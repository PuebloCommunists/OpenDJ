// Copies onnxruntime-node (AI stems runtime) for one target into vendor/<platform>-<arch>/ort
// so the packager ships it as resources/ort, outside app.asar. Loaded from inside the archive,
// Windows finds its own older System32 onnxruntime.dll instead of ours and the app crashes
// when AI stems start. Usage: node scripts/vendor-ort.mjs [platform] [arch]  (arch may be "universal")
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
const archs = arch === 'universal' ? ['arm64', 'x64'] : [arch];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'node_modules', 'onnxruntime-node');
const out = path.join(root, 'vendor', `${platform}-${arch}`, 'ort', 'onnxruntime-node');

fs.rmSync(out, { recursive: true, force: true });
for (const f of ['package.json', 'dist']) fs.cpSync(path.join(src, f), path.join(out, f), { recursive: true });
for (const a of archs) {
  const bin = path.join('bin', 'napi-v6', platform, a);
  if (!fs.existsSync(path.join(src, bin))) {
    console.error(`onnxruntime-node has no binaries for ${platform}-${a}`);
    process.exit(1);
  }
  fs.cpSync(path.join(src, bin), path.join(out, bin), { recursive: true });
}
fs.cpSync(path.join(root, 'node_modules', 'onnxruntime-common'), path.join(out, 'node_modules', 'onnxruntime-common'), { recursive: true });
console.log(`onnxruntime-node for ${platform}-${arch} -> ${path.relative(root, out)}`);
