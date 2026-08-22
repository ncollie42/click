// Owns: every tuned number for the Red Giraffe reference test scene — the light rig, the camera,
// the object albedos, and the pixelTune preset. ONE file to edit when the match drifts; scene.js,
// terrain.js and objects.js only consume what is declared here.
//
// ROUND 2 (Aug 20). Round 1 solved every albedo through a CPU mirror of pixel.js's OKLab, which
// then had a mistranscribed s-row. That is fixed in src/ (Ottosson's true row, round trip is
// identity to 3e-7), so every number below was RE-SOLVED. The albedos now read like a painter
// would author them — grass is green, not minty. See ROUND-LOG.md "## Round 2".
//
// HOW THESE NUMBERS WERE DERIVED (do not "clean up" by eye — re-measure instead):
// The reference frame (tools/shots/redgiraffe-scene-r1/reference.png) was sampled, and every
// albedo below was solved BACKWARDS through the rig so the RENDERED sRGB lands on the sampled
// target. Working model, three r160, useLegacyLights = false, MeshLambertMaterial:
//
//   linear_out[c] = albedo_lin[c] * ( amb[c] + S * sun_lin[c] * f )
//     amb[c] = skyColor_lin[c] * hemiIntensity / PI      (hemi weight w = 0.5*n.y+0.5 ≈ 1 on ground)
//     S      = sunIntensity * sin(elevation) / PI        (the flat-ground sun term)
//     f      = this surface's NdotL / sin(elevation)     (1 on flat ground, up to 1.31 on a
//                                                         sun-facing sphere facet)
// In cloudsMode "scene" a cloud shadow removes the sun term outright, so shaded ground is
// albedo*amb — which is why the ambient's HUE, not just its level, is pinned by the reference's
// grass-shade sample. Solving the pair
//     lit   (96,186,54)  = A*(amb + S*sun)
//     shade (31,67,22)   = A*amb
// for a fixed sun colour (PAL.sunDay 0xfff2d0) leaves exactly ONE free scalar — the exposure S —
// and it was set so the most demanding albedo in the scene keeps headroom below 1.0 (round 1 had
// red AND white pinned at 1.0 and could not reach their targets; nothing is pinned now).
// Final rig: S = 0.885, amb = (0.1372, 0.1002, 0.0306), so shaded/lit per channel is
// 0.134 / 0.113 / 0.052 — the pre-quantize ratio the reference's grass pair asks for.
// SUN.intensity and HEMI.intensity are still a PAIR: move one alone and every shaded pixel in
// the frame changes depth.
//
// ⚠ THE ONE REMAINING PRE-DISTORTION: pixel.js's mode-0 quantizer does `lab.z += (L-0.5)*0.05`
// after snapping lightness — a blue shift that pushes DARK pixels blue and bright ones yellow.
// The solve inverts it, which is why HEMI.skyColor is a warm peach rather than a sky blue: the
// ambient must arrive short of blue for the quantizer's shift to land shaded grass on the
// reference's (31,67,22). Judge DISPLAYED colour (measure.py), never the authored hex.
//
// CANONICAL FRAME for this round: /tools/test-scene.html?t=680&seed=3 — that is what
// tools/shots/redgiraffe-scene-r1/full.png is, and what the ROUND-LOG's numbers were measured on.

import {PAL} from "../../src/render/palette.js";
import {SUN_INTENSITY, HEMI_INTENSITY} from "../../src/render/rig.js";

export const SEED_DEFAULT = 3;

