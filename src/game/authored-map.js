// Owns the game's authored-map loading: the DOM-free terrain raster query
// helpers and the conversion from an authored map document (map-document.js,
// authored in tools/map-editor.html) into the initial spatial blueprint the
// simulation materializes. This replaced the procedural world generator: the
// starter world is data (src/game/maps/starter.map.json), not an algorithm.
// Runtime entities, health, occupancy mutation, rendering, and movement policy
// belong to consumers.

import {W, H, BASE, CELL, GRID_ORIGIN_X, GRID_ORIGIN_Y, GRID_COLS, GRID_ROWS, BUILD_MARGIN, FOOTPRINT_1x1} from "./data.js";
import {footprintWorldRectInGrid} from "./grid.js";
import {parseMapDocument, inBounds} from "./map-document.js";
import {resolveScatterRegions} from "./scatter-regions.js";
import STARTER_MAP_DATA from "./maps/starter.map.json" with {type: "json"};

export const LAND = "land";
export const WATER = "water";
export const TERRAIN_ORDER = "row-major";
export const TERRAIN_TAGS = Object.freeze([LAND, WATER]);
export const TERRAIN_CELL_SIZE = 16;
export const TERRAIN_COLS = W / TERRAIN_CELL_SIZE, TERRAIN_ROWS = H / TERRAIN_CELL_SIZE;
export const TERRAIN_ORIGIN_X = 0, TERRAIN_ORIGIN_Y = 0;

// The canonical authored starter world, loadable and editable in the map editor.
export const STARTER_MAP_SOURCE = STARTER_MAP_DATA;

const validFootprint = footprint => footprint && Number.isInteger(footprint.w) && Number.isInteger(footprint.h) && footprint.w > 0 && footprint.h > 0 && footprint.w % 2 === 1 && footprint.h % 2 === 1;

// ── raster query helpers (contract unchanged from the retired generator) ────

export function validateTerrainTags(tags, expectedLength){
  if(!Array.isArray(tags) || !Number.isInteger(expectedLength) || expectedLength < 1 || tags.length !== expectedLength) throw new TypeError("terrain producer: malformed terrain field dimensions");
  if(!tags.every(tag => TERRAIN_TAGS.includes(tag))) throw new TypeError("terrain producer: unknown terrain tag");
  return true;
}

function assertTerrainBlueprint(blueprint){
  if(!blueprint || !Number.isFinite(blueprint.width) || !Number.isFinite(blueprint.height) || blueprint.width <= 0 || blueprint.height <= 0 ||
    !Number.isFinite(blueprint.terrainCellSize) || blueprint.terrainCellSize <= 0 || !Number.isFinite(blueprint.terrainOriginX) || !Number.isFinite(blueprint.terrainOriginY) ||
    !Number.isInteger(blueprint.terrainCols) || blueprint.terrainCols < 1 || !Number.isInteger(blueprint.terrainRows) || blueprint.terrainRows < 1 || blueprint.terrainOrder !== TERRAIN_ORDER ||
    blueprint.terrainOriginX !== 0 || blueprint.terrainOriginY !== 0 || blueprint.terrainCols * blueprint.terrainCellSize !== blueprint.width || blueprint.terrainRows * blueprint.terrainCellSize !== blueprint.height ||
    !Array.isArray(blueprint.terrain) || blueprint.terrain.length !== blueprint.terrainCols * blueprint.terrainRows)
    throw new TypeError("terrain query: malformed row-major terrain blueprint");
}

export function terrainAtRasterCell(blueprint, terrainX, terrainY){
  assertTerrainBlueprint(blueprint);
  if(!Number.isInteger(terrainX) || !Number.isInteger(terrainY) || terrainX < 0 || terrainY < 0 || terrainX >= blueprint.terrainCols || terrainY >= blueprint.terrainRows) return null;
  const tag = blueprint.terrain[terrainY * blueprint.terrainCols + terrainX];
  if(!TERRAIN_TAGS.includes(tag)) throw new TypeError("terrain query: unknown terrain tag");
  return tag;
}

export function terrainAtWorldPoint(blueprint, worldX, worldY){
  assertTerrainBlueprint(blueprint);
  if(!Number.isFinite(worldX) || !Number.isFinite(worldY)) throw new TypeError("terrain query: world coordinates must be finite");
  if(worldX < 0 || worldY < 0 || worldX >= blueprint.width || worldY >= blueprint.height) return null;
  const terrainX = Math.floor((worldX - blueprint.terrainOriginX) / blueprint.terrainCellSize), terrainY = Math.floor((worldY - blueprint.terrainOriginY) / blueprint.terrainCellSize);
  return terrainAtRasterCell(blueprint, terrainX, terrainY);
}

