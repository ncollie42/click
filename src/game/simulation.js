// Owns all mutable gameplay and showcase state. Commands mutate it; render/UI queries only read it.
// update() dispatches to explicit normal/showcase pipelines; browser effects leave through connect().

import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,BUILD_MARGIN,
  CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,GRID_COLS,GRID_ROWS,
  FOOTPRINT_1x1,RESOURCE_FOOTPRINT,
  RESOURCE_KINDS,CHEST,FEED_XP,LEVEL_CURVE,SKILL_POINT_LEVELS,CARD_BUFFS,CARD_CONSUMABLES,
  HOUSE_SLOTS,HOUSE_COST,HOUSE_COST_ESCALATION,WORKER_SPAWN_TIME,RESOURCE_NODE_JOB_SLOTS,BLUEPRINT_JOB_SLOTS,
  WORKER_LEASH,WORKER_MELEE,WORKER_SPEED,WORKER_HP,WORKER_DAMAGE,WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_CARRY,
  BUILDING_TYPES,UPGRADES,TOWER_VARIANTS,
  ENEMY_TYPES,ENEMY_SPAWN_RADIUS,
  ENEMY_POOL,
  NIGHT_WAVE_SPAWNS,NIGHT_WAVE_WINDOW,NIGHT_ENEMY_CAP,NIGHT_TIER_BONUS_SPAWNS,NIGHT_WAVE_RECIPES,
  DAY_DURATION,NIGHT_OVERLAY_ALPHA,LIGHT_FADE_TIME,
  KING,STEADY_HAND_RATE,FIREBALL
} from "./data.js";
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCellBounds,footprintWorldRect,footprintInWorldBounds
} from "./grid.js";
import {
  buildStarterWorld,LAND,WATER,TERRAIN_ORDER,TERRAIN_CELL_SIZE,TERRAIN_COLS,TERRAIN_ROWS,TERRAIN_ORIGIN_X,TERRAIN_ORIGIN_Y,
  terrainAtRasterCell as queryTerrainAtRasterCell,terrainAtWorldPoint as queryTerrainAtWorldPoint,
  validateTerrainTags,worldRectEntirelyOnLand
} from "./authored-map.js";
// The authored skill graph: shape only. This module owns state.skillTree over it, never the nodes.
import {SKILL_NODES,SKILL_EDGES,SKILL_TREE_ROOT_ID,SKILL_NODES_BY_ID,SKILL_NEIGHBORS} from "./skill-tree-data.js";
// Authored showcase coordinates are immutable input; all live fixture objects remain owned here.
import {SHOWCASE_MANIFEST} from "./showcase-data.js";
// The authored card catalog: the draft reads it and NEVER writes it — a taken card tallies a
// stack in state.draft, and cards.js keeps its implemented/inPool flags as authored.
import {CARDS,RARITY_WEIGHTS,cardById} from "./cards.js";

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
  builderSourceRadius:300, // blueprint-centered loose-drop scan [slider vBuilderRadius]
  recruitRadius:200, // blueprint guard recruitment radius           [slider vRecruitRadius]
  fleeHpThreshold:1, // worker hp that triggers the survival interrupt
};

// ── effect boundary ─────────────────────────────────────────────────────────
// The simulation never talks to the browser. Everything a player HEARS or SEES
// outside the world itself — toasts, sounds, the pause badge, the game-over
// card, the placement cursor, the upgrade panel — leaves through this injected
// record, installed once by the adapter in src/main.js via connect().
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
  levelChanged(){},          // xp progress or the level itself moved
  draftChanged(){},          // an offer appeared, was consumed, or was replaced by the next one
  handChanged(){},           // the held-card list moved: a card arrived, was spent, or lost a charge
  buildHudChanged(){},       // placement mode was armed or cleared (the crosshair, the lifted card)
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
// One-hit, no-yield vegetation. The array is render-facing; the cell map owns fast pointer lookup.
const grass = [];
const grassByCell = new Map();
let vegetationRevision = 0;
const resourceDrops = [];
const buildings = [];
// Unopened chest ownership is exclusive: this collection owns placed chests; held chests are
// temporarily owned only by state.heldObject. Destruction removes identity permanently before payout.
// Normal lifetime is world seed until pickup/destruction/page reload; showcase rebuild replaces fixtures.
const chests = [];
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
// Detached impact snapshots. Damage owns creation/age; overlay.js only projects and styles them.
// `critical` is carried now so future crit resolution changes the hit call, not this data flow.
const damageNumbers = [];
let damageNumberSequence=0;
// Deterministic validation/debug seam: only the next outcome tag is held, never resource contents.
// Destruction consumes and clears it before rolling the authored weighted payout.
let forcedChestOutcome=null;
const state = {
  runMode:"normal",
  mouse:{x:W/2,y:H/2,inside:false},
  carried:{wood:0,stone:0,dust:0,coin:0,diamond:0}, stored:{wood:0,stone:0,dust:0,coin:0,diamond:0}, workers:[], enemies:[],
  // xp is the run TOTAL ever fed; levelXp is only the progress into the current level, so the two
  // never have to be reconstructed from each other. Both are written by feedBase() alone.
  xp:0,levelXp:0,level:0,skillPoints:0,
  // The draft's whole run ledger: queued level-ups, queued dawn rewards, the live 3-card offer and
  // which kind of offer it is, buff stacks taken, and the two banked consumable effects. Blueprints
  // keep no ledger at all — a plan is not an unlock, so the pool may offer the same one again.
  // Authored tables stay untouched.
  draft:{queue:0,dawnQueue:0,offer:null,offerKind:null,buffs:{},calmNight:false,dayBonus:0},
  // ── the hand ──
  // Every card the player is HOLDING, oldest first. One entry per id: {id, count, charges} where
  // count is how many copies are held and charges is the partially-spent kit's remaining placements
  // (null when the top copy is untouched). Written only by the hand helpers below.
  hand:[],
  // The card currently steering state.buildMode, or null: {id, type, cast}. `type` is the authored
  // BUILDING_TYPES key whose ghost/footprint the placement flow draws; `cast` (fireball) replaces
  // "leave a building" with an instant effect at the anchor.
  cardTargeting:null,
  baseHp:100,baseMax:100,gameOver:false,paused:false,draftPaused:false,coinTimer:6,basePulse:0,buildMode:null,capacity:5,toastTimer:0,collectCooldown:0,collecting:false,
  // elapsed is simulated run time. remaining is the authoritative DAY countdown only; night has
  // no deadline and ends from active-wave clearance after the frame's complete combat pipeline.
  clock:{phase:"day",remaining:DAY_DURATION,completedNights:0,light:0,elapsed:0},
  // activeNightNumber owns the generation currently eligible to gate dawn. Scheduled enemies copy
  // it to enemy.waveNightNumber; manual/showcase enemies deliberately omit that field.
  nightWave:{upcomingRecipe:null,activeRecipe:null,totalSpawns:0,remainingSpawns:0,elapsed:0,nextSpawnAt:0,nightNumber:0,activeNightNumber:null},
  camera:{x:BASE.x,y:BASE.y,zoom:1,panning:false,lastX:0,lastY:0}, keys:new Set(),
  upgradeMenu:{building:null,selected:null,kind:null},primaryClick:{held:false,audioCooldown:0},heldObject:null,showcaseFocus:null,
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
  invulnBase:false,         // enemy hits on the base subtract nothing
  instantWorkers:false,     // houses ignore their spawn timer
  groundSourcing:true,      // builders prefer loose drops before covered storage
  builderSelfSupply:true,   // starved builders mine one bounded, needed resource at a time
  blueprintRecruiting:true, // incomplete buildings borrow nearby idle guards
  idleSeeksWork:true         // house-posted guards fill vacant durable jobs
};

// ── Global upgrade ownership flow ──
// Legitimate writes: completed obelisks set building.upgrades[id] in dropToUpgrade().
// Gameplay reads:    globalUpgradeEnabled() is pure obelisk ownership; there is no override map.
function legitimateGlobalUpgradeOwned(id){return buildings.some(building=>building.complete&&building.type==="obelisk"&&building.upgrades[id]);}
function globalUpgradeEnabled(id){return legitimateGlobalUpgradeOwned(id);}
// THE night difficulty dial, re-derived from the level rather than stored: every third level opens
// the next recipe tier and adds a bonus spawn batch, and tier 4 is the authored ceiling.
function waveTier(){return Math.min(4,Math.floor(state.level/3));}
// One night's spawn quota, calm-night discount included. The discount is consumed by whoever sets
// a wave up, so a card drafted at night shrinks the NEXT wave, never the one already running.
function nightSpawnTotal(){const total=NIGHT_WAVE_SPAWNS+waveTier()*NIGHT_TIER_BONUS_SPAWNS;return state.draft.calmNight?Math.max(1,Math.floor(total*CARD_CONSUMABLES.calmNightFactor)):total;}
/** Living scheduled enemies from this night only. Manual/debug and showcase enemies have no
 * waveNightNumber, while survivors from a force-ended older night retain their retired identity. */
function livingActiveWaveEnemies(){
  const activeNightNumber=state.nightWave.activeNightNumber;
  return activeNightNumber===null?0:state.enemies.reduce((count,enemy)=>count+(enemy.hp>0&&enemy.waveNightNumber===activeNightNumber?1:0),0);
}
function chooseUpcomingNight(){
  const recipes=NIGHT_WAVE_RECIPES.filter(recipe=>recipe.minTier<=waveTier());
  state.nightWave.upcomingRecipe=recipes[(Math.random()*recipes.length)|0];
}
chooseUpcomingNight();

// ── Initial spatial ownership ──
// authored-map.js returns only cell tags/coordinates. This module materializes those records into
// existing mutable runtime shapes and keeps the copied terrain array private and frozen for the run.
let terrainStorage=Object.freeze([]),terrainRevision=0,terrainRuntime=null,raisedStorage=new Uint8Array(GRID_COLS*GRID_ROWS);
let terrainDescriptor=Object.freeze({width:W,height:H,terrainCellSize:TERRAIN_CELL_SIZE,terrainOriginX:TERRAIN_ORIGIN_X,terrainOriginY:TERRAIN_ORIGIN_Y,terrainCols:TERRAIN_COLS,terrainRows:TERRAIN_ROWS,terrainOrder:TERRAIN_ORDER,revision:0,targets:null});
function installTerrain(tags,metadata={}){
  // Reject producer defects before changing any installed runtime ownership.
  validateTerrainTags(tags,TERRAIN_COLS*TERRAIN_ROWS);
  terrainStorage=Object.freeze([...tags]);terrainRevision++;
  // Presentational one-level raised layer at placement-cell resolution (authored maps only;
  // showcase all-land installs none). Gameplay ignores it: placement/movement stay 2D.
  const raisedSource=Array.isArray(metadata.raised)&&metadata.raised.length===GRID_COLS*GRID_ROWS?metadata.raised:null;
  raisedStorage=raisedSource?Uint8Array.from(raisedSource,value=>value===1?1:0):new Uint8Array(GRID_COLS*GRID_ROWS);
  terrainDescriptor=Object.freeze({...terrainDescriptor,revision:terrainRevision,seed:(metadata.seed??0)>>>0,targets:metadata.targets||null});
  terrainRuntime=Object.freeze({...terrainDescriptor,terrain:terrainStorage});
}
function installAllLandTerrain(){installTerrain(Array(terrainDescriptor.terrainCols*terrainDescriptor.terrainRows).fill(LAND));}
function replaceGrass(cells){
  grass.length=0;grassByCell.clear();
  for(const cell of cells){const {x,y}=cellToWorld(cell.cx,cell.cy),tuft={x,y,hp:1,max:1,variant:cell.variant??0};grass.push(tuft);grassByCell.set(cell.cy*GRID_COLS+cell.cx,tuft);}
  vegetationRevision++;
}
function materializeWorld(blueprint){
  installTerrain(blueprint.terrain,blueprint);
  trees.length=rocks.length=diamonds.length=chests.length=0;replaceGrass(blueprint.grass||[]);
  blueprint.trees.forEach((cell,index)=>{const {x,y}=cellToWorld(cell.cx,cell.cy);trees.push({x,y,hp:100,max:100,stump:0,shake:0,variant:cell.variant??index%3,footprint:RESOURCE_FOOTPRINT});});
  blueprint.rocks.forEach(cell=>{const {x,y}=cellToWorld(cell.cx,cell.cy);rocks.push({x,y,hp:70,max:70,depleted:0,shake:0,footprint:RESOURCE_FOOTPRINT});});
  blueprint.diamonds.forEach(cell=>{const {x,y}=cellToWorld(cell.cx,cell.cy);diamonds.push({x,y,hp:25,max:25,depleted:0,shake:0,footprint:RESOURCE_FOOTPRINT});});
  blueprint.chests.forEach(cell=>{const {x,y}=cellToWorld(cell.cx,cell.cy);chests.push({x,y,hp:CHEST.maxHp,max:CHEST.maxHp,shake:0,footprint:CHEST.footprint});});
}
function terrainAtRasterCell(terrainX,terrainY){return queryTerrainAtRasterCell(terrainRuntime,terrainX,terrainY);}
function terrainRaisedAtCell(cx,cy){return Number.isInteger(cx)&&Number.isInteger(cy)&&cx>=0&&cy>=0&&cx<GRID_COLS&&cy<GRID_ROWS&&raisedStorage[cy*GRID_COLS+cx]===1;}
function terrainAtWorldPoint(worldX,worldY){return queryTerrainAtWorldPoint(terrainRuntime,worldX,worldY);}
function terrainWorldRectEntirelyOnLand(rect){return worldRectEntirelyOnLand(terrainRuntime,rect);}
function terrainMetadata(){return terrainDescriptor;}
function vegetationMetadata(){return Object.freeze({revision:vegetationRevision,count:grass.length});}
// The world is authored data, not an algorithm: src/game/maps/starter.map.json,
// edited in tools/map-editor.html. Startup is fully deterministic.
materializeWorld(buildStarterWorld());

