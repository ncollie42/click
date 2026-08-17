# Reference Games

Living list of games to study for specific design problems. Copy principles, not content; record concrete observations before turning them into features.

| Game | Study for |
|---|---|
| **Clikyland** | Primary overall reference. See the detailed [tower notes](tower.md). |
| **Beaconfall** | Similar overall structure; especially workers and player actions. |
| **Super Fantasy Kingdom** | Worker roles, assignment, automation, and readability. |
| **Bills Must Be Paid** | How features are introduced incrementally without overwhelming the player. |
| **Click Mage** | Mouse-driven resource pickup mechanic. |
| **Thronefall** | Visual inspiration: vibrant popping colors, readable top-down view, unit/tower/projectile presentation, Steam page look. |

## Clikyland

Use as the broadest comparison point for the current game. Existing tower statistics, roles, strengths, and weaknesses are collected in [tower.md](tower.md).

When reviewing, capture:

- What the player does manually before automation.
- How building and defense choices compete for resources and attention.
- How new towers or systems change decisions rather than only increase power.

## Beaconfall

Study the overlap in overall structure, then focus on workers and actions.

Questions:

- How are workers assigned, reassigned, and visually distinguished?
- Which actions belong to the player, workers, or buildings?
- How does the game communicate what a worker will do before commitment?
- Where does automation remove repetition while preserving decisions?

## Super Fantasy Kingdom

Use primarily as a worker-system reference.

Questions:

- How are worker roles created and changed?
- How are idle, working, blocked, and missing-resource states communicated?
- How much direct control does the player have?
- How do worker limits create meaningful prioritization?

## Bills Must Be Paid

Study incremental feature delivery: when a mechanic appears, how it is taught, and what pressure makes it relevant.

Apply this pacing rule:

1. Introduce one new demand.
2. Let the player understand it through play.
3. Offer a tool or automation that answers it.
4. Allow a brief period of mastery.
5. Add the next pressure only after the prior system reads clearly.

This supports the existing pressure curve: **overload → automate → brief surplus → new pressure → overload**. Also use its interaction presentation as reference for hover, pickup, and placement states; see [Open Thoughts and Ideas](idea.md#3d-hover-and-selection-visualization).

## Click Mage

Study its mouse-driven resource pickup mechanic: [Steam page](https://store.steampowered.com/app/3228180/Click_Mage/).

## Thronefall

Primary visual reference. Study the look, not the mechanics.

Observations:

- Clear, vibrant colors that pop; limited palette per scene keeps everything readable.
- Top-down view similar to ours — good comparison for camera angle and scene composition.
- Enemies and towers are very readable at a glance despite minimalist shapes.
- Steam page stands out: each screenshot uses a different dominant color out the gate. Use as the bar for what our screenshots should look like — mock up what a screenshot of our game could be.

Steal directly from: units, towers, HP presentation, projectiles, and juice (hit feedback, motion, impact effects).
