"""Build the detailed NPC man as public/npc/npc.glb.

Usage:  python3 tools/npc/build_npc.py --mh /path/to/makehuman/data

The anatomy comes from MakeHuman's CC0 base mesh, targets, skeleton and
eye proxy. Everything else (subdivision, hair grooming, eyelashes,
eyebrows, clothing, morph set, export) is done here.
"""
import argparse
import os
import time

import numpy as np
from scipy.spatial import cKDTree

import geom
from gltf import GLB
from mhdata import MHData, load_simple_obj

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DEFAULT = os.path.join(HERE, '..', '..', 'public', 'npc')

HEIGHT_M = 1.81

# Character: a ~38 year old man, fit, slightly rugged.
MACRO = dict(gender=1.0, age=0.6, muscle=0.62, weight=0.55, height=0.62,
             proportions=0.6)
FACE = [
    ('head/head-square.target', 0.35),
    ('head/head-age-incr.target', 0.3),
    ('chin/chin-width-incr.target', 0.3),
    ('chin/chin-prominent-incr.target', 0.2),
    ('chin/chin-bones-incr.target', 0.35),
    ('chin/chin-cleft-incr.target', 0.15),
    ('nose/nose-hump-incr.target', 0.3),
    ('nose/nose-point-width-incr.target', 0.15),
    ('nose/nose-scale-vert-incr.target', 0.15),
    ('nose/nose-volume-incr.target', 0.1),
    ('eyebrows/eyebrows-trans-down.target', 0.1),
    ('eyebrows/eyebrows-angle-down.target', 0.15),
    ('eyes/l-eye-bag-incr.target', 0.15),
    ('eyes/r-eye-bag-incr.target', 0.15),
    ('cheek/l-cheek-bones-incr.target', 0.25),
    ('cheek/r-cheek-bones-incr.target', 0.25),
    ('cheek/l-cheek-volume-decr.target', 0.2),
    ('cheek/r-cheek-volume-decr.target', 0.2),
    ('mouth/mouth-laugh-lines-in.target', 0.35),
    ('mouth/mouth-lowerlip-volume-incr.target', 0.15),
    ('mouth/mouth-upperlip-volume-decr.target', 0.1),
    ('mouth/mouth-scale-horiz-incr.target', 0.1),
    ('neck/neck-scale-horiz-incr.target', 0.35),
    ('neck/neck-scale-depth-incr.target', 0.2),
    ('torso/torso-vshape-incr.target', 0.3),
    ('torso/torso-muscle-pectoral-incr.target', 0.2),
    ('forehead/forehead-temple-decr.target', 0.15),
]
EXPR = 'expression/units/caucasian/'
MORPHS = {
    'blinkL': [('eye-left-closure', 1.0)],
    'blinkR': [('eye-right-closure', 1.0)],
    'squint': [('eye-left-slit', 0.6), ('eye-right-slit', 0.6)],
    'eyesWide': [('eye-left-opened-up', 1.0), ('eye-right-opened-up', 1.0)],
    'smile': [('mouth-corner-puller', 1.0)],
    'browsUp': [('eyebrows-left-up', 1.0), ('eyebrows-right-up', 1.0)],
    'browsInner': [('eyebrows-left-inner-up', 1.0), ('eyebrows-right-inner-up', 1.0)],
    'browsDown': [('eyebrows-left-down', 1.0), ('eyebrows-right-down', 1.0)],
    'jawOpen': [('mouth-open', 1.0)],
    'mouthPress': [('mouth-compression', 1.0)],
    'nostrils': [('nose-left-dilatation', 1.0), ('nose-right-dilatation', 1.0)],
}


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


def top4(W):
    """Dense (n, nb) weights -> (joints uint16 (n,4), weights float (n,4))."""
    idx = np.argsort(-W, axis=1)[:, :4]
    w = np.take_along_axis(W, idx, axis=1)
    w = np.maximum(w, 0)
    s = w.sum(1, keepdims=True)
    w = np.where(s > 0, w / np.maximum(s, 1e-9), np.array([[1, 0, 0, 0]]))
    return idx.astype(np.uint16), w.astype(np.float32)


