// Temporary home for the complete game runtime while it is decomposed into modules.
import * as THREE from "three";
// ── authored data ──
// Every immutable definition the game is authored from now lives in src/game/data.js: world and
// frame dimensions, the placement lattice, footprints, resource kinds, the building / upgrade /
// tower / enemy tables, the wave recipes and the pacing constants. Nothing here may reassign or
// mutate any of them (see the DBG rule below); this file only reads.
import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,BUILD_MARGIN,
  CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,GRID_COLS,GRID_ROWS,
  FOOTPRINT_1x1,FOOTPRINT_3x3,RESOURCE_FOOTPRINT,
  RESOURCE_KINDS,
  HOUSE_SLOTS,HOUSE_COST,HOUSE_COST_ESCALATION,WORKER_SPAWN_TIME,
  WORKER_LEASH,WORKER_MELEE,WORKER_SPEED,WORKER_HP,WORKER_DAMAGE,WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_CARRY,
  BUILDING_TYPES,UPGRADES,TOWER_VARIANTS,
  ENEMY_TYPES,MAP_SIDE,MAP_SIDES,WAVE_FRONT_SECONDARY,
  ENEMY_POOL,DAY_ENEMY_SPAWN,DAY_ENEMY_CAP,
  NIGHT_WAVE_SPAWNS,NIGHT_WAVE_WINDOW,NIGHT_ENEMY_CAP,NIGHT_TELEGRAPH_TIME,NIGHT_WAVE_RECIPES,
  DAY_DURATION,NIGHT_DURATION,NIGHT_OVERLAY_ALPHA,LIGHT_FADE_TIME,
  KING,STEADY_HAND_RATE
} from "./game/data.js";
// ── placement math ──
// Pure lattice helpers over those definitions (src/game/grid.js). Occupancy, the build margin and the
// placement verdict itself are NOT there: canPlace() below composes them from these helpers and the
// live world arrays.
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCellBounds,footprintCells,footprintWorldRect,footprintInWorldBounds
} from "./game/grid.js";

// Raycast scratch shared by input (defined here so the sim's handlers can use it).
const _ndc=new THREE.Vector2(), _ray=new THREE.Raycaster(), _ghit=new THREE.Vector3();
const _groundPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);

// ── debug-tunable feel constants (view panel > pickup) ───────────────────────
// These deliberately do NOT live in data.js. Every one is REASSIGNED at runtime by the view panel's
// bindV() bindings at the bottom of this file, and an imported binding is read-only in the importing
// module — moving them would turn each slider into a silent no-op (or a TypeError). They stay as
// module-level `let`s here so the writer and every reader share one binding. The one authored
// sibling that is never written, STEADY_HAND_RATE, is imported from data.js instead.
let CHOP_TIME=.7;          // seconds of held left-click per harvest hit
let VACUUM_RADIUS=45;      // game px that collectDrop() sweeps
let SUCK_RATE=.08;         // seconds between vacuum pickups
let HAND_ARC=2;            // world units a collected drop arcs on its way in
let SHOW_VACUUM_RING=true;
let GAME_SPEED=1;          // whole simulation steps per rendered frame
let SHOT_SPEED=26;         // tower projectile travel, world units per second
let SHOT_ARC=1;            // multiplier on how much a shot lobs
let SHOT_SIZE=1;           // projectile scale multiplier
let CHOP_YIELD=1;          // drops spawned per completed player chop
let CLICK_DAMAGE=1;        // hp removed per completed player swing on an enemy

// Harvesting is hold-to-fill rather than per-click, so it needs its own timer.
const chopState={target:null,kind:null,t:0};
function beginChop(hit){
  if(chopState.target===hit.target)return;
  chopState.target=hit.target;chopState.kind=hit.kind;chopState.t=0;
}
function resetChop(){chopState.target=null;chopState.kind=null;chopState.t=0;}
function chopProgress(){return chopState.target?clamp(chopState.t/CHOP_TIME,0,1):0;}

// Wooddrop's world is one explicit state object. Input mutates it; update advances it; draw only reads it.
const canvas = document.getElementById("overlay");   // 2D overlay sits above the WebGL scene
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled=false;
// World/frame dimensions (VIEW_W/VIEW_H, W/H), BASE, BASE_ZONE, the placement lattice
// (CELL, GRID_ORIGIN_*, GRID_COLS/ROWS), the footprint records and every authored table are imported
// from ./game/data.js; the pure lattice math is imported from ./game/grid.js. See those files for the
// grid's half-cell origin, its half-clipped border cells, and the odd-footprint rule.
const trees = [];
const rocks = [];
const diamonds = [];
const resourceDrops = [];
const buildings = [];
// ── Worker corpse ownership flow ──
// Written by: killWorker() creates one immutable visual snapshot per final death.
// Read by:    draw() only; corpses never enter interaction, placement, targeting, or update systems.
// Format:     death position plus compact pose/clothing values; never a mutable Worker object.
// Lifetime:   page load until run restart; no decay or removal.
const workerCorpses = [];
const particles = [];
const state = {
  mouse:{x:W/2,y:H/2,inside:false},
  carried:{wood:0,stone:0,dust:0,coin:0,diamond:0}, stored:{wood:0,stone:0,dust:0,coin:0,diamond:0}, workers:[], enemies:[],
  baseHp:100,baseMax:100,gameOver:false,paused:false,dayEnemyTimer:DAY_ENEMY_SPAWN.min,coinTimer:6,basePulse:0,buildMode:null,buildDockCategory:null,capacity:5,toastTimer:0,collectCooldown:0,collecting:false,
  // elapsed: total simulated seconds this run. It accumulates the same dt the phase countdown
  // spends, so it is game time, not wall time — it does not advance while paused or after a loss,
  // and a raised game speed makes it run as fast as the phases do.
  clock:{phase:"day",remaining:DAY_DURATION,completedNights:0,light:0,elapsed:0},
  nightWave:{upcomingSide:null,upcomingRecipe:null,activeSide:null,secondarySide:null,activeRecipe:null,lastSides:[],remainingSpawns:0,elapsed:0,nextSpawnAt:0,nightNumber:0},
  camera:{x:BASE.x,y:BASE.y,zoom:1,panning:false,lastX:0,lastY:0}, keys:new Set(),
  upgradeMenu:{building:null,selected:null,kind:null},primaryClick:{held:false,audioCooldown:0},heldObject:null,buildStacks:{spikes:5,landmine:3,tar:3},
  king:{x:BASE.x,y:BASE.y+18,cooldown:0,swing:0,targetX:BASE.x,targetY:BASE.y}
};

const rand = (a,b) => a + Math.random()*(b-a);
const distance = (a,b,c,d) => Math.hypot(a-c,b-d);
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const carriedTotal=()=>RESOURCE_KINDS.reduce((total,kind)=>total+state.carried[kind],0);
// ── Gameplay debug flags (view panel > gameplay) ──────────────────────────────
// THE single home for every debug switch that the simulation is allowed to read.
// HARD RULE: no debug flag may ever mutate authored data — building/upgrade cost
// tables, tower or enemy stats, and wave recipes stay exactly as written, and no
// flag writes state.stored. A flag only ever short-circuits a *pipeline* (skip the
// delivery, skip the spawn timer, skip the damage subtraction); the buttons below
// call the same entry points play does. The sim treats DBG as read-only: the only
// writers are the gameplay pane's own bindings.
const DBG={
  freeCosts:false,          // blueprints + accepted upgrades finish on placement/accept
  unlimitedCharges:false,   // stack:true deployables never decrement state.buildStacks
  invulnBase:false,         // enemy hits on the base subtract nothing
  instantWorkers:false      // houses ignore their spawn timer
};

// ── Global upgrade ownership flow ──
// Legitimate writes: completed obelisks set building.upgrades[id] in dropToUpgrade().
// Gameplay reads:    globalUpgradeEnabled() is pure obelisk ownership; there is no override map.
function legitimateGlobalUpgradeOwned(id){return buildings.some(building=>building.complete&&building.type==="obelisk"&&building.upgrades[id]);}
function globalUpgradeEnabled(id){return legitimateGlobalUpgradeOwned(id);}
function oppositeMapSide(side){return side===MAP_SIDE.NORTH?MAP_SIDE.SOUTH:side===MAP_SIDE.SOUTH?MAP_SIDE.NORTH:side===MAP_SIDE.EAST?MAP_SIDE.WEST:MAP_SIDE.EAST;}
function chooseUpcomingNight(){
  const wave=state.nightWave,choices=MAP_SIDES.filter(side=>!wave.lastSides.includes(side));
  wave.upcomingSide=choices[(Math.random()*choices.length)|0];
  wave.upcomingRecipe=NIGHT_WAVE_RECIPES[(Math.random()*NIGHT_WAVE_RECIPES.length)|0];
}
chooseUpcomingNight();

// Full land map: dense resource patches surround one initial clearing.
// ── Resource cell ownership ──
// Written by: seedWorld() — the only writer of initial node cells. Every tree/rock/diamond is born on
//             a cell CENTER and claims that cell exclusively, so no two active nodes share ground.
// Read by:    canPlace(), the occupancy consumer — it maps each node back through worldToCell() and
//             refuses any building footprint overlapping an ACTIVE node's cell. A depleted node keeps
//             its original cell (nothing ever moves it) but stops blocking, so clearing a node frees
//             exactly the one cell it stood on for construction.
const SEED_CELL_TRIES=8000;   // per-batch dart throws before a layout is declared unworkable
const SEED_LAYOUT_TRIES=24;   // whole-world re-rolls; diamonds are the batch that can genuinely box out
function seedWorld(){
  const cellKey=(cx,cy)=>cy*GRID_COLS+cx;   // unique per addressable cell; cx<GRID_COLS by construction
  const attempt=()=>{
    const occupied=[],takenCells=new Set();
    // Bounded rejection sampling: a batch ends by satisfying `count` or by reporting a shortfall.
    // `minGap` is a SCATTER rule, not a placement rule: it only spreads a batch out at seed time so the
    // map does not clump. It is NOT the old circular building-spacing ring, which cell occupancy in
    // canPlace() replaced outright — placed objects are separated by cells, never by a distance.
    const place=(count,minGap,make,accept=()=>true)=>{
      let tries=0;
      while(count>0&&tries++<SEED_CELL_TRIES){
        // Sample broadly in world space, then quantize with the shared helpers — keeps the old scatter
        // instead of stepping cells in order, which would read as obvious uniform rows.
        const c=worldToCell(rand(30,W-30),rand(35,H-25));
        if(takenCells.has(cellKey(c.cx,c.cy)))continue;          // one node per cell, no exceptions
        if(!footprintInWorldBounds(c.cx,c.cy,RESOURCE_FOOTPRINT))continue;
        const {x,y}=cellToWorld(c.cx,c.cy);                      // nodes live exactly on cell centers
        if(distance(x,y,BASE.x,BASE.y)<110||!accept(x,y))continue;
        if(occupied.some(p=>distance(x,y,p.x,p.y)<minGap))continue;
        takenCells.add(cellKey(c.cx,c.cy));occupied.push({x,y});make(x,y);count--;
      }
      return count===0;
    };
    // Fewer, richer nodes: each has 10× the old durability and therefore yields 10× as many drops.
    // Nodes carry RESOURCE_FOOTPRINT so grid consumers read one shared definition instead of per-kind sizes.
    return place(80,45,(x,y)=>trees.push({x,y,hp:100,max:100,stump:0,shake:0,variant:trees.length%3,footprint:RESOURCE_FOOTPRINT}))
      && place(24,49,(x,y)=>rocks.push({x,y,hp:70,max:70,depleted:0,shake:0,footprint:RESOURCE_FOOTPRINT}))
      && place(5,110,(x,y)=>diamonds.push({x,y,hp:25,max:25,depleted:0,shake:0,footprint:RESOURCE_FOOTPRINT}),
        (x,y)=>distance(x,y,BASE.x,BASE.y)>600);
  };
  // A dense tree/rock scatter can leave no far-from-base cell that still clears the diamond gap, and no
  // amount of extra dart throwing fixes that layout — so a shortfall discards the world and re-rolls.
  for(let layout=0;layout<SEED_LAYOUT_TRIES;layout++){
    trees.length=rocks.length=diamonds.length=0;
    if(attempt())return;
  }
  throw new Error(`seedWorld: could not place 80 trees / 24 rocks / 5 diamonds in ${SEED_LAYOUT_TRIES} layout attempts`);
}
seedWorld();

// ── Data flow ──
// Written by: pointer/keyboard handlers below.
// Read by: update() for collection/drop delivery and draw() for hover feedback.
// Format: state.mouse is world-space pixels after fixed-frame scaling and inverse camera transform.
// Lifetime: page load until refresh.
// Screen pixels become world pixels by raycasting the ground plane, which is the
// 3D equivalent of the old inverse camera transform and works at any pitch/yaw.
function groundFromEvent(event){
  const r=canvas.getBoundingClientRect();
  _ndc.x=((event.clientX-r.left)/r.width)*2-1;
  _ndc.y=-((event.clientY-r.top)/r.height)*2+1;
  _ray.setFromCamera(_ndc,camera3);
  if(!_ray.ray.intersectPlane(_groundPlane,_ghit))return null;
  return {x:_ghit.x/S,y:_ghit.z/S};
}
function pointerPosition(event){
  const g=groundFromEvent(event);
  if(!g){state.mouse.inside=false;return;}
  state.mouse.x=g.x;state.mouse.y=g.y;state.mouse.inside=true;
}
function clampCamera(){
  const camera=state.camera,halfW=VIEW_W/(2*camera.zoom),halfH=VIEW_H/(2*camera.zoom);
  camera.x=halfW>=W/2?W/2:clamp(camera.x,halfW,W-halfW);
  camera.y=halfH>=H/2?H/2:clamp(camera.y,halfH,H-halfH);
}
canvas.addEventListener("wheel",event=>{
  event.preventDefault();
  const camera=state.camera;
  // Zoom toward the cursor: remember the ground point, rescale, put it back.
  const before=groundFromEvent(event);
  camera.zoom=clamp(camera.zoom*Math.exp(-event.deltaY*.0015),.2,5);
  placeCamera();
  const after=groundFromEvent(event);
  if(before&&after){camera.x+=before.x-after.x;camera.y+=before.y-after.y;}
  clampCamera();placeCamera();pointerPosition(event);syncViewInputs();
},{passive:false});
canvas.addEventListener("pointermove",event=>{
  const camera=state.camera;
  if(camera.panning){
    // Drag keeps the grabbed ground point pinned under the cursor.
    const g=groundFromEvent(event);
    if(g){camera.x+=camera.dragX-g.x;camera.y+=camera.dragY-g.y;clampCamera();placeCamera();}
  }
  pointerPosition(event);
});
canvas.addEventListener("pointerleave",()=>{state.mouse.inside=false;});
canvas.addEventListener("contextmenu",event=>event.preventDefault());
canvas.addEventListener("auxclick",event=>event.preventDefault());
canvas.addEventListener("pointerdown",event=>{
  pointerPosition(event);
  if(event.button===1){event.preventDefault();const g=groundFromEvent(event);state.camera.panning=true;state.camera.dragX=g?g.x:state.camera.x;state.camera.dragY=g?g.y:state.camera.y;canvas.setPointerCapture(event.pointerId);return;}
  if(state.gameOver||state.paused||modalOpen())return;
  if(event.button===0){leftClick();if(!modalOpen())startPrimaryClick();}
  if(event.button===2){if(cancelBuildMode())return;if(pickUpMovableAt(state.mouse.x,state.mouse.y))return;state.collecting=true;collectDrop();state.collectCooldown=SUCK_RATE;}
});
// Window-level release prevents collection or camera drag getting stuck outside the canvas.
window.addEventListener("pointerup",event=>{if(event.button===0)stopPrimaryClick();if(event.button===2)releaseRightMouse();if(event.button===1)state.camera.panning=false;});
window.addEventListener("pointercancel",()=>{stopPrimaryClick();state.collecting=false;state.camera.panning=false;cancelHeldObject();});
window.addEventListener("blur",()=>{stopPrimaryClick();state.collecting=false;state.camera.panning=false;state.keys.clear();cancelHeldObject();});
window.addEventListener("keydown",event=>{
  if(event.code==="Escape"){event.preventDefault();if(!event.repeat){if(closeUpgradeMenu())return;if(cancelBuildMode())return;togglePause();}return;}
  if(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"].includes(event.code)){event.preventDefault();state.keys.add(event.code);}
});
window.addEventListener("keyup",event=>state.keys.delete(event.code));

function startPrimaryClick(){state.primaryClick.held=true;}
// Release/cancel owns only held state; the shared work cooldown survives every stop/start boundary.
function stopPrimaryClick(){state.primaryClick.held=false;resetChop();}
function stopGameplayInput(cancelPlacement=false){
  stopPrimaryClick();state.collecting=false;state.camera.panning=false;state.keys.clear();
  if(cancelPlacement){state.buildMode=null;setBuildDockCategory(null);syncBuildHud();}
}
function togglePause(){
  if(state.gameOver)return;
  state.paused=!state.paused;stopGameplayInput();
  if(state.paused)closeUpgradeMenu();
  document.getElementById("pauseBadge").classList.toggle("off",!state.paused);sound(state.paused?180:360,.06);
}
function cancelBuildMode(){
  if(!state.buildMode)return false;
  state.buildMode=null;syncBuildHud();toast("building placement cancelled");return true;
}
function spawnEnemy(side=null,enemyType=null){
  const attackSide=side||MAP_SIDES[(Math.random()*MAP_SIDES.length)|0],type=enemyType||ENEMY_POOL[(Math.random()*ENEMY_POOL.length)|0],def=ENEMY_TYPES[type];
  let x,y;
  if(attackSide===MAP_SIDE.WEST){x=8;y=rand(20,H-20);}else if(attackSide===MAP_SIDE.EAST){x=W-8;y=rand(20,H-20);}
  else if(attackSide===MAP_SIDE.NORTH){x=rand(20,W-20);y=8;}else{x=rand(20,W-20);y=H-8;}
  state.enemies.push({type,spawnSide:attackSide,x,y,hp:def.hp,max:def.hp,attackCooldown:0,healCooldown:rand(.5,2),wob:rand(0,6),flash:0,shotFlash:0,healFlash:0,status:{burn:null,slow:null},retaliationTower:null});
}
function enemyAt(x,y){
  let target=null,best=Infinity;
  for(const enemy of state.enemies){
    const d=distance(x,y,enemy.x,enemy.y),hitRadius=24*ENEMY_TYPES[enemy.type].size;
    if(d<hitRadius&&d<best){best=d;target=enemy;}
  }
  return target;
}
function killEnemy(enemy,announce=true){
  const at=state.enemies.indexOf(enemy);if(at<0)return;
  // Death owns status teardown so every damage path releases tower/source references immediately.
  enemy.status={burn:null,slow:null};enemy.retaliationTower=null;state.enemies.splice(at,1);
  const droppedDust=Math.random()<.25;
  if(droppedDust)spawnResource("dust",enemy.x+rand(-7,7),enemy.y);
  burst(enemy.x,enemy.y,"#4b3b50",12);if(announce||droppedDust)toast(droppedDust?"enemy defeated — dust dropped":"enemy defeated");sound(150,.12);
}
function hitEnemy(enemy,quiet=false){
  enemy.hp-=CLICK_DAMAGE;enemy.flash=.16;
  burst(enemy.x,enemy.y,"#d25b49",5);if(!quiet)sound(610,.045);
  if(enemy.hp<=0)killEnemy(enemy);
}
function blastButtonHit(building,x,y){return x>=building.x-30&&x<=building.x+30&&y>=building.y-34&&y<=building.y+34;}
function manualTowerButtonHit(building,x,y){return x>=building.x-30&&x<=building.x+30&&y>=building.y-42&&y<=building.y+34;}
function towerVariant(building){return TOWER_VARIANTS[building.tower?.variant||"basic"];}
function workerNodeAt(x,y){
  let found=null,best=38;
  for(const [nodes,kind] of [[trees,"wood"],[rocks,"stone"],[diamonds,"diamond"]])for(const node of nodes){const d=distance(x,y,node.x,node.y);if(resourceIsActive(node,kind)&&d<best){found={node,kind};best=d;}}
  return found;
}
function pickUpMovableAt(x,y){
  let worker=null,best=24;
  for(const candidate of state.workers){const d=distance(x,y,candidate.x,candidate.y);if(d<best){worker=candidate;best=d;}}
  if(worker){
    clearWorkerTask(worker);state.workers.splice(state.workers.indexOf(worker),1);
    state.heldObject={kind:"worker",object:worker,originX:worker.x,originY:worker.y};state.collecting=false;toast("worker lifted — release to assign");return true;
  }
  const building=buildings.find(item=>item.complete&&item.type==="tower"&&towerVariant(item).movable&&manualTowerButtonHit(item,x,y));
  if(!building)return false;
  state.heldObject={kind:"building",object:building,originX:building.x,originY:building.y};buildings.splice(buildings.indexOf(building),1);state.collecting=false;
  toast(towerVariant(building).name+" picked up — release right to place");return true;
}
function heldWorker(){return state.heldObject?.kind==="worker"?state.heldObject.object:null;}
function heldBuilding(){return state.heldObject?.kind==="building"?state.heldObject.object:null;}
function cancelHeldObject(){
  if(!state.heldObject)return;
  const held=state.heldObject,object=held.object;object.x=held.originX;object.y=held.originY;
  if(held.kind==="worker")state.workers.push(object);else buildings.push(object);state.heldObject=null;
}
// Assignment priority is resolved once so drop behavior and held-worker preview cannot drift.
function workerAssignmentAt(worker,x,y){
  if(x<20||y<20||x>W-20||y>H-20)return null;
  const near=predicate=>buildings.find(item=>predicate(item)&&distance(x,y,item.x,item.y)<42);
  const blueprint=near(item=>!item.complete),node=workerNodeAt(x,y),staff=near(item=>item.complete&&(item.type==="lumber"||item.type==="quarry")),stockpile=near(item=>item.complete&&item.type==="stockpile"),house=near(item=>item.complete&&item.type==="house");
  if(blueprint)return {job:"build",target:blueprint,postX:blueprint.x,postY:blueprint.y+20,zoneX:blueprint.x,zoneY:blueprint.y,zoneRadius:WORKER_LEASH};
  if(node)return {job:"harvest",target:node,postX:x,postY:y,zoneX:x,zoneY:y,zoneRadius:WORKER_LEASH};
  if(staff)return {job:"staff",target:staff,postX:staff.x,postY:staff.y+16,zoneX:staff.x,zoneY:staff.y,zoneRadius:BUILDING_TYPES[staff.type].serviceRadius};
  if(stockpile)return {job:"haul",target:stockpile,postX:stockpile.x,postY:stockpile.y+18,zoneX:stockpile.x,zoneY:stockpile.y,zoneRadius:storageServiceRadius(stockpile)};
  if(house)return {job:"guard",target:null,postX:house.x,postY:house.y+23,zoneX:house.x,zoneY:house.y+23,zoneRadius:WORKER_LEASH};
  if(distance(x,y,BASE.x,BASE.y)<BASE.r+18)return {job:"haul",target:BASE,postX:BASE.x,postY:BASE.y+25,zoneX:BASE.x,zoneY:BASE.y,zoneRadius:BASE_ZONE};
  return {job:"guard",target:null,postX:x,postY:y,zoneX:x,zoneY:y,zoneRadius:WORKER_LEASH};
}
function assignWorker(worker,x,y){
  const assignment=workerAssignmentAt(worker,x,y);if(!assignment)return null;
  clearWorkerTask(worker);worker.x=x;worker.y=y;worker.postX=assignment.postX;worker.postY=assignment.postY;worker.job=assignment.job;worker.jobTarget=assignment.target;worker.retaliationTarget=null;worker.returnAfterCombat=false;worker.returning=false;worker.starved=false;
  if(worker.job!=="haul")for(const kind of RESOURCE_KINDS){while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,x+rand(-8,8),y+rand(-5,5));}}
  return worker.job;
}
function dropHeldObject(){
  const held=state.heldObject;if(!held)return false;
  if(held.kind==="worker"){
    const worker=held.object,result=state.mouse.inside&&assignWorker(worker,state.mouse.x,state.mouse.y);
    if(result){state.workers.push(worker);const assignment=worker.job==="haul"?"haul to "+(worker.jobTarget===BASE?"base":"stockpile"):result;toast("worker assigned: "+assignment);}
    else{worker.x=held.originX;worker.y=held.originY;state.workers.push(worker);toast("invalid ground — worker returned");}
    state.heldObject=null;sound(260,.06);return true;
  }
  // Relocation validates the tower's own 3x3 footprint at the snapped anchor, excluding itself.
  // Only x/y are ever touched: cooldown, hp, variant and upgrade state ride along on the same object,
  // and an invalid drop restores the exact origin recorded at pickup.
  const building=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
  if(anchor&&canPlace(anchor.x,anchor.y,building.type,building)){building.x=anchor.x;building.y=anchor.y;toast(towerVariant(building).name+" placed");}
  else{building.x=held.originX;building.y=held.originY;toast("invalid ground — tower returned");}
  buildings.push(building);state.heldObject=null;sound(260,.06);return true;
}
function activateManualTower(building){
  const tower=building.tower,variant=towerVariant(building);if(!variant.manual)return;
  if(tower.cooldown>0){toast(variant.name+" recharging: "+tower.cooldown.toFixed(1)+"s");return;}
  tower.cooldown=variant.cooldown;tower.flash=.35;
  for(const enemy of [...state.enemies]){
    if(distance(building.x,building.y,enemy.x,enemy.y)>variant.effectRadius)continue;
    damageEnemy(enemy,variant.damage,variant.accent,7,building);
  }
  burst(building.x,building.y,variant.accent,24);toast("shock pulse fired");sound(variant.sound,.28);
}
function detonateBlast(building){
  for(const enemy of [...state.enemies]){
    const d=distance(building.x,building.y,enemy.x,enemy.y),radius=BUILDING_TYPES.blast.effectRadius;if(d>radius)continue;
    enemy.hp-=d<radius*.5?5:3;enemy.flash=.2;
    if(enemy.hp<=0)killEnemy(enemy,false);
  }
  for(let i=0;i<42;i++)particles.push({x:building.x,y:building.y,vx:rand(-180,180),vy:rand(-190,40),life:rand(.35,.9),col:i%2?"#e39a3f":"#b84b38"});
  buildings.splice(buildings.indexOf(building),1);toast("blast charge detonated");sound(70,.3);
}
function createBuilding(type,x,y){
  const def=BUILDING_TYPES[type],cost=type==="house"?nextHouseCost():{...def.cost};
  return {type,x,y,cost,delivered:{wood:0,stone:0},storage:{wood:0,stone:0,dust:0,coin:0,diamond:0},upgrades:{},activeUpgrade:null,tower:null,hazard:["spikes","landmine","tar"].includes(type)?{cooldown:0,flash:0}:null,complete:!!def.instant,pulse:1};
}

