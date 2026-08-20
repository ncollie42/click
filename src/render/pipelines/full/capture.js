// Owns: everything that renders the GAME SCENE rather than a fullscreen quad — the sun shadow pass
// and the 18-layer G-buffer capture — plus the material bookkeeping both depend on.
//
// THIS FILE EXISTS BECAUSE OF ONE THREE.JS GAP. A G-buffer needs per-mesh albedo, and three's
// one-line answer to "render the scene with a different shader" (scene.overrideMaterial) throws
// every per-mesh colour away. So instead of overriding we SWAP: each source material gets a cached
// G-buffer twin — same colour, same side, same flat-shading, same instancing shape — and the swap is
// applied to the whole scene once, held across all EIGHTEEN face renders, and undone before anything
// else looks at the scene graph. The cache is keyed by (source material uuid, instanced?) because
// three recompiles a program when one material is used on both an InstancedMesh and a plain Mesh.
//
// This structure and its degradation rules are lifted from the sibling `splat` pipeline's
// capture.js, which is validation-hardened; the differences here are the 18-layer capture loop and
// the three probe origins. The reference (/pixel) has no equivalent — Odin drew its own vertex
// buffer with a single G-buffer shader, so per-mesh colour was just a uniform.
//
// DEGRADATION, deliberately: vertex colours and a diffuse map are honoured (variants carry
// USE_COLOR / GB_MAP); emissive is folded into the base colour, so glowing props read bright but
// still take lighting; a material with no .color at all captures as white. Objects that cannot mean
// anything as splats are routed away instead of faked — see partition().
//
// ENTITY IDS: the reference tags every entity with an id in albedo.a for its outline pass. three has
// no per-mesh uniform slot, so ids here are per MATERIAL. The lighting pass compensates with a
// radial-discontinuity test (full/glsl.js detectEdge) so silhouettes between two props sharing a
// material still get inked.
//
// OWNERSHIP: this module mutates ctx.scene (material fields, visible flags) and MUST leave it byte
// for byte as it found it. Every mutation is paired: beginCapture/endCapture, beginForward/
// endForward, hideShells/showShells. full.js calls them in that order and unwinds in a finally, and
// restoreAll() is the belt-and-braces for the throw path — index.js benches a pipeline whose
// render() throws and then falls back to a direct render of the same scene.

import {GBUFFER_VERT, GBUFFER_FRAG, SHADOW_VERT, SHADOW_FRAG} from "./glsl.js";
import {NUM_FACES, NUM_PROBES, faceVisible, placeFaceCameras} from "./probe.js";

let nextEntityId = 1;   // 0 is reserved for sky (the zero clear); 255 stays free as a guard
const SWEEP_TICKS = 600;

