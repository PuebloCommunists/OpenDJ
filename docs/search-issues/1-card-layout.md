# 1 — Result cards collapse; thumbnails cut off

**State: fixed in the NoGate build.** Please confirm on your screen.

## What was wrong

`.cc-results` is a CSS grid that fills whatever height is left under the decks. Its rows were the default
`auto`, and each card has `overflow: hidden`. In CSS grid, an `overflow: hidden` item is allowed to shrink to
zero, so when the panel was shorter than the cards (which is nearly always under the decks), every row was
squeezed to a sliver. Thumbnails showed as thin strips and titles disappeared. Nothing was wrong with the
thumbnails themselves. yt-dlp returns proper 16:9 `hq720` images.

There was a second, related problem: under the decks there is only about 350 px of height for the whole
browser panel at 1080p, and the search header (inputs, note) used most of it.

## Fix (in `CommonsDJ-nogate/src/renderer/styles.css`)

```css
.cc-results { ... min-height: 0; grid-auto-rows: max-content; }   /* rows size to their cards */
.cc-item img { width: 160px; aspect-ratio: 16 / 9; height: auto; object-fit: cover; }  /* was 96×54 */
```

Plus:
- The dev-build note is now one line.
- The details strip is compact, with the extra information folded into "Details".
- An **Expand ⤢** button lets the browser cover the decks, so results get the full window height.

## Check it works

- [ ] Search anything. Cards show the full 16:9 thumbnail, a two-line title, the channel, and the video ID.
- [ ] Without expanding, at your normal window size, at least one full row of cards is visible.
- [ ] **Expand ⤢**: about 4 rows of cards are visible. **Collapse** or Esc puts the decks back.
- [ ] With a track playing, Expand then Collapse. Audio doesn't stop and the waveforms are still correct.
- [ ] Make the window narrow. Cards go down to 1–2 columns and nothing overlaps.
