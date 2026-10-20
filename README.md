# OpenDJ (beta)

A two-deck DJ app for your own music and Creative Commons tracks, with yt-dlp built in.

> **This is a development build with the license gate removed.** Downloads are not license-checked, and tracks
> record whatever license yt-dlp reports (or none, shown as UNCHECKED). It uses its own data folder
> (`%APPDATA%\Commons DJ NoGate`), so it doesn't touch the main app's library. The removed features and their
> known problems are written up in `docs/license-gate-features/`, to be put back one at a time.
>
> The search is also a **plain YouTube search** here (no Creative Commons filter, up to 50 results in YouTube's
> order), with a details strip showing exactly what was searched and an **Expand** button for more room. The
> search problems are written up in `docs/search-issues/`.

## Running it (Windows on ARM)

1. Unzip `CommonsDJ-win-arm64.zip` somewhere you keep apps, such as `Documents\Apps\Commons DJ`.
2. Double-click **Commons DJ.exe**.
3. The app isn't code-signed, so Windows SmartScreen will warn you the first time. Click **More info → Run anyway**.

Your library and downloads live in `%APPDATA%\Commons DJ` (the **Open download folder** button takes you there).

## What it does

- **Two decks** with play/cue, 4 hot cues, beat loops (1/2/4/8), tempo slider (±8/16/50%), nudge, and **SYNC** that matches tempo and beat phase.
- **Automatic BPM and beat grid** detection on first load, with ÷2 / ×2 / TAP / BEAT to fix the grid by hand.
- **Key detection** (Camelot + key name), **key shift** (♭/♯ without changing tempo), **key lock** (tempo without changing pitch) and **MATCH** to put a deck in the other deck's key.
- **Stems**: turn vocals, drums or instruments on and off per deck in real time (DSP separation, approximate — see `docs/new-features/key-and-stems.md`).
- **AI stems (prototype)**: if the HT-Demucs model and ONNX Runtime are installed, each track is separated once in the background and the stem buttons switch to the clean AI stems — see `docs/new-features/ai-stems-plan.md`.
- **Mixer** with trim, 3-band EQ (kills at the bottom), one-knob filter (left = low-pass, right = high-pass), channel faders with meters, a crossfader with Blend or Cut curves, and a limiter on the master.
- **Scrolling waveforms** that stay beat-aligned across both decks, plus an overview you can click to seek.
- **Library** for your own files (drag them into the window or use Add files).
- **Creative Commons search**, which uses YouTube's own Creative Commons filter through yt-dlp. You can also paste a link.
- ~~**License gate**~~: removed in this build (see `docs/license-gate-features/`).
- **Credits**: collects attribution lines for every CC track you play, ready to paste into a mix description (CC BY requires credit).

## Keyboard

| Deck A | Deck B | Mixer |
|---|---|---|
| `X` play / pause | `,` play / pause | `←` `→` crossfader |
| `Z` cue | `M` cue | `Shift` + arrows: slam |
| `C` sync | `.` sync | `/` filter library |
| `1`–`4` hot cues | `7`–`0` hot cues | `?` help |
| `Q` / `W` nudge | `O` / `P` nudge | |

Shift + a hot cue key clears it.

## yt-dlp

A copy of the official `yt-dlp_arm64.exe` ships inside the app. The **yt-dlp** chip in the top bar shows its version; click it to update. YouTube changes often, so update yt-dlp first if search or downloads stop working.

YouTube support in yt-dlp needs a JavaScript runtime. Commons DJ provides one by reusing its own built-in Node.js, so there's nothing extra to install. If you already have Deno installed, yt-dlp will use that instead.

## Building from source

Requires Node.js 22+.

```
npm install
npm run fetch-ytdlp     # grabs yt-dlp for this computer, so `npm start` works
npm start               # run in development
npm test                # tempo-detection tests
npm run package:win-arm64
npm run package:win-x64
```

Project layout:

- `src/main.js` handles the window, library storage, and yt-dlp (search, license check, download).
- `src/preload.js` is the bridge between the UI and the main process.
- `src/renderer/engine.js` is the Web Audio engine (decks, EQ, filter, loops, sync, crossfader).
- `src/renderer/deck-fx.worklet.js` is the per-deck audio-thread processor for key shift / key lock / stems.
- `src/renderer/analysis.js` holds the waveform, BPM/beat-grid and key detection.
- `src/renderer/app.js` is the UI.

## Notes and limits

- Tempo changes work like vinyl (pitch moves with speed) unless **LOCK** is on.
- Key shift and stems run through a per-deck processor that adds a fixed ~43 ms delay to both decks.
- There's one audio output, so there's no separate headphone cue yet.
- Decoded audio is held in memory, so very long files (hour-long mixes) use a lot of RAM.
- The license check relies on what YouTube reports. Keep an eye on licenses for anything you plan to publish.
