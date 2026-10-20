# Feature 2 — CC-search memory (`ccVerifiedIds`)

**Needs feature 1 first** (it plugs into `licenseVerdict()`).

## What it did

Every video that came back from the in-app Creative Commons search (YouTube's own CC filter) had its ID added
to a set. When you downloaded one of those videos, the license check passed straight away, even with no
`license` field.

## Original code (`CommonsDJ/src/main.js`)

```js
// lines 23–24
// Video IDs that YouTube itself returned under the Creative Commons filter.
const ccVerifiedIds = new Set();

// in searchCreativeCommons(), line 207, for each search result
ccVerifiedIds.add(e.id);

// in licenseVerdict(), lines 263–265, right after the license-field check
if (info.id && ccVerifiedIds.has(info.id) && isYoutube(info)) {
  return { ok: true, license: info.license || 'Creative Commons Attribution (YouTube CC filter)', how: 'cc-search' };
}

// line 257 (shared with feature 3)
const isYoutube = (info) => /youtube/i.test(info.extractor_key || info.extractor || '');
```

## Problems

1. **It's only kept in memory.** After the app restarts the set is empty, so a video you found in search
   yesterday fails if you paste its link today, or if you click Retry after a restart. Then it falls through
   to feature 3, which is the fragile one.
2. **It only works in the session where you searched.** Pasting a link to a known CC video never benefits,
   unless you searched for it first in the same session.
3. **The label is a guess.** It saves "Creative Commons Attribution (YouTube CC filter)", but YouTube's CC
   filter only means CC BY. That's right today, but it's an assumption, not something YouTube reported.
4. **Minor: the ID is trusted without checking the extractor at add time.** The search only keeps entries
   where `ie_key === 'Youtube' || !ie_key`. The lookup later checks `isYoutube(info)`, so this is mostly
   fine, but it's worth tightening if you change how IDs are stored.

## Plan for putting it back

- Bring back the set and the `licenseVerdict()` branch.
- **Save it to disk:** `paths.ccVerified = path.join(paths.root, 'cc-verified.json')`. Store
  `{ [id]: { seenAt, query } }`, load it in `initPaths()` or at startup, and save it (debounced, like
  `saveLibrary()`) whenever search adds new IDs.
- Optionally expire entries after a long time (for example, 180 days), since uploaders can change a video's
  license.
- Store `how: 'cc-search'` on the track as before, so you can tell which tracks were verified this way.

## Check it works

Using the fake yt-dlp:

- [ ] Search "lofi beat" and click **Add** on "Sunny Lofi Beat" (`cc1`). It downloads.
- [ ] Remove that track from the library, **restart the app**, then paste
      `https://www.youtube.com/watch?v=cc1`. It downloads without searching again. (This failed in the
      original build.)
- [ ] `cc-verified.json` exists in `%APPDATA%\Commons DJ NoGate` and contains `cc1` and `cc2`.
- [ ] `ccX` and `nolic` are still skipped (until feature 3 is back).

With real YouTube:

- [ ] Search for something, add a result. It downloads.
- [ ] Restart, then paste a link to a *different* result from that same search. It downloads.
