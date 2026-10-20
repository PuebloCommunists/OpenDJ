// Per-deck real-time effects, run on the audio thread (AudioWorklet):
//
//  • Key shift / key lock — phase-vocoder pitch shifting, so pitch can move
//    without changing tempo (and tempo without changing pitch).
//  • Stems — splits the sound into vocals / drums / instruments with DSP masks
//    and lets each be turned down. This is signal processing, not a trained
//    model: drums come from harmonic/percussive separation (median filtering),
//    vocals from harmonic sound that sits in the centre of the stereo image in
//    the voice range. Good enough to drop the drums or thin out a vocal live,
//    not a clean studio stem.
//
// Both share one stereo STFT (2048-point, hop 512), so the node has a fixed
// latency of FRAME samples (~43 ms) whatever it is doing. When nothing is engaged
// the frame is overlap-added untouched, which reconstructs the input exactly,
// and switching between that and processing cross-fades through the overlap.

const FRAME = 2048;
const HOP = 512; // 4× overlap
const BINS = FRAME / 2 + 1;
const FIFO_START = FRAME - HOP; // where new input enters the analysis buffer
const LATENCY = FRAME; // input → output delay, in samples
const TWO_PI = Math.PI * 2;

// Stem separation settings.
const TIME_MEDIAN = 11; // frames (~120 ms) of history for the harmonic estimate
const FREQ_MEDIAN = 17; // bins (~400 Hz) for the percussive estimate
// A bin counts as vocal in proportion to centre⁴ (centre = 1 when L and R match).

