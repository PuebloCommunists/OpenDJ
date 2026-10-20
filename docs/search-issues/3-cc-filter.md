# 3 — Creative Commons filter

**State: off in the NoGate build.** The search matches what you'd see by searching on youtube.com.

## What it did

The original search added YouTube's own "Creative Commons" filter to the search URL:

```js
// YouTube's own "Creative Commons" search filter.
const CC_SEARCH_PARAM = 'EgIwAQ%253D%253D';
const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${CC_SEARCH_PARAM}`;
```

(`EgIwAQ==` is the "Features → Creative Commons" filter on YouTube's search page. The double `%25`
encoding is how YouTube itself writes it in the URL.)

The constant is still in `src/main.js`, unused, so it's ready to put back.

## Why results looked "missing"

- Only uploads the uploader has explicitly marked **CC BY** pass this filter. That's a small slice of YouTube.
  Most "free to use" or "no copyright" music is uploaded under the Standard YouTube License with a note in the
  description, so the filter hides it.
- Searching on youtube.com without the filter shows many more videos, so it looked like the app was missing
  them. It was the filter, plus the 25-result cap (#2).

## Plan

- Bring it back as a **toggle** next to the search box: "Creative Commons only" (on or off), with the
  current state shown in the details strip ("Filter: …").
- Decide together with the license gate (`../license-gate-features/`). If the CC-only toggle is on, results
  could be pre-marked as "CC (search)", which ties into feature 2 there (CC-search memory).

## Check it works (when reimplemented)

- [ ] With the toggle off, results match youtube.com for the same words (use Open on YouTube to compare).
- [ ] With the toggle on, results match youtube.com with **Filters → Creative Commons** selected, and the
      details strip shows the filter in use.
