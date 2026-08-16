// Map editor — curated object palette over the project's model factories.
// Owns the mapping from stable map object IDs to src/render/models.js factories
// plus editor metadata. Factories are reused, never copied; groups a factory
// pre-positions (the main base) are normalized back to the origin so placement
// is always cell-driven. Browser-only (models.js imports "three").

import {
  makeTree, makeRock, makeDiamond, makeChest, makeMainBase, makeBuilding,
  disposeGroup, S,
} from "../../src/render/models.js";

export {disposeGroup, S};

// Every factory group is re-anchored at the origin: the map document owns the
// cell, the preview derives the transform. Pre-positioned factories (main base)
// otherwise carry their production world coordinates.
function normalized(group){
  group.position.set(0, 0, 0);
  return group;
}

// variants: selectable variant values persisted in the map document (null = none).
export const OBJECT_CATALOG = Object.freeze({
  "tree": Object.freeze({label: "tree", variants: Object.freeze([0, 1, 2]),
    build: variant => normalized(makeTree({variant: variant ?? 0}))}),
  "rock": Object.freeze({label: "rock", variants: null, build: () => normalized(makeRock())}),
  "diamond": Object.freeze({label: "diamond", variants: null, build: () => normalized(makeDiamond())}),
  "chest": Object.freeze({label: "chest", variants: null, build: () => normalized(makeChest())}),
  "base": Object.freeze({label: "main base", variants: null, build: () => normalized(makeMainBase(false))}),
  "house": Object.freeze({label: "house", variants: null, build: () => normalized(makeBuilding("house"))}),
  "lumber": Object.freeze({label: "lumber camp", variants: null, build: () => normalized(makeBuilding("lumber"))}),
  "quarry": Object.freeze({label: "quarry", variants: null, build: () => normalized(makeBuilding("quarry"))}),
  "stockpile": Object.freeze({label: "stockpile", variants: null, build: () => normalized(makeBuilding("stockpile"))}),
  "obelisk": Object.freeze({label: "obelisk", variants: null, build: () => normalized(makeBuilding("obelisk"))}),
  "tower": Object.freeze({label: "basic tower", variants: null, build: () => normalized(makeBuilding("tower"))}),
});

export const OBJECT_KINDS = Object.freeze(Object.keys(OBJECT_CATALOG));

export function buildObjectModel(kind, variant = null){
  const entry = OBJECT_CATALOG[kind];
  if(!entry) throw new Error(`object-catalog: unknown object kind ${JSON.stringify(kind)}`);
  if(entry.variants && variant !== null && !entry.variants.includes(variant))
    throw new Error(`object-catalog: ${kind} has no variant ${JSON.stringify(variant)}`);
  return entry.build(variant);
}
