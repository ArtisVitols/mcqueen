#!/usr/bin/env python3
"""Draw a track's racing line on top of its overhead render.

The fastest way to see whether the physics agrees with the road: if the
centreline wanders off the asphalt here, it will wander off it in the game.
Draws the centreline plus both edges (centre +/- the stored half-widths), so
too-wide sections show up as well as misplaced ones.

    python3 tools/overlay_line.py msots
"""
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
OUT = os.path.expanduser('~/mcqueen-shots')


def main():
    name = sys.argv[1]
    meta = json.load(open(os.path.join(BUILD, f'{name}_meta.json')))
    spec = next(t for t in json.load(open(os.path.join(ROOT, 'assets', 'tracks.json')))['tracks']
                if t['id'] == name)
    data = json.load(open(os.path.join(ROOT, 'assets', spec['data'])))

    scale = data.get('modelScale', 1)
    mpp = meta['metresPerPixel']

    def to_px(wx, wz):
        # World is the model scaled up; undo that, then map to image pixels.
        return ((wx / scale - meta['left']) / mpp, (wz / scale - meta['top']) / mpp)

    img = Image.open(os.path.join(BUILD, f'{name}_colour.png')).convert('RGB')
    d = ImageDraw.Draw(img)
    n = data['stationCount']

    def ring(offset, colour, width):
        pts = []
        for i in range(n):
            k = offset if offset >= 0 else -offset
            w = data['outW'][i] if offset > 0 else data['inW'][i]
            o = (w if offset > 0 else -w) if offset else 0
            pts.append(to_px(data['x'][i] + data['ox'][i] * o,
                             data['z'][i] + data['oz'][i] * o))
        d.line(pts + [pts[0]], fill=colour, width=width)

    ring(1, (0, 200, 255), 3)      # outer edge
    ring(-1, (255, 210, 0), 3)     # inner edge
    ring(0, (255, 0, 255), 3)      # centreline
    sx, sy = to_px(data['x'][0], data['z'][0])
    d.ellipse([sx - 9, sy - 9, sx + 9, sy + 9], outline=(255, 255, 255), width=4)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f'overlay_{name}.png')
    img.save(path)
    print(f'wrote {path}  (magenta = centreline, cyan = outer, yellow = inner, '
          f'white ring = start)')


if __name__ == '__main__':
    main()
