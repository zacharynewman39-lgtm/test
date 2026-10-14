import * as THREE from 'three';

// Blood soaking into skin and clothes. Each mesh gets a small mask painted in
// its own UV space at the exact spot a bullet went in; the material darkens and
// goes wet wherever the mask is red. Works for any mesh with UVs, so it carries
// straight over to the real anatomical model.

export class BloodMask {
  constructor(size = 128) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, size, size);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
  }

  // uv in 0..1, radius in UV units, strength 0..1
  paint(uv, radius, strength = 1) {
    const g = this.ctx, s = this.size;
    const x = (uv.x % 1 + 1) % 1 * s, y = (1 - (uv.y % 1 + 1) % 1) * s;
    const r = Math.max(1.5, radius * s);
    g.save();
    g.globalCompositeOperation = 'lighter';
    // draw wrapped copies so stains cross UV seams on tiling islands
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      const cx = x + ox, cy = y + oy;
      if (cx + r < 0 || cx - r > s || cy + r < 0 || cy - r > s) continue;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, `rgba(255,0,0,${strength})`);
      gr.addColorStop(0.6, `rgba(255,0,0,${strength * 0.5})`);
      gr.addColorStop(1, 'rgba(255,0,0,0)');
      g.fillStyle = gr;
      g.beginPath();
      // ragged edge
      for (let i = 0; i <= 12; i++) {
        const a = i / 12 * Math.PI * 2, rr = r * (0.75 + Math.random() * 0.35);
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.fill();
      // a run of blood dragged downward in texture space
      if (strength > 0.4 && Math.random() < 0.6) {
        g.fillStyle = `rgba(255,0,0,${strength * 0.6})`;
        g.fillRect(cx - r * 0.12, cy, r * 0.24, r * (1 + Math.random() * 2));
      }
    }
    g.restore();
    this.texture.needsUpdate = true;
  }
}

// Patch a standard material so it reads a BloodMask.
export function bloodify(material, mask, color = new THREE.Color(0.16, 0.004, 0.004)) {
  material.userData.bloodMask = mask;
  material.onBeforeCompile = (sh) => {
    sh.uniforms.bloodMap = { value: mask.texture };
    sh.uniforms.bloodColor = { value: color };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBloodUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBloodUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D bloodMap;\nuniform vec3 bloodColor;\nvarying vec2 vBloodUv;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float bloodAmt = texture2D(bloodMap, vBloodUv).r;
        float bloodWet = smoothstep(0.03, 0.55, bloodAmt);
        diffuseColor.rgb = mix(diffuseColor.rgb, bloodColor * (0.6 + 0.5 * bloodAmt), bloodWet);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.4, bloodWet * 0.8);`);
  };
  material.customProgramCacheKey = () => 'blood-v1';
  return material;
}
