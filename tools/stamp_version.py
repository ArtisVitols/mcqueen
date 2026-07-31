#!/usr/bin/env python3
"""Stamp a build id into index.html so deploys are atomic for the browser.

GitHub Pages serves everything with max-age=600 and no content hashing, so a
phone can hold a freshly fetched track-data.json next to the previous
track.glb for ten minutes. That combination puts the cars on banking the model
no longer has - which looks exactly like the floating-car bug and is entirely a
caching artefact.

index.html is the one file that always refreshes within its ten minutes, so it
carries the build id. Everything fetched afterwards - the entry script, the
stylesheet and every model and data file - gets that id as a query string, so a
given index.html can only ever pull assets from its own deploy.

    python3 tools/stamp_version.py            # stamp with the current time
    python3 tools/stamp_version.py --check    # is it stamped? (exit 1 if not)
"""
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')


def current_build():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')
    try:
        sha = subprocess.check_output(['git', 'rev-parse', '--short=7', 'HEAD'],
                                      cwd=ROOT, stderr=subprocess.DEVNULL).decode().strip()
        return f'{stamp}-{sha}'
    except Exception:
        return stamp


def read():
    with open(INDEX, encoding='utf-8') as f:
        return f.read()


def stamped_value(html):
    m = re.search(r"window\.__BUILD__ = '([^']*)'", html)
    return m.group(1) if m else None


def main():
    html = read()
    if '--check' in sys.argv:
        value = stamped_value(html)
        print(f'index.html build id: {value}')
        if not value or value == 'dev':
            print('NOT STAMPED - run python3 tools/stamp_version.py before deploying')
            return 1
        for pattern in (r'styles\.css\?v=([^"]+)', r'src/main\.js\?v=([^"]+)'):
            m = re.search(pattern, html)
            if not m or m.group(1) != value:
                print(f'MISMATCH: {pattern} is {m.group(1) if m else "missing"}, expected {value}')
                return 1
        print('OK - entry points and asset loader all carry this id')
        return 0

    build = current_build()
    html = re.sub(r"window\.__BUILD__ = '[^']*'", f"window.__BUILD__ = '{build}'", html)
    html = re.sub(r'styles\.css\?v=[^"]+', f'styles.css?v={build}', html)
    html = re.sub(r'src/main\.js\?v=[^"]+', f'src/main.js?v={build}', html)
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'stamped index.html with build {build}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
