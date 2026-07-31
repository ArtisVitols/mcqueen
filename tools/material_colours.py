#!/usr/bin/env python3
"""Average rendered colour of every material in a GLB.

Circuits exported from Blender often name all 90-odd materials "Material.nnn",
so the road cannot be found by name. Colour works: asphalt is grey, grass is
green, sand is tan. This multiplies each material's baseColorFactor by the mean
colour of its base texture and reports hue/saturation/value so a classifier can
say "greyish and near the ground" instead of guessing at names.

    python3 tools/material_colours.py raw/motor_speedway_of_the_south.glb
"""
import colorsys
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import GLB  # noqa: E402

from PIL import Image  # noqa: E402


def texture_mean(g, mat):
    pbr = mat.get('pbrMetallicRoughness', {})
    tex = pbr.get('baseColorTexture')
    if not tex:
        return (1.0, 1.0, 1.0)
    try:
        src = g.g['textures'][tex['index']].get('source')
        if src is None:
            return (1.0, 1.0, 1.0)
        img = Image.open(io.BytesIO(g.image_bytes(src))).convert('RGB')
        img.thumbnail((48, 48))
        px = list(img.getdata())
        n = len(px)
        return tuple(sum(p[i] for p in px) / n / 255 for i in range(3))
    except Exception:
        return (1.0, 1.0, 1.0)


def material_colour(g, mat):
    """Linear-ish base colour x mean texture colour, as 0..1 RGB."""
    pbr = mat.get('pbrMetallicRoughness', {})
    base = pbr.get('baseColorFactor', [1, 1, 1, 1])[:3]
    tex = texture_mean(g, mat)
    return tuple(base[i] * tex[i] for i in range(3))


def classify(rgb):
    h, s, v = colorsys.rgb_to_hsv(*rgb)
    hue = h * 360
    if v < 0.035:
        return 'dark'
    if s < 0.20:
        return 'grey'          # asphalt, concrete, white lines
    if 60 <= hue <= 175:
        return 'green'         # grass
    if 20 <= hue < 60 and s >= 0.20:
        return 'tan'           # sand, dirt
    return 'other'


def main():
    g = GLB(sys.argv[1])
    print(f'{"material":<24}{"rgb":<22}{"hue":>6}{"sat":>6}{"val":>6}  class')
    for i, m in enumerate(g.g.get('materials', [])):
        name = m.get('name') or f'#{i}'
        rgb = material_colour(g, m)
        h, s, v = colorsys.rgb_to_hsv(*rgb)
        swatch = '#%02x%02x%02x' % tuple(int(c * 255) for c in rgb)
        print(f'{name:<24}{swatch:<22}{h * 360:>6.0f}{s:>6.2f}{v:>6.2f}  {classify(rgb)}')


if __name__ == '__main__':
    main()
