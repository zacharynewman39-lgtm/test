# NPC Sandbox

A blank 3D plane, a block you drive around in third person, and one NPC: a
detailed, realistically built man. The NPC is the point of this project; the
rest is kept deliberately simple.

## Run it

```bash
npm install
npm run dev        # open the printed localhost URL
```

Controls:

| Input | Action |
| --- | --- |
| Click | Capture the mouse to look around |
| W A S D | Move the block |
| Shift | Run |
| Space | Jump |
| Mouse wheel | Zoom the camera |
| Left click (mouse captured) | Fire at the crosshair |
| 1 / 2 / 3 | Pistol / rifle / shotgun |
| X | Cycle the anatomy x-ray views |
| R | Reset him (heal, clear blood) |
| F | Inspect mode: orbit his head up close (drag to orbit, scroll to zoom, F again to exit) |

The panel at the top right shows his live vitals and a log of what each shot
went through.

To use the NPC in another game, see **[INTEGRATION.md](INTEGRATION.md)**.

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

## Inside him

**Anatomy.** BodyParts3D (CC BY 4.0) was fitted into his body. There are
2,175 structures: every bone, about 400 muscles, 420 arteries and 225 veins,
the heart, liver, stomach and intestines, kidneys, spleen, the brain and
brainstem, and more.

Fitting works in four steps:

1. His rig is posed to match the reference.
2. The anatomy is warped onto him with a thin-plate spline, using joint
   landmarks and a skin match.
3. Interior skin weights are solved by Laplace diffusion inside his body.
4. Everything is un-posed back to his bind pose.

Lungs, the spinal cord, peripheral nerves and subcutaneous fat aren't in the
source, so they're synthesised.

**Physiology** (`src/npc-kit/physiology.js`):

- Circulation starts at 4,979 mL of blood (70 mL/kg).
- Bleeds are driven by vessel calibre and blood pressure, and arterial bleeds
  pulse with his heartbeat.
- Blood loss moves him through haemorrhagic shock classes I–IV.
- Specific injuries have specific effects:
  - brain or brainstem: instant death
  - heart: pump failure and tamponade
  - lungs: pneumothorax or haemothorax, falling oxygen, coughing blood
  - high spinal cord: he stops breathing
  - nerves: limb failure
  - pelvis or femur fracture: he collapses
- His skin shows pallor with blood loss and cyanosis with low oxygen.

**Gore physics** (`src/npc-kit/`):

- Shots are traced through every tissue they cross, losing energy along the
  way. Rifles also tear organs near the path (temporary cavity).
- Wound holes go through every layer, with raw tissue visible inside.
- Arterial jets pulse with his heartbeat.
- Blood droplets fly ballistically. Splatter stretches in the direction of
  impact, and pools spread out and clot.
- Blood soaks and runs down his clothes.
- He collapses into a Verlet ragdoll.

## Rebuilding the model

The `public/npc/` assets come from the scripts in `tools/npc/`. Running
those scripts requires Python 3 with `numpy`, `scipy` and `Pillow`, plus a
checkout of MakeHuman's data:

```bash
git clone --depth 1 https://github.com/makehumancommunity/makehuman.git /tmp/makehuman
python3 tools/npc/build_npc.py --mh /tmp/makehuman/makehuman/data   # geometry, rig, hair -> npc.glb, hair.bin
python3 tools/npc/textures.py --size 4096                           # skin/eye/fabric textures

# anatomy (needs the BodyParts3D data packed by github.com/ashemag/human-atlas)
git clone --depth 1 https://github.com/ashemag/human-atlas.git /tmp/atlas
pip install fast-simplification scikit-image
python3 tools/npc/anatomy/build_anatomy.py --mh /tmp/makehuman/makehuman/data --bp3d /tmp/atlas/public/models
```

What each part controls:

| What to change | Where to change it |
| --- | --- |
| Body and face shape | `MACRO` and `FACE` in `build_npc.py` |
| Grooming | `hair.py` |
| Clothing | `clothes.py` |
| Skin painting | `textures.py` |
| Shading | `src/npc-kit/materials.js` |
| Behaviour | `src/npc-kit/npc.js` |
| Anatomy fit | `tools/npc/anatomy/` |
| Damage and physiology | `src/npc-kit/physiology.js` |
| Wounds and blood | `src/npc-kit/woundShader.js`, `src/npc-kit/blood.js` |
| Ragdoll | `src/npc-kit/ragdoll.js` |

## Credits

The base mesh, targets, skeleton, skin weights and eye mesh are from
[MakeHuman](http://www.makehumancommunity.org/), released as CC0.

The internal anatomy is from BodyParts3D, © The Database Center for Life
Science, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
and adapted here (fitted, simplified, extended). It was obtained via the
packed release in [human-atlas](https://github.com/ashemag/human-atlas).
Any game that uses it must credit it.

Everything else was written for this project.
