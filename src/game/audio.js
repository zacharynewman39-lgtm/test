// Every sound is synthesised at load time, so there are no audio files yet.

const SR = 44100;

function biquad(x, type, f, Q = 0.707) {
  const w = 2 * Math.PI * f / SR, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * Q);
  let b0, b1, b2;
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const len = (s) => Math.floor(s * SR);
const noise = (s) => Float32Array.from({ length: len(s) }, () => Math.random() * 2 - 1);
function env(x, fn) { for (let i = 0; i < x.length; i++) x[i] *= fn(i / SR); return x; }
function mix(...parts) {
  const n = Math.max(...parts.map(([b]) => b.length));
  const out = new Float32Array(n);
  for (const [b, g, off = 0] of parts) { const o = len(off); for (let i = 0; i < b.length && i + o < n; i++) out[i + o] += b[i] * g; }
  return out;
}
function normalize(x, peak = 0.9) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}
function tone(s, freq, shape = 'sin') {
  const out = new Float32Array(len(s));
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    ph += (typeof freq === 'function' ? freq(t) : freq) / SR;
    const p = ph % 1;
    out[i] = shape === 'saw' ? 2 * p - 1 : Math.sin(2 * Math.PI * ph);
  }
  return out;
}
// A crude voice: sawtooth through vowel formants.
function voice(s, pitch, formants, amp) {
  const src = tone(s, pitch, 'saw');
  const breath = noise(s);
  for (let i = 0; i < src.length; i++) src[i] = src[i] * 0.8 + breath[i] * 0.15;
  const out = new Float32Array(src.length);
  for (const [f, q, g] of formants) {
    const b = biquad(src, 'bp', typeof f === 'number' ? f : f[0], q);
    for (let i = 0; i < out.length; i++) out[i] += b[i] * g;
  }
  return env(out, amp);
}

// Layered gunshot: supersonic crack, muzzle blast, sub boom, bolt clack,
// early reflections off nearby walls and a room tail, all driven into soft
// clipping so it hits like a real indoor shot.
function gunshot(heavy) {
  const T = 1.8, n = len(T);
  const out = new Float32Array(n);
  // N-wave crack (~1 ms)
  const cw = Math.floor(SR * 0.0012);
  for (let i = 0; i < cw; i++) out[i] += (i < cw / 2 ? 1 : -1) * 1.6;
  // muzzle blast
  const blast = env(biquad(noise(0.35), 'lp', heavy ? 3200 : 4500), (t) => Math.min(1, t * 4000) * Math.exp(-t * (heavy ? 16 : 22)));
  // low-mid body
  const body = env(biquad(noise(0.5), 'bp', heavy ? 350 : 500, 0.7), (t) => Math.exp(-t * (heavy ? 9 : 12)));
  // sub boom sweeping down
  const boom = env(tone(0.5, (t) => (heavy ? 110 : 140) * Math.exp(-t * 6) + 38), (t) => Math.min(1, t * 800) * Math.exp(-t * (heavy ? 6 : 8)));
  // action cycling
  const clack = env(biquad(noise(0.03), 'bp', 2600, 3), (t) => Math.exp(-t * 150));
  for (let i = 0; i < blast.length; i++) out[i] += blast[i] * 1.4;
  for (let i = 0; i < body.length; i++) out[i] += body[i] * 1.2;
  for (let i = 0; i < boom.length; i++) out[i] += boom[i] * (heavy ? 2.2 : 1.7);
  const co = len(heavy ? 0.06 : 0.045);
  for (let i = 0; i < clack.length; i++) out[i + co] += clack[i] * 0.35;
  // early reflections
  const dry = out.slice(0, len(0.12));
  const refl = biquad(dry, 'lp', 2500);
  for (const [ms, gain] of [[7, 0.55], [13, 0.42], [21, 0.32], [33, 0.24], [47, 0.18]]) {
    const o = len(ms / 1000);
    for (let i = 0; i < refl.length && i + o < n; i++) out[i + o] += refl[i] * gain;
  }
  // room tail
  const tail = env(biquad(noise(T), 'lp', 900), (t) => Math.min(1, t * 30) * Math.exp(-t * 2.4));
  for (let i = 0; i < n; i++) out[i] += tail[i] * 0.32;
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 2.2);
  return normalize(out, 0.98);
}

