// Owns: the stylized grass system — ONE instanced draw of billboarded pixel-tuft quads over any
// ground the host can sample. Recipe stolen from "How I made grass better than 99% of games"
// (youtube OxsuWDtjuGw, the Red Giraffe-adjacent Godot video) and translated to our Lambert rig:
//   · quads spawn on the ground with the TERRAIN's normal as their lighting normal, so every
//     blade lights exactly like the ground under it (his "face the Z direction upon spawning");
//   · per-instance color is sampled from the host's own ground-color math (his "do this on both
//     the grass and the floor below it"), so patches stay continuous across blades and dirt;
//   · accent blades by per-instance seed (taller, third sprite, brighter);
//   · wind = TWO value noises along ±diverged directions at irrationally-related speed/scale,
//     multiplied (his non-repeating trick), leaning each quad about the world axis ⟂ wind;
//   · quantized wind time with a per-instance phase (his low-framerate "handdrawn" charm without
//     the whole-field same-frame lag);
//   · fake perspective for near-ortho cameras: the sprite's UV.x squashes toward the tip by the
//     wind lean when the view runs parallel to the wind (his fragment-stage UV scale).
//
// INTEGRATION CONTRACT (annotated because three of these are non-obvious):
//   · The material is a MeshLambertMaterial, so material-light-mods.js patches it like everything
//     else (analytic cloud shade). userData.noToonRamp mirrors the terrain — grass IS ground.
//   · This module's onBeforeCompile REPLACES the literal `#include <begin_vertex>`, which means
//     light-mods' vertex injection (which string-targets that include) deliberately no-ops; the
//     grass shader assigns vLmWorld ITSELF (post-displacement — light-mods would capture the
//     pre-billboard vertex, i.e. the origin, and cloud shade would stop moving across the field).
//     Guarded by the GRASS_LM define, set only when light-mods is initialized, so the shader
//     still compiles in a host without the rig.
//   · mesh.userData.noNormalsPass: pixel.js's normals pass runs scene.overrideMaterial, which
//     would draw every quad as a FULL rectangle of normals and ink boxes around the sprites; the
//     pipeline hides flagged meshes for that pass.
//   · castShadow stays false (the video's call, and 40k quads in the shadow map buy nothing);
//     receiveShadow works because `transformed` ends up in world space under an identity
//     modelMatrix, so three's worldpos/shadowmap chunks are already correct.
//
// Data flow: host sampler (x,z) -> {height, normal, color, dirt} ──CPU, once per rebuild──▶
// instanced attributes ──GPU, per frame──▶ billboard + wind in the vertex stage. grassTune is
// live-read by sync() every frame (same pattern as pixelTune); geometry-shaped knobs trigger a
// debounced rebuild.

import {lightModsActive} from "./material-light-mods.js";

// ── the live tune ─────────────────────────────────────────────────────────────────────────────
// Owner defaults; hosts override via preset (test scene) or console. window mirror for tuning.
export const grassTune = {
  enabled: true,
  // geometry knobs (any change = debounced CPU rebuild)
  // Sized against the GAME's models (owner pass, Aug 20): the first-cut 1.05x1.35 blades read
  // near tree-scale in-game on the solid sprite. Smaller quads at higher density keep the same
  // ground coverage (density x W x H ≈ const) with sub-unit bump size.
  density: 3.0,        // blade quads per wu²
  bladeH: 0.85,        // wu; ±25% per-instance jitter on top
  bladeW: 0.7,         // wu; ±20% jitter
  accentRatio: 0.06,   // fraction of quads promoted to accent blades
  accentScale: 1.45,   // accent height multiplier (sprite variant 2, brightened)
  dirtClear: 0.9,      // 1 = dirt patches fully clear of grass, 0 = grass everywhere
  // wind
  windDirDeg: 25,      // world azimuth the wind blows TOWARD (0 = +x, 90 = +z)
  windAngle: 16,       // max lean, degrees
  windSpeed: 1.2,      // field drift, wu/s
  windScale: 0.09,     // 1/wu — features ~11 wu, smaller than the clouds' ~26 wu on purpose
  windDivergeDeg: 15,  // ± rotation of the two noise sample directions
  windLift: 0.18,      // brightness bias added to the multiplied noises (video's "arbitrary value")
  windGlow: 0.55,      // wind→albedo coupling: crests brighten, troughs dim slightly. This is the
                       // reference's sunlit shimmer — it supplies the frame's >180 L highlight
                       // tier (measured absent without it: 0.05% vs the reference's 2.4%) and
                       // makes the wind READ in colour, not just lean
  fps: 10,             // wind time quantize; 0 = smooth
  viewSway: 2.0,       // idle view-space sway, degrees (his "minimal levels" layer)
  viewSwayFreq: 1.4,   // Hz-ish
  // pushers (setPushers API — moving things + gusts bend blades away from themselves)
  pushAngle: 40,       // max lean away from a pusher, degrees (at falloff 1, i.e. dead centre)
  pushFps: 20,         // pusher position quantize; a touch above the wind fps reads best (video's
                       // note: fast movers under the wind's own fps look laggy). 0 = every frame
  // wear (setWearMap API — the 0..1 bare-ground field; the HOST stamps it, these knobs are read
  // by the host's stamping code so both hosts share one tuning home)
  trampleRate: 0.9,    // wear added per second under a walking unit
  trampleMax: 0.75,    // trample alone never exceeds this (flattened, not permanent dirt)
  regrowSec: 18,       // trample decay time constant, seconds
  clearRadius: 4.5,    // bare-circle radius around resource nodes, wu
  rootShade: 0.9,      // sprite base-row darkening floor (tip = 1). 0.8 measured the whole field
                       // ~20 L dark and 2.5x the reference's texture energy — the roots dominate
                       // the visible sprite area at a low camera. Texture-only swap, no rebuild.
  fakePersp: 0.5,      // 0..1 strength of the UV squash
  sprite: "solid",     // SPRITE_STYLES key — live texture swap, no rebuild. Owner pick Aug 20
                       // (in-game judging): the chunky rounded quads; "leaf" was the test-scene
                       // pick and stays one select away
  billboard: "camera", // "camera" = full camera-plane quads · "upright" = world-up cylindrical
  // debug
  debugMode: 0,        // 0 off · 1 quads (no sprite/alpha — see the plane meshes) · 2 wind noise
                       // as albedo · 3 flat instance color · 4 lighting normals
  wireframe: false,
};
if(typeof window !== "undefined") window.grassTune = grassTune;

