// Commons DJ — main process
// Owns the window, the track library on disk, and the yt-dlp integration.
// The renderer never touches the filesystem or spawns processes directly;
// everything goes through the IPC handlers below.

const { app, BrowserWindow, ipcMain, dialog, shell, net, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'webm', 'aif', 'aiff'];

// YouTube's own "Creative Commons" search filter. Not used in the NoGate
// build's search (see search-issues/3-cc-filter.md).
const CC_SEARCH_PARAM = 'EgIwAQ%253D%253D';

// NO-GATE BUILD: the license gate (license-field check, CC-search memory and
// title-search fallback) is removed here. See license-gate-features/ for the
// original code and the plan for putting each piece back.

const paths = {};
let mainWindow = null;
let library = { version: 1, tracks: [] };
const activeDownloads = new Map();

// ---------------------------------------------------------------- paths

function initPaths() {
  paths.root = app.getPath('userData');
  paths.bin = path.join(paths.root, 'bin');
  paths.audio = path.join(paths.root, 'audio');
  paths.library = path.join(paths.root, 'library.json');
  fs.mkdirSync(paths.bin, { recursive: true });
  fs.mkdirSync(paths.audio, { recursive: true });
}

// ---------------------------------------------------------------- library

async function loadLibrary() {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.library, 'utf8'));
    library = { version: 1, tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [] };
  } catch {
    library = { version: 1, tracks: [] };
  }
}

let saveTimer = null;
function saveLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeLibraryNow, 250);
}

function writeLibraryNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = paths.library + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(library, null, 2));
    fs.renameSync(tmp, paths.library);
  } catch (err) {
    console.error('Could not save library:', err);
  }
}