function playerResourceAt(x,y){
  let target=null,kind=null,best=34;
  for(const tree of trees){if(tree.stump>0)continue;const d=distance(x,y,tree.x,tree.y-10);if(d<best){best=d;target=tree;kind="wood";}}
  for(const rock of rocks){if(rock.depleted>0)continue;const d=distance(x,y,rock.x,rock.y);if(d<best){best=d;target=rock;kind="stone";}}
  for(const diamond of diamonds){if(diamond.depleted>0)continue;const d=distance(x,y,diamond.x,diamond.y);if(d<best){best=d;target=diamond;kind="diamond";}}
  return target?{target,kind}:null;
}

// ── primary-action resolver ──────────────────────────────────────────────────
// Presentation identity per resolved thing: what the swing IS and what tool draws it.
// Resource keys match hitResource()'s kind argument, so the resolver can carry both
// the simulation kind and the display kind without a second lookup table.
const PRIMARY_ACTIONS={
  wood:   {kind:"chop",   icon:"axe"},
  stone:  {kind:"mine",   icon:"pickaxe"},
  diamond:{kind:"mine",   icon:"pickaxe"},
  enemy:  {kind:"attack", icon:"sword"}
};
/**
 * THE authority for direct timed left-click work at a world point.
 *
 * Data flow: everything that needs to know "what would a held left click do here?"
 * reads this one answer — leftClick() (press arms the bar), updatePrimaryClick()
 * (hold fills and resolves it), and chopTarget() (hover preview ring, and any
 * later cursor/HUD tool icon). Because all three consume the same resolution,
 * the highlighted target and the target that actually takes damage can never
 * disagree, and a future icon preview needs no parallel selection logic.
 *
 * Pure: reads the world lists, mutates nothing, returns a fresh descriptor.
 * Priority is enemies before resources — a foe standing on a tree gets swung at.
 * Felled trees, depleted rocks/diamonds and dead-or-removed enemies never resolve.
 *
 * @returns {null|{target:object,kind:"chop"|"mine"|"attack",resource:null|"wood"|"stone"|"diamond",icon:"axe"|"pickaxe"|"sword"}}
 */
function resolvePrimaryAction(x,y){
  const enemy=enemyAt(x,y);
  // enemyAt() only walks the live roster; the hp guard also rejects a corpse
  // still referenced mid-frame before killEnemy() splices it out.
  if(enemy&&enemy.hp>0&&state.enemies.includes(enemy))
    return {target:enemy,kind:PRIMARY_ACTIONS.enemy.kind,resource:null,icon:PRIMARY_ACTIONS.enemy.icon};
  const node=playerResourceAt(x,y);   // already skips stumps and depleted nodes
  if(!node)return null;
  const action=PRIMARY_ACTIONS[node.kind];
  return {target:node.target,kind:action.kind,resource:node.kind,icon:action.icon};
}

// Harvesting and attacking both run through updatePrimaryClick()'s hold timer.
// Simulation time advances one cooldown and, while held, retries current cursor work without buffering missed actions.
function updatePrimaryClick(dt){
  const primary=state.primaryClick;
  primary.audioCooldown=Math.max(0,primary.audioCooldown-dt);
  if(!primary.held){resetChop();return;}
  if(modalOpen()||state.paused||state.gameOver){resetChop();stopPrimaryClick();return;}
  const m=state.mouse;
  if(!m.inside){resetChop();return;}
  // Nodes and enemies share one hold-to-fill timer; moving off resets it.
  // Re-resolved every tick through the one authority, so a target that dies,
  // depletes, or is swapped under the cursor drops or restarts the fill here.
  const hit=resolvePrimaryAction(m.x,m.y);
  if(!hit){resetChop();return;}
  beginChop(hit);
  chopState.t+=dt*(globalUpgradeEnabled("autoClick")?STEADY_HAND_RATE:1);
  if(chopState.t<CHOP_TIME)return;
  chopState.t=0;
  const quiet=primary.audioCooldown>0;
  if(hit.kind==="attack")hitEnemy(hit.target,quiet);
  else hitResource(hit.target,hit.resource,false,quiet);
  if(!quiet)primary.audioCooldown=.25;
}
function leftClick(){
  if(state.gameOver||state.paused)return;
  const m=state.mouse;
  // Same resolver the hover ring and the hold timer read, so the press arms
  // exactly what was previewed. Resolved once up front; it is pure, and every
  // branch between here and the harvest fall-through returns before using it.
  const action=resolvePrimaryAction(m.x,m.y);
  // Attacking is timed too — the press only arms the bar.
  if(action&&action.kind==="attack"){beginChop(action);return;}
  if(state.buildMode){
    // Commit uses the same snap the ghost preview drew with, so what you see is what lands.
    const type=state.buildMode,anchor=snapToCellCenter(m.x,m.y);
    if(canPlace(anchor.x,anchor.y,type)){
      const def=BUILDING_TYPES[type],placed=createBuilding(type,anchor.x,anchor.y);
      buildings.push(placed);
      // free costs (debug): the blueprint is created exactly as authored (its own cost
      // snapshot intact) and then finished through completeBuilding() — the same call a
      // satisfied delivery makes. Nothing is deducted from state.stored, and because the
      // completion is unconditional a free-cost placement can never leave a stuck blueprint.
      const freed=DBG.freeCosts&&!placed.complete;
      if(freed)completeBuilding(placed);
      // unlimited charges (debug): the stack counter is simply never decremented, so the
      // authored starting counts and the "n left" HUD stay honest the moment it is off.
      if(def.stack){if(!DBG.unlimitedCharges)state.buildStacks[type]--;state.buildMode=DBG.unlimitedCharges||state.buildStacks[type]>0?type:null;}else state.buildMode=null;
      setBuildDockCategory(null);syncBuildHud();
      sound(240,.06);
      // completeBuilding() already announced a freed blueprint's own ready message.
      if(!freed)toast(def.stack?def.name+" placed — "+(DBG.unlimitedCharges?"unlimited":state.buildStacks[type]+" stacks remain"):def.instant?def.name+" placed — hover it to detonate":"blueprint placed — carry its resources to it");
    }else toast("needs clear ground away from the base");
    return;
  }
  const blast=buildings.find(building=>building.complete&&building.type==="blast"&&blastButtonHit(building,m.x,m.y));
  if(blast){detonateBlast(blast);return;}
  const manualTower=buildings.find(building=>building.complete&&building.type==="tower"&&towerVariant(building).manual&&manualTowerButtonHit(building,m.x,m.y));
  if(manualTower){activateManualTower(manualTower);return;}
  const obelisk=buildings.find(building=>building.complete&&building.type==="obelisk"&&upgradeButtonHit(building,m.x,m.y));
  if(obelisk){openUpgradeMenu(obelisk,"obelisk");return;}
  const tower=buildings.find(building=>building.complete&&building.type==="tower"&&building.tower.variant==="basic"&&!building.activeUpgrade&&upgradeButtonHit(building,m.x,m.y));
  if(tower){openUpgradeMenu(tower,"tower");return;}
  const pile=buildings.find(building=>building.complete&&building.type==="stockpile"&&distance(m.x,m.y,building.x,building.y)<38);
  if(pile){unloadStockpile(pile,m.x);return;}
  if(!action){toast("left click a tree, rock, or diamond deposit");return;}
  // Harvesting no longer resolves on the press; updatePrimaryClick() fills the timer.
  beginChop(action);
}

// Player and harvesting workers share this path: harvesting automation creates physical drops, never stored resources.
function hitResource(target,kind,automatic,quiet=false){
  target.hp--;
  target.shake=1;
  for(let i=0;i<(automatic?1:CHOP_YIELD);i++)
    spawnResource(kind,target.x+rand(-12,12),target.y+rand(-6,7));
  burst(target.x,target.y-12,kind==="wood"?"#9fb351":kind==="diamond"?"#78d7e5":"#bbb7ae",5);
  if(!automatic&&!quiet)sound(kind==="wood"?350+target.hp*25:kind==="diamond"?760:170+target.hp*15,.045);
  if(target.hp<=0&&kind==="wood"){
    target.stump=1;
    burst(target.x,target.y-10,"#557036",13);
    if(!automatic)toast("tree felled");
  }else if(target.hp<=0){
    target.depleted=1;
    burst(target.x,target.y,kind==="diamond"?"#78d7e5":"#8b8985",11);
    if(!automatic)toast(kind==="diamond"?"diamond deposit exhausted":"rock cleared");
  }
}

function spawnResource(kind,x,y,ttl=null){
  resourceDrops.push({kind,x,y,groundY:clamp(y+rand(10,22),35,H-20),vx:rand(-35,35),vy:rand(-75,-35),ground:false,target:null,t:0,spin:rand(0,6),ttl});
}
function spawnCoin(){
  for(let attempt=0;attempt<300;attempt++){
    const x=rand(40,W-40),y=rand(40,H-40);
    if(distance(x,y,BASE.x,BASE.y)<80)continue;
    spawnResource("coin",x,y,8);toast("a gold coin appeared nearby");return;
  }
}

function collectDrop(silent=false){
  // Reserve capacity for drops already flying to the cursor, preventing rapid collection from overfilling hands.
  const incoming=resourceDrops.reduce((count,drop)=>count+(drop.target==="hand"),0);
  const carried=carriedTotal();
  if(carried+incoming>=state.capacity){if(!silent){toast("hands full — drop your resources");sound(110,.08);}return false;}
  const m=state.mouse;
  let nearest=null,best=VACUUM_RADIUS;
  for(const drop of resourceDrops){
    if(drop.target)continue;
    const d=distance(m.x,m.y,drop.x,drop.y);
    if(d<best){best=d;nearest=drop;}
  }
  if(!nearest){if(!silent)toast("hold right click and drag over loose resources");return false;}
  if(nearest.claimedBy){const worker=nearest.claimedBy;clearWorkerTask(worker);worker.returning=workerLoad(worker)>0;}
  nearest.target="hand";nearest.t=0;
  sound(650,.035);
  return true;
}

function hoverTarget(){
  const m=state.mouse;
  if(!m.inside)return null;
  if(distance(m.x,m.y,BASE.x,BASE.y)<BASE.r+16)return {kind:"base",object:BASE};
  for(const building of buildings){
    if(!building.complete&&distance(m.x,m.y,building.x,building.y)<38)return {kind:"building",object:building};
    if(building.complete&&building.type==="stockpile"&&distance(m.x,m.y,building.x,building.y)<42)return {kind:"stockpile",object:building};
    if(building.complete&&(building.type==="obelisk"||building.type==="tower")&&building.activeUpgrade&&upgradeButtonHit(building,m.x,m.y))return {kind:"upgrade",object:building};
  }
  return null;
}

function releaseRightMouse(){
  state.collecting=false;
  if(state.gameOver||state.paused)return;
  if(dropHeldObject())return;
  // A quick press may release before pickup animations finish; commit those reserved drops first.
  for(let i=resourceDrops.length-1;i>=0;i--){
    const resource=resourceDrops[i];
    if(resource.target!=="hand")continue;
    state.carried[resource.kind]++;resourceDrops.splice(i,1);
  }
  if(carriedTotal()<=0)return;
  const target=hoverTarget();
  if(target&&target.kind==="base")dropToBase();
  else if(target&&target.kind==="stockpile")dropToStockpile(target.object);
  else if(target&&target.kind==="upgrade"){
    dropToUpgrade(target.object);
    if(carriedTotal())dropCarriedOnGround(true);
  }else if(target&&target.kind==="building"){
    dropToBuilding(target.object);
    if(carriedTotal())dropCarriedOnGround(true);
  }else dropCarriedOnGround();
}

function dropCarriedOnGround(silent=false){
  for(const kind of RESOURCE_KINDS){const amount=state.carried[kind];state.carried[kind]=0;for(let i=0;i<amount;i++)spawnResource(kind,state.mouse.x+rand(-10,10),state.mouse.y+rand(-7,7));}
  if(!silent){toast("resources dropped");sound(310,.06);}
}

function dropToStockpile(building){
  let total=0;
  for(const kind of RESOURCE_KINDS){const amount=state.carried[kind];building.storage[kind]+=amount;state.carried[kind]=0;total+=amount;handoffParticles(building.x,building.y,kind,amount);}
  building.pulse=1;toast("stockpiled "+total+" resources");sound(470,.07);
}
function unloadStockpile(building,mouseX){
  const slots=["wood","coin","dust","diamond","stone"],slot=clamp(Math.floor((mouseX-building.x+35)/14),0,4),preferred=slots[slot];
  const kind=building.storage[preferred]>0?preferred:slots.find(item=>building.storage[item]>0)||null;
  if(!kind){toast("stockpile is empty");return;}
  building.storage[kind]--;
  spawnResource(kind,building.x+rand(-18,18),building.y+28);
  building.pulse=1;toast("pulled 1 "+kind+" from stockpile");sound(kind==="wood"?390:180,.05);
}
function towerUpgradeList(){return Object.entries(TOWER_VARIANTS).filter(([id])=>id!=="basic").map(([id,variant])=>({id,...variant}));}
function upgradeList(kind){return kind==="tower"?towerUpgradeList():UPGRADES;}
function resourceCounts(){return Object.fromEntries(RESOURCE_KINDS.map(kind=>[kind,0]));}
function costText(cost){return RESOURCE_KINDS.filter(kind=>(cost[kind]||0)>0).map(kind=>cost[kind]+" "+kind).join(" + ")||"free";}
function upgradeNeedText(upgrade,delivered){return RESOURCE_KINDS.filter(kind=>(upgrade.cost[kind]||0)>delivered[kind]).map(kind=>(upgrade.cost[kind]-delivered[kind])+" "+kind).join(" + ");}
// THE one place an accepted upgrade job turns into a permanent effect. Extracted so the
// satisfied branch of dropToUpgrade() and the free-costs debug shortcut are literally the
// same code — a debug completion cannot drift from a legitimate one. Reads the authored
// cost/stat tables, writes only this building.
function applyFinishedUpgrade(building){
  const job=building.activeUpgrade;if(!job)return false;
  const upgrade=upgradeList(job.kind).find(item=>item.id===job.id);if(!upgrade)return false;
  if(job.kind==="tower"){const tower=building.tower,healthRatio=tower.maxHp?clamp(tower.hp/tower.maxHp,0,1):1;tower.variant=job.id;tower.maxHp=upgrade.maxHp;tower.hp=upgrade.maxHp*healthRatio;}
  else building.upgrades[job.id]=true;
  building.activeUpgrade=null;burst(building.x,building.y-25,"#72d4cc",22);toast(upgrade.name+" complete");sound(820,.2);
  return true;
}
function dropToUpgrade(building){
  const job=building.activeUpgrade,upgrade=upgradeList(job.kind).find(item=>item.id===job.id),kinds=job.kind==="tower"?RESOURCE_KINDS:["wood","stone"];
  let total=0;
  for(const kind of kinds){
    const amount=Math.min((upgrade.cost[kind]||0)-job.delivered[kind],state.carried[kind]);
    state.carried[kind]-=amount;job.delivered[kind]+=amount;total+=amount;
    handoffParticles(building.x,building.y,kind,amount);
  }
  if(!total){toast("upgrade does not need those resources");return;}
  building.pulse=1;
  if(kinds.every(kind=>job.delivered[kind]>=(upgrade.cost[kind]||0)))applyFinishedUpgrade(building);
  else toast("upgrade needs "+upgradeNeedText(upgrade,job.delivered));
}

