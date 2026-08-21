// Owns immutable gameplay definitions. DOM-free leaf read by simulation, grid, render, and showcase data.
// Mutable run/debug values remain with their owning simulation or render modules.

// ── frame and world dimensions ──────────────────────────────────────────────
export const VIEW_W=960,VIEW_H=540;          // Fixed 16:9 logical frame; CSS scales both axes together.
// World size in 1536×1024 tiles. buildStarterWorld() crops a centered subsection of the full
// authored starter map to match — a size lever, not a second authored world. This is the one URL
// read outside main.js: W/H must exist at import time, before any composition code runs.
// Defaults: the PLAYABLE game boots the small 1-tile map; the showcase keeps the full canvas its
// fixture layout is authored on, and off-browser harnesses (validate.mjs, tools) keep the full map
// their expectations are pinned to. An explicit ?mapSize=1..5 always wins over both.
// Any tile count keeps BASE=W/2 on a cell center (768k = 24k·CELL), so the grid alignment notes
// below hold at every size.
export const MAP_TILES=(()=>{
  const search=new URLSearchParams(globalThis.location?.search??"");
  const raw=Number(search.get("mapSize"));
  if(Number.isInteger(raw)&&raw>=1&&raw<=5)return raw;
  return globalThis.location&&search.get("mode")!=="showcase"?1:5;
})();
export const W=1536*MAP_TILES,H=1024*MAP_TILES;

// ── the base ────────────────────────────────────────────────────────────────
// Authored anchor, radius and reserved footprint. Not run state: base HEALTH is
// state.baseHp/baseMax in simulation.js, and nothing ever writes x/y/r/footprint.
// Its anchor is already a cell center, so the 3x3 is symmetric around it. The base reserves cells
// exactly like a placed building - no keep-out circle, no special case in canPlace().
// `footprint` is attached below, once FOOTPRINT_3x3 exists; nothing else ever writes this object.
export const BASE = {x:W/2,y:H/2,r:43};
export const BASE_ZONE=600;
// Buildable world = the map inset by this much on every side. Read by canPlace() in simulation.js.
export const BUILD_MARGIN=45;

// ── Placement grid ──
// One shared lattice for every placeable object. This module owns its numbers; grid.js owns the math
// over them; the simulation and rendering only consume both.
// CELL is measured in simulation pixels, the same space as W/H, BASE, mouse, and building x/y.
// Origin is shifted back by half a cell so cell CENTERS land on exact multiples of CELL. That keeps
// BASE (3840,2560 = 120·CELL, 80·CELL) sitting precisely on a cell center, so the base stays a valid
// alignment reference for anything snapped to the grid.
// Map-edge treatment: because of that half-cell shift the first and last column/row are HALF cells
// clipped by the world border - cell (0,*) spans x∈[-16,16] and cell (48,*) spans x∈[1520,1552],
// with centers exactly on x=0 and x=W. They remain addressable (worldToCell never returns a
// negative index for an in-world point) but are never fully inside the world, so
// footprintInWorldBounds() rejects them. Fully-interior cells are cx∈[1,239], cy∈[1,159] (239x159).
export const CELL=32;
export const GRID_ORIGIN_X=-CELL/2,GRID_ORIGIN_Y=-CELL/2;   // world coords of cell (0,0)'s top-left corner
export const GRID_COLS=W/CELL+1,GRID_ROWS=H/CELL+1;         // 241 x 161 addressable cells, edge ones half-clipped

// ── Footprint ownership ──
// Written by: the literals below and the BUILDING_TYPES / world-node definitions that reference them.
// Read by:    the grid helpers in grid.js, canPlace() in simulation.js, and the Three.js layer.
// Format:     {w,h} in CELLS, always ODD so half-extents are whole cells and a model can stay
//             centered on its anchor cell. Anchor coordinates are always the CENTER cell.
// Rule:       dimensions live here only - rendering must read footprint.w/h, never restate a size.
export const FOOTPRINT_1x1=Object.freeze({w:1,h:1});
export const FOOTPRINT_3x3=Object.freeze({w:3,h:3});
export const RESOURCE_FOOTPRINT=FOOTPRINT_1x1;              // trees, rocks and diamonds each occupy one cell
BASE.footprint=FOOTPRINT_3x3;

