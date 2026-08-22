// Owns: the rock model. Contract (scene.js scatter layer): userData.live = [fused body+chip],
// userData.rubble = hidden remnant. Per-entity yaw comes from scene.js scatterYaw, not from here.
import * as THREE from "three";
import {toned, meshOf, bakeStatic} from "../kit.js";
import {TONES} from "../../palette.js";

// Aug 21 (owner): rocks reworked as SHARP PLANES — the other legal surface type under the pixel
// pipeline (docs/pixel-models.md): few large flat-shaded faces take one quantizer band each and
// read crisp, like the test-scene box. First attempt was literal BoxGeometry and read as crates
// (right angles + parallel faces + level top say "box"); this hull keeps the plane count but
// breaks every box tell: wider soil-line than crest, slanted top, no two faces parallel, and the
// top quad is deliberately NON-planar so its two triangles crease into a ridge — the one "extra"
// facet, and it is what says "rock". Footprint stays ~1.9 x 1.4 wu (the gauntlet rock's).
// nodeMesh("rock")/"rock-rubble" remain exported by the module for a one-function swap-back.
//
// 8 corners, bottom quad then top quad (y up); 5 faces (bottom face omitted — buried).
// Sculpt notes (iterated against tools/rock-snap.mjs shots): v1 boxes read as crates; v2's
// converging sides read as TENTS — two big slopes meeting at a ridge is a roof, so the sides
// stay near-vertical (crest ~85% of the soil footprint) and the cap is one slanted polygon
// whose non-planar creases are the rock facets. v3 was still a clean quad in plan and read as a
// bread loaf — the rings are PENTAGONS now (one cut corner), which is what breaks the box tell.
// Two rings, soil then crest, same traversal direction; heights deliberately uneven.
const ROCK_SOIL  = [[-.9,0,-.65],[.85,0,-.72],[.95,0,.22],[.55,0,.62],[-.78,0,.66]];
const ROCK_CREST = [[-.7,.72,-.5],[.72,.95,-.55],[.78,.6,.15],[.4,.62,.42],[-.55,.78,.5]];
function rockHullGeometry(scale){
  const lo = ROCK_SOIL.map(p => p.map(v => v*scale));
  const hi = ROCK_CREST.map(p => p.map(v => v*scale));
  const N = lo.length, positions = [];
  const quad = (a,b,d,e) => positions.push(...a,...b,...d, ...a,...d,...e);
  for(let i = 0; i < N; i++){ const j = (i+1)%N; quad(lo[i], hi[i], hi[j], lo[j]); }
  for(let k = N-1; k >= 2; k--) positions.push(...hi[0], ...hi[k], ...hi[k-1]);  // crest fan
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions,3));
  geometry.computeVertexNormals();   // non-indexed -> true per-face normals
  geometry.computeBoundingSphere();
  return geometry;
}
// Rock family = palette.js TONES.stone / stoneDk (Aug 22): authored lit/shadow swatches replace
// the old hand-cooled local hexes (0x7f8b9d family) that compensated for the warm rig by eye.
export function makeRock(){
  const g = new THREE.Group();
  const body = meshOf(rockHullGeometry(1), toned(TONES.stone));
  body.rotation.y = .35;
  // Chip sits CLEAR of the body silhouette (v2 tucked it against the face and the dark shape
  // read as a tent door), low and flat so it says "small stone", not "opening".
  const chip = meshOf(rockHullGeometry(.42), toned(TONES.stoneDk));
  chip.scale.y = .62; chip.position.set(1.08,0,.62); chip.rotation.y = -1.9;
  const rubble = meshOf(rockHullGeometry(.6), toned(TONES.stoneDk));
  rubble.scale.y = .45; rubble.rotation.y = 2.3; rubble.visible = false;
  g.add(body, chip, rubble);
  g.userData = {rubble};
  const fused = bakeStatic(g);                // body+chip fuse into one live mesh
  g.userData.live = fused ? [fused] : [body, chip];
  return g;
}
