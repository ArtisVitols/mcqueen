#!/usr/bin/env python3
"""Survey a track GLB: scale, materials, transparency and an overhead map.

Used to work out which materials form the driveable surface before pointing
the extractor at a new circuit. Every model names things differently - one
uses "Asphalt", another exports 93 objects all called "Material.nnn" - and at
least one ships an invisible collision shell that must not be mistaken for the
road. Some are modelled at 1:20 scale.

    python3 tools/inspect_track.py raw/palm_mile_speedway.glb [material ...]
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import GLB  # noqa: E402


def invisible(mat):
    pbr = mat.get('pbrMetallicRoughness', {})
    alpha = pbr.get('baseColorFactor', [1, 1, 1, 1])[3]
    return mat.get('alphaMode') == 'BLEND' and alpha < 0.01


def rasterise(tris, cell):
    """Top-down occupancy: {(gx, gz): highest y}. Also returns flat-area stats."""
    grid = {}
    flat = 0
    for a, b, c in tris:
        # Skip near-vertical faces - walls and fences are not road.
        e1 = [b[i] - a[i] for i in range(3)]
        e2 = [c[i] - a[i] for i in range(3)]
        nx = e1[1] * e2[2] - e1[2] * e2[1]
        ny = e1[2] * e2[0] - e1[0] * e2[2]
        nz = e1[0] * e2[1] - e1[1] * e2[0]
        ln = math.sqrt(nx * nx + ny * ny + nz * nz)
        if ln < 1e-12:
            continue
        if abs(ny / ln) < 0.35:
            continue
        flat += 1
        ax, az = a[0] / cell, a[2] / cell
        bx, bz = b[0] / cell, b[2] / cell
        cx, cz = c[0] / cell, c[2] / cell
        denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
        if abs(denom) < 1e-12:
            continue
        for gz in range(int(math.floor(min(az, bz, cz))), int(math.ceil(max(az, bz, cz))) + 1):
            pz = gz + 0.5
            xs = []
            for (px, pzz), (qx, qzz) in (((ax, az), (bx, bz)), ((bx, bz), (cx, cz)),
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
                w2 = 1 - w0 - w1
                if w0 < -0.05 or w1 < -0.05 or w2 < -0.05:
                    continue
                y = w0 * a[1] + w1 * b[1] + w2 * c[1]
                k = (gx, gz)
                if k not in grid or y > grid[k]:
                    grid[k] = y
    return grid, flat


def enclosed_area(cells):
    """Area of holes fully surrounded by `cells` - a closed circuit has one.

    Flood-fills the empty space from outside the footprint's bounding box;
    anything empty it cannot reach is enclosed. This is what separates a track
    ribbon from a grandstand blob without knowing anything about materials.
    """
    if not cells:
        return 0, 0
    xs = [c[0] for c in cells]
    zs = [c[1] for c in cells]
    x0, x1 = min(xs) - 1, max(xs) + 1
    z0, z1 = min(zs) - 1, max(zs) + 1
    seen = set()
    stack = [(x0, z0)]
    while stack:
        p = stack.pop()
        if p in seen or p in cells:
            continue
        if not (x0 <= p[0] <= x1 and z0 <= p[1] <= z1):
            continue
        seen.add(p)
        stack.append((p[0] + 1, p[1]))
        stack.append((p[0] - 1, p[1]))
        stack.append((p[0], p[1] + 1))
        stack.append((p[0], p[1] - 1))
    total = (x1 - x0 + 1) * (z1 - z0 + 1)
    return total - len(seen) - len(cells), total


def ascii_map(cells, title, cell, cols=104, rows=44, bounds=None):
    if not cells:
        print(f'{title}: empty')
        return
    xs = [c[0] for c in cells]
    zs = [c[1] for c in cells]
    x0, x1, z0, z1 = bounds or (min(xs), max(xs), min(zs), max(zs))
    sx = (x1 - x0) / cols or 1
    sz = (z1 - z0) / rows or 1
    canvas = [[' '] * cols for _ in range(rows)]
    for (a, b) in cells:
        c, r = int((a - x0) / sx), int((b - z0) / sz)
        if 0 <= r < rows and 0 <= c < cols:
            canvas[r][c] = '#'
    print(f'\n{title}')
    print(f'  x {x0 * cell:.0f}..{x1 * cell:.0f}   z {z0 * cell:.0f}..{z1 * cell:.0f} m')
    print('\n'.join(''.join(r) for r in canvas))


def main():
    path = sys.argv[1]
    want = set(sys.argv[2:])
    g = GLB(path)
    mats = g.g.get('materials', [])

    lo, hi = g.bounds()
    extent = max(hi[0] - lo[0], hi[2] - lo[2])
    cell = max(0.05, extent / 500)      # ~500 cells across, whatever the scale
    print(f'{path}: {len(g.g["meshes"])} meshes, {len(mats)} materials, '
          f'{os.path.getsize(path) / 1e6:.1f} MB')
    print('world extent: ' + ' x '.join(f'{hi[i] - lo[i]:.1f}' for i in range(3)) + ' m')
    print(f'  x {lo[0]:.1f}..{hi[0]:.1f}   y {lo[1]:.1f}..{hi[1]:.1f}   z {lo[2]:.1f}..{hi[2]:.1f}')
    print(f'raster cell: {cell:.3f} m')

    print(f'\n{"material":<26}{"tris":>8}{"cells":>8}{"area m2":>10}{"encloses":>10}'
          f'{"y range":>16}  flags')
    stats = []
    for i, m in enumerate(mats):
        name = m.get('name') or f'#{i}'
        tris = list(g.triangles(keep=lambda n, x=name: n == x))
        if not tris:
            continue
        grid, flat = rasterise(tris, cell)
        flags = 'INVISIBLE' if invisible(m) else ''
        ys = list(grid.values())
        yr = f'{min(ys):.2f}..{max(ys):.2f}' if ys else '-'
        area = len(grid) * cell * cell
        hole, _ = enclosed_area(set(grid.keys()))
        hole_m2 = hole * cell * cell
        if hole_m2 > area * 0.15:
            flags = (flags + ' RING').strip()
        print(f'{name:<26}{len(tris):>8}{len(grid):>8}{area:>10.0f}{hole_m2:>10.0f}'
              f'{yr:>16}  {flags}')
        if grid:
            stats.append((name, len(grid), area, set(grid.keys()), hole_m2))

    if want:
        cells = set()
        for name, _, _, keys, _ in stats:
            if name in want:
                cells |= keys
        ascii_map(cells, 'selected: ' + ', '.join(sorted(want)), cell)
    else:
        # Rings first - a closed circuit is what we are hunting for.
        ranked = sorted(stats, key=lambda s: (-s[4], -s[2]))[:4]
        for name, n, area, keys, hole in ranked:
            ascii_map(keys, f'material "{name}"  {area:.0f} m2, encloses {hole:.0f} m2', cell)


if __name__ == '__main__':
    main()
