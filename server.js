'use strict';
// Trinity Dialer — Phase 0 server
// Goal: receive Telnyx Call Control webhooks, decode client_state, log every event,
// and expose a protected /test-dial to originate one call so we can prove events flow.
// Pacing engine, agent FSM and WebRTC come in later phases.

const express = require('express');
const path    = require('path');

const app = express();

// Capture raw body (needed later for Telnyx Ed25519 signature verification).
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const TELNYX_KEY    = process.env.TELNYX_KEY;
const CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;
const WH_TOKEN      = process.env.WH_TOKEN || 'trinity-2026';
const AMD_MODE      = process.env.AMD_MODE || 'premium';
const SB_HOST       = process.env.SUPABASE_HOST;
const SB_KEY        = process.env.SUPABASE_KEY;

const TELNYX_BASE = 'https://api.telnyx.com/v2';

// ── Helpers ───────────────────────────────────────────────────────────────────
function encodeClientState(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}
function decodeClientState(b64) {
  if (!b64) return null;
  try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); }
  catch { return null; }
}

async function telnyx(method, endpoint, body) {
  const res = await fetch(`${TELNYX_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TELNYX_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Telnyx ${method} ${endpoint} -> ${res.status}: ${text}`);
  return json;
}

// Fire-and-forget insert into Supabase (no-ops if DB not configured yet).
async function sbInsert(table, row) {
  if (!SB_HOST || !SB_KEY) return;
  try {
    await fetch(`https://${SB_HOST}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error('[sbInsert] failed:', e.message);
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'trinity-dialer',
    phase: 0,
    telnyx_key: !!TELNYX_KEY,
    connection_id: !!CONNECTION_ID,
    supabase: !!(SB_HOST && SB_KEY),
    time: new Date().toISOString(),
  });
});

// ── Webhook receiver ───────────────────────────────────────────────────────────
// Telnyx posts { data: { event_type, payload: { call_control_id, client_state, ... } } }
app.post('/webhooks/telnyx', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  // Ack immediately — Telnyx retries on non-2xx, so never block on DB work.
  res.sendStatus(200);

  const data       = req.body && req.body.data ? req.body.data : {};
  const eventType  = data.event_type || 'unknown';
  const payload    = data.payload || {};
  const ccid       = payload.call_control_id || null;
  const clientState = decodeClientState(payload.client_state);

  console.log(`[webhook] ${eventType} ccid=${ccid || '-'} state=${clientState ? JSON.stringify(clientState) : '-'}`);
  if (eventType === 'call.machine.detection.ended') {
    console.log(`  AMD result: ${payload.result}`);
  }

  await sbInsert('call_events', {
    event_type: eventType,
    telnyx_call_control_id: ccid,
    client_state: clientState,
    payload,
  });
});

// ── Test dial (protected) ───────────────────────────────────────────────────────
// POST /test-dial?token=...  { to, from }
// Originates one outbound call with AMD so we can watch the event sequence.
app.post('/test-dial', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  if (!CONNECTION_ID) return res.status(400).json({ error: 'TELNYX_CONNECTION_ID not set' });

  const { to, from } = req.body || {};
  if (!to || !from) return res.status(400).json({ error: 'body needs { to, from }' });

  try {
    const client_state = encodeClientState({ test: true, ts: Date.now() });
    const result = await telnyx('POST', '/calls', {
      connection_id: CONNECTION_ID,
      to,
      from,
      answering_machine_detection: AMD_MODE === 'disabled' ? 'disabled' : 'premium',
      client_state,
    });
    console.log(`[test-dial] originated to=${to} from=${from} ccid=${result.data && result.data.call_control_id}`);
    res.json({ ok: true, call_control_id: result.data && result.data.call_control_id });
  } catch (e) {
    console.error('[test-dial] error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Trinity Dialer (phase 0) listening on :${PORT}`));
