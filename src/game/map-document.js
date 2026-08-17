// Authored map document model, shared by the game loader (authored-map.js) and
// the map editor (tools/map-editor/). Owns the versioned map data format:
// creation, validation, cloning, parsing, and serialization. DOM-free by
// contract. The document is the single source of truth; everything else derives.

export const MAP_FORMAT = "click-authored-map";
export const MAP_VERSION = 2;
export const SCATTER_KINDS = Object.freeze(["tree", "rock", "grass"]);

// Explicit safe limits for configurable dimensions.
export const MAP_LIMITS = Object.freeze({
  minWidth: 8, maxWidth: 256,
  minHeight: 8, maxHeight: 256,
  minCellSize: 4, maxCellSize: 128,
});

// Defaults match the game's placement grid (data.js GRID_COLS×GRID_ROWS at CELL
// px), so a default new map is directly loadable as a game world.
export const MAP_DEFAULTS = Object.freeze({
  width: 241, height: 161, cellSize: 32, seed: 1,
});

// Readable, diffable row encoding: one string per row.
export const LAND_CHAR = Object.freeze({water: "~", land: "#"});
export const RAISED_CHAR = Object.freeze({flat: ".", raised: "^"});

function fail(message){ throw new Error(`map-document: ${message}`); }

function checkedInt(value, name, min, max){
  if(!Number.isInteger(value)) fail(`${name} must be an integer, got ${JSON.stringify(value)}`);
  if(value < min || value > max) fail(`${name} must be in [${min}, ${max}], got ${value}`);
  return value;
}

export function checkedDimensions({width, height, cellSize}){
  checkedInt(width, "width", MAP_LIMITS.minWidth, MAP_LIMITS.maxWidth);
  checkedInt(height, "height", MAP_LIMITS.minHeight, MAP_LIMITS.maxHeight);
  checkedInt(cellSize, "cellSize", MAP_LIMITS.minCellSize, MAP_LIMITS.maxCellSize);
  return {width, height, cellSize};
}

