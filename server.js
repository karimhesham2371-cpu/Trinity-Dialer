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
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { deriveFromAreaCode } = require('./lib/areacodes');

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
// AMD_MODE:
//   'greet_first' (default) — greet the instant the line is answered, keep premium
//        AMD running in the background; if AMD later says "machine" the call is
//        dropped a few seconds in. Zero human-lead loss (no 5-6s AMD gate before
//        the bot speaks), tiny cost of a few seconds of assistant on voicemails.
//   'premium'    — wait for premium AMD to confirm human before greeting (no
//        assistant cost on voicemails, but ~5-6s of dead air → owners hang up).
//   'disabled'   — greet on answer, no AMD at all (assistant fully engages VMs).
const AMD_MODE           = env('AMD_MODE', 'greet_first');
const SB_HOST            = env('SUPABASE_HOST');
const SB_KEY             = env('SUPABASE_KEY');
const DEFAULT_FROM       = env('DEFAULT_FROM', '+19168850241');
const JWT_SECRET         = env('JWT_SECRET', 'trinity-dev-secret-change-me');
const PACING_MS          = Number(process.env.PACING_MS || 3000);
// Public hostname used to build the wss:// URL Telnyx forks live AI-call audio to.
// Render injects RENDER_EXTERNAL_HOSTNAME automatically; override with PUBLIC_HOST if needed.
const PUBLIC_HOST        = env('PUBLIC_HOST', process.env.RENDER_EXTERNAL_HOSTNAME || '');
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
  // AMD-accuracy ground truth: the agent bridged in, but it was actually a
  // machine/voicemail AMD failed to catch (a false negative). Recorded so the
  // amd-stats disagreement report can score real-world miss rate against labels.
  { code: 'AMD_MISS',       label: 'Voicemail reached me (AMD miss)', color: '#6e40c9', hotkey: '8', recycle: 'no_answer' },
  // System-written (agent_id null) when the predictive engine kills a leg AMD
  // classified as a machine — never surfaced as an agent hotkey, but present so
  // the accuracy cross-check and per-campaign reports can count machine kills.
  { code: 'AUTO_ANSWERING_MACHINE', label: 'Answering machine (auto)', color: '#57606a', recycle: 'no_answer' },
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

// Live per-playlist call stats (ReadyMode-style wallboard). Accumulated since
// process start (or last manual reset). Keyed by playlist id; the pseudo-key
// '__direct__' collects legacy campaign_agents dials that have no playlist.
//   calls = dials initiated · ans = bridged to a human · md = machine-detected
//   drop  = answered-but-no-free-agent (abandoned). Live "Dial" is derived from
//   rt[*].pending at request time, not stored here.
let PLAYLIST_STATS = {};
let PLAYLIST_STATS_SINCE = Date.now();
function plStat(pid) {
  const k = pid || '__direct__';
  return PLAYLIST_STATS[k] || (PLAYLIST_STATS[k] = { calls: 0, ans: 0, md: 0, drop: 0 });
}

// Discovered outbound caller-ID pool (refreshed from Telnyx).
let CALLER_POOL = CALLER_IDS_ENV.slice();

// Per-state lead-local calling window (ReadyMode-style compliance). Each US state
// maps to its own timezone; the admin can disable a state entirely or override its
// start/end time, else it inherits the queue-default window. Cached from
// app_settings key "calling_window". In-memory shape:
//   { default:{start,end}, states:{ AB:{enabled,start,end}, ... } }
// where start/end are minutes-since-local-midnight (0..1439); a null state
// start/end inherits the default. Evaluated in each state's own tz via localMinutes.
const { STATES, STATE_BY_ABBR, DEFAULT_WINDOW, FALLBACK_TZ: CW_FALLBACK_TZ, localMinutes, toMinutes } = require('./lib/callingwindow');
let CALLING = { default: { ...DEFAULT_WINDOW }, states: {} };
async function loadCallingWindow() {
  if (!SB_HOST) return;
  try {
    const rows = await sbSelect('app_settings', `key=eq.calling_window&select=value`);
    CALLING = normalizeCallingCfg(rows && rows[0] && rows[0].value);
  } catch (e) { console.error('[callingWindow]', e.message); }
}
// Build the in-memory config from stored JSON, tolerating the legacy
// {start_hour,end_hour} global shape and any missing/partial data.
function normalizeCallingCfg(v) {
  const cfg = { default: { ...DEFAULT_WINDOW }, states: {} };
  if (v && typeof v === 'object') {
    // Legacy global shape → default window (hours → minutes).
    if (v.start_hour != null || v.end_hour != null) {
      const s = toMinutes((v.start_hour ?? 10) * 60);
      const e = toMinutes(Math.min(1439, (v.end_hour ?? 21) * 60));
      if (s != null) cfg.default.start = s;
      if (e != null) cfg.default.end = e;
    }
    if (v.default && typeof v.default === 'object') {
      const s = toMinutes(v.default.start), e = toMinutes(v.default.end);
      if (s != null) cfg.default.start = s;
      if (e != null) cfg.default.end = e;
    }
    if (v.states && typeof v.states === 'object') {
      for (const st of STATES) {
        const row = v.states[st.abbr];
        if (!row || typeof row !== 'object') continue;
        cfg.states[st.abbr] = {
          enabled: row.enabled !== false,   // default enabled
          start: toMinutes(row.start),       // null = inherit default
          end: toMinutes(row.end),
        };
      }
    }
  }
  return cfg;
}
// Which US state (2-letter) governs this lead's calling window? Prefer the
// area-code-derived state (matches import logic); fall back to an explicit
// 2-letter lead.state; else null (unknown → default window in the fallback tz).
function stateOfLead(lead) {
  const d = deriveFromAreaCode(areaCodeOf(lead && lead.phone));
  if (d && d.state && STATE_BY_ABBR[d.state]) return d.state;
  const raw = String((lead && lead.state) || '').trim().toUpperCase();
  if (STATE_BY_ABBR[raw]) return raw;
  return null;
}
// May we dial this lead RIGHT NOW? Evaluated in the lead's state timezone.
// A disabled state is never dialable. Fail-open only when Intl can't resolve the
// zone (localMinutes null), matching the old inCallingWindow behaviour.
function callableNow(lead) {
  const abbr = stateOfLead(lead);
  const meta = abbr ? STATE_BY_ABBR[abbr] : null;
  const cfg = abbr ? CALLING.states[abbr] : null;
  if (cfg && cfg.enabled === false) return false;
  const start = (cfg && cfg.start != null) ? cfg.start : CALLING.default.start;
  const end   = (cfg && cfg.end   != null) ? cfg.end   : CALLING.default.end;
  const tz = meta ? meta.tz : (((lead && lead.timezone)) || CW_FALLBACK_TZ);
  const m = localMinutes(tz);
  if (m == null) return true;
  return m >= start && m < end;
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

// ── Answering Machine Detection (AMD) ────────────────────────────────────────
// Every event_type string, parameter name and result value below is taken
// VERBATIM from the Telnyx Call Control v2 docs (voice/answering-machine-
// detection). Classification keys off those exact strings — never invent new
// result values.
//   answering_machine_detection : premium | detect | detect_beep | disabled
//   answering_machine_detection_config :
//       { total_analysis_time_millis, greeting_duration_millis, prompt_end_timeout_millis }
//   call.machine.premium.detection.ended  result:
//       human_residence | human_business | machine | silence | fax_detected | not_sure
//   call.machine.detection.ended (standard) result: human | machine | not_sure
//   call.machine.premium.greeting.ended  result: beep_detected | no_beep_detected | prompt_ended
//   call.machine.greeting.ended (standard) result: ended | beep_detected | not_sure
const AMD_MODES            = ['premium', 'detect', 'detect_beep', 'disabled'];
const AMD_DETECTION_EVENTS = new Set(['call.machine.premium.detection.ended', 'call.machine.detection.ended']);
const AMD_GREETING_EVENTS  = new Set(['call.machine.premium.greeting.ended', 'call.machine.greeting.ended']);
const AMD_HUMAN_RESULTS    = new Set(['human', 'human_residence', 'human_business']);
const AMD_MACHINE_RESULTS  = new Set(['machine', 'fax_detected']);
// silence / not_sure (and anything unrecognised) are AMBIGUOUS — routed by the
// campaign's silence_policy, which defaults to 'human' so we never hang up on a
// real person by default.
function amdClass(result) {
  if (AMD_HUMAN_RESULTS.has(result)) return 'human';
  if (AMD_MACHINE_RESULTS.has(result)) return 'machine';
  return 'ambiguous';
}
// Only the config sub-fields Telnyx documents; drop anything else so a bad
// campaign config can't inject unknown params into the Dial command.
function amdConfigParam(config) {
  if (!config || typeof config !== 'object') return null;
  const out = {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);
  if (config.total_analysis_time_millis != null) out.total_analysis_time_millis = n(config.total_analysis_time_millis);
  if (config.greeting_duration_millis   != null) out.greeting_duration_millis   = n(config.greeting_duration_millis);
  if (config.prompt_end_timeout_millis  != null) out.prompt_end_timeout_millis  = n(config.prompt_end_timeout_millis);
  return Object.keys(out).length ? out : null;
}
// Per-campaign AMD config, short-TTL cached (dialLead runs hot). select=* keeps
// this working before AND after scripts/amd_schema.sql is applied.
const _campAmdCache = new Map();   // campaignId -> { at, cfg }
const CAMP_AMD_TTL_MS = 15000;
async function campaignAmd(campaignId) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const fallback = {
    mode: AMD_MODE === 'disabled' ? 'disabled' : 'premium',
    config: null, vmDrop: false, vmUrl: null, vmConsent: false,
    silencePolicy: 'human', gatedBridge: false,
    // Predictive-pacing defaults (see scripts/predictive_schema.sql).
    pacingMode: 'power', dialRatio: 2.0, dialRatioMin: 1.0, dialRatioMax: 3.0,
    abandonSoft: 0.025, safeHarborUrl: null,
  };
  if (!campaignId) return fallback;
  const hit = _campAmdCache.get(campaignId);
  if (hit && Date.now() - hit.at < CAMP_AMD_TTL_MS) return hit.cfg;
  let row = null;
  try { const rows = await sbSelect('campaigns', `id=eq.${campaignId}&select=*`); row = rows && rows[0]; }
  catch { /* keep defaults */ }
  const cfg = row ? {
    mode: AMD_MODES.includes(row.amd_mode) ? row.amd_mode : 'premium',
    config: (row.amd_config && typeof row.amd_config === 'object') ? row.amd_config : null,
    vmDrop: !!row.vm_drop_enabled,
    vmUrl: row.vm_drop_url || null,
    vmConsent: !!row.vm_drop_consent,
    silencePolicy: row.silence_policy === 'machine' ? 'machine' : 'human',
    gatedBridge: !!(row.amd_config && typeof row.amd_config === 'object' && row.amd_config.gated_bridge),
    pacingMode: row.pacing_mode === 'predictive' ? 'predictive' : 'power',
    dialRatio: num(row.dial_ratio, 2.0),
    dialRatioMin: num(row.dial_ratio_min, 1.0),
    dialRatioMax: num(row.dial_ratio_max, 3.0),
    abandonSoft: num(row.abandon_soft_threshold, 0.025),
    safeHarborUrl: row.safe_harbor_url || null,
  } : fallback;
  _campAmdCache.set(campaignId, { at: Date.now(), cfg });
  return cfg;
}
// One row per AMD webhook. Best-effort (table ships in scripts/amd_schema.sql);
// never retried so a missing table can't spam the durable outbox.
function amdEvent(row) { sbReq('POST', 'amd_events', row, 'return=minimal').catch(() => {}); }
// Rolling per-campaign abandoned-rate guardrail (FCC: <=3% per campaign per 30
// days). Recomputed lazily from the calls table and cached; pacing reads it to
// throttle the dial ratio before the cap is hit.
const AMD_ABANDON_CAP = 0.03, AMD_ABANDON_THROTTLE = 0.025;
const _abandonCache = new Map();   // campaignId -> { at, rate }
const ABANDON_TTL_MS = 5 * 60 * 1000;
async function campaignAbandonRate(campaignId) {
  if (!campaignId) return 0;
  const hit = _abandonCache.get(campaignId);
  if (hit && Date.now() - hit.at < ABANDON_TTL_MS) return hit.rate;
  let rate = 0;
  try {
    // FCC formula: abandoned ÷ (abandoned + answered by a LIVE person). bridged_at
    // is only set when an agent was actually connected, so machines/voicemails are
    // excluded from the denominator — they'd otherwise dilute the rate and let the
    // pacer keep dialing past the real cap.
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const bridged   = await sbCount('calls', `campaign_id=eq.${campaignId}&bridged_at=not.is.null&created_at=gte.${since}`);
    const abandoned = await sbCount('calls', `campaign_id=eq.${campaignId}&abandoned=is.true&created_at=gte.${since}`);
    rate = (abandoned + bridged) > 0 ? abandoned / (abandoned + bridged) : 0;
  } catch { rate = 0; }
  _abandonCache.set(campaignId, { at: Date.now(), rate });
  return rate;
}
// Nightly AMD cross-check: over the last 24h, compare AMD's verbatim result to
// the agent's own disposition (ground truth) and log a per-campaign miss report.
// Writes a compact audit_log row so the accuracy trend is queryable over time.
// Runs from the boot scheduler; best-effort and never throws into the loop.
async function amdNightlyCrossCheck() {
  if (!SB_HOST) return;
  try {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const calls = await sbSelect('calls',
      `answered_at=gte.${encodeURIComponent(since)}&select=telnyx_call_control_id,campaign_id,amd_mode,amd_result,amd_latency_ms,abandoned&limit=200000`).catch(() => []);
    if (!calls || !calls.length) return;
    const ccids = calls.filter(c => c.telnyx_call_control_id).map(c => `"${c.telnyx_call_control_id}"`);
    const disps = ccids.length
      ? await sbSelect('dispositions', `telnyx_call_control_id=in.(${ccids.join(',')})&select=telnyx_call_control_id,code&limit=200000`).catch(() => [])
      : [];
    const dispBy = {};
    for (const d of disps || []) if (d.telnyx_call_control_id) dispBy[d.telnyx_call_control_id] = d.code;
    const LIVE = new Set(['SALE', 'APPT', 'APPOINTMENT', 'LEAD', 'CB', 'CALLBACK', 'NI', 'NOT_INTERESTED', 'DNC', 'XFER', 'TRANSFER']);
    const VM   = new Set(['VM', 'VOICEMAIL', 'MACHINE', 'AMD_MISS', 'AUTO_ANSWERING_MACHINE']);
    const pctl = (xs, q) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };
    const agg = {};   // campaign_id -> counts
    for (const c of calls) {
      const a = agg[c.campaign_id] || (agg[c.campaign_id] = { answered: 0, fp: 0, fn: 0, abandoned: 0, machine: 0, human: 0, lat: [] });
      a.answered++; if (c.abandoned) a.abandoned++;
      if (c.amd_result) {
        const cls = amdClass(c.amd_result);
        if (cls === 'machine') a.machine++;
        if (cls === 'human') a.human++;
      }
      if (Number.isFinite(c.amd_latency_ms)) a.lat.push(c.amd_latency_ms);
      const code = c.telnyx_call_control_id ? dispBy[c.telnyx_call_control_id] : null;
      if (code && c.amd_result) {
        const cls = amdClass(c.amd_result);
        if (cls === 'machine' && LIVE.has(code)) a.fp++;
        if (cls === 'human'   && VM.has(code))   a.fn++;
      }
    }
    for (const [cid, a] of Object.entries(agg)) {
      const rate = a.answered ? a.abandoned / a.answered : 0;
      const machineKillRate = a.answered ? a.machine / a.answered : 0;
      const fnRate = a.human ? a.fn / a.human : 0;   // false negatives per confirmed-human detection
      const p50 = pctl(a.lat, 0.5), p95 = pctl(a.lat, 0.95);
      // Latest auto-adjusted dial_ratio for this campaign (pacing history).
      let dialRatio = null;
      try {
        const [pe] = await sbSelect('pacing_events', `campaign_id=eq.${cid}&order=created_at.desc&select=dial_ratio&limit=1`).catch(() => []);
        if (pe && Number.isFinite(pe.dial_ratio)) dialRatio = pe.dial_ratio;
      } catch { /* best effort */ }
      console.log(`[amd-nightly] campaign ${String(cid).slice(0, 8)} 24h: answered=${a.answered} machine_kill=${(machineKillRate * 100).toFixed(1)}% false_pos=${a.fp} false_neg=${a.fn} (${(fnRate * 100).toFixed(1)}%) abandoned=${a.abandoned} (${(rate * 100).toFixed(2)}%) lat_p50=${p50 ?? '-'}ms lat_p95=${p95 ?? '-'}ms ratio=${dialRatio ?? '-'}`);
      audit(null, 'amd_cross_check', { target_type: 'campaign', target_id: cid,
        meta: { window: '24h', answered: a.answered, false_positive: a.fp, false_negative: a.fn,
          false_negative_rate: Math.round(fnRate * 1000) / 1000,
          machine_kills: a.machine, machine_kill_rate: Math.round(machineKillRate * 1000) / 1000,
          amd_latency_p50_ms: p50, amd_latency_p95_ms: p95, dial_ratio: dialRatio,
          abandoned: a.abandoned, abandoned_rate: Math.round(rate * 1000) / 1000, over_cap: rate > AMD_ABANDON_CAP } });
    }
  } catch (e) { console.error('[amd-nightly]', e.message); }
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
let AI = { enabled: false, concurrency: 5, assistant_id: '', voice: '', transfer_agent_ids: [], campaign_ids: [], did_numbers: [] };
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
      did_numbers: Array.isArray(v.did_numbers) ? v.did_numbers.map(String) : [],
    };
  } catch (e) { console.error('[aiConfig]', e.message); }
}
// In-flight AI calls, keyed by Telnyx call_control_id. This is the AI lane's
// entire runtime — it has NO conference and NO human agent seat. Each entry:
//   { leadId, leadNumber, fromNumber, campaignId, name, address, phase, at }
//   phase: 'dialing' (ringing / pre-answer) | 'assistant' (assistant attached).
// The size of this map is the live spend; AI.concurrency is the hard ceiling.
const aiRt = {};