function upgradeButtonHit(building,x,y){const top=building.type==="obelisk"?building.y-66:building.y-48;return x>=building.x-30&&x<=building.x+30&&y>=top&&y<=building.y+38;}
function upgradePanelOpen(){return !document.getElementById("upgradePanel").classList.contains("off");}
// The upgrade panel is the only modal left; the old debug modal is gone, and the view
// debugger is a non-modal side panel that deliberately does NOT suppress gameplay input.
function modalOpen(){return upgradePanelOpen();}
function syncModalUi(){document.getElementById("game").classList.toggle("modal-open",modalOpen());}
function closeUpgradeMenu(){const wasOpen=upgradePanelOpen();state.upgradeMenu.building=null;state.upgradeMenu.selected=null;state.upgradeMenu.kind=null;document.getElementById("upgradePanel").classList.add("off");syncModalUi();return wasOpen;}
function openUpgradeMenu(building,kind){
  if(building.activeUpgrade){toast("finish the active upgrade by depositing resources");return;}
  if(kind==="tower"&&building.tower.variant!=="basic"){toast("this tower already has a permanent variant");return;}
  stopGameplayInput();const list=upgradeList(kind);
  state.upgradeMenu.building=building;state.upgradeMenu.kind=kind;state.upgradeMenu.selected=list.find(item=>!building.upgrades[item.id])?.id||null;
  renderUpgradeMenu();document.getElementById("upgradePanel").classList.remove("off");syncModalUi();
}
function renderUpgradeMenu(){
  const menu=state.upgradeMenu,building=menu.building,list=upgradeList(menu.kind),options=document.getElementById("upgradeOptions"),detail=document.getElementById("upgradeDetail"),towerMenu=menu.kind==="tower";
  document.getElementById("upgradeTitle").textContent=towerMenu?"choose one permanent tower variant":menu.kind+" upgrades";options.replaceChildren();
  if(towerMenu)for(const variant of list){
    const button=document.createElement("button");button.className="variant-card";button.classList.toggle("on",menu.selected===variant.id);button.title=variant.family+" · "+variant.attackMode+" · "+variant.description;button.innerHTML="<b>"+variant.icon+"</b>"+variant.name;button.addEventListener("click",()=>{menu.selected=variant.id;renderUpgradeMenu();});options.appendChild(button);
  }else for(const upgrade of list){
    const button=document.createElement("button");button.classList.toggle("on",menu.selected===upgrade.id);button.classList.toggle("owned",!!building.upgrades[upgrade.id]);button.innerHTML="<b>"+upgrade.icon+"</b>"+upgrade.name+(building.upgrades[upgrade.id]?" · done":"");button.addEventListener("click",()=>{if(building.upgrades[upgrade.id])return;menu.selected=upgrade.id;renderUpgradeMenu();});options.appendChild(button);
  }
  const selected=list.find(item=>item.id===menu.selected);detail.innerHTML=selected?"<b>"+(towerMenu?selected.icon+" ":"")+selected.name+"</b>"+(towerMenu?"<div class=\"detail-meta\">"+selected.family+" · "+selected.attackMode+"</div>":"")+selected.description+"<br>cost: "+costText(selected.cost):"all upgrades complete";
}
document.getElementById("upgradeDecline").addEventListener("click",closeUpgradeMenu);
document.getElementById("upgradeAccept").addEventListener("click",()=>{
  const menu=state.upgradeMenu,building=menu.building,upgrade=upgradeList(menu.kind).find(item=>item.id===menu.selected);
  if(!building||!upgrade)return;
  building.activeUpgrade={id:upgrade.id,kind:menu.kind,delivered:resourceCounts()};
  const destination=menu.kind;closeUpgradeMenu();
  // free costs (debug): the job is accepted normally, then satisfied through the same
  // applyFinishedUpgrade() a full delivery reaches. Nothing is deducted or granted.
  if(DBG.freeCosts&&applyFinishedUpgrade(building))return;
  toast("accepted "+upgrade.name+" — deposit resources at the "+destination);sound(590,.1);
});

function dropToBase(){
  let total=0;
  for(const kind of RESOURCE_KINDS){const amount=state.carried[kind];state.stored[kind]+=amount;state.carried[kind]=0;total+=amount;handoffParticles(BASE.x,BASE.y,kind,amount);}
  state.basePulse=1;toast("stored "+total+" resources at base");sound(520,.08);
}

function buildingCost(building){return building.cost||BUILDING_TYPES[building.type].cost;}
function completeBuilding(building){
  if(building.complete)return;
  const def=BUILDING_TYPES[building.type];building.complete=true;building.starved=false;
  if(def.resource)state.capacity+=2;
  if(building.type==="tower"){const variant=TOWER_VARIANTS.basic;building.tower={variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:variant.maxHp,maxHp:variant.maxHp};}
  if(building.type==="house")building.spawnTimer=WORKER_SPAWN_TIME;
  burst(building.x,building.y-12,"#ead28d",18);
  const readyMessage=building.type==="stockpile"?"stockpile complete — release resources over it":building.type==="house"?"house complete — worker production started":building.type==="obelisk"?"obelisk complete — hover it to choose upgrades":building.type==="tower"?"basic tower complete — hover it to choose one variant":def.name+" complete";
  toast(def.resource?def.name+" complete — drop a worker on it to staff it":readyMessage);sound(760,.18);syncBuildHud();
}
function dropToBuilding(building){
  const cost=buildingCost(building);let total=0;
  for(const kind of ["wood","stone"]){
    const amount=Math.min(cost[kind]-building.delivered[kind],state.carried[kind]);
    state.carried[kind]-=amount;building.delivered[kind]+=amount;total+=amount;handoffParticles(building.x,building.y,kind,amount);
  }
  if(!total){toast("this blueprint already has that resource");return;}
  building.pulse=1;sound(480,.08);
  if(building.delivered.wood>=cost.wood&&building.delivered.stone>=cost.stone)completeBuilding(building);
  else toast("needs "+(cost.wood-building.delivered.wood)+" wood + "+(cost.stone-building.delivered.stone)+" stone");
}

function handoffParticles(x,y,kind,count,fromX=state.mouse.x,fromY=state.mouse.y){
  const col=kind==="wood"?"#b67b43":kind==="stone"?"#aaa9a5":kind==="coin"?"#e3b445":kind==="diamond"?"#79d9e8":"#a783df";
  for(let i=0;i<Math.min(count,10);i++)particles.push({x:fromX+rand(-9,9),y:fromY+rand(-9,9),tx:x,ty:y,life:.45+i*.035,max:.45+i*.035,col,kind,resource:true});
}

// ── Placement validity ──
// Occupancy is RECOMPUTED from the live trees/rocks/diamonds/buildings arrays on every call; it is
// never cached. Harvesting, construction, detonation and tower pickup all mutate those arrays
// directly, so a cached grid would need invalidation hooks in a dozen unrelated places to buy
// nothing measurable at this world size (~210 nodes x at most 9 candidate cells).
// BUILD_MARGIN (the map inset every placement must clear) is authored data and lives in data.js.
// Axis-aligned cell-rectangle overlap. Footprints are rectangles, so testing their cell BOUNDS is
// exactly equivalent to testing every cell of one against every cell of the other, minus the loops.
function cellBoundsOverlap(a,b){return a.minX<=b.maxX&&b.minX<=a.maxX&&a.minY<=b.maxY&&b.minY<=a.maxY;}
// Cell bounds of anything already on the map: world anchor -> its cell -> its footprint's bounds.
// Resource nodes carry `footprint` themselves; buildings resolve theirs from their type.
function occupiedCellBounds(entity,footprint=entity.footprint||FOOTPRINT_1x1){
  const c=worldToCell(entity.x,entity.y);
  return footprintCellBounds(c.cx,c.cy,footprint);
}
// `type` is the CANDIDATE building type and is always explicit — canPlace() no longer reads
// state.buildMode, so held-tower relocation and blueprint previews can't disagree about footprints.
// `ignoreBuilding` drops one existing instance from the occupancy scan: a relocating Shock Tower must
// not collide with itself. (Pickup already splices it out of `buildings`; passing it keeps the rule
// true regardless of that ordering.)
function canPlace(x,y,type=null,ignoreBuilding=null){
  const footprint=buildingFootprint(type),c=worldToCell(x,y);
  // Whole footprint, not just the anchor: a 3x3 one cell from the border overhangs the map.
  if(!footprintInWorldBounds(c.cx,c.cy,footprint))return false;
  const rect=footprintWorldRect(c.cx,c.cy,footprint);
  if(rect.x<BUILD_MARGIN||rect.y<BUILD_MARGIN||rect.x+rect.w>W-BUILD_MARGIN||rect.y+rect.h>H-BUILD_MARGIN)return false;
  const bounds=footprintCellBounds(c.cx,c.cy,footprint);
  // The base is just another occupant: its 3x3 blocks, the cells beside it do not.
  if(cellBoundsOverlap(bounds,occupiedCellBounds(BASE)))return false;
  // Depleted nodes no longer reserve ground, letting harvesting open construction sites.
  for(const [nodes,kind] of [[trees,"wood"],[rocks,"stone"],[diamonds,"diamond"]])
    for(const node of nodes)
      if(resourceIsActive(node,kind)&&cellBoundsOverlap(bounds,occupiedCellBounds(node)))return false;
  // Cell occupancy replaces the old distance rings, so 1x1 deployables (spikes/mines/tar included)
  // may sit in touching cells but never share one.
  for(const b of buildings)
    if(b!==ignoreBuilding&&cellBoundsOverlap(bounds,occupiedCellBounds(b,buildingFootprint(b.type))))return false;
  return true;
}

function setBuildDockCategory(category){
  state.buildDockCategory=category;
  document.getElementById("buildCards").classList.toggle("open",!!category);
  document.querySelectorAll(".build-category").forEach(panel=>panel.classList.toggle("open",panel.dataset.category===category));
  document.querySelectorAll(".dock-tab").forEach(tab=>{const active=tab.dataset.category===category;tab.classList.toggle("on",active);tab.setAttribute("aria-expanded",active);});
}
document.querySelectorAll(".dock-tab").forEach(tab=>tab.addEventListener("click",()=>setBuildDockCategory(state.buildDockCategory===tab.dataset.category?null:tab.dataset.category)));
// Toasts occupy the notification lane immediately above the dock in both collapsed and expanded states.
const buildDock=document.getElementById("buildDock"),stage=document.getElementById("stage");
new ResizeObserver(()=>stage.style.setProperty("--build-dock-clearance",buildDock.offsetHeight+"px")).observe(buildDock);
document.querySelectorAll("button.build").forEach(button=>button.addEventListener("click",()=>{
  if(state.gameOver||state.paused)return;
  const kind=button.dataset.kind;
  if(BUILDING_TYPES[kind].stack&&!DBG.unlimitedCharges&&state.buildStacks[kind]<=0){toast("no "+BUILDING_TYPES[kind].name+" stacks remaining");return;}
  state.buildMode=state.buildMode===kind?null:kind;
  syncBuildHud();
  toast(state.buildMode?"click explored, clear ground to place the blueprint":"build cancelled");
}));
function completeHouses(){return buildings.filter(building=>building.complete&&building.type==="house");}
function nextHouseCost(){const count=completeHouses().length;return {wood:HOUSE_COST.wood+HOUSE_COST_ESCALATION.wood*count,stone:HOUSE_COST.stone+HOUSE_COST_ESCALATION.stone*count};}
function sourceWorkerCount(source){const held=heldWorker();return state.workers.filter(worker=>worker.spawnSource===source).length+(held?.spawnSource===source?1:0);}
function createHouseWorker(house){
  if(!house.complete||house.type!=="house")return null;
  const postX=house.x,postY=house.y+23;
  return {x:postX+rand(-8,8),y:postY,postX,postY,spawnSource:house,job:"guard",jobTarget:null,taskTarget:null,returning:false,starved:false,carried:{wood:0,stone:0,dust:0,coin:0,diamond:0},hp:WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false};
}
function spawnHouseWorker(house){
  const worker=createHouseWorker(house);if(!worker)return;
  state.workers.push(worker);burst(worker.postX,worker.postY,"#ead28d",9);sound(720,.12);
}
function updateWorkerSpawns(dt){
  for(const house of completeHouses()){
    if(sourceWorkerCount(house)>=HOUSE_SLOTS){house.spawnTimer=WORKER_SPAWN_TIME;continue;}
    // instant workers (debug) skips only the timer; the slot check above still gates it.
    house.spawnTimer-=dt;if(DBG.instantWorkers||house.spawnTimer<=0){spawnHouseWorker(house);house.spawnTimer=WORKER_SPAWN_TIME;}
  }
}

function resourceIsActive(node,kind){return kind==="wood"?node.stump<=0:node.depleted<=0;}
function workerLoad(worker){return RESOURCE_KINDS.reduce((total,kind)=>total+worker.carried[kind],0);}
function clearWorkerTask(worker){if(worker.taskTarget?.claimedBy===worker)delete worker.taskTarget.claimedBy;worker.taskTarget=null;}
function targetIsClaimed(target){
  const owner=target.claimedBy;if(owner&&(!state.workers.includes(owner)||owner.taskTarget!==target)){delete target.claimedBy;return false;}return !!owner;
}
function nearestWorkerNode(worker,kind,centerX=worker.postX,centerY=worker.postY,radius=WORKER_LEASH){
  const nodes=kind==="wood"?trees:kind==="stone"?rocks:diamonds;let choice=null,best=Infinity;
  for(const node of nodes){const scopeDistance=distance(centerX,centerY,node.x,node.y),d=distance(worker.x,worker.y,node.x,node.y);if(resourceIsActive(node,kind)&&scopeDistance<=radius&&d<best){choice=node;best=d;}}
  return choice;
}
function moveWorker(worker,x,y,dt,stop=12){
  // Report arrival on the crossing frame; waiting for exact float equality can strand loaded workers at drop-off range.
  const d=distance(worker.x,worker.y,x,y);if(d<=stop+.01)return true;
  const remaining=d-stop,amount=Math.min(remaining,WORKER_SPEED*dt),angle=Math.atan2(y-worker.y,x-worker.x);worker.x+=Math.cos(angle)*amount;worker.y+=Math.sin(angle)*amount;return amount>=remaining-.01;
}
function workerCoatColor(worker){return worker.job==="haul"?"#4d7892":worker.job==="build"?"#d29a39":worker.job==="guard"?"#856347":"#d4b079";}
function killWorker(worker){
  const at=state.workers.indexOf(worker);if(at<0)return false;
  clearWorkerTask(worker);worker.combatTarget=null;worker.retaliationTarget=null;worker.returnAfterCombat=false;
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,worker.x+rand(-7,7),worker.y+rand(-5,5));}
  state.workers.splice(at,1);
  // Snapshot only rendering data: the source slot is free as soon as the mutable worker leaves state.workers.
  workerCorpses.push(Object.freeze({x:worker.x,y:worker.y,coat:workerCoatColor(worker),flip:Math.random()<.5?-1:1,pose:rand(-2,2)}));
  burst(worker.x,worker.y,"#9d493d",9);return true;
}
function workerAttack(worker,enemy){
  worker.combatTarget=enemy;if(worker.attackCooldown>0)return;
  worker.attackCooldown=WORKER_ATTACK_RATE;enemy.hp-=WORKER_DAMAGE;enemy.flash=.18;burst(enemy.x,enemy.y,"#f0cc72",6);sound(310,.05);if(enemy.hp<=0){killEnemy(enemy,false);worker.returnAfterCombat=true;}
}
function depositWorkerLoad(worker){
  // Hauling moves already-physical drops; harvesting itself can only call hitResource() and never reaches storage.
  const storage=worker.jobTarget;
  for(const kind of RESOURCE_KINDS){const amount=worker.carried[kind];if(!amount)continue;if(storage===BASE)state.stored[kind]+=amount;else storage.storage[kind]+=amount;worker.carried[kind]=0;}
  if(storage===BASE)state.basePulse=1;else storage.pulse=1;
  worker.returning=false;burst(worker.postX,worker.postY,"#e5ce91",5);
}
function storageServiceRadius(storage){return storage===BASE?BASE_ZONE:BUILDING_TYPES[storage.type].serviceRadius;}
function storageStock(storage){return storage===BASE?state.stored:storage.storage;}
function nearestBuildStorage(building,worker){
  let choice=null,best=Infinity,covered=false;
  for(const storage of [BASE,...buildings.filter(item=>item.complete&&item.type==="stockpile")]){const d=distance(storage.x,storage.y,building.x,building.y);if(d>storageServiceRadius(storage))continue;covered=true;const stock=storageStock(storage),available=["wood","stone"].some(kind=>stock[kind]>0&&buildNeed(building,kind,worker)>0);if(available&&d<best){choice=storage;best=d;}}
  return {storage:choice,covered};
}
function buildNeed(building,kind,worker){
  let reserved=0;for(const other of state.workers)if(other!==worker&&other.job==="build"&&other.jobTarget===building)reserved+=other.carried[kind]+(other.taskTarget?.kind===kind?1:0);
  return Math.max(0,buildingCost(building)[kind]-building.delivered[kind]-reserved);
}
function inheritBuiltJob(worker,building){
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,building.x+rand(-8,8),building.y+rand(-5,5));}
  clearWorkerTask(worker);worker.returning=false;worker.starved=false;
  if(building.type==="lumber"||building.type==="quarry"){worker.job="staff";worker.jobTarget=building;worker.postX=building.x;worker.postY=building.y+16;}
  else if(building.type==="stockpile"){worker.job="haul";worker.jobTarget=building;worker.postX=building.x;worker.postY=building.y+18;}
  else{worker.job="guard";worker.jobTarget=null;worker.postX=building.x;worker.postY=building.y+(building.type==="house"?23:18);}
}
function updateBuilder(worker,dt){
  const building=worker.jobTarget;
  if(!building||!buildings.includes(building)){clearWorkerTask(worker);worker.job="guard";worker.jobTarget=null;worker.starved=false;return;}
  if(building.complete){inheritBuiltJob(worker,building);return;}
  if(workerLoad(worker)>0){
    worker.starved=false;if(!moveWorker(worker,building.x,building.y,dt,16))return;
    const cost=buildingCost(building);for(const kind of ["wood","stone"]){const amount=Math.min(worker.carried[kind],cost[kind]-building.delivered[kind]);worker.carried[kind]-=amount;building.delivered[kind]+=amount;handoffParticles(building.x,building.y,kind,amount,worker.x,worker.y);}
    building.pulse=1;if(building.delivered.wood>=cost.wood&&building.delivered.stone>=cost.stone){completeBuilding(building);inheritBuiltJob(worker,building);}return;
  }
  if(worker.taskTarget&&(!resourceDrops.includes(worker.taskTarget)||worker.taskTarget.target||worker.taskTarget.claimedBy!==worker))clearWorkerTask(worker);
  if(worker.taskTarget){
    worker.starved=false;const resource=worker.taskTarget;if(moveWorker(worker,resource.x,resource.y,dt,10)){const at=resourceDrops.indexOf(resource);if(at>=0){worker.carried[resource.kind]++;resourceDrops.splice(at,1);}delete resource.claimedBy;worker.taskTarget=null;}return;
  }
  const source=nearestBuildStorage(building,worker),storage=source.storage;
  if(!source.covered){worker.starved=true;moveWorker(worker,worker.postX,worker.postY,dt);return;}
  if(storage){
    worker.starved=false;if(!moveWorker(worker,storage.x,storage.y,dt,storage===BASE?BASE.r-4:18))return;
    const stock=storageStock(storage);let room=WORKER_CARRY;for(const kind of ["wood","stone"]){const amount=Math.min(room,stock[kind],buildNeed(building,kind,worker));stock[kind]-=amount;worker.carried[kind]+=amount;room-=amount;}if(storage!==BASE)storage.pulse=1;return;
  }
  let nearest=null,best=Infinity;
  for(const resource of resourceDrops){if(resource.target||targetIsClaimed(resource)||!resource.ground||!["wood","stone"].includes(resource.kind)||buildNeed(building,resource.kind,worker)<=0||distance(building.x,building.y,resource.x,resource.y)>WORKER_LEASH)continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<best){best=d;nearest=resource;}}
  if(nearest){worker.starved=false;worker.taskTarget=nearest;nearest.claimedBy=worker;return;}
  worker.starved=["wood","stone"].some(kind=>buildNeed(building,kind,worker)>0);moveWorker(worker,worker.postX,worker.postY,dt);
}

