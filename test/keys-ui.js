// Boots the real app with a throwaway library of two synthetic tracks in known
// keys (A minor and C# minor... see below), then drives the key and stem
// controls and records what the UI shows. Used as a temporary entry point.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-keys-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const SR = 44100;
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
// Stereo track: chords in the centre ("vocal-ish" centre content), a pad panned
// left, and a kick + hat pattern — so every stem has something to act on.
function writeTrack(file, { bpm, chords, seconds = 40 }) {
  const n = SR * seconds;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const beat = 60 / bpm;
  const bar = 4 * beat;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const ch = chords[Math.floor(t / bar) % chords.length];
    let c = 0;
    ch.forEach((m, j) => {
      const f = midiHz(j === 0 ? m - 12 : m);
      for (let h = 1; h <= 3; h++) c += (Math.sin(2 * Math.PI * f * h * t) * 0.05) / h;
    });
    const pad = Math.sin(2 * Math.PI * midiHz(ch[1] + 12) * t) * 0.04;
    L[i] = c + pad;
    R[i] = c;
  }
  for (let b = 0; b * beat < seconds; b++) {
    const i0 = Math.round(b * beat * SR);
    for (let i = 0; i < 0.2 * SR && i0 + i < n; i++) {
      const tt = i / SR;
      const k = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 12) * 0.6;
      L[i0 + i] += k;
      R[i0 + i] += k;
    }
    const h0 = Math.round((b + 0.5) * beat * SR);
    for (let i = 0; i < 0.04 * SR && h0 + i < n; i++) {
      const s = rnd() * Math.exp((-i / SR) * 90) * 0.15;
      L[h0 + i] += s;
      R[h0 + i] += s;
    }
  }
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(q(L[i]), 44 + i * 4);
    buf.writeInt16LE(q(R[i]), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
const maj = (r) => [r, r + 12, r + 16, r + 19];
const min = (r) => [r, r + 12, r + 15, r + 19];
// Track 1: A minor (8A). Track 2: D minor (7A) — 5 semitones apart, MATCH should move B by −5... or +7 → wraps to −5.
const t1 = path.join(tmp, 'Key Test - A minor 124.wav');
const t2 = path.join(tmp, 'Key Test - D minor 120.wav');
writeTrack(t1, { bpm: 124, chords: [min(57), maj(53), maj(48), maj(55), min(57), min(50), maj(52), min(57)] });
writeTrack(t2, { bpm: 120, chords: [min(50), min(55), maj(57), min(50)] });
fs.writeFileSync(
  path.join(tmp, 'library.json'),
  JSON.stringify({
    version: 1,
    tracks: [
      { id: 'k1', title: 'A minor 124', artist: 'Key Test', file: t1, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } },
      { id: 'k2', title: 'D minor 120', artist: 'Key Test', file: t2, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } },
    ],
  }),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const keyRead = (d) => js(`document.querySelector('#deck${d} .key-read').textContent`);
    const toasts = () => js(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`);
    const report = {};
    try {
      await sleep(1000);
      report.stemsEnabledAtBoot = await js(`[...document.querySelectorAll('#deckA .stem')].every(b => !b.disabled)`);
      await js(`document.querySelector('tr[data-id="k1"] [data-load="A"]').click()`);
      await sleep(4000);
      await js(`document.querySelector('tr[data-id="k2"] [data-load="B"]').click()`);
      await sleep(4000);
      report.loaded = { A: await keyRead('A'), B: await keyRead('B') };
      report.libraryKeys = await js(`[...document.querySelectorAll('#libBody tr')].map(tr => tr.children[1].textContent + ' | ' + tr.children[4].textContent)`);
      report.savedKeys = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')).tracks.map((t) => ({ id: t.id, key: t.key, bpm: t.bpm }));

      // Play both, shift A up 2 semitones.
      await js(`document.querySelector('#deckA .play').click(); document.querySelector('#deckB .play').click()`);
      await sleep(500);
      await js(`document.querySelector('#deckA .key-up').click(); document.querySelector('#deckA .key-up').click()`);
      await sleep(300);
      report.afterUp2 = await keyRead('A');
      await js(`document.querySelector('#deckA .key-read').click()`);
      await sleep(200);
      report.keyAfterReset = await keyRead('A');

      // Tempo +6% on A without key lock → key display moves ~+1 st; with LOCK it doesn't.
      await js(`const s = document.querySelector('#deckA .tempo-slider'); s.value = 375; s.dispatchEvent(new Event('input'))`); // 375/1000 × 16% = +6%
      await sleep(200);
      report.tempo6NoLock = await keyRead('A');
      await js(`document.querySelector('#deckA .key-lock').click()`);
      await sleep(200);
      report.tempo6Lock = { read: await keyRead('A'), lockOn: await js(`document.querySelector('#deckA .key-lock').classList.contains('on')`) };

      // MATCH deck B to deck A.
      await js(`document.querySelector('#deckB .key-match').click()`);
      await sleep(400);
      report.afterMatchB = { read: await keyRead('B'), lockB: await js(`document.querySelector('#deckB .key-lock').classList.contains('on')`), toasts: await toasts() };

      // Stems: toggle drums off, solo vocals, right-click reset.
      await js(`document.querySelector('#deckA .stem[data-stem="drums"]').click()`);
      await sleep(100);
      report.drumsOff = await js(`[...document.querySelectorAll('#deckA .stem')].map(b => b.dataset.stem + ':' + (b.classList.contains('off') ? 'off' : 'on'))`);
      await js(`document.querySelector('#deckA .stem[data-stem="vocals"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`);
      await sleep(100);
      report.soloVox = await js(`[...document.querySelectorAll('#deckA .stem')].map(b => b.dataset.stem + ':' + (b.classList.contains('off') ? 'off' : 'on'))`);
      await sleep(1500); // let it play processed
      // Level check: deck A meter should still show signal with only vocals on.
      report.peakA = await js(`document.querySelector('#deckA') && document.querySelectorAll('.meter-fill').length`);
      fs.writeFileSync(path.join(outDir, 'keys-1.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#deckA .stem[data-stem="drums"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      await sleep(100);
      report.afterReset = await js(`[...document.querySelectorAll('#deckA .stem')].map(b => b.dataset.stem + ':' + (b.classList.contains('off') ? 'off' : 'on'))`);
      await sleep(2000);
      report.stillPlaying = await js(`({ A: document.querySelector('#deckA .elapsed').textContent, B: document.querySelector('#deckB .elapsed').textContent })`);
      fs.writeFileSync(path.join(outDir, 'keys-2.png'), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      report.error = String((err && err.stack) || err);
    }
    report.logs = logs;
    fs.writeFileSync(path.join(outDir, 'keys-report.json'), JSON.stringify(report, null, 2));
    app.exit(0);
  });
});

require('../src/main.js');
