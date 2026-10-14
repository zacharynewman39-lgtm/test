import * as THREE from 'three';
import { deadPose } from './body.js';

const UP = new THREE.Vector3(0, 1, 0);
const _ray = new THREE.Raycaster();

// Blood model. An adult carries ~5 L. Organ bleed values in ORGANS are scaled
// by ML_PER_BLEED into ml/s. Lose ~1.7 L and you go down for good.
export const BLOOD_FULL = 5000;
const BLOOD_DOWN = 3300;
const ML_PER_BLEED = 25;
const ARTERIAL = new Set(['neck', 'femoral']);

// Shared by suspects and hostages: wounds, bleeding, dismemberment, death.
let nextId = 1;

export class Actor {
  constructor(game, body, x, z, heading) {
    this.game = game;
    this.id = nextId++;
    this.body = body;
    this.kit = body.kit || null; // anatomical NPC (npc-kit) when available
    this.root = body.root;
    this.root.position.set(x, 0, z);
    this.heading = heading;
    this.root.rotation.y = heading;
    game.scene.add(this.root);
    this.hp = 100; // tissue trauma
    this.blood = BLOOD_FULL;
    this.bleed = 0; // in ORGANS units; ml/s = bleed * ML_PER_BLEED
    this.alive = true;
    this.dead = false;
    this.deathT = 0;
    this.dripT = 0;
    this.soakT = 0;
    this.pool = null;
    this.fallDir = 1;
    this.twitch = 0;
    this.lastHit = null;
    this.wounds = [];
  }

  get pos() { return this.root.position; }
  // 0 = fine, 1 = about to pass out from blood loss
  get shock() { return THREE.MathUtils.clamp((BLOOD_FULL - this.blood) / (BLOOD_FULL - BLOOD_DOWN), 0, 1); }

