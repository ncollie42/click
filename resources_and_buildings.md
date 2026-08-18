# Resources and Building Taxonomy

Living reference for resources, building categories, and behavior tags.

## Resources

| Resource | Source | Current uses |
|---|---|---|
| Wood | Trees, including lumber-camp growth | Construction and upgrades |
| Stone | Stone nodes, including quarry growth | Construction and upgrades |
| Dust essence | 25% enemy death drop | Tower variant upgrades |
| Gold coin | Temporary random spawn; flashes and vanishes after about 8 seconds | Shock tower variant upgrade |
| Diamond | 5–8 rare deposits generated more than 600px from the base | Advanced tower variant upgrades |

Resources may exist in several states: loose on the ground, carried by the player or a hauling worker, stored at the base or stockpile, or delivered to construction/upgrade progress. Loose drops are continuous — only the *nodes* are grid-anchored.

Each normal run loads explicit landmarks plus deterministic authored scatter regions. Trees, rocks, and grass may come from regions; diamonds and chests remain explicit. Regions occupy placement-grid rectangles and use a finite `[0,1]` density per eligible land cell. Resolution priority is explicit objects → rocks → trees → grass, so the frozen blueprint contains distinct cells before `simulation.js` materializes mutable runtime nodes.

## Placement Grid

Everything that is *placed* lands on one shared square lattice. `src/game/data.js` owns its dimensions, `src/game/grid.js` owns pure lattice math, and simulation/render consumers share those definitions.

- **Cell size is 32 simulation pixels.** The same unit as world width/height, base position, mouse position, and every building `x`/`y`. The world is 7680x5120, so the lattice addresses 241x161 cells.
- **The anchor is the centre cell.** A building's stored `x`/`y` is always a cell *centre*, never a corner. The origin is deliberately shifted back by half a cell so centres land on exact multiples of 32, which puts the base (3840, 2560) on a centre and makes it a valid alignment reference.
- **Footprints must be odd.** An odd `{w, h}` has a whole-cell half-extent on each side of the anchor, so a model can stay centred on the cell it is anchored to. `1x1` and `3x3` are the only sizes in use; a `2x2` would have no centre cell and is not supported.
- **The whole footprint is validated, not just the anchor.** Bounds, the build margin, and occupancy against nodes, buildings, and the base are all tested against every cell the footprint covers. A 3x3 whose anchor is in bounds can still be rejected because a corner cell overhangs.
- **The half-clipped border row and column always fail.** The half-cell origin shift makes column 0 / 240 and row 0 / 160 straddle the world edge. They remain addressable but never fully inside the world, so nothing can be placed on them. Fully interior cells are 239x159.
- **Cell occupancy is the only spacing rule between placed things.** There is no minimum distance between buildings any more. Two 1x1 deployables may sit in touching cells; they may never share one.

### Footprints

| Placed object | Footprint | Notes |
|---|---|---|
| Lumber camp | 3x3 | Camp in center; grows trees in the eight perimeter cells |
| Quarry | 3x3 | Quarry in center; grows rocks in the eight perimeter cells |
| Stockpile | 1x1 | |
| House | 1x1 | |
| Obelisk | 1x1 | |
| Basic tower chassis | 3x3 | |
| Every tower variant | 3x3 | Inherited from the chassis; variants declare no footprint of their own |
| Capture yard | 3x3 | Constructed; converts dropped light enemies into controlled allies |
| Garrison | 1x1 | Constructed; converts existing workers into fortified guards |
| Blast charge | 1x1 | |
| Spike trap | 1x1 | |
| Land mine | 1x1 | |
| Tar | 1x1 | |
| Base | 3x3 | Not placeable, but occupies cells like anything else |
| Tree | 1x1 | Blocks only while standing |
| Stone node | 1x1 | Blocks only while not depleted |
| Diamond deposit | 1x1 | Blocks only while not depleted |
| Showcase props | Authored odd footprint | Showcase-only; validated with the same placement rules |

