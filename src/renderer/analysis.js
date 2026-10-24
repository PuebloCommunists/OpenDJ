// Track analysis: waveform peaks and tempo/beat-grid detection.
// Pure functions over raw sample data so they can be tested outside the app.

/** Mix all channels down to one Float32Array. */
export function mixToMono(channels) {
  const len = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(len);
  const scale = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < len; i++) out[i] += ch[i] * scale;
  }
  return out;
}

/**
 * Waveform data at `rate` columns per second.
 * peak: max absolute amplitude per column (0..1)
 * bass: share of energy below ~200 Hz per column (0..1), used for colouring
 */
export function computeWaveform(mono, sampleRate, rate = 150) {
  const hop = Math.max(1, Math.round(sampleRate / rate));
  const cols = Math.ceil(mono.length / hop);
  const peak = new Float32Array(cols);
  const bass = new Float32Array(cols);
  const a = 1 - Math.exp((-2 * Math.PI * 200) / sampleRate); // one-pole low-pass at 200 Hz
  let lp = 0;
  for (let c = 0; c < cols; c++) {
    const start = c * hop;
    const end = Math.min(start + hop, mono.length);
    let max = 0;
    let eAll = 0;
    let eLow = 0;
    for (let i = start; i < end; i++) {
      const s = mono[i];
      lp += a * (s - lp);
      const abs = s < 0 ? -s : s;
      if (abs > max) max = abs;
      eAll += s * s;
      eLow += lp * lp;
    }
    peak[c] = max > 1 ? 1 : max;
    bass[c] = eAll > 1e-12 ? Math.min(1, eLow / eAll) : 0;
  }
  return { rate: sampleRate / hop, peak, bass };
}

/** Downsample waveform peaks to a fixed number of columns (for the overview). */
export function overview(wave, columns) {
  const out = new Float32Array(columns);
  const outBass = new Float32Array(columns);
  const n = wave.peak.length;
  for (let c = 0; c < columns; c++) {
    const start = Math.floor((c * n) / columns);
    const end = Math.max(start + 1, Math.floor(((c + 1) * n) / columns));
    let max = 0;
    let b = 0;
    for (let i = start; i < end && i < n; i++) {
      if (wave.peak[i] > max) max = wave.peak[i];
      b += wave.bass[i];
    }
    out[c] = max;
    outBass[c] = b / (end - start);
  }
  return { peak: out, bass: outBass };
}

const TARGET_ENV_RATE = 200; // onset envelope frames per second (approx.)

/**
 * Onset-strength envelope: rectified rise in log energy, emphasising low end (kicks).
 * Also returns two band envelopes used to tell kicks from offbeat bass and hats:
 * `low` (below ~150 Hz) and `mid` (~150–2500 Hz). A kick rises in both at once.
 */
