---
name: pixel-model
description: Build, rework, or critique any in-game 3D model, prop, or asset (tree, rock, building, unit, remnant, effect mesh). Fires when asked to make a new model, improve or resize an existing one, or when a model reads mushy, wrong, or "not like the thing" under the pixel renderer.
---

# Pixel-model workflow

The law and its case history live in `docs/pixel-models.md`. Every rule there was proven on
screen; this skill is the process that applies it. Read that file end to end before touching
geometry — the case-law table is the fastest way to avoid re-losing a solved battle.

## Steps

1. **Read `docs/pixel-models.md`.** Done when you can state, for this asset: its size in cells,
   its texel width at play zoom, and which case-law rows are closest to it.
2. **Classify every form before building.** Each visible form is either a smooth curve or a set
   of few large planes — name the choice per part (crown = curve, trunk = plane, ...). A form
   you cannot classify is a form the quantizer will ruin; redesign it until you can.
3. **Build against the live contracts.** Colors are albedo under the current rig (cool-bias
   stone-like materials; the doc carries the numbers). Existing entity contracts
   (`userData.live/stump/rubble/...`, the scatter layer, `bakeStatic`) are documented at their
   definitions: `src/render/models/kit.js` (shared helpers), the model's own file under `src/render/models/{nodes,units,buildings,props}/` (one model per file; `models.js` is just the barrel), and `src/render/scene.js` — read the comment at the
   thing you're replacing, keep its contract. Hand-built hulls: verify one face's winding by
   cross product before the first snap (inward-wound triangles light pitch-black).
4. **Audition loop.** Snap the real game headless:
   `node tools/rock-snap.mjs <out.png> [zoom] [x] [y] [pixel|current]` (shots land in
   `tools/shots/rocks/`). Look at the shot and NAME what each model reads as, out loud, at play
   zoom and at ~3× zoom. The loop exits only when you name the intended subject at both zooms —
   naming anything else (crate, tent, loaf, golf ball, blob) means another sculpt pass, and the
   doc's tells section says which lever moves each misread. For side-by-side banding judgment,
   toggle the scale ball (R panel → camera/sun) next to it.
5. **Record and close.** `node scripts/validate.mjs` green; add or update the asset's row in the
   doc's case-law table (verdict + why, one line); if the iteration taught a new tell or rule,
   append it to the doc — with the evidence named, like every rule already there.
