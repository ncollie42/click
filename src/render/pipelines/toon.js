// Owns: the "toon" render pipeline — Bayer-dithered colour quantization with drifting cloud
// shadows. Built from two references: Acerola's "Color Quantization and Dithering" (downscale +
// point-filter upscale, ordered-dither noise before a per-channel quantize, sharpen so detail
// survives the downres, grayscale-as-UV palette remap) and Voyage's toon-shading devlog (cloud
// shadows from world-space fBm noise folded into the value signal BEFORE banding, so clouds cast
// hard-edged quantized patches instead of soft grey smudges).
// Everything is post-process: one scene draw into a low-res target, one fullscreen composite.
// Borrowed-object discipline, camera snap, colour space and water pre-pass sizing all follow
// retro.js (same scaffolding; see its header for the COLOR SPACE and precision reasoning).
//
// Passes (per frame)
//   0. camera texel snap (optional, same math as retro)
//   1. ctx.waterPrePass(rtW, rtH)
//   2. scene → low-res colour+depth target (NEAREST both ways = the pixel upscale)
//   3. fullscreen composite:
//        · 5-tap sharpen (Acerola: contrast fakes detail through the downres)
//        · cloud shadow: 4-octave value-noise fBm over world XZ (reconstructed from depth),
//          multiplied into the colour BEFORE the quantize — the Voyage fold. Sky texels skip it.
//        · Bayer 4x4 threshold noise scaled by `spread`
//        · quantize: per-channel floor(c·(n−1)+.5)/(n−1), OR luma-quantize → authored palette
//        · linear → sRGB encode (same manual encode as retro; the target stays linear)
//
// Tunables — `toonTune` (window.toonTune for console), live-read every frame:
//   targetHeight 540 / pixelScale — low-res size, exactly like retro.
//   levels        8   colours per channel (rgb mode) or palette rungs (ramp mode), 2..16.
//   spread       .1   dither noise amplitude. 0 = flat Dead-Cells bands, no dither visible.
//   sharpen      .6   pre-quantize sharpen strength. 0 disables the taps entirely.
//   clouds      true  world-anchored drifting cloud shadows.
//   cloudScale  .006  fBm frequency per world unit — smaller = bigger clouds.
//   cloudSpeed  .01   drift, world units per second (applied in noise space).
//   cloudCover  .52   fBm threshold a cloud starts at. Higher = clearer sky.
//   cloudDarken .72   floor the shadow multiplies the colour toward (1 = off).
//   paletteMode  0    0 = per-channel rgb quantize · 1 = luma → the 8-colour authored ramp
//                     (toonTune.palette, hex numbers, console-editable, max 8).
//   snap        true  camera texel snapping, as in retro.
export const toonTune = {
  targetHeight: 540,
  pixelScale: 0,
  levels: 8,
  spread: 0.1,
  sharpen: 0.6,
  clouds: true,
  cloudScale: 0.02,     // features ~50wu — cloud blobs visibly smaller than the screen
  cloudSpeed: 0.01,
  cloudCover: 0.52,
  cloudDarken: 0.72,
  cloudHeight: 60,       // world units of the virtual cloud plane (Red Giraffe sun projection)
  cloudBands: 3,         // quantized partial-coverage steps; 1 = smooth (pre-upgrade look)
  paletteMode: 0,
  lumaLo: 0.12,          // display luma mapped to the ramp's darkest rung (palette mode)
  lumaHi: 0.62,          // display luma mapped to the ramp's brightest rung
  // Night-sea → grass → sun-cream ramp authored against the game's palette family. Console:
  // window.toonTune.palette = [0x000000, ...] (≤8 entries; fewer than `levels` clamps levels).
  palette: [0x1b2033, 0x2e4a3b, 0x49683f, 0x6f8f4e, 0x9db365, 0xc7cd8d, 0xe8e3b6, 0xfaf3d8],
  snap: true,
};
if(typeof window !== "undefined") window.toonTune = toonTune;

