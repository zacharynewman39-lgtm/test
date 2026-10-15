# Black House (working title)

A dark, gory, solo SWAT-style FPS that runs in the browser. You raid a
cult-occupied house alone at night: clear it room by room, free the hostages
before they're executed, and put down every suspect.

## Run it

```bash
npm install
npm run dev        # open the printed localhost URL
```

| Input | Action |
| --- | --- |
| W A S D | Move |
| Space (hold) | Sprint |
| C | Crouch (toggle) |
| Q / E | Lean left / right |
| Mouse, LMB | Look, fire (rifle is semi-auto) |
| Shift or RMB | Aim down sights |
| R | Reload |
| 1 / 2 or wheel | Rifle / shotgun |
| G | Throw a flashbang (3) |
| F | Open/close doors; hold to free a hostage |
| V | Kick a door open or a suspect back |
| T | Flashlight |

## What's in it

- **The house** (`src/game/level.js`): an ASCII floor plan with 8 rooms,
  hinged doors, furniture, flickering lights and a nav grid. Edit `MAP`,
  `OPENINGS`, `FURNITURE` and `SPAWNS` to change the layout.
- **Suspects** (`src/game/enemy.js`, `squad.js`): masked cultists with their
  own personalities (aggression, skill, reaction time, preferred range).
  - When you make noise, the two closest go to investigate with weapons up and
    the rest dig in and hold an angle on the noise.
  - Once you're spotted, the squad hands out roles:
    - Holders take cover and peek.
    - A pusher leapfrogs from cover to cover toward you.
    - Flankers route around out of your sight.
  - Cover is chosen from a live map of what you can see.
  - Rounds cracking past them pin them down, and pinned suspects blind-fire
    around corners. They reload, call out to each other, and retreat when hurt.
  - Ambushers crouch and wait. One plays dead until you walk past. The
    executioner goes for the hostage the moment he spots you.
- **Wounds** (`src/game/body.js`, `actor.js`): every hit resolves to an
  organ (brain, heart, lungs, liver, spine, femoral artery…). Each organ has
  its own damage, bleed rate and effect:
  - Leg hits cause limping, and both legs (or the spine) put him on the floor
    crawling at you.
  - A gun-hand hit disarms him.
  - Heart and neck hits cause panic, then he bleeds out.
- **Gore** (`src/game/gore.js`, `blood.js`, `actor.js`):
  - Every body carries about 5 L of blood. Wounds bleed by organ, and a suspect
    goes down after losing about 1.7 L.
  - Exit wounds are traced through the body, and that side gets the mess.
  - Rifle rounds penetrate bodies and doors.
  - Blood soaks into clothes and skin around each wound (painted per mesh in UV
    space) and spreads while he bleeds.
  - Neck and femoral hits pulse arterial jets.
  - Wall splatter runs down the wall.
  - Pools spread under bodies, and walking through one leaves bloody
    footprints.
  - Limbs can be severed, heads can explode, and stumps keep pumping.
- **Hostages** (`src/game/hostage.js`): hooded and kneeling, and they sob.
  Free them with E and they run for the street. Your bullets hurt them too.
- **Audio** (`src/game/audio.js`): every sound is synthesised, positional, and
  muffled through walls.

## Swapping in the real enemy model

The enemies currently use a placeholder body made of primitives. Everything
else talks to it through the `Body` class in `src/game/body.js`. To use the
anatomical model, write a replacement with the same surface:

| Member | What it must do |
| --- | --- |
| `root` | Object3D with feet at the origin, facing +z |
| `j` | Named joints (`pelvis`, `spine`, `chest`, `neck`, `head`, `uArmL`… `footR`) that the pose functions rotate |
| `hitMeshes` | Meshes bullets can hit, each with `userData.body` and `userData.part` |
| `resolveHit(mesh, point)` | Return `{ part, organ, side, info }`. With real organs this becomes "which organ mesh did the ray hit" |
| `sever(part, scene)`, `destroyHead(scene)` | Detach a limb or head and return the stump |
| `addWound`, `blendPose`, `world`, `headPos` | As in the placeholder |

