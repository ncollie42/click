// Texel splatting — the experimental pixel-art pipeline. Port of /pixel (Odin + sokol-gfx), which is
// itself an implementation of "Texel Splatting: Perspective-Stable 3D Pixel Art".
//
// THE IDEA IN ONE PARAGRAPH: instead of shading the screen, we shade a cubemap G-buffer captured
// from a probe whose origin is SNAPPED TO A WORLD GRID, then draw every one of its texels back to
// the screen as a little world-space quad. Because the texels are anchored to the probe and not to
// the camera, panning does not make the pixel grid crawl — the chunky pixels sit still in the world
// the way hand-drawn pixel art does, while still respecting perspective. When the camera leaves its
// grid cell the probe has to jump; a Bayer-dithered crossfade against the previous probe hides it.
//
// PASS ORDER (one frame)
//   1. shadow      capture.js   own depth pass from the sun, packed into RGBA8         [scene draw]
//   2. G-buffer    capture.js   albedo / octahedral normal / radial, MRT, per face     [scene draw]
//   3. edge mask   passes.js    4-neighbour radial continuity, one draw over the atlas
//   4. lighting    passes.js    world-pos reconstruct + PCF shadow + outlines + OKLab posterize
//   5. background  passes.js    sky (and hole-fill) at probe texel resolution, depth 1
//   6. splat       passes.js    probeSize^2 instanced quads per visible face, per probe
//   7. water       here         hybrid forward pass for transparents, over the splat depth buffer
//   8. post        passes.js    nearest-neighbour upscale of the low-res target + gamma
//
// WHAT WAS SIMPLIFIED VS THE REFERENCE, AND WHY
//   * No eye probe. The reference runs three probes (eye at the camera, grid, prev); the eye probe
//     exists to add close-range detail for a free-flying first-person camera. This game's camera is
//     locked to ~40 degrees of pitch and never rotates in play, so the grid probe alone covers the
//     screen and the eye probe would just double the capture bill.
//   * prev is ping-ponged, not re-captured. See targets.js.
//   * Texture array -> 3x2 atlas, R32F -> packed RGBA8. See targets.js.
//   * Entity-id outlines are per MATERIAL, not per mesh (three has no per-mesh uniform slot), with a
//     radial-discontinuity test added to recover silhouettes between props sharing a material.
//   * Transparents (water, rings, beams, the placement grid) are not splatted at all — splatting an
//     animated transparent surface is not a thing texel splatting does. They forward-render on top
//     into the same low-res target, which is why waterPrePass() is called with that target's size.
//
// FACE CULLING: faces are picked per frame from the camera forward vector at cos(103 degrees), the
// reference's grid threshold. At the game's fixed pose (pitch 40, yaw 0) that is +X, -X, -Y and -Z —
// four of six. +Y (straight up) and +Z (behind) never contribute and are neither captured nor
// splatted. Orbit debug mode re-derives the mask, so it keeps working.
//
// SCENE OWNERSHIP: this pipeline temporarily rewrites ctx.scene (material swaps, visible flags,
// scene.background) and renderer state (autoClear, clear colour, shadowMap.autoUpdate, render
// target). Every one of those is saved on entry and restored in a finally, including on the throw
// path — index.js benches a pipeline that throws, and it must hand the scene back intact.

import {Targets} from "./splat/targets.js";
import {SceneCapture, renderShadowMap, renderGBuffer} from "./splat/capture.js";
import {Transition, makeFaceCameras, placeFaceCameras, computeFaceMask, faceVisible} from "./splat/probe.js";
import {
  makeFullscreenGeometry, makeEdgeMaskPass, makeLightingPass,
  makeBackgroundPass, makePostPass, SplatDraw,
} from "./splat/passes.js";

