// ═══════════════════════════════════════════════════════════════════════════
// AUTHORED GAME DATA
// THE single source for every immutable definition the game is authored from:
// world dimensions, the placement lattice, footprints, resource kinds, building
// and upgrade tables, tower variants, enemy stats, wave recipes, and the pacing
// constants that are never written at runtime.
//
// Ownership / data flow
//   Written by: nobody. Every value here is authored, read-only at runtime, and
//               may only change by editing this file. No debug flag, no view
//               panel binding and no simulation path may assign into these
//               tables (see the DBG rule in simulation.js, which restates the same
//               contract from the consumer side).
//   Read by:    grid.js (lattice + footprints only), simulation.js (everything
//               gameplay), and main.js (the render / UI layer). Both consumers
//               only ever read.
//   Imports:    none, deliberately. This module must stay a leaf so nothing can
//               create an import cycle through it. It never touches `document`,
//               `window`, THREE, the canvas, or any mutable run state.
//
// Anything that IS written at runtime deliberately does NOT live here: mutable
// run state (`state`, the entity arrays), the world seeding constants next to
// seedWorld(), and the debug-tunable feel constants the view panel reassigns
// all stay in simulation.js (TUNE) and main.js (VIEW_TUNE), because a `const`
// re-exported from here could not be reassigned by its readers.
// ═══════════════════════════════════════════════════════════════════════════

// ── frame and world dimensions ──────────────────────────────────────────────
export const VIEW_W=960,VIEW_H=540;          // Fixed 16:9 logical frame; CSS scales both axes together.
export const W=1536,H=1024;                  // Larger world explored through camera pan/zoom.

// ── the base ────────────────────────────────────────────────────────────────
// Authored anchor, radius and reserved footprint. Not run state: base HEALTH is
// state.baseHp/baseMax in simulation.js, and nothing ever writes x/y/r/footprint.
// Its anchor is already a cell center, so the 3x3 is symmetric around it. The base reserves cells
// exactly like a placed building - no keep-out circle, no special case in canPlace().
// `footprint` is attached below, once FOOTPRINT_3x3 exists; nothing else ever writes this object.
export const BASE = {x:W/2,y:H/2,r:43};
export const BASE_ZONE=240;
// Buildable world = the map inset by this much on every side. Read by canPlace() in simulation.js.
export const BUILD_MARGIN=45;

// ── Placement grid ──
// One shared lattice for every placeable object. This module owns its numbers; grid.js owns the math
// over them; the simulation and rendering only consume both.
// CELL is measured in simulation pixels, the same space as W/H, BASE, mouse, and building x/y.
// Origin is shifted back by half a cell so cell CENTERS land on exact multiples of CELL. That keeps
// BASE (768,512 = 24·CELL, 16·CELL) sitting precisely on a cell center, so the base stays a valid
// alignment reference for anything snapped to the grid.
// Map-edge treatment: because of that half-cell shift the first and last column/row are HALF cells
// clipped by the world border - cell (0,*) spans x∈[-16,16] and cell (48,*) spans x∈[1520,1552],
// with centers exactly on x=0 and x=W. They remain addressable (worldToCell never returns a
// negative index for an in-world point) but are never fully inside the world, so
// footprintInWorldBounds() rejects them. Fully-interior cells are cx∈[1,47], cy∈[1,31] (47x31).
export const CELL=32;
export const GRID_ORIGIN_X=-CELL/2,GRID_ORIGIN_Y=-CELL/2;   // world coords of cell (0,0)'s top-left corner
export const GRID_COLS=W/CELL+1,GRID_ROWS=H/CELL+1;         // 49 x 33 addressable cells, edge ones half-clipped

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
// Canonical kind order. Every per-kind record (carried, stored, storage, delivered,
// upgrade costs) is keyed by these names, and iteration order here is the order
// costs, tallies and grants are read in.
export const RESOURCE_KINDS=["wood","stone","dust","coin","diamond"];

// ── houses and workers ──────────────────────────────────────────────────────
export const HOUSE_SLOTS=2,HOUSE_COST={wood:8,stone:6},HOUSE_COST_ESCALATION={wood:4,stone:3},WORKER_SPAWN_TIME=12;
export const WORKER_LEASH=150,WORKER_MELEE=24,WORKER_SPEED=52,WORKER_HP=5,WORKER_DAMAGE=1,WORKER_ATTACK_RATE=.9,WORKER_HIT_COOLDOWN=2.35,WORKER_CARRY=3;

