// Scratch voice: plays a deck's track at whatever speed and direction the hand
// moves it (record or waveform), forwards or backwards, with vinyl-style pitch.
// The UI sends target positions; the playhead chases them smoothly, so a still
// hand is silent and a fast flick is a high-pitched zip.

class Scratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null; // Float32Array per channel
    this.active = false;
    this.pos = 0; // seconds
    this.target = 0;
    this.vel = 0; // playback rate (1 = normal, negative = backwards)
    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') this.ch = data.channels;
      else if (data.type === 'start') {
        this.active = true;
        this.pos = this.target = data.pos;
        this.vel = 0;
      } else if (data.type === 'target') this.target = data.pos;
      else if (data.type === 'stop') this.active = false;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.active || !this.ch) return true;
    const ch = this.ch;
    const len = ch[0].length;
    const n = out[0].length;
    const dt = 1 / sampleRate;
    for (let i = 0; i < n; i++) {
      // Chase the hand: speed that would close the gap in ~25 ms, eased in.
      const want = Math.max(-6, Math.min(6, (this.target - this.pos) / 0.025));
      this.vel += (want - this.vel) * 0.004;
      this.pos += this.vel * dt;
      const x = this.pos * sampleRate;
      const j = Math.floor(x);
      const f = x - j;
      // Fade with speed so a still record is silent (no DC hold) and starts don't click.
      const g = Math.min(1, Math.abs(this.vel) * 3);
      for (let c = 0; c < out.length; c++) {
        const src = ch[Math.min(c, ch.length - 1)];
        out[c][i] = j >= 0 && j + 1 < len ? (src[j] * (1 - f) + src[j + 1] * f) * g : 0;
      }
    }
    return true;
  }
}

registerProcessor('scratch', Scratch);