const RUN_MODES=new Set(["normal","showcase"]);
const RESOURCE_KIND_SET=new Set(RESOURCE_KINDS);
let initializedMode=null;
function invariant(condition,message){if(!condition)throw new Error("simulation invariant: "+message);}
function assertCombatKind(target){
  invariant(target&&["enemy","damage-dummy"].includes(target.combatKind),"unknown combat kind "+target?.combatKind);
  return target.combatKind;
}
function assertHeldKind(held){
  invariant(held&&["worker","building","chest","showcase-prop"].includes(held.kind),"unknown held kind "+held?.kind);
  return held.kind;
}
function makeShowcaseWorker(f,index){
  // homePost is null or {job,jobTarget,postX,postY}; temporary jobs restore that saved assignment.
  return {x:f.x,y:f.y,postX:f.x,postY:f.y,spawnSource:null,job:f.job,jobTarget:null,homePost:null,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:resourceCounts(),hp:WORKER_HP,attackCooldown:0,hitCooldown:0,step:index*.4,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,reposting:false,displayUnit:true,displayTool:f.tool||null,showcaseKey:"worker:"+f.id,showcaseLabel:f.label,showcaseSection:f.section};
}
function clearShowcaseLive(){
  cancelHeldObject();closeUpgradeMenu();resetChop();state.showcaseFocus=null;
  trees.length=rocks.length=diamonds.length=resourceDrops.length=buildings.length=chests.length=damageDummies.length=showcaseProps.length=showcaseLabelRecords.length=workerCorpses.length=particles.length=damageNumbers.length=0;replaceGrass([]);state.workers.length=state.enemies.length=0;
  invariant(!state.heldObject,"held object survived showcase teardown");
}
function buildShowcaseFixtures(){
  clearShowcaseLive();
  for(const f of SHOWCASE_MANIFEST.resourceNodes){const common={x:f.x,y:f.y,hp:10,max:10,shake:0,footprint:RESOURCE_FOOTPRINT,showcaseKey:"resource-node:"+f.id,showcaseLabel:f.label,showcaseSection:f.section};if(f.id==="wood")trees.push({...common,stump:0,variant:0});else if(f.id==="stone")rocks.push({...common,depleted:0});else diamonds.push({...common,depleted:0});}
  for(const f of SHOWCASE_MANIFEST.looseResources)resourceDrops.push({kind:f.id,x:f.x,y:f.y,groundY:f.y,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null,showcaseKey:"loose-resource:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  for(const f of SHOWCASE_MANIFEST.chests)chests.push({x:f.x,y:f.y,hp:CHEST.maxHp,max:CHEST.maxHp,shake:0,footprint:CHEST.footprint,showcaseKey:"chest:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  const addComplete=(type,x,y,label,section,key)=>{const b=createBuilding(type,x,y);b.complete=true;b.pulse=0;b.showcaseKey=key;b.showcaseLabel=label;b.showcaseSection=section;if(type==="tower"){const v=TOWER_VARIANTS.basic;b.tower={variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:v.maxHp,maxHp:v.maxHp};}if(type==="house")b.spawnTimer=WORKER_SPAWN_TIME;buildings.push(b);return b;};
  for(const f of SHOWCASE_MANIFEST.buildings)addComplete(f.id,f.x,f.y,f.label,f.section,"building:"+f.id);
  for(const f of SHOWCASE_MANIFEST.towers){const b=addComplete("tower",f.x,f.y,TOWER_VARIANTS[f.id].name,f.section,"tower:"+f.id),v=TOWER_VARIANTS[f.id];b.tower={variant:f.id,cooldown:0,flash:0,hitFlash:0,hp:v.maxHp,maxHp:v.maxHp};}
  for(const f of SHOWCASE_MANIFEST.progress){const b=createBuilding(f.type,f.x,f.y);b.showcaseKey="progress:"+f.id;b.showcaseLabel=f.label;b.showcaseSection=f.section;if(f.state==="blueprint"){b.complete=false;b.delivered={wood:Math.floor(b.cost.wood/2),stone:Math.floor(b.cost.stone/2)};}else{const v=TOWER_VARIANTS[f.variant];b.complete=true;b.tower={variant:f.variant,cooldown:0,flash:0,hitFlash:0,hp:v.maxHp,maxHp:v.maxHp};const cost=TOWER_VARIANTS[f.upgrade].cost;b.activeUpgrade={id:f.upgrade,kind:"tower",delivered:Object.fromEntries(RESOURCE_KINDS.map(k=>[k,Math.floor((cost[k]||0)/2)]))};}buildings.push(b);}
  SHOWCASE_MANIFEST.enemies.forEach((f,i)=>{const d=ENEMY_TYPES[f.id];state.enemies.push({combatKind:"enemy",type:f.id,x:f.x,y:f.y,hp:d.hp,max:d.hp,attackCooldown:0,healCooldown:1,wob:i*.5,flash:0,shotFlash:0,healFlash:0,status:{burn:null,slow:null},retaliationTower:null,displayUnit:true,showcaseKey:"enemy:"+f.id,showcaseLabel:d.name,showcaseSection:f.section});});
  SHOWCASE_MANIFEST.workers.forEach((f,i)=>state.workers.push(makeShowcaseWorker(f,i)));
  for(const f of SHOWCASE_MANIFEST.dummies)damageDummies.push({combatKind:"damage-dummy",id:f.id,x:f.x,y:f.y,homeX:f.homeX,homeY:f.homeY,hp:f.hp,max:f.hp,flash:0,defeatedTimer:0,status:{burn:null,slow:null},recentDamage:0,hitCount:0,showcaseKey:"dummy:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  state.showcaseFocus=damageDummies[0]||null;
  for(const f of SHOWCASE_MANIFEST.props)showcaseProps.push({id:f.id,model:f.model,x:f.x,y:f.y,homeX:f.x,homeY:f.y,footprint:f.footprint,showcaseKey:"prop:"+f.id,showcaseLabel:f.label,showcaseSection:f.section});
  showcaseLabelRecords.push(
    {key:"fixed:base",entity:BASE,label:"base",section:"units",height:88},
    {key:"fixed:king",entity:state.king,label:"king",section:"units",height:34}
  );
  for(const items of [[...trees,...rocks,...diamonds],resourceDrops,chests,buildings,state.workers,state.enemies,damageDummies,showcaseProps])
    for(const entity of items)if(entity.showcaseLabel)showcaseLabelRecords.push({key:entity.showcaseKey,entity,label:entity.showcaseLabel,section:entity.showcaseSection,height:entity.type==="tower"?70:38});
  invariant(new Set(showcaseLabelRecords.map(record=>record.key)).size===showcaseLabelRecords.length,"duplicate showcase label key");
  showcaseRevision++;
  validateSimulationInvariants();
}
// First initialization selects a closed run mode. Repeating the same mode is idempotent for normal
// and rebuilds authored fixtures for showcase; switching an installed simulation is rejected.
function resetShowcaseEconomy(){state.xp=0;state.levelXp=0;state.level=0;state.skillPoints=0;state.draft={queue:0,dawnQueue:0,offer:null,offerKind:null,buffs:{},calmNight:false,dayBonus:0};state.draftPaused=false;state.hand.length=0;state.cardTargeting=null;effects.levelChanged();effects.draftChanged();effects.handChanged();effects.phaseHudChanged();effects.skillTreeChanged();}
// ── STRAWMAN, for owner tuning ──────────────────────────────────────────────
// With the build shop gone, cards are the ONLY way to put a building on the ground, while level-ups
// deliberately offer buffs rather than blueprints. This list prevents a fresh run from waiting for
// its first cleared wave to build: one house (workers), one lumber camp and one quarry
// (income), one basic tower chassis (the first night). It is a DESIGN GUESS — change the ids, the
// counts, or delete the line entirely; nothing else reads it.
const STARTING_HAND=["bpHouse","bpLumber","bpQuarry","bpTower"];
let startingHandDealt=false;
export function initializeRunMode(mode="normal"){
  if(!RUN_MODES.has(mode))throw new Error("invalid run mode: "+mode);
  if(initializedMode&&initializedMode!==mode)throw new Error("run mode already initialized as "+initializedMode);
  const firstInitialization=initializedMode===null;
  initializedMode=mode;state.runMode=mode;
  if(firstInitialization)state.nightWave.activeNightNumber=null;
  if(mode==="normal"){
    invariant(!damageDummies.length&&!showcaseProps.length,"normal mode contains showcase entities");
    // Dealt through addToHand() — the same writer takeCard() uses for a drafted card — so a seeded
    // card and a drafted one are literally the same hand entry. Once per run; re-initializing the
    // same mode stays idempotent. The showcase sandbox is never dealt cards and is seeded nothing.
    if(!startingHandDealt){startingHandDealt=true;for(const id of STARTING_HAND)addToHand(id);}
    validateSimulationInvariants();return;
  }
  installAllLandTerrain();
  state.gameOver=false;state.paused=false;state.showcaseFocus=null;state.baseHp=state.baseMax;resetShowcaseEconomy();state.clock={phase:"day",remaining:DAY_DURATION,completedNights:0,light:0,elapsed:0};state.nightWave.activeRecipe=null;state.nightWave.totalSpawns=0;state.nightWave.remainingSpawns=0;state.nightWave.elapsed=0;state.nightWave.nextSpawnAt=0;state.nightWave.activeNightNumber=null;state.camera.x=SHOWCASE_MANIFEST.sections.towers.x;state.camera.y=SHOWCASE_MANIFEST.sections.towers.y;state.camera.zoom=SHOWCASE_MANIFEST.sections.towers.zoom;state.keys.clear();state.buildMode=null;state.carried=resourceCounts();state.stored=resourceCounts();buildShowcaseFixtures();clampCamera();effects.pauseChanged(false);
}
export function rebuildShowcase(){if(state.runMode!=="showcase")return false;resetShowcaseEconomy();installAllLandTerrain();buildShowcaseFixtures();return true;}

export function validateSimulationInvariants(){
  invariant(RUN_MODES.has(state.runMode),"invalid run mode "+state.runMode);
  invariant(Object.isFrozen(terrainStorage),"terrain storage is mutable");
  invariant(terrainStorage.length===terrainDescriptor.terrainCols*terrainDescriptor.terrainRows,"terrain dimensions disagree with metadata");
  invariant(terrainStorage.every(tag=>tag===LAND||tag===WATER),"unknown terrain tag");
  invariant(terrainDescriptor.width===W&&terrainDescriptor.height===H&&terrainDescriptor.terrainCellSize===TERRAIN_CELL_SIZE&&terrainDescriptor.terrainOriginX===TERRAIN_ORIGIN_X&&terrainDescriptor.terrainOriginY===TERRAIN_ORIGIN_Y&&terrainDescriptor.terrainCols===TERRAIN_COLS&&terrainDescriptor.terrainRows===TERRAIN_ROWS&&terrainDescriptor.terrainOrder===TERRAIN_ORDER,"terrain metadata drifted");
  invariant(Number.isInteger(terrainDescriptor.revision)&&terrainDescriptor.revision>0,"invalid terrain revision");
  invariant(Number.isFinite(state.baseHp)&&state.baseHp>=0&&state.baseHp<=state.baseMax,"illegal base health");
  invariant(Number.isInteger(state.xp)&&state.xp>=0,"illegal xp");
  invariant(Number.isInteger(state.level)&&state.level>=0,"illegal level");
  invariant(Number.isFinite(state.levelXp)&&state.levelXp>=0&&state.levelXp<levelCost(state.level),"illegal level progress");
  invariant(Number.isInteger(state.skillPoints)&&state.skillPoints>=0,"illegal skill points");
  invariant(["day","night"].includes(state.clock.phase),"illegal phase "+state.clock.phase);
  invariant(Number.isFinite(state.clock.remaining)&&state.clock.remaining>=0,"illegal phase countdown");
  const offer=state.draft.offer;
  invariant(offer===null||(Array.isArray(offer)&&offer.length>0&&offer.length<=3&&new Set(offer).size===offer.length&&offer.every(id=>cardById[id]?.inPool)),"illegal draft offer");
  invariant(offer===null?state.draft.offerKind===null:DRAFT_KINDS.includes(state.draft.offerKind),"draft offer kind disagrees with the pending offer");
  invariant(offer===null||offer.every(id=>DRAFT_CATEGORIES[state.draft.offerKind].includes(cardById[id].category)),"draft offer category disagrees with its kind");
  invariant(state.draftPaused===!!offer,"draft pause flag disagrees with the pending offer");
  // The hand: one stack per id, every id authored, every count real, partial kits mid-spend only.
  invariant(new Set(state.hand.map(entry=>entry.id)).size===state.hand.length,"the hand holds two stacks of one card");
  for(const entry of state.hand){
    invariant(cardById[entry.id],"unknown card in hand: "+entry.id);
    invariant(["consumable","blueprint"].includes(cardById[entry.id].category),"only consumables and blueprints may be held");
    invariant(Number.isInteger(entry.count)&&entry.count>=1,"illegal hand stack count for "+entry.id);
    invariant(entry.charges===null||(Number.isInteger(entry.charges)&&entry.charges>0&&entry.charges<=(cardById[entry.id].charges??1)),"illegal remaining charges for "+entry.id);
  }
  const targeting=state.cardTargeting;
  // Cards are the only entry into placement now, so an armed ghost with no card behind it is a bug.
  invariant(!state.buildMode||!!targeting,"placement is armed with no card driving it");
  if(targeting){
    invariant(state.buildMode===targeting.type,"card targeting lost its placement mode");
    const entry=handEntry(targeting.id);
    invariant(entry&&entry.charges>0,"card targeting outlived the card it is placing");
  }
  const collections=[trees,rocks,diamonds,grass,resourceDrops,chests,buildings,state.workers,state.enemies,damageDummies,showcaseProps,particles,damageNumbers];
  for(const collection of collections)for(const item of collection)invariant(Number.isFinite(item.x)&&Number.isFinite(item.y),"non-finite entity coordinates");
  const wave=state.nightWave;
  invariant(Number.isInteger(wave.nightNumber)&&wave.nightNumber>=0,"illegal night number");
  invariant(wave.activeNightNumber===null||(Number.isInteger(wave.activeNightNumber)&&wave.activeNightNumber>0&&wave.activeNightNumber===wave.nightNumber),"illegal active wave identity");
  invariant((state.clock.phase==="night")===(wave.activeNightNumber!==null),"active wave identity disagrees with phase");
  invariant(Number.isInteger(wave.totalSpawns)&&wave.totalSpawns>=0,"illegal wave total");
  invariant(Number.isInteger(wave.remainingSpawns)&&wave.remainingSpawns>=0&&wave.remainingSpawns<=wave.totalSpawns,"illegal remaining wave spawns");
  if(state.clock.phase==="night")invariant(NIGHT_WAVE_RECIPES.includes(wave.activeRecipe)&&wave.totalSpawns>0,"night has no authored active recipe");
  for(const enemy of state.enemies){
    invariant(assertCombatKind(enemy)==="enemy","non-enemy in enemy collection");
    invariant(ENEMY_TYPES[enemy.type],"unknown enemy type "+enemy.type);
    invariant(enemy.hp>=0&&enemy.hp<=enemy.max,"illegal enemy health");
    if(enemy.waveNightNumber!==undefined){
      invariant(Number.isInteger(enemy.waveNightNumber)&&enemy.waveNightNumber>0&&enemy.waveNightNumber<=wave.nightNumber,"malformed wave membership");
      invariant(!enemy.displayUnit&&!enemy.showcaseKey,"showcase enemy has wave membership");
    }
  }
  for(const dummy of damageDummies){invariant(assertCombatKind(dummy)==="damage-dummy","non-dummy in dummy collection");invariant(dummy.hp>=0&&dummy.hp<=dummy.max,"illegal dummy health");}
  invariant(grassByCell.size===grass.length,"grass cell index disagrees with vegetation collection");
  for(const tuft of grass){const cell=worldToCell(tuft.x,tuft.y),center=cellToWorld(cell.cx,cell.cy);invariant(tuft.x===center.x&&tuft.y===center.y&&tuft.hp===1&&tuft.max===1,"illegal grass tuft");invariant(grassByCell.get(cell.cy*GRID_COLS+cell.cx)===tuft,"grass cell index lost identity");}
  for(const nodes of [trees,rocks,diamonds])for(const node of nodes){
    const cell=worldToCell(node.x,node.y),center=cellToWorld(cell.cx,cell.cy);
    invariant(node.x===center.x&&node.y===center.y,"resource is not cell aligned");
    invariant(footprintInWorldBounds(cell.cx,cell.cy,node.footprint||RESOURCE_FOOTPRINT),"resource footprint is out of bounds");
    invariant(terrainWorldRectEntirelyOnLand(footprintWorldRect(cell.cx,cell.cy,node.footprint||RESOURCE_FOOTPRINT)),"resource is not on land");
  }
  invariant(new Set(chests).size===chests.length,"duplicate chest ownership");
  for(const chest of chests){
    const cell=worldToCell(chest.x,chest.y),center=cellToWorld(cell.cx,cell.cy);
    invariant(chest.x===center.x&&chest.y===center.y,"chest is not cell aligned");
    invariant(footprintInWorldBounds(cell.cx,cell.cy,chest.footprint),"chest footprint is out of bounds");
    invariant(terrainWorldRectEntirelyOnLand(footprintWorldRect(cell.cx,cell.cy,chest.footprint)),"chest is not on land");
    invariant(Number.isInteger(chest.hp)&&chest.hp>0&&chest.hp<=chest.max&&chest.max===CHEST.maxHp,"illegal chest health");
    invariant(chest.footprint===CHEST.footprint,"invalid chest footprint");
    invariant(!("contents" in chest)&&!("outcome" in chest),"chest contents rolled before destruction");
    invariant(canPlace(chest.x,chest.y,null,null,null,chest),"placed chest overlaps another occupant");
  }
  for(const number of damageNumbers){invariant(Number.isFinite(number.amount)&&number.amount>0,"illegal damage number amount");invariant(Number.isFinite(number.age)&&number.age>=0,"illegal damage number age");invariant(typeof number.critical==="boolean","illegal damage number crit tag");invariant(["dealt","received"].includes(number.tone),"illegal damage number tone");}
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
  // A designated variant is a promise made to an unfinished tower site; completeBuilding() turns it
  // into the upgrade job and clears it, so it can never outlive the construction it was made to.
  for(const building of buildings)if(building.plannedVariant){
    invariant(building.type==="tower"&&TOWER_VARIANTS[building.plannedVariant],"illegal designated tower variant "+building.plannedVariant);
    invariant(!building.complete,"a designated tower variant outlived its construction");
  }
  for(const id of state.skillTree.selected)invariant(state.skillTree.revealed.has(id)&&SKILL_NODES_BY_ID[id],"selected skill is not revealed");
  for(const id of state.skillTree.revealed)invariant(SKILL_NODES_BY_ID[id],"unknown revealed skill "+id);
  if(state.heldObject){const held=state.heldObject,kind=assertHeldKind(held);invariant(Number.isFinite(held.originX)&&Number.isFinite(held.originY),"invalid held origin");if(kind==="worker")invariant(!state.workers.includes(held.object),"held worker still installed");else if(kind==="building")invariant(!buildings.includes(held.object),"held building still installed");else if(kind==="chest"){invariant(!chests.includes(held.object),"held chest still installed");invariant(Number.isFinite(held.object.x)&&Number.isFinite(held.object.y),"held chest has non-finite coordinates");invariant(Number.isInteger(held.object.hp)&&held.object.hp>0&&held.object.hp<=held.object.max&&held.object.max===CHEST.maxHp,"held dead chest");invariant(held.object.footprint===CHEST.footprint,"held chest has invalid footprint");}else invariant(showcaseProps.includes(held.object),"held prop lost ownership");}
  if(state.runMode==="normal")invariant(!damageDummies.length&&!showcaseProps.length&&!showcaseLabelRecords.length,"normal mode contains showcase entities");
  else{invariant(grass.length===0&&grassByCell.size===0,"showcase contains production vegetation");
    invariant(state.enemies.every(enemy=>enemy.displayUnit)&&state.workers.every(worker=>worker.displayUnit),"showcase display units are not inert");
    for(const record of showcaseLabelRecords)if(record.key.startsWith("chest:"))invariant(chests.includes(record.entity),"stale showcase chest label");
  }
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
  // Modal/pause teardown must not strand a chest outside placed ownership; showcase props keep their
  // existing authored-coordinate cancellation contract.
  if(heldChest()||heldProp())cancelHeldObject();
  if(cancelPlacement){state.buildMode=null;state.cardTargeting=null;effects.buildHudChanged();}
}
function togglePause(){
  if(state.gameOver)return;
  state.paused=!state.paused;stopGameplayInput();
  if(state.paused)closeUpgradeMenu();
  effects.pauseChanged(state.paused);sound(state.paused?180:360,.06);
}
function cancelBuildMode(){
  if(!state.buildMode)return false;
  // A cancelled card keeps whatever charges it had not placed: the hand entry was never removed,
  // so dropping the targeting record alone leaves a partial card the player can play again.
  const card=state.cardTargeting&&handEntry(state.cardTargeting.id);
  state.buildMode=null;state.cardTargeting=null;effects.buildHudChanged();
  toast(card?cardById[card.id].text+" put away — "+card.charges+" charge"+(card.charges===1?"":"s")+" left":"placement cancelled");return true;
}

// A random point on the spawn ring around the base, preferring land but never failing:
// if the ring offers no land after bounded tries, the last candidate spawns anyway.
function randomSpawnPoint(){
  let candidate=null;
  for(let attempt=0;attempt<80;attempt++){
    const angle=Math.random()*Math.PI*2,radius=ENEMY_SPAWN_RADIUS*rand(.9,1.1);
    candidate={x:clamp(BASE.x+Math.cos(angle)*radius,BUILD_MARGIN,W-BUILD_MARGIN),y:clamp(BASE.y+Math.sin(angle)*radius,BUILD_MARGIN,H-BUILD_MARGIN)};
    if(terrainAtWorldPoint(candidate.x,candidate.y)===LAND)return candidate;
  }
  return candidate;
}
function spawnEnemy(enemyType=null){
  // Showcase is an authored inert gallery: the always-visible debugger command deliberately no-ops
  // rather than adding a production enemy that has no authored position or display-unit contract.
  if(state.runMode==="showcase")return;
  const type=enemyType||ENEMY_POOL[(Math.random()*ENEMY_POOL.length)|0],def=ENEMY_TYPES[type],{x,y}=randomSpawnPoint();
  state.enemies.push({combatKind:"enemy",type,x,y,hp:def.hp,max:def.hp,attackCooldown:0,healCooldown:rand(.5,2),wob:rand(0,6),flash:0,shotFlash:0,healFlash:0,status:{burn:null,slow:null},retaliationTower:null});
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
  // One crit roll per COMPLETED swing, so a critical hit and its damage number can never disagree.
  const kind=assertCombatKind(target),critical=critHit(),damage=clickDamage()*(critical?CARD_BUFFS.critMultiplier:1);
  if(kind==="damage-dummy")damageDummy(target,damage,"#d25b49",5,{critical});
  else if(kind==="enemy")damageEnemy(target,damage,"#d25b49",5,null,{announce:true,critical});
  else invariant(false,"unhandled combat kind "+kind);
  if(!quiet)sound(critical?820:610,.045);
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
    clearWorkerSelfSupply(worker);state.workers.splice(state.workers.indexOf(worker),1);
    state.heldObject={kind:"worker",object:worker,originX:worker.x,originY:worker.y};state.collecting=false;toast("worker lifted — release to assign");return true;
  }
  const building=buildings.find(item=>item.complete&&item.type==="tower"&&towerVariant(item).movable&&manualTowerButtonHit(item,x,y));
  if(building){state.heldObject={kind:"building",object:building,originX:building.x,originY:building.y};buildings.splice(buildings.indexOf(building),1);state.collecting=false;toast(towerVariant(building).name+" picked up — release right to place");return true;}
  // Explicit secondary-action priority: workers, movable Shock Towers, unopened chests,
  // showcase props, then loose-resource vacuuming.
  let chest=null,chestDistance=30;
  for(const candidate of chests){const d=distance(x,y,candidate.x,candidate.y);if(candidate.hp>0&&d<chestDistance){chest=candidate;chestDistance=d;}}
  if(chest){stopPrimaryClick();state.heldObject={kind:"chest",object:chest,originX:chest.x,originY:chest.y};chests.splice(chests.indexOf(chest),1);state.collecting=false;toast("unopened chest picked up — release right to place");return true;}
  if(state.runMode==="showcase"){
    const prop=showcaseProps.find(item=>distance(x,y,item.x,item.y)<24);
    if(prop){state.heldObject={kind:"showcase-prop",object:prop,originX:prop.x,originY:prop.y};state.collecting=false;toast(prop.id+" picked up — release right to place");return true;}
  }
  return false;
}
function heldWorker(){return state.heldObject?.kind==="worker"?state.heldObject.object:null;}
function heldBuilding(){return state.heldObject?.kind==="building"?state.heldObject.object:null;}
function heldChest(){return state.heldObject?.kind==="chest"?state.heldObject.object:null;}
function heldProp(){return state.heldObject?.kind==="showcase-prop"?state.heldObject.object:null;}
// Canonical completed-building assignment. Construction inheritance, placement, and vacancy filling share it.
function builtJobAssignment(building){
  if(building.type==="lumber"||building.type==="quarry")return {job:"staff",jobTarget:building,postX:building.x,postY:building.y+16};
  if(building.type==="stockpile")return {job:"haul",jobTarget:building,postX:building.x,postY:building.y+18};
  return {job:"guard",jobTarget:null,postX:building.x,postY:building.y+(building.type==="house"?23:18)};
}
function workerStaffsPost(worker,building){const assignment=builtJobAssignment(building);return worker.job===assignment.job&&worker.jobTarget===building;}
function resourceNodeKind(node){return trees.includes(node)?"wood":rocks.includes(node)?"stone":diamonds.includes(node)?"diamond":null;}
function assignedWorkers(target,excludeWorker=null){
  const candidates=state.workers.concat(heldWorker()&&!state.workers.includes(heldWorker())?[heldWorker()]:[]).filter(worker=>worker!==excludeWorker);
  if(buildings.includes(target))return candidates.filter(worker=>target.complete?workerStaffsPost(worker,target):worker.job==="build"&&worker.jobTarget===target);
  return candidates.filter(worker=>(worker.job==="harvest"&&worker.jobTarget?.node===target)||worker.selfSupply?.node===target);
}
/** Read-only assignment/reservation status for an active node or completed durable building. */
function workerOccupancyStatus(target,excludeWorker=null){
  if(state.runMode!=="normal")return null;
  const kind=resourceNodeKind(target);
  if(kind){if(!resourceIsActive(target,kind))return null;return {target,assigned:assignedWorkers(target,excludeWorker).length,capacity:RESOURCE_NODE_JOB_SLOTS};}
  if(!buildings.includes(target))return null;
  const capacity=target.complete?(BUILDING_TYPES[target.type].jobSlots||0):BLUEPRINT_JOB_SLOTS;if(!capacity)return null;
  return {target,assigned:assignedWorkers(target,excludeWorker).length,capacity};
}
function workerOccupancyAt(x,y){
  let nearest=null,best=Infinity;
  for(const nodes of [trees,rocks,diamonds])for(const node of nodes){const status=workerOccupancyStatus(node),d=distance(x,y,node.x,node.y);if(status&&d<38&&d<best){nearest=status;best=d;}}
  for(const building of buildings){const status=workerOccupancyStatus(building),d=distance(x,y,building.x,building.y);if(status&&d<42&&d<best){nearest=status;best=d;}}
  return nearest;
}
function installHeldAtOrigin(held){
  const object=held.object;object.x=held.originX;object.y=held.originY;
  const kind=assertHeldKind(held);
  if(kind==="worker")state.workers.push(object);
  else if(kind==="building")buildings.push(object);
  else if(kind==="chest")chests.push(object);
  else if(kind==="showcase-prop")invariant(showcaseProps.includes(object),"held prop left its owned collection");
  else invariant(false,"unhandled held kind "+kind);
}
function cancelHeldObject(){if(!state.heldObject)return;installHeldAtOrigin(state.heldObject);state.heldObject=null;}
// Assignment priority is resolved once so drop behavior and held-worker preview cannot drift.
function workerAssignmentAt(worker,x,y){
  if(x<20||y<20||x>W-20||y>H-20)return null;
  const near=predicate=>buildings.find(item=>predicate(item)&&distance(x,y,item.x,item.y)<42);
  const blueprint=near(item=>!item.complete),node=workerNodeAt(x,y),staff=near(item=>item.complete&&(item.type==="lumber"||item.type==="quarry")),stockpile=near(item=>item.complete&&item.type==="stockpile"),house=near(item=>item.complete&&item.type==="house");
  if(blueprint){const status=workerOccupancyStatus(blueprint,worker);if(status.assigned>=status.capacity)return null;return {job:"build",target:blueprint,postX:blueprint.x,postY:blueprint.y+20,zoneX:blueprint.x,zoneY:blueprint.y,zoneRadius:WORKER_LEASH};}
  if(node){const status=workerOccupancyStatus(node.node,worker);if(status.assigned>=status.capacity)return null;return {job:"harvest",target:node,postX:x,postY:y,zoneX:x,zoneY:y,zoneRadius:WORKER_LEASH};}
  if(staff){const status=workerOccupancyStatus(staff,worker);if(status.assigned>=status.capacity)return null;return {job:"staff",target:staff,postX:staff.x,postY:staff.y+16,zoneX:staff.x,zoneY:staff.y,zoneRadius:BUILDING_TYPES[staff.type].serviceRadius};}
  if(stockpile){const status=workerOccupancyStatus(stockpile,worker);if(status.assigned>=status.capacity)return null;return {job:"haul",target:stockpile,postX:stockpile.x,postY:stockpile.y+18,zoneX:stockpile.x,zoneY:stockpile.y,zoneRadius:storageServiceRadius(stockpile)};}
  if(house)return {job:"guard",target:null,postX:house.x,postY:house.y+23,zoneX:house.x,zoneY:house.y+23,zoneRadius:WORKER_LEASH};
  if(distance(x,y,BASE.x,BASE.y)<BASE.r+18)return {job:"haul",target:BASE,postX:BASE.x,postY:BASE.y+25,zoneX:BASE.x,zoneY:BASE.y,zoneRadius:BASE_ZONE};
  return {job:"guard",target:null,postX:x,postY:y,zoneX:x,zoneY:y,zoneRadius:WORKER_LEASH};
}
function assignWorker(worker,x,y){
  const assignment=workerAssignmentAt(worker,x,y);if(!assignment)return null;
  const scatterGuardLoad=worker.job==="guard"||worker.reposting;
  clearWorkerSelfSupply(worker);worker.x=x;worker.y=y;worker.postX=assignment.postX;worker.postY=assignment.postY;worker.job=assignment.job;worker.jobTarget=assignment.target;worker.homePost=null;worker.retaliationTarget=null;worker.returnAfterCombat=false;worker.fleeing=false;worker.fleeSafeTime=0;worker.reposting=false;worker.returning=false;worker.starved=false;
  if(scatterGuardLoad||worker.job!=="haul")for(const kind of RESOURCE_KINDS){while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,x+rand(-8,8),y+rand(-5,5));}}
  return worker.job;
}
function dropHeldObject(){
  const held=state.heldObject;if(!held)return false;
  if(held.kind==="worker"){
    const worker=held.object,result=state.mouse.inside&&assignWorker(worker,state.mouse.x,state.mouse.y);
    if(result){worker.staffingArrivedAt=null;state.workers.push(worker);const assignment=worker.job==="haul"?"haul to "+(worker.jobTarget===BASE?"base":"stockpile"):result;toast("worker assigned: "+assignment);}
    else{worker.x=held.originX;worker.y=held.originY;state.workers.push(worker);toast("invalid ground — worker returned");}
    state.heldObject=null;sound(260,.06);return true;
  }
  if(held.kind==="showcase-prop"){
    const prop=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
    if(anchor&&canPlace(anchor.x,anchor.y,null,null,prop)){prop.x=anchor.x;prop.y=anchor.y;toast(prop.id+" placed");}
    else{prop.x=held.originX;prop.y=held.originY;toast("invalid ground — "+prop.id+" returned");}
    invariant(showcaseProps.includes(prop),"placed prop left its owned collection");state.heldObject=null;sound(260,.06);return true;
  }
  if(held.kind==="chest"){
    const chest=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
    if(anchor&&canPlace(anchor.x,anchor.y,null,null,null,chest)){chest.x=anchor.x;chest.y=anchor.y;toast("unopened chest placed");}
    else{chest.x=held.originX;chest.y=held.originY;toast("invalid ground — chest returned");}
    chests.push(chest);state.heldObject=null;sound(260,.06);return true;
  }
  // Relocation validates the tower's own 3x3 footprint at the snapped anchor, excluding itself.
  // Only x/y are ever touched: cooldown, hp, variant and upgrade state ride along on the same object,
  // and an invalid drop restores the exact origin recorded at pickup.
  invariant(assertHeldKind(held)==="building","unhandled held drop kind "+held.kind);
  const building=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
  if(anchor&&canPlace(anchor.x,anchor.y,building.type,building)){building.x=anchor.x;building.y=anchor.y;clearGrassInFootprint(building.x,building.y,buildingFootprint(building.type));toast(towerVariant(building).name+" placed");}
  else{building.x=held.originX;building.y=held.originY;toast("invalid ground — tower returned");}
  buildings.push(building);state.heldObject=null;sound(260,.06);return true;
}
function activateManualTower(building){
  const tower=building.tower,variant=towerVariant(building);if(!variant.manual)return;
  if(tower.cooldown>0){toast(variant.name+" recharging: "+tower.cooldown.toFixed(1)+"s");return;}
  if(state.runMode==="showcase"&&!damageDummies.some(dummy=>dummy.defeatedTimer<=0&&distance(building.x,building.y,dummy.x,dummy.y)<=variant.effectRadius))return;
  tower.cooldown=towerCooldown(variant);tower.flash=.35;
  const damage=towerDamage(variant);
  eachTowerCombatTarget(enemy=>{
    if(distance(building.x,building.y,enemy.x,enemy.y)<=variant.effectRadius)damageCombatTarget(enemy,damage,variant.accent,7,building);
  });
  burst(building.x,building.y,variant.accent,24);toast("shock pulse fired");sound(variant.sound,.28);
}
function detonateBlast(building){
  for(const enemy of [...state.enemies]){
    const d=distance(building.x,building.y,enemy.x,enemy.y),radius=BUILDING_TYPES.blast.effectRadius;if(d>radius)continue;
    damageEnemy(enemy,d<radius*.5?BUILDING_TYPES.blast.innerDamage:BUILDING_TYPES.blast.damage,"#e39a3f",0);
  }
  for(let i=0;i<42;i++)particles.push({x:building.x,y:building.y,vx:rand(-180,180),vy:rand(-190,40),life:rand(.35,.9),col:i%2?"#e39a3f":"#b84b38"});
  buildings.splice(buildings.indexOf(building),1);toast("blast charge detonated");sound(70,.3);
}
function createBuilding(type,x,y){
  const def=BUILDING_TYPES[type],cost=type==="house"?nextHouseCost():{...def.cost};
  // plannedVariant: the tower variant a blueprint card designated for this site, accepted as an
  // upgrade job the moment construction finishes. Null on every ordinary build.
  return {type,x,y,cost,delivered:{wood:0,stone:0},storage:{wood:0,stone:0,dust:0,coin:0,diamond:0},upgrades:{},activeUpgrade:null,plannedVariant:null,tower:null,hazard:["spikes","landmine","tar"].includes(type)?{cooldown:0,flash:0}:null,complete:!!def.instant,pulse:1};
}

function chestAt(x,y){
  let target=null,best=32;
  for(const chest of chests){const d=distance(x,y,chest.x,chest.y);if(chest.hp>0&&d<best){target=chest;best=d;}}
  return target;
}
function grassAt(x,y){
  const center=worldToCell(x,y);let target=null,best=24;
  for(let cy=center.cy-1;cy<=center.cy+1;cy++)for(let cx=center.cx-1;cx<=center.cx+1;cx++){
    const tuft=grassByCell.get(cy*GRID_COLS+cx);if(!tuft)continue;const d=distance(x,y,tuft.x,tuft.y);if(d<best){target=tuft;best=d;}
  }
  return target;
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
  chest:  {kind:"break-chest",icon:"axe"},
  grass:  {kind:"cut-grass",icon:"axe"},
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
 * Priority is enemies, unopened chests, real resources, then one-hit grass.
 * Felled/depleted/removed targets never resolve.
 *
 * @returns {null|{target:object,kind:"chop"|"mine"|"break-chest"|"cut-grass"|"attack",resource:null|"wood"|"stone"|"diamond",icon:"axe"|"pickaxe"|"sword"}}
 */
function resolvePrimaryAction(x,y){
  const enemy=enemyAt(x,y);
  // enemyAt() selects the mode's attackable roster: production enemies normally, dummies in
  // showcase. The membership guard rejects stale references after death/reset/rebuild.
  if(enemy&&enemy.hp>0&&(assertCombatKind(enemy)==="damage-dummy"?damageDummies.includes(enemy):state.enemies.includes(enemy)))
    return {target:enemy,kind:PRIMARY_ACTIONS.enemy.kind,resource:null,icon:PRIMARY_ACTIONS.enemy.icon};
  const chest=chestAt(x,y);
  if(chest)return {target:chest,kind:PRIMARY_ACTIONS.chest.kind,resource:null,icon:PRIMARY_ACTIONS.chest.icon};
  const node=playerResourceAt(x,y);   // already skips stumps and depleted nodes
  if(node){const action=PRIMARY_ACTIONS[node.kind];return {target:node.target,kind:action.kind,resource:node.kind,icon:action.icon};}
  const tuft=grassAt(x,y);
  if(tuft)return {target:tuft,kind:PRIMARY_ACTIONS.grass.kind,resource:null,icon:PRIMARY_ACTIONS.grass.icon};
  return null;
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
  chopState.t+=dt*chopFillRate();
  if(chopState.t<TUNE.chopTime)return;
  chopState.t=0;
  const quiet=primary.audioCooldown>0;
  if(hit.kind==="attack")hitCombatTarget(hit.target,quiet);
  else if(hit.kind==="break-chest")hitChest(hit.target,quiet);
  else if(hit.kind==="cut-grass")hitGrass(hit.target,quiet);
  else hitResource(hit.target,hit.resource,false,quiet);
  if(!quiet)primary.audioCooldown=.25;
}
function leftClick(){
  if(state.gameOver||state.paused||heldChest())return;
  const m=state.mouse;
  // A played card owns the click outright, ahead of even the swing: unlike build mode — which the
  // player may leave armed while fighting — targeting was an explicit commitment made this second,
  // and a fireball aimed INTO a crowd must not turn into a punch at whoever stands nearest the
  // cursor. Right click still cancels it.
  if(state.cardTargeting){placeCardCharge(snapToCellCenter(m.x,m.y));return;}
  // Same resolver the hover ring and the hold timer read, so the press arms
  // exactly what was previewed. Resolved once up front; it is pure, and every
  // branch between here and the harvest fall-through returns before using it.
  const action=resolvePrimaryAction(m.x,m.y);
  // Attacking and chest breaking outrank placement; the press only arms their shared hold bar.
  if(action&&(action.kind==="attack"||action.kind==="break-chest")){beginChop(action);return;}
  // No dock branch below this line: state.buildMode is now only ever armed by a played card, and
  // the guard above already routed that click into placeCardCharge(). A buildMode with no
  // cardTargeting cannot exist, and the invariant check on state.cardTargeting enforces the pair.
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
  if(!action){toast("left click a chest, resource, or enemy");return;}
  // Harvesting/chest breaking no longer resolves on the press; updatePrimaryClick() fills the timer.
  beginChop(action);
}

function rollChestResource(){
  const total=RESOURCE_KINDS.reduce((sum,kind)=>sum+CHEST.weights[kind],0);
  let roll=Math.random()*total;
  for(const kind of RESOURCE_KINDS){roll-=CHEST.weights[kind];if(roll<0)return kind;}
  return RESOURCE_KINDS.at(-1);
}
function scatterChestReward(kind,x,y,wide,index=0,count=1){
  const angle=(index/count)*Math.PI*2+rand(-.28,.28),radius=wide?rand(52,126):rand(8,24);
  spawnResource(kind,clamp(x+Math.cos(angle)*radius,35,W-35),clamp(y+Math.sin(angle)*radius,35,H-35),null);
}
function destroyChest(chest){
  const at=chests.indexOf(chest);if(at<0)return false;
  chests.splice(at,1);if(chopState.target===chest)resetChop();
  if(chest.showcaseKey){
    const labelAt=showcaseLabelRecords.findIndex(record=>record.entity===chest);
    if(labelAt>=0){showcaseLabelRecords.splice(labelAt,1);showcaseRevision++;}
  }
  const outcome=forcedChestOutcome||(Math.random()<CHEST.outcomeOdds.cache?"cache":"pinata");forcedChestOutcome=null;
  const pinata=outcome==="pinata",payout=pinata?CHEST.pinataPayout:CHEST.cachePayout;
  const rewards=Array.from({length:payout},rollChestResource);
  if(pinata){
    rewards.forEach((kind,index)=>scatterChestReward(kind,chest.x,chest.y,true,index,rewards.length));
    burst(chest.x,chest.y,"#e3b445",34);burst(chest.x,chest.y,"#b98a4e",22);
    toast("loot piñata — "+payout+" resources burst free!");sound(880,.3);
  }else{
    rewards.forEach((kind,index)=>scatterChestReward(kind,chest.x,chest.y,false,index,rewards.length));
    burst(chest.x,chest.y,"#d8c47c",18);
    toast("chest cache — "+payout+" resources dropped nearby");sound(540,.22);
  }
  return true;
}
function hitChest(chest,quiet=false){
  if(!chests.includes(chest)||chest.hp<=0)return false;
  chest.hp--;chest.shake=1;addDamageNumber(chest,1);burst(chest.x,chest.y-8,"#8a7358",6);
  if(!quiet)sound(290+chest.hp*35,.06);
  if(chest.hp<=0)destroyChest(chest);
  return true;
}
function removeGrass(tuft,withFeedback=false,quiet=false){
  const at=grass.indexOf(tuft);if(at<0)return false;
  const cell=worldToCell(tuft.x,tuft.y);grass.splice(at,1);grassByCell.delete(cell.cy*GRID_COLS+cell.cx);vegetationRevision++;
  if(chopState.target===tuft)resetChop();
  if(withFeedback){addDamageNumber(tuft,1);burst(tuft.x,tuft.y,"#6f965c",5);if(!quiet)sound(220,.04);}
  return true;
}
function hitGrass(tuft,quiet=false){return removeGrass(tuft,true,quiet);}
function clearGrassInFootprint(x,y,footprint){
  const cell=worldToCell(x,y),bounds=footprintCellBounds(cell.cx,cell.cy,footprint),removed=[];
  for(let cy=bounds.minY;cy<=bounds.maxY;cy++)for(let cx=bounds.minX;cx<=bounds.maxX;cx++){const tuft=grassByCell.get(cy*GRID_COLS+cx);if(tuft)removed.push(tuft);}
  for(const tuft of removed)removeGrass(tuft);
}

// Player and harvesting workers share this path: harvesting automation creates physical drops, never stored resources.
function hitResource(target,kind,automatic,quiet=false){
  // Only a player chop can crit. A resource crit adds exactly one drop; the ×3 critical
  // multiplier remains combat-only. Worker automation keeps its one authored drop per hit.
  const critical=!automatic&&critHit(),drops=automatic?1:TUNE.chopYield+(critical?1:0);
  // Player and worker chops share this impact path, so every damaged resource gets combat text.
  addDamageNumber(target,1,{critical});
  target.hp--;
  target.shake=1;
  for(let i=0;i<drops;i++)
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
  let nearest=null,best=vacuumRadius();
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

// The sole state.xp writer. It consumes one caller-owned resource-count record atomically.
// XP enters the run HERE and nowhere else, so levels — and therefore drafts — can only come
// from feeding the thing.
function feedBase(counts,particleFromX,particleFromY){
  let units=0,gained=0;
  for(const kind of RESOURCE_KINDS){
    const amount=counts[kind];units+=amount;gained+=FEED_XP[kind]*amount;counts[kind]=0;
    handoffParticles(BASE.x,BASE.y,kind,amount,particleFromX,particleFromY);
  }
  if(gained<=0)return 0;
  state.xp+=gained;state.levelXp+=gained;state.basePulse=1;
  toast("fed "+units+" — "+gained+" xp");sound(520,.08);
  // One feed may cross several levels; each crossing queues its own offer.
  while(state.levelXp>=levelCost(state.level))gainLevel();
  effects.levelChanged();effects.phaseHudChanged();
  return gained;
}
function gainLevel(){
  state.levelXp-=levelCost(state.level);state.level++;
  if(state.level%SKILL_POINT_LEVELS===0){state.skillPoints++;if(state.runMode!=="showcase"){toast("the thing stirs — skill point earned");sound(180,.25);}}
  if(state.runMode!=="normal")return;                 // the showcase sandbox is never dealt cards
  toast("level "+state.level);sound(660,.16);
  state.draft.queue++;refillDraft();
}

// ── the draft ───────────────────────────────────────────────────────────────
// Two reward loops share this machinery but never share a pool: LEVEL-UP offers permanent buffs;
// DAWN — the moment a cleared night rolls into day — offers hand-bound consumables and blueprints.
// This separation makes progression choices strategic and wave loot tactical. Each offer contains
// up to three DISTINCT eligible cards drawn by rarity weight. Exactly one offer is live at a time,
// the rest wait in their queues, and the world is halted while one pends via state.draftPaused.
// The choice arrives through chooseDraft(); nothing else may write state.draft. What a taken card
// DOES is routed by takeCard() below, not by the dealer.
const DRAFT_KINDS=["level","dawn"];
const DRAFT_CATEGORIES=Object.freeze({level:Object.freeze(["buff"]),dawn:Object.freeze(["consumable","blueprint"])});
function levelCost(level){return LEVEL_CURVE.base*LEVEL_CURVE.growth**level;}
function buffStacks(id){return state.draft.buffs[id]||0;}
// Consumables and blueprints carry no `stacks`, so the same test lets them repeat forever and caps
// only buffs. A blueprint is deliberately RE-OFFERABLE: what it deals is a construction site, not
// an unlock, so a run that keeps drawing bpSniper is a run that gets to stand three snipers.
function draftEligible(categories=null){return CARDS.filter(card=>card.inPool&&(!categories||categories.includes(card.category))&&buffStacks(card.id)<(card.stacks??Infinity));}
function drawDraftOffer(categories=null){
  const pool=draftEligible(categories),picks=[];
  while(picks.length<3&&pool.length){
    let roll=Math.random()*pool.reduce((sum,card)=>sum+RARITY_WEIGHTS[card.rarity],0),index=0;
    while(index<pool.length-1&&(roll-=RARITY_WEIGHTS[pool[index].rarity])>=0)index++;
    picks.push(pool.splice(index,1)[0].id);   // splice keeps the three distinct
  }
  return picks.length?picks:null;
}
// An empty pool consumes its queued reward silently, so a run with nothing left to offer never
// stalls. Level-ups are served before dawn rewards, so a dawn that lands on a pending level offer
// queues behind it rather than jumping it.
function refillDraft(){
  const draft=state.draft;
  while(!draft.offer&&(draft.queue>0||draft.dawnQueue>0)){
    const kind=draft.queue>0?"level":"dawn";
    if(kind==="level")draft.queue--;else draft.dawnQueue--;
    draft.offer=drawDraftOffer(DRAFT_CATEGORIES[kind]);
    draft.offerKind=draft.offer?kind:null;
  }
  state.draftPaused=!!draft.offer;
  if(state.draftPaused){stopGameplayInput();closeUpgradeMenu();}
  effects.draftChanged();
}
/** Dawn's own reward, queued by transitionPhase() when a night ends. */
function queueDawnReward(){
  if(state.runMode!=="normal")return;                 // the showcase sandbox is never dealt cards
  state.draft.dawnQueue++;refillDraft();
}
// THE one place a card becomes an effect — a buff the instant it is drafted, a consumable the
// instant it is PLAYED out of the hand. Buff entries are deliberately empty: their whole effect is
// the stack tally, layered over the authored numbers by the accessors below.
const CARD_EFFECTS={
  clickSpeed(){},critClicks(){},vacuumRadius(){},workerSpeed(){},workerCarry(){},towerDamage(){},towerSpeed(){},clickDamage(){},
  handCarry(){state.capacity+=CARD_BUFFS.handCarry;},
  baseHp(){state.baseMax+=CARD_BUFFS.baseHp;state.baseHp+=CARD_BUFFS.baseHp;},
  woodBundle(){state.stored.wood+=CARD_CONSUMABLES.woodBundle;state.basePulse=1;},
  stoneBundle(){state.stored.stone+=CARD_CONSUMABLES.stoneBundle;state.basePulse=1;},
  dustBundle(){state.stored.dust+=CARD_CONSUMABLES.dustBundle;state.basePulse=1;},
  healBase(){state.baseHp=state.baseMax;state.basePulse=1;},
  repairAll(){for(const building of [...buildings,heldBuilding()])if(building?.tower)building.tower.hp=building.tower.maxHp;},
  longDay(){if(state.clock.phase==="day")state.clock.remaining+=CARD_CONSUMABLES.longDay;else state.draft.dayBonus+=CARD_CONSUMABLES.longDay;},
  calmNight(){state.draft.calmNight=true;}
};
/** A drafted BUFF, applied on the spot: one more stack, and its (usually empty) effect. */
function applyBuff(id){
  const card=cardById[id],effect=CARD_EFFECTS[id];
  if(!card||!effect)return false;
  state.draft.buffs[id]=buffStacks(id)+1;
  effect();toast("drafted: "+card.text);sound(700,.16);
  return true;
}
/**
 * THE routing rule for a taken card, shared by level and dawn offers. A buff lands immediately; a
 * consumable or blueprint lands in the HAND and does nothing at all until it is played. Nothing
 * leaves the pool: a blueprint can be offered again, and a second copy simply thickens its stack.
 */
function takeCard(id){
  const card=cardById[id];
  if(!card)return false;
  if(card.category==="buff")return applyBuff(id);
  addToHand(id);toast("drawn: "+card.text);sound(700,.16);
  return true;
}

// ── the hand ────────────────────────────────────────────────────────────────
// The held cards, and the ONLY writers of state.hand / state.cardTargeting. Everything here fires
// handChanged() on its way out, so a UI never has to poll. Draw order is arrival order: a new id is
// appended, a repeat thickens the stack it already has.
function handEntry(id){return state.hand.find(entry=>entry.id===id)||null;}
function addToHand(id){
  const entry=handEntry(id);
  if(entry)entry.count++;else state.hand.push({id,count:1,charges:null});
  effects.handChanged();
}
/** Spend one whole copy: the stack thins, an emptied stack leaves, and the next copy starts fresh. */
function consumeHandCopy(entry){
  entry.count--;entry.charges=null;
  if(entry.count<=0)state.hand.splice(state.hand.indexOf(entry),1);
  effects.handChanged();
}
// Consumables that ask WHERE. Each names the authored building type whose ghost, footprint and
// radius ring the existing placement flow already draws — so targeting needs no render work at all.
// `cast` is the escape hatch for a spell: fireball borrows the blast charge's ghost (its radius IS
// FIREBALL.radius) and detonates on placement instead of leaving anything behind.
// `site` is the blueprint half of the table (below): the card drops an ordinary CONSTRUCTION SITE
// where a kit drops an authored instant building, and `variant` is the tower variant that site is
// already promised to. The card buys ACCESS to the variant, never the materials.
const TARGETED_CARDS={
  blastCharge:{type:"blast"},
  spikeKit:{type:"spikes"},
  mineKit:{type:"landmine"},
  tarKit:{type:"tar"},
  fireball:{type:"blast",cast:castFireball},
  // A blueprint asks WHERE exactly like a kit does — its own authored row names what lands, so the
  // whole set is derived from the registry rather than restated here. "tower:sniper" drops a tower
  // site promised to the sniper variant; "building:obelisk" drops an obelisk site. A blueprint whose
  // ref is a concept has no table row yet and stays out, so playing one refuses.
  ...Object.fromEntries(CARDS.filter(card=>card.category==="blueprint").map(card=>[card.id,blueprintPlacement(card.ref)]).filter(([,spec])=>spec))
};
function blueprintPlacement(ref){
  const [kind,id]=String(ref||"").split(":");
  if(kind==="tower"&&TOWER_VARIANTS[id])return {type:"tower",variant:id,site:true};
  if(kind==="building"&&BUILDING_TYPES[id])return {type:id,variant:null,site:true};
  return null;
}
/** What a blueprint card's placement will be called once it stands up: its variant's authored name
 *  when it is a tower, the building's own otherwise. */
function blueprintName(spec){return spec.variant?TOWER_VARIANTS[spec.variant].name:BUILDING_TYPES[spec.type].name;}
function cardCharges(id){return cardById[id].charges??1;}
/** The fireball's whole effect: one area hit at the anchor, no building, blast-style noise and dust. */
function castFireball(x,y){
  for(const enemy of [...state.enemies])if(distance(x,y,enemy.x,enemy.y)<=FIREBALL.radius)damageEnemy(enemy,FIREBALL.damage,"#ef7b3f",0);
  for(let i=0;i<42;i++)particles.push({x,y,vx:rand(-180,180),vy:rand(-190,40),life:rand(.35,.9),col:i%2?"#ef7b3f":"#b84b38"});
  toast("fireball");sound(70,.3);
}
/** Arm the placement flow for one held card. The card STAYS in hand while its charges are spent. */
function beginCardTargeting(entry){
  const spec=TARGETED_CARDS[entry.id];
  entry.charges??=cardCharges(entry.id);
  state.cardTargeting={id:entry.id,type:spec.type,cast:spec.cast||null,site:!!spec.site,variant:spec.variant||null};
  state.buildMode=spec.type;effects.buildHudChanged();effects.handChanged();
  toast(cardById[entry.id].text+" — click clear ground ("+entry.charges+" charge"+(entry.charges===1?"":"s")+")");sound(660,.08);
  return "targeting";
}
/**
 * One click of a targeted card. Placement validity is the same canPlace() the ghost colours itself
 * with, so what the player sees is what lands — for the fireball too, which aims with the blast
 * charge's footprint. A charge is spent only when something actually happened, and the card leaves
 * the hand only on the charge that empties it.
 */
function placeCardCharge(anchor){
  const targeting=state.cardTargeting,entry=handEntry(targeting.id);
  if(!entry||!(entry.charges>0)){endCardTargeting();return false;}
  if(!canPlace(anchor.x,anchor.y,targeting.type)){toast("needs clear ground away from the base");return false;}
  if(targeting.cast)targeting.cast(anchor.x,anchor.y);
  else{
    const placed=createBuilding(targeting.type,anchor.x,anchor.y);
    // A blueprint card is ACCESS to the variant, not materials for it: what lands is an ordinary
    // construction site at the authored cost, already promised to the card's variant. The player
    // still carries every resource, exactly as if they had built the chassis and bought the upgrade.
    if(targeting.site)placed.plannedVariant=targeting.variant;
    buildings.push(placed);clearGrassInFootprint(placed.x,placed.y,buildingFootprint(placed.type));
    // A kit's charges are free: these are the authored cost-0 instant buildings, and the CARD is
    // the only thing that pays for them — there is no separate stack counter anywhere any more.
    if(!targeting.site)
      toast(BUILDING_TYPES[targeting.type].name+" placed — "+(entry.charges-1)+" charge"+(entry.charges===1?"":"s")+" left");
    // free costs (debug): the site is created exactly as authored and then finished, designated
    // upgrade included, so the toggle strands nothing.
    else if(DBG.freeCosts){completeBuilding(placed);applyFinishedUpgrade(placed);}
    else toast(blueprintName(targeting)+" blueprint placed — carry its resources to it");
    sound(240,.06);
  }
  entry.charges--;
  if(entry.charges<=0){consumeHandCopy(entry);endCardTargeting();}
  else effects.handChanged();
  return true;
}
function endCardTargeting(){
  state.cardTargeting=null;state.buildMode=null;effects.buildHudChanged();
}

// ── card buffs, layered at READ time ────────────────────────────────────────
// Every accessor reads the authored value (data.js constant or TUNE knob) and applies this run's
// stacks on top. Nothing here writes an authored table, so turning the buffs off is just an empty
// ledger. critHit() short-circuits at zero stacks so an unbuffed run consumes no randomness.
function chopFillRate(){return (globalUpgradeEnabled("autoClick")?STEADY_HAND_RATE:1)*CARD_BUFFS.clickSpeed**buffStacks("clickSpeed");}
function vacuumRadius(){return TUNE.vacuumRadius+CARD_BUFFS.vacuumRadius*buffStacks("vacuumRadius");}
function clickDamage(){return TUNE.clickDamage+CARD_BUFFS.clickDamage*buffStacks("clickDamage");}
function critHit(){const stacks=buffStacks("critClicks");return stacks>0&&Math.random()<CARD_BUFFS.critChance*stacks;}
function workerSpeed(){return WORKER_SPEED*CARD_BUFFS.workerSpeed**buffStacks("workerSpeed");}
function workerCarry(){return WORKER_CARRY+CARD_BUFFS.workerCarry*buffStacks("workerCarry");}
function towerDamage(variant){return Math.ceil(variant.damage*CARD_BUFFS.towerDamage**buffStacks("towerDamage"));}
function towerCooldown(variant){return variant.cooldown/CARD_BUFFS.towerSpeed**buffStacks("towerSpeed");}
function dropToBase(){feedBase(state.carried,state.mouse.x,state.mouse.y);}

function buildingCost(building){return building.cost||BUILDING_TYPES[building.type].cost;}
function completeBuilding(building){
  if(building.complete)return;
  const def=BUILDING_TYPES[building.type];building.complete=true;building.starved=false;
  if(def.resource)state.capacity+=2;
  if(building.type==="tower"){const variant=TOWER_VARIANTS.basic;building.tower={variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:variant.maxHp,maxHp:variant.maxHp};}
  // A blueprint card designated a variant when it dropped this site. The chassis is finished exactly
  // like any other, then that upgrade is accepted here — the same {id,kind,delivered} job
  // acceptUpgrade() writes — so the next deliveries carry straight on into its authored cost and the
  // total materials match building the tower and buying the upgrade by hand.
  const planned=building.plannedVariant&&TOWER_VARIANTS[building.plannedVariant]?building.plannedVariant:null;
  if(planned)building.activeUpgrade={id:planned,kind:"tower",delivered:resourceCounts()};
  building.plannedVariant=null;
  if(building.type==="house")building.spawnTimer=WORKER_SPAWN_TIME;
  // Resolve the transition as one transaction. updateWorkerSpawns() runs before workers, so leaving
  // an earlier builder unresolved until the next tick would expose its durable vacancy to autofill.
  resolveBuildingCompletionWorkers(building);
  burst(building.x,building.y-12,"#ead28d",18);
  const readyMessage=building.type==="stockpile"?"stockpile complete — release resources over it":building.type==="house"?"house complete — worker production started":building.type==="obelisk"?"obelisk complete — hover it to choose upgrades":building.type==="tower"?(planned?"basic tower complete — "+TOWER_VARIANTS[planned].name+" already accepted, keep delivering":"basic tower complete — hover it to choose one variant"):def.name+" complete";
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
function canPlace(x,y,type=null,ignoreBuilding=null,ignoreProp=null,ignoreChest=null){
  const footprint=ignoreChest?.footprint||ignoreProp?.footprint||buildingFootprint(type),c=worldToCell(x,y);
  // Whole footprint, not just the anchor: a 3x3 one cell from the border overhangs the map.
  if(!footprintInWorldBounds(c.cx,c.cy,footprint))return false;
  const rect=footprintWorldRect(c.cx,c.cy,footprint);
  if(rect.x<BUILD_MARGIN||rect.y<BUILD_MARGIN||rect.x+rect.w>W-BUILD_MARGIN||rect.y+rect.h>H-BUILD_MARGIN)return false;
  const bounds=footprintCellBounds(c.cx,c.cy,footprint);
  // grid.js owns the placement footprint rectangle; fine terrain owns whether every pixel is land.
  if(!terrainWorldRectEntirelyOnLand(rect))return false;
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
  // Only placed unopened chests block. A relocating chest is outside this collection, and ignoreChest
  // keeps the rule correct if call order changes.
  for(const chest of chests)
    if(chest!==ignoreChest&&cellBoundsOverlap(bounds,occupiedCellBounds(chest,chest.footprint)))return false;
  return true;
}

function completeHouses(){return buildings.filter(building=>building.complete&&building.type==="house");}
function nextHouseCost(){const count=completeHouses().length;return {wood:HOUSE_COST.wood+HOUSE_COST_ESCALATION.wood*count,stone:HOUSE_COST.stone+HOUSE_COST_ESCALATION.stone*count};}
function sourceWorkerCount(source){const held=heldWorker();return state.workers.filter(worker=>worker.spawnSource===source).length+(held?.spawnSource===source?1:0);}
/** Durable-post compatibility view adds arrival to shared occupancy. */
function durablePostStatus(building){
  if(state.runMode!=="normal")return null;
  const status=workerOccupancyStatus(building);if(!status)return null;
  const assigned=assignedWorkers(building);
  return {building,capacity:status.capacity,assigned:status.assigned,arrived:assigned.filter(worker=>state.workers.includes(worker)&&worker.staffingArrivedAt===building).length};
}
function vacantDurablePosts(){return buildings.filter(building=>{const status=durablePostStatus(building);return status&&status.assigned<status.capacity;});}
function createHouseWorker(house){
  if(!house.complete||house.type!=="house")return null;
  const postX=house.x,postY=house.y+23;
  // homePost is null or {job,jobTarget,postX,postY}; temporary jobs restore that saved assignment.
  return {x:postX+rand(-8,8),y:postY,postX,postY,spawnSource:house,job:"guard",jobTarget:null,homePost:null,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:{wood:0,stone:0,dust:0,coin:0,diamond:0},hp:WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,reposting:false};
}
function spawnHouseWorker(house){
  const worker=createHouseWorker(house);if(!worker)return;
  if(state.runMode==="normal"){
    let nearest=null,best=Infinity;
    for(const post of vacantDurablePosts()){const d=distance(house.x,house.y,post.x,post.y);if(d<best){best=d;nearest=post;}}
    if(nearest){Object.assign(worker,builtJobAssignment(nearest));worker.staffingArrivedAt=null;}
  }
  state.workers.push(worker);burst(house.x,house.y+23,"#ead28d",9);sound(720,.12);
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
function clearWorkerSelfSupply(worker){clearWorkerTask(worker);worker.selfSupply=null;}
function releaseWorkerHome(worker){
  clearWorkerSelfSupply(worker);
  const homePost=worker.homePost;worker.homePost=null;
  const node=homePost?.jobTarget?.node,nodeKind=node&&resourceNodeKind(node);
  if(homePost&&(homePost.jobTarget===null||buildings.includes(homePost.jobTarget)||(nodeKind&&resourceIsActive(node,nodeKind)))){
    worker.job=homePost.job;worker.jobTarget=homePost.jobTarget;worker.postX=homePost.postX;worker.postY=homePost.postY;return;
  }
  worker.job="guard";worker.jobTarget=null;worker.postX=worker.x;worker.postY=worker.y;
}
const WORKER_RECRUIT_CADENCE=.5;
let nextWorkerRecruitAt=0;
function guardIdleAtSpawn(worker){
  const house=worker.spawnSource;
  return worker.job==="guard"&&worker.jobTarget===null&&!worker.combatTarget&&!worker.retaliationTarget&&!worker.returnAfterCombat&&!worker.fleeing&&!worker.homePost&&house&&buildings.includes(house)&&house.complete&&house.type==="house"&&distance(worker.postX,worker.postY,house.x,house.y+23)<=4;
}
function recruitBlueprintBuilders(){
  if(!DBG.blueprintRecruiting||state.runMode!=="normal")return;
  for(const building of buildings){
    if(building.complete)continue;
    while(workerOccupancyStatus(building).assigned<workerOccupancyStatus(building).capacity){
      let nearest=null,best=Infinity;
      for(const worker of state.workers){
        if(worker.job!=="guard"||worker.combatTarget||worker.retaliationTarget||worker.returnAfterCombat||worker.fleeing||worker.homePost)continue;
        const d=distance(worker.x,worker.y,building.x,building.y);if(d<=TUNE.recruitRadius&&d<best){nearest=worker;best=d;}
      }
      if(!nearest)break;
      nearest.homePost={job:nearest.job,jobTarget:nearest.jobTarget,postX:nearest.postX,postY:nearest.postY};
      nearest.job="build";nearest.jobTarget=building;nearest.postX=building.x;nearest.postY=building.y+20;
    }
  }
}
function recruitIdleGuards(){
  if(!DBG.idleSeeksWork||state.runMode!=="normal")return;
  for(const post of vacantDurablePosts()){
    while(workerOccupancyStatus(post).assigned<workerOccupancyStatus(post).capacity){
      let nearest=null,best=Infinity;
      for(const worker of state.workers){
        if(!guardIdleAtSpawn(worker))continue;
        const d=distance(worker.x,worker.y,post.x,post.y);if(d<=TUNE.recruitRadius&&d<best){nearest=worker;best=d;}
      }
      if(!nearest)break;
      Object.assign(nearest,builtJobAssignment(post));nearest.staffingArrivedAt=null;nearest.reposting=true;
    }
  }
}
function recruitWorkers(){
  if(state.runMode!=="normal"||(!DBG.blueprintRecruiting&&!DBG.idleSeeksWork)||state.clock.elapsed<nextWorkerRecruitAt)return;
  // Both independent sweeps share one game-time cadence; blueprints never enter the durable-post sweep.
  nextWorkerRecruitAt=state.clock.elapsed+WORKER_RECRUIT_CADENCE;
  recruitBlueprintBuilders();recruitIdleGuards();
}
function targetIsClaimed(target){
  const owner=target.claimedBy;if(owner&&(!state.workers.includes(owner)||owner.taskTarget!==target)){delete target.claimedBy;return false;}return !!owner;
}
function nearestWorkerNode(worker,kind,centerX=worker.postX,centerY=worker.postY,radius=WORKER_LEASH){
  const nodes=kind==="wood"?trees:kind==="stone"?rocks:diamonds;let choice=null,best=Infinity;
  for(const node of nodes){const scopeDistance=distance(centerX,centerY,node.x,node.y),d=distance(worker.x,worker.y,node.x,node.y),occupancy=workerOccupancyStatus(node,worker);if(resourceIsActive(node,kind)&&occupancy.assigned<occupancy.capacity&&scopeDistance<=radius&&d<best){choice=node;best=d;}}
  return choice;
}
function moveWorker(worker,x,y,dt,stop=12){
  // Report arrival on the crossing frame; waiting for exact float equality can strand loaded workers at drop-off range.
  const d=distance(worker.x,worker.y,x,y);if(d<=stop+.01)return true;
  const remaining=d-stop,amount=Math.min(remaining,workerSpeed()*dt),angle=Math.atan2(y-worker.y,x-worker.x);worker.x+=Math.cos(angle)*amount;worker.y+=Math.sin(angle)*amount;return amount>=remaining-.01;
}
function workerCoatColor(worker){return worker.job==="haul"?"#4d7892":worker.job==="build"?"#d29a39":worker.job==="guard"?"#856347":"#d4b079";}
function killWorker(worker){
  const at=state.workers.indexOf(worker);if(at<0)return false;
  clearWorkerSelfSupply(worker);worker.homePost=null;worker.combatTarget=null;worker.retaliationTarget=null;worker.returnAfterCombat=false;worker.fleeing=false;worker.fleeSafeTime=0;worker.reposting=false;
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,worker.x+rand(-7,7),worker.y+rand(-5,5));}
  state.workers.splice(at,1);
  // Snapshot only rendering data: the source slot is free as soon as the mutable worker leaves state.workers.
  workerCorpses.push(Object.freeze({x:worker.x,y:worker.y,coat:workerCoatColor(worker),flip:Math.random()<.5?-1:1,pose:rand(-2,2)}));
  burst(worker.x,worker.y,"#9d493d",9);return true;
}
function workerAttack(worker,enemy){
  worker.combatTarget=enemy;if(worker.attackCooldown>0)return;
  worker.attackCooldown=WORKER_ATTACK_RATE;const alive=damageEnemy(enemy,WORKER_DAMAGE,"#f0cc72",6);sound(310,.05);if(!alive)worker.returnAfterCombat=true;
}
function depositWorkerLoad(worker){
  // Hauling moves already-physical drops; harvesting itself can only call hitResource() and never reaches storage.
  const storage=worker.jobTarget;
  if(storage===BASE)feedBase(worker.carried,worker.x,worker.y);
  else{for(const kind of RESOURCE_KINDS){const amount=worker.carried[kind];if(!amount)continue;storage.storage[kind]+=amount;worker.carried[kind]=0;}storage.pulse=1;}
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
  let reserved=0;
  for(const other of state.workers)if(other!==worker&&other.job==="build"&&other.jobTarget===building){
    reserved+=other.carried[kind]+(other.taskTarget?.kind===kind?1:0);
    if(other.selfSupply?.kind===kind&&!other.carried[kind]&&other.taskTarget?.kind!==kind)reserved++;
  }
  return Math.max(0,buildingCost(building)[kind]-building.delivered[kind]-reserved);
}
function inheritBuiltJob(worker,building){
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,building.x+rand(-8,8),building.y+rand(-5,5));}
  clearWorkerSelfSupply(worker);worker.returning=false;worker.starved=false;
  const assignment=builtJobAssignment(building),occupancy=workerOccupancyStatus(building,worker);
  if(worker.homePost&&(!occupancy||occupancy.assigned>=occupancy.capacity))releaseWorkerHome(worker);
  else{
    if(occupancy&&occupancy.assigned>=occupancy.capacity)Object.assign(worker,{job:"guard",jobTarget:null,postX:assignment.postX,postY:assignment.postY});
    else Object.assign(worker,assignment);
    worker.homePost=null;
  }
  worker.staffingArrivedAt=null;
}
function resolveBuildingCompletionWorkers(building){
  // Snapshot preserves state.workers order while inheritance mutates the fields used by this filter.
  const builders=state.workers.filter(worker=>worker.job==="build"&&worker.jobTarget===building);
  for(const worker of builders)inheritBuiltJob(worker,building);
}
function nearestBuildDrop(building,worker){
  let nearest=null,best=Infinity;
  for(const resource of resourceDrops){if(resource.target||targetIsClaimed(resource)||!resource.ground||!["wood","stone"].includes(resource.kind)||buildNeed(building,resource.kind,worker)<=0||distance(building.x,building.y,resource.x,resource.y)>TUNE.builderSourceRadius)continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<best){best=d;nearest=resource;}}
  return nearest;
}
function claimBuildDrop(worker,resource){if(!resource)return false;worker.starved=false;worker.taskTarget=resource;resource.claimedBy=worker;return true;}
function nearestBuilderSelfSupply(worker,building){
  let choice=null,best=Infinity;
  for(const kind of ["wood","stone"]){
    if(buildNeed(building,kind,worker)<=0)continue;
    const nodes=kind==="wood"?trees:rocks;
    for(const node of nodes){
      if(!resourceIsActive(node,kind)||distance(building.x,building.y,node.x,node.y)>TUNE.builderSourceRadius)continue;
      const occupancy=workerOccupancyStatus(node,worker),d=distance(worker.x,worker.y,node.x,node.y);
      if(occupancy.assigned<occupancy.capacity&&d<best){choice={kind,node};best=d;}
    }
  }
  return choice;
}
function updateBuilderSelfSupply(worker,building,dt){
  if(state.runMode!=="normal"||!DBG.builderSelfSupply){clearWorkerSelfSupply(worker);return false;}
  let supply=worker.selfSupply;
  if(supply&&buildNeed(building,supply.kind,worker)<=0){clearWorkerSelfSupply(worker);supply=null;}
  if(!supply){
    supply=nearestBuilderSelfSupply(worker,building);
    if(!supply)return false;
    worker.selfSupply=supply;worker.starved=false;
  }
  if(worker.taskTarget){
    const drop=worker.taskTarget;
    if(!resourceDrops.includes(drop)||drop.target||drop.claimedBy!==worker){clearWorkerTask(worker);return true;}
    worker.starved=false;
    if(drop.ground&&moveWorker(worker,drop.x,drop.y,dt,10)){
      const at=resourceDrops.indexOf(drop);if(at>=0){worker.carried[drop.kind]++;resourceDrops.splice(at,1);}
      delete drop.claimedBy;worker.taskTarget=null;worker.selfSupply=null;
    }else if(!drop.ground)moveWorker(worker,drop.x,drop.y,dt,10);
    return true;
  }
  if(!resourceIsActive(supply.node,supply.kind)){clearWorkerSelfSupply(worker);return true;}
  worker.starved=false;
  if(moveWorker(worker,supply.node.x,supply.node.y,dt,20)&&worker.hitCooldown<=0){
    worker.hitCooldown=WORKER_HIT_COOLDOWN;const firstNewDrop=resourceDrops.length;hitResource(supply.node,supply.kind,true);
    const drop=resourceDrops[firstNewDrop];invariant(drop?.kind===supply.kind,"self-supply mining did not create its physical drop");drop.claimedBy=worker;worker.taskTarget=drop;
  }
  return true;
}
function updateBuilder(worker,dt){
  const building=worker.jobTarget;
  if(!building||!buildings.includes(building)){releaseWorkerHome(worker);worker.starved=false;return;}
  if(building.complete){inheritBuiltJob(worker,building);return;}
  if(workerLoad(worker)>0){
    worker.selfSupply=null;worker.starved=false;if(!moveWorker(worker,building.x,building.y,dt,16))return;
    const cost=buildingCost(building);for(const kind of ["wood","stone"]){const amount=Math.min(worker.carried[kind],cost[kind]-building.delivered[kind]);worker.carried[kind]-=amount;building.delivered[kind]+=amount;handoffParticles(building.x,building.y,kind,amount,worker.x,worker.y);}
    building.pulse=1;if(building.delivered.wood>=cost.wood&&building.delivered.stone>=cost.stone)completeBuilding(building);return;
  }
  if(worker.selfSupply&&updateBuilderSelfSupply(worker,building,dt))return;
  if(worker.taskTarget&&(!resourceDrops.includes(worker.taskTarget)||worker.taskTarget.target||worker.taskTarget.claimedBy!==worker))clearWorkerTask(worker);
  if(worker.taskTarget){
    worker.starved=false;const resource=worker.taskTarget;if(moveWorker(worker,resource.x,resource.y,dt,10)){const at=resourceDrops.indexOf(resource);if(at>=0){worker.carried[resource.kind]++;resourceDrops.splice(at,1);}delete resource.claimedBy;worker.taskTarget=null;}return;
  }
  if(DBG.groundSourcing&&claimBuildDrop(worker,nearestBuildDrop(building,worker)))return;
  const source=nearestBuildStorage(building,worker),storage=source.storage;
  if(!source.covered){if(updateBuilderSelfSupply(worker,building,dt))return;worker.starved=["wood","stone"].some(kind=>buildNeed(building,kind,worker)>0);moveWorker(worker,worker.postX,worker.postY,dt);return;}
  if(storage){
    worker.starved=false;if(!moveWorker(worker,storage.x,storage.y,dt,storage===BASE?BASE.r-4:18))return;
    const stock=storageStock(storage);let room=workerCarry();for(const kind of ["wood","stone"]){const amount=Math.min(room,stock[kind],buildNeed(building,kind,worker));stock[kind]-=amount;worker.carried[kind]+=amount;room-=amount;}if(storage!==BASE)storage.pulse=1;return;
  }
  if(claimBuildDrop(worker,nearestBuildDrop(building,worker)))return;
  if(updateBuilderSelfSupply(worker,building,dt))return;
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
  damageEnemy(target,KING.damage,"#efe0a0",5);sound(260,.05);
}
function updateHazard(building,dt){
  const hazard=building.hazard;hazard.cooldown-=dt;hazard.flash=Math.max(0,hazard.flash-dt);
  if(hazard.cooldown>0)return;
  const enemy=state.enemies.find(item=>distance(building.x,building.y,item.x,item.y)<20);
  if(!enemy)return;
  if(building.type==="tar"){
    const def=BUILDING_TYPES.tar;hazard.cooldown=def.cooldown;hazard.flash=.12;applySlow(enemy,def.slowDuration,def.slowMultiplier);
  }else if(building.type==="landmine"){
    for(const target of [...state.enemies]){if(distance(building.x,building.y,target.x,target.y)>BUILDING_TYPES.landmine.effectRadius)continue;damageEnemy(target,BUILDING_TYPES.landmine.damage,"#e09b43",7);}
    for(let i=0;i<28;i++)particles.push({x:building.x,y:building.y,vx:rand(-140,140),vy:rand(-160,20),life:rand(.3,.7),col:i%2?"#d9893d":"#6e5540"});
    building.remove=true;sound(75,.25);
  }else{
    const def=BUILDING_TYPES.spikes;hazard.cooldown=def.cooldown;hazard.flash=.18;damageEnemy(enemy,def.damage,"#c9c2b5",4);
  }
}
function addDamageNumber(target,amount,{critical=false,tone="dealt"}={}){
  if(!(amount>0)||!Number.isFinite(amount))return;
  const sequence=damageNumberSequence++;
  damageNumbers.push({x:target.x,y:target.y,amount,critical:!!critical,tone,age:0,
    // Stable alternating lanes prevent rapid hits from painting an unreadable single glyph.
    lane:(sequence%5)-2,seed:(sequence*0.61803398875)%1});
}
function damageDummy(dummy,damage,color="#d25b49",count=5,hit={}){
  if(!damageDummies.includes(dummy)||dummy.defeatedTimer>0)return false;
  dummy.hp=Math.max(0,dummy.hp-damage);addDamageNumber(dummy,damage,hit);dummy.flash=.16;dummy.recentDamage=damage;dummy.recentTimer=2;dummy.hitCount++;state.showcaseFocus=dummy;burst(dummy.x,dummy.y,color,count);
  if(dummy.hp<=0){dummy.defeatedTimer=1;dummy.status={burn:null,slow:null};return false;}return true;
}
/** All enemy damage converges here. Future crit rolls pass {critical:true}; rendering already supports it. */
function damageEnemy(enemy,damage,color,count=5,source=null,hit={}){
  if(!state.enemies.includes(enemy)||enemy.displayUnit)return false;if(source?.tower&&buildings.includes(source))enemy.retaliationTower=source;enemy.hp=Math.max(0,enemy.hp-damage);addDamageNumber(enemy,damage,hit);enemy.flash=.16;if(count>0)burst(enemy.x,enemy.y,color,count);if(enemy.hp<=0){killEnemy(enemy,hit.announce??false);return false;}return true;
}
function damageCombatTarget(target,damage,color,count=5,source=null,hit={}){
  const kind=assertCombatKind(target);
  if(kind==="damage-dummy")return damageDummy(target,damage,color,count,hit);
  if(kind==="enemy")return damageEnemy(target,damage,color,count,source,hit);
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
  // Radially away from the base: with ring spawning there is no per-enemy home side.
  const dx=enemy.x-BASE.x,dy=enemy.y-BASE.y,length=Math.hypot(dx,dy)||1;
  enemy.x=clamp(enemy.x+dx/length*distanceAmount,8,W-8);enemy.y=clamp(enemy.y+dy/length*distanceAmount,8,H-8);
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
  const tower=building.tower,color=variant.impactColor||variant.accent,damage=towerDamage(variant);tower.targetX=target.x;tower.targetY=target.y;tower.flash=.2;
  if(variant.attackMode==="splash"){
    const impactX=target.x,impactY=target.y;tower.impactX=impactX;tower.impactY=impactY;eachTowerCombatTarget(enemy=>{if(distance(impactX,impactY,enemy.x,enemy.y)<=variant.splashRadius)damageCombatTarget(enemy,damage,color,8,building);});burst(impactX,impactY,color,18);
  }else if(variant.attackMode==="line"){
    const angle=Math.atan2(target.y-building.y,target.x-building.x),endX=building.x+Math.cos(angle)*variant.range,endY=building.y+Math.sin(angle)*variant.range;tower.targetX=endX;tower.targetY=endY;
    eachTowerCombatTarget(enemy=>{if(lineIntersectsEnemy(building.x,building.y,endX,endY,enemy,variant.beamWidth))damageCombatTarget(enemy,damage,color,7,building);});
  }else{
    const alive=damageCombatTarget(target,damage,color,["burn","slow","push"].includes(variant.attackMode)?8:5,building);
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
    let attacked=false;eachTowerCombatTarget(enemy=>{if(distance(building.x,building.y,enemy.x,enemy.y)>variant.effectRadius)return;if(!attacked){tower.cooldown=towerCooldown(variant);tower.flash=.4;attacked=true;}damageCombatTarget(enemy,towerDamage(variant),variant.accent,5,building);});
    if(attacked)sound(variant.sound,.22);return;
  }
  const target=nearestTowerTarget(building,variant.range);if(!target)return;tower.cooldown=towerCooldown(variant);fireTowerAttack(building,variant,target);
}

