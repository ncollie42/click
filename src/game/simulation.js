// Owns all mutable gameplay and showcase state. Commands mutate it; render/UI queries only read it.
// update() dispatches to explicit normal/showcase pipelines; browser effects leave through connect().

import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,BUILD_MARGIN,
  CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,GRID_COLS,GRID_ROWS,
  FOOTPRINT_1x1,FOOTPRINT_3x3,RESOURCE_FOOTPRINT,
  RESOURCE_KINDS,RESOURCE_NODE_HP,FOG,CHEST,CARD_BUFFS,CARD_CONSUMABLES,
  HOUSE_SLOTS,STARTING_HOUSE_COST,HOUSE_COST,HOUSE_COST_ESCALATION,WORKER_SPAWN_TIME,RESOURCE_NODE_JOB_SLOTS,
  WORKER_LEASH,WORKER_MELEE,WORKER_SPEED,WORKER_HP,WORKER_DAMAGE,WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_CARRY,STAFF_GATHER,
  BUILDING_TYPES,MAIN_BASE,MAIN_BASE_LEVELS,UPGRADES,TOWER_VARIANTS,
  ENEMY_TYPES,ENEMY_SPAWN_RADIUS,
  ENEMY_POOL,
  NIGHT_WAVE_WINDOW,NIGHT_ENEMY_CAP,NIGHT_WAVE_RECIPES,WAVE_THREAT_CURVE,WAVE_BOSS_SPAWNS,WIN_WAVE,
  DAY_DURATION,NIGHT_OVERLAY_ALPHA,LIGHT_FADE_TIME,
  STEADY_HAND_RATE,FIREBALL,METEOR,DAMAGE_TARGET_TYPE,DAMAGE_ORBS,SUMMONING_CIRCLE,CONSUMABLE_FORGE,DRAFT_REROLL,FRIENDLY_BRUTE,CAPTURE_YARD,GARRISON
} from "./data.js";
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCellBounds,footprintCells,footprintWorldRect,footprintInWorldBounds
} from "./grid.js";
import {
  buildStarterWorld,LAND,WATER,TERRAIN_ORDER,TERRAIN_CELL_SIZE,TERRAIN_COLS,TERRAIN_ROWS,TERRAIN_ORIGIN_X,TERRAIN_ORIGIN_Y,
  terrainAtRasterCell as queryTerrainAtRasterCell,terrainAtWorldPoint as queryTerrainAtWorldPoint,
  validateTerrainTags,worldRectEntirelyOnLand
} from "./authored-map.js";
// Authored showcase coordinates are immutable input; all live fixture objects remain owned here.
import {SHOWCASE_MANIFEST} from "./showcase-data.js";
// The authored card catalog stays immutable; RewardDraft owns the run's finite Card Pull.
import {CARDS,RARITY_WEIGHTS,cardById} from "./cards.js";
import {createRewardDraft} from "./reward-draft.js";

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
  snapRadius:110,    // game px a held swing stays locked to its target after the cursor slips off [slider vSnapR]
  vacuumRadius:45,   // game px that collectDrop() sweeps            [slider vRadius]
  suckRate:.08,      // seconds between vacuum pickups               [slider vRate]
  chopYield:1,       // drops spawned per completed player chop      [slider vYield]
  clickDamage:1,     // hp removed per completed player swing        [slider vDamage]
  gameSpeed:1,       // whole simulation steps per rendered frame    [slider vSpeed]
  builderSourceRadius:400, // blueprint-centered loose-drop scan [slider vBuilderRadius]
  freeSearchRadius:500, // expanded free-worker search tier      [slider vFreeSearchRadius]
  fleeHpThreshold:1, // survival-interrupt hp per 5 max hp; scaled by workerMaxHp so fortified guards flee at 2
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
  victory(){},               // the win wave was cleared; the run is over, won
  victoryContinued(){},      // the player dismissed victory and resumed into the next day
  pauseChanged(){},          // (paused)
  baseLevelChanged(){},      // the main base gained a level, or banked progress toward the next
  draftChanged(){},          // an offer appeared, was consumed, or was replaced by the next one
  handChanged(){},           // the held-card list moved: a card arrived, was spent, or lost a charge
  buildHudChanged(){},       // placement mode was armed or cleared (the crosshair, the lifted card)
  upgradeMenuOpened(){},     // state.upgradeMenu is populated; show and render the panel
  upgradeMenuClosed(){},     // state.upgradeMenu is cleared; hide the panel
  phaseHudChanged(){},       // a debug command jumped the clock; re-read the phase HUD
  isModalOpen(){return false;},   // does a modal currently own input?
  isCombatTargetOnScreen(){return false;}, // renderer injects the active-camera frustum query
};
let effects = NO_EFFECTS;
/** Install the adapter. Unlisted hooks keep their no-op default. */
export function connect(impl){ effects = {...NO_EFFECTS, ...impl}; return effects; }
/** Single funnel for audio, so no gameplay path touches an AudioContext. */
function sound(freq,duration){ effects.sound(freq,duration); }

// Harvesting is hold-to-fill rather than per-click, so it needs its own timer.
const chopState={target:null,kind:null,action:null,t:0};
function beginChop(hit){
  if(chopState.target===hit.target)return;
  chopState.target=hit.target;chopState.kind=hit.kind;chopState.action=hit;chopState.t=0;
}
function resetChop(){chopState.target=null;chopState.kind=null;chopState.action=null;chopState.t=0;}
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
// Friendly Brutes are combat units, not workers or enemies. Circles create them; their dedicated
// collection keeps hostile wave membership and worker economy free of special-case identities.
const friendlyBrutes = [];
// Controlled enemies are converted hostiles that fight for the player. A dedicated collection keeps
// them out of hostile wave accounting, the worker economy, and the Friendly Brute contract. Each
// unit keeps its authored ENEMY_TYPES record and links to exactly ONE completed Capture Yard as its
// sourceYard; yard occupancy is always derived by counting living linked units, never stored.
const controlledEnemies = [];
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
// Lightning segments, one per jump, shared by the chainLightning buff and the lightning tower.
// Damage resolved the instant an arc is pushed; scene.js only draws {x1,y1,x2,y2,age,seed} and
// `seed` keeps a bolt's jitter stable while it fades.
const lightningArcs = [];
// Falling spell records own gameplay timing. Casts only push records. Their update functions apply
// damage at touchdown, while scene.js reads the same clocks to draw each descent and impact cue.
const fallingMeteors = [];
const fallingFireballs = [];
let damageNumberSequence=0;
const state = {
  runMode:"normal",
  mouse:{x:W/2,y:H/2,inside:false},
  carried:{wood:0,stone:0,dust:0,coin:0,diamond:0}, stored:{wood:0,stone:0,dust:0,coin:0,diamond:0}, workers:[], enemies:[],
  // Applied card effects stay with the gameplay state they mutate. RewardDraft separately owns the
  // Card Pull, reward backlog, and live offer, so selection rules cannot leak into effect state.
  draft:{buffs:{},calmNight:false,dayBonus:0},
  // ── the hand ──
  // Every card the player is HOLDING, oldest first. One entry per id: {id, count, charges} where
  // count is how many copies are held and charges is the partially-spent kit's remaining placements
  // (null when the top copy is untouched). Written only by the hand helpers below.
  hand:[],
  // The card currently steering state.buildMode, or null: {id, type, cast}. `type` is the authored
  // BUILDING_TYPES key whose ghost/footprint the placement flow draws; `cast` replaces placement
  // with a spell call at the anchor.
  cardTargeting:null,
  // baseLevel is THE authority on whether a base stands: 0 while the map centre is bare (the
  // pre-wave opening), then the authored MAIN_BASE_LEVELS level it has reached. Every base service —
  // storage, hover, enemy target, the rendered structure — asks mainBaseStanding(), never the
  // presence of a building record, so the showcase fixture (level 1, no construction record) and a
  // real run answer the same question the same way. baseHp/baseMax stay the health pool the baseHp
  // card grows; nothing may damage the base while baseLevel is 0.
  baseLevel:0,
  // Progress toward the NEXT authored level, MAIN_BASE_LEVELS[baseLevel], as a resource-count record.
  // Written only by the main-base section below and cleared by every level it completes, so a
  // partial delivery survives any number of frames, releases and phase flips.
  // OWNERSHIP SPLIT, and the only one: while baseLevel is 0 the level-1 recipe is an ordinary
  // CONSTRUCTION SITE, so its progress lives on that building record's `delivered` and this record
  // stays all zeros (asserted). From level 1 on there is no site left and this is the whole ledger.
  baseDelivered:{wood:0,stone:0,dust:0,coin:0,diamond:0},
  baseHp:100,baseMax:100,gameOver:false,victory:false,continuedAfterVictory:false,paused:false,draftPaused:false,coinTimer:45,basePulse:0,screenShake:0,buildMode:null,capacity:5,toastTimer:0,collectCooldown:0,collecting:false,
  // elapsed is simulated run time. remaining is the authoritative DAY countdown only; night has
  // no deadline and ends from active-wave clearance after the frame's complete combat pipeline.
  // THREE phases, not two: a run BOOTS into "pre-wave", the untimed gathering opening that lasts
  // until the main base stands (remaining is 0, light stays full, no wave is ever scheduled). It is
  // a real phase rather than a daytime flag so every phase reader has to answer for it explicitly.
  // pre-wave is entered once, at world load, and left once, through beginFirstDay().
  clock:{phase:"pre-wave",remaining:0,completedNights:0,light:0,elapsed:0},
  // activeNightNumber owns the generation currently eligible to gate dawn. Scheduled enemies copy
  // it to enemy.waveNightNumber; manual/showcase enemies deliberately omit that field.
  nightWave:{upcomingPlan:null,activePlan:null,threatBudget:0,spawnedThreat:0,totalSpawns:0,remainingSpawns:0,elapsed:0,nextSpawnAt:0,nightNumber:0,activeNightNumber:null},
  camera:{x:BASE.x,y:BASE.y,zoom:1,panning:false,lastX:0,lastY:0}, keys:new Set(),
  upgradeMenu:{building:null,selected:null,kind:null},primaryClick:{held:false,audioCooldown:0},heldObject:null,showcaseFocus:null,
  // The standing base's automatic defence (updateBaseAttack). Same three fields a tower's `tower`
  // record carries for the renderer: the cadence gate, a decaying muzzle flash, and where the last
  // shot went. Purely runtime — every NUMBER behind it is MAIN_BASE's.
  baseAttack:{cooldown:0,flash:0,targetX:BASE.x,targetY:BASE.y}
};

const rewardDraft=createRewardDraft({cards:CARDS,rarityWeights:RARITY_WEIGHTS,rerollCost:DRAFT_REROLL.coinCost});

const rand = (a,b) => a + Math.random()*(b-a);
// ── presentation randomness (juice only) ────────────────────────────────────
// A SECOND, independent stream, used by the fx* emitters below and by nothing else. Gameplay rolls
// (spawn points, loot, crits, resource-source cells) all draw from Math.random, and headless runs
// pin outcomes against a seeded replacement for it — scripts/validate.mjs installs an LCG over
// Math.random and asserts against the results. One extra rand() inside a dust puff would therefore
// reshuffle real gameplay, so garnish is never allowed to touch that stream. This one is seeded
// from a constant, so it is deterministic too: two identical runs still emit identical debris.
let fxSeed=0x9e3779b9>>>0;
const fxRand=(a,b)=>a+((fxSeed=Math.imul(fxSeed,1664525)+1013904223>>>0)/0x100000000)*(b-a);
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
  instantWorkers:true,      // houses ignore their spawn timer by default
  groundSourcing:true,      // builders prefer loose drops before covered storage
  builderSelfSupply:true    // starved builders mine one bounded, needed resource at a time
};

// ── Global upgrade ownership flow ──
// Legitimate writes: completed obelisks set building.upgrades[id] in dropToUpgrade().
// Gameplay reads:    globalUpgradeEnabled() is pure obelisk ownership; there is no override map.
function legitimateGlobalUpgradeOwned(id){return buildings.some(building=>building.complete&&building.type==="obelisk"&&building.upgrades[id]);}
function globalUpgradeEnabled(id){return legitimateGlobalUpgradeOwned(id);}
// Broader authored Spawn Pools unlock with NIGHTS SURVIVED, not with a player level — the XP track
// this used to read (Math.floor(state.level/3)) was deleted Aug 22 and elapsed nights is the
// progression number the wave composer already thinks in. nightNumber counts nights BEGUN, so the
// upcoming wave is nightNumber+1: tier 0 covers waves 1-2, tier 1 waves 3-4, tier 2 waves 5+.
// Quantity/difficulty still comes from waveThreatBudget() alone, so enemy stats never hidden-scale.
function waveTier(){return Math.min(4,Math.floor(state.nightWave.nightNumber/2));}
// Runtime curve holder. WAVE_THREAT_CURVE remains the authored reset/default; only the debugger's
// setter below writes this holder, and an active Spawn Plan remains an immutable snapshot.
const WAVE_TUNE={...WAVE_THREAT_CURVE};
/** Normalized power ramp with explicit endpoints. This is the one mathematical difficulty knob:
 *   B(w)=B0+(BX-B0)*clamp((w-1)/(X-1),0,1)^p
 * `power` >1 delays growth then steepens it; 1 is linear; 0<p<1 front-loads growth. */
function waveThreatBudget(waveNumber){
  const {startBudget,targetBudget,targetWave,power}=WAVE_TUNE;
  const t=clamp((waveNumber-1)/Math.max(1,targetWave-1),0,1);
  const curveBudget=Math.max(1,Math.round(startBudget+(targetBudget-startBudget)*t**power));
  const forcedBossThreat=(WAVE_BOSS_SPAWNS[waveNumber]||[]).reduce((sum,type)=>sum+(ENEMY_TYPES[type]?.threatCost||0),0);
  return Math.max(curveBudget,forcedBossThreat);
}
let spawnPlanRevision=0;
/** Spend an integer Threat Budget against one recipe's archetype pool. Wave number unlocks fixed-stat
 * color variants; each enemy's spawnWeight says how often. A base cost-1 raider guarantees exact spend. */
function composeSpawnPlan(recipe,waveNumber,{budget=waveThreatBudget(waveNumber),immediateFirst=false}={}){
  const archetypes=new Set(recipe.pool);
  const pool=Object.entries(ENEMY_TYPES).filter(([,def])=>!def.boss&&archetypes.has(def.archetype)&&def.minWave<=waveNumber).map(([type,def])=>({type,...def}));
  invariant(pool.length>0&&pool.every(enemy=>Number.isInteger(enemy.threatCost)&&enemy.threatCost>0&&enemy.spawnWeight>0),"invalid threat pool "+recipe.id);
  invariant(pool.some(enemy=>enemy.threatCost===1),"threat pool cannot spend every integer budget: "+recipe.id);
  const forcedBosses=(WAVE_BOSS_SPAWNS[waveNumber]||[]).map(type=>({type,...ENEMY_TYPES[type]}));
  invariant(forcedBosses.every(boss=>boss.threatCost>0),"forced boss schedule contains an unknown type");
  const forcedBossThreat=forcedBosses.reduce((sum,boss)=>sum+boss.threatCost,0);
  invariant(forcedBossThreat<=budget,"forced bosses exceed wave threat budget: wave "+waveNumber);
  const entries=[];let remaining=budget-forcedBossThreat;
  while(remaining>0){
    const eligible=pool.filter(enemy=>enemy.threatCost<=remaining);
    const totalWeight=eligible.reduce((sum,enemy)=>sum+enemy.spawnWeight,0);
    let roll=Math.random()*totalWeight,selected=eligible.at(-1);
    for(const enemy of eligible){roll-=enemy.spawnWeight;if(roll<0){selected=enemy;break;}}
    entries.push({type:selected.type,threatCost:selected.threatCost,at:0});remaining-=selected.threatCost;
  }
  // Forced bosses close the schedule rather than displacing the opening pressure.
  for(const boss of forcedBosses)entries.push({type:boss.type,threatCost:boss.threatCost,at:0});
  let spent=0;
  for(let index=0;index<entries.length;index++){
    const entry=entries[index];entry.at=immediateFirst&&index===0?0:NIGHT_WAVE_WINDOW*(spent+entry.threatCost/2)/budget;spent+=entry.threatCost;Object.freeze(entry);
  }
  return Object.freeze({id:"plan-"+(++spawnPlanRevision),sourceId:recipe.id,waveNumber,threatBudget:budget,entries:Object.freeze(entries)});
}
/** Living scheduled enemies from this night only. Manual/debug and showcase enemies have no
 * waveNightNumber, while survivors from a force-ended older night retain their retired identity. */
function livingActiveWaveEnemies(){
  const activeNightNumber=state.nightWave.activeNightNumber;
  if(activeNightNumber===null)return 0;
  const placed=state.enemies.reduce((count,enemy)=>count+(enemy.hp>0&&enemy.waveNightNumber===activeNightNumber?1:0),0);
  return placed+(heldEnemy()?.waveNightNumber===activeNightNumber?1:0);
}
function chooseUpcomingNight(){
  const recipes=NIGHT_WAVE_RECIPES.filter(recipe=>recipe.minTier<=waveTier());
  const recipe=recipes[(Math.random()*recipes.length)|0],waveNumber=state.nightWave.nightNumber+1;
  state.nightWave.upcomingPlan=composeSpawnPlan(recipe,waveNumber);
}
/** Debug-authoring command: update future difficulty and recompose only the upcoming plan. The active
 * plan is never touched, so moving a slider cannot add or remove work from a wave in progress. */
function setWaveThreatCurve(patch){
  const next={...WAVE_TUNE,...patch};
  if(!Number.isInteger(next.startBudget)||next.startBudget<1||!Number.isInteger(next.targetBudget)||next.targetBudget<next.startBudget||!Number.isInteger(next.targetWave)||next.targetWave<2||!Number.isFinite(next.power)||next.power<=0)return false;
  if(Object.keys(WAVE_TUNE).every(key=>WAVE_TUNE[key]===next[key]))return true;
  Object.assign(WAVE_TUNE,next);
  const plan=state.nightWave.upcomingPlan,recipe=plan&&NIGHT_WAVE_RECIPES.find(item=>item.id===plan.sourceId);
  if(recipe){state.nightWave.upcomingPlan=composeSpawnPlan(recipe,state.nightWave.nightNumber+1);effects.phaseHudChanged();}
  return true;
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
// The showcase sandbox is all revealed land by definition, so this path also drops the fog field.
function installAllLandTerrain(){installTerrain(Array(terrainDescriptor.terrainCols*terrainDescriptor.terrainRows).fill(LAND));clearAllFog();}
function replaceGrass(cells){
  grass.length=0;grassByCell.clear();
  for(const cell of cells){const {x,y}=cellToWorld(cell.cx,cell.cy),tuft={x,y,hp:1,max:1,variant:cell.variant??0};grass.push(tuft);grassByCell.set(cell.cy*GRID_COLS+cell.cx,tuft);}
  vegetationRevision++;
}
function materializeWorld(blueprint){
  installTerrain(blueprint.terrain,blueprint);
  trees.length=rocks.length=diamonds.length=chests.length=0;replaceGrass(blueprint.grass||[]);
  // One HP produces one drop, so node health is also its total resource yield.
  blueprint.trees.forEach((cell,index)=>{const {x,y}=cellToWorld(cell.cx,cell.cy),hp=RESOURCE_NODE_HP.wood;trees.push({x,y,hp,max:hp,stump:0,shake:0,variant:cell.variant??index%3,footprint:RESOURCE_FOOTPRINT});});
  blueprint.rocks.forEach(cell=>{const {x,y}=cellToWorld(cell.cx,cell.cy),hp=RESOURCE_NODE_HP.stone;rocks.push({x,y,hp,max:hp,depleted:0,shake:0,footprint:RESOURCE_FOOTPRINT});});
  blueprint.diamonds.forEach(cell=>{const {x,y}=cellToWorld(cell.cx,cell.cy),hp=RESOURCE_NODE_HP.diamond;diamonds.push({x,y,hp,max:hp,depleted:0,shake:0,footprint:RESOURCE_FOOTPRINT});});
  blueprint.chests.forEach(cell=>{const {x,y}=cellToWorld(cell.cx,cell.cy);chests.push({x,y,hp:CHEST.maxHp,max:CHEST.maxHp,shake:0,footprint:CHEST.footprint});});
}
function terrainAtRasterCell(terrainX,terrainY){return queryTerrainAtRasterCell(terrainRuntime,terrainX,terrainY);}
function terrainRaisedAtCell(cx,cy){return Number.isInteger(cx)&&Number.isInteger(cy)&&cx>=0&&cy>=0&&cx<GRID_COLS&&cy<GRID_ROWS&&raisedStorage[cy*GRID_COLS+cx]===1;}
function terrainAtWorldPoint(worldX,worldY){return queryTerrainAtWorldPoint(terrainRuntime,worldX,worldY);}
function terrainWorldRectEntirelyOnLand(rect){return worldRectEntirelyOnLand(terrainRuntime,rect);}
function terrainMetadata(){return terrainDescriptor;}
function vegetationMetadata(){return Object.freeze({revision:vegetationRevision,count:grass.length});}
// ── mineable fog of war ─────────────────────────────────────────────────────
// The unexplored map is a field of destructible fog blocks, one per fully-on-land placement cell
// beyond the starting clearing. Blocks are mined like resource nodes (player clicks, or workers
// posted on a scout hut); a cleared cell is gone for the run. `fogByCell` is the identity index
// every lookup uses; `fogRevision` invalidates the render layer's instanced field.
const fog=[],fogByCell=new Map();
// Pending cascade pops: {cell,at,ring} entries scheduled by a mined-out block, popped when the
// clock reaches them. cell.popQueued marks membership so a cell is never scheduled twice.
const fogPopQueue=[];
// Presentation-only death records: a cleared block leaves gameplay INSTANTLY (index, revision,
// targeting all updated) but lingers here for popAnimTime so the render layer can play its
// inflate-then-collapse tween. Nothing in gameplay may ever read this list.
const fogPops=[];
let fogRevision=0;
// The field extends FOG.marginCells beyond the world rect, so indices go negative: the key pads
// both axes by 64 and strides wider than any padded column count can reach, keeping keys unique.
const FOG_KEY_PAD=64,FOG_KEY_STRIDE=2048;
const fogCellKey=(cx,cy)=>(cy+FOG_KEY_PAD)*FOG_KEY_STRIDE+(cx+FOG_KEY_PAD);
function fogAtPoint(x,y){const cell=worldToCell(x,y);return fogByCell.get(fogCellKey(cell.cx,cell.cy))||null;}
function buildFogField(){
  fog.length=0;fogByCell.clear();fogPopQueue.length=0;fogRevision++;
  // Fog covers EVERYTHING beyond the clearing — land, coast, open water, and a marginCells-wide
  // apron past every world edge — so neither the map silhouette nor the sea rim shows until mined.
  const minC=-FOG.marginCells,maxCx=GRID_COLS+FOG.marginCells,maxCy=GRID_ROWS+FOG.marginCells;
  for(let cy=minC;cy<maxCy;cy++)for(let cx=minC;cx<maxCx;cx++){
    const {x,y}=cellToWorld(cx,cy),d=distance(x,y,BASE.x,BASE.y);
    if(d<FOG.clearRadius)continue;
    // The water tag is presentation truth (blocks sit down at water level) and worker policy truth
    // (the scheduler never sends a walker out onto water to mine). idx is the cell's live position
    // in `fog`, maintained by clearFogCell's swap-remove so clears are O(1).
    // Health is FLAT — FOG.blockHp everywhere (the BFS ring-depth ramp is gone, see data.js).
    const cell={x,y,cx,cy,idx:fog.length,hp:FOG.blockHp,max:FOG.blockHp,shake:0,water:terrainAtWorldPoint(x,y)!==LAND,footprint:RESOURCE_FOOTPRINT};
    fog.push(cell);fogByCell.set(fogCellKey(cx,cy),cell);
  }
  fogPops.length=0;
}
function clearAllFog(){if(!fog.length&&fogRevision>0)return;fog.length=0;fogByCell.clear();fogPopQueue.length=0;fogPops.length=0;fogRevision++;}
function fogMetadata(){return Object.freeze({revision:fogRevision,count:fog.length});}
/** Every cell of a candidate footprint must be fog-free before anything may occupy it. */
function footprintFogFree(x,y,footprint=FOOTPRINT_1x1){
  if(!fog.length)return true;
  const cell=worldToCell(x,y),b=footprintCellBounds(cell.cx,cell.cy,footprint);
  for(let cy=b.minY;cy<=b.maxY;cy++)for(let cx=b.minX;cx<=b.maxX;cx++)if(fogByCell.has(fogCellKey(cx,cy)))return false;
  return true;
}
// The world is authored data, not an algorithm: src/game/maps/starter.map.json,
// edited in tools/map-editor.html. Startup is fully deterministic.
materializeWorld(buildStarterWorld());
buildFogField();

const RUN_MODES=new Set(["normal","showcase"]);
const RESOURCE_KIND_SET=new Set(RESOURCE_KINDS);
// The closed worker-job vocabulary. `free` is the autonomous idle role workers spawn into;
// `guard` exists only as a GARRISON posting — reached by dropping a worker onto a station or by the
// autonomous muster answering a nearby hostile. `clearfog` exists only as a SCOUT HUT posting
// (drop or construction inheritance) — the posted scout mines fog frontier blocks for as long as
// it holds the post. Dropping a worker on open ground or a house repositions it as free, and no
// other path in the game mints a guard or a scout.
const WORKER_JOBS=new Set(["free","build","haul","harvest","staff","guard","clearfog"]);
let initializedMode=null;
function invariant(condition,message){if(!condition)throw new Error("simulation invariant: "+message);}
function assertCombatKind(target){
  invariant(target&&["enemy","damage-dummy"].includes(target.combatKind),"unknown combat kind "+target?.combatKind);
  return target.combatKind;
}
function assertHeldKind(held){
  invariant(held&&["worker","enemy","building","chest","showcase-prop"].includes(held.kind),"unknown held kind "+held?.kind);
  return held.kind;
}
function makeShowcaseWorker(f,index){
  // Authored fixtures are manual assignments: `autonomous` is explicit provenance, never inferred.
  return {x:f.x,y:f.y,postX:f.x,postY:f.y,spawnSource:null,job:f.job,jobTarget:null,autonomous:false,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:resourceCounts(),hp:WORKER_HP,attackCooldown:0,hitCooldown:0,step:index*.4,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,guardSafeTime:0,garrisonBonus:false,displayUnit:true,displayTool:f.tool||null,showcaseKey:"worker:"+f.id,showcaseLabel:f.label,showcaseSection:f.section};
}
function clearShowcaseLive(){
  cancelHeldObject();closeUpgradeMenu();resetChop();state.showcaseFocus=null;
  trees.length=rocks.length=diamonds.length=resourceDrops.length=buildings.length=friendlyBrutes.length=controlledEnemies.length=chests.length=damageDummies.length=showcaseProps.length=showcaseLabelRecords.length=workerCorpses.length=particles.length=damageNumbers.length=lightningArcs.length=fallingMeteors.length=fallingFireballs.length=0;replaceGrass([]);state.workers.length=state.enemies.length=0;state.screenShake=0;
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
    {key:"fixed:base",entity:BASE,label:"base",section:"units",height:88}
  );
  for(const items of [[...trees,...rocks,...diamonds],resourceDrops,chests,buildings,state.workers,state.enemies,damageDummies,showcaseProps])
    for(const entity of items)if(entity.showcaseLabel)showcaseLabelRecords.push({key:entity.showcaseKey,entity,label:entity.showcaseLabel,section:entity.showcaseSection,height:entity.type==="tower"?70:38});
  invariant(new Set(showcaseLabelRecords.map(record=>record.key)).size===showcaseLabelRecords.length,"duplicate showcase label key");
  showcaseRevision++;
  validateSimulationInvariants();
}
// First initialization selects a closed run mode. Repeating the same mode is idempotent for normal
// and rebuilds authored fixtures for showcase; switching an installed simulation is rejected.
function resetShowcaseEconomy(){state.draft={buffs:{},calmNight:false,dayBonus:0};rewardDraft.reset();state.draftPaused=false;state.hand.length=0;state.cardTargeting=null;effects.baseLevelChanged();effects.draftChanged();effects.handChanged();effects.phaseHudChanged();}
// ── the opening hand ────────────────────────────────────────────────────────
// ONE card. The run opens with nothing on the map and no clock pressure: the player gathers 10 wood
// by hand, plays this card to raise the base site, and delivers the wood to it. Completing it ends
// pre-wave and starts day 1, and the base level it completes is what deals the first draft — so the
// house and the first tower are now EARNED in the opening rather than handed out with it.
const STARTING_HAND=["bpMainBase"];
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
  // The showcase is a FIXTURE world, not a run: its base is simply standing (level 1) with no
  // construction record behind it, so every base service the gallery shows — storage ring, the
  // "fixed:base" label, the rendered structure — works exactly as it did before the base became
  // player-built. It therefore never sees "pre-wave": the sandbox opens, and stays, in day.
  state.gameOver=false;state.victory=false;state.continuedAfterVictory=false;state.paused=false;state.showcaseFocus=null;state.baseLevel=1;state.baseDelivered=resourceCounts();state.baseHp=state.baseMax;resetShowcaseEconomy();state.clock={phase:"day",remaining:DAY_DURATION,completedNights:0,light:0,elapsed:0};state.nightWave.upcomingPlan=null;state.nightWave.activePlan=null;state.nightWave.threatBudget=0;state.nightWave.spawnedThreat=0;state.nightWave.totalSpawns=0;state.nightWave.remainingSpawns=0;state.nightWave.elapsed=0;state.nightWave.nextSpawnAt=0;state.nightWave.activeNightNumber=null;state.camera.x=SHOWCASE_MANIFEST.sections.towers.x;state.camera.y=SHOWCASE_MANIFEST.sections.towers.y;state.camera.zoom=SHOWCASE_MANIFEST.sections.towers.zoom;state.keys.clear();state.buildMode=null;state.carried=resourceCounts();state.stored=resourceCounts();buildShowcaseFixtures();clampCamera();effects.pauseChanged(false);
}
export function rebuildShowcase(){if(state.runMode!=="showcase")return false;resetShowcaseEconomy();installAllLandTerrain();buildShowcaseFixtures();return true;}
function assertTemporaryBuildingState(building){
  if(building.orbs)invariant(building.type==="damageOrbs"&&Number.isInteger(building.orbs.count)&&building.orbs.count>=DAMAGE_ORBS.minCount&&building.orbs.count<=DAMAGE_ORBS.maxCount&&building.orbs.remaining>0&&building.orbs.remaining<=DAMAGE_ORBS.duration,"illegal damage-orb state");
  if(building.summoning)invariant(building.type==="summoningCircle"&&Number.isInteger(building.summoning.dust)&&building.summoning.dust>=0&&building.summoning.dust<SUMMONING_CIRCLE.dustCost&&building.summoning.remaining>0&&building.summoning.remaining<=SUMMONING_CIRCLE.duration,"illegal summoning-circle state");
  if(building.type==="consumableForge")invariant(building.consumableForge&&Number.isInteger(building.consumableForge.dust)&&building.consumableForge.dust>=0&&building.consumableForge.dust<CONSUMABLE_FORGE.dustCost,"illegal consumable-forge state");
}

