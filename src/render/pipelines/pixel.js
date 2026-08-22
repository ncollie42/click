// Owns: the "pixel" render pipeline — THE renderer pick: the merged best-of of the retro and
// toon experiments (both deleted at 43ad59b after judging), plus the wins the
// Aug 19 research pass surfaced (Red Giraffe "Pixel Perfect", hello-threejs, Photosounder pixel
// math; full map in the Pixel Rendering Atlas artifact). Same borrowed-object discipline as
// retro/toon: everything comes through ctx, every borrowed object is restored on return.
//
// What it took from each parent (deleted at 43ad59b; recover from git if ever needed):
//   retro — depth-Laplacian silhouettes + crease modes (depth-tangent or hello-threejs normal
//           buffer), outlines applied as an OKLab lightness step of the pixel's OWN colour
//           ("selout": the ink inherits the material, and lands on a real band once quantized).
//   toon  — 5-tap sharpen, sun-projected banded cloud shadows, Bayer dither. (Toon's rgb-levels
//           quantizer + endpoint fade came over too but were CUT Aug 19 by owner call — palette
//           match covers the "authored colors" want; recover from git if ever needed.)
// New here (not in either parent):
//   · SUB-PIXEL RECONSTRUCTION: the composite samples the RT at uv + snapRemainder*texel, so the
//     snapped render is shown from the TRUE camera position — pans glide instead of stepping
//     whole texels (Red Giraffe's offset quad / three.js example's frustum shift, done in UV).
//     Side effect: the drawn frame now matches the unsnapped camera, so the overlay/picking skew
//     retro documents mostly disappears. Sampling can read up to half a texel outside the RT;
//     ClampToEdge duplicates the border texel there — accepted, invisible in practice.
//   · NEAREST-PALETTE MATCH IN OKLAB (quantizeMode 1): per pixel, nearest of the authored palette
//     by OKLab distance — Red Giraffe's CIELAB move on our OKLab plumbing. The pixel's colour is
//     already linear (the RT is linear; OKLab's matrices want linear), palette hexes are
//     sRGB→linear→OKLab'd on the CPU, and the WINNING entry is output as its verbatim authored
//     sRGB value (no round trip, same rule as toon's ramp mode). Perceptually uniform L means
//     this does not suffer the linear-quantize dark-crush the display-space law exists for.
//   · GOD RAYS (Red Giraffe vid6, the part he left unresolved): per pixel, ray-march the LAST
//     rayDist world-units of air above the surface (Bayer-jittered steps), accumulate the SMOOTH
//     unoccluded cloud fraction at each step's sun-plane projection, and add only the EXCESS of
//     that over the ground's own litness — beams exist purely where lit air hangs over shaded
//     ground, and a clear sky adds exactly zero (no flat wash; first build had one, owner report
//     Aug 19). The window matters: marching the whole camera→ground path crosses several cloud
//     features once zoomed out and every pixel averages to the same mean. His open problem was
//     noise-vs-samples ("blurring breaks the pixel look"); the owner's law resolves it: SMOOTH
//     FIRST, THEN QUANTIZE — the march samples the un-banded field (smooth fBm, so ~12 jittered
//     steps land clean), and rayBands re-pixelates the beam into stepped shafts. Bounded warm
//     fold (lerp toward tint, capped at rayStrength — raw addition white-out dark fog blocks),
//     pre-quantize, beside the cloud shadow it complements.
//
// Passes (per frame)
//   0. camera texel snap (post-stage) — also records the sub-pixel remainder.
//   1. ctx.waterPrePass(rtW, rtH)
//   2. scene → low-res colour+depth target (NEAREST both ways = the upscale). In cloudsMode
//      "scene" (default) the shadow map now contains the cloud plane (cloud-field.js): cloud
//      shade arrives as REAL shadows here — object sides included — and the composite's own
//      cloud fold stands down (uCloudFold=0) so nothing darkens twice. "image" restores the
//      old composite-fold behaviour for A/B.
//   2b. optional normals pass (normalEdges mode, +1 scene draw, shadows frozen; the plane is
//      layer-gated off every camera, so the override material never sees it)
//   3. fullscreen composite, in Red Giraffe's order: sharpen → cloud shadow + god rays
//      (pre-quantize folds) → outline band-shift (OKLab, selout) → quantize → encode.
//
// Quantize modes (`quantizeMode`):
//   0 oklab bands — retro's look: 32-band OKLab lightness posterize + blue shift (default).
//   1 palette     — nearest-in-OKLab against an authored palette tier (dithered on L).
//
// COLOR SPACE / precision: see post-stage.js's COLOR SPACE header — linear RT (HalfFloat when the
// driver can render to it; the RGBA8 fallback WILL band in the darks before any quantizer runs),
// manual sRGB encode in the composite, gated on renderer.outputColorSpace.

// Three authored palettes for quantize mode 2, all built from the game's hue families
// (night-navy, grass greens, sun-creams, stone greys, wood browns, water blues, portal purple).
// paletteSize picks one; setting pixelTune.palette to an array of hexes overrides them entirely.
export const PALETTES = {
  8: [0x1b2033, 0x2e4a3b, 0x49683f, 0x6f8f4e, 0x9db365, 0xc7cd8d, 0xe8e3b6, 0xfaf3d8],
  16: [
    0x1b2033, 0x2e4a3b, 0x49683f, 0x6f8f4e, 0x9db365, 0xc7cd8d, 0xe8e3b6, 0xfaf3d8,
    0x3a3f4d, 0x6b7280, 0x9aa3ad,             // stone
    0x5a3d2e, 0x8a6242,                       // wood
    0x31456b, 0x4b6a8f,                       // water
    0x6e4a7e,                                 // portal/tree purple
  ],
  32: [
    0x11141f, 0x1b2033, 0x272e47, 0x31456b, 0x4b6a8f, 0x7290ab,             // night + water blues
    0x24352b, 0x2e4a3b, 0x3d5c3a, 0x49683f, 0x5b7c46, 0x6f8f4e, 0x86a55a,   // greens (dark→light)
    0x9db365, 0xc7cd8d,
    0xdbd8a2, 0xe8e3b6, 0xf1ecc9, 0xfaf3d8,                                 // sand → cream
    0x2c3038, 0x4a4f5a, 0x6b7280, 0x8d95a0, 0xaeb6bf,                       // stone greys
    0x402c20, 0x5a3d2e, 0x7a5438, 0x8a6242, 0xa87e54,                       // wood browns
    0x4a3457, 0x6e4a7e, 0x9a6fae,                                           // purples
  ],
};

