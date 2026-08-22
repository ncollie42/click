# Open Thoughts and Ideas

These ideas may or may not be implemented. Revisit periodically to select, implement, revise, or discard them.

## Key Reason Tags

Use these tags to record why an idea matters:

- `Core Gameplay`
- `Retention`
- `Game Feel / Juice`
- `Immersion`

More tags can be added later.

## Core Ideas

### Cursor Attention Is the Real Resource

Everything competes for one mouse: gathering, hauling, fighting, building, moving, and exploring. Automation should convert repetitive cursor labor into higher-level decisions rather than remove the player's involvement.

**Target pressure curve:**

> overload → automate → brief surplus → new pressure → overload

The brief surplus matters: automation should let the player feel that they solved a problem before the game asks something new. Do not maintain constant overload.

**Design promise:**

> You start doing everything yourself. You end doing nothing by hand—and deciding everything.

Use this as a filter for new systems: each should consume cursor attention, automate an existing demand, or create a more interesting demand.

## Current Focus: Day and Night

Prototype only:

1. A two-minute day/night cycle.
2. A light daytime enemy trickle.
3. Directional enemy waves at night.

Explicitly postponed:

- Progression and unlock pacing.
- Bosses and meta-progression.
- Base repair. Later, manually delivered repair resources should compete with combat attention; the run still ends if base health reaches zero.

## Buildings

- Buildings cost resources to construct; drag resources into their blueprints.
- A special building type can pull in nearby resources automatically.

### Time-Normalized Building Costs

**Tags:** `Core Gameplay`, `Retention`

Price buildings by the time required to acquire their resources, not by arbitrary resource totals. A starter cost of 3 wood + 1 stone might represent roughly four seconds of gathering. Mid-game costs should scale with the expected acquisition-rate multiplier at that progression stage: if wood and stone arrive 40× faster, the equivalent four-second price becomes 120 wood + 40 stone.

For each resource `r`:

> `stageCost[r] = readableRound(baseCost[r] × expectedRate[r, stage] / baselineRate[r])`

Expected rate should include the whole acquisition path: click yield × action speed × uptime, crits, workers, carry capacity, travel, collection, and delivery efficiency. Prefer measured/simulated sustained rates over multiplying isolated upgrade stats.

Default to costs authored from the expected rate **when the building unlocks**, not prices that continuously rise with the player's live power. Live scaling would make gathering upgrades feel cancelled out and punish efficient play. If adaptive pricing is ever tested, treat it as an explicit difficulty system.

Validate costs by measuring actual time-to-deliver under representative early-, mid-, and late-game states. Preserve resource ratios only when their acquisition rates scale similarly; otherwise normalize wood and stone independently.

## Theme (committed): The Thing in the Ground

**Tags:** `Immersion`, `Core Gameplay`

**Genre tags (what the game is, store-page vocabulary):**
`tower defense` · `village builder` · `clicker` · `incremental` · `settlement` · `cozy` · `roguelite` · `kingdom clicker` · `simulation` · `resource management`

**The anchor — five lines:**

> A cozy village is built around a buried thing nobody understands.
> Feeding it makes the village stronger. Feeding it makes the thing louder.
> Its glow is your light — and their beacon. The light ends in a hard line; the night waits just past it.
> The night belongs to it: what comes in the dark comes because of it, not because of you.
> Whether it is a machine or a god is deliberately unanswered. The villagers argue about it too.

**Palette rule:** violet means *it* — the pit, its cracks, its orb, its dust. Timber, plaster, stone and sage mean *us*. Color is information, never decoration. Villager-built structures stay crude and human, even when wrapped around precursor things.

**Mechanical anchors the theme commits to:**

- Base delivery = feeding = progress (the sink, never a store). *Status 2026-08-22: XP is gone; the base's own three authored levels are the ladder, and deposits are storage. The theme still wants a sink — see the retirement note under "Base Delivery Grants XP, Not Storage".*
- Hunger scales the night: waves grow with total fed, not night count — the greed dial.
- Glow = radius: feeding visibly widens the light circle. Useful (vision, aura, later fog) and dangerous (the beacon they march toward). The dial is drawn on the ground.
- Enemies are connected to the thing — drawn to it, or made by it. Not random raiders.

---