The base is never placed by the player, but it reserves ground exactly like a building: a 3x3 footprint on its own cell centre, tested by the same occupancy rule and drawn with the same pad. There is no keep-out circle and no dirt clearing under it — the cells immediately outside its 3x3 are buildable.

Towers are permanently 3x3. Choosing a chassis upgrade never resizes an already-placed tower: upgrade completion swaps stats, health scale, and behaviour but leaves the anchor and the nine reserved cells untouched. The Shock Tower is the one movable tower; relocating it re-validates the same 3x3 footprint at the new snapped anchor while excluding the tower itself from the occupancy scan, and only `x`/`y` change — cooldown, health, and variant ride along.

### Renewable resource sources

A completed lumber camp or quarry starts a 30-second countdown automatically; no worker gates production. At each interval it chooses one random vacant cell from its eight-cell perimeter and creates a standard tree or rock there. Active nodes block their cells; eight active nodes therefore pause production. A depleted source node is revived in place rather than duplicated. Source-grown nodes use the canonical `trees` / `rocks` collections, so manual or worker harvesting, rendering, and damage behave exactly as for world nodes. The central cell always holds only the building.

### Depleted nodes

Trees, stone nodes, and diamond deposits each reserve exactly one cell *while active*. Felling a tree or exhausting a node clears that node's reservation immediately: the cell becomes buildable unless another footprint still reserves it. The stump or spent rock stays on the map as scenery on the same cell it always occupied. Harvesting is therefore the way to open construction sites in a crowded forest. Source-grown stumps/spent rocks remain inside their source building's reserved 3x3 and may regrow there.

### Grass vegetation

Grass-textured `LAND` is immutable topology. Separate frozen blueprint grass descriptors become mutable runtime vegetation in normal runs only. Tufts have 1 HP and use one existing completed hold-action hit. They are lower priority than enemies, chests, and real resources; clearing yields no drops, XP, workers, occupancy, or topology change. `canPlace()` ignores grass, while successful building placement and Shock Tower relocation clear overlapping tufts. The shared scatter resolver reserves grass source cells after explicit objects, rocks, and trees, preventing spawn overlap without making grass runtime occupancy. Rendering uses one bounded instanced mesh rebuilt only when the separate vegetation revision changes. Land color samples a deterministic repeating 64×64 RGBA tile: 16 KiB canvas backing plus 16 KiB GPU level (mipmaps disabled), replacing the former 7680×5120 allocation of about 150 MiB on each side.

### Footprint is not the other radii

Footprint occupancy answers one question only: *which cells does this object reserve so nothing else can be placed there?* It is unrelated to, and must not be confused with:

- **Model bounds.** The 3D mesh has its own dimensions and may visually overhang or under-fill its cells. Only `footprint.w/h` may be read for placement; rendering derives its pad and preview from the same values rather than restating a size.
- **Service radius.** Circles in which a lumber camp (155) or quarry (155) finds nodes, and a stockpile (175) covers drops and delivery. Still circular, still measured from the anchor.
- **Attack range.** Per-variant tower range (165 to 430) plus the Aggro Tower's 320 taunt radius. Still circular.
- **Effect radius.** Blast charge 135, land mine 65, tar 22, Pulse 145, Shock 150. Still circular.
- **Build margin.** A 45px inset from the world border, still a continuous rule; the grid only decides which cells are tested against it. (The base is *not* in this list any more — it is plain cell occupancy.)
- **Hover and drop targeting.** Picking a blueprint, stockpile, or upgrade button under the cursor is still a distance test, so two structures in adjacent cells can both be inside each other's hover range even though their footprints never overlap.

### Terrain ownership and generation

`authored-map.js` loads the hand-authored starter map (`src/game/maps/starter.map.json`, one authored cell per 32px placement cell, edited in `tools/map-editor.html`) and derives the 16px, 480x320 row-major `LAND`/`WATER` raster. Data flows map JSON → `map-document.js` validation → DOM-free `scatter-regions.js` resolution → frozen game blueprint/editor preview → `simulation.js` mutable materialization. Placement rejects footprints touching water. Showcase initialization/rebuild installs authored all-land terrain.

