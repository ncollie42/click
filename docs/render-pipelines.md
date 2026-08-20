# Render pipeline bake-off (Aug 17-18 2026)

Three switchable render pipelines, built to decide whether the pixel-art look (ported from
`~/dev/gamedev/pixel`, texel splatting) is worth adopting.

## How to try them

Run the game, press **F9** to cycle: `current` → `retro` → `toon` → `splat` → `full`. A badge shows the active one.
Press **R** for the renderer debug window: pipeline switch + live sliders over every `retroTune` /
`splatTune` knob (applied next frame), per-section reset, splat debug-view/face selectors.
Choice persists in localStorage (`click.pipeline`). A pipeline that throws is benched for the
session and the game falls back to `current` — check the console for `[pipeline]` errors.

| Pipeline | What it is | Cost |
|----------|------------|------|
| `current` | The existing renderer, untouched (direct draw + water pre-pass). | baseline |
| `retro`   | Cheap look-alike: low-res render target + nearest-neighbor upscale + OKLab posterize + outlines. | ~1 extra fullscreen pass |
| `splat`   | Adapted texel-splatting port: one probe, 4 faces, fixed-camera shortcuts. | heavy, experimental |
| `toon`    | Acerola dither/quantize + Voyage cloud shadows: low-res, sharpen, world-fBm cloud darkening folded pre-quantize, Bayer dither, per-channel quantize or 8-color authored-ramp remap. | 1 scene draw + post |
| `full`    | FAITHFUL texel-splatting port: 3 probes (eye/grid/prev) × 6 faces every frame, rotation-correct, reference constants. | ~21 scene draws/frame — brutal by design |

## Tuning

- `retro`: import/console `retroTune` (pixel scale, posterize bands, outlines) — see
  `src/render/pipelines/retro.js`.
- `splat`: `splatTune` (probe size, post height, crossfade, debug faces) — see
  `src/render/pipelines/splat.js`.

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

### full — first-look notes
- The no-shortcuts port, built for future camera rotation: eye+grid+prev probes, all 18 cubemap
  layers captured every frame. Expect single-digit FPS on weak GPUs — that is the point of the
  experiment. First mitigations in the R panel: `cullCaptures` on (reference's own capture culling),
  `eyeProbe` off, lower `probeSize`.
- `fullTune.debugView` 0–7 mirrors the reference's Tab modes (splat/forward/albedo/normal/radial/
  lit/edge/shadow); `showProbe` picks eye/grid/prev; `fullStats` (console) shows live draw counts.
- Known quirks: texels behind the camera read unshadowed (game's shadow frustum is screen-sized,
  probes shade a full sphere — visible in debug views only); ortho toggle gives a slightly warped
  sky (documented approximation).

### splat — first-look notes
- Validation found zero must-fix defects; risks are perf + look, not correctness.
- Cost: ~5 full scene renders/frame (shadow + 4 visible cubemap faces) + instanced splats.
  If slow: lower `splatTune.probeSize` (384) and/or `postHeight` (400).
- Debug: `splatTune.debugView = 1..6` shows albedo/normal/radial/lit/edge/shadow buffers;
  `showFace 0..5` isolates a face (needs debugView > 0).
- Expected quirks: blobby ground = reference behavior (raise `edgeThreshold` to tighten); shadow
  acne at far zoom → raise `shadowBias`/`shadowSlope`; corpses (only lit transparent) can show
  slightly stale shadows; one-time shader-compile hitch on first F9 into splat.
- If the whole screen is solid/inverted geometry: radial packing convention — see
  `splat/targets.js`.

## Removal

To drop an experiment: delete its file(s) under `src/render/pipelines/`, remove its entry from
`PIPELINES`/`loaderFor` in `index.js`. To drop the whole experiment: revert the three small
`scene.js` edits and delete `src/render/pipelines/`.