// ── buildings ───────────────────────────────────────────────────────────────
// Every entry carries an explicit `footprint` (odd cells, anchor-centered). The tower chassis is the
// only 3x3; every other building and deployable is 1x1. Tower VARIANTS inherit the chassis footprint -
// upgrading never resizes an already-placed tower, so variants deliberately declare no footprint.
export const BUILDING_TYPES = {
  lumber:{name:"lumber camp",resource:"wood",cost:{wood:8,stone:2},serviceRadius:155,footprint:FOOTPRINT_1x1},
  quarry:{name:"quarry",resource:"stone",cost:{wood:4,stone:8},serviceRadius:155,footprint:FOOTPRINT_1x1},
  stockpile:{name:"stockpile",resource:null,cost:{wood:2,stone:0},serviceRadius:175,footprint:FOOTPRINT_1x1},
  house:{name:"house",resource:null,cost:HOUSE_COST,footprint:FOOTPRINT_1x1},
  obelisk:{name:"obelisk",resource:null,cost:{wood:5,stone:12},footprint:FOOTPRINT_1x1},
  tower:{name:"basic tower",resource:null,cost:{wood:6,stone:10},footprint:FOOTPRINT_3x3},
  blast:{name:"blast charge",resource:null,cost:{wood:0,stone:0},effectRadius:135,instant:true,footprint:FOOTPRINT_1x1},
  spikes:{name:"spike trap",resource:null,cost:{wood:0,stone:0},instant:true,stack:true,footprint:FOOTPRINT_1x1},
  landmine:{name:"land mine",resource:null,cost:{wood:0,stone:0},effectRadius:65,instant:true,stack:true,footprint:FOOTPRINT_1x1},
  tar:{name:"tar",resource:null,cost:{wood:0,stone:0},effectRadius:22,slowDuration:2,slowMultiplier:.5,instant:true,stack:true,footprint:FOOTPRINT_1x1}
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
export const TOWER_VARIANTS={
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
  shock:{icon:"↯",name:"shock tower",family:"Special",description:"movable tower with a manually triggered reusable shock pulse.",cost:{wood:2,stone:4,coin:1,diamond:1},attackMode:"manual area",effectRadius:150,damage:2,cooldown:8,maxHp:15,manual:true,movable:true,accent:"#70d8d1",sound:105}
};

// ── enemies and the night schedule ──────────────────────────────────────────
export const ENEMY_TYPES={
  raider:{name:"raider",hp:5,speed:52,damage:2,range:40,rate:1,size:1},
  archer:{name:"archer",hp:4,speed:42,damage:1,range:155,rate:1.8,size:1},
  healer:{name:"healer",hp:5,speed:38,damage:0,range:180,rate:0,size:1},
  brute:{name:"brute",hp:12,speed:28,damage:5,range:43,rate:1.4,size:1.35}
};
export const MAP_SIDE={NORTH:"north",EAST:"east",SOUTH:"south",WEST:"west"},MAP_SIDES=Object.values(MAP_SIDE);
export const WAVE_FRONT_SECONDARY="secondary";
export const ENEMY_POOL=["raider","raider","archer","healer","brute"],DAY_ENEMY_SPAWN={min:14,max:20},DAY_ENEMY_CAP=5;
export const NIGHT_WAVE_SPAWNS=12,NIGHT_WAVE_WINDOW=30,NIGHT_ENEMY_CAP=30,NIGHT_TELEGRAPH_TIME=8;
// Authored order/composition changes tactical shape without deriving stats from night number.
export const NIGHT_WAVE_RECIPES=[
  {id:"raiderRush",spawns:[["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"],["raider","primary"]]},
  {id:"archerLine",spawns:[["raider","primary"],["archer","primary"],["archer","primary"],["archer","primary"],["raider","primary"],["archer","primary"],["archer","primary"],["raider","primary"],["archer","primary"],["archer","primary"],["raider","primary"],["archer","primary"]]},
  {id:"healerEscort",spawns:[["raider","primary"],["raider","primary"],["healer","primary"],["raider","primary"],["raider","primary"],["healer","primary"],["raider","primary"],["raider","primary"],["healer","primary"],["raider","primary"],["raider","primary"],["raider","primary"]]},
  {id:"brutePush",spawns:[["raider","primary"],["brute","primary"],["raider","primary"],["brute","primary"],["raider","primary"],["brute","primary"],["raider","primary"],["brute","primary"],["raider","primary"],["brute","primary"],["raider","primary"],["brute","primary"]]},
  {id:"twoFront",spawns:[["raider","primary"],["raider","secondary"],["archer","primary"],["archer","secondary"],["raider","primary"],["raider","secondary"],["brute","primary"],["brute","secondary"],["archer","primary"],["archer","secondary"],["raider","primary"],["raider","secondary"]]}
];

// ── day / night pacing ──────────────────────────────────────────────────────
export const DAY_DURATION=75,NIGHT_DURATION=45;
export const NIGHT_OVERLAY_ALPHA=.5,LIGHT_FADE_TIME=6;

// ── the king ────────────────────────────────────────────────────────────────
export const KING={range:95,damage:2,rate:.85};

// ── player feel ─────────────────────────────────────────────────────────────
// Only the constants the view debugger can NEVER write live here. The tunable
// siblings are fields of a mutable holder in whichever module READS them,
// because the view panel reassigns them at runtime and an imported binding
// cannot be reassigned by its importer: TUNE in simulation.js (chopTime,
// vacuumRadius, suckRate, chopYield, clickDamage, gameSpeed) and VIEW_TUNE in
// main.js (handArc, showVacuumRing, shotSpeed, shotArc, shotSize).
export const STEADY_HAND_RATE=1.8;  // the "steady hand" upgrade's fill multiplier
