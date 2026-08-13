// Owns all mutable gameplay and showcase state. Commands mutate it; render/UI queries only read it.
// update() dispatches to explicit normal/showcase pipelines; browser effects leave through connect().

import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,BUILD_MARGIN,
  GRID_COLS,
  FOOTPRINT_1x1,RESOURCE_FOOTPRINT,
  RESOURCE_KINDS,
  HOUSE_SLOTS,HOUSE_COST,HOUSE_COST_ESCALATION,WORKER_SPAWN_TIME,
  WORKER_LEASH,WORKER_MELEE,WORKER_SPEED,WORKER_HP,WORKER_DAMAGE,WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_CARRY,
  BUILDING_TYPES,UPGRADES,TOWER_VARIANTS,
  ENEMY_TYPES,MAP_SIDE,MAP_SIDES,WAVE_FRONT_SECONDARY,
  ENEMY_POOL,DAY_ENEMY_SPAWN,DAY_ENEMY_CAP,
  NIGHT_WAVE_SPAWNS,NIGHT_WAVE_WINDOW,NIGHT_ENEMY_CAP,NIGHT_WAVE_RECIPES,
  DAY_DURATION,NIGHT_DURATION,NIGHT_OVERLAY_ALPHA,LIGHT_FADE_TIME,
  KING,STEADY_HAND_RATE
} from "./data.js";
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCellBounds,footprintWorldRect,footprintInWorldBounds
} from "./grid.js";
// The authored skill graph: shape only. This module owns state.skillTree over it, never the nodes.
import {SKILL_NODES,SKILL_EDGES,SKILL_TREE_ROOT_ID,SKILL_NODES_BY_ID,SKILL_NEIGHBORS} from "./skill-tree-data.js";
// Authored showcase coordinates are immutable input; all live fixture objects remain owned here.
import {SHOWCASE_MANIFEST} from "./showcase-data.js";

// ── runtime-tunable gameplay constants ──────────────────────────────────────
// The view debugger REASSIGNS these while the game runs. An imported binding is
// read-only in the importing module, so a bare `export let CHOP_TIME` would make
// every slider a silent no-op (or a TypeError). They therefore live as fields of
// ONE exported mutable holder: the debugger writes TUNE.chopTime and every
// reader in here sees the new value on its next read, with no rebinding anywhere.
//
// Written by: src/debug/view-debugger.js bindings, and nothing else.
// Read by:    this module only (the presentational siblings — hand arc, vacuum
//             ring visibility, shot speed/arc/size — stay in the render layer as
//             VIEW_TUNE, because the simulation never reads them). The one
//             exception is TUNE.vacuumRadius, which the render layer also reads
//             so the drawn vacuum ring is literally collectDrop()'s reach, and
//             TUNE.gameSpeed, which the frame loop reads to count steps.
// Authored siblings that are NEVER written (STEADY_HAND_RATE) live in data.js.
export const TUNE = {
  chopTime:.7,       // seconds of held left-click per harvest hit   [slider vChopT]
  vacuumRadius:45,   // game px that collectDrop() sweeps            [slider vRadius]
  suckRate:.08,      // seconds between vacuum pickups               [slider vRate]
  chopYield:1,       // drops spawned per completed player chop      [slider vYield]
  clickDamage:1,     // hp removed per completed player swing        [slider vDamage]
  gameSpeed:1,       // whole simulation steps per rendered frame    [slider vSpeed]
};

// ── effect boundary ─────────────────────────────────────────────────────────
// The simulation never talks to the browser. Everything a player HEARS or SEES
// outside the world itself — toasts, sounds, the pause badge, the game-over
// card, the build HUD, the upgrade panel — leaves through this injected record,
// installed once by the adapter in src/main.js via connect().
//
// Invariant (producer end): every hook is optional and every default is a
// no-op, so this module imports and runs in bare node with no DOM. A hook may
// read simulation state but must never write it; the only way back in is a
// command exported below.
// Invariant (consumer end, restated in main.js): the adapter's implementations
// are called SYNCHRONOUSLY from inside commands and update(), in the exact
// command/update order, so feedback ordering is deterministic.
const NO_EFFECTS = {
  toast(){},                 // (message) player-facing notification line
  sound(){},                 // (freq, duration) one blip
  toastExpired(){},          // the toast timer reached zero this step
  afterUpdate(){},           // one whole simulation step finished
  gameOver(){},              // the base fell; the run is over
  pauseChanged(){},          // (paused)
  buildHudChanged(){},       // build dock buttons / stack counts / house cost moved
  buildDockChanged(){},      // (category) which dock category is open
  upgradeMenuOpened(){},     // state.upgradeMenu is populated; show and render the panel
  upgradeMenuClosed(){},     // state.upgradeMenu is cleared; hide the panel
  skillTreeOpened(){},       // state.skillTree.open went true; show the panel
  skillTreeChanged(){},      // the revealed/selected sets moved; repaint the panel
  skillTreeClosed(){},       // state.skillTree.open went false; hide the panel
  phaseHudChanged(){},       // a debug command jumped the clock; re-read the phase HUD
  isModalOpen(){return false;},   // does a modal currently own input?
};
let effects = NO_EFFECTS;
/** Install the adapter. Unlisted hooks keep their no-op default. */
export function connect(impl){ effects = {...NO_EFFECTS, ...impl}; return effects; }
/** Single funnel for audio, so no gameplay path touches an AudioContext. */
function sound(freq,duration){ effects.sound(freq,duration); }

// Harvesting is hold-to-fill rather than per-click, so it needs its own timer.
const chopState={target:null,kind:null,t:0};
function beginChop(hit){
  if(chopState.target===hit.target)return;
  chopState.target=hit.target;chopState.kind=hit.kind;chopState.t=0;
}
function resetChop(){chopState.target=null;chopState.kind=null;chopState.t=0;}
function chopProgress(){return chopState.target?clamp(chopState.t/TUNE.chopTime,0,1):0;}

