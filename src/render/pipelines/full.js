// FULL texel splatting — a no-shortcuts port of /home/mando/dev/gamedev/pixel (Odin + sokol-gfx),
// which implements "Texel Splatting: Perspective-Stable 3D Pixel Art" (arXiv 2603.14587).
//
// THE IDEA IN ONE PARAGRAPH: instead of shading the screen, shade a cubemap G-buffer captured from
// PROBES whose origins are anchored in the world, then draw every one of their texels back to screen
// as a little world-space quad. Because the texels belong to the probe and not to the camera,
// panning and TURNING do not make the pixel grid crawl — the chunky pixels sit still in the world
// the way hand-drawn pixel art does, while still respecting perspective.
//
// WHY THIS FILE EXISTS ALONGSIDE pipelines/splat.js. The sibling `splat` pipeline is a deliberately
// simplified adaptation: one probe, four faces, fixed camera pose, prev recycled by ping-pong. It is
// cheap and it is correct ONLY because this game's camera does not currently rotate. This one takes
// the opposite trade: every fixed-camera shortcut is removed so that free camera ROTATION stays
// correct if it is ever added. It costs 21 scene draws per frame (18 G-buffer + shadow + water
// prepass + forward transparents; fullStats.sceneDraws counts the first 19). That is the price, and it is the
// point.
//
// ── PASS ORDER (one frame), against the reference's game.odin ──────────────────────────────
//   1. shadow      capture.js   depth from the sun, packed RGBA8, 2048^2        [1 scene draw]
//   2. G-buffer    capture.js   albedo / oct normal / radial, MRT, 18 layers   [18 scene draws]
//   3. edge mask   passes.js    4-neighbour radial continuity, per layer
//   4. lighting    passes.js    world-pos reconstruct + 3x3 PCF + outlines + OKLab posterize
//   5. background  passes.js    pixelated sky from the EYE probe, at depth 1.0
//   6. splat       passes.js    probeSize^2 instanced quads per visible face per probe
//   7. water       here         hybrid forward pass for transparents (NO reference equivalent)
//   8. post        passes.js    nearest-neighbour upscale of the ~555p target + gamma
//
// ── THREE PROBES, ALL SIX FACES, EVERY FRAME ───────────────────────────────────────────────
//   eye  (layers  0-5)  origin = the live camera position
//   grid (layers  6-11) origin = camera position snapped to a gridStep lattice (reference: 1m)
//   prev (layers 12-17) origin = the previous grid origin, live during a crossfade
// The reference culls CAPTURES by camera direction (probe.odin compute_face_mask, 98/103 degrees)
// and alternates grid/prev on even/odd frames. Neither shortcut is taken here by default: all 18
// layers are captured every frame, so a camera that snaps to a new orientation has valid data for
// every direction on the very first frame. `cullCaptures` restores the reference's behaviour for
// anyone who wants the frame time back. SPLATTING still uses the reference's visibility test — that
// one is not a shortcut, it is the reference's own algorithm, and it is derived from the live camera
// forward vector so it stays correct under any rotation.
//
// ── CLICK-SPECIFIC ADAPTATIONS (documented in full, per file) ──────────────────────────────
//   * 18-layer texture array -> one 6x3 atlas; R32F radial -> packed RGBA8   [full/targets.js]
//   * per-material G-buffer twins instead of scene.overrideMaterial          [full/capture.js]
//   * entity ids are per material + a radial-discontinuity test              [full/glsl.js]
//   * the sun is the game's DirectionalLight, not the reference's orbiter    [full/capture.js]
//   * TRANSPARENTS (water, rings, beams, the placement grid) are forward-rendered on top of the
//     splats into the same low-res target. The reference has NO equivalent — it has no transparent
//     geometry at all, and splatting an animated transparent surface is not a thing texel splatting
//     does. ctx.waterPrePass() is called with the LOW-RES size so the water shader's screen-space
//     UVs line up with the target it will actually draw into.
//   * ORTHOGRAPHIC CAMERA: the game has an ortho toggle, and an eye probe is fundamentally a
//     perspective idea (one origin, rays fanning out). Under ortho the splat quads and the probes
//     are all still correct — they are world-space geometry — but the BACKGROUND ray is built as
//     normalize(unproject(pixel) - eyeOrigin), which under parallel projection is an approximation
//     rather than the true per-pixel ray. The result is a sane, slightly warped sky instead of a
//     crash. Face-mask culling also degrades to "keep every face" under ortho, since there is no
//     ray cone to cull against.
//
// ── STATE OWNERSHIP ────────────────────────────────────────────────────────────────────────
// This pipeline temporarily rewrites ctx.scene (material swaps, visible flags, scene.background,
// scene.overrideMaterial) and renderer state (autoClear, clear colour + alpha, shadowMap.autoUpdate,
// render target). Every one of those is saved on entry and restored in a `finally`, INCLUDING on the
// throw path — index.js benches a pipeline that throws and then falls back to a direct render of the
// same scene object, so it must get the scene back intact.
//
// Contract: see pipelines/index.js.

