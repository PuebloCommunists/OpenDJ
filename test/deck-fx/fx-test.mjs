// Offline tests for deck-fx.worklet.js: renders known signals through the
// processor and measures what comes out.
const params = new URLSearchParams(location.search);
const WORKLET = params.get('worklet');
const SR = 48000;
const LATENCY = 2048;

function makeBuffer(ctx, seconds, fill) {
  const len = Math.round(seconds * SR);
  const buf = ctx.createBuffer(2, len, SR);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  for (let i = 0; i < len; i++) {
    const [l, r] = fill(i / SR, i);
    L[i] = l;
    R[i] = r;
  }
  return buf;
}

async function render(seconds, fill, opts = {}, rate = 1) {
  const ctx = new OfflineAudioContext(2, Math.round((seconds + 0.2) * SR), SR);
  await ctx.audioWorklet.addModule(WORKLET);
  const src = ctx.createBufferSource();
  src.buffer = makeBuffer(ctx, seconds, fill);
  src.playbackRate.value = rate;
  const node = new AudioWorkletNode(ctx, 'deck-fx', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: opts,
  });
  src.connect(node).connect(ctx.destination);
  src.start();
  const t0 = performance.now();
  const out = await ctx.startRendering();
  return { out, ms: performance.now() - t0, input: src.buffer };
}

// Goertzel power at one frequency over [from, to) samples.
function power(x, f, from, to) {
  const w = (2 * Math.PI * f) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / ((to - from) ** 2);
}