export class SceneCapture {
  constructor(THREE, nearFar){
    this.THREE = THREE;
    this.nearFar = nearFar;             // shared Vector2, mutated by full.js when the tune changes
    this.variants = new Map();          // key -> ShaderMaterial
    this.opaque = [];                   // {obj, original, swapped}
    this.forward = [];                  // transparent meshes, lines, points -> hybrid forward pass
    this.shells = [];                   // inverted-hull ink outlines: never drawn by this pipeline
    this.ambient = null;                // hemisphere/ambient light, read for the ambient term
    this.tick = 0;
    this.swapWasApplied = false;
    this.hiddenForward = false;
    this.hiddenOpaque = false;
    this.hiddenShells = false;

    this.shadowMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      side: THREE.FrontSide,
    });
  }

  // ── scene walk ────────────────────────────────────────────────────────────
  // Rebuilt every frame: units move, props spawn, the fog mesh rebuilds. A manual recursion instead
  // of Object3D.traverse so an invisible subtree costs nothing.
  partition(scene){
    this.opaque.length = 0;
    this.forward.length = 0;
    this.shells.length = 0;
    this.ambient = null;
    this.tick++;
    this._walk(scene);
    // The game builds materials at runtime (projectiles, meteors, rebuilt terrain). Left alone the
    // variant cache would grow with them for the life of the session, so anything untouched for
    // SWEEP_TICKS frames is dropped. Cheap: one pass every SWEEP_TICKS frames.
    if(this.tick % SWEEP_TICKS === 0) this._sweep();
  }

  _sweep(){
    for(const [key, m] of this.variants){
      if(this.tick - m.userData.tick < SWEEP_TICKS) continue;
      m.dispose();
      this.variants.delete(key);
    }
  }

  _walk(o){
    if(o.visible === false) return;
    if(o.isLight){
      if(o.isHemisphereLight || o.isAmbientLight) this.ambient = o;
    }else if(o.userData && o.userData.outline === true){
      this.shells.push(o);
      return;   // the shell's subtree is nothing but more shell
    }else if(o.isMesh){
      const mat = o.material;
      if(Array.isArray(mat)){
        if(mat.some(m => m && m.transparent)) this.forward.push(o);
        else this.opaque.push({obj:o, original:mat, swapped:mat.map(m => this._variant(m, o.isInstancedMesh))});
      }else if(mat){
        if(mat.transparent) this.forward.push(o);
        else this.opaque.push({obj:o, original:mat, swapped:this._variant(mat, o.isInstancedMesh)});
      }
    }else if(o.isLine || o.isPoints || o.isSprite){
      this.forward.push(o);
    }
    const kids = o.children;
    for(let i = 0; i < kids.length; i++) this._walk(kids[i]);
  }

  // ── G-buffer material variants ────────────────────────────────────────────
  _variant(src, instanced){
    const THREE = this.THREE;
    const key = `${src.uuid}${instanced ? "|i" : ""}`;
    let m = this.variants.get(key);
    if(m){ m.userData.tick = this.tick; return m; }

    const defines = {};
    if(src.flatShading) defines.GB_FLAT = "";
    if(src.map) defines.GB_MAP = "";
    if(src.side === THREE.BackSide) defines.GB_FLIP = "";
    else if(src.side === THREE.DoubleSide) defines.GB_DOUBLE = "";

    const uniforms = {
      uColor: {value: new THREE.Color(1, 1, 1)},
      uEntityId: {value: nextEntityId / 255},
      uNearFar: {value: this.nearFar},
    };
    nextEntityId = nextEntityId >= 254 ? 1 : nextEntityId + 1;
    if(src.map){
      uniforms.uMap = {value: src.map};
      uniforms.uMapTransform = {value: new THREE.Vector4(1, 1, 0, 0)};
    }

    m = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines,
      uniforms,
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      side: src.side,
      vertexColors: src.vertexColors === true,
      depthTest: true,
      depthWrite: true,
      transparent: false,
    });
    m.userData.src = src;
    m.userData.tick = this.tick;
    this.variants.set(key, m);
    return m;
  }

  /** Pull live colour/map state out of every source material. Cheap, and it keeps the day/night tint
   * and any runtime recolour working — the game mutates material.color in place. */
  refreshVariants(){
    for(const m of this.variants.values()){
      const src = m.userData.src;
      const c = m.uniforms.uColor.value;
      if(src.color) c.copy(src.color); else c.setRGB(1, 1, 1);
      if(src.emissive) c.add(src.emissive);
      if(m.uniforms.uMap){
        m.uniforms.uMap.value = src.map;
        const t = m.uniforms.uMapTransform.value;
        if(src.map) t.set(src.map.repeat.x, src.map.repeat.y, src.map.offset.x, src.map.offset.y);
      }
      // Consecutive draws of one material skip three's uniform upload; this is the documented
      // opt-out, and the values only change once per frame.
      m.uniformsNeedUpdate = true;
    }
  }

  // ── paired scene mutations ────────────────────────────────────────────────
  hideShells(){
    if(this.hiddenShells) return;
    for(const s of this.shells) s.visible = false;
    this.hiddenShells = true;
  }
  showShells(){
    if(!this.hiddenShells) return;
    for(const s of this.shells) s.visible = true;
    this.hiddenShells = false;
  }

  /** Swap in the G-buffer twins and pull the transparents out of the way. */
  beginCapture(){
    for(const e of this.forward) e.visible = false;
    this.hiddenForward = true;
    for(const e of this.opaque) e.obj.material = e.swapped;
    this.swapWasApplied = true;
  }
  endCapture(){
    if(this.swapWasApplied){
      for(const e of this.opaque) e.obj.material = e.original;
      this.swapWasApplied = false;
    }
    if(this.hiddenForward){
      for(const e of this.forward) e.visible = true;
      this.hiddenForward = false;
    }
  }

  /** Inverse of the capture set: only the transparents draw, over the splats' depth buffer. */
  beginForward(){
    for(const e of this.opaque) e.obj.visible = false;
    this.hiddenOpaque = true;
  }
  endForward(){
    if(!this.hiddenOpaque) return;
    for(const e of this.opaque) e.obj.visible = true;
    this.hiddenOpaque = false;
  }

  restoreAll(){
    this.endCapture();
    this.endForward();
    this.showShells();
  }

  dispose(){
    this.restoreAll();
    for(const m of this.variants.values()) m.dispose();
    this.variants.clear();
    this.shadowMaterial.dispose();
    this.opaque.length = this.forward.length = this.shells.length = 0;
  }
}