Longer rationale, kept for reference: villagers dig it up, wall it in with their own timber and stone, and feed it because feeding it makes them stronger.

**What it explains, using only what already exists:**

- **Dust** leaks from the machine. It accounts for the violet already running through the palette.
- **The obelisk** is precursor technology, and is already the building that grants global upgrades.
- **Tower families already encode the split.** `Starter` and `Ballistics` are villager carpentry and masonry. `Elemental` and `Special` — fire, freeze, teleport, laser, pulse, shock — are salvaged devices switched back on. The distinction is authored in `data.js` and currently carries no fiction.
- **Base delivery granting XP** becomes a machine that returns knowledge rather than goods, which is exactly what a sink should be.
- **The archived skill-tree concept** was what the villagers learned from it. The feature is deprecated, but its `✦ ◈ ◆ ◇` visual language still reads precursor if revisited.
- **The floating orb** is a guardian that woke with the engine. (The king is already retired — the base itself now owns the defence — so this is a reskin of the base, not a replacement unit.)
- **Night gloom** is what the machine holds back, or what it attracts.

**Why not the alternatives:** committing to pure medieval means deleting the arcane towers and dust; committing to pure science fiction means deleting the villagers, the timber and the cozy manual gathering loop that is the game's main appeal. This theme keeps both and makes the contrast the point.

**Palette rule this implies:** violet means precursor, and nothing else. Villager-built objects stay timber, plaster, stone and sage. Anything glowing violet was not made by the people living there. Applied consistently, colour becomes information rather than decoration.

**Asset consequence:** structures the villagers build around precursor objects should be visibly crude and human — rough timber beams, uneven stone, simple joints. The contrast between humble containment and alien content carries the theme in a single silhouette.

## Base Delivery Grants XP, Not Storage

**Tags:** `Core Gameplay`, `Retention`

> **RETIRED 2026-08-22 — XP no longer exists.** `state.xp`, `state.level`, `LEVEL_CURVE` and
> `RESOURCE_XP` were deleted from the game. Progression is now the three authored `MAIN_BASE_LEVELS`
> (each pays one building draft) plus one buff per night survived, and wave pools widen with
> nights survived rather than anything the player feeds. Everything in this section — including the
> "Decided (2026-08-21)" line and the Machine Hunger sub-idea below — is kept as unbuilt design: the
> greed dial it argues for would have to be rebuilt on a number that still exists (deposits, base
> levels) rather than on XP.

Dropping resources at the base converts them to XP instead of storing them. Different kinds are worth different amounts.

If storage is removed, `dropToBase` is the last remaining writer to `state.stored` and otherwise has no purpose. This gives the base a permanent role and keeps the rule that everything is a sink and nothing is a bank.

**What it solves:**

- Surplus stops being dead weight. Excess wood on the ground is unbanked XP rather than clutter.
- Rare kinds get a destination. Diamond and dust currently have almost no sinks.
- It originally answered when the player earned skill picks. That prototype is now deprecated; XP thresholds drive run-local card drafts instead.

**Risk:** if every gathered resource converts to progress, gathering is never the wrong choice and the work-versus-defense tension flattens. Candidate limits: diminishing returns per phase, a cap per day, conversion only during daylight, or rare kinds worth far more so bulk hauling is not the optimal XP route.

**Decided (2026-08-21):** there is no separate "hunger" stat — **XP is the number.** `state.xp` grows with deposits (authored per-kind values), never decays, and wave difficulty is matched to it. XP thresholds grant run-local card drafts. The skill tree is deprecated and disabled. The orb defender does NOT auto-scale with XP — it improves only through explicit upgrades. The glow-ring / crack visual stage-up is deferred (see *Deferred: Glow Radius Stage-Up*).

### Machine Hunger: Feeding Scales the Night

The strongest version of the XP sink: **wave pressure scales with what you have fed the base, not with night count.** Deliver greedily and the thing gets louder; the night answers.

- Difficulty becomes player-paced — a greed dial. This solves the "gathering is never the wrong choice" risk better than caps or diminishing returns, because banking XP *is* the risky move.
- Surplus on the ground becomes a live decision: haul it in before dark for power, or leave it lying as safety.
- Feeding milestones give run structure for free: the thing wakes in stages — boss triggers, new enemy types, possibly the run's end condition.
- Telegraph it physically: rumble, brighter violet, wider pull radius. The player should *feel* they overfed before the wave proves it.

