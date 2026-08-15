// Card registry — the single source of truth for the pick-3 draft pool.
//
// One entry per card. This file is the design catalog AND the feature tracker:
//   implemented — the effect exists in game code (may still be test-only)
//   inPool      — the draft can actually offer it
// Workflow: add an entry here (implemented:false), point Claude at it, it gets
// built, the flag flips.
// Routing: a drafted BUFF applies the moment it is picked. A drafted CONSUMABLE or
// BLUEPRINT is not applied at all — it goes into the run's HAND (simulation.js) and
// only becomes an effect when the player plays it. docs/cards.html renders this file as a browsable
// catalog; docs/progression-model.js reads `model` to simulate income
// compounding; scripts/validate.mjs keeps every ref honest.
//
// Fields:
//   id         unique slug
//   category   "buff" (permanent, stackable) | "consumable" (free, expendable)
//              | "aura" (free, temporary buff tower) | "blueprint" (drops one construction
//              site; it stays in the pool and may be offered again)
//   rarity     "common" | "rare" | "epic" | "legendary"
//   text       player-facing effect line
//   stacks     max times a buff can be drafted (buffs only)
//   ref        what it unlocks/casts, checked against authored tables:
//              "building:<id>" | "tower:<id>" | "upgrade:<id>" | "concept:<slug>"
//   model      expected income effect PER STACK for the pacing model, or null.
//              {target:"hand"|"worker"|"global"|"xp", mult:<factor>} — a crude
//              multiplicative average; the headless bot replaces these later.
//   type       optional consumable tag: "building" | "spell"
//   charges    number of placements/casts granted by one consumable
//   durationSeconds  lifetime of a temporary consumable effect, in real seconds
//   tags       optional mechanic facets beyond the card's category
//   features   larger game systems touched by the card; values come from CARD_FEATURES
//   produces   output of a generator blueprint that has no authored game table yet

export const RARITIES=["common","rare","epic","legendary"];
export const CARD_CATEGORIES=["buff","consumable","aura","blueprint"];
export const CARD_FEATURES=["day/night","resources","workers","hp","fire","fog","physical space"];
// Relative draw weight per rarity. The draft picks 3 distinct eligible cards proportionally to
// these; they are odds, not percentages, so adding a card to the pool reweights its whole rarity.
export const RARITY_WEIGHTS={common:60,rare:27,epic:10,legendary:3};