export function onsetEnvelope(mono, sampleRate) {
  const hop = Math.round(sampleRate / TARGET_ENV_RATE);
  const ENV_RATE = sampleRate / hop;
  const frames = Math.floor(mono.length / hop);
  const env = new Float32Array(frames);
  const lowEnv = new Float32Array(frames);
  const midEnv = new Float32Array(frames);
  const aLow = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  const aMid = 1 - Math.exp((-2 * Math.PI * 2500) / sampleRate);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 4000) / sampleRate);
  let lp = 0;
  let lpM = 0;
  let lpH = 0;
  let prevLow = 0;
  let prevMid = 0;
  let prevAll = 0;
  for (let f = 0; f < frames; f++) {
    let eLow = 0;
    let eMid = 0;
    let eHigh = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) {
      const s = mono[i];
      lp += aLow * (s - lp);
      lpM += aMid * (s - lpM);
      lpH += aHigh * (s - lpH);
      const m = lpM - lp;
      const h = s - lpH;
      eLow += lp * lp;
      eMid += m * m;
      eHigh += h * h;
    }
    const logLow = Math.log1p(1000 * eLow / hop);
    const logMid = Math.log1p(1000 * eMid / hop);
    const logHigh = Math.log1p(1000 * eHigh / hop);
    const dLow = logLow - prevLow;
    const dMid = logMid - prevMid;
    const dHigh = logHigh - prevAll;
    env[f] = (dLow > 0 ? dLow : 0) * 1.0 + (dHigh > 0 ? dHigh : 0) * 0.5;
    lowEnv[f] = dLow > 0 ? dLow : 0;
    midEnv[f] = dMid > 0 ? dMid : 0;
    prevLow = logLow;
    prevMid = logMid;
    prevAll = logHigh;
  }
  // Remove slow trend so loud sections don't dominate.
  const win = Math.round(ENV_RATE); // 1 s moving average
  const detrend = (e) => {
    const out = new Float32Array(frames);
    let acc = 0;
    for (let f = 0; f < frames; f++) {
      acc += e[f];
      if (f >= win) acc -= e[f - win];
      const v = e[f] - acc / Math.min(f + 1, win);
      out[f] = v > 0 ? v : 0;
    }
    return out;
  };
  return { env: detrend(env), low: detrend(lowEnv), mid: detrend(midEnv), rate: ENV_RATE };
}

function sampleEnv(env, pos) {
  const i = Math.floor(pos);
  if (i < 0 || i + 1 >= env.length) return 0;
  const t = pos - i;
  return env[i] * (1 - t) + env[i + 1] * t;
}

function smooth(env, sigma = 2) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let norm = 0;
  for (let i = -radius; i <= radius; i++) {
    const k = Math.exp((-0.5 * i * i) / (sigma * sigma));
    kernel.push(k);
    norm += k;
  }
  const out = new Float32Array(env.length);
  for (let f = 0; f < env.length; f++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = f + j;
      if (idx >= 0 && idx < env.length) acc += env[idx] * kernel[j + radius];
    }
    out[f] = acc / norm;
  }
  return out;
}

/** Best phase (in frames) and its mean comb score for a given tempo over [from, to). */
function combScore(env, ENV_RATE, bpm, from, to, phaseStep) {
  const period = (60 * ENV_RATE) / bpm;
  let best = -1;
  let bestPhase = 0;
  for (let ph = 0; ph < period; ph += phaseStep) {
    let sum = 0;
    let n = 0;
    for (let p = from + ph; p < to; p += period) {
      sum += sampleEnv(env, p);
      n++;
    }
    const score = n ? sum / n : 0;
    if (score > best) {
      best = score;
      bestPhase = from + ph;
    }
  }
  return { score: best, phase: bestPhase };
}

// Gentle preference for tempos DJs usually work in.
function tempoPrior(bpm, width = 0.55) {
  const x = Math.log2(bpm / 122) / width;
  return Math.exp(-0.5 * x * x);
}

// Bump when tempo / beat-grid detection changes: tracks analysed by an older version
// (and not fixed by hand) are re-analysed the next time they load.
export const GRID_VERSION = 2;

/**
 * Detect tempo and the position of the first beat.
 * Returns { bpm, offset, confidence } where offset is in seconds (first beat at
 * or after 0), or null if the track is too short or has no clear pulse.
 */
