# Feature 3 — Title-search fallback (`confirmViaCcSearch`)

**Needs feature 1 first.** It works best with feature 2 back as well.

## What it did

When a YouTube video had no usable `license` field and wasn't in the CC-search memory, the app searched
YouTube for the video's own title (and then title + channel) with the Creative Commons filter on. If the
exact video ID appeared in the first 40 results, the video counted as CC. This is the check behind most of
the problems.

## Original code (`CommonsDJ/src/main.js`)

```js
// lines 236–255
// Ask YouTube itself: does this video show up when searching its own title
// with the Creative Commons filter on? That's YouTube's CC flag, and it works
// even when yt-dlp doesn't return a license field for the video.
async function confirmViaCcSearch(info) {
  const queries = [info.title, info.channel && `${info.title} ${info.channel}`].filter(Boolean);
  for (const q of queries) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${CC_SEARCH_PARAM}`;
    try {
      const out = await runYtdlp(['--flat-playlist', '--playlist-end', '40', '-J', url]);
      const ids = (JSON.parse(out).entries || []).map((e) => e && e.id);
      if (ids.includes(info.id)) {
        ccVerifiedIds.add(info.id);
        return true;
      }
    } catch {
      // fall through to the next query
    }
  }
  return false;
}

// in licenseVerdict(), lines 266–273, after the feature-2 branch
// No usable license field (common on YouTube now): check against YouTube's CC filter.
const explicitlyStandard = /standard youtube license/i.test(info.license || '');
if (isYoutube(info) && !explicitlyStandard) {
  onStatus('Checking YouTube’s Creative Commons filter…');
  if (await confirmViaCcSearch(info)) {
    return { ok: true, license: 'Creative Commons Attribution (YouTube CC filter)', how: 'cc-search-check' };
  }
}
```

## Problems

1. **Errors count as "not CC".** The `catch {}` swallows network failures, yt-dlp errors, rate limiting
   and bad JSON, then returns `false`. A flaky connection or an outdated yt-dlp shows up as
   "Skipped: YouTube doesn't list this upload as Creative Commons." This is probably the biggest source of
   confusing failures.
2. **Searching by title depends on ranking.** Common titles ("Lofi Beat", "Chill Mix"), popular songs with
   many re-uploads, or titles full of emoji, brackets and "| Free to use | No copyright" tags can push the
   real video below position 40. Real CC videos then get rejected.
3. **The raw title makes a poor search query.** Very long titles, special characters and non-Latin scripts
   make YouTube's search less precise.
4. **It's slow.** Up to two extra yt-dlp runs (each starts a new process, loads the JS runtime and fetches a
   search page) before the download even starts. Several seconds each, longer on ARM.
5. **Results aren't cached.** A video that passed is added to `ccVerifiedIds`, but that's in memory only
   (see feature 2). A video that failed is searched again on every retry.
6. **It's YouTube only.** Other sites never get a fallback (see feature 1, problem 4).

## Plan for putting it back

- Bring back `confirmViaCcSearch()` and the `licenseVerdict()` branch, but have it return
  **`'cc' | 'not-found' | 'error'`** instead of `true`/`false`. Don't swallow errors: if every query
  failed, return `'error'` with the last error message, so the user sees "Couldn't check the license
  (network / yt-dlp problem). Try again or update yt-dlp." instead of "Skipped".
- **Better queries, in this order:**
  1. The video ID itself (`search_query=<id>` with the CC filter). YouTube search often returns the exact
     video for its ID, and it's the most specific query.
  2. A cleaned-up title: strip `[...]`, `(...)`, `|`-separated tags, emoji, "free to use" and
     "no copyright" phrases, and cap it at about 80 characters.
  3. Cleaned title + channel.
- Stop as soon as one query matches, so the common case costs one search instead of two.
- Optionally raise `--playlist-end` for the title queries (60–80). It's a trade-off against speed.
- Write successes to the saved `cc-verified.json` from feature 2.
- Show which step is running in the status line ("Checking YouTube's CC filter (1/3)…").

## Check it works

Using the fake yt-dlp:

- [ ] Paste `https://www.youtube.com/watch?v=ccX` (no license field, but found by searching its title).
      It downloads.
- [ ] Paste `https://www.youtube.com/watch?v=nolic`. It's skipped with a "couldn't verify / not found in
      YouTube's CC filter" message.
- [ ] Simulate an error by temporarily making the fake script `sys.exit(1)` on `--flat-playlist`. Pasting
      `ccX` should now show the "couldn't check" error, not "Skipped".
- [ ] `nocc` (Standard YouTube License) is still skipped without running any search.

With real YouTube:

- [ ] A CC video with a long, emoji-heavy title passes when pasted directly, without searching first.
- [ ] Turn off Wi-Fi and paste a CC link. You get a connection error, not a license skip.
- [ ] Time a pasted CC link from clicking to download start. It should be noticeably faster than in the
      original build.
