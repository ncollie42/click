// Owns: LIGHT-STAGE modifications injected into existing Lambert/Toon materials via
// onBeforeCompile — the pixel look's two material-side features, applied WITHOUT replacing any
// material object (game code holds material references for tints/ghosts/dispose; swapping
// objects would break those silently):
//
//   1. ANALYTIC CLOUD SHADE (uCloudShade): the direct sun term is multiplied by
//      (1 - cloudCoverAt(worldPos)) — the same field the god rays and every other cloud consumer
//      read (cloud-field.js). This replaces the shadow-plane's binary dithered shade with a
//      SMOOTH penumbra on every receiver, object sides included ("material" cloudsMode, the
//      default; the plane and image-fold modes remain as A/B).
//   2. TOON RAMP (uToonOn, Lambert materials only): the directional dotNL is routed through the
//      shared gradient map (toon-ramp.js semantics: a texel is an effective NdotL) — game-wide
//      adoption of the round-5 audition. Materials that must stay smooth (terrain, fog) opt out
//      with material.userData.noToonRamp = true. MeshToonMaterial already has its own ramp and
//      only receives the cloud term.
//   3. TONE TARGETS (uLmDirectTint / uLmShadeTint, per material): t3ssel8r's "each material has
//      an authored highlight/midtone/shadow colour", done INSIDE the multiplicative rig instead of
//      as a second lighting model. setToneTargets() solves two per-channel tints so that a flat
//      sun-lit face renders EXACTLY the lit swatch and a fully shaded face (hemi only) EXACTLY the
//      shadow swatch; cloud penumbra / shadow-map edges blend linearly between them. Terrain and
//      grass use it (palette.js TONES); everything else keeps the plain rig (tints = 1). Night
//      still scales the sun term, fog/emissives/baked models are untouched — the Aug 22 for/against
//      review chose this over a three-tone branch for exactly those reasons.
//
// WIRING (both hosts do the same): call initLightMods(THREE, ramp) once, applyLightingMods(scene)
// every frame BEFORE the render (new materials are patched before their first compile), and
// syncLightMods(...) every frame with values from pixelTune. All patched materials share ONE
// uniforms object, so the sync is O(1).
//
// The injections string-replace against three r160's exact chunk text (verified in
// vendor/three.module.min.js: lights_lambert_pars_fragment / lights_toon_pars_fragment). If an
// upgrade changes a pattern, the material is left UNPATCHED and one loud console.error names it —
// a broken pattern must never take the renderer down.

import {CLOUD_UNIFORMS_GLSL, CLOUD_FIELD_GLSL} from "./cloud-field.js";
import {makeGradientMap} from "./toon-ramp.js";

let shared = null;         // the one uniforms object every patched material references
let THREE_ = null;
let seen = new WeakSet();  // materials already patched (or deliberately skipped)

/** True once initLightMods has run — i.e. applyLightingMods will actually patch materials.
 *  Consumer: grass.js, whose shader must only reference vLmWorld when the patch will land. */
export function lightModsActive(){ return shared !== null; }

export function initLightMods(THREE, {rampSteps, rampLevels}){
  THREE_ = THREE;
  shared = {
    uCloudScale: {value: 0.038}, uCloudSpeed: {value: 0.01}, uCloudCover: {value: 0.38},
    uTime: {value: 0}, uCloudOffset: {value: new THREE.Vector2(0, 0)},
    uCloudShade: {value: 0},   // 1 only in cloudsMode "material"
    uLmCloudMax: {value: 0.8}, // how much of the direct term a full cloud removes (1 = as dark as cast shadow)
    uLmCloudHeight: {value: 60},
    uLmSunDir: {value: new THREE.Vector3(0, 1, 0)},
    uToonOn: {value: 0},
    uToonRamp: {value: makeGradientMap(THREE, {steps: rampSteps, levels: rampLevels})},
  };
  seen = new WeakSet();
  return shared;
}

