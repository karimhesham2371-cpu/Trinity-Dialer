-- ─────────────────────────────────────────────────────────────────────────────
-- Trinity Dialer — Answering Machine Detection (AMD) schema
-- Run ONCE in the Supabase SQL editor (DDL can't go through the PostgREST key).
-- Every statement is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so
-- re-running is safe.
--
-- Field names / result values below match the Telnyx Call Control v2 docs exactly:
--   answering_machine_detection: premium | detect | detect_beep | disabled
--   events:  call.machine.premium.detection.ended  -> result:
--              human_residence | human_business | machine | silence |
--              fax_detected | not_sure
--            call.machine.detection.ended (standard) -> result:
--              human | machine | not_sure
--            call.machine.premium.greeting.ended -> result:
--              beep_detected | no_beep_detected | prompt_ended
--            call.machine.greeting.ended (standard) -> result:
--              ended | beep_detected | not_sure
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. calls: AMD instrumentation columns ---------------------------------------
alter table public.calls add column if not exists amd_mode        text;
alter table public.calls add column if not exists amd_result      text;   -- verbatim payload.result
alter table public.calls add column if not exists amd_latency_ms  integer;-- amd_ended_at - answered_at
alter table public.calls add column if not exists answered_at     timestamptz;
alter table public.calls add column if not exists amd_ended_at    timestamptz;
alter table public.calls add column if not exists amd_greeting    text;   -- greeting.ended result (beep_detected / no_beep_detected / ...)
alter table public.calls add column if not exists vm_dropped      boolean not null default false;
alter table public.calls add column if not exists abandoned       boolean not null default false; -- human detected, no free agent within the FCC window

-- 2. campaigns: AMD config ----------------------------------------------------
--   amd_mode / vm_drop_enabled / vm_drop_url already exist in Trinity.
alter table public.campaigns add column if not exists amd_config      jsonb;   -- {total_analysis_time_millis, greeting_duration_millis, prompt_end_timeout_millis}
alter table public.campaigns add column if not exists vm_drop_consent boolean not null default false; -- explicit consent gate for voicemail drops
alter table public.campaigns add column if not exists silence_policy  text not null default 'human';  -- how to treat silence/not_sure: 'human' | 'machine'

-- 3. amd_events: one row per AMD webhook, with the raw payload for auditing ----
create table if not exists public.amd_events (
  id          uuid primary key default gen_random_uuid(),
  call_id     text,               -- telnyx_call_control_id (our correlation key)
  campaign_id uuid,
  amd_mode    text,               -- premium | detect | detect_beep | disabled
  event_type  text,               -- exact Telnyx event_type string
  result      text,               -- verbatim payload.result
  latency_ms  integer,            -- detection latency for detection.ended events
  raw         jsonb,              -- full payload
  created_at  timestamptz not null default now()
);
create index if not exists amd_events_call_idx     on public.amd_events (call_id);
create index if not exists amd_events_campaign_idx on public.amd_events (campaign_id, created_at desc);

-- 4. calls indexes used by the AMD stats endpoint / nightly cross-check --------
create index if not exists calls_campaign_created_idx on public.calls (campaign_id, created_at desc);
create index if not exists calls_amd_result_idx       on public.calls (amd_result);
