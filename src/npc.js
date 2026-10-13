import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadHairGeometry } from './hair.js';
import { makeMaterials } from './materials.js';

const BASE = import.meta.env.BASE_URL + 'npc/';
const bn = (n) => n.replace(/[[\]\.:\/]/g, ''); // three's node-name sanitising

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

// Rotate a bone by `angle` around a WORLD axis (rest frames are world aligned).
function rotWorld(bone, axis, angle) {
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_q);
  _q2.setFromAxisAngle(axis, angle);
  const l = _q.clone().invert().multiply(_q2).multiply(_q);
  bone.quaternion.premultiply(l);
}

// Rotate `bone` so the direction to `child` points along worldDir.
function aim(bone, child, worldDir) {
  bone.updateWorldMatrix(true, true);
  const a = bone.getWorldPosition(new THREE.Vector3());
  const b = child.getWorldPosition(new THREE.Vector3());
  const cur = b.sub(a).normalize();
  const qd = new THREE.Quaternion().setFromUnitVectors(cur, worldDir.clone().normalize());
  applyWorld(bone, qd);
}

// Twist a bone about its own length.
function twist(bone, child, angle) {
  bone.updateWorldMatrix(true, true);
  const a = bone.getWorldPosition(new THREE.Vector3());
  const ax = child.getWorldPosition(new THREE.Vector3()).sub(a).normalize();
  applyWorld(bone, new THREE.Quaternion().setFromAxisAngle(ax, angle));
}

function applyWorld(bone, qd) {
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_q);
  const l = _q.clone().invert().multiply(qd).multiply(_q);
  bone.quaternion.premultiply(l);
}

function damp(a, b, k, dt) { return a + (b - a) * (1 - Math.exp(-k * dt)); }