// ── camera ────────────────────────────────────────────────────────────────────────────────────
// 55 deg down-pitch. fov/dist are a PAIR: dist*tan(fov/2) = 20.7 wu is the half-height of the
// frame at the target, and every value of the pair that holds that product frames the meadow
// identically. What the pair changes is PARALLAX, and round 3 spent it deliberately.
//
// ROUND 3 — fov 38/dist 60 -> fov 10.75/dist 220 (product unchanged). Round 2's props spanned
// 66 wu at ~70 wu range, so the view direction swung 45 deg across the frame. The sun is fixed,
// so the angle between sun and view (gamma) — the ONE number that decides how much of a sphere's
// shaded side the camera can see — ran 11 deg on the left pair to 56 deg on the right pair. That
// is the whole of CRITIC-R2 item 1: the left domes were flat discs (core span 48/32 L) because
// their shaded crescent was a sliver hidden behind the outline, and the right pair was crushed
// (span 104 L) because half of it was terminator. Nothing about albedo or ambient could fix it.
// At dist 220 the swing is ~16 deg (gamma 43-59) and all four domes land in the same window.
// COST, accepted: less foreshortening, so the meadow reads flatter and the hills at the top of
// the frame are no longer stretched. TERRAIN.featureLen was re-tuned against it.
// `near` moved 0.5 -> 60 with the camera: the depth-edge test is |laplacian(viewDist)|/viewDist,
// and a 0.5 near-plane over a 220 wu scene wastes most of the depth texture's precision.
// ROUND 4 (owner directive): pitch 55 -> 32. The owner read the reference at "30-ish, 40 at
// most" and the frame agrees: at 55 the reference's ground rolls read too foreshortened and the
// dome ground-cuts too round. fov/dist pair kept from round 3 (near-ortho, stabilises gamma
// across the prop row); near stays proportional to dist.
export const CAMERA = {
  fov: 10.75,
  near: 60,
  far: 600,
  pitchDeg: 32,
  dist: 220,
  target: [0, 0, 0],    // world origin; OBJECTS[].x/z below were solved against exactly this
};

// ── sun ───────────────────────────────────────────────────────────────────────────────────────
// MEASURED, and it contradicts the round brief: the brief said "sun from upper-left, shadows
// down-right". Every object in the reference is lit from screen-RIGHT with a near-vertical
// terminator (luma centroids of the red/orange/yellow/white domes all offset +x), and the ground
// shade skirts fall left / down-left. So the sun sits to the right, 50 deg up, tipped 45 deg
// toward the camera (+z) — that +z tip is what tilts the terminator from "top-lit" to the
// reference's near-vertical line, and 50 deg keeps the cast shadows as short as the reference's
// (its props have almost no visible skirt). Override at runtime with ?sunaz=&sunel=.
// ROUND 3 re-derivation. Two constraints, two unknowns (az, el), solved rather than nudged:
//  1. VERTICAL TERMINATOR. In the near-ortho camera above, screen-up is U = (0, cos55, -sin55).
//     The terminator is vertical when the sun has no screen-up component, L·U = 0, i.e.
//     tan(el) = 1.427 sin(az). CRITIC-R2 measured the reference's four darkest-quartile centroids
//     at bearings 178/160/-156/-159 deg — dark straight left, so this constraint is the reference's.
//  2. TERMINATOR SIZE. With screen-toward-camera V = (0, sin55, cos55), constraint 1 reduces
//     cos(gamma) = L·V to 1.2213 sin(el). Round 2's el 50 therefore forced gamma = 27 deg — a
//     near-frontal sun that flattens EVERY dome once the camera stops supplying parallax. el 31
//     puts gamma at 51 deg, which measures out at a 70-110 L core span (see ROUND-LOG round 3).
// So elevation is not a free "shadow length" dial any more; it IS the terminator size. The cost
// is longer cast shadows than round 2's el 50, which is why HEMI went up (CRITIC-R2 item 8).
// ROUND 4 re-solve at pitch 32 (same two constraints, generalised):
//   vertical terminator  L·U = 0        =>  tan(el) = tan(pitch)·sin(az)
//   terminator size      cos(gamma) = sin(el)/sin(pitch)
// Under the first constraint el can never exceed the pitch, so at 32 the round-3 el of 31 would
// mean gamma ~11 deg (flat discs again). gamma ~45 was chosen over round 3's 51: el 22 instead of
// 19.5 halves the growth of the cast skirts, and the reference's crescents are modest. The skirts
// still lengthen vs round 3 (cot 22 = 2.5), so shadow.radius softens their edge — the reference's
// skirts are grass-eaten soft, and a hard ellipse at this length reads fake (owner round-3 look).
// OWNER DEFAULT (Aug 20, post-round-5): az 0 / el 60 — high sun from screen-right, short skirts.
// This departs from the REFERENCE match (its derived sun was az 40 / el 22; use
// ?sunaz=40&sunel=22 to reproduce the judged round-5 frames). S = 0.885 held as always, so
// intensity re-derives and the flat-ground albedo solves stay valid; TOON.levels was re-anchored
// to sin(60 deg) for the same reason.
export const SUN = {
  azimuthDeg: 0,      // 0 = straight along +X (screen right); positive rotates toward the camera
  elevationDeg: 60,
  color: PAL.sunDay,  // held FIXED so the exposure solve has one unknown, not four
  intensity: SUN_INTENSITY,   // rig.js: S*PI/sin(60 deg), S = 0.885. Paired with HEMI, not free
  distance: 240,      // must clear cloudHeight 60: sin(22)*240 = 90 wu up, above the plane
  shadow: {mapSize: 2048, halfSpan: 95, near: 1, far: 520, bias: -0.0006, normalBias: 0.035,
           radius: 8},   // PCF blur (needs PCFShadowMap — PCFSoft ignores radius): the el-22
                         // skirts are long, and a hard edge at that length reads fake without
                         // grass to eat it
};