function updateKing(dt){
  const king=state.king;king.cooldown-=dt;king.swing=Math.max(0,king.swing-dt);
  if(king.cooldown>0)return;
  let target=null,best=KING.range;
  for(const enemy of state.enemies){
    const d=distance(king.x,king.y,enemy.x,enemy.y);if(d<best){best=d;target=enemy;}
  }
  if(!target)return;
  king.cooldown=KING.rate;king.swing=.18;king.targetX=target.x;king.targetY=target.y;
  target.hp-=KING.damage;target.flash=.15;burst(target.x,target.y,"#efe0a0",5);sound(260,.05);
  if(target.hp<=0)killEnemy(target,false);
}
function updateHazard(building,dt){
  const hazard=building.hazard;hazard.cooldown-=dt;hazard.flash=Math.max(0,hazard.flash-dt);
  if(hazard.cooldown>0)return;
  const enemy=state.enemies.find(item=>distance(building.x,building.y,item.x,item.y)<20);
  if(!enemy)return;
  if(building.type==="tar"){
    const def=BUILDING_TYPES.tar;hazard.cooldown=.25;hazard.flash=.12;applySlow(enemy,def.slowDuration,def.slowMultiplier);
  }else if(building.type==="landmine"){
    for(const target of [...state.enemies]){if(distance(building.x,building.y,target.x,target.y)>BUILDING_TYPES.landmine.effectRadius)continue;target.hp-=8;target.flash=.2;burst(target.x,target.y,"#e09b43",7);if(target.hp<=0)killEnemy(target,false);}
    for(let i=0;i<28;i++)particles.push({x:building.x,y:building.y,vx:rand(-140,140),vy:rand(-160,20),life:rand(.3,.7),col:i%2?"#d9893d":"#6e5540"});
    building.remove=true;sound(75,.25);
  }else{
    hazard.cooldown=.55;hazard.flash=.18;enemy.hp-=2;enemy.flash=.14;burst(enemy.x,enemy.y,"#c9c2b5",4);if(enemy.hp<=0)killEnemy(enemy,false);
  }
}
function damageEnemy(enemy,damage,color,count=5,source=null){
  if(!state.enemies.includes(enemy))return false;if(source?.tower&&buildings.includes(source))enemy.retaliationTower=source;enemy.hp-=damage;enemy.flash=.16;burst(enemy.x,enemy.y,color,count);if(enemy.hp<=0){killEnemy(enemy,false);return false;}return true;
}
function applySlow(enemy,duration,multiplier){
  enemy.status??={burn:null,slow:null};const current=enemy.status.slow;
  // Shared slow rule: repeated applications keep the longest remaining duration and the lowest (strongest) speed multiplier.
  enemy.status.slow={duration:Math.max(current?.duration||0,duration),multiplier:Math.min(current?.multiplier??1,multiplier)};
}
function pushEnemyToSpawn(enemy,distanceAmount){
  if(enemy.spawnSide===MAP_SIDE.WEST)enemy.x-=distanceAmount;else if(enemy.spawnSide===MAP_SIDE.EAST)enemy.x+=distanceAmount;else if(enemy.spawnSide===MAP_SIDE.NORTH)enemy.y-=distanceAmount;else if(enemy.spawnSide===MAP_SIDE.SOUTH)enemy.y+=distanceAmount;
  enemy.x=clamp(enemy.x,8,W-8);enemy.y=clamp(enemy.y,8,H-8);
}
function nearestTowerTarget(building,range){
  let target=null,best=range;for(const enemy of state.enemies){const d=distance(building.x,building.y,enemy.x,enemy.y);if(d<best){best=d;target=enemy;}}return target;
}
function applyBurn(enemy,building,variant){
  enemy.status??={burn:null};const current=enemy.status.burn,continues=current?.source===building;enemy.status.burn={remaining:variant.burnDuration,tickCooldown:continues?current.tickCooldown:variant.burnInterval,damage:variant.burnDamage,interval:variant.burnInterval,source:building};
}
function lineIntersectsEnemy(x1,y1,x2,y2,enemy,width){
  // Closest point on finite beam: project enemy-center vector onto beam, clamp t to [0,1], then compare distance to beam half-width plus enemy radius.
  const dx=x2-x1,dy=y2-y1,lengthSquared=dx*dx+dy*dy,t=clamp(((enemy.x-x1)*dx+(enemy.y-y1)*dy)/lengthSquared,0,1),closestX=x1+t*dx,closestY=y1+t*dy,enemyRadius=10*ENEMY_TYPES[enemy.type].size;
  return distance(enemy.x,enemy.y,closestX,closestY)<=width/2+enemyRadius;
}
function fireTowerAttack(building,variant,target){
  const tower=building.tower,color=variant.impactColor||variant.accent;tower.targetX=target.x;tower.targetY=target.y;tower.flash=.2;
  if(variant.attackMode==="splash"){
    const impactX=target.x,impactY=target.y;tower.impactX=impactX;tower.impactY=impactY;for(const enemy of [...state.enemies])if(distance(impactX,impactY,enemy.x,enemy.y)<=variant.splashRadius)damageEnemy(enemy,variant.damage,color,8,building);burst(impactX,impactY,color,18);
  }else if(variant.attackMode==="line"){
    const angle=Math.atan2(target.y-building.y,target.x-building.x),endX=building.x+Math.cos(angle)*variant.range,endY=building.y+Math.sin(angle)*variant.range;tower.targetX=endX;tower.targetY=endY;
    for(const enemy of [...state.enemies])if(lineIntersectsEnemy(building.x,building.y,endX,endY,enemy,variant.beamWidth))damageEnemy(enemy,variant.damage,color,7,building);
  }else{
    const alive=damageEnemy(target,variant.damage,color,["burn","slow","push"].includes(variant.attackMode)?8:5,building);
    if(alive&&variant.attackMode==="burn")applyBurn(target,building,variant);
    else if(alive&&variant.attackMode==="slow")applySlow(target,variant.slowDuration,variant.slowMultiplier);
    else if(alive&&variant.attackMode==="push"){pushEnemyToSpawn(target,variant.pushDistance);burst(target.x,target.y,color,10);}
  }
  sound(variant.sound,.18);
}
function updateTower(building,dt){
  if(!buildings.includes(building)&&heldBuilding()!==building)return;
  const tower=building.tower,variant=towerVariant(building);tower.cooldown=Math.max(0,tower.cooldown-dt);tower.flash=Math.max(0,tower.flash-dt);tower.hitFlash=Math.max(0,(tower.hitFlash||0)-dt);
  if(variant.manual||tower.cooldown>0)return;
  if(variant.attackMode==="periodic area"){
    const targets=state.enemies.filter(enemy=>distance(building.x,building.y,enemy.x,enemy.y)<=variant.effectRadius);if(!targets.length)return;
    tower.cooldown=variant.cooldown;tower.flash=.4;for(const enemy of targets)damageEnemy(enemy,variant.damage,variant.accent,5,building);sound(variant.sound,.22);return;
  }
  const target=nearestTowerTarget(building,variant.range);if(!target)return;tower.cooldown=variant.cooldown;fireTowerAttack(building,variant,target);
}

function updateGuard(worker,dt){
  let target=null,best=Infinity;
  for(const enemy of state.enemies){const postDistance=distance(worker.postX,worker.postY,enemy.x,enemy.y),d=distance(worker.x,worker.y,enemy.x,enemy.y);if(postDistance<=WORKER_LEASH&&d<best){best=d;target=enemy;}}
  if(target){worker.combatTarget=target;if(moveWorker(worker,target.x,target.y,dt,WORKER_MELEE-2))workerAttack(worker,target);return;}
  moveWorker(worker,worker.postX,worker.postY,dt);
}
function updateHauler(worker,dt){
  const storage=worker.jobTarget,task=worker.taskTarget;
  if(task&&(!resourceDrops.includes(task)||task.target||task.claimedBy!==worker))clearWorkerTask(worker);
  if(workerLoad(worker)>=WORKER_CARRY)worker.returning=true;
  if(!worker.returning&&!worker.taskTarget){
    let nearest=null,best=Infinity;
    for(const resource of resourceDrops){if(resource.target||targetIsClaimed(resource)||!resource.ground||distance(storage.x,storage.y,resource.x,resource.y)>storageServiceRadius(storage))continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<best){best=d;nearest=resource;}}
    if(nearest){worker.taskTarget=nearest;nearest.claimedBy=worker;}else if(workerLoad(worker)>0)worker.returning=true;
  }
  if(worker.returning){if(moveWorker(worker,worker.postX,worker.postY,dt,13))depositWorkerLoad(worker);return;}
  if(worker.taskTarget){
    const target=worker.taskTarget;if(moveWorker(worker,target.x,target.y,dt,10)){const at=resourceDrops.indexOf(target);if(at>=0){worker.carried[target.kind]++;resourceDrops.splice(at,1);}delete target.claimedBy;worker.taskTarget=null;if(workerLoad(worker)>=WORKER_CARRY)worker.returning=true;}return;
  }
  moveWorker(worker,worker.postX,worker.postY,dt);
}
function updateGatherer(worker,dt){
  let node=null,kind=null;
  if(worker.job==="harvest"){
    kind=worker.jobTarget?.kind;node=worker.jobTarget?.node;
    if(!kind)return;
    if(!node||!resourceIsActive(node,kind)){node=nearestWorkerNode(worker,kind);worker.jobTarget={node,kind};}
  }else{
    const building=worker.jobTarget;kind=BUILDING_TYPES[building?.type]?.resource;
    if(!building||!buildings.includes(building)||!kind){worker.job="guard";worker.jobTarget=null;return;}
    node=worker.taskTarget;
    if(!node||!resourceIsActive(node,kind)){node=nearestWorkerNode(worker,kind,building.x,building.y,BUILDING_TYPES[building.type].serviceRadius);worker.taskTarget=node;}
  }
  if(!node){moveWorker(worker,worker.postX,worker.postY,dt);return;}
  if(moveWorker(worker,node.x,node.y,dt,20)&&worker.hitCooldown<=0){worker.hitCooldown=WORKER_HIT_COOLDOWN;hitResource(node,kind,true);if(!resourceIsActive(node,kind)){if(worker.job==="harvest")worker.jobTarget={node:null,kind};else worker.taskTarget=null;}}
}
function updateWorker(worker,dt){
  worker.step+=dt;worker.hitCooldown-=dt;worker.attackCooldown-=dt;worker.combatTarget=null;
  let threat=null,best=WORKER_MELEE;
  for(const enemy of state.enemies){const d=distance(worker.x,worker.y,enemy.x,enemy.y);if(d<best){best=d;threat=enemy;}}
  if(threat){clearWorkerTask(worker);workerAttack(worker,threat);return;}
  const attacker=worker.retaliationTarget;
  if(attacker&&state.enemies.includes(attacker)&&distance(worker.postX,worker.postY,attacker.x,attacker.y)<=WORKER_LEASH+WORKER_MELEE){
    clearWorkerTask(worker);worker.combatTarget=attacker;if(moveWorker(worker,attacker.x,attacker.y,dt,WORKER_MELEE))workerAttack(worker,attacker);return;
  }
  if(worker.retaliationTarget)worker.returnAfterCombat=true;
  worker.retaliationTarget=null;
  if(worker.returnAfterCombat){clearWorkerTask(worker);if(moveWorker(worker,worker.postX,worker.postY,dt)){worker.returnAfterCombat=false;}return;}
  if(worker.job==="build")updateBuilder(worker,dt);
  else if(worker.job==="guard")updateGuard(worker,dt);
  else if(worker.job==="haul")updateHauler(worker,dt);
  else if(worker.job==="harvest"||worker.job==="staff")updateGatherer(worker,dt);
  else{clearWorkerTask(worker);worker.job="guard";worker.jobTarget=null;updateGuard(worker,dt);}
}

// Only this function changes phase identity and owns both phase-boundary side effects.
function transitionPhase(){
  const clock=state.clock;
  if(clock.phase==="day"){
    const wave=state.nightWave;
    clock.phase="night";clock.remaining=NIGHT_DURATION;
    wave.activeSide=wave.upcomingSide;wave.activeRecipe=wave.upcomingRecipe;wave.secondarySide=wave.activeRecipe.id==="twoFront"?oppositeMapSide(wave.activeSide):null;wave.lastSides=wave.secondarySide?[wave.activeSide,wave.secondarySide]:[wave.activeSide];wave.remainingSpawns=NIGHT_WAVE_SPAWNS;wave.elapsed=0;wave.nextSpawnAt=NIGHT_WAVE_WINDOW/NIGHT_WAVE_SPAWNS;wave.nightNumber++;
    chooseUpcomingNight();
  }else{
    clock.phase="day";clock.remaining=DAY_DURATION;clock.completedNights++;state.dayEnemyTimer=rand(DAY_ENEMY_SPAWN.min,DAY_ENEMY_SPAWN.max);
    state.nightWave.activeSide=null;state.nightWave.secondarySide=null;state.nightWave.activeRecipe=null;state.nightWave.remainingSpawns=0;
  }
}
function updateClock(dt){
  const clock=state.clock;
  clock.elapsed+=dt;   // same dt the countdown spends, so the two can never drift apart
  clock.remaining-=dt;
  while(clock.remaining<=0){const overflow=-clock.remaining;transitionPhase();clock.remaining-=overflow;}
  const target=clock.phase==="night"?NIGHT_OVERLAY_ALPHA:0,step=dt*NIGHT_OVERLAY_ALPHA/LIGHT_FADE_TIME;
  clock.light=target>clock.light?Math.min(target,clock.light+step):Math.max(target,clock.light-step);
}

function updateDaytimeEnemySpawns(dt){
  if(state.clock.phase!=="day")return;
  state.dayEnemyTimer-=dt;
  if(state.dayEnemyTimer>0)return;
  state.dayEnemyTimer=rand(DAY_ENEMY_SPAWN.min,DAY_ENEMY_SPAWN.max);
  if(state.enemies.length<DAY_ENEMY_CAP)spawnEnemy();
}
function updateNightEnemyWave(dt){
  if(state.clock.phase!=="night")return;
  const wave=state.nightWave,interval=NIGHT_WAVE_WINDOW/NIGHT_WAVE_SPAWNS;
  wave.elapsed+=dt;
  // Scheduled thresholds, rather than random frame rolls, keep the quota stable across frame rates.
  while(wave.remainingSpawns>0&&wave.elapsed>=wave.nextSpawnAt&&state.enemies.length<NIGHT_ENEMY_CAP){
    const spawn=wave.activeRecipe.spawns[NIGHT_WAVE_SPAWNS-wave.remainingSpawns],side=spawn[1]===WAVE_FRONT_SECONDARY?wave.secondarySide:wave.activeSide;
    spawnEnemy(side,spawn[0]);wave.remainingSpawns--;wave.nextSpawnAt+=interval;
  }
}

function updateEnemyStatuses(enemy,dt){
  enemy.status??={burn:null,slow:null};const burn=enemy.status.burn,slow=enemy.status.slow;
  if(burn){
    if(!buildings.includes(burn.source)||burn.source.tower?.variant!=="fire")enemy.status.burn=null;
    else{burn.remaining-=dt;burn.tickCooldown-=dt;while(burn.tickCooldown<=0&&burn.remaining>=0){burn.tickCooldown+=burn.interval;if(!damageEnemy(enemy,burn.damage,"#ef6a32",5,burn.source))return false;}if(burn.remaining<=0)enemy.status.burn=null;}
  }
  if(slow){slow.duration-=dt;if(slow.duration<=0)enemy.status.slow=null;}return true;
}
function segmentDistance(px,py,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,lengthSquared=dx*dx+dy*dy;if(!lengthSquared)return distance(px,py,x1,y1);const t=clamp(((px-x1)*dx+(py-y1)*dy)/lengthSquared,0,1);return distance(px,py,x1+t*dx,y1+t*dy);}
function enemyTargetResult(enemy,kind,object){return {kind,object,x:object.x,y:object.y,distance:Math.max(0,distance(enemy.x,enemy.y,object.x,object.y)-(kind==="tower"?26:0))};}
// Enemy priority is centralized: Aggro taunt, tower retaliation, nearest worker/base, then any tower physically intersecting that route.
function selectEnemyTarget(enemy){
  const canDamage=ENEMY_TYPES[enemy.type].damage>0;
  if(canDamage){
    let aggro=null,bestAggro=Infinity;for(const building of buildings){if(!building.complete||building.type!=="tower"||building.tower.hp<=0)continue;const variant=towerVariant(building),d=distance(enemy.x,enemy.y,building.x,building.y);if(variant.tauntRadius&&d<=variant.tauntRadius&&d<bestAggro){aggro=building;bestAggro=d;}}
    if(aggro)return enemyTargetResult(enemy,"tower",aggro);
    const retaliation=enemy.retaliationTower;if(retaliation&&buildings.includes(retaliation)&&retaliation.complete&&retaliation.tower.hp>0)return enemyTargetResult(enemy,"tower",retaliation);
  }
  enemy.retaliationTower=null;
  let kind="base",object=BASE,best=distance(enemy.x,enemy.y,BASE.x,BASE.y);for(const worker of state.workers){const d=distance(enemy.x,enemy.y,worker.x,worker.y);if(d<best){best=d;kind="worker";object=worker;}}
  if(!canDamage)return enemyTargetResult(enemy,kind,object);
  let blocker=null,bestBlocker=Infinity;for(const building of buildings){if(!building.complete||building.type!=="tower"||building.tower.hp<=0)continue;const d=distance(enemy.x,enemy.y,building.x,building.y);if(d<bestBlocker&&segmentDistance(building.x,building.y,enemy.x,enemy.y,object.x,object.y)<=26){blocker=building;bestBlocker=d;}}
  return blocker?enemyTargetResult(enemy,"tower",blocker):enemyTargetResult(enemy,kind,object);
}
function destroyTower(building){
  const at=buildings.indexOf(building);if(at<0)return;buildings.splice(at,1);for(const enemy of state.enemies){if(enemy.retaliationTower===building)enemy.retaliationTower=null;if(enemy.status?.burn?.source===building)enemy.status.burn=null;}
  for(const worker of state.workers)if(worker.jobTarget===building){clearWorkerTask(worker);worker.job="guard";worker.jobTarget=null;worker.postX=worker.x;worker.postY=worker.y;}
  if(state.upgradeMenu.building===building)closeUpgradeMenu();burst(building.x,building.y,"#8f5141",22);toast(towerVariant(building).name+" destroyed");sound(70,.35);
}
function damageTower(building,damage){const tower=building.tower;if(!buildings.includes(building)||tower.hp<=0)return;tower.hp=Math.max(0,tower.hp-damage);tower.hitFlash=.22;building.pulse=1;if(tower.hp<=0)destroyTower(building);}
function update(dt){
  if(state.gameOver||state.paused){stopPrimaryClick();return;}
  updatePrimaryClick(dt);updateClock(dt);updateNightEnemyWave(dt);
  const keys=state.keys,camera=state.camera;
  let panX=(keys.has("KeyD")||keys.has("ArrowRight"))-(keys.has("KeyA")||keys.has("ArrowLeft"));
  let panY=(keys.has("KeyS")||keys.has("ArrowDown"))-(keys.has("KeyW")||keys.has("ArrowUp"));
  if(panX||panY){const length=Math.hypot(panX,panY),speed=430/camera.zoom;camera.x+=panX/length*speed*dt;camera.y+=panY/length*speed*dt;clampCamera();}
  state.coinTimer-=dt;
  if(state.coinTimer<=0){spawnCoin();state.coinTimer=rand(14,22);}
  for(const enemy of [...state.enemies]){
    if(!updateEnemyStatuses(enemy,dt))continue;
    const def=ENEMY_TYPES[enemy.type];
    enemy.wob+=dt*7;enemy.flash=Math.max(0,enemy.flash-dt);enemy.shotFlash=Math.max(0,enemy.shotFlash-dt);enemy.healFlash=Math.max(0,enemy.healFlash-dt);enemy.attackCooldown-=dt;enemy.healCooldown-=dt;
    if(enemy.type==="healer"&&enemy.healCooldown<=0){
      let patient=null,best=150;
      for(const ally of state.enemies){if(ally===enemy||ally.hp>=ally.max)continue;const dd=distance(enemy.x,enemy.y,ally.x,ally.y);if(dd<best){best=dd;patient=ally;}}
      if(patient){patient.hp=Math.min(patient.max,patient.hp+2);enemy.healFlash=.3;enemy.healX=patient.x;enemy.healY=patient.y;burst(patient.x,patient.y,"#75c86d",5);}
      enemy.healCooldown=2.3;
    }
    const target=selectEnemyTarget(enemy);
    if(target.distance>def.range){const angle=Math.atan2(target.y-enemy.y,target.x-enemy.x),speedMultiplier=enemy.status.slow?.multiplier??1;enemy.x+=Math.cos(angle)*def.speed*speedMultiplier*dt;enemy.y+=Math.sin(angle)*def.speed*speedMultiplier*dt;}
    else if(def.damage&&enemy.attackCooldown<=0){
      enemy.attackCooldown=def.rate;enemy.shotFlash=.14;enemy.shotX=target.x;enemy.shotY=target.y;
      let workerDied=false;
      if(target.kind==="worker"){const worker=target.object;worker.retaliationTarget=enemy;worker.hp=Math.max(0,worker.hp-def.damage);if(worker.hp<=0)workerDied=killWorker(worker);}
      else if(target.kind==="tower")damageTower(target.object,def.damage);
      // invulnerable base (debug) is checked at the damage site: the hit still lands,
      // flashes and toasts, it just subtracts nothing. baseHp/baseMax are never inflated.
      else{if(!DBG.invulnBase)state.baseHp=Math.max(0,state.baseHp-def.damage);state.basePulse=1;if(state.baseHp<=0){endGame();break;}}
      toast(workerDied?"worker died — replacement in "+WORKER_SPAWN_TIME+"s":def.name+" hit "+(target.kind==="worker"?"a worker":target.kind==="tower"?towerVariant(target.object).name:"the base"));sound(def.range>60?180:95,.09);
    }
  }
  if(state.gameOver)return;
  updateKing(dt);
  state.basePulse=Math.max(0,state.basePulse-dt*3);
  state.toastTimer=Math.max(0,state.toastTimer-dt);
  state.collectCooldown-=dt;
  if(state.collecting&&state.mouse.inside&&state.collectCooldown<=0){
    // One pickup per short interval makes a drag vacuum nearby pieces without requiring repeated clicks.
    collectDrop(true);
    state.collectCooldown=SUCK_RATE;
  }
  if(state.toastTimer<=0)document.getElementById("toast").classList.remove("on");
  // Harvested nodes stay exhausted; only their hit-shake animation decays.
  for(const tree of trees)tree.shake=Math.max(0,tree.shake-dt*7);
  for(const rock of rocks)rock.shake=Math.max(0,rock.shake-dt*7);
  for(const diamond of diamonds)diamond.shake=Math.max(0,diamond.shake-dt*7);
  for(let i=resourceDrops.length-1;i>=0;i--){
    const drop=resourceDrops[i];
    if(drop.ttl!==null&&!drop.target&&!drop.claimedBy){drop.ttl-=dt;if(drop.ttl<=0){resourceDrops.splice(i,1);continue;}}
    drop.spin+=dt*4;
    if(drop.target==="hand"){
      drop.t+=dt*7;
      const ease=1-Math.pow(1-clamp(drop.t,0,1),3);
      drop.x+=(state.mouse.x-drop.x)*ease*.35;
      drop.y+=(state.mouse.y-drop.y)*ease*.35;
      if(drop.t>=1){resourceDrops.splice(i,1);state.carried[drop.kind]++;}
      continue;
    }
    drop.vy+=170*dt;
    drop.x+=drop.vx*dt;drop.y+=drop.vy*dt;
    if(drop.y>=drop.groundY){drop.y=drop.groundY;drop.vx*=.72;drop.vy*=-.22;if(Math.abs(drop.vy)<10){drop.vy=0;drop.vx=0;drop.ground=true;}}
  }
  updateWorkerSpawns(dt);
  for(const building of buildings){
    building.pulse=Math.max(0,building.pulse-dt*3);
    if(building.complete&&building.tower)updateTower(building,dt);
    if(building.complete&&building.hazard)updateHazard(building,dt);
  }
  for(let i=buildings.length-1;i>=0;i--)if(buildings[i].remove)buildings.splice(i,1);
  const held=heldBuilding();if(held?.tower)updateTower(held,dt);
  for(const worker of state.workers)updateWorker(worker,dt);
  for(const building of buildings)if(!building.complete){const builders=state.workers.filter(worker=>worker.job==="build"&&worker.jobTarget===building);building.starved=builders.length>0&&builders.every(worker=>worker.starved);}
  for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;if(p.resource){const q=1-p.life/p.max;p.x+=(p.tx-p.x)*q*.28;p.y+=(p.ty-p.y)*q*.28;}else{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=80*dt;}if(p.life<=0)particles.splice(i,1);}
  updatePrompt();syncPhaseHud();
}

