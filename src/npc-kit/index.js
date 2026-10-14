import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { loadNPC } from './npc.js';
import { loadAnatomy, raycastAll, partOfFace, LAYERS } from './anatomy.js';
import { createGoreUniforms, applyGore, MAX_WOUNDS, MAX_STAINS } from './woundShader.js';
import { Physiology } from './physiology.js';
import { BloodFX } from './blood.js';
import { Ragdoll } from './ragdoll.js';

// ============================================================================
//  NPC KIT
//  const world = createGoreWorld({ scene, renderer, baseUrl: '/npc/' });
//  const npc = await world.spawnNPC({ position: new THREE.Vector3(0, 0, 0) });
//  every frame:  world.update(dt, { camera, playerPos });
//  firing:       world.shoot(origin, direction, 'rifle')  -> hit report
// ============================================================================

export const WEAPONS = {
  pistol: { label: '9mm pistol', energy: 500, entryR: 0.0045, cavity: 0.012, pellets: 1, spread: 0, push: 0.6 },
  rifle: { label: '7.62mm rifle', energy: 3300, entryR: 0.004, cavity: 0.045, pellets: 1, spread: 0, push: 1.2 },
  shotgun: { label: '12ga buckshot', energy: 430, entryR: 0.0045, cavity: 0.01, pellets: 9, spread: 0.03, push: 0.4 },
};

// kinetic energy a projectile loses per metre of each tissue (J/m)
const RESIST = {
  skin: 1500, fat: 250, muscle: 900, tendon: 1300, bone: 9000, marrow: 600, cartilage: 2600, disc: 2000,
  lung: 150, airway: 500, brain: 650, white_matter: 650, brainstem: 650, cerebellum: 650, csf: 300,
  spinal_cord: 650, nerve: 900, artery: 900, vein: 700, heart: 900, heart_blood: 600, liver: 800,
  spleen: 800, kidney: 850, default: 700,
};
const LAYER_SCALE = { fat: 0.95, muscle: 0.85, skeleton: 0.6, organs: 0.9, arteries: 1.25, veins: 1.2, nerves: 1.0, cns: 0.9 };
const SOLID_ORGANS = new Set(['liver', 'spleen', 'kidney', 'lung', 'heart', 'brain', 'white_matter', 'intestine', 'colon', 'stomach']);

// coarse hit capsules: [frame bone, from joint, to joint, radius]
const CAPSULES = [
  ['head', 'head', 'head:tail', 0.105], ['neck02', 'neck01', 'head', 0.065],
  ['spine01', 'spine02', 'neck01', 0.17], ['spine03', 'spine05', 'spine02', 0.16], ['root', 'root', 'spine05', 0.17],
  ...['L', 'R'].flatMap((s) => [
    [`upperarm02.${s}`, `upperarm01.${s}`, `lowerarm01.${s}`, 0.06], [`lowerarm01.${s}`, `lowerarm01.${s}`, `wrist.${s}`, 0.05],
    [`wrist.${s}`, `wrist.${s}`, `finger3-3.${s}`, 0.055],
    [`upperleg02.${s}`, `upperleg01.${s}`, `lowerleg01.${s}`, 0.1], [`lowerleg01.${s}`, `lowerleg01.${s}`, `foot.${s}`, 0.07],
    [`foot.${s}`, `foot.${s}`, `toe2-1.${s}`, 0.06],
  ]),
];

