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
// classes and focus (src/main.js looks it up and hands it to input.js, hud.js and skill-tree.js), and this file
// only reads its client rect to build a raycast ray.
// ═══════════════════════════════════════════════════════════════════════════
import * as THREE from "three";
import {PAL, css, TOWER_TOP} from "./palette.js";
import {
  S,WU,HU,gx,gz, flat, meshOf, isOutline, disposeGroup, FLOOR_TOP,
  makeTree, makeRock, makeDiamond, makeDrop, makeEnemy, makeCorpse, makeGrassTuftGeometry,
  makeChest, makeDamageDummy, makeShowcaseProp,
  makeMainBase, makePegWorker, makeKing, makeBuilding, makeBlueprint, handMeshFor,
  outlineMat, outlineMatPx
} from "./models.js";
import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,
  CELL,GRID_COLS,GRID_ROWS,
  FOOTPRINT_1x1,FOOTPRINT_3x3,
  RESOURCE_KINDS,
  WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_LEASH,
  BUILDING_TYPES,
  ENEMY_TYPES,
  XP_TIERS
} from "../game/data.js";
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCells,footprintWorldRect
} from "../game/grid.js";
import {
  TUNE, state,
  trees, rocks, diamonds, grass, resourceDrops, chests, buildings, friendlyBrutes, controlledEnemies, damageDummies, showcaseProps, workerCorpses, particles, lightningArcs,
  badgeAction, hoveredBuilding, captureYardOccupancy, durablePostStatus,
  canPlace, indicatorRadius, towerVariant, storageServiceRadius, workerAssignmentAt,
  heldWorker, heldEnemy, heldBuilding, heldChest, heldProp, workerLoad,
  vacuumRadius,terrainAtRasterCell,terrainMetadata,terrainRaisedAtCell,vegetationMetadata,
  clamp, distance
} from "../game/simulation.js";
import {LAND} from "../game/authored-map.js";
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAL.sky);

const persp = new THREE.PerspectiveCamera(38, 16/9, 0.5, 600);
const ortho = new THREE.OrthographicCamera(-1,1,1,-1,-200,600);
let camera3 = persp;

