# Asset Inventory

Living checklist for production assets. Current canvas art is placeholder art unless marked otherwise.

## Environment

- [ ] Grass terrain tiles and variations
- [ ] Fog-of-war tile, edge, and reveal treatment
- [ ] Tree: healthy, damaged, stump
- [ ] Stone node: healthy, damaged, rubble
- [ ] Loose wood drop
- [ ] Loose stone drop
- [ ] Dust essence enemy drop, pickup, carried, and stored variants
- [ ] Temporary gold coin: idle, warning flash, pickup, carried, and stored variants
- [ ] Diamond deposit: full, damaged, exhausted, loose, carried, and stored variants

## Buildings

- [ ] Main base: healthy and damaged states
- [ ] Lumber camp: blueprint and complete
- [ ] Quarry: blueprint and complete
- [ ] Stockpile: empty plus stacked wood/stone variants
- [ ] House: blueprint, complete, spawning, and full-slot states
- [ ] Obelisk: idle, upgrade available, upgrading, complete pulse
- [ ] Basic tower chassis: idle, firing, and permanent variant states
- [ ] Pulse tower variant: idle, charging, ready, and area-pulse states
- [ ] Blast charge: idle, hover button, explosion
- [ ] Shock tower variant: ready, active pulse, cooldown, carried ghost
- [ ] Spike trap
- [ ] Land mine: armed, triggered, explosion, spent
- [ ] Tar puddle and slowed-enemy treatment

## Tower Assets

- [ ] Basic tower body
- [ ] Basic tower muzzle/firing frame
- [ ] Turret and Outpost variant details
- [ ] Watch, Sniper, Brick, and Aggro variant details
- [ ] Fire, Freeze, Tar, Teleport, Bomb, Laser, Pulse, and Shock variant details
- [ ] Basic projectile or shot beam
- [ ] Projectile impact
- [ ] Pulse-tower wave and impact
- [ ] Tower range indicator

## Units

- [ ] Generic worker: idle, walk, hurt, downed, carried, revived
- [ ] Worker job tools: axe, pick, builder hammer, hauling sack, guard weapon
- [ ] King: idle guard stance, sword attack, hit effects
- [ ] Future explorer
- [ ] Future repair unit

## Enemies

- [ ] Raider: idle, walk, melee attack, hit, death
- [ ] Archer: idle, walk, ranged attack, hit, death
- [ ] Healer: idle, walk, healing cast, hit, death
- [ ] Brute: idle, walk, heavy attack, hit, death
- [ ] Archer projectile or shot trail
- [ ] Healer beam and healing impact
- [ ] Future enemy variants
- [ ] Boss body and independently clickable parts
- [ ] Enemy health bar

## VFX

- [ ] Tree chopping debris
- [ ] Stone mining debris
- [ ] Resource pickup trail
- [ ] Resource deposit trail
- [ ] Enemy hit and death
- [ ] Tower muzzle flash and impact
- [ ] Blast-charge explosion
- [ ] Shock-tower pulse
- [ ] Upgrade accepted, depositing, and completed
- [ ] Base damage and destruction
- [ ] Fog reveal

## UI

- [ ] Hand/carry icon
- [ ] Wood, stone, dust essence, coin, and diamond icons
- [ ] Building icons for every building type
- [ ] Upgrade icons
- [ ] Activation, detonation, accept, and decline buttons
- [ ] Cooldown bar and timer treatment
- [ ] Placement-valid and placement-invalid outlines
- [ ] Action badge frame: empty, filling, and hidden states
- [ ] Axe action icon
- [ ] Pickaxe action icon
- [ ] Sword action icon

## Ground Selectors

Flat, ground-plane marks. Corners state *what* (target or footprint), arcs state
*how far* (the simulation's real gameplay radius). Buildings with no gameplay
radius get corners only and no ring, on purpose. Current shapes are generated
geometry, not art.

- [ ] Corner bracket stroke: cap/end treatment and a texture or taper to replace
      the flat quad
- [ ] One-cell action selector: valid, and a distinct "blocked/out of reach" read
- [ ] Footprint selector: placement-valid and placement-invalid tones, plus the
      neutral hover tone
- [ ] Footprint selector at 3x3, so arm length still reads proportionate
- [ ] Segmented radius ring: arc cap treatment and gap rhythm
- [ ] Second-ring treatment for taunt radius, distinct from the attack ring
- [ ] Night/day value check for every selector under the night sun tint

### VFX

- [ ] Selector arrive/leave transition (currently a hard on/off)
- [ ] Corner breath: the resting pulse, and whether a "confirmed" beat differs
- [ ] Ring opacity breath, and a firing/active variant
- [ ] Placement-rejected feedback on the footprint selector
