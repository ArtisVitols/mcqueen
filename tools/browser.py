#!/usr/bin/env python3
"""Tiny WebDriver client for driving headless Firefox.

Firefox's --screenshot flag fires as soon as the load event does, which is
useless for a page that keeps working asynchronously. This talks to geckodriver
directly so tests can wait for a condition, run script and grab the result.

Only depends on `requests` and the geckodriver binary, both already present.
"""
import atexit
import base64
import json
import os
import signal
import subprocess
import time

import requests

PORT = 4444
BASE = f'http://127.0.0.1:{PORT}'


class Browser:
    def __init__(self, width=1280, height=720, prefs=None):
        # There is no GPU here, so point Mesa at the llvmpipe software
        # rasteriser; geckodriver passes its environment on to Firefox.
        env = dict(os.environ,
                   LIBGL_ALWAYS_SOFTWARE='1',
                   GALLIUM_DRIVER='llvmpipe',
                   MOZ_ENABLE_WAYLAND='0',
                   MOZ_WEBRENDER='1')
        self.proc = subprocess.Popen(
            ['geckodriver', '--port', str(PORT), '--log', 'fatal'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=env, preexec_fn=os.setsid)
        atexit.register(self.quit)
        self._wait_for_driver()

        # Software WebGL: there is no GPU on this box, and without these the
        # renderer refuses to create a context at all.
        allprefs = {
            'webgl.force-enabled': True,
            'webgl.disabled': False,
            'webgl.forbid-software': False,
            'webgl.out-of-process': False,
            'webgl.disable-angle': True,
            'webgl.dxgl.enabled': False,
            'gfx.webrender.software': True,
            'gfx.webrender.all': True,
            'gfx.canvas.accelerated': False,
            'layers.acceleration.disabled': True,
            'security.sandbox.content.level': 0,
            'dom.webgpu.enabled': False,
        }
        allprefs.update(prefs or {})

        caps = {'capabilities': {'alwaysMatch': {
            'browserName': 'firefox',
            'moz:firefoxOptions': {
                'args': ['-headless', f'--width={width}', f'--height={height}'],
                'prefs': allprefs,
            },
        }}}
        r = requests.post(f'{BASE}/session', json=caps, timeout=90)
        r.raise_for_status()
        self.sid = r.json()['value']['sessionId']
        self.set_size(width, height)

    def _wait_for_driver(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                requests.get(f'{BASE}/status', timeout=2)
                return
            except requests.RequestException:
                time.sleep(0.2)
        raise RuntimeError('geckodriver did not start')

    def _post(self, path, body=None, timeout=120):
        r = requests.post(f'{BASE}/session/{self.sid}{path}', json=body or {}, timeout=timeout)
        r.raise_for_status()
        return r.json().get('value')

    def _get(self, path, timeout=120):
        r = requests.get(f'{BASE}/session/{self.sid}{path}', timeout=timeout)
        r.raise_for_status()
        return r.json().get('value')

    def set_size(self, w, h):
        self._post('/window/rect', {'width': w, 'height': h, 'x': 0, 'y': 0})

    def go(self, url):
        self._post('/url', {'url': url})

    def script(self, src, args=None):
        return self._post('/execute/sync', {'script': src, 'args': args or []})

    def title(self):
        return self._get('/title')

    def text(self):
        return self.script('return document.body.innerText')

    def wait_for(self, expr, timeout=180, poll=0.5, label=''):
        """Poll a JS expression until it returns truthy. Returns its value."""
        end = time.time() + timeout
        last = None
        while time.time() < end:
            last = self.script(f'return ({expr})')
            if last:
                return last
            time.sleep(poll)
        raise TimeoutError(f'timed out waiting for {label or expr} (last={last!r})')

    def console_errors(self):
        return self.script('return window.__errors || []')

    def install_error_capture(self):
        """Must be called after navigation; records later errors on the page."""
        self.script("""
            window.__errors = window.__errors || [];
            if (!window.__errHooked) {
              window.__errHooked = true;
              addEventListener('error', e =>
                window.__errors.push(String(e.message || e.error)));
              addEventListener('unhandledrejection', e =>
                window.__errors.push('unhandled rejection: ' + (e.reason?.message || e.reason)));
              const ce = console.error;
              console.error = (...a) => { window.__errors.push(a.map(String).join(' ')); ce(...a); };
            }
        """)

    def screenshot(self, path):
        data = self._get('/screenshot')
        with open(path, 'wb') as f:
            f.write(base64.b64decode(data))
        return path

    def quit(self):
        try:
            requests.delete(f'{BASE}/session/{self.sid}', timeout=10)
        except Exception:
            pass
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except Exception:
            pass


def serve(root, port=8099):
    """Background static file server rooted at `root`."""
    proc = subprocess.Popen(
        ['python3', '-m', 'http.server', str(port), '--bind', '127.0.0.1'],
        cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid)
    atexit.register(lambda: os.killpg(os.getpgid(proc.pid), signal.SIGTERM))
    for _ in range(60):
        try:
            requests.get(f'http://127.0.0.1:{port}/', timeout=1)
            return proc
        except requests.RequestException:
            time.sleep(0.2)
    raise RuntimeError('static server did not start')