export const GRASS_PANEL = {
  sliders: [
    ["density",       "blades /wu²", 0.2, 5, 0.1],
    ["bladeH",        "blade height wu", 0.4, 4, 0.05],
    ["bladeW",        "blade width wu", 0.3, 3, 0.05],
    ["accentRatio",   "accent ratio", 0, 0.3, 0.01],
    ["accentScale",   "accent scale", 1, 3, 0.05],
    ["dirtClear",     "dirt clearing", 0, 1, 0.05],
    "wind",
    ["windDirDeg",    "wind azimuth", -180, 180, 1],
    ["windAngle",     "max lean deg", 0, 60, 1],
    ["windSpeed",     "wind speed", 0, 6, 0.05],
    ["windScale",     "wind scale 1/wu", 0.01, 0.5, 0.005],
    ["windDivergeDeg","noise diverge", 0, 45, 1],
    ["windLift",      "wind lift", 0, 1, 0.01],
    ["windGlow",      "wind glow", 0, 1.5, 0.05],
    ["rootShade",     "root shade floor", 0.5, 1, 0.02],
    ["fps",           "anim fps (0=smooth)", 0, 30, 1],
    ["viewSway",      "idle sway deg", 0, 10, 0.25],
    ["viewSwayFreq",  "idle sway freq", 0.1, 5, 0.05],
    ["fakePersp",     "fake perspective", 0, 2, 0.05],
    "push",
    ["pushAngle",     "push lean deg", 0, 80, 1],
    ["pushFps",       "push fps (0=every)", 0, 60, 1],
    "wear",
    ["trampleRate",   "trample /s", 0, 3, 0.05],
    ["trampleMax",    "trample cap", 0, 1, 0.05],
    ["regrowSec",     "regrow s", 1, 60, 1],
    ["clearRadius",   "resource clear wu", 0, 6, 0.1],
  ],
  checks: [["enabled", "grass"], ["wireframe", "wireframe"]],
  selects: [
    ["sprite", "sprite", ["tufts", "leaf", "sprigs", "blades", "wisps", "solid"]],
    ["billboard", "billboard", [["camera", "camera-plane"], ["upright", "upright"]]],
    ["debugMode", "debug view", [[0, "off"], [1, "quads"], [2, "wind noise"], [3, "flat color"], [4, "normals"], [5, "push"], [6, "wear"]]],
  ],
  tips: {
    density: "rebuilds ~250ms after the slider settles (CPU resample of the ground)",
    dirtClear: "probability a blade is culled scales with the ground's dirt weight",
    windLift: "baseline of the multiplied noise pair — raises how much of the field sways at once",
    windGlow: "wind crests brighten blade albedo, troughs dim it — the moving sunlit-shimmer tier; 0 = lean only",
    rootShade: "how dark sprite base rows bake vs the tip; higher = flatter, brighter, quieter field",
    fps: "wind time is quantized per instance with a random phase, so updates don't all land on the same frame",
    fakePersp: "squashes the sprite toward the tip when the view is parallel to the wind — depth cue for near-ortho cameras",
    sprite: "blade atlas style (authored in grass.js SPRITE_STYLES; previews via tools/test-scene/grass-sprite.mjs)",
    debugMode: "quads = full plane meshes, no sprite cutout; wind noise = the sampled wind field as albedo; push = pusher influence, blue→red; wear = bare-ground field on the surviving blades (worn blades shrink away)",
    pushAngle: "blades inside a pusher's radius lean away from it (setPushers API); gusts are phantom pushers",
    pushFps: "pusher positions update on this tick so fast movers keep the choppy charm without lag",
    trampleRate: "walking units add this much wear per second; blades shrink with wear (setWearMap)",
    trampleMax: "trample saturates here so paths flatten but never turn permanently bare",
    regrowSec: "trampled grass grows back on this time constant once the traffic stops",
    clearRadius: "permanent bare circle stamped around trees/rocks/diamonds (buildings use their footprint)",
  },
};

