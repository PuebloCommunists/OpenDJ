import { detectTempo, computeWaveform, overview, mixToMono, beatPhase, detectKey, keyName, camelot, transposeKey } from '../src/renderer/analysis.js';
const sr = 44100;
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
function synth({ bpm, offset, seconds, pattern, drone = true }) {
  const buf = new Float32Array(sr * seconds);
  const beat = 60 / bpm;
  const add = (t, kind) => {
    const i0 = Math.round(t * sr);
    const len = kind === 'kick' ? 0.25 : kind === 'snare' ? 0.18 : 0.05;
    for (let i = 0; i < len * sr && i0 + i < buf.length; i++) {
      const tt = i / sr;
      let s;
      if (kind === 'kick') s = Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 12) * 0.9;
      else if (kind === 'snare') s = rnd() * Math.exp(-tt * 25) * 0.5 + Math.sin(2*Math.PI*190*tt)*Math.exp(-tt*20)*0.3;
      else s = rnd() * Math.exp(-tt * 80) * 0.25;
      buf[i0 + i] += s;
    }
  };
  // pad/bass drone so it's not pure drums
  for (let i = 0; i < buf.length; i++) buf[i] += (drone ? Math.sin(2*Math.PI*110*i/sr)*0.08 : 0) + rnd()*0.01;
  for (let b = 0; offset + b * beat < seconds; b++) {
    const t = offset + b * beat;
    pattern(b, t, beat, add);
  }
  return buf;
}
const house = (b, t, beat, add) => { add(t, 'kick'); add(t + beat / 2, 'hat'); if (b % 2) add(t, 'snare'); };
const hiphop = (b, t, beat, add) => { if (b % 4 === 0 || b % 4 === 2) add(t, 'kick'); if (b%8===2) add(t+beat*0.75,'kick'); if (b % 2) add(t, 'snare'); add(t,'hat'); add(t+beat/2,'hat'); };
const dnb = (b, t, beat, add) => { if (b % 4 === 0) add(t, 'kick'); if (b%4===2) add(t+beat/2,'kick'); if (b % 4 === 1 || b % 4 === 3) add(t, 'snare'); add(t,'hat'); add(t+beat/2,'hat'); };
const cases = [
  { name: 'house 124', bpm: 124, offset: 0.37, pattern: house },
  { name: 'house 128', bpm: 128, offset: 0.05, pattern: house },
  { name: 'tech 122.5', bpm: 122.5, offset: 0.2, pattern: house },
  { name: 'hiphop 92', bpm: 92, offset: 0.61, pattern: hiphop },
  { name: 'dnb 174 (half ok)', bpm: 174, offset: 0.1, pattern: dnb, octaveOk: true },
  { name: 'disco 112', bpm: 112, offset: 0.45, pattern: house },
];
let fails = 0;
for (const c of cases) {
  const mono = synth({ ...c, seconds: 150 });
  const t0 = performance.now();
  const r = detectTempo(mono, sr);
  const ms = performance.now() - t0;
  const period = 60 / c.bpm;
  let offErr = Math.abs(r.offset - c.offset); offErr = Math.min(offErr, period - offErr);
  const octave = [1, 2, 0.5].find((k) => Math.abs(r.bpm * k - c.bpm) < 0.1);
  const p2 = 60 / Math.max(r.bpm, c.bpm); let offErr2 = Math.abs(((r.offset - c.offset) % p2 + p2) % p2); offErr2 = Math.min(offErr2, p2 - offErr2);
  const ok = octave === 1 ? offErr < 0.02 : (octave && c.octaveOk && offErr2 < 0.02);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: got ${r.bpm} bpm, offset ${r.offset.toFixed(3)} (want ${c.offset}), conf ${r.confidence.toFixed(2)}, ${ms.toFixed(0)}ms`);
}
// --- key detection: chord progressions (triads + bass, with harmonics) over a house beat
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
function progression(chords, { seconds = 60, bpm = 124 } = {}) {
  const buf = synth({ bpm, offset: 0.1, seconds, pattern: house, drone: false });
  const bar = (4 * 60) / bpm;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const ch = chords[Math.floor(t / bar) % chords.length];
    let s = 0;
    ch.forEach((m, j) => {
      const f = midiHz(j === 0 ? m - 12 : m); // first note an octave down as the bass
      for (let h = 1; h <= 4; h++) s += (Math.sin(2 * Math.PI * f * h * t) * 0.06) / h;
    });
    buf[i] += s;
  }
  return buf;
}
// chords as MIDI notes: [bass/root, triad...]
const C = 48, D = 50, Eb = 51, E = 52, F = 53, Fs = 54, G = 55, Ab = 56, A = 57, Bb = 58, B = 59;
const maj = (r) => [r, r + 12, r + 16, r + 19];
const min = (r) => [r, r + 12, r + 15, r + 19];
const keyCases = [
  { name: 'C major (C F G C)', want: 'C', chords: [maj(C), maj(F), maj(G), maj(C)] },
  { name: 'A minor (Am F C G)', want: 'Am', chords: [min(A), maj(F), maj(C), maj(G), min(A), min(D), maj(E), min(A)] },
  { name: 'F# minor (F#m D A E)', want: 'F#m', chords: [min(Fs), maj(D), maj(A), maj(E), min(Fs), min(B), maj(Cs()), min(Fs)] },
  { name: 'Eb major (Eb Ab Bb Eb)', want: 'Eb', chords: [maj(Eb), maj(Ab), maj(Bb), maj(Eb)] },
  { name: 'D minor (Dm Gm A Dm)', want: 'Dm', chords: [min(D), min(G), maj(A), min(D)] },
];
function Cs() { return 49; }
for (const c of keyCases) {
  const mono = progression(c.chords);
  const t0 = performance.now();
  const r = detectKey(mono, sr);
  const ms = performance.now() - t0;
  const got = r ? keyName(r.key) : 'none';
  const ok = got === c.want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} key ${c.name}: got ${got} (${r ? camelot(r.key) : ''}), conf ${r ? r.confidence.toFixed(2) : '-'}, ${ms.toFixed(0)}ms`);
}
{
  const drumsOnly = synth({ bpm: 124, offset: 0.1, seconds: 30, pattern: house, drone: false });
  const r = detectKey(drumsOnly, sr);
  console.log(`INFO key of drums only: ${r ? keyName(r.key) + ' conf ' + r.confidence.toFixed(2) : 'none'} (any answer here is a guess; low confidence expected)`);
}
const camelotChecks = [[0, '8B'], [9 + 12, '8A'], [7, '9B'], [4 + 12, '9A'], [5, '7B'], [6 + 12, '11A'], [3, '5B']];
for (const [k, want] of camelotChecks) {
  const ok = camelot(k) === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} camelot ${keyName(k)} = ${camelot(k)} (want ${want})`);
}
{
  const ok = keyName(transposeKey(9 + 12, 2)) === 'Bm' && keyName(transposeKey(0, -1)) === 'B';
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} transpose Am +2 = ${keyName(transposeKey(21, 2))}, C -1 = ${keyName(transposeKey(0, -1))}`);
}

const mono = mixToMono([new Float32Array(sr*10).fill(0.5), new Float32Array(sr*10).fill(-0.5)]);
const w = computeWaveform(mono, sr); const o = overview(w, 500);
console.log('waveform cols', w.peak.length, 'rate', w.rate.toFixed(1), 'overview', o.peak.length, 'phase', beatPhase(1.0, 120, 0.25).toFixed(2));
process.exit(fails ? 1 : 0);
