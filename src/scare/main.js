import * as THREE from 'three';
import { buildLevel } from '../game/level.js';
import { FPSPlayer } from '../game/player.js';
import { Audio } from '../game/audio.js';

// DON'T LOOK
// Find three photos in the dark house and get out. Something walks the house
// with you. You'll see it at the end of a hall and then it won't be there.
// You'll hear it behind you. Don't turn around too slowly.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.03, 120);
scene.add(camera);

const IMG = window.__SCARE_IMG || (import.meta.env.BASE_URL + 'scare.png');
const game = {
  scene, camera, input: { keys: {} }, enemies: [],
  weapons: { aiming: false }, squad: { noise() {} },
  gore: { wetAt: () => 0, footprint() {} },
  hud: { damage() {} }, onPlayerDeath() {},
};
const A = game.audio = new Audio();
const L = game.level = buildLevel(scene, renderer);
game.player = new FPSPlayer(game, camera, { x: 7.5, z: 10.4, yaw: 0 });
const P = game.player;
scene.traverse((o) => { if (o.isHemisphereLight) o.intensity = 0.28; });
scene.fog.density = 0.05;
for (const d of L.doors) if (d.center.z > 10.9 && d.center.z < 11.1) { d.close(); game.frontDoor = d; }

const ray = new THREE.Raycaster();
const los = (a, b) => {
  const dir = b.clone().sub(a), dist = dir.length();
  ray.set(a, dir.divideScalar(dist)); ray.far = dist - 0.1;
  return ray.intersectObjects(L.occluders, false).length === 0;
};
const view = () => camera.getWorldDirection(new THREE.Vector3());
const lookDot = (p) => view().dot(p.clone().sub(camera.position).normalize());

// ------------------------------------------------------------------ it
const tex = new THREE.TextureLoader().load(IMG);
tex.colorSpace = THREE.SRGBColorSpace;
const itMat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide, transparent: true });
const it = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 1.78).translate(0, 0.89, 0), itMat);
it.castShadow = true;
it.visible = false;
scene.add(it);
const itHead = () => it.position.clone().setY(1.55);

// photos to find
const photoMat = new THREE.MeshStandardMaterial({ color: 0xf2eee0, emissive: 0x332a18, roughness: 0.6 });
const PHOTO_SPOTS = [[2.0, 1.4, 0.56], [14.8, 1.35, 0.52], [19.0, 2.2, 0.92]];
const photos = PHOTO_SPOTS.map(([x, z, y]) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.004, 0.13), photoMat);
  m.position.set(x, y + 0.003, z);
  m.rotation.y = Math.random() * 3;
  scene.add(m);
  return m;
});
let found = 0;

// ------------------------------------------------------------------ sound
function sting(vol = 1, low = false) {
  const ctx = A.ctx; if (!ctx) return;
  const t = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35 * vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
  g.connect(A.master);
  for (const f of (low ? [55, 58, 82, 116] : [220, 233, 311, 466, 622, 659])) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (low ? 0.9 : 0.96), t + 2.4);
    o.connect(g); o.start(t); o.stop(t + 2.7);
  }
}
function heartbeat(rate) { A.play('heartbeat', { volume: 0.9, rate }); }