export function createMapDocument(options = {}){
  if(options === null || typeof options !== "object") fail("options must be an object");
  const width = options.width ?? MAP_DEFAULTS.width;
  const height = options.height ?? MAP_DEFAULTS.height;
  const cellSize = options.cellSize ?? MAP_DEFAULTS.cellSize;
  const seed = options.seed ?? MAP_DEFAULTS.seed;
  checkedDimensions({width, height, cellSize});
  if(!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail(`seed must be a uint32 integer, got ${JSON.stringify(seed)}`);
  return {
    width, height, cellSize, seed,
    land: new Uint8Array(width * height),    // 0 = water, 1 = land
    raised: new Uint8Array(width * height),  // 0 = normal, 1 = +1 elevation (implies land)
    objects: [],                             // sparse: {kind, cx, cy, rotation, variant}
    scatterRegions: [],                      // sparse rectangles resolved by scatter-regions.js
  };
}

export function inBounds(doc, cx, cy){
  return Number.isInteger(cx) && Number.isInteger(cy) && cx >= 0 && cy >= 0 && cx < doc.width && cy < doc.height;
}
export function cellIndex(doc, cx, cy){
  if(!inBounds(doc, cx, cy)) fail(`cell (${cx}, ${cy}) out of bounds for ${doc.width}x${doc.height}`);
  return cy * doc.width + cx;
}
export function landAt(doc, cx, cy){ return doc.land[cellIndex(doc, cx, cy)] === 1; }
export function raisedAt(doc, cx, cy){ return doc.raised[cellIndex(doc, cx, cy)] === 1; }
export function objectAt(doc, cx, cy){
  cellIndex(doc, cx, cy);
  return doc.objects.find(object => object.cx === cx && object.cy === cy) ?? null;
}

function checkedScatterRegion(entry, index, doc){
  const at = `scatterRegions[${index}]`;
  if(entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(`${at} must be an object`);
  if(typeof entry.id !== "string" || entry.id.trim().length === 0) fail(`${at}.id must be a non-empty string`);
  if(!SCATTER_KINDS.includes(entry.kind)) fail(`${at}.kind must be one of ${SCATTER_KINDS.join("|")}`);
  checkedInt(entry.cx, `${at}.cx`, 0, doc.width - 1);
  checkedInt(entry.cy, `${at}.cy`, 0, doc.height - 1);
  checkedInt(entry.width, `${at}.width`, 1, doc.width);
  checkedInt(entry.height, `${at}.height`, 1, doc.height);
  if(entry.cx + entry.width > doc.width || entry.cy + entry.height > doc.height)
    fail(`${at} rectangle (${entry.cx}, ${entry.cy}, ${entry.width}, ${entry.height}) is out of bounds`);
  if(!Number.isFinite(entry.density) || entry.density < 0 || entry.density > 1) fail(`${at}.density must be a finite number in [0, 1]`);
  if(!Number.isInteger(entry.seed) || entry.seed < 0 || entry.seed > 0xffffffff) fail(`${at}.seed must be a uint32 integer`);
  return {id: entry.id, kind: entry.kind, cx: entry.cx, cy: entry.cy, width: entry.width, height: entry.height, density: entry.density, seed: entry.seed};
}

function checkedObject(entry, index, doc){
  if(entry === null || typeof entry !== "object") fail(`objects[${index}] must be an object`);
  if(typeof entry.kind !== "string" || entry.kind.length === 0) fail(`objects[${index}].kind must be a non-empty string`);
  if(!inBounds(doc, entry.cx, entry.cy)) fail(`objects[${index}] (${entry.kind}) cell (${entry.cx}, ${entry.cy}) is out of bounds`);
  if(doc.land[entry.cy * doc.width + entry.cx] !== 1) fail(`objects[${index}] (${entry.kind}) at (${entry.cx}, ${entry.cy}) is not on land`);
  const rotation = entry.rotation ?? 0;
  if(!Number.isFinite(rotation)) fail(`objects[${index}].rotation must be a finite number`);
  const variant = entry.variant ?? null;
  if(variant !== null && typeof variant !== "string" && !Number.isFinite(variant)) fail(`objects[${index}].variant must be null, a string, or a finite number`);
  return {kind: entry.kind, cx: entry.cx, cy: entry.cy, rotation, variant};
}

// Full invariant sweep. Throws on the first violation; returns the doc for chaining.
export function assertMapInvariants(doc){
  if(doc === null || typeof doc !== "object") fail("document must be an object");
  checkedDimensions(doc);
  if(!Number.isInteger(doc.seed) || doc.seed < 0 || doc.seed > 0xffffffff) fail("seed must be a uint32 integer");
  const cells = doc.width * doc.height;
  if(!(doc.land instanceof Uint8Array) || doc.land.length !== cells) fail(`land grid must be a Uint8Array of ${cells} cells`);
  if(!(doc.raised instanceof Uint8Array) || doc.raised.length !== cells) fail(`raised grid must be a Uint8Array of ${cells} cells`);
  for(let index = 0; index < cells; index++){
    if(doc.land[index] > 1) fail(`land[${index}] must be 0 or 1`);
    if(doc.raised[index] > 1) fail(`raised[${index}] must be 0 or 1`);
    if(doc.raised[index] === 1 && doc.land[index] !== 1) fail(`raised cell (${index % doc.width}, ${Math.floor(index / doc.width)}) is not land (raised implies land)`);
  }
  if(!Array.isArray(doc.objects)) fail("objects must be an array");
  const occupied = new Set();
  doc.objects.forEach((entry, index) => {
    checkedObject(entry, index, doc);
    const key = entry.cy * doc.width + entry.cx;
    if(occupied.has(key)) fail(`objects[${index}] (${entry.kind}) shares cell (${entry.cx}, ${entry.cy}) with another object`);
    occupied.add(key);
  });
  if(!Array.isArray(doc.scatterRegions)) fail("scatterRegions must be an array");
  const regionIds = new Set();
  doc.scatterRegions.forEach((entry, index) => {
    checkedScatterRegion(entry, index, doc);
    if(regionIds.has(entry.id)) fail(`scatterRegions[${index}].id ${JSON.stringify(entry.id)} is not unique`);
    regionIds.add(entry.id);
  });
  return doc;
}

// Centered crop to width×height cells (same cellSize/seed). Objects shift with the window and
// drop when outside it; scatter regions clip to the window and drop when nothing remains.
// Land/raised values copy unchanged, so every surviving object is still on land by construction.
export function cropMapDocumentCentered(doc, width, height){
  assertMapInvariants(doc);
  checkedDimensions({width, height, cellSize: doc.cellSize});
  if(width > doc.width || height > doc.height) fail(`crop ${width}x${height} exceeds document ${doc.width}x${doc.height}`);
  const offsetX = Math.floor((doc.width - width) / 2), offsetY = Math.floor((doc.height - height) / 2);
  const out = createMapDocument({width, height, cellSize: doc.cellSize, seed: doc.seed});
  for(let cy = 0; cy < height; cy++) for(let cx = 0; cx < width; cx++){
    const src = (cy + offsetY) * doc.width + (cx + offsetX), dst = cy * width + cx;
    out.land[dst] = doc.land[src];
    out.raised[dst] = doc.raised[src];
  }
  out.objects = doc.objects
    .filter(o => o.cx >= offsetX && o.cx < offsetX + width && o.cy >= offsetY && o.cy < offsetY + height)
    .map(o => ({kind: o.kind, cx: o.cx - offsetX, cy: o.cy - offsetY, rotation: o.rotation ?? 0, variant: o.variant ?? null}));
  out.scatterRegions = doc.scatterRegions.flatMap(region => {
    const x0 = Math.max(region.cx, offsetX), y0 = Math.max(region.cy, offsetY);
    const x1 = Math.min(region.cx + region.width, offsetX + width), y1 = Math.min(region.cy + region.height, offsetY + height);
    if(x1 <= x0 || y1 <= y0) return [];
    return [{...region, cx: x0 - offsetX, cy: y0 - offsetY, width: x1 - x0, height: y1 - y0}];
  });
  return assertMapInvariants(out);
}

export function cloneMapDocument(doc){
  assertMapInvariants(doc);
  return {
    width: doc.width, height: doc.height, cellSize: doc.cellSize, seed: doc.seed,
    land: new Uint8Array(doc.land),
    raised: new Uint8Array(doc.raised),
    objects: doc.objects.map(entry => ({kind: entry.kind, cx: entry.cx, cy: entry.cy, rotation: entry.rotation ?? 0, variant: entry.variant ?? null})),
    scatterRegions: doc.scatterRegions.map(entry => ({...entry})),
  };
}

function rowsFrom(grid, width, height, zero, one){
  const rows = [];
  for(let cy = 0; cy < height; cy++){
    let row = "";
    for(let cx = 0; cx < width; cx++) row += grid[cy * width + cx] === 1 ? one : zero;
    rows.push(row);
  }
  return rows;
}

// Plain-JSON snapshot of the document (the on-disk format).
export function serializeMapDocument(doc){
  assertMapInvariants(doc);
  return {
    format: MAP_FORMAT,
    version: MAP_VERSION,
    width: doc.width, height: doc.height, cellSize: doc.cellSize, seed: doc.seed,
    land: rowsFrom(doc.land, doc.width, doc.height, LAND_CHAR.water, LAND_CHAR.land),
    raised: rowsFrom(doc.raised, doc.width, doc.height, RAISED_CHAR.flat, RAISED_CHAR.raised),
    // Canonical cell order keeps serialization diffable and independent of edit history.
    objects: doc.objects
      .map(entry => ({kind: entry.kind, cx: entry.cx, cy: entry.cy, rotation: entry.rotation ?? 0, variant: entry.variant ?? null}))
      .sort((a, b) => (a.cy * doc.width + a.cx) - (b.cy * doc.width + b.cx)),
    // Stable identity order: array edit history and overlap order never affect disk output.
    scatterRegions: doc.scatterRegions.map(entry => ({...entry})).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}

export function stringifyMapDocument(doc){
  return JSON.stringify(serializeMapDocument(doc), null, 2) + "\n";
}

function parseRows(rows, name, width, height, zero, one){
  if(!Array.isArray(rows)) fail(`${name} must be an array of row strings`);
  if(rows.length !== height) fail(`${name} must have ${height} rows, got ${rows.length}`);
  const grid = new Uint8Array(width * height);
  rows.forEach((row, cy) => {
    if(typeof row !== "string") fail(`${name}[${cy}] must be a string`);
    if(row.length !== width) fail(`${name}[${cy}] must be ${width} characters, got ${row.length}`);
    for(let cx = 0; cx < width; cx++){
      const char = row[cx];
      if(char === one) grid[cy * width + cx] = 1;
      else if(char !== zero) fail(`${name}[${cy}][${cx}] has unknown character ${JSON.stringify(char)} (expected ${JSON.stringify(zero)} or ${JSON.stringify(one)})`);
    }
  });
  return grid;
}

// Parse JSON text or an already-parsed plain object into a fresh document.
// Always copies: the returned document never retains externally mutable references.
export function parseMapDocument(source){
  let raw = source;
  if(typeof raw === "string"){
    try{ raw = JSON.parse(raw); }
    catch(error){ fail(`invalid JSON: ${error.message}`); }
  }
  if(raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("map data must be a JSON object");
  if(raw.format !== MAP_FORMAT) fail(`unsupported format ${JSON.stringify(raw.format)} (expected ${JSON.stringify(MAP_FORMAT)})`);
  if(raw.version !== 1 && raw.version !== MAP_VERSION) fail(`unsupported version ${JSON.stringify(raw.version)} (this tool reads versions 1 and ${MAP_VERSION})`);
  const {width, height, cellSize} = checkedDimensions(raw);
  const doc = createMapDocument({width, height, cellSize, seed: raw.seed});
  doc.land = parseRows(raw.land, "land", width, height, LAND_CHAR.water, LAND_CHAR.land);
  doc.raised = parseRows(raw.raised, "raised", width, height, RAISED_CHAR.flat, RAISED_CHAR.raised);
  if(raw.objects !== undefined && !Array.isArray(raw.objects)) fail("objects must be an array");
  doc.objects = (raw.objects ?? []).map((entry, index) => checkedObject(entry, index, doc));
  if(raw.version === MAP_VERSION && !Array.isArray(raw.scatterRegions)) fail("scatterRegions must be an array");
  doc.scatterRegions = raw.version === 1 ? [] : raw.scatterRegions.map((entry, index) => checkedScatterRegion(entry, index, doc));
  return assertMapInvariants(doc);
}
