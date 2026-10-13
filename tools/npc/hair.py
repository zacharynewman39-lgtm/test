"""Procedural grooming: scalp hair, eyebrows, eyelashes and beard stubble.

Every hair is a polyline grown over the skin surface, then turned into a
tapered ribbon. Coordinates are meters (y up, +z forward). Facial landmarks
are expressed relative to the midpoint between the eyes in 'face units'
(K meters, the decimetre of the unscaled MakeHuman mesh) so the numbers
read like the measurements they came from.
"""
import numpy as np
from scipy.spatial import cKDTree

K = 0.0945  # meters per face unit (MakeHuman decimetre at this body scale)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


class Face:
    """Landmark frame. rel() gives face units relative to the eye midpoint."""

    def __init__(self, eye_info):
        self.E = 0.5 * (eye_info['L'][0] + eye_info['R'][0])

    def rel(self, p):
        return (p - self.E) / K

    def head_center(self):
        return self.E + np.array([0.0, 0.16, -0.80]) * K


# ------------------------------------------------------------------ masks
def lips_mask(R, soft=0.012):
    """R: face-unit coords. 1 on the vermilion of the lips."""
    X, Y = np.abs(R[..., 0]), R[..., 1]
    w = 0.262
    t = np.clip(1 - (X / w) ** 2, 0, 1)
    y0 = -0.762
    bow = 0.010 * np.exp(-(X / 0.028) ** 2)
    peaks = 0.006 * np.exp(-((X - 0.055) / 0.03) ** 2)
    yu = y0 + 0.082 * t ** 0.55 - bow + peaks
    yl = y0 - 0.105 * t ** 0.5
    inside = smoothstep(-soft, soft, yu - Y) * smoothstep(-soft, soft, Y - yl)
    front = smoothstep(0.08, 0.16, R[..., 2])  # exclude the mouth cavity
    return inside * smoothstep(w + 0.01, w - 0.02, X) * front


def hairline(phi):
    """Lower edge of the scalp hair (face units above the eyes) by azimuth.
    phi in degrees, 0 = forehead centre, 90 = side, 180 = nape."""
    k = [0, 18, 30, 40, 48, 55, 63, 72, 100, 112, 128, 150, 180]
    y = [0.70, 0.72, 0.76, 0.62, 0.42, -0.08, -0.16, 0.20, 0.20, -0.30, -0.70, -0.86, -0.90]
    return np.interp(phi, k, y)


def azimuth(rel_c):
    return np.degrees(np.arctan2(np.abs(rel_c[..., 0]), rel_c[..., 2]))


def scalp_density(p, face):
    """Hair density 0..1 on the scalp with a feathered hairline."""
    R = face.rel(p)
    C = face.rel(face.head_center())
    rc = R - C
    phi = azimuth(rc)
    yl = hairline(phi)
    d = smoothstep(yl - 0.02, yl + 0.10, R[..., 1])
    # keep off the ears: ears protrude laterally from the skull
    ear = np.exp(-(((np.abs(R[..., 0]) - 0.62) / 0.16) ** 2
                   + ((R[..., 1] + 0.02) / 0.32) ** 2
                   + ((R[..., 2] + 0.85) / 0.30) ** 2))
    d *= 1 - smoothstep(0.25, 0.6, ear)
    # never on the face
    d *= 1 - smoothstep(0.0, 0.25, R[..., 2] + 0.15 - 2.0 * np.maximum(R[..., 1] - 0.55, 0)) * (R[..., 1] < 0.85)
    return d


def beard_mask(p, n, face):
    R = face.rel(p)
    X, Y = np.abs(R[..., 0]), R[..., 1]
    top = np.interp(X, [0.0, 0.20, 0.27, 0.36, 0.50, 0.66, 0.76, 1.0],
                    [-0.57, -0.56, -0.62, -0.60, -0.47, -0.27, -0.20, -0.20])
    m = smoothstep(top + 0.04, top - 0.06, Y)
    m *= smoothstep(-1.75, -1.35, Y)                 # fade down the neck
    C = face.rel(face.head_center())
    phi = azimuth(R - C)
    m *= smoothstep(112, 92, phi) + (Y < -1.25) * smoothstep(125, 100, phi)
    m = np.clip(m, 0, 1)
    m *= 1 - lips_mask(R, 0.02)
    # thinner on the cheeks and just under the lower lip sides
    m *= 1 - 0.45 * np.exp(-(((X - 0.42) / 0.12) ** 2 + ((Y + 0.66) / 0.08) ** 2))
    m *= 1 - 0.6 * np.exp(-(((X - 0.13) / 0.06) ** 2 + ((Y + 0.93) / 0.05) ** 2))
    # nostrils / under the nose tip
    m *= 1 - np.exp(-((X / 0.13) ** 2 + ((Y + 0.50) / 0.05) ** 2))
    return np.clip(m, 0, 1)


