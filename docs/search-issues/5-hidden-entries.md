# 5 — Channels and playlists in results were dropped silently

**State: still dropped in the NoGate build, but now listed under Details → Hidden.**

## What's wrong

YouTube search results include channels and playlists as well as videos. The original code threw these away
without saying so:

```js
const entries = (data.entries || []).filter((e) => e && e.id && (e.ie_key === 'Youtube' || !e.ie_key));
```

That's reasonable, because a channel can't be added as a track. But it made the count look short, and it
used up places in the 25-result limit. For example, "lofi beats" returns the **Lofi Girl** channel (as a
`YoutubeTab` entry) as one of its 50.

The NoGate build keeps the same rule. It also drops duplicate IDs, and lists everything it hid with the reason
("not a video (YoutubeTab)", "duplicate", "no video id").

## Plan

- Show channels and playlists as small non-downloadable rows ("Channel · open on YouTube"), so the results
  line up with youtube.com one-to-one.
- Or keep hiding them, but don't count them toward the limit: fetch extra so you still get N videos.

## Check it works

- [ ] Search "lofi beats" and open **Details**. "Lofi Girl — not a video (YoutubeTab)" is listed.
- [ ] (After the change) The channel appears as a row you can open, or the video count stays at the full
      limit.