export function detectTempo(mono, sampleRate, { minBpm = 70, maxBpm = 180 } = {}) {
  const duration = mono.length / sampleRate;
  if (duration < 8) return null;
  const onset = onsetEnvelope(mono, sampleRate);
  const ENV_RATE = onset.rate;
  const env = smooth(onset.env, 2);

  // Analyse a window that skips most of the intro.
  const startSec = Math.min(30, duration * 0.15);
  const lenSec = Math.min(90, duration - startSec);
  const from = Math.floor(startSec * ENV_RATE);
  const to = Math.floor((startSec + lenSec) * ENV_RATE);

  // 1) Autocorrelation of the onset envelope (insensitive to small tempo errors).
  const maxLag = Math.ceil((60 * ENV_RATE) / minBpm) * 4 + 2;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = from; f + lag < to; f++) sum += env[f] * env[f + lag];
    ac[lag] = sum / Math.max(1, to - from - lag);
  }
  const acAt = (x) => {
    const i = Math.floor(x);
    if (i < 1 || i + 1 > maxLag) return 0;
    const t = x - i;
    return ac[i] * (1 - t) + ac[i + 1] * t;
  };

  // 2) Score tempos by how well whole multiples of the beat period line up.
  //    A weak prior picks the metrical level; a stronger one settles octave
  //    (half/double) ambiguity afterwards.
  const raw = (bpm) => {
    const lag = (60 * ENV_RATE) / bpm;
    return acAt(lag) + acAt(2 * lag) + 0.75 * acAt(3 * lag) + acAt(4 * lag);
  };
  let best = null;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.05) {
    const r = raw(bpm);
    const weighted = r * tempoPrior(bpm, 1.2);
    if (!best || weighted > best.weighted) best = { bpm, weighted, raw: r };
  }
  if (!best || best.raw <= 0) return null;
  const pickOctave = () => {
    for (const factor of [2, 0.5]) {
      const alt = best.bpm * factor;
      if (alt < minBpm || alt > maxBpm) continue;
      const r = raw(alt);
      if (r * tempoPrior(alt, 0.55) > best.raw * tempoPrior(best.bpm, 0.55)) best = { bpm: alt, weighted: 0, raw: r };
    }
  };
  pickOctave();

  // Autocorrelation can lock onto a tempo 3:4 or 4:5 off the real one (a triplet or
  // syncopated pattern repeats at that lag too). The real tempo's grid, with its half
  // and quarter beats, catches nearly every hit; a related wrong tempo's grid misses
  // many. Switch only when a related tempo explains the track clearly better.
  const fitTo = Math.min(env.length, from + Math.floor(120 * ENV_RATE));
  const gridFit = (bpm) =>
    combScore(env, ENV_RATE, bpm, from, fitTo, 1).score +
    0.5 * combScore(env, ENV_RATE, bpm * 2, from, fitTo, 1).score +
    0.25 * combScore(env, ENV_RATE, bpm * 4, from, fitTo, 1).score;
  const fit = gridFit(best.bpm);
  let better = null;
  for (const factor of [4 / 3, 3 / 4, 5 / 4, 4 / 5, 3 / 2, 2 / 3]) {
    // Compare in the same octave band so the denser grid doesn't win just by being denser.
    let alt = best.bpm * factor;
    while (alt > maxBpm) alt /= 2;
    while (alt < minBpm) alt *= 2;
    const f = gridFit(alt);
    if (f > 1.15 * fit && (!better || f > better.f)) better = { bpm: alt, f };
  }
  if (better) {
    best = { bpm: better.bpm, weighted: 0, raw: raw(better.bpm) };
    pickOctave();
  }

  // 3) Refine tempo and find the beat phase with a comb over a longer stretch.
  const fineTo = Math.min(env.length, from + Math.floor(240 * ENV_RATE));
  let fine = { bpm: best.bpm, score: -1, phase: 0 };
  for (let bpm = best.bpm - 0.3; bpm <= best.bpm + 0.3; bpm += 0.01) {
    const r = combScore(env, ENV_RATE, bpm, from, fineTo, 0.5);
    if (r.score > fine.score) fine = { bpm, score: r.score, phase: r.phase };
  }

  // Snap to a whole BPM when very close (most produced music sits on whole BPMs).
  let bpm = fine.bpm;
  const rounded = Math.round(bpm);
  if (Math.abs(bpm - rounded) < 0.06) bpm = rounded;
  else bpm = Math.round(bpm * 100) / 100;

  // Find the beat phase: lock to the double-time grid first (so a half-time
  // reading still lands on real beats), then pick which of its two phases holds
  // the kicks. Kicks rise in the low and mid bands together; offbeat bass is low
  // only and hats are high only, so sqrt(low × mid) tells them apart where the
  // plain envelope would put the grid on a strong offbeat.
  const halfPeriodFrames = (30 * ENV_RATE) / bpm;
  const dbl = combScore(env, ENV_RATE, bpm * 2, from, fineTo, 0.25).phase;
  const peak = (e, p) => {
    const i = Math.round(p);
    return i < 1 || i + 1 >= e.length ? 0 : Math.max(e[i - 1], e[i], e[i + 1]);
  };
  const scoreAt = (ph, kick) => {
    let sum = 0;
    let n = 0;
    for (let p = ph; p < fineTo; p += 2 * halfPeriodFrames) {
      sum += kick ? Math.sqrt(peak(onset.low, p) * peak(onset.mid, p)) : sampleEnv(env, p);
      n++;
    }
    return n ? sum / n : 0;
  };
  const k0 = scoreAt(dbl, true);
  const k1 = scoreAt(dbl + halfPeriodFrames, true);
  const finalPhase =
    Math.abs(k0 - k1) > 0.03 * Math.max(k0, k1)
      ? (k0 > k1 ? dbl : dbl + halfPeriodFrames)
      : scoreAt(dbl, false) >= scoreAt(dbl + halfPeriodFrames, false) ? dbl : dbl + halfPeriodFrames;
  const period = 60 / bpm;
  let offset = finalPhase / ENV_RATE;
  offset = ((offset % period) + period) % period;

  // Confidence: how far the winning comb stands above the envelope's average.
  let mean = 0;
  for (let f = from; f < to; f++) mean += env[f];
  mean /= Math.max(1, to - from);
  const confidence = mean > 0 ? Math.max(0, Math.min(1, (fine.score / mean - 1) / 3)) : 0;

  return { bpm, offset, confidence };
}

