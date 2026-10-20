# 4 — Results are mostly long mixes and live streams

**State: shown and flagged in the NoGate build, not filtered.**

## What's wrong

For music searches, YouTube ranks hour-long mixes and 24/7 live streams at the top:

- "lofi beat" with the CC filter: **17 of the first 25** results were over 20 minutes.
- "lofi beats" with no filter: **43 of 50** were over 20 minutes, and **6–8 were live streams** (no length).

For a DJ app these are mostly not what you want:

- **Mixes** (1–24 hours) are huge downloads. They're decoded fully into memory (see "Notes and limits" in the
  README), and BPM detection only looks at part of them.
- **Live streams** have no length, and a yt-dlp download of a live stream never finishes. **Don't click Add
  on a "live / no length" result in this build.** It will keep downloading until you cancel or close the app.

So the individual tracks you were looking for are buried, or pushed out of the first 25 entirely (#2).

## What the NoGate build shows

- A length badge on every thumbnail, **red when over 20 minutes**.
- No badge means live or unknown length.
- The details strip counts both ("43 over 20 min", "6 live / no length").

## Plan

- Block **Add** on live results (`duration` missing and/or `live_status === 'is_live'`). Show "Live, can't
  download" instead.
- Add a length filter next to the search box: **Any / Under 10 min / Under 20 min**. Apply it to the results
  as they arrive. YouTube's own "Under 4 minutes" and "4–20 minutes" search filters are another option. They
  are `sp=` values like the CC filter, and would combine with it.
- Have the details strip say how many results the length filter hid. Hiding them silently is the problem
  this whole write-up is about.

## Check it works (when implemented)

- [ ] Search "lofi beats" and set the length filter to "Under 20 min". Only results under 20 minutes show,
      and the strip says how many were hidden.
- [ ] A live result can't be added and says why.
