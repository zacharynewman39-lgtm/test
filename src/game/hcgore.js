import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { createGoreUniforms, MAX_WOUNDS } from '../npc-kit/woundShader.js';

// High-calibre gore layered on top of the npc-kit.
//
// The kit already cuts wound tracts through every tissue layer and runs the
// physiology. This adds what a rifle does on the way out:
//   - exit wounds that bloom: a ragged crater with torn skin/cloth peeled
//     outward, raw on the inside
//   - head shots that blow out the side the round leaves through (top, back,
//     temple, face, jaw), throwing skull plates, scalp flaps and brain
//   - limbs whose bone shatters mid-shaft and then hang on a strip of tissue
//   - full dismemberment: the limb (or head) is cut out of the skinned mesh and
//     becomes its own physics piece, leaving a raw stump

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);
const rnd = (a, b) => a + Math.random() * (b - a);

// limb segments: the mid-shaft "02" bone is where it breaks and bends
const LIMBS = {
  uarm: { brk: 'upperarm02', child: 'lowerarm01', r: 0.05, limb: 'arm' },
  farm: { brk: 'lowerarm02', child: 'wrist', r: 0.04, limb: 'arm' },
  thigh: { brk: 'upperleg02', child: 'lowerleg01', r: 0.085, limb: 'leg' },
  shin: { brk: 'lowerleg02', child: 'foot', r: 0.055, limb: 'leg' },
};

// 'uarmL' -> { seg: 'uarm', side: 'L', part: 'uArmL' }
const PART = { uarm: 'uArm', farm: 'fArm', hand: 'hand', thigh: 'thigh', shin: 'shin', foot: 'foot' };
function segmentFromCode(code) {
  const m = /^([a-z]+?)([LR]?)$/.exec(code);
  if (!m) return null;
  const [, seg, side] = m;
  return { seg, side: side || null, part: PART[seg] ? PART[seg] + side : seg };
}

export function segmentOf(boneName) {
  const side = /\.L$/.test(boneName) ? 'L' : /\.R$/.test(boneName) ? 'R' : null;
  if (boneName === 'head') return { seg: 'head', side, part: 'head' };
  if (/^neck/.test(boneName)) return { seg: 'neck', side, part: 'neck' };
  if (/^upperarm/.test(boneName)) return { seg: 'uarm', side, part: 'uArm' + side };
  if (/^lowerarm/.test(boneName)) return { seg: 'farm', side, part: 'fArm' + side };
  if (/^wrist|^finger/.test(boneName)) return { seg: 'hand', side, part: 'hand' + side };
  if (/^upperleg/.test(boneName)) return { seg: 'thigh', side, part: 'thigh' + side };
  if (/^lowerleg/.test(boneName)) return { seg: 'shin', side, part: 'shin' + side };
  if (/^foot|^toe/.test(boneName)) return { seg: 'foot', side, part: 'foot' + side };
  if (boneName === 'spine01' || boneName === 'spine02') return { seg: 'chest', side, part: 'chest' };
  if (boneName === 'root') return { seg: 'pelvis', side, part: 'pelvis' };
  return { seg: 'abdomen', side, part: 'abdomen' };
}

// ------------------------------------------------------------------- flaps
// Two-tone material: outside (skin/cloth/scalp) and inside (raw meat or bone).
const flapMats = new Map();
function flapMaterial(outer, inner) {
  const key = outer + ':' + inner;
  if (flapMats.has(key)) return flapMats.get(key);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, side: THREE.DoubleSide });
  const uo = { value: new THREE.Color(outer) }, ui = { value: new THREE.Color(inner) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uOuter = uo; sh.uniforms.uInner = ui;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uOuter; uniform vec3 uInner;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fl = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        diffuseColor.rgb = gl_FrontFacing ? uOuter : uInner * (0.8 + 0.25 * fl);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.005, 0.005), gl_FrontFacing ? 0.35 : 0.0);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gl_FrontFacing ? 0.55 : 0.18;');
  };
  m.customProgramCacheKey = () => 'flap-v1';
  flapMats.set(key, m);
  return m;
}

