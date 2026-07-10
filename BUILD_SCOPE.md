# Trinity Dialer — Build Scope (Owner-Selected)

This file supersedes the phase ordering in readymode-parity-spec.md. The owner
selected these categories: Caller ID & Number Health, Answering Machine
Handling, Lead Management, Dispositions, Agent Experience, Admin/Floor Control,
Reporting & Automation. Use readymode-parity-spec.md for the detailed behavior
of each feature; this file defines WHAT is in scope and in what ORDER.

## Explicitly OUT of scope (do not build)
- Predictive/progressive multi-line pacing and abandon-target auto-pacing
  (keep the existing power-dial: 1 line per available agent, auto-advance)
- Preview/Cold Call mode, inbound queues/blending (callbacks still work —
  they dial OUT to the lead at the scheduled time)
- State-by-state restriction tables, consent/opt-in timeframes,
  state-of-emergency switches, per-lead attempt caps
- Buying numbers inside the UI (admin adds Telnyx numbers manually for now)
- Email templates / disposition-triggered email
- Automated carrier remediation (manual workflow + CSV export only)

## Kept from Compliance (embedded, non-negotiable)
- DNC list, disposition-driven and permanent-only: the ONLY way a number
  enters the list is an agent clicking the DNC disposition ("owner said don't
  call again"). No imports of external DNC files, no expiry. Enforcement is
  two checks against the same table: (1) before EVERY dial the engine skips
  DNC numbers, (2) on CSV import, DNC numbers are filtered out and counted in
  the import summary ("N removed — on your DNC list"). Admin can view/search
  the list and export it; removing a number requires admin role + confirm.
- Timezone calling window: leads dialed only 10:00 AM – 9:00 PM in the
  LEAD's local time (derived from their state/area code). Hard rule: no one
  receives a call before 10:00 AM their time regardless of where the agents
  or campaign operate. Single global setting, admin-editable. Out-of-window
  leads → skip + requeue automatically once their local clock passes 10 AM.

---

## Build order

### Sprint 1 — Data model + Lead Management
Foundation everything else needs.
- Schema migration per spec section 1 (Lead, Campaign, Queue, Playlist,
  CallResult, CallLog, DID). Include action_folder queues.
- CSV import: column mapping UI, dedupe by phone, DNC scrub on import,
  invalid-number rejection with downloadable rejects file, timezone derivation
  from area code.
- Playlists: filter builder (state / times_called / custom fields / tags,
  is / is not / between), weighted groups, priority 1–9, live "Available
  leads: N" refresh-on-demand count.
- Action folders (Appointments, Hot Leads, Follow-ups — admin-definable),
  manual click-to-call from any lead in them.
- Global lead search (phone / name / address) across campaigns.
- Custom CRM fields per campaign + lead-card layout editor.

### Sprint 2 — Dispositions engine
The automation brain. Build exactly per spec section 3:
- Disposition objects: name, abbreviation, color (status palette), hotkey,
  category nesting, per-campaign scoping, hide flag.
- One-click actions: end/keep call, schedule callback (picker), add to DNC
  (permanent — see DNC section above), transfer to action folder, take
  ownership (allow/force).
- Escalating rules by times-logged (the recycling engine), including system
  dispositions: no-answer, busy, failed, AMD-machine, abandoned — all with
  retry rules and a global 4h minimum re-dial safety net.
- Require-notes flag, apply tags, announce-to-floor websocket toast.
- Seed set: No Answer, Voicemail, Not Interested, Wrong Number, DNC,
  Callback, Warm Seller, Appointment Set, Contract Interest.

### Sprint 3 — Agent experience
- Three-panel agent screen per DESIGN.md: script panel with merge fields,
  lead card (CRM fields + contact history timeline with notes/recordings),
  call controls + disposition bar with hotkeys (1–9).
- Availability modes: Available / Wrap-up / Break / Meeting / Offline, each
  flagged payable/unpayable (admin-editable list). State machine drives the
  dialer: only Available agents receive bridged calls.
- Wrap-up timer after disposition (configurable, default 5s) → auto-advance.
- Callbacks: fire to the owning agent at the scheduled time (notification +
  queue-jump); fallback if agent offline: hold 15 min then release to queue.
- Dial pad: mute, hold, hangup, DTMF.

### Sprint 4 — Caller ID & number health + AMD
- DID pool: import Telnyx numbers with area code/state; proximity matching
  (area code → state → any); rotation by least-used-today.
- Daily per-DID caps (default 100; presets 75/100/150/200/none). Pool
  exhausted → PAUSE dialing + admin alert (never keep dialing).
- Lead carrier lookup (Telnyx Number Lookup) on import; store per lead.
- DID health: rolling answer-rate per DID (and per DID×carrier); sharp drop
  vs pool average → auto-rest N days + alert. Health states: Healthy /
  Suspect / Resting / Retired, shown on a DID Health page with counters.
- Selection modes per playlist: Strict (healthy only) / Balanced / Off.
- Remediation workflow: mark in-remediation, links to Free Caller Registry
  and carrier portals, flagged-number CSV export.
- AMD via Telnyx: named profiles Quick / Rigorous / custom (map params to
  current Telnyx AMD options — verify param names in docs first). Machine →
  auto-disposition Voicemail → recycling rules fire. Optional VM drop with
  per-lead drop counter (log every drop).

### Sprint 5 — Admin / floor control
- Live floor view per DESIGN.md: agent cards (state, current lead, ticking
  talk timer, calls/contacts/appointments today), campaign stats strip.
- Listen / whisper / barge via Telnyx supervisor legs.
- Callback Manager: all pending callbacks, filter by agent, bulk reassign /
  reschedule orphans.
- Call recording on by default; recordings attached to lead history and
  call logs, playable in-browser.

### Sprint 6 — Reporting & automation
- Dialer Report: dials, connects, no-answer, machine, busy, abandoned,
  connect rate — by campaign/playlist/date range.
- Agent Report: time per availability mode with payable/unpayable totals
  (payroll export CSV), calls, talk time, avg handle, dispositions,
  appointments. Leaderboard view.
- Call Logs: filterable table (date, agent, campaign, disposition, DID,
  AMD outcome, duration), inline recording playback, CSV export.
- DID Health report (from Sprint 4 data).
- Scheduled Jobs: { email report CSV (daily/weekly), start/pause campaign
  at time, pause/unpause agent in queue } with recipient emails.

## Definition of done (every sprint)
Works end-to-end with 2 agents + a 1,000-lead CSV; live states over
websocket; UI conforms to DESIGN.md; no native form controls anywhere.