// ── ambient ───────────────────────────────────────────────────────────────────────────────────
// skyColor is warm, not blue — see "THE ONE REMAINING PRE-DISTORTION" above. hemiIntensity is
// only pinned as a PRODUCT with skyColor; it was picked so the sky hex's largest channel is 0xff
// (best 8-bit resolution for the authored value). groundColor reaches only down-facing normals
// (w = 0.5*n.y+0.5), so on this scene it is a ~5% slope tint on the ground and a half-weight
// fill on the spheres' sides.
// ROUND 4: intensity 0.431 -> 0.48. The upper-left corner stacks cloud shade ON dirt, and
// dirt*amb sat at L38 — a quarter-frame just under the <40 L gate. +11% ambient floats it to
// ~42 and lifts p5 toward the reference's 55; the grass-shade sample drifts ~Δ3, accepted.
// Round 6 (grass calibration): 0.48 -> 0.60. With the meadow bladed, cloud-shade areas measured
// p25 66 vs the reference's 89 — the shade floor needed the ambient, not the grass, lifted.
export const HEMI = {skyColor: PAL.skyLight, groundColor: PAL.bounce, intensity: HEMI_INTENSITY};

// ── terrain ───────────────────────────────────────────────────────────────────────────────────
// The whole frame is ground: at 55 deg pitch the top of the frame still hits the ground ~79 wu
// out, so 320 wu of plane leaves no horizon anywhere. 256 segments ≈ 2.4 wu per quad — fine
// enough that the 283x157 low-res render never sees a facet edge on a hill.
export const TERRAIN = {
  size: 320,
  segments: 256,
  amplitude: 7.0,     // +-7 wu; the slope spread is what widens the lit-grass luma histogram
  featureLen: 58,     // wu per noise octave-0 cell
  octaves: 3,
  // Albedos are the SHARED palette (src/render/palette.js PAL): LINEAR-solved here, written as
  // the sRGB hex a painter would author, and read by the game too. Re-solve there, not here.
  grass: PAL.grass,       // renders to (96,186,54) lit / (31,67,22) cloud-shaded
  grassAlt: PAL.grassAlt, // BRIGHTER second tone, renders to (138,195,68) — the reference's p95
                          // grass. Blended by a slow noise; without it our luma p95 sits ~14 short.
  dirt: PAL.soil,         // renders to ~(120,111,47) lit; brightened 10% linear in round 4 so
                          // CLOUD-SHADED dirt clears the 40 L black gate (dirt*amb sat at 38)
  dirtHeight: 0.56,   // crest threshold (0..1 over the height range) where dirt starts winning
  dirtSlope: 0.9,     // extra dirt weight from surface slope
  dirtLeftBias: 0.6,  // tilts the dirt mass toward screen-left (reference: 59% in the left
                      // third). Has to out-shout the crest term (±1.1 over the height range),
                      // which kept parking every patch on the tall right-side hills. 0.75 stacked
                      // too much dirt under the left shade mass and dug a quarter-frame of blacks
};

// ── grass ─────────────────────────────────────────────────────────────────────────────────────
// Structural spawn params live here; every LOOK knob is grassTune (src/render/grass.js owns the
// defaults, same one-source-of-truth rule as PIXEL_PRESET/pixelTune — `tune` carries only diffs).
// span 180 (not the full 320 plane): the default frame's ground footprint is ~74x77 wu around the
// origin target; 180 covers every pose the camera panel can reach without paying 3x the instances
// for meadow no camera sees. Instance count follows grassTune.density (~97k at the shipped 3.0,
// minus dirt culls) in ONE draw.
export const GRASS = {
  span: 180,
  tune: {},
};

