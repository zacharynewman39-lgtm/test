import * as THREE from 'three';

// Blood as physics: every droplet carries a volume, flies ballistically with
// air drag, and on landing feeds a pool (pools grow by volume at ~3 mm
// thickness, spread, and darken as they clot) or leaves a splatter decal
// stretched along its impact direction. Also tissue fragments, bone chips
// and fine mist for high-energy wounds.

const MAX_P = 9000;
const MAX_SPLATS = 1500;
const MAX_POOLS = 400;
const CELL = 0.04; // ground accumulation grid (m)
const RHO = 1060;

export class BloodFX {
  constructor(scene, { groundHeight = () => 0 } = {}) {
    this.scene = scene;
    this.groundHeight = groundHeight;
    this.n = 0;
    this.pos = new Float32Array(MAX_P * 3);
    this.vel = new Float32Array(MAX_P * 3);
    this.vol = new Float32Array(MAX_P);     // mL
    this.kind = new Uint8Array(MAX_P);      // 0 blood, 1 tissue, 2 bone, 3 mist
    this.life = new Float32Array(MAX_P);
    this.colliders = [];                    // spheres {c: Vector3, r} droplets stick to (body)

    const drop = new THREE.IcosahedronGeometry(1, 1);
    this.dropMesh = new THREE.InstancedMesh(drop, new THREE.MeshPhysicalMaterial({
      color: 0x4a0202, roughness: 0.06, clearcoat: 0.6, clearcoatRoughness: 0.05, sheen: 0.3, envMapIntensity: 0.6,
      sheenColor: new THREE.Color(0.6, 0.05, 0.05),
    }), MAX_P);
    this.dropMesh.frustumCulled = false;
    this.dropMesh.count = 0;
    this.dropMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_P * 3), 3);
    scene.add(this.dropMesh);

    // splatter decals
    const splatTex = makeSplatTexture();
    this.splatMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshPhysicalMaterial({
        map: splatTex, alphaMap: splatTex, transparent: true, depthWrite: false, color: 0x3a0202,
        roughness: 0.12, clearcoat: 0.4, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -2,
      }), MAX_SPLATS);
    this.splatMesh.count = 0;
    this.splatMesh.frustumCulled = false;
    this.splatMesh.renderOrder = 2;
    this.splatAge = new Float32Array(MAX_SPLATS);
    this.splatI = 0;
    scene.add(this.splatMesh);

    // pools
    this.cells = new Map();
    this.pools = [];
    const poolGeo = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2);
    this.poolSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POOLS * 2), 2);
    poolGeo.setAttribute('aPool', this.poolSeed);
    const poolMat = new THREE.MeshPhysicalMaterial({
      color: 0x4a0202, roughness: 0.04, clearcoat: 0.5, clearcoatRoughness: 0.02, transparent: true,
      envMapIntensity: 0.45, specularIntensity: 0.6,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
    });
    poolMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aPool; varying vec2 vPool; varying vec2 vLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPool = aPool; vLocal = position.xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vPool; varying vec2 vLocal;
          float ph(float a, float s){ return sin(a*3.0+s)*0.08 + sin(a*7.0+s*2.3)*0.05 + sin(a*13.0+s*5.1)*0.03 + sin(a*23.0+s*1.7)*0.015; }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float ang = atan(vLocal.y, vLocal.x);
          float rr = length(vLocal);
          float edge = 0.86 + ph(ang, vPool.x * 40.0);
          if (rr > edge) discard;
          float clot = clamp(vPool.y / 240.0, 0.0, 1.0);          // age in seconds
          diffuseColor.rgb = mix(vec3(0.16, 0.002, 0.002), vec3(0.05, 0.006, 0.005), clot);
          diffuseColor.rgb *= 0.85 + 0.15 * smoothstep(edge - 0.08, edge, rr);  // thin bright rim
          diffuseColor.a = 1.0 - smoothstep(edge - 0.02, edge, rr);
        `);
    };
    this.poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, MAX_POOLS);
    this.poolMesh.count = 0;
    this.poolMesh.frustumCulled = false;
    this.poolMesh.renderOrder = 1;
    scene.add(this.poolMesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this.totalOnGround = 0;
  }

  // emit `ml` of blood split into droplets
  spray(origin, dir, speed, ml, { spread = 0.25, kind = 0, dropMl = 0.05, speedJitter = 0.35 } = {}) {
    let count = Math.max(1, Math.round(ml / dropMl));
    if (count > 400) { dropMl = ml / 400; count = 400; }
    for (let i = 0; i < count && this.n < MAX_P; i++) {
      const k = this.n++;
      const v = dropMl * (0.3 + Math.random() * 1.4);
      this.vol[k] = v; this.kind[k] = kind; this.life[k] = 0;
      this.pos[k * 3] = origin.x; this.pos[k * 3 + 1] = origin.y; this.pos[k * 3 + 2] = origin.z;
      const s = speed * (1 - speedJitter + Math.random() * speedJitter * 2);
      this._d.set(dir.x + (Math.random() - 0.5) * 2 * spread, dir.y + (Math.random() - 0.5) * 2 * spread,
        dir.z + (Math.random() - 0.5) * 2 * spread).normalize().multiplyScalar(s);
      this.vel[k * 3] = this._d.x; this.vel[k * 3 + 1] = this._d.y; this.vel[k * 3 + 2] = this._d.z;
    }
  }

  // pressure-driven jet from an arterial wound; returns velocity used
  jet(origin, normal, mmHg, mlThisFrame, dt) {
    const dp = Math.max(0, mmHg) * 133.32;
    const v = 0.55 * Math.sqrt((2 * dp) / RHO); // orifice losses
    if (mlThisFrame > 0) this.spray(origin, normal, v, mlThisFrame, { spread: 0.05, dropMl: 0.012, speedJitter: 0.1 });
    return v;
  }

  drip(origin, ml) {
    if (ml <= 0) return;
    this._acc = (this._acc || 0) + ml;
    while (this._acc > 0.25) {
      this._acc -= 0.25;
      this.spray(origin, this._d.set(0, -1, 0), 0.05, 0.25, { spread: 0.4, dropMl: 0.25 });
    }
  }

  chunks(origin, dir, speed, count, kind) {
    for (let i = 0; i < count; i++) this.spray(origin, dir, speed, 0.6, { spread: 0.55, kind, dropMl: 0.6 });
  }

  mist(origin, dir, speed, ml) {
    this.spray(origin, dir, speed, ml, { spread: 0.45, kind: 3, dropMl: 0.004, speedJitter: 0.5 });
  }

  // blood landing on the ground accumulates per grid cell; cells with enough
  // volume become pools (3 mm deep) that merge with their neighbours
  addToPool(x, z, ml) {
    this.totalOnGround += ml;
    const key = Math.round(x / CELL) + ',' + Math.round(z / CELL);
    let c = this.cells.get(key);
    if (!c) { c = { x, z, vol: 0, age: 0, seed: Math.random() }; this.cells.set(key, c); }
    const w = ml / (c.vol + ml);
    c.x += (x - c.x) * w; c.z += (z - c.z) * w;
    c.vol += ml;
    c.age = Math.max(0, c.age - ml * 2);
    this.poolsDirty = true;
  }

  splat(x, y, z, vx, vz, size) {
    const i = this.splatI++ % MAX_SPLATS;
    const sp = Math.hypot(vx, vz);
    this._q.setFromAxisAngle(this._d.set(0, 1, 0), Math.atan2(vx, vz) + (sp < 0.3 ? Math.random() * 6.28 : 0));
    this._s.set(size, 1, size * (1 + Math.min(sp, 4) * 0.6));
    this._m.compose(this._p.set(x, y + 0.0015, z), this._q, this._s);
    this.splatMesh.setMatrixAt(i, this._m);
    this.splatMesh.count = Math.min(MAX_SPLATS, Math.max(this.splatMesh.count, i + 1));
    this.splatMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    const g = -9.81;
    let w = 0;
    const col = this.dropMesh.instanceColor.array;
    for (let i = 0; i < this.n; i++) {
      const k3 = i * 3;
      const kind = this.kind[i];
      const r = Math.cbrt((3 * this.vol[i] * 1e-6) / (4 * Math.PI));
      // quadratic air drag; mist slows almost immediately
      const sp = Math.hypot(this.vel[k3], this.vel[k3 + 1], this.vel[k3 + 2]);
      const drag = kind === 3 ? 6 : (0.47 * 1.2 * Math.PI * r * r * 0.5 * sp) / (RHO * (4 / 3) * Math.PI * r * r * r);
      const f = Math.max(0, 1 - drag * dt);
      this.vel[k3] *= f; this.vel[k3 + 2] *= f;
      this.vel[k3 + 1] = this.vel[k3 + 1] * f + g * dt * (kind === 3 ? 0.15 : 1);
      this.pos[k3] += this.vel[k3] * dt; this.pos[k3 + 1] += this.vel[k3 + 1] * dt; this.pos[k3 + 2] += this.vel[k3 + 2] * dt;
      this.life[i] += dt;
      const gy = this.groundHeight(this.pos[k3], this.pos[k3 + 2]);
      let dead = false;
      if (this.pos[k3 + 1] <= gy) {
        if (kind === 0) {
          this.addToPool(this.pos[k3], this.pos[k3 + 2], this.vol[i]);
          if (sp > 1.2 || this.vol[i] > 0.15 || Math.random() < 0.2) this.splat(this.pos[k3], gy, this.pos[k3 + 2], this.vel[k3], this.vel[k3 + 2], 0.006 + 0.05 * Math.cbrt(this.vol[i]) * (0.6 + 0.12 * sp));
        } else if (kind === 3) {
          if (Math.random() < 0.05) this.splat(this.pos[k3], gy, this.pos[k3 + 2], this.vel[k3], this.vel[k3 + 2], 0.004);
        } else {
          // fragments bounce and settle
          this.pos[k3 + 1] = gy + 0.002; this.vel[k3 + 1] *= -0.25; this.vel[k3] *= 0.5; this.vel[k3 + 2] *= 0.5;
          if (Math.abs(this.vel[k3 + 1]) < 0.2 && this.life[i] > 0.4) { this.vel[k3] = this.vel[k3 + 1] = this.vel[k3 + 2] = 0; if (this.life[i] > 120) dead = true; }
        }
        if (kind === 0 || kind === 3) dead = true;
      }
      if (kind === 3 && this.life[i] > 1.5) dead = true;
      if (dead) { this.kill(i); i--; continue; }
      // stretch droplets along their velocity
      const s = kind === 1 ? Math.max(r, 0.004) * 1.4 : kind === 2 ? Math.max(r, 0.003) : kind === 3 ? 0.0008 : r * 1.25;
      if (sp > 0.01) this._q.setFromUnitVectors(this._d.set(0, 1, 0), this._p.set(this.vel[k3] / sp, this.vel[k3 + 1] / sp, this.vel[k3 + 2] / sp));
      // fast droplets read as streaks (motion + surface tension necking)
      this._s.set(s, s * (1 + Math.min(sp * 0.9, 6)), s);
      this._m.compose(this._p.set(this.pos[k3], this.pos[k3 + 1], this.pos[k3 + 2]), this._q, this._s);
      this.dropMesh.setMatrixAt(w, this._m);
      const c = kind === 1 ? [0.45, 0.12, 0.12] : kind === 2 ? [0.9, 0.86, 0.76] : [1, 1, 1];
      col[w * 3] = c[0]; col[w * 3 + 1] = c[1]; col[w * 3 + 2] = c[2];
      w++;
    }
    this.dropMesh.count = w;
    this.dropMesh.instanceMatrix.needsUpdate = true;
    this.dropMesh.instanceColor.needsUpdate = true;

    // pools spread slowly and clot
    if (this.poolsDirty || (this._poolT = (this._poolT || 0) + dt) > 0.5) {
      this._poolT = 0;
      this.poolsDirty = false;
      this.pools = [...this.cells.values()].filter((c) => c.vol > 0.8).sort((a, b) => b.vol - a.vol).slice(0, MAX_POOLS);
    }
    for (const c of this.cells.values()) c.age += dt;
    for (let i = 0; i < this.pools.length; i++) {
      const p = this.pools[i];
      const spread = 1 + 0.25 * Math.min(1, p.age / 60);
      const r = Math.sqrt((p.vol * 1e-6) / (Math.PI * 0.003)) * spread;
      const gy = this.groundHeight(p.x, p.z);
      this._m.compose(this._p.set(p.x, gy + 0.001 + (i % 7) * 0.00004, p.z), this._q.identity(), this._s.set(r, 1, r));
      this.poolMesh.setMatrixAt(i, this._m);
      this.poolSeed.setXY(i, p.seed, p.age);
    }
    this.poolMesh.count = this.pools.length;
    this.poolMesh.instanceMatrix.needsUpdate = true;
    this.poolSeed.needsUpdate = true;
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (let a = 0; a < 3; a++) { this.pos[i * 3 + a] = this.pos[j * 3 + a]; this.vel[i * 3 + a] = this.vel[j * 3 + a]; }
    this.vol[i] = this.vol[j]; this.kind[i] = this.kind[j]; this.life[i] = this.life[j];
  }

  clear() {
    this.n = 0; this.pools.length = 0; this.cells.clear(); this.splatMesh.count = 0; this.splatI = 0; this.totalOnGround = 0;
  }
}

function makeSplatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  const blob = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  blob(128, 128, 42);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 30 + Math.random() * 80;
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 2 + Math.random() * 10 * (1 - d / 120));
    // streaks back toward the centre
    g.beginPath(); g.lineWidth = 2 + Math.random() * 5; g.strokeStyle = '#fff';
    g.moveTo(128 + Math.cos(a) * 30, 128 + Math.sin(a) * 30); g.lineTo(128 + Math.cos(a) * d, 128 + Math.sin(a) * d); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}
