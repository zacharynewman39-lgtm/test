"""Build public/npc/anatomy.glb + anatomy.json: the man's full interior.

    python3 tools/npc/anatomy/build_anatomy.py --mh <makehuman data> --bp3d <human-atlas public/models>

Anatomy: BodyParts3D 4.0 (c) DBCLS, CC BY 4.0 (bones, muscles, vessels,
organs, brain...), fitted into the NPC by register.py; lungs, spinal cord and
peripheral nerves synthesised by synth.py; subcutaneous fat from the NPC skin.
Every vertex carries a part index so a hit can be resolved to e.g.
'Left femoral artery' or 'Hepatovenous segment VII'.
"""
import argparse
import json
import os
import sys
import time

import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import fast_simplification  # noqa: E402

import build_npc  # noqa: E402
import geom  # noqa: E402
from bp3d import BP3D  # noqa: E402
from gltf import GLB, FLOAT, UBYTE, USHORT, UINT  # noqa: E402
from harmonic import InteriorWeights  # noqa: E402
from mhdata import MHData  # noqa: E402
import register  # noqa: E402
import synth  # noqa: E402
from tissues import TISSUES, EXCLUDE, classify  # noqa: E402

OUT = os.path.join(HERE, '..', '..', '..', 'public', 'npc')
KEEP = {'bone': 0.45, 'cartilage': 0.5, 'disc': 0.4, 'muscle': 0.18, 'tendon': 0.3, 'artery': 0.24,
        'vein': 0.2, 'mesentery': 0.12, 'duct': 0.3, 'nerve': 0.5, 'brain': 0.35, 'white_matter': 0.5, 'brainstem': 0.6, 'cerebellum': 0.6,
        'csf': 0.5}
RIGID = {'bone', 'cartilage', 'disc'}
MIN_DEPTH = {'bone': 0.0045, 'muscle': 0.0055, 'artery': 0.006, 'vein': 0.005, 'tendon': 0.0045, 'nerve': 0.005}
FAT_DEPTH = 0.0025  # dermis; the fat surface sits just under the skin


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


def weld(P, F, eps=1e-6):
    key = np.round(P / eps).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    F = inv.ravel()[F]
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    return P[first], F


def decimate(P, F, keep, min_tris=60):
    P, F = weld(P, F)
    if len(F) <= min_tris or keep >= 0.99:
        return P, F
    target = max(min_tris, int(len(F) * keep))
    red = 1 - target / len(F)
    try:
        P2, F2 = fast_simplification.simplify(np.ascontiguousarray(P, np.float32),
                                              np.ascontiguousarray(F, np.int32), red)
        if len(F2) >= 4:
            return P2.astype(np.float64), F2.astype(np.int64)
    except Exception:
        pass
    return P, F


def mesh_volume(P, F):
    a, b, c = P[F[:, 0]], P[F[:, 1]], P[F[:, 2]]
    return abs(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)


