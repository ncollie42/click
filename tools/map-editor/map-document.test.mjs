// Map editor — Node tests for the authored map document model (node --test).

import assert from "node:assert/strict";
import {test} from "node:test";
import {
  MAP_FORMAT, MAP_VERSION, MAP_LIMITS, MAP_DEFAULTS,
  createMapDocument, cloneMapDocument, assertMapInvariants,
  serializeMapDocument, stringifyMapDocument, parseMapDocument,
  landAt, raisedAt, objectAt, cellIndex, inBounds,
} from "../../src/game/map-document.js";

function paintedFixture(){
  const doc = createMapDocument({width: 8, height: 8, cellSize: 32, seed: 7});
  for(let cy = 2; cy <= 5; cy++) for(let cx = 2; cx <= 5; cx++) doc.land[cy * 8 + cx] = 1;
  doc.raised[3 * 8 + 3] = 1;
  doc.raised[3 * 8 + 4] = 1;
  doc.objects.push({kind: "tree", cx: 2, cy: 2, rotation: 0.5, variant: 1});
  doc.objects.push({kind: "rock", cx: 5, cy: 5, rotation: 0, variant: null});
  doc.scatterRegions.push({id: "grove", kind: "tree", cx: 2, cy: 2, width: 4, height: 4, density: .25, seed: 9});
  return assertMapInvariants(doc);
}

test("defaults: new maps are the game grid (241x161 at 32px), all water, empty objects", () => {
  const doc = createMapDocument();
  assert.deepEqual(
    [doc.width, doc.height, doc.cellSize, doc.seed],
    [MAP_DEFAULTS.width, MAP_DEFAULTS.height, MAP_DEFAULTS.cellSize, MAP_DEFAULTS.seed]);
  assert.deepEqual([MAP_DEFAULTS.width, MAP_DEFAULTS.height, MAP_DEFAULTS.cellSize], [241, 161, 32]);
  assert.equal(doc.land.length, 241 * 161);
  assert.equal(doc.land.every(value => value === 0), true);
  assert.equal(doc.raised.every(value => value === 0), true);
  assert.deepEqual(doc.objects, []);
  assert.deepEqual(doc.scatterRegions, []);
  assertMapInvariants(doc);
});

test("dimension limits are enforced on creation and import", () => {
  assert.throws(() => createMapDocument({width: MAP_LIMITS.minWidth - 1}), /width must be in/);
  assert.throws(() => createMapDocument({height: MAP_LIMITS.maxHeight + 1}), /height must be in/);
  assert.throws(() => createMapDocument({cellSize: 0}), /cellSize must be in/);
  assert.throws(() => createMapDocument({width: 10.5}), /width must be an integer/);
  assert.throws(() => createMapDocument({seed: -1}), /seed must be a uint32/);
  assert.throws(() => createMapDocument({seed: 2 ** 32}), /seed must be a uint32/);
  createMapDocument({width: MAP_LIMITS.maxWidth, height: MAP_LIMITS.minHeight, cellSize: MAP_LIMITS.maxCellSize, seed: 0xffffffff});
});

test("cell accessors: bounds, index, land, raised, objectAt", () => {
  const doc = paintedFixture();
  assert.equal(inBounds(doc, 0, 0), true);
  assert.equal(inBounds(doc, -1, 0), false);
  assert.equal(inBounds(doc, 8, 7), false);
  assert.equal(cellIndex(doc, 3, 3), 27);
  assert.throws(() => cellIndex(doc, 8, 0), /out of bounds/);
  assert.equal(landAt(doc, 3, 3), true);
  assert.equal(landAt(doc, 0, 0), false);
  assert.equal(raisedAt(doc, 3, 3), true);
  assert.equal(raisedAt(doc, 2, 2), false);
  assert.equal(objectAt(doc, 2, 2).kind, "tree");
  assert.equal(objectAt(doc, 4, 4), null);
});

test("invariants: raised over water is rejected, never repaired", () => {
  const doc = paintedFixture();
  doc.raised[0] = 1; // (0,0) is water
  assert.throws(() => assertMapInvariants(doc), /raised implies land/);
  assert.equal(doc.raised[0], 1, "validation must not silently repair the document");
});

test("invariants: objects must be in bounds, on land, one per cell, well-typed", () => {
  const base = paintedFixture();
  const withObject = (entry) => {
    const doc = cloneMapDocument(base);
    doc.objects.push(entry);
    return () => assertMapInvariants(doc);
  };
  assert.throws(withObject({kind: "tree", cx: 9, cy: 0}), /out of bounds/);
  assert.throws(withObject({kind: "tree", cx: 0, cy: 0}), /not on land/);
  assert.throws(withObject({kind: "tree", cx: 2, cy: 2}), /shares cell/);
  assert.throws(withObject({kind: "", cx: 3, cy: 3}), /kind must be a non-empty string/);
  assert.throws(withObject({kind: "tree", cx: 3, cy: 3, rotation: Infinity}), /rotation must be a finite number/);
  assert.throws(withObject({kind: "tree", cx: 3, cy: 3, variant: {}}), /variant must be/);
});

