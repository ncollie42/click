// Owns: the main base building body — one authored stone DOME on the 3x3 footprint.
// build(g, add) hangs the body via add(); buildings/index.js adds the parts list and the static
// bake after, exactly as for every other building. `mainBase` is a BUILDING_TYPES id, so the base
// has ONE factory reached the ordinary way — makeBuilding("mainBase") — used by both scene.js (the
// standing base at BASE) and the map editor's object catalog.
// userData contract: none of its own. index.js's userData.parts is the hurt-flash / pulse target
// scene.js drives; the base is positioned by its caller, not from here.
//
// SPHERE, not a cube (Aug 22, owner, replacing the 4.4 wu box). Two reasons, both pixel-pipeline:
//  - SMOOTH normals (flatShading:false, like nodes/tree.js's crown). The quantizer carves its
//    bands out of a continuous NdotL gradient; a flat-shaded ball hands it one value per facet —
//    flat plates, and an inked seam at every ~40 degree step. Smooth curves or big planes only
//    (docs/pixel-models.md).
//  - SUNK, like the test-scene reference domes (tools/test-scene/preset.js `sink`, the judged
//    match cast): a ball resting tangent on the ground reads as a floating marble, a buried one
//    reads as a mass rooted in the hill. SINK is the fraction of the DIAMETER below y=0, and the
//    ground hides the rest — there is no separate base plate.
//
// ONE mesh on purpose. bakeStatic() fuses two or more bakeable meshes into a single
// vertex-coloured flat() material, and that fused material carries no tone-target uniforms — the
// authored lit/shadow pair toned() solved would be lost. A lone body is left unfused (bakeStatic
// needs at least two), so the dome takes TONES.stone's sunlit and shaded swatches and joins the
// night tier for free, exactly like the meadow rocks.
import * as THREE from "three";
import {TONES} from "../../palette.js";
import {toned, meshOf, GROUND_Y} from "../kit.js";

// The 3x3 footprint is 6 wu across (3 cells x CELL px x S). R 2.0 leaves ~1 wu of painted soil
// showing on every side, so the reservation the base occupies stays legible around the dome — the
// same read the old cube's 4.4 wu box had against its pad. 2.4 wu of dome stands above ground.
const R = 2.0, SINK = .40;              // SINK = fraction of the DIAMETER buried
// 32x20 segments: the tree crown's tessellation at a comparable radius. Cheap, and fine enough
// that the silhouette shows no chords at play zoom (~25 render px/wu after the pixel downscale).
const SEGMENTS = 32, RINGS = 20;

export function build(g, add){
  const body = add(meshOf(new THREE.SphereGeometry(R, SEGMENTS, RINGS),
                          toned(TONES.stone, {flatShading:false})));
  body.position.y = GROUND_Y + R - SINK*2*R;
}
