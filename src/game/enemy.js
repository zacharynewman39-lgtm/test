import * as THREE from 'three';
import { Actor } from './actor.js';
import { Body, standPose, pronePose, deadPose } from './body.js';

const CLOTHES = [0x1d1d22, 0x2a2420, 0x202a22, 0x2a1d1d, 0x18181a, 0x2b2b2b];
const SKINS = [0xc9a089, 0xb98a6c, 0x8a5f45, 0xd8b098, 0x6e4a36];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const CALM = new Set(['idle', 'patrol', 'ambush', 'playdead', 'investigate', 'search']);

function angleTo(from, to) {
  let d = to - from;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

export class Enemy extends Actor {
  constructor(game, spawn) {
    const armed = spawn.type !== 'playdead';
    const body = new Body({ shirt: pick(CLOTHES), pants: pick(CLOTHES), skin: pick(SKINS), mask: true, gun: armed });
    super(game, body, spawn.x, spawn.z, spawn.h);
    this.type = spawn.type;
    this.state = { playdead: 'playdead', ambush: 'ambush', patrol: 'patrol' }[spawn.type] || 'idle';
    this.hasGun = armed;
    if (!armed) this.giveKnife();
    this.aware = 0;
    this.sees = false;
    this.seesPlayer = false;
    this.lastKnown = null;
    this.losT = Math.random() * 0.2;
    this.path = null;
    this.pathI = 0;
    this.pathTarget = null;
    this.repathT = 0;
    this.speedCur = 0;
    this.phase = Math.random() * 6;
    this.reaction = 0.45 + Math.random() * 0.45;
    this.reactT = 0;
    this.burst = 0;
    this.fireT = 0;
    this.meleeT = 0;
    this.legDmg = { L: 0, R: 0 };
    this.limp = null;
    this.prone = false;
    this.flinch = 0;
    this.stagger = 0;
    this.home = this.pos.clone();
    this.patrol = spawn.patrol?.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.patrolI = 1;
    this.waitT = 0;
    this.executioner = spawn.executioner;
    this.executeT = 0;
    this.stateT = 0;
    this.aimPitch = 0;
    this.look = 0;
    this.seed = Math.random() * 100;
    this.stepPhase = 0;
    this.attackAnim = 0;
    this.groanT = 3 + Math.random() * 5;
    // start in pose
    for (let i = 0; i < 10; i++) this.pose(0.1, 0);
  }

  giveKnife() {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.22, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 1, roughness: 0.25 }));
    blade.position.set(0, -0.2, 0.02);
    this.body.j.handR.add(blade);
    this.knife = blade;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
    this.path = null;
  }

  // ------------------------------------------------------------- perception
  perceive(dt) {
    const g = this.game, P = g.player;
    const eye = this.body.headPos(_a);
    const target = P.eye;
    const d = eye.distanceTo(target);
    this.losT -= dt;
    if (this.losT <= 0) {
      this.losT = 0.1 + Math.random() * 0.08;
      let can = false;
      if (d < 32 && P.alive) {
        const tx = target.x - eye.x, tz = target.z - eye.z;
        const hl = Math.hypot(tx, tz) || 1;
        const cosA = (tx * Math.sin(this.heading) + tz * Math.cos(this.heading)) / hl;
        const fov = this.prone ? 0.0 : 0.3;
        if (cosA > fov || d < 2.2) can = g.lineOfSight(eye, target);
      }
      this.sees = can;
    }
    const engaged = !CALM.has(this.state);
    let range = engaged ? 30 : P.flashlight ? 22 : 10;
    if (P.firedT < 1.5) range = 30;
    this.seesPlayer = this.sees && d < range;
    this.playerDist = d;
    if (this.seesPlayer) {
      const rate = (1.0 + 8 / (d + 0.5)) * (P.crouched ? 0.55 : 1) * (P.flashlight ? 1.4 : 1);
      this.aware = Math.min(1, this.aware + rate * dt);
      if (this.aware >= 1 || engaged) this.lastKnown = P.pos.clone();
    } else if (!engaged) {
      this.aware = Math.max(0, this.aware - dt * 0.04);
    }
  }

  // A noise somewhere: a gunshot, a door being kicked.
  hear(pos, radius) {
    if (this.dead || this.state === 'playdead') return;
    const d = this.pos.distanceTo(pos);
    if (d > radius) return;
    if (!CALM.has(this.state)) { if (!this.seesPlayer) this.lastKnown = pos.clone(); return; }
    this.aware = Math.max(this.aware, 0.65);
    if (this.state === 'ambush' || this.executioner !== undefined) return; // hold position
    this.lastKnown = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2));
    this.setState('investigate');
  }

  engage() {
    const ex = this.executioner !== undefined ? this.game.hostages[this.executioner] : null;
    if (ex && ex.captive && this.hasGun && !this.prone) {
      this.setState('execute');
      this.game.hud.warn('They\'re going for the hostage!');
      return;
    }
    if (this.state === 'ambush') this.reactT = this.reaction - 0.15;
    this.setState(this.prone ? 'crawl' : 'combat');
    if (Math.random() < 0.6) this.game.audio.play('shout', { pos: this.pos, rate: 0.9 + Math.random() * 0.2 });
  }

  // --------------------------------------------------------------- movement
  turnTo(h, rate, dt) {
    this.heading += THREE.MathUtils.clamp(angleTo(this.heading, h), -rate * dt, rate * dt);
  }

  // Walk the nav path to `target`. Returns true once there.
  moveTo(target, speed, dt, repath = 1.0) {
    const g = this.game;
    this.repathT -= dt;
    if (!this.path || this.repathT <= 0 || !this.pathTarget || this.pathTarget.distanceTo(target) > 0.8) {
      this.path = g.level.findPath(this.pos, target);
      this.pathI = 0;
      this.pathTarget = target.clone();
      this.repathT = repath;
    }
    if (!this.path || this.pathI >= this.path.length) { this.speedCur = 0; return true; }
    const wp = this.path[this.pathI];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const last = this.pathI === this.path.length - 1;
    if (dist < (last ? 0.25 : 0.4)) { this.pathI++; return this.pathI >= this.path.length; }
    for (const door of g.level.doors) {
      if (!door.isOpen && Math.hypot(door.center.x - this.pos.x, door.center.z - this.pos.z) < 1.0) {
        door.open(this.pos);
        g.audio.play('door', { pos: door.center, volume: 0.6 });
      }
    }
    this.turnTo(Math.atan2(dx, dz), 7, dt);
    const sp = speed * (this.limp ? 0.45 : 1);
    this.speedCur = sp;
    this.pos.x += dx / dist * sp * dt;
    this.pos.z += dz / dist * sp * dt;
    return false;
  }

  // ------------------------------------------------------------------ think
  update(dt, t) {
    this.updateBody(dt, t);
    if (this.dead) { this.root.rotation.y = this.heading; return; }
    const g = this.game, P = g.player;
    this.stateT += dt;
    this.flinch = Math.max(0, this.flinch - dt * 4);
    this.stagger = Math.max(0, this.stagger - dt);
    this.fireT -= dt;
    this.meleeT -= dt;
    this.attackAnim = Math.max(0, this.attackAnim - dt * 3);
    this.speedCur = 0;
    this.perceive(dt);
    if (this.aware >= 1 && CALM.has(this.state) && this.state !== 'playdead') this.engage();

    const toP = Math.atan2(P.pos.x - this.pos.x, P.pos.z - this.pos.z);
    const flatD = Math.hypot(P.pos.x - this.pos.x, P.pos.z - this.pos.z);

    switch (this.state) {
      case 'idle':
        this.look = Math.sin(t * 0.35 + this.seed) * 0.6;
        if (this.pos.distanceTo(this.home) > 0.6) this.moveTo(this.home, 1.2, dt);
        break;
      case 'patrol': {
        const tgt = this.patrol[this.patrolI];
        if (this.waitT > 0) { this.waitT -= dt; this.look = Math.sin(t * 0.8 + this.seed) * 0.7; }
        else if (this.moveTo(tgt, 1.1, dt)) { this.patrolI = (this.patrolI + 1) % this.patrol.length; this.waitT = 2 + Math.random() * 2; this.path = null; }
        break;
      }
      case 'ambush':
        this.look = Math.sin(t * 0.25 + this.seed) * 0.3;
        break;
      case 'playdead':
        if (flatD < 2.4 || (this.sees && flatD < 3.5 && !P.lookingAt(this.pos, 0.85))) {
          this.setState('rising');
          g.audio.play('shout', { pos: this.pos, rate: 0.7 });
        }
        break;
      case 'rising':
        if (this.stateT > 0.8) { this.aware = 1; this.lastKnown = P.pos.clone(); this.setState('combat'); }
        this.turnTo(toP, 3, dt);
        break;
      case 'investigate':
        if (this.moveTo(this.lastKnown, 1.9, dt)) this.setState('search');
        break;
      case 'search':
        this.look = Math.sin(this.stateT * 1.3) * 0.9;
        this.heading += Math.sin(this.stateT * 0.7) * dt * 0.8;
        if (this.stateT > 6) { this.home = this.pos.clone(); this.setState('idle'); }
        break;
      case 'combat':
        this.combat(dt, toP, flatD);
        break;
      case 'execute':
        this.execute(dt);
        break;
      case 'flee': {
        if (!this.fleeTo) this.fleeTo = this.pickFleeSpot();
        if (this.moveTo(this.fleeTo, 3.0, dt)) this.setState('cower');
        break;
      }
      case 'cower':
        this.turnTo(toP, 4, dt);
        if (this.seesPlayer && flatD < 2.2 && this.stateT > 2 && Math.random() < dt) { this.giveKnifeIfNone(); this.setState('combat'); }
        break;
      case 'panic':
        if (!this.panicTo || this.stateT > 1.5) { this.panicTo = this.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)); this.stateT = 0.01; }
        this.moveTo(this.panicTo, 0.8, dt, 0.5);
        if (this.bleed < 6) this.setState(this.hasGun ? 'combat' : 'flee');
        break;
      case 'crawl':
        if (flatD > 0.9) this.moveTo(P.pos, 0.35, dt, 0.6);
        else {
          this.turnTo(toP, 3, dt);
          if (this.meleeT <= 0) { this.meleeT = 1.3; this.attackAnim = 1; g.damagePlayer(8, this.pos, 'grab'); }
        }
        break;
    }

    // separation from other suspects and the player
    for (const o of g.enemies) {
      if (o === this || o.dead) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.55 && d > 1e-4) { this.pos.x += dx / d * (0.55 - d) * 0.5; this.pos.z += dz / d * (0.55 - d) * 0.5; }
    }
    if (flatD < 0.6 && flatD > 1e-4 && !this.prone) {
      this.pos.x -= (P.pos.x - this.pos.x) / flatD * (0.6 - flatD);
      this.pos.z -= (P.pos.z - this.pos.z) / flatD * (0.6 - flatD);
    }
    g.level.collide(this.pos, 0.26);
    this.root.rotation.y = this.heading;
    this.pose(dt, t);
    this.sounds(dt);
  }

  combat(dt, toP, flatD) {
    const g = this.game, P = g.player;
    if (this.stagger > 0) return;
    if (this.hasGun) {
      if (this.seesPlayer) {
        this.path = null;
        this.turnTo(toP, 5, dt);
        const eye = this.body.headPos(_a);
        this.aimPitch = Math.atan2(P.eye.y - 0.15 - (eye.y - 0.1), Math.max(0.5, flatD));
        this.reactT += dt;
        if (Math.abs(angleTo(this.heading, toP)) < 0.25 && this.reactT > this.reaction && this.fireT <= 0) {
          if (this.burst <= 0) this.burst = 2 + Math.floor(Math.random() * 4);
          g.enemyShoot(this, P.chestPoint(), false);
          this.burst--;
          this.fireT = this.burst > 0 ? 0.1 + Math.random() * 0.05 : 0.45 + Math.random() * 0.8;
        }
        // occasionally step to the side
        if (flatD > 3 && Math.random() < dt * 0.15) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const h = this.heading + side * Math.PI / 2;
          this.strafeTo = this.pos.clone().add(new THREE.Vector3(Math.sin(h) * 1.2, 0, Math.cos(h) * 1.2));
        }
        if (this.strafeTo) {
          const dx = this.strafeTo.x - this.pos.x, dz = this.strafeTo.z - this.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.15) this.strafeTo = null;
          else { this.pos.x += dx / d * 1.3 * dt; this.pos.z += dz / d * 1.3 * dt; this.speedCur = 1.3; }
        }
      } else {
        this.reactT = Math.min(this.reactT, 0.2);
        this.strafeTo = null;
        if (!this.lastKnown || this.moveTo(this.lastKnown, 2.8, dt)) this.setState('search');
      }
    } else {
      // knife: run him down
      if (flatD > 1.0) this.moveTo(P.pos, 3.5, dt, 0.4);
      else {
        this.turnTo(toP, 8, dt);
        if (this.meleeT <= 0) {
          this.meleeT = 0.9;
          this.attackAnim = 1;
          g.damagePlayer(22, this.pos, 'knife');
        }
      }
    }
  }

  execute(dt) {
    const g = this.game;
    const h = g.hostages[this.executioner];
    if (!h || !h.captive) { this.setState('combat'); return; }
    const d = Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z);
    if (d > 1.7) { this.moveTo(h.pos, 2.6, dt); return; }
    this.turnTo(Math.atan2(h.pos.x - this.pos.x, h.pos.z - this.pos.z), 5, dt);
    this.aimPitch = -0.45;
    this.executeT += dt;
    if (this.executeT > 2.3) {
      g.enemyShoot(this, h.body.headPos(new THREE.Vector3()), h);
      this.setState('combat');
    }
  }

  pickFleeSpot() {
    const P = this.game.player;
    let best = null, bd = -1;
    for (let i = 0; i < 16; i++) {
      const rooms = Object.keys(this.game.level.cellsByRoom);
      const c = this.game.level.randomCellIn(rooms[Math.floor(Math.random() * rooms.length)]);
      const d = c.distanceTo(P.pos);
      if (d > bd) { bd = d; best = c; }
    }
    return best;
  }

  giveKnifeIfNone() { if (!this.hasGun && !this.knife) this.giveKnife(); }

  // -------------------------------------------------------------- reactions
  onWounded(res, hit, dmg) {
    const g = this.game;
    const info = res.info;
    this.flinch = 1;
    this.stagger = 0.22;
    this.reactT *= 0.3;
    this.aware = 1;
    this.lastKnown = g.player.pos.clone();
    if (this.state === 'playdead' || CALM.has(this.state)) {
      this.engage();
    }
    if (info.leg && res.side) {
      this.legDmg[res.side] += dmg;
      if (this.legDmg[res.side] > 22) this.limp = res.side;
    }
    if (res.organ === 'pelvis') { this.legDmg.L += dmg * 0.5; this.legDmg.R += dmg * 0.5; }
    if ((this.legDmg.L > 22 && this.legDmg.R > 22) || this.legDmg.L > 55 || this.legDmg.R > 55 || info.paralyze) this.goProne();
    if (info.disarm && res.side === 'R' && this.hasGun && Math.random() < info.disarm) this.dropGun(hit.dir);
    g.audio.play(this.hp < 40 ? 'scream' : 'pain', { pos: this.pos, rate: 0.85 + Math.random() * 0.3 });
    if (!this.prone && this.bleed >= 8) this.setState('panic');
    else if (!this.prone && this.hp < 35 && Math.random() < 0.35 && this.state !== 'execute') { this.dropGun(hit.dir); this.setState('flee'); }
  }

  onSevered(part) {
    if (/R$/.test(part) && /Arm|hand/.test(part)) this.dropGun(new THREE.Vector3(0, -1, 0));
    if (/thigh|shin/.test(part)) this.goProne();
    if (!this.dead && !this.prone && !this.hasGun) this.setState('panic');
  }

  goProne() {
    if (this.prone) return;
    this.prone = true;
    this.limp = null;
    this.dropGun(new THREE.Vector3(0, -1, 0));
    this.setState('crawl');
    this.game.audio.play('thud', { pos: this.pos });
  }

  dropGun(dir) {
    if (!this.hasGun || !this.body.gun) return;
    this.hasGun = false;
    const gun = this.body.gun;
    this.body.gun = null;
    this.game.scene.attach(gun);
    this.game.gore.addChunk(gun, dir.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.5, 0)),
      new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4), { bleed: 0, r: 0.05 });
    if (this.state === 'combat' && !this.prone) this.setState(Math.random() < 0.5 ? 'flee' : 'combat');
    if (this.state === 'combat') this.giveKnifeIfNone();
  }

  onDeath(res) {
    const g = this.game;
    this.dropGun(this.lastHit?.dir || new THREE.Vector3(0, -1, 0));
    g.stats.kills++;
    if (res?.organ === 'brain') g.stats.headshots++;
    g.audio.play(res?.organ === 'brain' ? 'thud' : 'death', { pos: this.pos, rate: 0.8 + Math.random() * 0.3 });
    g.onSuspectDown(this);
  }

  // ------------------------------------------------------------- animation
  pose(dt, t) {
    const b = this.body;
    this.phase += this.speedCur * dt * 4.0;
    if (this.state === 'playdead') { b.blendPose(deadPose(1, b.rand), dt, 20); return; }
    if (this.prone) { b.blendPose(pronePose({ phase: this.phase * 1.6, moving: this.speedCur > 0.05 ? 1 : 0, lift: 0.6 + this.attackAnim * 0.4 }), dt, 6); return; }
    const aiming = this.hasGun && (this.state === 'combat' || this.state === 'execute') && this.stagger <= 0;
    b.blendPose(standPose({
      phase: this.phase, speed: this.speedCur, aim: aiming, aimPitch: this.aimPitch,
      crouch: this.state === 'ambush' ? 1 : this.state === 'rising' ? Math.max(0, 1 - this.stateT * 1.5) : this.state === 'cower' ? 0.9 : 0,
      limp: this.limp, clutch: this.state === 'panic', flinch: this.flinch, look: this.look, t: t + this.seed,
      raise: this.state === 'cower' ? 1 : this.attackAnim,
    }), dt, this.state === 'rising' ? 4 : 12);
  }

  sounds(dt) {
    const g = this.game;
    if (this.speedCur > 0.5) {
      const prev = this.stepPhase;
      this.stepPhase = Math.floor(this.phase / Math.PI);
      if (this.stepPhase !== prev) g.audio.play('step', { pos: this.pos, volume: Math.min(1, this.speedCur / 3) * 0.8, rate: 0.9 + Math.random() * 0.2 });
    }
    this.groanT -= dt;
    if (this.groanT <= 0) {
      this.groanT = 4 + Math.random() * 6;
      if (this.hp < 70 || this.prone) g.audio.play('pain', { pos: this.pos, volume: 0.6, rate: 0.7 + Math.random() * 0.2 });
      else if (this.state === 'idle' && Math.random() < 0.3) g.audio.play('whisper', { pos: this.pos, volume: 0.5 });
    }
  }
}
