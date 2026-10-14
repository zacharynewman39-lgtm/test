import * as THREE from 'three';

// Everything is painted procedurally. Each "set" paints colour, height and
// roughness together so surfaces get a proper normal map and varied shine.

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function tex(c, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// ------------------------------------------------------------------ noise
// Tileable fractal value noise, rendered small and scaled up.
const fbmCache = new Map();
export function fbm(seed, period = 8, octaves = 4, size = 256) {
  const key = `${seed}:${period}:${octaves}:${size}`;
  if (fbmCache.has(key)) return fbmCache.get(key);
  const r = rng(seed);
  const lat = [];
  for (let o = 0; o < octaves; o++) {
    const p = period << o;
    lat.push({ p, v: Float32Array.from({ length: p * p }, () => r()) });
  }
  const [c, g] = canvas(size);
  const img = g.createImageData(size, size);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 0.5, tot = 0;
    for (const { p, v: L } of lat) {
      const fx = x / size * p, fy = y / size * p;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = sm(fx - x0), ty = sm(fy - y0);
      const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
      const a = L[y0 * p + x0], b = L[y0 * p + x1], c2 = L[y1 * p + x0], d = L[y1 * p + x1];
      v += amp * ((a + (b - a) * tx) + ((c2 + (d - c2) * tx) - (a + (b - a) * tx)) * ty);
      tot += amp; amp *= 0.5;
    }
    const k = (y * size + x) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = v / tot * 255;
    img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  fbmCache.set(key, c);
  return c;
}

function grain(g, w, h, amt, rand) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function blot(g, x, y, r, color) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function overlay(g, src, w, h, mode, alpha) {
  g.save();
  g.globalCompositeOperation = mode;
  g.globalAlpha = alpha;
  g.drawImage(src, 0, 0, w, h);
  g.restore();
}

export function normalFromHeight(hc, strength = 2) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const [c, g] = canvas(w, h);
  const out = g.createImageData(w, h);
  const d = out.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * strength;
    const ny = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.hypot(nx, ny, 1);
    const k = (y * w + x) * 4;
    d[k] = (nx / l * 0.5 + 0.5) * 255;
    d[k + 1] = (ny / l * 0.5 + 0.5) * 255;
    d[k + 2] = (1 / l * 0.5 + 0.5) * 255;
    d[k + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return tex(c, true, false);
}

// A colour/height/roughness triple painted in lockstep.
function painter(w, h = w) {
  const [cc, c] = canvas(w, h), [hc, hh] = canvas(w, h), [rc, r] = canvas(w, h);
  hh.fillStyle = '#808080'; hh.fillRect(0, 0, w, h);
  return { w, h, c, hh, r, cc, hc, rc };
}
function finish(p, normal = 3) {
  return { map: tex(p.cc), normalMap: normalFromHeight(p.hc, normal), roughnessMap: tex(p.rc, true, false) };
}
const gray = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

// ------------------------------------------------------------------- walls
// Wall textures span 2 m across and the full wall height (UV v = y / wall height),
// so baseboards and crown moulding land in the right place.
const WALL_PX_H = 1024, WALL_H = 2.7;
const yPx = (m) => WALL_PX_H - m / WALL_H * WALL_PX_H;

function trims(p, rand, board = '#8b8475') {
  const { c, hh, r, w } = p;
  // baseboard
  const b0 = yPx(0.15);
  c.fillStyle = board; c.fillRect(0, b0, w, WALL_PX_H - b0);
  c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(0, b0, w, 4);
  const gr = c.createLinearGradient(0, WALL_PX_H - 30, 0, WALL_PX_H);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(10,6,2,0.55)');
  c.fillStyle = gr; c.fillRect(0, WALL_PX_H - 30, w, 30);
  hh.fillStyle = gray(190); hh.fillRect(0, b0, w, WALL_PX_H - b0);
  hh.fillStyle = gray(230); hh.fillRect(0, b0 + 4, w, 8);
  r.fillStyle = gray(110); r.fillRect(0, b0, w, WALL_PX_H - b0);
  // crown
  const t1 = yPx(2.6);
  c.fillStyle = board; c.fillRect(0, 0, w, t1);
  c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(0, t1 - 3, w, 3);
  hh.fillStyle = gray(200); hh.fillRect(0, 0, w, t1);
  r.fillStyle = gray(120); r.fillRect(0, 0, w, t1);
  // scuffs along the baseboard
  for (let i = 0; i < 14; i++) blot(c, rand() * w, b0 + rand() * 40, 10 + rand() * 30, 'rgba(20,15,10,0.25)');
}

function ageWall(p, rand, seed) {
  const { c, w, h } = p;
  overlay(c, fbm(seed, 4, 5), w, h, 'multiply', 0.35);
  // damp creeping up from the floor and down from the ceiling
  let gr = c.createLinearGradient(0, h, 0, h * 0.55);
  gr.addColorStop(0, 'rgba(40,30,15,0.45)'); gr.addColorStop(1, 'rgba(40,30,15,0)');
  c.fillStyle = gr; c.fillRect(0, 0, w, h);
  gr = c.createLinearGradient(0, 0, 0, h * 0.25);
  gr.addColorStop(0, 'rgba(30,25,15,0.35)'); gr.addColorStop(1, 'rgba(30,25,15,0)');
  c.fillStyle = gr; c.fillRect(0, 0, w, h);
  // water streaks
  c.strokeStyle = 'rgba(45,32,15,0.22)';
  for (let i = 0; i < 18; i++) {
    const x = rand() * w;
    c.lineWidth = 1 + rand() * 4;
    c.beginPath(); c.moveTo(x, yPx(2.55)); c.lineTo(x + (rand() - 0.5) * 10, yPx(2.55 - 0.3 - rand() * 1.6)); c.stroke();
  }
  for (let i = 0; i < 7; i++) blot(c, rand() * w, rand() * h, 40 + rand() * 120, 'rgba(50,38,18,0.25)');
}

export function wallpaperSet(base, stripe, seed) {
  const W = 1024, p = painter(W, WALL_PX_H);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, W, WALL_PX_H);
  r.fillStyle = gray(215); r.fillRect(0, 0, W, WALL_PX_H);
  // stripes and damask
  c.fillStyle = stripe;
  hh.fillStyle = gray(140);
  for (let x = 0; x < W; x += 128) { c.fillRect(x, 0, 36, WALL_PX_H); hh.fillRect(x, 0, 36, WALL_PX_H); }
  c.globalAlpha = 0.28; hh.globalAlpha = 0.6;
  for (let y = 20; y < WALL_PX_H; y += 90) for (let x = 82; x < W; x += 128) {
    for (const g of [c, hh]) {
      g.fillStyle = g === c ? stripe : gray(170);
      g.beginPath(); g.ellipse(x, y, 9, 16, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(x - 12, y + 10, 5, 9, -0.6, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(x + 12, y + 10, 5, 9, 0.6, 0, Math.PI * 2); g.fill();
    }
  }
  c.globalAlpha = hh.globalAlpha = 1;
  overlay(hh, fbm(seed + 1, 16, 3), W, WALL_PX_H, 'overlay', 0.25);
  ageWall(p, rand, seed);
  // peeling patches showing plaster underneath
  for (let i = 0; i < 2; i++) {
    const x = rand() * W, y = yPx(0.4 + rand() * 1.8), rw = 12 + rand() * 30, rh = 16 + rand() * 40;
    c.fillStyle = 'rgba(70,62,48,0.45)'; hh.fillStyle = gray(115); r.fillStyle = gray(240);
    for (const g of [c, hh, r]) {
      g.beginPath();
      for (let k = 0; k <= 10; k++) {
        const a = k / 10 * Math.PI * 2, rr = 0.7 + rand() * 0.3;
        const px = x + Math.cos(a) * rw * rr, py = y + Math.sin(a) * rh * rr;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.fill();
    }
  }
  trims(p, rand);
  grain(c, W, WALL_PX_H, 12, rand);
  return finish(p, 2.5);
}

export function plasterSet(base, seed, board = '#6d6559') {
  const W = 1024, p = painter(W, WALL_PX_H);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, W, WALL_PX_H);
  r.fillStyle = gray(230); r.fillRect(0, 0, W, WALL_PX_H);
  overlay(hh, fbm(seed, 12, 4), W, WALL_PX_H, 'source-over', 0.6);
  overlay(c, fbm(seed + 3, 6, 4), W, WALL_PX_H, 'overlay', 0.35);
  ageWall(p, rand, seed);
  hh.strokeStyle = gray(60); c.strokeStyle = 'rgba(20,14,8,0.5)';
  for (let i = 0; i < 9; i++) { // cracks
    let x = rand() * W, y = rand() * WALL_PX_H;
    const pts = [[x, y]];
    for (let k = 0; k < 16; k++) { x += (rand() - 0.5) * 40; y += rand() * 24; pts.push([x, y]); }
    for (const g of [c, hh]) {
      g.lineWidth = g === hh ? 3 : 1.2;
      g.beginPath(); pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
    }
  }
  trims(p, rand, board);
  grain(c, W, WALL_PX_H, 16, rand);
  return finish(p, 3);
}

// tiles up to 1.2 m, plaster above
export function wainscotSet(tileA, upper, seed) {
  const W = 1024, p = painter(W, WALL_PX_H);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = upper; c.fillRect(0, 0, W, WALL_PX_H);
  r.fillStyle = gray(230); r.fillRect(0, 0, W, WALL_PX_H);
  overlay(c, fbm(seed, 6, 4), W, WALL_PX_H, 'overlay', 0.35);
  const top = yPx(1.2);
  const s = 76; // ~15 cm tiles
  for (let y = WALL_PX_H; y > top; y -= s * 0.75) for (let x = 0; x < W; x += s) {
    const k = 0.88 + rand() * 0.18;
    const col = new THREE.Color(tileA).multiplyScalar(k);
    c.fillStyle = '#' + col.getHexString();
    c.fillRect(x + 3, y - s * 0.75 + 3, s - 6, s * 0.75 - 6);
    hh.fillStyle = gray(180); hh.fillRect(x + 3, y - s * 0.75 + 3, s - 6, s * 0.75 - 6);
    r.fillStyle = gray(40 + rand() * 30); r.fillRect(x + 3, y - s * 0.75 + 3, s - 6, s * 0.75 - 6);
  }
  c.fillStyle = '#d8d2c0'; c.fillRect(0, top - 10, W, 12);
  hh.fillStyle = gray(230); hh.fillRect(0, top - 10, W, 12);
  ageWall(p, rand, seed);
  for (let i = 0; i < 40; i++) blot(c, rand() * W, top + rand() * (WALL_PX_H - top), 8 + rand() * 30, 'rgba(60,45,20,0.25)');
  grain(c, W, WALL_PX_H, 10, rand);
  return finish(p, 3);
}

export function sidingSet(seed) {
  const W = 1024, p = painter(W, WALL_PX_H);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = '#6f6e66'; c.fillRect(0, 0, W, WALL_PX_H);
  r.fillStyle = gray(200); r.fillRect(0, 0, W, WALL_PX_H);
  const board = WALL_PX_H / 13;
  for (let y = 0; y < WALL_PX_H; y += board) {
    const gr = hh.createLinearGradient(0, y, 0, y + board);
    gr.addColorStop(0, gray(60)); gr.addColorStop(0.1, gray(200)); gr.addColorStop(1, gray(120));
    hh.fillStyle = gr; hh.fillRect(0, y, W, board);
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(0, y, W, 4);
  }
  overlay(c, fbm(seed, 6, 4), W, WALL_PX_H, 'multiply', 0.4);
  const f0 = yPx(0.3);
  c.fillStyle = '#4c4a45'; c.fillRect(0, f0, W, WALL_PX_H - f0);
  overlay(c, fbm(seed + 5, 10, 4), W, WALL_PX_H, 'overlay', 0.3);
  hh.fillStyle = gray(128); hh.fillRect(0, f0, W, WALL_PX_H - f0);
  for (let i = 0; i < 30; i++) blot(c, rand() * W, rand() * WALL_PX_H, 20 + rand() * 80, 'rgba(20,30,10,0.3)');
  grain(c, W, WALL_PX_H, 14, rand);
  return finish(p, 4);
}

// ------------------------------------------------------------------ floors
// Floor textures cover 2 x 2 m.
export function woodFloorSet(seed, tone = [92, 62, 38]) {
  const S = 1024, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  const plank = S / 14;
  for (let y = 0; y < S; y += plank) {
    let x = -rand() * 400;
    while (x < S) {
      const len = 250 + rand() * 400;
      const k = 0.72 + rand() * 0.42;
      c.fillStyle = `rgb(${tone[0] * k | 0},${tone[1] * k | 0},${tone[2] * k | 0})`;
      c.fillRect(x, y, len, plank);
      r.fillStyle = gray(120 + rand() * 70); r.fillRect(x, y, len, plank);
      c.strokeStyle = 'rgba(25,12,4,0.3)';
      for (let i = 0; i < 10; i++) {
        c.lineWidth = 0.6 + rand() * 1.2;
        const gy = y + rand() * plank;
        c.beginPath(); c.moveTo(x, gy);
        c.bezierCurveTo(x + len * 0.3, gy + (rand() - 0.5) * 10, x + len * 0.6, gy + (rand() - 0.5) * 10, x + len, gy);
        c.stroke();
      }
      if (rand() < 0.3) blot(c, x + rand() * len, y + plank / 2, 6 + rand() * 6, 'rgba(30,15,5,0.6)'); // knot
      for (const g of [c, hh]) { g.fillStyle = g === c ? 'rgba(0,0,0,0.65)' : gray(40); g.fillRect(x, y, 3, plank); }
      x += len;
    }
    for (const g of [c, hh]) { g.fillStyle = g === c ? 'rgba(0,0,0,0.6)' : gray(30); g.fillRect(0, y, S, 3); }
  }
  overlay(c, fbm(seed, 4, 4), S, S, 'multiply', 0.3);
  // scratches and wear
  c.strokeStyle = 'rgba(200,170,130,0.12)';
  for (let i = 0; i < 120; i++) {
    const x = rand() * S, y = rand() * S, a = rand() * Math.PI;
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * 30, y + Math.sin(a) * 30); c.stroke();
  }
  overlay(r, fbm(seed + 7, 6, 3), S, S, 'overlay', 0.5);
  grain(c, S, S, 10, rand);
  return finish(p, 4);
}

export function tileFloorSet(seed, a = '#b9b4a6', b = '#8f8a7e') {
  const S = 1024, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = '#3a362f'; c.fillRect(0, 0, S, S);
  hh.fillStyle = gray(60); hh.fillRect(0, 0, S, S);
  r.fillStyle = gray(235); r.fillRect(0, 0, S, S);
  const n = 7, s = S / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const col = new THREE.Color((i + j) % 2 ? a : b).multiplyScalar(0.9 + rand() * 0.15);
    c.fillStyle = '#' + col.getHexString();
    c.fillRect(i * s + 4, j * s + 4, s - 8, s - 8);
    hh.fillStyle = gray(190); hh.fillRect(i * s + 4, j * s + 4, s - 8, s - 8);
    r.fillStyle = gray(50 + rand() * 40); r.fillRect(i * s + 4, j * s + 4, s - 8, s - 8);
    if (rand() < 0.12) { // cracked tile
      c.strokeStyle = 'rgba(20,15,10,0.7)'; hh.strokeStyle = gray(80);
      const x0 = i * s + rand() * s, y0 = j * s + 4;
      for (const g of [c, hh]) { g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + (rand() - 0.5) * s, y0 + s * 0.9); g.stroke(); }
    }
  }
  overlay(c, fbm(seed, 4, 4), S, S, 'multiply', 0.35);
  for (let i = 0; i < 25; i++) blot(c, rand() * S, rand() * S, 30 + rand() * 90, 'rgba(50,38,18,0.25)');
  grain(c, S, S, 10, rand);
  return finish(p, 5);
}