/** Live-read every frame. Exported and mirrored on window for console tuning.
 *  Values are the OWNER DEFAULTS, Aug 20: ported wholesale from the test scene's solved
 *  reference-match preset (tools/test-scene/preset.js PIXEL_PRESET) after the round-5 audition —
 *  the Aug 19 game numbers were tuned against the pre-fix OKLab/sharpen math anyway. */
export const pixelTune = {
  targetHeight: 157,     // the match's texel grid; inert while pixelScale > 0
  pixelScale: 0.4,       // scale wins over targetHeight
  snap: true,
  subpixel: true,        // sub-pixel reconstruction at the upscale (needs snap)
  // toon half
  sharpen: 0.25,         // 0.6 overshot the match's midtone frame; also halos shadow edges less
  clouds: true,
  cloudsMode: "material", // "material" (default) = analytic shade in the materials (smooth
                          // penumbra, object sides, no dither; material-light-mods.js) ·
                          // "scene" = shadow-casting plane (dithered) · "image" = composite fold
  toonRamp: true,         // material-stage banded lighting (material-light-mods.js; terrain/fog
                          // opt out scene-side). Lives here so ONE panel owns the look knobs.
  cloudScale: 0.038,     // ~26 wu features
  cloudSpeed: 0.01,
  cloudCover: 0.65,      // THRESHOLD (lower = more cloud); field mean ~0.45. Owner call Aug 21:
                         // only the fbm peaks shade — a cute passing puff now and then, never
                         // half the map dark (was 0.38, which shaded ~half the meadow).
  cloudDarken: 0.1,      // image mode only (inert in scene mode)
  cloudHeight: 60,
  cloudBands: 1,         // smooth coverage measured better than posterized
  cloudOffsetX: 2,       // pans the field in FIELD units (≈1/cloudScale wu each) — composition
  cloudOffsetZ: -2,      // authoring; drift (time) only moves along one fixed diagonal
  // god rays (needs clouds on — the beams ARE the gaps in that same field)
  rays: true,
  rayStrength: 0.08,
  raySteps: 12,
  rayBands: 4,
  rayDist: 18,           // wu of air marched above the surface. Short ON PURPOSE, twice proven:
                         // at this game's near-ortho low-pitch camera a long view-ray window is
                         // mostly HORIZONTAL, so it smears the cloud-gap mask across the screen
                         // (grey wash + rayBands contouring into 1px streaks — measured Aug 20)
                         // instead of making shafts. True sun-axis shafts are geometrically
                         // unavailable at this camera; beams here are grounded edge-light.
  // retro half
  outlines: true,
  inkMode: "selout",     // "selout" = ink is the pixel's own colour banded darker (house style)
                         // · "uniform" = one authored ink for every silhouette (the reference's
                         // dark-olive read); colour in inkColor (console/tooltip, no slider)
  inkColor: 0x3f3a20,
  outlineStrength: 3,
  depthEdge: 0.002,      // 0.001 inked terrain ridge contours into 1px horizontal streaks at the
                         // near-ortho camera (swept + crop-verified Aug 20); prop silhouettes'
                         // depth steps are orders larger, unaffected
  creases: true,
  creaseThreshold: 0.86,
  creaseStrength: 1,
  normalEdges: true,     // costs the +1 normals scene draw
  edgeHighlight: 0.75,
  normalThreshold: 0.35, // 0.1 inked every facet seam on curved meshes
  // quantize
  quantizeMode: 0,       // 0 oklab bands (default) · 1 palette match
  bands: 37,             // mode 0 — solved: the quantizer's own floor over the reference samples
                         // is lowest at 37 (round 2)
  spread: 0.16,          // dither amplitude at band borders (both modes)
  paletteSize: 16,       // mode 1: which authored PALETTES tier to match against (8/16/32)
  palette: null,         // set an array of hexes (≤32) to override the authored tiers
};
if(typeof window !== "undefined") window.pixelTune = pixelTune;

