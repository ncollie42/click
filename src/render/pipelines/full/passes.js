// Owns: the draws that never touch the game scene — edge mask, lighting, background, the splat
// quads themselves, and the post upscale. Each is a tiny private THREE.Scene holding a single mesh,
// which is the cheapest way to issue a controlled draw through WebGLRenderer without fighting its
// render lists.
//
// A private scene also has scene.background === null, which matters more than it looks: three
// force-clears the colour buffer whenever a rendered scene carries a background colour, so routing
// these passes through the GAME scene would wipe the target between passes.
//
// THE UNIFORM TRAP, once, for all of these: three only re-uploads a ShaderMaterial's uniforms when
// the material id changes between draws. The splat material is drawn up to eighteen times per frame
// with different uniform values, so every draw sets `material.uniformsNeedUpdate = true` first.
// Removing that line does not break anything visibly at first — it silently makes every face render
// with the first face's uniforms.
//
// Ported from splat.odin (splat + background pipelines), edge_mask.odin, lighting.odin, post.odin.

import {
  FULLSCREEN_VERT, EDGE_MASK_FRAG, LIGHTING_FRAG,
  BACKGROUND_VERT, BACKGROUND_FRAG, SPLAT_VERT, SPLAT_FRAG, POST_FRAG,
} from "./glsl.js";

// Clip-space positions for a single screen-covering triangle; the vertex shaders use xy verbatim.
const FULLSCREEN_POSITIONS = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);

// Quad corners as sign pairs, in the reference's winding: BL BR TR / BL TR TL (splat.glsl vid 0..5).
// Culling is off, so the winding only has to be consistent, not outward-facing.
const QUAD_CORNERS = new Float32Array([
  -1, -1, 0,   1, -1, 0,   1, 1, 0,
  -1, -1, 0,   1,  1, 0,  -1, 1, 0,
]);

/** One draw of one material over a full render target (or a viewport of one). */
export class Pass {
  constructor(THREE, material, geometry){
    this.material = material;
    this.geometry = geometry;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  render(renderer){
    this.material.uniformsNeedUpdate = true;
    renderer.render(this.scene, this.camera);
  }
  dispose(){
    this.material.dispose();
    this.scene.clear();
  }
}

export function makeFullscreenGeometry(THREE){
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(FULLSCREEN_POSITIONS, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ── edge mask (edge_mask.odin) ──────────────────────────────────────────────
export function makeEdgeMaskPass(THREE, geometry){
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: EDGE_MASK_FRAG,
    uniforms: {
      uRadial: {value: null},
      uProbeSize: {value: 1},
      uThreshold: {value: 0.002},
    },
    depthTest: false, depthWrite: false, transparent: false,
  });
  return new Pass(THREE, material, geometry);
}

// ── lighting (lighting.odin) ────────────────────────────────────────────────
// One draw over all 18 atlas cells. The three probe origins arrive as three separate vec3 uniforms
// rather than an array: three handles `vec3[3]` fine, but three scalars sidestep the whole
// PureArrayUniform path for the cost of two ternaries in the shader.
export function makeLightingPass(THREE, geometry){
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: LIGHTING_FRAG,
    uniforms: {
      uAlbedo: {value: null},
      uNormal: {value: null},
      uRadial: {value: null},
      uShadow: {value: null},
      uLightMatrix: {value: new THREE.Matrix4()},
      uSunDir: {value: new THREE.Vector3(0, 1, 0)},
      uSunColor: {value: new THREE.Color(1, 0.95, 0.9)},
      uAmbient: {value: new THREE.Color(0.15, 0.15, 0.2)},
      uOriginEye: {value: new THREE.Vector3()},
      uOriginGrid: {value: new THREE.Vector3()},
      uOriginPrev: {value: new THREE.Vector3()},
      uNearFar: {value: new THREE.Vector2(0.5, 600)},
      uShadowBias: {value: new THREE.Vector2(0.001, 0.005)},   // x = const, y = slope (reference)
      uSkyZenith: {value: new THREE.Color(0.25, 0.47, 0.815)},
      uSkyHorizon: {value: new THREE.Color(0.55, 0.61, 0.7)},
      uHazeColor: {value: new THREE.Color(0.5, 0.56, 0.66)},
      uHazeDensity: {value: 0.005},
      uShadowTexel: {value: 1 / 2048},
      uBands: {value: 32},
      uNormalThresh: {value: 0.7},
      uDepthEdge: {value: 0.03},
      uOutlineDarken: {value: 1},
      uOutlineHighlight: {value: 1},
      uOutlines: {value: 1},
      uOutlineEye: {value: 0},
      uProbeSize: {value: 1},
    },
    depthTest: false, depthWrite: false, transparent: false,
  });
  return new Pass(THREE, material, geometry);
}