// ── resources ───────────────────────────────────────────────────────────────
// Standard node health is also total yield: every hit removes one HP and creates one resource.
export const RESOURCE_NODE_HP=Object.freeze({wood:25,stone:18,diamond:13});
// Mineable fog of war: every cell beyond clearRadius of the base — land, coast and open water —
// starts under a destructible fog block.
// Mining a block to death also pops its neighbourhood, staggered popDelay seconds per cell of
// distance — the cascade is the payoff feel. The 3x3 core always pops; cells beyond it out to
// popRadius pop with popEdgeChance, so every clearing gets an organic ragged rim. Buffs are
// expected to grow popRadius later. marginCells extends the field that far beyond every world
// edge (over open water) so no bare ground or sea shows at the rim; must stay under 64 (see
// fogCellKey's padding).
// Block health is keyed to BFS ring depth from the starting clearing (cells per ring band), not
// raw radius, so the ramp feels identical in every direction on the wide map; open water is a
// flat premium instead — shoreline water still falls to land-side cascades for free, but
// hand-carving into deep sea is deliberately expensive.
// popAnimTime: seconds a cleared block spends on its inflate-then-collapse death tween.
// loot: independent roll per cleared LAND block — a rare buried chest (falls back to a coin when
// the revealed cell is blocked), else maybe a coin or dust. Cascade pops roll too; that slot-pull
// is the point.
export const FOG=Object.freeze({clearRadius:560,marginCells:24,
  ringTiers:Object.freeze([Object.freeze({rings:12,hp:1}),Object.freeze({rings:30,hp:2}),Object.freeze({rings:55,hp:4})]),farHp:6,waterHp:8,
  popRadius:2,popEdgeChance:.55,popDelay:.07,popAnimTime:.22,
  loot:Object.freeze({chestChance:.003,coinChance:.05,dustChance:.015})});
// Canonical kind order. Every per-kind record (carried, stored, storage, delivered,
// upgrade costs) is keyed by these names, and iteration order here is the order
// costs, tallies and grants are read in.
export const RESOURCE_KINDS=["wood","stone","dust","coin","diamond"];
// One nearby unopened chest is seeded with the world. Breaking any chest opens a pick-1-of-3
// consumable draft; chests hold no pre-rolled runtime contents.
export const CHEST=Object.freeze({
  startingCount:1,
  maxHp:4,
  footprint:FOOTPRINT_1x1,
  discoverMinRadius:128,
  discoverMaxRadius:352,
  // World chest scatter (authored-map.js): scatterPerTile*MAP_TILES chests land on the free land
  // cells with the lowest deterministic hashes outside the discover band — exploration loot that
  // scales with map size (3 on the default 1-tile map, 15 on the full map), editor untouched.
  scatterPerTile:3,
});
// Per-unit XP value of each resource in a completed building's cost. Construction completion is
// the ONLY XP source (grantXp in simulation.js): depositing at the base just stores resources.
// Read only by simulation.js; no runtime path may assign into this table.
export const RESOURCE_XP={wood:1,stone:1,dust:5,coin:5,diamond:12};
// THE level curve: going from level n to n+1 costs base*growth**n xp. docs/progression-spec.js
// re-exports this table, so the design docs and the game can never quote different numbers.
export const LEVEL_CURVE={base:6,growth:1.19};
export const SKILL_POINT_LEVELS=4;   // placeholder cadence: one skill point per this many levels

// Closed target policy shared by every authored damage source. Callers choose one supported
// combination rather than passing ad-hoc booleans that silently invent friendly-fire semantics.
export const DAMAGE_TARGET_TYPE=Object.freeze({
  ENEMIES_ONLY:"enemies-only",
  RESOURCES_ONLY:"resources-only",
  ENEMIES_RESOURCES:"enemies-resources",
  PLAYER_RESOURCES:"player-resources",
  ALL:"all",
});

