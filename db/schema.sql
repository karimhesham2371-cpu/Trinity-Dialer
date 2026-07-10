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
