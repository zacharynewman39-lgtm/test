"""Fit the BodyParts3D reference anatomy inside our NPC.

BodyParts3D is a 1.72 m man in anatomical position (arms down, palms
forward). Our NPC is 1.81 m in an A-pose bind pose. The fit is a
thin-plate-spline warp driven by:

  * joint landmarks computed on both sides (hip, knee, ankle, shoulder,
    elbow, wrist, every finger/thumb joint, toes, clavicles, skull, jaw, eyes),
  * small oriented frames around each limb segment so bones move almost
    rigidly with the A-pose rotation (and the forearm pronates),
  * the vertebral column mapped by sagittal depth between back and front skin,
then a second, smoother spline that pulls the warped reference skin onto
the NPC's skin so the whole interior follows his proportions.
"""
import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree

SIDES = (('Left', 'L', 1.0), ('Right', 'R', -1.0))
FINGERS = {2: 'index', 3: 'middle', 4: 'ring', 5: 'little'}
MC_ORD = {1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth'}


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def rot_between(a, b):
    a, b = unit(a), unit(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def axis_angle(ax, ang):
    ax = unit(ax)
    K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
    return np.eye(3) + np.sin(ang) * K + (1 - np.cos(ang)) * K @ K


def contact(PA, PB, tol=0.004):
    """Centre of the region where two bone meshes meet (a joint centre)."""
    d, _ = cKDTree(PB).query(PA)
    ca = PA[d < d.min() + tol].mean(0)
    d2, _ = cKDTree(PA).query(PB)
    cb = PB[d2 < d2.min() + tol].mean(0)
    return 0.5 * (ca + cb)


def sphere_fit(P):
    A = np.c_[2 * P, np.ones(len(P))]
    b = (P ** 2).sum(1)
    x = np.linalg.lstsq(A, b, rcond=None)[0]
    return x[:3]


def head_centre(bone, socket):
    """Femoral/humeral head centre: sphere fit to the bone near its socket."""
    d, _ = cKDTree(socket).query(bone)
    return sphere_fit(bone[d < d.min() + 0.012])


def tip(P, frm):
    d = np.linalg.norm(P - frm, axis=1)
    return P[np.argsort(-d)[:6]].mean(0)


class Landmarks:
    def __init__(self, A, body):
        self.A = A
        self.body = body
        self.B = {b['name']: b for b in body['bones']}
        self.src, self.dst, self.tag = [], [], []

    def m(self, name):
        return self.A.mesh(self.A.first(name))[0]

    def add(self, s, d, tag):
        self.src.append(np.asarray(s, float))
        self.dst.append(np.asarray(d, float))
        self.tag.append(tag)

    def bone(self, n, end='head'):
        return self.B[n][end]

    # ------------------------------------------------------------------
    def joints(self):
        J = {}
        for side, s, sg in SIDES:
            lo = side.lower()
            fem, hip, tib = self.m(f'{side} femur'), self.m(f'{side} hip bone'), self.m(f'{side} tibia')
            tal = self.m(f'{side} talus')
            hum, sca, uln, rad = self.m(f'{side} humerus'), self.m(f'{side} scapula'), self.m(f'{side} ulna'), self.m(f'{side} radius')
            J[f'hip.{s}'] = (head_centre(fem, hip), self.bone(f'upperleg01.{s}'))
            J[f'knee.{s}'] = (contact(fem, tib), self.bone(f'lowerleg01.{s}'))
            J[f'ankle.{s}'] = (contact(tib, tal), self.bone(f'foot.{s}'))
            for t, nm in ((1, 'big toe'), (2, 'second toe')):
                mt = self.m(f'{side} {MC_ORD[t]} metatarsal bone')
                pp = self.m(f'Proximal phalanx of {lo} {nm}')
                J[f'mtp{t}.{s}'] = (contact(mt, pp), self.bone(f'toe{t}-1.{s}'))
            J[f'shoulder.{s}'] = (head_centre(hum, sca), self.bone(f'upperarm01.{s}'))
            J[f'elbow.{s}'] = (contact(hum, uln), self.bone(f'lowerarm01.{s}'))
            J[f'wrist.{s}'] = (0.5 * (contact(rad, self.m(f'{side} scaphoid')) + contact(uln, self.m(f'{side} triquetral'))),
                               self.bone(f'wrist.{s}'))
            cla = self.m(f'{side} clavicle')
            J[f'sc.{s}'] = (contact(cla, self.m('Manubrium')), self.bone(f'clavicle.{s}'))
            J[f'ac.{s}'] = (contact(cla, sca), self.bone(f'clavicle.{s}', 'tail'))
            for f, nm in FINGERS.items():
                mc = self.m(f'{side} {MC_ORD[f]} metacarpal bone')
                pp = self.m(f'Proximal phalanx of {lo} {nm} finger')
                mp = self.m(f'Middle phalanx of {lo} {nm} finger')
                dp = self.m(f'Distal phalanx of {lo} {nm} finger')
                j1, j2, j3 = contact(mc, pp), contact(pp, mp), contact(mp, dp)
                J[f'f{f}-1.{s}'] = (j1, self.bone(f'finger{f}-1.{s}'))
                J[f'f{f}-2.{s}'] = (j2, self.bone(f'finger{f}-2.{s}'))
                J[f'f{f}-3.{s}'] = (j3, self.bone(f'finger{f}-3.{s}'))
                J[f'f{f}-tip.{s}'] = (tip(dp, j3), self.bone(f'finger{f}-3.{s}', 'tail'))
            mc1 = self.m(f'{side} first metacarpal bone')
            tp = self.m(f'Proximal phalanx of {lo} thumb')
            td = self.m(f'Distal phalanx of {lo} thumb')
            J[f'f1-1.{s}'] = (contact(self.m(f'{side} trapezium'), mc1), self.bone(f'finger1-1.{s}'))
            J[f'f1-2.{s}'] = (contact(mc1, tp), self.bone(f'finger1-2.{s}'))
            J[f'f1-3.{s}'] = (contact(tp, td), self.bone(f'finger1-3.{s}'))
            J[f'f1-tip.{s}'] = (tip(td, J[f'f1-3.{s}'][0]), self.bone(f'finger1-3.{s}', 'tail'))
            vit = self.m(f'{side} vitreous body')
            J[f'eye.{s}'] = (vit.mean(0), self.bone(f'eye.{s}'))
        occ, atl, man = self.m('Occipital bone'), self.m('Atlas'), self.m('Mandible')
        J['skull'] = (contact(occ, atl), self.bone('head'))
        tmj = [contact(man, self.m(f'{side} temporal bone')) for side, _, _ in SIDES]
        J['tmj'] = (0.5 * (tmj[0] + tmj[1]), self.bone('jaw'))
        front = man[man[:, 2] > man[:, 2].max() - 0.01]
        J['chin'] = (front[np.argmin(front[:, 1])], self.bone('jaw', 'tail'))
        top = np.concatenate([self.m('Left parietal bone'), self.m('Right parietal bone')])
        J['vertex'] = (top[np.argmax(top[:, 1])], self.bone('head', 'tail'))
        self.J = J
        for k, (a, b) in J.items():
            self.add(a, b, k)
        return J

    # ------------------------------------------------------------------
    def frames(self):
        """Oriented point frames around limb segments for near-rigid bones."""
        J = self.J
        segs = []
        for side, s, sg in SIDES:
            segs += [(f'hip.{s}', f'knee.{s}', 0.055, None), (f'knee.{s}', f'ankle.{s}', 0.045, None),
                     (f'ankle.{s}', f'mtp2.{s}', 0.03, None),
                     (f'shoulder.{s}', f'elbow.{s}', 0.04, None),
                     (f'elbow.{s}', f'wrist.{s}', 0.035, 'hand'),
                     (f'wrist.{s}', f'f3-1.{s}', 0.025, 'hand')]
        for a, b, r, tw in segs:
            sa, da = J[a]
            sb, db = J[b]
            R = rot_between(sb - sa, db - da)
            if tw == 'hand':
                s = a.split('.')[1]
                acr_s = J[f'f2-1.{s}'][0] - J[f'f5-1.{s}'][0]
                acr_d = J[f'f2-1.{s}'][1] - J[f'f5-1.{s}'][1]
                ax = unit(db - da)
                u = R @ acr_s
                u -= ax * (u @ ax)
                v = acr_d - ax * (acr_d @ ax)
                ang = np.arctan2(np.cross(unit(u), unit(v)) @ ax, unit(u) @ unit(v))
                R = axis_angle(ax, ang) @ R
            k = np.linalg.norm(db - da) / np.linalg.norm(sb - sa)
            axs = unit(sb - sa)
            p1 = unit(np.cross(axs, [0, 0, 1.0]) if abs(axs[2]) < 0.9 else np.cross(axs, [1.0, 0, 0]))
            p2 = np.cross(axs, p1)
            for t in (0.2, 0.5, 0.8):
                c_s = sa + (sb - sa) * t
                c_d = da + (db - da) * t
                for off in (p1 * r, -p1 * r, p2 * r, -p2 * r):
                    self.add(c_s + off, c_d + R @ off * k, f'frame:{a}')

    # ------------------------------------------------------------------
    def spine(self, bp_skin, mh_skin):
        """Vertebral bodies mapped by height fraction (hip line -> skull
        joint) and sagittal depth fraction between back and front skin."""
        J = self.J
        hs = 0.5 * (J['hip.L'][0] + J['hip.R'][0])
        hd = 0.5 * (J['hip.L'][1] + J['hip.R'][1])
        ts, td = J['skull']
        names = ['Sacrum', 'Fifth lumbar vertebra', 'Fourth lumbar vertebra', 'Third lumbar vertebra',
                 'Second lumbar vertebra', 'First lumbar vertebra'] + \
            [f'{o} thoracic vertebra' for o in ('Twelfth', 'Eleventh', 'Tenth', 'Ninth', 'Eighth', 'Seventh',
                                                'Sixth', 'Fifth', 'Fourth', 'Third', 'Second', 'First')] + \
            [f'{o} cervical vertebra' for o in ('Seventh', 'Sixth', 'Fifth', 'Fourth', 'Third')] + ['Axis', 'Atlas']
        def depth(skin, y):
            m = (np.abs(skin[:, 0]) < 0.02) & (np.abs(skin[:, 1] - y) < 0.012)
            return skin[m, 2].min(), skin[m, 2].max()
        for n in names:
            P = self.m(n)
            for q in (P.mean(0), P[P[:, 2] > np.percentile(P[:, 2], 80)].mean(0), P[P[:, 2] < np.percentile(P[:, 2], 15)].mean(0)):
                f = (q[1] - hs[1]) / (ts[1] - hs[1])
                yd = hd[1] + f * (td[1] - hd[1])
                b0, f0 = depth(bp_skin, q[1])
                b1, f1 = depth(mh_skin, yd)
                z = b1 + (q[2] - b0) / (f0 - b0) * (f1 - b1)
                self.add(q, [q[0] * (np.linalg.norm(hd - td) / np.linalg.norm(hs - ts)), yd, z], 'spine:' + n)
        # sternum and pubic symphysis anchor the front of the trunk
        for n in ('Manubrium', 'Body of sternum', 'Xiphoid process'):
            q = self.m(n).mean(0)
            f = (q[1] - hs[1]) / (ts[1] - hs[1])
            yd = hd[1] + f * (td[1] - hd[1])
            b0, f0 = depth(bp_skin, q[1])
            b1, f1 = depth(mh_skin, yd)
            self.add(q, [0, yd, b1 + (q[2] - b0) / (f0 - b0) * (f1 - b1)], 'sternum')


def pose_to_reference(L, body):
    """Pose the NPC rig so its limbs point the way the reference's do."""
    from posing import Pose
    J = L.J
    pose = Pose(body['bones'])
    B = L.B

    def aim(bone, end_key, a_key, b_key):
        pose.aim(bone, J[end_key][1], J[b_key][0] - J[a_key][0])

    for side, s, sg in SIDES:
        aim(f'clavicle.{s}', f'ac.{s}', f'sc.{s}', f'ac.{s}')
        aim(f'upperarm01.{s}', f'elbow.{s}', f'shoulder.{s}', f'elbow.{s}')
        aim(f'lowerarm01.{s}', f'wrist.{s}', f'elbow.{s}', f'wrist.{s}')
        # forearm twist: match the across-the-knuckles direction
        i = pose.idx
        ax = unit(pose.h[i[f'wrist.{s}']] - pose.h[i[f'lowerarm01.{s}']])
        acr = pose.h[i[f'finger2-1.{s}']] - pose.h[i[f'finger5-1.{s}']]
        tgt = J[f'f2-1.{s}'][0] - J[f'f5-1.{s}'][0]
        u = unit(acr - ax * (acr @ ax))
        v = unit(tgt - ax * (tgt @ ax))
        pose.twist(f'lowerarm01.{s}', ax, np.arctan2(np.cross(u, v) @ ax, u @ v))
        aim(f'wrist.{s}', f'f3-1.{s}', f'wrist.{s}', f'f3-1.{s}')
        for f in (2, 3, 4, 5, 1):
            aim(f'finger{f}-1.{s}', f'f{f}-2.{s}', f'f{f}-1.{s}', f'f{f}-2.{s}')
            aim(f'finger{f}-2.{s}', f'f{f}-3.{s}', f'f{f}-2.{s}', f'f{f}-3.{s}')
            aim(f'finger{f}-3.{s}', f'f{f}-tip.{s}', f'f{f}-3.{s}', f'f{f}-tip.{s}')
        aim(f'upperleg01.{s}', f'knee.{s}', f'hip.{s}', f'knee.{s}')
        aim(f'lowerleg01.{s}', f'ankle.{s}', f'knee.{s}', f'ankle.{s}')
        aim(f'foot.{s}', f'mtp2.{s}', f'ankle.{s}', f'mtp2.{s}')
    return pose


def posed_landmark(pose, bones, rest_pt):
    for b in bones:
        if np.allclose(b['head'], rest_pt, atol=1e-9):
            return pose.h[pose.idx[b['name']]]
    for b in bones:
        if np.allclose(b['tail'], rest_pt, atol=1e-9):
            return pose.point(b['name'], rest_pt)
    raise ValueError('landmark not on a bone end')


def fit(A, body, log=print):
    """Returns (warp: reference -> posed NPC space, pose, posed skin verts)."""
    import geom
    bp_skin = A.mesh(A.first('Skin'))[0]
    L = Landmarks(A, body)
    L.joints()
    pose = pose_to_reference(L, body)
    V, W = body['V'], body['W']
    Vp = pose.skin(V, W)
    fv = body['body_fv']
    tris = geom.quads_to_tris(fv)
    rng = np.random.default_rng(0)
    from harmonic import sample_surface
    skin_p, _ = sample_surface(Vp, tris, np.zeros((len(Vp), 1)), 4, rng)
    skin_p = np.concatenate([skin_p, Vp[np.unique(fv)]])
    src = [a for a, _ in L.J.values()]
    dst = [posed_landmark(pose, body['bones'], b) for _, b in L.J.values()]
    L.src, L.dst, L.tag = list(src), list(dst), list(L.J.keys())
    L.spine(bp_skin, skin_p)
    src, dst = np.array(L.src), np.array(L.dst)
    log('landmarks', len(src))
    warp1 = RBFInterpolator(src, dst - src, kernel='thin_plate_spline', smoothing=1e-6)
    sk = bp_skin[rng.choice(len(bp_skin), 3000, replace=False)]
    skw = sk + warp1(sk)
    d, i = cKDTree(skin_p).query(skw)
    ok = d < 0.05
    log('skin pairs', int(ok.sum()), 'median gap mm', round(float(np.median(d[ok]) * 1000), 1))
    pts2 = np.concatenate([skw[ok], dst])
    res2 = np.concatenate([skin_p[i[ok]] - skw[ok], np.zeros_like(dst)])
    warp2 = RBFInterpolator(pts2, res2, kernel='thin_plate_spline', smoothing=5e-4)

    def apply(P):
        out = np.empty_like(P)
        for k in range(0, len(P), 50000):
            q = P[k:k + 50000]
            q = q + warp1(q)
            out[k:k + 50000] = q + warp2(q)
        return out
    return apply, pose, Vp, L
