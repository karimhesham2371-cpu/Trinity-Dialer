-- Trinity Dialer — Supabase / Postgres schema (MVP)
-- Run in the Supabase SQL editor. Uses gen_random_uuid() (pgcrypto, on by default in Supabase).

-- ── agents ──────────────────────────────────────────────────────────────────
create table if not exists agents (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  email                 text unique,
  telnyx_credential_id  text,            -- Telephony Credential id (WebRTC login)
  sip_username          text,            -- SIP username for the credential
  state                 text not null default 'OFFLINE',
                        -- OFFLINE | AVAILABLE | ON_CALL | WRAP_UP | BREAK
  current_call_id       uuid,
  conference_id         text,            -- per-agent Telnyx conference id (set on Go Available)
  campaign_id           uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── campaigns ───────────────────────────────────────────────────────────────
create table if not exists campaigns (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  caller_id_strategy    text not null default 'local',   -- local | fixed
  fixed_caller_id       text,                            -- used when strategy = fixed
  amd_mode              text not null default 'premium',  -- premium | detect | disabled
  dialing_ratio         numeric not null default 1.0,     -- 1.0 = power; >1 = predictive (phase 4)
  calling_window_start  int not null default 8,           -- local hour, 0-23
  calling_window_end    int not null default 21,          -- local hour, 0-23
  active                boolean not null default false,
  created_at            timestamptz not null default now()
);

-- ── leads ───────────────────────────────────────────────────────────────────
create table if not exists leads (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid references campaigns(id) on delete cascade,
  phone              text not null,
  first_name         text,
  last_name          text,
  address            text,
  state              text,               -- US state, for timezone/calling-window
  timezone           text,               -- IANA tz, e.g. America/New_York
  status             text not null default 'NEW',
                     -- NEW | IN_PROGRESS | CONTACTED | CALLBACK | DNC | DNC_LITIGATOR | DONE
  attempts           int not null default 0,
  last_attempt_at    timestamptz,
  next_callback_at   timestamptz,
  assigned_agent_id  uuid references agents(id),
  dnc                boolean not null default false,
  created_at         timestamptz not null default now()
);

-- pacing query hot path: eligible leads for a campaign
create index if not exists leads_pacing_idx
  on leads (campaign_id, status, dnc, next_callback_at);
create index if not exists leads_phone_idx on leads (phone);

-- ── calls ───────────────────────────────────────────────────────────────────
create table if not exists calls (
  id                      uuid primary key default gen_random_uuid(),
  lead_id                 uuid references leads(id),
  agent_id                uuid references agents(id),
  campaign_id             uuid references campaigns(id),
  telnyx_call_control_id  text unique,
  conference_id           text,
  from_number             text,
  to_number               text,
  direction               text default 'outbound',
  amd_result              text,          -- human | machine | not_sure | null
  answered_at             timestamptz,
  bridged_at              timestamptz,
  ended_at                timestamptz,
  duration_sec            int,
  recording_url           text,
  hangup_cause            text,
  created_at              timestamptz not null default now()
);

create index if not exists calls_ccid_idx on calls (telnyx_call_control_id);
create index if not exists calls_lead_idx on calls (lead_id);

-- ── dispositions ────────────────────────────────────────────────────────────
create table if not exists dispositions (
  id           uuid primary key default gen_random_uuid(),
  call_id      uuid references calls(id),
  lead_id      uuid references leads(id),
  agent_id     uuid references agents(id),
  code         text not null,
               -- SALE | CALLBACK | NOT_INTERESTED | NO_ANSWER | MACHINE |
               -- WRONG_NUMBER | DNC | BUSY | VOICEMAIL
  notes        text,
  callback_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ── dnc_list ────────────────────────────────────────────────────────────────
create table if not exists dnc_list (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,
  reason      text,               -- internal | litigator | carrier_stop
  source      text,
  created_at  timestamptz not null default now()
);

-- ── raw webhook log (Phase 0 debugging; keep for audit) ──────────────────────
create table if not exists call_events (
  id                      bigserial primary key,
  event_type              text,
  telnyx_call_control_id  text,
  client_state            jsonb,
  payload                 jsonb,
  received_at             timestamptz not null default now()
);
create index if not exists call_events_ccid_idx on call_events (telnyx_call_control_id);

-- ── v2: auth + multi-user + campaign assignment ─────────────────────────────
alter table agents    add column if not exists role          text not null default 'agent';   -- agent | admin
alter table agents    add column if not exists password_hash text;
alter table agents    add column if not exists active        boolean not null default true;
alter table campaigns add column if not exists status        text not null default 'DRAFT';    -- DRAFT | RUNNING | PAUSED | STOPPED
alter table campaigns add column if not exists caller_ids    jsonb not null default '[]'::jsonb; -- optional per-campaign DID pool override

create table if not exists campaign_agents (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references campaigns(id) on delete cascade,
  agent_id     uuid references agents(id)    on delete cascade,
  created_at   timestamptz not null default now(),
  unique (campaign_id, agent_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- v3: durable runtime state, webhook idempotency, dialing intelligence, dispositions,
--      scripts, recycling, recording. Safe to re-run (idempotent).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── agents: mirror live runtime so a restart can rehydrate (no lost calls) ────
alter table agents add column if not exists agent_leg      text;   -- Telnyx call_control_id of the agent's WebRTC leg
alter table agents add column if not exists lead_leg       text;   -- call_control_id of the lead leg currently bridged/dialing
alter table agents add column if not exists lead_id        uuid;   -- lead currently on this agent
alter table agents add column if not exists lead_number    text;   -- phone being dialed (for UI)
alter table agents add column if not exists from_number    text;   -- caller ID in use (for vacancy rotation)
alter table agents add column if not exists rt_updated_at  timestamptz;  -- heartbeat; reaper uses this
-- state now includes: OFFLINE | CONNECTING | AVAILABLE | CLAIMING | DIALING | ON_CALL | WRAP_UP | BREAK

-- ── campaigns: full dialing configuration ─────────────────────────────────────
alter table campaigns add column if not exists dial_ratio         numeric not null default 1.0;  -- lines per available agent (1–4)
alter table campaigns add column if not exists wrap_seconds       int not null default 5;        -- forced wrap-up before auto-advance
alter table campaigns add column if not exists script             text;                          -- agent script w/ {{merge_fields}}
alter table campaigns add column if not exists dispositions       jsonb not null default '[]'::jsonb;  -- [{code,label,color,hotkey,recycle,is_dnc,is_callback}]
alter table campaigns add column if not exists recycle_rules      jsonb not null default '{}'::jsonb;  -- {no_answer:{hours,max},busy:{minutes,max}}
alter table campaigns add column if not exists record_calls       boolean not null default true; -- unconditional recording (per Karim)
alter table campaigns add column if not exists vm_drop_enabled    boolean not null default false;
alter table campaigns add column if not exists vm_drop_url        text;                          -- audio URL for ringless-style VM drop
alter table campaigns add column if not exists local_presence     boolean not null default true; -- match caller ID area code to lead

-- ── leads: recycling + custom fields + outcome tracking ───────────────────────
alter table leads add column if not exists custom       jsonb not null default '{}'::jsonb;  -- extra CSV columns preserved as merge fields
alter table leads add column if not exists last_outcome text;    -- last disposition code / system outcome
alter table leads add column if not exists max_attempts int;     -- per-lead override (else campaign rule)
alter table leads add column if not exists area_code    text;    -- derived for local presence + tz
alter table leads add column if not exists city         text;    -- property city (CSV column mapping)
alter table leads add column if not exists zip          text;    -- property ZIP / postal (CSV column mapping)
-- status now includes: NEW | IN_PROGRESS | CONTACTED | CALLBACK | MACHINE | NO_ANSWER
--                      | BUSY | DONE | BAD_NUMBER | DNC | EXHAUSTED

-- ── dispositions: link to campaign, add disposition source ────────────────────
alter table dispositions add column if not exists campaign_id uuid references campaigns(id);

-- ── webhook idempotency: dedupe Telnyx redeliveries ───────────────────────────
create table if not exists webhook_events (
  event_id     text primary key,        -- Telnyx event id (data.id)
  event_type   text,
  received_at  timestamptz not null default now()
);
-- housekeeping: old rows can be pruned by the reaper (keeps last ~24h)
create index if not exists webhook_events_time_idx on webhook_events (received_at);

-- ── calls: recording + supervisor bookkeeping ─────────────────────────────────
alter table calls add column if not exists recording_id text;   -- Telnyx recording id
alter table calls add column if not exists talk_seconds int;     -- bridged→ended

-- ═══ v4: reporting (audit trail + agent time tracking + floor plan) ═══════════
-- One row per state span, so the Agent Report can sum login / dialing / talk /
-- wrap / break durations. Open span = ended_at is null; closed by an
-- agent_id + ended_at.is.null filter so it survives in-memory rt resets.
create table if not exists agent_state_events (
  id           bigserial primary key,
  agent_id     uuid references agents(id),
  state        text not null,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  duration_sec int
);
create index if not exists ase_agent_idx on agent_state_events (agent_id, started_at);
create index if not exists ase_open_idx  on agent_state_events (agent_id) where ended_at is null;

-- User-activity audit trail for the Audit Logs report.
create table if not exists audit_log (
  id          bigserial primary key,
  actor_id    uuid,
  actor_name  text,
  actor_role  text,
  action      text not null,
  target_type text,
  target_id   text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_time_idx  on audit_log (created_at);
create index if not exists audit_actor_idx on audit_log (actor_id, created_at);

-- Office map: persisted desk positions (percentage 0-100 of the canvas).
alter table agents add column if not exists seat_x numeric;
alter table agents add column if not exists seat_y numeric;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v5: Sprint 1 — Data model + Lead Management (per BUILD_SCOPE.md).
--     Additive + idempotent. Absorbs existing tables; keeps v4 reporting intact.
--     Scope-locked: power dial only, DNC permanent/disposition-driven,
--     global 10AM–9PM lead-local calling window.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── app_settings: single global key/value store (calling window lives here) ────
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
-- Hard rule: no lead is dialed before 10:00 or after 21:00 in their LOCAL time.
insert into app_settings (key, value)
  values ('calling_window', '{"start_hour":10,"end_hour":21}'::jsonb)
  on conflict (key) do nothing;

-- ── dids: the outbound number pool (admin adds Telnyx numbers manually) ────────
create table if not exists dids (
  id           uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  area_code    text,
  state        text,
  carrier      text,
  daily_cap    int not null default 100,     -- presets 75/100/150/200/none(null)
  health       text not null default 'HEALTHY', -- HEALTHY | SUSPECT | RESTING | RETIRED
  rest_until   timestamptz,                   -- auto-rest expiry
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists dids_state_idx  on dids (state, active);
create index if not exists dids_health_idx on dids (health);

-- Per-DID per-day counters — feeds daily caps + rolling answer-rate health.
create table if not exists did_daily_stats (
  did_id   uuid references dids(id) on delete cascade,
  day      date not null,
  carrier  text not null default '',   -- '' = all; per DID×carrier rows too
  dials    int not null default 0,
  answers  int not null default 0,
  primary key (did_id, day, carrier)
);

-- ── campaign_fields: custom CRM fields per campaign + lead-card layout ─────────
create table if not exists campaign_fields (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references campaigns(id) on delete cascade,
  key          text not null,            -- stored under leads.custom[key]
  label        text not null,
  type         text not null default 'text', -- text | number | date | select | phone
  options      jsonb not null default '[]'::jsonb, -- for select
  position     int not null default 0,   -- lead-card layout order
  show_on_card boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (campaign_id, key)
);

-- ── action_folders: Appointments / Hot Leads / Follow-ups (admin-definable) ────
create table if not exists action_folders (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references campaigns(id) on delete cascade, -- null = global
  name         text not null,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);

-- Membership: a lead can sit in many folders (manual click-to-call from any).
create table if not exists lead_folders (
  lead_id    uuid references leads(id) on delete cascade,
  folder_id  uuid references action_folders(id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (lead_id, folder_id)
);

-- ── playlists: filter-driven lead selection with weighted groups + priority ────
create table if not exists playlists (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid references campaigns(id) on delete cascade,
  name           text not null,
  priority       int not null default 5,      -- 1 (highest) .. 9 (lowest)
  weight         int not null default 1,       -- weighting within a group
  group_name     text,                         -- weighted-group bucket
  filters        jsonb not null default '[]'::jsonb,
                 -- [{field, op, value}] op: is | is_not | between
  selection_mode text not null default 'balanced', -- strict | balanced | off (DID health)
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists playlists_campaign_idx on playlists (campaign_id, active, priority);

-- ── import_batches: one row per CSV upload (drives the import summary) ─────────
create table if not exists import_batches (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references campaigns(id) on delete cascade,
  filename     text,
  total        int not null default 0,
  inserted     int not null default 0,
  duplicates   int not null default 0,   -- deduped by phone
  dnc_removed  int not null default 0,   -- "N removed — on your DNC list"
  invalid      int not null default 0,   -- rejected numbers (rejects file)
  created_by   uuid references agents(id),
  created_at   timestamptz not null default now()
);

-- ── leads: tags, ownership, import provenance, source ─────────────────────────
alter table leads add column if not exists tags            text[] not null default '{}';
alter table leads add column if not exists owner_agent_id  uuid references agents(id);
alter table leads add column if not exists import_batch_id uuid references import_batches(id);
alter table leads add column if not exists source          text;
alter table leads add column if not exists times_called    int not null default 0; -- distinct from attempts; playlist filterable

-- Global lead search (phone / name / address) across campaigns.
create extension if not exists pg_trgm;
create index if not exists leads_name_trgm on leads using gin ((coalesce(first_name,'')||' '||coalesce(last_name,'')) gin_trgm_ops);
create index if not exists leads_addr_trgm on leads using gin (coalesce(address,'') gin_trgm_ops);
create index if not exists leads_tags_idx  on leads using gin (tags);
create index if not exists leads_owner_idx on leads (owner_agent_id);

-- ── disposition_defs: the disposition catalog (Sprint 2 uses; defined here) ────
-- Included in Sprint 1 so the schema is complete; Sprint 2 wires the engine.
create table if not exists disposition_defs (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid references campaigns(id) on delete cascade, -- null = global
  parent_id       uuid references disposition_defs(id),            -- category nesting
  name            text not null,
  abbreviation    text,
  color           text,           -- status palette token
  hotkey          text,           -- '1'..'9'
  position        int not null default 0,
  hidden          boolean not null default false,
  end_call        boolean not null default true,   -- end vs keep call
  is_dnc          boolean not null default false,  -- permanent DNC (the only entry path)
  is_callback     boolean not null default false,  -- opens callback picker
  take_ownership  text not null default 'none',    -- none | allow | force
  action_folder_id uuid references action_folders(id), -- transfer-to-folder
  require_notes   boolean not null default false,
  apply_tags      text[] not null default '{}',
  announce        boolean not null default false,  -- announce-to-floor toast
  created_at      timestamptz not null default now()
);
create index if not exists disp_defs_campaign_idx on disposition_defs (campaign_id, hidden, position);

-- ── disposition_rules: escalating recycling by times-logged ───────────────────
-- Global 4h (240min) minimum re-dial safety net is the default delay.
create table if not exists disposition_rules (
  id             uuid primary key default gen_random_uuid(),
  disposition_id uuid references disposition_defs(id) on delete cascade,
  times_logged   int not null default 1,       -- fires when logged this many times
  action         text not null default 'recycle', -- recycle | exhaust | dnc | folder
  delay_minutes  int not null default 240,      -- >= 240 enforced by engine
  action_folder_id uuid references action_folders(id),
  created_at     timestamptz not null default now()
);
create index if not exists disp_rules_disp_idx on disposition_rules (disposition_id, times_logged);

-- ═══════════════════════════════════════════════════════════════════════════════
-- v6 — Playlist-driven dialing + DID→campaign inbound routing
-- Model: PLAYLIST holds many CAMPAIGNS and many AGENTS. Available agents on a
-- playlist dial leads drawn from that playlist's campaigns (highest priority
-- playlist first). Each DID belongs to at most one campaign; inbound calls on
-- that DID ring a random available agent working the campaign.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Playlist ↔ Campaigns (many-to-many)
create table if not exists playlist_campaigns (
  id           uuid primary key default gen_random_uuid(),
  playlist_id  uuid references playlists(id)  on delete cascade,
  campaign_id  uuid references campaigns(id)  on delete cascade,
  created_at   timestamptz not null default now(),
  unique (playlist_id, campaign_id)
);
create index if not exists pl_camp_playlist_idx on playlist_campaigns (playlist_id);
create index if not exists pl_camp_campaign_idx on playlist_campaigns (campaign_id);

-- Playlist ↔ Agents (callers assigned to a playlist)
create table if not exists playlist_agents (
  id           uuid primary key default gen_random_uuid(),
  playlist_id  uuid references playlists(id) on delete cascade,
  agent_id     uuid references agents(id)    on delete cascade,
  created_at   timestamptz not null default now(),
  unique (playlist_id, agent_id)
);
create index if not exists pl_agent_playlist_idx on playlist_agents (playlist_id);
create index if not exists pl_agent_agent_idx    on playlist_agents (agent_id);

-- Playlists become standalone containers; campaign_id is now legacy/optional.
alter table playlists alter column campaign_id drop not null;

-- Backfill: fold every existing single-campaign playlist into the join table.
insert into playlist_campaigns (playlist_id, campaign_id)
  select id, campaign_id from playlists where campaign_id is not null
  on conflict (playlist_id, campaign_id) do nothing;

-- Assign a DID to exactly one campaign (for inbound routing). NULL = unassigned.
alter table dids add column if not exists campaign_id uuid references campaigns(id) on delete set null;
create index if not exists dids_campaign_idx on dids (campaign_id);

-- v7 — Per-playlist CPA (calls-per-agent) override.
-- How many leads to ring SIMULTANEOUSLY for each free agent working this
-- playlist. NULL = inherit the global default (app_settings 'dialer'). 1 = pure
-- power dialing (no abandoned calls); higher cuts inter-call wait but can drop
-- extra legs when a human answers first. Enforced range 1-5 in the app layer.
alter table playlists add column if not exists lines_per_agent int;

-- v8 — Disposition-driven DNC + recycle policy.
-- expires_at: when set, the DNC entry auto-expires (e.g. 90 days after a sale).
-- NULL = permanent (explicit DNC disposition or 4-strike auto-DNC).
alter table dnc_list add column if not exists expires_at timestamptz;
create index if not exists dnc_expires_idx on dnc_list (expires_at);

-- Per-phone activity across ALL campaigns: anchors the 10-day recycle window
-- (first_dial_at) and counts negative-outcome strikes toward the 4-strike DNC.
create table if not exists phone_activity (
  phone         text primary key,
  first_dial_at timestamptz,
  neg_strikes   int not null default 0,
  last_disp_at  timestamptz,
  updated_at    timestamptz not null default now()
);

-- Atomic strike bump: increments neg_strikes (or inserts at 1), preserving the
-- earliest first_dial_at, and returns the updated row.
create or replace function bump_phone_strike(p_phone text)
returns phone_activity
language plpgsql as $$
declare r phone_activity;
begin
  insert into phone_activity (phone, neg_strikes, first_dial_at, last_disp_at, updated_at)
    values (p_phone, 1, now(), now(), now())
  on conflict (phone) do update
    set neg_strikes   = phone_activity.neg_strikes + 1,
        first_dial_at = coalesce(phone_activity.first_dial_at, now()),
        last_disp_at  = now(),
        updated_at    = now()
  returning * into r;
  return r;
end $$;

-- v9 — Fine-grained RBAC for the 'support' role. Admins grant individual report
-- capabilities at user-creation time (adjustable, revoked live). Empty array for
-- admins (implicit full access) and agents (no back-office access). Keys map to
-- the PERMISSIONS registry in server.js: reports.call_logs, reports.call_logs_export,
-- reports.office_map, reports.research, reports.agent_report.
alter table agents add column if not exists permissions jsonb not null default '[]'::jsonb;

-- v10 — Recording QA. Reviewers (admins / support with reports.qa) flag, score
-- (1–5) and annotate call recordings for quality review, embedded in Call logs.
alter table calls add column if not exists qa_flagged     boolean not null default false;
alter table calls add column if not exists qa_score       smallint;
alter table calls add column if not exists qa_note        text;
alter table calls add column if not exists qa_reviewed_by uuid references agents(id);
alter table calls add column if not exists qa_reviewed_at timestamptz;
create index if not exists idx_calls_qa_flagged on calls(qa_flagged) where qa_flagged;