// ── Live AI-call audio monitoring ────────────────────────────────────────────────
// aiStreams: ccid -> { listeners:Set<ws browser>, telnyxWs, starting }. On the first
// admin listener we ask Telnyx to fork the call's audio (both legs) to /telnyx-media
// as a WebSocket; each media frame is relayed to the listeners, who decode + play it
// in the browser. On the last listener leaving (or call hangup) we stop the fork so
// media streaming only costs money while someone is actually listening.
const aiStreams = new Map();
// Signed per-call key so only Telnyx (using the URL we handed it) can push audio.
function streamKey(ccid) {
  return crypto.createHmac('sha256', JWT_SECRET).update('aistream:' + ccid).digest('hex').slice(0, 24);
}
async function startAiStream(ccid) {
  if (!PUBLIC_HOST) throw new Error('PUBLIC_HOST not set — cannot build media stream URL');
  const url = `wss://${PUBLIC_HOST}/telnyx-media?ccid=${encodeURIComponent(ccid)}&k=${streamKey(ccid)}`;
  await telnyx('POST', `/calls/${ccid}/actions/streaming_start`,
    { stream_url: url, stream_track: 'both_tracks' });
  console.log(`[ai-listen] fork started ${ccid.slice(-8)}`);
}
// Listener-initiated stop: call is still live, so tell Telnyx to stop forking.
async function stopAiStream(ccid) {
  const st = aiStreams.get(ccid);
  aiStreams.delete(ccid);
  if (st && st.telnyxWs) { try { st.telnyxWs.close(); } catch {} }
  try { await telnyx('POST', `/calls/${ccid}/actions/streaming_stop`, {}); } catch {}
  console.log(`[ai-listen] fork stopped ${ccid.slice(-8)}`);
}
// Call ended: notify + close listeners; the fork dies with the call.
function endAiStream(ccid) {
  const st = aiStreams.get(ccid);
  if (!st) return;
  aiStreams.delete(ccid);
  for (const l of st.listeners) { try { l.send(JSON.stringify({ event: 'ended' })); l.close(); } catch {} }
  if (st.telnyxWs) { try { st.telnyxWs.close(); } catch {} }
}

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