function updateGuard(worker,dt){
  let target=null,best=Infinity;
  for(const enemy of state.enemies){const postDistance=distance(worker.postX,worker.postY,enemy.x,enemy.y),d=distance(worker.x,worker.y,enemy.x,enemy.y);if(postDistance<=WORKER_LEASH&&d<best){best=d;target=enemy;}}
  if(target){worker.combatTarget=target;if(moveWorker(worker,target.x,target.y,dt,WORKER_MELEE-2))workerAttack(worker,target);return;}
  moveWorker(worker,worker.postX,worker.postY,dt);
}
function guardWalkPickup(worker){
  if(!DBG.idleSeeksWork||state.runMode!=="normal"||(worker.job!=="guard"&&!worker.reposting)||worker.fleeing||workerLoad(worker)!==0)return;
  let nearest=null,best=20;
  for(const resource of resourceDrops){if(resource.target||targetIsClaimed(resource)||!resource.ground)continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<=best){nearest=resource;best=d;}}
  if(!nearest)return;
  nearest.claimedBy=worker;worker.taskTarget=nearest;
  const at=resourceDrops.indexOf(nearest);if(at>=0){worker.carried[nearest.kind]++;resourceDrops.splice(at,1);}
  delete nearest.claimedBy;worker.taskTarget=null;
}
function settleGuardPickup(worker){
  if(workerLoad(worker)===0)return;
  for(const kind of RESOURCE_KINDS){
    if(!worker.carried[kind])continue;
    const blueprint=buildings.find(building=>building!==BASE&&!building.complete&&distance(worker.postX,worker.postY,building.x,building.y)<=60&&buildNeed(building,kind,worker)>0);
    if(blueprint){worker.carried[kind]--;blueprint.delivered[kind]++;blueprint.pulse=1;handoffParticles(blueprint.x,blueprint.y,kind,1,worker.x,worker.y);const cost=buildingCost(blueprint);if(blueprint.delivered.wood>=cost.wood&&blueprint.delivered.stone>=cost.stone)completeBuilding(blueprint);continue;}
    const stockpile=buildings.find(building=>building.complete&&building.type==="stockpile"&&distance(worker.postX,worker.postY,building.x,building.y)<=60);
    if(stockpile){worker.carried[kind]--;stockpile.storage[kind]++;stockpile.pulse=1;continue;}
    worker.carried[kind]--;spawnResource(kind,worker.postX,worker.postY);
  }
}
function nearestWorkerSafety(worker){
  let safe=BASE,best=distance(worker.x,worker.y,BASE.x,BASE.y);
  for(const building of buildings){if(!building.complete||building.type!=="tower")continue;const d=distance(worker.x,worker.y,building.x,building.y);if(d<best){safe=building;best=d;}}
  return safe;
}
function updateWorkerFlee(worker,dt){
  let danger=false;for(const enemy of state.enemies)if(distance(worker.x,worker.y,enemy.x,enemy.y)<=WORKER_LEASH*1.5){danger=true;break;}
  worker.fleeSafeTime=danger?0:(worker.fleeSafeTime||0)+dt;
  if(worker.fleeSafeTime>=3){worker.fleeing=false;worker.fleeSafeTime=0;worker.retaliationTarget=null;return false;}
  worker.combatTarget=null;worker.retaliationTarget=null;const safe=nearestWorkerSafety(worker);moveWorker(worker,safe.x,safe.y,dt);return true;
}
function updateHauler(worker,dt){
  const storage=worker.jobTarget,task=worker.taskTarget;
  if(task&&(!resourceDrops.includes(task)||task.target||task.claimedBy!==worker))clearWorkerTask(worker);
  if(workerLoad(worker)>=workerCarry())worker.returning=true;
  if(!worker.returning&&!worker.taskTarget){
    let nearest=null,best=Infinity;
    for(const resource of resourceDrops){if(resource.target||targetIsClaimed(resource)||!resource.ground||distance(storage.x,storage.y,resource.x,resource.y)>storageServiceRadius(storage))continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<best){best=d;nearest=resource;}}
    if(nearest){worker.taskTarget=nearest;nearest.claimedBy=worker;}else if(workerLoad(worker)>0)worker.returning=true;
  }
  if(worker.returning){if(moveWorker(worker,worker.postX,worker.postY,dt,13))depositWorkerLoad(worker);return;}
  if(worker.taskTarget){
    const target=worker.taskTarget;if(moveWorker(worker,target.x,target.y,dt,10)){const at=resourceDrops.indexOf(target);if(at>=0){worker.carried[target.kind]++;resourceDrops.splice(at,1);}delete target.claimedBy;worker.taskTarget=null;if(workerLoad(worker)>=workerCarry())worker.returning=true;}return;
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
  if(state.runMode==="normal"&&!worker.fleeing&&worker.hp<=TUNE.fleeHpThreshold){
    for(const enemy of state.enemies)if(distance(worker.x,worker.y,enemy.x,enemy.y)<=WORKER_LEASH){clearWorkerSelfSupply(worker);worker.combatTarget=null;worker.fleeing=true;worker.fleeSafeTime=0;break;}
  }
  if(worker.fleeing&&updateWorkerFlee(worker,dt))return;
  let threat=null,best=WORKER_MELEE;
  for(const enemy of state.enemies){const d=distance(worker.x,worker.y,enemy.x,enemy.y);if(d<best){best=d;threat=enemy;}}
  if(threat){clearWorkerSelfSupply(worker);workerAttack(worker,threat);return;}
  const attacker=worker.retaliationTarget;
  if(attacker&&state.enemies.includes(attacker)&&distance(worker.postX,worker.postY,attacker.x,attacker.y)<=WORKER_LEASH+WORKER_MELEE){
    clearWorkerSelfSupply(worker);worker.combatTarget=attacker;if(moveWorker(worker,attacker.x,attacker.y,dt,WORKER_MELEE))workerAttack(worker,attacker);return;
  }
  if(worker.retaliationTarget)worker.returnAfterCombat=true;
  worker.retaliationTarget=null;
  if(worker.returnAfterCombat){clearWorkerTask(worker);guardWalkPickup(worker);if(moveWorker(worker,worker.postX,worker.postY,dt)){settleGuardPickup(worker);worker.returnAfterCombat=false;}return;}
  const staffingTarget=worker.jobTarget&&workerStaffsPost(worker,worker.jobTarget)&&durablePostStatus(worker.jobTarget)?worker.jobTarget:null;
  if(worker.staffingArrivedAt&&worker.staffingArrivedAt!==staffingTarget)worker.staffingArrivedAt=null;
  if(staffingTarget&&worker.staffingArrivedAt!==staffingTarget){
    if(worker.reposting)guardWalkPickup(worker);
    if(moveWorker(worker,worker.postX,worker.postY,dt)){if(worker.reposting)settleGuardPickup(worker);worker.staffingArrivedAt=staffingTarget;worker.reposting=false;}
    else return;
  }
  if(worker.job==="guard"&&worker.reposting){guardWalkPickup(worker);if(moveWorker(worker,worker.postX,worker.postY,dt)){settleGuardPickup(worker);worker.reposting=false;}return;}
  if(worker.job==="build")updateBuilder(worker,dt);
  else if(worker.job==="guard")updateGuard(worker,dt);
  else if(worker.job==="haul")updateHauler(worker,dt);
  else if(worker.job==="harvest"||worker.job==="staff")updateGatherer(worker,dt);
  else{clearWorkerTask(worker);worker.job="guard";worker.jobTarget=null;updateGuard(worker,dt);}
}

