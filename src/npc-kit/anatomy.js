import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';

// Interior anatomy (BodyParts3D, CC BY 4.0, fitted to this body): bones,
// muscles, organs, arteries, veins, nerves, brain/spinal cord, fat.
// Meshes are skinned to the NPC skeleton; every vertex knows its part id.

export const LAYERS = ['fat', 'muscle', 'skeleton', 'organs', 'arteries', 'veins', 'nerves', 'cns'];

export async function loadAnatomy(base, bodyMesh) {
  const [gltf, meta] = await Promise.all([
    new GLTFLoader().loadAsync(base + 'anatomy.glb'),
    fetch(base + 'anatomy.json').then((r) => r.json()),
  ]);
  const layers = {};
  const pickables = [];
  gltf.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const name = o.name.replace(/^anat_/, '');
    layers[name] = o;
  });
  for (const [name, mesh] of Object.entries(layers)) {
    // share the NPC's skeleton so the anatomy moves with the body
    mesh.removeFromParent();
    mesh.bind(bodyMesh.skeleton, bodyMesh.bindMatrix);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = false; // revealed by wounds / x-ray
    mesh.userData.layer = name;
    const g = mesh.geometry;
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