export const PANEL_SPEC = {
  // Bare strings are group headers (debug-panel renders them as full-width subheadings).
  sliders: [
    ["pixelScale",     "pixel scale ×window", 0, 1, 0.05],
    ["targetHeight",   "fixed height px", 64, 1080, 4],
    ["sharpen",        "sharpen", 0, 2, 0.05],
    "quantize",
    ["bands",          "oklab bands (m0)", 2, 64, 1],
    ["spread",         "dither spread", 0, 1, 0.01],
    "outlines",
    ["outlineStrength","outline strength", 0, 4, 0.25],
    ["depthEdge",      "silhouette thresh", 0.0001, 0.02, 0.0001],
    ["creaseThreshold","crease thresh", 0, 1, 0.01],
    ["creaseStrength", "crease strength", 0, 4, 0.25],
    ["edgeHighlight",  "edge highlight (nrm)", 0, 4, 0.25],
    ["normalThreshold","normal thresh", 0.01, 1, 0.01],
    "clouds",
    ["cloudScale",     "cloud scale", 0.001, 0.1, 0.0005],
    ["cloudSpeed",     "cloud drift", 0, 0.1, 0.001],
    ["cloudCover",     "cloud cover thresh", 0, 1, 0.01],
    ["cloudDarken",    "cloud darken floor", 0, 1, 0.01],
    ["cloudHeight",    "cloud plane wu", 10, 200, 5],
    ["cloudBands",     "cloud bands", 1, 8, 1],
    ["cloudOffsetX",   "cloud offset x", -50, 50, 0.1],
    ["cloudOffsetZ",   "cloud offset z", -50, 50, 0.1],
    "god rays",
    ["rayStrength",    "ray strength", 0, 1, 0.01],
    ["raySteps",       "ray steps", 4, 16, 1],
    ["rayBands",       "ray bands", 1, 8, 1],
    ["rayDist",        "ray air window wu", 10, 200, 5],
  ],
  checks: [
    ["outlines", "outlines"], ["creases", "creases"],
    ["normalEdges", "normal edges (hello-threejs)"],
    ["clouds", "cloud shadows"], ["rays", "god rays"],
    ["toonRamp", "toon ramp (materials)"],
    ["snap", "camera snap"], ["subpixel", "sub-pixel pan"],
  ],
  selects: [
    ["quantizeMode", "quantize", [[0, "oklab bands"], [1, "palette match"]]],
    ["paletteSize", "palette (m1)", [[8, "8 colors"], [16, "16 colors"], [32, "32 colors"]]],
    ["cloudsMode", "cloud shade via",
     [["material", "material (smooth)"], ["scene", "shadow plane"], ["image", "image fold"]]],
    ["inkMode", "outline ink", [["selout", "selout (own colour)"], ["uniform", "uniform olive"]]],
  ],

  // Hover text per knob (debug-panel puts these on the whole row; falls back to the key name).
  tips: {
    pixelScale: "Low-res buffer height as a fraction of the window (0.18 = 18%). Chunkiness stays proportional when the window resizes. While > 0 this OWNS the resolution; drag to 0 to hand control to 'fixed height px'.",
    targetHeight: "Low-res buffer height in exact pixels — a fixed texel grid (good for matching a reference or an authored asset grid). Only active while pixel scale = 0.",
    sharpen: "Luma-only unsharp mask on the low-res image, before everything else. 0 = off.",
    bands: "OKLab-bands mode: number of lightness rungs the frame posterizes to. Fewer = chunkier.",
    spread: "Dither amplitude at quantize borders (fraction of one band). Breaks band terraces into checker dither in both quantize modes.",
    outlineStrength: "Silhouette ink: how many bands DARKER the near edge steps. The ink inherits each pixel's own colour (selout).",
    depthEdge: "Depth-edge threshold for silhouettes. Lower inks more edges — too low starts inking the rolling terrain itself.",
    creaseThreshold: "Fallback crease detector (used only when normal edges is off): surface bend angle that counts as a crease.",
    creaseStrength: "Fallback crease ink depth, in bands.",
    edgeHighlight: "Normal-edge mode: how many bands LIGHTER interior creases step.",
    normalThreshold: "Normal-edge sensitivity. Lower inks more interior detail — low values ink every facet seam on curved meshes.",
    cloudScale: "Cloud feature frequency over world units. Higher = smaller, busier puffs.",
    cloudSpeed: "Cloud drift speed. Drift moves along one fixed diagonal — use the offsets to compose.",
    cloudCover: "Coverage THRESHOLD, not amount: shade appears where the noise EXCEEDS it, so LOWER = more cloud.",
    cloudDarken: "Image-fold mode only: multiplier on cloud-shaded pixels (0.72 = 28% darker). Inert in shadow-plane mode, where shade darkness comes from the sun:ambient ratio.",
    cloudHeight: "Cloud plane altitude (wu). Tilts where sun-projected shade lands and shapes the god-ray march.",
    cloudBands: "Posterizes cloud coverage into N levels before dithering. 1 = smooth coverage.",
    cloudOffsetX: "Pans the whole cloud field east-west (field units, ≈1/cloud-scale wu each). Composition authoring.",
    cloudOffsetZ: "Pans the whole cloud field north-south. Composition authoring.",
    rayStrength: "God-ray intensity: max fraction lerped toward sun-cream where lit air hangs over shaded ground. Clear sky adds zero.",
    raySteps: "Samples along each god-ray march. More = smoother beams, linear cost.",
    rayBands: "Quantizes the smooth beam into stepped shafts (smooth first, then quantize).",
    rayDist: "Air window marched above each surface (wu). Too big exits the cloud above shaded ground and washes deep shade warm.",
    outlines: "Master switch for the depth-edge silhouette ink.",
    creases: "Fallback interior-crease ink (only runs when normal edges is off).",
    normalEdges: "Interior edge highlight from a normals buffer (+1 scene draw). Preferred crease detector.",
    clouds: "Master switch for the cloud field: shade AND god rays.",
    rays: "Volumetric god rays (needs clouds on).",
    snap: "Quantizes the camera onto the texel lattice so pans step whole pixels instead of shimmering.",
    subpixel: "Shows the snapped render from the true camera position — pans glide while texels stay locked (needs snap).",
    quantizeMode: "oklab bands = posterize lightness, hue untouched. palette match = snap every pixel to the nearest authored colour.",
    paletteSize: "Which authored palette tier palette-match snaps to.",
    cloudsMode: "material (smooth) = analytic shade computed IN the materials: smooth penumbra, object sides, no dither — the default. shadow plane = real shadow-map clouds (dithered penumbra). image fold = flat screen-space multiply (cloud darken applies).",
    toonRamp: "Material-stage banded lighting (the round-5 audition, game-wide): the sun term steps through an authored ramp before the quantizer. Terrain and fog stay smooth by design.",
    inkMode: "selout = silhouette ink is each pixel's own colour banded darker (house style). uniform = one authored dark-olive ink on every silhouette, like the reference. Colour: pixelTune.inkColor (console).",
  },

  // A live colour strip the panel renders after the named select: the exact hexes the palette
  // quantizer is matching against right now (authored tier, or a console-set tune.palette).
  swatches: {
    after: "paletteSize",
    tip: "The authored colours palette-match snaps to. Console-set pixelTune.palette overrides the tiers.",
    get: t => Array.isArray(t.palette) && t.palette.length ? t.palette : PALETTES[t.paletteSize] || PALETTES[16],
  },

  // Knobs that are inert under a condition; debug-panel dims the row and appends `why` to the
  // tooltip while `when(tune)` holds.
  dims: {
    targetHeight: {when: t => (+t.pixelScale || 0) > 0, why: "inactive: pixel scale > 0 owns the resolution"},
    cloudDarken: {when: t => t.cloudsMode !== "image", why: "inactive: shadow-plane mode — shade comes from the light rig"},
    creaseThreshold: {when: t => t.normalEdges === true, why: "inactive: normal edges is the active crease detector"},
    creaseStrength: {when: t => t.normalEdges === true, why: "inactive: normal edges is the active crease detector"},
    creases: {when: t => t.normalEdges === true, why: "inactive: normal edges is the active crease detector"},
    edgeHighlight: {when: t => t.normalEdges !== true, why: "inactive: needs normal edges on"},
    normalThreshold: {when: t => t.normalEdges !== true, why: "inactive: needs normal edges on"},
    paletteSize: {when: t => +t.quantizeMode !== 1, why: "inactive: quantize is in oklab-bands mode"},
    bands: {when: t => +t.quantizeMode === 1, why: "inactive: quantize is in palette mode"},
    rayStrength: {when: t => t.rays === false || t.clouds === false, why: "inactive: rays/clouds off"},
    raySteps: {when: t => t.rays === false || t.clouds === false, why: "inactive: rays/clouds off"},
    rayBands: {when: t => t.rays === false || t.clouds === false, why: "inactive: rays/clouds off"},
    rayDist: {when: t => t.rays === false || t.clouds === false, why: "inactive: rays/clouds off"},
  },
};

