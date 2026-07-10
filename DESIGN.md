# Trinity Dialer — Design Specification

> Follow this file exactly for all UI work. Every color, font, and spacing value
> comes from this token system. Do not introduce values outside it.

## 1. Design intent
Trinity is an operator tool. Agents live in it for 6–8 hour shifts; admins watch a
live floor. The design goal is **calm density**: dark, low-glare, quiet surfaces,
with attention pulled only by things that are *live* (active calls, ticking timers,
state changes). Nothing decorative. If an element isn't data, a control, or a label,
it shouldn't exist.

This is NOT the LeadMamba marketing brand. LeadMamba rules (Montserrat 900,
#031124/#F5C518, no green/red) apply to LeadMamba surfaces only. Trinity is a
sibling product with its own restrained identity — the gold accent is the only
family resemblance. Status colors (green/amber/red) are required here because they
carry operational meaning.

## 2. Color tokens
Backgrounds are near-black with a cold navy cast (reduces glare on long shifts
vs. pure black, and makes the status colors read cleanly).

```css
:root {
  /* Surfaces */
  --bg:            #0B0E14;   /* app background */
  --surface:       #11151D;   /* cards, panels */
  --surface-2:     #171C26;   /* raised elements: modals, dropdowns, table header */
  --border:        rgba(255,255,255,0.07);
  --border-strong: rgba(255,255,255,0.14);  /* focused inputs, active cards */
  /* Text */
  --text:          #E6EAF2;   /* primary */
  --text-dim:      #8A93A6;   /* labels, secondary, timestamps */
  --text-faint:    #566072;   /* placeholders, disabled */
  /* Accent — one only */
  --accent:        #E8B33D;   /* desaturated gold. Primary buttons, active nav,
                                 focus rings, live-telemetry glow */
  --accent-hover:  #F2C45C;
  --accent-ink:    #14100A;   /* text on accent backgrounds */
  /* Status — semantic only, never decorative */
  --ok:            #34C77B;   /* available, connected, running */
  --warn:          #E8A13D;   /* wrap-up, paused, callback due */
  --danger:        #E5544B;   /* stop, DNC, error, abandoned */
  --info:          #5B8DEF;   /* dialing/ringing ONLY. Nowhere else. */
  /* Status tints (backgrounds behind status text/pills) */
  --ok-tint:       rgba(52,199,123,0.12);
  --warn-tint:     rgba(232,161,61,0.12);
  --danger-tint:   rgba(229,84,75,0.12);
  --info-tint:     rgba(91,141,239,0.12);
}
```

Rules:
- Accent gold appears on at most **one primary action per view**. Everything else
  is a quiet secondary button.
- Status colors appear ONLY on: state pills, state dots, the four campaign
  transport buttons (Start/Pause/Stop/Reset), and chart segments tied to those
  states. Never on headings, borders-at-rest, or icons for flavor.
- No gradients anywhere. No pure #000 or #FFF.

## 3. Typography
```css
/* UI face: IBM Plex Sans — built for tooling, more character than Inter */
/* Numeric/data face: IBM Plex Mono — ALL live numbers, phone numbers, timers, IDs */
--font-ui:   "IBM Plex Sans", system-ui, sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, monospace;
```

| Role                | Font | Size | Weight | Notes |
|---------------------|------|------|--------|-------|
| Page title          | Plex Sans | 20px | 600 | One per page. Letter-spacing -0.01em |
| Section/card title  | Plex Sans | 14px | 600 | |
| Body / cell text    | Plex Sans | 13.5px | 400 | line-height 1.5 |
| Labels / eyebrows   | Plex Sans | 11px | 500 | uppercase, letter-spacing 0.06em, --text-dim |
| Phone numbers       | Plex Mono | 13.5px | 400 | always mono, always `font-variant-numeric: tabular-nums` |
| Live timers/counters| Plex Mono | inherit | 500 | tabular-nums so digits don't jitter |
| Big stat values     | Plex Mono | 26px | 500 | with an 11px label above |

The mono treatment for every numeric/live value is a hard rule — it's what makes
the product feel like an instrument instead of a website.

## 4. The signature: live telemetry treatment
The one memorable element. Anything currently *live* gets this exact treatment,
and nothing else does:
- **State dot**: 8px circle before the state label. Solid at rest. When the state
  is active (On Call, Dialing, campaign Running), the dot pulses:
  `box-shadow: 0 0 0 0 → 0 0 0 6px transparent` over 1.6s, using the state's color
  at 40% alpha. `animation-iteration-count: infinite`.
- **Ticking timers** (talk time, wrap-up countdown): Plex Mono, --text at rest;
  while ticking, color shifts to the relevant status color and the last-changed
  digit does NOT animate (no flip effects — just clean tabular ticking).
- **Live rows** (agent currently on a call in the floor view): left border 2px in
  the status color, background = that status tint.

Respect `prefers-reduced-motion`: pulses become a static 2px ring.

## 5. Layout & spacing
- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48. Nothing off-scale.
- Card padding: 24px. Card gap: 16px. Page gutter: 32px (16px under 768px).
- Border radius: 10px cards/modals, 8px buttons/inputs, 999px pills. Nothing else.
- Max content width: none for the floor view (it's a dashboard — use the space);
  forms max out at 480px.
- Tables: header row on --surface-2, 11px uppercase labels, rows 44px tall,
  row hover = --surface-2, 1px --border row dividers only (no vertical rules).
- Agent screen is a fixed 3-panel grid: script 280px | lead card 1fr | controls 320px,
  collapsing to stacked tabs under 1100px.

## 6. Components
**Buttons**
- Primary: --accent bg, --accent-ink text, 8px radius, 36px height, 600 weight.
  Hover: --accent-hover. One per view.
- Secondary: transparent bg, 1px --border-strong, --text. Hover: --surface-2.
- Destructive: only for genuinely destructive acts. --danger-tint bg,
  --danger text at rest; solid --danger with white text on hover.
- Transport row (Start/Pause/Stop/Reset): equal-width secondary-style buttons whose
  text+icon take the status color; the ACTIVE one gets that status tint as bg.
  Never four solid colored slabs (current UI's biggest tell).

**Inputs / selects / file upload**
- 36px height, --surface bg, 1px --border, 8px radius. Focus: 1px --accent border
  + 3px ring rgba(232,179,61,0.18). Placeholder --text-faint.
- Replace ALL native controls: custom select (styled listbox), and the file input
  becomes a drop zone: dashed 1px --border-strong, "Drop leads CSV or browse",
  showing filename + row count after parse.

**Pills (states)**
- 999px radius, 22px height, 11px 600 uppercase, dot + label,
  status tint bg + status color text. OFFLINE uses --text-faint on --surface-2.

**Toasts**: bottom-right, --surface-2, 1px --border-strong, status-colored left
edge 2px, auto-dismiss 4s. Text says exactly what happened: "Campaign started",
"237 duplicates removed".

**Empty states**: icon-free. One dim sentence + one secondary button.
"No campaigns yet. Create one to upload leads." — never an illustration.

**Modals**: --surface-2, 10px radius, 1px --border-strong, backdrop
rgba(4,6,10,0.7). No blur (perf on long-running tabs).

## 7. Motion
- Durations: 120ms (hover), 180ms (open/close), ease-out. Nothing longer except
  the 1.6s telemetry pulse.
- Panels/modals: fade + 4px translate. No slides, no bounces, no page transitions.
- Numbers never animate their value (no count-up effects) — this is live ops data,
  fake motion undermines trust.

## 8. Voice (microcopy)
- Sentence case everywhere. Buttons say what happens: "Create campaign",
  "Assign agent", "Upload leads". Same verb persists into the toast.
- Errors state cause + fix: "CSV missing a phone column. Map a column to Phone
  and re-upload." Never "Something went wrong."
- Agents "go available", campaigns "start" — use the operators' own vocabulary,
  never system vocabulary (no "session initialized", no "credential provisioned";
  the current "Create user (+ Telnyx credential)" becomes "Add agent" with the
  Telnyx provisioning implied and reported in the toast).

## 9. Quality floor
- Keyboard: full tab order, visible focus (the accent ring), Esc closes modals.
  Agent shortcuts: 1–9 dispositions, M mute, space answer/hang per context.
- All timestamps in the viewer's local time, 24h, with relative labels under 1h
  ("14 min ago").
- Websocket disconnect = a persistent slim --warn banner "Reconnecting…", not a toast.
- Test every view at 1280px and 375px before calling it done.

## 10. Do / Don't
Do: mono numerals everywhere · one gold action per view · tint+text status pills ·
dense tables with tall rows · quiet borders.
Don't: gradients · pure black/white · solid green/yellow/red button slabs ·
native file inputs or selects · icons as decoration · count-up animations ·
more than one accent · blue anywhere except the Dialing state.