// Debug-owned view state. pitch 90 reproduces the original top-down framing.
// MUTABLE HOLDER, on purpose: the debugger writes view.pitch / view.yaw / … as properties, which an
// imported binding allows. `camera3` above is the one value that must be REASSIGNED, so it stays
// module-private and setOrthoCamera() is its only write path.
export const view = {pitch:40, yaw:0, fov:38, ortho:false, orbit:false,
              heightScale:100, ghostPins:false};

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
  persp.fov = view.fov; persp.updateProjectionMatrix();

  const dist = camera3===ortho ? 160 : halfH/Math.tan(THREE.MathUtils.degToRad(view.fov/2));
  const h = Math.sin(p)*dist, r = Math.cos(p)*dist;
  camera3.position.set(tx + Math.sin(y)*r, h, tz + Math.cos(y)*r);
  camera3.lookAt(tx, 0, tz);

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
// Ambient stays low so cast shadows actually read as shadows.
const sky = new THREE.HemisphereLight(PAL.skyLight, PAL.bounce, 0.5);
scene.add(sky);
const sun = new THREE.DirectionalLight(PAL.sunDay, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.035;
scene.add(sun, sun.target);

// ─────────────────────────────────────────────────────────── terrain
// Grass presentation is world-aligned and independent of topology. A 64px deterministic repeat
// avoids maximum-texture-size coupling: RGBA backing is 64*64*4 = 16 KiB CPU and 16 KiB GPU
// (mipmaps disabled), versus 150 MiB each for the former 7680*5120 sheet.
const GRASS_TILE_PX=64,GRASS_TEXTURE_BYTES=GRASS_TILE_PX*GRASS_TILE_PX*4;
const grassLayer=document.createElement("canvas");grassLayer.width=grassLayer.height=GRASS_TILE_PX;
(function bakeGrass(){
  const c=grassLayer.getContext("2d");c.imageSmoothingEnabled=false;
  for(let y=0;y<GRASS_TILE_PX;y+=8)for(let x=0;x<GRASS_TILE_PX;x+=8){
    const n=(x*13+y*7)%31;c.fillStyle=n%3?css(PAL.grass):css(PAL.grassAlt);c.fillRect(x,y,8,8);
    if(n<6){c.fillStyle=css(PAL.grassSpeck);c.fillRect(x+n,y+(n*3)%7,2,2);}
  }
})();
const grassTex=new THREE.CanvasTexture(grassLayer);
grassTex.wrapS=grassTex.wrapT=THREE.RepeatWrapping;grassTex.repeat.set(W/GRASS_TILE_PX,H/GRASS_TILE_PX);
grassTex.magFilter=grassTex.minFilter=THREE.NearestFilter;grassTex.generateMipmaps=false;grassTex.colorSpace=THREE.SRGBColorSpace;
const landMat=flat(0xffffff,{map:grassTex,vertexColors:true});
const REGION_COLORS={forest:new THREE.Color(0x6f965c),rocky:new THREE.Color(0xa8a387),open:new THREE.Color(0xb3c98c),coast:new THREE.Color(PAL.cliff)};
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
  uShallow:{value:new THREE.Color(0x6fb0dd)},uDeep:{value:new THREE.Color(0x22558f)},
  uFoam:{value:new THREE.Color(0xecf6f8)},uSun:{value:new THREE.Vector3(.35,.85,.3).normalize()},
};
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
      float foam=(smoothstep(1.8,.08,thickness)*smoothstep(.3,.8,ripple)
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
const waterFloor=meshOf(new THREE.PlaneGeometry(WU+2*WATER_MARGIN,HU+2*WATER_MARGIN),flat(0x8f855e),false,false);
waterFloor.rotation.x=-Math.PI/2;waterFloor.position.set(WU/2,SHORE_BOTTOM,HU/2);
waterFloor.raycast=NO_RAYCAST;waterFloor.layers.enable(WATER_DEPTH_LAYER);scene.add(waterFloor);
// Horizon fill beyond the detailed mesh; sits under the floor and reads as deep water.
const waterFar=meshOf(new THREE.PlaneGeometry(WU*5,HU*6),flat(0x24568c),false,false);
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
function waterPrePass(){
  if(!waterPrepassEnabled)return;
  const size=renderer.getDrawingBufferSize(_waterBufSize);
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

function rebuildTerrainPresentation(){
  const metadata=terrainMetadata();
  if(metadata.revision!==builtTerrainRevision){
    const grid=authoredCellGrid(metadata),seed=metadata.seed??0;
    const solves=[
      {solve:solveTerrainWfc({doc:grid,catalog:GROUND_CATALOG,layer:"ground",seed,salt:GROUND_SALT}),topY:0,bottomY:SHORE_BOTTOM},
      {solve:solveTerrainWfc({doc:grid,catalog:RAISED_CATALOG,layer:"raised",seed,salt:RAISED_SALT}),topY:RAISED_TOP,bottomY:0},
    ];
    for(const {solve} of solves)if(solve.status!=="solved")throw new Error(`terrain WFC ${solve.layer} contradiction with the complete module catalog`);
    const top=[],uv=[],colors=[],skirts=[],tint=new THREE.Color();
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
        top.push(px,y,pz);uv.push(px/WU,1-pz/HU);colors.push(color.r,color.g,color.b);
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

// Thousands of tufts remain one bounded draw object. Simulation revision is the only invalidation
// input; camera frames never rebuild matrices, and removed tufts disappear on the next revision.
let grassInstances=null,builtVegetationRevision=-1;
const grassMatrix=new THREE.Matrix4(),grassPosition=new THREE.Vector3(),grassRotation=new THREE.Quaternion(),grassScale=new THREE.Vector3();
function syncGrass(){
  const metadata=vegetationMetadata();if(metadata.revision===builtVegetationRevision)return;
  if(grassInstances){scene.remove(grassInstances);grassInstances.geometry.dispose();grassInstances.material.dispose();}
  grassInstances=new THREE.InstancedMesh(makeGrassTuftGeometry(),new THREE.MeshLambertMaterial({color:0xffffff,flatShading:true,side:THREE.DoubleSide}),grass.length);
  grassInstances.name="destructible-grass";grassInstances.castShadow=true;grassInstances.receiveShadow=true;grassInstances.raycast=NO_RAYCAST;
  grass.forEach((tuft,index)=>{
    const variant=tuft.variant%PAL.grassTuft.length,scale=.8+variant*.07;
    grassPosition.set(gx(tuft.x),terrainLiftAt(tuft.x,tuft.y)+.025,gz(tuft.y));grassRotation.setFromAxisAngle(_upY,((tuft.x*13+tuft.y*7)%628)/100);grassScale.set(scale,scale,scale);
    grassMatrix.compose(grassPosition,grassRotation,grassScale);grassInstances.setMatrixAt(index,grassMatrix);grassInstances.setColorAt(index,new THREE.Color(PAL.grassTuft[variant]));
  });
  grassInstances.instanceMatrix.needsUpdate=true;if(grassInstances.instanceColor)grassInstances.instanceColor.needsUpdate=true;scene.add(grassInstances);builtVegetationRevision=metadata.revision;
}

const syncTrees = makeLayer(makeTree, (g,t)=>{
  setXZ(g,t);
  const d = g.userData, felled = t.stump>0;
  d.trunk.visible = d.crown.visible = !felled;
  d.stump.visible = felled;
  g.rotation.z = felled ? 0 : shakeOf(t);
  const wear = felled ? 1 : .78 + .22*(t.hp/t.max);
  g.scale.set(wear, wear*view.heightScale/100, wear);
});
const syncRocks = makeLayer(makeRock, (g,r)=>{
  setXZ(g,r);
  const d = g.userData, spent = r.depleted>0;
  for(const m of d.live) m.visible = !spent;
  d.rubble.visible = spent;
  g.rotation.z = spent ? 0 : shakeOf(r);
  const wear = (spent ? 1 : .8 + .2*(r.hp/r.max))*(r.meteor?2.25:1);
  g.scale.set(wear, wear*view.heightScale/100, wear);
});
const syncDiamonds = makeLayer(makeDiamond, (g,n)=>{
  setXZ(g,n);
  const d = g.userData, spent = n.depleted>0;
  for(const m of d.live) m.visible = !spent;
  d.spent.visible = spent;
  g.rotation.z = spent ? 0 : shakeOf(n);
  if(!spent) d.gem.rotation.y += .02;
  g.scale.y = view.heightScale/100;
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
  setXZ(g, r, 0);
  g.rotation.set(0, r.spin*.25, 0);      // sim spins at 4 rad/s; that reads far too fast
  g.scale.setScalar(1);
  const fading = r.ttl!==null && r.ttl<2 && Math.floor(r.ttl*7)%2===0;
  g.userData.body.visible = !fading;
});
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
  for(const material of d.tintMats||[])material.emissive.setHex(unit.flash>0?PAL.flash:0x244a35);
  setXZ(g,unit);g.rotation.set(0,d.yaw,0);
  g.scale.set(S,S*view.heightScale/100,S);
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
  const seen = new Set();
  for(const b of buildings){
    // The blueprint key carries its type now that the blueprint pad is footprint-sized.
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
    rec.g.visible = true;
    setXZ(rec.g, b);
    rec.g.scale.y = view.heightScale/100;
    const pulse = 1 + (b.pulse||0)*.12;
    rec.g.scale.x = rec.g.scale.z = pulse;
    // The pad marks RESERVED CELLS, so it must not breathe with the pulse: undo the group's
    // horizontal scale on the floor alone. Its extents then always equal the placement preview's.
    if(rec.g.userData.floor) rec.g.userData.floor.scale.set(1/pulse, 1, 1/pulse);
    if(b.complete && b.type==="tower" && b.tower){
      const hurt = b.tower.hitFlash>0;
      for(const p of rec.g.userData.parts||[]) p.material.emissive.setHex(hurt?PAL.hurtGlow:0x000000);
    }
    if(rec.g.userData.tip) rec.g.userData.tip.rotation.y += .02;
    if(b.orbs&&rec.g.userData.orbit){rec.g.userData.orbit.rotation.y=b.orbs.angle;rec.g.userData.orbs.forEach((orb,index)=>orb.visible=index<b.orbs.count);}
    // Derived occupancy drives the sage bay caps directly: one visible cap per living linked ally,
    // so a capture or an ally death changes the model on the very next frame.
    if(b.type==="captureYard"&&rec.g.userData.slotMarkers){const held=captureYardOccupancy(b);rec.g.userData.slotMarkers.forEach((cap,index)=>cap.visible=index<held);}
    // Same contract for the garrison's two station pennants, read off the durable-post status the
    // overlay already uses: a pennant flies only for a guard that has ARRIVED, so a reserved-but-
    // travelling slot stays bare and matches the "! vacant" label. Outside a normal run (showcase,
    // and therefore the placement ghost's untracked copy too) the status is null and the station
    // shows its full dress.
    if(b.type==="garrison"&&rec.g.userData.postMarkers){const staffing=durablePostStatus(b),flying=staffing?staffing.arrived:rec.g.userData.postMarkers.length;rec.g.userData.postMarkers.forEach((pennant,index)=>pennant.visible=index<flying);}
  }
  for(const [b,rec] of buildingStore){
    if(seen.has(b))continue;
    scene.remove(rec.g); disposeGroup(rec.g); buildingStore.delete(b);
  }
}

// The main base swaps between its asleep and awake models at the first XP tier (the orb wakes with
// the thing). Its gulp is driven off the sim's basePulse RISING EDGE with a local clock, because
// basePulse itself decays in a third of a second — too fast to phase a readable swallow.
let baseRec = null, lastBasePulse = 0, gulpStart = -9;
function syncBase(t){
  const awake = state.xp >= XP_TIERS[0];
  if(!baseRec || baseRec.awake!==awake){
    if(baseRec){ scene.remove(baseRec.g); disposeGroup(baseRec.g); }
    baseRec = {awake, g: makeMainBase(awake)};
    scene.add(baseRec.g);
  }
  const g = baseRec.g;
  g.scale.y = view.heightScale/100;
  if(state.basePulse > lastBasePulse + .5) gulpStart = t;   // a delivery landed
  lastBasePulse = state.basePulse;
  const {inner, anims} = g.userData;
  const gp = (t-gulpStart)/0.9;
  if(gp>=0 && gp<1 && anims.gulp) anims.gulp(inner, gp, t);
  else anims.idle(inner, 0, t);
}
const kingMesh = makeKing(); scene.add(kingMesh);

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

  // Splash rings fire when the shell lands, not when the barrel flashes.
  for(const im of impacts)
    ring(im.x, im.y, im.r*(.3+.7*im.t), im.col, (1-im.t)*.9);

  for(const e of state.enemies){
    if(e.shotFlash > 0)
      beam(e.x, e.y, .8, e.shotX ?? BASE.x, e.shotY ?? BASE.y, .7, .055,
           "#d9b65f", clamp(e.shotFlash*7, 0, 1));
    if(e.healFlash > 0 && e.healX!==undefined)
      beam(e.x, e.y, 1.0, e.healX, e.healY, 1.0, .07,
           "#75c86d", clamp(e.healFlash*3, 0, 1));
  }

  for(const w of state.workers)
    if(w.combatTarget && w.attackCooldown > WORKER_ATTACK_RATE-.2)
      beam(w.x, w.y, .8, w.combatTarget.x, w.combatTarget.y, .7, .06, "#f3dfa3", .85);

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
    const s = p.resource ? 1.6 : 1;
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

// ─────────────────────────────────────────────────────────── previews (ghosts)
const ghostBuild = {key:null, g:null};
function showGhostBuilding(type, x, y, ok, lift=0){
  const key = type;
  if(ghostBuild.key!==key){
    if(ghostBuild.g){ scene.remove(ghostBuild.g); disposeGroup(ghostBuild.g); }
    ghostBuild.g = makeBuilding(type);
    // The ghost's own pad is hidden: showFootprint() draws the reserved cells on the ground, and a
    // held building floats on the cursor, where a pad would just hang in the air.
    if(ghostBuild.g.userData.floor) ghostBuild.g.userData.floor.visible = false;
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
// rect. The player sees the same cells canPlace() tested and the same rectangle the finished floor
// will cover, so the preview and the committed pad share one source of dimensions.
// Depth: the quads ride just above the tallest pad (FLOOR_TOP) so an invalid placement over an
// existing building still shows red instead of being swallowed by that building's own floor. They
// keep depthTest on — trees and towers still occlude them correctly — with depthWrite off and a
// negative polygon offset so nothing coplanar (a tar puddle, another pad) can flicker against them.
// Ownership: these live directly in the scene, never inside a group disposeGroup() will visit, so
// their geometry and materials are shared module singletons and are never disposed.
const CELL_U = CELL*S;                 // one cell in world units
const GHOST_Y = FLOOR_TOP + .035;
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
  // The border is the authority on extents: exactly footprintWorldRect(), the rect the pad fills.
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
// its pad covers, cellWorldRect() supplies the one-CELL case out of the same lattice, and
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
// Depth: both ride above GHOST_Y, so they clear pads (FLOOR_TOP), previews and the footprint border
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
 * from buildingFootprint() -> footprintWorldRect(), the same pair showFootprint() measures its pad
 * with, so 1x1 and 3x3 need no special casing and no dimension is restated here.
 *
 * Colour is the placement verdict, PAL.cellOk/PAL.cellBad — the same two colours CELL_MAT/EDGE_MAT
 * tint the pad with, so corners, ring and cells flip together. Only the CORNERS breathe (a pulse on
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

  if(m.inside && distance(m.x,m.y,BASE.x,BASE.y)<BASE.r+16) ring(BASE.x,BASE.y,BASE_ZONE);

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
    ring(BASE.x,BASE.y,BASE_ZONE,css(PAL.storage),.4);
    for(const s of buildings) if(s.complete && s.type==="stockpile")
      ring(s.x,s.y,storageServiceRadius(s),css(PAL.storage),.4);
  }

  hideGhostBuilding();
  hideFootprint();
  // Previews snap with snapToCellCenter() — the exact call leftClick()/dropHeldObject() commit with —
  // so the ghost's cell, its validity tint, and the placed anchor can never disagree.
  if(state.buildMode && m.inside){
    const a = snapToCellCenter(m.x, m.y);
    const ok = canPlace(a.x, a.y, state.buildMode);
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
        const a=snapToCellCenter(m.x,m.y),ok=canPlace(a.x,a.y,null,null,null,chest);
        showFootprint(null,a.x,a.y,ok);showSelector(cellWorldRect(a.x,a.y),{color:css(ok?PAL.cellOk:PAL.cellBad),opacity:.9,pulse:indicatorPulse(t)});
      }
      const prop=heldProp();
      if(prop){
        const a=snapToCellCenter(m.x,m.y),ok=canPlace(a.x,a.y,null,null,prop);
        showFootprint(null,a.x,a.y,ok);showSelector(cellWorldRect(a.x,a.y),{color:css(ok?PAL.cellOk:PAL.cellBad),opacity:.9,pulse:indicatorPulse(t)});
      }
      const b = heldBuilding();
      if(b){
        const a = snapToCellCenter(m.x, m.y), ok = canPlace(a.x, a.y, b.type, b);
        showFootprint(b.type, a.x, a.y, ok);
        showGhostBuilding(b.type, a.x, a.y, ok, 1.6 + Math.sin(t*5)*.12);
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
  sun.position.set(gx(cam.x)-26, 46, gz(cam.y)+20);
  sun.target.position.set(gx(cam.x), 0, gz(cam.y));
  sun.target.updateMatrixWorld();
  // Night dims and cools the key light; day/night already lives in state.clock.
  const night = state.clock.light;
  sun.intensity = 1.1 - night*.75;
  sun.color.setHex(night>.25 ? PAL.sunNight : PAL.sunDay);
  // The water shader ignores scene lights, so it tracks the night dim explicitly.
  waterUniforms.uLight.value = 1 - night*.6;
  // The grid is unlit, so without this it would stay bright while the map darkens and end up the
  // loudest thing on screen at night. Fading it keeps it under the terrain and the combat marks.
  // Overview zoom suppresses the 32px lattice; normal/build zoom retains full precision.
  const overviewFade=THREE.MathUtils.smoothstep(state.camera.zoom,.2,.58);
  gridMat.opacity = GRID_OPACITY * overviewFade * (1 - night*.55);
  // Fully transparent lines still cost a draw call; overview hides the object as well as fading it.
  if(terrainGrid)terrainGrid.visible=gridMat.opacity>0;

  syncGrass();syncTrees(trees); syncRocks(rocks); syncDiamonds(diamonds);
  syncChests(heldChest()?[...chests,heldChest()]:chests);
  syncDrops(resourceDrops); syncCorpses(workerCorpses);
  syncEnemies(heldEnemy()?[...state.enemies,heldEnemy()]:state.enemies);syncFriendlyBrutes(friendlyBrutes);syncControlledEnemies(controlledEnemies);syncWorkers();
  syncDummies(damageDummies);syncShowcaseProps(showcaseProps);
  syncBuildings(); syncParticles(); syncHand();

  // Sim-px outline shells track the view panel's weight slider through the world-unit material.
  outlineMatPx.uniforms.thickness.value = outlineMat.uniforms.thickness.value / S;
  syncBase(performance.now()/1000);
  const king = state.king;
  kingMesh.position.set(gx(king.x), terrainLiftAt(king.x,king.y), gz(king.y));
  kingMesh.scale.y = view.heightScale/100;
  kingMesh.userData.sword.rotation.z = king.swing>0 ? -1.2 : 0;

  // Shots advance on real elapsed time, independent of the sim step count.
  const nowS = performance.now()/1000;
  stepShots(Math.min(.05, nowS - (lastDrawT || nowS)));
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
/** The draw call itself, split from drawScene() so pins land in the scene before it runs. */
export function renderScene(){ waterPrePass(); renderer.render(scene, camera3); }

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
      const owner = hit.object.userData.ent;
      if(owner === e) continue;                 // its own body doesn't count
      if(hit.distance < dist - .15){ blocked = true; break; }
    }
    if(blocked) hidden.push(_sp.clone()); else vis++;
  }
  return {vis, total:list.length, hidden};
}
