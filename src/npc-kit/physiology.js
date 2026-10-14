// Whole-body physiology for one NPC.
//
// Circulation: blood volume (70 mL/kg), heart rate, mean arterial pressure,
// cardiac output. Every damaged vessel/organ becomes a bleed whose flow
// depends on its calibre and on the current pressure (arterial bleeds pulse
// with each heartbeat; venous/capillary bleeds ooze and clot). Blood loss
// drives haemorrhagic shock (ATLS classes I-IV): tachycardia, falling
// pressure, loss of consciousness, cardiac arrest.
//
// Organ effects: brain/brainstem -> instant death; heart -> massive bleed,
// tamponade, arrest; lungs -> pneumothorax/haemothorax, falling SpO2;
// trachea -> airway compromise; high cervical cord -> apnoea, lower cord ->
// paralysis; major nerves -> limb failure; long-bone/pelvis fractures ->
// cannot stand (pelvis/femur bleed heavily); liver/spleen/kidney -> heavy
// internal bleeding.

const ARTERY_R = [
  [/aorta/i, 11], [/pulmonary trunk|left pulmonary artery|right pulmonary artery/i, 9],
  [/brachiocephalic artery/i, 6], [/common carotid/i, 3.5], [/internal carotid/i, 2.6], [/external carotid/i, 2.2],
  [/subclavian artery/i, 4], [/axillary artery/i, 3.5], [/vertebral artery/i, 2], [/brachial artery/i, 2.3],
  [/radial artery|ulnar artery/i, 1.3], [/common iliac/i, 5], [/external iliac/i, 4], [/internal iliac/i, 3],
  [/femoral artery/i, 4.5], [/popliteal artery/i, 3], [/tibial artery|fibular artery/i, 1.6],
  [/renal artery/i, 3], [/mesenteric artery|celiac/i, 3.5], [/splenic artery|hepatic artery/i, 2.5],
  [/coronary/i, 1.5], [/intercostal artery/i, 1],
];
const VEIN_R = [
  [/vena cava/i, 11], [/brachiocephalic vein/i, 7], [/internal jugular/i, 5.5], [/subclavian vein/i, 5],
  [/axillary vein/i, 4.5], [/portal vein/i, 6], [/hepatic vein/i, 5], [/common iliac vein/i, 6],
  [/external iliac vein/i, 5], [/femoral vein/i, 5], [/popliteal vein/i, 3.5], [/renal vein/i, 4],
  [/pulmonary vein/i, 6], [/great saphenous/i, 2.5], [/cephalic vein|basilic vein/i, 2],
];

const LIMB_NERVES = {
  leg: /sciatic|femoral nerve|tibial nerve|common fibular|cauda equina/i,
  arm: /brachial plexus|median nerve|ulnar nerve|radial nerve/i,
};
const LEG_BONES = /femur|tibia|hip bone|patella|talus|calcaneus/i;
const ARM_BONES = /humerus|radius|ulna|scapula|clavicle/i;