export function createGoreWorld({ scene, renderer, baseUrl = '/npc/', groundHeight = () => 0, anatomyParts = null, hair = true }) {
  const blood = new BloodFX(scene, { groundHeight });
  const world = {
    scene, renderer, baseUrl, groundHeight, blood, npcs: [], t: 0, xray: 0, anatomyParts, hair,
    // optional callbacks: onHit(npc, report), onDown(npc), onDeath(npc, cause)
    onHit: null, onDown: null, onDeath: null,
    async spawnNPC(opts = {}) {
      const npc = await GoreNPC.create(world, opts);
      world.npcs.push(npc);
      return npc;
    },
    update(dt, ctx) {
      world.t += dt;
      for (const n of world.npcs) n.update(dt, world.t, ctx);
      blood.update(dt);
    },
    // returns { hit, npc, parts, events, wounds } for the first NPC hit
    shoot(origin, direction, weapon = 'pistol') {
      const w = typeof weapon === 'string' ? WEAPONS[weapon] : weapon;
      let report = { hit: false, parts: [], events: [] };
      for (let p = 0; p < w.pellets; p++) {
        const d = direction.clone().normalize();
        if (w.spread) d.add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).multiplyScalar(w.spread)).normalize();
        // follow the projectile through every body segment it perforates
        let o = origin.clone();
        let energy = w.energy;
        let entryR = w.entryR;
        const skip = new Set();
        for (let seg = 0; seg < 4 && energy > 40; seg++) {
          let best = null;
          for (const n of world.npcs) {
            const r = n.trace(o, d, skip);
            if (r && (!best || r.distance < best.distance)) best = r;
          }
          if (!best) break;
          const res = best.npc.applyHit(best, { ...w, energy, entryR }, seg > 0);
          world.onHit?.(best.npc, res);
          report.hit = true; report.npc = report.npc || best.npc;
          report.parts.push(...res.parts); report.events.push(...res.events);
          if (!res.exitWorld) break;
          energy = res.remaining;
          entryR = Math.max(w.entryR, res.exitR * 0.6);  // a deformed/tumbling round
          skip.add(best.bone.name);
          o = res.exitWorld.clone().addScaledVector(d, 0.002);
        }
      }
      return report;
    },
    // anatomy viewer: 0 off, 1 muscles, 2 organs+vessels+skeleton, 3 skeleton+nerves+cns, 4 circulation
    setXRay(mode) {
      world.xray = mode;
      for (const n of world.npcs) n.applyXRay(mode);
    },
  };
  return world;
}