// ── passes ──────────────────────────────────────────────────────────────────

/** shadow.odin's depth-only pass from the sun, into an RGBA8 target holding packed gl_FragCoord.z.
 * The reference orbits its own sun and builds its own ortho light frustum; here we drive the GAME's
 * DirectionalLight shadow camera, because scene.js already sizes that frustum to the current zoom —
 * we inherit correct coverage for free, and the sun direction follows the game's day cycle.
 * three's own shadow machinery stays switched off (full.js forces shadowMap.autoUpdate = false
 * around the whole frame) so it cannot re-render the scene behind us. */
export function renderShadowMap(renderer, scene, capture, sun, target){
  sun.shadow.updateMatrices(sun);          // positions the shadow camera + builds sun.shadow.matrix
  const shadowCam = sun.shadow.camera;
  const prevOverride = scene.overrideMaterial;
  scene.overrideMaterial = capture.shadowMaterial;
  target.viewport.set(0, 0, target.width, target.height);
  target.scissor.set(0, 0, target.width, target.height);
  target.scissorTest = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0xffffff, 1);     // white = far = "nothing occludes here"
  renderer.clear(true, true, false);
  renderer.render(scene, shadowCam);
  scene.overrideMaterial = prevOverride;
}

/** game.odin's Pass 2, all three probes: MRT capture of up to 18 (probe, face) layers into the 6x3
 * atlas. Clear the whole atlas once, then draw the scene once per layer into that layer's cell via
 * the render target's viewport/scissor (setRenderTarget re-applies both to GL state, which is why it
 * is called again inside the loop).
 *
 * `masks[p]` is the 6-bit face mask for probe p. The FAITHFUL configuration passes 0x3F for all
 * three — the reference captures every layer it will splat, and this pipeline must survive free
 * camera rotation, so nothing is culled at CAPTURE time by default. The masks exist so the optional
 * `cullCaptures` tune can reproduce the reference's own capture-time culling when someone needs the
 * frame back.
 *
 * three frustum-culls each face render against its 90-degree camera, which is most of the reason
 * 18 scene draws stays merely expensive rather than impossible.
 *
 * @returns the number of scene draws issued, for the cost readout. */
export function renderGBuffer(renderer, scene, target, cams, origins, masks, probeSize, near, far){
  target.viewport.set(0, 0, target.width, target.height);
  target.scissor.set(0, 0, target.width, target.height);
  target.scissorTest = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);     // zero clear == sky sentinel in every attachment
  renderer.clear(true, true, false);

  let draws = 0;
  for(let p = 0; p < NUM_PROBES; p++){
    const mask = masks[p];
    if(!mask) continue;
    placeFaceCameras(cams, origins[p], near, far);
    for(let f = 0; f < NUM_FACES; f++){
      if(!faceVisible(f, mask)) continue;
      const layer = p * NUM_FACES + f;
      const ox = (layer % NUM_FACES) * probeSize;
      const oy = Math.floor(layer / NUM_FACES) * probeSize;
      target.viewport.set(ox, oy, probeSize, probeSize);
      target.scissor.set(ox, oy, probeSize, probeSize);
      target.scissorTest = true;
      renderer.setRenderTarget(target);    // re-applies viewport/scissor to GL state
      renderer.render(scene, cams[f]);
      draws++;
    }
  }
  target.scissorTest = false;
  target.viewport.set(0, 0, target.width, target.height);
  target.scissor.set(0, 0, target.width, target.height);
  return draws;
}
