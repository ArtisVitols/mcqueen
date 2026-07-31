"""Minimal stdlib-only GLB reader.

Just enough to walk the node hierarchy and pull world-space triangles out of a
.glb, which is all the asset pipeline needs. No external dependencies so the
pipeline runs anywhere python3 does.
"""
import json
import struct

COMPONENT = {
    5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2),
    5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4),
}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

IDENTITY = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))


class GLB:
    def __init__(self, path):
        data = open(path, 'rb').read()
        assert data[:4] == b'glTF', f'{path} is not a GLB'
        self.json = None
        self.bin = b''
        off = 12
        while off < len(data):
            length, kind = struct.unpack_from('<II', data, off)
            off += 8
            if kind == 0x4E4F534A:
                self.json = json.loads(data[off:off + length])
            elif kind == 0x004E4942:
                self.bin = data[off:off + length]
            off += length
        self.g = self.json

    # -- accessors ---------------------------------------------------------
    def read(self, index):
        """Return an accessor's values as a list of tuples (or scalars)."""
        a = self.g['accessors'][index]
        fmt, size = COMPONENT[a['componentType']]
        n = NCOMP[a['type']]
        if 'bufferView' not in a:
            return [(0,) * n] * a['count']
        bv = self.g['bufferViews'][a['bufferView']]
        stride = bv.get('byteStride') or size * n
        base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        pattern = '<' + fmt * n
        out = []
        for i in range(a['count']):
            v = struct.unpack_from(pattern, self.bin, base + i * stride)
            out.append(v[0] if n == 1 else v)
        return out

    def image_bytes(self, index):
        im = self.g['images'][index]
        bv = self.g['bufferViews'][im['bufferView']]
        o = bv.get('byteOffset', 0)
        return self.bin[o:o + bv['byteLength']]

    # -- hierarchy ---------------------------------------------------------
    @staticmethod
    def local_matrix(node):
        if 'matrix' in node:
            m = node['matrix']
            return (tuple(m[0:4]), tuple(m[4:8]), tuple(m[8:12]), tuple(m[12:16]))
        t = node.get('translation', [0, 0, 0])
        x, y, z, w = node.get('rotation', [0, 0, 0, 1])
        s = node.get('scale', [1, 1, 1])
        r = [
            [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0],
            [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0],
            [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1],
        ]
        for i in range(3):
            for k in range(3):
                r[i][k] *= s[i]
        r[3] = [t[0], t[1], t[2], 1]
        return tuple(tuple(row) for row in r)

    @staticmethod
    def mul(a, b):
        """Row-vector convention: point * a * b."""
        return tuple(
            tuple(sum(a[i][k] * b[k][c] for k in range(4)) for c in range(4))
            for i in range(4)
        )

    @staticmethod
    def apply(m, p):
        return (
            p[0] * m[0][0] + p[1] * m[1][0] + p[2] * m[2][0] + m[3][0],
            p[0] * m[0][1] + p[1] * m[1][1] + p[2] * m[2][1] + m[3][1],
            p[0] * m[0][2] + p[1] * m[1][2] + p[2] * m[2][2] + m[3][2],
        )

    def walk(self):
        """Yield (node, world_matrix) for every node in the default scene."""
        scene = self.g['scenes'][self.g.get('scene', 0)]

        def rec(idx, parent):
            node = self.g['nodes'][idx]
            world = self.mul(self.local_matrix(node), parent)
            yield node, world
            for child in node.get('children', []):
                yield from rec(child, world)

        for root in scene['nodes']:
            yield from rec(root, IDENTITY)

    def material_name(self, prim):
        if 'material' not in prim:
            return None
        return self.g['materials'][prim['material']].get('name')

    def triangles(self, keep=None):
        """Yield world-space (p0, p1, p2) triangles.

        keep: optional predicate on the material name.
        """
        for node, world in self.walk():
            if 'mesh' not in node:
                continue
            for prim in self.g['meshes'][node['mesh']]['primitives']:
                if keep is not None and not keep(self.material_name(prim)):
                    continue
                if prim.get('mode', 4) != 4:
                    continue
                pos = [self.apply(world, p) for p in self.read(prim['attributes']['POSITION'])]
                if 'indices' in prim:
                    idx = self.read(prim['indices'])
                else:
                    idx = range(len(pos))
                idx = list(idx)
                for i in range(0, len(idx) - 2, 3):
                    yield pos[idx[i]], pos[idx[i + 1]], pos[idx[i + 2]]

    def bounds(self):
        lo = [1e30] * 3
        hi = [-1e30] * 3
        for node, world in self.walk():
            if 'mesh' not in node:
                continue
            for prim in self.g['meshes'][node['mesh']]['primitives']:
                a = self.g['accessors'][prim['attributes']['POSITION']]
                if 'min' not in a:
                    continue
                mn, mx = a['min'], a['max']
                for cx in (mn[0], mx[0]):
                    for cy in (mn[1], mx[1]):
                        for cz in (mn[2], mx[2]):
                            w = self.apply(world, (cx, cy, cz))
                            for i in range(3):
                                lo[i] = min(lo[i], w[i])
                                hi[i] = max(hi[i], w[i])
        return lo, hi