Scatter candidates hash the map seed, stable region ID/local uint32 seed, kind, and cell coordinates. Changing the map seed deterministically affects WFC and every region; local reroll changes one region except where overlap priority legitimately exposes or hides lower-priority candidates. Generated cells require land, the 45px build margin, and the protected base 3×3. WFC chooses terrain appearance only; scatter regions choose resource and vegetation presence.

Production enemies spawn near the base on the configured ring, preferring authored land. Showcase enemies retain authored positions; the production/debug spawn command is intentionally a no-op in showcase mode.

### What stays continuous

The grid governs *placement only*. Workers, enemies, the player cursor, loose resource drops, projectiles, and all movement remain free-floating in continuous world pixels. There is no pathfinding, no tile-based movement, no rotation, and no persistence between runs. **Temporary limitation:** shoreline selection makes enemies start on land and prefers a clear direct approach, but workers and enemies still have no water collision and may later cross ocean or lakes while pursuing targets. Teleport pushback still follows the recorded cardinal `spawnSide`, so it may also push an enemy across shoreline water.

## Showcase Validation

`?mode=showcase` installs an authored gallery: display units stay inert, while towers use production combat against resettable damage dummies and authored props/chests retain their demonstrated pointer interactions. Its fixture manifest validates registry coverage, IDs, sections, footprints, margins, and overlap at import. Run `node scripts/validate.mjs` for deterministic normal/showcase stress, fixture rebuild/reset checks, and complete skill-graph reveal.

## Building Categories

```text
base
├── production
│   ├── lumber camp
│   └── quarry
├── storage
│   └── stockpile
├── population
│   └── house
├── progression
│   └── obelisk
├── defense
│   ├── towers
│   │   └── basic tower chassis
│   │       ├── starter: turret / outpost
│   │       ├── ballistics: watch / sniper / brick / aggro
│   │       ├── elemental: fire / freeze / tar tower
│   │       ├── control: teleport
│   │       └── special: bomb / laser / pulse / shock
│   ├── deployables / cards
│   │   ├── blast charge
│   │   ├── spike trap
│   │   ├── land mine
│   │   └── tar
│   └── garrison
├── units
│   └── capture yard
└── future
    ├── explorer building
    ├── repair building
    └── barracks (produces warriors of its own — NOT the garrison)
```

## Behavior Tags

Categories answer **what role does this building serve?** Tags answer **how does it behave?** A building can have several tags.

### Activation

- `automatic` — activates without player input.
- `staffed` — requires a worker dropped onto it before its automatic behavior runs.
- `manual` — player presses its hover button.
- `contact` — activates when an enemy touches it.

### Targeting

- `single-target`
- `area`
- `resource-node`
- `friendly`

### Cadence

- `cooldown` — reusable after visible recharge time.
- `continuous` — works whenever a valid target exists.
- `charges` — limited number of uses or placements.

### Lifetime

- `persistent`
- `one-use`
- `card` — limited inventory stack; placing one consumes a stack.
- `movable`

### Acquisition

- `constructed` — requires delivered resources.
- `free`
- `upgradeable`

## Current Examples

| Building | Category | Tags |
|---|---|---|
| Lumber camp | Production | `constructed`, `staffed`, `automatic`, `resource-node`, `persistent` |
| Quarry | Production | `constructed`, `staffed`, `automatic`, `resource-node`, `persistent` |
| Stockpile | Storage | `constructed`, `manual`, `persistent` |
| House | Population | `constructed`, `automatic`, `cooldown`, `persistent` |
| Obelisk | Progression | `constructed`, `manual`, `upgradeable`, `persistent` |
| Basic tower chassis | Defense / Tower | `constructed`, `automatic`, `single-target`, `cooldown`, `upgradeable`, `persistent` |
| Automatic tower variants | Defense / Tower | `automatic`, `single-target` or `area`, `cooldown`, `persistent` |
| Pulse tower variant | Defense / Tower | `automatic`, `area`, `cooldown`, `persistent` |
| Shock tower variant | Defense / Tower | `manual`, `area`, `cooldown`, `movable`, `persistent` |
| Blast charge | Defense / Deployable | `free`, `manual`, `area`, `one-use` |
| Spike trap | Defense / Deployable | `free`, `contact`, `card`, `charges`, `persistent` |
| Land mine | Defense / Deployable | `free`, `contact`, `card`, `charges`, `area`, `one-use` |
| Tar | Defense / Deployable | `free`, `contact`, `card`, `charges`, `persistent` |
| Capture yard | Units | `constructed`, `manual`, `friendly`, `persistent` |
| Garrison | Defense | `constructed`, `staffed`, `friendly`, `persistent` |

