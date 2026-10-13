"""Clothing built from MakeHuman's full-body 'tights' helper shell:
a cotton t-shirt, straight-leg jeans and leather boots. The shell is
subdivided, cut into garments, inflated and draped (Laplacian relaxation
against the body), given geometric folds and cylindrical UVs."""
import numpy as np
from scipy.spatial import cKDTree
import scipy.sparse as sp
import scipy.sparse.csgraph  # noqa: F401

import geom
from hair import Collider, smoothstep, unit


def adjacency(quads, n):
    """Row-normalised neighbour averaging. Boundary vertices only average
    along the boundary so open edges (hems, cuffs) keep their place."""
    e = np.concatenate([quads[:, [0, 1]], quads[:, [1, 2]], quads[:, [2, 3]], quads[:, [3, 0]]])
    es = np.sort(e, axis=1)
    u, cnt = np.unique(es, axis=0, return_counts=True)
    bd = u[cnt == 1]
    is_b = np.zeros(n, bool)
    is_b[bd.ravel()] = True
    inner = u[~(is_b[u[:, 0]] | is_b[u[:, 1]])]
    mixed = u[is_b[u[:, 0]] ^ is_b[u[:, 1]]]
    # interior vertices see all neighbours; boundary vertices see boundary only
    rows = [inner[:, 0], inner[:, 1], bd[:, 0], bd[:, 1]]
    cols = [inner[:, 1], inner[:, 0], bd[:, 1], bd[:, 0]]
    mi = np.where(is_b[mixed[:, 0]], mixed[:, 1], mixed[:, 0])
    mb = np.where(is_b[mixed[:, 0]], mixed[:, 0], mixed[:, 1])
    rows.append(mi)
    cols.append(mb)
    r = np.concatenate(rows)
    c = np.concatenate(cols)
    A = sp.coo_matrix((np.ones(len(r)), (r, c)), shape=(n, n)).tocsr()
    A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel()
    return sp.diags(1 / np.maximum(deg, 1)) @ A


def noise3(p, freq, seed):
    """Cheap smooth value noise from summed random sinusoids."""
    rng = np.random.default_rng(seed)
    out = np.zeros(len(p))
    for _ in range(6):
        k = unit(rng.normal(size=3)) * freq * rng.uniform(0.7, 1.4)
        out += np.sin(p @ k + rng.uniform(0, 6.283))
    return out / 6 ** 0.5


def drape(Pc, quads, body, gap, iters=12, smooth=0.5, pin=None):
    L = adjacency(quads, len(Pc))
    for _ in range(iters):
        Q = L @ Pc
        Pc = Pc * (1 - smooth) + Q * smooth if pin is None else \
            np.where(pin[:, None], Pc, Pc * (1 - smooth) + Q * smooth)
        Pc, _ = body.push_out(Pc, gap)
    return Pc


def cyl_uv(P, quads, axis_o, axis_d, ref, wrap_seam):
    """Cylindrical UVs around an axis, metres along/around. ref: radial
    reference direction where the wrap seam sits."""
    d = P - axis_o
    h = d @ axis_d
    r = d - np.outer(h, axis_d)
    x = unit(np.cross(axis_d, ref))
    y = np.cross(x, axis_d)
    ang = np.arctan2(r @ x, r @ y)  # 0 at -ref? ; seam where ang = +-pi
    rad = np.linalg.norm(r, axis=1)
    u = (ang + np.pi) / (2 * np.pi)
    fu = u[quads]
    span = fu.max(1) - fu.min(1)
    fix = span > 0.5
    fu[fix] = np.where(fu[fix] < 0.5, fu[fix] + 1, fu[fix])
    circ = 2 * np.pi * np.median(rad)
    fuv = np.stack([fu * circ, h[quads]], -1)
    return fuv


