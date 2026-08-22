# Pixel-pipeline model language

The law for every in-game 3D model. Each rule was proven on screen; add a rule only with the
shot that proved it. Process: the `pixel-model` skill. Harness: `tools/rock-snap.mjs`.
Companions: `docs/model-spec.md` (unit construction/motion vocabulary; its "flat shading
everywhere" rule is scoped by this file), `tools/test-scene/preset.js` (solved rig numbers).

## The pipeline, in the order that shapes a model

1. Lit Lambert scene — sun az 0 / el 60 @ 3.21, warm hemi 0.6 (scene.js lights; mirrored in
   `models/game-rig.js`).
2. Toon ramp at the material stage (32 texels, anchor sin 60° = 0.866; terrain/fog opt out).
3. Low-res target at ~0.4× window height → **~7 texels per wu** at standard zoom.
4. OKLab band quantizer + dither — **this is where the look is made.**
5. Outline inks: depth silhouette + normal-edge highlight.
6. Nearest-neighbour upscale.

## The one law

**Bands come from the quantizer, never from the geometry.** Give it either a smooth gradient to
carve or one stable value per large plane. Nothing else.

## The two legal surface types

1. **Smooth curve** — smooth normals, `flatShading:false`, real segment counts (sphere 32×20+).
   The quantizer carves curved bands by itself. *The scale ball; the tree crown.*
2. **Big flat plane** — `flatShading:true`, FEW LARGE faces; each takes one clean band. Sharp
   corners read great. *The test-scene box; the fog slabs; the hull rocks.*

**Illegal: the middle.** Low-poly "round" shapes (icosahedron-0) give one value per small facet —
flat plates, no gradient, every seam inked. Painted per-facet shading (the reviewed SDF casts) fails
the same way at small scale: baked ramp + toon ramp + quantizer fighting over ~28 texels.

## Size — think in cells and texels

- **1 cell = 2 wu = 32 game px.** The in-game scale balls (R panel → camera/sun → "scale ball")
  are the ruler: 3×3 cells (r 3 wu) and 1×1 (r 1 wu).
- A 1×1-cell prop is ~28 texels wide: silhouette + 3–4 bands, zero surface detail. A 3×3 prop
  (~85 texels) bands fully. Design detail for the 3×3 tier only.
- Features under ~2 texels (≈0.3 wu) become dither noise; leave them off.
- The depth pass inks the silhouette for free — spend on a clean, chunky silhouette; no limbs
  thinner than ~2 texels.

## Colour

- Colours are **albedo under the live rig** — never paint lighting in. Flat ground sees S = 0.885.
- Sun from screen-right, near-vertical terminator — sculpt knowing where the light lands.
- **The warm rig drags neutrals to tan.** Stone/iron need blue-biased albedo
  (`models/nodes/rock.js` ROCK_ALBEDO = 0x7f8b9d; PAL.rock is the castle's masonry, leave it).
- Judge **displayed** colour, never authored hex. White is the eye channel and is spent nowhere
  else. One token, one meaning (a ground ring can't be both "heal" and "danger").

## Sculpting planes so they don't read as man-made

Plane ARRANGEMENT carries meaning and the eye names shapes fast: right angles + parallel faces +
level top = **crate**; two slopes meeting at a ridge = **tent**; a clean quad in plan = **loaf**;
a dark shape touching a face = **doorway**. Levers, in order of impact: pentagon (not quad) rings
in plan; near-vertical sides with the crest ~85% of the footprint; uneven crest heights so the cap
creases into facets; deterministic per-entity yaw (`scatterYaw`, scene.js) so one instanced
template never tiles; satellites kept clear of the body. Hand-built hulls lit pitch-black =
triangles wound inward; verify one cross product before snapping.

## Construction rules

- Identity lives in `build()`, not anims — every comparison shot renders REST pose.
- Anims are pure functions `(group, phase01, t)` of existing sim timers; the sim never learns
  rendering exists. Snapshot rest, restore, then pose.
- Build in world units, in the model's own file under `models/{nodes,units,buildings,props}/`,
  with a header naming its `userData` contract. Keep the contract scene.js already drives.
- Check the photo before blaming the model: wrong snap phase, edge-on prop, or an overlay hiding
  crisp geometry explain half of "it looks wrong".

## Acceptance test

Park the model beside the scale ball. Curves band like the ball; planes sit one band per face like
the box. Name what it reads as at play zoom and at 3×; the loop exits only on the intended name.

## Case law

| model | verdict | why |
|---|---|---|
| scale balls (scene.js `setScaleBall`) | good | smooth sphere → quantizer bands |
| test-scene box / fog slabs | good | few large flat faces |
| tree (`nodes/tree.js`) | good | smooth crown + flat trunk |
| hull rocks (`nodes/rock.js`) | good | pentagon-ring hull, cool albedo, per-entity yaw |
| icosahedron-0 crown, flat-shaded | bad | facet plates + seam ink |
| reviewed SDF casts (`models/reviewed/`) | replace | painted facet ramps fight the quantizer — see docs/tickets/ |
