# Render pipeline: `pixel`

Outcome of the Aug 17–20 2026 bake-off (survey + reasoning in the Pixel Rendering Atlas
artifact). Five candidates were built and judged; `pixel` won and everything else was deleted:

- `splat` / `full` (texel-splatting ports) — deleted Aug 19, last present at `c96104a`. Their
  world-anchored-texel benefit is ~reproduced by `pixel`'s sub-pixel reconstruction at trivial
  cost, and `full`'s rotation-proofing buys nothing in a fixed-yaw game.
- `retro` / `toon` (pixel's merged parents) — deleted Aug 20, last present at `43ad59b`.
  Everything worth keeping from both lives on inside `pixel`.

## Using it

`pixel` is the default pipeline. **F9** toggles `current` ↔ `pixel` (badge shows the active
one); **R** opens the debug panel (grouped sliders over `pixelTune`, applied next frame, A/B
preset slots, live ms/fps meter); **B** blinks between the last two pipelines. Choice persists
in localStorage (`click.pipeline`). A pipeline that throws is benched for the session and the
game falls back to `current` — check the console for `[pipeline]` errors.

| Pipeline | What it is | Cost |
|----------|------------|------|
| `current` | The stock renderer (direct draw + water pre-pass). Baseline and bench fallback. | baseline |
| `pixel`   | Low-res render → sharpen → sun-projected banded cloud shadows → depth/normal outlines (selout) → quantize → nearest upscale with sub-pixel pan reconstruction. | 1 scene draw + post (+1 with normalEdges, on by default) |

Owner defaults (Aug 19 panel session): `pixelScale 0.4`, `outlineStrength 4`, `normalEdges on`,
quantize `oklab bands`.

### Quantize modes (`pixelTune.quantizeMode`)

- `0` **oklab bands** (default) — OKLab lightness posterize, `bands` rungs; hue untouched.
- `1` **rgb levels** — display-space per-channel floor + Bayer dither (`levels`, `spread`);
  `ditherFade` keeps true black/white reachable.
- `2` **palette match** — nearest authored color by OKLab distance. `paletteSize` picks the
  8/16/32-color tier (PALETTES in pixel.js); `pixelTune.palette = [hexes]` overrides them,
  `null` restores. Night/day re-toning = swap the array.

## Architecture

- `src/render/pipelines/index.js` — registry, F9 switch, error-benching. Pipeline contract in
  its header.
- `src/render/pipelines/post-stage.js` — shared scaffolding: low-res HalfFloat colour+depth
  target (nearest both ways), fullscreen-triangle composite, camera texel snap + sub-pixel
  remainder, the COLOR SPACE rule (linear target, manual sRGB encode — read its header before
  touching the encode).
- `src/render/pipelines/pixel.js` — the pipeline; passes, tunables and quantize modes are
  documented in its header.
- `src/render/pipelines/debug-panel.js` — the R panel. Lives in a shadow root because the
  game's global tag CSS (`button{width:100%}` etc.) mangles light-DOM panels.
- `scene.js` seams: `renderScene()` delegates to `renderFrame()`, `resizeRenderer()` forwards
  the drawing-buffer size, `waterPrePass()` takes optional size args so offscreen pipelines
  keep water depth UVs aligned.
- The map editor preview (`tools/map-editor/preview.js`) routes through the same registry.

## Known caveats

- Water outlines derive from the floor beneath (water writes no depth).
- `normalEdges` costs +1 scene draw and flattens water vertex waves in the normal buffer.
- Sub-pixel pan can read up to half a texel outside the RT; ClampToEdge duplicates the border
  texel there — accepted, invisible in practice.
- The RGBA8 target fallback (drivers without renderable HalfFloat) bands in the darks before
  the quantizer runs — if a device shows banding, check which target type it got.

## Removal

To drop the whole experiment: revert the three small `scene.js` seams and delete
`src/render/pipelines/`. Individual deleted pipelines recover from git: `splat`/`full` at
`c96104a`, `retro`/`toon` at `43ad59b`.