// ── draft card numbers ──────────────────────────────────────────────────────
// Per-stack buff magnitudes and consumable payouts for the catalog in cards.js, which owns the
// ids, rarities, texts and stack limits but none of the arithmetic. Read only by simulation.js;
// no runtime path may assign into these tables — a taken card tallies a stack in run state and
// the accessors layer these numbers over the authored values at read time.
export const CARD_BUFFS={clickSpeed:1.12,critChance:.1,critMultiplier:3,freeHitChance:.15,handCarry:2,vacuumRadius:15,workerSpeed:1.12,workerCarry:1,buildCapacity:1,towerDamage:1.1,towerSpeed:1.1,towerRange:50,baseHp:5,clickDamage:1,
  deathTreeChance:.25,deathExplosionDamage:3,deathExplosionRadius:64,deathExplosionTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY,
  // Chain lightning scales BOTH dials per stack: stack N procs a completed player swing at
  // chainChance+(N-1)*chainChanceStack and throws chainJumps+(N-1) jumps — 20%/1, 30%/2, 40%/3,
  // 50%/4 at the card's 4-stack cap. A jump is a full ordinary swing (its own crit roll) on the
  // nearest unstruck enemy OR resource within chainRange of the previous strike.
  chainChance:.2,chainChanceStack:.1,chainJumps:1,chainRange:120};
export const CARD_CONSUMABLES={woodBundle:20,stoneBundle:15,dustBundle:3,longDay:20,calmNightFactor:.75};
// The fireball card's cast: an instant area hit that leaves nothing behind. The radius matches the
// blast charge's effectRadius on purpose — the cast borrows the blast placement ghost, so the ring
// the player aims with IS the area this damages.
export const FIREBALL={damage:6,radius:135,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY};
// Intentional large-obstacle tuning: the impact reserves 3x3 through meteorTarget and the rock's
// runtime footprint; its fixed 15 HP keeps the spell-created obstacle durable without inheriting
// ordinary stone-node balance.
// fallTime is gameplay, not garnish: damage resolves only when the fall completes, so enemies can
// walk into (or out of) the blast during the descent.
export const METEOR=Object.freeze({damage:20,radius:180,rockHp:15,fallTime:.9,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_RESOURCES});
export const DAMAGE_ORBS=Object.freeze({duration:30,minCount:1,maxCount:3,orbitRadius:52,aoeRadius:38,damage:1,cooldown:.6,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_RESOURCES});
export const SUMMONING_CIRCLE=Object.freeze({duration:120,dustCost:5});
// Rerolling the live draft offer costs gold coins — this is coin's primary sink now that feeding
// is gone (the shock tower's 1-coin cost is the only other). Read by rerollDraft() in simulation.js.
export const DRAFT_REROLL=Object.freeze({coinCost:1});
export const FRIENDLY_BRUTE=Object.freeze({hp:36,damage:5,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY,speed:34,range:34,rate:1.1,guardRadius:360});
// Capture Yard conversion rules. Combat stats are NOT here on purpose: a controlled enemy keeps its
// authored ENEMY_TYPES record, so this table only owns what the yard itself decides — how many
// living allies one completed yard supports, how far from the yard they engage hostiles, how close
// they idle to it, and how far a controlled healer looks for wounded allies.
export const CAPTURE_YARD=Object.freeze({capacity:3,guardRadius:300,homeRadius:70,healSearchRadius:150});
// Garrison rules. The BUILDING_TYPES row below owns what every building owns — name, cost, footprint,
// construction and job slots — and this table owns everything GUARD-specific, so no other module may
// restate a guard number: how many workers one garrison can hold (capacity, which IS its job-slot
// count), how near a hostile must come to call the muster (threatRadius), how far that call reaches
// for workers (musterRadius), how far a posted guard detects and pursues hostiles from its post
// (engagementRadius), how far station threats prevent daytime stand-down (guardRadius), how many
// threat-free daylight seconds demobilize it (safeSeconds), and the stats an arrived guard fights
// with (maxHp/damage). The garrison itself creates no workers and has no attack.
export const GARRISON=Object.freeze({capacity:3,musterRadius:300,threatRadius:180,engagementRadius:400,guardRadius:180,safeSeconds:10,maxHp:10,damage:2,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY});