export function validateSimulationInvariants(){
  invariant(RUN_MODES.has(state.runMode),"invalid run mode "+state.runMode);
  invariant(Object.isFrozen(terrainStorage),"terrain storage is mutable");
  invariant(terrainStorage.length===terrainDescriptor.terrainCols*terrainDescriptor.terrainRows,"terrain dimensions disagree with metadata");
  invariant(terrainStorage.every(tag=>tag===LAND||tag===WATER),"unknown terrain tag");
  invariant(terrainDescriptor.width===W&&terrainDescriptor.height===H&&terrainDescriptor.terrainCellSize===TERRAIN_CELL_SIZE&&terrainDescriptor.terrainOriginX===TERRAIN_ORIGIN_X&&terrainDescriptor.terrainOriginY===TERRAIN_ORIGIN_Y&&terrainDescriptor.terrainCols===TERRAIN_COLS&&terrainDescriptor.terrainRows===TERRAIN_ROWS&&terrainDescriptor.terrainOrder===TERRAIN_ORDER,"terrain metadata drifted");
  invariant(Number.isInteger(terrainDescriptor.revision)&&terrainDescriptor.revision>0,"invalid terrain revision");
  invariant(Number.isFinite(state.baseHp)&&state.baseHp>=0&&state.baseHp<=state.baseMax,"illegal base health");
  invariant(typeof state.victory==="boolean"&&typeof state.continuedAfterVictory==="boolean"&&(!state.victory||state.gameOver)&&!(state.victory&&state.continuedAfterVictory),"illegal victory lifecycle");
  invariant(["pre-wave","day","night"].includes(state.clock.phase),"illegal phase "+state.clock.phase);
  invariant(Number.isFinite(state.clock.remaining)&&state.clock.remaining>=0,"illegal phase countdown");
  // ── the main base ──
  // baseLevel and the clock are two views of ONE fact: a normal run is in pre-wave exactly while no
  // base stands. The showcase is the documented exception — a fixture base with no site record.
  invariant(Number.isInteger(state.baseLevel)&&state.baseLevel>=0&&state.baseLevel<=MAIN_BASE.maxLevel,"illegal base level "+state.baseLevel);
  if(state.runMode==="normal")invariant((state.clock.phase==="pre-wave")===(state.baseLevel===0),"the pre-wave opening disagrees with the base level");
  else invariant(state.baseLevel===1&&state.clock.phase!=="pre-wave","the showcase fixture base must simply stand");
  const mainBases=buildings.filter(building=>building.type==="mainBase");
  invariant(mainBases.length<=1,"the map holds more than one main base");
  for(const base of mainBases){
    invariant(base.x===BASE.x&&base.y===BASE.y,"the main base left its authored anchor");
    invariant(base.complete===(state.baseLevel>0),"the main base record disagrees with the base level");
  }
  // Deliberately NOT asserted: that a standing base still HAS its construction record. baseLevel is
  // the authority, the record is ordinary construction, and headless harnesses routinely clear
  // `buildings` wholesale between scenarios.
  // The active authored recipe: never negative, never over-paid, and empty at both ends of the list
  // (level 0 charges the construction site instead; the maximum level has no next recipe at all).
  const nextBaseLevel=state.baseLevel===MAIN_BASE.maxLevel?null:MAIN_BASE_LEVELS[state.baseLevel];
  invariant(state.baseLevel===MAIN_BASE.maxLevel||nextBaseLevel,"missing authored base level "+(state.baseLevel+1));
  for(const kind of RESOURCE_KINDS){
    invariant(Number.isFinite(state.baseDelivered[kind])&&state.baseDelivered[kind]>=0,"illegal base delivery "+kind);
    invariant(state.baseDelivered[kind]<=(nextBaseLevel?.cost[kind]||0),"the base banked more "+kind+" than its next authored level costs");
  }
  if(state.baseLevel===0)invariant(RESOURCE_KINDS.every(kind=>state.baseDelivered[kind]===0),"the level-1 recipe is charged on the construction site, never on state.baseDelivered");
  invariant(state.draftPaused===!!rewardDraft.current(),"draft pause flag disagrees with the pending offer");
  // The hand: one stack per id, every id authored, every count real, partial kits mid-spend only.
  invariant(new Set(state.hand.map(entry=>entry.id)).size===state.hand.length,"the hand holds two stacks of one card");
  for(const entry of state.hand){
    invariant(cardById[entry.id],"unknown card in hand: "+entry.id);
    invariant(["consumable","build"].includes(cardById[entry.id].category),"only consumables and builds may be held");
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
  const collections=[trees,rocks,diamonds,grass,resourceDrops,chests,buildings,friendlyBrutes,controlledEnemies,state.workers,state.enemies,damageDummies,showcaseProps,particles,damageNumbers,fallingMeteors,fallingFireballs];
  for(const collection of collections)for(const item of collection)invariant(Number.isFinite(item.x)&&Number.isFinite(item.y),"non-finite entity coordinates");
  // Landed records are spliced in the same update step, so between steps every record is mid-fall.
  for(const m of fallingMeteors)invariant(Number.isFinite(m.t)&&m.t>=0&&m.dur===METEOR.fallTime&&m.t<m.dur,"malformed falling meteor");
  for(const f of fallingFireballs)invariant(Number.isFinite(f.t)&&f.t>=0&&f.dur===FIREBALL.fallTime&&f.t<f.dur,"malformed falling fireball");
  const wave=state.nightWave;
  invariant(Number.isInteger(wave.nightNumber)&&wave.nightNumber>=0,"illegal night number");
  invariant(wave.activeNightNumber===null||(Number.isInteger(wave.activeNightNumber)&&wave.activeNightNumber>0&&wave.activeNightNumber===wave.nightNumber),"illegal active wave identity");
  invariant((state.clock.phase==="night")===(wave.activeNightNumber!==null),"active wave identity disagrees with phase");
  invariant(Number.isInteger(wave.totalSpawns)&&wave.totalSpawns>=0,"illegal wave total");
  invariant(Number.isInteger(wave.remainingSpawns)&&wave.remainingSpawns>=0&&wave.remainingSpawns<=wave.totalSpawns,"illegal remaining wave spawns");
  const validPlan=plan=>plan&&Number.isInteger(plan.threatBudget)&&plan.threatBudget>0&&Object.isFrozen(plan)&&Object.isFrozen(plan.entries)&&plan.entries.length>0&&plan.entries.every(entry=>Object.isFrozen(entry)&&ENEMY_TYPES[entry.type]?.threatCost===entry.threatCost&&entry.at>=0&&entry.at<=NIGHT_WAVE_WINDOW)&&plan.entries.reduce((sum,entry)=>sum+entry.threatCost,0)===plan.threatBudget;
  if(state.runMode==="normal")invariant(validPlan(wave.upcomingPlan),"normal run has no valid upcoming Spawn Plan");
  if(state.clock.phase==="night"){
    invariant(validPlan(wave.activePlan)&&wave.totalSpawns===wave.activePlan.entries.length,"night has no valid active Spawn Plan");
    invariant(Number.isInteger(wave.spawnedThreat)&&wave.spawnedThreat>=0&&wave.spawnedThreat<=wave.threatBudget&&wave.threatBudget===wave.activePlan.threatBudget,"active threat schedule disagrees with its budget");
  }
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
  invariant(fogByCell.size===fog.length,"fog cell index disagrees with the fog collection");
  fog.forEach((cell,i)=>{
    const center=cellToWorld(cell.cx,cell.cy);
    invariant(cell.idx===i,"fog block idx drifted from its live position");
    invariant(cell.x===center.x&&cell.y===center.y,"fog block is not cell aligned");
    invariant(Number.isInteger(cell.hp)&&Number.isInteger(cell.max)&&cell.max>0&&cell.hp>0&&cell.hp<=cell.max,"illegal fog block health");
    invariant(fogByCell.get(fogCellKey(cell.cx,cell.cy))===cell,"fog cell index lost identity");
    invariant(cell.water===(terrainAtWorldPoint(cell.x,cell.y)!==LAND),"fog block water tag disagrees with terrain");
    if(cell.claimedBy!==undefined)invariant(state.workers.includes(cell.claimedBy)||heldWorker()===cell.claimedBy,"fog block claimed by unknown worker");
    if(cell.claimedBy!==undefined)invariant(!cell.water,"a walker claimed a water fog block");
  });
  for(const entry of fogPopQueue)invariant(entry.cell.popQueued===true&&Number.isFinite(entry.at),"malformed fog cascade entry");
  for(const pop of fogPops)invariant(pop.age>=0&&pop.age<FOG.popAnimTime&&!fogByCell.has(fogCellKey(pop.cx,pop.cy)),"fog death record outlived its tween or shadows a standing block");
  if(state.runMode==="showcase")invariant(fog.length===0,"showcase mode contains fog");
  for(const [nodes,kind] of [[trees,"wood"],[rocks,"stone"],[diamonds,"diamond"]])for(const node of nodes){
    const cell=worldToCell(node.x,node.y),center=cellToWorld(cell.cx,cell.cy);
    invariant(node.x===center.x&&node.y===center.y,"resource is not cell aligned");
    invariant(Number.isInteger(node.hp)&&Number.isInteger(node.max)&&node.max>0&&node.hp>=0&&node.hp<=node.max,"illegal "+kind+" node health");
    invariant(footprintInWorldBounds(cell.cx,cell.cy,node.footprint||RESOURCE_FOOTPRINT),"resource footprint is out of bounds");
    invariant(terrainWorldRectEntirelyOnLand(footprintWorldRect(cell.cx,cell.cy,node.footprint||RESOURCE_FOOTPRINT)),"resource is not on land");
    if(node.meteor)invariant(nodes===rocks&&node.max===METEOR.rockHp&&node.footprint===FOOTPRINT_3x3,"malformed meteor rock");
    if(node.fireball)invariant(nodes===rocks&&node.max===FIREBALL.rockHp&&node.footprint===FOOTPRINT_1x1,"malformed fireball rock");
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
  for(const arc of lightningArcs)invariant([arc.x1,arc.y1,arc.x2,arc.y2,arc.age,arc.seed].every(Number.isFinite)&&arc.age>=0,"illegal lightning arc");
  for(const drop of resourceDrops){
    invariant(RESOURCE_KIND_SET.has(drop.kind),"unknown resource drop kind "+drop.kind);
    invariant(drop.target===null||drop.target==="hand"||drop.target==="base","invalid resource drop target "+drop.target);
    if(drop.claimedBy!==undefined)invariant(state.workers.includes(drop.claimedBy),"resource claimed by unknown worker");
  }
  for(const kind of RESOURCE_KINDS){invariant(Number.isFinite(state.carried[kind])&&state.carried[kind]>=0,"illegal carried "+kind);invariant(Number.isFinite(state.stored[kind])&&state.stored[kind]>=0,"illegal stored "+kind);}
  for(const kind of Object.keys(state.carried))invariant(RESOURCE_KIND_SET.has(kind),"unknown carried resource "+kind);
  for(const kind of Object.keys(state.stored))invariant(RESOURCE_KIND_SET.has(kind),"unknown stored resource "+kind);
  for(const worker of state.workers.concat(heldWorker()?[heldWorker()]:[])){
    // Health is bounded by the EFFECTIVE maximum — the garrison pool for an arrived guard, the
    // ordinary pool for everyone else, held workers included — so a stale bonus is a hard error.
    invariant(worker.hp>=0&&worker.hp<=workerMaxHp(worker),"illegal worker health");
    // A scout's task is a fog cell, identity deliberately unasserted — the block it just mined out
    // stays referenced for one frame until its next update re-targets. Everything else must task an
    // object still living in an owned collection.
    if(worker.taskTarget)invariant(worker.job==="clearfog"
      ?Number.isInteger(worker.taskTarget.cx)&&Number.isInteger(worker.taskTarget.cy)
      :resourceDrops.includes(worker.taskTarget)||trees.includes(worker.taskTarget)||rocks.includes(worker.taskTarget)||diamonds.includes(worker.taskTarget),"worker task target left owned collection");
    // The closed job vocabulary and explicit assignment provenance. Staff is manual (drop/drag,
    // sticky) OR an autonomous slot claim by the free-worker scheduler; guard is manual OR an
    // autonomous garrison muster; free is autonomous idle carrying no target and no claims.
    invariant(WORKER_JOBS.has(worker.job),"unknown worker job "+worker.job);
    invariant(typeof worker.autonomous==="boolean","worker assignment provenance is not explicit");
    // A production staffer is always posted to a live camp/quarry; showcase staff are inert
    // display fixtures, exempt by design like showcase guards below.
    if(worker.job==="staff"&&state.runMode==="normal")invariant(buildings.includes(worker.jobTarget)&&!!BUILDING_TYPES[worker.jobTarget.type]?.resource,"a staffer is not posted to a camp or quarry");
    // Every scheduler-posted guard carries the demobilization clock that will eventually stand it
    // down; a manual guard has no clock because it never stands itself down.
    if(worker.job==="guard"&&worker.autonomous)invariant(Number.isFinite(worker.guardSafeTime)&&worker.guardSafeTime>=0,"an autonomous guard has no demobilization timer");
    // A production guard is always a GARRISON guard: no ground drop, house or completion inheritance
    // may mint one without a station. Showcase guards are inert display fixtures, exempt by design.
    if(worker.job==="guard"&&state.runMode==="normal")invariant(isGuardStation(worker.jobTarget),"a guard is not posted to a completed garrison");
    if(worker.job==="free")invariant(worker.autonomous&&worker.jobTarget===null&&worker.taskTarget===null&&worker.selfSupply===null,"free worker retains job state");
    // A hauler is posted to the STANDING base or to a live stockpile — never to a base that has not
    // been built, which would make the pre-wave map centre a storage destination.
    if(worker.job==="haul"&&state.runMode==="normal")
      invariant(worker.jobTarget===BASE?mainBaseStanding():buildings.includes(worker.jobTarget)&&worker.jobTarget.type==="stockpile","a hauler is not posted to the standing base or a stockpile");
    // A production scout is always POSTED: only a completed scout hut mints the job (drop or
    // construction inheritance). Its fog-cell task is checked with the taskTarget rule above.
    if(worker.job==="clearfog"&&state.runMode==="normal")invariant(buildings.includes(worker.jobTarget)&&worker.jobTarget.type==="scoutHut","a scout is not posted to a scout hut");
  }
  // Guard occupancy is DERIVED from the workers pointing at each garrison — held workers included —
  // so a reservation can never drift from a stored counter or oversubscribe the authored capacity.
  for(const building of buildings)if(building.type==="garrison"&&building.complete)invariant(assignedWorkers(building).length<=GARRISON.capacity,"garrison exceeds its guard capacity");
  // Same rule, same derivation, for the base's Worker Limit: counted off the workers naming BASE
  // (held ones included), never off a stored counter, so no reservation path can oversubscribe it.
  if(state.runMode==="normal")invariant(assignedWorkers(BASE).length<=(mainBaseStanding()?MAIN_BASE.jobSlots:0),"the main base exceeds its authored Worker Limit");
  for(const brute of friendlyBrutes)invariant(brute.hp>0&&brute.hp<=brute.max&&brute.max===FRIENDLY_BRUTE.hp,"illegal friendly brute health");
  invariant(new Set(controlledEnemies).size===controlledEnemies.length,"duplicate controlled enemy ownership");
  for(const unit of controlledEnemies){
    const def=ENEMY_TYPES[unit.type];
    invariant(def&&def.weightTag==="light","controlled enemy has an illegal type "+unit.type);
    invariant(unit.hp>0&&unit.hp<=unit.max&&unit.max===def.hp,"illegal controlled enemy health");
    invariant(buildings.includes(unit.sourceYard)&&unit.sourceYard.type==="captureYard"&&unit.sourceYard.complete,"controlled enemy lost its source capture yard");
    invariant(!state.enemies.includes(unit),"controlled enemy still in the hostile collection");
    invariant(unit.waveNightNumber===undefined,"controlled enemy retains wave membership");
    invariant(heldEnemy()!==unit,"controlled enemy is simultaneously held");
  }
  for(const building of buildings)if(building.type==="captureYard"&&building.complete)invariant(captureYardOccupancy(building)<=CAPTURE_YARD.capacity,"capture yard exceeds its living-ally capacity");
  for(const building of buildings){
    if(building.tower)invariant(building.tower.hp>=0&&building.tower.hp<=building.tower.maxHp,"illegal tower health");
    assertTemporaryBuildingState(building);
  }
  // A designated variant belongs only to its unfinished site. completeBuilding() installs that
  // variant directly and clears the designation; no second construction job may survive completion.
  for(const building of buildings)if(building.plannedVariant){
    invariant(building.type==="tower"&&TOWER_VARIANTS[building.plannedVariant],"illegal designated tower variant "+building.plannedVariant);
    invariant(!building.complete,"a designated tower variant outlived its construction");
  }
  if(state.heldObject){const held=state.heldObject,kind=assertHeldKind(held);invariant(Number.isFinite(held.originX)&&Number.isFinite(held.originY),"invalid held origin");if(kind==="worker")invariant(!state.workers.includes(held.object),"held worker still installed");else if(kind==="enemy"){invariant(!state.enemies.includes(held.object),"held enemy still installed");invariant(ENEMY_TYPES[held.object.type]?.weightTag==="light","held enemy is not light");}else if(kind==="building"){invariant(!buildings.includes(held.object),"held building still installed");assertTemporaryBuildingState(held.object);}else if(kind==="chest"){invariant(!chests.includes(held.object),"held chest still installed");invariant(Number.isFinite(held.object.x)&&Number.isFinite(held.object.y),"held chest has non-finite coordinates");invariant(Number.isInteger(held.object.hp)&&held.object.hp>0&&held.object.hp<=held.object.max&&held.object.max===CHEST.maxHp,"held dead chest");invariant(held.object.footprint===CHEST.footprint,"held chest has invalid footprint");}else invariant(showcaseProps.includes(held.object),"held prop lost ownership");}
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
    if(state.runMode==="normal"&&fogAtPoint(enemy.x,enemy.y))continue;   // hidden in fog: not clickable
    const d=distance(x,y,enemy.x,enemy.y),hitRadius=assertCombatKind(enemy)==="damage-dummy"?24:24*ENEMY_TYPES[enemy.type].size;
    if(d<hitRadius&&d<best){best=d;target=enemy;}
  }
  return target;
}
function dropBossChest(x,y){
  let anchor=null,bestDistanceSq=Infinity;
  // Bosses may die over water or occupied ground. The chest remains an ordinary placed chest, so
  // choose the nearest cell satisfying the same terrain and occupancy contract as player placement.
  for(let cy=0;cy<GRID_ROWS;cy++)for(let cx=0;cx<GRID_COLS;cx++){
    const point=cellToWorld(cx,cy),dx=point.x-x,dy=point.y-y,distanceSq=dx*dx+dy*dy;
    if(distanceSq>=bestDistanceSq||!canPlace(point.x,point.y)||!footprintFogFree(point.x,point.y,CHEST.footprint))continue;
    anchor=point;bestDistanceSq=distanceSq;
  }
  invariant(anchor,"boss death found no free cell for its chest");
  const chest={x:anchor.x,y:anchor.y,hp:CHEST.maxHp,max:CHEST.maxHp,shake:0,footprint:CHEST.footprint};
  chests.push(chest);
  return chest;
}
function spawnDeathTreeNear(x,y){
  let anchor=null,bestDistanceSq=Infinity;
  for(let cy=0;cy<GRID_ROWS;cy++)for(let cx=0;cx<GRID_COLS;cx++){
    const point=cellToWorld(cx,cy),dx=point.x-x,dy=point.y-y,distanceSq=dx*dx+dy*dy;
    if(distanceSq>=bestDistanceSq||!canPlace(point.x,point.y)||!footprintFogFree(point.x,point.y,RESOURCE_FOOTPRINT))continue;
    anchor=point;bestDistanceSq=distanceSq;
  }
  if(!anchor)return false; // A saturated map cannot represent another physical tree.
  const hp=RESOURCE_NODE_HP.wood;
  trees.push({x:anchor.x,y:anchor.y,hp,max:hp,stump:0,shake:0,variant:(Math.random()*3)|0,footprint:RESOURCE_FOOTPRINT});
  clearGrassInFootprint(anchor.x,anchor.y,RESOURCE_FOOTPRINT);
  burst(anchor.x,anchor.y,"#6f965c",10);
  return true;
}
function resolveEnemyDeathBuffs(enemy){
  if(buffStacks("deathTree")>0&&Math.random()<CARD_BUFFS.deathTreeChance)spawnDeathTreeNear(enemy.x,enemy.y);
  if(buffStacks("deathExplosion")<=0)return;
  burst(enemy.x,enemy.y,"#d96a3f",20);sound(80,.18);
  // The dead enemy has already left ownership. Explosion kills recurse through this same finite
  // death pipeline; the shared dispatcher snapshots and safely visits the shrinking enemy roster.
  applyAreaDamage({centers:[enemy],radius:CARD_BUFFS.deathExplosionRadius,damage:CARD_BUFFS.deathExplosionDamage,targetType:CARD_BUFFS.deathExplosionTargetType,color:"#d96a3f"});
}
function killEnemy(enemy,announce=true){
  const at=state.enemies.indexOf(enemy);if(at<0)return;
  // Death owns status teardown so every damage path releases tower/source references immediately.
  enemy.status={burn:null,slow:null};enemy.retaliationTower=null;state.enemies.splice(at,1);
  const droppedChest=!!ENEMY_TYPES[enemy.type].boss;
  if(droppedChest)dropBossChest(enemy.x,enemy.y);
  resolveEnemyDeathBuffs(enemy);
  const droppedDust=Math.random()<.25;
  if(droppedDust)spawnResource("dust",enemy.x+rand(-7,7),enemy.y);
  burst(enemy.x,enemy.y,"#4b3b50",12);
  // JUICE — death reads at the body's scale. The 12-piece burst above is the LIGHT-enemy baseline
  // and stays exactly as authored (a raider dies as it always did); everything below is additive
  // and keyed to the authored `size`, so a brute throws real debris and the 5.4x boss comes apart
  // with a floor-shaking boom. `heft` is clamped so no future giant can flood the particle pool.
  // Reads a frozen data.js constant to pick counts — no simulation state is written.
  const heft=clamp(ENEMY_TYPES[enemy.type].size,1,4);
  if(heft>1){
    fxDebris(enemy.x,enemy.y,"#4b3b50",Math.round(12*(heft-1)),{spread:58*heft,lift:105*heft,jitter:5*heft,size:.85*heft});
    fxDustRing(enemy.x,enemy.y,"#6a5570",Math.round(4*heft),{radius:12*heft,speed:64*heft,size:heft});
    if(heft>2){addScreenShake(clamp(.13*heft,0,.6));sound(150/heft,.34);}
  }
  if(announce||droppedDust||droppedChest)toast(droppedChest?(droppedDust?"boss defeated — chest and dust dropped":"boss defeated — chest dropped"):(droppedDust?"enemy defeated — dust dropped":"enemy defeated"));
  sound(150,.12);
}
const MAX_PLAYER_HIT_EFFECT_DEPTH=12;
function combatTargetActive(target){const kind=assertCombatKind(target);return kind==="damage-dummy"?damageDummies.includes(target)&&target.defeatedTimer<=0:state.enemies.includes(target)&&target.hp>0;}
function playerHitActive(hit){return hit.kind==="combat"?combatTargetActive(hit.target):resourceIsActive(hit.target,hit.resourceKind);}
/** One extensible player-click pipeline for combat and resources. Context makes recursion policy
 * explicit: chain jumps cannot chain directly, free hits can, and no generated hit can generate
 * another Free Hit. The depth ceiling guarantees future effect combinations remain bounded. */
function executePlayerHit(hit,context={}){
  const ctx={depth:0,source:"direct",allowChain:true,allowFreeHit:true,quiet:false,...context};
  if(!playerHitActive(hit))return false;
  const critical=critHit();
  if(hit.kind==="combat"){
    const kind=assertCombatKind(hit.target),damage=clickDamage()*(critical?CARD_BUFFS.critMultiplier:1);
    if(kind==="damage-dummy")damageDummy(hit.target,damage,"#d25b49",5,{critical});
    else damageEnemy(hit.target,damage,"#d25b49",5,null,{announce:true,critical});
  }else{
    const damage=clickDamage()*(critical?CARD_BUFFS.critMultiplier:1);
    const drops=TUNE.chopYield+(critical?CARD_BUFFS.critYield*buffStacks("critYield"):0);
    damageResourceTarget(hit.target,hit.resourceKind,{damage,drops,critical});
  }
  if(!ctx.quiet){const frequency=hit.kind==="combat"?(critical?820:610):hit.resourceKind==="wood"?350+hit.target.hp*25:hit.resourceKind==="diamond"?760:170+hit.target.hp*15;sound(frequency,.045);}
  if(ctx.depth<MAX_PLAYER_HIT_EFFECT_DEPTH&&ctx.allowChain)resolvePlayerHitChain(hit,ctx);
  const stacks=buffStacks("freeHit");
  if(ctx.depth<MAX_PLAYER_HIT_EFFECT_DEPTH&&ctx.allowFreeHit&&playerHitActive(hit)&&stacks>0&&Math.random()<Math.min(1,CARD_BUFFS.freeHitChance*stacks))
    executePlayerHit(hit,{depth:ctx.depth+1,source:"free",allowChain:true,allowFreeHit:false,quiet:true});
  return true;
}
function hitCombatTarget(target,quiet=false){return executePlayerHit({kind:"combat",target},{quiet});}

// ── chain lightning ─────────────────────────────────────────────────────────
// The chainLightning buff turns a completed player swing into up to N more swings, each landing on
// the nearest unstruck target within reach of the previous strike. Every jump re-enters
// executePlayerHit() with explicit effect permissions and its own crit/free-hit rolls.
function chainCombatRoster(){return state.runMode==="showcase"?damageDummies.filter(dummy=>dummy.defeatedTimer<=0):state.enemies;}
/** Jump order resolved BEFORE any damage lands, so a kill mid-chain cannot re-aim later jumps. */
function chainLightningTargets(fromX,fromY,jumps,range,visited,combatOnly=false){
  const targets=[];
  let x=fromX,y=fromY;
  for(let i=0;i<jumps;i++){
    let next=null,best=range;
    for(const enemy of chainCombatRoster()){if(state.runMode==="normal"&&fogAtPoint(enemy.x,enemy.y))continue;const d=distance(x,y,enemy.x,enemy.y);if(!visited.has(enemy)&&enemy.hp>0&&d<best){best=d;next={target:enemy,combat:true,resource:null};}}
    if(!combatOnly)for(const [nodes,kind] of [[trees,"wood"],[rocks,"stone"],[diamonds,"diamond"]])for(const node of nodes){const d=distance(x,y,node.x,node.y);if(!visited.has(node)&&resourceIsActive(node,kind)&&d<best){best=d;next={target:node,combat:false,resource:kind};}}
    if(!next)break;
    visited.add(next.target);targets.push(next);x=next.target.x;y=next.target.y;
  }
  return targets;
}
function addLightningArc(x1,y1,x2,y2){lightningArcs.push({x1,y1,x2,y2,age:0,seed:Math.random()});}
function resolvePlayerHitChain(hit,context){
  const jumps=chainLightningJumps(),origin=hit.target;
  if(jumps<=0||Math.random()>=chainLightningChance())return;
  const targets=chainLightningTargets(origin.x,origin.y,jumps,CARD_BUFFS.chainRange,new Set([origin]));
  if(!targets.length)return;
  let fromX=origin.x,fromY=origin.y;
  for(const jump of targets){
    addLightningArc(fromX,fromY,jump.target.x,jump.target.y);fromX=jump.target.x;fromY=jump.target.y;
    executePlayerHit(jump.combat?{kind:"combat",target:jump.target}:{kind:"resource",target:jump.target,resourceKind:jump.resource},
      {depth:context.depth+1,source:"chain",allowChain:false,allowFreeHit:true,quiet:true});
  }
  sound(940,.1);
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
    // Lifting a guard off its post ends the fortification IMMEDIATELY — the kit belongs to a worker
    // standing at the station, not to the orders it carries — while job/jobTarget (and therefore the
    // derived slot reservation) survive in hand until the drop reassigns or returns it.
    setWorkerStationArrival(worker,null);
    state.heldObject={kind:"worker",object:worker,originX:worker.x,originY:worker.y};state.collecting=false;toast("worker lifted — release to assign");return true;
  }
  if(buffStacks("enemyPickup")>0){
    let enemy=null,bestEnemy=32;
    for(const candidate of state.enemies){const def=ENEMY_TYPES[candidate.type],d=distance(x,y,candidate.x,candidate.y);if(def.weightTag==="light"&&d<bestEnemy){enemy=candidate;bestEnemy=d;}}
    if(enemy){state.enemies.splice(state.enemies.indexOf(enemy),1);state.heldObject={kind:"enemy",object:enemy,originX:enemy.x,originY:enemy.y};state.collecting=false;toast(ENEMY_TYPES[enemy.type].name+" lifted — release right to place");return true;}
  }
  const building=buildings.find(item=>item.complete&&((item.type==="tower"&&towerVariant(item).movable)||BUILDING_TYPES[item.type].movable)&&manualTowerButtonHit(item,x,y));
  if(building){const name=building.type==="tower"?towerVariant(building).name:BUILDING_TYPES[building.type].name;state.heldObject={kind:"building",object:building,originX:building.x,originY:building.y};buildings.splice(buildings.indexOf(building),1);state.collecting=false;toast(name+" picked up — release right to place");return true;}
  // Explicit secondary-action priority: workers (preserved interaction), light enemies with the
  // buff, movable deployables, unopened chests, showcase props, then loose-resource vacuuming.
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
function heldEnemy(){return state.heldObject?.kind==="enemy"?state.heldObject.object:null;}
function heldBuilding(){return state.heldObject?.kind==="building"?state.heldObject.object:null;}
function heldChest(){return state.heldObject?.kind==="chest"?state.heldObject.object:null;}
function heldProp(){return state.heldObject?.kind==="showcase-prop"?state.heldObject.object:null;}
// The garrison's guard post: one stable point just below the 1x1 station, in simulation
// coordinates, shared by every guard it holds. Occupancy is DERIVED from the workers pointing at
// this exact building (assignedWorkers below), so no slot counter is ever stored on the garrison.
const GARRISON_POST_OFFSET=18;
function garrisonPost(building){return {x:building.x,y:building.y+GARRISON_POST_OFFSET};}
/** Is this the completed garrison a guard may legally be posted to? */
function isGuardStation(building){return !!building&&buildings.includes(building)&&building.type==="garrison"&&building.complete;}
// ── the garrison's fortified kit ────────────────────────────────────────────
// THE predicate. A worker is a fortified guard only while all three hold at once: it holds guard
// orders, those orders name a live completed garrison, and it has physically ARRIVED there through
// the shared staffing gate. A reservation, a walk that is still in progress, or a razed station all
// read false, so the kit can never outlive the post it belongs to.
function isActiveGarrisonGuard(worker){
  return !!worker&&worker.job==="guard"&&isGuardStation(worker.jobTarget)&&worker.staffingArrivedAt===worker.jobTarget;
}
/** THE effective maximum health of a worker: the garrison's pool for an active guard, else the
 * ordinary worker pool. Every health bar, invariant and heal reads this, never WORKER_HP. */
function workerMaxHp(worker){return isActiveGarrisonGuard(worker)?GARRISON.maxHp:WORKER_HP;}
/** THE effective melee damage of a worker, on the same predicate. */
function workerDamage(worker){return (isActiveGarrisonGuard(worker)?GARRISON.damage:WORKER_DAMAGE)+CARD_BUFFS.workerCombatDamage*buffStacks("workerCombatDamage");}
// The ONE writer of the garrison health bonus. Taking the post grants only the MAX-HP DELTA — a
// 3/5 worker becomes 8/10, never 10/10 — and losing it CLAMPS the pool back under the ordinary
// maximum rather than subtracting a fixed amount, so a wounded guard is never healed or killed by
// a status change. The stored flag makes each edge fire exactly once however often it is re-read.
function syncWorkerGarrisonBonus(worker){
  const active=isActiveGarrisonGuard(worker);
  if(active===!!worker.garrisonBonus)return;
  if(active)worker.hp+=GARRISON.maxHp-WORKER_HP;
  else worker.hp=Math.min(worker.hp,WORKER_HP);
  worker.garrisonBonus=active;
}
/** Every write of the station-arrival gate goes through here, so the kit can never lag the post. */
function setWorkerStationArrival(worker,station){worker.staffingArrivedAt=station;syncWorkerGarrisonBonus(worker);}
// Where a base hauler stands: south of the anchor, clear of the 3x3 footprint. One definition, so
// the manual drop, construction inheritance and the free-worker scheduler cannot post to different
// spots at the same station.
const BASE_HAUL_POST={x:BASE.x,y:BASE.y+25};
// Canonical completed-building assignment. Construction inheritance, placement, and vacancy filling share it.
function builtJobAssignment(building){
  // The completed main base is a durable HAUL post exactly like a stockpile — its jobSlots are
  // MAIN_BASE.jobSlots — but its runtime identity is the BASE anchor, never the construction record
  // that raised it. Both spellings resolve here so inheritance, drops and the scheduler share one
  // two-slot pool at the map centre instead of two pools at the same coordinates.
  if(building===BASE||building.type==="mainBase")return {job:"haul",jobTarget:BASE,postX:BASE_HAUL_POST.x,postY:BASE_HAUL_POST.y};
  if(building.type==="lumber"||building.type==="quarry")return {job:"staff",jobTarget:building,postX:building.x,postY:building.y+16};
  if(building.type==="stockpile")return {job:"haul",jobTarget:building,postX:building.x,postY:building.y+18};
  // A garrison is a durable post like any other station — its jobSlots ARE the guard slots, so it
  // shares the occupancy, reservation and arrival machinery instead of inventing a parallel one.
  if(building.type==="garrison"){const post=garrisonPost(building);return {job:"guard",jobTarget:building,postX:post.x,postY:post.y};}
  // The scout hut is a durable post exactly like a camp: its jobSlots ARE the scout posts, so it
  // shares occupancy/reservation/arrival. A posted worker mines fog frontier blocks (updateFogMiner)
  // the way a camp staffer works wild nodes — jobTarget is the HUT, taskTarget the claimed block.
  if(building.type==="scoutHut")return {job:"clearfog",jobTarget:building,postX:building.x,postY:building.y+18};
  // Post-less buildings (house, tower, obelisk, deployables) hold nobody: a worker that lands on one
  // is repositioned free, never converted into a guard standing watch over nothing.
  return {job:"free",jobTarget:null,postX:building.x,postY:building.y+(building.type==="house"?23:18)};
}
function workerStaffsPost(worker,building){const assignment=builtJobAssignment(building);return worker.job===assignment.job&&worker.jobTarget===building;}
function resourceNodeKind(node){return trees.includes(node)?"wood":rocks.includes(node)?"stone":diamonds.includes(node)?"diamond":null;}
function assignedWorkers(target,excludeWorker=null){
  const candidates=state.workers.concat(heldWorker()&&!state.workers.includes(heldWorker())?[heldWorker()]:[]).filter(worker=>worker!==excludeWorker);
  // The base's haulers name the BASE anchor, manual and autonomous alike, and a HELD hauler is
  // still one of them (candidates above) — lifting a worker off the base keeps its slot reserved.
  if(target===BASE)return candidates.filter(worker=>worker.job==="haul"&&worker.jobTarget===BASE);
  if(buildings.includes(target))return candidates.filter(worker=>target.complete?workerStaffsPost(worker,target):worker.job==="build"&&worker.jobTarget===target);
  return candidates.filter(worker=>(worker.job==="harvest"&&worker.jobTarget?.node===target)||worker.selfSupply?.node===target);
}
/** Read-only assignment/reservation status for an active node or completed durable building. */
function workerOccupancyStatus(target,excludeWorker=null){
  if(state.runMode!=="normal")return null;
  // The base is a durable post only once it STANDS: the bare anchor and its unfinished site employ
  // nobody, so an unbuilt centre has no slots to reserve, fill or draw.
  if(target===BASE)return mainBaseStanding()?{target:BASE,assigned:assignedWorkers(BASE,excludeWorker).length,capacity:MAIN_BASE.jobSlots}:null;
  const kind=resourceNodeKind(target);
  if(kind){if(!resourceIsActive(target,kind))return null;return {target,assigned:assignedWorkers(target,excludeWorker).length,capacity:RESOURCE_NODE_JOB_SLOTS};}
  if(!buildings.includes(target))return null;
  const def=BUILDING_TYPES[target.type];
  const capacity=target.complete?(def.jobSlots||0):def.buildSlots+CARD_BUFFS.buildCapacity*buffStacks("buildCapacity");if(!capacity)return null;
  return {target,assigned:assignedWorkers(target,excludeWorker).length,capacity};
}
function workerOccupancyAt(x,y){
  let nearest=null,best=Infinity;
  for(const nodes of [trees,rocks,diamonds])for(const node of nodes){const status=workerOccupancyStatus(node),d=distance(x,y,node.x,node.y);if(status&&d<38&&d<best){nearest=status;best=d;}}
  for(const building of buildings){const status=workerOccupancyStatus(building),d=distance(x,y,building.x,building.y);if(status&&d<42&&d<best){nearest=status;best=d;}}
  // The standing base answers on the same reach its drop rule uses (workerAssignmentAt), so the
  // hovered slot tray and the drop that fills it agree on where "the base" ends.
  {const status=workerOccupancyStatus(BASE),d=distance(x,y,BASE.x,BASE.y);if(status&&d<BASE.r+18&&d<best){nearest=status;best=d;}}
  return nearest;
}
function installHeldAtOrigin(held){
  const object=held.object;object.x=held.originX;object.y=held.originY;
  const kind=assertHeldKind(held);
  if(kind==="worker")state.workers.push(object);
  else if(kind==="enemy")state.enemies.push(object);
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
  const blueprint=near(item=>!item.complete),node=workerNodeAt(x,y),staff=near(item=>item.complete&&(item.type==="lumber"||item.type==="quarry")),stockpile=near(item=>item.complete&&item.type==="stockpile"),garrison=near(item=>item.complete&&item.type==="garrison"),scoutHut=near(item=>item.complete&&item.type==="scoutHut"),house=near(item=>item.complete&&item.type==="house");
  if(blueprint){const status=workerOccupancyStatus(blueprint,worker);if(status.assigned>=status.capacity)return null;return {job:"build",target:blueprint,postX:blueprint.x,postY:blueprint.y+20,zoneX:blueprint.x,zoneY:blueprint.y,zoneRadius:WORKER_LEASH};}
  if(node){const status=workerOccupancyStatus(node.node,worker);if(status.assigned>=status.capacity)return null;return {job:"harvest",target:node,postX:x,postY:y,zoneX:x,zoneY:y,zoneRadius:WORKER_LEASH};}
  if(staff){const status=workerOccupancyStatus(staff,worker);if(status.assigned>=status.capacity)return null;return {job:"staff",target:staff,postX:staff.x,postY:staff.y+16,zoneX:staff.x,zoneY:staff.y,zoneRadius:BUILDING_TYPES[staff.type].serviceRadius};}
  // The scout hut is a station: a full one REJECTS the drop like a full camp. The posted worker
  // becomes a scout — a durable fog miner with no working radius, so the zone ring only marks the post.
  if(scoutHut){const status=workerOccupancyStatus(scoutHut,worker);if(status.assigned>=status.capacity)return null;return {job:"clearfog",target:scoutHut,postX:scoutHut.x,postY:scoutHut.y+18,zoneX:scoutHut.x,zoneY:scoutHut.y,zoneRadius:WORKER_LEASH};}
  if(stockpile){const status=workerOccupancyStatus(stockpile,worker);if(status.assigned>=status.capacity)return null;return {job:"haul",target:stockpile,postX:stockpile.x,postY:stockpile.y+18,zoneX:stockpile.x,zoneY:stockpile.y,zoneRadius:storageServiceRadius(stockpile)};}
  // The garrison is a station: a full one REJECTS the drop outright (like a full camp or stockpile)
  // rather than quietly leaking the worker onto the ground beside it.
  if(garrison){const status=workerOccupancyStatus(garrison,worker);if(status.assigned>=status.capacity)return null;const post=garrisonPost(garrison);return {job:"guard",target:garrison,postX:post.x,postY:post.y,zoneX:garrison.x,zoneY:garrison.y,zoneRadius:WORKER_LEASH};}
  // A house holds no post, and open ground is not a post either: both simply MOVE the worker and
  // leave it free for the scheduler. Guard duty comes from a garrison or from nothing.
  if(house)return {job:"free",target:null,postX:house.x,postY:house.y+23,zoneX:house.x,zoneY:house.y+23,zoneRadius:WORKER_LEASH};
  // Only a STANDING base is a haul post; the bare anchor (or its unfinished site) offers no storage.
  // A FULL base rejects the drop like a full camp, stockpile or garrison — the held worker returns
  // to its pickup origin with its prior assignment intact rather than leaking onto the ground.
  if(mainBaseStanding()&&distance(x,y,BASE.x,BASE.y)<BASE.r+18){
    const status=workerOccupancyStatus(BASE,worker);if(status.assigned>=status.capacity)return null;
    return {job:"haul",target:BASE,postX:BASE_HAUL_POST.x,postY:BASE_HAUL_POST.y,zoneX:BASE.x,zoneY:BASE.y,zoneRadius:BASE_ZONE};
  }
  return {job:"free",target:null,postX:x,postY:y,zoneX:x,zoneY:y,zoneRadius:WORKER_LEASH};
}
function assignWorker(worker,x,y){
  const assignment=workerAssignmentAt(worker,x,y);if(!assignment)return null;
  const scatterIdleLoad=worker.job==="guard"||worker.job==="free";
  clearWorkerSelfSupply(worker);worker.x=x;worker.y=y;worker.retaliationTarget=null;worker.returnAfterCombat=false;worker.fleeing=false;worker.fleeSafeTime=0;
  // A free placement is a REPOSITION, not a job: releaseWorkerToFree is the one transition that
  // drops every claim, the staffing arrival, the stale station reference and the carried load, so
  // the worker lands schedulable with nothing reserved behind it.
  if(assignment.job==="free"){releaseWorkerToFree(worker);return worker.job;}
  // Every drop-assigned job is a MANUAL assignment; the scheduler is the only writer of autonomous=true.
  worker.postX=assignment.postX;worker.postY=assignment.postY;worker.job=assignment.job;worker.jobTarget=assignment.target;worker.autonomous=false;worker.returning=false;worker.starved=false;worker.guardSafeTime=0;
  // A new posting is never an arrival: the worker must walk to it before the kit is granted again.
  setWorkerStationArrival(worker,null);
  if(scatterIdleLoad||worker.job!=="haul")for(const kind of RESOURCE_KINDS){while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,x+rand(-8,8),y+rand(-5,5));}}
  return worker.job;
}
function dropHeldObject(){
  const held=state.heldObject;if(!held)return false;
  if(held.kind==="enemy"){
    const enemy=held.object;
    // A yard under the cursor claims the drop entirely: it either converts the enemy or restores
    // its exact pickup origin — a hostile is never RELOCATED onto a yard it cannot enter.
    const yard=state.mouse.inside?captureYardAtPoint(state.mouse.x,state.mouse.y):null;
    if(yard){
      if(!yard.complete){enemy.x=held.originX;enemy.y=held.originY;state.enemies.push(enemy);toast("capture yard unfinished — enemy returned");}
      else if(captureYardOccupancy(yard)>=CAPTURE_YARD.capacity){enemy.x=held.originX;enemy.y=held.originY;state.enemies.push(enemy);toast("capture yard is full — enemy returned");}
      else captureEnemy(enemy,yard);
      state.heldObject=null;sound(180,.08);return true;
    }
    if(state.mouse.inside&&terrainAtWorldPoint(state.mouse.x,state.mouse.y)===LAND){enemy.x=clamp(state.mouse.x,BUILD_MARGIN,W-BUILD_MARGIN);enemy.y=clamp(state.mouse.y,BUILD_MARGIN,H-BUILD_MARGIN);toast(ENEMY_TYPES[enemy.type].name+" dropped");}
    else{enemy.x=held.originX;enemy.y=held.originY;toast("invalid ground — enemy returned");}
    state.enemies.push(enemy);state.heldObject=null;sound(180,.08);return true;
  }
  if(held.kind==="worker"){
    const worker=held.object,result=state.mouse.inside&&assignWorker(worker,state.mouse.x,state.mouse.y);
    if(result){setWorkerStationArrival(worker,null);state.workers.push(worker);const assignment=worker.job==="haul"?"haul to "+(worker.jobTarget===BASE?"base":"stockpile"):worker.job==="guard"?"garrison guard":worker.job==="clearfog"?"fog scout":result;toast(result==="free"?"worker moved — free":"worker assigned: "+assignment);}
    else{worker.x=held.originX;worker.y=held.originY;state.workers.push(worker);toast("invalid ground — worker returned");}
    state.heldObject=null;sound(260,.06);return true;
  }
  if(held.kind==="showcase-prop"){
    const prop=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
    if(anchor&&canPlace(anchor.x,anchor.y,null,null,prop)&&footprintFogFree(anchor.x,anchor.y,prop.footprint)){prop.x=anchor.x;prop.y=anchor.y;toast(prop.id+" placed");}
    else{prop.x=held.originX;prop.y=held.originY;toast("invalid ground — "+prop.id+" returned");}
    invariant(showcaseProps.includes(prop),"placed prop left its owned collection");state.heldObject=null;sound(260,.06);return true;
  }
  if(held.kind==="chest"){
    const chest=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
    if(anchor&&canPlace(anchor.x,anchor.y,null,null,null,chest)&&footprintFogFree(anchor.x,anchor.y,chest.footprint)){chest.x=anchor.x;chest.y=anchor.y;toast("unopened chest placed");}
    else{chest.x=held.originX;chest.y=held.originY;toast("invalid ground — chest returned");}
    chests.push(chest);state.heldObject=null;sound(260,.06);return true;
  }
  // Relocation validates the tower's own 3x3 footprint at the snapped anchor, excluding itself.
  // Only x/y are ever touched: cooldown, hp, variant and upgrade state ride along on the same object,
  // and an invalid drop restores the exact origin recorded at pickup.
  invariant(assertHeldKind(held)==="building","unhandled held drop kind "+held.kind);
  const building=held.object,anchor=state.mouse.inside?snapToCellCenter(state.mouse.x,state.mouse.y):null;
  if(anchor&&canPlace(anchor.x,anchor.y,building.type,building)&&footprintFogFree(anchor.x,anchor.y,buildingFootprint(building.type))){building.x=anchor.x;building.y=anchor.y;clearGrassInFootprint(building.x,building.y,buildingFootprint(building.type));toast((building.type==="tower"?towerVariant(building).name:BUILDING_TYPES[building.type].name)+" placed");}
  else{building.x=held.originX;building.y=held.originY;toast("invalid ground — "+(building.type==="tower"?"tower":BUILDING_TYPES[building.type].name)+" returned");}
  // JUICE — a relocated structure sets down with the same dust/thud vocabulary a fresh site uses.
  // Runs for the restored-origin case too: the thing landed there either way.
  fxGroundThump(building.x,building.y,buildingFootprint(building.type),"#8a7358");
  buildings.push(building);state.heldObject=null;sound(260,.06);sound(104,.13);return true;
}
function activateManualTower(building){
  const tower=building.tower,variant=towerVariant(building);if(!variant.manual)return;
  if(tower.cooldown>0){toast(variant.name+" recharging: "+tower.cooldown.toFixed(1)+"s");return;}
  const radius=towerAttackRadius(building,variant);
  if(state.runMode==="showcase"&&!damageDummies.some(dummy=>dummy.defeatedTimer<=0&&distance(building.x,building.y,dummy.x,dummy.y)<=radius))return;
  tower.cooldown=towerCooldown(building,variant);tower.flash=.35;
  const damage=towerDamage(building,variant);
  applyAreaDamage({centers:[building],radius,damage,targetType:variant.damageTargetType,color:variant.accent,source:building});
  burst(building.x,building.y,variant.accent,24);toast("shock pulse fired");sound(variant.sound,.28);
}
function detonateBlast(building){
  const def=BUILDING_TYPES.blast,center=[building];
  applyAreaDamage({centers:center,radius:def.effectRadius,damage:def.damage,targetType:def.damageTargetType,color:"#e39a3f"});
  applyAreaDamage({centers:center,radius:def.effectRadius*.5,damage:def.innerDamage-def.damage,targetType:def.damageTargetType,color:"#e39a3f"});
  for(let i=0;i<42;i++)particles.push({x:building.x,y:building.y,vx:rand(-180,180),vy:rand(-190,40),life:rand(.35,.9),col:i%2?"#e39a3f":"#b84b38"});
  buildings.splice(buildings.indexOf(building),1);toast("blast charge detonated");sound(70,.3);
}
function createBuilding(type,x,y){
  const def=BUILDING_TYPES[type],cost=type==="house"?nextHouseCost():{...def.cost};
  // plannedVariant identifies the finished tower this one construction site will produce. Null on
  // ordinary builds and basic towers.
  const building={type,x,y,cost,delivered:resourceCounts(),storage:resourceCounts(),upgrades:{},activeUpgrade:null,plannedVariant:null,tower:null,hazard:["spikes","landmine","tar"].includes(type)?{cooldown:0,flash:0}:null,complete:!!def.instant,pulse:1};
  if(type==="damageOrbs")building.orbs={count:Math.floor(rand(DAMAGE_ORBS.minCount,DAMAGE_ORBS.maxCount+1)),angle:0,cooldown:0,remaining:DAMAGE_ORBS.duration};
  if(type==="summoningCircle")building.summoning={dust:0,remaining:SUMMONING_CIRCLE.duration};
  if(type==="consumableForge")building.consumableForge={dust:0};
  return building;
}