// Geometry-shaped knobs; a change to any of these re-samples the ground and rebuilds attributes.
const REBUILD_KEYS = ["density", "bladeH", "bladeW", "accentRatio", "accentScale", "dirtClear"];
// Covers the largest game map (?mapSize=5: ~153k wu² of land at the default density 3 ≈ 460k
// blades). Hitting the cap truncates the spawn sweep mid-map — a visible bare band — so it must
// stay above any real region; the warn below is the tripwire.
const MAX_INSTANCES = 520000;
const DEG = Math.PI / 180;

// ── deterministic CPU hash (same family as tools/test-scene/terrain.js; Math.imul is exact) ──
function hash2(ix, iy, seed){
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ── blade sprite atlases: hand-authored pixel styles, 3 variants each ────────────────────────
// grassTune.sprite picks the STYLE (live swap, texture only — no geometry rebuild); within a
// style, variants 0/1 are the normal blades and variant 2 is the accent sprite.
// Rows are listed TOP-FIRST for readability and written bottom-up (uv.y 0 = quad base = ground).
// Chars: ' ' transparent, '.' 0.78, 'o' 0.88, '#' 1.0 — near-white so the per-instance ground
// color owns the hue; a mild root-darkening gradient bakes in ground contact.
// Preview PNGs: node tools/test-scene/grass-sprite.mjs → tools/shots/grass-sprites/.
// The leaf style's base sprite, hoisted so variant 1 can be its mirror.
const LEAF_PINWHEEL = [
  "            ####    ",
  "           ######   ",
  "  ####     #######  ",
  " ########  #######  ",
  " #########  ######  ",
  "  ########  ######  ",
  "   #######  #####   ",
  "    ######  #####   ",
  "     ####   ####    ",
  "      ##    ###     ",
  "           ###      ",
  "        ####        ",
  "       ######       ",
  "      #######       ",
  "     #######        ",
  "    #######         ",
  "    ######          ",
  "   #####            ",
  "    ###             ",
  "                    ",
];
const SPRITE_STYLES = {
  tufts: {w: 12, h: 12, rows: [
    [ // variant 0 — 4-blade fan
      "            ",
      "     #      ",
      " .   #      ",
      " .   #    o ",
      "  .  #    o ",
      "  .  #   o  ",
      "   . #  o   ",
      "   .##  o   ",
      "    .# o    ",
      "    .#o     ",
      "     #o     ",
      "     ##     ",
    ],
    [ // variant 1 — 3 blades, squatter
      "            ",
      "            ",
      "    o       ",
      "    o    .  ",
      " #  o    .  ",
      " #  o   .   ",
      " #  o   .   ",
      "  # o  .    ",
      "  # o  .    ",
      "   #o .     ",
      "   #o.      ",
      "    ##      ",
    ],
    [ // variant 2 — accent: dense, reaches the full quad
      "     #      ",
      "     #      ",
      "  o  #      ",
      "  o  #  .   ",
      "  o  #  .   ",
      "   o #  .   ",
      "   o # .    ",
      "   o # .    ",
      "    o#.     ",
      "    o#.     ",
      "     #.     ",
      "     ##     ",
    ],
  ]},
  // Broad-leaf pinwheel, transcribed from the reference video's own grass sprite (owner
  // attachment, Aug 20): three FAT solid ovals converging on the center with 1-2px gaps — no
  // stems. Fat silhouettes survive the low-res RT's minification far better than 1px strokes.
  // Variant 1 is the exact mirror of 0 (built below); variant 2 is the taller accent cluster.
  leaf: {w: 20, h: 20, rows: [
    LEAF_PINWHEEL,
    LEAF_PINWHEEL.map(r => [...r].reverse().join("")),
    [ // accent — same family, leaves reaching higher
      "        ####        ",
      "       ######       ",
      "  ##   #######      ",
      " ####  #######      ",
      " #####  ######      ",
      "  #####  #####      ",
      "   ####  #####      ",
      "    ###   ####      ",
      "     ##   ###       ",
      "          ###       ",
      "         ###        ",
      "       ####   ##    ",
      "      #####  ####   ",
      "     #####  ####    ",
      "    #####  ####     ",
      "    ####  ###       ",
      "   ####  ##         ",
      "   ###              ",
      "    #               ",
      "                    ",
    ],
  ]},
  // The first leaf attempt (skinny stemmed clusters) — kept by owner request, it reads as its
  // own thing: wilder, stalkier foliage than the pinwheel.
  sprigs: {w: 16, h: 16, rows: [
    [ // variant 0 — big right leaf, left leaf, low droop
      "           ###  ",
      "          ####  ",
      "  o      #####  ",
      " ooo     #####  ",
      "ooooo   #####   ",
      " ooooo  #####   ",
      "  ooooo#####    ",
      "   ooo #####    ",
      "    oo ####     ",
      "     . ###      ",
      "     .###       ",
      "    ..###       ",
      "   ...##        ",
      "  ....#         ",
      "   ..##         ",
      "     #          ",
    ],
    [ // variant 1 — mirrored pair
      "  ##            ",
      " ####           ",
      " #####          ",
      "  #####    o    ",
      "  #####   ooo   ",
      "   ##### ooooo  ",
      "    #########   ",
      "    #### oooo   ",
      "     ###  oo    ",
      "     ###   o    ",
      "      ##        ",
      "     .##        ",
      "    ..##        ",
      "     .#         ",
      "     ##         ",
      "      #         ",
    ],
    [ // variant 2 — accent: three leaves up
      "   o    ##      ",
      "  ooo  ####     ",
      " ooooo #####    ",
      " ooooo #####  . ",
      "  ooooo#####  . ",
      "   ooo ##### .. ",
      "    oo #### ... ",
      "     o #### ..  ",
      "      #### ...  ",
      "      ### ...   ",
      "      ######    ",
      "       ####     ",
      "      ####      ",
      "     ###        ",
      "      ##        ",
      "      #         ",
    ],
  ]},
  // 2px tapered blades — the middle ground between tufts and leaf.
  blades: {w: 14, h: 14, rows: [
    [
      "      #       ",
      "      #       ",
      "  o   ##      ",
      "  o   ##   .  ",
      "  oo  ##   .  ",
      "  oo  ##  ..  ",
      "   oo ##  ..  ",
      "   oo ##  ..  ",
      "   oo##  ..   ",
      "    o##  ..   ",
      "    ###  .    ",
      "    ### ..    ",
      "     ####     ",
      "     ###      ",
    ],
    [
      "   o          ",
      "   o          ",
      "   oo    #    ",
      "   oo    #    ",
      "    oo   ##   ",
      "    oo   ##   ",
      "    oo  ###   ",
      "  .  oo ##    ",
      "  .. oo ##    ",
      "   ..oo##     ",
      "   ..oo##     ",
      "    .####     ",
      "    ####      ",
      "     ##       ",
    ],
    [ // accent
      "      ##      ",
      "      ##      ",
      "  o   ##      ",
      "  oo  ##  .   ",
      "  oo  ##  .   ",
      "   oo ##  ..  ",
      "   oo ##  ..  ",
      "   oo ## ..   ",
      "    o### ..   ",
      "    ####..    ",
      "    #####     ",
      "     ####     ",
      "     ###      ",
      "      ##      ",
    ],
  ]},
  // The quads-debug look promoted to a real style (owner request: "nice chunky feel") — opaque
  // rounded-corner quads through the NORMAL path, so lighting, wind lean, accents and the root
  // shade all apply, unlike debugMode 1 which bypasses the sprite entirely.
  solid: {w: 10, h: 10, rows: [
    [ // variant 0 — 1px clipped corners
      " ######## ",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      " ######## ",
    ],
    [ // variant 1 — rounder
      "  ######  ",
      " ######## ",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      " ######## ",
      "  ######  ",
    ],
    [ // variant 2 — accent: domed top, full base
      "   ####   ",
      "  ######  ",
      " ######## ",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
      "##########",
    ],
  ]},
  // Thin curved wisps — sparser, leans hard on the wind read.
  wisps: {w: 12, h: 12, rows: [
    [
      "     #      ",
      "    ##      ",
      "    #   o   ",
      "   ##   o   ",
      "   #   o    ",
      "   #   o  . ",
      "  ##  o   . ",
      "  #   o  .  ",
      "  ##  o  .  ",
      "   ## o .   ",
      "    ##o.    ",
      "     ##     ",
    ],
    [
      "      #     ",
      "      ##    ",
      "   o   #    ",
      "   o   ##   ",
      "    o   #   ",
      " .  o   #   ",
      " .   o  ##  ",
      "  .  o   #  ",
      "  .  o  ##  ",
      "   . o ##   ",
      "    .o##    ",
      "     ##     ",
    ],
    [ // accent
      "    #       ",
      "    ##      ",
      "     #  o   ",
      "     ## o   ",
      "  .   # o   ",
      "  .   ##o   ",
      "   .   #o   ",
      "   .   #o   ",
      "    .  #o   ",
      "    . ##o   ",
      "     .#o    ",
      "     ##     ",
    ],
  ]},
};
const VARIANTS = 3;
const CHAR_LEVEL = {".": 0.78, "o": 0.88, "#": 1.0};

/** Raw RGBA pixels of one style's atlas (texel row 0 = blade base). Exported for
 *  tools/test-scene/grass-sprite.mjs, which dumps every style to a PNG for eyeballing. */
export function bladeAtlasPixels(style = "tufts", rootFloor = grassTune.rootShade){
  const s = SPRITE_STYLES[style];
  if(!s) throw new Error(`grass: unknown sprite style "${style}"`);
  for(const rows of s.rows){
    if(rows.length !== s.h || rows.some(r => r.length !== s.w))
      throw new Error(`grass: sprite style "${style}" variant ${s.rows.indexOf(rows)} is not ${s.w}x${s.h}`);
  }
  const data = new Uint8Array(s.w * VARIANTS * s.h * 4);
  for(let v = 0; v < VARIANTS; v++){
    const rows = s.rows[v];
    for(let ry = 0; ry < s.h; ry++){
      const row = rows[s.h - 1 - ry];             // texel row 0 = base
      const rootShade = rootFloor + (1 - rootFloor) * (ry / (s.h - 1));
      for(let rx = 0; rx < s.w; rx++){
        const level = CHAR_LEVEL[row[rx]];
        if(level === undefined) continue;
        const i = ((ry * s.w * VARIANTS) + v * s.w + rx) * 4;
        const val = Math.round(255 * level * rootShade);
        data[i] = data[i + 1] = data[i + 2] = val;
        data[i + 3] = 255;
      }
    }
  }
  return {width: s.w * VARIANTS, height: s.h, data};
}
export const SPRITE_STYLE_NAMES = Object.keys(SPRITE_STYLES);

function makeBladeTexture(THREE, style, rootFloor){
  const {width, height, data} = bladeAtlasPixels(SPRITE_STYLES[style] ? style : "tufts", rootFloor);
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = `grass-${style}`;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;   // no mips: alpha-tested 1px blades erode under mips, and
  tex.generateMipmaps = false;           // the pixel pipeline's low-res RT is the real filter
  tex.colorSpace = THREE.SRGBColorSpace; // albedo data, same decode path as any material map
  tex.needsUpdate = true;
  return tex;
}

// ── shader injections ────────────────────────────────────────────────────────────────────────
const MAX_PUSHERS = 32;   // fixed shader array; unused slots carry radius 0 and cost ~nothing

const VERT_DECL = /* glsl */`
#define GRASS_MAX_PUSHERS ${MAX_PUSHERS}
attribute vec3 iOffset;
attribute vec4 iData;    // x width wu · y height wu · z phase 0..1 · w sprite variant
uniform float uGrassTime, uGrassFps, uGrassWindSpeed, uGrassWindScale, uGrassWindDiv,
  uGrassWindLift, uGrassWindAngle, uGrassSway, uGrassSwayFreq, uGrassPersp, uGrassUpright,
  uGrassPushAngle;
uniform vec4 uGrassPushers[GRASS_MAX_PUSHERS];   // xyz world pos · w radius wu (0 = inert)
uniform vec2 uGrassWindDir;
uniform sampler2D uGrassWear;   // the host's 0..1 bare-ground field (setWearMap); R channel
uniform vec4 uGrassWearRect;    // xy = region origin wu · zw = 1/region size (world → uv)
uniform float uGrassWearOn, uGrassDebug;    // uGrassDebug also declared in the fragment stage
varying float vGrassWind, vGrassPersp, vGrassPush, vGrassWear;
varying vec3 vGrassUv;
float gHash21(vec2 p){ p = fract(p * vec2(127.31, 311.71)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
float gNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash21(i), gHash21(i + vec2(1.0, 0.0)), u.x),
             mix(gHash21(i + vec2(0.0, 1.0)), gHash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// Replaces `#include <begin_vertex>` outright — see the header's light-mods coupling note.
const VERT_BODY = /* glsl */`
vec3 transformed = vec3( position );
vGrassWind = 0.0; vGrassPersp = 0.0; vGrassPush = 0.0; vGrassWear = 0.0;
{
  float gp = iData.z;
  float gt = uGrassTime;
  // Low-fps charm: quantize the wind clock, phase-shifted per instance so updates stagger.
  if(uGrassFps > 0.5) gt = floor((gt + gp * 37.0) * uGrassFps) / uGrassFps;
  // Wind: two directions rotated ±diverge off the wind azimuth, sampled at irrationally related
  // speed/scale (1.618 / π/2) and MULTIPLIED — the pair never re-aligns, so no visible loop.
  vec2 base = iOffset.xz;
  float dc = cos(uGrassWindDiv), ds = sin(uGrassWindDiv);
  vec2 d1 = vec2(uGrassWindDir.x * dc - uGrassWindDir.y * ds, uGrassWindDir.x * ds + uGrassWindDir.y * dc);
  vec2 d2 = vec2(uGrassWindDir.x * dc + uGrassWindDir.y * ds, -uGrassWindDir.x * ds + uGrassWindDir.y * dc);
  float n1 = gNoise((base - d1 * (gt * uGrassWindSpeed)) * uGrassWindScale);
  float n2 = gNoise((base - d2 * (gt * uGrassWindSpeed * 1.618)) * (uGrassWindScale * 1.5707963));
  float wind = clamp(n1 * n2 * 1.7 + uGrassWindLift, 0.0, 1.0);
  vGrassWind = wind;
  // Billboard frame from the view matrix (world-space camera right/up live in its columns).
  vec3 bbRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 bbUp;
  if(uGrassUpright > 0.5){
    bbRight = normalize(vec3(bbRight.x, 0.0, bbRight.z));
    bbUp = vec3(0.0, 1.0, 0.0);
  }else{
    bbUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  }
  // Wear: blades SHRINK toward zero with the host's bare-ground field (buildings, resource
  // clearings, trample). A zero-size quad emits no fragments, so wear 1 is a free discard; the
  // texture's linear filtering supplies the drop-off rim between texels. The wear debug view (6)
  // keeps blades FULL SIZE so the field's alignment can be judged against the ground meshes.
  float wear = uGrassWearOn > 0.5
    ? texture2D(uGrassWear, (iOffset.xz - uGrassWearRect.xy) * uGrassWearRect.zw).r : 0.0;
  vGrassWear = wear;
  if(uGrassDebug == 6.0) wear = 0.0;
  // Idle view-space sway: tiny rotation about the quad base, in the billboard plane.
  float ia = uGrassSway * sin(gt * uGrassSwayFreq * 6.2831853 + gp * 6.2831853);
  float ic = cos(ia), isn = sin(ia);
  vec2 lp = vec2(position.x * iData.x, position.y * iData.y) * (1.0 - wear);
  lp = vec2(lp.x * ic - lp.y * isn, lp.x * isn + lp.y * ic);
  vec3 offset = bbRight * lp.x + bbUp * lp.y;
  // Wind lean: Rodrigues about the horizontal axis ⟂ wind, so the tip moves DOWNWIND.
  float wa = uGrassWindAngle * wind;
  vec3 ax = vec3(uGrassWindDir.y, 0.0, -uGrassWindDir.x);
  float wc = cos(wa), wsn = sin(wa);
  offset = offset * wc + cross(ax, offset) * wsn + ax * dot(ax, offset) * (1.0 - wc);
  // Pushers (the video's character displacement, vectorised): every active pusher adds a
  // radially-outward push scaled by (1-d/r)² — quadratic falloff so the wake has a soft rim.
  // The SUM is direction-weighted, so a blade between two movers leans by their resultant, then
  // one Rodrigues bend applies it (same axis rule as the wind: tip moves along the push).
  vec2 push = vec2(0.0);
  for(int i = 0; i < GRASS_MAX_PUSHERS; i++){
    vec4 p = uGrassPushers[i];
    if(p.w < 0.001) continue;
    vec2 d = iOffset.xz - p.xz;
    float dist = length(d);
    if(dist >= p.w) continue;
    float m = 1.0 - dist / p.w;
    push += (d / max(dist, 0.001)) * (m * m);
  }
  float pushLen = length(push);
  if(pushLen > 0.001){
    vGrassPush = min(pushLen, 1.0);
    vec2 pd = push / pushLen;
    float pa = uGrassPushAngle * min(pushLen, 1.0);
    vec3 pax = vec3(pd.y, 0.0, -pd.x);
    float pc = cos(pa), psn = sin(pa);
    offset = offset * pc + cross(pax, offset) * psn + pax * dot(pax, offset) * (1.0 - pc);
  }
  transformed = iOffset + offset;
  // Fake perspective: only meaningful when the view direction runs along the wind.
  vec3 camFwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vGrassPersp = uGrassPersp * wind * dot(normalize(camFwd.xz + vec2(1e-6, 0.0)), uGrassWindDir);
  #ifdef GRASS_LM
    vLmWorld = transformed;   // light-mods' capture point; see header
  #endif
}
`;

const FRAG_DECL = /* glsl */`
varying float vGrassWind, vGrassPersp, vGrassPush, vGrassWear;
varying vec3 vGrassUv;
uniform float uGrassDebug, uGrassGlow;
`;

// Replaces `#include <map_fragment>`: fake-perspective squash of the LOCAL uv about the sprite
// axis (tip moves most — weight (1-uv.y)), then the variant atlas lookup. Debug 1 skips the
// sprite entirely so the raw quads render.
const FRAG_MAP = /* glsl */`
{
  float gU = clamp((vGrassUv.x - 0.5) * (1.0 + vGrassPersp * (1.0 - vGrassUv.y)) + 0.5, 0.0, 1.0);
  vec4 sampledDiffuseColor = uGrassDebug == 1.0 ? vec4(1.0)
    : texture2D(map, vec2((gU + vGrassUv.z) / ${VARIANTS}.0, vGrassUv.y));
  diffuseColor *= sampledDiffuseColor;
  // Wind glow (the reference's moving sunlit shimmer): crests brighten albedo, troughs dim.
  // Centered on 0.35 — the field's typical value under the default lift — so the MEAN stays put
  // and the glow adds contrast range, not exposure.
  // Upper clamp keeps crest blades under the frame's peak-luma gate (unclamped they measured 217).
  diffuseColor.rgb *= clamp(1.0 + uGrassGlow * (vGrassWind - 0.35), 0.0, 1.15);
}
`;

const FRAG_DEBUG = /* glsl */`
#include <dithering_fragment>
if(uGrassDebug == 2.0) gl_FragColor = vec4(vec3(vGrassWind), 1.0);
else if(uGrassDebug == 3.0) gl_FragColor = vec4(vColor, 1.0);
else if(uGrassDebug == 4.0) gl_FragColor = vec4(normalize(vNormal) * 0.5 + 0.5, 1.0);
else if(uGrassDebug == 5.0) gl_FragColor = vec4(vGrassPush, 0.08, 1.0 - vGrassPush, 1.0);
else if(uGrassDebug == 6.0) gl_FragColor = vec4(vGrassWear, vGrassWear * 0.6, 0.08, 1.0);
`;

// ── instance building ────────────────────────────────────────────────────────────────────────
/**
 * Sample the ground over a jittered grid and fill instanced attributes.
 * `sample(x,z)` -> {height, normal:[x,y,z], color:[r,g,b] linear, dirt:0..1} — the host's ground
 * authority (test scene: terrain.js makeGroundSampler; game: scene.js meadowSample). A sample may
 * instead return {skip:true} for a HARD exclusion (water, fog, off-map) — unlike `dirt`, which
 * culls probabilistically so patch borders stay ragged. Deterministic for a fixed seed.
 */
function buildGeometry(THREE, {seed, region, sample, tune}){
  const geo = new THREE.InstancedBufferGeometry();
  // Base quad: x centered, y 0 at the ground anchor. CCW so camera-plane billboards front-face.
  geo.setAttribute("position", new THREE.Float32BufferAttribute(
    [-0.5, 0, 0,  0.5, 0, 0,  0.5, 1, 0,  -0.5, 1, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const step = 1 / Math.sqrt(Math.max(0.05, tune.density));
  const offsets = [], datas = [], colors = [], normals = [];
  let count = 0;
  for(let gx = region.x0; gx < region.x1 && count < MAX_INSTANCES; gx += step){
    for(let gz = region.z0; gz < region.z1 && count < MAX_INSTANCES; gz += step){
      const ix = Math.round(gx * 97), iz = Math.round(gz * 97);   // stable per-cell hash lattice
      const px = gx + hash2(ix, iz, seed + 11) * step;
      const pz = gz + hash2(ix, iz, seed + 23) * step;
      const g = sample(px, pz);
      if(g.skip) continue;
      // Dirt clears grass probabilistically, so patch borders thin out instead of hard-cutting.
      if(hash2(ix, iz, seed + 31) < g.dirt * tune.dirtClear) continue;
      const accent = hash2(ix, iz, seed + 47) < tune.accentRatio;
      let h = tune.bladeH * (0.75 + 0.5 * hash2(ix, iz, seed + 59));
      const w = tune.bladeW * (0.8 + 0.4 * hash2(ix, iz, seed + 67));
      let variant = hash2(ix, iz, seed + 71) < 0.5 ? 0 : 1;
      // Mean 1.07, ±5% jitter: sprite level x root shade averages ~0.90, which dimmed the WHOLE
      // field ~10% against the rig's bare-ground albedo solve (p50 119 vs the reference's 134,
      // measured) — the tint compensates so a blade-covered meadow keeps the solved exposure.
      // Jitter tightened from ±8%: root gradient + wind glow already feed per-blade variation.
      let tint = 1.02 + 0.10 * hash2(ix, iz, seed + 83);
      if(accent){ h *= tune.accentScale; variant = 2; tint *= 1.2; }
      offsets.push(px, g.height, pz);
      datas.push(w, h, hash2(ix, iz, seed + 89), variant);
      colors.push(Math.min(1, g.color[0] * tint), Math.min(1, g.color[1] * tint),
                  Math.min(1, g.color[2] * tint));
      normals.push(g.normal[0], g.normal[1], g.normal[2]);
      count++;
    }
  }
  if(count >= MAX_INSTANCES) console.warn(`[grass] instance cap hit (${MAX_INSTANCES}) — lower density or region`);
  geo.setAttribute("iOffset", new THREE.InstancedBufferAttribute(new Float32Array(offsets), 3));
  geo.setAttribute("iData", new THREE.InstancedBufferAttribute(new Float32Array(datas), 4));
  // Built-in attribute names carry per-instance values here: three binds any
  // InstancedBufferAttribute with divisor 1, so every vertex of a quad shares its blade's
  // ground color and TERRAIN normal — the whole ground-matching trick in two lines.
  geo.setAttribute("color", new THREE.InstancedBufferAttribute(new Float32Array(colors), 3));
  geo.setAttribute("normal", new THREE.InstancedBufferAttribute(new Float32Array(normals), 3));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3((region.x0 + region.x1) / 2, 0, (region.z0 + region.z1) / 2),
    Math.hypot(region.x1 - region.x0, region.z1 - region.z0) / 2 + 30);
  return geo;
}

/**
 * Build the grass. Caller owns the lifecycle: add mesh to the scene, call sync(time) every frame
 * (same clock pixel.js reads, so ?t= freezes the wind too), dispose() when done.
 */
export function createGrass(THREE, {seed, region, sample, lightMods = lightModsActive(), tune = grassTune}){
  const uniforms = {
    uGrassTime: {value: 0}, uGrassFps: {value: tune.fps},
    uGrassWindDir: {value: new THREE.Vector2(1, 0)},
    uGrassWindSpeed: {value: 0}, uGrassWindScale: {value: 0.09}, uGrassWindDiv: {value: 0},
    uGrassWindLift: {value: 0}, uGrassWindAngle: {value: 0},
    uGrassSway: {value: 0}, uGrassSwayFreq: {value: 0},
    uGrassPersp: {value: 0}, uGrassUpright: {value: 0}, uGrassDebug: {value: 0},
    uGrassGlow: {value: 0},
    uGrassPushAngle: {value: 0},
    uGrassPushers: {value: Array.from({length: MAX_PUSHERS}, () => new THREE.Vector4(0, 0, 0, 0))},
    uGrassWearOn: {value: 0},
    uGrassWear: {value: null},
    uGrassWearRect: {value: new THREE.Vector4(region.x0, region.z0,
      1 / Math.max(1e-6, region.x1 - region.x0), 1 / Math.max(1e-6, region.z1 - region.z0))},
  };

  let spriteStyle = SPRITE_STYLES[tune.sprite] ? tune.sprite : "tufts";
  let builtRootShade = tune.rootShade;
  let map = makeBladeTexture(THREE, spriteStyle, builtRootShade);
  const mat = new THREE.MeshLambertMaterial({map, alphaTest: 0.5, vertexColors: true});
  mat.name = "grass";
  mat.userData.noToonRamp = true;   // grass is ground; the meadow measured better un-banded
  // defines feed three's program cache key, so this program can never be reused for a plain
  // Lambert (light-mods overwrites customProgramCacheKey with its own; the define disambiguates).
  mat.defines = {GRASS: 1};
  if(lightMods) mat.defines.GRASS_LM = 1;
  mat.onBeforeCompile = shader => {
    shader.vertexShader = VERT_DECL + shader.vertexShader
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n\tvGrassUv = vec3(uv, iData.w);")
      .replace("#include <begin_vertex>", VERT_BODY);
    shader.fragmentShader = FRAG_DECL + shader.fragmentShader
      .replace("#include <map_fragment>", FRAG_MAP)
      .replace("#include <alphatest_fragment>",
               "if(uGrassDebug != 1.0 && diffuseColor.a < alphaTest) discard;")
      .replace("#include <dithering_fragment>", FRAG_DEBUG);
    Object.assign(shader.uniforms, uniforms);
  };

  let geo = buildGeometry(THREE, {seed, region, sample, tune});
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "grass";
  mesh.frustumCulled = false;       // one region-sized draw; the sphere is set but never load-bearing
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.noNormalsPass = true;   // see header — pixel.js hides this for its normals pass
  mesh.raycast = () => {};              // inert to pickers, like the cloud plane

  // Debounced rebuild on geometry-shaped knob changes. Date.now, not performance.now — the
  // screenshot harness freezes performance.now and the debounce must still elapse in live use.
  let builtKey = REBUILD_KEYS.map(k => tune[k]).join(",");
  let pendingKey = builtKey, pendingSince = 0;

  // Pushers: the caller hands a fresh list any time (game: movers each frame; gusts are phantom
  // entries); sync copies it into the uniform array on the pushFps tick so fast movers stay on
  // the same choppy clock as everything else. Extra entries beyond MAX_PUSHERS are dropped —
  // callers with many movers should pass the ones that matter (e.g. nearest the camera).
  let pushers = [], lastPushTick = null;
  function setPushers(list){ pushers = list || []; }

  /** Hand over the 0..1 bare-ground field: an R-channel texture covering exactly `region`
   *  (LinearFilter recommended — the filtering IS the clearing's drop-off rim). The HOST owns
   *  the texture, its stamping, and its updates; null turns wear off. */
  function setWearMap(texture){
    uniforms.uGrassWear.value = texture;
    uniforms.uGrassWearOn.value = texture ? 1 : 0;
  }
  function applyPushers(){
    const u = uniforms.uGrassPushers.value;
    const n = Math.min(pushers.length, MAX_PUSHERS);
    for(let i = 0; i < n; i++){
      const p = pushers[i];
      u[i].set(p.x, p.y || 0, p.z, p.r);
    }
    for(let i = n; i < MAX_PUSHERS; i++) u[i].w = 0;
  }

  function sync(time){
    uniforms.uGrassTime.value = time;
    uniforms.uGrassFps.value = tune.fps;
    uniforms.uGrassWindDir.value.set(Math.cos(tune.windDirDeg * DEG), Math.sin(tune.windDirDeg * DEG));
    uniforms.uGrassWindSpeed.value = tune.windSpeed;
    uniforms.uGrassWindScale.value = tune.windScale;
    uniforms.uGrassWindDiv.value = tune.windDivergeDeg * DEG;
    uniforms.uGrassWindLift.value = tune.windLift;
    uniforms.uGrassWindAngle.value = tune.windAngle * DEG;
    uniforms.uGrassSway.value = tune.viewSway * DEG;
    uniforms.uGrassSwayFreq.value = tune.viewSwayFreq;
    uniforms.uGrassPersp.value = tune.fakePersp;
    uniforms.uGrassUpright.value = tune.billboard === "upright" ? 1 : 0;
    uniforms.uGrassDebug.value = +tune.debugMode || 0;
    uniforms.uGrassGlow.value = tune.windGlow || 0;
    uniforms.uGrassPushAngle.value = tune.pushAngle * DEG;
    mat.wireframe = !!tune.wireframe;
    mesh.visible = tune.enabled !== false;

    const tick = tune.pushFps > 0 ? Math.floor(time * tune.pushFps) : null;
    if(tick === null || tick !== lastPushTick){ lastPushTick = tick; applyPushers(); }

    // Sprite style / root shade: texture-only swap, same USE_MAP program — no recompile, no rebuild.
    const style = SPRITE_STYLES[tune.sprite] ? tune.sprite : "tufts";
    if(style !== spriteStyle || tune.rootShade !== builtRootShade){
      spriteStyle = style;
      builtRootShade = tune.rootShade;
      const next = makeBladeTexture(THREE, style, builtRootShade);
      mat.map = next;
      map.dispose();
      map = next;
    }

    const key = REBUILD_KEYS.map(k => tune[k]).join(",");
    if(key !== pendingKey){ pendingKey = key; pendingSince = Date.now(); }
    if(pendingKey !== builtKey && Date.now() - pendingSince > 250){
      const next = buildGeometry(THREE, {seed, region, sample, tune});
      mesh.geometry = next;
      geo.dispose();
      geo = next;
      builtKey = pendingKey;
    }
  }

  return {
    mesh, uniforms, sync, setPushers, setWearMap,
    instanceCount: () => geo.instanceCount,
    /** Re-sample the ground now (host's terrain/fog changed under the blades). Tune-driven
     *  rebuilds stay on the debounced sync path; this is for external invalidation. */
    rebuild(){
      const next = buildGeometry(THREE, {seed, region, sample, tune});
      mesh.geometry = next;
      geo.dispose();
      geo = next;
    },
    dispose(){ geo.dispose(); mat.dispose(); map.dispose(); },
  };
}
