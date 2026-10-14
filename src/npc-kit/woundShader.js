import * as THREE from 'three';

// Shared wound/stain state injected into every material of one NPC.
// Wounds are tracts in bind space (entry -> exit/stop) with a radius at each
// end; each material cuts its own hole size (clothes tear, skin holes, fat
// rings, muscle and organs). Back faces seen through a hole render as raw,
// wet tissue. Stains are blood sources that run downward and soak fabric.

export const MAX_WOUNDS = 64;
export const MAX_BONES = 168;
export const MAX_STAINS = 32;

export function createGoreUniforms() {
  return {
    uWoundA: { value: Array.from({ length: MAX_WOUNDS }, () => new THREE.Vector4()) },
    uWoundB: { value: Array.from({ length: MAX_WOUNDS }, () => new THREE.Vector4()) },
    uWoundCount: { value: 0 },
    uStain: { value: Array.from({ length: MAX_STAINS }, () => new THREE.Vector4()) },
    uStainDir: { value: Array.from({ length: MAX_STAINS }, () => new THREE.Vector4(0, -1, 0, 0.05)) },
    uStainCount: { value: 0 },
    uGoreTime: { value: 0 },
    uXRay: { value: 0 },
    uPallor: { value: 0 },     // haemorrhagic shock / death
    uCyanosis: { value: 0 },   // low oxygen saturation
    // dismemberment: 1 for every bone that has been cut away. Vertices skinned to
    // those bones are discarded (or, with uCutKeep = 1, everything else is: the gib).
    uCut: { value: new Float32Array(MAX_BONES) },
    uCutKeep: { value: 0 },
  };
}

const COMMON = /* glsl */`
#define MAX_WOUNDS ${MAX_WOUNDS}
#define MAX_STAINS ${MAX_STAINS}
uniform vec4 uWoundA[MAX_WOUNDS];
uniform vec4 uWoundB[MAX_WOUNDS];
uniform int uWoundCount;
uniform vec4 uStain[MAX_STAINS];
uniform vec4 uStainDir[MAX_STAINS];
uniform int uStainCount;
uniform float uGoreTime;
uniform float uXRay;
uniform float uPallor;
uniform float uCyanosis;
uniform float uRevealDist; // >0: tissue only exists within this distance (m) of a wound tract
uniform float uLayerScale;
uniform float uGoreKind; // 0 skin, 1 cloth, 2 tissue, 3 fat, 4 bone
uniform float uReveal;   // 1: only exists around wounds (skin hidden under clothes)
uniform float uCutKeep;
varying vec3 vBindPos;
varying float vCut;

float g_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float g_noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(g_hash(i), g_hash(i + vec3(1,0,0)), f.x), mix(g_hash(i + vec3(0,1,0)), g_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(g_hash(i + vec3(0,0,1)), g_hash(i + vec3(1,0,1)), f.x), mix(g_hash(i + vec3(0,1,1)), g_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// distance to the nearest wound tract in units of its local radius (<1 = inside)
float woundField(vec3 p, out float tAlong, out float dAbs) {
  float best = 1e6; tAlong = 0.0; dAbs = 1e6;
  for (int i = 0; i < MAX_WOUNDS; i++) {
    if (i >= uWoundCount) break;
    vec3 a = uWoundA[i].xyz; vec3 b = uWoundB[i].xyz;
    vec3 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
    float d = length(p - a - ab * t);
    float r = mix(uWoundA[i].w, uWoundB[i].w, smoothstep(0.0, 1.0, t)) * uLayerScale;
    dAbs = min(dAbs, d - r);
    float rag = 0.65 + 0.7 * g_noise(p * 700.0 + float(i) * 13.1) + 0.3 * g_noise(p * 2500.0);
    float f = d / max(r * rag, 1e-5);
    if (f < best) { best = f; tAlong = t; }
  }
  return best;
}
// blood running down from each source; w = amount (0..1+)
float stainField(vec3 p) {
  float s = 0.0;
  for (int i = 0; i < MAX_STAINS; i++) {
    if (i >= uStainCount) break;
    vec3 d = p - uStain[i].xyz;
    vec3 down = normalize(uStainDir[i].xyz);
    float along = dot(d, down);
    vec3 side = d - down * along;
    float amt = uStain[i].w;
    float width = 0.012 + 0.05 * sqrt(amt);
    float len = uStainDir[i].w;
    float runs = 0.55 + 0.45 * g_noise(vec3(side.x * 160.0, side.z * 160.0, float(i)));
    float lat = exp(-dot(side, side) / (width * width * runs));
    float lng = along < 0.0 ? exp(-along * along / (width * width * 0.6)) : exp(-pow(along / max(len, 0.005), 2.0));
    s += min(amt * 3.0, 1.0) * lat * lng;
  }
  return clamp(s, 0.0, 1.0);
}
`;

