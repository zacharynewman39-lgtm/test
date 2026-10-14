import * as THREE from 'three';
import { flashTexture, fbm } from './textures.js';

export const DEFS = {
  rifle: {
    name: 'M4 Carbine · Semi', mag: 30, reserve: 150, rpm: 600, auto: false, damage: 52, pellets: 1, penetration: 2,
    hip: 0.03, ads: 0.002, recoil: 0.026, reload: 2.1, sound: 'rifle', fov: 50, adsZ: -0.2,
  },
  shotgun: {
    name: 'M870 Shotgun', mag: 6, reserve: 36, rpm: 75, auto: false, damage: 21, pellets: 10, penetration: 0,
    hip: 0.07, ads: 0.05, recoil: 0.07, shellTime: 0.48, sound: 'shotgun', fov: 60, adsZ: -0.24,
  },
};

// slightly uneven roughness so the metal catches light like worn anodising
const wear = (() => {
  const t = new THREE.CanvasTexture(fbm(91, 16, 4, 128));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();
const black = new THREE.MeshStandardMaterial({ color: 0x2c2e31, metalness: 0.6, roughness: 0.5, roughnessMap: wear });
const steel = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.9, roughness: 0.35, roughnessMap: wear });
const poly = new THREE.MeshStandardMaterial({ color: 0x3a3833, roughness: 0.8, roughnessMap: wear });
const rubber = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
const wood = new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.55 });
const glove = new THREE.MeshStandardMaterial({ color: 0x262624, roughness: 0.9 });
const sleeve = new THREE.MeshStandardMaterial({ color: 0x1f242c, roughness: 0.95 });
const glass = new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0.5, depthWrite: false });
const red = new THREE.MeshBasicMaterial({ color: 0xff2a1a });

function part(g, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  g.add(m);
  return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r, l, s = 12) => new THREE.CylinderGeometry(r, r, l, s).rotateX(Math.PI / 2);

function hand(g, x, y, z, rx, grip = true) {
  const h = new THREE.Group();
  h.position.set(x, y, z);
  h.rotation.x = rx;
  part(h, box(0.05, 0.075, 0.09), glove, 0, 0, 0);
  for (let i = 0; i < 4; i++) part(h, box(0.012, 0.018, grip ? 0.05 : 0.07), glove, -0.019 + i * 0.0125, -0.04, grip ? -0.02 : -0.06, grip ? 0.9 : 0);
  part(h, box(0.016, 0.02, 0.06), glove, 0.03, 0.01, -0.03, 0, -0.4);
  g.add(h);
  return h;
}

function arms(g, rightGrip, leftGrip) {
  hand(g, rightGrip.x + 0.005, rightGrip.y, rightGrip.z, -0.3);
  part(g, box(0.07, 0.075, 0.42), sleeve, rightGrip.x + 0.07, rightGrip.y - 0.1, rightGrip.z + 0.22, 0.45, 0.3);
  part(g, box(0.078, 0.08, 0.05), glove, rightGrip.x + 0.03, rightGrip.y - 0.045, rightGrip.z + 0.06, 0.45, 0.3); // cuff
  hand(g, leftGrip.x, leftGrip.y - 0.01, leftGrip.z, 0.2, false);
  part(g, box(0.065, 0.07, 0.47), sleeve, leftGrip.x - 0.1, leftGrip.y - 0.08, leftGrip.z + 0.21, 0.35, -0.45);
}

