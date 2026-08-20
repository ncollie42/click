// Map editor — browser editor shell for tools/map-editor.html.
// Sole owner of map-document and history mutation: every change flows through
// commitCommand/applyCommand here. The 2D paint canvas is the authoring surface;
// the Three.js preview (preview.js) is derived and rebuilt only after a completed
// stroke, undo/redo, load, new map, or seed change. Hover, selection, camera, and
// history are transient and never serialized.

import {
  createMapDocument, parseMapDocument, stringifyMapDocument, serializeMapDocument,
  assertMapInvariants, inBounds, MAP_DEFAULTS,
} from "../../src/game/map-document.js";
import {createTerrainPreview} from "./preview.js";
import {resolveAuthoredMapScatter} from "../../src/game/authored-map.js";
import {OBJECT_CATALOG} from "./object-catalog.js";

const PAINT_CELL_PX = 14;
const HISTORY_LIMIT = 200;

const query = id => document.getElementById(id);
const paintCanvas = query("paint");
const paintContext = paintCanvas.getContext("2d");
const statusNode = query("uStatus"), errorNode = query("uError"), solveNode = query("uSolveStatus");

let doc = createMapDocument();
const history = {undo: [], redo: []};
let hover = null;            // {cx, cy} | null — transient, never serialized
let stroke = null;           // active drag stroke accumulating one undo command
let sampleArmed = false;     // one-shot sample mode from the toolbar button
let rectAnchor = null;       // terrain/scatter rectangle drag origin
let rectPointerOrigin = null, rectDragged = false;
let selectedRegionId = null; // transient; stable ID survives canonical region ordering
let lastScatter = null;
const SCATTER_DEFAULT_DENSITY = Object.freeze({tree: .12, rock: .06, grass: .14});
const brush = {mode: "ground", objectKind: "tree", objectVariant: 0, scatterKind: "tree", scatterDensity: .12, size: 1, tool: "rect"};
const AUTHORING_PANELS = Object.freeze({terrain: Object.freeze(["water", "ground", "raised"]), objects: Object.freeze(["object", "erase"]), scatter: Object.freeze(["scatter"])});

function panelForMode(mode){
  return Object.entries(AUTHORING_PANELS).find(([, modes]) => modes.includes(mode))?.[0] ?? "terrain";
}

function activateAuthoringPanel(panel){
  const modes = AUTHORING_PANELS[panel];
  if(!modes) throw new Error(`unknown authoring panel ${JSON.stringify(panel)}`);
  if(!modes.includes(brush.mode)) brush.mode = panel === "terrain" ? "ground" : panel === "objects" ? "object" : "scatter";
  syncBrushControls();
  syncRegionControls();
  drawPaint();
  updateStatus();
  return panel;
}

// Disc stamp offsets per brush size (size 1 = single cell, 2 = 5-cell cross, …).
function stampOffsets(size){
  const radius = size - 1, offsets = [];
  for(let dy = -radius; dy <= radius; dy++) for(let dx = -radius; dx <= radius; dx++)
    if(dx * dx + dy * dy <= radius * radius + .5) offsets.push([dx, dy]);
  return offsets;
}

const preview = createTerrainPreview({canvas: query("preview")});
let lastSolves = null;

// ── document + history mutation (single owner) ─────────────────────────────

function applyCommand(command, direction){
  const forward = direction === "redo";
  for(const change of command.cells ?? []){
    doc.land[change.index] = forward ? change.afterLand : change.beforeLand;
    doc.raised[change.index] = forward ? change.afterRaised : change.beforeRaised;
  }
  const removed = forward ? (command.removedObjects ?? []) : (command.addedObjects ?? []);
  const added = forward ? (command.addedObjects ?? []) : (command.removedObjects ?? []);
  for(const object of removed){
    const at = doc.objects.findIndex(entry => entry.cx === object.cx && entry.cy === object.cy);
    if(at >= 0) doc.objects.splice(at, 1);
  }
  for(const object of added) doc.objects.push({...object});
  if(command.regions) doc.scatterRegions = (forward ? command.regions.after : command.regions.before).map(region => ({...region}));
  assertMapInvariants(doc);
}

