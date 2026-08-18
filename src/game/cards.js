// Card registry — the single source of truth for the pick-3 draft pool.
//
// One entry per card. This file is the design catalog AND the feature tracker:
//   implemented — the effect exists in game code (may still be test-only)
//   inPool      — the draft can actually offer it
// Workflow: add an entry here (implemented:false), point Claude at it, it gets
// built, the flag flips.
// Reward pools: level-ups offer BUILDS; cleared waves offer a permanent BUFF then a CONSUMABLE;
// opened chests offer a CONSUMABLE. A chosen buff applies immediately. Chosen builds and
// consumables enter the HAND (simulation.js) and only become effects when played.
// docs/cards.html renders this file as a browsable
// catalog; docs/progression-model.js reads `model` to simulate income
// compounding; scripts/validate.mjs keeps every ref honest.
//
// Fields:
//   id         unique slug
//   category   "buff" (permanent, stackable) | "consumable" (free, expendable)
//              | "aura" (free, temporary buff tower) | "build" (drops one construction
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
//   produces   output of a generator build that has no authored game table yet
//   requires   optional list of BUFF card ids the run must own (>=1 stack each) before the draft
//              may offer this card; ownership never expires, so a once-eligible card stays eligible

export const RARITIES=["common","rare","epic","legendary"];
export const CARD_CATEGORIES=["buff","consumable","aura","build"];
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
  {id:"critClicks",   category:"buff", rarity:"rare",   text:"10% crit chance: +1 resource drop, ×3 combat damage",
   stacks:3, ref:"concept:crit", model:{target:"hand",mult:1.2},
   implemented:true, inPool:true, notes:"resource crits add one physical drop; combat crits multiply damage by three"},
  {id:"chainLightning", category:"buff", rarity:"epic", text:"swings can arc lightning between nearby targets",
   tags:["chain","lightning"], stacks:4, ref:"concept:chainLightning", model:null,
   implemented:true, inPool:true, notes:"stack N procs at 20%+10%(N-1) and throws N jumps — 20%/1 to 50%/4 at cap; jumps are full swings (own crit roll) crossing freely between enemies and resources (CARD_BUFFS.chain* in data.js)"},
  {id:"freeHit", category:"buff", rarity:"rare", text:"each click hit has a 15% chance per stack to strike again for free",
   tags:["click","free hit"], stacks:3, ref:"concept:freeHit", model:null,
   implemented:true, inPool:true, notes:"the bonus strike is a full click hit with crit and future click effects; it cannot recursively trigger itself"},
  {id:"enemyPickup", category:"buff", rarity:"epic", text:"pick up enemies tagged light",
   tags:["enemy pickup","light enemy"], features:["physical space"], stacks:1, ref:"concept:enemyPickup", model:null,
   implemented:true, inPool:true, notes:"enemy definitions own weightTag; held scheduled enemies still count toward wave clearance"},
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
  {id:"buildCapacity", category:"buff", rarity:"rare", text:"every construction site supports +1 builder",
   features:["workers"], stacks:2, ref:"concept:buildCapacity", model:{target:"worker",mult:1.08},
   implemented:true, inPool:true, notes:"adds one to each building type's authored buildSlots while it is under construction"},
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
  {id:"towerRange",   category:"buff", rarity:"rare",   text:"all towers +100 attack radius",
   features:["physical space"], stacks:5, ref:"concept:towerRange", model:null,
   implemented:true, inPool:true, notes:"adds 100px per stack to single-target range and area-tower effect radius; capped at five drafts"},
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
  {id:"screenClick", category:"consumable", rarity:"epic", text:"apply one full click hit to every on-screen enemy",
   type:"spell", tags:["click","aoe"], features:["physical space"], charges:1, ref:"concept:screenClick", model:null, implemented:true, inPool:true,
   notes:"each target enters the ordinary click-hit pipeline, including crit, chain lightning, free hit, and future click effects"},
  {id:"resourceRecall", category:"consumable", rarity:"rare", text:"pull every loose resource back to the base",
   type:"spell", features:["resources"], charges:1, ref:"concept:resourceRecall", model:null, implemented:true, inPool:true, notes:"releases worker claims and deposits recalled drops into base storage"},
  {id:"touchOfDeath", category:"consumable", rarity:"legendary", text:"deal 999 damage to every on-screen enemy",
   type:"spell", tags:["aoe"], features:["physical space"], charges:1, ref:"concept:touchOfDeath", model:null, implemented:true, inPool:true, notes:"direct spell damage; not a click hit"},
  {id:"damageOrbs", category:"consumable", rarity:"rare", text:"place 1–3 orbiting damage orbs for 30 seconds",
   type:"building", tags:["aoe"], features:["physical space"], charges:1, durationSeconds:30, ref:"building:damageOrbs", model:null, implemented:true, inPool:true, notes:"the center can be picked up and relocated while active"},
  {id:"meteor", category:"consumable", rarity:"epic", text:"call a heavy meteor that leaves a mineable rock",
   type:"spell", tags:["aoe"], features:["resources","physical space"], charges:1, ref:"concept:meteor", model:null, implemented:true, inPool:true, notes:"targets a clear 3x3 footprint; impact deals heavy area damage and installs a large stone node"},
  {id:"summoningCircle", category:"consumable", rarity:"rare", text:"place a 2-minute circle; each 5 dust summons a friendly Brute",
   type:"building", tags:["summon"], features:["resources","physical space"], charges:1, durationSeconds:120, ref:"building:summoningCircle", model:null, implemented:true, inPool:true, notes:"the movable circle persists for its full duration, retains partial dust, and can summon repeatedly; one delivery may summon several Brutes"},
  {id:"fireball",     category:"consumable", rarity:"rare",   text:"cast a fireball at a location",
   type:"spell", features:["fire"], charges:1, ref:"concept:fireball", model:null, implemented:true, inPool:true,
   notes:"held in hand; aims with the blast charge's placement ghost and detonates FIREBALL (damage/radius in data.js), leaving no building"},
  {id:"raiseTreants", category:"consumable", rarity:"epic",   text:"consume a tree to spawn treants",
   type:"spell", tags:["tree"], features:["resources","workers","physical space"], charges:1, ref:"concept:treants", model:null, implemented:false, inPool:false, notes:""},
  {id:"healBase",     category:"consumable", rarity:"rare",   text:"restore the base to full",
   type:"building", features:["hp","physical space"], durationSeconds:5, ref:"concept:healBase", model:null, implemented:true, inPool:true, notes:""},
  {id:"repairAll",    category:"consumable", rarity:"rare",   text:"repair every tower",
   features:["hp"], ref:"concept:repairTowers", model:null, implemented:true, inPool:true, notes:"a held shock tower repairs too"},
  {id:"rushBuild",    category:"consumable", rarity:"epic",   text:"instantly finish one build",
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

  // ── D · builds — the base kit ─────────────────────────────────────────
  // The build shop is gone: these five ARE the ordinary economy/defense menu, dealt as cards. Each
  // one drops a single ordinary CONSTRUCTION SITE at the building's own authored cost — the card
  // buys the plan, never the materials — and the house site charges nextHouseCost(), the same
  // escalating price every later house pays. They are common and they stay in the pool, so a run
  // can keep drawing houses and camps as it grows.
  {id:"bpHouse",     category:"build", rarity:"common", text:"place a house",     features:["workers","physical space"], charges:1, ref:"building:house",     model:null, implemented:true, inPool:true, notes:"one house site at the ESCALATED house cost — the same price the nth house has always cost"},
  {id:"bpLumber",    category:"build", rarity:"common", text:"place a lumber camp",features:["resources","physical space"], charges:1, ref:"building:lumber",    model:null, implemented:true, inPool:false, notes:"3x3 automatic renewable source: center camp grows one tree every 30 seconds in a vacant perimeter cell; no worker required; pulled from the draft pool for now"},
  {id:"bpQuarry",    category:"build", rarity:"common", text:"place a quarry",    features:["resources","physical space"], charges:1, ref:"building:quarry",    model:null, implemented:true, inPool:false, notes:"3x3 automatic renewable source: center quarry grows one rock every 30 seconds in a vacant perimeter cell; no worker required; pulled from the draft pool for now"},
  {id:"bpStockpile", category:"build", rarity:"common", text:"place a stockpile", features:["resources","physical space"], charges:1, ref:"building:stockpile", model:null, implemented:true, inPool:false, notes:"pulled from the pool for now — stockpiles aren't part of the game yet; one stockpile site at its authored cost when re-enabled"},
  {id:"bpTower",     category:"build", rarity:"common", text:"place a basic tower",features:["physical space"], charges:1, ref:"building:tower",     model:null, implemented:true, inPool:true, notes:"one basic tower site, plannedVariant null — the chassis, free to take any variant later"},

  // ── D · builds — the tower table is the pool ──────────────────────────
  // Every card below refs a real authored table row, so all of them are in the pool. Drafting one
  // puts the card in the HAND; playing it arms the ordinary build placement flow and the click drops
  // a normal CONSTRUCTION SITE, one per card. A build card does NOT leave the pool — sites are not
  // unlocks, so a run may draw the same plan again and stand three of the thing. The card is
  // access to the plan, never free materials: one site displays and accepts the combined basic
  // chassis + variant cost, then completes directly as the named tower. No second build phase.
  {id:"bpTurret",   category:"build", rarity:"common", text:"place a turret",        tags:["single target"], features:["physical space"], charges:1, ref:"tower:turret",   model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + turret materials"},
  {id:"bpOutpost",  category:"build", rarity:"common", text:"place an outpost",      tags:["single target"], features:["physical space"], charges:1, ref:"tower:outpost",  model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + outpost materials"},
  {id:"bpWatch",    category:"build", rarity:"common", text:"place a watch tower",   tags:["single target"], features:["physical space"], charges:1, ref:"tower:watch",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + watch tower materials"},
  {id:"bpBrick",    category:"build", rarity:"rare",   text:"place a brick tower",   tags:["single target"], features:["physical space"], charges:1, ref:"tower:brick",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + brick tower materials"},
  {id:"bpAggro",    category:"build", rarity:"rare",   text:"place an aggro tower",  tags:["single target"], features:["physical space"], charges:1, ref:"tower:aggro",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + aggro tower materials"},
  {id:"bpFire",     category:"build", rarity:"rare",   text:"place a fire tower",    tags:["single target"], features:["fire","physical space"], charges:1, ref:"tower:fire",     model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + fire tower materials"},
  {id:"bpFreeze",   category:"build", rarity:"rare",   text:"place a freeze tower",  tags:["single target"], features:["physical space"], charges:1, ref:"tower:freeze",   model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + freeze tower materials"},
  {id:"bpTar",      category:"build", rarity:"rare",   text:"place a tar tower",     tags:["single target"], features:["physical space"], charges:1, ref:"tower:tarTower", model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + tar tower materials"},
  {id:"bpSniper",   category:"build", rarity:"epic",   text:"place a sniper tower",  tags:["single target"], features:["physical space"], charges:1, ref:"tower:sniper",   model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + sniper tower materials"},
  {id:"bpTeleport", category:"build", rarity:"epic",   text:"place a teleport tower",tags:["single target"], features:["physical space"], charges:1, ref:"tower:teleport", model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + teleport tower materials"},
  {id:"bpBomb",     category:"build", rarity:"epic",   text:"place a bomb tower",    tags:["aoe"], features:["physical space"], charges:1, ref:"tower:bomb",     model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + bomb tower materials"},
  {id:"bpLaser",    category:"build", rarity:"epic",   text:"place a laser tower",   tags:["piercing"], features:["physical space"], charges:1, ref:"tower:laser",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + laser tower materials"},
  {id:"bpPulse",    category:"build", rarity:"epic",   text:"place a pulse tower",   tags:["aoe"], features:["physical space"], charges:1, ref:"tower:pulse",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + pulse tower materials"},
  {id:"bpLightning",category:"build", rarity:"epic",   text:"place a lightning tower",tags:["aoe","chain","lightning"], features:["physical space"], charges:1, ref:"tower:lightning", model:null, implemented:true, inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + lightning tower materials"},
  {id:"bpShock",    category:"build", rarity:"legendary", text:"place a shock tower",tags:["aoe"], features:["physical space"], charges:1, ref:"tower:shock",    model:null, implemented:true,  inPool:true, notes:"one site on the tower footprint; one combined build charges basic chassis + shock tower materials; the finished tower stays movable"},
  {id:"bpObelisk",  category:"build", rarity:"rare",   text:"place an obelisk",      features:["physical space"], charges:1, ref:"building:obelisk", model:null, implemented:true, inPool:false, notes:"disabled: direct tower upgrading is gone and the obelisk shop is not used"},

  // ── D · builds — enemy capture ────────────────────────────────────────
  {id:"bpCaptureYard", category:"build", rarity:"rare", text:"place a capture yard — drop carried light enemies in to turn them",
   tags:["enemy pickup","light enemy"], features:["workers","physical space"], charges:1, requires:["enemyPickup"],
   ref:"building:captureYard", model:null, implemented:true, inPool:true,
   notes:"gated behind the enemyPickup buff via `requires`; each finished yard controls up to 3 living converted enemies, a slot reopening when one dies"},

  // ── D · builds — the garrison ─────────────────────────────────────────
  // A defensive post, not a producer: it creates no workers and has no attack of its own. It holds
  // ordinary workers, who keep working in peace and fight from it when danger comes. Common and it
  // stays in the pool like the rest of the build menu, but it is NOT part of the opening hand.
  {id:"bpGarrison", category:"build", rarity:"common", text:"place a garrison — workers muster here to defend",
   tags:["guard"], features:["workers","physical space"], charges:1, ref:"building:garrison", model:null,
   implemented:true, inPool:true,
   notes:"one garrison site at its authored cost; GARRISON in data.js owns the guard slots, muster/threat/guard radii, demobilize delay and arrived-guard stats"},

  // ── C · builds — workers (don't exist yet) ────────────────────────────
  // Unimplemented and unrelated to the garrison: a barracks would PRODUCE warriors of its own, where
  // the garrison only borrows the workers the colony already has.
  {id:"bpBarracks", category:"build", rarity:"rare", text:"makes warriors",
   tags:["worker"], features:["workers","physical space"], produces:"warriors", ref:"concept:barracks", model:null, implemented:false, inPool:false, notes:""},

  // ── C · builds — fog generators (don't exist yet) ─────────────────────
  {id:"bpDustSiphon",   category:"build", rarity:"epic",      text:"build: dust siphon — works a fog dust node",
   features:["resources","fog","physical space"], ref:"concept:dustSiphon", model:{target:"xp",mult:1.1}, implemented:false, inPool:false, notes:"higher-tier generator, lives out in the fog"},
  {id:"bpCoinPress",    category:"build", rarity:"epic",      text:"build: coin press — mints from a fog vein",
   features:["resources","fog","physical space"], ref:"concept:coinPress", model:{target:"xp",mult:1.1}, implemented:false, inPool:false, notes:""},
  {id:"bpDiamondDrill", category:"build", rarity:"legendary", text:"build: diamond drill — the deep fog pays",
   features:["resources","fog","physical space"], ref:"concept:diamondDrill", model:{target:"xp",mult:1.15}, implemented:false, inPool:false, notes:""},
];

export const cardById=Object.fromEntries(CARDS.map(c=>[c.id,c]));
