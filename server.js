'use strict';
// Trinity Dialer — Phase 1 server
// Webhook receiver + WebRTC softphone backend.
// Model: agent logs in via @telnyx/webrtc. "Go Available" -> server dials the
// agent's SIP URI from the Call Control app; agent browser auto-answers; on
// answer we create a per-agent conference. "Dial" -> originate to lead with AMD;
// on premium AMD human result we join the lead leg into the agent's conference.

const express = require('express');
const path    = require('path');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const TELNYX_KEY    = process.env.TELNYX_KEY;
const CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;   // Call Control app (dials leads + agent SIP)
const WH_TOKEN      = process.env.WH_TOKEN || 'trinity-2026';
const AMD_MODE      = process.env.AMD_MODE || 'premium';
const SB_HOST       = process.env.SUPABASE_HOST;
const SB_KEY        = process.env.SUPABASE_KEY;
const DEFAULT_FROM  = process.env.DEFAULT_FROM || '+19168850241';

const TELNYX_BASE = 'https://api.telnyx.com/v2';
const SIP_DOMAIN  = 'sip.telnyx.com';

// Agent slots -> telephony credential (created via API in Phase 1 setup).
const AGENTS = {
  '1': { name: 'Agent 1', credId: '73d28570-c916-4ff5-9e8d-e81b563a3a95', sip: 'gencredbpblIGHqGrhP3jrADfTrABN9V2jHrXEdD03sJR3JHE' },
  '2': { name: 'Agent 2', credId: 'e4feb42b-db4c-46a1-9bcb-e297c8995ce2', sip: 'gencreddMxzKIjVCM5HLdothCwvofbJdP4K5vNeGIs8GZ6AlZ' },
};

// In-memory runtime state per agent slot (single instance — fine for Phase 1).
// { state, agentLeg, conferenceId, leadLeg, leadNumber }
const rt = {};
for (const slot of Object.keys(AGENTS)) rt[slot] = { state: 'OFFLINE' };

// ── Helpers ───────────────────────────────────────────────────────────────────
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const dec = (b64) => { if (!b64) return null; try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; } };

