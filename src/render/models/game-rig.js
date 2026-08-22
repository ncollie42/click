// Owns: the game's light rig MIRROR and the relight that turns viewer-calibrated display
// targets into albedo for it. Interlocked with scene.js's lights — see the rig comment there and
// memory/docs: change the two together.
import * as THREE from "three";
import {SUN_INTENSITY, HEMI_INTENSITY, SUN_ELEVATION_DEG} from "../rig.js";
import {PAL} from "../palette.js";
import {isOutline} from "./kit.js";

// ── display-referred adoption: the game's own rig, inverted ─────────────────
// The painted casts (resource-nodes.js, summoning-circle.js) are calibrated in DISPLAYED sRGB
// against the model viewer, which renders them UNLIT through ACES @1.18. The game renders
// NoToneMapping + sRGB out, through a LIT Lambert. Adopting them unchanged would hand a scene-
// linear ACES value to a light rig and shade it a second time.
//
// So those two modules can bake for the game instead (withGameTarget): every colour comes out as
// the albedo that displays its calibrated pixel on an UP-FACING facet. This is the other half —
// rescale each facet by irr(up)/irr(that facet's WORLD normal), so the Lambert pass multiplies the
// rig straight back out and the painted ramp renders exactly as authored, while the material still
// answers to the sun, the shadow map and the day/night dim, which an unlit material never would.
// (Same idea as enemy-shard's toneAlbedo(), which does it against the VIEWER's rig at build time;
// this does it against the GAME's rig at adoption time, so one module serves both renderers.)
//
// THE RIG, mirrored from scene.js. If the lights there change, these change with them:
//   sun    PAL.sunDay @3.21 (drawScene's `3.21 - night*2.86`, i.e. the NOON value), from
//          az 0 / el 60 (sunPose default) — direction (cos60, sin60, 0), constant in world.
//   hemi   PAL.skyLight over PAL.bounce @0.6, axis +Y.
// (Aug 21: whole rig re-solved to the test-scene port — see scene.js lights comment. The
// verified-to-the-byte fog-block check below predates that and refers to the OLD 1.1 rig.)
// Three's non-legacy lighting (renderer._useLegacyLights === false, r160) is
//   displayed_linear = albedo * (sun*I*max(0,N·L) + mix(ground,sky,.5+.5*N.y)*I_hemi) / PI
// which was verified against the shipped build to the byte: a fog block of authored 0x484253 on
// its top face predicts (44,39,48) and the render measures (44,40,48).
const GAME_SUN_DIR = new THREE.Vector3(Math.cos(SUN_ELEVATION_DEG*Math.PI/180), Math.sin(SUN_ELEVATION_DEG*Math.PI/180), 0);
const GAME_SUN_I = SUN_INTENSITY, GAME_HEMI_I = HEMI_INTENSITY;   // rig.js — one source
const _sunLin = new THREE.Color(PAL.sunDay), _skyLin = new THREE.Color(PAL.skyLight), _gndLin = new THREE.Color(PAL.bounce);
// THE ONE EXPOSURE NUMBER, and the honest limit of this whole exercise.
// The gauntlet calibrated its cast against a clearing that DISPLAYS at (173,187,127), luma 180.
// The game's clearing displays (57,81,30), luma 72 — measured off tools/shots/terrain-before —
// because scene.js tints the grass texture (PAL.grass) with a vertex colour that is PAL.grass
// again, so the ground is that colour squared. In linear light the game's world is 6.7x darker
// than the viewer's, and the sheet's absolute numbers are simply not reachable here: at albedo 1
// the brightest pixel this rig can put on a sun-facing top facet is (169,166,157), and the
// canopy's calibrated green alone wants G=200.
// So the cast is transplanted rather than copied: ONE linear exposure applied to every target,
// which preserves every ratio inside the cast AND its ratio against the world. 0.19 is the value
// that reproduces the reference sheet's own figure/ground — its canopy sits 1.47x its grass in
// linear luminance, and 0.19 puts the canopy 1.47x the GAME's grass (displayed luma ~91 against
// the clearing's 72, against the sheet's 190-over-160).
// MEASURED, on tools/shots/terrain/normal-base.png against tools/shots/terrain-before: canopy
// median (87,99,68) luma 94 over a clearing at luma 73. The old primitive crowns sat at luma 112,
// so the new trees separate LESS than the ones they replace (+21 against +39) while separating
// exactly as much as the reference sheet's do. That is the one call in this file that is taste
// rather than measurement, and it is a single number to turn:
//     .19   the sheet's figure/ground, in linear ratio (canopy 1.47x the clearing)   <- shipped
//     .226  the sheet's figure/ground, in DISPLAY luma (+30 over the clearing, canopy luma ~103)
//     .275  the OLD game's contrast (canopy luma ~112, what the primitive crowns had)
// Raising it costs ramp: the higher the exposure, the more shade-side facets hit the albedo
// ceiling in relightGeometry() below and flatten toward the rig's own falloff.
// Aug 21 rig re-solve (sun 1.1→3.21, el 54.5→60, hemi 0.5 cool→0.6 warm): up-facing irradiance
// rose ×2.45 in luma, so the shipped .19 scales to .19×2.45 = .465. Baked albedos come out
// ~unchanged (exposure and irr(up) cancel), the displayed cast brightens WITH the world, and the
// solved canopy-over-clearing ratio above still holds. The three menu values above are quoted in
// the OLD rig's scale — multiply by 2.45 to reuse them.
// Aug 21 palette unification: the floor is now PAL.grass (0x55c058, the test-scene solve) tinted
// ONCE over a white texture instead of 0x9db97f squared — clearing luma ×2.06 in linear. Scaled
// again to hold the canopy-over-clearing ratio: .465 × 2.06 = .958. NAPKIN, not measured; at
// this exposure more shade-side facets will hit the albedo ceiling in relightGeometry(). Owner
// to judge in the browser and re-measure against a fresh clearing shot.
export const GAME_EXPOSURE = .958;
function gameIrradiance(n, out){
  const nl = Math.max(0, n.dot(GAME_SUN_DIR)), w = .5 + .5*n.y, iw = 1/Math.PI;
  out.r = (_sunLin.r*GAME_SUN_I*nl + (_gndLin.r + (_skyLin.r-_gndLin.r)*w)*GAME_HEMI_I)*iw;
  out.g = (_sunLin.g*GAME_SUN_I*nl + (_gndLin.g + (_skyLin.g-_gndLin.g)*w)*GAME_HEMI_I)*iw;
  out.b = (_sunLin.b*GAME_SUN_I*nl + (_gndLin.b + (_skyLin.b-_gndLin.b)*w)*GAME_HEMI_I)*iw;
  return out;
}
const _rlNormalMatrix = new THREE.Matrix3(), _rlA = new THREE.Vector3(), _rlB = new THREE.Vector3(),
      _rlC = new THREE.Vector3(), _rlN = new THREE.Vector3(), _rlIrr = new THREE.Color();
