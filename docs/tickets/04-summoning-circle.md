# 04 — Summoning circle

**Skill:** `pixel-model`. **Replaces:** `src/render/models/buildings/summoning-circle.js` →
`build(g, add)`, which adopts `models/reviewed/summoning-circle.js` with its own screen-space ink.
After this ticket the body joins the normal building frame: parts via `add()`, world-unit ink from
`meshOf()`, no `adoptInkedModel`, no `relightForGame`.

## What it is
A 3×3 ritual site (card-placed, `SUMMONING_CIRCLE.duration` lifetime, costs dust). Its glyph is a
GAUGE: five dust slots light as dust is paid, and six ash-ring stages advance as the circle decays.
Violet is the precursor register and means exactly this — nothing else on the model may be violet.

## Size
3×3 cells, but flat: a ground disc plus low kerb. The gauge marks must each be ≥ 2 texels at play
zoom or they vanish — five slots around a 6 wu disc is plenty of room.

## Contract to keep
- `g.userData.inner` (the whole subtree — this keeps it out of `bakeStatic`: the slots and rings
  must stay individually switchable), `anims` (`idle`, `feed`, `summon`, all `(inner, p, t)`),
  `slotMarkers` (array of 5 meshes; scene.js sets `visible = index < dust`), `ashRings` (array of
  6; scene.js picks the stage from remaining lifetime — see scene.js ~1309–1320).
- Nothing from this body joins `parts` (hurt flash / ghost tint must never touch the glyph).

## Doctrine notes
- Disc and kerb = big flat planes; glyph marks = emissive flat facets (one dimmer facet for
  falloff, never additive gradient overlays). Smooth curve only on the kerb ring itself.

## Exit
README "done" list + shots at play zoom with dust 0, 3, 5 and ash stage 0 and 5, beside the 3×3 ball.
