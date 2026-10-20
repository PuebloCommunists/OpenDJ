// Downloads the official yt-dlp binary for a target platform into vendor/<platform>-<arch>/bin
// so the packager can bundle it. Usage: node scripts/fetch-ytdlp.mjs [platform] [arch]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;

const assets = {
  'win32-arm64': 'yt-dlp_arm64.exe',
  'win32-x64': 'yt-dlp.exe',
  'win32-ia32': 'yt-dlp_x86.exe',
  'darwin-arm64': 'yt-dlp_macos',
  'darwin-x64': 'yt-dlp_macos',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
};
const asset = assets[`${platform}-${arch}`];
if (!asset) {
  console.error(`No yt-dlp build known for ${platform}-${arch}`);
  process.exit(1);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'vendor', `${platform}-${arch}`, 'bin');
const dev = path.join(root, 'vendor');
const out = path.join(outDir, asset);
if (fs.existsSync(out)) {
  console.log(`yt-dlp already present: ${out}`);
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
console.log(`Downloading ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}`);
  process.exit(1);
}
fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
if (!platform.startsWith('win')) fs.chmodSync(out, 0o755);
// Also make it available to `npm start` on this machine.
if (platform === process.platform && arch === process.arch) fs.copyFileSync(out, path.join(dev, asset));
console.log(`Saved ${out} (${fs.statSync(out).size} bytes)`);
