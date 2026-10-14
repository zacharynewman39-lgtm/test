import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadHairGeometry } from './hair.js';
import { makeMaterials } from './materials.js';

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

export async function loadNPC(renderer, BASE) {
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
  root.traverse((o) => {
    if (!o.isBone) return;
    rest.set(o, o.quaternion.clone());
    // bind-pose joint positions in NPC space (used by the ragdoll and hit capsules)
    o.userData.restHead = root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  });
  head.userData.tailOffset = new THREE.Vector3(0, 0.1, 0.01);
  head.userData.restTail = head.userData.restHead.clone().add(head.userData.tailOffset);
  let bodyMesh = null;
  const meshes = {};
  root.traverse((o) => { if (o.isSkinnedMesh) { meshes[o.name] = o; if (o.name === 'Body') bodyMesh = o; } });
  const flinches = [];
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

  let breathPhase = 0, lastT = 0;
  function pose(t, cond) {
    for (const [b, q] of rest) b.quaternion.copy(q);
    breathPhase += (t - lastT) * (cond.rr || 14) / 60 * 2 * Math.PI;
    lastT = t;
    const deep = 1 + 1.5 * Math.min(1, Math.max(0, (cond.rr - 16) / 20));
    const breath = Math.sin(breathPhase) * deep;
    const dazed = 1 - cond.consciousness;
    const sway = Math.sin(t * 2 * Math.PI / 9.0) * (1 + 6 * dazed) + Math.sin(t * 1.7) * 2 * dazed;

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
    // wounded: hunch, sag at the knees, injured arm hangs dead
    const hurt = Math.max(cond.pain * 0.6, dazed);
    rotWorld(bone('spine02'), X, hurt * 0.18);
    rotWorld(bone('neck01'), X, dazed * 0.35);
    for (const s of ['L', 'R']) {
      rotWorld(bone('lowerleg01.' + s), X, hurt * 0.12);
      if ((cond.limbs?.['arm' + s] ?? 1) < 0.5) {
        aim(bone('lowerarm01.' + s), bone('wrist.' + s), _v.set(0.03 * (s === 'L' ? 1 : -1), -1, 0.02));
      }
    }
    // hit reactions: damped rotational kicks
    for (let i = flinches.length - 1; i >= 0; i--) {
      const f = flinches[i];
      const age = t - f.t0;
      if (age > 1.5) { flinches.splice(i, 1); continue; }
      const a = f.amp * Math.exp(-age * 5) * Math.cos(age * 14);
      rotWorld(f.bone, f.axis, a);
    }
  }

  const healthy = { rr: 14, consciousness: 1, pain: 0, alive: true, limbs: null };
  function update(dt, t, camPos, playerPos, cond = healthy) {
    pose(t, cond);
    root.updateWorldMatrix(true, true);

    // ---------------------------------------------------- attention / look
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const toCam = camPos.clone().sub(headPos);
    const dist = toCam.length();
    const localDir = toCam.clone().normalize();
    const yaw = Math.atan2(localDir.x, localDir.z);
    const pitch = Math.asin(THREE.MathUtils.clamp(localDir.y, -1, 1));
    const interested = dist < 9 && Math.abs(yaw) < 2.0 && cond.consciousness > 0.5;
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
    if (t > st.nextBlink && st.blinkT < 0 && !(typeof window !== 'undefined' && window.__noBlink)) {
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
    const lid = THREE.MathUtils.clamp(-st.eye.y * 0.9, 0, 0.35) + (1 - cond.consciousness) * 0.6;
    morph('blinkL', Math.min(1, blink + lid));
    morph('blinkR', Math.min(1, blink + lid));
    if (cond.pain > 0.05 || cond.consciousness < 0.95) {
      // pain grimace: brows knit, eyes screw up, lips press, nostrils flare
      morph('browsInner', cond.pain * 0.8);
      morph('browsDown', cond.pain * 0.5);
      morph('squint', cond.pain * 0.6);
      morph('mouthPress', cond.pain * 0.5);
      morph('nostrils', Math.max(0, Math.sin(breathPhase)) * (0.15 + cond.pain * 0.6));
      morph('jawOpen', Math.max(0, Math.sin(breathPhase)) * 0.25 * Math.max(0, Math.min(1, (cond.rr - 18) / 15)) + (1 - cond.consciousness) * 0.2);
      morph('smile', 0); morph('browsUp', 0);
      return;
    }

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

  // face after death: lids half open, jaw slack, eyes fixed and slightly divergent
  function deadFace() {
    morph('blinkL', 0.45); morph('blinkR', 0.5);
    for (const n of ['smile', 'browsUp', 'browsInner', 'browsDown', 'squint', 'mouthPress', 'nostrils']) morph(n, 0);
    morph('jawOpen', 0.35);
    bone('eye.L').quaternion.setFromEuler(new THREE.Euler(0.12, 0.08, 0));
    bone('eye.R').quaternion.setFromEuler(new THREE.Euler(0.1, -0.12, 0));
  }

  function flinch(boneName, worldAxis, amp, t) {
    const b = bone(boneName);
    if (b) flinches.push({ bone: b, axis: worldAxis.clone().normalize(), amp, t0: t });
  }

  return {
    root,
    update,
    deadFace,
    flinch,
    bone,
    bones: B,
    bodyMesh,
    meshes,
    materials: mats,
    hair,
    morph,
    morphMeshes,
    state: st,
    boneWorld: (name, v) => bone(name).getWorldPosition(v),
    headWorld: (v) => head.getWorldPosition(v).add(_v2.set(0, 0.06, 0)),
  };
}
