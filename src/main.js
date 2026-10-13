import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Player } from './player.js';
import { loadNPC } from './npc.js';

const SHOT = new URLSearchParams(location.search).has('shot'); // headless screenshot mode
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: SHOT });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.02, 600);

// ---------------------------------------------------------------- sky + env
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(35));
const sky = new Sky();
sky.scale.setScalar(1000);
const su = sky.material.uniforms;
su.turbidity.value = 4;
su.rayleigh.value = 1.4;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.8;
su.sunPosition.value.copy(sunDir);
scene.add(sky);

const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new Sky();
envSky.scale.setScalar(1000);
Object.assign(envSky.material.uniforms.sunPosition.value, sunDir);
envSky.material.uniforms.turbidity.value = 4;
envSky.material.uniforms.rayleigh.value = 1.4;
envScene.add(envSky);
const envGround = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x6a6660 }));
envGround.position.y = -1;
envScene.add(envGround);
scene.environment = pmrem.fromScene(envScene, 0.02).texture;
scene.environmentIntensity = 0.55;

// ------------------------------------------------------------------- lights
const sun = new THREE.DirectionalLight(0xfff1e0, 4.0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -5; sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5; sun.shadow.camera.bottom = -5;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 40;
sun.shadow.bias = -0.00015;
sun.shadow.normalBias = 0.012;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

const hemi = new THREE.HemisphereLight(0xbcd3ef, 0x5d5348, 0.4);
scene.add(hemi);

// -------------------------------------------------------------------- ground
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#8d8f88';
  g.fillRect(0, 0, 512, 512);
  const img = g.getImageData(0, 0, 512, 512);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = '#7e807a';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(200, 200);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.95 })
);
ground.receiveShadow = true;
scene.add(ground);
scene.fog = new THREE.Fog(0xb8c6d4, 60, 220);

// ------------------------------------------------------------- player & npc
const player = new Player(camera, renderer.domElement);
scene.add(player.mesh);
player.mesh.position.set(0, 0, 4);
player.yaw = 0;

let npc = null;
loadNPC(renderer).then((n) => {
  npc = n;
  window.__npc = n;
  scene.add(npc.root);
  player.colliders.push({ x: 0, z: 0, r: 0.38 });
  document.getElementById('loading').remove();
  window.__npcReady = true;
}).catch((e) => {
  document.getElementById('loading').textContent = 'Failed to load NPC: ' + e.message;
  console.error(e);
});

// inspect mode: orbit camera around his head
let inspect = false;
const insp = { yaw: 0.35, pitch: 0.05, dist: 0.65, dragging: false };
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && npc) {
    inspect = !inspect;
    player.enabled = !inspect;
    if (inspect && document.pointerLockElement) document.exitPointerLock();
  }
});
renderer.domElement.addEventListener('pointerdown', () => { if (inspect) insp.dragging = true; });
window.addEventListener('pointerup', () => { insp.dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (inspect && insp.dragging) {
    insp.yaw -= e.movementX * 0.005;
    insp.pitch = THREE.MathUtils.clamp(insp.pitch + e.movementY * 0.004, -0.8, 0.9);
  }
});
window.addEventListener('wheel', (e) => {
  if (inspect) insp.dist = THREE.MathUtils.clamp(insp.dist * (1 + e.deltaY * 0.001), 0.25, 3.5);
}, { passive: true });

// debug/screenshot hook
window.__setView = (o) => { Object.assign(insp, o); inspect = true; player.enabled = false; };

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  player.update(dt);
  if (inspect && npc) {
    const focus = insp.bone ? npc.boneWorld(insp.bone, tmp)
      : npc.headWorld(tmp).add(new THREE.Vector3(0, -0.02 - Math.max(0, insp.dist - 0.8) * 0.35, 0));
    camera.position.set(
      focus.x + Math.sin(insp.yaw) * Math.cos(insp.pitch) * insp.dist,
      focus.y + Math.sin(insp.pitch) * insp.dist,
      focus.z + Math.cos(insp.yaw) * Math.cos(insp.pitch) * insp.dist,
    );
    camera.lookAt(focus);
  }
  if (npc) npc.update(dt, t, camera.position, player.mesh.position);

  // keep the shadow frustum around the action
  const c = npc ? npc.root.position.clone().lerp(player.mesh.position, 0.5) : player.mesh.position;
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(sunDir, 20);
  renderer.render(scene, camera);
  if (!SHOT) requestAnimationFrame(frame);
}
if (SHOT) {
  window.__frame = (steps = 1, dt = 1 / 30) => {
    for (let i = 0; i < steps; i++) {
      player.update(dt);
      if (npc) npc.update(dt, (window.__t = (window.__t || 0) + dt), camera.position, player.mesh.position);
    }
    frame();
    return renderer.domElement.toDataURL('image/png');
  };
} else {
  frame();
}
