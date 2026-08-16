# Gauntlet: recreate the reference map as authored data

Run a gauntlet loop (recipe: `docs/gauntlet.md` — read it first) to recreate
`docs/reference/map-target.png` as the game's authored map. **Data-only run: the deliverable is
`src/game/maps/starter.map.json`. No game or editor code changes.** Throwaway authoring scripts in
the scratchpad are fine (and expected — nobody hand-edits 161 rows).

Before round 1: copy the current `src/game/maps/starter.map.json` to the scratchpad as backup
(working tree is already dirty; don't rely on git).

## Builder brief (cold agent, `model: opus`, self-contained — paste all of this)

- Open `docs/reference/map-target.png` FIRST.
- Map format: `click-authored-map` v2, exactly 241×161 cells @32px. Read `src/game/map-document.js`
  for the schema and reuse its serialize/parse from a Node script — author the JSON
  programmatically, then replace `src/game/maps/starter.map.json`.
- Hard invariants (loader fails loudly, never repairs):
  - Base 3×3 footprint on land at cells (119–121, 79–81); base center is cell (120,80), sim (3840,2560).
  - Exactly one chest 128–352 sim-px from base center.
  - Raised cells never on water. Only supported object kinds (tree, rock, diamond, chest, …).
  - Gate every round with `node scripts/validate.mjs`.
- Terrain look is derived: WFC picks chamfered coasts and cliff walls automatically. You author only
  the land mask (`~`/`#`), the raised mask (`.`/`^`), objects, and scatter regions. Grass
  auto-derives from land (~14%) — don't author grass regions unless you want dense patches.
- Scatter regions are rectangles `{kind: tree|rock|grass, cx, cy, width, height, density, seed}`.
  **Organic forest blobs = 3–6 overlapping small rects at varied density, never one big rectangle.**
  Rocks = small sparse regions. Keep landmarks explicit (2 diamonds, 1 chest, a few hero trees/rocks).
- Proof shots: after replacing the file, run `node tools/terrain-render-snap.mjs`. Shots land in
  `tools/shots/terrain/` — `normal-full-map.png` is the judge shot; base/coast/meadow shots are
  supporting evidence. Zero page errors required.

### Measure, don't eyeball (round 1 builder does this before authoring anything)

- Grid the reference into a 6×4 overlay (script it — sample pixel hues per cell). Per cell record
  approximate water / raised-plateau / forest / open-meadow coverage.
- Targets to extract: lake count (~10–14 mid-size, elongated, stepped diagonal edges), water % of
  frame, plateau band along the top edge plus scattered raised pockets, forest clusters hugging lake
  shores and plateau rims (mixed dense cores + sparse fringes), large open meadows near center.
- The reference is a ~16:9 crop of a larger world; our map is 3:2. Reproduce the composition and let
  it extend vertically; keep the center relatively open (that's where our base lives).
- Re-measure your own output every round: print water %, raised %, region count, resolved tree-cell
  count from the JSON, and compare against the reference targets BEFORE requesting a judge.

## Judge brief (cold blind judge per round, `model: opus`, never reused)

- Give it the reference and `normal-full-map.png`.
- Scope explicitly to macro composition ONLY: lake count / size distribution / shapes, stepped
  coastlines, plateau placement, forest-cluster organic-ness (**call out any visible rectangle
  edges in vegetation**), meadow negative space, rock sprinkling.
- Tell it to IGNORE: art style, tree colors (reference has pink trees we don't ship), buildings,
  enemies, the UI popup, camera/projection differences.
- Verdict WOWED / CLOSE / NOT-THERE + numbered fixes with cell-coordinate specificity
  ("lake near cells (60,40) too round, extend E–W" — not "lakes feel off").

## Orchestrator triage (per docs/gauntlet.md)

- Flagged by 2+ judges → mandatory. Judge reversals → freeze the axis. Judge claims that contradict
  a measurement → overrule with data.
- 3–5 rounds max; stop when fix-lists stop naming structure and start cycling on taste.
- Final gate: `validate.mjs` green, `terrain-render-snap.mjs` clean, full-map + base + coast shots
  presented to the owner. Leave the winning `starter.map.json` in place; state the backup path.