// ── houses and workers ──────────────────────────────────────────────────────
// The first house prices the deliberate hand-played opening chapter: the player chops ~5 wood
// personally before automation exists. Later houses retain the escalating progression below.
export const HOUSE_SLOTS=2,STARTING_HOUSE_COST={wood:5,stone:0},HOUSE_COST={wood:3,stone:1},HOUSE_COST_ESCALATION={wood:4,stone:3},WORKER_SPAWN_TIME=12;
// Resource-node capacity is global because nodes have no type table. Construction capacity belongs
// to each BUILDING_TYPES row below and is modified only when read for the current run.
export const RESOURCE_NODE_JOB_SLOTS=1;
export const WORKER_LEASH=150,WORKER_MELEE=24,WORKER_SPEED=52,WORKER_HP=5,WORKER_DAMAGE=1,WORKER_ATTACK_RATE=.9,WORKER_HIT_COOLDOWN=2,WORKER_CARRY=3;
// The staffed-post advantage (owner rates, Aug 20): a free worker's ceiling is 1 resource per
// 2s (WORKER_HIT_COOLDOWN, further slowed by reassignment overhead); a camp/quarry staffer
// strikes at half the cooldown for a clean 1 per second. Both knobs are read only by
// updateGatherer in simulation.js.
export const STAFF_GATHER=Object.freeze({cooldownFactor:.5,yield:1});

