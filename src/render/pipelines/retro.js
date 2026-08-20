// Owns: the "retro" render pipeline — the whole low-res pixel-art presentation of the game scene.
// Nothing outside this file is touched: the pipeline borrows scene.js's renderer/scene/camera through
// the ctx handed to it by pipelines/index.js, renders into targets it allocates itself, and leaves
// every borrowed object exactly as it found it (render target, camera position, matrices).
// ═══════════════════════════════════════════════════════════════════════════
// RETRO PIXEL-ART PIPELINE
// Port of the LOOK of /home/mando/dev/gamedev/pixel (Odin+sokol): render small, upscale hard, then
// posterize perceptually and outline the silhouettes. None of that project's probe/cubemap machinery
// comes across — this is a plain forward render plus one post pass.
//
// Passes (per frame, in order)
//   0. camera texel snap  — optional. Quantizes the camera's world position along its own right/up
//      axes to whole output-texel steps so a slow pan steps the image one pixel at a time instead of
//      crawling sub-pixel. Applied before the water pre-pass so every pass sees one camera; undone
//      immediately after the scene pass.
//   1. ctx.waterPrePass(rtW, rtH) — the water material samples a screen-space depth texture keyed on
//      gl_FragCoord/uResolution, so it MUST be filled at the offscreen target's size, not the
//      canvas's, or the foam smears against a differently-scaled depth buffer.
//   2. scene → rt  — the full scene (shadows and all) into a low-res colour+depth target. This is the
//      only pass that costs geometry; everything downstream is one fullscreen triangle.
//   3. rt → canvas — fullscreen triangle doing, in one fragment shader:
//        · NEAREST magnification (the target's magFilter, not a shader trick) → hard pixel edges
//        · depth-derived edge outlines, applied as a ±1-band step of OKLab lightness
//        · OKLab 32-band lightness posterization + the reference's small blue chroma shift
//        · linear → sRGB encode (see COLOR SPACE below)
//
// COLOR SPACE (deliberate choice — read before touching the encode)
//   three r160 only honours a render target's texture colorSpace for XR targets: WebGLPrograms picks
//   `currentRenderTarget === null ? renderer.outputColorSpace : LinearSRGBColorSpace` (r160
//   WebGLProgram parameters + WebGLRenderer.setRenderTarget). So a scene rendered into ANY ordinary
//   offscreen target comes out LINEAR no matter what we set on rt.texture — setting SRGBColorSpace
//   there would change only how three DECODES the texture when a built-in material samples it, which
//   our raw ShaderMaterial does not do. Therefore: the target stays linear, and the final pass does
//   the sRGB encode itself, byte-for-byte the same transfer function as three's `LinearTosRGB`
//   (colorspace_fragment). That keeps "retro" exactly as bright as "current" with posterize/outlines
//   off, instead of the washed-out (double-encoded) or muddy (never-encoded) failure modes.
//   Scene background clears agree too: WebGLBackground clears an offscreen target through
//   getUnlitUniformColorSpace() → working (linear) space, which is the space we then encode from.
//   The encode is skipped if the host renderer's outputColorSpace is not sRGB, so a future change in
//   scene.js can't double-convert.
//
// Precision: the low-res target is RGBA16F when the driver can render to it (EXT_color_buffer_float /
// EXT_color_buffer_half_float, effectively always on WebGL2). Linear values in RGBA8 band badly in the
// darks, which the 32-band posterizer then locks in. RGBA8 is the fallback, not the intent.
//
// NOT ours: the 2D overlay canvas (health bars, text) is a separate DOM canvas rendered by
// overlay.js at full resolution. It stays crisp on purpose — this pipeline never sees it.
//
// Tunables — `retroTune`, also parked on window.retroTune for console poking. Read LIVE every frame,
// so every knob takes effect on the next rendered frame with no reload:
//   targetHeight    540    offscreen height in px, aspect preserved from the drawing buffer. The
//                          reference runs ≈555p. Clamped to [64, drawing-buffer height] — the target
//                          is never allowed to be larger than the canvas.
//   pixelScale      0      if > 0 this WINS over targetHeight: target = drawing buffer × scale.
//   posterize       true   OKLab lightness quantization.
//   bands           32     posterization levels (reference: 32). Also the outline step size.
//   outlines        true   depth-discontinuity silhouette outlines.
//   outlineStrength 1      how many bands a silhouette texel is darkened by.
//   depthEdge       .0025  silhouette threshold: |∂²depth| / depth. Distance-relative and
//                          second-order, so sloped ground (constant gradient → ~0 curvature) never
//                          trips it at any zoom, while a real depth jump does.
//   creases         true   second detector: tangent-direction breaks inside a continuous surface
//                          (cube edges, terrain steps). Convex → highlight, concave → darken.
//   creaseThreshold .86    dot() of the forward/backward view-space tangents below which it is a
//                          crease. Lower = fewer creases.
//   creaseStrength  1      bands of adjustment for a crease texel.
//   snap            true   camera texel snapping (pass 0). The restore (updateMatrixWorld) puts the
//                          camera fully back — matrixWorldInverse included — so the overlay and mouse
//                          picking both see the UNSNAPPED camera, consistently with each other, and
//                          may sit up to one output texel (~2 device px) off the drawn frame. Flip to
//                          false if that ever reads wrong.
//   normalEdges     false  hello-threejs mode (KodyJKing/hello-threejs): +1 scene draw renders a
//                          view-space normal buffer; interior creases come from it and HIGHLIGHT
//                          (bias-gated to up/camera-facing edges — the pixel-art rim look) instead
//                          of the depth-tangent creases. Silhouette darkening stays as-is.
//   edgeHighlight   1      bands added on a lit crease texel (normalEdges only).
//   normalThreshold .1     summed neighbour indicator needed to fire (hello-threejs's step(0.1)).
// ═══════════════════════════════════════════════════════════════════════════

