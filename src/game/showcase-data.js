// Owns and validates immutable showcase fixtures.

import {
  W,H,BASE,BUILD_MARGIN,RESOURCE_KINDS,RESOURCE_FOOTPRINT,CHEST,
  BUILDING_TYPES,TOWER_VARIANTS,ENEMY_TYPES
} from "./data.js";
import {
  worldToCell,buildingFootprint,footprintCellBounds,footprintWorldRect,footprintInWorldBounds
} from "./grid.js";

const manifest = {
  sections: {
    towers:{label:"towers",x:736,y:256,zoom:.75},
    resources:{label:"resources",x:288,y:576,zoom:1.2},
    buildings:{label:"buildings",x:352,y:736,zoom:1},
    units:{label:"units",x:1120,y:688,zoom:1},
    dummies:{label:"damage dummies",x:736,y:326,zoom:.75},
    props:{label:"interaction props",x:1120,y:896,zoom:1.2},
    progress:{label:"progress states",x:704,y:800,zoom:1.2},
  },
  resourceNodes:[
    {id:"wood",section:"resources",x:96,y:544,label:"tree"},
    {id:"stone",section:"resources",x:224,y:544,label:"rock"},
    {id:"diamond",section:"resources",x:352,y:544,label:"diamond deposit"},
  ],
  looseResources:[
    {id:"wood",section:"resources",x:96,y:608,label:"loose wood"},
    {id:"stone",section:"resources",x:192,y:608,label:"loose stone"},
    {id:"dust",section:"resources",x:288,y:608,label:"loose dust"},
    {id:"coin",section:"resources",x:384,y:608,label:"loose coin"},
    {id:"diamond",section:"resources",x:480,y:608,label:"loose diamond"},
  ],
  chests:[
    {id:"unopened",section:"props",x:1344,y:896,label:"unopened chest"},
  ],
  buildings:[
    {id:"lumber",section:"buildings",x:96,y:672,label:"lumber camp"},
    {id:"quarry",section:"buildings",x:224,y:672,label:"quarry"},
    {id:"stockpile",section:"buildings",x:352,y:672,label:"stockpile"},
    {id:"house",section:"buildings",x:480,y:672,label:"house"},
    {id:"obelisk",section:"buildings",x:608,y:672,label:"obelisk"},
    {id:"blast",section:"buildings",x:96,y:800,label:"blast charge"},
    {id:"spikes",section:"buildings",x:224,y:800,label:"spike trap"},
    {id:"landmine",section:"buildings",x:352,y:800,label:"land mine"},
    {id:"tar",section:"buildings",x:480,y:800,label:"tar"},
  ],
  towers:[
    {id:"basic",x:96,y:96},{id:"turret",x:416,y:96},{id:"outpost",x:736,y:96},{id:"watch",x:1056,y:96},{id:"sniper",x:1376,y:96},
    {id:"brick",x:96,y:256},{id:"aggro",x:416,y:256},{id:"fire",x:736,y:256},{id:"freeze",x:1056,y:256},{id:"tarTower",x:1376,y:256},
    {id:"teleport",x:96,y:416},{id:"bomb",x:416,y:416},{id:"laser",x:736,y:416},{id:"pulse",x:1056,y:416},{id:"shock",x:1376,y:416},
  ].map(t=>({...t,section:"towers",label:t.id})),
  enemies:[
    {id:"raider",x:960,y:640},{id:"archer",x:1088,y:640},{id:"healer",x:1216,y:640},{id:"brute",x:1344,y:640},
  ].map(e=>({...e,section:"units",label:e.id})),
  workers:[
    {id:"guard",job:"guard",x:896,y:736,label:"worker · guard"},
    {id:"haul",job:"haul",x:992,y:736,label:"worker · hauler"},
    {id:"build",job:"build",x:1088,y:736,label:"worker · builder"},
    {id:"harvestWood",job:"harvest",tool:"wood",x:1184,y:736,label:"worker · woodcutter"},
    {id:"harvestStone",job:"harvest",tool:"stone",x:1280,y:736,label:"worker · miner"},
    {id:"staffWood",job:"staff",tool:"wood",x:1376,y:736,label:"worker · lumber staff"},
    {id:"staffStone",job:"staff",tool:"stone",x:1472,y:736,label:"worker · quarry staff"},
  ].map(worker=>({...worker,section:"units"})),
  progress:[
    {id:"blueprint",type:"house",state:"blueprint",x:608,y:800,section:"progress",label:"house · construction 50%"},
    {id:"upgrade",type:"tower",variant:"basic",upgrade:"turret",state:"upgrade",x:768,y:800,section:"progress",label:"tower · turret delivery"},
  ],
  dummies:[
    ...[
      ["basic",96,176],["turret",416,176],["outpost",736,176],["watch",1056,176],["sniper",1376,176],
      ["brick",96,336],["aggro",416,336],["fire",736,336],["freeze",1056,336],["tarTower",1376,336],
      ["teleport",96,496],["bomb",416,496],["laser",736,496],["pulse",1056,496],["shock",1376,496],
    ].map(([id,x,y])=>({id:"dummy-"+id,x,y,homeX:x,homeY:y,section:"dummies",label:"dummy · "+id,hp:40})),
    {id:"dummy-splash-extra",x:448,y:488,homeX:448,homeY:488,section:"dummies",label:"dummy · splash pair",hp:40},
    {id:"dummy-line-extra",x:744,y:480,homeX:744,homeY:480,section:"dummies",label:"dummy · line pair",hp:40},
  ],
  props:[
    {id:"crate",model:"crate",x:1088,y:896,section:"props",label:"pickable crate",footprint:{w:1,h:1}},
    {id:"barrel",model:"barrel",x:1216,y:896,section:"props",label:"pickable barrel",footprint:{w:1,h:1}},
  ],
};

