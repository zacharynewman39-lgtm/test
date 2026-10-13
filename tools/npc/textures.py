"""Bake the NPC's textures procedurally.

Skin maps are painted in the body's UV space: every texel is mapped back to
its 3D position/normal on the subdivided mesh, so features (lips, stubble,
wrinkles, nails ...) are placed anatomically. Also writes the iris/sclera
texture and tileable fabric/leather/pore detail maps.

Usage: python3 tools/npc/textures.py [--size 4096]
"""
import argparse
import os
import time

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

import hair as H
from hair import K, Face, smoothstep, unit

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'public', 'npc')


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


# ------------------------------------------------------------------ noise
def tile_noise(n, scale, rng, octaves=1, persistence=0.5):
    """Tileable band-limited noise via FFT filtering, unit variance."""
    out = np.zeros((n, n))
    amp = 1.0
    for o in range(octaves):
        f = np.fft.fftfreq(n)[:, None] ** 2 + np.fft.fftfreq(n)[None, :] ** 2
        s = scale / (2 ** o)
        filt = np.exp(-f * (s ** 2) * 2 * np.pi ** 2)
        w = np.fft.ifft2(np.fft.fft2(rng.normal(size=(n, n))) * filt).real
        out += amp * w / (w.std() + 1e-9)
        amp *= persistence
    return out / (out.std() + 1e-9)


class Noise3:
    """Smooth 3D value noise (trilinear lattice), deterministic."""

    def __init__(self, seed, size=64):
        self.g = np.random.default_rng(seed).random((size, size, size))
        self.n = size

    def __call__(self, p, freq):
        q = p * freq
        i = np.floor(q).astype(np.int64)
        f = q - i
        f = f * f * (3 - 2 * f)
        n = self.n
        out = 0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (f[..., 0] if dx else 1 - f[..., 0]) * (f[..., 1] if dy else 1 - f[..., 1]) * \
                        (f[..., 2] if dz else 1 - f[..., 2])
                    out = out + w * self.g[(i[..., 0] + dx) % n, (i[..., 1] + dy) % n, (i[..., 2] + dz) % n]
        return out * 2 - 1

    def fbm(self, p, freq, oct=4):
        s, a, tot = 0, 1, 0
        for o in range(oct):
            s = s + a * self(p + o * 17.3, freq * 2 ** o)
            tot += a
            a *= 0.5
        return s / tot


