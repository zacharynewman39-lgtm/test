import * as THREE from 'three';
import { Body, HIP_Y, makeEnemyRifle } from './body.js';
import { fabricSet, maskSet } from './textures.js';

// Puts the anatomical NPC (src/npc-kit) under the game's control.
//
// The AI animates an invisible primitive rig (body.js poses). Every frame the
// rig's joint positions are handed to the kit's ragdoll solver, which turns 21
// joint points into a full 163-bone pose. So walking, aiming, crouching and
// crawling all carry over, and death hands the same skeleton to the ragdoll.
//
// The rest of the game talks to this through the same surface as the
// placeholder Body (root, gun, world(), headPos(), blendPose()...).

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

// rig joint -> ragdoll particle. [joint, local offset or null]
const POINTS = {
  pelvis: ['pelvis'], belly: ['spine'], chest: ['chest'], neck: ['neck'], head: ['head', [0, 0.2, 0.02]],
  shoL: ['uArmL'], elbL: ['fArmL'], wriL: ['handL'], hanL: ['handL', [0, -0.11, 0.01]],
  shoR: ['uArmR'], elbR: ['fArmR'], wriR: ['handR'], hanR: ['handR', [0, -0.11, 0.01]],
  hipL: ['thighL'], kneL: ['shinL'], ankL: ['footL'], toeL: ['footL', [0, -0.05, 0.16]],
  hipR: ['thighR'], kneR: ['shinR'], ankR: ['footR'], toeR: ['footR', [0, -0.05, 0.16]],
};
// what the game calls a joint -> kit bone
const BONE = { pelvis: 'root', spine: 'spine03', abdomen: 'spine03', chest: 'spine01', neck: 'neck02', head: 'head' };

// head and chest sizes measured from the model's skin weights (bone-local, metres)
const HEAD = { c: [0, 0.035, 0.022], r: [0.092, 0.121, 0.112] };
const CHEST = { c: [0, -0.03, 0.08], s: [0.42, 0.31, 0.25] };

const matCache = new Map();
function setMat(key, make) {
  if (!matCache.has(key)) {
    const set = make();
    matCache.set(key, new THREE.MeshStandardMaterial({ ...set, roughness: 1 }));
  }
  return matCache.get(key);
}

export class KitBody {
  constructor(goreNpc, opts = {}) {
    const { shirt = null, pants = null, mask = false, bag = false, gun = false, vest = false } = opts;
    this.kit = goreNpc;
    this.rig = new Body({ gun });
    for (const m of this.rig.hitMeshes) m.visible = false;
    this.rig.hitMeshes = [];
    this.root = this.rig.root;
    this.j = this.rig.j;
    this.gun = this.rig.gun;
    this.rand = this.rig.rand;
    this.hitMeshes = []; // shots go through the kit's tissue tracer instead
    this.severed = new Set();
    this.accessories = [];
    this.scale = this.kit.npc.bone('root').userData.restHead.y / HIP_Y;
    this.points = {};
    for (const n of Object.keys(POINTS)) this.points[n] = new THREE.Vector3();

    // clothes: recolour this NPC's own copies of the kit materials
    const M = this.kit.npc.materials;
    if (shirt !== null) M.shirt.color.set(shirt);
    if (pants !== null) M.denim.color.set(pants);

    const head = this.kit.npc.bone('head');
    if (mask) this.addMask(head);
    if (bag) this.addBag(head);
    if (vest) this.addVest(this.kit.npc.bone('spine01'));

    // the rifle rides on his chest, not the invisible rig's
    if (this.gun) { this.kit.npc.bone('spine01').add(this.gun); this.gun.position.set(-0.11, 0.04, 0.24); }

    goreNpc.driver = () => this.sync();
  }

  // ------------------------------------------------------------ accessories
  attach(bone, mesh, kind) {
    mesh.castShadow = true;
    mesh.userData.accessory = kind;
    bone.add(mesh);
    this.accessories.push(mesh);
    return mesh;
  }