export const PANEL_SPEC = {
  sliders: [
    ["targetHeight", "target height px", 64, 1080, 4],
    ["pixelScale",   "pixel scale (0=off)", 0, 1, 0.05],
    ["levels",       "colour levels", 2, 16, 1],
    ["spread",       "dither spread", 0, 1, 0.01],
    ["sharpen",      "sharpen", 0, 2, 0.05],
    ["cloudScale",   "cloud scale", 0.001, 0.03, 0.0005],
    ["cloudSpeed",   "cloud drift", 0, 0.1, 0.001],
    ["cloudCover",   "cloud cover thresh", 0, 1, 0.01],
    ["cloudDarken",  "cloud darken floor", 0, 1, 0.01],
    ["cloudHeight",  "cloud plane wu", 10, 200, 5],
    ["cloudBands",   "cloud bands", 1, 8, 1],
    ["lumaLo",       "ramp luma low", 0, 1, 0.01],
    ["lumaHi",       "ramp luma high", 0, 1, 0.01],
  ],
  checks: [["clouds", "cloud shadows"], ["snap", "camera snap"]],
  selects: [["paletteMode", "palette", [[0, "rgb quantize"], [1, "authored ramp"]]]],
};

import {createPostStage, POST_VERT, GLSL_DEPTH_HELPERS, GLSL_SRGB_ENCODE} from "./post-stage.js";

