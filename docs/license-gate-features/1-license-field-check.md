# Feature 1 — License-field check (the gate itself)

## What it did

Before downloading, it read yt-dlp's `license` field for the video. If the field looked like Creative Commons
or public domain, the download went ahead. Otherwise the app asked features 2 and 3, and if neither said yes,
it threw a "Skipped: …" error and nothing was downloaded.

This feature also owns `licenseVerdict()`, which is the hook features 2 and 3 plug into, and `skipMessage()`.

## Original code (`CommonsDJ/src/main.js`)

```js
// lines 17–18
// What counts as a reuse-friendly license in yt-dlp's `license` field.
const CC_LICENSE_RE = /creative\s*commons|\bcc[\s-]?(by|0)\b|public\s+domain/i;

// lines 188–190
function isCcLicense(license) {
  return typeof license === 'string' && CC_LICENSE_RE.test(license);
}

// lines 259–275 (the parts for features 2 and 3 are marked)
async function licenseVerdict(info, onStatus = () => {}) {
  if (isCcLicense(info.license)) {
    return { ok: true, license: info.license, how: 'license' };
  }
  // [feature 2: ccVerifiedIds lookup]
  // [feature 3: title-search fallback, skipped when license says "Standard YouTube License"]
  return { ok: false, license: info.license || null };
}

// lines 277–289
function skipMessage(info) {
  if (/standard youtube license/i.test(info.license || '')) {
    return (
      'Skipped: YouTube lists this upload under the Standard YouTube License, not Creative Commons. ' +
      'The song itself might still be CC (lots of re-uploads are labelled this way) — if so, download it from ' +
      'the artist’s own site and drag the file in.'
    );
  }
  return (
    'Skipped: YouTube doesn’t list this upload as Creative Commons. If the music is CC from its original source, ' +
    'download it from there and drag the file in.'
  );
}

// in downloadTrack(), lines 308–309 (right after the "already in library" check)
const verdict = await licenseVerdict(info, (message) => send({ stage: 'checking', message }));
if (!verdict.ok) throw new Error(skipMessage(info));

// in the saved track's source, lines 364–365
license: verdict.license,
licenseCheckedBy: verdict.how,
```

Renderer side (`src/renderer/app.js`): status text said "Checking license…" and "Checking…". `shortLicense()`
returned `'CC'` when there was no license, and `attribution()` fell back to `'Creative Commons'`. The note in
`index.html` said every download is license-checked.

## Problems

1. **Most YouTube videos have no `license` field now.** yt-dlp often leaves it out, so this check alone
   rejects almost everything. It only worked because features 2 and 3 caught those videos, and they were
   unreliable themselves.
2. **The result is only yes or no.** "Checked and not CC", "no data", and "the check crashed" all end up as
   `ok: false` and the same "Skipped" message. You can't tell a real rejection from a failed check.
3. **"Standard YouTube License" is rejected on sight.** That's correct for the upload, but there's no way
   to override it, even when you know the music is CC (for example, a re-upload of a CC track).
4. **Sites other than YouTube are always rejected** unless they report a license string, because the
   fallback in feature 3 only runs for YouTube.
5. **The UI defaulted to "CC".** `shortLicense(null)` returned `'CC'` and credits said "Creative Commons",
   so a track with no license information looked verified.

## Plan for putting it back

- Bring back `CC_LICENSE_RE`, `isCcLicense()`, `licenseVerdict()`, `skipMessage()` and the two lines in
  `downloadTrack()`.
- Return **three states** instead of a yes/no: `{ status: 'cc' | 'not-cc' | 'unknown', license, how }`.
  - `cc`: download.
  - `not-cc` (explicit Standard YouTube License): skip with the existing message.
  - `unknown`: pass it to features 2 and 3. If they can't decide, either skip with a message that says
    "couldn't verify" (not "isn't CC"), or show an **"Add anyway (unverified)"** button that saves the
    track with `licenseCheckedBy: 'user-override'`.
- Keep the NoGate renderer changes: `UNCHECKED` as the badge fallback, and "license not checked" in credits.
- Restore the `index.html` note once the gate is back.

## Check it works

Using the fake yt-dlp (paste each link in the "paste a link" box):

- [ ] `https://www.youtube.com/watch?v=ccA` downloads, and the badge shows `CC-BY` or `CC BY`.
- [ ] `https://www.youtube.com/watch?v=nocc` is skipped with the Standard YouTube License message.
- [ ] `https://www.youtube.com/watch?v=nolic` is skipped with a "couldn't verify" message (or shows the
      override button, if you added one).
- [ ] `cc1` and `ccX` are also skipped at this stage. That's expected until features 2 and 3 are back.

With real YouTube:

- [ ] A video whose page shows "Creative Commons Attribution license (reuse allowed)" downloads.
- [ ] A normal music video is skipped.
