# 07 — Retire the adoption layer (last)

**Precondition:** tickets 01–06 merged — `grep -rn "models/reviewed" src tools` returns nothing
but this ticket's targets.

## Delete
- `src/render/models/reviewed/` (all five modules) and `tools/model-viewer.html` + `tools/snap.mjs`
  (their ACES viewer/snapper — the pixel harness `tools/rock-snap.mjs` is the replacement).
- `src/render/models/adopt.js`, `src/render/models/nodes/node-mesh.js`.
- In `src/render/models/game-rig.js`: `relightForGame`, `relightGeometry`, `GAME_TARGET`,
  `GAME_UP_IRR`, `GAME_EXPOSURE` and the exposure essay — they exist only to bake viewer-calibrated
  casts. Keep the rig MIRROR constants only if something still reads them (check; likely delete
  the file entirely and the barrel exports with it).
- In `kit.js`: `outlineMatPx` + `addPxOutline` (sim-px ink), and scene.js's per-frame thickness
  mirror for `outlineMatPx`. `bakeStatic`'s `requireShadow:false`/`shell:false` paths were for
  pre-adoption bakes — simplify if no caller remains.
- `docs/model-spec.md`: the sim-px scale paragraphs; `docs/quality-bar.md`, `docs/asset-prompts.md`,
  `docs/reference/` — keep only what a pixel-doctrine model still cites.

## Exit
`node scripts/validate.mjs` green; headless boot (`tools/rock-snap.mjs`) with zero page errors;
`models.js` barrel exports only live symbols; `docs/pixel-models.md` case-law row for the reviewed
casts changed from "replace" to "gone".
