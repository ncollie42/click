// Owns deterministic scatter-region resolution. DOM-free and pure: callers own
// map validation plus policy inputs; this module owns candidate hashing, overlap
// priority, occupancy, stable variants, and per-region diagnostics.

import {assertMapInvariants} from "./map-document.js";

export const SCATTER_PRIORITY = Object.freeze({rock: 0, tree: 1, grass: 2});
const compareIdentity = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function mix32(value){
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function hashString(value, hash){
  for(let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}

// Every candidate is addressed directly. No PRNG stream or traversal state means
// unrelated regions/cells cannot perturb an unchanged region.
export function scatterCellHash(mapSeed, region, cx, cy, salt = 0){
  let hash = (0x811c9dc5 ^ mapSeed ^ salt) >>> 0;
  hash = hashString(region.id, hash);
  hash = mix32(hash ^ region.seed);
  hash = hashString(region.kind, hash);
  hash = mix32(hash ^ Math.imul(cx + 1, 0x9e3779b1));
  return mix32(hash ^ Math.imul(cy + 1, 0x85ebca6b));
}

function protectedSet(doc, protectedCells){
  const output = new Set();
  for(const cell of protectedCells ?? []){
    if(Number.isInteger(cell)) output.add(cell);
    else if(cell && Number.isInteger(cell.cx) && Number.isInteger(cell.cy)) output.add(cell.cy * doc.width + cell.cx);
    else throw new TypeError("scatter-regions: protected cells must be cell indices or {cx, cy}");
  }
  return output;
}

/**
 * Resolves validated regions into conflict-free records.
 * isCellEligible supplies caller policy (for example build margin); land,
 * explicit occupancy, protected cells, density, and region priority stay here.
 */
export function resolveScatterRegions({doc, protectedCells = [], isCellEligible = () => true} = {}){
  assertMapInvariants(doc);
  if(typeof isCellEligible !== "function") throw new TypeError("scatter-regions: isCellEligible must be a function");

  const unavailable = protectedSet(doc, protectedCells);
  for(const object of doc.objects) unavailable.add(object.cy * doc.width + object.cx);
  const occupied = new Set(unavailable);
  const byKind = {tree: [], rock: [], grass: []};
  const statsById = Object.fromEntries(doc.scatterRegions.map(region => [region.id, {eligible: 0, candidate: 0, placed: 0}]));
  const regions = [...doc.scatterRegions].sort((a, b) =>
    SCATTER_PRIORITY[a.kind] - SCATTER_PRIORITY[b.kind] || compareIdentity(a.id, b.id));

  for(const region of regions){
    const stats = statsById[region.id];
    for(let cy = region.cy; cy < region.cy + region.height; cy++) for(let cx = region.cx; cx < region.cx + region.width; cx++){
      const address = cy * doc.width + cx;
      if(doc.land[address] !== 1 || unavailable.has(address) || !isCellEligible(cx, cy)) continue;
      stats.eligible++;
      const hash = scatterCellHash(doc.seed, region, cx, cy);
      if(region.density !== 1 && (region.density === 0 || hash / 0x100000000 >= region.density)) continue;
      stats.candidate++;
      // Earlier priority (or stable ID within one kind) owns overlap.
      if(occupied.has(address)) continue;
      const variantHash = scatterCellHash(doc.seed, region, cx, cy, 0xa511e9b3);
      const variant = region.kind === "tree" ? variantHash % 3 : region.kind === "grass" ? variantHash % 4 : null;
      byKind[region.kind].push({kind: region.kind, cx, cy, variant, regionId: region.id});
      occupied.add(address);
      stats.placed++;
    }
  }

  const cellOrder = (a, b) => a.cy - b.cy || a.cx - b.cx || compareIdentity(a.regionId, b.regionId);
  for(const records of Object.values(byKind)) records.sort(cellOrder);
  return {
    trees: byKind.tree,
    rocks: byKind.rock,
    grass: byKind.grass,
    statsById,
    totals: {tree: byKind.tree.length, rock: byKind.rock.length, grass: byKind.grass.length},
  };
}
