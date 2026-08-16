#!/usr/bin/env node
// Browser smoke for the standalone map editor: painting invariants, gap-free drag
// strokes, sampling, undo/redo, resize picking, save/load round trips, WFC solve
// status, contradiction highlighting, object placement, disposal symmetry, and
// deterministic review screenshots under tools/shots/map-editor/.

import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir, readFile} from "node:fs/promises";
import {extname, join, resolve} from "node:path";
import {chromium} from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const SHOTS = join(ROOT, "tools/shots/map-editor");
const MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json"};
const server = createServer(async (request, response) => {
  try{
    const pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
    if(pathname === "/favicon.ico"){ response.writeHead(204).end(); return; }
    const path = join(ROOT, pathname);
    if(!path.startsWith(ROOT)){ response.writeHead(403).end(); return; }
    const body = await readFile(path);
    response.writeHead(200, {"content-type": MIME[extname(path)] || "application/octet-stream"});
    response.end(body);
  }catch{ response.writeHead(404).end(); }
});
await new Promise(listen => server.listen(0, "127.0.0.1", listen));
await mkdir(SHOTS, {recursive: true});
const port = server.address().port;
const browser = await chromium.launch({channel: "chrome", headless: true});

const editor = (page, script) => page.evaluate(`(() => { const e = window.__mapEditor; return (${script}); })()`);
const settle = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

