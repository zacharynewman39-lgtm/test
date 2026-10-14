"""Reader for BodyParts3D 4.0 (CC BY 4.0, DBCLS) as packed by the
human-atlas project: atlas.json manifest + body-N.bin chunks holding
float32 positions (m, Y-up), int16 normals and uint32 triangle indices."""
import json
import os

import numpy as np


class BP3D:
    def __init__(self, models_dir):
        self.dir = models_dir
        self.manifest = json.load(open(os.path.join(models_dir, 'atlas.json')))
        self.parts = self.manifest['parts']
        self._chunks = {}

    def _chunk(self, i):
        if i not in self._chunks:
            url = self.manifest['chunks'][i]['url']
            self._chunks[i] = open(os.path.join(self.dir, os.path.basename(url)), 'rb').read()
        return self._chunks[i]

    def mesh(self, part):
        b = self._chunk(part['chunk'])
        n, m = part['vertexCount'], part['indexCount']
        P = np.frombuffer(b, np.float32, n * 3, part['positions']).reshape(-1, 3).astype(np.float64)
        F = np.frombuffer(b, np.uint32, m, part['indices']).reshape(-1, 3).astype(np.int64)
        return P, F

    def find(self, name):
        return [p for p in self.parts if p['name'] == name]

    def first(self, name):
        r = self.find(name)
        if not r:
            raise KeyError(name)
        return r[0]