function build() {
  const S = {};
  S.rifle = gunshot(false);
  S.shotgun = gunshot(true);
  S.flesh = normalize(mix(
    [env(biquad(noise(0.25), 'bp', 900, 1.2), (t) => Math.exp(-t * 28)), 1],
    [env(tone(0.2, 90), (t) => Math.exp(-t * 25)), 0.8]), 0.7);
  const crunch = noise(0.5);
  for (let i = 0; i < crunch.length; i++) if (Math.random() > 0.004) crunch[i] *= 0.15;
  S.gib = normalize(mix(
    [env(biquad(noise(0.6), 'bp', 600, 0.8), (t) => Math.exp(-t * 7)), 1],
    [env(biquad(crunch, 'bp', 2000, 1), (t) => Math.exp(-t * 6)), 1.2],
    [env(tone(0.3, 70), (t) => Math.exp(-t * 15)), 0.8]));
  S.impact = normalize(env(biquad(noise(0.1), 'hp', 1800), (t) => Math.exp(-t * 70)), 0.5);
  S.step = normalize(env(biquad(noise(0.14), 'lp', 280), (t) => Math.exp(-t * 40)), 0.6);
  S.door = normalize(mix(
    [env(tone(0.7, (t) => 170 + 90 * t + 30 * Math.sin(t * 90)), (t) => (0.5 + 0.5 * Math.sin(t * 160)) * Math.sin(Math.PI * t / 0.7)), 0.25],
    [env(biquad(noise(0.05), 'bp', 1500), (t) => Math.exp(-t * 60)), 1]), 0.5);
  S.kick = normalize(mix(
    [env(biquad(noise(0.6), 'lp', 900), (t) => Math.exp(-t * 12)), 1],
    [env(tone(0.4, 60), (t) => Math.exp(-t * 12)), 1.2]));
  const click = (f) => env(biquad(noise(0.04), 'bp', f, 2), (t) => Math.exp(-t * 120));
  S.reload = normalize(mix([click(2500), 1], [click(1800), 1, 0.12], [click(3000), 0.8, 0.9], [click(2000), 1, 1.0]), 0.5);
  S.pump = normalize(mix([click(1400), 1], [click(1100), 1, 0.18]), 0.6);
  S.shell = normalize(mix([click(3500), 1]), 0.4);
  S.hit = normalize(mix([click(4200), 1], [click(2600), 0.6, 0.012]), 0.5);
  S.kill = normalize(mix([env(tone(0.18, 140), (t) => Math.exp(-t * 25)), 1], [click(3000), 0.8], [click(1800), 0.7, 0.05]), 0.7);
  S.empty = normalize(click(3000), 0.5);
  S.hurt = normalize(mix([env(tone(0.25, 70), (t) => Math.exp(-t * 18)), 1], [env(biquad(noise(0.2), 'lp', 600), (t) => Math.exp(-t * 20)), 0.6]));
  S.thud = normalize(mix([env(biquad(noise(0.5), 'lp', 220), (t) => Math.exp(-t * 12)), 1], [env(tone(0.3, 48), (t) => Math.exp(-t * 14)), 1]), 0.8);
  S.heartbeat = normalize(mix([env(tone(0.15, 50), (t) => Math.exp(-t * 25)), 1], [env(tone(0.15, 45), (t) => Math.exp(-t * 25)), 0.7, 0.22]), 0.8);

  const ah = [[700, 6, 1], [1150, 8, 0.6], [2600, 10, 0.25]];
  const ee = [[300, 6, 1], [2300, 9, 0.5], [3000, 10, 0.2]];
  const oo = [[350, 5, 1], [800, 7, 0.5], [2400, 10, 0.15]];
  S.pain = normalize(voice(0.45, (t) => 120 - t * 60, ah, (t) => Math.min(1, t * 40) * Math.exp(-t * 6)));
  S.scream = normalize(voice(0.9, (t) => 380 + 40 * Math.sin(t * 30) + 60 * t, ah, (t) => Math.min(1, t * 20) * Math.exp(-t * 2.2)));
  S.shout = normalize(voice(0.45, (t) => 170 - t * 50, [[750, 6, 1], [1200, 8, 0.7]], (t) => Math.min(1, t * 50) * (t < 0.3 ? 1 : Math.exp(-(t - 0.3) * 20))));
  const gurgle = voice(1.6, (t) => 95 - t * 25, oo, (t) => Math.min(1, t * 10) * Math.exp(-t * 1.4));
  const bub = biquad(noise(1.6), 'lp', 300);
  for (let i = 0; i < gurgle.length; i++) gurgle[i] *= 0.4 + 0.6 * Math.abs(Math.sin(i / SR * 27 + bub[i] * 4));
  S.death = normalize(gurgle);
  S.whisper = normalize(env(biquad(noise(1.1), 'bp', 2800, 1.5), (t) => Math.max(0, Math.sin(t * 17)) * Math.sin(Math.PI * t / 1.1)), 0.4);
  S.sob = normalize(voice(1.2, (t) => 300 + 25 * Math.sin(t * 40), oo, (t) => Math.pow(Math.max(0, Math.sin(t * 13)), 2) * Math.exp(-t * 1.5)), 0.5);
  S.thanks = normalize(voice(0.5, (t) => 230 - 60 * t, ee, (t) => Math.max(0, Math.sin(t * 20)) * Math.exp(-t * 2)), 0.6);

  // ambient bed: low detuned drone + wind, loops
  const D = 8;
  const drone = mix([tone(D, 46), 0.5], [tone(D, 46.6), 0.5], [tone(D, 69.2), 0.25], [biquad(noise(D), 'lp', 180), 0.9]);
  env(drone, (t) => 0.6 + 0.4 * Math.sin(2 * Math.PI * t / D));
  S.drone = normalize(drone, 0.5);
  return S;
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.occlusion = null; // fn(pos) -> true if blocked
    this.listenerPos = { x: 0, y: 0, z: 0 };
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const raw = build();
    for (const [k, v] of Object.entries(raw)) {
      const b = ctx.createBuffer(1, v.length, SR);
      b.copyToChannel(v, 0);
      this.buffers[k] = b;
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    // everything except your own gun runs through a lowpass and a duck so a shot
    // can deafen the room for a moment
    this.deaf = ctx.createBiquadFilter();
    this.deaf.type = 'lowpass';
    this.deaf.frequency.value = 20000;
    this.deaf.connect(comp);
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.deaf);
    this.gunBus = ctx.createGain();
    this.gunBus.gain.value = 1.0;
    const gunComp = ctx.createDynamicsCompressor();
    gunComp.threshold.value = -6; gunComp.ratio.value = 3; gunComp.attack.value = 0.001; gunComp.release.value = 0.1;
    this.gunBus.connect(gunComp).connect(ctx.destination);
    // tinnitus: a thin whine that builds with repeated shots indoors
    this.ring = ctx.createOscillator();
    this.ring.frequency.value = 4100;
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0;
    this.ring.connect(this.ringGain).connect(ctx.destination);
    this.ring.start();
    this.ear = 0;
    // small-room reverb send
    const ir = ctx.createBuffer(2, len(1.3), SR);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.5);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.3;
    this.verbSend.connect(this.verb);
    this.verb.connect(this.deaf);

    const drone = ctx.createBufferSource();
    drone.buffer = this.buffers.drone;
    drone.loop = true;
    const dg = ctx.createGain();
    dg.gain.value = 0.35;
    drone.connect(dg).connect(this.master);
    drone.start();
  }

  setListener(camera) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const p = camera.position;
    this.listenerPos = p;
    const f = camera.getWorldDirection(new camera.position.constructor());
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(p.x, t); L.positionY.setValueAtTime(p.y, t); L.positionZ.setValueAtTime(p.z, t);
      L.forwardX.setValueAtTime(f.x, t); L.forwardY.setValueAtTime(f.y, t); L.forwardZ.setValueAtTime(f.z, t);
      L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  // Your own shot: full volume, then the world goes muffled and duck for a beat.
  gunshot(name) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    const g = ctx.createGain();
    g.gain.value = 1.0;
    src.connect(g);
    g.connect(this.gunBus);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    g.connect(send).connect(this.verbSend);
    src.start();
    this.deafen(name === 'shotgun' ? 1 : 0.8);
  }

  deafen(amount) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = this.deaf.frequency, m = this.master.gain;
    f.cancelScheduledValues(t); m.cancelScheduledValues(t);
    f.setValueAtTime(Math.max(350, 1400 - amount * 900), t);
    f.exponentialRampToValueAtTime(20000, t + 0.6 + amount * 0.9);
    m.setValueAtTime(0.8 * (1 - amount * 0.65), t);
    m.linearRampToValueAtTime(0.8, t + 0.5 + amount * 0.8);
    this.ear = Math.min(1, this.ear + amount * 0.22);
    const rg = this.ringGain.gain;
    rg.cancelScheduledValues(t);
    rg.setValueAtTime(rg.value, t);
    rg.linearRampToValueAtTime(0.012 * this.ear, t + 0.15);
    rg.exponentialRampToValueAtTime(0.0001, t + 1.5 + this.ear * 4);
  }

  update(dt) { this.ear = Math.max(0, this.ear - dt * 0.08); }

  play(name, { pos = null, volume = 1, rate = 1 } = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.buffers[name]) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = volume;
    if (pos) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      const blocked = this.occlusion ? this.occlusion(pos) : false;
      lp.frequency.value = blocked ? 650 : 18000;
      if (blocked) g.gain.value *= 0.65;
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 1.5;
      pan.rolloffFactor = 1.1;
      const y = pos.y < 0.2 ? pos.y + 1 : pos.y; // actor positions are at their feet
      if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = y; pan.positionZ.value = pos.z; }
      else pan.setPosition(pos.x, y, pos.z);
      src.connect(lp).connect(g).connect(pan);
      pan.connect(this.master);
      pan.connect(this.verbSend);
    } else {
      src.connect(g);
      g.connect(this.master);
      g.connect(this.verbSend);
    }
    src.start();
  }
}
