import * as THREE from 'three';
import * as T from './textures.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

// Flat decals stuck to walls/floors, drawn as one instanced mesh per texture.
class DecalPool {
  constructor(scene, texture, capacity, opts = {}) {
    const mat = new THREE.MeshStandardMaterial({
      map: texture, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      roughness: opts.roughness ?? 0.2, metalness: 0, color: 0xffffff,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = opts.order ?? 1;
    this.capacity = capacity;
    this.next = 0;
    this.pos = [];
    this.quat = [];
    this.size = [];
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, _c.set(0xffffff));
    scene.add(this.mesh);
  }
  add(pos, normal, size, color, spin = Math.random() * Math.PI * 2, stretch = 1) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    _q.setFromUnitVectors(Z, normal);
    _q2.setFromAxisAngle(Z, spin);
    const q = _q.clone().multiply(_q2);
    const p = pos.clone().addScaledVector(normal, 0.003 + Math.random() * 0.002);
    this.pos[i] = p; this.quat[i] = q; this.size[i] = [size, size * stretch];
    this.write(i);
    this.mesh.setColorAt(i, _c.set(color));
    this.mesh.instanceColor.needsUpdate = true;
    return i;
  }
  resize(i, size, stretch = 1) {
    this.size[i] = [size, size * stretch];
    this.write(i);
  }
  write(i) {
    const [w, h] = this.size[i];
    _m.compose(this.pos[i], this.quat[i], _s.set(w, h, 1));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Gore {
  constructor(scene, level) {
    this.scene = scene;
    this.level = level;
    this.ray = new THREE.Raycaster();
    // blood droplets in flight
    this.N = 1400;
    this.drops = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 5, 4),
      new THREE.MeshStandardMaterial({ color: 0x5c0404, roughness: 0.25 }), this.N);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.frustumCulled = false;
    this.drops.count = 0;
    scene.add(this.drops);
    this.p = [];
    // decals
    this.splats = [0, 1, 2].map((i) => new DecalPool(scene, T.splatTexture(100 + i, 'splat'), 220, { order: 2 }));
    this.dropDecals = new DecalPool(scene, T.splatTexture(110, 'drop'), 500, { order: 2 });
    this.pools = new DecalPool(scene, T.splatTexture(120, 'pool'), 40, { order: 1, roughness: 0.08 });
    this.holes = new DecalPool(scene, T.bulletHoleTexture(), 300, { order: 3, roughness: 0.9 });
    this.runs = new DecalPool(scene, T.splatTexture(130, 'run'), 120, { order: 2 });
    this.feet = new DecalPool(scene, T.splatTexture(140, 'foot'), 160, { order: 2 });
    this.running = [];
    this.growing = [];
    // mist puffs
    this.puffTex = T.puffTexture();
    this.puffs = [];
    // chunks: severed parts and gibs
    this.chunks = [];
    this.emitters = [];
    this.dropCooldown = 0;
  }

  // ---------------------------------------------------------------- particles
  spray(origin, dir, count, speed = 3, spread = 0.5, size = 1) {
    for (let i = 0; i < count; i++) {
      if (this.p.length >= this.N) this.p.shift();
      const v = dir.clone().multiplyScalar(speed * (0.3 + Math.random() * 0.9));
      v.x += (Math.random() - 0.5) * spread * speed;
      v.y += (Math.random() - 0.3) * spread * speed;
      v.z += (Math.random() - 0.5) * spread * speed;
      this.p.push({ pos: origin.clone(), vel: v, r: (0.004 + Math.random() * 0.01) * size, life: 3 });
    }
  }

