import * as THREE from 'three';

// Position-based (Verlet) ragdoll driven straight onto the NPC skeleton.
// Particles sit at the joints with segment masses; distance constraints keep
// bone lengths, cross-bracing keeps the trunk rigid, hinge constraints stop
// knees/elbows bending backwards, neck/spine ranges are limited, and the
// ground has friction. Bone rotations are rebuilt from the particles each
// step so the skinned body (and everything inside it) follows.

const J = {
  pelvis: { bone: 'root', m: 11, r: 0.11 }, belly: { bone: 'spine03', m: 9, r: 0.11 }, chest: { bone: 'spine01', m: 13, r: 0.12 },
  neck: { bone: 'neck02', m: 2, r: 0.05 }, head: { bone: 'head', tail: true, m: 5, r: 0.1 },
  shoL: { bone: 'upperarm01.L', m: 2.5, r: 0.05 }, shoR: { bone: 'upperarm01.R', m: 2.5, r: 0.05 },
  elbL: { bone: 'lowerarm01.L', m: 1.6, r: 0.04 }, elbR: { bone: 'lowerarm01.R', m: 1.6, r: 0.04 },
  wriL: { bone: 'wrist.L', m: 0.8, r: 0.035 }, wriR: { bone: 'wrist.R', m: 0.8, r: 0.035 },
  hanL: { bone: 'finger3-2.L', m: 0.4, r: 0.03 }, hanR: { bone: 'finger3-2.R', m: 0.4, r: 0.03 },
  hipL: { bone: 'upperleg01.L', m: 8, r: 0.08 }, hipR: { bone: 'upperleg01.R', m: 8, r: 0.08 },
  kneL: { bone: 'lowerleg01.L', m: 3.8, r: 0.055 }, kneR: { bone: 'lowerleg01.R', m: 3.8, r: 0.055 },
  ankL: { bone: 'foot.L', m: 1.2, r: 0.045 }, ankR: { bone: 'foot.R', m: 1.2, r: 0.045 },
  toeL: { bone: 'toe2-1.L', m: 0.4, r: 0.03 }, toeR: { bone: 'toe2-1.R', m: 0.4, r: 0.03 },
};
const LINKS = [
  ['pelvis', 'belly'], ['belly', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'shoL'], ['chest', 'shoR'], ['shoL', 'shoR'], ['neck', 'shoL'], ['neck', 'shoR'],
  ['belly', 'shoL', 0.4], ['belly', 'shoR', 0.4], ['pelvis', 'chest', 0.25], ['head', 'chest', 0.35],
  ['shoL', 'elbL'], ['elbL', 'wriL'], ['wriL', 'hanL'], ['shoR', 'elbR'], ['elbR', 'wriR'], ['wriR', 'hanR'],
  ['pelvis', 'hipL'], ['pelvis', 'hipR'], ['hipL', 'hipR'], ['belly', 'hipL'], ['belly', 'hipR'],
  ['hipL', 'kneL'], ['kneL', 'ankL'], ['ankL', 'toeL'], ['hipR', 'kneR'], ['kneR', 'ankR'], ['ankR', 'toeR'],
  ['kneL', 'toeL', 0.5], ['kneR', 'toeR', 0.5],
];
// bone -> [from particle, to particle] used to orient limb bones
const LIMB = {
  'upperarm01.L': ['shoL', 'elbL'], 'lowerarm01.L': ['elbL', 'wriL'], 'wrist.L': ['wriL', 'hanL'],
  'upperarm01.R': ['shoR', 'elbR'], 'lowerarm01.R': ['elbR', 'wriR'], 'wrist.R': ['wriR', 'hanR'],
  'upperleg01.L': ['hipL', 'kneL'], 'lowerleg01.L': ['kneL', 'ankL'], 'foot.L': ['ankL', 'toeL'],
  'upperleg01.R': ['hipR', 'kneR'], 'lowerleg01.R': ['kneR', 'ankR'], 'foot.R': ['ankR', 'toeR'],
};
const RESET_LOCAL = ['spine05', 'spine04', 'spine03', 'spine02', 'neck01', 'neck03', 'upperarm02.L', 'upperarm02.R',
  'lowerarm02.L', 'lowerarm02.R', 'upperleg02.L', 'upperleg02.R', 'lowerleg02.L', 'lowerleg02.R', 'clavicle.L',
  'clavicle.R', 'shoulder01.L', 'shoulder01.R', 'pelvis.L', 'pelvis.R'];

const v = () => new THREE.Vector3();

export class Ragdoll {
  constructor(root, bone, groundHeight) {
    this.root = root;
    this.bone = bone;
    this.groundHeight = groundHeight;
    this.active = false;
    this.names = Object.keys(J);
    // rest (bind) particle positions in NPC-local space
    this.rest = {};
    for (const n of this.names) {
      const b = bone(J[n].bone);
      this.rest[n] = J[n].tail ? b.userData.restTail.clone() : b.userData.restHead.clone();
    }
    this.restFrames = {
      pelvis: frame(this.rest.pelvis, this.rest.belly, this.rest.hipL, this.rest.hipR),
      chest: frame(this.rest.chest, this.rest.neck, this.rest.shoL, this.rest.shoR),
    };
    this.p = {}; this.pp = {}; this.inv = {};
    for (const n of this.names) { this.p[n] = v(); this.pp[n] = v(); this.inv[n] = 1 / J[n].m; }
    this.links = [];
    this.limp = 1;
  }