Whether the base is a machine or a living creature is deliberately undecided — the villagers do not know either. Commit only to the loop and the palette rule (violet = it, timber = us).

## Black Hole Base and Floating Orb

**Tags:** `Immersion`, `Game Feel / Juice`

Replace the castle with a black hole that visibly pulls things inward, and give the base's own automatic attack (the king is retired; the base fires) the look of a floating orb.

The fiction matches the mechanics: a base that consumes what you feed it and returns nothing is the correct read for an XP sink. The pull could be literal, drawing nearby loose drops inward, which also doubles as the auto-collect fantasy.

The orb is a costume for the base's automatic defence and removes the medieval framing without moving the role off the base.

**Open:** does the pull actually consume drops (a hazard near the base), or is it purely visual? A base that eats resources the player did not intend to spend would be a strong tension but a bad surprise.

## Aura Buildings

**Tags:** `Core Gameplay`

Buildings whose only output is a radius effect on whatever stands inside it. No production, no attack — they make everything nearby better.

The structural pieces already exist: `serviceRadius` / `effectRadius` in `BUILDING_TYPES`, the `buildingRadius()` query, and ring rendering in the scene layer.

**Why this is worth having:**

- It converts a labor problem into a placement decision. Faster gathering by placing one building beats faster gathering by dragging three more workers, which is the filter in *Cursor Attention Is the Real Resource*.
- It gives camps and clustering a reason to exist. If a boost is a radius, then where things sit relative to each other finally matters.
- A healing aura attacks the worker-death churn directly — dead workers currently cost a manual re-drag every time.

**Candidates:**

- **Chopping / mining speed.** Shortens `WORKER_HIT_COOLDOWN` inside the radius.
- **Healing (church, shrine).** Regen for workers in radius. Also a candidate answer to the open *Healing the Main Base* question.
- **Carry capacity.** Workers in radius carry more per trip, so fewer trips.
- **Movement speed.** Shortens the walk, which is the least interesting part of every loop.
- **Tower fire rate or damage.** The combat-side twin.
- **Repair.** Heals towers and structures rather than people.
- **Light.** Pushes back the night overlay. This is the seed of BEACONFALL's lighthouse — a radius that holds off darkness and could later be upgraded into a weapon.

**Open questions:**

- Do auras stack, or does the strongest one win? Stacking invites a degenerate pile of overlapping circles; highest-wins stays readable.
- Always-on, or conditional? An always-on boost is just a stat edit with a building attached. A boost that needs staffing, fuel delivery, or only works during the day is a decision.
- Where does the effect read — a ring on the emitter, a tell on each affected unit, or both? Without the second one, the player cannot tell whether a given worker is actually benefiting.
- Do economy auras and combat auras compete for the same placement budget? Making them compete is what turns them into the work-vs-defense tension rather than a free upgrade.

**Sequencing note:** do not tune a gathering-speed aura before the chop-vs-build rate ratio is measured. It is a multiplier on a number that is still moving.

## Breakable Chests

**Tags:** `Core Gameplay`, `Game Feel / Juice`

Implemented: each normal run seeds exactly one unknown, unopened 4 HP chest on a nearby free
1×1 grid cell. It blocks construction and can be right-click lifted and grid-relocated with exact
origin restoration on invalid/cancelled drops. Hold left to break it with the shared axe action badge.
The destruction roll is deferred until the fourth hit, then resolves 50/50 into:

- **Cache:** five weighted, non-expiring resources drop nearby on the ground.
- **Loot piñata:** twelve weighted, non-expiring resources burst widely onto the ground.

Both outcomes always land on the floor; breaking a chest never puts rewards directly in hand.

Wood and stone dominate the shared distribution, dust and coin remain possible, and diamond is rare.
The chest never respawns, stores no pre-rolled contents, accepts no worker assignment, and is ignored
by enemies. Only unopened chests are movable. Chest rarity and rarity telegraphing are explicitly
deferred; there is no rarity system yet.

## Drop Animations

**Tags:** `Game Feel / Juice`, `Immersion`

Add a short landing animation after successfully dropping a carried entity, especially workers and chests. Communicate weight and confirm placement: workers briefly brace or bounce; chests land with a heavier impact. Invalid or cancelled drops should keep their existing origin-restoration behavior rather than playing a landing animation.

