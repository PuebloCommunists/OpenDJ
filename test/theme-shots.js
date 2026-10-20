// Screenshot helper: boots the app at ~1080p with two synthetic tracks loaded and
// playing, then captures every theme (decks, plus the search tab expanded).
// Run: xvfb-run electron test/theme-shots.js <outDir>
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const outDir = path.resolve(process.argv[process.argv.length - 1].endsWith('.js') ? os.tmpdir() : process.argv[process.argv.length - 1]);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-smoke-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// --- synthetic 124 BPM house loop as a WAV file
function writeWav(file, seconds, bpm, offset) {
  const sr = 44100;
  const n = sr * seconds;
  const data = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const beat = 60 / bpm;
  for (let b = 0; offset + b * beat < seconds; b++) {
    const t = offset + b * beat;
    const i0 = Math.round(t * sr);
    for (let i = 0; i < 0.25 * sr && i0 + i < n; i++) {
      const tt = i / sr;
      data[i0 + i] += Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 12) * 0.8;
    }
    const h0 = Math.round((t + beat / 2) * sr);
    for (let i = 0; i < 0.05 * sr && h0 + i < n; i++) data[h0 + i] += rnd() * Math.exp((-i / sr) * 80) * 0.25;
  }
  for (let i = 0; i < n; i++) data[i] += Math.sin((2 * Math.PI * 110 * i) / sr) * 0.06;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
const wav = path.join(tmp, 'Test Artist - Smoke Loop 124.wav');
writeWav(wav, 60, 124, 0.25);
const wav2 = path.join(tmp, 'Other Artist - Second Loop 120.wav');
writeWav(wav2, 60, 120, 0.1);
fs.writeFileSync(
  path.join(tmp, 'library.json'),
  JSON.stringify({
    version: 1,
    tracks: [
      { id: 't1', title: 'Smoke Loop 124', artist: 'Test Artist', file: wav, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } },
      { id: 't2', title: 'Second Loop 120', artist: 'Other Artist', file: wav2, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } },
      { id: 't3', title: 'Example CC Track', artist: 'Some Channel', file: wav, duration: 60, bpm: 124, beatOffset: 0.25, cues: [null, null, null, null], source: { kind: 'web', extractor: 'Youtube', id: 'abc', url: 'https://www.youtube.com/watch?v=abc', uploader: 'Some Channel', license: 'Creative Commons Attribution license (reuse allowed)' } },
    ],
  }),
);

if (process.env.CDJ_FAKE_YTDLP) {
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  const dest = path.join(tmp, 'bin', 'yt-dlp');
  fs.copyFileSync(process.env.CDJ_FAKE_YTDLP, dest);
  fs.chmodSync(dest, 0o755);
  process.env.CDJ_FAKE_AUDIO = wav2;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
    try {
      win.setContentSize(1900, 1010);
      await sleep(800);
      await js(`document.querySelector('tr[data-id="t1"] [data-load="A"]').click()`);
      await sleep(2500);
      await js(`document.querySelector('tr[data-id="t2"] [data-load="B"]').click()`);
      await sleep(2500);
      await js(`document.querySelector('#deckA .play').click(); document.querySelector('#deckB .sync').click()`);
      await js(`document.querySelector('#deckA .hc[data-i="0"]').click(); document.querySelector('#deckA .lp[data-beats="4"]').click()`);
      await js(`document.querySelector('#deckA .key-lock').click(); document.querySelector('#deckB .stem[data-stem="vocals"]').click()`);
      await sleep(1500);
      for (const theme of ['light', 'dark', 'skrillex']) {
        await js(`(s => { s.value = '${theme}'; s.dispatchEvent(new Event('change')); })(document.querySelector('#themeSel'))`);
        await sleep(700);
        await shot(`${theme}-decks.png`);
      }
      await js(`(s => { s.value = 'light'; s.dispatchEvent(new Event('change')); })(document.querySelector('#themeSel'))`);
      await js(`document.querySelector('#split').dispatchEvent(new MouseEvent('dblclick'))`);
      await sleep(500);
      await shot('light-waves-hidden.png');
      await js(`document.querySelector('#split').dispatchEvent(new MouseEvent('dblclick'))`);
    } catch (err) {
      fs.writeFileSync(path.join(outDir, 'error.txt'), String((err && err.stack) || err));
    }
    app.exit(0);
  });
});

require('../src/main.js');
