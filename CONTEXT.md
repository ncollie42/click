# Wooddrop Domain Context

Shared language for design, code, UI, and tests. Prefer these terms consistently so definitions and usages remain searchable.

## Enemy-Wave Difficulty

### Wave Threat Budget

The total combat power a wave composer may spend. This replaces wave size as the primary difficulty value because equal budgets may produce different numbers of enemies.

Example: a budget of 100 could produce 100 enemies costing 1 each, 10 costing 10 each, 2 costing 50 each, or a mixed composition.

### Threat-Budget Curve

The mathematical function mapping wave number to Wave Threat Budget. Authored defaults are `startBudget`, `targetBudget`, `targetWave`, and `power` in `WAVE_THREAT_CURVE`; the debugger copies them into runtime tuning and may recompose the upcoming wave. An active Spawn Plan never changes.

Current normalized power curve:

```text
t = clamp((waveNumber - 1) / (targetWave - 1), 0, 1)
budget = round(startBudget + (targetBudget - startBudget) * t^power)
```

`power = 1` is linear. Values above 1 delay growth and steepen the finish; values between 0 and 1 front-load growth. The clamp intentionally holds at the target until another curve segment is authored. A forced authored boss imposes its Threat Cost as a minimum budget on its scheduled wave, so the plan and UI never hide boss threat outside the displayed total.

### Threat Cost

The authored amount of Wave Threat Budget consumed by one enemy. Use `threatCost` in data and code; do not call it score, weight, level, or scaling.

Threat Cost estimates practical combat pressure. HP, damage, speed, range, abilities, and support synergy inform it, but those base stats do not scale with run time.

### Spawn Pool

The enemy types currently eligible for composition. Progression unlocks new authored enemy types and variants by adding them to this pool; it does not increase existing enemies' HP or damage.

### Enemy Variant Band

A fixed-stat, shared-color difficulty band applied consistently across archetypes. Every current archetype has three authored enemies: base (wave 1+), blue Veteran (wave 4+), and red Elite (wave 7+). Variants have their own Threat Cost and Spawn Weight; no runtime stat scaling creates them.

### Spawn Weight

The authored relative likelihood that an eligible enemy is selected. Spawn Weight controls frequency; Threat Cost controls budget consumption. Never use one value for both concerns.

### Enemy Weight Tag

The physical pickup class authored as `weightTag` on every enemy definition. Current closed values are `light` and `heavy`; Enemy Pickup may lift only `light` enemies. Weight Tag controls interaction only. It is unrelated to Threat Cost (wave pressure), Spawn Weight (composition likelihood), variant tier, model scale, or HP.

### Spawn Plan

The ordered enemy list produced by spending a Wave Threat Budget against the Spawn Pool. The plan is fixed when the wave begins so later progression changes cannot alter an active wave.

### Wave Composer

The system that creates a Spawn Plan. It repeatedly selects an eligible enemy that fits the remaining Wave Threat Budget, using Spawn Weight for selection. A cost-1 filler enemy should remain available so the budget can always be spent exactly.

### Active Threat

The sum of Threat Cost for all living enemies belonging to the active wave.

### Active Threat Cap

The maximum Active Threat normally allowed on the battlefield at once. It controls concurrent combat pressure independently from the total Wave Threat Budget.

### Active Enemy Cap

The maximum number of enemies allowed alive at once. This is a performance safeguard, not the primary difficulty control. Keep it separate from Active Threat Cap.

### Forced Boss Spawn

One or more named enemies reserved in a specific wave through that wave's ordered `WAVE_BOSS_SPAWNS` list. Their combined Threat Cost is deducted before weighted composition; they close the Spawn Plan and remain part of the displayed Wave Threat Budget. Wave 5 schedules one `bruteBoss`; the wave-10 finale schedules three.

### Authored Squad

A later composition unit containing a deliberate enemy combination, such as a healer escort. A squad has a combined Threat Cost and preserves synergies that independent weighted selection cannot express reliably.

## Enemy Capture

### Controlled Enemy

A converted hostile that fights for the player. It keeps its authored enemy type, variant, and abilities and the HP it had at capture, and lives in the simulation's dedicated `controlledEnemies` collection. A Controlled Enemy is **not** a hostile wave member, not a worker, and not a Friendly Brute — never merge it into those collections or their accounting. Capture clears every hostile-only reference: burn/slow statuses, tower retaliation, and wave membership (capturing an active-wave enemy removes it from clearance accounting like a kill).

### Source Capture Yard