// ── buildings ───────────────────────────────────────────────────────────────
// Every entry carries an explicit `footprint` (odd cells, anchor-centered). Work camps, the
// houses, tower chassis, capture yards, and tar pits are persistent 3x3s; ordinary buildings/deployables
// are 1x1 (the summoning circle and meteor target are temporary/instant 3x3s). Tower VARIANTS inherit the chassis footprint -
// upgrading never resizes an already-placed tower, so variants deliberately declare no footprint.
// `buildSlots` is construction staffing capacity; material totals >=12 use three builders. Every
// row owns a number, including zero for instant/target-only records that never become blueprints.
// `jobSlots` independently controls permanent staffing after completion; absence means zero.
export const BUILDING_TYPES = {
  // Work buildings, not sources: camps/quarries grow nothing (renewable growth deleted Aug 20).
  // Their whole value is jobSlots working WILD nodes inside serviceRadius at the STAFF_GATHER
  // rate, so placement beside a real forest/rockfield is the decision being made.
  lumber:{name:"lumber camp",resource:"wood",cost:{wood:8,stone:2},buildSlots:2,serviceRadius:155,jobSlots:2,footprint:FOOTPRINT_3x3},
  quarry:{name:"quarry",resource:"stone",cost:{wood:4,stone:8},buildSlots:3,serviceRadius:155,jobSlots:2,footprint:FOOTPRINT_3x3},
  stockpile:{name:"stockpile",resource:null,cost:{wood:2,stone:0},buildSlots:2,serviceRadius:175,jobSlots:2,footprint:FOOTPRINT_1x1},
  // The house model remains centered in its anchor cell; its yard reserves the surrounding eight.
  house:{name:"house",resource:null,cost:HOUSE_COST,buildSlots:2,footprint:FOOTPRINT_3x3},
  rangeBeacon:{name:"range beacon",resource:null,cost:{wood:4,stone:6},buildSlots:2,effectRadius:128,rangeBonus:50,footprint:FOOTPRINT_1x1},
  warShrine:{name:"war shrine",resource:null,cost:{wood:5,stone:7},buildSlots:2,effectRadius:128,damageBonus:1,footprint:FOOTPRINT_1x1},
  // The other two aura supports. wardTotem grants a real hp pool (granted/removed by
  // syncTowerWard in simulation.js, never below 1 hp on removal); hasteTotem multiplies
  // towerCooldown. Neither stacks with copies of itself, matching the shrine/beacon rule.
  wardTotem:{name:"ward totem",resource:null,cost:{wood:3,stone:8},buildSlots:2,effectRadius:128,hpBonus:10,footprint:FOOTPRINT_1x1},
  hasteTotem:{name:"haste totem",resource:null,cost:{wood:5,stone:6,dust:2},buildSlots:2,effectRadius:128,cooldownFactor:.8,footprint:FOOTPRINT_1x1},
  obelisk:{name:"obelisk",resource:null,cost:{wood:5,stone:12},buildSlots:3,footprint:FOOTPRINT_1x1},
  tower:{name:"basic tower",resource:null,cost:{wood:6,stone:10},buildSlots:3,footprint:FOOTPRINT_3x3},
  captureYard:{name:"capture yard",resource:null,cost:{wood:8,stone:8},buildSlots:3,footprint:FOOTPRINT_3x3},
  // The garrison's jobSlots ARE its guard slots, so the count is read from GARRISON.capacity rather
  // than restated here. Guard stats, radii and the muster timing all live in that record.
  garrison:{name:"garrison",resource:null,cost:{wood:6,stone:6},buildSlots:2,jobSlots:GARRISON.capacity,footprint:FOOTPRINT_1x1},
  blast:{name:"blast charge",resource:null,cost:{wood:0,stone:0},buildSlots:0,effectRadius:135,damage:3,innerDamage:5,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY,instant:true,footprint:FOOTPRINT_1x1},
  spikes:{name:"spike trap",resource:null,cost:{wood:0,stone:0},buildSlots:0,damage:2,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY,cooldown:.55,instant:true,stack:true,footprint:FOOTPRINT_1x1},
  landmine:{name:"land mine",resource:null,cost:{wood:0,stone:0},buildSlots:0,effectRadius:65,damage:8,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY,instant:true,stack:true,footprint:FOOTPRINT_1x1},
  tar:{name:"tar pit",resource:null,cost:{wood:0,stone:0},buildSlots:0,effectRadius:48,damage:0,cooldown:.25,slowDuration:2,slowMultiplier:.5,instant:true,stack:true,footprint:FOOTPRINT_3x3},
  damageOrbs:{name:"damage orbs",resource:null,cost:{wood:0,stone:0},buildSlots:0,effectRadius:DAMAGE_ORBS.orbitRadius+DAMAGE_ORBS.aoeRadius,instant:true,movable:true,footprint:FOOTPRINT_1x1},
  summoningCircle:{name:"summoning circle",resource:null,cost:{wood:0,stone:0},buildSlots:0,instant:true,movable:true,footprint:FOOTPRINT_3x3},
  meteorTarget:{name:"meteor impact",resource:null,cost:{wood:0,stone:0},buildSlots:0,effectRadius:METEOR.radius,instant:true,targetOnly:true,footprint:FOOTPRINT_3x3}
};
export const UPGRADES=[
  {id:"hardness",icon:"⛏",name:"click hardness",cost:{wood:5,stone:5},description:"placeholder: mine tougher resources with each click."},
  {id:"power",icon:"✊",name:"click power",cost:{wood:8,stone:4},description:"placeholder: increase the power of manual gathering."},
  {id:"hands",icon:"☝",name:"hand size",cost:{wood:6,stone:6},description:"placeholder: increase your carrying capacity."},
  {id:"magnet",icon:"⌁",name:"auto collect",cost:{wood:10,stone:8},description:"placeholder: pull nearby loose resources toward you."},
  {id:"storage",icon:"▣",name:"building storage",cost:{wood:12,stone:5},description:"placeholder: increase stockpile storage and organization."},
  {id:"fuel",icon:"▰",name:"worker fuel",cost:{wood:7,stone:10},description:"placeholder: let gathering workers operate faster."},
  {id:"autoClick",icon:"↻",name:"steady hand",cost:{wood:9,stone:7},description:"steadier swings: gathering and attacking take 45% less time to land."}
];
// Tower chassis state selects one definition here; update, input, range UI, and cooldown UI read no duplicated stats.
const towerVariantRows={
  basic:{icon:"⌂",name:"basic tower",family:"Starter",description:"steady single-target defense; chassis for one permanent variant.",cost:{},attackMode:"single",range:180,damage:1,cooldown:1.3,maxHp:10,manual:false,movable:false,accent:"#d7c36d",sound:260},
  turret:{icon:"⌖",name:"turret",family:"Starter",description:"cheapest choice; compact gun with a modest single-target improvement.",cost:{wood:2,stone:2},attackMode:"single",range:165,damage:2,cooldown:1.2,maxHp:12,manual:false,movable:false,accent:"#d8b06a",sound:290},
  outpost:{icon:"▣",name:"outpost",family:"Starter",description:"durable early generalist with balanced range, damage, and cadence.",cost:{wood:5,stone:7},attackMode:"single",range:220,damage:3,cooldown:1.25,maxHp:45,manual:false,movable:false,accent:"#c9b88d",sound:250},
  watch:{icon:"»",name:"watch tower",family:"Ballistics",description:"low-damage twin guns fire rapidly into nearby light enemies.",cost:{wood:6,stone:8},attackMode:"single",range:195,damage:1,cooldown:.35,maxHp:18,manual:false,movable:false,accent:"#e3c260",sound:390},
  sniper:{icon:"◎",name:"sniper tower",family:"Ballistics",description:"extreme-range burst deletes light enemies but reloads slowly.",cost:{wood:8,stone:10,diamond:1},attackMode:"single",range:430,damage:8,cooldown:3.2,maxHp:12,manual:false,movable:false,accent:"#d9e3c2",sound:620},
  brick:{icon:"▦",name:"brick tower",family:"Ballistics",description:"armored rapid-fire tower built to sustain pressure.",cost:{wood:5,stone:14,dust:2},attackMode:"single",range:210,damage:1,cooldown:.4,maxHp:80,manual:false,movable:false,accent:"#b9654f",sound:350},
  aggro:{icon:"!",name:"aggro tower",family:"Ballistics",description:"extreme health and long-range taunt traded for negligible damage.",cost:{stone:16,dust:2},attackMode:"single",range:180,damage:1,cooldown:3,maxHp:160,tauntRadius:320,manual:false,movable:false,accent:"#d04f43",sound:150},
  fire:{icon:"♨",name:"fire tower",family:"Elemental",description:"direct hits ignite targets for timed damage after impact.",cost:{wood:5,stone:8,dust:2},attackMode:"burn",range:190,damage:1,cooldown:1.4,burnDamage:1,burnDuration:3,burnInterval:.75,maxHp:18,manual:false,movable:false,accent:"#ef7b3f",impactColor:"#ef6a32",sound:180},
  freeze:{icon:"❄",name:"freeze tower",family:"Elemental",description:"rapid hits apply a short movement slow.",cost:{wood:7,stone:9,dust:2},attackMode:"slow",range:215,damage:1,cooldown:.55,slowDuration:1.5,slowMultiplier:.65,maxHp:24,manual:false,movable:false,accent:"#8fd9ee",impactColor:"#8fd9ee",sound:560},
  tarTower:{icon:"≋",name:"tar tower",family:"Elemental",description:"low damage applies a stronger, longer ranged slow.",cost:{wood:4,stone:9,dust:3},attackMode:"slow",range:230,damage:1,cooldown:1.8,slowDuration:3.5,slowMultiplier:.4,maxHp:24,manual:false,movable:false,accent:"#6d5843",impactColor:"#5b4637",sound:110},
  teleport:{icon:"↶",name:"teleport tower",family:"Control",description:"damages one enemy and pushes it toward its recorded spawn edge.",cost:{stone:10,dust:3,diamond:1},attackMode:"push",range:225,damage:2,cooldown:2.2,pushDistance:110,maxHp:20,manual:false,movable:false,accent:"#7396e8",impactColor:"#7396e8",sound:680},
  bomb:{icon:"●",name:"bomb tower",family:"Special",description:"slow shells damage groups clustered around the selected target.",cost:{wood:8,stone:10,dust:2},attackMode:"splash",range:210,damage:3,cooldown:2.6,splashRadius:55,maxHp:16,manual:false,movable:false,accent:"#e39a3f",impactColor:"#e38a38",sound:80},
  laser:{icon:"╱",name:"laser tower",family:"Special",description:"a focused beam pierces every enemy intersecting its line.",cost:{stone:10,dust:3,diamond:2},attackMode:"line",range:320,damage:2,cooldown:1.7,beamWidth:18,maxHp:16,manual:false,movable:false,accent:"#78e3df",impactColor:"#78e3df",sound:720},
  pulse:{icon:"◉",name:"pulse tower",family:"Special",description:"automatically strikes every enemy in its pulse radius.",cost:{wood:4,stone:6,dust:2},attackMode:"periodic area",effectRadius:145,damage:2,cooldown:5,maxHp:20,manual:false,movable:false,accent:"#b18be5",sound:125},
  lightning:{icon:"ϟ",name:"lightning tower",family:"Special",description:"a bolt strikes the nearest enemy and chains between nearby foes.",cost:{stone:8,dust:3,diamond:1},attackMode:"chain",range:240,damage:2,cooldown:2.1,chainJumps:3,chainRange:110,maxHp:16,manual:false,movable:false,accent:"#a9c4f5",impactColor:"#cfe4ff",sound:660},
  shock:{icon:"↯",name:"shock tower",family:"Special",description:"movable tower with a manually triggered reusable shock pulse.",cost:{wood:2,stone:4,coin:1,diamond:1},attackMode:"manual area",effectRadius:150,damage:2,cooldown:8,maxHp:15,manual:true,movable:true,accent:"#70d8d1",sound:105}
};
// Every tower damage path is hostile-only, including direct, line, chain, splash, and radial modes.
export const TOWER_VARIANTS=Object.freeze(Object.fromEntries(Object.entries(towerVariantRows).map(([id,row])=>[id,Object.freeze({...row,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY})])));

