"""Skin weights for the body's interior.

The skin's bone weights are fixed on a voxelised shell of the body and
diffused inward by solving Laplace's equation, so a point deep in the chest
blends spine/clavicle/rib-cage bones smoothly and a point in the thigh
follows the femur, exactly continuous with the skin above it."""
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy import ndimage


def sample_surface(P, tris, W, per_tri, rng):
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    u = rng.random((len(tris), per_tri))
    v = rng.random((len(tris), per_tri))
    f = u + v > 1
    u[f], v[f] = 1 - u[f], 1 - v[f]
    w0 = 1 - u - v
    pts = P[a][:, None] * w0[..., None] + P[b][:, None] * u[..., None] + P[c][:, None] * v[..., None]
    ws = W[a][:, None] * w0[..., None] + W[b][:, None] * u[..., None] + W[c][:, None] * v[..., None]
    return pts.reshape(-1, 3), ws.reshape(-1, W.shape[1])


class InteriorWeights:
    def __init__(self, P, tris, W, h=0.008, log=print):
        rng = np.random.default_rng(0)
        self.h = h
        lo = P.min(0) - 3 * h
        hi = P.max(0) + 3 * h
        self.lo = lo
        shape = np.ceil((hi - lo) / h).astype(int) + 1
        self.shape = shape
        cols = np.nonzero(W.max(0) > 0.02)[0]
        self.cols = cols
        Wc = W[:, cols]
        edge = np.linalg.norm(P[tris[:, 1]] - P[tris[:, 0]], axis=1).max()
        per = int(np.clip((edge / (h * 0.4)) ** 2, 6, 60))
        pts, ws = sample_surface(P, tris, Wc, per, rng)
        ijk = np.floor((pts - lo) / h).astype(int)
        flat = np.ravel_multi_index(ijk.T, shape)
        n = int(np.prod(shape))
        cnt = np.bincount(flat, minlength=n).astype(float)
        surf = cnt > 0
        acc = np.zeros((n, len(cols)), np.float32)
        np.add.at(acc, flat, ws.astype(np.float32))
        acc[surf] /= cnt[surf, None]
        # exterior = connected to the grid corner through non-surface voxels
        closed = ndimage.binary_closing(surf.reshape(shape), iterations=1) | surf.reshape(shape)
        closed = ndimage.binary_dilation(closed, iterations=1)
        lab, _ = ndimage.label(~closed)
        exterior = (lab == lab[0, 0, 0]).ravel()
        interior = ~exterior & ~surf
        log('voxels', shape, 'surface', int(surf.sum()), 'interior', int(interior.sum()))
        # Laplace system on interior voxels, surface voxels are Dirichlet
        ids = -np.ones(n, int)
        ids[interior] = np.arange(interior.sum())
        coords = np.array(np.unravel_index(np.nonzero(interior)[0], shape)).T
        rows, colsA, vals = [], [], []
        rhs = np.zeros((interior.sum(), len(cols)), np.float64)
        diag = np.zeros(interior.sum())
        for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
            nb = coords + d
            okb = np.all((nb >= 0) & (nb < shape), 1)
            fn = np.full(len(nb), -1)
            fn[okb] = np.ravel_multi_index(nb[okb].T, shape)
            inner = okb & (ids[np.maximum(fn, 0)] >= 0)
            onsurf = okb & surf[np.maximum(fn, 0)]
            r = np.nonzero(inner)[0]
            rows.append(r)
            colsA.append(ids[fn[inner]])
            vals.append(-np.ones(len(r)))
            rs = np.nonzero(onsurf)[0]
            rhs[rs] += acc[fn[onsurf]]
            diag += inner + onsurf
        A = sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(colsA))),
                          shape=(len(diag), len(diag))) + sp.diags(np.maximum(diag, 1))
        log('solving laplace', A.shape, 'for', len(cols), 'bones')
        solve = spla.factorized(A.tocsc())
        sol = np.zeros_like(rhs)
        for k in range(len(cols)):
            if rhs[:, k].any():
                sol[:, k] = solve(rhs[:, k])
        grid = acc
        grid[interior] = sol.astype(np.float32)
        # fill the exterior by nearest known voxel so lookups just outside work
        known = (interior | surf).reshape(shape)
        _, ind = ndimage.distance_transform_edt(~known, return_indices=True)
        nearest = np.ravel_multi_index(ind.reshape(3, -1), shape)
        self.grid = grid[nearest]
        self.nb = W.shape[1]

    def __call__(self, Q):
        """Trilinear weights at points Q -> dense (len(Q), n_bones)."""
        f = (Q - self.lo) / self.h - 0.5
        i0 = np.clip(np.floor(f).astype(int), 0, self.shape - 2)
        t = np.clip(f - i0, 0, 1)
        out = np.zeros((len(Q), len(self.cols)), np.float32)
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (t[:, 0] if dx else 1 - t[:, 0]) * (t[:, 1] if dy else 1 - t[:, 1]) * (t[:, 2] if dz else 1 - t[:, 2])
                    flat = np.ravel_multi_index((i0[:, 0] + dx, i0[:, 1] + dy, i0[:, 2] + dz), self.shape)
                    out += w[:, None] * self.grid[flat]
        full = np.zeros((len(Q), self.nb), np.float32)
        full[:, self.cols] = np.maximum(out, 0)
        s = full.sum(1, keepdims=True)
        return full / np.maximum(s, 1e-9)