export const CARDS=[
  // ── A · buffs — click ─────────────────────────────────────────────────────
  {id:"clickDamage",  category:"buff", rarity:"common", text:"+1 click damage",
   stacks:5, ref:"concept:clickCombat", model:null,
   implemented:true, inPool:true, notes:"combat only; layered over TUNE.clickDamage at read time"},
  {id:"clickSpeed",   category:"buff", rarity:"common", text:"swings land 12% faster",
   stacks:4, ref:"concept:chopTime", model:{target:"hand",mult:1.12},
   implemented:true, inPool:true, notes:"multiplies the chop fill rate, composing with steady hand"},
  {id:"chopYield",    category:"buff", rarity:"rare",   text:"+1 drop per completed chop",
   features:["resources"], stacks:2, ref:"concept:chopYield", model:{target:"hand",mult:1.35},
   implemented:false, inPool:false, notes:"TUNE.chopYield exists as debug knob; huge early — rare on purpose"},
  {id:"critClicks",   category:"buff", rarity:"rare",   text:"10% chance a chop pays ×3",
   stacks:3, ref:"concept:crit", model:{target:"hand",mult:1.2},
   implemented:true, inPool:true, notes:"also ×3 damage on completed combat swings"},
  {id:"chainLightning", category:"buff", rarity:"epic", text:"click hits have a chance to chain lightning",
   tags:["chain","lightning"], stacks:1, ref:"concept:chainLightning", model:null,
   implemented:false, inPool:false, notes:"proc chance, chain count, range, and chained damage TBD"},
  {id:"loadedDrop", category:"buff", rarity:"epic", text:"dropping carried resources deals 1 area damage per resource",
   tags:["aoe","hand"], features:["resources","physical space"], stacks:1, ref:"concept:loadedDrop", model:null,
   implemented:false, inPool:false, notes:"uses hand count before the drop; prevent repeated pickup/drop from dealing free infinite damage"},
  {id:"enemySlam", category:"buff", rarity:"legendary", text:"pick up light enemies; dropping one deals area damage on impact",
   tags:["aoe","enemy pickup","light enemy"], features:["physical space"], stacks:1, ref:"concept:enemySlam", model:null,
   implemented:false, inPool:false, notes:"follow-up to enemy pickup; weight limit, impact damage, and radius TBD"},
  {id:"handCarry",    category:"buff", rarity:"common", text:"+2 hand carry capacity",
   features:["resources"], stacks:4, ref:"upgrade:hands", model:{target:"hand",mult:1.05},
   implemented:true, inPool:true, notes:"raises state.capacity, the same run field a completed resource building raises"},
  {id:"vacuumRadius", category:"buff", rarity:"common", text:"pull loose drops from further away",
   features:["resources","physical space"], stacks:3, ref:"upgrade:magnet", model:{target:"hand",mult:1.08},
   implemented:true, inPool:true, notes:"+15px/stack layered over TUNE.vacuumRadius; the drawn ring still reads TUNE directly"},
  {id:"steadyHand",   category:"buff", rarity:"rare",   text:"gathering and attacking take 45% less time",
   features:["resources"], stacks:1, ref:"upgrade:autoClick", model:{target:"hand",mult:1.45},
   implemented:true, inPool:false, notes:"STEADY_HAND_RATE — the one upgrade with a real effect today"},

  // ── A · buffs — workers ───────────────────────────────────────────────────
  {id:"workerSpeed",  category:"buff", rarity:"common", text:"workers walk 12% faster",
   features:["workers"], stacks:4, ref:"concept:workerSpeed", model:{target:"worker",mult:1.12},
   implemented:true, inPool:true, notes:""},
  {id:"workerCarry",  category:"buff", rarity:"rare",   text:"workers carry +1",
   features:["workers"], stacks:3, ref:"concept:workerCarry", model:{target:"worker",mult:1.25},
   implemented:true, inPool:true, notes:"WORKER_CARRY is 3 today, so each stack is big"},
  {id:"workerSlot",   category:"buff", rarity:"epic",   text:"every house hosts +1 worker",
   features:["workers","physical space"], stacks:2, ref:"concept:houseSlots", model:{target:"worker",mult:1.2},
   implemented:false, inPool:false, notes:"HOUSE_SLOTS lever; retroactive on built houses"},
  {id:"workerHp",     category:"buff", rarity:"common", text:"workers +2 hp",
   features:["workers","hp"], stacks:3, ref:"concept:workerHp", model:null,
   implemented:false, inPool:false, notes:"survival, not income"},
  {id:"dawnHeal",     category:"buff", rarity:"rare",   text:"workers fully heal at dawn",
   features:["day/night","workers","hp"], stacks:1, ref:"concept:dawnHeal", model:null,
   implemented:false, inPool:false, notes:""},

  // ── A · buffs — towers & base ─────────────────────────────────────────────
  {id:"towerDamage",  category:"buff", rarity:"common", text:"all towers +10% damage",
   stacks:5, ref:"concept:towerDamage", model:null,
   implemented:true, inPool:true, notes:"rounded up per shot; burn ticks keep their authored damage"},
  {id:"towerSpeed",   category:"buff", rarity:"common", text:"all towers fire 10% faster",
   stacks:5, ref:"concept:towerSpeed", model:null,
   implemented:true, inPool:true, notes:"divides every tower cooldown, manual pulses included"},
  {id:"towerRange",   category:"buff", rarity:"rare",   text:"all towers +10% range",
   features:["physical space"], stacks:3, ref:"concept:towerRange", model:null,
   implemented:false, inPool:false, notes:""},
  {id:"dawnRepair",   category:"buff", rarity:"epic",   text:"towers self-repair at dawn",
   features:["day/night","hp"], stacks:1, ref:"concept:dawnRepair", model:null,
   implemented:false, inPool:false, notes:""},
  {id:"baseHp",       category:"buff", rarity:"common", text:"the base +5 max hp",
   features:["hp"], stacks:4, ref:"concept:baseHp", model:null,
   implemented:true, inPool:true, notes:"heals the same 5 it adds"},
  {id:"retaliation", category:"buff", rarity:"epic", text:"attackers take damage proportional to the damage they deal",
   tags:["retaliation","reflected damage"], features:["hp","physical space"], stacks:1,
   ref:"concept:retaliation", model:null, implemented:false, inPool:false,
   notes:"scope—main base only or every damageable building—and reflected percentage TBD"},
  {id:"nightOwl",     category:"buff", rarity:"rare",   text:"gathering keeps +15% of its rate at night",
   features:["day/night","resources"], stacks:2, ref:"concept:nightGather", model:{target:"global",mult:1.06},
   implemented:false, inPool:false, notes:"raises ARC.nightIncomeFactor in effect"},
  {id:"xpAppetite",   category:"buff", rarity:"epic",   text:"the thing digests +15% XP per fed unit",
   stacks:3, ref:"concept:feedXp", model:{target:"xp",mult:1.15},
   implemented:false, inPool:false, notes:"the greedy-loop card: faster drafts, louder thing"},

  // ── B · consumables — already in the game as free instant buildings ───────
  {id:"blastCharge",  category:"consumable", rarity:"common", text:"blast charge: detonate an area now",
   type:"building", features:["physical space"], charges:1, ref:"building:blast", model:null, implemented:true, inPool:true,
   notes:"held in hand; playing it targets one free cost-0 blast charge through the build placement flow"},
  {id:"spikeKit",     category:"consumable", rarity:"common", text:"place spike traps",
   type:"building", features:["physical space"], charges:3, durationSeconds:5, ref:"building:spikes", model:null, implemented:true, inPool:true,
   notes:"held in hand; 3 free placements, and cancelling mid-kit keeps the unplaced charges on the card"},
  {id:"mineKit",      category:"consumable", rarity:"rare",   text:"place land mines",
   type:"building", features:["physical space"], charges:2, durationSeconds:5, ref:"building:landmine", model:null, implemented:true, inPool:true,
   notes:"held in hand; 2 free placements, and cancelling mid-kit keeps the unplaced charges on the card"},
  {id:"tarKit",       category:"consumable", rarity:"common", text:"pour 3 tar patches",
   type:"building", features:["physical space"], charges:3, ref:"building:tar", model:null, implemented:true, inPool:true,
   notes:"held in hand; 3 free placements, and cancelling mid-kit keeps the unplaced charges on the card"},

  // ── B · consumables — new ─────────────────────────────────────────────────
  {id:"fireball",     category:"consumable", rarity:"rare",   text:"cast a fireball at a location",
   type:"spell", features:["fire"], charges:1, ref:"concept:fireball", model:null, implemented:true, inPool:true,
   notes:"held in hand; aims with the blast charge's placement ghost and detonates FIREBALL (damage/radius in data.js), leaving no building"},
  {id:"raiseTreants", category:"consumable", rarity:"epic",   text:"consume a tree to spawn treants",
   type:"spell", tags:["tree"], features:["resources","workers","physical space"], charges:1, ref:"concept:treants", model:null, implemented:false, inPool:false, notes:""},
  {id:"healBase",     category:"consumable", rarity:"rare",   text:"restore the base to full",
   type:"building", features:["hp","physical space"], durationSeconds:5, ref:"concept:healBase", model:null, implemented:true, inPool:true, notes:""},
  {id:"repairAll",    category:"consumable", rarity:"rare",   text:"repair every tower",
   features:["hp"], ref:"concept:repairTowers", model:null, implemented:true, inPool:true, notes:"a held shock tower repairs too"},
  {id:"rushBuild",    category:"consumable", rarity:"epic",   text:"instantly finish one blueprint",
   features:["physical space"], ref:"concept:rushBuild", model:null, implemented:false, inPool:false, notes:""},
  {id:"woodBundle",   category:"consumable", rarity:"common", text:"+20 wood, delivered now",
   features:["resources"], ref:"concept:bundle", model:null, implemented:true, inPool:true, notes:"lands in base storage, not in the hand"},
  {id:"stoneBundle",  category:"consumable", rarity:"common", text:"+15 stone, delivered now",
   features:["resources"], ref:"concept:bundle", model:null, implemented:true, inPool:true, notes:"lands in base storage, not in the hand"},
  {id:"dustBundle",   category:"consumable", rarity:"epic",   text:"+3 dust, delivered now",
   features:["resources"], ref:"concept:bundle", model:null, implemented:true, inPool:true, notes:"lands in base storage, not in the hand"},
  {id:"tempWorker",   category:"consumable", rarity:"rare",   text:"a spectral worker helps until dusk",
   features:["day/night","workers"], ref:"concept:tempWorker", model:null, implemented:false, inPool:false, notes:""},
  {id:"calmNight",    category:"consumable", rarity:"epic",   text:"the next wave is 25% smaller",
   features:["day/night"], ref:"concept:calmNight", model:null, implemented:true, inPool:true, notes:"applies at the next night's setup, so a wave already running is untouched"},
  {id:"longDay",      category:"consumable", rarity:"rare",   text:"the sun lingers 20 more seconds",
   features:["day/night"], ref:"concept:longDay", model:null, implemented:true, inPool:true, notes:"extends the current day, or banks onto the next one if drafted at night"},
  {id:"reroll",       category:"consumable", rarity:"rare",   text:"reroll this draft",
   ref:"concept:draftMeta", model:null, implemented:false, inPool:false, notes:"draft-meta"},
  {id:"banish",       category:"consumable", rarity:"legendary", text:"remove a card from the pool for this run",
   ref:"concept:draftMeta", model:null, implemented:false, inPool:false, notes:"draft-meta"},

  // ── C · buff towers — temporary free aura buildings ──────────────────────
  {id:"mendingBeacon", category:"aura", rarity:"common", text:"heal nearby towers and workers",
   type:"building", tags:["aoe","heal"], features:["workers","hp","physical space"], charges:1, durationSeconds:20,
   ref:"concept:mendingBeacon", model:null, implemented:false, inPool:false, notes:"free prototype; healing rate and radius TBD"},
  {id:"towerStandard", category:"aura", rarity:"common", text:"nearby towers deal 25% more damage",
   type:"building", tags:["aoe","tower damage"], features:["physical space"], charges:1, durationSeconds:20,
   ref:"concept:towerStandard", model:null, implemented:false, inPool:false, notes:"free prototype; strongest aura wins if radii overlap"},
  {id:"warDrum", category:"aura", rarity:"rare", text:"nearby workers deal 25% more damage",
   type:"building", tags:["aoe","worker"], features:["workers","physical space"], charges:1, durationSeconds:20,
   ref:"concept:warDrum", model:null, implemented:false, inPool:false, notes:"free prototype; combat damage only"},
  {id:"frostTotem", category:"aura", rarity:"rare", text:"slow nearby enemies",
   type:"building", tags:["aoe","slow"], features:["physical space"], charges:1, durationSeconds:20,
   ref:"concept:frostTotem", model:null, implemented:false, inPool:false, notes:"free prototype; slow strength and radius TBD"},
  {id:"luckyTotem", category:"aura", rarity:"epic", text:"enemies defeated nearby drop more resources",
   type:"building", tags:["aoe","lucky"], features:["resources","physical space"], charges:1, durationSeconds:20,
   ref:"concept:luckyTotem", model:null, implemented:false, inPool:false, notes:"free prototype; bonus drop chance TBD"},
  {id:"wildFoundation", category:"aura", rarity:"rare", text:"nearby building costs shift with the local biome",
   type:"building", tags:["aoe","biome","tree","cost"], features:["resources","physical space"], charges:1, durationSeconds:20,
   ref:"concept:wildFoundation", model:null, implemented:false, inPool:false,
   notes:"prototype: matching biome costs 25% less; mismatched biome costs 25% more; biome detection does not exist yet"},

  // ── D · blueprints — the base kit ─────────────────────────────────────────
  // The build shop is gone: these five ARE the ordinary economy/defense menu, dealt as cards. Each
  // one drops a single ordinary CONSTRUCTION SITE at the building's own authored cost — the card
  // buys the plan, never the materials — and the house site charges nextHouseCost(), the same
  // escalating price every later house pays. They are common and they stay in the pool, so a run
  // can keep drawing houses and camps as it grows.
  {id:"bpHouse",     category:"blueprint", rarity:"common", text:"place a house blueprint",     features:["workers","physical space"], charges:1, ref:"building:house",     model:null, implemented:true, inPool:true, notes:"one house site at the ESCALATED house cost — the same price the nth house has always cost"},
  {id:"bpLumber",    category:"blueprint", rarity:"common", text:"place a lumber camp blueprint",features:["resources","physical space"], charges:1, ref:"building:lumber",    model:null, implemented:true, inPool:true, notes:"one lumber camp site at its authored cost; staff it with a worker once it stands"},
  {id:"bpQuarry",    category:"blueprint", rarity:"common", text:"place a quarry blueprint",    features:["resources","physical space"], charges:1, ref:"building:quarry",    model:null, implemented:true, inPool:true, notes:"one quarry site at its authored cost; staff it with a worker once it stands"},
  {id:"bpStockpile", category:"blueprint", rarity:"common", text:"place a stockpile blueprint", features:["resources","physical space"], charges:1, ref:"building:stockpile", model:null, implemented:true, inPool:true, notes:"one stockpile site at its authored cost; local storage haulers can fill"},
  {id:"bpTower",     category:"blueprint", rarity:"common", text:"place a basic tower blueprint",features:["physical space"], charges:1, ref:"building:tower",     model:null, implemented:true, inPool:true, notes:"one basic tower site, plannedVariant null — the chassis, free to take any variant later"},

  // ── D · blueprints — the tower table is the pool ──────────────────────────
  // Every card below refs a real authored table row, so all of them are in the pool. Drafting one
  // puts the card in the HAND; playing it arms the ordinary build placement flow and the click drops
  // a normal CONSTRUCTION SITE, one per card. A blueprint does NOT leave the pool — sites are not
  // unlocks, so a run may draw the same plan again and stand three of the thing. The card is
  // access to the variant, never its materials: the site costs the authored basic-tower price and
  // its variant upgrade is accepted the moment the chassis stands, so the player pays exactly what
  // building the tower and buying the upgrade by hand would have cost.
  {id:"bpTurret",   category:"blueprint", rarity:"common", text:"place a turret blueprint",        tags:["single target"], features:["physical space"], charges:1, ref:"tower:turret",   model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the turret upgrade, accepted for you"},
  {id:"bpOutpost",  category:"blueprint", rarity:"common", text:"place an outpost blueprint",      tags:["single target"], features:["physical space"], charges:1, ref:"tower:outpost",  model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the outpost upgrade, accepted for you"},
  {id:"bpWatch",    category:"blueprint", rarity:"common", text:"place a watch tower blueprint",   tags:["single target"], features:["physical space"], charges:1, ref:"tower:watch",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the watch tower upgrade, accepted for you"},
  {id:"bpBrick",    category:"blueprint", rarity:"rare",   text:"place a brick tower blueprint",   tags:["single target"], features:["physical space"], charges:1, ref:"tower:brick",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the brick tower upgrade, accepted for you"},
  {id:"bpAggro",    category:"blueprint", rarity:"rare",   text:"place an aggro tower blueprint",  tags:["single target"], features:["physical space"], charges:1, ref:"tower:aggro",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the aggro tower upgrade, accepted for you"},
  {id:"bpFire",     category:"blueprint", rarity:"rare",   text:"place a fire tower blueprint",    tags:["single target"], features:["fire","physical space"], charges:1, ref:"tower:fire",     model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the fire tower upgrade, accepted for you"},
  {id:"bpFreeze",   category:"blueprint", rarity:"rare",   text:"place a freeze tower blueprint",  tags:["single target"], features:["physical space"], charges:1, ref:"tower:freeze",   model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the freeze tower upgrade, accepted for you"},
  {id:"bpTar",      category:"blueprint", rarity:"rare",   text:"place a tar tower blueprint",     tags:["single target"], features:["physical space"], charges:1, ref:"tower:tarTower", model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the tar tower upgrade, accepted for you"},
  {id:"bpSniper",   category:"blueprint", rarity:"epic",   text:"place a sniper tower blueprint",  tags:["single target"], features:["physical space"], charges:1, ref:"tower:sniper",   model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the sniper tower upgrade, accepted for you"},
  {id:"bpTeleport", category:"blueprint", rarity:"epic",   text:"place a teleport tower blueprint",tags:["single target"], features:["physical space"], charges:1, ref:"tower:teleport", model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the teleport tower upgrade, accepted for you"},
  {id:"bpBomb",     category:"blueprint", rarity:"epic",   text:"place a bomb tower blueprint",    tags:["aoe"], features:["physical space"], charges:1, ref:"tower:bomb",     model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the bomb tower upgrade, accepted for you"},
  {id:"bpLaser",    category:"blueprint", rarity:"epic",   text:"place a laser tower blueprint",   tags:["piercing"], features:["physical space"], charges:1, ref:"tower:laser",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the laser tower upgrade, accepted for you"},
  {id:"bpPulse",    category:"blueprint", rarity:"epic",   text:"place a pulse tower blueprint",   tags:["aoe"], features:["physical space"], charges:1, ref:"tower:pulse",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the pulse tower upgrade, accepted for you"},
  {id:"bpShock",    category:"blueprint", rarity:"legendary", text:"place a shock tower blueprint",tags:["aoe"], features:["physical space"], charges:1, ref:"tower:shock",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; materials still apply — basic tower cost, then the shock tower upgrade, accepted for you; the finished tower stays movable"},
  {id:"bpObelisk",  category:"blueprint", rarity:"rare",   text:"place an obelisk blueprint",      features:["physical space"], charges:1, ref:"building:obelisk", model:null, implemented:true, inPool:true, notes:"one obelisk site at its authored cost; materials still apply. it carries the global-upgrade shop"},

  // ── C · blueprints — workers (don't exist yet) ────────────────────────────
  {id:"bpBarracks", category:"blueprint", rarity:"rare", text:"makes warriors",
   tags:["worker"], features:["workers","physical space"], produces:"warriors", ref:"concept:barracks", model:null, implemented:false, inPool:false, notes:""},

  // ── C · blueprints — fog generators (don't exist yet) ─────────────────────
  {id:"bpDustSiphon",   category:"blueprint", rarity:"epic",      text:"blueprint: dust siphon — works a fog dust node",
   features:["resources","fog","physical space"], ref:"concept:dustSiphon", model:{target:"xp",mult:1.1}, implemented:false, inPool:false, notes:"higher-tier generator, lives out in the fog"},
  {id:"bpCoinPress",    category:"blueprint", rarity:"epic",      text:"blueprint: coin press — mints from a fog vein",
   features:["resources","fog","physical space"], ref:"concept:coinPress", model:{target:"xp",mult:1.1}, implemented:false, inPool:false, notes:""},
  {id:"bpDiamondDrill", category:"blueprint", rarity:"legendary", text:"blueprint: diamond drill — the deep fog pays",
   features:["resources","fog","physical space"], ref:"concept:diamondDrill", model:{target:"xp",mult:1.15}, implemented:false, inPool:false, notes:""},
];

export const cardById=Object.fromEntries(CARDS.map(c=>[c.id,c]));
