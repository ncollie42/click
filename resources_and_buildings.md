# Resources and Building Taxonomy

Living reference for resources, building categories, and behavior tags.

## Resources

| Resource | Source | Current uses |
|---|---|---|
| Wood | Trees | Construction and upgrades |
| Stone | Stone nodes | Construction and upgrades |
| Dust essence | 25% enemy death drop | Tower variant upgrades |
| Gold coin | Temporary random spawn; flashes and vanishes after about 8 seconds | Shock tower variant upgrade |
| Diamond | Five rare deposits generated more than 600px from the base | Advanced tower variant upgrades |

Resources may exist in several states: loose on the ground, carried by the player or a hauling worker, stored at the base or stockpile, or delivered to construction/upgrade progress. Loose drops are continuous — only the *nodes* are grid-anchored.

Each run seeds 80 trees, 24 stone nodes, and 5 diamond deposits onto distinct cell centres, one node per cell (see [Placement Grid](#placement-grid)).

## Placement Grid

Everything that is *placed* lands on one shared square lattice. The simulation owns it (`CELL`, `GRID_ORIGIN_X/Y`, `GRID_COLS/GRID_ROWS` near the top of the script); rendering only consumes it.

- **Cell size is 32 simulation pixels.** The same unit as world width/height, base position, mouse position, and every building `x`/`y`. The world is 1536x1024, so the lattice addresses 49x33 cells.
- **The anchor is the centre cell.** A building's stored `x`/`y` is always a cell *centre*, never a corner. The origin is deliberately shifted back by half a cell so centres land on exact multiples of 32, which puts the base (768, 512) on a centre and makes it a valid alignment reference.
- **Footprints must be odd.** An odd `{w, h}` has a whole-cell half-extent on each side of the anchor, so a model can stay centred on the cell it is anchored to. `1x1` and `3x3` are the only sizes in use; a `2x2` would have no centre cell and is not supported.
- **The whole footprint is validated, not just the anchor.** Bounds, the build margin, and occupancy against nodes, buildings, and the base are all tested against every cell the footprint covers. A 3x3 whose anchor is in bounds can still be rejected because a corner cell overhangs.
- **The half-clipped border row and column always fail.** The half-cell origin shift makes column 0 / 48 and row 0 / 32 straddle the world edge. They remain addressable but never fully inside the world, so nothing can be placed on them. Fully interior cells are 47x31.
- **Cell occupancy is the only spacing rule between placed things.** There is no minimum distance between buildings any more. Two 1x1 deployables may sit in touching cells; they may never share one.

### Footprints

| Placed object | Footprint | Notes |
|---|---|---|
| Lumber camp | 1x1 | |
| Quarry | 1x1 | |
| Stockpile | 1x1 | |
| House | 1x1 | |
| Obelisk | 1x1 | |
| Basic tower chassis | 3x3 | The only multi-cell placement in the game |
| Every tower variant | 3x3 | Inherited from the chassis; variants declare no footprint of their own |
| Blast charge | 1x1 | |
| Spike trap | 1x1 | |
| Land mine | 1x1 | |
| Tar | 1x1 | |
| Base | 3x3 | Not placeable, but occupies cells like anything else |
| Tree | 1x1 | Blocks only while standing |
| Stone node | 1x1 | Blocks only while not depleted |
| Diamond deposit | 1x1 | Blocks only while not depleted |

The base is never placed by the player, but it reserves ground exactly like a building: a 3x3 footprint on its own cell centre, tested by the same occupancy rule and drawn with the same pad. There is no keep-out circle and no dirt clearing under it — the cells immediately outside its 3x3 are buildable.

Towers are permanently 3x3. Choosing a chassis upgrade never resizes an already-placed tower: upgrade completion swaps stats, health scale, and behaviour but leaves the anchor and the nine reserved cells untouched. The Shock Tower is the one movable tower; relocating it re-validates the same 3x3 footprint at the new snapped anchor while excluding the tower itself from the occupancy scan, and only `x`/`y` change — cooldown, health, and variant ride along.

### Depleted nodes

Trees, stone nodes, and diamond deposits each reserve exactly one cell *while active*. Felling a tree or exhausting a node clears that reservation immediately: the cell becomes buildable, but the node object does not move and does not disappear. The stump or spent rock stays on the map as scenery on the same cell it always occupied. Harvesting is therefore the way to open construction sites in a crowded forest.

### Footprint is not the other radii

Footprint occupancy answers one question only: *which cells does this object reserve so nothing else can be placed there?* It is unrelated to, and must not be confused with:

- **Model bounds.** The 3D mesh has its own dimensions and may visually overhang or under-fill its cells. Only `footprint.w/h` may be read for placement; rendering derives its pad and preview from the same values rather than restating a size.
- **Service radius.** Circles in which a lumber camp (155) or quarry (155) finds nodes, and a stockpile (175) covers drops and delivery. Still circular, still measured from the anchor.
- **Attack range.** Per-variant tower range (165 to 430) plus the Aggro Tower's 320 taunt radius. Still circular.
- **Effect radius.** Blast charge 135, land mine 65, tar 22, Pulse 145, Shock 150. Still circular.
- **Build margin.** A 45px inset from the world border, still a continuous rule; the grid only decides which cells are tested against it. (The base is *not* in this list any more — it is plain cell occupancy.)
- **Hover and drop targeting.** Picking a blueprint, stockpile, or upgrade button under the cursor is still a distance test, so two structures in adjacent cells can both be inside each other's hover range even though their footprints never overlap.

### What stays continuous

The grid governs *placement only*. Workers, enemies, the player cursor, loose resource drops, projectiles, and all movement remain free-floating in continuous world pixels. There is no pathfinding, no tile-based movement, no rotation, and no persistence of the grid between runs — `seedWorld()` simply re-rolls node anchors onto fresh unique cells each run.

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
│   └── deployables / cards
│       ├── blast charge
│       ├── spike trap
│       ├── land mine
│       └── tar
└── future
    ├── explorer building
    └── repair building
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

Footprints for every row above live in the [Footprints](#footprints) table. All of them are 1x1 except the tower chassis and its variants.

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

Workers have no permanent specialization. Right-dragging and dropping assigns behavior from the target under the cursor:

| Target | Job |
|---|---|
| Incomplete blueprint | Deliver needed wood and stone from covering storage or nearby ground drops |
| Resource node | Harvest nearby nodes of that resource |
| Lumber camp / quarry | Staff that production building |
| Stockpile / base | Haul nearby physical drops to that storage |
| House | Guard at that house, clearing the prior assignment |
| Empty ground | Guard that region |

A new run begins with zero workers. Each completed house owns two worker slots and produces one missing worker per `WORKER_SPAWN_TIME` (12-second) cycle, so multiple vacancies refill sequentially. Reassignment never changes a worker's source-house ownership, and a living worker held for dragging still reserves that house's slot. Worker death immediately frees the owning house's slot and starts replacement timing. Carried resources become physical ground drops on death, while a permanent, inert corpse remains as scenery. The base has no worker-production capacity, but remains a valid storage and hauling target. Jobs remain within the worker's home leash. Harvesting always creates physical ground drops.

## Design Rule

Use categories for menu organization and tags for shared systems. Cooldown UI, card stacks, pickup behavior, targeting, and activation should eventually read these tags instead of relying on building-specific conditionals.

Footprints follow the same rule: a size is declared once, on the building type (or on `RESOURCE_FOOTPRINT` for nodes), and every consumer — placement validation, ghost preview, ground pad, blueprint scaffold — derives its dimensions from that one declaration. No simulation or rendering path may restate a cell count or a pixel size of its own.