// Own world-position varying, computed with three's exact batching/instancing pattern —
// worldpos_vertex is #ifdef-guarded on features we can't rely on, so we never borrow it.
// COUPLING (grass.js): the grass material replaces the literal `#include <begin_vertex>`, so the
// VERT_BODY insertion below deliberately no-ops there and grass assigns vLmWorld itself AFTER its
// billboard/wind displacement (this capture point would read the pre-displacement vertex). The
// declaration in VERT_DECL is still ours; grass guards its assignment behind its GRASS_LM define.
const VERT_DECL = "varying vec3 vLmWorld;\n";
const VERT_BODY = `
{
  vec4 lmWorld = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    lmWorld = batchingMatrix * lmWorld;
  #endif
  #ifdef USE_INSTANCING
    lmWorld = instanceMatrix * lmWorld;
  #endif
  vLmWorld = ( modelMatrix * lmWorld ).xyz;
}
`;
const FRAG_DECL = `
varying vec3 vLmWorld;
${CLOUD_UNIFORMS_GLSL}
uniform float uCloudShade, uToonOn, uLmCloudHeight, uLmCloudMax;
uniform vec3 uLmSunDir;
uniform vec3 uLmDirectTint, uLmShadeTint;   // per material (setToneTargets); (1,1,1) = stock
uniform sampler2D uToonRamp;
${CLOUD_FIELD_GLSL}
// Project along the SUN to the cloud plane, exactly like pixel.js's cloudShadowAt — sampling the
// field at the surface's own xz instead displaces the shade by cloudHeight/tan(el) (~35 wu at a
// 60-degree sun) and every other consumer (god rays, the plane, the fold) disagrees with it.
float lmSunShade(){
  if(uCloudShade < 0.5) return 1.0;
  vec2 uv = vLmWorld.xz;
  if(uLmSunDir.y > 0.08){
    float t = (uLmCloudHeight - vLmWorld.y) / uLmSunDir.y;
    uv += uLmSunDir.xz * max(t, 0.0);
  }
  // uLmCloudMax < 1 keeps a sliver of sun under full cloud, so cloud shade sits a step LIGHTER
  // than canopy/cast shadow (the reference's canopy reads darker than its clouds).
  return 1.0 - cloudCoverAt(uv) * uLmCloudMax;
}
`;

// The exact statements inside three r160's chunks that the injections re-write.
const LAMBERT_DOT = "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );";
const LAMBERT_IRR = "vec3 irradiance = dotNL * directLight.color;";
const TOON_IRR = "vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;";
const INDIRECT = "RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

function fail(mat, what){
  console.error(`[light-mods] ${what} pattern not found — three chunk changed? material "${mat.name || mat.type}" left stock`);
  return null;
}

/** Patch one material in place. `toon` = route Lambert dotNL through the shared ramp. */
function patchMaterial(mat, toon){
  const prior = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prior?.(shader, renderer);
    let frag = shader.fragmentShader;
    const parsKey = mat.isMeshToonMaterial ? "lights_toon_pars_fragment" : "lights_lambert_pars_fragment";
    const marker = `#include <${parsKey}>`;
    if(!frag.includes(marker)) return fail(mat, marker);
    // Expand the include ourselves so the statement-level replaces below can see the code.
    let pars = ThreeChunks[parsKey];
    if(mat.isMeshToonMaterial){
      if(!pars.includes(TOON_IRR)) return fail(mat, "toon irradiance");
      pars = pars.replace(TOON_IRR,
        "vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color * lmSunShade() * uLmDirectTint;");
    }else{
      if(!pars.includes(LAMBERT_DOT) || !pars.includes(LAMBERT_IRR)) return fail(mat, "lambert dotNL/irradiance");
      if(toon){
        // Effective-NdotL ramp (toon-ramp.js semantics), toggleable at runtime via uToonOn.
        pars = pars.replace(LAMBERT_DOT,
          LAMBERT_DOT + "\n\tif( uToonOn > 0.5 ) dotNL = texture2D( uToonRamp, vec2( dotNL * 0.5 + 0.5, 0.0 ) ).r;");
      }
      pars = pars.replace(LAMBERT_IRR, "vec3 irradiance = dotNL * directLight.color * lmSunShade() * uLmDirectTint;");
    }
    frag = frag.replace(marker, FRAG_DECL + pars);
    // Indirect (hemi/ambient) term × the shade tint — expand lights_fragment_end so the statement
    // is visible to the replace.
    const endMarker = "#include <lights_fragment_end>";
    const endChunk = ThreeChunks.lights_fragment_end;
    if(!frag.includes(endMarker) || !endChunk.includes(INDIRECT)) return fail(mat, "lights_fragment_end indirect");
    frag = frag.replace(endMarker, endChunk.replace(INDIRECT,
      "RE_IndirectDiffuse( irradiance * uLmShadeTint, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );"));
    shader.fragmentShader = frag;
    shader.vertexShader = VERT_DECL + shader.vertexShader.replace("#include <begin_vertex>",
      "#include <begin_vertex>" + VERT_BODY);
    Object.assign(shader.uniforms, shared);
    // Per-material tone uniforms (NOT shared): created lazily so setToneTargets can run before or
    // after the first compile and the same objects are what the program reads.
    shader.uniforms.uLmDirectTint = toneUniform(mat, "lmDirectTint");
    shader.uniforms.uLmShadeTint = toneUniform(mat, "lmShadeTint");
  };
  // Distinct program per patch variant, or three would reuse a stock material's compiled program.
  mat.customProgramCacheKey = () => `lm:${mat.isMeshToonMaterial ? "toon" : "lambert"}:${toon ? 1 : 0}`;
  mat.needsUpdate = true;
}

