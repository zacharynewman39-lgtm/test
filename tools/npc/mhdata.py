"""Loading and shaping MakeHuman (CC0) base data.

Reads the hm08 base mesh, applies modelling targets to produce a specific
man, and resolves the default skeleton's joint positions on the result.
"""
import json
import os
from functools import lru_cache

import numpy as np


class MHData:
    def __init__(self, root):
        self.root = root  # .../makehuman/data

    def path(self, *p):
        return os.path.join(self.root, *p)

    # ------------------------------------------------------------------ obj
    def load_base(self):
        V, VT, faces = [], [], []
        group = None
        for line in open(self.path('3dobjs', 'base.obj')):
            if line.startswith('v '):
                V.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                VT.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                group = line.split()[1]
            elif line.startswith('f '):
                vi, ti = [], []
                for tok in line.split()[1:]:
                    a = tok.split('/')
                    vi.append(int(a[0]) - 1)
                    ti.append(int(a[1]) - 1)
                faces.append((vi, ti, group))
        self.V0 = np.array(V, dtype=np.float64)
        self.VT = np.array(VT, dtype=np.float64)
        self.faces = faces
        return self

    def group_faces(self, pred):
        fv = np.array([f[0] for f in self.faces if pred(f[2])], dtype=np.int64)
        ft = np.array([f[1] for f in self.faces if pred(f[2])], dtype=np.int64)
        return fv, ft

    # -------------------------------------------------------------- targets
    @lru_cache(maxsize=None)
    def target(self, rel):
        idx, d = [], []
        for line in open(self.path('targets', rel)):
            if not line.strip() or line.startswith('#'):
                continue
            a = line.split()
            idx.append(int(a[0]))
            d.append([float(a[1]), float(a[2]), float(a[3])])
        return np.array(idx, dtype=np.int64), np.array(d, dtype=np.float64).reshape(-1, 3)

    def target_dense(self, rel, n=None):
        n = n or len(self.V0)
        idx, d = self.target(rel)
        out = np.zeros((n, 3))
        out[idx] = d
        return out

    # ---------------------------------------------------- macro modelling
    @staticmethod
    def _three(v):
        lo = max(0.0, 1 - v * 2)
        hi = max(0.0, (v - 0.5) * 2)
        return {'min': lo, 'average': 1 - lo - hi, 'max': hi}

    @staticmethod
    def _age(a):
        if a < 0.5:
            baby = max(0.0, 1 - a * 5.333)  # same breakpoints as MakeHuman
            young = max(0.0, (a - 0.1875) * 3.2)
            child = max(0.0, min(1.0, 5.333 * a) - young)
            return {'baby': baby, 'child': child, 'young': young, 'old': 0.0}
        return {'baby': 0.0, 'child': 0.0, 'young': 1 - (a - 0.5) * 2,
                'old': (a - 0.5) * 2}

    def macro_targets(self, gender=1.0, age=0.5, muscle=0.5, weight=0.5,
                      height=0.5, proportions=0.5, race=None):
        race = race or {'caucasian': 1.0}
        G = {'female': 1 - gender, 'male': gender}
        A = self._age(age)
        M = self._three(muscle)
        W = self._three(weight)
        H = {'minheight': max(0.0, 1 - height * 2),
             'maxheight': max(0.0, (height - 0.5) * 2)}
        P = {'uncommonproportions': max(0.0, 1 - proportions * 2),
             'idealproportions': max(0.0, (proportions - 0.5) * 2)}
        out = []
        for g, gw in G.items():
            for a, aw in A.items():
                for r, rw in race.items():
                    w = gw * aw * rw
                    if w > 1e-4:
                        out.append((f'macrodetails/{r}-{g}-{a}.target', w))
                for m, mw in M.items():
                    mm = 'averagemuscle' if m == 'average' else m + 'muscle'
                    for wt, ww in W.items():
                        wn = 'averageweight' if wt == 'average' else wt + 'weight'
                        base = gw * aw * mw * ww
                        if base < 1e-4:
                            continue
                        out.append((f'macrodetails/universal-{g}-{a}-{mm}-{wn}.target', base))
                        for h, hw in H.items():
                            if base * hw > 1e-4:
                                out.append((f'macrodetails/height/{g}-{a}-{mm}-{wn}-{h}.target', base * hw))
                        for p, pw in P.items():
                            if base * pw > 1e-4:
                                out.append((f'macrodetails/proportions/{g}-{a}-{mm}-{wn}-{p}.target', base * pw))
        return out

    def shape(self, targets):
        V = self.V0.copy()
        for rel, w in targets:
            idx, d = self.target(rel)
            if len(idx):
                V[idx] += d * w
        self.V = V
        return V

    # ------------------------------------------------------------- skeleton
    def skeleton(self, V):
        sk = json.load(open(self.path('rigs', 'default.mhskel')))
        joints = {k: V[np.array(v)].mean(0) for k, v in sk['joints'].items()}
        bones = []
        for name, b in sk['bones'].items():
            bones.append({'name': name, 'parent': b['parent'],
                          'head': joints[b['head']], 'tail': joints[b['tail']]})
        # parents before children
        order, seen = [], set()
        byname = {b['name']: b for b in bones}

        def visit(n):
            if n in seen:
                return
            p = byname[n]['parent']
            if p:
                visit(p)
            seen.add(n)
            order.append(byname[n])
        for b in bones:
            visit(b['name'])
        wfile = json.load(open(self.path('rigs', sk['weights_file'])))
        return order, wfile['weights']

    # ---------------------------------------------------------------- proxy
    def load_mhclo(self, rel):
        """Returns (refverts[n,3], weights[n,3], offsets[n,3], scales, objpath)."""
        base = os.path.dirname(self.path(rel))
        refs, ws, offs, scale = [], [], [], {}
        obj = None
        in_verts = False
        for line in open(self.path(rel)):
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            a = s.split()
            if in_verts:
                if len(a) == 9:
                    refs.append([int(x) for x in a[:3]])
                    ws.append([float(x) for x in a[3:6]])
                    offs.append([float(x) for x in a[6:9]])
                    continue
                elif len(a) == 1 and a[0].isdigit():
                    refs.append([int(a[0])] * 3)
                    ws.append([1.0, 0, 0])
                    offs.append([0.0, 0, 0])
                    continue
                in_verts = False
            if a[0] == 'obj_file':
                obj = os.path.join(base, a[1])
            elif a[0] in ('x_scale', 'y_scale', 'z_scale'):
                scale[a[0][0]] = (int(a[1]), int(a[2]), float(a[3]))
            elif a[0] == 'verts':
                in_verts = True
        return (np.array(refs), np.array(ws), np.array(offs), scale, obj)

    def fit_proxy(self, rel, V):
        refs, ws, offs, scale, obj = self.load_mhclo(rel)
        s = np.ones(3)
        for i, ax in enumerate('xyz'):
            if ax in scale:
                a, b, d = scale[ax]
                s[i] = abs(V[a, i] - V[b, i]) / d
        P = (V[refs] * ws[..., None]).sum(1) + offs * s
        return P, refs, ws, obj


def load_simple_obj(path):
    V, VT, F, FT = [], [], [], []
    for line in open(path):
        if line.startswith('v '):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('vt '):
            VT.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('f '):
            vi, ti = [], []
            for tok in line.split()[1:]:
                a = tok.split('/')
                vi.append(int(a[0]) - 1)
                ti.append(int(a[1]) - 1 if len(a) > 1 and a[1] else -1)
            F.append(vi)
            FT.append(ti)
    return np.array(V), np.array(VT), F, FT