Footprints for every row above live in the [Footprints](#footprints) table. All of them are 1x1 except the tower chassis, its variants, and the capture yard.

### Capture Yard

Acquisition: the rare `bpCaptureYard` build card (8 wood + 8 stone, 3 build slots). The card carries `requires: ["enemyPickup"]`, so the draft may only offer it after the Enemy Pickup buff is owned — the buff first, the yard afterward. Behavior: right-releasing a carried light enemy over a completed yard with fewer than three living linked allies converts it into a controlled enemy (see CONTEXT.md "Enemy Capture"); a full or unfinished yard rejects the drop and restores the enemy to its pickup origin. Occupancy is derived from living linked units — a slot reopens only when one dies.

### Garrison

Acquisition: the common `bpGarrison` build card (6 wood + 6 stone, 2 build slots, 1x1 footprint). The card is ungated and lives in the ordinary draft pool — it is drafted, never granted, and it is not part of the starting hand. Multiple garrisons are independent, each with its own three slots.

**The garrison converts workers; it never creates them.** It produces no resource, has no attack of its own, adds no population, and mints no new unit. Its three `jobSlots` **are** its guard slots (`GARRISON.capacity`), and a guard is always one of the colony's existing workers standing in one of them. A worker on guard duty is a worker not gathering, hauling or building — that opportunity cost is the whole trade. The unimplemented **barracks** concept (`bpBarracks`, `ref:"concept:barracks"`) is deliberately kept separate: a barracks would *produce* warriors of its own, which is exactly what the garrison does not do.

Two kinds of guard stand in the same slots:

- **Manual guards** (`autonomous:false`) come from the player right-dragging a worker onto a completed garrison, or from a manual builder inheriting the durable post it just stood up. They are standing orders: they never auto-demobilize, dawn never releases them, and the muster never re-posts them.
- **Autonomous guards** (`autonomous:true`) are temporary, raised by the muster below and released again by dawn or by a quiet day.

Assignment reserves a slot immediately — before the worker has walked anywhere — because occupancy is derived from the workers pointing at the station (held workers included), never from a counter on the building. A full garrison rejects a drop outright and restores the held worker to its pickup origin and prior assignment, exactly like a full camp or a full Capture Yard.

**The fortified kit is earned by arrival, not by orders.** A guard is fortified only while all three hold: its job is `guard`, its `jobTarget` is a live *completed* garrison, and it has physically reached that post. Only then does its effective maximum become `GARRISON.maxHp` (10, against the ordinary `WORKER_HP` 5) and its melee hit `GARRISON.damage` (2, against `WORKER_DAMAGE` 1). A posted guard detects and pursues hostiles up to `GARRISON.engagementRadius` (400px) from its post; melee reach and attack cadence are untouched.

The kit is granted as a max-HP **delta** and withdrawn as a **clamp**, so a status change can neither heal a wounded guard nor kill it by subtraction:

- **On arrival** the guard gains the +5 delta: a full 5/5 becomes 10/10, a wounded 3/5 becomes 8/10. The edge fires once — later frames re-read the same predicate and grant nothing.
- **On exit** (pickup, reassignment, demobilization, death of the station, a garrison that leaves the world) the pool clamps back to 5. A guard at 2/10 stays at 2/5; a guard at 10/10 drops to 5/5. Picking a guard up withdraws the kit immediately while keeping its slot reserved.

The bigger pool is not immortality: zero is still death, the ordinary corpse is left behind, and the slot reopens on the spot.

## Deployable Cards

| Item | Starting charges | Effect |
|---|---:|---|
| Spike trap | 5 | Repeatedly damages enemies crossing it |
| Land mine | 3 | Explodes once, damaging a small enemy group |
| Tar | 3 | Slows enemies crossing it |

## Tower Chassis and Variants

The basic tower is the only constructible tower. It remains a `tower` building and keeps firing while one upgrade cost is delivered. It may permanently become exactly one variant; variants cannot be switched or refunded. Every chassis and every variant is permanently 3x3 — see [Placement Grid](#placement-grid).

| Variant | Family | Upgrade cost | Role | Implementation status |
|---|---|---:|---|---|
| Basic | Starter | Chassis only | Automatic single target | Implemented chassis |
| Turret | Starter | 2 wood + 2 stone | Cheap, modest single target | Implemented |
| Outpost | Starter | 5 wood + 7 stone | Durable early generalist | Implemented |
| Watch Tower | Ballistics | 6 wood + 8 stone | Low damage, rapid fire | Implemented |
| Sniper Tower | Ballistics | 8 wood + 10 stone + 1 diamond | Extreme-range burst, slow reload | Implemented |
| Brick Tower | Ballistics | 5 wood + 14 stone + 2 dust | Armored rapid fire | Implemented |
| Aggro Tower | Ballistics | 16 stone + 2 dust | Extreme health, negligible DPS, 320px taunt | Implemented; centralized enemy targeting |
| Fire Tower | Elemental | 5 wood + 8 stone + 2 dust | Direct hit plus timed burn | Implemented; explicit burn status |
| Freeze Tower | Elemental | 7 wood + 9 stone + 2 dust | Rapid damage and short slow | Implemented; shared slow status |
| Tar Tower | Elemental | 4 wood + 9 stone + 3 dust | Low damage and strong long slow | Implemented; shared slow status |
| Teleport Tower | Control | 10 stone + 3 dust + 1 diamond | Damage and spawn-edge pushback | Implemented; recorded spawn side and world clamping |
| Bomb Tower | Special | 8 wood + 10 stone + 2 dust | Slow target-centered splash | Implemented |
| Laser Tower | Special | 10 stone + 3 dust + 2 diamonds | Piercing finite line | Implemented |
| Pulse | Special | 4 wood + 6 stone + 2 dust | Automatic periodic area | Implemented |
| Shock | Special | 2 wood + 4 stone + 1 coin + 1 diamond | Manual area, movable | Implemented; relocation preserves cooldown |

Every listed variant is immediately available; each chassis accepts exactly one. Upgrade completion preserves health percentage when registry `maxHp` changes. Damaged towers can be destroyed by enemies; no repair exists yet.

Slow rule: repeated slows retain the longest remaining duration and lowest (strongest) speed multiplier. Freeze, Tar Tower, and tar ground deployables all use this interface.

## Worker Assignment

Workers have no permanent specialization. Every worker spawns **free** — the autonomous default role — and every assignment records explicit provenance: autonomous (chosen by the free-worker scheduler) or manual (placed by the player). Right-dragging and dropping assigns a manual job from the target under the cursor:

| Target | Job |
|---|---|
| Incomplete blueprint | Deliver needed wood and stone from covering storage or nearby ground drops |
| Resource node | Harvest nearby nodes of that resource |
| Lumber camp / quarry | Staff that production building |
| Stockpile / base | Haul nearby physical drops to that storage |
| Garrison | Guard that station (rejected outright when its three guard slots are full) |
| House | Reposition at that house as a free worker |
| Empty ground | Reposition there as a free worker |

### Free workers and autonomous work

A free worker searches for useful work every 0.5 simulated seconds, from its current position, in two distance tiers: local (`WORKER_LEASH`, 150px), then expanded (the tunable free-worker search radius, default 500px). One tier is evaluated completely before expanding, so nearby hauling beats a distant blueprint. Within a tier the priority is strict: **build → haul → gather**, taking the nearest viable candidate (exact-distance ties keep collection order). Viability respects build slots, stockpile staffing capacity, storage service radii, and drop reservations — a chosen hauling drop is reserved at assignment so two free workers can never pick it in one sweep.

Autonomous jobs are bounded and always return to free:

- **Gathering** is exactly one resource strike, creating the ordinary physical drop, then free — so a fresh drop can immediately trigger hauling. An objective that dies before impact resolves to free with no yield.
- **Hauling** honors its reserved drop, collects up to carry capacity or exhaustion, deposits at its chosen base/completed-stockpile destination, then goes free.
- **Building** lasts until the blueprint completes or becomes invalid, then goes free; autonomous builders never inherit the completed building's staff/haul post.

Manual jobs remain persistent: a player-assigned hauler waits at its storage, a harvester keeps its job while its node is gone, and a manual builder inherits the durable post it stood up where capacity permits. Guards are never given autonomous economy work, never borrowed for construction, and never tidy drops. A free worker with no candidate simply stays free and inert (it defends itself in melee, but runs no guard AI).

### The garrison muster

Defense is the one autonomous job that outranks the economy sweep, and it runs every frame before build/haul/gather is considered. An **autonomous** worker that is not already a guard and is not fighting, retaliating, returning from combat, fleeing or held musters when a living hostile is inside `GARRISON.threatRadius` (180px) of it *and* a completed Garrison with a free guard slot sits within `GARRISON.musterRadius` (300px). The nearest such station wins (exact-distance ties keep collection order), and naming it reserves the slot immediately — occupancy stays derived from the workers pointing at the station, so two workers can never claim one slot in the same pass. The abandoned objective is released through the normal path: claims drop and any carried load is scattered as physical resources. Guard bonuses depend on physical arrival at the post, not on the reservation. The fortified pool also scales the survival interrupt: a guard breaks off and runs for safety at 2 HP, the same fifth of its maximum that sends an ordinary worker running at 1.

Manual assignments are standing orders and are never overridden by the muster. Coming back off duty is symmetric:

- **Night** postings are binding. Dawn releases every autonomous garrison guard in one transaction at the real phase boundary (forced debug phase changes included); manual guards keep their posts.
- **Day** postings run a stand-down clock. Any living hostile inside the station's `GARRISON.guardRadius` (180px) resets it; `GARRISON.safeSeconds` (10s) of quiet releases the guard back to free.
- A reserved station that stops being a completed Garrison releases its guard immediately, in any phase, and death, pickup, cancellation or reassignment reopen the derived slot on the spot.

What a guard *gains* by standing there — the 10 HP / 2 damage kit, granted as a delta on arrival and clamped away on exit — is described once under [Garrison](#garrison); the muster only decides who walks to the post.

A new run begins with zero workers. Each completed house owns `HOUSE_SLOTS` (4) worker slots and produces one missing worker per `WORKER_SPAWN_TIME` (12-second) cycle, so multiple vacancies refill sequentially. Reassignment never changes a worker's source-house ownership, and a living worker held for dragging still reserves that house's slot. Worker death immediately frees the owning house's slot and starts replacement timing. Carried resources become physical ground drops on death, while a permanent, inert corpse remains as scenery. The base has no worker-production capacity, but remains a valid storage and hauling target. Manual jobs remain within the worker's home leash. Harvesting always creates physical ground drops.

## Design Rule

Use categories for menu organization and tags for shared systems. Cooldown UI, card stacks, pickup behavior, targeting, and activation should eventually read these tags instead of relying on building-specific conditionals.

Footprints follow the same rule: a size is declared once, on the building type (or on `RESOURCE_FOOTPRINT` for nodes), and every consumer — placement validation, ghost preview, ground pad, blueprint scaffold — derives its dimensions from that one declaration. No simulation or rendering path may restate a cell count or a pixel size of its own.
