#!/usr/bin/env python3
"""Extract a racing line from the overhead passes produced by topdown.mjs.

Circuits from different authors share no naming, no scale and no conventions -
Palm Mile exports 93 materials all called "Material.nnn" - so the road cannot
be found by reading the material list, and classifying pixels by colour fails
because infields contain grey tarmac and grandstands contain green seats.

What does work is the material-ID pass: every material rendered as a flat
unique colour from directly overhead, showing exactly which surface is visible
where. Name the road's material(s) once per track (find them with
tools/probe_points.mjs, or by scanning a transect of the ID image) and the mask
is exact. From there it is the same maths extract_track.py uses for Yoyleland,
and the output format is identical so the game does not care which tool made a
given track.

    node tools/topdown.mjs raw/palm_mile_speedway.glb palm
    python3 tools/extract_oval.py palm
"""
import json
import math
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')

RAYS = 1440
HARMONICS = 12
STATIONS = 1200
TARGET_WIDTH = 18.0     # metres; every circuit is scaled to race like a superspeedway

TRACKS = {
    'msots': {
        'name': 'Motor Speedway of the South',
        # A narrow 0.8 m ribbon at model scale, between the wall (Material.076)
        # and the infield grass (Material.099).
        'road': ['Material.105', 'Material.107'],
        'startBearing': -90.0,      # start/finish on the pit straight
    },
    'palm': {
        'name': 'Palm Mile Speedway',
        # 227 is the dark asphalt; 216/222/225/226 are the kerbs and patches
        # that complete the ring. Material.219 is deliberately excluded - it
        # is the pit lane, and including it drags the centreline off the road
        # and puts the whole field under the pit awnings.
        'road': ['Material.227', 'Material.216', 'Material.222',
                 'Material.225', 'Material.226'],
        'startBearing': -90.0,
    },
}


def decode_height(px, meta):
    r, g, b = px
    if r == 0 and g == 0 and b == 0:
        return None
    t = (r * 65536 + g * 256 + b) / 16777215.0
    return meta['yMin'] + t * (meta['yMax'] - meta['yMin'])


def fourier_smooth(values, harmonics):
    n = len(values)
    coeffs = []
    for k in range(harmonics + 1):
        re = sum(values[i] * math.cos(2 * math.pi * k * i / n) for i in range(n)) * 2 / n
        im = sum(values[i] * math.sin(2 * math.pi * k * i / n) for i in range(n)) * 2 / n
        coeffs.append((re, im))
    out = []
    for i in range(n):
        v = coeffs[0][0] / 2
        for k in range(1, harmonics + 1):
            v += coeffs[k][0] * math.cos(2 * math.pi * k * i / n)
            v += coeffs[k][1] * math.sin(2 * math.pi * k * i / n)
        out.append(v)
    return out


def fill_gaps(values):
    n = len(values)
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        raise SystemExit('ERROR: the road mask is empty - check the material names')
    out = list(values)
    for i in range(n):
        if out[i] is not None:
            continue
        prev = max((k for k in known if k <= i), default=known[-1])
        nxt = min((k for k in known if k >= i), default=known[0])
        span = (nxt - prev) % n or n
        t = ((i - prev) % n) / span
        out[i] = values[prev] * (1 - t) + values[nxt] * t
    return out


def resample(pts, count):
    n = len(pts)
    cum = [0.0]
    for i in range(n):
        cum.append(cum[-1] + math.dist(pts[i], pts[(i + 1) % n]))
    total = cum[-1]
    out, j = [], 0
    for i in range(count):
        target = total * i / count
        while cum[j + 1] < target:
            j += 1
        seg = cum[j + 1] - cum[j]
        t = 0.0 if seg < 1e-9 else (target - cum[j]) / seg
        a, b = pts[j], pts[(j + 1) % n]
        out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out, total