/**
 * Kick envelope for audio-based sync: sqrt(low × mid) onset strength, lightly
 * smoothed. High where a kick (or a snare's body) starts, low on offbeat bass and hats.
 */
export function kickEnvelope(mono, sampleRate) {
  const o = onsetEnvelope(mono, sampleRate);
  const k = new Float32Array(o.low.length);
  for (let i = 0; i < k.length; i++) k[i] = Math.sqrt(o.low[i] * o.mid[i]);
  return { env: smooth(k, 1), rate: o.rate };
}

/**
 * Line two decks up from their audio rather than their beat grids: how many
 * seconds of B's track time B should move so its kicks land on A's over the next
 * `span` seconds of real time, searching ±maxShift. a, b: kickEnvelope()s; pos*:
 * track positions at the same moment; speed*: playback rates.
 * Returns { shift, confidence } (confidence = correlation 0..1), or null when that
 * stretch has too little shared rhythm to tell (a breakdown, an intro).
 */
export function alignOnsets(a, posA, speedA, b, posB, speedB, { span = 6, maxShift = 0.05, minConfidence = 0.25 } = {}) {
  const dt = 1 / 200;
  const n = Math.floor(span / dt);
  const ea = new Float32Array(n);
  let sa = 0;
  let saa = 0;
  for (let i = 0; i < n; i++) {
    const v = sampleEnv(a.env, (posA + i * dt * speedA) * a.rate);
    ea[i] = v;
    sa += v;
    saa += v * v;
  }
  const va = saa - (sa * sa) / n;
  if (va <= 1e-9) return null;
  const lagStep = 0.001;
  const L = Math.max(1, Math.round(maxShift / lagStep));
  const r = new Float32Array(2 * L + 1);
  for (let j = -L; j <= L; j++) {
    let sab = 0;
    let sb = 0;
    let sbb = 0;
    const start = posB + j * lagStep;
    for (let i = 0; i < n; i++) {
      const v = sampleEnv(b.env, (start + i * dt * speedB) * b.rate);
      sab += ea[i] * v;
      sb += v;
      sbb += v * v;
    }
    const vb = sbb - (sb * sb) / n;
    r[j + L] = vb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : 0;
  }
  let best = 0;
  for (let i = 1; i < r.length; i++) if (r[i] > r[best]) best = i;
  if (best === 0 || best === r.length - 1 || r[best] < minConfidence) return null; // no peak inside the window
  const y0 = r[best - 1];
  const y1 = r[best];
  const y2 = r[best + 1];
  const den = y0 - 2 * y1 + y2;
  const frac = den < 0 ? (0.5 * (y0 - y2)) / den : 0;
  return { shift: (best - L + frac) * lagStep, confidence: y1 };
}

