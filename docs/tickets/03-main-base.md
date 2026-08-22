# 03 — Main base (keep + precursor pit)

**Skill:** `pixel-model`. **Replaces:** `src/render/models/buildings/main-base.js` →
`makeMainBase(awake)`, which adopts `models/reviewed/the-hole.js` (`main-base`, `main-base-awake`).

## What it is
The player's castle: a keep beside the precursor hole (the pit the base feeds). Two states:
asleep and awake (the orb hovers when awake). It sits on the shared 3×3 footprint pad
(`makeFootprintFloor(BASE.footprint, PAL.grass)`) at `gx(BASE.x), gz(BASE.y)` — keep that frame.

## Size
3×3 cells (6 wu) — the one model that gets the full texel budget (~85 texels). This is the tier
where detail is allowed: crenellations, a door, the berm. The scale ball is the same footprint:
build the keep to band like it.

## Contract to keep
- `g.userData = {floor, inner, anims}`; anims `idle(inner, phase01, t)` and `gulp(inner, p, t)`
  (the pit swallows a deposit); awake adds `orbHover`. Rigid parts fuse (`bakeStatic` with the
  animated subtrees kept out via `extraKeep`).
- Storage/targeting/placement read `BASE` in the sim — nothing here changes gameplay geometry.

## Doctrine notes
- Keep = big flat planes (masonry, `PAL.rock`/`PAL.rockDark` — the castle colours, NOT the
  boulders' cool albedo). Pit rim = smooth curve. Orb = smooth sphere, emissive allowed (unlit
  parts are excluded from the bake by the material filter).
- This is where "identity lives in build()" matters most: the awake state must read asleep→awake
  from the rest pose alone (orb visible), not only from the hover.

## Exit
README "done" list + shots at play zoom of both states beside the 3×3 ball, and one `gulp` frame.