class Attacher:
    """Binds arbitrary points to a reference vertex set (weights + morphs)."""

    def __init__(self, P, W, morphs, k=4):
        self.tree = cKDTree(P)
        self.P, self.W, self.morphs, self.k = P, W, morphs, k

    def bind(self, Q):
        d, i = self.tree.query(Q, k=self.k)
        w = 1.0 / np.maximum(d, 1e-5) ** 2
        w /= w.sum(1, keepdims=True)
        W = (self.W[i] * w[..., None]).sum(1)
        M = {n: (D[i] * w[..., None]).sum(1) for n, D in self.morphs.items()}
        return W, M


def morph_normals(P, tris, N0, morphs):
    out = {}
    for n, D in morphs.items():
        N1 = geom.vertex_normals(P + D, tris)
        out[n] = (D, N1 - N0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mh', default=os.environ.get('MH'), required=False)
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--hair', type=int, default=60000)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    mh = MHData(args.mh).load_base()
    log('shaping')
    Vdm = mh.shape(mh.macro_targets(**MACRO) + FACE)
    body_fv, body_ft = mh.group_faces(lambda g: g == 'body')
    bverts = np.unique(body_fv)
    ymin, ymax = Vdm[bverts, 1].min(), Vdm[bverts, 1].max()
    s = HEIGHT_M / (ymax - ymin)
    off = np.array([0.0, -ymin, 0.0])

    def to_m(x):
        return (x + off) * s

    V = to_m(Vdm)
    nV = len(V)

    # expression deltas (dense, base vertex space, meters)
    D = {}
    for name, parts in MORPHS.items():
        d = np.zeros((nV, 3))
        for t, w in parts:
            d += mh.target_dense(EXPR + t + '.target') * w * s
        D[name] = d

    # skeleton
    bones, wdict = mh.skeleton(Vdm)
    for b in bones:
        b['head'] = to_m(b['head'])
        b['tail'] = to_m(b['tail'])
    bidx = {b['name']: i for i, b in enumerate(bones)}
    nb = len(bones)
    W = np.zeros((nV, nb))
    for bn, lst in wdict.items():
        if bn not in bidx:
            continue
        a = np.array(lst)
        W[a[:, 0].astype(int), bidx[bn]] = a[:, 1]

    # eyes: fit high poly proxy, recentre eye bones on eyeball centres
    EP, _, _, eobj = mh.fit_proxy('eyes/high-poly/high-poly.mhclo', Vdm)
    EP = to_m(EP)
    _, EVT, EF, EFT = load_simple_obj(eobj)
    EF = np.array(EF)
    EFT = np.array(EFT)
    left = EP[:, 0] > 0
    eye_info = {}
    for side, m in (('L', left), ('R', ~left)):
        c = EP[m].mean(0)
        r = np.linalg.norm(EP[m] - c, axis=1).max()
        bones[bidx['eye.' + side]]['head'] = c
        eye_info[side] = (c, r)

    glb = GLB()
    glb.add_skeleton(bones)
    meshes = []
    export = {}

    # ------------------------------------------------------------- body
    log('subdividing body')
    loc = np.full(nV, -1)
    loc[bverts] = np.arange(len(bverts))
    q = loc[body_fv]
    fuv = mh.VT[body_ft]
    S, q2, fuv2 = geom.subdivide(q, fuv, V[bverts], levels=1)
    P = S @ V[bverts]
    Wb = S @ W[bverts]
    Db = {n: S @ d[bverts] for n, d in D.items()}
    vpi, vuv, tris = geom.unweld(q2, fuv2)
    ptris = geom.quads_to_tris(q2)
    Np = geom.vertex_normals(P, ptris)
    Dn = morph_normals(P, ptris, Np, Db)
    j, w = top4(Wb[vpi])
    uv_gl = np.stack([vuv[:, 0], 1 - vuv[:, 1]], 1)
    body_prim = dict(material='skin', pos=P[vpi], nrm=Np[vpi], uv=uv_gl,
                     joints=j, weights=w, idx=tris,
                     morphs={n: (Dn[n][0][vpi], Dn[n][1][vpi]) for n in MORPHS})
    body_index = len(meshes)
    meshes.append(None)  # body is added once clothing tells us what is hidden
    log('body verts', len(vpi), 'tris', len(tris))
    export.update(body_pos=P, body_nrm=Np, body_quads=q2, body_vpi=vpi,
                  body_uv=vuv, body_tris=tris)
    surf = Attacher(P, Wb, Db)

    # ------------------------------------------------------------- eyes
    log('eyes')
    ew = np.zeros((len(EP), nb))
    ew[left, bidx['eye.L']] = 1
    ew[~left, bidx['eye.R']] = 1
    # the proxy holds the eyeball plus a cornea dome mapped to a small uv disc
    fuv_e = EVT[EFT]
    is_cornea = np.linalg.norm(fuv_e.mean(1) - np.array([0.937, 0.07]), axis=1) < 0.07
    EN = geom.vertex_normals(EP, geom.quads_to_tris(EF))
    for name, mat, sel in (('Eyes', 'eye', ~is_cornea), ('Cornea', 'cornea', is_cornea)):
        evpi, evuv, etris = geom.unweld(EF[sel], fuv_e[sel])
        j, w = top4(ew[evpi])
        meshes.append(glb.add_mesh(name, [dict(
            material=mat, pos=EP[evpi], nrm=EN[evpi],
            uv=np.stack([evuv[:, 0], 1 - evuv[:, 1]], 1),
            joints=j, weights=w, idx=etris)]))
    log('cornea faces', int(is_cornea.sum()))

    # ---------------------------------------------- teeth / tongue helpers
    log('mouth parts')
    for gname, mat in (('helper-upper-teeth', 'teeth'), ('helper-lower-teeth', 'teeth'),
                       ('helper-tongue', 'tongue')):
        f, t = mh.group_faces(lambda g, gname=gname: g == gname)
        hv = np.unique(f)
        l2 = np.full(nV, -1)
        l2[hv] = np.arange(len(hv))
        Sg, qg, fg = geom.subdivide(l2[f], mh.VT[t], V[hv], levels=2)
        Pg = Sg @ V[hv]
        Wg = Sg @ W[hv]
        Dg = {n: Sg @ d[hv] for n, d in D.items()}
        tri = geom.quads_to_tris(qg)
        Ng = geom.vertex_normals(Pg, tri)
        j, w = top4(Wg)
        dn = morph_normals(Pg, tri, Ng, Dg)
        meshes.append(glb.add_mesh(gname.replace('helper-', ''), [dict(
            material=mat, pos=Pg, nrm=Ng, uv=np.zeros((len(Pg), 2)), joints=j,
            weights=w, idx=tri, morphs=dn)]))

    # ---------------------------------------------------------- strands
    import hair as hairmod
    rng = np.random.default_rng(7)
    head_b = bones[bidx['head']]

    lash = hairmod.eyelashes(mh, V, rng)
    brow = hairmod.eyebrows(P, Np, ptris, eye_info, rng)
    scalp = hairmod.scalp_hair(P, Np, ptris, eye_info, head_b, rng, args.hair)
    hairmod.write_strands(os.path.join(args.out, 'hair.bin'), scalp, head_b['head'])
    log('hair strands', len(scalp['pts']))

    # lashes bind to the base lash helpers (they carry the blink deltas)
    lash_groups = [g for g in set(f[2] for f in mh.faces) if 'eyelashes' in g]
    lf, _ = mh.group_faces(lambda g: g in lash_groups)
    lv = np.unique(lf)
    lash_att = Attacher(V[lv], W[lv], {n: d[lv] for n, d in D.items()}, k=3)

    for name, strands, att, mat in (('Eyelashes', lash, lash_att, 'lash'),
                                    ('Eyebrows', brow, surf, 'brow')):
        pos, nrm, uv, col, idx, root = strands
        Wst, Mst = att.bind(root)
        j, w = top4(Wst)
        morphs = {n: (m.astype(np.float32), None) for n, m in Mst.items()
                  if np.abs(m).max() > 1e-6}
        meshes.append(glb.add_mesh(name, [dict(
            material=mat, pos=pos, nrm=nrm, uv=uv, color=col, joints=j,
            weights=w, idx=idx, morphs=morphs)]))
        log(name, 'verts', len(pos), 'tris', len(idx))

    # ---------------------------------------------------------- clothing
    import clothes
    log('clothes')
    cloth_pts = []
    for name, mat, pos, nrm, uv, idx, Wc, col in clothes.build(mh, V, W, P, Np, surf, bones, bidx, rng):
        j, w = top4(Wc)
        meshes.append(glb.add_mesh(name, [dict(
            material=mat, pos=pos, nrm=nrm, uv=uv, color=col, joints=j, weights=w, idx=idx)]))
        log(name, 'verts', len(pos))
        cloth_pts.append(interior_points(pos, idx))

    # drop skin triangles that are fully covered by clothing (no poke-through)
    cp = np.concatenate(cloth_pts)
    d, _ = cKDTree(cp).query(P, k=1)
    covered = d < 0.045
    keep = ~covered[vpi][tris].all(1)
    body_prim['idx'] = tris[keep]
    meshes[body_index] = glb.add_mesh('Body', [body_prim])
    log('body tris kept', int(keep.sum()), 'of', len(tris))

    out = os.path.join(args.out, 'npc.glb')
    glb.write(out, root_children=meshes)
    log('wrote', out, os.path.getsize(out) // 1024, 'KiB')
    np.savez_compressed(os.path.join(HERE, '.cache_body.npz'),
                        **{k: v for k, v in export.items() if v is not None},
                        eyeL=eye_info['L'][0], eyeR=eye_info['R'][0],
                        eye_r=eye_info['L'][1], head=head_b['head'],
                        hair_roots=scalp['pts'][:, 0],
                        bone_names=np.array([x['name'] for x in bones]),
                        bone_heads=np.array([x['head'] for x in bones]),
                        bone_tails=np.array([x['tail'] for x in bones]))


def interior_points(pos, tris, margin=0.035):
    """Garment vertices at least `margin` from an open edge of the garment."""
    key = np.round(pos / 1e-5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    t = weld[tris]
    e = np.sort(np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]), axis=1)
    u, c = np.unique(e, axis=0, return_counts=True)
    bverts = np.unique(u[c == 1])
    first = np.zeros(weld.max() + 1, np.int64)
    first[weld] = np.arange(len(weld))
    bp = pos[first[bverts]]
    if len(bp) == 0:
        return pos
    d, _ = cKDTree(bp).query(pos)
    return pos[d > margin]


def cornea(c, r, fwd, rings=12, segs=48):
    """Spherical cap bulging slightly in front of the eyeball over the iris."""
    up = np.array([0.0, 1.0, 0.0])
    x = np.cross(up, fwd)
    x /= np.linalg.norm(x)
    y = np.cross(fwd, x)
    limbus = np.radians(34)          # angular radius of the iris on the ball
    rc = r * 0.82                    # cornea has a tighter curvature
    # centre of cornea sphere so it meets the eyeball at the limbus
    ring_r = r * np.sin(limbus)
    ring_z = r * np.cos(limbus)
    zc = ring_z - np.sqrt(rc ** 2 - ring_r ** 2)
    amax = np.arcsin(ring_r / rc)
    pts, nrm, uv = [], [], []
    for i in range(rings + 1):
        a = amax * i / rings * 1.06  # tuck the rim slightly under the ball
        for k in range(segs):
            phi = 2 * np.pi * k / segs
            d = np.array([np.sin(a) * np.cos(phi), np.sin(a) * np.sin(phi), np.cos(a)])
            p = np.array([0, 0, zc]) + d * rc
            pts.append(c + x * p[0] + y * p[1] + fwd * p[2])
            nrm.append(x * d[0] + y * d[1] + fwd * d[2])
            uv.append([0.5 + 0.5 * d[0] / np.sin(amax * 1.06 + 1e-9),
                       0.5 + 0.5 * d[1] / np.sin(amax * 1.06 + 1e-9)])
    tris = []
    for i in range(rings):
        for k in range(segs):
            a = i * segs + k
            b = i * segs + (k + 1) % segs
            c2 = (i + 1) * segs + k
            d2 = (i + 1) * segs + (k + 1) % segs
            tris += [[a, c2, b], [b, c2, d2]]
    return np.array(pts), np.array(nrm), np.array(uv), np.array(tris)


if __name__ == '__main__':
    main()
