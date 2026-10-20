// SFX pads: dubstep / dariacore one-shots, all synthesized with Web Audio (no
// sample files). Each sound is a function (ctx, out, t, beat) that schedules its
// nodes to start at audio time t; `beat` is the current beat length in seconds
// (wobble and stutter follow the tempo). Pads play into their own gain, then the
// master, so the limiter catches them.

function noise(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}

function env(ctx, out, t, { attack = 0.005, peak = 1, hold = 0, release = 0.3 }) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  g.connect(out);
  return { g, end: t + attack + hold + release + 0.05 };
}

function osc(ctx, type, freq, t, end, dest) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.connect(dest);
  o.start(t);
  o.stop(end);
  return o;
}

export const SOUNDS = [
  {
    id: 'horn', label: 'Air horn', play(ctx, out, t) {
      // Three stabs of a detuned saw stack through a nasal band-pass.
      [0, 0.16, 0.32].forEach((dt, i) => {
        const len = i === 2 ? 0.55 : 0.12;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.2;
        const { g, end } = env(ctx, out, t + dt, { attack: 0.004, peak: 0.35, hold: len, release: 0.08 });
        bp.connect(g);
        for (const f of [466, 470, 554, 698]) osc(ctx, 'sawtooth', f, t + dt, end, bp);
      });
    },
  },
  {
    id: 'siren', label: 'Dub siren', play(ctx, out, t) {
      const { g, end } = env(ctx, out, t, { attack: 0.01, peak: 0.6, hold: 1.6, release: 0.3 });
      const o = osc(ctx, 'square', 600, t, end, g);
      const lfo = ctx.createOscillator(); // pitch wail that speeds up
      lfo.type = 'triangle';
      lfo.frequency.setValueAtTime(5, t);
      lfo.frequency.linearRampToValueAtTime(9, end);
      const depth = ctx.createGain();
      depth.gain.value = 350;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(t);
      lfo.stop(end);
    },
  },
  {
    id: 'laser', label: 'Laser', play(ctx, out, t) {
      const { g, end } = env(ctx, out, t, { attack: 0.002, peak: 0.6, release: 0.35 });
      const o = osc(ctx, 'sawtooth', 3200, t, end, g);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.3);
    },
  },
  {
    id: 'subdrop', label: 'Sub drop', play(ctx, out, t) {
      const { g, end } = env(ctx, out, t, { attack: 0.005, peak: 0.9, hold: 0.2, release: 1.6 });
      const o = osc(ctx, 'sine', 160, t, end, g);
      o.frequency.exponentialRampToValueAtTime(30, t + 1.6);
    },
  },
  {
    id: 'boom', label: 'Boom', play(ctx, out, t) {
      // Deep thump with a short reverb-ish noise tail.
      const { g, end } = env(ctx, out, t, { attack: 0.002, peak: 1, release: 1.2 });
      const o = osc(ctx, 'sine', 90, t, end, g);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.5);
      const n = noise(ctx, 1.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + 1);
      const ng = env(ctx, out, t, { attack: 0.002, peak: 0.25, release: 0.9 });
      n.connect(lp).connect(ng.g);
      n.start(t); n.stop(ng.end);
    },
  },
  {
    id: 'impact', label: 'Impact', play(ctx, out, t) {
      const n = noise(ctx, 2);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 300;
      const ng = env(ctx, out, t, { attack: 0.001, peak: 0.45, release: 1.6 });
      n.connect(hp).connect(ng.g);
      n.start(t); n.stop(ng.end);
      const { g, end } = env(ctx, out, t, { attack: 0.001, peak: 0.8, release: 0.6 });
      osc(ctx, 'sine', 55, t, end, g);
    },
  },
  {
    id: 'wobble', label: 'Wobble', play(ctx, out, t, beat) {
      // One bar of wub: saw bass through a low-pass opened by a tempo-synced LFO (⅛ notes).
      const len = beat * 4;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 8; lp.frequency.value = 400;
      const { g, end } = env(ctx, out, t, { attack: 0.01, peak: 0.45, hold: len - 0.05, release: 0.05 });
      lp.connect(g);
      osc(ctx, 'sawtooth', 55, t, end, lp);
      osc(ctx, 'square', 55.4, t, end, lp);
      const lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 2 / beat;
      const depth = ctx.createGain();
      depth.gain.value = 1100;
      lfo.connect(depth).connect(lp.frequency);
      lfo.start(t); lfo.stop(end);
    },
  },
  {
    id: 'riser', label: 'Riser', play(ctx, out, t, beat) {
      const len = beat * 4;
      const n = noise(ctx, len + 0.1);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 2;
      bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + len); g.gain.linearRampToValueAtTime(0, t + len + 0.02);
      n.connect(bp).connect(g).connect(out);
      n.start(t); n.stop(t + len + 0.05);
    },
  },
  {
    id: 'rewind', label: 'Rewind', play(ctx, out, t) {
      // Tape spin-back: a buzzy tone sliding down and up fast, then a stop.
      const { g, end } = env(ctx, out, t, { attack: 0.01, peak: 0.3, hold: 0.7, release: 0.1 });
      const o = osc(ctx, 'sawtooth', 220, t, end, g);
      for (let i = 0; i < 6; i++) {
        o.frequency.linearRampToValueAtTime(i % 2 ? 900 : 120, t + 0.12 * (i + 1));
      }
      o.frequency.exponentialRampToValueAtTime(30, end);
    },
  },
  {
    id: 'zap', label: 'Stutter zap', play(ctx, out, t, beat) {
      // Dariacore-style glitch: 1/16-note bleeps climbing in pitch for one beat.
      const step = beat / 4;
      for (let i = 0; i < 8; i++) {
        const s = t + i * (step / 2);
        const { g, end } = env(ctx, out, s, { attack: 0.001, peak: 0.5, release: step / 2.2 });
        osc(ctx, 'square', 440 * 2 ** (i / 4), s, end, g);
      }
    },
  },
];
