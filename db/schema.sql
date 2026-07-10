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
