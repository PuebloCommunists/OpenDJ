#!/usr/bin/env python3
# Stand-in for yt-dlp used by the smoke test (no network). Mimics the handful of
# command lines Commons DJ uses: --version, CC search, -J info, and download.
import json, os, shutil, sys, time

args = sys.argv[1:]
src_wav = os.environ.get('CDJ_FAKE_AUDIO')

if '--version' in args:
    print('2099.01.01')
    sys.exit(0)

url = args[-1]
vid = url.rsplit('=', 1)[-1]

if '--flat-playlist' in args:
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(url).query).get('search_query', [''])[0]
    extra = [{'id': 'ccX', 'ie_key': 'Youtube', 'title': 'Track ccX', 'channel': 'Some Creator', 'duration': 60,
              'url': 'https://www.youtube.com/watch?v=ccX'}] if 'ccX' in q else []
    print(json.dumps({'entries': extra + [
        {'id': 'cc1', 'ie_key': 'Youtube', 'title': 'Sunny Lofi Beat (free to use)', 'channel': 'Open Beats', 'duration': 60,
         'url': 'https://www.youtube.com/watch?v=cc1'},
        {'id': 'cc2', 'ie_key': 'Youtube', 'title': 'Funk Breakbeat 98 BPM', 'channel': 'Commons Crew', 'duration': 60,
         'url': 'https://www.youtube.com/watch?v=cc2'},
    ]}))
    sys.exit(0)

# NoGate build: every ID below downloads. The comments describe what the
# license gate should do once it's reimplemented (see license-gate-features/).
licenses = {
    'cc1': None,  # license row missing — only trusted because the CC search returned it
    'cc2': 'Creative Commons Attribution license (reuse allowed)',
    'ccA': 'Creative Commons Attribution license (reuse allowed)',
    'nocc': 'Standard YouTube License',
    'ccX': None,     # no license field, but YouTube's CC filter finds it by title
    'nolic': None,   # no license field and not in CC search -> must be skipped
}
info = {
    'id': vid, 'title': f'Track {vid}', 'channel': 'Some Creator', 'duration': 60,
    'extractor_key': 'Youtube', 'webpage_url': f'https://www.youtube.com/watch?v={vid}',
    'license': licenses.get(vid, 'Standard YouTube License'),
}

if '-J' in args:
    print(json.dumps(info))
    sys.exit(0)

if '-o' in args:
    template = args[args.index('-o') + 1]
    out = template.replace('%(extractor_key)s', 'Youtube').replace('%(id)s', vid).replace('%(ext)s', 'wav')
    for p in (10, 45.5, 100):
        print(f'[download]  {p:.1f}% of 5.00MiB at 1.00MiB/s ETA 00:01', flush=True)
        time.sleep(0.1)
    shutil.copyfile(src_wav, out)
    print(f'CDJPATH:{out}', flush=True)
    sys.exit(0)

print('ERROR: unexpected arguments', file=sys.stderr)
sys.exit(2)
