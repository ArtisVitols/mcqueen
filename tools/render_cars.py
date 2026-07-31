#!/usr/bin/env python3
"""Software-render each car to a PNG contact sheet.

Used to work out each model's forward axis and upright orientation without a
browser. Orthographic projection with a z-buffer and flat shading is plenty to
recognise which way a car is pointing.

Writes ~/mcqueen-shots/cars_<view>.png
"""
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import GLB  # noqa: E402

from PIL import Image, ImageDraw  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARS = ['lightning_mcqueen', 'chick_hicks', 'the_king', 'francesco_bernoulli',
        'jackson_storm', 'mater', 'doc_hudson']
OUTDIR = os.path.expanduser('~/mcqueen-shots')
TILE = 480


def mesh_triangles(g):
    """World-space triangles. Skinned meshes ignore their node transform."""
    out = []
    for node, world in g.walk():
        if 'mesh' not in node:
            continue
        skinned = 'skin' in node
        for prim in g.g['meshes'][node['mesh']]['primitives']:
            if prim.get('mode', 4) != 4:
                continue
            pos = g.read(prim['attributes']['POSITION'])
            if not skinned:
                pos = [g.apply(world, p) for p in pos]
            idx = g.read(prim['indices']) if 'indices' in prim else list(range(len(pos)))
            for i in range(0, len(idx) - 2, 3):
                out.append((pos[idx[i]], pos[idx[i + 1]], pos[idx[i + 2]]))
    return out


def render(tris, size, axes, flip=(1, 1)):
    """Orthographic render. axes = (horizontal_axis, vertical_axis, depth_axis)."""
    ha, va, da = axes
    img = Image.new('RGB', (size, size), (24, 26, 32))
    px = img.load()
    zbuf = [[-1e30] * size for _ in range(size)]

    lo = [min(min(t[k][i] for k in range(3)) for t in tris) for i in range(3)]
    hi = [max(max(t[k][i] for k in range(3)) for t in tris) for i in range(3)]
    span = max(hi[ha] - lo[ha], hi[va] - lo[va]) or 1.0
    scale = (size * 0.82) / span
    cx = (lo[ha] + hi[ha]) / 2
    cy = (lo[va] + hi[va]) / 2

    def project(p):
        x = (p[ha] - cx) * scale * flip[0] + size / 2
        y = size / 2 - (p[va] - cy) * scale * flip[1]
        return x, y, p[da]

    for t in tris:
        a, b, c = (project(p) for p in t)
        # Face normal in screen space for cheap shading.
        ux, uy = b[0] - a[0], b[1] - a[1]
        vx, vy = c[0] - a[0], c[1] - a[1]
        area = ux * vy - uy * vx
        if abs(area) < 1e-9:
            continue
        # World normal for lighting.
        e1 = [t[1][i] - t[0][i] for i in range(3)]
        e2 = [t[2][i] - t[0][i] for i in range(3)]
        n = [e1[1] * e2[2] - e1[2] * e2[1],
             e1[2] * e2[0] - e1[0] * e2[2],
             e1[0] * e2[1] - e1[1] * e2[0]]
        nl = math.sqrt(sum(v * v for v in n)) or 1.0
        n = [v / nl for v in n]
        lam = max(0.15, abs(n[0] * 0.35 + n[1] * 0.85 + n[2] * 0.38))
        shade = (int(70 + 170 * lam), int(75 + 165 * lam), int(85 + 160 * lam))

        x0 = max(0, int(min(a[0], b[0], c[0])))
        x1 = min(size - 1, int(max(a[0], b[0], c[0])) + 1)
        y0 = max(0, int(min(a[1], b[1], c[1])))
        y1 = min(size - 1, int(max(a[1], b[1], c[1])) + 1)
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                w0 = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / area
                w1 = ((c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0])) / area
                w2 = 1 - w0 - w1
                if w0 < 0 or w1 < 0 or w2 < 0:
                    continue
                z = a[2] * w1 + b[2] * w2 + c[2] * w0
                if z > zbuf[y][x]:
                    zbuf[y][x] = z
                    px[x, y] = shade
    return img


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    # (name, axes(h, v, depth), flip) - X=0, Y=1, Z=2
    views = {
        'side_from_+X': ((2, 1, 0), (1, 1)),   # looking down -X: +Z to the right
        'top_from_+Y': ((2, 0, 1), (1, 1)),    # looking down: +Z right, +X up
    }
    info = []
    for vname, (axes, flip) in views.items():
        cols = 4
        rows = (len(CARS) + cols - 1) // cols
        sheet = Image.new('RGB', (TILE * cols, (TILE + 26) * rows), (14, 15, 18))
        draw = ImageDraw.Draw(sheet)
        for i, car in enumerate(CARS):
            # Read the raw models: the shipped ones are meshopt-compressed and
            # the orientation we are checking is identical either way.
            g = GLB(os.path.join(ROOT, 'raw', f'{car}.glb'))
            tris = mesh_triangles(g)
            lo = [min(min(t[k][j] for k in range(3)) for t in tris) for j in range(3)]
            hi = [max(max(t[k][j] for k in range(3)) for t in tris) for j in range(3)]
            if vname.startswith('side'):
                info.append((car, len(tris), [round(hi[j] - lo[j], 2) for j in range(3)],
                             [round(lo[j], 2) for j in range(3)]))
            ox, oy = (i % cols) * TILE, (i // cols) * (TILE + 26)
            sheet.paste(render(tris, TILE, axes, flip), (ox, oy + 26))
            draw.text((ox + 6, 8 + oy), car.replace('_', ' '), fill=(230, 230, 240))
            # Arrow along +Z (drawn to the right in both views).
            ay = oy + TILE + 14
            draw.line([(ox + TILE - 90, ay), (ox + TILE - 20, ay)], fill=(120, 220, 255), width=3)
            draw.polygon([(ox + TILE - 20, ay), (ox + TILE - 33, ay - 6),
                          (ox + TILE - 33, ay + 6)], fill=(120, 220, 255))
            draw.text((ox + TILE - 120, ay - 7), '+Z', fill=(120, 220, 255))
        path = os.path.join(OUTDIR, f'cars_{vname}.png')
        sheet.save(path)
        print('wrote', path)

    print(f'\n{"car":<22}{"tris":>7}  size(X,Y,Z)              min(X,Y,Z)')
    for car, n, size, lo in info:
        print(f'{car:<22}{n:>7}  {str(size):<24} {lo}')


if __name__ == '__main__':
    main()