/** Live knobs — read fresh every frame, so a debugger or the console can poke them mid-run.
 * probeSize vs postHeight is THE quality/cost dial: a cubemap face spans 90 degrees over probeSize
 * texels while the screen spans the camera's 38 over postHeight pixels, so a texel covers about
 * (90/probeSize) / (fov/postHeight) screen pixels. The defaults land near 2.5, matching the look of
 * the reference. Raise postHeight for a sharper image and the texels grow chunkier; raise probeSize
 * to keep them small and pay for it in vertex work (probeSize^2 quads per face per probe). */
export const splatTune = {
  probeSize: 512,        // cubemap face resolution; capture + splat cost scales with the square.
                         // Raised from the reference's 384: at 384/400p the upscale read as mush
                         // on a big viewport. 512/540 keeps the reference's ~2.5 px/texel exactly.
  postHeight: 540,       // low-res render height in px; width follows the canvas aspect
  gridStep: 2,           // world units between probe snaps; larger = stabler, bigger jump
  crossfadeTime: 0.5,    // seconds; the fade also speeds up with camera velocity
  probeNear: 0.5,
  probeFar: 600,
  shadowSize: 1024,
  shadowBias: 0.09,      // world units, constant term
  shadowSlope: 0.6,      // world units, scaled by 1 - N.L
  bands: 32,             // OKLab lightness posterization bands
  normalThresh: 0.7,     // dot below which two neighbouring normals count as a crease
  edgeThreshold: 0.002,  // relative radial delta that expands a quad (edge mask)
  depthEdge: 0.03,       // relative radial delta that counts as a silhouette (outlines)
  expansion: 0.5,        // gap-fill quad growth at discontinuities, in texels
  hazeDensity: 0.0035,
  sunGain: 0.7,          // scales the scene DirectionalLight's colour * intensity
  ambientGain: 1.0,      // scales the scene HemisphereLight/AmbientLight
  cullCos: -0.225,       // cos(103 degrees), the reference's grid-probe face mask threshold
  outlines: true,
  water: true,           // hybrid forward pass for transparents
  background: true,
  showFace: -1,          // debug: -1 = whole atlas, 0..5 = one face fullscreen (needs debugView > 0)
  debugView: 0,          // debug: 0 splat, 1 albedo, 2 normal, 3 radial, 4 lit, 5 edge, 6 shadow
};

const DEBUG_MODES = {1: 5, 2: 3, 3: 2, 4: 0, 5: 4, 6: 2};   // debugView -> POST_FRAG uMode

let R = null;       // all pipeline resources; null means "not built yet or disposed"
let lastTime = 0;

function build(ctx){
  const {THREE} = ctx;
  const nearFar = new THREE.Vector2(splatTune.probeNear, splatTune.probeFar);
  const quadGeometry = makeFullscreenGeometry(THREE);
  R = {
    targets: new Targets(THREE),
    capture: new SceneCapture(THREE, nearFar),
    transition: new Transition(),
    faceCams: makeFaceCameras(THREE, splatTune.probeNear, splatTune.probeFar),
    quadGeometry,
    edgePass: makeEdgeMaskPass(THREE, quadGeometry),
    lightPass: makeLightingPass(THREE, quadGeometry),
    bgPass: makeBackgroundPass(THREE, quadGeometry),
    postPass: makePostPass(THREE, quadGeometry),
    splat: new SplatDraw(THREE, splatTune.probeSize),
    nearFar,
    lastMask: 0,        // face mask the current grid slot was captured with
    prevMask: 0,        // face mask the frozen (prev) slot was captured with
    // scratch — allocated once, never per frame
    v0: new THREE.Vector3(), v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
    savedClear: new THREE.Color(),
    viewProj: new THREE.Matrix4(),
    sky: {zenith: new THREE.Color(), horizon: new THREE.Color(), haze: new THREE.Color()},
    bufSize: new THREE.Vector2(),
  };
  return R;
}