/** Live-read every frame. Exported and mirrored on window for console tuning. */
export const retroTune = {
  targetHeight: 540,
  pixelScale: 0,
  posterize: true,
  bands: 32,
  outlines: true,
  outlineStrength: 1,
  depthEdge: 0.0025,
  creases: true,
  creaseThreshold: 0.86,
  creaseStrength: 1,
  snap: true,
  // hello-threejs edge mode (KodyJKing/hello-threejs): a second scene pass renders view-space
  // normals into their own low-res target, and interior creases come from that buffer — biased so
  // only up/camera-facing edges HIGHLIGHT (the hand-placed pixel-art rim look) — instead of the
  // depth-tangent creases above. Costs one extra scene draw (shadows frozen for it). Silhouette
  // darkening and posterization are unchanged; A/B against `creases` with the R panel.
  normalEdges: false,
  edgeHighlight: 1,      // bands ADDED on a lit crease texel
  normalThreshold: 0.1,  // summed indicator needed to fire (hello-threejs's step(0.1))
};
if(typeof window !== "undefined") window.retroTune = retroTune;

// ─────────────────────────────────────────────────────────────────── shaders
// Written in ES 1.00 syntax; on WebGL2 three rewrites non-raw ShaderMaterials to `#version 300 es`
// with compatibility defines (varying→in/out, texture2D→texture), so this compiles on either context.
// Nothing here needs texelFetch/textureSize, hence no glslVersion: GLSL3.
// Scaffolding (target, quad, sizing, snap, encode chunk) is shared with toon.js via post-stage.js.
import {createPostStage, POST_VERT, GLSL_DEPTH_HELPERS, GLSL_SRGB_ENCODE} from "./post-stage.js";

