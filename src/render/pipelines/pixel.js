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
//   toon  — 5-tap sharpen, sun-projected banded cloud shadows, Bayer dither, the display-space
//           quantize law, the authored 8-colour ramp.
// New here (not in either parent):
//   · SUB-PIXEL RECONSTRUCTION: the composite samples the RT at uv + snapRemainder*texel, so the
//     snapped render is shown from the TRUE camera position — pans glide instead of stepping
//     whole texels (Red Giraffe's offset quad / three.js example's frustum shift, done in UV).
//     Side effect: the drawn frame now matches the unsnapped camera, so the overlay/picking skew
//     retro documents mostly disappears. Sampling can read up to half a texel outside the RT;
//     ClampToEdge duplicates the border texel there — accepted, invisible in practice.
//   · NEAREST-PALETTE MATCH IN OKLAB (quantizeMode 2): per pixel, nearest of the authored palette
//     by OKLab distance — Red Giraffe's CIELAB move on our OKLab plumbing. The pixel's colour is
//     already linear (the RT is linear; OKLab's matrices want linear), palette hexes are
//     sRGB→linear→OKLab'd on the CPU, and the WINNING entry is output as its verbatim authored
//     sRGB value (no round trip, same rule as toon's ramp mode). Perceptually uniform L means
//     this does not suffer the linear-quantize dark-crush the display-space law exists for.
//   · DITHER ENDPOINT FADE (rgb mode): Bayer noise fades within 0.6 quantization units of 0/1 —
//     Photosounder's measured black-lift (~0.16 units) otherwise keeps true black unreachable.
//
// Passes (per frame)
//   0. camera texel snap (post-stage) — also records the sub-pixel remainder.
//   1. ctx.waterPrePass(rtW, rtH)
//   2. scene → low-res colour+depth target (NEAREST both ways = the upscale)
//   2b. optional normals pass (normalEdges mode, +1 scene draw, shadows frozen)
//   3. fullscreen composite, in Red Giraffe's order: sharpen → cloud shadow (pre-quantize fold)
//      → outline band-shift (OKLab, selout) → quantize (one of three modes) → encode.
//
// Quantize modes (`quantizeMode`):
//   0 oklab bands — retro's look: 32-band OKLab lightness posterize + blue shift (default).
//   1 rgb levels  — toon's look: display-space per-channel floor + Bayer dither.
//   2 palette     — nearest-in-OKLab against an authored palette tier (dithered on L).
//
// COLOR SPACE / precision: see post-stage.js's COLOR SPACE header — linear RT (HalfFloat when the
// driver can render to it; the RGBA8 fallback WILL band in the darks before any quantizer runs),
// manual sRGB encode in the composite, gated on renderer.outputColorSpace.