import {Targets} from "./full/targets.js";
import {SceneCapture, renderShadowMap, renderGBuffer} from "./full/capture.js";
import {
  Transition, makeFaceCameras, computeFaceMask, faceVisible, faceCount, cullThreshold,
  NUM_FACES, NUM_PROBES, PROBE_EYE, PROBE_GRID, PROBE_PREV, EYE_CULL_COS, GRID_CULL_COS,
} from "./full/probe.js";
import {
  makeFullscreenGeometry, makeEdgeMaskPass, makeLightingPass,
  makeBackgroundPass, makePostPass, SplatDraw,
} from "./full/passes.js";

const ALL_FACES = 0x3F;

/** Live knobs — read fresh EVERY FRAME, so a debugger or the console can poke them mid-run.
 *
 * probeSize vs postHeight is THE quality/cost dial. A cubemap face spans 90 degrees over probeSize
 * texels while the screen spans the camera's fov over postHeight pixels, so one texel covers about
 * (90/probeSize) / (fov/postHeight) screen pixels. The reference targets ~2.5 and derives its
 * viewport height from it: height = ceil(2.5 * PROBE_SIZE * tan(fov/2)), which at its 60-degree
 * camera is 555. That is the default here; `autoPostHeight` recomputes it from the game's LIVE fov
 * instead, which is the same rule applied to a different camera. */