def main():
    name = sys.argv[1]
    cfg = TRACKS[name]
    meta = json.load(open(os.path.join(BUILD, f'{name}_meta.json')))
    size, mpp = meta['size'], meta['metresPerPixel']
    idpx = Image.open(os.path.join(BUILD, f'{name}_id.png')).convert('RGB').load()
    hpx = Image.open(os.path.join(BUILD, f'{name}_height.png')).convert('RGB').load()

    missing = [m for m in cfg['road'] if m not in meta['materials']]
    if missing:
        raise SystemExit(f'ERROR: no such material(s) in {name}: {missing}')
    wanted = {tuple(meta['materials'][m]) for m in cfg['road']}

    mask = set()
    heights = {}
    for y in range(size):
        for x in range(size):
            if idpx[x, y] in wanted:
                mask.add((x, y))
                heights[(x, y)] = decode_height(hpx[x, y], meta)
    if not mask:
        raise SystemExit('ERROR: road materials render nowhere - is the road hidden from above?')
    print(f'{name}: road mask {len(mask)} px ({len(mask) * mpp * mpp:.0f} m2 at model scale)')

    xs = [p[0] for p in mask]
    ys = [p[1] for p in mask]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    reach = math.hypot(max(xs) - min(xs), max(ys) - min(ys))

    # Split each ray into contiguous runs of road. A ray may cross several:
    # the ribbon itself, plus any pit lane, apron or access ramp sharing the
    # road's material.
    runs_by_ray = []
    for i in range(RAYS):
        a = 2 * math.pi * i / RAYS
        dx, dy = math.cos(a), math.sin(a)
        runs, start, prev = [], None, None
        r = 1.0
        while r < reach:
            hit = (int(cx + dx * r), int(cy + dy * r)) in mask
            if hit:
                if start is None:
                    start = r
                prev = r
            elif start is not None and r - prev > 2.0:
                runs.append((start, prev))
                start = None
            r += 0.5
        if start is not None:
            runs.append((start, prev))
        runs_by_ray.append(runs)

    # First pass: the outermost run. Then median-filter across neighbouring
    # rays, which shrugs off the minority of rays that an appendage corrupts.
    rough = [(r[-1][0] + r[-1][1]) / 2 if r else None for r in runs_by_ray]
    filled = fill_gaps(rough)
    win = RAYS // 24
    guide = []
    for i in range(RAYS):
        near = sorted(filled[(i + k) % RAYS] for k in range(-win, win + 1))
        guide.append(near[len(near) // 2])

    # Second pass: on each ray keep the run whose midpoint sits closest to the
    # guide, so the ribbon is followed rather than whatever reaches furthest.
    inner, outer = [], []
    for i in range(RAYS):
        runs = runs_by_ray[i]
        if not runs:
            inner.append(None)
            outer.append(None)
            continue
        best = min(runs, key=lambda s: abs((s[0] + s[1]) / 2 - guide[i]))
        inner.append(best[0])
        outer.append(best[1])
    print(f'  traced {sum(1 for v in outer if v is not None)}/{RAYS} rays')

    inner = fourier_smooth(fill_gaps(inner), HARMONICS)
    outer = fourier_smooth(fill_gaps(outer), HARMONICS)

    raw = []
    for i in range(RAYS):
        a = 2 * math.pi * i / RAYS
        r = 0.5 * (inner[i] + outer[i])
        raw.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    centre_px, lap_px = resample(raw, STATIONS)

    band = sorted(outer[i] - inner[i] for i in range(RAYS))
    model_width = band[RAYS // 2] * mpp
    scale = TARGET_WIDTH / model_width
    print(f'  ribbon {model_width:.2f} m wide at model scale -> scale x{scale:.2f}')
    print(f'  lap {lap_px * mpp:.1f} m -> {lap_px * mpp * scale:.0f} m scaled')

    def height_at(px, py):
        return heights.get((int(round(px)), int(round(py))))

    stations = []
    for i, (px, py) in enumerate(centre_px):
        ax, ay = centre_px[(i + 1) % STATIONS]
        bx, by = centre_px[(i - 1) % STATIONS]
        tx, ty = ax - bx, ay - by
        tl = math.hypot(tx, ty) or 1
        tx, ty = tx / tl, ty / tl
        nx, ny = -ty, tx
        if nx * (px - cx) + ny * (py - cy) < 0:
            nx, ny = -nx, -ny

        def edge(sign):
            d, gap, last = 0.0, 0.0, 0.0
            while d < reach:
                d += 0.5
                if (int(px + nx * sign * d), int(py + ny * sign * d)) in mask:
                    gap, last = 0.0, d
                else:
                    gap += 0.5
                    if gap > 2.0:
                        break
            return last
        out_d, in_d = edge(1), edge(-1)

        hc = height_at(px, py)
        ho = height_at(px + nx * out_d * 0.8, py + ny * out_d * 0.8)
        hi_ = height_at(px - nx * in_d * 0.8, py - ny * in_d * 0.8)
        span = (out_d + in_d) * 0.8 * mpp
        slope = ((ho - hi_) / span) if (ho is not None and hi_ is not None and span > 1e-6) else 0.0

        stations.append({
            'x': (meta['left'] + px * mpp) * scale,
            'z': (meta['top'] + py * mpp) * scale,
            'y': (hc if hc is not None else 0.0) * scale,
            'tx': tx, 'tz': ty, 'ox': nx, 'oz': ny,
            'outW': out_d * mpp * scale, 'inW': in_d * mpp * scale,
            'slope': slope, 'px': px, 'py': py,
        })

    # A missing height leaves a hole; carry the neighbours across before smoothing.
    ys_ = [s['y'] for s in stations]
    good = [v for v in ys_ if v is not None]
    fallback = sum(good) / len(good) if good else 0.0
    for s in stations:
        if s['y'] is None:
            s['y'] = fallback
    for key in ('y', 'slope', 'outW', 'inW'):
        for s, v in zip(stations, fourier_smooth([s[key] for s in stations], HARMONICS)):
            s[key] = v
    for s in stations:
        s['outW'] = min(TARGET_WIDTH * 0.7, max(4.5, s['outW']))
        s['inW'] = min(TARGET_WIDTH * 0.7, max(4.5, s['inW']))

    # NASCAR runs anticlockwise: infield on the driver's left puts the outward
    # normal on their right, so (t x o).y must be negative with Y up.
    s0 = stations[0]
    if (s0['tz'] * s0['ox'] - s0['tx'] * s0['oz']) > 0:
        print('  reversing direction so cars turn left')
        stations.reverse()
        for s in stations:
            s['tx'], s['tz'] = -s['tx'], -s['tz']

    wcx = (meta['left'] + cx * mpp) * scale
    wcz = (meta['top'] + cy * mpp) * scale
    want = math.radians(cfg['startBearing'])
    best = max(range(STATIONS), key=lambda i: (
        (stations[i]['x'] - wcx) * math.cos(want) + (stations[i]['z'] - wcz) * math.sin(want))
        / max(1e-6, math.hypot(stations[i]['x'] - wcx, stations[i]['z'] - wcz)))
    stations = stations[best:] + stations[:best]

    lap = sum(math.dist((stations[i]['x'], stations[i]['z']),
                        (stations[(i + 1) % STATIONS]['x'], stations[(i + 1) % STATIONS]['z']))
              for i in range(STATIONS))
    widths = [s['outW'] + s['inW'] for s in stations]
    banks = [math.atan(s['slope']) for s in stations]
    print(f'  final: lap {lap:.0f} m, width {min(widths):.1f}-{max(widths):.1f} m, '
          f'bank {math.degrees(min(banks)):.1f}..{math.degrees(max(banks)):.1f} deg, '
          f'y {min(s["y"] for s in stations):.1f}..{max(s["y"] for s in stations):.1f} m')

    data = {
        'lapLength': round(lap, 3),
        'stationCount': STATIONS,
        'stationStep': round(lap / STATIONS, 6),
        'centre': [round(wcx, 3), round(wcz, 3)],
        'modelScale': round(scale, 6),
        'x': [round(s['x'], 2) for s in stations],
        'z': [round(s['z'], 2) for s in stations],
        'y': [round(s['y'], 3) for s in stations],
        'tx': [round(s['tx'], 5) for s in stations],
        'tz': [round(s['tz'], 5) for s in stations],
        'ox': [round(s['ox'], 5) for s in stations],
        'oz': [round(s['oz'], 5) for s in stations],
        'outW': [round(s['outW'], 2) for s in stations],
        'inW': [round(s['inW'], 2) for s in stations],
        'bank': [round(b, 5) for b in banks],
    }
    out = os.path.join(ROOT, 'assets', f'track-{name}.json')
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print(f'  wrote {out} ({os.path.getsize(out) / 1024:.0f} KB)')
    preview(mask, stations)


def preview(mask, stations):
    pts = [(s['px'], s['py']) for s in stations]
    xs = [p[0] for p in mask]
    ys = [p[1] for p in mask]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    cols, rows = 100, 42
    sx, sy = (x1 - x0) / cols or 1, (y1 - y0) / rows or 1
    canvas = [[' '] * cols for _ in range(rows)]
    for (x, y) in mask:
        c, r = int((x - x0) / sx), int((y - y0) / sy)
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = '.'
    off = 0
    for i, (x, y) in enumerate(pts):
        if (int(x), int(y)) not in mask:
            off += 1
        c, r = int((x - x0) / sx), int((y - y0) / sy)
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = 'S' if i == 0 else '#'
    print('\ncentreline (#) over the road mask (.), S = start/finish:')
    print('\n'.join(''.join(r) for r in canvas))
    print(f'stations off the road: {off} / {len(pts)}')
    if off > len(pts) * 0.02:
        raise SystemExit('ERROR: centreline leaves the road')


if __name__ == '__main__':
    main()
