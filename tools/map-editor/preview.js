// Map editor — standalone Three.js preview of the authored map.
// Owns the 3D scene: WFC-selected ground and raised terrain modules, the shared
// water plane, placed object models, contradiction highlights, and the orbit
// camera. All state here is derived from the map document; rebuild() is the only
// entry point and disposes exactly what it built. Browser-only.

import * as THREE from "three";
import {buildModuleCatalog, SHAPE_GEOMETRY, rotateShapePoint} from "../../src/game/terrain-modules.js";
import {solveTerrainWfc} from "../../src/game/terrain-wfc.js";
import {buildObjectModel, disposeGroup, S} from "./object-catalog.js";
import {PAL} from "../../src/render/palette.js";
import {SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG, SUN_INTENSITY, HEMI_INTENSITY} from "../../src/render/rig.js";
import {resolveAuthoredMapScatter} from "../../src/game/authored-map.js";
import {createWaterModes} from "./water-modes.js";
import {configurePipelines, renderFrame, resizePipeline} from "../../src/render/pipelines/index.js";
import {createGrass, grassTune, GRASS_PANEL} from "../../src/render/grass.js";

// Fixed authored elevations in world units (1 unit = 16 game px, matching models.js).
export const GROUND_TOP = 0;
export const RAISED_TOP = 1.2;
export const WATER_SURFACE = -0.42;
export const WATER_BOTTOM = -0.9;

// Independent deterministic salts so the two WFC passes never share variant rolls.
export const GROUND_SALT = 0x970a11;
export const RAISED_SALT = 0x5a15ed;

const GROUND_CATALOG = buildModuleCatalog({layer: "ground"});
const RAISED_CATALOG = buildModuleCatalog({layer: "raised"});

// ── cell colours: the SHARED palette, no editor-local hexes (palette.js LAW, Aug 21) ──────────
// Tops reproduce the game's terrain tint law verbatim (src/render/scene.js tintFor): PAL.grass
// lerped toward a region colour per WFC variant, then raised cells lifted 12% toward white.
// The weights are duplicated here because scene.js CANNOT be imported outside the game page (it
// grabs document.getElementById("scene") at module load) — if tintFor's weights move, move these.
// Known gap, deliberate: the editor does not run material-light-mods, so tone targets (TONES.meadow),
// the toon ramp and cloud shade are absent — this shows albedo × plain rig, the game's ground
// FAMILY at the game's light, not a frame-exact match.
const REGION_TINT = Object.freeze({          // full-tile variant -> [region colour, lerp weight]
  meadow:  null,                             // the plain meadow: PAL.grass untouched
  mottled: [PAL.regionForest, .16],
  scrub:   [PAL.regionOpen,   .2],
  plateau: null,
  rocky:   [PAL.regionRocky,  .18],
});
// Edge (non-full) modules keep the coast tint; the game leans them harder on the ground layer.
const COAST_TINT = Object.freeze({ground: .28, raised: .16});
// Shore/cliff faces. The game skirts ALL of these with one shoreMat (PAL.cliff); the editor keeps
// the per-variant read for authoring, sourced from the stone + sand roles.
const WALL_COLOR = Object.freeze({
  sand: PAL.dirt, pebble: PAL.rubble,          // cream1 / grey0
  cliff: PAL.cliff, striated: PAL.rockDark,    // stone3 / stone2
});
const WHITE = 0xffffff;
/** `${layer}:${part}:${variant}` -> the THREE.Color that key renders as. Throws on unknown keys. */
function cellColor(key){
  const [layer, part, variant] = key.split(":");
  if(part === "wall"){
    const hex = WALL_COLOR[variant];
    if(hex === undefined) throw new Error(`preview: no wall colour for ${key}`);
    return new THREE.Color(hex);
  }
  const color = new THREE.Color(PAL.grass);
  if(variant === "base"){
    const weight = COAST_TINT[layer];
    if(weight === undefined) throw new Error(`preview: no coast tint for layer ${layer}`);
    color.lerp(new THREE.Color(PAL.cliff), weight);
  }else{
    if(!(variant in REGION_TINT)) throw new Error(`preview: no top colour for ${key}`);
    const rule = REGION_TINT[variant];
    if(rule) color.lerp(new THREE.Color(rule[0]), rule[1]);
  }
  if(layer === "raised") color.lerp(new THREE.Color(WHITE), .12);
  return color;
}