export const fullTune = {
  // ── resolution ──
  // Raised from the reference's 384/555: on a ~1700px viewport that upscale read soft and low.
  // 512/720 lands ~3.3 screen px per texel at the game's 38 deg fov — chunkier than the
  // reference's 2.5 but crisp. Capture cost scales with probeSize^2 (18 draws/frame): dropping
  // back to 384/555 is the first perf move.
  probeSize: 512,          // reference PROBE_SIZE was 384
  postHeight: 720,         // reference's was ceil(2.5 * 384 * tan(30 deg)) = 555
  autoPostHeight: false,   // recompute postHeight from the live camera fov by the reference formula
  probeNear: 0.5,          // reference PROBE_NEAR 0.1 — raised for this game's world scale
  probeFar: 600,           // reference PROBE_FAR 200 — raised to match the game camera's far plane

  // ── probes / transition (probe.odin) ──
  gridStep: 1,             // reference GRID_STEP = 1m
  crossfadeTime: 0.5,      // reference BLEND_DURATION; the fade also speeds up with camera velocity
  eyeProbe: true,          // draw the eye probe at all (off = the sibling pipeline's probe set)
  prevProbe: true,         // draw the prev probe during crossfades
  eyeBias: 0.001,          // reference: eye splats get +0.001*w depth so grid wins overlaps
  eyeCullCos: EYE_CULL_COS,   // reference cos(98 deg)
  gridCullCos: GRID_CULL_COS, // reference cos(103 deg)
  fovAwareCull: true,      // widen the cone to the live half-diagonal FOV; never narrower
  cullCaptures: false,     // ON = reference capture-time face culling + idle prev skip (cheaper,
                           //      but a hard camera re-orientation shows one frame of stale layers)

  // ── shadow (shadow.odin + lighting.glsl) ──
  shadowSize: 2048,        // reference SHADOW_MAP_SIZE
  // Reference values are 0.001/0.005 NORMALISED against ITS light frustum (range 149 → 0.15/0.75
  // world units). This game's sun frustum spans near=1..far=400 (scene.js), so the same world-unit
  // bias normalises 2.7x smaller — the reference numbers verbatim would peter-pan on frame one.
  // Defaults below are the sibling pipeline's proven 0.09/0.6 world units over this 399-unit range.
  shadowBias: 0.000226,
  shadowSlope: 0.0015,

  // ── lighting / posterize (lighting.glsl) ──
  bands: 32,               // reference BANDS
  normalThresh: 0.7,       // reference OUTLINE_NORMAL_THRESH
  depthEdge: 0.03,         // relative radial jump that counts as a silhouette (click addition)
  outlineDarken: 1,        // reference OUTLINE_DARKEN, in posterisation bands
  outlineHighlight: 1,     // reference OUTLINE_HIGHLIGHT
  outlines: true,
  outlineEye: false,       // reference skips outlines on the eye probe (layers 0-5)
  sunGain: 1,              // scales the scene DirectionalLight's colour * intensity
  ambientGain: 1,          // scales the scene HemisphereLight/AmbientLight

  // ── edge mask + quad sizing (edge_mask.glsl + splat.glsl) ──
  edgeThreshold: 0.002,    // reference THRESHOLD
  expansion: 0.5,          // reference EXPANSION, in texels
  tightScale: 1.15,        // reference hsEdge = halfTexel * 1.15 + 0.0005 * tanTheta
  tightSlope: 0.0005,

  // ── atmosphere (splat.glsl / background.glsl / lighting.glsl constants) ──
  hazeDensity: 0.005,      // reference HAZE_DENSITY
  background: true,
  water: true,             // hybrid forward pass for transparents (no reference equivalent)

  // ── debug, mirroring the reference's Tab / 1-6 / 7 ──
  debugView: 0,            // 0 splat, 1 forward, 2 albedo, 3 normal, 4 radial, 5 lit, 6 edge, 7 shadow
  showFace: -1,            // -1 = the probe's whole row of 6, else 0..5 = +X -X +Y -Y +Z -Z
  showProbe: 1,            // 0 eye, 1 grid, 2 prev  (the reference's `7` key)
};

/** Shape consumed by pipelines/debug-panel.js: sliders [key,label,min,max,step],
 * checks [key,label], selects [key,label,[[value,label],...]]. Select values must be numeric —
 * the panel writes `tune[key] = +select.value`. */
