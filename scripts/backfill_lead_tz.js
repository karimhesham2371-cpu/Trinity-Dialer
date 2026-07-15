// One-off: backfill timezone + area_code on legacy leads that have null timezone.
// Uses the same area-code map as the importer. Safe to re-run (only touches null tz).
const { deriveFromAreaCode } = require('../lib/areacodes');

const SB_HOST = process.env.SUPABASE_HOST || 'eeyblcqghibycgslnxix.supabase.co';
const SB_KEY  = process.env.SUPABASE_KEY;
if (!SB_KEY) { console.error('set SUPABASE_KEY'); process.exit(1); }
const BASE = `https://${SB_HOST}/rest/v1`;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

function areaCodeOf(e164) {
  const d = String(e164 || '').replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1, 4);
  if (d.length === 10) return d.slice(0, 3);
  return null;
}

async function main() {
  // Page through all null-timezone leads.
  const all = [];
  let offset = 0;
  for (;;) {
    const r = await fetch(`${BASE}/leads?timezone=is.null&select=id,phone&order=id.asc&limit=1000&offset=${offset}`, { headers: H });
    if (!r.ok) throw new Error(`fetch ${r.status}: ${await r.text()}`);
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  console.log(`null-timezone leads: ${all.length}`);
  if (!all.length) return;

  // Group by (area_code, tz) so each group is one PATCH.
  const groups = new Map(); // key `${ac}|${tz}` -> { ac, tz, ids: [] }
  for (const l of all) {
    const ac = areaCodeOf(l.phone);
    const { tz } = deriveFromAreaCode(ac);
    const key = `${ac}|${tz}`;
    if (!groups.has(key)) groups.set(key, { ac, tz, ids: [] });
    groups.get(key).ids.push(l.id);
  }
  console.log(`groups: ${groups.size}`);

  let done = 0;
  for (const { ac, tz, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const inList = chunk.map(id => `"${id}"`).join(',');
      const body = { timezone: tz };
      if (ac) body.area_code = ac;
      const r = await fetch(`${BASE}/leads?id=in.(${inList})`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`patch ${r.status}: ${await r.text()}`);
      done += chunk.length;
    }
    console.log(`ac=${ac || '(unknown)'} tz=${tz} -> ${ids.length}`);
  }
  console.log(`backfilled ${done} leads`);
}
main().catch(e => { console.error(e); process.exit(1); });
