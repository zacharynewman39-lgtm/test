import * as THREE from 'three';

// All textures are painted procedurally on canvases so the game ships no art yet.

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function noise(g, w, h, amt, rand) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function grime(g, w, h, rand, n, color, maxR) {
  for (let i = 0; i < n; i++) {
    const x = rand() * w, y = rand() * h, r = maxR * (0.2 + rand());
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, color);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

function tex(c, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function wallpaperTexture(base, stripe, seed) {
  const [c, g] = canvas(512);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = stripe;
  for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 20, 512);
  g.globalAlpha = 0.22;
  for (let y = 16; y < 512; y += 64) for (let x = 42; x < 512; x += 64) {
    g.beginPath(); g.ellipse(x, y, 6, 10, 0, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  grime(g, 512, 512, r, 40, 'rgba(40,30,15,0.2)', 90);
  g.strokeStyle = 'rgba(50,38,20,0.28)';
  for (let i = 0; i < 16; i++) {
    const x = r() * 512;
    g.lineWidth = 1 + r() * 3;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (r() - 0.5) * 8, 60 + r() * 320); g.stroke();
  }
  noise(g, 512, 512, 18, r);
  return tex(c);
}

export function plasterTexture(base, seed) {
  const [c, g] = canvas(512);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  grime(g, 512, 512, r, 60, 'rgba(30,25,20,0.22)', 110);
  grime(g, 512, 512, r, 30, 'rgba(255,255,255,0.05)', 70);
  g.strokeStyle = 'rgba(20,15,10,0.35)';
  for (let i = 0; i < 6; i++) { // cracks
    let x = r() * 512, y = r() * 512;
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 12; k++) { x += (r() - 0.5) * 30; y += r() * 18; g.lineTo(x, y); }
    g.stroke();
  }
  noise(g, 512, 512, 22, r);
  return tex(c);
}

export function woodTexture(seed, tone = [92, 62, 38]) {
  const [c, g] = canvas(512);
  const r = rng(seed);
  const plankH = 64;
  for (let y = 0; y < 512; y += plankH) {
    let x = -r() * 300;
    while (x < 512) {
      const len = 180 + r() * 260;
      const k = 0.75 + r() * 0.4;
      g.fillStyle = `rgb(${tone[0] * k | 0},${tone[1] * k | 0},${tone[2] * k | 0})`;
      g.fillRect(x, y, len, plankH);
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let i = 0; i < 9; i++) { // grain
        g.lineWidth = 0.6 + r();
        const gy = y + r() * plankH;
        g.beginPath(); g.moveTo(x, gy);
        g.bezierCurveTo(x + len * 0.3, gy + (r() - 0.5) * 8, x + len * 0.6, gy + (r() - 0.5) * 8, x + len, gy);
        g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(x, y, 2, plankH);
      x += len;
    }
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, y, 512, 2);
  }
  grime(g, 512, 512, r, 30, 'rgba(10,6,3,0.3)', 100);
  noise(g, 512, 512, 14, r);
  return tex(c);
}

export function tileTexture(seed, a = '#b9b4a6', b = '#8f8a7e') {
  const [c, g] = canvas(512);
  const r = rng(seed);
  const n = 8, s = 512 / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    g.fillStyle = (i + j) % 2 ? a : b;
    g.fillRect(i * s, j * s, s, s);
  }
  g.strokeStyle = '#3d3a33';
  g.lineWidth = 3;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(512, i * s); g.stroke();
  }
  grime(g, 512, 512, r, 50, 'rgba(40,30,15,0.3)', 80);
  noise(g, 512, 512, 16, r);
  return tex(c);
}

export function carpetTexture(seed, base = '#4a3530') {
  const [c, g] = canvas(256);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  noise(g, 256, 256, 40, r);
  grime(g, 256, 256, r, 20, 'rgba(10,5,0,0.35)', 60);
  return tex(c);
}

export function concreteTexture(seed, base = '#5d5c58') {
  const [c, g] = canvas(512);
  const r = rng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  grime(g, 512, 512, r, 80, 'rgba(0,0,0,0.18)', 120);
  noise(g, 512, 512, 30, r);
  return tex(c);
}

export function grassTexture(seed) {
  const [c, g] = canvas(512);
  const r = rng(seed);
  g.fillStyle = '#26301c';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const x = r() * 512, y = r() * 512;
    g.strokeStyle = `rgba(${40 + r() * 40 | 0},${55 + r() * 50 | 0},${25 + r() * 20 | 0},0.7)`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 4, y - 3 - r() * 6); g.stroke();
  }
  grime(g, 512, 512, r, 40, 'rgba(40,30,15,0.35)', 90);
  return tex(c);
}

export function sidingTexture(seed) {
  const [c, g] = canvas(512);
  const r = rng(seed);
  g.fillStyle = '#6d6c64';
  g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 32) {
    const gr = g.createLinearGradient(0, y, 0, y + 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.35)');
    gr.addColorStop(0.15, 'rgba(255,255,255,0.06)');
    gr.addColorStop(1, 'rgba(0,0,0,0.05)');
    g.fillStyle = gr;
    g.fillRect(0, y, 512, 32);
  }
  grime(g, 512, 512, r, 50, 'rgba(20,25,10,0.3)', 90);
  noise(g, 512, 512, 16, r);
  return tex(c);
}

