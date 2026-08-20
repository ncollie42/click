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
export const SUN = {
  azimuthDeg: 40,     // 0 = straight along +X (screen right); positive rotates toward the camera
  elevationDeg: 22,   // = asin(cos(45 deg)·sin(32 deg)); az = asin(tan(22)/tan(32))
  color: 0xfff2d0,    // PAL.sunDay — held FIXED so the exposure solve has one unknown, not four
  intensity: 7.42,    // = S*PI/sin(22 deg), S = 0.885 held from round 2. Paired with HEMI, not free
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
export const HEMI = {skyColor: 0xffde82, groundColor: 0x6b5a4a, intensity: 0.48};

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
  // Albedos below are LINEAR-solved then written as the sRGB hex a painter would author.
  grass: 0x55c058,    // renders to (96,186,54) lit / (31,67,22) cloud-shaded
  grassAlt: 0x85d06e, // BRIGHTER second tone, renders to (138,195,68) — the reference's p95
                      // grass. Blended by a slow noise; without it our luma p95 sits ~14 short.
  dirt: 0x837b47,     // renders to ~(120,111,47) lit; brightened 10% linear in round 4 so
                      // CLOUD-SHADED dirt clears the 40 L black gate (dirt*amb sat at 38)
  dirtHeight: 0.56,   // crest threshold (0..1 over the height range) where dirt starts winning
  dirtSlope: 0.9,     // extra dirt weight from surface slope
  dirtLeftBias: 0.6,  // tilts the dirt mass toward screen-left (reference: 59% in the left
                      // third). Has to out-shout the crest term (±1.1 over the height range),
                      // which kept parking every patch on the tall right-side hills. 0.75 stacked
                      // too much dirt under the left shade mass and dug a quarter-frame of blacks
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
  {kind: "sphere", name: "yellow", x: -31.2, z: -10.9, r: 4.65, sink: 0.54, color: 0x8cb91c},
  {kind: "sphere", name: "red",    x: -15.7, z:  -3.0, r: 4.30, sink: 0.46, color: 0xc1363f},
  // ROUND 4 (owner): SQUARE footprint — the reference box reads square, ours read as an oblong
  // slab. Shrunk toward the reference's 195x143 visible px while keeping the ~30 deg yaw.
  // Box albedo solved for a SUN-LIT top face (r4c proved the locked composition leaves the box
  // lit — the lavender shade-solve rendered pink): top = albedo*(amb + S*sun), so albedo =
  // (72,54,49)_lin / (1.022, 0.885, 0.588) -> dark warm plum. Sides fall darker on their own.
  {kind: "box",    name: "box",    x:   1.3, z:  -6.5, size: [4.5, 3.1, 4.5], sink: 0.34,
   rot: [0.10, 0.52, -0.07], color: 0x473a40},
  {kind: "sphere", name: "orange", x:  18.9, z: -14.9, r: 4.30, sink: 0.52, color: 0x916721},
  // White solved for a ~205 crown (the crown, not the median, owns the frame's max luma; the
  // reference dome is unphysically flat — critic note — so the median lands a little dark).
  {kind: "sphere", name: "white",  x:  34.9, z: -11.6, r: 3.70, sink: 0.56, color: 0x8890aa},
];

// ── pixelTune preset ──────────────────────────────────────────────────────────────────────────
// Only the keys that differ from src/render/pipelines/pixel.js defaults carry a comment.
export const PIXEL_PRESET = {
  // The reference's texels measure ~5.5 output px across a 1571-wide frame => a ~283x157 render.
  // pixelScale (fraction of drawing-buffer height) is the knob that survives a resize.
  pixelScale: 0.18,
  targetHeight: 157,
  snap: true,
  subpixel: true,
  sharpen: 0.25,        // 0.6 overshoots: the reference's max luma is 193, nothing near white
  clouds: true,
  cloudsMode: "scene",  // see the CLOUD SHADE note at the bottom of this file
  cloudScale: 0.038,    // ~26 wu features: 3-4 shadow bands across the ~100 wu visible ground
  cloudSpeed: 0.01,
  cloudCover: 0.38,    // THRESHOLD, not amount: shade lives where the fBm EXCEEDS it, so LOWER =
                       // more shade (got that backwards once — 0.47 measured p25 124, clearer
                       // sky). 0.38 measures p25 103 vs the reference's 89 at the locked offset;
                       // lower still starts merging the big masses into one murk
  cloudDarken: 0.10,   // "image" mode only (inert in "scene", where the rig's ambient IS the
                       // shade). LINEAR multiply, so it is directly the shade/lit ratio. Swept
                       // against the final albedos: 0.09 -> grass-shade Δ7.9, 0.10 -> Δ6.4,
                       // 0.11 -> Δ7.9. One scalar cannot match a per-channel ratio; see below.
  cloudHeight: 60,
  cloudBands: 1,       // >1 posterizes coverage BEFORE the plane's dither. Measured at 3:
                       // grass-shade Δ 4.6 -> 5.9 and p25 94 -> 88. Smooth coverage wins.
  cloudOffsetX: 2,     // ROUND 4 composition solve: 3x3 coarse + 3x3 refined sweep, graded on
  cloudOffsetZ: -2,    // block-luma correlation vs reference + red-sphere-lit + box-in-shade
                       // (r4b series: corr 0.287, red 107 L, box 78 L). Red LIT like the
                       // reference's; box fully cloud-shaded (its albedo solve assumes this).
  rays: true,
  rayStrength: 0.06,    // the reference has no visible shafts at all. 0.1 (let alone the 0.2
                        // default) lifts every cloud-shaded pixel out of the deep band — measured:
                        // darkest grass went from (31,56,24) to (63,106,50). A whisper, not a beam.
  raySteps: 12,
  rayBands: 4,
  rayDist: 15,       // the marched air window. 30 (the current default; 60 when round 1 measured
                     // it) marches so far above a cloud-shaded pixel that the sample column exits
                     // the shadow, so `beam` is large EVERYWHERE in shade and the bounded warm
                     // fold lifts the deepest grass out of its band. 15 wu keeps beams at edges.
  outlines: true,
  outlineStrength: 3,
  depthEdge: 0.0010,    // 0.0025 inks the rolling hills themselves; the reference only inks objects
  creases: true,
  creaseThreshold: 0.86,
  creaseStrength: 1,
  normalEdges: true,
  edgeHighlight: 0.75,
  normalThreshold: 0.35, // 0.1 draws every sphere facet seam; the reference shows only strong ones
  quantizeMode: 0,       // OKLab bands — the reference is many-banded, not a 16-colour palette
  bands: 37,             // SOLVED, not eyed: with the fixed OKLab the quantizer's own floor over
                         // the eight reference samples is lowest at 37 (mean Δ1.4, max Δ3.5);
                         // 32 costs 4.7 and 48 costs 3.2. Wider bands also make the match robust —
                         // a small render error still snaps to the band the solve aimed at.
  spread: 0.16,        // 0.1 left 3-4 hard terraces on a smooth-hill scanline (CRITIC-R2 item 11);
                       // dither them into the bands instead
};

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
