// ── Shadow AMD ────────────────────────────────────────────────────────────────
// Self-hosted answering-machine detection over a Telnyx media fork (8 kHz μ-law,
// 20 ms frames). Runs in SHADOW MODE: it listens to the same audio premium AMD
// hears and logs its own verdict, but never routes a call — premium stays the
// decider until the measured agreement says otherwise.
//
// The classifier is deliberately simple, because the domain is narrow: a human
// answers with a short utterance and then WAITS ("Hello?" … silence); a
// voicemail greeting is one long continuous utterance ("Hi, you've reached …")
// usually ending in a beep. Three signals cover it:
//   1. beep       — sustained near-pure tone (Goertzel at common beep pitches)
//   2. long run   — continuous speech ≥ MACHINE_RUN_MS → greeting → machine
//   3. short+wait — utterance ≤ HUMAN_UTTER_MS followed by ≥ HUMAN_WAIT_MS of
//                   silence → human
// Ringback (440/480 Hz dual tone) is recognised and ignored so early media can
// never masquerade as speech. No verdict by DEADLINE_MS → not_sure (or silence
// if nothing was ever heard) — mirroring premium's own result vocabulary.

const FRAME = 160;                 // samples per 20 ms frame @ 8 kHz
const HUMAN_UTTER_MS  = 2400;      // longest opener a human plausibly says
const HUMAN_WAIT_MS   = 900;       // the wait after it that machines don't do
const MACHINE_RUN_MS  = 2600;      // one utterance spanning this long = greeting
const HANGOVER_MS     = 300;       // syllable gaps shorter than this stay inside
                                   // the same utterance — without this, the dips
                                   // between words reset the run and a greeting
                                   // reads as several short "human" utterances
const BEEP_MS         = 160;       // sustained pure tone this long = beep
const DEADLINE_MS     = 5200;      // give up: not_sure / silence
const MIN_UTTER_MS    = 120;       // ignore clicks/pops shorter than this

// μ-law byte → linear PCM (−32124..32124). Standard G.711 expansion.
const MULAW = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  MULAW[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
}

// Goertzel power of one frequency over one frame, normalised by frame energy.
function goertzel(samples, off, freq) {
  const k = 2 * Math.cos((2 * Math.PI * freq) / 8000);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < FRAME; i++) { s0 = samples[off + i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

function createDetector(onVerdict) {
  const pcm = new Float64Array(FRAME);
  let ms = 0;                      // audio time processed
  let noise = 500;                 // adaptive noise floor (RMS)
  let utterStartMs = -1;           // start of the utterance in progress
  let lastSpeechMs = -1;           // last frame that contained speech
  let lastUtter = null;            // { start, end } of the last finished utterance
  let beepMs = 0;                  // sustained pure-tone duration
  let spokeAtAll = false;
  let done = false;
  let carry = Buffer.alloc(0);     // partial frame between WS messages

  function verdict(result, reason) {
    if (done) return;
    done = true;
    onVerdict({ result, reason, ms,
      features: { spoke: spokeAtAll, lastUtterMs: lastUtter ? lastUtter.end - lastUtter.start : 0 } });
  }

  function frame(buf, off) {
    // Decode, then remove the frame mean: DC offset (a biased line, a stuck
    // codec) is not sound and must not count as energy.
    let mean = 0;
    for (let i = 0; i < FRAME; i++) { pcm[i] = MULAW[buf[off + i]]; mean += pcm[i]; }
    mean /= FRAME;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) { pcm[i] -= mean; sum += pcm[i] * pcm[i]; }
    const rms = Math.sqrt(sum / FRAME);
    const energy = sum;
    ms += 20;

    // Tone analysis on loud frames only.
    let beep = false, ringback = false;
    if (rms > 800) {
      const p800 = goertzel(pcm, 0, 800), p1000 = goertzel(pcm, 0, 1000),
            p1400 = goertzel(pcm, 0, 1400), p440 = goertzel(pcm, 0, 440), p480 = goertzel(pcm, 0, 480);
      const norm = energy * FRAME / 2;
      ringback = (p440 + p480) / norm > 0.5;                       // dual-tone US ringback
      beep = !ringback && Math.max(p800, p1000, p1400) / norm > 0.55;
    }
    if (ringback) { beepMs = 0; return; }                          // early media — not speech
    beepMs = beep ? beepMs + 20 : 0;
    if (beepMs >= BEEP_MS) return verdict('machine', 'beep');

    const speaking = rms > Math.max(noise * 3.5, 700) && !beep;
    if (!speaking) noise = noise * 0.97 + rms * 0.03;              // track the floor while quiet

    if (speaking) {
      spokeAtAll = true;
      if (utterStartMs < 0) utterStartMs = ms;
      lastSpeechMs = ms;
      if (ms - utterStartMs >= MACHINE_RUN_MS) return verdict('machine', 'greeting-run');
    } else if (utterStartMs >= 0) {
      // Inside the hangover a gap is still the same utterance (inter-word dip).
      if (ms - lastSpeechMs >= HANGOVER_MS) {
        if (lastSpeechMs - utterStartMs >= MIN_UTTER_MS)
          lastUtter = { start: utterStartMs, end: lastSpeechMs };
        utterStartMs = -1;
      }
    }
    if (utterStartMs < 0 && lastUtter) {
      const utterMs = lastUtter.end - lastUtter.start;
      if (utterMs <= HUMAN_UTTER_MS && ms - lastUtter.end >= HUMAN_WAIT_MS)
        return verdict('human', 'short-utterance-then-wait');
    }
    if (ms >= DEADLINE_MS) return verdict(spokeAtAll ? 'not_sure' : 'silence', 'deadline');
  }

  return {
    // Feed one Telnyx media payload (base64 μ-law). Returns true once decided.
    feed(b64) {
      if (done) return true;
      const buf = carry.length ? Buffer.concat([carry, Buffer.from(b64, 'base64')]) : Buffer.from(b64, 'base64');
      let off = 0;
      for (; off + FRAME <= buf.length && !done; off += FRAME) frame(buf, off);
      carry = buf.subarray(off);
      return done;
    },
    // Stream ended before a rule fired (short call, hangup) — close out honestly.
    finish() { if (!done) verdict(spokeAtAll ? 'not_sure' : 'silence', 'stream-ended'); },
    get done() { return done; },
  };
}

module.exports = { createDetector, MULAW, FRAME };
