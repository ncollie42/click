# Water — parked, revisit after the pixel-shader renderer is chosen

The game ships depth-foam water (editor mode 4; same technique in src/render/scene.js). A richer
"voyage/ocean" candidate (mode 5) was built and auditioned in the map editor on Aug 19 2026,
measured by a blind critic, BENCHED, and removed from the tree. **The full implementation lives at
commit `ffe6b95`** (tools/map-editor/water-modes.js + the #waterVoyageTuning UI) — restore it from
there, don't rebuild.

## What mode 5 was

Ported from Voyage's "Developing a Water Shader for 3D Pixel Art" + Red Giraffe's "Pixel Art
Oceans": opaque-scene refraction with absorption tint · flow-field distortion SCALED BY DEPTH
(surface stays put, deep water warps) · planar reflections via mirrored camera with Lengyel
oblique near-plane clipping, behind a toggle · ebb-flow vertex waves (two perpendicular sines
MULTIPLIED) · sparse whitecaps (two incommensurate noise reads multiplied) · mode-4's foam.
Cost: +1 full scene render, +2 with reflections.

## Why it was benched (measured, not vibes)

- The reference art's water is FLAT — its interior spans 4 luma points; its virtue is value and
  desaturation, not detail. Every added layer was something the art direction never asked for.
- Reflections at the game's ~40° camera bought 0.006 lum/px of structure for 2 scene renders
  (fresnel correctly kills top-down reflection). Gorgeous at grazing angles the game never shows.
- Distortion at 40° was statistically invisible where the player looks and shimmer-bait in the
  distance.
- Its white shoreline rim was the only thing in frame above the eye-channel ceiling (house law:
  white belongs to eyes/glints).

## The one thing worth taking NOW (still open)

**Mode 5's body colour measured 11 luma closer to the reference than the shipped water** —
reference interior (112,144,192) lum 146; shipped mode 4 (32,96,160) lum 96; mode 5 (64,96,144)
lum 107. Critic's recommendation: keep depth-foam wholesale, lift the water colour toward lum
~120-130 (shallow/deep constants in scene.js + water-modes.js). One-line change, owner's eyes
required because it shifts a locked-in look.

## Why "after the renderer"

The chosen pipeline changes what water even needs: toon quantizes the water anyway (banding eats
gradients), retro posterizes it, splat/full forward-render it over splats at low res. Judge water
INSIDE the winning pipeline, not against the raw renderer — the flat reference look may fall out
of the quantizer for free.

## Also on file

- Red Giraffe ocean technique inventory: session brief (scratchpad/redgiraffe-briefs.md, vid7) —
  key items already folded into ffe6b95's implementation.
- Known quirk in the SHIPPED water (not mode 5): the foam's reversed smoothstep edges
  (`smoothstep(1.8, .08, t)`) are undefined-behavior per the GLSL spec — every driver we run
  renders them as intended, but if foam ever breaks on some GPU, look here first.
- The editor's water tab (mode select + shared sliders) remains — that's the audition venue for
  any future candidate; docs/render-lab.md has the workflow.