// Rectangles use half-open world bounds [x,x+w) × [y,y+h). Any positive overlap with water fails.
export function worldRectEntirelyOnLand(blueprint, rect){
  assertTerrainBlueprint(blueprint);
  if(!rect || typeof rect !== "object" || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) throw new TypeError("terrain query: world rectangle must have finite x/y and positive w/h");
  if(rect.x < 0 || rect.y < 0 || rect.x >= blueprint.width || rect.y >= blueprint.height || rect.w > blueprint.width - rect.x || rect.h > blueprint.height - rect.y) return false;
  const right = rect.x + rect.w, bottom = rect.y + rect.h;
  const minX = Math.floor((rect.x - blueprint.terrainOriginX) / blueprint.terrainCellSize), minY = Math.floor((rect.y - blueprint.terrainOriginY) / blueprint.terrainCellSize);
  // Math.max handles positive spans smaller than floating-point precision: they still occupy the
  // raster cell containing their start rather than collapsing to an empty query at a cell edge.
  const maxX = Math.max(minX, Math.ceil((right - blueprint.terrainOriginX) / blueprint.terrainCellSize) - 1), maxY = Math.max(minY, Math.ceil((bottom - blueprint.terrainOriginY) / blueprint.terrainCellSize) - 1);
  for(let terrainY = minY; terrainY <= maxY; terrainY++) for(let terrainX = minX; terrainX <= maxX; terrainX++) if(terrainAtRasterCell(blueprint, terrainX, terrainY) !== LAND) return false;
  return true;
}

export function placementFootprintOnLand(blueprint, placementCx, placementCy, footprint, placementGrid){
  if(!Number.isInteger(placementCx) || !Number.isInteger(placementCy) || !validFootprint(footprint)) throw new TypeError("terrain query: placement coordinates and footprint must use positive odd integers");
  if(!placementGrid || typeof placementGrid !== "object") throw new TypeError("terrain query: placement grid is required");
  return worldRectEntirelyOnLand(blueprint, footprintWorldRectInGrid(placementCx, placementCy, footprint, placementGrid));
}

// ── authored map → world blueprint ──────────────────────────────────────────

const OBJECT_KIND_BUCKETS = Object.freeze({tree: "trees", rock: "rocks", diamond: "diamonds", chest: "chests"});

// Shared game/editor policy adapter. The resolver owns land/occupancy/priority;
// this adapter supplies the production build margin and protected base footprint.
export function resolveAuthoredMapScatter(doc){
  const placementGrid = {
    width: (doc.width - 1) * doc.cellSize, height: (doc.height - 1) * doc.cellSize,
    cellSize: doc.cellSize, gridOriginX: -doc.cellSize / 2, gridOriginY: -doc.cellSize / 2,
    gridCols: doc.width, gridRows: doc.height,
  };
  const baseCx = Math.floor((BASE.x - placementGrid.gridOriginX) / doc.cellSize);
  const baseCy = Math.floor((BASE.y - placementGrid.gridOriginY) / doc.cellSize);
  const protectedCells = [];
  for(let cy = baseCy - 1; cy <= baseCy + 1; cy++) for(let cx = baseCx - 1; cx <= baseCx + 1; cx++)
    if(inBounds(doc, cx, cy)) protectedCells.push({cx, cy});
  return resolveScatterRegions({
    doc,
    protectedCells,
    isCellEligible(cx, cy){
      const rect = footprintWorldRectInGrid(cx, cy, FOOTPRINT_1x1, placementGrid);
      return rect.x >= BUILD_MARGIN && rect.y >= BUILD_MARGIN &&
        rect.x + rect.w <= placementGrid.width - BUILD_MARGIN && rect.y + rect.h <= placementGrid.height - BUILD_MARGIN;
    },
  });
}