// ── enemies and the night schedule ──────────────────────────────────────────
// Variants are authored fixed-stat enemies, never runtime stat multipliers. Every archetype has the
// same three visual/difficulty bands: base, blue veteran (wave 4+), red elite (wave 7+).
const ENEMY_ARCHETYPES={
  raider:{hp:3,speed:52,damage:2,damageTargetType:DAMAGE_TARGET_TYPE.PLAYER_RESOURCES,range:40,rate:1,size:1,weightTag:"light",threatCost:1,spawnWeight:10},
  archer:{hp:4,speed:42,damage:1,damageTargetType:DAMAGE_TARGET_TYPE.PLAYER_RESOURCES,range:155,rate:1.8,size:1,weightTag:"light",threatCost:2,spawnWeight:6},
  healer:{hp:5,speed:38,damage:0,damageTargetType:DAMAGE_TARGET_TYPE.PLAYER_RESOURCES,range:180,rate:0,healAmount:2,healRate:2.3,size:1,weightTag:"light",threatCost:3,spawnWeight:2},
  // Bomber: fast light kamikaze. `range` is the fuse-arm distance, not a swing reach: inside it the
  // fuse lights and fuseTime later it detonates, dealing `damage` to every player-side target within
  // blastRadius; the detonation is the unit's death. `rate` exists only for the controlled
  // (captured) unit, which fights as an ordinary slow melee ally instead of exploding.
  bomber:{hp:3,speed:60,damage:5,damageTargetType:DAMAGE_TARGET_TYPE.PLAYER_RESOURCES,range:46,rate:2.5,size:.9,fuseTime:.9,blastRadius:70,weightTag:"light",threatCost:2,spawnWeight:5},
  brute:{hp:12,speed:28,damage:5,damageTargetType:DAMAGE_TARGET_TYPE.PLAYER_RESOURCES,range:43,rate:1.4,size:1.35,weightTag:"heavy",threatCost:4,spawnWeight:3}
};
const ENEMY_VARIANT_BANDS=Object.freeze([
  Object.freeze({suffix:"",label:"",tier:1,minWave:1,hp:1,speed:1,damage:1,rate:1,cost:1,weight:1,color:null}),
  Object.freeze({suffix:"Veteran",label:"veteran ",tier:2,minWave:4,hp:1.6,speed:1.08,damage:1.5,rate:.9,cost:2,weight:.4,color:"#3568a8"}),
  Object.freeze({suffix:"Elite",label:"elite ",tier:3,minWave:7,hp:2.5,speed:1.15,damage:2.5,rate:.8,cost:4,weight:.2,color:"#a23e50"})
]);
const enemyVariants={};
for(const [archetype,base] of Object.entries(ENEMY_ARCHETYPES))for(const band of ENEMY_VARIANT_BANDS){
  const id=archetype+band.suffix;
  enemyVariants[id]=Object.freeze({...base,name:band.label+archetype,archetype,variantTier:band.tier,variantColor:band.color,minWave:band.minWave,
    hp:Math.ceil(base.hp*band.hp),speed:Math.round(base.speed*band.speed),damage:Math.ceil(base.damage*band.damage),
    rate:base.rate===0?0:Number((base.rate*band.rate).toFixed(2)),...(base.healAmount?{healAmount:Math.ceil(base.healAmount*band.damage),healRate:Number((base.healRate*band.rate).toFixed(2))}:{}),
    threatCost:base.threatCost*band.cost,spawnWeight:base.spawnWeight*band.weight});
}
// One authored boss for now: brute behavior/model, but a 4× render/collision scale and fixed boss
// stats. It is not a weighted variant; WAVE_BOSS_SPAWNS authors every scheduled appearance.
enemyVariants.bruteBoss=Object.freeze({...ENEMY_ARCHETYPES.brute,name:"brute boss",archetype:"brute",boss:true,variantColor:null,minWave:5,
  // The 4× model's visible ground ring reaches about 200 simulation pixels. Every walking contact
  // uses that same radius. Owner nerf Aug 20: hp halved 500→250, melee swing 60→10 — the boss is
  // pressure and presence, not an instant base-delete.
  hp:250,damage:10,stompDamage:10,stompRadius:200,stompDamageTargetType:DAMAGE_TARGET_TYPE.PLAYER_RESOURCES,size:ENEMY_ARCHETYPES.brute.size*4,modelScale:4,threatCost:20,spawnWeight:1});
