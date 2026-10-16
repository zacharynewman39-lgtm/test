import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as T from './textures.js';

// One map cell is 1 m. Letters are rooms, 'o' is outside.
const MAP = [
  'oooooooooooooooooooooo',
  'oMMMMMMTTTTBBBBBRRRRRo',
  'oMMMMMMTTTTBBBBBRRRRRo',
  'oMMMMMMTTTTBBBBBRRRRRo',
  'oMMMMMMHHHHHHHHHRRRRRo',
  'oMMMMMMHHHHHHHHHRRRRRo',
  'oKKKKKKHHLLLLLLLLLLLLo',
  'oKKKKKKHHLLLLLLLLLLLLo',
  'oKKKKKKHHLLLLLLLLLLLLo',
  'oKKKKKKEELLLLLLLLLLLLo',
  'oKKKKKKEELLLLLLLLLLLLo',
  'oooooooooooooooooooooo',
  'oooooooooooooooooooooo',
  'oooooooooooooooooooooo',
  'oooooooooooooooooooooo',
];
export const ROOM_NAMES = {
  M: 'Master bedroom', T: 'Bathroom', B: 'Bedroom', R: '???', H: 'Hallway',
  K: 'Kitchen', L: 'Living room', E: 'Entry', o: 'Outside',
};

// Openings between two neighbouring cells.
const OPENINGS = [
  [7, 10, 7, 11, 'door'], // front door
  [7, 8, 7, 9, 'arch'], [8, 8, 8, 9, 'arch'], // entry -> hall
  [8, 9, 9, 9, 'arch'], [8, 10, 9, 10, 'arch'], // entry -> living
  [6, 9, 7, 9, 'door'], // entry -> kitchen
  [6, 4, 7, 4, 'door'], // hall -> master
  [8, 3, 8, 4, 'door'], // hall -> bath
  [13, 3, 13, 4, 'door'], // hall -> bedroom
  [15, 5, 16, 5, 'door'], // hall -> ???
  [18, 5, 18, 6, 'door'], // living -> ???
  [3, 5, 3, 6, 'door'], // kitchen -> master
];

export const WALL_H = 2.7;
const WALL_T = 0.14;
const DOOR_H = 2.08;

// x/z/w/d in metres; h height; m material key
const FURNITURE = [
  // master
  { x: 1.1, z: 1.1, w: 2.0, d: 2.1, h: 0.55, m: 'mattress' },
  { x: 1.1, z: 1.05, w: 2.0, d: 0.12, h: 1.05, m: 'darkwood' },
  { x: 5.9, z: 1.1, w: 0.95, d: 0.6, h: 2.0, m: 'wood' },
  // bath
  { x: 7.15, z: 1.15, w: 1.65, d: 0.75, h: 0.55, m: 'porcelain' },
  { x: 10.3, z: 1.15, w: 0.55, d: 0.6, h: 0.45, m: 'porcelain' },
  // bedroom
  { x: 13.5, z: 1.15, w: 2.35, d: 1.45, h: 0.5, m: 'mattress' },
  { x: 11.15, z: 1.15, w: 1.15, d: 0.45, h: 0.9, m: 'wood' },
  // ???
  { x: 18.0, z: 1.6, w: 1.4, d: 0.8, h: 0.9, m: 'altar' },
  // living
  { x: 12.0, z: 7.0, w: 3.0, d: 0.9, h: 0.85, m: 'fabric' },
  { x: 12.6, z: 8.4, w: 1.8, d: 0.6, h: 0.45, m: 'wood' },
  { x: 16.6, z: 8.5, w: 0.9, d: 0.9, h: 0.85, m: 'fabric' },
  { x: 20.5, z: 6.3, w: 0.35, d: 2.0, h: 1.9, m: 'darkwood' },
  { x: 12.8, z: 10.5, w: 1.4, d: 0.35, h: 0.6, m: 'darkwood' },
  // kitchen
  { x: 1.15, z: 6.15, w: 0.6, d: 4.7, h: 0.92, m: 'counter' },
  { x: 3.3, z: 7.8, w: 1.6, d: 1.2, h: 0.92, m: 'counter' },
  { x: 5.9, z: 6.15, w: 0.95, d: 0.7, h: 1.8, m: 'metal' },
  // hall
  { x: 10.0, z: 4.1, w: 0.9, d: 0.35, h: 0.8, m: 'darkwood' },
];

