// Owns: the rolling meadow — the seeded value-noise height field, the displaced plane, and the
// per-vertex grass/dirt albedo. Nothing else in the test scene may invent terrain heights:
// heightAt() is the single source of truth, and objects.js calls it to sit its props on the ground.
//
// Data flow: preset.TERRAIN (+ a seed) -> heightAt() -> a BufferGeometry with `position` displaced
// and a `color` attribute in LINEAR working space (three converts material colours to linear; a
// vertex-colour attribute is used verbatim, so THREE.Color's already-linear channels go straight
// in). Consumer: scene.js, which drops the mesh into the scene with receiveShadow.
//
// ROUND 5: the meadow can be banded at the material stage too (preset.TOON.terrain) — scene.js
// passes the shared gradient map in, or null for the stock Lambert. It is null by default, and
// that is a MEASURED choice, not a default-by-omission: see ROUND-LOG.md "Round 5 / terrain vs
// props". The albedos above were solved through the Lambert transfer at flat-ground NdotL.
//
// DELIBERATE GAP: no grass blades. The reference's blade texture is Red Giraffe's grass system;
// the owner excluded grass from this round. Everything here is macro colour only.

import {makeToonMaterial} from "../../src/render/toon-ramp.js";

const HASH_A = 0x27d4eb2d, HASH_B = 0x165667b1, HASH_C = 0x9e3779b1;

/** Integer-lattice hash -> [0,1). Deterministic across runs and machines (Math.imul is exact). */
function hash2(ix, iy, seed){
  let h = Math.imul(ix | 0, HASH_A) ^ Math.imul(iy | 0, HASH_B) ^ Math.imul(seed | 0, HASH_C);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y, seed){
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

/** fBm in [0,1]; `octaves` halvings of amplitude against 2.03x frequency (same shape as the
 *  cloud field's fBm in src/render/cloud-field.js, so hills and clouds read as one family). */
export function fbm(x, y, seed, octaves){
  let v = 0, a = 0.5, norm = 0;
  for(let k = 0; k < octaves; k++){
    v += a * vnoise(x, y, seed + k * 1013);
    norm += a;
    x = x * 2.03 + 17.7; y = y * 2.03 - 9.3;
    a *= 0.5;
  }
  return v / norm;
}

/** World height (wu) of the meadow at (x,z). The ONE height authority for this scene. */
export function heightAt(x, z, seed, terrain){
  const n = fbm(x / terrain.featureLen, z / terrain.featureLen, seed, terrain.octaves);
  return (n - 0.5) * 2 * terrain.amplitude;
}

/** Dirt weight in [0,1] at (x,z): crests + slope + a patch noise, matching the reference's
 *  brown caps on the far hilltops. Slope is passed in because the caller already has the normal. */
function dirtWeightAt(x, z, seed, terrain, heightNorm, slope){
  const patch = fbm(x / 46 + 11.3, z / 46 - 7.1, seed + 7717, 2);
  // dirtLeftBias tilts the mass toward -x (screen left): the reference has 59% of its warm
  // ground in the left third (CRITIC-R2 item 7) and crest/patch noise alone kept landing it right.
  // Normalised against the VISIBLE half-width (~37 wu at the round-4 camera), not the plane —
  // against the 160 wu plane the bias measured ±0.08 in frame, invisible.
  const side = (terrain.dirtLeftBias || 0) * (-x / 40);
  const drive = (heightNorm - terrain.dirtHeight) * 2.6 + (patch - 0.5) * 1.9 + slope * terrain.dirtSlope + side;
  return Math.max(0, Math.min(1, drive * 1.4 + 0.5));
}

/**
 * Build the meadow mesh. Returns {mesh, dispose}. `THREE` and `terrain` come from the caller so
 * this module imports nothing and stays trivially testable with node --check.
 */
export function buildTerrain(THREE, {seed, terrain, gradientMap = null}){
  const geo = new THREE.PlaneGeometry(terrain.size, terrain.size, terrain.segments, terrain.segments);
  geo.rotateX(-Math.PI / 2);            // plane XY -> world XZ, +y up
  const pos = geo.attributes.position;
  for(let i = 0; i < pos.count; i++)
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i), seed, terrain));
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // Vertex colours are LINEAR: THREE.Color(hex) converts sRGB->working(linear) on construction
  // (ColorManagement is on by default in r160), and the shader multiplies the attribute in
  // verbatim. Authoring the three albedos as hexes keeps them readable next to the reference.
  const grass = new THREE.Color(terrain.grass);
  const grassAlt = new THREE.Color(terrain.grassAlt);
  const dirt = new THREE.Color(terrain.dirt);
  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for(let i = 0; i < pos.count; i++){
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const heightNorm = Math.max(0, Math.min(1, y / (2 * terrain.amplitude) + 0.5));
    const slope = Math.max(0, 1 - nrm.getY(i));
    const tone = fbm(x / 120 - 3.7, z / 120 + 5.2, seed + 4231, 2);
    // grassAlt is a SPARSE bright patch, not a global tint: the gate opens at tone 0.55 (~15% of
    // the field) and saturates at 0.80 (~2%). A wide gate lifts the whole meadow's red channel and
    // the 75-85th-percentile "lit grass" sample drifts off (96,186,54) — measured, twice.
    c.copy(grass).lerp(grassAlt, Math.max(0, Math.min(1, (tone - 0.55) * 4.0)));
    c.lerp(dirt, dirtWeightAt(x, z, seed, terrain, heightNorm, slope));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = gradientMap
    ? makeToonMaterial(THREE, {color: 0xffffff, vertexColors: true, gradientMap})
    : new THREE.MeshLambertMaterial({color: 0xffffff, vertexColors: true});
  // The meadow never takes the light-mods toon ramp (measured: banding the ground caps its only
  // highlights); analytic cloud shade still applies through the same patcher.
  mat.userData.noToonRamp = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "test-scene:terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;              // a 320 wu plane in the shadow map buys nothing but acne
  return {mesh, dispose(){ geo.dispose(); mat.dispose(); }};
}