class GoreNPC {
  static async create(world, { position = new THREE.Vector3(), rotationY = 0 } = {}) {
    const self = new GoreNPC();
    self.world = world;
    self.npc = await loadNPC(world.renderer, world.baseUrl, { hair: world.hair });
    self.root = self.npc.root;
    self.root.position.copy(position);
    self.root.rotation.y = rotationY;
    world.scene.add(self.root);
    self.anat = await loadAnatomy(world.baseUrl, self.npc.bodyMesh, world.anatomyParts);
    for (const m of Object.values(self.anat.layers)) self.root.add(m);
    self.uniforms = createGoreUniforms();
    self.setupMaterials();
    // bind-space BVH of the whole skin (visible + under the clothes) for entry/exit points
    const bg = self.npc.bodyMesh.geometry;
    if (!bg.userData.skinGeo) { // built once, shared by every NPC
      const hg = self.npc.meshes.BodyHidden.geometry;
      const skin = new THREE.BufferGeometry();
      skin.setAttribute('position', bg.getAttribute('position'));
      const idx = new Uint32Array(bg.index.count + hg.index.count);
      idx.set(bg.index.array); idx.set(hg.index.array, bg.index.count);
      skin.setIndex(new THREE.BufferAttribute(idx, 1));
      skin.boundsTree = new MeshBVH(skin);
      bg.userData.skinGeo = skin;
    }
    self.skinGeo = bg.userData.skinGeo;
    if (!bg.userData.vertSeg) { // body segment that owns each skin vertex (by strongest skin weight)
      const si = bg.getAttribute('skinIndex'), sw = bg.getAttribute('skinWeight');
      const bones = self.npc.bodyMesh.skeleton.bones;
      const boneSeg = bones.map((b) => segmentOfBone(b));
      const vs = new Array(si.count);
      for (let i = 0; i < si.count; i++) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        vs[i] = boneSeg[best];
      }
      bg.userData.vertSeg = vs;
    }
    self.vertSeg = bg.userData.vertSeg;
    self.skeleton = self.npc.bodyMesh.skeleton;
    self.boneIndex = new Map(self.skeleton.bones.map((b, i) => [b, i]));
    self.vertebrae = self.anat.parts.filter((p) => /vertebra|^Atlas$|^Axis$/.test(p.name));
    self.reset();
    return self;
  }

  setupMaterials() {
    const m = this.npc.materials;
    applyGore(m.skin, this.uniforms, 0, 1.0);
    applyGore(m.skin_hidden, this.uniforms, 0, 1.0, { revealOnly: true });
    applyGore(m.shirt, this.uniforms, 1, 1.25);
    applyGore(m.denim, this.uniforms, 1, 1.2);
    applyGore(m.leather, this.uniforms, 1, 1.0);
    this.anatMats = {};
    for (const [layer, mesh] of Object.entries(this.anat.layers)) {
      const isBone = layer === 'skeleton';
      const mat = new THREE.MeshPhysicalMaterial({
        vertexColors: true, roughness: isBone ? 0.45 : layer === 'fat' ? 0.3 : 0.28,
        clearcoat: isBone ? 0.2 : 0.7, clearcoatRoughness: 0.15, sheen: isBone ? 0 : 0.35,
        sheenColor: new THREE.Color(0.9, 0.5, 0.5), specularIntensity: 0.7,
      });
      // interior tissue is only ever seen through wounds: clip it to their surroundings
      applyGore(mat, this.uniforms, isBone ? 4 : layer === 'fat' ? 3 : 2, LAYER_SCALE[layer] ?? 0.9, { revealDist: 0.045 });
      mesh.material = mat;
      this.anatMats[layer] = mat;
    }
  }

  reset() {
    this.phys = new Physiology(this.anat.meta);
    this.wounds = [];
    this.anchors = [];
    this.uniforms.uWoundCount.value = 0;
    this.uniforms.uStainCount.value = 0;
    this.ragdoll = new Ragdoll(this.root, this.npc.bone, this.world.groundHeight);
    this.lastJoints = null;
    this.deadFor = 0;
    this.wasAlive = true;
    this.mouthAnchor = null;
    for (const m of this.npc.morphMeshes) m.morphTargetInfluences.fill(0);
    this.npc.bone('eye.L').quaternion.identity();
    this.npc.bone('eye.R').quaternion.identity();
    this.applyXRay(this.world.xray);
  }

  applyXRay(mode) {
    const show = {
      0: null, 1: ['muscle', 'skeleton'], 2: ['organs', 'arteries', 'veins', 'skeleton', 'cns'],
      3: ['skeleton', 'nerves', 'cns'], 4: ['arteries', 'veins', 'organs'],
    }[mode];
    this.uniforms.uXRay.value = show ? 1 : 0;
    const outer = Object.values(this.npc.meshes).concat([this.npc.hair]);
    for (const o of outer) o.visible = !show;
    for (const [layer, mesh] of Object.entries(this.anat.layers)) {
      mesh.visible = show ? show.includes(layer) : this.wounds.length > 0;
    }
  }

  // world <- bind transform of a bone (rigid part of the skinning)
  boneMatrix(bone, out = new THREE.Matrix4()) {
    const i = this.boneIndex.get(bone);
    return out.multiplyMatrices(bone.matrixWorld, this.skeleton.boneInverses[i]).multiply(this.npc.bodyMesh.bindMatrix);
  }

  jointWorld(spec) {
    if (spec === 'head:tail') { const h = this.npc.bone('head'); return h.localToWorld(h.userData.tailOffset.clone()); }
    return this.npc.bone(spec).getWorldPosition(new THREE.Vector3());
  }

  // find the first skin interval this ray passes through
  trace(origin, dir, skip = new Set()) {
    this.root.updateWorldMatrix(true, true);
    const ray = new THREE.Ray(origin, dir);
    const hits = [];
    for (const [frame, a, b, r] of CAPSULES) {
      const t = rayCapsule(ray, this.jointWorld(a), this.jointWorld(b), r);
      if (t !== null) hits.push({ t, frame });
    }
    hits.sort((x, y) => x.t - y.t);
    const tried = new Set();
    // Capsules overlap (the chest capsule reaches the jaw, the hip capsule the
    // thighs), so prefer the first frame whose entry skin actually belongs to
    // that segment; fall back to the nearest one.
    let fallback = null;
    for (const h of hits) {
      if (tried.has(h.frame) || skip.has(h.frame) || this.cutSet?.has(h.frame)) continue;
      tried.add(h.frame);
      const bone = this.npc.bone(h.frame);
      const M = this.boneMatrix(bone);
      const inv = M.clone().invert();
      const rb = ray.clone().applyMatrix4(inv);
      rb.direction.normalize();
      const skin = raycastAll(this.skinGeo, rb, 5);
      if (!skin.length) continue;
      const entry = skin[0];
      if (entry.face.normal.dot(rb.direction) > 0) continue; // started inside
      // a closed skin: the next crossing after the entry is the exit
      const exit = skin.find((s) => s.distance > entry.distance + 0.003);
      const entryWorld = entry.point.clone().applyMatrix4(M);
      const entrySeg = this.vertSeg[entry.face.a];
      const tr = { npc: this, bone, M, inv, rb, entry, exit, distance: entryWorld.distanceTo(origin), rayWorld: ray, entrySeg };
      const frameSeg = segmentOfBone(bone);
      if (entrySeg === frameSeg || (TORSO.has(entrySeg) && TORSO.has(frameSeg))) return tr;
      fallback ||= tr;
    }
    return fallback;
  }

  applyHit(tr, weapon, continued = false) {
    const { rb, entry, exit, bone, M } = tr;
    const d0 = entry.distance;
    const d1 = exit ? exit.distance : d0 + 0.6;
    // every anatomical structure crossed between entry and exit
    const crossings = new Map();
    for (const mesh of Object.values(this.anat.layers)) {
      for (const h of raycastAll(mesh.geometry, rb, d1 + 0.001)) {
        if (h.distance < d0 - 0.002) continue;
        const pid = partOfFace(mesh.geometry, h.faceIndex);
        const c = crossings.get(pid) || { pid, min: h.distance, max: h.distance, n: 0 };
        c.min = Math.min(c.min, h.distance); c.max = Math.max(c.max, h.distance); c.n++;
        crossings.set(pid, c);
      }
    }
    const segs = [...crossings.values()].sort((a, b) => a.min - b.min);
    let E = weapon.energy - RESIST.skin * 0.003 - RESIST.fat * 0.008;
    let stop = null;
    const hitParts = [];
    let boneHit = false, brainHit = false;
    for (const s of segs) {
      const part = this.anat.parts[s.pid];
      if (part.tissue === 'fat') continue;
      const len = Math.max(0.002, s.max - s.min);
      const res = RESIST[part.tissue] ?? RESIST.default;
      const eHere = Math.min(E, res * len);
      const travelled = res > 0 ? eHere / res : len;
      hitParts.push({ part, length: travelled, nearExit: exit ? (s.min - d0) / (d1 - d0) > 0.5 : false, at: s.min });
      if (part.tissue === 'bone') boneHit = true;
      if (/brain|white_matter|cerebellum|brainstem/.test(part.tissue)) brainHit = true;
      E -= eHere;
      if (E <= 0) { stop = s.min + travelled; break; }
    }
    // skin at the exit takes energy too
    const exits = exit && E > RESIST.skin * 0.004;
    const tEnd = exits ? d1 : (stop ?? Math.min(d1, d0 + 0.25));
    const remaining = Math.max(0, E);

    // temporary cavity: high-energy rounds bruise/tear solid organs near the tract
    if (weapon.cavity > 0.02) {
      const a = rb.at(d0, new THREE.Vector3()), b = rb.at(tEnd, new THREE.Vector3());
      for (const part of this.anat.parts) {
        if (!SOLID_ORGANS.has(part.tissue) || crossings.has(part.id)) continue;
        const c = new THREE.Vector3().fromArray(part.centre);
        if (distToSegment(c, a, b) < weapon.cavity) hitParts.push({ part, length: 0.004, nearExit: false, cavity: true });
      }
    }
    // spinal cord level from the nearest vertebra
    for (const h of hitParts) {
      if (h.part.tissue !== 'spinal_cord') continue;
      const pt = rb.at(h.at ?? d0, new THREE.Vector3());
      let best = null, bd = 1e9;
      for (const v of this.vertebrae) { const dd = pt.distanceTo(new THREE.Vector3().fromArray(v.centre)); if (dd < bd) { bd = dd; best = v; } }
      h.cordLevel = best ? vertebraLevel(best.name) : 'T6';
    }

    // ------------------------------------------------ wound geometry (bind space)
    const pEntry = rb.at(d0, new THREE.Vector3());
    const pEnd = rb.at(tEnd, new THREE.Vector3());
    const rEntry = weapon.entryR * (1 + 0.3 * Math.random());
    let rExit = exits ? Math.min(0.05, weapon.entryR * (1.4 + remaining / 450) + (boneHit ? 0.008 : 0) + (brainHit && weapon.energy > 1500 ? 0.02 : 0) + weapon.cavity * 0.25)
      : weapon.entryR * 1.1;
    const wound = {
      a: pEntry.clone().addScaledVector(rb.direction, -0.06), b: exits ? pEnd.clone().addScaledVector(rb.direction, 0.06) : pEnd,
      rA: rEntry, rB: rExit, bone, exits,
    };
    this.addWound(wound);
    const entryAnchor = this.addAnchor(bone, pEntry, rb.direction.clone().negate());
    const exitAnchor = exits ? this.addAnchor(bone, pEnd, rb.direction.clone()) : null;

    // ------------------------------------------------ physiology
    const before = this.phys.events.length;
    this.phys.damage({ segments: hitParts, entryAnchor, exitAnchor, radius: Math.max(rEntry, rExit * 0.5) });
    const events = this.phys.events.slice(before).map((e) => e.text);

    // ------------------------------------------------ immediate effects (world space)
    const blood = this.world.blood;
    const wEntry = pEntry.clone().applyMatrix4(M);
    const dirW = tr.rayWorld.direction.clone();
    // back-spatter: a fine spray toward the shooter
    blood.spray(wEntry, dirW.clone().negate(), 1.2 + Math.random(), 0.3 + weapon.energy / 3000, { spread: 0.45, dropMl: 0.006 });
    let wExit = null;
    if (exits) {
      wExit = pEnd.clone().applyMatrix4(M);
      const vol = 4 + remaining / 60 + (boneHit ? 6 : 0) + (brainHit ? 20 : 0);
      blood.spray(wExit, dirW, 3 + remaining / 300, vol, { spread: 0.35, dropMl: 0.025 });
      if (weapon.energy > 1500) blood.mist(wExit, dirW, 6, vol * 0.3);
      if (brainHit) blood.chunks(wExit, dirW, 4 + remaining / 400, 18, 1);
      if (boneHit) blood.chunks(wExit, dirW, 4, 8, 2);
      if (!brainHit && remaining > 800) blood.chunks(wExit, dirW, 3, 5, 1);
    }
    if (this.ragdoll.active) this.ragdoll.impulse(wEntry, dirW.clone().multiplyScalar(weapon.push * 1.5));
    else {
      const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dirW).normalize();
      this.npc.flinch(bone.name.includes('spine') || bone.name === 'root' ? 'spine03' : bone.name, axis, 0.12 * weapon.push, this.world.t);
      this.npc.flinch('spine02', axis, 0.06 * weapon.push, this.world.t);
    }
    this.pendingImpulse = { point: wEntry, vel: dirW.clone().multiplyScalar(weapon.push * 1.2) };
    this.applyXRay(this.world.xray);
    return { parts: hitParts.map((h) => h.part.name), events, exitWorld: wExit, remaining, exitR: rExit,
      boneHit, brainHit, exits, entryBind: pEntry, endBind: pEnd, dirBind: rb.direction.clone(), wound, tissues: hitParts.map((h) => h.part.tissue) };
  }

  addWound(w) {
    if (this.wounds.length >= MAX_WOUNDS) this.wounds.shift();
    this.wounds.push(w);
    const U = this.uniforms;
    this.wounds.forEach((x, i) => {
      U.uWoundA.value[i].set(x.a.x, x.a.y, x.a.z, x.rA);
      U.uWoundB.value[i].set(x.b.x, x.b.y, x.b.z, x.rB);
    });
    U.uWoundCount.value = this.wounds.length;
  }

  addAnchor(bone, pos, normal) {
    const a = { bone, pos: pos.clone(), normal: normal.clone().normalize(), vol: 0, id: this.anchors.length };
    if (this.anchors.length < MAX_STAINS) this.anchors.push(a);
    return a;
  }

  // --------------------------------------------------------------- per frame
  // A game can drive the pose itself (its own AI/animation): set `driver` to a
  // function(dt) that poses the skeleton, and call goLimp() to hand over to the ragdoll.
  goLimp() {
    if (this.ragdoll.active) return;
    this.ragdoll.activate(this.lastJoints, 1 / 60);
    if (this.pendingImpulse) this.ragdoll.impulse(this.pendingImpulse.point, this.pendingImpulse.vel);
  }

  update(dt, t, { camera, playerPos }) {
    const ph = this.phys.step(dt);
    const cond = { rr: ph.rr, consciousness: ph.consciousness, pain: ph.pain, alive: ph.alive, limbs: ph.limbs };

    if (this.wasAlive && !ph.alive) this.world.onDeath?.(this, ph.cause);
    this.wasAlive = ph.alive;
    if (this.driver && !this.ragdoll.active) {
      this.driver(dt, t, cond);
      this.root.updateWorldMatrix(true, true);
      this.lastJoints = this.captureJoints();
    } else if (!this.ragdoll.active && !ph.canStand) {
      this.world.onDown?.(this);
      this.ragdoll.activate(this.lastJoints, dt);
      if (this.pendingImpulse) this.ragdoll.impulse(this.pendingImpulse.point, this.pendingImpulse.vel);
    }
    if (this.ragdoll.active) {
      this.deadFor += ph.alive ? 0 : dt;
      const agonal = ph.alive ? (1 - ph.consciousness) * 0.3 : Math.max(0, 1 - this.deadFor / 6) * 0.8;
      this.ragdoll.step(dt, agonal);
      this.ragdoll.apply();
      if (!ph.alive || ph.consciousness < 0.2) this.npc.deadFace();
      else this.npc.morph('browsInner', ph.pain);
    } else if (!this.driver) {
      this.npc.update(dt, t, camera.position, playerPos, cond);
      this.lastJoints = this.captureJoints();
    }
    this.postPose?.(dt);
    this.root.updateWorldMatrix(true, true);
    this.emitBlood(dt);
    this.orificeBleeding(dt, t);
    this.uniforms.uGoreTime.value = t;
    const loss = ph.lossFraction;
    const pallor = Math.max(smooth01(0.12, 0.45, loss), ph.alive ? 0 : Math.min(1, 0.5 + this.deadFor / 30));
    this.uniforms.uPallor.value = pallor;
    this.uniforms.uCyanosis.value = smooth01(0.92, 0.6, ph.spo2) * (ph.alive ? 1 : 0.7);
  }

  // blood from the mouth (lung/airway injury: coughed with each breath),
  // nose and ears (skull/facial fractures)
  orificeBleeding(dt, t) {
    const ph = this.phys;
    const blood = this.world.blood;
    const head = this.npc.bone('head');
    const M = this.boneMatrix(head);
    const at = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(M);
    const fwd = new THREE.Vector3(0, -0.2, 1).transformDirection(M);
    const airwayBlood = ph.hemothorax > 30 || ph.airway < 1 || ph.bleeds.some((b) => b.aspirate);
    const mouth = head.userData.restHead.clone().add(new THREE.Vector3(0, -0.075, 0.105));
    if (airwayBlood && ph.alive && ph.rr > 0) {
      this.coughT = (this.coughT ?? 0) - dt;
      if (this.coughT <= 0) {
        this.coughT = 1.5 + Math.random() * 3.5;
        const ml = 1 + Math.random() * 3 + ph.hemothorax / 400;
        blood.spray(at(mouth.x, mouth.y, mouth.z), fwd, 1.5 + Math.random() * 1.5, ml, { spread: 0.3, dropMl: 0.03 });
        blood.mist(at(mouth.x, mouth.y, mouth.z), fwd, 2.5, ml * 0.2);
        this.npc.morph && this.npc.morph('jawOpen', 0.6);
        if (this.anchors.length < MAX_STAINS && !this.mouthAnchor) this.mouthAnchor = this.addAnchor(head, mouth, new THREE.Vector3(0, -0.3, 1));
        if (this.mouthAnchor) this.mouthAnchor.vol += ml * 0.6;
      }
    }
    if (ph.fracture.skull || ph.brain <= 0) {
      const ml = (ph.alive ? 0.25 : 0.06) * dt;
      for (const sx of [-0.012, 0.012]) blood.drip(at(head.userData.restHead.x + sx, head.userData.restHead.y - 0.035, head.userData.restHead.z + 0.115), ml);
      if (ph.brain <= 0) for (const sx of [-0.075, 0.075]) blood.drip(at(head.userData.restHead.x + sx, head.userData.restHead.y + 0.01, head.userData.restHead.z + 0.0), ml * 0.5);
    }
  }

  captureJoints() {
    const out = {};
    for (const [n, spec] of Object.entries({ pelvis: 'root', belly: 'spine03', chest: 'spine01', neck: 'neck02', shoL: 'upperarm01.L', shoR: 'upperarm01.R', elbL: 'lowerarm01.L', elbR: 'lowerarm01.R', wriL: 'wrist.L', wriR: 'wrist.R', hanL: 'finger3-2.L', hanR: 'finger3-2.R', hipL: 'upperleg01.L', hipR: 'upperleg01.R', kneL: 'lowerleg01.L', kneR: 'lowerleg01.R', ankL: 'foot.L', ankR: 'foot.R', toeL: 'toe2-1.L', toeR: 'toe2-1.R' })) {
      out[n] = this.npc.bone(spec).getWorldPosition(new THREE.Vector3());
    }
    out.head = this.jointWorld('head:tail');
    return out;
  }

  emitBlood(dt) {
    const blood = this.world.blood;
    const M = new THREE.Matrix4();
    const U = this.uniforms;
    const perAnchor = new Map();
    for (const b of this.phys.bleeds) {
      if (!b.anchor || !b.flow) continue;
      const ml = b.flow * dt * b.external;
      if (ml <= 0) continue;
      const a = b.anchor;
      this.boneMatrix(a.bone, M);
      const pos = a.pos.clone().applyMatrix4(M);
      const nrm = a.normal.clone().transformDirection(M);
      if (b.pulsatile && this.phys.alive && b.rate > 4) {
        // arterial: a jet that surges with each heartbeat
        blood.jet(pos.addScaledVector(nrm, 0.004), nrm, this.phys.map * (0.7 + 0.6 * (b.surge || 0)), ml * 0.55, dt);
        perAnchor.set(a, (perAnchor.get(a) || 0) + ml * 0.45);
      } else {
        perAnchor.set(a, (perAnchor.get(a) || 0) + ml);
      }
    }
    // soak into skin/clothes, the rest runs off and drips
    for (const [a, ml] of perAnchor) {
      a.vol += ml * 0.5;
      this.boneMatrix(a.bone, M);
      const pos = a.pos.clone().applyMatrix4(M);
      const len = Math.min(0.7, 0.03 + a.vol / 250);
      const down = new THREE.Vector3(0, -1, 0);
      blood.drip(pos.clone().addScaledVector(down, len * 0.6), ml * 0.5);
    }
    // stain uniforms: blood runs 'down' in world space, expressed in bind space
    let k = 0;
    for (const a of this.anchors) {
      if (k >= MAX_STAINS) break;
      if (a.vol <= 0.05) continue;
      this.boneMatrix(a.bone, M);
      const inv = M.clone().invert();
      const down = new THREE.Vector3(0, -1, 0).transformDirection(inv);
      U.uStain.value[k].set(a.pos.x, a.pos.y, a.pos.z, Math.min(2, a.vol / 120));
      U.uStainDir.value[k].set(down.x, down.y, down.z, Math.min(0.7, 0.03 + a.vol / 250));
      k++;
    }
    U.uStainCount.value = k;
  }

  get vitals() { return this.phys.vitals(); }
  get alive() { return this.phys.alive; }
  get position() { return this.root.position; }
  dispose() {
    this.world.scene.remove(this.root);
    this.world.npcs.splice(this.world.npcs.indexOf(this), 1);
  }
  get events() { return this.phys.events; }
}