// --------------------------------------------------------------- overlay
const el = document.createElement('div');
el.innerHTML = `<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#000}
  canvas{display:block}
  #scare{position:fixed;inset:-6%;display:none;background:radial-gradient(circle,#2a0000 0%,#000 70%);z-index:9}
  #scare img{position:absolute;left:50%;top:50%;height:115%;transform:translate(-50%,-50%);filter:contrast(1.6) saturate(.4) brightness(1.25);animation:rush .14s ease-out,sh .05s .14s infinite}
  @keyframes rush{from{transform:translate(-50%,-50%) scale(.15)}to{transform:translate(-50%,-50%) scale(1)}}
  @keyframes sh{0%{transform:translate(-52%,-49%) scale(1.04) rotate(-1deg)}50%{transform:translate(-48%,-51%) scale(1.09) rotate(1.4deg)}100%{transform:translate(-50%,-48%) scale(1.06)}}
  #vig{position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at center,transparent 38%,rgba(0,0,0,.92) 100%);z-index:3}
  #red{position:fixed;inset:0;pointer-events:none;background:#600;mix-blend-mode:multiply;opacity:0;z-index:4}
  #grain{position:fixed;inset:0;pointer-events:none;opacity:.07;z-index:5;width:100%;height:100%}
  #ov{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.9);color:#cfcabc;font:15px 'Courier New',monospace;text-align:center;cursor:pointer;z-index:10}
  #ov h1{font-size:60px;letter-spacing:10px;color:#9a0000;margin:0 0 12px;text-shadow:0 0 20px #400}
  #hud{position:fixed;left:22px;top:18px;color:#b7b2a4;font:13px 'Courier New',monospace;letter-spacing:2px;text-shadow:0 1px 3px #000;pointer-events:none;z-index:6;line-height:1.8}
  #msg{position:fixed;left:50%;top:60%;transform:translateX(-50%);color:#ddd;font:15px 'Courier New',monospace;letter-spacing:2px;text-shadow:0 1px 4px #000;pointer-events:none;z-index:6;transition:opacity .6s}
  #stam{position:fixed;left:50%;bottom:26px;width:160px;height:3px;margin-left:-80px;background:#fff2;z-index:6;pointer-events:none}
  #stam div{height:100%;background:#cfc8b8}
  kbd{border:1px solid #fff4;padding:0 5px;border-radius:3px}
</style>
<canvas id="grain" width="480" height="270"></canvas><div id="vig"></div><div id="red"></div>
<div id="scare"><img alt="" src="${IMG}"></div><div id="hud"></div><div id="msg"></div><div id="stam"><div></div></div>
<div id="ov"><div><h1>DON'T LOOK</h1>
<p>Three photos are somewhere in this house. Find them and get out.<br>You are not alone in here. If you see it, look away.</p>
<p style="opacity:.6"><kbd>WASD</kbd> move · <kbd>Space</kbd> run · <kbd>C</kbd> crouch · <kbd>Q</kbd>/<kbd>E</kbd> lean<br><kbd>F</kbd> doors &amp; pick up · <kbd>T</kbd> flashlight · headphones on</p>
<p id="go">CLICK TO ENTER</p></div></div>`;
document.body.appendChild(el);
const $ = (s) => el.querySelector(s);
const scareEl = $('#scare'), ov = $('#ov'), hud = $('#hud'), msgEl = $('#msg'), red = $('#red');
const grain = $('#grain').getContext('2d');
const gimg = grain.createImageData(480, 270);
let msgT = 0;
const say = (text, t = 3) => { msgEl.textContent = text; msgEl.style.opacity = 1; msgT = t; };

