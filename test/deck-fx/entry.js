// Temporary app entry: opens the deck-fx test page in a hidden window and saves the results.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
const TOOLS = process.env.CDJ_FX_TEST_DIR;

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const worklet = pathToFileURL(path.join(app.getAppPath(), 'src', 'renderer', 'deck-fx.worklet.js')).href;
  win.webContents.on('console-message', (e) => {
    const msg = e.message;
    if (msg.startsWith('FXTEST ')) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'fx-report.json'), msg.slice(7));
      app.exit(0);
    }
  });
  setTimeout(() => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'fx-report.json'), JSON.stringify([{ name: 'timeout', ok: false }]));
    app.exit(1);
  }, 120000);
  win.loadFile(path.join(TOOLS, 'fx-test.html'), { query: { worklet } });
});
