import * as THREE from 'three';
import { buildLevel, SPAWNS, ROOM_NAMES } from './level.js';
import { FPSPlayer } from './player.js';
import { Weapons } from './weapons.js';
import { Enemy } from './enemy.js';
import { Hostage } from './hostage.js';
import { Gore } from './gore.js';
import { Audio } from './audio.js';
import { HUD } from './hud.js';

const TEST = new URLSearchParams(location.search).has('test'); // headless test mode
const TITLE = 'BLACK HOUSE';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: TEST });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.03, 120);
scene.add(camera);

const game = {
  scene, camera, renderer,
  state: 'menu',
  stats: { shots: 0, hits: 0, kills: 0, headshots: 0, dismember: 0, time: 0 },
  enemies: [],
  hostages: [],
  input: { keys: {}, lmb: false, rmb: false },
};
window.__game = game;

game.audio = new Audio();
game.hud = new HUD();
game.level = buildLevel(scene, renderer);
game.gore = new Gore(scene, game.level);
game.player = new FPSPlayer(game, camera, SPAWNS.player);
game.weapons = new Weapons(game, camera);
game.exit = new THREE.Vector3(SPAWNS.exit.x, 0, SPAWNS.exit.z);
for (const s of SPAWNS.enemies) game.enemies.push(new Enemy(game, s));
for (const s of SPAWNS.hostages) game.hostages.push(new Hostage(game, s));

// ------------------------------------------------------------------ helpers
const ray = new THREE.Raycaster();
game.lineOfSight = (a, b) => {
  const dir = b.clone().sub(a);
  const dist = dir.length();
  ray.set(a, dir.divideScalar(dist));
  ray.far = dist - 0.05;
  return ray.intersectObjects(game.level.occluders, false).length === 0;
};
game.audio.occlusion = (pos) => {
  const p = pos.y < 0.2 ? new THREE.Vector3(pos.x, 1.2, pos.z) : pos;
  return !game.lineOfSight(camera.position, p);
};
game.suspectsLeft = () => game.enemies.filter((e) => !e.dead).length;
game.roomName = () => ROOM_NAMES[game.level.roomAt(game.player.pos.x, game.player.pos.z)] || '';

const actorOf = new Map();
for (const a of [...game.enemies, ...game.hostages]) actorOf.set(a.body, a);
const targets = () => {
  const list = [...game.level.occluders];
  for (const a of actorOf.values()) if (a.root.visible) list.push(...a.body.hitMeshes);
  return list;
};

// Player bullets. dirs: one per pellet.
game.playerShot = (origin, dirs, def) => {
  const list = targets();
  let hitAny = false, killed = false;
  game.stats.shots++;
  game.player.firedT = 0;
  for (const dir of dirs) {
    ray.set(origin, dir);
    ray.far = 80;
    const hit = ray.intersectObjects(list, false)[0];
    if (!hit) continue;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : dir.clone().negate();
    if (n.dot(dir) > 0) n.negate();
    const body = hit.object.userData.body;
    if (body) {
      const actor = actorOf.get(body);
      const wasDead = actor.dead;
      const dist = hit.distance;
      const falloff = def.pellets > 1 ? THREE.MathUtils.clamp(1.3 - dist / 14, 0.25, 1.2) : 1;
      actor.takeHit({ mesh: hit.object, point: hit.point, normal: n, dir, damage: def.damage * falloff });
      if (!wasDead && actor.dead) killed = true;
      hitAny = true;
      if (actor instanceof Hostage && !wasDead) game.hud.warn('HOLD YOUR FIRE — HOSTAGE HIT', 2);
    } else {
      if (!hit.object.userData.door) game.gore.bulletHole(hit.point, n);
      else game.gore.dust(hit.point, n);
      game.audio.play('impact', { pos: hit.point, volume: 0.5 });
    }
  }
  if (hitAny) { game.stats.hits++; game.hud.hitmarker(killed); }
  // everyone in earshot comes running
  for (const e of game.enemies) e.hear(game.player.pos, 22);
  flashAt(camera.localToWorld(new THREE.Vector3(0.1, -0.1, -0.6)), 0);
};

// world-space muzzle flash lights (fixed count so shaders don't recompile)
const flashes = [0, 1].map(() => {
  const l = new THREE.PointLight(0xffb060, 0, 9, 2);
  scene.add(l);
  return { l, t: 0 };
});
function flashAt(pos, i) {
  const f = flashes[i];
  f.l.position.copy(pos);
  f.t = 0.05;
}