function toneUniform(mat, key){
  return mat.userData[key] ??= {value: new THREE_.Vector3(1, 1, 1)};
}
const srgbToLin = c => c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
const hexLin = h => [srgbToLin((h >> 16 & 255) / 255), srgbToLin((h >> 8 & 255) / 255), srgbToLin((h & 255) / 255)];
/**
 * Solve a material's two tone tints so its flat sun-lit face renders `lit` and its fully shaded
 * (hemi-only, up-facing) face renders `shadow`, given the albedo the material actually carries.
 * Three physical-light Lambert: out = albedo/π × (sunI·sunCol·ndotl·directTint + hemiI·sky·shadeTint)
 * on an up-facing face (hemi weight 1). Solved per channel:
 *   shadeTint  = shadow·π / (albedo·hemiI·sky)
 *   directTint = (lit − shadow)·π / (albedo·sunI·sunCol·ndotl)
 * Faces with other albedos (the meadow's green0 patches) scale proportionally — a patch in shadow
 * reads as a lighter shadow, which is the reference's green0/green0/green2 behaviour.
 * `rig` mirrors scene.js's lights; pass the same numbers the predictor uses (palette-snap.mjs).
 */
export function setToneTargets(mat, {albedo, lit, shadow, rig}){
  const a = hexLin(albedo), l = hexLin(lit), sh = hexLin(shadow);
  const sun = hexLin(rig.sunColor), sky = hexLin(rig.skyColor);
  const direct = toneUniform(mat, "lmDirectTint").value, shade = toneUniform(mat, "lmShadeTint").value;
  const out = [0, 0, 0], outS = [0, 0, 0];
  for(let i = 0; i < 3; i++){
    const den = Math.max(1e-5, a[i]);
    outS[i] = sh[i] * Math.PI / (den * rig.hemiIntensity * Math.max(1e-5, sky[i]));
    out[i] = Math.max(0, l[i] - sh[i]) * Math.PI / (den * rig.sunIntensity * Math.max(1e-5, sun[i]) * rig.ndotl);
  }
  direct.set(out[0], out[1], out[2]);
  shade.set(outS[0], outS[1], outS[2]);
  return {direct: out, shade: outS};
}

// The chunk sources, captured once from the THREE namespace at init (vendored r160).
let ThreeChunks = null;

/**
 * Patch every not-yet-seen Lambert/Toon material in the scene. Call each frame BEFORE rendering:
 * materials created this frame compile on the coming render, so the patch always lands first.
 * Cost when nothing is new: one traverse + WeakSet hits.
 */
export function applyLightingMods(THREE, scene){
  if(!shared) return;
  if(!ThreeChunks) ThreeChunks = THREE.ShaderChunk;
  scene.traverse(o => {
    if(!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for(const m of mats){
      if(!m || seen.has(m)) continue;
      seen.add(m);
      if(!(m.isMeshLambertMaterial || m.isMeshToonMaterial)) continue;
      patchMaterial(m, m.isMeshLambertMaterial && m.userData.noToonRamp !== true);
    }
  });
}

/** Per-frame value sync; every patched material sees these through the shared references. */
export function syncLightMods({cloudScale, cloudSpeed, cloudCover, cloudOffsetX, cloudOffsetZ,
                               cloudHeight, sunDir, time, cloudShade, toon, cloudMax}){
  if(!shared) return;
  shared.uCloudScale.value = cloudScale;
  shared.uCloudSpeed.value = cloudSpeed;
  shared.uCloudCover.value = cloudCover;
  shared.uCloudOffset.value.set(cloudOffsetX || 0, cloudOffsetZ || 0);
  shared.uLmCloudHeight.value = cloudHeight || 60;
  if(sunDir) shared.uLmSunDir.value.copy(sunDir).normalize();
  shared.uTime.value = time;
  shared.uCloudShade.value = cloudShade ? 1 : 0;
  shared.uLmCloudMax.value = cloudMax ?? 0.8;
  shared.uToonOn.value = toon ? 1 : 0;
}