async function telnyx(method, endpoint, body) {
  const res = await fetch(`${TELNYX_BASE}${endpoint}`, {
    method,
    headers: { 'Authorization': `Bearer ${TELNYX_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Telnyx ${method} ${endpoint} -> ${res.status}: ${text}`);
  return json;
}

async function sbInsert(table, row) {
  if (!SB_HOST || !SB_KEY) return;
  try {
    await fetch(`https://${SB_HOST}/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) { console.error('[sbInsert]', e.message); }
}

function findAgentByLeg(legId) {
  for (const slot of Object.keys(rt)) {
    if (rt[slot].agentLeg === legId || rt[slot].leadLeg === legId) return slot;
  }
  return null;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true, service: 'trinity-dialer', phase: 1,
    telnyx_key: !!TELNYX_KEY, connection_id: !!CONNECTION_ID, supabase: !!(SB_HOST && SB_KEY),
    agents: Object.fromEntries(Object.keys(rt).map(s => [s, rt[s].state])),
    time: new Date().toISOString(),
  });
});

// ── Agent: mint WebRTC login token ─────────────────────────────────────────────
app.get('/api/agent/token', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  const slot = String(req.query.agent || '');
  const a = AGENTS[slot];
  if (!a) return res.status(400).json({ error: 'unknown agent slot' });
  try {
    const jwt = await (await fetch(`${TELNYX_BASE}/telephony_credentials/${a.credId}/token`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${TELNYX_KEY}` },
    })).text();
    res.json({ login_token: jwt.trim(), name: a.name, sip: a.sip });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Agent: Go Available (pull agent into a conference) ──────────────────────────
app.post('/api/agent/available', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  const slot = String(req.body && req.body.agent || '');
  const a = AGENTS[slot];
  if (!a) return res.status(400).json({ error: 'unknown agent slot' });
  if (!CONNECTION_ID) return res.status(400).json({ error: 'TELNYX_CONNECTION_ID not set' });
  if (rt[slot].state !== 'OFFLINE') return res.json({ ok: true, state: rt[slot].state });

  try {
    rt[slot] = { state: 'CONNECTING' };
    const result = await telnyx('POST', '/calls', {
      connection_id: CONNECTION_ID,
      to: `sip:${a.sip}@${SIP_DOMAIN}`,
      from: DEFAULT_FROM,
      client_state: enc({ role: 'agent', slot }),
    });
    rt[slot].agentLeg = result.data && result.data.call_control_id;
    console.log(`[available] agent ${slot} dialing SIP, leg=${rt[slot].agentLeg}`);
    res.json({ ok: true, state: 'CONNECTING' });
  } catch (e) {
    rt[slot] = { state: 'OFFLINE' };
    console.error('[available]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── Agent: Dial a lead ──────────────────────────────────────────────────────────
app.post('/api/dial', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  const slot = String(req.body && req.body.agent || '');
  const to   = req.body && req.body.to;
  const a = AGENTS[slot];
  if (!a) return res.status(400).json({ error: 'unknown agent slot' });
  if (!to) return res.status(400).json({ error: 'missing to' });
  if (rt[slot].state !== 'AVAILABLE' || !rt[slot].conferenceId)
    return res.status(409).json({ error: `agent not available (state=${rt[slot].state})` });

  try {
    const result = await telnyx('POST', '/calls', {
      connection_id: CONNECTION_ID,
      to,
      from: DEFAULT_FROM,
      answering_machine_detection: AMD_MODE === 'disabled' ? 'disabled' : 'premium',
      client_state: enc({ role: 'lead', slot, conf: rt[slot].conferenceId }),
    });
    rt[slot].leadLeg = result.data && result.data.call_control_id;
    rt[slot].leadNumber = to;
    rt[slot].state = 'DIALING';
    console.log(`[dial] agent ${slot} -> ${to}, leadLeg=${rt[slot].leadLeg}`);
    res.json({ ok: true, call_control_id: rt[slot].leadLeg });
  } catch (e) { console.error('[dial]', e.message); res.status(502).json({ error: e.message }); }
});

// ── Agent: hang up current lead (stay available) ────────────────────────────────
app.post('/api/hangup', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  const slot = String(req.body && req.body.agent || '');
  if (!rt[slot]) return res.status(400).json({ error: 'unknown agent slot' });
  const leg = rt[slot].leadLeg;
  try {
    if (leg) await telnyx('POST', `/calls/${leg}/actions/hangup`, {});
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Agent: status poll ───────────────────────────────────────────────────────────
app.get('/api/agent/status', (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  const slot = String(req.query.agent || '');
  if (!rt[slot]) return res.status(400).json({ error: 'unknown agent slot' });
  res.json({ state: rt[slot].state, leadNumber: rt[slot].leadNumber || null });
});

// ── Webhook receiver + bridge logic ─────────────────────────────────────────────
app.post('/webhooks/telnyx', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  res.sendStatus(200);

  const data    = (req.body && req.body.data) || {};
  const event   = data.event_type || 'unknown';
  const payload = data.payload || {};
  const ccid    = payload.call_control_id || null;
  const cs      = dec(payload.client_state);
  const role    = cs && cs.role;
  const slot    = (cs && cs.slot) || findAgentByLeg(ccid);

  console.log(`[wh] ${event} role=${role || '-'} slot=${slot || '-'} ccid=${ccid ? ccid.slice(-8) : '-'}` +
              (payload.result ? ` result=${payload.result}` : ''));

  sbInsert('call_events', { event_type: event, telnyx_call_control_id: ccid, client_state: cs, payload });

  try {
    // Agent leg answered -> create per-agent conference and mark AVAILABLE
    if (event === 'call.answered' && role === 'agent' && slot) {
      const conf = await telnyx('POST', '/conferences', {
        name: `trinity-conf-${slot}-${Date.now()}`,
        call_control_id: ccid,
        beep_enabled: 'never',
      });
      rt[slot].conferenceId = conf.data && conf.data.id;
      rt[slot].agentLeg = ccid;
      rt[slot].state = 'AVAILABLE';
      console.log(`[bridge] agent ${slot} AVAILABLE, conf=${rt[slot].conferenceId}`);
      return;
    }

    // Lead AMD result -> bridge human, drop machine
    if (event === 'call.machine.premium.detection.ended' && role === 'lead' && slot) {
      const r = payload.result || '';
      const isHuman = r.startsWith('human') || r === 'silence' || r === 'not_sure';
      if (isHuman) {
        await telnyx('POST', `/conferences/${cs.conf}/actions/join`, {
          call_control_id: ccid, start_conference_on_enter: true, mute: false,
        });
        rt[slot].state = 'ON_CALL';
        console.log(`[bridge] agent ${slot} ON_CALL (result=${r})`);
      } else {
        await telnyx('POST', `/calls/${ccid}/actions/hangup`, {});
        console.log(`[bridge] dropped machine leg for agent ${slot} (result=${r})`);
      }
      return;
    }

    // Hangups
    if (event === 'call.hangup' && slot) {
      if (role === 'lead' || rt[slot].leadLeg === ccid) {
        rt[slot].leadLeg = null; rt[slot].leadNumber = null;
        if (rt[slot].state !== 'OFFLINE') rt[slot].state = 'AVAILABLE';
        console.log(`[bridge] lead ended, agent ${slot} back to AVAILABLE`);
      } else if (role === 'agent' || rt[slot].agentLeg === ccid) {
        rt[slot] = { state: 'OFFLINE' };
        console.log(`[bridge] agent ${slot} OFFLINE (agent leg ended)`);
      }
      return;
    }
  } catch (e) {
    console.error(`[bridge] error on ${event}:`, e.message);
  }
});

app.listen(PORT, () => console.log(`Trinity Dialer (phase 1) listening on :${PORT}`));
