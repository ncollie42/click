// Owns: the three.js renderer, cameras, lights, terrain presentation, every mesh pool and ground mark, world
// projection, resize and the per-frame scene draw. Read-only over simulation state.
// ═══════════════════════════════════════════════════════════════════════════
// 3D SCENE
// The simulation lives in src/game/simulation.js and still thinks in 2D game pixels. Everything here
// is read-only over the collections and queries it exports: game (x, y) maps to world (x*S, 0, y*S)
// (see models.js for S), meshes are pooled per entity, and anything that must stay unskewed (bars,
// text, carried resources) is drawn by src/render/overlay.js instead.
//
// Ownership / data flow
//   Reads:    simulation queries and live collections — iterate and project only. Nothing in this
//             file splices, pushes or assigns into them, and nothing assigns into `state`.
//   Writes:   renderer-owned pools and meshes, the camera/view presentation holders (`view`,
//             `VIEW_TUNE`, `IND`) and visual animation state (glide, shots, hand pile). Nothing else.
//   Supplies: project() and combatTargetOnScreen() — the scene owns all camera projection/frustum
//             decisions. Overlay and simulation receive answers, never camera internals. The dependency runs
//             overlay -> scene and never back, so the overlay can never steer the camera.
//   Asks:     connect({isModalOpen}) — one host predicate the idle cursor bracket needs. Injected
//             rather than imported so this module never reaches into the host or the DOM UI.
//
// The DOM element <canvas id="overlay"> is shared by three owners, deliberately and read-only here:
// overlay.js owns its 2D context and backing-store size, the host owns its event listeners and
// classes and focus (src/main.js looks it up and hands it to input.js and hud.js), and this file
// only reads its client rect to build a raycast ray.
// ═══════════════════════════════════════════════════════════════════════════
import * as THREE from "three";
import {configurePipelines, renderFrame, resizePipeline} from "./pipelines/index.js";
import {initLightMods, applyLightingMods, syncLightMods, setToneTargets, setNightTone} from "./material-light-mods.js";
import {PAL, SWATCH, css, TOWER_TOP, TONES} from "./palette.js";
import {SUN_INTENSITY, HEMI_INTENSITY, NIGHT_SUN_SCALE, TONE_RIG, TONE_RIG_NIGHT} from "./rig.js";
import {
  S,WU,HU,gx,gz, flat, meshOf, isOutline, disposeGroup, GROUND_Y,
  makeTree, makeRock, makeDiamond, makeDrop, makeEnemy, makeCorpse,
  makeChest, makeDamageDummy, makeShowcaseProp,
  makePegWorker, makeBuilding, makeBlueprint, handMeshFor,
  outlineMat, outlineMatPx, adoptOutlineShell, releaseOutlineShell
} from "./models.js";
import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,
  CELL,GRID_COLS,GRID_ROWS,FOG,NIGHT_OVERLAY_ALPHA,
  FOOTPRINT_1x1,FOOTPRINT_3x3,
  RESOURCE_KINDS,
  WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_LEASH,
  BUILDING_TYPES,
  SUMMONING_CIRCLE,
  ENEMY_TYPES,
  FIREBALL,METEOR
} from "../game/data.js";
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCells,footprintWorldRect
} from "../game/grid.js";
import {
  TUNE, state,
  trees, rocks, diamonds, fog, fogPops, resourceDrops, chests, buildings, friendlyBrutes, controlledEnemies, damageDummies, showcaseProps, workerCorpses, particles, lightningArcs, fallingMeteors, fallingFireballs,
  fogMetadata, fogAtPoint, footprintFogFree,
  badgeAction, hoveredBuilding, captureYardOccupancy, durablePostStatus,
  canPlace, indicatorRadius, towerVariant, storageServiceRadius, workerAssignmentAt,
  mainBaseStanding,
  heldWorker, heldEnemy, heldBuilding, heldChest, heldProp, workerLoad,
  vacuumRadius,terrainAtRasterCell,terrainMetadata,terrainRaisedAtCell,
  clamp, distance, setCameraZoom, ZOOM_LIMITS
} from "../game/simulation.js";
import {LAND, TERRAIN_CELL_SIZE} from "../game/authored-map.js";
import {createGrass, grassTune, GRASS_PANEL} from "./grass.js";
import {buildModuleCatalog,SHAPE_GEOMETRY,rotateShapePoint} from "../game/terrain-modules.js";
import {solveTerrainWfc} from "../game/terrain-wfc.js";

// ── host predicates ─────────────────────────────────────────────────────────
// The one thing the scene cannot answer for itself: whether a modal owns input. Same shape as the
// simulation's connect(effects) — a record of named hooks, replaced wholesale at boot.
const HOOKS = {
  isModalOpen(){ return false; },
};
export function connect(hooks){ Object.assign(HOOKS, hooks); }

// ── runtime-tunable PRESENTATION constants (view panel) ──────────────────────
// The view debugger reassigns these while the game runs, exactly as it does the simulation's TUNE.
// They live in one mutable holder for the same reason: an imported binding cannot be reassigned by
// its importer, so a plain `let` here would break the moment the view debugger wrote one. The split
// between the two holders is by READER, not by widget: nothing below is ever read by the simulation,
// and nothing in TUNE is presentation-only.
//   handArc / shotSpeed / shotArc / shotSize — pure visuals of a flight the sim already resolved.
//   showVacuumRing — whether to DRAW the ring; its radius is the simulation's vacuumRadius(), the
//                    real reach with the drafted buff stacks already in it, not TUNE alone.
export const VIEW_TUNE = {
  handArc:2,           // world units a collected drop arcs on its way in   [slider vArc]
  showVacuumRing:true, //                                                   [slider vRing]
  shotSpeed:26,        // tower projectile travel, world units per second   [slider vShotSpeed]
  shotArc:1,           // multiplier on how much a shot lobs                [slider vShotArc]
  shotSize:1,          // projectile scale multiplier                       [slider vShotSize]
};