// Only this function changes phase identity and owns both phase-boundary side effects. Normal dawn
// calls it from the post-combat clearance check; debugger commands may intentionally force it.
function transitionPhase(){
  const clock=state.clock,wave=state.nightWave;
  if(clock.phase==="day"){
    clock.phase="night";clock.remaining=0;
    // Tier is snapshotted at night setup: leveling mid-wave changes the next telegraphed night only.
    const totalSpawns=nightSpawnTotal();state.draft.calmNight=false;
    wave.activeRecipe=wave.upcomingRecipe;wave.totalSpawns=totalSpawns;wave.remainingSpawns=totalSpawns;wave.elapsed=0;wave.nextSpawnAt=NIGHT_WAVE_WINDOW/totalSpawns;wave.nightNumber++;wave.activeNightNumber=wave.nightNumber;
  }else{
    // A long day drafted at night is banked here, so the card is never silently wasted.
    clock.phase="day";clock.remaining=DAY_DURATION+state.draft.dayBonus;state.draft.dayBonus=0;clock.completedNights++;
    wave.activeRecipe=null;wave.remainingSpawns=0;wave.activeNightNumber=null;
    // Roll the next forecast after the night ends, so feeding during that night can unlock its pool.
    chooseUpcomingNight();
    // Surviving the night IS the reward: one pick of three consumables or blueprints, straight into
    // the hand. It queues behind a level offer that is somehow already live rather than replacing it.
    queueDawnReward();
  }
}
function updateClock(dt){
  const clock=state.clock;
  clock.elapsed+=dt;
  // Only day owns a countdown. Clamp before transition so a large or long-running frame can never
  // leave a negative timer looping across an indefinite night.
  if(clock.phase==="day"){
    clock.remaining=Math.max(0,clock.remaining-dt);
    if(clock.remaining===0)transitionPhase();
  }
  const target=clock.phase==="night"?NIGHT_OVERLAY_ALPHA:0,step=dt*NIGHT_OVERLAY_ALPHA/LIGHT_FADE_TIME;
  clock.light=target>clock.light?Math.min(target,clock.light+step):Math.max(target,clock.light-step);
}