# ------------------------------------------------------------- sampling
def sample_surface(P, N, tris, n, rng, region=None):
    a, b, c = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    cen = (a + b + c) / 3
    keep = np.ones(len(tris), bool) if region is None else region(cen)
    t = tris[keep]
    a, b, c = a[keep], b[keep], c[keep]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    pick = rng.choice(len(t), size=n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    w = 1 - u - v
    p = a[pick] * w[:, None] + b[pick] * u[:, None] + c[pick] * v[:, None]
    nn = N[t[pick, 0]] * w[:, None] + N[t[pick, 1]] * u[:, None] + N[t[pick, 2]] * v[:, None]
    return p, unit(nn)


class Collider:
    def __init__(self, P, N):
        self.tree = cKDTree(P)
        self.P, self.N = P, N

    def push_out(self, q, hmin):
        d, i = self.tree.query(q, k=3)
        w = 1 / np.maximum(d, 1e-6)
        w /= w.sum(1, keepdims=True)
        pn = (self.P[i] * w[..., None]).sum(1)
        nn = unit((self.N[i] * w[..., None]).sum(1))
        h = ((q - pn) * nn).sum(1)
        corr = np.maximum(hmin - h, 0)
        return q + nn * corr[:, None], nn


# --------------------------------------------------------------- ribbons
def ribbons(pts, width, normals, colors, twist_rng=None):
    """pts (S,K,3) polylines, width (S,K) full width, normals (S,3) root
    normals the ribbon faces, colors (S,3). Returns mesh arrays."""
    S, Kp, _ = pts.shape
    t = np.zeros_like(pts)
    t[:, 1:-1] = pts[:, 2:] - pts[:, :-2]
    t[:, 0] = pts[:, 1] - pts[:, 0]
    t[:, -1] = pts[:, -1] - pts[:, -2]
    t = unit(t)
    n = np.broadcast_to(normals[:, None, :], pts.shape)
    side = np.cross(t, n)
    bad = np.linalg.norm(side, axis=-1) < 1e-6
    side[bad] = np.cross(t[bad], np.array([0.0, 1.0, 0.0]))
    side = unit(side)
    if twist_rng is not None:  # random ribbon roll so not all hairs face out
        ang = twist_rng.uniform(-0.6, 0.6, size=(S, 1, 1))
        nb = unit(np.cross(side, t))
        side = unit(side * np.cos(ang) + nb * np.sin(ang))
    face_n = unit(np.cross(side, t))
    flip = (face_n * n).sum(-1, keepdims=True) < 0
    face_n = np.where(flip, -face_n, face_n)
    hw = (width / 2)[..., None]
    v0 = pts - side * hw
    v1 = pts + side * hw
    pos = np.stack([v0, v1], axis=2).reshape(-1, 3)
    nrm = np.repeat(face_n, 2, axis=1).reshape(-1, 3)
    s = np.linspace(0, 1, Kp)
    uv = np.stack([np.repeat(np.broadcast_to(s, (S, Kp))[..., None], 2, -1),
                   np.broadcast_to(np.array([0.0, 1.0]), (S, Kp, 2))], -1).reshape(-1, 2)
    col = np.repeat(np.repeat(colors[:, None, :], Kp, 1)[:, :, None, :], 2, 2).reshape(-1, 3)
    base = (np.arange(S) * Kp * 2)[:, None] + (np.arange(Kp - 1) * 2)[None, :]
    a = base
    b = base + 1
    c = base + 2
    d = base + 3
    idx = np.concatenate([np.stack([a, c, b], -1), np.stack([b, c, d], -1)], 1).reshape(-1, 3)
    return pos.astype(np.float32), nrm.astype(np.float32), uv.astype(np.float32), \
        col.astype(np.float32), idx.astype(np.uint32)


def taper(Kp, root, tip, S, power=1.0):
    s = np.linspace(0, 1, Kp)
    w = root[:, None] * (1 - s[None, :] ** power) + tip[:, None] * s[None, :] ** power
    return w


# ------------------------------------------------------------- scalp hair
def comb_field(p, n, face):
    R = face.rel(p)
    C = face.rel(face.head_center())
    rc = R - C
    phi = azimuth(rc)
    Y = R[..., 1]
    x = R[..., 0]
    part = 0.30                                  # side part on his left (+x)
    left_of_part = x > part
    d_top = np.where(left_of_part[:, None], np.array([0.45, 0.0, -0.6]),
                     np.array([-0.45, 0.05, -0.9]))
    # front: lifted and swept back/across off the forehead
    d_front = np.array([-0.35, 0.65, -0.8])
    d_front = np.where(left_of_part[:, None], np.array([0.30, 0.45, -0.8]), d_front)
    d_side = np.array([0.0, -0.75, -1.0])
    d_back = np.stack([-0.25 * np.sign(x), -np.ones_like(x), -0.05 * np.ones_like(x)], -1)

    w_front = smoothstep(55, 20, phi) * smoothstep(0.55, 0.9, Y) * smoothstep(1.55, 1.2, Y)
    w_top = smoothstep(0.75, 1.05, Y) * (1 - w_front)
    w_back = smoothstep(115, 150, phi) * (1 - w_top)
    w_side = np.clip(1 - w_front - w_top - w_back, 0, 1)
    d = (d_top * w_top[:, None] + d_front[None] * w_front[:, None] if d_front.ndim == 1
         else d_top * w_top[:, None] + d_front * w_front[:, None])
    d = d + d_side * w_side[:, None] + d_back * w_back[:, None]
    # crown whorl
    cw = C + np.array([0.12, 1.02, -0.55])
    dv = R - cw
    swirl = np.cross(n, dv)
    ws = np.exp(-(np.linalg.norm(dv, axis=1) / 0.22) ** 2)
    d = d * (1 - ws[:, None]) + unit(swirl) * ws[:, None] * 1.2 + unit(dv) * ws[:, None] * 0.4
    d = d - n * (d * n).sum(1, keepdims=True)
    return unit(d)


def hair_length(p, face, rng):
    R = face.rel(p)
    Y = R[..., 1]
    C = face.rel(face.head_center())
    phi = azimuth(R - C)
    # short tapered sides and back, longer textured top
    L = np.interp(Y, [-1.0, -0.6, -0.2, 0.25, 0.6, 0.9, 1.2],
                  [0.004, 0.006, 0.008, 0.011, 0.016, 0.034, 0.045])
    # the long top is confined to the crown/top band; sides stay short
    top = smoothstep(62, 38, phi) + smoothstep(1.05, 1.25, Y)
    L = np.where(np.clip(top, 0, 1) > 0, L * (0.45 + 0.55 * np.clip(top, 0, 1)), L)
    front = smoothstep(40, 5, phi) * smoothstep(0.6, 0.9, Y)
    L = L + front * 0.010
    L *= rng.uniform(0.7, 1.15, size=L.shape)
    return L


def grow(roots, nrm, face, coll, L, Kp, rng, lift, hmin, field, gravity=0.25):
    S = len(roots)
    pts = np.zeros((S, Kp, 3))
    pts[:, 0] = roots
    d0 = field(roots, nrm)
    dirs = unit(nrm * lift[:, None] + d0)
    seg = (L / (Kp - 1))[:, None]
    p = roots.copy()
    n_cur = nrm
    for i in range(1, Kp):
        f = field(p, n_cur)
        g = np.array([0.0, -1.0, 0.0]) * gravity * (L / 0.05)[:, None]
        dirs = unit(dirs * 0.55 + f * 0.45 - n_cur * 0.12 + g * 0.2
                    + rng.normal(0, 0.06, size=dirs.shape))
        p = p + dirs * seg
        h = hmin[:, 0] + (hmin[:, 1] - hmin[:, 0]) * (i / (Kp - 1))
        p, n_cur = coll.push_out(p, h)
        pts[:, i] = p
    return pts


def scalp_hair(P, N, tris, eye_info, head_b, rng, count):
    face = Face(eye_info)
    region_c = face.E + np.array([0, 0.5, -0.8]) * K

    def region(c):
        return np.linalg.norm(c - region_c, axis=1) < 1.75 * K
    roots, nrm = sample_surface(P, N, tris, count * 3, rng, region)
    dens = scalp_density(roots, face)
    keep = rng.random(len(roots)) < dens
    roots, nrm, dens = roots[keep][:count], nrm[keep][:count], dens[keep][:count]
    S = len(roots)
    head_sel = np.linalg.norm(P - region_c, axis=1) < 2.2 * K
    coll = Collider(P[head_sel], N[head_sel])
    L = hair_length(roots, face, rng)
    # feathered hairline hairs are finer and shorter
    L *= 0.55 + 0.45 * dens
    Kp = 9
    lift = rng.uniform(0.25, 0.7, S)
    vol = rng.uniform(0.0, 1.0, S) ** 0.7
    hmin = np.stack([np.full(S, 0.0006), 0.0012 + vol * 0.30 * L], 1)
    field = lambda p, n: comb_field(p, n, face)
    pts = grow(roots, nrm, face, coll, L, Kp, rng, lift, hmin, field)

    # clumping: strands pull towards a guide strand near their tips
    nclump = max(1, S // 30)
    gi = rng.choice(S, nclump, replace=False)
    _, ci = cKDTree(roots[gi]).query(roots)
    guide = pts[gi][ci]
    groot = guide[:, :1]
    off = guide - groot + pts[:, :1]
    c = (np.linspace(0, 1, Kp) ** 1.5)[None, :, None] * rng.uniform(0.15, 0.5, (S, 1, 1))
    pts = pts * (1 - c) + off * c
    # flyaways and frizz
    pts[:, 2:] += rng.normal(0, 0.00025, size=pts[:, 2:].shape) * (np.linspace(0, 1, Kp)[2:, None])
    for i in range(1, Kp):
        h = hmin[:, 0] + (hmin[:, 1] - hmin[:, 0]) * (i / (Kp - 1))
        pts[:, i], _ = coll.push_out(pts[:, i], h * 0.8)

    # colour: dark brown with melanin variation, some grey at the temples
    base = np.array([0.062, 0.036, 0.020])
    var = rng.lognormal(0, 0.25, (S, 1))
    col = base * var * rng.uniform(0.9, 1.1, (S, 3))
    R = face.rel(roots)
    C = face.rel(face.head_center())
    phi = azimuth(R - C)
    grey_p = 0.03 + 0.10 * smoothstep(40, 80, phi) * smoothstep(0.9, 0.2, R[:, 1])
    grey = rng.random(S) < grey_p
    col[grey] = np.array([0.42, 0.40, 0.37]) * rng.uniform(0.8, 1.1, (grey.sum(), 1))
    return dict(pts=pts, nrm=nrm, col=col,
                root_w=0.00021 * (0.6 + 0.4 * dens), tip_w=np.full(S, 0.00003))


def write_strands(path, H, origin):
    """Compact strand file built into ribbons at load time (see src/hair.js).
    Layout (little endian): u32 S, u32 Kp, f32 scale, then
    i16 points[S*Kp*3] (relative to origin, /scale*32767), i8 normals[S*3],
    u8 colours[S*3] (sRGB-ish sqrt encoded), u16 widths[S*2] (micrometres)."""
    pts = H['pts'] - origin
    S, Kp, _ = pts.shape
    scale = float(np.abs(pts).max() * 1.001)
    q = np.round(pts / scale * 32767).astype('<i2')
    n = np.round(np.clip(H['nrm'], -1, 1) * 127).astype('i1')
    c = np.round(np.sqrt(np.clip(H['col'], 0, 1)) * 255).astype('u1')
    w = np.round(np.stack([H['root_w'], H['tip_w']], 1) * 1e6).astype('<u2')
    with open(path, 'wb') as f:
        f.write(np.array([S, Kp], '<u4').tobytes())
        f.write(np.array([scale], '<f4').tobytes())
        for a in (q, n, c, w):
            f.write(a.tobytes())


# --------------------------------------------------------------- eyebrows
def eyebrows(P, N, tris, eye_info, rng, per_brow=1100):
    face = Face(eye_info)
    out_pts, out_n, out_w, out_c, out_root = [], [], [], [], []
    for side, sgn in (('L', 1.0), ('R', -1.0)):
        ec = face.rel(eye_info[side][0])

        def brow_coords(p):
            R = face.rel(p)
            lat = (R[:, 0] - ec[0]) * sgn          # + = lateral
            u = (lat + 0.215) / 0.62
            yc = np.interp(u, [0, 0.3, 0.62, 1.0], [0.125, 0.165, 0.195, 0.150])
            th = np.interp(u, [0, 0.3, 0.62, 1.0], [0.115, 0.105, 0.080, 0.030])
            v = (R[:, 1] - yc) / np.maximum(th, 1e-3)  # -0.5..0.5 inside
            return u, v

        def region(c):
            R = face.rel(c)
            return (np.abs(R[:, 0] - ec[0]) < 0.6) & (R[:, 1] > -0.05) & (R[:, 1] < 0.45) & (R[:, 2] > -0.3)
        cand, cn = sample_surface(P, N, tris, per_brow * 8, rng, region)
        u, v = brow_coords(cand)
        dens = smoothstep(-0.05, 0.08, u) * smoothstep(1.06, 0.9, u) * smoothstep(0.62, 0.40, np.abs(v))
        dens *= 0.75 + 0.25 * smoothstep(0.0, 0.25, u)
        keep = rng.random(len(cand)) < dens * 0.9
        roots, nrm, u, v = cand[keep][:per_brow], cn[keep][:per_brow], u[keep][:per_brow], v[keep][:per_brow]
        S = len(roots)
        # herringbone: upper hairs point down-lateral, lower ones up-lateral
        lat = np.array([sgn, 0.0, 0.0])
        up = np.array([0.0, 1.0, 0.0])
        a_up = np.interp(u, [0, 0.15, 0.4, 0.8, 1.0], [2.4, 1.0, 0.35, -0.15, -0.4]) - 0.9 * v
        lat_w = np.interp(u, [0, 0.15, 1.0], [0.35, 1.0, 1.0])
        d = unit(lat[None] * lat_w[:, None] + up[None] * a_up[:, None])
        d = unit(d - nrm * (d * nrm).sum(1, keepdims=True))
        L = rng.uniform(0.0065, 0.0105, S) * np.interp(u, [0, 0.5, 1], [0.8, 1.0, 0.75])
        Kp = 5
        pts = np.zeros((S, Kp, 3))
        pts[:, 0] = roots
        dirs = unit(d + nrm * 0.45)
        sel = np.linalg.norm(P - face.E - (eye_info[side][0] - face.E), axis=1) < 1.0 * K
        coll = Collider(P[sel], N[sel])
        p = roots.copy()
        for i in range(1, Kp):
            dirs = unit(dirs * 0.6 + d * 0.4 - nrm * 0.25 + rng.normal(0, 0.08, dirs.shape))
            p = p + dirs * (L / (Kp - 1))[:, None]
            p, _ = coll.push_out(p, 0.00025 + 0.0006 * i / (Kp - 1))
            pts[:, i] = p
        col = np.array([0.040, 0.026, 0.017]) * rng.lognormal(0, 0.2, (S, 1))
        out_pts.append(pts)
        out_n.append(nrm)
        out_w.append(taper(Kp, np.full(S, 0.00016), np.full(S, 0.00003), S))
        out_c.append(col)
        out_root.append(np.repeat(roots, Kp * 2, axis=0))
    mesh = ribbons(np.concatenate(out_pts), np.concatenate(out_w), np.concatenate(out_n),
                   np.concatenate(out_c), twist_rng=rng)
    return (*mesh, np.concatenate(out_root))


# --------------------------------------------------------------- eyelashes
def eyelashes(mh, V, rng):
    """Grow lashes along the lid margins using MakeHuman's lash helper strips
    to find root line and outward direction."""
    pts_all, n_all, w_all, c_all, root_all = [], [], [], [], []
    for side in ('l', 'r'):
        for row, upper in (('2', True), ('1', False)):
            g = f'helper-{side}-eyelashes-{row}'
            f, _ = mh.group_faces(lambda x, g=g: x == g)
            hv = np.unique(f)
            H = V[hv]
            eye = V[np.unique(mh.group_faces(lambda x: x == f'helper-{side}-eye')[0])]
            ec = eye.mean(0)
            dist = np.linalg.norm(H - ec, axis=1)
            # bin the strip along x; the root edge is the vertex nearest the lid
            # margin (lowest y+z for the upper strip, lowest z-y for the lower)
            key = H[:, 2] + (H[:, 1] if upper else -H[:, 1])
            xs_ = np.linspace(H[:, 0].min(), H[:, 0].max(), 13)
            roots_c = []
            for x0, x1 in zip(xs_[:-1], xs_[1:]):
                m = (H[:, 0] >= x0) & (H[:, 0] <= x1 + 1e-9)
                if m.sum() < 1:
                    continue
                roots_c.append(H[m][np.argmin(key[m])])
            roots_c = np.array(roots_c)
            if roots_c[0, 0] > roots_c[-1, 0]:
                roots_c = roots_c[::-1]
            nl = 130 if upper else 45
            tt = np.sort(rng.uniform(0.02, 0.98, nl))
            xs = np.linspace(0, 1, len(roots_c))
            r = np.stack([np.interp(tt, xs, roots_c[:, k]) for k in range(3)], 1)
            radial = r - ec
            radial[:, 2] = 0
            radial = unit(radial)
            out = unit(np.array([0, 0, 1.0]) * 1.0 + radial * (0.42 if upper else 0.5))
            # length profile: longest a bit lateral of centre, short at corners
            lat = tt if (side == 'l') == (H[:, 0].mean() > 0) else 1 - tt
            prof = np.exp(-((lat - 0.62) / 0.36) ** 2)
            L = (0.0092 if upper else 0.0042) * (0.35 + 0.65 * prof) * rng.uniform(0.8, 1.1, nl)
            # clump lashes in small groups
            r += rng.normal(0, 0.00015, r.shape)
            curl = np.array([0.0, 1.0 if upper else -1.0, -0.15])
            Kp = 6
            pts = np.zeros((nl, Kp, 3))
            for i in range(Kp):
                s = i / (Kp - 1)
                pts[:, i] = r + out * (L * s)[:, None] + curl[None] * (L * s * s * 0.35)[:, None]
            pts[:, 1:] += rng.normal(0, 0.00008, pts[:, 1:].shape)
            nrm = unit(np.cross(out, np.cross(curl, out)) * 0 + np.array([0, 0, 1.0]))
            pts_all.append(pts)
            n_all.append(np.broadcast_to(nrm, (nl, 3)).copy())
            w_all.append(taper(Kp, np.full(nl, 0.00022 if upper else 0.00016), np.full(nl, 0.00002), nl, 0.8))
            c_all.append(np.tile([0.012, 0.009, 0.008], (nl, 1)))
            root_all.append(np.repeat(r, Kp * 2, axis=0))
    mesh = ribbons(np.concatenate(pts_all), np.concatenate(w_all), np.concatenate(n_all),
                   np.concatenate(c_all), twist_rng=None)
    return (*mesh, np.concatenate(root_all))


# ----------------------------------------------------------------- stubble
def stubble_strands(P, N, tris, eye_info, rng, count=26000):
    face = Face(eye_info)
    jaw_c = face.E + np.array([0, -0.9, 0.0]) * K

    def region(c):
        return np.linalg.norm(c - jaw_c, axis=1) < 1.3 * K
    cand, cn = sample_surface(P, N, tris, count * 4, rng, region)
    m = beard_mask(cand, cn, face)
    keep = rng.random(len(cand)) < m
    roots, nrm = cand[keep][:count], cn[keep][:count]
    S = len(roots)
    R = face.rel(roots)
    # beard grows downward, curving with the jaw; on the neck it is chaotic
    d = np.array([0.0, -1.0, 0.0]) + rng.normal(0, 0.45, (S, 3))
    d = unit(d - nrm * (d * nrm).sum(1, keepdims=True))
    L = rng.uniform(0.0007, 0.0018, S)
    Kp = 3
    pts = np.zeros((S, Kp, 3))
    for i in range(Kp):
        s = i / (Kp - 1)
        pts[:, i] = roots + (unit(d + nrm * 0.9) * (L * s)[:, None]) - nrm * 0.00005
    col = np.array([0.030, 0.020, 0.014]) * rng.lognormal(0, 0.3, (S, 1))
    grey = rng.random(S) < 0.06
    col[grey] = [0.30, 0.29, 0.27]
    mesh = ribbons(pts, taper(Kp, np.full(S, 0.00010), np.full(S, 0.00004), S), nrm, col)
    return (*mesh, np.repeat(roots, Kp * 2, axis=0))
