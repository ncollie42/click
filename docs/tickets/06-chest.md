# 06 — Chest

**Skill:** `pixel-model`. **Replaces:** `src/render/models/nodes/chest.js` → `makeChest()`,
which adopts `models/reviewed/resource-nodes.js` key `chest`. Keep the export; drop the reviewed
import and the relight.

## What it is
A loot chest the player picks up and SMASHES (never opens): it takes hits, wobbles, and breaks.
No open state exists in the sim — do not build one.

## Size
~1 cell (≈1.4 wu wide). ~22 texels: body block + lid block + one brass latch dot. That is the
entire detail budget.

## Contract to keep
- `g.userData = {body, lid, latch, wearMats}`: `lid` is a hinge group (scene.js ~910 sets
  `lid.rotation.x` from `chest.shake`), `latch` one separate mesh, `wearMats` = every body
  material (scene.js sets `emissive` to `PAL.hurtGlow` while hp < max).
- Body parts fuse; lid and latch stay separate (`bakeStatic` with `extraKeep: [lid, latch]`).

## Doctrine notes
- Pure big-plane object: box body, box lid with a slight overhang, flat-shaded timber
  (`PAL.timber`/`PAL.timberDark`), metal straps only if ≥ 2 texels wide — otherwise omit.

## Exit
README "done" list + play-zoom and 3× shots beside the 1×1 ball, plus one mid-wobble frame.