def build(mh, V, W, Pbody, Nbody, surf, bones, bidx, rng):
    f, t = mh.group_faces(lambda g: g == 'helper-tights')
    hv = np.unique(f)
    loc = np.full(len(V), -1)
    loc[hv] = np.arange(len(hv))
    S, q, _ = geom.subdivide(loc[f], None, V[hv], levels=2)
    P = S @ V[hv]
    Wc = S @ W[hv]
    cen = P[q].mean(1)
    body = Collider(Pbody, Nbody)

    B = {b['name']: b for b in bones}
    hipL = B['upperleg01.L']['head']
    y_hip = hipL[1]
    knee_y = B['lowerleg01.L']['head'][1]
    ankle_y = B['foot.L']['head'][1]
    neck_y = B['neck01']['head'][1]
    out = []

    def part(mask_faces):
        # drop small disconnected islands of faces (they make stray flaps)
        idx = np.nonzero(mask_faces)[0]
        sub = q[idx]
        e = np.concatenate([sub[:, [0, 1]], sub[:, [1, 2]], sub[:, [2, 3]], sub[:, [3, 0]]])
        A = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(P), len(P)))
        ncomp, lab = sp.csgraph.connected_components(A, directed=False)
        fl = lab[sub[:, 0]]
        sizes = np.bincount(fl, minlength=ncomp)
        keep = sizes[fl] > 0.05 * len(sub)
        mask_faces = np.zeros(len(q), bool)
        mask_faces[idx[keep]] = True
        qs = q[mask_faces]
        used = np.unique(qs)
        l = np.full(len(P), -1)
        l[used] = np.arange(len(used))
        return used, l[qs]

    # ------------------------------------------------------------ shirt
    def sleeve_t(c, side):
        sh = B['upperarm01.' + side]['head']
        el = B['lowerarm01.' + side]['head']
        ax = el - sh
        return ((c - sh) @ ax) / (ax @ ax)

    def arm_param(c):
        """Param along the upper arm and distance from its axis (per side)."""
        t_out = np.full(len(c), -1.0)
        for side, sg in (('L', 1), ('R', -1)):
            sh = B['upperarm01.' + side]['head']
            el = B['lowerarm01.' + side]['head']
            ax = el - sh
            t = ((c - sh) @ ax) / (ax @ ax)
            d = np.linalg.norm(c - sh - np.outer(t, ax), axis=1)
            m = (c[:, 0] * sg > 0) & (t > 0) & ((d < 0.075) | (t > 0.9))
            t_out[m] = t[m]
        return t_out

    arm_t = arm_param(cen)
    nk = B['neck01']['head']
    rad = np.hypot((cen[:, 0] - nk[0]) / 0.085, (cen[:, 2] - nk[2] - 0.004) / 0.075)
    front = smoothstep(-0.01, 0.05, cen[:, 2] - nk[2])
    neck_hole = (rad < 1.0) & (cen[:, 1] > neck_y - 0.035 - 0.035 * front)
    shirt_f = (cen[:, 1] > y_hip + 0.03) & (arm_t < 0.50) & ~neck_hole & (cen[:, 1] < neck_y + 0.03)
    used, sq = part(shirt_f)
    Ps = P[used].copy()
    # looser at the belly/back hem, snug on the shoulders
    gap = 0.006 + 0.012 * smoothstep(neck_y - 0.25, y_hip, Ps[:, 1])
    Ps, n0 = body.push_out(Ps, gap)
    Ps = drape(Ps, sq, body, gap, iters=16, smooth=0.6)
    # folds: soft horizontal ripples above the hem, drag folds from the
    # armpits, a little bagginess at the lower back
    nrm = geom.vertex_normals(Ps, geom.quads_to_tris(sq))
    y = Ps[:, 1]
    nz = noise3(Ps, 40, 1)
    hem = smoothstep(y_hip + 0.17, y_hip + 0.02, y)
    rip = np.sin((y - y_hip) * 2 * np.pi / 0.045 + nz * 1.8) * 0.0035 * hem
    arm = arm_param(Ps)
    pit = np.exp(-((arm - 0.0) / 0.12) ** 2) * smoothstep(neck_y - 0.10, neck_y - 0.22, y)
    rip += np.sin(arm * 2 * np.pi / 0.13 + nz) * 0.003 * pit
    slv = smoothstep(0.30, 0.48, arm)
    rip += np.sin(arm * 2 * np.pi / 0.07 + noise3(Ps, 25, 2) * 2) * 0.0025 * slv
    rip += noise3(Ps, 18, 3) * 0.0025 + noise3(Ps, 55, 4) * 0.0008
    Ps = Ps + nrm * rip[:, None]
    Ps, _ = body.push_out(Ps, 0.003)
    # cylindrical uvs around the spine; sleeves around the arms
    fuv = cyl_uv(Ps, sq, np.array([0, 0, 0.0]), np.array([0, 1.0, 0]),
                 np.array([0, 0, -1.0]), 'back')
    for side, sgn in (('L', 1), ('R', -1)):
        sh = B['upperarm01.' + side]['head']
        el = B['lowerarm01.' + side]['head']
        ax = unit(el - sh)
        fa = np.where(Ps[:, 0] * sgn > 0, sleeve_t(Ps, side), -1)[sq]
        sel = fa.mean(1) > 0.05
        if sel.any():
            suv = cyl_uv(Ps, sq[sel], sh, ax, np.array([0, -1.0, 0]), 'under')
            fuv[sel] = suv + np.array([5.0 * (1 if sgn > 0 else 2), 0])
    # slight dye/fade variation, darker in the folds' valleys
    shade = 1.0 + 0.10 * np.clip(rip / 0.004, -1, 1) + 0.04 * noise3(Ps, 9, 8)
    col = np.clip(np.outer(shade, [1, 1, 1]), 0, 1.2)
    out.append(finish('Shirt', 'shirt', Ps, sq, fuv, Wc[used], col, hem=dict(width=0.016, thick=0.0035, rib=True)))

    # ------------------------------------------------------------ jeans
    waist_y = y_hip + 0.085 + 0.012 * np.sign(cen[:, 2])
    hem_y = ankle_y + 0.030
    pants_f = (cen[:, 1] < waist_y) & (cen[:, 1] > hem_y - 0.04)
    used, pq = part(pants_f)
    Pp = P[used].copy()
    y = Pp[:, 1]
    gap = 0.004 + 0.010 * smoothstep(y_hip - 0.05, knee_y, y) + 0.008 * smoothstep(knee_y, ankle_y + 0.08, y)
    Pp, _ = body.push_out(Pp, gap)
    # straight leg: below mid thigh push out to a minimum radius around the leg axis
    for side, sgn in (('L', 1), ('R', -1)):
        top = B['upperleg01.' + side]['head']
        kn = B['lowerleg01.' + side]['head']
        an = B['foot.' + side]['head']
        m = (Pp[:, 0] * sgn > 0) & (y < (top[1] + kn[1]) / 2)
        a = np.where(y[m, None] > kn[1], kn + (top - kn) * ((y[m] - kn[1]) / (top[1] - kn[1]))[:, None],
                     an + (kn - an) * ((y[m] - an[1]) / (kn[1] - an[1]))[:, None])
        a[:, 2] -= 0.004
        r = Pp[m] - a
        r[:, 1] = 0
        rad = np.linalg.norm(r, axis=1)
        rmin = np.interp(y[m], [an[1], kn[1], (top[1] + kn[1]) / 2], [0.058, 0.062, 0.075])
        scale = np.maximum(1, rmin / np.maximum(rad, 1e-6))
        Pp[m] = a + r * scale[:, None] + np.outer(np.zeros(m.sum()), [0, 1, 0]) + (Pp[m] - a - r) * 0
        Pp[m, 1] = y[m]
    Pp = drape(Pp, pq, body, gap * 0.8, iters=10, smooth=0.5)
    nrm = geom.vertex_normals(Pp, geom.quads_to_tris(pq))
    y = Pp[:, 1]
    nz = noise3(Pp, 35, 5)
    # stacking at the ankle, bunching behind the knee, crotch whiskers
    stack = smoothstep(ankle_y + 0.16, ankle_y + 0.04, y)
    rip = np.sin((y - ankle_y) * 2 * np.pi / 0.045 + nz * 2.2) * 0.0035 * stack
    knee = np.exp(-((y - knee_y) / 0.06) ** 2) * smoothstep(0.0, -0.06, Pp[:, 2] - B['lowerleg01.L']['head'][2])
    rip += np.sin((y - knee_y) * 2 * np.pi / 0.03 + nz * 1.5) * 0.003 * knee
    crotch = np.exp(-((y - (y_hip - 0.07)) / 0.06) ** 2) * smoothstep(0.0, 0.05, Pp[:, 2])
    rip += np.sin(np.arctan2(Pp[:, 1] - y_hip + 0.12, np.abs(Pp[:, 0]) - 0.02) * 22 + nz) * 0.0018 * crotch
    rip += noise3(Pp, 14, 6) * 0.002 + noise3(Pp, 45, 7) * 0.0006
    Pp = Pp + nrm * rip[:, None]
    # flare the hem out over the boot shaft
    Pp, _ = body.push_out(Pp, 0.003 + 0.010 * smoothstep(ankle_y + 0.10, ankle_y + 0.02, y))
    fuv = np.zeros((len(pq), 4, 2))
    for side, sgn in (('L', 1), ('R', -1)):
        top = B['upperleg01.' + side]['head']
        an = B['foot.' + side]['head']
        sel = (Pp[pq][:, :, 0].mean(1) * sgn) > 0
        fuv[sel] = cyl_uv(Pp, pq[sel], an, unit(top - an), np.array([-sgn, 0, 0.0]), 'inseam') \
            + np.array([3.0 * (1 if sgn > 0 else 2), 0])
    # wear: lighter on thigh fronts, knees and seat, whiskers, darker in folds
    y = Pp[:, 1]
    front = smoothstep(0.0, 0.05, Pp[:, 2] - 0.02)
    back = smoothstep(0.0, 0.05, -Pp[:, 2] - 0.02)
    thigh = np.exp(-((y - (y_hip - 0.18)) / 0.13) ** 2) * front
    kneew = np.exp(-((y - knee_y) / 0.07) ** 2) * front
    seat = np.exp(-((y - (y_hip - 0.03)) / 0.08) ** 2) * back
    wear = 0.35 * thigh + 0.30 * kneew + 0.25 * seat
    wear += 0.25 * np.clip(rip / 0.003, 0, 1) * (crotch + stack)
    wear *= 0.8 + 0.4 * (noise3(Pp, 20, 9) * 0.5 + 0.5)
    fold = np.clip(-rip / 0.004, 0, 1)
    shade = (1 + 0.5 * wear) * (1 - 0.25 * fold)
    col = np.stack([shade * (1 + 0.05 * wear), shade * (1 + 0.08 * wear), shade * (1 + 0.12 * wear)], 1)
    out.append(finish('Jeans', 'denim', Pp, pq, fuv, Wc[used], col, hem=dict(width=0.022, thick=0.004)))

    # ------------------------------------------------------------ boots
    boot_f = cen[:, 1] < ankle_y + 0.10
    used, bq = part(boot_f)
    Pb = P[used].copy()
    y0 = Pb[:, 1].copy()
    Pb, _ = body.push_out(Pb, 0.008 + 0.004 * smoothstep(ankle_y, ankle_y - 0.05, y0))
    Pb = drape(Pb, bq, body, 0.008, iters=8, smooth=0.5)
    out_f = []
    for side, sg in (('L', 1), ('R', -1)):
        m = Pb[:, 0] * sg > 0
        heel_c = B['foot.' + side]['head'].copy()
        toe = B['toe3-1.' + side]['head'] if 'toe3-1.' + side in B else B['foot.' + side]['tail']
        ax = toe - heel_c
        ax[1] = 0
        ax = unit(ax)
        q = Pb[m]
        rel = q - heel_c
        along = rel @ ax
        perp = rel - np.outer(along, ax)
        perp[:, 1] = 0
        # outsole: flat bottom, lip sticking out a few millimetres
        low = q[:, 1]
        lip = smoothstep(0.03, 0.012, low)
        q = q + unit(perp + 1e-9) * (0.005 * lip)[:, None]
        q = q + ax * (0.006 * lip * smoothstep(0.08, 0.14, along))[:, None]
        q = q - ax * (0.004 * lip * smoothstep(0.0, -0.04, along))[:, None]
        # roomy toe box
        toe_w = smoothstep(0.09, 0.17, along)
        q[:, 1] += 0.006 * toe_w * smoothstep(0.02, 0.05, low)
        q[:, 1] = np.maximum(q[:, 1], 0.0)
        q[:, 1] = np.where(low < 0.012, q[:, 1] * 0.5, q[:, 1])
        Pb[m] = q
    y = Pb[:, 1]
    fuv = np.stack([Pb[bq][..., 0] + Pb[bq][..., 2], Pb[bq][..., 1]], -1)
    # brown oiled leather, darker welt and a rubber sole
    y = Pb[:, 1]
    leather = np.array([0.055, 0.028, 0.015]) * (1 + 0.15 * noise3(Pb, 30, 10))[:, None]
    toe = smoothstep(0.03, 0.09, Pb[:, 2] - B['foot.L']['head'][2])
    leather = leather * (1 + 0.35 * toe)[:, None]  # scuffed, lighter toe cap
    sole = np.array([0.025, 0.022, 0.020])
    welt = np.array([0.05, 0.03, 0.018])
    ws = smoothstep(0.014, 0.010, y)
    wl = smoothstep(0.019, 0.015, y) * (1 - ws)
    col = leather * (1 - ws - wl)[:, None] + sole * ws[:, None] + welt * wl[:, None]
    out.append(finish('Boots', 'leather', Pb, bq, fuv, Wc[used], col, hem=dict(width=0.012, thick=0.006)))
    return out


