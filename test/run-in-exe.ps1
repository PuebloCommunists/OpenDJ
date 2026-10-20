# Temporarily points the NoGate exe at a test entry script, runs it, then restores package.json.
# Usage: run-in-exe.ps1 <entry.js> <outDir>
param([string]$Entry, [string]$OutDir, [int]$TimeoutSec = 150, [string]$AppDir = '')
$root = Split-Path $PSScriptRoot -Parent
if (-not $AppDir) { $AppDir = "$root\pkg-nogate\Commons DJ NoGate" }
$app = "$AppDir\resources\app"
$exe = "$AppDir\Commons DJ NoGate.exe"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$app\test", $OutDir | Out-Null
Copy-Item $Entry "$app\test\entry.js" -Force
Copy-Item "$app\package.json" "$PSScriptRoot\package.json.bak" -Force
try {
  (Get-Content "$app\package.json" -Raw).Replace('"main": "src/main.js"', '"main": "test/entry.js"') | Set-Content "$app\package.json" -Encoding utf8 -NoNewline
  $p = Start-Process -FilePath $exe -ArgumentList "`"$OutDir`"" -PassThru
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $p.Kill(); 'TIMEOUT' } else { "exit $($p.ExitCode)" }
} finally {
  Copy-Item "$PSScriptRoot\package.json.bak" "$app\package.json" -Force
  Remove-Item -Recurse "$app\test" -Confirm:$false
}
