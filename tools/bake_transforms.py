#!/usr/bin/env python3
"""Bake node transforms into vertex data, producing a world-space GLB.

The Sketchfab speedway stores its geometry in a local space spanning about
+/-3,000,000 units, scaled down to ~660 m by the node hierarchy. Any quantising
compressor then lays its grid over those millions of units and destroys the
model: meshopt at the default 14 bits flattened the banked asphalt onto the
apron and left the cars floating a metre in the air.

Baking the transforms first makes local coordinates equal world metres, so
quantisation grids are sane and every downstream tool behaves. It also drops
the node hierarchy to one flat node per mesh.

    python3 tools/bake_transforms.py raw/speedway.glb build/speedway_baked.glb
"""
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb import GLB  # noqa: E402


def inverse_transpose3(m):
    """Inverse-transpose of the upper 3x3, for transforming normals."""
    a = [[m[i][j] for j in range(3)] for i in range(3)]
    det = (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
           - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
           + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    if abs(det) < 1e-20:
        return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    inv = [[0.0] * 3 for _ in range(3)]
    for i in range(3):
        for j in range(3):
            r = [[a[x][y] for y in range(3) if y != j] for x in range(3) if x != i]
            cof = r[0][0] * r[1][1] - r[0][1] * r[1][0]
            inv[i][j] = ((-1) ** (i + j)) * cof / det
    # inv is already the transpose of the adjugate/det arrangement above, which
    # is what a normal matrix needs.
    return inv


def xform_point(m, p):
    return (
        p[0] * m[0][0] + p[1] * m[1][0] + p[2] * m[2][0] + m[3][0],
        p[0] * m[0][1] + p[1] * m[1][1] + p[2] * m[2][1] + m[3][1],
        p[0] * m[0][2] + p[1] * m[1][2] + p[2] * m[2][2] + m[3][2],
    )


def xform_dir(n3, v):
    x = v[0] * n3[0][0] + v[1] * n3[1][0] + v[2] * n3[2][0]
    y = v[0] * n3[0][1] + v[1] * n3[1][1] + v[2] * n3[2][1]
    z = v[0] * n3[0][2] + v[1] * n3[1][2] + v[2] * n3[2][2]
    ln = math.sqrt(x * x + y * y + z * z) or 1.0
    return (x / ln, y / ln, z / ln)


def main(src, dst):
    g = GLB(src)
    doc = g.g

    out_json = {
        'asset': doc.get('asset', {'version': '2.0'}),
        'scene': 0,
        'scenes': [{'nodes': []}],
        'nodes': [],
        'meshes': [],
        'materials': doc.get('materials', []),
        'accessors': [],
        'bufferViews': [],
        'buffers': [],
    }
    for key in ('textures', 'samplers', 'images', 'extensionsUsed', 'extensionsRequired'):
        if key in doc:
            out_json[key] = json.loads(json.dumps(doc[key]))

    blob = bytearray()

    def add_view(data, target=None, stride=None):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(data)
        view = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            view['target'] = target
        if stride:
            view['byteStride'] = stride
        out_json['bufferViews'].append(view)
        return len(out_json['bufferViews']) - 1

    def add_accessor(values, ncomp, ctype, target, normalized=False):
        fmt = {5126: 'f', 5125: 'I', 5123: 'H'}[ctype]
        flat = []
        for v in values:
            if ncomp == 1:
                flat.append(v)
            else:
                flat.extend(v)
        data = struct.pack('<' + fmt * len(flat), *flat)
        view = add_view(data, target)
        acc = {
            'bufferView': view,
            'componentType': ctype,
            'count': len(values),
            'type': {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4'}[ncomp],
        }
        if ctype == 5126 and ncomp == 3:
            acc['min'] = [min(v[i] for v in values) for i in range(3)]
            acc['max'] = [max(v[i] for v in values) for i in range(3)]
        if normalized:
            acc['normalized'] = True
        out_json['accessors'].append(acc)
        return len(out_json['accessors']) - 1

    # Re-emit image bufferViews unchanged.
    if 'images' in out_json:
        for im in out_json['images']:
            if 'bufferView' in im:
                src_view = doc['bufferViews'][im['bufferView']]
                o = src_view.get('byteOffset', 0)
                im['bufferView'] = add_view(g.bin[o:o + src_view['byteLength']])

    total_tris = 0
    for node, world in g.walk():
        if 'mesh' not in node:
            continue
        n3 = inverse_transpose3(world)
        src_mesh = doc['meshes'][node['mesh']]
        prims = []
        for prim in src_mesh['primitives']:
            attrs = prim['attributes']
            pos = [xform_point(world, p) for p in g.read(attrs['POSITION'])]
            new_attrs = {'POSITION': add_accessor(pos, 3, 5126, 34962)}

            if 'NORMAL' in attrs:
                nrm = [xform_dir(n3, v) for v in g.read(attrs['NORMAL'])]
                new_attrs['NORMAL'] = add_accessor(nrm, 3, 5126, 34962)
            if 'TEXCOORD_0' in attrs:
                uv = g.read(attrs['TEXCOORD_0'])
                new_attrs['TEXCOORD_0'] = add_accessor(uv, 2, 5126, 34962)
            if 'TANGENT' in attrs:
                tan = []
                for v in g.read(attrs['TANGENT']):
                    d = xform_dir(n3, v[:3])
                    tan.append((d[0], d[1], d[2], v[3]))
                new_attrs['TANGENT'] = add_accessor(tan, 4, 5126, 34962)

            new_prim = {'attributes': new_attrs}
            if 'material' in prim:
                new_prim['material'] = prim['material']
            if 'indices' in prim:
                idx = list(g.read(prim['indices']))
                ctype = 5123 if len(pos) <= 65535 else 5125
                new_prim['indices'] = add_accessor(idx, 1, ctype, 34963)
                total_tris += len(idx) // 3
            else:
                total_tris += len(pos) // 3
            prims.append(new_prim)

        out_json['meshes'].append({'name': src_mesh.get('name'), 'primitives': prims})
        out_json['nodes'].append({
            'name': node.get('name'),
            'mesh': len(out_json['meshes']) - 1,
        })
        out_json['scenes'][0]['nodes'].append(len(out_json['nodes']) - 1)

    out_json['buffers'] = [{'byteLength': len(blob)}]

    js = json.dumps(out_json, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    while len(blob) % 4:
        blob.append(0)

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))

    lo = [min(a['min'][i] for a in out_json['accessors'] if 'min' in a and len(a['min']) == 3)
          for i in range(3)]
    hi = [max(a['max'][i] for a in out_json['accessors'] if 'max' in a and len(a['max']) == 3)
          for i in range(3)]
    print(f'{dst}: {len(out_json["meshes"])} meshes, {total_tris} tris, '
          f'{os.path.getsize(dst) / 1e6:.1f} MB')
    print('  world-space extent: ' +
          ' x '.join(f'{hi[i] - lo[i]:.1f}' for i in range(3)) + ' m')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
