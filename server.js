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
const { deriveFromAreaCode, inCallingWindow } = require('./lib/areacodes');

const app = express();
app.use(express.json({ limit: '32mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
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

// ── Disposition → DNC / recycle policy (Karim's rules) ────────────────────────
//  • Sale / appointment (positive outcome): DNC for 90 days, then auto-removed.
//  • DNC disposition: permanent DNC, only an admin can clear it.
//  • Any other outcome (not available / voicemail / not interested / …): the
//    number stays re-dialable for 10 days from the FIRST dial. Each such
//    disposition is a "strike"; 4 strikes on a phone (across ALL campaigns)
//    → permanent DNC. After the 10-day window with < 4 strikes → EXHAUSTED.
// Admin-editable via the "Call Result Management" panel (app_settings key
// "call_policy"). Recycle/strike/redial are now configured PER DISPOSITION —
// each disposition code carries its own re-dial window, strike limit, and
// redial spacing. positive_dnc_days still governs the sale/appt DNC expiry.
const DISP_POLICY_DEFAULT = { recycle_window_days: 10, neg_strike_limit: 4, neg_redial_hours: 24 };
const POSITIVE_DNC_DAYS_DEFAULT = 90;
let POLICY = { positive_dnc_days: POSITIVE_DNC_DAYS_DEFAULT, dispositions: {} };
function clampDispPolicy(v) {
  return {
    recycle_window_days: Math.max(1, Math.min(365, parseInt(v && v.recycle_window_days, 10) || DISP_POLICY_DEFAULT.recycle_window_days)),
    neg_strike_limit:    Math.max(1, Math.min(20,  parseInt(v && v.neg_strike_limit, 10)    || DISP_POLICY_DEFAULT.neg_strike_limit)),
    neg_redial_hours:    Math.max(1, Math.min(720, parseInt(v && v.neg_redial_hours, 10)    || DISP_POLICY_DEFAULT.neg_redial_hours)),
  };
}
async function loadCallPolicy() {
  if (!SB_HOST) return;
  try {
    const rows = await sbSelect('app_settings', `key=eq.call_policy&select=value`);
    const v = rows && rows[0] && rows[0].value;
    if (v) {
      const disp = {};
      if (v.dispositions && typeof v.dispositions === 'object')
        for (const [code, cfg] of Object.entries(v.dispositions)) disp[code] = clampDispPolicy(cfg);
      POLICY = {
        positive_dnc_days: Math.max(1, Math.min(3650, parseInt(v.positive_dnc_days, 10) || POSITIVE_DNC_DAYS_DEFAULT)),
        dispositions: disp,
      };
    }
  } catch (e) { console.error('[callPolicy]', e.message); }
}
// Effective recycle/strike/redial policy for a given disposition code.
const dispPolicy = (code) => (POLICY.dispositions && POLICY.dispositions[code]) || DISP_POLICY_DEFAULT;

// In-memory runtime keyed by agent id (single instance — required for pacing).
// { state, sip, agentLeg, conferenceId, leadLeg, leadId, leadNumber, fromNumber }
const rt = {};

// Discovered outbound caller-ID pool (refreshed from Telnyx).
let CALLER_POOL = CALLER_IDS_ENV.slice();

// Global lead-local calling window (compliance rule). Cached from app_settings.
let CALLING_WINDOW = { start_hour: 10, end_hour: 21 };
async function loadCallingWindow() {
  if (!SB_HOST) return;
  try {
    const rows = await sbSelect('app_settings', `key=eq.calling_window&select=value`);
    if (rows && rows[0] && rows[0].value) {
      const v = rows[0].value;
      CALLING_WINDOW = { start_hour: v.start_hour ?? 10, end_hour: v.end_hour ?? 21 };
    }
  } catch (e) { console.error('[callingWindow]', e.message); }
}

// Dialer pacing config (admin-editable, cached from app_settings key "dialer").
// lines_per_agent == ReadyMode "CPA": how many leads to ring SIMULTANEOUSLY per
// free agent. 1 = pure power dialer (zero dropped/abandoned calls). >1 shortens
// the agent's wait between connects at the cost of occasionally dropping a call
// when more than one person answers at once. ring_secs caps how long a no-answer
// rings before we give up and move to the next number (kills dead air).
let DIALER = { lines_per_agent: 1, ring_secs: 25 };
async function loadDialerConfig() {
  if (!SB_HOST) return;
  try {
    const rows = await sbSelect('app_settings', `key=eq.dialer&select=value`);
    if (rows && rows[0] && rows[0].value) {
      const v = rows[0].value;
      DIALER = {
        lines_per_agent: Math.max(1, Math.min(5, parseInt(v.lines_per_agent, 10) || 1)),
        ring_secs: Math.max(10, Math.min(60, parseInt(v.ring_secs, 10) || 25)),
      };
    }
  } catch (e) { console.error('[dialerConfig]', e.message); }
}

// ── AI Cold Caller config (admin-editable, cached from app_settings key "ai") ──
// The AI runs as its own "seat lane" on the floor, independent of human agents.
//   enabled            master on/off switch for AI dialing
//   concurrency        MAX simultaneous AI calls — the hard spend ceiling (1-50)
//   assistant_id       the Telnyx AI Assistant to attach on a confirmed human
//   voice              informational: which TTS voice the assistant uses
//   transfer_agent_ids human closers who receive warm transfers (Lead/Callback)
//   campaign_ids       which campaigns the AI caller dials (opt-in, never all)
// Sprint 1 only loads/serves this config; the pacer wiring lands in Sprint 2, so
// toggling `enabled` here does NOT yet affect live human dialing.
let AI = { enabled: false, concurrency: 5, assistant_id: '', voice: '', transfer_agent_ids: [], campaign_ids: [] };
async function loadAiConfig() {
  if (!SB_HOST) return;
  try {
    const rows = await sbSelect('app_settings', `key=eq.ai&select=value`);
    const v = rows && rows[0] && rows[0].value;
    if (v) AI = {
      enabled: !!v.enabled,
      concurrency: Math.max(1, Math.min(50, parseInt(v.concurrency, 10) || 5)),
      assistant_id: String(v.assistant_id || '').trim(),
      voice: String(v.voice || '').trim(),
      transfer_agent_ids: Array.isArray(v.transfer_agent_ids) ? v.transfer_agent_ids.map(String) : [],
      campaign_ids: Array.isArray(v.campaign_ids) ? v.campaign_ids.map(String) : [],
    };
  } catch (e) { console.error('[aiConfig]', e.message); }
}
// In-flight AI calls, keyed by Telnyx call_control_id. This is the AI lane's
// entire runtime — it has NO conference and NO human agent seat. Each entry:
//   { leadId, leadNumber, fromNumber, campaignId, name, address, phase, at }
//   phase: 'dialing' (ringing / pre-answer) | 'assistant' (assistant attached).
// The size of this map is the live spend; AI.concurrency is the hard ceiling.
const aiRt = {};

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
// Exact row count regardless of PostgREST's default 1000-row select cap.
async function sbCount(table, q = '') {
  const r = await fetch(`https://${SB_HOST}/rest/v1/${table}?${q}${q ? '&' : ''}select=id`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = r.headers.get('content-range') || '*/0';
  return parseInt(cr.split('/')[1], 10) || 0;
}
// Fetch ALL rows past the 1000-row cap by paging through ranges.
async function sbSelectAll(table, q = '', page = 1000) {
  const out = [];
  for (let offset = 0; ; offset += page) {
    const r = await fetch(`https://${SB_HOST}/rest/v1/${table}?${q}`, {
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        Range: `${offset}-${offset + page - 1}`, 'Range-Unit': 'items',
      },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase GET ${table} -> ${r.status}: ${text}`);
    const rows = text ? JSON.parse(text) : [];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const dec = (b64) => { if (!b64) return null; try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; } };

function signToken(a) {
  return jwt.sign({ id: a.id, role: a.role, name: a.name, email: a.email }, JWT_SECRET, { expiresIn: '12h' });
}
function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  // Header token normally; fall back to ?token= for browser-native GETs
  // (e.g. <audio src>, download links) that can't set an Authorization header.
  const token = m ? m[1] : (req.query && req.query.token);
  if (!token) return res.sendStatus(401);
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
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

// ── Wrap-up cooldown ─────────────────────────────────────────────────────────
// Wrap-up is automated (agents can't self-select it). After every call the
// agent gets a short breather before the pacer feeds the next lead: 3s by
// default, but 3 minutes when the call was dispositioned as a positive outcome
// (appointment / sale / lead) so they can finish paperwork. Server-authoritative
// so it survives a client refresh and correctly gates pacing (WRAP_UP is not
// dialable). The client renders the countdown off `wrapUntil` in the snapshot.
const WRAP_SHORT_SEC = 3, WRAP_LONG_SEC = 180;
const LONG_WRAP_RE = /appointment|appt|(^|[^a-z])sale([^a-z]|$)|(^|[^a-z])lead([^a-z]|$)/i;
function wrapSecondsFor(disp) {
  if (!disp) return WRAP_SHORT_SEC;
  if (disp.long_wrap === true) return WRAP_LONG_SEC;
  return LONG_WRAP_RE.test(`${disp.code || ''} ${disp.label || ''}`) ? WRAP_LONG_SEC : WRAP_SHORT_SEC;
}
function clearWrapTimer(st) {
  if (st && st.wrapTimer) { clearTimeout(st.wrapTimer); st.wrapTimer = null; }
  if (st) st.wrapUntil = 0;
}
function scheduleWrapReturn(agentId, seconds) {
  const st = rt[agentId];
  if (!st) return;
  clearWrapTimer(st);
  st.wrapUntil = Date.now() + seconds * 1000;
  st.wrapTimer = setTimeout(async () => {
    const s = rt[agentId];
    if (!s) return;
    s.wrapTimer = null; s.wrapUntil = 0;
    // Only auto-advance if still wrapping on a connected softphone.
    if (s.state === 'WRAP_UP' && s.conferenceId) { s.state = 'AVAILABLE'; await setAgentState(agentId, 'AVAILABLE'); }
  }, seconds * 1000);
}

// ── DNC + phone-strike helpers ────────────────────────────────────────────────
// A positive outcome (sale / appointment / lead) whose regex mirrors the wrap rule.
function isPositiveDisp(disp) {
  if (!disp) return false;
  if (disp.positive === true || disp.long_wrap === true) return true;
  return LONG_WRAP_RE.test(`${disp.code || ''} ${disp.label || ''}`);
}
// Add a number to the DNC list permanently (expires_at NULL). merge-duplicates so
// a pre-existing temporary entry is upgraded to permanent.
function dncPermanent(phone, reason) {
  if (!phone) return;
  sbReq('POST', 'dnc_list?on_conflict=phone',
    { phone, reason: reason || 'internal', source: 'agent', expires_at: null },
    'resolution=merge-duplicates,return=minimal').catch(e => console.error('[dncPermanent]', e.message));
}
// Add a number to the DNC list with an auto-expiry. ignore-duplicates so we never
// shorten (or overwrite) an existing permanent/earlier entry.
function dncTemporary(phone, days, reason) {
  if (!phone) return;
  sbReq('POST', 'dnc_list?on_conflict=phone',
    { phone, reason: reason || 'converted', source: 'agent',
      expires_at: new Date(Date.now() + days * 86400e3).toISOString() },
    'resolution=ignore-duplicates,return=minimal').catch(e => console.error('[dncTemporary]', e.message));
}
// Atomically bump a phone's negative-strike counter (across campaigns) and return
// the updated { neg_strikes, first_dial_at }. Falls back gracefully on error.
async function bumpPhoneStrike(phone) {
  try {
    const r = await sbReq('POST', 'rpc/bump_phone_strike', { p_phone: phone });
    return Array.isArray(r) ? r[0] : r;
  } catch (e) { console.error('[bumpPhoneStrike]', e.message); return { neg_strikes: 1, first_dial_at: null }; }
}
// Record the first-ever dial of a phone (ignore-duplicates keeps the earliest).
function markFirstDial(phone) {
  if (!phone || !SB_HOST) return;
  sbReq('POST', 'phone_activity?on_conflict=phone',
    { phone, first_dial_at: new Date().toISOString() },
    'resolution=ignore-duplicates,return=minimal').catch(() => {});
}
// Periodic sweep: drop DNC entries whose 90-day (or other) expiry has passed and
// clear the dnc flag on any leads carrying that number.
async function sweepExpiredDnc() {
  if (!SB_HOST) return;
  try {
    const nowIso = new Date().toISOString();
    const expired = await sbSelect('dnc_list', `expires_at=lt.${nowIso}&select=phone`);
    if (!expired || !expired.length) return;
    const phones = expired.map(r => r.phone).filter(Boolean);
    for (let i = 0; i < phones.length; i += 100) {
      const chunk = phones.slice(i, i + 100);
      const inList = chunk.map(p => `"${p}"`).join(',');
      await sbDelete('dnc_list', `phone=in.(${inList})&expires_at=lt.${nowIso}`);
      await sbUpdate('leads', `phone=in.(${inList})&dnc=eq.true`, { dnc: false }).catch(() => {});
    }
    console.log(`[dncSweep] removed ${phones.length} expired DNC entr${phones.length === 1 ? 'y' : 'ies'}`);
  } catch (e) { console.error('[dncSweep]', e.message); }
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
           fromNumber: st.fromNumber || null, onCallSince: st.onCallSince || null, wrapUntil: st.wrapUntil || null };
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
    // Overlay the live in-memory runtime state; the DB `state` column is only a
    // creation-time seed and is never persisted per state change.
    const users = rows.map(u => ({ ...u, state: (rt[u.id] && rt[u.id].state) || 'OFFLINE' }));
    res.json({ users });
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
  const { name, email, password, active, role } = req.body || {};
  if (name != null) patch.name = name;
  if (email != null && String(email).trim()) {
    const other = await sbSelect('agents',
      `email=eq.${encodeURIComponent(String(email).trim())}&id=neq.${req.params.id}&select=id`);
    if (other.length) return res.status(409).json({ error: 'email already in use' });
    patch.email = String(email).trim();
  }
  if (active != null) patch.active = !!active;
  if (role != null) patch.role = role === 'admin' ? 'admin' : 'agent';
  if (password) patch.password_hash = await bcrypt.hash(password, 10);
  try {
    await sbUpdate('agents', `id=eq.${req.params.id}`, patch);
    const meta = { ...patch }; delete meta.password_hash;
    if (password) meta.password = 'reset';
    audit(req.user, 'UPDATE_AGENT', { target_type: 'agent', target_id: req.params.id, meta });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: "you can't delete your own account" });
  try {
    const [target] = await sbSelect('agents', `id=eq.${id}&select=id,name,email,role,telnyx_credential_id`);
    if (!target) return res.status(404).json({ error: 'user not found' });
    // Never remove the last remaining active admin.
    if (target.role === 'admin') {
      const admins = await sbSelect('agents', `role=eq.admin&active=eq.true&select=id`);
      if (admins.length <= 1) return res.status(400).json({ error: 'cannot delete the last active admin' });
    }
    // Best-effort cleanup of the Telnyx WebRTC credential.
    if (target.telnyx_credential_id && TELNYX_KEY) {
      await telnyx('DELETE', `/telephony_credentials/${target.telnyx_credential_id}`).catch(() => {});
    }
    await sbDelete('campaign_agents', `agent_id=eq.${id}`).catch(() => {});
    await sbDelete('agents', `id=eq.${id}`);
    delete rt[id];
    audit(req.user, 'DELETE_AGENT', { target_type: 'agent', target_id: id,
      meta: { name: target.name, email: target.email, role: target.role } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ADMIN: campaigns ════════════════════════════════════════════════════════════
app.get('/api/admin/campaigns', auth, adminOnly, async (_req, res) => {
  try {
    const campaigns = await sbSelect('campaigns', 'select=*&order=created_at.desc');
    const assigns   = await sbSelect('campaign_agents', 'select=campaign_id,agent_id');
    const out = [];
    for (const c of campaigns) {
      const agentIds = assigns.filter(a => a.campaign_id === c.id).map(a => a.agent_id);
      // Pull every status row (past the 1000 cap) so totals are accurate on large lists.
      const counts   = await sbSelectAll('leads', `campaign_id=eq.${c.id}&select=status`);
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

// ── CSV lead import (Sprint 1) ────────────────────────────────────────────────
// Canonical lead fields the mapper can target (everything else → custom).
const CANON_FIELDS = ['phone','first_name','last_name','address','state','source'];
// Auto-suggest which CSV header maps to each canonical field.
const HEADER_HINTS = {
  phone:      ['phone','number','phone_number','phone1','primary_phone','cell','mobile','tel'],
  first_name: ['first_name','firstname','first','fname','owner_first'],
  last_name:  ['last_name','lastname','last','lname','owner_last'],
  address:    ['address','street','property_address','addr','site_address'],
  state:      ['state','st','property_state'],
  source:     ['source','lead_source','list'],
};
function suggestMapping(headers) {
  const map = {};
  for (const field of CANON_FIELDS) {
    const hit = headers.find(h => HEADER_HINTS[field].includes(h));
    if (hit) map[field] = hit;
  }
  return map;
}
// Turn one parsed CSV row into a lead draft using an explicit or auto mapping.
function rowToLead(r, mapping, campaignId) {
  const get = (f) => (mapping.fields && mapping.fields[f]) ? (r[mapping.fields[f]] || '') : '';
  const rawPhone = get('phone') || r.phone || r.number || r.phone_number || '';
  const phone = normPhone(rawPhone);
  const custom = {};
  const customCols = mapping.custom || null;
  const mappedHeaders = new Set(Object.values(mapping.fields || {}));
  for (const k of Object.keys(r)) {
    if (mappedHeaders.has(k)) continue;
    if (customCols && !customCols.includes(k)) continue; // explicit custom whitelist
    if (r[k]) custom[k] = r[k];
  }
  const ac = areaCodeOf(phone);
  const derived = deriveFromAreaCode(ac);
  return {
    campaign_id: campaignId,
    phone, _rawPhone: rawPhone,
    first_name: get('first_name') || r.first_name || r.firstname || r.first || null,
    last_name:  get('last_name')  || r.last_name  || r.lastname  || r.last  || null,
    address:    get('address') || r.address || null,
    state:      (get('state') || r.state || derived.state || null),
    source:     get('source') || null,
    area_code:  ac,
    timezone:   derived.tz,
    custom, status: 'NEW',
  };
}

// Preview: parse headers + a few sample rows, return suggested column mapping.
app.post('/api/admin/campaigns/:id/leads/preview', auth, adminOnly, async (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : (req.body && req.body.csv) || '';
  if (!csv.trim()) return res.status(400).json({ error: 'empty csv' });
  try {
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(400).json({ error: 'no rows parsed' });
    const headers = Object.keys(rows[0]);
    res.json({
      headers,
      total: rows.length,
      sample: rows.slice(0, 5),
      suggested: suggestMapping(headers),
      canon: CANON_FIELDS,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import: dedupe by phone, DNC scrub, invalid rejection (+rejects file), tz
// derivation from area code, import-batch bookkeeping. Body: raw csv OR
// { csv, mapping:{fields,custom}, filename }.
app.post('/api/admin/campaigns/:id/leads', auth, adminOnly, async (req, res) => {
  const isJson = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body);
  const csv = typeof req.body === 'string' ? req.body : (isJson ? (req.body.csv || '') : '');
  const mapping  = (isJson && req.body.mapping) ? req.body.mapping : {};
  const filename = (isJson && req.body.filename) ? req.body.filename : null;
  const campaignId = req.params.id;
  if (!csv.trim()) return res.status(400).json({ error: 'empty csv' });
  try {
    const rows = parseCsv(csv);
    if (!rows.length) return res.status(400).json({ error: 'no rows parsed' });

    // 1) map + validate
    const drafts = rows.map(r => rowToLead(r, mapping, campaignId));
    const invalidRows = [];   // { row, reason }
    const valid = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const digits = String(d.phone || '').replace(/[^\d]/g, '');
      const okLen = (digits.length === 11 && digits.startsWith('1')) || digits.length === 10;
      if (!d.phone || !okLen) { invalidRows.push({ i, raw: d._rawPhone, reason: 'invalid phone' }); continue; }
      valid.push(d);
    }

    // 2) dedupe by phone — within the file, then against existing campaign leads
    let duplicates = 0;
    const seen = new Set();
    const deduped = [];
    for (const d of valid) {
      if (seen.has(d.phone)) { duplicates++; continue; }
      seen.add(d.phone); deduped.push(d);
    }
    const existing = await sbSelectAll('leads', `campaign_id=eq.${campaignId}&select=phone`);
    const existingSet = new Set((existing || []).map(l => l.phone));
    const notExisting = deduped.filter(d => { if (existingSet.has(d.phone)) { duplicates++; return false; } return true; });

    // 3) DNC scrub — permanent list is the source of truth (compliance rule)
    let dncRemoved = 0;
    const dncHits = new Set();
    const phones = notExisting.map(d => d.phone);
    for (let i = 0; i < phones.length; i += 200) {
      const chunk = phones.slice(i, i + 200);
      const inList = chunk.map(p => `"${p}"`).join(',');
      const hits = await sbSelect('dnc_list', `phone=in.(${inList})&select=phone`);
      for (const h of hits || []) dncHits.add(h.phone);
    }
    const clean = notExisting.filter(d => { if (dncHits.has(d.phone)) { dncRemoved++; return false; } return true; });

    // 4) import batch row
    let batchId = null;
    try {
      const [batch] = await sbInsert('import_batches', {
        campaign_id: campaignId, filename,
        total: rows.length, inserted: 0, duplicates,
        dnc_removed: dncRemoved, invalid: invalidRows.length,
        created_by: req.user.id,
      });
      batchId = batch && batch.id;
    } catch (_) { /* import_batches optional; continue */ }

    // 5) insert clean leads in chunks
    let inserted = 0;
    for (let i = 0; i < clean.length; i += 500) {
      const chunk = clean.slice(i, i + 500).map(({ _rawPhone, ...l }) => ({ ...l, import_batch_id: batchId }));
      await sbInsert('leads', chunk);
      inserted += chunk.length;
    }
    if (batchId) await sbUpdate('import_batches', `id=eq.${batchId}`, { inserted }).catch(() => {});

    // 6) rejects file (invalid numbers) for download
    const rejects = invalidRows.map(v => `${v.raw || ''},${v.reason}`).join('\n');
    const rejectsCsv = invalidRows.length ? 'phone,reason\n' + rejects : '';

    audit(req.user, 'UPLOAD_LEADS', { target_type: 'campaign', target_id: campaignId,
      meta: { total: rows.length, inserted, duplicates, dnc_removed: dncRemoved, invalid: invalidRows.length } });
    res.json({
      ok: true, batch_id: batchId,
      total: rows.length, inserted, duplicates,
      dnc_removed: dncRemoved, invalid: invalidRows.length,
      rejects_csv: rejectsCsv,
      summary: `${inserted} imported · ${duplicates} duplicate · ${dncRemoved} removed — on your DNC list · ${invalidRows.length} invalid`,
    });
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

// ══ ADMIN: Sprint 1 — Lead Management ════════════════════════════════════════════

// ── Global lead search: phone / name / address across all campaigns ───────────
app.get('/api/admin/leads/search', auth, adminOnly, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ rows: [] });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const digits = q.replace(/[^\d]/g, '');
  const like = `*${q.replace(/[%,()*]/g, '')}*`;
  const ors = [`first_name.ilike.${like}`, `last_name.ilike.${like}`, `address.ilike.${like}`];
  if (digits) ors.push(`phone.ilike.*${digits}*`);
  try {
    const rows = await sbSelect('leads',
      `or=(${ors.join(',')})&order=created_at.desc&limit=${limit}` +
      `&select=id,campaign_id,phone,first_name,last_name,address,state,status,attempts,tags,owner_agent_id,next_callback_at`);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single lead (lead card) get + update ──────────────────────────────────────
app.get('/api/admin/leads/:id', auth, adminOnly, async (req, res) => {
  try {
    const [lead] = await sbSelect('leads', `id=eq.${req.params.id}&select=*&limit=1`);
    if (!lead) return res.status(404).json({ error: 'not found' });
    const calls  = await sbSelect('calls', `lead_id=eq.${req.params.id}&order=created_at.desc&select=*`);
    const disps  = await sbSelect('dispositions', `lead_id=eq.${req.params.id}&order=created_at.desc&select=*`);
    const folders = await sbSelect('lead_folders', `lead_id=eq.${req.params.id}&select=folder_id`);
    res.json({ lead, calls, dispositions: disps, folder_ids: (folders || []).map(f => f.folder_id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/leads/:id', auth, adminOnly, async (req, res) => {
  const allow = ['first_name','last_name','address','state','status','tags','owner_agent_id','custom','next_callback_at','source'];
  const patch = {};
  for (const k of allow) if (k in (req.body || {})) patch[k] = req.body[k];
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'no fields' });
  try {
    const [row] = await sbUpdate('leads', `id=eq.${req.params.id}`, patch);
    audit(req.user, 'EDIT_LEAD', { target_type: 'lead', target_id: req.params.id, meta: { fields: Object.keys(patch) } });
    res.json({ ok: true, lead: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Custom CRM fields per campaign + lead-card layout ─────────────────────────
app.get('/api/admin/campaigns/:id/fields', auth, adminOnly, async (req, res) => {
  try { res.json({ fields: await sbSelect('campaign_fields', `campaign_id=eq.${req.params.id}&order=position.asc`) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/campaigns/:id/fields', auth, adminOnly, async (req, res) => {
  const { key, label, type, options, position, show_on_card } = req.body || {};
  if (!key || !label) return res.status(400).json({ error: 'key + label required' });
  try {
    const [row] = await sbInsert('campaign_fields', {
      campaign_id: req.params.id, key: String(key).toLowerCase().replace(/\s+/g, '_'),
      label, type: type || 'text', options: options || [],
      position: position ?? 0, show_on_card: show_on_card !== false,
    });
    audit(req.user, 'ADD_FIELD', { target_type: 'campaign', target_id: req.params.id, meta: { key, label } });
    res.json({ ok: true, field: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/fields/:fid', auth, adminOnly, async (req, res) => {
  const allow = ['label','type','options','position','show_on_card'];
  const patch = {}; for (const k of allow) if (k in (req.body || {})) patch[k] = req.body[k];
  try { const [row] = await sbUpdate('campaign_fields', `id=eq.${req.params.fid}`, patch); res.json({ ok: true, field: row }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/fields/:fid', auth, adminOnly, async (req, res) => {
  try { await sbDelete('campaign_fields', `id=eq.${req.params.fid}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Action folders (Appointments / Hot Leads / Follow-ups) ────────────────────
app.get('/api/admin/folders', auth, adminOnly, async (req, res) => {
  const cid = req.query.campaign_id;
  const q = cid ? `or=(campaign_id.eq.${cid},campaign_id.is.null)&order=position.asc` : 'order=position.asc';
  try {
    const folders = await sbSelect('action_folders', q);
    // attach lead counts
    for (const f of folders) {
      const rows = await sbSelect('lead_folders', `folder_id=eq.${f.id}&select=lead_id`);
      f.lead_count = (rows || []).length;
    }
    res.json({ folders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/folders', auth, adminOnly, async (req, res) => {
  const { name, campaign_id, position } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const [row] = await sbInsert('action_folders', { name, campaign_id: campaign_id || null, position: position ?? 0 });
    audit(req.user, 'ADD_FOLDER', { target_type: 'folder', target_id: row.id, meta: { name } });
    res.json({ ok: true, folder: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/folders/:fid', auth, adminOnly, async (req, res) => {
  try { await sbDelete('action_folders', `id=eq.${req.params.fid}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Leads inside a folder (for the click-to-call list)
app.get('/api/admin/folders/:fid/leads', auth, adminOnly, async (req, res) => {
  try {
    const mem = await sbSelect('lead_folders', `folder_id=eq.${req.params.fid}&select=lead_id&order=added_at.desc`);
    const ids = (mem || []).map(m => m.lead_id);
    if (!ids.length) return res.json({ leads: [] });
    const inList = ids.map(i => `"${i}"`).join(',');
    const leads = await sbSelect('leads', `id=in.(${inList})&select=id,campaign_id,phone,first_name,last_name,address,state,status,tags`);
    res.json({ leads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Add / remove a lead from a folder
app.post('/api/admin/leads/:id/folders', auth, adminOnly, async (req, res) => {
  const { folder_id, remove } = req.body || {};
  if (!folder_id) return res.status(400).json({ error: 'folder_id required' });
  try {
    if (remove) await sbDelete('lead_folders', `lead_id=eq.${req.params.id}&folder_id=eq.${folder_id}`);
    else        await sbInsert('lead_folders', { lead_id: req.params.id, folder_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Playlists: filter builder + live count ────────────────────────────────────
// Translate a filter list into a PostgREST query fragment. Supported ops:
// is | is_not | between. Fields: state, status, times_called, attempts, source,
// tags (contains), or custom.<key> (jsonb).
function playlistFragment(filters) {
  const parts = [];
  for (const f of (filters || [])) {
    if (!f || !f.field) continue;
    const op = f.op || 'is';
    const val = f.value;
    let col = f.field;
    const isTag = col === 'tags';
    const isCustom = col.startsWith('custom.');
    if (isCustom) col = `custom->>${col.slice(7)}`;
    const enc = (v) => encodeURIComponent(String(v));
    if (op === 'between' && Array.isArray(val)) {
      parts.push(`${col}=gte.${enc(val[0])}`);
      parts.push(`${col}=lte.${enc(val[1])}`);
    } else if (isTag) {
      // tag contains (is) / not-contains (is_not)
      parts.push(op === 'is_not' ? `tags=not.cs.{${enc(val)}}` : `tags=cs.{${enc(val)}}`);
    } else if (op === 'is_not') {
      parts.push(`${col}=neq.${enc(val)}`);
    } else {
      parts.push(`${col}=eq.${enc(val)}`);
    }
  }
  return parts.join('&');
}
// ── Playlists (top-level containers of campaigns + agents) ────────────────────
// A playlist holds many campaigns and many agents. Available agents on a playlist
// dial leads drawn from its campaigns, highest-priority playlist first.
async function hydratePlaylists(rows) {
  if (!rows.length) return [];
  const ids = rows.map(p => `"${p.id}"`).join(',');
  const [pcs, pas, camps, agents] = await Promise.all([
    sbSelect('playlist_campaigns', `playlist_id=in.(${ids})&select=playlist_id,campaign_id`),
    sbSelect('playlist_agents',    `playlist_id=in.(${ids})&select=playlist_id,agent_id`),
    sbSelect('campaigns', 'select=id,name,status'),
    sbSelect('agents', 'select=id,name,role'),
  ]);
  const campById  = Object.fromEntries((camps  || []).map(c => [c.id, c]));
  const agentById = Object.fromEntries((agents || []).map(a => [a.id, a]));
  return rows.map(p => ({
    ...p,
    campaigns: (pcs || []).filter(x => x.playlist_id === p.id)
      .map(x => campById[x.campaign_id]).filter(Boolean),
    agents: (pas || []).filter(x => x.playlist_id === p.id)
      .map(x => agentById[x.agent_id]).filter(Boolean),
  }));
}
app.get('/api/admin/playlists', auth, adminOnly, async (_req, res) => {
  try {
    const rows = await sbSelect('playlists', 'order=priority.asc,created_at.asc');
    res.json({ playlists: await hydratePlaylists(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/playlists', auth, adminOnly, async (req, res) => {
  const { name, priority, filters, selection_mode, lines_per_agent } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const lpaRaw = parseInt(lines_per_agent, 10);
  const lpa = (lpaRaw >= 1 && lpaRaw <= 5) ? lpaRaw : null;   // null = inherit global default
  try {
    const [row] = await sbInsert('playlists', {
      name, priority: Math.min(9, Math.max(1, priority || 5)),
      filters: filters || [], selection_mode: selection_mode || 'balanced',
      lines_per_agent: lpa,
    });
    audit(req.user, 'ADD_PLAYLIST', { target_type: 'playlist', target_id: row.id, meta: { name } });
    res.json({ ok: true, playlist: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/admin/playlists/:pid', auth, adminOnly, async (req, res) => {
  const allow = ['name','priority','weight','group_name','filters','selection_mode','active','lines_per_agent'];
  const patch = {}; for (const k of allow) if (k in (req.body || {})) patch[k] = req.body[k];
  if ('lines_per_agent' in patch) {
    const n = parseInt(patch.lines_per_agent, 10);
    patch.lines_per_agent = (n >= 1 && n <= 5) ? n : null;   // null = inherit global default
  }
  try { const [row] = await sbUpdate('playlists', `id=eq.${req.params.pid}`, patch); res.json({ ok: true, playlist: row }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/playlists/:pid', auth, adminOnly, async (req, res) => {
  try { await sbDelete('playlists', `id=eq.${req.params.pid}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Attach / detach a campaign
app.post('/api/admin/playlists/:pid/campaigns', auth, adminOnly, async (req, res) => {
  const { campaign_id } = req.body || {};
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
  try {
    await sbReq('POST', 'playlist_campaigns',
      { playlist_id: req.params.pid, campaign_id }, 'resolution=ignore-duplicates,return=minimal');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/playlists/:pid/campaigns/:cid', auth, adminOnly, async (req, res) => {
  try { await sbDelete('playlist_campaigns', `playlist_id=eq.${req.params.pid}&campaign_id=eq.${req.params.cid}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Attach / detach an agent (caller)
app.post('/api/admin/playlists/:pid/agents', auth, adminOnly, async (req, res) => {
  const { agent_id } = req.body || {};
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  try {
    await sbReq('POST', 'playlist_agents',
      { playlist_id: req.params.pid, agent_id }, 'resolution=ignore-duplicates,return=minimal');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/playlists/:pid/agents/:aid', auth, adminOnly, async (req, res) => {
  try { await sbDelete('playlist_agents', `playlist_id=eq.${req.params.pid}&agent_id=eq.${req.params.aid}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Live "Available leads: N" across all campaigns in a playlist (dialable only).
app.post('/api/admin/playlists/:pid/count', auth, adminOnly, async (req, res) => {
  try {
    const [pl] = await sbSelect('playlists', `id=eq.${req.params.pid}&select=filters`);
    const pcs = await sbSelect('playlist_campaigns', `playlist_id=eq.${req.params.pid}&select=campaign_id`);
    const cids = (pcs || []).map(x => x.campaign_id);
    if (!cids.length) return res.json({ count: 0 });
    const frag = playlistFragment((req.body && req.body.filters) || (pl && pl.filters) || []);
    const q = `campaign_id=in.(${cids.map(c => `"${c}"`).join(',')})&dnc=eq.false&status=in.(NEW,CALLBACK)` +
              (frag ? `&${frag}` : '') + '&select=id';
    const r = await fetch(`https://${SB_HOST}/rest/v1/leads?${q}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = r.headers.get('content-range') || '*/0';
    res.json({ count: parseInt(cr.split('/')[1], 10) || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DIDs (caller numbers) + campaign assignment for inbound routing ───────────
app.get('/api/admin/dids', auth, adminOnly, async (_req, res) => {
  try {
    const [dids, camps] = await Promise.all([
      sbSelect('dids', 'select=*&order=created_at.desc'),
      sbSelect('campaigns', 'select=id,name'),
    ]);
    const cById = Object.fromEntries((camps || []).map(c => [c.id, c.name]));
    res.json({ dids: (dids || []).map(d => ({ ...d, campaign_name: d.campaign_id ? cById[d.campaign_id] || null : null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/dids', auth, adminOnly, async (req, res) => {
  const { phone_number, state } = req.body || {};
  const num = normPhone(phone_number || '');
  if (!num) return res.status(400).json({ error: 'valid phone_number required' });
  const area_code = num.replace(/[^\d]/g, '').replace(/^1/, '').slice(0, 3);
  const derived = deriveFromAreaCode(area_code);
  try {
    const [row] = await sbInsert('dids', {
      phone_number: num, area_code, state: state || derived.state || null, active: true,
    });
    audit(req.user, 'ADD_DID', { target_type: 'did', target_id: row.id, meta: { phone_number: num } });
    res.json({ ok: true, did: row });
  } catch (e) { res.status(409).json({ error: e.message }); }
});
// Assign / unassign a DID to a campaign (exclusive: one DID → one campaign).
app.patch('/api/admin/dids/:id', auth, adminOnly, async (req, res) => {
  const patch = {};
  if ('campaign_id' in (req.body || {})) patch.campaign_id = req.body.campaign_id || null;
  if ('active' in (req.body || {})) patch.active = !!req.body.active;
  if ('daily_cap' in (req.body || {})) patch.daily_cap = req.body.daily_cap;
  try {
    const [row] = await sbUpdate('dids', `id=eq.${req.params.id}`, patch);
    audit(req.user, 'UPDATE_DID', { target_type: 'did', target_id: req.params.id, meta: patch });
    res.json({ ok: true, did: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/dids/:id', auth, adminOnly, async (req, res) => {
  try { await sbDelete('dids', `id=eq.${req.params.id}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ TELNYX NUMBER MANAGEMENT ═════════════════════════════════════════════════════
// Every number the Telnyx account owns on THIS dialer's Call-Control connection.
async function telnyxListOwned() {
  if (!TELNYX_KEY || !CONNECTION_ID) return [];
  const out = [];
  for (let page = 1; page <= 40; page++) {   // hard cap 10k numbers
    const r = await telnyx('GET',
      `/phone_numbers?filter[connection_id]=${CONNECTION_ID}&page[number]=${page}&page[size]=250`);
    const rows = r.data || [];
    for (const n of rows) out.push({
      id: n.id, phone_number: n.phone_number, status: n.status,
      connection_id: n.connection_id || null,
    });
    if (rows.length < 250) break;
  }
  return out;
}

// List owned numbers, flagged with whether they're already imported into `dids`.
app.get('/api/admin/telnyx/numbers', auth, adminOnly, async (_req, res) => {
  try {
    const [owned, dids] = await Promise.all([
      telnyxListOwned(), sbSelect('dids', 'select=phone_number'),
    ]);
    const have = new Set((dids || []).map(d => d.phone_number));
    res.json({ numbers: owned.map(n => ({ ...n, in_dialer: have.has(n.phone_number) })) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Pull every owned number on the connection into `dids` (skips ones already there).
app.post('/api/admin/telnyx/sync', auth, adminOnly, async (req, res) => {
  try {
    const owned = await telnyxListOwned();
    let added = 0;
    for (const n of owned) {
      const num = n.phone_number; if (!num) continue;
      const area = areaCodeOf(num);
      const derived = deriveFromAreaCode(area || '');
      const r = await sbReq('POST', 'dids?on_conflict=phone_number',
        { phone_number: num, area_code: area, state: derived.state || null, active: true },
        'resolution=ignore-duplicates,return=representation');
      if (Array.isArray(r) && r.length) added++;   // representation returns only new inserts
    }
    audit(req.user, 'SYNC_DIDS', { target_type: 'did', meta: { owned: owned.length, added } });
    res.json({ ok: true, owned: owned.length, added });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Search Telnyx inventory for available numbers by area code, with per-number cost.
app.get('/api/admin/telnyx/available', auth, adminOnly, async (req, res) => {
  if (!TELNYX_KEY) return res.status(400).json({ error: 'Telnyx not configured' });
  const area = String(req.query.area_code || '').replace(/[^\d]/g, '').slice(0, 3);
  if (area.length !== 3) return res.status(400).json({ error: 'area_code must be 3 digits' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  try {
    const r = await telnyx('GET',
      `/available_phone_numbers?filter[national_destination_code]=${area}` +
      `&filter[country_code]=US&filter[features][]=voice&filter[limit]=${limit}`);
    const numbers = (r.data || []).map(n => ({
      phone_number: n.phone_number,
      upfront_cost: n.cost_information && n.cost_information.upfront_cost,
      monthly_cost: n.cost_information && n.cost_information.monthly_cost,
      currency: (n.cost_information && n.cost_information.currency) || 'USD',
      region: (n.region_information || []).map(x => x.region_name).filter(Boolean).join(', '),
    }));
    res.json({ numbers });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Purchase one or more numbers on Telnyx, assign them to this dialer's connection,
// and import them into `dids`. Actual billing happens on the Telnyx account.
app.post('/api/admin/telnyx/order', auth, adminOnly, async (req, res) => {
  if (!TELNYX_KEY || !CONNECTION_ID) return res.status(400).json({ error: 'Telnyx not configured' });
  const list = Array.isArray(req.body && req.body.phone_numbers) ? req.body.phone_numbers : [];
  const nums = [...new Set(list.map(x => normPhone(String(x || ''))).filter(Boolean))];
  if (!nums.length) return res.status(400).json({ error: 'phone_numbers required' });
  if (nums.length > 10) return res.status(400).json({ error: 'max 10 numbers per order' });
  try {
    const order = await telnyx('POST', '/number_orders', {
      phone_numbers: nums.map(phone_number => ({ phone_number })),
      connection_id: CONNECTION_ID,   // voice assignment happens here, on Telnyx
    });
    const od = order.data || {};
    // Import ordered numbers into dids so they're immediately usable in the dialer.
    let added = 0;
    for (const num of nums) {
      const area = areaCodeOf(num);
      const derived = deriveFromAreaCode(area || '');
      const r = await sbReq('POST', 'dids?on_conflict=phone_number',
        { phone_number: num, area_code: area, state: derived.state || null, active: true },
        'resolution=ignore-duplicates,return=representation');
      if (Array.isArray(r) && r.length) added++;
    }
    refreshCallerPool().catch(() => {});
    audit(req.user, 'ORDER_DIDS', { target_type: 'did', meta: { numbers: nums, order_id: od.id, status: od.status } });
    res.json({ ok: true, order_id: od.id || null, status: od.status || 'pending', ordered: nums, added });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── DNC list management (view / search / export / remove w/ confirm) ──────────
app.get('/api/admin/dnc', auth, adminOnly, async (req, res) => {
  const q = String(req.query.q || '').replace(/[^\d]/g, '');
  const filter = q ? `phone=ilike.*${q}*&` : '';
  try { res.json({ rows: await sbSelect('dnc_list', `${filter}order=created_at.desc&limit=500`) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/dnc/export', auth, adminOnly, async (req, res) => {
  try {
    const rows = await sbSelect('dnc_list', 'select=phone,reason,source,created_at&order=created_at.desc');
    const csv = 'phone,reason,source,created_at\n' +
      (rows || []).map(r => `${r.phone},${r.reason||''},${r.source||''},${r.created_at}`).join('\n');
    audit(req.user, 'EXPORT_DNC', { target_type: 'dnc', meta: { count: (rows||[]).length } });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="dnc-list.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Manual DNC upload — admin pastes/uploads a list; every valid number is added
// permanently. Accepts single-column or multi-column CSV, with or without header.
app.post('/api/admin/dnc/import', auth, adminOnly, async (req, res) => {
  const isJson = req.is('application/json');
  const text = isJson ? (req.body && req.body.csv) : (typeof req.body === 'string' ? req.body : '');
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'empty file' });
  try {
    // Scan every cell of every line; keep tokens that normalize to a valid NANP number.
    const found = new Set();
    let scanned = 0, invalid = 0;
    for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
      if (!line.trim()) continue;
      for (const cell of line.split(',')) {
        const raw = cell.trim(); if (!raw) continue;
        const digits = raw.replace(/[^\d]/g, '');
        if (!digits) continue;
        scanned++;
        const p = normPhone(raw);
        const d2 = p.replace(/[^\d]/g, '');
        if ((d2.length === 11 && d2.startsWith('1')) || d2.length === 10) found.add(p);
        else invalid++;
      }
    }
    const phones = [...found];
    if (!phones.length) return res.status(400).json({ error: 'no valid phone numbers found' });

    // Dedupe against what's already on the list.
    const existing = new Set();
    for (let i = 0; i < phones.length; i += 200) {
      const chunk = phones.slice(i, i + 200).map(p => `"${p}"`).join(',');
      const hits = await sbSelect('dnc_list', `phone=in.(${chunk})&select=phone`);
      for (const h of hits || []) existing.add(h.phone);
    }
    const fresh = phones.filter(p => !existing.has(p));

    let added = 0;
    for (let i = 0; i < fresh.length; i += 500) {
      const rows = fresh.slice(i, i + 500).map(phone => ({
        phone, reason: 'manual upload', source: 'admin_import',
      }));
      await sbInsert('dnc_list', rows);
      added += rows.length;
    }
    // Flag any existing leads that match, so the pre-dial check and pacer skip them.
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200).map(p => `"${p}"`).join(',');
      await sbUpdate('leads', `phone=in.(${chunk})`, { dnc: true, status: 'DNC' }).catch(() => {});
    }
    audit(req.user, 'IMPORT_DNC', { target_type: 'dnc',
      meta: { added, duplicates: existing.size, invalid } });
    res.json({ ok: true, added, duplicates: existing.size, invalid,
      summary: `${added} added · ${existing.size} already listed · ${invalid} invalid` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Removal requires admin role (enforced) + explicit confirm flag.
app.delete('/api/admin/dnc/:phone', auth, adminOnly, async (req, res) => {
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'confirmation required' });
  const phone = normPhone(req.params.phone);
  try {
    await sbDelete('dnc_list', `phone=eq.${encodeURIComponent(phone)}`);
    // also clear the denormalized flag on any matching leads
    await sbUpdate('leads', `phone=eq.${encodeURIComponent(phone)}&dnc=eq.true`, { dnc: false, status: 'NEW' }).catch(() => {});
    audit(req.user, 'REMOVE_DNC', { target_type: 'dnc', target_id: phone });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Calling-window global setting (admin-editable) ────────────────────────────
app.get('/api/admin/settings/calling-window', auth, adminOnly, async (_req, res) => {
  res.json({ ...CALLING_WINDOW });
});
app.put('/api/admin/settings/calling-window', auth, adminOnly, async (req, res) => {
  const sh = parseInt(req.body && req.body.start_hour, 10);
  const eh = parseInt(req.body && req.body.end_hour, 10);
  if (!(sh >= 0 && sh <= 23) || !(eh >= 1 && eh <= 24) || eh <= sh)
    return res.status(400).json({ error: 'invalid window' });
  try {
    await sbUpdate('app_settings', `key=eq.calling_window`, { value: { start_hour: sh, end_hour: eh }, updated_at: new Date().toISOString() });
    CALLING_WINDOW = { start_hour: sh, end_hour: eh };
    audit(req.user, 'EDIT_CALLING_WINDOW', { target_type: 'settings', meta: CALLING_WINDOW });
    res.json({ ok: true, ...CALLING_WINDOW });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dialer pacing config — CPA (lines_per_agent) + ring timeout (ring_secs).
app.get('/api/admin/settings/dialer', auth, adminOnly, async (_req, res) => {
  res.json({ ...DIALER });
});
app.put('/api/admin/settings/dialer', auth, adminOnly, async (req, res) => {
  const lpa = parseInt(req.body && req.body.lines_per_agent, 10);
  const rs = parseInt(req.body && req.body.ring_secs, 10);
  if (!(lpa >= 1 && lpa <= 5)) return res.status(400).json({ error: 'lines_per_agent must be 1-5' });
  if (!(rs >= 10 && rs <= 60)) return res.status(400).json({ error: 'ring_secs must be 10-60' });
  const value = { lines_per_agent: lpa, ring_secs: rs };
  try {
    await sbReq('POST', 'app_settings?on_conflict=key',
      { key: 'dialer', value, updated_at: new Date().toISOString() },
      'resolution=merge-duplicates,return=minimal');
    DIALER = value;
    audit(req.user, 'EDIT_DIALER', { target_type: 'settings', meta: DIALER });
    res.json({ ok: true, ...DIALER });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Call Result Management — per-disposition recycle / strike / redial policy.
// Returns the disposition list (for the dropdown) plus each one's effective
// settings so the UI can pre-fill the fields when a disposition is picked.
app.get('/api/admin/settings/call-policy', auth, adminOnly, async (_req, res) => {
  const dispositions = DEFAULT_DISPOSITIONS.map(d => ({
    code: d.code, label: d.label,
    is_dnc: !!d.is_dnc, is_callback: !!d.is_callback, positive: isPositiveDisp(d),
    policy: dispPolicy(d.code),
  }));
  res.json({ dispositions, defaults: DISP_POLICY_DEFAULT, positive_dnc_days: POLICY.positive_dnc_days });
});
// Save the policy for ONE disposition. Body: { code, recycle_window_days,
// neg_strike_limit, neg_redial_hours }. Merges into the per-disposition map.
app.put('/api/admin/settings/call-policy', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  if (!code || !DEFAULT_DISPOSITIONS.some(d => d.code === code))
    return res.status(400).json({ error: 'unknown disposition code' });
  const rwd = parseInt(b.recycle_window_days, 10);
  const nsl = parseInt(b.neg_strike_limit, 10);
  const nrh = parseInt(b.neg_redial_hours, 10);
  if (!(rwd >= 1 && rwd <= 365))  return res.status(400).json({ error: 'recycle_window_days must be 1-365' });
  if (!(nsl >= 1 && nsl <= 20))   return res.status(400).json({ error: 'neg_strike_limit must be 1-20' });
  if (!(nrh >= 1 && nrh <= 720))  return res.status(400).json({ error: 'neg_redial_hours must be 1-720' });
  const dispositions = { ...(POLICY.dispositions || {}), [code]: { recycle_window_days: rwd, neg_strike_limit: nsl, neg_redial_hours: nrh } };
  const value = { positive_dnc_days: POLICY.positive_dnc_days, dispositions };
  try {
    await sbReq('POST', 'app_settings?on_conflict=key',
      { key: 'call_policy', value, updated_at: new Date().toISOString() },
      'resolution=merge-duplicates,return=minimal');
    POLICY = value;
    audit(req.user, 'EDIT_CALL_POLICY', { target_type: 'settings', meta: { code, ...dispositions[code] } });
    res.json({ ok: true, code, policy: dispositions[code] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI Cold Caller — master config. GET returns the config plus the campaign and
// agent lists so the UI can offer opt-in checkboxes. PUT validates + persists.
app.get('/api/admin/settings/ai', auth, adminOnly, async (_req, res) => {
  try {
    const [campaigns, agents] = await Promise.all([
      sbSelect('campaigns', 'select=id,name,active&order=created_at.desc').catch(() => []),
      sbSelect('agents', 'select=id,name,role&order=name.asc').catch(() => []),
    ]);
    res.json({ ...AI, campaigns: campaigns || [], agents: (agents || []).filter(a => a.role === 'agent' || a.role === 'admin') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/settings/ai', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const conc = parseInt(b.concurrency, 10);
  if (!(conc >= 1 && conc <= 50)) return res.status(400).json({ error: 'concurrency must be 1-50' });
  const value = {
    enabled: !!b.enabled,
    concurrency: conc,
    assistant_id: String(b.assistant_id || '').trim(),
    voice: String(b.voice || '').trim(),
    transfer_agent_ids: Array.isArray(b.transfer_agent_ids) ? b.transfer_agent_ids.map(String) : [],
    campaign_ids: Array.isArray(b.campaign_ids) ? b.campaign_ids.map(String) : [],
  };
  // Guard: can't enable AI dialing without an assistant to attach.
  if (value.enabled && !value.assistant_id)
    return res.status(400).json({ error: 'set a Telnyx assistant_id before enabling' });
  try {
    await sbReq('POST', 'app_settings?on_conflict=key',
      { key: 'ai', value, updated_at: new Date().toISOString() },
      'resolution=merge-duplicates,return=minimal');
    AI = value;
    audit(req.user, 'EDIT_AI', { target_type: 'settings', meta: { enabled: value.enabled, concurrency: value.concurrency, campaigns: value.campaign_ids.length } });
    res.json({ ok: true, ...AI });
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

// Stream a recording THROUGH the server so the browser can play/download it.
// Telnyx `recording_urls` (api.telnyx.com) require an Authorization: Bearer header
// that an <audio> tag / anchor can't send — so those play as 0:00/0:00 if handed
// to the browser directly. We fetch server-side (with the key when needed) and
// pipe the bytes back over our own https origin. Auth via ?token= (see auth()).
app.get('/api/admin/reports/recording/:id/stream', auth, adminOnly, async (req, res) => {
  try {
    const rows = await sbSelect('calls', `id=eq.${req.params.id}&select=id,recording_url,to_number`);
    const c = rows[0];
    if (!c || !c.recording_url) return res.status(404).json({ error: 'no recording' });
    const isTelnyx = /telnyx\.com/i.test(c.recording_url);
    const upstream = await fetch(c.recording_url, {
      headers: isTelnyx ? { 'Authorization': `Bearer ${TELNYX_KEY}` } : {},
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `recording fetch ${upstream.status}` });
    }
    const download = req.query.download === '1';
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const len = upstream.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (download) {
      const safe = String(c.to_number || 'recording').replace(/[^0-9a-z_+-]/gi, '');
      res.setHeader('Content-Disposition', `attachment; filename="call_${safe}.mp3"`);
    }
    audit(req.user, download ? 'CALL_DOWNLOAD' : 'CALL_LISTEN',
      { target_type: 'call', target_id: c.id, meta: { to: c.to_number } });
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
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

// AUX status switch: Ready (AVAILABLE) / Wrap up (WRAP_UP) / Break (BREAK).
// The softphone stays in-conference the whole time, so switching is instant and
// no re-dial is needed. The pacer only feeds AVAILABLE agents, so WRAP_UP/BREAK
// simply pause new calls. Client enforces the max timers (3 min / 15 min) and
// flips back to Ready; this endpoint just records the requested state.
app.post('/api/agent/aux', auth, async (req, res) => {
  const id = req.user.id;
  const st = rt[id];
  const want = String((req.body && req.body.state) || '').toUpperCase();
  // Wrap-up is automated (set by call-end / disposition), never agent-selected.
  if (!['AVAILABLE', 'BREAK'].includes(want))
    return res.status(400).json({ error: 'invalid aux state' });
  if (!st || !st.conferenceId)
    return res.status(409).json({ error: 'softphone not connected' });
  if (['DIALING', 'CLAIMING', 'ON_CALL'].includes(st.state))
    return res.status(409).json({ error: 'busy on a call' });
  clearWrapTimer(st);   // manual Ready/Break cancels any pending wrap auto-return
  // Returning to Ready with an undispositioned lead still attached (e.g. the
  // wrap-up timer expired): release the leftover leg so the pacer starts clean.
  if (want === 'AVAILABLE' && st.leadId) {
    if (st.leadLeg) telnyx('POST', `/calls/${st.leadLeg}/actions/hangup`, {}).catch(() => {});
    st.leadLeg = null; st.leadNumber = null; st.leadId = null; st.fromNumber = null; st.onCallSince = null;
  }
  st.state = want;
  await setAgentState(id, want);
  audit(req.user, 'AUX', { target_type: 'session', meta: { state: want } });
  res.json({ ok: true, state: want });
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

    // Decide the lead's next status + DNC policy (see the rules block near the top).
    const patch = { last_outcome: code };
    if (notes != null) patch.notes_last = undefined; // reserved; notes live on dispositions
    if (disp.is_dnc) {
      // Explicit Do-Not-Call → permanent DNC (only an admin can clear it).
      patch.status = 'DNC'; patch.dnc = true;
      dncPermanent(lead.phone, 'internal');
    } else if (isPositiveDisp(disp)) {
      // Sale / appointment / lead → converted, DNC for 90 days then auto-removed.
      patch.status = disp.outcome || 'DONE'; patch.dnc = true;
      dncTemporary(lead.phone, POLICY.positive_dnc_days, 'converted');
    } else if (disp.is_callback) {
      patch.status = 'CALLBACK';
      patch.next_callback_at = callback_at || new Date(Date.now() + 3600e3).toISOString();
      patch.assigned_agent_id = req.user.id; // route callback back to this agent
    } else {
      // Every other outcome (not available / voicemail / not interested / …):
      // one strike. 4 strikes on the phone (any campaign) → permanent DNC.
      // Otherwise keep it re-dialable, but only within 10 days of the first dial.
      const dp = dispPolicy(disp.code);
      const act = await bumpPhoneStrike(lead.phone);
      const strikes = (act && act.neg_strikes) || 1;
      if (strikes >= dp.neg_strike_limit) {
        patch.status = 'DNC'; patch.dnc = true;
        dncPermanent(lead.phone, 'strike-limit');
        // Propagate DNC to every other lead row sharing this number.
        sbUpdate('leads', `phone=eq.${encodeURIComponent(lead.phone)}&dnc=eq.false`,
          { dnc: true, status: 'DNC' }).catch(() => {});
      } else {
        const firstDial = (act && act.first_dial_at) ? new Date(act.first_dial_at).getTime() : Date.now();
        const windowEnd = firstDial + dp.recycle_window_days * 86400e3;
        const rule = disp.recycle ? ((cfg.recycle_rules || DEFAULT_RECYCLE)[disp.recycle] || {}) : {};
        const ms = rule.hours ? rule.hours * 3600e3 : (rule.minutes ? rule.minutes * 60e3 : dp.neg_redial_hours * 3600e3);
        const next = Date.now() + ms;
        if (next >= windowEnd) {
          patch.status = 'EXHAUSTED';   // next redial would fall outside the 10-day window
        } else {
          patch.status = 'NEW';
          patch.next_callback_at = new Date(next).toISOString();
        }
      }
    }
    await sbUpdate('leads', `id=eq.${leadId}`, patch).catch(e => console.error('[disp:lead]', e.message));
    audit(req.user, 'DISPOSITION', { target_type: 'lead', target_id: leadId, meta: { code, next_status: patch.status, phone: lead.phone } });

    // Hang up the lead leg if still up, then run the wrap-up cooldown before the
    // pacer feeds the next call: 3s by default, 3 minutes for a positive outcome
    // (appointment / sale / lead) so the agent can finish paperwork.
    let wrapSec = WRAP_SHORT_SEC;
    if (st) {
      if (st.leadLeg) telnyx('POST', `/calls/${st.leadLeg}/actions/hangup`, {}).catch(() => {});
      st.leadLeg = null; st.leadNumber = null; st.leadId = null; st.fromNumber = null; st.onCallSince = null;
      if (st.state !== 'OFFLINE' && st.conferenceId) {
        wrapSec = wrapSecondsFor(disp);
        st.state = 'WRAP_UP';
        await setAgentState(req.user.id, 'WRAP_UP');
        scheduleWrapReturn(req.user.id, wrapSec);
      } else if (st.state !== 'OFFLINE') {
        st.state = 'OFFLINE'; await setAgentState(req.user.id, 'OFFLINE');
      }
    }
    res.json({ ok: true, next_status: patch.status, wrap_seconds: wrapSec });
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

// Manual click-to-call: agent dials a specific lead (from an action folder or
// search result) instead of waiting for the pacer. Requires the agent to be
// AVAILABLE and in-conference. Still enforces DNC + calling-window compliance.
app.post('/api/agent/call-lead', auth, async (req, res) => {
  const id = req.user.id;
  const st = rt[id];
  const leadId = req.body && req.body.lead_id;
  if (!leadId) return res.status(400).json({ error: 'lead_id required' });
  if (!st || st.state !== 'AVAILABLE' || !st.conferenceId || st.leadLeg)
    return res.status(409).json({ error: 'must be available and connected first' });
  try {
    const [lead] = await sbSelect('leads', `id=eq.${leadId}&select=*&limit=1`);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    if (!inCallingWindow(lead.timezone, CALLING_WINDOW.start_hour, CALLING_WINDOW.end_hour))
      return res.status(409).json({ error: 'outside calling window for this lead' });
    st.state = 'CLAIMING';
    await dialLead(id, lead);   // does the DNC check + state transitions
    audit(req.user, 'MANUAL_CALL', { target_type: 'lead', target_id: leadId, meta: { phone: lead.phone } });
    res.json({ ok: true, state: st.state });
  } catch (e) { st && (st.state = 'AVAILABLE'); res.status(502).json({ error: e.message }); }
});

// ══ PACING ENGINE ════════════════════════════════════════════════════════════════
async function dialLead(agentId, lead) {
  const st = rt[agentId];
  if (!st) return;
  // ReadyMode power-dialer invariant: ONE live line per agent. Never launch a
  // new dial while a lead leg is still connected/ringing — this is the last-
  // resort guard against overlapping calls if a hangup webhook was missed or
  // state raced back to AVAILABLE. Bail and stay dialable for the next tick.
  if (st.leadLeg) {
    console.log(`[pacing] skip dial ${agentId.slice(0, 8)} — lead leg still live`);
    if (st.state === 'CLAIMING') st.state = 'AVAILABLE';
    return;
  }
  // Compliance check #1: skip DNC numbers before EVERY dial. dnc_list is the
  // source of truth; if a number slipped through (flag not yet synced), catch
  // it here, sync the flag, and bail without dialing.
  try {
    // Ignore entries whose expiry has passed (e.g. a 90-day post-sale DNC) even if
    // the periodic sweep hasn't cleared them yet.
    const nowIso = new Date().toISOString();
    const hit = await sbSelect('dnc_list',
      `phone=eq.${encodeURIComponent(lead.phone)}&or=(expires_at.is.null,expires_at.gt.${nowIso})&select=phone&limit=1`);
    if (hit && hit.length) {
      await sbUpdate('leads', `id=eq.${lead.id}`, { dnc: true, status: 'DNC' }).catch(() => {});
      console.log(`[pacing] DNC skip ${lead.phone}`);
      return;   // leave state as-is; the flagged lead won't be re-selected
    }
  } catch (e) { console.error('[dialLead:dnc]', e.message); }
  const from = pickCallerId(areaCodeOf(lead.phone));
  const result = await telnyx('POST', '/calls', {
    connection_id: CONNECTION_ID,
    to: lead.phone,
    from,
    timeout_secs: DIALER.ring_secs,   // hard ring cap — no dead air on no-answers
    answering_machine_detection: AMD_MODE === 'disabled' ? 'disabled' : 'premium',
    // Unconditional recording (per Karim). Recording is saved on call.recording.saved.
    record: 'record-from-answer', record_channels: 'dual', record_format: 'mp3',
    client_state: enc({ role: 'lead', agentId, conf: st.conferenceId, leadId: lead.id, campaignId: lead.campaign_id }),
  });
  const ccid = result.data && result.data.call_control_id;
  // Ratio dialing: track every in-flight (unbridged) leg. st.leadLeg is reserved
  // for the ONE leg that actually connects to a human; the extras get dropped the
  // moment one connects (see connectLeadLeg).
  st.pending = st.pending || {};
  st.pending[ccid] = { leadId: lead.id, leadNumber: lead.phone, fromNumber: from, campaignId: lead.campaign_id, at: Date.now() };
  if (st.state !== 'ON_CALL') st.state = 'DIALING';
  st.onCallSince = null;
  await persistRt(agentId);
  logStateEvent(agentId, 'DIALING');
  wsAgentSnapshot(agentId);
  await sbUpdate('leads', `id=eq.${lead.id}`,
    { status: 'IN_PROGRESS', attempts: (lead.attempts || 0) + 1, last_attempt_at: new Date().toISOString(), assigned_agent_id: agentId })
    .catch(e => console.error('[dialLead:update]', e.message));
  markFirstDial(lead.phone);   // stamps first_dial_at once — anchors the 10-day recycle window
  // Open a calls row for history/recording linkage.
  sbLog('calls', { lead_id: lead.id, agent_id: agentId, campaign_id: lead.campaign_id,
    telnyx_call_control_id: ccid, from_number: from, to_number: lead.phone, direction: 'outbound' });
  console.log(`[pacing] agent ${agentId.slice(0, 8)} -> ${lead.phone} from ${from} (${Object.keys(st.pending).length} in flight)`);
}

// Promote one ringing leg to THE connected call for this agent, dropping every
// other in-flight leg. Enforces the one-live-call-per-agent invariant even when
// ratio dialing rings several numbers at once. `amd` is the AMD result (or null
// for AMD-disabled straight answers).
async function connectLeadLeg(agentId, ccid, cs, amd) {
  const st = rt[agentId];
  const conf = (cs && cs.conf) || (st && st.conferenceId);
  if (!st || !conf) { telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {}); return; }
  // Already talking to someone → this is a second simultaneous answer. Drop it
  // and requeue the lead shortly so it isn't lost (this is the "abandoned call").
  if (st.leadLeg && st.leadLeg !== ccid) {
    if (st.pending) delete st.pending[ccid];
    telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
    const lid = (cs && cs.leadId);
    if (lid) sbUpdate('leads', `id=eq.${lid}`,
      { status: 'CALLBACK', next_callback_at: new Date(Date.now() + 10 * 60e3).toISOString() }).catch(() => {});
    console.log(`[bridge] extra answer dropped for agent ${agentId.slice(0, 8)} (already on a call)`);
    return;
  }
  const info = (st.pending && st.pending[ccid]) || {};
  if (st.pending) delete st.pending[ccid];
  st.leadLeg = ccid;
  st.leadId = info.leadId || (cs && cs.leadId) || null;
  st.leadNumber = info.leadNumber || null;
  st.fromNumber = info.fromNumber || null;
  st.onCallSince = Date.now();
  st.state = 'ON_CALL';
  await telnyx('POST', `/conferences/${conf}/actions/join`, { call_control_id: ccid, start_conference_on_enter: true, mute: false });
  await setAgentState(agentId, 'ON_CALL');
  sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`, { bridged_at: new Date().toISOString(), amd_result: amd || null }).catch(() => {});
  if (st.leadId) sbUpdate('leads', `id=eq.${st.leadId}`, { status: 'CONTACTED' }).catch(() => {});
  // Drop the sibling dials and requeue their leads so nothing is wasted.
  if (st.pending) {
    for (const other of Object.keys(st.pending)) {
      const oi = st.pending[other];
      telnyx('POST', `/calls/${other}/actions/hangup`, {}).catch(() => {});
      if (oi && oi.leadId) sbUpdate('leads', `id=eq.${oi.leadId}`,
        { status: 'CALLBACK', next_callback_at: new Date(Date.now() + 5 * 60e3).toISOString() }).catch(() => {});
    }
    st.pending = {};
  }
  console.log(`[bridge] agent ${agentId.slice(0, 8)} ON_CALL (${amd || 'answered'})`);
}

let pacingBusy = false;
// Pull the next dialable, in-window lead across a set of campaigns (applying an
// optional playlist filter set). Returns a lead row or null.
async function nextDialableLead(campaignIds, filters, nowIso) {
  if (!campaignIds.length) return null;
  const inList = campaignIds.map(c => `"${c}"`).join(',');
  const frag = playlistFragment(filters || []);
  const leads = await sbSelect('leads',
    `campaign_id=in.(${inList})&dnc=eq.false&status=in.(NEW,CALLBACK)` +
    (frag ? `&${frag}` : '') +
    `&or=(next_callback_at.is.null,next_callback_at.lte.${nowIso})` +
    `&order=next_callback_at.asc.nullsfirst,created_at.asc&limit=15&select=*`);
  // Compliance: hard lead-local calling window.
  return (leads || []).find(l =>
    inCallingWindow(l.timezone, CALLING_WINDOW.start_hour, CALLING_WINDOW.end_hour)) || null;
}
async function pacingTick() {
  if (pacingBusy || !SB_HOST || !CONNECTION_ID) return;
  pacingBusy = true;
  try {
    // Agents that can take MORE dials: in-conference, not on a connected call,
    // not inbound, and with fewer in-flight legs than the CPA ratio allows.
    const freeAgents = Object.keys(rt).filter(id => {
      const st = rt[id];
      if (!st || !st.conferenceId || st.leadLeg || st.inbound) return false;
      if (st.state !== 'AVAILABLE' && st.state !== 'DIALING') return false;
      const inFlight = st.pending ? Object.keys(st.pending).length : 0;
      return inFlight < 5;   // hard max; real per-playlist CPA enforced in the loop
    });
    if (!freeAgents.length) return;
    const nowIso = new Date().toISOString();

    // Snapshot the routing model once per tick.
    const [runningCamps, playlists, plCamps, plAgents, legacyAssigns] = await Promise.all([
      sbSelect('campaigns', 'status=eq.RUNNING&select=id'),
      sbSelect('playlists', 'active=eq.true&select=id,priority,filters,lines_per_agent'),
      sbSelect('playlist_campaigns', 'select=playlist_id,campaign_id'),
      sbSelect('playlist_agents', 'select=playlist_id,agent_id'),
      sbSelect('campaign_agents', 'select=campaign_id,agent_id'),
    ]);
    const runningSet = new Set((runningCamps || []).map(c => c.id));
    const plById = Object.fromEntries((playlists || []).map(p => [p.id, p]));
    // playlist_id -> [campaignIds that are RUNNING]
    const campsByPlaylist = {};
    for (const { playlist_id, campaign_id } of plCamps || []) {
      if (!runningSet.has(campaign_id)) continue;
      (campsByPlaylist[playlist_id] ||= []).push(campaign_id);
    }
    // agent_id -> ordered playlist list (highest priority = lowest number first)
    const playlistsByAgent = {};
    for (const { playlist_id, agent_id } of plAgents || []) {
      const p = plById[playlist_id]; if (!p) continue;
      (playlistsByAgent[agent_id] ||= []).push(p);
    }
    for (const id in playlistsByAgent) playlistsByAgent[id].sort((a, b) => a.priority - b.priority);
    // Legacy: agent_id -> [RUNNING campaignIds] (only used if agent is on no playlist)
    const legacyByAgent = {};
    for (const { campaign_id, agent_id } of legacyAssigns || []) {
      if (!runningSet.has(campaign_id)) continue;
      (legacyByAgent[agent_id] ||= []).push(campaign_id);
    }

    // Per-playlist CPA (calls-per-agent). A playlist may override the global
    // DIALER.lines_per_agent; null/invalid on the playlist = inherit global.
    const cpaOf = (pl) => {
      const n = pl && pl.lines_per_agent;
      return (n >= 1 && n <= 5) ? n : DIALER.lines_per_agent;
    };

    // Pick the next dialable lead for one agent, honouring its playlist priority.
    // Returns { lead, playlist } (playlist is null for legacy campaign_agents).
    const pickLead = async (agentId) => {
      const agentPlaylists = playlistsByAgent[agentId];
      if (agentPlaylists && agentPlaylists.length) {
        for (const p of agentPlaylists) {
          const cids = campsByPlaylist[p.id];
          if (!cids || !cids.length) continue;
          const lead = await nextDialableLead(cids, p.filters, nowIso);
          if (lead) return { lead, playlist: p };
        }
        return { lead: null, playlist: null };
      }
      return { lead: await nextDialableLead(legacyByAgent[agentId] || [], [], nowIso), playlist: null };
    };

    for (const agentId of freeAgents) {
      const st = rt[agentId];
      if (!st || !st.conferenceId || st.leadLeg || st.inbound) continue;
      if (st.state !== 'AVAILABLE' && st.state !== 'DIALING') continue;
      const inFlight = st.pending ? Object.keys(st.pending).length : 0;
      // First pick decides which playlist (and therefore which CPA) applies to
      // this agent this tick. Each dialLead marks its lead IN_PROGRESS before the
      // next pick, so we never ring the same number twice.
      const first = await pickLead(agentId);
      if (!first.lead) continue;                          // no dialable lead for this agent
      const cpa = cpaOf(first.playlist);
      if (inFlight >= cpa) continue;                       // already at this playlist's CPA
      try { await dialLead(agentId, first.lead); }
      catch (e) { console.error('[pacing:dial]', e.message); continue; }
      // Top up to the playlist's CPA with additional simultaneous legs.
      let need = cpa - inFlight - 1;
      while (need-- > 0) {
        if (st.leadLeg || st.inbound) break;              // connected mid-loop → stop dialing
        const nxt = await pickLead(agentId);
        if (!nxt.lead) break;                              // no more leads for this agent
        try { await dialLead(agentId, nxt.lead); }
        catch (e) { console.error('[pacing:dial]', e.message); break; }
      }
    }
  } catch (e) { console.error('[pacing]', e.message); }
  finally { pacingBusy = false; }
}

// ══ AI COLD CALLER LANE ══════════════════════════════════════════════════════════
// A self-contained pacer that dials leads from AI.campaign_ids and, on a CONFIRMED
// human (premium AMD gate — voicemail is never billed), attaches the Telnyx AI
// Assistant instead of bridging a human agent. No conference, no seat; the only
// resource is a concurrency slot in aiRt. Reuses the same DID pool as the human
// dialer (pickCallerId) per the "same phone numbers" decision.
const AI_MAX_CALL_MS = 15 * 60 * 1000;   // safety: reclaim a slot if a webhook was missed

// Next dialable, in-window AI lead across AI.campaign_ids. Mirrors nextDialableLead
// but scoped to the AI opt-in campaigns with no playlist filters.
async function nextAiLead(nowIso) {
  const cids = AI.campaign_ids;
  if (!cids.length) return null;
  const inList = cids.map(c => `"${c}"`).join(',');
  const leads = await sbSelect('leads',
    `campaign_id=in.(${inList})&dnc=eq.false&status=in.(NEW,CALLBACK)` +
    `&or=(next_callback_at.is.null,next_callback_at.lte.${nowIso})` +
    `&order=next_callback_at.asc.nullsfirst,created_at.asc&limit=15&select=*`);
  return (leads || []).find(l =>
    inCallingWindow(l.timezone, CALLING_WINDOW.start_hour, CALLING_WINDOW.end_hour)) || null;
}

// Place one outbound AI call. Marks the lead IN_PROGRESS immediately (same as the
// human dialLead) so neither lane re-picks it. client_state carries role:'ai'.
async function dialAiLead(lead) {
  // Compliance: skip DNC before every dial (honour non-expired entries).
  try {
    const nowIso = new Date().toISOString();
    const hit = await sbSelect('dnc_list',
      `phone=eq.${encodeURIComponent(lead.phone)}&or=(expires_at.is.null,expires_at.gt.${nowIso})&select=phone&limit=1`);
    if (hit && hit.length) {
      await sbUpdate('leads', `id=eq.${lead.id}`, { dnc: true, status: 'DNC' }).catch(() => {});
      console.log(`[ai] DNC skip ${lead.phone}`);
      return;
    }
  } catch (e) { console.error('[dialAiLead:dnc]', e.message); }
  const from = pickCallerId(areaCodeOf(lead.phone));
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || 'there';
  const result = await telnyx('POST', '/calls', {
    connection_id: CONNECTION_ID,
    to: lead.phone,
    from,
    timeout_secs: DIALER.ring_secs,
    answering_machine_detection: AMD_MODE === 'disabled' ? 'disabled' : 'premium',
    record: 'record-from-answer', record_channels: 'dual', record_format: 'mp3',
    client_state: enc({ role: 'ai', leadId: lead.id, campaignId: lead.campaign_id }),
  });
  const ccid = result.data && result.data.call_control_id;
  if (!ccid) return;
  aiRt[ccid] = { leadId: lead.id, leadNumber: lead.phone, fromNumber: from,
    campaignId: lead.campaign_id, name, address: lead.address || '', phase: 'dialing', at: Date.now() };
  await sbUpdate('leads', `id=eq.${lead.id}`,
    { status: 'IN_PROGRESS', attempts: (lead.attempts || 0) + 1, last_attempt_at: new Date().toISOString() })
    .catch(e => console.error('[dialAiLead:update]', e.message));
  markFirstDial(lead.phone);
  sbLog('calls', { lead_id: lead.id, campaign_id: lead.campaign_id,
    telnyx_call_control_id: ccid, from_number: from, to_number: lead.phone, direction: 'outbound' });
  console.log(`[ai] -> ${lead.phone} from ${from} (${Object.keys(aiRt).length}/${AI.concurrency} live)`);
}

// Attach the assistant to a live, confirmed-human leg. Dynamic variables are nested
// under assistant.dynamic_variables per the Telnyx ai_assistant_start contract.
async function startAiAssistant(ccid) {
  const info = aiRt[ccid];
  if (!info) return;
  const dyn = { contact_name: info.name || 'there' };
  if (info.address) dyn.property_address = info.address;
  try {
    await telnyx('POST', `/calls/${ccid}/actions/ai_assistant_start`, {
      assistant: { id: AI.assistant_id, dynamic_variables: dyn },
    });
    info.phase = 'assistant';
    sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
      { bridged_at: new Date().toISOString(), amd_result: 'human' }).catch(() => {});
    if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`, { status: 'CONTACTED' }).catch(() => {});
    console.log(`[ai] assistant attached ${ccid.slice(-8)} (${info.leadNumber})`);
  } catch (e) {
    console.error('[ai:start]', e.message);
    telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
  }
}

let aiPacingBusy = false;
async function aiPacingTick() {
  if (aiPacingBusy) return;
  if (!AI.enabled || !AI.assistant_id || !AI.campaign_ids.length) return;
  if (!SB_HOST || !CONNECTION_ID) return;
  aiPacingBusy = true;
  try {
    // Reclaim leaked slots (missed hangup webhook) before counting capacity.
    for (const [id, info] of Object.entries(aiRt)) {
      if (Date.now() - info.at > AI_MAX_CALL_MS) {
        delete aiRt[id];
        telnyx('POST', `/calls/${id}/actions/hangup`, {}).catch(() => {});
        console.log(`[ai] reclaimed stale slot ${id.slice(-8)}`);
      }
    }
    let slots = AI.concurrency - Object.keys(aiRt).length;
    if (slots <= 0) return;
    const nowIso = new Date().toISOString();
    while (slots-- > 0) {
      const lead = await nextAiLead(nowIso);   // dialAiLead marks IN_PROGRESS, so no re-pick
      if (!lead) break;
      try { await dialAiLead(lead); }
      catch (e) { console.error('[ai:dial]', e.message); break; }
    }
  } catch (e) { console.error('[aiPacing]', e.message); }
  finally { aiPacingBusy = false; }
}

// Pick a random AVAILABLE, in-conference agent who works `campaignId` (via any
// playlist that contains it). Returns an agentId or null.
async function pickInboundAgent(campaignId) {
  const pcs = await sbSelect('playlist_campaigns', `campaign_id=eq.${campaignId}&select=playlist_id`);
  const plIds = [...new Set((pcs || []).map(x => x.playlist_id))];
  if (!plIds.length) return null;
  const pas = await sbSelect('playlist_agents',
    `playlist_id=in.(${plIds.map(p => `"${p}"`).join(',')})&select=agent_id`);
  const candidates = [...new Set((pas || []).map(x => x.agent_id))]
    .filter(id => { const st = rt[id]; return st && st.state === 'AVAILABLE' && st.conferenceId; });
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];   // random rotation
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
              (payload.result ? ` result=${payload.result}` : '') +
              (payload.hangup_cause ? ` hangup_cause=${payload.hangup_cause}` : '') +
              (payload.hangup_source ? ` src=${payload.hangup_source}` : '') +
              (payload.sip_hangup_cause ? ` sip=${payload.sip_hangup_cause}` : '') +
              (payload.to ? ` to=${payload.to}` : ''));
  sbLog('call_events', { event_type: event, telnyx_call_control_id: ccid, client_state: cs, payload });

  try {
    // Recording saved -> attach URL to the calls row for in-browser playback.
    if (event === 'call.recording.saved') {
      // Prefer public_recording_urls (browser-playable, no auth) over recording_urls
      // (api.telnyx.com, needs Bearer). The /stream proxy handles either, but this
      // keeps stored URLs directly usable too.
      const url = (payload.public_recording_urls && (payload.public_recording_urls.mp3 || payload.public_recording_urls.wav)) ||
                  (payload.recording_urls && (payload.recording_urls.mp3 || payload.recording_urls.wav)) || null;
      if (ccid) sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
        { recording_url: url, recording_id: payload.recording_id || null }).catch(() => {});
      return;
    }

    // ── AI Cold Caller lane ────────────────────────────────────────────────────
    // Self-contained: no conference, no human agent. The assistant is attached
    // only on a confirmed human so voicemails never incur assistant cost.
    if (role === 'ai') {
      const info = aiRt[ccid];
      // AMD disabled: a straight answer is the connect signal.
      if (event === 'call.answered' && AMD_MODE === 'disabled' && info && info.phase === 'dialing') {
        await startAiAssistant(ccid);
        return;
      }
      // Premium AMD gate: attach on human/ambiguous, hang up + mark machine otherwise.
      if (event === 'call.machine.premium.detection.ended') {
        const r = payload.result || '';
        const isHuman = r.startsWith('human') || r === 'silence' || r === 'not_sure';   // TCPA-safe
        if (isHuman) {
          if (info && info.phase === 'dialing') await startAiAssistant(ccid);
        } else {
          delete aiRt[ccid];
          await telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
          if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}`, { status: 'MACHINE', last_outcome: 'machine' }).catch(() => {});
          sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`, { amd_result: r }).catch(() => {});
          console.log(`[ai] dropped machine ${ccid ? ccid.slice(-8) : '-'} (result=${r})`);
        }
        return;
      }
      // Call ended: free the slot and disposition the lead.
      if (event === 'call.hangup') {
        const talked = info && info.phase === 'assistant';
        delete aiRt[ccid];
        sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
          { ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }).catch(() => {});
        if (talked) {
          if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}&status=eq.CONTACTED`, { last_outcome: 'ai_contacted' }).catch(() => {});
        } else {
          // Never reached a human (no-answer/busy/ring-timeout). Machine was already
          // marked above and removed from aiRt, so it won't reach this branch.
          if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}&status=eq.IN_PROGRESS`,
            { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
        }
        console.log(`[ai] hangup ${ccid ? ccid.slice(-8) : '-'} (${talked ? 'talked' : 'no-answer'})`);
        return;
      }
      return;   // ignore other AI-lane events (call.initiated, ai_assistant.*, etc.)
    }

    // ── Inbound call on one of our DIDs ────────────────────────────────────────
    // A caller dials a DID assigned to a campaign; ring a random available agent
    // working that campaign and bridge them into that agent's conference.
    if (event === 'call.initiated' && (payload.direction === 'incoming' || payload.direction === 'inbound') && !role) {
      const toNum = normPhone(payload.to || '');
      const fromNum = payload.from || '';
      const [did] = await sbSelect('dids', `phone_number=eq.${encodeURIComponent(toNum)}&select=campaign_id,active&limit=1`);
      if (!did || did.active === false || !did.campaign_id) {
        console.log(`[inbound] no campaign for ${toNum} — rejecting`);
        await telnyx('POST', `/calls/${ccid}/actions/reject`, { cause: 'CALL_REJECTED' }).catch(() => {});
        return;
      }
      const chosen = await pickInboundAgent(did.campaign_id);
      if (!chosen) {
        console.log(`[inbound] ${toNum} campaign ${did.campaign_id.slice(0, 8)} — no available agent, rejecting`);
        await telnyx('POST', `/calls/${ccid}/actions/reject`, { cause: 'USER_BUSY' }).catch(() => {});
        return;
      }
      const st = rt[chosen];
      st.state = 'ON_CALL';                     // reserve so the pacer skips this agent
      await setAgentState(chosen, 'ON_CALL');
      await telnyx('POST', `/calls/${ccid}/actions/answer`, {
        client_state: enc({ role: 'inbound', agentId: chosen, conf: st.conferenceId, campaignId: did.campaign_id, from: fromNum }),
      });
      sbLog('calls', { agent_id: chosen, campaign_id: did.campaign_id,
        telnyx_call_control_id: ccid, from_number: fromNum, to_number: toNum, direction: 'inbound' });
      console.log(`[inbound] ${toNum} -> agent ${chosen.slice(0, 8)} (campaign ${did.campaign_id.slice(0, 8)})`);
      return;
    }
    // Inbound leg answered -> join it into the chosen agent's conference.
    if (event === 'call.answered' && role === 'inbound' && agentId) {
      const st = rt[agentId];
      if (st && (cs.conf || st.conferenceId)) {
        await telnyx('POST', `/conferences/${cs.conf || st.conferenceId}/actions/join`, {
          call_control_id: ccid, start_conference_on_enter: true, mute: false,
        });
        st.leadLeg = ccid; st.inbound = true; st.leadId = null;
        st.onCallSince = Date.now(); st.state = 'ON_CALL';
        await setAgentState(agentId, 'ON_CALL');
        sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`, { bridged_at: new Date().toISOString() }).catch(() => {});
        console.log(`[inbound] agent ${agentId.slice(0, 8)} ON_CALL (bridged inbound)`);
      }
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

    // AMD-disabled: a lead simply answering IS the connect signal.
    if (event === 'call.answered' && role === 'lead' && agentId && AMD_MODE === 'disabled') {
      await connectLeadLeg(agentId, ccid, cs, null);
      return;
    }

    // Lead premium AMD -> bridge human, drop machine
    if (event === 'call.machine.premium.detection.ended' && role === 'lead' && agentId) {
      const r = payload.result || '';
      const isHuman = r.startsWith('human') || r === 'silence' || r === 'not_sure';   // TCPA-safe: connect ambiguous
      const st = rt[agentId];
      if (isHuman) {
        await connectLeadLeg(agentId, ccid, cs, r);
      } else {
        if (st && st.pending) delete st.pending[ccid];
        await telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
        if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}`, { status: 'MACHINE' }).catch(() => {});
        console.log(`[bridge] dropped machine leg agent ${agentId.slice(0, 8)} (result=${r})`);
        // agent freed to redial by the ensuing call.hangup handler
      }
      return;
    }

    // Hangups
    if (event === 'call.hangup' && agentId && rt[agentId]) {
      const st = rt[agentId];
      // A ringing/unbridged ratio-dial leg dropped (no-answer, busy, ring timeout,
      // or a dropped machine leg). Clear it; free the agent to redial only when
      // nothing else is in flight and no call has connected.
      if (st.pending && st.pending[ccid]) {
        const info = st.pending[ccid]; delete st.pending[ccid];
        if (ccid) sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
          { ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }).catch(() => {});
        if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
          { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
        const idle = !st.leadLeg && Object.keys(st.pending).length === 0;
        if (idle && st.state === 'DIALING') { st.state = 'AVAILABLE'; await setAgentState(agentId, 'AVAILABLE'); }
        return;
      }
      const wasLead = st.leadLeg === ccid || (role === 'lead' && st.leadLeg == null);
      if (wasLead) {
        const talked = st.state === 'ON_CALL';   // agent actually spoke to a human
        if (ccid) sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
          { ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }).catch(() => {});
        const wasInbound = st.inbound === true;
        st.leadLeg = null; st.leadNumber = null; st.fromNumber = null; st.onCallSince = null;
        if (wasInbound) {
          // Inbound calls have no lead to disposition — return straight to AVAILABLE.
          st.inbound = false; st.leadId = null;
          if (ccid) sbUpdate('calls', `telnyx_call_control_id=eq.${ccid}`,
            { ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }).catch(() => {});
          if (st.state !== 'OFFLINE') { st.state = 'AVAILABLE'; await setAgentState(agentId, 'AVAILABLE'); }
          console.log(`[bridge] inbound ended, agent ${agentId.slice(0, 8)} AVAILABLE`);
        } else if (talked) {
          // Automated wrap-up: hold WRAP_UP with a 3s auto-return; keep leadId so
          // /api/agent/context + /disposition resolve the right lead. A positive
          // disposition (appointment/sale/lead) extends the window to 3 minutes.
          if (st.state !== 'OFFLINE') { st.state = 'WRAP_UP'; await setAgentState(agentId, 'WRAP_UP'); scheduleWrapReturn(agentId, WRAP_SHORT_SEC); }
          console.log(`[bridge] call ended (talked), agent ${agentId.slice(0, 8)} WRAP_UP (${WRAP_SHORT_SEC}s)`);
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
    const staleLegMs = (DIALER.ring_secs + 45) * 1000;
    for (const id of Object.keys(rt)) {
      const st = rt[id];
      if (!st) continue;
      // Sweep stale ringing legs whose hangup webhook never arrived.
      if (st.pending) {
        for (const cc of Object.keys(st.pending)) {
          if (now - (st.pending[cc].at || 0) > staleLegMs) {
            telnyx('POST', `/calls/${cc}/actions/hangup`, {}).catch(() => {});
            delete st.pending[cc];
          }
        }
      }
      const inFlight = st.pending ? Object.keys(st.pending).length : 0;
      // A DIALING agent with nothing actually in flight and no connected call ->
      // free it to redial (covers a missed hangup webhook).
      if ((st.state === 'DIALING' || st.state === 'CLAIMING') && !st.leadLeg && inFlight === 0 &&
          st.rtUpdatedAt && (now - st.rtUpdatedAt) > 5000) {
        console.log(`[reaper] agent ${id.slice(0,8)} idle in ${st.state} -> freeing`);
        st.leadNumber = null; st.leadId = null; st.fromNumber = null; st.onCallSince = null;
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
  await loadCallingWindow();
  await loadDialerConfig();
  await loadCallPolicy();
  await loadAiConfig();
  console.log(`[boot] caller pool: ${CALLER_POOL.join(', ') || '(none)'}`);
  console.log(`[boot] calling window: ${CALLING_WINDOW.start_hour}:00–${CALLING_WINDOW.end_hour}:00 lead-local`);
  console.log(`[boot] dialer: ${DIALER.lines_per_agent} line(s)/agent, ${DIALER.ring_secs}s ring`);
  console.log(`[boot] ai caller: ${AI.enabled ? 'ENABLED' : 'off'}, concurrency ${AI.concurrency}, ${AI.campaign_ids.length} campaign(s), assistant ${AI.assistant_id || '(none)'}`);
  setInterval(pacingTick, PACING_MS);
  setInterval(aiPacingTick, PACING_MS);   // AI Cold Caller lane (independent of human agents)
  setInterval(reaperTick, 30 * 1000);
  setInterval(refreshCallerPool, 5 * 60 * 1000);
  setInterval(loadCallingWindow, 5 * 60 * 1000);
  setInterval(loadDialerConfig, 60 * 1000);
  setInterval(loadCallPolicy, 60 * 1000);
  setInterval(loadAiConfig, 60 * 1000);
  sweepExpiredDnc();
  setInterval(sweepExpiredDnc, 10 * 60 * 1000);   // auto-remove expired (e.g. 90-day) DNC entries
});