function chestAt(x,y){
  let target=null,best=32;
  for(const chest of chests){const d=distance(x,y,chest.x,chest.y);if(chest.hp>0&&!fogAtPoint(chest.x,chest.y)&&d<best){target=chest;best=d;}}
  return target;
}
function grassAt(x,y){
  const center=worldToCell(x,y);let target=null,best=24;
  for(let cy=center.cy-1;cy<=center.cy+1;cy++)for(let cx=center.cx-1;cx<=center.cx+1;cx++){
    const tuft=grassByCell.get(cy*GRID_COLS+cx);if(!tuft||fogAtPoint(tuft.x,tuft.y))continue;const d=distance(x,y,tuft.x,tuft.y);if(d<best){target=tuft;best=d;}
  }
  return target;
}
function playerResourceAt(x,y){
  let target=null,kind=null,best=34;
  for(const tree of trees){if(!resourceIsActive(tree,"wood"))continue;const d=distance(x,y,tree.x,tree.y-10);if(d<best){best=d;target=tree;kind="wood";}}
  for(const rock of rocks){if(!resourceIsActive(rock,"stone"))continue;const d=distance(x,y,rock.x,rock.y);if(d<best){best=d;target=rock;kind="stone";}}
  for(const diamond of diamonds){if(!resourceIsActive(diamond,"diamond"))continue;const d=distance(x,y,diamond.x,diamond.y);if(d<best){best=d;target=diamond;kind="diamond";}}
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
  enemy:  {kind:"attack", icon:"sword"},
  fog:    {kind:"mine-fog",icon:"pickaxe"}
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
  // A fog block owns its whole cell: while one stands, nothing beneath or beside it resolves.
  const fogCell=fogAtPoint(x,y);
  if(fogCell)return {target:fogCell,kind:PRIMARY_ACTIONS.fog.kind,resource:null,icon:PRIMARY_ACTIONS.fog.icon};
  const chest=chestAt(x,y);
  if(chest)return {target:chest,kind:PRIMARY_ACTIONS.chest.kind,resource:null,icon:PRIMARY_ACTIONS.chest.icon};
  const node=playerResourceAt(x,y);   // already skips stumps and depleted nodes
  if(node){const action=PRIMARY_ACTIONS[node.kind];return {target:node.target,kind:action.kind,resource:node.kind,icon:action.icon};}
  const tuft=grassAt(x,y);
  if(tuft)return {target:tuft,kind:PRIMARY_ACTIONS.grass.kind,resource:null,icon:PRIMARY_ACTIONS.grass.icon};
  return null;
}