// enemy tracers
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
const tracers = [];
function tracer(a, b) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const l = new THREE.Line(geo, tracerMat);
  scene.add(l);
  tracers.push({ l, t: 0.06 });
}

game.enemyShoot = (enemy, target, hostage) => {
  const gun = enemy.body.gun;
  if (!gun) return;
  const muzzle = gun.userData.muzzle.getWorldPosition(new THREE.Vector3());
  game.audio.play('rifle', { pos: muzzle, volume: 0.9, rate: 0.92 + Math.random() * 0.1 });
  flashAt(muzzle, 1);
  for (const e of game.enemies) if (e !== enemy) e.hear(game.player.pos, 14);
  if (hostage) {
    const head = hostage.body.hitMeshes.find((m) => m.userData.part === 'head');
    const dir = target.clone().sub(muzzle).normalize();
    if (head) hostage.takeHit({ mesh: head, point: target, normal: dir.clone().negate(), dir, damage: 80 });
    tracer(muzzle, target);
    return;
  }
  const P = game.player;
  const d = muzzle.distanceTo(target);
  let chance = 0.5 - d * 0.022 - Math.min(P.speed, 5) * 0.05 + Math.min(enemy.reactT - enemy.reaction, 1.5) * 0.1;
  if (P.crouched) chance *= 0.8;
  if (enemy.limp || enemy.bleed > 3) chance *= 0.7;
  chance = THREE.MathUtils.clamp(chance, 0.06, 0.85);
  const clear = game.lineOfSight(muzzle, target);
  if (clear && Math.random() < chance) {
    P.damage(13 + Math.random() * 11, enemy.pos);
    tracer(muzzle, target.clone().add(new THREE.Vector3(0, 0.1, 0)));
  } else {
    const dir = target.clone().sub(muzzle).normalize();
    dir.x += (Math.random() - 0.5) * 0.12; dir.y += (Math.random() - 0.5) * 0.08; dir.z += (Math.random() - 0.5) * 0.12;
    dir.normalize();
    ray.set(muzzle, dir);
    ray.far = 60;
    const hit = ray.intersectObjects(game.level.occluders, false)[0];
    const end = hit ? hit.point : muzzle.clone().addScaledVector(dir, 40);
    if (hit && !hit.object.userData.door) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      game.gore.bulletHole(hit.point, n);
      game.audio.play('impact', { pos: hit.point, volume: 0.8 });
    }
    tracer(muzzle, end);
  }
};

game.damagePlayer = (amount, from, kind) => {
  game.player.damage(amount, from);
  game.audio.play(kind === 'knife' ? 'flesh' : 'thud', { volume: 0.8 });
};

game.onSuspectDown = (e) => {
  game.hud.feed(e.lastHit?.organ === 'brain' ? 'SUSPECT DOWN · HEADSHOT' : 'SUSPECT DOWN');
  checkEnd();
};
game.onHostageRescued = () => { game.hud.feed('HOSTAGE SECURED'); checkEnd(); };
game.onHostageKilled = () => { game.hud.warn('HOSTAGE KILLED', 3); game.hud.feed('<span style="color:#e33">HOSTAGE KIA</span>'); checkEnd(); };
game.onPlayerDeath = () => {
  game.state = 'dead';
  setTimeout(() => endScreen(false), 2200);
};

let ended = false;
function checkEnd() {
  if (ended) return;
  if (game.suspectsLeft() === 0 && !game.hostages.some((h) => h.captive)) {
    ended = true;
    game.hud.warn('HOUSE CLEAR', 3);
    setTimeout(() => endScreen(true), 3000);
  }
}

function endScreen(survived) {
  game.state = 'over';
  document.exitPointerLock?.();
  const s = game.stats;
  const saved = game.hostages.filter((h) => h.state === 'leaving' || h.state === 'safe').length;
  const lost = game.hostages.filter((h) => h.dead).length;
  const acc = s.shots ? Math.round(s.hits / s.shots * 100) : 0;
  const mm = Math.floor(s.time / 60), ss = String(Math.floor(s.time % 60)).padStart(2, '0');
  let score = s.kills * 100 + s.headshots * 50 + saved * 500 - lost * 600 + acc * 5 + Math.max(0, 300 - s.time) * 2;
  if (!survived) score = Math.min(score, 0);
  const rank = !survived ? 'F' : lost ? 'D' : score > 2600 ? 'S' : score > 2100 ? 'A' : score > 1500 ? 'B' : 'C';
  const title = !survived ? 'YOU DIED' : lost ? 'MISSION FAILED' : 'MISSION COMPLETE';
  game.hud.show(`
    <h1 style="font-size:44px">${title}</h1>
    <h2>${survived ? 'The house is quiet now.' : 'They got you.'}</h2>
    <div class="rank">${rank}</div>
    <table>
      <tr><td>Time</td><td>${mm}:${ss}</td></tr>
      <tr><td>Hostages saved</td><td>${saved} / ${game.hostages.length}</td></tr>
      <tr><td>Hostages killed</td><td>${lost}</td></tr>
      <tr><td>Suspects down</td><td>${s.kills} / ${game.enemies.length}</td></tr>
      <tr><td>Headshots</td><td>${s.headshots}</td></tr>
      <tr><td>Dismemberments</td><td>${s.dismember}</td></tr>
      <tr><td>Accuracy</td><td>${acc}%</td></tr>
      <tr><td>Score</td><td>${Math.round(score)}</td></tr>
    </table>
    <div class="go">CLICK TO RAID AGAIN</div>`, () => location.reload());
}

