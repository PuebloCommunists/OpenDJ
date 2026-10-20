# Search — isolated issues

The in-app search had two visible problems: thumbnails cut off, and "many, many videos missing". In the NoGate
build the search is now a **plain YouTube search**. It sends the same query YouTube's own search box would and
shows results in YouTube's order. A details strip shows exactly what was searched, so you can check it against
youtube.com. Everything else is split into the items below, to fix one at a time.

| # | Issue | State in NoGate build | File |
|---|---|---|---|
| 1 | Result cards collapse to a sliver; thumbnails cut off | **Fixed** (please confirm) | [1-card-layout.md](1-card-layout.md) |
| 2 | Only the first 25 results, with no way to see more | Limit raised to 50, still no "load more" | [2-result-cap.md](2-result-cap.md) |
| 3 | Creative Commons filter hides most of YouTube | **Off** (plain search) | [3-cc-filter.md](3-cc-filter.md) |
| 4 | Results are mostly multi-hour mixes and 24/7 live streams | Shown and flagged, not filtered | [4-mixes-and-live.md](4-mixes-and-live.md) |
| 5 | Channels and playlists in results are silently dropped | Now listed under "Details → Hidden" | [5-hidden-entries.md](5-hidden-entries.md) |

## What changed in the NoGate build

- `src/main.js`, `searchCreativeCommons()`: no CC filter (`sp=` removed from the URL), limit set by
  `SEARCH_LIMIT = 50`, and it returns `{ query, url, filter, limit, received, dropped, results, ms }` instead
  of a bare array. Each result has a `rank` (its position on YouTube).
- `src/renderer/app.js`: `renderCcInfo()` draws the details strip. Cards show the rank, the length (red
  when over 20 minutes), the video ID, and a two-line title.
- `src/renderer/styles.css`: card layout fix (see #1), plus styles for the details strip.
- `src/renderer/index.html`: the tab is renamed **YouTube search**, the dev-build note is one line, and there's
  an **Expand ⤢** button. It lets the library or search panel cover the decks (Esc or **Collapse** goes back).
  The decks keep playing underneath.

## The details strip

```
"lofi beats" on YouTube   showing 49 of 50 returned (limit 50)   43 over 20 min   6 live / no length   1 hidden   5.6s   Open on YouTube to compare
▸ Details  →  filter, the exact URL searched, and anything the app hid and why
```

**Open on YouTube to compare** opens the exact same search URL in your browser, so you can line the results
up against the app's `#1, #2, …` numbers.

## Order to work on them

1. Confirm #1 (layout) is fixed on your screen size.
2. #4 (mixes and live). This decides what a "useful" result is for DJing, which affects #2 and #3.
3. #2 (load more / paging).
4. #3 (bring the CC filter back as an option, together with the license gate in `../license-gate-features/`).
5. #5 is small, and can go along with whichever of the above touches the result filter.
