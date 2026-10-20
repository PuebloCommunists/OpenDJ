# License gate — pulled out for rework

The YouTube Creative Commons check in Commons DJ is made of three features. All three are removed from
`CommonsDJ-nogate/`, and each one is written up here with its original code, what goes wrong, and a plan for
putting it back. The untouched original source is still in `CommonsDJ/` for reference.

| # | Feature | Original location (`CommonsDJ/src/main.js`) | File |
|---|---|---|---|
| 1 | License-field check (the gate itself) | lines 17–18, 188–190, 259–262, 274, 277–289, 308–309, 364–365 | [1-license-field-check.md](1-license-field-check.md) |
| 2 | CC-search memory (`ccVerifiedIds`) | lines 23–24, 207, 263–265 | [2-cc-search-memory.md](2-cc-search-memory.md) |
| 3 | Title-search fallback (`confirmViaCcSearch`) | lines 236–255, 257, 266–273 | [3-title-search-fallback.md](3-title-search-fallback.md) |

## What the NoGate build does instead

- `downloadTrack()` fetches info and downloads. Nothing is ever skipped for licensing.
- Each track stores `license: info.license || null` and `licenseCheckedBy: 'unchecked'`.
- The library badge shows `UNCHECKED` for anything that isn't clearly CC. It no longer defaults to "CC".
  Credits lines say "license not checked" instead of "Creative Commons".
- The app's name is **Commons DJ NoGate**, so its data lives in `%APPDATA%\Commons DJ NoGate`, separate
  from your real library.
- CC **search** still uses YouTube's Creative Commons filter. Only the download check is gone.

Everything else in `CommonsDJ-nogate/` is the same as the original: decks, mixer, library, and so on.

## Order to put them back

Put them back one at a time, and test after each one before starting the next:

1. **License-field check.** This brings back the gate and the `licenseVerdict()` hook that the other two plug into.
   Expect lots of skips at this stage. That's normal, because the other two features are what rescue videos
   that have no license field.
2. **CC-search memory.** Videos you add from the search tab pass again, this time across restarts.
3. **Title-search fallback.** Pasted links to CC videos with no license field pass again.

Each file has a **"Check it works"** list. Use the fake yt-dlp (`test/fake-ytdlp.py`) for repeatable checks,
then try a few real YouTube links.

### Fake yt-dlp IDs and expected result at each stage

| Video ID | yt-dlp `license` | In CC search? | NoGate | After 1 | After 2 | After 3 |
|---|---|---|---|---|---|---|
| `cc2`, `ccA` | "Creative Commons Attribution…" | cc2 yes, ccA no | download | download | download | download |
| `nocc` | "Standard YouTube License" | no | download | **skip** | skip | skip |
| `cc1` | none | yes (from "lofi beat" search) | download | **skip** | download\* | download |
| `ccX` | none | only when searching its own title | download | **skip** | skip | download |
| `nolic` | none | no | download | **skip** | skip | skip |

\* only if it was returned by a search first, now including searches from before a restart.