  addMask(head) {
    const [cx, cy, cz] = HEAD.c, [rx, ry, rz] = HEAD.r;
    const plate = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
      setMat('mask', () => maskSet(56)));
    plate.scale.set(rx * 0.98, ry * 0.92, rz * 0.62);
    plate.rotation.x = Math.PI / 2;
    plate.position.set(cx, cy - 0.005, cz + rz * 0.42);
    this.mask = this.attach(head, plate, 'mask');
    // eye holes, in the cap's unit-sphere space (+y is the face, -z is up)
    const hole = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.CircleGeometry(0.17, 12), hole);
      e.scale.y = 1.5;
      e.position.set(sx * 0.36, 0.9, -0.22).normalize().multiplyScalar(1.01);
      e.lookAt(e.position.clone().multiplyScalar(2));
      plate.add(e);
    }
    const hood = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
      setMat('hood', () => fabricSet('#1c1b1d', 60, 'knit')));
    hood.scale.set(rx * 1.18, ry * 1.12, rz * 1.12);
    hood.position.set(cx, cy + 0.01, cz - 0.02);
    hood.rotation.x = -0.4;
    this.hood = this.attach(head, hood, 'hood');
  }

  addBag(head) {
    const [cx, cy, cz] = HEAD.c, [rx, ry, rz] = HEAD.r;
    const sack = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), setMat('burlap', () => fabricSet('#7a6748', 57, 'denim')));
    sack.scale.set(rx * 1.3, ry * 1.2, rz * 1.25);
    sack.position.set(cx, cy + 0.01, cz);
    this.bag = this.attach(head, sack, 'bag');
  }

  addVest(chest) {
    const [cx, cy, cz] = CHEST.c, [sx, sy, sz] = CHEST.s;
    const mat = setMat('vest', () => fabricSet('#2a2c24', 55, 'denim'));
    const v = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    v.position.set(cx, cy, cz);
    this.attach(chest, v, 'vest');
    for (const x of [-0.1, 0, 0.1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.12, 0.05), mat);
      p.position.set(cx + x, cy - 0.06, cz + sz / 2 + 0.02);
      this.attach(chest, p, 'vest');
    }
  }

  removeBag() {
    if (!this.bag) return;
    this.bag.removeFromParent();
    this.bag = null;
  }

  // Knock an accessory off (mask shattered, bag torn away...). Returns it in world space.
  detach(mesh, scene) {
    if (!mesh?.parent) return null;
    scene.attach(mesh);
    this.accessories = this.accessories.filter((a) => a !== mesh);
    if (mesh === this.mask) this.mask = null;
    if (mesh === this.hood) this.hood = null;
    return mesh;
  }

  // ----------------------------------------------------------------- posing
  blendPose(pose, dt, k) { this.rig.blendPose(pose, dt, k); }

  // Called by the kit every frame while it isn't ragdolling.
  sync() {
    const rig = this.rig, kitRoot = this.kit.root;
    rig.root.updateWorldMatrix(true, true);
    kitRoot.position.copy(rig.root.position);
    kitRoot.quaternion.copy(rig.root.quaternion);
    kitRoot.updateWorldMatrix(true, true);
    const o = rig.root.position;
    for (const [n, [joint, off]] of Object.entries(POINTS)) {
      const j = rig.j[joint];
      const p = off ? j.localToWorld(_v.set(off[0], off[1], off[2])) : j.getWorldPosition(_v);
      // the kit man is a little taller in the hips than the rig: scale about the feet
      this.points[n].copy(p).sub(o).multiplyScalar(this.scale).add(o);
    }
    this.kit.ragdoll.applyPoints(this.points);
  }

  // ------------------------------------------------------------- queries
  world(joint, out = new THREE.Vector3()) {
    const b = this.kit.npc.bone(BONE[joint] || joint);
    if (b) return b.getWorldPosition(out);
    return this.rig.world(joint, out);
  }

  headPos(out = new THREE.Vector3()) {
    const h = this.kit.npc.bone('head');
    return h.localToWorld(out.set(HEAD.c[0], HEAD.c[1] + 0.02, HEAD.c[2]));
  }

  dispose() { this.rig.dispose(); }
}

export { makeEnemyRifle };