export function createTerrainPreview({canvas}){
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true});
  renderer.shadowMap.enabled = true;
  // Plain PCF + a blur radius, exactly like the game (scene.js): PCFSoftShadowMap IGNORES
  // shadow.radius, so the editor used to draw a different skirt than the thing it previews.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // NO tone mapping — the game renders straight (scene.js has no toneMapping), and the rig
  // intensities below are solved against that. ACES here also made the offscreen pixel pipeline
  // disagree with the "current" pipeline, since three skips tone mapping into render targets.
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAL.sky);
  // FOV matches the game camera (src/render/scene.js persp) so framing agrees.
  const camera = new THREE.PerspectiveCamera(38, 1, .1, 4000);

  // Light rig = rig.js, the ONE source the game scene, the model bake and the tone solves read.
  scene.add(new THREE.HemisphereLight(PAL.skyLight, PAL.bounce, HEMI_INTENSITY));
  const sun = new THREE.DirectionalLight(PAL.sunDay, SUN_INTENSITY);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 3;   // matches scene.js's crisp pixel-art skirt
  scene.add(sun, sun.target);

  const materialCache = new Map();
  function materialFor(key){
    if(!materialCache.has(key))
      materialCache.set(key, new THREE.MeshLambertMaterial({color: cellColor(key), flatShading: true}));
    return materialCache.get(key);
  }
  // Water is owned by the mode system (see water-modes.js): mode 0 reproduces
  // the game's flat plane; 1-5 are candidate shader treatments swappable live.
  const water = createWaterModes({renderer, surfaceY: WATER_SURFACE, tileOf: doc => doc.cellSize * S, floorYOf: () => shoreBottom});
  // Editor-only chrome, but still a palette role: PAL.bad is the shared "blocked/wrong" red.
  const contradictionMaterial = new THREE.MeshBasicMaterial({color: PAL.bad, transparent: true, opacity: .55, depthTest: false});

  // Everything rebuild() creates, torn down symmetrically before the next build.
  const built = {meshes: [], geometries: [], materials: [], objectModels: []};
  function disposeBuilt(){
    for(const mesh of built.meshes) scene.remove(mesh);
    for(const geometry of built.geometries) geometry.dispose();
    for(const material of built.materials) material.dispose();
    for(const model of built.objectModels){ scene.remove(model); disposeGroup(model); }
    built.meshes.length = built.geometries.length = built.materials.length = built.objectModels.length = 0;
  }

  function pushTop(bucket, points, y){
    // Fan-triangulate with upward normals regardless of authored point order.
    let area = 0;
    for(let i = 0; i < points.length; i++){
      const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length];
      area += ax * bz - bx * az;
    }
    const ordered = area > 0 ? [...points].reverse() : points;
    for(let i = 1; i < ordered.length - 1; i++)
      bucket.push(ordered[0][0], y, ordered[0][1], ordered[i][0], y, ordered[i][1], ordered[i + 1][0], y, ordered[i + 1][1]);
  }
  function pushWall(bucket, [[ax, az], [bx, bz]], yTop, yBottom){
    bucket.push(ax, yTop, az, bx, yTop, bz, ax, yBottom, az);
    bucket.push(bx, yTop, bz, bx, yBottom, bz, ax, yBottom, az);
  }

  // One elevation threshold: emit merged geometry buckets from a WFC solve.
  function buildLayer(doc, solve, layer, topY, bottomY){
    if(solve.status !== "solved") return;
    const tile = doc.cellSize * S;
    const buckets = new Map();
    const bucketFor = key => { if(!buckets.has(key)) buckets.set(key, []); return buckets.get(key); };
    for(const cell of solve.cells){
      if(cell.shape === "empty") continue;
      const {tops, walls} = SHAPE_GEOMETRY[cell.shape];
      const originX = (cell.dx - .5) * tile, originZ = (cell.dy - .5) * tile;
      const place = point => { const [x, z] = rotateShapePoint(point, cell.rotation); return [originX + x * tile, originZ + z * tile]; };
      const topKey = cell.shape === "full" ? `${layer}:top:${cell.variant}` : `${layer}:top:base`;
      for(const polygon of tops) pushTop(bucketFor(topKey), polygon.map(place), topY);
      for(const segment of walls) pushWall(bucketFor(`${layer}:wall:${cell.variant}`), segment.map(place), topY, bottomY);
    }
    for(const [key, positions] of buckets){
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, materialFor(key));
      mesh.name = `terrain:${key}`;
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      built.meshes.push(mesh);
      built.geometries.push(geometry);
    }
  }

  function markContradictions(doc, solve, topY, bottomY){
    if(solve.status === "solved") return;
    const tile = doc.cellSize * S;
    for(const entry of solve.contradictions){
      const geometry = new THREE.BoxGeometry(tile, topY - bottomY + .3, tile);
      const marker = new THREE.Mesh(geometry, contradictionMaterial);
      marker.position.set(entry.dx * tile, (topY + bottomY) / 2 + .15, entry.dy * tile);
      marker.renderOrder = 10;
      marker.name = `contradiction:${solve.layer}`;
      scene.add(marker);
      built.meshes.push(marker);
      built.geometries.push(geometry);
    }
  }

  function placeObjectModel(doc, object, name){
    const tile = doc.cellSize * S;
    const model = buildObjectModel(object.kind, object.variant ?? null);
    const raised = doc.raised[object.cy * doc.width + object.cx] === 1;
    model.position.set((object.cx + .5) * tile, raised ? RAISED_TOP : GROUND_TOP, (object.cy + .5) * tile);
    model.rotation.y = object.rotation ?? 0;
    model.name = name;
    scene.add(model);
    built.objectModels.push(model);
  }

  function buildObjects(doc, scatter){
    for(const object of doc.objects) placeObjectModel(doc, object, `object:${object.kind}:${object.cx},${object.cy}`);
    // The map's center cell is the base ANCHOR — the game reserves its 3x3 footprint there and
    // the player builds the base on it (nothing stands at run start). Preview the cube on that
    // reservation unless the author already placed an explicit base there.
    const baseCx = Math.floor(doc.width / 2), baseCy = Math.floor(doc.height / 2);
    if(!doc.objects.some(object => object.kind === "base" && object.cx === baseCx && object.cy === baseCy))
      placeObjectModel(doc, {kind: "base", cx: baseCx, cy: baseCy}, "baseMarker");
    for(const cell of scatter.trees) placeObjectModel(doc, cell, `generated:tree:${cell.cx},${cell.cy}`);
    for(const cell of scatter.rocks) placeObjectModel(doc, cell, `generated:rock:${cell.cx},${cell.cy}`);
    // scatter.grass = the simulation's cut-grass cells. They have NO model: the legacy tuft
    // instancer was deleted Aug 22 in both hosts. The meadow (createGrass, below) is the grass
    // the editor previews; the count still reports so authors can see the scatter resolved.
    return {explicitObjects: doc.objects.length, generatedTrees: scatter.trees.length, generatedRocks: scatter.rocks.length, generatedGrass: scatter.grass.length};
  }

  const view = {yaw: 0, pitch: 88, dist: 60, tx: 0, tz: 0};
  let lastDoc = null, lastSolves = null;
  // How far shore walls extend below ground tops. Only visible through the
  // transparent depth-foam water (mode 4), where deeper walls widen the
  // shoreline gradient; the game's own walls stop at SHORE_BOTTOM.
  let shoreBottom = WATER_BOTTOM;
  let resourceCounts = {explicitObjects: 0, generatedTrees: 0, generatedRocks: 0, generatedGrass: 0};
  // Debug/test hook: a reduced shape set makes real contradictions reachable
  // in the browser (e.g. no saddle) without touching authored terrain.
  let groundCatalog = GROUND_CATALOG, raisedCatalog = RAISED_CATALOG;

  function fitCamera(doc, pitch = 40){
    const tile = doc.cellSize * S;
    view.tx = doc.width * tile / 2;
    view.tz = doc.height * tile / 2;
    view.yaw = 0;
    view.pitch = pitch;
    view.dist = Math.max(doc.width, doc.height * 1.6) * tile * .78;
  }
  function applyCamera(){
    const pitch = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(view.pitch, 10, 89.9));
    const yaw = THREE.MathUtils.degToRad(view.yaw);
    camera.position.set(
      view.tx + Math.sin(yaw) * Math.cos(pitch) * view.dist,
      Math.sin(pitch) * view.dist,
      view.tz + Math.cos(yaw) * Math.cos(pitch) * view.dist);
    camera.lookAt(view.tx, 0, view.tz);
  }

  function summary(solve){
    return solve.status === "solved"
      ? {status: "solved", attempts: solve.attempts}
      : {status: "contradiction", attempts: solve.attempts, contradictions: solve.contradictions.map(entry => ({...entry}))};
  }

  // Hand this page's renderer to the shared pipeline registry (its own module instance — the game
  // page has its own). waterPrePass with no size = the old per-frame water.update; with a size, a
  // low-res pipeline keeps the foam depth-read aligned to its offscreen target.
  configurePipelines({
    THREE, renderer, scene,
    getCamera: () => camera,
    getSun: () => sun,
    waterPrePass: (w, h) => water.update(camera, w, h),
    view,
    // Same grass sliders the game/test scene get, so density-vs-ms is tunable right here.
    panelSections: [{title: "grass", tune: grassTune, spec: GRASS_PANEL}],
  });

  // ── grass (perf audition toggle) ──
  // The same src/render/grass.js meadow the game runs, sampled off the editor's own rasters:
  // land cells grow at GROUND_TOP, raised at RAISED_TOP (+.03 anti-z-fight, same as the game),
  // water/raised-void cells skip. grassTune (R panel "grass" section / window.grassTune) drives
  // it live, so density-vs-ms can be judged here against the R panel's frame meter on any map
  // size. Off by default: the editor's first job is authoring, not the meadow.
  let meadow = null, meadowOn = false;
  const GRASS_LIFT = .03;
  function buildMeadow(doc){
    if(meadow){ scene.remove(meadow.mesh); meadow.dispose(); meadow = null; }
    if(!meadowOn || !doc) return;
    const tile = doc.cellSize * S;
    const groundC = cellColor("ground:top:base"), raisedC = cellColor("raised:top:base");
    const SKIP = {skip: true}, UP = [0, 1, 0];
    const sample = (x, z) => {
      const cx = Math.floor(x / tile), cy = Math.floor(z / tile);
      if(cx < 0 || cy < 0 || cx >= doc.width || cy >= doc.height) return SKIP;
      const i = cy * doc.width + cx;
      if(doc.land[i] !== 1) return SKIP;
      const raised = doc.raised[i] === 1;
      const c = raised ? raisedC : groundC;
      return {height: (raised ? RAISED_TOP : GROUND_TOP) + GRASS_LIFT, normal: UP,
              color: [c.r, c.g, c.b], dirt: 0};
    };
    meadow = createGrass(THREE, {seed: 7, sample,
      region: {x0: 0, z0: 0, x1: doc.width * tile, z1: doc.height * tile}});
    scene.add(meadow.mesh);
  }

  const preview = {
    // Re-solve both thresholds and rebuild all derived scene state.
    rebuild(doc){
      const ground = solveTerrainWfc({doc, catalog: groundCatalog, layer: "ground", salt: GROUND_SALT});
      const raised = solveTerrainWfc({doc, catalog: raisedCatalog, layer: "raised", salt: RAISED_SALT});
      disposeBuilt();
      water.build(scene, doc);
      buildLayer(doc, ground, "ground", GROUND_TOP, shoreBottom);
      buildLayer(doc, raised, "raised", RAISED_TOP, GROUND_TOP);
      markContradictions(doc, ground, GROUND_TOP, shoreBottom);
      markContradictions(doc, raised, RAISED_TOP, GROUND_TOP);
      const scatter = resolveAuthoredMapScatter(doc);
      resourceCounts = buildObjects(doc, scatter);
      const tile = doc.cellSize * S;
      // Sun POSE from rig.js (az 0 = +X/screen-right, el up), the same direction the game and the
      // model bake use — only the direction matters for a directional light, so the distance just
      // has to clear the map for the shadow camera. The old hand-placed offset lit the editor from
      // a different quarter than the game, which made every authored slope read wrong.
      const span = Math.max(doc.width, doc.height) * tile * .75;
      const cx = doc.width * tile / 2, cz = doc.height * tile / 2;
      const saz = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG), sel = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
      const horizontal = Math.cos(sel) * span * 2;
      sun.position.set(cx + Math.cos(saz) * horizontal, Math.sin(sel) * span * 2, cz + Math.sin(saz) * horizontal);
      sun.target.position.set(cx, 0, cz);
      sun.shadow.camera.left = sun.shadow.camera.bottom = -span;
      sun.shadow.camera.right = sun.shadow.camera.top = span;
      sun.shadow.camera.far = span * 6;
      sun.shadow.camera.updateProjectionMatrix();
      if(!lastDoc || lastDoc.width !== doc.width || lastDoc.height !== doc.height || lastDoc.cellSize !== doc.cellSize) fitCamera(doc);
      lastDoc = doc;
      buildMeadow(doc);   // rasters may have changed under the blades
      lastSolves = {ground: summary(ground), raised: summary(raised)};
      return lastSolves;
    },
    resetCamera(){ if(lastDoc) fitCamera(lastDoc, 88); },
    // The in-game perspective: same pitch/yaw as the game's default view state
    // (scene.js view = {pitch:40, yaw:0, fov:38}); distance/target are kept.
    gameView(){ view.pitch = 40; view.yaw = 0; },
    /** Grass perf toggle; returns the live blade count (0 when off). */
    setGrass(on){
      meadowOn = !!on;
      buildMeadow(lastDoc);
      return meadow ? meadow.instanceCount() : 0;
    },
    // Water candidates 0-5; rebuilds only the water, terrain is untouched.
    setWaterMode(next){ water.setMode(next); if(lastDoc) water.build(scene, lastDoc); },
    setWaterParams(partial){ water.setParams(partial); },
    setShoreDepth(next){
      if(!(next > 0)) throw new Error(`shore depth must be a positive drop below ground, got ${next}`);
      shoreBottom = -next;
      if(lastDoc) preview.rebuild(lastDoc);
    },
    setShapeFilter({ground = null, raised = null} = {}){
      groundCatalog = ground ? buildModuleCatalog({layer: "ground", shapes: ground}) : GROUND_CATALOG;
      raisedCatalog = raised ? buildModuleCatalog({layer: "raised", shapes: raised}) : RAISED_CATALOG;
    },
    orbit(dYaw, dPitch){ view.yaw += dYaw; view.pitch = THREE.MathUtils.clamp(view.pitch + dPitch, 10, 89.9); },
    pan(dx, dz){
      const yaw = THREE.MathUtils.degToRad(view.yaw), scale = view.dist * .0016;
      view.tx += (Math.cos(yaw) * dx + Math.sin(yaw) * dz) * scale;
      view.tz += (-Math.sin(yaw) * dx + Math.cos(yaw) * dz) * scale;
    },
    zoom(factor){ view.dist = THREE.MathUtils.clamp(view.dist * factor, 4, 800); },
    setView(next){ Object.assign(view, next); },
    lastSolves(){ return lastSolves; },
    debugState(){
      let triangles = 0;
      for(const geometry of built.geometries)
        triangles += (geometry.getIndex() ? geometry.getIndex().count : geometry.getAttribute("position").count) / 3;
      return {
        terrainMeshes: built.meshes.length,
        triangles: triangles + water.triangleCount(),
        waterMode: water.mode(),
        waterParams: water.params(),
        shoreBottom,
        objects: resourceCounts.explicitObjects,
        ...resourceCounts,
        contradictionMarkers: built.meshes.filter(mesh => mesh.name.startsWith("contradiction:")).length,
        rendererGeometries: renderer.info.memory.geometries,
        rendererTextures: renderer.info.memory.textures,
        view: {...view},
      };
    },
    renderOnce(){
      const width = canvas.clientWidth || canvas.width, height = canvas.clientHeight || canvas.height;
      if(canvas.width !== width || canvas.height !== height){
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
        resizePipeline(width, height);
      }
      applyCamera();
      meadow?.sync(performance.now() / 1000);   // wind clock; no-op cost when the toggle is off
      // Same registry as the game: F9 toggles current/pixel, R opens the slider panel.
      // The "current" pipeline reproduces the old direct draw exactly (it calls waterPrePass()
      // with no size, which is the old water.update(camera) — waves + pre-pass — then renders).
      // The old ACES-vs-offscreen mismatch between "current" and the pixel pipeline is gone:
      // this renderer no longer tone-maps, matching the game (see the renderer setup above).
      renderFrame();
    },
    dispose(){
      if(meadow){ scene.remove(meadow.mesh); meadow.dispose(); meadow = null; }
      disposeBuilt();
      for(const material of materialCache.values()) material.dispose();
      materialCache.clear();
      water.dispose();
      contradictionMaterial.dispose();
      renderer.dispose();
    },
  };
  return preview;
}