/** Allocate/reallocate anything the current tune values or canvas size demand. */
function ensure(ctx){
  const {renderer} = ctx;
  // MRT + GLSL3 + gl_InstanceID are all WebGL2. Throwing here is the intended failure mode: the
  // registry benches the pipeline and the game keeps rendering normally.
  if(!renderer.capabilities.isWebGL2) throw new Error("splat pipeline requires WebGL2");
  if(!R) build(ctx);
  const maxProbe = Math.floor(renderer.capabilities.maxTextureSize / 3);
  const probeSize = Math.max(32, Math.min(maxProbe, Math.round(splatTune.probeSize)));
  if(R.targets.ensureAtlas(probeSize)){
    R.splat.setProbeSize(probeSize);
    R.prevMask = 0;          // the frozen slot is fresh garbage until it has been captured once
    R.lastMask = 0;
  }
  R.targets.ensureShadow(Math.max(256, Math.min(4096, Math.round(splatTune.shadowSize))));
  renderer.getDrawingBufferSize(R.bufSize);
  const h = Math.max(64, Math.round(splatTune.postHeight));
  const aspect = R.bufSize.y > 0 ? R.bufSize.x / R.bufSize.y : 16 / 9;
  R.targets.ensureLowRes(Math.round(h * aspect), h);
  R.nearFar.set(splatTune.probeNear, splatTune.probeFar);
  return R;
}

/** Sky/haze palette is derived from the scene's own background colour, so the pipeline follows the
 * game's day/night tint instead of hardcoding the reference's daytime blue. */
function readSky(scene, sky, fallback){
  const bg = scene.background;
  if(bg && bg.isColor){
    sky.horizon.copy(bg);
    sky.zenith.copy(bg).multiplyScalar(0.62);
    sky.haze.copy(bg).multiplyScalar(0.95);
  }else{
    sky.horizon.copy(fallback.horizon);
    sky.zenith.copy(fallback.zenith);
    sky.haze.copy(fallback.haze);
  }
}
const SKY_FALLBACK = {
  horizon: {r: 0.55, g: 0.61, b: 0.70},
  zenith: {r: 0.25, g: 0.47, b: 0.815},
  haze: {r: 0.50, g: 0.56, b: 0.66},
};