The one completed Capture Yard a Controlled Enemy is linked to via `sourceYard`. The unit guards inside the yard's authored guard radius and returns to the yard when no hostile is present; controlled healers heal allied units (controlled enemies and Friendly Brutes), never hostiles.

### Capture Yard Capacity

Three **living** Controlled Enemies per completed yard (`CAPTURE_YARD.capacity`). Occupancy is always derived by counting living linked units — there is no stored slot counter — so a slot reopens only when a linked unit dies. A full or unfinished yard rejects a capture drop and restores the held enemy to its exact pickup origin. Multiple yards are independent: each provides its own three slots.

The `bpCaptureYard` build card is draft-gated behind the Enemy Pickup buff through authored `requires` metadata; only light enemies (see Enemy Weight Tag) can be carried, so only they can be captured.

## The Opening

### Pre-Wave

The clock state a run **boots into**, alongside day and night (`state.clock.phase === "pre-wave"`, `src/game/simulation.js`). It is the untimed opening: no countdown, full daylight, no wave scheduled or forecast, and no path into night. Everything else runs normally — gathering, cards, camera, construction delivery, elapsed run time and debug inspection.

Pre-Wave is entered once, at world load, and left exactly once, when the Main Base is completed. That is its **only** exit: no timer, no phase button and no debug command can flip it (the phase commands refuse while it lasts). Completing the base sets `state.baseLevel` to 1 and starts **day 1 with the full `DAY_DURATION`**; day/night pacing from then on is unchanged.

### Base Standing

Whether a base exists at all, answered by `state.baseLevel > 0` (`mainBaseStanding()`) and by nothing else — not by the presence of a building record. Every base service reads it: storage deposits and hauling, the health target, enemy target selection, the hover action, the map centre's attack, and the rendered structure. While no base stands the map centre is bare reserved ground; an enemy with no other valid target idles rather than attacking an absent base. The showcase fixture world starts standing (level 1) with no construction record behind it.

## Run Progression

### Base Level

The run's **only** progression number: `state.baseLevel`, 0 before the Main Base stands and then the authored `level` of the `MAIN_BASE_LEVELS` entry it has reached (maximum 3, `MAIN_BASE.maxLevel`). There is no player level and no experience — `state.xp`, `state.level`, `LEVEL_CURVE` and `RESOURCE_XP` were deleted on 2026-08-22 along with the level-up draft they paid. Completing an ordinary building now grants the building and nothing else.

### Reward Draft

A pick-one-of-up-to-three offer drawn from the Card Pull, in one of three closed kinds. `base` is paid by each completed Base Level and draws buildings only — it is the only source of build cards after the opening hand. `dawn` is paid by surviving a night and draws permanent buffs only. `consumable` is paid by a chest or a Consumable Forge batch and draws consumables. Backlog priority is base → dawn → consumable; exactly one offer is live at a time and the world is frozen while it pends.

### Card Pull

The run's finite deck of draftable cards, containing each card ID once and recording which remain and which were given. Only the chosen card is removed for the rest of the run; rejected and rerolled cards remain, newly eligible cards join immediately, and a reward earned from an empty category is discarded.

A Reward Draft may contain fewer than three cards near exhaustion. Rarity still weights selection among remaining cards; rerolls avoid the rejected batch when alternatives exist, but are refused without charge when no card can change.

### Wave Tier

Which authored Spawn Pools the night composer may choose from: `min(4, floor(nights begun / 2))`, so tier 0 covers waves 1-2, tier 1 waves 3-4, and tier 2 waves 5 and up. It rides **nights survived** — never the Base Level, the hand, or anything the player buys. Difficulty size stays with the Threat-Budget Curve; the tier only widens the roster.

## Worker Capacity

### Worker Limit

The maximum number of workers that may be assigned to a **completed** building at once. It is authored per building as `jobSlots` on that building's definition, and absence means zero — a house, tower or obelisk holds nobody. Work camps and quarries author 2, the stockpile 2, the scout hut 2 (`SCOUT_HUT_SLOTS`), and the garrison 3 (`GARRISON.capacity`). The main base authors 2 on `MAIN_BASE.jobSlots` and deliberately **not** on its `BUILDING_TYPES.mainBase` row: that row is the construction *site*, while the completed base's post is the `BASE` anchor (see Base Standing), and a second `jobSlots` there would open a competing pool at the same coordinates. Resource nodes are not buildings and use the single global `RESOURCE_NODE_JOB_SLOTS` instead.

Four rules hold for every Worker Limit, so no building may invent its own staffing machinery:

