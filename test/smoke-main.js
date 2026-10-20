// Headless smoke test: boots the real app with a temp library, loads a synthetic
// track onto deck A, plays it, and saves screenshots + console output.
// Run: xvfb-run electron test/smoke-main.js <outDir>
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

const logs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.on('preload-error', (_ev, p, err) => logs.push(`[preload-error] ${p} ${err}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const report = {};
    try {
      await sleep(800);
      report.rows = await js(`document.querySelectorAll('#libBody tr').length`);
      await js(`document.querySelector('tr[data-id="t1"] [data-load="A"]').click()`);
      await sleep(2500);
      await js(`document.querySelector('tr[data-id="t2"] [data-load="B"]').click()`);
      await sleep(2500);
      report.afterLoad = await js(`({ titleA: document.querySelector('#deckA .t-title').textContent, bpmA: document.querySelector('#deckA .bpm-eff').textContent, bpmB: document.querySelector('#deckB .bpm-eff').textContent, libBpm: [...document.querySelectorAll('#libBody tr td.num')].map(td => td.textContent) })`);
      await js(`document.querySelector('#deckA .play').click(); document.querySelector('#deckB .play').click()`);
      await sleep(1500);
      await js(`document.querySelector('#deckB .sync').click()`);
      await sleep(300);
      await js(`document.querySelector('#deckA .hc[data-i="0"]').click()`);
      await js(`document.querySelector('#deckA .lp[data-beats="4"]').click()`);
      await sleep(2500);
      report.playing = await js(`({ elapsedA: document.querySelector('#deckA .elapsed').textContent, bpmB: document.querySelector('#deckB .bpm-eff').textContent, rateB: document.querySelector('#deckB .rate').textContent, hotcueSet: document.querySelector('#deckA .hc[data-i="0"]').classList.contains('set'), loopOn: document.querySelector('#deckA .lp[data-beats="4"]').classList.contains('on'), playOn: document.querySelector('#deckA .play').classList.contains('on') })`);
      fs.writeFileSync(path.join(outDir, 'smoke-decks.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('.tab[data-tab="cc"]').click(); document.querySelector('#ccQuery').value = 'lofi beat'; document.querySelector('#ccSearchForm').requestSubmit()`);
      await sleep(process.env.CDJ_FAKE_YTDLP ? 1500 : 6000);
      report.ccStatus = await js(`document.querySelector('#ccStatus').textContent`);
      report.ccResults = await js(`[...document.querySelectorAll('.cc-item .ttl')].map(e => e.textContent)`);
      if (process.env.CDJ_FAKE_YTDLP) {
        await js(`document.querySelector('.cc-item [data-get]').click()`);
        await sleep(2500);
        report.afterAdd = await js(`({ btn: document.querySelector('.cc-item [data-get]').textContent, msg: document.querySelector('.cc-item .msg').textContent })`);
        const paste = async (u) => {
          await js(`document.querySelector('#ccLink').value = ${JSON.stringify(u)}; document.querySelector('#ccLinkForm').requestSubmit()`);
          await sleep(2500);
          return js(`document.querySelector('#ccStatus').textContent`);
        };
        report.pasteNonCc = await paste('https://www.youtube.com/watch?v=nocc');
        report.pasteCc = await paste('https://www.youtube.com/watch?v=ccA');
        report.pasteAgain = await paste('https://www.youtube.com/watch?v=ccA');
        report.pasteNoLicenseButCc = await paste('https://www.youtube.com/watch?v=ccX');
        report.pasteNoLicenseNotCc = await paste('https://www.youtube.com/watch?v=nolic');
        report.libraryRows = await js(`[...document.querySelectorAll('#libBody tr')].map(tr => tr.children[1].textContent + ' | ' + tr.children[6].textContent)`);
        await js(`document.querySelector('#deckA .play').click()`);
        await sleep(300);
        const firstWeb = await js(`document.querySelector('#libBody tr').dataset.id`);
        await js(`document.querySelector('tr[data-id="${firstWeb}"] [data-load="A"]').click()`);
        await sleep(2500);
        await js(`document.querySelector('#deckA .play').click()`);
        await sleep(500);
        await js(`document.querySelector('#creditsBtn').click()`);
        await sleep(300);
        report.credits = await js(`document.querySelector('#creditsText').value`);
        fs.writeFileSync(path.join(outDir, 'smoke-credits.png'), (await win.webContents.capturePage()).toPNG());
        await js(`document.querySelector('#creditsDialog').close()`);
      }
      report.ytdlpChip = await js(`document.querySelector('#ytdlpChip').textContent`);
      fs.writeFileSync(path.join(outDir, 'smoke-cc.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#helpBtn').click()`);
      await sleep(300);
      fs.writeFileSync(path.join(outDir, 'smoke-help.png'), (await win.webContents.capturePage()).toPNG());
      report.savedLibrary = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')).tracks.map((t) => ({ id: t.id, bpm: t.bpm, offset: t.beatOffset, cues: t.cues }));
    } catch (err) {
      report.error = String(err && err.stack || err);
    }
    report.logs = logs;
    fs.writeFileSync(path.join(outDir, 'smoke-report.json'), JSON.stringify(report, null, 2));
    app.exit(0);
  });
});

require('../src/main.js');
