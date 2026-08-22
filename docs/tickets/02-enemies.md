# 02 — Enemies (shadow shards)

**Skill:** `pixel-model`. **Replaces:** `src/render/models/units/enemy.js` → `makeEnemy(type)`
(and keep `makeCorpse`), which adopts `models/reviewed/enemy-shard.js`.

## What it is
Five archetypes from `ENEMY_TYPES[type].archetype` (data.js): `raider`, `archer`, `healer`,
`brute`, `bomber`; the boss is a brute scaled by `ENEMY_TYPES.modelScale` (scene.js applies it —
never bake collision `size` into the model). Variants (veteran/elite) tint by
`ENEMY_TYPES[type].variantColor`; keep the luminance-preserving vertex tint in `enemy.js`
(`tintEnemyGeometry`) or re-implement it as a material colour if the new albedo is bright enough
for a multiplier to read — the old cast was near-black, which is WHY the vertex trick existed.

## Size
Raider/archer/healer/bomber ≈ 1 cell tall; brute ≈ 1.35×. ~15–20 texels at play zoom: the
archetype must be one silhouette word each (blade, bow, halo, mass, round+fuse).

## Contract to keep
- `g.userData = {inner, anims, tintMats}`; `tintMats` = the unique BODY materials (lit,
  zero-emissive Lambert) that hit-flash/burn recolour — never eyes or ability FX.
- `anims` per archetype, all `(inner, phase01, t)`:
  raider `scuttle`, `lunge` · archer `sway`, `fire` · healer `hover`, `heal` ·
  brute `thump` (also used for walk/jab phases) · bomber `scuttle`, `arm`.
  Missing optional anims fall back as scene.js ~1085–1105 shows; idle forms must exist.
- Archer: the sim draws its own bolt (`beam()`); do not model a projectile.
- Enemy palette is violet/cyan (precursor register); villager colours are forbidden here.

## Doctrine notes
- Shard body = few large flat planes (an angular crystal reads "enemy" and bands perfectly);
  eyes = white, nothing else white. Abilities read by silhouette change, not pose.
- Dark albedo crush: near-black multiplies to near-black — give the body a mid value so bands show.

## Exit
README "done" list + a row shot of all five archetypes beside the 1×1 ball, plus the brute boss at
`modelScale`, plus one `lunge` and one `fire` contact frame from a face-visible yaw.