// Petals of torn tissue around a hole on the local xy plane, blown out along
// +z and curling back. droop (local vector) bends them toward the floor.
function flowerGeometry({ petals = 8, r0 = 0.02, len = 0.04, width = 0.018, curl = 1.6, droop = null, jag = 0.5 }) {
  const S = 6;
  const pos = [], idx = [];
  for (let p = 0; p < petals; p++) {
    const th = (p / petals) * Math.PI * 2 + rnd(-0.3, 0.3);
    const u = new THREE.Vector3(Math.cos(th), Math.sin(th), 0);
    const side = new THREE.Vector3().crossVectors(Z, u);
    const L = len * rnd(0.55, 1.35);
    const W = width * rnd(0.6, 1.3);
    const c = curl * rnd(0.7, 1.25);
    const pt = u.clone().multiplyScalar(r0);
    const base = pos.length / 3;
    for (let i = 0; i <= S; i++) {
      const t = i / S;
      const w = W * Math.pow(1 - t, 0.7) * (1 + (Math.random() - 0.5) * jag) + 0.0008;
      const a = pt.clone().addScaledVector(side, w / 2), b = pt.clone().addScaledVector(side, -w / 2);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const phi = 0.45 + c * t;
      const dir = u.clone().multiplyScalar(Math.sin(phi)).addScaledVector(Z, Math.cos(phi));
      if (droop) dir.addScaledVector(droop, t * 0.9);
      pt.addScaledVector(dir.normalize(), L / S);
      pt.x += rnd(-1, 1) * L * 0.03; pt.y += rnd(-1, 1) * L * 0.03;
    }
    for (let i = 0; i < S; i++) {
      const k = base + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class HighCalibreGore {
  constructor(game) {
    this.game = game;
    this.dangles = [];
    this.gibs = [];
    this.shot = new Map(); // pellets per actor+segment within one trigger pull
    this.shotId = 0;
  }

  beginShot() { this.shotId++; this.shot.clear(); }

  // Called after the kit has applied a hit. Returns extra info for the AI.
  onHit(actor, tr, weapon, res) {
    const kit = actor.kit;
    const seg = segmentFromCode(tr.entrySeg || '') || segmentOf(tr.bone.name);
    if (res.brainHit) { seg.seg = 'head'; seg.part = 'head'; }
    const key = actor.id + (seg.seg === 'neck' ? 'head' : seg.seg) + seg.side; // pellets in the neck count toward the head
    const pellets = (this.shot.get(key) || 0) + 1;
    this.shot.set(key, pellets);
    const highEnergy = weapon.energy >= 1500;
    const out = { seg, mangled: false, severed: null, blowout: null };
    const dirW = tr.rayWorld.direction.clone();

    if (seg.seg === 'head') {
      if (highEnergy || pellets === 2) out.blowout = this.headBlowout(actor, tr, res, weapon, pellets);
    } else if (seg.seg === 'neck' && (pellets === 5 || (highEnergy && res.boneHit && actor.mangled?.neck))) {
      out.severed = this.sever(actor, 'neck02', dirW, 'head');
    } else if (LIMBS[seg.seg]) {
      const limbKey = seg.seg + seg.side;
      actor.mangled ||= {};
      const already = actor.mangled[limbKey];
      if (already && (highEnergy || pellets >= 3)) out.severed = this.sever(actor, LIMBS[seg.seg].brk + '.' + seg.side, dirW, limbKey);
      else if (pellets >= 6 && weapon.energy < 1500) out.severed = this.sever(actor, LIMBS[seg.seg].brk + '.' + seg.side, dirW, limbKey);
      else if (!already && ((highEnergy && res.boneHit) || pellets === 4)) { this.mangle(actor, seg, tr, res); out.mangled = true; }
    } else if (seg.seg === 'neck' && highEnergy && res.boneHit) {
      actor.mangled ||= {};
      actor.mangled.neck = true;
    }
    if (res.exits && (highEnergy || pellets === 1) && !out.blowout && !out.severed) this.bloomExit(actor, tr, res, weapon, seg);
    if (pellets === 6 && (seg.seg === 'chest' || seg.seg === 'abdomen')) this.crater(actor, tr, res, seg);
    return out;
  }

  // --------------------------------------------------------- exit wounds
  bloomExit(actor, tr, res, weapon, seg) {
    const kit = actor.kit;
    const energy = res.remaining;
    if (energy < 250 && !res.boneHit) return;
    const pEnd = res.endBind, dir = res.dirBind;
    // widen the exit and tear it ragged with satellite tracts
    const rOut = Math.min(0.055, 0.018 + energy / 70000 + (res.boneHit ? 0.012 : 0));
    res.wound.rB = Math.max(res.wound.rB, rOut);
    const extra = res.boneHit ? 4 : 2;
    const t1 = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const t2 = new THREE.Vector3().crossVectors(dir, t1);
    for (let i = 0; i < extra; i++) {
      const a = Math.random() * Math.PI * 2, d = rOut * rnd(0.6, 1.2);
      const off = t1.clone().multiplyScalar(Math.cos(a) * d).addScaledVector(t2, Math.sin(a) * d);
      this.addTract(kit, pEnd.clone().addScaledVector(dir, -0.025).add(off.clone().multiplyScalar(0.4)),
        pEnd.clone().addScaledVector(dir, 0.04).add(off), 0.006, rOut * rnd(0.35, 0.6));
    }
    this.refresh(kit);
    // the skin and cloth around the hole, blown outward
    const clothed = ['chest', 'abdomen', 'uarm', 'pelvis', 'thigh', 'shin'].includes(seg.seg);
    const outer = clothed ? (seg.seg === 'thigh' || seg.seg === 'shin' || seg.seg === 'pelvis' ? kit.npc.materials.denim.color : kit.npc.materials.shirt.color) : new THREE.Color(0xb88a72);
    this.flower(actor, tr.bone, res.exitWorld, tr.rayWorld.direction, {
      petals: Math.round(rnd(6, 10)), r0: rOut * 0.8, len: rOut * rnd(0.9, 1.6), width: rOut * 0.9, curl: rnd(1.4, 2.2),
    }, outer.getHex(), 0x5a0808);
    const blood = kit.world.blood;
    blood.chunks(res.exitWorld, tr.rayWorld.direction, 3 + energy / 500, Math.round(3 + energy / 300), 1);
    if (res.boneHit) blood.chunks(res.exitWorld, tr.rayWorld.direction, 4, 6, 2);
  }

  // Shotgun point blank into the torso: a ragged open crater.
  crater(actor, tr, res, seg) {
    const kit = actor.kit;
    const p = res.entryBind, dir = res.dirBind;
    for (let i = 0; i < 5; i++) {
      const off = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(0.035);
      this.addTract(kit, p.clone().addScaledVector(dir, -0.03).add(off), p.clone().addScaledVector(dir, 0.08).add(off), 0.03, 0.045);
    }
    this.refresh(kit);
    const outer = kit.npc.materials.shirt.color.getHex();
    const entryW = tr.rb.at(tr.entry.distance, new THREE.Vector3()).applyMatrix4(tr.M);
    this.flower(actor, tr.bone, entryW, tr.rayWorld.direction.clone().negate(), { petals: 12, r0: 0.05, len: 0.06, width: 0.04, curl: 2.2 }, outer, 0x4a0606);
    kit.world.blood.chunks(entryW, tr.rayWorld.direction.clone().negate(), 2, 14, 1);
    kit.phys.addBleed({ part: 'torso crater', rate: 9, external: 0.9, anchor: kit.addAnchor(tr.bone, p, dir.clone().negate()), pulsatile: true });
  }

  // ------------------------------------------------------------- heads
  headBlowout(actor, tr, res, weapon, pellets) {
    const kit = actor.kit, g = this.game;
    const head = kit.npc.bone('head');
    const center = head.userData.restHead.clone().add(new THREE.Vector3(0, 0.035, 0.022));
    const pEnd = res.exits ? res.endBind : res.entryBind.clone().addScaledVector(res.dirBind, 0.12);
    const out = pEnd.clone().sub(center).normalize();
    const region = out.y > 0.55 ? 'top' : out.z < -0.45 ? 'back' : out.z > 0.4 && out.y < -0.25 ? 'jaw' : out.z > 0.4 ? 'face' : out.x > 0 ? 'left' : 'right';
    const dir = res.dirBind;
    const big = weapon.energy >= 1500 ? 1 : 0.8;

    // the cavity: an expanding cone out of the skull where the round leaves
    this.addTract(kit, center.clone().addScaledVector(out, 0.01), center.clone().addScaledVector(out, 0.16), 0.03 * big, 0.075 * big);
    const t1 = new THREE.Vector3().crossVectors(out, Math.abs(out.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const t2 = new THREE.Vector3().crossVectors(out, t1);
    for (let i = 0; i < 6; i++) { // radial fractures make the edge ragged
      const a = (i / 6) * Math.PI * 2 + rnd(-0.4, 0.4);
      const tang = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
      const rim = center.clone().addScaledVector(out, 0.07).addScaledVector(tang, rnd(0.04, 0.07) * big);
      this.addTract(kit, rim.clone().addScaledVector(out, -0.03), rim.clone().addScaledVector(out, 0.06), 0.01, rnd(0.016, 0.03) * big);
    }
    const R = (a, b, ra, rb) => this.addTract(kit, center.clone().add(new THREE.Vector3(...a)), center.clone().add(new THREE.Vector3(...b)), ra, rb);
    switch (region) {
      case 'top': R([0, 0.07, 0], [0, 0.2, -0.02], 0.055, 0.08); break; // skull cap gone
      case 'back': R([0, 0.02, -0.06], [0, 0.0, -0.18], 0.05, 0.08); break;
      case 'jaw': R([-0.06, -0.075, 0.08], [0.06, -0.075, 0.08], 0.038, 0.038); R([0, -0.09, 0.04], [0, -0.12, 0.14], 0.03, 0.05); break; // lower jaw blown away
      case 'face': R([-0.045, 0.0, 0.1], [0.045, 0.0, 0.1], 0.035, 0.035); R([0, -0.03, 0.08], [0, -0.02, 0.18], 0.03, 0.06); break;
      default: R([0, 0.03, 0], [Math.sign(out.x) * 0.16, 0.03, 0], 0.035, 0.07); break;
    }
    this.refresh(kit);
    if (region === 'jaw') kit.npc.morph('jawOpen', 1);

    // skull plates and scalp peeled out of the crater, hanging where gravity takes them
    const exitW = kit.boneMatrix(head, new THREE.Matrix4());
    const exitWorld = center.clone().addScaledVector(out, 0.1).applyMatrix4(exitW);
    const outW = out.clone().transformDirection(exitW);
    this.flower(actor, head, exitWorld, outW, { petals: 9, r0: 0.05 * big, len: 0.06, width: 0.04, curl: 1.4, jag: 0.8 }, 0xb88a72, 0x6a0a0a, true);
    this.flower(actor, head, exitWorld.clone().addScaledVector(outW, -0.012), outW, { petals: 6, r0: 0.04 * big, len: 0.035, width: 0.03, curl: 0.9, jag: 0.9 }, 0xe2d6c2, 0xc9a090);

    // what comes out
    const blood = kit.world.blood;
    blood.chunks(exitWorld, outW, 6, 26, 1); // brain
    blood.chunks(exitWorld, outW, 6, 14, 2); // bone
    blood.spray(exitWorld, outW, 7, 90, { spread: 0.45, dropMl: 0.05 });
    blood.mist(exitWorld, outW, 9, 30);
    g.gore.exitSplatter(exitWorld, outW, 3);
    for (let i = 0; i < 3; i++) g.gore.brainSplatter(exitWorld, outW.clone().add(new THREE.Vector3(rnd(-0.4, 0.4), rnd(-0.3, 0.3), rnd(-0.4, 0.4))).normalize());
    g.audio.play('gib', { pos: exitWorld, volume: 1.3 });

    // the mask doesn't survive a face or jaw shot; otherwise it's knocked off
    const kb = actor.body;
    if (kb.mask) {
      const m = kb.detach(kb.mask, g.scene);
      if (region === 'face' || region === 'jaw' || Math.random() < 0.4) this.shatter(m, outW);
      else g.gore.addChunk(m, outW.clone().multiplyScalar(2.5).add(new THREE.Vector3(0, 1.5, 0)), new THREE.Vector3(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)), { r: 0.08, bleed: 0.4 });
    }
    if (kb.hood && region === 'top') { kb.detach(kb.hood, g.scene); }
    if (kb.bag && (region === 'top' || region === 'back' || Math.random() < 0.5)) {
      const b = kb.detach(kb.bag, g.scene);
      g.gore.addChunk(b, outW.clone().multiplyScalar(2).add(new THREE.Vector3(0, 1.2, 0)), new THREE.Vector3(rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)), { r: 0.1, bleed: 0.3 });
      kb.bag = null;
    }
    g.stats.dismember++;
    return region;
  }

  shatter(mesh, dir) {
    const g = this.game;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < 5; i++) {
      const shard = new THREE.Mesh(new THREE.TetrahedronGeometry(rnd(0.025, 0.045)), mesh.material);
      shard.position.setFromMatrixPosition(mesh.matrixWorld).add(new THREE.Vector3(rnd(-0.05, 0.05), rnd(-0.05, 0.05), rnd(-0.05, 0.05)));
      shard.scale.z = 0.3;
      shard.castShadow = true;
      g.scene.add(shard);
      g.gore.addChunk(shard, dir.clone().multiplyScalar(rnd(2, 4)).add(new THREE.Vector3(rnd(-1, 1), rnd(0.5, 2), rnd(-1, 1))),
        new THREE.Vector3(rnd(-15, 15), rnd(-15, 15), rnd(-15, 15)), { r: 0.03, bleed: 0.2 });
    }
    mesh.removeFromParent();
  }

  // ------------------------------------------------------------- limbs
  // The bone shatters at the hit and the limb below swings on what's left.
  mangle(actor, seg, tr, res) {
    const kit = actor.kit;
    const L = LIMBS[seg.seg];
    const brk = kit.npc.bone(L.brk + '.' + seg.side);
    const child = kit.npc.bone(L.child + '.' + seg.side);
    const a = brk.userData.restHead, b = child.userData.restHead;
    const axis = b.clone().sub(a).normalize();
    // break where the round crossed the limb axis
    const hit = res.entryBind.clone().add(res.endBind).multiplyScalar(0.5);
    const t = THREE.MathUtils.clamp(hit.clone().sub(a).dot(axis), 0.02, b.distanceTo(a) - 0.04);
    const c = a.clone().addScaledVector(axis, t);
    // a ring of tissue blown away, leaving a strip on one side
    const t1 = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 0, 1)).normalize();
    if (t1.lengthSq() < 0.1) t1.set(1, 0, 0);
    const t2 = new THREE.Vector3().crossVectors(axis, t1);
    const keep = Math.random() * Math.PI * 2;
    for (let i = 0; i < 7; i++) {
      const ang = keep + 0.7 + (i / 6) * (Math.PI * 2 - 1.4);
      const rd = t1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(t2, Math.sin(ang));
      const p = c.clone().addScaledVector(rd, L.r * 0.9);
      this.addTract(kit, p.clone().addScaledVector(axis, -0.025), p.clone().addScaledVector(axis, 0.025), L.r * 0.55, L.r * 0.55);
    }
    this.addTract(kit, c.clone().addScaledVector(axis, -0.02), c.clone().addScaledVector(axis, 0.02), L.r * 0.45, L.r * 0.45); // bone gap
    this.refresh(kit);
    // physiology: the limb is gone as far as he's concerned, and it pours
    const ph = kit.phys;
    ph.limbs[L.limb + seg.side] = 0;
    ph.fracture[L.limb + seg.side] = true;
    ph.pain = 1;
    ph.addBleed({ part: 'mangled ' + seg.seg, rate: L.limb === 'leg' ? 7 : 4, external: 1, anchor: kit.addAnchor(brk, c, t1), pulsatile: true });
    actor.mangled[seg.seg + seg.side] = { brk: brk.name, at: c };
    // swing
    this.dangles.push({ actor, brk, child, tip: null, prev: null, len: 0 });
    if (!kit.postPose) kit.postPose = (dt) => this.postPose(kit, dt);
    this.game.audio.play('gib', { pos: tr.rayWorld.origin.clone().lerp(res.exitWorld || tr.rayWorld.origin, 1), volume: 0.8 });
    this.game.stats.dismember++;
  }

  postPose(kit, dt) {
    for (const d of this.dangles) {
      if (d.actor.kit !== kit) continue;
      const bp = d.brk.getWorldPosition(new THREE.Vector3());
      const cp = d.child.getWorldPosition(new THREE.Vector3());
      if (!d.tip) { d.tip = cp.clone(); d.prev = cp.clone(); d.len = bp.distanceTo(cp); }
      // verlet pendulum on the break
      const vel = d.tip.clone().sub(d.prev).multiplyScalar(0.96);
      d.prev.copy(d.tip);
      d.tip.add(vel).add(new THREE.Vector3(0, -9.81 * dt * dt, 0));
      d.tip.sub(bp).setLength(d.len).add(bp);
      if (d.tip.y < 0.03) d.tip.y = 0.03;
      const cur = cp.sub(bp).normalize();
      const want = d.tip.clone().sub(bp).normalize();
      const qd = new THREE.Quaternion().setFromUnitVectors(cur, want);
      const pw = d.brk.parent.getWorldQuaternion(new THREE.Quaternion());
      const w = d.brk.getWorldQuaternion(new THREE.Quaternion()).premultiply(qd);
      d.brk.quaternion.copy(pw.invert().multiply(w));
      d.child.quaternion.slerp(new THREE.Quaternion(), 0.5); // the rest of it goes slack
      d.brk.updateMatrixWorld(true);
    }
  }

  // --------------------------------------------------------- dismemberment
  // Cut `boneName` and everything below it out of the body; it flies off as a gib.
  sever(actor, boneName, dirW, key) {
    const kit = actor.kit, g = this.game;
    const cutBone = kit.npc.bone(boneName);
    if (!cutBone || kit.cutSet?.has(boneName)) return null;
    if (this.gibs.length >= 10) { const old = this.gibs.shift(); old.pivot.removeFromParent(); }
    kit.cutSet ||= new Set();
    const cutBones = new Set();
    cutBone.traverse((o) => { if (o.isBone) { cutBones.add(o); kit.cutSet.add(o.name); } });
    // also stop tracing the capsule frames that now hang off nothing
    for (const n of ['upperarm02', 'lowerarm01', 'wrist', 'upperleg02', 'lowerleg01', 'foot', 'head', 'neck02']) {
      for (const s of ['', '.L', '.R']) { const b = kit.npc.bone(n + s); if (b && cutBones.has(b)) kit.cutSet.add(b.name); }
    }
    kit.root.updateWorldMatrix(true, true);

    // stump: open the cut so muscle and bone show, and make it pour
    const a = cutBone.userData.restHead.clone();
    const childB = cutBone.children.find((c) => c.isBone);
    const axis = childB ? childB.userData.restHead.clone().sub(a).normalize() : new THREE.Vector3(0, 1, 0);
    const r = boneName.startsWith('upperleg') ? 0.09 : boneName.startsWith('neck') ? 0.07 : 0.06;
    this.addTract(kit, a.clone().addScaledVector(axis, -0.03), a.clone().addScaledVector(axis, 0.03), r * 0.4, r * 0.4);
    this.refresh(kit);

    // gib: a skeleton clone that keeps only the cut part
    const gib = cloneSkinned(kit.root);
    const gu = createGoreUniforms();
    copyUniforms(kit.uniforms, gu);
    gu.uCutKeep.value = 1;
    const cutNames = new Set([...cutBones].map((b) => b.name));
    const strip = [];
    gib.traverse((o) => {
      if (o.isSkinnedMesh) {
        if (o.material.userData.goreKind !== undefined) o.material = gibMaterial(o.material, gu);
        else if (!cutNames.has('head')) strip.push(o); // eyes/teeth only travel with a head
      } else if (o.isMesh && !underCut(o, cutNames)) strip.push(o);
    });
    for (const o of strip) o.removeFromParent();
    // and the body loses everything that was riding on the cut part
    kit.root.traverse((o) => {
      if (o.isMesh && !o.isSkinnedMesh && underCut(o, cutNames)) o.visible = false;
      if (o.isSkinnedMesh && o.material.userData.goreKind === undefined && cutNames.has('head')) o.visible = false;
    });
    for (let i = 0; i < kit.skeleton.bones.length; i++) if (cutBones.has(kit.skeleton.bones[i])) kit.uniforms.uCut.value[i] = 1;

    const pivot = new THREE.Group();
    const at = cutBone.getWorldPosition(new THREE.Vector3());
    pivot.position.copy(at);
    g.scene.add(pivot, gib);
    pivot.attach(gib);
    const vel = dirW.clone().multiplyScalar(rnd(2, 3.5)).add(new THREE.Vector3(0, rnd(1, 2.2), 0));
    const spin = new THREE.Vector3(rnd(-9, 9), rnd(-9, 9), rnd(-9, 9));
    const spurt = new THREE.Object3D();
    pivot.add(spurt);
    spurt.lookAt(at.clone().sub(dirW));
    g.gore.emitter(spurt, 40, 5, new THREE.Vector3(0, 0, 1));
    this.gibs.push({ pivot, vel, spin, rest: false, r: boneName.startsWith('neck') ? 0.1 : 0.07, t: 0 });

    const ph = kit.phys;
    const stumpAnchor = kit.addAnchor(cutBone.parent.isBone ? cutBone.parent : cutBone, a, axis);
    if (boneName.startsWith('neck')) { ph.brain = 0; ph.consciousness = 0; ph.die('decapitated'); }
    else {
      const limb = /leg/.test(boneName) ? 'leg' : 'arm';
      const side = boneName.endsWith('L') ? 'L' : 'R';
      ph.limbs[limb + side] = 0;
      ph.fracture[limb + side] = true;
      ph.pain = 1;
    }
    ph.addBleed({ part: 'stump', rate: boneName.startsWith('upperleg') ? 14 : 9, external: 1, anchor: stumpAnchor, pulsatile: true });
    const blood = kit.world.blood;
    blood.spray(at, dirW, 4, 60, { spread: 0.5, dropMl: 0.05 });
    blood.chunks(at, dirW, 4, 12, 1);
    blood.chunks(at, dirW, 4, 6, 2);
    g.gore.mist(at, 0.8);
    g.audio.play('gib', { pos: at, volume: 1.3 });
    g.stats.dismember++;
    this.dangles = this.dangles.filter((d) => !(d.actor === actor && cutBones.has(d.child)));
    actor.onSevered?.(key);
    return key;
  }

  addTract(kit, a, b, rA, rB) {
    if (kit.wounds.length >= MAX_WOUNDS) kit.wounds.shift();
    kit.wounds.push({ a, b, rA, rB, bone: null, exits: true });
  }

  refresh(kit) {
    const U = kit.uniforms;
    kit.wounds.forEach((x, i) => {
      U.uWoundA.value[i].set(x.a.x, x.a.y, x.a.z, x.rA);
      U.uWoundB.value[i].set(x.b.x, x.b.y, x.b.z, x.rB);
    });
    U.uWoundCount.value = kit.wounds.length;
    kit.applyXRay(kit.world.xray);
  }

  flower(actor, bone, worldPos, worldDir, opts, outer, inner, droop = false) {
    bone.updateWorldMatrix(true, false);
    const bq = bone.getWorldQuaternion(new THREE.Quaternion());
    const q = new THREE.Quaternion().setFromUnitVectors(Z, worldDir.clone().normalize());
    const local = bq.clone().invert().multiply(q);
    if (droop) opts.droop = new THREE.Vector3(0, -1, 0).applyQuaternion(q.clone().invert());
    const mesh = new THREE.Mesh(flowerGeometry(opts), flapMaterial(outer, inner));
    mesh.castShadow = true;
    mesh.position.copy(bone.worldToLocal(worldPos.clone()));
    mesh.quaternion.copy(local);
    bone.add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------- update
  update(dt) {
    const level = this.game.level;
    for (const gb of this.gibs) {
      if (gb.rest) continue;
      gb.t += dt;
      const p = gb.pivot;
      gb.vel.y -= 9.81 * dt;
      p.position.addScaledVector(gb.vel, dt);
      p.rotation.x += gb.spin.x * dt; p.rotation.y += gb.spin.y * dt; p.rotation.z += gb.spin.z * dt;
      level.collide(p.position, gb.r, 3);
      if (p.position.y < gb.r) {
        p.position.y = gb.r;
        if (Math.abs(gb.vel.y) > 1.2) this.game.gore.splat(new THREE.Vector3(p.position.x, 0.001, p.position.z), new THREE.Vector3(0, 1, 0), 0.25);
        gb.vel.y *= -0.2; gb.vel.x *= 0.5; gb.vel.z *= 0.5;
        gb.spin.multiplyScalar(0.4);
        if (gb.vel.lengthSq() < 0.02 || gb.t > 5) gb.rest = true;
      }
    }
  }
}

function underCut(o, cutNames) {
  for (let p = o.parent; p; p = p.parent) if (p.isBone && cutNames.has(p.name)) return true;
  return false;
}

function copyUniforms(src, dst) {
  for (const k of Object.keys(src)) {
    const v = src[k].value;
    if (Array.isArray(v)) dst[k].value = v.map((x) => x.clone());
    else if (v instanceof Float32Array) dst[k].value = v.slice();
    else dst[k].value = v;
  }
}

// Same shader program as the body (so no recompile), but this gib's own uniforms.
function gibMaterial(orig, uniforms) {
  const m = orig.clone();
  const base = orig.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    const keep = orig.userData.shader;
    base.call(orig, sh, r);
    orig.userData.shader = keep;
    Object.assign(sh.uniforms, uniforms);
  };
  m.customProgramCacheKey = orig.customProgramCacheKey;
  m.userData = { ...orig.userData };
  return m;
}