// Viewmodels point down -z with the sight line on the local origin.
function buildRifle() {
  const g = new THREE.Group();
  // holographic sight: open window you look through
  part(g, box(0.034, 0.012, 0.07), black, 0, -0.026, 0.005);
  part(g, box(0.004, 0.034, 0.055), black, 0.018, -0.004, 0.0);
  part(g, box(0.004, 0.034, 0.055), black, -0.018, -0.004, 0.0);
  part(g, box(0.04, 0.005, 0.06), black, 0, 0.015, 0.0);
  part(g, new THREE.PlaneGeometry(0.032, 0.03), glass, 0, -0.003, -0.022);
  part(g, new THREE.RingGeometry(0.0022, 0.0028, 24), red, 0, 0, -0.021);
  part(g, new THREE.CircleGeometry(0.0006, 8), red, 0, 0, -0.0209);
  // upper receiver + rail
  part(g, box(0.034, 0.034, 0.25), black, 0, -0.049, 0.04);
  part(g, box(0.022, 0.006, 0.34), black, 0, -0.03, -0.02);
  for (let i = 0; i < 16; i++) part(g, box(0.024, 0.005, 0.007), black, 0, -0.026, -0.17 + i * 0.021);
  part(g, box(0.042, 0.009, 0.014), black, 0, -0.037, 0.168); // charging handle
  part(g, box(0.003, 0.016, 0.055), poly, 0.0175, -0.05, 0.05); // ejection port cover
  const bolt = part(g, box(0.003, 0.011, 0.04), steel, 0.0168, -0.05, 0.05);
  part(g, cyl(0.006, 0.02, 8), black, 0.019, -0.042, 0.12); // forward assist
  // lower receiver
  part(g, box(0.03, 0.045, 0.17), black, 0, -0.085, 0.05);
  part(g, box(0.035, 0.05, 0.07), black, 0, -0.11, 0.0);
  part(g, box(0.006, 0.004, 0.065), black, 0, -0.12, 0.07);
  part(g, box(0.004, 0.02, 0.006), steel, 0, -0.105, 0.075, 0.3);
  // curved magazine
  const mag = new THREE.Group();
  mag.position.set(0, -0.135, 0.0);
  for (let i = 0; i < 3; i++) part(mag, box(0.026, 0.05, 0.06), poly, 0, -i * 0.045, -i * 0.012, 0.12 + i * 0.1);
  part(mag, box(0.028, 0.012, 0.064), rubber, 0, -0.14, -0.04, 0.4);
  g.add(mag);
  part(g, box(0.028, 0.085, 0.038), poly, 0, -0.127, 0.112, -0.35); // grip
  // handguard
  part(g, cyl(0.025, 0.27, 8), poly, 0, -0.05, -0.215);
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) part(g, box(0.002, 0.012, 0.03), rubber, side * 0.025, -0.05, -0.31 + i * 0.055);
  part(g, cyl(0.014, 0.08, 10), poly, 0, -0.105, -0.25, Math.PI / 2); // vertical foregrip
  // barrel + brake
  part(g, cyl(0.0085, 0.14, 10), steel, 0, -0.05, -0.41);
  part(g, cyl(0.012, 0.055, 10), black, 0, -0.05, -0.505);
  for (let i = 0; i < 3; i++) part(g, box(0.026, 0.004, 0.006), rubber, 0, -0.04, -0.49 - i * 0.012);
  // stock
  part(g, cyl(0.014, 0.15, 12), black, 0, -0.052, 0.235);
  part(g, box(0.036, 0.062, 0.13), poly, 0, -0.066, 0.29);
  part(g, box(0.038, 0.075, 0.02), rubber, 0, -0.07, 0.36);
  // weapon light
  part(g, cyl(0.013, 0.1, 12), black, 0.036, -0.05, -0.27);
  part(g, new THREE.CircleGeometry(0.011, 12), new THREE.MeshBasicMaterial({ color: 0xfff6e0 }), 0.036, -0.05, -0.3205, 0, Math.PI);
  arms(g, new THREE.Vector3(0.006, -0.128, 0.112), new THREE.Vector3(0, -0.11, -0.25));
  g.userData.mag = mag;
  g.userData.bolt = bolt;
  g.userData.muzzle = new THREE.Vector3(0, -0.05, -0.54);
  return g;
}