// ── click snapping ──────────────────────────────────────────────────────────
// A swing in progress is committed: while the primary button stays down, the armed target keeps
// taking the fill even after the cursor slips off it, so a chase stays locked to the running enemy
// and fog keeps chipping while the hand drifts. The lock breaks only when the target dies,
// depletes, hides in fog, drifts past TUNE.snapRadius of the cursor, or the button comes up;
// only then does the cursor re-resolve. A press always resolves fresh (leftClick), so the badge
// preview and the armed target still agree — the lock never survives a release.
function primaryActionAlive(action){
  const target=action.target;
  if(action.kind==="attack")return target.hp>0&&(assertCombatKind(target)==="damage-dummy"?damageDummies.includes(target):state.enemies.includes(target)&&!(state.runMode==="normal"&&fogAtPoint(target.x,target.y)));
  if(action.kind==="mine-fog")return fogByCell.get(fogCellKey(target.cx,target.cy))===target;
  if(action.kind==="break-chest")return chests.includes(target)&&target.hp>0;
  if(action.kind==="cut-grass")return grass.includes(target);
  return resourceIsActive(target,action.resource);
}
function stickyChopAction(){
  const action=chopState.action;
  if(!action||!state.primaryClick.held)return null;
  if(distance(state.mouse.x,state.mouse.y,action.target.x,action.target.y)>TUNE.snapRadius)return null;
  return primaryActionAlive(action)?action:null;
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
  // Nodes and enemies share one hold-to-fill timer. The armed target is sticky while the button
  // stays down (stickyChopAction); only when that lock is gone does the cursor re-resolve through
  // the one authority, so a dead, depleted, or out-of-leash target drops or restarts the fill here.
  const hit=stickyChopAction()||resolvePrimaryAction(m.x,m.y);
  if(!hit){resetChop();return;}
  beginChop(hit);
  chopState.t+=dt*chopFillRate();
  if(chopState.t<TUNE.chopTime)return;
  chopState.t=0;
  const quiet=primary.audioCooldown>0;
  if(hit.kind==="attack")hitCombatTarget(hit.target,quiet);
  else if(hit.kind==="break-chest")hitChest(hit.target,quiet);
  else if(hit.kind==="cut-grass")hitGrass(hit.target,quiet);
  else if(hit.kind==="mine-fog")hitFog(hit.target,quiet);
  else hitResource(hit.target,hit.resource,false,quiet);
  if(!quiet)primary.audioCooldown=.25;
}
function leftClick(){
  if(state.gameOver||state.paused||state.heldObject)return;
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
  const pile=buildings.find(building=>building.complete&&building.type==="stockpile"&&distance(m.x,m.y,building.x,building.y)<38);
  if(pile){unloadStockpile(pile,m.x);return;}
  if(!action){toast("left click a chest, resource, or enemy");return;}
  // Harvesting/chest breaking no longer resolves on the press; updatePrimaryClick() fills the timer.
  beginChop(action);
}

function destroyChest(chest){
  const at=chests.indexOf(chest);if(at<0)return false;
  chests.splice(at,1);if(chopState.target===chest)resetChop();
  if(chest.showcaseKey){
    const labelAt=showcaseLabelRecords.findIndex(record=>record.entity===chest);
    if(labelAt>=0){showcaseLabelRecords.splice(labelAt,1);showcaseRevision++;}
  }
  burst(chest.x,chest.y,"#e3b445",34);burst(chest.x,chest.y,"#b98a4e",18);
  toast("chest opened — choose a consumable");sound(880,.3);
  queueConsumableRewards();
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

// ── mining fog ──────────────────────────────────────────────────────────────
// Fog blocks take chip damage like resource nodes but never drop anything: the reveal is the yield.
// Identity is checked through fogByCell so a stale reference (already-cleared cell) can never be
// hit twice; a cleared cell leaves the map for the rest of the run and bumps fogRevision.
/** Buried loot: one independent roll per cleared land block. The chest is the jackpot and needs a
 * genuinely placeable revealed cell (fully on land, nothing occupying it) — otherwise it degrades
 * to the coin, so the jackpot is never silently lost to a hidden tree. */
function rollFogLoot(cell){
  const roll=Math.random(),loot=FOG.loot;
  if(roll<loot.chestChance){
    if(terrainWorldRectEntirelyOnLand(footprintWorldRect(cell.cx,cell.cy))&&canPlace(cell.x,cell.y)){
      chests.push({x:cell.x,y:cell.y,hp:CHEST.maxHp,max:CHEST.maxHp,shake:0,footprint:CHEST.footprint});
      toast("the fog hid a buried cache");sound(660,.2);
    }else spawnResource("coin",cell.x,cell.y);
  }
  else if(roll<loot.chestChance+loot.coinChance)spawnResource("coin",cell.x+rand(-8,8),cell.y+rand(-5,5));
  else if(roll<loot.chestChance+loot.coinChance+loot.dustChance)spawnResource("dust",cell.x+rand(-8,8),cell.y+rand(-5,5));
}
function clearFogCell(cell,ring=0){
  if(fog[cell.idx]!==cell)return false;
  // Swap-remove keeps clears O(1); render layers rebuild off the count change, so order is free.
  const last=fog[fog.length-1];
  fog[cell.idx]=last;last.idx=cell.idx;fog.pop();
  fogByCell.delete(fogCellKey(cell.cx,cell.cy));fogRevision++;
  if(chopState.target===cell)resetChop();
  fogPops.push({x:cell.x,y:cell.y,cx:cell.cx,cy:cell.cy,water:cell.water,age:0});
  if(!cell.water&&state.runMode==="normal")rollFogLoot(cell);
  burst(cell.x,cell.y,"#8d8798",16);burst(cell.x,cell.y,"#c9c4d4",8);
  // Cascade pops climb in pitch with distance from the mined block, so a clear reads as one
  // rising "pop-pop-pop" figure rather than a pile of identical thuds.
  sound(520+ring*90,ring?.08:.12);
  return true;
}
/** A block mined to death takes its neighbourhood with it: the 3x3 core always pops, and cells
 * beyond it out to FOG.popRadius (roughly circular) pop with FOG.popEdgeChance, so every clearing
 * grows a ragged organic rim instead of a stamped square. Pops stagger outward by euclidean
 * distance, ignore remaining HP, and never cascade again themselves — one swing, one neighbourhood. */
function queueFogCascade(origin){
  const r=FOG.popRadius;
  for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
    if(!dx&&!dy)continue;
    const d=Math.hypot(dx,dy);
    if(d>r+.5)continue;
    if(d>1.5&&Math.random()>=FOG.popEdgeChance)continue;
    const cell=fogByCell.get(fogCellKey(origin.cx+dx,origin.cy+dy));
    if(!cell||cell.popQueued)continue;
    cell.popQueued=true;
    fogPopQueue.push({cell,at:state.clock.elapsed+d*FOG.popDelay,ring:Math.max(Math.abs(dx),Math.abs(dy))});
  }
}
function updateFogPops(){
  if(!fogPopQueue.length)return;
  const now=state.clock.elapsed;
  for(let i=fogPopQueue.length-1;i>=0;i--){
    const entry=fogPopQueue[i];
    if(entry.at>now)continue;
    fogPopQueue.splice(i,1);
    // A queued cell the player (or an earlier pop) already cleared is simply gone; skip it.
    if(fogByCell.get(fogCellKey(entry.cell.cx,entry.cell.cy))===entry.cell)clearFogCell(entry.cell,entry.ring);
  }
}
function hitFog(cell,quiet=false){
  if(fogByCell.get(fogCellKey(cell.cx,cell.cy))!==cell)return false;
  cell.hp--;cell.shake=1;addDamageNumber(cell,1);burst(cell.x,cell.y-6,"#6f6a7c",5);
  if(!quiet)sound(200+cell.hp*20,.05);
  if(cell.hp<=0){clearFogCell(cell);queueFogCascade(cell);}
  return true;
}
function clearGrassInFootprint(x,y,footprint){
  const cell=worldToCell(x,y),bounds=footprintCellBounds(cell.cx,cell.cy,footprint),removed=[];
  for(let cy=bounds.minY;cy<=bounds.maxY;cy++)for(let cx=bounds.minX;cx<=bounds.maxX;cx++){const tuft=grassByCell.get(cy*GRID_COLS+cx);if(tuft)removed.push(tuft);}
  for(const tuft of removed)removeGrass(tuft);
}

// Worker automation enters only the physical resource impact; player work always enters the unified
// click pipeline above, where crit, chain, Free Hit, and later click effects compose once.
function hitResource(target,kind,automatic,quiet=false,autoDrops=1,autoDamage=1){
  if(automatic)return damageResourceTarget(target,kind,{damage:autoDamage,drops:autoDrops,automatic:true});
  return executePlayerHit({kind:"resource",target,resourceKind:kind},{quiet});
}
function damageResourceTarget(target,kind,{damage=1,drops=1,critical=false,automatic=false}={}){
  addDamageNumber(target,damage,{critical});target.hp-=damage;target.shake=1;
  for(let i=0;i<drops;i++)spawnResource(kind,target.x+rand(-12,12),target.y+rand(-6,7));
  burst(target.x,target.y-12,kind==="wood"?"#9fb351":kind==="diamond"?"#78d7e5":"#bbb7ae",5);
  if(target.hp<=0&&kind==="wood"){
    target.stump=1;burst(target.x,target.y-10,"#557036",13);if(!automatic)toast("tree felled");
    // JUICE — the fall. `collapse` is a presentation-only countdown decayed in updateResourceNodes();
    // scene.js keeps drawing the LIVE trunk and tips it over while it runs, then swaps to the stump
    // it has always drawn. Gameplay already treats the node as spent (stump=1 above), so nothing
    // waits on this: the yield, the toast and the click target all resolved on the line before.
    target.collapse=1;
    fxDustRing(target.x,target.y,"#6d5a3d",10,{radius:20,speed:74});
    sound(96,.26);sound(150,.13);
  }else if(target.hp<=0){
    target.depleted=1;burst(target.x,target.y,kind==="diamond"?"#78d7e5":"#8b8985",11);if(!automatic)toast(kind==="diamond"?"diamond deposit exhausted":"rock cleared");
    // JUICE — the crumble. Same presentation-only countdown; the renderer squashes the live rock or
    // deposit into the ground over it instead of swapping to rubble on the same frame.
    target.collapse=1;
    fxDebris(target.x,target.y,kind==="diamond"?"#5fa9b6":"#7d7c78",9,{spread:88,lift:120,jitter:9,size:1.25});
    fxDustRing(target.x,target.y,kind==="diamond"?"#4d6264":"#8d8c88",9,{radius:16,speed:62});
    sound(kind==="diamond"?520:118,.22);
  }
  return true;
}

function spawnResource(kind,x,y,ttl=null){
  resourceDrops.push({kind,x,y,groundY:clamp(y+rand(10,22),35,H-20),vx:rand(-35,35),vy:rand(-75,-35),ground:false,target:null,t:0,spin:rand(0,6),ttl});
}
/** Reusable radial impulse on loose drops — the small shockwave impacts use to shove floating
 * resources aside (first caller: the meteor). Every drop inside `radius` is pushed away from (x,y)
 * with linear falloff through the exact toss physics spawnResource() seeds — outward vx, an upward
 * hop in vy, the landing spot (groundY) displaced along ground-plane y — so a pushed drop bounces,
 * settles and stays collectable exactly like a fresh one. Drops tweening to the hand or base are
 * left alone (that channel owns their motion); a claimed-but-grounded drop moves and its worker
 * simply follows, since pickup re-reads drop.x/y every frame. When the push is up-screen the drop
 * is reseated at its new landing spot before the hop (updateLooseResources()'s ground clamp would
 * otherwise eat the impulse) — an instant step of at most `push` px, hidden under the impact
 * effects that call this. */
