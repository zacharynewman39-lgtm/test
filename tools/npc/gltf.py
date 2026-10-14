"""Minimal GLB writer supporting skinned meshes with morph targets."""
import json
import struct

import numpy as np

FLOAT, USHORT, UINT, UBYTE = 5126, 5123, 5125, 5121


class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accessors = [], []
        self.nodes, self.meshes, self.skins, self.materials = [], [], [], []
        self.scene_nodes = []
        self._mat_index = {}
        self.extensions_used = set()

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, arr, ctype=FLOAT, kind=None, target=None, minmax=False,
                 normalized=False):
        arr = np.ascontiguousarray(arr)
        dt = {FLOAT: np.float32, USHORT: np.uint16, UINT: np.uint32,
              UBYTE: np.uint8}[ctype]
        arr = arr.astype(dt)
        if kind is None:
            kind = {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4'}[
                1 if arr.ndim == 1 else arr.shape[1]]
        a = {'bufferView': self._view(arr.tobytes(), target), 'componentType': ctype,
             'count': int(arr.shape[0]), 'type': kind}
        if normalized:
            a['normalized'] = True
        if minmax:
            a['min'] = arr.min(0).astype(float).tolist()
            a['max'] = arr.max(0).astype(float).tolist()
        self.accessors.append(a)
        return len(self.accessors) - 1

    def sparse(self, arr, minmax=False):
        """Morph deltas are mostly zero: store them as a sparse accessor."""
        arr = np.asarray(arr, np.float32)
        nz = np.nonzero(np.abs(arr).max(1) > 1e-6)[0]
        if len(nz) > len(arr) * 0.4:
            return self.accessor(arr, minmax=minmax)
        if len(nz) == 0:
            nz = np.array([0])
        a = {'componentType': FLOAT, 'count': int(len(arr)), 'type': 'VEC3',
             'sparse': {'count': int(len(nz)),
                        'indices': {'bufferView': self._view(nz.astype(np.uint32).tobytes()),
                                    'componentType': UINT},
                        'values': {'bufferView': self._view(arr[nz].tobytes())}}}
        if minmax:
            a['min'] = arr.min(0).astype(float).tolist()
            a['max'] = arr.max(0).astype(float).tolist()
        self.accessors.append(a)
        return len(self.accessors) - 1

    def accessor_packed_normals(self, N):
        """int8 normals padded to 4 bytes (KHR_mesh_quantization)."""
        q = np.zeros((len(N), 4), np.int8)
        q[:, :3] = np.round(np.clip(N, -1, 1) * 127)
        v = self._view(q.tobytes(), 34962)
        self.views[v]['byteStride'] = 4
        self.accessors.append({'bufferView': v, 'componentType': 5120, 'count': len(N),
                               'type': 'VEC3', 'normalized': True})
        self.extensions_used.add('KHR_mesh_quantization')
        return len(self.accessors) - 1

    def material(self, name, color=(0.8, 0.8, 0.8, 1.0)):
        if name not in self._mat_index:
            self.materials.append({'name': name, 'pbrMetallicRoughness': {
                'baseColorFactor': list(color), 'metallicFactor': 0.0,
                'roughnessFactor': 0.6}})
            self._mat_index[name] = len(self.materials) - 1
        return self._mat_index[name]

    def add_node(self, node):
        self.nodes.append(node)
        return len(self.nodes) - 1

    def add_skeleton(self, bones):
        """bones: list of dicts with name, parent, head (world). Rest rotations
        are identity so local translation is head - parent head."""
        idx = {}
        for b in bones:
            p = b['parent']
            t = b['head'] - (bones[idx[p]]['head'] if p else 0)
            n = {'name': b['name'], 'translation': [float(x) for x in t]}
            idx[b['name']] = self.add_node(n)
        for b in bones:
            if b['parent']:
                pn = self.nodes[idx[b['parent']]]
                pn.setdefault('children', []).append(idx[b['name']])
        joints = [idx[b['name']] for b in bones]
        ibm = np.zeros((len(bones), 16), np.float32)
        for i, b in enumerate(bones):
            m = np.identity(4)
            m[:3, 3] = -b['head']
            ibm[i] = m.T.reshape(-1)  # column-major
        self.skins.append({'joints': joints, 'skeleton': joints[0],
                           'inverseBindMatrices': self.accessor(ibm, kind='MAT4')})
        self.root_bone = joints[0]
        return idx

    def add_mesh(self, name, prims, skin=True):
        """prims: list of dicts: material, pos, nrm, uv?, color?, joints?,
        weights?, idx, morphs? {name: (dpos, dnrm)}, tangent?"""
        out, target_names = [], None
        for p in prims:
            attr = {'POSITION': self.accessor(p['pos'], minmax=True, target=34962),
                    'NORMAL': self.accessor(p['nrm'], target=34962)}
            if p.get('uv') is not None:
                attr['TEXCOORD_0'] = self.accessor(p['uv'], target=34962)
            if p.get('uv2') is not None:
                attr['TEXCOORD_1'] = self.accessor(p['uv2'], target=34962)
            if p.get('color') is not None:
                attr['COLOR_0'] = self.accessor(p['color'], target=34962)
            if p.get('tangent') is not None:
                attr['TANGENT'] = self.accessor(p['tangent'], target=34962)
            if skin:
                attr['JOINTS_0'] = self.accessor(p['joints'], USHORT, target=34962)
                attr['WEIGHTS_0'] = self.accessor(p['weights'], target=34962)
            prim = {'attributes': attr,
                    'indices': self.accessor(p['idx'].reshape(-1), UINT, target=34963),
                    'material': self.material(p['material'])}
            if p.get('morphs'):
                names = list(p['morphs'].keys())
                target_names = names
                prim['targets'] = []
                for n in names:
                    dp, dn = p['morphs'][n]
                    t = {'POSITION': self.sparse(dp, minmax=True)}
                    if dn is not None:
                        t['NORMAL'] = self.sparse(dn)
                    prim['targets'].append(t)
            out.append(prim)
        mesh = {'name': name, 'primitives': out}
        if target_names:
            mesh['extras'] = {'targetNames': target_names}
            mesh['weights'] = [0.0] * len(target_names)
        self.meshes.append(mesh)
        node = {'name': name, 'mesh': len(self.meshes) - 1}
        if skin:
            node['skin'] = 0
        return self.add_node(node)

    def add_mesh_shared(self, name, src_node, idx, material, skin=True):
        """Another mesh reusing src mesh's vertex attributes/targets with its own triangles."""
        src = self.meshes[self.nodes[src_node]['mesh']]
        sp = src['primitives'][0]
        prim = {'attributes': dict(sp['attributes']),
                'indices': self.accessor(idx.reshape(-1), UINT, target=34963),
                'material': self.material(material)}
        if 'targets' in sp:
            prim['targets'] = sp['targets']
        mesh = {'name': name, 'primitives': [prim]}
        if 'extras' in src:
            mesh['extras'] = src['extras']
            mesh['weights'] = list(src['weights'])
        self.meshes.append(mesh)
        node = {'name': name, 'mesh': len(self.meshes) - 1}
        if skin:
            node['skin'] = 0
        return self.add_node(node)

    def write(self, path, root_name='NPC', root_children=()):
        root = self.add_node({'name': root_name,
                              'children': [self.root_bone] + list(root_children)})
        doc = {
            'asset': {'version': '2.0', 'generator': 'npc-build'},
            'scene': 0, 'scenes': [{'nodes': [root]}],
            'nodes': self.nodes, 'meshes': self.meshes, 'skins': self.skins,
            'materials': self.materials, 'accessors': self.accessors,
            'bufferViews': self.views, 'buffers': [{'byteLength': len(self.bin)}],
        }
        if self.extensions_used:
            doc['extensionsUsed'] = sorted(self.extensions_used)
            doc['extensionsRequired'] = sorted(self.extensions_used)
        js = json.dumps(doc, separators=(',', ':')).encode()
        while len(js) % 4:
            js += b' '
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942))
            f.write(self.bin)
