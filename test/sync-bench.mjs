// Beat-grid accuracy benchmark: how far a detected grid sits from the true beats
// over the whole track, in ms. Two tracks synced on their grids flam by roughly the
// sum of their errors, so anything over ~5 ms is audible.
// Usage: node test/sync-bench.mjs  (exit 1 if any case is off)
import { detectTempo } from '../src/renderer/analysis.js';
import { pathToFileURL } from 'node:url';

const sr = 44100;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

export function render({ bpm, offset, seconds, intro = 0, pattern, swing = 0, bassOff = false, humanize = 0, drift = 0 }) {
  const buf = new Float32Array(sr * seconds);
  let hatPrev = 0;
  const add = (t, kind, gain = 1) => {
    const i0 = Math.round(t * sr);
    if (i0 < 0) return;
    const len = { kick: 0.3, snare: 0.18, hat: 0.05, clap: 0.12, bass: 0.22 }[kind];
    for (let i = 0; i < len * sr && i0 + i < buf.length; i++) {
      const tt = i / sr;
      let s;
      if (kind === 'kick') s = Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-tt * 35)) * tt) * Math.min(1, tt * 2000) * Math.exp(-tt * 9) * 0.9;
      else if (kind === 'snare') s = rnd() * Math.exp(-tt * 22) * 0.45 + Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt * 20) * 0.25;
      else if (kind === 'clap') s = rnd() * Math.exp(-tt * 30) * 0.4;
      else if (kind === 'bass') s = (Math.sin(2 * Math.PI * 55 * tt) + 0.4 * Math.sin(2 * Math.PI * 110 * tt) + 0.2 * Math.sin(2 * Math.PI * 165 * tt)) * Math.min(1, tt * 300) * Math.exp(-tt * 7) * 0.45;
      else { const n = rnd(); s = (n - hatPrev) * Math.exp(-tt * 90) * 0.3; hatPrev = n; }
      buf[i0 + i] += s * gain;
    }
  };
  for (let i = 0; i < buf.length; i++) buf[i] += Math.sin((2 * Math.PI * 220 * i) / sr) * 0.05 + rnd() * 0.01;
  // drift: tempo multiplies by (1 + drift) linearly over the track (live drummer)
  const beatTimes = [];
  let t = offset;
  for (let b = 0; t < seconds; b++) {
    beatTimes.push(t);
    const local = 60 / (bpm * (1 + (drift * t) / seconds));
    if (t >= intro) {
      const h = humanize ? rnd() * humanize : 0;
      pattern(b, t + h, local, add, swing);
      if (bassOff) add(t + h + local / 2, 'bass', 1.2);
    } else if (b % 2 === 0) add(t + local / 2, 'hat', 0.6); // sparse intro: off-beat hats only
    t += local;
  }
  return { buf, beatTimes };
}
const four = (b, t, beat, add) => { add(t, 'kick'); add(t + beat / 2, 'hat', 1.4); if (b % 2) add(t, 'clap'); };
const offHeavy = (b, t, beat, add) => { add(t, 'kick', 0.6); add(t + beat / 2, 'hat', 2.2); add(t + beat / 2, 'clap', 0.8); };
const swingy = (b, t, beat, add, swing) => { add(t, 'kick'); add(t + beat * (0.5 + swing), 'hat'); if (b % 2) add(t, 'snare'); };
const hiphop = (b, t, beat, add) => { if (b % 4 === 0 || b % 4 === 2) add(t, 'kick'); if (b % 8 === 2) add(t + beat * 0.75, 'kick'); if (b % 2) add(t, 'snare'); add(t, 'hat'); add(t + beat / 2, 'hat'); };
const dubstep = (b, t, beat, add) => { if (b % 4 === 0) add(t, 'kick'); if (b % 4 === 2) add(t, 'snare', 1.6); if (b % 8 === 7) add(t + beat / 2, 'kick', 0.8); add(t, 'hat', 0.7); add(t + beat / 2, 'hat', 0.7); };
const trap = (b, t, beat, add) => { if (b % 8 === 0 || b % 8 === 3) add(t, 'kick'); if (b % 8 === 5) add(t + beat / 2, 'kick'); if (b % 4 === 2) add(t, 'clap', 1.5); for (let i = 0; i < 4; i++) add(t + (i * beat) / 4, 'hat', 0.6); };
const breaks = (b, t, beat, add) => { const p = b % 8; if (p === 0 || p === 5) add(t, 'kick'); if (p === 2 || p === 6) add(t, 'snare', 1.3); if (p === 3) add(t + beat / 2, 'snare', 0.8); if (p === 7) add(t + beat * 0.75, 'kick', 0.7); add(t, 'hat', 0.5); add(t + beat / 2, 'hat', 0.5); };
const dnb = (b, t, beat, add) => { if (b % 4 === 0) add(t, 'kick'); if (b % 4 === 2) add(t + beat / 2, 'kick'); if (b % 4 === 1 || b % 4 === 3) add(t, 'snare'); add(t, 'hat'); add(t + beat / 2, 'hat'); };