// ------------------------------------------------------------------ key

export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Krumhansl–Kessler key profiles (major, minor), tonic first. They describe
// which notes a key uses; audio also carries each note's overtones (the 3rd
// harmonic is a fifth up, the 5th a major third up), which drags a raw chroma
// toward the dominant. So, as in Gómez's audio key-finding, the profiles get
// the same overtones folded in before they're compared with the audio.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const HARMONIC_INTERVALS = [0, 0, 7, 0, 4, 7]; // harmonics 1–6, in semitones above the note (mod 12)
function withOvertones(profile, decay = 0.6) {
  const out = new Array(12).fill(0);
  for (let pc = 0; pc < 12; pc++) {
    HARMONIC_INTERVALS.forEach((iv, h) => {
      out[(pc + iv) % 12] += profile[pc] * decay ** h;
    });
  }
  return out;
}
const MAJOR_PROFILE = withOvertones(KK_MAJOR);
const MINOR_PROFILE = withOvertones(KK_MINOR);

/**
 * Keys are numbers 0–23: tonic pitch class (C = 0) + 12 for minor.
 * keyName(9 + 12) → 'Am', camelot(9 + 12) → '8A'.
 */
export function keyName(key) {
  if (key == null || key < 0) return '';
  return PITCH_NAMES[key % 12] + (key >= 12 ? 'm' : '');
}

export function camelot(key) {
  if (key == null || key < 0) return '';
  const minor = key >= 12;
  const tonic = key % 12;
  const relMajor = minor ? (tonic + 3) % 12 : tonic; // A minor ↔ C major
  return `${(((relMajor * 7) % 12) + 7) % 12 + 1}${minor ? 'A' : 'B'}`;
}

/** Key moved by a number of semitones (rounded). */
export function transposeKey(key, semitones) {
  if (key == null || key < 0) return key;
  const tonic = (((key % 12) + Math.round(semitones)) % 12 + 12) % 12;
  return tonic + (key >= 12 ? 12 : 0);
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** 12-bin chroma (pitch-class energy) summed over the track. */
export function chromagram(mono, sampleRate, { maxFrames = 600 } = {}) {
  // Work at ~11 kHz: plenty for 55 Hz–2 kHz, and 4× less to transform.
  const dec = Math.max(1, Math.round(sampleRate / 11025));
  const sr = sampleRate / dec;
  const len = Math.floor(mono.length / dec);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < dec; j++) s += mono[i * dec + j];
    x[i] = s / dec;
  }

  const N = 8192; // ~1.3 Hz bins at 11 kHz: resolves semitones down to ~55 Hz
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = Math.max(0, Math.floor((len - N) / (N / 4)) + 1);
  const step = Math.max(1, Math.ceil(frames / maxFrames));

  // Each FFT bin → (pitch class, weight). Weight falls off away from the semitone centre.
  const lo = Math.ceil((55 * N) / sr);
  const hi = Math.min(N / 2 - 1, Math.floor((2000 * N) / sr));
  const binPc = new Int8Array(hi + 1).fill(-1);
  const binW = new Float32Array(hi + 1);
  for (let k = lo; k <= hi; k++) {
    const midi = 69 + 12 * Math.log2((k * sr) / N / 440);
    const nearest = Math.round(midi);
    const d = Math.abs(midi - nearest);
    if (d < 0.4) {
      binPc[k] = ((nearest % 12) + 12) % 12;
      binW[k] = Math.cos((d / 0.4) * (Math.PI / 2));
    }
  }

  const chroma = new Float64Array(12);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const frameChroma = new Float64Array(12);
  for (let f = 0; f < frames; f += step) {
    const off = f * (N / 4);
    let energy = 0;
    for (let i = 0; i < N; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
      energy += re[i] * re[i];
    }
    if (energy < 1e-6) continue; // silence
    fftInPlace(re, im);
    frameChroma.fill(0);
    for (let k = lo; k <= hi; k++) {
      if (binPc[k] < 0) continue;
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      // Only spectral peaks count — keeps noise and drums from flattening the chroma.
      const pm = Math.sqrt(re[k - 1] * re[k - 1] + im[k - 1] * im[k - 1]);
      const nm = Math.sqrt(re[k + 1] * re[k + 1] + im[k + 1] * im[k + 1]);
      if (m > pm && m >= nm) frameChroma[binPc[k]] += Math.log1p(m) * binW[k];
    }
    let total = 0;
    for (let c = 0; c < 12; c++) total += frameChroma[c];
    if (total > 0) for (let c = 0; c < 12; c++) chroma[c] += frameChroma[c] / total;
  }
  return chroma;
}