function fail(message){throw new Error("showcase-data.js: "+message);}
function sameMembers(label,actual,expected){
  const counts=new Map();
  for(const id of actual)counts.set(id,(counts.get(id)||0)+1);
  const missing=expected.filter(id=>!counts.has(id));
  const duplicate=[...counts].filter(([,count])=>count!==1).map(([id])=>id);
  const unknown=[...counts.keys()].filter(id=>!expected.includes(id));
  if(missing.length||duplicate.length||unknown.length)
    fail(label+" coverage (missing: "+missing.join(",")+"; duplicate: "+duplicate.join(",")+"; unknown: "+unknown.join(",")+")");
}
function validFootprint(footprint){
  return footprint&&Number.isInteger(footprint.w)&&Number.isInteger(footprint.h)&&footprint.w>0&&footprint.h>0&&footprint.w%2===1&&footprint.h%2===1;
}
function overlaps(a,b){return a.minX<=b.maxX&&b.minX<=a.maxX&&a.minY<=b.maxY&&b.minY<=a.maxY;}
function validateManifest(){
  sameMembers("resource nodes",manifest.resourceNodes.map(f=>f.id),["wood","stone","diamond"]);
  sameMembers("loose resources",manifest.looseResources.map(f=>f.id),RESOURCE_KINDS);
  sameMembers("buildings",manifest.buildings.map(f=>f.id),Object.keys(BUILDING_TYPES).filter(id=>id!=="tower"));
  sameMembers("tower variants",manifest.towers.map(f=>f.id),Object.keys(TOWER_VARIANTS));
  sameMembers("enemies",manifest.enemies.map(f=>f.id),Object.keys(ENEMY_TYPES));

  sameMembers("chests",manifest.chests.map(f=>f.id),["unopened"]);

  const groups=["resourceNodes","looseResources","chests","buildings","towers","enemies","workers","progress","dummies","props"];
  const keys=new Set();
  for(const group of groups){
    const ids=new Set();
    for(const fixture of manifest[group]){
      if(typeof fixture.id!=="string"||!fixture.id)fail(group+" fixture has no id");
      if(ids.has(fixture.id))fail(group+" has duplicate id "+fixture.id);
      ids.add(fixture.id);
      const key=group+":"+fixture.id;
      if(keys.has(key))fail("duplicate fixture key "+key);
      keys.add(key);
      if(!manifest.sections[fixture.section])fail(key+" references unknown section "+fixture.section);
      if(!Number.isFinite(fixture.x)||!Number.isFinite(fixture.y))fail(key+" has non-finite coordinates");
    }
  }
  for(const [id,section] of Object.entries(manifest.sections))
    if(!section.label||![section.x,section.y,section.zoom].every(Number.isFinite)||section.zoom<=0)fail("invalid section "+id);
  for(const prop of manifest.props){
    if(!["crate","barrel"].includes(prop.model))fail("invalid prop model "+prop.id+": "+prop.model);
    if(!validFootprint(prop.footprint))fail("invalid prop footprint "+prop.id);
  }
  for(const fixture of manifest.progress){
    if(!BUILDING_TYPES[fixture.type])fail("unknown progress building "+fixture.type);
    switch(fixture.state){
      case "blueprint":
        if(BUILDING_TYPES[fixture.type].instant)fail("instant building has blueprint progress "+fixture.id);
        if(fixture.variant!==undefined||fixture.upgrade!==undefined)fail("blueprint has tower upgrade fields "+fixture.id);
        break;
      case "upgrade":
        if(fixture.type!=="tower")fail("upgrade progress is not a tower "+fixture.id);
        if(!TOWER_VARIANTS[fixture.variant]||!TOWER_VARIANTS[fixture.upgrade])fail("invalid progress tower variant "+fixture.id);
        if(fixture.variant!=="basic")fail("tower upgrade source is not basic "+fixture.id);
        if(fixture.upgrade==="basic")fail("tower upgrade destination is not permanent "+fixture.id);
        break;
      default: fail("invalid progress state "+fixture.state);
    }
  }
  for(const worker of manifest.workers){
    if(!["guard","haul","build","harvest","staff"].includes(worker.job))fail("invalid worker job "+worker.job);
    if(["harvest","staff"].includes(worker.job)&&!["wood","stone"].includes(worker.tool))fail("invalid worker tool "+worker.id);
  }
  for(const dummy of manifest.dummies)if(!(dummy.hp>0)||dummy.x!==dummy.homeX||dummy.y!==dummy.homeY)fail("invalid dummy "+dummy.id);

  const placed=[
    ...manifest.resourceNodes.map(f=>({...f,key:"resourceNodes:"+f.id,footprint:RESOURCE_FOOTPRINT})),
    ...manifest.chests.map(f=>({...f,key:"chests:"+f.id,footprint:CHEST.footprint})),
    ...manifest.buildings.map(f=>({...f,key:"buildings:"+f.id,footprint:buildingFootprint(f.id)})),
    ...manifest.towers.map(f=>({...f,key:"towers:"+f.id,footprint:buildingFootprint("tower")})),
    ...manifest.progress.map(f=>({...f,key:"progress:"+f.id,footprint:buildingFootprint(f.type)})),
    ...manifest.props.map(f=>({...f,key:"props:"+f.id})),
  ];
  const baseCell=worldToCell(BASE.x,BASE.y),baseBounds=footprintCellBounds(baseCell.cx,baseCell.cy,BASE.footprint);
  for(let i=0;i<placed.length;i++){
    const fixture=placed[i];
    if(!validFootprint(fixture.footprint))fail("invalid footprint "+fixture.key);
    const cell=worldToCell(fixture.x,fixture.y),rect=footprintWorldRect(cell.cx,cell.cy,fixture.footprint),bounds=footprintCellBounds(cell.cx,cell.cy,fixture.footprint);
    if(!footprintInWorldBounds(cell.cx,cell.cy,fixture.footprint)||rect.x<BUILD_MARGIN||rect.y<BUILD_MARGIN||rect.x+rect.w>W-BUILD_MARGIN||rect.y+rect.h>H-BUILD_MARGIN)fail(fixture.key+" exceeds build margin");
    if(overlaps(bounds,baseBounds))fail(fixture.key+" overlaps base");
    for(let j=0;j<i;j++){
      const other=placed[j],otherCell=worldToCell(other.x,other.y);
      if(overlaps(bounds,footprintCellBounds(otherCell.cx,otherCell.cy,other.footprint)))fail(fixture.key+" overlaps "+other.key);
    }
  }
}
function deepFreeze(value){
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    for(const child of Object.values(value))deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

validateManifest();
export const SHOWCASE_MANIFEST=deepFreeze(manifest);
export const SHOWCASE_FIXTURE_COUNTS=Object.freeze(Object.fromEntries(
  Object.entries(manifest).filter(([,value])=>Array.isArray(value)).map(([key,value])=>[key,value.length])
));