// Three authored palettes for quantize mode 2, all built from the game's hue families
// (night-navy, grass greens, sun-creams, stone greys, wood browns, water blues, portal purple).
// paletteSize picks one; setting pixelTune.palette to an array of hexes overrides them entirely.
const PALETTES = {
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

/** Live-read every frame. Exported and mirrored on window for console tuning. */
export const pixelTune = {
  targetHeight: 540,
  pixelScale: 0.4,       // owner defaults, Aug 19 (panel session): scale wins over targetHeight
  snap: true,
  subpixel: true,        // sub-pixel reconstruction at the upscale (needs snap)
  // toon half
  sharpen: 0.6,
  clouds: true,
  cloudScale: 0.02,
  cloudSpeed: 0.01,
  cloudCover: 0.52,
  cloudDarken: 0.72,
  cloudHeight: 60,
  cloudBands: 3,
  // retro half
  outlines: true,
  outlineStrength: 4,    // owner default, Aug 19
  depthEdge: 0.0025,
  creases: true,
  creaseThreshold: 0.86,
  creaseStrength: 1,
  normalEdges: true,     // owner default, Aug 19 — costs the +1 normals scene draw
  edgeHighlight: 1,
  normalThreshold: 0.1,
  // quantize
  quantizeMode: 0,       // 0 oklab bands (default) · 1 rgb levels · 2 palette match
  bands: 32,             // mode 0
  levels: 8,             // mode 1
  spread: 0.1,           // Bayer amplitude (modes 1 and 2)
  ditherFade: true,      // mode 1: fade Bayer near 0/1 so true black/white stay reachable
  paletteSize: 16,       // mode 2: which authored PALETTES tier to match against (8/16/32)
  palette: null,         // set an array of hexes (≤32) to override the authored tiers
};
if(typeof window !== "undefined") window.pixelTune = pixelTune;

export const PANEL_SPEC = {
  // Bare strings are group headers (debug-panel renders them as full-width subheadings).
  sliders: [
    ["targetHeight",   "target height px", 64, 1080, 4],
    ["pixelScale",     "pixel scale (0=off)", 0, 1, 0.05],
    ["sharpen",        "sharpen", 0, 2, 0.05],
    "quantize",
    ["bands",          "oklab bands (m0)", 2, 64, 1],
    ["levels",         "rgb levels (m1)", 2, 16, 1],
    ["spread",         "dither spread", 0, 1, 0.01],
    "outlines",
    ["outlineStrength","outline strength", 0, 4, 0.25],
    ["depthEdge",      "silhouette thresh", 0.0001, 0.02, 0.0001],
    ["creaseThreshold","crease thresh", 0, 1, 0.01],
    ["creaseStrength", "crease strength", 0, 4, 0.25],
    ["edgeHighlight",  "edge highlight (nrm)", 0, 4, 0.25],
    ["normalThreshold","normal thresh", 0.01, 1, 0.01],
    "clouds",
    ["cloudScale",     "cloud scale", 0.001, 0.03, 0.0005],
    ["cloudSpeed",     "cloud drift", 0, 0.1, 0.001],
    ["cloudCover",     "cloud cover thresh", 0, 1, 0.01],
    ["cloudDarken",    "cloud darken floor", 0, 1, 0.01],
    ["cloudHeight",    "cloud plane wu", 10, 200, 5],
    ["cloudBands",     "cloud bands", 1, 8, 1],
  ],
  checks: [
    ["outlines", "outlines"], ["creases", "creases"],
    ["normalEdges", "normal edges (hello-threejs)"],
    ["clouds", "cloud shadows"], ["snap", "camera snap"],
    ["subpixel", "sub-pixel pan"], ["ditherFade", "dither endpoint fade"],
  ],
  selects: [
    ["quantizeMode", "quantize", [[0, "oklab bands"], [1, "rgb levels"], [2, "palette match"]]],
    ["paletteSize", "palette (m2)", [[8, "8 colors"], [16, "16 colors"], [32, "32 colors"]]],
  ],
};

import {createPostStage, POST_VERT, GLSL_DEPTH_HELPERS, GLSL_SRGB_ENCODE} from "./post-stage.js";

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
uniform float uTime;
uniform float uSharpen;
uniform float uClouds, uCloudScale, uCloudSpeed, uCloudCover, uCloudDarken;
uniform float uCloudHeight, uCloudBands;
uniform vec3 uSunDir;
uniform float uOutlines, uOutlineStrength, uDepthEdge;
uniform float uCrease, uCreaseThresh, uCreaseStrength;
uniform float uNormalEdges, uEdgeHighlight, uNormalThresh;
uniform float uQuantMode;       // 0 oklab bands · 1 rgb levels · 2 palette match
uniform float uBands;
uniform float uLevels;
uniform float uSpread;
uniform float uDitherFade;
uniform vec3 uPalette[32];      // authored sRGB, output verbatim in mode 2
uniform vec3 uPaletteLab[32];   // same entries, sRGB→linear→OKLab (CPU-side)
uniform float uPaletteSize;

varying vec2 vUv;

${GLSL_DEPTH_HELPERS}
${GLSL_SRGB_ENCODE}
// ── OKLab (linear sRGB ⇄ OKLab), ported verbatim from pixel/source/lighting.glsl ──
vec3 toOKLab(vec3 c){
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2220049174 * c.g + 0.6896926207 * c.b;
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

// ── value-noise fBm over world XZ (the cloud field). Cheap, tileless, deterministic. ──
float hash21(vec2 p){
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int k = 0; k < 4; k++){ v += a * vnoise(p); p = p * 2.03 + 17.7; a *= 0.5; }
  return v;
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
    // Acerola's kernel: centre ×(1+4s) minus the 4-neighbour cross ×s.
    vec3 l = texture2D(uColor, uv - dx).rgb;
    vec3 r = texture2D(uColor, uv + dx).rgb;
    vec3 d = texture2D(uColor, uv - dy).rgb;
    vec3 u = texture2D(uColor, uv + dy).rgb;
    col = max(col * (1.0 + 4.0 * uSharpen) - (l + r + u + d) * uSharpen, vec3(0.0));
  }

  float zC = viewDist(uv);

  if(uClouds > 0.5 && zC < uFar * 0.99){
    // Sun-projected cloud plane, banded coverage, folded pre-quantize (Voyage fold +
    // Red Giraffe projection; see the header).
    vec3 world = (uCamWorld * vec4(viewPosOf(uv, zC), 1.0)).xyz;
    vec2 cloudUv = world.xz;
    if(uSunDir.y > 0.08){
      float t = (uCloudHeight - world.y) / uSunDir.y;
      cloudUv = world.xz + uSunDir.xz * max(t, 0.0);
    }
    float n = fbm(cloudUv * uCloudScale + uTime * uCloudSpeed) * 1.6 - 0.3;
    float shadow = smoothstep(uCloudCover, uCloudCover + 0.18, n);
    if(uCloudBands > 1.5) shadow = floor(shadow * uCloudBands + 0.5) / uCloudBands;
    col *= mix(1.0, uCloudDarken, shadow);
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
      // Step size: mode 0 has real bands; the other modes borrow uBands as "ink depth" so one
      // outlineStrength knob reads the same across modes.
      vec3 lab = toOKLab(col);
      lab.x = clamp(lab.x + bandShift / uBands, 0.0, 1.0);
      col = max(fromOKLab(lab), vec3(0.0));
    }
  }

  col = max(col, vec3(0.0));
  float noise = bayer4(uv / uTexel) * uSpread;

  if(uQuantMode < 0.5){
    // Mode 0 — retro: OKLab lightness posterize (linear input, encode after).
    vec3 lab = toOKLab(col);
    float L = clamp(lab.x, 0.0, 1.0);
    lab.x = floor(L * uBands + 0.5) / uBands;
    lab.z += (lab.x - 0.5) * 0.05;
    col = max(fromOKLab(lab), vec3(0.0));
    if(uEncode > 0.5) col = srgbEncode(clamp(col, 0.0, 1.0));
  }else if(uQuantMode < 1.5){
    // Mode 1 — toon rgb: encode FIRST (display-space law), then dither+floor. The endpoint fade
    // (Photosounder) kills the black-lift: naive dither keeps "black" ~0.16 units above zero.
    col = clamp(col, 0.0, 1.0);
    if(uEncode > 0.5) col = srgbEncode(col);
    float n1 = max(uLevels - 1.0, 1.0);
    vec3 fade = vec3(1.0);
    if(uDitherFade > 0.5)
      fade = clamp(min(col, 1.0 - col) * n1 / 0.6, 0.0, 1.0);
    col = floor((col + noise * fade) * n1 + 0.5) / n1;
  }else{
    // Mode 2 — palette match: nearest authored entry by OKLab distance (linear input; the
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
  const s = Math.cbrt(Math.max(0.0883024619 * r + 0.2220049174 * g + 0.6896926207 * b, 0));
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
    uClouds: {value: 1}, uCloudScale: {value: 0.02}, uCloudSpeed: {value: 0.01},
    uCloudCover: {value: 0.52}, uCloudDarken: {value: 0.72},
    uCloudHeight: {value: 60}, uCloudBands: {value: 3},
    uSunDir: {value: new THREE.Vector3(0, 1, 0)},
    uOutlines: {value: 1}, uOutlineStrength: {value: 4}, uDepthEdge: {value: 0.0025},
    uCrease: {value: 1}, uCreaseThresh: {value: 0.86}, uCreaseStrength: {value: 1},
    uNormalEdges: {value: 0}, uEdgeHighlight: {value: 1}, uNormalThresh: {value: 0.1},
    uQuantMode: {value: 0}, uBands: {value: 32}, uLevels: {value: 8}, uSpread: {value: 0.1},
    uDitherFade: {value: 1},
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
  uniforms.uCloudScale.value = Math.max(1e-5, +pixelTune.cloudScale || 0.02);
  uniforms.uCloudSpeed.value = +pixelTune.cloudSpeed || 0;
  uniforms.uCloudCover.value = clamp(+pixelTune.cloudCover || 0, 0, 1);
  uniforms.uCloudDarken.value = clamp(+pixelTune.cloudDarken || 0, 0, 1);
  uniforms.uCloudHeight.value = Math.max(1, +pixelTune.cloudHeight || 60);
  uniforms.uCloudBands.value = clamp(Math.round(+pixelTune.cloudBands || 1), 1, 8);
  if(sun){
    uniforms.uSunDir.value.copy(sun.position);
    if(sun.target) uniforms.uSunDir.value.sub(sun.target.position);
    const len = uniforms.uSunDir.value.length();
    if(len > 1e-4) uniforms.uSunDir.value.divideScalar(len);
    else uniforms.uSunDir.value.set(0, 1, 0);
  }

  uniforms.uOutlines.value = pixelTune.outlines === false ? 0 : 1;
  uniforms.uOutlineStrength.value = +pixelTune.outlineStrength || 0;
  uniforms.uDepthEdge.value = Math.max(1e-5, +pixelTune.depthEdge || 0.0025);
  uniforms.uCrease.value = pixelTune.creases === false ? 0 : 1;
  uniforms.uCreaseThresh.value = clamp(+pixelTune.creaseThreshold || 0.86, -1, 1);
  uniforms.uCreaseStrength.value = +pixelTune.creaseStrength || 0;
  uniforms.uNormalEdges.value = pixelTune.normalEdges === true && normalRt ? 1 : 0;
  uniforms.uEdgeHighlight.value = +pixelTune.edgeHighlight || 0;
  uniforms.uNormalThresh.value = Math.max(0.01, +pixelTune.normalThreshold || 0.1);

  uniforms.uQuantMode.value = clamp(Math.round(+pixelTune.quantizeMode || 0), 0, 2);
  uniforms.uBands.value = Math.max(2, Math.round(+pixelTune.bands || 32));
  uniforms.uLevels.value = clamp(Math.round(+pixelTune.levels || 8), 2, 16);
  uniforms.uSpread.value = clamp(+pixelTune.spread || 0, 0, 1);
  uniforms.uDitherFade.value = pixelTune.ditherFade === false ? 0 : 1;

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
    const normalEdgesOn = pixelTune.normalEdges === true;
    try{
      ctx.waterPrePass(w, h);
      renderer.setRenderTarget(stage.rt);
      renderer.render(scene, cam);
      if(normalEdgesOn){
        // Normals pass: whole scene under MeshNormalMaterial, shadows frozen, override restored
        // in the inner finally.
        if(!normalMat) normalMat = new THREE.MeshNormalMaterial();
        ensureNormalTarget(THREE, w, h);
        const prevOverride = scene.overrideMaterial;
        const shadowAuto = renderer.shadowMap.autoUpdate;
        renderer.shadowMap.autoUpdate = false;
        scene.overrideMaterial = normalMat;
        try{
          renderer.setRenderTarget(normalRt);
          renderer.render(scene, cam);
        }finally{
          scene.overrideMaterial = prevOverride;
          renderer.shadowMap.autoUpdate = shadowAuto;
        }
      }else if(normalRt){
        releaseNormalTarget();
      }
    }finally{
      // Uniforms read the SNAPPED camera matrix (the frame that was drawn); the sub-pixel
      // remainder recorded by snapCamera then re-aims the composite at the true position.
      syncUniforms(THREE, renderer, cam, ctx.getSun?.());
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

  dispose(){
    releaseNormalTarget();
    normalMat?.dispose(); normalMat = null;
    stage?.dispose();
    stage = null; uniforms = null;
    paletteKey = "";
  },
};