def boundary_loops(quads):
    e = np.concatenate([quads[:, [0, 1]], quads[:, [1, 2]], quads[:, [2, 3]], quads[:, [3, 0]]])
    es = np.sort(e, axis=1)
    u, cnt = np.unique(es, axis=0, return_counts=True)
    bset = set(map(tuple, u[cnt == 1]))
    # keep the face winding direction for consistent orientation
    nxt = {}
    for a, b in e:
        if (min(a, b), max(a, b)) in bset:
            nxt[a] = b
    loops, seen = [], set()
    for s in nxt:
        if s in seen:
            continue
        loop, v = [], s
        while v not in seen and v in nxt:
            seen.add(v)
            loop.append(v)
            v = nxt[v]
        if len(loop) > 4:
            loops.append(np.array(loop))
    return loops


def finish(name, mat, Pc, quads, fuv, Wc, col, hem=None):
    """hem: dict(width, thick) adds rolled/ribbed bands on every open edge."""
    N = geom.vertex_normals(Pc, geom.quads_to_tris(quads))
    extra = []
    if hem:
        Pc = Pc.copy()
        for loop in boundary_loops(quads):
            if len(loop) < 16:
                continue
            # smooth the cut line (it follows the shell's quads)
            p = Pc[loop]
            for _ in range(12):
                p = 0.5 * p + 0.25 * (np.roll(p, 1, 0) + np.roll(p, -1, 0))
            # flatten onto the loop's best-fit plane: clean straight hems
            cen_ = p.mean(0)
            _, _, vt = np.linalg.svd(p - cen_)
            pn = vt[2]
            p = p - np.outer((p - cen_) @ pn, pn)
            delta = p - Pc[loop]
            Pc[loop] = p
            # carry part of the correction into the next rings so there is no kink
            ring1 = np.unique(quads[np.isin(quads, loop).any(1)].ravel())
            ring1 = ring1[~np.isin(ring1, loop)]
            if len(ring1):
                _, k = cKDTree(p).query(Pc[ring1])
                Pc[ring1] += delta[k] * 0.6
            n = N[loop]
            for _ in range(20):
                n = unit(0.5 * n + 0.25 * (np.roll(n, 1, 0) + np.roll(n, -1, 0)))
            t = unit(np.roll(p, -1, 0) - np.roll(p, 1, 0))
            n = unit(n - t * (n * t).sum(1, keepdims=True))
            d = unit(np.cross(n, t))
            # point d into the garment: towards the centroid of nearby verts
            inner = Pc[quads[np.isin(quads, loop).any(1)].ravel()].mean(0)
            if ((inner - p) * d).sum(1).mean() < 0:
                d = -d
            w, h = hem['width'], hem['thick']
            prof = np.array([[w, 0.25 * h], [0.75 * w, 0.9 * h], [0.35 * w, h], [0.05 * w, 0.9 * h],
                             [-0.35 * h, 0.45 * h], [-0.05 * h, -0.15 * h], [0.25 * w, -0.25 * h]])
            if hem.get('rib'):
                ribs = np.sin(np.cumsum(np.linalg.norm(np.roll(p, -1, 0) - p, axis=1)) / 0.0012) * 0.25 * h
            else:
                ribs = np.zeros(len(loop))
            ring = p[:, None] + d[:, None] * prof[None, :, 0:1] + \
                n[:, None] * (prof[None, :, 1:2] + ribs[:, None, None] * (prof[None, :, 1:2] > 0.5 * h))
            L, M = ring.shape[:2]
            bp = ring.reshape(-1, 3)
            q = []
            for i in range(L):
                i2 = (i + 1) % L
                for j in range(M - 1):
                    q.append([i * M + j, i2 * M + j, i2 * M + j + 1, i * M + j + 1])
            q = np.array(q)
            arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))])
            fuv_b = np.stack([arc[q // M], (q % M) * 0.004], -1)
            fix = np.abs(fuv_b[..., 0].max(1) - fuv_b[..., 0].min(1)) > 0.05
            fuv_b[fix, :, 0] = np.where(fuv_b[fix, :, 0] < 0.05, fuv_b[fix, :, 0] + arc[-1] + np.linalg.norm(p[0] - p[-1]), fuv_b[fix, :, 0])
            extra.append((bp, q, fuv_b, np.repeat(Wc[loop], M, axis=0), np.repeat(col[loop], M, axis=0) * 0.97))
    allP, allQ, allUV, allW, allC = [Pc], [quads], [fuv], [Wc], [col]
    off = len(Pc)
    for bp, q, fu, wb, cb in extra:
        allP.append(bp)
        allQ.append(q + off)
        allUV.append(fu)
        allW.append(wb)
        allC.append(cb)
        off += len(bp)
    Pc, quads, fuv = np.concatenate(allP), np.concatenate(allQ), np.concatenate(allUV)
    Wc, col = np.concatenate(allW), np.concatenate(allC)
    vpi, vuv, tris = geom.unweld(quads, fuv)
    N = geom.vertex_normals(Pc, geom.quads_to_tris(quads))
    return name, mat, Pc[vpi].astype(np.float32), N[vpi].astype(np.float32), \
        vuv.astype(np.float32), tris.astype(np.uint32), Wc[vpi], col[vpi].astype(np.float32)