## Ground Clutter

**Question:** If the ground is the only place loose resources live, how do we keep it readable?

Start messy and unassisted — ship the raw version first and see whether a littered forest floor reads as wealth or as noise. Two cleaner versions to test after that:

- **Stack / merge.** Drops of the same kind near each other combine into one object with a count, so ten logs are one readable pile instead of ten sprites.
- **Tidy cluster deposit.** Producers drop into an ordered arrangement near themselves (a neat stack beside the lumber camp) rather than scattering at the point of harvest.

These are not exclusive; merging is about density, clustering is about placement. Decide by looking at a mid-game screen, not in the abstract.

## Towers

- Add towers.

### Water Usage

**Tags:** `Core Gameplay`, `Immersion`

Give water a gameplay purpose beyond blocking placement. Explore either a water monster that makes shorelines dangerous, or a water tower that draws from nearby water for attacks or utility. Decide whether these ideas should interact or remain alternatives before defining mechanics.

### Resource-Fed Towers

**Tags:** `Core Gameplay`, `Immersion`

Add towers that consume physically delivered resources as ammunition or fuel. Loading them should reuse the existing resource-delivery interaction instead of subtracting directly from abstract storage.

- Stone cannon: load rocks into a small magazine; each slow shot consumes one stone and deals heavy splash damage.
- Wood furnace: burn delivered wood to sustain a flame or apply burn damage.
- Show remaining ammunition on the tower and make the empty state visibly idle.
- Start with manual loading. Worker hauling, capacity upgrades, and ammo-efficiency upgrades can follow later.
- Resource choice should create a real economy-versus-defense decision rather than a mandatory upkeep tax.

### Walls and Barricades

**Tags:** `Core Gameplay`, `Immersion`

Add placeable, destructible wall segments. Start with grid-aligned pieces that enemies attack when they obstruct a route; gates and full enemy pathfinding can follow after the basic blocker behavior proves useful.

- Progression candidate: wood palisade → stone wall → reinforced wall.
- Use neighboring wall connections to choose end, straight, corner, T, and cross visuals automatically.
- Prefer a simple neighbor-mask/autotile system first. Wave Function Collapse may be useful later for visual variation or generated ruins, but should not own gameplay connectivity.
- Define whether walls redirect enemies or merely become the first intersecting attack target before implementation.

## Clicking

Manual clicks and steady-hand holding share one player-work cooldown, tuned by `PLAYER_CLICK_CPS`. The rate applies only to direct enemy attacks and tree, rock, or diamond gathering; other interactions remain immediate.

### On-Click and On-Death Spectacle

**Tags:** `Core Gameplay`, `Game Feel / Juice`

Clicks can gain chance-based spatial procs. Favor effects that visibly travel through or alter the world—not invisible damage modifiers—and occasionally let a proc become excessive enough to create a memorable screen-clearing moment.

**On enemy click candidates:**

- **Chain lightning:** arcs to nearby enemies, with rare extra jumps or a fork into two chains.
- **Piercing beam:** continues through the clicked enemy in the cursor-to-target direction and hits everything in a narrow line.
- **Ground fissure:** a crack races away from the target, damaging and briefly staggering enemies it crosses.
- **Shockwave:** an expanding ring damages or knocks enemies outward; clusters scatter visibly.
- **Gravity pulse:** pulls nearby enemies into the clicked point, then bursts after a short telegraph.
- **Ricochet shard:** launches toward several nearby targets with clear target-to-target trails.
- **Delayed sky strike:** marks the ground, then drops a large bolt or meteor; enemies can move into or out of it.
- **Echo click:** repeats the hit at the same world position after a short delay, potentially creating rhythmic cascades.
- **Storm jackpot:** a very rare proc repeatedly strikes random enemies across the visible battlefield for a few seconds.

**On enemy death candidates:**

- Chance to explode, damaging nearby enemies and strongly throwing debris outward.
- Chance to spawn a tree at the death position, turning combat into future wood and temporary terrain clutter.
- Chance to launch seeking sparks from the corpse into surviving enemies.
- Chance to leave a short-lived damaging or slowing patch on the ground.
- Chance to split into several harmless resource motes or collectible drops that scatter spatially.
- Other options TBD.

