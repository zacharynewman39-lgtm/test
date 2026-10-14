import * as THREE from 'three';

// Placeholder human made of primitives. This is the module the real anatomical
// model will replace: keep the same surface (root, joints, hitMeshes, resolveHit,
// sever, destroyHead, addWound, blendPose) and the rest of the game won't care.
//
// Faces +z. Feet at the root origin. The character's left is +x.

// What each organ does when a bullet goes through it.
//   mult: damage multiplier, bleed: hp/sec added, plus special effects.
export const ORGANS = {
  brain: { mult: 10, bleed: 4, fatal: true },
  jaw: { mult: 2.2, bleed: 3 },
  neck: { mult: 1.8, bleed: 9 },
  heart: { mult: 2.5, bleed: 16 },
  lung: { mult: 1.3, bleed: 2.5, lung: true },
  spine: { mult: 1.4, bleed: 1.5, paralyze: true },
  liver: { mult: 1.5, bleed: 5 },
  gut: { mult: 1.0, bleed: 2 },
  pelvis: { mult: 1.0, bleed: 2, leg: true },
  arm: { mult: 0.5, bleed: 0.8, arm: true },
  hand: { mult: 0.35, bleed: 0.5, arm: true, disarm: 0.85 },
  forearm: { mult: 0.45, bleed: 0.8, arm: true, disarm: 0.35 },
  thigh: { mult: 0.65, bleed: 1.2, leg: true },
  femoral: { mult: 0.7, bleed: 7, leg: true },
  shin: { mult: 0.5, bleed: 0.8, leg: true },
  foot: { mult: 0.3, bleed: 0.4, leg: true },
};

// Raw (pre-multiplier) damage a part can take before it comes off.
const SEVER_AT = { head: 70, uArmL: 90, uArmR: 90, fArmL: 70, fArmR: 70, thighL: 120, thighR: 120, shinL: 95, shinR: 95 };

