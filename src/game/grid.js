// Owns pure placement-lattice math over data.js. Occupancy and placement policy remain in simulation.js.
// Cell coordinates are integers; world coordinates are simulation pixels.

import {CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,W,H,FOOTPRINT_1x1,BUILDING_TYPES} from "./data.js";

// Parameterized forms let DOM-free generators use the same conversions without importing world policy.
export function worldToCellInGrid(x,y,{cellSize,gridOriginX,gridOriginY}){
  return {cx:Math.floor((x-gridOriginX)/cellSize),cy:Math.floor((y-gridOriginY)/cellSize)};
}
export function cellToWorldInGrid(cx,cy,{cellSize,gridOriginX,gridOriginY}){
  return {x:gridOriginX+cx*cellSize+cellSize/2,y:gridOriginY+cy*cellSize+cellSize/2};
}
const DEFAULT_GRID={cellSize:CELL,gridOriginX:GRID_ORIGIN_X,gridOriginY:GRID_ORIGIN_Y};
export const worldToCell=(x,y)=>worldToCellInGrid(x,y,DEFAULT_GRID);
export const cellToWorld=(cx,cy)=>cellToWorldInGrid(cx,cy,DEFAULT_GRID);
// Snap an arbitrary world point onto the center of the cell that contains it. A point exactly on a
// cell edge belongs to the higher-index cell (floor semantics), so snapping is total and stable.
export function snapToCellCenter(x,y){const c=worldToCell(x,y);return cellToWorld(c.cx,c.cy);}
// Footprints are odd, so half-extent is a whole number of cells on each side of the anchor.
const footprintHalf=size=>(size-1)/2;
// The one lookup from a building TYPE to its authored footprint. Unknown or null types (a menu entry
// that is not a building, a relocation with no type) fall back to a single cell, exactly as before.
export function buildingFootprint(type){return BUILDING_TYPES[type]?.footprint||FOOTPRINT_1x1;}
export function footprintCellBounds(cx,cy,footprint=FOOTPRINT_1x1){
  const hx=footprintHalf(footprint.w),hy=footprintHalf(footprint.h);
  return {minX:cx-hx,maxX:cx+hx,minY:cy-hy,maxY:cy+hy};
}
// Every cell an object covers, anchor-centered, row-major. 1x1 yields exactly the anchor cell.
export function footprintCells(cx,cy,footprint=FOOTPRINT_1x1){
  const b=footprintCellBounds(cx,cy,footprint),cells=[];
  for(let y=b.minY;y<=b.maxY;y++)for(let x=b.minX;x<=b.maxX;x++)cells.push({cx:x,cy:y});
  return cells;
}
// World-space rectangle covered by a footprint; the rendering/placement consumer of {w,h}.
export function footprintWorldRectInGrid(cx,cy,footprint,{cellSize,gridOriginX,gridOriginY}){
  const b=footprintCellBounds(cx,cy,footprint);
  return {x:gridOriginX+b.minX*cellSize,y:gridOriginY+b.minY*cellSize,w:footprint.w*cellSize,h:footprint.h*cellSize};
}
export function footprintInBounds(cx,cy,footprint,grid){
  const r=footprintWorldRectInGrid(cx,cy,footprint,grid);
  return r.x>=0&&r.y>=0&&r.x+r.w<=grid.width&&r.y+r.h<=grid.height;
}
export function footprintWorldRect(cx,cy,footprint=FOOTPRINT_1x1){
  return footprintWorldRectInGrid(cx,cy,footprint,DEFAULT_GRID);
}
// Boundary test on the COMPLETE footprint, not just the anchor: a 3x3 anchored one cell from the
// border overhangs the world even though its anchor is in-bounds. Half-clipped edge cells always fail.
export function footprintInWorldBounds(cx,cy,footprint=FOOTPRINT_1x1){
  return footprintInBounds(cx,cy,footprint,{...DEFAULT_GRID,width:W,height:H});
}
