// Map editor — Node tests for the terrain module grammar and WFC solver (node --test).

import assert from "node:assert/strict";
import {test} from "node:test";
import {createMapDocument, assertMapInvariants, serializeMapDocument} from "../../src/game/map-document.js";
import {
  SHAPES, SIDES, buildModuleCatalog, modulesForMask,
  maskFromCorners, rotateMaskCW, reflectMask, socketForSide, compatibleSockets,
} from "../../src/game/terrain-modules.js";
import {deriveDualMasks, solveTerrainWfc} from "../../src/game/terrain-wfc.js";

function landFixture(paint){
  const doc = createMapDocument({width: 12, height: 10, cellSize: 32, seed: 42});
  paint(doc);
  return assertMapInvariants(doc);
}
const blob = doc => { for(let cy = 2; cy <= 7; cy++) for(let cx = 2; cx <= 9; cx++) doc.land[cy * doc.width + cx] = 1; };

test("mask algebra: corners, rotation, reflection", () => {
  assert.equal(maskFromCorners({nw: 1, ne: 0, se: 0, sw: 0}), 0b0001);
  assert.equal(maskFromCorners({nw: 0, ne: 1, se: 1, sw: 1}), 0b1110);
  assert.equal(rotateMaskCW(0b0001), 0b0010, "NW rotates to NE");
  assert.equal(rotateMaskCW(0b1000), 0b0001, "SW rotates to NW");
  assert.equal(rotateMaskCW(rotateMaskCW(rotateMaskCW(rotateMaskCW(0b1011)))), 0b1011, "four rotations are identity");
  assert.equal(reflectMask(0b0001), 0b0010, "NW mirrors to NE");
  assert.equal(reflectMask(0b0101), 0b1010, "saddle mirrors to the opposite saddle");
  for(let mask = 0; mask < 16; mask++) assert.equal(reflectMask(reflectMask(mask)), mask);
});

test("catalog: every topology mask is covered exactly once per layer", () => {
  for(const layer of ["ground", "raised"]){
    const catalog = buildModuleCatalog({layer});
    assert.equal(catalog.length, 16);
    for(let mask = 0; mask < 16; mask++){
      const matches = modulesForMask(catalog, mask);
      assert.equal(matches.length, 1, `mask ${mask} must map to exactly one shape+rotation`);
      assert.equal(matches[0].layer, layer);
      assert.ok(matches[0].variants.length >= 1);
      assert.ok(matches[0].variants.every(variant => variant.weight > 0));
    }
    // Rotation metadata: rotating a shape's base mask r times yields the instance mask.
    for(const module of catalog){
      let expected = SHAPES.find(shape => shape.id === module.shape).baseMask;
      for(let step = 0; step < module.rotation; step++) expected = rotateMaskCW(expected);
      assert.equal(module.mask, expected, `${module.id} rotation metadata drifted`);
      assert.equal(typeof module.reflectionOf, "string");
      for(const side of SIDES) assert.equal(module.sockets[side], socketForSide(module.mask, side));
    }
  }
  assert.throws(() => buildModuleCatalog({layer: "underground"}), /unknown layer/);
});

test("sockets: derivation and orientation-aware compatibility", () => {
  // straight with the north edge occupied: mask NW+NE.
  const mask = 0b0011;
  assert.equal(socketForSide(mask, "n"), "ll");
  assert.equal(socketForSide(mask, "e"), "lw");
  assert.equal(socketForSide(mask, "s"), "ww");
  assert.equal(socketForSide(mask, "w"), "wl");
  assert.equal(compatibleSockets("ll", "ll"), true);
  assert.equal(compatibleSockets("ww", "ww"), true);
  assert.equal(compatibleSockets("lw", "wl"), true, "asymmetric sockets match their reverse");
  assert.equal(compatibleSockets("lw", "lw"), false, "asymmetric sockets must not match themselves");
  assert.equal(compatibleSockets("ll", "ww"), false);
  assert.throws(() => compatibleSockets("ll", 3), /sockets must be strings/);
});

test("dual grid: each solver cell observes four authored cells; outside is water", () => {
  const empty = createMapDocument({width: 8, height: 8});
  const emptyDual = deriveDualMasks(empty, "ground");
  assert.deepEqual([emptyDual.cols, emptyDual.rows], [9, 9]);
  assert.equal(emptyDual.masks.every(mask => mask === 0), true);

  const one = createMapDocument({width: 8, height: 8});
  one.land[3 * 8 + 2] = 1; // single land cell at (2,3)
  const dual = deriveDualMasks(one, "ground");
  const at = (dx, dy) => dual.masks[dy * dual.cols + dx];
  assert.equal(at(2, 3), 0b0100, "land cell is the SE corner of the dual cell at its own coordinates");
  assert.equal(at(3, 3), 0b1000, "SW corner");
  assert.equal(at(2, 4), 0b0010, "NE corner");
  assert.equal(at(3, 4), 0b0001, "NW corner");
  assert.equal(dual.masks.reduce((sum, mask) => sum + (mask !== 0 ? 1 : 0), 0), 4);

  // Raised layer derives from the raised grid, not land.
  one.raised[3 * 8 + 2] = 1;
  one.land[3 * 8 + 3] = 1;
  const raisedDual = deriveDualMasks(one, "raised");
  assert.equal(raisedDual.masks[3 * 9 + 3], 0b1000, "raised dual ignores non-raised land");
  assert.throws(() => deriveDualMasks(one, "lava"), /unknown layer/);
});