function findTrack(id) {
  return library.tracks.find((t) => t.id === id);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function publicTrack(t) {
  return { ...t, missing: !fs.existsSync(t.file) };
}

// ---------------------------------------------------------------- yt-dlp

function ytdlpAssetName() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
    return 'yt-dlp.exe';
  }
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function ytdlpPath() {
  return path.join(paths.bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function bundledYtdlpPath() {
  // Packaged builds ship a copy in resources/bin; dev runs look in ./vendor.
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'vendor');
  return path.join(base, ytdlpAssetName());
}

async function ensureYtdlp(onStatus = () => {}) {
  const target = ytdlpPath();
  if (fs.existsSync(target)) return target;

  // First choice: the copy bundled with the app (copied somewhere writable so it can self-update).
  const bundled = bundledYtdlpPath();
  if (fs.existsSync(bundled)) {
    onStatus('Setting up yt-dlp…');
    await fsp.copyFile(bundled, target);
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755);
    return target;
  }

  // Fallback: fetch the official release from GitHub.
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAssetName()}`;
  onStatus('Downloading yt-dlp from GitHub…');
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download yt-dlp (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = target + '.download';
  await fsp.writeFile(tmp, buf);
  if (process.platform !== 'win32') await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, target);
  return target;
}

// yt-dlp needs a JavaScript runtime for full YouTube support. Electron can act
// as Node (ELECTRON_RUN_AS_NODE), so we hand it our own executable. If the user
// has Deno installed, yt-dlp prefers that automatically.
function jsRuntimeArgs() {
  return ['--js-runtimes', `node:${process.execPath}`];
}

function runYtdlp(args, { onLine, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    let bin;
    try {
      bin = await ensureYtdlp();
    } catch (err) {
      reject(err);
      return;
    }
    const child = spawn(bin, [...jsRuntimeArgs(), '--no-warnings', '--no-color', ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onLine) {
        lineBuf += chunk;
        const lines = lineBuf.split(/\r?\n|\r/);
        lineBuf = lines.pop();
        lines.forEach(onLine);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (onLine) chunk.split(/\r?\n|\r/).filter(Boolean).forEach(onLine);
    });
    if (signal) {
      signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(cleanError(stderr) || `yt-dlp exited with code ${code}`));
    });
  });
}

function cleanError(stderr) {
  const errLine = stderr.split(/\r?\n/).reverse().find((l) => l.startsWith('ERROR:'));
  let msg = (errLine || stderr.trim().split(/\r?\n/).pop() || '').replace(/^ERROR:\s*/, '');
  if (/unable to (download|connect)|getaddrinfo|timed out|network is unreachable/i.test(msg)) {
    return 'Couldn’t reach the site — check your internet connection and try again.';
  }
  if (/sign in to confirm|age/i.test(msg)) return 'YouTube wants a sign-in for this video, so it can’t be downloaded here.';
  return msg.replace(/;?\s*please report this issue.*$/i, '').slice(0, 300);
}

function pickThumb(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  const mid = thumbs.find((t) => t.width && t.width >= 200 && t.width <= 400) || thumbs[thumbs.length - 1];
  return mid?.url || null;
}

// How many results the search asks yt-dlp for (YouTube's first page is ~20,
// then more as you scroll). See search-issues/2-result-cap.md.
const SEARCH_LIMIT = 50;

// NOGATE BUILD: plain YouTube search, same query and order as typing it into
// youtube.com. The Creative Commons filter (CC_SEARCH_PARAM) is off; see
// search-issues/3-cc-filter.md. Returns the results plus details of exactly
// what was searched and what was dropped, so the search tab can show it.
async function searchCreativeCommons(query) {
  const q = String(query || '').trim();
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const info = { query: q, url, filter: 'none (plain YouTube search)', limit: SEARCH_LIMIT };
  if (!q) return { ...info, received: 0, dropped: [], results: [], ms: 0 };
  const started = Date.now();
  const out = await runYtdlp(['--flat-playlist', '--playlist-end', String(SEARCH_LIMIT), '-J', url]);
  const data = JSON.parse(out);
  const raw = data.entries || [];
  const dropped = [];
  const seen = new Set();
  const kept = [];
  for (const e of raw) {
    let reason = null;
    if (!e || !e.id) reason = 'no video id';
    else if (e.ie_key && e.ie_key !== 'Youtube') reason = `not a video (${e.ie_key})`;
    else if (seen.has(e.id)) reason = 'duplicate';
    if (reason) dropped.push({ id: e?.id || '', title: e?.title || '', reason });
    else {
      seen.add(e.id);
      kept.push(e);
    }
  }
  const results = kept.map((e, i) => ({
    rank: i + 1,
    id: e.id,
    title: e.title || e.id,
    channel: e.channel || e.uploader || '',
    duration: e.duration || null,
    url: e.url && e.url.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    thumbnail: pickThumb(e),
    inLibrary: library.tracks.some((t) => t.source?.id === e.id),
  }));
  return { ...info, received: raw.length, dropped, results, ms: Date.now() - started };
}

function validateUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error('That doesn’t look like a link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links are supported.');
  return u.toString();
}

async function fetchInfo(url) {
  const out = await runYtdlp(['--no-playlist', '-J', url]);
  return JSON.parse(out);
}

async function downloadTrack({ url, jobId }) {
  const send = (payload) => mainWindow?.webContents.send('download:progress', { jobId, ...payload });
  const controller = new AbortController();
  activeDownloads.set(jobId, controller);

  try {
    const cleanUrl = validateUrl(url);
    send({ stage: 'checking', message: 'Fetching video info…' });
    await ensureYtdlp((message) => send({ stage: 'setup', message }));
    const info = await fetchInfo(cleanUrl);

    const existing = library.tracks.find((t) => t.source?.id === info.id && t.source?.extractor === info.extractor_key);
    if (existing) {
      send({ stage: 'done', message: 'Already in your library', track: publicTrack(existing) });
      return publicTrack(existing);
    }

    send({ stage: 'downloading', message: 'Downloading audio…', percent: 0 });
    const outTemplate = path.join(paths.audio, '%(extractor_key)s-%(id)s.%(ext)s');
    let finalPath = null;
    await runYtdlp(
      [
        '--no-playlist',
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '-o', outTemplate,
        '--no-mtime',
        '--newline',
        '--progress',
        '--no-simulate',
        '--print', 'after_move:CDJPATH:%(filepath)s',
        cleanUrl,
      ],
      {
        signal: controller.signal,
        onLine: (line) => {
          if (line.startsWith('CDJPATH:')) {
            finalPath = line.slice('CDJPATH:'.length).trim();
            return;
          }
          const m = line.match(/\[download\]\s+([\d.]+)%/);
          if (m) send({ stage: 'downloading', message: 'Downloading audio…', percent: parseFloat(m[1]) });
        },
      },
    );

    if (!finalPath || !fs.existsSync(finalPath)) {
      // Fall back to finding the file by its ID.
      const prefix = `${info.extractor_key}-${info.id}.`;
      const match = (await fsp.readdir(paths.audio)).find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
      if (!match) throw new Error('Download finished but the audio file could not be found.');
      finalPath = path.join(paths.audio, match);
    }

    const track = {
      id: newId(),
      title: info.track || info.title || info.id,
      artist: info.artist || info.creator || info.channel || info.uploader || '',
      file: finalPath,
      duration: info.duration || null,
      bpm: null,
      beatOffset: null,
      cues: [null, null, null, null],
      addedAt: new Date().toISOString(),
      source: {
        kind: 'web',
        extractor: info.extractor_key,
        id: info.id,
        url: info.webpage_url || cleanUrl,
        uploader: info.channel || info.uploader || '',
        uploaderUrl: info.channel_url || info.uploader_url || '',
        // Recorded as reported, not checked (no-gate build).
        license: info.license || null,
        licenseCheckedBy: 'unchecked',
      },
    };
    library.tracks.unshift(track);
    saveLibrary();
    send({ stage: 'done', message: 'Added to library', track: publicTrack(track) });
    return publicTrack(track);
  } catch (err) {
    send({ stage: 'error', message: err.message });
    throw err;
  } finally {
    activeDownloads.delete(jobId);
  }
}

// ---------------------------------------------------------------- local files

async function importLocalFiles(filePaths) {
  const added = [];
  for (const file of filePaths) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) continue;
    if (library.tracks.some((t) => t.file === file)) continue;
    const base = path.basename(file, path.extname(file));
    const dash = base.indexOf(' - ');
    const track = {
      id: newId(),
      title: dash > 0 ? base.slice(dash + 3) : base,
      artist: dash > 0 ? base.slice(0, dash) : '',
      file,
      duration: null,
      bpm: null,
      beatOffset: null,
      cues: [null, null, null, null],
      addedAt: new Date().toISOString(),
      source: { kind: 'local' },
    };
    library.tracks.unshift(track);
    added.push(publicTrack(track));
  }
  if (added.length) saveLibrary();
  return added;
}

// ---------------------------------------------------------------- AI stems (prototype)
//
// Optional: needs onnxruntime-node next to the app and the HT-Demucs ONNX model
// in <userData>/models (or <app>/models). Without them the decks keep using the
// real-time DSP stems. Each track is separated once; the four stems are cached
// as WAVs in <userData>/stems/<trackId>/.

const STEM_MODEL = 'htdemucs_fp16weights.onnx';
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];
let stemWorker = null;
const stemJobs = new Map(); // trackId -> { promise, resolve, reject }
let stemQueue = Promise.resolve();

function stemSetup() {
  const model = [path.join(paths.root, 'models', STEM_MODEL), path.join(__dirname, '..', 'models', STEM_MODEL)].find((p) => fs.existsSync(p));
  // Packaged: resources/ort/onnxruntime-node (native code can't run from inside the app archive).
  // Dev: a normal node_modules install.
  let runtime = null;
  const packaged = path.join(process.resourcesPath || '', 'ort', 'onnxruntime-node');
  if (fs.existsSync(path.join(packaged, 'package.json'))) runtime = packaged;
  else {
    try {
      runtime = path.dirname(require.resolve('onnxruntime-node/package.json'));
    } catch {}
  }
  return { model, runtime, available: !!(model && runtime) };
}

const stemDir = (id) => path.join(paths.root, 'stems', String(id).replace(/[^a-zA-Z0-9_-]/g, ''));

function cachedStems(id) {
  const dir = stemDir(id);
  if (!fs.existsSync(path.join(dir, 'stems.json'))) return null;
  const files = Object.fromEntries(STEM_NAMES.map((n) => [n, path.join(dir, `${n}.wav`)]));
  return Object.values(files).every((f) => fs.existsSync(f)) ? files : null;
}

function getStemWorker(setup) {
  if (stemWorker) return stemWorker;
  const { Worker } = require('node:worker_threads');
  stemWorker = new Worker(path.join(__dirname, 'stems-worker.js'), { workerData: { modelPath: setup.model, runtimePath: setup.runtime } });
  stemWorker.on('message', (m) => {
    const job = stemJobs.get(m.jobId);
    if (m.type === 'progress') mainWindow?.webContents.send('stems:progress', { trackId: m.jobId, done: m.done, total: m.total });
    if (!job) return;
    if (m.type === 'done') job.resolve({ ms: m.ms });
    if (m.type === 'error') job.reject(new Error(m.message));
    if (m.type === 'done' || m.type === 'error') stemJobs.delete(m.jobId);
  });
  stemWorker.on('error', (err) => {
    for (const job of stemJobs.values()) job.reject(err);
    stemJobs.clear();
    stemWorker = null;
  });
  return stemWorker;
}

/** Separate one track (44.1 kHz stereo PCM from the renderer). One job at a time. */
function separateStems(id, left, right) {
  const setup = stemSetup();
  if (!setup.available) return Promise.reject(new Error('AI stems are not installed.'));
  if (!findTrack(id)) return Promise.reject(new Error('Track not found'));
  if (cachedStems(id)) return Promise.resolve({ cached: true });
  if (stemJobs.has(id)) return stemJobs.get(id).promise;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  stemJobs.set(id, { promise, resolve, reject });
  stemQueue = stemQueue.then(() => {
    getStemWorker(setup).postMessage({ type: 'separate', jobId: id, left, right, outDir: stemDir(id) }, [left.buffer, right.buffer]);
    return promise.catch(() => {});
  });
  return promise;
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('stems:status', (_e, id) => {
    const setup = stemSetup();
    return { available: setup.available, ready: !!cachedStems(id), busy: stemJobs.has(id) };
  });

  ipcMain.handle('stems:separate', (_e, id, left, right) => separateStems(id, new Float32Array(left), new Float32Array(right)));

  ipcMain.handle('stems:read', async (_e, id, name) => {
    const files = cachedStems(id);
    if (!files || !files[name]) throw new Error('Stems not ready');
    const buf = await fsp.readFile(files[name]);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('library:list', () => library.tracks.map(publicTrack));

  ipcMain.handle('library:update', (_e, id, patch) => {
    const t = findTrack(id);
    if (!t) return null;
    const allowed = ['title', 'artist', 'bpm', 'beatOffset', 'cues', 'duration', 'key'];
    for (const key of allowed) if (key in patch) t[key] = patch[key];
    saveLibrary();
    return publicTrack(t);
  });

  ipcMain.handle('library:remove', async (_e, id, { deleteFile } = {}) => {
    const idx = library.tracks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    const [t] = library.tracks.splice(idx, 1);
    // Only ever delete files that live inside our own audio folder.
    if (deleteFile && path.dirname(path.resolve(t.file)) === path.resolve(paths.audio)) {
      await fsp.unlink(t.file).catch(() => {});
    }
    // Cached AI stems belong to the track; they go with it.
    if (!stemJobs.has(id)) await fsp.rm(stemDir(id), { recursive: true, force: true }).catch(() => {});
    saveLibrary();
    return true;
  });

  ipcMain.handle('library:readAudio', async (_e, id) => {
    const t = findTrack(id);
    if (!t) throw new Error('Track not found');
    const buf = await fsp.readFile(t.file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('library:importDialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Add music files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (res.canceled) return [];
    return importLocalFiles(res.filePaths);
  });

  ipcMain.handle('library:importPaths', (_e, filePaths) => importLocalFiles(Array.isArray(filePaths) ? filePaths : []));

  ipcMain.handle('library:openFolder', () => shell.openPath(paths.audio));

  ipcMain.handle('cc:search', (_e, query) => searchCreativeCommons(query));

  ipcMain.handle('cc:download', (_e, url, jobId) => downloadTrack({ url, jobId }));

  ipcMain.handle('cc:cancel', (_e, jobId) => {
    activeDownloads.get(jobId)?.abort();
    return true;
  });

  ipcMain.handle('ytdlp:status', async () => {
    const p = ytdlpPath();
    if (!fs.existsSync(p) && !fs.existsSync(bundledYtdlpPath())) return { installed: false };
    try {
      const v = await runYtdlp(['--version']);
      return { installed: true, version: v.trim() };
    } catch (err) {
      return { installed: false, error: err.message };
    }
  });

  ipcMain.handle('ytdlp:update', async () => {
    const out = await runYtdlp(['-U']);
    return out.trim().split(/\r?\n/).pop();
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    const u = validateUrl(url);
    return shell.openExternal(u);
  });
}

// ---------------------------------------------------------------- window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0d0e10',
    title: 'Commons DJ',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Keep links out of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  initPaths();
  await loadLibrary();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const c of activeDownloads.values()) c.abort();
  if (saveTimer) writeLibraryNow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
