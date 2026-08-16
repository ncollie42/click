// Map editor — dual-grid Wave Function Collapse solver.
// Owns dual-mask derivation, constraint propagation, deterministic collapse, and
// structured contradiction reporting. DOM-free by contract. The authored document
// is read-only input: the solver never alters water/ground/raised intent, it only
// selects compatible modules, rotations, and variants for the painted topology.

import {compatibleSockets, modulesForMask} from "./terrain-modules.js";

// Opposite sides for propagation: my side `n` faces the neighbor's side `s`.
const NEIGHBORS = Object.freeze([
  {side: "n", opposite: "s", dx: 0, dy: -1},
  {side: "e", opposite: "w", dx: 1, dy: 0},
  {side: "s", opposite: "n", dx: 0, dy: 1},
  {side: "w", opposite: "e", dx: -1, dy: 0},
]);

// Derive the dual grid: one solver cell per authored-grid vertex, observing the
// four surrounding authored cells. Cells outside the map read as unoccupied
// (water for the ground layer, not-raised for the raised layer).
export function deriveDualMasks(doc, layer = "ground"){
  const grid = layer === "raised" ? doc.raised : doc.land;
  if(layer !== "ground" && layer !== "raised") throw new Error(`terrain-wfc: unknown layer ${JSON.stringify(layer)}`);
  const cols = doc.width + 1, rows = doc.height + 1;
  const masks = new Uint8Array(cols * rows);
  const at = (cx, cy) => (cx >= 0 && cy >= 0 && cx < doc.width && cy < doc.height && grid[cy * doc.width + cx] === 1) ? 1 : 0;
  for(let dy = 0; dy < rows; dy++) for(let dx = 0; dx < cols; dx++){
    masks[dy * cols + dx] =
      (at(dx - 1, dy - 1) ? 1 : 0) |   // nw
      (at(dx, dy - 1) ? 2 : 0) |       // ne
      (at(dx, dy) ? 4 : 0) |           // se
      (at(dx - 1, dy) ? 8 : 0);        // sw
  }
  return {cols, rows, masks};
}

