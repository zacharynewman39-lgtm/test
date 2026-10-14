import * as THREE from 'three';

// Builds tapered hair ribbons from the compact strand file written by
// tools/npc/hair.py (write_strands). Positions are relative to the head bone.
export async function loadHairGeometry(url, seed = 1) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  const S = dv.getUint32(0, true);
  const K = dv.getUint32(4, true);
  const scale = dv.getFloat32(8, true);
  let o = 12;
  const pts = new Int16Array(buf.slice(o, o + S * K * 6)); o += S * K * 6;
  const nrm = new Int8Array(buf, o, S * 3); o += S * 3;
  const col = new Uint8Array(buf, o, S * 3); o += S * 3;
  const wid = new Uint16Array(buf.slice(o, o + S * 4));

  let rs = seed >>> 0;
  const rnd = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296);

  const nv = S * K * 2;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const color = new Float32Array(nv * 3);
  const index = new Uint32Array(S * (K - 1) * 6);
  const q = scale / 32767;
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3();
  const side = new THREE.Vector3(), fn = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  let vi = 0, ii = 0;
  for (let s = 0; s < S; s++) {
    N.set(nrm[s * 3] / 127, nrm[s * 3 + 1] / 127, nrm[s * 3 + 2] / 127).normalize();
    const cr = (col[s * 3] / 255) ** 2, cg = (col[s * 3 + 1] / 255) ** 2, cb = (col[s * 3 + 2] / 255) ** 2;
    const w0 = wid[s * 2] * 1e-6, w1 = wid[s * 2 + 1] * 1e-6;
    const roll = (rnd() - 0.5) * 1.2;
    const base = s * K * 3;
    const v0 = vi;
    for (let k = 0; k < K; k++) {
      const i = base + k * 3;
      P.set(pts[i] * q, pts[i + 1] * q, pts[i + 2] * q);
      const ia = base + Math.max(k - 1, 0) * 3, ib = base + Math.min(k + 1, K - 1) * 3;
      a.set(pts[ia], pts[ia + 1], pts[ia + 2]);
      b.set(pts[ib], pts[ib + 1], pts[ib + 2]);
      T.subVectors(b, a).normalize();
      side.crossVectors(T, N);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      fn.crossVectors(side, T).normalize();
      // roll the ribbon a little around the strand so not every hair faces out
      side.multiplyScalar(Math.cos(roll)).addScaledVector(fn, Math.sin(roll)).normalize();
      fn.crossVectors(side, T).normalize();
      if (fn.dot(N) < 0) fn.negate();
      const t = k / (K - 1);
      const hw = 0.5 * (w0 + (w1 - w0) * Math.pow(t, 1.6));
      // darker near the scalp (self shadowing), slightly lighter tips
      const ao = 0.28 + 0.72 * Math.pow(t, 0.55);
      const tip = 1 + 0.25 * t * t;
      for (let e = 0; e < 2; e++) {
        const sg = e ? 1 : -1;
        pos[vi * 3] = P.x + side.x * hw * sg;
        pos[vi * 3 + 1] = P.y + side.y * hw * sg;
        pos[vi * 3 + 2] = P.z + side.z * hw * sg;
        nor[vi * 3] = fn.x; nor[vi * 3 + 1] = fn.y; nor[vi * 3 + 2] = fn.z;
        uv[vi * 2] = t; uv[vi * 2 + 1] = e;
        color[vi * 3] = cr * ao * tip; color[vi * 3 + 1] = cg * ao * tip; color[vi * 3 + 2] = cb * ao * tip;
        vi++;
      }
    }
    for (let k = 0; k < K - 1; k++) {
      const A = v0 + k * 2, B = A + 1, C = A + 2, D = A + 3;
      index[ii++] = A; index[ii++] = C; index[ii++] = B;
      index[ii++] = B; index[ii++] = C; index[ii++] = D;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}
