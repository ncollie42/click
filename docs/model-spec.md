# Model spec — units, accessories, motion

The build bible for in-game procedural models (three.js, flat-shaded, no rigs). Companion to
`docs/asset-prompts.md` (generation prompts) and `docs/reference/*.png` (the accepted look).
Quality bar: `docs/quality-bar.md` — blind side-by-side with reference, as good or better.

## Ground rules

- **Flat shading everywhere** (`flatShading:true`), facets visible, three-step lighting feel.
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
| gatherer | tan `coat` | axe across back (shoulder strap) | harvest / staff |
| courier | dusty blue `jobHaul` | wicker basket worn as backpack | haul |
| builder | ochre `jobBuild` | hammer tucked in belt (belt point) | build |
| guard | brown `jobGuard` | round shield on back + spear angled behind (both back-mounted) | guard |
| carrier | any coat | 3-log stack strapped on head (head top) | any worker with `carried > 0` |

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

## The main base — the Keep and the Hole (3×3 footprint)

The keep stays (it charms); the pit joins it. Full footprint: the model fills its entire 3×3 cell
reservation (96×96 sim px) — keep on one half, pit on the other, sand apron underneath, crude
timber+stone curb around the pit rim with one tip-in chute. Thin violet cracks radiate from the
pit and stop before the keep.

**Group tree:** `root → [apron, keep → [tower, crenellations, door], pit → [funnel, curb, chute, cracks], orb*]`

| Motion | What moves | Driver | Charm note |
|---|---|---|---|
| idle breath | pit glow intensity slow-pulses | time | it is asleep, not dead |
| feed gulp | funnel scales down-in briefly; cracks flash brighter | delivery event (`basePulse`) | the thing noticed |
| tier-up | one new crack ring appears; longer rumble pulse | xp tier crossing | "I just made it worse" |
| orb (awake stage) | faceted orb hovers over pit, slow spin + bob | tier ≥ threshold | the guardian woke up |

## Verification

Standalone viewer at `tools/model-viewer.html` (repo root server required for ES modules):
renders any model by name, steppable animation phase, fixed camera angles matching the reference
sheets. Screenshots go to `tools/shots/` for blind side-by-side judging against
`docs/reference/*.png`.
