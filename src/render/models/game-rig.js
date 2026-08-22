// Owns: the game's light rig MIRROR, the relight that turns viewer-calibrated display targets into
// albedo for it, and the SHADE TINT that lands a baked cast's shadow side on its palette family.
// Interlocked with scene.js's lights — see the rig comment there and memory/docs: change together.
//
// Data flow, once per model build (nodes/chest.js, nodes/diamond.js, nodes/node-mesh.js,
// units/worker.js, units/enemy.js, buildings/main-base.js all run this order):
//   reviewed module builds  ->  relightForGame()  ->  bakeStatic()/adoptModel()  ->  shadeToFamily()
// relightForGame owns the SUN side (what the cast looks like lit), shadeToFamily owns the HEMI
// side (what it looks like in cloud shade or cast shadow). Neither touches geometry.
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
// ── THE ONE EXPOSURE NUMBER ────────────────────────────────────────────────────────────────────
// A reviewed cast was judged in the MODEL VIEWER, against the viewer's ground plane. What makes it
// look the same in the game is not its absolute pixel values (the two worlds are not equally
// bright and never will be) but its FIGURE/GROUND RATIO — every cast pixel keeping the same ratio
// to the clearing it was judged against. One linear exposure applied to every target is exactly
// that: a uniform scale preserves every ratio inside the cast AND its ratio to the ground.
//
//     GAME_EXPOSURE = (game clearing, linear luma) / (viewer clearing, linear luma)
//
// Both terms, re-derived Aug 22 for the CURRENT rig — no measurement off a screenshot is needed
// any more, because both clearings are now closed-form:
//
//   VIEWER clearing.  A flat up-facing Lambert of albedo 0x9db97f under the viewer's rig, whose
//     irradiance the reviewed modules already carry as a measured constant (IRR = .738/.678/.519,
//     summoning-circle.js). Pushed through the exact ACES@1.18 forward those modules implement,
//     it DISPLAYS (166,181,117) — which is the number the module's own header records, so the
//     chain reproduces the calibration anchor rather than assuming it. Linear luma 0.4254.
//   GAME clearing.  scene.js gives the ground material palette.js TONES.meadow through
//     setToneTargets(), whose whole contract is "a flat sun-lit face renders EXACTLY the lit
//     swatch". The lit clearing is therefore SWATCH.green1 0x97b064, by construction and not by
//     measurement. Linear luma 0.3855.
//
//     0.3855 / 0.4254 = 0.9063
//
// This retires the old chain of napkin scalings (.19 measured on the pre-Aug-21 world, ×2.45 for
// the sun/hemi re-solve, ×2.06 for the un-squared ground = .958). The napkin landed 5.7% high,
// which is within taste but is no longer a number anyone has to trust: the two clearings above are
// both derivable, so a rig or palette change re-derives this by re-running the arithmetic.
// LUMA, not per-channel. The per-channel ratios are .816/.935/.718 — applying those would white-
// balance the cast into the meadow's hue and throw away the calibrated hues the TINT tables in the
// reviewed modules were solved for. Value transplants; hue is authored.
// COST OF RAISING IT: albedo = displayTarget × exposure / irr(up), and albedo clips at 1 in
// relightGeometry() below. At .9063 every viewer pixel up to sRGB (255,253,234) still fits on an
// up-facing facet; at the old .958 the ceiling was (255,246,229). Neither binds for this cast —
// what binds is the SHADE side, and that is what shadeToFamily() below exists to answer.
export const GAME_EXPOSURE = .9063;
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
// ── shade tint: the baked casts' answer to TONES ────────────────────────────
// The live-rig models (trees, rocks, terrain) opt into palette.js TONES through kit.toned(): a
// flat sun-lit face renders the family's `lit` swatch, a fully shaded face its `shadow` swatch.
// The baked casts could not use that as-is, and the failure is visible: with tints at (1,1,1) a
// shaded face is albedo × the hemi pair, and the hemi pair is a cool lavender sky over a mauve
// bounce, so a warm timber chest under cloud went grey-brown mud instead of dark wood.
//
// WHY ONLY THE SHADE HALF. setToneTargets() solves BOTH tints, and its direct tint would overwrite
// the sun-side calibration relightGeometry() just spent this whole file establishing. These casts
// already know what they look like lit — that is the bake. All they were missing was the hemi
// side, so this solves only uLmShadeTint and leaves uLmDirectTint at its (1,1,1) default. That is
// the smaller change of the two the Aug 22 brief offered: extending relightForGame() would have
// meant re-solving every facet against a second irradiance and storing a second colour set.
// Same equation as setToneTargets (material-light-mods.js), same rig, one unknown instead of two:
//     shadeTint = shadow·π / (albedo · hemiIntensity · skyLight)
//
// ALBEDO IS MEASURED, NOT NAMED. These meshes are vertex-coloured (bakeStatic fuses to one white
// material), so "the material's albedo" is the MEAN of its colour attribute — computed here rather
// than hand-declared per model, so a cast that gets re-painted re-solves itself. A facet whose own
// albedo differs from that mean scales proportionally, exactly like the meadow's green0 patches:
// the blue courier still shades toward blue-dark, the gold builder toward gold-dark. Only the
// overall cast of the shadow comes from the `shadow` swatch passed in.
//
// COUPLING (material-light-mods.js): `mat.userData.lmShadeTint` IS the uniform object the patched
// shader reads — toneUniform() creates it with `??=`, so writing it before or after the material's
// first compile both land. Do not replace the object, only its .value.
//
// HEADROOM. The tint is solved on the MEAN, so the material's BRIGHTEST facet renders
// shadow × (maxAlbedo / meanAlbedo) when fully shaded, which can pass 1 on a cast whose mean is
// near-black (the enemy shard's charcoal). The whole triple is then scaled down by its own worst
// channel — the same "clip toward black, never toward the rig's hue" trade relightGeometry() makes
// above — so a shaded highlight can go dark but can never blow out to white or shift hue.
const _stMean = new THREE.Color();
export function shadeToFamily(root, shadowHex){
  const sky = new THREE.Color(PAL.skyLight);
  const shadow = new THREE.Color(shadowHex);
  const acc = new Map();          // material -> mean+max albedo accumulator
  root.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const col = o.geometry.getAttribute("color");
    for(const m of mats){
      if(!m || !m.isMeshLambertMaterial) continue;
      let a = acc.get(m);
      if(!a){ a = {r:0, g:0, b:0, n:0, mr:0, mg:0, mb:0}; acc.set(m, a); }
      // Multi-material meshes would need per-group means; every cast that reaches here is either
      // one material or vertex-coloured, so the material colour times the mean vertex colour is
      // the honest albedo either way.
      if(col){
        // Sampling stride: these fused geometries run to tens of thousands of vertices and the
        // mean does not need every one. 3 = one vertex per triangle on non-indexed flat geometry.
        for(let i = 0; i < col.count; i += 3){
          const r = m.color.r*col.getX(i), g = m.color.g*col.getY(i), b = m.color.b*col.getZ(i);
          a.r += r; a.g += g; a.b += b; a.n++;
          if(r > a.mr) a.mr = r;
          if(g > a.mg) a.mg = g;
          if(b > a.mb) a.mb = b;
        }
      }else{
        a.r += m.color.r; a.g += m.color.g; a.b += m.color.b; a.n++;
        a.mr = Math.max(a.mr, m.color.r); a.mg = Math.max(a.mg, m.color.g); a.mb = Math.max(a.mb, m.color.b);
      }
    }
  });
  for(const [m, a] of acc){
    if(!a.n) continue;
    _stMean.setRGB(Math.max(1e-4, a.r/a.n), Math.max(1e-4, a.g/a.n), Math.max(1e-4, a.b/a.n));
    const t = [shadow.r*Math.PI / (_stMean.r*GAME_HEMI_I*Math.max(1e-4, sky.r)),
               shadow.g*Math.PI / (_stMean.g*GAME_HEMI_I*Math.max(1e-4, sky.g)),
               shadow.b*Math.PI / (_stMean.b*GAME_HEMI_I*Math.max(1e-4, sky.b))];
    const over = Math.max(1, shadow.r*a.mr/_stMean.r, shadow.g*a.mg/_stMean.g, shadow.b*a.mb/_stMean.b);
    const u = (m.userData.lmShadeTint ??= {value: new THREE.Vector3(1,1,1)});
    u.value.set(t[0]/over, t[1]/over, t[2]/over);
    // NIGHT TIER (rig.js): the clock dims the SUN only — the hemi pair is the same all night — so a
    // baked cast's shaded side is the same colour day and night and its night slot is this same
    // solve. Mirroring it (rather than leaving the (1,1,1) default) is what keeps uLmNight from
    // lerping these casts back to the stock hemi as dusk falls.
    (m.userData.lmShadeTintN ??= {value: new THREE.Vector3(1,1,1)}).value.copy(u.value);
  }
  return root;
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