export async function loadNPC(renderer) {
  const [gltf, hairGeo, mats] = await Promise.all([
    new GLTFLoader().loadAsync(BASE + 'npc.glb'),
    loadHairGeometry(BASE + 'hair.bin'),
    makeMaterials(renderer, BASE),
  ]);
  const root = gltf.scene;
  const B = {};
  root.traverse((o) => { if (o.isBone) B[o.name] = o; });
  const bone = (n) => B[bn(n)];

  const morphMeshes = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = mats[o.material.name];
    if (m) o.material = m;
    if (o.material.name === 'cornea') o.castShadow = false;
    if (o.morphTargetDictionary) morphMeshes.push(o);
  });

  const head = bone('head');
  const hair = new THREE.Mesh(hairGeo, mats.hair);
  hair.castShadow = true;
  hair.receiveShadow = true;
  hair.frustumCulled = false;
  head.add(hair);
  // hair positions are relative to the head bone's rest position
  root.updateWorldMatrix(true, true);

  const rest = new Map();
  root.traverse((o) => { if (o.isBone) rest.set(o, o.quaternion.clone()); });
  const hipsRest = bone('root').position.clone();

  const morph = (name, v) => {
    for (const m of morphMeshes) {
      const i = m.morphTargetDictionary[name];
      if (i !== undefined) m.morphTargetInfluences[i] = v;
    }
  };

  const fingers = [];
  for (const s of ['L', 'R']) {
    for (let f = 1; f <= 5; f++) {
      for (let j = 1; j <= 3; j++) {
        const b = bone(`finger${f}-${j}.${s}`);
        if (b) fingers.push({ b, f, j, s });
      }
    }
  }

  const st = {
    look: new THREE.Vector2(), eye: new THREE.Vector2(), sacc: new THREE.Vector2(),
    nextSacc: 0, nextBlink: 2, blink: 0, blinkT: -1, smile: 0, flash: 0, met: false,
    attention: 0,
  };

  function pose(t) {
    for (const [b, q] of rest) b.quaternion.copy(q);
    const breath = Math.sin(t * 2 * Math.PI / 4.2);
    const sway = Math.sin(t * 2 * Math.PI / 9.0);

    // weight on one leg, subtle sway
    const hips = bone('root');
    hips.position.copy(hipsRest).x += sway * 0.006;
    rotWorld(bone('spine05'), Z, -sway * 0.012);
    rotWorld(bone('spine03'), X, -breath * 0.010);
    rotWorld(bone('spine02'), X, -breath * 0.006);
    rotWorld(bone('spine01'), Z, sway * 0.010);

    // relaxed arms from the A-pose: aim each segment at a target direction
    for (const [s, sg] of [['L', 1], ['R', -1]]) {
      rotWorld(bone('clavicle.' + s), Z, -sg * (0.05 + breath * 0.006));
      aim(bone('upperarm01.' + s), bone('lowerarm01.' + s), _v.set(0.16 * sg, -1, 0.0));
      aim(bone('lowerarm01.' + s), bone('wrist.' + s), _v.set(0.08 * sg, -1, 0.30));
      twist(bone('lowerarm01.' + s), bone('wrist.' + s), sg * 0.45);
      aim(bone('wrist.' + s), bone('finger3-1.' + s), _v.set(0.04 * sg, -1, 0.18));
    }
    // relaxed finger curl
    for (const { b, f, j, s } of fingers) {
      const sg = s === 'L' ? 1 : -1;
      if (f === 1) continue; // thumb is aimed below
      const amt = (0.24 + 0.06 * f) * (j === 1 ? 0.6 : j === 2 ? 1.1 : 0.8);
      b.quaternion.multiply(_q2.setFromAxisAngle(Z, -sg * amt));
      // close the spread between fingers at the knuckles
      if (j === 1) b.quaternion.multiply(_q2.setFromAxisAngle(Y, sg * [0, 0, 0.06, 0, -0.06, -0.12][f]));
    }
    // thumb rests along the index finger, a little in front of it
    for (const s of ['L', 'R']) {
      const i1 = bone('finger2-1.' + s), i3 = bone('finger2-3.' + s);
      i1.updateWorldMatrix(true, true);
      const dir = i3.getWorldPosition(new THREE.Vector3()).sub(i1.getWorldPosition(new THREE.Vector3())).normalize();
      dir.z += 0.35;
      aim(bone('finger1-1.' + s), bone('finger1-3.' + s), dir);
      bone('finger1-2.' + s).quaternion.multiply(_q2.setFromAxisAngle(Z, (s === 'L' ? -1 : 1) * 0.25));
    }
    // legs: slight knee softness on the weight-bearing leg
    rotWorld(bone('upperleg01.R'), Z, -0.025);
    rotWorld(bone('upperleg01.L'), Z, 0.035);
    rotWorld(bone('lowerleg01.L'), X, 0.05);
  }

  function update(dt, t, camPos, playerPos) {
    pose(t);
    root.updateWorldMatrix(true, true);

    // ---------------------------------------------------- attention / look
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const toCam = camPos.clone().sub(headPos);
    const dist = toCam.length();
    const localDir = toCam.clone().normalize();
    const yaw = Math.atan2(localDir.x, localDir.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(localDir.y, -1, 1));
    const interested = dist < 9 && Math.abs(yaw) < 2.0;
    st.attention = damp(st.attention, interested ? 1 : 0, 2.0, dt);
    const tyaw = THREE.MathUtils.clamp(yaw, -1.0, 1.0) * st.attention;
    const tpitch = THREE.MathUtils.clamp(pitch, -0.35, 0.3) * st.attention;
    st.look.x = damp(st.look.x, tyaw, 3.0, dt);
    st.look.y = damp(st.look.y, tpitch, 3.0, dt);
    const idleYaw = Math.sin(t * 0.23) * 0.12 * (1 - st.attention);
    const neck = [['neck01', 0.2], ['neck02', 0.2], ['neck03', 0.2], ['head', 0.4]];
    for (const [n, w] of neck) {
      rotWorld(bone(n), Y, (st.look.x + idleYaw) * w);
      rotWorld(bone(n), X, -st.look.y * w);
    }
    root.updateWorldMatrix(true, true);

    // eyes: lead the head, with small saccades
    if (t > st.nextSacc) {
      st.sacc.set((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04);
      if (st.attention < 0.5) st.sacc.multiplyScalar(4);
      st.nextSacc = t + 0.4 + Math.random() * 2.2;
    }
    for (const s of ['L', 'R']) {
      const eb = bone('eye.' + s);
      const ep = eb.getWorldPosition(new THREE.Vector3());
      const target = st.attention > 0.05 ? camPos.clone().lerp(ep.clone().add(new THREE.Vector3(0, 0, 3).applyQuaternion(head.getWorldQuaternion(_q))), 1 - st.attention) : ep.clone().add(new THREE.Vector3(0, 0, 3).applyQuaternion(head.getWorldQuaternion(_q)));
      const d = target.sub(ep).normalize();
      eb.parent.getWorldQuaternion(_q);
      d.applyQuaternion(_q.invert());
      let ey = Math.atan2(d.x, d.z) + st.sacc.x;
      let ex = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) + st.sacc.y;
      ey = THREE.MathUtils.clamp(ey, -0.45, 0.45);
      ex = THREE.MathUtils.clamp(ex, -0.3, 0.3);
      eb.quaternion.setFromEuler(new THREE.Euler(-ex, ey, 0, 'YXZ'));
      st.eye.set(ey, ex);
    }

    // ------------------------------------------------------------ blinks
    if (t > st.nextBlink && st.blinkT < 0 && !window.__noBlink) {
      st.blinkT = 0;
      st.nextBlink = t + 1.8 + Math.random() * 4.5;
      if (Math.random() < 0.15) st.nextBlink = t + 0.35;
    }
    let blink = 0;
    if (st.blinkT >= 0) {
      st.blinkT += dt;
      const bt = st.blinkT;
      blink = bt < 0.07 ? bt / 0.07 : Math.max(0, 1 - (bt - 0.09) / 0.13);
      if (bt > 0.25) st.blinkT = -1;
    }
    // lids follow the gaze down
    const lid = THREE.MathUtils.clamp(-st.eye.y * 0.9, 0, 0.35);
    morph('blinkL', Math.min(1, blink + lid));
    morph('blinkR', Math.min(1, blink + lid));

    // greet with an eyebrow flash and a soft smile when you come close
    const pd = Math.hypot(playerPos.x - root.position.x, playerPos.z - root.position.z);
    if (pd < 3.0 && !st.met) { st.met = true; st.flash = 1; }
    if (pd > 6) st.met = false;
    st.flash = Math.max(0, st.flash - dt * 1.6);
    st.smile = damp(st.smile, pd < 3.5 ? 0.45 : 0.0, 1.5, dt);
    morph('smile', st.smile);
    morph('browsUp', Math.sin(Math.min(1, st.flash) * Math.PI) * 0.6);
    morph('squint', st.smile * 0.25);
    morph('nostrils', Math.max(0, breath01(t)) * 0.15);
  }

  function breath01(t) { return Math.sin(t * 2 * Math.PI / 4.2); }

  return {
    root,
    update,
    morph,
    morphMeshes,
    state: st,
    boneWorld: (name, v) => bone(name).getWorldPosition(v),
    headWorld: (v) => head.getWorldPosition(v).add(_v2.set(0, 0.06, 0)),
  };
}