// `packing` gives perspectiveDepthToViewZ / orthographicDepthToViewZ. three resolves #include for
// ShaderMaterial exactly as for its own materials (scene.js's water shader relies on the same thing).
const FRAG = /* glsl */`
#include <packing>

// Both samplers are explicitly highp: sampler precision defaults to lowp in an ES 1.00 fragment
// shader, which ANGLE honours — that quantizes the depth reads (the same trap documented on
// scene.js's water shader) and would clip the RGBA16F colour target to lowp's ±2 range.
uniform highp sampler2D uColor;
uniform highp sampler2D uDepth;
uniform sampler2D uNormal;  // view-space normals *0.5+0.5; only sampled when uNormalEdges is on
uniform vec2 uTexel;        // 1 / low-res target size, in texels
uniform vec2 uUnproj;       // persp: (tanHalfFovX, tanHalfFovY) · ortho: (halfWidth, halfHeight)
uniform float uNear;
uniform float uFar;
uniform float uOrtho;       // 1 when the live camera is orthographic
uniform float uEncode;      // 1 when we owe the canvas a linear→sRGB encode
uniform float uBands;
uniform float uPosterize;
uniform float uOutlines;
uniform float uOutlineStrength;
uniform float uDepthEdge;
uniform float uCrease;
uniform float uCreaseThresh;
uniform float uCreaseStrength;
uniform float uNormalEdges;     // 1 = hello-threejs mode: normal-buffer creases replace the
uniform float uEdgeHighlight;   //     depth-tangent detector; highlight strength in bands
uniform float uNormalThresh;    //     indicator sum needed before a texel highlights

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

// viewDist/viewPosOf come from GLSL_DEPTH_HELPERS above. Sky (raw depth 1.0) resolves to uFar for
// both projections, which is what makes a silhouette against the sky a huge curvature spike.
void main(){
  vec3 col = texture2D(uColor, vUv).rgb;

  if(uOutlines > 0.5){
    vec2 dx = vec2(uTexel.x, 0.0);
    vec2 dy = vec2(0.0, uTexel.y);
    float zC = viewDist(vUv);
    float zR = viewDist(vUv + dx);
    float zL = viewDist(vUv - dx);
    float zU = viewDist(vUv + dy);
    float zD = viewDist(vUv - dy);

    // Second difference, not first: a flat OR sloped surface has a constant depth gradient and so
    // ~zero curvature at any zoom, whereas a silhouette leaves a spike. Sign carries the geometry —
    // positive means the neighbours are farther, i.e. this texel is the NEAR side of the step, which
    // is the side the reference draws the outline on.
    float lapX = zL + zR - 2.0 * zC;
    float lapY = zD + zU - 2.0 * zC;
    float lap  = (abs(lapX) >= abs(lapY)) ? lapX : lapY;
    // Normalize by whatever sets on-screen scale for this projection: distance under perspective,
    // the fixed half-height of the frustum under orthographic (uUnproj.y is exactly that there).
    // Without the split, the ortho debug camera — whose near plane is negative — would compare
    // curvature against a distance that means nothing.
    float refZ = (uOrtho > 0.5) ? max(uUnproj.y, 1e-3) : max(zC, 1e-3);
    float rel  = abs(lap) / refZ;

    float bandShift = 0.0;   // in bands: negative darkens, positive highlights
    if(rel > uDepthEdge){
      // Silhouette. The far side deliberately does nothing — otherwise every edge is 2px thick.
      if(lap > 0.0) bandShift = -uOutlineStrength;
    }else if(uNormalEdges > 0.5){
      // hello-threejs mode (KodyJKing): interior creases from a REAL normal buffer instead of the
      // depth-tangent test below, and they HIGHLIGHT rather than darken. Two gates per neighbour,
      // both ported: (1) the normal difference is dotted with a fixed bias direction, so only
      // creases whose facing swings toward up-left-camera get the rim — that is the hand-placed
      // pixel-art highlight; (2) only the shallower pixel of the pair draws, so an edge is 1px.
      vec3 n = texture2D(uNormal, vUv).rgb * 2.0 - 1.0;
      float refN = max(zC, 1e-3);
      float indicator = 0.0;
      for(int k = 0; k < 4; k++){
        vec2 off = (k == 0) ? dx : (k == 1) ? -dx : (k == 2) ? dy : -dy;
        vec3 nN = texture2D(uNormal, vUv + off).rgb * 2.0 - 1.0;
        float zN = viewDist(vUv + off);
        float depthInd  = step(0.0, zN - zC + refN * 5e-4);          // neighbour not nearer
        float normalInd = smoothstep(-0.01, 0.01, dot(n - nN, vec3(1.0)));
        indicator += distance(n, nN) * depthInd * normalInd;
      }
      if(indicator > uNormalThresh) bandShift = uEdgeHighlight;
    }else if(uCrease > 0.5){
      // No depth step, so any tangent break here is a crease inside one continuous surface. Compare
      // the forward and backward view-space tangents: parallel on a plane, bent at a cube edge.
      vec3 pC = viewPosOf(vUv, zC);
      vec3 tR = viewPosOf(vUv + dx, zR) - pC;
      vec3 tL = pC - viewPosOf(vUv - dx, zL);
      vec3 tU = viewPosOf(vUv + dy, zU) - pC;
      vec3 tD = pC - viewPosOf(vUv - dy, zD);
      float bend = min(dot(normalize(tR), normalize(tL)),
                       dot(normalize(tU), normalize(tD)));
      if(bend < uCreaseThresh)
        bandShift = (lap > 0.0) ? uCreaseStrength : -uCreaseStrength;
    }

    // The reference's outline move: step OKLab lightness by whole posterization bands, BEFORE
    // quantizing, so the outline lands on a real palette entry instead of inventing a colour.
    if(bandShift != 0.0){
      vec3 lab = toOKLab(col);
      lab.x = clamp(lab.x + bandShift / uBands, 0.0, 1.0);
      col = max(fromOKLab(lab), vec3(0.0));
    }
  }

  if(uPosterize > 0.5){
    vec3 lab = toOKLab(col);
    float L = clamp(lab.x, 0.0, 1.0);
    lab.x = floor(L * uBands + 0.5) / uBands;
    lab.z += (lab.x - 0.5) * 0.05;   // reference's subtle blue shift in the darks
    col = max(fromOKLab(lab), vec3(0.0));
  }

  col = max(col, vec3(0.0));
  // srgbEncode is three's exact LinearTosRGB — see COLOR SPACE in the header.
  if(uEncode > 0.5) col = srgbEncode(col);
  gl_FragColor = vec4(col, 1.0);
}`;