const trees = [];
const rocks = [];
const diamonds = [];
const resourceDrops = [];
const buildings = [];
// ── Showcase resource ownership flow ──
// Written by: initializeRunMode()/rebuildShowcase() create and reset live sandbox fixtures.
// Read by:    combat below and the read-only render/UI consumers.
// Format:     dummies carry production-compatible combat status; props carry grid positions/footprints.
// Lifetime:   showcase initialization until rebuild or page reload; absent from normal mode.
const damageDummies = [];
const showcaseProps = [];
const showcaseLabelRecords=[];
let showcaseRevision=0;
// ── Worker corpse ownership flow ──
// Written by: killWorker() creates one immutable visual snapshot per final death.
// Read by:    draw() only; corpses never enter interaction, placement, targeting, or update systems.
// Format:     death position plus compact pose/clothing values; never a mutable Worker object.
// Lifetime:   page load until run restart; no decay or removal.
const workerCorpses = [];
const particles = [];
const state = {
  runMode:"normal",
  mouse:{x:W/2,y:H/2,inside:false},
  carried:{wood:0,stone:0,dust:0,coin:0,diamond:0}, stored:{wood:0,stone:0,dust:0,coin:0,diamond:0}, workers:[], enemies:[],
  baseHp:100,baseMax:100,gameOver:false,paused:false,dayEnemyTimer:DAY_ENEMY_SPAWN.min,coinTimer:6,basePulse:0,buildMode:null,buildDockCategory:null,capacity:5,toastTimer:0,collectCooldown:0,collecting:false,
  // elapsed: total simulated seconds this run. It accumulates the same dt the phase countdown
  // spends, so it is game time, not wall time — it does not advance while paused or after a loss,
  // and a raised game speed makes it run as fast as the phases do.
  clock:{phase:"day",remaining:DAY_DURATION,completedNights:0,light:0,elapsed:0},
  nightWave:{upcomingSide:null,upcomingRecipe:null,activeSide:null,secondarySide:null,activeRecipe:null,lastSides:[],remainingSpawns:0,elapsed:0,nextSpawnAt:0,nightNumber:0},
  camera:{x:BASE.x,y:BASE.y,zoom:1,panning:false,lastX:0,lastY:0}, keys:new Set(),
  upgradeMenu:{building:null,selected:null,kind:null},primaryClick:{held:false,audioCooldown:0},heldObject:null,showcaseFocus:null,buildStacks:{spikes:5,landmine:3,tar:3},
  // revealed: every node the player can SEE; selected: the subset taken, always a subset of it.
  // Two id sets over the frozen graph, written only by selectSkillNode() and read only by the
  // skill tree queries — the nodes have no cost and no effect, so nothing else consults them.
  // open: whether the skill-tree screen owns input. It is a modal (see modalOpen() in the HUD) but
  // NOT a pause: update() keeps stepping under it, exactly as it does under the upgrade panel.
  skillTree:{revealed:new Set([SKILL_TREE_ROOT_ID]),selected:new Set(),open:false},
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
    // `minGap` spreads seeded nodes; live placement uses cell occupancy instead.
    const place=(count,minGap,make,accept=()=>true)=>{
      let tries=0;
      while(count>0&&tries++<SEED_CELL_TRIES){
        // Sample broadly, then quantize; stepping cells in order would create visible rows.
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
    // Nodes carry RESOURCE_FOOTPRINT so grid consumers share one definition.
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

const RUN_MODES=new Set(["normal","showcase"]);
const RESOURCE_KIND_SET=new Set(RESOURCE_KINDS);
let initializedMode=null;
function invariant(condition,message){if(!condition)throw new Error("simulation invariant: "+message);}
function assertCombatKind(target){
  invariant(target&&["enemy","damage-dummy"].includes(target.combatKind),"unknown combat kind "+target?.combatKind);
  return target.combatKind;
}
function assertHeldKind(held){
  invariant(held&&["worker","building","showcase-prop"].includes(held.kind),"unknown held kind "+held?.kind);
  return held.kind;
}
function makeShowcaseWorker(f,index){
  return {x:f.x,y:f.y,postX:f.x,postY:f.y,spawnSource:null,job:f.job,jobTarget:null,taskTarget:null,returning:false,starved:false,carried:resourceCounts(),hp:WORKER_HP,attackCooldown:0,hitCooldown:0,step:index*.4,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,displayUnit:true,displayTool:f.tool||null,showcaseKey:"worker:"+f.id,showcaseLabel:f.label,showcaseSection:f.section};
}
function clearShowcaseLive(){
  cancelHeldObject();closeUpgradeMenu();resetChop();state.showcaseFocus=null;
  trees.length=rocks.length=diamonds.length=resourceDrops.length=buildings.length=damageDummies.length=showcaseProps.length=showcaseLabelRecords.length=workerCorpses.length=particles.length=0;state.workers.length=state.enemies.length=0;
  invariant(!state.heldObject,"held object survived showcase teardown");
}
function buildShowcaseFixtures(){
  clearShowcaseLive();
  for(const f of SHOWCASE_MANIFEST.resourceNodes){const common={x:f.x,y:f.y,hp:10,max:10,shake:0,footprint:RESOURCE_FOOTPRINT,showcaseKey:"resource-node:"+f.id,showcaseLabel:f.label,showcaseSection:f.section};if(f.id==="wood")trees.push({...common,stump:0,variant:0});else if(f.id==="stone")rocks.push({...common,depleted:0});else diamonds.push({...common,depleted:0});}
  for(const f of SHOWCASE_MANIFEST.looseResources)resourceDrops.push({kind:f.id,x:f.x,y:f.y,groundY:f.y,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null,showcaseKey:"loose-resource:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  const addComplete=(type,x,y,label,section,key)=>{const b=createBuilding(type,x,y);b.complete=true;b.pulse=0;b.showcaseKey=key;b.showcaseLabel=label;b.showcaseSection=section;if(type==="tower"){const v=TOWER_VARIANTS.basic;b.tower={variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:v.maxHp,maxHp:v.maxHp};}if(type==="house")b.spawnTimer=WORKER_SPAWN_TIME;buildings.push(b);return b;};
  for(const f of SHOWCASE_MANIFEST.buildings)addComplete(f.id,f.x,f.y,f.label,f.section,"building:"+f.id);
  for(const f of SHOWCASE_MANIFEST.towers){const b=addComplete("tower",f.x,f.y,TOWER_VARIANTS[f.id].name,f.section,"tower:"+f.id),v=TOWER_VARIANTS[f.id];b.tower={variant:f.id,cooldown:0,flash:0,hitFlash:0,hp:v.maxHp,maxHp:v.maxHp};}
  for(const f of SHOWCASE_MANIFEST.progress){const b=createBuilding(f.type,f.x,f.y);b.showcaseKey="progress:"+f.id;b.showcaseLabel=f.label;b.showcaseSection=f.section;if(f.state==="blueprint"){b.complete=false;b.delivered={wood:Math.floor(b.cost.wood/2),stone:Math.floor(b.cost.stone/2)};}else{const v=TOWER_VARIANTS[f.variant];b.complete=true;b.tower={variant:f.variant,cooldown:0,flash:0,hitFlash:0,hp:v.maxHp,maxHp:v.maxHp};const cost=TOWER_VARIANTS[f.upgrade].cost;b.activeUpgrade={id:f.upgrade,kind:"tower",delivered:Object.fromEntries(RESOURCE_KINDS.map(k=>[k,Math.floor((cost[k]||0)/2)]))};}buildings.push(b);}
  SHOWCASE_MANIFEST.enemies.forEach((f,i)=>{const d=ENEMY_TYPES[f.id];state.enemies.push({combatKind:"enemy",type:f.id,x:f.x,y:f.y,hp:d.hp,max:d.hp,attackCooldown:0,healCooldown:1,wob:i*.5,flash:0,shotFlash:0,healFlash:0,status:{burn:null,slow:null},retaliationTower:null,displayUnit:true,showcaseKey:"enemy:"+f.id,showcaseLabel:d.name,showcaseSection:f.section});});
  SHOWCASE_MANIFEST.workers.forEach((f,i)=>state.workers.push(makeShowcaseWorker(f,i)));
  for(const f of SHOWCASE_MANIFEST.dummies)damageDummies.push({combatKind:"damage-dummy",id:f.id,x:f.x,y:f.y,homeX:f.homeX,homeY:f.homeY,hp:f.hp,max:f.hp,flash:0,defeatedTimer:0,status:{burn:null,slow:null},spawnSide:MAP_SIDE.SOUTH,recentDamage:0,hitCount:0,showcaseKey:"dummy:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  state.showcaseFocus=damageDummies[0]||null;
  for(const f of SHOWCASE_MANIFEST.props)showcaseProps.push({id:f.id,model:f.model,x:f.x,y:f.y,homeX:f.x,homeY:f.y,footprint:f.footprint,showcaseKey:"prop:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  showcaseLabelRecords.push(
    {key:"fixed:base",entity:BASE,label:"base",section:"units",height:88},
    {key:"fixed:king",entity:state.king,label:"king",section:"units",height:34}
  );
  for(const items of [[...trees,...rocks,...diamonds],resourceDrops,buildings,state.workers,state.enemies,damageDummies,showcaseProps])
    for(const entity of items)if(entity.showcaseLabel)showcaseLabelRecords.push({key:entity.showcaseKey,entity,label:entity.showcaseLabel,section:entity.showcaseSection,height:entity.type==="tower"?70:38});
  invariant(new Set(showcaseLabelRecords.map(record=>record.key)).size===showcaseLabelRecords.length,"duplicate showcase label key");
  showcaseRevision++;
  validateSimulationInvariants();
}
// First initialization selects a closed run mode. Repeating the same mode is idempotent for normal
// and rebuilds authored fixtures for showcase; switching an installed simulation is rejected.
export function initializeRunMode(mode="normal"){
  if(!RUN_MODES.has(mode))throw new Error("invalid run mode: "+mode);
  if(initializedMode&&initializedMode!==mode)throw new Error("run mode already initialized as "+initializedMode);
  initializedMode=mode;state.runMode=mode;
  if(mode==="normal"){invariant(!damageDummies.length&&!showcaseProps.length,"normal mode contains showcase entities");validateSimulationInvariants();return;}
  state.gameOver=false;state.paused=false;state.showcaseFocus=null;state.baseHp=state.baseMax;state.clock={phase:"day",remaining:DAY_DURATION,completedNights:0,light:0,elapsed:0};state.camera.x=SHOWCASE_MANIFEST.sections.towers.x;state.camera.y=SHOWCASE_MANIFEST.sections.towers.y;state.camera.zoom=SHOWCASE_MANIFEST.sections.towers.zoom;state.keys.clear();state.buildMode=null;state.buildDockCategory=null;state.carried=resourceCounts();state.stored=resourceCounts();buildShowcaseFixtures();clampCamera();effects.pauseChanged(false);
}
export function rebuildShowcase(){if(state.runMode!=="showcase")return false;buildShowcaseFixtures();return true;}

export function validateSimulationInvariants(){
  invariant(RUN_MODES.has(state.runMode),"invalid run mode "+state.runMode);
  invariant(Number.isFinite(state.baseHp)&&state.baseHp>=0&&state.baseHp<=state.baseMax,"illegal base health");
  const collections=[trees,rocks,diamonds,resourceDrops,buildings,state.workers,state.enemies,damageDummies,showcaseProps,particles];
  for(const collection of collections)for(const item of collection)invariant(Number.isFinite(item.x)&&Number.isFinite(item.y),"non-finite entity coordinates");
  for(const enemy of state.enemies){
    invariant(assertCombatKind(enemy)==="enemy","non-enemy in enemy collection");
    invariant(ENEMY_TYPES[enemy.type],"unknown enemy type "+enemy.type);
    invariant(enemy.hp>=0&&enemy.hp<=enemy.max,"illegal enemy health");
  }
  for(const dummy of damageDummies){invariant(assertCombatKind(dummy)==="damage-dummy","non-dummy in dummy collection");invariant(dummy.hp>=0&&dummy.hp<=dummy.max,"illegal dummy health");}
  for(const drop of resourceDrops){
    invariant(RESOURCE_KIND_SET.has(drop.kind),"unknown resource drop kind "+drop.kind);
    invariant(drop.target===null||drop.target==="hand","invalid resource drop target "+drop.target);
    if(drop.claimedBy!==undefined)invariant(state.workers.includes(drop.claimedBy),"resource claimed by unknown worker");
  }
  for(const kind of RESOURCE_KINDS){invariant(Number.isFinite(state.carried[kind])&&state.carried[kind]>=0,"illegal carried "+kind);invariant(Number.isFinite(state.stored[kind])&&state.stored[kind]>=0,"illegal stored "+kind);}
  for(const kind of Object.keys(state.carried))invariant(RESOURCE_KIND_SET.has(kind),"unknown carried resource "+kind);
  for(const kind of Object.keys(state.stored))invariant(RESOURCE_KIND_SET.has(kind),"unknown stored resource "+kind);
  for(const worker of state.workers){invariant(worker.hp>=0&&worker.hp<=WORKER_HP,"illegal worker health");if(worker.taskTarget)invariant(resourceDrops.includes(worker.taskTarget)||trees.includes(worker.taskTarget)||rocks.includes(worker.taskTarget)||diamonds.includes(worker.taskTarget),"worker task target left owned collection");}
  for(const building of buildings)if(building.tower)invariant(building.tower.hp>=0&&building.tower.hp<=building.tower.maxHp,"illegal tower health");
  for(const id of state.skillTree.selected)invariant(state.skillTree.revealed.has(id)&&SKILL_NODES_BY_ID[id],"selected skill is not revealed");
  for(const id of state.skillTree.revealed)invariant(SKILL_NODES_BY_ID[id],"unknown revealed skill "+id);
  if(state.heldObject){const held=state.heldObject,kind=assertHeldKind(held);invariant(Number.isFinite(held.originX)&&Number.isFinite(held.originY),"invalid held origin");if(kind==="worker")invariant(!state.workers.includes(held.object),"held worker still installed");else if(kind==="building")invariant(!buildings.includes(held.object),"held building still installed");else invariant(showcaseProps.includes(held.object),"held prop lost ownership");}
  if(state.runMode==="normal")invariant(!damageDummies.length&&!showcaseProps.length&&!showcaseLabelRecords.length,"normal mode contains showcase entities");
  else invariant(state.enemies.every(enemy=>enemy.displayUnit)&&state.workers.every(worker=>worker.displayUnit),"showcase display units are not inert");
  return true;
}

function clampCamera(){
  const camera=state.camera,halfW=VIEW_W/(2*camera.zoom),halfH=VIEW_H/(2*camera.zoom);
  camera.x=halfW>=W/2?W/2:clamp(camera.x,halfW,W-halfW);
  camera.y=halfH>=H/2?H/2:clamp(camera.y,halfH,H-halfH);
}

function startPrimaryClick(){state.primaryClick.held=true;}
// Release/cancel owns only held state; the shared work cooldown survives every stop/start boundary.
function stopPrimaryClick(){state.primaryClick.held=false;resetChop();}
function stopGameplayInput(cancelPlacement=false){
  stopPrimaryClick();state.collecting=false;state.camera.panning=false;state.keys.clear();
  // Held props remain simulation-owned but cancellation must restore their authored coordinates.
  if(heldProp())cancelHeldObject();
  if(cancelPlacement){state.buildMode=null;setBuildDockCategory(null);effects.buildHudChanged();}
}
function togglePause(){
  if(state.gameOver)return;
  state.paused=!state.paused;stopGameplayInput();
  if(state.paused)closeUpgradeMenu();
  effects.pauseChanged(state.paused);sound(state.paused?180:360,.06);
}
function cancelBuildMode(){
  if(!state.buildMode)return false;
  state.buildMode=null;effects.buildHudChanged();toast("building placement cancelled");return true;
}

function spawnEnemy(side=null,enemyType=null){
  const attackSide=side||MAP_SIDES[(Math.random()*MAP_SIDES.length)|0],type=enemyType||ENEMY_POOL[(Math.random()*ENEMY_POOL.length)|0],def=ENEMY_TYPES[type];
  let x,y;
  if(attackSide===MAP_SIDE.WEST){x=8;y=rand(20,H-20);}else if(attackSide===MAP_SIDE.EAST){x=W-8;y=rand(20,H-20);}
  else if(attackSide===MAP_SIDE.NORTH){x=rand(20,W-20);y=8;}else{x=rand(20,W-20);y=H-8;}
  state.enemies.push({combatKind:"enemy",type,spawnSide:attackSide,x,y,hp:def.hp,max:def.hp,attackCooldown:0,healCooldown:rand(.5,2),wob:rand(0,6),flash:0,shotFlash:0,healFlash:0,status:{burn:null,slow:null},retaliationTower:null});
}
function enemyAt(x,y){
  let target=null,best=Infinity;
  const candidates=state.runMode==="showcase"?damageDummies:state.enemies;
  for(const enemy of candidates){
    if(enemy.displayUnit||enemy.defeatedTimer>0)continue;
    const d=distance(x,y,enemy.x,enemy.y),hitRadius=assertCombatKind(enemy)==="damage-dummy"?24:24*ENEMY_TYPES[enemy.type].size;
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
function hitCombatTarget(target,quiet=false){
  const kind=assertCombatKind(target);
  if(kind==="damage-dummy")damageDummy(target,TUNE.clickDamage);
  else if(kind==="enemy"){target.hp-=TUNE.clickDamage;target.flash=.16;burst(target.x,target.y,"#d25b49",5);if(target.hp<=0)killEnemy(target);}
  else invariant(false,"unhandled combat kind "+kind);
  if(!quiet)sound(610,.045);
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
  for(const candidate of state.workers){if(candidate.displayUnit)continue;const d=distance(x,y,candidate.x,candidate.y);if(d<best){worker=candidate;best=d;}}
  if(worker){
    clearWorkerTask(worker);state.workers.splice(state.workers.indexOf(worker),1);
    state.heldObject={kind:"worker",object:worker,originX:worker.x,originY:worker.y};state.collecting=false;toast("worker lifted — release to assign");return true;
  }
  const building=buildings.find(item=>item.complete&&item.type==="tower"&&towerVariant(item).movable&&manualTowerButtonHit(item,x,y));
  if(building){state.heldObject={kind:"building",object:building,originX:building.x,originY:building.y};buildings.splice(buildings.indexOf(building),1);state.collecting=false;toast(towerVariant(building).name+" picked up — release right to place");return true;}
  // Explicit secondary-action priority: workers, movable Shock Towers, showcase props, then vacuum.
  if(state.runMode==="showcase"){
    const prop=showcaseProps.find(item=>distance(x,y,item.x,item.y)<24);
    if(prop){state.heldObject={kind:"showcase-prop",object:prop,originX:prop.x,originY:prop.y};state.collecting=false;toast(prop.id+" picked up — release right to place");return true;}
  }
  return false;
}
function heldWorker(){return state.heldObject?.kind==="worker"?state.heldObject.object:null;}
function heldBuilding(){return state.heldObject?.kind==="building"?state.heldObject.object:null;}
function heldProp(){return state.heldObject?.kind==="showcase-prop"?state.heldObject.object:null;}
function installHeldAtOrigin(held){
  const object=held.object;object.x=held.originX;object.y=held.originY;
  const kind=assertHeldKind(held);
  if(kind==="worker")state.workers.push(object);
  else if(kind==="building")buildings.push(object);
  else if(kind==="showcase-prop")invariant(showcaseProps.includes(object),"held prop left its owned collection");
  else invariant(false,"unhandled held kind "+kind);
}
function cancelHeldObject(){if(!state.heldObject)return;installHeldAtOrigin(state.heldObject);state.heldObject=null;}
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
  if(held.kind==="showcase-prop"){
    const prop=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
    if(anchor&&canPlace(anchor.x,anchor.y,null,null,prop)){prop.x=anchor.x;prop.y=anchor.y;toast(prop.id+" placed");}
    else{prop.x=held.originX;prop.y=held.originY;toast("invalid ground — "+prop.id+" returned");}
    invariant(showcaseProps.includes(prop),"placed prop left its owned collection");state.heldObject=null;sound(260,.06);return true;
  }
  // Relocation validates the tower's own 3x3 footprint at the snapped anchor, excluding itself.
  // Only x/y are ever touched: cooldown, hp, variant and upgrade state ride along on the same object,
  // and an invalid drop restores the exact origin recorded at pickup.
  invariant(assertHeldKind(held)==="building","unhandled held drop kind "+held.kind);
  const building=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
  if(anchor&&canPlace(anchor.x,anchor.y,building.type,building)){building.x=anchor.x;building.y=anchor.y;toast(towerVariant(building).name+" placed");}
  else{building.x=held.originX;building.y=held.originY;toast("invalid ground — tower returned");}
  buildings.push(building);state.heldObject=null;sound(260,.06);return true;
}
function activateManualTower(building){
  const tower=building.tower,variant=towerVariant(building);if(!variant.manual)return;
  if(tower.cooldown>0){toast(variant.name+" recharging: "+tower.cooldown.toFixed(1)+"s");return;}
  if(state.runMode==="showcase"&&!damageDummies.some(dummy=>dummy.defeatedTimer<=0&&distance(building.x,building.y,dummy.x,dummy.y)<=variant.effectRadius))return;
  tower.cooldown=variant.cooldown;tower.flash=.35;
  eachTowerCombatTarget(enemy=>{
    if(distance(building.x,building.y,enemy.x,enemy.y)<=variant.effectRadius)damageCombatTarget(enemy,variant.damage,variant.accent,7,building);
  });
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
  // enemyAt() selects the mode's attackable roster: production enemies normally, dummies in
  // showcase. The membership guard rejects stale references after death/reset/rebuild.
  if(enemy&&enemy.hp>0&&(assertCombatKind(enemy)==="damage-dummy"?damageDummies.includes(enemy):state.enemies.includes(enemy)))
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
  if(effects.isModalOpen()||state.paused||state.gameOver){resetChop();stopPrimaryClick();return;}
  const m=state.mouse;
  if(!m.inside){resetChop();return;}
  // Nodes and enemies share one hold-to-fill timer; moving off resets it.
  // Re-resolved every tick through the one authority, so a target that dies,
  // depletes, or is swapped under the cursor drops or restarts the fill here.
  const hit=resolvePrimaryAction(m.x,m.y);
  if(!hit){resetChop();return;}
  beginChop(hit);
  chopState.t+=dt*(globalUpgradeEnabled("autoClick")?STEADY_HAND_RATE:1);
  if(chopState.t<TUNE.chopTime)return;
  chopState.t=0;
  const quiet=primary.audioCooldown>0;
  if(hit.kind==="attack")hitCombatTarget(hit.target,quiet);
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
      setBuildDockCategory(null);effects.buildHudChanged();
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
  for(let i=0;i<(automatic?1:TUNE.chopYield);i++)
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
  let nearest=null,best=TUNE.vacuumRadius;
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
  toast(def.resource?def.name+" complete — drop a worker on it to staff it":readyMessage);sound(760,.18);effects.buildHudChanged();
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
function canPlace(x,y,type=null,ignoreBuilding=null,ignoreProp=null){
  const footprint=ignoreProp?.footprint||buildingFootprint(type),c=worldToCell(x,y);
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
  // Props reserve authored cells only while placed; this collection is empty in normal runs.
  for(const prop of showcaseProps)
    if(prop!==ignoreProp&&cellBoundsOverlap(bounds,occupiedCellBounds(prop,prop.footprint)))return false;
  return true;
}

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
function damageDummy(dummy,damage,color="#d25b49",count=5){
  if(!damageDummies.includes(dummy)||dummy.defeatedTimer>0)return false;
  dummy.hp=Math.max(0,dummy.hp-damage);dummy.flash=.16;dummy.recentDamage=damage;dummy.recentTimer=2;dummy.hitCount++;state.showcaseFocus=dummy;burst(dummy.x,dummy.y,color,count);
  if(dummy.hp<=0){dummy.defeatedTimer=1;dummy.status={burn:null,slow:null};return false;}return true;
}
function damageEnemy(enemy,damage,color,count=5,source=null){
  if(!state.enemies.includes(enemy)||enemy.displayUnit)return false;if(source?.tower&&buildings.includes(source))enemy.retaliationTower=source;enemy.hp-=damage;enemy.flash=.16;burst(enemy.x,enemy.y,color,count);if(enemy.hp<=0){killEnemy(enemy,false);return false;}return true;
}
function damageCombatTarget(target,damage,color,count=5,source=null){
  const kind=assertCombatKind(target);
  if(kind==="damage-dummy")return damageDummy(target,damage,color,count);
  if(kind==="enemy")return damageEnemy(target,damage,color,count,source);
  invariant(false,"unhandled combat kind "+kind);
}
function visitStableTargets(targets,visit){
  for(let i=0;i<targets.length;){const target=targets[i];visit(target);if(targets[i]===target)i++;}
}
function eachTowerCombatTarget(visit){
  if(state.runMode==="normal"){visitStableTargets(state.enemies,visit);return;}
  if(state.runMode==="showcase"){visitStableTargets(damageDummies,dummy=>{if(dummy.defeatedTimer<=0)visit(dummy);});return;}
  invariant(false,"invalid run mode "+state.runMode);
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
  let target=null,best=range;eachTowerCombatTarget(enemy=>{const d=distance(building.x,building.y,enemy.x,enemy.y);if(d<best){best=d;target=enemy;}});return target;
}
function applyBurn(enemy,building,variant){
  enemy.status??={burn:null};const current=enemy.status.burn,continues=current?.source===building;enemy.status.burn={remaining:variant.burnDuration,tickCooldown:continues?current.tickCooldown:variant.burnInterval,damage:variant.burnDamage,interval:variant.burnInterval,source:building};
}
function lineIntersectsEnemy(x1,y1,x2,y2,enemy,width){
  // Closest point on finite beam: project enemy-center vector onto beam, clamp t to [0,1], then compare distance to beam half-width plus enemy radius.
  const dx=x2-x1,dy=y2-y1,lengthSquared=dx*dx+dy*dy,t=clamp(((enemy.x-x1)*dx+(enemy.y-y1)*dy)/lengthSquared,0,1),closestX=x1+t*dx,closestY=y1+t*dy,enemyRadius=assertCombatKind(enemy)==="damage-dummy"?10:10*ENEMY_TYPES[enemy.type].size;
  return distance(enemy.x,enemy.y,closestX,closestY)<=width/2+enemyRadius;
}
function fireTowerAttack(building,variant,target){
  const tower=building.tower,color=variant.impactColor||variant.accent;tower.targetX=target.x;tower.targetY=target.y;tower.flash=.2;
  if(variant.attackMode==="splash"){
    const impactX=target.x,impactY=target.y;tower.impactX=impactX;tower.impactY=impactY;eachTowerCombatTarget(enemy=>{if(distance(impactX,impactY,enemy.x,enemy.y)<=variant.splashRadius)damageCombatTarget(enemy,variant.damage,color,8,building);});burst(impactX,impactY,color,18);
  }else if(variant.attackMode==="line"){
    const angle=Math.atan2(target.y-building.y,target.x-building.x),endX=building.x+Math.cos(angle)*variant.range,endY=building.y+Math.sin(angle)*variant.range;tower.targetX=endX;tower.targetY=endY;
    eachTowerCombatTarget(enemy=>{if(lineIntersectsEnemy(building.x,building.y,endX,endY,enemy,variant.beamWidth))damageCombatTarget(enemy,variant.damage,color,7,building);});
  }else{
    const alive=damageCombatTarget(target,variant.damage,color,["burn","slow","push"].includes(variant.attackMode)?8:5,building);
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
    let attacked=false;eachTowerCombatTarget(enemy=>{if(distance(building.x,building.y,enemy.x,enemy.y)>variant.effectRadius)return;if(!attacked){tower.cooldown=variant.cooldown;tower.flash=.4;attacked=true;}damageCombatTarget(enemy,variant.damage,variant.accent,5,building);});
    if(attacked)sound(variant.sound,.22);return;
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
    else{burn.remaining-=dt;burn.tickCooldown-=dt;while(burn.tickCooldown<=0&&burn.remaining>=0){burn.tickCooldown+=burn.interval;if(!damageCombatTarget(enemy,burn.damage,"#ef6a32",5,burn.source))return false;}if(burn.remaining<=0)enemy.status.burn=null;}
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
function updateCamera(dt){
  const keys=state.keys,camera=state.camera;
  let panX=(keys.has("KeyD")||keys.has("ArrowRight"))-(keys.has("KeyA")||keys.has("ArrowLeft"));
  let panY=(keys.has("KeyS")||keys.has("ArrowDown"))-(keys.has("KeyW")||keys.has("ArrowUp"));
  if(panX||panY){const length=Math.hypot(panX,panY),speed=430/camera.zoom;camera.x+=panX/length*speed*dt;camera.y+=panY/length*speed*dt;clampCamera();}
}
function updateTransientTimers(dt){
  state.basePulse=Math.max(0,state.basePulse-dt*3);state.toastTimer=Math.max(0,state.toastTimer-dt);state.collectCooldown-=dt;
  if(state.collecting&&state.mouse.inside&&state.collectCooldown<=0){collectDrop(true);state.collectCooldown=TUNE.suckRate;}
  if(state.toastTimer<=0)effects.toastExpired();
}
function updateResourceNodes(dt){
  for(const tree of trees)tree.shake=Math.max(0,tree.shake-dt*7);
  for(const rock of rocks)rock.shake=Math.max(0,rock.shake-dt*7);
  for(const diamond of diamonds)diamond.shake=Math.max(0,diamond.shake-dt*7);
}
function updateLooseResources(dt,expire){
  for(let i=resourceDrops.length-1;i>=0;i--){
    const drop=resourceDrops[i];
    if(expire&&drop.ttl!==null&&!drop.target&&!drop.claimedBy){drop.ttl-=dt;if(drop.ttl<=0){resourceDrops.splice(i,1);continue;}}
    drop.spin+=dt*4;
    if(drop.target==="hand"){drop.t+=dt*7;const ease=1-Math.pow(1-clamp(drop.t,0,1),3);drop.x+=(state.mouse.x-drop.x)*ease*.35;drop.y+=(state.mouse.y-drop.y)*ease*.35;if(drop.t>=1){resourceDrops.splice(i,1);state.carried[drop.kind]++;}continue;}
    drop.vy+=170*dt;drop.x+=drop.vx*dt;drop.y+=drop.vy*dt;
    if(drop.y>=drop.groundY){drop.y=drop.groundY;drop.vx*=.72;drop.vy*=-.22;if(Math.abs(drop.vy)<10){drop.vy=0;drop.vx=0;drop.ground=true;}}
  }
}
function updateBuildings(dt,includeHazards){
  for(const building of buildings){building.pulse=Math.max(0,building.pulse-dt*3);if(building.complete&&building.tower)updateTower(building,dt);if(includeHazards&&building.complete&&building.hazard)updateHazard(building,dt);}
  if(includeHazards)for(let i=buildings.length-1;i>=0;i--)if(buildings[i].remove)buildings.splice(i,1);
  const held=heldBuilding();if(held?.tower)updateTower(held,dt);
}
function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;if(p.resource){const q=1-p.life/p.max;p.x+=(p.tx-p.x)*q*.28;p.y+=(p.ty-p.y)*q*.28;}else{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=80*dt;}if(p.life<=0)particles.splice(i,1);}
}
function updateNormal(dt){
  if(state.gameOver||state.paused){stopPrimaryClick();return;}
  updatePrimaryClick(dt);updateClock(dt);updateNightEnemyWave(dt);updateCamera(dt);
  state.coinTimer-=dt;if(state.coinTimer<=0){spawnCoin();state.coinTimer=rand(14,22);}
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
  updateKing(dt);updateTransientTimers(dt);updateResourceNodes(dt);updateLooseResources(dt,true);
  updateWorkerSpawns(dt);updateBuildings(dt,true);
  for(const worker of state.workers)updateWorker(worker,dt);
  for(const building of buildings)if(!building.complete){const builders=state.workers.filter(worker=>worker.job==="build"&&worker.jobTarget===building);building.starved=builders.length>0&&builders.every(worker=>worker.starved);}
  updateParticles(dt);effects.afterUpdate();
}

// Dedicated showcase policy: deliberately lists the sandbox stages instead of branching inside the
// production pipeline. Clock/waves/spawns/enemy AI/worker AI/houses/economy/defeat are absent.
function updateShowcase(dt){
  if(state.paused){stopPrimaryClick();return;}
  updatePrimaryClick(dt);updateCamera(dt);updateTransientTimers(dt);updateResourceNodes(dt);updateLooseResources(dt,false);
  for(const dummy of damageDummies){
    dummy.flash=Math.max(0,dummy.flash-dt);dummy.recentTimer=Math.max(0,(dummy.recentTimer||0)-dt);
    if(dummy.defeatedTimer>0){dummy.defeatedTimer-=dt;if(dummy.defeatedTimer<=0){dummy.x=dummy.homeX;dummy.y=dummy.homeY;dummy.hp=dummy.max;dummy.status={burn:null,slow:null};}continue;}
    updateEnemyStatuses(dummy,dt);
  }
  updateBuildings(dt,false);updateParticles(dt);effects.afterUpdate();
}

// main.js supplies dt; the explicit mode dispatch keeps both pipelines auditable.
function update(dt){
  switch(state.runMode){
    case "normal": return updateNormal(dt);
    case "showcase": return updateShowcase(dt);
    default: invariant(false,"invalid run mode "+state.runMode);
  }
}

function toast(message){
  state.toastTimer=2.2;effects.toast(message);
}
function endGame(){
  if(state.gameOver)return;
  state.gameOver=true;stopGameplayInput(true);cancelHeldObject();closeUpgradeMenu();
  effects.gameOver();sound(65,.6);
}

function burst(x,y,col,count){for(let i=0;i<count;i++)particles.push({x,y,vx:rand(-55,55),vy:rand(-90,-25),life:rand(.3,.7),col});}

function towerRadius(building){const variant=towerVariant(building);return variant.range||variant.effectRadius;}

function chopTarget(){
  const m = state.mouse;
  if(!m.inside) return null;
  return resolvePrimaryAction(m.x,m.y);
}

function badgeAction(){
  if(state.paused || state.gameOver || effects.isModalOpen()) return null;  // pause, loss, modal UI
  if(state.camera.panning) return null;                           // middle-mouse drag
  if(state.heldObject) return null;                               // carrying a worker or building
  const action = chopTarget();                                    // null once the cursor leaves the canvas
  if(!action) return null;
  // Placement mode swallows the press for harvesting but not for a swing:
  // leftClick() resolves an attack before it ever looks at state.buildMode.
  if(state.buildMode && action.kind !== "attack") return null;
  return action;
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
  if(state.paused || state.gameOver || effects.isModalOpen()) return null;
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
  effects.phaseHudChanged();
}
function debugAdvancePhase(){ transitionPhase(); effects.phaseHudChanged(); }
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
  effects.phaseHudChanged(); toast("debug wave: "+recipe.id);
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

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS — the ONLY way player intent (or the debugger) may change the world.
// Each one is a whole intent, not a state poke: main.js decides WHEN a command
// runs, this module decides WHAT it does. None of them draw, and none of them
// return a rendering decision.
// ═══════════════════════════════════════════════════════════════════════════

// ── pointer position ──
// state.mouse is world-space simulation pixels. input.js obtains it from scene.js ground raycasts.
export function setPointerWorld(x,y){ state.mouse.x=x; state.mouse.y=y; state.mouse.inside=true; }
export function setPointerOutside(){ state.mouse.inside=false; }

// ── the primary (left) action ──
// Press arms the held bar through leftClick()'s full priority chain; the modal
// re-check between the two halves is the original ordering (leftClick may open
// the upgrade panel, and a press that did so must not also start a swing).
export function primaryPress(){const action=resolvePrimaryAction(state.mouse.x,state.mouse.y);if(action?.target?.combatKind==="damage-dummy")state.showcaseFocus=action.target;leftClick();if(!effects.isModalOpen())startPrimaryClick();}
export function primaryRelease(){ stopPrimaryClick(); }

// ── the secondary (right) action ──
// Cancel placement first, then pick a movable up, and only then start vacuuming:
// the same order the pointerdown handler used to run inline.
export function secondaryPress(){
  if(cancelBuildMode())return;
  if(pickUpMovableAt(state.mouse.x,state.mouse.y))return;
  state.collecting=true; collectDrop(); state.collectCooldown=TUNE.suckRate;
}
export function secondaryRelease(){ releaseRightMouse(); }

// ── input teardown ──
// pointercancel keeps the movement keys (the window still has focus); blur drops
// them too, or a key held across a focus change would pan forever.
export function pointerCancelled(){ stopPrimaryClick(); state.collecting=false; state.camera.panning=false; cancelHeldObject(); }
export function windowBlurred(){ stopPrimaryClick(); state.collecting=false; state.camera.panning=false; state.keys.clear(); cancelHeldObject(); }
export function pressKey(code){ state.keys.add(code); }
export function releaseKey(code){ state.keys.delete(code); }

// ── camera ──
// The camera lives in state because update() pans it with movement keys and
// therefore steps with game speed. scene.js owns projection; these own the
// numbers. dragCameraTo/setCameraZoom clamp on the way out; zoomCameraBy and
// offsetCamera deliberately do not, because the wheel handler interleaves them
// with two ground raycasts and clamps once at the end.
export function beginCameraPan(x,y){ const camera=state.camera; camera.panning=true; camera.dragX=x; camera.dragY=y; }
export function endCameraPan(){ state.camera.panning=false; }
export function dragCameraTo(x,y){ const camera=state.camera; camera.x+=camera.dragX-x; camera.y+=camera.dragY-y; clampCamera(); }
export function zoomCameraBy(factor){ const camera=state.camera; camera.zoom=clamp(camera.zoom*factor,.2,5); }
export function setCameraZoom(zoom){ state.camera.zoom=zoom; clampCamera(); }
/** Showcase UI camera command; section coordinates remain authored in showcase-data.js. */
export function focusShowcaseSection(id){const section=SHOWCASE_MANIFEST.sections[id];if(state.runMode!=="showcase"||!section)return false;state.camera.x=section.x;state.camera.y=section.y;state.camera.zoom=section.zoom;clampCamera();return true;}
/** Wheel zoom-toward-cursor correction: shift by the ground delta, unclamped (the caller clamps). */
export function offsetCamera(dx,dy){ state.camera.x+=dx; state.camera.y+=dy; }

// ── build mode / dock ──
export function toggleBuildMode(kind){
  if(state.gameOver||state.paused)return;
  if(BUILDING_TYPES[kind].stack&&!DBG.unlimitedCharges&&state.buildStacks[kind]<=0){toast("no "+BUILDING_TYPES[kind].name+" stacks remaining");return;}
  state.buildMode=state.buildMode===kind?null:kind;
  effects.buildHudChanged();
  toast(state.buildMode?"click explored, clear ground to place the blueprint":"build cancelled");
}
/** Which dock category is expanded. The open/closed classes are the adapter's job. */
export function setBuildDockCategory(category){ state.buildDockCategory=category; effects.buildDockChanged(category); }

// ── the upgrade menu ──
// state.upgradeMenu is gameplay state (it names the building being upgraded), so
// it is owned here; the panel that displays it is not. openUpgradeMenu() reports
// whether it opened, and announces its own refusals.
export function openUpgradeMenu(building,kind){
  if(building.activeUpgrade){toast("finish the active upgrade by depositing resources");return false;}
  if(kind==="tower"&&building.tower.variant!=="basic"){toast("this tower already has a permanent variant");return false;}
  stopGameplayInput();
  const list=upgradeList(kind);
  state.upgradeMenu.building=building;state.upgradeMenu.kind=kind;
  state.upgradeMenu.selected=list.find(item=>!building.upgrades[item.id])?.id||null;
  effects.upgradeMenuOpened();
  return true;
}
/**
 * Returns whether a menu was actually open, so Escape can consume the keystroke. The building IS
 * the open flag: openUpgradeMenu() is the only thing that sets it and this is the only thing that
 * clears it. It deliberately does not ask isModalOpen() — that answers for the skill tree too.
 */
export function closeUpgradeMenu(){
  const wasOpen=!!state.upgradeMenu.building;
  state.upgradeMenu.building=null;state.upgradeMenu.selected=null;state.upgradeMenu.kind=null;
  effects.upgradeMenuClosed();
  return wasOpen;
}
export function selectUpgrade(id){ state.upgradeMenu.selected=id; }
export function acceptUpgrade(){
  const menu=state.upgradeMenu,building=menu.building,upgrade=upgradeList(menu.kind).find(item=>item.id===menu.selected);
  if(!building||!upgrade)return false;
  building.activeUpgrade={id:upgrade.id,kind:menu.kind,delivered:resourceCounts()};
  const destination=menu.kind;closeUpgradeMenu();
  // free costs (debug): the job is accepted normally, then satisfied through the same
  // applyFinishedUpgrade() a full delivery reaches. Nothing is deducted or granted.
  if(DBG.freeCosts&&applyFinishedUpgrade(building))return true;
  toast("accepted "+upgrade.name+" — deposit resources at the "+destination);sound(590,.1);
  return true;
}

// ── the skill tree ──
// THE only writer of the two id sets (state.skillTree.revealed / .selected); the `open` flag beside
// them is written by openSkillTree() / closeSkillTree() below and by nothing else. Taking a node
// reveals its immediate neighbours — ONE hop, either direction along an edge — and costs and grants
// nothing. Refusals are silent no-ops, so a UI may call this on any click without pre-checking.
export function selectSkillNode(id){
  const tree=state.skillTree;
  if(!SKILL_NODES_BY_ID[id])return false;                          // not a node at all
  if(!tree.revealed.has(id)||tree.selected.has(id))return false;   // hidden, or already taken
  tree.selected.add(id);
  for(const neighbour of SKILL_NEIGHBORS[id])tree.revealed.add(neighbour);
  effects.skillTreeChanged();
  return true;
}
/**
 * Show the skill-tree screen. It takes over input, so it lets go of whatever the pointer and the
 * keys were doing and clears placement through the SAME stopGameplayInput(true) the run-over path
 * uses — a blueprint left armed under a full-stage overlay would come back with the screen. The
 * upgrade panel goes first because two modals must never be on screen together.
 * Reports whether it actually opened; a second call while open changes nothing.
 */
export function openSkillTree(){
  if(state.skillTree.open)return false;
  stopGameplayInput(true);
  closeUpgradeMenu();
  state.skillTree.open=true;
  effects.skillTreeOpened();
  return true;
}
/**
 * Hide it again. Selected and revealed ids, resources, the clock, the camera and the pause flag are
 * all left exactly as they were — this command writes one boolean. Returns whether it was open, so
 * Escape can consume the keystroke.
 */
export function closeSkillTree(){
  if(!state.skillTree.open)return false;
  state.skillTree.open=false;
  effects.skillTreeClosed();
  return true;
}

// ── debug-owned writes into ordinary state (view panel > gameplay) ──
export function setCapacity(value){ state.capacity=value; }
export function resetDamageDummies(){if(state.runMode!=="showcase")return false;for(const d of damageDummies){d.x=d.homeX;d.y=d.homeY;d.hp=d.max;d.flash=0;d.defeatedTimer=0;d.status={burn:null,slow:null};d.recentDamage=0;d.recentTimer=0;d.hitCount=0;}state.showcaseFocus=damageDummies[0]||null;validateSimulationInvariants();return true;}
export function resetShowcaseProps(){if(state.runMode!=="showcase")return false;if(heldProp())cancelHeldObject();for(const p of showcaseProps){p.x=p.homeX;p.y=p.homeY;}validateSimulationInvariants();return true;}
export function showcaseSections(){return SHOWCASE_MANIFEST.sections;}
export function focusedDummyReadout(){const d=state.showcaseFocus;return d&&damageDummies.includes(d)?{id:d.id,hp:d.hp,max:d.max,recentDamage:d.recentTimer>0?d.recentDamage:0,hitCount:d.hitCount,defeated:d.defeatedTimer>0}:null;}
export function showcaseLabels(){return state.runMode==="showcase"?{revision:showcaseRevision,labels:showcaseLabelRecords}:null;}

// ═══════════════════════════════════════════════════════════════════════════
// QUERIES — pure reads for the render / UI layers. None of them mutate.
// Anything the drawing code needs to know about the world is answered here, so
// a mark on screen can never disagree with the rule that produced it.
// ═══════════════════════════════════════════════════════════════════════════

/** What the held-action timer is currently filling, or null. Read-only peek. */
export function heldChopTarget(){ return chopState.target; }
/** Is the primary button down right now? */
export function primaryHeld(){ return state.primaryClick.held; }

// ── skill tree projections ──
// Fresh records over the frozen graph and the two id sets — project them, never mutate them, the
// same contract the live collections carry. Status is "selected", "available" or "hidden" (unknown
// ids read as hidden); nodes come in authored order with hidden ones in, edges only when both ends
// are visible, so a line never points at a node the player has not been shown.
const skillNodeVisible=id=>state.skillTree.revealed.has(id);
function skillNodeStatus(id){ return state.skillTree.selected.has(id)?"selected":skillNodeVisible(id)?"available":"hidden"; }
function skillTreeNodes(){
  return SKILL_NODES.map(node=>({id:node.id,name:node.name,icon:node.icon,x:node.x,y:node.y,root:!!node.root,status:skillNodeStatus(node.id)}));
}
function skillTreeEdges(){
  return SKILL_EDGES.filter(edge=>skillNodeVisible(edge.a)&&skillNodeVisible(edge.b)).map(edge=>({a:edge.a,b:edge.b}));
}

export {
  // live collections — iterate, never mutate
  state, trees, rocks, diamonds, resourceDrops, buildings, damageDummies, showcaseProps, workerCorpses, particles,
  // debug flags (the gameplay pane's own bindings are the only writers)
  DBG,
  // the step
  update,
  // notifications the UI itself raises (boot message, debug readouts)
  toast,
  // hover / action resolution
  hoverTarget, hoveredBuilding, badgeAction, chopTarget, chopProgress,
  resolvePrimaryAction,
  // placement + coverage
  canPlace, indicatorRadius, towerRadius, towerVariant,
  // costs and progress
  buildingCost, costText, upgradeList, towerUpgradeList, nextHouseCost,
  // world lookups the render layer projects
  storageServiceRadius, workerAssignmentAt, heldWorker, heldBuilding, heldProp,
  workerCoatColor, workerLoad, carriedTotal, resourceIsActive, oppositeMapSide,
  // skill tree — read-only projections of the authored graph over this run's two id sets
  skillTreeNodes, skillTreeEdges,
  // shared numeric helpers (defined here, so nothing restates them)
  clamp, distance, rand,
  // commands that are plain gameplay functions rather than input adapters
  togglePause, cancelBuildMode, clampCamera, stopGameplayInput, cancelHeldObject,
  spawnEnemy, transitionPhase,
  // debug commands (view panel > gameplay)
  debugGrant, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase,
  debugStartWave, debugClearEnemies, debugHealAll,
};
