import * as THREE from 'three';
import { Actor } from './actor.js';
import { Body, standPose, pronePose, deadPose } from './body.js';
import { KitBody } from './kitbody.js';

const CLOTHES = [0x1d1d22, 0x2a2420, 0x202a22, 0x2a1d1d, 0x18181a, 0x2b2b2b, 0x30281e];
const SKINS = [0xc9a089, 0xb98a6c, 0x8a5f45, 0xd8b098, 0x6e4a36];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const _a = new THREE.Vector3();

const CALM = new Set(['idle', 'patrol', 'ambush', 'playdead', 'investigate', 'search', 'defend']);
const MAG = 30;

function angleTo(from, to) {
  const d = to - from;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

export class Enemy extends Actor {
  constructor(game, spawn) {
    const armed = spawn.type !== 'playdead';
    const look = { shirt: pick(CLOTHES), pants: pick(CLOTHES), skin: pick(SKINS), mask: true, gun: armed, vest: armed && Math.random() < 0.6 };
    // the anatomical model goes in bare-faced in its own clothes: you see his face
    const body = spawn.kit ? new KitBody(spawn.kit, { gun: armed }) : new Body(look);
    super(game, body, spawn.x, spawn.z, spawn.h);
    this.type = spawn.type;
    this.state = { playdead: 'playdead', ambush: 'ambush', patrol: 'patrol' }[spawn.type] || 'idle';
    this.hasGun = armed;
    if (!armed) this.giveKnife();
    // personality: nobody fights the same way
    this.aggression = Math.random();
    this.skill = rand(0.75, 1.25);
    this.reaction = rand(0.35, 0.7) / this.skill;
    this.prefRange = rand(4, 10);
    this.wanders = spawn.type === 'guard' && Math.random() < 0.6;
    this.executioner = spawn.executioner;
    this.special = spawn.type === 'ambush' || spawn.type === 'playdead' || spawn.executioner !== undefined;
    this.role = this.special ? spawn.type : 'holder';

    this.aware = 0;
    this.sees = false;
    this.seesPlayer = false;
    this.lastKnown = null;
    this.losT = Math.random() * 0.2;
    this.path = null; this.pathI = 0; this.pathTarget = null; this.repathT = 0;
    this.speedCur = 0;
    this.phase = Math.random() * 6;
    this.reactT = 0; this.burst = 0; this.fireT = 0; this.meleeT = 0;
    this.ammo = MAG; this.reloadT = 0;
    this.suppression = 0;
    this.tactic = null; this.tacticT = 0; this.peeks = 0;
    this.coverPos = null; this.peekPos = null; this.coverHalf = false;
    this.legDmg = { L: 0, R: 0 };
    this.limp = null; this.prone = false;
    this.flinch = 0; this.stagger = 0;
    this.home = this.pos.clone();
    this.homeRoom = game.level.roomAt(this.pos.x, this.pos.z);
    this.patrol = spawn.patrol?.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.patrolI = 1;
    this.waitT = rand(2, 8);
    this.executeT = 0;
    this.stateT = 0;
    this.aimPitch = 0;
    this.look = 0;
    this.seed = Math.random() * 100;
    this.stepPhase = 0;
    this.attackAnim = 0;
    this.groanT = rand(3, 8);
    this.crouchAmt = 0;
    for (let i = 0; i < 10; i++) this.pose(0.1, 0);
  }

  get engaged() { return !this.dead && !CALM.has(this.state); }
  get squad() { return this.game.squad; }

  giveKnife() {
    if (this.knife) return;
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
    if (s === 'combat') this.tactic = null;
  }
  setTactic(t, time = 0) { this.tactic = t; this.tacticT = time; this.path = null; }

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
        const fov = this.prone ? 0.0 : this.engaged ? -0.1 : 0.3;
        if (cosA > fov || d < 2.2) can = g.lineOfSight(eye, target);
      }
      this.sees = can;
    }
    let range = this.engaged ? 30 : P.flashlight ? 22 : 10;
    if (P.firedT < 1.5) range = 30;
    this.seesPlayer = this.sees && d < range;
    this.playerDist = d;
    if (this.seesPlayer) {
      const rate = (1.0 + 8 / (d + 0.5)) * (P.crouched ? 0.55 : 1) * (P.flashlight ? 1.4 : 1);
      this.aware = Math.min(1, this.aware + rate * dt);
      if (this.aware >= 1 || this.engaged) { this.lastKnown = P.pos.clone(); if (this.engaged) this.squad.report(); }
    } else if (!this.engaged) {
      this.aware = Math.max(0, this.aware - dt * 0.04);
    }
    if (this.engaged && !this.seesPlayer && this.squad.lastKnown) this.lastKnown = this.squad.lastKnown.clone();
  }

  // The squad decided this one should go look.
  investigate(pos) {
    if (this.special || !CALM.has(this.state) || this.state === 'playdead') return;
    this.aware = Math.max(this.aware, 0.65);
    this.lastKnown = pos.clone().add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)));
    this.setState('investigate');
  }

  // Or dig in where he is and watch the door.
  defend(pos) {
    if (this.special || !CALM.has(this.state) || this.state === 'investigate' || this.state === 'playdead') return;
    this.aware = Math.max(this.aware, 0.6);
    this.threat = pos.clone();
    const L = this.game.level;
    let best = null, bd = -1;
    for (let i = 0; i < 8; i++) {
      const c = L.randomCellIn(this.homeRoom);
      const d = c.distanceTo(pos);
      if (d > bd) { bd = d; best = c; }
    }
    this.holdPos = best;
    this.setState('defend');
  }

  // gunfire etc. near a suspect who's already fighting
  hear(pos) {
    if (this.dead || this.state === 'playdead') return;
    if (this.engaged && !this.seesPlayer && this.squad.sinceSeen() > 2) this.lastKnown = pos.clone();
    if (this.state === 'ambush' || this.executioner !== undefined) this.aware = Math.max(this.aware, 0.7);
  }

  // A bullet went past close enough to make him flinch.
  suppress(amount) {
    if (this.dead) return;
    this.suppression = Math.min(1, this.suppression + amount);
    if (CALM.has(this.state) && this.state !== 'playdead') { this.aware = 1; this.lastKnown = this.game.player.pos.clone(); this.engage(); }
    if (this.tactic === 'peek' && this.suppression > 0.45) this.setTactic('return');
  }

  engage() {
    const ex = this.executioner !== undefined ? this.game.hostages[this.executioner] : null;
    this.squad.report();
    if (ex && ex.captive && this.hasGun && !this.prone) {
      this.setState('execute');
      this.game.hud.warn('They\'re going for the hostage!');
      return;
    }
    if (this.state === 'ambush') this.reactT = this.reaction - 0.15;
    this.setState(this.prone ? 'crawl' : 'combat');
    this.squad.callout(this);
  }

  // --------------------------------------------------------------- movement
  turnTo(h, rate, dt) {
    this.heading += THREE.MathUtils.clamp(angleTo(this.heading, h), -rate * dt, rate * dt);
  }

  moveTo(target, speed, dt, repath = 1.0, cost = null, face = true) {
    const g = this.game;
    this.repathT -= dt;
    if (!this.path || this.repathT <= 0 || !this.pathTarget || this.pathTarget.distanceTo(target) > 0.8) {
      this.path = g.level.findPath(this.pos, target, cost, true);
      this.pathI = 0;
      this.pathTarget = target.clone();
      this.repathT = repath;
    }
    if (!this.path || this.pathI >= this.path.length) { this.speedCur = 0; return true; }
    const wp = this.path[this.pathI];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const last = this.pathI === this.path.length - 1;
    if (dist < (last ? 0.2 : 0.4)) { this.pathI++; return this.pathI >= this.path.length; }
    for (const door of g.level.doors) {
      if (!door.isOpen && Math.hypot(door.center.x - this.pos.x, door.center.z - this.pos.z) < 1.0) {
        door.open(this.pos);
        g.audio.play('door', { pos: door.center, volume: 0.6 });
      }
    }
    if (face) this.turnTo(Math.atan2(dx, dz), 7, dt);
    const sp = speed * (this.limp ? 0.45 : 1) * (1 - this.shock * 0.4);
    this.speedCur = sp;
    this.pos.x += dx / dist * sp * dt;
    this.pos.z += dz / dist * sp * dt;
    return false;
  }

  faceTarget(dt, rate = 6) {
    const t = this.seesPlayer ? this.game.player.pos : this.lastKnown;
    if (!t) return;
    this.turnTo(Math.atan2(t.x - this.pos.x, t.z - this.pos.z), rate, dt);
    const eyeY = this.body.headPos(_a).y;
    const dist = Math.max(0.5, Math.hypot(t.x - this.pos.x, t.z - this.pos.z));
    this.aimPitch = Math.atan2((this.seesPlayer ? this.game.player.eye.y - 0.2 : 1.2) - (eyeY - 0.1), dist);
  }

  // ------------------------------------------------------------------ think
  update(dt, t) {
    this.updateBody(dt, t);
    if (this.dead) { this.root.rotation.y = this.heading; return; }
    const g = this.game, P = g.player;
    this.stateT += dt;
    this.tacticT -= dt;
    this.flinch = Math.max(0, this.flinch - dt * 4);
    this.stagger = Math.max(0, this.stagger - dt);
    this.suppression = Math.max(0, this.suppression - dt * 0.35);
    this.fireT -= dt;
    this.meleeT -= dt;
    this.attackAnim = Math.max(0, this.attackAnim - dt * 3);
    this.speedCur = 0;
    this.crouch = 0;
    this.aiming = false;
    // flashbanged: blind and deaf, hands over the face, staggering
    if (this.stunT > 0 && this.state !== 'playdead') {
      this.stunT -= dt;
      this.flinch = Math.max(this.flinch, 0.3 * Math.abs(Math.sin(t * 9)));
      this.crouch = this.prone ? 0 : 0.35;
      this.attackAnim = 1;
      this.heading += Math.sin(t * 2.3 + this.seed) * dt * 1.5;
      if (this.stunT <= 0) { this.aware = 1; this.lastKnown = g.player.pos.clone(); if (CALM.has(this.state)) this.engage(); }
      g.level.collide(this.pos, 0.26);
      this.root.rotation.y = this.heading;
      this.pose(dt, t);
      return;
    }
    this.perceive(dt);
    if (this.aware >= 1 && CALM.has(this.state) && this.state !== 'playdead') this.engage();

    const toP = Math.atan2(P.pos.x - this.pos.x, P.pos.z - this.pos.z);
    const flatD = Math.hypot(P.pos.x - this.pos.x, P.pos.z - this.pos.z);

    switch (this.state) {
      case 'idle':
        this.look = Math.sin(t * 0.35 + this.seed) * 0.6;
        if (this.wanders) {
          this.waitT -= dt;
          if (this.waitT <= 0) { this.home = this.game.level.randomCellIn(this.homeRoom); this.waitT = rand(6, 14); }
        }
        if (this.pos.distanceTo(this.home) > 0.5) this.moveTo(this.home, 1.0, dt);
        break;
      case 'patrol': {
        const tgt = this.patrol[this.patrolI];
        if (this.waitT > 0 && this.stateT > 0.1) { this.waitT -= dt; this.look = Math.sin(t * 0.8 + this.seed) * 0.7; }
        else if (this.moveTo(tgt, 1.1, dt)) { this.patrolI = (this.patrolI + 1) % this.patrol.length; this.waitT = rand(2, 4); this.path = null; }
        break;
      }
      case 'ambush':
        this.crouch = 1;
        this.aiming = this.aware > 0.5 && this.hasGun;
        this.look = Math.sin(t * 0.25 + this.seed) * 0.3;
        break;
      case 'playdead':
        if (flatD < 2.4 || (this.sees && flatD < 3.5 && !P.lookingAt(this.pos, 0.85))) {
          this.setState('rising');
          g.audio.play('shout', { pos: this.pos, rate: 0.7 });
        }
        break;
      case 'rising':
        this.crouch = Math.max(0, 1 - this.stateT * 1.5);
        if (this.stateT > 0.8) { this.aware = 1; this.lastKnown = P.pos.clone(); this.setState('combat'); }
        this.turnTo(toP, 3, dt);
        break;
      case 'investigate':
        // weapon up, slow and careful
        this.aiming = this.hasGun;
        this.aimPitch = 0;
        if (this.moveTo(this.lastKnown, 1.25, dt)) this.setState('search');
        break;
      case 'search':
        this.aiming = this.hasGun;
        this.look = Math.sin(this.stateT * 1.3) * 0.9;
        this.heading += Math.sin(this.stateT * 0.7) * dt * 0.8;
        if (this.stateT > 6) { this.home = this.pos.clone(); this.homeRoom = g.level.roomAt(this.pos.x, this.pos.z); this.defend(this.lastKnown || this.pos); }
        break;
      case 'defend':
        // dig in away from the noise and hold the angle on it
        if (this.holdPos && this.pos.distanceTo(this.holdPos) > 0.3) this.moveTo(this.holdPos, 2.4, dt);
        else {
          this.crouch = 0.8;
          this.aiming = this.hasGun;
          this.turnTo(Math.atan2(this.threat.x - this.pos.x, this.threat.z - this.pos.z), 3, dt);
          this.look = Math.sin(t * 0.6 + this.seed) * 0.25;
        }
        break;
      case 'combat':
        this.combat(dt, toP, flatD);
        break;
      case 'execute':
        this.execute(dt);
        break;
      case 'flee':
        if (!this.fleeTo) this.fleeTo = this.pickFleeSpot();
        if (this.moveTo(this.fleeTo, 3.0, dt)) this.setState('cower');
        break;
      case 'cower':
        this.crouch = 0.9;
        this.turnTo(toP, 4, dt);
        if (this.seesPlayer && flatD < 2.2 && this.stateT > 2 && Math.random() < dt) { this.giveKnife(); this.setState('combat'); }
        break;
      case 'panic':
        if (!this.panicTo || this.stateT > 1.5) { this.panicTo = this.pos.clone().add(new THREE.Vector3(rand(-1.5, 1.5), 0, rand(-1.5, 1.5))); this.stateT = 0.01; }
        this.moveTo(this.panicTo, 0.8, dt, 0.5);
        if (this.bleed < 6) this.setState(this.hasGun ? 'combat' : 'flee');
        break;
      case 'crawl':
        // drags himself along, smearing a trail
        this.smearT = (this.smearT || 0) - dt;
        if (this.speedCur > 0.05 && this.smearT <= 0 && this.bleed > 0.2) { this.smearT = 0.22; g.gore.smear(this.pos, this.heading); }
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

  // ---------------------------------------------------------------- tactics
  combat(dt, toP, flatD) {
    const g = this.game, sq = this.squad;
    if (this.stagger > 0) return;
    if (!this.hasGun) { this.melee(dt, toP, flatD); return; }

    // reloading: get low and do it
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      this.crouch = 1;
      if (this.coverPos && this.pos.distanceTo(this.coverPos) > 0.3) this.moveTo(this.coverPos, 3, dt);
      if (this.reloadT <= 0) this.ammo = MAG;
      return;
    }

    if (!this.tactic) this.chooseTactic();
    const lost = sq.sinceSeen();

    switch (this.tactic) {
      case 'move': // run to cover, shooting on the move if he's bold
        if (this.moveTo(this.coverPos, 3.1, dt, 1, null, !(this.seesPlayer && this.aggression > 0.6))) {
          this.setTactic('hide', rand(0.5, 1.2));
        }
        if (this.seesPlayer && this.aggression > 0.6) { this.faceTarget(dt); this.aiming = true; this.shoot(dt, 0.6); }
        break;
      case 'hide':
        this.crouch = 1;
        this.aiming = true;
        this.faceTarget(dt, 3);
        if (this.coverCompromised()) { this.retake(); break; }
        this.tacticT += dt * this.suppression * 0.7; // pinned down: wait longer
        if (this.suppression > 0.75 && Math.random() < dt * 0.6 && lost < 4) this.blindFire();
        if (this.tacticT <= 0) {
          if (this.role === 'pusher' && this.peeks >= 2) { this.advance(); break; }
          if ((this.role === 'flanker' || this.role === 'pusher') && lost > 6) { this.setTactic('search'); break; }
          this.setTactic('peek', rand(1.2, 2.4));
          this.peeks++;
        }
        break;
      case 'peek':
        this.aiming = true;
        if (!this.coverHalf && this.peekPos && this.pos.distanceTo(this.peekPos) > 0.25) this.moveTo(this.peekPos, 2.2, dt, 1, null, false);
        this.faceTarget(dt);
        this.shoot(dt, 1);
        if (this.tacticT <= 0) this.setTactic('return');
        break;
      case 'return':
        this.aiming = true;
        this.faceTarget(dt, 4);
        if (!this.coverPos || this.moveTo(this.coverPos, 2.4, dt, 1, null, false)) this.setTactic('hide', rand(1.0, 2.6));
        break;
      case 'flank': {
        // circle round out of sight, then come in from the side
        if (!this.flankTo) this.flankTo = sq.findFlankSpot(this) || sq.lastKnown;
        const arrived = this.moveTo(this.flankTo, 3.0, dt, 1.5, sq.stealthCost());
        if ((this.seesPlayer && flatD < 9) || arrived) { this.setTactic('assault', rand(4, 7)); sq.callout(this); }
        break;
      }
      case 'assault':
        this.aiming = true;
        this.faceTarget(dt);
        this.shoot(dt, 1.1);
        this.strafe(dt, flatD);
        if (!this.seesPlayer && lost > 1.5) this.setTactic('search');
        else if (this.tacticT <= 0 && this.role !== 'pusher') this.retake();
        break;
      case 'search':
        this.aiming = true;
        if (this.seesPlayer) { this.retake(); break; }
        if (!this.lastKnown || this.moveTo(this.lastKnown, 1.6, dt)) {
          this.look = Math.sin(this.stateT * 1.5) * 0.9;
          if (this.tacticT < -5) { this.home = this.pos.clone(); this.homeRoom = g.level.roomAt(this.pos.x, this.pos.z); this.setState('defend'); this.threat = this.lastKnown || this.pos.clone(); this.holdPos = this.pos.clone(); }
        }
        break;
    }
  }

  chooseTactic() {
    const sq = this.squad;
    this.peeks = 0;
    if (this.role === 'flanker') { this.flankTo = null; this.setTactic('flank'); return; }
    if (this.role === 'pusher') { this.advance(); return; }
    this.retake();
  }

  retake(mode = 'hold') {
    const c = this.squad.findCover(this, this.hp < 50 ? 'retreat' : mode);
    if (c) {
      this.coverPos = c.pos; this.peekPos = c.peek; this.coverHalf = c.half;
      this.setTactic('move');
    } else {
      this.coverPos = null;
      this.setTactic('assault', rand(2, 4));
    }
  }

  advance() {
    const c = this.squad.findCover(this, 'advance', 7);
    this.peeks = 0;
    if (c) { this.coverPos = c.pos; this.peekPos = c.peek; this.coverHalf = c.half; this.setTactic('move'); this.squad.callout(this); }
    else this.setTactic('assault', rand(3, 5));
  }

  coverCompromised() {
    if (!this.coverPos) return true;
    const sq = this.squad;
    return !!sq.visLow[sq.idx(this.coverPos.x, this.coverPos.z)];
  }

  strafe(dt, flatD) {
    if (flatD > 2.5 && Math.random() < dt * 0.4) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const h = this.heading + side * Math.PI / 2;
      this.strafeTo = this.pos.clone().add(new THREE.Vector3(Math.sin(h) * 1.3, 0, Math.cos(h) * 1.3));
    }
    if (this.strafeTo) {
      const dx = this.strafeTo.x - this.pos.x, dz = this.strafeTo.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) this.strafeTo = null;
      else { this.pos.x += dx / d * 1.5 * dt; this.pos.z += dz / d * 1.5 * dt; this.speedCur = 1.5; }
    }
  }

  // Trigger discipline: react, then short bursts, then reload when dry.
  shoot(dt, eagerness) {
    const g = this.game, P = g.player;
    if (!this.seesPlayer) { this.reactT = Math.min(this.reactT, 0.15); return; }
    this.reactT += dt * eagerness;
    const toP = Math.atan2(P.pos.x - this.pos.x, P.pos.z - this.pos.z);
    if (Math.abs(angleTo(this.heading, toP)) > 0.3 || this.reactT < this.reaction || this.fireT > 0) return;
    if (this.burst <= 0) this.burst = 2 + Math.floor(Math.random() * 3 * this.aggression + 1);
    g.enemyShoot(this, P.chestPoint(), null);
    this.ammo--;
    this.burst--;
    this.fireT = this.burst > 0 ? rand(0.09, 0.14) : rand(0.35, 0.9) / (0.6 + this.aggression);
    if (this.ammo <= 0) this.startReload();
  }

  blindFire() {
    if (!this.lastKnown || this.ammo <= 0) return;
    for (let i = 0; i < 3; i++) setTimeout(() => {
      if (this.dead || !this.hasGun) return;
      this.game.enemyShoot(this, this.lastKnown.clone().add(new THREE.Vector3(rand(-1, 1), 1.2, rand(-1, 1))), null, { blind: true });
    }, i * 110);
    this.ammo = Math.max(0, this.ammo - 3);
    if (this.ammo <= 0) this.startReload();
  }

  startReload() {
    this.reloadT = rand(2.2, 3.0);
    this.burst = 0;
    this.squad.callout(this);
  }

  melee(dt, toP, flatD) {
    const g = this.game, P = g.player;
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

  execute(dt) {
    const g = this.game;
    const h = g.hostages[this.executioner];
    if (!h || !h.captive) { this.special = false; this.role = 'holder'; this.setState('combat'); return; }
    const d = Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z);
    this.aiming = true;
    if (d > 1.7) { this.moveTo(h.pos, 2.6, dt); return; }
    this.turnTo(Math.atan2(h.pos.x - this.pos.x, h.pos.z - this.pos.z), 5, dt);
    this.aimPitch = -0.45;
    this.executeT += dt;
    if (this.executeT > 2.3) {
      g.enemyShoot(this, h.body.headPos(new THREE.Vector3()), h);
      this.special = false; this.role = 'holder';
      this.setState('combat');
    }
  }

  pickFleeSpot() {
    const P = this.game.player;
    let best = null, bd = -1;
    const rooms = Object.keys(this.game.level.cellsByRoom).filter((r) => r !== 'o');
    for (let i = 0; i < 16; i++) {
      const c = this.game.level.randomCellIn(rooms[Math.floor(Math.random() * rooms.length)]);
      const d = c.distanceTo(P.pos);
      if (d > bd) { bd = d; best = c; }
    }
    return best;
  }

  // -------------------------------------------------------------- reactions
  onWounded(res, hit, dmg) {
    const g = this.game;
    const info = res.info;
    this.flinch = 1;
    this.stagger = 0.25 + Math.min(0.4, dmg / 100);
    this.reactT *= 0.3;
    this.aware = 1;
    this.suppression = Math.min(1, this.suppression + 0.5);
    this.lastKnown = g.player.pos.clone();
    if (CALM.has(this.state)) this.engage();
    if (info.leg && res.side) {
      this.legDmg[res.side] += dmg;
      if (this.legDmg[res.side] > 22) this.limp = res.side;
    }
    if (!this.kit) { // with the anatomical model the physiology decides when he can't stand (cantStand)
      if (res.organ === 'pelvis') { this.legDmg.L += dmg * 0.5; this.legDmg.R += dmg * 0.5; }
      if ((this.legDmg.L > 22 && this.legDmg.R > 22) || this.legDmg.L > 55 || this.legDmg.R > 55 || info.paralyze) this.goProne();
    }
    if (info.disarm && res.side === 'R' && this.hasGun && Math.random() < info.disarm) this.dropGun(hit.dir);
    g.audio.play(this.hp < 40 ? 'scream' : 'pain', { pos: this.pos, rate: 0.85 + Math.random() * 0.3 });
    if (this.prone) return;
    if (this.bleed >= 8) this.setState('panic');
    else if (this.hp < 35 && this.aggression < 0.5 && Math.random() < 0.4 && this.state !== 'execute') { this.dropGun(hit.dir); this.setState('flee'); }
    else if (this.state === 'combat' && this.tactic !== 'move') this.retake(this.hp < 60 ? 'retreat' : 'hold');
  }

  cantStand() { this.goProne(); }

  onSevered(part) {
    if (/R$/.test(part) && /arm|hand/i.test(part)) this.dropGun(new THREE.Vector3(0, -1, 0));
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
    if (this.state === 'combat' && !this.prone) {
      if (Math.random() < 0.5) this.setState('flee');
      else this.giveKnife();
    }
  }

  onDeath(res) {
    const g = this.game;
    this.dropGun(this.lastHit?.dir || new THREE.Vector3(0, -1, 0));
    this.coverPos = null;
    g.stats.kills++;
    if (res?.organ === 'brain') g.stats.headshots++;
    g.audio.play(res?.organ === 'brain' ? 'thud' : 'death', { pos: this.pos, rate: 0.8 + Math.random() * 0.3 });
    g.onSuspectDown(this);
  }

  // ------------------------------------------------------------- animation
  pose(dt, t) {
    const b = this.body;
    this.phase += this.speedCur * dt * 4.0;
    this.crouchAmt += ((this.crouch || 0) - this.crouchAmt) * (1 - Math.exp(-8 * dt));
    if (this.state === 'playdead') { b.blendPose(deadPose(1, b.rand), dt, 20); return; }
    if (this.prone) { b.blendPose(pronePose({ phase: this.phase * 1.6, moving: this.speedCur > 0.05 ? 1 : 0, lift: 0.6 + this.attackAnim * 0.4 }), dt, 6); return; }
    const aim = this.hasGun && this.aiming && this.stagger <= 0 && this.reloadT <= 0;
    b.blendPose(standPose({
      phase: this.phase, speed: this.speedCur, aim, aimPitch: this.aimPitch,
      crouch: this.crouchAmt, limp: this.limp, clutch: this.state === 'panic', flinch: this.flinch,
      look: this.look, t: t + this.seed,
      raise: this.state === 'cower' ? 1 : this.attackAnim,
    }), dt, this.state === 'rising' ? 4 : 12);
  }

  sounds(dt) {
    const g = this.game;
    if (this.speedCur > 0.5) {
      const prev = this.stepPhase;
      this.stepPhase = Math.floor(this.phase / Math.PI);
      if (this.stepPhase !== prev) {
        g.audio.play('step', { pos: this.pos, volume: Math.min(1, this.speedCur / 3) * 0.8, rate: 0.9 + Math.random() * 0.2 });
        if (g.gore.wetAt(this.pos) > 0.2) this.bloodySteps = 6;
        if (this.bloodySteps > 0) { this.bloodySteps--; g.gore.footprint(this.pos, this.heading, this.stepPhase % 2 ? 1 : -1, this.bloodySteps / 6); }
      }
    }
    this.groanT -= dt;
    if (this.groanT <= 0) {
      this.groanT = rand(4, 10);
      if (this.hp < 70 || this.prone) g.audio.play('pain', { pos: this.pos, volume: 0.6, rate: 0.7 + Math.random() * 0.2 });
      else if ((this.state === 'idle' || this.state === 'defend') && Math.random() < 0.35) g.audio.play('whisper', { pos: this.pos, volume: 0.5 });
    }
  }
}