function buildShotgun() {
  const g = new THREE.Group();
  part(g, new THREE.TorusGeometry(0.011, 0.003, 8, 20), black, 0, 0, 0);
  part(g, box(0.02, 0.016, 0.02), black, 0, -0.016, 0);
  part(g, new THREE.SphereGeometry(0.0035, 8, 6), new THREE.MeshStandardMaterial({ color: 0xd8d0a0, emissive: 0x222200 }), 0, 0, -0.58);
  part(g, box(0.042, 0.055, 0.2), black, 0, -0.04, 0.03);
  part(g, cyl(0.011, 0.56), black, 0, -0.016, -0.34);
  part(g, cyl(0.0095, 0.42), black, 0, -0.042, -0.27);
  const pump = part(g, box(0.045, 0.04, 0.16), wood, 0, -0.045, -0.3);
  part(g, box(0.034, 0.075, 0.3), wood, 0, -0.08, 0.27, 0.12);
  part(g, box(0.03, 0.07, 0.04), wood, 0, -0.1, 0.12, -0.35);
  arms(g, new THREE.Vector3(0.006, -0.11, 0.12), new THREE.Vector3(0, -0.07, -0.3));
  g.userData.pump = pump;
  g.userData.muzzle = new THREE.Vector3(0, -0.016, -0.63);
  return g;
}

export class Weapons {
  constructor(game, mainCamera) {
    this.game = game;
    this.main = mainCamera;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(mainCamera.fov, mainCamera.aspect, 0.01, 5);
    this.scene.add(new THREE.HemisphereLight(0x8a96a8, 0x2a2018, 1.2));
    const key = new THREE.DirectionalLight(0xfff0dd, 1.6);
    key.position.set(0.5, 1, 0.4);
    const rim = new THREE.DirectionalLight(0x9ab0ff, 0.8);
    rim.position.set(-1, 0.3, -0.5);
    this.scene.add(key, rim);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 3, 2);
    this.flashLight.position.set(0, -0.05, -0.6);
    this.scene.add(this.flashLight);