def height_to_normal(h, texel_m, strength=1.0, wrap=False):
    """Height (metres) -> tangent space normal (three.js derivative frame:
    +x along +u, +y along +v with flipY=false, i.e. down the image)."""
    if wrap:
        gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2
        gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2
    else:
        gy, gx = np.gradient(h)
    nx = -gx / texel_m[..., 0] * strength if np.ndim(texel_m) else -gx / texel_m * strength
    ny = -gy / texel_m[..., 1] * strength if np.ndim(texel_m) else -gy / texel_m * strength
    n = np.stack([nx, ny, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return ((n * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)


def save(img, name, q=92):
    path = os.path.join(OUT, name)
    im = Image.fromarray(img)
    if name.endswith('.jpg'):
        im.save(path, quality=q, subsampling=0 if q >= 95 else 2)
    else:
        im.save(path, optimize=True)
    log('wrote', name, os.path.getsize(path) // 1024, 'KiB')


def srgb(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


def lin(srgb_):
    c = np.asarray(srgb_, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# -------------------------------------------------------------- rasterise
def rasterize(uv, tris, size):
    """Triangle id per texel (-1 = empty) using PIL polygon fill."""
    img = Image.new('I', (size, size), -1)
    d = ImageDraw.Draw(img)
    px = uv * size
    for i, t in enumerate(tris):
        d.polygon([tuple(px[t[0]]), tuple(px[t[1]]), tuple(px[t[2]])], fill=i)
    return np.asarray(img, dtype=np.int64)


def barycentric(px, a, b, c):
    v0, v1, v2 = b - a, c - a, px - a
    d00 = (v0 * v0).sum(-1)
    d01 = (v0 * v1).sum(-1)
    d11 = (v1 * v1).sum(-1)
    d20 = (v2 * v0).sum(-1)
    d21 = (v2 * v1).sum(-1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) < 1e-14, 1e-14, den)
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    bc = np.stack([1 - v - w, v, w], -1)
    bc = np.clip(bc, 0, 1)
    return bc / bc.sum(-1, keepdims=True)


class Baker:
    def __init__(self, npz, size):
        self.size = size
        P = npz['body_pos']
        vpi = npz['body_vpi']
        uv = npz['body_uv'].copy()
        uv[:, 1] = 1 - uv[:, 1]  # glTF v (image rows)
        tris = npz['body_tris']
        q = npz['body_quads']
        from geom import vertex_normals, quads_to_tris
        N = vertex_normals(P, quads_to_tris(q))
        self.vP, self.vN = P, N
        log('rasterising', len(tris), 'triangles at', size)
        tid = rasterize(uv, tris, size)
        self.mask = tid >= 0
        ys, xs = np.nonzero(self.mask)
        self.ys, self.xs = ys, xs
        t = tris[tid[ys, xs]]
        pix = np.stack([(xs + 0.5) / size, (ys + 0.5) / size], -1)
        bc = barycentric(pix, uv[t[:, 0]], uv[t[:, 1]], uv[t[:, 2]])
        self.bc = bc
        self.tv = vpi[t]  # position-vertex ids of triangle corners
        self.P = (P[self.tv] * bc[..., None]).sum(1)
        self.N = unit((N[self.tv] * bc[..., None]).sum(1))
        # world size of one texel along u and v (for height -> normal)
        Pimg = np.zeros((size, size, 3))
        Pimg[ys, xs] = self.P
        Pimg = self.dilate(Pimg)
        du = np.linalg.norm(np.diff(Pimg, axis=1, append=Pimg[:, -1:]), axis=-1)
        dv = np.linalg.norm(np.diff(Pimg, axis=0, append=Pimg[-1:]), axis=-1)
        du = ndimage.median_filter(du, 5)
        dv = ndimage.median_filter(dv, 5)
        self.texel = np.stack([np.maximum(du, 1e-5), np.maximum(dv, 1e-5)], -1)

    def vattr(self, A):
        """Interpolate a per-position-vertex attribute to texels."""
        return (A[self.tv] * self.bc.reshape(self.bc.shape + (1,) * (A.ndim - 1))).sum(1)

    def image(self, vals, fill=0):
        shape = (self.size, self.size) + vals.shape[1:]
        img = np.full(shape, fill, dtype=float)
        img[self.ys, self.xs] = vals
        return img

    def dilate(self, img):
        _, (iy, ix) = ndimage.distance_transform_edt(~self.mask, return_indices=True)
        return img[iy, ix]


# ---------------------------------------------------------- per-vertex data
def vertex_obscurance(P, N, radius, k=48):
    tree = cKDTree(P)
    d, i = tree.query(P, k=k, distance_upper_bound=radius)
    valid = np.isfinite(d) & (d > 1e-6)
    i = np.where(valid, i, 0)
    v = P[i] - P[:, None]
    dist = np.maximum(np.linalg.norm(v, axis=-1), 1e-6)
    h = (v * N[:, None]).sum(-1) / dist
    w = valid * (1 - np.minimum(dist / radius, 1))
    return (np.maximum(h, 0) * w).sum(1) / np.maximum(w.sum(1), 1e-6)


def mouth_interior(P, N, face):
    R = face.rel(P)
    cm = np.array([0.0, -0.76, -0.32])
    box = (np.abs(R[:, 0]) < 0.38) & (R[:, 1] > -1.05) & (R[:, 1] < -0.45) & (R[:, 2] > -0.75) & (R[:, 2] < 0.40)
    d = ((R - cm) * N).sum(1)
    return (box & (d < 0)).astype(float)


# ------------------------------------------------------------------- skin
def bake_skin(npz, size, rng):
    B = Baker(npz, size)
    eye = {'L': (npz['eyeL'], float(npz['eye_r'])), 'R': (npz['eyeR'], float(npz['eye_r']))}
    face = Face(eye)
    P, N = B.P, B.N
    R = face.rel(P)
    X, Y, Z = np.abs(R[:, 0]), R[:, 1], R[:, 2]
    n3 = Noise3(3)
    names = list(npz['bone_names'])
    bh = dict(zip(names, npz['bone_heads']))
    bt = dict(zip(names, npz['bone_tails']))

    log('vertex AO / cavity')
    vP, vN = B.vP, B.vN
    occ_s = vertex_obscurance(vP, vN, 0.012)
    occ_l = vertex_obscurance(vP, vN, 0.035, k=96)
    interior = mouth_interior(vP, vN, face)
    occ_s, occ_l, interior = B.vattr(occ_s), B.vattr(occ_l), B.vattr(interior)

    near_head = np.linalg.norm(P - face.E, axis=1) < 2.4 * K
    lips = H.lips_mask(R) * near_head
    beard = H.beard_mask(P, N, face) * near_head
    scalp = H.scalp_density(P, face) * (np.linalg.norm(P - face.E, axis=1) < 2.6 * K)
    interior = np.clip(interior * 1.6, 0, 1) * near_head

    def blob(cx, cy, cz, sx, sy, sz, sym=True):
        x = X if sym else R[:, 0]
        return np.exp(-(((x - cx) / sx) ** 2 + ((Y - cy) / sy) ** 2 + ((Z - cz) / sz) ** 2))

    face_front = near_head * smoothstep(-0.6, 0.0, Z)
    # ears: lateral protrusions of the head
    ear = near_head * np.exp(-(((X - 0.72) / 0.14) ** 2 + ((Y + 0.05) / 0.36) ** 2 + ((Z + 0.80) / 0.32) ** 2))
    ear = smoothstep(0.2, 0.55, ear)

    # ---------------------------------------------------------- albedo
    log('albedo')
    base = lin([198, 158, 140])
    col = np.tile(base, (len(P), 1))
    # tan: face, neck, forearms and hands are a touch darker/warmer
    tan = smoothstep(-2.2, -1.2, Y) * near_head
    for s in ('L', 'R'):
        el, wr = bh['lowerarm01.' + s], bh['wrist.' + s]
        t = np.clip(((P - el) @ (wr - el)) / ((wr - el) @ (wr - el)), -0.5, 3)
        tan = np.maximum(tan, smoothstep(-0.2, 0.3, t))
    col *= (1 - 0.10 * tan)[:, None] * np.array([1.0, 0.97, 0.93])
    # hemoglobin: redness map
    red = 0.22 * blob(0.38, -0.30, 0.15, 0.22, 0.20, 0.3)          # cheeks
    red += 0.30 * blob(0.0, -0.40, 0.45, 0.10, 0.12, 0.2)           # nose tip
    red += 0.16 * blob(0.08, -0.30, 0.35, 0.10, 0.20, 0.2)          # nose wings
    red += 0.12 * blob(0.0, 0.45, 0.10, 0.45, 0.25, 0.3)            # forehead
    red += 0.12 * blob(0.0, -1.05, 0.10, 0.25, 0.15, 0.3)           # chin
    red += 0.35 * ear
    red += 0.20 * blob(0.24, 0.02, 0.05, 0.06, 0.05, 0.2)           # inner eye corners
    red += 0.18 * blob(0.30, 0.04, 0.08, 0.17, 0.07, 0.2)           # eyelids
    red *= near_head
    red += 0.25 * (n3.fbm(P, 22, 4) * 0.5 + 0.5) ** 2               # blotchiness
    red += 0.15 * smoothstep(0.3, 0.8, n3(P, 70))
    # knuckles, elbows, knees, palms, fingertips
    for s in ('L', 'R'):
        for f in range(1, 6):
            for j in (1, 2, 3):
                bnm = f'finger{f}-{j}.{s}'
                if bnm in bh:
                    red += 0.30 * np.exp(-(np.linalg.norm(P - bh[bnm], axis=1) / 0.009) ** 2)
                    if j == 3:
                        red += 0.28 * np.exp(-(np.linalg.norm(P - bt[bnm], axis=1) / 0.011) ** 2)
        red += 0.25 * np.exp(-(np.linalg.norm(P - bh['lowerarm01.' + s], axis=1) / 0.035) ** 2)
    blood = lin([180, 62, 58])
    col = col * (1 - 0.26 * red[:, None]) + blood * 0.26 * red[:, None] * (col / base).mean(1, keepdims=True)
    # melanin variation: freckles and a few moles on face / forearms
    mel = smoothstep(0.55, 0.9, n3(P, 900)) * (0.4 * near_head + 0.3 * tan)
    col *= (1 - 0.18 * mel[:, None] * np.array([0.8, 1.0, 1.15]))
    for c, r in (([0.46, -0.52, 0.10], 0.022), ([-0.28, -1.18, 0.05], 0.016),
                 ([0.62, 0.10, -0.40], 0.018), ([-0.05, 0.62, 0.15], 0.012)):
        m = np.exp(-(np.linalg.norm(R - np.array(c), axis=1) / r) ** 4) * near_head
        col = col * (1 - 0.55 * m[:, None]) + lin([92, 58, 44]) * 0.55 * m[:, None]
    # dark circles under the eyes (blue/purple), slight shadow in the sockets
    circ = blob(0.30, -0.14, 0.0, 0.16, 0.06, 0.25) * near_head * smoothstep(-0.25, -0.06, Y)
    col = col * (1 - 0.22 * circ[:, None]) + lin([110, 80, 95]) * 0.22 * circ[:, None]
    # temple veins
    veins = smoothstep(0.75, 0.95, 1 - np.abs(n3(P * np.array([1, 0.35, 1]), 140))) * blob(0.60, 0.25, -0.05, 0.12, 0.25, 0.3)
    col = col * (1 - 0.10 * veins[:, None]) + lin([120, 120, 150]) * 0.10 * veins[:, None]
    # stubble: bluish-grey shadow plus individual follicles
    fol = smoothstep(0.35, 0.75, n3(P, 2600) * 0.6 + n3(P + 3.1, 4100) * 0.6)
    beard_d = beard * (0.55 + 0.45 * fol)
    stub = lin([74, 66, 62])
    col = col * (1 - 0.68 * beard_d[:, None]) + stub * 0.68 * beard_d[:, None]
    # pores read as tiny darker specks on the face
    pore = smoothstep(0.55, 0.85, n3(P, 5200)) * face_front * (1 - lips)
    col *= (1 - 0.10 * pore)[:, None]
    # scalp under the hair: dark roots
    sc = scalp * (0.6 + 0.4 * fol)
    col = col * (1 - 0.82 * sc[:, None]) + lin([42, 32, 26]) * 0.82 * sc[:, None]
    # skin under the brows
    browz = np.zeros(len(P))
    for s, sg in (('L', 1), ('R', -1)):
        ec = face.rel(eye[s][0])
        u = ((R[:, 0] - ec[0]) * sg + 0.215) / 0.62
        yc = np.interp(u, [0, 0.3, 0.62, 1.0], [0.125, 0.165, 0.195, 0.150])
        th = np.interp(u, [0, 0.3, 0.62, 1.0], [0.115, 0.105, 0.080, 0.030])
        browz = np.maximum(browz, smoothstep(0.6, 0.3, np.abs(Y - yc) / th) * smoothstep(-0.05, 0.05, u) * smoothstep(1.05, 0.92, u))
    browz *= face_front
    col = col * (1 - 0.35 * browz[:, None]) + lin([70, 50, 40]) * 0.35 * browz[:, None]
    # forearm hair darkening (fine body hair)
    arms = np.zeros(len(P))
    for s in ('L', 'R'):
        el, wr = bh['lowerarm01.' + s], bh['wrist.' + s]
        t = ((P - el) @ (wr - el)) / ((wr - el) @ (wr - el))
        arms = np.maximum(arms, smoothstep(-0.1, 0.2, t) * smoothstep(1.05, 0.85, t))
    arms *= smoothstep(0.55, 0.8, n3(P, 3000) * 0.5 + 0.5) * 0.6
    col *= (1 - 0.25 * arms)[:, None]
    # lips: vermilion with fine vertical striations, darker at the seam
    stri = 0.5 + 0.5 * np.sin(R[:, 0] / 0.012 * np.pi + n3(P, 600) * 2.0)
    lipcol = lin([168, 92, 86]) * (0.92 + 0.12 * stri)[:, None]
    seam = np.exp(-((Y + 0.762) / 0.018) ** 2) * smoothstep(0.27, 0.15, X)
    lipcol *= (1 - 0.35 * seam)[:, None]
    border = lips * (1 - lips) * 4
    col = col * (1 - lips[:, None]) + lipcol * lips[:, None]
    col *= (1 + 0.06 * border)[:, None]
    # mouth interior
    col = col * (1 - interior[:, None]) + lin([120, 40, 42]) * interior[:, None]
    # nails
    nails = np.zeros(len(P))
    lunula = np.zeros(len(P))
    for s in ('L', 'R'):
        mc = bh['metacarpal2.' + s]
        hand_c = (bh['wrist.' + s] + bh['finger3-1.' + s]) / 2
        # dorsal direction: average normal of the back of the hand
        near = np.linalg.norm(vP - hand_c, axis=1) < 0.03
        dn = unit(vN[near].mean(0) if near.any() else np.array([0, 1.0, 0]))
        # choose the side whose normals are more 'up' in the A-pose
        if dn[1] < 0:
            dn = -dn
        for f in range(1, 6):
            bnm = f'finger{f}-3.{s}'
            if bnm not in bh:
                continue
            a, b = bh[bnm], bt[bnm]
            ax = b - a
            L = np.linalg.norm(ax)
            t = ((P - a) @ ax) / (L * L)
            rad = np.linalg.norm(P - a - np.outer(t, ax), axis=1)
            side_ = unit(np.cross(ax, dn))
            lat = np.abs((P - a - np.outer(t, ax)) @ side_)
            dors = (N @ dn)
            m = smoothstep(0.30, 0.42, t) * smoothstep(1.12, 1.0, t) * smoothstep(0.35, 0.65, dors) \
                * smoothstep(0.0062, 0.0050, lat) * (rad < 0.02)
            nails = np.maximum(nails, m)
            lunula = np.maximum(lunula, m * smoothstep(0.48, 0.38, t))
    nailcol = lin([214, 168, 160])
    col = col * (1 - nails[:, None]) + nailcol * nails[:, None]
    col = col * (1 - 0.5 * lunula[:, None]) + lin([232, 215, 205]) * 0.5 * lunula[:, None]
    tip = nails * 0  # free edge kept implicit
    # cavity darkening baked lightly into albedo (rest goes to AO)
    col *= (1 - 0.35 * np.clip(occ_s * 2.2, 0, 1))[:, None]
    col *= (1 - 0.2 * np.clip(occ_l * 2.0, 0, 1))[:, None]

    # --------------------------------------------------- height/wrinkles
    log('wrinkles')
    h = np.zeros(len(P))

    def lines(coord, period, depth, width, mask):
        ph = coord / period
        d = np.abs(ph - np.round(ph)) * period
        return -depth * np.exp(-(d / width) ** 2) * mask

    nn = n3(P, 120) * 0.02
    # forehead: horizontal lines
    fh = blob(0.0, 0.48, 0.15, 0.42, 0.16, 0.4) * face_front * smoothstep(0.75, 0.62, Y)
    h += lines(Y + 0.03 * np.cos(R[:, 0] * 3) + nn * 2.5, 0.07, 0.00009, 0.007, fh * (0.6 + 0.4 * n3(P, 60)))
    # glabella: two vertical lines
    gl = blob(0.035, 0.22, 0.25, 0.03, 0.06, 0.3) * face_front
    h += -0.00022 * gl
    # crow's feet
    for s, sg in (('L', 1), ('R', -1)):
        ec = face.rel(eye[s][0])
        lc = ec + np.array([0.20 * sg, 0.0, -0.1])
        v = R - lc
        ang = np.arctan2(v[:, 1], np.abs(v[:, 0]))
        rr = np.linalg.norm(v[:, :2], axis=1)
        m = smoothstep(0.02, 0.06, rr) * smoothstep(0.22, 0.10, rr) * (R[:, 0] * sg > ec[0] * sg + 0.12) * face_front
        h += lines(ang + nn * 3, 0.32, 0.00009, 0.04, m)
        # under-eye fine lines and the tear trough
        ue = np.exp(-(((R[:, 0] - ec[0]) / 0.16) ** 2 + ((Y + 0.13) / 0.04) ** 2)) * face_front
        h += lines(Y + 0.02 * np.sin(R[:, 0] * 30), 0.025, 0.00008, 0.004, ue)
        tt = np.exp(-(((R[:, 0] - ec[0] + 0.08 * sg) / 0.10) ** 2 + ((Y + 0.20 + 0.15 * (R[:, 0] * sg - ec[0] * sg)) / 0.03) ** 2))
        h += -0.00030 * tt * face_front
    # nasolabial folds
    for sg in (1, -1):
        a = np.array([0.20, -0.45])
        b = np.array([0.31, -0.80])
        p2 = np.stack([X, Y], 1)
        ab = b - a
        t = np.clip(((p2 - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(p2 - (a + np.outer(t, ab)), axis=1)
        h += -0.00045 * np.exp(-(d / 0.022) ** 2) * face_front * (R[:, 0] * sg > 0)
    # neck rings
    neck = smoothstep(-2.4, -2.0, Y) * smoothstep(-1.2, -1.5, Y) * near_head
    h += lines(Y + 0.03 * np.sin(R[:, 0] * 6) + nn, 0.30, 0.00025, 0.012, neck * smoothstep(-0.3, 0.3, Z))
    # lips striations
    h += -0.00006 * stri * lips
    # knuckle creases (dorsal transverse)
    for s in ('L', 'R'):
        for f in range(1, 6):
            for j in (2, 3):
                bnm = f'finger{f}-{j}.{s}'
                if bnm not in bh:
                    continue
                jp = bh[bnm]
                ax = unit(bt[bnm] - bh[bnm])
                along = (P - jp) @ ax
                near = np.linalg.norm(P - jp, axis=1) < 0.014
                h += lines(along, 0.0022, 0.00007, 0.0005, near * smoothstep(0.006, 0.0, np.abs(along)))
    # skin micro relief: body-wide subtle bumpiness
    h += 0.00004 * n3.fbm(P, 400, 3)
    h -= 0.00006 * np.clip(occ_s * 2, 0, 1)

    # --------------------------------------------------------- ORM maps
    rough = np.full(len(P), 0.52)
    tz = blob(0.0, 0.45, 0.15, 0.25, 0.25, 0.4) + blob(0.0, -0.25, 0.4, 0.09, 0.30, 0.3)
    rough -= 0.14 * np.clip(tz * face_front, 0, 1)
    rough += 0.10 * beard + 0.12 * scalp
    rough = rough * (1 - lips) + 0.32 * lips
    rough = rough * (1 - interior) + 0.18 * interior
    rough = rough * (1 - nails) + 0.22 * nails
    rough += 0.04 * n3(P, 200)
    ao = 1 - np.clip(occ_s * 1.6 + occ_l * 1.3, 0, 0.85)
    ao = ao * (1 - 0.6 * interior)
    thin = 0.85 * ear + 0.35 * blob(0.12, -0.38, 0.35, 0.06, 0.06, 0.2) + 0.25 * blob(0.0, -0.40, 0.45, 0.06, 0.06, 0.2)
    thin += 0.25 * blob(0.30, 0.04, 0.08, 0.17, 0.06, 0.2)  # eyelids
    for s in ('L', 'R'):
        for f in range(1, 6):
            for j in (1, 2, 3):
                bnm = f'finger{f}-{j}.{s}'
                if bnm in bh:
                    thin += 0.25 * np.exp(-(np.linalg.norm(P - bh[bnm], axis=1) / 0.012) ** 2)
    thin = np.clip(thin, 0, 1)

    # ---------------------------------------------------------- write
    log('writing skin maps')
    alb = B.dilate(B.image(srgb(col)))
    save((alb * 255).clip(0, 255).astype(np.uint8), 'skin_albedo.jpg', 92)
    himg = B.dilate(B.image(h))
    himg = ndimage.gaussian_filter(himg, 0.7)
    nrm = height_to_normal(himg, B.texel, 1.0)
    save(nrm, 'skin_normal.jpg', 93)
    orm = np.stack([B.dilate(B.image(ao, 1)), B.dilate(B.image(np.clip(rough, 0.1, 1), 0.5)),
                    B.dilate(B.image(thin))], -1)
    orm_img = Image.fromarray((orm * 255).clip(0, 255).astype(np.uint8)).resize((size // 2, size // 2), Image.LANCZOS)
    orm_img.save(os.path.join(OUT, 'skin_orm.jpg'), quality=92)
    log('wrote skin_orm.jpg')


# ---------------------------------------------------------- detail tiles
def pore_tile(rng, n=512):
    h = np.zeros((n, n))
    # pores: small soft dents at jittered positions
    yy, xx = np.mgrid[0:n, 0:n]
    count = 220
    pts = rng.random((count, 2)) * n
    rad = rng.uniform(1.6, 3.2, count)
    for (px, py), r in zip(pts, rad):
        dx = (xx - px + n / 2) % n - n / 2
        dy = (yy - py + n / 2) % n - n / 2
        h -= np.exp(-(dx ** 2 + dy ** 2) / (r * r)) * rng.uniform(0.6, 1.0)
    # skin furrows: two crossing sets of fine grooves (diamond pattern)
    for ang in (0.6, -0.55, 1.6):
        g = tile_noise(n, 1.2, rng)
        d = np.cos(ang) * xx + np.sin(ang) * yy
        f = np.sin(d / n * 2 * np.pi * 22 + tile_noise(n, 30, rng) * 2.5)
        h -= 0.35 * np.clip(f, 0.6, 1) * (0.5 + 0.5 * tile_noise(n, 40, rng))
    h += 0.25 * tile_noise(n, 3, rng)
    h = (h - h.mean()) / h.std()
    return height_to_normal(h * 0.12, np.array(1.0), 1.0, wrap=True)


def knit_tile(rng, n=256):
    # jersey knit: columns of V-shaped loops
    yy, xx = np.mgrid[0:n, 0:n] / n
    cols, rows = 16, 22
    u = (xx * cols) % 1.0
    v = (yy * rows) % 1.0
    vshape = np.abs(u - 0.5) * 2
    loop = np.exp(-((v - vshape * 0.5 - 0.25) / 0.18) ** 2) * (1 - (2 * np.abs(u - 0.5)) ** 4)
    loop2 = np.exp(-((v - vshape * 0.5 - 0.75) / 0.18) ** 2) * (1 - (2 * np.abs(u - 0.5)) ** 4)
    h = loop + loop2 + 0.15 * tile_noise(n, 2, rng)
    return height_to_normal(h * 0.4, np.array(1.0), 1.0, wrap=True)


def denim_tiles(rng, n=512):
    """3x1 right-hand twill: indigo warp over ecru weft."""
    yy, xx = np.mgrid[0:n, 0:n]
    threads = 64
    tx = xx * threads / n
    ty = yy * threads / n
    ix, iy = np.floor(tx).astype(int), np.floor(ty).astype(int)
    fx, fy = tx - ix, ty - iy
    warp_up = ((ix - iy) % 4) != 0  # warp floats over 3 picks
    # slub: thickness/colour variation per warp yarn along its length
    slub = tile_noise(n, 6, rng) * 0.5 + np.repeat(rng.normal(0, 1, threads), n // threads)[None, :] * 0.5
    warp_col = lin([16, 28, 68]) * (1 + 0.18 * slub[..., None])
    warp_col *= (1 + 0.25 * np.clip(tile_noise(n, 1.5, rng), 0, None))[..., None]  # ring-dyed highlights
    weft_col = lin([168, 164, 150]) * (1 + 0.08 * tile_noise(n, 3, rng))[..., None]
    prof_w = np.sin(fx * np.pi) ** 0.6
    prof_f = np.sin(fy * np.pi) ** 0.6
    col = np.where(warp_up[..., None], warp_col, weft_col * 0.85 + warp_col * 0.15)
    col *= (0.75 + 0.25 * np.where(warp_up, prof_w, prof_f))[..., None]
    h = np.where(warp_up, prof_w, prof_f * 0.85) + 0.1 * tile_noise(n, 2, rng)
    alb = (srgb(col) * 255).clip(0, 255).astype(np.uint8)
    return alb, height_to_normal(h * 0.5, np.array(1.0), 1.0, wrap=True)


def leather_tile(rng, n=512):
    # pebbled grain: cellular-ish bumps from thresholded noise + creases
    a = tile_noise(n, 4, rng)
    b = tile_noise(n, 1.5, rng)
    h = -np.abs(a) * 0.8 + 0.15 * b
    h += -0.6 * np.exp(-(tile_noise(n, 20, rng) / 0.08) ** 2)
    return height_to_normal(h * 0.5, np.array(1.0), 1.0, wrap=True)


# --------------------------------------------------------------------- eye
def eye_texture(rng, n=2048):
    centres = [(0.2917, 0.7101), (0.7059, 0.2954)]
    yy, xx = (np.mgrid[0:n, 0:n] + 0.5) / n
    img = np.zeros((n, n, 3))
    # sclera: off-white, warmer/greyer towards the back, with veins
    d_all = np.minimum(np.hypot(xx - centres[0][0], yy - centres[0][1]),
                       np.hypot(xx - centres[1][0], yy - centres[1][1]))
    sclera = lin([236, 228, 222]) * (1 - 0.12 * smoothstep(0.13, 0.30, d_all))[..., None]
    sclera = sclera * (1 - 0.05 * smoothstep(0.15, 0.3, d_all))[..., None] + \
        lin([226, 210, 190]) * 0.05 * smoothstep(0.15, 0.3, d_all)[..., None]
    img[:] = sclera
    # veins: thin meandering lines growing inward from the periphery
    vein = np.zeros((n, n))
    for (cx, cy) in centres:
        for k in range(26):
            ang = rng.uniform(0, 2 * np.pi)
            r = rng.uniform(0.26, 0.30)
            x, y = cx + r * np.cos(ang), cy + r * np.sin(ang)
            w = rng.uniform(0.6, 1.6)
            steps = int(rng.uniform(40, 120))
            for s in range(steps):
                dx, dy = cx - x, cy - y
                dl = np.hypot(dx, dy)
                if dl < 0.135:
                    break
                ang2 = np.arctan2(dy, dx) + rng.normal(0, 0.9)
                x += np.cos(ang2) * 0.0016
                y += np.sin(ang2) * 0.0016
                ix, iy = int(x * n), int(y * n)
                if 0 <= ix < n and 0 <= iy < n:
                    rr = max(1, int(w * (1 - s / steps) * 2))
                    vein[max(0, iy - rr):iy + rr, max(0, ix - rr):ix + rr] += 0.6 * (1 - s / steps)
    vein = ndimage.gaussian_filter(np.clip(vein, 0, 1), 1.2)
    img = img * (1 - 0.45 * vein[..., None]) + lin([170, 60, 60]) * 0.45 * vein[..., None]
    for (cx, cy) in centres:
        dx, dy = xx - cx, yy - cy
        r = np.hypot(dx, dy)
        a = np.arctan2(dy, dx)
        R_IRIS, R_PUP = 0.112, 0.034
        t = np.clip((r - R_PUP) / (R_IRIS - R_PUP), 0, 1)
        # fibres
        fib = np.zeros_like(r)
        for f, amp in ((90, 0.5), (210, 0.35), (420, 0.2)):
            ph = rng.uniform(0, 6.28, 8)
            fib += amp * np.sin(a * f + 3 * np.sin(a * 7 + ph[0]) + t * 4 * np.sin(a * 3 + ph[1]))
        fib = fib * 0.5 + 0.5
        # colour: blue-grey/green outer iris, amber-brown collarette
        outer = lin([96, 118, 112])
        mid = lin([118, 128, 96])
        inner = lin([148, 104, 52])
        coll = smoothstep(0.42, 0.30, t)
        c = outer * (1 - smoothstep(0.35, 0.75, 1 - t))[..., None] + mid * smoothstep(0.35, 0.75, 1 - t)[..., None]
        c = c * (1 - coll[..., None]) + inner * coll[..., None]
        c *= (0.62 + 0.55 * fib)[..., None]
        # crypts: dark lacunae
        crypt = np.zeros_like(r)
        for k in range(40):
            ca = rng.uniform(0, 2 * np.pi)
            ct = rng.uniform(0.25, 0.85)
            cr = R_PUP + ct * (R_IRIS - R_PUP)
            px, py = cx + cr * np.cos(ca), cy + cr * np.sin(ca)
            crypt += np.exp(-(((xx - px) ** 2 + (yy - py) ** 2) / (rng.uniform(0.002, 0.005) ** 2)))
        c *= (1 - 0.45 * np.clip(crypt, 0, 1))[..., None]
        # collarette ridge and limbal ring
        c *= (1 + 0.25 * np.exp(-((t - 0.36) / 0.04) ** 2))[..., None]
        limb = smoothstep(0.75, 1.0, t)
        c *= (1 - 0.65 * limb)[..., None]
        iris = smoothstep(R_IRIS + 0.006, R_IRIS - 0.004, r)
        pupil = smoothstep(R_PUP + 0.003, R_PUP - 0.002, r)
        c = c * (1 - pupil[..., None]) + lin([4, 4, 5]) * pupil[..., None]
        img = img * (1 - iris[..., None]) + c * iris[..., None]
        # limbal shadow on the sclera just outside the iris
        ls = np.exp(-((r - R_IRIS - 0.004) / 0.008) ** 2) * (r > R_IRIS)
        img *= (1 - 0.25 * ls)[..., None]
    return (srgb(img) * 255).clip(0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=4096)
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    rng = np.random.default_rng(11)
    npz = np.load(os.path.join(HERE, '.cache_body.npz'))
    only = args.only.split(',') if args.only else None
    if not only or 'tiles' in only:
        save(pore_tile(rng), 'skin_detail_normal.png')
        save(knit_tile(rng), 'knit_normal.png')
        a, nn = denim_tiles(rng)
        save(a, 'denim_albedo.jpg', 92)
        save(nn, 'denim_normal.png')
        save(leather_tile(rng), 'leather_normal.png')
    if not only or 'eye' in only:
        save(eye_texture(rng), 'eye.jpg', 92)
    if not only or 'skin' in only:
        bake_skin(npz, args.size, rng)


if __name__ == '__main__':
    main()
