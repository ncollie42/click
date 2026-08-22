# Model spec — units, accessories, motion

The build bible for in-game procedural models (three.js, flat-shaded, no rigs). Companion to
`docs/asset-prompts.md` (generation prompts) and `docs/reference/*.png` (the accepted look).
Quality bar: `docs/quality-bar.md` — blind side-by-side with reference, as good or better.

## Ground rules

- **Flat shading everywhere** (`flatShading:true`), facets visible, three-step lighting feel.
  **Scoped Aug 21 by `docs/pixel-models.md`** (the pixel-pipeline law): flat shading is for few
  LARGE planes only; anything meant to read round must be genuinely smooth (normals + segments),
  because small facets turn to plates + seam ink under the quantizer. Read that file before
  building any new model.
- **Palette from `src/render/palette.js` only.** Violet/cyan = the thing and its creatures, never on villager builds or workers.
- **No skeletal rigs.** Every model is a THREE.Group tree; animation is transforms on named child
  groups (position/rotation/scale). Accessories are separate child meshes with pivots at their strap point.
- **Animation is presentational.** Poses derive from existing sim state (`hitCooldown`,
  `attackCooldown`, `combatTarget`, velocity, `step`, `flash`) inside the render layer. The
  simulation never learns animation exists.
- **Easing over speed.** Anticipation (wind-up), fast action, follow-through (overshoot + settle).
  Damped oscillation is the house wobble: `rot = sin(t·f)·a·e^(−d·t)`.

## Workers — the peg villagers (`docs/reference/workers.png`)

One shared body, five dressings. Body: chunky rounded peg (pawn silhouette), simple head with two
dark dot eyes, hood/hat. ~1.4 cells tall in-world; must read at 30px.

**Group tree:** `root → body → [head, hood, beltStrap, accessory*, carryStack*]`
Accessory pivot = strap point on the body, never the accessory's center.

| Worker | Coat (palette) | Accessory (pivot) | Job mapping |
|---|---|---|---|
| gatherer | tan `coat` | axe across back (shoulder strap) | harvest / staff / free |
| courier | dusty blue `jobHaul` | wicker basket worn as backpack | haul |
| builder | ochre `jobBuild` | hammer tucked in belt (belt point) | build |
| guard | brown `jobGuard` | round shield on back + spear angled behind (both back-mounted) | guard — every Garrison posting |
| carrier | any coat | 3-log stack strapped on head (head top) | any worker with `carried > 0` |

**Garrison guards reuse this exact guard dressing — there is no fortified variant model.** A manually
posted guard, a mustered guard, a travelling guard and an arrived guard whose effective maximum is
10 HP are all the same `guard` worker; the health difference reads through the ordinary overlay
health bar (which sizes itself from `workerMaxHp`), never through a second mesh, a scale change or a
palette swap. The only render-side tell that a guard has *arrived* lives on the station, not the
unit: see the garrison's post pennants below.

### Worker motion vocabulary

| Motion | What moves | Driver | Charm note |
|---|---|---|---|
| walk | body bob (existing `step`), lean into velocity, tiny hop on direction change | velocity, `step` | lean sells intent; hop sells eagerness |
| chop | axe unhooks, wind-up BACK, fast swing down; body leans in | `hitCooldown` phase | anticipation is the charm — the pause before the hit |
| spear jab | spear levels from back-angle, thrusts along facing; body recoils opposite | `attackCooldown` | 2px recoil makes the jab feel like effort |
| shield up | shield rotates back → front when threat in leash; body tucks ~5% | `combatTarget != null` | a scared peg is a lovable peg |
| carry lag | head stack tilts OPPOSITE to acceleration, settles with damped wobble | velocity delta | top-heavy physics = weight = comedy |
| idle | micro-wander, face passersby (see idea.md worker behaviors) | idle state | desynchronized per worker |

**Priority order for implementation value:** carry lag, chop, walk lean. One each of
physics / action / locomotion; everything else reuses their code shapes.

## Enemies — the shadow shards (`docs/reference/enemies.png`)

Matte near-black faceted bodies, pale grey facet edges, white eyes, violet `dust` crack-seams
glowing between facets (emissive). The ONLY villain color. No timber/cloth/anything hand-made.

| Enemy | Silhouette | Combat read | Size |
|---|---|---|---|
| raider | low crouched wedge, small horns | fast melee | 1 |
| archer | tall thin spire, quill fan on back | ranged | 1 |
| healer | rounded drooping bell, hovers, tendrils, violet light pool | support — target first | 1 |
| brute | hulking cracked boulder, widest seams | slow tank | 1.35 |

### Enemy motion vocabulary

| Motion | What moves | Driver | Charm note |
|---|---|---|---|
| raider scuttle | shallow fast hops (3–4/s), nose-down tilt into movement | velocity | reads as scurrying vermin |
| raider lunge | big anticipation crouch → lunge along facing → return | attack timer | the crouch telegraphs; players learn to read it |
| archer sway | spire sways like grass at rest | idle time | makes a still ranged unit feel alive |
| archer fire | whole spire recoils back; one quill detaches as the projectile | attack timer | projectile = quill mesh, not a generic dot |
| healer hover | sine bob, never grounded; tendrils sway with phase delay (drag) | time | tendril lag is the entire personality |
| healer heal | bell inflates ~10%, pulses down; pool brightens | heal tick | breathing, not casting |
| brute thump | slow high hops; landing: squash (1.15, 0.85, 1.15) ~80ms, dust puff, 1–2px camera nudge | velocity/hop phase | squash + particles + camera = WEIGHT |
| brute effort | violet seams brighten while airborne | hop phase | the thing inside is working |