export function carpetSet(seed, base = '#4a3530') {
  const S = 512, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, S, S);
  r.fillStyle = gray(250); r.fillRect(0, 0, S, S);
  overlay(hh, fbm(seed, 64, 2), S, S, 'source-over', 1);
  overlay(c, fbm(seed + 1, 8, 4), S, S, 'overlay', 0.5);
  for (let i = 0; i < 15; i++) blot(c, rand() * S, rand() * S, 20 + rand() * 60, 'rgba(15,8,2,0.35)');
  grain(c, S, S, 40, rand);
  return finish(p, 2);
}

export function concreteSet(seed, base = '#5d5c58') {
  const S = 1024, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, S, S);
  r.fillStyle = gray(225); r.fillRect(0, 0, S, S);
  overlay(c, fbm(seed, 4, 5), S, S, 'overlay', 0.55);
  overlay(hh, fbm(seed + 2, 32, 3), S, S, 'source-over', 0.7);
  for (let i = 0; i < 30; i++) blot(c, rand() * S, rand() * S, 30 + rand() * 120, 'rgba(0,0,0,0.2)');
  for (let i = 0; i < 400; i++) { // pits
    const x = rand() * S, y = rand() * S;
    hh.fillStyle = gray(40); hh.beginPath(); hh.arc(x, y, 1 + rand() * 2.5, 0, 7); hh.fill();
  }
  grain(c, S, S, 22, rand);
  return finish(p, 3);
}

