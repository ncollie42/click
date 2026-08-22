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
  (`models/nodes/rock.js` ROCK_ALBEDO = 0x7f8b9d; PAL.rock is the buildings' masonry, leave it).
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
| enemy shard cast (`models/reviewed/enemy-shard.js` v15) | good | DARK body (`PAL.<archetype>` = shade1, tops `PAL.enemyLit` = stone3, caps shade2 with one warm note each), red spent entirely on the ACTIVE registers: seams `enemySeam`/`enemySeamDeep` (red2 over red3), thrown FX `enemyAbility`/`enemyAbilityDim` (red1 over red2). A crimson-BODIED cut was built first and rejected — see the note below. |

  ## Palette (Aug 22 — no model authors a hex)                                
                                                                              
  Every albedo a model file writes is a SWATCH entry from                     
  src/render/palette.js. Not "close to                                        
  one" — the entry itself. scripts/validate.mjs asserts zero off-palette      
  literals under                                                              
  src/render/models/** and fails the build on a new one. Comments are stripped
  before the scan, so                                                         
  a calibration note may still quote the hex it replaced; a line that         
  genuinely needs a non-swatch                                                
  number (a LIGHT colour, a hash seed) carries a palette-exempt marker in its 
  own trailing comment.                                                       
                                                                              
  Picking the swatch, in order:                                               
                                                                              
  1. node scripts/palette-snap.mjs for a PAL role; nearestSwatch(hex) from    
  that module for a raw                                                       
  hex. OKLab-nearest is the default answer.                                   
  2. Override nearest when it breaks doctrine. The two that keep coming up:   
  the red ramp is only for                                                    
  threat/damage/fire/coin-gold, and **an actor may not wear the ground's      
  value**. Nearest for the                                                    
  old worker coats was literally green1 — the grass — and that is the         
  collision the whole rule                                                    
  exists to stop.                                                             
  3. Value gate, asserted for actor roles: OKLab L at least .08 from both     
  green1 (lit clearing)                                                       
  and green2 (forest tint). In practice that means an actor is either L >= .80
  or L <= .55.                                                                
  Fix a failure by re-mapping the role, never by widening the gate.           
                                                                              
  Shading a model is two separate questions, and they have two different      
  owners:                                                                     
                                                                              
   model kind             | lit side               | shade side               
  ------------------------|------------------------|------------------------  
   live-rig (trees,       | kit.toned(TONES.x) — a | same call — a hemi-      
   rocks, terrain,        | sun-lit face renders   | only face renders        
   buildings from         | lit exactly            | shadow exactly           
   kit.flat)              |                        |                          
   baked casts            | relightForGame() +     | shadeToFamily(root,      
   (models/reviewed/*     | GAME_EXPOSURE          | TONES.x.shadow)          
   through game-rig.js)   |                        |                          
                                                                              
  A baked cast without shadeToFamily goes grey-brown mud under cloud, because 
  the raw hemi pair is                                                        
  a lavender sky over a mauve bounce. Call it after the bake and after any    
  vertex re-tint (the enemy                                                   
  variant tint), because it measures the albedo it finds.                     

## Red is what a creature DOES (Aug 22, the enemy re-ink)

A first pass read "RED IS RESERVED for threat" as "enemies are red" and put the whole shard cast on
the red ramp, bodies included. The owner rejected it: *"taking it too literal. Enemies are red -
keep them DARK within the palette; make the purple accent red. Or just make the damage they do
red."* The rule is about what SPENDS the reserve, and a silhouette does not spend it - an event
does. A crimson body also self-defeats: the seams had nothing left to be brighter and redder than,
so the one thing that actually said "threat" went quiet.

The shipped shape of it, and the pattern to copy for any future hostile:

- BODY dark and neutral-cool (shade1, tops stone3). It reads by VALUE against the meadow, which is
  the readability rule; hue on the mass buys nothing.
- ACTIVE REGISTERS carry the reserve, in a ladder: seam red2 over red3, thrown FX red1 over red2 so
  a bolt always out-values the crack it came from.
- ONE warm cap note per creature at most (archer fin red1, bomber fuse red0). More than one and the
  body starts reading red again.
- VARIANT TIER brightens the seam, never the body (palette.js ENEMY_VARIANT_TINT, enemy-shard
  tintSeams). Tier is an intensity, and intensity belongs on the register that already means harm.
- THE DAMAGE ITSELF IS RED at the receiving end: PAL.hurtGlow (red2) on every player-side thing
  whose hp drops, the "received" damage numbers, the archer's bolt, the boss stomp. The player never
  has to infer that they are being hurt from the enemy's paint job.

## Family shadows and hue vectors (Aug 22, the enemy re-ink)

PICK THE SHADOW SWATCH ONE STEP BELOW THE BODY, IN THE BODY'S OWN FAMILY. `shadeToFamily(root,
TONES.x.shadow)` is only right while the cast belongs to family `x` AND the body is not already
sitting on `x`'s shadow. The enemy cast is shade1 now, and `TONES.stoneDk.shadow` IS shade1 - the
shaded side would have equalled the lit side and flattened the whole cast. Hence a named role:
`PAL.enemyShade` = shade2, one step further down the same shadow bridge.

The other half of the trap, learned on the rejected crimson cut: the red ramp's hemi-only landing is
`wood2` (`scripts/palette-snap.mjs` predictLanding on red2/red3). Any RED-bodied cast left on a
default shade goes brown mud - the exact failure this section already warns about, reached from the
other direction. Run `predictLanding` on the body swatch before choosing a shade.

HUE VECTOR IS NOT ALBEDO. enemy-shard normalises every swatch it reads to luminance 1 (`tintOf`)
and takes VALUE from its own PLANE ramp. A swatch used that way contributes hue ONLY — which is why
a cap can be `cream0` and still never render cream (it renders as a tan at the cap's display value),
and why the enemy CAP roles are exempt from validate's actor value gate while the BODY roles are in
it. If you add a model that inks this way, gate its bodies and say in the palette comment that the
accents are hue-only.