function updateNightEnemyWave(dt){
  if(state.clock.phase!=="night")return;
  const wave=state.nightWave,interval=NIGHT_WAVE_WINDOW/wave.totalSpawns;
  wave.elapsed+=dt;
  // Scheduled thresholds, rather than random frame rolls, keep the quota stable across frame rates.
  while(wave.remainingSpawns>0&&wave.elapsed>=wave.nextSpawnAt&&state.enemies.length<NIGHT_ENEMY_CAP){
    const index=(wave.totalSpawns-wave.remainingSpawns)%wave.activeRecipe.spawns.length;
    // This is the sole membership writer. spawnEnemy() stays membership-neutral for debugger calls
    // and preserves its command-style undefined return contract.
    spawnEnemy(wave.activeRecipe.spawns[index]);state.enemies[state.enemies.length-1].waveNightNumber=wave.activeNightNumber;
    wave.remainingSpawns--;wave.nextSpawnAt+=interval;
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
  for(const worker of state.workers)if(worker.jobTarget===building)releaseWorkerHome(worker);
  if(state.upgradeMenu.building===building)closeUpgradeMenu();burst(building.x,building.y,"#8f5141",22);toast(towerVariant(building).name+" destroyed");sound(70,.35);
}
function damageTower(building,damage){const tower=building.tower;if(!buildings.includes(building)||tower.hp<=0)return;addDamageNumber(building,damage,{tone:"received"});tower.hp=Math.max(0,tower.hp-damage);tower.hitFlash=.22;building.pulse=1;if(tower.hp<=0)destroyTower(building);}
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
  for(const chest of chests)chest.shake=Math.max(0,chest.shake-dt*7);
  const held=heldChest();if(held)held.shake=Math.max(0,held.shake-dt*7);
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
function updateDamageNumbers(dt){
  // Renderer owns configurable lifetime; retain past its maximum slider range, then it can decide opacity.
  for(let i=damageNumbers.length-1;i>=0;i--){damageNumbers[i].age+=dt;if(damageNumbers[i].age>5)damageNumbers.splice(i,1);}
}
function updateNormal(dt){
  // A pending draft freezes the world on its own flag: the player's pause may be on or off under it.
  if(state.gameOver||state.paused||state.draftPaused){stopPrimaryClick();return;}
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
      if(target.kind==="worker"){const worker=target.object;worker.retaliationTarget=enemy;addDamageNumber(worker,def.damage,{tone:"received"});worker.hp=Math.max(0,worker.hp-def.damage);if(worker.hp<=0)workerDied=killWorker(worker);}
      else if(target.kind==="tower")damageTower(target.object,def.damage);
      // invulnerable base (debug) is checked at the damage site: the hit still lands,
      // flashes and toasts, it just subtracts nothing. baseHp/baseMax are never inflated.
      else{if(!DBG.invulnBase){addDamageNumber(BASE,def.damage,{tone:"received"});state.baseHp=Math.max(0,state.baseHp-def.damage);}state.basePulse=1;if(state.baseHp<=0){endGame();break;}}
      toast(workerDied?"worker died — replacement in "+WORKER_SPAWN_TIME+"s":def.name+" hit "+(target.kind==="worker"?"a worker":target.kind==="tower"?towerVariant(target.object).name:"the base"));sound(def.range>60?180:95,.09);
    }
  }
  if(state.gameOver)return;
  updateKing(dt);updateTransientTimers(dt);updateResourceNodes(dt);updateLooseResources(dt,true);
  updateWorkerSpawns(dt);updateBuildings(dt,true);recruitWorkers();
  for(const worker of state.workers)updateWorker(worker,dt);
  for(const building of buildings)if(!building.complete){const builders=state.workers.filter(worker=>worker.job==="build"&&worker.jobTarget===building);building.starved=builders.length>0&&builders.every(worker=>worker.starved);}
  updateParticles(dt);updateDamageNumbers(dt);
  // Stable completion point: scheduled spawning plus every kill-capable stage (player/status/enemy,
  // king, towers, hazards, workers) has finished. The phase flip makes this condition false before
  // any later frame, so transitionPhase() owns exactly one dawn reward.
  if(state.clock.phase==="night"&&state.nightWave.remainingSpawns===0&&livingActiveWaveEnemies()===0)transitionPhase();
  effects.afterUpdate();
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
  updateBuildings(dt,false);updateParticles(dt);updateDamageNumbers(dt);effects.afterUpdate();
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
  if(state.buildMode && !["attack","break-chest"].includes(action.kind)) return null;
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
  // Storage grants remain the explicit builder/withdrawal fallback; feeding never writes this stock.
  for(const kind of kinds) state.stored[kind]+=DEBUG_GRANT;
  state.basePulse=1; toast("granted "+DEBUG_GRANT+" "+kinds.join(" + ")); sound(520,.08);
}
function debugGrantXp(amount){
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(state.xp+amount))return false;
  const counts=resourceCounts();counts.wood=amount/FEED_XP.wood;feedBase(counts,BASE.x,BASE.y);return true;
}
/** Deal one card straight into the hand, skipping the offer entirely. Run state only: the catalog,
 *  its pool flags and every authored table are untouched, and the dealt card behaves exactly like a
 *  drafted one — it goes through addToHand(), and a kit carries its authored charges. */