export const CASES = [
  { name: 'house 124', bpm: 124, offset: 0.37, pattern: four },
  { name: 'house 127.3', bpm: 127.3, offset: 0.12, pattern: four },
  { name: 'tech 122.68, long intro', bpm: 122.68, offset: 0.2, intro: 40, pattern: four, seconds: 300 },
  { name: 'trance 138, offbeat bass', bpm: 138, offset: 0.05, pattern: four, bassOff: true },
  { name: 'offbeat-heavy 126', bpm: 126, offset: 0.31, pattern: offHeavy },
  { name: 'swing 118.5', bpm: 118.5, offset: 0.4, pattern: swingy, swing: 0.12 },
  { name: 'hiphop 92.4', bpm: 92.4, offset: 0.61, pattern: hiphop },
  { name: 'dnb 174', bpm: 174, offset: 0.1, pattern: dnb, octaveOk: true },
  { name: 'dubstep 140', bpm: 140, offset: 0.22, pattern: dubstep, octaveOk: true },
  { name: 'trap 142', bpm: 142, offset: 0.08, pattern: trap, octaveOk: true },
  { name: 'breakcore 168', bpm: 168, offset: 0.3, pattern: breaks, octaveOk: true },
  { name: 'techno 131 offbeat bass', bpm: 131, offset: 0.17, pattern: offHeavy, bassOff: true },
  { name: 'disco 115.8 humanized', bpm: 115.8, offset: 0.45, pattern: four, humanize: 0.006 },
];

export function gridError(c, r, beatTimes, seconds) {
  const k = [1, 2, 0.5].find((m) => Math.abs((r.bpm * m) / c.bpm - 1) < 0.02);
  const per = 60 / r.bpm;
  const errs = [];
  for (const bt of beatTimes) {
    if (bt < (c.intro || 0) + 2 || bt > seconds - 2) continue;
    if (k === 2 && Math.round((bt - beatTimes[0]) / (60 / c.bpm)) % 2) continue;
    const n = Math.round((bt - r.offset) / per);
    errs.push((bt - (r.offset + n * per)) * 1000);
  }
  return { k, maxErr: Math.max(...errs.map(Math.abs)), meanErr: errs.reduce((a, b) => a + b, 0) / errs.length };
}