// Whole seconds as M:SS, rolling over to H:MM:SS only once a run passes an hour — so the common
// case stays as short as the phase countdown beside it and a long run never silently wraps.
function formatDuration(totalSeconds){
  const s=Math.max(0,Math.floor(totalSeconds)),hours=Math.floor(s/3600),minutes=Math.floor(s/60)%60;
  const pad=n=>String(n).padStart(2,"0");
  return hours?hours+":"+pad(minutes)+":"+pad(s%60):minutes+":"+pad(s%60);
}
function syncPhaseHud(){
  const clock=state.clock,wave=state.nightWave,isDay=clock.phase==="day",duration=isDay?DAY_DURATION:NIGHT_DURATION;
  const recipeState=isDay?wave.upcomingRecipe:wave.activeRecipe,recipe=NIGHT_WAVE_RECIPES.find(item=>item.id===recipeState?.id),side=isDay?wave.upcomingSide:wave.activeSide;
  const secondary=recipe?.id==="twoFront"?(isDay?oppositeMapSide(side):wave.secondarySide):null,panel=document.getElementById("phaseHud");
  const setText=(id,text)=>{const element=document.getElementById(id);if(element.textContent!==text)element.textContent=text;};
  const seconds=Math.max(0,Math.ceil(clock.remaining)),phaseNumber=isDay?clock.completedNights+1:wave.nightNumber;
  setText("phaseName",clock.phase+" "+phaseNumber);setText("phaseTime",Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0"));
  setText("runTime",formatDuration(clock.elapsed));
  panel.classList.toggle("night",!isDay);
  document.getElementById("phaseProgressFill").style.width=(100*clamp((duration-clock.remaining)/duration,0,1)).toFixed(2)+"%";
  setText("forecastLabel",isDay?"next attack":"current wave");setText("forecastRemaining",isDay?"":wave.remainingSpawns+" scheduled spawns remaining");
  const signature=[clock.phase,recipe?.id,side,secondary].join("|");
  if(panel.dataset.forecast!==signature){
    panel.dataset.forecast=signature;
    const arrows={north:"↑",east:"→",south:"↓",west:"←"};
    setText("forecastSides",side?(arrows[side]+" "+side+(secondary?" · "+arrows[secondary]+" "+secondary:"")):"no attack scheduled");
    const summary=document.getElementById("recipeSummary");summary.replaceChildren();
    if(recipe){const counts={};for(const spawn of recipe.spawns)counts[spawn[0]]=(counts[spawn[0]]||0)+1;for(const [type,count] of Object.entries(counts)){const item=document.createElement("li");item.textContent=count+"× "+type;summary.appendChild(item);}}
  }
}

function syncBuildHud(){
  document.querySelectorAll("button.build").forEach(button=>button.classList.toggle("on",button.dataset.kind===state.buildMode));
  for(const [kind,label] of [["spikes","spikeStack"],["landmine","landmineStack"],["tar","tarStack"]]){
    const unavailable=!DBG.unlimitedCharges&&state.buildStacks[kind]<=0,button=document.querySelector('button.build[data-kind="'+kind+'"]');
    document.getElementById(label).textContent="free · "+(DBG.unlimitedCharges?"∞":state.buildStacks[kind]+" left");button.disabled=unavailable;
  }
  const houseCost=nextHouseCost();document.getElementById("houseCost").textContent=houseCost.wood+"w · "+houseCost.stone+"s";
  canvas.classList.toggle("building",state.buildMode);
}
function updatePrompt(){
  const box=document.getElementById("prompt"),label=box.querySelector("span"),target=hoverTarget();
  box.classList.toggle("on",!!target);
  if(target)label.textContent=target.kind==="base"?"deposit at base":target.kind==="stockpile"?"store in stockpile":target.kind==="upgrade"?"deposit toward upgrade":"deliver to blueprint";
}
function toast(message){
  const el=document.getElementById("toast");el.textContent=message;el.classList.add("on");state.toastTimer=2.2;
}
function endGame(){
  if(state.gameOver)return;
  state.gameOver=true;stopGameplayInput(true);cancelHeldObject();closeUpgradeMenu();
  document.getElementById("gameOver").classList.remove("off");sound(65,.6);
}
document.getElementById("restart").addEventListener("click",()=>location.reload());
function burst(x,y,col,count){for(let i=0;i<count;i++)particles.push({x,y,vx:rand(-55,55),vy:rand(-90,-25),life:rand(.3,.7),col});}

let audio=null;
function sound(freq,duration){
  try{audio=audio||new(window.AudioContext||window.webkitAudioContext)();const o=audio.createOscillator(),g=audio.createGain();o.type="square";o.frequency.value=freq;g.gain.setValueAtTime(.035,audio.currentTime);g.gain.exponentialRampToValueAtTime(.0001,audio.currentTime+duration);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+duration);}catch(_){ }
}


// ═══════════════════════════════════════════════════════════════════════════
// 3D RENDER LAYER
// The simulation above is untouched and still thinks in 2D game pixels.
// Everything here is read-only over that state: game (x, y) maps to world
// (x*S, 0, y*S), meshes are pooled per entity, and anything that must stay
// unskewed (bars, text, carried resources) is drawn on a 2D overlay canvas
// at projected screen positions.
// ═══════════════════════════════════════════════════════════════════════════

function workerToolKind(worker){
  if(worker.job==="harvest")return worker.jobTarget?.kind;
  if(worker.job==="staff")return BUILDING_TYPES[worker.jobTarget?.type]?.resource;
  if(worker.job==="build")return "build";
  return null;
}
function towerRadius(building){const variant=towerVariant(building);return variant.range||variant.effectRadius;}

const S = 1/16;                       // game pixels -> world units
const WU = W*S, HU = H*S;             // 96 x 64
const gx = x => x*S, gz = y => y*S;

// ═══════════════════════════════════════════════════════════════════════════
// PALETTE
// Single source of truth for every colour in the 3D layer. Entries are hex
// numbers for three.js; css() converts for the 2D overlay and the baked
// ground texture. Grouped by role, not by object, so retinting a material
// family (all timber, all arcane glow) is one edit.
// ═══════════════════════════════════════════════════════════════════════════
const PAL = {
  // ── world ──────────────────────────────────────────────
  sky:        0x1d1c29,
  water:      0x8fb3cf,
  cliff:      0x6a5a41,
  grass:      0x9db97f,
  grassAlt:   0x96b177,
  grassSpeck: 0x8dab70,
  dirt:       0xd9c9a3,   // base clearing, paths
  grid:       0x63764c,   // placement lattice; drawn at very low opacity

  // ── flora ──────────────────────────────────────────────
  trunk:      0x6b4a2e,
  stump:      0x79512e,
  leaf:      [0x7fae5c, 0x6d9a4d, 0xd9a0bc],   // indexed by tree.variant

  // ── minerals ───────────────────────────────────────────
  rock:       0x9a9a94,
  rockDark:   0x6f6f6a,
  rubble:     0x8d8c88,
  gem:        0x71cbd8,
  gemBase:    0x4d6264,
  gemSpent:   0x557b80,

  // ── resources ──────────────────────────────────────────
  wood:       0xb98a4e,
  stone:      0xaaa9a5,
  dust:       0xa783df,
  coin:       0xe3b445,
  diamond:    0x79d9e8,

  // ── people ─────────────────────────────────────────────
  skin:       0xd7b586,
  coat:       0xd4b079,   // fallback worker coat
  jobHaul:    0x6f96ad,
  jobBuild:   0xd29a39,
  jobGuard:   0x9a7a54,
  hat:        0x6f4930,
  kingRobe:   0x9d3f34,
  kingCrown:  0xe8be55,
  blade:      0xded8c9,

  // ── enemies ────────────────────────────────────────────
  raider:     0x4a4152, raiderCap: 0x2b2532,
  archer:     0x76583e, archerCap: 0xa2814f,
  healer:     0x557649, healerCap: 0xe3dec5,
  brute:      0x674337, bruteCap:  0x3b2a21,

  // ── structures ─────────────────────────────────────────
  timber:     0x8a7358,
  timberDark: 0x5c4a38,
  plaster:    0xc0a170,
  plasterLit: 0xc9b48a,
  roof:       0x8e5f3c,
  roofDark:   0x5f4527,
  masonry:    0x8d8495,
  masonryDark:0x6b6874,
  quarryWall: 0x777775,
  quarryRoof: 0x5f6061,
  doorway:    0x49392d,
  // the keep: pale dressed stone, deliberately cooler and lighter than masonry (the obelisk) so
  // the base reads as the one landmark on the map. keepTrim is the plinth/crown/prop course.
  keepWall:   0xb9b6b0,
  keepTrim:   0x93908a,
  pole:       0x5d4935,
  banner:     0xa94634,
  metal:      0xbdb7ab,
  tar:        0x3a3128,
  arcane:     0xb18be5,
  arcaneGlow: 0x2e1f4a,
  fuse:       0xd8a343,
  charge:     0xa74434,
  chargeBody: 0x59473a,
  blueprint:  0x9a774d,
  scaffold:   0x83603a,
  pad:        0xa08a63,   // packed earth under a finished building's footprint

  // ── tower accents (by variant) ─────────────────────────
  towShock:   0x4c5d61,
  towLaser:   0x78e3df,
  towFire:    0xd9713f,
  towFreeze:  0x8fd9ee,
  towTeleport:0x7396e8,
  towBomb:    0x9a5c3a,
  towSniper:  0xd9e3c2,
  towBrick:   0x9b7f60,
  towOutpost: 0x7d6b52,

  // ── feedback / rings ───────────────────────────────────
  flash:      0xd25b49,   // enemy hit tint
  hurtGlow:   0x5a1a12,   // tower damage emissive
  emberGlow:  0x60220c,   // burning status emissive
  ghostOk:    0x1d3312,
  ghostBad:   0x3d1410,
  cellOk:     0x8fc95e,   // footprint preview, placement allowed
  cellBad:    0xcf4f3e,   // footprint preview, placement blocked
  tool:       0x65442c,
  hpGood:     0x7fb356,   // remaining-health track, top row of a stack
  hint:       0xead18d,
  ok:         0xf5df98,   // affirmative highlight: hover rings, default impact flash
  cursor:     0xc8cbb8,   // idle cursor bracket: cool and quiet, so a real target still reads warmer
  bad:        0xb84b3c,
  taunt:      0xd6534f,
  storage:    0xd8c47c,
  pin:        0xd4453a,

  // ── lighting ───────────────────────────────────────────
  sunDay:     0xfff2d0,
  sunNight:   0x9fb4e8,
  skyLight:   0xd8e8ff,
  bounce:     0x6b6350,
};
/** Hex number -> css string, for the 2D overlay and canvas textures. */
const css = n => "#" + n.toString(16).padStart(6,"0");

const DROP_COLOR = {wood:PAL.wood, stone:PAL.stone, dust:PAL.dust,
                    coin:PAL.coin, diamond:PAL.diamond};
const JOB_COAT = {haul:PAL.jobHaul, build:PAL.jobBuild, guard:PAL.jobGuard};
/** Tower roof accent per variant; anything unlisted falls back to timberDark. */
const TOWER_TOP = {
  pulse:PAL.arcane,     shock:PAL.towShock,   laser:PAL.towLaser,
  fire:PAL.towFire,     freeze:PAL.towFreeze, tar:PAL.tar,
  teleport:PAL.towTeleport, bomb:PAL.towBomb, sniper:PAL.towSniper,
  watch:PAL.coin,       brick:PAL.towBrick,   aggro:PAL.taunt,
  turret:PAL.timber,    outpost:PAL.towOutpost,
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
const view = {pitch:40, yaw:0, fov:38, ortho:false, orbit:false,
              heightScale:100, ghostPins:false};

function placeCamera(){
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

// The overlay is authored in a fixed 960x540 space but displayed much larger.
// Backing store must match real device pixels or every bar and glyph is upscaled.
let overlayScale = 1;
let viewAspect = 16/9;

function resizeRenderer(){
  const r = sceneCanvas.getBoundingClientRect();
  if(!r.width||!r.height)return;
  renderer.setSize(r.width, r.height, false);
  viewAspect = r.width/r.height;
  persp.aspect = viewAspect;

  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width  = Math.round(r.width  * dpr);
  canvas.height = Math.round(r.height * dpr);
  overlayScale  = canvas.width / VIEW_W;

  placeCamera();
}
addEventListener("resize", resizeRenderer);

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
const flat = (color, extra={}) => new THREE.MeshLambertMaterial({color, flatShading:true, ...extra});
// ── outlines ────────────────────────────────────────────────────────────────
// Inverted hull: a back-faced copy of each prop pushed out along its normals,
// so only the shell behind the object survives depth testing and reads as ink.
// Costs one extra draw per prop; hidden meshes are skipped, so the toggle is free.
let OUTLINE_ON = true;
const outlineMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: {thickness:{value:.05}, tint:{value:new THREE.Color(0x1d1712)}},
  vertexShader: `
    uniform float thickness;
    void main(){
      vec3 swollen = position + normal * thickness;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(swollen, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 tint;
    void main(){ gl_FragColor = vec4(tint, 1.0); }`,
});
const outlineShells = [];
const isOutline = o => o.userData.outline === true;

function meshOf(geo, mat, cast=true, receive=true){
  const m = new THREE.Mesh(geo, mat); m.castShadow=cast; m.receiveShadow=receive;
  if(cast){                                  // props only — never ground or water
    const shell = new THREE.Mesh(geo, outlineMat);
    shell.castShadow = shell.receiveShadow = false;
    shell.userData.outline = true;
    shell.visible = OUTLINE_ON;
    m.add(shell);
    outlineShells.push(shell);
  }
  return m;
}
function setOutlines(on){
  OUTLINE_ON = on;
  for(const s of outlineShells) s.visible = on;
}

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
const GRID_OPACITY = .24;     // deliberately faint; draw() fades it further at night
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
  // Not a mesh and not a shadow caster, so blockerMeshes() cannot pick it up as an occluder.
  lines.castShadow = lines.receiveShadow = false;
  lines.renderOrder = -1;      // below rings, ghosts and every other transparent mark
  return lines;
})();
scene.add(terrainGrid);


// ─────────────────────────────────────────────────────────── entity models