function commitCommand(command){
  if((command.cells?.length ?? 0) === 0 && (command.removedObjects?.length ?? 0) === 0 && (command.addedObjects?.length ?? 0) === 0 && !command.regions) return;
  history.undo.push(command);
  if(history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  afterDocumentChange();
}

function undo(){
  const command = history.undo.pop();
  if(!command) return;
  applyCommand(command, "undo");
  history.redo.push(command);
  afterDocumentChange();
}
function redo(){
  const command = history.redo.pop();
  if(!command) return;
  applyCommand(command, "redo");
  history.undo.push(command);
  afterDocumentChange();
}

function replaceDocument(next){
  doc = next;
  history.undo.length = history.redo.length = 0;
  hover = null;
  stroke = null;
  rectAnchor = null;
  rectPointerOrigin = null;
  rectDragged = false;
  selectedRegionId = null;
  query("uWidth").value = doc.width;
  query("uHeight").value = doc.height;
  query("uCellSize").value = doc.cellSize;
  resizePaintCanvas();
  afterDocumentChange();
}

function afterDocumentChange(){
  lastScatter = resolveAuthoredMapScatter(doc);
  lastSolves = preview.rebuild(doc);
  if(selectedRegionId && !doc.scatterRegions.some(region => region.id === selectedRegionId)) selectedRegionId = null;
  syncRegionControls();
  drawPaint();
  updateStatus();
}

function commitRegionMutation(label, mutate){
  const before = doc.scatterRegions.map(region => ({...region}));
  try{
    mutate();
    assertMapInvariants(doc);
  }catch(error){
    doc.scatterRegions = before;
    throw error;
  }
  const after = doc.scatterRegions.map(region => ({...region}));
  if(JSON.stringify(before) === JSON.stringify(after)) return;
  commitCommand({label, regions: {before, after}});
}

function selectedRegion(){ return doc.scatterRegions.find(region => region.id === selectedRegionId) ?? null; }

function nextRegionId(kind){
  let suffix = 1;
  const ids = new Set(doc.scatterRegions.map(region => region.id));
  while(ids.has(`${kind}-${suffix}`)) suffix++;
  return `${kind}-${suffix}`;
}

function createScatterRegion(from, to){
  const cx = Math.min(from.cx, to.cx), cy = Math.min(from.cy, to.cy);
  const width = Math.max(from.cx, to.cx) - cx + 1, height = Math.max(from.cy, to.cy) - cy + 1;
  const id = nextRegionId(brush.scatterKind);
  commitRegionMutation(`scatter:create:${id}`, () => doc.scatterRegions.push({
    id, kind: brush.scatterKind, cx, cy, width, height,
    density: brush.scatterDensity, seed: 1,
  }));
  selectedRegionId = id;
  syncRegionControls();
  drawPaint();
}

// Repeated clicks cycle stable-ID order, making fully overlapping regions reachable.
function selectRegionAt(cx, cy){
  const matches = doc.scatterRegions.filter(region => cx >= region.cx && cy >= region.cy && cx < region.cx + region.width && cy < region.cy + region.height)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if(matches.length === 0){ selectedRegionId = null; syncRegionControls(); drawPaint(); return false; }
  const current = matches.findIndex(region => region.id === selectedRegionId);
  selectedRegionId = matches[(current + 1) % matches.length].id;
  syncRegionControls(); drawPaint(); updateStatus();
  return true;
}

// ── stroke painting ─────────────────────────────────────────────────────────

function beginStroke(label){
  stroke = {label, cells: new Map(), removedObjects: [], addedObjects: []};
}

function strokeSetCell(cx, cy, land, raised){
  const index = cy * doc.width + cx;
  if(!stroke.cells.has(index)) stroke.cells.set(index, {index, beforeLand: doc.land[index], beforeRaised: doc.raised[index], afterLand: land, afterRaised: raised});
  else Object.assign(stroke.cells.get(index), {afterLand: land, afterRaised: raised});
  doc.land[index] = land;
  doc.raised[index] = raised;
}

function strokeRemoveObject(cx, cy){
  const at = doc.objects.findIndex(entry => entry.cx === cx && entry.cy === cy);
  if(at < 0) return;
  const [object] = doc.objects.splice(at, 1);
  const addedAt = stroke.addedObjects.findIndex(entry => entry.cx === cx && entry.cy === cy);
  if(addedAt >= 0) stroke.addedObjects.splice(addedAt, 1); // placed earlier in this same stroke
  else stroke.removedObjects.push(object);
}

function strokeAddObject(object){
  stroke.addedObjects.push({...object});
  doc.objects.push({...object});
}

function paintCell(cx, cy){
  if(!inBounds(doc, cx, cy)) return;
  const index = cy * doc.width + cx;
  if(brush.mode === "water"){
    strokeSetCell(cx, cy, 0, 0);           // water clears raised state…
    strokeRemoveObject(cx, cy);            // …and drowns any object in the cell
  }else if(brush.mode === "ground"){
    strokeSetCell(cx, cy, 1, 0);
  }else if(brush.mode === "raised"){
    strokeSetCell(cx, cy, 1, 1);           // raised implies land
  }else if(brush.mode === "erase"){
    strokeRemoveObject(cx, cy);
  }else if(brush.mode === "object"){
    if(doc.land[index] !== 1) return;      // objects require land
    const existing = doc.objects.find(entry => entry.cx === cx && entry.cy === cy);
    if(existing && existing.kind === brush.objectKind && (existing.variant ?? null) === (brush.objectVariant ?? null)) return;
    strokeRemoveObject(cx, cy);
    strokeAddObject({kind: brush.objectKind, cx, cy, rotation: 0, variant: brush.objectVariant ?? null});
  }
}

// One brush application: a disc of the current size (objects always place singly —
// a wide object stamp would fight the one-object-per-cell rule).
function paintStamp(cx, cy){
  if(brush.mode === "object" || brush.size <= 1){ paintCell(cx, cy); return; }
  for(const [dx, dy] of stampOffsets(brush.size)) paintCell(cx + dx, cy + dy);
}

// Gap-free drag painting: walk every cell between consecutive pointer samples.
function paintLine(from, to){
  let {cx: x0, cy: y0} = from;
  const {cx: x1, cy: y1} = to;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for(;;){
    paintStamp(x0, y0);
    if(x0 === x1 && y0 === y1) break;
    const doubled = 2 * err;
    if(doubled > -dy){ err -= dy; x0 += sx; }
    if(doubled < dx){ err += dx; y0 += sy; }
  }
}

// Rect tool: fill the anchored rectangle with the current brush as one command.
function paintRect(from, to){
  beginStroke(`rect:${brush.mode}`);
  for(let cy = Math.min(from.cy, to.cy); cy <= Math.max(from.cy, to.cy); cy++)
    for(let cx = Math.min(from.cx, to.cx); cx <= Math.max(from.cx, to.cx); cx++)
      paintCell(cx, cy);
  endStroke();
}

function endStroke(){
  if(!stroke) return;
  const command = {label: stroke.label, cells: [...stroke.cells.values()].filter(change =>
    change.beforeLand !== change.afterLand || change.beforeRaised !== change.afterRaised),
    removedObjects: stroke.removedObjects, addedObjects: stroke.addedObjects};
  stroke = null;
  assertMapInvariants(doc);
  commitCommand(command);
}

// ── sampling ─────────────────────────────────────────────────────────────────

function sampleCell(cx, cy){
  if(!inBounds(doc, cx, cy)) return;
  const object = doc.objects.find(entry => entry.cx === cx && entry.cy === cy);
  if(object){
    brush.mode = "object";
    brush.objectKind = object.kind;
    brush.objectVariant = object.variant ?? null;
  }else{
    const index = cy * doc.width + cx;
    brush.mode = doc.raised[index] === 1 ? "raised" : doc.land[index] === 1 ? "ground" : "water";
  }
  syncBrushControls();
  updateStatus();
}

// ── 2D paint canvas ──────────────────────────────────────────────────────────

function resizePaintCanvas(){
  paintCanvas.width = doc.width * PAINT_CELL_PX;
  paintCanvas.height = doc.height * PAINT_CELL_PX;
}

const CELL_COLORS = {water: "#3f6ea8", ground: "#7fa35c", raised: "#a8c37e"};

function drawPaint(){
  const px = PAINT_CELL_PX;
  for(let cy = 0; cy < doc.height; cy++) for(let cx = 0; cx < doc.width; cx++){
    const index = cy * doc.width + cx;
    paintContext.fillStyle = doc.raised[index] === 1 ? CELL_COLORS.raised : doc.land[index] === 1 ? CELL_COLORS.ground : CELL_COLORS.water;
    paintContext.fillRect(cx * px, cy * px, px, px);
    if(doc.raised[index] === 1){
      paintContext.strokeStyle = "#6d8a4a";
      paintContext.strokeRect(cx * px + 1.5, cy * px + 1.5, px - 3, px - 3);
    }
  }
  paintContext.strokeStyle = "rgba(0,0,0,0.18)";
  paintContext.lineWidth = 1;
  for(let cx = 0; cx <= doc.width; cx++){ paintContext.beginPath(); paintContext.moveTo(cx * px + .5, 0); paintContext.lineTo(cx * px + .5, doc.height * px); paintContext.stroke(); }
  for(let cy = 0; cy <= doc.height; cy++){ paintContext.beginPath(); paintContext.moveTo(0, cy * px + .5); paintContext.lineTo(doc.width * px, cy * px + .5); paintContext.stroke(); }
  const regionColors = {tree: ["rgba(42,108,52,.22)", "#285f32"], rock: ["rgba(105,102,98,.24)", "#67635d"], grass: ["rgba(177,198,89,.18)", "#a7bd53"]};
  for(const region of [...doc.scatterRegions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)){
    const [fill, border] = regionColors[region.kind];
    paintContext.fillStyle = fill;
    paintContext.fillRect(region.cx * px, region.cy * px, region.width * px, region.height * px);
    paintContext.strokeStyle = region.id === selectedRegionId ? "#ffffff" : border;
    paintContext.lineWidth = region.id === selectedRegionId ? 3 : 2;
    paintContext.strokeRect(region.cx * px + 1, region.cy * px + 1, region.width * px - 2, region.height * px - 2);
    paintContext.fillStyle = region.id === selectedRegionId ? "#ffffff" : border;
    paintContext.font = `bold ${Math.max(9, px - 4)}px system-ui`;
    paintContext.textAlign = "left";
    paintContext.textBaseline = "top";
    paintContext.fillText(`${region.kind} ${Math.round(region.density * 100)}%`, region.cx * px + 3, region.cy * px + 2);
  }
  paintContext.font = `${px - 4}px system-ui`;
  paintContext.textAlign = "center";
  paintContext.textBaseline = "middle";
  for(const object of doc.objects){
    paintContext.fillStyle = "#2c2418";
    paintContext.beginPath();
    paintContext.arc((object.cx + .5) * px, (object.cy + .5) * px, px * .38, 0, Math.PI * 2);
    paintContext.fill();
    paintContext.fillStyle = "#f3efe2";
    paintContext.fillText(object.kind[0].toUpperCase(), (object.cx + .5) * px, (object.cy + .55) * px);
  }
  {
    // The game always spawns the main base at the map's center cell (3×3 footprint);
    // mark that reserved footprint so authors keep it on land.
    const baseCx = Math.floor(doc.width / 2), baseCy = Math.floor(doc.height / 2);
    paintContext.fillStyle = "rgba(255,214,90,0.25)";
    paintContext.fillRect((baseCx - 1) * px, (baseCy - 1) * px, 3 * px, 3 * px);
    paintContext.strokeStyle = "#ffd65a";
    paintContext.lineWidth = 2;
    paintContext.strokeRect((baseCx - 1) * px + 1, (baseCy - 1) * px + 1, 3 * px - 2, 3 * px - 2);
    paintContext.fillStyle = "#ffd65a";
    paintContext.font = `bold ${px - 2}px system-ui`;
    paintContext.fillText("B", (baseCx + .5) * px, (baseCy + .55) * px);
  }
  if(rectAnchor && hover){
    const x0 = Math.min(rectAnchor.cx, hover.cx), x1 = Math.max(rectAnchor.cx, hover.cx);
    const y0 = Math.min(rectAnchor.cy, hover.cy), y1 = Math.max(rectAnchor.cy, hover.cy);
    paintContext.fillStyle = "rgba(255,255,255,0.22)";
    paintContext.fillRect(x0 * px, y0 * px, (x1 - x0 + 1) * px, (y1 - y0 + 1) * px);
    paintContext.strokeStyle = "#ffffff";
    paintContext.lineWidth = 2;
    paintContext.strokeRect(x0 * px + 1, y0 * px + 1, (x1 - x0 + 1) * px - 2, (y1 - y0 + 1) * px - 2);
  }else if(hover && inBounds(doc, hover.cx, hover.cy)){
    paintContext.strokeStyle = "#ffffff";
    paintContext.lineWidth = 2;
    const reach = brush.tool === "paint" && brush.mode !== "object" ? brush.size - 1 : 0;
    paintContext.strokeRect((hover.cx - reach) * px + 1, (hover.cy - reach) * px + 1, (2 * reach + 1) * px - 2, (2 * reach + 1) * px - 2);
  }
}

// Exact picking under CSS scaling: map client coordinates through the live rect.
function cellFromPointer(event){
  const rect = paintCanvas.getBoundingClientRect();
  return {
    cx: Math.max(0, Math.min(doc.width - 1, Math.floor((event.clientX - rect.left) / rect.width * doc.width))),
    cy: Math.max(0, Math.min(doc.height - 1, Math.floor((event.clientY - rect.top) / rect.height * doc.height))),
  };
}

let lastPaintedCell = null;
paintCanvas.addEventListener("contextmenu", event => event.preventDefault());
paintCanvas.addEventListener("pointerdown", event => {
  if(event.button !== 0) return;
  const cell = cellFromPointer(event);
  if(event.altKey || sampleArmed){
    sampleArmed = false;
    sampleCell(cell.cx, cell.cy);
    return;
  }
  paintCanvas.setPointerCapture(event.pointerId);
  hover = cell;
  if(brush.tool === "rect" || brush.mode === "scatter"){
    rectAnchor = cell;
    rectPointerOrigin = {x: event.clientX, y: event.clientY};
    rectDragged = false;
    drawPaint();
    return;
  }
  beginStroke(brush.mode);
  paintStamp(cell.cx, cell.cy);
  lastPaintedCell = cell;
  drawPaint();
});
paintCanvas.addEventListener("pointermove", event => {
  const cell = cellFromPointer(event);
  const moved = !hover || hover.cx !== cell.cx || hover.cy !== cell.cy;
  hover = cell;
  if(rectPointerOrigin && Math.hypot(event.clientX - rectPointerOrigin.x, event.clientY - rectPointerOrigin.y) >= 3) rectDragged = true;
  if(stroke && lastPaintedCell){
    paintLine(lastPaintedCell, cell);
    lastPaintedCell = cell;
    drawPaint();
  }else if(moved) drawPaint(); // hover/rect preview only needs a redraw when the cell changes
});
const finishPointer = () => {
  lastPaintedCell = null;
  if(rectAnchor && hover){
    const anchor = rectAnchor;
    rectAnchor = null;
    if(brush.mode === "scatter"){
      if(rectDragged) createScatterRegion(anchor, hover);
      else selectRegionAt(hover.cx, hover.cy);
    }else paintRect(anchor, hover);
  }else rectAnchor = null;
  rectPointerOrigin = null;
  rectDragged = false;
  endStroke();
};
paintCanvas.addEventListener("pointerup", event => { if(event.button === 0) finishPointer(); });
paintCanvas.addEventListener("pointercancel", finishPointer);
paintCanvas.addEventListener("pointerleave", () => { hover = null; if(!stroke && !rectAnchor) drawPaint(); });

// ── preview camera input ─────────────────────────────────────────────────────

const previewCanvas = query("preview");
let previewDrag = null;
previewCanvas.addEventListener("contextmenu", event => event.preventDefault());
previewCanvas.addEventListener("pointerdown", event => {
  previewCanvas.setPointerCapture(event.pointerId);
  previewDrag = {x: event.clientX, y: event.clientY, pan: event.button !== 0 || event.shiftKey};
});
previewCanvas.addEventListener("pointermove", event => {
  if(!previewDrag) return;
  const dx = event.clientX - previewDrag.x, dy = event.clientY - previewDrag.y;
  previewDrag.x = event.clientX;
  previewDrag.y = event.clientY;
  if(previewDrag.pan) preview.pan(-dx, -dy);
  else preview.orbit(-dx * .4, dy * .3);
});
for(const type of ["pointerup", "pointercancel"]) previewCanvas.addEventListener(type, () => { previewDrag = null; });
previewCanvas.addEventListener("wheel", event => {
  event.preventDefault();
  preview.zoom(Math.exp(event.deltaY * .001));
}, {passive: false});

// ── toolbar ──────────────────────────────────────────────────────────────────

function showError(error){
  errorNode.textContent = error ? String(error.message ?? error) : "";
  if(error) console.warn(error);
}

function updateStatus(){
  const land = doc.land.reduce((sum, value) => sum + value, 0);
  const raised = doc.raised.reduce((sum, value) => sum + value, 0);
  const totals = lastScatter?.totals ?? {tree: 0, rock: 0, grass: 0};
  statusNode.textContent = `${doc.width}×${doc.height} @ ${doc.cellSize}px · seed ${doc.seed} · land ${land} · raised ${raised} · objects ${doc.objects.length} · regions ${doc.scatterRegions.length} · generated T${totals.tree}/R${totals.rock}/G${totals.grass} · undo ${history.undo.length} / redo ${history.redo.length} · ${brush.tool === "rect" ? "rect" : `size ${brush.size}`} ${brush.mode}${brush.mode === "object" ? `:${brush.objectKind}${brush.objectVariant !== null ? "·" + brush.objectVariant : ""}` : ""}`;
  const describe = (layer, solve) => solve.status === "solved"
    ? `${layer} solved (${solve.attempts} attempt${solve.attempts === 1 ? "" : "s"})`
    : `${layer} CONTRADICTION ×${solve.contradictions.length}`;
  solveNode.textContent = lastSolves ? `seed ${doc.seed} · ${describe("ground", lastSolves.ground)} · ${describe("raised", lastSolves.raised)}` : "";
  query("uUndo").disabled = history.undo.length === 0;
  query("uRedo").disabled = history.redo.length === 0;
}

function syncRegionControls(){
  const region = selectedRegion();
  document.body.dataset.regionSelected = String(Boolean(region));
  const kind = region?.kind ?? brush.scatterKind;
  const density = region?.density ?? brush.scatterDensity;
  query("uScatterKind").value = kind;
  query("uScatterDensity").value = String(density);
  query("uScatterDensityValue").value = `${Math.round(density * 1000) / 10}%`; 
  const idInput = query("uRegionId");
  idInput.value = region?.id ?? "";
  idInput.disabled = !region;
  for(const [id, value] of [["uRegionX", region?.cx], ["uRegionY", region?.cy], ["uRegionWidth", region?.width], ["uRegionHeight", region?.height], ["uRegionSeed", region?.seed]]){
    query(id).value = value ?? "";
    query(id).disabled = !region;
  }
  query("uRegionReroll").disabled = query("uRegionDelete").disabled = !region;
  query("uScatterSettingsTitle").textContent = region ? `selected · ${region.id}` : "new region";
  query("uScatterHint").textContent = region ? "Kind and density edit this region. Renaming changes stable identity and rerolls it." : "Drag on the map to create. Click a region to inspect; repeated clicks cycle overlaps.";
  const stats = region && lastScatter?.statsById[region.id];
  query("uRegionStats").textContent = region ? `${region.id} · eligible ${stats?.eligible ?? 0} / candidate ${stats?.candidate ?? 0} / placed ${stats?.placed ?? 0}` : "none selected";

  const list = query("uRegionList");
  list.replaceChildren();
  const ordered = [...doc.scatterRegions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  query("uRegionListTitle").textContent = `regions · ${ordered.length}`;
  if(ordered.length === 0){
    const option = new Option("No regions yet", "");
    option.disabled = true;
    list.add(option);
  }else for(const entry of ordered){
    const placed = lastScatter?.statsById[entry.id]?.placed ?? 0;
    list.add(new Option(`${entry.kind} · ${entry.id} · ${Math.round(entry.density * 1000) / 10}% · ${placed} placed`, entry.id));
  }
  list.value = region?.id ?? "";
}

function editSelectedRegion(patch, label = "scatter:edit"){
  const region = selectedRegion();
  if(!region) return;
  const previousId = region.id;
  try{
    showError(null);
    commitRegionMutation(`${label}:${previousId}`, () => {
      Object.assign(region, patch);
      if(patch.id !== undefined) selectedRegionId = patch.id;
    });
  }catch(error){
    selectedRegionId = previousId;
    showError(error);
    syncRegionControls();
  }
}

function rerollSelectedRegion(){
  const region = selectedRegion();
  if(!region) return;
  editSelectedRegion({seed: (region.seed + 0x9e3779b9) >>> 0}, "scatter:reroll");
}

function deleteSelectedRegion(){
  const region = selectedRegion();
  if(!region) return;
  commitRegionMutation(`scatter:delete:${region.id}`, () => doc.scatterRegions.splice(doc.scatterRegions.indexOf(region), 1));
}

function syncBrushControls(){
  document.body.dataset.brushMode = brush.mode;
  document.body.dataset.authoringPanel = panelForMode(brush.mode);
  for(const mode of ["water", "ground", "raised", "erase", "object", "scatter"]) 
    query(`uBrush${mode[0].toUpperCase()}${mode.slice(1)}`).checked = brush.mode === mode;
  const kindSelect = query("uObjectKind");
  kindSelect.disabled = brush.mode !== "object";
  kindSelect.value = `${brush.objectKind}:${brush.objectVariant ?? ""}`;
  query("uBrushSize").value = String(brush.size);
  query("uToolPaint").checked = brush.tool === "paint";
  query("uToolRect").checked = brush.tool === "rect";
}

{ // object palette: one entry per kind+variant
  const kindSelect = query("uObjectKind");
  for(const [kind, entry] of Object.entries(OBJECT_CATALOG)){
    for(const variant of entry.variants ?? [null])
      kindSelect.add(new Option(entry.variants ? `${entry.label} ${variant}` : entry.label, `${kind}:${variant ?? ""}`));
  }
  kindSelect.onchange = () => {
    const [kind, variant] = kindSelect.value.split(":");
    brush.objectKind = kind;
    brush.objectVariant = variant === "" ? null : Number(variant);
    updateStatus();
  };
}
for(const mode of ["water", "ground", "raised", "erase", "object", "scatter"]){
  query(`uBrush${mode[0].toUpperCase()}${mode.slice(1)}`).onchange = () => {
    brush.mode = mode;
    syncBrushControls();
    updateStatus();
  };
}
query("uBrushSize").onchange = () => {
  brush.size = Math.max(1, Math.min(4, Number(query("uBrushSize").value) || 1));
  updateStatus();
};
query("uScatterKind").onchange = () => {
  const kind = query("uScatterKind").value;
  brush.scatterKind = kind;
  if(selectedRegion()) editSelectedRegion({kind});
  else{
    brush.scatterDensity = SCATTER_DEFAULT_DENSITY[kind];
    syncRegionControls();
  }
};
query("uScatterDensity").oninput = () => { query("uScatterDensityValue").value = `${Math.round(Number(query("uScatterDensity").value) * 1000) / 10}%`; };
query("uScatterDensity").onchange = () => {
  const density = Number(query("uScatterDensity").value);
  brush.scatterDensity = density;
  if(selectedRegion()) editSelectedRegion({density});
  else syncRegionControls();
};
for(const [id, key] of [["uRegionX", "cx"], ["uRegionY", "cy"], ["uRegionWidth", "width"], ["uRegionHeight", "height"], ["uRegionSeed", "seed"]])
  query(id).onchange = () => editSelectedRegion({[key]: Number(query(id).value)});
query("uRegionId").onchange = () => editSelectedRegion({id: query("uRegionId").value.trim()}, "scatter:rename");
query("uRegionList").onchange = () => {
  selectedRegionId = query("uRegionList").value || null;
  syncRegionControls();
  drawPaint();
  updateStatus();
};
query("uRegionReroll").onclick = rerollSelectedRegion;
query("uRegionDelete").onclick = deleteSelectedRegion;
for(const tool of ["paint", "rect"]){
  query(`uTool${tool[0].toUpperCase()}${tool.slice(1)}`).onchange = () => {
    brush.tool = tool;
    syncBrushControls();
    updateStatus();
  };
}
query("uSample").onclick = () => { sampleArmed = true; };
query("uTabTerrain").onclick = () => activateAuthoringPanel("terrain");
query("uTabObjects").onclick = () => activateAuthoringPanel("objects");
query("uTabScatter").onclick = () => activateAuthoringPanel("scatter");
query("uUndo").onclick = undo;
query("uRedo").onclick = redo;
query("uResetCamera").onclick = () => preview.resetCamera();
query("uGameView").onclick = () => preview.gameView();
// ── water tab ────────────────────────────────────────────────────────────────
// One fieldset owns the audition: the mode select picks the treatment and stamps data-water-mode so
// the CSS shows only the sliders that mode reads (mode 5 "voyage" adds tint/distortion/wave
// speed/whitecaps/reflection on top of the shared height/foam/fade). Every knob pushes the whole slider set through setParams, so
// the DOM stays the single source of truth; the reflection toggle rides along as 0/1 because
// setParams validates numbers only (see water-modes.js).
const WATER_SLIDERS = {
  uWaterAmp: "amp", uWaterFoam: "foam", uWaterFade: "fade",
  uWaterTint: "tint", uWaterDistort: "distort", uWaterDistortSpeed: "distortSpeed",
  uWaterWaveSpeed: "waveSpeed", uWaterCaps: "caps", uWaterReflect: "reflect",
};
function applyWaterMode(next){
  query("waterControls").dataset.waterMode = String(next);
  preview.setWaterMode(next);
}
function waterParamsFromUI(){
  const partial = {reflectOn: query("uWaterReflectOn").checked ? 1 : 0};
  for(const [sliderId, param] of Object.entries(WATER_SLIDERS)) partial[param] = Number(query(sliderId).value);
  return partial;
}
const pushWaterParams = () => preview.setWaterParams(waterParamsFromUI());
query("uWaterMode").onchange = event => applyWaterMode(Number(event.target.value));
for(const sliderId of Object.keys(WATER_SLIDERS)) query(sliderId).oninput = pushWaterParams;
query("uWaterReflectOn").onchange = pushWaterParams;   // off = the mirrored camera pass is skipped entirely
query("uWaterShoreDepth").onchange = event => preview.setShoreDepth(Number(event.target.value));  // rebuilds terrain: on release, not per-tick
// Controls are the source of truth on boot so UI and preview state always agree.
pushWaterParams();
preview.setShoreDepth(Number(query("uWaterShoreDepth").value));
applyWaterMode(Number(query("uWaterMode").value));

query("uNew").onclick = () => {
  try{
    showError(null);
    replaceDocument(createMapDocument({
      width: Number(query("uWidth").value),
      height: Number(query("uHeight").value),
      cellSize: Number(query("uCellSize").value),
      seed: 1,
    }));
  }catch(error){ showError(error); }
};

query("uSave").onclick = () => {
  const blob = new Blob([stringifyMapDocument(doc)], {type: "application/json"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `map-${doc.width}x${doc.height}-seed${doc.seed}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
};

query("uSaveLive").onclick = async () => {
  const button = query("uSaveLive");
  try{
    showError(null);
    const response = await fetch("../src/game/maps/starter.map.json", {
      method: "PUT",
      headers: {"content-type": "application/json"},
      body: stringifyMapDocument(doc),
    });
    if(!response.ok){
      // python3 -m http.server answers PUT with 501; point at the writable server.
      const detail = response.status === 501 || response.status === 405
        ? "live save needs the node dev server — restart serving with: node tools/serve.mjs"
        : await response.text() || `save failed (${response.status})`;
      throw new Error(detail);
    }
    button.textContent = "saved ✓";
    setTimeout(() => { button.textContent = "save to game"; }, 1600);
  }catch(error){ showError(error); }
};

query("uLoad").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if(!file) return;
  try{
    showError(null);
    replaceDocument(parseMapDocument(await file.text()));
  }catch(error){ showError(error); }
};

window.addEventListener("keydown", event => {
  if(!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if(key === "z" && !event.shiftKey){ event.preventDefault(); undo(); }
  else if(key === "y" || (key === "z" && event.shiftKey)){ event.preventDefault(); redo(); }
});

// ── view tabs ────────────────────────────────────────────────────────────────
// map / 3D / split: one pane can take the whole width. Both panes stay in the DOM (only display
// toggles) so paint state, history and the 3D scene all survive switching; the render loop below
// skips the 3D draw while its pane is hidden. Choice persists across reloads.
const panesBox = document.getElementById("panes"), VIEW_KEY = "mapEditor.view";
const VIEW_BUTTONS = {paint: query("uViewPaint"), preview: query("uViewPreview"), split: query("uViewSplit")};
function setView(name){
  if(!VIEW_BUTTONS[name]) name = "split";
  panesBox.classList.toggle("view-paint", name === "paint");
  panesBox.classList.toggle("view-preview", name === "preview");
  for(const [key, button] of Object.entries(VIEW_BUTTONS)) button.classList.toggle("on", key === name);
  localStorage.setItem(VIEW_KEY, name);
}
for(const [key, button] of Object.entries(VIEW_BUTTONS)) button.onclick = () => setView(key);
setView(localStorage.getItem(VIEW_KEY) || "split");

// ── render loop ──────────────────────────────────────────────────────────────

(function frame(){
  // offsetParent is null while the preview pane is display:none — skip the 3D draw entirely
  // (including the water pre-pass and any active render pipeline) while the map tab is up.
  if(query("preview").offsetParent !== null) preview.renderOnce();
  requestAnimationFrame(frame);
})();

// ── deterministic test surface ───────────────────────────────────────────────

window.__mapEditor = {
  exportJSON: () => stringifyMapDocument(doc),
  importJSON: text => replaceDocument(parseMapDocument(text)),
  newMap: options => replaceDocument(createMapDocument(options)),
  getDocument: () => serializeMapDocument(doc),
  setBrush: next => { Object.assign(brush, next); syncBrushControls(); syncRegionControls(); updateStatus(); },
  getBrush: () => ({...brush}),
  sample: (cx, cy) => sampleCell(cx, cy),
  paintCells: (cells, mode) => {          // programmatic stroke, one undo command
    const previousMode = brush.mode;
    if(mode) brush.mode = mode;
    beginStroke(brush.mode);
    for(const [cx, cy] of cells) paintCell(cx, cy);
    endStroke();
    brush.mode = previousMode;
  },
  paintRect: (x0, y0, x1, y1, mode) => {  // programmatic rect fill, one undo command
    const previousMode = brush.mode;
    if(mode) brush.mode = mode;
    paintRect({cx: x0, cy: y0}, {cx: x1, cy: y1});
    brush.mode = previousMode;
  },
  stampOffsets,
  undo, redo,
  historyDepth: () => ({undo: history.undo.length, redo: history.redo.length}),
  hover: () => (hover ? {...hover} : null),
  paintCellPx: PAINT_CELL_PX,
  lastSolves: () => lastSolves,
  previewDebug: () => preview.debugState(),
  scatterResult: () => JSON.parse(JSON.stringify(lastScatter)),
  createRegion: entry => {
    const region = {...entry};
    commitRegionMutation(`scatter:create:${region.id}`, () => doc.scatterRegions.push(region));
    selectedRegionId = region.id; syncRegionControls(); drawPaint();
  },
  selectRegion: id => { selectedRegionId = doc.scatterRegions.some(region => region.id === id) ? id : null; syncRegionControls(); drawPaint(); return selectedRegionId; },
  editRegion: (id, patch) => { selectedRegionId = id; editSelectedRegion({...patch}); },
  rerollRegion: id => { selectedRegionId = id; rerollSelectedRegion(); },
  deleteRegion: id => { selectedRegionId = id; deleteSelectedRegion(); },
  selectedRegion: () => selectedRegionId,
  setAuthoringPanel: activateAuthoringPanel,
  getAuthoringPanel: () => panelForMode(brush.mode),
  setPreviewView: next => preview.setView(next),
  resetCamera: () => preview.resetCamera(),
  gameView: () => preview.gameView(),
  setWaterMode: next => { query("uWaterMode").value = String(next); applyWaterMode(next); },
  setWaterParams: partial => preview.setWaterParams(partial),
  setShoreDepth: next => { query("uWaterShoreDepth").value = String(next); preview.setShoreDepth(next); },
  // Reduced module sets make real WFC contradictions reachable in tests.
  setShapeFilter: filter => { preview.setShapeFilter(filter ?? {}); afterDocumentChange(); },
};

replaceDocument(doc);
syncBrushControls();
syncRegionControls();
// Boot with the game's authored starter map when served from the repo root; the
// blank document remains the fallback (file://, fetch failure). The ready flag
// flips only after the attempt so nothing observes a half-loaded default.
(async () => {
  try{
    const response = await fetch("../src/game/maps/starter.map.json", {cache: "no-store"});
    if(response.ok) replaceDocument(parseMapDocument(await response.text()));
  }catch{ /* keep the blank document */ }
  window.__mapEditorReady = true;
})();