const lookup = (table, name, fallback) => {
  for (const [re, r] of table) if (re.test(name)) return r;
  return fallback;
};
const sideOf = (name) => (/^left\b|\bleft\b/i.test(name) ? 'L' : /^right\b|\bright\b/i.test(name) ? 'R' : null);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Physiology {
  constructor(meta) {
    this.mass = meta.body.mass_kg;
    this.blood0 = meta.body.blood_volume_ml;
    this.blood = this.blood0;
    this.t = 0;
    this.hr = 72; this.map = 93; this.sbp = 120; this.dbp = 80; this.co = 5.2;
    this.rr = 14; this.spo2 = 0.98; this.consciousness = 1; this.pain = 0;
    this.alive = true; this.arrest = false; this.cause = null; this.timeOfDeath = null;
    this.phase = 0; // cardiac cycle 0..1
    this.heart = 1; this.tamponade = 0; this.brain = 1;
    this.lung = { L: 1, R: 1 }; this.pneumo = { L: 0, R: 0 }; this.hemothorax = 0; this.airway = 1;
    this.apnoea = false; this.cord = null; // {level:'C3', paralysis:'tetra'|'para'}
    this.limbs = { armL: 1, armR: 1, legL: 1, legR: 1 };
    this.fracture = { armL: false, armR: false, legL: false, legR: false, pelvis: false, skull: false };
    this.concussion = 0;
    this.bleeds = [];
    this.internalLoss = 0; this.externalLoss = 0;
    this.events = [];
    this.lowPerfusionTime = 0; this.hypoxiaTime = 0;
  }

  log(text) { this.events.push({ t: this.t, text }); }

  get lossFraction() { return 1 - this.blood / this.blood0; }
  get shockClass() {
    const l = this.lossFraction;
    return l < 0.15 ? 1 : l < 0.30 ? 2 : l < 0.40 ? 3 : 4;
  }
  get canStand() {
    // after cardiac arrest the brain keeps ~10 s of oxygen: he can stagger before dropping
    return this.brain > 0 && this.consciousness > 0.35 && this.limbs.legL > 0.4 && this.limbs.legR > 0.4 &&
      !this.fracture.legL && !this.fracture.legR && !this.fracture.pelvis && !this.cord;
  }

  die(cause) {
    if (!this.alive) return;
    this.alive = false; this.arrest = true; this.cause = cause; this.timeOfDeath = this.t;
    this.log('DEAD: ' + cause);
  }

  addBleed(b) {
    this.bleeds.push(Object.assign({ clot: 0, age: 0, external: 0.5, pulsatile: false }, b));
  }

  // hit: { segments: [{part, length}], anchors: {entry, exit}, energy }
  damage(hit) {
    this.pain = Math.min(1, this.pain + 0.35);
    const seen = new Set();
    const organKey = (p) => ['liver', 'spleen', 'kidney', 'heart', 'heart_blood', 'lung', 'stomach', 'intestine', 'colon', 'pancreas'].includes(p.tissue)
      ? p.tissue.replace('heart_blood', 'heart') + (sideOf(p.name) || '') : 'id' + p.id;
    const merged = new Map();
    for (const seg of hit.segments) {
      const k = organKey(seg.part);
      const m = merged.get(k);
      if (m) m.length = Math.min(0.2, m.length + seg.length); else merged.set(k, { ...seg });
    }
    for (const seg of merged.values()) {
      const p = seg.part; const n = p.name; const L = seg.length; // metres travelled in the part
      if (seen.has(p.id)) continue; seen.add(p.id);
      const side = sideOf(n);
      const anchor = hit.exitAnchor && seg.nearExit ? hit.exitAnchor : hit.entryAnchor;
      const torso = /thorax|abdom|lung|liver|spleen|kidney|heart|aorta|vena cava|intestin|stomach|colon|pancrea|mesenter|renal|iliac|portal|hepat/i.test(n) ||
        ['lung', 'liver', 'spleen', 'kidney', 'heart', 'heart_blood', 'intestine', 'colon', 'stomach', 'pancreas'].includes(p.tissue);
      const ext = torso ? 0.3 : 0.85;
      switch (p.tissue) {
        case 'brain': case 'white_matter': case 'cerebellum': case 'brainstem': case 'csf':
          this.brain = 0;
          this.consciousness = 0;
          this.addBleed({ part: n, rate: 6, external: 0.9, anchor, pulsatile: true });
          this.die(p.tissue === 'brainstem' ? 'brainstem destroyed (' + n + ')' : 'penetrating brain injury (' + n + ')');
          break;
        case 'spinal_cord': {
          const y = p.centre ? seg.y : 0;
          const level = seg.cordLevel || 'T';
          const high = /^C[1-4]$/.test(level);
          this.cord = { level, paralysis: high || /^C/.test(level) ? 'tetra' : 'para' };
          if (high) { this.apnoea = true; this.log(`spinal cord severed at ${level}: respiratory paralysis`); } else this.log(`spinal cord severed at ${level}: ${this.cord.paralysis}plegia`);
          if (/^C/.test(level)) { this.limbs.armL = this.limbs.armR = 0; }
          this.limbs.legL = this.limbs.legR = 0;
          break;
        }
        case 'heart': case 'heart_blood': {
          // through-and-through ventricles: pump failure within seconds
          this.heart = Math.max(0, this.heart - Math.min(0.95, 0.35 + 8 * L));
          this.addBleed({ part: n, rate: 60 * Math.min(1, L / 0.03 + 0.3), external: 0.15, anchor, pulsatile: true, cavity: 'pericardium' });
          this.log('heart penetrated: ' + n);
          break;
        }
        case 'artery': {
          const r = lookup(ARTERY_R, n, Math.min(p.radius_mm || 1, 3));
          const frac = Math.min(1, (hit.radius * 1000) / r + 0.25);
          this.addBleed({ part: n, rate: 1.6 * r * r * frac, external: ext, anchor, pulsatile: true });
          if (r >= 3) this.log(`major artery hit: ${n} (~${Math.round(1.6 * r * r * frac * 60)} mL/min)`);
          if (/carotid|vertebral/i.test(n)) this.brainFlowLoss = (this.brainFlowLoss || 0) + 0.3;
          break;
        }
        case 'vein': {
          const r = lookup(VEIN_R, n, Math.min(p.radius_mm || 1, 3));
          const frac = Math.min(1, (hit.radius * 1000) / r + 0.25);
          this.addBleed({ part: n, rate: 0.55 * r * r * frac, external: ext, anchor, clots: true });
          break;
        }
        // solid organ lacerations: heavy, mostly internal (haemoperitoneum), slow to clot
        case 'liver': this.addBleed({ part: n, rate: 2.5 + 70 * L, external: 0.12, anchor, clots: true, slow: true }); this.log('liver laceration'); break;
        case 'spleen': this.addBleed({ part: n, rate: 3 + 80 * L, external: 0.08, anchor, slow: true }); this.log('spleen ruptured'); break;
        case 'kidney': this.addBleed({ part: n, rate: 1.5 + 45 * L, external: 0.1, anchor, clots: true }); this.log('kidney hit'); break;
        case 'lung': {
          const s = /left/i.test(n) ? 'L' : 'R';
          this.pneumo[s] = Math.max(this.pneumo[s], 0.02);
          this.addBleed({ part: n, rate: 1.5 + 40 * L, external: 0.1, anchor, clots: true, cavity: 'thorax' });
          this.log(`${s === 'L' ? 'left' : 'right'} lung punctured: pneumothorax`);
          break;
        }
        case 'airway':
          if (/bronchial tree/i.test(n)) {
            // segmental bronchi sit inside the lung: a lung wound that also bleeds into the airway
            const s2 = /left/i.test(n) ? 'L' : 'R';
            this.pneumo[s2] = Math.max(this.pneumo[s2], 0.02);
            this.addBleed({ part: n, rate: 1 + 25 * L, external: 0.1, anchor, clots: true, cavity: 'thorax', aspirate: true });
            this.log(`${s2 === 'L' ? 'left' : 'right'} lung punctured: pneumothorax, blood in the airway`);
            break;
          }
          this.airway = Math.max(0, this.airway - 0.5);
          this.addBleed({ part: n, rate: 1.2, external: 0.6, anchor, clots: true, aspirate: true });
          this.log('airway breached: aspirating blood');
          break;
        case 'nerve': {
          if (LIMB_NERVES.leg.test(n)) { if (side) this.limbs['leg' + side] = Math.min(this.limbs['leg' + side], /sciatic|femoral/i.test(n) ? 0.1 : 0.5); else this.limbs.legL = this.limbs.legR = 0.2; this.log(n + ' cut: leg gives way'); }
          if (LIMB_NERVES.arm.test(n) && side) { this.limbs['arm' + side] = Math.min(this.limbs['arm' + side], 0.2); this.log(n + ' cut: arm paralysed'); }
          if (/phrenic/i.test(n)) this.lung[side || 'L'] *= 0.6;
          if (/vagus/i.test(n)) this.hr += 15;
          this.pain = 1;
          break;
        }
        case 'bone': case 'cartilage': case 'disc': {
          if (/frontal|parietal|occipital|temporal|sphenoid|ethmoid/i.test(n)) { this.fracture.skull = true; this.concussion = Math.max(this.concussion, 0.8); this.log('skull fractured'); }
          if (LEG_BONES.test(n) && side) { this.fracture['leg' + side] = true; this.log(n + ' fractured'); }
          if (/hip bone|sacrum/i.test(n)) { this.fracture.pelvis = true; this.addBleed({ part: n, rate: 8, external: 0.05, anchor, slow: true }); this.log('pelvis fractured: retroperitoneal bleeding'); }
          if (/femur/i.test(n)) this.addBleed({ part: n, rate: 4, external: 0.4, anchor, clots: true });
          if (ARM_BONES.test(n) && side) { this.fracture['arm' + side] = true; this.limbs['arm' + side] = Math.min(this.limbs['arm' + side], 0.3); this.log(n + ' fractured'); }
          if (/rib/i.test(n)) this.pain = 1;
          if (/vertebra|axis|atlas/i.test(n) && !this.cord && L > 0.015) {
            // a bullet through the vertebral body/arch risks the cord
            const m = /(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) (cervical|thoracic|lumbar)/i.exec(n);
            if (m && Math.random() < 0.6) this.damage({ segments: [{ part: { id: -1, name: 'Spinal cord', tissue: 'spinal_cord' }, length: 0.01, cordLevel: levelOf(m) }], entryAnchor: anchor, radius: hit.radius });
            if (/^(atlas|axis)$/i.test(n)) this.damage({ segments: [{ part: { id: -2, name: 'Spinal cord', tissue: 'spinal_cord' }, length: 0.01, cordLevel: 'C1' }], entryAnchor: anchor, radius: hit.radius });
          }
          this.addBleed({ part: n, rate: 0.3, external: ext, anchor, clots: true });
          break;
        }
        case 'muscle':
          this.addBleed({ part: n, rate: 0.12 + 6 * L, external: ext, anchor, clots: true });
          break;
        case 'stomach': case 'intestine': case 'colon': case 'pancreas': case 'mesentery': case 'esophagus':
          this.addBleed({ part: n, rate: 0.8 + 20 * L, external: 0.15, anchor, clots: true });
          this.log(n + ' perforated');
          break;
        default:
          this.addBleed({ part: n, rate: 0.08 + 2 * L, external: ext, anchor, clots: true });
      }
    }
    // skin itself
    this.addBleed({ part: 'skin', rate: 0.05, external: 1, anchor: hit.entryAnchor, clots: true });
  }

  step(dt) {
    this.t += dt;
    const loss = this.lossFraction;

    // ------------------------------------------------ heart & pressure
    const tamp = smooth(80, 220, this.tamponade);           // pericardial blood stops filling
    const pump = this.arrest ? 0 : Math.max(0, this.heart) * (1 - tamp);
    const preload = Math.max(0, 1 - 1.9 * Math.max(0, loss - 0.12));
    const hrTarget = this.arrest ? 0 :
      loss > 0.42 ? 150 - 260 * (loss - 0.42) :              // pre-terminal bradycardia
        72 + 85 * smooth(0.10, 0.40, loss) + 25 * this.pain + 30 * (1 - this.spo2 / 0.98) - 15 * this.concussion;
    this.hr += (Math.max(0, hrTarget) - this.hr) * Math.min(1, dt * 1.5);
    const mapTarget = this.arrest ? 6 : 93 * preload * (0.35 + 0.65 * pump) * (0.92 + 0.12 * smooth(0.0, 0.3, loss));
    this.map += (mapTarget - this.map) * Math.min(1, dt * (this.arrest ? 0.6 : 2.0));
    const pp = this.arrest ? 0 : 40 * preload * pump;
    this.sbp = this.map + pp * 0.66; this.dbp = Math.max(0, this.map - pp * 0.33);
    this.co = this.arrest ? 0 : this.hr * 0.07 * preload * pump;
    this.phase = (this.phase + dt * this.hr / 60) % 1;

    // ------------------------------------------------ breathing / oxygen
    const collapseRate = 0.015;
    for (const s of ['L', 'R']) {
      if (this.pneumo[s] > 0) this.pneumo[s] = Math.min(1, this.pneumo[s] + collapseRate * dt);
    }
    this.hemothorax = this.bleeds.filter((b) => b.cavity === 'thorax').reduce((a, b) => a + (b.lost || 0) * (1 - b.external), 0);
    const lungFn = 0.5 * (this.lung.L * (1 - this.pneumo.L) + this.lung.R * (1 - this.pneumo.R)) * (1 - smooth(500, 2000, this.hemothorax));
    const ventilation = this.apnoea || this.arrest || this.brain <= 0 ? 0 : lungFn * this.airway;
    this.rr = ventilation <= 0 ? 0 : 14 + 22 * smooth(0.15, 0.45, loss) + 16 * (1 - lungFn);
    const spo2Target = ventilation <= 0 ? 0.0 : 0.98 - 0.45 * (1 - Math.min(1, ventilation * 1.6));
    // apnoea: O2 reserve lasts ~1-2 min before saturation collapses
    const rate = spo2Target < this.spo2 ? (ventilation <= 0 ? 0.0011 : 0.03) : 0.1;
    this.spo2 += (spo2Target - this.spo2) * Math.min(1, dt * rate * 10);
    this.spo2 = Math.max(0, Math.min(0.99, this.spo2));

    // ------------------------------------------------ bleeding
    const pressure = Math.max(0, this.map) / 93;
    let total = 0;
    for (const b of this.bleeds) {
      b.age += dt;
      let q;
      if (b.pulsatile) {
        // pressure-driven, surges each systole
        const wave = this.arrest ? 0 : Math.max(0, Math.sin(this.phase * Math.PI * 2)) ** 2;
        q = b.rate * Math.sqrt(pressure) * (this.arrest ? 0.05 * Math.exp(-(this.t - (this.timeOfDeath ?? this.t)) / 45) : 0.45 + 1.1 * wave);
        b.surge = wave;
      } else {
        q = b.rate * (0.35 + 0.65 * pressure);
        if (this.arrest) q = b.rate * 0.08 * Math.exp(-(this.t - (this.timeOfDeath ?? this.t)) / 45); // passive drainage, tapering
      }
      if (b.clots) { b.clot = Math.min(0.92, b.clot + dt / (b.slow ? 400 : 140)); q *= 1 - b.clot; }
      if (b.cavity === 'pericardium') { this.tamponade += q * dt * 0.35; }
      b.flow = q;
      b.lost = (b.lost || 0) + q * dt;
      total += q;
      this.externalLoss += q * dt * b.external;
      this.internalLoss += q * dt * (1 - b.external);
    }
    this.blood = Math.max(0, this.blood - total * dt);
    this.bleedRate = total;

    // ------------------------------------------------ consciousness & death
    const cpp = this.map - 10;                      // cerebral perfusion
    const perf = smooth(25, 55, cpp) * (1 - (this.brainFlowLoss || 0) * 0.5);
    const oxy = smooth(0.45, 0.75, this.spo2);
    this.concussion = Math.max(0, this.concussion - dt * 0.03);
    const cTarget = this.brain <= 0 ? 0 : Math.min(perf, oxy) * (1 - 0.8 * this.concussion);
    this.consciousness += (cTarget - this.consciousness) * Math.min(1, dt * (cTarget < this.consciousness ? 0.25 : 0.1));
    this.pain = Math.max(0, this.pain - dt * 0.05);

    if (this.alive) {
      this.lowPerfusionTime = this.map < 28 ? this.lowPerfusionTime + dt : 0;
      this.hypoxiaTime = this.spo2 < 0.4 ? this.hypoxiaTime + dt : 0;
      if (this.heart <= 0.1) this.die('cardiac destruction');
      else if (tamp > 0.95) this.die('cardiac tamponade');
      else if (loss > 0.55) this.die('exsanguination (' + Math.round(this.blood0 - this.blood) + ' mL lost)');
      else if (this.lowPerfusionTime > 6) this.die('haemorrhagic shock: cardiac arrest');
      else if (this.hypoxiaTime > 60) this.die(this.apnoea ? 'respiratory paralysis: hypoxic arrest' : 'hypoxic cardiac arrest');
    }
    return this;
  }

  vitals() {
    return {
      alive: this.alive, cause: this.cause, hr: Math.round(this.hr), bp: `${Math.round(this.sbp)}/${Math.round(this.dbp)}`,
      map: Math.round(this.map), spo2: Math.round(this.spo2 * 100), rr: Math.round(this.rr),
      blood_ml: Math.round(this.blood), lost_ml: Math.round(this.blood0 - this.blood),
      lossPct: Math.round(this.lossFraction * 100), shockClass: this.shockClass,
      bleed_ml_min: Math.round((this.bleedRate || 0) * 60), consciousness: +this.consciousness.toFixed(2),
      internal_ml: Math.round(this.internalLoss), external_ml: Math.round(this.externalLoss),
    };
  }
}

function levelOf(m) {
  const ord = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 }[m[1].toLowerCase()];
  return { cervical: 'C', thoracic: 'T', lumbar: 'L' }[m[2].toLowerCase()] + ord;
}