function makeTree(t){
  const g = new THREE.Group();
  const leaf = PAL.leaf[t.variant] ?? PAL.leaf[0];
  const trunk = meshOf(new THREE.CylinderGeometry(.16,.24,2.2,6), flat(PAL.trunk));
  trunk.position.y = 1.1;
  const crown = meshOf(new THREE.IcosahedronGeometry(1.35,0), flat(leaf));
  crown.position.y = 3.0; crown.scale.set(1,.85,1);
  const stump = meshOf(new THREE.CylinderGeometry(.26,.3,.42,6), flat(PAL.stump));
  stump.position.y = .21; stump.visible = false;
  g.add(trunk, crown, stump);
  g.userData = {trunk, crown, stump};
  return g;
}
function makeRock(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.DodecahedronGeometry(.95,0), flat(PAL.rock));
  body.position.y = .55; body.scale.set(1,.72,1);
  const chip = meshOf(new THREE.DodecahedronGeometry(.42,0), flat(PAL.rockDark));
  chip.position.set(.8,.28,.35);
  const rubble = meshOf(new THREE.DodecahedronGeometry(.55,0), flat(PAL.rubble));
  rubble.position.y = .14; rubble.scale.set(1,.3,1); rubble.visible = false;
  g.add(body, chip, rubble);
  g.userData = {live:[body,chip], rubble};
  return g;
}
function makeDiamond(){
  const g = new THREE.Group();
  const base = meshOf(new THREE.DodecahedronGeometry(.7,0), flat(PAL.gemDark));
  base.position.y = .35; base.scale.set(1,.5,1);
  const gem = meshOf(new THREE.OctahedronGeometry(.55,0), flat(PAL.gem));
  gem.position.y = 1.05;
  const spent = meshOf(new THREE.DodecahedronGeometry(.45,0), flat(PAL.gemSpent));
  spent.position.y = .12; spent.scale.set(1,.28,1); spent.visible = false;
  g.add(base, gem, spent);
  g.userData = {live:[base,gem], spent, gem};
  return g;
}
function makeDrop(kind){
  const g = new THREE.Group();
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.16,.16,.8,6), flat(col)); m.rotation.z=Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.3,.3,.09,10), flat(col)); m.rotation.x=Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.32,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.3,0), flat(col));
  m.position.y = .3;
  g.add(m);
  g.userData = {body:m};
  return g;
}
// Enemies borrow the prototype's unit form — capsule body, sphere head, cone
// cap — and read apart by colour and bulk rather than by props.
const ENEMY_LOOK = {
  raider:{body:PAL.raider, cap:PAL.raiderCap, r:.26, len:.46},
  archer:{body:PAL.archer, cap:PAL.archerCap, r:.22, len:.56},
  healer:{body:PAL.healer, cap:PAL.healerCap, r:.29, len:.40},
  brute: {body:PAL.brute, cap:PAL.bruteCap, r:.34, len:.54},
};
function makeEnemy(type){
  const g = new THREE.Group();
  const L = ENEMY_LOOK[type] || ENEMY_LOOK.raider;
  const body = meshOf(new THREE.CapsuleGeometry(L.r, L.len, 3, 8), flat(L.body));
  body.position.y = L.r + L.len/2;
  const head = meshOf(new THREE.SphereGeometry(L.r*.82, 8, 6), flat(PAL.skin));
  head.position.y = L.r*2 + L.len + .04;
  const cap = meshOf(new THREE.ConeGeometry(L.r*1.18, L.r*1.05, 7), flat(L.cap));
  cap.position.y = head.position.y + L.r*.86;
  g.add(body, head, cap);
  g.userData = {body, head, cap, baseColor:L.body};
  return g;
}
function makeWorker(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.CapsuleGeometry(.26,.42,3,7), flat(PAL.coat));
  body.position.y = .55;
  const head = meshOf(new THREE.SphereGeometry(.24,8,6), flat(PAL.skin));
  head.position.y = 1.08;
  const hat = meshOf(new THREE.ConeGeometry(.3,.26,7), flat(PAL.hat));
  hat.position.y = 1.3;
  const load = meshOf(new THREE.BoxGeometry(.28,.28,.28), flat(PAL.wood));
  load.position.set(-.38,.72,0); load.visible = false;
  const tool = meshOf(new THREE.BoxGeometry(.08,.62,.08), flat(PAL.tool));
  tool.position.set(.36,.72,0);
  g.add(body, head, hat, load, tool);
  g.userData = {body, load, tool};
  return g;
}
function makeCorpse(coat){
  const g = new THREE.Group();
  const m = meshOf(new THREE.CapsuleGeometry(.24,.4,3,6),
    new THREE.MeshLambertMaterial({color:new THREE.Color(coat), flatShading:true,
      transparent:true, opacity:.62}));
  m.rotation.z = Math.PI/2; m.position.y = .24;
  g.add(m);
  return g;
}
// ── the keep ────────────────────────────────────────────────────────────────
// A compact square watchtower: a stone shaft whose walls taper inward, a slightly projecting open
// crown with chunky crenellations, and one small dark entrance. No pitched roof, no flag, no
// corner towers - the silhouette is meant to read as a single tall block, not a house.
//
// The VISUAL MASS IS INTENTIONALLY 1x1 (about 2.0 x 2.0 world units, the centre cell) while
// GAMEPLAY OCCUPANCY REMAINS 3x3 (BASE.footprint = FOOTPRINT_3x3). The outer ring of the pad is
// courtyard: an entrance path and a couple of low props, everything kept below doorway height so
// nothing competes with the tower. canPlace(), enemy targeting and BASE.r read the footprint and
// BASE.r, never the model, so shrinking the mesh changes nothing in the simulation.
function makeBase(){
  const g = new THREE.Group();
  const Y0 = FLOOR_TOP;               // the footprint pad's top face; every course stacks off it
  const LAP = .03;                    // each course sinks this far into the one below, so no two
                                      // solid faces ever end up coplanar and z-fighting
  // Square prisms come from a 4-segment cylinder turned 45deg, which lands flat faces on the X and
  // Z axes. Width across those faces is r*sqrt(2), so sq() converts a wall width into the radius
  // three.js wants. A frustum (bottom wider than top) is what gives the walls their taper.
  const sq = w => w/Math.SQRT2;
  const prism = (wBottom, wTop, h, mat) => {
    const m = meshOf(new THREE.CylinderGeometry(sq(wTop), sq(wBottom), h, 4), mat);
    m.rotation.y = Math.PI/4;
    return m;
  };
  const PLINTH_H = .30, SHAFT_H = 3.5, CORBEL_H = .22, MERLON_H = .48;
  const PLINTH_TOP = Y0 + PLINTH_H;                       // .396
  const SHAFT_BOT  = PLINTH_TOP - LAP;
  const SHAFT_TOP  = SHAFT_BOT + SHAFT_H;                 // 3.866
  const CROWN_TOP  = SHAFT_TOP - LAP + CORBEL_H;          // 4.056 - walkway level

  const plinth = meshOf(new THREE.BoxGeometry(2.0,PLINTH_H,2.0), flat(PAL.keepTrim));
  plinth.position.y = Y0 + PLINTH_H/2;
  // 1.86 -> 1.42 across 3.5 of height: a taper you can read in silhouette without the tower
  // looking like a cone. Widest point (1.86) still sits inside the 2.0 plinth.
  const body = prism(1.86, 1.42, SHAFT_H, flat(PAL.keepWall));
  body.position.y = SHAFT_BOT + SHAFT_H/2;
  // The crown flares back OUT past the shaft top (1.42 -> 1.84), so it overhangs by ~.21 a side.
  const corbel = prism(1.46, 1.84, CORBEL_H, flat(PAL.keepTrim));
  corbel.position.y = SHAFT_TOP - LAP + CORBEL_H/2;
  // Shadowed interior, glimpsed through the gaps between merlons and from above: this is what
  // makes the crown read as open rather than as a solid capstone.
  // 1.04 wide keeps it just inside the merlon ring's inner edge (+-.52), so it fills the gaps
  // between the teeth without clipping into them.
  const well = meshOf(new THREE.BoxGeometry(1.04,.12,1.04), flat(PAL.doorway));
  well.position.y = CROWN_TOP + .02;
  g.add(plinth, body, corbel, well);
  // Crenellations: four corners plus one merlon at the middle of each side. .40 blocks with .32
  // gaps around a 1.84 crown, so at gameplay zoom they read as separate teeth, not a serrated rim.
  for(const [mx,mz] of [[-.72,-.72],[.72,-.72],[-.72,.72],[.72,.72],[0,-.72],[0,.72],[-.72,0],[.72,0]]){
    const merlon = meshOf(new THREE.BoxGeometry(.40,MERLON_H,.40), flat(PAL.keepWall));
    merlon.position.set(mx, CROWN_TOP - LAP + MERLON_H/2, mz);
    g.add(merlon);
  }
  // Entrance faces the king. gz() maps sim y straight to world z, and the king stands at
  // BASE.y+18, so "toward the king" is +Z. The dark block stands slightly proud of the plinth
  // (front face z=1.05 vs the plinth's 1.0) so it never z-fights the wall it sits in.
  const door = meshOf(new THREE.BoxGeometry(.58,1.00,.30), flat(PAL.doorway));
  door.position.set(0, PLINTH_TOP - .02 + .50, .90);
  // The king never moves off BASE.y+18, i.e. z=+1.125 with a .26 body radius, so he occupies
  // z .865-1.385 right where a slab tucked against the plinth would go. The step therefore sits at
  // the HEAD OF THE PATH (back face z=1.405) and the king stands on the pad between it and the
  // door; anything nearer the wall would be drawn through his legs.
  const step = meshOf(new THREE.BoxGeometry(.90,.14,.55), flat(PAL.keepTrim));
  step.position.set(0, Y0 + .07, 1.68);
  // One arrow slit high on the same face, so the tower still has an eye when the king is standing
  // in the doorway. The wall has drawn back to z=.78 by this height, so .87 clears it.
  const slit = meshOf(new THREE.BoxGeometry(.20,.42,.14), flat(PAL.doorway));
  slit.position.set(0, 2.80, .80);
  // Worn approach across the courtyard. cast=false, exactly like the pad: no outline shell, no
  // shadow, and invisible to blockerMeshes() so it can never occlude a unit.
  // Reaches z=2.70, so even at the store pulse's peak 1.1x group scale it stays inside the pad.
  const path = meshOf(new THREE.BoxGeometry(.60,.05,1.60), flat(PAL.dirt), false, true);
  path.position.set(0, Y0 + .02, 1.90);
  g.add(door, step, slit, path);
  // Three low props, all well under the doorway's 1.38 and well inside the pad: two gate posts
  // flanking the path and a small stack of cut stone in a back corner. The rest stays open.
  for(const px of [-.62, .62]){
    const post = meshOf(new THREE.BoxGeometry(.28,.36,.28), flat(PAL.keepTrim));
    post.position.set(px, Y0 + .18, 2.45); g.add(post);
  }
  const block = meshOf(new THREE.BoxGeometry(.52,.30,.52), flat(PAL.stone));
  block.position.set(-1.85, Y0 + .15, -1.95);
  const blockTop = meshOf(new THREE.BoxGeometry(.34,.24,.34), flat(PAL.stone));
  blockTop.position.set(-1.78, Y0 + .30 - LAP + .12, -2.02);
  const floor = makeFootprintFloor(BASE.footprint);
  g.add(floor, block, blockTop);
  g.position.set(gx(BASE.x), 0, gz(BASE.y));
  g.userData = {body, floor};
  return g;
}
function makeKing(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.CapsuleGeometry(.26,.44,3,7), flat(PAL.kingRobe));
  body.position.y = .58;
  const head = meshOf(new THREE.SphereGeometry(.24,8,6), flat(PAL.skin));
  head.position.y = 1.12;
  const crown = meshOf(new THREE.CylinderGeometry(.26,.26,.2,6), flat(PAL.kingCrown));
  crown.position.y = 1.36;
  const sword = meshOf(new THREE.BoxGeometry(.08,.86,.08), flat(PAL.blade));
  sword.position.set(.38,.86,0);
  g.add(body, head, crown, sword);
  g.userData = {sword};
  return g;
}

// ── footprint floors ────────────────────────────────────────────────────────
// A low pad covering exactly the cells canPlace() reserves for `type`. Every dimension is derived
// from the footprint metadata (fp.w/fp.h in CELLS -> game px -> world units), so the tower's 3x3
// pad and a deployable's single cell come from the same expression and nothing restates a size.
// The model keeps its own scale and stays centred on the anchor; the pad is what grows.
// Ownership: geometry and material are built PER INSTANCE. Building groups are torn down wholesale
// by disposeGroup(), so nothing parented into one may share a geometry or material with anything else.
const FLOOR_H = .09;          // pad thickness in world units
const FLOOR_LIFT = .006;      // bottom face held clear of the ground plane
const FLOOR_TOP = FLOOR_LIFT + FLOOR_H;
// Takes the footprint itself, not a type, so the base (which has no BUILDING_TYPES entry) uses the
// same pad path as everything else.
function makeFootprintFloor(fp, color=PAL.pad){
  // cast=false: no outline shell, no shadow casting, and therefore invisible to blockerMeshes().
  const m = meshOf(new THREE.BoxGeometry(fp.w*CELL*S, FLOOR_H, fp.h*CELL*S), flat(color), false, true);
  m.position.y = FLOOR_LIFT + FLOOR_H/2;   // box bottom sits just above y=0, so no coplanar ground face
  return m;
}

function makeBuilding(type){
  const g = new THREE.Group();
  const parts = [];
  const add = (m)=>{ g.add(m); parts.push(m); return m; };
  if(type==="tower"){
    for(const [dx,dz] of [[-.5,-.5],[.5,-.5],[-.5,.5],[.5,.5]]){
      const leg = add(meshOf(new THREE.BoxGeometry(.2,3.0,.2), flat(PAL.timber)));
      leg.position.set(dx,1.5,dz);
    }
    const deck = add(meshOf(new THREE.BoxGeometry(1.7,.3,1.7), flat(PAL.timber)));
    deck.position.y = 3.1;
    const roof = add(meshOf(new THREE.ConeGeometry(1.4,1.0,4), flat(PAL.timberDark)));
    roof.position.y = 3.8; roof.rotation.y = Math.PI/4;
    g.userData.roof = roof;
  } else if(type==="house"){
    const b = add(meshOf(new THREE.BoxGeometry(2.4,1.6,2.0), flat(PAL.plaster))); b.position.y=.8;
    const r = add(meshOf(new THREE.ConeGeometry(1.9,1.2,4), flat(PAL.roof))); r.position.y=2.2; r.rotation.y=Math.PI/4;
  } else if(type==="lumber"){
    const b = add(meshOf(new THREE.BoxGeometry(2.4,1.3,1.9), flat(PAL.scaffold))); b.position.y=.65;
    const r = add(meshOf(new THREE.BoxGeometry(2.7,.28,2.2), flat(PAL.roofDark))); r.position.y=1.42;
    const log = add(meshOf(new THREE.CylinderGeometry(.22,.22,1.8,6), flat(PAL.wood)));
    log.rotation.x=Math.PI/2; log.position.set(1.1,.24,.9);
  } else if(type==="quarry"){
    const b = add(meshOf(new THREE.BoxGeometry(2.3,1.2,1.9), flat(PAL.quarryWall))); b.position.y=.6;
    const r = add(meshOf(new THREE.ConeGeometry(1.7,.9,5), flat(PAL.quarryRoof))); r.position.y=1.6;
    const s = add(meshOf(new THREE.DodecahedronGeometry(.45,0), flat(PAL.stone))); s.position.set(1.1,.3,.9);
  } else if(type==="stockpile"){
    const p = add(meshOf(new THREE.BoxGeometry(2.6,.24,2.2), flat(PAL.scaffold))); p.position.y=.12;
    const c1 = add(meshOf(new THREE.BoxGeometry(.9,.7,.9), flat(PAL.wood))); c1.position.set(-.6,.55,0);
    const c2 = add(meshOf(new THREE.BoxGeometry(.8,.55,.8), flat(PAL.stone))); c2.position.set(.65,.48,.2);
  } else if(type==="obelisk"){
    const b = add(meshOf(new THREE.BoxGeometry(1.5,.4,1.5), flat(PAL.masonryDark))); b.position.y=.2;
    const sh = add(meshOf(new THREE.CylinderGeometry(.36,.52,3.0,5), flat(PAL.masonry))); sh.position.y=1.9;
    const tip = add(meshOf(new THREE.OctahedronGeometry(.44,0), flat(PAL.arcane,{emissive:PAL.arcaneGlow}))); tip.position.y=3.7;
    g.userData.tip = tip;
  } else if(type==="blast"){
    const b = add(meshOf(new THREE.CylinderGeometry(.55,.62,.8,8), flat(PAL.chargeBody))); b.position.y=.4;
    const t = add(meshOf(new THREE.SphereGeometry(.28,8,6), flat(PAL.charge))); t.position.y=.95;
  } else if(type==="landmine"){
    const b = add(meshOf(new THREE.CylinderGeometry(.5,.55,.4,8), flat(PAL.chargeBody))); b.position.y=.2;
    const t = add(meshOf(new THREE.CylinderGeometry(.14,.14,.3,6), flat(PAL.fuse))); t.position.y=.52;
  } else if(type==="spikes"){
    for(let i=0;i<5;i++){
      const s = add(meshOf(new THREE.ConeGeometry(.16,.85,4), flat(PAL.metal)));
      s.position.set((i%3-1)*.55, .42, (Math.floor(i/3)-.5)*.6);
    }
  } else if(type==="tar"){
    const p = add(meshOf(new THREE.CylinderGeometry(1.15,1.15,.12,14), flat(PAL.tar))); p.position.y=.06;
  } else {
    const b = add(meshOf(new THREE.BoxGeometry(2,1.4,1.8), flat(PAL.blueprint))); b.position.y=.7;
  }
  // Added after `parts` is filled and deliberately NOT pushed into it: the tower hurt-flash and the
  // ghost tint iterate `parts`/meshes for the MODEL, and the ground pad must not join those effects.
  const floor = makeFootprintFloor(buildingFootprint(type));
  g.add(floor);
  g.userData.floor = floor;
  g.userData.parts = parts;
  return g;
}
// Blueprints are footprint-aware too: same pad the finished building will get, so completing a
// structure never changes the ground it reserved. Posts ride the footprint corners.
function makeBlueprint(type){
  const g = new THREE.Group();
  const fp = buildingFootprint(type);
  const w = fp.w*CELL*S, d = fp.h*CELL*S;
  const pad = makeFootprintFloor(buildingFootprint(type), PAL.scaffold);
  g.add(pad);
  g.userData.floor = pad;
  const post = .18, ix = w/2 - post/2 - .06, iz = d/2 - post/2 - .06;
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    const p = meshOf(new THREE.BoxGeometry(post,1.1,post), flat(PAL.blueprint));
    p.position.set(sx*ix, FLOOR_TOP + .55, sz*iz);
    g.add(p);
  }
  return g;
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
function disposeGroup(g){
  g.traverse(o=>{
    if(!o.isMesh) return;
    if(isOutline(o)){                        // shares its parent's geometry and
      const i = outlineShells.indexOf(o);     // one global material — drop the
      if(i >= 0) outlineShells.splice(i, 1);  // reference, dispose neither
      return;
    }
    o.geometry.dispose();
    if(o.material.dispose) o.material.dispose();
  });
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
    setXZ(g, r, Math.sin(p*Math.PI)*HAND_ARC + p*2.2);
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
  mesh.scale.setScalar(size*SHOT_SIZE);
  shots.push({mesh, from, to, t:0,
    dur: clamp(from.distanceTo(to)/SHOT_SPEED, .1, .9),
    arc: arc*SHOT_ARC, impact});
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
// Populated by measureNow() in the debug layer, which already computes the
// hidden positions while it counts visibility.
const pins = new THREE.Group();
scene.add(pins);
const pinGeo = new THREE.ConeGeometry(.6,1.4,4);
const pinMat = new THREE.MeshBasicMaterial({color:PAL.pin, depthTest:false, transparent:true, opacity:.9});
function setPins(points){
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

function handMeshFor(kind){
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.13,.13,.62,6), flat(col)); m.rotation.z = Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.22,.22,.07,10), flat(col)); m.rotation.x = Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.24,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.22,0), flat(col));
  return m;
}
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
// Exclusion: castShadow=false on every mesh keeps them out of blockerMeshes() (`isMesh && visible &&
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
const IND = {
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
    mesh.castShadow = mesh.receiveShadow = false;   // keeps it out of blockerMeshes()/shadow map
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

// ─────────────────────────────────────────────────────────── 2D overlay
const _pv = new THREE.Vector3();
/** game (x,y) plus height in game px -> overlay canvas coords (960x540). */
function project(x, y, hpx=0){
  _pv.set(gx(x), hpx*S, gz(y)).project(camera3);
  return {x:(_pv.x*.5+.5)*VIEW_W, y:(-_pv.y*.5+.5)*VIEW_H, depth:_pv.z};
}
/** Health / progress readout. Same capsule as the chop bar, dark-rimmed. */
// ── overlay sizing (view panel > bars) ──────────────────────────────────────
// Overlay marks are drawn in fixed screen pixels, so without scaling they
// dwarf the world when zoomed out and vanish when zoomed in.
const BARS = {
  wMul:1, h:6,            // track width multiplier and thickness at zoom 1
  gap:2.5, padX:4, padY:1.5,   // gap between tracks; frame padding, split per axis
  lift:1,                 // multiplier on every "height above the entity"
  scale:true,             // track camera zoom
  minScale:.6, maxScale:1.8,
  text:9, textMin:7, textMax:15,
};
const barScale = () =>
  BARS.scale ? clamp(state.camera.zoom, BARS.minScale, BARS.maxScale) : 1;

const bar = (x, y, hpx, frac, wpx, _back, fill="#d39a3d") =>
  marks(x, y, hpx, wpx, [{frac, fill}]);
function label(text, x, y, hpx, color="#f1dfb7", size=BARS.text){
  const p = project(x, y, hpx*BARS.lift);
  if(p.depth>1)return;
  const s = clamp(size*barScale(), BARS.textMin, BARS.textMax);
  ctx.font = "bold "+s.toFixed(1)+"px monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#17120dcc"; ctx.fillText(text, p.x+1, p.y+1);
  ctx.fillStyle = color; ctx.fillText(text, p.x, p.y);
}

// ── delivery readout, shared by blueprints and upgrades ─────────────────────
const RES_ABBR = {wood:"w", stone:"s", dust:"d", coin:"◉", diamond:"◆"};
/** "w 2/8  s 0/10  ◆ 0/1" — what's in versus what's needed. */
function costLine(cost, delivered){
  return RESOURCE_KINDS.filter(k=>(cost[k]||0)>0)
    .map(k=>RES_ABBR[k]+" "+Math.min(delivered[k]||0,cost[k])+"/"+cost[k]).join("  ");
}
function costProgress(cost, delivered){
  let need=0, got=0;
  for(const k of RESOURCE_KINDS){
    const c = cost[k]||0;
    need += c; got += Math.min(delivered[k]||0, c);
  }
  return need ? got/need : 1;
}
/** One presentation for every "carry resources here" job: name, bar, tally. */
function drawDelivery(x, y, name, cost, delivered, accent="#d4a443"){
  label(name, x, y, 60);
  bar(x, y, 47, costProgress(cost,delivered), 58, "#292119", accent);
  label(costLine(cost,delivered), x, y, 34, "#e8dcbc", 8.5);
}

function drawOverlay(){
  // Draw in 960x540 space; the transform scales it up to device pixels crisply.
  ctx.setTransform(overlayScale,0,0,overlayScale,0,0);
  ctx.clearRect(0,0,VIEW_W,VIEW_H);

  // Night lighting, screen space, exactly as before.
  if(state.clock.light>0){
    ctx.fillStyle = "rgba(12,28,67,"+state.clock.light+")";
    ctx.fillRect(0,0,VIEW_W,VIEW_H);
  }
  drawNightTelegraph();

  // Health only. Swing progress lives in the action badge now (drawActionBadge),
  // so a node you are cutting shows its remaining yield here and the fill of the
  // current hit down on the badge — one piece of feedback each, never both.
  // Auto-hide is unchanged: a full-health thing carries no mark at all.
  const rowsFor = (frac, fill) => frac < 1 ? [{frac, fill}] : [];

  // Widths keep each track near the reference's ~9:1 ratio; the frame padding
  // adds height, so a narrow track reads as a squat blob rather than a bar.
  for(const t of trees)
    if(t.stump<=0) marks(t.x,t.y,58,52, rowsFor(t.hp/t.max, css(PAL.hpGood)));
  for(const r of rocks)
    if(r.depleted<=0) marks(r.x,r.y,34,46, rowsFor(r.hp/r.max, "#bcbab3"));
  for(const n of diamonds)
    if(n.depleted<=0) marks(n.x,n.y,38,46, rowsFor(n.hp/n.max, css(PAL.diamond)));
  for(const e of state.enemies){
    const s = ENEMY_TYPES[e.type].size;
    marks(e.x,e.y,28*s,Math.round(40*s), rowsFor(e.hp/e.max, "#c65343"));
  }
  for(const w of state.workers)
    if(w.hp<WORKER_HP) bar(w.x,w.y,30,w.hp/WORKER_HP,40,null,css(PAL.hpGood));
  if(state.baseHp<state.baseMax) bar(BASE.x,BASE.y,84,state.baseHp/state.baseMax,90,null,css(PAL.bad));

  for(const b of buildings){
    // Blueprints and upgrades are the same job — carry resources here — so they
    // share one name / bar / tally stack instead of two invented formats.
    if(!b.complete){
      drawDelivery(b.x, b.y, BUILDING_TYPES[b.type].name, buildingCost(b), b.delivered);
      if(b.starved) label("! starved", b.x, b.y, 22, "#e08a76");
      continue;
    }
    if(b.type==="tower" && b.tower && b.tower.hp<b.tower.maxHp)
      bar(b.x,b.y,56,b.tower.hp/b.tower.maxHp,52,null,css(PAL.hpGood));
    if(b.activeUpgrade){
      const job = b.activeUpgrade;
      const up = towerUpgradeList().find(i=>i.id===job.id) || UPGRADES.find(i=>i.id===job.id);
      if(up) drawDelivery(b.x, b.y, up.name, up.cost, job.delivered, css(PAL.arcane));
    }
  }

  // Last world-anchored mark, so the badge sits over the bars it shares a target
  // with; the cursor's carry count still draws on top of everything.
  drawActionBadge();
  drawCarryCount();
}

/**
 * Preview read of what a held left click would hit right now — or null.
 * Pure pass-through to resolvePrimaryAction(), the single authority the
 * simulation swings with, so the ring (and any later tool icon, via the
 * returned .kind / .icon) can never point at something the sim would not hit.
 */
function chopTarget(){
  const m = state.mouse;
  if(!m.inside) return null;
  return resolvePrimaryAction(m.x,m.y);
}
// Sits ON the node (mid-canopy for a tree) rather than floating above it.

function roundPath(x, y, w, h, r){
  ctx.beginPath();
  if(ctx.roundRect){ ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r); ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r); ctx.arcTo(x,   y,   x+w, y,  r);
  ctx.closePath();
}

