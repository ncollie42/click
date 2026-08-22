# 05 — Diamond deposit

**Skill:** `pixel-model`. **Replaces:** `src/render/models/nodes/diamond.js` → `makeDiamond()`,
which adopts `models/reviewed/resource-nodes.js` keys `diamond` and `diamond-spent` through
`node-mesh.js`. Keep `makeDiamond` exported; drop the `node-mesh.js` import.

## What it is
A mineable deposit: a low mound with a crystal cluster that spins; when depleted, a spent crater.
Per-entity (not scatter-instanced), so it keeps separate parts.

## Size
~1 cell (crystals ~1.9 wu tall). ~28 texels: mound = one band, crystals = a few big flat planes
with a real highlight face. Leave off any facet under 2 texels.

## Contract to keep
- `g.userData = {live: [group], spent, gem}`: `live` entries toggle with `spent` on `depleted`;
  `gem` spins — scene.js ~899 rotates `gem.children` if present, else `gem` itself.
- Collapse: the live cluster sinks/spins out over the sim's `collapse` countdown (scene-side).

## Doctrine notes
- Crystals are the canonical "few large flat planes" object: 4–6 faces each, 2–3 crystals, one
  saturated albedo (`PAL.gem`) — the quantizer will do the facet banding.
- Mound = smooth curve or a single low plane; spent crater = dark flat disc with a rim.

## Exit
README "done" list + play-zoom and 3× shots of live and spent beside the 1×1 ball.