export const PANEL_SPEC = {
  sliders: [
    ["probeSize",        "probe size",          64, 768, 32],
    ["postHeight",       "post height px",      120, 1080, 1],
    ["probeNear",        "probe near",          0.05, 4, 0.05],
    ["probeFar",         "probe far",           50, 1200, 10],
    ["gridStep",         "grid step wu",        0.25, 8, 0.25],
    ["crossfadeTime",    "crossfade s",         0, 2, 0.05],
    ["eyeBias",          "eye depth bias",      0, 0.01, 0.0001],
    ["eyeCullCos",       "eye cull cos",        -1, 1, 0.001],
    ["gridCullCos",      "grid cull cos",       -1, 1, 0.001],
    ["shadowBias",       "shadow bias",         0, 0.002, 0.00001],
    ["shadowSlope",      "shadow slope",        0, 0.01, 0.0001],
    ["bands",            "posterize bands",     2, 64, 1],
    ["normalThresh",     "crease dot",          0, 1, 0.01],
    ["depthEdge",        "outline thresh",      0, 0.2, 0.005],
    ["outlineDarken",    "outline darken",      0, 4, 0.25],
    ["outlineHighlight", "outline highlight",   0, 4, 0.25],
    ["edgeThreshold",    "edge (expand) thresh", 0, 0.02, 0.0005],
    ["expansion",        "quad expansion tx",   0, 2, 0.05],
    ["tightScale",       "tight fit scale",     1, 1.5, 0.01],
    ["tightSlope",       "tight fit slope",     0, 0.005, 0.0001],
    ["hazeDensity",      "haze density",        0, 0.02, 0.0005],
    ["sunGain",          "sun gain",            0, 3, 0.05],
    ["ambientGain",      "ambient gain",        0, 3, 0.05],
  ],
  checks: [
    ["eyeProbe", "eye probe"], ["prevProbe", "prev probe"], ["fovAwareCull", "fov-aware cull"],
    ["cullCaptures", "cull captures"], ["autoPostHeight", "auto post height"],
    ["outlines", "outlines"], ["outlineEye", "outline eye probe"],
    ["background", "background"], ["water", "water/transparents"],
  ],
  selects: [
    ["shadowSize", "shadow map", [[512, "512"], [1024, "1024"], [2048, "2048"], [4096, "4096"]]],
    ["debugView", "debug view", [[0, "splat"], [1, "forward"], [2, "albedo"], [3, "normal"],
                                 [4, "radial"], [5, "lit"], [6, "edge"], [7, "shadow"]]],
    ["showFace", "face (debugView>1)", [[-1, "all 6"], [0, "+X"], [1, "-X"], [2, "+Y"],
                                        [3, "-Y"], [4, "+Z"], [5, "-Z"]]],
    ["showProbe", "probe (debugView>1)", [[0, "eye"], [1, "grid"], [2, "prev"]]],
  ],
};

// debugView -> POST_FRAG uMode. 0 (splat) and 1 (forward) never reach the table.
const DEBUG_MODES = {2: 5, 3: 3, 4: 2, 5: 0, 6: 4, 7: 6};

let R = null;        // all pipeline resources; null means "not built yet, or disposed"
let lastTime = 0;

/** Per-frame cost readout, for the console. Not allocated per frame. */
export const fullStats = {
  sceneDraws: 0, splatDraws: 0, quads: 0,
  eyeFaces: 0, gridFaces: 0, prevFaces: 0, fade: 0, blending: false,
};

function build(ctx){
  const {THREE} = ctx;
  const nearFar = new THREE.Vector2(fullTune.probeNear, fullTune.probeFar);
  const quadGeometry = makeFullscreenGeometry(THREE);
  R = {
    targets: new Targets(THREE),
    capture: new SceneCapture(THREE, nearFar),
    transition: new Transition(),
    faceCams: makeFaceCameras(THREE, fullTune.probeNear, fullTune.probeFar),
    quadGeometry,
    edgePass: makeEdgeMaskPass(THREE, quadGeometry),
    lightPass: makeLightingPass(THREE, quadGeometry),
    bgPass: makeBackgroundPass(THREE, quadGeometry),
    postPass: makePostPass(THREE, quadGeometry),
    splat: new SplatDraw(THREE, fullTune.probeSize),
    nearFar,
    lastGridStep: fullTune.gridStep,
    // scratch — allocated once, never per frame
    v0: new THREE.Vector3(), v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
    eyeOrigin: new THREE.Vector3(),
    savedClear: new THREE.Color(),
    viewProj: new THREE.Matrix4(),
    sky: {zenith: new THREE.Color(), horizon: new THREE.Color(), haze: new THREE.Color()},
    bufSize: new THREE.Vector2(),
    origins: [null, null, null],     // filled per frame with live Vector3s (no allocation)
    masks: [0, 0, 0],
  };
  return R;
}

