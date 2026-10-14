# NPC kit: integration guide

Paste this into the chat that has your game. It explains how to drop in the
realistic NPC (full anatomy, physiology, gore, ragdoll) built in
https://github.com/zacharynewman39-lgtm/test/tree/claude/detailed-npc-character-uflqtd

## What you get

- A realistic adult man, skinned and rigged with 163 bones. He idles, breathes,
  blinks, and tracks the camera with his eyes and head.
- Real anatomy inside him, fitted to his body:
  - every bone, about 400 muscles, and 640 arteries and 400 veins
  - heart, lungs, liver, stomach, intestines, kidneys, spleen and pancreas
  - brain, brainstem, spinal cord, and the major peripheral nerves
  - subcutaneous fat
- Ballistics: every shot is traced through each tissue it crosses (for
  example skin → pectoralis → 4th rib → left lung → aorta), losing energy
  in each one. It may stop inside him or exit, and it can carry on into
  another body part (arm into chest).
- Physiology: he starts with 4,979 mL of blood (70 mL/kg).
  - Every damaged vessel or organ bleeds at a rate set by its calibre and the
    current blood pressure. Arterial bleeds pulse with his heartbeat.
  - Blood loss moves him through haemorrhagic shock classes I–IV, then
    unconsciousness, then cardiac arrest.
  - Brain or brainstem hits kill instantly.
  - Heart wounds cause pump failure and tamponade. He drops after about 5 s,
    once the brain's oxygen runs out.
  - Lung wounds cause pneumothorax or haemothorax, falling SpO2, and coughing
    blood.
  - Spinal cord injuries cause tetraplegia or paraplegia. At C1–C4 he stops
    breathing.
  - Cut nerves make limbs fail. Femur or pelvis fractures drop him to the
    ground.
  - His skin goes pale with blood loss and blue when his oxygen falls.
- Gore physics:
  - Wound holes go through the clothes, skin, fat and muscle into the organs,
    and you see raw wet tissue inside.
  - Arterial jets spurt in time with his heartbeat, using a pressure-driven
    velocity.
  - Blood droplets fly ballistically with air drag. Spatter decals stretch in
    the direction of impact.
  - Pools grow by volume (3 mm deep), spread out from under the body, and
    darken as they clot.
  - Blood soaks into and runs down his clothes.
  - High-energy hits throw out bone chips, brain matter and blood mist.
- Death: a Verlet ragdoll crumples him. He has agonal twitches, a slack jaw,
  half-open eyes and fixed gaze.

## 1. Copy the files

From the repo (download the ZIP:
https://github.com/zacharynewman39-lgtm/test/archive/refs/heads/claude/detailed-npc-character-uflqtd.zip ):

| From the repo | Into your game |
| --- | --- |
| `src/npc-kit/` | anywhere in your source, e.g. `src/npc-kit/` |
| `public/npc/` | a folder your web server serves, e.g. `public/npc/` → `/npc/` |

`public/npc/` holds about 45 MB of models and textures. Copy the whole folder.

## 2. Install the dependencies

```bash
npm install three three-mesh-bvh
```

The kit was tested with three r170 and three-mesh-bvh 0.8. It uses ES modules
and `three/addons/...` imports, so it works with Vite and other modern
bundlers.

## 3. Use it

```js
import * as THREE from 'three';
import { createGoreWorld, WEAPONS } from './npc-kit/index.js';

// once, after you create your scene/renderer
const gore = createGoreWorld({
  scene,
  renderer,
  baseUrl: '/npc/',                 // where public/npc/ is served
  groundHeight: (x, z) => 0,        // your terrain height (blood pools + ragdoll use it)
});

const npc = await gore.spawnNPC({ position: new THREE.Vector3(0, 0, -5), rotationY: 0 });

// every frame
gore.update(dt, { camera, playerPos: player.position });

// when your weapon fires (origin + direction in world space, e.g. from the camera)
const report = gore.shoot(origin, direction, 'rifle');   // 'pistol' | 'rifle' | 'shotgun' | custom
// report = { hit, npc, parts: ['Left femoral artery', ...], events: ['major artery hit: ...'] }

// optional callbacks
gore.onHit = (npc, res) => {};
gore.onDown = (npc) => {};              // collapsed (unconscious / legs gone / dead)
gore.onDeath = (npc, cause) => console.log('dead:', cause);
```

### Useful state

| Call | What it gives you |
| --- | --- |
| `npc.vitals` | `{ alive, cause, hr, bp, map, spo2, rr, blood_ml, lost_ml, lossPct, shockClass, bleed_ml_min, consciousness, internal_ml, external_ml }` |
| `npc.alive`, `npc.position`, `npc.root` | Whether he's alive, his position, and his root `THREE.Object3D` |
| `npc.reset()` | Heals him completely. Also call `gore.blood.clear()` to remove the blood. |
| `npc.dispose()` | Removes him from the scene |
| `gore.setXRay(0..4)` | Anatomy viewer: 0 off, 1 muscles, 2 organs/vessels/skeleton, 3 skeleton/nerves/CNS, 4 circulation |
| `gore.shoot(origin, dir, { energy, entryR, cavity, pellets, spread, push })` | Fires a custom weapon. `energy` is in joules. `entryR` is the hole radius in metres. `cavity` is the temporary-cavity radius in metres. |

### Renderer settings that make him look right

```js
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
scene.environment = /* any PMREM environment, e.g. from three's Sky or RoomEnvironment */;
```

Use a directional light with shadows as the key light, plus a hemisphere
light.

## Limits

- **Behaviour:** he has no AI or locomotion. He stands, idles, reacts to hits,
  collapses and dies. Your game's AI would drive movement.
- **Physics:** the ragdoll and blood collide with the ground (`groundHeight`).
  They don't collide with your other level geometry.
- **Performance:** one wounded NPC renders about 1.2M triangles, because the
  interior is only drawn once he's wounded. That's fine on desktop GPUs. For
  many NPCs at once you'd want LODs or anatomy shared between them.
- **Dismemberment:** there's none. Wounds are holes and channels; limbs don't
  come off.

## Credits (required in your game's credits)

- Anatomy: BodyParts3D, © The Database Center for Life Science, licensed
  under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), adapted
  (fitted, simplified, extended).
- Body base mesh, rig and eyes: MakeHuman (CC0).