// ── the five objects ──────────────────────────────────────────────────────────────────────────
// x/z are world positions solved from the reference's screen fractions through the CAMERA above
// (invert the perspective divide at the ground plane; the terrain height then lifts them).
// `sink` = fraction of the DIAMETER buried, so 0.5 puts the sphere's equator exactly on the
// ground line. The reference domes are all just above half-buried.
// Albedos: solved from the reference sample through the rig at flat-ground NdotL, then corrected
// by measurement (spheres read brighter than flat ground because their lit cap has NdotL ~ 1).
// TWO of them were finished by hand against measure.py, and the reason is worth keeping:
//  · box — it is the only prop the reference samples IN CLOUD SHADE, and in "scene" mode shade is
//    albedo x ambient. Solving it that way demands a lavender albedo (the ambient has almost no
//    blue), which renders correctly over the ~74% of the box that is shaded but turns the lit
//    quarter bright pink. 0xa885b8 is the value that keeps the family Δ (6.7, better than the
//    lavender's 7.8) with the lit face at (127,106,103) instead of (168,125,138).
//  · white — its albedo controls the frame's PEAK luma (every pixel over 200 in the frame is this
//    one dome). Dimming it from the raw solve took max luma 238 -> 211 AND the family Δ 30.8 ->
//    2.2, because measure.py's t_white threshold (b > 100, r > 110) only admits our dome's
//    brighter facets and the median swings with how many qualify. Re-measure, do not re-derive.
export const OBJECTS = [
  // ROUND 4 albedo re-solves through the el-22 rig (lit factor 1.022/0.885/0.588; sphere crowns
  // see up to 2.36x the flat-ground sun term, which is what blew the old crowns to 222-255):
  // red desaturated to land on the reference's (195,51,48) — the pure 0xe03a49 quantized its
  // highlight to (252,0,31), which is what CRITIC-R2's "magenta rim" gate was actually catching.
  // Aug 21 (owner): the whole cast rescaled by 3.0/4.3 ≈ 0.698 so the RED dome lands exactly on
  // the game's placement grid — 1 game cell = 2 wu (CELL 32 px · S 1/16), red = 6 wu = a 3x3
  // footprint, the "red-1x1" sphere below = one cell. Every r/size is the round-5 solve times
  // that one factor (family proportions and albedos untouched); positions were NOT moved, so the
  // gaps between props read wider than the judged rounds' frames.
  {kind: "sphere", name: "yellow", x: -31.2, z: -10.9, r: 3.24, sink: 0.54, color: 0x8cb91c},
  // ROUND 5, and the ONLY albedo the toon ramp forced: 0xc1363f -> 0xc84d3f.
  // Round 4 solved red against its family MEDIAN, which put its red channel at 194-235 — the flat
  // top of the sRGB curve, where a 3x change in the light term is worth ~20 luma. Consequence:
  // the dome's whole ambient-to-full-sun range spans ~50 L, so probe.py resolved only three of the
  // ramp's four bands (>=3% of core per 8L bucket) and red reported span 32 / 1 group against the
  // reference's 72 / 2. THREE ramp variants left that number at exactly 32 — it is albedo-bound,
  // not ramp-bound, which is why this one is allowed. Re-solved so the CROWN band (level 0.60)
  // lands on the reference's own lit sample (240,88,51): albedo_lin = target_lin / (1.516, 1.331,
  // 0.916), then the blue channel finished by measurement (the linear solve lands b 15 short
  // because the mode-0 quantizer's lab.z += (L-0.5)*0.05 pulls bright pixels yellow; 0x35 measured
  // b 36, 0x4b measured 66, 0x3f measured 53 against the target's 51).
  // Result: lit (248,92,53) vs reference (240,88,51), span 80 / 2 groups vs 72 / 2.
  // COST, accepted and not hidden: measure.py's red FAMILY median goes Δ26.1 -> Δ47.6, because
  // 52% of our dome's core sits in the crown band where the reference's sits lower. That yardstick
  // cannot see shading structure (CRITIC-R2 §0) and probe.py is the round-3+ yardstick.
  {kind: "sphere", name: "red",    x: -15.7, z:  -3.0, r: 3.00, sink: 0.46, color: 0xc84d3f},
  // One-cell reference ball (owner ask, Aug 21): same albedo/sink as red, 2 wu diameter = 1x1
  // game cell. Mirrored in the game as the second "scale ball" sphere (scene.js setScaleBall).
  {kind: "sphere", name: "red-1x1", x: -8.6, z: -1.8, r: 1.00, sink: 0.46, color: 0xc84d3f},
  // ROUND 4 (owner): SQUARE footprint — the reference box reads square, ours read as an oblong
  // slab. Shrunk toward the reference's 195x143 visible px while keeping the ~30 deg yaw.
  // Box albedo solved for a SUN-LIT top face (r4c proved the locked composition leaves the box
  // lit — the lavender shade-solve rendered pink): top = albedo*(amb + S*sun), so albedo =
  // (72,54,49)_lin / (1.022, 0.885, 0.588) -> dark warm plum. Sides fall darker on their own.
  {kind: "box",    name: "box",    x:   1.3, z:  -6.5, size: [3.14, 2.16, 3.14], sink: 0.34,
   rot: [0.10, 0.52, -0.07], color: 0x473a40},
  {kind: "sphere", name: "orange", x:  18.9, z: -14.9, r: 3.00, sink: 0.52, color: 0x916721},
  // White solved for a ~205 crown (the crown, not the median, owns the frame's max luma; the
  // reference dome is unphysically flat — critic note — so the median lands a little dark).
  {kind: "sphere", name: "white",  x:  34.9, z: -11.6, r: 2.58, sink: 0.56, color: 0x8890aa},
];

