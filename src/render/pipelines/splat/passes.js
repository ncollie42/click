// Owns: the fullscreen and instanced draws that never touch the game scene — edge mask, lighting,
// background, the splat quads themselves, and the post upscale. Each one is a tiny private
// THREE.Scene holding a single mesh, which is the cheapest way to issue a controlled draw through
// WebGLRenderer without fighting its render lists.
//
// A private scene also has scene.background === null, which matters more than it looks: three force-
// clears the colour buffer whenever a rendered scene carries a background colour, so drawing these
// passes through the *game* scene would wipe the target between passes.
//
// THE UNIFORM TRAP, once, for all of these: three only re-uploads a ShaderMaterial's uniforms when
// the material id changes between draws. Every one of these passes is drawn repeatedly with the same
// material and different uniform values (six faces, two probes), so each draw sets
// `material.uniformsNeedUpdate = true` first. Removing that line does not break anything visibly at
// first — it silently makes every face render with face 0's uniforms.

import {
  FULLSCREEN_VERT, EDGE_MASK_FRAG, LIGHTING_FRAG,
  BACKGROUND_VERT, BACKGROUND_FRAG, SPLAT_VERT, SPLAT_FRAG, POST_FRAG,
} from "./glsl.js";

// Clip-space positions for a single screen-covering triangle; the vertex shaders use xy verbatim.
const FULLSCREEN_POSITIONS = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);

// Quad corners as sign pairs, in the reference's winding: BL BR TR / BL TR TL. Culling is off, so
// the winding only has to be consistent, not outward-facing.
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

// ── edge mask ───────────────────────────────────────────────────────────────
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

// ── lighting ────────────────────────────────────────────────────────────────
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
      uProbeOrigin: {value: new THREE.Vector3()},
      uNearFar: {value: new THREE.Vector2(0.5, 600)},
      uShadowBias: {value: new THREE.Vector2(0.0005, 0.002)},
      uSkyZenith: {value: new THREE.Color(0.25, 0.47, 0.815)},
      uSkyHorizon: {value: new THREE.Color(0.55, 0.61, 0.7)},
      uHazeColor: {value: new THREE.Color(0.5, 0.56, 0.66)},
      uHazeDensity: {value: 0.004},
      uShadowTexel: {value: 1 / 1024},
      uBands: {value: 32},
      uNormalThresh: {value: 0.7},
      uDepthEdge: {value: 0.03},
      uOutlines: {value: 1},
      uProbeSize: {value: 1},
    },
    depthTest: false, depthWrite: false, transparent: false,
  });
  return new Pass(THREE, material, geometry);
}

// ── background ──────────────────────────────────────────────────────────────
// Draws at depth 1.0 so the splat quads land in front of it. It is both the sky and the hole-filler:
// wherever the quads fail to cover a pixel, this shows the probe's own lit texel for that direction.
export function makeBackgroundPass(THREE, geometry){
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BACKGROUND_VERT,
    fragmentShader: BACKGROUND_FRAG,
    uniforms: {
      uLit: {value: null},
      uRadial: {value: null},
      uInvViewProj: {value: new THREE.Matrix4()},
      uProbeOrigin: {value: new THREE.Vector3()},
      uHazeColor: {value: new THREE.Color(0.5, 0.56, 0.66)},
      uNearFar: {value: new THREE.Vector2(0.5, 600)},
      uHazeDensity: {value: 0.004},
      uProbeSize: {value: 1},
    },
    depthTest: true, depthWrite: true, transparent: false,
  });
  return new Pass(THREE, material, geometry);
}

// ── splat ───────────────────────────────────────────────────────────────────
// probeSize^2 instances of a 6-vertex quad per visible face. No per-instance attributes: the texel
// index is gl_InstanceID and the corner is the sign pair in `position`, exactly like the reference's
// vertex-buffer-less draw.
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
        uFadeT: {value: 0},
        uSlot: {value: 0},
        uFace: {value: 0},
        uProbeSize: {value: probeSize},
        uHazeColor: {value: new THREE.Color(0.5, 0.56, 0.66)},
        uHazeDensity: {value: 0.004},
      },
      side: THREE.DoubleSide,
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

  /** One face, one draw. Uniforms that vary per face are set by the caller beforehand. */
  drawFace(renderer, face){
    this.material.uniforms.uFace.value = face;
    this.material.uniformsNeedUpdate = true;
    renderer.render(this.scene, this.camera);
  }

  dispose(){
    this.material.dispose();
    this.geometry.dispose();
    this.scene.clear();
  }
}

// ── post ────────────────────────────────────────────────────────────────────
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
