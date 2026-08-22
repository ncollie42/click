# Model rebuild tickets

One ticket per model that must be rebuilt under the pixel-pipeline doctrine. Each is written for a
fresh agent with zero context: it names the law, the skill, the contract to keep, and the exit.

**Every ticket starts the same way:** invoke the `pixel-model` skill (it loads
`docs/pixel-models.md`, the law, and runs the audition loop). Do not start from the old model's
construction — the reviewed casts are the thing being replaced, not the reference.

**What "done" means for every ticket** (the ticket adds its own specifics):
1. New model lives in its own file under `src/render/models/{units,buildings,nodes}/`, built in
   world units with plain `MeshLambertMaterial` albedo (via `kit.js` `flat()` / `meshOf()`), no
   relight, no sim-px wrapper, no `models/reviewed/` import. Header names its `userData` contract.
2. The contract scene.js already drives is kept verbatim (listed per ticket) — scene.js changes only
   if the ticket says so.
3. Headless proof: `node tools/rock-snap.mjs <name>.png [zoom] [x] [y]` at play zoom and 3×,
   and the read is NAMED as the intended subject at both. `node scripts/validate.mjs` green.
4. `docs/pixel-models.md` case-law row added. The old module key is no longer imported anywhere
   (leave the file in `models/reviewed/` — ticket 07 deletes the folder once all are done).

Order: 01 → 06 are independent; 07 last. Size vocabulary: 1 cell = 2 wu = 32 game px.

| # | ticket | replaces | seen how often |
|---|---|---|---|
| 01 | [workers](01-workers.md) | `reviewed/worker-peg.js` | constantly — highest value |
| 02 | [enemies](02-enemies.md) | `reviewed/enemy-shard.js` | every night |
| 03 | [main base](03-main-base.md) | `reviewed/the-hole.js` | always on screen |
| 04 | [summoning circle](04-summoning-circle.md) | `reviewed/summoning-circle.js` | per cast |
| 05 | [diamond](05-diamond.md) | `reviewed/resource-nodes.js` diamond keys | map prop |
| 06 | [chest](06-chest.md) | `reviewed/resource-nodes.js` chest keys | map prop |
| 07 | [retire the adoption layer](07-retire-adoption-layer.md) | `adopt.js`, `game-rig.js` relight, `node-mesh.js`, `models/reviewed/` | — |
