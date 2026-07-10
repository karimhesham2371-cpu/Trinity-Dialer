# Trinity Dialer

Cloud **power dialer** built on Telnyx. Greenfield — separate from the KMC SMS dashboard.

Stack: Node.js + Express, Supabase (Postgres via REST), Render hosting, `@telnyx/webrtc` browser softphone (phase 1+).

## Architecture (MVP)

- **Web service** (`server.js`) — REST API + Telnyx Call Control webhook receiver.
- **Pacing worker** (phase 2) — single long-running instance that dials the next eligible lead the moment an agent frees up (power = 1 line per available agent).
- **Agent SPA** (`public/`, phase 1) — WebRTC softphone + disposition UI.

Each agent, on "Go Available," joins a per-agent Telnyx **conference** over WebRTC and stays in it the whole shift. When AMD confirms a human, the lead's PSTN leg is joined into that conference → instant connect, ~0 abandonment.

## Call flow (dial → AMD → bridge → disposition)

```
pacing worker -> POST /calls (AMD=premium, client_state={lead,agent,conf})
  call.initiated -> call.answered -> call.machine.detection.ended
     result=human   -> conference join -> record_start -> agent ON_CALL
     result=machine -> hangup -> lead=MACHINE, agent stays AVAILABLE
  call.hangup -> agent WRAP_UP -> disposition -> agent AVAILABLE
```

`client_state` (base64 JSON) is echoed on every webhook, so the stateless handler
always knows which lead/agent/conference a call belongs to.

## Phases

- **Phase 0 (current)** — webhook receiver + `/test-dial` to prove events flow.
- **Phase 1** — WebRTC login, per-agent conference, manual dial + bridge.
- **Phase 2 (MVP)** — pacing worker, dispositions, callbacks, agent FSM.
- **Phase 3** — DNC/litigator scrub, calling-window enforcement, multi-agent hardening.
- **Phase 4** — predictive pacing, live transcription, barge/whisper, reporting.

## Setup

1. `npm install`
2. Copy `.env.example` -> `.env`, fill values.
3. Run `db/schema.sql` in the Supabase SQL editor.
4. `npm start` (or deploy to Render).
5. Create the Telnyx Voice API Application pointed at `https://<render-url>/webhooks/telnyx?token=<WH_TOKEN>`; set `TELNYX_CONNECTION_ID`.
6. Test: `POST /test-dial?token=<WH_TOKEN>` with `{ "to": "+1...", "from": "+1<your telnyx DID>" }`.

## Env

See `.env.example`. `SUPABASE_KEY` is the service_role key — server-side only, never ship to the browser.
