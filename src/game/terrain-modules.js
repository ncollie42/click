// Map editor — terrain module grammar for the dual-grid WFC.
// Owns the canonical module shapes, rotation/reflection metadata, edge sockets,
// and weighted variants. DOM-free by contract. Painted terrain stays authoritative:
// modules only describe how a fixed four-corner topology mask can look.

// Dual-cell corners in clockwise order. Mask bit i set = corner i is occupied
// (land for the ground pass, raised for the raised pass).
export const CORNERS = Object.freeze(["nw", "ne", "se", "sw"]);
export const SIDES = Object.freeze(["n", "e", "s", "w"]);

// Corner pair observed along each side, clockwise as seen from inside the module.
const SIDE_CORNERS = Object.freeze({n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0]});

export function maskFromCorners({nw, ne, se, sw}){
  return (nw ? 1 : 0) | (ne ? 2 : 0) | (se ? 4 : 0) | (sw ? 8 : 0);
}

// Rotating module content 90° clockwise moves the NW corner to NE: rotate bits left.
export function rotateMaskCW(mask){
  return ((mask << 1) | (mask >> 3)) & 0b1111;
}

// Mirror across the vertical axis: NW<->NE, SW<->SE.
export function reflectMask(mask){
  const nw = mask & 1, ne = (mask >> 1) & 1, se = (mask >> 2) & 1, sw = (mask >> 3) & 1;
  return maskFromCorners({nw: ne, ne: nw, se: sw, sw: se});
}

// Canonical shapes. Every 4-bit topology mask reduces to exactly one shape under
// rotation; reflection metadata records that no shape needs a distinct mirror form.
export const SHAPES = Object.freeze([
  Object.freeze({id: "empty", baseMask: 0b0000, rotations: 1, reflectionOf: "empty"}),
  Object.freeze({id: "convex", baseMask: 0b0001, rotations: 4, reflectionOf: "convex"}),   // one corner occupied
  Object.freeze({id: "straight", baseMask: 0b0011, rotations: 4, reflectionOf: "straight"}), // one full edge occupied
  Object.freeze({id: "saddle", baseMask: 0b0101, rotations: 2, reflectionOf: "saddle"}),   // two opposite corners
  Object.freeze({id: "concave", baseMask: 0b0111, rotations: 4, reflectionOf: "concave"}), // three corners occupied
  Object.freeze({id: "full", baseMask: 0b1111, rotations: 1, reflectionOf: "full"}),
]);

// Socket ID for one side: the two observed corner tags in clockwise order.
// "w" = unoccupied (water / not raised), "l" = occupied.
export function socketForSide(mask, side){
  const [a, b] = SIDE_CORNERS[side];
  return `${mask & (1 << a) ? "l" : "w"}${mask & (1 << b) ? "l" : "w"}`;
}

// Orientation-aware matching: my side reads clockwise, the neighbor's facing side
// reads clockwise from its own frame, so the shared corners appear reversed.
export function compatibleSockets(a, b){
  if(typeof a !== "string" || typeof b !== "string") throw new Error("terrain-modules: sockets must be strings");
  return a === [...b].reverse().join("");
}

// Default weighted variants per shape and layer. Variants only change appearance.
const GROUND_TOP_VARIANTS = [
  {id: "meadow", weight: 6},
  {id: "mottled", weight: 3},
  {id: "scrub", weight: 1},
];
const GROUND_EDGE_VARIANTS = [
  {id: "sand", weight: 5},
  {id: "pebble", weight: 2},
];
const RAISED_TOP_VARIANTS = [
  {id: "plateau", weight: 6},
  {id: "rocky", weight: 2},
];
const RAISED_EDGE_VARIANTS = [
  {id: "cliff", weight: 5},
  {id: "striated", weight: 2},
];

function variantsFor(shapeId, layer){
  if(shapeId === "empty") return [{id: "none", weight: 1}];
  if(shapeId === "full") return layer === "raised" ? RAISED_TOP_VARIANTS : GROUND_TOP_VARIANTS;
  return layer === "raised" ? RAISED_EDGE_VARIANTS : GROUND_EDGE_VARIANTS;
}

// Build the frozen module catalog: one module per shape+rotation, with explicit
// per-side sockets and weighted variants. `layer` is "ground" or "raised" so the
// two WFC passes share the grammar while carrying height-specific variant IDs.
export function buildModuleCatalog(options = {}){
  const layer = options.layer ?? "ground";
  if(layer !== "ground" && layer !== "raised") throw new Error(`terrain-modules: unknown layer ${JSON.stringify(layer)}`);
  const includeShapes = options.shapes ?? SHAPES.map(shape => shape.id);
  const modules = [];
  for(const shape of SHAPES){
    if(!includeShapes.includes(shape.id)) continue;
    let mask = shape.baseMask;
    for(let rotation = 0; rotation < shape.rotations; rotation++){
      const sockets = {};
      for(const side of SIDES) sockets[side] = socketForSide(mask, side);
      modules.push(Object.freeze({
        id: `${layer}:${shape.id}:r${rotation}`,
        layer, shape: shape.id, rotation, mask,
        reflectionOf: shape.reflectionOf,
        sockets: Object.freeze(sockets),
        variants: Object.freeze((options.variants?.[shape.id] ?? variantsFor(shape.id, layer)).map(variant => Object.freeze({...variant}))),
      }));
      mask = rotateMaskCW(mask);
    }
  }
  return Object.freeze(modules);
}

export function modulesForMask(catalog, mask){
  return catalog.filter(module => module.mask === mask);
}

// Canonical module footprints in tile-local (x, z) coordinates, base orientation
// (mask bit order nw, ne, se, sw). Tops are land polygons; walls are boundary
// segments ordered with land on the left so extruded faces point at the water.
// Shared by every renderer (game scene and editor preview) so module geometry
// can never disagree between them.
export const SHAPE_GEOMETRY = Object.freeze({
  empty: {tops: [], walls: []},
  full: {tops: [[[0, 0], [1, 0], [1, 1], [0, 1]]], walls: []},
  convex: {tops: [[[0, 0], [.5, 0], [0, .5]]], walls: [[[.5, 0], [0, .5]]]},
  straight: {tops: [[[0, 0], [1, 0], [1, .5], [0, .5]]], walls: [[[1, .5], [0, .5]]]},
  saddle: {tops: [[[0, 0], [.5, 0], [0, .5]], [[1, 1], [.5, 1], [1, .5]]],
           walls: [[[.5, 0], [0, .5]], [[.5, 1], [1, .5]]]},
  concave: {tops: [[[0, 0], [1, 0], [1, 1], [.5, 1], [0, .5]]], walls: [[[.5, 1], [0, .5]]]},
});

// Rotate a tile-local point 90° clockwise per step (screen sense: x right, z down): nw -> ne.
export function rotateShapePoint([x, z], rotation){
  for(let step = 0; step < rotation; step++){ const px = x; x = 1 - z; z = px; }
  return [x, z];
}