  // start from the current pose (world space), optionally with an initial velocity field
  activate(prevWorld = null, dt = 1 / 60) {
    this.root.updateWorldMatrix(true, true);
    for (const n of this.names) {
      const b = this.bone(J[n].bone);
      const w = J[n].tail ? b.localToWorld(b.userData.tailOffset.clone()) : b.getWorldPosition(v());
      this.p[n].copy(w);
      this.pp[n].copy(prevWorld && prevWorld[n] ? prevWorld[n] : w);
    }
    this.links = LINKS.map(([a, b, stiff = 1]) => ({ a, b, d: this.p[a].distanceTo(this.p[b]), k: stiff }));
    // knees buckle, hips go back: people crumple rather than topple like planks
    for (const s of ['L', 'R']) {
      this.pp['kne' + s].addScaledVector(this.forward(), -0.012);
      this.pp['ank' + s].addScaledVector(this.forward(), 0.003);
    }
    this.pp.pelvis.y += 0.004; this.pp.belly.y += 0.003;
    this.active = true;
    this.t = 0;
  }

  forward() {
    const f = frame(this.p.pelvis, this.p.belly, this.p.hipL, this.p.hipR);
    return new THREE.Vector3().setFromMatrixColumn(f, 2);
  }

  impulse(worldPoint, velocity) {
    // distribute a velocity change to the nearest particles
    let total = 0;
    const w = {};
    for (const n of this.names) { w[n] = 1 / (0.02 + this.p[n].distanceToSquared(worldPoint)); total += w[n]; }
    for (const n of this.names) this.pp[n].addScaledVector(velocity, -(w[n] / total) * 2.5 / 60);
  }