const _rlUp = new THREE.Vector3(0,1,0);
// The up-facing irradiance the painted modules solve their albedo against, and the numerator of
// every per-facet rescale below. Handed to them through withGameTarget() so neither module has to
// hold a copy of the game's light rig.
const GAME_UP_IRR = (()=>{ const c = gameIrradiance(_rlUp, new THREE.Color()); return [c.r, c.g, c.b]; })();
export const GAME_TARGET = {exposure: GAME_EXPOSURE, irr: GAME_UP_IRR};
// Facet normals are recomputed from POSITIONS, not read from the normal attribute: the attribute
// is smooth on the primitives these modules borrow (the chest lid is a CylinderGeometry), while
// the material is flatShaded, so the shader's normal is the geometric one. Solving against
// anything else puts the compensation on a different normal than the shading pass uses.
function relightGeometry(geo, normalMatrix){
  const pos = geo.getAttribute("position"), col = geo.getAttribute("color");
  if(!col) return;
  for(let i = 0; i < pos.count; i += 3){
    _rlA.fromBufferAttribute(pos, i); _rlB.fromBufferAttribute(pos, i+1); _rlC.fromBufferAttribute(pos, i+2);
    _rlN.copy(_rlB).sub(_rlA).cross(_rlC.sub(_rlA)).applyMatrix3(normalMatrix);
    if(_rlN.lengthSq() < 1e-20) continue;                 // degenerate facet (SDF pole fans)
    gameIrradiance(_rlN.normalize(), _rlIrr);
    // The ceiling is where this stops being exact, and it is worth naming: a facet the sun never
    // reaches gets ~1/4.4 of an up-facing facet's light, so a bright fill (the canopy's shade
    // band, a trunk's shaded side) would need albedo past 1 to hold its painted value there.
    // Tops and uppers — which is what a 40-degree camera mostly sees — land exactly on target.
    // WHEN IT DOES CLIP, IT CLIPS TOWARD BLACK, NOT TOWARD THE RIG'S HUE. Clamping per channel
    // was measured doing the second thing: a pale trunk's side facets pinned all three channels
    // at 1, so the pixel became the rig itself — sky-lit, and the bone trunk rendered cool grey
    // (72,76,77) where its family is warm (88,85,76). Scaling the whole triple by its own worst
    // channel keeps the authored hue and spends only value, which is the trade the cast can
    // afford (its ramp is already a value ramp).
    const kr = GAME_UP_IRR[0]/_rlIrr.r, kg = GAME_UP_IRR[1]/_rlIrr.g, kb = GAME_UP_IRR[2]/_rlIrr.b;
    for(let k = 0; k < 3; k++){
      const r = col.getX(i+k)*kr, g = col.getY(i+k)*kg, b = col.getZ(i+k)*kb;
      const over = Math.max(1, r, g, b);
      col.setXYZ(i+k, r/over, g/over, b/over);
    }
  }
  col.needsUpdate = true;
}
/** Re-solve every painted facet for its own world normal. Run once, on the built sim-px group,
 *  BEFORE bakeStatic() fuses it (the fuse copies whatever colours it finds, and it flattens the
 *  transforms these normals are read through). */
export function relightForGame(root){
  root.updateMatrixWorld(true);
  const done = new Set();
  root.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    const geo = o.geometry;
    if(!geo.userData.gameTarget || done.has(geo)) return;
    done.add(geo);
    relightGeometry(geo, _rlNormalMatrix.getNormalMatrix(o.matrixWorld));
    geo.userData.gameTarget = false;
  });
  return root;
}
