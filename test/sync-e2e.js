// End-to-end sync test: boots the real app with synthetic tracks whose true beats are
// known, presses Sync like a DJ would, and checks two things:
//  • alignment: where the engine has each deck, the two tracks' real beats coincide;
//  • timing: what each deck actually plays (recorded inside the audio graph) sits exactly
//    where the engine's position says, with the same delay on both decks. (Measured on
//    drum-only tracks: an offbeat bass blurs where a kick starts in a recording.)
// Run: xvfb-run node_modules/.bin/electron test/sync-e2e.js <outDir>   (exit 1 if out of step)
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const outDir = path.resolve(process.argv[process.argv.length - 1].endsWith('.js') ? os.tmpdir() : process.argv[process.argv.length - 1]);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-sync-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function writeWav(file, mono, sr = 44100) {
  const n = mono.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono[i] * 0.8 * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// Recorder (two inputs, so both decks are captured on the same sample clock) and the
// measurement: low-band onset envelopes at 1 kHz, cross-correlated over ±80 ms.
const RENDERER_HELPERS = `
const posOf = (d, t) => (d.posAt ? d.posAt(t) : d.startPos + (t - d.startTime) * d.rate);
window.__rec = (() => {
  const code = \`class Rec extends AudioWorkletProcessor {
    constructor() { super(); this.a = []; this.b = []; this.on = false;
      this.port.onmessage = (e) => {
        if (e.data === 'start') { this.a = []; this.b = []; this.on = true; this.t0 = null; }
        else { this.on = false; const join = (l) => { const o = new Float32Array(l.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of l) { o.set(x, i); i += x.length; } return o; };
          this.port.postMessage({ a: join(this.a), b: join(this.b), t0: this.t0 }); } }; }
    process(inputs) { if (this.on) { if (this.t0 == null) this.t0 = currentTime; this.a.push((inputs[0][0] || new Float32Array(128)).slice()); this.b.push((inputs[1][0] || new Float32Array(128)).slice()); } return true; }
  }
  registerProcessor('rec', Rec);\`;
  let node = null;
  return {
    async setup() {
      const m = window.cdjDebug.mixer;
      await m.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
      node = new AudioWorkletNode(m.ctx, 'rec', { numberOfInputs: 2, numberOfOutputs: 1 });
      m.decks.A.fader.connect(node, 0, 0);
      m.decks.B.fader.connect(node, 0, 1);
      const sink = m.ctx.createGain(); sink.gain.value = 0; node.connect(sink); sink.connect(m.ctx.destination);
    },
    start() { node.port.postMessage('start'); },
    stop() { return new Promise((res) => { node.port.onmessage = (e) => res(e.data); node.port.postMessage('stop'); }); },
  };
})();
// Per deck: where its kicks really are in the recording vs where the engine's position says.
window.__selfCheck = (rec, sr, TRUE) => {
  const m = window.cdjDebug.mixer, out = {};
  for (const [name, x] of [['A', rec.a], ['B', rec.b]]) {
    const d = m.decks[name], [o, bpm] = TRUE[d.track.id], per = 60 / bpm;
    const a = 1 - Math.exp(-2 * Math.PI * 150 / sr);
    let lp = 0; const e = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { lp += a * (x[i] - lp); e[i] = lp * lp; }
    const offs = [];
    const t1 = rec.t0 + x.length / sr;
    for (let k = Math.ceil((posOf(d, rec.t0) - o) / per); ; k++) {
      const b = o + k * per; const t = d.startTime + (b - d.startPos) / d.rate; if (t > t1 - 0.2) break; if (t < rec.t0 + 0.1) continue;
      const i0 = Math.round((t - rec.t0) * sr);
      // onset = first sample in [-30, +80] ms reaching 10 % of the local peak energy
      let pk = 0; for (let i = i0 - sr * 0.03; i < i0 + sr * 0.08; i++) pk = Math.max(pk, e[i | 0] || 0);
      let j = i0 - sr * 0.03 | 0; while (j < i0 + sr * 0.08 && (e[j] || 0) < 0.1 * pk) j++;
      offs.push((j - i0) / sr * 1000);
    }
    offs.sort((p, q) => p - q);
    out[name] = offs.length ? +offs[offs.length >> 1].toFixed(1) : null;
  }
  return out;
};
window.__measure = (rec, sr) => {
  const env = (x) => {
    const hop = Math.round(sr / 1000), a = 1 - Math.exp(-2 * Math.PI * 150 / sr);
    const n = Math.floor(x.length / hop), e = new Float32Array(n);
    let lp = 0, prev = 0;
    for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) { lp += a * (x[i] - lp); s += lp * lp; } const v = Math.log1p(1e4 * s / hop); e[f] = Math.max(0, v - prev); prev = v; }
    return e;
  };
  const A = env(rec.a), B = env(rec.b), L = 80;
  const r = [];
  for (let lag = -L; lag <= L; lag++) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = L; i < A.length - L; i++) { const x = A[i], y = B[i + lag]; ab += x * y; aa += x * x; bb += y * y; }
    r.push(ab / Math.sqrt(aa * bb + 1e-12));
  }
  let k = 0; for (let i = 1; i < r.length; i++) if (r[i] > r[k]) k = i;
  const y0 = r[k - 1] ?? r[k], y2 = r[k + 1] ?? r[k], den = y0 - 2 * r[k] + y2;
  const lagMs = k - L + (den < 0 ? 0.5 * (y0 - y2) / den : 0);
  return { lagMs: Math.round(lagMs * 10) / 10, corr: Math.round(r[k] * 100) / 100 };
};
`;

const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const report = { scenarios: [] };
    let fails = 0;
    try {
      await sleep(800);
      await js(RENDERER_HELPERS + ";0");
      await js(`window.__rec.setup()`);
      const sr = await js(`window.cdjDebug.mixer.ctx.sampleRate`);
      const load = async (deck, id) => {
        await js(`document.querySelector('tr[data-id="${id}"] [data-load="${deck}"]').click()`);
        for (let i = 0; i < 100; i++) {
          await sleep(200);
          if (await js(`(() => { const d = window.cdjDebug.mixer.decks.${deck}; return d.track?.id === '${id}' && (!!d.kicks || !('holdPhase' in d)); })()`)) return;
        }
        throw new Error(`deck ${deck} never loaded ${id}`);
      };
      const TRUE = { house: [0.37, 124], techno: [0.17, 131], offgrid: [0.12, 127.3], drift: [0.17, 131] };
      const record = async (seconds) => {
        await js(`window.__rec.start()`);
        await sleep(seconds * 1000);
        return js(`window.__rec.stop().then((r) => ({ ...window.__measure(r, ${sr}), audioMinusBook: window.__selfCheck(r, ${sr}, ${JSON.stringify(TRUE)}) }))`);
      };
      // Where the engine thinks each deck is, against the tracks' true beats (real-time ms off the beat).
      const deckInfo = (d) => js(`(() => { const m = window.cdjDebug.mixer, d = m.decks.${d}, a = m.decks.A, t = m.ctx.currentTime + 0.1;
        const T = ${JSON.stringify(TRUE)};
        const off = (x) => { const [o, bpm] = T[x.track.id]; const per = 60 / bpm; let p = ((posOf(x, t) - o) % per + per) % per; if (p > per / 2) p -= per; return +(p / x.rate * 1000).toFixed(1); };
        return { bpm: d.bpm, offset: +d.track.beatOffset.toFixed(4), rate: +d.rate.toFixed(5), rateA: +a.rate.toFixed(5), fine: d.lastFine ? +(d.lastFine.shift * 1000).toFixed(1) : null, bookA: off(a), bookB: off(d) }; })()`);
      // In step = the engine has the true beats within 2 ms; and, where the recording can
      // tell (drum-only tracks), both decks sound exactly that far behind the engine.
      const check = (name, m, info, { timing = false, within = 2 } = {}) => {
        const apart = Math.abs(info.bookA - info.bookB);
        const lag = timing ? Math.abs(m.audioMinusBook.A - m.audioMinusBook.B) : 0;
        const ok = apart <= within && lag <= 1.5;
        if (!ok) fails++;
        report.scenarios.push({ name, ok, beatsApartMs: +apart.toFixed(1), soundVsEngine: m.audioMinusBook, timingChecked: timing, B: info });
      };

      await load('A', 'house');
      await js(`document.querySelector('#deckA .play').click()`);

      // 1) Fresh tracks, analysed on load: house 124 ← techno 131 with an offbeat bass.
      await load('B', 'techno');
      await sleep(1500);
      await js(`document.querySelector('#deckB .play').click()`);
      await sleep(700);
      await js(`document.querySelector('#deckB .sync').click()`);
      await sleep(500);
      check('fresh analysis, techno 131 offbeat bass → house 124', await record(6), await deckInfo('B'));

      // 2) A stored grid 20 ms off: the audio alignment has to fix it.
      await js(`document.querySelector('#deckB .play').click()`);
      await sleep(300);
      await load('B', 'offgrid');
      await js(`document.querySelector('#deckB .play').click()`);
      await sleep(900);
      await js(`document.querySelector('#deckB .sync').click()`);
      await sleep(500);
      check('stored grid 20 ms off, house 127.3 → house 124', await record(6), await deckInfo('B'), { timing: true });

      // 3) A stored BPM 0.15 % off: the decks drift ~1.5 ms a second unless the phase lock holds them.
      await js(`document.querySelector('#deckB .play').click()`);
      await sleep(300);
      await load('B', 'drift');
      await js(`document.querySelector('#deckB .play').click()`);
      await sleep(900);
      await js(`document.querySelector('#deckB .sync').click()`);
      await sleep(500);
      check('BPM 0.15 % off, right after Sync', await record(5), await deckInfo('B'));
      await sleep(18000);
      // The lock lets ~3 ms build up before it bends the deck back, so allow a little more here.
      check('BPM 0.15 % off, 25 s later (phase lock)', await record(5), await deckInfo('B'), { within: 4 });

      fs.writeFileSync(path.join(outDir, 'sync-e2e.png'), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      report.error = String((err && err.stack) || err);
      fails++;
    }
    report.logs = logs.filter((l) => !l.includes('DevTools'));
    fs.writeFileSync(path.join(outDir, 'sync-e2e.json'), JSON.stringify(report, null, 2));
    for (const s of report.scenarios) console.log(`${s.ok ? 'PASS' : 'FAIL'} ${s.name}: beats ${s.beatsApartMs} ms apart${s.timingChecked ? `, sound vs engine A ${s.soundVsEngine.A} / B ${s.soundVsEngine.B} ms` : ''}  (B: ${s.B.bpm} BPM, rate ${s.B.rate}, audio fine-tune ${s.B.fine} ms)`);
    if (report.error) console.log('ERROR', report.error);
    app.exit(fails ? 1 : 0);
  });
});

(async () => {
  const { render, CASES } = await import('./sync-bench.mjs');
  const mk = (id, c, seconds, patch = {}) => {
    const file = path.join(tmp, `${id}.wav`);
    writeWav(file, render({ ...c, seconds }).buf);
    return { id, title: c.name, artist: 'Sync Test', file, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' }, ...patch };
  };
  const house = CASES.find((c) => c.name === 'house 124');
  const house2 = CASES.find((c) => c.name === 'house 127.3');
  const techno = CASES.find((c) => c.name.startsWith('techno 131'));
  const tracks = [
    mk('house', house, 150),
    mk('techno', techno, 90),
    mk('offgrid', house2, 60, { bpm: house2.bpm, beatOffset: house2.offset + 0.02, beatsPerBar: 4, downbeat: house2.offset + 0.02, gridVersion: 2 }),
    mk('drift', techno, 60, { bpm: 131.2, beatOffset: techno.offset, beatsPerBar: 4, downbeat: techno.offset, gridVersion: 2 }),
  ];
  fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks }));
  require('../src/main.js');
})();
