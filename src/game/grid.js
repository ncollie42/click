// Owns pure placement-lattice math over data.js. Occupancy and placement policy remain in simulation.js.
// Cell coordinates are integers; world coordinates are simulation pixels.

import {CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,W,H,FOOTPRINT_1x1,BUILDING_TYPES} from "./data.js";

const worldToCellX=x=>Math.floor((x-GRID_ORIGIN_X)/CELL);
const worldToCellY=y=>Math.floor((y-GRID_ORIGIN_Y)/CELL);
export const worldToCell=(x,y)=>({cx:worldToCellX(x),cy:worldToCellY(y)});
const cellToWorldX=cx=>GRID_ORIGIN_X+cx*CELL+CELL/2;
const cellToWorldY=cy=>GRID_ORIGIN_Y+cy*CELL+CELL/2;
export const cellToWorld=(cx,cy)=>({x:cellToWorldX(cx),y:cellToWorldY(cy)});
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
export function footprintWorldRect(cx,cy,footprint=FOOTPRINT_1x1){
  const b=footprintCellBounds(cx,cy,footprint);
  return {x:GRID_ORIGIN_X+b.minX*CELL,y:GRID_ORIGIN_Y+b.minY*CELL,w:footprint.w*CELL,h:footprint.h*CELL};
}
// Boundary test on the COMPLETE footprint, not just the anchor: a 3x3 anchored one cell from the
// border overhangs the world even though its anchor is in-bounds. Half-clipped edge cells always fail.
export function footprintInWorldBounds(cx,cy,footprint=FOOTPRINT_1x1){
  const r=footprintWorldRect(cx,cy,footprint);
  return r.x>=0&&r.y>=0&&r.x+r.w<=W&&r.y+r.h<=H;
}