let playing = false, over = false;
ov.onclick = () => {
  if (over) { location.reload(); return; }
  A.start();
  ov.style.display = 'none';
  playing = true;
  try { renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); } catch {}
  if (!started) { started = true; say("It's cold in here.", 3); }
};
let started = false;
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && playing && !over) { playing = false; ov.style.display = 'grid'; $('#go').textContent = 'CLICK TO KEEP GOING'; }
});
addEventListener('keydown', (e) => {
  game.input.keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (!playing) return;
  if (e.code === 'KeyC') P.crouchToggle = !P.crouchToggle;
  if (e.code === 'KeyT') P.toggleFlashlight();
  if (e.code === 'KeyF') interact();
});
addEventListener('keyup', (e) => { game.input.keys[e.code] = false; });
addEventListener('mousemove', (e) => { if (playing && document.pointerLockElement) P.look(e.movementX, e.movementY, 0.0021); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

function interact() {
  for (const ph of photos) {
    if (ph.visible && ph.position.distanceTo(camera.position) < 1.6) {
      ph.visible = false;
      found++;
      A.play('empty', { volume: 0.7, rate: 0.8 });
      say(found < 3 ? `A photo. ${3 - found} left.` : "That's all of them. The front door. Go.", 4);
      dread = Math.min(1, dread + 0.25);
      if (found === 3) { game.frontDoor?.open(P.pos); A.play('door', { pos: game.frontDoor.center }); schedule('behind', 6); }
      else schedule(Math.random() < 0.5 ? 'footsteps' : 'blackout', 4 + Math.random() * 4);
      return;
    }
  }
  let best = null, bd = 1.8;
  for (const d of L.doors) {
    const dd = Math.hypot(d.center.x - P.pos.x, d.center.z - P.pos.z);
    if (dd < bd) { bd = dd; best = d; }
  }
  if (best === game.frontDoor && found < 3) { say("It won't open. Not yet."); A.play('kick', { volume: 0.3, rate: 1.6 }); return; }
  if (best) { best.toggle(P.pos); A.play('door', { pos: best.center, volume: 0.6 }); }
}

// --------------------------------------------------------------- director
// One thing happens at a time; the gaps get shorter the longer you're inside.
let dread = 0, scares = 0, event = null, nextAt = 14, eventT = 0, blackout = 0, torchFail = 0;
let scareT = 0, stamina = 1, beatT = 0;
let pending = null;
function schedule(kind, inS) { pending = { kind, at: clockT + inS }; }

function cellsAround(minD, maxD, filter) {
  const out = [];
  for (let z = 0; z < L.H; z++) for (let x = 0; x < L.W; x++) {
    if (!L.walkable(x, z) || L.room(x, z) === 'o') continue;
    const c = L.cellCenter(x, z);
    const d = Math.hypot(c.x - P.pos.x, c.z - P.pos.z);
    if (d >= minD && d <= maxD && (!filter || filter(c))) out.push(c);
  }
  return out;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function start(kind) {
  event = { kind, t: 0, stare: 0 };
  if (kind === 'glimpse') {
    // at the edge of your vision, down a hall or across a room
    const spots = cellsAround(5, 12, (c) => { const k = lookDot(c.clone().setY(1.5)); return k > 0.25 && k < 0.85 && los(camera.position, c.clone().setY(1.5)); });
    if (!spots.length) return end(6);
    it.position.copy(pick(spots)); it.visible = true;
    A.play('whisper', { pos: it.position, volume: 0.7 });
  } else if (kind === 'doorway') {
    const doors = L.doors.filter((d) => d !== game.frontDoor && d.center.distanceTo(P.pos) > 5 && los(camera.position, d.center.clone().setY(1.5)));
    if (!doors.length) return start('glimpse');
    const d = pick(doors);
    if (!d.isOpen) d.open(P.pos);
    it.position.set(d.center.x, 0, d.center.z); it.visible = true;
    A.play('door', { pos: d.center, volume: 0.9, rate: 0.6 });
  } else if (kind === 'footsteps') {
    // something walks up behind you
    const back = view().setY(0).normalize().negate();
    event.from = P.pos.clone().addScaledVector(back, 7);
    event.steps = 0;
  } else if (kind === 'behind') {
    const back = view().setY(0).normalize().negate();
    const p = P.pos.clone().addScaledVector(back, 1.25);
    if (!L.walkable(Math.floor(p.x), Math.floor(p.z)) || !los(camera.position, p.clone().setY(1.2))) return end(3);
    it.position.copy(p).setY(0); it.visible = true;
    A.play('whisper', { pos: it.position, volume: 1.2, rate: 0.7 });
  } else if (kind === 'blackout') {
    blackout = 1;
    torchFail = 3.2;
    A.play('thud', { volume: 1, rate: 0.5 });
    sting(0.7, true);
  }
}
function end(gap) {
  it.visible = false;
  event = null;
  nextAt = clockT + (gap ?? (16 - dread * 9) * (0.7 + Math.random() * 0.6));
}

function updateEvent(dt) {
  const e = event;
  e.t += dt;
  const d = it.visible ? Math.hypot(it.position.x - P.pos.x, it.position.z - P.pos.z) : 99;
  const looking = it.visible && lookDot(itHead()) > 0.9 && los(camera.position, itHead());
  switch (e.kind) {
    case 'glimpse':
    case 'doorway':
      // look straight at it and it's gone
      if (looking) e.stare += dt;
      if (e.stare > (e.kind === 'doorway' ? 0.5 : 0.18)) { sting(e.kind === 'doorway' ? 0.5 : 0.8); dread = Math.min(1, dread + 0.08); end(); }
      else if (e.t > 6) end();
      else if (d < 2.2) jumpscare();
      break;
    case 'footsteps': {
      // a step every half second, each one closer
      if (e.t > e.steps * (0.62 - dread * 0.2) + 0.5) {
        e.steps++;
        const k = Math.min(1, e.steps / 9);
        const p = e.from.clone().lerp(P.pos, k * 0.85);
        A.play('step', { pos: p, volume: 0.9 + k, rate: 0.75 });
        if (e.steps === 9) {
          // turn around...
          const back = P.pos.clone().sub(view().setY(0).normalize().multiplyScalar(1.2));
          it.position.copy(back).setY(0);
          it.visible = Math.random() < 0.55;
          A.play('whisper', { pos: it.position, volume: 1.3, rate: 0.6 });
        }
      }
      if (e.steps >= 9) {
        if (!it.visible) { if (e.t > e.steps * 0.6 + 3) { say('Nothing there.', 2); end(); } }
        else if (lookDot(itHead()) > 0.45) jumpscare();
        else if (e.t > e.steps * 0.6 + 4) jumpscare();
      }
      break;
    }
    case 'behind':
      if (lookDot(itHead()) > 0.4) jumpscare();
      else if (e.t > 9) end();
      break;
    case 'blackout':
      if (e.t > 3.2 && blackout > 0) {
        // lights come back: it's right there
        blackout = 0;
        const p = P.pos.clone().addScaledVector(view().setY(0).normalize(), 2.4);
        if (L.walkable(Math.floor(p.x), Math.floor(p.z)) && los(camera.position, p.clone().setY(1.4))) { it.position.copy(p).setY(0); it.visible = true; }
        A.play('heartbeat', { volume: 1.2, rate: 1.4 });
      }
      if (e.t > 3.2) {
        if (it.visible && looking) e.stare += dt;
        if (e.stare > 0.35) jumpscare();
        else if (e.t > 5.5) end();
      }
      break;
  }
}

function jumpscare() {
  scares++;
  scareT = 1.15;
  scareEl.style.display = 'block';
  const img = scareEl.querySelector('img');
  img.style.animation = 'none'; void img.offsetWidth; img.style.animation = '';
  A.play('scream', { volume: 1.8, rate: 0.62 });
  A.play('scream', { volume: 1.2, rate: 0.9 });
  A.play('kick', { volume: 1.6, rate: 0.7 });
  A.play('shotgun', { volume: 0.9, rate: 0.45 });
  sting(1.4);
  A.deafen?.(0.8);
  P.shake = 1;
  dread = Math.min(1, dread + 0.12);
  end();
}

// --------------------------------------------------------------- loop
const clock = new THREE.Clock();
let clockT = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (playing) {
    clockT += dt;
    dread = Math.min(1, dread + dt / 400);
    // stamina: you can't run forever, and you'll hear it
    const keys = { ...game.input.keys };
    if (stamina <= 0.02) keys.Space = false;
    const running = keys.Space && keys.KeyW;
    stamina = THREE.MathUtils.clamp(stamina + (running ? -dt / 5 : dt / 9), 0, 1);
    P.update(dt, { keys });
    if (stamina < 0.35 && Math.random() < dt * 1.5) A.play('whisper', { volume: 0.25, rate: 0.5 });

    if (scareT > 0) { scareT -= dt; if (scareT <= 0) scareEl.style.display = 'none'; }
    if (event) updateEvent(dt);
    else if (pending && clockT >= pending.at) { const k = pending.kind; pending = null; start(k); }
    else if (clockT > nextAt) {
      const r = Math.random();
      start(r < 0.32 ? 'glimpse' : r < 0.5 ? 'doorway' : r < 0.72 ? 'footsteps' : r < 0.85 ? 'behind' : 'blackout');
    }
    // heartbeat when it's close or something's coming
    const near = it.visible ? it.position.distanceTo(P.pos) : (event?.kind === 'footsteps' ? 4 : 99);
    beatT -= dt;
    if (near < 8 && beatT <= 0) { heartbeat(1 + (8 - near) / 8); beatT = 0.4 + near * 0.08; }
    // the way out
    if (found === 3 && P.pos.z > 11.6) win();
  }
  L.update(dt, clockT);
  // lights: blackouts kill everything, and the torch isn't reliable
  torchFail = Math.max(0, torchFail - dt);
  for (const Lt of L.lights) {
    if (!Lt.flicker) Lt.light.intensity = Lt.base;
    Lt.light.intensity *= blackout ? 0 : 0.55;
  }
  const flick = torchFail > 0 ? (Math.random() < 0.15 ? 0.4 : 0) : (Math.random() < 0.004 ? 0.1 : 1);
  P.torch.intensity = P.flashlight ? 24 * flick : 0;
  red.style.opacity = scareT > 0 ? 0.55 : Math.min(0.35, dread * 0.25 * (it.visible ? 1 : 0.3));
  msgT -= dt;
  if (msgT <= 0) msgEl.style.opacity = 0;
  hud.innerHTML = `PHOTOS ${found}/3${found === 3 ? '<br>GET OUT' : ''}`;
  $('#stam div').style.width = stamina * 100 + '%';
  $('#stam').style.opacity = stamina < 0.98 ? 1 : 0;
  // it always turns to face you
  it.rotation.y = Math.atan2(P.pos.x - it.position.x, P.pos.z - it.position.z);
  A.setListener(camera);
  // film grain
  if ((clockT * 24 | 0) !== (frame.g | 0)) {
    frame.g = clockT * 24;
    const D = gimg.data;
    for (let i = 0; i < D.length; i += 4) { const v = Math.random() * 255; D[i] = D[i + 1] = D[i + 2] = v; D[i + 3] = 255; }
    grain.putImageData(gimg, 0, 0);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function win() {
  over = true; playing = false;
  document.exitPointerLock?.();
  ov.style.display = 'grid';
  ov.querySelector('div').innerHTML = `<h1>YOU GOT OUT</h1><p>It let you leave this time.</p><p>Scared ${scares} time${scares === 1 ? '' : 's'} · ${Math.floor(clockT / 60)}:${String(Math.floor(clockT % 60)).padStart(2, '0')}</p><p>CLICK TO GO BACK IN</p>`;
}

P.update(0, { keys: {} });
frame();