// ── Durable writes (at-least-once) ───────────────────────────────────────────────
// Call/event/disposition writes are the product's memory — losing one to a transient
// Supabase blip is unacceptable. sbWrite() tries inline, and on failure parks the
// request in an in-memory outbox that a background flusher retries with backoff for
// up to ~6h. Combined with the nightly Telnyx reconciliation, no call is silently
// dropped. The outbox is bounded so a prolonged outage can't exhaust memory.
const writeOutbox = [];
const OUTBOX_MAX = 5000;
let outboxDropped = 0;
function queueWrite(w) {
  if (writeOutbox.length >= OUTBOX_MAX) { writeOutbox.shift(); outboxDropped++; }
  writeOutbox.push(w);
}
async function sbWrite(method, pathQ, body, prefer, desc) {
  if (!SB_HOST || !SB_KEY) return null;
  try { return await sbReq(method, pathQ, body, prefer); }
  catch (e) {
    console.error(`[sbWrite:${desc || pathQ}]`, e.message);
    queueWrite({ method, pathQ, body, prefer, desc: desc || pathQ, tries: 0, at: Date.now() });
    return null;
  }
}
async function flushOutbox() {
  if (!writeOutbox.length || !SB_HOST) return;
  const batch = writeOutbox.splice(0, 50);
  for (const w of batch) {
    try { await sbReq(w.method, w.pathQ, w.body, w.prefer); }
    catch (e) {
      w.tries++; w.lastErr = e.message;
      const tooOld = (Date.now() - w.at) > 6 * 3600 * 1000;
      if (w.tries < 30 && !tooOld) queueWrite(w);
      else { outboxDropped++; console.error(`[outbox:drop:${w.desc}] after ${w.tries} tries: ${e.message}`); }
    }
  }
}
// Upsert a calls row keyed on the Telnyx call_control_id (unique). Order-independent:
// whichever event arrives first creates the row, later events merge onto it — so a
// missed call.initiated can't strand every subsequent update. Always durable.
function saveCall(patch, desc) {
  if (!patch || !patch.telnyx_call_control_id) return;
  sbWrite('POST', 'calls?on_conflict=telnyx_call_control_id', patch,
    'resolution=merge-duplicates,return=minimal', desc || 'calls');
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

// ── Durable recording archive ────────────────────────────────────────────────
// Telnyx's public recording URLs are presigned S3 links that expire after 10 min
// (X-Amz-Expires=600) — so any URL we store is dead ~10 min after the call, which
// is the root cause of "0:00 / unplayable" recordings. Fix: copy the audio ONCE
// into Supabase Storage (bucket 'recordings') and serve from there forever. The
// calls.recording_url is rewritten to the marker `sb:recordings/<id>.mp3`, which
// the /stream proxy expands to a Supabase object fetch. Telnyx retains the source
// audio for its retention window and hands out a fresh URL via GET /recordings/{id},
// so even calls whose stored URL already expired can still be recovered.
const REC_BUCKET = 'recordings';
const isArchived = (u) => typeof u === 'string' && u.startsWith('sb:');
async function archiveRecording(recId, sourceUrl) {
  if (!recId) throw new Error('no recording_id');
  // Pull a FRESH download URL from Telnyx (the webhook's URL may already be minutes
  // old); fall back to whatever URL we were handed.
  let url = sourceUrl || null;
  try {
    const meta = await telnyx('GET', `/recordings/${recId}`);
    const d = meta && meta.data;
    url = (d && d.download_urls && (d.download_urls.mp3 || d.download_urls.wav)) || url;
  } catch { /* keep sourceUrl */ }
  if (!url) throw new Error('no source url');
  const isTelnyxApi = /api\.telnyx\.com/i.test(url);
  const dl = await fetch(url, { headers: isTelnyxApi ? { Authorization: `Bearer ${TELNYX_KEY}` } : {} });
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (!buf.length) throw new Error('empty download');
  const path = `${recId}.mp3`;
  const up = await fetch(`https://${SB_HOST}/storage/v1/object/${REC_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' },
    body: buf,
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 120)}`);
  return { marker: `sb:${REC_BUCKET}/${path}`, bytes: buf.length };
}
// Archive one call's recording and persist the durable marker onto its row.
async function archiveCallRecording(ccidOrId, recId, sourceUrl, byId) {
  const r = await archiveRecording(recId, sourceUrl);
  const q = byId ? `id=eq.${ccidOrId}` : `telnyx_call_control_id=eq.${ccidOrId}`;
  await sbUpdate('calls', q, { recording_url: r.marker }).catch(e => console.error('[rec-archive:update]', e.message));
  return r;
}
// Safety-net sweep: find recorded calls whose URL isn't archived yet (archive failed,
// lagged, or predates this feature) and pull them into Supabase Storage. Idempotent.
let recSweepBusy = false;
async function reconcileRecordings() {
  if (recSweepBusy || !SB_HOST || !SB_KEY || !TELNYX_KEY) return;
  recSweepBusy = true;
  try {
    const rows = await sbSelect('calls',
      'recording_id=not.is.null&select=id,recording_id,recording_url&order=created_at.desc&limit=300');
    const pending = rows.filter(r => r.recording_id && !isArchived(r.recording_url)).slice(0, 12);
    for (const r of pending) {
      try {
        const { bytes } = await archiveCallRecording(r.id, r.recording_id, r.recording_url, true);
        console.log(`[rec-sweep] archived ${r.recording_id} (${bytes}B)`);
      } catch (e) { console.error(`[rec-sweep] ${r.recording_id}: ${e.message}`); }
    }
  } catch (e) { console.error('[rec-sweep]', e.message); }
  finally { recSweepBusy = false; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const dec = (b64) => { if (!b64) return null; try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; } };

function signToken(a) {
  return jwt.sign(
    { id: a.id, role: a.role, name: a.name, email: a.email, permissions: normPerms(a.permissions) },
    JWT_SECRET, { expiresIn: '12h' });
}

// ── Role tiers & granular support permissions ────────────────────────────────
// Three tiers: admin (everything), support (only the capabilities an admin
// grants — enforced per-request), agent (softphone only). The registry below is
// the single source of truth; the admin UI renders a checkbox per entry, so
// adding a new grantable capability is a one-line change here + a permForPath
// mapping. Keep keys stable (they're persisted on the user row).
const PERMISSIONS = [
  { key: 'reports.call_logs',        label: 'Call logs',        area: 'reports', hint: 'View the call log (listen to recordings).' },
  { key: 'reports.call_logs_export', label: 'Export call logs', area: 'reports', hint: 'Download the call log as CSV. Separate from viewing, to limit data egress.' },
  { key: 'reports.office_map',       label: 'Office map',       area: 'reports', hint: 'Live floor — each agent\'s seat and status.' },
  { key: 'reports.research',         label: 'Research calls',   area: 'reports', hint: 'Look up a call by phone number.' },
  { key: 'reports.agent_report',     label: 'Agent report',     area: 'reports', hint: 'Per-agent logged-in / talk / wrap time.' },
  { key: 'reports.wallboard',        label: 'Wallboard',        area: 'reports', hint: 'Live team dashboard — dials, contact rate, sales, per-agent status.' },
  { key: 'reports.qa',               label: 'Recording QA',     area: 'reports', hint: 'Flag / score / annotate recordings for quality review (inside Call logs).' },
  { key: 'floor.monitor',            label: 'Live monitor',     area: 'reports', hint: 'Listen in on an agent\'s live call from the office map (needs Office map).' },
  { key: 'floor.kick',               label: 'Kick agent',       area: 'reports', hint: 'Force an agent off the dialer from the office map (needs Office map).' },
];
const PERM_KEYS = new Set(PERMISSIONS.map(p => p.key));
const normPerms = (v) => (Array.isArray(v) ? v.filter(k => PERM_KEYS.has(k)) : []);

// Live permission cache (userId -> { role, perms:Set }). Authoritative for
// access checks so an admin's grant/revoke takes effect on the support user's
// very next request — no need to wait out their 12h session token.
const permCache = new Map();
function cacheUser(u) {
  if (u && u.id) permCache.set(u.id, { role: u.role, perms: new Set(normPerms(u.permissions)) });
}
async function loadPermCache() {
  try {
    const rows = await sbSelect('agents', 'select=id,role,permissions');
    permCache.clear();
    for (const u of rows) cacheUser(u);
    console.log(`[perms] cached ${permCache.size} users`);
  } catch (e) { console.error('[perms] cache load failed:', e.message); }
}
// Does this user hold (any of) the required permission key(s)?
function userCan(user, need) {
  if (!user) return false;
  const c = permCache.get(user.id);
  const role = c ? c.role : user.role;
  if (role === 'admin') return true;
  if (role !== 'support') return false;
  const perms = c ? c.perms : new Set(normPerms(user.permissions));
  const needs = Array.isArray(need) ? need : [need];
  return needs.some(k => perms.has(k));
}
// Map an admin API request to the permission(s) that unlock it for a support
// user. null = admin-only (no support grant exists for that path). Most-specific
// paths first (…/calls/export must beat …/calls). Read-only list endpoints the
// report filters depend on are opened to any support user with a report grant.
function permForPath(path, method) {
  if (path.startsWith('/api/admin/reports/calls/export')) return 'reports.call_logs_export';
  if (/^\/api\/admin\/reports\/calls\/[^/]+\/qa$/.test(path)) return 'reports.qa';
  if (path.startsWith('/api/admin/reports/calls'))        return 'reports.call_logs';
  if (path.startsWith('/api/admin/reports/agent'))        return 'reports.agent_report';
  if (path.startsWith('/api/admin/reports/wallboard'))    return 'reports.wallboard';
  if (path.startsWith('/api/admin/reports/research'))     return 'reports.research';
  if (path.startsWith('/api/admin/reports/recording'))    return ['reports.call_logs', 'reports.research'];
  if (path === '/api/admin/floor/kick')                   return 'floor.kick';
  if (path === '/api/admin/floor/monitor')                return 'floor.monitor';
  if (path.startsWith('/api/admin/floor'))                return 'reports.office_map';
  if (path === '/api/admin/permissions')                  return PERMISSIONS.map(p => p.key); // any grant
  if (method === 'GET' && (path === '/api/admin/users' || path === '/api/admin/campaigns'))
    return PERMISSIONS.map(p => p.key); // agent/campaign name lookups for report filters
  return null;
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
// Guards every /api/admin/* route. Admins pass unconditionally; support users
// pass only on paths mapped to a permission they hold; everyone else is denied.
function adminOnly(req, res, next) {
  if (!req.user) return res.sendStatus(403);
  const c = permCache.get(req.user.id);
  const role = c ? c.role : req.user.role;
  if (role === 'admin') return next();
  if (role === 'support') {
    const need = permForPath(req.path, req.method);
    if (need && userCan(req.user, need)) return next();
  }
  return res.sendStatus(403);
}
// Strict admin gate for escalation-sensitive writes (creating/editing users).
// Never satisfiable by a support permission, so support can't grant itself power.
function adminRoleOnly(req, res, next) {
  const c = permCache.get(req.user && req.user.id);
  const role = c ? c.role : (req.user && req.user.role);
  return role === 'admin' ? next() : res.sendStatus(403);
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
function pickCallerId(preferredAreaCode, allow) {
  // Optional allowlist (AI lane can be restricted to a chosen subset of DIDs).
  // Fall back to the full pool if the allowlist matches nothing usable.
  let base = (Array.isArray(allow) && allow.length) ? CALLER_POOL.filter(n => allow.includes(n)) : CALLER_POOL;
  if (!base.length) base = CALLER_POOL;
  const inUse = new Set(Object.values(rt).map(s => s.fromNumber).filter(Boolean));
  let candidates = base.filter(n => !inUse.has(n));
  if (!candidates.length) candidates = base.slice();
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
// Admins + support users (the latter for the live office map) see the floor feed.
function wsToAdmins(obj) { for (const c of wsClients) if (c.role === 'admin' || c.role === 'support') wsSend(c.ws, obj); }
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
    cacheUser(a);   // keep the live permission cache fresh on every login
    audit({ id: a.id, name: a.name, role: a.role }, 'LOGIN', { target_type: 'session' });
    res.json({ token: signToken(a), user: { id: a.id, name: a.name, email: a.email, role: a.role, permissions: normPerms(a.permissions) } });
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
    outbox_depth: writeOutbox.length, outbox_dropped: outboxDropped,
    uptime_sec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

// ══ ADMIN: users ════════════════════════════════════════════════════════════════
// The permission registry drives the support-role checkbox UI. Admin-managed only.
app.get('/api/admin/permissions', auth, adminOnly, adminRoleOnly, (_req, res) => {
  res.json({ permissions: PERMISSIONS });
});

app.get('/api/admin/users', auth, adminOnly, async (_req, res) => {
  try {
    const rows = await sbSelect('agents', 'select=id,name,email,role,active,state,telnyx_credential_id,campaign_id,permissions&order=created_at.asc');
    // Overlay the live in-memory runtime state; the DB `state` column is only a
    // creation-time seed and is never persisted per state change.
    const users = rows.map(u => ({ ...u, state: (rt[u.id] && rt[u.id].state) || 'OFFLINE' }));
    res.json({ users });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users', auth, adminOnly, adminRoleOnly, async (req, res) => {
  const { name, email, password, role: rawRole, permissions } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const role = ['admin', 'support', 'agent'].includes(rawRole) ? rawRole : 'agent';
  const perms = role === 'support' ? normPerms(permissions) : [];
  try {
    const existing = await sbSelect('agents', `email=eq.${encodeURIComponent(email)}&select=id`);
    if (existing.length) return res.status(409).json({ error: 'email already exists' });

    // Only agents take calls, so only agents get a Telnyx WebRTC credential.
    let credId = null, sip = null;
    if (role === 'agent' && TELNYX_KEY) {
      const cred = await telnyx('POST', '/telephony_credentials', {
        connection_id: CRED_CONNECTION_ID, name: `trinity-${String(email).replace(/[^a-z0-9]/gi, '')}`,
      });
      credId = cred.data && cred.data.id;
      sip    = cred.data && cred.data.sip_username;
    }
    const hash = await bcrypt.hash(password, 10);
    const [row] = await sbInsert('agents', {
      name, email: String(email).trim(), password_hash: hash, role,
      telnyx_credential_id: credId, sip_username: sip, active: true, state: 'OFFLINE',
      permissions: perms,
    });
    cacheUser({ ...row, permissions: perms });
    audit(req.user, 'ADD_AGENT', { target_type: 'agent', target_id: row.id, meta: { name: row.name, email: row.email, role, permissions: perms } });
    res.json({ ok: true, user: { id: row.id, name: row.name, email: row.email, role, sip_username: sip } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.patch('/api/admin/users/:id', auth, adminOnly, adminRoleOnly, async (req, res) => {
  const patch = {};
  const { name, email, password, active, role, permissions } = req.body || {};
  if (name != null) patch.name = name;
  if (email != null && String(email).trim()) {
    const other = await sbSelect('agents',
      `email=eq.${encodeURIComponent(String(email).trim())}&id=neq.${req.params.id}&select=id`);
    if (other.length) return res.status(409).json({ error: 'email already in use' });
    patch.email = String(email).trim();
  }
  if (active != null) patch.active = !!active;
  let newRole = null;
  if (role != null) {
    newRole = ['admin', 'support', 'agent'].includes(role) ? role : 'agent';
    patch.role = newRole;
    // A non-support user holds no permissions; clear them on role change.
    if (newRole !== 'support') patch.permissions = [];
  }
  // Permission edits apply when the (resulting) role is support.
  if (permissions != null) {
    const effectiveRole = newRole || null;
    if (effectiveRole === 'support' || effectiveRole == null) patch.permissions = normPerms(permissions);
  }
  if (password) patch.password_hash = await bcrypt.hash(password, 10);
  try {
    await sbUpdate('agents', `id=eq.${req.params.id}`, patch);
    // Refresh the live permission cache so revocation/grant is immediate.
    const [fresh] = await sbSelect('agents', `id=eq.${req.params.id}&select=id,role,permissions`);
    if (fresh) cacheUser(fresh);
    const meta = { ...patch }; delete meta.password_hash;
    if (password) meta.password = 'reset';
    audit(req.user, 'UPDATE_AGENT', { target_type: 'agent', target_id: req.params.id, meta });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, adminRoleOnly, async (req, res) => {
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
    permCache.delete(id);
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

// Edit campaign config. Whitelisted fields only. Admin-only (permForPath returns
// null for PATCH here, so a support user falls through adminOnly to 403).
app.patch('/api/admin/campaigns/:id', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.name != null && String(b.name).trim()) patch.name = String(b.name).trim();
  if (b.script != null) patch.script = String(b.script);
  if (b.wrap_seconds != null) patch.wrap_seconds = Math.max(0, Math.min(60, parseInt(b.wrap_seconds, 10) || 0));
  if (b.dial_ratio != null) patch.dial_ratio = Math.max(1, Math.min(4, Number(b.dial_ratio) || 1));
  if (b.amd_mode != null && AMD_MODES.includes(b.amd_mode)) patch.amd_mode = b.amd_mode;
  if (b.record_calls != null) patch.record_calls = !!b.record_calls;
  if (b.local_presence != null) patch.local_presence = !!b.local_presence;
  if (b.vm_drop_enabled != null) patch.vm_drop_enabled = !!b.vm_drop_enabled;
  if (b.vm_drop_url != null) patch.vm_drop_url = String(b.vm_drop_url).trim() || null;
  if (b.vm_drop_consent != null) patch.vm_drop_consent = !!b.vm_drop_consent;
  if (b.silence_policy != null && ['human', 'machine'].includes(b.silence_policy)) patch.silence_policy = b.silence_policy;
  // ── Predictive (background-AMD) pacing config ──────────────────────────────
  if (b.pacing_mode != null && ['power', 'predictive'].includes(b.pacing_mode)) patch.pacing_mode = b.pacing_mode;
  if (b.dial_ratio_min != null) patch.dial_ratio_min = Math.max(1, Math.min(4, Number(b.dial_ratio_min) || 1));
  if (b.dial_ratio_max != null) patch.dial_ratio_max = Math.max(1, Math.min(6, Number(b.dial_ratio_max) || 3));
  if (b.abandon_soft_threshold != null) patch.abandon_soft_threshold = Math.max(0, Math.min(0.03, Number(b.abandon_soft_threshold) || 0.025));
  if (b.safe_harbor_url != null) patch.safe_harbor_url = String(b.safe_harbor_url).trim() || null;
  // amd_config: keep only the documented Telnyx sub-fields + our gated_bridge flag.
  if (b.amd_config != null) {
    if (b.amd_config === false || b.amd_config === '') { patch.amd_config = null; }
    else if (typeof b.amd_config === 'object') {
      const cfg = amdConfigParam(b.amd_config) || {};
      if (b.amd_config.gated_bridge != null) cfg.gated_bridge = !!b.amd_config.gated_bridge;
      patch.amd_config = Object.keys(cfg).length ? cfg : null;
    }
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
  try {
    await sbUpdate('campaigns', `id=eq.${req.params.id}`, patch);
    const meta = { ...patch }; if (meta.script != null) meta.script = `(${meta.script.length} chars)`;
    audit(req.user, 'UPDATE_CAMPAIGN', { target_type: 'campaign', target_id: req.params.id, meta });
    res.json({ ok: true });
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
const CANON_FIELDS = ['first_name','last_name','phone','address','city','state','zip','source'];
// Auto-suggest which CSV header maps to each canonical field.
const HEADER_HINTS = {
  phone:      ['phone','number','phone_number','phone1','primary_phone','cell','mobile','tel'],
  first_name: ['first_name','firstname','first','fname','owner_first'],
  last_name:  ['last_name','lastname','last','lname','owner_last'],
  address:    ['address','street','property_address','addr','site_address'],
  city:       ['city','property_city','town','municipality'],
  state:      ['state','st','property_state'],
  zip:        ['zip','zipcode','zip_code','postal','postal_code','postcode','property_zip'],
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
    city:       get('city') || r.city || null,
    state:      (get('state') || r.state || derived.state || null),
    zip:        get('zip') || r.zip || r.zipcode || r.postal || null,
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

// ── Per-state calling-window setting (ReadyMode-style, admin-editable) ─────────
// GET returns the default window plus a fully-merged row for every state (so the
// UI always has all 51 rows even for states with no stored override).
app.get('/api/admin/settings/calling-window', auth, adminOnly, async (_req, res) => {
  const states = STATES.map(s => {
    const cfg = CALLING.states[s.abbr] || {};
    return {
      abbr: s.abbr, name: s.name, tz: s.tz, label: s.label,
      enabled: cfg.enabled !== false,
      start: cfg.start != null ? cfg.start : null,   // null = inherit default
      end: cfg.end != null ? cfg.end : null,
    };
  });
  res.json({ default: { ...CALLING.default }, states });
});
// PUT accepts { default:{start,end}, states:{ ABBR:{enabled,start,end}, ... } }.
// start/end are minutes-since-midnight (0..1439) or null to inherit the default.
app.put('/api/admin/settings/calling-window', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const dStart = toMinutes(b.default && b.default.start);
  const dEnd = toMinutes(b.default && b.default.end);
  if (dStart == null || dEnd == null || dEnd <= dStart)
    return res.status(400).json({ error: 'invalid default window' });
  const states = {};
  if (b.states && typeof b.states === 'object') {
    for (const st of STATES) {
      const row = b.states[st.abbr];
      if (!row || typeof row !== 'object') continue;
      const s = toMinutes(row.start), e = toMinutes(row.end);
      if (s != null && e != null && e <= s)
        return res.status(400).json({ error: `invalid window for ${st.abbr}` });
      states[st.abbr] = { enabled: row.enabled !== false, start: s, end: e };
    }
  }
  const value = { default: { start: dStart, end: dEnd }, states };
  try {
    await sbReq('POST', 'app_settings?on_conflict=key',
      { key: 'calling_window', value, updated_at: new Date().toISOString() },
      'resolution=merge-duplicates,return=minimal');
    CALLING = normalizeCallingCfg(value);
    audit(req.user, 'EDIT_CALLING_WINDOW', { target_type: 'settings', meta: { default: value.default, states: Object.keys(states).length } });
    res.json({ ok: true, default: { ...CALLING.default } });
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
    res.json({ ...AI, campaigns: campaigns || [], agents: (agents || []).filter(a => a.role === 'agent' || a.role === 'admin'),
      telnyx_numbers: telnyxNumberList() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// The live outbound number pool, straight from the Telnyx Call-Control connection
// (CALLER_POOL, refreshed on boot + every 5 min). This is the exact set the AI can
// dial from, so the picker always mirrors Telnyx — no manual re-entry.
function telnyxNumberList() {
  return CALLER_POOL.map(n => {
    const ac = areaCodeOf(n);
    const d = (ac && deriveFromAreaCode(ac)) || {};
    return { phone_number: n, area_code: ac, state: d.state || null };
  });
}
// On-demand pull from Telnyx (the "Sync from Telnyx" button).
app.post('/api/admin/settings/ai/refresh-numbers', auth, adminOnly, async (_req, res) => {
  try { await refreshCallerPool(); res.json({ numbers: telnyxNumberList() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
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
    did_numbers: Array.isArray(b.did_numbers) ? b.did_numbers.map(String) : [],
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

// AI Call Results — live in-flight calls (from aiRt) + stored AI-lane calls with
// the contact's name/address embedded from the leads table. 50 rows per page.
// AI calls are the outbound calls with no human agent (agent_id is null).
app.get('/api/admin/ai/calls', auth, adminOnly, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const PER = 50;
  const { from, to } = req.query;
  const dmin = req.query.dmin != null && req.query.dmin !== '' ? Math.max(0, parseInt(req.query.dmin, 10) || 0) : null;
  const dmax = req.query.dmax != null && req.query.dmax !== '' ? Math.max(0, parseInt(req.query.dmax, 10) || 0) : null;
  // Result filter — matches on leads.last_outcome (the value aiOutcome() badges from).
  // Uses an inner join so DB-side pagination stays correct. Empty/'all' = no filter.
  const result = String(req.query.result || '').trim().toLowerCase();
  // Live lane snapshot (server memory) — drives the "bot is calling now" panel.
  const live = Object.entries(aiRt).map(([ccid, i]) => ({
    ccid, phone: i.leadNumber, name: i.name, address: i.address,
    phase: i.phase, campaign_id: i.campaignId, since: i.at,
  })).sort((a, b) => a.since - b.since);
  const join = result && result !== 'all' ? 'leads!inner' : 'leads';
  const f = [
    `select=*,${join}(first_name,last_name,address,state,phone,status,last_outcome)`,
    'agent_id=is.null', 'direction=eq.outbound',
    'order=created_at.desc', `limit=${PER + 1}`, `offset=${page * PER}`,
  ];
  if (from) f.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to)   f.push(`created_at=lte.${encodeURIComponent(to)}`);
  // Duration filter — matches on call duration_sec (seconds). Keeps DB-side pagination correct.
  if (dmin != null) f.push(`duration_sec=gte.${dmin}`);
  if (dmax != null) f.push(`duration_sec=lte.${dmax}`);
  // Result filter — ilike is case-insensitive so it catches legacy uppercase
  // outcomes (VOICEMAIL / NOT_INTERESTED). Grouped categories use an embedded OR.
  if (result && result !== 'all') {
    if (result === 'talked') f.push('leads.or=(last_outcome.ilike.ai_contacted,last_outcome.ilike.manual_hangup)');
    else if (result === 'no_answer') f.push('leads.or=(last_outcome.ilike.no_answer,last_outcome.ilike.machine)');
    else f.push(`leads.last_outcome=ilike.${encodeURIComponent(result)}`);
  }
  try {
    const rows = await sbSelect('calls', f.join('&'));
    const hasMore = rows.length > PER;
    res.json({ live, rows: rows.slice(0, PER), page, per: PER, hasMore });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin safety button: hang up one live AI call by ccid. Guarded to the AI lane
// (must be in aiRt) so it can't be pointed at agent/inbound legs. Records the lead
// as manually ended so the pacer won't immediately redial it, and sets
// resultRecorded so the call.hangup handler won't overwrite that disposition.
app.post('/api/admin/ai/hangup', auth, adminOnly, async (req, res) => {
  const ccid = (req.body && req.body.ccid) || '';
  const info = ccid && aiRt[ccid];
  if (!info) return res.status(404).json({ error: 'call not live (already ended?)' });
  info.resultRecorded = true;
  if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`,
    { status: 'CONTACTED', last_outcome: 'manual_hangup' }).catch(() => {});
  try {
    await telnyx('POST', `/calls/${ccid}/actions/hangup`, {});
    console.log(`[ai] manual hangup ${ccid.slice(-8)} by admin`);
    res.json({ ok: true });
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
// Regular-dialer call log — human-agent calls only (agent_id set; AI lane is null).
// Mirrors the AI results page: embeds lead contact + campaign name, badges the
// disposition (leads.last_outcome), and paginates 50/page. Filters: date range,
// agent, campaign, duration (dmin/dmax seconds), result (disposition code).
app.get('/api/admin/reports/calls', auth, adminOnly, async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const PER = 50;
  const { from, to, agent_id, campaign_id } = req.query;
  const dmin = req.query.dmin != null && req.query.dmin !== '' ? Math.max(0, parseInt(req.query.dmin, 10) || 0) : null;
  const dmax = req.query.dmax != null && req.query.dmax !== '' ? Math.max(0, parseInt(req.query.dmax, 10) || 0) : null;
  // Result filter — matches leads.last_outcome (the disposition code written by
  // /api/agent/disposition). ilike is case-insensitive so uppercase codes match.
  const result = String(req.query.result || '').trim().toLowerCase();
  const join = result && result !== 'all' ? 'leads!inner' : 'leads';
  const f = [
    `select=*,${join}(first_name,last_name,address,state,phone,status,last_outcome),campaigns(name)`,
    'agent_id=not.is.null',
    'order=created_at.desc', `limit=${PER + 1}`, `offset=${page * PER}`,
  ];
  if (from)        f.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to)          f.push(`created_at=lte.${encodeURIComponent(to)}`);
  if (agent_id)    f.push(`agent_id=eq.${agent_id}`);
  if (campaign_id) f.push(`campaign_id=eq.${campaign_id}`);
  if (dmin != null) f.push(`duration_sec=gte.${dmin}`);
  if (dmax != null) f.push(`duration_sec=lte.${dmax}`);
  if (result && result !== 'all') {
    // "No answer" groups the machine/busy system outcomes with the agent code.
    if (result === 'no_answer') f.push('leads.or=(last_outcome.ilike.no_answer,last_outcome.ilike.machine,last_outcome.ilike.busy)');
    else f.push(`leads.last_outcome=ilike.${encodeURIComponent(result)}`);
  }
  const qa = String(req.query.qa || '').trim().toLowerCase();
  if (qa === 'flagged')    f.push('qa_flagged=is.true');
  if (qa === 'reviewed')   f.push('qa_reviewed_at=not.is.null');
  if (qa === 'unreviewed') f.push('qa_reviewed_at=is.null');
  try {
    const [rows, names] = await Promise.all([sbSelect('calls', f.join('&')), agentNameMap()]);
    const hasMore = rows.length > PER;
    res.json({
      rows: rows.slice(0, PER).map(r => ({ ...r, agent_name: names[r.agent_id] || null })),
      page, per: PER, hasMore,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV export of the call log — same filters as above, but every matching row
// (no pagination) with full contact detail: owner, address, phone, result,
// time, duration, agent, campaign, recording link.
const CALL_RESULT_LABELS = {
  sale: 'Sale / Appt', callback: 'Callback', not_interested: 'Not interested',
  no_answer: 'No answer', voicemail: 'Voicemail', wrong_number: 'Wrong number',
  dnc: 'Do not call', machine: 'Voicemail', busy: 'Busy',
  lead: 'Lead', bluffer: 'Bluffer', ai_contacted: 'Talked', manual_hangup: 'Talked',
};
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const hhmmss = (secs) => {
  if (secs == null || isNaN(secs) || secs < 0) return '';
  const s = Math.round(secs), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
app.get('/api/admin/reports/calls/export', auth, adminOnly, async (req, res) => {
  const { from, to, agent_id, campaign_id } = req.query;
  const dmin = req.query.dmin != null && req.query.dmin !== '' ? Math.max(0, parseInt(req.query.dmin, 10) || 0) : null;
  const dmax = req.query.dmax != null && req.query.dmax !== '' ? Math.max(0, parseInt(req.query.dmax, 10) || 0) : null;
  const result = String(req.query.result || '').trim().toLowerCase();
  const join = result && result !== 'all' ? 'leads!inner' : 'leads';
  const f = [
    `select=*,${join}(first_name,last_name,address,state,phone,status,last_outcome),campaigns(name)`,
    'agent_id=not.is.null', 'order=created_at.desc', 'limit=50000',
  ];
  if (from)        f.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to)          f.push(`created_at=lte.${encodeURIComponent(to)}`);
  if (agent_id)    f.push(`agent_id=eq.${agent_id}`);
  if (campaign_id) f.push(`campaign_id=eq.${campaign_id}`);
  if (dmin != null) f.push(`duration_sec=gte.${dmin}`);
  if (dmax != null) f.push(`duration_sec=lte.${dmax}`);
  if (result && result !== 'all') {
    if (result === 'no_answer') f.push('leads.or=(last_outcome.ilike.no_answer,last_outcome.ilike.machine,last_outcome.ilike.busy)');
    else f.push(`leads.last_outcome=ilike.${encodeURIComponent(result)}`);
  }
  try {
    const [rows, names] = await Promise.all([sbSelect('calls', f.join('&')), agentNameMap()]);
    const head = ['Time', 'Owner', 'Phone', 'Result', 'Agent', 'Campaign', 'State',
      'Property Address', 'Called From', 'Talk', 'Duration (s)', 'Lead Status',
      'Started', 'Ended', 'Recording URL'];
    const lines = [head.join(',')];
    for (const r of rows) {
      const L = r.leads || {};
      const owner = [L.first_name, L.last_name].filter(Boolean).join(' ');
      const oc = String(L.last_outcome || '').toLowerCase();
      const resLabel = CALL_RESULT_LABELS[oc] || (r.amd_result === 'human' ? 'Talked' : (L.status || r.hangup_cause || ''));
      const talk = (r.bridged_at && r.ended_at) ? hhmmss((new Date(r.ended_at) - new Date(r.bridged_at)) / 1000) : '';
      lines.push([
        r.created_at, owner, r.to_number || L.phone || '', resLabel,
        names[r.agent_id] || '', (r.campaigns && r.campaigns.name) || '', L.state || '',
        L.address || '', r.from_number || '', talk, r.duration_sec != null ? r.duration_sec : '',
        L.status || '', r.created_at || '', r.ended_at || '', r.recording_url || '',
      ].map(csvCell).join(','));
    }
    audit(req.user, 'EXPORT_CALL_LOGS', { target_type: 'calls', meta: { count: rows.length } });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="call-logs.csv"');
    res.send(lines.join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recording QA — flag / score / annotate a call recording for quality review.
// Lives inside the Call logs report; gated by reports.qa (separate from viewing).
app.post('/api/admin/reports/calls/:id/qa', auth, adminOnly, async (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  const patch = { qa_reviewed_by: req.user.id, qa_reviewed_at: new Date().toISOString() };
  if (b.flagged != null) patch.qa_flagged = !!b.flagged;
  if (b.score === null || b.score === '') patch.qa_score = null;
  else if (b.score != null) {
    const s = parseInt(b.score, 10);
    if (isNaN(s) || s < 1 || s > 5) return res.status(400).json({ error: 'score must be 1–5 or empty' });
    patch.qa_score = s;
  }
  if (b.note != null) patch.qa_note = String(b.note).slice(0, 2000);
  try {
    const rows = await sbUpdate('calls', `id=eq.${id}`, patch);
    if (!rows || !rows.length) return res.status(404).json({ error: 'call not found' });
    audit(req.user, 'QA_REVIEW', { target_type: 'calls', target_id: id, meta: { flagged: patch.qa_flagged, score: patch.qa_score } });
    res.json({ ok: true, call: rows[0] });
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

// ── Campaign analytics: disposition summary + call time, per campaign ──────────
// Aggregates the dispositions table (grouped by code) and the calls table (time)
// over [from,to], optionally scoped to one campaign. Powers the Analytics grid.
const DISP_META = (() => {
  const m = {};
  for (const d of DEFAULT_DISPOSITIONS) m[d.code] = { label: d.label, color: d.color };
  // Codes that arise from the system/AI lane (no agent disposition row) or extras.
  m.MACHINE   = m.MACHINE   || { label: 'Answering Machine', color: '#a371f7' };
  m.BUSY      = m.BUSY      || { label: 'Busy',              color: '#d29922' };
  m.AI_CONTACTED = { label: 'AI — Contacted', color: '#2ea043' };
  return m;
})();
const dispMeta = (code) => DISP_META[code] || { label: String(code || 'Unknown'), color: '#8b95a5' };

app.get('/api/admin/analytics', auth, adminOnly, async (req, res) => {
  const now = Date.now();
  const from = req.query.from ? new Date(req.query.from).getTime() : new Date(new Date().toDateString()).getTime();
  const to   = req.query.to   ? new Date(req.query.to).getTime()   : now;
  const fromIso = new Date(from).toISOString(), toIso = new Date(to).toISOString();
  const wantId = req.query.campaign_id && req.query.campaign_id !== 'all' ? String(req.query.campaign_id) : null;
  try {
    const campaigns = await sbSelect('campaigns', 'select=id,name,status,active&order=created_at.asc') || [];
    const targets = wantId ? campaigns.filter(c => c.id === wantId) : campaigns;
    const ids = targets.map(c => c.id);
    const acc = {};
    for (const c of targets) acc[c.id] = { campaign_id: c.id, name: c.name, status: c.status, active: c.active,
      dials: 0, total_calls: 0, total_talk_sec: 0, avg_sec: 0, _codes: {} };

    if (ids.length) {
      const inList = ids.map(i => `"${i}"`).join(',');
      const range = `&created_at=gte.${encodeURIComponent(fromIso)}&created_at=lte.${encodeURIComponent(toIso)}`;
      const [disps, calls] = await Promise.all([
        sbSelect('dispositions', `campaign_id=in.(${inList})${range}&select=campaign_id,code&limit=200000`),
        sbSelect('calls', `campaign_id=in.(${inList})${range}&select=campaign_id,duration_sec,talk_seconds&limit=200000`),
      ]);
      for (const d of disps || []) { const a = acc[d.campaign_id]; if (!a) continue;
        a.total_calls++; a._codes[d.code] = (a._codes[d.code] || 0) + 1; }
      for (const c of calls || []) { const a = acc[c.campaign_id]; if (!a) continue;
        a.dials++; a.total_talk_sec += (c.talk_seconds || c.duration_sec || 0); }
    }
    const summaries = Object.values(acc).map(a => {
      a.avg_sec = a.total_calls ? Math.round(a.total_talk_sec / a.total_calls) : 0;
      a.dispositions = Object.entries(a._codes)
        .map(([code, count]) => ({ code, ...dispMeta(code), count,
          pct: a.total_calls ? Math.round((count / a.total_calls) * 1000) / 10 : 0 }))
        .sort((x, y) => y.count - x.count);
      delete a._codes; return a;
    });
    res.json({ from: fromIso, to: toIso, campaigns, summaries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AMD accuracy / effectiveness stats ────────────────────────────────────────
// Answers "is AMD actually working?" for a campaign+range from the always-on
// instrumentation columns (no test harness needed to read production accuracy):
//   • result distribution (verbatim payload.result counts + %)
//   • detection latency p50 / p95 / mean (ms, from amd_latency_ms)
//   • AMD-vs-disposition disagreement: calls AMD flagged machine but the AGENT
//     dispositioned as a live contact (false positive), and calls AMD called
//     human but the agent marked voicemail/no-answer (false negative / miss)
//   • abandoned rate vs the FCC 3% cap
// Reads the calls + dispositions tables directly; degrades to zeros pre-migration.
app.get('/api/admin/amd-stats', auth, adminOnly, async (req, res) => {
  const now = Date.now();
  const from = req.query.from ? new Date(req.query.from).getTime() : (now - 7 * 864e5);
  const to   = req.query.to   ? new Date(req.query.to).getTime()   : now;
  const fromIso = new Date(from).toISOString(), toIso = new Date(to).toISOString();
  const wantId = req.query.campaign_id && req.query.campaign_id !== 'all' ? String(req.query.campaign_id) : null;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const quantile = (sorted, q) => {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    return sorted[idx];
  };
  // Agent dispositions that mean "I actually spoke to a live person".
  const LIVE_CODES = new Set(['SALE', 'APPT', 'APPOINTMENT', 'LEAD', 'CB', 'CALLBACK', 'NI', 'NOT_INTERESTED', 'DNC', 'XFER', 'TRANSFER']);
  const VM_CODES   = new Set(['VM', 'VOICEMAIL', 'MACHINE', 'AMD_MISS']);
  try {
    const filt = wantId ? `campaign_id=eq.${wantId}` : '';
    const range = `created_at=gte.${encodeURIComponent(fromIso)}&created_at=lte.${encodeURIComponent(toIso)}`;
    const where = [filt, range].filter(Boolean).join('&');
    const [calls, disps] = await Promise.all([
      sbSelect('calls', `${where}&select=id,telnyx_call_control_id,campaign_id,amd_mode,amd_result,amd_latency_ms,amd_greeting,answered_at,abandoned,vm_dropped&limit=200000`).catch(() => []),
      sbSelect('dispositions', `${where}&select=telnyx_call_control_id,code&limit=200000`).catch(() => []),
    ]);
    const dispByCall = {};
    for (const d of disps || []) if (d.telnyx_call_control_id) dispByCall[d.telnyx_call_control_id] = d.code;

    const byMode = {};   // amd_mode -> aggregates
    const mode = (m) => byMode[m] || (byMode[m] = {
      amd_mode: m, calls: 0, answered: 0, results: {}, latencies: [],
      false_positive: 0, false_negative: 0, vm_dropped: 0, abandoned: 0,
    });
    let totalAnswered = 0, totalAbandoned = 0;
    for (const c of calls || []) {
      const m = mode(c.amd_mode || 'unknown');
      m.calls++;
      if (c.answered_at) { m.answered++; totalAnswered++; }
      if (c.abandoned) { m.abandoned++; totalAbandoned++; }
      if (c.vm_dropped) m.vm_dropped++;
      if (c.amd_result) m.results[c.amd_result] = (m.results[c.amd_result] || 0) + 1;
      if (Number.isFinite(c.amd_latency_ms)) m.latencies.push(c.amd_latency_ms);
      // Disagreement vs the agent's own disposition (ground truth).
      const code = c.telnyx_call_control_id ? dispByCall[c.telnyx_call_control_id] : null;
      if (code && c.amd_result) {
        const cls = amdClass(c.amd_result);
        if (cls === 'machine' && LIVE_CODES.has(code)) m.false_positive++;   // AMD said machine, agent talked to a human
        if (cls === 'human'   && VM_CODES.has(code))   m.false_negative++;   // AMD said human, agent got a machine/VM
      }
    }
    const modes = Object.values(byMode).map(m => {
      const lat = m.latencies.sort((a, b) => a - b);
      const dist = Object.entries(m.results)
        .map(([result, count]) => ({ result, count, pct: pct(count, m.answered) }))
        .sort((a, b) => b.count - a.count);
      return {
        amd_mode: m.amd_mode, calls: m.calls, answered: m.answered,
        result_distribution: dist,
        latency_ms: {
          p50: quantile(lat, 0.5), p95: quantile(lat, 0.95),
          mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
          n: lat.length,
        },
        disagreement: {
          false_positive: m.false_positive, false_positive_pct: pct(m.false_positive, m.answered),
          false_negative: m.false_negative, false_negative_pct: pct(m.false_negative, m.answered),
        },
        vm_dropped: m.vm_dropped, abandoned: m.abandoned,
      };
    }).sort((a, b) => b.calls - a.calls);

    res.json({
      from: fromIso, to: toIso, campaign_id: wantId || 'all',
      totals: {
        calls: (calls || []).length, answered: totalAnswered,
        abandoned: totalAbandoned, abandoned_rate_pct: pct(totalAbandoned, totalAnswered),
        fcc_cap_pct: AMD_ABANDON_CAP * 100, over_cap: pct(totalAbandoned, totalAnswered) > AMD_ABANDON_CAP * 100,
      },
      modes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Real-time wallboard ───────────────────────────────────────────────────────
// Live team snapshot for a wall-mounted / always-open view: today's dials,
// contact rate, sales, plus per-agent live state and a disposition breakdown.
// Cheap enough to poll every few seconds. "Today" = since local midnight.
app.get('/api/admin/reports/wallboard', auth, adminOnly, async (_req, res) => {
  const now = Date.now();
  const fromIso = new Date(new Date().toDateString()).toISOString();
  const ONLINE = new Set(['CONNECTING', 'AVAILABLE', 'CLAIMING', 'DIALING', 'ON_CALL', 'WRAP_UP', 'BREAK']);
  try {
    const [names, calls, disps, campaigns] = await Promise.all([
      agentNameMap(),
      sbSelect('calls', `created_at=gte.${encodeURIComponent(fromIso)}&select=agent_id,bridged_at,duration_sec,talk_seconds&limit=200000`),
      sbSelect('dispositions', `created_at=gte.${encodeURIComponent(fromIso)}&select=agent_id,code&limit=200000`),
      sbSelect('campaigns', 'select=id,status'),
    ]);
    const per = {};
    const A = (id) => per[id] || (per[id] = { agent_id: id, name: names[id] || '—',
      dials: 0, contacts: 0, talk: 0, sales: 0, state: (rt[id] && rt[id].state) || 'OFFLINE' });
    let dials = 0, contacts = 0, talk = 0;
    for (const c of calls || []) {
      dials++; if (c.bridged_at) contacts++; talk += (c.talk_seconds || c.duration_sec || 0);
      if (c.agent_id) { const a = A(c.agent_id); a.dials++; if (c.bridged_at) a.contacts++; a.talk += (c.talk_seconds || c.duration_sec || 0); }
    }
    let sales = 0; const codeBreak = {};
    for (const d of disps || []) {
      codeBreak[d.code] = (codeBreak[d.code] || 0) + 1;
      if (d.code === 'SALE') { sales++; if (d.agent_id) A(d.agent_id).sales++; }
    }
    // Surface every currently-online agent, even with no dials yet today.
    for (const id of Object.keys(rt)) if (ONLINE.has(rt[id] && rt[id].state)) A(id);
    const agents = Object.values(per).map(a => {
      a.talk = Math.round(a.talk);
      a.contact_rate = a.dials ? Math.round((a.contacts / a.dials) * 1000) / 10 : 0;
      return a;
    }).sort((x, y) => (y.sales - x.sales) || (y.contacts - x.contacts) || (y.dials - x.dials));
    const online = Object.keys(rt).filter(id => ONLINE.has(rt[id] && rt[id].state));
    const dispositions = Object.entries(codeBreak)
      .map(([code, count]) => ({ code, ...dispMeta(code), count })).sort((a, b) => b.count - a.count);
    res.json({ ts: now, since: fromIso,
      team: { dials, contacts, talk_sec: Math.round(talk), sales,
        contact_rate: dials ? Math.round((contacts / dials) * 1000) / 10 : 0,
        agents_online: online.length,
        agents_on_call: Object.keys(rt).filter(id => rt[id].state === 'ON_CALL').length,
        campaigns_running: (campaigns || []).filter(c => c.status === 'RUNNING').length },
      agents, dispositions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live per-playlist call stats (ReadyMode-style). Columns: CPA (configured
// calls-per-agent), Calls (dials initiated), Ans (bridged to a human), MD
// (machine-detected), Drop (answered but no free agent = abandoned), Abd% (Drop/
// Ans), Dial (legs ringing right now). Counters are in-memory since boot/last
// reset; Dial is derived live from rt[*].pending.
app.get('/api/admin/reports/playlists', auth, adminOnly, async (_req, res) => {
  try {
    const playlists = await sbSelect('playlists', 'select=id,name,priority,lines_per_agent,active') || [];
    const byId = Object.fromEntries(playlists.map(p => [p.id, p]));
    // Live in-flight dials, grouped by the playlist that launched each leg.
    const liveDial = {};
    for (const id in rt) {
      const st = rt[id]; if (!st || !st.pending) continue;
      for (const cc in st.pending) {
        const k = st.pending[cc].playlistId || '__direct__';
        liveDial[k] = (liveDial[k] || 0) + 1;
      }
    }
    const cpaOf = (pl) => { const n = pl && pl.lines_per_agent; return (n >= 1 && n <= 5) ? n : DIALER.lines_per_agent; };
    const keys = new Set([...Object.keys(PLAYLIST_STATS), ...Object.keys(liveDial)]);
    const rows = [];
    for (const k of keys) {
      const s = PLAYLIST_STATS[k] || { calls: 0, ans: 0, md: 0, drop: 0 };
      const pl = k === '__direct__' ? null : byId[k];
      const dial = liveDial[k] || 0;
      // Skip fully-empty rows for playlists that were deleted and never dialed.
      if (!pl && k !== '__direct__' && s.calls === 0 && dial === 0) continue;
      rows.push({
        playlist_id: k === '__direct__' ? null : k,
        name: pl ? pl.name : (k === '__direct__' ? 'Direct (no playlist)' : '(deleted playlist)'),
        active: pl ? pl.active !== false : false,
        cpa: cpaOf(pl), calls: s.calls, ans: s.ans, md: s.md, drop: s.drop,
        abd_pct: s.ans > 0 ? Math.round((s.drop / s.ans) * 1000) / 10 : 0,
        dial,
      });
    }
    rows.sort((a, b) => (b.calls - a.calls) || (b.dial - a.dial));
    const tot = rows.reduce((t, r) => {
      t.calls += r.calls; t.ans += r.ans; t.md += r.md; t.drop += r.drop; t.dial += r.dial; return t;
    }, { calls: 0, ans: 0, md: 0, drop: 0, dial: 0 });
    tot.abd_pct = tot.ans > 0 ? Math.round((tot.drop / tot.ans) * 1000) / 10 : 0;
    res.json({ ts: Date.now(), since: new Date(PLAYLIST_STATS_SINCE).toISOString(), rows, totals: tot });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Reset the live per-playlist counters (Dial is live and unaffected).
app.post('/api/admin/reports/playlists/reset', auth, adminOnly, (req, res) => {
  PLAYLIST_STATS = {}; PLAYLIST_STATS_SINCE = Date.now();
  audit(req.user, 'RESET_PLAYLIST_STATS', { target_type: 'settings' });
  res.json({ ok: true, since: new Date(PLAYLIST_STATS_SINCE).toISOString() });
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
    // Resolve the storage source. `sb:recordings/<id>.mp3` = durable copy in our own
    // Supabase bucket (permanent). Otherwise it's a Telnyx URL — api.telnyx.com needs
    // Bearer; presigned S3 links work directly but expire ~10 min after the call.
    let src = c.recording_url, extra = {};
    if (isArchived(c.recording_url)) {
      src = `https://${SB_HOST}/storage/v1/object/${c.recording_url.slice(3)}`;
      extra = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
    } else if (/api\.telnyx\.com/i.test(c.recording_url)) {
      extra = { Authorization: `Bearer ${TELNYX_KEY}` };
    }
    // Forward the browser's Range header so <audio> can seek/buffer. Without range
    // support some browsers stall playback after ~1s. Both Telnyx and Supabase honour Range.
    const range = req.headers.range;
    let upstream = await fetch(src, { headers: Object.assign({}, extra, range ? { 'Range': range } : {}) });
    // Self-heal: a legacy/expired Telnyx presigned URL (403/410) that was never
    // archived — pull a fresh copy into Supabase now, then serve it. This makes even
    // old "0:00" recordings play on the first click without a manual backfill.
    if (!upstream.ok && !isArchived(c.recording_url) && c.recording_id) {
      try {
        const r = await archiveCallRecording(c.id, c.recording_id, null, true);
        src = `https://${SB_HOST}/storage/v1/object/${r.marker.slice(3)}`;
        upstream = await fetch(src, { headers: Object.assign({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, range ? { 'Range': range } : {}) });
      } catch (e) { console.error('[stream:self-heal]', e.message); }
    }
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `recording fetch ${upstream.status}` });
    }
    const download = req.query.download === '1';
    // Telnyx serves mp3 recordings as application/octet-stream, which some browsers
    // refuse to play/scrub in an <audio> element. We record as mp3, so normalise a
    // generic/missing upstream type to audio/mpeg.
    let ctype = upstream.headers.get('content-type') || '';
    if (!ctype || /octet-stream/i.test(ctype)) ctype = 'audio/mpeg';
    res.setHeader('Content-Type', ctype);
    res.setHeader('Accept-Ranges', 'bytes');
    // Relay a partial-content response verbatim so the browser's range machinery works.
    if (upstream.status === 206) {
      res.status(206);
      const cr = upstream.headers.get('content-range'); if (cr) res.setHeader('Content-Range', cr);
    }
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

// Supervisor action: kick an agent off the dialer. Drops any live lead leg, drops
// the agent's WebRTC leg, forces OFFLINE, and pushes a 'kicked' event to the
// agent's own browser so their softphone tears down. Reversible: they can log
// back in and Go Available again.
app.post('/api/admin/floor/kick', auth, adminOnly, async (req, res) => {
  const id = req.body && req.body.agent_id;
  if (!id) return res.status(400).json({ error: 'agent_id required' });
  const st = rt[id];
  try {
    if (st) {
      clearWrapTimer(st);
      if (st.leadLeg)  await telnyx('POST', `/calls/${st.leadLeg}/actions/hangup`, {}).catch(() => {});
      if (st.agentLeg) await telnyx('POST', `/calls/${st.agentLeg}/actions/hangup`, {}).catch(() => {});
    }
    rt[id] = { state: 'OFFLINE' };
    await setAgentState(id, 'OFFLINE');
    wsToAgent(id, { type: 'kicked', by: req.user.name || req.user.email || 'a supervisor' });
    audit(req.user, 'KICK_AGENT', { target_type: 'agent', target_id: id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supervisor action: report whether an agent has a live call that can be
// monitored, and return the leg's call_control_id the /ws/monitor socket forks.
app.post('/api/admin/floor/monitor', auth, adminOnly, (req, res) => {
  const id = req.body && req.body.agent_id;
  if (!id) return res.status(400).json({ error: 'agent_id required' });
  const st = rt[id];
  const live = !!(st && st.state === 'ON_CALL' && st.leadLeg);
  res.json({ ok: true, live, ccid: live ? st.leadLeg : null, state: (st && st.state) || 'OFFLINE' });
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

// Agent-facing productivity: logged-in / break / wrap durations + calls handled,
// for two windows — today (local midnight) and this month (resets on the 1st).
const PROD_LOGGED = new Set(['CONNECTING', 'AVAILABLE', 'CLAIMING', 'DIALING', 'ON_CALL', 'WRAP_UP', 'BREAK']);
async function productivityWindow(agentId, fromMs, toMs) {
  const fromIso = new Date(fromMs).toISOString(), toIso = new Date(toMs).toISOString();
  const [spans, calls] = await Promise.all([
    sbSelect('agent_state_events',
      `agent_id=eq.${agentId}&started_at=lte.${encodeURIComponent(toIso)}` +
      `&or=(ended_at.is.null,ended_at.gte.${encodeURIComponent(fromIso)})` +
      `&select=state,started_at,ended_at&limit=100000`),
    sbSelect('calls',
      `agent_id=eq.${agentId}&created_at=gte.${encodeURIComponent(fromIso)}` +
      `&created_at=lte.${encodeURIComponent(toIso)}&select=id&limit=100000`),
  ]);
  const out = { logged_in: 0, break: 0, wrap: 0, calls: (calls || []).length };
  for (const s of spans || []) {
    const start = new Date(s.started_at).getTime();
    const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now();
    const dur = Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs)) / 1000;
    if (dur <= 0) continue;
    if (PROD_LOGGED.has(s.state)) out.logged_in += dur;
    if (s.state === 'BREAK') out.break += dur;
    else if (s.state === 'WRAP_UP') out.wrap += dur;
  }
  for (const k of ['logged_in', 'break', 'wrap']) out[k] = Math.round(out[k]);
  return out;
}
app.get('/api/agent/productivity', auth, async (req, res) => {
  try {
    const now = Date.now();
    const d = new Date();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const [today, month] = await Promise.all([
      productivityWindow(req.user.id, dayStart, now),
      productivityWindow(req.user.id, monthStart, now),
    ]);
    res.json({ today, month });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    address: lead.address, city: lead.city, state: lead.state, zip: lead.zip, ...(lead.custom || {}) };
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

    // Record the disposition row. Correlate to the exact call leg (rt.leadLeg)
    // so the AMD false-negative meter can match "Voicemail reached me" back to the
    // AMD verdict Telnyx returned for this same leg.
    sbWrite('POST', 'dispositions', { lead_id: leadId, agent_id: req.user.id, campaign_id: lead.campaign_id,
      code, notes: notes || null, callback_at: callback_at || null,
      telnyx_call_control_id: (st && st.leadLeg) || null }, 'return=minimal', 'dispositions');

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
    if (!callableNow(lead))
      return res.status(409).json({ error: 'outside calling window for this lead' });
    st.state = 'CLAIMING';
    await dialLead(id, lead);   // does the DNC check + state transitions
    audit(req.user, 'MANUAL_CALL', { target_type: 'lead', target_id: leadId, meta: { phone: lead.phone } });
    res.json({ ok: true, state: st.state });
  } catch (e) { st && (st.state = 'AVAILABLE'); res.status(502).json({ error: e.message }); }
});

// ══ PACING ENGINE ════════════════════════════════════════════════════════════════
async function dialLead(agentId, lead, playlistId) {
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
  // Per-campaign AMD config (mode + optional analysis-time overrides). Falls back
  // to premium; a campaign set to 'disabled' opts out entirely.
  const acfg = await campaignAmd(lead.campaign_id);
  const amdParam = AMD_MODE === 'disabled' ? 'disabled' : acfg.mode;
  const amdConf  = amdConfigParam(acfg.config);
  const cid = crypto.randomUUID();   // our internal call id — correlates every webhook back to this dial
  const dialBody = {
    connection_id: CONNECTION_ID,
    to: lead.phone,
    from,
    timeout_secs: DIALER.ring_secs,   // hard ring cap — no dead air on no-answers
    answering_machine_detection: amdParam,
    // Unconditional recording (per Karim). Recording is saved on call.recording.saved.
    record: 'record-from-answer', record_channels: 'dual', record_format: 'mp3',
    client_state: enc({ role: 'lead', agentId, conf: st.conferenceId, leadId: lead.id, campaignId: lead.campaign_id, cid, amd: amdParam }),
  };
  if (amdParam !== 'disabled' && amdConf) dialBody.answering_machine_detection_config = amdConf;
  const result = await telnyx('POST', '/calls', dialBody);
  const ccid = result.data && result.data.call_control_id;
  // Ratio dialing: track every in-flight (unbridged) leg. st.leadLeg is reserved
  // for the ONE leg that actually connects to a human; the extras get dropped the
  // moment one connects (see connectLeadLeg).
  st.pending = st.pending || {};
  st.pending[ccid] = { leadId: lead.id, leadNumber: lead.phone, fromNumber: from, campaignId: lead.campaign_id, playlistId: playlistId || null, at: Date.now(),
    cid, amdMode: amdParam, gatedBridge: acfg.gatedBridge, silencePolicy: acfg.silencePolicy, answeredAt: null };
  plStat(playlistId).calls++;
  if (st.state !== 'ON_CALL') st.state = 'DIALING';
  st.onCallSince = null;
  await persistRt(agentId);
  logStateEvent(agentId, 'DIALING');
  wsAgentSnapshot(agentId);
  await sbUpdate('leads', `id=eq.${lead.id}`,
    { status: 'IN_PROGRESS', attempts: (lead.attempts || 0) + 1, last_attempt_at: new Date().toISOString(), assigned_agent_id: agentId })
    .catch(e => console.error('[dialLead:update]', e.message));
  markFirstDial(lead.phone);   // stamps first_dial_at once — anchors the 10-day recycle window
  // Open a calls row for history/recording linkage (durable upsert by ccid).
  // id = cid ties amd_events.call_id back to calls.id for the accuracy harness.
  saveCall({ id: cid, lead_id: lead.id, agent_id: agentId, campaign_id: lead.campaign_id,
    telnyx_call_control_id: ccid, from_number: from, to_number: lead.phone, direction: 'outbound' }, 'call-open-outbound');
  // Separate best-effort write so the amd_mode column (added by amd_schema.sql)
  // failing pre-migration can't roll back the core calls-open row above.
  saveCall({ telnyx_call_control_id: ccid, amd_mode: amdParam }, 'call-amd-mode');
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
    const dp = (st.pending && st.pending[ccid] && st.pending[ccid].playlistId) || null;
    plStat(dp).drop++;   // ReadyMode "Drop": answered but no free agent to take it
    if (st.pending) delete st.pending[ccid];
    telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
    // FCC "abandoned call": a live answer we couldn't connect to an agent within
    // the 2-second window. Flag it so campaignAbandonRate can hold the campaign
    // under the 3%-per-30-days cap and the pacer can throttle before we hit it.
    if (ccid) saveCall({ telnyx_call_control_id: ccid, abandoned: true,
      ended_at: new Date().toISOString() }, 'call-abandoned');
    const lid = (cs && cs.leadId);
    if (lid) sbUpdate('leads', `id=eq.${lid}`,
      { status: 'CALLBACK', next_callback_at: new Date(Date.now() + 10 * 60e3).toISOString() }).catch(() => {});
    console.log(`[bridge] extra answer dropped for agent ${agentId.slice(0, 8)} (already on a call) — ABANDONED`);
    return;
  }
  const info = (st.pending && st.pending[ccid]) || {};
  if (st.pending) delete st.pending[ccid];
  st.leadLeg = ccid;
  st.leadId = info.leadId || (cs && cs.leadId) || null;
  st.leadNumber = info.leadNumber || null;
  st.fromNumber = info.fromNumber || null;
  st.leadPlaylistId = info.playlistId || null;   // remembered for MD/wrap stats after pending is cleared
  st.onCallSince = Date.now();
  st.state = 'ON_CALL';
  await telnyx('POST', `/conferences/${conf}/actions/join`, { call_control_id: ccid, start_conference_on_enter: true, mute: false });
  await setAgentState(agentId, 'ON_CALL');
  plStat(st.leadPlaylistId).ans++;
  saveCall({ telnyx_call_control_id: ccid, bridged_at: new Date().toISOString(), amd_result: amd || null }, 'call-bridged');
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
// optional playlist filter set). Returns a lead row or null. The per-state
// calling window is enforced by callableNow (evaluated in each lead's own tz).
async function nextDialableLead(campaignIds, filters, nowIso) {
  if (!campaignIds.length) return null;
  const inList = campaignIds.map(c => `"${c}"`).join(',');
  const frag = playlistFragment(filters || []);
  const base =
    `campaign_id=in.(${inList})&dnc=eq.false&status=in.(NEW,CALLBACK)` +
    (frag ? `&${frag}` : '') +
    `&or=(next_callback_at.is.null,next_callback_at.lte.${nowIso})` +
    `&order=next_callback_at.asc.nullsfirst,created_at.asc&select=*`;
  // Compliance: hard per-state lead-local calling window. callableNow is
  // evaluated in JS (each lead's own timezone), so it can't be pushed into the
  // SQL WHERE clause. We therefore page through candidates IN PRIORITY ORDER
  // and return the first one that's dialable right now — instead of limiting to
  // a tiny pre-filtered slice. A small slice stalls the pacer completely
  // whenever its leading rows are all out-of-window (e.g. the oldest leads are
  // all West-Coast and it's before 10am PT), even though thousands of other
  // in-window leads are waiting behind them.
  const PAGE = 100, MAX = 1000;
  for (let offset = 0; offset < MAX; offset += PAGE) {
    const leads = await sbSelect('leads', `${base}&limit=${PAGE}&offset=${offset}`);
    if (!leads || !leads.length) return null;
    const hit = leads.find(callableNow);
    if (hit) return hit;
    if (leads.length < PAGE) return null;   // last (partial) page — nothing dialable now
  }
  return null;
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
      sbSelect('campaigns', 'status=eq.RUNNING&select=*'),   // select=* keeps this working pre-predictive_schema.sql
      sbSelect('playlists', 'active=eq.true&select=id,priority,filters,lines_per_agent'),
      sbSelect('playlist_campaigns', 'select=playlist_id,campaign_id'),
      sbSelect('playlist_agents', 'select=playlist_id,agent_id'),
      sbSelect('campaign_agents', 'select=campaign_id,agent_id'),
    ]);
    // Predictive campaigns belong EXCLUSIVELY to enginePacingTick — excluding them
    // here is what prevents the two engines from double-dialing the same leads.
    const runningSet = new Set((runningCamps || []).filter(c => c.pacing_mode !== 'predictive').map(c => c.id));
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
      let cpa = cpaOf(first.playlist);
      // FCC guardrail: if this campaign's rolling abandoned rate is nearing the 3%
      // cap, clamp to pure power-dialing (CPA=1) so we ring one number per free
      // agent and can never abandon a live answer. Rate is cached (5-min TTL).
      if (cpa > 1) {
        const arate = await campaignAbandonRate(first.lead.campaign_id).catch(() => 0);
        if (arate >= AMD_ABANDON_THROTTLE) {
          cpa = 1;
          console.log(`[pacing] campaign ${String(first.lead.campaign_id).slice(0, 8)} abandoned=${(arate * 100).toFixed(2)}% >= throttle — CPA clamped to 1`);
        }
      }
      if (inFlight >= cpa) continue;                       // already at this playlist's CPA
      try { await dialLead(agentId, first.lead, first.playlist && first.playlist.id); }
      catch (e) { console.error('[pacing:dial]', e.message); continue; }
      // Top up to the playlist's CPA with additional simultaneous legs.
      let need = cpa - inFlight - 1;
      while (need-- > 0) {
        if (st.leadLeg || st.inbound) break;              // connected mid-loop → stop dialing
        const nxt = await pickLead(agentId);
        if (!nxt.lead) break;                              // no more leads for this agent
        try { await dialLead(agentId, nxt.lead, nxt.playlist && nxt.playlist.id); }
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
  return (leads || []).find(callableNow) || null;
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
  const from = pickCallerId(areaCodeOf(lead.phone), AI.did_numbers);
  // Cold-call greeting addresses the contact by FIRST name only.
  const firstName = String(lead.first_name || '').trim() || 'there';
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() || 'there';
  // Full property address from the mapped lead columns (street, city, state, zip).
  const propertyAddress = [lead.address, lead.city, lead.state, lead.zip]
    .map(x => String(x || '').trim()).filter(Boolean).join(', ');
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
    campaignId: lead.campaign_id, name, firstName, address: propertyAddress || lead.address || '',
    phase: 'dialing', at: Date.now() };
  await sbUpdate('leads', `id=eq.${lead.id}`,
    { status: 'IN_PROGRESS', attempts: (lead.attempts || 0) + 1, last_attempt_at: new Date().toISOString() })
    .catch(e => console.error('[dialAiLead:update]', e.message));
  markFirstDial(lead.phone);
  saveCall({ lead_id: lead.id, campaign_id: lead.campaign_id,
    telnyx_call_control_id: ccid, from_number: from, to_number: lead.phone, direction: 'outbound' }, 'call-open-ai');
  console.log(`[ai] -> ${lead.phone} from ${from} (${Object.keys(aiRt).length}/${AI.concurrency} live)`);
}

// Post-call transcript classifier (safety net for missed end_call). Reads the
// message array from call.conversation.ended and returns 'lead' | 'callback' |
// 'not_interested' | null. Conservative: only upgrades to 'lead' on a genuine
// signal of selling interest, never on a bare "hello". Returns null when unsure
// so the generic 'ai_contacted' ("Talked") stays put.
function classifyTranscript(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const userTurns = messages
    .filter(m => m && (m.role === 'user' || m.role === 'human'))
    .map(m => String(m.content || m.text || '').toLowerCase().trim())
    .filter(Boolean);
  if (!userTurns.length) return null;
  const all = userTurns.join(' ');

  // Explicit disinterest wins (unless immediately contradicted by an interest cue).
  const notInterested = /\b(not interested|no thanks|no thank you|don'?t call|stop calling|remove me|take me off|not selling|not for sale|leave me alone|wrong number)\b/;
  const callback = /\b(call (me )?back|call (me )?later|not a good time|busy right now|another time|tomorrow|next week|reach me (at|later)|call after|in an hour)\b/;
  const interest = /\b(sell|selling|interested|how much|what.s your offer|cash offer|make an offer|buy my|thinking (about|of) selling|willing to sell|what can you offer|price|open to)\b/;
  // Info-sharing signals: seller volunteering property/contact details = real lead.
  const gaveInfo = /\b(bedroom|bathroom|square feet|sq ft|acres|my (address|number|email|name is)|it.s located|the (house|property|home) is|built in|roof|foundation|condition|mortgage|owe|tenant|rented)\b/;

  const hasInterest = interest.test(all) || gaveInfo.test(all);
  if (notInterested.test(all) && !hasInterest) return 'not_interested';
  if (hasInterest) return 'lead';
  if (callback.test(all)) return 'callback';
  // Multiple substantive turns (engaged conversation) but no clear cue: leave as Talked.
  return null;
}

// Attach the assistant to a live, confirmed-human leg. Dynamic variables are nested
// under assistant.dynamic_variables per the Telnyx ai_assistant_start contract.
async function startAiAssistant(ccid) {
  const info = aiRt[ccid];
  if (!info) return;
  // The bot addresses the contact by first name and asks about the property at
  // the mapped address. contact_name is the FIRST name; property_address is the
  // STREET ONLY (first comma-segment). Lead lists often have messy/duplicated
  // city+state tails (e.g. "13232 Saint Helena Pl, New Orleans, LA 70129, New
  // Orleans, LA"); saying just the street ("13232 Saint Helena Pl") sounds natural
  // and avoids reading the garbled tail aloud.
  const dyn = { contact_name: info.firstName || info.name || 'there',
    contact_first_name: info.firstName || 'there',
    call_control_id: ccid };   // templated into the end_call tool URL so results route back to this leg
  if (info.address) {
    const street = String(info.address).split(',')[0].trim();
    dyn.property_address = street || info.address;
  }
  try {
    await telnyx('POST', `/calls/${ccid}/actions/ai_assistant_start`, {
      assistant: { id: AI.assistant_id, dynamic_variables: dyn },
    });
    info.phase = 'assistant';
    info.bridgedAt = Date.now();   // talk-clock start, used to compute duration_sec on hangup
    saveCall({ telnyx_call_control_id: ccid, bridged_at: new Date().toISOString(), amd_result: 'human' }, 'call-bridged-ai');
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

// ══ PREDICTIVE (BACKGROUND AMD) DIALER ENGINE ════════════════════════════════════
// A campaign whose pacing_mode='predictive' is dialed by this background engine
// instead of the per-agent power pacer. Calls are placed as standalone UNBRIDGED
// legs (role='dialer'); agents never hear ringing, dialing, or detected machines.
// The webhook state machine below holds each answered leg in a DETECTING phase and
// only bridges it to a reserved agent once premium AMD confirms a human. Machines
// are hung up (or voicemail-dropped) before any agent is involved.
//
// dialerRt[ccid] = {campaignId, leadId, cid, phase, from, to, at, answeredAt,
//                   reservedAgentId} — the single source of truth for an in-flight
// predictive call. Keyed by Telnyx call_control_id so every webhook can O(1) it.
const dialerRt = {};
// Inbound legs sent to the voicemail box when no agent was free (spec §4). Keyed
// by call_control_id: {campaignId, from, to, at} — used by the recording/transcription
// webhooks to file the message into public.voicemails for the callback queue.
const vmboxRt = {};
const DIALER_MAX_CALL_MS = 5 * 60 * 1000;   // reclaim a slot whose webhooks vanished
// Live per-campaign human-answer-rate estimate (EWMA), for pacing adjustment.
const _humanRate = new Map();   // campaignId -> rate 0..1
function noteAnswer(campaignId, isHuman) {
  if (!campaignId) return;
  const prev = _humanRate.has(campaignId) ? _humanRate.get(campaignId) : 0.3;
  const a = 0.1;   // EWMA weight
  _humanRate.set(campaignId, prev * (1 - a) + (isHuman ? 1 : 0) * a);
}
function campaignInFlight(campaignId) {
  let n = 0;
  for (const cc in dialerRt) if (dialerRt[cc].campaignId === campaignId) n++;
  return n;
}
// AVAILABLE, in-conference agents who work this campaign, sorted LONGEST-IDLE
// first (stateStart is when they entered AVAILABLE). RESERVED/ON_CALL excluded.
async function availableAgentsFor(campaignId) {
  const ids = await agentIdsForCampaign(campaignId);
  const free = ids.filter(id => {
    const st = rt[id];
    return st && st.state === 'AVAILABLE' && st.conferenceId && !st.leadLeg;
  });
  free.sort((a, b) => (rt[a].stateStart || 0) - (rt[b].stateStart || 0));
  return free;
}
// Atomically reserve the longest-idle AVAILABLE agent for an about-to-bridge
// human. Returns the agentId or null. RESERVED gates the pacer AND inbound.
async function reserveLongestIdleAgent(campaignId) {
  const free = await availableAgentsFor(campaignId);
  for (const id of free) {
    const st = rt[id];
    if (st && st.state === 'AVAILABLE' && st.conferenceId && !st.leadLeg) {
      st.state = 'RESERVED'; st.reservedAt = Date.now();
      await setAgentState(id, 'RESERVED');
      return id;
    }
  }
  return null;
}
// Resolve the set of agentIds attached to a campaign (via playlists or legacy
// campaign_agents), cached briefly since the engine runs hot.
const _campAgentsCache = new Map();
async function agentIdsForCampaign(campaignId) {
  const hit = _campAgentsCache.get(campaignId);
  if (hit && Date.now() - hit.at < 10000) return hit.ids;
  const set = new Set();
  try {
    const pcs = await sbSelect('playlist_campaigns', `campaign_id=eq.${campaignId}&select=playlist_id`);
    const plIds = [...new Set((pcs || []).map(x => x.playlist_id))];
    if (plIds.length) {
      const pas = await sbSelect('playlist_agents',
        `playlist_id=in.(${plIds.map(p => `"${p}"`).join(',')})&select=agent_id`);
      for (const x of pas || []) set.add(x.agent_id);
    }
    const cas = await sbSelect('campaign_agents', `campaign_id=eq.${campaignId}&select=agent_id`);
    for (const x of cas || []) set.add(x.agent_id);
  } catch { /* fall through with whatever we have */ }
  const ids = [...set];
  _campAgentsCache.set(campaignId, { at: Date.now(), ids });
  return ids;
}

// Place ONE unbridged predictive leg for `lead`. No agent, no conference. The
// DNC + calling-window checks already ran in nextDialableLead; we re-check DNC
// here (cheap, authoritative) so a just-added number can never slip through.
async function dialEngineLead(lead, acfg) {
  const nowIso = new Date().toISOString();
  try {
    const hit = await sbSelect('dnc_list',
      `phone=eq.${encodeURIComponent(lead.phone)}&or=(expires_at.is.null,expires_at.gt.${nowIso})&select=phone&limit=1`);
    if (hit && hit.length) {
      await sbUpdate('leads', `id=eq.${lead.id}`, { dnc: true, status: 'DNC' }).catch(() => {});
      return;
    }
  } catch (e) { console.error('[engine:dnc]', e.message); }
  const from = pickCallerId(areaCodeOf(lead.phone));
  // The engine is USELESS without AMD (the whole state machine keys off the
  // detection webhook), so predictive dials always force premium — overriding
  // both the campaign's amd_mode and the global AMD_MODE env (spec §2).
  const amdParam = 'premium';
  const amdConf = amdConfigParam(acfg.config);
  const cid = crypto.randomUUID();
  const dialBody = {
    connection_id: CONNECTION_ID,
    to: lead.phone,
    from,
    timeout_secs: DIALER.ring_secs,
    answering_machine_detection: amdParam,
    record: 'record-from-answer', record_channels: 'dual', record_format: 'mp3',
    client_state: enc({ role: 'dialer', cid, campaignId: lead.campaign_id, leadId: lead.id, amd: amdParam }),
  };
  if (amdParam !== 'disabled' && amdConf) dialBody.answering_machine_detection_config = amdConf;
  // Mark IN_PROGRESS BEFORE dialing so the next pick can't re-select this lead.
  await sbUpdate('leads', `id=eq.${lead.id}`,
    { status: 'IN_PROGRESS', attempts: (lead.attempts || 0) + 1, last_attempt_at: nowIso }).catch(() => {});
  markFirstDial(lead.phone);
  const result = await telnyx('POST', '/calls', dialBody);
  const ccid = result.data && result.data.call_control_id;
  if (!ccid) return;
  dialerRt[ccid] = { ccid, campaignId: lead.campaign_id, leadId: lead.id, cid, phase: 'DIALING',
    amdMode: amdParam, from, to: lead.phone, at: Date.now(), answeredAt: null, reservedAgentId: null };
  saveCall({ id: cid, lead_id: lead.id, campaign_id: lead.campaign_id, telnyx_call_control_id: ccid,
    from_number: from, to_number: lead.phone, direction: 'outbound' }, 'engine-open');
  saveCall({ telnyx_call_control_id: ccid, amd_mode: amdParam, call_phase: 'DIALING' }, 'engine-phase');
  console.log(`[engine] ${String(lead.campaign_id).slice(0, 8)} dial ${lead.phone} from ${from} cc=...${ccid.slice(-8)}`);
}

// Auto-adjust a campaign's dial_ratio toward safety/efficiency, then persist it.
// Shrinks toward the floor as human-answer-rate rises or the 30-day abandon rate
// nears the soft threshold; grows slowly when agents sit idle. Hard-clamped to
// [dialRatioMin, dialRatioMax]; forced to the floor at/above the soft threshold.
async function adjustDialRatio(campaignId, acfg, ctx) {
  let ratio = acfg.dialRatio;
  let reason = 'steady';
  const abandon = await campaignAbandonRate(campaignId).catch(() => 0);
  const human = _humanRate.has(campaignId) ? _humanRate.get(campaignId) : 0.3;
  if (abandon >= acfg.abandonSoft) {
    if (ratio > acfg.dialRatioMin) {
      ratio = acfg.dialRatioMin; reason = 'abandon-clamp';
      console.warn(`[engine] ALERT campaign ${String(campaignId).slice(0, 8)} abandon=${(abandon * 100).toFixed(2)}% >= soft ${(acfg.abandonSoft * 100).toFixed(2)}% — dial_ratio clamped to floor ${ratio}`);
    }
  } else if (human > 0.5 && ratio > acfg.dialRatioMin) {
    ratio = Math.max(acfg.dialRatioMin, Math.round((ratio - 0.1) * 100) / 100); reason = 'high-human-rate';
  } else if (ctx.idlePct > 0.4 && ratio < acfg.dialRatioMax) {
    ratio = Math.min(acfg.dialRatioMax, Math.round((ratio + 0.1) * 100) / 100); reason = 'agents-idle';
  }
  if (ratio !== acfg.dialRatio) {
    acfg.dialRatio = ratio;   // update the cached cfg so the change applies this tick
    sbUpdate('campaigns', `id=eq.${campaignId}`, { dial_ratio: ratio }).catch(() => {});
    _campAmdCache.delete(campaignId);   // force a re-read next TTL so we don't fight the DB value
  }
  sbLog('pacing_events', { campaign_id: campaignId, dial_ratio: ratio, available: ctx.available,
    in_flight: ctx.inFlight, placed: ctx.placed, human_rate: Math.round(human * 1000) / 1000,
    abandon_rate: Math.round(abandon * 1000) / 1000, idle_pct: Math.round(ctx.idlePct * 1000) / 1000, reason });
  return ratio;
}

// Hand a confirmed-human predictive leg to a RESERVED agent by joining it into
// that agent's standing conference (same mechanism the power lane uses, so live
// monitor / whisper keep working). On success the leg leaves dialerRt and is
// owned by rt[agentId] — later hangups resolve via findAgentByLeg into the
// normal agent WRAP_UP path. Returns true on success, false on any failure.
async function engineBridgeToAgent(agentId, ccid, info) {
  const st = rt[agentId];
  const conf = st && st.conferenceId;
  if (!st || !conf) return false;
  try {
    await telnyx('POST', `/conferences/${conf}/actions/join`,
      { call_control_id: ccid, start_conference_on_enter: true, mute: false });
    st.leadLeg = ccid;
    st.leadId = info.leadId || null;
    st.leadNumber = info.to || null;
    st.fromNumber = info.from || null;
    st.onCallSince = Date.now();
    st.state = 'ON_CALL';
    await setAgentState(agentId, 'ON_CALL');
    info.phase = 'BRIDGED';
    delete dialerRt[ccid];   // ownership transferred to the agent lane
    saveCall({ telnyx_call_control_id: ccid, bridged_at: new Date().toISOString(),
      call_phase: 'BRIDGED', reserved_agent_id: agentId, agent_id: agentId }, 'engine-bridged');
    if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`, { status: 'CONTACTED' }).catch(() => {});
    console.log(`[engine] bridged human ...${ccid.slice(-8)} -> agent ${agentId.slice(0, 8)} (idle->ON_CALL)`);
    return true;
  } catch (e) {
    console.error('[engine:bridge]', e.message);
    return false;
  }
}

// Write an agent-less disposition for an auto-handled predictive leg (machine
// kills, etc.). Correlated to the exact call leg via telnyx_call_control_id so
// the nightly AMD accuracy cross-check can meter false negatives.
function autoDisposition(info, code) {
  if (!info || !info.leadId) return;
  sbWrite('POST', 'dispositions', {
    lead_id: info.leadId, agent_id: null, campaign_id: info.campaignId || null,
    code, telnyx_call_control_id: info.ccid || null,
  }, 'return=minimal', 'auto-disposition');
}

// Revert any agent stuck in RESERVED without a landed leg. reserveLongestIdleAgent
// flips an agent to RESERVED the instant AMD says "human"; the bridge normally
// lands within a second. If the bridge fails silently (or the human hung up in
// the gap), the agent could otherwise sit RESERVED forever, starving the pacer.
const RESERVE_MAX_MS = 8000;
async function reserveReaper() {
  const now = Date.now();
  // Drop voicemail-box correlation entries once their message can't still be
  // filing (recording + transcription both land well within 10 minutes).
  for (const cc of Object.keys(vmboxRt)) {
    if (now - (vmboxRt[cc].at || 0) > 10 * 60 * 1000) delete vmboxRt[cc];
  }
  for (const id of Object.keys(rt)) {
    const st = rt[id];
    if (st && st.state === 'RESERVED' && !st.leadLeg && (now - (st.reservedAt || 0) > RESERVE_MAX_MS)) {
      st.state = 'AVAILABLE'; st.reservedAt = null;
      await setAgentState(id, 'AVAILABLE').catch(() => {});
      console.warn(`[engine] reserve-reaper freed agent ${id.slice(0, 8)} (RESERVED >${RESERVE_MAX_MS}ms, no bridge)`);
    }
  }
}

let enginePacingBusy = false;
async function enginePacingTick() {
  if (enginePacingBusy || !SB_HOST || !CONNECTION_ID) return;
  if (AMD_MODE === 'disabled') return;   // predictive REQUIRES AMD; honor the global kill-switch by not dialing at all
  enginePacingBusy = true;
  try {
    // Reclaim leaked predictive slots (missed hangup webhook) before pacing.
    for (const cc of Object.keys(dialerRt)) {
      if (Date.now() - (dialerRt[cc].at || 0) > DIALER_MAX_CALL_MS) {
        const info = dialerRt[cc]; delete dialerRt[cc];
        telnyx('POST', `/calls/${cc}/actions/hangup`, {}).catch(() => {});
        if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
          { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
        console.log(`[engine] reclaimed stale slot ...${cc.slice(-8)}`);
      }
    }
    const running = await sbSelect('campaigns', `status=eq.RUNNING&pacing_mode=eq.predictive&select=id`).catch(() => []);
    if (!running || !running.length) return;
    const nowIso = new Date().toISOString();
    for (const { id: campaignId } of running) {
      const acfg = await campaignAmd(campaignId);
      const agents = await agentIdsForCampaign(campaignId);
      // Engine runs only while >=1 agent is AVAILABLE or ON_CALL (spec §2).
      const onFloor = agents.filter(a => { const s = rt[a]; return s && (s.state === 'AVAILABLE' || s.state === 'ON_CALL' || s.state === 'RESERVED' || s.state === 'WRAP_UP'); });
      const available = agents.filter(a => { const s = rt[a]; return s && s.state === 'AVAILABLE' && s.conferenceId && !s.leadLeg; }).length;
      if (!onFloor.length) continue;
      const inFlight = campaignInFlight(campaignId);
      const idlePct = onFloor.length ? available / onFloor.length : 0;
      const ratio = await adjustDialRatio(campaignId, acfg, { available, inFlight, placed: 0, idlePct });
      // Pacing math (spec §2): ceil(available × ratio) − unresolved_in_flight.
      let toPlace = Math.ceil(available * ratio) - inFlight;
      if (toPlace <= 0) continue;
      // Never place more than a sane per-tick burst.
      toPlace = Math.min(toPlace, Math.max(1, Math.ceil(available * ratio)));
      let placed = 0;
      while (placed < toPlace) {
        const lead = await nextDialableLead([campaignId], [], nowIso);   // DNC + calling window enforced here
        if (!lead) break;
        try { await dialEngineLead(lead, acfg); placed++; }
        catch (e) { console.error('[engine:dial]', e.message); break; }
      }
      if (placed) console.log(`[engine] campaign ${String(campaignId).slice(0, 8)} placed ${placed} (avail=${available} ratio=${ratio} inflight=${inFlight})`);
    }
  } catch (e) { console.error('[enginePacing]', e.message); }
  finally { enginePacingBusy = false; }
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

// ══ AI RESULT TOOL WEBHOOK ═══════════════════════════════════════════════════════
// The assistant's `end_call` tool posts the classified outcome here, then we fast-cut
// the call to stop billing. Token-guarded like the main webhook. ccid arrives as ?cc=
// (templated from the call_control_id dynamic variable). Body: { result, reason,
// callback_hours }. We disposition the lead and set resultRecorded so the later
// call.hangup handler won't overwrite it with the generic default.
app.post('/webhooks/ai-result', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.sendStatus(403);
  // Resolve the call id from the most reliable source available. Telnyx sends
  // x-telnyx-call-control-id on webhook-tool requests; the ?cc= query is the
  // {{call_control_id}} template; body is a last resort. Any one is enough.
  const ccid = req.query.cc && !/^\{\{/.test(req.query.cc) ? req.query.cc
    : (req.headers['x-telnyx-call-control-id'] || (req.body && req.body.call_control_id) || null);
  const b = req.body || {};
  const result = String(b.result || '').trim();
  const reason = String(b.reason || '').slice(0, 500);
  const cbHours = Number.isFinite(+b.callback_hours) && +b.callback_hours > 0 ? +b.callback_hours : 72;
  res.json({ ok: true });   // ack immediately so the tool call resolves fast

  const info = ccid ? aiRt[ccid] : null;
  let leadId = info && info.leadId;
  if (!leadId && ccid) {   // slot may have been reclaimed; recover leadId from the call row
    try { const [row] = await sbSelect('calls', `telnyx_call_control_id=eq.${ccid}&select=lead_id&limit=1`); leadId = row && row.lead_id; }
    catch {}
  }
  if (info) info.resultRecorded = true;

  // Map the assistant's classification to lead state. No schema migration: everything
  // lands on existing leads columns (status/last_outcome/next_callback_at/dnc).
  let patch = null;
  switch (result.toLowerCase()) {
    case 'lead':
      patch = { status: 'CONTACTED', last_outcome: 'lead' }; break;
    case 'call back': case 'callback':
      patch = { status: 'CALLBACK', last_outcome: 'callback',
        next_callback_at: new Date(Date.now() + cbHours * 3600e3).toISOString() }; break;
    case 'not interested': case 'not_interested':
      patch = { status: 'CONTACTED', last_outcome: 'not_interested' }; break;
    case 'voicemail':
      patch = { status: 'NO_ANSWER', last_outcome: 'voicemail' }; break;
    case 'bluffer': case 'troll':
      patch = { status: 'DNC', dnc: true, last_outcome: 'bluffer' }; break;
    default:
      patch = { last_outcome: result ? result.toLowerCase().slice(0, 40) : 'unknown' };
  }
  if (leadId && patch) sbUpdate('leads', `id=eq.${leadId}`, patch).catch(e => console.error('[ai-result:lead]', e.message));
  console.log(`[ai-result] ${ccid ? ccid.slice(-8) : '-'} result=${result || '-'} cb=${cbHours}h reason="${reason.slice(0, 60)}"`);

  // End the call server-side so termination is guaranteed even if the model doesn't
  // also fire its hangup tool. Fast-cut wasteful calls (troller/voicemail) to save
  // money; give real conversations a few seconds so the closing line isn't chopped.
  const r = result.toLowerCase();
  const fast = r === 'bluffer' || r === 'troll' || r === 'voicemail';
  const delayMs = fast ? 500 : 5000;
  if (ccid) setTimeout(() => { telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {}); }, delayMs);
});

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
  sbWrite('POST', 'call_events', { event_type: event, telnyx_call_control_id: ccid, client_state: cs, payload }, 'return=minimal', 'call_events');

  try {
    // Recording saved -> archive the audio into Supabase Storage so it stays
    // playable forever. Telnyx's public URLs are presigned and die after 10 min,
    // so we can't just store one. We first write the ephemeral URL (so a call you
    // open in the next few minutes plays instantly), then copy the bytes into our
    // own bucket and rewrite recording_url to the durable `sb:` marker.
    if (event === 'call.recording.saved') {
      const recId = payload.recording_id || null;
      const url = (payload.public_recording_urls && (payload.public_recording_urls.mp3 || payload.public_recording_urls.wav)) ||
                  (payload.recording_urls && (payload.recording_urls.mp3 || payload.recording_urls.wav)) || null;
      if (ccid) saveCall({ telnyx_call_control_id: ccid, recording_url: url, recording_id: recId }, 'call-recording-saved');
      if (ccid && recId) {
        archiveCallRecording(ccid, recId, url, false)
          .then(r => console.log(`[rec-archive] ${ccid.slice(-8)} -> ${recId} (${r.bytes}B)`))
          .catch(e => console.error(`[rec-archive] ${ccid.slice(-8)}: ${e.message}`));
      }
      // Voicemail-box recording → file it into the callback queue (spec §4).
      if (ccid && vmboxRt[ccid]) {
        const vm = vmboxRt[ccid];
        sbWrite('POST', 'voicemails', { campaign_id: vm.campaignId || null, call_id: ccid,
          from_number: vm.from || null, to_number: vm.to || null, recording_url: url }, 'return=minimal', 'voicemail-insert');
        console.log(`[vmbox] filed voicemail from ${vm.from || '?'} (campaign ${String(vm.campaignId || '').slice(0, 8)})`);
      }
      return;
    }

    // Voicemail-box transcription → attach the transcript to the queued message.
    // Post-recording transcription arrives as call.recording.transcription.saved
    // with the text in payload.transcription_text (per the Telnyx callback docs).
    if (event === 'call.recording.transcription.saved' && ccid && vmboxRt[ccid]) {
      const text = payload.transcription_text || null;
      if (text) sbWrite('PATCH', `voicemails?call_id=eq.${encodeURIComponent(ccid)}`,
        { transcription: text }, 'return=minimal', 'voicemail-transcript');
      return;
    }

    // ── AI Cold Caller lane ────────────────────────────────────────────────────
    // Self-contained: no conference, no human agent. The assistant is attached
    // only on a confirmed human so voicemails never incur assistant cost.
    if (role === 'ai') {
      const info = aiRt[ccid];
      // Greet the instant the line is answered (greet_first + disabled). This
      // removes the 5-6s of dead air that made owners hang up. In greet_first,
      // premium AMD keeps running in the background and can still drop voicemails.
      if (event === 'call.answered' && (AMD_MODE === 'greet_first' || AMD_MODE === 'disabled')
          && info && info.phase === 'dialing') {
        await startAiAssistant(ccid);
        return;
      }
      // Premium AMD result. In 'premium' mode this is the gate that first attaches
      // the assistant. In 'greet_first' the assistant is already talking, so a human
      // result is a no-op and only a machine result matters — drop the voicemail.
      if (event === 'call.machine.premium.detection.ended') {
        const r = payload.result || '';
        const isHuman = r.startsWith('human') || r === 'silence' || r === 'not_sure';   // TCPA-safe
        if (isHuman) {
          if (info && info.phase === 'dialing') await startAiAssistant(ccid);   // premium mode: first attach
        } else {
          // Machine confirmed. Kill the leg even if the greeting has already
          // started (greet_first), so voicemails don't run the full assistant.
          delete aiRt[ccid];
          await telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
          if (cs.leadId) sbUpdate('leads', `id=eq.${cs.leadId}`, { status: 'MACHINE', last_outcome: 'machine' }).catch(() => {});
          saveCall({ telnyx_call_control_id: ccid, amd_result: r }, 'call-ai-machine');
          console.log(`[ai] dropped machine ${ccid ? ccid.slice(-8) : '-'} (result=${r})`);
        }
        return;
      }
      // Call ended: free the slot and disposition the lead.
      if (event === 'call.hangup') {
        const talked = info && info.phase === 'assistant';
        // Talk duration = time from assistant bridge to hangup (matches the "Talk"
        // column in the UI). Non-bridged (no-answer/machine) calls have 0s of talk.
        // Stored so the duration filter in AI Call Results has a column to match on.
        const talkSec = (info && info.bridgedAt) ? Math.max(0, Math.round((Date.now() - info.bridgedAt) / 1000)) : 0;
        const resultRecorded = !!(info && info.resultRecorded);   // end_call tool already disposed this lead
        delete aiRt[ccid];
        endAiStream(ccid);   // tear down any live-listen fork + notify listeners
        saveCall({ telnyx_call_control_id: ccid, ended_at: new Date().toISOString(),
            hangup_cause: payload.hangup_cause || null,
            duration_sec: talkSec, talk_seconds: talkSec }, 'call-ai-ended');
        if (resultRecorded) {
          // The assistant's end_call tool already wrote the definitive outcome to the
          // lead; don't clobber it with the generic ai_contacted/no_answer default.
        } else if (talked) {
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
      // ── Post-call safety net ───────────────────────────────────────────────
      // Fires AFTER call.hangup, carries the full transcript. If the assistant's
      // end_call tool never ran (seller hung up right after giving their info),
      // the lead is sitting at the generic 'ai_contacted' default and shows as
      // "Talked" even though they were interested. Re-classify from the transcript
      // and upgrade — but ONLY when end_call didn't already write a real outcome.
      if (event === 'call.conversation.ended') {
        const leadId = cs.leadId;
        if (!leadId) return;
        // Only touch leads still on a non-structured outcome. end_call always wins.
        let cur = null;
        try { const [row] = await sbSelect('leads', `id=eq.${leadId}&select=last_outcome,status&limit=1`); cur = row; } catch {}
        const STRUCTURED = ['lead','callback','not_interested','voicemail','bluffer','manual_hangup','machine'];
        const lo = (cur && cur.last_outcome || '').toLowerCase();
        if (STRUCTURED.includes(lo)) return;   // definitive result already recorded
        const guess = classifyTranscript(payload.messages || payload.transcript || []);
        if (!guess) return;
        const patch = guess === 'callback'
          ? { status: 'CALLBACK', last_outcome: 'callback', next_callback_at: new Date(Date.now() + 72 * 3600e3).toISOString() }
          : guess === 'not_interested'
            ? { status: 'CONTACTED', last_outcome: 'not_interested' }
            : { status: 'CONTACTED', last_outcome: 'lead' };
        sbUpdate('leads', `id=eq.${leadId}`, patch).catch(e => console.error('[ai-safetynet]', e.message));
        console.log(`[ai] safety-net ${ccid ? ccid.slice(-8) : '-'} transcript->${guess} (was ${lo || 'none'})`);
        return;
      }
      return;   // ignore other AI-lane events (call.initiated, ai_assistant.*, etc.)
    }

    // ── PREDICTIVE DIALER LANE (role='dialer') ─────────────────────────────────
    // Background AMD state machine. The leg is UNBRIDGED and owned by dialerRt
    // until AMD confirms a human, at which point we reserve an agent and hand the
    // leg to the standard agent lane (removing it from dialerRt). All transitions
    // are idempotent: once a ccid leaves dialerRt, later webhooks fall through.
    if (role === 'dialer' && dialerRt[ccid]) {
      const info = dialerRt[ccid];

      // DIALING → DETECTING. Do NOT bridge; wait for the AMD verdict.
      if (event === 'call.answered') {
        info.phase = 'DETECTING'; info.answeredAt = Date.now();
        saveCall({ telnyx_call_control_id: ccid, answered_at: new Date().toISOString(), call_phase: 'DETECTING' }, 'engine-detecting');
        return;
      }

      // DETECTING → route on the AMD result (premium OR standard).
      if (AMD_DETECTION_EVENTS.has(event)) {
        const r = payload.result || '';
        const cls = amdClass(r);
        const acfg = await campaignAmd(info.campaignId).catch(() => null);
        const silencePolicy = (acfg && acfg.silencePolicy) || 'human';
        const treatAs = cls === 'ambiguous' ? silencePolicy : cls;   // never default-hangup on ambiguity
        const latency = info.answeredAt ? Math.max(0, Date.now() - info.answeredAt) : null;
        saveCall({ telnyx_call_control_id: ccid, amd_result: r, amd_ended_at: new Date().toISOString(), amd_latency_ms: latency }, 'engine-amd');
        amdEvent({ call_id: info.cid, campaign_id: info.campaignId, amd_mode: info.amdMode || (cs && cs.amd) || null,
          event_type: event, result: r, latency_ms: latency, raw: payload });
        noteAnswer(info.campaignId, treatAs === 'human');

        if (treatAs === 'machine') {
          const wantVm = acfg && acfg.vmDrop && acfg.vmConsent && acfg.vmUrl;
          if (wantVm) { info.phase = 'WAIT_BEEP'; return; }   // hold for greeting.ended beep
          info.phase = 'MACHINE'; delete dialerRt[ccid];
          telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
          saveCall({ telnyx_call_control_id: ccid, call_phase: 'MACHINE', ended_at: new Date().toISOString() }, 'engine-machine');
          if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`, { status: 'MACHINE', last_outcome: 'auto_answering_machine' }).catch(() => {});
          autoDisposition(info, 'AUTO_ANSWERING_MACHINE');
          console.log(`[engine] machine ...${ccid.slice(-8)} (${r}) — leg killed, slot freed`);
          return;
        }

        // Human (or ambiguous→human): reserve an agent and bridge < 500ms.
        const agentId2 = await reserveLongestIdleAgent(info.campaignId);
        if (!agentId2) {
          // ABANDONED_HUMAN: no agent free. Play the FCC safe-harbor message
          // (company + callback, no solicitation), hang up, count the abandon.
          info.phase = 'ABANDONED'; delete dialerRt[ccid];
          if (acfg && acfg.safeHarborUrl) {
            telnyx('POST', `/calls/${ccid}/actions/playback_start`, { audio_url: acfg.safeHarborUrl }).catch(() => {});
            setTimeout(() => { telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {}); }, 15000);
          } else {
            telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
          }
          saveCall({ telnyx_call_control_id: ccid, abandoned: true, call_phase: 'ABANDONED', ended_at: new Date().toISOString() }, 'engine-abandoned');
          if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`,
            { status: 'CALLBACK', next_callback_at: new Date(Date.now() + 20 * 60e3).toISOString(), last_outcome: 'abandoned' }).catch(() => {});
          _abandonCache.delete(info.campaignId);   // force fresh abandon-rate next read
          console.warn(`[engine] ABANDONED_HUMAN ...${ccid.slice(-8)} — no agent available (safe-harbor ${acfg && acfg.safeHarborUrl ? 'played' : 'MISSING'})`);
          return;
        }
        // Bridge: hand the human leg to the reserved agent's conference.
        const ok = await engineBridgeToAgent(agentId2, ccid, info);
        if (!ok) {
          // Bridge failed — release the agent and drop the leg rather than hang.
          const s = rt[agentId2]; if (s && s.state === 'RESERVED') { s.state = 'AVAILABLE'; await setAgentState(agentId2, 'AVAILABLE'); }
          info.phase = 'ENDED'; delete dialerRt[ccid];
          telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
        }
        return;
      }

      // WAIT_BEEP → voicemail drop on the premium/standard greeting beep event.
      if (AMD_GREETING_EVENTS.has(event)) {
        const r = payload.result || '';
        const acfg = await campaignAmd(info.campaignId).catch(() => null);
        saveCall({ telnyx_call_control_id: ccid, amd_greeting: r }, 'engine-greeting');
        amdEvent({ call_id: info.cid, campaign_id: info.campaignId, amd_mode: info.amdMode || null,
          event_type: event, result: r, latency_ms: null, raw: payload });
        const wantVm = acfg && acfg.vmDrop && acfg.vmConsent && acfg.vmUrl;
        if (wantVm && r === 'beep_detected') {
          info.phase = 'VOICEMAIL'; delete dialerRt[ccid];
          telnyx('POST', `/calls/${ccid}/actions/playback_start`, { audio_url: acfg.vmUrl }).catch(() => {});
          saveCall({ telnyx_call_control_id: ccid, vm_dropped: true, call_phase: 'VOICEMAIL' }, 'engine-vm');
          if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`, { status: 'VOICEMAIL', last_outcome: 'voicemail' }).catch(() => {});
          setTimeout(() => { telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {}); }, 32000);
        } else if (r !== 'beep_detected' && r !== 'no_beep_detected') {
          // ended/prompt_ended without a beep — nothing to drop into; hang up.
          info.phase = 'MACHINE'; delete dialerRt[ccid];
          telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
          if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}`, { status: 'MACHINE', last_outcome: 'auto_answering_machine' }).catch(() => {});
        }
        return;
      }

      // Terminal / failure in any pre-bridge phase → free the slot, disposition.
      if (event === 'call.hangup') {
        delete dialerRt[ccid];
        const cause = payload.hangup_cause || null;
        saveCall({ telnyx_call_control_id: ccid, ended_at: new Date().toISOString(), hangup_cause: cause,
          call_phase: 'ENDED' }, 'engine-hangup');
        // Only mark NO_ANSWER if we never got past DETECTING (i.e. no human/machine
        // verdict was recorded). MACHINE/ABANDONED/VOICEMAIL already dispositioned.
        if (info.phase === 'DIALING' || info.phase === 'DETECTING') {
          if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
            { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
        } else if (info.phase === 'WAIT_BEEP') {
          // Machine hung up before the beep: it WAS a machine — record it so the
          // lead doesn't stay stuck IN_PROGRESS and the kill is still countable.
          if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
            { status: 'MACHINE', last_outcome: 'auto_answering_machine' }).catch(() => {});
          autoDisposition(info, 'AUTO_ANSWERING_MACHINE');
        }
        return;
      }
      return;   // ignore other dialer-lane events while unbridged
    }

    // Orphaned predictive leg: role='dialer', no dialerRt entry, and NOT owned by
    // any agent (a bridged leg resolves via findAgentByLeg and must fall through
    // to the normal agent hangup/WRAP_UP path below). This means the server
    // restarted (Render redeploy) while the call was in flight — we can no longer
    // pace, detect, or bridge it, so kill it rather than leave a human in dead air.
    if (role === 'dialer' && !dialerRt[ccid] && !agentId) {
      if (event === 'call.answered' || AMD_DETECTION_EVENTS.has(event)) {
        telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
        console.warn(`[engine] orphaned leg ...${ccid.slice(-8)} (${event}) — hung up (state lost, likely redeploy)`);
      }
      if (event === 'call.hangup' && cs && cs.leadId) {
        // No call_phase here: a deliberately-killed MACHINE/ABANDONED leg also
        // lands in this branch and must keep its recorded phase.
        saveCall({ telnyx_call_control_id: ccid, ended_at: new Date().toISOString(),
          hangup_cause: payload.hangup_cause || null }, 'engine-orphan-hangup');
        sbUpdate('leads', `id=eq.${cs.leadId}&status=eq.IN_PROGRESS`,
          { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
      }
      return;
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
        // No agent free → voicemail box (spec §4). Answer, greet, record + transcribe;
        // the recording/transcription webhooks file it into the callback queue.
        console.log(`[inbound] ${toNum} campaign ${did.campaign_id.slice(0, 8)} — no agent, sending to voicemail`);
        vmboxRt[ccid] = { campaignId: did.campaign_id, from: fromNum, to: toNum, at: Date.now() };
        saveCall({ campaign_id: did.campaign_id, telnyx_call_control_id: ccid,
          from_number: fromNum, to_number: toNum, direction: 'inbound' }, 'call-open-vmbox');
        await telnyx('POST', `/calls/${ccid}/actions/answer`, {
          client_state: enc({ role: 'vmbox', campaignId: did.campaign_id, from: fromNum, to: toNum }),
        }).catch(() => {});
        return;
      }
      const st = rt[chosen];
      st.state = 'ON_CALL';                     // reserve so the pacer skips this agent
      await setAgentState(chosen, 'ON_CALL');
      await telnyx('POST', `/calls/${ccid}/actions/answer`, {
        client_state: enc({ role: 'inbound', agentId: chosen, conf: st.conferenceId, campaignId: did.campaign_id, from: fromNum }),
      });
      saveCall({ agent_id: chosen, campaign_id: did.campaign_id,
        telnyx_call_control_id: ccid, from_number: fromNum, to_number: toNum, direction: 'inbound' }, 'call-open-inbound');
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
        saveCall({ telnyx_call_control_id: ccid, bridged_at: new Date().toISOString() }, 'call-bridged-inbound');
        console.log(`[inbound] agent ${agentId.slice(0, 8)} ON_CALL (bridged inbound)`);
      }
      return;
    }

    // ── Voicemail box: inbound call answered with no free agent (spec §4) ───────
    // Greet the caller, then record + transcribe. call.recording.saved and
    // call.transcription file the message into public.voicemails (callback queue).
    if (event === 'call.answered' && role === 'vmbox') {
      const greet = 'Thank you for calling. We are unable to take your call right now. '
        + 'Please leave your name, number, and a brief message after the tone, and we will call you back.';
      try {
        await telnyx('POST', `/calls/${ccid}/actions/speak`,
          { payload: greet, voice: 'female', language: 'en-US' });
        await telnyx('POST', `/calls/${ccid}/actions/record_start`,
          { format: 'mp3', channels: 'single', transcription: true, transcription_engine: 'B' });
        console.log(`[vmbox] recording started ...${ccid.slice(-8)}`);
      } catch (e) { console.error('[vmbox:start]', e.message); }
      // Auto-hangup as a safety net so a silent line can't hold the leg open.
      setTimeout(() => { telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {}); }, 120000);
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

    // Lead answered -> bridge to the agent IMMEDIATELY, regardless of AMD mode.
    // Waiting for premium AMD to confirm a human before joining leaves several
    // seconds of dead air on every live call (and total silence if the premium
    // AMD event never fires because it isn't enabled on the connection) — which
    // is exactly the "calls come in silent" symptom. Premium AMD still runs in
    // parallel and drops the leg below if it turns out to be a machine.
    if (event === 'call.answered' && role === 'lead' && agentId) {
      // Instrumentation: stamp the answer time so detection.ended can compute AMD
      // latency, and so the FCC abandoned-rate denominator has an answered_at.
      const nowIso = new Date().toISOString();
      const st0 = rt[agentId];
      if (st0 && st0.pending && st0.pending[ccid]) st0.pending[ccid].answeredAt = Date.now();
      saveCall({ telnyx_call_control_id: ccid, answered_at: nowIso }, 'call-answered-at');
      await connectLeadLeg(agentId, ccid, cs, null);   // AMD result (if any) is filled in by detection.ended below
      return;
    }

    // Lead AMD detection result (premium OR standard). The leg is already bridged
    // (we connect on answer). Two behaviors, selected per-campaign:
    //   • DEFAULT (gated_bridge=false): auto hang-up is DISABLED. Premium AMD is
    //     unreliable — it drops live humans (false positives) while missing real
    //     voicemails (false negatives). We NEVER tear the leg down automatically;
    //     the agent decides. We only record the classification + latency and count
    //     MD for the Live stats tab's visibility.
    //   • gated_bridge=true (opt-in, verify accuracy first): a machine result hangs
    //     up the leg (no agent time wasted); ambiguous is routed by silence_policy.
    // Instrumentation (amd_result/amd_ended_at/amd_latency_ms + amd_events row) is
    // ALWAYS recorded so scripts/amd_test.py can measure real-world accuracy.
    if (AMD_DETECTION_EVENTS.has(event) && role === 'lead' && agentId) {
      const r = payload.result || '';
      const cls = amdClass(r);   // 'human' | 'machine' | 'ambiguous'
      const st = rt[agentId];
      const info = (st && st.pending && st.pending[ccid]) || null;
      const answeredAt = info && info.answeredAt;
      const endedAtMs = Date.now();
      const latency = answeredAt ? Math.max(0, endedAtMs - answeredAt) : null;
      const silencePolicy = (info && info.silencePolicy) || 'human';
      const gated = !!(info && info.gatedBridge);
      // Effective routing class: ambiguous follows the campaign's silence_policy.
      const treatAs = cls === 'ambiguous' ? silencePolicy : cls;
      const endedIso = new Date(endedAtMs).toISOString();
      // Always: persist verbatim result + latency, emit an amd_events audit row.
      if (ccid) saveCall({ telnyx_call_control_id: ccid, amd_result: r,
        amd_ended_at: endedIso, amd_latency_ms: latency }, treatAs === 'human' ? 'call-amd-human' : 'call-amd-machine');
      amdEvent({ call_id: (info && info.cid) || null, campaign_id: (info && info.campaignId) || (cs && cs.campaignId) || null,
        amd_mode: (info && info.amdMode) || (cs && cs.amd) || null, event_type: event, result: r, latency_ms: latency, raw: payload });
      if (treatAs !== 'human') {
        const pid = (info && info.playlistId) || (st && st.leadLeg === ccid ? st.leadPlaylistId : null);
        plStat(pid).md++;
      }
      // Gated-bridge routing only. Default mode keeps the leg for the agent.
      if (gated && treatAs === 'machine') {
        // A machine on a bridged leg: if the campaign has consented VM drop we hold
        // for the greeting/beep (handled below); otherwise hang up now. Either way
        // the agent shouldn't stay tied to a machine.
        const acfg = await campaignAmd(info && info.campaignId).catch(() => null);
        const wantVm = acfg && acfg.vmDrop && acfg.vmConsent && acfg.vmUrl;
        if (!wantVm) {
          if (st && st.leadLeg === ccid) { st.leadLeg = null; st.onCallSince = null; }
          telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
          if (info && info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
            { status: 'MACHINE', last_outcome: 'machine' }).catch(() => {});
        }
        // wantVm: leave the leg up; call.machine.*.greeting.ended handles the drop.
      }
      return;
    }

    // Lead AMD greeting result (premium OR standard). Only actionable when the
    // campaign opted into gated_bridge WITH consented voicemail drop. On a detected
    // beep we play the pre-recorded drop then hang up; otherwise we hang up the
    // machine leg. In default mode this is purely informational (amd_greeting).
    if (AMD_GREETING_EVENTS.has(event) && role === 'lead' && agentId) {
      const r = payload.result || '';
      const st = rt[agentId];
      const info = (st && st.pending && st.pending[ccid]) || null;
      if (ccid) saveCall({ telnyx_call_control_id: ccid, amd_greeting: r }, 'call-amd-greeting');
      amdEvent({ call_id: (info && info.cid) || null, campaign_id: (info && info.campaignId) || (cs && cs.campaignId) || null,
        amd_mode: (info && info.amdMode) || (cs && cs.amd) || null, event_type: event, result: r, latency_ms: null, raw: payload });
      const gated = !!(info && info.gatedBridge);
      if (!gated) return;   // default mode: record only, agent still owns the call
      const acfg = await campaignAmd(info && info.campaignId).catch(() => null);
      const wantVm = acfg && acfg.vmDrop && acfg.vmConsent && acfg.vmUrl;
      const beep = r === 'beep_detected';
      if (wantVm && beep) {
        // Voicemail drop: compliance gates already cleared at dial time (DNC filtered
        // by nextDialableLead; calling window by callableNow). Play then hang up.
        telnyx('POST', `/calls/${ccid}/actions/playback_start`, { audio_url: acfg.vmUrl }).catch(() => {});
        if (ccid) saveCall({ telnyx_call_control_id: ccid, vm_dropped: true }, 'call-vm-dropped');
        if (info && info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
          { status: 'VOICEMAIL', last_outcome: 'voicemail' }).catch(() => {});
        // Give the drop room to play; playback.ended would be cleaner but a timed
        // hangup is robust to a missed webhook.
        setTimeout(() => { telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {}); }, 32000);
      } else {
        // No beep / no consent path in gated mode: don't leave the agent on a machine.
        if (st && st.leadLeg === ccid) { st.leadLeg = null; st.onCallSince = null; }
        telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
        if (info && info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
          { status: 'MACHINE', last_outcome: 'machine' }).catch(() => {});
      }
      return;
    }

    // ── AMD accuracy harness lane (role='amdtest') ─────────────────────────────
    // scripts/amd_test.py dials numbers with a known expected label, no agent and
    // no conference. We record the verbatim result + latency to amd_events/calls
    // and hang up immediately so the harness can score accuracy offline.
    if (role === 'amdtest') {
      if (event === 'call.answered') {
        saveCall({ telnyx_call_control_id: ccid, answered_at: new Date().toISOString() }, 'amdtest-answered');
        if (cs) cs._answeredAt = Date.now();
        return;
      }
      if (AMD_DETECTION_EVENTS.has(event)) {
        const r = payload.result || '';
        saveCall({ telnyx_call_control_id: ccid, amd_result: r, amd_ended_at: new Date().toISOString() }, 'amdtest-result');
        amdEvent({ call_id: (cs && cs.cid) || null, campaign_id: (cs && cs.campaignId) || null,
          amd_mode: (cs && cs.amd) || null, event_type: event, result: r, latency_ms: null, raw: payload });
        telnyx('POST', `/calls/${ccid}/actions/hangup`, {}).catch(() => {});
        return;
      }
      if (AMD_GREETING_EVENTS.has(event)) {
        const r = payload.result || '';
        saveCall({ telnyx_call_control_id: ccid, amd_greeting: r }, 'amdtest-greeting');
        amdEvent({ call_id: (cs && cs.cid) || null, campaign_id: (cs && cs.campaignId) || null,
          amd_mode: (cs && cs.amd) || null, event_type: event, result: r, latency_ms: null, raw: payload });
        return;
      }
      if (event === 'call.hangup') return;
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
        if (ccid) saveCall({ telnyx_call_control_id: ccid,
          ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }, 'call-ended-pending');
        if (info.leadId) sbUpdate('leads', `id=eq.${info.leadId}&status=eq.IN_PROGRESS`,
          { status: 'NO_ANSWER', last_outcome: 'no_answer' }).catch(() => {});
        const idle = !st.leadLeg && Object.keys(st.pending).length === 0;
        if (idle && st.state === 'DIALING') { st.state = 'AVAILABLE'; await setAgentState(agentId, 'AVAILABLE'); }
        return;
      }
      const wasLead = st.leadLeg === ccid || (role === 'lead' && st.leadLeg == null);
      if (wasLead) {
        if (ccid) endAiStream(ccid);   // notify + close any live-monitor listeners on this leg
        const talked = st.state === 'ON_CALL';   // agent actually spoke to a human
        if (ccid) saveCall({ telnyx_call_control_id: ccid,
          ended_at: new Date().toISOString(), hangup_cause: payload.hangup_cause || null }, 'call-ended-lead');
        const wasInbound = st.inbound === true;
        st.leadLeg = null; st.leadNumber = null; st.fromNumber = null; st.onCallSince = null;
        if (wasInbound) {
          // Inbound calls have no lead to disposition — return straight to AVAILABLE.
          st.inbound = false; st.leadId = null;
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
// All three WS servers run in noServer mode and share ONE upgrade router below —
// attaching multiple { server, path } WSS to one HTTP server makes each non-matching
// server abortHandshake() the socket, which would kill the others' connections.
const wss = new WebSocketServer({ noServer: true });
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
  if (user.role === 'admin' || user.role === 'support') {
    for (const id of Object.keys(rt)) wsSend(ws, { type: 'floor.agent', ...agentSnapshot(id) });
  } else {
    wsSend(ws, { type: 'agent.state', ...agentSnapshot(user.id) });
  }
  wsSend(ws, { type: 'hello', role: user.role, ts: Date.now() });
});
// Heartbeat: drop dead sockets.
setInterval(() => { for (const c of wsClients) { try { c.ws.ping(); } catch {} } }, 30 * 1000);

// ── Live AI audio: Telnyx media fork ingress ─────────────────────────────────────
// Telnyx connects here (URL we handed it in streaming_start) and streams the call's
// audio as JSON frames: {event:'media', media:{track, payload:<base64 μ-law 8k>}}.
// We prefix each payload with a track byte (0=inbound/contact, 1=outbound/AI) and
// relay the raw μ-law bytes as a binary frame to every browser listening to this call.
const mediaWss = new WebSocketServer({ noServer: true });
mediaWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const ccid = url.searchParams.get('ccid');
  const st = ccid && aiStreams.get(ccid);
  if (!st || url.searchParams.get('k') !== streamKey(ccid)) { ws.close(4003, 'forbidden'); return; }
  st.telnyxWs = ws;
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === 'media' && msg.media && msg.media.payload) {
      const track = msg.media.track === 'outbound' ? 1 : 0;
      const pcm = Buffer.from(msg.media.payload, 'base64');
      const frame = Buffer.concat([Buffer.from([track]), pcm]);
      const s = aiStreams.get(ccid);
      if (s) for (const l of s.listeners) { if (l.readyState === 1) { try { l.send(frame); } catch {} } }
    }
  });
  ws.on('close', () => { const s = aiStreams.get(ccid); if (s && s.telnyxWs === ws) s.telnyxWs = null; });
  ws.on('error', () => {});
});

// ── Live AI audio: admin browser egress ──────────────────────────────────────────
// Admin opens /ws/ai-listen?token=<jwt>&ccid=<ccid> to hear a live AI call. First
// listener triggers the Telnyx fork; last listener leaving stops it.
const listenWss = new WebSocketServer({ noServer: true });
listenWss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://x');
  let user; try { user = jwt.verify(url.searchParams.get('token'), JWT_SECRET); } catch { ws.close(4001, 'unauthorized'); return; }
  if (user.role !== 'admin') { ws.close(4003, 'forbidden'); return; }
  const ccid = url.searchParams.get('ccid');
  if (!ccid || !aiRt[ccid]) { try { ws.send(JSON.stringify({ event: 'error', error: 'call is not live' })); } catch {} ws.close(); return; }
  let st = aiStreams.get(ccid);
  if (!st) { st = { listeners: new Set(), telnyxWs: null, starting: false }; aiStreams.set(ccid, st); }
  st.listeners.add(ws);
  try { ws.send(JSON.stringify({ event: 'ready', sampleRate: 8000, codec: 'PCMU' })); } catch {}
  if (!st.telnyxWs && !st.starting) {
    st.starting = true;
    try { await startAiStream(ccid); }
    catch (e) { try { ws.send(JSON.stringify({ event: 'error', error: e.message })); } catch {} }
    finally { const s = aiStreams.get(ccid); if (s) s.starting = false; }
  }
  ws.on('close', () => {
    const s = aiStreams.get(ccid);
    if (!s) return;
    s.listeners.delete(ws);
    if (s.listeners.size === 0 && aiRt[ccid]) stopAiStream(ccid);   // call still live → stop the fork
    else if (s.listeners.size === 0) aiStreams.delete(ccid);
  });
  ws.on('error', () => {});
});

// ── Live agent-call monitoring: supervisor browser egress ────────────────────────
// A supervisor (admin, or support with floor.monitor) opens
// /ws/monitor?token=<jwt>&agentId=<uuid> to listen in on that agent's live call.
// We resolve the agent's current lead leg (rt[agentId].leadLeg) and reuse the same
// Telnyx media-fork pipeline as AI monitoring — no supervisor softphone needed.
const monitorWss = new WebSocketServer({ noServer: true });
monitorWss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://x');
  let user; try { user = jwt.verify(url.searchParams.get('token'), JWT_SECRET); } catch { ws.close(4001, 'unauthorized'); return; }
  if (!userCan(user, 'floor.monitor')) { ws.close(4003, 'forbidden'); return; }
  const agentId = url.searchParams.get('agentId');
  const ast = agentId && rt[agentId];
  const ccid = ast && ast.state === 'ON_CALL' ? ast.leadLeg : null;
  if (!ccid) { try { ws.send(JSON.stringify({ event: 'error', error: 'agent is not on a live call' })); } catch {} ws.close(); return; }
  let st = aiStreams.get(ccid);
  if (!st) { st = { listeners: new Set(), telnyxWs: null, starting: false }; aiStreams.set(ccid, st); }
  st.listeners.add(ws);
  try { ws.send(JSON.stringify({ event: 'ready', sampleRate: 8000, codec: 'PCMU' })); } catch {}
  if (!st.telnyxWs && !st.starting) {
    st.starting = true;
    try { await startAiStream(ccid); }
    catch (e) { try { ws.send(JSON.stringify({ event: 'error', error: e.message })); } catch {} }
    finally { const s = aiStreams.get(ccid); if (s) s.starting = false; }
  }
  audit(user, 'MONITOR_CALL', { target_type: 'agent', target_id: agentId });
  ws.on('close', () => {
    const s = aiStreams.get(ccid);
    if (!s) return;
    s.listeners.delete(ws);
    // Call still live (leg unchanged) → stop the fork to save spend; else just drop.
    const stillLive = rt[agentId] && rt[agentId].leadLeg === ccid;
    if (s.listeners.size === 0 && stillLive) stopAiStream(ccid);
    else if (s.listeners.size === 0) aiStreams.delete(ccid);
  });
  ws.on('error', () => {});
});

// Single upgrade router: pick the right WS server by pathname, or drop the socket.
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { socket.destroy(); return; }
  const target = pathname === '/ws' ? wss
    : pathname === '/telnyx-media' ? mediaWss
    : pathname === '/ws/ai-listen' ? listenWss
    : pathname === '/ws/monitor' ? monitorWss
    : null;
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

// Global crash guards — a single stray rejection/throw must never take the whole
// dialer down mid-shift. Log loudly, keep serving. (Telnyx webhooks, WS handlers
// and fire-and-forget writes are the usual sources.)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

server.listen(PORT, async () => {
  console.log(`Trinity Dialer (phase0) listening on :${PORT}`);
  await bootstrapAdmin();
  await loadPermCache();
  await rehydrateRt();
  await refreshCallerPool();
  await loadCallingWindow();
  await loadDialerConfig();
  await loadCallPolicy();
  await loadAiConfig();
  console.log(`[boot] caller pool: ${CALLER_POOL.join(', ') || '(none)'}`);
  {
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const overrides = Object.keys(CALLING.states).length;
    const disabled = Object.values(CALLING.states).filter(s => s.enabled === false).length;
    console.log(`[boot] calling window: default ${hhmm(CALLING.default.start)}–${hhmm(CALLING.default.end)} per-state lead-local (${overrides} override(s), ${disabled} disabled)`);
  }
  console.log(`[boot] dialer: ${DIALER.lines_per_agent} line(s)/agent, ${DIALER.ring_secs}s ring`);
  console.log(`[boot] ai caller: ${AI.enabled ? 'ENABLED' : 'off'}, concurrency ${AI.concurrency}, ${AI.campaign_ids.length} campaign(s), assistant ${AI.assistant_id || '(none)'}`);
  setInterval(pacingTick, PACING_MS);
  setInterval(aiPacingTick, PACING_MS);   // AI Cold Caller lane (independent of human agents)
  setInterval(enginePacingTick, PACING_MS);   // predictive (background AMD) lane, per campaign pacing_mode='predictive'
  setInterval(reserveReaper, 5 * 1000);       // revert agents stuck in RESERVED (bridge that never landed)
  setInterval(flushOutbox, 5 * 1000);     // drain any Supabase writes that failed, at-least-once
  setInterval(reaperTick, 30 * 1000);
  setInterval(refreshCallerPool, 5 * 60 * 1000);
  setInterval(loadCallingWindow, 5 * 60 * 1000);
  setInterval(loadDialerConfig, 60 * 1000);
  setInterval(loadCallPolicy, 60 * 1000);
  setInterval(loadAiConfig, 60 * 1000);
  sweepExpiredDnc();
  setInterval(sweepExpiredDnc, 10 * 60 * 1000);   // auto-remove expired (e.g. 90-day) DNC entries
  reconcileRecordings();                          // archive any recordings that slipped through
  setInterval(reconcileRecordings, 3 * 60 * 1000);
  setTimeout(amdNightlyCrossCheck, 60 * 1000);    // first pass a minute after boot
  setInterval(amdNightlyCrossCheck, 24 * 3600 * 1000);   // AMD accuracy vs disposition, daily
});
