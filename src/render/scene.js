// Owns: the three.js renderer, cameras, lights, terrain, every mesh pool and ground mark, world
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
//   Supplies: project() — the scene->overlay projection boundary. This module is the PRODUCER of
//             screen coordinates; src/render/overlay.js is the sole CONSUMER. The dependency runs
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
import {PAL, css, DROP_COLOR, TOWER_TOP} from "./palette.js";
import {
  S,WU,HU,gx,gz, flat, meshOf, isOutline, disposeGroup, FLOOR_TOP,
  makeTree, makeRock, makeDiamond, makeDrop, makeEnemy, makeWorker, makeCorpse,
  makeBase, makeKing, makeBuilding, makeBlueprint, handMeshFor
} from "./models.js";
import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,
  CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,GRID_COLS,GRID_ROWS,
  FOOTPRINT_1x1,FOOTPRINT_3x3,
  RESOURCE_KINDS,
  WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_LEASH,
  BUILDING_TYPES,
  ENEMY_TYPES
} from "../game/data.js";
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCells,footprintWorldRect
} from "../game/grid.js";
import {
  TUNE, state,
  trees, rocks, diamonds, resourceDrops, buildings, workerCorpses, particles,
  badgeAction, hoveredBuilding,
  canPlace, indicatorRadius, towerVariant, storageServiceRadius, workerAssignmentAt,
  heldWorker, heldBuilding, workerCoatColor, workerLoad,
  clamp, distance
} from "../game/simulation.js";

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
//   showVacuumRing — whether to DRAW the ring; its radius is TUNE.vacuumRadius, the real reach.
export const VIEW_TUNE = {
  handArc:2,           // world units a collected drop arcs on its way in   [slider vArc]
  showVacuumRing:true, //                                                   [slider vRing]
  shotSpeed:26,        // tower projectile travel, world units per second   [slider vShotSpeed]
  shotArc:1,           // multiplier on how much a shot lobs                [slider vShotArc]
  shotSize:1,          // projectile scale multiplier                       [slider vShotSize]
};

function workerToolKind(worker){
  if(worker.job==="harvest")return worker.jobTarget?.kind;
  if(worker.job==="staff")return BUILDING_TYPES[worker.jobTarget?.type]?.resource;
  if(worker.job==="build")return "build";
  return null;
}

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
  scene.traverse(o=>{ if(o.isMesh) o.material.needsUpdate = true; });
}

