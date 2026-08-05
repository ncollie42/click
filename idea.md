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

## Towers

- Add towers.

## Clicking

- Add a click cooldown so rapid clicking cannot be spammed too quickly.
- Increase the minimum click interval. Exact interval TBD.

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

## Small Interactive World Props

**Tags:** `Game Feel / Juice`, `Immersion`

- Add small interactive objects that are not required for core progression.
- Example: a crate the player can break, with a chance to drop a coin.
- Let the player pick up and reposition the crate.
- Consider other movable, breakable, or reactive world props later.
