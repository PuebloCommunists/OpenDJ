// Audio engine: two decks → mixer → master limiter → speakers.
// Built on the Web Audio API. Tempo changes are vinyl-style (pitch follows
// speed) unless key lock is on. Each deck runs through a deck-fx worklet
// (key shift / key lock / stems) before its EQ.

const dbToGain = (db) => Math.pow(10, db / 20);

export const STEMS = ['vocals', 'drums', 'instruments'];
export const AI_STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];

export class Mixer {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.master.connect(this.limiter);
    this.limiter.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    this.decks = {
      A: new Deck(this, 'A'),
      B: new Deck(this, 'B'),
    };
    this.crossfader = 0.5;
    this.curve = 'smooth';
    this.applyCrossfader();

    // Key shift / stems processor. Decks play straight through until it's loaded.
    this.fxReady = this.ctx.audioWorklet
      .addModule(new URL('./deck-fx.worklet.js', import.meta.url))
      .then(() => {
        for (const d of Object.values(this.decks)) d.attachFx();
        return true;
      })
      .catch((err) => {
        console.error('Key shift / stems unavailable:', err);
        return false;
      });
  }

  resume() {
    if (this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }

  setMasterVolume(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setCrossfader(x) {
    this.crossfader = Math.min(1, Math.max(0, x));
    this.applyCrossfader();
  }

  setCurve(curve) {
    this.curve = curve;
    this.applyCrossfader();
  }

  applyCrossfader() {
    const x = this.crossfader;
    let a;
    let b;
    if (this.curve === 'cut') {
      // Scratch-style: both full until the very edges.
      a = x > 0.95 ? (1 - x) / 0.05 : 1;
      b = x < 0.05 ? x / 0.05 : 1;
    } else {
      // Equal-power blend.
      a = Math.cos((x * Math.PI) / 2);
      b = Math.sin((x * Math.PI) / 2);
    }
    const t = this.ctx.currentTime;
    this.decks.A.xfade.gain.setTargetAtTime(a, t, 0.005);
    this.decks.B.xfade.gain.setTargetAtTime(b, t, 0.005);
  }
}

export class Deck {
  constructor(mixer, name) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.name = name;
    const ctx = this.ctx;

    this.trim = ctx.createGain();
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 3800;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.lp.Q.value = 0.9;
    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.trim.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.hp);
    this.hp.connect(this.lp);
    this.lp.connect(this.fader);
    this.fader.connect(this.analyser);
    this.fader.connect(this.xfade);
    this.xfade.connect(mixer.master);

    this.buffer = null;
    this.track = null;
    this.source = null;
    this.playing = false;
    this.rate = 1;
    this.startPos = 0; // track seconds at startTime
    this.startTime = 0; // context time when playback (re)started
    this.pausedPos = 0;
    this.cuePoint = 0;
    this.loop = null; // { start, end, beats }
    this.listeners = new Set();

    this.fx = null; // deck-fx worklet node, once loaded
    this.keyShift = 0; // semitones (may be fractional after MATCH)
    this.keyLock = false; // tempo changes leave pitch alone
    this.stems = { vocals: 1, drums: 1, instruments: 1 };

    // AI stems (prototype): when a track's separated stems are loaded, the deck
    // plays them as four synced sources through these gains instead of the
    // mixed buffer, and the DSP stem masks are bypassed.
    this.bus = ctx.createGain(); // every source plays into this
    this.bus.connect(this.trim);
    this.aiStems = null; // { drums, bass, other, vocals } AudioBuffers
    this.aiGains = {};
    for (const n of AI_STEM_NAMES) {
      this.aiGains[n] = ctx.createGain();
      this.aiGains[n].connect(this.bus);
    }
    this.sources = []; // all running sources (1, or 4 with AI stems)
  }

  /** Where the sources play into (then through the fx node when loaded, then the EQ). */
  get input() {
    return this.bus;
  }

  attachFx() {
    if (this.fx) return;
    this.fx = new AudioWorkletNode(this.ctx, 'deck-fx', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { pitch: this.pitchFactor, stems: this.stems },
    });
    this.bus.disconnect();
    this.bus.connect(this.fx);
    this.fx.connect(this.trim);
    this.emit('fx');
  }

  /** Pitch change the fx node applies on top of playback speed. */
  get pitchFactor() {
    return 2 ** (this.keyShift / 12) / (this.keyLock ? this.rate : 1);
  }

  /** How far the heard key is from the track's own key, in semitones. */
  get keyOffset() {
    return this.keyShift + (this.keyLock ? 0 : 12 * Math.log2(this.rate));
  }

  sendFx() {
    // With AI stems the stem levels are applied by aiGains, so the DSP masks stay off.
    const stems = this.aiStems ? { vocals: 1, drums: 1, instruments: 1 } : this.stems;
    this.fx?.port.postMessage({ pitch: this.pitchFactor, stems });
  }

  /** Apply the VOX / DRUMS / INST levels to the AI stem gains (INST = bass + other). */
  applyAiGains() {
    const t = this.ctx.currentTime;
    const level = { vocals: this.stems.vocals, drums: this.stems.drums, bass: this.stems.instruments, other: this.stems.instruments };
    for (const n of AI_STEM_NAMES) this.aiGains[n].gain.setTargetAtTime(level[n], t, 0.015);
  }

  /** Switch this deck to AI stems (buffers keyed drums/bass/other/vocals), keeping position. */
  setAiStems(buffers) {
    this.aiStems = buffers;
    this.applyAiGains();
    this.sendFx();
    if (this.playing) this.startSource(this.position);
    this.emit('stems');
  }

  setKeyShift(semitones) {
    this.keyShift = Math.max(-12, Math.min(12, Math.round(semitones * 100) / 100));
    this.sendFx();
    this.emit('key');
  }

  setKeyLock(on) {
    this.keyLock = !!on;
    this.sendFx();
    this.emit('key');
  }

  /**
   * Shift this deck so it plays in the other deck's (heard) key, or its
   * relative major/minor — same Camelot number, so they mix harmonically.
   * Turns key lock on, so the match holds when tempo moves. Returns the shift
   * in semitones, or null if either key is unknown.
   */
  matchKeyTo(other) {
    const mine = this.track?.key;
    const theirs = other.track?.key;
    if (mine == null || mine < 0 || theirs == null || theirs < 0) return null;
    const relMajor = (k) => (k % 12) + (k >= 12 ? 3 : 0);
    let s = relMajor(theirs) + other.keyOffset - relMajor(mine);
    s = ((s % 12) + 12) % 12;
    if (s >= 6) s -= 12; // smallest move: −6…+6
    this.keyLock = true;
    this.setKeyShift(s);
    return this.keyShift;
  }

  /** Stem level 0..1 (vocals | drums | instruments). */
  setStem(name, level) {
    if (!(name in this.stems)) return;
    this.stems[name] = Math.max(0, Math.min(1, level));
    if (this.aiStems) this.applyAiGains();
    this.sendFx();
    this.emit('stems');
  }

  resetStems() {
    for (const k of STEMS) this.stems[k] = 1;
    if (this.aiStems) this.applyAiGains();
    this.sendFx();
    this.emit('stems');
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type) {
    for (const fn of this.listeners) fn(type, this);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get bpm() {
    return this.track?.bpm || null;
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.rate : null;
  }

  get position() {
    if (!this.playing) return this.pausedPos;
    let pos = this.startPos + (this.ctx.currentTime - this.startTime) * this.rate;
    if (this.loop && pos >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.min(pos, this.duration);
  }

  load(buffer, track) {
    this.stopSource();
    this.buffer = buffer;
    this.track = track;
    this.playing = false;
    this.pausedPos = 0;
    this.cuePoint = track.beatOffset && track.beatOffset < 2 ? track.beatOffset : 0;
    this.loop = null;
    // A new track starts in its own key with every stem on; key lock is a deck setting and stays.
    this.keyShift = 0;
    for (const k of STEMS) this.stems[k] = 1;
    this.aiStems = null;
    this.applyAiGains();
    this.sendFx();
    this.emit('load');
  }

  stopSource() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {}
      s.disconnect();
    }
    this.sources = [];
    this.source = null;
  }

  startSource(at) {
    this.stopSource();
    // One source for the mixed track, or four (one per AI stem) started together.
    const plan = this.aiStems
      ? AI_STEM_NAMES.map((n) => [this.aiStems[n], this.aiGains[n]])
      : [[this.buffer, this.input]];
    const when = this.ctx.currentTime;
    const offset = Math.max(0, Math.min(at, this.duration - 0.001));
    for (const [buffer, dest] of plan) {
      const s = this.ctx.createBufferSource();
      s.buffer = buffer;
      s.playbackRate.value = this.rate;
      if (this.loop) {
        s.loop = true;
        s.loopStart = this.loop.start;
        s.loopEnd = this.loop.end;
      }
      s.connect(dest);
      s.start(when, offset);
      this.sources.push(s);
    }
    const src = this.sources[0];
    src.onended = () => {
      if (this.source === src) {
        this.stopSource();
        this.playing = false;
        this.pausedPos = this.duration;
        this.emit('state');
      }
    };
    this.startPos = at;
    this.startTime = when;
    this.source = src;
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.mixer.resume();
    if (this.pausedPos >= this.duration - 0.01) this.pausedPos = 0;
    this.startSource(this.pausedPos);
    this.playing = true;
    this.emit('state');
  }

  pause() {
    if (!this.playing) return;
    this.pausedPos = this.position;
    this.stopSource();
    this.playing = false;
    this.emit('state');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    if (!this.buffer) return;
    const pos = Math.max(0, Math.min(t, this.duration));
    if (this.loop && (pos < this.loop.start || pos >= this.loop.end)) this.loop = null;
    if (this.playing) this.startSource(pos);
    else this.pausedPos = pos;
    this.emit('seek');
  }

  /** CDJ-style cue: paused → set cue here; playing → jump back to cue and stop. */
  cue() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else {
      const pos = this.snapToBeat(this.position);
      this.cuePoint = pos;
      this.seek(pos);
    }
    this.emit('cue');
  }

  setRate(rate, { silent = false } = {}) {
    if (this.playing) {
      // Rebase so position math stays continuous.
      const pos = this.position;
      this.startPos = pos;
      this.startTime = this.ctx.currentTime;
      if (this.loop && pos < this.loop.start) this.loop = null;
    }
    this.rate = rate;
    for (const s of this.sources) s.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
    if (this.keyLock) this.sendFx(); // pitch correction follows the tempo
    if (!silent) this.emit('rate');
  }

  /** Nudge (pitch bend) for manual beat-matching; call endBend() on release. */
  bend(amount) {
    if (this._baseRate == null) this._baseRate = this.rate;
    this.setRate(this._baseRate * (1 + amount), { silent: true });
  }

  endBend() {
    if (this._baseRate == null) return;
    const base = this._baseRate;
    this._baseRate = null;
    this.setRate(base);
  }

  snapToBeat(pos) {
    const t = this.track;
    if (!t?.bpm || t.beatOffset == null) return pos;
    const period = 60 / t.bpm;
    const n = Math.round((pos - t.beatOffset) / period);
    const snapped = t.beatOffset + n * period;
    return Math.abs(snapped - pos) < period * 0.25 ? Math.max(0, snapped) : pos;
  }

  setLoop(beats) {
    if (!this.buffer) return;
    if (this.loop && this.loop.beats === beats) {
      this.exitLoop();
      return;
    }
    const bpm = this.bpm || 120;
    const period = 60 / bpm;
    const pos = this.position;
    let start = pos;
    if (this.track?.beatOffset != null && this.bpm) {
      const n = Math.floor((pos - this.track.beatOffset) / period);
      start = Math.max(0, this.track.beatOffset + n * period);
    }
    if (this.loop) start = this.loop.start; // resizing keeps the start
    const end = Math.min(this.duration, start + beats * period);
    if (end - start < 0.02) return;
    this.loop = { start, end, beats };
    if (this.playing) {
      // Rebase position, then hand the loop to the running source.
      const p = this.position;
      const inside = p >= start && p < end ? p : start;
      if (inside !== p) this.startSource(inside);
      else {
        this.startPos = p;
        this.startTime = this.ctx.currentTime;
      }
      for (const s of this.sources) {
        s.loopStart = start;
        s.loopEnd = end;
        s.loop = true;
      }
    }
    this.emit('loop');
  }

  exitLoop() {
    if (!this.loop) return;
    if (this.playing) {
      const p = this.position;
      this.startPos = p;
      this.startTime = this.ctx.currentTime;
      for (const s of this.sources) s.loop = false;
    }
    this.loop = null;
    this.emit('loop');
  }

  /** Match tempo (and beat phase, when both grids are known) to another deck. */
  syncTo(other) {
    if (!this.bpm || !other.effectiveBpm) return false;
    let target = other.effectiveBpm;
    // Choose the closest octave (e.g. 87 ↔ 174).
    const candidates = [target, target * 2, target / 2];
    target = candidates.reduce((a, b) => (Math.abs(b - this.bpm) < Math.abs(a - this.bpm) ? b : a));
    const rate = target / this.bpm;
    if (rate < 0.5 || rate > 1.5) return false;
    this.setRate(rate);

    if (this.track.beatOffset != null && other.track?.beatOffset != null && other.bpm) {
      // Express the other deck's beat position on this deck's grid.
      const scale = target / other.effectiveBpm; // 1, 2 or 0.5
      const otherBeats = (other.position - other.track.beatOffset) / (60 / other.bpm);
      const phaseOther = frac(otherBeats * scale);
      const phaseMe = frac((this.position - this.track.beatOffset) / (60 / this.bpm));
      let diff = phaseOther - phaseMe;
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      const shift = diff * (60 / this.bpm);
      if (Math.abs(shift) > 0.002) {
        if (this.playing) {
          this.loop = null;
          this.startSource(Math.max(0, this.position + shift));
        } else {
          this.pausedPos = Math.max(0, this.pausedPos + shift);
        }
      }
    }
    this.emit('sync');
    return true;
  }

  setEq(band, db) {
    const node = band === 'low' ? this.low : band === 'mid' ? this.mid : this.high;
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setTrim(db) {
    this.trim.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setFader(v) {
    // Slight curve so the fader feels even to the ear.
    this.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01);
  }

  /** One-knob filter: -1 = low-pass closed, 0 = off, +1 = high-pass closed. */
  setFilter(x) {
    const t = this.ctx.currentTime;
    if (x < -0.02) {
      const f = 22000 * Math.pow(150 / 22000, -x);
      this.lp.frequency.setTargetAtTime(f, t, 0.01);
      this.hp.frequency.setTargetAtTime(10, t, 0.01);
    } else if (x > 0.02) {
      const f = 10 * Math.pow(6000 / 10, x);
      this.hp.frequency.setTargetAtTime(f, t, 0.01);
      this.lp.frequency.setTargetAtTime(22000, t, 0.01);
    } else {
      this.lp.frequency.setTargetAtTime(22000, t, 0.01);
      this.hp.frequency.setTargetAtTime(10, t, 0.01);
    }
  }
}

const frac = (x) => x - Math.floor(x);

/** Peak level in dBFS from an analyser. */
export function peakDb(analyser, scratch) {
  analyser.getFloatTimeDomainData(scratch);
  let max = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = Math.abs(scratch[i]);
    if (v > max) max = v;
  }
  return max > 0 ? 20 * Math.log10(max) : -Infinity;
}