Procs should originate at the clicked/dead enemy and preserve readable direction, radius, and timing. Rare upgrades may increase jump count, radius, duration, or projectile count rather than only damage. Decide whether secondary hits may trigger more procs; unrestricted recursion is exciting but needs a hard event budget to prevent hangs.

## Resource-Drop AOE

**Tags:** `Core Gameplay`

A full hand can become a weapon: dropping carried resources over enemies deals 1 AOE damage per resource held before the drop. Hand-capacity upgrades therefore become an alternate combat build.

Prevent repeatedly picking up and dropping the same resources for free infinite damage. Candidate rules: consume thrown resources, give the hand-drop attack a cooldown, or mark each resource unable to damage again until delivered and regathered.

## Picking Up Enemies

- Let the player pick up light enemies and drop them elsewhere using the same right-drag interaction as workers.
- Dropping a carried enemy deals AOE impact damage to units around the landing point.
- Heavy enemies remain uncarryable; define weight by authored enemy data rather than scattered type checks.
- Decide whether carrying pauses the enemy, whether drops require valid ground, and whether enemies can be dropped into hazards or tower range.
- Decide whether impact damages enemies only, everyone nearby, or the dropped unit too.
- Keep worker assignment priority and resource collection unambiguous when targets overlap.

### Capture Building — SHIPPED as the Capture Yard

**Tags:** `Core Gameplay`, `Retention`

Shipped rules (see CONTEXT.md "Enemy Capture" for vocabulary):

- The **Capture Yard** is a 3x3 constructed building (8 wood + 8 stone, 3 build slots) dealt by the rare `bpCaptureYard` build card. The card is draft-gated behind the Enemy Pickup buff through authored `requires` metadata — it never appears in an offer before the buff is owned.
- Dropping a carried light enemy onto a **completed, non-full** yard converts it instantly — no recruitment timer. The unit keeps its authored type/variant/abilities and its current HP; hostile statuses, tower retaliation, and wave membership are cleared. Capturing an active-wave enemy removes it from clearance accounting like a kill.
- Each completed yard supports **three living controlled enemies**; occupancy is derived by counting living linked units and a slot reopens only when one dies. A full or unfinished yard rejects the drop and restores the enemy to its exact pickup origin.
- Controlled units guard around their source yard with their authored combat kit (raiders melee, archers ranged); controlled healers heal allied units instead of hostiles. Hostiles target and kill them through the ordinary damage pipeline.
- Snowballing is limited by per-yard capacity plus the yard's build cost per +3 force; heavy enemies remain uncapturable by the pickup weight rule.

## Fog and Expansion

**Question:** How should fog and expansion work?

Manually clicking fog becomes annoying. There is currently no reason not to click everywhere for a while.

- A human explorer could eventually reveal territory.
- We also need other ways to expand or clear fog.

**Candidate answer (2026-08-13): fog is a resource — you mine it.**

Fog cells are hard nodes, chipped at exactly like trees and rocks: hold-click to break, workers assignable to it, same interaction vocabulary everywhere.

