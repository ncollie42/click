// Scatter resolver — focused deterministic policy and isolation tests (node --test).

import assert from "node:assert/strict";
import {test} from "node:test";
import {createMapDocument, assertMapInvariants} from "../../src/game/map-document.js";
import {resolveScatterRegions} from "../../src/game/scatter-regions.js";

function fixture(){
  const doc = createMapDocument({width: 8, height: 8, cellSize: 32, seed: 7});
  doc.land.fill(1);
  return doc;
}
const region = (id, kind, overrides = {}) => ({id, kind, cx: 0, cy: 0, width: 8, height: 8, density: 1, seed: 1, ...overrides});
const cells = records => records.map(({cx, cy, variant, regionId}) => [cx, cy, variant, regionId]);

test("density extremes, stable variants, water, explicit, protection, and eligibility", () => {
  const doc = fixture();
  doc.land[3 * 8 + 3] = 0;
  doc.objects.push({kind: "chest", cx: 1, cy: 1, rotation: 0, variant: null});
  doc.scatterRegions.push(region("none", "tree", {density: 0}), region("all", "grass"));
  const result = resolveScatterRegions({doc: assertMapInvariants(doc), protectedCells: [{cx: 2, cy: 2}], isCellEligible: cx => cx !== 0});
  assert.equal(result.trees.length, 0);
  assert.equal(result.grass.length, 64 - 8 - 3, "density 1 must fill every eligible unoccupied cell");
  assert.equal(result.grass.some(cell => (cell.cx === 1 && cell.cy === 1) || (cell.cx === 2 && cell.cy === 2) || (cell.cx === 3 && cell.cy === 3)), false);
  assert.equal(result.grass.every(cell => cell.variant >= 0 && cell.variant <= 3), true);
  assert.deepEqual(resolveScatterRegions({doc, protectedCells: [{cx: 2, cy: 2}], isCellEligible: cx => cx !== 0}), result);
});

test("overlap priority is explicit, rock, tree, grass and independent of region order", () => {
  const make = order => {
    const doc = fixture();
    doc.objects.push({kind: "diamond", cx: 7, cy: 7, rotation: 0, variant: null});
    doc.scatterRegions = order.map(kind => region(kind, kind));
    return doc;
  };
  const forward = resolveScatterRegions({doc: make(["grass", "tree", "rock"])});
  const reverse = resolveScatterRegions({doc: make(["rock", "tree", "grass"])});
  assert.deepEqual(forward, reverse);
  assert.equal(forward.rocks.length, 63);
  assert.equal(forward.trees.length, 0);
  assert.equal(forward.grass.length, 0);
  assert.equal(forward.rocks.some(cell => cell.cx === 7 && cell.cy === 7), false);
});

test("same-kind overlap has stable identity ownership, not array-order ownership", () => {
  const doc = fixture();
  doc.scatterRegions = [region("z-last", "tree"), region("a-first", "tree")];
  const first = resolveScatterRegions({doc});
  doc.scatterRegions.reverse();
  const second = resolveScatterRegions({doc});
  assert.deepEqual(first, second);
  assert.equal(first.trees.every(cell => cell.regionId === "a-first"), true);
  assert.equal(first.trees.every(cell => cell.variant >= 0 && cell.variant <= 2), true);
});

test("region rerolls are local; disjoint additions and edits cannot reshuffle neighbors", () => {
  const doc = fixture();
  doc.scatterRegions = [
    region("left", "tree", {cx: 0, width: 4, density: .5, seed: 10}),
    region("right", "grass", {cx: 4, width: 4, density: .5, seed: 20}),
  ];
  const before = resolveScatterRegions({doc});
  doc.scatterRegions[1].seed++;
  const rerolled = resolveScatterRegions({doc});
  assert.deepEqual(cells(before.trees), cells(rerolled.trees));
  assert.notDeepEqual(cells(before.grass), cells(rerolled.grass));
  doc.scatterRegions.push(region("small-rocks", "rock", {cx: 6, cy: 6, width: 2, height: 2, density: .5, seed: 30}));
  const added = resolveScatterRegions({doc});
  assert.deepEqual(cells(rerolled.trees), cells(added.trees));
});

test("map seed affects every region deterministically", () => {
  const doc = fixture();
  doc.scatterRegions = [region("trees", "tree", {density: .5}), region("grass", "grass", {density: .5})];
  const first = resolveScatterRegions({doc});
  doc.seed++;
  const second = resolveScatterRegions({doc});
  assert.notDeepEqual(cells(first.trees), cells(second.trees));
  assert.notDeepEqual(cells(first.grass), cells(second.grass));
  doc.seed--;
  assert.deepEqual(resolveScatterRegions({doc}), first);
});
