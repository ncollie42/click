# Render pipeline bake-off (Aug 17-19 2026)

Switchable render pipelines, built to decide whether the pixel-art look is worth adopting.
Aug 19: the research atlas (Pixel Rendering Atlas artifact) closed the survey phase — the two
texel-splatting ports (`splat`, `full`) were DELETED (last present at commit `c96104a`; their
world-anchored-texel benefit is ~reproduced by `pixel`'s sub-pixel reconstruction at trivial
cost, and `full`'s rotation-proofing buys nothing in a fixed-yaw game), and the merged `pixel`
pipeline was added as the recommended keeper. `retro`/`toon` stay only as A/B baselines until
`pixel` is judged; then they go the same way (removal steps below).

## How to try them

Run the game, press **F9** to cycle: `current` → `retro` → `toon` → `pixel`. A badge shows the active one.
Press **R** for the renderer debug window: pipeline switch + live sliders over every tune knob
(applied next frame), per-section reset, A/B preset slots, live ms/fps meter.
Choice persists in localStorage (`click.pipeline`). A pipeline that throws is benched for the
session and the game falls back to `current` — check the console for `[pipeline]` errors.

| Pipeline | What it is | Cost |
|----------|------------|------|
| `current` | The existing renderer, untouched (direct draw + water pre-pass). | baseline |
| `retro`   | Cheap look-alike: low-res render target + nearest-neighbor upscale + OKLab posterize + outlines. | ~1 extra fullscreen pass |
| `toon`    | Acerola dither/quantize + Voyage cloud shadows: low-res, sharpen, world-fBm cloud darkening folded pre-quantize, Bayer dither, per-channel quantize or 8-color authored-ramp remap. | 1 scene draw + post |
| `pixel`   | The MERGE (recommended): retro's outlines + toon's clouds/sharpen/dither on one composite, plus sub-pixel pan reconstruction, OKLab nearest-palette quantize mode, dither endpoint fade. | 1 scene draw + post (+1 with normalEdges) |

## Tuning

- `retro`: import/console `retroTune` (pixel scale, posterize bands, outlines) — see
  `src/render/pipelines/retro.js`.
- `toon`: `toonTune` — see `src/render/pipelines/toon.js`.
- `pixel`: `pixelTune` (union of both + `subpixel`, `quantizeMode`, `ditherFade`) — see
  `src/render/pipelines/pixel.js`.

## Architecture

- `src/render/pipelines/index.js` — registry, F9 switch, error-benching. Pipeline contract is
  documented in its header.
- `scene.js` changes were minimal: `renderScene()` delegates to `renderFrame()`,
  `resizeRenderer()` forwards the drawing-buffer size, and `waterPrePass()` grew optional
  size params so offscreen pipelines keep water depth UVs aligned.
- Each experimental pipeline is fully self-contained in `src/render/pipelines/<name>*` and can be
  deleted wholesale if rejected.

## Status (Aug 18, after overnight build + validation)

Both pipelines are built and passed a static validation pass against the vendored three r160
source (API signatures, shader-uniform cross-checks, ported math verified numerically against
`~/dev/gamedev/pixel/source/*.glsl`). GLSL could not be compile-tested headless — first browser
run is the real test; a compile failure benches the pipeline with a `[pipeline]` console error.

### retro — first-look notes
- One real bug found+fixed in review (render target restore on throw). Color handling verified
  byte-identical to `current` with posterize/outlines off.
- If terrain sparkles with edge lines: `retroTune.creases = false`, or raise
  `retroTune.creaseThreshold`. `depthEdge` may want retuning at far zoom.
- `retroTune.normalEdges = true` switches interior creases to the hello-threejs mode (real normal
  buffer, +1 scene draw): bias-gated edge HIGHLIGHTS on up/camera-facing creases — the pixel-art
  rim look. Tune with `edgeHighlight` / `normalThreshold`; A/B against `creases` in the R panel.
- Water outlines derive from the floor under it (water writes no depth) — check how that reads.
- Camera snap makes overlay/picking track the *unsnapped* camera: ≤1 output texel skew vs the
  drawn frame. `retroTune.snap = false` if it bothers.

### pixel — first-look notes (Aug 19, unjudged — GLSL not yet compiled in a browser)
- The merge: retro's outline block and toon's sharpen/cloud/dither blocks run in ONE composite,
  in Red Giraffe's order (sharpen → clouds → outline band-shift → quantize → encode).
- `quantizeMode`: 0 = retro's OKLab bands · 1 = toon's rgb levels (default, the standing
  recommendation) · 2 = NEW nearest-palette match in OKLab against the authored 8-hex ramp
  (real 2-D palette control; night/day re-toning = swap `pixelTune.palette`).
- `subpixel` (default on): the composite samples the RT offset by the camera-snap remainder, so
  pans GLIDE instead of stepping whole texels — this replaces most of what `splat` existed for,
  and the retro overlay/picking-skew caveat mostly disappears with it. Watch the screen border:
  up to half a texel of clamped edge duplication while mid-step (accepted).
- `ditherFade` (default on, rgb mode): Bayer fades near 0/1 so true black/white stay reachable
  (Photosounder's ~0.16-unit black-lift fix).
- Same caveats as its parents otherwise: water outlines derive from the floor beneath (water
  writes no depth); `normalEdges` costs +1 scene draw and flattens water waves in that buffer.

### splat / full — DELETED Aug 19 (were: texel-splatting ports)
Adapted (4-face, ~7 scene draws) and faithful (18-face, ~21 scene draws) ports of the
`~/dev/gamedev/pixel` texel-splatting renderer. Both validated, both worked; cut because the
game's fixed yaw makes rotation-proofing worthless and `pixel`'s sub-pixel reconstruction covers
pan stability at ~0.1% of the cost. Recover from git (`git show c96104a -- src/render/pipelines/`)
if world-anchored texels are ever wanted; their tuning notes live in this file's history.

## Removal

To drop an experiment: delete its file(s) under `src/render/pipelines/`, remove its entry from
`PIPELINES`/`loaderFor` in `index.js`. To drop the whole experiment: revert the three small
`scene.js` edits and delete `src/render/pipelines/`.
