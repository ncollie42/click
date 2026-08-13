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

## Ground Clutter

**Question:** If the ground is the only place loose resources live, how do we keep it readable?

Start messy and unassisted — ship the raw version first and see whether a littered forest floor reads as wealth or as noise. Two cleaner versions to test after that:

- **Stack / merge.** Drops of the same kind near each other combine into one object with a count, so ten logs are one readable pile instead of ten sprites.
- **Tidy cluster deposit.** Producers drop into an ordered arrangement near themselves (a neat stack beside the lumber camp) rather than scattering at the point of harvest.

These are not exclusive; merging is about density, clustering is about placement. Decide by looking at a mid-game screen, not in the abstract.

## Towers

- Add towers.

## Clicking

Manual clicks and steady-hand holding share one player-work cooldown, tuned by `PLAYER_CLICK_CPS`. The rate applies only to direct enemy attacks and tree, rock, or diamond gathering; other interactions remain immediate.

## Picking Up Enemies

- Let the player pick up enemies and drop them elsewhere using the same right-drag interaction as workers.
- Decide whether carrying pauses the enemy, whether drops require valid ground, and whether enemies can be dropped into hazards or tower range.
- Keep worker assignment priority and resource collection unambiguous when targets overlap.

## Fog and Expansion

**Question:** How should fog and expansion work?

Manually clicking fog becomes annoying. There is currently no reason not to click everywhere for a while.

- A human explorer could eventually reveal territory.
- We also need other ways to expand or clear fog.

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

## Resource-Thief Enemy

- Add an enemy that steals loose or stored resources.
- Decide whether it targets ground drops, stockpiles, collectors, or the main base.
- A successful thief may attempt to escape the map with its stolen resources.

## King and Base Defense

- Add a king who lives at the castle and automatically defends the main base.
- Decide whether the king can move, receive upgrades, be manually picked up, or be directly commanded.
- Decide what happens if the king is defeated.

## Barracks and Commandable Units

- Add barracks that create an army for the player.
- Let the player choose which unit type to recruit.
- Unlike towers, army units can move and enter fog.

**Command questions:**

- Command units using right-click?
- How do we select only a few units?
- Manually pick units up and drop them at a destination?
- Use RTS selection similar to StarCraft II?
- Use boid-like groups that follow objective points rather than controlling every unit?
- Can the king command nearby units?
- How do commands coexist with right-click resource collection and building movement?

## 3D Hover and Selection Visualization

- In a future 3D version, make hover interactions feel like *Bills Must Be Paid*.
- Hovered or picked-up units/buildings could lift from the ground, gain a selection ring, scale slightly, or be held by a visible hand.
- Use strong shadows, outlines, and height changes to distinguish hover, selection, pickup, and placement states.

**Purpose:** make interaction state and valid targets easier to visualize.

## Skill Tree

**Purpose:** retention, replayability, and incremental progression.

- Add a skill tree with persistent or run-specific unlocks.
- Decide when the player gets opportunities to select skills.
- Possible timings: elapsed-time milestones, boss defeats, upgrade completions, exploration milestones, or after a run ends.
- Decide whether choices are permanent, reversible, or reset each run.

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
