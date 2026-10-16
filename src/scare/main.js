import * as THREE from 'three';
import { buildLevel, SPAWNS } from '../game/level.js';
import { FPSPlayer } from '../game/player.js';
import { Audio } from '../game/audio.js';

// Walk the dark house. Something is in it. Don't look at it for too long.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.03, 120);
scene.add(camera);

const IMG = window.__SCARE_IMG || (import.meta.env.BASE_URL + 'scare.jpg');
const game = {
  scene, camera, input: { keys: {} }, enemies: [],
  weapons: { aiming: false }, squad: { noise() {} },
  gore: { wetAt: () => 0, footprint() {} },
  hud: { damage() {} },
  onPlayerDeath() {},
};
game.audio = new Audio();
game.level = buildLevel(scene, renderer);
game.player = new FPSPlayer(game, camera, SPAWNS.player);
const P = game.player;

// --------------------------------------------------------------- the thing
const tex = new THREE.TextureLoader().load(IMG);
tex.colorSpace = THREE.SRGBColorSpace;
const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, side: THREE.DoubleSide });
const cut = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 1.8).translate(0, 0.9, 0), mat);
cut.castShadow = true;
scene.add(cut);
const SPOTS = [[3.5, 9.5], [15.2, 4.6], [14.8, 2.0], [19.6, 3.4], [2.2, 2.6], [20, 9.8], [9.6, 2.2], [7.5, 6.8]];
let spot = -1;
function moveThing() {
  let next;
  do next = Math.floor(Math.random() * SPOTS.length); while (next === spot);
  spot = next;
  cut.position.set(SPOTS[spot][0], 0, SPOTS[spot][1]);
  cut.visible = true;
}
moveThing();

// full-screen scare
const el = document.createElement('div');
el.innerHTML = `<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#000}
  #scare{position:fixed;inset:0;display:none;background:#000 url(${IMG}) center/contain no-repeat;z-index:9;animation:sh .07s infinite}
  @keyframes sh{0%{transform:translate(-14px,9px) scale(1.25)}50%{transform:translate(12px,-10px) scale(1.32)}100%{transform:translate(-8px,-6px) scale(1.28)}}
  #ov{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.85);color:#ddd;font:15px 'Courier New',monospace;text-align:center;cursor:pointer;z-index:10}
  #ov h1{font-size:54px;letter-spacing:8px;color:#a00;margin:0 0 10px}
  #hud{position:fixed;left:20px;top:16px;color:#bbb;font:13px 'Courier New',monospace;letter-spacing:1px;text-shadow:0 1px 3px #000;pointer-events:none}
  kbd{border:1px solid #fff4;padding:0 5px;border-radius:3px}
</style>
<div id="scare"></div><div id="hud"></div>
<div id="ov"><div><h1>DON'T LOOK</h1><p>Something is in the house.<br>Find the way through. Don't stare.</p>
<p style="opacity:.6"><kbd>WASD</kbd> move · <kbd>Space</kbd> run · <kbd>C</kbd> crouch · <kbd>F</kbd> doors · <kbd>T</kbd> flashlight</p><p>CLICK TO ENTER</p></div></div>`;
document.body.appendChild(el);
const scareEl = el.querySelector('#scare'), ov = el.querySelector('#ov'), hud = el.querySelector('#hud');

let playing = false, scares = 0, scareT = 0, stare = 0, cooldown = 3;
ov.onclick = () => {
  game.audio.start();
  ov.style.display = 'none';
  playing = true;
  renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
};
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && playing) { playing = false; ov.style.display = 'grid'; ov.querySelector('p:last-child').textContent = 'CLICK TO KEEP GOING'; }
});
addEventListener('keydown', (e) => {
  game.input.keys[e.code] = true;
  if (!playing) return;
  if (e.code === 'KeyC') P.crouchToggle = !P.crouchToggle;
  if (e.code === 'KeyT') P.toggleFlashlight();
  if (e.code === 'KeyF') {
    let best = null, bd = 1.8;
    for (const d of game.level.doors) { const dd = Math.hypot(d.center.x - P.pos.x, d.center.z - P.pos.z); if (dd < bd) { bd = dd; best = d; } }
    if (best) { best.toggle(P.pos); game.audio.play('door', { pos: best.center, volume: 0.6 }); }
  }
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { game.input.keys[e.code] = false; });
addEventListener('mousemove', (e) => { if (playing && document.pointerLockElement) P.look(e.movementX, e.movementY, 0.0022); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

function jumpscare() {
  scares++;
  scareT = 1.3;
  scareEl.style.display = 'block';
  game.audio.play('scream', { volume: 1.6, rate: 0.75 });
  game.audio.play('kick', { volume: 1.4 });
  game.audio.play('shotgun', { volume: 0.8, rate: 0.5 });
  game.audio.deafen?.(0.6);
  P.shake = 1;
  cut.visible = false;
  cooldown = 6 + Math.random() * 6;
}

const clock = new THREE.Clock();
let t = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  if (playing) P.update(dt, game.input);
  game.level.update(dt, t);
  game.audio.setListener(camera);

  // it always faces you
  cut.rotation.y = Math.atan2(P.pos.x - cut.position.x, P.pos.z - cut.position.z);
  if (scareT > 0) {
    scareT -= dt;
    if (scareT <= 0) { scareEl.style.display = 'none'; }
  } else if (playing) {
    cooldown -= dt;
    if (!cut.visible && cooldown <= 0) moveThing();
    if (cut.visible) {
      const d = Math.hypot(cut.position.x - P.pos.x, cut.position.z - P.pos.z);
      const toIt = cut.position.clone().setY(1.5).sub(camera.position).normalize();
      const looking = camera.getWorldDirection(new THREE.Vector3()).dot(toIt) > 0.8;
      // stare at it from across the room and it comes for you; get close and it's on you
      stare = looking && d < 9 ? stare + dt : Math.max(0, stare - dt);
      if (d < 1.6 || stare > 1.2) { stare = 0; jumpscare(); }
      // it creeps closer when you look away
      else if (!looking && d > 2 && Math.random() < dt * 0.4) {
        cut.position.lerp(new THREE.Vector3(P.pos.x, 0, P.pos.z), 0.25);
        game.level.collide(cut.position, 0.3);
      }
      if (Math.random() < dt * 0.15) game.audio.play('whisper', { pos: cut.position, volume: 0.8 });
    }
  }
  hud.textContent = `SCARED ${scares} TIMES`;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
P.update(0, game.input);
frame();