// Blood writing scrawled on the ritual-room wall.
export function scrawlTexture(text) {
  const [c, g] = canvas(1024, 256);
  const r = rng(99);
  g.clearRect(0, 0, 1024, 256);
  g.font = 'bold 150px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(120,8,6,0.92)';
  g.save();
  g.translate(512, 120);
  g.rotate(-0.03);
  g.fillText(text, 0, 0);
  g.restore();
  for (let i = 0; i < 40; i++) { // drips
    const x = 80 + r() * 860, y = 110 + r() * 50, len = 20 + r() * 110;
    g.fillRect(x, y, 3 + r() * 4, len);
    g.beginPath(); g.arc(x + 3, y + len, 4, 0, Math.PI * 2); g.fill();
  }
  return tex(c, false);
}

export function pentagramTexture() {
  const [c, g] = canvas(512);
  g.clearRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(110,6,4,0.9)';
  g.lineWidth = 9;
  g.beginPath(); g.arc(256, 256, 230, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 6;
  g.beginPath(); g.arc(256, 256, 200, 0, Math.PI * 2); g.stroke();
  g.beginPath();
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 4 / 5);
    const x = 256 + Math.cos(a) * 200, y = 256 + Math.sin(a) * 200;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.lineWidth = 8;
  g.stroke();
  return tex(c, false);
}

// White-on-transparent masks; the material tints them.
export function splatTexture(seed, kind) {
  const [c, g] = canvas(256);
  const r = rng(seed);
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  const blob = (x, y, rad) => { g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); };
  if (kind === 'pool') {
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, d = r() * 55;
      blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 28 + r() * 40);
    }
  } else if (kind === 'drop') {
    blob(128, 128, 60);
    for (let i = 0; i < 10; i++) {
      const a = r() * Math.PI * 2, d = 60 + r() * 50;
      blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 4 + r() * 10);
    }
  } else { // splat: core + spikes + satellite droplets
    for (let i = 0; i < 10; i++) blob(128 + (r() - 0.5) * 50, 128 + (r() - 0.5) * 50, 18 + r() * 26);
    for (let i = 0; i < 22; i++) {
      const a = r() * Math.PI * 2, len = 40 + r() * 80, w = 3 + r() * 8;
      g.save(); g.translate(128, 128); g.rotate(a);
      g.beginPath(); g.moveTo(0, -w); g.lineTo(len, 0); g.lineTo(0, w); g.fill();
      g.restore();
      blob(128 + Math.cos(a) * (len + 6), 128 + Math.sin(a) * (len + 6), 2 + r() * 6);
    }
    for (let i = 0; i < 30; i++) {
      const a = r() * Math.PI * 2, d = 50 + r() * 70;
      blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 1 + r() * 4);
    }
  }
  // darker, thicker centre via alpha falloff
  const img = g.getImageData(0, 0, 256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    if (img.data[i + 3] > 0) {
      const d = Math.hypot(x - 128, y - 128) / 128;
      const v = 255 * (0.65 + 0.35 * (1 - d));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
  return tex(c, false);
}

export function bulletHoleTexture() {
  const [c, g] = canvas(128);
  const r = rng(5);
  g.clearRect(0, 0, 128, 128);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 50);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(0.18, 'rgba(10,8,6,1)');
  gr.addColorStop(0.3, 'rgba(60,55,50,0.8)');
  gr.addColorStop(1, 'rgba(60,55,50,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(a) * (20 + r() * 30), 64 + Math.sin(a) * (20 + r() * 30)); g.stroke();
  }
  return tex(c, false);
}

export function flashTexture() {
  const [c, g] = canvas(128);
  g.clearRect(0, 0, 128, 128);
  g.translate(64, 64);
  for (let i = 0; i < 7; i++) {
    g.rotate(Math.PI * 2 / 7);
    const gr = g.createLinearGradient(0, 0, 60, 0);
    gr.addColorStop(0, 'rgba(255,240,200,1)');
    gr.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, -7); g.lineTo(60, 0); g.lineTo(0, 7); g.fill();
  }
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, 30);
  gr.addColorStop(0, 'rgba(255,255,230,1)');
  gr.addColorStop(1, 'rgba(255,140,30,0)');
  g.fillStyle = gr;
  g.fillRect(-30, -30, 60, 60);
  return tex(c, false);
}

export function puffTexture() {
  const [c, g] = canvas(64);
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return tex(c, false);
}

// Rewrite a box's UVs so textures tile at `scale` metres per repeat in world space.
export function worldUV(geo, offset, scale = 1) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x, y = pos.getY(i) + offset.y, z = pos.getZ(i) + offset.z;
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    if (nx > 0.5) uv.setXY(i, z / scale, y / scale);
    else if (ny > 0.5) uv.setXY(i, x / scale, z / scale);
    else uv.setXY(i, x / scale, y / scale);
  }
  uv.needsUpdate = true;
  return geo;
}