// Who's in the house. heading: facing direction is (sin h, cos h).
export const SPAWNS = {
  player: { x: 7.5, z: 13.6, yaw: 0 },
  enemies: [
    { x: 14.6, z: 9.8, h: -1.62, type: 'guard' },
    { x: 19.5, z: 7.6, h: -Math.PI / 2, type: 'guard' },
    { x: 2.6, z: 8.5, h: Math.PI / 2, type: 'ambush' },
    { x: 9.5, z: 4.6, h: Math.PI / 2, type: 'patrol', patrol: [[9.5, 4.6], [14.5, 5.4]] },
    { x: 19.8, z: 4.3, h: -1.24, type: 'guard', executioner: 0 },
    { x: 5.0, z: 3.9, h: 2.3, type: 'playdead' },
    { x: 15.4, z: 3.4, h: -1.26, type: 'ambush' },
  ],
  hostages: [
    { x: 18.7, z: 3.15, h: 0 },
    { x: 1.8, z: 4.35, h: Math.PI / 2 },
  ],
  exit: { x: 7.5, z: 13.0 },
};

export class Door {
  constructor(level, axis, line, a, b) {
    // axis 'v': wall runs along z at x=line, opening z in [a,b]. 'h': runs along x at z=line.
    this.level = level;
    this.axis = axis;
    this.line = line;
    this.angle = 0;
    this.target = 0;
    this.width = (b - a) - WALL_T - 0.02;
    this.pivot = new THREE.Group();
    this.pivot.rotation.order = 'YXZ';
    const hinge = a + WALL_T / 2 + 0.01;
    if (axis === 'v') { this.pivot.position.set(line, 0, hinge); this.base = -Math.PI / 2; }
    else { this.pivot.position.set(hinge, 0, line); this.base = 0; }
    this.pivot.rotation.y = this.base;
    const geo = new THREE.BoxGeometry(this.width, DOOR_H - 0.02, 0.045).translate(this.width / 2, DOOR_H / 2, 0);
    this.mesh = new THREE.Mesh(geo, level.mats.door);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.userData.door = this;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), level.mats.brass);
    knob.position.set(this.width - 0.08, 1.0, 0.045);
    const knob2 = knob.clone(); knob2.position.z = -0.045;
    this.pivot.add(this.mesh, knob, knob2);
    this.center = axis === 'v' ? new THREE.Vector3(line, 1, (a + b) / 2) : new THREE.Vector3((a + b) / 2, 1, line);
  }
  get isOpen() { return Math.abs(this.target) > 0.1; }
  open(from, hard = false) {
    const side = this.axis === 'v' ? Math.sign(from.x - this.line) : Math.sign(from.z - this.line);
    const away = -(side || 1);
    this.target = this.axis === 'v' ? away * 1.65 : -away * 1.65;
    this.speed = hard ? 14 : 5;
  }
  close() { this.target = 0; this.speed = 4; }
  toggle(from) { this.isOpen ? this.close() : this.open(from); }
  update(dt) {
    const prev = this.angle;
    this.angle += (this.target - this.angle) * (1 - Math.exp(-(this.speed || 5) * dt));
    if (Math.abs(this.target - this.angle) < 0.002) this.angle = this.target;
    this.pivot.rotation.y = this.base + this.angle;
    if (Math.abs(prev - this.angle) > 1e-4) this.level.shadowsDirty = true;
  }
  // segment from hinge to tip, for circle collisions
  segment() {
    const p = this.pivot.position;
    const r = this.base + this.angle;
    return [p.x, p.z, p.x + Math.cos(r) * this.width, p.z - Math.sin(r) * this.width];
  }
}