export default {
  name: "splat",

  init(ctx){ ensure(ctx); },

  resize(ctx){ if(R) ensure(ctx); },

  render(ctx){
    const {THREE, renderer, scene} = ctx;
    const camera = ctx.getCamera();
    const sun = ctx.getSun();
    ensure(ctx);

    const now = performance.now() / 1000;
    const dt = lastTime ? Math.min(Math.max(now - lastTime, 0), 0.1) : 1 / 60;
    lastTime = now;

    // ── save every piece of shared state we are about to bend ──
    const savedAutoClear = renderer.autoClear;
    const savedShadowAuto = renderer.shadowMap.autoUpdate;
    const savedBackground = scene.background;
    const savedOverride = scene.overrideMaterial;
    const savedAlpha = renderer.getClearAlpha();
    const savedClear = renderer.getClearColor(R.savedClear);

    try{
      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false;   // three's own shadow pass would re-render the scene
      scene.overrideMaterial = null;
      readSky(scene, R.sky, SKY_FALLBACK);
      scene.background = null;                 // stops three force-clearing on every scene render

      camera.updateMatrixWorld();
      scene.updateMatrixWorld();
      const camPos = camera.getWorldPosition(R.v0);
      const fwd = camera.getWorldDirection(R.v1);

      // ── probe transition ──
      R.transition.update(THREE, camPos, dt, splatTune.gridStep, splatTune.crossfadeTime);
      if(R.transition.snapped){
        R.targets.swapSlots();
        R.prevMask = R.lastMask;               // the slot we just froze was captured with this mask
      }
      const gridMask = computeFaceMask(fwd, splatTune.cullCos);
      const origin = R.transition.gridOrigin;
      const probeSize = R.targets.probeSize;
      const fade = R.transition.fade;
      placeFaceCameras(R.faceCams, origin, splatTune.probeNear, splatTune.probeFar);

      // ── 1 + 2: shadow map and G-buffer capture ──
      R.capture.partition(scene);
      R.capture.refreshVariants();
      R.capture.hideShells();
      R.capture.beginCapture();
      renderShadowMap(renderer, scene, R.capture, sun, R.targets.shadow);
      renderGBuffer(renderer, scene, R.targets.grid.gbuf, R.faceCams, gridMask, probeSize);
      R.capture.endCapture();
      R.lastMask = gridMask;

      const grid = R.targets.grid;
      const prev = R.targets.prev;

      // ── 3: edge mask ──
      {
        const u = R.edgePass.material.uniforms;
        u.uRadial.value = grid.gbuf.texture[2];
        u.uProbeSize.value = probeSize;
        u.uThreshold.value = splatTune.edgeThreshold;
        renderer.setRenderTarget(grid.edge);
        R.edgePass.render(renderer);
      }

      // ── 4: lighting ──
      {
        const u = R.lightPass.material.uniforms;
        u.uAlbedo.value = grid.gbuf.texture[0];
        u.uNormal.value = grid.gbuf.texture[1];
        u.uRadial.value = grid.gbuf.texture[2];
        u.uShadow.value = R.targets.shadow.texture;
        u.uLightMatrix.value.copy(sun.shadow.matrix);
        // Direction TO the sun. sun.target is parented into the scene by scene.js and tracks the
        // camera, so this is a live vector, not a constant.
        u.uSunDir.value.copy(sun.getWorldPosition(R.v2))
          .sub(sun.target.getWorldPosition(R.v3)).normalize();
        u.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity * splatTune.sunGain);
        const amb = R.capture.ambient;
        if(amb && amb.isHemisphereLight){
          u.uAmbient.value.copy(amb.color).lerp(amb.groundColor, 0.5)
            .multiplyScalar(amb.intensity * splatTune.ambientGain);
        }else if(amb){
          u.uAmbient.value.copy(amb.color).multiplyScalar(amb.intensity * splatTune.ambientGain);
        }else{
          u.uAmbient.value.setRGB(0.15, 0.15, 0.2);
        }
        u.uProbeOrigin.value.copy(origin);
        u.uNearFar.value.copy(R.nearFar);
        const sc = sun.shadow.camera;
        const range = Math.max(sc.far - sc.near, 1e-3);
        u.uShadowBias.value.set(splatTune.shadowBias / range, splatTune.shadowSlope / range);
        u.uSkyZenith.value.copy(R.sky.zenith);
        u.uSkyHorizon.value.copy(R.sky.horizon);
        u.uHazeColor.value.copy(R.sky.haze);
        u.uHazeDensity.value = splatTune.hazeDensity;
        u.uShadowTexel.value = 1 / R.targets.shadowSize;
        u.uBands.value = splatTune.bands;
        u.uNormalThresh.value = splatTune.normalThresh;
        u.uDepthEdge.value = splatTune.depthEdge;
        u.uOutlines.value = splatTune.outlines ? 1 : 0;
        u.uProbeSize.value = probeSize;
        renderer.setRenderTarget(grid.lit);
        R.lightPass.render(renderer);
      }

      // ── water depth pre-pass, at the low-res target's size so the water shader's screen-space
      // UVs line up. It needs a real clear, so autoClear goes back on for exactly that call. ──
      if(splatTune.water){
        renderer.setClearColor(savedClear, savedAlpha);
        renderer.autoClear = true;
        ctx.waterPrePass(R.targets.lowW, R.targets.lowH);
        renderer.autoClear = false;
      }

      // ── 5 + 6: background and splat quads into the low-res target ──
      R.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      renderer.setRenderTarget(R.targets.lowRes);
      renderer.setClearColor(R.sky.horizon, 1);
      renderer.clear(true, true, false);

      if(splatTune.background){
        const u = R.bgPass.material.uniforms;
        u.uLit.value = grid.lit.texture;
        u.uRadial.value = grid.gbuf.texture[2];
        u.uInvViewProj.value.copy(R.viewProj).invert();
        u.uProbeOrigin.value.copy(origin);
        u.uHazeColor.value.copy(R.sky.haze);
        u.uNearFar.value.copy(R.nearFar);
        u.uHazeDensity.value = splatTune.hazeDensity;
        u.uProbeSize.value = probeSize;
        R.bgPass.render(renderer);
      }

      {
        const u = R.splat.material.uniforms;
        u.uViewProj.value.copy(R.viewProj);
        u.uCameraPos.value.copy(camPos);
        u.uNearFar.value.copy(R.nearFar);
        u.uExpansion.value = splatTune.expansion;
        u.uHazeColor.value.copy(R.sky.haze);
        u.uHazeDensity.value = splatTune.hazeDensity;
        u.uFadeT.value = fade;

        // grid probe: fades IN during a transition
        u.uRadial.value = grid.gbuf.texture[2];
        u.uEdge.value = grid.edge.texture;
        u.uLit.value = grid.lit.texture;
        u.uProbeOrigin.value.copy(origin);
        u.uSlot.value = 0;
        for(let f = 0; f < 6; f++){
          if(!faceVisible(f, gridMask)) continue;
          R.splat.drawFace(renderer, f);
        }

        // prev probe: fades OUT, inverse dither, only while blending and only for the faces the
        // frozen slot actually holds.
        if(fade > 0 && fade < 1 && R.prevMask){
          u.uRadial.value = prev.gbuf.texture[2];
          u.uEdge.value = prev.edge.texture;
          u.uLit.value = prev.lit.texture;
          u.uProbeOrigin.value.copy(R.transition.prevOrigin);
          u.uSlot.value = 1;
          for(let f = 0; f < 6; f++){
            if(!faceVisible(f, R.prevMask & gridMask)) continue;
            R.splat.drawFace(renderer, f);
          }
        }
      }

      // ── 7: hybrid forward pass for transparents, over the splat depth buffer ──
      if(splatTune.water){
        R.capture.beginForward();
        renderer.setRenderTarget(R.targets.lowRes);
        renderer.render(scene, camera);
        R.capture.endForward();
      }

      // ── 8: post ──
      renderer.setRenderTarget(null);
      {
        const u = R.postPass.material.uniforms;
        const view = splatTune.debugView | 0;
        if(view > 0){
          const g = R.targets.grid;
          u.uTex.value = view === 1 ? g.gbuf.texture[0]
                       : view === 2 ? g.gbuf.texture[1]
                       : view === 3 ? g.gbuf.texture[2]
                       : view === 4 ? g.lit.texture
                       : view === 5 ? g.edge.texture
                       : R.targets.shadow.texture;
          u.uMode.value = DEBUG_MODES[view] ?? 1;
          const f = splatTune.showFace;
          if(view !== 6 && f >= 0 && f <= 5) u.uRect.value.set((f % 3) / 3, Math.floor(f / 3) / 2, 1 / 3, 1 / 2);
          else u.uRect.value.set(0, 0, 1, 1);
        }else{
          u.uTex.value = R.targets.lowRes.texture;
          u.uMode.value = 0;
          u.uRect.value.set(0, 0, 1, 1);
        }
        R.postPass.render(renderer);
      }
    }finally{
      R.capture.restoreAll();
      scene.background = savedBackground;
      scene.overrideMaterial = savedOverride;
      renderer.setClearColor(savedClear, savedAlpha);
      renderer.autoClear = savedAutoClear;
      renderer.shadowMap.autoUpdate = savedShadowAuto;
      renderer.setRenderTarget(null);
    }
  },

  dispose(){
    if(!R) return;
    R.targets.dispose();
    R.capture.dispose();
    R.edgePass.dispose();
    R.lightPass.dispose();
    R.bgPass.dispose();
    R.postPass.dispose();
    R.splat.dispose();
    R.quadGeometry.dispose();
    R = null;
    lastTime = 0;
  },
};
