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

Resources may exist in several states: loose on the ground, carried by the player or a hauling worker, stored at the base or stockpile, or delivered to construction/upgrade progress.

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

## Deployable Cards

| Item | Starting charges | Effect |
|---|---:|---|
| Spike trap | 5 | Repeatedly damages enemies crossing it |
| Land mine | 3 | Explodes once, damaging a small enemy group |
| Tar | 3 | Slows enemies crossing it |

## Tower Chassis and Variants

The basic tower is the only constructible tower. It remains a `tower` building and keeps firing while one upgrade cost is delivered. It may permanently become exactly one variant; variants cannot be switched or refunded.

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

The base supplies three worker slots; each completed house adds two. Empty slots refill automatically at their owning base or house. Jobs remain within the worker's home leash. Harvesting always creates physical ground drops.

## Design Rule

Use categories for menu organization and tags for shared systems. Cooldown UI, card stacks, pickup behavior, targeting, and activation should eventually read these tags instead of relying on building-specific conditionals.