export function placeCamera(){
  const cam = state.camera;
  const tx = gx(cam.x), tz = gz(cam.y);
  const p = THREE.MathUtils.degToRad(view.pitch), y = THREE.MathUtils.degToRad(view.yaw);
  // Ortho frustum matches the 2D game's coverage exactly, so clampCamera() and
  // the .2-5 zoom range carry over unchanged.
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
const _pv = new THREE.Vector3();
/** game (x,y) plus height in game px -> overlay canvas coords (960x540). */
export function project(x, y, hpx=0){
  _pv.set(gx(x), hpx*S, gz(y)).project(camera3);
  return {x:(_pv.x*.5+.5)*VIEW_W, y:(-_pv.y*.5+.5)*VIEW_H, depth:_pv.z};
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

// ─────────────────────────────────────────────────────────── ground
// The original pixel-art ground generator, repainted in the prototype's palette.
const groundLayer=document.createElement("canvas");groundLayer.width=W;groundLayer.height=H;
(function bakeGround(){
  const c=groundLayer.getContext("2d");c.imageSmoothingEnabled=false;
  for(let y=0;y<H;y+=8)for(let x=0;x<W;x+=8){
    const n=(x*13+y*7)%31;
    c.fillStyle=n%3?css(PAL.grass):css(PAL.grassAlt);c.fillRect(x,y,8,8);
    if(n<6){c.fillStyle=css(PAL.grassSpeck);c.fillRect(x+n,y+(n*3)%7,2,2);}
  }
  // No dirt clearing under the base: it wears the same footprint pad as every other building.
})();
const groundTex = new THREE.CanvasTexture(groundLayer);
groundTex.magFilter = THREE.NearestFilter;
groundTex.colorSpace = THREE.SRGBColorSpace;

const ground = meshOf(new THREE.PlaneGeometry(WU,HU), flat(0xffffff,{map:groundTex}), false, true);
ground.rotation.x = -Math.PI/2;
ground.position.set(WU/2, 0, HU/2);
scene.add(ground);

// Slab sides so the map reads as an object rather than an infinite plane.
// Its top must sit BELOW the ground plane — coincident faces z-fight and the
// terrain turns into brown/green stripes.
const slab = meshOf(new THREE.BoxGeometry(WU, 3.0, HU), flat(PAL.cliff), false, false);
slab.position.set(WU/2, -1.53, HU/2);          // top face at y = -0.03
scene.add(slab);

// Water surrounds the slab, same as the prototype's island read.
const water = meshOf(new THREE.PlaneGeometry(WU*5, HU*6), flat(PAL.water), false, false);
water.rotation.x = -Math.PI/2;
water.position.set(WU/2, -1.9, HU/2);
scene.add(water);

// ─────────────────────────────────────────────────────────── placement grid
// The simulation owns the lattice (CELL, GRID_ORIGIN_*, GRID_COLS/ROWS); this only draws it, so the
// lines land on cell BOUNDARIES. Every square therefore encloses exactly one snap target — the same
// cell centre snapToCellCenter() commits to and the same anchor seedWorld() gave each resource node.
// Edge treatment: the half-clipped border cells put boundaries at -CELL/2 and past W/H. Those are
// skipped rather than clamped — a clamped line would sit mid-cell and lie about where a cell ends.
// Cost: (GRID_COLS-1) + (GRID_ROWS-1) = 80 segments in one LineSegments, a single draw call.
const GRID_Y = .015;          // world units above the ground plane: enough to win the depth test
const GRID_OPACITY = .24;     // deliberately faint; drawScene() fades it further at night
const gridMat = new THREE.LineBasicMaterial({color:PAL.grid, transparent:true,
                                             opacity:GRID_OPACITY, depthWrite:false});
const terrainGrid = (function buildTerrainGrid(){
  const v = [];
  for(let cx=0; cx<=GRID_COLS; cx++){
    const x = GRID_ORIGIN_X + cx*CELL;
    if(x<0 || x>W) continue;
    v.push(gx(x), GRID_Y, gz(0), gx(x), GRID_Y, gz(H));
  }
  for(let cy=0; cy<=GRID_ROWS; cy++){
    const y = GRID_ORIGIN_Y + cy*CELL;
    if(y<0 || y>H) continue;
    v.push(gx(0), GRID_Y, gz(y), gx(W), GRID_Y, gz(y));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  const lines = new THREE.LineSegments(geo, gridMat);
  // Not a mesh and not a shadow caster, so scanBlockers() cannot pick it up as an occluder.
  lines.castShadow = lines.receiveShadow = false;
  lines.renderOrder = -1;      // below rings, ghosts and every other transparent mark
  return lines;
})();
scene.add(terrainGrid);

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
const setXZ = (g,e,y=0)=>g.position.set(gx(e.x), y, gz(e.y));
const shakeOf = e => e.shake ? Math.sin(e.shake*28)*.12 : 0;

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
  const wear = spent ? 1 : .8 + .2*(r.hp/r.max);
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
const syncEnemies = makeLayer(e=>makeEnemy(e.type), (g,e)=>{
  const def = ENEMY_TYPES[e.type], s = def.size;
  setXZ(g,e, Math.abs(Math.sin(e.wob))*.1);
  g.scale.set(s, s*view.heightScale/100, s);
  g.rotation.z = Math.sin(e.wob)*.09;                    // the wobble-walk
  const d = g.userData;
  d.body.material.color.setHex(e.flash ? PAL.flash : d.baseColor);
  const burning = !!e.status?.burn;
  d.body.material.emissive.setHex(burning ? PAL.emberGlow : 0x000000);
});
const syncWorkers = makeLayer(makeWorker, (g,w)=>{
  const t = performance.now()/1000;
  if(w===heldWorker() && state.mouse.inside){
    // Lifted units ride the cursor, exactly like the demo's carried object.
    g.position.set(gx(state.mouse.x), 2.2 + Math.sin(t*5)*.14, gz(state.mouse.y));
    g.rotation.z = Math.sin(t*7)*.13;
  } else {
    setXZ(g,w, Math.abs(Math.sin(w.step*8))*.08);
    g.rotation.z = Math.sin(w.step*8)*.10;
  }
  g.scale.y = view.heightScale/100;
  const d = g.userData;
  d.body.material.color.set(workerCoatColor(w));
  const load = workerLoad(w);
  d.load.visible = load>0;
  if(load){
    const k = w.carried.diamond?"diamond":w.carried.coin?"coin":w.carried.dust?"dust":w.carried.stone?"stone":"wood";
    d.load.material.color.setHex(DROP_COLOR[k]);
  }
  const tool = workerToolKind(w);
  const swinging = (w.combatTarget && w.attackCooldown>WORKER_ATTACK_RATE-.2) ||
                   (tool && w.hitCooldown>WORKER_HIT_COOLDOWN-.2);
  d.tool.rotation.z = swinging ? -1.1 : .25;
});
const syncCorpses = makeLayer(c=>makeCorpse(c.coat), (g,c)=>{
  g.position.set(gx(c.x+c.pose), .1, gz(c.y+c.pose*.35));
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
  }
  for(const [b,rec] of buildingStore){
    if(seen.has(b))continue;
    scene.remove(rec.g); disposeGroup(rec.g); buildingStore.delete(b);
  }
}

const baseMesh = makeBase(); scene.add(baseMesh);
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
  m.position.set(gx(x), .09, gz(y));
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
  m.position.set(gx(x), h, gz(y));
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
    const topH = 3.4*hs;                       // the tower deck
    const area = v.attackMode==="periodic area" || v.attackMode==="manual area";

    // A rising flash means it just fired. Launch the visual for that shot.
    const prev = lastFlash.get(b) ?? 0;
    if(t.flash > prev){
      if(v.attackMode==="splash" && t.impactX!==undefined)
        spawnShot(b.x,b.y,topH, t.impactX,t.impactY, .35, col, 1.6, 2.4,
                  {x:t.impactX, y:t.impactY, r:v.splashRadius||40, col});
      else if(!area && v.attackMode!=="line" && t.targetX!==undefined)
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
    ring(m.x, m.y, TUNE.vacuumRadius, css(PAL.ok), .45 + Math.sin(t*6)*.18);

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
  // The grid is unlit, so without this it would stay bright while the map darkens and end up the
  // loudest thing on screen at night. Fading it keeps it under the terrain and the combat marks.
  gridMat.opacity = GRID_OPACITY * (1 - night*.55);

  syncTrees(trees); syncRocks(rocks); syncDiamonds(diamonds);
  syncDrops(resourceDrops); syncCorpses(workerCorpses);
  syncEnemies(state.enemies); syncWorkers(state.workers);
  syncBuildings(); syncParticles(); syncHand();

  const basePulse = 1 + state.basePulse*.1;
  baseMesh.scale.set(basePulse, view.heightScale/100, basePulse);
  // The pad marks BASE's RESERVED CELLS, so it must not breathe with the store pulse - same
  // counter-scale syncBuildings() applies to every other building's footprint floor.
  baseMesh.userData.floor.scale.set(1/basePulse, 1, 1/basePulse);
  const king = state.king;
  kingMesh.position.set(gx(king.x), 0, gz(king.y));
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
export function renderScene(){ renderer.render(scene, camera3); }

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
  for(const w of state.workers) out.push([w,.8]);
  for(const e of state.enemies) out.push([e,.8]);
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
  for(const [e,h] of list){
    _sp.set(gx(e.x), h*view.heightScale/100, gz(e.y));
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
