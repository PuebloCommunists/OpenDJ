# Key shift, key lock, key match & stems

Added to the NoGate build. Each deck has two new rows:

```
KEY    [8A Am]  ♭  ♯  LOCK  MATCH
STEMS  [ VOX ] [ DRUMS ] [ INST ]
```

## What each control does

| Control | What it does |
|---|---|
| **KEY readout** | The track's detected key in Camelot and normal notation (`8A Am`). When the key is shifted it shows the key you're actually hearing and by how much (`10A Bm +2`). Click it to reset the shift. |
| **♭ / ♯** | Moves the key down or up one semitone **without changing tempo**. Range ±12. |
| **LOCK** (key lock) | The tempo slider and nudge change speed only, not pitch. Without it, tempo works like vinyl as before: +6% tempo ≈ +1 semitone, and the readout shows that. |
| **MATCH** | Shifts this deck into the other deck's key as you hear it (including the other deck's shift and tempo pitch), taking the smallest move (−6…+6). It aims for the same Camelot number, so a minor track can match a major one through its relative key (Am ↔ C). Turns LOCK on so the match holds when you change tempo. |
| **VOX / DRUMS / INST** | Turns each stem of the deck on or off in real time. **Shift-click** solos one (Shift-click again to bring all back). **Right-click** turns all on. |
| **Library → Key column** | Camelot + key for every analysed track. You can type `8A` or `Am` in the library filter to find tracks in a key. |

Keys are detected the first time a track is loaded, like BPM, and saved to the library.

## How it works (files)

- `src/renderer/deck-fx.worklet.js` (new) is an AudioWorklet that runs on the audio thread, one per deck,
  between the track and the EQ. It is a 2048-point stereo STFT (hop 512) that does both jobs:
  - **Pitch shift**: a phase vocoder with peak locking (Laroche & Dolson). Each harmonic and the bins around it
    move as one block, so levels hold and it sounds less "phasey" than shifting bins one by one. Key lock is the
    same shifter set to `1 / tempo`, which cancels the vinyl pitch change.
  - **Stems**: soft masks per frequency bin.
    - **Drums** = percussive part, from harmonic/percussive separation (median filtering across time and across frequency).
    - **Vocals** = harmonic part that's centre-panned (L ≈ R) in the 120 Hz–10 kHz voice range.
    - **Instruments** = everything else that's harmonic.
    With everything on and no shift, the frame passes through untouched, a bit-exact copy delayed by 2048 samples.
- `src/renderer/engine.js`: the deck owns `keyShift`, `keyLock`, `stems`, `matchKeyTo()`, `pitchFactor`, `keyOffset`.
- `src/renderer/analysis.js`: `detectKey()`, `chromagram()`, `camelot()`, `keyName()`, `transposeKey()`.
  Krumhansl–Kessler key profiles with overtones folded in (as in Gómez's audio key-finding), so a note's
  3rd harmonic doesn't drag the result toward the dominant.
- `src/renderer/app.js` / `index.html` / `styles.css`: the KEY and STEMS rows and the library Key column.
- `src/main.js`: `key` added to the fields the library saves.

## Measured (tests run inside the exe)

| Test | Result |
|---|---|
| Untouched path is a perfect delayed copy | max error 6 × 10⁻⁸ |
| Pitch +2, −3, +7, −12 semitones on a 440 Hz tone | within 0.3 cents, level within 0.6 dB |
| Key lock at +8% tempo | stays at 440 Hz (would be 475 Hz without lock) |
| Chord A4–C5–E5 shifted +2 | every note within 0.6 cents |
| Mute DRUMS | clicks −19 dB, tones unchanged |
| Mute VOX | centre tone −76 dB, side tone unchanged |
| Mute INST | side tone −71 dB, centre tone unchanged |
| Speed, pitch + stems together | ~12–18× faster than real time per deck |
| Key detection (C, Am, F#m, Eb, Dm progressions with drums) | 5/5 correct, ~0.1 s per track |
| In-app: Am + Dm tracks, ♯♯, LOCK at +6%, MATCH, stem toggle/solo/reset | all as designed, no console errors |
| Original smoke test (decks, BPM, sync, cues, loops, search) | unchanged |

## Known limits — be aware when testing

1. **Stems are DSP, not AI.** They're good for dropping the drums or pulling a vocal back live. They won't
   give clean isolated stems like Serato/rekordbox/Demucs:
   - Anything centred in the voice range counts as "vocal": lead synths, centre-panned guitar or keys.
   - Mono tracks have everything centred, so VOX takes most of the melody.
   - Sustained bass sits in INST, and kick tails can leak into INST.
   - Expect some "watery" artefacts when a stem is muted.
2. **Low close notes shift less precisely.** Two notes about 2 FFT bins apart below ~250 Hz, such as a low
   minor third, can end up 10–20 cents off when shifted. Mid and high register is accurate. A bigger FFT would
   fix this but double the delay.
3. **About 43 ms extra delay on every deck** (2048 samples), all the time. It's the same on both decks, so sync
   and beatmatching are unaffected, but play and cue respond 43 ms later, and the waveform runs about 43 ms ahead
   of what you hear.
4. **Key detection** can pick the relative major/minor (Am vs C). They share a Camelot number and mix
   fine. Tracks with no clear harmony (drum loops) show "no key".
5. **MATCH needs a detected key on both decks.**

## Check it works (your checklist)

- [ ] Load two tracks. Both show a key in the deck and in the library Key column.
- [ ] Press ♯ twice. The track sounds 2 semitones higher **at the same tempo**, and the readout shows `+2`.
      Click the readout to go back.
- [ ] With LOCK **off**, move tempo +6%. Pitch rises (readout +1). Turn LOCK **on**. Pitch returns to normal and
      tempo stays at +6%.
- [ ] Press MATCH on deck B. The toast says how far it shifted, and the two tracks sound in key together.
- [ ] Turn DRUMS off on a track with a clear beat. The beat mostly disappears and the music keeps going.
- [ ] Shift-click VOX on a vocal track. You mostly hear the voice (plus other centred parts).
- [ ] Right-click any stem. Everything comes back.
- [ ] With both decks playing, key shift and stems on, listen for clicks or dropouts. Note your machine if you
      hear any.

## Possible next steps

- **AI stems (much cleaner):** run a separation model such as Demucs (MIT licensed) via ONNX Runtime when a
  track is loaded, and save the 4 stems next to the track. It's not real-time on a laptop CPU (expect ~0.5–2×
  the track length to process), but after that switching stems is instant and clean. It needs a ~80–300 MB model
  download.
- **Stem faders** instead of on/off, using the same engine (it already takes 0–1 levels).
- **Lower-latency mode** with a 1024-point frame (~21 ms delay, less precise bass).
- **Harmonic hints:** colour library keys that are compatible (±1 Camelot) with the deck that's playing.