// ─────────────────────────────────────────────────────────── renderer & cameras
const sceneCanvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({canvas:sceneCanvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled = true;
// Plain PCF, not PCFSoft: PCFSoftShadowMap IGNORES shadow.radius, and the radius blur is what
// keeps cast skirts from reading as hard fake ellipses (test-scene round-4 finding, ported Aug 21).
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
// PAL.sky is SWATCH.shade2, the FLOOR of the shade bridge — already the night end of the palette,
// so the night tier deliberately leaves it alone: as the world falls toward shade1/shade2 the
// background stops being a void the map floats in and joins the same family. Nothing to lerp.
scene.background = new THREE.Color(PAL.sky);

// Constructor values are placeholders: placeCamera() owns fov/near/far every frame.
const persp = new THREE.PerspectiveCamera(10.75, 16/9, 0.5, 600);
const ortho = new THREE.OrthographicCamera(-1,1,1,-1,-200,600);
// Ortho by default (owner call Aug 21, after the test-scene A/B): camera3 must agree with
// view.ortho below, and the index.html vOrtho markup must agree with both (bindV boot-applies it).
let camera3 = ortho;

// Debug-owned view state. pitch 90 reproduces the original top-down framing.
// MUTABLE HOLDER, on purpose: the debugger writes view.pitch / view.yaw / … as properties, which an
// imported binding allows. `camera3` above is the one value that must be REASSIGNED, so it stays
// module-private and setOrthoCamera() is its only write path.
// fog* are presentation-only feel knobs over the fog layer below. FOG (data.js) is frozen and the
// simulation's pop records are aged against FOG.popAnimTime, so fogPopTime seeds from it as ms and
// can only ever COMPRESS the tween: a record is spliced out at age >= FOG.popAnimTime, so a longer
// visual would be cut mid-curve. syncFogPops() clamps to that ceiling.
// pitch 33 / fov 10.75: the test-scene camera solve (tools/test-scene/preset.js CAMERA — owner
// read the reference at "30-ish", settled on 33 Aug 21; near-ortho fov stabilises the sun angle
// across the frame). placeCamera() compensates dist from fov, so fov changes projection
// convergence only, never coverage — that is why the fov slider reads as subtle.
// COUPLING: view-debugger's bindV() applies the index.html slider markup defaults at boot, so
// vPitch/vFov values there must match these or they silently win.
export const view = {pitch:33, yaw:0, fov:10.75, ortho:true, orbit:false,
              heightScale:100, ghostPins:false,
              fogHeight:100, fogPopTime:FOG.popAnimTime*1000, fogPopSwell:35};

/** The vOrtho switch's single write path: flips the flag and swaps which camera renders. */
export function setOrthoCamera(on){
  view.ortho = on;
  camera3 = on ? ortho : persp;
}
/** The vShadow switch's single write path; materials must recompile when shadows toggle. */
export function setShadows(on){
  renderer.shadowMap.enabled = on;
  scene.traverse(o=>{
    if(!o.isMesh)return;
    for(const material of Array.isArray(o.material)?o.material:[o.material])
      if(material)material.needsUpdate=true;
  });
}
/** Perf isolation control. Resize remains composition-owned so the overlay follows the same box. */
export function setRenderPixelRatio(value){renderer.setPixelRatio(clamp(value,.5,2));}

export function placeCamera(){
  const cam = state.camera;
  const tx = gx(cam.x), tz = gz(cam.y);
  const p = THREE.MathUtils.degToRad(view.pitch), y = THREE.MathUtils.degToRad(view.yaw);
  // Ortho frustum matches the 2D game's coverage exactly, so clampCamera() and
  // the .1-5 zoom range carry over unchanged.
  // halfW must come from the live canvas aspect. Hardcoding 16:9 here stretches
  // world-X against world-Y on any other shape, which reads as squashed models.
  const halfH = VIEW_H/(2*cam.zoom)*S, halfW = halfH*viewAspect;
  ortho.left=-halfW; ortho.right=halfW; ortho.top=halfH; ortho.bottom=-halfH;
  ortho.updateProjectionMatrix();
  const dist = camera3===ortho ? 160 : halfH/Math.tan(THREE.MathUtils.degToRad(view.fov/2));
  // near/far track dist (test-scene lesson: a fixed 0.5 near over a hundreds-of-wu scene wastes
  // most of the depth texture, and the pixel pipeline's outline/edge passes read that texture).
  // Also what makes low fov usable at all: at fov 10.75 zoomed out, dist blows past a fixed far.
  persp.fov = view.fov; persp.near = dist*.1; persp.far = dist*3;
  persp.updateProjectionMatrix();
  const h = Math.sin(p)*dist, r = Math.cos(p)*dist;
  camera3.position.set(tx + Math.sin(y)*r, h, tz + Math.cos(y)*r);
  camera3.lookAt(tx, 0, tz);

  // Impact rattle (meteor landings). Translating the PLACED camera along its own local axes pans
  // the whole view without tilting it, so projection-based picking and the overlay stay coherent —
  // everything just shudders together. Squaring the decaying sim value front-loads the kick.
  const shake = state.screenShake || 0;
  if(shake > 0){
    const st = performance.now()/1000, amp = shake*shake*.55;
    camera3.translateX(Math.sin(st*73)*amp);
    camera3.translateY(Math.cos(st*91)*amp*.6);
  }

  // The shadow frustum has to track zoom, or zooming out drops every shadow
  // outside it and the map goes flat.
  const span = clamp(halfW*1.5, 14, 120);   // halfW, not halfH — the view is 16:9
  const sc = sun.shadow.camera;
  sc.left=-span; sc.right=span; sc.top=span; sc.bottom=-span;
  sc.updateProjectionMatrix();
}

let viewAspect = 16/9;

/**
 * Resize the WebGL side to the scene canvas's live CSS box and re-place the camera.
 * Returns that box so the caller can hand the same numbers to the overlay's own resize, or null
 * when the canvas has no layout yet (nothing was changed in that case).
 */
export function resizeRenderer(){
  const r = sceneCanvas.getBoundingClientRect();
  if(!r.width||!r.height)return null;
  renderer.setSize(r.width, r.height, false);
  viewAspect = r.width/r.height;
  persp.aspect = viewAspect;
  placeCamera();
  {const s=renderer.getDrawingBufferSize(new THREE.Vector2());resizePipeline(s.x,s.y);}
  return {width:r.width, height:r.height};
}

// ── Pointer data flow (producer end) ──
// The pointer surface is the overlay canvas: it is the element src/input.js listens on, so its client
// rect is the one that turns a client point into normalised device coordinates.
// Format out: world-space simulation pixels, produced by raycasting the ground plane — the 3D
// equivalent of the old inverse camera transform, correct at any pitch/yaw.
const pointerSurface = document.getElementById("overlay");
const _ndc=new THREE.Vector2(), _ray=new THREE.Raycaster(), _ghit=new THREE.Vector3();
const _groundPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
export function groundFromEvent(event){
  const r=pointerSurface.getBoundingClientRect();
  _ndc.x=((event.clientX-r.left)/r.width)*2-1;
  _ndc.y=-((event.clientY-r.top)/r.height)*2+1;
  _ray.setFromCamera(_ndc,camera3);
  if(!_ray.ray.intersectPlane(_groundPlane,_ghit))return null;
  return {x:_ghit.x/S,y:_ghit.z/S};
}

// ── scene -> overlay projection boundary ──
// The ONE function that converts world space into overlay space. overlay.js imports it and nothing
// else; no screen coordinate is computed anywhere but here, so a camera change can never leave the
// two layers disagreeing about where a thing is.
const _pv = new THREE.Vector3(),_viewProjection=new THREE.Matrix4(),_viewFrustum=new THREE.Frustum(),_targetSphere=new THREE.Sphere();
/** game (x,y) plus height in game px -> overlay canvas coords (960x540). */
export function project(x, y, hpx=0){
  _pv.set(gx(x), hpx*S, gz(y)).project(camera3);
  return {x:(_pv.x*.5+.5)*VIEW_W, y:(-_pv.y*.5+.5)*VIEW_H, depth:_pv.z};
}
/** Actual active-camera frustum test injected into simulation for screen-wide spells. The sphere
 * includes a target whose model intersects an edge even when its ground center is just outside. */
export function combatTargetOnScreen(target){
  const size=target.combatKind==="damage-dummy"?1:ENEMY_TYPES[target.type]?.size||1,radius=24*size*S;
  camera3.updateMatrixWorld();_viewProjection.multiplyMatrices(camera3.projectionMatrix,camera3.matrixWorldInverse);_viewFrustum.setFromProjectionMatrix(_viewProjection);
  _targetSphere.center.set(gx(target.x),radius*.75,gz(target.y));_targetSphere.radius=radius;
  return _viewFrustum.intersectsSphere(_targetSphere);
}

// ─────────────────────────────────────────────────────────── lights
// The whole day rig (hemi pair+intensity, sun az/el/intensity) is the test-scene owner solve
// ported verbatim (tools/test-scene/preset.js SUN/HEMI, Aug 21): flat-ground sun term
// S = 3.21·sin(60°)/π = 0.885, warm hemi 0.60. The old rig (sun 1.1 @ az 142/el 54.5, cool hemi
// 0.5) ran the world ~2.45x darker in up-facing linear luma — models.js GAME_* mirrors this rig
// and GAME_EXPOSURE was re-scaled by exactly that ratio; change the two files together.
const sky = new THREE.HemisphereLight(PAL.skyLight, PAL.bounce, HEMI_INTENSITY);
scene.add(sky);
const sun = new THREE.DirectionalLight(PAL.sunDay, 1.5);
// The two key-light colours drawScene lerps between (in three's linear working space, which is the
// space rig.js's tone solves are written in). The hemi pair is NOT part of the day/night lerp —
// see the NIGHT block in rig.js for why every mirror of HEMI_INTENSITY depends on that.
const SUN_DAY_COLOR = new THREE.Color(PAL.sunDay), SUN_NIGHT_COLOR = new THREE.Color(PAL.sunNight);
// The key light's direction as az/el (az 0 = +X/screen-right, positive toward +Z; el up).
// az 0 / el 60 = the test-scene owner default: high sun from screen-right, short skirts.
// The R panel's "camera / sun" section mutates this. Day/night still owns intensity/colour.
const SUN_OFFSET_DIST = Math.hypot(26, 46, 20);
const _sunDirScratch = new THREE.Vector3();
const sunPose = {az: 0, el: 60};
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
// Material-stage light mods (material-light-mods.js): analytic cloud shade + the toon ramp,
// injected into every Lambert/Toon material each frame in drawScene. The ramp is the round-5
// audition's shape re-anchored to THIS rig's sun elevation (sin 60° = 0.866) — the band
// holding flat-ground NdotL carries exactly that value, so un-ramped and ramped flat ground
// match and the palette work survives. Terrain and fog opt out via userData.noToonRamp.
initLightMods(THREE, {rampSteps: 32, rampLevels: [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,   // dotNL < 0
  0.22, 0.22, 0.22, 0.22, 0.22,                     // terminator (dotNL 0–0.3125)
  0.55, 0.55, 0.55, 0.55, 0.55,                     // low-mid   (0.3125–0.625)
  0.866, 0.866, 0.866, 0.866,                       // anchor = sin(60°) (0.625–0.875)
  1.0, 1.0,                                         // crown (0.875–1)
]});
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.035;
// PCF blur kernel. 8 → 3 (Aug 22): the 8 came from the test scene, when shade was whatever the
// hemi happened to produce and a wide blur hid the transition. Shade is now an AUTHORED swatch
// (TONES.*), so the penumbra is a straight ramp between two palette colours — a wide one just
// smears in-between tones the quantizer then has to band. 3 keeps a 1-2 px feather at gameplay
// zoom (the reference's canopy shadows are crisp with a hint of softness) without the stair-step
// aliasing radius 0-1 gives on a 2048 map. Live slider stays (R panel "shadow blur").
sun.shadow.radius = 3;
scene.add(sun, sun.target);

// ─────────────────────────────────────────────────────────── terrain
// PATCH MAP (Aug 22): the meadow's two-tone patches live in a map-sized, NEAREST-filtered texture
// at PATCH_PX_PER_WU texels per wu, baked from groundColorInto — the same law the blades sample.
// Before this the patch rode the VERTEX colour and interpolated across the 2-wu WFC cells, which
// blurred the hard edge to mush at gameplay zoom. Texel = the ABSOLUTE meadow colour (green1 or
// green0); the vertex colour is only the per-cell tint as a RATIO to PAL.grass, so base cells
// render the texel exactly and the tone solve (albedo = green1) stays valid. 96x64 wu x 4 = 384x256
// RGBA = 393 KiB; rebaked with the terrain when groundTune changes (groundKey).
const PATCH_PX_PER_WU=4;
const PATCH_W=Math.max(1,Math.round(WU*PATCH_PX_PER_WU)),PATCH_H=Math.max(1,Math.round(HU*PATCH_PX_PER_WU));
const patchPixels=new Uint8Array(PATCH_W*PATCH_H*4);
const GRASS_TEXTURE_BYTES=patchPixels.byteLength;
const grassTex=new THREE.DataTexture(patchPixels,PATCH_W,PATCH_H,THREE.RGBAFormat,THREE.UnsignedByteType);
grassTex.magFilter=grassTex.minFilter=THREE.NearestFilter;grassTex.generateMipmaps=false;grassTex.colorSpace=THREE.SRGBColorSpace;
grassTex.flipY=false;   // uv.v = 1 - z/HU (pushTopPolygon), so texel row r ↔ z = HU·(1 - (r+.5)/PATCH_H)
const landMat=flat(0xffffff,{map:grassTex,vertexColors:true});
// The meadow's authored tones (palette.js TONES.meadow), solved into the material's direct/indirect
// tints by material-light-mods. Both rigs come from rig.js — the same numbers the lights below use,
// and TONES.meadow.night is the swatch pair the clock lerps to (drawScene's uLmNight).
setToneTargets(landMat,{...TONES.meadow,rig:TONE_RIG,nightRig:TONE_RIG_NIGHT});
// Terrain stays SMOOTH under the toon ramp (measured in the test-scene audition: banding the
// ground caps its only highlights and draws contour rings). Cloud shade still applies to it.
landMat.userData.noToonRamp=true;
// ── SOIL on the wear field (Aug 22) ─────────────────────────────────────────────────────────
// The wear field (see "wear field" below: base, building footprints, node clearings, trample)
// only SHRANK blades — the ground under them stayed green. Now the terrain fragment takes
// PAL.soil wherever wear crosses groundTune.soilAt, HARD-edged like the meadow's two tones.
// WHY a shader sample and not a bake into the patch map: trample moves at ~20 Hz and the patch
// map is 384x256 RGBA — rebaking it per tick to recolour a few hundred texels is pure waste, and
// a static-stamps-only bake would drop the trample paths, which are the part that moves.
// ACCEPTED SHORTCUT, documented: the tone solve above assumes the texel is green1, so a soil texel
// renders soil × (green1_lit / green1) = exactly PAL.soil in full sun, and soil × green4/green1 in
// shade (lands wood2 — the swatch the shade SHOULD be, checked with scripts/palette-snap.mjs).
// Soil is a small fraction of the meadow, so it does not earn a second material with its own solve.
// Chaining is safe: material-light-mods' patch calls this prior hook first, then does its own
// replaces on the result.
const landSoil={
  uLandWear:{value:null},                       // assigned once wearTex exists (wear field section)
  uLandSoil:{value:new THREE.Color(PAL.soil)},  // THREE.Color uploads LINEAR, which is what diffuseColor is
  uLandSoilAt:{value:0},                        // synced from groundTune.soilAt every frame
};
landMat.onBeforeCompile=shader=>{
  Object.assign(shader.uniforms,landSoil);
  shader.fragmentShader=shader.fragmentShader
    .replace("#include <common>","#include <common>\nuniform sampler2D uLandWear;\nuniform vec3 uLandSoil;\nuniform float uLandSoilAt;")
    // After color_fragment, so neither the patch texel nor the per-cell vertex tint survives on soil.
    .replace("#include <color_fragment>",`#include <color_fragment>
{
  // wearTex is flipY=false with texel row ty holding z = ty+0.5, while the terrain's uv.y is
  // 1 - z/HU (pushTopPolygon) — hence the v flip. Its LINEAR filter is the clearing's rim, and
  // step() turns that rim into one hard contour instead of a gradient.
  float landWear = texture2D( uLandWear, vec2( vMapUv.x, 1.0 - vMapUv.y ) ).r;
  diffuseColor.rgb = mix( diffuseColor.rgb, uLandSoil, step( uLandSoilAt, landWear ) );
}`);
};
const REGION_COLORS={forest:new THREE.Color(PAL.regionForest),rocky:new THREE.Color(PAL.regionRocky),open:new THREE.Color(PAL.regionOpen),coast:new THREE.Color(PAL.cliff)};
// ── ground colour law: ONE function for the terrain mesh and the grass blades ──────────────
// Ported from the test scene (tools/test-scene/terrain.js groundColorInto): blades sample the
// host's own ground colour so the meadow stays continuous across blades and floor. Inputs:
//   · cell tint — the per-dual-cell WFC variant tint (tintFor below), recorded into
//     terrainTintMap by rebuildTerrainPresentation so meadowSample can read it;
//   · a SPARSE bright patch (grassBright) gated on a slow value noise — gate opens at 0.55,
//     saturates at 0.80 (~15%/~2% of the field). Wide gates lift the whole meadow (measured there).
// Coordinates are WORLD UNITS (gx/gz space); the noise period is 120 wu like the test scene.
// Second meadow tone = PAL.grassAlt, the test scene's solved bright patch. Has to be a REAL
// second colour — a +16%-toward-white lerp averaged ~3% L over the field and vanished under the
// 37-band quantizer (measured Aug 21). Strength/gate live in groundTune (R panel "ground").
const GRASS_BRIGHT=new THREE.Color(PAL.grassAlt);
// Aug 22 (owner, after t3ssel8r's imgur write-up): the meadow is TWO flat tones with a HARD edge —
// big painted patches of green0 on green1 — and the blades (which sample this same law) break the
// boundary into grass texture. Soft noise blends read as mush under the band quantizer.
export const groundTune={
  patchStrength:1,   // 0..1 lerp toward GRASS_BRIGHT inside a patch
  patchOpen:.5,      // noise tone where the patch gate opens (~40% of the field above it)
  patchWidth:.03,    // tone span from open to saturated — near-zero = hard 2-tone edge
  patchScale:18,     // wu per noise cell (second octave at half this). Map is 96x64 wu — 160 was ONE
                     // cell for the whole meadow (no patches at all, Aug 22 preview); 18 ≈ reference
  // Wear value at which the terrain flips from grass to PAL.soil (the landMat patch above).
  // NOT part of groundKey — shader-only, no terrain rebuild. .55 sits above a moment's trample
  // (grassTune.trampleRate .9/s toward cap .75) so only a real path or a permanent stamp goes bare;
  // 1 turns soil off entirely.
  soilAt:.85,        // only building/base stamps (peak 1) paint soil; node clearings (.7) and trample never do
};
const GROUND_PANEL={sliders:[["patchStrength","patch strength",0,1,.05],["patchOpen","patch gate open",.3,.8,.01],
  ["patchWidth","patch gate width",.05,.5,.01],["patchScale","patch scale wu",30,300,5],
  ["soilAt","soil at wear",.2,1,.05]],
  tips:{patchStrength:"rebuilds terrain + meadow on change: blend toward the bright second grass tone inside patches",
        soilAt:"wear value where bare ground turns to PAL.soil — above .7 only building/base footprints qualify; 1 = never"}};
const groundKey=()=>`${groundTune.patchStrength},${groundTune.patchOpen},${groundTune.patchWidth},${groundTune.patchScale}`;
function hashWU(ix,iz,seed){let h=(ix*374761393+iz*668265263+seed*1442695041)|0;h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967296;}
function valueNoise(x,z,seed){
  const ix=Math.floor(x),iz=Math.floor(z),fx=x-ix,fz=z-iz,ux=fx*fx*(3-2*fx),uz=fz*fz*(3-2*fz);
  const a=hashWU(ix,iz,seed),b=hashWU(ix+1,iz,seed),c=hashWU(ix,iz+1,seed),d=hashWU(ix+1,iz+1,seed);
  return a+(b-a)*ux+(c-a)*uz+(a-b-c+d)*ux*uz;
}
// Domain-warped value noise: plain grid noise gives square-ish lobes; warping the sample point by
// a second noise bends the patch outlines into the organic shapes of the reference meadow.
function patchTone(x,z,seed){
  const L=groundTune.patchScale;
  const u=x/L,v=z/L;
  const wx=(valueNoise(u*.7+11.1,v*.7-4.2,seed+5)-.5)*1.4, wz=(valueNoise(u*.7-6.3,v*.7+8.8,seed+9)-.5)*1.4;
  return .6*valueNoise(u+wx-3.7,v+wz+5.2,seed)+.4*valueNoise((u+wx)*2+1.3,(v+wz)*2-2.9,seed+17);
}
/** Cell tint → ground albedo at (x,z) wu, written into `out`. */
function groundColorInto(out,cellTint,x,z,seed){
  const t=patchTone(x,z,seed);
  const gate=Math.max(0,Math.min(1,(t-groundTune.patchOpen)/groundTune.patchWidth));
  return out.copy(cellTint).lerp(GRASS_BRIGHT,gate*groundTune.patchStrength);
}
// Per-dual-cell tint, refreshed by rebuildTerrainPresentation. Dual cell (dx,dy) covers world px
// [(dx-1)*CELL,dx*CELL) — the +1 in the lookup is that offset. Raised cells overwrite ground.
let terrainTintMap={cols:0,rows:0,rgb:new Float32Array(0),has:new Uint8Array(0)};
const GRASS_BASE=new THREE.Color(PAL.grass);
/** Bake the patch map: every texel = groundColorInto at its world position over the BASE tint. */
function bakePatchMap(seed){
  const c=new THREE.Color();
  for(let r=0;r<PATCH_H;r++){
    const z=HU*(1-(r+.5)/PATCH_H);
    for(let q=0;q<PATCH_W;q++){
      const x=(q+.5)/PATCH_PX_PER_WU;
      groundColorInto(c,GRASS_BASE,x,z,seed);
      const i=(r*PATCH_W+q)*4;
      // THREE.Color holds LINEAR floats; the texture is declared sRGB, so encode on the way in.
      patchPixels[i]=Math.round(linToSrgb(c.r)*255);
      patchPixels[i+1]=Math.round(linToSrgb(c.g)*255);patchPixels[i+2]=Math.round(linToSrgb(c.b)*255);patchPixels[i+3]=255;
    }
  }
  grassTex.needsUpdate=true;
}
const linToSrgb=v=>v<=.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-.055;
const shoreMat=flat(PAL.cliff,{side:THREE.DoubleSide});

// ── water: depth-foam shader (winner of the map-editor audition; see tools/map-editor water select) ──
// A per-frame depth pre-pass of terrain-only geometry measures water thickness per
// pixel: animated foam where water meets shore, an exp() shallow→deep gradient below,
// small vertex waves on top. Shore walls drop to SHORE_BOTTOM and a sand floor sits at
// the same depth so thickness stays finite and the gradient runs continuously — without
// the floor, view rays escaping past wall bottoms snap the color to full deep in a hard
// line. Only meshes on WATER_DEPTH_LAYER feed the pre-pass, so props, drops, and UI
// overlays can never smudge foam into the water.
const WATER_Y=-1.05,SHORE_BOTTOM=WATER_Y-4.6,NO_RAYCAST=()=>{};
const WATER_DEPTH_LAYER=1;
const WATER_MARGIN=60;               // detailed water mesh reaches this far beyond the map
const waterUniforms={
  uTime:{value:0},uLight:{value:1},
  uAmp:{value:.16},uFoamMul:{value:1},uFade:{value:.45},   // slider values locked in the editor audition
  uDepth:{value:null},uResolution:{value:new THREE.Vector2(1,1)},
  uNear:{value:.5},uFar:{value:600},uOrtho:{value:0},
  uShallow:{value:new THREE.Color(PAL.waterShallow)},uDeep:{value:new THREE.Color(PAL.waterDeep)},
  uFoam:{value:new THREE.Color(PAL.waterFoam)},uSun:{value:new THREE.Vector3(.35,.85,.3).normalize()},
};
// The water's two palette tiers. drawScene lerps the three uniforms between them on the day/night
// phase — the shader is unlit, so this IS its night lighting (docs/water.md, Aug 22).
const WATER_DAY={shallow:new THREE.Color(PAL.waterShallow),deep:new THREE.Color(PAL.waterDeep),foam:new THREE.Color(PAL.waterFoam)};
const WATER_NIGHT={shallow:new THREE.Color(PAL.waterShallowNight),deep:new THREE.Color(PAL.waterDeepNight),foam:new THREE.Color(PAL.waterFoamNight)};
const waterMat=new THREE.ShaderMaterial({
  transparent:true,depthWrite:false,uniforms:waterUniforms,
  vertexShader:`
    uniform float uTime,uAmp;
    varying vec3 vWorld;
    varying float vViewZ;
    float waveHeight(vec2 p,float t){
      return uAmp*(.45*sin(p.x*.16+t*1.2)
        +.3*sin(p.x*.11+p.y*.13-t*.8)
        +.25*sin(-.42*p.x+.38*p.y+t*2.0)
        +.3*sin(p.x*.9+p.y*.75+t*2.4));
    }
    void main(){
      vec4 world=modelMatrix*vec4(position,1.0);
      world.y+=waveHeight(world.xz,uTime);
      vWorld=world.xyz;
      vec4 view=viewMatrix*world;
      vViewZ=view.z;
      gl_Position=projectionMatrix*view;
    }`,
  fragmentShader:`
    #include <packing>
    // highp is load-bearing: samplers default to lowp, and ANGLE (Chrome) honors that on
    // depth reads, quantizing thickness into visible contour bands. Firefox's GL happens
    // to give fp32 either way, which is why the banding was Chrome-only.
    uniform highp sampler2D uDepth;
    uniform vec2 uResolution;
    uniform float uNear,uFar,uTime,uFoamMul,uFade,uLight,uOrtho;
    uniform vec3 uShallow,uDeep,uFoam,uSun;
    varying vec3 vWorld;
    varying float vViewZ;
    void main(){
      float sceneDepth=texture2D(uDepth,gl_FragCoord.xy/uResolution).x;
      float sceneViewZ=uOrtho>.5
        ? orthographicDepthToViewZ(sceneDepth,uNear,uFar)
        : perspectiveDepthToViewZ(sceneDepth,uNear,uFar);
      float thickness=max(vViewZ-sceneViewZ,0.0);
      vec3 facetNormal=normalize(cross(dFdx(vWorld),dFdy(vWorld)));
      if(facetNormal.y<0.0)facetNormal=-facetNormal;
      float light=.5+.6*clamp(dot(facetNormal,uSun),0.0,1.0);
      vec3 color=mix(uShallow,uDeep,1.0-exp(-thickness*uFade))*light;
      float ripple=.5+.5*sin(thickness*6.0-uTime*2.2+(vWorld.x+vWorld.z)*.4);
      // 4.5, not 1.8 (Aug 22): the shore walls drop straight to SHORE_BOTTOM, so the basin has no
      // shelf and thickness jumps from 0 to ~7 wu within a couple of pixels — the exp() gradient
      // above therefore lands on uDeep EVERYWHERE (measured: 100% blue2 across the whole body) and
      // the blue ramp's shallow step was never on screen. The ripple-gated foam is the only term
      // with a usable domain near the shore, so IT carries the shallow band: partial blue0 coverage
      // over blue2 reads as blue1 in the middle. The hard rim (second term) is unchanged.
      float foam=(smoothstep(4.5,.08,thickness)*smoothstep(.3,.8,ripple)
        +smoothstep(.45,.04,thickness))*uFoamMul;
      color=mix(color,uFoam,clamp(foam,0.0,1.0));
      gl_FragColor=vec4(color*uLight,clamp(.6+thickness*.12,0.0,.93));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const WATER_SEGS_X=200,WATER_SEGS_Y=Math.round(WATER_SEGS_X*(HU+2*WATER_MARGIN)/(WU+2*WATER_MARGIN));
const water=new THREE.Mesh(new THREE.PlaneGeometry(WU+2*WATER_MARGIN,HU+2*WATER_MARGIN,WATER_SEGS_X,WATER_SEGS_Y),waterMat);
water.rotation.x=-Math.PI/2;water.position.set(WU/2,WATER_Y,HU/2);water.raycast=NO_RAYCAST;scene.add(water);
// Sand floor at shore-wall depth: read through the shallows, keeps thickness finite.
const waterFloor=meshOf(new THREE.PlaneGeometry(WU+2*WATER_MARGIN,HU+2*WATER_MARGIN),flat(PAL.waterFloor),false,false);
waterFloor.rotation.x=-Math.PI/2;waterFloor.position.set(WU/2,SHORE_BOTTOM,HU/2);
waterFloor.raycast=NO_RAYCAST;waterFloor.layers.enable(WATER_DEPTH_LAYER);scene.add(waterFloor);
// Horizon fill beyond the detailed mesh; sits under the floor and reads as deep water.
const waterFar=meshOf(new THREE.PlaneGeometry(WU*5,HU*6),flat(PAL.waterFar),false,false);
waterFar.rotation.x=-Math.PI/2;waterFar.position.set(WU/2,SHORE_BOTTOM-1,HU/2);
waterFar.raycast=NO_RAYCAST;waterFar.layers.enable(WATER_DEPTH_LAYER);scene.add(waterFar);

// Live tuning/debug surface (view-debugger + headless harnesses).
export const waterDebug={
  uniforms:waterUniforms,
  layerMasks:()=>({top:terrainTop?.layers.mask,skirts:shorelineSkirts?.layers.mask,floor:waterFloor.layers.mask,far:waterFar.layers.mask,camera:camera3.layers.mask}),
};

let waterDepthTarget=null,waterPrepassEnabled=true;
const waterDepthOverride=new THREE.MeshBasicMaterial();
const _waterBufSize=new THREE.Vector2();
/** Diagnostic isolation switch: disabled water keeps the last depth sample, intentionally. */
export function setWaterPrepass(on){waterPrepassEnabled=!!on;}
/** Optional width/height: a pipeline rendering the scene into an offscreen target passes that
 * target's size so the water shader's gl_FragCoord/uResolution UVs stay aligned. Defaults to the
 * canvas drawing buffer (the direct-draw path). */
function waterPrePass(width,height){
  if(!waterPrepassEnabled)return;
  const size=width?_waterBufSize.set(width,height):renderer.getDrawingBufferSize(_waterBufSize);
  if(!waterDepthTarget||waterDepthTarget.width!==size.x||waterDepthTarget.height!==size.y){
    waterDepthTarget?.depthTexture?.dispose();waterDepthTarget?.dispose();
    waterDepthTarget=new THREE.WebGLRenderTarget(size.x,size.y,{depthTexture:new THREE.DepthTexture(size.x,size.y)});
    waterUniforms.uDepth.value=waterDepthTarget.depthTexture;
  }
  waterUniforms.uResolution.value.copy(size);
  waterUniforms.uNear.value=camera3.near;waterUniforms.uFar.value=camera3.far;
  waterUniforms.uOrtho.value=camera3.isOrthographicCamera?1:0;
  waterUniforms.uTime.value=(performance.now()/1000)%100000;
  const layerMask=camera3.layers.mask,shadowAuto=renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate=false;
  camera3.layers.set(WATER_DEPTH_LAYER);
  scene.overrideMaterial=waterDepthOverride;
  renderer.setRenderTarget(waterDepthTarget);
  renderer.render(scene,camera3);
  renderer.setRenderTarget(null);
  scene.overrideMaterial=null;
  camera3.layers.mask=layerMask;
  renderer.shadowMap.autoUpdate=shadowAuto;
}

// ─────────────────────────────────────────────────────────── placement grid
const GRID_Y=.015;           // world units above the land top: enough to win the depth test
const GRID_OPACITY=.24;      // deliberately faint; drawScene() fades it further at night
const gridMat=new THREE.LineBasicMaterial({color:PAL.grid,transparent:true,opacity:GRID_OPACITY,depthWrite:false});
let terrainTop=null,shorelineSkirts=null,terrainGrid=null,builtTerrainRevision=-1,builtGridSignature="";
const staticBuildStats={terrainBuilds:0,terrainDisposals:0,gridBuilds:0,gridDisposals:0};

function geometryWith(positions,uvs=null,colors=null){
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  if(uvs)geometry.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));
  if(colors)geometry.setAttribute("color",new THREE.Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();geometry.computeBoundingSphere();
  return geometry;
}
function removeTerrainObject(object,kind="terrain"){
  if(!object)return;scene.remove(object);object.geometry.dispose();
  if(kind==="grid")staticBuildStats.gridDisposals++;else staticBuildStats.terrainDisposals++;
}
function placementBlockerSignature(metadata){
  // canPlace() deliberately computes occupancy from live arrays. Mirror only its invalidation inputs
  // here, then run the authoritative query when one changes; this avoids 1,600 full scans per frame.
  const keyed=(items,extra)=>items.map(item=>`${item.x},${item.y},${extra(item)}`).join(";");
  return [metadata.revision,
    keyed(trees,item=>item.stump<=0?1:0),keyed(rocks,item=>item.depleted<=0?1:0),keyed(diamonds,item=>item.depleted<=0?1:0),
    keyed(buildings,item=>item.type),keyed(showcaseProps,item=>`${item.footprint.w}x${item.footprint.h}`),keyed(chests,item=>`${item.footprint.w}x${item.footprint.h}`)
  ].join("|");
}
function rebuildPlacementGrid(metadata){
  const signature=placementBlockerSignature(metadata);if(signature===builtGridSignature)return;
  const eligible=Array(GRID_COLS*GRID_ROWS).fill(false),at=(x,y)=>x>=0&&y>=0&&x<GRID_COLS&&y<GRID_ROWS&&eligible[y*GRID_COLS+x];
  for(let cy=0;cy<GRID_ROWS;cy++)for(let cx=0;cx<GRID_COLS;cx++){
    const center=cellToWorld(cx,cy);eligible[cy*GRID_COLS+cx]=canPlace(center.x,center.y,null);
  }
  const grid=[],edge=(ax,az,bx,bz,lift)=>grid.push(gx(ax),GRID_Y+lift,gz(az),gx(bx),GRID_Y+lift,gz(bz));
  for(let cy=0;cy<GRID_ROWS;cy++)for(let cx=0;cx<GRID_COLS;cx++){
    if(!at(cx,cy))continue;
    const lift=terrainRaisedAtCell(cx,cy)?RAISED_TOP:0;
    const rect=footprintWorldRect(cx,cy,FOOTPRINT_1x1),x0=rect.x,x1=rect.x+rect.w,z0=rect.y,z1=rect.y+rect.h;
    // North/west own shared interior edges; east/south close only exposed perimeters. Each line is
    // therefore emitted once, avoiding doubled alpha where two eligible cells touch.
    edge(x0,z0,x1,z0,lift);edge(x0,z0,x0,z1,lift);
    if(!at(cx+1,cy))edge(x1,z0,x1,z1,lift);
    if(!at(cx,cy+1))edge(x0,z1,x1,z1,lift);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(grid,3));
  const nextGrid=new THREE.LineSegments(geometry,gridMat);nextGrid.castShadow=nextGrid.receiveShadow=false;nextGrid.renderOrder=-1;
  removeTerrainObject(terrainGrid,"grid");terrainGrid=nextGrid;scene.add(terrainGrid);builtGridSignature=signature;staticBuildStats.gridBuilds++;
}
// ── WFC terrain presentation ──
// The game renders the same dual-grid module terrain as the map editor preview:
// authored 32px cells become chamfered marching-squares tops with shoreline and
// cliff walls, selected by the shared WFC solver from the installed map seed.
// Gameplay is untouched — placement/movement still query the flat 16px raster;
// the raised layer is one fixed presentational elevation.
const GROUND_CATALOG=buildModuleCatalog({layer:"ground"}),RAISED_CATALOG=buildModuleCatalog({layer:"raised"});
const GROUND_SALT=0x970a11,RAISED_SALT=0x5a15ed;   // match the editor preview so looks agree
export const RAISED_TOP=1.2;                       // world units above ground tops
export function terrainLiftAt(x,y){const cell=worldToCell(x,y);return terrainRaisedAtCell(cell.cx,cell.cy)?RAISED_TOP:0;}

// The solver reads authored-cell resolution: each placement cell's land bit comes from
// the raster cell containing its center, so painted cells and modules agree 1:1.
function authoredCellGrid(metadata){
  const land=new Uint8Array(GRID_COLS*GRID_ROWS),raised=new Uint8Array(GRID_COLS*GRID_ROWS);
  for(let cy=0;cy<GRID_ROWS;cy++)for(let cx=0;cx<GRID_COLS;cx++){
    const tx=Math.min(2*cx,metadata.terrainCols-1),ty=Math.min(2*cy,metadata.terrainRows-1);
    land[cy*GRID_COLS+cx]=terrainAtRasterCell(tx,ty)===LAND?1:0;
    raised[cy*GRID_COLS+cx]=terrainRaisedAtCell(cx,cy)?1:0;
  }
  return {width:GRID_COLS,height:GRID_ROWS,land,raised};
}

let builtGroundKey="";
function rebuildTerrainPresentation(){
  const metadata=terrainMetadata();
  if(metadata.revision!==builtTerrainRevision||groundKey()!==builtGroundKey){
    builtGroundKey=groundKey();
    bakePatchMap(metadata.seed??0);
    const grid=authoredCellGrid(metadata),seed=metadata.seed??0;
    const solves=[
      {solve:solveTerrainWfc({doc:grid,catalog:GROUND_CATALOG,layer:"ground",seed,salt:GROUND_SALT}),topY:0,bottomY:SHORE_BOTTOM},
      {solve:solveTerrainWfc({doc:grid,catalog:RAISED_CATALOG,layer:"raised",seed,salt:RAISED_SALT}),topY:RAISED_TOP,bottomY:0},
    ];
    for(const {solve} of solves)if(solve.status!=="solved")throw new Error(`terrain WFC ${solve.layer} contradiction with the complete module catalog`);
    const top=[],uv=[],colors=[],skirts=[],tint=new THREE.Color();
    {const cols=grid.width+1,rows=grid.height+1;
     terrainTintMap={cols,rows,rgb:new Float32Array(cols*rows*3),has:new Uint8Array(cols*rows)};}
    // Vertex tints multiply the shared grass texture, exactly like the old per-cell tinting:
    // full-tile variants vary the meadow tone, edge modules keep the coast tint, raised reads lighter.
    const tintFor=(layer,shape,variant)=>{
      tint.setHex(PAL.grass);
      if(shape!=="full")tint.lerp(REGION_COLORS.coast,layer==="raised"?.16:.28);
      else if(variant==="mottled")tint.lerp(REGION_COLORS.forest,.16);
      else if(variant==="scrub")tint.lerp(REGION_COLORS.open,.2);
      else if(variant==="rocky")tint.lerp(REGION_COLORS.rocky,.18);
      if(layer==="raised")tint.lerp(new THREE.Color(0xffffff),.12);
      return tint;
    };
    const pushTopPolygon=(points,y,color)=>{
      let area=0;
      for(let i=0;i<points.length;i++){const [ax,az]=points[i],[bx,bz]=points[(i+1)%points.length];area+=ax*bz-bx*az;}
      const ordered=area>0?[...points].reverse():points;
      for(let i=1;i<ordered.length-1;i++)for(const [px,pz] of [ordered[0],ordered[i],ordered[i+1]]){
        // Vertex colour = cell tint as a ratio to the base, so the patch-map texel IS the colour.
        top.push(px,y,pz);uv.push(px/WU,1-pz/HU);
        colors.push(color.r/GRASS_BASE.r,color.g/GRASS_BASE.g,color.b/GRASS_BASE.b);
      }
    };
    const pushWallSegment=([[ax,az],[bx,bz]],yTop,yBottom)=>skirts.push(
      ax,yTop,az,bx,yTop,bz,ax,yBottom,az,
      bx,yTop,bz,bx,yBottom,bz,ax,yBottom,az
    );
    const tileUnits=gx(CELL);
    for(const {solve,topY,bottomY} of solves)for(const cell of solve.cells){
      if(cell.shape==="empty")continue;
      const {tops,walls}=SHAPE_GEOMETRY[cell.shape];
      // Dual cell (dx,dy) spans between the four surrounding placement-cell centers.
      const originX=gx((cell.dx-1)*CELL),originZ=gz((cell.dy-1)*CELL);
      const place=point=>{const [x,z]=rotateShapePoint(point,cell.rotation);return [originX+x*tileUnits,originZ+z*tileUnits];};
      const color=tintFor(solve.layer,cell.shape,cell.variant);
      {const i=cell.dy*terrainTintMap.cols+cell.dx;terrainTintMap.has[i]=1;
       terrainTintMap.rgb[i*3]=color.r;terrainTintMap.rgb[i*3+1]=color.g;terrainTintMap.rgb[i*3+2]=color.b;}
      for(const polygon of tops)pushTopPolygon(polygon.map(place),topY,color);
      for(const segment of walls)pushWallSegment(segment.map(place),topY,bottomY);
    }
    // Revision is simulation-owned. Build replacements before disposing the visible old pair so a
    // rebuild cannot leave a half-updated scene if a future producer violates the terrain contract.
    const nextTop=meshOf(geometryWith(top,uv,colors),landMat,false,true),nextSkirts=meshOf(geometryWith(skirts),shoreMat,false,true);
    nextTop.raycast=nextSkirts.raycast=NO_RAYCAST;
    // Terrain is what the water shader measures thickness against.
    nextTop.layers.enable(WATER_DEPTH_LAYER);nextSkirts.layers.enable(WATER_DEPTH_LAYER);
    removeTerrainObject(terrainTop);removeTerrainObject(shorelineSkirts);
    terrainTop=nextTop;shorelineSkirts=nextSkirts;scene.add(terrainTop,shorelineSkirts);builtTerrainRevision=metadata.revision;staticBuildStats.terrainBuilds++;
  }
  rebuildPlacementGrid(metadata);
}
rebuildTerrainPresentation();

export function terrainRenderDiagnostics(){
  let sceneObjects=-1,meshes=0,visibleMeshes=0,shadowCasters=0,outlines=0,instancedMeshes=0;
  const materials=new Set();
  // This 4 Hz census is diagnostic-only. renderer.info supplies submitted work; traversal explains
  // what scene structure produced it without making the render layer expose its private pools.
  scene.traverse(object=>{
    sceneObjects++;
    if(!object.isMesh)return;
    meshes++;if(object.visible)visibleMeshes++;if(object.castShadow)shadowCasters++;
    if(object.userData.outline===true)outlines++;if(object.isInstancedMesh)instancedMeshes++;
    for(const material of Array.isArray(object.material)?object.material:[object.material])if(material)materials.add(material);
  });
  const buffer=renderer.getDrawingBufferSize(new THREE.Vector2());
  return Object.freeze({...staticBuildStats,terrainRevision:builtTerrainRevision,
    terrainTextureBytes:GRASS_TEXTURE_BYTES,placementGridVisible:terrainGrid?.visible===true,
    drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
    geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,
    sceneObjects,meshes,visibleMeshes,shadowCasters,outlines,instancedMeshes,materials:materials.size,
    pixelRatio:renderer.getPixelRatio(),bufferWidth:buffer.x,bufferHeight:buffer.y,
    shadows:renderer.shadowMap.enabled,waterPrepass:waterPrepassEnabled});
}

// ─────────────────────────────────────────────────────────── pooling
/** Keeps one group per live entity; builds on first sight, disposes when gone. */
function makeLayer(build, update){
  const store = new Map();
  const seen = new Set();
  return function sync(list){
    seen.clear();
    for(const e of list){
      let g = store.get(e);
      if(!g){
        g = build(e);
        g.traverse(o=>{ if(o.isMesh) o.userData.ent = e; });   // for the occlusion test
        scene.add(g); store.set(e,g);
      }
      seen.add(e);
      g.visible = true;
      update(g,e);
    }
    for(const [e,g] of store){
      if(seen.has(e))continue;
      scene.remove(g); disposeGroup(g); store.delete(e);
    }
  };
}
// Every ground-anchored entity rides the presentational raised layer through this
// one hook; the simulation's coordinates stay flat 2D.
const setXZ = (g,e,y=0)=>g.position.set(gx(e.x), y+terrainLiftAt(e.x,e.y), gz(e.y));
const shakeOf = e => e.shake ? Math.sin(e.shake*28)*.12 : 0;
// A struck node also COMPRESSES, not just wobbles: `shake` lands at 1 and decays over ~.14s, so
// height dips hardest on the impact frame and springs back while the wobble rings out. The matching
// horizontal bulge keeps the silhouette roughly volume-preserving so it reads as a thump, not a
// shrink. Presentation only — the simulation's `shake` field is unchanged and unread here otherwise.
const hitSquashOf = e => 1 - (e.shake||0)*.13;
const hitBulgeOf  = e => 1 + (e.shake||0)*.06;
// A felled/depleted node topples toward a stable per-node side, hashed off its cell-aligned
// coordinates, so a cleared forest falls in a mix of directions and never re-rolls mid-animation.
const collapseDir = e => (((e.x*7 + e.y*13)|0) & 1) ? 1 : -1;

// Simulation `grass` cells (cut-grass targets) have NO render of their own: the legacy tuft
// instancer was deleted Aug 22 — the meadow below IS the grass presentation, and tufts read as
// floor noise through the pixel pipeline. Cutting grass is still a real simulation action; it
// just doesn't change what's drawn.

// ── the meadow: instanced grass blades (src/render/grass.js) ────────────────
// The "real grass presentation" the flat-fill bake above waits for. One instanced draw over the
// whole map: blades spawn on LAND raster cells (16px = 1 wu resolution) outside fog, ride the
// raised layer's lift, and take the flat meadow albedo (raised cells read 12% lighter, matching
// tintFor). Terrain relocation and fog clears re-sample via the revision key; entities bend
// blades through the pusher API every frame. All look knobs live in grassTune (R panel "grass").
const meadowSample = (() => {
  const base = new THREE.Color(PAL.grass);
  const raisedTint = base.clone().lerp(new THREE.Color(0xffffff), .12);
  const cellTint = new THREE.Color(), c = new THREE.Color();
  const SKIP = {skip: true}, UP = [0, 1, 0];
  return (x, z) => {
    const px = x / S, py = z / S;
    if(px < 0 || py < 0 || px >= W || py >= H) return SKIP;
    if(terrainAtRasterCell(Math.floor(px / TERRAIN_CELL_SIZE), Math.floor(py / TERRAIN_CELL_SIZE)) !== LAND) return SKIP;
    if(fogAtPoint(px, py)) return SKIP;
    const lift = terrainLiftAt(px, py);
    // Same law as the terrain mesh (groundColorInto): the cell's WFC tint, then the bright patch.
    const m = terrainTintMap, dx = Math.floor(px / CELL) + 1, dy = Math.floor(py / CELL) + 1;   // CELL (32px) = the WFC dual grid pitch, not TERRAIN_CELL_SIZE
    const i = dy * m.cols + dx;
    if(dx >= 0 && dy >= 0 && dx < m.cols && dy < m.rows && m.has[i]) cellTint.setRGB(m.rgb[i*3], m.rgb[i*3+1], m.rgb[i*3+2]);
    else cellTint.copy(lift > 0 ? raisedTint : base);
    groundColorInto(c, cellTint, x, z, terrainMetadata().seed ?? 0);
    // +0.03 keeps blade roots from z-fighting the terrain top at grazing camera pitches.
    return {height: lift + .03, normal: UP, color: [c.r, c.g, c.b], dirt: 0};
  };
})();
// ── wear field: the 0..1 bare-ground map (grass.js setWearMap) ──────────────
// One R8 texture at 1 texel/wu over the whole map; blades shrink with its value, and its LINEAR
// filtering is the clearing's drop-off rim. Composition, refreshed on a ~20Hz tick:
//   pixels = min(1, STATIC + TRAMPLE)
//   STATIC  — permanent stamps: the base, building footprint RECTS (+1 wu feathered rim), and a
//             grassTune.clearRadius circle on every resource node. Restamped when the stamp
//             population or clearRadius changes.
//   TRAMPLE — walking units add grassTune.trampleRate/s under themselves (cap trampleMax, so
//             paths flatten but never go permanently bare), decaying over regrowSec.
// Authored dirt regions would stamp into STATIC too — none exist in the game yet.
const WEAR_W = Math.max(2, Math.round(WU)), WEAR_H = Math.max(2, Math.round(HU));
const wearStatic = new Float32Array(WEAR_W * WEAR_H);
const wearTrample = new Float32Array(WEAR_W * WEAR_H);
const wearPixels = new Uint8Array(WEAR_W * WEAR_H);
const wearTex = new THREE.DataTexture(wearPixels, WEAR_W, WEAR_H, THREE.RedFormat, THREE.UnsignedByteType);
wearTex.magFilter = wearTex.minFilter = THREE.LinearFilter;
wearTex.generateMipmaps = false;
wearTex.unpackAlignment = 1;
wearTex.needsUpdate = true;
landSoil.uLandWear.value = wearTex;   // the terrain's soil paint reads this same field (landMat patch above)
/** Max-combine a smoothstep circle into `arr` (wu coords; texel centers sit at +0.5). */
function stampWear(arr, x, z, r, peak){
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(WEAR_W - 1, Math.ceil(x + r));
  const z0 = Math.max(0, Math.floor(z - r)), z1 = Math.min(WEAR_H - 1, Math.ceil(z + r));
  for(let ty = z0; ty <= z1; ty++) for(let tx = x0; tx <= x1; tx++){
    const t = 1 - Math.hypot(tx + .5 - x, ty + .5 - z) / r;
    if(t <= 0) continue;
    const v = peak * t * t * (3 - 2 * t);
    const i = ty * WEAR_W + tx;
    if(v > arr[i]) arr[i] = v;
  }
}
/** Max-combine a rectangle (full peak inside) with a `feather`-wide smoothstep rim — distance
 *  to the rect, so the rim is even on sides AND corners. cx/cz center, hx/hz half-extents, wu. */
function stampWearRect(arr, cx, cz, hx, hz, feather, peak){
  const x0 = Math.max(0, Math.floor(cx - hx - feather)), x1 = Math.min(WEAR_W - 1, Math.ceil(cx + hx + feather));
  const z0 = Math.max(0, Math.floor(cz - hz - feather)), z1 = Math.min(WEAR_H - 1, Math.ceil(cz + hz + feather));
  for(let ty = z0; ty <= z1; ty++) for(let tx = x0; tx <= x1; tx++){
    const dx = Math.max(0, Math.abs(tx + .5 - cx) - hx), dz = Math.max(0, Math.abs(ty + .5 - cz) - hz);
    const t = 1 - Math.hypot(dx, dz) / feather;   // d=0 inside the rect, so t=1 = full peak there
    if(t <= 0) continue;
    const v = peak * t * t * (3 - 2 * t);
    const i = ty * WEAR_W + tx;
    if(v > arr[i]) arr[i] = v;
  }
}
function rebuildWearStatic(){
  wearStatic.fill(0);
  stampWear(wearStatic, gx(BASE.x), gz(BASE.y), BASE.r * S + 1.5, 1);
  for(const b of buildings){
    // The ACTUAL grid footprint (owner ask): full wear across exactly the covered cells, then a
    // 1 wu feathered rim, even on sides and corners. Since Aug 22 this stamp is the ONLY ground
    // treatment a building gets — the flat pad mesh under every body is deleted — so it also has
    // to paint the soil the pad used to be.
    // SOIL_MARGIN exists for that: the field is 1 texel/wu and LINEAR-filtered, so the soilAt (.85)
    // crossing falls INSIDE the peak-1 rect, up to ~0.7 wu in on the worst texel alignment. Half a
    // world unit of extra half-extent pushes the crossing back out to the footprint edge, so no
    // building corner is ever left standing on bare green. Grass still overlaps the rim "a tad"
    // (owner call), which is the point of the 1 wu feather.
    const fp = buildingFootprint(b.type), SOIL_MARGIN = .5;
    stampWearRect(wearStatic, gx(b.x), gz(b.y),
                  fp.w * CELL * S / 2 + SOIL_MARGIN, fp.h * CELL * S / 2 + SOIL_MARGIN, 1, 1);
  }
  const r = grassTune.clearRadius;
  if(r > 0) for(const list of [trees, rocks, diamonds])
    for(const e of list) stampWear(wearStatic, gx(e.x), gz(e.y), r, grassTune.clearStrength);   // < soilAt by default: shortens blades, never paints soil
}
let wearStaticKey = "", lastWearT = 0;
function syncWear(time, pushers){
  const key = buildings.length + ":" + trees.length + ":" + rocks.length + ":" + diamonds.length
            + ":" + grassTune.clearRadius + ":" + grassTune.clearStrength;
  if(time - lastWearT < .05 && key === wearStaticKey) return;
  if(key !== wearStaticKey){ rebuildWearStatic(); wearStaticKey = key; }
  const dt = Math.min(.25, Math.max(0, time - lastWearT));
  lastWearT = time;
  const decay = Math.exp(-dt / Math.max(1, grassTune.regrowSec));
  const add = grassTune.trampleRate * dt, cap = grassTune.trampleMax;
  for(let i = 0; i < wearTrample.length; i++) wearTrample[i] *= decay;
  if(add > 0 && cap > 0) for(const p of pushers){
    const r = p.r * .55;   // trample under the body, narrower than the visual push radius
    const x0 = Math.max(0, Math.floor(p.x - r)), x1 = Math.min(WEAR_W - 1, Math.ceil(p.x + r));
    const z0 = Math.max(0, Math.floor(p.z - r)), z1 = Math.min(WEAR_H - 1, Math.ceil(p.z + r));
    for(let ty = z0; ty <= z1; ty++) for(let tx = x0; tx <= x1; tx++){
      const t = 1 - Math.hypot(tx + .5 - p.x, ty + .5 - p.z) / r;
      if(t <= 0) continue;
      const i = ty * WEAR_W + tx;
      wearTrample[i] = Math.min(cap, wearTrample[i] + add * t * t * (3 - 2 * t));
    }
  }
  for(let i = 0; i < wearPixels.length; i++)
    wearPixels[i] = Math.min(255, Math.round((wearStatic[i] + wearTrample[i]) * 255));
  wearTex.needsUpdate = true;
}

let meadow = null, meadowKey = "";
function syncMeadow(time){
  const key = terrainMetadata().revision + ":" + fogMetadata().revision + ":" + groundKey();
  if(!meadow){
    meadow = createGrass(THREE, {seed: (terrainMetadata().seed ?? 1) | 0,
                                 region: {x0: 0, z0: 0, x1: WU, z1: HU}, sample: meadowSample});
    meadow.setWearMap(wearTex);
    setToneTargets(meadow.mesh.material,{...TONES.meadow,rig:TONE_RIG,nightRig:TONE_RIG_NIGHT});   // blades = ground tones, night pair included
    scene.add(meadow.mesh);
    meadowKey = key;
  }else if(key !== meadowKey){
    meadow.rebuild();
    meadowKey = key;
  }
  // Pushers: everything that walks the meadow, in world units. Fog-dormant entities are hidden
  // by the sync layers above, so they must not part grass either. The 32-slot cap is grass.js's;
  // typical load (workers + enemies) sits well under it. The same list feeds the wear
  // field's trample stamps, so what parts the grass is exactly what wears it down.
  const pushers = [];
  const push = (e, r) => { if(e && pushers.length < 32 && !fogAtPoint(e.x, e.y)) pushers.push({x: gx(e.x), z: gz(e.y), r}); };
  for(const w of state.workers) push(w, 1.8);
  push(heldWorker(), 1.8);
  for(const e of state.enemies) push(e, 2.2);
  for(const b of friendlyBrutes) push(b, 2.4);
  for(const c of controlledEnemies) push(c, 2.2);
  meadow.setPushers(pushers);
  syncWear(time, pushers);
  landSoil.uLandSoilAt.value = groundTune.soilAt;   // live R-panel knob, shader-only (no rebuild)
  meadow.sync(time);
}

// ── instanced resource scatter ──────────────────────────────────────────────
// The authored map carries a few hundred trees/rocks; as pooled groups they were ~1,500 draws
// (parts + ink shells + their shadow passes). Each class is now a handful of InstancedMeshes —
// one live body per colour variant, one depleted remnant, each paired with an ink shell that
// SHARES the live instance buffer — so scatter draws no longer scale with map density. Matrices
// are recomposed from the simulation arrays every frame (a few hundred composes is microseconds),
// which keeps shake/wear/heightScale behaviour identical to the old per-group path.
// Occlusion sweeps identify instances through userData.entities[instanceId] (see countVisible).
function makeScatterLayer(buildTemplate, variantCount){
  const variantGeos = [], liveMat = flat(0xffffff, {vertexColors:true});
  let remnantGeo = null, remnantMat = null;
  for(let v = 0; v < variantCount; v++){
    const template = buildTemplate(v);
    const liveSrc = Array.isArray(template.userData.live) ? template.userData.live[0] : template.userData.live;
    liveSrc.updateMatrix();
    variantGeos.push(liveSrc.geometry.clone().applyMatrix4(liveSrc.matrix));
    if(!remnantGeo){
      const remnantSrc = template.userData.stump ?? template.userData.rubble;
      remnantSrc.updateMatrix();
      remnantGeo = remnantSrc.geometry.clone().applyMatrix4(remnantSrc.matrix);
      // The painted casts carry their colour in vertex attributes (one flat value per facet), so
      // the remnant takes the same white vertex-colour Lambert the live variants share. A remnant
      // with no colour attribute keeps the old single-colour material.
      remnantMat = remnantGeo.getAttribute("color") ? liveMat : flat(remnantSrc.material.color.getHex());
    }
    disposeGroup(template);
  }
  const layer = {units:[], capacity:-1, variantCount};
  layer.rebuild = n => {
    for(const {mesh, shell} of layer.units){
      scene.remove(mesh, shell); releaseOutlineShell(shell); mesh.dispose(); shell.dispose();
    }
    layer.units = [...variantGeos, remnantGeo].map((geo, i) => {
      const mesh = new THREE.InstancedMesh(geo, i < variantCount ? liveMat : remnantMat, Math.max(n,1));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.entities = [];
      const shell = new THREE.InstancedMesh(geo, outlineMat, Math.max(n,1));
      shell.instanceMatrix = mesh.instanceMatrix;   // one write drives body and ink together
      shell.frustumCulled = false; shell.count = 0;
      adoptOutlineShell(shell);
      scene.add(mesh, shell);
      return {mesh, shell};
    });
    layer.capacity = n;
  };
  return layer;
}
const _sm=new THREE.Matrix4(),_sq=new THREE.Quaternion(),_sqYaw=new THREE.Quaternion(),_sv=new THREE.Vector3(),_ssc=new THREE.Vector3(),_axisZ=new THREE.Vector3(0,0,1),_axisY=new THREE.Vector3(0,1,0);
// Deterministic per-entity yaw so one scatter template doesn't tile visibly (every rock used to
// face the same way). Pure function of the sim position — stable across rebuilds and states, so
// a boulder doesn't snap around when it starts crumbling.
const scatterYaw=e=>{const h=Math.sin(e.x*12.9898+e.y*78.233)*43758.5453;return (h-Math.floor(h))*Math.PI*2;};
// classify(e) -> [unitIndex, rotZ, wear, squash, yaw]; scale is (wear, wear*heightScale*squash, wear).
// `squash` defaults to 1 and scales HEIGHT ONLY, so an impact thump or a collapsing node can flatten
// toward the ground without its footprint shrinking with it.
function syncScatter(layer, list, classify){
  if(list.length !== layer.capacity) layer.rebuild(list.length);
  for(const u of layer.units){ u.mesh.count = 0; u.mesh.userData.entities.length = 0; }
  const hs = view.heightScale/100;
  for(const e of list){
    const [unit, rotZ, wear, squash = 1, yaw = 0] = classify(e);
    const u = layer.units[unit], i = u.mesh.count++;
    u.mesh.userData.entities[i] = e;
    _sq.setFromAxisAngle(_axisZ, rotZ);
    // yaw first, collapse-lean second, so a crumble still tips in a WORLD direction.
    if(yaw){ _sqYaw.setFromAxisAngle(_axisY, yaw); _sq.multiply(_sqYaw); }
    _sv.set(gx(e.x), terrainLiftAt(e.x,e.y), gz(e.y));
    _ssc.set(wear, wear*hs*squash, wear);
    _sm.compose(_sv, _sq, _ssc);
    u.mesh.setMatrixAt(i, _sm);
  }
  for(const u of layer.units){
    u.shell.count = u.mesh.count;
    u.mesh.instanceMatrix.needsUpdate = true;
    u.mesh.computeBoundingSphere();   // occlusion raycasts early-out against it
  }
}
const treeLayer = makeScatterLayer(v => makeTree({variant:v}), PAL.leaf.length);
const rockLayer = makeScatterLayer(() => makeRock(), 1);
// The felling tween. `collapse` is the sim's presentation countdown (1 at the killing blow, 0 when
// the fall is done); while it runs the LIVE canopy keeps drawing and swings about its base on Z —
// the instanced geometry is authored around the ground point, so a Z rotation is a clean topple —
// then the stump this layer has always drawn takes over. Gameplay finished the node the moment
// stump went 1: the yield, the toast and the click target all resolved before this ever ran.
const TREE_FALL_ANGLE = 1.5;                       // radians past vertical: flat on the ground
const treeVariantOf = t => PAL.leaf[t.variant] !== undefined ? t.variant : 0;
const syncTrees = list => syncScatter(treeLayer, list, t => {
  if(t.stump<=0)
    return [treeVariantOf(t), shakeOf(t), (.78 + .22*(t.hp/t.max))*hitBulgeOf(t), hitSquashOf(t)];
  if(t.collapse>0){
    const p = 1-t.collapse;                        // 0 at the felling hit, 1 with the trunk down
    return [treeVariantOf(t), TREE_FALL_ANGLE*p*p*collapseDir(t), .78, 1];   // p² : slow tip, fast fall
  }
  return [treeLayer.variantCount, 0, 1];
});
const syncRocks = list => syncScatter(rockLayer, list, r => {
  // A landed meteor rock swells past its resting 2.25x while its sim-owned `pop` decays — the
  // touchdown compression. A fireball's small rock gets the same overshoot at resting 1x so it
  // punches out of the ground instead of just appearing under the embers. Ordinary click shakes
  // never write `pop`, so mining doesn't re-pop either.
  const spent = r.depleted>0, meteor = r.meteor ? 2.25*(1 + .3*(r.pop||0)**2) : r.fireball ? 1 + .3*(r.pop||0)**2 : 1;
  if(spent && r.collapse>0){
    // The crumble: the live boulder settles into the ground and spreads as it goes, so the rubble
    // it becomes appears to be what is left of it rather than a swapped-in prop.
    const p = 1-r.collapse;
    return [0, shakeOf(r) + .22*p*collapseDir(r), (.8 + .38*p)*meteor, Math.max(.06, 1-p*p), scatterYaw(r)];
  }
  return spent ? [1, 0, meteor, 1, scatterYaw(r)]
               : [0, shakeOf(r), (.8 + .2*(r.hp/r.max))*meteor*hitBulgeOf(r), hitSquashOf(r), scatterYaw(r)];
});
const syncDiamonds = makeLayer(makeDiamond, (g,n)=>{
  setXZ(g,n);
  const d = g.userData, spent = n.depleted>0;
  // Same felling contract as trees/rocks: an exhausted deposit keeps its live crystals for the
  // length of the sim's `collapse` countdown, sinking and spinning out, before the spent husk
  // takes over. The simulation considers it finished from the frame `depleted` went 1.
  const collapsing = spent && n.collapse>0, p = collapsing ? 1-n.collapse : 0;
  for(const m of d.live) m.visible = !spent || collapsing;
  d.spent.visible = spent && !collapsing;
  g.rotation.z = collapsing ? .55*p*p*collapseDir(n) : spent ? 0 : shakeOf(n);
  // Spin each crystal about its own base, not the cluster about the node centre — `gem` is now a
  // GROUP of offset crystals, and rotating it orbits the whole formation (reads as the rock itself
  // slowly turning). Children first; the fallback keeps the old single-mesh contract working.
  if(!spent || collapsing){
    const spin = collapsing ? .10 : .02;
    if(d.gem.children?.length) for(const crystal of d.gem.children) crystal.rotation.y += spin;
    else d.gem.rotation.y += spin;
  }
  const squash = collapsing ? Math.max(.06, 1-p*p) : spent ? 1 : hitSquashOf(n);
  const bulge  = collapsing ? 1 + .3*p            : spent ? 1 : hitBulgeOf(n);
  g.scale.set(bulge, squash*view.heightScale/100, bulge);
});
const syncChests = makeLayer(makeChest,(g,chest)=>{
  const held=chest===heldChest()&&state.mouse.inside,t=performance.now()/1000,wear=.9+.1*(chest.hp/chest.max);
  if(held)g.position.set(gx(state.mouse.x),2.2+Math.sin(t*5)*.14,gz(state.mouse.y));else setXZ(g,chest);
  g.rotation.z=held?Math.sin(t*7)*.09:shakeOf(chest);
  g.userData.lid.rotation.x=chest.shake?Math.sin(chest.shake*30)*.08:0;
  for(const material of g.userData.wearMats)material.emissive.setHex(chest.hp<chest.max?PAL.hurtGlow:0x000000);
  g.scale.set(wear,wear*view.heightScale/100,wear);
});
const syncDrops = makeLayer(e=>makeDrop(e.kind), (g,r)=>{
  if(r.target==="hand"){
    // Flying to the cursor: parabolic hop, fast tumble, shrinking as it lands.
    const p = clamp(r.t,0,1);
    setXZ(g, r, Math.sin(p*Math.PI)*VIEW_TUNE.handArc + p*2.2);
    g.rotation.x += .30; g.rotation.y += .22;
    g.scale.setScalar(1 - .45*p);
    g.userData.body.visible = true;
    return;
  }
  // A settled drop breathes; one inside the live vacuum's reach lifts, spins up and swells. The
  // ring at the cursor says "this area", this says "THESE ones" — and it is a read of the same
  // vacuumRadius() collectDrop() sweeps with, so it can never advertise a pickup the sim refuses.
  // Purely a read: the simulation alone decides which drop is actually taken.
  const t = performance.now()/1000;
  const reachable = state.collecting && state.mouse.inside && !r.target
    && distance(state.mouse.x, state.mouse.y, r.x, r.y) < vacuumRadius();
  const bob = r.ground ? Math.sin(t*3 + r.spin)*.09 : 0;
  setXZ(g, r, bob + (reachable ? .6 : 0));
  g.rotation.set(0, r.spin*.25 + (reachable ? t*3 : 0), 0);   // sim spins at 4 rad/s; too fast raw
  g.scale.setScalar(reachable ? 1.2 : 1);
  const fading = r.ttl!==null && r.ttl<2 && Math.floor(r.ttl*7)%2===0;
  g.userData.body.visible = !fading;
});
// ── mineable fog field ──────────────────────────────────────────────────────
// Every standing fog block rides ONE InstancedMesh plus a buffer-sharing ink shell, so tens of
// thousands of cells stay two draw calls. Matrices recompose only when the field changes or a
// block is mid-shake; per-instance shade colours are keyed once per rebuild. Blocks sit flush on
// the placement grid (full-cell footprint), with hashed height variance so the field reads as
// carved slabs rather than a flat wall; wear squashes a block toward the ground as it is mined.
const FOG_BLOCK_H=2.5;
// Shades are ALBEDO under the live light rig. Aug 21 rig re-solve (×2.45 up-facing luma — see
// the lights comment above): these are the original owner-picked hexes (52 4c 5e / 5a 54 68 /
// 48 42 53, water 49 48 5e / 50 4f 68 / 41 40 53) divided by 2.45 in linear, so the fog DISPLAYS
// byte-near-identical to the pre-relight build and keeps receding instead of riding the new sun.
const FOG_SHADES=PAL.fogLand.map(h=>new THREE.Color(h));
// Blocks standing in open water shade cooler and sit down at the water surface, so the fog field
// reads as one sheet draped over an unknown silhouette rather than floating slabs.
const FOG_WATER_SHADES=PAL.fogWater.map(h=>new THREE.Color(h));
const fogGeo=new THREE.BoxGeometry(CELL*S,1,CELL*S);fogGeo.translate(0,.5,0);
const fogMat=new THREE.MeshLambertMaterial({color:0xffffff,flatShading:true});
// Fog is a gameplay surface a third of the screen wide — banding it is a look decision the owner
// has not made; opt out of the toon ramp (cloud shade still applies).
fogMat.userData.noToonRamp=true;
// NIGHT TIER (Aug 22). Fog blocks are per-instance coloured off the shade bridge (FOG_SHADES), so
// they have no day tone triple to extend — setNightTone adds a NIGHT-ONLY pair and leaves the day
// render byte-identical. Solved on shade0, the middle of the land palette above; the other two
// shades scale proportionally (same rule as the meadow's green0 patches). Without it the dimmed
// key light would drop the field to shade2 and the unknown would stop reading as a wall at all —
// this walks it one step DOWN the bridge (shade0 lit -> shade1) instead of switching it off.
setNightTone(fogMat,{albedo:PAL.fogLand[0],lit:SWATCH.shade1,shadow:SWATCH.shade2,rig:TONE_RIG_NIGHT});
let fogMesh=null,fogShell=null,fogBuiltRevision=-1,fogHadShake=false,fogBuiltHeight=-1;
const _fq0=new THREE.Quaternion(),_fv=new THREE.Vector3(),_fs=new THREE.Vector3(),_fm=new THREE.Matrix4();
function rebuildFogField(count){
  if(fogMesh){scene.remove(fogMesh,fogShell);releaseOutlineShell(fogShell);fogMesh.dispose();fogShell.dispose();}
  fogMesh=fogShell=null;
  if(!count)return;
  fogMesh=new THREE.InstancedMesh(fogGeo,fogMat,count);
  fogMesh.name="fog-field";fogMesh.castShadow=false;fogMesh.receiveShadow=true;fogMesh.frustumCulled=false;fogMesh.raycast=NO_RAYCAST;
  fogMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Apron cells carry negative indices, so every hash pads them positive first — a negative
  // modulo here indexes undefined and kills the whole render loop.
  fog.forEach((cell,i)=>fogMesh.setColorAt(i,(cell.water?FOG_WATER_SHADES:FOG_SHADES)[((cell.cx+64)*13+(cell.cy+64)*7)%FOG_SHADES.length]));
  fogMesh.instanceColor.needsUpdate=true;
  fogShell=new THREE.InstancedMesh(fogGeo,outlineMat,count);
  fogShell.instanceMatrix=fogMesh.instanceMatrix;fogShell.frustumCulled=false;fogShell.raycast=NO_RAYCAST;
  adoptOutlineShell(fogShell);
  scene.add(fogMesh,fogShell);
}
function syncFog(){
  const metadata=fogMetadata();
  // The height factor joins the early-out key: neither slider touches the fog revision, so without
  // it a field with nothing shaking would keep its old matrices until the next mine.
  const hs=view.heightScale/100*(view.fogHeight/100);
  let shaking=false;
  for(const cell of fog)if(cell.shake>0){shaking=true;break;}
  if(metadata.revision===fogBuiltRevision&&hs===fogBuiltHeight&&!shaking&&!fogHadShake)return;
  if(metadata.count!==(fogMesh?fogMesh.count:0))rebuildFogField(metadata.count);
  if(!fogMesh){fogBuiltRevision=metadata.revision;fogBuiltHeight=hs;fogHadShake=false;return;}
  fog.forEach((cell,i)=>{
    const jag=.8+(((cell.cx+64)*31+(cell.cy+64)*17)%23)/23*.4;
    const wear=.45+.55*(cell.hp/cell.max);
    const squash=cell.shake>0?1-Math.abs(Math.sin(cell.shake*28))*.18:1;
    _fv.set(gx(cell.x),cell.water?WATER_Y:terrainLiftAt(cell.x,cell.y),gz(cell.y));
    _fs.set(1,Math.max(.25,FOG_BLOCK_H*jag*wear*squash*hs),1);
    _fm.compose(_fv,_fq0,_fs);
    fogMesh.setMatrixAt(i,_fm);
  });
  fogMesh.instanceMatrix.needsUpdate=true;
  fogBuiltRevision=metadata.revision;fogBuiltHeight=hs;fogHadShake=shaking;
}
// ── fog death tween ──
// Cleared blocks are already gone from gameplay; the simulation's fogPops records replay them here
// for popAnimTime as an inflate-then-collapse. A small fixed-capacity instanced pair (body + ink)
// is created on first use and idles at count 0 — during heavy cascades records beyond the cap
// simply skip the tween, which reads as blocks at the pile's centre popping instantly.
const FOG_POP_CAP=512;
let fogPopMesh=null,fogPopShell=null;
function ensureFogPopMesh(){
  if(fogPopMesh)return;
  fogPopMesh=new THREE.InstancedMesh(fogGeo,fogMat,FOG_POP_CAP);
  fogPopMesh.name="fog-pops";fogPopMesh.castShadow=false;fogPopMesh.receiveShadow=true;fogPopMesh.frustumCulled=false;fogPopMesh.raycast=NO_RAYCAST;
  fogPopMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);fogPopMesh.count=0;
  fogPopShell=new THREE.InstancedMesh(fogGeo,outlineMat,FOG_POP_CAP);
  fogPopShell.instanceMatrix=fogPopMesh.instanceMatrix;fogPopShell.frustumCulled=false;fogPopShell.raycast=NO_RAYCAST;fogPopShell.count=0;
  adoptOutlineShell(fogPopShell);
  scene.add(fogPopMesh,fogPopShell);
}
function syncFogPops(){
  if(!fogPops.length&&(!fogPopMesh||fogPopMesh.count===0))return;
  ensureFogPopMesh();
  const hs=view.heightScale/100*(view.fogHeight/100),n=Math.min(fogPops.length,FOG_POP_CAP);
  // The record is spliced out of fogPops at age >= FOG.popAnimTime, so the visual can only be
  // COMPRESSED into that window, never stretched past it — a longer curve would be cut mid-swell.
  const popTime=Math.max(.001,Math.min(view.fogPopTime/1000,FOG.popAnimTime)),swellAmt=view.fogPopSwell/100;
  for(let i=0;i<n;i++){
    const pop=fogPops[i],t=Math.min(pop.age/popTime,1);
    // Inflate for the first third, then collapse to nothing — the classic squash pop.
    const swell=t<.33?1+swellAmt*(t/.33):Math.max(0,(1+swellAmt)*(1-(t-.33)/.67));
    const jag=.8+(((pop.cx+64)*31+(pop.cy+64)*17)%23)/23*.4;
    _fv.set(gx(pop.x),pop.water?WATER_Y:terrainLiftAt(pop.x,pop.y),gz(pop.y));
    _fs.set(swell,Math.max(.01,FOG_BLOCK_H*jag*hs*swell),swell);
    _fm.compose(_fv,_fq0,_fs);
    fogPopMesh.setMatrixAt(i,_fm);
    fogPopMesh.setColorAt(i,(pop.water?FOG_WATER_SHADES:FOG_SHADES)[((pop.cx+64)*13+(pop.cy+64)*7)%FOG_SHADES.length]);
  }
  fogPopMesh.count=n;fogPopShell.count=n;
  fogPopMesh.instanceMatrix.needsUpdate=true;if(fogPopMesh.instanceColor)fogPopMesh.instanceColor.needsUpdate=true;
}

// ── Showcase render consumption flow ──
// Written by simulation.js's fixture/damage/held-object commands; iterated read-only here.
// Pools own meshes and dispose them as fixture resets replace live object identities.
const syncDummies = makeLayer(makeDamageDummy,(g,d)=>{
  setXZ(g,d,d.defeatedTimer>0?.08:0);g.rotation.z=d.defeatedTimer>0?Math.PI/2:0;g.scale.y=view.heightScale/100;
  g.userData.target.material.emissive.setHex(d.flash?PAL.hurtGlow:0x000000);
});
const syncShowcaseProps = makeLayer(p=>makeShowcaseProp(p.model),(g,p)=>{
  const held=p===heldProp()&&state.mouse.inside;
  if(held)g.position.set(gx(state.mouse.x),2.2+Math.sin(performance.now()/200)*.14,gz(state.mouse.y));else setXZ(g,p);
  g.rotation.z=held?Math.sin(performance.now()/140)*.1:0;g.scale.y=view.heightScale/100;
});
// Enemies use the reviewed shard models (see makeEnemy in models.js): one model per enemy for its
// whole life (types never change), a store rec for render-side facing/edge state, and exactly one
// deterministic anim call per frame — the same contract syncWorkers follows. Drivers derive from
// existing sim state only: movement deltas (locomotion + facing), attackCooldown cycling off
// ENEMY_TYPES.rate (lunge/fire/thump strike frames land on the sim's actual hit, the worker-jab
// phase trick), healFlash rising edge (one heal cast), wob (the sim's locomotion clock) for hop
// phases. Showcase fixtures hold attackCooldown at 0, so they rest in idle poses by construction.
// Status tints go through userData.tintMats — body rock only, never seams/eyes/FX.
const enemyStore = new Map();
function syncEnemies(list){
  const t = performance.now()/1000;
  const seen = new Set();
  for(const e of list){
    let rec = enemyStore.get(e);
    if(!rec){
      const g = makeEnemy(e.type);
      g.traverse(o=>{ if(o.isMesh) o.userData.ent = e; });   // for the occlusion test
      scene.add(g);
      rec = {g, inner:g.userData.inner, anims:g.userData.anims, tintMats:g.userData.tintMats,
             px:e.x, py:e.y, yaw:Math.PI, targetYaw:undefined, healT:-9};
      enemyStore.set(e, rec);
    }
    seen.add(e);
    const {g, inner, anims} = rec;
    g.visible = true;
    // facing: movement direction while marching, the recorded shot target while planted
    const dx = e.x-rec.px, dz = e.y-rec.py;
    const moving = Math.hypot(dx,dz) > .05;
    if(moving) rec.targetYaw = Math.atan2(dx,dz);
    else if(e.shotFlash>0 && e.shotX!==undefined) rec.targetYaw = Math.atan2(e.shotX-e.x, e.shotY-e.y);
    rec.px = e.x; rec.py = e.y;
    if(rec.targetYaw!==undefined) rec.yaw += yawWrap(rec.targetYaw-rec.yaw)*.2;
    const def = ENEMY_TYPES[e.type],archetype=def.archetype;
    const engaged = e.attackCooldown>0;      // cycling combat timer; 0 = never attacked / fixture
    const combatPhase = strike =>
      (strike + (1 - clamp(e.attackCooldown,0,def.rate)/def.rate)) % 1;
    if(archetype==="healer"){
      if(e.healFlash>0 && t-rec.healT>1.2) rec.healT = t;   // rising edge: one cast cycle
      if(t-rec.healT<.9 && anims.heal) anims.heal(inner, (t-rec.healT)/.9, t);
      else anims.hover(inner, 0, t);
    } else if(archetype==="archer"){
      if(engaged && anims.fire) anims.fire(inner, combatPhase(.5), t);
      else anims.sway(inner, 0, t);
    } else if(archetype==="brute"){
      // thump is both gait and swing: landing (~.55) syncs to the sim's hit when engaged,
      // and to the wob clock while lumbering.
      if(engaged && anims.thump) anims.thump(inner, combatPhase(.55), t);
      else anims.thump(inner, moving ? (e.wob*.12)%1 : 0, t);
    } else if(archetype==="bomber"){
      // the lit fuse IS the combat state: arm() renders the sim's fuse timer as the
      // swell/blink telegraph; a bomber with no fuse just runs.
      if(e.fuse!==undefined && anims.arm) anims.arm(inner, 1-clamp(e.fuse,0,def.fuseTime)/def.fuseTime, t);
      else anims.scuttle(inner, moving ? (e.wob*.2)%1 : 0, t);
    } else {
      if(engaged && anims.lunge) anims.lunge(inner, combatPhase(.5), t);
      else anims.scuttle(inner, moving ? (e.wob*.2)%1 : 0, t);
    }
    const burning = !!e.status?.burn;
    for(const m of rec.tintMats)
      m.emissive.setHex(e.flash>0 ? PAL.flash : burning ? PAL.emberGlow : 0x000000);
    const held=e===heldEnemy()&&state.mouse.inside;
    if(held)g.position.set(gx(state.mouse.x),2.2,gz(state.mouse.y));else setXZ(g, e, 0);
    g.rotation.set(0, rec.yaw, 0);
    // Archetype size is baked into reviewed models. modelScale is reserved for explicit authored
    // scale variants such as the brute boss; collision size is authored independently in data.js.
    const modelScale=def.modelScale||1;
    g.scale.set(S*modelScale, S*modelScale*view.heightScale/100, S*modelScale);
  }
  for(const [e,rec] of enemyStore){
    if(seen.has(e)) continue;
    scene.remove(rec.g); disposeGroup(rec.g); enemyStore.delete(e);
  }
}
const syncFriendlyBrutes=makeLayer(()=>makeEnemy("brute"),(g,brute)=>{
  const t=performance.now()/1000,target=brute.combatTarget,inner=g.userData.inner,anims=g.userData.anims;
  if(anims.thump)anims.thump(inner,target?(1-clamp(brute.attackCooldown,0,1.1)/1.1):brute.wob*.12%1,t);
  if(target)g.rotation.y=Math.atan2(target.x-brute.x,target.y-brute.y);
  setXZ(g,brute);g.scale.set(S,S*view.heightScale/100,S);
  for(const material of g.userData.tintMats||[])material.emissive.setHex(0x244a35);
});
// Controlled enemies keep their own archetype/variant shard model — same build path, same anims —
// with the friendly-Brute green emissive layered on so allegiance reads at a glance beside hostile
// veteran/elite tints. Facing/anim state rides the pooled group's userData; makeLayer owns disposal
// when a unit dies or the run resets.
const syncControlledEnemies=makeLayer(unit=>makeEnemy(unit.type),(g,unit)=>{
  const t=performance.now()/1000,d=g.userData,def=ENEMY_TYPES[unit.type],inner=d.inner,anims=d.anims;
  d.px??=unit.x;d.py??=unit.y;d.yaw??=Math.PI;d.healT??=-9;
  const dx=unit.x-d.px,dz=unit.y-d.py,moving=Math.hypot(dx,dz)>.05;
  if(moving)d.targetYaw=Math.atan2(dx,dz);
  else if(unit.combatTarget)d.targetYaw=Math.atan2(unit.combatTarget.x-unit.x,unit.combatTarget.y-unit.y);
  d.px=unit.x;d.py=unit.y;
  if(d.targetYaw!==undefined)d.yaw+=yawWrap(d.targetYaw-d.yaw)*.2;
  const engaged=unit.attackCooldown>0;
  const combatPhase=strike=>(strike+(1-clamp(unit.attackCooldown,0,def.rate)/def.rate))%1;
  if(def.archetype==="healer"){
    if(unit.healFlash>0&&t-d.healT>1.2)d.healT=t;
    if(t-d.healT<.9&&anims.heal)anims.heal(inner,(t-d.healT)/.9,t);
    else anims.hover(inner,0,t);
  }else if(def.archetype==="archer"){
    if(engaged&&anims.fire)anims.fire(inner,combatPhase(.5),t);
    else anims.sway(inner,0,t);
  }else if(def.archetype==="brute"){
    if(anims.thump)anims.thump(inner,engaged?combatPhase(.55):moving?(unit.wob*.12)%1:0,t);
  }else{
    if(engaged&&anims.lunge)anims.lunge(inner,combatPhase(.5),t);
    else anims.scuttle(inner,moving?(unit.wob*.2)%1:0,t);
  }
  // A controlled (turned) enemy is player-side now, so a hit on it reads with the player-side
  // hurt colour, not the enemy-hit flash. Its rest emissive stays the sage cast that marks it turned.
  for(const material of d.tintMats||[])material.emissive.setHex(unit.flash>0?PAL.hurtGlow:0x244a35);   // palette-exempt: turned-unit rest cast
  setXZ(g,unit);g.rotation.set(0,d.yaw,0);
  const modelScale=def.modelScale||1;
  g.scale.set(S*modelScale,S*modelScale*view.heightScale/100,S*modelScale);
});
// Workers swap their whole model when their job or carrying-state changes (the buildingStore
// pattern) — the reviewed pegs carry the tool and the load IN the model, so there is nothing to
// tint or toggle per frame; the per-frame work is choosing an animation and a facing.
// The held worker is spliced out of state.workers by the sim, so it is appended back here — the
// lifted unit rides the cursor as the real mesh, per the held-object contract below.
const workerStore = new Map();
const workerModelKey = w =>
  (w.job==="haul" ? "worker-courier" : w.job==="build" ? "worker-builder" :
   w.job==="guard" ? "worker-guard" : w.job==="free" ? "worker-gatherer" :
   "worker-gatherer") + (workerLoad(w)>0 ? "+carry" : "");   // free wears the plain gatherer coat
const yawWrap = a => Math.atan2(Math.sin(a), Math.cos(a));
function syncWorkers(){
  const t = performance.now()/1000;
  const held = heldWorker();
  const list = held ? [...state.workers, held] : state.workers;
  const seen = new Set();
  for(const w of list){
    const key = workerModelKey(w);
    let rec = workerStore.get(w);
    if(!rec || rec.key!==key){
      if(rec){ scene.remove(rec.g); disposeGroup(rec.g); }
      const g = makePegWorker(key);
      g.traverse(o=>{ if(o.isMesh) o.userData.ent = w; });   // for the occlusion test
      scene.add(g);
      // yaw 0 faces +z — south, toward the default camera — so idle units show their faces.
      rec = {key, g, inner:g.userData.inner, anims:g.userData.anims,
             px:w.x, py:w.y, yaw:0, shield:0, moveT:-9, moveStart:-9};
      workerStore.set(w, rec);
    }
    seen.add(w);
    const {g, inner, anims} = rec;
    g.visible = true;
    // movement + facing from render-side position deltas; the sim knows nothing of either
    const dx = w.x-rec.px, dz = w.y-rec.py;
    const moving = Math.hypot(dx,dz) > .12;
    if(moving){
      rec.targetYaw = Math.atan2(dx,dz);
      if(t-rec.moveT > .5) rec.moveStart = t;      // fresh start after standing: one carry-lag beat
      rec.moveT = t;
    } else if(w.combatTarget){
      rec.targetYaw = Math.atan2(w.combatTarget.x-w.x, w.combatTarget.y-w.y);
    } else if((w.job==="harvest"||w.job==="staff") && w.taskTarget?.x!==undefined){
      rec.targetYaw = Math.atan2(w.taskTarget.x-w.x, w.taskTarget.y-w.y);
    }
    rec.px = w.x; rec.py = w.y;
    if(rec.targetYaw!==undefined) rec.yaw += yawWrap(rec.targetYaw-rec.yaw)*.22;
    // pose: exactly one anim per frame; every anim restores from rest first, so switching is safe
    const guard = w.job==="guard";
    const chopping = !moving && !w.combatTarget && (w.job==="harvest"||w.job==="staff") &&
                     w.hitCooldown>0 && anims.chop;
    let braced = false;
    if(w===held && state.mouse.inside){
      anims.idle(inner, 0, t);
      g.position.set(gx(state.mouse.x), 2.2 + Math.sin(t*5)*.14, gz(state.mouse.y));
      g.rotation.set(0, rec.yaw, Math.sin(t*7)*.13);
      g.scale.set(S, S*view.heightScale/100, S);
      continue;
    }
    if(guard && w.combatTarget && anims.jab){
      // attackCooldown counts down from WORKER_ATTACK_RATE after each hit; the jab's thrust
      // (p~.35) lands at the moment the sim struck, then recovers into the next wind.
      anims.jab(inner, (.35 + (1 - clamp(w.attackCooldown,0,WORKER_ATTACK_RATE)/WORKER_ATTACK_RATE)) % 1, t);
    } else if(chopping){
      // hitCooldown counts down from WORKER_HIT_COOLDOWN after each swing; contact (p=.46)
      // lands exactly at the strike, recovery and the next wind-up fill the cooldown.
      anims.chop(inner, (.46 + (1 - clamp(w.hitCooldown,0,WORKER_HIT_COOLDOWN)/WORKER_HIT_COOLDOWN)) % 1, t);
    } else if(moving){
      if(rec.key.endsWith("+carry") && anims.carryLag && t-rec.moveStart < 1.1)
        anims.carryLag(inner, (t-rec.moveStart)/1.1, t);
      else anims.walk(inner, 0, t);
    } else if(guard && anims.shieldUp){
      // shield rises while an enemy is inside the leash and eases back down after
      let threat = false;
      for(const e of state.enemies)
        if(distance(w.postX,w.postY,e.x,e.y) <= WORKER_LEASH){ threat = true; break; }
      rec.shield = clamp(rec.shield + (threat ? .07 : -.05), 0, 1);
      if(rec.shield > .02){ anims.shieldUp(inner, rec.shield, t); braced = true; }
      else anims.idle(inner, 0, t);
    } else {
      anims.idle(inner, 0, t);
    }
    if(braced && w.combatTarget===null){
      // face the nearest threat while braced, not the last walk direction
      let best=1e9, bx=null, bz=null;
      for(const e of state.enemies){ const d=distance(w.x,w.y,e.x,e.y); if(d<best){best=d;bx=e.x;bz=e.y;} }
      if(bx!==null) rec.yaw += yawWrap(Math.atan2(bx-w.x, bz-w.y)-rec.yaw)*.22;
    }
    setXZ(g, w, 0);
    g.rotation.set(0, rec.yaw, 0);
    g.scale.set(S, S*view.heightScale/100, S);
  }
  for(const [w,rec] of workerStore){
    if(seen.has(w)) continue;
    scene.remove(rec.g); disposeGroup(rec.g); workerStore.delete(w);
  }
}
const syncCorpses = makeLayer(c=>makeCorpse(c.coat), (g,c)=>{
  g.position.set(gx(c.x+c.pose), .1+terrainLiftAt(c.x,c.y), gz(c.y+c.pose*.35));
  g.rotation.y = c.flip<0 ? Math.PI : 0;
});

// Buildings swap their whole mesh when they finish or change tower variant.
const buildingStore = new Map();
function syncBuildings(){
  const seen = new Set(),heldOrbs=heldBuilding()?.type==="damageOrbs"?heldBuilding():null;
  // Carried damage orbs keep their real animated identity; other movable buildings continue using
  // the placement ghost because none of them remain active while held.
  const visibleBuildings=heldOrbs?[...buildings,heldOrbs]:buildings;
  for(const b of visibleBuildings){
    // The finished main base is drawn by syncBase, which owns the fixed anchor placement and the
    // pulse/hurt feedback; two owners at the map centre would double the dome. Its SITE still draws
    // as an ordinary blueprint, which is the whole point.
    if(b.complete && b.type==="mainBase")continue;
    // The blueprint key carries its type: the corner posts sit on the type's own footprint.
    const key = b.complete ? (b.type==="tower" ? "tower:"+(b.tower?.variant||"basic") : b.type) : "blueprint:"+b.type;
    let rec = buildingStore.get(b);
    if(!rec || rec.key!==key){
      if(rec){ scene.remove(rec.g); disposeGroup(rec.g); }
      const g = b.complete ? makeBuilding(b.type) : makeBlueprint(b.type);
      if(b.complete && b.type==="tower" && g.userData.roof)
        g.userData.roof.material.color.setHex(TOWER_TOP[b.tower?.variant] ?? PAL.timberDark);
      g.traverse(o=>{ if(o.isMesh) o.userData.ent = b; });
      scene.add(g);
      rec = {key, g};
      buildingStore.set(b, rec);
    }
    seen.add(b);
    const floating=b===heldOrbs;
    rec.g.visible = !floating||state.mouse.inside;
    if(floating)rec.g.position.set(gx(state.mouse.x),1.6+Math.sin(b.orbs.angle*2)*.16,gz(state.mouse.y));
    else setXZ(rec.g,b);
    rec.g.rotation.x=floating?Math.sin(b.orbs.angle*1.7)*.08:0;
    rec.g.rotation.z=floating?Math.cos(b.orbs.angle*1.4)*.08:0;
    rec.g.scale.y = view.heightScale/100;
    const pulse = 1 + (b.pulse||0)*.12;
    rec.g.scale.x = rec.g.scale.z = pulse;
    if(b.complete && b.type==="tower" && b.tower){
      const hurt = b.tower.hitFlash>0;
      for(const p of rec.g.userData.parts||[]) p.material.emissive.setHex(hurt?PAL.hurtGlow:0x000000);
    }
    if(rec.g.userData.tip) rec.g.userData.tip.rotation.y += .02;
    // The summoning circle reads its whole state off the building: how much dust is in (five
    // floor spokes and five crystals, one pair per dust), and how much of the 120s clock is gone
    // (six add-only decay stages — soot climbing the menhirs, rubble on the rim). The two channels
    // share nothing on purpose, so a guttering circle at 1 dust looks nothing like a fresh one at
    // 4. The module's idle() runs off the same per-frame slot the old tip-spin used; it restores
    // its own rest pose every call and never touches the two state-owned counts above.
    // The summon climax anim is deliberately not wired: the sim consumes the building the frame
    // the fifth dust lands, so there is no entity left to play it on.
    if(b.type==="summoningCircle"&&rec.g.userData.slotMarkers){
      const summoning=b.summoning;
      const dust=summoning?summoning.dust:rec.g.userData.slotMarkers.length;
      rec.g.userData.slotMarkers.forEach((slot,index)=>slot.visible=index<dust);
      const stages=rec.g.userData.ashRings,spent=summoning?1-summoning.remaining/SUMMONING_CIRCLE.duration:0;
      const lit=Math.ceil(spent*stages.length);
      stages.forEach((stage,index)=>stage.visible=index<lit);
      rec.g.userData.anims.idle(rec.g.userData.inner,0,performance.now()/1000);
    }
    if(b.orbs&&rec.g.userData.orbit){rec.g.userData.orbit.rotation.y=b.orbs.angle;rec.g.userData.orbit.position.y=.75+Math.sin(b.orbs.angle*2)*.10;rec.g.userData.orbs.forEach((orb,index)=>orb.visible=index<b.orbs.count);}
    // Derived occupancy drives the sage bay caps directly: one visible cap per living linked ally,
    // so a capture or an ally death changes the model on the very next frame.
    if(b.type==="captureYard"&&rec.g.userData.slotMarkers){const held=captureYardOccupancy(b);rec.g.userData.slotMarkers.forEach((cap,index)=>cap.visible=index<held);}
    // Same contract for the garrison's two station pennants, read off the durable-post status:
    // a pennant flies only for a guard that has ARRIVED, so a reserved-but-travelling slot stays
    // bare and the station reads as under-staffed at a glance. Outside a normal run (showcase,
    // and therefore the placement ghost's untracked copy too) the status is null and the station
    // shows its full dress.
    if(b.type==="garrison"&&rec.g.userData.postMarkers){const staffing=durablePostStatus(b),flying=staffing?staffing.arrived:rec.g.userData.postMarkers.length;rec.g.userData.postMarkers.forEach((pennant,index)=>pennant.visible=index<flying);}
  }
  for(const [b,rec] of buildingStore){
    if(seen.has(b))continue;
    scene.remove(rec.g); disposeGroup(rec.g); buildingStore.delete(b);
  }
}

// The standing main base. ONE fixed dome at the authored BASE anchor, built through the ordinary
// building registry (makeBuilding("mainBase")) and drawn here rather than from its construction
// record, which syncBuildings deliberately skips — the map centre has exactly one owner. There is
// no level-based model swap: authored base levels are read from the overlay, never from the body.
// NOTHING is drawn at the map centre until a base stands (mainBaseStanding): during the pre-wave
// opening the anchor is bare ground, and its unfinished site draws as an ordinary blueprint through
// syncBuildings.
//
// Two sim signals feed the body, and they are different facts:
//   state.basePulse rises to 1 whenever the base NOTICES something (a delivery landing, a hit) and
//     decays over ~1/3 s — it drives a short swell of the dome body.
//   state.baseHp FALLING is the only honest damage signal (basePulse cannot tell a delivery from a
//     hit), and it lights the same PAL.hurtGlow emissive every tower body uses.
let baseRec = null, lastBaseHp = null, baseHurtUntil = -9;
const BASE_HURT_SECONDS = .18;
function syncBase(t){
  if(!mainBaseStanding()){
    if(baseRec){ scene.remove(baseRec); disposeGroup(baseRec); baseRec = null; }
    lastBaseHp = null; baseHurtUntil = -9;
    return;
  }
  if(!baseRec){
    baseRec = makeBuilding("mainBase");
    baseRec.position.set(gx(BASE.x), 0, gz(BASE.y));
    scene.add(baseRec);
  }
  baseRec.scale.y = view.heightScale/100;
  if(lastBaseHp !== null && state.baseHp < lastBaseHp) baseHurtUntil = t + BASE_HURT_SECONDS;
  lastBaseHp = state.baseHp;
  const hurt = t < baseHurtUntil;
  for(const part of baseRec.userData.parts){
    part.material.emissive.setHex(hurt ? PAL.hurtGlow : 0x000000);
    part.scale.setScalar(1 + state.basePulse*.05);
  }
}

// ─────────────────────────────────────────────────────────── ground rings (zones)
const ringGeo = new THREE.RingGeometry(.985,1,64);
const ringPool = [];
let ringUsed = 0;
function ring(x, y, radiusPx, color=css(PAL.hint), opacity=.6){
  let m = ringPool[ringUsed];
  if(!m){
    m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      transparent:true, side:THREE.DoubleSide, depthWrite:false}));
    m.rotation.x = -Math.PI/2;
    ringPool.push(m); scene.add(m);
  }
  ringUsed++;
  m.visible = true;
  m.position.set(gx(x), .09+terrainLiftAt(x,y), gz(y));
  m.scale.setScalar(radiusPx*S);
  m.material.color.set(color);
  m.material.opacity = opacity;
  return m;
}
function endRings(){ for(let i=ringUsed;i<ringPool.length;i++) ringPool[i].visible=false; ringUsed=0; }

// ─────────────────────────────────────────────────────────── attack visuals
// Every ranged attack already records where it fired and a decaying flash; the
// sim applies damage instantly, so these are pure feedback drawn from that.
const beamGeo = new THREE.CylinderGeometry(1,1,1,6,1,true);
const flashGeo = new THREE.IcosahedronGeometry(1,0);
const beamPool = [], flashPool = [];
let beamUsed = 0, flashUsed = 0;
const _bA = new THREE.Vector3(), _bB = new THREE.Vector3(), _bD = new THREE.Vector3();
const _upY = new THREE.Vector3(0,1,0);

/** A cylinder stretched between two points, both in game (x, y) plus world height. */
function beam(x1,y1,h1, x2,y2,h2, radius, color, alpha){
  _bA.set(gx(x1), h1, gz(y1));
  _bB.set(gx(x2), h2, gz(y2));
  _bD.subVectors(_bB, _bA);
  const len = _bD.length();
  if(len < 1e-4) return;

  let m = beamPool[beamUsed];
  if(!m){
    m = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({transparent:true, depthWrite:false}));
    beamPool.push(m); scene.add(m);
  }
  beamUsed++;
  m.visible = true;
  m.position.copy(_bA).addScaledVector(_bD, .5);
  m.quaternion.setFromUnitVectors(_upY, _bD.normalize());
  m.scale.set(radius, len, radius);
  m.material.color.set(color);
  m.material.opacity = clamp(alpha, 0, 1);
}
function muzzle(x, y, h, size, color, alpha){
  let m = flashPool[flashUsed];
  if(!m){
    m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({transparent:true, depthWrite:false}));
    flashPool.push(m); scene.add(m);
  }
  flashUsed++;
  m.visible = true;
  m.position.set(gx(x), h+terrainLiftAt(x,y), gz(y));
  m.scale.setScalar(size);
  m.material.color.set(color);
  m.material.opacity = clamp(alpha, 0, 1);
}
function endAttacks(){
  for(let i=beamUsed;i<beamPool.length;i++) beamPool[i].visible=false;
  for(let i=flashUsed;i<flashPool.length;i++) flashPool[i].visible=false;
  beamUsed = flashUsed = 0;
}

// ── travelling shots ────────────────────────────────────────────────────────
// Purely visual. The sim resolves damage the instant a tower fires, so these
// balls are a short flight after the fact — kept brief enough that the target
// has not visibly reacted before the shot lands.
const SHOT_GEO = new THREE.DodecahedronGeometry(.30, 0);
const shotPool = [], shots = [], impacts = [];
const lastFlash = new WeakMap();

function spawnShot(x1,y1,h1, x2,y2,h2, color, size, arc, impact){
  const from = new THREE.Vector3(gx(x1), h1, gz(y1));
  const to   = new THREE.Vector3(gx(x2), h2, gz(y2));
  let mesh = shotPool.pop();
  if(!mesh){
    mesh = new THREE.Mesh(SHOT_GEO, new THREE.MeshLambertMaterial({flatShading:true}));
    mesh.castShadow = false;                  // keeps them out of the occlusion scan
    scene.add(mesh);
  }
  mesh.visible = true;
  mesh.material.color.set(color);
  mesh.scale.setScalar(size*VIEW_TUNE.shotSize);
  shots.push({mesh, from, to, t:0,
    dur: clamp(from.distanceTo(to)/VIEW_TUNE.shotSpeed, .1, .9),
    arc: arc*VIEW_TUNE.shotArc, impact});
}

function stepShots(dt){
  for(let i=shots.length-1; i>=0; i--){
    const s = shots[i];
    s.t += dt/s.dur;
    const p = Math.min(s.t, 1);
    s.mesh.position.lerpVectors(s.from, s.to, p);
    s.mesh.position.y += Math.sin(p*Math.PI)*s.arc;
    s.mesh.rotation.x += dt*13;
    s.mesh.rotation.y += dt*9;
    if(p < 1) continue;
    s.mesh.visible = false;
    shotPool.push(s.mesh);
    shots.splice(i, 1);
    if(s.impact) impacts.push({...s.impact, t:0});
  }
  for(let i=impacts.length-1; i>=0; i--){
    impacts[i].t += dt/0.28;
    if(impacts[i].t >= 1) impacts.splice(i, 1);
  }
}

// ── falling meteors ─────────────────────────────────────────────────────────
// The sim owns all timing (fallingMeteors records; damage on landing). Everything here is
// presentation: the rock streaking in at an angle with a fiery wake, the target ring closing as it
// nears the ground, and the landing blast. A record vanishing from fallingMeteors with its clock
// run out IS the impact cue — a vanished record whose clock had time left was a run reset instead,
// so that one spawns no blast.
const METEOR_FX = {
  height: 34,        // world-unit entry altitude
  driftX: -170,      // sim-px lateral entry offset — the diagonal streak
  driftY: -80,
  blastDur: .55,     // seconds the landing rings take to wash out
};
const meteorGeo = new THREE.DodecahedronGeometry(1, 0);
const meteorPool = []; let meteorUsed = 0;
const meteorTracked = new Set(); const meteorBlasts = [];

function stepMeteors(dt){
  for(const m of fallingMeteors) meteorTracked.add(m);
  for(const m of meteorTracked) if(!fallingMeteors.includes(m)){
    meteorTracked.delete(m);
    if(m.t >= m.dur) meteorBlasts.push({x:m.x, y:m.y, t:0});
  }
  for(let i=meteorBlasts.length-1; i>=0; i--){
    meteorBlasts[i].t += dt/METEOR_FX.blastDur;
    if(meteorBlasts[i].t >= 1) meteorBlasts.splice(i, 1);
  }
}

/** Claims beams/muzzles/rings, so drawAttacks() calls it before its own endAttacks(). */
function drawMeteors(){
  meteorUsed = 0;
  const nowT = performance.now()/1000;
  for(const m of fallingMeteors){
    const p = clamp(m.t/m.dur, 0, 1), e = p*p;            // gravity: lazy entry, violent landing
    const sx = m.x + METEOR_FX.driftX*(1-e), sy = m.y + METEOR_FX.driftY*(1-e);
    const h = .9 + METEOR_FX.height*(1-e);
    let mesh = meteorPool[meteorUsed];
    if(!mesh){
      mesh = new THREE.Mesh(meteorGeo, new THREE.MeshLambertMaterial({flatShading:true, color:"#6b4a38"}));
      mesh.castShadow = false;
      meteorPool.push(mesh); scene.add(mesh);
    }
    meteorUsed++;
    mesh.visible = true;
    mesh.position.set(gx(sx), h, gz(sy));
    mesh.rotation.set(nowT*3.1, nowT*2.3, m.t*4);
    mesh.scale.setScalar(1.0 + .4*e);
    // Fiery wake back up the entry line: a wide ember sheath around a hotter core, glow on the head.
    // The wake is two segments kinked at a wandering midpoint, and everything flickers on its own
    // per-meteor phase, so it burns rather than reading as a drawn line.
    const flick = .8 + .2*Math.sin(nowT*43 + m.x);
    const backX = sx + METEOR_FX.driftX*.4, backY = sy + METEOR_FX.driftY*.4;
    const backH = h + METEOR_FX.height*.4;
    const dlen = Math.hypot(METEOR_FX.driftX, METEOR_FX.driftY);
    const wob = Math.sin(nowT*29 + m.y)*22;              // sim-px sideways kink
    const midX = (sx+backX)/2 - METEOR_FX.driftY/dlen*wob;
    const midY = (sy+backY)/2 + METEOR_FX.driftX/dlen*wob;
    const midH = (h+backH)/2;
    beam(backX, backY, backH, midX, midY, midH, .26+.14*e, "#e8873f", .45*flick);
    beam(midX, midY, midH, sx, sy, h, .30+.18*e, "#e8873f", .55*flick);
    beam(backX, backY, backH, midX, midY, midH, .11, "#f6c86e", .7*flick);
    beam(midX, midY, midH, sx, sy, h, .13, "#f6c86e", .85*flick);
    muzzle(sx, sy, h, (.9 + .6*e)*(.85 + .3*flick), "#f2a24d", .8);
    // Ground telegraph: the full blast radius holds while an inner ring closes with the descent.
    ring(m.x, m.y, METEOR.radius, "#e18a43", .2 + .5*e);
    ring(m.x, m.y, METEOR.radius*(1 - .8*e), "#f3c76a", .55);
  }
  for(let i=meteorUsed; i<meteorPool.length; i++) meteorPool[i].visible = false;

  for(const b of meteorBlasts){
    const q = b.t;
    // Shockwave pair racing outward, plus a brief flash and light pillar right at touchdown.
    ring(b.x, b.y, METEOR.radius*(.25+.75*q), "#e8873f", (1-q)*.9);
    ring(b.x, b.y, METEOR.radius*.6*(.2+.8*q), "#f3c76a", (1-q)*.7);
    if(q < .35) muzzle(b.x, b.y, 1.1, 1.2 + 2.4*(1-q/.35), "#f6d27c", 1-q/.35);
    if(q < .3)  beam(b.x, b.y, METEOR_FX.height*.75, b.x, b.y, .4, .9*(1-q/.3), "#f6d27c", .85*(1-q/.3));
  }
}

// Fireballs use their own straight-down silhouette. The hot sphere, vertical wake, closing target
// ring and impact flash all read the simulation-owned fallingFireballs clock. Damage still lands in
// simulation.js, never here.
const FIREBALL_FX = {height:26, blastDur:.42};
const fireballGeo = new THREE.IcosahedronGeometry(1, 1);
const fireballCoreMat = new THREE.MeshBasicMaterial({color:"#ffd35a"});
const fireballShellMat = new THREE.MeshBasicMaterial({color:"#ff642f",transparent:true,opacity:.58,depthWrite:false});
const fireballPool = []; let fireballUsed = 0;
const fireballTracked = new Set(); const fireballBlasts = [];

function stepFireballs(dt){
  for(const f of fallingFireballs)fireballTracked.add(f);
  for(const f of fireballTracked)if(!fallingFireballs.includes(f)){
    fireballTracked.delete(f);
    if(f.t>=f.dur)fireballBlasts.push({x:f.x,y:f.y,t:0});
  }
  for(let i=fireballBlasts.length-1;i>=0;i--){
    fireballBlasts[i].t+=dt/FIREBALL_FX.blastDur;
    if(fireballBlasts[i].t>=1)fireballBlasts.splice(i,1);
  }
}

function drawFireballs(){
  fireballUsed=0;
  const nowT=performance.now()/1000;
  for(const f of fallingFireballs){
    const p=clamp(f.t/f.dur,0,1),e=p*p;
    const h=.75+FIREBALL_FX.height*(1-e);
    let group=fireballPool[fireballUsed];
    if(!group){
      group=new THREE.Group();
      const core=new THREE.Mesh(fireballGeo,fireballCoreMat),shell=new THREE.Mesh(fireballGeo,fireballShellMat);
      core.scale.setScalar(1.18);shell.scale.setScalar(1.62);core.castShadow=shell.castShadow=false;
      group.add(core,shell);fireballPool.push(group);scene.add(group);
    }
    fireballUsed++;
    group.visible=true;group.position.set(gx(f.x),h,gz(f.y));group.rotation.set(nowT*4.2,f.t*7.5,nowT*3.4);
    group.scale.setScalar((1+.38*e)*(.96+.06*Math.sin(nowT*47+f.x)));

    const flick=.82+.18*Math.sin(nowT*39+f.y);
    const tailH=h+8+8*(1-e);
    beam(f.x,f.y,tailH,f.x,f.y,h,.54+.18*e,"#e24528",.62*flick);
    beam(f.x,f.y,tailH-1,f.x,f.y,h,.24+.08*e,"#ffd36a",.92*flick);
    muzzle(f.x,f.y,h,1.5+.5*e,"#ff9b3d",.88);
    ring(f.x,f.y,FIREBALL.radius,"#c9432c",.18+.55*e);
    ring(f.x,f.y,FIREBALL.radius*(1-.82*e),"#ffb34f",.7);
  }
  for(let i=fireballUsed;i<fireballPool.length;i++)fireballPool[i].visible=false;

  for(const b of fireballBlasts){
    const q=b.t,fade=1-q;
    ring(b.x,b.y,FIREBALL.radius*(.18+.82*q),"#e64e2d",fade*.95);
    ring(b.x,b.y,FIREBALL.radius*(.08+.55*q),"#ffd36a",fade*.8);
    if(q<.42)muzzle(b.x,b.y,.9,1.1+2.8*(1-q/.42),"#ffd36a",1-q/.42);
    if(q<.28)beam(b.x,b.y,FIREBALL_FX.height*.55,b.x,b.y,.35,.72*(1-q/.28),"#ff7a32",.9*(1-q/.28));
  }
}

// The base's shot colour, matched by hand to the impact burst simulation.js emits for the same hit
// (updateBaseAttack). Not a PAL role: nothing else in the world wears it.
const BASE_SHOT_COL = "#efe0a0";
function drawAttacks(){
  const hs = view.heightScale/100;

  for(const b of buildings){
    if(!b.complete || b.type!=="tower" || !b.tower) continue;
    const t = b.tower, v = towerVariant(b);
    const col = v.impactColor || v.accent || css(PAL.ok);
    const topH = 3.7*hs;                       // open platform inside the chassis roof
    const area = v.attackMode==="periodic area" || v.attackMode==="manual area";

    // A rising flash means it just fired. Launch the visual for that shot.
    const prev = lastFlash.get(b) ?? 0;
    if(t.flash > prev){
      if(v.attackMode==="splash" && t.impactX!==undefined)
        spawnShot(b.x,b.y,topH, t.impactX,t.impactY, .35, col, 1.6, 2.4,
                  {x:t.impactX, y:t.impactY, r:v.splashRadius||40, col});
      else if(!area && v.attackMode!=="line" && v.attackMode!=="chain" && t.targetX!==undefined)
        spawnShot(b.x,b.y,topH, t.targetX,t.targetY, .7, col, 1, 1.0, null);
    }
    lastFlash.set(b, t.flash);

    if(t.flash <= 0) continue;
    const a = clamp(t.flash*3.2, 0, 1);
    if(area){
      // Shockwave grows outward as the flash decays.
      const grow = 1 - clamp(t.flash/.4, 0, 1);
      ring(b.x, b.y, (v.effectRadius||60)*(.25+.75*grow), col, a*.85);
    } else if(v.attackMode==="line" && t.targetX!==undefined){
      beam(b.x, b.y, topH, t.targetX, t.targetY, .5, (v.beamWidth||10)*S*.5, col, a);
    }
    muzzle(b.x, b.y, topH, .22 + .42*a, col, a);
  }

  // The standing base defends itself (simulation.js updateBaseAttack) and reads exactly like a
  // tower doing it: same rising-flash edge, same travelling shot, same muzzle. It has no variant —
  // the numbers are MAIN_BASE's — so the colour is fixed rather than looked up.
  if(mainBaseStanding()){
    const attack = state.baseAttack, muzzleH = 4.2*hs;
    const prevBaseFlash = lastFlash.get(BASE) ?? 0;
    if(attack.flash > prevBaseFlash)
      spawnShot(BASE.x, BASE.y, muzzleH, attack.targetX, attack.targetY, .7, BASE_SHOT_COL, 1, 1.0, null);
    lastFlash.set(BASE, attack.flash);
    if(attack.flash > 0){
      const a = clamp(attack.flash*3.2, 0, 1);
      muzzle(BASE.x, BASE.y, muzzleH, .22 + .5*a, BASE_SHOT_COL, a);
    }
  }

  // Splash rings fire when the shell lands, not when the barrel flashes.
  for(const im of impacts)
    ring(im.x, im.y, im.r*(.3+.7*im.t), im.col, (1-im.t)*.9);

  for(const e of state.enemies){
    // The body is hidden under standing fog, so its muzzle/heal beams go with it: a bolt leaving an
    // empty fog block would point at a shooter the player cannot see or click.
    if(fogAtPoint(e.x,e.y)) continue;
    // The archer's bolt is the clearest "an enemy is damaging you" event in the frame, and it was
    // GOLD — the builder's hi-vis and the coin (palette.js COLOUR THEORY). It is the enemy ability
    // register now, the same red the creature's own seams and muzzle core wear.
    if(e.shotFlash > 0)
      beam(e.x, e.y, .8, e.shotX ?? BASE.x, e.shotY ?? BASE.y, .7, .055,
           css(PAL.enemyAbility), clamp(e.shotFlash*7, 0, 1));
    if(e.healFlash > 0 && e.healX!==undefined)
      beam(e.x, e.y, 1.0, e.healX, e.healY, 1.0, .07,
           "#75c86d", clamp(e.healFlash*3, 0, 1));
  }

  for(const w of state.workers)
    if(w.combatTarget && w.attackCooldown > WORKER_ATTACK_RATE-.2)
      beam(w.x, w.y, .8, w.combatTarget.x, w.combatTarget.y, .7, .06, "#f3dfa3", .85);

  drawMeteors();
  drawFireballs();

  // Lightning arcs (chainLightning buff + lightning tower). Damage already landed in the sim;
  // each record is one jump, drawn as a short-lived jagged bolt. The per-arc seed keeps the
  // kinks still while the bolt fades, so it reads as one strike rather than a flickering wire.
  for(const arc of lightningArcs){
    const a = clamp(1 - arc.age/.4, 0, 1);
    if(a <= 0) continue;
    const dx = arc.x2-arc.x1, dy = arc.y2-arc.y1, len = Math.hypot(dx,dy) || 1;
    const nx = -dy/len, ny = dx/len;                  // unit normal for the kink offsets
    const kinks = 3;
    let px = arc.x1, py = arc.y1, ph = 1.1;
    for(let i=1; i<=kinks+1; i++){
      const t = i/(kinks+1), last = i===kinks+1;
      // deterministic pseudo-random kink from the arc's seed; end points stay exact
      const wob = last ? 0 : (Math.sin((arc.seed*97+i)*12.9898)*.5)*Math.min(28, len*.3);
      const x = arc.x1+dx*t+nx*wob, y = arc.y1+dy*t+ny*wob, h = last ? 1.1 : 1.1+Math.abs(wob)*.02;
      beam(px,py,ph, x,y,h, .07, "#cfe4ff", a);
      px=x; py=y; ph=h;
    }
    muzzle(arc.x2, arc.y2, 1.0, .14+.3*a, "#cfe4ff", a);
  }

  endAttacks();
}

// ─────────────────────────────────────────────────────────── occluded markers
// Populated by the debugger's visibility measurement, which already computes the
// hidden positions while it counts visibility.
const pins = new THREE.Group();
scene.add(pins);
const pinGeo = new THREE.ConeGeometry(.6,1.4,4);
const pinMat = new THREE.MeshBasicMaterial({color:PAL.pin, depthTest:false, transparent:true, opacity:.9});
export function setPins(points){
  pins.clear();
  if(!view.ghostPins)return;
  for(const p of points){
    const m = new THREE.Mesh(pinGeo, pinMat);
    m.position.set(p.x, p.y + 3.4, p.z);
    m.rotation.x = Math.PI;          // point down at the thing you can't see
    m.renderOrder = 999;
    pins.add(m);
  }
}

// ─────────────────────────────────────────────────────────── particles
const partGeo = new THREE.BoxGeometry(.18,.18,.18);
const partPool = [];
let partUsed = 0;
function syncParticles(){
  partUsed = 0;
  for(const p of particles){
    let m = partPool[partUsed];
    if(!m){
      m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({transparent:true}));
      partPool.push(m); scene.add(m);
    }
    partUsed++;
    m.visible = true;
    m.position.set(gx(p.x), .45 + Math.max(0,p.life)*1.2, gz(p.y));
    m.material.color.set(p.col);
    m.material.opacity = clamp(p.life*3,0,1);
    // `size` is the sim's optional per-piece scale (the fx* emitters write it; burst() never does),
    // so heavy debris reads as chunks and dust as grit without needing a second particle pool.
    const s = (p.resource ? 1.6 : 1) * (p.size || 1);
    m.scale.setScalar(s);
  }
  for(let i=partUsed;i<partPool.length;i++) partPool[i].visible=false;
}

// ─────────────────────────────────────────────────────────── the hand
// state.carried is just counts, so the pile is rebuilt whenever those change.
// Golden-angle stacking keeps it legible as it grows past a couple of items.
const hand = new THREE.Group();
scene.add(hand);
const handItems = [];
let handSig = "";

function syncHand(){
  const t = performance.now()/1000;
  const want = [];
  for(const kind of RESOURCE_KINDS)
    for(let i=0;i<state.carried[kind];i++) want.push(kind);

  const sig = want.join(",");
  if(sig !== handSig){
    const grew = want.length > handItems.length;
    for(const it of handItems){ hand.remove(it.mesh); it.mesh.geometry.dispose(); it.mesh.material.dispose(); }
    handItems.length = 0;
    want.forEach((kind,i)=>{
      const mesh = handMeshFor(kind);
      hand.add(mesh);
      const a = i*2.399, r = .26*Math.sqrt(i);
      handItems.push({mesh, phase:Math.random()*6.28,
        pop:(grew && i===want.length-1) ? 1 : 0,
        home:new THREE.Vector3(Math.cos(a)*r, i*.2, Math.sin(a)*r)});
    });
    handSig = sig;
  }

  hand.visible = state.mouse.inside && handItems.length>0;
  if(!hand.visible)return;
  hand.position.set(gx(state.mouse.x), 2.5 + Math.sin(t*5)*.09, gz(state.mouse.y));
  hand.rotation.y += .009;
  for(const it of handItems){
    it.mesh.position.set(it.home.x, it.home.y + Math.sin(t*3.2+it.phase)*.06, it.home.z);
    if(it.pop>0){ it.pop = Math.max(0, it.pop-.05); it.mesh.scale.setScalar(1 + it.pop*.9); }
  }
}

// ─────────────────────────────────────────────────────────── scale-reference balls
// The test scene's red dome pair (tools/test-scene/preset.js OBJECTS "red"/"red-1x1": sink 0.46
// of the diameter, albedo 0xc84d3f — solved for the rig the game now runs), parked east of the
// base anchor for size/shading comparison. Sized on the PLACEMENT GRID: 1 cell = 2 wu,
// big ball 3x3 cells (r 3), small ball 1x1 (r 1). R panel "camera / sun" → "scale ball" toggles
// both; built lazily so a normal session never pays for it. SMOOTH spheres on purpose: faceting
// re-inks every quad seam under the pixel pipeline's normal-edge pass (test-scene round-3
// finding). Debug-only — never referenced by the simulation.
let scaleBall = null;
function setScaleBall(on){
  if(on && !scaleBall){
    scaleBall = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({color: 0xc84d3f});
    // [radius wu, east offset from the BASE anchor in game px]: big ball parked against the base
    // footprint, small one just past it. Ground seat matches the buildings' plane (GROUND_Y).
    for(const [r, off] of [[3, 45 + BASE.r], [1, 45 + BASE.r + 70]]){
      const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), mat);
      ball.castShadow = ball.receiveShadow = true;
      ball.position.set(gx(BASE.x + off), GROUND_Y + r*(1 - 2*.46), gz(BASE.y));
      scaleBall.add(ball);
    }
    scene.add(scaleBall);
  }
  if(scaleBall) scaleBall.visible = on;
}

// ─────────────────────────────────────────────────────────── the base pile
// state.stored is just counts (storeAtBase credits it, builders withdraw), and the design rule is
// that resources stay PHYSICAL: the banked stock is shown as an actual pile at the base's south
// edge, not a number. Same rebuild-on-signature trick as the cursor hand above. The display caps
// at PILE_MAX items so a late-game bank cannot flood the scene with meshes.
const basePile = new THREE.Group();
basePile.position.set(gx(BASE.x), GROUND_Y, gz(BASE.y + BASE.r + 26));
scene.add(basePile);
const pileItems = [];
let pileSig = "";
const PILE_MAX = 80;

function syncBasePile(){
  const want = [];
  for(const kind of RESOURCE_KINDS)
    for(let i=0;i<state.stored[kind] && want.length<PILE_MAX;i++) want.push(kind);

  const sig = want.join(",");
  if(sig !== pileSig){
    const grew = want.length > pileItems.length;
    for(const it of pileItems){ basePile.remove(it.mesh); disposeGroup(it.mesh); }
    pileItems.length = 0;
    // Golden-angle spiral, kinds grouped by the ordered fill above so each resource clusters into
    // its own wedge; a little seeded height/spin jitter keeps it a pile rather than a lattice.
    want.forEach((kind,i)=>{
      const mesh = makeDrop(kind);
      basePile.add(mesh);
      const a = i*2.399, r = .35 + .25*Math.sqrt(i);
      mesh.position.set(Math.cos(a)*r, .1 + (i%3)*.12, Math.sin(a)*r);
      mesh.rotation.y = a*1.7;
      mesh.scale.setScalar(.8);
      pileItems.push({mesh, pop:(grew && i===want.length-1) ? 1 : 0});
    });
    pileSig = sig;
  }

  basePile.visible = pileItems.length>0 && mainBaseStanding();
  for(const it of pileItems)
    if(it.pop>0){ it.pop = Math.max(0, it.pop-.05); it.mesh.scale.setScalar(.8*(1 + it.pop*.9)); }
}

// ─────────────────────────────────────────────────────────── previews (ghosts)
const ghostBuild = {key:null, g:null};
function showGhostBuilding(type, x, y, ok, lift=0){
  const key = type;
  if(ghostBuild.key!==key){
    if(ghostBuild.g){ scene.remove(ghostBuild.g); disposeGroup(ghostBuild.g); }
    ghostBuild.g = makeBuilding(type);
    // depthWrite off as well as transparent: a 1x1 model is wider than its cell, so a depth-writing
    // ghost would bury the reserved-cell quads underneath it and the footprint would go unseen.
    ghostBuild.g.traverse(o=>{ if(o.isMesh && !isOutline(o)){ o.material.transparent=true; o.material.opacity=.5; o.material.depthWrite=false; o.castShadow=false; } });
    scene.add(ghostBuild.g);
    ghostBuild.key = key;
  }
  ghostBuild.g.visible = true;
  ghostBuild.g.position.set(gx(x), lift, gz(y));
  ghostBuild.g.traverse(o=>{ if(o.isMesh && !isOutline(o)) o.material.emissive.setHex(ok?PAL.ghostOk:PAL.ghostBad); });
}
function hideGhostBuilding(){ if(ghostBuild.g) ghostBuild.g.visible=false; }

// ── footprint preview ───────────────────────────────────────────────────────
// One tinted quad per cell footprintCells() reserves, plus a border on the footprint's exact world
// rect. The player sees the same cells canPlace() tested and the same rectangle the soil stamp
// under the finished building will paint, so preview and commitment share one source of dimensions.
// Depth: the quads ride just above the ground seat (GROUND_Y) so an invalid placement over an
// existing building still shows red instead of being swallowed by the terrain. They keep depthTest
// on — trees and towers still occlude them correctly — with depthWrite off and a negative polygon
// offset so nothing coplanar (a tar puddle, the land) can flicker against them.
// Ownership: these live directly in the scene, never inside a group disposeGroup() will visit, so
// their geometry and materials are shared module singletons and are never disposed.
const CELL_U = CELL*S;                 // one cell in world units
const GHOST_Y = GROUND_Y + .035;
const CELL_GAP = .07;                  // hairline seam so each reserved cell reads as its own square
const cellGeo = new THREE.PlaneGeometry(1,1);
const edgeGeo = new THREE.BufferGeometry().setAttribute("position",
  new THREE.Float32BufferAttribute([-.5,0,-.5,  .5,0,-.5,  .5,0,.5,  -.5,0,.5], 3));
const cellMat = ok => new THREE.MeshBasicMaterial({
  color: ok?PAL.cellOk:PAL.cellBad, transparent:true, opacity:.34, depthWrite:false,
  side:THREE.DoubleSide, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2});
const edgeMat = ok => new THREE.LineBasicMaterial({
  color: ok?PAL.cellOk:PAL.cellBad, transparent:true, opacity:.85, depthWrite:false});
const CELL_MAT = {ok:cellMat(true), bad:cellMat(false)};
const EDGE_MAT = {ok:edgeMat(true), bad:edgeMat(false)};
const cellPool = [];
let footprintEdge = null;

function showFootprint(type, x, y, ok){
  const fp = buildingFootprint(type), c = worldToCell(x, y);
  const cells = footprintCells(c.cx, c.cy, fp);
  for(let i=0;i<cells.length;i++){
    let m = cellPool[i];
    if(!m){
      m = new THREE.Mesh(cellGeo, CELL_MAT.ok);
      m.rotation.x = -Math.PI/2;                 // plane XY -> ground XZ
      m.castShadow = m.receiveShadow = false;    // never a shadow caster => never an occlusion blocker
      m.renderOrder = 2;
      cellPool.push(m); scene.add(m);
    }
    const w = cellToWorld(cells[i].cx, cells[i].cy);
    m.visible = true;
    m.material = ok?CELL_MAT.ok:CELL_MAT.bad;
    m.position.set(gx(w.x), GHOST_Y, gz(w.y));
    m.scale.set(CELL_U-CELL_GAP, CELL_U-CELL_GAP, 1);
  }
  for(let i=cells.length;i<cellPool.length;i++) cellPool[i].visible=false;
  // The border is the authority on extents: exactly footprintWorldRect(), the reserved rect.
  if(!footprintEdge){
    footprintEdge = new THREE.LineLoop(edgeGeo, EDGE_MAT.ok);
    footprintEdge.castShadow = footprintEdge.receiveShadow = false;
    footprintEdge.renderOrder = 3;
    scene.add(footprintEdge);
  }
  const r = footprintWorldRect(c.cx, c.cy, fp);
  footprintEdge.visible = true;
  footprintEdge.material = ok?EDGE_MAT.ok:EDGE_MAT.bad;
  footprintEdge.position.set(gx(r.x+r.w/2), GHOST_Y+.004, gz(r.y+r.h/2));
  footprintEdge.scale.set(r.w*S, 1, r.h*S);
}
function hideFootprint(){
  for(const m of cellPool) m.visible=false;
  if(footprintEdge) footprintEdge.visible=false;
}

// ── selection indicators ────────────────────────────────────────────────────
// Two reusable ground marks — a four-cornered selector bracket and a segmented radius ring — built
// here. drawZones() aims both: the selector at the primary-action target, at the footprint of a
// building being placed or relocated, and at the footprint of the completed building under the
// cursor; the radius ring at that building's real coverage.
//
// Data flow (render-only): every call is (where, how big, what colour). Neither function reads or
// writes simulation state, keeps a reference to an entity, or remembers a selection between frames,
// so the sim stays the only owner of positions, footprints and radii. Claim-per-frame like the ring
// pool above: show*() claims the next free slot, end*() hides whatever went unclaimed, and hide*()
// drops the whole set — so callers never track slot indices.
//
// Dimensions: showSelector() takes the SAME rect shape footprintWorldRect() returns ({x,y,w,h}, sim
// pixels, top-left anchored). A selector around a placed building therefore reuses the exact rect
// its footprint covers, cellWorldRect() supplies the one-CELL case out of the same lattice, and
// pointWorldRect() supplies it off-lattice for things that move continuously. No size is restated
// here — the footprint table stays the single source of dimensions.
//
// Ownership / geometry lifetime: both pools grow on demand and never shrink. A slot's group, meshes,
// materials and (for the radius ring) its position buffer live from first use until the page
// unloads. They are added straight to the scene, never parented into a group disposeGroup() visits,
// so nothing here is ever disposed and a redraw only rewrites transforms and colours — no mesh,
// geometry or material is allocated per frame. The selector arms share cellGeo, the unit quad the
// footprint preview above already owns. The radius ring cannot share one unit geometry because a
// uniform scale would fatten its band with the circle, so each slot owns one buffer that is
// REWRITTEN IN PLACE (same Float32Array, same mesh) only when that slot's radius actually changes.
//
// Depth: both ride above GHOST_Y, so they clear the ground seat (GROUND_Y), previews and the border
// without z-fighting; depthTest stays on so towers and trees still occlude them, with depthWrite off
// and a negative polygon offset so nothing coplanar can flicker against them.
//
// Exclusion: castShadow=false on every mesh keeps them out of scanBlockers() (`isMesh && visible &&
// castShadow`) and therefore out of both the occlusion scan and the sun's shadow map — the same
// technique the footprint quads use. They are built with `new THREE.Mesh`, never meshOf(), so no
// outline shell is registered and setOutlines() cannot reach them. Hover picking raycasts the math
// ground plane (groundFromEvent), never scene objects, so they are unpickable by construction.
//
// Night: unlit MeshBasicMaterial, so they hold the same readable value under the night sun tint
// instead of going black, and low default opacity keeps them from dominating the frame.
const SELECT_Y = GHOST_Y + .016;      // above the footprint quads (GHOST_Y) and their border (+.004)
const RADIUS_Y = GHOST_Y + .010;
const NO_OPTS = Object.freeze({});    // shared default so an omitted opts bag allocates nothing

/** One-CELL rect, same shape as footprintWorldRect(), around the cell containing a world point. */
function cellWorldRect(x, y){
  const c = worldToCell(x, y);
  return footprintWorldRect(c.cx, c.cy, FOOTPRINT_1x1);
}
/**
 * Same rect shape and same footprint-derived size, but centred on the point itself instead of on the
 * cell containing it. For things that live off the lattice — enemies walk continuously, so snapping
 * their mark would make it jump a whole cell at a time while they slide.
 */
function pointWorldRect(x, y, footprint=FOOTPRINT_1x1){
  const w = footprint.w*CELL, h = footprint.h*CELL;
  return {x:x - w/2, y:y - h/2, w, h};
}

// ── shared indicator tunables ──
// PRESENTATION ONLY. Every field here changes how a mark is drawn and nothing else: no footprint is
// measured from these, no gameplay radius is derived from them, and indicatorRadius() never reads
// them. A ring's RADIUS in particular is always the simulation's own number — the breath below moves
// its opacity, never its size, so an indicator can never advertise coverage the sim does not have.
//
// All three call sites (the one-cell action bracket, the placement/relocation preview and the
// building-hover mark) go through indicatorPulse()/indicatorRingOpacity(), so one knob retimes or
// restyles the whole language at once and two marks alive on the same frame stay in phase.
// MUTABLE HOLDER: the `selectors` pane writes these as properties on the imported object.
export const IND = {
  pulseAmt: .07,      // corner breath: half-amplitude as a fraction of the resting half-extent
  pulseSpeed: 4,      // rad/s, shared by corners and rings so they never beat against each other
  thick: .10,         // corner stroke width, world units
  cornerOpacity: .85, // corner brackets' base opacity, before the per-site weight below
  ringOpacity: .42,   // segmented ring's mid opacity, the centre of its breath
  follow: .28,        // cursor bracket glide: fraction of the remaining gap closed per 60Hz frame
};
// Hard ceiling on the breath, applied AFTER the per-site weight. The tightest case is a 1x1 bracket,
// where the arms are cut at .68 of a 1.0 half-extent: at .20 the corners pull in to .80 and still
// leave a .12 gap either side of the centre, so opposite brackets can never cross or fuse, and they
// never push out far enough to read as detached from the thing they frame. The slider is capped to
// the same number, so the clamp is a floor under a bad value rather than a surprise.
const IND_PULSE_MAX = .20;
// Per-site weights on IND.pulseAmt, written as ratios of the amplitudes this shipped with so the
// defaults reproduce the original look exactly while a single knob still scales all of them together.
const IND_PULSE_ACTION = 9/7;    // the one-cell action bracket breathes a touch deeper (.09 vs .07)
const IND_RING_PULSE   = 13/7;   // rings breathe in opacity, not size (.13 against the corners' .07)
// Same ratio trick for corner opacity: a placement/relocation verdict is the one mark the player is
// about to COMMIT to, so its corners sit a shade firmer than the informational ones (.90 vs .85).
const IND_OPACITY_PLACEMENT = 18/17;
// The idle bracket is the quietest state there is — nothing is under the pointer, it is only saying
// "the grid is here and this is the cell you are on" — so it sits well under the informational marks.
const IND_OPACITY_IDLE = .55;

/** Multiplier on a selector rect's half-extents at time t. weight scales the shared amplitude. */
function indicatorPulse(t, weight=1){
  return 1 + Math.sin(t*IND.pulseSpeed)*clamp(IND.pulseAmt*weight, 0, IND_PULSE_MAX);
}
/**
 * Opacity for a selector's corner brackets. weight scales the shared base the same way the pulse
 * weights do, and the clamp keeps a weighted site legal when the slider is pushed to 1.
 */
function indicatorCornerOpacity(weight=1){
  return clamp(IND.cornerOpacity*weight, 0, 1);
}
/**
 * Opacity for a segmented radius ring at time t. Amplitude is capped at three quarters of the base,
 * so a ring turned down to the slider's dimmest setting breathes SHALLOWER rather than blinking out
 * of existence at the bottom of every cycle — a coverage claim that vanishes is worse than a faint
 * one. The cap is far above the default amplitude (.315 vs .13), so it never bites at rest.
 */
function indicatorRingOpacity(t){
  const amp = Math.min(IND.pulseAmt*IND_RING_PULSE, IND.ringOpacity*.75);
  return clamp(IND.ringOpacity + Math.sin(t*IND.pulseSpeed)*amp, 0, 1);
}

// ── corner selector ──
// Four independent L brackets, one per corner of the rect, each made of two axis-aligned quads that
// meet without overlapping (an overlap would double-blend at the corner). Arm length tracks the
// rect's shorter side so a 1x1 and a 3x3 stay proportionate; stroke width (IND.thick) is a constant
// in world units so both read at the same weight — and, being a world measure, it grows and shrinks
// with the footprint it frames under camera zoom instead of drifting away from it.
const SEL_ARM_FRAC = .34;             // arm length as a share of the shorter side
const SEL_ARM_MIN = .35, SEL_ARM_MAX = 1.4;
const SEL_CORNERS = [[-1,-1],[1,-1],[1,1],[-1,1]];   // sign pairs, (x,z), in arm order
const selectorPool = [];
let selectorUsed = 0;

function makeSelector(){
  const g = new THREE.Group();
  // One material per slot (like the ring pool), so two live selectors can carry different colours.
  const mat = new THREE.MeshBasicMaterial({
    transparent:true, side:THREE.DoubleSide, depthWrite:false,
    polygonOffset:true, polygonOffsetFactor:-3, polygonOffsetUnits:-3});
  const arms = [];
  for(let i=0;i<SEL_CORNERS.length*2;i++){     // 4 corners x 2 arms
    const m = new THREE.Mesh(cellGeo, mat);    // shared unit quad, owned by the footprint block
    m.rotation.x = -Math.PI/2;                 // plane XY -> ground XZ, so it lies on the ground
    m.castShadow = m.receiveShadow = false;    // never a shadow caster => never an occlusion blocker
    m.renderOrder = 5;
    g.add(m); arms.push(m);
  }
  g.userData.arms = arms; g.userData.mat = mat;
  scene.add(g);
  return g;
}

/**
 * rect: {x,y,w,h} in sim pixels (footprintWorldRect / cellWorldRect / pointWorldRect).
 * opts: {color,opacity,pulse}.
 *
 * pulse is a multiplier on the rect's HALF-EXTENTS only — the four corners breathe outward and back
 * while stroke width and arm length hold still. Scaling the group instead would scale the stroke with
 * it, so a breathing selector would read as a thickening one; the group therefore stays at scale 1
 * and every arm keeps the size it was measured at from the resting rect.
 */
function showSelector(rect, opts=NO_OPTS){
  let g = selectorPool[selectorUsed];
  if(!g){ g = makeSelector(); selectorPool.push(g); }
  selectorUsed++;
  const hw0 = rect.w*S/2, hh0 = rect.h*S/2;    // resting half-extents: the size the strokes are cut from
  // Cap the arm at the half-extent so opposite brackets can never meet and close into an outline.
  const arm = Math.min(clamp(Math.min(hw0,hh0)*2*SEL_ARM_FRAC, SEL_ARM_MIN, SEL_ARM_MAX), hw0, hh0);
  const t = Math.min(IND.thick, arm*.5);       // keeps the second arm's length (arm-t) positive
  // Only the corner OFFSETS breathe; arm and t above were measured before this and are not touched.
  const pulse = opts.pulse ?? 1;
  const hw = hw0*pulse, hh = hh0*pulse;
  const arms = g.userData.arms;
  for(let c=0;c<SEL_CORNERS.length;c++){
    const sx = SEL_CORNERS[c][0], sz = SEL_CORNERS[c][1], cx = sx*hw, cz = sz*hh;
    const along = arms[c*2], across = arms[c*2+1];
    along.position.set(cx - sx*arm/2, 0, cz - sz*t/2);          // x-arm: full length, one stroke deep
    along.scale.set(arm, t, 1);
    across.position.set(cx - sx*t/2, 0, cz - sz*(t + (arm-t)/2)); // z-arm: starts where the x-arm ends
    across.scale.set(t, arm-t, 1);
  }
  g.visible = true;
  g.position.set(gx(rect.x + rect.w/2), SELECT_Y, gz(rect.y + rect.h/2));
  const mat = g.userData.mat;
  mat.color.set(opts.color ?? css(PAL.ok));
  mat.opacity = opts.opacity ?? .8;
  return g;
}
function endSelectors(){ for(let i=selectorUsed;i<selectorPool.length;i++) selectorPool[i].visible=false; selectorUsed=0; }
function hideSelectors(){ for(const g of selectorPool) g.visible=false; selectorUsed=0; }

// ── segmented radius ring ──
// Exactly 12 arcs: three per quadrant, hairline gaps between the three, and a wider break centred on
// each cardinal axis so the four groups read as separate. The four spans tile a full circle exactly:
// 3*span + 2*SEG_GAP + QUAD_GAP == PI/2 by construction.
const RING_SEGS = 12, RING_PER_QUAD = 3, RING_STEPS = 6;   // 3 per quadrant x 4 quadrants
const RING_QUAD_GAP = .17, RING_SEG_GAP = .055;            // radians: group break, in-group gap
const RING_BAND = .22;                                     // band width in world units, radius-independent
// Angles are fixed; only the radii change, so cos/sin are precomputed once for the whole ring.
const RING_ANGLES = (()=>{
  const span = (Math.PI/2 - RING_QUAD_GAP - (RING_PER_QUAD-1)*RING_SEG_GAP)/RING_PER_QUAD;
  const out = [];
  for(let q=0;q<4;q++){
    const start = q*Math.PI/2 + RING_QUAD_GAP/2;           // half the break sits either side of the axis
    for(let s=0;s<RING_PER_QUAD;s++){
      const a0 = start + s*(span + RING_SEG_GAP);
      for(let k=0;k<=RING_STEPS;k++) out.push(a0 + span*k/RING_STEPS);
    }
  }
  return out;                                              // RING_SEGS*(RING_STEPS+1) angles, draw order
})();
const RING_COS = RING_ANGLES.map(a=>Math.cos(a)), RING_SIN = RING_ANGLES.map(a=>Math.sin(a));
// Vertex i of RING_ANGLES contributes an inner vertex (2i) and an outer vertex (2i+1); each arc is a
// strip of RING_STEPS quads. Index order is constant, so one shared array seeds every slot.
const RING_INDEX = (()=>{
  const idx = [];
  for(let s=0;s<RING_SEGS;s++){
    const base = s*(RING_STEPS+1)*2;
    for(let k=0;k<RING_STEPS;k++){
      const v = base + k*2;
      idx.push(v, v+1, v+3, v, v+3, v+2);
    }
  }
  return idx;
})();
function writeRadiusRing(arr, rIn, rOut){
  for(let i=0;i<RING_COS.length;i++){
    const c = RING_COS[i], s = RING_SIN[i], o = i*6;
    arr[o]   = c*rIn;  arr[o+1] = 0; arr[o+2] = s*rIn;
    arr[o+3] = c*rOut; arr[o+4] = 0; arr[o+5] = s*rOut;
  }
}
const radiusPool = [];
let radiusUsed = 0;

/** Centre in sim pixels, radius in sim pixels. opts: {color, opacity, pulse}. */
function showRadiusRing(x, y, radiusPx, opts=NO_OPTS){
  let rec = radiusPool[radiusUsed];
  if(!rec){
    const geo = new THREE.BufferGeometry();
    // BufferAttribute (not Float32BufferAttribute) so the array is kept by reference and can be
    // rewritten in place; setIndex() builds this slot's own index attribute from the shared list.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RING_COS.length*6), 3));
    geo.setIndex(RING_INDEX);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      transparent:true, side:THREE.DoubleSide, depthWrite:false,
      polygonOffset:true, polygonOffsetFactor:-3, polygonOffsetUnits:-3}));
    mesh.castShadow = mesh.receiveShadow = false;   // keeps it out of scanBlockers()/shadow map
    mesh.renderOrder = 4;
    scene.add(mesh);
    rec = {mesh, arr:geo.attributes.position.array, radius:-1};
    radiusPool.push(rec);
  }
  radiusUsed++;
  const r = Math.max(RING_BAND, radiusPx*S);
  if(rec.radius !== r){                             // rebuild only when this slot's radius moves
    writeRadiusRing(rec.arr, r - RING_BAND, r);
    rec.mesh.geometry.attributes.position.needsUpdate = true;
    rec.mesh.geometry.computeBoundingSphere();
    rec.radius = r;
  }
  rec.mesh.visible = true;
  rec.mesh.position.set(gx(x), RADIUS_Y, gz(y));
  rec.mesh.scale.setScalar(opts.pulse ?? 1);
  rec.mesh.material.color.set(opts.color ?? css(PAL.hint));
  rec.mesh.material.opacity = opts.opacity ?? .55;
  return rec.mesh;
}
function endRadiusRings(){ for(let i=radiusUsed;i<radiusPool.length;i++) radiusPool[i].mesh.visible=false; radiusUsed=0; }
function hideRadiusRings(){ for(const rec of radiusPool) rec.mesh.visible=false; radiusUsed=0; }

// Held workers are the real mesh lifted onto the cursor (see syncWorkers), so
// there is no worker ghost — only the drop-target ring below it.

/**
 * Placement/relocation mark: four pulsing corners around the COMPLETE footprint, plus the segmented
 * radius ring when indicatorRadius() reports one.
 *
 * anchor is the snapToCellCenter() result the preview and the commit both use, so the corners, the
 * ring, the tinted cells, the ghost and the building that finally lands share one centre. Extents come
 * from buildingFootprint() -> footprintWorldRect(), the same pair showFootprint() measures its cells
 * with, so 1x1 and 3x3 need no special casing and no dimension is restated here.
 *
 * Colour is the placement verdict, PAL.cellOk/PAL.cellBad — the same two colours CELL_MAT/EDGE_MAT
 * tint the cells with, so corners, ring and cells flip together. Only the CORNERS breathe (a pulse on
 * their offsets); the ring's radius is left alone and its opacity does the breathing, because the ring
 * states real coverage and a scaled one would advertise a range the tower does not have. An invalid
 * spot therefore reads as red everywhere while still showing the true, unshrunken radius.
 */
function showPlacementIndicators(type, anchor, ok, t, building=null){
  const c = worldToCell(anchor.x, anchor.y);
  const color = css(ok ? PAL.cellOk : PAL.cellBad);
  showSelector(footprintWorldRect(c.cx, c.cy, buildingFootprint(type)),
    {color, opacity:indicatorCornerOpacity(IND_OPACITY_PLACEMENT), pulse:indicatorPulse(t)});
  const radius = indicatorRadius(type, building);
  if(radius) showRadiusRing(anchor.x, anchor.y, radius, {color, opacity:indicatorRingOpacity(t)});
}

// ── selector preview (debugger affordance) ──────────────────────────────────
// A tuning aid owned by the view debugger's `selectors` tab, not a game feature. Ordinary play never
// puts every selector state on screen at once — a valid and an invalid footprint are mutually
// exclusive, and a coverage ring only appears while the cursor sits on the thing that owns it — so
// this draws SAMPLE marks on demand and the slider row above can be judged against a known state.
//
// RENDER-ONLY, and strictly so: nothing here places, mutates or reads-then-writes anything. No
// building is created, `buildings` and `state` are never assigned to, and the samples go through the
// SAME showSelector()/showRadiusRing() calls drawZones() makes. They therefore claim ordinary pool
// slots and endSelectors()/endRadiusRings() retire them on the very frame the mode returns to off —
// no separate teardown exists because none is needed. Every dimension is real: footprints come from
// the footprint table (FOOTPRINT_1x1 / FOOTPRINT_3x3) and the radius from indicatorRadius("tower"),
// which resolves through towerRadius() to TOWER_VARIANTS.basic.range. No number is invented here.
//
// LIVE MARKS — deliberate: the preview is ADDITIVE and never suppresses them. With a mode on and the
// cursor also over a target, BOTH draw. That is the point of the control: the sample is the fixed
// reference you compare the moving live mark against, and suppressing one would make them
// un-comparable. The anchor is the camera-focus cell, so a sample holds still and stays on screen
// while you pan; if a live mark happens to land on the same cell the two simply overlap, which is
// harmless — separate pool slots, separate materials, no shared state.
const SEL_PREVIEW_MODES = Object.freeze({OFF:0, ACTION:1, OK_1X1:2, OK_3X3:3, BAD_3X3:4, RADIUS:5});
let SEL_PREVIEW = SEL_PREVIEW_MODES.OFF;
/**
 * The vSelPreview <select>'s single write path. SEL_PREVIEW cannot be an exported `let` — the
 * debugger lives in another module and an imported binding is read-only there — so the mode is
 * module-private and this setter is the only thing that moves it.
 */
export function setSelectorPreview(mode){ SEL_PREVIEW = mode; }

function drawSelectorPreview(t){
  if(SEL_PREVIEW === SEL_PREVIEW_MODES.OFF) return;
  // Camera focus, snapped the same way a real placement snaps — always on screen, always on lattice.
  const a = snapToCellCenter(state.camera.x, state.camera.y);
  const c = worldToCell(a.x, a.y);
  const M = SEL_PREVIEW_MODES;
  if(SEL_PREVIEW === M.ACTION){
    // The one-cell primary-action bracket: PAL.ok, and the deeper IND_PULSE_ACTION breath.
    showSelector(cellWorldRect(a.x, a.y),
      {color:css(PAL.ok), opacity:indicatorCornerOpacity(), pulse:indicatorPulse(t, IND_PULSE_ACTION)});
    return;
  }
  if(SEL_PREVIEW === M.RADIUS){
    // A completed building under the cursor: hint-toned footprint corners plus its coverage ring.
    showSelector(footprintWorldRect(c.cx, c.cy, FOOTPRINT_3x3),
      {color:css(PAL.hint), opacity:indicatorCornerOpacity(), pulse:indicatorPulse(t)});
    const radius = indicatorRadius("tower");   // omitted building => the basic chassis's own range
    if(radius) showRadiusRing(a.x, a.y, radius, {color:css(PAL.hint), opacity:indicatorRingOpacity(t)});
    return;
  }
  // Placement verdicts. BAD reuses the 3x3 footprint so it differs from the valid 3x3 in COLOUR
  // ONLY — the pair is there to check the red/green flip reads at a glance, not the sizing.
  const ok = SEL_PREVIEW !== M.BAD_3X3;
  const footprint = SEL_PREVIEW === M.OK_1X1 ? FOOTPRINT_1x1 : FOOTPRINT_3x3;
  showSelector(footprintWorldRect(c.cx, c.cy, footprint),
    {color:css(ok ? PAL.cellOk : PAL.cellBad),
     opacity:indicatorCornerOpacity(IND_OPACITY_PLACEMENT), pulse:indicatorPulse(t)});
}


// ── cursor bracket ──────────────────────────────────────────────────────────
// ONE bracket lives under the pointer at all times, and it changes what it frames rather than
// blinking in and out. Three states, in priority order, resolved fresh every frame:
//
//   1. a harvest/attack target   -> that target's one-cell rect, PAL.ok, the deeper action breath
//   2. a completed building      -> its COMPLETE footprint rect, PAL.hint, plus its coverage rings
//   3. nothing                   -> the lattice cell under the pointer, PAL.cursor, dimmed
//
// Both target states already had their own authority — badgeAction() and hoveredBuilding() — and
// those are unchanged and still consulted in that order. All this adds is the third state and the
// glide, so a bracket that used to appear from nowhere now travels there from wherever it was.
/**
 * What the cursor bracket frames this frame, or null when it should not be drawn at all.
 * Pure: reads state and the live world lists, mutates nothing, returns a fresh descriptor.
 *
 * `building` rides along so the caller can hang the coverage rings off the same resolution — the
 * corners and the rings can never end up naming different buildings.
 */
function cursorMark(){
  // 1. Something to swing at. badgeAction() owns every suppression this needs.
  const action = badgeAction();
  if(action){
    // Nodes sit exactly on cell centers (see the seeder), so theirs snaps to the lattice; enemies move
    // continuously, so theirs is centred on the enemy at the same one-cell size instead of hopping.
    const p = action.target;
    return {rect: action.resource ? cellWorldRect(p.x, p.y) : pointWorldRect(p.x, p.y),
            color: css(PAL.ok), opacity: indicatorCornerOpacity(), pulse: IND_PULSE_ACTION,
            building: null};
  }
  // 2. A finished building. hoveredBuilding() is the sole authority for WHICH one.
  const b = hoveredBuilding();
  if(b){
    const c = worldToCell(b.x, b.y);
    return {rect: footprintWorldRect(c.cx, c.cy, buildingFootprint(b.type)),
            color: css(PAL.hint), opacity: indicatorCornerOpacity(), pulse: 1, building: b};
  }
  // 3. Empty ground. The two resolvers above both refuse in these states and the idle bracket has to
  // refuse in the same ones, or it would outlive them — placement and a held object draw their own
  // snapped mark, and the rest are "the game is not taking pointer input right now".
  const m = state.mouse;
  if(!m.inside || state.paused || state.gameOver || HOOKS.isModalOpen()) return null;
  if(state.camera.panning || state.heldObject || state.buildMode) return null;
  return {rect: cellWorldRect(m.x, m.y), color: css(PAL.cursor),
          opacity: indicatorCornerOpacity(IND_OPACITY_IDLE), pulse: 1, building: null};
}

// Where the bracket actually IS, as opposed to where cursorMark() says it belongs. Centre and size
// are smoothed separately so a 1x1 -> 3x3 handover grows the frame instead of popping it.
// `live` false means the bracket is not on screen, so the next frame that draws it TELEPORTS: without
// that it would sail across the whole map after every pause, modal or pointer-leave.
const cursorGlide = {x:0, y:0, w:0, h:0, live:false};
let cursorGlideT = 0;
/**
 * Ease the drawn rect toward the resolved one and return what to draw. Exponential smoothing with the
 * step taken from real elapsed time, so the glide covers the same ground per second at 30fps as at
 * 144 and IND.follow keeps meaning "fraction of the gap closed per 60Hz frame".
 *
 * A moving enemy is smoothed like everything else rather than special-cased: exponential smoothing
 * settles at a constant lag of v*dt/k, which at the default is about a fortieth of a cell for a
 * walking raider — far too small to read as the bracket falling behind, and it keeps the handover
 * from the lattice onto a moving body as smooth as every other handover.
 */
function glideCursorRect(rect){
  const now = performance.now()/1000;
  const dt = Math.min(.05, now - (cursorGlideT || now));
  cursorGlideT = now;
  const cx = rect.x + rect.w/2, cy = rect.y + rect.h/2;
  const k = cursorGlide.live ? 1 - Math.pow(1 - clamp(IND.follow, .01, 1), dt*60) : 1;
  cursorGlide.x += (cx - cursorGlide.x)*k;
  cursorGlide.y += (cy - cursorGlide.y)*k;
  cursorGlide.w += (rect.w - cursorGlide.w)*k;
  cursorGlide.h += (rect.h - cursorGlide.h)*k;
  cursorGlide.live = true;
  return {x: cursorGlide.x - cursorGlide.w/2, y: cursorGlide.y - cursorGlide.h/2,
          w: cursorGlide.w, h: cursorGlide.h};
}

function drawZones(){
  const m = state.mouse, t = performance.now()/1000;

  // Vacuum reach while right-drag is collecting — the real collectDrop() radius.
  if(VIEW_TUNE.showVacuumRing && state.collecting && m.inside)
    ring(m.x, m.y, vacuumRadius(), css(PAL.ok), .45 + Math.sin(t*6)*.18);

  // The cursor bracket: one mark, always present, that RETARGETS instead of appearing and vanishing.
  // cursorMark() picks what it frames (see above) and the glide carries it there, so moving off a tree
  // and onto a tower is a single frame sliding and growing rather than two separate marks.
  const cursor = cursorMark();
  if(cursor){
    // One continuous clock (t, shared with the rings), so a retarget mid-breath carries the phase over
    // instead of snapping the bracket back to full size.
    showSelector(glideCursorRect(cursor.rect),
      {color:cursor.color, opacity:cursor.opacity, pulse:indicatorPulse(t, cursor.pulse)});
  } else cursorGlide.live = false;   // off screen: the next appearance teleports rather than flies in

  if(mainBaseStanding() && m.inside && distance(m.x,m.y,BASE.x,BASE.y)<BASE.r+16) ring(BASE.x,BASE.y,BASE_ZONE);

  // Coverage rings for the hovered building, hung off the SAME resolution the corners used so the two
  // can never name different buildings. The radius comes from indicatorRadius(), the resolver the
  // placement preview also reads — a tower reads its OWN variant's range through it, so an upgraded
  // tower advertises what it actually covers and a house/obelisk/spike gets no ring at all.
  // These do NOT glide: the corners are a pointer, free to ease, but a ring is a claim about where the
  // simulation reaches, and a claim that drifts to its position is a claim that is briefly wrong.
  const hovered = cursor?.building;
  if(hovered){
    const color = css(PAL.hint);
    const radius = indicatorRadius(hovered.type, hovered);
    if(radius) showRadiusRing(hovered.x, hovered.y, radius, {color, opacity:indicatorRingOpacity(t)});
    // Aggro's taunt is a SECOND ring in PAL.taunt — a different radius with different meaning (what it
    // pulls, not what it shoots), so it is coloured apart instead of doubling the attack ring's tone.
    const taunt = hovered.type==="tower" && towerVariant(hovered).tauntRadius;
    if(taunt) showRadiusRing(hovered.x, hovered.y, taunt, {color:css(PAL.taunt), opacity:indicatorRingOpacity(t)});
  }
  if(heldWorker()){
    if(mainBaseStanding()) ring(BASE.x,BASE.y,BASE_ZONE,css(PAL.storage),.4);
    for(const s of buildings) if(s.complete && s.type==="stockpile")
      ring(s.x,s.y,storageServiceRadius(s),css(PAL.storage),.4);
  }

  hideGhostBuilding();
  hideFootprint();
  // Previews snap with snapToCellCenter() — the exact call leftClick()/dropHeldObject() commit with —
  // so the ghost's cell, its validity tint, and the placed anchor can never disagree.
  // Standing fog is refused by every commit path (placeCardCharge / dropHeldObject both test
  // footprintFogFree), so every verdict below ANDs it in — otherwise a ghost reads valid over a
  // cell the click will reject. Same footprint the ghost is already drawn with, never a wider one.
  if(state.buildMode && m.inside){
    const a = snapToCellCenter(m.x, m.y);
    const ok = canPlace(a.x, a.y, state.buildMode) && footprintFogFree(a.x, a.y, buildingFootprint(state.buildMode));
    showFootprint(state.buildMode, a.x, a.y, ok);
    showGhostBuilding(state.buildMode, a.x, a.y, ok);
    showPlacementIndicators(state.buildMode, a, ok, t);
  }
  if(state.heldObject && m.inside){
    const worker = heldWorker();
    if(worker){
      // The worker itself is already floating on the cursor; show where it lands.
      const a = workerAssignmentAt(worker, m.x, m.y);
      if(a) ring(a.zoneX,a.zoneY,a.zoneRadius,css(PAL.ok),.85);
      else  ring(m.x,m.y,WORKER_LEASH,css(PAL.bad),.7);
      ring(m.x, m.y, 16, a?css(PAL.ok):css(PAL.bad), .8);
    } else {
      const chest=heldChest();
      if(chest){
        const a=snapToCellCenter(m.x,m.y),ok=canPlace(a.x,a.y,null,null,null,chest)&&footprintFogFree(a.x,a.y,chest.footprint);
        showFootprint(null,a.x,a.y,ok);showSelector(cellWorldRect(a.x,a.y),{color:css(ok?PAL.cellOk:PAL.cellBad),opacity:.9,pulse:indicatorPulse(t)});
      }
      const prop=heldProp();
      if(prop){
        const a=snapToCellCenter(m.x,m.y),ok=canPlace(a.x,a.y,null,null,prop)&&footprintFogFree(a.x,a.y,prop.footprint);
        showFootprint(null,a.x,a.y,ok);showSelector(cellWorldRect(a.x,a.y),{color:css(ok?PAL.cellOk:PAL.cellBad),opacity:.9,pulse:indicatorPulse(t)});
      }
      const b = heldBuilding();
      if(b){
        const a = snapToCellCenter(m.x, m.y), ok = canPlace(a.x, a.y, b.type, b) && footprintFogFree(a.x, a.y, buildingFootprint(b.type));
        showFootprint(b.type, a.x, a.y, ok);
        // Damage orbs' live model already follows the cursor and remains animated/active.
        if(b.type!=="damageOrbs")showGhostBuilding(b.type, a.x, a.y, ok, 1.6 + Math.sin(t*5)*.12);
        // A held tower keeps whatever variant it was upgraded to, so its radius comes from the
        // building itself (towerRadius -> its own variant), never from the basic chassis.
        showPlacementIndicators(b.type, a, ok, t, b);
        ring(a.x, a.y, 30, ok?css(PAL.ok):css(PAL.bad), .8);
      }
    }
  }
  // Debugger samples last, so they claim pool slots AFTER every live mark and can never displace one.
  drawSelectorPreview(t);
  // endRings()/endSelectors()/endRadiusRings() run in drawScene(), after drawAttacks() claims its rings.
}

// ─────────────────────────────────────────────────────────── frame
let lastDrawT = 0;
/**
 * Bring every mesh, pool and ground mark in line with the current simulation state and camera.
 * Does NOT issue the draw call — renderScene() does, so the caller can slot the debugger's
 * visibility measurement (which adds pins to the scene) in between, exactly as it always ran.
 * Returns true when orbit advanced the yaw, so the caller can push it back into its slider.
 */
export function drawScene(){
  rebuildTerrainPresentation();
  const orbited = view.orbit;
  if(orbited) view.yaw = (view.yaw + .25) % 360;
  placeCamera();

  const cam = state.camera;
  {
    // Sun offset from the camera target, az/el-parameterised (R panel "camera / sun" drives
    // sunPose; defaults az 0 / el 60, the test-scene owner solve).
    const saz = THREE.MathUtils.degToRad(sunPose.az), sel = THREE.MathUtils.degToRad(sunPose.el);
    const h = Math.cos(sel) * SUN_OFFSET_DIST;
    sun.position.set(gx(cam.x) + Math.cos(saz)*h, Math.sin(sel)*SUN_OFFSET_DIST, gz(cam.y) + Math.sin(saz)*h);
  }
  sun.target.position.set(gx(cam.x), 0, gz(cam.y));
  sun.target.updateMatrixWorld();
  // ── DAY / NIGHT ────────────────────────────────────────────────────────────────────────────
  // ONE phase number, 0 = noon, 1 = full night, feeding the key light, the tone tier (uLmNight
  // below), the water and the grid. state.clock.light is the simulation's night OVERLAY ALPHA and
  // tops out at NIGHT_OVERLAY_ALPHA (0.28), so it is normalised here — the sun dim below has always
  // documented a 0.35 floor and never reached it (driven raw it bottomed out at 2.41, a 25% dim).
  // Noon 3.21 = the test-scene exposure solve (S·π/sin 60°, S = 0.885 — see the rig comment at the
  // lights above); the night floor is rig.js NIGHT_SUN_SCALE.
  const night = Math.min(1, state.clock.light / NIGHT_OVERLAY_ALPHA);
  sun.intensity = SUN_INTENSITY*(1 - night*(1 - NIGHT_SUN_SCALE));   // 3.21 -> 0.353
  // Continuous, replacing the old hard switch at night > .25: the tone tiers solve their night pair
  // against EXACTLY PAL.sunNight at night = 1 and lerp on this same phase, so a step in the key
  // light's colour would show up as a step in every toned family's landing halfway through dusk.
  sun.color.copy(SUN_DAY_COLOR).lerp(SUN_NIGHT_COLOR, night);
  // The water shader ignores scene lights, so it swaps its own tier (see WATER_NIGHT): a step down
  // the blue ramp plus a mild dim. The old `1 - night*.6` darken alone made water the one surface
  // on screen that answered night by going black.
  waterUniforms.uShallow.value.copy(WATER_DAY.shallow).lerp(WATER_NIGHT.shallow, night);
  waterUniforms.uDeep.value.copy(WATER_DAY.deep).lerp(WATER_NIGHT.deep, night);
  waterUniforms.uFoam.value.copy(WATER_DAY.foam).lerp(WATER_NIGHT.foam, night);
  waterUniforms.uLight.value = 1 - night*.25;

  // Material light mods: patch any materials born this frame (before the coming render compiles
  // them) and sync the shared uniforms. Knob values come from pixel.js's WINDOW MIRROR rather
  // than a static import, so the pipeline module stays lazily loaded — when it has never loaded
  // ("current"-only session), the zeros mean stock lighting, which is exactly what "current" is.
  applyLightingMods(THREE, scene);
  const lightTime = (performance.now() / 1000) % 100000;   // shared by light mods + the meadow
  {
    const tune = window.pixelTune;
    const materialMode = tune && tune.clouds !== false && tune.cloudsMode === "material";
    syncLightMods({
      cloudScale: tune?.cloudScale ?? 0.038, cloudSpeed: tune?.cloudSpeed ?? 0.01,
      cloudCover: tune?.cloudCover ?? 0.38,
      cloudOffsetX: tune?.cloudOffsetX ?? 0, cloudOffsetZ: tune?.cloudOffsetZ ?? 0,
      cloudHeight: tune?.cloudHeight ?? 60,
      sunDir: _sunDirScratch.subVectors(sun.position, sun.target.position),
      time: lightTime,
      cloudShade: !!materialMode,
      cloudMax: tune?.cloudMax ?? 0.8,
      toon: tune ? tune.toonRamp !== false : false,
      night,   // the tone tier's day->night lerp; same phase the sun above rides
    });
  }
  // The grid is unlit, so without this it would stay bright while the map darkens and end up the
  // loudest thing on screen at night. Fading it keeps it under the terrain and the combat marks.
  // Overview zoom suppresses the 32px lattice; normal/build zoom retains full precision.
  // Placement-only (owner pick, Aug 19): outside build mode the grid fought the pixel pipeline's
  // quantizer — a 24%-alpha hairline posterizes onto a full lightness band and reads as bright
  // texel lines — so it now shows only while a building (or the held chest) owns the cursor.
  const placing = state.buildMode || state.heldObject ? 1 : 0;
  const overviewFade=THREE.MathUtils.smoothstep(state.camera.zoom,.2,.58);
  gridMat.opacity = GRID_OPACITY * overviewFade * (1 - night*.55) * placing;
  // Fully transparent lines still cost a draw call; overview hides the object as well as fading it.
  if(terrainGrid)terrainGrid.visible=gridMat.opacity>0;

  // Entities under standing fog are dormant in the simulation and hidden here; the held chest is
  // in the player's hand, so it renders regardless of what cell the cursor floats over.
  const revealed=e=>!fogAtPoint(e.x,e.y);
  syncMeadow(lightTime);
  syncFog();syncFogPops();
  syncTrees(trees.filter(revealed)); syncRocks(rocks.filter(revealed)); syncDiamonds(diamonds.filter(revealed));
  const visibleChests=chests.filter(revealed);
  syncChests(heldChest()?[...visibleChests,heldChest()]:visibleChests);
  syncDrops(resourceDrops); syncCorpses(workerCorpses);
  // Same contract as the resources above: an enemy inside standing fog is untargetable in the
  // simulation (clicks, towers and the base all skip it), so it must not be drawn either — a body
  // on screen that no click can reach is worse than no body at all. The held enemy is in hand.
  const visibleEnemies=state.enemies.filter(revealed);
  syncEnemies(heldEnemy()?[...visibleEnemies,heldEnemy()]:visibleEnemies);syncFriendlyBrutes(friendlyBrutes);syncControlledEnemies(controlledEnemies);syncWorkers();
  syncDummies(damageDummies);syncShowcaseProps(showcaseProps);
  syncBuildings(); syncParticles(); syncHand(); syncBasePile();

  // Sim-px outline shells track the view panel's weight slider through the world-unit material.
  outlineMatPx.uniforms.thickness.value = outlineMat.uniforms.thickness.value / S;
  syncBase(performance.now()/1000);

  // Shots advance on real elapsed time, independent of the sim step count.
  const nowS = performance.now()/1000;
  const drawDt = Math.min(.05, nowS - (lastDrawT || nowS));
  stepShots(drawDt);
  stepMeteors(drawDt);
  stepFireballs(drawDt);
  lastDrawT = nowS;

  drawZones();
  drawAttacks();
  endRings();
  // Same claim-per-frame contract as the rings: whatever drawZones() did not claim this frame hides.
  // drawScene() runs even while paused / in a modal, so a suppressed selector is always cleared next frame.
  endSelectors();
  endRadiusRings();
  return orbited;
}
/** The draw call itself, split from drawScene() so pins land in the scene before it runs.
 * Routed through the pipeline registry: "current" reproduces the direct draw exactly; "pixel" is
 * the shipped pixel-art pipeline (F9 toggles, see src/render/pipelines/). */
export function renderScene(){ renderFrame(); }

configurePipelines({
  THREE, renderer, scene,
  getCamera: () => camera3,
  getSun: () => sun,
  waterPrePass,
  view,
  // The R panel's pinned "grass" section — same section the test scene shows, over the same
  // live grassTune, so a tuning found in either host applies to both.
  panelSections: [{title: "grass", tune: grassTune, spec: GRASS_PANEL},
                  {title: "ground", tune: groundTune, spec: GROUND_PANEL}],
  // The R panel's "camera / sun" section (debug-panel.js) — shared UI with the test scene.
  // Writes go through the SAME paths the view-debugger uses (view fields + placeCamera /
  // setOrthoCamera / setCameraZoom), so the two panels can never disagree about ownership.
  // Yaw is stored 0..360 (orbit wraps it); the slider speaks -180..180.
  poseControls: {
    sliders: [
      ["pitch", "pitch", 15, 89, 1], ["yaw", "yaw", -180, 180, 1],
      ["zoom", "zoom", 0.1, 5, 0.05], ["fov", "fov", 8, 70, 0.25],
      ["zoomMin", "zoom clamp min", 0.02, 1, 0.01], ["zoomMax", "zoom clamp max", 1, 20, 0.5],
      ["sunAz", "sun azimuth", -180, 180, 1], ["sunEl", "sun elevation", 10, 85, 1],
      ["shadowBlur", "shadow blur (PCF radius)", 0, 16, 0.5],
    ],
    checks: [["ortho", "orthographic"], ["ball", "scale ball"], ["zoomClamp", "clamp zoom"]],
    buttons: [["iso", "isometric"]],
    get(k){
      switch(k){
        case "pitch": return view.pitch;
        case "yaw": return ((view.yaw + 540) % 360) - 180;
        case "zoom": return state.camera.zoom;
        case "fov": return view.fov;
        case "ortho": return view.ortho;
        case "ball": return !!(scaleBall && scaleBall.visible);
        case "zoomMin": return ZOOM_LIMITS.min;
        case "zoomMax": return ZOOM_LIMITS.max;
        case "zoomClamp": return ZOOM_LIMITS.clamp;
        case "sunAz": return sunPose.az;
        case "sunEl": return sunPose.el;
        case "shadowBlur": return sun.shadow.radius;
      }
    },
    set(k, v){
      switch(k){
        case "pitch": view.pitch = v; break;
        case "yaw": view.yaw = (v + 360) % 360; break;
        case "zoom": setCameraZoom(v); break;
        case "fov": view.fov = v; break;
        case "ortho": setOrthoCamera(v); break;
        case "ball": setScaleBall(v); return;
        case "zoomMin": ZOOM_LIMITS.min = v; return;   // read on the next wheel tick
        case "zoomMax": ZOOM_LIMITS.max = v; return;
        case "zoomClamp": ZOOM_LIMITS.clamp = v; return;
        case "sunAz": sunPose.az = v; return;   // sun is placed per frame in drawScene
        case "sunEl": sunPose.el = v; return;
        case "shadowBlur": sun.shadow.radius = v; return;
      }
      placeCamera();
    },
    press(k){
      if(k === "iso"){ view.pitch = 35.264; view.yaw = 45; setOrthoCamera(true); placeCamera(); }
    },
  },
});

// ─────────────────────────────────────────────── visibility measurement (scene half)
// The debugger owns the readouts and the pitch sweep; these three are the parts that need the scene
// graph and the camera, so they live with them. All read-only apart from the raycaster scratch.
const occRay = new THREE.Raycaster();
const _sp = new THREE.Vector3();

/** Force world matrices up to date before a sweep raycasts against them. */
export function updateWorldMatrices(){ scene.updateMatrixWorld(true); }

/** Every live thing the player can click, with the height to sight to. */
export function scanSubjects(){
  const out = [];
  for(const t of trees)    if(t.stump<=0)    out.push([t,1.7]);
  for(const r of rocks)    if(r.depleted<=0) out.push([r,.6]);
  for(const n of diamonds) if(n.depleted<=0) out.push([n,.9]);
  for(const d of resourceDrops) out.push([d,.3]);
  for(const chest of chests) out.push([chest,.8]);
  // Extra tuple coordinates are render-space truth for held objects: the entity retains its exact
  // restoration origin while its pooled model is lifted at the cursor.
  if(heldChest()){const held=heldChest(),x=state.mouse.inside?state.mouse.x:held.x,y=state.mouse.inside?state.mouse.y:held.y;out.push([held,.8,x,y]);}
  for(const w of state.workers) out.push([w,.8]);
  for(const e of state.enemies) out.push([e,.8]);
  if(heldEnemy()){const held=heldEnemy(),x=state.mouse.inside?state.mouse.x:held.x,y=state.mouse.inside?state.mouse.y:held.y;out.push([held,.8,x,y]);}
  for(const brute of friendlyBrutes) out.push([brute,1.4]);
  for(const unit of controlledEnemies) out.push([unit,.8]);
  for(const d of damageDummies) out.push([d,1.2]);
  for(const p of showcaseProps) out.push([p,.8]);
  for(const b of buildings)     out.push([b,1.0]);
  return out;
}
export function scanBlockers(){
  const out = [];
  scene.traverse(o=>{ if(o.isMesh && o.visible && o.castShadow) out.push(o); });
  return out;
}
export function countVisible(list, blockers){
  let vis = 0;
  const hidden = [];
  for(const [e,h,scanX=e.x,scanY=e.y] of list){
    _sp.set(gx(scanX), h*view.heightScale/100, gz(scanY));
    const dir = _sp.clone().sub(camera3.position);
    const dist = dir.length();
    occRay.set(camera3.position, dir.normalize());
    occRay.far = dist;
    let blocked = false;
    for(const hit of occRay.intersectObjects(blockers,false)){
      // Instanced scatter identifies per instance; pooled meshes carry the entity directly.
      const owner = hit.object.isInstancedMesh
        ? hit.object.userData.entities?.[hit.instanceId]
        : hit.object.userData.ent;
      if(owner === e) continue;                 // its own body doesn't count
      if(hit.distance < dist - .15){ blocked = true; break; }
    }
    if(blocked) hidden.push(_sp.clone()); else vis++;
  }
  return {vis, total:list.length, hidden};
}