test("regions: malformed entries and duplicate IDs are rejected", () => {
  const base = paintedFixture();
  const invalid = entry => { const doc = cloneMapDocument(base); doc.scatterRegions.push(entry); return () => assertMapInvariants(doc); };
  assert.throws(invalid({id: "", kind: "tree", cx: 0, cy: 0, width: 1, height: 1, density: 1, seed: 0}), /non-empty/);
  assert.throws(invalid({id: "bad-kind", kind: "diamond", cx: 0, cy: 0, width: 1, height: 1, density: 1, seed: 0}), /one of/);
  assert.throws(invalid({id: "outside", kind: "grass", cx: 7, cy: 7, width: 2, height: 1, density: .2, seed: 0}), /out of bounds/);
  assert.throws(invalid({id: "zero", kind: "rock", cx: 0, cy: 0, width: 0, height: 1, density: .2, seed: 0}), /width must be in/);
  assert.throws(invalid({id: "density", kind: "grass", cx: 0, cy: 0, width: 1, height: 1, density: NaN, seed: 0}), /density must be a finite/);
  assert.throws(invalid({id: "seed", kind: "tree", cx: 0, cy: 0, width: 1, height: 1, density: .5, seed: -1}), /seed must be a uint32/);
  assert.throws(invalid({...base.scatterRegions[0]}), /not unique/);
});

test("v1 imports as no regions and always serializes as v2", () => {
  const plain = serializeMapDocument(paintedFixture());
  plain.version = 1;
  delete plain.scatterRegions;
  const parsed = parseMapDocument(plain);
  assert.deepEqual(parsed.scatterRegions, []);
  assert.equal(serializeMapDocument(parsed).version, 2);
});

test("serialization: rows are readable strings and round trips are exact", () => {
  const doc = paintedFixture();
  const plain = serializeMapDocument(doc);
  assert.equal(plain.format, MAP_FORMAT);
  assert.equal(plain.version, MAP_VERSION);
  assert.equal(plain.land.length, 8);
  assert.equal(plain.land[0], "~~~~~~~~");
  assert.equal(plain.land[3], "~~####~~");
  assert.equal(plain.raised[3], "...^^...");
  const reparsed = parseMapDocument(stringifyMapDocument(doc));
  assert.deepEqual(serializeMapDocument(reparsed), plain, "stringify -> parse -> serialize must be identical");
  assert.deepEqual(reparsed.land, doc.land);
  assert.deepEqual(reparsed.raised, doc.raised);
  assert.deepEqual(reparsed.objects, doc.objects);
});

test("parse: malformed documents are rejected with clear messages", () => {
  const good = serializeMapDocument(paintedFixture());
  const broken = (mutate) => {
    const copy = JSON.parse(JSON.stringify(good));
    mutate(copy);
    return () => parseMapDocument(copy);
  };
  assert.throws(() => parseMapDocument("{nope"), /invalid JSON/);
  assert.throws(() => parseMapDocument(null), /must be a JSON object/);
  assert.throws(() => parseMapDocument([1, 2]), /must be a JSON object/);
  assert.throws(broken(copy => { copy.format = "other-map"; }), /unsupported format/);
  assert.throws(broken(copy => { copy.version = MAP_VERSION + 1; }), /unsupported version/);
  assert.throws(broken(copy => { copy.land = "not rows"; }), /land must be an array/);
  assert.throws(broken(copy => { copy.land.pop(); }), /land must have 8 rows/);
  assert.throws(broken(copy => { copy.land[2] = "~~##"; }), /must be 8 characters/);
  assert.throws(broken(copy => { copy.land[2] = "~~##XX~~"; }), /unknown character "X"/);
  assert.throws(broken(copy => { copy.raised[0] = "^......."; }), /raised implies land/);
  assert.throws(broken(copy => { copy.objects[0].cx = 99; }), /out of bounds/);
  assert.throws(broken(copy => { copy.objects[0].cy = 0; }), /not on land/);
  assert.throws(broken(copy => { copy.objects = {}; }), /objects must be an array/);
});

test("parse copies its input: later external mutation cannot reach the document", () => {
  const plain = serializeMapDocument(paintedFixture());
  const doc = parseMapDocument(plain);
  plain.objects[0].kind = "mutated";
  plain.objects[0].cx = 0;
  plain.scatterRegions[0].density = 1;
  plain.land[3] = "~~~~~~~~";
  assert.equal(doc.objects[0].kind, "tree");
  assert.equal(doc.scatterRegions[0].density, .25);
  assert.equal(landAt(doc, 3, 3), true);
  assertMapInvariants(doc);
});

test("clone is deep and independent", () => {
  const doc = paintedFixture();
  const copy = cloneMapDocument(doc);
  copy.land[0] = 1;
  copy.raised[2 * 8 + 2] = 1;
  copy.objects[0].kind = "changed";
  copy.scatterRegions[0].density = .75;
  copy.objects.push({kind: "rock", cx: 4, cy: 4, rotation: 0, variant: null});
  assert.equal(doc.land[0], 0);
  assert.equal(raisedAt(doc, 2, 2), false);
  assert.equal(doc.objects[0].kind, "tree");
  assert.equal(doc.scatterRegions[0].density, .25);
  assert.equal(doc.objects.length, 2);
  assertMapInvariants(doc);
});