export function applyGore(material, uniforms, kind, layerScale = 1, { revealOnly = false, revealDist = 0 } = {}) {
  const prev = material.onBeforeCompile;
  material.side = THREE.DoubleSide;
  material.userData.goreKind = kind;
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.uniforms.uLayerScale = { value: layerScale };
    sh.uniforms.uGoreKind = { value: kind };
    sh.uniforms.uReveal = { value: revealOnly ? 1 : 0 };
    sh.uniforms.uRevealDist = { value: revealDist };
    material.userData.shader = sh;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBindPos;
        varying float vCut;
        uniform float uCut[${MAX_BONES}];`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBindPos = position;
        vCut = 0.0;
        #ifdef USE_SKINNING
          vCut = skinWeight.x * uCut[int(skinIndex.x)] + skinWeight.y * uCut[int(skinIndex.y)]
               + skinWeight.z * uCut[int(skinIndex.z)] + skinWeight.w * uCut[int(skinIndex.w)];
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uCutKeep > 0.5 ? vCut < 0.5 : vCut > 0.5) discard;
        float gT; float gD; float gW = woundField(vBindPos, gT, gD);
        if (gW < 1.0) discard;
        if (uRevealDist > 0.0 && uXRay < 0.5 && gD > uRevealDist) discard;
        if (uReveal > 0.5 && gW > 3.5) discard;
        float gStain = (uGoreKind < 1.5 || uGoreKind > 3.5) ? stainField(vBindPos) : 0.0;
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float rim = 1.0 - smoothstep(1.0, 1.6, gW);      // torn edge
          float bruise = 1.0 - smoothstep(1.2, 4.0, gW);   // contusion halo
          if (!gl_FrontFacing) {
            // looking into the wound: raw, wet tissue
            vec3 raw = uGoreKind < 0.5 ? vec3(0.32, 0.02, 0.02) : uGoreKind < 1.5 ? diffuseColor.rgb * 0.35 :
                       uGoreKind > 3.5 ? vec3(0.55, 0.42, 0.36) : mix(diffuseColor.rgb * 0.5, vec3(0.30, 0.01, 0.01), 0.55);
            diffuseColor.rgb = raw * (0.7 + 0.3 * g_noise(vBindPos * 900.0));
          } else if (uGoreKind < 0.5) {
            // shock pallor (blood leaves the skin: waxy, grey-yellow) and cyanosis (blue-grey)
            float lum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
            vec3 pale = vec3(lum * 1.08, lum * 1.04, lum * 0.92);
            diffuseColor.rgb = mix(diffuseColor.rgb, pale, uPallor * 0.85);
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.84, 1.08), uCyanosis * 0.7);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.10, 0.14), bruise * 0.45);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.03, 0.02), rim * 0.9);
          } else if (uGoreKind < 1.5) {
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.35, rim);   // scorched/frayed fibres
          } else {
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.25, 0.01, 0.01), rim * 0.8 + bruise * 0.35);
          }
          // blood: bright when fresh on skin, soaks dark into fabric
          vec3 blood = uGoreKind > 0.5 && uGoreKind < 1.5 ? vec3(0.09, 0.005, 0.005) : vec3(0.22, 0.004, 0.003);
          diffuseColor.rgb = mix(diffuseColor.rgb, blood, gStain * (uGoreKind > 0.5 && uGoreKind < 1.5 ? 0.92 : 0.85));
        }
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.12, max(gStain, (!gl_FrontFacing ? 0.85 : 0.0)));
        roughnessFactor = mix(roughnessFactor, 0.15, (1.0 - smoothstep(1.0, 1.8, gW)));
      `);
  };
  const key = material.customProgramCacheKey ? material.customProgramCacheKey() : '';
  material.customProgramCacheKey = () => key + '|gore' + kind + (revealOnly ? 'r' : '');
  material.needsUpdate = true;
  return material;
}