/**
 * One rounded frame holding N stacked tracks. Callers today pass a single
 * health row (see drawOverlay's rowsFor); the stack stays generic so any second
 * per-entity track lands inside the same frame rather than as a loose mark
 * floating at its own height.
 */
function stackedBars(px, py, rows, w, k){
  if(!rows.length) return;
  const rowH = BARS.h*k;
  const gap  = BARS.gap*k;
  const padX = BARS.padX*k, padY = BARS.padY*k;
  const innerH = rows.length*rowH + (rows.length-1)*gap;
  const boxW = w + padX*2, boxH = innerH + padY*2;
  const bx = px - boxW/2, by = py - boxH/2;

  roundPath(bx, by, boxW, boxH, Math.min(boxH/2, rowH*1.4));
  ctx.fillStyle = "rgba(36,31,22,.86)"; ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5*k);
  ctx.strokeStyle = "#efe6cd"; ctx.stroke();

  rows.forEach((row, i)=>{
    const ry = by + padY + i*(rowH+gap);
    roundPath(bx+padX, ry, w, rowH, rowH/2);
    ctx.fillStyle = "rgba(12,10,7,.5)"; ctx.fill();
    const fw = w*clamp(row.frac, 0, 1);
    if(fw > rowH*0.35){
      roundPath(bx+padX, ry, fw, rowH, rowH/2);
      ctx.fillStyle = row.fill; ctx.fill();
    }
  });
}

/** Project an entity and draw its stacked marks above it. */
function marks(x, y, hpx, wpx, rows){
  if(!rows.length) return;
  const p = project(x, y, hpx*BARS.lift);
  if(p.depth>1) return;
  const k = barScale();
  stackedBars(p.x, p.y, rows, wpx*BARS.wMul*k, k);
}

// ── primary-action badge ────────────────────────────────────────────────────
// A tool silhouette pinned under whatever a held left click would work on, so
// "what does clicking here do?" is answered before the swing starts. Drawn on
// the screen-facing overlay like every other mark, so no camera pitch or yaw
// can skew it, and purely decorative: hit-testing is world-space (groundFromEvent)
// and never consults the canvas, so the badge cannot swallow a click.
// box / drop / icon / fill alpha below are debugger-owned presentation state:
// the view panel's "bars > action badge" sliders write them live (see bindV
// calls near vBarScale). Nothing here feeds targeting, cadence, or the resolver.
const BADGE = {
  box:19,       // frame side, overlay px at zoom 1            [slider vBadgeBox]
  drop:15,      // px below the target's ground point — its lower/front edge on screen
                //                                             [slider vBadgeDrop]
  icon:15,      // silhouettes are authored in a 20x20 box, drawn at this size.
                // Rides vBadgeBox at the authored 15:19 ratio so resizing the
                // frame never leaves the tool rattling around or spilling out.
  edgePad:5,    // margin kept when a badge is clamped against the viewport
  // Held-action fill: the badge IS the swing bar now, rising bottom-to-top.
  // Cool and translucent on purpose — it reads as clearly "not empty" against the
  // badge's dark ground while staying darker than both tool inks (steel #bdb7ab,
  // haft #9a774d), so the silhouette on top of it never loses contrast. Drawn
  // above the night tint like every other overlay mark, so day and night look
  // identical rather than the fill dimming out after dusk.
  fillRGB:"84,170,214",             // hue is fixed art direction, alpha is tunable
  fill:"rgba(84,170,214,.3)",       // rebuilt from fillRGB [slider vBadgeFill]
};
// Authored icon:frame ratio, captured before any slider can move either one.
const BADGE_ICON_RATIO = BADGE.icon / BADGE.box;
// Zoom scaling follows BARS exactly (barScale()), so the badge grows and shrinks
// in step with the bars above it and the debug sliders steer both.

const ICON_STEEL = css(PAL.metal), ICON_WOOD = css(PAL.blueprint);
/**
 * Tool silhouettes keyed by resolvePrimaryAction()'s icon id — the resolver
 * names the tool, this table draws it, and nothing else decides which is which.
 * Each entry paints inside a 20x20 box centred on the current origin (y down);
 * drawBadge() supplies the translate/scale so one path set serves any size.
 * Canvas primitives only: no glyphs, no fonts, no external art to load.
 */
const ACTION_ICONS = {
  axe(){                                        // trees
    ctx.lineCap="round"; ctx.lineJoin="round";
    ctx.strokeStyle=ICON_WOOD; ctx.lineWidth=2.6;
    ctx.beginPath(); ctx.moveTo(2.2,-6.4); ctx.lineTo(-3.0,8.6); ctx.stroke();   // haft
    ctx.fillStyle=ICON_STEEL;                                                    // bit, drawn over the haft top
    ctx.beginPath();
    ctx.moveTo(0.6,-8.2);
    ctx.quadraticCurveTo(5.4,-8.8, 8.0,-5.8);       // shoulder
    ctx.quadraticCurveTo(9.6,-2.0, 6.4,1.6);        // cutting edge, bulged out
    ctx.quadraticCurveTo(4.0,-1.8, 0.0,-2.2);       // concave underside back to the haft
    ctx.closePath(); ctx.fill();
  },
  pickaxe(){                                    // rocks and diamond deposits
    ctx.lineCap="round"; ctx.lineJoin="round";
    ctx.strokeStyle=ICON_WOOD; ctx.lineWidth=2.6;
    ctx.beginPath(); ctx.moveTo(0,-5.4); ctx.lineTo(0,8.8); ctx.stroke();        // haft
    ctx.fillStyle=ICON_STEEL;                                                    // head: one crescent tapering to two points
    ctx.beginPath();
    ctx.moveTo(-9.4,0.8);
    ctx.quadraticCurveTo(-6.2,-8.0, 0,-8.4);
    ctx.quadraticCurveTo( 6.2,-8.0, 9.4,0.8);
    ctx.quadraticCurveTo( 5.4,-3.4, 0,-4.4);
    ctx.quadraticCurveTo(-5.4,-3.4, -9.4,0.8);
    ctx.closePath(); ctx.fill();
  },
  sword(){                                      // enemies
    ctx.lineJoin="round";
    ctx.fillStyle=ICON_STEEL;                                                    // blade, point up
    ctx.beginPath();
    ctx.moveTo(0,-9.5); ctx.lineTo(2.2,-5.6); ctx.lineTo(2.2,1.6);
    ctx.lineTo(-2.2,1.6); ctx.lineTo(-2.2,-5.6); ctx.closePath(); ctx.fill();
    roundPath(-6.4,1.6,12.8,2.4,1.2); ctx.fill();                                // crossguard
    ctx.beginPath(); ctx.arc(0,8.6,1.4,0,Math.PI*2); ctx.fill();                 // pommel
    ctx.fillStyle=ICON_WOOD;
    roundPath(-1.5,4.0,3.0,4.0,1.4); ctx.fill();                                 // grip
  },
};

/**
 * Compact frame + silhouette, centred on (px,py) in 960x540 overlay space.
 * @param fill 0..1 of the held action already served — the badge doubles as the
 *   swing bar, so this rises bottom-to-top inside the frame. 0 draws an empty badge.
 */
function drawBadge(px, py, iconId, k, fill){
  const paint = ACTION_ICONS[iconId];
  if(!paint) return;                          // unknown tool: draw nothing, never a blank box
  const box = BADGE.box*k, half = box/2, r = Math.min(half, 5*k);
  ctx.save();
  // Same dark-fill / light-rim treatment as stackedBars, so the two marks on one
  // target read as one family rather than two invented widgets.
  roundPath(px-half, py-half, box, box, r);
  ctx.fillStyle = "rgba(36,31,22,.86)"; ctx.fill();
  // Progress rises inside that same rounded interior: clipped to it, so the fill
  // can never square off the corners or bleed past the rim, and painted BEFORE the
  // rim and the icon — the stroke below always runs at one width and one colour
  // whatever the fraction, and the silhouette always sits on top of the fill.
  const frac = clamp(fill || 0, 0, 1);
  if(frac > 0){
    ctx.save();
    ctx.clip();                               // the rounded frame path, still current
    ctx.fillStyle = BADGE.fill;
    ctx.fillRect(px-half, py+half - box*frac, box, box*frac);
    ctx.restore();
  }
  roundPath(px-half, py-half, box, box, r);   // rebuilt: clip() left the path implicit
  ctx.lineWidth = Math.max(1, 1.5*k); ctx.strokeStyle = "#efe6cd"; ctx.stroke();
  ctx.translate(px, py);
  const s = BADGE.icon*k/20;                  // icon design space is 20 units wide
  ctx.scale(s, s);
  paint();
  ctx.restore();
}

/**
 * The action the badge advertises, or null when it must stay dark.
 * Reads chopTarget() -> resolvePrimaryAction(), the one authority the press
 * arms, so an enemy standing on a tree previews the sword the click swings.
 */
function badgeAction(){
  if(state.paused || state.gameOver || modalOpen()) return null;  // pause, loss, modal UI
  if(state.camera.panning) return null;                           // middle-mouse drag
  if(state.heldObject) return null;                               // carrying a worker or building
  const action = chopTarget();                                    // null once the cursor leaves the canvas
  if(!action) return null;
  // Placement mode swallows the press for harvesting but not for a swing:
  // leftClick() resolves an attack before it ever looks at state.buildMode.
  if(state.buildMode && action.kind !== "attack") return null;
  return action;
}
function drawActionBadge(){
  const action = badgeAction();
  if(!action) return;
  const t = action.target;
  const p = project(t.x, t.y, 0);      // ground point = the model's lower/front edge on screen
  if(p.depth > 1) return;              // behind the camera
  const k = barScale();
  const half = BADGE.box*k/2 + BADGE.edgePad*k;
  // Visible height from the live backing store, so clamping still lands inside
  // the frame on aspects other than the authored 16:9.
  const viewH = canvas.height/overlayScale || VIEW_H;
  // Read-only view of the sim's one hold timer — nothing is advanced here.
  // It shows only while the button is down on the very thing chopState is timing,
  // so hovering before the press draws an empty badge, and an early release, a
  // pointer leave, a modal, or a swap to another target has already zeroed or
  // dropped chopState by the time this frame draws. A completed hit rolls the
  // timer back to 0 itself, which empties the badge for the next repeat while the
  // button stays held. Steady Hand needs nothing here: it multiplies chopState.t.
  const filling = state.primaryClick.held && chopState.target === action.target;
  drawBadge(clamp(p.x, half, VIEW_W-half),
            clamp(p.y + BADGE.drop*k, half, viewH-half),
            action.icon, k, filling ? chopProgress() : 0);
}

/** The pile itself is 3D; only the "n/5" readout stays flat. */
function drawCarryCount(){
  const total = carriedTotal();
  if(!total || !state.mouse.inside) return;
  const p = project(state.mouse.x, state.mouse.y, 0);
  if(p.depth>1) return;
  const full = total >= state.capacity;
  ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#17120dcc"; ctx.fillText(total+"/"+state.capacity, p.x+1, p.y+15);
  ctx.fillStyle = full ? "#e8926f" : "#f1dfb7";
  ctx.fillText(total+"/"+state.capacity, p.x, p.y+14);
}

function drawWarningEdge(side,alpha){
  const thickness=18;ctx.fillStyle="rgba(202,72,48,"+alpha+")";
  if(side===MAP_SIDE.NORTH)ctx.fillRect(0,0,VIEW_W,thickness);
  else if(side===MAP_SIDE.SOUTH)ctx.fillRect(0,VIEW_H-thickness,VIEW_W,thickness);
  else if(side===MAP_SIDE.WEST)ctx.fillRect(0,0,thickness,VIEW_H);
  else ctx.fillRect(VIEW_W-thickness,0,thickness,VIEW_H);
}
function drawNightTelegraph(){
  const clock=state.clock,wave=state.nightWave,side=wave.upcomingSide,recipe=wave.upcomingRecipe;
  if(clock.phase!=="day"||clock.remaining>NIGHT_TELEGRAPH_TIME||!side||!recipe)return;
  const alpha=.42+Math.sin(clock.remaining*5)*.14,secondary=recipe.id==="twoFront"?oppositeMapSide(side):null;
  drawWarningEdge(side,alpha);if(secondary)drawWarningEdge(secondary,alpha);
}

// ─────────────────────────────────────────────────────────── interaction rings
/**
 * The ONE gameplay radius a building (or a build-menu type) advertises, in sim pixels, or null when
 * it has none. Single source for every radius indicator — placement preview, relocation preview and
 * hover all call this, so they can never disagree about what a type covers.
 *
 * `building` is optional: pass the live building to read its own state, omit it for a menu type that
 * has not been placed yet. Towers resolve through towerRadius() -> towerVariant(), whose own fallback
 * is TOWER_VARIANTS.basic — exactly the chassis a fresh placement builds, so an omitted building
 * yields the basic chassis's range without restating it. Everything else reports its service radius
 * (lumber/quarry/stockpile) or its effect radius (blast/landmine/tar) straight from BUILDING_TYPES.
 * Types with neither — house, obelisk, spikes — return null and get NO ring: an indicator is
 * only ever drawn for coverage the simulation actually has.
 */
function indicatorRadius(type, building=null){
  if(type==="tower") return towerRadius(building || {}) || null;
  const def = BUILDING_TYPES[type];
  return def?.serviceRadius || def?.effectRadius || null;
}

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
let SEL_PREVIEW = SEL_PREVIEW_MODES.OFF;   // written by bindV("vSelPreview") and by nothing else

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

// How close the cursor must be to a completed building with no button of its own before it counts as
// hovered. Same number the plain hover rings used before the segmented mark replaced them.
const HOVER_BUILDING_RANGE = 48;
/**
 * The ONE completed building the cursor is currently acting on, or null. Single authority for the
 * hover mark: drawZones() calls it once a frame and draws exactly what it returns, so two neighbouring
 * 1x1 structures can never both light up and no distance test lives anywhere else.
 *
 * Priority is leftClick()'s chain first, then hoverTarget()'s right-click delivery pass, in each of
 * their own orders — so the mark always names whatever a press would really act on, never something
 * merely nearby. hoverTarget()'s two non-building outcomes (the base drop zone, an unfinished
 * blueprint) return null: the cursor is committed elsewhere, and neither is a completed building.
 *
 * Render-only and stateless: it reads live `buildings` every frame and keeps no reference between
 * frames, so a building that is destroyed, detonated, picked up, replaced by completion or retyped by
 * an upgrade simply stops being returned and the claim-per-frame pools hide its mark on that frame.
 */
function hoveredBuilding(){
  // Every suppression badgeAction() owns, plus placement — a ghost already draws its own mark there.
  if(state.paused || state.gameOver || modalOpen()) return null;
  if(state.camera.panning || state.heldObject || state.buildMode) return null;
  const m = state.mouse;
  if(!m.inside) return null;
  // ── leftClick()'s order: blast, manual tower, obelisk menu, tower menu, stockpile pull ──
  const blast = buildings.find(b=>b.complete && b.type==="blast" && blastButtonHit(b,m.x,m.y));
  if(blast) return blast;
  const manualTower = buildings.find(b=>b.complete && b.type==="tower" && towerVariant(b).manual && manualTowerButtonHit(b,m.x,m.y));
  if(manualTower) return manualTower;
  const obelisk = buildings.find(b=>b.complete && b.type==="obelisk" && upgradeButtonHit(b,m.x,m.y));
  if(obelisk) return obelisk;
  const tower = buildings.find(b=>b.complete && b.type==="tower" && b.tower.variant==="basic" && !b.activeUpgrade && upgradeButtonHit(b,m.x,m.y));
  if(tower) return tower;
  const pile = buildings.find(b=>b.complete && b.type==="stockpile" && distance(m.x,m.y,b.x,b.y)<38);
  if(pile) return pile;
  // ── hoverTarget()'s order: base first, then one pass over buildings with its three branches ──
  if(distance(m.x,m.y,BASE.x,BASE.y)<BASE.r+16) return null;
  for(const b of buildings){
    if(!b.complete && distance(m.x,m.y,b.x,b.y)<38) return null;          // blueprint owns the cursor
    if(b.complete && b.type==="stockpile" && distance(m.x,m.y,b.x,b.y)<42) return b;
    if(b.complete && (b.type==="obelisk"||b.type==="tower") && b.activeUpgrade && upgradeButtonHit(b,m.x,m.y)) return b;
  }
  // ── plain proximity, for everything with no button and no delivery role ──
  // NEAREST wins, not first-in-array: deployables may sit in touching cells (see canPlace), so their
  // hover circles overlap and picking the closest is what keeps the answer single.
  let near = null, best = HOVER_BUILDING_RANGE;
  for(const b of buildings){
    if(!b.complete) continue;
    const d = distance(m.x,m.y,b.x,b.y);
    if(d<best){ best = d; near = b; }
  }
  return near;
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
  if(!m.inside || state.paused || state.gameOver || modalOpen()) return null;
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
  if(SHOW_VACUUM_RING && state.collecting && m.inside)
    ring(m.x, m.y, VACUUM_RADIUS, css(PAL.ok), .45 + Math.sin(t*6)*.18);

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
  // endRings()/endSelectors()/endRadiusRings() run in draw(), after drawAttacks() claims its rings.
}