export function grassSet(seed) {
  const S = 512, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = '#2b3520'; c.fillRect(0, 0, S, S);
  r.fillStyle = gray(240); r.fillRect(0, 0, S, S);
  overlay(c, fbm(seed, 4, 4), S, S, 'overlay', 0.5);
  for (let i = 0; i < 7000; i++) {
    const x = rand() * S, y = rand() * S, len = 3 + rand() * 7;
    c.strokeStyle = `rgba(${45 + rand() * 45 | 0},${60 + rand() * 55 | 0},${25 + rand() * 20 | 0},0.75)`;
    hh.strokeStyle = gray(150 + rand() * 100);
    for (const g of [c, hh]) { g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 4, y - len); g.stroke(); }
  }
  return finish(p, 2);
}

export function ceilingSet(seed) {
  const S = 512, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = '#8a857b'; c.fillRect(0, 0, S, S);
  r.fillStyle = gray(240); r.fillRect(0, 0, S, S);
  overlay(c, fbm(seed, 3, 4), S, S, 'overlay', 0.18);
  overlay(hh, fbm(seed + 1, 48, 2), S, S, 'source-over', 0.5); // popcorn texture
  for (let i = 0; i < 5; i++) blot(c, rand() * S, rand() * S, 40 + rand() * 80, 'rgba(70,50,20,0.18)'); // water stains
  return finish(p, 2);
}

