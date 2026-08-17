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

A named enemy reserved exactly once in a specific wave through `WAVE_BOSS_SPAWNS`. Its Threat Cost is deducted before weighted composition; it closes the Spawn Plan and remains part of the displayed Wave Threat Budget. The current test boss is `bruteBoss` on wave 5.

### Authored Squad

A later composition unit containing a deliberate enemy combination, such as a healer escort. A squad has a combined Threat Cost and preserves synergies that independent weighted selection cannot express reliably.

## Enemy Scaling Rule

Existing enemy types retain their authored HP, damage, and other stats for the entire run. Late difficulty comes from larger Wave Threat Budgets, changed Spawn Pools, authored variants, squads, and spawn topology. A basic early enemy becoming one-hit fodder later is intentional.
