"""Mesh utilities: Catmull-Clark subdivision as a sparse linear operator,
face-varying UV handling, normals and tangents."""
import numpy as np
import scipy.sparse as sp


def catmull_clark(quads, nverts):
    """One level of Catmull-Clark on a closed or open quad mesh.

    Returns (S, new_quads, corner_info). S is a sparse (n_new x nverts)
    matrix mapping old vertex data to new vertex data. Because subdivision is
    linear, the same S works for positions, morph deltas and skin weights.
    corner_info gives, per new quad corner, (kind, old_face, a, b) so
    face-varying attributes (UVs) can be rebuilt per face.
    """
    quads = np.asarray(quads, dtype=np.int64)
    nf = len(quads)
    # edges
    e = np.stack([quads, np.roll(quads, -1, axis=1)], axis=2).reshape(-1, 2)
    es = np.sort(e, axis=1)
    uniq, inv = np.unique(es, axis=0, return_inverse=True)
    inv = inv.reshape(nf, 4)  # edge id of edge (i, i+1) per face
    ne = len(uniq)
    edge_faces = [[] for _ in range(ne)]
    for f in range(nf):
        for k in range(4):
            edge_faces[inv[f, k]].append(f)
    boundary = np.array([len(x) == 1 for x in edge_faces])

    rows, cols, vals = [], [], []

    def add(r, c, v):
        rows.append(r)
        cols.append(c)
        vals.append(v)

    fp0 = nverts + ne  # face points offset
    ep0 = nverts       # edge points offset
    # face points
    for f in range(nf):
        for k in range(4):
            add(fp0 + f, quads[f, k], 0.25)
    # edge points
    for i, (a, b) in enumerate(uniq):
        fs = edge_faces[i]
        if len(fs) == 2:
            add(ep0 + i, a, 0.25)
            add(ep0 + i, b, 0.25)
            for f in fs:
                for k in range(4):
                    add(ep0 + i, quads[f, k], 0.25 * 0.25)
        else:
            add(ep0 + i, a, 0.5)
            add(ep0 + i, b, 0.5)
    # vertex points
    vfaces = [[] for _ in range(nverts)]
    for f in range(nf):
        for k in range(4):
            vfaces[quads[f, k]].append(f)
    vedges = [[] for _ in range(nverts)]
    for i, (a, b) in enumerate(uniq):
        vedges[a].append(i)
        vedges[b].append(i)
    for v in range(nverts):
        fs, es_ = vfaces[v], vedges[v]
        if not fs:
            add(v, v, 1.0)
            continue
        bes = [i for i in es_ if boundary[i]]
        if bes:
            add(v, v, 0.75)
            for i in bes[:2]:
                o = uniq[i][0] if uniq[i][1] == v else uniq[i][1]
                add(v, o, 0.125)
            continue
        n = len(fs)
        # (F + 2R + (n-3)P) / n
        for f in fs:
            for k in range(4):
                add(v, quads[f, k], 0.25 / n / n)
        for i in es_:
            a, b = uniq[i]
            add(v, a, 2 * 0.5 / n / n)
            add(v, b, 2 * 0.5 / n / n)
        add(v, v, (n - 3) / n)
    S = sp.csr_matrix((vals, (rows, cols)), shape=(nverts + ne + nf, nverts))
    S.sum_duplicates()

    newq = []
    corner = []  # per new quad: list of 4 (kind, face, k) for uv rebuild
    for f in range(nf):
        q = quads[f]
        E = inv[f]
        for k in range(4):
            km = (k - 1) % 4
            newq.append([q[k], ep0 + E[k], fp0 + f, ep0 + E[km]])
            corner.append([('v', f, k), ('e', f, k), ('f', f, 0), ('e', f, km)])
    return S, np.array(newq), corner


def subdivide_uv(face_uv, corner):
    """face_uv: (nf,4,2) uvs per old face corner -> (nq,4,2) for new quads."""
    out = np.zeros((len(corner), 4, 2))
    for i, cs in enumerate(corner):
        for j, (kind, f, k) in enumerate(cs):
            uv = face_uv[f]
            if kind == 'v':
                out[i, j] = uv[k]
            elif kind == 'e':
                out[i, j] = 0.5 * (uv[k] + uv[(k + 1) % 4])
            else:
                out[i, j] = uv.mean(0)
    return out


def subdivide(quads, face_uv, P, levels=1):
    """Convenience: returns (S_total, quads, face_uv)."""
    n = len(P)
    S_tot = sp.identity(n, format='csr')
    for _ in range(levels):
        S, quads, corner = catmull_clark(quads, n)
        face_uv = subdivide_uv(face_uv, corner) if face_uv is not None else None
        S_tot = S @ S_tot
        n = S.shape[0]
    return S_tot.tocsr(), quads, face_uv


def vertex_normals(P, tris):
    n = np.zeros_like(P)
    a, b, c = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    for i in range(3):
        np.add.at(n, tris[:, i], fn)
    l = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(l, 1e-12)


def quads_to_tris(q):
    q = np.asarray(q)
    return np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]])


def unweld(pos_quads, face_uv):
    """Turn (pos-index quads, per-corner uv) into GL vertex arrays.

    Returns (vert_pos_index[n], vert_uv[n,2], tris[m,3])."""
    nq = len(pos_quads)
    pi = pos_quads.reshape(-1)
    uv = face_uv.reshape(-1, 2)
    key = np.round(uv * 1e6).astype(np.int64)
    k = pi * (2 ** 42) + key[:, 0] * (2 ** 21) + key[:, 1]
    uk, first, inv = np.unique(k, return_index=True, return_inverse=True)
    vpi = pi[first]
    vuv = uv[first]
    q = inv.reshape(nq, 4)
    return vpi, vuv, quads_to_tris(q)


def tangents(P, N, UV, tris):
    t1 = np.zeros_like(P)
    t2 = np.zeros_like(P)
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    e1, e2 = P[b] - P[a], P[c] - P[a]
    d1, d2 = UV[b] - UV[a], UV[c] - UV[a]
    r = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    r = np.where(np.abs(r) < 1e-12, 1e-12, r)
    sdir = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) / r[:, None]
    tdir = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) / r[:, None]
    for i in (a, b, c):
        np.add.at(t1, i, sdir)
        np.add.at(t2, i, tdir)
    t = t1 - N * (N * t1).sum(1, keepdims=True)
    t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-12)
    w = np.where((np.cross(N, t) * t2).sum(1) < 0, -1.0, 1.0)
    return np.concatenate([t, w[:, None]], axis=1)