### Universal juice (all units)

- **Hit:** flash (exists) + skew away from impact source.
- **Death:** squash flat, facets scatter as particles.
- **Spawn:** grow from ground with overshoot.
- **Wobble:** damped rotation oscillation, one line per axis.

## The main base — the stone dome (3×3 footprint)

One authored sphere, `src/render/models/buildings/main-base.js` `build(g, add)`, registered in
`buildings/index.js` under the `mainBase` type and reached only as `makeBuilding("mainBase")`.
Radius 2.0 wu, **smooth-shaded** and sunk 40 % of its diameter into the ground (2.4 wu stands
above it), centred on the 3×3 footprint (6 wu) so ~1 wu of painted soil shows on every side. The
Keep, the precursor pit, the orb, the gulp and the asleep/awake swap are all retired, and so is the
4.4 wu cube that replaced them (owner, Aug 22).

Why a smooth sunken sphere: under the pixel pipeline the quantizer carves bands out of a continuous
NdotL gradient, so a smooth curve reads as a lit mass while a flat-shaded ball hands it one value
per facet (flat plates, an inked seam at every step) — the same finding that made the tree crown
smooth. Sinking it is the test-scene reference domes' trick (`tools/test-scene/preset.js` `sink`):
tangent on the ground it reads as a floating marble; buried it reads as rooted.

**Group tree:** `root → [body]` — one toned mesh, no ground plate (the footprint pads are deleted;
see below). The body stays a single mesh on purpose: `bakeStatic()` only fuses two or more meshes,
and a fused mesh's `flat()` vertex-colour material would drop the tone-target uniforms, so a lone
body keeps `toned(TONES.stone, {flatShading:false})`'s authored lit/shadow pair and its night tier.

**Conditional presence.** The base is built, not given. `mainBaseStanding()` (`state.baseLevel > 0`)
gates it: bare ground in the pre-wave opening, an ordinary construction blueprint while the site is
unfinished, the dome from level 1 on. `syncBuildings` skips the completed record so `syncBase` is
the single owner of the map centre.

| Motion | What moves | Driver | Note |
|---|---|---|---|
| notice swell | body scales up ~5% and settles | `state.basePulse` (a delivery landed, or a hit) | the base answers the village |
| hurt flash | body emissive → `PAL.hurtGlow` for .18 s | `state.baseHp` FALLING | `basePulse` cannot tell a delivery from damage |

Authored base LEVEL is not a model state: the `main base · lv n/max` readout and its delivery
progress live in `src/render/overlay.js`, alongside the health bar and the worker-slot tray.

## No footprint pads (Aug 22)

Buildings have no ground plate. `makeFootprintFloor()` and `PAL.pad` are deleted: every body seats
its bottom face on `kit.js` `GROUND_Y` (= 0, the terrain plane), and the bare earth under a
footprint is painted by the TERRAIN, from the wear field `scene.js` stamps per building record
(`rebuildWearStatic` → `landSoil.uLandSoilAt`, `groundTune.soilAt` .85). The stamp is the footprint
rect plus a half-world-unit soil margin and a 1 wu feathered rim; the margin exists because the
wear field is 1 texel/wu and linearly filtered, so without it the soil edge falls *inside* the
footprint and a corner can end up on bare green. Construction blueprints lost their pad too — the
site is four corner posts on painted soil.

## The garrison — the guard station (1×1 footprint)

A villager build, not a keep: the same timber / plaster / stone / metal / banner vocabulary as the
house and the capture yard, plus the guard coat colour so the station reads as the home of the
`guard` worker above. Compact hut pushed to the back (−Z) with a gabled roof and ridge beam, an open
drill yard in front (+Z) — the simulation's `garrisonPost` sits at `y+18`, straight out the doorway,
so nothing may block the +Z half of the footprint. One wide door with a lintel, a shield either side in
`jobGuard` with a `metal` boss, a muster standard at the back corner clearing the roofline, and a
weapon rack of racked spears on the left flank.

**Group tree:** `root → [footings, walls, cornerPosts, roof → ridge, door → lintel, shields, standard, weaponRack, flagstones → postMarkers]`

| Part | What it encodes | Driver |
|---|---|---|
| flagstones | one per guard slot — count comes from `GARRISON.capacity` (3), never restated | authored |
| pennant per flagstone (`userData.postMarkers`) | raised one per **arrived** guard | `durablePostStatus(building).arrived`, synced by `scene.js` |

The pennants use the same contract as the Capture Yard's bay caps: the render layer reads derived
occupancy and raises one marker per unit that is actually standing there. A reserved-but-travelling
guard raises nothing. No new UI and no extra worker model are introduced — vacancy still reads
through the existing worker-slot tray (filled = assigned, hollow = open). There is no text nag.

## Verification

Standalone viewer at `tools/model-viewer.html` (repo root server required for ES modules):
renders any model by name, steppable animation phase, fixed camera angles matching the reference
sheets. Screenshots go to `tools/shots/` for blind side-by-side judging against
`docs/reference/*.png`.