const JOINTS = ['pelvis', 'spine', 'chest', 'neck', 'head',
  'uArmL', 'fArmL', 'handL', 'uArmR', 'fArmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];

export const HIP_Y = 0.9;

export class Body {
  constructor(opts = {}) {
    const {
      skin = 0xc9a089, shirt = 0x26262a, pants = 0x1c1c22, shoes = 0x111111,
      mask = false, bag = false, gun = false, scale = 1,
    } = opts;
    this.root = new THREE.Group();
    this.root.scale.setScalar(scale);
    this.j = {};
    this.hitMeshes = [];
    this.partDamage = {};
    this.severed = new Set();
    this.stumps = [];
    const M = (color, rough = 0.9) => new THREE.MeshStandardMaterial({ color, roughness: rough });
    this.mats = { skin: M(skin, 0.6), shirt: M(shirt), pants: M(pants), shoes: M(shoes, 0.5) };
    for (const n of JOINTS) {
      const g = new THREE.Group();
      g.rotation.order = 'YXZ';
      g.name = n;
      this.j[n] = g;
    }
    const J = this.j;
    const attach = (parent, child, x, y, z) => { J[parent].add(J[child]); J[child].position.set(x, y, z); };
    this.root.add(J.pelvis);
    J.pelvis.position.y = HIP_Y;
    attach('pelvis', 'spine', 0, 0.08, 0);
    attach('spine', 'chest', 0, 0.22, 0);
    attach('chest', 'neck', 0, 0.28, 0);
    attach('neck', 'head', 0, 0.08, 0);
    attach('chest', 'uArmL', 0.21, 0.24, 0);
    attach('uArmL', 'fArmL', 0, -0.29, 0);
    attach('fArmL', 'handL', 0, -0.26, 0);
    attach('chest', 'uArmR', -0.21, 0.24, 0);
    attach('uArmR', 'fArmR', 0, -0.29, 0);
    attach('fArmR', 'handR', 0, -0.26, 0);
    attach('pelvis', 'thighL', 0.1, -0.04, 0);
    attach('thighL', 'shinL', 0, -0.43, 0);
    attach('shinL', 'footL', 0, -0.4, 0);
    attach('pelvis', 'thighR', -0.1, -0.04, 0);
    attach('thighR', 'shinR', 0, -0.43, 0);
    attach('shinR', 'footR', 0, -0.4, 0);

    const m = this.mats;
    const add = (joint, geo, mat, x, y, z, part = joint) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.body = this;
      mesh.userData.part = part;
      J[joint].add(mesh);
      this.hitMeshes.push(mesh);
      return mesh;
    };
    const cap = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);
    add('pelvis', new THREE.BoxGeometry(0.33, 0.2, 0.21), m.pants, 0, 0, 0);
    add('spine', new THREE.BoxGeometry(0.31, 0.24, 0.19), m.shirt, 0, 0.11, 0, 'abdomen');
    add('chest', new THREE.BoxGeometry(0.4, 0.29, 0.23), m.shirt, 0, 0.14, 0);
    add('neck', new THREE.CylinderGeometry(0.052, 0.058, 0.11, 10), m.skin, 0, 0.04, 0);
    const head = add('head', new THREE.SphereGeometry(1, 16, 12), m.skin, 0, 0.11, 0.005);
    head.scale.set(0.095, 0.12, 0.108);
    for (const s of ['L', 'R']) {
      const mat = s === 'L' ? 1 : -1;
      add('uArm' + s, cap(0.052, 0.2), m.shirt, 0, -0.14, 0);
      add('fArm' + s, cap(0.042, 0.18), m.skin, 0, -0.13, 0);
      add('hand' + s, new THREE.BoxGeometry(0.06, 0.15, 0.035), m.skin, 0, -0.075, 0);
      add('thigh' + s, cap(0.075, 0.28), m.pants, 0, -0.21, 0);
      add('shin' + s, cap(0.055, 0.28), m.pants, 0, -0.2, 0);
      add('foot' + s, new THREE.BoxGeometry(0.1, 0.07, 0.26), m.shoes, 0, -0.035, 0.06);
      void mat;
    }
    if (mask) {
      const mm = new THREE.MeshStandardMaterial({ color: 0xe6e0d0, roughness: 0.45 });
      const plate = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.75), mm);
      plate.scale.set(0.088, 0.115, 0.07);
      plate.rotation.x = Math.PI / 2;
      plate.position.set(0, 0.11, 0.055);
      plate.userData.body = this; plate.userData.part = 'head';
      J.head.add(plate);
      this.hitMeshes.push(plate);
      const hole = new THREE.MeshBasicMaterial({ color: 0x000000 });
      for (const x of [-0.033, 0.033]) {
        const e = new THREE.Mesh(new THREE.CircleGeometry(0.016, 10), hole);
        e.scale.y = 1.6;
        e.position.set(x, 0.135, 0.123);
        e.rotation.x = -0.15;
        J.head.add(e);
      }
      const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.005), hole);
      mouth.position.set(0, 0.06, 0.118);
      J.head.add(mouth);
      const hood = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), m.shirt);
      hood.scale.set(0.115, 0.14, 0.125);
      hood.position.set(0, 0.12, -0.012);
      hood.rotation.x = -0.35;
      hood.userData.body = this; hood.userData.part = 'head';
      J.head.add(hood);
      this.hitMeshes.push(hood);
    }
    if (bag) {
      const bm = new THREE.MeshStandardMaterial({ color: 0x7a6748, roughness: 1 });
      const sack = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), bm);
      sack.scale.set(0.12, 0.15, 0.13);
      sack.position.set(0, 0.1, 0.005);
      sack.userData.body = this; sack.userData.part = 'head';
      J.head.add(sack);
      this.hitMeshes.push(sack);
    }
    if (gun) {
      this.gun = makeEnemyRifle();
      this.gun.position.set(-0.11, 0.17, 0.2);
      J.chest.add(this.gun);
    }
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.rand = Array.from({ length: 16 }, () => Math.random());
  }

  // Joint world position.
  world(joint, out = new THREE.Vector3()) { return this.j[joint].getWorldPosition(out); }
  headPos(out) {
    if (this.severed.has('head')) return this.world('neck', out);
    return this.j.head.localToWorld(out.set(0, 0.1, 0.02));
  }

  // Work out which organ a bullet went through. local coords are in the mesh's space.
  resolveHit(mesh, point) {
    const part = mesh.userData.part;
    const l = mesh.worldToLocal(point.clone());
    const r = Math.random();
    let organ;
    switch (part) {
      case 'head': organ = l.y < -0.35 ? 'jaw' : 'brain'; break;
      case 'neck': organ = 'neck'; break;
      case 'chest':
        if (Math.abs(l.x) < 0.03) organ = 'spine';
        else if (l.x > -0.015 && l.x < 0.09 && l.y > -0.09 && l.y < 0.06) organ = 'heart';
        else organ = 'lung';
        break;
      case 'abdomen': organ = Math.abs(l.x) < 0.03 ? 'spine' : l.x < 0 && l.y > 0.0 ? 'liver' : 'gut'; break;
      case 'pelvis': organ = 'pelvis'; break;
      default:
        if (part.startsWith('uArm')) organ = 'arm';
        else if (part.startsWith('fArm')) organ = 'forearm';
        else if (part.startsWith('hand')) organ = 'hand';
        else if (part.startsWith('thigh')) organ = r < 0.25 ? 'femoral' : 'thigh';
        else if (part.startsWith('shin')) organ = 'shin';
        else organ = 'foot';
    }
    const side = part.endsWith('L') ? 'L' : part.endsWith('R') ? 'R' : null;
    return { part, organ, side, info: ORGANS[organ] };
  }

  // Accumulate raw damage on a part; returns true if it should come off.
  damagePart(part, raw) {
    this.partDamage[part] = (this.partDamage[part] || 0) + raw;
    return SEVER_AT[part] !== undefined && this.partDamage[part] >= SEVER_AT[part] && !this.severed.has(part);
  }

  _collectMeshes(joint) {
    const set = new Set();
    joint.traverse((o) => { if (o.isMesh) set.add(o); });
    this.hitMeshes = this.hitMeshes.filter((h) => !set.has(h));
    return set;
  }

  // Detach a limb. Returns the detached group (now parented to `scene`) and the stump point.
  sever(part, scene) {
    const joint = this.j[part];
    if (!joint || this.severed.has(part)) return null;
    joint.traverse((o) => { if (o.name && JOINTS.includes(o.name)) this.severed.add(o.name); });
    const meshes = this._collectMeshes(joint);
    for (const m of meshes) { m.userData.gib = true; delete m.userData.body; }
    const parent = joint.parent;
    const local = joint.position.clone();
    scene.attach(joint);
    const stump = this._stump(parent, local, part);
    return { piece: joint, stump };
  }

  destroyHead(scene) {
    const head = this.j.head;
    if (this.severed.has('head')) return null;
    this.severed.add('head');
    this._collectMeshes(head);
    head.parent.remove(head);
    return this._stump(this.j.neck, new THREE.Vector3(0, 0.08, 0), 'head');
  }

  // A raw-meat cap where a part used to be. Returns an Object3D to emit blood from.
  _stump(parent, localPos, part) {
    const s = new THREE.Group();
    s.position.copy(localPos);
    s.userData.part = part;
    const meat = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8).scale(1, 0.5, 1),
      new THREE.MeshStandardMaterial({ color: 0x5a0606, roughness: 0.25 }));
    const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 6),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.5 }));
    bone.position.y = 0.01;
    s.add(meat, bone);
    parent.add(s);
    this.stumps.push(s);
    return s;
  }

  // Small dark wound stuck to the body at the hit point.
  addWound(mesh, point, normal, size = 0.022, exit = false) {
    const joint = mesh.parent;
    if (!joint) return;
    const w = new THREE.Mesh(woundGeo, exit ? exitMat : woundMat);
    w.scale.setScalar(size * (0.8 + Math.random() * 0.5));
    joint.add(w);
    joint.updateWorldMatrix(true, false);
    w.position.copy(joint.worldToLocal(point.clone().addScaledVector(normal, 0.004)));
    w.lookAt(point.clone().add(normal));
  }

  // Ease every joint toward a target pose. pose: { joint: [x,y,z], pelvisY, ... }
  blendPose(pose, dt, k = 10) {
    const a = 1 - Math.exp(-k * dt);
    for (const n of JOINTS) {
      const t = pose[n] || ZERO;
      const r = this.j[n].rotation;
      r.x += (t[0] - r.x) * a;
      r.y += (t[1] - r.y) * a;
      r.z += (t[2] - r.z) * a;
    }
    const py = pose.pelvisY ?? HIP_Y;
    const p = this.j.pelvis.position;
    p.y += (py - p.y) * a;
    p.z += ((pose.pelvisZ ?? 0) - p.z) * a;
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
}