export function buildLevel(scene, renderer) {
  const H = MAP.length, W = MAP[0].length;
  const room = (x, z) => (z < 0 || z >= H || x < 0 || x >= W) ? 'o' : MAP[z][x];

  // ---------------------------------------------------------------- materials
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const set = (o, extra = {}) => std({ ...o, roughness: 1, normalScale: new THREE.Vector2(1, 1), ...extra });
  const wallMats = {
    M: set(T.wallpaperSet('#7a6754', '#6b5947', 1)),
    T: set(T.wainscotSet('#9fb0aa', '#8b918a', 2)),
    B: set(T.wallpaperSet('#5d6878', '#535d6c', 3)),
    R: set(T.plasterSet('#5a3229', 4, '#3a2a24')),
    H: set(T.wallpaperSet('#7d7458', '#70684e', 5)),
    K: set(T.wainscotSet('#c8c2b0', '#958a6a', 6)),
    L: set(T.wallpaperSet('#5b6955', '#4f5d4a', 7)),
    E: set(T.plasterSet('#7a7363', 8)),
    o: set(T.sidingSet(9)),
  };
  const wood = T.woodFloorSet(13), wood2 = T.woodFloorSet(17, [80, 56, 36]), tile = T.tileFloorSet(12), tile2 = T.tileFloorSet(16, '#a8a294', '#6f6a5f');
  const floorMats = {
    M: set(T.carpetSet(11, '#563d36')),
    T: set(tile),
    B: set(wood),
    R: set(T.concreteSet(14, '#555049')),
    H: set(wood),
    K: set(tile2),
    L: set(wood2),
    E: set(wood),
  };
  const trim = std({ color: 0x4a4238, roughness: 0.6 });
  const doorWood = T.woodFloorSet(21, [74, 50, 32]), furnWood = T.woodFloorSet(22, [96, 66, 40]), darkWood = T.woodFloorSet(23, [52, 36, 24]);
  const mats = {
    door: set(doorWood, { roughness: 0.9 }),
    brass: std({ color: 0xa88a4a, metalness: 1, roughness: 0.35 }),
    mattress: set(T.fabricSet('#8c8574', 41, 'knit')),
    wood: set(furnWood),
    darkwood: set(darkWood),
    porcelain: std({ color: 0xd8d6cc, roughness: 0.12 }),
    altar: set(T.concreteSet(24, '#3a3330')),
    fabric: set(T.fabricSet('#3e4a3e', 42, 'denim')),
    counter: set(T.concreteSet(25, '#8a857a'), { roughness: 0.6 }),
    metal: std({ color: 0xb8bcbc, metalness: 0.6, roughness: 0.35 }),
  };

  const group = new THREE.Group();
  scene.add(group);
  const occluders = []; // things bullets and eyes can't pass
  const boxes = []; // static AABB colliders {minX,maxX,minZ,maxZ,top}
  const level = { group, occluders, boxes, doors: [], mats, shadowsDirty: true, W, H };

  const addBox = (x0, x1, y0, y1, z0, z1, material, collide = true, wall = false) => {
    const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    if (wall) T.worldUV(geo, c, 2, 'wall', WALL_H);
    else T.worldUV(geo, c, 2);
    const m = new THREE.Mesh(geo, material);
    m.position.copy(c);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    occluders.push(m);
    if (collide) boxes.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: y1 });
    return m;
  };

  // painted door casings either side of an opening
  const casingMat = std({ color: 0x8b8475, roughness: 0.55 });
  const casing = (axis, line, a, op) => {
    const top = DOOR_H + (op === 'arch' ? 0.1 : 0);
    const T2 = WALL_T / 2 + 0.02, wd = 0.07;
    const pieces = [[a, a + wd, 0, top + wd], [a + 1 - wd, a + 1, 0, top + wd], [a, a + 1, top, top + wd]];
    for (const [p0, p1, y0, y1] of pieces) {
      const geo = axis === 'v' ? new THREE.BoxGeometry(T2 * 2, y1 - y0, p1 - p0) : new THREE.BoxGeometry(p1 - p0, y1 - y0, T2 * 2);
      const m = new THREE.Mesh(geo, casingMat);
      if (axis === 'v') m.position.set(line, (y0 + y1) / 2, (p0 + p1) / 2);
      else m.position.set((p0 + p1) / 2, (y0 + y1) / 2, line);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
  };

  // -------------------------------------------------------------------- walls
  const opening = new Map();
  for (const [x1, z1, x2, z2, type] of OPENINGS) {
    const key = x1 !== x2 ? `v:${Math.max(x1, x2)}:${z1}` : `h:${Math.max(z1, z2)}:${x1}`;
    opening.set(key, type);
  }
  const wallFaces = (a, b) => (a === b ? null : [a, b]);
  // vertical lines (constant x)
  for (let X = 1; X < W; X++) {
    let run = null;
    const flush = () => {
      if (!run) return;
      const [a, b] = run.rooms;
      const mArr = [wallMats[b], wallMats[a], trim, trim, trim, trim];
      addBox(X - WALL_T / 2, X + WALL_T / 2, 0, WALL_H, run.z0 - WALL_T / 2, run.z1 + WALL_T / 2, mArr, true, true);
      run = null;
    };
    for (let z = 0; z < H; z++) {
      const a = room(X - 1, z), b = room(X, z);
      const faces = wallFaces(a, b);
      const op = opening.get(`v:${X}:${z}`);
      if (!faces || op) {
        flush();
        if (faces && op) {
          const mArr = [wallMats[b], wallMats[a], trim, trim, trim, trim];
          addBox(X - WALL_T / 2, X + WALL_T / 2, DOOR_H + (op === 'arch' ? 0.1 : 0), WALL_H, z, z + 1, mArr, false, true);
          casing('v', X, z, op);
          if (op === 'door') {
            const d = new Door(level, 'v', X, z, z + 1);
            group.add(d.pivot); occluders.push(d.mesh); level.doors.push(d);
          }
        }
        continue;
      }
      if (run && run.rooms[0] === a && run.rooms[1] === b) run.z1 = z + 1;
      else { flush(); run = { rooms: [a, b], z0: z, z1: z + 1 }; }
    }
    flush();
  }
  // horizontal lines (constant z)
  for (let Z = 1; Z < H; Z++) {
    let run = null;
    const flush = () => {
      if (!run) return;
      const [a, b] = run.rooms;
      const mArr = [trim, trim, trim, trim, wallMats[b], wallMats[a]];
      addBox(run.x0 - WALL_T / 2, run.x1 + WALL_T / 2, 0, WALL_H, Z - WALL_T / 2, Z + WALL_T / 2, mArr, true, true);
      run = null;
    };
    for (let x = 0; x < W; x++) {
      const a = room(x, Z - 1), b = room(x, Z);
      const faces = wallFaces(a, b);
      const op = opening.get(`h:${Z}:${x}`);
      if (!faces || op) {
        flush();
        if (faces && op) {
          const mArr = [trim, trim, trim, trim, wallMats[b], wallMats[a]];
          addBox(x, x + 1, DOOR_H + (op === 'arch' ? 0.1 : 0), WALL_H, Z - WALL_T / 2, Z + WALL_T / 2, mArr, false, true);
          casing('h', Z, x, op);
          if (op === 'door') {
            const d = new Door(level, 'h', Z, x, x + 1);
            group.add(d.pivot); occluders.push(d.mesh); level.doors.push(d);
          }
        }
        continue;
      }
      if (run && run.rooms[0] === a && run.rooms[1] === b) run.x1 = x + 1;
      else { flush(); run = { rooms: [a, b], x0: x, x1: x + 1 }; }
    }
    flush();
  }

  // ------------------------------------------------------------ floors + roof
  const cellsByRoom = {};
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const r = room(x, z);
    if (r !== 'o') (cellsByRoom[r] ||= []).push([x, z]);
  }
  for (const [r, cells] of Object.entries(cellsByRoom)) {
    const geos = cells.map(([x, z]) => {
      const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(x + 0.5, 0, z + 0.5);
      const p = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 2, p.getZ(i) / 2);
      return g;
    });
    const floor = new THREE.Mesh(mergeGeometries(geos), floorMats[r]);
    floor.receiveShadow = true;
    floor.userData.floor = true;
    group.add(floor);
    occluders.push(floor);
  }
  const roofMat = [trim, trim, std({ color: 0x24221f, roughness: 1 }),
    set(T.ceilingSet(30)), trim, trim];
  const roof = addBox(0.6, W - 0.6, WALL_H, WALL_H + 0.25, 0.6, 11.4, roofMat, false);
  roof.userData.ceiling = true;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2),
    set(T.grassSet(31)));
  for (const k of ['map', 'normalMap', 'roughnessMap']) ground.material[k].repeat.set(60, 60);
  ground.position.set(W / 2, -0.005, H / 2);
  ground.receiveShadow = true;
  ground.userData.floor = true;
  group.add(ground);
  occluders.push(ground);
  const path = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 6).rotateX(-Math.PI / 2),
    set(T.concreteSet(32, '#6a6862')));
  path.position.set(7.5, 0.001, 14);
  path.receiveShadow = true;
  path.userData.floor = true;
  group.add(path);
  occluders.push(path);

  // ---------------------------------------------------------------- furniture
  const blocked = new Set();
  for (const f of FURNITURE) {
    addBox(f.x, f.x + f.w, 0, f.h, f.z, f.z + f.d, mats[f.m]);
    for (let z = Math.floor(f.z); z < f.z + f.d; z++) for (let x = Math.floor(f.x); x < f.x + f.w; x++) {
      const ox = Math.min(x + 1, f.x + f.w) - Math.max(x, f.x);
      const oz = Math.min(z + 1, f.z + f.d) - Math.max(z, f.z);
      if (ox * oz > 0.3) blocked.add(x + z * W);
    }
  }

  // set dressing ----------------------------------------------------------
  const deco = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; group.add(mesh); return mesh; };
  // ritual room: pentagram, scrawl, candles
  const pent = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2),
    std({ map: T.pentagramTexture(), transparent: true, roughness: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  pent.position.set(18.5, 0.003, 3.4);
  group.add(pent);
  const scrawl = new THREE.Mesh(new THREE.PlaneGeometry(4, 1),
    std({ map: T.scrawlTexture('WE SEE YOU'), transparent: true, roughness: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  scrawl.position.set(18.5, 1.75, 1 + WALL_T / 2 + 0.003);
  group.add(scrawl);
  const scrawl2 = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.75), new THREE.MeshStandardMaterial({
    map: T.scrawlTexture('LET HIM IN'), transparent: true, roughness: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  scrawl2.position.set(13.5, 1.6, 6 - WALL_T / 2 - 0.003);
  scrawl2.rotation.y = Math.PI;
  group.add(scrawl2);
  const candleMat = std({ color: 0xd8cfb8, roughness: 0.8, emissive: 0x331100 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb060 });
  for (const [x, z, y] of [[18.2, 1.8, 0.9], [18.6, 1.9, 0.9], [19.1, 1.75, 0.9], [17.2, 2.5, 0], [20.0, 4.6, 0], [17.4, 4.7, 0], [19.8, 2.3, 0]]) {
    const h = 0.1 + ((x * 7) % 1) * 0.15;
    deco(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, h, 8), candleMat), x, y + h / 2, z);
    deco(new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 5).scale(1, 2, 1), flameMat), x, y + h + 0.02, z).castShadow = false;
  }
  // floor lamp, TV
  deco(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6), mats.metal), 18.0, 0.7, 9.0);
  deco(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 0.25, 12, 1, true),
    std({ color: 0xd8c8a0, emissive: 0x553a10, side: THREE.DoubleSide })), 18.0, 1.45, 9.0).castShadow = false;
  const tv = deco(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.06), std({ color: 0x111111, emissive: 0x334466 })), 11.7, 1.12, 1.4);
  tv.rotation.y = 0;
  // fridge door hanging open
  const fd = deco(new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.75, 0.9), mats.metal), 5.88, 0.9, 7.25);
  fd.rotation.y = 0.25;
  // police car outside
  const car = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.7, 4.6), std({ color: 0x15171c, roughness: 0.4, metalness: 0.4 }));
  body.position.y = 0.6;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 2.2), std({ color: 0xdedede, roughness: 0.3 }));
  cabin.position.set(0, 1.2, -0.2);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.25), std({ color: 0x222222, emissive: 0x220000 }));
  bar.position.set(0, 1.52, -0.2);
  car.add(body, cabin, bar);
  car.traverse((o) => { o.castShadow = o.receiveShadow = true; });
  car.position.set(3.2, 0, 17.5);
  car.rotation.y = 0.15;
  group.add(car);
  boxes.push({ minX: 2.0, maxX: 4.4, minZ: 15.1, maxZ: 19.9, top: 1.5 });

  // ------------------------------------------------------------------- lights
  const lights = [];
  const shadowed = [];
  const point = (x, y, z, color, intensity, distance, flicker, shadow = 0) => {
    const l = new THREE.PointLight(color, intensity, distance, 2);
    l.position.set(x, y, z);
    if (shadow) {
      l.castShadow = true;
      l.shadow.mapSize.set(shadow, shadow);
      l.shadow.bias = -0.002;
      l.shadow.autoUpdate = false;
      l.shadow.needsUpdate = true;
      shadowed.push(l);
    }
    group.add(l);
    let fixture = null;
    if (y > 2.3) { // ceiling fixture that glows with its light
      fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.06, 16),
        new THREE.MeshStandardMaterial({ color: 0x222222, emissive: color, emissiveIntensity: 2 }));
      fixture.position.set(x, WALL_H - 0.03, z);
      group.add(fixture);
    }
    lights.push({ light: l, base: intensity, flicker, seed: Math.random() * 100, state: 1, fixture });
    return l;
  };
  point(7.5, 2.3, 11.35, 0xffc890, 4.5, 8, 'buzz'); // porch
  point(18.0, 1.5, 9.0, 0xffb070, 12.0, 13, 'soft', 512); // living lamp
  point(12.5, 2.4, 8.5, 0xffd8a8, 6.0, 10, 'buzz'); // living ceiling
  point(18.7, 1.2, 2.7, 0xff5a2a, 13.0, 10, 'candle', 512); // ritual candles
  point(11.7, 1.2, 1.7, 0x7fa0ff, 7.0, 8, 'tv'); // bedroom TV
  point(6.2, 1.1, 7.3, 0xcfe6ff, 4.0, 5, null); // fridge
  point(3.8, 2.4, 9.3, 0xfff0d0, 5.0, 8, 'dying', 512); // kitchen strip light
  point(3.8, 2.4, 2.8, 0xffd0a0, 4.0, 8, 'soft'); // master bedside
  point(9.0, 2.4, 2.2, 0xe0f0ff, 3.5, 6, 'buzz'); // bathroom
  point(7.9, 2.4, 9.9, 0xffe0b8, 2.5, 6, 'soft'); // entry
  point(11.0, 2.45, 5.0, 0xffe0b0, 7.0, 9, 'dying', 256); // hall bulb
  level.lights = lights;
  const red = point(2.6, 1.6, 17.2, 0xff1010, 0, 7, null);
  const blue = point(3.8, 1.6, 17.4, 0x1030ff, 0, 7, null);

  const street = new THREE.SpotLight(0xffc98a, 120, 34, 0.8, 0.6, 2);
  street.position.set(2.5, 6, 19);
  street.target.position.set(8, 0, 11);
  street.castShadow = true;
  street.shadow.mapSize.set(1024, 1024);
  street.shadow.bias = -0.0005;
  street.shadow.autoUpdate = false;
  street.shadow.needsUpdate = true;
  shadowed.push(street);
  group.add(street, street.target);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 8), mats.metal);
  pole.position.set(2.2, 3, 19.3);
  group.add(pole);

  const hemi = new THREE.HemisphereLight(0x46566e, 0x1c1812, 1.1);
  group.add(hemi);
  scene.fog = new THREE.FogExp2(0x0b0f16, 0.022);
  scene.background = new THREE.Color(0x0b0f16);

  // -------------------------------------------------------------- navigation
  const doorEdge = new Set();
  for (const [x1, z1, x2, z2] of OPENINGS) doorEdge.add(`${x1},${z1},${x2},${z2}`).add(`${x2},${z2},${x1},${z1}`);
  const inGrid = (x, z) => x >= 0 && z >= 0 && x < W && z < H;
  const walkable = (x, z) => inGrid(x, z) && !blocked.has(x + z * W);
  const passable = (x1, z1, x2, z2) => {
    if (!walkable(x1, z1) || !walkable(x2, z2)) return false;
    return room(x1, z1) === room(x2, z2) || doorEdge.has(`${x1},${z1},${x2},${z2}`);
  };
  level.walkable = walkable;
  level.passable = passable;
  level.room = room;
  level.roomAt = (x, z) => room(Math.floor(x), Math.floor(z));
  level.cellCenter = (x, z) => new THREE.Vector3(x + 0.5, 0, z + 0.5);

  // inside: never leave the house (suspects); a target outside snaps to the nearest room cell
  level.findPath = (from, to, cost = null, inside = false) => {
    const sx = Math.floor(from.x), sz = Math.floor(from.z);
    let tx = Math.floor(to.x), tz = Math.floor(to.z);
    if (!inGrid(sx, sz)) return null;
    if (inside && room(tx, tz) === 'o') {
      let best = null, bd = 1e9;
      for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        if (room(x, z) === 'o' || !walkable(x, z)) continue;
        const d = (x - tx) ** 2 + (z - tz) ** 2;
        if (d < bd) { bd = d; best = [x, z]; }
      }
      if (!best) return null;
      [tx, tz] = best;
      to = level.cellCenter(tx, tz);
    }
    if (!walkable(tx, tz)) { // nearest walkable neighbour
      let best = null, bd = 1e9;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (walkable(tx + dx, tz + dz) && room(tx + dx, tz + dz) === room(tx, tz)) {
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = [tx + dx, tz + dz]; }
        }
      }
      if (!best) return null;
      [tx, tz] = best;
    }
    const key = (x, z) => x + z * W;
    const g = new Map([[key(sx, sz), 0]]);
    const came = new Map();
    const open = [[Math.hypot(tx - sx, tz - sz), sx, sz]];
    const closed = new Set();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, x, z] = open.splice(bi, 1)[0];
      const k = key(x, z);
      if (closed.has(k)) continue;
      closed.add(k);
      if (x === tx && z === tz) {
        const out = [];
        let c = k;
        while (c !== undefined) { out.push(level.cellCenter(c % W, Math.floor(c / W))); c = came.get(c); }
        out.reverse();
        out[out.length - 1] = new THREE.Vector3(to.x, 0, to.z);
        if (!walkable(Math.floor(to.x), Math.floor(to.z))) out[out.length - 1] = level.cellCenter(tx, tz);
        return out.slice(1);
      }
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx, nz = z + dz;
        if (dx && dz) {
          if (!(passable(x, z, nx, z) && passable(nx, z, nx, nz) && passable(x, z, x, nz) && passable(x, nz, nx, nz))) continue;
        } else if (!passable(x, z, nx, nz)) continue;
        if (inside && room(nx, nz) === 'o' && room(x, z) !== 'o') continue;
        const nk = key(nx, nz);
        const ng = g.get(k) + (dx && dz ? 1.414 : 1) + (cost ? cost(nx, nz) : 0);
        if (ng < (g.get(nk) ?? 1e9)) {
          g.set(nk, ng);
          came.set(nk, k);
          open.push([ng + Math.hypot(tx - nx, tz - nz), nx, nz]);
        }
      }
    }
    return null;
  };
  level.randomCellIn = (r) => {
    const cells = (cellsByRoom[r] || []).filter(([x, z]) => walkable(x, z));
    const [x, z] = cells[Math.floor(Math.random() * cells.length)];
    return level.cellCenter(x, z);
  };
  level.cellsByRoom = cellsByRoom;

  // Is a point inside a wall or furniture? Returns the outward face normal.
  // Boxes are bucketed into 1 m cells so blood droplets can ask cheaply.
  const bucket = new Map();
  for (const b of boxes) {
    for (let z = Math.floor(b.minZ); z <= Math.floor(b.maxZ); z++) for (let x = Math.floor(b.minX); x <= Math.floor(b.maxX); x++) {
      const k = x + ',' + z;
      if (!bucket.has(k)) bucket.set(k, []);
      bucket.get(k).push(b);
    }
  }
  level.solidAt = (x, y, z) => {
    if (y > WALL_H) return null;
    const list = bucket.get(Math.floor(x) + ',' + Math.floor(z));
    if (!list) return null;
    for (const b of list) {
      if (y > b.top || x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const d = [x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z, b.top - y];
      const i = d.indexOf(Math.min(...d));
      return [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)][i];
    }
    return null;
  };

  // Ragdoll particles: settle on top of furniture, get pushed out of walls.
  level.collide3D = (p, r) => {
    const list = bucket.get(Math.floor(p.x) + ',' + Math.floor(p.z));
    if (!list) return;
    for (const b of list) {
      if (p.y - r > b.top || p.x < b.minX - r || p.x > b.maxX + r || p.z < b.minZ - r || p.z > b.maxZ + r) continue;
      const pushUp = b.top + r - p.y;
      const pushes = [p.x - (b.minX - r), (b.maxX + r) - p.x, p.z - (b.minZ - r), (b.maxZ + r) - p.z];
      const side = Math.min(...pushes);
      if (b.top < 1.2 && pushUp < side + 0.15) { p.y = b.top + r; continue; }
      const i = pushes.indexOf(side);
      if (i === 0) p.x = b.minX - r; else if (i === 1) p.x = b.maxX + r; else if (i === 2) p.z = b.minZ - r; else p.z = b.maxZ + r;
    }
  };

  // --------------------------------------------------------------- collision
  // Push a circle (pos.x/pos.z, radius r) out of walls, furniture and doors.
  level.collide = (pos, r, maxTop = 0.35) => {
    for (const b of boxes) {
      if (b.top <= maxTop) continue;
      const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pos.x = cx + dx / d * r; pos.z = cz + dz / d * r;
        } else { // centre inside the box: shove out the shortest way
          const pushes = [[b.minX - r - pos.x, 0], [b.maxX + r - pos.x, 0], [0, b.minZ - r - pos.z], [0, b.maxZ + r - pos.z]];
          pushes.sort((p, q) => Math.abs(p[0] + p[1]) - Math.abs(q[0] + q[1]));
          pos.x += pushes[0][0]; pos.z += pushes[0][1];
        }
      }
    }
    for (const d of level.doors) {
      const [ax, az, bx, bz] = d.segment();
      const ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((pos.x - ax) * ex + (pos.z - az) * ez) / (ex * ex + ez * ez)));
      const cx = ax + ex * t, cz = az + ez * t;
      const dx = pos.x - cx, dz = pos.z - cz;
      const rr = r + 0.03;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-8) {
        const dd = Math.sqrt(d2);
        pos.x = cx + dx / dd * rr; pos.z = cz + dz / dd * rr;
      }
    }
  };

  // ------------------------------------------------------------------ update
  let policeT = 0;
  level.update = (dt, t) => {
    for (const d of level.doors) d.update(dt);
    for (const L of lights) {
      const l = L.light, s = L.seed;
      switch (L.flicker) {
        case 'buzz': l.intensity = L.base * (Math.random() < 0.04 ? 0.2 : 1); break;
        case 'soft': l.intensity = L.base * (0.92 + 0.08 * Math.sin(t * 13 + s)); break;
        case 'candle': l.intensity = L.base * (0.75 + 0.15 * Math.sin(t * 9 + s) + 0.1 * Math.sin(t * 23.7 + s * 2)); break;
        case 'tv':
          if (Math.random() < dt * 6) L.state = 0.4 + Math.random() * 0.9;
          l.intensity = L.base * L.state;
          break;
        case 'dying':
          if (L.state > 0.5) { if (Math.random() < dt * 0.6) L.state = 0; }
          else if (Math.random() < dt * 1.4) L.state = 1;
          l.intensity = L.state > 0.5 ? L.base * (Math.random() < 0.3 ? 0.1 : 1) : 0;
          break;
      }
    }
    for (const L of lights) if (L.fixture) L.fixture.material.emissiveIntensity = 2.5 * L.light.intensity / L.base;
    policeT += dt;
    const ph = Math.floor(policeT * 6) % 4;
    red.intensity = ph === 0 || ph === 1 ? 12 : 0;
    blue.intensity = ph === 2 || ph === 3 ? 12 : 0;
    if (level.shadowsDirty) {
      for (const l of shadowed) l.shadow.needsUpdate = true;
      level.shadowsDirty = false;
    }
  };
  level.refreshShadows = () => { level.shadowsDirty = true; };
  return level;
}
