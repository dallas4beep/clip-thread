-- =============================================================================
-- Clipthread core schema: campaigns, videos, segments, consent, transcripts,
-- moderation audit log.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create type public.app_role as enum ('member', 'moderator', 'admin');

-- Lifecycle:
--   draft          -> row + consent created, segments uploading
--   uploaded       -> all segments in R2, waiting for processor
--   processing     -> claimed by the FastAPI worker
--   pending_review -> stitched/transcribed, waiting for a moderator
--   approved | rejected | flagged -> moderator decision
--   failed         -> processing error (retryable)
create type public.video_status as enum (
  'draft', 'uploaded', 'processing', 'pending_review',
  'approved', 'rejected', 'flagged', 'failed'
);

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role         public.app_role not null default 'member',
  created_at   timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('moderator', 'admin')
  );
$$;

-- -----------------------------------------------------------------------------
-- Campaigns (a prompt flow + branding + embed settings)
-- -----------------------------------------------------------------------------
create table public.campaigns (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  title                 text not null,
  description           text,
  prompt_flow           jsonb not null,             -- validated by config/prompt-flow.schema.json
  branding              jsonb not null default '{}'::jsonb,
  allowed_embed_origins text[] not null default '{}', -- empty = any origin may embed
  is_active             boolean not null default true,
  created_by            uuid references auth.users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Consent documents: immutable, versioned legal text. New wording = new row.
-- -----------------------------------------------------------------------------
create table public.consent_documents (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid references public.campaigns (id) on delete restrict, -- null = global default
  version         text not null,
  title           text not null,
  body_markdown   text not null,
  body_sha256     text not null,  -- set by trigger; body is immutable after insert
  required_checks jsonb not null default '[]'::jsonb, -- [{ "id": "...", "label": "..." }]
  is_current      boolean not null default true,
  created_at      timestamptz not null default now(),
  unique nulls not distinct (campaign_id, version)
);

create function public.consent_documents_hash()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.body_sha256 := encode(extensions.digest(convert_to(new.body_markdown, 'UTF8'), 'sha256'), 'hex');
  return new;
end;
$$;

create trigger consent_documents_hash_trg
  before insert on public.consent_documents
  for each row execute function public.consent_documents_hash();

-- -----------------------------------------------------------------------------
-- Videos
-- -----------------------------------------------------------------------------
create table public.videos (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references public.campaigns (id) on delete restrict,
  submitter_id          uuid not null references auth.users (id) on delete restrict,
  status                public.video_status not null default 'draft',
  metadata              jsonb not null default '{}'::jsonb, -- name, affiliation, etc. from prompt-flow fields
  source_prefix         text not null,                     -- submissions/{id}/
  final_key             text,
  poster_key            text,
  duration_seconds      numeric(10, 3),
  processing_error      text,
  processing_started_at timestamptz,
  is_featured           boolean not null default false,
  sort_order            integer not null default 0,
  submitted_at          timestamptz,
  processed_at          timestamptz,
  reviewed_at           timestamptz,
  reviewed_by           uuid references auth.users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index videos_status_idx on public.videos (status, submitted_at);
create index videos_wall_idx on public.videos (campaign_id, status, is_featured desc, sort_order, reviewed_at desc);
create index videos_submitter_idx on public.videos (submitter_id);

-- One recorded clip per prompt; the worker stitches them into final.mp4.
create table public.video_segments (
  id                  uuid primary key default gen_random_uuid(),
  video_id            uuid not null references public.videos (id) on delete cascade,
  segment_index       smallint not null check (segment_index between 0 and 49),
  prompt_id           text not null,
  object_key          text not null unique,
  mime_type           text not null,
  size_bytes          bigint not null check (size_bytes > 0),
  duration_ms         integer,
  upload_id           text,          -- S3/R2 multipart upload id (resumable state)
  upload_completed_at timestamptz,
  created_at          timestamptz not null default now(),
  unique (video_id, segment_index)
);

-- -----------------------------------------------------------------------------
-- Consent records: append-only, HMAC-signed, hash-chained.
-- -----------------------------------------------------------------------------
create table public.consent_records (
  seq                 bigint generated always as identity unique,
  id                  uuid primary key default gen_random_uuid(),
  video_id            uuid not null unique references public.videos (id) on delete restrict,
  user_id             uuid not null references auth.users (id) on delete restrict,
  consent_document_id uuid not null references public.consent_documents (id) on delete restrict,
  consent_version     text not null,
  document_sha256     text not null,
  signer_name         text not null check (char_length(signer_name) between 1 and 200),
  signature_image     text check (signature_image is null or char_length(signature_image) <= 400000),
  signature_sha256    text,
  checks              jsonb not null,
  ip_address          inet,
  user_agent          text,
  client_timestamp    timestamptz,
  server_timestamp    timestamptz not null,
  payload             jsonb not null,  -- exact canonical payload that was hashed
  payload_sha256      text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  hmac_sha256         text not null check (hmac_sha256 ~ '^[0-9a-f]{64}$'),
  prev_hash           text not null,
  record_hash         text not null,
  created_at          timestamptz not null default now()
);

-- Chain each record to the previous one so any edit/deletion is detectable.
create function public.consent_records_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('public.consent_records.chain'));
  select record_hash into v_prev
  from public.consent_records
  order by seq desc
  limit 1;

  new.prev_hash   := coalesce(v_prev, repeat('0', 64));
  new.record_hash := encode(
    extensions.digest(convert_to(new.prev_hash || new.payload_sha256 || new.hmac_sha256, 'UTF8'), 'sha256'),
    'hex'
  );
  new.created_at  := now();
  return new;
end;
$$;

create trigger consent_records_chain_trg
  before insert on public.consent_records
  for each row execute function public.consent_records_chain();

create function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only (attempted %)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger consent_records_immutable
  before update or delete on public.consent_records
  for each row execute function public.forbid_mutation();

create trigger consent_documents_immutable
  before update of body_markdown, version, required_checks, campaign_id or delete
  on public.consent_documents
  for each row execute function public.forbid_mutation();

-- Returns rows whose chain link does not verify (empty result = intact).
create function public.verify_consent_chain()
returns table (seq bigint, id uuid, problem text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_prev text := repeat('0', 64);
  v_expected text;
begin
  for r in select * from public.consent_records order by seq loop
    if r.prev_hash <> v_prev then
      seq := r.seq; id := r.id; problem := 'prev_hash mismatch'; return next;
    end if;
    v_expected := encode(
      extensions.digest(convert_to(r.prev_hash || r.payload_sha256 || r.hmac_sha256, 'UTF8'), 'sha256'),
      'hex'
    );
    if r.record_hash <> v_expected then
      seq := r.seq; id := r.id; problem := 'record_hash mismatch'; return next;
    end if;
    -- payload_sha256 / hmac_sha256 are verified by `npm run verify:consent`,
    -- which re-canonicalizes the payload and checks the HMAC with the secret.
    v_prev := r.record_hash;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Transcripts
-- -----------------------------------------------------------------------------
create table public.transcripts (
  video_id   uuid primary key references public.videos (id) on delete cascade,
  language   text,
  text       text not null,
  segments   jsonb not null default '[]'::jsonb, -- [{ start, end, text }]
  vtt        text not null,
  srt        text not null,
  vtt_key    text,
  srt_key    text,
  model      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Moderation audit log
-- -----------------------------------------------------------------------------
create table public.moderation_events (
  id          bigint generated always as identity primary key,
  video_id    uuid not null references public.videos (id) on delete cascade,
  actor_id    uuid not null references auth.users (id),
  from_status public.video_status not null,
  to_status   public.video_status not null,
  note        text check (note is null or char_length(note) <= 2000),
  created_at  timestamptz not null default now()
);

create index moderation_events_video_idx on public.moderation_events (video_id, created_at desc);

-- -----------------------------------------------------------------------------
-- updated_at helper
-- -----------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger campaigns_touch before update on public.campaigns
  for each row execute function public.touch_updated_at();
create trigger videos_touch before update on public.videos
  for each row execute function public.touch_updated_at();
create trigger transcripts_touch before update on public.transcripts
  for each row execute function public.touch_updated_at();
