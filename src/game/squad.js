import * as THREE from 'three';

// Shared brain for the suspects: where the player was last seen, which cells
// the player can see right now (for cover and flanking), who is doing what,
// and who has claimed which piece of cover.

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Squad {
  constructor(game) {
    this.game = game;
    const L = game.level;
    this.W = L.W; this.H = L.H;
    this.alerted = false;
    this.lastKnown = null;
    this.lastSeenT = -99;
    this.t = 0;
    this.visT = 0;
    this.visLow = new Uint8Array(L.W * L.H); // a crouched head (1.0 m) is visible to the player
    this.visHigh = new Uint8Array(L.W * L.H); // a standing head (1.55 m) is visible
    this.visFrom = new THREE.Vector3();
    this.calloutT = 0;
    this.ray = new THREE.Raycaster();
  }

  get members() { return this.game.enemies.filter((e) => !e.dead); }
  idx(x, z) { return Math.floor(x) + Math.floor(z) * this.W; }
  sinceSeen() { return this.t - this.lastSeenT; }

  update(dt) {
    this.t += dt;
    this.calloutT -= dt;
    const P = this.game.player;
    if (this.members.some((e) => e.seesPlayer)) {
      this.lastKnown = P.pos.clone();
      this.lastSeenT = this.t;
    }
    if (this.alerted) {
      this.visT -= dt;
      if (this.visT <= 0) { this.visT = 0.35; this.computeVisibility(P.eye); }
    }
  }

  // Someone spotted the player. First time: wake everyone and hand out jobs.
  report() {
    this.lastKnown = this.game.player.pos.clone();
    this.lastSeenT = this.t;
    if (this.alerted) return;
    this.alerted = true;
    this.computeVisibility(this.game.player.eye);
    this.assignRoles();
  }

  assignRoles() {
    const P = this.game.player.pos;
    const free = this.members
      .filter((e) => !e.special)
      .sort((a, b) => a.pos.distanceTo(P) - b.pos.distanceTo(P));
    let flankers = 0, pushers = 0;
    for (const e of free) {
      if (e.aggression > 0.6 && pushers < 1) { e.role = 'pusher'; pushers++; }
      else if (e.aggression > 0.35 && flankers < 2) { e.role = 'flanker'; flankers++; }
      else e.role = 'holder';
    }
  }

  // A gunshot or a kicked door. Two of the calm ones go and look; the rest dig in.
  noise(pos, radius) {
    const all = this.members;
    const near = all.filter((e) => e.pos.distanceTo(pos) < radius);
    for (const e of near) if (e.engaged || e.special) e.hear(pos);
    const calm = near
      .filter((e) => !e.engaged && !e.special && e.state !== 'investigate' && e.state !== 'defend')
      .sort((a, b) => a.pos.distanceTo(pos) - b.pos.distanceTo(pos));
    let lookers = Math.max(0, 2 - all.filter((e) => e.state === 'investigate').length);
    for (const e of calm) {
      if (lookers > 0) { e.investigate(pos); lookers--; }
      else e.defend(pos);
    }
  }

  callout(enemy, sound = 'shout') {
    if (this.calloutT > 0) return;
    this.calloutT = 1.5;
    this.game.audio.play(sound, { pos: enemy.pos, rate: 0.8 + Math.random() * 0.35 });
  }

  // Which cells can the player see from `eye`, at crouch and standing height?
  computeVisibility(eye) {
    const L = this.game.level;
    this.visFrom.copy(eye);
    const occ = L.occluders;
    for (let z = 0; z < this.H; z++) for (let x = 0; x < this.W; x++) {
      const k = x + z * this.W;
      const cx = x + 0.5, cz = z + 0.5;
      const d = Math.hypot(cx - eye.x, cz - eye.z);
      if (d > 22 || !L.walkable(x, z)) { this.visLow[k] = this.visHigh[k] = 0; continue; }
      this.visLow[k] = this.los(eye, _a.set(cx, 1.0, cz), occ) ? 1 : 0;
      this.visHigh[k] = this.visLow[k] || this.los(eye, _a.set(cx, 1.55, cz), occ) ? 1 : 0;
    }
  }

  los(a, b, occ) {
    _b.copy(b).sub(a);
    const dist = _b.length();
    this.ray.set(a, _b.divideScalar(dist));
    this.ray.far = dist - 0.05;
    return this.ray.intersectObjects(occ, false).length === 0;
  }

  claimed(pos, by) {
    for (const e of this.members) {
      if (e === by || !e.coverPos) continue;
      if (Math.hypot(e.coverPos.x - pos.x, e.coverPos.z - pos.z) < 1.2) return true;
    }
    return false;
  }

  // Find a cell that hides `e` from the player but lets him lean out to shoot.
  // mode: 'hold' (near where he is), 'advance' (closer to the player), 'retreat'
  findCover(e, mode = 'hold', radius = 6) {
    const L = this.game.level, P = this.game.player.pos;
    const ex = Math.floor(e.pos.x), ez = Math.floor(e.pos.z);
    const myD = Math.hypot(e.pos.x - P.x, e.pos.z - P.z);
    let best = null, bestScore = -1e9;
    for (let z = ez - radius; z <= ez + radius; z++) for (let x = ex - radius; x <= ex + radius; x++) {
      if (!L.walkable(x, z)) continue;
      const k = x + z * this.W;
      if (this.visLow[k]) continue; // he'd be seen even crouched
      const c = L.cellCenter(x, z);
      const dP = Math.hypot(c.x - P.x, c.z - P.z);
      if (dP < 2.5 || dP > 18) continue;
      if (this.claimed(c, e)) continue;
      let peek = null, half = false;
      if (this.visHigh[k]) half = true; // furniture: crouch to hide, stand to shoot
      else {
        for (let dz = -1; dz <= 1 && !peek; dz++) for (let dx = -1; dx <= 1 && !peek; dx++) {
          if ((dx || dz) && L.passable(x, z, x + dx, z + dz) && this.visHigh[(x + dx) + (z + dz) * this.W]) peek = L.cellCenter(x + dx, z + dz);
        }
        if (!peek) continue;
      }
      const travel = Math.hypot(c.x - e.pos.x, c.z - e.pos.z);
      let score = -travel * 0.8 - Math.abs(dP - e.prefRange) * 0.35 + (half ? 0.6 : 0);
      if (L.room(x, z) !== L.room(ex, ez)) score -= 1.5; // prefer to stay put
      if (mode === 'advance') { if (dP > myD - 1.5) continue; score += (myD - dP) * 1.2; }
      if (mode === 'retreat') { if (dP < myD) continue; score += (dP - myD); }
      if (score > bestScore) { bestScore = score; best = { pos: c, peek, half }; }
    }
    return best;
  }

  // A spot near the player, seen from an angle the others aren't covering.
  findFlankSpot(e) {
    const L = this.game.level, P = this.game.player.pos;
    const others = this.members.filter((o) => o !== e && o.engaged);
    const avg = new THREE.Vector2();
    for (const o of others) avg.add(new THREE.Vector2(o.pos.x - P.x, o.pos.z - P.z).normalize());
    let best = null, bestScore = -1e9;
    for (let z = 0; z < this.H; z++) for (let x = 0; x < this.W; x++) {
      if (!L.walkable(x, z) || !this.visHigh[x + z * this.W]) continue;
      const c = L.cellCenter(x, z);
      const v = new THREE.Vector2(c.x - P.x, c.z - P.z);
      const d = v.length();
      if (d < 3 || d > 8) continue;
      v.normalize();
      const sep = others.length ? -v.dot(avg.clone().normalize()) : 0; // 1 = opposite the others
      const score = sep * 3 - Math.abs(d - 5) * 0.3 - Math.hypot(c.x - e.pos.x, c.z - e.pos.z) * 0.08 + Math.random() * 0.5;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // Path cost that keeps flankers out of the player's sight.
  stealthCost() {
    return (x, z) => (this.visHigh[x + z * this.W] ? 6 : 0);
  }
}