  // hit: { mesh, point, normal, dir, damage, uv }
  takeHit(hit) {
    const g = this.game;
    const b = this.body;
    const res = b.resolveHit(hit.mesh, hit.point);
    const info = res.info;
    const dmg = hit.damage * info.mult;
    const head = res.part === 'head';
    this.lastHit = { ...res, dir: hit.dir.clone(), point: hit.point.clone() };

    // entry: small hole, soak the cloth/skin around it, back-spatter toward the shooter
    b.addWound(hit.mesh, hit.point, hit.normal, head ? 0.016 : 0.02);
    this.soak(hit.mesh, hit.uv, 0.16, 1, info.bleed);
    g.gore.spray(hit.point, hit.normal.clone().multiplyScalar(0.7).add(hit.dir.clone().multiplyScalar(-0.3)), 8, 1.6, 0.6);
    g.gore.mist(hit.point, head ? 0.35 : 0.2, 0x6a0606);

    // exit: find where the round left the body; that side gets the real mess
    const exit = this.findExit(hit.point, hit.dir);
    const power = head ? 1.8 : 1.1;
    if (exit) {
      b.addWound(exit.object, exit.point, exit.normal, head ? 0.04 : 0.032, true);
      this.soak(exit.object, exit.uv, 0.24, 1, info.bleed);
      g.gore.spray(exit.point, hit.dir, 24 + (info.fatal ? 50 : 0), 4.2, 0.4, head ? 1.4 : 1);
      g.gore.mist(exit.point.clone().addScaledVector(hit.dir, 0.15), head ? 0.7 : 0.4);
      g.gore.exitSplatter(exit.point, hit.dir, power);
      if (Math.random() < 0.5) g.gore.exitSplatter(exit.point, hit.dir.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, -0.15, (Math.random() - 0.5) * 0.3)).normalize(), power * 0.6);
    } else {
      g.gore.spray(hit.point, hit.dir, 16, 3.5, 0.4);
      g.gore.exitSplatter(hit.point, hit.dir, power * 0.8);
    }
    // arteries pump in pulses out of the entry wound
    if (ARTERIAL.has(res.organ) && hit.mesh.parent) this.arterialJet(hit.mesh, hit.point, hit.normal, res.organ === 'neck' ? 90 : 70);
    g.audio.play('flesh', { pos: hit.point, volume: 1 });

    const sever = b.damagePart(res.part, hit.damage);
    if (sever) this.dismember(res.part, hit.dir);

    this.blood -= dmg * 4; // immediate loss from the wound channel
    if (!this.dead) {
      this.hp -= dmg;
      this.bleed += info.bleed;
      if (info.fatal || this.hp <= 0 || this.blood <= BLOOD_DOWN) this.die(hit.dir, res);
      else this.onWounded(res, hit, dmg);
    } else {
      this.twitch = Math.min(1, this.twitch + 0.6);
    }
    return { ...res, exit };
  }

  // A round traced through the anatomical model. tr comes from kit.trace(),
  // weapon is a kit weapon spec ({ energy, entryR, cavity, push }).
  kitHit(tr, weapon, continued = false) {
    const g = this.game, kit = this.kit;
    const ph = kit.phys;
    const before = { armR: ph.limbs.armR, canStand: ph.canStand, alive: ph.alive };
    const res = kit.applyHit(tr, weapon, continued);
    if (ph.alive) kit.screamT = 1; // he screams
    if (res.brainHit || ph.cord) kit.seize = Math.max(kit.seize || 0, res.brainHit ? 1 : 0.6);
    const ext = g.hcgore.onHit(this, tr, weapon, res);
    const dir = tr.rayWorld.direction.clone();
    if (res.exitWorld) g.gore.exitSplatter(res.exitWorld, dir, ext.seg.seg === 'head' ? 2 : 1 + res.remaining / 3000);
    g.audio.play('flesh', { pos: tr.rayWorld.at(tr.distance, new THREE.Vector3()), volume: 1 });
    const point = tr.rb.at(tr.entry.distance, new THREE.Vector3()).applyMatrix4(tr.M);
    const deposited = weapon.energy - res.remaining;
    const dmg = deposited / 40;
    const brain = res.brainHit;
    const aiRes = {
      part: ext.seg.part, side: ext.seg.side,
      organ: brain ? 'brain' : ext.seg.seg,
      info: {
        leg: ['thigh', 'shin', 'foot', 'pelvis'].includes(ext.seg.seg),
        arm: ['uarm', 'farm', 'hand'].includes(ext.seg.seg),
        disarm: before.armR > 0.5 && ph.limbs.armR < 0.5 ? 1 : ext.seg.seg === 'hand' && ext.seg.side === 'R' ? 0.8 : 0,
        paralyze: !!ph.cord,
        bleed: (ph.bleedRate || 0) / 25,
        fatal: !ph.alive,
      },
      ext,
    };
    this.lastHit = { ...aiRes, dir, point };
    if (!this.dead) {
      if (!ph.alive || ph.brain <= 0) this.die(dir, aiRes);
      else this.onWounded(aiRes, { dir, point }, dmg);
    } else this.twitch = 1;
    return res;
  }

  findExit(point, dir) {
    const far = point.clone().addScaledVector(dir, 0.9);
    _ray.set(far, dir.clone().negate());
    _ray.far = 0.9 - 0.01;
    const hits = _ray.intersectObjects(this.body.hitMeshes, false);
    const h = hits[0];
    if (!h || h.distance > 0.88) return null;
    const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    if (normal.dot(dir) < 0) normal.negate();
    return { object: h.object, point: h.point, normal, uv: h.uv };
  }

  soak(mesh, uv, radius, strength, bleed) {
    const mask = mesh?.userData.bloodMask;
    if (!mask || !uv) return;
    mask.paint(uv, radius, strength);
    this.wounds.push({ mask, uv: uv.clone(), r: radius, rate: bleed });
  }

  arterialJet(mesh, point, normal, rate) {
    const joint = mesh.parent;
    const o = new THREE.Object3D();
    joint.add(o);
    joint.updateWorldMatrix(true, false);
    o.position.copy(joint.worldToLocal(point.clone()));
    o.lookAt(point.clone().add(normal));
    this.game.gore.emitter(o, rate, 7 + Math.random() * 4, new THREE.Vector3(0, 0.25, 1).normalize());
  }

  dismember(part, dir) {
    const g = this.game, b = this.body;
    if (part === 'head') {
      const pos = b.headPos(new THREE.Vector3());
      const stump = b.destroyHead(g.scene);
      if (!stump) return;
      g.gore.headExplosion(pos, dir);
      g.gore.emitter(stump, 60, 6);
      g.audio.play('gib', { pos, volume: 1.2 });
      g.stats.dismember++;
      if (!this.dead) this.die(dir, { part: 'head', organ: 'brain' });
      return;
    }
    const cut = b.sever(part, g.scene);
    if (!cut) return;
    const v = dir.clone().multiplyScalar(2.5 + Math.random() * 2).add(new THREE.Vector3(0, 1.5, 0));
    g.gore.addChunk(cut.piece, v, new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12), { r: 0.07, bleed: 2.5 });
    g.gore.emitter(cut.stump, 45, 8);
    const sp = cut.stump.getWorldPosition(new THREE.Vector3());
    g.gore.spray(sp, dir, 50, 3, 0.8, 1.2);
    g.gore.mist(sp, 0.6);
    g.audio.play('gib', { pos: sp });
    g.stats.dismember++;
    this.bleed += 12;
    this.onSevered?.(part);
  }

  die(dir, res) {
    if (this.dead) return;
    this.dead = true;
    this.alive = false;
    this.deathT = 0;
    // fall away from the shot: face-down if hit from behind
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.fallDir = fwd.dot(dir) > 0 ? 1 : -1;
    this.twitch = res?.organ === 'brain' ? 0.3 : 1;
    if (this.kit) this.kit.goLimp();
    this.onDeath?.(res);
  }

  // Bleeding, soaking, drips, pools, death pose. Call every frame.
  updateBody(dt, t) {
    const g = this.game;
    if (this.kit) {
      // the kit runs the physiology; mirror it into the numbers the AI reads
      const ph = this.kit.phys;
      this.blood = ph.blood;
      this.bleed = (ph.bleedRate || 0) / 25;
      this.hp = 100 * Math.min(ph.consciousness, 1 - ph.lossFraction / 0.45);
      if (this.dead) { this.deathT += dt; return; }
      // out cold counts as down: he crumples and the ragdoll takes over
      if (!ph.alive || ph.consciousness < 0.25) this.die(this.lastHit?.dir || new THREE.Vector3(0, 0, 1), this.lastHit);
      else if (!ph.canStand && !this.prone) this.cantStand?.();
      return;
    }
    if (this.bleed > 0) {
      this.blood -= this.bleed * ML_PER_BLEED * dt;
      if (!this.dead && this.blood <= BLOOD_DOWN) this.die(this.lastHit?.dir || new THREE.Vector3(0, 0, 1), this.lastHit);
      this.dripT -= dt * Math.min(this.bleed, 20);
      if (this.dripT <= 0 && !this.dead) {
        this.dripT = 1.0;
        const p = this.body.world('pelvis', new THREE.Vector3());
        p.x += (Math.random() - 0.5) * 0.2; p.z += (Math.random() - 0.5) * 0.2;
        g.gore.drip(p, 3);
      }
      // stains spread outward from each wound while it bleeds
      this.soakT -= dt;
      if (this.soakT <= 0) {
        this.soakT = 0.6;
        for (const w of this.wounds) {
          if (w.r > 0.6) continue;
          w.r += 0.02 + w.rate * 0.006;
          w.mask.paint(w.uv, w.r, 0.22);
        }
      }
    }
    if (this.dead) {
      this.deathT += dt;
      this.twitch = Math.max(0, this.twitch - dt * 0.25);
      const k = this.deathT < 0.25 ? 8 : 6;
      this.body.blendPose(deadPose(this.fallDir, this.body.rand, this.deathT > 0.8 ? this.twitch : 0, t), dt, k);
      if (!this.pool && this.deathT > 0.7) {
        const c = this.body.world('chest', new THREE.Vector3());
        this.pool = g.gore.pool(c, 1.5 + Math.min(this.bleed, 30) * 0.05, 0.3 + this.bleed * 0.02);
      }
      this.bleed = Math.max(0, this.bleed - dt * 0.6);
    }
  }
}

export { UP };
