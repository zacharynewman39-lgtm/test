import * as THREE from 'three';
import { flashTexture } from './textures.js';

export const DEFS = {
  rifle: {
    name: 'M4 Carbine', mag: 30, reserve: 150, rpm: 750, auto: true, damage: 34, pellets: 1,
    hip: 0.035, ads: 0.003, recoil: 0.014, reload: 2.1, sound: 'rifle', fov: 52, adsZ: -0.19,
  },
  shotgun: {
    name: 'M870 Shotgun', mag: 6, reserve: 36, rpm: 75, auto: false, damage: 17, pellets: 10,
    hip: 0.07, ads: 0.05, recoil: 0.055, shellTime: 0.48, sound: 'shotgun', fov: 60, adsZ: -0.24,
  },
};

const black = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, metalness: 0.6, roughness: 0.42 });
const poly = new THREE.MeshStandardMaterial({ color: 0x252525, roughness: 0.8 });
const wood = new THREE.MeshStandardMaterial({ color: 0x4a2c18, roughness: 0.55 });
const glove = new THREE.MeshStandardMaterial({ color: 0x2a2a28, roughness: 0.9 });
const sleeve = new THREE.MeshStandardMaterial({ color: 0x1f242c, roughness: 0.95 });

function part(g, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  g.add(m);
  return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r, l, s = 12) => new THREE.CylinderGeometry(r, r, l, s).rotateX(Math.PI / 2);

function arms(g, rightGrip, leftGrip) {
  part(g, box(0.05, 0.09, 0.1), glove, rightGrip.x, rightGrip.y, rightGrip.z, -0.3);
  part(g, box(0.07, 0.075, 0.4), sleeve, rightGrip.x + 0.07, rightGrip.y - 0.1, rightGrip.z + 0.2, 0.45, 0.3);
  part(g, box(0.055, 0.05, 0.11), glove, leftGrip.x, leftGrip.y, leftGrip.z);
  part(g, box(0.065, 0.07, 0.45), sleeve, leftGrip.x - 0.1, leftGrip.y - 0.08, leftGrip.z + 0.2, 0.35, -0.45);
}

// Viewmodels point down -z with the sight line on the local origin.
function buildRifle() {
  const g = new THREE.Group();
  part(g, new THREE.TorusGeometry(0.016, 0.0032, 8, 24), black, 0, 0, 0);
  part(g, box(0.022, 0.012, 0.04), black, 0, -0.022, 0);
  part(g, new THREE.SphereGeometry(0.0013, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2020 }), 0, 0, -0.004);
  part(g, box(0.036, 0.03, 0.3), black, 0, -0.043, 0.02);
  part(g, box(0.03, 0.04, 0.16), black, 0, -0.077, 0.04);
  part(g, box(0.044, 0.046, 0.2), poly, 0, -0.05, -0.2);
  part(g, cyl(0.008, 0.18), black, 0, -0.05, -0.38);
  part(g, cyl(0.011, 0.05), black, 0, -0.05, -0.48);
  const mag = part(g, box(0.026, 0.11, 0.05), poly, 0, -0.14, 0.0, 0.18);
  part(g, box(0.026, 0.08, 0.035), poly, 0, -0.12, 0.1, -0.3);
  part(g, box(0.032, 0.05, 0.2), poly, 0, -0.06, 0.28);
  part(g, cyl(0.012, 0.09), black, 0.032, -0.05, -0.24);
  arms(g, new THREE.Vector3(0.006, -0.125, 0.1), new THREE.Vector3(0, -0.085, -0.22));
  g.userData.mag = mag;
  g.userData.muzzle = new THREE.Vector3(0, -0.05, -0.52);
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
    this.scene.add(new THREE.HemisphereLight(0x8090a0, 0x201810, 0.6));
    const key = new THREE.DirectionalLight(0xfff0dd, 0.6);
    key.position.set(0.5, 1, 0.4);
    this.scene.add(key);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 2, 2);
    this.flashLight.position.set(0, -0.05, -0.6);
    this.scene.add(this.flashLight);

    this.models = { rifle: buildRifle(), shotgun: buildShotgun() };
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    for (const m of Object.values(this.models)) { m.visible = false; this.holder.add(m); }
    const flashMat = new THREE.MeshBasicMaterial({ map: flashTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
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
    this.flashLight.intensity = this.flashT > 0 ? 3 : 0;
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
    this.aiming = !!input.rmb && !busy && !P.sprinting;
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
    pos.z += this.kick * (this.current === 'shotgun' ? 0.07 : 0.03);
    rot.x += this.kick * (this.current === 'shotgun' ? 0.16 : 0.05);
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
    const mz = m.userData.muzzle;
    this.flash.position.set(mz.x, mz.y, mz.z - 0.03);
    this.flash.rotation.z = Math.random() * Math.PI;
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
    P.kickRecoil(rk, (Math.random() - 0.5) * rk * 0.7);
    this.kick = 1;
    this.flashT = 0.045;
    g.audio.play(d.sound, { volume: 1 });
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