const ZERO = [0, 0, 0];
const woundGeo = new THREE.CircleGeometry(1, 10);
const woundMat = new THREE.MeshStandardMaterial({ color: 0x2a0303, roughness: 0.2, side: THREE.DoubleSide });
const exitMat = new THREE.MeshStandardMaterial({ color: 0x6a0808, roughness: 0.3, side: THREE.DoubleSide });

export function makeEnemyRifle() {
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.5 });
  const box = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), black); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  box(0.05, 0.07, 0.42, 0, 0, 0.1);
  box(0.03, 0.03, 0.3, 0, 0.01, 0.45);
  box(0.04, 0.12, 0.05, 0, -0.08, 0.12);
  box(0.045, 0.07, 0.22, 0, -0.01, -0.18);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, 0.62);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// ------------------------------------------------------------------ poses
// Each returns a target pose for Body.blendPose.

export function standPose({ phase = 0, speed = 0, aim = false, aimPitch = 0, crouch = 0, limp = null,
  clutch = false, flinch = 0, look = 0, t = 0, raise = 0 }) {
  const s = Math.sin(phase), c = Math.cos(phase);
  const amp = Math.min(speed / 1.5, 1.4) * 0.5;
  const ampL = limp === 'L' ? amp * 0.3 : amp, ampR = limp === 'R' ? amp * 0.3 : amp;
  const breathe = Math.sin(t * 1.7) * 0.02;
  const p = {
    pelvisY: HIP_Y - Math.abs(c) * 0.035 * amp - crouch * 0.38 - (limp ? Math.max(0, s * (limp === 'L' ? 1 : -1)) * 0.06 : 0),
    pelvis: [0, 0, limp ? (limp === 'L' ? 0.08 : -0.08) * Math.abs(s) : 0],
    spine: [crouch * 0.35 + (clutch ? 0.4 : 0) + flinch * 0.4, look * 0.3, 0],
    chest: [breathe + (clutch ? 0.2 : 0), look * 0.3 + flinch * 0.6, 0],
    neck: [clutch ? 0.3 : -crouch * 0.3, look * 0.4, 0],
    head: [0, 0, 0],
    thighL: [-s * ampL - crouch * 1.3, 0, 0.03],
    shinL: [Math.max(0, -c) * ampL * 1.4 + crouch * 1.9, 0, 0],
    footL: [-crouch * 0.6, 0, 0],
    thighR: [s * ampR - crouch * 1.3, 0, -0.03],
    shinR: [Math.max(0, c) * ampR * 1.4 + crouch * 1.9, 0, 0],
    footR: [-crouch * 0.6, 0, 0],
  };
  if (aim) {
    const ap = -aimPitch;
    p.spine[0] += ap * 0.4 - crouch * 0.2;
    p.chest[0] += ap * 0.6 - crouch * 0.15;
    p.neck[0] -= ap * 0.0;
    p.uArmR = [-1.25, 0.3, 0];
    p.fArmR = [-0.5, 0, 0];
    p.handR = [0, 0, 0];
    p.uArmL = [-1.25, -0.6, 0];
    p.fArmL = [-0.55, 0, 0];
  } else if (clutch) {
    p.uArmL = [-0.6, -0.5, 0.2];
    p.fArmL = [-1.8, 0, 0];
    p.uArmR = [-0.5, 0.5, -0.2];
    p.fArmR = [-1.7, 0, 0];
  } else {
    p.uArmL = [s * amp * 0.8 - raise * 1.2, 0, 0.08];
    p.fArmL = [-0.25 - raise * 1.2, 0, 0];
    p.uArmR = [-s * amp * 0.8 - raise * 1.2, 0, -0.08];
    p.fArmR = [-0.25 - raise * 1.2, 0, 0];
  }
  return p;
}