/** Allocate/reallocate anything the current tune values or canvas size demand. */
function ensure(ctx){
  const {renderer} = ctx;
  // MRT, GLSL3 and gl_InstanceID are all WebGL2. Throwing here is the INTENDED failure mode: the
  // registry benches the pipeline and the game keeps rendering normally.
  if(!renderer.capabilities.isWebGL2) throw new Error("full pipeline requires WebGL2");
  if(!R) build(ctx);

  // The atlas is 6 probeSize wide and 3 tall, so the wide axis is what has to fit.
  const maxProbe = Math.floor(renderer.capabilities.maxTextureSize / 6);
  const probeSize = Math.max(32, Math.min(maxProbe, Math.round(fullTune.probeSize)));
  if(R.targets.ensureAtlas(probeSize)) R.splat.setProbeSize(probeSize);

  R.targets.ensureShadow(Math.max(256, Math.min(4096, Math.round(fullTune.shadowSize))));

  renderer.getDrawingBufferSize(R.bufSize);
  const camera = ctx.getCamera();
  let h = Math.max(64, Math.round(fullTune.postHeight));
  if(fullTune.autoPostHeight && camera.isPerspectiveCamera){
    // post.odin's formula, applied to the LIVE camera instead of the reference's fixed 60 degrees.
    h = Math.max(64, Math.ceil(2.5 * probeSize * Math.tan(camera.fov * Math.PI / 360)));
  }
  const aspect = R.bufSize.y > 0 ? R.bufSize.x / R.bufSize.y : 16 / 9;
  R.targets.ensureLowRes(Math.round(h * aspect), h);

  R.nearFar.set(fullTune.probeNear, fullTune.probeFar);

  // A grid-step change invalidates the lattice the current origin was snapped to.
  if(R.lastGridStep !== fullTune.gridStep){
    R.lastGridStep = fullTune.gridStep;
    R.transition.reset();
  }
  return R;
}

/** Sky/haze palette derived from the scene's own background colour, so the pipeline follows the
 * game's day/night tint instead of hardcoding the reference's daytime blue. The RATIOS between
 * zenith / horizon / haze are the reference's (lighting.glsl SKY_ZENITH / SKY_HORIZON / HAZE_COLOR
 * sit at roughly 0.62x and 0.95x of each other in luminance). */
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
  zenith:  {r: 0.25, g: 0.47, b: 0.815},
  haze:    {r: 0.50, g: 0.56, b: 0.66},
};

