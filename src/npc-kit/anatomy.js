import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';

// Interior anatomy (BodyParts3D, CC BY 4.0, fitted to this body): bones,
// muscles, organs, arteries, veins, nerves, brain/spinal cord, fat.
// Meshes are skinned to the NPC skeleton; every vertex knows its part id.

export const LAYERS = ['fat', 'muscle', 'skeleton', 'organs', 'arteries', 'veins', 'nerves', 'cns'];

// The anatomy is parsed once (colours converted, BVHs built) and every NPC
// gets its own SkinnedMeshes over the same geometry. `parts` lets the .glb be
// served as several chunks (hosts with a per-file size cap).
const cache = new Map();
function loadShared(base, parts) {
  const key = base + (parts ? parts.join() : '');
  if (cache.has(key)) return cache.get(key);
  const glb = parts
    ? Promise.all(parts.map((p) => fetch(base + p).then((r) => r.arrayBuffer()))).then((bufs) => {
      const out = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
      let o = 0;
      for (const b of bufs) { out.set(new Uint8Array(b), o); o += b.byteLength; }
      return new GLTFLoader().parseAsync(out.buffer, base);
    })
    : new GLTFLoader().loadAsync(base + 'anatomy.glb');
  const p = Promise.all([glb, fetch(base + 'anatomy.json').then((r) => r.json())]).then(([gltf, meta]) => {
    const geos = {};
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh) geos[o.name.replace(/^anat_/, '')] = prepare(o.geometry); });
    return { geos, meta };
  });
  cache.set(key, p);
  return p;
}

function prepare(g) {
  // vertex colours were authored as sRGB display colours
  const c = g.getAttribute('color');
  if (c) {
    const lin = new Float32Array(c.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < c.count; i++) {
      col.setRGB(c.getX(i), c.getY(i), c.getZ(i), THREE.SRGBColorSpace);
      lin[i * 3] = col.r; lin[i * 3 + 1] = col.g; lin[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(lin, 3));
  }
  g.boundsTree = new MeshBVH(g, { maxLeafTris: 12 });
  return g;
}

export async function loadAnatomy(base, bodyMesh, parts = null) {
  const { geos, meta } = await loadShared(base, parts);
  const layers = {};
  const pickables = [];
  for (const [name, geo] of Object.entries(geos)) {
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    // share the NPC's skeleton so the anatomy moves with the body
    mesh.bind(bodyMesh.skeleton, bodyMesh.bindMatrix);
    mesh.name = 'anat_' + name;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = false; // revealed by wounds / x-ray
    mesh.userData.layer = name;
    layers[name] = mesh;
    pickables.push(mesh);
  }
  return { layers, meta, parts: meta.parts, pickables };
}

// Every hit of a bind-space ray against a geometry's BVH (sorted by distance).
export function raycastAll(geometry, ray, far) {
  const hits = geometry.boundsTree.raycast(ray, THREE.DoubleSide, 0, far);
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

export function partOfFace(geometry, faceIndex) {
  const a = geometry.index.getX(faceIndex * 3);
  return geometry.getAttribute('_part').getX(a);
}