export const ENEMY_TYPES=Object.freeze(enemyVariants);
// Each wave owns an ordered forced-boss list. Wave 10 is the current finale: three bosses close it.
export const WAVE_BOSS_SPAWNS=Object.freeze({
  5:Object.freeze(["bruteBoss"]),
  10:Object.freeze(["bruteBoss","bruteBoss","bruteBoss"]),
});
// Enemies spawn at a random angle on a ring around the base (small radial jitter in
// simulation.js), preferring land. No directional/shoreline spawning.
export const ENEMY_SPAWN_RADIUS=800;
export const ENEMY_POOL=Object.freeze(["raider","raider","archer","healer","bomber","brute"]);
export const NIGHT_WAVE_WINDOW=30,NIGHT_ENEMY_CAP=30,NIGHT_TELEGRAPH_TIME=8;
// Clearing this wave opens victory. The player may restart or continue into uncapped later waves.
export const WIN_WAVE=10;
// Normalized power curve: wave 1 starts at startBudget, targetWave reaches targetBudget, and later
// waves hold there until another authored segment is added. Raise `power` for a slower start and
// steeper finish; lower it toward 1 for a more linear ramp.
export const WAVE_THREAT_CURVE=Object.freeze({startBudget:12,targetBudget:100,targetWave:8,power:1.5});
// Each recipe defines an unlock tier and an archetype Spawn Pool. The composer expands each member
// to variants unlocked for that wave; spawnWeight controls frequency while threatCost spends budget.
// Freeze every level so no runtime path can mutate authored pool membership.
const freezeWaveRecipe=recipe=>Object.freeze({...recipe,pool:Object.freeze([...recipe.pool])});
export const NIGHT_WAVE_RECIPES=Object.freeze([
  {id:"raiderRush",minTier:0,pool:["raider"]},
  {id:"archerLine",minTier:0,pool:["raider","archer"]},
  {id:"healerEscort",minTier:1,pool:["raider","healer"]},
  {id:"bomberRush",minTier:1,pool:["raider","bomber"]},
  {id:"brutePush",minTier:2,pool:["raider","brute"]},
  {id:"twoFront",minTier:2,pool:["raider","archer","bomber","brute"]}
].map(freezeWaveRecipe));

// ── day / night pacing ──────────────────────────────────────────────────────
export const DAY_DURATION=75;
export const NIGHT_OVERLAY_ALPHA=.28,LIGHT_FADE_TIME=6;

// ── the king ────────────────────────────────────────────────────────────────
export const KING={range:95,damage:2,damageTargetType:DAMAGE_TARGET_TYPE.ENEMIES_ONLY,rate:.85};

// ── player feel ─────────────────────────────────────────────────────────────
// Only the constants the view debugger can NEVER write live here. The tunable
// siblings are fields of mutable holders in the modules that read them:
// TUNE in simulation.js and VIEW_TUNE in render/scene.js. The debugger mutates
// holder fields because imported bindings cannot be reassigned.
export const STEADY_HAND_RATE=1.8;  // the "steady hand" upgrade's fill multiplier
