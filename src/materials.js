import * as THREE from 'three';

const loader = new THREE.TextureLoader();

function tex(url, { srgb = false, repeat = false, renderer } = {}) {
  return new Promise((resolve) => {
    loader.load(url, (t) => {
      t.flipY = false; // glTF uv convention
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (renderer) t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      resolve(t);
    }, undefined, () => resolve(null));
  });
}

// Skin: wrapped, red-shifted diffuse (cheap subsurface scattering), thin-area
// back-light translucency (ears, nostrils), pore detail normals and a soft
// sheen for vellus hair.
function patchSkin(mat, detail, sss) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailNormal = { value: detail };
    sh.uniforms.sssMap = { value: sss };
    sh.uniforms.detailRepeat = { value: 92.0 };
    sh.uniforms.detailStrength = { value: 0.55 };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', `
        uniform sampler2D sssMap;
        #include <lights_physical_pars_fragment>
      `.replace('#include <lights_physical_pars_fragment>',
        THREE.ShaderChunk.lights_physical_pars_fragment.replace(
          'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
          `
          float ndlRaw = dot( geometryNormal, directLight.direction );
          vec3 wrapW = vec3( 0.50, 0.24, 0.14 );
          vec3 sssIrr = clamp( ( ndlRaw + wrapW ) / ( 1.0 + wrapW ), 0.0, 1.0 );
          sssIrr = mix( vec3( dotNL ), sssIrr * sssIrr * ( 1.0 + wrapW ), 0.85 );
          reflectedLight.directDiffuse += sssIrr * directLight.color * BRDF_Lambert( material.diffuseColor );
          #ifdef USE_ROUGHNESSMAP
            float thin = texture2D( sssMap, vRoughnessMapUv ).b;
            float back = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 3.0 );
            float edge = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 2.0 );
            reflectedLight.directDiffuse += directLight.color * material.diffuseColor *
              vec3( 1.0, 0.22, 0.10 ) * thin * ( back * 1.6 + edge * 0.15 ) * 0.9;
          #endif
          `)))
      .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          vec3 dN = texture2D( detailNormal, vNormalMapUv * detailRepeat ).xyz * 2.0 - 1.0;
          dN.xy *= detailStrength;
          mapN = normalize( vec3( mapN.xy + dN.xy, mapN.z ) );
          normal = normalize( tbn * mapN );
        #else
          #include <normal_fragment_maps>
        #endif
      `)
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailNormal; uniform float detailRepeat; uniform float detailStrength;');
  };
  mat.customProgramCacheKey = () => 'skin-v1';
}

function patchFabric(mat, key) {
  // fabric normal maps repeat in metres along the garment's cylindrical uvs
  mat.customProgramCacheKey = () => key;
}

export async function makeMaterials(renderer, base) {
  const o = { renderer };
  const [albedo, normal, orm, detail, eye, knitN, denimA, denimN, leatherN] = await Promise.all([
    tex(base + 'skin_albedo.jpg', { srgb: true, ...o }),
    tex(base + 'skin_normal.jpg', o),
    tex(base + 'skin_orm.jpg', o),
    tex(base + 'skin_detail_normal.png', { repeat: true, ...o }),
    tex(base + 'eye.jpg', { srgb: true, ...o }),
    tex(base + 'knit_normal.png', { repeat: true, ...o }),
    tex(base + 'denim_albedo.jpg', { srgb: true, repeat: true, ...o }),
    tex(base + 'denim_normal.png', { repeat: true, ...o }),
    tex(base + 'leather_normal.png', { repeat: true, ...o }),
  ]);

  const skin = new THREE.MeshPhysicalMaterial({
    name: 'skin',
    color: albedo ? 0xffffff : 0xc89a82,
    map: albedo,
    normalMap: normal,
    roughnessMap: orm,
    aoMap: orm,
    aoMapIntensity: 0.7,
    roughness: 1.0,
    specularIntensity: 0.55,
    ior: 1.4,
    sheen: 0.35,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0.95, 0.80, 0.74),
    clearcoat: 0.05,
    clearcoatRoughness: 0.4,
  });
  if (normal && detail && orm) patchSkin(skin, detail, orm);

  const eyeMat = new THREE.MeshPhysicalMaterial({
    name: 'eye', map: eye, color: eye ? 0xffffff : 0xeeeeee, roughness: 0.25,
    specularIntensity: 0.6,
  });
  const cornea = new THREE.MeshPhysicalMaterial({
    name: 'cornea', color: 0xffffff, roughness: 0.0, metalness: 0,
    transmission: 1.0, thickness: 0.0006, ior: 1.25, specularIntensity: 1.0,
    envMapIntensity: 1.6, transparent: false,
  });
  const lash = new THREE.MeshStandardMaterial({
    name: 'lash', vertexColors: true, roughness: 0.7, envMapIntensity: 0.2, side: THREE.DoubleSide,
  });
  const brow = new THREE.MeshPhysicalMaterial({
    name: 'brow', vertexColors: true, roughness: 0.5, side: THREE.DoubleSide,
    anisotropy: 0.6, specularIntensity: 0.5,
  });
  const hair = new THREE.MeshPhysicalMaterial({
    name: 'hair', vertexColors: true, roughness: 0.42, side: THREE.DoubleSide,
    anisotropy: 0.7, specularIntensity: 0.2, envMapIntensity: 0.0,
    specularColor: new THREE.Color(0.85, 0.62, 0.45),
  });
  const teeth = new THREE.MeshPhysicalMaterial({
    name: 'teeth', color: 0xe9dfca, roughness: 0.22, clearcoat: 0.4, clearcoatRoughness: 0.2,
  });
  const tongue = new THREE.MeshPhysicalMaterial({
    name: 'tongue', color: 0xa8504c, roughness: 0.42, sheen: 0.4, sheenColor: new THREE.Color(1, 0.7, 0.7),
  });

  const repeat = (t, r) => { if (t) { t = t.clone(); t.repeat.set(r, r); t.needsUpdate = true; } return t; };
  const shirt = new THREE.MeshPhysicalMaterial({
    name: 'shirt', color: 0x3c4651, envMapIntensity: 0.6, roughness: 0.92, side: THREE.DoubleSide,
    normalMap: repeat(knitN, 110), normalScale: new THREE.Vector2(0.6, 0.6),
    sheen: 0.6, sheenRoughness: 0.8, sheenColor: new THREE.Color(0.32, 0.36, 0.42),
    vertexColors: true,
  });
  patchFabric(shirt, 'shirt');
  const denim = new THREE.MeshPhysicalMaterial({
    name: 'denim', color: denimA ? new THREE.Color(0.62, 0.72, 1.0) : 0x2b3a55, map: repeat(denimA, 28),
    normalMap: repeat(denimN, 28), normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.9, side: THREE.DoubleSide, sheen: 0.25, sheenRoughness: 0.85,
    sheenColor: new THREE.Color(0.22, 0.26, 0.34), vertexColors: true, envMapIntensity: 0.6,
  });
  const leather = new THREE.MeshPhysicalMaterial({
    name: 'leather', color: 0xffffff, vertexColors: true,
    normalMap: repeat(leatherN, 40), normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.28,
  });

  return { skin, eye: eyeMat, cornea, lash, brow, hair, teeth, tongue, shirt, denim, leather };
}