// ── toon ramp (ROUND 5) ───────────────────────────────────────────────────────────────────────
// MATERIAL-STAGE banding, built through src/render/toon-ramp.js. Read that file's header for how
// three r160 samples a gradient map; read ROUND-LOG.md "Round 5" for the measured before/after.
//
// WHY. Every band in rounds 1-4 was POST (pixel.js mode-0 OKLab posterize) laid over a smooth
// Lambert gradient, which is a staircase, not a value structure. Worse, it could not close the
// frame's peak-luma gate: a Lambert sphere crown sees NdotL up to ~1 where the flat ground sees
// sin(22 deg) = 0.3746, i.e. 2.67x the sun term, so the crowns ran 232 L against the reference
// frame's whole-frame max of 193. No albedo or posterizer setting reaches that; the transfer
// function itself has to be capped. A ramp does exactly that.
//
// LEVELS — authored as EFFECTIVE NdotL, because that is what the texel replaces (toon-ramp.js
// consequence 1). Translate to display with the same model as the albedo solve at the top of this
// file: lit = albedo * (amb + sunIntensity*sun_lin*level/PI). That model was checked against the
// render before any of these numbers were trusted: predicted vs measured on the white dome's four
// bands is 94/136/151/165 vs 97/136/153/165 (quantize-off), i.e. within 3 L.
//
// FOUR levels, but 32 STEPS — and the step count is about BAND EDGES, not band count.
// three maps coord = dotNL*0.5+0.5, so a `steps`-wide map puts edges on the fixed lattice
// dotNL = 2i/steps - 1 and spends its whole lower half on dotNL < 0. steps 8 was the first
// attempt; it forced the terminator edge to dotNL 0.25, and MEASURED, that band covered only
// 2.0% of the red dome's core — under probe.py's 3%-of-core threshold, so the span metric could
// not see it and red reported span 32 (1 group) against the reference's 72 (2). Band AREA is set
// by where the edge sits, and no choice of LEVEL can fix it. steps 32 puts the lattice at 0.0625
// so the terminator edge can move out to 0.3125 (5.7% of core at the domes' gamma ~41 deg)
// WITHOUT dragging the 0.3746 anchor into it.
//
//   texels   dotNL           level    why
//   0-15     < 0             0        facing away from the sun: ambient only, by definition
//   16-20    0.0000-0.3125   0.14     TERMINATOR. Not 0 — a hard cut to ambient reads as a pasted
//                                     -on shadow, and the reference's domes keep a visible mid
//                                     step (shade/lit medians 0.58-0.87, not 0.13). Swept against
//                                     the domes' p5 (reference 54.8/47.8/69.4/114.7):
//                                     0.10 -> 38.4/46.7/49.3/58.9, 0.14 -> 38.6/51.5/55.6/73.1,
//                                     0.16 (the steps-8 first pass) -> 38.6/74.5/62.6/80.2.
//                                     0.10 nails red alone; 0.14 is the value that lands three of
//                                     the four domes closest at once.
//   21-23    0.3125-0.5000   0.3746   THE ANCHOR = sin(SUN.elevationDeg). Flat ground and the
//                                     box's top face sit here, so this level renders them exactly
//                                     as the Lambert rig did and every albedo above survives
//                                     untouched. It sits mid-band (0.062 from the low edge), not
//                                     on an edge — do not narrow this band around it.
//   24-26    0.5000-0.6875   0.50     1.33x the flat sun term
//   27-31    0.6875-1.0000   0.60     1.60x the flat sun term, replacing Lambert's 2.67x. THIS
//                                     ONE NUMBER IS THE PEAK-LUMA GATE: it took frame max from
//                                     232 to 194 against the reference frame's 193. Raising it to
//                                     0.70 measures ~+9 L on the white crown, which is most of
//                                     the remaining headroom under 205.
//
// One band-EDGE experiment is worth not repeating: widening the 0.50 band to dotNL 0.5625-0.8125
// (so the domes' area sits in the mid band rather than 52% in the crown) fixes the red dome's
// family median but costs the white dome 16 L of crown (lit 167 -> 151, reference 164) and the
// frame 4 L of p75. Rejected on the numbers; see ROUND-LOG.md "Round 5".
//
// terrain: FALSE — measured, not assumed. See ROUND-LOG.md "Round 5 / terrain vs props".
// Ramp re-authored for the el-60 owner sun (the el-22 ramp's 0.60 crown cap sat BELOW the new
// sin(el) anchor and would have inverted). Law unchanged: the band containing dotNL = sin(el)
// carries level sin(el), so flat ground renders exactly as Lambert and the albedo solves hold.
// At high sun the Lambert crown factor is only 1/sin(60) = 1.15x, so crowns no longer need a
// cap below 1 — the el-22 judged ramp lives in ROUND-LOG.md "Round 5" if the match is re-run.
export const TOON = {
  enabled: true,
  props: true,
  terrain: false,
  steps: 32,
  levels: [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,   // dotNL < 0
    0.25, 0.25, 0.25, 0.25, 0.25,                     // terminator (dotNL 0–0.3125)
    0.55, 0.55, 0.55, 0.55, 0.55,                     // low-mid   (0.3125–0.625)
    0.866, 0.866, 0.866, 0.866,                       // anchor = sin(60°) (0.625–0.875)
    1.0, 1.0,                                         // crown highlight (0.875–1)
  ],
};