const main = import.meta.url === pathToFileURL(process.argv[1]).href;
let fails = 0;
for (const c of main ? CASES : []) {
  const seconds = c.seconds || 240;
  const { buf, beatTimes } = render({ ...c, seconds });
  const t0 = performance.now();
  const r = detectTempo(buf, sr);
  const ms = performance.now() - t0;
  if (!r) { console.log(`FAIL ${c.name}: no tempo`); fails++; continue; }
  // Grid error: for each true beat past the intro, distance to the nearest detected grid line.
  const { k, maxErr, meanErr } = gridError(c, r, beatTimes, seconds);
  const ok = (k === 1 || (k && c.octaveOk)) && maxErr < 6;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(28)} got ${String(r.bpm).padEnd(8)} want ${c.bpm}  grid error max ${maxErr.toFixed(1)} ms, mean ${meanErr.toFixed(1)} ms  conf ${r.confidence.toFixed(2)}  ${ms.toFixed(0)} ms`);
}


// --- Sync end to end: two different tracks, A playing, B synced to it on its detected
// grid, then fine-aligned from the audio. Measures how far B's kicks land from A's.
import { kickEnvelope, alignOnsets } from '../src/renderer/analysis.js';
export function syncCase({ a, b, gridBias = 0, at = 60 }) {
  const secs = 200;
  const A = render({ ...a, seconds: secs });
  const B = render({ ...b, seconds: secs });
  const ra = detectTempo(A.buf, sr);
  const rb = detectTempo(B.buf, sr);
  rb.offset += gridBias; // simulate a grid that's a few ms off
  // Same tempo octave as the engine's matchTempo, then B's grid on A's grid.
  const target = [ra.bpm, ra.bpm * 2, ra.bpm / 2].reduce((x, y) => (Math.abs(y - rb.bpm) < Math.abs(x - rb.bpm) ? y : x));
  const speedB = target / rb.bpm;
  const pa = at;
  const phaseA = ((pa - ra.offset) / (60 / ra.bpm)) * (target / ra.bpm);
  const frac = (x) => x - Math.floor(x);
  let pb = 50 + rb.offset;
  pb += (frac(phaseA) - frac((pb - rb.offset) / (60 / rb.bpm))) * (60 / rb.bpm);
  // True misalignment in real time: B's nearest true kick vs A's, a few beats on.
  const trueErr = (pbNow) => {
    const errs = [];
    for (let k = 2; k < 10; k++) {
      const ta = A.beatTimes.find((t) => t >= pa + k * (60 / ra.bpm) * (ra.bpm / target) - 0.0001) ?? 0;
      const realT = ta - pa; // seconds from now on A (speed 1)
      const posB = pbNow + realT * speedB;
      const nb = B.beatTimes.reduce((x, y) => (Math.abs(y - posB) < Math.abs(x - posB) ? y : x));
      errs.push(((nb - posB) / speedB) * 1000);
    }
    return errs.reduce((x, y) => x + y, 0) / errs.length;
  };
  const before = trueErr(pb);
  const fine = alignOnsets(kickEnvelope(A.buf, sr), pa, 1, kickEnvelope(B.buf, sr), pb, speedB);
  const after = fine ? trueErr(pb + fine.shift) : before;
  return { before, after, fine };
}
const SYNC_CASES = [
  { name: 'house 124 ← house 127.3', a: CASES[0], b: CASES[1] },
  { name: 'house 124 ← techno 131 (offbeat bass)', a: CASES[0], b: CASES[11] },
  { name: 'trap 142 ← dubstep 140', a: CASES[9], b: CASES[8] },
  { name: 'house 124 ← house 127.3, grid 15 ms off', a: CASES[0], b: CASES[1], gridBias: 0.015 },
  { name: 'trance 138 ← techno 131, grid 25 ms off', a: CASES[3], b: CASES[11], gridBias: -0.025 },
];
for (const c of main ? SYNC_CASES : []) {
  const r = syncCase(c);
  const ok = Math.abs(r.after) < 3;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} sync ${c.name.padEnd(40)} kicks apart: grid only ${r.before.toFixed(1)} ms → with audio ${r.after.toFixed(1)} ms (confidence ${r.fine ? r.fine.confidence.toFixed(2) : 'none'})`);
}
if (main) process.exit(fails ? 1 : 0);
