-- Demo campaign + global consent document for local development.

insert into public.campaigns (slug, title, description, prompt_flow, branding)
values (
  'customer-stories',
  'Share your story',
  'Tell us how you use the product. It takes about 3 minutes.',
  '{
    "version": 1,
    "intro": {
      "title": "Record a short video",
      "body": "We will guide you through 3 quick questions. You can retake each answer before submitting.",
      "estimatedMinutes": 3
    },
    "fields": [
      { "id": "name",        "label": "Your name",          "type": "text",  "required": true,  "maxLength": 80 },
      { "id": "affiliation", "label": "Company / affiliation", "type": "text", "required": false, "maxLength": 120 },
      { "id": "email",       "label": "Email (private)",    "type": "email", "required": false, "public": false }
    ],
    "prompts": [
      { "id": "intro", "title": "Introduce yourself", "body": "Say your name, role and where you work.",
        "prepSeconds": 5, "minSeconds": 3, "maxSeconds": 30 },
      { "id": "story", "title": "What problem did we help you solve?", "body": "Be specific: what was hard before, and what changed?",
        "prepSeconds": 10, "minSeconds": 10, "maxSeconds": 120 },
      { "id": "cta", "title": "Who would you recommend us to?", "body": "One sentence for someone considering us.",
        "prepSeconds": 5, "minSeconds": 3, "maxSeconds": 45, "optional": true }
    ],
    "recording": {
      "maxRetakes": 3,
      "maxSegmentBytes": 524288000,
      "video": { "width": 1280, "height": 720, "frameRate": 30 }
    }
  }'::jsonb,
  '{
    "primaryColor": "#4f46e5",
    "backgroundColor": "#ffffff",
    "textColor": "#0f172a",
    "radius": 14,
    "fontFamily": "Inter, system-ui, sans-serif",
    "wallTitle": "What our customers say"
  }'::jsonb
)
on conflict (slug) do nothing;

insert into public.consent_documents (campaign_id, version, title, body_markdown, required_checks)
values (
  null,
  '2026-10-01',
  'Video Release & Consent',
  E'By submitting this recording you grant the Operator a worldwide, royalty-free, non-exclusive, perpetual licence to reproduce, edit, caption, publish and distribute the recording, your name, likeness, voice and any affiliation you provide, in any media, for marketing, educational and community purposes.\n\nYou confirm that you are at least 18 years old, that the recording is your own work, that you have the right to grant this licence, and that the recording does not disclose confidential information of any third party.\n\nYou may request removal of a published video at any time by contacting the Operator; removal does not affect copies already distributed before the request.\n\nThis consent is recorded with a timestamp, your user identifier, IP address, user agent and a cryptographic signature to evidence your agreement.',
  '[
    { "id": "license",  "label": "I grant the media release licence described above." },
    { "id": "adult",    "label": "I am at least 18 years old." },
    { "id": "rights",   "label": "This recording is my own and contains no confidential third-party information." }
  ]'::jsonb
)
on conflict do nothing;