// ── owned resources: shared scaffolding lives in post-stage.js; the normal target is retro-only ──
let stage = null;
let normalRt = null;      // low-res view-space normal target (allocated only while normalEdges is on)
let normalMat = null;     // MeshNormalMaterial used as scene.overrideMaterial for that pass
let uniforms = null;

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function makeUniforms(THREE){
  return {
    uColor: {value: null},
    uDepth: {value: null},
    uTexel: {value: new THREE.Vector2(1, 1)},
    uUnproj: {value: new THREE.Vector2(1, 1)},
    uNear: {value: 0.5}, uFar: {value: 600}, uOrtho: {value: 0}, uEncode: {value: 1},
    uBands: {value: 32}, uPosterize: {value: 1},
    uOutlines: {value: 1}, uOutlineStrength: {value: 1}, uDepthEdge: {value: 0.0025},
    uCrease: {value: 1}, uCreaseThresh: {value: 0.86}, uCreaseStrength: {value: 1},
    uNormal: {value: null}, uNormalEdges: {value: 0}, uEdgeHighlight: {value: 1},
    uNormalThresh: {value: 0.1},
  };
}

/**
 * Build everything that does not depend on target size.
 * Called from render(), not only from init(): the registry does re-init after dispose, so this guard
 * is belt-and-braces against any activation path that skips init(). One truthiness check a frame.
 */
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
/** Lazily allocated: exists only while retroTune.normalEdges is on, sized like the colour target.
 *  RGBA8 is plenty — MeshNormalMaterial writes normals packed *0.5+0.5. Own depth buffer so the
 *  normal pass depth-tests correctly, but no depth texture (the composite reads rt's). */
function ensureNormalTarget(THREE, w, h){
  if(normalRt && normalRt.width === w && normalRt.height === h) return;
  releaseNormalTarget();
  normalRt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  });
  normalRt.texture.generateMipmaps = false;
  uniforms.uNormal.value = normalRt.texture;
}