Drop the model into `public/` as a `.glb`. Keep internal layers (muscle,
organs, bones, nerves) as separate named meshes so hits can be resolved
against them directly.

## Headless testing

Open `/?test` to get `window.__game.test.start()` and `.step(n)`, which
advance the simulation deterministically and return a screenshot.

---

# NPC sandbox

The original detailed-NPC sandbox is still available at `/sandbox.html`.

## The man

He's a fit man of about 38, 1.81 m tall, in a t-shirt, jeans and leather boots.

**Body.** The anatomy starts from MakeHuman's CC0 base mesh. It's shaped
with age, gender, muscle, weight and proportion targets, plus about 30 facial
targets (squarer jaw, slight nose hump, cheekbones, laugh lines, under-eye
bags). The mesh is then Catmull-Clark subdivided to about 56k vertices.

**Rig.** The 163-bone MakeHuman skeleton is included, with face, finger and
toe bones and linear blend skinning.

**Skin.** Skin is shaded with wrapped, red-shifted diffuse light (a cheap
subsurface scattering). Thin areas like the ears, eyelids, nostrils and
fingers let back-light through. There's also a vellus-hair sheen, a thin oily
clearcoat, and a tiling pore/furrow detail normal map.

**Skin textures.** All skin textures are baked procedurally in UV space from
the 3D surface. That puts every feature where it belongs on the body:

- Colour from blood and melanin: redder cheeks, nose, ears, knuckles and
  elbows; blotchiness; freckles and a few moles; dark circles under the eyes;
  faint temple veins
- A beard-shadow stubble pattern drawn as individual follicles, and darkened
  scalp under the hair
- Lips with vertical striations; fingernails with lunulae; a dark-red mouth
  interior
- Wrinkles as a normal map: forehead lines, glabella lines, crow's feet,
  under-eye lines, nasolabial folds, neck rings and knuckle creases
- Roughness that is oilier on the T-zone and wet on the lips, plus
  ambient-occlusion/cavity and translucency maps

**Eyes.** The eyeballs have a procedural iris with radial fibres, crypts, a
collarette, an amber centre over blue-green, and a limbal ring. The sclera has
veins. A separate refractive cornea dome sits over each eye.

**Hair.**

- About 90,000 individually grown scalp strands with a side part, a crown
  whorl, clumping, a feathered hairline, short tapered sides, a longer top and
  some grey at the temples
- About 2,200 herringbone-patterned eyebrow hairs
- Upper and lower eyelashes that curl and follow the eyelids when he blinks

**Clothes.** The garments are cut from a body-fitting shell, then draped
against the body. They have geometric folds (ankle stacking, knee bunching,
crotch whiskers, armpit drag) and finished edges: a rib collar, rolled hems
and a waistband. The jeans are 3/1 twill denim with wear fading. The shirt is
jersey knit. The boots are pebbled leather with a welt and rubber sole.

**Behaviour.**

- He breathes and shifts his weight
- He turns his head and eyes toward you, with saccades
- He blinks (sometimes twice), and his lids follow his gaze
- When you come close he flashes his eyebrows and gives a soft smile
- His nostrils flare as he breathes

## Rebuilding the model

The `public/npc/` assets come from the scripts in `tools/npc/`. Running
those scripts requires Python 3 with `numpy`, `scipy` and `Pillow`, plus a
checkout of MakeHuman's data:

```bash
git clone --depth 1 https://github.com/makehumancommunity/makehuman.git /tmp/makehuman
python3 tools/npc/build_npc.py --mh /tmp/makehuman/makehuman/data   # geometry, rig, hair -> npc.glb, hair.bin
python3 tools/npc/textures.py --size 4096                           # skin/eye/fabric textures
```

What each part controls:

| What to change | Where to change it |
| --- | --- |
| Body and face shape | `MACRO` and `FACE` in `build_npc.py` |
| Grooming | `hair.py` |
| Clothing | `clothes.py` |
| Skin painting | `textures.py` |
| Shading | `src/materials.js` |
| Behaviour | `src/npc.js` |

## Credits

The base mesh, targets, skeleton, skin weights and eye mesh are from
[MakeHuman](http://www.makehumancommunity.org/), released as CC0. Everything
else was written for this project.
