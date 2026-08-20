// Owns: the scaffolding every post-process pipeline shares — the low-res colour+depth target, the
// fullscreen-triangle composite, output sizing, and the camera texel snap. retro.js and toon.js
// consume one stage instance each; their identity lives entirely in their fragment shaders and
// tunables. Extracted (with nico's consolidation license) after the two files had ~200 duplicated
// lines and a codex review flagged per-frame [w,h] garbage and a composite that could land in a
// host-bound target instead of the default framebuffer — both fixed here, once.
//
// GLSL building blocks are exported as string chunks so each pipeline's shader stays one readable
// literal: GLSL_DEPTH_HELPERS (viewDist/viewPosOf over the shared uDepth/uUnproj/uNear/uFar/uOrtho
// uniform set) and GLSL_SRGB_ENCODE (three's exact LinearTosRGB — see retro.js COLOR SPACE for why
// the encode is manual: three cannot encode into an ordinary offscreen target).

export const GLSL_DEPTH_HELPERS = /* glsl */`
float viewDist(vec2 uv){
  float d = texture2D(uDepth, uv).x;
  float vz = (uOrtho > 0.5)
    ? orthographicDepthToViewZ(d, uNear, uFar)
    : perspectiveDepthToViewZ(d, uNear, uFar);
  return -vz;
}
vec3 viewPosOf(vec2 uv, float dist){
  vec2 ndc = uv * 2.0 - 1.0;
  vec2 xy = (uOrtho > 0.5) ? ndc * uUnproj : ndc * uUnproj * dist;
  return vec3(xy, -dist);
}`;

export const GLSL_SRGB_ENCODE = /* glsl */`
vec3 srgbEncode(vec3 col){
  return mix(pow(col, vec3(0.41666)) * 1.055 - vec3(0.055), col * 12.92,
             vec3(lessThanEqual(col, vec3(0.0031308))));
}`;

export const POST_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/** One per pipeline. `makeMaterial(THREE)` returns the pipeline's composite ShaderMaterial. */
export function createPostStage(THREE, makeMaterial){
  const stage = {
    rt: null,
    material: makeMaterial(THREE),
    size: [0, 0],                 // targetSize writes here — no per-frame allocation
  };
  const bufSize = new THREE.Vector2();
  const savedPos = new THREE.Vector3();
  const axisR = new THREE.Vector3(), axisU = new THREE.Vector3(), axisF = new THREE.Vector3();
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute("position", new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quadMesh = new THREE.Mesh(quadGeo, stage.material);
  quadMesh.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quadMesh);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /** RGBA16F when the driver renders to it (linear values band in 8 bits); RGBA8 fallback. */
  stage.targetType = renderer => {
    const ext = renderer.extensions;
    if(ext && (ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float")))
      return THREE.HalfFloatType;
    return THREE.UnsignedByteType;
  };

  stage.releaseTarget = () => {
    if(!stage.rt) return;
    stage.rt.depthTexture?.dispose();
    stage.rt.dispose();
    stage.rt = null;
  };

  /** (Re)allocate the low-res colour+depth target. NearestFilter both ways IS the pixel upscale.
   *  Returns true when the target was (re)built, so callers can rebind sampler uniforms. */
  stage.ensureTarget = (renderer, w, h) => {
    if(stage.rt && stage.rt.width === w && stage.rt.height === h) return false;
    stage.releaseTarget();
    const depth = new THREE.DepthTexture(w, h);
    depth.minFilter = THREE.NearestFilter; depth.magFilter = THREE.NearestFilter;
    stage.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: stage.targetType(renderer),
      depthBuffer: true, stencilBuffer: false, depthTexture: depth,
    });
    // Stays linear on purpose; the composite owns the sRGB encode (see retro.js COLOR SPACE).
    stage.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    stage.rt.texture.generateMipmaps = false;
    return true;
  };

  /** Low-res size from {pixelScale, targetHeight} tunables, aspect-locked, into stage.size. */
  stage.targetSize = (tune, fallbackHeight = 540) => {
    const scale = +tune.pixelScale || 0;
    const bufW = bufSize.x, bufH = bufSize.y;
    const wanted = scale > 0 ? bufH * scale : (+tune.targetHeight || fallbackHeight);
    const h = Math.max(64, Math.min(Math.round(wanted), Math.round(bufH) || 64));
    stage.size[0] = Math.max(64, Math.round(h * (bufW / Math.max(bufH, 1))));
    stage.size[1] = h;
    return stage.size;
  };

  stage.readBufferSize = renderer => renderer.getDrawingBufferSize(bufSize);

  /**
   * Quantize the camera position onto the output-texel lattice along its own right/up axes, so a
   * slow pan steps whole low-res texels instead of shimmering. Ground-plane referenced for persp,
   * exact frustum for ortho. Returns true when unsnap() must run.
   */
  stage.snapCamera = (cam, w, h) => {
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    axisR.set(e[0], e[1], e[2]); axisU.set(e[4], e[5], e[6]); axisF.set(-e[8], -e[9], -e[10]);
    const p = cam.projectionMatrix.elements;
    if(!p[0] || !p[5]) return false;
    let unitX, unitY;
    if(cam.isOrthographicCamera){
      unitX = (2 / p[0]) / w; unitY = (2 / p[5]) / h;
    }else{
      let dist = Math.abs(axisF.y) > 1e-4 ? -cam.position.y / axisF.y : 0;
      if(!(dist > 0) || !isFinite(dist)) dist = Math.max(cam.position.y, cam.near * 4);
      dist = clamp(dist, cam.near * 2, cam.far);
      unitX = (2 / p[0]) * dist / w; unitY = (2 / p[5]) * dist / h;
    }
    if(!(unitX > 0) || !(unitY > 0) || !isFinite(unitX) || !isFinite(unitY)) return false;
    savedPos.copy(cam.position);
    const dr = cam.position.dot(axisR), du = cam.position.dot(axisU);
    cam.position
      .addScaledVector(axisR, Math.round(dr / unitX) * unitX - dr)
      .addScaledVector(axisU, Math.round(du / unitY) * unitY - du);
    cam.updateMatrixWorld(true);
    return true;
  };
  stage.unsnapCamera = cam => { cam.position.copy(savedPos); cam.updateMatrixWorld(true); };

  /** Composite to the DEFAULT FRAMEBUFFER, explicitly — the contract says the frame ends on
   *  screen, whatever target a host or a throw left bound (codex catch). */
  stage.composite = renderer => {
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);
  };

  stage.dispose = () => {
    stage.releaseTarget();
    quadGeo.dispose();
    stage.material.dispose();
  };

  return stage;
}