// ── pixelTune preset ──────────────────────────────────────────────────────────────────────────
// Only the keys that differ from src/render/pipelines/pixel.js defaults carry a comment.
// The game's pixelTune defaults ARE this scene's solved values — they were ported wholesale
// after round 5 (owner call), so the preset carries only what still DIFFERS from the shipped
// defaults. Empty today, and that is the point: one source of truth (pixel.js), no drift. The
// reference-match numbers that differ from the owner look live in ROUND-LOG.md and are applied
// per shot via URL params (?pixelScale=0.18&sunaz=40&sunel=22 ...).
export const PIXEL_PRESET = {};

// ── CLOUD SHADE: "scene" vs "image" ───────────────────────────────────────────────────────────
// Round 1 had to run "image" because the shadow-casting plane was broken in two ways (view-camera
// layer test, and a depth pass that back-face-culled the plane); both are fixed in src/ and the
// page no longer patches anything. Round 2 re-auditioned them — see ROUND-LOG.md "## Round 2".
// VERDICT: "scene" wins, and it is the default. Same albedos, same frame, measure.py:
//   scene (full.png)              grass-shade Δ4.6   box Δ6.7    p5/p25 50/94
//   image (clouds-image-mode.png) grass-shade Δ8.7   box Δ14.0   p5/p25 50/93   (best darken 0.10
//                                 still only reaches Δ6.4)
//   scene  — the plane really casts, so shade removes the SUN TERM: shade hue comes from the rig's
//            ambient PER CHANNEL (0.134/0.113/0.052), and object SIDES get cloud shade too.
//            Cost: the shadow map is binary, so cloud-field.js's ordered 4x4 Bayer dither renders
//            every partially-covered texel as a checkerboard. Our penumbrae are WIDE (the field's
//            smoothstep spans 0.18 of an fBm whose whole range is ~1.5), and one render texel
//            (0.26 wu) is smaller than one Bayer cell in the shadow map (0.37 wu at mapSize 2048),
//            so the pattern aliases instead of averaging. mapSize 4096 barely helps — measured.
//   image  — a screen-space multiply by cloudDarken, one scalar for all three channels, so the
//            shade can only be the lit colour dimmed and the per-channel ratio is out of reach.
//            It IS smoother (no dither at all) and it darkens each prop uniformly instead of
//            cutting a shadow edge across it. Kept switchable with ?cloudsMode=image.
