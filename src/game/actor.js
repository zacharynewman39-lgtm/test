import * as THREE from 'three';
import { deadPose } from './body.js';

const UP = new THREE.Vector3(0, 1, 0);

// Shared by suspects and hostages: health, bleeding, wounds, dismemberment, death.
export class Actor {
  constructor(game, body, x, z, heading) {
    this.game = game;
    this.body = body;
    this.root = body.root;
    this.root.position.set(x, 0, z);
    this.heading = heading;
    this.root.rotation.y = heading;
    game.scene.add(this.root);
    this.hp = 100;
    this.bleed = 0;
    this.bloodLost = 0;
    this.alive = true;
    this.dead = false;
    this.deathT = 0;
    this.dripT = 0;
    this.pool = null;
    this.fallDir = 1;
    this.twitch = 0;
    this.lastHit = null;
  }

  get pos() { return this.root.position; }

  // hit: { mesh, point, normal, dir, damage, weapon, pellet }
  takeHit(hit) {
    const g = this.game;
    const b = this.body;
    const res = b.resolveHit(hit.mesh, hit.point);
    const info = res.info;
    const dmg = hit.damage * info.mult;
    this.lastHit = { ...res, dir: hit.dir.clone(), point: hit.point.clone() };

    // visuals: entry wound, spray back toward the shooter, exit spray + wall splatter
    b.addWound(hit.mesh, hit.point, hit.normal, res.part === 'head' ? 0.018 : 0.024);
    g.gore.spray(hit.point, hit.normal.clone().multiplyScalar(0.6).add(hit.dir.clone().multiplyScalar(-0.3)), 6, 1.5, 0.6);
    g.gore.spray(hit.point, hit.dir, 14 + (info.fatal ? 30 : 0), 3.5, 0.35);
    g.gore.mist(hit.point.clone().addScaledVector(hit.dir, 0.2), res.part === 'head' ? 0.5 : 0.28);
    g.gore.exitSplatter(hit.point, hit.dir, res.part === 'head' ? 1.6 : 1);
    g.audio.play('flesh', { pos: hit.point, volume: 0.9 });

    const sever = b.damagePart(res.part, hit.damage);
    if (sever) this.dismember(res.part, hit.dir);

    if (!this.dead) {
      this.hp -= dmg;
      this.bleed += info.bleed;
      if (info.fatal || this.hp <= 0) this.die(hit.dir, res);
      else this.onWounded(res, hit, dmg);
    } else {
      // corpse: just gore. Twitch a bit.
      this.twitch = Math.min(1, this.twitch + 0.6);
    }
    return res;
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
    this.onDeath?.(res);
  }

  // Bleeding, drips, pools, death pose. Call every frame.
  updateBody(dt, t) {
    const g = this.game;
    if (this.bleed > 0) {
      const lose = this.bleed * dt;
      this.bloodLost += lose;
      if (!this.dead) {
        this.hp -= lose;
        if (this.hp <= 0) this.die(this.lastHit?.dir || new THREE.Vector3(0, 0, 1), this.lastHit);
      }
      this.dripT -= dt * Math.min(this.bleed, 20);
      if (this.dripT <= 0 && !this.dead) {
        this.dripT = 1.2;
        const p = this.body.world('pelvis', new THREE.Vector3());
        p.x += (Math.random() - 0.5) * 0.2; p.z += (Math.random() - 0.5) * 0.2;
        g.gore.drip(p, 2);
      }
    }
    if (this.dead) {
      this.deathT += dt;
      this.twitch = Math.max(0, this.twitch - dt * 0.25);
      // knees go first, then the fall
      const k = this.deathT < 0.25 ? 8 : 6;
      this.body.blendPose(deadPose(this.fallDir, this.body.rand, this.deathT > 0.8 ? this.twitch : 0, t), dt, k);
      if (!this.pool && this.deathT > 0.7) {
        const c = this.body.world('chest', new THREE.Vector3());
        this.pool = g.gore.pool(c, 0.8 + Math.min(this.bleed, 30) * 0.035, 0.12 + this.bleed * 0.01);
      }
      this.bleed = Math.max(0, this.bleed - dt * 0.6);
    }
  }
}

export { UP };
