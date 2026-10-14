import * as THREE from 'three';
import { Actor } from './actor.js';
import { Body, kneelPose, standPose } from './body.js';

export class Hostage extends Actor {
  constructor(game, spawn) {
    const body = new Body({ shirt: 0x6d6a5a, pants: 0x3a4250, skin: 0xd0a68a, bag: true });
    super(game, body, spawn.x, spawn.z, spawn.h);
    this.state = 'captive';
    this.free = 0; // hold-E progress
    this.phase = 0;
    this.sobT = 2 + Math.random() * 4;
    for (let i = 0; i < 10; i++) body.blendPose(kneelPose(0), 0.1, 10);
  }
  get captive() { return this.state === 'captive' && !this.dead; }

  rescue() {
    this.state = 'leaving';
    const bag = this.body.hitMeshes.find((m) => m.geometry.type === 'SphereGeometry' && m.scale.x > 0.115);
    if (bag) { bag.visible = false; this.body.hitMeshes = this.body.hitMeshes.filter((m) => m !== bag); }
    this.game.audio.play('thanks', { pos: this.pos });
    this.game.onHostageRescued(this);
  }

  onWounded() {
    this.game.audio.play('scream', { pos: this.pos, rate: 1.3 });
  }

  onDeath(res) {
    this.game.onHostageKilled(this, res);
  }

  update(dt, t) {
    this.updateBody(dt, t);
    if (this.dead) return;
    const g = this.game;
    if (this.state === 'captive') {
      this.body.blendPose(kneelPose(t, 1), dt, 8);
      this.sobT -= dt;
      if (this.sobT <= 0) {
        this.sobT = 3 + Math.random() * 5;
        g.audio.play('sob', { pos: this.pos, volume: 0.7, rate: 0.9 + Math.random() * 0.2 });
      }
    } else if (this.state === 'leaving') {
      const target = g.exit;
      const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
      if (Math.hypot(dx, dz) < 0.6) { this.state = 'safe'; this.root.visible = false; this.body.hitMeshes = []; return; }
      if (!this.path || (this.repathT -= dt) <= 0) { this.path = g.level.findPath(this.pos, target); this.pathI = 0; this.repathT = 2; }
      let speed = 0;
      if (this.path && this.pathI < this.path.length) {
        const wp = this.path[this.pathI];
        const wx = wp.x - this.pos.x, wz = wp.z - this.pos.z, d = Math.hypot(wx, wz);
        if (d < 0.35) this.pathI++;
        else {
          speed = 2.6;
          this.pos.x += wx / d * speed * dt; this.pos.z += wz / d * speed * dt;
          let a = Math.atan2(wx, wz) - this.heading;
          this.heading += Math.atan2(Math.sin(a), Math.cos(a)) * Math.min(1, dt * 8);
        }
        for (const door of g.level.doors) {
          if (!door.isOpen && Math.hypot(door.center.x - this.pos.x, door.center.z - this.pos.z) < 1.0) door.open(this.pos);
        }
      }
      g.level.collide(this.pos, 0.25);
      this.root.rotation.y = this.heading;
      this.phase += speed * dt * 4;
      this.body.blendPose(standPose({ phase: this.phase, speed, t, raise: 0.4 }), dt, 8);
    }
  }
}
