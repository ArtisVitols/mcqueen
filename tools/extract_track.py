#!/usr/bin/env python3
"""Derive the racing line from the speedway GLB.

The stadium mesh is 755k triangles; nothing in the game raycasts against it.
Instead we extract the asphalt ribbon once, offline, into a small JSON that
describes the oval as a centreline spline with per-station width, height and
banking. The game then drives cars in (s, lateral) track space, which makes
lap counting, race positions and NASCAR-style lane changes trivial and keeps
the phone at 60fps.

The tricky part is that the 'Asphalt' material also covers a wide flat apron
either side of the banked ribbon, so centring on it drifts off the racing
surface. The mesh does however carry painted boundary lines as their own
materials, and those bracket the ribbon unambiguously - so the centreline is
traced from the lines, and the asphalt deck is only used for heights.

Output: assets/track-data.json
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import GLB  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'raw', 'speedway.glb')
OUT = os.path.join(ROOT, 'assets', 'track-data.json')

# The banked racing ribbon plus everything painted on it. Deliberately excludes
# 'Asphalt.001' (flat infield paving, 390k cells at y=0) and 'Asphalt.002'
# (the pit lane strip) - either would swallow the interior of the oval.
DECK = {'Asphalt', 'Asphalt_Line', 'Asphalt_Line_2', 'Asphalt_Line_3', 'Finish_Line'}
OUTER_LINE = 'Asphalt_Line_2'   # painted line near the outer wall
INNER_LINE = 'Asphalt_Line'     # painted line along the inside of the ribbon
FINISH_LINE = 'Finish_Line'

CELL = 1.0           # occupancy grid resolution, metres
RAYS = 1440          # radial samples used to trace each ring
HARMONICS = 14       # Fourier terms kept when smoothing periodic signals
STATIONS = 1200      # final arc-length-resampled centreline points
PLANE_TOL = 0.8      # metres a cell may deviate from the local banking plane
MIN_HALF, MAX_HALF = 5.0, 13.0


# ---------------------------------------------------------------- rasterising

def rasterise(tris):
    """Scanline-rasterise triangles into {(gx, gz): [heights]}."""
    grid = {}
    for a, b, c in tris:
        ax, az = a[0] / CELL, a[2] / CELL
        bx, bz = b[0] / CELL, b[2] / CELL
        cx, cz = c[0] / CELL, c[2] / CELL
        denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        if abs(denom) < 1e-12:
            continue
        for gz in range(int(math.floor(min(az, bz, cz))), int(math.ceil(max(az, bz, cz))) + 1):
            pz = gz + 0.5
            xs = []
            for (px, pzz), (qx, qzz) in (((ax, az), (bx, bz)),
                                         ((bx, bz), (cx, cz)),
                                         ((cx, cz), (ax, az))):
                if (pzz <= pz < qzz) or (qzz <= pz < pzz):
                    xs.append(px + (pz - pzz) / (qzz - pzz) * (qx - px))
            if len(xs) < 2:
                continue
            lo, hi = min(xs), max(xs)
            for gx in range(int(math.floor(lo)), int(math.ceil(hi)) + 1):
                px = gx + 0.5
                if px < lo - 0.5 or px > hi + 0.5:
                    continue
                w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / denom
                w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / denom
                w2 = 1.0 - w0 - w1
                if w0 < -0.05 or w1 < -0.05 or w2 < -0.05:
                    continue
                grid.setdefault((gx, gz), []).append(w0 * a[1] + w1 * b[1] + w2 * c[1])
    return grid


def deck_heights(grid):
    """Collapse each cell to its topmost surface.

    Every cell holds two stacked surfaces about 6 m apart - the track deck and
    the underside of the banking, which share the 'Asphalt' material. Averaging
    them flattens the banking to zero, so keep the max and drop the underside.
    """
    return {k: max(v) for k, v in grid.items()}


def cellset(g, material):
    return set(rasterise(list(g.triangles(keep=lambda m: m == material))).keys())


def occupied(cells, x, z):
    return (int(math.floor(x / CELL)), int(math.floor(z / CELL))) in cells


def height_at(deck, x, z):
    return deck.get((int(math.floor(x / CELL)), int(math.floor(z / CELL))))


# ------------------------------------------------------------------- geometry

def trace_ring(cells, cx, cz, max_r):
    """Radius of the outermost hit on each ray; None where the ring has a gap.

    Taking the outermost hit keeps us on the oval and ignores the pit-lane
    markings that sit inside it.
    """
    radii = []
    for i in range(RAYS):
        ang = 2 * math.pi * i / RAYS
        dx, dz = math.cos(ang), math.sin(ang)
        found = None
        r = 40.0
        while r < max_r:
            if occupied(cells, cx + dx * r, cz + dz * r):
                found = r
            r += 0.5
        radii.append(found)
    return radii


def fill_gaps(values):
    """Linearly interpolate None entries in a periodic sequence."""
    n = len(values)
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        raise SystemExit('ERROR: ring is completely empty')
    out = list(values)
    for i in range(n):
        if out[i] is not None:
            continue
        prev = max((k for k in known if k <= i), default=None)
        nxt = min((k for k in known if k >= i), default=None)
        if prev is None:
            prev = known[-1]
        if nxt is None:
            nxt = known[0]
        span = (nxt - prev) % n or n
        t = ((i - prev) % n) / span
        out[i] = values[prev] * (1 - t) + values[nxt] * t
    return out


def fourier_smooth(values, harmonics):
    """Low-pass a periodic signal - every track signal is smooth by nature."""
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


def resample_by_arclength(pts, count):
    """pts: closed polyline [(x, z)]. Returns `count` evenly spaced points."""
    n = len(pts)
    cum = [0.0]
    for i in range(n):
        cum.append(cum[-1] + math.dist(pts[i], pts[(i + 1) % n]))
    total = cum[-1]
    out = []
    j = 0
    for i in range(count):
        target = total * i / count
        while cum[j + 1] < target:
            j += 1
        seg = cum[j + 1] - cum[j]
        t = 0.0 if seg < 1e-9 else (target - cum[j]) / seg
        a, b = pts[j], pts[(j + 1) % n]
        out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out, total


def measure(deck, centre, cx, cz):
    """Per-station frame, banking and ribbon edges."""
    n = len(centre)
    stations = []
    for i, (x, z) in enumerate(centre):
        ax, az = centre[(i + 1) % n]
        px, pz = centre[(i - 1) % n]
        tx, tz = ax - px, az - pz
        tl = math.hypot(tx, tz) or 1.0
        tx, tz = tx / tl, tz / tl
        # Normal pointing away from the ring centre - the "high" line.
        ox, oz = -tz, tx
        if (ox * (x - cx) + oz * (z - cz)) < 0:
            ox, oz = tz, -tx

        y_mid = height_at(deck, x, z)
        if y_mid is None:
            y_mid = 0.0
        hp = height_at(deck, x + ox * 4, z + oz * 4)
        hm = height_at(deck, x - ox * 4, z - oz * 4)
        slope = ((hp - hm) / 8.0) if (hp is not None and hm is not None) else 0.0

        def edge(sign):
            """Walk out until the deck leaves the local banking plane.

            The apron alongside the ribbon is flat, so it breaks the plane as
            soon as we cross the edge.
            """
            d, last = 0.0, 0.0
            while d < MAX_HALF + 2:
                d += 0.25
                h = height_at(deck, x + ox * sign * d, z + oz * sign * d)
                if h is None or abs(h - (y_mid + slope * sign * d)) > PLANE_TOL:
                    break
                last = d
            return last

        stations.append({
            'x': x, 'z': z, 'tx': tx, 'tz': tz, 'ox': ox, 'oz': oz,
            'outW': edge(1.0), 'inW': edge(-1.0),
            'yMid': y_mid, 'slope': slope,
        })
    return stations


# ----------------------------------------------------------------------- main

def main():
    print(f'reading {SRC}')
    g = GLB(SRC)

    deck = deck_heights(rasterise(list(g.triangles(keep=lambda m: m in DECK))))
    print(f'  deck: {len(deck)} cells')

    fpts = [p for t in g.triangles(keep=lambda m: m == FINISH_LINE) for p in t]
    fx = sum(p[0] for p in fpts) / len(fpts)
    fz = sum(p[2] for p in fpts) / len(fpts)
    print(f'  finish line at ({fx:.1f}, {fz:.1f})')

    gx = [k[0] for k in deck]
    gz = [k[1] for k in deck]
    cx = (min(gx) + max(gx)) * 0.5 * CELL
    cz = (min(gz) + max(gz)) * 0.5 * CELL
    max_r = max(map(abs, gx + gz)) * CELL + 100
    print(f'  ring centre ({cx:.1f}, {cz:.1f})')

    # Centreline from the painted boundary lines, which bracket the ribbon
    # exactly - unlike the asphalt, which bleeds into the flat apron.
    outer = trace_ring(cellset(g, OUTER_LINE), cx, cz, max_r)
    inner = trace_ring(cellset(g, INNER_LINE), cx, cz, max_r)
    print(f'  outer line hit {sum(v is not None for v in outer)}/{RAYS} rays')
    print(f'  inner line hit {sum(v is not None for v in inner)}/{RAYS} rays')
    outer = fourier_smooth(fill_gaps(outer), HARMONICS)
    inner = fourier_smooth(fill_gaps(inner), HARMONICS)

    raw = []
    for i in range(RAYS):
        ang = 2 * math.pi * i / RAYS
        r = 0.5 * (outer[i] + inner[i])
        raw.append((cx + math.cos(ang) * r, cz + math.sin(ang) * r))

    centre, lap_length = resample_by_arclength(raw, STATIONS)
    stations = measure(deck, centre, cx, cz)
    print(f'  lap length {lap_length:.1f} m')

    # Smooth every per-station signal so nothing jitters under the camera.
    for key in ('yMid', 'slope'):
        for s, v in zip(stations, fourier_smooth([s[key] for s in stations], HARMONICS)):
            s[key] = v
    for key in ('outW', 'inW'):
        vals = fourier_smooth([s[key] for s in stations], HARMONICS)
        for s, v in zip(stations, vals):
            s[key] = min(MAX_HALF, max(MIN_HALF, v))

    # Direction of travel: NASCAR turns left, so the infield stays on the
    # driver's left and the outward normal sits on their right. With Y up,
    # (t x o).y = tz*ox - tx*oz, and that is negative when o is on the right
    # (e.g. t = +Z, o = -X gives -1). So a positive value means we are running
    # the oval backwards.
    s0 = stations[0]
    if (s0['tz'] * s0['ox'] - s0['tx'] * s0['oz']) > 0:
        print('  reversing direction so cars turn left')
        stations.reverse()
        for s in stations:
            s['tx'], s['tz'] = -s['tx'], -s['tz']

    # Rotate so station 0 sits on the start/finish line.
    best = min(range(STATIONS),
               key=lambda i: math.dist((stations[i]['x'], stations[i]['z']), (fx, fz)))
    stations = stations[best:] + stations[:best]
    print(f'  start/finish rotated from station {best}')

    widths = [s['outW'] + s['inW'] for s in stations]
    banks = [math.atan(s['slope']) for s in stations]
    print(f'  width  {min(widths):.1f} - {max(widths):.1f} m')
    print(f'  bank   {math.degrees(min(banks)):.1f} - {math.degrees(max(banks)):.1f} deg')
    print(f'  height {min(s["yMid"] for s in stations):.2f} - {max(s["yMid"] for s in stations):.2f} m')

    data = {
        'lapLength': round(lap_length, 3),
        'stationCount': STATIONS,
        'stationStep': round(lap_length / STATIONS, 6),
        'centre': [round(cx, 3), round(cz, 3)],
        'finishLine': [round(fx, 3), round(fz, 3)],
        # Flat arrays keep the JSON small and parse fast on a phone.
        'x': [round(s['x'], 2) for s in stations],
        'z': [round(s['z'], 2) for s in stations],
        'y': [round(s['yMid'], 3) for s in stations],
        'tx': [round(s['tx'], 5) for s in stations],
        'tz': [round(s['tz'], 5) for s in stations],
        'ox': [round(s['ox'], 5) for s in stations],
        'oz': [round(s['oz'], 5) for s in stations],
        'outW': [round(s['outW'], 2) for s in stations],
        'inW': [round(s['inW'], 2) for s in stations],
        'bank': [round(b, 5) for b in banks],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print(f'wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)')

    validate(deck, stations, banks)


def validate(deck, stations, banks):
    """Overlay the derived centreline on the asphalt raster and sanity-check."""
    gx = [k[0] for k in deck]
    gz = [k[1] for k in deck]
    x0, x1, z0, z1 = min(gx), max(gx), min(gz), max(gz)
    cols, rows = 100, 46
    sx, sz = (x1 - x0) / cols, (z1 - z0) / rows
    canvas = [[' '] * cols for _ in range(rows)]
    for (a, b) in deck:
        c, r = int((a - x0) / sx), int((b - z0) / sz)
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = '.'
    for i, s in enumerate(stations):
        c, r = int((s['x'] / CELL - x0) / sx), int((s['z'] / CELL - z0) / sz)
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = 'S' if i == 0 else '#'
    print('\ncentreline (#) over asphalt (.), S = start/finish:')
    print('\n'.join(''.join(row) for row in canvas))

    problems = []
    off = [i for i, s in enumerate(stations) if not occupied(deck, s['x'], s['z'])]
    if off:
        problems.append(f'{len(off)}/{len(stations)} stations off the asphalt: {off[:12]}')
    flat = [i for i, b in enumerate(banks) if math.degrees(b) < -1.0]
    if flat:
        problems.append(f'{len(flat)} stations bank the wrong way')
    print(f'\nstations off the asphalt: {len(off)} / {len(stations)}')
    if problems:
        raise SystemExit('ERROR: ' + '; '.join(problems))
    print('track data OK')


if __name__ == '__main__':
    main()