function debugDealCard(id){
  const card=cardById[id];
  if(!card||!["consumable","blueprint"].includes(card.category))return false;
  addToHand(id);return true;
}
/** Empty the hand. RUN STATE ONLY, exactly like every other debug command: it drops held cards and
 *  the placement they may have armed, and touches no authored table, no pool flag and no store. */
function debugClearHand(){
  const emptied=state.hand.length;
  if(state.cardTargeting)endCardTargeting();
  state.hand.length=0;effects.handChanged();
  toast("cleared "+emptied+" card"+(emptied===1?"":"s")+" from hand");
  return emptied;
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
  // A real transition already sized (and spent) the night; only a re-roll inside an ongoing night
  // has to size one itself, so a calm night is neither double-counted nor thrown away here.
  const transitioned=state.clock.phase!=="night"; if(transitioned) transitionPhase();
  const wave=state.nightWave;
  wave.activeRecipe=recipe;
  wave.totalSpawns=transitioned?wave.totalSpawns:nightSpawnTotal();
  wave.remainingSpawns=wave.totalSpawns; wave.elapsed=0; wave.nextSpawnAt=0;
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
export function primaryPress(){if(heldChest())return;const action=resolvePrimaryAction(state.mouse.x,state.mouse.y);if(action?.target?.combatKind==="damage-dummy")state.showcaseFocus=action.target;leftClick();if(!effects.isModalOpen())startPrimaryClick();}
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
export function zoomCameraBy(factor){ const camera=state.camera; camera.zoom=clamp(camera.zoom*factor,.1,5); }
export function setCameraZoom(zoom){ state.camera.zoom=zoom; clampCamera(); }
/** Showcase UI camera command; section coordinates remain authored in showcase-data.js. */
export function focusShowcaseSection(id){const section=SHOWCASE_MANIFEST.sections[id];if(state.runMode!=="showcase"||!section)return false;state.camera.x=section.x;state.camera.y=section.y;state.camera.zoom=section.zoom;clampCamera();return true;}
/** Wheel zoom-toward-cursor correction: shift by the ground delta, unclamped (the caller clamps). */
export function offsetCamera(dx,dy){ state.camera.x+=dx; state.camera.y+=dy; }

// ── build mode ──
// There is no build dock and no toggleBuildMode() any more: state.buildMode exists only as the flag
// the ghost/footprint preview reads, and beginCardTargeting() is its ONE writer. Building is 100%
// card-driven; placeCardCharge() is the single entry point into placement.

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
  const menu=state.upgradeMenu,building=menu.building,kind=menu.kind,upgrade=upgradeList(kind).find(item=>item.id===menu.selected);
  if(!building||!upgrade)return false;
  building.activeUpgrade={id:upgrade.id,kind,delivered:resourceCounts()};
  closeUpgradeMenu();
  // free costs (debug): the job is accepted normally, then satisfied through the same
  // applyFinishedUpgrade() a full delivery reaches. Nothing is deducted or granted.
  if(DBG.freeCosts&&applyFinishedUpgrade(building))return true;
  toast("accepted "+upgrade.name+" — deposit resources at the "+kind);sound(590,.1);
  return true;
}