function correlate(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Detect the musical key. Returns { key, confidence, scores } with key 0–23
 * (see keyName / camelot), or null when there's no clear tonal content.
 */
export function detectKey(mono, sampleRate) {
  if (mono.length / sampleRate < 5) return null;
  const chroma = chromagram(mono, sampleRate);
  if (chroma.every((v) => v === 0)) return null;
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [[0, MAJOR_PROFILE], [12, MINOR_PROFILE]]) {
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[(i + tonic) % 12] = profile[i];
      scores.push({ key: tonic + mode, r: correlate(chroma, rotated) });
    }
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  if (best.r < 0.3) return null;
  // Confidence: margin over the runner-up that isn't the relative major/minor
  // (those share a scale and are near-ties by nature, and mix fine anyway).
  const runnerUp = scores.find((s) => s.key !== best.key && camelot(s.key).slice(0, -1) !== camelot(best.key).slice(0, -1));
  const confidence = Math.max(0, Math.min(1, (best.r - (runnerUp?.r ?? 0)) * 4));
  return { key: best.key, confidence, scores: scores.slice(0, 4) };
}

/**
 * Time signature and downbeat, given a beat grid. Each beat gets two cues for
 * "this is beat 1": how hard the low end hits (kicks, crashes, bass entries)
 * and how much the bass note changes (bass lines usually move on the bar).
 * Returns { beatsPerBar: 3 | 4, downbeat, confidence }, downbeat being the
 * first bar start in seconds, or null when the track is too short to tell.
 */
