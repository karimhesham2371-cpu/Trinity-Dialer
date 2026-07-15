-- ─────────────────────────────────────────────────────────────────────────────
-- Trinity Dialer — Predictive (background AMD) pacing schema
-- Run ONCE in the Supabase SQL editor, AFTER amd_schema.sql. Idempotent.
--
-- Adds per-campaign predictive-dialer config. A campaign's pacing_mode selects
-- the engine:
--   'power'       — existing ReadyMode power dialer (bridge on answer, one line
--                   per agent). Unchanged default so live campaigns don't flip.
--   'predictive'  — background dialer engine: calls are placed unbridged, held in
--                   a DETECTING state, and only bridged to an agent once premium
--                   AMD confirms a human. Agents never hear ringing or machines.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. campaigns: predictive pacing config -------------------------------------
alter table public.campaigns add column if not exists pacing_mode            text    not null default 'power';   -- 'power' | 'predictive'
alter table public.campaigns add column if not exists dial_ratio             numeric not null default 2.0;       -- calls per available agent (auto-adjusted)
alter table public.campaigns add column if not exists dial_ratio_min         numeric not null default 1.0;       -- hard floor (pure power dialing)
alter table public.campaigns add column if not exists dial_ratio_max         numeric not null default 3.0;       -- hard ceiling
alter table public.campaigns add column if not exists abandon_soft_threshold numeric not null default 0.025;     -- clamp to floor at/above this rate (FCC cap is 0.03)
alter table public.campaigns add column if not exists safe_harbor_url        text;                               -- FCC safe-harbor audio (company + callback, NO solicitation)

-- 2. calls: predictive lifecycle columns -------------------------------------
--   amd_mode / amd_result / amd_latency_ms / answered_at / amd_ended_at /
--   amd_greeting / vm_dropped / abandoned already ship in amd_schema.sql.
alter table public.calls add column if not exists call_phase   text;   -- DIALING | DETECTING | BRIDGED | MACHINE | ABANDONED | VOICEMAIL | ENDED
alter table public.calls add column if not exists reserved_agent_id uuid;

-- 2b. dispositions: correlate to the exact call leg (AMD false-negative meter) -
alter table public.dispositions add column if not exists telnyx_call_control_id text;
create index if not exists dispositions_ccid_idx on public.dispositions (telnyx_call_control_id);

-- 3. inbound voicemail box ----------------------------------------------------
create table if not exists public.voicemails (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid,
  call_id        text,                  -- telnyx_call_control_id
  from_number    text,
  to_number      text,
  recording_url  text,
  transcription  text,
  handled        boolean not null default false,   -- cleared when an agent works the callback
  handled_by     uuid,
  created_at     timestamptz not null default now()
);
create index if not exists voicemails_campaign_idx on public.voicemails (campaign_id, created_at desc);
create index if not exists voicemails_unhandled_idx on public.voicemails (handled, created_at desc);

-- 4. dial_ratio history (per-campaign, for the nightly pacing report) ---------
create table if not exists public.pacing_events (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid,
  dial_ratio    numeric,
  available     integer,
  in_flight     integer,
  placed        integer,
  human_rate    numeric,
  abandon_rate  numeric,
  idle_pct      numeric,
  reason        text,
  created_at    timestamptz not null default now()
);
create index if not exists pacing_events_campaign_idx on public.pacing_events (campaign_id, created_at desc);
