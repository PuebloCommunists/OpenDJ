# 2 — Result cap (no paging)

**State: limit raised from 25 to 50. Still no "load more".**

## What's wrong

The original search asked yt-dlp for `--playlist-end 25` and stopped there. YouTube has far more: a test
search for "lofi beat" with the CC filter on returned 200 results with no trouble (199 unique). So anything
YouTube ranked 26th or lower never appeared in the app. That's the main reason for "many videos missing".

The NoGate build uses `SEARCH_LIMIT = 50` (in `src/main.js`), which is about 2–3 screens of YouTube's
infinite scroll. Each search takes about 5–6 s at 50.

## Original code

```js
const out = await runYtdlp(['--flat-playlist', '--playlist-end', '25', '-J', url]);
```

## Plan

- Add a **Load more** button under the results. It calls search again with
  `--playlist-start N+1 --playlist-end N+50` and appends the results. Keep `rank` continuous.
- Note that yt-dlp re-fetches the earlier pages internally to reach page N, so each "load more" gets a bit
  slower. That's acceptable up to a few hundred results.
- Optionally let the first page come back faster (for example, 20) and load the rest in the background.
- Remove duplicates by ID across pages. YouTube occasionally repeats a video.

## Check it works

- [ ] Search "lofi beats", note result #50, click **Load more**. Results #51–#100 appear and the numbering
      continues.
- [ ] No video appears twice.
- [ ] Open on YouTube to compare, scroll to roughly the same depth, and spot-check that the same videos
      appear in roughly the same order.