export function detectMeter(mono, sampleRate, bpm, offset) {
  if (!bpm) return null;
  const period = 60 / bpm;
  const duration = mono.length / sampleRate;
  const start = Math.min(30, duration * 0.15);
  const first = Math.ceil((start - offset) / period);
  const count = Math.min(Math.floor((Math.min(duration, start + 180) - offset) / period) - first, 256);
  if (count < 24) return null;

  // Bass only (two one-pole stages at 120 Hz), so snares and hats on 2 and 4 don't count.
  const aLow = 1 - Math.exp((-2 * Math.PI * 120) / sampleRate);
  const accent = new Float64Array(count); // rise in bass energy at the beat
  const pitch = new Float64Array(count); // bass zero-crossing rate over the beat ≈ bass note
  const w = Math.round(0.06 * sampleRate);
  for (let j = 0; j < count; j++) {
    const t = offset + (first + j) * period;
    const i0 = Math.max(0, Math.round(t * sampleRate) - w);
    const i1 = Math.min(mono.length, Math.round((t + period * 0.75) * sampleRate));
    let lp1 = 0;
    let lp2 = 0;
    let prev = 0;
    let zc = 0;
    let before = 0;
    let after = 0;
    for (let i = i0; i < i1; i++) {
      lp1 += aLow * (mono[i] - lp1);
      lp2 += aLow * (lp1 - lp2);
      const k = i - i0;
      if (k < w) before += lp2 * lp2;
      else if (k < 2 * w) after += lp2 * lp2;
      if (k > 2 * w) {
        if ((lp2 >= 0) !== (prev >= 0)) zc++;
      }
      prev = lp2;
    }
    accent[j] = Math.max(0, Math.log1p(1e4 * after / w) - Math.log1p(1e4 * before / w));
    pitch[j] = zc;
  }
  const change = new Float64Array(count);
  for (let j = 1; j < count; j++) change[j] = Math.abs(Math.log((pitch[j] + 1) / (pitch[j - 1] + 1)));
  const norm = (a) => {
    let m = 0;
    for (const v of a) m += v;
    m /= a.length;
    return m > 0 ? a.map((v) => v / m) : a;
  };
  const a = norm(accent);
  const c = norm(change);

  // For each meter, the phase whose beats stand out most from the rest.
  const contrast = (m) => {
    let best = { k: 0, score: -Infinity };
    const mean = (k) => {
      let s = 0;
      let n = 0;
      for (let j = k; j < count; j += m) {
        s += a[j] + c[j];
        n++;
      }
      return n ? s / n : 0;
    };
    const means = Array.from({ length: m }, (_, k) => mean(k));
    for (let k = 0; k < m; k++) {
      const others = (means.reduce((x, y) => x + y, 0) - means[k]) / (m - 1);
      const score = means[k] - others;
      if (score > best.score) best = { k, score };
    }
    return best;
  };
  const four = contrast(4);
  const three = contrast(3);
  // Most dance music is 4/4: 3/4 has to win clearly.
  const useThree = three.score > four.score * 1.3 && three.score > 0.15;
  const m = useThree ? 3 : 4;
  const win = useThree ? three : four;
  const bar = m * period;
  let downbeat = offset + (first + win.k) * period;
  downbeat = ((downbeat % bar) + bar) % bar;
  return { beatsPerBar: m, downbeat, confidence: Math.max(0, Math.min(1, win.score / 1.5)) };
}

/** Beat phase (0..1) at a given track position. */
export function beatPhase(position, bpm, offset) {
  const period = 60 / bpm;
  const p = (position - offset) / period;
  return p - Math.floor(p);
}

/**
 * How much more the audio supports 4⁄3 × bpm than bpm itself (> 1: the faster one).
 * Uses the onset envelope's autocorrelation with its average removed, which tells
 * metrical levels apart much better than the raw one: a triplet feel can make the
 * detector read ¾ of the real tempo, and this is the check for that.
 */
export function threeFourSupport(mono, sampleRate, bpm) {
  const onset = onsetEnvelope(mono, sampleRate);
  const R = onset.rate;
  const env = smooth(onset.env, 2);
  const duration = mono.length / sampleRate;
  const from = Math.floor(Math.min(30, duration * 0.15) * R);
  const to = Math.min(env.length, from + Math.floor(90 * R));
  let mean = 0;
  for (let f = from; f < to; f++) mean += env[f];
  mean /= Math.max(1, to - from);
  const ac = (lag) => {
    const i = Math.round(lag);
    let s = 0;
    for (let f = from; f + i < to; f++) s += (env[f] - mean) * (env[f + i] - mean);
    return s / Math.max(1, to - from - i);
  };
  const score = (b) => {
    const lag = (60 * R) / b;
    return ac(lag) + ac(2 * lag) + ac(4 * lag);
  };
  const base = score(bpm);
  return base > 0 ? score((bpm * 4) / 3) / base : 2;
}
