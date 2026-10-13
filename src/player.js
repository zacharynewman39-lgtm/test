import * as THREE from 'three';

// The player is deliberately just a block.
export class Player {
  constructor(camera, dom) {
    this.camera = camera;
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 0.25, 0),
      new THREE.MeshStandardMaterial({ color: 0x3d7be0, roughness: 0.6 })
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0.25;
    this.dist = 4.5;
    this.keys = {};
    this.enabled = true;
    this.colliders = [];
    this.onGround = true;

    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    dom.addEventListener('click', () => { if (this.enabled) dom.requestPointerLock(); });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0025;
      this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.002, -0.35, 1.2);
    });
    window.addEventListener('wheel', (e) => {
      if (this.enabled) this.dist = THREE.MathUtils.clamp(this.dist * (1 + e.deltaY * 0.001), 1.5, 14);
    }, { passive: true });
  }

  update(dt) {
    const k = this.keys;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (this.enabled) {
      if (k.KeyW) wish.add(fwd);
      if (k.KeyS) wish.sub(fwd);
      if (k.KeyD) wish.add(right);
      if (k.KeyA) wish.sub(right);
    }
    const speed = k.ShiftLeft || k.ShiftRight ? 7 : 3.2;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    const a = 1 - Math.exp(-12 * dt);
    this.vel.x += (wish.x - this.vel.x) * a;
    this.vel.z += (wish.z - this.vel.z) * a;
    if (this.enabled && k.Space && this.onGround) { this.vel.y = 5; this.onGround = false; }
    this.vel.y -= 14 * dt;

    const p = this.mesh.position;
    p.addScaledVector(this.vel, dt);
    if (p.y <= 0) { p.y = 0; this.vel.y = 0; this.onGround = true; }
    for (const c of this.colliders) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const d = Math.hypot(dx, dz), min = c.r + 0.3;
      if (d < min && d > 1e-5) { p.x = c.x + dx / d * min; p.z = c.z + dz / d * min; }
    }
    if (wish.lengthSq() > 0) {
      const target = Math.atan2(wish.x, wish.z);
      let diff = target - this.mesh.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.mesh.rotation.y += diff * Math.min(1, 10 * dt);
    }

    if (this.enabled) {
      const focus = p.clone().add(new THREE.Vector3(0, 0.9, 0));
      const cp = Math.cos(this.pitch);
      this.camera.position.set(
        focus.x + Math.sin(this.yaw) * cp * this.dist,
        focus.y + Math.sin(this.pitch) * this.dist,
        focus.z + Math.cos(this.yaw) * cp * this.dist,
      );
      if (this.camera.position.y < 0.15) this.camera.position.y = 0.15;
      this.camera.lookAt(focus);
    }
  }
}