// ── the skill tree ──
// THE only writer of the two id sets (state.skillTree.revealed / .selected); the `open` flag beside
// them is written by openSkillTree() / closeSkillTree() below and by nothing else. Taking a node
// reveals its immediate neighbours — ONE hop, either direction along an edge — and spends one
// skill point. Refusals are silent no-ops, so a UI may call this on any click without pre-checking.
export function selectSkillNode(id){
  const tree=state.skillTree;
  if(!SKILL_NODES_BY_ID[id])return false;                          // not a node at all
  if(!tree.revealed.has(id)||tree.selected.has(id)||state.skillPoints<=0)return false;
  state.skillPoints--;tree.selected.add(id);
  for(const neighbour of SKILL_NEIGHBORS[id])tree.revealed.add(neighbour);
  effects.skillTreeChanged();effects.phaseHudChanged();
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
function debugForceNextChestOutcome(outcome=null){
  invariant(outcome===null||outcome==="cache"||outcome==="pinata","invalid forced chest outcome "+outcome);
  forcedChestOutcome=outcome;return true;
}
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

/** XP economy read-only peeks; state mutations remain inside feeding and skill commands. */
function xp(){return state.xp;}
function skillPoints(){return state.skillPoints;}
/** The level bar: xp is progress INTO the current level, next is what the following one costs. */
export function levelState(){return {level:state.level,xp:state.levelXp,next:levelCost(state.level)};}
/** The live offer as three card ids, or null when no draft is pending. Never mutate the array. */
export function draftPending(){return state.draft.offer;}
/** Why the pending offer exists — "level" or "dawn" — or null when none is. Same offer, same pick. */
export function draftKind(){return state.draft.offer?state.draft.offerKind:null;}
/**
 * Take card `index` (0-2) of the pending offer. Routes the card through takeCard() — a buff applies,
 * a consumable or blueprint goes to the hand — consumes the offer and, if more rewards are queued,
 * deals the next one immediately, so the world stays frozen until the queue drains. Refusals are
 * silent, so a UI may call this on any click without pre-checking.
 */
export function chooseDraft(index){
  const offer=state.draft.offer;
  if(!offer||!Number.isInteger(index)||index<0||index>=offer.length)return false;
  const id=offer[index];state.draft.offer=null;state.draft.offerKind=null;takeCard(id);refillDraft();
  return true;
}
/**
 * The held cards, oldest first: {id, count, charges}. `count` is how many COPIES of that card are
 * held; `charges` is the remaining placements of a part-spent kit (null while the top copy is
 * whole), so a UI can show "2 of 3 spikes left" without knowing what a spike kit is. Fresh records
 * every call — read them, never write them; playCard() is the only way in.
 */
export function hand(){return state.hand.map(entry=>({id:entry.id,count:entry.count,charges:entry.charges}));}
/**
 * Play held card `index`. Returns false when the index names nothing, the world is frozen (a pending
 * offer, a pause, a lost run) or a placement is already armed; "applied" when the effect fired and
 * the card left the hand; "targeting" when the placement flow now owns the next click — the card
 * stays in hand, one charge lighter per placement, until its last charge lands.
 */
export function playCard(index){
  if(!Number.isInteger(index)||index<0||index>=state.hand.length)return false;
  // heldChest(): the same refusal the build dock used to make. A chest in hand owns the pointer
  // (right-click puts it down), so arming a placement under it would leave a ghost nothing can
  // commit — leftClick() returns early while a chest is held.
  if(state.gameOver||state.paused||state.draftPaused||state.buildMode||state.cardTargeting||heldChest())return false;
  const entry=state.hand[index],card=cardById[entry.id];
  if(!card)return false;
  if(TARGETED_CARDS[entry.id])return beginCardTargeting(entry);
  const effect=CARD_EFFECTS[entry.id];
  if(!effect)return false;                  // a held card with no effect is a catalog bug, not a click
  effect();toast("played: "+card.text);sound(700,.16);consumeHandCopy(entry);
  return "applied";
}
/** What the held-action timer is currently filling, or null. Read-only peek. */
export function heldChopTarget(){ return chopState.target; }
/** Whether temporary blueprint recruitment has saved an assignment for this worker. */
function workerIsLoaned(worker){ return !!worker?.homePost; }
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
  state, trees, rocks, diamonds, grass, resourceDrops, chests, buildings, damageDummies, showcaseProps, workerCorpses, particles, damageNumbers,
  // debug flags (the gameplay pane's own bindings are the only writers)
  DBG,
  // the step
  update,
  // notifications the UI itself raises (boot message, debug readouts)
  toast,
  // hover / action resolution
  hoverTarget, hoveredBuilding, badgeAction, chopTarget, chopProgress,
  resolvePrimaryAction,
  // placement + immutable, coordinate-explicit terrain queries
  canPlace, indicatorRadius, towerRadius, towerVariant,
  terrainAtRasterCell,terrainAtWorldPoint,terrainWorldRectEntirelyOnLand,terrainMetadata,terrainRaisedAtCell,
  vegetationMetadata,
  // costs and progress
  buildingCost, costText, upgradeList, towerUpgradeList, nextHouseCost,
  // world lookups the render layer projects
  storageServiceRadius, workerAssignmentAt, heldWorker, heldBuilding, heldChest, heldProp,
  workerOccupancyStatus, workerOccupancyAt, durablePostStatus, vacantDurablePosts,
  workerIsLoaned, workerCoatColor, workerLoad, carriedTotal, resourceIsActive,
  // skill tree — read-only projections of the authored graph over this run's two id sets
  skillTreeNodes, skillTreeEdges, xp, skillPoints, waveTier, livingActiveWaveEnemies, levelCost, buffStacks,
  // the effective vacuum reach, buffs included — the drawn ring should read this, not TUNE alone
  vacuumRadius,
  // shared numeric helpers (defined here, so nothing restates them)
  clamp, distance, rand,
  // commands that are plain gameplay functions rather than input adapters
  togglePause, cancelBuildMode, clampCamera, stopGameplayInput, cancelHeldObject,
  spawnEnemy, transitionPhase,
  // debug commands (view panel > gameplay)
  debugGrant, debugGrantXp, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase,
  debugStartWave, debugClearEnemies, debugHealAll, debugForceNextChestOutcome, debugDealCard, debugClearHand,
};