test("solve: shapes match painted topology, assembly is socket-consistent, doc untouched", () => {
  const doc = landFixture(blob);
  const before = JSON.stringify(serializeMapDocument(doc));
  const catalog = buildModuleCatalog({layer: "ground"});
  const result = solveTerrainWfc({doc, catalog});
  assert.equal(result.status, "solved");
  assert.equal(result.cells.length, 13 * 11);
  const {masks} = deriveDualMasks(doc, "ground");
  for(const cell of result.cells){
    assert.equal(cell.mask, masks[cell.dy * result.cols + cell.dx]);
    const module = catalog.find(entry => entry.id === cell.moduleId);
    assert.equal(module.mask, cell.mask, "chosen module does not satisfy the painted topology");
    assert.ok(module.variants.some(variant => variant.id === cell.variant));
  }
  assert.equal(JSON.stringify(serializeMapDocument(doc)), before, "solver mutated the authored document");
});

test("solve: deterministic from the saved seed; seed and layer salt change variants", () => {
  const doc = landFixture(blob);
  const catalog = buildModuleCatalog({layer: "ground"});
  const first = solveTerrainWfc({doc, catalog, salt: 1});
  const second = solveTerrainWfc({doc, catalog, salt: 1});
  assert.deepEqual(first, second, "same document and seed must reproduce the whole solve");
  const otherSeed = solveTerrainWfc({doc, catalog, seed: 977, salt: 1});
  assert.notDeepEqual(otherSeed.cells.map(cell => cell.variant), first.cells.map(cell => cell.variant), "seed change did not affect variant selection");
  const otherSalt = solveTerrainWfc({doc, catalog, salt: 2});
  assert.notDeepEqual(otherSalt.cells.map(cell => cell.variant), first.cells.map(cell => cell.variant), "salt change did not affect variant selection");
});

test("contradiction: topology without a matching module is structured and immediate", () => {
  const doc = landFixture(d => {
    d.land[3 * d.width + 3] = 1;
    d.land[4 * d.width + 4] = 1; // diagonal pair -> saddle dual cell
  });
  const catalog = buildModuleCatalog({layer: "ground", shapes: ["empty", "convex", "straight", "concave", "full"]});
  const result = solveTerrainWfc({doc, catalog});
  assert.equal(result.status, "contradiction");
  assert.equal(result.attempts, 0, "uncoverable topology must not burn retries");
  assert.ok(result.contradictions.length >= 1);
  const saddle = result.contradictions.find(entry => entry.mask === 0b0101 || entry.mask === 0b1010);
  assert.ok(saddle, "missing-saddle contradiction was not reported with its mask");
  assert.deepEqual([saddle.dx, saddle.dy, saddle.layer], [4, 4, "ground"]);
  assert.match(saddle.reason, /no module in the catalog matches topology mask/);
});

test("propagation: a collapsed flavor sweeps the whole grid through sockets", () => {
  const doc = createMapDocument({width: 10, height: 10}); // all water: every dual mask is 0
  const flavored = flavor => Object.freeze({
    id: `test:empty-${flavor}`, layer: "ground", shape: "empty", rotation: 0, mask: 0,
    reflectionOf: "empty",
    sockets: Object.freeze({n: flavor, e: flavor, s: flavor, w: flavor}),
    variants: Object.freeze([Object.freeze({id: "none", weight: 1})]),
  });
  const catalog = [flavored("aa"), flavored("bb")]; // self-compatible, mutually incompatible
  const result = solveTerrainWfc({doc, catalog});
  assert.equal(result.status, "solved");
  const ids = new Set(result.cells.map(cell => cell.moduleId));
  assert.equal(ids.size, 1, "propagation failed to sweep one flavor across the grid");
});

test("bounded failure: an unsatisfiable catalog fails within maxAttempts, structurally", () => {
  const doc = createMapDocument({width: 10, height: 10});
  const catalog = [Object.freeze({
    id: "test:empty-oriented", layer: "ground", shape: "empty", rotation: 0, mask: 0,
    reflectionOf: "empty",
    sockets: Object.freeze({n: "ab", e: "ab", s: "ab", w: "ab"}), // never matches its own reverse
    variants: Object.freeze([Object.freeze({id: "none", weight: 1})]),
  })];
  const result = solveTerrainWfc({doc, catalog, maxAttempts: 3});
  assert.equal(result.status, "contradiction");
  assert.equal(result.attempts, 3);
  assert.equal(result.contradictions.length, 3);
  for(const entry of result.contradictions){
    assert.equal(entry.layer, "ground");
    assert.equal(Number.isInteger(entry.dx) && Number.isInteger(entry.dy), true);
    assert.match(entry.reason, /emptied the domain/);
  }
  assert.throws(() => solveTerrainWfc({doc, catalog, maxAttempts: 0}), /maxAttempts/);
  assert.throws(() => solveTerrainWfc({doc, catalog: []}), /non-empty module array/);
});

test("exhaustive small masks: every 2x2 painted block solves with matching shapes", () => {
  const catalog = buildModuleCatalog({layer: "ground"});
  for(let pattern = 0; pattern < 16; pattern++){
    const doc = createMapDocument({width: 8, height: 8});
    if(pattern & 1) doc.land[3 * 8 + 3] = 1;
    if(pattern & 2) doc.land[3 * 8 + 4] = 1;
    if(pattern & 4) doc.land[4 * 8 + 4] = 1;
    if(pattern & 8) doc.land[4 * 8 + 3] = 1;
    const result = solveTerrainWfc({doc, catalog});
    assert.equal(result.status, "solved", `pattern ${pattern} failed to solve`);
    const center = result.cells.find(cell => cell.dx === 4 && cell.dy === 4);
    assert.equal(center.mask, pattern, "center dual cell must observe the painted 2x2 block");
    const module = catalog.find(entry => entry.id === center.moduleId);
    assert.equal(module.mask, pattern);
  }
});
