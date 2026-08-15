# The Gauntlet — model-quality playbook

How to run a build-vs-blind-judge loop for new models. Distilled from 28 judged rounds across three
casts (workers ×9, base ×6, enemies ×8+, 2026-08). A fresh session starts HERE, not from scratch.

## What already exists (don't rebuild)

- `tools/model-viewer.html` — standalone viewer; models register via `MODELS = {name: {build, anims, cam}}`;
  add new module paths to its `SOURCES` manifest. Query-driven, deterministic, ACES tone mapping.
- `tools/snap.mjs` — headless screenshots: `node tools/snap.mjs "model=X&anim=Y&phase=0.5" out.png`
  (row mode: `"row=a,b,c&yaw=35&gap=52"`). Shots land in `tools/shots/`. Reports pageerrors.
- `docs/reference/*.png` — accepted art direction. `docs/model-spec.md` — construction + motion vocab.
  `docs/quality-bar.md` — the standing order.
- Live modules: `src/render/models/worker-peg.js`, `the-hole.js`, `enemy-shard.js` — read one as the
  contract example (named parts, rest-snapshot anims `(group, phase01, t)`, sim-px scale, ground origin).

## The recipe (what actually worked)

1. **Builder agent** (cold, `model: opus`, self-contained brief — forks expire mid-loop, cold agents
   with everything written in the brief are more reliable). Brief must include: the module contract,
   the reference path with "open it FIRST," the laws below, a named proof-shot list, and minimum
   iteration count. Builders that measure beat builders that eyeball — demand measurements.
2. **Proof shots in a fixed order**: row (rest pose!), solos, 30px far shot, pure-black thumbnail strip
   (all pairwise silhouettes), action frames at named phases, one close-up crop of the signature
   material. If the module is live in the game: headless boot proof, zero page errors, `validate.mjs`.
3. **Cold blind judge** (fresh agent per round, `model: opus`, never the same one twice): same-subject
   A/B with labels shuffled, extras with per-shot questions, verdict WOWED/CLOSE/NOT-THERE, numbered
   actionable fixes. Give it literal checklists for settled rules ("check the crack crop: lit top
   faces? closed cells?") — turns judging into spec verification.
4. **Orchestrator triage of the fix list** (the critical human/coordinator step):
   - *Invariant* = flagged by ≥2 judges across rounds → mandatory.
   - *Pendulum* = a judge reverses a previous judge (head seating, berm height, eye size flipped
     repeatedly) → FREEZE the axis; reopen only if two consecutive judges agree in one direction.
   - *Judge error* = contradicts a measurement → overrule with data (a judge's brightness spec was
     overruled by pixel-measuring the reference itself; the judge was wrong).
5. **3–5 rounds, then the human gate.** THE BIG LESSON: blind judges never say WOWED against painted
   reference art — same-subject comparison generates rotating structural demands forever. Verdicts
   are a compass; **fix-lists are the product; the finish line is the owner looking at in-game shots.**
   Do not loop past the point where fix-lists stop naming structure and start cycling on taste.

## The laws (canon — paste into every builder brief)

**Measurement beats adjectives**
- Match the reference by MEASURING it: pixel-pick its value percentiles, hue-segment its silhouettes
  for profile ratios, match rendered px widths. Then re-measure your own render. (Workers' 7-round
  "snowman" was one number: waist/hood 0.71 vs the sheet's 0.86.)
- Judge DISPLAYED color, never authored hex — ACES + warm sun shift everything (authored blue-violet
  displays magenta). Author display targets and invert the pipeline (see `toneAlbedo()` in enemy-shard).
- Albedo crush: multiplying near-black yields near-black — value ramps need a bright-enough base or
  no shading system can show.

**Construction**
- Identity lives in `build()`, not anims — every row/solo shot renders REST pose (a hover that exists
  only in the anim reads as standing; it happened twice).
- One continuous shell beats stacked primitives (ball-on-gourd reads "snowman" forever); carve
  features into shared vertices — separate attached meshes poke through and read as masks/decals.
- Color breaks sit on MODELED edge loops (folds), never at primitive intersections.
- Emissive seams: recessed, tapering to zero, branching at acute Y-junctions, tree topology (never a
  closed cell), never following real mesh edges (reads as wireframe), no lit top faces, thin at
  rendered scale. Falloff via one dimmer flat facet — NEVER additive gradient overlays (reads airbrush).
- Silhouettes must be solid at 30px: no white/emissive element may punch a hole through the outline.

**Readability**
- White is the eye channel — never spent anywhere else (projectiles get a licensed white-hot core).
- One token, one meaning: a ground ring can't mean both "heal" and "danger"; a white sliver can't be
  both eye and bolt. Ability register ≠ body-damage register (brighter + saturated + off-body).
- Props read by silhouette + position at 30px, not texture ("one bright shape, one dark line");
  profile faces the camera (an axe's flat facing the viewer reads as a pebble — 5 rounds to find).
- Per-creature front markers if facing matters at distance.
- Telegraphs are SILHOUETTE changes, not poses; the tell precedes the release; never hide the eyes
  or invert the facing in the one frame that must communicate.

**Verification hygiene (half the "art failures" were photography)**
- Before blaming the model, check the photo: wrong snap phase (judges graded a recovery frame as the
  strike for 4 rounds), prop rotated edge-on at contact, anim-only identity, additive overlay hiding
  crisp geometry underneath.
- Snap action frames at the ACTUAL contact phase from a face-visible yaw; black-thumbnail test at a
  COMMON scale; test every claim in the shot the judge will see.
- Known bug classes to assert against: rest-snapshot must exclude the root (teleport-to-origin),
  `toFixed` weld keys hit `-0.000`, three.js Euler order (Z applies first in XYZ) no-ops symmetric
  rotations, backwards winding backface-culls a face into a "ring around a hole."

## Integration (when models go live)

Adoption layer in `src/render/models.js` (`adoptModel`, sim-px wrapper); store-based sync in
`scene.js` (build once per entity, swap only on state change, dispose material ARRAYS); anims are
pure functions of existing sim timers — the sim never learns rendering exists. Watch: double-applied
size scaling, sim-vs-model duplicate projectiles, status tints scoped to body materials only
(never seams/eyes), strike frames synced to the sim's actual hit.