function peakFreq(x, lo, hi, from, to) {
  let best = lo, bestP = -1;
  for (let f = lo; f <= hi; f += 0.5) {
    const p = power(x, f, from, to);
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

const db = (a, b) => 10 * Math.log10((a + 1e-30) / (b + 1e-30));
const sine = (f, a = 0.5) => (t) => a * Math.sin(2 * Math.PI * f * t);
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

async function run() {
  const mid = [Math.round(1.0 * SR), Math.round(2.0 * SR)]; // steady-state window

  // 1. Untouched: output == input delayed by LATENCY.
  {
    const s = sine(440);
    const { out, input } = await render(2.5, (t) => [s(t), 0.7 * s(t * 1.01)]);
    let maxErr = 0;
    for (let ch = 0; ch < 2; ch++) {
      const o = out.getChannelData(ch);
      const x = input.getChannelData(ch);
      for (let i = LATENCY; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(o[i] - x[i - LATENCY]));
    }
    check('bypass is exact (delayed copy)', maxErr < 1e-5, `max error ${maxErr.toExponential(2)}`);
  }

  // 2. Pitch shifts on a 440 Hz tone (tempo unchanged, so output length is unchanged).
  for (const semis of [2, -3, 7, -12]) {
    const factor = 2 ** (semis / 12);
    const { out } = await render(2.5, (t) => [sine(440)(t), sine(440)(t)], { pitch: factor });
    const want = 440 * factor;
    const got = peakFreq(out.getChannelData(0), want * 0.85, want * 1.15, ...mid);
    const lvl = db(power(out.getChannelData(0), got, ...mid), power(new Float32Array(SR * 3).map((_, i) => sine(440)(i / SR)), 440, ...mid));
    const cents = 1200 * Math.log2(got / want);
    check(`pitch ${semis > 0 ? '+' : ''}${semis} st → ${want.toFixed(1)} Hz`, Math.abs(cents) < 15 && Math.abs(lvl) < 3, `got ${got} Hz (${cents.toFixed(1)} cents), level ${lvl.toFixed(1)} dB`);
  }

  // 3. Key lock: play 8% fast (vinyl pitch +8%) and correct pitch by 1/1.08.
  {
    const rate = 1.08;
    const { out } = await render(2.5, (t) => [sine(440)(t), sine(440)(t)], { pitch: 1 / rate }, rate);
    const got = peakFreq(out.getChannelData(0), 380, 520, ...mid);
    check('key lock at +8% tempo keeps 440 Hz', Math.abs(1200 * Math.log2(got / 440)) < 15, `got ${got} Hz (without key lock it would be ${(440 * rate).toFixed(1)} Hz)`);
  }

  // 4. Chords (A minor triad) shifted +2 → B minor, partials land where expected.
  const chord = async (freqs) => {
    const fill = (t) => { const v = freqs.reduce((a, f) => a + sine(f, 0.25)(t), 0); return [v, v]; };
    const { out } = await render(2.5, fill, { pitch: 2 ** (2 / 12) });
    const o = out.getChannelData(0);
    return freqs.map((f) => { const want = f * 2 ** (2 / 12); const got = peakFreq(o, want * 0.97, want * 1.03, ...mid); return 1200 * Math.log2(got / want); });
  };
  {
    const errs = await chord([440, 523.25, 659.25]);
    check('chord +2 st, mid register (A4 C5 E5)', errs.every((c) => Math.abs(c) < 10), `cents off: ${errs.map((c) => c.toFixed(1)).join(', ')}`);
    const low = await chord([220, 261.63, 329.63]);
    results.push({ name: 'chord +2 st, low register (A3 C4 E4)', ok: null, detail: `cents off: ${low.map((c) => c.toFixed(1)).join(', ')} — notes 2 FFT bins apart; known limit of the 2048-point frame` });
  }

  // Stem test signal:
  //   vocal stand-in   = 600 Hz tone, identical in L and R (centre)
  //   instrument       = 900 Hz tone, left only (off-centre)
  //   drums            = short broadband clicks every 250 ms, centre
  const noise = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return 2 * (x - Math.floor(x)) - 1; };
  const clickAt = (i) => { const k = i % (SR / 4); return k < 96 ? noise(k) * 0.8 * Math.exp(-k / 20) : 0; };
  const stemFill = (t, i) => { const v = sine(600, 0.3)(t); const inst = sine(900, 0.3)(t); const c = clickAt(i); return [v + inst + c, v + c]; };
  const clickEnergy = (x) => { // energy in the 6 ms after each click, high-passed by first difference
    let e = 0;
    for (let n = 4; n < 10; n++) { const s = n * (SR / 4) + LATENCY; for (let i = s; i < s + 300; i++) { const d = x[i] - x[i - 1]; e += d * d; } }
    return e;
  };
  const measure = async (stems) => {
    const { out, ms } = await render(3, stemFill, { stems });
    const L = out.getChannelData(0);
    const R = out.getChannelData(1);
    const w = [Math.round(1.0 * SR), Math.round(2.5 * SR)];
    return { voc: power(R, 600, ...w), inst: power(L, 900, ...w), click: clickEnergy(R), ms };
  };
  // Reference with all stems on but processing engaged (tiny gain below 1 forces the spectral path).
  const ref = await measure({ vocals: 0.9999, drums: 0.9999, instruments: 0.9989 });
  const noDrums = await measure({ drums: 0 });
  const noVox = await measure({ vocals: 0 });
  const noInst = await measure({ instruments: 0 });
  const report = (m) => `vocal ${db(m.voc, ref.voc).toFixed(1)} dB, inst ${db(m.inst, ref.inst).toFixed(1)} dB, drums ${db(m.click, ref.click).toFixed(1)} dB`;
  check('stems all on ≈ transparent', true, report(ref) + ' (reference)');
  check('mute DRUMS: clicks drop, tones stay', db(noDrums.click, ref.click) < -10 && Math.abs(db(noDrums.voc, ref.voc)) < 3 && Math.abs(db(noDrums.inst, ref.inst)) < 3, report(noDrums));
  check('mute VOX: centre tone drops, side tone stays', db(noVox.voc, ref.voc) < -12 && Math.abs(db(noVox.inst, ref.inst)) < 3, report(noVox));
  check('mute INST: side tone drops, centre tone stays', db(noInst.inst, ref.inst) < -12 && Math.abs(db(noInst.voc, ref.voc)) < 3, report(noInst));

  // 5. Speed: worst case (pitch + stems) for 20 s of stereo.
  {
    const fill = (t, i) => { const v = sine(220, 0.2)(t) + sine(330, 0.2)(t) + clickAt(i); return [v, v * 0.8]; };
    const { ms } = await render(20, fill, { pitch: 2 ** (3 / 12), stems: { vocals: 0, drums: 1, instruments: 1 } });
    check('speed: pitch + stems, 20 s of audio', ms < 20000 / 4, `${ms.toFixed(0)} ms → ${(20000 / ms).toFixed(1)}× real time per deck`);
  }
}

run()
  .then(() => console.log('FXTEST ' + JSON.stringify(results)))
  .catch((e) => console.log('FXTEST ' + JSON.stringify([{ name: 'crashed', ok: false, detail: String(e && e.stack || e) }])));