  mist(pos, size = 0.25, color = 0x7a0505) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, color, transparent: true, opacity: 0.85, depthWrite: false }));
    sp.position.copy(pos);
    sp.scale.setScalar(size * 0.4);
    this.scene.add(sp);
    this.puffs.push({ sp, t: 0, size, life: 0.35 + Math.random() * 0.2 });
  }

  dust(pos, normal) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, color: 0x8a8070, transparent: true, opacity: 0.5, depthWrite: false }));
    sp.position.copy(pos).addScaledVector(normal, 0.05);
    sp.scale.setScalar(0.05);
    this.scene.add(sp);
    this.puffs.push({ sp, t: 0, size: 0.25, life: 0.4 });
  }

  smoke(pos, amount = 2) {
    for (let i = 0; i < amount; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.puffTex, color: 0x9a968e, transparent: true, opacity: 0.22, depthWrite: false }));
      sp.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1));
      sp.scale.setScalar(0.1);
      this.scene.add(sp);
      this.puffs.push({ sp, t: 0, size: 0.6 + Math.random() * 0.5, life: 1.4 + Math.random(), rise: 0.25, op: 0.22 });
    }
  }

  // A bloody footprint, facing `heading`.
  footprint(pos, heading, side, wetness) {
    const off = side * 0.09;
    const p = new THREE.Vector3(pos.x + Math.cos(heading) * off, 0.0015, pos.z - Math.sin(heading) * off);
    const k = 0.5 + wetness * 0.5;
    _c.setRGB(0.22 * k, 0.008 * k, 0.008 * k);
    this.feet.add(p, UP, 0.16, _c.getHex(), heading + Math.PI, 1.8);
  }

  // A wounded man dragging himself leaves a long smear.
  smear(pos, heading) {
    _c.setRGB(0.2, 0.008, 0.008);
    this.dropDecals.add(new THREE.Vector3(pos.x, 0.0012, pos.z), UP, 0.22, _c.getHex(), heading, 2.2);
  }

  // How much blood is on the floor here (0..1)?
  wetAt(pos) {
    let w = 0;
    const pl = this.pools;
    for (let i = 0; i < pl.mesh.count; i++) {
      const p = pl.pos[i];
      if (!p) continue;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < pl.size[i][0] * 0.45) w = Math.max(w, 1 - d / (pl.size[i][0] * 0.45));
    }
    return w;
  }

  bulletHole(point, normal) {
    this.holes.add(point, normal, 0.06 + Math.random() * 0.03, 0xffffff);
    this.dust(point, normal);
  }

  splat(point, normal, size, dark = 0) {
    const pool = this.splats[Math.floor(Math.random() * 3)];
    const k = 0.75 + Math.random() * 0.3 - dark;
    _c.setRGB(0.3 * k, 0.012 * k, 0.012 * k);
    pool.add(point, normal, size, _c.getHex(), undefined, 0.8 + Math.random() * 0.5);
  }

  dropDecal(point, size) {
    const k = 0.7 + Math.random() * 0.3;
    _c.setRGB(0.28 * k, 0.012 * k, 0.012 * k);
    this.dropDecals.add(point, UP, size, _c.getHex());
  }

  // A pool that spreads under a body.
  pool(pos, maxSize, rate = 0.12) {
    _c.setRGB(0.16, 0.006, 0.006);
    const i = this.pools.add(new THREE.Vector3(pos.x, 0.001, pos.z), UP, 0.1, _c.getHex());
    const g = { i, size: 0.1, max: maxSize, rate };
    this.growing.push(g);
    return g;
  }

  // After a bullet leaves a body, paint whatever is behind it.
  exitSplatter(point, dir, power = 1) {
    this.ray.set(point, dir);
    this.ray.far = 3.5;
    const hit = this.ray.intersectObjects(this.level.occluders, false)[0];
    if (!hit) return;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const size = (0.25 + Math.random() * 0.35) * power * (1 - hit.distance / 5);
    this.splat(hit.point, n, size);
    // on a wall, blood starts running down from the splat
    if (Math.abs(n.y) < 0.3 && hit.point.y > 0.4 && Math.random() < 0.7) this.wallRun(hit.point, n, size);
    if (Math.random() < 0.5) this.splat(hit.point.clone().addScaledVector(dir, -0.05).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 0)), n, size * 0.5);
  }

  wallRun(point, n, size) {
    _c.setRGB(0.24, 0.01, 0.01);
    const w = size * 0.7;
    // orient so the texture's top sits at the splat and streaks hang downward
    _q.setFromUnitVectors(Z, n);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(_q.clone().invert());
    const spin = Math.atan2(-up.x, up.y);
    const i = this.runs.add(point, n, w, _c.getHex(), spin, 0.05);
    this.running.push({ i, w, len: 0.05, max: Math.min(point.y - 0.05, 0.6 + Math.random() * 1.0) / w, top: point.clone(), n: n.clone() });
  }

  // Brain and skull fragments thrown onto whatever is behind a head shot.
  brainSplatter(point, dir) {
    this.ray.set(point, dir);
    this.ray.far = 4;
    const hit = this.ray.intersectObjects(this.level.occluders, false)[0];
    if (!hit) return;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    _c.setRGB(0.55, 0.38, 0.36);
    this.splats[Math.floor(Math.random() * 3)].add(hit.point.clone().addScaledVector(n, 0.002), n, 0.08 + Math.random() * 0.1, _c.getHex());
    this.splat(hit.point, n, 0.35 + Math.random() * 0.3);
    if (Math.abs(n.y) < 0.3 && hit.point.y > 0.4) this.wallRun(hit.point, n, 0.4);
  }

  // Gibs: a severed limb or a chunk of skull.
  addChunk(obj, vel, spin, opts = {}) {
    if (!obj.parent) this.scene.add(obj);
    this.chunks.push({ obj, vel, spin, rest: false, bleed: opts.bleed ?? 2, r: opts.r ?? 0.06, t: 0 });
  }

  headExplosion(pos, dir) {
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0x6a0a0a, roughness: 0.3 }),
      new THREE.MeshStandardMaterial({ color: 0xc89090, roughness: 0.5 }),
      new THREE.MeshStandardMaterial({ color: 0xe6dcc6, roughness: 0.5 }),
    ];
    for (let i = 0; i < 9; i++) {
      const s = 0.02 + Math.random() * 0.035;
      const g = i % 3 === 2 ? new THREE.BoxGeometry(s * 1.6, s * 0.4, s) : new THREE.IcosahedronGeometry(s, 0);
      const m = new THREE.Mesh(g, mats[i % 3]);
      m.position.copy(pos);
      m.castShadow = true;
      const v = dir.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3));
      this.addChunk(m, v, new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20), { r: s, bleed: 0.6 });
    }
    this.spray(pos, dir, 160, 4.5, 1.0, 1.3);
    this.mist(pos, 0.9);
    this.mist(pos.clone().addScaledVector(dir, 0.3), 0.7);
    for (let i = 0; i < 3; i++) this.exitSplatter(pos, dir.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.6)).normalize(), 2.2);
  }

  // Keep pumping blood out of something (a stump, a neck wound) for a while.
  emitter(obj, rate, life, dirLocal = new THREE.Vector3(0, 1, 0)) {
    this.emitters.push({ obj, rate, life, t: 0, acc: 0, dirLocal });
  }

  drip(pos, amount = 1) {
    this.spray(pos, new THREE.Vector3(0, -1, 0), amount, 0.3, 0.3, 0.8);
  }

  // ------------------------------------------------------------------- update
  update(dt) {
    const g = 9.8;
    let n = 0;
    const alive = [];
    for (const d of this.p) {
      d.vel.y -= g * dt;
      d.vel.multiplyScalar(1 - 0.6 * dt);
      d.pos.addScaledVector(d.vel, dt);
      d.life -= dt;
      if (d.pos.y <= 0.002) {
        if (Math.random() < 0.45) this.dropDecal(_v.set(d.pos.x, 0.001, d.pos.z), d.r * (3 + Math.random() * 6));
        continue;
      }
      if (d.life <= 0) continue;
      alive.push(d);
      const sp = d.vel.length();
      _q.setFromUnitVectors(UP, sp > 0.01 ? _v.copy(d.vel).divideScalar(sp) : UP);
      _m.compose(d.pos, _q, _s.set(d.r, d.r * (1 + Math.min(sp * 0.4, 3)), d.r));
      this.drops.setMatrixAt(n++, _m);
    }
    this.p = alive;
    this.drops.count = n;
    this.drops.instanceMatrix.needsUpdate = true;

    for (const gr of this.growing) {
      if (gr.size < gr.max) {
        gr.size = Math.min(gr.max, gr.size + gr.rate * dt * (1 - gr.size / (gr.max + 0.01)) * 2);
        this.pools.resize(gr.i, gr.size);
      }
    }
    this.growing = this.growing.filter((x) => x.size < x.max);

    for (const p of this.puffs) {
      p.t += dt;
      const k = p.t / p.life;
      p.sp.scale.setScalar(p.size * (0.4 + k * 0.8));
      p.sp.material.opacity = (p.op ?? 0.85) * (1 - k);
      if (p.rise) p.sp.position.y += p.rise * dt;
    }
    // blood creeping down walls: grow the decal and keep its top pinned
    for (const r of this.running) {
      r.len = Math.min(r.max, r.len + dt * 0.25 * (1 - r.len / (r.max + 0.01)) * 3);
      const pool = this.runs;
      pool.size[r.i] = [r.w, r.w * r.len];
      pool.pos[r.i] = r.top.clone().addScaledVector(r.n, 0.004).add(new THREE.Vector3(0, -r.w * r.len / 2 + r.w * 0.1, 0));
      pool.write(r.i);
    }
    this.running = this.running.filter((r) => r.len < r.max - 0.01);
    this.puffs = this.puffs.filter((p) => {
      if (p.t < p.life) return true;
      this.scene.remove(p.sp); p.sp.material.dispose();
      return false;
    });

    for (const c of this.chunks) {
      if (c.rest) continue;
      c.t += dt;
      c.vel.y -= g * dt;
      const o = c.obj;
      o.position.addScaledVector(c.vel, dt);
      o.rotation.x += c.spin.x * dt; o.rotation.y += c.spin.y * dt; o.rotation.z += c.spin.z * dt;
      const before = o.position.clone();
      this.level.collide(o.position, c.r, 3);
      // fast meat hitting a wall sticks there and slides a little
      if (before.distanceToSquared(o.position) > 1e-6 && c.vel.lengthSq() > 4 && o.position.y > 0.3 && !o.userData.muzzle) {
        const n = o.position.clone().sub(before).setY(0).normalize();
        this.splat(o.position.clone().addScaledVector(n, -c.r), n, 0.25 + Math.random() * 0.2);
        if (Math.random() < 0.6) this.wallRun(o.position.clone().addScaledVector(n, -c.r), n, 0.3);
        c.vel.set(0, -0.15, 0); c.spin.set(0, 0, 0); c.stuck = 2 + Math.random() * 4;
      }
      if (c.stuck > 0) { c.stuck -= dt; c.vel.set(0, -0.04, 0); if (c.stuck <= 0) c.vel.set(0, -0.5, 0); }
      if (o.position.y < c.r * 0.6) {
        o.position.y = c.r * 0.6;
        if (Math.abs(c.vel.y) > 1) {
          this.splat(_v.set(o.position.x, 0.001, o.position.z), UP, 0.15 + Math.random() * 0.15);
          c.vel.y *= -0.25;
        } else c.vel.y = 0;
        c.vel.x *= 0.6; c.vel.z *= 0.6;
        c.spin.multiplyScalar(0.5);
        if (c.vel.lengthSq() < 0.01 || c.t > 4) {
          c.rest = true;
          // lay severed limbs flat
          if (o.userData.muzzle) { o.rotation.set(0, o.rotation.y, Math.PI / 2); o.position.y = 0.03; } // a dropped rifle lies on its side
          else if (o.isGroup) { o.rotation.x = Math.PI / 2 * Math.sign(o.rotation.x || 1); o.position.y = 0.06; }
        }
      }
      if (c.bleed > 0 && Math.random() < dt * 25) {
        this.spray(o.getWorldPosition(_v), UP, 1, 0.4, 0.8);
        c.bleed -= dt;
      }
    }

    for (const e of this.emitters) {
      e.t += dt;
      if (!e.obj.parent) { e.t = e.life; continue; }
      const pulse = 0.4 + 0.6 * Math.max(0, Math.sin(e.t * 7.5));
      const fade = 1 - e.t / e.life;
      e.acc += e.rate * pulse * fade * dt;
      if (e.acc >= 1) {
        const k = Math.floor(e.acc);
        e.acc -= k;
        const wp = e.obj.getWorldPosition(new THREE.Vector3());
        const wq = e.obj.getWorldQuaternion(new THREE.Quaternion());
        const dir = e.dirLocal.clone().applyQuaternion(wq);
        this.spray(wp, dir, k, 1.6 * pulse * fade + 0.3, 0.35);
      }
    }
    this.emitters = this.emitters.filter((e) => e.t < e.life);
  }
}