// Convert authored map data (JSON text, plain object, or parsed document) into
// the frozen world blueprint the simulation materializes. The map must match
// the game's placement grid exactly: one authored cell per placement cell.
export function buildWorldFromMapData(mapData){
  const doc = parseMapDocument(mapData);
  if(doc.width !== GRID_COLS || doc.height !== GRID_ROWS || doc.cellSize !== CELL)
    throw new RangeError(`authored map: must be ${GRID_COLS}x${GRID_ROWS} cells at ${CELL}px to cover the game world (got ${doc.width}x${doc.height} at ${doc.cellSize}px)`);
  const placementGrid = {width: W, height: H, cellSize: CELL, gridOriginX: GRID_ORIGIN_X, gridOriginY: GRID_ORIGIN_Y, gridCols: GRID_COLS, gridRows: GRID_ROWS};

  // Fine terrain raster: each 16px raster cell belongs to the authored cell containing its center.
  const terrain = new Array(TERRAIN_COLS * TERRAIN_ROWS);
  for(let ty = 0; ty < TERRAIN_ROWS; ty++) for(let tx = 0; tx < TERRAIN_COLS; tx++){
    const cx = Math.floor(((tx + .5) * TERRAIN_CELL_SIZE - GRID_ORIGIN_X) / CELL);
    const cy = Math.floor(((ty + .5) * TERRAIN_CELL_SIZE - GRID_ORIGIN_Y) / CELL);
    terrain[ty * TERRAIN_COLS + tx] = doc.land[cy * doc.width + cx] === 1 ? LAND : WATER;
  }

  const buckets = {trees: [], rocks: [], diamonds: [], chests: []};
  for(const object of doc.objects){
    const bucket = OBJECT_KIND_BUCKETS[object.kind];
    if(!bucket) throw new TypeError(`authored map: object kind ${JSON.stringify(object.kind)} at (${object.cx}, ${object.cy}) cannot load into the game yet (supported: ${Object.keys(OBJECT_KIND_BUCKETS).join(", ")})`);
    buckets[bucket].push(Object.freeze({cx: object.cx, cy: object.cy, variant: object.variant ?? null}));
  }

  const resolved = resolveAuthoredMapScatter(doc);
  for(const cell of resolved.trees) buckets.trees.push(Object.freeze({cx: cell.cx, cy: cell.cy, variant: cell.variant}));
  for(const cell of resolved.rocks) buckets.rocks.push(Object.freeze({cx: cell.cx, cy: cell.cy, variant: cell.variant}));
  const grass = Object.freeze(resolved.grass.map(cell => Object.freeze({cx: cell.cx, cy: cell.cy, variant: cell.variant})));
  const blueprint = {
    width: W, height: H,
    terrainCellSize: TERRAIN_CELL_SIZE, terrainOriginX: TERRAIN_ORIGIN_X, terrainOriginY: TERRAIN_ORIGIN_Y,
    terrainCols: TERRAIN_COLS, terrainRows: TERRAIN_ROWS, terrainOrder: TERRAIN_ORDER,
    terrain: Object.freeze(terrain),
    placementCellSize: CELL, placementOriginX: GRID_ORIGIN_X, placementOriginY: GRID_ORIGIN_Y, placementCols: GRID_COLS, placementRows: GRID_ROWS,
    seed: doc.seed,
    // One-level raised layer at authored-cell resolution (raised implies land, enforced
    // by the document). Purely presentational in the game: gameplay stays 2D.
    raised: Object.freeze(Array.from(doc.raised, value => value === 1 ? 1 : 0)),
    trees: Object.freeze(buckets.trees), rocks: Object.freeze(buckets.rocks),
    diamonds: Object.freeze(buckets.diamonds), chests: Object.freeze(buckets.chests), grass,
    targets: Object.freeze({
      treeCount: buckets.trees.length, rockCount: buckets.rocks.length,
      diamondCount: buckets.diamonds.length, chestCount: buckets.chests.length, grassCount: grass.length,
    }),
  };

  // The base must stand on authored land before any consumer materializes the world.
  const baseCx = Math.floor((BASE.x - GRID_ORIGIN_X) / CELL), baseCy = Math.floor((BASE.y - GRID_ORIGIN_Y) / CELL);
  if(!placementFootprintOnLand(blueprint, baseCx, baseCy, BASE.footprint, placementGrid))
    throw new RangeError(`authored map: the base footprint at cell (${baseCx}, ${baseCy}) is not entirely on painted land`);
  for(const [bucket, cells] of Object.entries(buckets)) for(const cell of cells)
    if(!placementFootprintOnLand(blueprint, cell.cx, cell.cy, FOOTPRINT_1x1, placementGrid))
      throw new RangeError(`authored map: ${bucket} object at (${cell.cx}, ${cell.cy}) is not on placement-grid land`);

  return Object.freeze(blueprint);
}

// The world the game boots into.
export function buildStarterWorld(){
  return buildWorldFromMapData(STARTER_MAP_SOURCE);
}
