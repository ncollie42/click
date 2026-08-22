# Asset prompts — building & tower overhaul

Companion docs: `model-spec.md` (in-engine build bible: group trees, accessories, motion vocabulary),
`quality-bar.md` (the standing order and verification loop), `reference/` (accepted sheets).

Paste the **style block** first, then one **asset block**. Regenerate any asset by swapping the asset block only — the style block is what keeps the set looking like one game.

Reference key art: the village scene with the contained pit (2026-08-13). Match it.

**Accepted references (generated 2026-08-13, these ARE the art direction now):**
- `reference/workers.png` — the five peg villagers: gatherer/axe, courier/basket, builder/hammer, guard/spear+shield, carrier/log-stack
- `reference/enemies.png` — the four shadow shards: raider wedge, archer spire, healer bell (hovering, violet pool), brute boulder

New generations of ANY asset should be checked against these two sheets for scale, facet size, and palette discipline.

---

## Style block (always include)

> Stylized low-poly 3D game asset: a single object centered on a small square tile of sage-green grass, plain flat background, no scene around it.
>
> Camera: 3/4 top-down, slight angle, like an isometric strategy game. Flat shading, hard-edged visible facets, posterized lighting with three brightness steps. No gradients, no soft glows, no motion blur, no texture detail — color per facet only. Chunky, slightly toy-like proportions; every detail at the same scale as a low-poly blob tree.
>
> Palette: timber brown #8a7358, dark timber #5c4a38, plaster #c0a170, grey stone #9a9a94, sand #d9c9a3, sage grass #9db97f. Violet #a783df and cyan #71cbd8 are RESERVED — they appear only on precursor elements explicitly named in the asset description, never as decoration.
>
> Everything villager-built is crude and hand-made: rough beams, uneven stone courses, simple joints, no ornament. No text, no UI, no watermark.

---

## Main base: the stone dome (3×3 footprint)

The base is deliberately NOT an art brief any more. It is one authored Three.js sphere —
`src/render/models/buildings/main-base.js`, radius 2.0 wu, smooth-shaded and sunk 40 % of its
diameter into the ground on the 3×3 footprint, painted with `toned(TONES.stone, {flatShading:false})`
so it takes the same authored lit/shadow swatches as the meadow rocks and joins the night tier for
free. There is no keep, no precursor pit, no orb and no asleep/awake variant to generate. (It was a
4.4 wu cube until Aug 22; the owner replaced it, because the pixel quantizer bands a smooth curve
and only plates a faceted one.)

It is also not always there: the player BUILDS it. The map centre is bare ground during the
pre-wave opening, the unfinished base draws as an ordinary construction blueprint, and the dome
appears only once level 1 completes (`state.baseLevel > 0`).

If the dome is ever replaced with authored art, the replacement must still be one body seated on
the ground (there are no footprint pads any more — the terrain paints the soil), must keep
`userData.parts` as the pulse/hurt target, and must not restore any keep / pit / orb identity.
Generate nothing here until that decision is actually taken.

## House (1×1 footprint)

> Asset: a small villager house that produces workers. Plaster #c0a170 walls over a timber frame, steep timber-shingle roof in two browns, one chimney, one oversized friendly front door — the door is the feature, workers walk out of it. A tiny log stack against one wall and a stub of fence.
>
> Cozy and slightly squat, like a toy. Fits a single square tile with a little grass showing around the base. No violet anywhere on this asset.

## Basic Tower (3×3 footprint, upgrade chassis)

> Asset: a wooden watchtower — the plain starter chassis that every tower variant is built on top of. Four rough timber legs with cross-bracing, an open platform with a low plank railing, a simple pitched roof on posts, a ladder up one side. A base course of uneven grey stone blocks anchoring the legs.
>
> Deliberately generic and unarmed: no weapon visible, no banner, no violet — it must look like something waiting to be specialized. Sturdy but crude, centered on its tile with the legs planted wide.

---

## Workers (peg villagers — no limbs, animation-free by design)

Locomotion is transforms only: bob, lean, hop. No arms/legs means no walk cycle. Carrying = actual resources stacked on the head/back (the physical-resource fantasy, visible). Coat colors mirror `workerCoatColor` in code: haul blue, build ochre, guard brown. NO violet/cyan on workers — a violet worker would read as belonging to the thing (save that for a corrupted-worker enemy).

> Asset: a character sheet of five small worker creatures for a village game — simple peg-shaped villagers with NO arms and NO legs: one chunky rounded body like a wooden pawn, a simple head with two dot eyes, no mouth, a tiny hood or hat. They move by bobbing and leaning, so the silhouette must read without any limbs.
>
> Five variants, identical body, told apart by coat color and ONE strapped-on accessory:
> - gatherer — warm tan coat, small axe strapped across the back
> - courier — dusty blue coat, wicker basket worn like a backpack
> - builder — ochre coat, hammer tucked into a belt strap
> - guard — brown coat, round wooden shield on the back, tiny spear angled behind
> - one extra gatherer shown CARRYING: three chunky logs stacked and strapped on top of its head
>
> Each about the height of two grass tufts — must stay readable when tiny. Cozy, sturdy, slightly comic, like carved wooden toys. Colors: coats in muted tans, blues and ochres; skin a warm plaster tone; NO violet and NO cyan on any worker.
>
> Arrange the five in a row on the grass tile, same scale, 3/4 top-down view.

Alt direction (generate once to compare): seed-sprites — acorn bodies, leaf-sprout hats, hop instead of walk. Cuter/more Sokpop, but reads "forest creature" over "villager."

## Enemies (shadow shards — no limbs)

Shape language opposes workers: warm rounded pegs vs cold angular shards. Enemies belong to the thing, so they are the ONE other place violet is legal — thin crack-seams between facets. Silhouettes encode the authored roster (`ENEMY_TYPES`): wedge = melee, spire = ranged, bell = the support you target first, boulder = the tank (brute `size:1.35`). Generate in the same conversation as the worker sheet so scale holds.

> Asset: a character sheet of four night creatures for a village-defense game — angular shadow beings with NO arms and NO legs, each a single faceted body that moves by scuttling, tilting or lumbering. Bodies are matte near-black with pale grey facet edges so they read against darkness; each has two small pale eyes; thin violet #a783df crack-seams glow between some facets, as if something split open and got up. The violet seams are the only color on them.
>
> Four variants, silhouette-first:
> - raider — a low crouched wedge, shard-like, slightly forward-leaning, small horns; reads fast and mean
> - archer — a tall thin spire, top-heavy, a fan of dark quills along its back that it fires; reads ranged
> - healer — the odd one out: a rounded drooping bell shape, like a hooded jellyfish, hovering slightly, a few hanging tendrils and a soft pale glow pooled under it; reads support, not fighter
> - brute — half again taller and much wider than the raider, a hulking cracked boulder of facets with the widest violet seams and heavy forward tilt; reads slow and unstoppable
>
> Line them up on the grass tile smallest to largest, same 3/4 top-down view. They must look like they belong to the same species of darkness, clearly NOT built by villagers: no timber, no plaster, no cloth, nothing hand-made.

---

## Backlog (same style block, prompts to write when needed)

lumber camp · quarry · stockpile · obelisk (violet allowed: the stone itself) ·
tower variants by family — Starter/Ballistics stay pure timber+stone; Elemental/Special mount ONE
salvaged violet/cyan device on the plain chassis · spike trap · land mine · tar · blast charge