// --------------------------------------------------------- bodies & props
export function fabricSet(color, seed, kind = 'knit') {
  const S = 256, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = color; c.fillRect(0, 0, S, S);
  r.fillStyle = gray(kind === 'leather' ? 140 : 245); r.fillRect(0, 0, S, S);
  if (kind === 'denim') {
    for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 4) {
      const off = (y / 2) % 4;
      hh.fillStyle = gray(160); hh.fillRect((x + off) % S, y, 2, 2);
      c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect((x + off) % S, y, 2, 2);
    }
  } else if (kind === 'leather') {
    overlay(hh, fbm(seed, 48, 2), S, S, 'source-over', 1);
  } else {
    for (let y = 0; y < S; y += 4) for (let x = 0; x < S; x += 4) {
      hh.fillStyle = gray(110 + ((x + y) % 8) * 12); hh.fillRect(x, y, 3, 3);
    }
  }
  overlay(c, fbm(seed + 9, 4, 4), S, S, 'overlay', 0.45);
  for (let i = 0; i < 6; i++) blot(c, rand() * S, rand() * S, 15 + rand() * 40, 'rgba(25,18,10,0.3)'); // grime
  grain(c, S, S, 14, rand);
  return finish(p, 2);
}

export function skinSet(tone, seed) {
  const S = 256, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  const col = new THREE.Color(tone);
  c.fillStyle = '#' + col.getHexString(); c.fillRect(0, 0, S, S);
  r.fillStyle = gray(150); r.fillRect(0, 0, S, S);
  overlay(c, fbm(seed, 6, 4), S, S, 'overlay', 0.25);
  for (let i = 0; i < 25; i++) blot(c, rand() * S, rand() * S, 8 + rand() * 25, 'rgba(160,40,30,0.12)');
  for (let i = 0; i < 1500; i++) { // pores
    hh.fillStyle = gray(90); hh.fillRect(rand() * S, rand() * S, 1, 1);
  }
  overlay(hh, fbm(seed + 2, 24, 2), S, S, 'overlay', 0.4);
  overlay(r, fbm(seed + 4, 8, 3), S, S, 'overlay', 0.4);
  grain(c, S, S, 6, rand);
  return finish(p, 1.5);
}