def top4(W):
    idx = np.argsort(-W, axis=1)[:, :4]
    w = np.take_along_axis(W, idx, axis=1)
    w = np.maximum(w, 0)
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    return idx, w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mh', required=True)
    ap.add_argument('--bp3d', required=True)
    ap.add_argument('--out', default=OUT)
    args = ap.parse_args()

    mh = MHData(args.mh).load_base()
    body = build_npc.shaped_body(mh)
    A = BP3D(args.bp3d)
    log('fitting reference anatomy')
    warp, pose, Vp, L = register.fit(A, body, log)

    items = []
    for p in A.parts:
        if EXCLUDE.search(p['name']):
            continue
        tissue = classify(p['name'], p['system'])
        P, F = A.mesh(p)
        P, F = decimate(P, F, KEEP.get(tissue, 0.6))
        items.append(dict(name=p['name'], system=p['system'], tissue=tissue, P=P, F=F, src=p['id']))
    log('parts', len(items), 'tris', sum(len(i['F']) for i in items))
    allP = np.concatenate([i['P'] for i in items])
    log('warping', len(allP), 'vertices')
    W_all = warp(allP)
    o = 0
    for i in items:
        n = len(i['P'])
        i['P'] = W_all[o:o + n]
        o += n

    # -------------------------------------------------- synthesised anatomy
    by_name = {}
    for i in items:
        by_name.setdefault(i['name'], []).append(i['P'])
    for name, (P, F) in synth.lungs(by_name, log=log).items():
        P, F = decimate(P, F, 0.35)
        items.append(dict(name=name, system='respiratory', tissue='lung', P=P, F=F, src='synth'))
    cord, cauda = synth.spinal_cord(by_name, log=log)
    items.append(dict(name='Spinal cord', system='nervous', tissue='spinal_cord', P=cord[0], F=cord[1], src='synth'))
    cp = np.concatenate([c[0] for c in cauda])
    cf = np.concatenate([c[1] + sum(len(x[0]) for x in cauda[:k]) for k, c in enumerate(cauda)])
    items.append(dict(name='Cauda equina', system='nervous', tissue='nerve', P=cp, F=cf, src='synth'))
    for name, (P, F) in synth.nerves(by_name, log=log).items():
        items.append(dict(name=name, system='nervous', tissue='nerve', P=P, F=F, src='synth'))

    # -------------------------------------------------- keep inside the skin
    # use the subdivided (rendered) skin surface, posed like the reference
    fv = body['body_fv']
    bv = np.unique(fv)
    loc = np.full(len(body['V']), -1)
    loc[bv] = np.arange(len(bv))
    S, q2, _ = geom.subdivide(loc[fv], None, body['V'][bv], levels=1)
    sub_tris = geom.quads_to_tris(q2)
    Vps = S @ Vp[bv]
    Nps = geom.vertex_normals(Vps, sub_tris)
    tree = cKDTree(Vps)
    pushed = 0
    for i in items:
        md = MIN_DEPTH.get(i['tissue'], 0.006)
        d, k = tree.query(i['P'], k=4)
        w_ = 1 / np.maximum(d, 1e-5)
        w_ /= w_.sum(1, keepdims=True)
        sp = (Vps[k] * w_[..., None]).sum(1)
        sn = (Nps[k] * w_[..., None]).sum(1)
        sn /= np.linalg.norm(sn, axis=1, keepdims=True)
        depth = ((sp - i['P']) * sn).sum(1)
        m = depth < md
        pushed += int(m.sum())
        i['P'][m] -= sn[m] * (md - depth[m])[:, None]
    log('pushed inside skin', pushed)
    btris = geom.quads_to_tris(fv)

    # -------------------------------------------------- weights + unpose
    log('interior weights')
    IW = InteriorWeights(Vp, btris, body['W'], log=log)
    G, t = pose.matrices()
    for i in items:
        Wv = IW(i['P'])
        if i['tissue'] in RIGID:
            Wv = np.broadcast_to(Wv.mean(0, keepdims=True), Wv.shape)
        j, w = top4(Wv)
        M = np.einsum('nk,nkij->nij', w, G[j])
        T = np.einsum('nk,nki->ni', w, t[j])
        i['bind'] = np.einsum('nij,nj->ni', np.linalg.inv(M), i['P'] - T)
        i['j'], i['w'] = j, w

    # -------------------------------------------------- subcutaneous fat
    # just under the rendered (subdivided) skin, skinned like the skin
    V, W = body['V'], body['W']
    Ps = S @ V[bv]
    Ns = geom.vertex_normals(Ps, sub_tris)
    Ws = S @ W[bv]
    fatP = Ps - Ns * FAT_DEPTH
    j, w = top4(Ws)
    items.append(dict(name='Subcutaneous fat', system='integumentary', tissue='fat', bind=fatP,
                      F=sub_tris, j=j, w=w, src='synth', P=fatP))

    export(items, body, args.out)