import {createPostStage, POST_VERT, GLSL_DEPTH_HELPERS, GLSL_SRGB_ENCODE} from "./post-stage.js";
import {CLOUD_UNIFORMS_GLSL, CLOUD_FIELD_GLSL, createCloudShadowPlane} from "../cloud-field.js";

const FRAG = /* glsl */`
#include <packing>

// highp on both data samplers — sampler precision defaults to lowp in ES 1.00, which quantizes
// depth reads and clips the RGBA16F colour target (same trap as scene.js's water shader).
uniform highp sampler2D uColor;
uniform highp sampler2D uDepth;
uniform sampler2D uNormal;      // only sampled when uNormalEdges is on
uniform vec2 uTexel;            // 1 / low-res target size
uniform vec2 uSubpixel;         // snap remainder in texels; (0,0) when snap/subpixel is off
uniform vec2 uUnproj;
uniform float uNear, uFar, uOrtho, uEncode;
uniform mat4 uCamWorld;
uniform float uSharpen;
${CLOUD_UNIFORMS_GLSL}
uniform float uClouds, uCloudDarken, uCloudFold;
uniform float uCloudHeight, uCloudBands;
uniform float uRays, uRayStrength, uRaySteps, uRayBands, uRayDist;
uniform vec3 uSunDir;
uniform float uOutlines, uOutlineStrength, uDepthEdge;
uniform float uInkUniform;
uniform vec3 uInkColor;     // linear (CPU-converted); applied pre-quantize like everything else
uniform float uCrease, uCreaseThresh, uCreaseStrength;
uniform float uNormalEdges, uEdgeHighlight, uNormalThresh;
uniform float uQuantMode;       // 0 oklab bands · 1 palette match
uniform float uBands;
uniform float uSpread;
uniform vec3 uPalette[32];      // authored sRGB, output verbatim in mode 2
uniform vec3 uPaletteLab[32];   // same entries, sRGB→linear→OKLab (CPU-side)
uniform float uPaletteSize;

varying vec2 vUv;

${GLSL_DEPTH_HELPERS}
${GLSL_SRGB_ENCODE}
// ── OKLab (linear sRGB ⇄ OKLab), Ottosson's published matrices. The source this was ported
// from (retro's lighting.glsl) had a mistranscribed s-row (0.2220049174/0.6896926207) that made
// the round trip destroy blue on saturated colours — found by the Aug 20 test-scene builder,
// fixed against bottosson.github.io/posts/oklab. Owner defaults tuned before the fix may read
// slightly differently. ──
vec3 toOKLab(vec3 c){
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  float l_ = pow(max(l, 0.0), 1.0 / 3.0);
  float m_ = pow(max(m, 0.0), 1.0 / 3.0);
  float s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}
vec3 fromOKLab(vec3 lab){
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

// The cloud density field lives in cloud-field.js (cloudCoverAt) — the SAME GLSL drives the
// shadow plane's depth material, so the analytic reads here can never drift from the real
// shadows the scene receives.
${CLOUD_FIELD_GLSL}

// Smooth (un-banded) cloud occlusion for a world position: project along the sun to the cloud
// plane, read the field there. Shared by the image-mode shadow fold AND every god-ray march
// step — the rays are literally the inverse of this mask, so they can never drift out of sync
// with the shadows they sit between. Banding is applied by each consumer AFTER (smooth first,
// then quantize — the owner's law; see the GOD RAYS header note).
float cloudShadowAt(vec3 pos){
  vec2 cloudUv = pos.xz;
  if(uSunDir.y > 0.08){
    float t = (uCloudHeight - pos.y) / uSunDir.y;
    cloudUv = pos.xz + uSunDir.xz * max(t, 0.0);
  }
  return cloudCoverAt(cloudUv);
}

// Walk from an in-gamut colour toward a target and stop at the sRGB gamut wall. An OKLab L
// move at constant (a,b) can leave the cube on saturated colours, and a naive per-channel clamp
// explodes the hue (saturated red lifts to (252,0,36) magenta, drops to purple — Aug 20 test-
// scene finding). Used by the outline band-shift AND the mode-0 posterize, which both move L.
vec3 gamutWalk(vec3 from, vec3 to){
  float t = 1.0;
  if(to.r > 1.0) t = min(t, (1.0 - from.r) / max(to.r - from.r, 1e-6));
  if(to.g > 1.0) t = min(t, (1.0 - from.g) / max(to.g - from.g, 1e-6));
  if(to.b > 1.0) t = min(t, (1.0 - from.b) / max(to.b - from.b, 1e-6));
  if(to.r < 0.0) t = min(t, from.r / max(from.r - to.r, 1e-6));
  if(to.g < 0.0) t = min(t, from.g / max(from.g - to.g, 1e-6));
  if(to.b < 0.0) t = min(t, from.b / max(from.b - to.b, 1e-6));
  return mix(from, to, clamp(t, 0.0, 1.0));
}

// ── Bayer 4x4 threshold, float-only lookup (no bitwise, no dynamic component index) ──
float bayer4(vec2 px){
  int x = int(mod(px.x, 4.0)), y = int(mod(px.y, 4.0));
  int i = y * 4 + x;
  float v =
    i== 0? 0.0: i== 1? 8.0: i== 2? 2.0: i== 3?10.0:
    i== 4?12.0: i== 5? 4.0: i== 6?14.0: i== 7? 6.0:
    i== 8? 3.0: i== 9?11.0: i==10? 1.0: i==11? 9.0:
    i==12?15.0: i==13? 7.0: i==14?13.0: 5.0;
  return v / 16.0 - 0.5;
}

void main(){
  // Sub-pixel reconstruction: the RT was rendered from the SNAPPED camera; offsetting every
  // sample by the snap remainder shows it from the TRUE one. All taps below use uv, and the
  // Bayer pattern is keyed on uv too, so the dither stays glued to the image texels (a pixel
  // artist's dither is part of the drawing, not a screen overlay).
  vec2 uv = vUv + uSubpixel * uTexel;
  vec3 col = texture2D(uColor, uv).rgb;

  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);

  if(uSharpen > 0.001){
    // Acerola's kernel: centre ×(1+4s) minus the 4-neighbour cross ×s — applied to LUMA ONLY,
    // scaling the colour to the sharpened luminance. The per-channel version subtracts a green
    // neighbourhood from a red centre pixel and destroys its chroma while staying inside the
    // gamut (red dome on grass: g -> ~0 => magenta fringe after quantize; ablation-isolated,
    // Aug 20 test scene). Luma sharpen keeps every pixel's hue by construction; the scale is
    // capped so near-black pixels can't blow up from the division.
    vec3 l = texture2D(uColor, uv - dx).rgb;
    vec3 r = texture2D(uColor, uv + dx).rgb;
    vec3 d = texture2D(uColor, uv - dy).rgb;
    vec3 u = texture2D(uColor, uv + dy).rgb;
    const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
    float lc = dot(col, LW);
    float ln = dot(l + r + u + d, LW);
    float sharpL = max(lc * (1.0 + 4.0 * uSharpen) - ln * uSharpen, 0.0);
    col *= clamp(sharpL / max(lc, 1e-5), 0.0, 4.0);
  }

  float zC = viewDist(uv);

  if(uClouds > 0.5 && zC < uFar * 0.99){
    // Sun-projected cloud plane, banded coverage, folded pre-quantize (Voyage fold +
    // Red Giraffe projection; see the header).
    vec3 world = (uCamWorld * vec4(viewPosOf(uv, zC), 1.0)).xyz;
    float shadowSmooth = cloudShadowAt(world);
    // Image-mode fold only: in scene mode the real shadow plane already darkened the render, so
    // folding again would double-darken. shadowSmooth stays live either way — the ray shaping
    // below needs the ground's litness.
    if(uCloudFold > 0.5){
      float shadow = shadowSmooth;
      if(uCloudBands > 1.5) shadow = floor(shadow * uCloudBands + 0.5) / uCloudBands;
      col *= mix(1.0, uCloudDarken, shadow);
    }

    if(uRays > 0.5 && uSunDir.y > 0.08){
      // God rays: march the last uRayDist world-units of the view ray before the surface and
      // average the smooth lit fraction of that air. The window is the point (owner report,
      // Aug 19): marching all the way to the camera crosses several cloud features once zoomed
      // out, so every pixel converges to the same mean and the beams wash to a flat lift.
      // fBm is smooth, so ~12 steps land clean; the per-pixel Bayer start jitter (uv-keyed, same
      // law as the dither) erases what step-count noise remains. THEN rayBands quantizes the
      // smooth beam into stepped shafts — the pixel-art god-ray look Red Giraffe's blur destroyed.
      vec3 nearPos = (uCamWorld * vec4(viewPosOf(uv, uNear), 1.0)).xyz;  // this pixel's near-plane point
      vec3 rayStart = mix(world, nearPos, clamp(uRayDist / max(zC - uNear, 1e-3), 0.0, 1.0));
      float jitter = bayer4(uv / uTexel) + 0.5;   // [0,1): offsets each pixel's step phase
      // Height falloff: air near the deck weighs most, fading to nothing at the cloud plane.
      // With the tall default window this integrates lit COLUMNS — beams smear along the
      // view/sun axis and read as shafts (round-2 critic's ask) instead of edge glow, while the
      // falloff keeps their energy grounded.
      float lit = 0.0, wSum = 0.0;
      for(int i = 0; i < 16; i++){
        if(float(i) >= uRaySteps) break;
        vec3 pos = mix(rayStart, world, (float(i) + jitter) / uRaySteps);
        float w = clamp(1.0 - pos.y / uCloudHeight, 0.05, 1.0);
        lit += (1.0 - cloudShadowAt(pos)) * w;
        wSum += w;
      }
      lit /= max(wSum, 1e-4);
      // A shaft is air MORE lit than the ground it hangs over — subtracting the ground's own
      // litness kills the DC term: clear sky over lit ground adds zero (no wash), and the beam
      // maxes out exactly on the money shot, lit air over cloud-shaded ground.
      float beam = max(lit - (1.0 - shadowSmooth), 0.0);
      // Dithered banding, same law as every quantizer here: un-dithered, the beam's wide flat
      // gradients contour into dead-straight 1px band lines (measured Aug 20, az-0 sun).
      if(uRayBands > 1.5) beam = floor(beam * uRayBands + jitter) / uRayBands;
      // Bounded warm (sun-cream family) fold: LERP toward the tint, not raw addition — a raw add
      // is ~10× the base value on dark pixels (fog blocks) and saturates beams to opaque white
      // blobs (owner report #2, Aug 19). Lerping caps the haze at rayStrength fraction whatever
      // the ground value, pre-quantize, so mode 0 bands it and mode 1 snaps it to the palette's
      // creams. Excess-only + bounded keeps the eye-channel line (only eye pixels read >215) and
      // the vid8 readability rule (uniform overlays flatten gameplay reads) safe by construction.
      col = mix(col, vec3(1.0, 0.92, 0.72), clamp(beam * uRayStrength, 0.0, 1.0));
    }
  }

  if(uOutlines > 0.5){
    // Depth-Laplacian silhouettes (near side only → 1px), then one of two
    // crease detectors. bandShift is applied to the pixel's OWN colour in OKLab — selout.
    float zR = viewDist(uv + dx);
    float zL = viewDist(uv - dx);
    float zU = viewDist(uv + dy);
    float zD = viewDist(uv - dy);
    float lapX = zL + zR - 2.0 * zC;
    float lapY = zD + zU - 2.0 * zC;
    float lap  = (abs(lapX) >= abs(lapY)) ? lapX : lapY;
    float refZ = (uOrtho > 0.5) ? max(uUnproj.y, 1e-3) : max(zC, 1e-3);
    float rel  = abs(lap) / refZ;

    float bandShift = 0.0;
    if(rel > uDepthEdge){
      if(lap > 0.0) bandShift = -uOutlineStrength;
    }else if(uNormalEdges > 0.5){
      vec3 n = texture2D(uNormal, uv).rgb * 2.0 - 1.0;
      float refN = max(zC, 1e-3);
      float indicator = 0.0;
      for(int k = 0; k < 4; k++){
        vec2 off = (k == 0) ? dx : (k == 1) ? -dx : (k == 2) ? dy : -dy;
        vec3 nN = texture2D(uNormal, uv + off).rgb * 2.0 - 1.0;
        float zN = viewDist(uv + off);
        float depthInd  = step(0.0, zN - zC + refN * 5e-4);
        float normalInd = smoothstep(-0.01, 0.01, dot(n - nN, vec3(1.0)));
        indicator += distance(n, nN) * depthInd * normalInd;
      }
      if(indicator > uNormalThresh) bandShift = uEdgeHighlight;
    }else if(uCrease > 0.5){
      vec3 pC = viewPosOf(uv, zC);
      vec3 tR = viewPosOf(uv + dx, zR) - pC;
      vec3 tL = pC - viewPosOf(uv - dx, zL);
      vec3 tU = viewPosOf(uv + dy, zU) - pC;
      vec3 tD = pC - viewPosOf(uv - dy, zD);
      float bend = min(dot(normalize(tR), normalize(tL)),
                       dot(normalize(tU), normalize(tD)));
      if(bend < uCreaseThresh)
        bandShift = (lap > 0.0) ? uCreaseStrength : -uCreaseStrength;
    }

    if(bandShift != 0.0){
      if(uInkUniform > 0.5 && bandShift < 0.0){
        // Uniform ink (the reference's read): every dark silhouette takes the ONE authored ink.
        // Interior highlights (positive shifts) stay selout either way.
        col = mix(col, uInkColor, 0.85);
      }else{
        // Selout (house style): step size — mode 0 has real bands; palette mode borrows uBands
        // as "ink depth" so one outlineStrength knob reads the same across modes.
        vec3 lab = toOKLab(col);
        lab.x = clamp(lab.x + bandShift / uBands, 0.0, 1.0);
        // The ink keeps its direction and loses only the part of the step that left sRGB.
        col = gamutWalk(col, fromOKLab(lab));
      }
    }
  }

  col = max(col, vec3(0.0));
  float noise = bayer4(uv / uTexel) * uSpread;

  if(uQuantMode < 0.5){
    // Mode 0 — retro: OKLab lightness posterize (linear input, encode after). gamutWalk, not a
    // raw clamp: the L snap + blue shift leaves sRGB on saturated colours and the clamp was
    // hue-exploding them (the magenta highlight actually came from HERE, not just the outline).
    // Bayer noise jitters L before the snap so band borders dither instead of terracing — until
    // Aug 20 the spread knob silently did nothing in this mode (owner report: dead panel knob).
    vec3 lab = toOKLab(col);
    float L = clamp(lab.x + noise / uBands, 0.0, 1.0);
    lab.x = floor(L * uBands + 0.5) / uBands;
    lab.z += (lab.x - 0.5) * 0.05;
    col = gamutWalk(clamp(col, 0.0, 1.0), fromOKLab(lab));
    if(uEncode > 0.5) col = srgbEncode(clamp(col, 0.0, 1.0));
  }else{
    // Mode 1 — palette match: nearest authored entry by OKLab distance (linear input; the
    // palette was converted CPU-side). Dither jitters L so band boundaries break up like every
    // other quantizer here. Winner is emitted as its verbatim authored sRGB — no round trip.
    vec3 lab = toOKLab(col);
    lab.x = clamp(lab.x + noise * 0.5, 0.0, 1.0);
    float best = 1e9;
    vec3 bestCol = uPalette[0];
    for(int i = 0; i < 32; i++){
      if(float(i) >= uPaletteSize) break;
      vec3 d = lab - uPaletteLab[i];
      float dist2 = dot(d, d);
      if(dist2 < best){ best = dist2; bestCol = uPalette[i]; }
    }
    col = bestCol;
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ── owned resources: shared scaffolding in post-stage.js; normal target is this pipeline's ──
let stage = null;
let normalRt = null;
let normalMat = null;
let uniforms = null;
let cloudPlane = null;   // shadow-casting cloud plane (cloud-field.js); borrowed scene + sun layer

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// CPU-side sRGB hex → linear → OKLab, for uPaletteLab. Same math as the shader; runs only in
// syncUniforms when the palette hash changes, so authoring in the console stays live.
const srgbToLinear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
function hexToOKLab(hex, out){
  const r = srgbToLinear(((hex >> 16) & 255) / 255);
  const g = srgbToLinear(((hex >> 8) & 255) / 255);
  const b = srgbToLinear((hex & 255) / 255);
  const l = Math.cbrt(Math.max(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0));
  const m = Math.cbrt(Math.max(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0));
  const s = Math.cbrt(Math.max(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 0));
  out.set(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  );
}
let paletteKey = "";   // change detector so the OKLab conversion isn't done per frame

function makeUniforms(THREE){
  return {
    uColor: {value: null}, uDepth: {value: null}, uNormal: {value: null},
    uTexel: {value: new THREE.Vector2(1, 1)},
    uSubpixel: {value: new THREE.Vector2(0, 0)},
    uUnproj: {value: new THREE.Vector2(1, 1)},
    uNear: {value: 0.5}, uFar: {value: 600}, uOrtho: {value: 0}, uEncode: {value: 1},
    uCamWorld: {value: new THREE.Matrix4()},
    uTime: {value: 0},
    uSharpen: {value: 0.6},
    uClouds: {value: 1}, uCloudFold: {value: 0}, uCloudScale: {value: 0.02}, uCloudSpeed: {value: 0.01},
    uCloudCover: {value: 0.52}, uCloudDarken: {value: 0.72},
    uCloudHeight: {value: 60}, uCloudBands: {value: 3},
    uCloudOffset: {value: new THREE.Vector2(0, 0)},
    uRays: {value: 1}, uRayStrength: {value: 0.2},
    uRaySteps: {value: 12}, uRayBands: {value: 4}, uRayDist: {value: 60},
    uSunDir: {value: new THREE.Vector3(0, 1, 0)},
    uOutlines: {value: 1}, uOutlineStrength: {value: 4}, uDepthEdge: {value: 0.0025},
    uInkUniform: {value: 0}, uInkColor: {value: new THREE.Color(0x3f3a20)},
    uCrease: {value: 1}, uCreaseThresh: {value: 0.86}, uCreaseStrength: {value: 1},
    uNormalEdges: {value: 0}, uEdgeHighlight: {value: 1}, uNormalThresh: {value: 0.1},
    uQuantMode: {value: 0}, uBands: {value: 32}, uSpread: {value: 0.1},
    uPalette: {value: Array.from({length: 32}, () => new THREE.Color(0))},
    uPaletteLab: {value: Array.from({length: 32}, () => new THREE.Vector3())},
    uPaletteSize: {value: 16},
  };
}

function ensureResources(THREE){
  if(stage) return;
  stage = createPostStage(THREE, () => {
    uniforms = makeUniforms(THREE);
    return new THREE.ShaderMaterial({
      uniforms, vertexShader: POST_VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false, transparent: false,
    });
  });
}

// The plane is a borrowed-object pact with the host scene: added here, removed symmetrically in
// removeCloudPlane (dispose restores the scene exactly as found, per the pipeline contract).
// It lives on the default layer (the shadow pass layer-tests the VIEW camera — see the
// cloud-field.js header) and hides from colour via colorWrite:false; the normals pass below
// must visible=false it, because override materials replace colorWrite along with the shader.
function ensureCloudPlane(ctx){
  if(cloudPlane) return;
  cloudPlane = createCloudShadowPlane(ctx.THREE);
  ctx.scene.add(cloudPlane.mesh);
}
function removeCloudPlane(ctx){
  if(!cloudPlane) return;
  ctx.scene.remove(cloudPlane.mesh);
  cloudPlane.dispose();
  cloudPlane = null;
}

function releaseNormalTarget(){
  if(!normalRt) return;
  normalRt.dispose();
  normalRt = null;
  if(uniforms) uniforms.uNormal.value = null;
}
/** Allocated only while normalEdges is on; RGBA8 is plenty for packed normals. */
function ensureNormalTarget(THREE, w, h){
  if(normalRt && normalRt.width === w && normalRt.height === h) return;
  releaseNormalTarget();
  normalRt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    depthBuffer: true, stencilBuffer: false,
  });
  normalRt.texture.generateMipmaps = false;
  uniforms.uNormal.value = normalRt.texture;
}

function syncUniforms(THREE, renderer, cam, sun){
  uniforms.uSharpen.value = clamp(+pixelTune.sharpen || 0, 0, 4);
  uniforms.uClouds.value = pixelTune.clouds === false ? 0 : 1;
  uniforms.uCloudFold.value = pixelTune.clouds !== false && pixelTune.cloudsMode === "image" ? 1 : 0;
  uniforms.uCloudScale.value = Math.max(1e-5, +pixelTune.cloudScale || 0.02);
  uniforms.uCloudSpeed.value = +pixelTune.cloudSpeed || 0;
  uniforms.uCloudCover.value = clamp(+pixelTune.cloudCover || 0, 0, 1);
  uniforms.uCloudDarken.value = clamp(+pixelTune.cloudDarken || 0, 0, 1);
  uniforms.uCloudHeight.value = Math.max(1, +pixelTune.cloudHeight || 60);
  uniforms.uCloudBands.value = clamp(Math.round(+pixelTune.cloudBands || 1), 1, 8);
  uniforms.uCloudOffset.value.set(+pixelTune.cloudOffsetX || 0, +pixelTune.cloudOffsetZ || 0);
  uniforms.uRays.value = pixelTune.rays === false ? 0 : 1;
  uniforms.uRayStrength.value = clamp(+pixelTune.rayStrength || 0, 0, 2);
  uniforms.uRaySteps.value = clamp(Math.round(+pixelTune.raySteps || 12), 4, 16);
  uniforms.uRayBands.value = clamp(Math.round(+pixelTune.rayBands || 1), 1, 8);
  uniforms.uRayDist.value = clamp(+pixelTune.rayDist || 60, 10, 200);
  if(sun){
    uniforms.uSunDir.value.copy(sun.position);
    if(sun.target) uniforms.uSunDir.value.sub(sun.target.position);
    const len = uniforms.uSunDir.value.length();
    if(len > 1e-4) uniforms.uSunDir.value.divideScalar(len);
    else uniforms.uSunDir.value.set(0, 1, 0);
  }

  uniforms.uOutlines.value = pixelTune.outlines === false ? 0 : 1;
  uniforms.uInkUniform.value = pixelTune.inkMode === "uniform" ? 1 : 0;
  uniforms.uInkColor.value.setHex(pixelTune.inkColor ?? 0x3f3a20);   // setHex = sRGB→linear
  uniforms.uOutlineStrength.value = +pixelTune.outlineStrength || 0;
  uniforms.uDepthEdge.value = Math.max(1e-5, +pixelTune.depthEdge || 0.0025);
  uniforms.uCrease.value = pixelTune.creases === false ? 0 : 1;
  uniforms.uCreaseThresh.value = clamp(+pixelTune.creaseThreshold || 0.86, -1, 1);
  uniforms.uCreaseStrength.value = +pixelTune.creaseStrength || 0;
  uniforms.uNormalEdges.value = pixelTune.normalEdges === true && normalRt ? 1 : 0;
  uniforms.uEdgeHighlight.value = +pixelTune.edgeHighlight || 0;
  uniforms.uNormalThresh.value = Math.max(0.01, +pixelTune.normalThreshold || 0.1);

  // Old saved presets may still carry quantizeMode 2 (palette's number before rgb levels was
  // cut); the clamp maps it onto palette's new slot 1 rather than silently changing look.
  uniforms.uQuantMode.value = clamp(Math.round(+pixelTune.quantizeMode || 0), 0, 1);
  uniforms.uBands.value = Math.max(2, Math.round(+pixelTune.bands || 32));
  uniforms.uSpread.value = clamp(+pixelTune.spread || 0, 0, 1);

  // A console-authored pixelTune.palette wins; otherwise paletteSize picks an authored tier.
  const pal = Array.isArray(pixelTune.palette) && pixelTune.palette.length
    ? pixelTune.palette
    : PALETTES[pixelTune.paletteSize] || PALETTES[16];
  const key = pal.join(",");
  if(key !== paletteKey){
    paletteKey = key;
    uniforms.uPaletteSize.value = Math.min(pal.length, 32);
    for(let i = 0; i < 32; i++){
      const hex = pal[Math.min(i, pal.length - 1)] || 0;
      // Authored display sRGB, emitted verbatim by the shader — raw channels, no ColorManagement.
      uniforms.uPalette.value[i].setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
      hexToOKLab(hex, uniforms.uPaletteLab.value[i]);
    }
  }

  uniforms.uTime.value = (performance.now() / 1000) % 100000;
  uniforms.uCamWorld.value.copy(cam.matrixWorld);
  uniforms.uNear.value = cam.near;
  uniforms.uFar.value = cam.far;
  uniforms.uOrtho.value = cam.isOrthographicCamera ? 1 : 0;
  const p = cam.projectionMatrix.elements;
  uniforms.uUnproj.value.set(p[0] ? 1 / p[0] : 1, p[5] ? 1 / p[5] : 1);
  uniforms.uEncode.value = renderer.outputColorSpace === THREE.SRGBColorSpace ? 1 : 0;
}

export default {
  name: "pixel",

  init(ctx){ ensureResources(ctx.THREE); },

  render(ctx){
    const {THREE, renderer, scene} = ctx;
    const cam = ctx.getCamera();
    ensureResources(THREE);

    stage.readBufferSize(renderer);
    const [w, h] = stage.targetSize(pixelTune, 540);
    if(stage.ensureTarget(renderer, w, h)){
      uniforms.uColor.value = stage.rt.texture;
      uniforms.uDepth.value = stage.rt.depthTexture;
      uniforms.uTexel.value.set(1 / w, 1 / h);
    }

    const snapped = pixelTune.snap !== false && stage.snapCamera(cam, w, h);
    // Sync runs BEFORE the scene render (but after the snap, so it reads the snapped matrix —
    // the frame that gets drawn): the shadow plane's field uniforms must be current when the
    // shadow map renders, and identical to the composite's copies within the frame.
    syncUniforms(THREE, renderer, cam, ctx.getSun?.());
    const sceneClouds = pixelTune.clouds !== false && pixelTune.cloudsMode === "scene";
    if(sceneClouds) ensureCloudPlane(ctx);
    if(cloudPlane){
      cloudPlane.mesh.visible = sceneClouds;   // invisible = skipped by the shadow pass too
      const cu = cloudPlane.uniforms;
      cu.uCloudScale.value = uniforms.uCloudScale.value;
      cu.uCloudSpeed.value = uniforms.uCloudSpeed.value;
      cu.uCloudCover.value = uniforms.uCloudCover.value;
      cu.uCloudBands.value = uniforms.uCloudBands.value;
      cu.uCloudOffset.value.copy(uniforms.uCloudOffset.value);
      cu.uTime.value = uniforms.uTime.value;
      cloudPlane.mesh.position.y = uniforms.uCloudHeight.value;
    }
    const normalEdgesOn = pixelTune.normalEdges === true;
    try{
      ctx.waterPrePass(w, h);
      renderer.setRenderTarget(stage.rt);
      renderer.render(scene, cam);
      if(normalEdgesOn){
        // Normals pass: whole scene under MeshNormalMaterial, shadows frozen, override restored
        // in the inner finally. The cloud plane must sit out — the override material replaces
        // its colorWrite:false placeholder, and a sky-filling plane of normals would swamp the
        // edge detector. Same for any mesh flagged userData.noNormalsPass (grass: the override
        // ignores its alpha-scissor shader, so every blade would render as a full quad of
        // normals and the edge pass would ink rectangles around the sprites).
        if(!normalMat) normalMat = new THREE.MeshNormalMaterial();
        ensureNormalTarget(THREE, w, h);
        const prevOverride = scene.overrideMaterial;
        const shadowAuto = renderer.shadowMap.autoUpdate;
        const planeWasVisible = cloudPlane ? cloudPlane.mesh.visible : false;
        if(cloudPlane) cloudPlane.mesh.visible = false;
        const hidden = [];
        scene.traverse(o => { if(o.visible && o.userData.noNormalsPass){ o.visible = false; hidden.push(o); } });
        renderer.shadowMap.autoUpdate = false;
        scene.overrideMaterial = normalMat;
        try{
          renderer.setRenderTarget(normalRt);
          renderer.render(scene, cam);
        }finally{
          scene.overrideMaterial = prevOverride;
          renderer.shadowMap.autoUpdate = shadowAuto;
          if(cloudPlane) cloudPlane.mesh.visible = planeWasVisible;
          for(const o of hidden) o.visible = true;
        }
      }else if(normalRt){
        releaseNormalTarget();
      }
    }finally{
      // The sub-pixel remainder recorded by snapCamera re-aims the composite at the true camera
      // position (uniforms themselves were synced pre-render, from the snapped matrix).
      const sub = snapped && pixelTune.subpixel !== false ? stage.snapRemainder : null;
      uniforms.uSubpixel.value.set(sub ? sub[0] : 0, sub ? sub[1] : 0);
      if(snapped) stage.unsnapCamera(cam);
    }

    stage.composite(renderer);   // explicitly to the default framebuffer, per the contract
  },

  resize(){
    stage?.releaseTarget();
    releaseNormalTarget();
  },

  dispose(ctx){
    removeCloudPlane(ctx);
    releaseNormalTarget();
    normalMat?.dispose(); normalMat = null;
    stage?.dispose();
    stage = null; uniforms = null;
    paletteKey = "";
  },
};