// -------------------------------------------------------------------- input
const dom = renderer.domElement;
const I = game.input;
window.addEventListener('keydown', (e) => {
  I.keys[e.code] = true;
  if (e.code === 'Escape' && noLock && game.state === 'play') pause();
  if (game.state !== 'play') return;
  const W = game.weapons, P = game.player;
  if (e.code === 'KeyR') W.reload();
  if (e.code === 'Digit1') W.switchTo('rifle');
  if (e.code === 'Digit2') W.switchTo('shotgun');
  if (e.code === 'KeyF') P.toggleFlashlight();
  if (e.code === 'KeyV') kick();
  if (e.code === 'KeyE') interactPress();
});
window.addEventListener('keyup', (e) => { I.keys[e.code] = false; });
window.addEventListener('mousedown', (e) => {
  if (game.state !== 'play') return;
  if (e.button === 0) I.lmb = true;
  if (e.button === 2) I.rmb = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) I.lmb = false;
  if (e.button === 2) I.rmb = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => {
  if (game.state === 'play') game.weapons.switchTo(game.weapons.current === 'rifle' ? 'shotgun' : 'rifle');
}, { passive: true });
window.addEventListener('mousemove', (e) => {
  // without pointer lock (some embedded frames refuse it) the free mouse still steers
  if (game.state !== 'play' || (document.pointerLockElement !== dom && !noLock)) return;
  const sens = 0.0022 * (1 - game.weapons.ads * 0.35);
  game.player.look(e.movementX, e.movementY, sens);
  game.weapons.onMouse(e.movementX, e.movementY);
});
let noLock = false;
document.addEventListener('pointerlockerror', () => { noLock = true; });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === dom) noLock = false;
  else if (game.state === 'play' && !noLock) pause();
});

function frontOf(maxDist, cos = 0.6) {
  const P = game.player;
  const f = P.forward(new THREE.Vector3()); f.y = 0; f.normalize();
  const ok = (p) => {
    const d = new THREE.Vector3(p.x - P.pos.x, 0, p.z - P.pos.z);
    const dist = d.length();
    return dist < maxDist && (dist < 0.5 || d.normalize().dot(f) > cos) ? dist : Infinity;
  };
  return ok;
}

function nearestDoor(maxDist) {
  const ok = frontOf(maxDist);
  let best = null, bd = Infinity;
  for (const d of game.level.doors) { const v = ok(d.center); if (v < bd) { bd = v; best = d; } }
  return best;
}
function nearestHostage() {
  const ok = frontOf(1.7, 0.4);
  let best = null, bd = Infinity;
  for (const h of game.hostages) if (h.captive) { const v = ok(h.pos); if (v < bd) { bd = v; best = h; } }
  return best;
}

let freeing = null;
function interactPress() {
  if (nearestHostage()) return; // handled as a hold in update
  const d = nearestDoor(1.7);
  if (d) {
    d.toggle(game.player.pos);
    game.audio.play('door', { pos: d.center, volume: 0.5 });
    for (const e of game.enemies) e.hear(d.center, 4);
  }
}

function kick() {
  const P = game.player;
  const d = nearestDoor(1.5);
  P.shake = Math.max(P.shake, 0.3);
  if (d) {
    d.open(P.pos, true);
    game.audio.play('kick', { pos: d.center });
    for (const e of game.enemies) e.hear(d.center, 14);
    return;
  }
  const ok = frontOf(1.4, 0.5);
  for (const e of game.enemies) {
    if (e.dead || ok(e.pos) === Infinity) continue;
    game.audio.play('kick', { pos: e.pos, volume: 0.6, rate: 1.3 });
    const dir = new THREE.Vector3(e.pos.x - P.pos.x, 0, e.pos.z - P.pos.z).normalize();
    e.pos.addScaledVector(dir, 0.5);
    e.stagger = 1.2; e.flinch = 1;
    e.hp -= 8;
    if (e.state !== 'combat') { e.aware = 1; e.engage(); }
    return;
  }
  game.audio.play('step', { volume: 0.4 });
}

