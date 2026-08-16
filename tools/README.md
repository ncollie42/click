# Repository tools

Serve the repository root so browser ES-module imports resolve:

```sh
node tools/serve.mjs        # port 8000; also enables the map editor's "save to game" button
python3 -m http.server 8000 # read-only alternative (live save unavailable)
```

`tools/serve.mjs` additionally accepts `PUT /src/game/maps/starter.map.json` from the editor,
validating the body with the real game loader (`parseMapDocument` + `buildWorldFromMapData`)
before writing — an invalid map is rejected with a 400 and nothing changes on disk.

- Terrain render screenshots/smoke: `node tools/terrain-render-snap.mjs`. Boots the game on the authored starter map and captures fixed full-map, base, coast, and showcase views under ignored `tools/shots/terrain/`. It checks browser/pointer behavior, base-ring enemy spawns, authored resource counts, terrain revision rebuild-disposal symmetry, bounded renderer resources, overview grid suppression, cold startup, 120 forced frames, and representative RAF timing. Screenshots are review artifacts, never pixel-perfect assertions.
- Model viewer: open `http://localhost:8000/tools/model-viewer.html`.
- Model screenshots: `node tools/snap.mjs "model=worker-gatherer&anim=chop&phase=0.5" out.png`.
- Map editor: open `http://localhost:8000/tools/map-editor.html`. The authored-map tool: manual cells define what exists, WFC decides how it looks in the editor preview.
- Map editor Node tests: `node --test tools/map-editor/map-document.test.mjs tools/map-editor/scatter-regions.test.mjs tools/map-editor/terrain-wfc.test.mjs`.
- Map editor browser smoke + screenshots: `node tools/map-editor-smoke.mjs` (Playwright + system Chrome; review shots land under ignored `tools/shots/map-editor/`).

## Authored world

Procedural world generation is gone. The game boots from `src/game/maps/starter.map.json` through `src/game/authored-map.js`, which derives the 16px terrain raster, the presentational raised layer, and region-authored tree/rock/grass cells while preserving explicit landmarks (including diamonds/chests). Enemies spawn at random points on a ring around the base (`ENEMY_SPAWN_RADIUS` in data.js), preferring land — no directional or shoreline spawning. The game's terrain look is the same dual-grid WFC as the editor preview, solved from the map seed. Game maps must be exactly 241×161 cells at 32px — one authored cell per placement cell — with the base footprint on land and one chest inside the 128–352px discover band. Loads fail loudly on anything else (wrong size, unsupported object kinds, raised-over-water); nothing is silently repaired.

To change the world: open the map editor, `load JSON` → `src/game/maps/starter.map.json`, edit, `download JSON`, and replace the file. `base.json` and `old.json` are migrated v2 explicit-only snapshots (`scatterRegions: []`), not production scatter examples. `scripts/validate.mjs` gates the result.

## Map editor

The persistent left toolbox uses **terrain**, **objects**, and **scatter** authoring tabs so inactive controls never compete for attention. The left canvas is authoritative; the right Three.js preview rebuilds only after a completed stroke, undo/redo, load, new map, or seed change.

- Document (`src/game/map-document.js`, DOM-free, shared with the game loader): versioned JSON (`click-authored-map` v2), default 241×161 cells at 32 game px. Binary land rows (`~`/`#`), raised rows (`.`/`^`), sparse explicit objects, and canonical `scatterRegions`. A region is `{id, kind, cx, cy, width, height, density, seed}`: unique stable ID, `tree|rock|grass`, in-bounds positive cell rectangle, finite probability `[0,1]`, uint32 local seed. v1 remains readable as no regions; every save emits v2. Imports deep-copy and validate, never repair.
- Scatter resolution (`src/game/scatter-regions.js`, DOM-free): each cell hashes map seed + region ID/seed + kind + coordinates. Map-seed rerolls affect terrain and all regions; region-seed rerolls stay local except legitimate overlap conflicts. Overlap is array-order independent and resolves explicit objects → rock → tree → grass. Generated cells require land, the game build margin, and base protection; one resolved occupant per cell. Diamonds/chests remain explicit, and explicit trees/rocks remain available as landmarks.
- Terrain tab: water (clears raised and drowns the cell's object), ground, and raised (sets land). Rectangle is the default tool; brush sizes 1–4 stamp discs after switching to brush. Objects tab: erase or place from the curated `src/render/models.js` palette — trees, rock, diamond, chest, base, house, lumber camp, quarry, stockpile, obelisk, tower. Objects always place singly. Alt-click or the sample button picks up a cell's terrain/object. Drag strokes are gap-free, and every stroke, stamp, or rect fill commits as one undo command; undo/redo is bounded (200) with Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
- WFC (`terrain-modules.js` + `terrain-wfc.js`, DOM-free): a dual grid where each solver cell observes four authored cells (outside = water) as a 4-corner topology mask. Six canonical shapes (empty, convex, straight, saddle, concave, full) × rotations cover all 16 masks with orientation-aware edge sockets; two independently salted deterministic passes solve ground and raised thresholds from the saved seed. Painted terrain is authoritative — WFC only picks modules, rotations, and weighted variants; contradictions come back structured (`dx, dy, mask, layer, reason`) within bounded retries and are highlighted red in the preview without touching authored cells.
- Scatter tab: choose kind/density and drag one rectangle. A stable-ID-sorted region browser provides direct selection when regions are small or overlap; array order intentionally has no placement meaning. The selected-region inspector (ID, bounds, seed, reroll, delete, counts) appears only after selection. Renaming changes stable identity and therefore rerolls that region. Bounds, labels, density, selection, edits, delete, and local reroll remain region operations—not object fills. Repeated canvas clicks cycle overlapping regions in stable-ID order. Completed create/edit/delete/reroll actions each make one undo command; water painting leaves rectangles intact and merely changes resolver eligibility.
- Preview (`preview.js`): shared water plane, marching-squares module tops with shoreline/cliff walls (ground at 0, raised one fixed level up, cliffs meeting without cracks), exact shared-resolver tree/rock placements plus one instanced grass mesh, explicit project models placed at cell centers with terrain-derived height, orbit/pan/zoom, a top-down reset, and a `game view` button that matches the in-game camera (pitch 40, yaw 0, fov 38). The game renders the same WFC module terrain (`src/render/scene.js` shares `src/game/terrain-modules.js` + `terrain-wfc.js` and the map seed), textured with the game grass/palette; the raised layer is presentational there — entities ride it visually while gameplay stays 2D.

Data flow: map JSON → `map-document.js` parse/invariants → `scatter-regions.js` resolution → `authored-map.js` frozen blueprint and editor preview → `simulation.js` mutable materialization. WFC controls terrain appearance only; authored land/raised cells control topology/elevation and scatter regions control generated resource/vegetation presence.

Terrain texture memory is fixed at a 64×64 RGBA repeat: 16 KiB CPU canvas backing and 16 KiB base GPU level, with mipmaps disabled. The render smoke prints measured cold startup, forced-frame elapsed time, RAF mean/p95, and draw/geometry/texture counts; thresholds are deliberately broad for headless Chrome and are performance regression alarms, not gameplay targets.