def export(items, body, out_dir):
    glb = GLB()
    glb.add_skeleton(body['bones'])
    layers = {}
    meta = []
    for pid, i in enumerate(items):
        layer, rgb, dens, blood = TISSUES[i['tissue']]
        if i['tissue'] in ('artery', 'vein'):
            layer = 'arteries' if i['tissue'] == 'artery' else 'veins'
        vol = mesh_volume(i['bind'], i['F']) * 1e6
        c = i['bind'].mean(0)
        lo, hi = i['bind'].min(0), i['bind'].max(0)
        ext = float(np.linalg.norm(hi - lo))
        entry = dict(id=pid, name=i['name'], tissue=i['tissue'], layer=layer, system=i['system'],
                     volume_ml=round(vol, 2), mass_g=round(vol * dens, 1), blood_ml=round(vol * blood, 2),
                     centre=[round(float(x), 4) for x in c], bounds=[[round(float(x), 4) for x in lo], [round(float(x), 4) for x in hi]],
                     source=i['src'])
        if i['tissue'] in ('artery', 'vein', 'nerve'):
            entry['radius_mm'] = round(float(np.sqrt(max(vol, 1e-3) * 1e-6 / (np.pi * max(ext, 0.01))) * 1000), 2)
        if i['tissue'] in RIGID:
            entry['bone'] = body['bones'][int(np.bincount(i['j'][:, 0]).argmax())]['name']
        meta.append(entry)
        L = layers.setdefault(layer, dict(P=[], F=[], j=[], w=[], col=[], part=[], n=0))
        L['P'].append(i['bind'])
        L['F'].append(i['F'] + L['n'])
        L['j'].append(i['j'])
        L['w'].append(i['w'])
        L['col'].append(np.tile(rgb, (len(i['bind']), 1)))
        L['part'].append(np.full(len(i['bind']), pid, np.float32))
        L['n'] += len(i['bind'])

    nodes = []
    for name, L in layers.items():
        P = np.concatenate(L['P'])
        F = np.concatenate(L['F'])
        N = geom.vertex_normals(P, F)
        j = np.concatenate(L['j']).astype(np.uint16)
        w = np.concatenate(L['w'])
        wq = np.round(w * 255).astype(np.int32)
        wq[:, 0] += 255 - wq.sum(1)  # exact normalisation in bytes
        col = np.concatenate(L['col'])
        col = np.c_[col, np.full(len(col), 255)].astype(np.uint8)
        part = np.concatenate(L['part'])
        attr = {
            'POSITION': glb.accessor(P, minmax=True, target=34962),
            'NORMAL': glb.accessor_packed_normals(N),
            'COLOR_0': glb.accessor(col, UBYTE, kind='VEC4', normalized=True, target=34962),
            'JOINTS_0': glb.accessor(j, USHORT, target=34962),
            'WEIGHTS_0': glb.accessor(np.clip(wq, 0, 255), UBYTE, kind='VEC4', normalized=True, target=34962),
            '_PART': glb.accessor(part, target=34962),
        }
        glb.meshes.append({'name': name, 'primitives': [{
            'attributes': attr, 'indices': glb.accessor(F.reshape(-1).astype(np.uint32), UINT, target=34963),
            'material': glb.material('anat_' + name)}]})
        nodes.append(glb.add_node({'name': 'anat_' + name, 'mesh': len(glb.meshes) - 1, 'skin': 0}))
        log(f'layer {name:10s} verts {len(P):7d} tris {len(F):7d}')
    path = os.path.join(out_dir, 'anatomy.glb')
    glb.write(path, root_name='Anatomy', root_children=nodes)
    log('wrote', path, os.path.getsize(path) // 1024, 'KiB')

    # body mass from the closed skin surface; blood volume 70 mL/kg (adult male)
    V = body['V']
    btris = geom.quads_to_tris(body['body_fv'])
    body_vol = mesh_volume(V, btris) * 1e6
    mass = body_vol * 1.01 / 1000
    doc = dict(
        source='BodyParts3D 4.0 (c) Database Center for Life Science, CC BY 4.0, fitted to the NPC; '
               'lungs, spinal cord, peripheral nerves and subcutaneous fat synthesised.',
        body=dict(height_m=1.81, volume_l=round(body_vol / 1000, 2), mass_kg=round(mass, 1),
                  blood_volume_ml=round(mass * 70)),
        parts=meta)
    with open(os.path.join(out_dir, 'anatomy.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    log('body mass', round(mass, 1), 'kg, blood', round(mass * 70), 'mL')


if __name__ == '__main__':
    main()