class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((TWO_PI * i) / n);
      this.sin[i] = -Math.sin((TWO_PI * i) / n);
    }
  }

  /** In-place complex FFT. inverse=true gives the unscaled inverse. */
  transform(re, im, inverse = false) {
    const { n, rev, cos } = this;
    const sin = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sgn * sin[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

function median(buf, n) {
  // Insertion sort; n is small (≤ 17).
  for (let i = 1; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  return buf[n >> 1];
}

const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI);

class DeckFx extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.fft = new FFT(FRAME);
    this.win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FRAME);
    // Hann analysis × Hann synthesis at 4× overlap sums to 1.5.
    this.olaScale = 1 / 1.5;

    this.inL = new Float32Array(FRAME);
    this.inR = new Float32Array(FRAME);
    this.outL = new Float32Array(HOP);
    this.outR = new Float32Array(HOP);
    this.accL = new Float32Array(FRAME * 2);
    this.accR = new Float32Array(FRAME * 2);
    this.rover = FIFO_START;

    this.re = new Float64Array(FRAME);
    this.im = new Float64Array(FRAME);
    // Per-channel spectra (bins 0..FRAME/2).
    this.lRe = new Float64Array(BINS);
    this.lIm = new Float64Array(BINS);
    this.rRe = new Float64Array(BINS);
    this.rIm = new Float64Array(BINS);

    // Stems.
    this.history = new Float32Array(TIME_MEDIAN * BINS);
    this.histPos = 0;
    this.histFill = 0;
    this.mono = new Float32Array(BINS);
    this.gain = new Float32Array(BINS);
    this.scratch = new Float32Array(Math.max(TIME_MEDIAN, FREQ_MEDIAN));
    this.band = new Float32Array(BINS); // vocal frequency weighting
    this.stems = { vocals: 1, drums: 1, instruments: 1 };

    // Pitch.
    this.pitch = 1;
    this.pv = [0, 1].map(() => ({
      last: new Float64Array(BINS), // previous analysis phase
      ph: new Float64Array(BINS),
      mag: new Float64Array(BINS),
      freq: new Float64Array(BINS),
      synPhase: new Float64Array(BINS), // previous synthesis phase
      oRe: new Float64Array(BINS),
      oIm: new Float64Array(BINS),
      peaks: new Int32Array(BINS),
    }));
    this.pvFresh = true;

    this.sampleRateHz = sampleRate;
    this.computeBand();

    this.port.onmessage = (e) => this.configure(e.data);
    this.configure(options?.processorOptions);
    this.port.postMessage({ latency: LATENCY });
  }

  /** { pitch: factor, stems: { vocals, drums, instruments } (0..1 each) } */
  configure(m) {
    if (!m) return;
    if (typeof m.pitch === 'number' && isFinite(m.pitch)) this.pitch = Math.min(4, Math.max(0.25, m.pitch));
    if (m.stems) {
      for (const k of ['vocals', 'drums', 'instruments']) {
        if (typeof m.stems[k] === 'number') this.stems[k] = Math.min(1, Math.max(0, m.stems[k]));
      }
    }
  }

  computeBand() {
    // Voice range: fade in 120–250 Hz, full to 5 kHz, fade out by 10 kHz.
    for (let k = 0; k < BINS; k++) {
      const f = (k * this.sampleRateHz) / FRAME;
      let w = 0;
      if (f >= 250 && f <= 5000) w = 1;
      else if (f > 120 && f < 250) w = (f - 120) / 130;
      else if (f > 5000 && f < 10000) w = 1 - (f - 5000) / 5000;
      this.band[k] = w;
    }
  }

  get stemsActive() {
    const s = this.stems;
    return s.vocals < 0.999 || s.drums < 0.999 || s.instruments < 0.999;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const inL = input[0];
    const inR = input[1] || input[0];
    const oL = output[0];
    const oR = output[1] || output[0];
    const n = oL.length;
    for (let i = 0; i < n; i++) {
      const r = this.rover;
      this.inL[r] = inL ? inL[i] : 0;
      this.inR[r] = inR ? inR[i] : 0;
      oL[i] = this.outL[r - FIFO_START];
      oR[i] = this.outR[r - FIFO_START];
      this.rover++;
      if (this.rover >= FRAME) {
        this.rover = FIFO_START;
        this.processFrame();
        this.inL.copyWithin(0, HOP, FRAME);
        this.inR.copyWithin(0, HOP, FRAME);
      }
    }
    return true;
  }

  processFrame() {
    const { win, inL, inR, accL, accR, olaScale } = this;
    const pitchOn = Math.abs(this.pitch - 1) > 1e-4;
    const stemsOn = this.stemsActive;

    let silent = true;
    for (let i = 0; i < FRAME; i += 4) {
      if (inL[i] !== 0 || inR[i] !== 0) {
        silent = false;
        break;
      }
    }

    if (!silent && (pitchOn || stemsOn)) {
      this.spectralFrame(pitchOn, stemsOn);
    } else {
      // Untouched: windowed overlap-add reconstructs the input exactly.
      for (let i = 0; i < FRAME; i++) {
        const w = win[i] * win[i] * olaScale;
        accL[i] += inL[i] * w;
        accR[i] += inR[i] * w;
      }
      this.pvFresh = true;
      if (silent) this.histFill = 0;
    }

    // The next HOP output samples; process() reads them as rover runs FIFO_START..FRAME.
    this.outL.set(accL.subarray(0, HOP));
    this.outR.set(accR.subarray(0, HOP));
    accL.copyWithin(0, HOP);
    accR.copyWithin(0, HOP);
    accL.fill(0, accL.length - HOP);
    accR.fill(0, accR.length - HOP);
  }

  spectralFrame(pitchOn, stemsOn) {
    const { re, im, win, inL, inR, lRe, lIm, rRe, rIm, fft } = this;
    // Pack L as real, R as imaginary: one complex FFT for both channels.
    for (let i = 0; i < FRAME; i++) {
      re[i] = inL[i] * win[i];
      im[i] = inR[i] * win[i];
    }
    fft.transform(re, im);
    for (let k = 0; k < BINS; k++) {
      const j = (FRAME - k) & (FRAME - 1);
      const zr = re[k];
      const zi = im[k];
      const cr = re[j];
      const ci = -im[j];
      lRe[k] = 0.5 * (zr + cr);
      lIm[k] = 0.5 * (zi + ci);
      rRe[k] = 0.5 * (zi - ci);
      rIm[k] = -0.5 * (zr - cr);
    }

    if (stemsOn) this.applyStems();
    if (pitchOn) {
      this.shiftPitch(0, lRe, lIm);
      this.shiftPitch(1, rRe, rIm);
      this.pvFresh = false;
    } else {
      this.pvFresh = true;
    }

    // Rebuild the full spectrum Z = L + iR and inverse transform.
    for (let k = 0; k < BINS; k++) {
      re[k] = lRe[k] - rIm[k];
      im[k] = lIm[k] + rRe[k];
    }
    for (let k = 1; k < FRAME / 2; k++) {
      // conj(L[k]) + i·conj(R[k])
      re[FRAME - k] = lRe[k] + rIm[k];
      im[FRAME - k] = -lIm[k] + rRe[k];
    }
    fft.transform(re, im, true);
    const s = this.olaScale / FRAME;
    const { accL, accR } = this;
    for (let i = 0; i < FRAME; i++) {
      accL[i] += re[i] * win[i] * s;
      accR[i] += im[i] * win[i] * s;
    }
  }

  applyStems() {
    const { lRe, lIm, rRe, rIm, mono, history, gain, scratch, band } = this;
    const { vocals, drums, instruments } = this.stems;

    for (let k = 0; k < BINS; k++) {
      const ml = Math.sqrt(lRe[k] * lRe[k] + lIm[k] * lIm[k]);
      const mr = Math.sqrt(rRe[k] * rRe[k] + rIm[k] * rIm[k]);
      mono[k] = 0.5 * (ml + mr);
    }
    history.set(mono, this.histPos * BINS);
    this.histPos = (this.histPos + 1) % TIME_MEDIAN;
    this.histFill = Math.min(TIME_MEDIAN, this.histFill + 1);
    const frames = this.histFill;
    const halfF = FREQ_MEDIAN >> 1;

    for (let k = 0; k < BINS; k++) {
      // Harmonic: steady over time → median across recent frames.
      for (let f = 0; f < frames; f++) scratch[f] = history[f * BINS + k];
      const h = median(scratch, frames);
      // Percussive: broadband at one instant → median across nearby bins.
      let c = 0;
      for (let j = k - halfF; j <= k + halfF; j++) scratch[c++] = j >= 0 && j < BINS ? mono[j] : 0;
      const p = median(scratch, c);
      const h2 = h * h;
      const p2 = p * p;
      const den = h2 + p2 + 1e-20;
      const mH = h2 / den;
      const mP = p2 / den;

      // Vocals: harmonic, centred (L ≈ R in level and phase), in the voice range.
      const ll = lRe[k] * lRe[k] + lIm[k] * lIm[k];
      const rr = rRe[k] * rRe[k] + rIm[k] * rIm[k];
      const lr = lRe[k] * rRe[k] + lIm[k] * rIm[k];
      let centre = (2 * lr) / (ll + rr + 1e-20);
      centre = centre > 0 ? centre : 0;
      const c2 = centre * centre;
      const mV = mH * c2 * c2 * band[k];
      const mI = mH - mV;
      gain[k] = vocals * mV + drums * mP + instruments * mI;
    }
    for (let k = 0; k < BINS; k++) {
      const g = gain[k];
      lRe[k] *= g;
      lIm[k] *= g;
      rRe[k] *= g;
      rIm[k] *= g;
    }
  }

  /**
   * Phase-vocoder pitch shift of one channel's spectrum, in place, with peak
   * locking (Laroche & Dolson): each spectral peak and the bins around it move
   * together as one block, keeping their phase relationships, so harmonics stay
   * at full level and sound less "phasey" than shifting bins one by one.
   */
  shiftPitch(ch, sRe, sIm) {
    const st = this.pv[ch];
    const { last, mag, ph, freq, synPhase, oRe, oIm, peaks } = st;
    const factor = this.pitch;
    const expected = (TWO_PI * HOP) / FRAME;
    const osamp = FRAME / HOP;
    const fresh = this.pvFresh;

    let maxMag = 0;
    for (let k = 0; k < BINS; k++) {
      const m = Math.sqrt(sRe[k] * sRe[k] + sIm[k] * sIm[k]);
      const p = Math.atan2(sIm[k], sRe[k]);
      const dev = fresh ? 0 : wrap(p - last[k] - k * expected);
      last[k] = p;
      ph[k] = p;
      mag[k] = m;
      freq[k] = k + (dev * osamp) / TWO_PI; // true frequency, in bins
      if (m > maxMag) maxMag = m;
    }

    // Peaks: local maxima, ignoring the noise floor. (±1 bin, not ±2, so close
    // low notes — two bins apart at ~200 Hz — stay separate peaks.)
    const floor = maxMag * 1e-6;
    let nPeaks = 0;
    for (let k = 1; k < BINS - 1; k++) {
      const m = mag[k];
      if (m > floor && m > mag[k - 1] && m >= mag[k + 1]) peaks[nPeaks++] = k;
    }

    oRe.fill(0);
    oIm.fill(0);
    let start = 0;
    for (let i = 0; i < nPeaks; i++) {
      const p = peaks[i];
      // Region of influence: up to the quietest bin before the next peak.
      let end = BINS - 1;
      if (i + 1 < nPeaks) {
        const q = peaks[i + 1];
        end = p;
        for (let k = p + 1; k < q; k++) if (mag[k] < mag[end]) end = k;
      }
      // Move the block by the peak's true frequency change, rounded once — rounding
      // the target and the peak bin separately can leave it nearly a bin off.
      const shift = Math.round(freq[p] * (factor - 1));
      const target = p + shift;
      if (target > 0 && target < BINS - 1) {
        const advance = expected * freq[p] * factor;
        const peakPhase = fresh ? ph[p] : wrap(synPhase[target] + advance);
        for (let k = start; k <= end; k++) {
          const t = k + shift;
          if (t <= 0 || t >= BINS - 1) continue;
          const phase = peakPhase + (ph[k] - ph[p]);
          oRe[t] += mag[k] * Math.cos(phase);
          oIm[t] += mag[k] * Math.sin(phase);
        }
      }
      start = end + 1;
    }

    for (let k = 0; k < BINS; k++) {
      const m2 = oRe[k] * oRe[k] + oIm[k] * oIm[k];
      // Bins left empty keep advancing at their own frequency so a peak moving in later starts sensibly.
      synPhase[k] = m2 > 0 ? Math.atan2(oIm[k], oRe[k]) : wrap(synPhase[k] + k * expected);
      sRe[k] = oRe[k];
      sIm[k] = oIm[k];
    }
    sIm[0] = 0;
    sIm[BINS - 1] = 0;
  }
}

registerProcessor('deck-fx', DeckFx);
