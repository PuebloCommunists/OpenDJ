// AI stem separation (prototype), run in a worker thread of the main process so
// the window stays responsive. Uses an ONNX export of Meta's HT-Demucs 4-stem
// model through onnxruntime-node (CPU).
//
// In:  { type: 'separate', jobId, left, right, outDir }   — 44.1 kHz stereo Float32Arrays
// Out: { type: 'progress', jobId, done, total }
//      { type: 'done', jobId, files: { drums, bass, other, vocals }, ms }
//      { type: 'error', jobId, message }

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

const SR = 44100;
const SEG = 343980; // samples per model call (7.8 s), fixed by the export
const OVERLAP = SR; // 1 s cross-fade between segments
const STEP = SEG - OVERLAP;
const STEM_ORDER = ['drums', 'bass', 'other', 'vocals']; // model output order

let session = null;
let ort = null;

async function getSession() {
  if (session) return session;
  ort = require(workerData.runtimePath);
  // Measured on a Snapdragon X Plus (8 cores): memory arena off cuts RAM from
  // ~4.8 GB to ~0.5 GB; 4 threads is fastest (0.37× track length) and leaves
  // cores free for audio and the UI.
  session = await ort.InferenceSession.create(workerData.modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    intraOpNumThreads: 4,
  });
  return session;
}

function writeWav(file, L, R) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), o);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), o + 2);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

async function separate({ jobId, left, right, outDir }) {
  const t0 = Date.now();
  const s = await getSession();
  const n = left.length;
  const out = STEM_ORDER.map(() => [new Float32Array(n), new Float32Array(n)]);
  const weight = new Float32Array(n);
  const starts = [];
  for (let start = 0; start < n; start += STEP) {
    starts.push(start);
    if (start + SEG >= n) break;
  }
  const input = new Float32Array(2 * SEG);
  // Linear fade in/out over the overlap so neighbouring segments cross-fade.
  const fade = (i) => Math.min(1, (i + 1) / OVERLAP, (SEG - i) / OVERLAP);

  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const len = Math.min(SEG, n - start);
    input.fill(0);
    input.set(left.subarray(start, start + len), 0);
    input.set(right.subarray(start, start + len), SEG);
    const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 2, SEG]) });
    const y = res[s.outputNames[0]].data; // [1, 4, 2, SEG]
    const first = k === 0;
    const last = k === starts.length - 1;
    for (let i = 0; i < len; i++) {
      // No fade at the very start and end of the track.
      const w = (first && i < OVERLAP) || (last && i >= len - OVERLAP) ? 1 : fade(i);
      weight[start + i] += w;
      for (let st = 0; st < 4; st++) {
        out[st][0][start + i] += w * y[(st * 2) * SEG + i];
        out[st][1][start + i] += w * y[(st * 2 + 1) * SEG + i];
      }
    }
    parentPort.postMessage({ type: 'progress', jobId, done: k + 1, total: starts.length });
  }
  for (let i = 0; i < n; i++) {
    const w = weight[i] || 1;
    for (let st = 0; st < 4; st++) {
      out[st][0][i] /= w;
      out[st][1][i] /= w;
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = {};
  STEM_ORDER.forEach((name, st) => {
    files[name] = path.join(outDir, `${name}.wav`);
    writeWav(files[name], out[st][0], out[st][1]);
  });
  // Written last: its presence means the set is complete.
  fs.writeFileSync(path.join(outDir, 'stems.json'), JSON.stringify({ model: path.basename(workerData.modelPath), sampleRate: SR, created: new Date().toISOString(), ms: Date.now() - t0 }));
  return { files, ms: Date.now() - t0 };
}

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'separate') return;
  try {
    const r = await separate(msg);
    parentPort.postMessage({ type: 'done', jobId: msg.jobId, ...r });
  } catch (err) {
    parentPort.postMessage({ type: 'error', jobId: msg.jobId, message: String((err && err.message) || err) });
  }
});
