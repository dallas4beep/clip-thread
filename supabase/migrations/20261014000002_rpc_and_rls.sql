-- =============================================================================
-- RPCs + Row Level Security
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_submission: atomically creates video + segments + consent record.
-- Called ONLY by the Next.js API with the service role after it has validated
-- the request and computed the consent HMAC (the signing secret never reaches
-- the database or the browser).
-- -----------------------------------------------------------------------------
create function public.create_submission(
  p_video_id    uuid,
  p_campaign_id uuid,
  p_user_id     uuid,
  p_metadata    jsonb,
  p_segments    jsonb,  -- [{ segment_index, prompt_id, object_key, mime_type, size_bytes, duration_ms }]
  p_consent     jsonb   -- consent_records columns (minus chain/seq fields)
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.videos (id, campaign_id, submitter_id, status, metadata, source_prefix)
  values (p_video_id, p_campaign_id, p_user_id, 'draft', coalesce(p_metadata, '{}'::jsonb),
          'submissions/' || p_video_id::text || '/');

  insert into public.video_segments (video_id, segment_index, prompt_id, object_key, mime_type, size_bytes, duration_ms)
  select p_video_id, s.segment_index, s.prompt_id, s.object_key, s.mime_type, s.size_bytes, s.duration_ms
  from jsonb_to_recordset(p_segments) as s(
    segment_index smallint, prompt_id text, object_key text,
    mime_type text, size_bytes bigint, duration_ms integer
  );

  insert into public.consent_records (
    video_id, user_id, consent_document_id, consent_version, document_sha256,
    signer_name, signature_image, signature_sha256, checks, ip_address, user_agent,
    client_timestamp, server_timestamp, payload, payload_sha256, hmac_sha256,
    prev_hash, record_hash
  ) values (
    p_video_id,
    p_user_id,
    (p_consent ->> 'consent_document_id')::uuid,
    p_consent ->> 'consent_version',
    p_consent ->> 'document_sha256',
    p_consent ->> 'signer_name',
    p_consent ->> 'signature_image',
    p_consent ->> 'signature_sha256',
    p_consent -> 'checks',
    nullif(p_consent ->> 'ip_address', '')::inet,
    p_consent ->> 'user_agent',
    (p_consent ->> 'client_timestamp')::timestamptz,
    (p_consent ->> 'server_timestamp')::timestamptz,
    p_consent -> 'payload',
    p_consent ->> 'payload_sha256',
    p_consent ->> 'hmac_sha256',
    '', ''  -- filled by consent_records_chain trigger
  );

  return p_video_id;
end;
$$;

revoke all on function public.create_submission(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_submission(uuid, uuid, uuid, jsonb, jsonb, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- moderate_video: the only path for a human to change a video's status.
-- -----------------------------------------------------------------------------
create function public.moderate_video(
  p_video_id uuid,
  p_status   public.video_status,
  p_note     text default null
)
returns public.videos
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from public.video_status;
  v_row  public.videos;
begin
  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('pending_review', 'approved', 'rejected', 'flagged') then
    raise exception 'invalid target status %', p_status using errcode = 'check_violation';
  end if;

  select status into v_from from public.videos where id = p_video_id for update;
  if not found then
    raise exception 'video % not found', p_video_id using errcode = 'no_data_found';
  end if;

  if v_from not in ('pending_review', 'approved', 'rejected', 'flagged') then
    raise exception 'video is % and cannot be moderated yet', v_from using errcode = 'check_violation';
  end if;

  update public.videos
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where id = p_video_id
  returning * into v_row;

  insert into public.moderation_events (video_id, actor_id, from_status, to_status, note)
  values (p_video_id, auth.uid(), v_from, p_status, nullif(trim(p_note), ''));

  return v_row;
end;
$$;

revoke all on function public.moderate_video(uuid, public.video_status, text) from public, anon;
grant execute on function public.moderate_video(uuid, public.video_status, text) to authenticated;

revoke all on function public.verify_consent_chain() from public, anon, authenticated;
grant execute on function public.verify_consent_chain() to service_role;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.campaigns         enable row level security;
alter table public.consent_documents enable row level security;
alter table public.videos            enable row level security;
alter table public.video_segments    enable row level security;
alter table public.consent_records   enable row level security;
alter table public.transcripts       enable row level security;
alter table public.moderation_events enable row level security;

-- profiles: read self (moderators read all); users may only edit display_name.
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_moderator()));

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- campaigns: active ones are public; moderators manage.
create policy campaigns_public_select on public.campaigns
  for select to anon, authenticated
  using (is_active or (select public.is_moderator()));

create policy campaigns_moderator_write on public.campaigns
  for all to authenticated
  using ((select public.is_moderator()))
  with check ((select public.is_moderator()));

-- consent documents: public legal text; moderators may publish new versions.
create policy consent_documents_select on public.consent_documents
  for select to anon, authenticated
  using (true);

create policy consent_documents_insert on public.consent_documents
  for insert to authenticated
  with check ((select public.is_moderator()));

create policy consent_documents_retire on public.consent_documents
  for update to authenticated
  using ((select public.is_moderator()))
  with check ((select public.is_moderator()));

-- videos: owners see their own, moderators see all. No direct writes: all
-- mutations go through create_submission / moderate_video / service role.
-- The public wall is served via the API (service role, explicit column list).
create policy videos_select on public.videos
  for select to authenticated
  using (submitter_id = (select auth.uid()) or (select public.is_moderator()));

create policy video_segments_select on public.video_segments
  for select to authenticated
  using (
    (select public.is_moderator())
    or exists (select 1 from public.videos v
               where v.id = video_id and v.submitter_id = (select auth.uid()))
  );

create policy consent_records_select on public.consent_records
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_moderator()));

create policy transcripts_select on public.transcripts
  for select to authenticated
  using (
    (select public.is_moderator())
    or exists (select 1 from public.videos v
               where v.id = video_id and v.submitter_id = (select auth.uid()))
  );

create policy moderation_events_select on public.moderation_events
  for select to authenticated
  using ((select public.is_moderator()));

-- Live updates for the moderation dashboard (RLS applies to Realtime).
alter publication supabase_realtime add table public.videos;
