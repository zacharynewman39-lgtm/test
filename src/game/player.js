import * as THREE from 'three';

const STAND_EYE = 1.62, CROUCH_EYE = 1.02;

export class FPSPlayer {
  constructor(game, camera, spawn) {
    this.game = game;
    this.camera = camera;
    this.pos = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.yaw = spawn.yaw;
    this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.crouch = 0;
    this.crouched = false;
    this.hp = 100;
    this.alive = true;
    this.firedT = 99;
    this.speed = 0;
    this.sprinting = false;
    this.bob = 0;
    this.shake = 0;
    this.recoilP = 0;
    this.stepAcc = 0;
    this._eye = new THREE.Vector3();

    this.flashlight = true;
    this.torch = new THREE.SpotLight(0xfff1dc, 30, 32, 0.55, 0.55, 1.3);
    this.torch.castShadow = true;
    this.torch.shadow.mapSize.set(512, 512);
    this.torch.shadow.bias = -0.0004;
    this.torch.shadow.camera.near = 0.1;
    this.torch.position.set(0.18, -0.12, 0.05);
    this.torch.target.position.set(0.05, -0.05, -6);
    camera.add(this.torch, this.torch.target);
  }

  get eye() {
    return this._eye.set(this.pos.x + (this.leanOff?.x || 0), this.pos.y + THREE.MathUtils.lerp(STAND_EYE, CROUCH_EYE, this.crouch) - Math.abs(this.lean || 0) * 0.06, this.pos.z + (this.leanOff?.z || 0));
  }
  chestPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + THREE.MathUtils.lerp(1.3, 0.8, this.crouch), this.pos.z); }
  forward(out = new THREE.Vector3()) { return this.camera.getWorldDirection(out); }

  // Is the player's view pointed at pos (within cos threshold)?
  lookingAt(pos, cos = 0.9) {
    const f = this.forward(new THREE.Vector3());
    const d = new THREE.Vector3(pos.x - this.pos.x, 0, pos.z - this.pos.z).normalize();
    f.y = 0; f.normalize();
    return f.dot(d) > cos;
  }

  toggleFlashlight() {
    this.flashlight = !this.flashlight;
    this.torch.intensity = this.flashlight ? 30 : 0;
    this.game.audio.play('empty', { volume: 0.6, rate: 0.7 });
  }

  look(dx, dy, sens) {
    this.yaw -= dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -1.45, 1.45);
  }

  kickRecoil(p, y) {
    this.pitch = Math.min(1.45, this.pitch + p);
    this.yaw += y;
    this.recoilP += p;
  }

  damage(amount, from) {
    if (!this.alive) return;
    this.hp -= amount;
    this.shake = Math.min(1, this.shake + amount / 30);
    this.game.audio.play('hurt', { volume: 0.9 });
    this.game.hud.damage(amount, from, this);
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.game.onPlayerDeath();
    }
  }

  update(dt, input) {
    const g = this.game;
    const k = input.keys;
    if (this.alive) {
      this.crouched = !!this.crouchToggle;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const wish = new THREE.Vector3();
      if (k.KeyW) wish.add(fwd);
      if (k.KeyS) wish.sub(fwd);
      if (k.KeyD) wish.add(right);
      if (k.KeyA) wish.sub(right);
      this.sprinting = !!k.Space && !!k.KeyW && !g.weapons.aiming;
      if (this.sprinting && this.crouchToggle) this.crouchToggle = false; // sprinting stands you up
      let speed = this.crouched ? 1.7 : this.sprinting ? 5.8 : 3.3;
      // lean: Q left, E right (peek round corners without stepping out)
      this.leanTarget = (k.KeyE ? 1 : 0) - (k.KeyQ ? 1 : 0);
      if (this.sprinting) this.leanTarget = 0;
      if (g.weapons.aiming) speed *= 0.6;
      if (this.hp < 30) speed *= 0.8;
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
      // momentum: quick to start, a little slide to stop
      const a = 1 - Math.exp(-(wish.lengthSq() > 0 ? 11 : 7) * dt);
      this.vel.x += (wish.x - this.vel.x) * a;
      this.vel.z += (wish.z - this.vel.z) * a;
      this.strafe = right.dot(this.vel);
    } else {
      this.vel.multiplyScalar(0.9);
      this.crouched = true;
    }
    this.crouch += ((this.crouched ? 1 : 0) - this.crouch) * (1 - Math.exp(-10 * dt));
    // lean, stopped short by walls so the camera never clips through
    this.lean = (this.lean || 0) + ((this.leanTarget || 0) - (this.lean || 0)) * (1 - Math.exp(-9 * dt));
    const side = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    let reach = 0.42 * this.lean;
    if (Math.abs(reach) > 0.01) {
      const from = new THREE.Vector3(this.pos.x, this.pos.y + THREE.MathUtils.lerp(STAND_EYE, CROUCH_EYE, this.crouch), this.pos.z);
      const dir = side.clone().multiplyScalar(Math.sign(reach));
      this._ray ||= new THREE.Raycaster();
      this._ray.set(from, dir);
      this._ray.far = Math.abs(reach) + 0.15;
      const hit = this._ray.intersectObjects(g.level.occluders, false)[0];
      if (hit) reach = Math.sign(reach) * Math.max(0, hit.distance - 0.15);
    }
    this.leanOff = side.multiplyScalar(reach);
    this.pos.addScaledVector(this.vel, dt);
    for (const e of g.enemies) { // don't walk through standing suspects
      if (e.dead || e.prone || e.state === 'playdead') continue;
      const dx = this.pos.x - e.pos.x, dz = this.pos.z - e.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.55 && d > 1e-4) { this.pos.x = e.pos.x + dx / d * 0.55; this.pos.z = e.pos.z + dz / d * 0.55; }
    }
    g.level.collide(this.pos, 0.3);
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // footsteps make noise
    this.bob += this.speed * dt * 2.1;
    this.stepAcc += this.speed * dt;
    const stride = this.sprinting ? 1.6 : 1.25;
    if (this.stepAcc > stride && this.alive) {
      this.stepAcc = 0;
      g.audio.play('step', { volume: this.crouched ? 0.15 : this.sprinting ? 0.6 : 0.3, rate: 0.9 + Math.random() * 0.2 });
      if (this.sprinting) g.squad.noise(this.pos, 6);
      // walk through a pool and you track it around the house
      if (g.gore.wetAt(this.pos) > 0.15) this.bloodySteps = 10;
      if (this.bloodySteps > 0) {
        this.bloodySteps--;
        this.foot = -(this.foot || 1);
        g.gore.footprint(this.pos, this.yaw + Math.PI, this.foot, this.bloodySteps / 10);
      }
    }

    this.firedT += dt;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    // recover part of the recoil
    const rec = this.recoilP * Math.min(1, dt * 6);
    this.pitch -= rec * 0.6;
    this.recoilP -= rec;

    const cam = this.camera;
    const e = this.eye;
    const bobAmt = Math.min(this.speed / 3, 1.6) * (this.crouched ? 0.5 : 1);
    cam.position.set(e.x, e.y + Math.sin(this.bob * 2) * 0.022 * bobAmt, e.z);
    this.tilt = (this.tilt || 0) + ((-(this.strafe || 0) * 0.012 - this.lean * 0.22) - (this.tilt || 0)) * (1 - Math.exp(-8 * dt));
    if (!this.alive) cam.position.y = Math.max(0.3, cam.position.y - 0.6);
    const sh = this.shake * this.shake;
    cam.rotation.set(
      this.pitch + (Math.random() - 0.5) * sh * 0.05,
      this.yaw + (Math.random() - 0.5) * sh * 0.05 + Math.sin(this.bob) * 0.004 * bobAmt,
      (this.alive ? this.tilt : 0.6) + (Math.random() - 0.5) * sh * 0.03, 'YXZ');
  }
}