// Deterministic 32-bit mix of the seed and per-cell coordinates so selection is
// independent of collapse order and reproducible from the saved map seed.
function hash32(a, b, c, d){
  let h = (a ^ 0x9e3779b9) >>> 0;
  for(const value of [b, c, d]){
    h = (h ^ Math.imul(value >>> 0, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function pickWeighted(items, weightOf, roll){
  let total = 0;
  for(const item of items) total += weightOf(item);
  let remaining = roll * total;
  for(const item of items){
    remaining -= weightOf(item);
    if(remaining < 0) return item;
  }
  return items[items.length - 1];
}

function moduleWeight(module){
  return module.variants.reduce((sum, variant) => sum + variant.weight, 0);
}

// Remove neighbor-unsupported modules until stable. Returns the first emptied
// cell index or -1. `domains` is an array of module arrays.
function propagate(domains, cols, rows, queue){
  const queued = new Set(queue);
  while(queue.length > 0){
    const index = queue.shift();
    queued.delete(index);
    const dx = index % cols, dy = Math.floor(index / cols);
    for(const {side, opposite, dx: sx, dy: sy} of NEIGHBORS){
      const nx = dx + sx, ny = dy + sy;
      if(nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const neighborIndex = ny * cols + nx;
      const before = domains[neighborIndex].length;
      domains[neighborIndex] = domains[neighborIndex].filter(candidate =>
        domains[index].some(module => compatibleSockets(module.sockets[side], candidate.sockets[opposite])));
      if(domains[neighborIndex].length === 0) return neighborIndex;
      if(domains[neighborIndex].length < before && !queued.has(neighborIndex)){
        queue.push(neighborIndex);
        queued.add(neighborIndex);
      }
    }
  }
  return -1;
}

// Solve one elevation layer. Returns either
//   {status:"solved", layer, cols, rows, attempts, cells:[{dx,dy,mask,moduleId,shape,rotation,variant}]}
// or a structured, bounded failure
//   {status:"contradiction", layer, cols, rows, attempts, contradictions:[{dx,dy,mask,layer,reason}]}.
export function solveTerrainWfc({doc, catalog, layer = "ground", seed, salt = 0, maxAttempts = 8}){
  if(!Array.isArray(catalog) || catalog.length === 0) throw new Error("terrain-wfc: catalog must be a non-empty module array");
  if(!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("terrain-wfc: maxAttempts must be a positive integer");
  const resolvedSeed = (seed ?? doc.seed) >>> 0;
  const {cols, rows, masks} = deriveDualMasks(doc, layer);

  // Topology gaps cannot be fixed by retrying: report every uncoverable mask at once.
  const uncoverable = [];
  for(let index = 0; index < masks.length; index++){
    if(modulesForMask(catalog, masks[index]).length === 0){
      uncoverable.push({dx: index % cols, dy: Math.floor(index / cols), mask: masks[index], layer,
        reason: `no module in the catalog matches topology mask ${masks[index]}`});
    }
  }
  if(uncoverable.length > 0) return {status: "contradiction", layer, cols, rows, attempts: 0, contradictions: uncoverable};

  const contradictions = [];
  for(let attempt = 0; attempt < maxAttempts; attempt++){
    const domains = [];
    for(let index = 0; index < masks.length; index++) domains.push(modulesForMask(catalog, masks[index]));
    let failed = propagate(domains, cols, rows, Array.from({length: masks.length}, (_, index) => index));
    while(failed === -1){
      // Lowest entropy first; ties break on cell index so collapse order is stable.
      let target = -1, best = Infinity;
      for(let index = 0; index < domains.length; index++){
        const size = domains[index].length;
        if(size > 1 && size < best){ best = size; target = index; }
      }
      if(target === -1) break; // fully collapsed
      const dx = target % cols, dy = Math.floor(target / cols);
      const roll = hash32(resolvedSeed ^ (salt >>> 0), dx, dy, attempt) / 0x100000000;
      const chosen = pickWeighted(domains[target], moduleWeight, roll);
      domains[target] = [chosen];
      failed = propagate(domains, cols, rows, [target]);
    }
    if(failed !== -1){
      contradictions.push({dx: failed % cols, dy: Math.floor(failed / cols), mask: masks[failed], layer,
        reason: `constraint propagation emptied the domain on attempt ${attempt + 1}`});
      continue;
    }

    const cells = [];
    for(let index = 0; index < domains.length; index++){
      const module = domains[index][0];
      const dx = index % cols, dy = Math.floor(index / cols);
      const roll = hash32(resolvedSeed ^ (salt >>> 0) ^ 0x5eedca11, dx, dy, attempt) / 0x100000000;
      const variant = pickWeighted(module.variants, entry => entry.weight, roll);
      cells.push({dx, dy, mask: masks[index], moduleId: module.id, shape: module.shape, rotation: module.rotation, variant: variant.id});
    }
    // Emitted assembly must be pairwise compatible; a violation here is a solver bug.
    for(let index = 0; index < domains.length; index++){
      const dx = index % cols, dy = Math.floor(index / cols);
      for(const {side, opposite, dx: sx, dy: sy} of NEIGHBORS){
        const nx = dx + sx, ny = dy + sy;
        if(nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if(!compatibleSockets(domains[index][0].sockets[side], domains[ny * cols + nx][0].sockets[opposite]))
          throw new Error(`terrain-wfc: emitted incompatible socket pair at (${dx}, ${dy}) side ${side}`);
      }
    }
    return {status: "solved", layer, cols, rows, attempts: attempt + 1, cells};
  }
  return {status: "contradiction", layer, cols, rows, attempts: maxAttempts, contradictions};
}