// Lying face down, dragging along.
export function pronePose({ phase = 0, moving = 0, lift = 0.5 }) {
  const s = Math.sin(phase);
  return {
    pelvisY: 0.13,
    pelvisZ: 0,
    pelvis: [Math.PI / 2, 0, 0],
    spine: [-0.1 * lift, 0, 0],
    chest: [-0.15 * lift, 0, 0],
    neck: [-0.6 * lift, 0, 0],
    uArmL: [-2.6 + s * 0.5 * moving, 0, 0.3],
    fArmL: [-0.5 - Math.max(0, s) * 0.6 * moving, 0, 0],
    uArmR: [-2.6 - s * 0.5 * moving, 0, -0.3],
    fArmR: [-0.5 - Math.max(0, -s) * 0.6 * moving, 0, 0],
    thighL: [0.05 + s * 0.15 * moving, 0, 0.12],
    shinL: [0.25, 0, 0],
    thighR: [0.05 - s * 0.15 * moving, 0, -0.12],
    shinR: [0.25, 0, 0],
    footL: [0.6, 0, 0],
    footR: [0.6, 0, 0],
  };
}

// Dead on the floor. dir: +1 face down, -1 on the back. rnd: per-body randoms.
export function deadPose(dir, rnd, twitch = 0, t = 0) {
  const tw = (i) => twitch * Math.sin(t * (20 + rnd[i] * 15) + rnd[i] * 10) * 0.12;
  return {
    pelvisY: 0.12,
    pelvis: [dir * Math.PI / 2, 0, (rnd[0] - 0.5) * 0.3],
    spine: [0, (rnd[1] - 0.5) * 0.4, 0],
    chest: [0, (rnd[2] - 0.5) * 0.3, 0],
    neck: [(rnd[3] - 0.5) * 0.6 + tw(3), (rnd[4] - 0.5) * 1.6, 0],
    uArmL: [-1.5 - rnd[5] * 1.4 * dir + tw(5), 0, 0.3 + rnd[6] * 0.9],
    fArmL: [-rnd[7] * 1.2 + tw(7), 0, 0],
    uArmR: [-1.5 - rnd[8] * 1.4 * dir + tw(8), 0, -0.3 - rnd[9] * 0.9],
    fArmR: [-rnd[10] * 1.2, 0, 0],
    thighL: [(rnd[11] - 0.5) * 0.6 + tw(11), 0, 0.1 + rnd[12] * 0.3],
    shinL: [rnd[13] * 0.9, 0, 0],
    thighR: [(rnd[14] - 0.5) * 0.6 + tw(14), 0, -0.1 - rnd[15] * 0.3],
    shinR: [rnd[12] * 0.9 + tw(12), 0, 0],
    footL: [0.5, 0, 0],
    footR: [0.5, 0, 0],
  };
}

export function kneelPose(t, fear = 1) {
  const tr = Math.sin(t * 31) * 0.012 * fear;
  return {
    pelvisY: 0.5,
    pelvis: [0, 0, 0],
    spine: [0.15 + tr, 0, 0],
    chest: [0.1 + Math.sin(t * 2.3) * 0.03 * fear, 0, tr],
    neck: [0.45 + tr, Math.sin(t * 0.7) * 0.2 * fear, 0],
    uArmL: [0.45, 0, -0.08],
    fArmL: [-0.2, 0.6, 0],
    uArmR: [0.45, 0, 0.08],
    fArmR: [-0.2, -0.6, 0],
    thighL: [0, 0, 0.05],
    shinL: [Math.PI / 2, 0, 0],
    footL: [0.9, 0, 0],
    thighR: [0, 0, -0.05],
    shinR: [Math.PI / 2, 0, 0],
    footR: [0.9, 0, 0],
  };
}