/** Push the live tunables + this frame's camera into the post uniforms. */
function syncUniforms(THREE, renderer, cam){
  const bands = Math.max(2, Math.round(+retroTune.bands || 32));
  uniforms.uBands.value = bands;
  uniforms.uPosterize.value = retroTune.posterize === false ? 0 : 1;
  uniforms.uOutlines.value = retroTune.outlines === false ? 0 : 1;
  uniforms.uOutlineStrength.value = +retroTune.outlineStrength || 0;
  uniforms.uDepthEdge.value = Math.max(1e-5, +retroTune.depthEdge || 0.0025);
  uniforms.uCrease.value = retroTune.creases === false ? 0 : 1;
  uniforms.uCreaseThresh.value = clamp(+retroTune.creaseThreshold || 0.86, -1, 1);
  uniforms.uCreaseStrength.value = +retroTune.creaseStrength || 0;
  // Gated on the target existing, not just the flag, so the shader never samples a null texture
  // on the exact frame the flag flips.
  uniforms.uNormalEdges.value = retroTune.normalEdges === true && normalRt ? 1 : 0;
  uniforms.uEdgeHighlight.value = +retroTune.edgeHighlight || 0;
  uniforms.uNormalThresh.value = Math.max(0.01, +retroTune.normalThreshold || 0.1);

  uniforms.uNear.value = cam.near;
  uniforms.uFar.value = cam.far;
  uniforms.uOrtho.value = cam.isOrthographicCamera ? 1 : 0;
  const p = cam.projectionMatrix.elements;
  uniforms.uUnproj.value.set(p[0] ? 1 / p[0] : 1, p[5] ? 1 / p[5] : 1);
  // Only owe an encode if the canvas actually wants sRGB; guards against scene.js ever changing it.
  uniforms.uEncode.value = renderer.outputColorSpace === THREE.SRGBColorSpace ? 1 : 0;
}

export default {
  name: "retro",

  init(ctx){
    ensureResources(ctx.THREE);
  },

  render(ctx){
    const {THREE, renderer, scene} = ctx;
    const cam = ctx.getCamera();
    ensureResources(THREE);

    stage.readBufferSize(renderer);
    const [w, h] = stage.targetSize(retroTune, 540);
    if(stage.ensureTarget(renderer, w, h)){
      uniforms.uColor.value = stage.rt.texture;
      uniforms.uDepth.value = stage.rt.depthTexture;
      uniforms.uTexel.value.set(1 / w, 1 / h);
    }

    const snapped = retroTune.snap !== false && stage.snapCamera(cam, w, h);
    const normalEdgesOn = retroTune.normalEdges === true;
    try{
      // Water's screen-space depth read is keyed on the target we are about to draw into.
      ctx.waterPrePass(w, h);
      renderer.setRenderTarget(stage.rt);
      renderer.render(scene, cam);
      if(normalEdgesOn){
        // hello-threejs normal pass: the whole scene again under a MeshNormalMaterial override,
        // same (snapped) camera. Shadows are frozen for it — normals don't need a shadow map —
        // and the override is restored in the inner finally so a throw can't leave the scene
        // rendering purple. Known, accepted overrides: water's vertex waves flatten (its material
        // is replaced), and back-face ink shells mostly self-cull. It's an experiment flag.
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
        releaseNormalTarget();     // flag switched off: give the memory back now
      }
    }finally{
      if(snapped) stage.unsnapCamera(cam);
    }

    syncUniforms(THREE, renderer, cam);
    stage.composite(renderer);   // explicitly to the default framebuffer, per the contract
  },

  resize(ctx){
    // Size is recomputed from the drawing buffer every frame; just drop the stale targets so the
    // memory goes back now rather than at the next draw.
    stage?.releaseTarget();
    releaseNormalTarget();
  },

  dispose(ctx){
    releaseNormalTarget();
    normalMat?.dispose(); normalMat = null;
    stage?.dispose();
    stage = null; uniforms = null;
  },
};
