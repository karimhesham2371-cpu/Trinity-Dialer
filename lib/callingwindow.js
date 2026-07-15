// Per-state (ReadyMode-style) calling-window support.
//
// Each US state + DC maps to ONE canonical IANA timezone (split states pick the
// dominant zone, same convention ReadyMode uses — e.g. Florida = Eastern even
// though the panhandle is Central). The admin can, per state: disable it (never
// dial numbers in that state) or override the start/end time; an unset override
// inherits the "queue default" window. Times are evaluated in the STATE's own
// timezone, with DST handled automatically by Intl.
//
// Config is stored as minutes-since-local-midnight (0..1439) so half-hour windows
// like 8:30 are representable. 10:00 = 600, 21:00 = 1260.

const STATES = [
  { abbr: 'AL', name: 'Alabama',        tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'AK', name: 'Alaska',         tz: 'America/Anchorage',   label: 'Alaska' },
  { abbr: 'AZ', name: 'Arizona',        tz: 'America/Phoenix',     label: 'Phoenix' },
  { abbr: 'AR', name: 'Arkansas',       tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'CA', name: 'California',     tz: 'America/Los_Angeles', label: 'PST' },
  { abbr: 'CO', name: 'Colorado',       tz: 'America/Denver',      label: 'MST' },
  { abbr: 'CT', name: 'Connecticut',    tz: 'America/New_York',    label: 'EST' },
  { abbr: 'DC', name: 'D.C.',           tz: 'America/New_York',    label: 'EST' },
  { abbr: 'DE', name: 'Delaware',       tz: 'America/New_York',    label: 'EST' },
  { abbr: 'FL', name: 'Florida',        tz: 'America/New_York',    label: 'EST' },
  { abbr: 'GA', name: 'Georgia',        tz: 'America/New_York',    label: 'EST' },
  { abbr: 'HI', name: 'Hawaii',         tz: 'Pacific/Honolulu',    label: 'Hawaii' },
  { abbr: 'ID', name: 'Idaho',          tz: 'America/Denver',      label: 'MST' },
  { abbr: 'IL', name: 'Illinois',       tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'IN', name: 'Indiana',        tz: 'America/New_York',    label: 'EST' },
  { abbr: 'IA', name: 'Iowa',           tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'KS', name: 'Kansas',         tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'KY', name: 'Kentucky',       tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'LA', name: 'Louisiana',      tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'ME', name: 'Maine',          tz: 'America/New_York',    label: 'EST' },
  { abbr: 'MD', name: 'Maryland',       tz: 'America/New_York',    label: 'EST' },
  { abbr: 'MA', name: 'Massachusetts',  tz: 'America/New_York',    label: 'EST' },
  { abbr: 'MI', name: 'Michigan',       tz: 'America/Detroit',     label: 'EST' },
  { abbr: 'MN', name: 'Minnesota',      tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'MS', name: 'Mississippi',    tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'MO', name: 'Missouri',       tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'MT', name: 'Montana',        tz: 'America/Denver',      label: 'MST' },
  { abbr: 'NE', name: 'Nebraska',       tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'NV', name: 'Nevada',         tz: 'America/Los_Angeles', label: 'PST' },
  { abbr: 'NH', name: 'New Hampshire',  tz: 'America/New_York',    label: 'EST' },
  { abbr: 'NJ', name: 'New Jersey',     tz: 'America/New_York',    label: 'EST' },
  { abbr: 'NM', name: 'New Mexico',     tz: 'America/Denver',      label: 'MST' },
  { abbr: 'NY', name: 'New York',       tz: 'America/New_York',    label: 'EST' },
  { abbr: 'NC', name: 'North Carolina', tz: 'America/New_York',    label: 'EST' },
  { abbr: 'ND', name: 'North Dakota',   tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'OH', name: 'Ohio',           tz: 'America/New_York',    label: 'EST' },
  { abbr: 'OK', name: 'Oklahoma',       tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'OR', name: 'Oregon',         tz: 'America/Los_Angeles', label: 'PST' },
  { abbr: 'PA', name: 'Pennsylvania',   tz: 'America/New_York',    label: 'EST' },
  { abbr: 'RI', name: 'Rhode Island',   tz: 'America/New_York',    label: 'EST' },
  { abbr: 'SC', name: 'South Carolina', tz: 'America/New_York',    label: 'EST' },
  { abbr: 'SD', name: 'South Dakota',   tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'TN', name: 'Tennessee',      tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'TX', name: 'Texas',          tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'UT', name: 'Utah',           tz: 'America/Denver',      label: 'MST' },
  { abbr: 'VT', name: 'Vermont',        tz: 'America/New_York',    label: 'EST' },
  { abbr: 'VA', name: 'Virginia',       tz: 'America/New_York',    label: 'EST' },
  { abbr: 'WA', name: 'Washington',     tz: 'America/Los_Angeles', label: 'PST' },
  { abbr: 'WV', name: 'West Virginia',  tz: 'America/New_York',    label: 'EST' },
  { abbr: 'WI', name: 'Wisconsin',      tz: 'America/Chicago',     label: 'CST' },
  { abbr: 'WY', name: 'Wyoming',        tz: 'America/Denver',      label: 'MST' },
];

const STATE_BY_ABBR = Object.fromEntries(STATES.map(s => [s.abbr, s]));

const DEFAULT_WINDOW = { start: 600, end: 1260 };   // 10:00 AM – 9:00 PM
// Westernmost contiguous-US zone: used for leads whose state can't be determined,
// so we never dial before the window opens somewhere in the lower 48.
const FALLBACK_TZ = 'America/Los_Angeles';

// Minutes since local midnight (0..1439) in an IANA zone, or null if Intl breaks.
function localMinutes(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    let h = 0, m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10);
      if (p.type === 'minute') m = parseInt(p.value, 10);
    }
    if (h === 24) h = 0;
    return h * 60 + m;
  } catch { return null; }
}

// Clamp/parse a minutes value; returns null for blank/invalid.
function toMinutes(v) {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1439) return null;
  return n;
}

module.exports = { STATES, STATE_BY_ABBR, DEFAULT_WINDOW, FALLBACK_TZ, localMinutes, toMinutes };