  step(dt, agonal = 0) {
    if (!this.active) return;
    this.t += dt;
    const sub = 3;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      for (const n of this.names) {
        const p = this.p[n], pp = this.pp[n];
        const vx = (p.x - pp.x) * 0.995, vy = (p.y - pp.y) * 0.995, vz = (p.z - pp.z) * 0.995;
        pp.copy(p);
        p.x += vx; p.y += vy - 9.81 * h * h; p.z += vz;
        if (agonal > 0 && Math.random() < agonal * h * 4) p.x += (Math.random() - 0.5) * 0.004, p.z += (Math.random() - 0.5) * 0.004;
      }
      for (let it = 0; it < 10; it++) {
        for (const L of this.links) solveDist(this.p[L.a], this.p[L.b], this.inv[L.a], this.inv[L.b], L.d, L.k);
        this.hinges();
        this.limits();
        for (const n of this.names) {
          const p = this.p[n];
          const gy = this.groundHeight(p.x, p.z) + J[n].r * 0.75;
          if (p.y < gy) {
            p.y = gy;
            // friction: kill most tangential motion while touching the ground
            const pp = this.pp[n];
            pp.x += (p.x - pp.x) * 0.6; pp.z += (p.z - pp.z) * 0.6;
          }
        }
        // limbs can't pass through each other at the knees/ankles
        minDist(this.p.kneL, this.p.kneR, 0.11); minDist(this.p.ankL, this.p.ankR, 0.09);
        minDist(this.p.hanL, this.p.pelvis, 0.12); minDist(this.p.hanR, this.p.pelvis, 0.12);
      }
    }
  }

  hinges() {
    const f = frame(this.p.pelvis, this.p.belly, this.p.hipL, this.p.hipR);
    const fwd = new THREE.Vector3().setFromMatrixColumn(f, 2);
    const cf = frame(this.p.chest, this.p.neck, this.p.shoL, this.p.shoR);
    const cfwd = new THREE.Vector3().setFromMatrixColumn(cf, 2);
    for (const s of ['L', 'R']) {
      // knee points forward of the hip-ankle line; elbow sits behind shoulder-wrist
      hinge(this.p['hip' + s], this.p['kne' + s], this.p['ank' + s], fwd, 0.004);
      hinge(this.p['sho' + s], this.p['elb' + s], this.p['wri' + s], cfwd.clone().negate(), 0.004);
    }
  }

  limits() {
    // neck: head stays within ~70 degrees of the chest axis
    const up = v().subVectors(this.p.neck, this.p.chest).normalize();
    const hd = v().subVectors(this.p.head, this.p.neck);
    const len = hd.length();
    const cos = hd.dot(up) / len;
    if (cos < 0.35) {
      const corr = hd.normalize().lerp(up, 0.25).normalize().multiplyScalar(len);
      this.p.head.copy(this.p.neck).add(corr);
    }
  }

  // write particle state onto the skeleton
  apply() {
    if (!this.active) return;
    const R = new THREE.Matrix4(), Rr = new THREE.Matrix4();
    const qPelvis = rot(frame(this.p.pelvis, this.p.belly, this.p.hipL, this.p.hipR), this.restFrames.pelvis);
    const qChest = rot(frame(this.p.chest, this.p.neck, this.p.shoL, this.p.shoR), this.restFrames.chest);
    const rootInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const world = {};
    world.root = qPelvis;
    world.spine05 = qPelvis.clone();
    world.spine04 = qPelvis.clone().slerp(qChest, 0.33);
    world.spine03 = qPelvis.clone().slerp(qChest, 0.66);
    world.spine02 = qChest.clone();
    world.spine01 = qChest.clone();
    const neckDir = v().subVectors(this.p.head, this.p.neck).normalize();
    const restNeck = v().subVectors(this.rest.head, this.rest.neck).normalize();
    const qHead = new THREE.Quaternion().setFromUnitVectors(restNeck.clone().applyQuaternion(qChest), neckDir).multiply(qChest);
    world.neck01 = qChest.clone().slerp(qHead, 0.3);
    world.neck02 = qChest.clone().slerp(qHead, 0.6);
    world.neck03 = qHead.clone();
    world.head = qHead.clone();
    for (const [bn, [a, b]] of Object.entries(LIMB)) {
      const rd = v().subVectors(this.rest[b], this.rest[a]).normalize();
      const cd = v().subVectors(this.p[b], this.p[a]).normalize();
      const parentQ = bn.startsWith('upperarm') ? qChest : bn.startsWith('upperleg') ? qPelvis : null;
      // twist-free relative to the parent segment
      const base = parentQ || world[LIMB_PARENT[bn]] || qChest;
      world[bn] = new THREE.Quaternion().setFromUnitVectors(rd.clone().applyQuaternion(base), cd).multiply(base);
    }
    // apply in hierarchy order: local = parentWorld^-1 * world (all in NPC root space)
    const toLocal = (name, q) => {
      const b = this.bone(name);
      if (!b) return;
      const pw = b.parent.isBone ? b.parent.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootInv) : new THREE.Quaternion();
      const target = q.clone().premultiply(rootInv);
      b.quaternion.copy(pw.invert().multiply(target));
      b.updateMatrixWorld(true);
    };
    const rootBone = this.bone('root');
    const pel = this.root.worldToLocal(this.p.pelvis.clone());
    const off = v().subVectors(rootBone.userData.restHead, this.rest.pelvis).applyQuaternion(qPelvis.clone().premultiply(rootInv));
    rootBone.position.copy(pel).add(off);
    for (const n of RESET_LOCAL) { const b = this.bone(n); if (b) b.quaternion.identity(); }
    const order = ['root', 'spine05', 'spine04', 'spine03', 'spine02', 'spine01', 'neck01', 'neck02', 'neck03', 'head',
      'upperarm01.L', 'lowerarm01.L', 'wrist.L', 'upperarm01.R', 'lowerarm01.R', 'wrist.R',
      'upperleg01.L', 'lowerleg01.L', 'foot.L', 'upperleg01.R', 'lowerleg01.R', 'foot.R'];
    for (const n of order) {
      if (n === 'root') { this.bone('root').quaternion.copy(world.root.clone().premultiply(rootInv)); this.bone('root').updateMatrixWorld(true); continue; }
      if (world[n]) toLocal(n, world[n]);
    }
  }
}

const LIMB_PARENT = {
  'lowerarm01.L': 'upperarm01.L', 'wrist.L': 'lowerarm01.L', 'lowerarm01.R': 'upperarm01.R', 'wrist.R': 'lowerarm01.R',
  'lowerleg01.L': 'upperleg01.L', 'foot.L': 'lowerleg01.L', 'lowerleg01.R': 'upperleg01.R', 'foot.R': 'lowerleg01.R',
};

function frame(o, upPt, leftPt, rightPt) {
  const y = v().subVectors(upPt, o).normalize();
  const x = v().subVectors(leftPt, rightPt);
  x.addScaledVector(y, -x.dot(y)).normalize();
  const z = v().crossVectors(x, y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z);
}

function rot(cur, rest) {
  const m = cur.clone().multiply(rest.clone().transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function solveDist(a, b, ia, ib, d, k) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
  const diff = ((len - d) / len) * k / (ia + ib);
  a.x += dx * diff * ia; a.y += dy * diff * ia; a.z += dz * diff * ia;
  b.x -= dx * diff * ib; b.y -= dy * diff * ib; b.z -= dz * diff * ib;
}

function minDist(a, b, d) {
  const dl = a.distanceTo(b);
  if (dl < d && dl > 1e-6) {
    const c = v().subVectors(b, a).multiplyScalar((d - dl) / dl * 0.5);
    a.sub(c); b.add(c);
  }
}

// keep the middle joint on one side of the line through the outer joints
function hinge(a, m, c, dir, slack) {
  const mid = v().addVectors(a, c).multiplyScalar(0.5);
  const off = v().subVectors(m, mid).dot(dir);
  if (off < -slack) m.addScaledVector(dir, -slack - off);
}