function applyShockwave(x,y,{radius=120,force=120,push=16,hop=55}={}){
  for(const drop of resourceDrops){
    if(drop.target)continue;
    const d=distance(x,y,drop.x,drop.y);
    if(d>=radius)continue;
    const falloff=1-d/radius;
    const a=d>1e-3?Math.atan2(drop.y-y,drop.x-x):fxRand(0,Math.PI*2);   // fx stream: garnish must not shift gameplay RNG
    drop.vx+=Math.cos(a)*force*falloff;
    drop.vy=Math.min(drop.vy,0)-hop*falloff;
    drop.groundY=clamp(drop.groundY+Math.sin(a)*push*falloff,35,H-20);
    if(drop.y>drop.groundY)drop.y=drop.groundY;
    drop.ground=false;
  }
}
function spawnCoin(){
  // On or just past the player's screen, not anywhere on the 5x map: ±1.15× the visible
  // half-extents around the camera target (the same numbers clampCamera() frames with),
  // so an 8s coin is actually findable before it despawns.
  const camera=state.camera,halfW=VIEW_W/(2*camera.zoom)*1.15,halfH=VIEW_H/(2*camera.zoom)*1.15;
  for(let attempt=0;attempt<300;attempt++){
    const x=clamp(camera.x+rand(-halfW,halfW),40,W-40),y=clamp(camera.y+rand(-halfH,halfH),40,H-40);
    if(distance(x,y,BASE.x,BASE.y)<80)continue;
    // Never under fog: a coin the player cannot see or reach would silently burn its 8s timer.
    if(fogAtPoint(x,y))continue;
    spawnResource("coin",x,y,8);toast("a gold coin appeared nearby");sound(1170,.1);return;
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
  // Before the base stands there is no "deposit at base" action at the map centre — the unfinished
  // site claims the cursor through the ordinary blueprint branch below, exactly like any other build.
  if(mainBaseStanding()&&distance(m.x,m.y,BASE.x,BASE.y)<BASE.r+16)return {kind:"base",object:BASE};
  for(const building of buildings){
    if(!building.complete&&distance(m.x,m.y,building.x,building.y)<38)return {kind:"building",object:building};
    if(building.complete&&building.type==="stockpile"&&distance(m.x,m.y,building.x,building.y)<42)return {kind:"stockpile",object:building};
    if(building.complete&&building.type==="summoningCircle"&&distance(m.x,m.y,building.x,building.y)<52)return {kind:"summoning",object:building};
    if(building.complete&&building.type==="consumableForge"&&distance(m.x,m.y,building.x,building.y)<42)return {kind:"consumableForge",object:building};
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
  else if(target&&target.kind==="summoning"){
    dropToSummoningCircle(target.object);
    if(carriedTotal())dropCarriedOnGround(true);
  }else if(target&&target.kind==="consumableForge"){
    dropToConsumableForge(target.object);
    if(carriedTotal())dropCarriedOnGround(true);
  }else if(target&&target.kind==="upgrade"){
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

function dropToSummoningCircle(building){
  const summon=building.summoning,amount=state.carried.dust;
  if(amount<=0){toast("summoning circle needs dust");return;}
  state.carried.dust=0;summon.dust+=amount;building.pulse=1;handoffParticles(building.x,building.y,"dust",amount);
  const summonCount=Math.floor(summon.dust/SUMMONING_CIRCLE.dustCost);
  summon.dust%=SUMMONING_CIRCLE.dustCost;
  for(let i=0;i<summonCount;i++)spawnFriendlyBrute(building.x,building.y);
  if(summonCount){burst(building.x,building.y,"#9870c9",30);toast(summonCount+(summonCount===1?" friendly Brute summoned":" friendly Brutes summoned"));sound(100,.35);}
  else toast("summoning circle: "+summon.dust+" / "+SUMMONING_CIRCLE.dustCost+" dust");
}

function dropToConsumableForge(building){
  const forge=building.consumableForge,amount=state.carried.dust;
  if(amount<=0){toast("consumable forge needs dust");return;}
  state.carried.dust=0;forge.dust+=amount;building.pulse=1;handoffParticles(building.x,building.y,"dust",amount);
  const batches=Math.floor(forge.dust/CONSUMABLE_FORGE.dustCost);
  forge.dust%=CONSUMABLE_FORGE.dustCost;
  if(batches){queueConsumableRewards(batches);burst(building.x,building.y,"#a783df",24);toast(batches+(batches===1?" consumable draft queued":" consumable drafts queued"));sound(620,.18);}
  else toast("consumable forge: "+forge.dust+" / "+CONSUMABLE_FORGE.dustCost+" dust");
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
  // The rewrite below discards any ward-totem grant; clearing the flag lets syncTowerWard re-grant
  // on the next update instead of silently eating the pool.
  if(job.kind==="tower"){const tower=building.tower,healthRatio=tower.maxHp?clamp(tower.hp/tower.maxHp,0,1):1,newMaxHp=towerMaxHp(upgrade);tower.variant=job.id;tower.ward=false;tower.maxHp=newMaxHp;tower.hp=newMaxHp*healthRatio;}
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

// Base deposits are pure storage: the caller-owned resource-count record is consumed atomically
// into state.stored, where builders withdraw from (nearestBuildStorage treats BASE as storage).
// Depositing grants NOTHING — the run's only progression is the authored base recipe, charged
// before this by dropToBase() alone, never here.
function storeAtBase(counts,particleFromX,particleFromY){
  let units=0;
  for(const kind of RESOURCE_KINDS){
    const amount=counts[kind];units+=amount;state.stored[kind]+=amount;counts[kind]=0;
    handoffParticles(BASE.x,BASE.y,kind,amount,particleFromX,particleFromY);
  }
  if(units<=0)return 0;
  state.basePulse=1;toast("stored "+units);sound(520,.08);
  return units;
}

// ── the draft ───────────────────────────────────────────────────────────────
function buffStacks(id){return state.draft.buffs[id]||0;}
// RewardDraft owns the finite Card Pull and every selection rule. This adapter owns the gameplay
// consequences of its read-only view: pausing input and notifying presentation.
function syncRewardDraft(){
  state.draftPaused=!!rewardDraft.current();
  if(state.draftPaused){stopGameplayInput();closeUpgradeMenu();}
  effects.draftChanged();
}
/** Chest or forge rewards. Showcase fixtures never enter production progression. */
function queueConsumableRewards(count=1){
  if(state.runMode!=="normal")return;
  rewardDraft.earn("consumable",count);syncRewardDraft();
}
/**
 * One completed authored base level deals ONE pick of up to three from the Card Pull's building
 * cards, and the chosen build lands in the hand. THE only caller is
 * completeMainBaseLevel(), which fires exactly once per level, so no free-cost sweep, repeated
 * release or oversized deposit can pay this twice.
 */
function queueBaseLevelReward(){
  if(state.runMode!=="normal")return;                 // the showcase sandbox is never dealt cards
  rewardDraft.earn("base");syncRewardDraft();
}
/** Wave clearance grants one permanent buff. */
function queueWaveClearReward(){
  if(state.runMode!=="normal")return;                 // the showcase sandbox is never dealt cards
  rewardDraft.earn("dawn");syncRewardDraft();
}
// Screen spells snapshot the renderer's actual active-camera frustum answer before damage starts;
// kills and chain movement during iteration cannot change membership or ordering.
function onScreenCombatTargets(){return chainCombatRoster().filter(target=>target.hp>0&&effects.isCombatTargetOnScreen(target));}
function recallResources(){
  for(const drop of resourceDrops){if(drop.claimedBy){clearWorkerTask(drop.claimedBy);delete drop.claimedBy;}drop.target="base";drop.t=0;}
  toast("resources recalled");sound(520,.14);
}
// THE one place a card becomes an effect — a buff the instant it is drafted, a consumable the
// instant it is PLAYED out of the hand. Buff entries are deliberately empty: their whole effect is
// the stack tally, layered over the authored numbers by the accessors below.
const CARD_EFFECTS={
  clickSpeed(){},critClicks(){},critYield(){},freeHit(){},enemyPickup(){},vacuumRadius(){},workerSpeed(){},workerResourceDamage(){},workerCombatDamage(){},workerCarry(){},buildCapacity(){},towerDamage(){},towerSpeed(){},towerRange(){},clickDamage(){},chainLightning(){},deathTree(){},deathExplosion(){},
  towerHp(){for(const building of [...buildings,heldBuilding()])if(building?.tower){building.tower.maxHp+=CARD_BUFFS.towerHp;building.tower.hp+=CARD_BUFFS.towerHp;}},
  handCarry(){state.capacity+=CARD_BUFFS.handCarry;},
  baseHp(){state.baseMax+=CARD_BUFFS.baseHp;state.baseHp+=CARD_BUFFS.baseHp;},
  woodBundle(){state.stored.wood+=CARD_CONSUMABLES.woodBundle;state.basePulse=1;},
  stoneBundle(){state.stored.stone+=CARD_CONSUMABLES.stoneBundle;state.basePulse=1;},
  dustBundle(){state.stored.dust+=CARD_CONSUMABLES.dustBundle;state.basePulse=1;},
  healBase(){state.baseHp=state.baseMax;state.basePulse=1;},
  repairAll(){for(const building of [...buildings,heldBuilding()])if(building?.tower)building.tower.hp=building.tower.maxHp;},
  longDay(){if(state.clock.phase==="day")state.clock.remaining+=CARD_CONSUMABLES.longDay;else state.draft.dayBonus+=CARD_CONSUMABLES.longDay;},
  calmNight(){state.draft.calmNight=true;},
  screenClick(){for(const target of onScreenCombatTargets())hitCombatTarget(target,true);sound(760,.18);},
  resourceRecall(){recallResources();},
  touchOfDeath(){for(const target of onScreenCombatTargets())damageCombatTarget(target,999,"#493052",12,null,{announce:true});sound(90,.35);}
};
/** A drafted BUFF, applied on the spot. Normal play gives each card ID once; debug may stack it. */
function applyBuff(id){
  const card=cardById[id],effect=CARD_EFFECTS[id];
  if(!card||!effect)return false;
  state.draft.buffs[id]=buffStacks(id)+1;
  effect();toast("drafted: "+card.text);sound(700,.16);
  return true;
}
/**
 * THE routing rule for a taken card, shared by every offer kind. A buff lands immediately; a
 * consumable or build lands in the HAND and does nothing at all until it is played. RewardDraft
 * has already removed the chosen ID from the finite Card Pull before this function runs.
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
// `cast` is the escape hatch for a spell: fireball aims with its own target-only row (its
// effectRadius IS FIREBALL.radius) and detonates on touchdown, leaving a small 1x1 rock behind.
// `site` is the build half of the table (below): the card drops one CONSTRUCTION SITE where a kit
// drops an authored instant building. A tower variant site combines chassis + variant materials,
// then produces the named tower in one completion transition.
// Build cards that place THEMSELVES: no ghost, no click, one authored anchor. Each entry is the
// command the card runs, returning false when it refuses (a second main base, for instance). These
// are subtracted from TARGETED_CARDS below, so a card is either aimed or anchored, never both.
const ANCHORED_BUILD_CARDS={bpMainBase:raiseMainBaseSite};
const TARGETED_CARDS={
  blastCharge:{type:"blast"},
  spikeKit:{type:"spikes"},
  mineKit:{type:"landmine"},
  tarKit:{type:"tar"},
  damageOrbs:{type:"damageOrbs"},
  summoningCircle:{type:"summoningCircle"},
  fireball:{type:"fireballTarget",cast:castFireball},
  meteor:{type:"meteorTarget",cast:castMeteor},
  // A build card asks WHERE exactly like a kit does — its own authored row names what lands, so the
  // whole set is derived from the registry rather than restated here. "tower:sniper" drops a tower
  // site promised to the sniper variant; "building:obelisk" drops an obelisk site. A build card whose
  // ref is a concept has no table row yet and stays out, so playing one refuses.
  ...Object.fromEntries(CARDS.filter(card=>card.category==="build"&&!ANCHORED_BUILD_CARDS[card.id]).map(card=>[card.id,blueprintPlacement(card.ref)]).filter(([,spec])=>spec))
};
function blueprintPlacement(ref){
  const [kind,id]=String(ref||"").split(":");
  if(kind==="tower"&&TOWER_VARIANTS[id])return {type:"tower",variant:id,site:true};
  if(kind==="building"&&BUILDING_TYPES[id])return {type:id,variant:null,site:true};
  return null;
}
/** What a build card's placement will be called once it stands up: its variant's authored name
 *  when it is a tower, the building's own otherwise. */
function blueprintName(spec){return spec.variant?TOWER_VARIANTS[spec.variant].name:BUILDING_TYPES[spec.type].name;}
function cardCharges(id){return cardById[id].charges??1;}
/** Playing the card only CALLS the strike: the rock is in flight for METEOR.fallTime and its whole
 *  effect resolves at touchdown in updateFallingMeteors(), never here. */
function castMeteor(x,y){
  fallingMeteors.push({x,y,t:0,dur:METEOR.fallTime});
  toast("meteor called — impact imminent");sound(1560,.22);
}
function meteorImpact(x,y){
  applyAreaDamage({centers:[{x,y}],radius:METEOR.radius,damage:METEOR.damage,targetType:METEOR.damageTargetType,color:"#d06a38"});
  // Loose drops inside the blast get a small outward shove — same reach as the damage.
  applyShockwave(x,y,{radius:METEOR.radius});
  // The footprint was clear at CAST, but the fall is real time — a building or chest raised under
  // the falling rock keeps its ground: the rock then shatters and the strike is damage-only.
  if(canPlace(x,y,"meteorTarget")){
    // shake makes it wobble on landing through the ordinary hit channel; pop is meteor-only landing
    // compression the renderer reads as a scale overshoot (decays below with the shakes).
    rocks.push({x,y,hp:METEOR.rockHp,max:METEOR.rockHp,depleted:0,shake:1.3,pop:1,meteor:true,footprint:FOOTPRINT_3x3});
    clearGrassInFootprint(x,y,FOOTPRINT_3x3);
    toast("meteor impact — a mineable rock remains");
  }else toast("meteor impact — the rock shattered on landing");
  for(let i=0;i<96;i++)particles.push({x,y,vx:rand(-320,320),vy:rand(-340,30),life:rand(.5,1.25),col:i%3?"#8b6248":i%2?"#e18a43":"#f3c76a"});
  addScreenShake(1);
  sound(42,.6);sound(90,.25);
}
/** Call the strike. Damage waits for touchdown in updateFallingFireballs(). */
function castFireball(x,y){
  fallingFireballs.push({x,y,t:0,dur:FIREBALL.fallTime});
  toast("fireball incoming");sound(980,.12);
}
function fireballImpact(x,y){
  applyAreaDamage({centers:[{x,y}],radius:FIREBALL.radius,damage:FIREBALL.damage,targetType:FIREBALL.damageTargetType,color:"#ef7b3f"});
  applyShockwave(x,y,{radius:FIREBALL.radius,force:90});
  // Small cousin of the meteor rock: an ordinary 1x1 stone node with FIREBALL.rockHp. Same rule as
  // the meteor — the cell was clear at cast, but if something was raised under it during the fall
  // the rock shatters and the slam is damage-only.
  if(canPlace(x,y,"fireballTarget")){
    rocks.push({x,y,hp:FIREBALL.rockHp,max:FIREBALL.rockHp,depleted:0,shake:1,pop:1,fireball:true,footprint:FOOTPRINT_1x1});
    clearGrassInFootprint(x,y,FOOTPRINT_1x1);
  }
  // Juice sized to the halved radius: fewer, tighter embers and a lighter kick, so the punch the
  // player feels matches the ground the blast actually covers (the rings read FIREBALL.radius).
  for(let i=0;i<40;i++)particles.push({x,y,vx:rand(-150,150),vy:rand(-170,25),life:rand(.35,1),col:i%3?"#ef7b3f":i%2?"#b84b38":"#ffd36a"});
  addScreenShake(.4);
  toast("fireball impact");sound(52,.38);sound(120,.16);
}
// ── the main base ───────────────────────────────────────────────────────────
// The player's base is BUILT, and this is the whole of its runtime lifecycle:
//   LEVEL 1  bpMainBase (the opening card) → raiseMainBaseSite() → ordinary blueprint delivery →
//            completeBuilding() → completeMainBaseLevel() → baseLevel 1, day 1, one build draft.
//   LEVEL 2+ carry the next authored recipe to the STANDING base and release →
//            deliverToMainBaseRecipe() → completeMainBaseLevel() → one build draft.
// Where it stands is authored (BASE in data.js) and never chosen, so this card does not aim: there
// is exactly one legal anchor and canPlace() has always reserved it. What it costs is authored too
// (MAIN_BASE_LEVELS, level 1 via the BUILDING_TYPES.mainBase row), delivered by hand or by builders
// like any other site.
//
// TWO deliverers, one storage rule. A PLAYER release at the base pays the active recipe first and
// stores the remainder; a worker hauler deposits into storage and nothing else (depositWorkerLoad),
// so autonomous logistics can never spend the player's stone on an upgrade they did not choose.
/** Is a base actually standing? THE predicate for every base service — storage, hover, enemy
 *  target, damage, the rendered structure. Reads baseLevel, never a building record, so the
 *  showcase's record-less fixture base answers yes exactly like a finished run base. */
function mainBaseStanding(){return state.baseLevel>0;}
/** The unfinished site, or null. There is at most one (validateSimulationInvariants). */
function mainBaseSite(){return buildings.find(building=>building.type==="mainBase"&&!building.complete)||null;}
/** The authored recipe the base is CURRENTLY charging — MAIN_BASE_LEVELS[state.baseLevel] — or null
 *  at level 30. A corrupt level above the authored maximum is a programmer bug, never another
 *  spelling of "maxed": assert here so every status, delivery, and completion path crashes on it. */
function mainBaseNextLevel(){
  invariant(Number.isInteger(state.baseLevel)&&state.baseLevel>=0&&state.baseLevel<=MAIN_BASE.maxLevel,"illegal base level "+state.baseLevel);
  if(state.baseLevel===MAIN_BASE.maxLevel)return null;
  const next=MAIN_BASE_LEVELS[state.baseLevel];
  invariant(next&&next.level===state.baseLevel+1,"missing authored base level "+(state.baseLevel+1));
  return next;
}
/** Progress on that recipe, from whichever record owns it: the construction site while the base is
 *  still being raised, state.baseDelivered once it stands. See state.baseDelivered's note. */
function mainBaseDelivered(){return mainBaseSite()?.delivered||state.baseDelivered;}
function mainBaseNeedText(){
  const next=mainBaseNextLevel();if(!next)return "";
  const delivered=mainBaseDelivered();
  return RESOURCE_KINDS.filter(kind=>(next.cost[kind]||0)>(delivered[kind]||0)).map(kind=>((next.cost[kind]||0)-(delivered[kind]||0))+" "+kind).join(" + ");
}
/**
 * THE read-only view of the base's authored progression, for the overlay, the draft copy and tests:
 * the level that stands, the authored maximum, what the next level costs (null at the maximum) and
 * how much of it is already delivered. `delivered` is a COPY — callers may not write base progress.
 * Since XP was deleted (Aug 22) this is also the HUD's run-progress readout: src/ui/draft.js draws
 * it as the top bar, filling on `delivered` against `cost`.
 */
function mainBaseStatus(){
  const next=mainBaseNextLevel();
  return {level:state.baseLevel,maxLevel:MAIN_BASE.maxLevel,atMaxLevel:!next,cost:next?next.cost:null,delivered:{...mainBaseDelivered()}};
}
/**
 * THE one transition that raises the base a level, and the only writer of state.baseLevel above
 * zero. Both payers meet here: the level-1 CONSTRUCTION SITE (completeBuilding, which has already
 * taken its wood the ordinary blueprint way) and every later recipe delivered at the standing base
 * (deliverToMainBaseRecipe). Payment is the caller's business; this owns the level number, the
 * cleared progress, the pre-wave exit and the one draft the level earns.
 *
 * Idempotence: the bounds invariant below makes a second call for the same level a hard failure
 * rather than a duplicate reward, and both callers are single-shot by construction —
 * completeBuilding returns early on an already-complete site, and a release can only pay a recipe
 * that still needs something.
 *
 * `free` follows completeBuilding's rule verbatim: a completion that spent nothing earns nothing,
 * so the free-costs toggle and the debug opening skip stand a base without paying out a build.
 */
function completeMainBaseLevel({free=false}={}){
  const next=mainBaseNextLevel();
  invariant(next,"the main base is already at its maximum authored level");
  invariant(next.level===state.baseLevel+1,"the authored base levels are not contiguous");
  state.baseLevel=next.level;
  for(const kind of RESOURCE_KINDS)state.baseDelivered[kind]=0;
  // Ordered so the clock agrees with the level BEFORE any reward can pause the world: level 1 is
  // also the pre-wave exit, and a run must be started before it can be interrupted.
  if(state.clock.phase==="pre-wave")beginFirstDay();
  effects.baseLevelChanged();
  if(!free)queueBaseLevelReward();
}
/**
 * A PLAYER release at the standing base, paid into the active authored recipe before anything
 * reaches storage. Takes only what the recipe still needs, so however much is carried a single
 * release completes AT MOST one level; partial deliveries bank on state.baseDelivered and survive
 * indefinitely. Returns having consumed part of `counts` — the remainder is the caller's to store.
 * A no-op at the maximum authored level, and while the base is still a construction site (level 0's
 * recipe is charged on that site by the ordinary blueprint path).
 */
function deliverToMainBaseRecipe(counts,fromX,fromY){
  const next=mainBaseNextLevel();
  if(!mainBaseStanding()||!next)return false;
  let total=0;
  for(const kind of RESOURCE_KINDS){
    const amount=Math.min((next.cost[kind]||0)-state.baseDelivered[kind],counts[kind]);
    if(amount<=0)continue;
    counts[kind]-=amount;state.baseDelivered[kind]+=amount;total+=amount;
    handoffParticles(BASE.x,BASE.y,kind,amount,fromX,fromY);
  }
  if(!total)return false;
  state.basePulse=1;sound(480,.08);effects.baseLevelChanged();   // banked progress moves the HUD's base bar
  if(RESOURCE_KINDS.every(kind=>state.baseDelivered[kind]>=(next.cost[kind]||0))){
    completeMainBaseLevel();
    burst(BASE.x,BASE.y-12,"#ead28d",18);
    fxGroundThump(BASE.x,BASE.y,BASE.footprint,"#c0a170");
    toast("main base raised to level "+state.baseLevel+(mainBaseNextLevel()?"":" — the authored maximum"));
    sound(760,.18);effects.buildHudChanged();
  }else toast("main base level "+next.level+" needs "+mainBaseNeedText());
  return true;
}
/**
 * Play the opening card: ONE unfinished main-base site on the authored anchor, or a refusal.
 * Atomic — either the site is in `buildings` and the card is spent, or nothing happened at all.
 * Duplicates refuse rather than stacking a second base: the map has one centre.
 */
function raiseMainBaseSite(){
  if(mainBaseStanding()){toast("the main base already stands");sound(200,.12);return false;}
  if(mainBaseSite()){toast("the main base site is already staked out");sound(200,.12);return false;}
  // The anchor cells have been reserved against every other placement since world load, so this is
  // an assertion about the map, not a placement test the player can fail.
  invariant(canPlace(BASE.x,BASE.y,"mainBase")&&footprintFogFree(BASE.x,BASE.y,buildingFootprint("mainBase")),"the authored base anchor is not clear");
  const site=createBuilding("mainBase",BASE.x,BASE.y);
  buildings.push(site);clearGrassInFootprint(site.x,site.y,buildingFootprint(site.type));
  fxGroundThump(site.x,site.y,buildingFootprint(site.type),"#8a7358");
  toast("main base staked out — carry "+constructionNeedText(site)+" to it");sound(240,.06);sound(104,.15);
  if(DBG.freeCosts)completeBuilding(site);
  return true;
}
/**
 * THE pre-wave exit, and the only one: the base standing is what starts the game's clock. Called by
 * completeMainBaseLevel() the moment the level-1 recipe is delivered, never by a debug phase button
 * — those refuse while pre-wave (see debugGoToPhase). Day 1 gets the FULL DAY_DURATION, plus any
 * long-day bonus banked while the clock had no countdown to extend.
 */
function beginFirstDay(){
  const clock=state.clock;
  invariant(clock.phase==="pre-wave","the first day may only be started from the pre-wave opening");
  invariant(state.baseLevel>0,"the first day started before a base stood");
  clock.phase="day";clock.remaining=DAY_DURATION+state.draft.dayBonus;state.draft.dayBonus=0;
  effects.phaseHudChanged();
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
  if(!canPlace(anchor.x,anchor.y,targeting.type)||!footprintFogFree(anchor.x,anchor.y,buildingFootprint(targeting.type))){toast("needs clear ground away from the base");return false;}
  if(targeting.cast)targeting.cast(anchor.x,anchor.y);
  else{
    const placed=createBuilding(targeting.type,anchor.x,anchor.y);
    // Fancy towers are one build. Their site asks for the same total materials as chassis + variant,
    // but completion installs the promised variant directly instead of exposing a second job.
    if(targeting.site){
      placed.plannedVariant=targeting.variant;
      if(targeting.variant)for(const kind of RESOURCE_KINDS)placed.cost[kind]=(placed.cost[kind]||0)+(TOWER_VARIANTS[targeting.variant].cost[kind]||0);
    }
    buildings.push(placed);clearGrassInFootprint(placed.x,placed.y,buildingFootprint(placed.type));
    // JUICE — the site lands rather than blinking in: footprint-sized dust plus a low thud under
    // the existing placement blip. Emissions only; the building record above is untouched.
    fxGroundThump(placed.x,placed.y,buildingFootprint(placed.type),"#8a7358");
    // A kit's charges are free: these are the authored cost-0 instant buildings, and the CARD is
    // the only thing that pays for them — there is no separate stack counter anywhere any more.
    if(!targeting.site)
      toast(BUILDING_TYPES[targeting.type].name+" placed — "+(entry.charges-1)+" charge"+(entry.charges===1?"":"s")+" left");
    // free costs (debug) resolves the same single completion transition.
    else if(DBG.freeCosts)completeBuilding(placed);
    else toast(blueprintName(targeting)+" build placed — carry its resources to it");
    sound(240,.06);sound(104,.15);   // JUICE: the blip keeps its identity, the thud gives it weight
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
function chopFillRate(){
  // The debugger may tune the unbuffed swing below the production floor. Zero stacks must preserve
  // that authored value rather than make the player slower, so the floor never exceeds chopTime.
  const minimumSeconds=Math.min(TUNE.chopTime,CARD_BUFFS.clickSpeedMinimumSeconds);
  const swingSeconds=Math.max(minimumSeconds,TUNE.chopTime-CARD_BUFFS.clickSpeedSeconds*buffStacks("clickSpeed"));
  return (globalUpgradeEnabled("autoClick")?STEADY_HAND_RATE:1)*TUNE.chopTime/swingSeconds;
}
function vacuumRadius(){return TUNE.vacuumRadius+CARD_BUFFS.vacuumRadius*buffStacks("vacuumRadius");}
function clickDamage(){return TUNE.clickDamage+CARD_BUFFS.clickDamage*buffStacks("clickDamage");}
function critHit(){const stacks=buffStacks("critClicks");return stacks>0&&Math.random()<CARD_BUFFS.critChance*stacks;}
function chainLightningJumps(){const stacks=buffStacks("chainLightning");return stacks>0?CARD_BUFFS.chainJumps+stacks-1:0;}
function chainLightningChance(){const stacks=buffStacks("chainLightning");return stacks>0?CARD_BUFFS.chainChance+CARD_BUFFS.chainChanceStack*(stacks-1):0;}
function workerSpeed(){return WORKER_SPEED*CARD_BUFFS.workerSpeed**buffStacks("workerSpeed");}
function workerResourceDamage(){return 1+CARD_BUFFS.workerResourceDamage*buffStacks("workerResourceDamage");}
function workerCarry(){return WORKER_CARRY+CARD_BUFFS.workerCarry*buffStacks("workerCarry");}
function towerDamageBuildingBonus(tower){
  const shrine=BUILDING_TYPES.warShrine;
  return buildings.some(building=>building.complete&&building.type==="warShrine"&&distance(tower.x,tower.y,building.x,building.y)<=shrine.effectRadius)?shrine.damageBonus:0;
}
function towerDamage(tower,variant=towerVariant(tower)){return variant.damage+CARD_BUFFS.towerDamage*buffStacks("towerDamage")+towerDamageBuildingBonus(tower);}
function towerMaxHp(variant){return variant.maxHp+CARD_BUFFS.towerHp*buffStacks("towerHp");}
function nearAuraBuilding(tower,type){
  const aura=BUILDING_TYPES[type];
  return buildings.some(building=>building.complete&&building.type===type&&distance(tower.x,tower.y,building.x,building.y)<=aura.effectRadius);
}
function towerHasteFactor(tower){return nearAuraBuilding(tower,"hasteTotem")?BUILDING_TYPES.hasteTotem.cooldownFactor:1;}
function towerCooldown(building,variant){return variant.cooldown/CARD_BUFFS.towerSpeed**buffStacks("towerSpeed")*towerHasteFactor(building);}
/** Ward totem reconciliation, same shape as syncWorkerGarrisonBonus: the aura grants its hp pool
 * as REAL health on the transition in and takes it back on the way out, never dropping a live
 * tower below 1 hp (moving a tower out of coverage must not kill it). Upgrade and debug paths
 * that rewrite tower.maxHp clear tower.ward first so this re-grants on the next update. */
function syncTowerWard(building){
  const tower=building.tower,inAura=nearAuraBuilding(building,"wardTotem");
  if(inAura&&!tower.ward){tower.ward=true;tower.maxHp+=BUILDING_TYPES.wardTotem.hpBonus;tower.hp+=BUILDING_TYPES.wardTotem.hpBonus;}
  else if(!inAura&&tower.ward){tower.ward=false;tower.maxHp-=BUILDING_TYPES.wardTotem.hpBonus;tower.hp=clamp(tower.hp-BUILDING_TYPES.wardTotem.hpBonus,1,tower.maxHp);}
}
function towerRangeBeaconBonus(tower){
  const beacon=BUILDING_TYPES.rangeBeacon;
  return buildings.some(building=>building.complete&&building.type==="rangeBeacon"&&distance(tower.x,tower.y,building.x,building.y)<=beacon.effectRadius)?beacon.rangeBonus:0;
}
function towerAttackRadius(tower,variant=towerVariant(tower)){return (variant.range||variant.effectRadius)+CARD_BUFFS.towerRange*buffStacks("towerRange")+towerRangeBeaconBonus(tower);}
/** A player release over the standing base. The active authored recipe is paid FIRST and takes only
 *  what it still needs; everything left — the whole load once the base is at its maximum level —
 *  lands in storage. */
function dropToBase(){
  deliverToMainBaseRecipe(state.carried,state.mouse.x,state.mouse.y);
  storeAtBase(state.carried,state.mouse.x,state.mouse.y);
}

function buildingCost(building){return building.cost||BUILDING_TYPES[building.type].cost;}
function constructionComplete(building){const cost=buildingCost(building);return RESOURCE_KINDS.every(kind=>(building.delivered[kind]||0)>=(cost[kind]||0));}
function constructionNeedText(building){const cost=buildingCost(building);return RESOURCE_KINDS.filter(kind=>(cost[kind]||0)>(building.delivered[kind]||0)).map(kind=>((cost[kind]||0)-(building.delivered[kind]||0))+" "+kind).join(" + ");}
/** `free` completions (the free-costs debug toggle, the debug base skip) spend nothing and
 *  therefore earn nothing; everything else is identical. */
function completeBuilding(building,{free=DBG.freeCosts}={}){
  if(building.complete)return;
  const def=BUILDING_TYPES[building.type];building.complete=true;building.starved=false;
  if(def.resource)state.capacity+=2;
  const planned=building.plannedVariant&&TOWER_VARIANTS[building.plannedVariant]?building.plannedVariant:null;
  if(building.type==="tower"){
    const id=planned||"basic",variant=TOWER_VARIANTS[id];
    const maxHp=towerMaxHp(variant);
    building.tower={variant:id,cooldown:0,flash:0,hitFlash:0,hp:maxHp,maxHp};
  }
  building.plannedVariant=null;
  if(building.type==="house")building.spawnTimer=WORKER_SPAWN_TIME;
  // The base is the one completion that also moves the run's clock: completeMainBaseLevel() takes
  // its first authored level, ends the untimed opening and queues the level's draft — the run's
  // only progression payout now that XP is gone.
  if(building.type==="mainBase"){
    invariant(state.baseLevel===0,"a second main base completed");
    completeMainBaseLevel({free});
  }
  // Resolve the transition as one transaction. updateWorkerSpawns() runs before workers, so leaving
  // an earlier builder unresolved until the next tick would expose its durable vacancy to autofill.
  resolveBuildingCompletionWorkers(building);
  burst(building.x,building.y-12,"#ead28d",18);
  // JUICE — completion pop. `pulse` is the existing renderer-owned bump channel (dropToBuilding,
  // the stockpile and tower damage already write it, updateBuildings decays it); writing it here
  // makes the finished structure snap up on the frame it replaces its blueprint instead of just
  // swapping models. The dust settles out over the pad it now owns.
  building.pulse=1;
  fxGroundThump(building.x,building.y,buildingFootprint(building.type),"#c0a170");
  fxDebris(building.x,building.y-14,"#ead28d",10,{spread:66,lift:135,size:.85});
  sound(300,.11);
  const readyMessage=building.type==="mainBase"?"main base complete — day 1 begins":building.type==="stockpile"?"stockpile complete — release resources over it":building.type==="consumableForge"?"consumable forge complete — deliver dust to draft consumables":building.type==="house"?"house complete — worker production started":building.type==="scoutHut"?"scout hut complete — drop a worker on it to scout the fog":building.type==="obelisk"?"obelisk complete — hover it to choose upgrades":building.type==="tower"?(planned?TOWER_VARIANTS[planned].name+" complete":"basic tower complete"):def.name+" complete";
  // Finishing an ordinary building pays NOTHING but the building — the XP grant that used to live
  // here (and the draft it dealt) was deleted Aug 22; base levels are the whole progression.
  toast(def.resource?def.name+" complete — staffed workers gather "+def.resource+" faster nearby":readyMessage);sound(760,.18);effects.buildHudChanged();
}
function dropToBuilding(building){
  const cost=buildingCost(building);let total=0;
  for(const kind of RESOURCE_KINDS){
    const amount=Math.min((cost[kind]||0)-(building.delivered[kind]||0),state.carried[kind]);
    state.carried[kind]-=amount;building.delivered[kind]+=amount;total+=amount;handoffParticles(building.x,building.y,kind,amount);
  }
  if(!total){toast("this build already has that resource");return;}
  building.pulse=1;sound(480,.08);
  // The level-1 base recipe is charged on THIS record (mainBaseDelivered reads it), so the HUD's
  // base bar has to hear about a partial delivery to the site the same way it hears about one to
  // the standing base.
  if(building.type==="mainBase")effects.baseLevelChanged();
  if(constructionComplete(building))completeBuilding(building);
  else toast("needs "+constructionNeedText(building));
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
  // The base anchor is just another occupant: its 3x3 blocks, the cells beside it do not. The
  // reservation exists from world load, before anything stands there, so the map centre is still
  // waiting when the opening card is played. The ONE candidate allowed onto those cells is the main
  // base itself — and only raiseMainBaseSite() ever names that type, at BASE exactly.
  if(type!=="mainBase"&&cellBoundsOverlap(bounds,occupiedCellBounds(BASE)))return false;
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
function nextHouseCost(){const count=completeHouses().length;if(count===0)return {...STARTING_HOUSE_COST};return {wood:HOUSE_COST.wood+HOUSE_COST_ESCALATION.wood*count,stone:HOUSE_COST.stone+HOUSE_COST_ESCALATION.stone*count};}
function sourceWorkerCount(source){const held=heldWorker();return state.workers.filter(worker=>worker.spawnSource===source).length+(held?.spawnSource===source?1:0);}
/** Durable-post compatibility view adds arrival to shared occupancy. Accepts the BASE anchor too:
 *  the standing base is a durable haul post, so it reports vacancies and arrivals like a stockpile. */
function durablePostStatus(building){
  if(state.runMode!=="normal")return null;
  const status=workerOccupancyStatus(building);if(!status)return null;
  const assigned=assignedWorkers(building);
  return {building,capacity:status.capacity,assigned:status.assigned,arrived:assigned.filter(worker=>state.workers.includes(worker)&&worker.staffingArrivedAt===building).length};
}
function createHouseWorker(house){
  if(!house.complete||house.type!=="house")return null;
  const postX=house.x,postY=house.y+23;
  // Workers are born FREE: no job, no post loyalty. The scheduler below hands them autonomous work.
  // Houses are the ONLY worker source — the scout hut is a staffed post, never a spawner.
  return {x:postX+rand(-8,8),y:postY,postX,postY,spawnSource:house,job:"free",jobTarget:null,autonomous:true,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:{wood:0,stone:0,dust:0,coin:0,diamond:0},hp:WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,guardSafeTime:0,garrisonBonus:false};
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

// A node under fog is DORMANT: invisible, untargetable by player and workers alike, and reserving
// no work — the fog block above it owns the cell until it is mined away.
function resourceIsActive(node,kind){if(fogAtPoint(node.x,node.y))return false;return kind==="wood"?node.stump<=0:node.depleted<=0;}
// Dust is player-only for now. Every worker path gates loose-drop claims through this predicate.
function workerCanPickupDrop(drop){return drop.kind!=="dust";}
function workerLoad(worker){return RESOURCE_KINDS.reduce((total,kind)=>total+worker.carried[kind],0);}
function clearWorkerTask(worker){
  // One teardown for every claim kind — drops, and a scout's fog-cell reservation, which rides
  // taskTarget exactly like a drop claim so no abandonment path (death, lift, flee, reassignment)
  // can leak it.
  if(worker.taskTarget?.claimedBy===worker)delete worker.taskTarget.claimedBy;worker.taskTarget=null;
}
function clearWorkerSelfSupply(worker){clearWorkerTask(worker);worker.selfSupply=null;}
// ── the free-worker scheduler ───────────────────────────────────────────────
// THE canonical transition into free. Releases every claim and transient task ownership so no
// drop stays reserved by a worker that stopped working it. Free is autonomous by definition:
// the scheduler is the only thing that moves a free worker back into a job.
function releaseWorkerToFree(worker){
  clearWorkerSelfSupply(worker);
  worker.job="free";worker.jobTarget=null;worker.autonomous=true;
  worker.postX=worker.x;worker.postY=worker.y;
  worker.returning=false;worker.starved=false;setWorkerStationArrival(worker,null);worker.guardSafeTime=0;
  // A freed worker holds no cargo: anything still carried becomes physical drops where it stands,
  // so autonomous hauling (its own or a neighbour's) can claim the load through the normal pipeline.
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,worker.x+rand(-8,8),worker.y+rand(-5,5));}
}
const FREE_WORKER_SEARCH_CADENCE=.5;
let nextFreeWorkerSearchAt=0;
function workerIsSchedulable(worker){
  return worker.job==="free"&&!worker.combatTarget&&!worker.retaliationTarget&&!worker.returnAfterCombat&&!worker.fleeing;
}
function freeWorkerBuildCandidate(worker,radius){
  let choice=null,best=Infinity;
  for(const building of buildings){
    if(building.complete||!["wood","stone"].some(kind=>buildNeed(building,kind,worker)>0))continue;
    const occupancy=workerOccupancyStatus(building,worker);
    if(!occupancy||occupancy.assigned>=occupancy.capacity)continue;
    const d=distance(worker.x,worker.y,building.x,building.y);
    if(d<=radius&&d<best){choice=building;best=d;}
  }
  return choice;
}
function haulDestinationFor(drop){
  let choice=null,best=Infinity;
  for(const storage of [...(mainBaseStanding()?[BASE]:[]),...buildings.filter(item=>item.complete&&item.type==="stockpile")]){
    const coverage=distance(storage.x,storage.y,drop.x,drop.y);
    if(coverage>storageServiceRadius(storage))continue;
    // The base obeys its Worker Limit here like every other post: a full base is not an autonomous
    // hauling destination, so the scheduler walks the drop to a stockpile or leaves the worker free.
    const occupancy=workerOccupancyStatus(storage);if(!occupancy||occupancy.assigned>=occupancy.capacity)continue;
    if(coverage<best){choice=storage;best=coverage;}
  }
  return choice;
}
function freeWorkerHaulCandidate(worker,radius){
  let choice=null,best=Infinity;
  for(const drop of resourceDrops){
    if(!workerCanPickupDrop(drop)||drop.target||!drop.ground||targetIsClaimed(drop))continue;
    const d=distance(worker.x,worker.y,drop.x,drop.y);
    if(d>radius||d>=best)continue;
    const storage=haulDestinationFor(drop);
    if(storage){choice={drop,storage};best=d;}
  }
  return choice;
}
function freeWorkerGatherCandidate(worker,radius){
  let choice=null,best=Infinity;
  for(const [nodes,kind] of [[trees,"wood"],[rocks,"stone"],[diamonds,"diamond"]])for(const node of nodes){
    if(!resourceIsActive(node,kind))continue;
    const occupancy=workerOccupancyStatus(node,worker);
    if(occupancy.assigned>=occupancy.capacity)continue;
    const d=distance(worker.x,worker.y,node.x,node.y);
    if(d<=radius&&d<best){choice={node,kind};best=d;}
  }
  return choice;
}
// Fog-mining claims mirror drop claims (targetIsClaimed): stale owners self-heal on read. The
// claim lives on the scout's taskTarget — its jobTarget is the hut it staffs.
function fogIsClaimed(cell){
  const owner=cell.claimedBy;
  if(owner&&(!state.workers.includes(owner)||owner.taskTarget!==cell)){delete cell.claimedBy;return false;}
  return !!owner;
}
/** Only frontier blocks are mineable by workers: at least one cardinal neighbour must be revealed
 * land, so the field is always chewed from the open edge inward, never from an unreachable core. */
function fogCellIsFrontier(cell){
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const cx=cell.cx+dx,cy=cell.cy+dy;
    if(fogByCell.has(fogCellKey(cx,cy)))continue;
    const point=cellToWorld(cx,cy);
    if(terrainAtWorldPoint(point.x,point.y)===LAND)return true;
  }
  return false;
}
function freeWorkerFogCandidate(worker,radius){
  let choice=null,best=Infinity;
  for(const cell of fog){
    if(cell.water)continue;   // walkers never wade out to mine over water
    const d=distance(worker.x,worker.y,cell.x,cell.y);
    if(d>radius||d>=best||fogIsClaimed(cell)||!fogCellIsFrontier(cell))continue;
    choice=cell;best=d;
  }
  return choice;
}
/** Camp/quarry staffing candidate: the nearest completed work building with an open job slot.
 * Durable unlike the one-shot tiers below — a staffed worker keeps the post until the building
 * dies, a muster pulls it away, or the player drags it off. */
function freeWorkerStaffCandidate(worker,radius){
  let choice=null,best=Infinity;
  for(const building of buildings){
    if(!building.complete||!BUILDING_TYPES[building.type].resource)continue;
    const status=workerOccupancyStatus(building,worker);
    if(!status||status.assigned>=status.capacity)continue;
    const d=distance(worker.x,worker.y,building.x,building.y);
    if(d>radius||d>=best)continue;
    choice=building;best=d;
  }
  return choice;
}
/** One tier of the search, strict priority: construction, then hauling, then staffing an open
 * camp/quarry slot, then loose gathering. Hauling outranks staffing so drop piles drain before a
 * worker binds to a durable post; staffing outranks gathering because a staffed post out-produces
 * one-strike harvesting (STAFF_GATHER). */
function assignFreeWorkerWithin(worker,radius){
  const site=freeWorkerBuildCandidate(worker,radius);
  if(site){worker.job="build";worker.jobTarget=site;worker.autonomous=true;worker.postX=site.x;worker.postY=site.y+20;return true;}
  const haul=freeWorkerHaulCandidate(worker,radius);
  if(haul){
    worker.job="haul";worker.jobTarget=haul.storage;worker.autonomous=true;
    const post=haul.storage===BASE?BASE_HAUL_POST:{x:haul.storage.x,y:haul.storage.y+18};
    worker.postX=post.x;worker.postY=post.y;
    // Reserve the chosen drop IMMEDIATELY so two free workers can never pick it in one sweep.
    worker.taskTarget=haul.drop;haul.drop.claimedBy=worker;
    return true;
  }
  const post=freeWorkerStaffCandidate(worker,radius);
  if(post){worker.job="staff";worker.jobTarget=post;worker.autonomous=true;worker.postX=post.x;worker.postY=post.y+16;return true;}
  const gather=freeWorkerGatherCandidate(worker,radius);
  if(gather){worker.job="harvest";worker.jobTarget=gather;worker.autonomous=true;worker.postX=worker.x;worker.postY=worker.y;return true;}
  // Fog is deliberately NOT autonomous work: the scheduler never mints clearfog, so the frontier
  // moves only when the player pushes it — by hand-mining, or by POSTING a worker on a scout hut
  // (workerAssignmentAt), whose staffer then works blocks through updateFogMiner.
  return false;
}
// ── the garrison muster ─────────────────────────────────────────────────────
// Defense is the ONE autonomous job that outranks the economy sweep: a hostile at the door turns
// nearby autonomous workers into garrison guards before build/haul/gather is even considered.
// Everything here reuses the shared station machinery — occupancy stays DERIVED from the workers
// pointing at each garrison, so the muster reserves a slot simply by naming its station.
function livingHostileWithin(x,y,radius){
  for(const enemy of state.enemies)if(enemy.hp>0&&distance(x,y,enemy.x,enemy.y)<=radius)return true;
  return false;
}
/** A manual assignment is the player's standing order: only autonomous workers that are not already
 * guards and are not entangled in combat answer the muster. A worker held for dragging is not in
 * state.workers at all, and the explicit check keeps that true even if the roster ever changes. */
function workerAnswersMuster(worker){
  // Posted scouts never answer for free: a scout-hut posting is a manual standing order
  // (autonomous=false), so the existing manual-assignment rule already keeps them on the frontier.
  return worker.autonomous&&worker.job!=="guard"&&!worker.combatTarget&&!worker.retaliationTarget&&!worker.returnAfterCombat&&!worker.fleeing&&heldWorker()!==worker;
}
function nearestOpenGarrison(worker){
  let choice=null,best=Infinity;
  for(const building of buildings){
    if(!isGuardStation(building))continue;
    const status=workerOccupancyStatus(building,worker);
    if(!status||status.assigned>=status.capacity)continue;
    // Nearest station wins; the strict comparison keeps collection order on an exact-distance tie.
    const d=distance(worker.x,worker.y,building.x,building.y);
    if(d<=GARRISON.musterRadius&&d<best){choice=building;best=d;}
  }
  return choice;
}
/** Take the post. The prior autonomous objective is abandoned safely: every claim is released and
 * the carried load becomes physical drops through the ordinary spawnResource path, so nothing stays
 * reserved behind the worker and the load can re-enter hauling. */
function musterWorkerToGarrison(worker,garrison){
  const post=garrisonPost(garrison);
  // The reservation lands FIRST: derived occupancy counts this worker from here on, so two workers
  // in one sweep can never claim the same slot.
  worker.job="guard";worker.jobTarget=garrison;worker.autonomous=true;
  worker.postX=post.x;worker.postY=post.y;
  worker.returning=false;worker.starved=false;worker.guardSafeTime=0;
  // Arrival is tracked by the shared staffing gate in updateWorker: the guard only counts as posted
  // once it has physically walked to the station. Nothing is granted for the reservation itself.
  setWorkerStationArrival(worker,null);
  clearWorkerSelfSupply(worker);
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,worker.x+rand(-8,8),worker.y+rand(-5,5));}
}
function musterGarrisonGuards(){
  for(const worker of state.workers){
    if(!workerAnswersMuster(worker))continue;
    if(!livingHostileWithin(worker.x,worker.y,GARRISON.threatRadius))continue;
    const station=nearestOpenGarrison(worker);
    if(station)musterWorkerToGarrison(worker,station);
  }
}
/** The other half of the contract. A guard the SCHEDULER posted stands itself down; a guard the
 * player posted never does. A night muster is binding — dawn releases the whole autonomous roster in
 * one transaction (transitionPhase) — so only a quiet day can time a guard out. */
function demobilizeGarrisonGuards(dt){
  for(const worker of state.workers){
    if(worker.job!=="guard"||!worker.autonomous)continue;
    const station=worker.jobTarget;
    // A reservation may never outlive its station, in any phase.
    if(!isGuardStation(station)){releaseWorkerToFree(worker);continue;}
    if(state.clock.phase!=="day"){worker.guardSafeTime=0;continue;}
    // The STATION's defense radius owns the timer, not the guard's wandering position.
    if(livingHostileWithin(station.x,station.y,GARRISON.guardRadius)){worker.guardSafeTime=0;continue;}
    worker.guardSafeTime=(worker.guardSafeTime??0)+dt;
    if(worker.guardSafeTime>=GARRISON.safeSeconds)releaseWorkerToFree(worker);
  }
}
/** Dawn's single auditable transaction: every autonomous garrison guard is released at once, so a
 * night's muster can never quietly become a permanent posting. Manual guards keep their orders, and
 * a worker the player is currently holding keeps its reservation until it is dropped. */
function releaseAutonomousGarrisonGuards(){
  const roster=state.workers.filter(worker=>worker.job==="guard"&&worker.autonomous);
  for(const worker of roster)releaseWorkerToFree(worker);
  if(roster.length)toast("dawn — "+roster.length+" garrison guard"+(roster.length===1?"":"s")+" stood down");
  return roster.length;
}
/** One ordered pass per frame: answer the muster, then time out the quiet posts it created. */
function updateGarrisonPostings(dt){
  if(state.runMode!=="normal")return;
  musterGarrisonGuards();
  demobilizeGarrisonGuards(dt);
}
/** Deterministic sweep on a shared simulated-time cadence: each free worker evaluates its local
 * tier completely before expanding, so nearby hauling beats a distant blueprint. A worker with no
 * candidate in either tier simply stays free — only the garrison muster above converts one to guard. */
function scheduleFreeWorkers(){
  if(state.runMode!=="normal"||state.clock.elapsed<nextFreeWorkerSearchAt)return;
  nextFreeWorkerSearchAt=state.clock.elapsed+FREE_WORKER_SEARCH_CADENCE;
  for(const worker of state.workers){
    if(!workerIsSchedulable(worker))continue;
    for(const radius of [WORKER_LEASH,TUNE.freeSearchRadius])if(assignFreeWorkerWithin(worker,radius))break;
  }
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
// Free workers wear the ordinary tan gatherer coat, alive and as corpses.
function workerCoatColor(worker){return worker.job==="haul"?"#4d7892":worker.job==="build"?"#d29a39":worker.job==="guard"?"#856347":"#d4b079";}
function killWorker(worker){
  const at=state.workers.indexOf(worker);if(at<0)return false;
  clearWorkerSelfSupply(worker);worker.combatTarget=null;worker.retaliationTarget=null;worker.returnAfterCombat=false;worker.fleeing=false;worker.fleeSafeTime=0;
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,worker.x+rand(-7,7),worker.y+rand(-5,5));}
  state.workers.splice(at,1);
  // Snapshot only rendering data: the source slot is free as soon as the mutable worker leaves state.workers.
  workerCorpses.push(Object.freeze({x:worker.x,y:worker.y,coat:workerCoatColor(worker),flip:Math.random()<.5?-1:1,pose:rand(-2,2)}));
  burst(worker.x,worker.y,"#9d493d",9);return true;
}
function workerAttack(worker,enemy){
  worker.combatTarget=enemy;if(worker.attackCooldown>0)return;
  worker.attackCooldown=WORKER_ATTACK_RATE;const alive=damageEnemy(enemy,workerDamage(worker),"#f0cc72",6);sound(310,.05);if(!alive)worker.returnAfterCombat=true;
}
function depositWorkerLoad(worker){
  // Hauling moves already-physical drops; harvesting itself can only call hitResource() and never reaches storage.
  // STORAGE ONLY, deliberately: a hauler at the base credits state.stored and never touches the
  // authored base recipe (deliverToMainBaseRecipe). Spending an upgrade's stone is a decision, so it
  // stays on the player's own release.
  const storage=worker.jobTarget;
  if(storage===BASE)storeAtBase(worker.carried,worker.x,worker.y);
  else{for(const kind of RESOURCE_KINDS){const amount=worker.carried[kind];if(!amount)continue;storage.storage[kind]+=amount;worker.carried[kind]=0;}storage.pulse=1;}
  worker.returning=false;burst(worker.postX,worker.postY,"#e5ce91",5);
}
function storageServiceRadius(storage){return storage===BASE?BASE_ZONE:BUILDING_TYPES[storage.type].serviceRadius;}
function storageStock(storage){return storage===BASE?state.stored:storage.storage;}
function nearestBuildStorage(building,worker){
  let choice=null,best=Infinity,covered=false;
  // Before the base stands the map centre is not storage: builders may only withdraw from stockpiles.
  for(const storage of [...(mainBaseStanding()?[BASE]:[]),...buildings.filter(item=>item.complete&&item.type==="stockpile")]){const d=distance(storage.x,storage.y,building.x,building.y);if(d>storageServiceRadius(storage))continue;covered=true;const stock=storageStock(storage),available=RESOURCE_KINDS.some(kind=>stock[kind]>0&&buildNeed(building,kind,worker)>0);if(available&&d<best){choice=storage;best=d;}}
  return {storage:choice,covered};
}
function buildNeed(building,kind,worker){
  let reserved=0;
  for(const other of state.workers)if(other!==worker&&other.job==="build"&&other.jobTarget===building){
    reserved+=other.carried[kind]+(other.taskTarget?.kind===kind?1:0);
    if(other.selfSupply?.kind===kind&&!other.carried[kind]&&other.taskTarget?.kind!==kind)reserved++;
  }
  return Math.max(0,(buildingCost(building)[kind]||0)-(building.delivered[kind]||0)-reserved);
}
// Completion inheritance is a MANUAL-builder privilege: a player-assigned builder keeps working the
// thing it stood up when the finished building has a durable post with room. Autonomous builders,
// over-capacity builders, and builders of post-less buildings (house/tower/obelisk) return to free.
function inheritBuiltJob(worker,building){
  for(const kind of RESOURCE_KINDS)while(worker.carried[kind]>0){worker.carried[kind]--;spawnResource(kind,building.x+rand(-8,8),building.y+rand(-5,5));}
  clearWorkerSelfSupply(worker);worker.returning=false;worker.starved=false;
  // Capacity is asked of the POST the assignment names, not of the record just finished: they are
  // the same object everywhere except the main base, whose level-1 site hands its builders to the
  // BASE anchor. A base already holding two haulers therefore frees its builders like any full post.
  const assignment=builtJobAssignment(building),post=assignment.jobTarget,occupancy=post?workerOccupancyStatus(post,worker):null;
  if(worker.autonomous||!occupancy||occupancy.assigned>=occupancy.capacity){releaseWorkerToFree(worker);return;}
  Object.assign(worker,assignment);
  worker.autonomous=false;setWorkerStationArrival(worker,null);
}
function resolveBuildingCompletionWorkers(building){
  // Snapshot preserves state.workers order while inheritance mutates the fields used by this filter.
  const builders=state.workers.filter(worker=>worker.job==="build"&&worker.jobTarget===building);
  for(const worker of builders)inheritBuiltJob(worker,building);
}
function nearestBuildDrop(building,worker){
  let nearest=null,best=Infinity;
  for(const resource of resourceDrops){if(!workerCanPickupDrop(resource)||resource.target||targetIsClaimed(resource)||!resource.ground||buildNeed(building,resource.kind,worker)<=0||distance(building.x,building.y,resource.x,resource.y)>TUNE.builderSourceRadius)continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<best){best=d;nearest=resource;}}
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
    if(!workerCanPickupDrop(drop)||!resourceDrops.includes(drop)||drop.target||drop.claimedBy!==worker){clearWorkerTask(worker);return true;}
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
    worker.hitCooldown=WORKER_HIT_COOLDOWN;const firstNewDrop=resourceDrops.length;hitResource(supply.node,supply.kind,true,false,1,workerResourceDamage());
    const drop=resourceDrops[firstNewDrop];invariant(drop?.kind===supply.kind,"self-supply mining did not create its physical drop");drop.claimedBy=worker;worker.taskTarget=drop;
  }
  return true;
}
function updateBuilder(worker,dt){
  const building=worker.jobTarget;
  if(!building||!buildings.includes(building)){releaseWorkerToFree(worker);return;}
  if(building.complete){inheritBuiltJob(worker,building);return;}
  if(workerLoad(worker)>0){
    worker.selfSupply=null;worker.starved=false;if(!moveWorker(worker,building.x,building.y,dt,16))return;
    const cost=buildingCost(building);for(const kind of RESOURCE_KINDS){const amount=Math.min(worker.carried[kind],(cost[kind]||0)-(building.delivered[kind]||0));worker.carried[kind]-=amount;building.delivered[kind]+=amount;handoffParticles(building.x,building.y,kind,amount,worker.x,worker.y);}
    building.pulse=1;
    if(building.type==="mainBase")effects.baseLevelChanged();   // the HUD base bar tracks the level-1 site too
    if(constructionComplete(building))completeBuilding(building);return;
  }
  if(worker.selfSupply&&updateBuilderSelfSupply(worker,building,dt))return;
  if(worker.taskTarget&&(!workerCanPickupDrop(worker.taskTarget)||!resourceDrops.includes(worker.taskTarget)||worker.taskTarget.target||worker.taskTarget.claimedBy!==worker))clearWorkerTask(worker);
  if(worker.taskTarget){
    worker.starved=false;const resource=worker.taskTarget;if(moveWorker(worker,resource.x,resource.y,dt,10)){const at=resourceDrops.indexOf(resource);if(at>=0){worker.carried[resource.kind]++;resourceDrops.splice(at,1);}delete resource.claimedBy;worker.taskTarget=null;}return;
  }
  if(DBG.groundSourcing&&claimBuildDrop(worker,nearestBuildDrop(building,worker)))return;
  const source=nearestBuildStorage(building,worker),storage=source.storage;
  if(!source.covered){if(updateBuilderSelfSupply(worker,building,dt))return;worker.starved=RESOURCE_KINDS.some(kind=>buildNeed(building,kind,worker)>0);moveWorker(worker,worker.postX,worker.postY,dt);return;}
  if(storage){
    worker.starved=false;if(!moveWorker(worker,storage.x,storage.y,dt,storage===BASE?BASE.r-4:18))return;
    const stock=storageStock(storage);let room=workerCarry();for(const kind of RESOURCE_KINDS){const amount=Math.min(room,stock[kind],buildNeed(building,kind,worker));stock[kind]-=amount;worker.carried[kind]+=amount;room-=amount;}if(storage!==BASE)storage.pulse=1;return;
  }
  if(claimBuildDrop(worker,nearestBuildDrop(building,worker)))return;
  if(updateBuilderSelfSupply(worker,building,dt))return;
  worker.starved=RESOURCE_KINDS.some(kind=>buildNeed(building,kind,worker)>0);moveWorker(worker,worker.postX,worker.postY,dt);
}

function spawnFriendlyBrute(x,y){
  friendlyBrutes.push({x:x+24,y:y+24,homeX:BASE.x,homeY:BASE.y,hp:FRIENDLY_BRUTE.hp,max:FRIENDLY_BRUTE.hp,attackCooldown:0,wob:0,combatTarget:null});
  burst(x,y,"#9870c9",24);
}
function damageFriendlyBrute(brute,damage){
  const at=friendlyBrutes.indexOf(brute);if(at<0)return false;
  brute.hp=Math.max(0,brute.hp-damage);addDamageNumber(brute,damage,{tone:"received"});burst(brute.x,brute.y,"#8f5141",6);
  if(brute.hp<=0){friendlyBrutes.splice(at,1);burst(brute.x,brute.y,"#493052",20);toast("friendly Brute fell");return false;}return true;
}
function updateFriendlyBrute(brute,dt){
  brute.attackCooldown-=dt;brute.wob+=dt*5;brute.combatTarget=null;
  let target=null,best=FRIENDLY_BRUTE.guardRadius;
  for(const enemy of state.enemies){if(fogAtPoint(enemy.x,enemy.y))continue;const d=distance(brute.x,brute.y,enemy.x,enemy.y);if(d<best){best=d;target=enemy;}}
  if(!target){const d=distance(brute.x,brute.y,brute.homeX,brute.homeY);if(d>60){const a=Math.atan2(brute.homeY-brute.y,brute.homeX-brute.x);brute.x+=Math.cos(a)*FRIENDLY_BRUTE.speed*dt;brute.y+=Math.sin(a)*FRIENDLY_BRUTE.speed*dt;}return;}
  brute.combatTarget=target;
  if(best>FRIENDLY_BRUTE.range){const a=Math.atan2(target.y-brute.y,target.x-brute.x);brute.x+=Math.cos(a)*FRIENDLY_BRUTE.speed*dt;brute.y+=Math.sin(a)*FRIENDLY_BRUTE.speed*dt;return;}
  if(brute.attackCooldown<=0){brute.attackCooldown=FRIENDLY_BRUTE.rate;damageEnemy(target,FRIENDLY_BRUTE.damage,"#c5a1e8",10);sound(120,.12);}
}

// ── the capture yard ────────────────────────────────────────────────────────
// Converting a carried light enemy is a change of OWNERSHIP, not of stats: the unit keeps its
// authored ENEMY_TYPES record (type, variant, abilities) and its current HP, sheds every
// hostile-only reference — statuses, tower retaliation, wave membership — and joins
// controlledEnemies linked to the yard that turned it.
function captureYardAtPoint(x,y){
  for(const building of buildings){
    if(building.type!=="captureYard")continue;
    const cell=worldToCell(building.x,building.y),rect=footprintWorldRect(cell.cx,cell.cy,buildingFootprint(building.type));
    if(x>=rect.x&&x<rect.x+rect.w&&y>=rect.y&&y<rect.y+rect.h)return building;
  }
  return null;
}
function captureYardOccupancy(yard){return controlledEnemies.reduce((count,unit)=>count+(unit.sourceYard===yard?1:0),0);}
/** Where a fresh convert stands up: the first land point on a ring just outside the yard's own 3x3,
 *  so a capture can never strand the unit on water or inside the footprint art. */
function captureMusterPoint(yard){
  for(let attempt=0;attempt<12;attempt++){
    const angle=attempt*Math.PI/6;
    const x=clamp(yard.x+Math.cos(angle)*64,BUILD_MARGIN,W-BUILD_MARGIN),y=clamp(yard.y+Math.sin(angle)*64,BUILD_MARGIN,H-BUILD_MARGIN);
    if(terrainAtWorldPoint(x,y)===LAND)return {x,y};
  }
  return {x:yard.x,y:yard.y};
}
function captureEnemy(enemy,yard){
  const spot=captureMusterPoint(yard);
  // Deleting waveNightNumber is the wave-accounting exit: a captured scheduled enemy stops gating
  // dawn the moment it turns, exactly like a killed one.
  enemy.status={burn:null,slow:null};enemy.retaliationTower=null;delete enemy.waveNightNumber;
  // A captured bomber defuses: the controlled unit fights as a plain melee ally, never explodes.
  delete enemy.fuse;
  enemy.x=spot.x;enemy.y=spot.y;enemy.sourceYard=yard;enemy.combatTarget=null;enemy.attackCooldown=0;enemy.healCooldown=1;
  controlledEnemies.push(enemy);
  burst(yard.x,yard.y,"#75c86d",24);toast(ENEMY_TYPES[enemy.type].name+" turned — it fights for you now");sound(620,.2);
}
function damageControlledEnemy(unit,damage){
  const at=controlledEnemies.indexOf(unit);if(at<0)return false;
  unit.hp=Math.max(0,unit.hp-damage);addDamageNumber(unit,damage,{tone:"received"});burst(unit.x,unit.y,"#8f5141",6);
  // Death frees the yard slot immediately: occupancy is derived from this collection, so the splice
  // IS the reopening.
  if(unit.hp<=0){controlledEnemies.splice(at,1);burst(unit.x,unit.y,"#3f5741",20);toast("controlled "+ENEMY_TYPES[unit.type].name+" fell");return false;}
  return true;
}
function updateControlledEnemy(unit,dt){
  const def=ENEMY_TYPES[unit.type],yard=unit.sourceYard;
  unit.wob+=dt*7;unit.flash=Math.max(0,unit.flash-dt);unit.shotFlash=Math.max(0,unit.shotFlash-dt);unit.healFlash=Math.max(0,unit.healFlash-dt);unit.attackCooldown-=dt;unit.healCooldown-=dt;unit.combatTarget=null;
  const moveToward=(x,y)=>{const angle=Math.atan2(y-unit.y,x-unit.x);unit.x+=Math.cos(angle)*def.speed*dt;unit.y+=Math.sin(angle)*def.speed*dt;};
  if(def.archetype==="healer"){
    // Allegiance flip of the authored kit: same amount and cadence, but patients come from the
    // allied roster — controlled units and friendly Brutes — never from hostiles.
    let patient=null,best=CAPTURE_YARD.healSearchRadius;
    for(const ally of [...controlledEnemies,...friendlyBrutes]){if(ally===unit||ally.hp>=ally.max)continue;const d=distance(unit.x,unit.y,ally.x,ally.y);if(d<best){best=d;patient=ally;}}
    if(patient){
      if(best>def.range){moveToward(patient.x,patient.y);return;}
      if(unit.healCooldown<=0){unit.healCooldown=def.healRate;patient.hp=Math.min(patient.max,patient.hp+def.healAmount);unit.healFlash=.3;unit.healX=patient.x;unit.healY=patient.y;burst(patient.x,patient.y,"#75c86d",5);}
      return;
    }
  }else{
    // Guard duty is anchored on the SOURCE yard, like a posted guard's leash: hostiles are engaged
    // only while they stand inside the yard's guard radius, with authored range/damage/rate.
    let target=null,best=Infinity;
    for(const enemy of state.enemies){const yardDistance=distance(yard.x,yard.y,enemy.x,enemy.y),d=distance(unit.x,unit.y,enemy.x,enemy.y);if(yardDistance<=CAPTURE_YARD.guardRadius&&d<best){best=d;target=enemy;}}
    if(target){
      unit.combatTarget=target;
      if(best>def.range){moveToward(target.x,target.y);return;}
      if(def.damage&&unit.attackCooldown<=0){unit.attackCooldown=def.rate;unit.shotFlash=.14;unit.shotX=target.x;unit.shotY=target.y;damageEnemy(target,def.damage,"#75c86d",6);sound(def.range>60?520:400,.06);}
      return;
    }
  }
  if(distance(unit.x,unit.y,yard.x,yard.y)>CAPTURE_YARD.homeRadius)moveToward(yard.x,yard.y);
}

// ── the base's own defence ──────────────────────────────────────────────────
// A completed base defends its own ground: nearest visible enemy, on MAIN_BASE's authored range,
// damage and cooldown. It is NOT a tower and deliberately gets none of a tower's SHAPE — no
// variants, no manual fire, no relocation, no ward-totem hp. What it does share is the tower COMBAT
// RULES, and it shares them by reuse rather than restatement: the same fog-gated target funnel
// (eachTowerCombatTarget, via nearestTowerTarget), the same three permanent buffs (towerDamage /
// towerSpeed / towerRange) and the same three auras (War Shrine damage, Haste Totem cooldown, Range
// Beacon range) that towerDamage/towerCooldown/towerAttackRadius already apply by position. Those
// helpers only ever read `x`/`y` off their subject and the numbers off the variant record below, so
// the BASE anchor is a legal subject and base and tower balance can never drift apart.
// `damageTargetType` mirrors the authored row for completeness; nothing reads it on this path,
// because a single-target shot never consults it — eachTowerCombatTarget is what makes the base
// enemies-only, exactly as it does for a basic tower.
const BASE_ATTACK=Object.freeze({damage:MAIN_BASE.damage,cooldown:MAIN_BASE.rate,range:MAIN_BASE.range,damageTargetType:MAIN_BASE.damageTargetType});
function updateBaseAttack(dt){
  const attack=state.baseAttack;
  attack.cooldown=Math.max(0,attack.cooldown-dt);attack.flash=Math.max(0,attack.flash-dt);
  // No base, no defence: during the pre-wave opening the map centre shoots at nothing.
  if(!mainBaseStanding()||attack.cooldown>0)return;
  const target=nearestTowerTarget(BASE,towerAttackRadius(BASE,BASE_ATTACK));
  if(!target)return;
  attack.cooldown=towerCooldown(BASE,BASE_ATTACK);attack.flash=.2;attack.targetX=target.x;attack.targetY=target.y;
  // No `source`: retaliation aggro belongs to towers the enemy can walk over and break. The base is
  // already every enemy's fallback target (selectEnemyTarget), so it needs no taunt of its own.
  damageCombatTarget(target,towerDamage(BASE,BASE_ATTACK),"#efe0a0",5,null);
  sound(260,.05);
}
function updateHazard(building,dt){
  const hazard=building.hazard;hazard.cooldown-=dt;hazard.flash=Math.max(0,hazard.flash-dt);
  if(hazard.cooldown>0)return;
  if(building.type==="tar"){
    const def=BUILDING_TYPES.tar,targets=state.enemies.filter(enemy=>distance(building.x,building.y,enemy.x,enemy.y)<=def.effectRadius);
    if(!targets.length)return;
    hazard.cooldown=def.cooldown;hazard.flash=.12;
    for(const enemy of targets)applySlow(enemy,def.slowDuration,def.slowMultiplier);
    return;
  }
  const enemy=state.enemies.find(item=>distance(building.x,building.y,item.x,item.y)<20);
  if(!enemy)return;
  if(building.type==="landmine"){
    const def=BUILDING_TYPES.landmine;
    applyAreaDamage({centers:[building],radius:def.effectRadius,damage:def.damage,targetType:def.damageTargetType,color:"#e09a3f"});
    for(let i=0;i<28;i++)particles.push({x:building.x,y:building.y,vx:rand(-140,140),vy:rand(-160,20),life:rand(.3,.7),col:i%2?"#d9893d":"#6e5540"});
    building.remove=true;sound(75,.25);
  }else{
    const def=BUILDING_TYPES.spikes;hazard.cooldown=def.cooldown;hazard.flash=.18;damageEnemy(enemy,def.damage,"#c9c2b5",4);
  }
}
/** Walking Brute Boss contacts are simulation events, not renderer callbacks. The renderer uses the
 * same unwrapped `wob * .12` gait and lands at each half-integer, so damage and the visible ground
 * ring stay synchronized even when one update crosses multiple steps. Attack contacts remain the
 * ordinary targeted melee hit and must not also enter this sweep. */
function walkingStompContacts(enemy,def,fromWob,fromX,fromY){
  if(!def.boss||!(def.stompDamage>0)||!(def.stompRadius>0))return;
  const fromPhase=fromWob*.12,toPhase=enemy.wob*.12,firstContact=Math.floor(fromPhase-.5)+1.5;
  for(let contact=firstContact;contact<=toPhase;contact++){
    const progress=(contact-fromPhase)/(toPhase-fromPhase),x=fromX+(enemy.x-fromX)*progress,y=fromY+(enemy.y-fromY)*progress;
    // The boss stomp is the single biggest chunk of enemy-dealt damage in the game and it was VIOLET
    // — the world's magic colour, which read as "a spell went off" rather than "you are being hit".
    // Red, matching the brute's own thump annulus (models/reviewed/enemy-shard.js C.ringHot) and the
    // seams it wears. Literal SWATCH.red2 from render/palette.js: the game layer does not import the
    // render layer (see ENEMY_VARIANT_BANDS above), so the value is copied and named, not imported.
    const result=applyAreaDamage({centers:[{x,y}],radius:def.stompRadius,damage:def.stompDamage,targetType:def.stompDamageTargetType,color:"#d4312a",source:enemy});
    burst(x,y,"#d4312a",18);sound(58,.16);
    if(result.workerDied)toast("worker died — replacement in "+WORKER_SPAWN_TIME+"s");
    if(state.gameOver)return;
  }
}
/** Bomber detonation: removal first (killEnemy owns wave accounting and the dust roll), then the
 * authored target policy runs through the same radial dispatcher as every other area source. */
function detonateBomber(enemy,def){
  const {x,y}=enemy;killEnemy(enemy,false);
  const result=applyAreaDamage({centers:[{x,y}],radius:def.blastRadius,damage:def.damage,targetType:def.damageTargetType,color:"#e0913f",source:enemy});
  for(let i=0;i<24;i++)particles.push({x,y,vx:rand(-150,150),vy:rand(-170,20),life:rand(.3,.7),col:i%2?"#e0913f":"#6e5540"});
  toast(result.workerDied?"worker died — replacement in "+WORKER_SPAWN_TIME+"s":def.name+" exploded");sound(75,.28);
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
function damageTargetFlags(type){
  switch(type){
    case DAMAGE_TARGET_TYPE.ENEMIES_ONLY:return {enemies:true,resources:false,player:false};
    case DAMAGE_TARGET_TYPE.RESOURCES_ONLY:return {enemies:false,resources:true,player:false};
    case DAMAGE_TARGET_TYPE.ENEMIES_RESOURCES:return {enemies:true,resources:true,player:false};
    case DAMAGE_TARGET_TYPE.PLAYER_RESOURCES:return {enemies:false,resources:true,player:true};
    case DAMAGE_TARGET_TYPE.ALL:return {enemies:true,resources:true,player:true};
    default:invariant(false,"unknown damage target type "+type);
  }
}
function insideAnyDamageArea(target,centers,radius){return centers.some(center=>distance(center.x,center.y,target.x,target.y)<=radius);}
function damageResourceAmount(target,kind,amount){
  for(let hit=0;hit<amount&&resourceIsActive(target,kind);hit++)damageResourceTarget(target,kind,false,true);
}
/** Reusable radial damage boundary. Target policy is one closed DAMAGE_TARGET_TYPE; each owned
 * entity is hit at most once even when several source circles overlap. Resources are live mineable
 * nodes (wood, stone, diamond), while player means workers, allied units, towers, and the base. */
function applyAreaDamage({centers,radius,damage,targetType,color="#d25b49",source=null}){
  invariant(Array.isArray(centers)&&centers.length>0&&centers.every(center=>Number.isFinite(center.x)&&Number.isFinite(center.y)),"area damage has invalid centers");
  invariant(Number.isFinite(radius)&&radius>=0&&Number.isInteger(damage)&&damage>0,"area damage has invalid magnitude");
  const flags=damageTargetFlags(targetType),result={hits:0,workerDied:false};
  if(flags.enemies)eachTowerCombatTarget(target=>{if(insideAnyDamageArea(target,centers,radius)){result.hits++;damageCombatTarget(target,damage,color,4,source);}});
  if(flags.resources)for(const [nodes,kind] of [[trees,"wood"],[rocks,"stone"],[diamonds,"diamond"]])for(const node of [...nodes])
    if(resourceIsActive(node,kind)&&insideAnyDamageArea(node,centers,radius)){result.hits++;damageResourceAmount(node,kind,damage);}
  if(!flags.player||state.runMode!=="normal")return result;
  for(const worker of [...state.workers])if(insideAnyDamageArea(worker,centers,radius)){result.hits++;if(source?.combatKind==="enemy"&&state.enemies.includes(source))worker.retaliationTarget=source;addDamageNumber(worker,damage,{tone:"received"});worker.hp=Math.max(0,worker.hp-damage);if(worker.hp<=0)result.workerDied=killWorker(worker)||result.workerDied;}
  for(const brute of [...friendlyBrutes])if(insideAnyDamageArea(brute,centers,radius)){result.hits++;damageFriendlyBrute(brute,damage);}
  for(const unit of [...controlledEnemies])if(insideAnyDamageArea(unit,centers,radius)){result.hits++;damageControlledEnemy(unit,damage);}
  for(const building of [...buildings])if(building.complete&&building.tower?.hp>0&&insideAnyDamageArea(building,centers,radius)){result.hits++;damageTower(building,damage);}
  // A bare anchor has no health to lose: blasts pass straight over the map centre until a base stands.
  if(mainBaseStanding()&&insideAnyDamageArea(BASE,centers,radius)){result.hits++;if(!DBG.invulnBase){addDamageNumber(BASE,damage,{tone:"received"});state.baseHp=Math.max(0,state.baseHp-damage);}state.basePulse=1;if(state.baseHp<=0)endGame();}
  return result;
}
function visitStableTargets(targets,visit){
  for(let i=0;i<targets.length;){const target=targets[i];visit(target);if(targets[i]===target)i++;}
}
function eachTowerCombatTarget(visit){
  // An enemy still inside standing fog is hidden and therefore not a combat subject: towers,
  // meteors and orbs all read this one funnel, so "invisible" and "untargetable" cannot drift.
  if(state.runMode==="normal"){visitStableTargets(state.enemies,enemy=>{if(!fogAtPoint(enemy.x,enemy.y))visit(enemy);});return;}
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
  const tower=building.tower,color=variant.impactColor||variant.accent,damage=towerDamage(building,variant);tower.targetX=target.x;tower.targetY=target.y;tower.flash=.2;
  if(variant.attackMode==="splash"){
    const impactX=target.x,impactY=target.y;tower.impactX=impactX;tower.impactY=impactY;applyAreaDamage({centers:[{x:impactX,y:impactY}],radius:variant.splashRadius,damage,targetType:variant.damageTargetType,color,source:building});burst(impactX,impactY,color,18);
  }else if(variant.attackMode==="line"){
    const range=towerAttackRadius(building,variant),angle=Math.atan2(target.y-building.y,target.x-building.x),endX=building.x+Math.cos(angle)*range,endY=building.y+Math.sin(angle)*range;tower.targetX=endX;tower.targetY=endY;
    eachTowerCombatTarget(enemy=>{if(lineIntersectsEnemy(building.x,building.y,endX,endY,enemy,variant.beamWidth))damageCombatTarget(enemy,damage,color,7,building);});
  }else if(variant.attackMode==="chain"){
    // Full tower damage on every strike; jumps ignore the tower's own range and only obey
    // chainRange, so the bolt may run past the ring the player aimed with — like the buff does.
    const jumps=chainLightningTargets(target.x,target.y,variant.chainJumps,variant.chainRange,new Set([target]),true);
    addLightningArc(building.x,building.y,target.x,target.y);
    damageCombatTarget(target,damage,color,7,building);
    let fromX=target.x,fromY=target.y;
    for(const jump of jumps){addLightningArc(fromX,fromY,jump.target.x,jump.target.y);fromX=jump.target.x;fromY=jump.target.y;damageCombatTarget(jump.target,damage,color,7,building);}
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
  // Reconcile the ward aura before anything reads health this frame (mirrors the worker garrison
  // bonus): a tower placed, moved, or newly covered settles here, so no other path has to.
  syncTowerWard(building);
  if(variant.manual||tower.cooldown>0)return;
  if(variant.attackMode==="periodic area"){
    const result=applyAreaDamage({centers:[building],radius:towerAttackRadius(building,variant),damage:towerDamage(building,variant),targetType:variant.damageTargetType,color:variant.accent,source:building});
    if(result.hits){tower.cooldown=towerCooldown(building,variant);tower.flash=.4;sound(variant.sound,.22);}return;
  }
  const target=nearestTowerTarget(building,towerAttackRadius(building,variant));if(!target)return;tower.cooldown=towerCooldown(building,variant);fireTowerAttack(building,variant,target);
}

function updateGuard(worker,dt){
  // A guard is only ever a garrison's guard. If the station was razed, recalled or never was one,
  // the posting is void and the worker returns to free rather than standing watch over nothing.
  // Showcase guards are inert authored poses with no station and are never updated here.
  if(state.runMode==="normal"&&!isGuardStation(worker.jobTarget)){releaseWorkerToFree(worker);return;}
  // Combat itself is unchanged: the same reach, cadence and retaliation as any worker. Only the
  // effective damage query inside workerAttack knows the guard hits harder once it has arrived.
  let target=null,best=Infinity;
  for(const enemy of state.enemies){const postDistance=distance(worker.postX,worker.postY,enemy.x,enemy.y),d=distance(worker.x,worker.y,enemy.x,enemy.y);if(postDistance<=GARRISON.engagementRadius&&d<best){best=d;target=enemy;}}
  if(target){worker.combatTarget=target;if(moveWorker(worker,target.x,target.y,dt,WORKER_MELEE-2))workerAttack(worker,target);return;}
  moveWorker(worker,worker.postX,worker.postY,dt);
}
/** Where a frightened worker runs. NULL when nothing on the map is safe — before the base stands
 *  the map centre is bare ground, not a refuge, so a pre-wave worker with no tower simply holds. */
function nearestWorkerSafety(worker){
  let safe=null,best=Infinity;
  if(mainBaseStanding()){safe=BASE;best=distance(worker.x,worker.y,BASE.x,BASE.y);}
  for(const building of buildings){if(!building.complete||building.type!=="tower")continue;const d=distance(worker.x,worker.y,building.x,building.y);if(d<best){safe=building;best=d;}}
  return safe;
}
function updateWorkerFlee(worker,dt){
  let danger=false;for(const enemy of state.enemies)if(distance(worker.x,worker.y,enemy.x,enemy.y)<=WORKER_LEASH*1.5){danger=true;break;}
  worker.fleeSafeTime=danger?0:(worker.fleeSafeTime||0)+dt;
  if(worker.fleeSafeTime>=3){worker.fleeing=false;worker.fleeSafeTime=0;worker.retaliationTarget=null;return false;}
  worker.combatTarget=null;worker.retaliationTarget=null;const safe=nearestWorkerSafety(worker);if(safe)moveWorker(worker,safe.x,safe.y,dt);return true;
}
function updateHauler(worker,dt){
  const storage=worker.jobTarget;
  // An autonomous hauler's destination can vanish (a recalled stockpile); it has nothing to wait for.
  if(storage!==BASE&&!buildings.includes(storage)){releaseWorkerToFree(worker);return;}
  const task=worker.taskTarget;
  // Stale claims release the moment a target disappears, is vacuumed away, or lifts off the ground.
  if(task&&(!workerCanPickupDrop(task)||!resourceDrops.includes(task)||task.target||task.claimedBy!==worker))clearWorkerTask(worker);
  if(workerLoad(worker)>=workerCarry())worker.returning=true;
  if(!worker.returning&&!worker.taskTarget){
    let nearest=null,best=Infinity;
    for(const resource of resourceDrops){if(!workerCanPickupDrop(resource)||resource.target||targetIsClaimed(resource)||!resource.ground||distance(storage.x,storage.y,resource.x,resource.y)>storageServiceRadius(storage))continue;const d=distance(worker.x,worker.y,resource.x,resource.y);if(d<best){best=d;nearest=resource;}}
    if(nearest){worker.taskTarget=nearest;nearest.claimedBy=worker;}
    else if(workerLoad(worker)>0)worker.returning=true;
    // One deposited batch is the whole autonomous job: with nothing claimed, nothing carried and
    // nothing left in coverage, the worker is free again rather than idling at the storage post.
    else if(worker.autonomous){releaseWorkerToFree(worker);return;}
  }
  if(worker.returning){
    if(moveWorker(worker,worker.postX,worker.postY,dt,13)){depositWorkerLoad(worker);if(worker.autonomous)releaseWorkerToFree(worker);}
    return;
  }
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
    if(!node||!resourceIsActive(node,kind)){
      // Autonomous gathering is one node, one strike: an objective that dies first resolves to
      // free without producing anything, and the next sweep picks fresh work.
      if(worker.autonomous){releaseWorkerToFree(worker);return;}
      node=nearestWorkerNode(worker,kind);worker.jobTarget={node,kind};
    }
  }else{
    const building=worker.jobTarget;kind=BUILDING_TYPES[building?.type]?.resource;
    if(!building||!buildings.includes(building)||!kind){releaseWorkerToFree(worker);return;}
    node=worker.taskTarget;
    if(!node||!resourceIsActive(node,kind)){node=nearestWorkerNode(worker,kind,building.x,building.y,BUILDING_TYPES[building.type].serviceRadius);worker.taskTarget=node;}
  }
  if(!node){moveWorker(worker,worker.postX,worker.postY,dt);return;}
  if(moveWorker(worker,node.x,node.y,dt,20)&&worker.hitCooldown<=0){
    // The staffed-post advantage: a camp/quarry staffer swings faster and each swing spawns more
    // drops. This margin over one-strike free harvesting is the whole reason to staff the building.
    const staffed=worker.job==="staff";
    worker.hitCooldown=WORKER_HIT_COOLDOWN*(staffed?STAFF_GATHER.cooldownFactor:1);
    hitResource(node,kind,true,false,staffed?STAFF_GATHER.yield:1,workerResourceDamage());
    // Exactly one successful strike, then free: the physical drop it just made can now trigger hauling.
    if(worker.job==="harvest"&&worker.autonomous){releaseWorkerToFree(worker);return;}
    if(!resourceIsActive(node,kind)){if(worker.job==="harvest")worker.jobTarget={node:null,kind};else worker.taskTarget=null;}
  }
}
/** The scout hut's posted staffer, mirroring the camp gatherer's contract: jobTarget is the HUT
 * (the durable post), taskTarget the currently claimed fog block. The scout walks to a block,
 * chips it until it dies, then claims the next nearest frontier block — no radius cap, batch
 * after batch, until the hut falls or the player pulls the worker off. A block cleared or
 * claimed away mid-walk simply re-targets; with no frontier left the scout waits at its post. */
function updateFogMiner(worker,dt){
  const hut=worker.jobTarget;
  if(!hut||!buildings.includes(hut)||!hut.complete||hut.type!=="scoutHut"){releaseWorkerToFree(worker);return;}
  let cell=worker.taskTarget;
  if(!cell||fogByCell.get(fogCellKey(cell.cx,cell.cy))!==cell||(fogIsClaimed(cell)&&cell.claimedBy!==worker)){
    cell=freeWorkerFogCandidate(worker,Infinity);
    worker.taskTarget=cell;
    if(!cell){moveWorker(worker,worker.postX,worker.postY,dt);return;}
  }
  cell.claimedBy=worker;
  if(moveWorker(worker,cell.x,cell.y,dt,24)&&worker.hitCooldown<=0){
    worker.hitCooldown=WORKER_HIT_COOLDOWN;hitFog(cell,true);
  }
}
function updateWorker(worker,dt){
  // Reconcile the fortified kit against the predicate before anything reads health this frame: a
  // station that was razed, recalled or completed out from under the worker settles here, so no
  // other path has to remember to undo the bonus.
  syncWorkerGarrisonBonus(worker);
  worker.step+=dt;worker.hitCooldown-=dt;worker.attackCooldown-=dt;worker.combatTarget=null;
  // The survival threshold scales with effective max HP (1 for a 5 HP worker, 2 for a 10 HP
  // fortified guard) so an even-damage enemy can't step a guard from 2 straight to dead without
  // ever crossing the absolute threshold.
  if(state.runMode==="normal"&&!worker.fleeing&&worker.hp<=TUNE.fleeHpThreshold*workerMaxHp(worker)/WORKER_HP){
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
  // Returning from combat walks back to the recorded post, then the ordinary job update resumes the
  // prior assignment; an autonomous objective that died meanwhile resolves to free on that resume.
  if(worker.returnAfterCombat){clearWorkerTask(worker);if(moveWorker(worker,worker.postX,worker.postY,dt))worker.returnAfterCombat=false;return;}
  const staffingTarget=worker.jobTarget&&workerStaffsPost(worker,worker.jobTarget)&&durablePostStatus(worker.jobTarget)?worker.jobTarget:null;
  if(worker.staffingArrivedAt&&worker.staffingArrivedAt!==staffingTarget)setWorkerStationArrival(worker,null);
  // The arrival edge fires ONCE: the branch is entered only while the gate does not yet name the
  // station, so re-running the update on an arrived guard can never grant the delta a second time.
  if(staffingTarget&&worker.staffingArrivedAt!==staffingTarget){
    if(moveWorker(worker,worker.postX,worker.postY,dt))setWorkerStationArrival(worker,staffingTarget);
    else return;
  }
  if(worker.job==="build")updateBuilder(worker,dt);
  else if(worker.job==="guard")updateGuard(worker,dt);
  else if(worker.job==="haul")updateHauler(worker,dt);
  else if(worker.job==="harvest"||worker.job==="staff")updateGatherer(worker,dt);
  else if(worker.job==="clearfog")updateFogMiner(worker,dt);
  // A free worker with no assignment is INERT at its position: it never runs guard AI, and only the
  // melee self-defense above ever moves it into combat.
  else if(worker.job==="free"){}
  // An unknown or malformed job transitions safely to free — it can never silently become a guard.
  else releaseWorkerToFree(worker);
}

// The day↔night flip: it changes phase identity and owns both phase-boundary side effects. Normal
// dawn calls it from the post-combat clearance check; debugger commands may intentionally force it.
// The pre-wave→day-1 flip is NOT here — it belongs to beginFirstDay(), because it is not a
// boundary the world can reach on its own: only a finished base can end the opening.
function transitionPhase(){
  const clock=state.clock,wave=state.nightWave;
  invariant(clock.phase!=="pre-wave","the pre-wave opening ends by building the base, not by a phase flip");
  if(clock.phase==="day"){
    clock.phase="night";clock.remaining=0;
    // The plan snapshots budget, pool, order, and timing. Leveling mid-wave can only affect the next
    // plan. Calm Night discounts the budget and recomposes before its one-shot flag is consumed.
    let plan=wave.upcomingPlan;
    if(state.draft.calmNight){
      const recipe=NIGHT_WAVE_RECIPES.find(item=>item.id===plan.sourceId);
      const budget=Math.max(1,Math.floor(plan.threatBudget*CARD_CONSUMABLES.calmNightFactor));
      plan=composeSpawnPlan(recipe,plan.waveNumber,{budget});
    }
    state.draft.calmNight=false;wave.activePlan=plan;wave.threatBudget=plan.threatBudget;wave.spawnedThreat=0;
    wave.totalSpawns=plan.entries.length;wave.remainingSpawns=wave.totalSpawns;wave.elapsed=0;wave.nextSpawnAt=plan.entries[0].at;wave.nightNumber++;wave.activeNightNumber=wave.nightNumber;
    // JUICE — dusk had no cue of its own: the border telegraph simply stops and the tint slides in
    // silently. Two descending notes mark the flip, after every phase field above is committed.
    sound(196,.34);sound(131,.52);
  }else{
    // A long day drafted at night is banked here, so the card is never silently wasted.
    clock.phase="day";clock.remaining=DAY_DURATION+state.draft.dayBonus;state.draft.dayBonus=0;clock.completedNights++;
    // THE dawn stand-down, on the real phase boundary and nowhere else: one transaction releases
    // every guard the scheduler mustered during the night. Manual guards keep their posts.
    releaseAutonomousGarrisonGuards();
    wave.activePlan=null;wave.threatBudget=0;wave.spawnedThreat=0;wave.remainingSpawns=0;wave.activeNightNumber=null;
    // Roll the next forecast after the night ends, so the night just survived counts toward waveTier().
    chooseUpcomingNight();
    // Surviving the night earns one permanent-buff pick. A banked base-level reward stays ahead of it.
    queueWaveClearReward();
    // JUICE — and dawn answers dusk, rising where the dusk pair fell. Placed last so the reward
    // queue above is already settled; sound() is a pure output hook either way.
    sound(392,.26);sound(523,.4);
  }
}
function updateClock(dt){
  const clock=state.clock;
  clock.elapsed+=dt;
  // Elapsed run time keeps counting through every phase, including the untimed pre-wave opening: it
  // is how long the player has been playing, not how long the wave clock has been running.
  // Only day owns a countdown — pre-wave has none at all and therefore no way to reach night, and
  // its light target below is the same 0 day uses, so the opening stays fully lit.
  // Clamp before transition so a large or long-running frame can never
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
  const wave=state.nightWave;wave.elapsed+=dt;
  // Plan timestamps are cumulative-threat midpoints: many cheap bodies stream steadily while one
  // expensive enemy occupies proportionally more of the 30-second window.
  while(wave.remainingSpawns>0&&wave.elapsed>=wave.nextSpawnAt&&state.enemies.length<NIGHT_ENEMY_CAP){
    const index=wave.totalSpawns-wave.remainingSpawns,entry=wave.activePlan.entries[index];
    // This is the sole membership writer. spawnEnemy() stays membership-neutral for debugger calls
    // and preserves its command-style undefined return contract.
    spawnEnemy(entry.type);state.enemies[state.enemies.length-1].waveNightNumber=wave.activeNightNumber;
    wave.spawnedThreat+=entry.threatCost;wave.remainingSpawns--;
    wave.nextSpawnAt=wave.remainingSpawns?wave.activePlan.entries[index+1].at:NIGHT_WAVE_WINDOW;
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
// Enemy priority is centralized: Aggro taunt, tower retaliation, nearest worker/base, then any tower
// physically intersecting that route.
// May return NULL. Before the main base stands, an otherwise empty map offers an enemy nothing to
// walk to or hit — the map centre is bare ground, not a health pool. Debug-spawned enemies are the
// only way to be in that situation (waves cannot start during pre-wave), and they idle in place.
function selectEnemyTarget(enemy){
  const canDamage=ENEMY_TYPES[enemy.type].damage>0;
  if(canDamage){
    let aggro=null,bestAggro=Infinity;for(const building of buildings){if(!building.complete||building.type!=="tower"||building.tower.hp<=0)continue;const variant=towerVariant(building),d=distance(enemy.x,enemy.y,building.x,building.y);if(variant.tauntRadius&&d<=variant.tauntRadius&&d<bestAggro){aggro=building;bestAggro=d;}}
    if(aggro)return enemyTargetResult(enemy,"tower",aggro);
    const retaliation=enemy.retaliationTower;if(retaliation&&buildings.includes(retaliation)&&retaliation.complete&&retaliation.tower.hp>0)return enemyTargetResult(enemy,"tower",retaliation);
  }
  enemy.retaliationTower=null;
  let kind=mainBaseStanding()?"base":null,object=mainBaseStanding()?BASE:null,best=mainBaseStanding()?distance(enemy.x,enemy.y,BASE.x,BASE.y):Infinity;
  for(const worker of state.workers){const d=distance(enemy.x,enemy.y,worker.x,worker.y);if(d<best){best=d;kind="worker";object=worker;}}
  for(const brute of friendlyBrutes){const d=distance(enemy.x,enemy.y,brute.x,brute.y);if(d<best){best=d;kind="friendly";object=brute;}}
  for(const unit of controlledEnemies){const d=distance(enemy.x,enemy.y,unit.x,unit.y);if(d<best){best=d;kind="controlled";object=unit;}}
  if(!object)return null;
  if(!canDamage)return enemyTargetResult(enemy,kind,object);
  let blocker=null,bestBlocker=Infinity;for(const building of buildings){if(!building.complete||building.type!=="tower"||building.tower.hp<=0)continue;const d=distance(enemy.x,enemy.y,building.x,building.y);if(d<bestBlocker&&segmentDistance(building.x,building.y,enemy.x,enemy.y,object.x,object.y)<=26){blocker=building;bestBlocker=d;}}
  return blocker?enemyTargetResult(enemy,"tower",blocker):enemyTargetResult(enemy,kind,object);
}
function destroyTower(building){
  const at=buildings.indexOf(building);if(at<0)return;buildings.splice(at,1);for(const enemy of state.enemies){if(enemy.retaliationTower===building)enemy.retaliationTower=null;if(enemy.status?.burn?.source===building)enemy.status.burn=null;}
  for(const worker of state.workers)if(worker.jobTarget===building)releaseWorkerToFree(worker);
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
// Presentation-only countdown shared by every spent node: 1 at the moment of depletion, 0 when the
// renderer's topple/crumble has finished. Decayed here rather than on wall clock so the collapse
// pauses with the sim exactly like `shake` and the meteor rock's `pop` do. Nothing reads it back.
const decayCollapse=(node,dt)=>{if(node.collapse)node.collapse=Math.max(0,node.collapse-dt*1.7);};
function updateResourceNodes(dt){
  for(const tree of trees){tree.shake=Math.max(0,tree.shake-dt*7);decayCollapse(tree,dt);}
  for(const rock of rocks){rock.shake=Math.max(0,rock.shake-dt*7);if(rock.pop)rock.pop=Math.max(0,rock.pop-dt*3);decayCollapse(rock,dt);}
  for(const diamond of diamonds){diamond.shake=Math.max(0,diamond.shake-dt*7);decayCollapse(diamond,dt);}
  for(const cell of fog)if(cell.shake>0)cell.shake=Math.max(0,cell.shake-dt*7);
  updateFogPops();
  for(let i=fogPops.length-1;i>=0;i--){const pop=fogPops[i];pop.age+=dt;if(pop.age>=FOG.popAnimTime)fogPops.splice(i,1);}
  for(const chest of chests)chest.shake=Math.max(0,chest.shake-dt*7);
  const held=heldChest();if(held)held.shake=Math.max(0,held.shake-dt*7);
}
function updateLooseResources(dt,expire){
  let recalled=null;
  for(let i=resourceDrops.length-1;i>=0;i--){
    const drop=resourceDrops[i];
    if(expire&&drop.ttl!==null&&!drop.target&&!drop.claimedBy){drop.ttl-=dt;if(drop.ttl<=0){resourceDrops.splice(i,1);continue;}}
    drop.spin+=dt*4;
    if(drop.target==="hand"||drop.target==="base"){
      drop.t+=dt*(drop.target==="base"?2.8:7);const ease=1-Math.pow(1-clamp(drop.t,0,1),3),tx=drop.target==="base"?BASE.x:state.mouse.x,ty=drop.target==="base"?BASE.y:state.mouse.y;
      drop.x+=(tx-drop.x)*ease*.35;drop.y+=(ty-drop.y)*ease*.35;
      if(drop.t>=1){resourceDrops.splice(i,1);if(drop.target==="base"){recalled??=resourceCounts();recalled[drop.kind]++;}else state.carried[drop.kind]++;}continue;
    }
    drop.vy+=170*dt;drop.x+=drop.vx*dt;drop.y+=drop.vy*dt;
    if(drop.y>=drop.groundY){drop.y=drop.groundY;drop.vx*=.72;drop.vy*=-.22;if(Math.abs(drop.vy)<10){drop.vy=0;drop.vx=0;drop.ground=true;}}
  }
  // All arrivals from this simulation step become one atomic deposit: one stored-stock credit
  // and one toast.
  if(recalled)storeAtBase(recalled,BASE.x,BASE.y);
}
function updateTemporaryBuilding(building,dt,active=true){
  if(building.orbs){
    const orbs=building.orbs;orbs.remaining-=dt;orbs.angle+=dt*2.4;orbs.cooldown-=dt;
    if(active&&orbs.cooldown<=0){
      orbs.cooldown=DAMAGE_ORBS.cooldown;
      const held=heldBuilding()===building&&state.mouse.inside,x=held?state.mouse.x:building.x,y=held?state.mouse.y:building.y;
      const centers=Array.from({length:orbs.count},(_,i)=>{const a=orbs.angle+i*Math.PI*2/orbs.count;return {x:x+Math.cos(a)*DAMAGE_ORBS.orbitRadius,y:y+Math.sin(a)*DAMAGE_ORBS.orbitRadius};});
      applyAreaDamage({centers,radius:DAMAGE_ORBS.aoeRadius,damage:DAMAGE_ORBS.damage,targetType:DAMAGE_ORBS.damageTargetType,color:"#8fd9ee"});
    }
    return orbs.remaining<=0;
  }
  if(building.summoning){building.summoning.remaining-=dt;return building.summoning.remaining<=0;}
  return false;
}
function updateBuildings(dt,includeHazards){
  for(const building of buildings){building.pulse=Math.max(0,building.pulse-dt*3);if(building.complete&&building.tower)updateTower(building,dt);if(includeHazards&&building.complete&&building.hazard)updateHazard(building,dt);if(includeHazards&&updateTemporaryBuilding(building,dt))building.remove=true;}
  if(includeHazards)for(let i=buildings.length-1;i>=0;i--)if(buildings[i].remove){const expired=buildings.splice(i,1)[0];burst(expired.x,expired.y,"#77638f",10);}
  const held=heldBuilding();
  if(held?.tower)updateTower(held,dt);
  // Damage orbs remain active around the cursor while carried; other temporary deployables only
  // age in hand and resume their active effect after placement.
  if(includeHazards&&held&&updateTemporaryBuilding(held,dt,held.type==="damageOrbs")){state.heldObject=null;burst(held.x,held.y,"#77638f",10);toast(BUILDING_TYPES[held.type].name+" expired");}
}
// The camera-rattle channel. Any impact may call addScreenShake(0..1); scene.js reads
// state.screenShake in placeCamera(). Max, not overwrite, so a small kick landing during a big
// rattle never cuts it short. Decay is sim-owned (below), so the rattle pauses with the sim.
function addScreenShake(amount){state.screenShake=Math.max(state.screenShake,clamp(amount,0,1));}
function updateScreenShake(dt){state.screenShake=Math.max(0,state.screenShake-dt/.6);}
function updateFallingMeteors(dt){
  for(let i=fallingMeteors.length-1;i>=0;i--){
    const m=fallingMeteors[i];m.t+=dt;
    if(m.t>=m.dur){fallingMeteors.splice(i,1);meteorImpact(m.x,m.y);continue;}
    // Descending whistle faked from the one-blip audio API: a blip every .13s whose pitch follows
    // the fall's p^2 easing, so it sinks slowly on entry and dives just before touchdown.
    if(m.t>=(m.nextBlip??0)){const p=m.t/m.dur;sound(1350-1050*p*p,.09);m.nextBlip=m.t+.13;}
  }
}
function updateFallingFireballs(dt){
  for(let i=fallingFireballs.length-1;i>=0;i--){
    const f=fallingFireballs[i];f.t+=dt;
    if(f.t>=f.dur){fallingFireballs.splice(i,1);fireballImpact(f.x,f.y);continue;}
    if(f.t>=(f.nextBlip??0)){const p=f.t/f.dur;sound(1050-650*p*p,.07);f.nextBlip=f.t+.11;}
  }
}
function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;if(p.resource){const q=1-p.life/p.max;p.x+=(p.tx-p.x)*q*.28;p.y+=(p.ty-p.y)*q*.28;}else{p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=80*dt;}if(p.life<=0)particles.splice(i,1);}
}
function updateDamageNumbers(dt){
  // Renderer owns configurable lifetime; retain past its maximum slider range, then it can decide opacity.
  for(let i=damageNumbers.length-1;i>=0;i--){damageNumbers[i].age+=dt;if(damageNumbers[i].age>5)damageNumbers.splice(i,1);}
  for(let i=lightningArcs.length-1;i>=0;i--){lightningArcs[i].age+=dt;if(lightningArcs[i].age>.4)lightningArcs.splice(i,1);}
}
function updateNormal(dt){
  // A pending draft freezes the world on its own flag: the player's pause may be on or off under it.
  if(state.gameOver||state.paused||state.draftPaused){stopPrimaryClick();return;}
  updatePrimaryClick(dt);updateClock(dt);updateNightEnemyWave(dt);updateCamera(dt);
  // Coins fund draft rerolls (DRAFT_REROLL), so the wandering spawn is deliberately scarce:
  // one every ~45s-2.7min keeps a reroll a treat, not an allowance.
  state.coinTimer-=dt;if(state.coinTimer<=0){spawnCoin();state.coinTimer=rand(45,160);}
  for(const enemy of [...state.enemies]){
    if(!updateEnemyStatuses(enemy,dt))continue;
    const def=ENEMY_TYPES[enemy.type],fromWob=enemy.wob,fromX=enemy.x,fromY=enemy.y;
    enemy.wob+=dt*7;enemy.flash=Math.max(0,enemy.flash-dt);enemy.shotFlash=Math.max(0,enemy.shotFlash-dt);enemy.healFlash=Math.max(0,enemy.healFlash-dt);enemy.attackCooldown-=dt;enemy.healCooldown-=dt;
    if(def.archetype==="healer"&&enemy.healCooldown<=0){
      let patient=null,best=150;
      for(const ally of state.enemies){if(ally===enemy||ally.hp>=ally.max)continue;const dd=distance(enemy.x,enemy.y,ally.x,ally.y);if(dd<best){best=dd;patient=ally;}}
      if(patient){patient.hp=Math.min(patient.max,patient.hp+def.healAmount);enemy.healFlash=.3;enemy.healX=patient.x;enemy.healY=patient.y;burst(patient.x,patient.y,"#75c86d",5);}
      enemy.healCooldown=def.healRate;
    }
    // May be NULL before the base stands (selectEnemyTarget): nothing on the map is worth walking to.
    const target=selectEnemyTarget(enemy);
    // Bomber: a lit fuse commits in place — it neither moves nor retargets, blinks through the
    // ordinary hit-flash channel, and detonates as its death. A lit fuse is resolved BEFORE the
    // no-target exit below, so an armed bomber always goes off. Unlit, it chases like everyone else
    // (shared movement below) and never reaches the swing branch because arming `continue`s.
    if(def.archetype==="bomber"){
      if(enemy.fuse!==undefined){
        // No flash writes here: the renderer reads `fuse` directly and owns the blink.
        enemy.fuse-=dt;
        if(enemy.fuse<=0){detonateBomber(enemy,def);if(state.gameOver)break;}
        continue;
      }
      if(target&&target.distance<=def.range){enemy.fuse=def.fuseTime;sound(940,.07);continue;}
    }
    // Nothing to march on: the enemy idles in place (statuses, wobble and cooldowns above still
    // tick) instead of crashing on an absent base or besieging bare ground.
    if(!target)continue;
    if(target.distance>def.range){
      const angle=Math.atan2(target.y-enemy.y,target.x-enemy.x),speedMultiplier=enemy.status.slow?.multiplier??1;enemy.x+=Math.cos(angle)*def.speed*speedMultiplier*dt;enemy.y+=Math.sin(angle)*def.speed*speedMultiplier*dt;
      walkingStompContacts(enemy,def,fromWob,fromX,fromY);if(state.gameOver)break;
    }
    else if(def.damage&&enemy.attackCooldown<=0){
      enemy.attackCooldown=def.rate;enemy.shotFlash=.14;enemy.shotX=target.x;enemy.shotY=target.y;
      let workerDied=false;
      if(target.kind==="worker"){const worker=target.object;worker.retaliationTarget=enemy;addDamageNumber(worker,def.damage,{tone:"received"});worker.hp=Math.max(0,worker.hp-def.damage);if(worker.hp<=0)workerDied=killWorker(worker);}
      else if(target.kind==="friendly")damageFriendlyBrute(target.object,def.damage);
      else if(target.kind==="controlled")damageControlledEnemy(target.object,def.damage);
      else if(target.kind==="tower")damageTower(target.object,def.damage);
      // invulnerable base (debug) is checked at the damage site: the hit still lands,
      // flashes and toasts, it just subtracts nothing. baseHp/baseMax are never inflated.
      else{if(!DBG.invulnBase){addDamageNumber(BASE,def.damage,{tone:"received"});state.baseHp=Math.max(0,state.baseHp-def.damage);}state.basePulse=1;if(state.baseHp<=0){endGame();break;}}
      toast(workerDied?"worker died — replacement in "+WORKER_SPAWN_TIME+"s":def.name+" hit "+(target.kind==="worker"?"a worker":target.kind==="friendly"?"the friendly Brute":target.kind==="controlled"?"a controlled "+ENEMY_TYPES[target.object.type].name:target.kind==="tower"?towerVariant(target.object).name:"the base"));sound(def.range>60?180:95,.09);
    }
  }
  if(state.gameOver)return;
  updateBaseAttack(dt);updateTransientTimers(dt);updateResourceNodes(dt);updateLooseResources(dt,true);
  // Ordering is the contract: garrison mustering resolves BEFORE the ordinary build/haul/gather
  // sweep, so a worker with a hostile at its back takes the post instead of picking up a job.
  updateWorkerSpawns(dt);updateBuildings(dt,true);updateGarrisonPostings(dt);scheduleFreeWorkers();
  for(const worker of state.workers)updateWorker(worker,dt);
  for(const brute of [...friendlyBrutes])updateFriendlyBrute(brute,dt);
  for(const unit of [...controlledEnemies])updateControlledEnemy(unit,dt);
  for(const building of buildings)if(!building.complete){const builders=state.workers.filter(worker=>worker.job==="build"&&worker.jobTarget===building);building.starved=builders.length>0&&builders.every(worker=>worker.starved);}
  updateFallingMeteors(dt);updateFallingFireballs(dt);updateScreenShake(dt);updateParticles(dt);updateDamageNumbers(dt);
  // Stable completion point: scheduled spawning plus every kill-capable stage (player/status/enemy,
  // the base, towers, hazards, workers) has finished. The phase flip makes this condition false before
  // any later frame, so transitionPhase() owns exactly one dawn reward.
  if(state.clock.phase==="night"&&state.nightWave.remainingSpawns===0&&livingActiveWaveEnemies()===0){
    // TEMPORARY win condition: clearing WIN_WAVE ends the run instead of dawning. See data.js.
    if(state.nightWave.activeNightNumber>=WIN_WAVE&&!state.continuedAfterVictory)winGame();
    else transitionPhase();
  }
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
  updateBuildings(dt,false);updateFallingMeteors(dt);updateFallingFireballs(dt);updateScreenShake(dt);updateParticles(dt);updateDamageNumbers(dt);effects.afterUpdate();
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
// Victory rides the gameOver flag for every input/update guard; `victory` only picks the endcard.
function winGame(){
  if(state.gameOver)return;
  state.gameOver=true;state.victory=true;stopGameplayInput(true);cancelHeldObject();closeUpgradeMenu();
  effects.victory();sound(880,.5);
}
// Victory pauses on the cleared final night. Continuing dismisses that terminal state, records the
// choice so later waves cannot reopen victory, then uses the ordinary night→day transaction.
function continueAfterVictory(){
  if(!state.gameOver||!state.victory)return false;
  invariant(state.clock.phase==="night"&&state.nightWave.remainingSpawns===0&&livingActiveWaveEnemies()===0,"victory continued before its wave cleared");
  state.gameOver=false;state.victory=false;state.continuedAfterVictory=true;effects.victoryContinued();
  transitionPhase();toast("the base endures — exploration continues");return true;
}

function burst(x,y,col,count){for(let i=0;i<count;i++)particles.push({x,y,vx:rand(-55,55),vy:rand(-90,-25),life:rand(.3,.7),col});}

// ── juice emitters ──────────────────────────────────────────────────────────
// Same particle record burst() pushes ({x,y,vx,vy,life,col} + an optional `size` the renderer reads
// as a scale multiplier), on the fx stream instead of the gameplay one. Nothing in this module ever
// READS a particle, so these are pure output: adding, removing or retuning a call below cannot
// change a single simulated outcome.
/** Chunky debris: a burst() with authorable spread/lift/lifetime and per-piece size. */
function fxDebris(x,y,col,count,{spread=70,lift=110,drop=25,life=[.35,.85],size=1,jitter=0}={}){
  for(let i=0;i<count;i++)particles.push({
    x:x+fxRand(-jitter,jitter),y:y+fxRand(-jitter,jitter),
    vx:fxRand(-spread,spread),vy:fxRand(-lift,drop),life:fxRand(life[0],life[1]),col,
    size:size*fxRand(.7,1.35)});
}
/** Ground-hugging dust: pieces fired OUTWARD around a ring with almost no lift, so a landing or a
 *  collapse reads as floor dust kicked sideways rather than another upward spark shower. */
function fxDustRing(x,y,col,count,{radius=16,speed=70,life=[.35,.8],size=1.1,rise=18}={}){
  for(let i=0;i<count;i++){
    // Even angular spacing with a small wobble: a ring that reads as a ring even at low counts.
    const a=(i/count)*Math.PI*2+fxRand(-.35,.35),v=speed*fxRand(.55,1);
    particles.push({x:x+Math.cos(a)*radius*fxRand(.2,1),y:y+Math.sin(a)*radius*fxRand(.2,1)*.6,
      vx:Math.cos(a)*v,vy:Math.sin(a)*v*.5-fxRand(0,rise),life:fxRand(life[0],life[1]),col,
      size:size*fxRand(.75,1.3)});
  }
}
/** The "something heavy just took the ground here" signature, sized to the footprint it reserves:
 *  a dust ring on the pad's edge plus a few chips off the middle. Shared by blueprint placement,
 *  relocation and completion so all three land in the same visual language. */
function fxGroundThump(x,y,footprint=FOOTPRINT_1x1,col="#9a8763"){
  const radius=footprint.w*CELL/2;
  fxDustRing(x,y,col,8+footprint.w*3,{radius:radius*.85,speed:50+footprint.w*11,life:[.3,.72]});
  fxDebris(x,y,col,4,{spread:54,lift:80,jitter:radius*.45,size:.9});
}

function towerRadius(building){return towerAttackRadius(building,towerVariant(building));}

function chopTarget(){
  const m = state.mouse;
  if(!m.inside) return null;
  // Same sticky-first order as updatePrimaryClick, so the badge follows the locked target.
  return stickyChopAction() || resolvePrimaryAction(m.x,m.y);
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
  // ── leftClick()'s order: blast, manual tower, obelisk menu, stockpile pull ──
  const blast = buildings.find(b=>b.complete && b.type==="blast" && blastButtonHit(b,m.x,m.y));
  if(blast) return blast;
  const manualTower = buildings.find(b=>b.complete && b.type==="tower" && towerVariant(b).manual && manualTowerButtonHit(b,m.x,m.y));
  if(manualTower) return manualTower;
  const obelisk = buildings.find(b=>b.complete && b.type==="obelisk" && upgradeButtonHit(b,m.x,m.y));
  if(obelisk) return obelisk;
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
  // Same stock every base deposit credits (storeAtBase); builders withdraw from it.
  for(const kind of kinds) state.stored[kind]+=DEBUG_GRANT;
  state.basePulse=1; toast("granted "+DEBUG_GRANT+" "+kinds.join(" + ")); sound(520,.08);
}
/** Queue one reward of a named kind through the SAME queue the game uses, so the offer, the pool it
 *  draws from and the pick all behave exactly as a played run's would. Replaces the deleted
 *  debugGrantXp: there is no player level to force any more, only a reward to deal. */
function debugQueueDraft(kind="base"){
  if(state.runMode!=="normal")return false;
  if(kind==="base")queueBaseLevelReward();
  else if(kind==="dawn")queueWaveClearReward();
  else if(kind==="consumable")queueConsumableRewards(1);
  else return false;
  return true;
}
/** Drop live and queued rewards without changing which cards the Card Pull has already given. */
function debugClearDraft(){rewardDraft.discardRewards();syncRewardDraft();}
/** Deal one card straight into the hand, skipping the offer entirely. Run state only: the catalog,
 *  its pool flags and every authored table are untouched, and the dealt card behaves exactly like a
 *  drafted one — it goes through addToHand(), and a kit carries its authored charges. */
function debugDealCard(id){
  const card=cardById[id];
  if(!card||!["consumable","build"].includes(card.category))return false;
  addToHand(id);return true;
}
/** Apply one stack of an implemented buff through the same effect path drafting uses. DEBUG ONLY:
 * repeated calls may stack even though the finite Card Pull gives each buff once. */
function debugApplyBuff(id){
  const card=cardById[id];
  if(!card||card.category!=="buff")return false;
  return applyBuff(id);
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
/** The one refusal every phase command shares: the pre-wave opening has no clock to move, and its
 *  only exit is a finished base (beginFirstDay). Skipping the opening is debugRaiseMainBase's job. */
function preWaveBlocksPhaseCommand(){
  if(state.clock.phase!=="pre-wave")return false;
  toast("build the main base first — the wave clock has not started");return true;
}
/** Phase buttons all go through transitionPhase(), never through clock.phase, so the
 *  night wave setup, chooseUpcomingNight() and the day-side forecast reset all run. */
function debugGoToPhase(phase){
  if(preWaveBlocksPhaseCommand())return;
  if(state.clock.phase!==phase) transitionPhase();
  effects.phaseHudChanged();
}
function debugAdvancePhase(){ if(preWaveBlocksPhaseCommand())return; transitionPhase(); effects.phaseHudChanged(); }
/** Skip the opening: raise the base site and stand it up as if its wood had been delivered, through
 *  the real path (raiseMainBaseSite + completeBuilding), so baseLevel, the pre-wave exit and every
 *  invariant are exactly the production ones. It pays NO draft, like every other free-cost
 *  completion, and it spends the opening card if the hand still holds it. Refuses once a base stands. */
function debugRaiseMainBase(){
  if(state.runMode!=="normal"||mainBaseStanding())return false;
  if(!mainBaseSite()&&!raiseMainBaseSite())return false;
  const site=mainBaseSite();
  if(site)completeBuilding(site,{free:true});
  const card=handEntry("bpMainBase");
  if(card)consumeHandCopy(card);
  return true;
}
/** Start a freshly composed plan from the chosen authored pool. Force night through the real
 * transition first, retain that night's snapshotted budget, then make its first spawn immediately
 * due. Neither the authored recipe nor the ordinary upcoming plan is modified. */
function debugStartWave(id){
  const recipe=NIGHT_WAVE_RECIPES.find(item=>item.id===id);if(!recipe)return;
  if(preWaveBlocksPhaseCommand())return;
  if(state.clock.phase!=="night")transitionPhase();
  const wave=state.nightWave,plan=composeSpawnPlan(recipe,wave.nightNumber,{budget:wave.threatBudget,immediateFirst:true});
  wave.activePlan=plan;wave.threatBudget=plan.threatBudget;wave.spawnedThreat=0;
  wave.totalSpawns=plan.entries.length;wave.remainingSpawns=wave.totalSpawns;wave.elapsed=0;wave.nextSpawnAt=0;
  effects.phaseHudChanged();toast("debug threat pool: "+recipe.id);
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
  for(const building of [...buildings,heldBuilding()]) if(building?.tower){ const maxHp=towerMaxHp(towerVariant(building)); building.tower.ward=false; building.tower.maxHp=maxHp; building.tower.hp=maxHp; }
  for(const worker of state.workers) worker.hp=workerMaxHp(worker);
  const held=heldWorker(); if(held) held.hp=workerMaxHp(held);
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
export function primaryPress(){if(state.heldObject)return;const action=resolvePrimaryAction(state.mouse.x,state.mouse.y);if(action?.target?.combatKind==="damage-dummy")state.showcaseFocus=action.target;leftClick();if(!effects.isModalOpen())startPrimaryClick();}
export function primaryRelease(){ stopPrimaryClick(); }

// ── the secondary (right) action ──
// Cancel placement first, then pick an eligible unit/deployable up, and only then start vacuuming:
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
// Debug-tunable zoom bounds (R panel "camera / sun" mutates this holder in place, same pattern
// as scene.js's `view`). Shipped clamp is [.1, 5]; clamp:false frees the wheel entirely for
// scale experiments — the .01 floor stays even then, because zoom divides halfW/halfH above and
// a zero would blow the projection. Presentation-only: nothing in the sim reads these bounds.
export const ZOOM_LIMITS={min:.1,max:5,clamp:true};
export function zoomCameraBy(factor){
  const camera=state.camera, z=camera.zoom*factor;
  camera.zoom=ZOOM_LIMITS.clamp?clamp(z,ZOOM_LIMITS.min,ZOOM_LIMITS.max):Math.max(.01,z);
}
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
  // Tower variants now come only from build cards. Keep this command-level guard as well as
  // removing the click target, so another UI cannot accidentally restore direct tower upgrading.
  if(kind==="tower"){toast("tower variants come from build cards");return false;}
  if(building.activeUpgrade){toast("finish the active upgrade by depositing resources");return false;}
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
 * clears it.
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

/** Perf/debug census of simulation-owned records. `total` includes short-lived particles and damage
 * numbers because they still consume update/render work; the named fields explain the useful load. */
export function simulationEntityDiagnostics(){
  const resourceNodes=trees.length+rocks.length+diamonds.length;
  const transients=particles.length+damageNumbers.length+workerCorpses.length;
  const total=resourceNodes+grass.length+resourceDrops.length+chests.length+buildings.length+friendlyBrutes.length+controlledEnemies.length+
    state.workers.length+state.enemies.length+damageDummies.length+showcaseProps.length+transients;
  return {total,workers:state.workers.length,enemies:state.enemies.length,friendlies:friendlyBrutes.length,controlled:controlledEnemies.length,buildings:buildings.length,
    resourceNodes,drops:resourceDrops.length,transients};
}
/** The live offer as one to three card ids, or null when no draft is pending. Never mutate it. */
export function draftPending(){return rewardDraft.current()?.cardIds||null;}
/** Pending pool — "base", "dawn", or "consumable" — or null. Same offer, same pick. */
export function draftKind(){return rewardDraft.current()?.kind||null;}
/** Read-only Card Pull ledger. `remaining` includes cards still locked by prerequisites; `eligible`
 * names what each reward kind could deal now. */
export function cardPullStatus(){return rewardDraft.pull();}
/**
 * Take card `index` (0-2) of the pending offer. Routes the card through takeCard() — a buff applies,
 * a consumable or build goes to the hand — consumes the offer and, if more rewards are queued,
 * deals the next one immediately, so the world stays frozen until the queue drains. Refusals are
 * silent, so a UI may call this on any click without pre-checking.
 */
export function chooseDraft(index){
  const id=rewardDraft.choose(index);
  if(!id)return false;
  invariant(takeCard(id),"Reward Draft chose an unfulfillable card: "+id);
  syncRewardDraft();
  return true;
}
/** What the reroll button reads: the flat coin price and every coin the run can reach (banked
 * stock plus the cursor hand — the two pools spendCoins() draws from, stored first). */
export function rerollState(){return {cost:DRAFT_REROLL.coinCost,coins:state.stored.coin+state.carried.coin};}
function spendCoins(amount){
  if(state.stored.coin+state.carried.coin<amount)return false;
  const fromStored=Math.min(state.stored.coin,amount);
  state.stored.coin-=fromStored;state.carried.coin-=amount-fromStored;
  return true;
}
/**
 * Replace the live offer for DRAFT_REROLL.coinCost gold. RewardDraft draws alternatives first and
 * reuses rejected cards only to fill a short batch. No alternative means refusal before payment.
 */
export function rerollDraft(){
  if(state.runMode!=="normal")return false;
  const result=rewardDraft.reroll(state.stored.coin+state.carried.coin);
  if(!result.changed){
    if(result.reason==="no-alternative")toast("nothing else to offer");
    else if(result.reason==="insufficient-coins")toast("reroll needs "+DRAFT_REROLL.coinCost+" gold coin");
    return false;
  }
  invariant(spendCoins(result.cost),"Reward Draft accepted a reroll the run could not pay for");
  sound(880,.09);syncRewardDraft();
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
  if(state.gameOver||state.paused||state.draftPaused||state.buildMode||state.cardTargeting||state.heldObject)return false;
  const entry=state.hand[index],card=cardById[entry.id];
  if(!card)return false;
  // An anchored build (the main base) commits in one call: it either raises its site and spends the
  // card, or refuses and leaves the hand untouched. Nothing is armed, so there is no ghost to cancel.
  const anchored=ANCHORED_BUILD_CARDS[entry.id];
  if(anchored){if(!anchored())return false;consumeHandCopy(entry);return "applied";}
  if(TARGETED_CARDS[entry.id])return beginCardTargeting(entry);
  const effect=CARD_EFFECTS[entry.id];
  if(!effect)return false;                  // a held card with no effect is a catalog bug, not a click
  effect();toast("played: "+card.text);sound(700,.16);consumeHandCopy(entry);
  return "applied";
}
/** What the held-action timer is currently filling, or null. Read-only peek. */
export function heldChopTarget(){ return chopState.target; }
/** Is the primary button down right now? */
export function primaryHeld(){ return state.primaryClick.held; }

export {
  // live collections — iterate, never mutate
  state, trees, rocks, diamonds, grass, fog, fogPops, resourceDrops, chests, buildings, friendlyBrutes, controlledEnemies, damageDummies, showcaseProps, workerCorpses, particles, damageNumbers, lightningArcs, fallingMeteors, fallingFireballs,
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
  vegetationMetadata, fogMetadata, fogAtPoint, footprintFogFree, clearAllFog,
  // costs and progress
  buildingCost, costText, upgradeList, towerUpgradeList, nextHouseCost,
  // world lookups the render layer projects
  storageServiceRadius, workerAssignmentAt, heldWorker, heldEnemy, heldBuilding, heldChest, heldProp,
  captureYardOccupancy,
  workerOccupancyStatus, workerOccupancyAt, durablePostStatus,
  workerCoatColor, workerLoad, carriedTotal, resourceIsActive,
  // read-only effective health for presentation; every mutation of it stays inside this module
  workerMaxHp,
  waveTier, waveThreatBudget, livingActiveWaveEnemies, buffStacks,
  // the effective vacuum reach, buffs included — the drawn ring should read this, not TUNE alone
  vacuumRadius,
  // shared numeric helpers (defined here, so nothing restates them)
  clamp, distance, rand,
  // commands that are plain gameplay functions rather than input adapters
  togglePause, cancelBuildMode, clampCamera, stopGameplayInput, cancelHeldObject, continueAfterVictory,
  spawnEnemy, transitionPhase,
  // the main base: the one predicate every base service and the renderer ask, and the read-only
  // authored-progression view the overlay and the draft copy project
  mainBaseStanding, mainBaseStatus,
  // debug commands (view panel > gameplay)
  debugGrant, debugQueueDraft, debugClearDraft, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase, setWaveThreatCurve,
  debugStartWave, debugClearEnemies, debugHealAll, debugDealCard, debugApplyBuff, debugClearHand,
  debugRaiseMainBase,
};
