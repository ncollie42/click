# 03 — Main base (stone dome) — DONE

**Skill:** `pixel-model`. **Replaced:** `models/reviewed/the-hole.js` (the Keep and the Hole),
adopted through `makeMainBase(awake)`. That module is deleted and the factory is gone: the base is
now an ordinary registered building, `src/render/models/buildings/main-base.js` `build(g, add)`,
reached as `makeBuilding("mainBase")`.

## What it is

One authored stone DOME: a smooth-shaded sphere of radius 2.0 wu, sunk 40 % of its diameter into
the ground (2.4 wu above it), centred on the 3×3 footprint (6 wu) that `BUILDING_TYPES.mainBase`
reserves. No keep, no precursor pit, no orb, no gulp, and no asleep/awake or level-based model swap
— the base's authored level is read from the overlay, never from the body.

**Aug 22 (owner), replacing the 4.4 × 3.6 wu cube this ticket first shipped.** Both changes are
pixel-pipeline findings, not taste alone:

- *Smooth sphere.* The quantizer bands a continuous NdotL gradient; a flat-shaded ball gives it one
  value per facet, which reads as plates with an inked seam at every step. Same call as the tree
  crown (`models/nodes/tree.js`), hence `toned(TONES.stone, {flatShading:false})`.
- *Sunk, not tangent.* The judged test-scene reference domes are all just past half-buried
  (`tools/test-scene/preset.js` `sink`). A tangent ball reads as a floating marble.
- *No pad.* Shipped in the same pass as the footprint-pad removal below.

## Conditional runtime presence

The base is BUILT, not given. `state.baseLevel` is the authority (`mainBaseStanding()`):

- **Pre-wave, level 0:** nothing stands at the map centre. `syncBase` draws no body; the anchor is
  bare ground.
- **Site:** the `bpMainBase` card places an ordinary `{type:"mainBase"}` construction record, which
  `syncBuildings` draws as an ordinary blueprint. That blueprint IS the unfinished base.
- **Level ≥ 1:** `syncBase` builds the dome once and parks it at `gx(BASE.x), gz(BASE.y)`.
  `syncBuildings` skips the completed `mainBase` record so the map centre has exactly one owner.

The map editor previews the same dome on the centre cell's reserved 3×3 (fixed anchor marker), so
authored maps and the running game agree on where it goes even though the game starts without it.

## Contract kept

- `userData.parts` (from `buildings/index.js`) is the presentation target. `syncBase` drives two
  distinct signals through it: `state.basePulse` (a swell — the base noticed a delivery or a hit)
  and a FALLING `state.baseHp` (the `PAL.hurtGlow` emissive every tower body uses). `basePulse`
  alone cannot tell a delivery from damage, which is why the hurt read comes from the health pool.
- There is no `userData.floor`: buildings have no ground pad any more (see below), so `parts` is
  the whole model and the pulse/hurt flash can drive all of it.
- The health bar, the `main base · lv n/max` readout with its authored-level delivery progress, and
  the worker-slot tray all live in `src/render/overlay.js` and are unchanged.
- Storage, targeting, hauling and placement read `BASE` in the simulation. Nothing in the model
  changes gameplay geometry.

## Footprint pads removed (same pass)

Owner: *"if we have soil now — we can remove the ugly 'floor' around buildings — just have the
soil."* `makeFootprintFloor()`, `FLOOR_H`/`FLOOR_LIFT`/`FLOOR_TOP` and `PAL.pad` are deleted.

- Every body now seats on `kit.js` `GROUND_Y` (= 0, the terrain plane). The rename from `FLOOR_TOP`
  is deliberate: there is no floor left to be the top of.
- `buildings/index.js` adds nothing but the parts list and the bake; blueprints keep their four
  corner posts and lost their scaffold pad.
- The bare earth is the TERRAIN's now: `scene.js` `rebuildWearStatic` stamps each building's
  footprint rect at wear 1 and the land shader paints `PAL.soil` above `groundTune.soilAt` (.85).
- That stamp grew a `SOIL_MARGIN` of .5 wu on each half-extent. The wear field is 1 texel/wu with
  LINEAR filtering, so the .85 crossing lands up to ~0.7 wu *inside* the peak-1 rect on a bad texel
  alignment — without the margin a building corner can stand on bare green. The 1 wu feather still
  lets a few blades overlap the rim ("a tad", owner).
- `validate.mjs`'s main-base block asserts the pad helper, `FLOOR_TOP` and `userData.floor` stay
  gone from kit / barrel / registry / blueprint / scene.

## Doctrine notes

- Outline: the inverted-hull ink (`kit.js` `outlineMat`, .05 wu) is left at the shared thickness.
  At play zoom (~25 render px/wu after the pixel downscale) that is about one low-res pixel, the
  same as on every other body, and the ink that actually reads at gameplay distance is the pixel
  pipeline's own depth/normal edge pass — a per-model bump would have been noise.
- The body is ONE mesh on purpose. `bakeStatic()` fuses two or more bakeable meshes into a single
  vertex-coloured `flat()` material, which carries no tone-target uniforms; a lone body is left
  unfused so `toned(TONES.stone)` keeps its authored lit/shadow swatches and its night tier, like
  the meadow rocks.
- All ink is `SWATCH` (through `TONES`) — `validate.mjs` asserts zero off-palette literals under
  `src/render/models/`.

## Exit

`node scripts/validate.mjs` green (registry + stale-reference assertions cover the dome and the
retired pads), `node scripts/card-mechanics.test.mjs` green, and a browser pass over pre-wave,
blueprint, standing dome, level progress, firing, day and night.
