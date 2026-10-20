// Speed check for the HT-Demucs ONNX model with onnxruntime-node.
// Run with the app's Electron as Node: ELECTRON_RUN_AS_NODE=1 "Commons DJ NoGate.exe" bench.js <runtimeDir> <model.onnx> [cpu|dml]
const path = require('node:path');
const [runtimeDir, modelPath, provider = 'cpu'] = process.argv.slice(2);
const ort = require(path.join(runtimeDir, 'node_modules', 'onnxruntime-node'));

const SEG = 343980; // 7.8 s at 44.1 kHz, fixed by the export

(async () => {
  const t0 = Date.now();
  const opts = {
    executionProviders: provider === 'dml' ? ['dml', 'cpu'] : ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Number(process.env.THREADS || 0),
    ...(process.env.LOWMEM === '1' ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
    ...(process.env.LOWMEM === 'arena' ? { enableCpuMemArena: false } : {}),
    ...(process.env.LOWMEM === 'pattern' ? { enableMemPattern: false } : {}),
  };
  const session = await ort.InferenceSession.create(modelPath, opts);
  const loadMs = Date.now() - t0;
  console.log(`provider=${provider} load ${loadMs} ms inputs=${session.inputNames} outputs=${session.outputNames}`);

  const data = new Float32Array(2 * SEG);
  for (let i = 0; i < SEG; i++) {
    const t = i / 44100;
    const v = 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 330 * t) + (i % 22050 < 400 ? 0.3 * Math.sin(i) : 0);
    data[i] = v;
    data[SEG + i] = v * 0.9;
  }
  const mix = new ort.Tensor('float32', data, [1, 2, SEG]);
  const times = [];
  let out;
  for (let r = 0; r < 3; r++) {
    const s = Date.now();
    out = await session.run({ [session.inputNames[0]]: mix });
    times.push(Date.now() - s);
  }
  const stems = out[session.outputNames[0]];
  const mem = process.memoryUsage();
  console.log(`runs ms: ${times.join(', ')}  → real-time factor ${(Math.min(...times) / 7800).toFixed(2)} (a 4-min track ≈ ${Math.round((Math.min(...times) / 7800) * 240)} s)`);
  console.log(`output dims ${stems.dims}  rss ${Math.round(mem.rss / 1e6)} MB`);
})().catch((e) => {
  console.error('FAILED', e && e.stack || e);
  process.exit(1);
});