// ------------------------------------------------------------------- states
function menu() {
  game.hud.show(`
    <h1>${TITLE}</h1>
    <h2>SOLO RAID · 2 HOSTAGES · UNKNOWN SUSPECTS</h2>
    <p>Dispatch lost contact with the family at 1147 Alder Road four hours ago.<br>
    Neighbours report chanting. Nobody's come out. You're the only unit on scene.</p>
    <p style="opacity:.65">
      <kbd>WASD</kbd> move · <kbd>Q</kbd> sprint · <kbd>C</kbd> crouch · <kbd>LMB</kbd> fire · <kbd>Shift</kbd> aim<br>
      <kbd>R</kbd> reload · <kbd>1</kbd>/<kbd>2</kbd> rifle / shotgun · <kbd>F</kbd> flashlight<br>
      <kbd>E</kbd> open doors · hold <kbd>E</kbd> free hostages · <kbd>V</kbd> kick</p>
    <div class="go">CLICK TO BREACH</div>`, start);
}
function start() {
  game.audio.start();
  game.hud.hide();
  game.state = 'play';
  try {
    const r = dom.requestPointerLock?.();
    if (r?.catch) r.catch(() => { noLock = true; });
    else if (!dom.requestPointerLock) noLock = true;
  } catch { noLock = true; }
}
function pause() {
  game.state = 'paused';
  I.lmb = I.rmb = false;
  game.hud.show(`<h1 style="font-size:40px">PAUSED</h1><div class="go">CLICK TO RESUME</div>`, start);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --------------------------------------------------------------------- loop
const clock = new THREE.Clock();
let t = 0;
let heartT = 0;

function step(dt) {
  t += dt;
  const live = game.state === 'play' || game.state === 'dead';
  if (live) {
    if (game.state === 'play') game.stats.time += dt;
    game.player.update(dt, I);
    game.weapons.update(dt, I);
    for (const e of game.enemies) e.update(dt, t);
    for (const h of game.hostages) h.update(dt, t);

    // hold E to free a hostage
    const h = game.state === 'play' ? nearestHostage() : null;
    if (h && I.keys.KeyE) {
      if (freeing !== h) { freeing = h; h.free = 0; }
      h.free += dt / 1.3;
      game.hud.prompt('CUTTING RESTRAINTS…', Math.min(1, h.free));
      if (h.free >= 1) { h.rescue(); freeing = null; }
    } else {
      if (freeing) freeing.free = 0;
      freeing = null;
      const d = game.state === 'play' ? nearestDoor(1.7) : null;
      game.hud.prompt(h ? 'Hold <kbd>E</kbd> to free hostage' : d ? `<kbd>E</kbd> ${d.isOpen ? 'close' : 'open'} door · <kbd>V</kbd> kick` : '');
    }
    if (game.player.hp < 35 && game.player.alive) {
      heartT -= dt;
      if (heartT <= 0) { heartT = 0.85; game.audio.play('heartbeat', { volume: 0.9 }); }
    }
    renderer.domElement.style.filter = game.player.hp < 35 ? `saturate(${0.3 + game.player.hp / 50})` : '';
  }
  game.level.update(dt, t);
  game.gore.update(dt);
  for (const f of flashes) { f.t -= dt; f.l.intensity = f.t > 0 ? 9 : 0; }
  for (const tr of tracers) tr.t -= dt;
  for (let i = tracers.length - 1; i >= 0; i--) {
    if (tracers[i].t <= 0) { scene.remove(tracers[i].l); tracers[i].l.geometry.dispose(); tracers.splice(i, 1); }
  }
  game.hud.update(dt, game);
  game.audio.setListener(camera);
}

function render() {
  renderer.clear();
  renderer.render(scene, camera);
  game.weapons.render(renderer);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  step(dt);
  render();
  requestAnimationFrame(frame);
}

if (TEST) {
  // deterministic stepping for headless screenshots
  window.THREE = THREE;
  game.test = {
    start: () => { game.hud.hide(); game.state = 'play'; },
    step: (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) step(dt); render(); return renderer.domElement.toDataURL('image/jpeg', 0.85); },
  };
  game.player.update(0, I);
  render();
  window.__ready = true;
} else {
  menu();
  game.player.update(0, I);
  frame();
}