    this.models = { rifle: buildRifle(), shotgun: buildShotgun() };
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    for (const m of Object.values(this.models)) { m.visible = false; this.holder.add(m); }
    const flashMat = new THREE.MeshBasicMaterial({ map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    // front-on star plus a side-on cone so the flash has depth
    this.flash = new THREE.Group();
    const star = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), flashMat);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), flashMat);
    side.rotation.y = Math.PI / 2; side.position.z = -0.12;
    const side2 = side.clone(); side2.rotation.x = Math.PI / 2;
    this.flash.add(star, side, side2);
    this.flash.visible = false;
    this.holder.add(this.flash);
    this.shells = [];
    this.shellMat = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.3 });
    this.redShellMat = new THREE.MeshStandardMaterial({ color: 0x9a1a14, roughness: 0.5 });

    this.state = {
      rifle: { mag: DEFS.rifle.mag, reserve: DEFS.rifle.reserve },
      shotgun: { mag: DEFS.shotgun.mag, reserve: DEFS.shotgun.reserve },
    };
    this.current = 'rifle';
    this.models.rifle.visible = true;
    this.ads = 0;
    this.aiming = false;
    this.cool = 0;
    this.kick = 0;
    this.reloading = 0; // seconds left
    this.shellLoad = 0;
    this.pumpT = 0;
    this.switchT = 0;
    this.pendingSwitch = null;
    this.flashT = 0;
    this.swayX = 0; this.swayY = 0;
    this.triggerHeld = false;
    this.lastTrigger = false;
    this.kickRoll = 0;
  }

  get def() { return DEFS[this.current]; }
  get ammo() { return this.state[this.current]; }

  switchTo(name) {
    if (name === this.current || this.pendingSwitch) return;
    this.reloading = 0;
    this.shellLoad = 0;
    this.pendingSwitch = name;
    this.switchT = 0.5;
  }

  reload() {
    const a = this.ammo, d = this.def;
    if (this.reloading || this.shellLoad || a.mag >= d.mag || a.reserve <= 0 || this.switchT > 0) return;
    if (this.current === 'rifle') {
      this.reloading = d.reload;
      this.game.audio.play('reload', { volume: 0.8 });
    } else {
      this.shellLoad = d.shellTime;
    }
  }

  onMouse(dx, dy) {
    this.swayX = THREE.MathUtils.clamp(this.swayX + dx * 0.0004, -0.04, 0.04);
    this.swayY = THREE.MathUtils.clamp(this.swayY + dy * 0.0004, -0.04, 0.04);
  }

  update(dt, input) {
    const g = this.game, P = g.player, d = this.def, a = this.ammo;
    this.cool -= dt;
    this.kick = Math.max(0, this.kick - dt * 9);
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.flashLight.intensity = this.flashT > 0 ? 8 : 0;
    this.boltT = Math.max(0, (this.boltT || 0) - dt);
    this.pumpT = Math.max(0, this.pumpT - dt);
    this.swayX *= Math.exp(-dt * 8);
    this.swayY *= Math.exp(-dt * 8);

    if (this.switchT > 0) {
      this.switchT -= dt;
      if (this.pendingSwitch && this.switchT < 0.25) {
        this.models[this.current].visible = false;
        this.current = this.pendingSwitch;
        this.models[this.current].visible = true;
        this.pendingSwitch = null;
        g.audio.play('pump', { volume: 0.4, rate: 1.3 });
      }
    }
    if (this.reloading > 0) {
      this.reloading -= dt;
      const m = this.models.rifle.userData.mag;
      const k = 1 - this.reloading / d.reload;
      m.visible = !(k > 0.3 && k < 0.6);
      if (this.reloading <= 0) {
        this.reloading = 0;
        const take = Math.min(d.mag - a.mag, a.reserve);
        a.mag += take; a.reserve -= take;
      }
    }
    if (this.shellLoad > 0) {
      this.shellLoad -= dt;
      if (this.shellLoad <= 0) {
        if (a.reserve > 0 && a.mag < d.mag) {
          a.mag++; a.reserve--;
          g.audio.play('shell', { volume: 0.9 });
        }
        this.shellLoad = a.mag < d.mag && a.reserve > 0 ? d.shellTime : 0;
        if (!this.shellLoad) { this.pumpT = 0.4; g.audio.play('pump'); }
      }
    }

    const busy = this.reloading > 0 || this.switchT > 0 || !P.alive;
    this.aiming = !!(input.rmb || input.keys.ShiftLeft || input.keys.ShiftRight) && !busy && !P.sprinting;
    this.ads += ((this.aiming ? 1 : 0) - this.ads) * (1 - Math.exp(-14 * dt));

    const trig = !!input.lmb;
    if (trig && !busy && !P.sprinting && P.alive) {
      if (this.shellLoad > 0 && a.mag > 0) this.shellLoad = 0; // interrupt shell loading
      const can = this.cool <= 0 && this.pumpT <= 0 && this.shellLoad <= 0 && (d.auto || !this.lastTrigger);
      if (can) {
        if (a.mag <= 0) {
          if (!this.lastTrigger) g.audio.play('empty');
          this.cool = 0.25;
          this.reload();
        } else this.fire();
      }
    }
    this.lastTrigger = trig;

    // ------------------------------------------------- pose the viewmodel
    const m = this.models[this.current];
    const hip = new THREE.Vector3(0.1, -0.1, -0.3);
    const adsPos = new THREE.Vector3(0, 0, d.adsZ);
    const pos = hip.lerp(adsPos, this.ads);
    const rot = new THREE.Euler(0, 0.05 * (1 - this.ads), 0);
    const moving = Math.min(P.speed / 3, 1.5) * (1 - this.ads * 0.85);
    pos.x += Math.sin(P.bob) * 0.012 * moving;
    pos.y += -Math.abs(Math.cos(P.bob)) * 0.012 * moving;
    pos.x -= this.swayX * (1 - this.ads * 0.8);
    pos.y += this.swayY * (1 - this.ads * 0.8);
    // sharp kick back and up, with a little roll
    const kk = this.kick * this.kick;
    pos.z += kk * (this.current === 'shotgun' ? 0.09 : 0.055);
    pos.y += kk * 0.012;
    rot.x += kk * (this.current === 'shotgun' ? 0.22 : 0.11);
    rot.z += kk * this.kickRoll;
    if (P.sprinting) { pos.add(new THREE.Vector3(-0.02, -0.06, 0.03)); rot.y += 0.7; rot.x -= 0.25; }
    if (this.reloading > 0) {
      const k = 1 - this.reloading / d.reload;
      const w = Math.sin(Math.PI * k);
      pos.y -= 0.06 * w; rot.x += 0.35 * w; rot.z += 0.6 * w;
    }
    if (this.shellLoad > 0) { pos.y -= 0.03; rot.z += 0.35; rot.x += 0.12 + Math.sin(this.shellLoad / d.shellTime * Math.PI) * 0.06; }
    if (this.switchT > 0) { const w = Math.sin(Math.PI * (1 - this.switchT / 0.5)); pos.y -= 0.25 * w; rot.x -= 0.6 * w; }
    if (!P.alive) { pos.y -= 0.4; }
    this.holder.position.copy(pos);
    this.holder.rotation.copy(rot);
    if (this.current === 'shotgun') {
      const pp = this.pumpT > 0 && this.pumpT < 0.4 ? Math.sin(Math.PI * (1 - this.pumpT / 0.4)) : 0;
      m.userData.pump.position.z = -0.3 + pp * 0.09;
    }
    if (m.userData.bolt) m.userData.bolt.position.z = 0.05 + Math.sin(Math.min(1, this.boltT / 0.08) * Math.PI) * 0.03;
    const mz = m.userData.muzzle;
    this.flash.position.set(mz.x, mz.y, mz.z - 0.03);
    this.flash.children[0].rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flashLight.position.set(pos.x + mz.x, pos.y + mz.y, pos.z + mz.z);

    // fov zoom
    const fov = THREE.MathUtils.lerp(75, d.fov, this.ads);
    if (Math.abs(this.main.fov - fov) > 0.01) {
      this.main.fov = fov;
      this.main.updateProjectionMatrix();
    }
    this.camera.fov = 75 - (75 - fov) * 0.3;
    this.camera.aspect = this.main.aspect;
    this.camera.updateProjectionMatrix();

    for (const s of this.shells) {
      s.v.y -= 9.8 * dt;
      s.m.position.addScaledVector(s.v, dt);
      s.m.rotation.x += 20 * dt; s.m.rotation.z += 13 * dt;
      s.t -= dt;
    }
    this.shells = this.shells.filter((s) => { if (s.t > 0) return true; this.scene.remove(s.m); return false; });
  }

  fire() {
    const g = this.game, P = g.player, d = this.def, a = this.ammo;
    a.mag--;
    this.cool = 60 / d.rpm;
    if (this.current === 'shotgun') this.pumpT = 0.55;
    const moveK = 1 + Math.min(P.speed / 3, 1.5) * (this.ads > 0.5 ? 0.6 : 1.5);
    const spread = THREE.MathUtils.lerp(d.hip, d.ads, this.ads) * moveK * (P.crouched ? 0.75 : 1);
    const cam = this.main;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const dirs = [];
    for (let i = 0; i < d.pellets; i++) {
      const r = spread * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
      dirs.push(fwd.clone().addScaledVector(right, Math.cos(th) * r).addScaledVector(up, Math.sin(th) * r).normalize());
    }
    g.playerShot(origin, dirs, d);
    const rk = d.recoil * (1 - this.ads * 0.35) * (P.crouched ? 0.8 : 1);
    P.kickRecoil(rk, (Math.random() - 0.5) * rk * 0.8);
    P.shake = Math.min(1, P.shake + (this.current === 'shotgun' ? 0.35 : 0.2));
    this.kick = 1;
    this.kickRoll = (Math.random() - 0.5) * 0.08;
    this.boltT = 0.08;
    this.flashT = 0.05;
    g.audio.gunshot(d.sound);
    const mzw = this.main.localToWorld(new THREE.Vector3(0.1, -0.12, -0.7));
    g.gore.smoke(mzw, this.current === 'shotgun' ? 3 : 2);
    if (this.current === 'shotgun') setTimeout(() => g.audio.play('pump', { volume: 0.8 }), 230);
    this.ejectShell();
  }

  ejectShell() {
    const sg = this.current === 'shotgun';
    const m = new THREE.Mesh(new THREE.CylinderGeometry(sg ? 0.009 : 0.004, sg ? 0.009 : 0.004, sg ? 0.05 : 0.022, 8), sg ? this.redShellMat : this.shellMat);
    m.position.copy(this.holder.position).add(new THREE.Vector3(0.02, -0.04, 0.02));
    this.scene.add(m);
    this.shells.push({ m, v: new THREE.Vector3(0.9 + Math.random() * 0.4, 0.9 + Math.random() * 0.5, 0.2), t: 0.7 });
  }

  render(renderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
