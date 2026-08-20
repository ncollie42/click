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
| `pixel`   | Low-res render → sharpen → sun-projected banded cloud shadows + god rays → depth/normal outlines (selout) → quantize → nearest upscale with sub-pixel pan reconstruction. | 1 scene draw + post (+1 with normalEdges, on by default) |

Owner defaults (Aug 19 panel session): `pixelScale 0.4`, `outlineStrength 4`, `normalEdges on`,
quantize `oklab bands`.

### Quantize modes (`pixelTune.quantizeMode`)

- `0` **oklab bands** (default) — OKLab lightness posterize, `bands` rungs; hue untouched.
- `1` **palette match** — nearest authored color by OKLab distance (`spread` jitters L).
  `paletteSize` picks the 8/16/32-color tier (PALETTES in pixel.js);
  `pixelTune.palette = [hexes]` overrides them, `null` restores. Night/day re-toning = swap
  the array.

(The old mode-1 **rgb levels** quantizer + dither endpoint fade were cut Aug 19 by owner call —
dead code; recover from git if ever wanted. Saved presets with `quantizeMode 2` clamp onto
palette's new slot 1, same look.)

### Cloud shade routes (`pixelTune.cloudsMode`)

- `"material"` (default, Aug 20) — analytic shade computed IN the materials
  (`src/render/material-light-mods.js`, injected via onBeforeCompile into every Lambert/Toon
  material): the direct sun term is multiplied by the cloud field, sun-projected to the cloud
  plane like every other consumer. Smooth penumbra (no shadow-map dither), object sides shaded,
  and both hosts (game + test scene) wire it identically. The same module carries the game-wide
  TOON RAMP (`pixelTune.toonRamp`; terrain/fog opt out via `material.userData.noToonRamp`).
- `"scene"` — a shadow-casting cloud plane (`src/render/cloud-field.js`) at
  `cloudHeight`: pixel.js adds it to the scene and enables layer 2 on the sun's shadow camera,
  so cloud shade arrives through the REAL shadow system — object sides included, in sun-space
  automatically (Red Giraffe vid6's "feed the mask into the shadow system"). Banded partial
  coverage becomes a hash-dithered discard PCF averages back into partial darkness. Shade
  darkness comes from the sun:ambient ratio (`cloudDarken` is unused on this route). The plane
  is invisible to every camera (layer-gated), inert to raycasts, and removed symmetrically on
  pipeline dispose.
- `"image"` — the old composite darken fold (`cloudDarken` applies), kept for A/B.

Both routes and the god rays read ONE GLSL field (`cloudCoverAt` in cloud-field.js) with the
same per-frame uniform values, so they cannot drift apart.

### God rays (`pixelTune.rays`, on by default)

Red Giraffe vid6's volumetric beams, resolved with the owner's smooth-then-quantize law:
per pixel, ray-march the last `rayDist` wu of air above the surface (Bayer-jittered,
`raySteps`), average the SMOOTH unoccluded fraction of the same cloud field the shadows use,
subtract the ground's own litness (a shaft is air more lit than the ground it hangs over),
then `rayBands` re-pixelates the beam into stepped shafts. Bounded warm fold beside the cloud
shadow, pre-quantize: a LERP toward the sun-cream tint capped at `rayStrength`, never raw
addition. Three deliberate shapes from the Aug 19 owner reports: the short march window keeps
beams structured at any zoom (a full camera→ground march averages several cloud features into
one flat mean), the excess-only subtraction makes a clear sky add exactly zero (no wash; the
eye-channel law >215 holds by construction), and the bounded lerp keeps beams from saturating
dark pixels (raw addition painted opaque white blobs over the fog blocks). Needs `clouds` on
and a sun above the horizon; beams appear where lit air hangs over cloud-shaded ground — they
share the shadows' cloud field on purpose (that sync is what makes them read as one weather
system), rays are its volumetric brighten term, shadows its projected darken term.

## Architecture

- `src/render/pipelines/index.js` — registry, F9 switch, error-benching. Pipeline contract in
  its header.
- `src/render/pipelines/post-stage.js` — shared scaffolding: low-res HalfFloat colour+depth
  target (nearest both ways), fullscreen-triangle composite, camera texel snap + sub-pixel
  remainder, the COLOR SPACE rule (linear target, manual sRGB encode — read its header before
  touching the encode).
- `src/render/pipelines/pixel.js` — the pipeline; passes, tunables and quantize modes are
  documented in its header.
- `src/render/cloud-field.js` — the ONE cloud density field (GLSL) + the shadow-casting cloud
  plane factory; consumed by pixel.js's composite, its scene-mode plane, and the material mods.
- `src/render/material-light-mods.js` — material-stage injections (analytic cloud shade + toon
  ramp) patched into existing Lambert/Toon materials without replacing them; both hosts call
  `applyLightingMods`/`syncLightMods` per frame.
- `src/render/toon-ramp.js` — gradient-map builder + MeshToonMaterial factory (band levels are
  effective NdotL; the band holding `sin(sunElevation)` must carry that value so flat ground
  matches Lambert).
- Outline ink: `pixelTune.inkMode` — `"selout"` (house style, per-pixel colour banded darker) or
  `"uniform"` (one authored dark-olive ink, `pixelTune.inkColor`).
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