// ------------------------------------------------------------------ helpers
const TORSO = new Set(['chest', 'abdomen', 'pelvis']);
// which body segment a bone belongs to (walks up to the nearest named one)
export function segmentOfBone(bone) {
  for (let b = bone; b; b = b.parent) {
    const n = b.name, s = /L$/.test(n) ? 'L' : /R$/.test(n) ? 'R' : '';
    if (n === 'head') return 'head';
    if (/^neck/.test(n)) return 'neck';
    if (/^upperarm/.test(n)) return 'uarm' + s;
    if (/^lowerarm/.test(n)) return 'farm' + s;
    if (/^(wrist|finger|metacarpal)/.test(n)) return 'hand' + s;
    if (/^upperleg/.test(n)) return 'thigh' + s;
    if (/^lowerleg/.test(n)) return 'shin' + s;
    if (/^(foot|toe)/.test(n)) return 'foot' + s;
    if (/^(spine01|spine02|breast|clavicle|shoulder01)/.test(n)) return 'chest';
    if (/^spine0[345]/.test(n)) return 'abdomen';
    if (/^(root|pelvis)/.test(n)) return 'pelvis';
  }
  return 'chest';
}

function rayCapsule(ray, a, b, r) {
  // sample-based closest approach (cheap and robust for coarse culling)
  const ab = new THREE.Vector3().subVectors(b, a);
  const L = ab.length();
  const n = Math.max(2, Math.ceil(L / (r * 0.5)));
  let best = null;
  const p = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    p.copy(a).addScaledVector(ab, i / n);
    const t = Math.max(0, ray.direction.dot(new THREE.Vector3().subVectors(p, ray.origin)));
    const d = ray.at(t, new THREE.Vector3()).distanceTo(p);
    if (d < r) { const te = t - Math.sqrt(r * r - d * d); if (best === null || te < best) best = te; }
  }
  return best;
}

function smooth01(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function distToSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(p, a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function vertebraLevel(name) {
  if (name === 'Atlas') return 'C1';
  if (name === 'Axis') return 'C2';
  const ord = { First: 1, Second: 2, Third: 3, Fourth: 4, Fifth: 5, Sixth: 6, Seventh: 7, Eighth: 8, Ninth: 9, Tenth: 10, Eleventh: 11, Twelfth: 12 };
  const m = /^(\w+) (cervical|thoracic|lumbar)/.exec(name);
  return m ? { cervical: 'C', thoracic: 'T', lumbar: 'L' }[m[2]] + ord[m[1]] : 'T6';
}

export { LAYERS };
