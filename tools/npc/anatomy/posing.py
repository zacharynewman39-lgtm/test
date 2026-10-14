"""Forward kinematics + linear blend skinning for the MakeHuman rig (rest
frames are world aligned, so a pose is a world rotation per bone)."""
import numpy as np


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def rot_between(a, b):
    a, b = unit(np.asarray(a, float)), unit(np.asarray(b, float))
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def axis_angle(ax, ang):
    ax = unit(np.asarray(ax, float))
    K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
    return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * K @ K


class Pose:
    def __init__(self, bones):
        self.bones = bones
        self.idx = {b['name']: i for i, b in enumerate(bones)}
        self.L = np.tile(np.eye(3), (len(bones), 1, 1))
        self.solve()

    def solve(self):
        n = len(self.bones)
        self.G = np.zeros((n, 3, 3))
        self.h = np.zeros((n, 3))
        for i, b in enumerate(self.bones):
            p = b['parent']
            if p is None:
                self.G[i] = self.L[i]
                self.h[i] = b['head']
            else:
                j = self.idx[p]
                self.G[i] = self.G[j] @ self.L[i]
                self.h[i] = self.h[j] + self.G[j] @ (b['head'] - self.bones[j]['head'])

    def point(self, name, rest_pt):
        """Where a rest-space point rigidly attached to bone `name` goes."""
        i = self.idx[name]
        return self.h[i] + self.G[i] @ (rest_pt - self.bones[i]['head'])

    def aim(self, name, rest_end, target_dir):
        """Rotate bone so (head -> rest_end, carried by the bone) points along target_dir."""
        i = self.idx[name]
        cur = self.point(name, rest_end) - self.h[i]
        R = rot_between(cur, target_dir)
        p = self.bones[i]['parent']
        Gp = self.G[self.idx[p]] if p else np.eye(3)
        self.L[i] = Gp.T @ R @ Gp @ self.L[i]
        self.solve()

    def twist(self, name, axis_world, angle):
        i = self.idx[name]
        p = self.bones[i]['parent']
        Gp = self.G[self.idx[p]] if p else np.eye(3)
        self.L[i] = Gp.T @ axis_angle(axis_world, angle) @ Gp @ self.L[i]
        self.solve()

    def matrices(self):
        """Per bone 3x4 affine: posed = G (rest - head) + h'."""
        heads = np.array([b['head'] for b in self.bones])
        t = self.h - np.einsum('nij,nj->ni', self.G, heads)
        return self.G, t

    def skin(self, P, W):
        G, t = self.matrices()
        out = np.zeros_like(P)
        nz = np.nonzero(W.any(0))[0]
        for b in nz:
            w = W[:, b]
            m = w > 0
            out[m] += w[m, None] * (P[m] @ G[b].T + t[b])
        return out

    def unskin(self, Pp, W):
        """Inverse LBS: rest = (sum w G)^-1 (posed - sum w t)."""
        G, t = self.matrices()
        M = np.einsum('nb,bij->nij', W, G)
        T = W @ t
        return np.einsum('nij,nj->ni', np.linalg.inv(M), Pp - T)