- **Early game it is too tough to break** — a fog cell takes so many hits that clearing one by hand is not worth the clicks. That kills the "no reason not to click everywhere" problem: the gate is cost, not a rule. The existing `hardness` upgrade ("mine tougher resources") is already the key that opens it.
- **Same automation flow as everything else:** assign workers to a path or frontier post and they grind the fog for you; worker upgrades speed it up. Exploration climbs the exact cut→carry→feed automation ladder instead of needing its own system.
- **Mining fog should yield something** — dust is the natural drop (the fog is the thing's breath, violet = it). Clearing frontier literally pays, and dust finally gets a faucet to match its sinks.
- Fits the theme loop: the glow pushes fog back passively (deferred glow-radius idea), mining is the active version — the village chews the dark faster than the light grows.

Open: does fog regrow at night? Regrowth would make frontier posts a holding action and pair well with hunger-scaled nights.

### Clouds at Extreme Zoom-Out

**Tags:** `Immersion`, `Game Feel / Juice`

When the camera zooms out beyond the normal play range, clouds drift over the world and increasingly obscure the ground. This makes the distant overview feel atmospheric while visually masking detail the game no longer needs to present clearly.

## Deferred: Glow Radius Stage-Up

**Tags:** `Game Feel / Juice`, `Immersion`

Parked from the base/XP design: feeding visibly widens the thing's light circle — glow radius drawn on the ground as the difficulty readout, cracks spreading a ring of cells at each XP threshold, rumble/pulse on crossing. The player should feel "I just made it worse" a full day before the night proves it. Revisit once XP-scaled waves are in and tuned; the mechanic works without the visual, the visual is the juice pass.

## TODO: Worker State Machine Rework

**Tags:** `Core Gameplay`

Workers currently encode their behavior in scattered booleans (`returning`, `starved`, `returnAfterCombat`, `taskTarget`, `combatTarget`, `staffingArrivedAt`) with implicit priority rules in `updateWorker`. That IS a state machine — written in flags.

**Target shape:**

- **Tagged union for state:** `worker.state = {type:"...", ...payload}`, one update function per `type`, dispatched on the tag. Illegal combinations become unrepresentable instead of policed.
- **Two layers:** `job` stays the ROLE (long-term, what manual placement or the free-worker scheduler assigns); the tagged state is the OBJECTIVE (short-term: fetching this drop, fleeing, returning to post).
- Refactor behavior-preserving first — same observable behavior, flags folded into the union one at a time. New behaviors land after, as new tags.

Sequencing note: small visible behaviors (flee, idle texture, opportunistic pickup) do not require this refactor and should not wait for it. Refactor when the flags actually start hurting.

## Autonomous Work Legibility

Historical note: blueprint recruiting once borrowed idle guards on a `homePost` loan and marked them with a diamond overlay. That system is gone — workers now spawn **free** and pick their own bounded work (build → haul → gather, local tier before expanded). What survives: hovering a blueprint still draws lines to its assigned builders, manual or autonomous.

Related open question: with free workers gathering and hauling on their own, does dropping a worker directly on a resource node still earn its place? Track it by noticing how often you still do it. If "basically never," delete the manual `harvest` job and route everything through camps.

## Assigning NPC Work

**Question:** How should little NPCs be assigned work, and how do we tell them where to go?

- Are workers permanently connected to their building?
- Can workers be reassigned?
- Where do resource collectors go?
- How is a collector's drop-off destination chosen?

## Healing the Main Base

**Question:** How should the main base be healed?

- Buy healing like an upgrade or power-up?
- Create a unit that repairs it automatically?
- Deliver repair resources manually?

## Boss

- Create a boss.
- Could defeating it require clicking different body parts?

## Cards and Charges

- Represent limited-charge items or buildings as cards.
- A card's stack count shows how many placements or uses remain.
- Examples: spike traps, walls, blast charges, and other consumable structures.

## Deferred: Run Upgrade Ledger and Live Counters

**Tags:** `Core Gameplay`, `Retention`

Implement later:

- Keep a compact bottom-of-screen ledger showing every card received this run and remaining charges where relevant.
- Keep a persistent counter window for live DPS and resource production/collection.
- Derive the ledger from run-owned card/upgrade state; do not maintain duplicate UI state.
- Derive DPS from actual damage events over a rolling window, not theoretical tower stats.
- Derive resource rates from actual resource events. Decide whether the window shows gathered, delivered, or both before implementation.

The display should remain readable when many upgrades accumulate; likely collapse repeated upgrades into one entry with a count.

## Enemy Mining and Remote Worker Camps

**Tags:** `Core Gameplay`

Add a dedicated **enemy worker** unit, separate from player workers and combat enemies. It mines world resources, hauls them for the enemy faction, and constructs worker-producing camps. This creates a visible enemy economy the player can disrupt instead of spawning every enemy for free.

**Placement rule:** enemy construction must never occur near the player settlement. Camps belong at the remote frontier—preferably in fog—and need a hard exclusion radius around the base and player buildings. If no valid remote site exists, construction waits or fails; it must not fall back to building nearby.

Open questions:

- Do enemy miners use the same finite trees/rocks as the player, steal loose drops, or both?
- Can destroying a camp refund its stored resources?
- Do camps produce new enemy workers continuously, in batches, or only after resource deliveries?
- Does the enemy worker flee from combat, defend itself weakly, or require escorts?
- How is distant construction telegraphed before the first worker arrives?

## Resource-Thief Enemy

- Add an enemy that steals loose or stored resources.
- Decide whether it targets ground drops, stockpiles, collectors, or the main base.
- A successful thief may attempt to escape the map with its stolen resources.

## Stomper Enemy: Damage Everything Nearby

**Tags:** `Core Gameplay`, `Game Feel / Juice`, `Immersion`

Add a large enemy with a clearly telegraphed radial stomp. Its impact uses one world hitbox that damages everything in range—not only combat targets—including workers, buildings, trees, rocks, diamonds, and other damageable props.

This makes the battlefield itself vulnerable: fighting near valuable resource clusters can destroy future income. Decide whether the stomp also damages allied enemies, whether resource destruction produces ordinary drops, and whether damage is flat or falls off from the center.

## King and Base Defense — RESOLVED (no king)

The role shipped without the unit. The **completed main base** defends itself — nearest visible
enemy on `MAIN_BASE.range`/`damage`/`rate`, reusing the tower buffs, auras and fog rules — and the
king record, model and palette roles were deleted. The open questions below are therefore answered
by construction: the defender cannot move, is not picked up, is not commanded, and cannot be
"defeated" separately from the base, whose destruction is still the run-loss condition. Base
upgrades come from `MAIN_BASE_LEVELS`, not from upgrading a unit.

Still open, if the fiction is ever revisited: the floating-orb reskin below would change *what the
defender looks like*, not who owns the attack.

## Garrison — SHIPPED

**Tags:** `Core Gameplay`, `Cursor Attention Is the Real Resource`

The colony's answer to "my workers keep dying" is a place to stand, not a new unit (see CONTEXT.md "The Garrison" for vocabulary).

- The **Garrison** is a 1x1 constructed building (6 wood + 6 stone, 2 build slots) dealt by the common, ungated `bpGarrison` build card. It is drafted like any other build and is not in the starting hand.
- It **converts existing workers**. Three guard slots, no production, no attack, no population, no new unit of any kind. Standing a worker in a slot is paying gathering throughput for defense — that opportunity cost is the design.
- **Manual guards** are standing orders: right-drag a worker in (or finish building the garrison with a manual builder, which inherits the post) and it stays until you move it.
- **Autonomous guards** are the muster: any free-ish autonomous worker with a hostile within 180px runs to a garrison within 300px, ahead of build/haul/gather. Night postings hold; dawn releases the whole autonomous roster in one transaction; a quiet day releases them after 10 seconds with no hostile inside the station's 180px guard radius. Manual guards are exempt from both.
- **The kit is earned by arriving**, not by being ordered: standing at a live completed garrison doubles a worker to 10 max HP and 2 damage. It is granted as a max-HP delta (a wounded 3/5 becomes 8/10) and clamped away on exit, so it can never full-heal a guard and never kill one by subtraction. Death at zero is unchanged.
- Snowballing is limited by the three slots per garrison, the build cost per extra station, and the fact that a guard is a worker who has stopped working.

## Barracks and Commandable Units

Still unbuilt, and deliberately **not** the Garrison: a barracks would *produce* warriors of its own, where the Garrison only re-roles workers the colony already has. Keep `bpBarracks` a separate concept card.

- Add barracks that create an army for the player.
- Let the player choose which unit type to recruit.
- Unlike towers, army units can move and enter fog.

**Command questions:**

- Command units using right-click?
- How do we select only a few units?
- Manually pick units up and drop them at a destination?
- Use RTS selection similar to StarCraft II?
- Use boid-like groups that follow objective points rather than controlling every unit?
- How do commands coexist with right-click resource collection and building movement?

## 3D Hover and Selection Visualization

- In a future 3D version, make hover interactions feel like *Bills Must Be Paid*.
- Hovered or picked-up units/buildings could lift from the ground, gain a selection ring, scale slightly, or be held by a visible hand.
- Use strong shadows, outlines, and height changes to distinguish hover, selection, pickup, and placement states.

**Purpose:** make interaction state and valid targets easier to visualize.

## Skill Tree (Deprecated)

Deprecated and disabled on 2026-08-21. The source snapshot lives in `src/deprecated/skill-tree/` in case the design is revisited.

**Historical purpose:** retention, replayability, and incremental progression.

- Add a skill tree with persistent or run-specific unlocks.
- Decide when the player gets opportunities to select skills.
- Possible timings: elapsed-time milestones, boss defeats, upgrade completions, exploration milestones, or after a run ends.
- Decide whether choices are permanent, reversible, or reset each run.

## Building and Tower Visual Overhaul

**Tags:** `Immersion`, `Game Feel / Juice`

Bring every building and tower up to the key-art style while keeping what already charms (the current stone keep stays — it moves next to the pit rather than being replaced). Shared style rules live in `docs/asset-prompts.md`: one reusable style block + per-asset prompts, so every generation matches the set.

- Palette rule enforced per asset: violet/cyan only on precursor elements; villager builds stay timber/plaster/stone.
- Tower families carry the fiction: Starter/Ballistics pure carpentry; Elemental/Special = one salvaged violet device mounted on the plain chassis.
- First three: main base (keep + hole), house, basic tower chassis. Backlog listed in the prompts file.

## Sharing: GitHub Pages

**Tags:** `Retention`

The game is a pure static site (~370 KB gzipped total, no backend, no build step) and the repo already lives at `github.com/ncollie42/click`. three.js is vendored at `vendor/three.module.min.js` so the build has zero external dependencies.

**Setup (one-time):** repo Settings → Pages → Deploy from a branch → `main` / `(root)`. The game then serves at `https://ncollie42.github.io/click/`, and the Machinations bench at `.../click/docs/greed-dial.html`. Every push to main redeploys automatically.

**Later considerations:** itch.io upload when it is time for real playtest feedback (that is where the genre's audience is); decide whether shared builds keep the view-debugger panel (leaving it in = free QA); a `?debug` query flag is the cheap middle ground.

## Kanban Agent for Idea Flow

**Tags:** `Retention` (of ideas, not players)

This file is a good capture net but a bad workflow: ideas pile up with no state — nothing marks what is proposed vs decided vs in-progress vs shipped vs discarded, and nothing resurfaces stale entries.

**Idea:** a recurring agent run that treats `idea.md` as a kanban backlog:

- Parse sections into cards; infer state from the existing markers (`Decided`, `Deferred`, `TODO`, `Open`, `committed`).
- Cross-check against git log to auto-move cards: an idea whose feature landed gets marked shipped with the commit hash.
- Surface the 3 oldest untouched ideas each run — revisit, promote, or explicitly discard ("Revisit periodically" is this file's own header, currently done by nobody).
- Output either a reorganized idea.md (states as sections) or a small `docs/board.html` artifact next to the Machinations bench.

Could run as a scheduled Claude routine or just be a manual `/board` skill invoked at the start of a session. Start manual; automate only if the manual version proves worth reading.

## Stats and Pacing

- Track how long people play.
- Track the point where players stop playing.
- Time important gameplay events.
- Change the pace or introduce a new mechanic approximately every 6–9 minutes.
- Reassess the interval using player-session data.

## Destructible Environment and Path Clearing

**Tags:** `Core Gameplay`, `Immersion`

Destruction should lead somewhere rather than exist only for decoration.

- Place rubble, fallen trees, brambles, ruined walls, or boulders that block movement, enemy routes, service coverage, or building placement.
- Let the player remove obstacles by repeatedly clicking to crack and break them. Clearing terrain competes directly for cursor attention.
- Every obstacle should produce a meaningful result: open a shortcut, expose a resource patch, reveal a build site, connect service zones, or uncover a small reward.
- Breaking barriers can be a tradeoff: opening a useful route for workers may also create a shorter enemy approach.
- Let obstacle material determine its drops: fallen trees yield wood, boulders yield stone, ruins may hide coins or dust.
- Telegraph what lies beyond enough to create a decision, without revealing the exact reward.
- Possible later automation: workers clear marked obstacles slowly, while manual clicking remains faster.

Related ideas:

- Enemies may break weak barriers and gradually create new attack routes.
- Movable barricades could let the player close one path while opening another.
- A night wave could arrive through a previously safe route after destroying its blockage.

## Small Interactive World Props

**Tags:** `Game Feel / Juice`, `Immersion`

- Add small interactive objects that are not required for core progression.
- Example: a crate the player can break, with a chance to drop a coin.
- Let the player pick up and reposition the crate.
- Consider other movable, breakable, or reactive world props later.