export function maskSet(seed) {
  const S = 256, p = painter(S);
  const { c, hh, r } = p;
  const rand = rng(seed);
  c.fillStyle = '#ddd6c4'; c.fillRect(0, 0, S, S);
  r.fillStyle = gray(90); r.fillRect(0, 0, S, S);
  overlay(c, fbm(seed, 4, 4), S, S, 'multiply', 0.3);
  c.strokeStyle = 'rgba(40,30,20,0.6)'; hh.strokeStyle = gray(40);
  for (let i = 0; i < 6; i++) {
    let x = rand() * S, y = rand() * S;
    const pts = [[x, y]];
    for (let k = 0; k < 8; k++) { x += (rand() - 0.5) * 30; y += (rand() - 0.5) * 30; pts.push([x, y]); }
    for (const g of [c, hh]) { g.lineWidth = 1.2; g.beginPath(); pts.forEach(([a, b], k) => (k ? g.lineTo(a, b) : g.moveTo(a, b))); g.stroke(); }
  }
  for (let i = 0; i < 8; i++) blot(c, rand() * S, rand() * S, 10 + rand() * 30, 'rgba(90,20,10,0.35)'); // old blood
  return finish(p, 2);
}

// -------------------------------------------------------------- set dressing
export function scrawlTexture(text) {
  const [c, g] = canvas(1024, 256);
  const r = rng(99);
  g.clearRect(0, 0, 1024, 256);
  g.font = 'bold 150px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(110,8,6,0.92)';
  g.save(); g.translate(512, 120); g.rotate(-0.03); g.fillText(text, 0, 0); g.restore();
  for (let i = 0; i < 40; i++) {
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
  } else if (kind === 'run') { // streaks running down a wall; top of texture = source
    for (let i = 0; i < 9; i++) {
      const x = 40 + r() * 176, w = 3 + r() * 9, len = 60 + r() * 190;
      g.fillRect(x - w / 2, 0, w, len);
      blob(x, len, w * 0.9);
    }
    blob(128, 10, 60);
  } else if (kind === 'foot') {
    g.beginPath(); g.ellipse(128, 150, 40, 75, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(128, 50, 32, 30, 0, 0, Math.PI * 2); g.fill();
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
  const img = g.getImageData(0, 0, 256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    if (img.data[i + 3] > 0) {
      const d = Math.hypot(x - 128, y - 128) / 128;
      const v = 255 * (0.65 + 0.35 * (1 - Math.min(1, d)));
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
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 54);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(0.14, 'rgba(8,6,4,1)');
  gr.addColorStop(0.22, 'rgba(70,62,52,0.95)');
  gr.addColorStop(0.5, 'rgba(120,110,95,0.5)');
  gr.addColorStop(1, 'rgba(60,55,50,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2;
    g.lineWidth = 1 + r();
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(a) * (18 + r() * 34), 64 + Math.sin(a) * (18 + r() * 34)); g.stroke();
  }
  return tex(c, false);
}

export function flashTexture() {
  const [c, g] = canvas(256);
  g.clearRect(0, 0, 256, 256);
  g.translate(128, 128);
  for (let i = 0; i < 9; i++) {
    g.rotate(Math.PI * 2 / 9 + (i % 2) * 0.2);
    const len = 70 + (i % 3) * 30;
    const gr = g.createLinearGradient(0, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,245,210,1)');
    gr.addColorStop(1, 'rgba(255,110,10,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, -12); g.lineTo(len, 0); g.lineTo(0, 12); g.fill();
  }
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, 60);
  gr.addColorStop(0, 'rgba(255,255,240,1)');
  gr.addColorStop(0.5, 'rgba(255,190,80,0.8)');
  gr.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = gr;
  g.fillRect(-60, -60, 120, 120);
  return tex(c, false);
}

export function puffTexture() {
  const [c, g] = canvas(128);
  const n = fbm(77, 4, 4, 128);
  g.drawImage(n, 0, 0);
  const img = g.getImageData(0, 0, 128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 4;
    const d = Math.hypot(x - 64, y - 64) / 64;
    const a = Math.max(0, 1 - d) * (0.4 + img.data[i] / 255 * 0.8);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.min(255, a * 255);
  }
  g.putImageData(img, 0, 0);
  return tex(c, false);
}

// Rewrite a box's UVs to world metres. mode 'wall' maps v to wall height so
// trim painted into the texture sits at the floor and ceiling.
export function worldUV(geo, offset, scale = 1, mode = 'tile', wallH = WALL_H) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x, y = pos.getY(i) + offset.y, z = pos.getZ(i) + offset.z;
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const v = mode === 'wall' ? y / wallH : y / scale;
    if (nx > 0.5) uv.setXY(i, z / scale, v);
    else if (ny > 0.5) uv.setXY(i, x / scale, z / scale);
    else uv.setXY(i, x / scale, v);
  }
  uv.needsUpdate = true;
  return geo;
}