const FRAG = /* glsl */`
#include <packing>
uniform highp sampler2D uColor;
uniform highp sampler2D uDepth;
uniform vec2 uTexel;
uniform vec2 uUnproj;
uniform float uNear, uFar, uOrtho, uEncode;
uniform mat4 uCamWorld;      // camera matrixWorld: view space -> world space for the cloud field
uniform float uTime;
uniform float uSharpen;
uniform float uSpread;
uniform float uLevels;
uniform float uPaletteMode;
uniform vec3 uPalette[8];
uniform float uPaletteSize;
uniform float uLumaLo, uLumaHi;   // scene luma range stretched over the ramp (palette mode)
uniform float uClouds, uCloudScale, uCloudSpeed, uCloudCover, uCloudDarken;
uniform float uCloudHeight, uCloudBands;
uniform vec3 uSunDir;      // normalized, points from the ground TOWARD the sun
varying vec2 vUv;
${GLSL_DEPTH_HELPERS}
${GLSL_SRGB_ENCODE}

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
  // The classic matrix, flattened row-major; /16 − .5 centres it around zero.
  float v =
    i== 0? 0.0: i== 1? 8.0: i== 2? 2.0: i== 3?10.0:
    i== 4?12.0: i== 5? 4.0: i== 6?14.0: i== 7? 6.0:
    i== 8? 3.0: i== 9?11.0: i==10? 1.0: i==11? 9.0:
    i==12?15.0: i==13? 7.0: i==14?13.0: 5.0;
  return v / 16.0 - 0.5;
}

void main(){
  vec3 col = texture2D(uColor, vUv).rgb;

  if(uSharpen > 0.001){
    // Acerola's kernel: centre ×(1+4s) minus the 4-neighbour cross ×s — contrast as fake detail.
    vec3 l = texture2D(uColor, vUv - vec2(uTexel.x, 0.0)).rgb;
    vec3 r = texture2D(uColor, vUv + vec2(uTexel.x, 0.0)).rgb;
    vec3 d = texture2D(uColor, vUv - vec2(0.0, uTexel.y)).rgb;
    vec3 u = texture2D(uColor, vUv + vec2(0.0, uTexel.y)).rgb;
    col = max(col * (1.0 + 4.0 * uSharpen) - (l + r + u + d) * uSharpen, vec3(0.0));
  }

  float dist = viewDist(vUv);
  if(uClouds > 0.5 && dist < uFar * 0.99){
    // The Voyage fold: the cloud field darkens the VALUE before any banding, so the quantizer
    // cuts hard cloud edges out of it. World-anchored: panning does not slide the clouds.
    // Red Giraffe upgrade #1: the cloud layer is a PLANE at uCloudHeight and each ground point
    // looks up along the SUN direction to find its cloud — so shadows land where the sun says,
    // sit on object flanks as well as the ground, and shear when the sun moves. Falls back to a
    // vertical look-up when the sun is near the horizon (the intersection blows up).
    vec3 world = (uCamWorld * vec4(viewPosOf(vUv, dist), 1.0)).xyz;
    vec2 cloudUv = world.xz;
    if(uSunDir.y > 0.08){
      float t = (uCloudHeight - world.y) / uSunDir.y;
      cloudUv = world.xz + uSunDir.xz * max(t, 0.0);
    }
    // fBm of value noise clusters tightly around 0.5 — stretch it so the cover threshold has real
    // tails to cut cloud SHAPES from (without this the whole frame sits in one mid band and the
    // effect reads as uniform dimming, not weather).
    float n = fbm(cloudUv * uCloudScale + uTime * uCloudSpeed) * 1.6 - 0.3;
    float shadow = smoothstep(uCloudCover, uCloudCover + 0.18, n);
    // Red Giraffe upgrade #2: BANDED partial coverage — round the density to fixed steps instead
    // of a smooth ramp, so half-shade quantizes like everything else in this pipeline.
    if(uCloudBands > 1.5) shadow = floor(shadow * uCloudBands + 0.5) / uCloudBands;
    col *= mix(1.0, uCloudDarken, shadow);
  }

  // Quantize in DISPLAY space, not linear — Acerola's effect operates on the final image. This
  // game's world sits in the bottom ~15% of the linear range (see the integration notes on the
  // 6.7x-dark rig), so a linear quantize crushes everything onto the lowest rungs and the dither
  // noise dominates. Encode first; everything below happens in the same space the eye judges.
  col = clamp(col, 0.0, 1.0);
  if(uEncode > 0.5) col = srgbEncode(col);

  float noise = bayer4(vUv / uTexel) * uSpread;
  float n1 = max(uLevels - 1.0, 1.0);
  if(uPaletteMode > 0.5){
    // Acerola's remap: quantized display luma becomes the rung index into the authored ramp.
    // Palette entries are authored sRGB and output verbatim — no round trip through linear.
    // The scene's luma is stretched across [uLumaLo, uLumaHi] first: the game's day frame packs
    // most pixels into a narrow band (grass everywhere), and without the stretch the whole map
    // lands on two adjacent rungs and reads as one colour.
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    luma = clamp((luma - uLumaLo) / max(uLumaHi - uLumaLo, 1e-3), 0.0, 1.0) + noise;
    float rungs = min(uLevels, uPaletteSize);
    float idx = clamp(floor(luma * (rungs - 1.0) + 0.5), 0.0, rungs - 1.0);
    int i = int(idx);
    col = i==0?uPalette[0]: i==1?uPalette[1]: i==2?uPalette[2]: i==3?uPalette[3]:
          i==4?uPalette[4]: i==5?uPalette[5]: i==6?uPalette[6]: uPalette[7];
  }else{
    col = floor((col + noise) * n1 + 0.5) / n1;
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ── owned resources: everything shared lives in the post stage (post-stage.js) ─
let stage = null;
let uniforms = null;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function makeUniforms(THREE){
  return {
    uColor: {value: null}, uDepth: {value: null},
    uTexel: {value: new THREE.Vector2(1, 1)},
    uUnproj: {value: new THREE.Vector2(1, 1)},
    uNear: {value: 0.5}, uFar: {value: 600}, uOrtho: {value: 0}, uEncode: {value: 1},
    uCamWorld: {value: new THREE.Matrix4()},
    uTime: {value: 0},
    uSharpen: {value: 0.6}, uSpread: {value: 0.1}, uLevels: {value: 8},
    uPaletteMode: {value: 0},
    uPalette: {value: Array.from({length: 8}, () => new THREE.Color(0))},
    uPaletteSize: {value: 8},
    uLumaLo: {value: 0.12}, uLumaHi: {value: 0.62},
    uClouds: {value: 1}, uCloudScale: {value: 0.02}, uCloudSpeed: {value: 0.01},
    uCloudCover: {value: 0.52}, uCloudDarken: {value: 0.72},
    uCloudHeight: {value: 60}, uCloudBands: {value: 3},
    uSunDir: {value: new THREE.Vector3(0, 1, 0)},
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

function syncUniforms(THREE, renderer, cam, sun){
  uniforms.uLevels.value = clamp(Math.round(+toonTune.levels || 8), 2, 16);
  uniforms.uSpread.value = clamp(+toonTune.spread || 0, 0, 1);
  uniforms.uSharpen.value = clamp(+toonTune.sharpen || 0, 0, 4);
  uniforms.uClouds.value = toonTune.clouds === false ? 0 : 1;
  uniforms.uCloudScale.value = Math.max(1e-5, +toonTune.cloudScale || 0.02);
  uniforms.uCloudSpeed.value = +toonTune.cloudSpeed || 0;
  uniforms.uCloudCover.value = clamp(+toonTune.cloudCover || 0, 0, 1);
  uniforms.uCloudDarken.value = clamp(+toonTune.cloudDarken || 0, 0, 1);
  uniforms.uCloudHeight.value = Math.max(1, +toonTune.cloudHeight || 60);
  uniforms.uCloudBands.value = clamp(Math.round(+toonTune.cloudBands || 1), 1, 8);
  // Direction TOWARD the sun, from the game's live DirectionalLight (day/night moves it).
  if(sun){
    uniforms.uSunDir.value.copy(sun.position);
    if(sun.target) uniforms.uSunDir.value.sub(sun.target.position);
    const len = uniforms.uSunDir.value.length();
    if(len > 1e-4) uniforms.uSunDir.value.divideScalar(len);
    else uniforms.uSunDir.value.set(0, 1, 0);
  }
  uniforms.uPaletteMode.value = +toonTune.paletteMode ? 1 : 0;
  const lo = clamp(+toonTune.lumaLo || 0, 0, 1);
  uniforms.uLumaLo.value = lo;
  uniforms.uLumaHi.value = clamp(+toonTune.lumaHi || 1, lo + 0.01, 1);
  const pal = Array.isArray(toonTune.palette) && toonTune.palette.length ? toonTune.palette : [0, 0xffffff];
  uniforms.uPaletteSize.value = Math.min(pal.length, 8);
  for(let i = 0; i < 8; i++){
    // Authored hexes are display sRGB and the quantizer runs in display space — no conversion.
    // setHex would convert via ColorManagement; read the channels out raw instead.
    const hex = pal[Math.min(i, pal.length - 1)] || 0;
    uniforms.uPalette.value[i].setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
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
  name: "toon",
  init(ctx){ ensureResources(ctx.THREE); },
  render(ctx){
    const {THREE, renderer, scene} = ctx;
    const cam = ctx.getCamera();
    ensureResources(THREE);
    stage.readBufferSize(renderer);
    const [w, h] = stage.targetSize(toonTune, 540);
    if(stage.ensureTarget(renderer, w, h)){
      uniforms.uColor.value = stage.rt.texture;
      uniforms.uDepth.value = stage.rt.depthTexture;
      uniforms.uTexel.value.set(1 / w, 1 / h);
    }
    const snapped = toonTune.snap !== false && stage.snapCamera(cam, w, h);
    try{
      ctx.waterPrePass(w, h);
      renderer.setRenderTarget(stage.rt);
      renderer.render(scene, cam);
    }finally{
      // Uniforms read the SNAPPED camera matrix (the frame that was drawn), then restore.
      syncUniforms(THREE, renderer, cam, ctx.getSun?.());
      if(snapped) stage.unsnapCamera(cam);
    }
    stage.composite(renderer);   // explicitly to the default framebuffer, per the contract
  },
  resize(){ stage?.releaseTarget(); },
  dispose(){
    stage?.dispose();
    stage = null; uniforms = null;
  },
};