try{
  const page = await browser.newPage({viewport: {width: 1500, height: 940}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if(message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/tools/map-editor.html`);
  await page.waitForFunction(() => window.__mapEditorReady === true);

  // ── toolbox tabs expose one authoring concern at a time ──
  assert.equal(await editor(page, "e.getAuthoringPanel()"), "terrain");
  assert.equal((await editor(page, "e.getBrush()")).tool, "rect", "rectangle must be the default terrain tool");
  await page.click("#uTabObjects"); assert.equal(await editor(page, "e.getAuthoringPanel()"), "objects");
  await page.click("#uTabScatter"); assert.equal(await editor(page, "e.getAuthoringPanel()"), "scatter");
  await page.click("#uTabTerrain"); assert.equal(await editor(page, "e.getAuthoringPanel()"), "terrain");

  // ── initial document and solve state: defaults are the game grid ──
  const initial = await editor(page, "({doc: e.getDocument(), solves: e.lastSolves(), preview: e.previewDebug()})");
  assert.deepEqual([initial.doc.width, initial.doc.height, initial.doc.cellSize, initial.doc.seed], [241, 161, 32, 1]);
  assert.equal(initial.doc.land.every(row => row === "~".repeat(241)), true, "a new map must be all water");
  assert.deepEqual([initial.solves.ground.status, initial.solves.raised.status], ["solved", "solved"]);
  assert.ok(initial.preview.triangles >= 2, "water plane missing from the empty preview");
  assert.equal(initial.preview.view.pitch, 40, "game camera must be the default editor preview");

  // Interactive painting runs on a smaller map so screen cells stay comfortably clickable.
  await page.fill("#uWidth", "64");
  await page.fill("#uHeight", "40");
  await page.click("#uNew");
  assert.equal(await page.locator("#uError").textContent(), "");

  // ── gap-free drag stroke through real pointer events ──
  const box = await page.locator("#paint").boundingBox();
  const at = (cx, cy) => ({x: box.x + (cx + .5) * box.width / 64, y: box.y + (cy + .5) * box.height / 40});
  await page.check("#uBrushGround");
  await page.check("#uToolPaint");
  let point = at(10, 10);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  point = at(20, 18); // one coarse jump: the editor must fill the line itself
  await page.mouse.move(point.x, point.y, {steps: 2});
  point = at(26, 18);
  await page.mouse.move(point.x, point.y, {steps: 1});
  await page.mouse.up();
  const afterStroke = await editor(page, "({doc: e.getDocument(), history: e.historyDepth()})");
  assert.equal(afterStroke.history.undo, 1, "one drag stroke must be one undo command");
  const landCells = afterStroke.doc.land.join("").split("").filter(char => char === "#").length;
  assert.ok(landCells >= 17, `coarse drag left gaps (${landCells} cells)`);
  assert.equal(afterStroke.doc.land[18][26], "#", "stroke endpoint unpainted");
  assert.equal(afterStroke.doc.land[10][10], "#", "stroke start unpainted");

  // ── rapid stroke + pointer cancel commits safely ──
  await page.check("#uBrushRaised");
  point = at(12, 22);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  point = at(24, 30);
  await page.mouse.move(point.x, point.y, {steps: 1});
  await page.dispatchEvent("#paint", "pointercancel");
  await page.mouse.up();
  const afterRaised = await editor(page, "e.getDocument()");
  assert.equal(afterRaised.raised[22][12], "^", "raised brush did not raise");
  assert.equal(afterRaised.land[22][12], "#", "raised must imply land");
  assert.equal(afterRaised.raised[30][24], "^", "cancelled stroke lost its painted cells");
  assert.equal((await editor(page, "e.historyDepth()")).undo, 2, "pointer cancel must commit the stroke once");

  // ── water clears raised state and drowns objects ──
  await editor(page, `e.setBrush({mode:"object", objectKind:"tree", objectVariant: 2})`);
  point = at(12, 22);
  await page.mouse.click(point.x, point.y);
  assert.equal((await editor(page, "e.getDocument()")).objects.some(o => o.kind === "tree" && o.cx === 12 && o.cy === 22 && o.variant === 2), true);
  await page.click("#uTabTerrain");
  await page.check("#uBrushWater");
  await page.mouse.click(point.x, point.y);
  const drowned = await editor(page, "e.getDocument()");
  assert.equal(drowned.land[22][12], "~");
  assert.equal(drowned.raised[22][12], ".");
  assert.equal(drowned.objects.some(o => o.cx === 12 && o.cy === 22), false, "water must remove the drowned object");

  // ── sampling: alt-click and the toolbar button ──
  point = at(24, 30); // raised cell
  await page.keyboard.down("Alt");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Alt");
  assert.equal((await editor(page, "e.getBrush()")).mode, "raised", "alt-click did not sample raised");
  await editor(page, `e.setBrush({mode:"object", objectKind:"rock", objectVariant: null})`);
  point = at(22, 18);
  await page.mouse.click(point.x, point.y); // rock on stroke land
  await page.click("#uSample");
  point = at(22, 18);
  await page.mouse.click(point.x, point.y);
  const sampled = await editor(page, "e.getBrush()");
  assert.deepEqual([sampled.mode, sampled.objectKind], ["object", "rock"], "sample button did not pick up the object");

  // ── circle brush: one click stamps a size-3 disc as one undo command ──
  await editor(page, `e.setBrush({mode:"ground", size: 3, tool: "paint"})`);
  const beforeDisc = await editor(page, "({land: e.getDocument().land.join(''), history: e.historyDepth()})");
  point = at(50, 32);
  await page.mouse.click(point.x, point.y);
  const afterDisc = await editor(page, "({doc: e.getDocument(), history: e.historyDepth()})");
  const discCells = afterDisc.doc.land.join("").split("").filter(c => c === "#").length - beforeDisc.land.split("").filter(c => c === "#").length;
  assert.equal(discCells, 13, `size-3 brush must stamp a 13-cell disc, painted ${discCells}`);
  assert.equal(afterDisc.doc.land[32][50], "#");
  assert.equal(afterDisc.doc.land[30][50], "#", "disc must reach 2 cells out on the axes");
  assert.equal(afterDisc.doc.land[30][48], "~", "disc must not fill the square corners");
  assert.equal(afterDisc.history.undo, beforeDisc.history.undo + 1, "one stamp must be one undo command");
  await editor(page, `e.setBrush({size: 1})`);

  // ── rect tool: drag corner-to-corner fills once, as one undo command ──
  await page.check("#uToolRect");
  await page.check("#uBrushRaised");
  const beforeRect = (await editor(page, "e.historyDepth()")).undo;
  point = at(54, 8);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  point = at(60, 13);
  await page.mouse.move(point.x, point.y, {steps: 3});
  await page.mouse.up();
  const afterRect = await editor(page, "({doc: e.getDocument(), history: e.historyDepth()})");
  for(let cy = 8; cy <= 13; cy++) for(let cx = 54; cx <= 60; cx++){
    assert.equal(afterRect.doc.raised[cy][cx], "^", `rect fill missed (${cx}, ${cy})`);
    assert.equal(afterRect.doc.land[cy][cx], "#", "rect raised fill must also set land");
  }
  assert.equal(afterRect.doc.raised[7][54], ".", "rect fill overshot its bounds");
  assert.equal(afterRect.history.undo, beforeRect + 1, "one rect drag must be one undo command");
  await editor(page, "e.undo()");
  assert.equal((await editor(page, "e.getDocument()")).raised[8][54], ".", "rect fill did not undo as one command");
  await editor(page, "e.redo()");
  await page.check("#uToolPaint");

  // ── undo/redo: buttons, keyboard, exact reverts ──
  const checkpoint = await editor(page, "JSON.stringify(e.getDocument())");
  await editor(page, `e.paintCells([[40,5],[41,5],[42,5]], "ground")`);
  assert.notEqual(await editor(page, "JSON.stringify(e.getDocument())"), checkpoint);
  await page.click("#uUndo");
  assert.equal(await editor(page, "JSON.stringify(e.getDocument())"), checkpoint, "undo did not restore the exact document");
  await page.click("#uRedo");
  assert.equal((await editor(page, "e.getDocument()")).land[5][41], "#", "redo did not reapply the stroke");
  await page.keyboard.press("Control+z");
  assert.equal(await editor(page, "JSON.stringify(e.getDocument())"), checkpoint, "Ctrl+Z undo failed");
  await page.keyboard.press("Control+Shift+z");
  assert.equal((await editor(page, "e.getDocument()")).land[5][40], "#", "Ctrl+Shift+Z redo failed");
  await page.keyboard.press("Control+z");

  // ── export/import: exact round trip, history resets after load ──
  const exported = await editor(page, "e.exportJSON()");
  await editor(page, "e.importJSON(" + JSON.stringify(exported) + ")");
  assert.equal(await editor(page, "e.exportJSON()"), exported, "export -> import -> export drifted");
  assert.deepEqual(await editor(page, "e.historyDepth()"), {undo: 0, redo: 0}, "history must not survive a load");
  await editor(page, "e.undo()"); // undo after load must be a safe no-op
  assert.equal(await editor(page, "e.exportJSON()"), exported);

  // ── invalid imports are rejected, document untouched ──
  for(const [bad, pattern] of [
    ["{nope", /invalid JSON/],
    [JSON.stringify({format: "click-authored-map", version: 99}), /unsupported version/],
    [exported.replace(/"raised": \[\s*"\.+/, match => match.replace(/\./, "^")), /raised implies land|unknown character/],
  ]){
    const message = await editor(page, `(() => { try{ e.importJSON(${JSON.stringify(bad)}); return null; }catch(error){ return error.message; } })()`);
    assert.match(message ?? "", pattern, `bad import was not rejected: ${bad.slice(0, 40)}`);
    assert.equal(await editor(page, "e.exportJSON()"), exported, "rejected import mutated the document");
  }

  // ── invalid new-map dimensions surface an error and keep the document ──
  await page.fill("#uWidth", "999");
  await page.click("#uNew");
  assert.match(await page.locator("#uError").textContent(), /width must be in/);
  assert.equal(await editor(page, "e.exportJSON()"), exported);

  // ── new map + resize: exact picking on the resized, CSS-scaled canvas ──
  await page.fill("#uWidth", "24");
  await page.fill("#uHeight", "16");
  await page.click("#uNew");
  assert.equal(await page.locator("#uError").textContent(), "");
  const resized = await editor(page, "e.getDocument()");
  assert.deepEqual([resized.width, resized.height, resized.seed], [24, 16, 1]);
  assert.deepEqual(await editor(page, "e.historyDepth()"), {undo: 0, redo: 0});
  const smallBox = await page.locator("#paint").boundingBox();
  await page.check("#uBrushGround");
  await page.mouse.click(smallBox.x + 23.5 * smallBox.width / 24, smallBox.y + 15.5 * smallBox.height / 16);
  const corner = await editor(page, "e.getDocument()");
  assert.equal(corner.land[15][23], "#", "corner-cell picking drifted after resize");
  assert.equal(corner.land.join("").split("#").length - 1, 1, "resize picking painted more than the corner cell");

  // ── fixture map: edges, corners, strips, holes, diagonals, raised terrain, objects ──
  await page.fill("#uWidth", "28");
  await page.fill("#uHeight", "20");
  await page.click("#uNew");
  await editor(page, `(() => {
    const island = [];
    for(let cy = 3; cy <= 15; cy++) for(let cx = 3; cx <= 19; cx++) island.push([cx, cy]);
    e.paintCells(island, "ground");
    e.paintCells([[8,7],[9,7],[8,8],[9,8]], "water");                       // hole / lake
    e.paintCells([[22,4],[23,5],[24,6],[25,7]], "ground");                  // diagonal chain (saddles)
    e.paintCells([[3,18],[4,18],[5,18],[6,18],[7,18],[8,18]], "ground");    // one-cell strip
    e.paintCells([[13,10],[14,10],[15,10],[13,11],[14,11],[15,11],[14,12]], "raised"); // plateau + concave/convex corners
    e.paintCells([[17,13]], "raised");                                       // isolated raised cell
    e.paintCells([[3,12],[3,13]], "raised");                                 // coast-adjacent raised
    return true;
  })()`);
  const fixture = await editor(page, "({doc: e.getDocument(), solves: e.lastSolves(), preview: e.previewDebug()})");
  assert.deepEqual([fixture.solves.ground.status, fixture.solves.raised.status], ["solved", "solved"]);
  assert.equal(fixture.doc.raised[10][14], "^");
  assert.equal(fixture.doc.land[7][8], "~", "lake hole missing");
  assert.ok(fixture.preview.triangles > 500, "fixture terrain produced too little geometry");
  assert.equal(fixture.preview.contradictionMarkers, 0);

  // ── scatter regions: pointer creation, overlap cycling, one-shot edits, reroll/delete history ──
  const fixtureBox = await page.locator("#paint").boundingBox();
  const fixtureAt = (cx, cy) => ({x: fixtureBox.x + (cx + .5) * fixtureBox.width / 28, y: fixtureBox.y + (cy + .5) * fixtureBox.height / 20});
  await page.click("#uTabScatter");
  await page.selectOption("#uScatterKind", "tree");
  await page.fill("#uScatterDensity", "0.5");
  await page.dispatchEvent("#uScatterDensity", "change");
  let start = fixtureAt(4, 4), finish = fixtureAt(11, 11);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(finish.x, finish.y, {steps: 3}); await page.mouse.up();
  let regions = await editor(page, "e.getDocument().scatterRegions");
  assert.equal(regions.length, 1, "scatter drag must create one region, not explicit cells");
  assert.deepEqual([regions[0].kind, regions[0].cx, regions[0].cy, regions[0].width, regions[0].height, regions[0].density], ["tree", 4, 4, 8, 8, .5]);
  await editor(page, `e.createRegion({id:"grass-over",kind:"grass",cx:4,cy:4,width:8,height:8,density:1,seed:2})`);
  await editor(page, `e.createRegion({id:"rock-over",kind:"rock",cx:4,cy:4,width:8,height:8,density:.25,seed:3})`);
  assert.equal(await page.locator("#uRegionList option").count(), 3, "region browser did not list every region");
  await page.selectOption("#uRegionList", "grass-over");
  assert.equal(await editor(page, "e.selectedRegion()"), "grass-over", "region browser selection did not reach the canvas inspector");
  const overlapPoint = fixtureAt(6, 6);
  await page.mouse.click(overlapPoint.x, overlapPoint.y);
  const selectedA = await editor(page, "e.selectedRegion()");
  await page.mouse.click(overlapPoint.x, overlapPoint.y);
  const selectedB = await editor(page, "e.selectedRegion()");
  assert.notEqual(selectedA, selectedB, "repeated clicks must cycle overlapping regions deterministically");
  await editor(page, `e.selectRegion("tree-1")`);
  const beforeDensityHistory = (await editor(page, "e.historyDepth()")).undo;
  await page.fill("#uScatterDensity", "0.8");
  await page.dispatchEvent("#uScatterDensity", "change");
  assert.equal((await editor(page, `e.getDocument().scatterRegions.find(r=>r.id==="tree-1").density`)), .8);
  assert.equal((await editor(page, "e.historyDepth()")).undo, beforeDensityHistory + 1, "completed density edit must be one command");
  await page.fill("#uRegionId", "forest-test");
  await page.dispatchEvent("#uRegionId", "change");
  assert.equal(await editor(page, `e.getDocument().scatterRegions.some(r=>r.id==="forest-test")`), true, "region rename did not update stable identity");
  assert.equal(await editor(page, "e.selectedRegion()"), "forest-test");
  await editor(page, "e.undo()");
  await page.selectOption("#uRegionList", "tree-1");
  const beforeReroll = await editor(page, `e.getDocument().scatterRegions.find(r=>r.id==="tree-1")`);
  await page.click("#uRegionReroll");
  const afterReroll = await editor(page, `e.getDocument().scatterRegions.find(r=>r.id==="tree-1")`);
  assert.deepEqual({...afterReroll, seed: beforeReroll.seed}, beforeReroll, "reroll changed more than region seed");
  assert.notEqual(afterReroll.seed, beforeReroll.seed);
  await page.click("#uRegionDelete");
  assert.equal((await editor(page, `e.getDocument().scatterRegions.some(r=>r.id==="tree-1")`)), false);
  await editor(page, "e.undo()");
  assert.equal((await editor(page, `e.getDocument().scatterRegions.some(r=>r.id==="tree-1")`)), true);
  await editor(page, "e.redo()");
  await editor(page, "e.undo()");
  const scatterPreview = await editor(page, "({resolved:e.scatterResult(),preview:e.previewDebug()})");
  assert.deepEqual([scatterPreview.preview.generatedTrees, scatterPreview.preview.generatedRocks, scatterPreview.preview.generatedGrass], [scatterPreview.resolved.trees.length, scatterPreview.resolved.rocks.length, scatterPreview.resolved.grass.length]);

  // objects on ground and raised terrain, then verify placement flows
  await editor(page, `(() => {
    e.setBrush({mode:"object", objectKind:"base", objectVariant: null});
    e.paintCells([[6,12]]);
    e.setBrush({mode:"object", objectKind:"tree", objectVariant: 1});
    e.paintCells([[5,5],[14,10]]);   // one on ground, one on the plateau
    e.setBrush({mode:"object", objectKind:"quarry", objectVariant: null});
    e.paintCells([[17,6]]);
    e.setBrush({mode:"object", objectKind:"tower", objectVariant: null});
    e.paintCells([[17,6]]);          // replace the quarry in place
    e.setBrush({mode:"erase"});
    e.paintCells([[5,5]]);           // erase one tree
    return true;
  })()`);
  const withObjects = await editor(page, "({doc: e.getDocument(), preview: e.previewDebug()})");
  assert.deepEqual(withObjects.doc.objects.map(o => o.kind).sort(), ["base", "tower", "tree"]);
  assert.equal(withObjects.doc.objects.some(o => o.kind === "quarry"), false, "replaced object survived");
  assert.equal(withObjects.preview.objects, 3, "preview explicit-object models out of sync with the document");
  const conflictCheck = await editor(page, "({doc:e.getDocument(),scatter:e.scatterResult(),preview:e.previewDebug()})");
  const explicitCells = new Set(conflictCheck.doc.objects.map(o => `${o.cx},${o.cy}`));
  assert.equal([...conflictCheck.scatter.trees, ...conflictCheck.scatter.rocks, ...conflictCheck.scatter.grass].some(cell => explicitCells.has(`${cell.cx},${cell.cy}`)), false, "preview resolver retained explicit/generated conflicts");
  assert.deepEqual([conflictCheck.preview.generatedTrees, conflictCheck.preview.generatedRocks, conflictCheck.preview.generatedGrass], [conflictCheck.scatter.trees.length, conflictCheck.scatter.rocks.length, conflictCheck.scatter.grass.length]);
  const objectsOnWater = await editor(page, `(() => { e.paintCells([[6,12]], "water"); const gone = !e.getDocument().objects.some(o => o.kind === "base"); e.undo(); return gone; })()`);
  assert.equal(objectsOnWater, true, "painting water under the base did not remove it");
  assert.deepEqual(await editor(page, "e.getDocument()"), withObjects.doc, "undo did not restore the drowned base exactly");

  // end-to-end: paint -> place -> raise -> save -> reload
  const fullExport = await editor(page, "e.exportJSON()");
  await editor(page, "e.importJSON(" + JSON.stringify(fullExport) + ")");
  assert.equal(await editor(page, "e.exportJSON()"), fullExport, "full fixture did not survive a save/reload");

  // ── screenshots ──
  await settle(page);
  await page.screenshot({path: join(SHOTS, "editor-2d-and-preview.png")});
  await editor(page, "e.setPreviewView({yaw: 38, pitch: 42})");
  await settle(page);
  await page.locator("#previewPane").screenshot({path: join(SHOTS, "fixture-angled.png")});
  await editor(page, "e.resetCamera()");
  await settle(page);
  await page.locator("#previewPane").screenshot({path: join(SHOTS, "fixture-top-down.png")});

  // ── disposal symmetry across repeated rebuilds ──
  await settle(page);
  const before = await editor(page, "e.previewDebug()");
  await editor(page, `(() => { for(let i = 0; i < 12; i++){ e.paintCells([[26,18]], i % 2 ? "water" : "ground"); } return true; })()`);
  await settle(page); // let the renderer upload the last rebuild before measuring
  const after = await editor(page, "e.previewDebug()");
  // Fresh geometries only register with the renderer once drawn (culled meshes never
  // do), so the renderer count may dip — but growth across identical states is a leak.
  assert.ok(after.rendererGeometries <= before.rendererGeometries,
    `rebuilds leak renderer geometries: ${before.rendererGeometries} -> ${after.rendererGeometries}`);
  assert.deepEqual(
    [after.terrainMeshes, after.triangles, after.objects],
    [before.terrainMeshes, before.triangles, before.objects],
    "identical documents must rebuild to identical scene stats");

  // ── real contradictions: reduced module set, highlighted, then recovered ──
  await editor(page, `e.setShapeFilter({ground: ["empty","convex","straight","concave","full"]})`);
  const contradiction = await editor(page, "({solves: e.lastSolves(), preview: e.previewDebug(), doc: e.getDocument()})");
  assert.equal(contradiction.solves.ground.status, "contradiction");
  assert.ok(contradiction.solves.ground.contradictions.every(entry => entry.layer === "ground" && Number.isInteger(entry.dx) && /mask/.test(entry.reason)));
  assert.ok(contradiction.preview.contradictionMarkers > 0, "contradiction cells are not highlighted");
  assert.equal(JSON.stringify(contradiction.doc), JSON.stringify(withObjects.doc), "contradiction handling mutated authored terrain");
  await settle(page);
  await page.locator("#previewPane").screenshot({path: join(SHOTS, "contradiction.png")});
  await editor(page, "e.setShapeFilter(null)");
  assert.equal((await editor(page, "e.lastSolves()")).ground.status, "solved");

  // Canonical starter: editor/game policy agreement and review screenshots.
  const starterJSON = await readFile(join(ROOT, "src/game/maps/starter.map.json"), "utf8");
  await editor(page, `e.importJSON(${JSON.stringify(starterJSON)})`);
  const starter = await editor(page, "({scatter:e.scatterResult(),preview:e.previewDebug(),doc:e.getDocument()})");
  assert.equal(starter.doc.version, 2);
  assert.deepEqual([starter.preview.generatedTrees,starter.preview.generatedRocks,starter.preview.generatedGrass],[starter.scatter.trees.length,starter.scatter.rocks.length,starter.scatter.grass.length]);
  await settle(page);
  await page.screenshot({path: join(SHOTS, "starter-map-loaded.png")});
  await editor(page, "e.gameView()");
  await settle(page);
  await page.locator("#previewPane").screenshot({path: join(SHOTS, "starter-game-view.png")});

  assert.deepEqual(errors, []);
  console.log(`map editor smoke ok | stroke cells ${landCells} | fixture triangles ${fixture.preview.triangles} | objects ${withObjects.preview.objects} | contradictions highlighted ${contradiction.preview.contradictionMarkers} | shots in tools/shots/map-editor/`);
}finally{
  await browser.close();
  server.close();
}
