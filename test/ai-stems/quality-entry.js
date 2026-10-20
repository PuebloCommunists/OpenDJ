// Temporary app entry: compares cached AI stems against the original track.
// Env: CDJ_AI_TRACK (original audio), CDJ_AI_STEMS (folder with drums/bass/other/vocals.wav)
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const outDir = path.resolve(process.argv[process.argv.length - 1]);

const page = `<!doctype html><meta charset="utf-8"><script>
const fs = require('fs');
const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
(async () => {
  try {
    const ctx = new OfflineAudioContext(2, 1, 44100); // decodes/resamples everything to 44.1 kHz
    const ref = await ctx.decodeAudioData(ab(${JSON.stringify(process.env.CDJ_AI_TRACK)}));
    const names = ['drums', 'bass', 'other', 'vocals'];
    const stems = {};
    for (const n of names) stems[n] = await ctx.decodeAudioData(ab(${JSON.stringify(process.env.CDJ_AI_STEMS)} + '/' + n + '.wav'));
    const len = Math.min(ref.length, stems.drums.length);
    let eRef = 0, eErr = 0;
    const e = Object.fromEntries(names.map((k) => [k, 0]));
    // Per-stem energy in bands, to sanity-check what went where.
    for (let ch = 0; ch < 2; ch++) {
      const r = ref.getChannelData(Math.min(ch, ref.numberOfChannels - 1));
      const s = names.map((n) => stems[n].getChannelData(ch));
      for (let i = 0; i < len; i++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) { sum += s[k][i]; e[names[k]] += s[k][i] * s[k][i]; }
        eRef += r[i] * r[i];
        eErr += (sum - r[i]) ** 2;
      }
    }
    const total = names.reduce((a, k) => a + e[k], 0);
    // Rough check that each stem is what it says: vocals should have little sub-bass,
    // bass should be mostly below 250 Hz.
    const lowShare = async (buf) => {
      const off = new OfflineAudioContext(1, buf.length, 44100);
      const src = off.createBufferSource(); src.buffer = buf;
      const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 250;
      src.connect(lp).connect(off.destination); src.start();
      const low = (await off.startRendering()).getChannelData(0);
      const x = buf.getChannelData(0);
      let a = 0, b = 0; for (let i = 0; i < x.length; i++) { a += low[i] * low[i]; b += x[i] * x[i]; }
      return +(100 * a / (b || 1)).toFixed(1);
    };
    const below250 = {};
    for (const n of names) below250[n] = await lowShare(stems[n]);
    console.log('QUALITY ' + JSON.stringify({
      seconds: +(len / 44100).toFixed(1),
      sumVsOriginal_SNR_dB: +(10 * Math.log10(eRef / eErr)).toFixed(1),
      energySharePct: Object.fromEntries(names.map((k) => [k, +(100 * e[k] / total).toFixed(1)])),
      pctEnergyBelow250Hz: below250,
    }));
  } catch (err) { console.log('QUALITY ' + JSON.stringify({ error: String(err && err.stack || err) })); }
})();
</script>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  win.webContents.on('console-message', (e) => {
    if (e.message.startsWith('QUALITY ')) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'quality.json'), e.message.slice(8));
      app.exit(0);
    }
  });
  setTimeout(() => app.exit(1), 300000);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
});