// ─────────────────────────────────────────────────────────── frame
function draw(){
  if(view.orbit){ view.yaw = (view.yaw + .25) % 360; syncViewInputs(); }
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
  // draw() runs even while paused / in a modal, so a suppressed selector is always cleared next frame.
  endSelectors();
  endRadiusRings();
  // Visibility stat + occluded pins. Throttled: it raycasts every clickable thing.
  if(++frameTick % 15 === 0) measureNow();
  renderer.render(scene, camera3);
  drawOverlay();
  if(scanPending){ scanPending=false; runScan(); }
}
let frameTick = 0, lastDrawT = 0;


// ═══════════════════════════════════════════════════════════════════════════
// VIEW DEBUGGER
// Ported from prototype-3d. Tabs are generated from the panes, so adding a
// section means adding a <section class="pane" data-tab="..."> and nothing else.
//
// Tab ownership (same order as the panes, and as the binding groups below):
//   camera / visibility / input / overlays / selectors — view + presentation only.
//   gameplay — the deliberate exception: it drives the simulation. Its switches
//              write DBG (see that object's rule: never authored data) and its
//              buttons call the same entry points play does. Its bindings are the
//              last group in this file, under the GAMEPLAY PANE banner.
// bindV() covers range / checkbox / select; bindBtn() covers plain buttons.
// ═══════════════════════════════════════════════════════════════════════════

const $v = id => document.getElementById(id);
let scanData = [], scanTimer = 0, scanPending = false;

const vPanes = [...document.querySelectorAll("#vPanes .pane")];
function showVTab(name){
  for(const p of vPanes) p.classList.toggle("on", p.dataset.tab===name);
  for(const b of $v("vTabs").children) b.classList.toggle("on", b.dataset.tab===name);
  $v("vPanes").scrollTop = 0;
  try{ localStorage.setItem("wd3d.tab", name); }catch{}
}
vPanes.forEach((p,i)=>{
  const b = document.createElement("button");
  b.textContent = p.dataset.tab; b.dataset.tab = p.dataset.tab; b.title = "shift+"+(i+1);
  b.addEventListener("click", ()=>showVTab(p.dataset.tab));
  $v("vTabs").appendChild(b);
});
(function initTab(){
  // A stored name from an older layout (sightlines/pickup/bars) no longer
  // matches a pane, so fall back to camera — the first pane, by design.
  let first = vPanes.some(p=>p.dataset.tab==="camera") ? "camera" : vPanes[0]?.dataset.tab;
  try{ const s = localStorage.getItem("wd3d.tab"); if(vPanes.some(p=>p.dataset.tab===s)) first = s; }catch{}
  showVTab(first);
})();

$v("vToggle").addEventListener("click", ()=>{
  const on = $v("viewPanel").classList.toggle("collapsed");
  $v("vToggle").textContent = on ? "view ▸" : "view ▾";
});

// Binds one control to one presentation field. Three control shapes: range (numeric), checkbox
// (boolean) and <select> (numeric, from the option's value — so `apply` always sees a number and
// callers never branch on the widget). The o_<id> readout span is optional; a <select> already shows
// its own label, so those omit it.
function bindV(id, apply, fmt){
  const el = $v(id), out = $v("o_"+id), select = el.tagName === "SELECT";
  // Browsers restore form-control values across a reload, so a slider left at
  // some test value keeps applying it while the markup still reads its default.
  // Markup wins on load; that is the only way these stay predictable.
  if(el.type === "checkbox") el.checked = el.hasAttribute("checked");
  // Same rule for a <select>: the option carrying the `selected` attribute wins over whatever the
  // browser restored, and with none marked the first option is the default.
  else if(select) el.selectedIndex = Math.max(0, [...el.options].findIndex(o=>o.hasAttribute("selected")));
  else if(el.hasAttribute("value")) el.value = el.getAttribute("value");
  const run = ()=>{
    const v = el.type==="checkbox" ? el.checked : +el.value;
    apply(v);
    if(out) out.textContent = fmt ? fmt(v) : v;
  };
  el.addEventListener(el.type==="checkbox"||select ? "change" : "input", run);
  run();
}

bindV("vPitch", v=>{ view.pitch=v; placeCamera(); drawScan(); updateReadout(); }, v=>v+"°");
bindV("vYaw",   v=>{ view.yaw=v; placeCamera(); scheduleScan(); updateReadout(); }, v=>v+"°");
bindV("vZoom",  v=>{ state.camera.zoom=v; clampCamera(); placeCamera(); updateReadout(); }, v=>v.toFixed(2));
bindV("vFov",   v=>{ view.fov=v; placeCamera(); updateReadout(); }, v=>v+"°");
bindV("vOrtho", v=>{ view.ortho=v; camera3 = v?ortho:persp; resizeRenderer(); scheduleScan(); updateReadout(); });
bindV("vOrbit", v=>{ view.orbit=v; });
bindV("vHeight",v=>{ view.heightScale=v; scheduleScan(); updateReadout(); }, v=>v+"%");
bindV("vShadow",v=>{ renderer.shadowMap.enabled=v; scene.traverse(o=>{ if(o.isMesh) o.material.needsUpdate=true; }); });
bindV("vPins",  v=>{ view.ghostPins=v; });

// ── pickup / harvest: these drive real simulation constants, not just visuals ──
bindV("vCap",   v=>{ state.capacity=v; },      v=>v);
bindV("vRadius",v=>{ VACUUM_RADIUS=v; },       v=>v+"px");
bindV("vRate",  v=>{ SUCK_RATE=v/1000; },      v=>v+"ms");
bindV("vArc",   v=>{ HAND_ARC=v; },            v=>v.toFixed(1));
bindV("vRing",  v=>{ SHOW_VACUUM_RING=v; });
bindV("vChopT", v=>{ CHOP_TIME=v/1000; },      v=>(v/1000).toFixed(2)+"s");
bindV("vShotSpeed", v=>{ SHOT_SPEED=v; },      v=>v+" u/s");
bindV("vShotArc",   v=>{ SHOT_ARC=v; },        v=>v.toFixed(1)+"x");
bindV("vShotSize",  v=>{ SHOT_SIZE=v; },       v=>v.toFixed(1)+"x");
bindV("vOutline",   v=>{ setOutlines(v); });
bindV("vOutlineW",  v=>{ outlineMat.uniforms.thickness.value=v; }, v=>v.toFixed(3));
// ── ground selectors: presentation only, see the IND block by showSelector() ──
// Owned by the `selectors` pane (see the tab-ownership list above #vPanes; this block and that pane
// are the two halves of the same concern and nothing else should write IND).
// These write IND fields and nothing else. Footprints (buildingFootprint) and gameplay radii
// (indicatorRadius) are read from the simulation on the frame they are drawn and are never touched
// here, so no slider position can change where a building lands or how far a tower shoots.
bindV("vSelPulse",   v=>{ IND.pulseAmt=v; },    v=>v.toFixed(3));
bindV("vSelSpeed",   v=>{ IND.pulseSpeed=v; },  v=>v.toFixed(1)+" rad/s");
bindV("vSelThick",   v=>{ IND.thick=v; },       v=>v.toFixed(2));
bindV("vSelOpacity", v=>{ IND.cornerOpacity=v; }, v=>v.toFixed(2));
bindV("vRingOpacity",v=>{ IND.ringOpacity=v; }, v=>v.toFixed(2));
bindV("vSelFollow",  v=>{ IND.follow=v; },      v=>v>=1?"snap":v.toFixed(2));
// The one control here that is not a style knob: it draws sample marks (drawSelectorPreview) instead
// of restyling the live ones, and it stays render-only — see the comment on that function.
bindV("vSelPreview", v=>{ SEL_PREVIEW=v; });

bindV("vYield", v=>{ CHOP_YIELD=v; },          v=>v+"x");
bindV("vDamage",v=>{ CLICK_DAMAGE=v; },        v=>v+" hp");

// ── overlay bar sizing / placement ──
bindV("vBarScale",v=>{ BARS.scale=v; });
bindV("vBarMin",  v=>{ BARS.minScale=v; }, v=>v.toFixed(2)+"x");
bindV("vBarMax",  v=>{ BARS.maxScale=v; }, v=>v.toFixed(1)+"x");
bindV("vBarW",    v=>{ BARS.wMul=v; },     v=>v.toFixed(2)+"x");
bindV("vBarH",    v=>{ BARS.h=v; },        v=>v.toFixed(1)+"px");
bindV("vBarGap",  v=>{ BARS.gap=v; },      v=>v.toFixed(1)+"px");
bindV("vBarPadX", v=>{ BARS.padX=v; },     v=>v.toFixed(1)+"px");
bindV("vBarPadY", v=>{ BARS.padY=v; },     v=>v.toFixed(1)+"px");
bindV("vBarLift", v=>{ BARS.lift=v; },     v=>v.toFixed(2)+"x");
bindV("vBarText", v=>{ BARS.text=v; },     v=>v.toFixed(1)+"px");
bindV("vTextMin", v=>{ BARS.textMin=v; },  v=>v.toFixed(1)+"px");
bindV("vTextMax", v=>{ BARS.textMax=v; },  v=>v.toFixed(1)+"px");

// ── action badge: presentation only, drawn from the same barScale() as above ──
// Ranges are clamped in the markup so the badge stays legible, stays translucent
// enough to read the silhouette through, and stays pinned to its target.
bindV("vBadgeBox",  v=>{ BADGE.box=v; BADGE.icon=v*BADGE_ICON_RATIO; }, v=>v+"px");
bindV("vBadgeDrop", v=>{ BADGE.drop=v; },                              v=>v+"px");
bindV("vBadgeFill", v=>{ BADGE.fill="rgba("+BADGE.fillRGB+","+v+")"; }, v=>v.toFixed(2));

// ═══════════════════════════════════════════════════════════════════════════
// GAMEPLAY PANE
// The one pane whose controls reach into the simulation instead of a
// presentation bag. Every switch here writes a DBG field and nothing else;
// every button calls a normal gameplay entry point (completeBuilding,
// applyFinishedUpgrade, transitionPhase, spawnEnemy, spawnHouseWorker...).
// NOTHING in this block may mutate authored data: BUILDING_TYPES / UPGRADES /
// TOWER_VARIANTS costs and stats, ENEMY_TYPES, and NIGHT_WAVE_RECIPES are read
// only. The grant buttons are the sole writers of state.stored, and the free
// costs toggle deliberately is not one of them.
// ═══════════════════════════════════════════════════════════════════════════

/** Buttons, the shape bindV() does not cover (no value, no readout span). */
function bindBtn(id, fn){ $v(id).addEventListener("click", fn); }

/** Fill a <select> from data so the options can never drift from the tables. */
function fillSelect(id, items){
  $v(id).replaceChildren(...items.map(([value,label])=>{
    const o=document.createElement("option"); o.value=value; o.textContent=label; return o;
  }));
}

const DEBUG_GRANT=25;
function debugGrant(kinds){
  // A grant is an honest deposit into the base store, the same field dropToBase() writes.
  for(const kind of kinds) state.stored[kind]+=DEBUG_GRANT;
  state.basePulse=1; toast("granted "+DEBUG_GRANT+" "+kinds.join(" + ")); sound(520,.08);
}
/** Sweep anything already pending when free costs is switched on, so no blueprint or
 *  accepted upgrade can sit half-delivered under a toggle that says costs are free. */
function debugSweepFreeCosts(){
  if(!DBG.freeCosts) return;
  for(const building of [...buildings]) if(!building.complete) completeBuilding(building);
  for(const building of [...buildings]) if(building.activeUpgrade) applyFinishedUpgrade(building);
}
/** Phase buttons all go through transitionPhase(), never through clock.phase, so the
 *  night wave setup, chooseUpcomingNight() and the day-side forecast reset all run. */
function debugGoToPhase(phase){
  if(state.clock.phase!==phase) transitionPhase();
  syncPhaseHud();
}
function debugAdvancePhase(){ transitionPhase(); syncPhaseHud(); }
/** Start the chosen recipe's wave immediately: force night through the real transition
 *  (which does the side/telegraph bookkeeping), then hand the schedule this recipe with
 *  its first spawn already due. The recipe object itself is never modified. */
function debugStartWave(id){
  const recipe=NIGHT_WAVE_RECIPES.find(item=>item.id===id); if(!recipe) return;
  if(state.clock.phase!=="night") transitionPhase();
  const wave=state.nightWave;
  wave.activeRecipe=recipe;
  wave.activeSide??=MAP_SIDES[(Math.random()*MAP_SIDES.length)|0];
  wave.secondarySide=recipe.id==="twoFront"?oppositeMapSide(wave.activeSide):null;
  wave.remainingSpawns=NIGHT_WAVE_SPAWNS; wave.elapsed=0; wave.nextSpawnAt=0;
  syncPhaseHud(); toast("debug wave: "+recipe.id);
}
/** Debug removal, not a kill: no dust roll, no defeat toast — just the same status and
 *  retaliation teardown killEnemy() does so nothing keeps a reference to a gone enemy. */
function debugClearEnemies(){
  const count=state.enemies.length;
  for(const enemy of state.enemies){ enemy.status={burn:null,slow:null}; enemy.retaliationTower=null; burst(enemy.x,enemy.y,"#4b3b50",6); }
  state.enemies.length=0;
  toast("cleared "+count+" enemies");
}
function debugHealAll(){
  state.baseHp=state.baseMax;
  for(const building of [...buildings,heldBuilding()]) if(building?.tower){ const variant=towerVariant(building); building.tower.maxHp=variant.maxHp; building.tower.hp=variant.maxHp; }
  for(const worker of state.workers) worker.hp=WORKER_HP;
  const held=heldWorker(); if(held) held.hp=WORKER_HP;
  toast("healed base, towers and workers"); sound(780,.12);
}

fillSelect("vEnemyType", Object.entries(ENEMY_TYPES).map(([id,def])=>[id,def.name]));
fillSelect("vWaveRecipe", NIGHT_WAVE_RECIPES.map(recipe=>[recipe.id,recipe.id]));

// economy — free costs bypasses the DELIVERY, it does not zero a cost or top up a store.
bindV("vFreeCosts", v=>{ DBG.freeCosts=v; debugSweepFreeCosts(); });
bindV("vUnlimitedCharges", v=>{ DBG.unlimitedCharges=v; syncBuildHud(); });
bindBtn("vGrantAll",     ()=>debugGrant(RESOURCE_KINDS));
bindBtn("vGrantDust",    ()=>debugGrant(["dust"]));
bindBtn("vGrantCoin",    ()=>debugGrant(["coin"]));
bindBtn("vGrantDiamond", ()=>debugGrant(["diamond"]));

// time — game speed moved here from the input pane; id, range, default, format unchanged.
bindV("vSpeed", v=>{ GAME_SPEED=v; },          v=>v+"x");
bindBtn("vStartDay",     ()=>debugGoToPhase("day"));
bindBtn("vStartNight",   ()=>debugGoToPhase("night"));
bindBtn("vAdvancePhase", debugAdvancePhase);

// combat — spawnEnemy() carries no phase guard of its own (night-only spawning lives in
// the sim loop's updateNightEnemyWave), so a debug spawn needs no bypass; it is a direct
// call with a random edge, exactly like the daytime spawner used to make.
bindBtn("vSpawnEnemy",   ()=>spawnEnemy(null,$v("vEnemyType").value));
bindBtn("vStartWave",    ()=>debugStartWave($v("vWaveRecipe").value));
bindBtn("vClearEnemies", debugClearEnemies);
bindV("vInvulnBase", v=>{ DBG.invulnBase=v; });

// population
bindV("vInstantWorkers", v=>{ DBG.instantWorkers=v; });
bindBtn("vHealAll", debugHealAll);

$v("vRescan").addEventListener("click", ()=>runScan());

/** Push programmatic camera changes (orbit, wheel zoom) back into the sliders. */
function syncViewInputs(){
  $v("vYaw").value = Math.round(view.yaw);  $v("o_vYaw").textContent = Math.round(view.yaw)+"°";
  $v("vZoom").value = state.camera.zoom;    $v("o_vZoom").textContent = state.camera.zoom.toFixed(2);
}

// ─────────────────────────────────────────────── visibility measurement
const occRay = new THREE.Raycaster();
const _sp = new THREE.Vector3();

/** Every live thing the player can click, with the height to sight to. */
function subjects(){
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
function blockerMeshes(){
  const out = [];
  scene.traverse(o=>{ if(o.isMesh && o.visible && o.castShadow) out.push(o); });
  return out;
}
function countVisible(list, blockers){
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

function measureNow(){
  const r = countVisible(subjects(), blockerMeshes());
  setPins(r.hidden);
  const pct = r.total ? Math.round(r.vis/r.total*100) : 100;
  $v("vStat").textContent = r.vis+"/"+r.total;
  const w = $v("vWarn");
  w.textContent = pct>=95 ? "✓" : "⚠ "+(100-pct)+"% hidden";
  w.className = pct>=95 ? "ok" : "warn";
}

function runScan(){
  scene.updateMatrixWorld(true);
  const list = subjects(), blockers = blockerMeshes(), saved = view.pitch;
  scanData = [];
  for(let p=15;p<=89;p+=3){
    view.pitch = p; placeCamera();
    const r = countVisible(list, blockers);
    scanData.push({p, pct: r.total ? r.vis/r.total : 1});
  }
  view.pitch = saved; placeCamera();
  drawScan(); updateReadout(); measureNow();
}
function scheduleScan(){ clearTimeout(scanTimer); scanTimer = setTimeout(()=>{scanPending=true;}, 260); }

function drawScan(){
  const c = $v("vScan"), g = c.getContext("2d"), Wd = c.width, Hd = c.height;
  const pad = 8, floor = Hd - pad - 16;
  g.clearRect(0,0,Wd,Hd);
  if(!scanData.length)return;
  const bw = (Wd-pad*2)/scanData.length;
  g.strokeStyle="#7d7458"; g.lineWidth=1;
  for(const f of [0,.5]){ const y = pad+(floor-pad)*f; g.beginPath(); g.moveTo(pad,y); g.lineTo(Wd-pad,y); g.stroke(); }
  scanData.forEach((d,i)=>{
    const h = (floor-pad)*d.pct;
    g.fillStyle = d.pct>=.999 ? "#6fa04f" : d.pct>=.92 ? "#d4a443" : "#c25a44";
    g.fillRect(pad+i*bw, floor-h, Math.max(bw-1.5,1), h);
  });
  const mx = pad + ((view.pitch-15)/3)*bw + bw/2;
  g.strokeStyle="#f1dfb7"; g.lineWidth=2;
  g.beginPath(); g.moveTo(mx,2); g.lineTo(mx,floor); g.stroke();
  g.fillStyle="#b3a684"; g.font="700 15px monospace"; g.textBaseline="top";
  g.fillText("15°",pad,floor+4);
  g.textAlign="right"; g.fillText("89°",Wd-pad,floor+4);
  g.textAlign="center"; g.fillStyle="#f1dfb7";
  g.fillText(Math.round(view.pitch)+"°", Math.min(Math.max(mx,30),Wd-34), floor+4);
  g.textAlign="left";
}
function updateReadout(){
  const clean = scanData.find(d=>d.pct>=.999);
  const here = scanData.find(d=>d.p>=view.pitch);
  $v("vReadout").textContent =
    "pitch  "+Math.round(view.pitch)+"°    yaw "+Math.round(view.yaw)+"°\n"+
    "zoom   "+state.camera.zoom.toFixed(2)+"   "+(view.ortho?"orthographic":"fov "+view.fov+"°")+"\n"+
    "height "+view.heightScale+"%"+(here?"   visible "+Math.round(here.pct*100)+"%":"")+"\n"+
    (clean ? "clean from "+clean.p+"° up" : "never fully clean");
}

// shift+digit switches tabs; plain digits stay free for the game.
addEventListener("keydown", e=>{
  if(!e.shiftKey)return;
  const n = "!@#$%^&*("./* shifted digits */indexOf(e.key);
  if(n>=0 && vPanes[n]){ showVTab(vPanes[n].dataset.tab); e.preventDefault(); }
});

// measureNow() is driven from draw() so the pins track moving things.
$v("vRestart").addEventListener("click", ()=>location.reload());
requestAnimationFrame(()=>{ resizeRenderer(); runScan(); });


// ── boot ──────────────────────────────────────────────────────────────
resizeRenderer();
syncBuildHud();syncPhaseHud();setBuildDockCategory(null);
let previous=performance.now();
function frame(now){
  const dt=Math.min(.033,(now-previous)/1000);previous=now;
  // Speed-up runs extra whole steps rather than stretching dt — a 3x-longer dt
  // would let enemies skip past melee range and break contact-damage checks.
  for(let i=0;i<GAME_SPEED;i++)update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
toast("left-hold a tree or rock to gather");