export default {
  name: "full",

  init(ctx){ ensure(ctx); },

  resize(ctx){ if(R) ensure(ctx); },

  render(ctx){
    const {renderer, scene, THREE} = ctx;
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
    // getClearColor COPIES into the target and returns it, and later setClearColor calls do not
    // write back through it — so this scratch Color is a safe frame-long snapshot with no allocation.
    const savedClear = renderer.getClearColor(R.savedClear);

    try{
      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false;   // three's own shadow pass would re-render the scene
      scene.overrideMaterial = null;
      readSky(scene, R.sky, SKY_FALLBACK);

      camera.updateMatrixWorld();
      scene.updateMatrixWorld();
      const camPos = camera.getWorldPosition(R.v0);
      const fwd = camera.getWorldDirection(R.v1);

      // ── debug: plain forward render of the game scene (the reference's Tab -> Forward) ──
      // Reproduces the "current" pipeline exactly, so a side-by-side is one dropdown away. Every
      // piece of borrowed state goes back BEFORE the draw (including shadowMap.autoUpdate, or
      // three would skip its own shadow pass and the view would render with a stale shadow map);
      // the finally then restores it a second time, harmlessly.
      if((fullTune.debugView | 0) === 1){
        renderer.setRenderTarget(null);
        renderer.autoClear = savedAutoClear;
        renderer.shadowMap.autoUpdate = savedShadowAuto;
        scene.background = savedBackground;
        ctx.waterPrePass();
        renderer.render(scene, camera);
        return;
      }

      scene.background = null;                 // stops three force-clearing on every scene render

      // ── probe transition (probe.odin transition_update) ──
      R.transition.update(THREE, camPos, dt, fullTune.gridStep, fullTune.crossfadeTime);
      const fade = R.transition.fade;
      const blending = R.transition.blending;

      // ── probe origins: eye = live camera, grid = snapped, prev = the old snap ──
      R.eyeOrigin.copy(camPos);
      R.origins[PROBE_EYE] = R.eyeOrigin;
      R.origins[PROBE_GRID] = R.transition.gridOrigin;
      R.origins[PROBE_PREV] = R.transition.prevOrigin;

      // ── splat visibility (probe.odin compute_face_mask, called from splat.odin) ──
      // Derived from the LIVE camera forward vector every frame, which is the whole
      // rotation-correctness contract: no yaw/pitch is assumed anywhere.
      const eyeMask = fullTune.eyeProbe
        ? computeFaceMask(fwd, cullThreshold(camera, fullTune.eyeCullCos, fullTune.fovAwareCull)) : 0;
      const gridMask =
        computeFaceMask(fwd, cullThreshold(camera, fullTune.gridCullCos, fullTune.fovAwareCull));
      const prevMask = (fullTune.prevProbe && blending) ? gridMask : 0;

      // ── capture masks. Default: everything, every frame (see the file header). ──
      if(fullTune.cullCaptures){
        R.masks[PROBE_EYE] = eyeMask;
        R.masks[PROBE_GRID] = gridMask;
        R.masks[PROBE_PREV] = blending ? gridMask : 0;
      }else{
        // All six faces of every ENABLED probe, every frame — including prev while it is idle, so a
        // transition that starts next frame already has valid data at the old origin. The eyeProbe /
        // prevProbe switches are an explicit "do not use this probe at all", so an off probe is not
        // captured either; that is a user choice, not a camera-direction shortcut.
        R.masks[PROBE_EYE] = fullTune.eyeProbe ? ALL_FACES : 0;
        R.masks[PROBE_GRID] = ALL_FACES;
        R.masks[PROBE_PREV] = fullTune.prevProbe ? ALL_FACES : 0;
      }

      const probeSize = R.targets.probeSize;
      const near = fullTune.probeNear, far = fullTune.probeFar;

      // ── 1 + 2: shadow map and the 18-layer G-buffer capture ──
      R.capture.partition(scene);
      R.capture.refreshVariants();
      R.capture.hideShells();
      R.capture.beginCapture();
      renderShadowMap(renderer, scene, R.capture, sun, R.targets.shadow);
      const gbufDraws = renderGBuffer(renderer, scene, R.targets.gbuf, R.faceCams,
                                      R.origins, R.masks, probeSize, near, far);
      R.capture.endCapture();

      const gbuf = R.targets.gbuf;

      // ── 3: edge mask, one draw over all 18 cells (edge_mask.odin) ──
      {
        const u = R.edgePass.material.uniforms;
        u.uRadial.value = gbuf.texture[2];
        u.uProbeSize.value = probeSize;
        u.uThreshold.value = fullTune.edgeThreshold;
        renderer.setRenderTarget(R.targets.edge);
        R.edgePass.render(renderer);
      }

      // ── 4: lighting, one draw over all 18 cells (lighting.odin) ──
      {
        const u = R.lightPass.material.uniforms;
        u.uAlbedo.value = gbuf.texture[0];
        u.uNormal.value = gbuf.texture[1];
        u.uRadial.value = gbuf.texture[2];
        u.uShadow.value = R.targets.shadow.texture;
        u.uLightMatrix.value.copy(sun.shadow.matrix);
        // Direction TO the sun. sun.target is parented into the scene by scene.js and tracks the
        // camera, so this is a live vector, not a constant.
        u.uSunDir.value.copy(sun.getWorldPosition(R.v2))
          .sub(sun.target.getWorldPosition(R.v3)).normalize();
        u.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity * fullTune.sunGain);
        const amb = R.capture.ambient;
        if(amb && amb.isHemisphereLight){
          u.uAmbient.value.copy(amb.color).lerp(amb.groundColor, 0.5)
            .multiplyScalar(amb.intensity * fullTune.ambientGain);
        }else if(amb){
          u.uAmbient.value.copy(amb.color).multiplyScalar(amb.intensity * fullTune.ambientGain);
        }else{
          u.uAmbient.value.setRGB(0.15, 0.15, 0.2);
        }
        u.uOriginEye.value.copy(R.origins[PROBE_EYE]);
        u.uOriginGrid.value.copy(R.origins[PROBE_GRID]);
        u.uOriginPrev.value.copy(R.origins[PROBE_PREV]);
        u.uNearFar.value.copy(R.nearFar);
        u.uShadowBias.value.set(fullTune.shadowBias, fullTune.shadowSlope);
        u.uSkyZenith.value.copy(R.sky.zenith);
        u.uSkyHorizon.value.copy(R.sky.horizon);
        u.uHazeColor.value.copy(R.sky.haze);
        u.uHazeDensity.value = fullTune.hazeDensity;
        u.uShadowTexel.value = 1 / R.targets.shadowSize;
        u.uBands.value = fullTune.bands;
        u.uNormalThresh.value = fullTune.normalThresh;
        u.uDepthEdge.value = fullTune.depthEdge;
        u.uOutlineDarken.value = fullTune.outlineDarken;
        u.uOutlineHighlight.value = fullTune.outlineHighlight;
        u.uOutlines.value = fullTune.outlines ? 1 : 0;
        u.uOutlineEye.value = fullTune.outlineEye ? 1 : 0;
        u.uProbeSize.value = probeSize;
        renderer.setRenderTarget(R.targets.lit);
        R.lightPass.render(renderer);
      }

      // ── water depth pre-pass, at the LOW-RES target's size so the water shader's screen-space
      // UVs line up. It needs a real clear, so autoClear goes back on for exactly that call. ──
      if(fullTune.water){
        renderer.setClearColor(savedClear, savedAlpha);
        renderer.autoClear = true;
        ctx.waterPrePass(R.targets.lowW, R.targets.lowH);
        renderer.autoClear = false;
      }

      // ── 5 + 6: background and splat quads into the low-res target (post.odin's offscreen pass) ──
      R.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      renderer.setRenderTarget(R.targets.lowRes);
      renderer.setClearColor(R.sky.horizon, 1);
      renderer.clear(true, true, false);

      if(fullTune.background){
        // splat.odin always samples the EYE probe here, and the ray form
        // normalize(unproject(pixel) - origin) is EXACT when origin is the camera position. With the
        // eye probe switched off it falls back to the grid row and the same ray form, which is then
        // an approximation (origin up to half a grid cell away) — the sibling pipeline's behaviour.
        const row = fullTune.eyeProbe ? PROBE_EYE : PROBE_GRID;
        const u = R.bgPass.material.uniforms;
        u.uLit.value = R.targets.lit.texture;
        u.uRadial.value = gbuf.texture[2];
        u.uInvViewProj.value.copy(R.viewProj).invert();
        u.uEyeOrigin.value.copy(R.origins[row]);
        u.uHazeColor.value.copy(R.sky.haze);
        u.uNearFar.value.copy(R.nearFar);
        u.uHazeDensity.value = fullTune.hazeDensity;
        u.uProbeSize.value = probeSize;
        u.uProbeRow.value = row;
        R.bgPass.render(renderer);
      }

      let splatDraws = 0;
      {
        const u = R.splat.material.uniforms;
        u.uRadial.value = gbuf.texture[2];
        u.uEdge.value = R.targets.edge.texture;
        u.uLit.value = R.targets.lit.texture;
        u.uViewProj.value.copy(R.viewProj);
        u.uCameraPos.value.copy(camPos);
        u.uNearFar.value.copy(R.nearFar);
        u.uExpansion.value = fullTune.expansion;
        u.uTightScale.value = fullTune.tightScale;
        u.uTightSlope.value = fullTune.tightSlope;
        u.uHazeColor.value.copy(R.sky.haze);
        u.uHazeDensity.value = fullTune.hazeDensity;
        u.uFadeT.value = fade;
        u.uEyeBias.value = fullTune.eyeBias;

        // splat.odin's draw order: eye, then grid, then prev. Eye carries the +eyeBias depth push so
        // grid texels win the LESS_EQUAL test wherever the two probes see the same surface.
        const drawMasks = [eyeMask, gridMask, prevMask];
        for(let p = 0; p < NUM_PROBES; p++){
          const mask = drawMasks[p] & R.masks[p];   // never splat a layer that was not captured
          if(!mask) continue;
          u.uProbeOrigin.value.copy(R.origins[p]);
          for(let f = 0; f < NUM_FACES; f++){
            if(!faceVisible(f, mask)) continue;
            R.splat.drawLayer(renderer, p, f);
            splatDraws++;
          }
        }
      }

      // ── 7: hybrid forward pass for transparents, over the splat depth buffer ──
      if(fullTune.water){
        R.capture.beginForward();
        renderer.setRenderTarget(R.targets.lowRes);
        renderer.render(scene, camera);
        R.capture.endForward();
      }

      // ── 8: post — nearest-neighbour upscale + gamma, or a debug blit (post.odin/debug_vis) ──
      renderer.setRenderTarget(null);
      {
        const u = R.postPass.material.uniforms;
        const viewMode = fullTune.debugView | 0;
        if(viewMode >= 2){
          u.uTex.value = viewMode === 2 ? gbuf.texture[0]
                       : viewMode === 3 ? gbuf.texture[1]
                       : viewMode === 4 ? gbuf.texture[2]
                       : viewMode === 5 ? R.targets.lit.texture
                       : viewMode === 6 ? R.targets.edge.texture
                       : R.targets.shadow.texture;
          u.uMode.value = DEBUG_MODES[viewMode] ?? 1;
          if(viewMode === 7){
            u.uRect.value.set(0, 0, 1, 1);        // the shadow map is not an atlas
          }else{
            const probe = Math.max(0, Math.min(NUM_PROBES - 1, fullTune.showProbe | 0));
            const f = fullTune.showFace | 0;
            const rect = (f >= 0 && f < NUM_FACES)
              ? R.targets.layerUvRect(probe * NUM_FACES + f)
              : R.targets.probeUvRect(probe);
            u.uRect.value.set(rect[0], rect[1], rect[2], rect[3]);
          }
        }else{
          u.uTex.value = R.targets.lowRes.texture;
          u.uMode.value = 0;
          u.uRect.value.set(0, 0, 1, 1);
        }
        R.postPass.render(renderer);
      }

      fullStats.sceneDraws = gbufDraws + 1;
      fullStats.splatDraws = splatDraws;
      fullStats.quads = splatDraws * probeSize * probeSize;
      fullStats.eyeFaces = faceCount(eyeMask);
      fullStats.gridFaces = faceCount(gridMask);
      fullStats.prevFaces = faceCount(prevMask);
      fullStats.fade = fade;
      fullStats.blending = blending;
    }finally{
      R?.capture.restoreAll();
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
    R.targets.dispose();     // gbuf (3 attachments) + edge + lit + shadow + lowRes
    R.capture.dispose();     // every material variant + the shadow material, and scene restore
    R.edgePass.dispose();
    R.lightPass.dispose();
    R.bgPass.dispose();
    R.postPass.dispose();
    R.splat.dispose();       // its own InstancedBufferGeometry + material
    R.quadGeometry.dispose();
    R = null;
    lastTime = 0;
  },
};
