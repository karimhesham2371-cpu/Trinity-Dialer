'use strict';
// Trinity Dialer — MVP server
// Multi-user cloud power dialer on Telnyx.
//   • Credential login (bcrypt + JWT), roles: admin / agent
//   • Admin: create users (auto-provisions a Telnyx WebRTC credential), build
//     campaigns, assign agents, upload lead CSVs, Start/Stop/Pause/Reset
//   • Agent: softphone auto-connects on login and goes Available; the pacing
//     engine auto-dials the next lead whenever the agent is free and their
//     campaign is RUNNING (power dialing — 1 line per available agent)
//   • Caller ID rotates randomly across the DIDs on the Telnyx connection,
//     skipping any number currently engaged on a live call
//   • Per-agent Telnyx conference: agent joins over WebRTC and stays all shift;
//     when premium AMD confirms a human, the lead PSTN leg joins the conference

const express = require('express');
const http    = require('http');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json({ limit: '8mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.text({ type: 'text/csv', limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────────────────────
const env = (k, dflt) => (process.env[k] != null ? String(process.env[k]).trim() : dflt);
const PORT               = env('PORT', 3000);
const TELNYX_KEY         = env('TELNYX_KEY');
const CONNECTION_ID      = env('TELNYX_CONNECTION_ID');                    // Call Control app (dials leads + agent SIP)
const CRED_CONNECTION_ID = env('TELNYX_CRED_CONNECTION_ID', '3001006440748943295'); // Credential Connection (agent WebRTC)
const WH_TOKEN           = env('WH_TOKEN', 'trinity-2026');
const AMD_MODE           = env('AMD_MODE', 'premium');
const SB_HOST            = env('SUPABASE_HOST');
const SB_KEY             = env('SUPABASE_KEY');
const DEFAULT_FROM       = env('DEFAULT_FROM', '+19168850241');
const JWT_SECRET         = env('JWT_SECRET', 'trinity-dev-secret-change-me');
const PACING_MS          = Number(process.env.PACING_MS || 3000);
const CALLER_IDS_ENV     = (process.env.CALLER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const TELNYX_BASE = 'https://api.telnyx.com/v2';
const SIP_DOMAIN  = 'sip.telnyx.com';

// Default one-click dispositions (used when a campaign hasn't customised its own).
// outcome: final lead status. is_callback/is_dnc/recycle drive special handling.
const DEFAULT_DISPOSITIONS = [
  { code: 'SALE',           label: 'Sale / Appt',    color: '#2ea043', hotkey: '1', outcome: 'DONE' },
  { code: 'CALLBACK',       label: 'Callback',       color: '#2f81f7', hotkey: '2', is_callback: true },
  { code: 'NOT_INTERESTED', label: 'Not Interested', color: '#8b95a5', hotkey: '3', outcome: 'DONE' },
  { code: 'NO_ANSWER',      label: 'No Answer',      color: '#d29922', hotkey: '4', recycle: 'no_answer' },
  { code: 'VOICEMAIL',      label: 'Left Voicemail', color: '#a371f7', hotkey: '5', recycle: 'no_answer' },
  { code: 'WRONG_NUMBER',   label: 'Wrong Number',   color: '#f0883e', hotkey: '6', outcome: 'BAD_NUMBER' },
  { code: 'DNC',            label: 'Do Not Call',    color: '#da3633', hotkey: '7', is_dnc: true },
];
const DEFAULT_RECYCLE = { no_answer: { hours: 4, max: 5 }, busy: { minutes: 20, max: 8 } };

// In-memory runtime keyed by agent id (single instance — required for pacing).
// { state, sip, agentLeg, conferenceId, leadLeg, leadId, leadNumber, fromNumber }
const rt = {};

// Discovered outbound caller-ID pool (refreshed from Telnyx).
let CALLER_POOL = CALLER_IDS_ENV.slice();

// ── Telnyx REST ───────────────────────────────────────────────────────────────
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

// ── Supabase REST (PostgREST) ──────────────────────────────────────────────────
async function sbReq(method, pathQ, body, prefer) {
  const res = await fetch(`https://${SB_HOST}/rest/v1/${pathQ}`, {
    method,
    headers: {
      'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(prefer ? { 'Prefer': prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Supabase ${method} ${pathQ} -> ${res.status}: ${text}`);
  return json;
}
const sbSelect = (t, q = '')      => sbReq('GET',    `${t}?${q}`);
const sbInsert = (t, row)         => sbReq('POST',   t, row, 'return=representation');
const sbUpdate = (t, q, patch)    => sbReq('PATCH',  `${t}?${q}`, patch, 'return=representation');
const sbDelete = (t, q)           => sbReq('DELETE', `${t}?${q}`);
function sbLog(table, row) { // fire-and-forget audit insert
  if (!SB_HOST || !SB_KEY) return;
  sbReq('POST', table, row, 'return=minimal').catch(e => console.error('[sbLog]', e.message));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const dec = (b64) => { if (!b64) return null; try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; } };

function signToken(a) {
  return jwt.sign({ id: a.id, role: a.role, name: a.name, email: a.email }, JWT_SECRET, { expiresIn: '12h' });
}
function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.sendStatus(401);
  try { req.user = jwt.verify(m[1], JWT_SECRET); next(); }
  catch { return res.sendStatus(401); }
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.sendStatus(403);
  next();
}
function findAgentByLeg(legId) {
  for (const id of Object.keys(rt)) {
    if (rt[id].agentLeg === legId || rt[id].leadLeg === legId) return id;
  }
  return null;
}

// Persist the full in-memory runtime for an agent to the agents row, so a server
// restart can rehydrate mid-shift instead of dropping every live call.
async function persistRt(id) {
  const st = rt[id];
  const now = new Date().toISOString();
  const patch = st ? {
    state: st.state || 'OFFLINE',
    agent_leg: st.agentLeg || null,
    lead_leg: st.leadLeg || null,
    lead_id: st.leadId || null,
    lead_number: st.leadNumber || null,
    from_number: st.fromNumber || null,
    conference_id: st.conferenceId || null,
    rt_updated_at: now, updated_at: now,
  } : { state: 'OFFLINE', agent_leg: null, lead_leg: null, lead_id: null,
        lead_number: null, from_number: null, conference_id: null, rt_updated_at: now, updated_at: now };
  return sbUpdate('agents', `id=eq.${id}`, patch).catch(e => console.error('[persistRt]', e.message));
}

// Audit trail: fire-and-forget user-activity log for the Audit Logs report.
function audit(actor, action, { target_type, target_id, meta } = {}) {
  sbLog('audit_log', {
    actor_id: (actor && actor.id) || null,
    actor_name: (actor && actor.name) || null,
    actor_role: (actor && actor.role) || null,
    action,
    target_type: target_type || null,
    target_id: target_id != null ? String(target_id) : null,
    meta: meta || {},
  });
}

// Agent time tracking: one row per state span, so the Agent Report can sum
// login / dialing / talk / wrap / break durations. Closing is done by an
// agent_id + ended_at.is.null filter so it survives in-memory rt resets.
function logStateEvent(id, state) {
  if (!SB_HOST) return;
  const st = rt[id] || (rt[id] = {});
  if (st.loggedState === state) return;
  const now = new Date().toISOString();
  const durSec = st.stateStart ? Math.max(0, Math.round((Date.now() - st.stateStart) / 1000)) : null;
  sbUpdate('agent_state_events', `agent_id=eq.${id}&ended_at=is.null`,
    { ended_at: now, duration_sec: durSec }).catch(() => {});
  st.loggedState = state; st.stateStart = Date.now();
  // OFFLINE isn't tracked as a span (we only closed the previous open one).
  if (state !== 'OFFLINE') sbLog('agent_state_events', { agent_id: id, state, started_at: now });
}

async function setAgentState(id, state) {
  const changed = !rt[id] || rt[id].loggedState !== state;
  if (rt[id]) { rt[id].state = state; rt[id].rtUpdatedAt = Date.now(); }
  await persistRt(id);
  if (changed) logStateEvent(id, state);
  wsAgentSnapshot(id);   // push to the agent's own socket + the admin floor
}

// Rebuild `rt` from the agents table on boot (durable-state recovery).
async function rehydrateRt() {
  if (!SB_HOST) return;
  try {
    const rows = await sbSelect('agents',
      `state=neq.OFFLINE&select=id,state,sip_username,agent_leg,lead_leg,lead_id,lead_number,from_number,conference_id`);
    let n = 0;
    for (const a of rows || []) {
      rt[a.id] = {
        state: a.state, sip: a.sip_username,
        agentLeg: a.agent_leg, leadLeg: a.lead_leg, leadId: a.lead_id,
        leadNumber: a.lead_number, fromNumber: a.from_number, conferenceId: a.conference_id,
        rtUpdatedAt: Date.now(),
      };
      n++;
    }
    if (n) console.log(`[rehydrate] restored ${n} live agent(s) from DB`);
  } catch (e) { console.error('[rehydrate]', e.message); }
}

// ── Caller-ID pool ────────────────────────────────────────────────────────────
async function refreshCallerPool() {
  if (CALLER_IDS_ENV.length) { CALLER_POOL = CALLER_IDS_ENV.slice(); return; }
  if (!CONNECTION_ID) return;
  try {
    const r = await telnyx('GET', `/phone_numbers?filter[connection_id]=${CONNECTION_ID}&page[size]=100`);
    const nums = (r.data || []).map(n => n.phone_number).filter(Boolean);
    if (nums.length) CALLER_POOL = nums;
  } catch (e) { console.error('[callerPool]', e.message); }
}
function pickCallerId(preferredAreaCode) {
  const inUse = new Set(Object.values(rt).map(s => s.fromNumber).filter(Boolean));
  let candidates = CALLER_POOL.filter(n => !inUse.has(n));
  if (!candidates.length) candidates = CALLER_POOL.slice();
  // Local presence: prefer a DID whose area code matches the lead's.
  if (preferredAreaCode) {
    const local = candidates.filter(n => areaCodeOf(n) === preferredAreaCode);
    if (local.length) candidates = local;
  }
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : DEFAULT_FROM;
}
function areaCodeOf(e164) {
  const d = String(e164 || '').replace(/[^\d]/g, '');
  // +1XXXYYYYYYY -> XXX
  if (d.length === 11 && d.startsWith('1')) return d.slice(1, 4);
  if (d.length === 10) return d.slice(0, 3);
  return null;
}

// ── WebSocket gateway ───────────────────────────────────────────────────────────
// Agents subscribe to their own live state; admins subscribe to the whole floor.
// clients: Set of { ws, userId, role }
const wsClients = new Set();
function wsSend(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function wsToAdmins(obj) { for (const c of wsClients) if (c.role === 'admin') wsSend(c.ws, obj); }
function wsToAgent(id, obj) { for (const c of wsClients) if (c.userId === id) wsSend(c.ws, obj); }
function agentSnapshot(id) {
  const st = rt[id] || { state: 'OFFLINE' };
  return { agentId: id, state: st.state, leadId: st.leadId || null, leadNumber: st.leadNumber || null,
           fromNumber: st.fromNumber || null, onCallSince: st.onCallSince || null };
}
// Push one agent's state to that agent and to every admin (floor view).
function wsAgentSnapshot(id) {
  const snap = agentSnapshot(id);
  wsToAgent(id, { type: 'agent.state', ...snap });
  wsToAdmins({ type: 'floor.agent', ...snap });
}

// ── Auth: login + admin bootstrap ───────────────────────────────────────────────
async function bootstrapAdmin() {
  const email = env('ADMIN_EMAIL'), pw = env('ADMIN_PASSWORD');
  if (!email || !pw || !SB_HOST || !SB_KEY) return;
  try {
    const hash = await bcrypt.hash(pw, 10);
    const rows = await sbSelect('agents', `email=eq.${encodeURIComponent(email)}&select=id`);
    if (rows.length) {
      await sbUpdate('agents', `id=eq.${rows[0].id}`, { password_hash: hash, role: 'admin', active: true });
      console.log(`[bootstrap] admin ${email} refreshed`);
    } else {
      await sbInsert('agents', { name: 'Admin', email, password_hash: hash, role: 'admin', active: true, state: 'OFFLINE' });
      console.log(`[bootstrap] admin ${email} created`);
    }
  } catch (e) { console.error('[bootstrap]', e.message); }
}

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing credentials' });
  try {
    const rows = await sbSelect('agents', `email=eq.${encodeURIComponent(String(email).trim())}&select=*`);
    const a = rows[0];
    if (!a || !a.active || !a.password_hash) return res.status(401).json({ error: 'invalid login' });
    const ok = await bcrypt.compare(password, a.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid login' });
    audit({ id: a.id, name: a.name, role: a.role }, 'LOGIN', { target_type: 'session' });
    res.json({ token: signToken(a), user: { id: a.id, name: a.name, email: a.email, role: a.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true, service: 'trinity-dialer', phase: 'phase0',
    telnyx_key: !!TELNYX_KEY, connection_id: !!CONNECTION_ID, supabase: !!(SB_HOST && SB_KEY),
    caller_pool: CALLER_POOL.length, agents_online: Object.keys(rt).length,
    ws_clients: wsClients.size, recording: true,
    time: new Date().toISOString(),
  });
});

// ══ ADMIN: users ════════════════════════════════════════════════════════════════
app.get('/api/admin/users', auth, adminOnly, async (_req, res) => {
  try {
    const rows = await sbSelect('agents', 'select=id,name,email,role,active,state,telnyx_credential_id,campaign_id&order=created_at.asc');
    res.json({ users: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  try {
    const existing = await sbSelect('agents', `email=eq.${encodeURIComponent(email)}&select=id`);
    if (existing.length) return res.status(409).json({ error: 'email already exists' });

    // Provision a Telnyx WebRTC telephony credential on the Credential Connection.
    let credId = null, sip = null;
    if (TELNYX_KEY) {
      const cred = await telnyx('POST', '/telephony_credentials', {
        connection_id: CRED_CONNECTION_ID, name: `trinity-${String(email).replace(/[^a-z0-9]/gi, '')}`,
      });
      credId = cred.data && cred.data.id;
      sip    = cred.data && cred.data.sip_username;
    }
    const hash = await bcrypt.hash(password, 10);
    const [row] = await sbInsert('agents', {
      name, email: String(email).trim(), password_hash: hash, role: role === 'admin' ? 'admin' : 'agent',
      telnyx_credential_id: credId, sip_username: sip, active: true, state: 'OFFLINE',
    });
    audit(req.user, 'ADD_AGENT', { target_type: 'agent', target_id: row.id, meta: { name: row.name, email: row.email, role: row.role } });
    res.json({ ok: true, user: { id: row.id, name: row.name, email: row.email, role: row.role, sip_username: sip } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const patch = {};
  const { name, password, active, role } = req.body || {};
  if (name != null) patch.name = name;
  if (active != null) patch.active = !!active;
  if (role != null) patch.role = role === 'admin' ? 'admin' : 'agent';
  if (password) patch.password_hash = await bcrypt.hash(password, 10);
  try { await sbUpdate('agents', `id=eq.${req.params.id}`, patch); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ADMIN: campaigns ════════════════════════════════════════════════════════════
app.get('/api/admin/campaigns', auth, adminOnly, async (_req, res) => {
  try {
    const campaigns = await sbSelect('campaigns', 'select=*&order=created_at.desc');
    const assigns   = await sbSelect('campaign_agents', 'select=campaign_id,agent_id');
    const out = [];
    for (const c of campaigns) {
      const agentIds = assigns.filter(a => a.campaign_id === c.id).map(a => a.agent_id);
      const counts   = await sbSelect('leads', `campaign_id=eq.${c.id}&select=status`);
      const byStatus = counts.reduce((m, l) => (m[l.status] = (m[l.status] || 0) + 1, m), {});
      out.push({ ...c, agent_ids: agentIds, lead_total: counts.length, lead_status: byStatus });
    }
    res.json({ campaigns: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/campaigns', auth, adminOnly, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const [row] = await sbInsert('campaigns', { name, status: 'DRAFT', active: false });
    audit(req.user, 'CREATE_CAMPAIGN', { target_type: 'campaign', target_id: row.id, meta: { name } });
    res.json({ ok: true, campaign: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/campaigns/:id/agents', auth, adminOnly, async (req, res) => {
  const { agent_id } = req.body || {};
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  try {
    await sbInsert('campaign_agents', { campaign_id: req.params.id, agent_id });
    await sbUpdate('agents', `id=eq.${agent_id}`, { campaign_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/campaigns/:id/agents/:agentId', auth, adminOnly, async (req, res) => {
  try {
    await sbDelete('campaign_agents', `campaign_id=eq.${req.params.id}&agent_id=eq.${req.params.agentId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV lead upload. Body is raw text/csv. Columns: phone,first_name,last_name,address,state
app.post('/api/admin/campaigns/:id/leads', auth, adminOnly, async (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : (req.body && req.body.csv) || '';
  if (!csv.trim()) return res.status(400).json({ error: 'empty csv' });
  try {
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(400).json({ error: 'no rows parsed' });
    const KNOWN = new Set(['phone','number','phone_number','first_name','firstname','first','last_name','lastname','last','address','state']);
    const leads = rows
      .map(r => {
        const phone = normPhone(r.phone || r.number || r.phone_number || '');
        // preserve any extra columns as merge fields
        const custom = {};
        for (const k of Object.keys(r)) if (!KNOWN.has(k) && r[k]) custom[k] = r[k];
        return {
          campaign_id: req.params.id,
          phone,
          first_name: r.first_name || r.firstname || r.first || null,
          last_name:  r.last_name  || r.lastname  || r.last  || null,
          address:    r.address || null,
          state:      r.state || null,
          area_code:  areaCodeOf(phone),
          custom,
          status: 'NEW',
        };
      })
      .filter(l => l.phone);
    if (!leads.length) return res.status(400).json({ error: 'no valid phone numbers found' });
    // insert in chunks
    let inserted = 0;
    for (let i = 0; i < leads.length; i += 500) {
      await sbInsert('leads', leads.slice(i, i + 500));
      inserted += Math.min(500, leads.length - i);
    }
    audit(req.user, 'UPLOAD_LEADS', { target_type: 'campaign', target_id: req.params.id, meta: { inserted, skipped: rows.length - leads.length } });
    res.json({ ok: true, inserted, skipped: rows.length - leads.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function setCampaignStatus(id, status) {
  await sbUpdate('campaigns', `id=eq.${id}`, { status, active: status === 'RUNNING' });
}
app.post('/api/admin/campaigns/:id/start', auth, adminOnly, async (req, res) => {
  try { await setCampaignStatus(req.params.id, 'RUNNING');
    audit(req.user, 'CAMPAIGN_START', { target_type: 'campaign', target_id: req.params.id });
    res.json({ ok: true, status: 'RUNNING' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/pause', auth, adminOnly, async (req, res) => {
  try { await setCampaignStatus(req.params.id, 'PAUSED');
    audit(req.user, 'CAMPAIGN_PAUSE', { target_type: 'campaign', target_id: req.params.id });
    res.json({ ok: true, status: 'PAUSED' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/stop', auth, adminOnly, async (req, res) => {
  try { await setCampaignStatus(req.params.id, 'STOPPED');
    audit(req.user, 'CAMPAIGN_STOP', { target_type: 'campaign', target_id: req.params.id });
    res.json({ ok: true, status: 'STOPPED' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Reset: stop, and requeue every lead back to NEW (attempts zeroed)
app.post('/api/admin/campaigns/:id/reset', auth, adminOnly, async (req, res) => {
  try {
    await setCampaignStatus(req.params.id, 'STOPPED');
    await sbUpdate('leads', `campaign_id=eq.${req.params.id}`,
      { status: 'NEW', attempts: 0, last_attempt_at: null, next_callback_at: null, assigned_agent_id: null });
    audit(req.user, 'CAMPAIGN_RESET', { target_type: 'campaign', target_id: req.params.id });
    res.json({ ok: true, status: 'STOPPED' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ADMIN: reports ══════════════════════════════════════════════════════════════
// 1) Audit Logs — user activity trail. Filters: from, to, actor_id, action, limit.
app.get('/api/admin/reports/audit', auth, adminOnly, async (req, res) => {
  const { from, to, actor_id, action } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const f = ['select=*', `order=created_at.desc`, `limit=${limit}`];
  if (from)     f.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to)       f.push(`created_at=lte.${encodeURIComponent(to)}`);
  if (actor_id) f.push(`actor_id=eq.${actor_id}`);
  if (action)   f.push(`action=eq.${encodeURIComponent(action)}`);
  try { res.json({ rows: await sbSelect('audit_log', f.join('&')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) Call Logs — calls with recordings for listen/download. Filters: from,to,agent_id.
async function agentNameMap() {
  const rows = await sbSelect('agents', 'select=id,name');
  return rows.reduce((m, a) => (m[a.id] = a.name, m), {});
}
app.get('/api/admin/reports/calls', auth, adminOnly, async (req, res) => {
  const { from, to, agent_id } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const f = ['select=*', 'order=created_at.desc', `limit=${limit}`];
  if (from)     f.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to)       f.push(`created_at=lte.${encodeURIComponent(to)}`);
  if (agent_id) f.push(`agent_id=eq.${agent_id}`);
  try {
    const [rows, names] = await Promise.all([sbSelect('calls', f.join('&')), agentNameMap()]);
    res.json({ rows: rows.map(r => ({ ...r, agent_name: names[r.agent_id] || null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3) Research Calls — find calls by phone number (matches either leg).
app.get('/api/admin/reports/research', auth, adminOnly, async (req, res) => {
  const digits = String(req.query.phone || '').replace(/[^\d]/g, '');
  if (!digits) return res.status(400).json({ error: 'phone required' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const pat = `*${digits}*`;
  try {
    const [rows, names] = await Promise.all([
      sbSelect('calls', `or=(to_number.ilike.${pat},from_number.ilike.${pat})&order=created_at.desc&limit=${limit}&select=*`),
      agentNameMap(),
    ]);
    res.json({ rows: rows.map(r => ({ ...r, agent_name: names[r.agent_id] || null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4) Agent Report — per-agent logged-in / dialing / talk / wrap / break seconds
// over [from,to], computed by clamping each state span to the window.
app.get('/api/admin/reports/agent', auth, adminOnly, async (req, res) => {
  const now = Date.now();
  const from = req.query.from ? new Date(req.query.from).getTime() : (now - 24 * 3600e3);
  const to   = req.query.to   ? new Date(req.query.to).getTime()   : now;
  // Buckets that make up "logged in" time.
  const LOGGED = new Set(['CONNECTING', 'AVAILABLE', 'CLAIMING', 'DIALING', 'ON_CALL', 'WRAP_UP', 'BREAK']);
  try {
    // Any span overlapping the window: started before `to` AND (open OR ended after `from`).
    const spans = await sbSelect('agent_state_events',
      `started_at=lte.${encodeURIComponent(new Date(to).toISOString())}` +
      `&or=(ended_at.is.null,ended_at.gte.${encodeURIComponent(new Date(from).toISOString())})` +
      `&select=agent_id,state,started_at,ended_at&limit=100000`);
    const names = await agentNameMap();
    const acc = {};
    for (const s of spans) {
      const start = new Date(s.started_at).getTime();
      const end   = s.ended_at ? new Date(s.ended_at).getTime() : now;
      const dur   = Math.max(0, Math.min(end, to) - Math.max(start, from)) / 1000;
      if (dur <= 0) continue;
      const a = acc[s.agent_id] || (acc[s.agent_id] = { agent_id: s.agent_id, name: names[s.agent_id] || '—',
        logged_in: 0, dialing: 0, talk: 0, wrap: 0, break: 0, available: 0 });
      if (LOGGED.has(s.state)) a.logged_in += dur;
      if (s.state === 'DIALING' || s.state === 'CLAIMING') a.dialing += dur;
      else if (s.state === 'ON_CALL') a.talk += dur;
      else if (s.state === 'WRAP_UP') a.wrap += dur;
      else if (s.state === 'BREAK') a.break += dur;
      else if (s.state === 'AVAILABLE' || s.state === 'CONNECTING') a.available += dur;
    }
    const rows = Object.values(acc).map(a => {
      for (const k of ['logged_in', 'dialing', 'talk', 'wrap', 'break', 'available']) a[k] = Math.round(a[k]);
      return a;
    }).sort((x, y) => y.logged_in - x.logged_in);
    res.json({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recording access — returns the URL and audits the listen/download.
app.get('/api/admin/reports/recording/:id', auth, adminOnly, async (req, res) => {
  try {
    const rows = await sbSelect('calls', `id=eq.${req.params.id}&select=id,recording_url,to_number,from_number`);
    const c = rows[0];
    if (!c || !c.recording_url) return res.status(404).json({ error: 'no recording' });
    const download = req.query.download === '1';
    audit(req.user, download ? 'CALL_DOWNLOAD' : 'CALL_LISTEN',
      { target_type: 'call', target_id: c.id, meta: { to: c.to_number, from: c.from_number } });
    res.json({ url: c.recording_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5) Office Map — seats + live status. GET floor, POST a seat position.
app.get('/api/admin/floor', auth, adminOnly, async (_req, res) => {
  try {
    const rows = await sbSelect('agents', 'active=eq.true&select=id,name,role,seat_x,seat_y&order=name.asc');
    res.json({ agents: rows.map(a => ({ ...a, state: (rt[a.id] && rt[a.id].state) || 'OFFLINE' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/floor/seat', auth, adminOnly, async (req, res) => {
  const { agent_id, x, y } = req.body || {};
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  const patch = { seat_x: x == null ? null : Number(x), seat_y: y == null ? null : Number(y) };
  try { await sbUpdate('agents', `id=eq.${agent_id}`, patch); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ AGENT: softphone token + presence ══════════════════════════════════════════
app.get('/api/agent/token', auth, async (req, res) => {
  try {
    const rows = await sbSelect('agents', `id=eq.${req.user.id}&select=telnyx_credential_id,name,sip_username`);
    const a = rows[0];
    if (!a || !a.telnyx_credential_id) return res.status(400).json({ error: 'no telnyx credential provisioned' });
    const jwtTok = await (await fetch(`${TELNYX_BASE}/telephony_credentials/${a.telnyx_credential_id}/token`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${TELNYX_KEY}` },
    })).text();
    res.json({ login_token: jwtTok.trim(), name: a.name, sip: a.sip_username });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Go Available: pull the agent into their own conference over the WebRTC leg.
app.post('/api/agent/available', auth, async (req, res) => {
  const id = req.user.id;
  if (!CONNECTION_ID) return res.status(400).json({ error: 'TELNYX_CONNECTION_ID not set' });
  // Busy states hold; only OFFLINE and BREAK may (re-)enter the floor. Break
  // released the Telnyx leg, so resuming re-establishes the softphone like a
  // fresh go-available.
  if (rt[id] && ['CONNECTING', 'AVAILABLE', 'CLAIMING', 'DIALING', 'ON_CALL', 'WRAP_UP'].includes(rt[id].state))
    return res.json({ ok: true, state: rt[id].state });
  const wasBreak = rt[id] && rt[id].state === 'BREAK';
  try {
    const rows = await sbSelect('agents', `id=eq.${id}&select=sip_username`);
    const sip = rows[0] && rows[0].sip_username;
    if (!sip) return res.status(400).json({ error: 'no sip username' });
    rt[id] = { state: 'CONNECTING', sip };
    logStateEvent(id, 'CONNECTING');   // opens the logged-in span at go-available
    audit(req.user, 'GO_AVAILABLE', { target_type: 'session', meta: { from: wasBreak ? 'BREAK' : 'OFFLINE' } });
    const result = await telnyx('POST', '/calls', {
      connection_id: CONNECTION_ID,
      to: `sip:${sip}@${SIP_DOMAIN}`,
      from: DEFAULT_FROM,
      client_state: enc({ role: 'agent', agentId: id }),
    });
    rt[id].agentLeg = result.data && result.data.call_control_id;
    res.json({ ok: true, state: 'CONNECTING' });
  } catch (e) {
    rt[id] = { state: 'OFFLINE' };
    res.status(502).json({ error: e.message });
  }
});

// Go Offline / break. reason:'break' tracks a BREAK span (counts toward logged-in
// time, measurable break duration); otherwise a full logout to OFFLINE.
app.post('/api/agent/offline', auth, async (req, res) => {
  const id = req.user.id;
  const st = rt[id];
  const isBreak = (req.body && req.body.reason) === 'break';
  try {
    if (st && st.agentLeg) await telnyx('POST', `/calls/${st.agentLeg}/actions/hangup`, {}).catch(() => {});
    const nextState = isBreak ? 'BREAK' : 'OFFLINE';
    rt[id] = { state: nextState };
    await setAgentState(id, nextState);
    audit(req.user, isBreak ? 'GO_BREAK' : 'LOGOUT', { target_type: 'session' });
    res.json({ ok: true, state: nextState });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/hangup', auth, async (req, res) => {
  const st = rt[req.user.id];
  try { if (st && st.leadLeg) await telnyx('POST', `/calls/${st.leadLeg}/actions/hangup`, {}); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/agent/status', auth, (req, res) => {
  const st = rt[req.user.id] || { state: 'OFFLINE' };
  res.json({ state: st.state, leadNumber: st.leadNumber || null, leadId: st.leadId || null,
             fromNumber: st.fromNumber || null, onCallSince: st.onCallSince || null });
});

// Load a campaign's config, filling in defaults for unset dialer fields.
async function campaignConfig(id) {
  if (!id) return null;
  const rows = await sbSelect('campaigns', `id=eq.${id}&select=*`).catch(() => []);
  const c = rows[0];
  if (!c) return null;
  return {
    ...c,
    dispositions: Array.isArray(c.dispositions) && c.dispositions.length ? c.dispositions : DEFAULT_DISPOSITIONS,
    recycle_rules: c.recycle_rules && Object.keys(c.recycle_rules).length ? c.recycle_rules : DEFAULT_RECYCLE,
    wrap_seconds: c.wrap_seconds != null ? c.wrap_seconds : 5,
    script: c.script || '',
  };
}
function mergeScript(script, lead) {
  if (!script) return '';
  const map = { first_name: lead.first_name, last_name: lead.last_name, phone: lead.phone,
    address: lead.address, state: lead.state, ...(lead.custom || {}) };
  return script.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (map[k] != null && map[k] !== '' ? map[k] : `—`));
}

// Everything the agent screen needs about the current lead: full record, campaign
// script (merged), disposition buttons, wrap timer, and this lead's contact history.
app.get('/api/agent/context', auth, async (req, res) => {
  const st = rt[req.user.id];
  if (!st || !st.leadId) return res.json({ state: st ? st.state : 'OFFLINE', lead: null });
  try {
    const leadRows = await sbSelect('leads', `id=eq.${st.leadId}&select=*`);
    const lead = leadRows[0];
    if (!lead) return res.json({ state: st.state, lead: null });
    const cfg = await campaignConfig(lead.campaign_id);
    const history = await sbSelect('dispositions',
      `lead_id=eq.${st.leadId}&select=code,notes,callback_at,created_at&order=created_at.desc&limit=20`).catch(() => []);
    res.json({
      state: st.state, onCallSince: st.onCallSince || null,
      lead: { ...lead, custom: lead.custom || {} },
      caller_id: st.fromNumber || null,
      campaign: cfg ? { id: cfg.id, name: cfg.name, wrap_seconds: cfg.wrap_seconds,
        dispositions: cfg.dispositions, script: cfg.script, script_merged: mergeScript(cfg.script, lead) } : null,
      history,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a disposition. Applies callback/DNC/recycle rules, then moves the agent
// from WRAP_UP back to AVAILABLE (auto-advance on the client after wrap timer).
app.post('/api/agent/disposition', auth, async (req, res) => {
  const st = rt[req.user.id];
  const { code, notes, callback_at } = req.body || {};
  const leadId = (st && st.leadId) || (req.body && req.body.lead_id);
  if (!code) return res.status(400).json({ error: 'code required' });
  if (!leadId) return res.status(400).json({ error: 'no lead to disposition' });
  try {
    const leadRows = await sbSelect('leads', `id=eq.${leadId}&select=*`);
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const cfg = await campaignConfig(lead.campaign_id);
    const disp = (cfg.dispositions || DEFAULT_DISPOSITIONS).find(d => d.code === code) || { code, outcome: 'DONE' };

    // Record the disposition row.
    sbLog('dispositions', { lead_id: leadId, agent_id: req.user.id, campaign_id: lead.campaign_id,
      code, notes: notes || null, callback_at: callback_at || null });

    // Decide the lead's next status.
    const patch = { last_outcome: code };
    if (notes != null) patch.notes_last = undefined; // reserved; notes live on dispositions
    if (disp.is_dnc) {
      patch.status = 'DNC'; patch.dnc = true;
      sbReq('POST', 'dnc_list', { phone: lead.phone, reason: 'internal', source: 'agent' },
        'resolution=ignore-duplicates,return=minimal').catch(() => {});
    } else if (disp.is_callback) {
      patch.status = 'CALLBACK';
      patch.next_callback_at = callback_at || new Date(Date.now() + 3600e3).toISOString();
      patch.assigned_agent_id = req.user.id; // route callback back to this agent
    } else if (disp.recycle) {
      const rule = (cfg.recycle_rules || DEFAULT_RECYCLE)[disp.recycle] || {};
      const max = lead.max_attempts || rule.max || 5;
      if ((lead.attempts || 0) >= max) {
        patch.status = 'EXHAUSTED';
      } else {
        patch.status = 'NEW';
        const ms = rule.hours ? rule.hours * 3600e3 : (rule.minutes ? rule.minutes * 60e3 : 3600e3);
        patch.next_callback_at = new Date(Date.now() + ms).toISOString();
      }
    } else {
      patch.status = disp.outcome || 'DONE';
    }
    await sbUpdate('leads', `id=eq.${leadId}`, patch).catch(e => console.error('[disp:lead]', e.message));
    audit(req.user, 'DISPOSITION', { target_type: 'lead', target_id: leadId, meta: { code, next_status: patch.status, phone: lead.phone } });

    // Hang up the lead leg if still up, then move agent to AVAILABLE.
    if (st) {
      if (st.leadLeg) telnyx('POST', `/calls/${st.leadLeg}/actions/hangup`, {}).catch(() => {});
      st.leadLeg = null; st.leadNumber = null; st.leadId = null; st.fromNumber = null; st.onCallSince = null;
      if (st.state !== 'OFFLINE') { st.state = st.conferenceId ? 'AVAILABLE' : 'OFFLINE'; await setAgentState(req.user.id, st.state); }
    }
    res.json({ ok: true, next_status: patch.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// In-call controls (lead leg). Mute is handled client-side on the WebRTC mic.
app.post('/api/agent/dtmf', auth, async (req, res) => {
  const st = rt[req.user.id];
  const digits = String((req.body && req.body.digits) || '').replace(/[^0-9*#]/g, '');
  if (!st || !st.leadLeg) return res.status(400).json({ error: 'no active lead call' });
  if (!digits) return res.status(400).json({ error: 'no digits' });
  try { await telnyx('POST', `/calls/${st.leadLeg}/actions/send_dtmf`, { digits }); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/agent/hold', auth, async (req, res) => {
  const st = rt[req.user.id];
  const on = !!(req.body && req.body.on);
  if (!st || !st.leadLeg) return res.status(400).json({ error: 'no active lead call' });
  try { await telnyx('POST', `/calls/${st.leadLeg}/actions/${on ? 'hold' : 'unhold'}`, {}); res.json({ ok: true, hold: on }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ══ PACING ENGINE ════════════════════════════════════════════════════════════════
async function dialLead(agentId, lead) {
  const st = rt[agentId];
  const from = pickCallerId(areaCodeOf(lead.phone));
  const result = await telnyx('POST', '/calls', {
    connection_id: CONNECTION_ID,
    to: lead.phone,
    from,
    answering_machine_detection: AMD_MODE === 'disabled' ? 'disabled' : 'premium',
    // Unconditional recording (per Karim). Recording is saved on call.recording.saved.
    record: 'record-from-answer', record_channels: 'dual', record_format: 'mp3',
    client_state: enc({ role: 'lead', agentId, conf: st.conferenceId, leadId: lead.id, campaignId: lead.campaign_id }),
  });
  st.leadLeg    = result.data && result.data.call_control_id;
  st.leadNumber = lead.phone;
  st.leadId     = lead.id;
  st.fromNumber = from;
  st.state      = 'DIALING';
  st.onCallSince = null;
  await persistRt(agentId);
  logStateEvent(agentId, 'DIALING');
  wsAgentSnapshot(agentId);
  await sbUpdate('leads', `id=eq.${lead.id}`,
    { status: 'IN_PROGRESS', attempts: (lead.attempts || 0) + 1, last_attempt_at: new Date().toISOString(), assigned_agent_id: agentId })
    .catch(e => console.error('[dialLead:update]', e.message));
  // Open a calls row for history/recording linkage.
  sbLog('calls', { lead_id: lead.id, agent_id: agentId, campaign_id: lead.campaign_id,
    telnyx_call_control_id: st.leadLeg, from_number: from, to_number: lead.phone, direction: 'outbound' });
  console.log(`[pacing] agent ${agentId.slice(0, 8)} -> ${lead.phone} from ${from}`);
}

let pacingBusy = false;
async function pacingTick() {
  if (pacingBusy || !SB_HOST || !CONNECTION_ID) return;
  pacingBusy = true;
  try {
    const campaigns = await sbSelect('campaigns', `status=eq.RUNNING&select=id`);
    if (!campaigns.length) return;
    const nowIso = new Date().toISOString();
    for (const c of campaigns) {
      const assigns = await sbSelect('campaign_agents', `campaign_id=eq.${c.id}&select=agent_id`);
      for (const { agent_id } of assigns) {
        const st = rt[agent_id];
        if (!st || st.state !== 'AVAILABLE' || !st.conferenceId) continue;   // only free, in-conference agents
        const leads = await sbSelect('leads',
          `campaign_id=eq.${c.id}&dnc=eq.false&status=in.(NEW,CALLBACK)` +
          `&or=(next_callback_at.is.null,next_callback_at.lte.${nowIso})` +
          `&order=next_callback_at.asc.nullsfirst,created_at.asc&limit=1&select=*`);
        const lead = leads[0];
        if (!lead) continue;
        st.state = 'CLAIMING';                          // guard: prevents re-dial on next tick
        try { await dialLead(agent_id, lead); }
        catch (e) { console.error('[pacing:dial]', e.message); st.state = 'AVAILABLE'; }
      }
    }
  } catch (e) { console.error('[pacing]', e.message); }
  finally { pacingBusy = false; }
}

// ══ WEBHOOK + BRIDGE ═════════════════════════════════════════════════════════════
app.post('/webhooks/telnyx', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  res.sendStatus(200);

  const data    = (req.body && req.body.data) || {};
  const event   = data.event_type || 'unknown';
  const eventId  = data.id || null;
  const payload = data.payload || {};
  const ccid    = payload.call_control_id || null;
  const cs      = dec(payload.client_state);
  const role    = cs && cs.role;
  const agentId = (cs && cs.agentId) || findAgentByLeg(ccid);

  // Idempotency: Telnyx redelivers webhooks. Record the event id; if we've already
  // seen it, skip processing so we never bridge/hangup twice.
  if (eventId) {
    try {
      const ins = await sbReq('POST', 'webhook_events', { event_id: eventId, event_type: event },
        'resolution=ignore-duplicates,return=representation');
      if (Array.isArray(ins) && ins.length === 0) {
        console.log(`[wh] dup ${event} ${eventId.slice(-8)} — skipped`);
        return;
      }
    } catch (e) { /* if the table is missing, fail open and still process */ }
  }

  console.log(`[wh] ${event} role=${role || '-'} agent=${agentId ? agentId.slice(0, 8) : '-'} ccid=${ccid ? ccid.slice(-8) : '-'}` +
              (payload.result ? ` result=${payload.result}` : ''));
  sbLog('call_events', { event_type: event, telnyx_call_control_id: ccid, client_state: cs, payload });

  try {
    // Recording saved -> attach URL to the calls row for in-browser playback.
    if (event === 'call.recording.saved') {
      const url = (payload.recording_urls && (payload.recording_urls.mp3 || payload.recording_urls.wav)) ||
                  (payload.public_recording_urls && (payload.public_recording_urls.mp3 || payload.public_recording_urls.wav)) || null;
      if (ccid) sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
        { recording_url: url, recording_id: payload.recording_id || null }).catch(() => {});
      return;
    }

    // Agent leg answered -> create per-agent conference, mark AVAILABLE
    if (event === 'call.answered' && role === 'agent' && agentId) {
      const conf = await telnyx('POST', '/conferences', {
        name: `trinity-conf-${agentId.slice(0, 8)}-${Date.now()}`,
        call_control_id: ccid, beep_enabled: 'never',
      });
      if (!rt[agentId]) rt[agentId] = {};
      rt[agentId].conferenceId = conf.data && conf.data.id;
      rt[agentId].agentLeg = ccid;
      rt[agentId].state = 'AVAILABLE';
      await setAgentState(agentId, 'AVAILABLE');
      console.log(`[bridge] agent ${agentId.slice(0, 8)} AVAILABLE conf=${rt[agentId].conferenceId}`);
      return;
    }

    // Lead premium AMD -> bridge human, drop machine
    if (event === 'call.machine.premium.detection.ended' && role === 'lead' && agentId) {
      const r = payload.result || '';
      const isHuman = r.startsWith('human') || r === 'silence' || r === 'not_sure';   // TCPA-safe: connect ambiguous
      const st = rt[agentId];
      if (isHuman && st && (cs.conf || st.conferenceId)) {
        await telnyx('POST', `/conferences/${cs.conf || st.conferenceId}/actions/join`, {
          call_control_id: ccid, start_conference_on_enter: true, mute: false,
        });
        st.onCallSince = Date.now();
        st.state = 'ON_CALL';
        await setAgentState(agentId, 'ON_CALL');
        sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`, { bridged_at: new Date().toISOString(), amd_result: r }).catch(() => {});
        if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}`, { status: 'CONTACTED' }).catch(() => {});
        console.log(`[bridge] agent ${agentId.slice(0, 8)} ON_CALL (result=${r})`);
      } else {
        await telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
        if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}`, { status: 'MACHINE' }).catch(() => {});
        console.log(`[bridge] dropped machine leg agent ${agentId.slice(0, 8)} (result=${r})`);
        // agent freed by the ensuing call.hangup handler
      }
      return;
    }

    // Hangups
    if (event === 'call.hangup' && agentId && rt[agentId]) {
      const st = rt[agentId];
      const wasLead = role === 'lead' || st.leadLeg === ccid;
      if (wasLead) {
        const talked = st.state === 'ON_CALL';   // agent actually spoke to a human
        if (ccid) sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
          { ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }).catch(() => {});
        st.leadLeg = null; st.leadNumber = null; st.fromNumber = null; st.onCallSince = null;
        if (talked) {
          // Require a disposition: hold the agent in WRAP_UP; keep leadId so
          // /api/agent/context + /disposition resolve the right lead.
          if (st.state !== 'OFFLINE') { st.state = 'WRAP_UP'; await setAgentState(agentId, 'WRAP_UP'); }
          console.log(`[bridge] call ended (talked), agent ${agentId.slice(0, 8)} WRAP_UP awaiting disposition`);
        } else {
          // Never reached a human (no-answer/machine). System dispositions, auto-advance.
          if (cs && cs.leadId)
            sbUpdate('leads', `id=eq.${cs.leadId}&status=eq.IN_PROGRESS`, { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
          st.leadId = null;
          if (st.state !== 'OFFLINE') { st.state = 'AVAILABLE'; await setAgentState(agentId, 'AVAILABLE'); }
          console.log(`[bridge] no-answer, agent ${agentId.slice(0, 8)} AVAILABLE`);
        }
      } else if (role === 'agent' || st.agentLeg === ccid) {
        rt[agentId] = { state: 'OFFLINE' };
        await setAgentState(agentId, 'OFFLINE');
        console.log(`[bridge] agent ${agentId.slice(0, 8)} OFFLINE (agent leg ended)`);
      }
      return;
    }
  } catch (e) {
    console.error(`[bridge] error on ${event}:`, e.message);
  }
});

// ── CSV parsing ────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const split = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    }
    out.push(cur); return out;
  };
  const headers = split(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map(line => {
    const cells = split(line);
    const o = {}; headers.forEach((h, i) => o[h] = (cells[i] || '').trim());
    return o;
  });
}
function normPhone(p) {
  const d = String(p).replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d.startsWith('+') ? d : '+' + d;
}

// ══ STUCK-CALL REAPER ══════════════════════════════════════════════════════════
// In-memory state can wedge (agent stuck DIALING because a webhook was missed, a
// lead stuck IN_PROGRESS after a crash). This self-heals the floor every 30s.
const REAP_DIALING_MS = 90 * 1000;      // agent dialing/claiming this long w/ no bridge -> free them
const REAP_LEAD_MS    = 8  * 60 * 1000; // lead IN_PROGRESS this long -> requeue as NO_ANSWER
async function reaperTick() {
  if (!SB_HOST) return;
  try {
    // 1) Free agents wedged in transient states.
    const now = Date.now();
    for (const id of Object.keys(rt)) {
      const st = rt[id];
      if (!st) continue;
      if ((st.state === 'DIALING' || st.state === 'CLAIMING') &&
          st.rtUpdatedAt && (now - st.rtUpdatedAt) > REAP_DIALING_MS) {
        console.log(`[reaper] agent ${id.slice(0,8)} wedged in ${st.state} -> freeing`);
        if (st.leadLeg) telnyx('POST', `/calls/${st.leadLeg}/actions/hangup`, {}).catch(() => {});
        st.leadLeg = null; st.leadNumber = null; st.leadId = null; st.fromNumber = null; st.onCallSince = null;
        st.state = st.conferenceId ? 'AVAILABLE' : 'OFFLINE';
        await setAgentState(id, st.state);
      }
    }
    // 2) Requeue leads stuck IN_PROGRESS (dialer died mid-call).
    const cutoff = new Date(now - REAP_LEAD_MS).toISOString();
    await sbUpdate('leads', `status=eq.IN_PROGRESS&last_attempt_at=lt.${cutoff}`,
      { status: 'NO_ANSWER', last_outcome: 'reaper_timeout' }).catch(() => {});
    // 3) Prune webhook idempotency rows older than 24h.
    const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
    sbDelete('webhook_events', `received_at=lt.${dayAgo}`).catch(() => {});
  } catch (e) { console.error('[reaper]', e.message); }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// WebSocket gateway: /ws?token=<jwt>. Auth via the same JWT as the REST API.
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  let user = null;
  try {
    const url = new URL(req.url, 'http://x');
    const tok = url.searchParams.get('token');
    user = jwt.verify(tok, JWT_SECRET);
  } catch { ws.close(4001, 'unauthorized'); return; }
  const client = { ws, userId: user.id, role: user.role };
  wsClients.add(client);
  ws.on('close', () => wsClients.delete(client));
  ws.on('error', () => wsClients.delete(client));
  // Prime the new client with the current picture.
  if (user.role === 'admin') {
    for (const id of Object.keys(rt)) wsSend(ws, { type: 'floor.agent', ...agentSnapshot(id) });
  } else {
    wsSend(ws, { type: 'agent.state', ...agentSnapshot(user.id) });
  }
  wsSend(ws, { type: 'hello', role: user.role, ts: Date.now() });
});
// Heartbeat: drop dead sockets.
setInterval(() => { for (const c of wsClients) { try { c.ws.ping(); } catch {} } }, 30 * 1000);

server.listen(PORT, async () => {
  console.log(`Trinity Dialer (phase0) listening on :${PORT}`);
  await bootstrapAdmin();
  await rehydrateRt();
  await refreshCallerPool();
  console.log(`[boot] caller pool: ${CALLER_POOL.join(', ') || '(none)'}`);
  setInterval(pacingTick, PACING_MS);
  setInterval(reaperTick, 30 * 1000);
  setInterval(refreshCallerPool, 5 * 60 * 1000);
});
