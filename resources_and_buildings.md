# Resources and Building Taxonomy

Living reference for resources, building categories, and behavior tags.

## Resources

| Resource | Source | Current uses |
|---|---|---|
| Wood | Trees | Construction and upgrades |
| Stone | Stone nodes | Construction and upgrades |
| Dust essence | 25% enemy death drop | Collectible and storable; spending use TBD |
| Gold coin | Temporary random spawn; flashes and vanishes after about 8 seconds | Collectible and storable; spending use TBD |
| Diamond | Five rare deposits generated more than 600px from the base | Rare mined construction/progression resource; spending use TBD |

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
│   │   ├── basic tower
│   │   ├── pulse tower
│   │   └── possible upgrades
│   │       ├── turret / outpost
│   │       ├── watch / sniper / fire / bomb
│   │       ├── teleport / freeze / tar
│   │       └── brick / aggro / laser
│   ├── reusable abilities
│   │   └── shock beacon
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
| Basic tower | Defense / Tower | `constructed`, `automatic`, `single-target`, `cooldown`, `upgradeable`, `persistent` |
| Pulse tower | Defense / Tower | `constructed`, `automatic`, `area`, `cooldown`, `persistent` |
| Shock beacon | Defense / Ability | `constructed`, `manual`, `area`, `cooldown`, `movable`, `persistent` |
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

## Possible Tower Upgrades

Reference concepts only; values should be rebalanced for this game.

| Tower | Role | Reference identity / special |
|---|---|---|
| Turret | Cheap starter | Compact, low range, expendable single-target fire |
| Outpost | Early generalist | More health, range, and damage than turret |
| Watch Tower | Rapid fire | High fire rate for groups of weak enemies |
| Sniper Tower | Long-range burst | Very high damage and range; slow firing |
| Fire Tower | Damage over time | Burns targets; fire may deal extra damage to tarred enemies |
| Bomb Tower | Area damage | Slow explosive shots damage clustered enemies |
| Teleport Tower | Crowd control | Pushes or teleports enemies backward |
| Freeze Tower | Damage and slow | Rapid shots apply chill |
| Tar Tower | Ranged slow | Applies tar slow at range |
| Brick Tower | Durable rapid fire | Watch-tower behavior with much higher durability |
| Aggro Tower | Tank / taunt | Very high durability; enemies prioritize it |
| Laser Tower | Piercing damage | Shots pass through multiple enemies |

### Possible Upgrade Families

```text
basic tower
├── rapid-fire
│   ├── watch tower
│   └── brick tower
├── precision
│   └── sniper tower
├── elemental
│   ├── fire tower
│   ├── freeze tower
│   └── tar tower
├── explosive
│   └── bomb tower
├── control
│   └── teleport tower
├── tank
│   ├── outpost
│   └── aggro tower
└── advanced
    └── laser tower
```

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