// ── background (background.glsl, drawn by splat.odin before the quads) ──────
// Depth 1.0 so every splat quad lands in front. It is both the sky and the hole-filler: wherever the
// quads fail to cover a pixel, this shows the eye probe's own lit texel for that direction.
export function makeBackgroundPass(THREE, geometry){
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BACKGROUND_VERT,
    fragmentShader: BACKGROUND_FRAG,
    uniforms: {
      uLit: {value: null},
      uRadial: {value: null},
      uInvViewProj: {value: new THREE.Matrix4()},
      uEyeOrigin: {value: new THREE.Vector3()},
      uHazeColor: {value: new THREE.Color(0.5, 0.56, 0.66)},
      uNearFar: {value: new THREE.Vector2(0.5, 600)},
      uHazeDensity: {value: 0.005},
      uProbeSize: {value: 1},
      uProbeRow: {value: 0},
    },
    depthTest: true, depthWrite: true, transparent: false,
  });
  return new Pass(THREE, material, geometry);
}

// ── splat (splat.odin) ──────────────────────────────────────────────────────
// probeSize^2 instances of a 6-vertex quad per (probe, visible face). No per-instance attributes:
// the texel index is gl_InstanceID and the corner is the sign pair in `position`, matching the
// reference's vertex-buffer-less draw. three drives this through the
// `geometry.isInstancedBufferGeometry` branch of renderBufferDirect, using geometry.instanceCount —
// with no InstancedBufferAttribute present, geometry._maxInstanceCount stays undefined so the count
// is taken verbatim.
export class SplatDraw {
  constructor(THREE, probeSize){
    this.THREE = THREE;
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(QUAD_CORNERS, 3));
    this.geometry.instanceCount = probeSize * probeSize;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      uniforms: {
        uRadial: {value: null},
        uEdge: {value: null},
        uLit: {value: null},
        uViewProj: {value: new THREE.Matrix4()},
        uProbeOrigin: {value: new THREE.Vector3()},
        uCameraPos: {value: new THREE.Vector3()},
        uNearFar: {value: new THREE.Vector2(0.5, 600)},
        uExpansion: {value: 0.5},
        uTightScale: {value: 1.15},
        uTightSlope: {value: 0.0005},
        uFadeT: {value: 0},
        uEyeBias: {value: 0.001},
        uProbeIdx: {value: 0},
        uFace: {value: 0},
        uLayer: {value: 0},
        uProbeSize: {value: probeSize},
        uHazeColor: {value: new THREE.Color(0.5, 0.56, 0.66)},
        uHazeDensity: {value: 0.005},
      },
      side: THREE.DoubleSide,     // splat.odin: cull_mode = NONE, quads may face any direction
      depthTest: true, depthWrite: true, transparent: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  setProbeSize(probeSize){
    this.geometry.instanceCount = probeSize * probeSize;
    this.material.uniforms.uProbeSize.value = probeSize;
  }

  /** One (probe, face) layer, one draw. Everything that varies per PROBE is set by the caller
   * beforehand; face and layer are set here. */
  drawLayer(renderer, probeIdx, face){
    const u = this.material.uniforms;
    u.uProbeIdx.value = probeIdx;
    u.uFace.value = face;
    u.uLayer.value = probeIdx * 6 + face;
    this.material.uniformsNeedUpdate = true;
    renderer.render(this.scene, this.camera);
  }

  dispose(){
    this.material.dispose();
    this.geometry.dispose();
    this.scene.clear();
  }
}

// ── post (post.odin + debug_vis.odin) ───────────────────────────────────────
export function makePostPass(THREE, geometry){
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: POST_FRAG,
    uniforms: {
      uTex: {value: null},
      uRect: {value: new THREE.Vector4(0, 0, 1, 1)},
      uMode: {value: 0},
    },
    depthTest: false, depthWrite: false, transparent: false,
  });
  return new Pass(THREE, material, geometry);
}