- **Occupancy is derived, never stored.** A post's assigned count is computed by counting the workers whose job and `jobTarget` match that building. There is no slot counter on the building, so a slot can never leak: a worker that dies, is picked up, is reassigned, or whose building stops being complete simply stops being counted.
- **Assignment reserves immediately.** Naming a post claims its slot the instant the assignment is recorded, before the worker has travelled a single pixel. Two workers can therefore never claim one slot in the same pass, and a full or unfinished building rejects a drop outright rather than leaking the worker onto the ground beside it.
- **Held workers keep their reservations.** A worker lifted for dragging is still assigned, so it still occupies its slot. Picking a staffer up does not open its post for someone else, and putting it back does not overfill the post.
- **Arrival is a separate fact.** Reaching the post is what grants post-specific bonuses (see Fortified Guard Kit); the reservation alone grants nothing.

Worker Limit is **not** either of the two other capacity numbers, and the three must never be merged:

- **Build capacity** is `buildSlots` — how many workers may staff a building *while it is still a construction site*. It is consumed before completion, is the number the buildCapacity buff grows, and drops to zero relevance the moment the building finishes and its Worker Limit takes over.
- **Population** is `HOUSE_SLOTS` — how many workers one completed house *creates and owns*. Population says where workers come from; Worker Limit says how many may stand somewhere. A house has population and no Worker Limit at all; a garrison has a Worker Limit and no population. Reassigning a worker never changes which house owns it.

## The Garrison

### Garrison

The constructed 1x1 defense station that converts existing workers into stronger guards. It is dealt by the common, ungated `bpGarrison` build card, costs 6 wood + 6 stone, and takes 2 build slots. A Garrison **creates nothing**: no warrior, no population, no resource, and it has no attack of its own. Never call it a barracks — the unimplemented Barracks concept would *produce* an army, where the Garrison only borrows workers the colony already has.

### Guard Slot

One of a completed Garrison's three posts (`GARRISON.capacity`, which is also the building's `jobSlots` — the count is declared once). Occupancy is always **derived** by counting the workers whose job is `guard` and whose `jobTarget` is that Garrison, held workers included; there is no slot counter on the building. Naming a station reserves its slot immediately, before the worker has travelled. A full or unfinished Garrison rejects a drop and restores the worker to its pickup origin and prior assignment.

### Manual Guard

A guard with `autonomous:false`, created by the player right-dragging a worker onto a completed Garrison, or by a manual builder inheriting the post it just finished building. A Manual Guard is a standing order: it has no demobilization clock, dawn never releases it, and the Muster never re-posts it.

### Autonomous Guard

A guard with `autonomous:true`, raised by the Muster. It is temporary by design and always returns to **free** — never to its previous job.

### Muster

The autonomous defense pass that runs every frame *before* the free-worker build/haul/gather sweep. An autonomous, non-guard worker that is not fighting, retaliating, returning from combat, fleeing or held musters when a living hostile is within `GARRISON.threatRadius` (180) of **the worker** and a completed Garrison with an open slot is within `GARRISON.musterRadius` (300). Nearest station wins; exact-distance ties keep collection order. Abandoned claims are released and any carried load is scattered as physical drops.

### Fortified Guard Kit

The stat upgrade a guard holds **only while standing at a live completed Garrison it is posted to** — job `guard`, valid station, and arrival recorded. Effective maximum health becomes `GARRISON.maxHp` (10, against `WORKER_HP` 5) and melee damage becomes `GARRISON.damage` (2, against `WORKER_DAMAGE` 1); a posted guard detects and pursues hostiles up to `GARRISON.engagementRadius` (400) from its post, while melee reach and attack cadence are unchanged. The low-health survival interrupt scales with the pool (a fortified guard runs for safety at 2, an ordinary worker at 1). The kit is granted as a max-HP **delta** on arrival (5/5 → 10/10, a wounded 3/5 → 8/10) and withdrawn as a **clamp** on exit (10/10 → 5/5, 2/10 → 2/5). Orders and reservations grant nothing — only arrival does. Death at zero is unchanged.

### Dawn Stand-Down

The single transaction at the real night→day boundary (forced debug phase changes included) that releases **every** Autonomous Guard at once. Night postings are otherwise binding and never time out. During the day an Autonomous Guard instead runs a stand-down clock: any living hostile inside `GARRISON.guardRadius` (180) of its station resets it, and `GARRISON.safeSeconds` (10) of quiet releases the guard to free. Manual Guards are exempt from both.

## Enemy Scaling Rule

Existing enemy types retain their authored HP, damage, and other stats for the entire run. Late difficulty comes from larger Wave Threat Budgets, changed Spawn Pools, authored variants, squads, and spawn topology. A basic early enemy becoming one-hit fodder later is intentional.
