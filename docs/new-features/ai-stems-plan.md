# AI stems (HT-Demucs) — plan and prototype

The upgrade path from `key-and-stems.md`: real model-separated stems instead of the DSP approximation.
**Status: working prototype in the NoGate source, tested inside the exe on one of your tracks.** It isn't in your
normal install yet. A separate test copy is at `Downloads\CommonsDJ-NoGate-AI-test` (see "Try it" below).

## How it behaves

1. You load a track as usual. The DSP stems work immediately, as before.
2. If the AI model is installed, the track is separated in the background, once. The STEMS label counts up
   (`AI 4%` … `AI 100%`). The deck keeps playing and the app stays responsive.
3. When it's done, a toast says "AI stems ready". The label turns to **STEMS·AI**, and VOX / DRUMS / INST now
   switch real separated stems. INST is bass + other.
4. Next time the track is loaded, the cached stems are used straight away (~4–5 s to read and decode, no
   re-separation).
5. If the model or runtime is missing, or separation fails, nothing changes: DSP stems as before.

## Choices

| | Choice | Why |
|---|---|---|
| Model | **HT-Demucs v4, 4 stems** (drums / bass / other / vocals), community ONNX export [`adowu/htdemucs-onnx`](https://huggingface.co/adowu/htdemucs-onnx), file `htdemucs_fp16weights.onnx` | One file with the STFT inside the graph, so no PyTorch and no extra DSP code. The card states parity with PyTorch (max diff 4.6e-5 vs fp32). |
| Model size | **166 MB** (fp16 weights; fp32 variant is 316 MB, same output per the card) | Half the download for the same quality. |
| Licence | Demucs code is **MIT** (Meta, [github.com/facebookresearch/demucs](https://github.com/facebookresearch/demucs), archived Jan 2025). The export's card also says MIT. | ⚠ One other ONNX repo (HRSadeghi/demucs-onnx) claims the v3/v4 *weights* are CC BY-NC. The Demucs README only names MIT and doesn't separately license the weights. **Confirm before selling or redistributing the app with the model bundled.** Downloading on the user's machine at first use is the safer default. |
| Runtime | **onnxruntime-node 1.30.0** (MIT, Microsoft), CPU execution provider, Windows ARM64 prebuilt binary | Native speed. N-API, so it works in Electron 44 without rebuilding. The npm tarball is 113.5 MB (all platforms); we ship only win32-arm64: **~70 MB** incl. DirectML, or ~30 MB CPU-only. |
| GPU (DirectML) | **Not used.** | Tried it: the Snapdragon X Plus GPU runs out of memory on this model ("Not enough memory resources"). CPU is fast enough. |
| Where it runs | A **worker thread** in the main process (`src/stems-worker.js`) | `session.run` blocks its thread for ~3 s per segment. In a worker, the window and IPC stay responsive (verified: the deck clock kept moving during separation). |
| Settings | `enableCpuMemArena: false`, `intraOpNumThreads: 4` | Measured, see below. |

## Measured on this machine (Snapdragon X Plus X1P42100, 8 cores, 16 GB)

Per 7.8 s model segment, after warm-up:

| Settings | Time / segment | × track length | 4-min track | RAM |
|---|---|---|---|---|
| defaults (arena on, all cores) | 2.98 s | 0.38× | ~92 s | **4.8 GB** |
| arena + memory patterns off | 6.1 s | 0.78× | ~188 s | 0.5 GB |
| memory patterns off only | 4.6 s | 0.59× | ~141 s | 2.7 GB |
| **arena off** (chosen) | 3.6 s | 0.46× | ~111 s | **0.5 GB** |
| **arena off + 4 threads** (chosen) | **2.9 s** | **0.37×** | **~89 s** | 0.5 GB |
| arena off + 6 threads | 3.7 s | 0.48× | ~115 s | |
| arena off + 8 threads | 3.4 s | 0.43× | ~104 s | |

**In the app**, on a real 3:06 track (one of your YouTube downloads, copied), while the deck was playing:
- 8 threads (first run): separation took **208 s** (~1.1× track length). Playback and the UI competed for the
  same cores.
- **4 threads (chosen): 135 s (0.73× track length), so a 4-minute track is ready in about 3 minutes**, with
  the deck playing throughout.
- Model load: ~4 s, first use only.

**Quality on that track:**
- The four stems add back up to the original at **28.6 dB SNR** (~3.7% difference, mostly from fp16 and the 1 s
  segment cross-fades).
- Energy split: drums 36%, bass 15%, other 31%, vocals 18.5%.
- The vocals stem has only 3% of its energy below 250 Hz; bass and drums are nearly all low. So the stems are
  what they say.
- No listening test yet: that's on your checklist.

**Disk:** 4 × 16-bit stereo 44.1 kHz WAVs ≈ **10.6 MB per minute of track** (a 3-minute track ≈ 131 MB).
**RAM while playing:** the 4 decoded stems ≈ 4 × the track's own size (a 3-minute track ≈ 290 MB per deck).

## How it plugs in (files)

| File | Change |
|---|---|
| `src/stems-worker.js` (new) | Loads the model once. Splits the track into 7.8 s segments with a 1 s linear cross-fade, runs the model, and writes `drums/bass/other/vocals.wav` plus `stems.json` (written last, so the set is complete) to `<userData>/stems/<trackId>/`. Reports progress per segment. |
| `src/main.js` | `stemSetup()` finds the model in `<userData>/models/` (or `<app>/models/`) and the runtime in `resources/ort/onnxruntime-node` (packaged) or `node_modules` (dev). One-at-a-time job queue. IPC `stems:status`, `stems:separate`, `stems:read`, `stems:progress` event. Removing a track also deletes its cached stems. |
| `src/preload.js` | `cdj.stems.{status, separate, read, onProgress}`. |
| `src/renderer/engine.js` | Every source now plays into `deck.bus` → fx worklet → EQ (one extra unity gain node). `setAiStems(buffers)` switches the deck to **four synced `AudioBufferSourceNode`s** (one per stem) through `aiGains`. Start, stop, seek, rate, nudge, loops and key shift/lock all apply to all four. When AI stems are active, VOX/DRUMS/INST drive `aiGains` (INST = bass + other) and the DSP masks in the worklet are switched off (all 1). Without AI stems, the DSP path is unchanged. |
| `src/renderer/app.js` | After a track loads, `prepareAiStems()`: use the cache, or resample to 44.1 kHz (OfflineAudioContext), send the PCM to the worker, and show progress on the STEMS label. |
| `deck-fx.worklet.js` | **Unchanged.** |

## Tested inside the exe

| Check | Result |
|---|---|
| Separation runs in the background while the deck plays | ✓ progress 4% → 100%, clock kept moving |
| Stems cached to disk | ✓ 4 × 32.8 MB WAV + stems.json |
| Label switches to STEMS·AI, toast shown | ✓ |
| VOX solo with AI stems | ✓ vocals on, drums/inst off |
| Reloading the same track uses the cache | ✓ STEMS·AI in 4.6 s, no re-separation |
| Console errors | none |
| DSP path, key shift, key match | unchanged code; the key/stems UI test still passes |

## To ship it (not done yet)

1. **Model install:** a "Download AI stems model (166 MB)" button with progress and checksum, to
   `<userData>/models/`. Don't bundle it in the zip, which keeps the download small and sidesteps the licence
   question.
2. **Runtime:** add `resources/ort/onnxruntime-node` to the packaging scripts. It's like `--extra-resource` for
   yt-dlp: win32-arm64 binaries + `onnxruntime-common` nested in `node_modules`. Drop the DirectML DLLs (saves
   ~40 MB) since the GPU path doesn't fit in memory.
3. **Path length:** the runtime's deepest file is ~95 characters below the app folder. Installs deeper than
   ~160 characters hit Windows' 260-character limit and the native module won't load. Fine in `Downloads` or
   `Program Files`, but this session's scratch folder is too deep. That's why the test copy lives in `Downloads`.
4. **Smaller cache:** store stems as FLAC or Opus instead of WAV (~4–8× smaller).
5. **Controls:** a per-track "Separate now / Delete stems" in the library, and a setting for "separate
   automatically on load".
6. **Quality options:** `htdemucs_ft` (4 fine-tuned models, ~4× slower, slightly better), or the 6-stem model
   (adds guitar and piano) for separate GUITAR / KEYS buttons.

## Try it

The test copy at `Downloads\CommonsDJ-NoGate-AI-test\Commons DJ NoGate\Commons DJ NoGate.exe` has the runtime,
but **not the model**. To try it, copy `htdemucs_fp16weights.onnx` (it's in this session's `ai-stems/downloads/`
folder) into `%APPDATA%\Commons DJ NoGate\models\`. That folder is shared with your normal NoGate install; the
normal install ignores the model because it has no runtime.

Checklist:
- [ ] Load a track. STEMS counts up `AI …%` while you can keep playing and mixing.
- [ ] After "AI stems ready": solo VOX. You should hear the vocal alone, much cleaner than the DSP version.
- [ ] Turn DRUMS off. Drums gone, bass and music intact.
- [ ] Key shift / LOCK / MATCH still work with AI stems on.
- [ ] Reload the same track. STEMS·AI appears within a few seconds.
