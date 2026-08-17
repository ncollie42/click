#!/usr/bin/env node
// Deterministic, DOM-free repository validation and sustained simulation stress.

import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync,readdirSync,statSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
function filesUnder(dir){
  const output=[];
  for(const name of readdirSync(dir).sort()){
    const path=join(dir,name),stat=statSync(path);
    if(stat.isDirectory()){if(name!==".git"&&name!==".pi")output.push(...filesUnder(path));}
    else output.push(path);
  }
  return output;
}
const jsFiles=filesUnder(root).filter(path=>/\.(?:js|mjs)$/.test(path));
for(const path of jsFiles)execFileSync(process.execPath,["--check",path],{stdio:"pipe"});

let randomState=0x5eed1234;
const originalRandom=Math.random;
Math.random=()=>((randomState=Math.imul(randomState,1664525)+1013904223>>>0)/0x100000000);
let sim,data,grid,showcase,cardCatalog,am,mapdoc;
try{
  [sim,data,grid,showcase,cardCatalog,am,mapdoc]=await Promise.all([
    import(pathToFileURL(join(root,"src/game/simulation.js"))),
    import(pathToFileURL(join(root,"src/game/data.js"))),
    import(pathToFileURL(join(root,"src/game/grid.js"))),
    import(pathToFileURL(join(root,"src/game/showcase-data.js"))),
    import(pathToFileURL(join(root,"src/game/cards.js"))),
    import(pathToFileURL(join(root,"src/game/authored-map.js"))),
    import(pathToFileURL(join(root,"src/game/map-document.js")))
  ]);

  assert.deepEqual(data.FEED_XP,{wood:1,stone:1,dust:5,coin:5,diamond:12});
  assert.deepEqual(Object.keys(data.FEED_XP),data.RESOURCE_KINDS);
  assert.deepEqual(Object.fromEntries(data.NIGHT_WAVE_RECIPES.map(recipe=>[recipe.id,recipe.minTier])),{raiderRush:0,archerLine:0,healerEscort:1,brutePush:2,twoFront:2});
  assert.deepEqual(data.WAVE_THREAT_CURVE,{startBudget:12,targetBudget:100,targetWave:8,power:1.5});assert.equal(Object.isFrozen(data.WAVE_THREAT_CURVE),true);
  assert.equal(Object.isFrozen(data.ENEMY_TYPES),true);assert.equal(Object.values(data.ENEMY_TYPES).every(enemy=>Object.isFrozen(enemy)&&Number.isInteger(enemy.threatCost)&&enemy.threatCost>0&&enemy.spawnWeight>0&&["light","heavy"].includes(enemy.weightTag)),true);
  for(const archetype of ["raider","archer","healer","brute"]){const variants=Object.values(data.ENEMY_TYPES).filter(enemy=>enemy.archetype===archetype&&!enemy.boss).sort((a,b)=>a.variantTier-b.variantTier);assert.deepEqual(variants.map(enemy=>enemy.variantTier),[1,2,3]);assert.deepEqual(variants.map(enemy=>enemy.minWave),[1,4,7]);assert.ok(variants[1].hp>variants[0].hp&&variants[2].hp>variants[1].hp);assert.ok(variants[1].threatCost>variants[0].threatCost&&variants[2].threatCost>variants[1].threatCost);}
  assert.deepEqual(new Set(Object.values(data.ENEMY_TYPES).filter(enemy=>enemy.variantTier===2).map(enemy=>enemy.variantColor)),new Set(["#3568a8"]));assert.deepEqual(new Set(Object.values(data.ENEMY_TYPES).filter(enemy=>enemy.variantTier===3).map(enemy=>enemy.variantColor)),new Set(["#a23e50"]));
  {const boss=data.ENEMY_TYPES.bruteBoss;assert.equal(boss.archetype,"brute");assert.equal(boss.boss,true);assert.equal(boss.minWave,5);assert.equal(boss.modelScale,4);assert.equal(boss.size,data.ENEMY_TYPES.brute.size*4);assert.ok(boss.damage>data.ENEMY_TYPES.brute.damage&&boss.hp>data.ENEMY_TYPES.brute.hp);assert.equal(boss.threatCost,20);}assert.deepEqual(data.WAVE_BOSS_SPAWNS,{5:"bruteBoss"});
  assert.equal(Object.isFrozen(data.ENEMY_POOL),true);assert.equal(Object.isFrozen(data.NIGHT_WAVE_RECIPES),true);assert.equal(data.NIGHT_WAVE_RECIPES.every(recipe=>Object.isFrozen(recipe)&&Object.isFrozen(recipe.pool)&&recipe.pool.every(type=>data.ENEMY_TYPES[type])),true);
  assert.deepEqual(data.LEVEL_CURVE,{base:6,growth:1.19});assert.equal(data.SKILL_POINT_LEVELS,4);
  assert.deepEqual(data.XP_TIERS,[40,100,200,350]);   // dead table, still imported by docs/progression.html and render/scene.js
  assert.equal(Object.isFrozen(data.CHEST),true);assert.equal(Object.isFrozen(data.CHEST.weights),true);assert.equal(Object.isFrozen(data.CHEST.outcomeOdds),true);
  assert.deepEqual(Object.keys(data.CHEST.weights),data.RESOURCE_KINDS);
  assert.equal(data.CHEST.startingCount,1);assert.equal(data.CHEST.maxHp,4);assert.deepEqual(data.CHEST.outcomeOdds,{cache:.5,pinata:.5});assert.equal(data.CHEST.cachePayout,5);assert.equal(data.CHEST.pinataPayout,12);assert.equal(data.CHEST.footprint,data.FOOTPRINT_1x1);
  assert.ok(data.CHEST.weights.wood>data.CHEST.weights.dust&&data.CHEST.weights.stone>data.CHEST.weights.coin&&data.CHEST.weights.diamond<Math.min(...data.RESOURCE_KINDS.filter(k=>k!=="diamond").map(k=>data.CHEST.weights[k])));

  // ── authored starter world ──
  // The world is authored data (src/game/maps/starter.map.json) parsed by map-document and
  // loaded by authored-map. Structural checks run on the pure loader before any simulation state.
  const placementGrid={width:data.W,height:data.H,cellSize:data.CELL,gridOriginX:data.GRID_ORIGIN_X,gridOriginY:data.GRID_ORIGIN_Y,gridCols:data.GRID_COLS,gridRows:data.GRID_ROWS};
  const authoredWorld=am.buildStarterWorld();
  {
    const starterDoc=mapdoc.parseMapDocument(am.STARTER_MAP_SOURCE);
    assert.deepEqual([starterDoc.width,starterDoc.height,starterDoc.cellSize],[data.GRID_COLS,data.GRID_ROWS,data.CELL],"starter map must cover the placement grid 1:1");
    assert.deepEqual(am.buildStarterWorld(),authoredWorld,"authored world loading must be deterministic");
    assert.deepEqual([authoredWorld.width,authoredWorld.height,authoredWorld.terrainCellSize,authoredWorld.terrainOriginX,authoredWorld.terrainOriginY,authoredWorld.terrainCols,authoredWorld.terrainRows,authoredWorld.terrainOrder],[data.W,data.H,16,0,0,am.TERRAIN_COLS,am.TERRAIN_ROWS,"row-major"]);
    assert.deepEqual([authoredWorld.placementCellSize,authoredWorld.placementOriginX,authoredWorld.placementOriginY,authoredWorld.placementCols,authoredWorld.placementRows],[data.CELL,data.GRID_ORIGIN_X,data.GRID_ORIGIN_Y,data.GRID_COLS,data.GRID_ROWS]);
    assert.equal(authoredWorld.terrain.length,am.TERRAIN_COLS*am.TERRAIN_ROWS);assert.equal(authoredWorld.terrain.every(tag=>am.TERRAIN_TAGS.includes(tag)),true);
    assert.equal(Object.isFrozen(authoredWorld)&&Object.isFrozen(authoredWorld.terrain)&&Object.isFrozen(authoredWorld.trees)&&Object.isFrozen(authoredWorld.grass)&&authoredWorld.grass.every(Object.isFrozen)&&Object.isFrozen(authoredWorld.targets)&&Object.isFrozen(authoredWorld.raised),true,"blueprint ownership is not read-only at public boundaries");
    // 1:1 grid alignment: a placement cell is buildable land exactly when its authored cell is painted land.
    for(let cy=1;cy<data.GRID_ROWS-1;cy+=3)for(let cx=1;cx<data.GRID_COLS-1;cx+=3)
      assert.equal(am.placementFootprintOnLand(authoredWorld,cx,cy,data.FOOTPRINT_1x1,placementGrid),starterDoc.land[cy*starterDoc.width+cx]===1,`raster/authored land disagreement at (${cx}, ${cy})`);
    const baseCell=grid.worldToCell(data.BASE.x,data.BASE.y);
    assert.equal(am.placementFootprintOnLand(authoredWorld,baseCell.cx,baseCell.cy,data.BASE.footprint,placementGrid),true,"base footprint is not entirely on authored land");
    assert.deepEqual([authoredWorld.trees.length,authoredWorld.rocks.length,authoredWorld.diamonds.length,authoredWorld.chests.length,authoredWorld.grass.length],[authoredWorld.targets.treeCount,authoredWorld.targets.rockCount,authoredWorld.targets.diamondCount,authoredWorld.targets.chestCount,authoredWorld.targets.grassCount]);
    assert.deepEqual(authoredWorld.targets,{treeCount:225,rockCount:77,diamondCount:2,chestCount:data.CHEST.startingCount+data.CHEST.scatterPerTile*data.MAP_TILES,grassCount:657},"intentional starter scatter targets changed; review distribution before updating");
    for(const landmark of starterDoc.objects.filter(object=>object.kind==="tree"||object.kind==="rock")){const loaded=authoredWorld[`${landmark.kind}s`].find(cell=>cell.cx===landmark.cx&&cell.cy===landmark.cy);assert.ok(loaded,"explicit landmark was not loaded");assert.equal(loaded.variant,landmark.variant,"explicit landmark variant drifted");}
    const starterScatter=am.resolveAuthoredMapScatter(starterDoc);
    assert.deepEqual(starterScatter.totals,{tree:222,rock:75,grass:657});
    const reordered=mapdoc.cloneMapDocument(starterDoc);reordered.scatterRegions.reverse();assert.deepEqual(am.resolveAuthoredMapScatter(reordered),starterScatter,"JSON region order changed resolved resources");
    const rerolled=mapdoc.cloneMapDocument(starterDoc),west=rerolled.scatterRegions.find(region=>region.id==="forest-west");west.seed=(west.seed+1)>>>0;const rerolledScatter=am.resolveAuthoredMapScatter(rerolled);
    assert.deepEqual(rerolledScatter.trees.filter(cell=>cell.regionId==="forest-east"),starterScatter.trees.filter(cell=>cell.regionId==="forest-east"),"local reroll perturbed a disjoint region");
    assert.ok(authoredWorld.grass.length>500,"starter vegetation is too sparse to read as Clickyland grass");
    // The chest field is world scatter over whatever the map authors: exactly startingCount chests
    // sit in the discover band (scatter tops the band up when the map authors none), every other
    // chest is exploration loot strictly beyond it, and none crowd the base inside the minimum.
    {
      const radii=authoredWorld.chests.map(cell=>{const p=grid.cellToWorld(cell.cx,cell.cy);return Math.hypot(p.x-data.BASE.x,p.y-data.BASE.y);});
      assert.equal(radii.filter(radius=>radius>=data.CHEST.discoverMinRadius&&radius<=data.CHEST.discoverMaxRadius).length,data.CHEST.startingCount,"the discover band must hold exactly the starting chest count");
      assert.equal(radii.filter(radius=>radius>data.CHEST.discoverMaxRadius).length,data.CHEST.scatterPerTile*data.MAP_TILES,"exploration chest count drifted from the authored per-tile rate");
      assert.equal(radii.some(radius=>radius<data.CHEST.discoverMinRadius),false,"a chest crowded the base inside the discover minimum");
    }
    const occupied=new Set();
    for(const cell of [...authoredWorld.trees,...authoredWorld.rocks,...authoredWorld.diamonds,...authoredWorld.chests]){
      const address=cell.cy*data.GRID_COLS+cell.cx;
      assert.equal(occupied.has(address),false,"authored occupants share a cell");occupied.add(address);
      assert.equal(am.placementFootprintOnLand(authoredWorld,cell.cx,cell.cy,data.FOOTPRINT_1x1,placementGrid),true,"authored occupant touches water");
    }
    const vegetationCells=new Set(authoredWorld.grass.map(cell=>cell.cy*data.GRID_COLS+cell.cx));
    assert.equal(vegetationCells.size,authoredWorld.grass.length,"two grass tufts share one source cell");
    for(const cell of authoredWorld.grass){assert.equal(occupied.has(cell.cy*data.GRID_COLS+cell.cx),false,"grass overlaps an authored occupant");assert.equal(am.placementFootprintOnLand(authoredWorld,cell.cx,cell.cy,data.FOOTPRINT_1x1,placementGrid),true,"grass touches water");}
    const protectedBaseCell=grid.worldToCell(data.BASE.x,data.BASE.y),generated=[...starterScatter.trees,...starterScatter.rocks,...starterScatter.grass];
    for(const cell of generated){const rect=grid.footprintWorldRect(cell.cx,cell.cy,data.FOOTPRINT_1x1);assert.ok(rect.x>=data.BUILD_MARGIN&&rect.y>=data.BUILD_MARGIN&&rect.x+rect.w<=data.W-data.BUILD_MARGIN&&rect.y+rect.h<=data.H-data.BUILD_MARGIN,"generated cell escaped build margin");assert.ok(Math.abs(cell.cx-protectedBaseCell.cx)>1||Math.abs(cell.cy-protectedBaseCell.cy)>1,"generated cell entered protected base footprint");}
    // Loader rejections: bad authored data must fail loudly, never repair.
    const plain=()=>JSON.parse(JSON.stringify(am.STARTER_MAP_SOURCE));
    assert.throws(()=>am.buildWorldFromMapData("{nope"),/invalid JSON/);
    {const bad=plain();bad.width=64;bad.height=40;bad.land=bad.land.slice(0,40).map(row=>row.slice(0,64));bad.raised=bad.raised.slice(0,40).map(row=>row.slice(0,64));bad.objects=[];bad.scatterRegions=[];assert.throws(()=>am.buildWorldFromMapData(bad),/must be 241x161 cells/);}
    {const bad=plain();bad.objects=[...bad.objects,{kind:"house",cx:120,cy:60,rotation:0,variant:null}];assert.throws(()=>am.buildWorldFromMapData(bad),/cannot load into the game yet/);}
    {const bad=plain();for(const cy of [79,80,81])bad.land[cy]=bad.land[cy].slice(0,119)+"~~~"+bad.land[cy].slice(122);assert.throws(()=>am.buildWorldFromMapData(bad),/base footprint.*not entirely on painted land/);}
    {const allLand=plain();allLand.objects=allLand.objects.filter(object=>object.kind!=="chest"||true);allLand.land=allLand.land.map(row=>"#".repeat(row.length));am.buildWorldFromMapData(allLand);} // oceanless maps are legal: spawning is a ring around the base
    {const bad=plain();bad.raised[0]="^"+bad.raised[0].slice(1);assert.throws(()=>am.buildWorldFromMapData(bad),/raised implies land/,"raised-over-water imports must be rejected, not repaired");}

    // Terrain raster query helpers keep their exact contract on synthetic worlds.
    const synthetic={width:192,height:192,terrainCellSize:16,terrainOriginX:0,terrainOriginY:0,terrainCols:12,terrainRows:12,terrainOrder:"row-major",terrain:Array(144).fill(am.LAND)};
    synthetic.terrain[5*12+4]=am.WATER;
    assert.equal(am.terrainAtRasterCell(synthetic,4,5),am.WATER,"row-major terrain indexing drifted");
    assert.equal(am.terrainAtRasterCell(synthetic,-1,0),null);assert.equal(am.terrainAtRasterCell(synthetic,12,0),null);
    assert.equal(am.terrainAtWorldPoint(synthetic,0,0),am.LAND);assert.equal(am.terrainAtWorldPoint(synthetic,191.999,191.999),am.LAND);
    assert.equal(am.terrainAtWorldPoint(synthetic,192,0),null);assert.equal(am.terrainAtWorldPoint(synthetic,0,192),null);
    assert.equal(am.worldRectEntirelyOnLand({...synthetic,terrain:Array(144).fill(am.LAND)},{x:0,y:0,w:192,h:192}),true,"exact world-boundary rectangle must cover the final raster cells without overrun");
    assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:0,y:0,w:192,h:192}),false);
    assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:-1,y:0,w:1,h:1}),false);assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:191,y:191,w:2,h:1}),false);
    assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:63,y:80,w:1,h:1}),true);
    assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:63,y:80,w:2,h:1}),false,"partial overlap with a water raster cell was accepted");
    assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:64,y:80,w:Number.EPSILON,h:1}),false,"sub-ULP span skipped water at a raster boundary");
    assert.equal(am.worldRectEntirelyOnLand(synthetic,{x:192,y:0,w:Number.EPSILON,h:1}),false,"sub-ULP span starting at the world boundary was accepted");
    const syntheticPlacement={width:192,height:192,cellSize:32,gridOriginX:-16,gridOriginY:-16,gridCols:7,gridRows:7};
    assert.equal(am.placementFootprintOnLand(synthetic,3,3,{w:1,h:1},syntheticPlacement),true,"1x1 placement footprint queried the wrong raster cells");
    assert.equal(am.placementFootprintOnLand(synthetic,3,3,{w:3,h:3},syntheticPlacement),false,"3x3 placement footprint missed fine-raster water");
    assert.throws(()=>am.terrainAtRasterCell({terrainCols:4,terrainRows:4,terrain:[]},0,0),/malformed row-major terrain blueprint/);
    const badTag={...synthetic,terrain:[...synthetic.terrain]};badTag.terrain[0]="lava";assert.throws(()=>am.terrainAtRasterCell(badTag,0,0),/unknown terrain tag/);assert.throws(()=>am.validateTerrainTags(badTag.terrain,badTag.terrain.length),/unknown terrain tag/);
    for(const footprint of [{w:0,h:1},{w:-1,h:1},{w:2,h:2},{w:1.5,h:1}])assert.throws(()=>am.placementFootprintOnLand(synthetic,1,1,footprint,syntheticPlacement),/positive odd integers/);
    // The raised layer rides the blueprint at authored-cell resolution and always implies land.
    assert.equal(authoredWorld.raised.length,data.GRID_COLS*data.GRID_ROWS);
    authoredWorld.raised.forEach((value,address)=>{if(value===1)assert.equal(starterDoc.land[address],1,"blueprint raised cell is not land");});
  }

  // Grass is lowest-priority one-hit scenery: no drops, no occupancy, no second hit.
  {
    const tuft=sim.grass[0],beforeCount=sim.grass.length,beforeDrops=sim.resourceDrops.length,oldChopTime=sim.TUNE.chopTime;
    assert.ok(tuft&&tuft.hp===1&&tuft.max===1);assert.equal(sim.canPlace(tuft.x,tuft.y,null),true,"grass incorrectly blocks placement");
    assert.equal(sim.resolvePrimaryAction(tuft.x,tuft.y)?.kind,"cut-grass");sim.TUNE.chopTime=.01;sim.setPointerWorld(tuft.x,tuft.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();sim.TUNE.chopTime=oldChopTime;
    assert.equal(sim.grass.length,beforeCount-1);assert.equal(sim.grass.includes(tuft),false);assert.equal(sim.resourceDrops.length,beforeDrops,"grass yielded a resource");assert.notEqual(sim.resolvePrimaryAction(tuft.x,tuft.y)?.target,tuft,"destroyed grass remained targetable");sim.validateSimulationInvariants();
  }

  // The pacing docs may never drift from the authored tables: every typed ref in
  // progression-spec.js and cards.js must resolve, beats stay sorted, phases tile
  // the arc, and the draft-feedback model must actually converge.
  {
    const spec=await import(pathToFileURL(join(root,"docs/progression-spec.js")));
    const cards=await import(pathToFileURL(join(root,"src/game/cards.js")));
    const {scoreBuilding,scoreTower}=await import(pathToFileURL(join(root,"docs/tower-score.js")));
    const refTables={building:id=>id in data.BUILDING_TYPES,upgrade:id=>data.UPGRADES.some(u=>u.id===id),tower:id=>id in data.TOWER_VARIANTS,concept:()=>true};
    const checkRef=(ref,owner)=>{const [kind,id]=ref.split(":");assert.ok(refTables[kind]?.(id),`${owner} ref ${ref} names nothing in data.js`);};
    assert.equal(spec.LEVEL_CURVE,data.LEVEL_CURVE,"the spec must re-export the game's level curve, never restate it");
    assert.deepEqual(Object.keys(cards.RARITY_WEIGHTS).sort(),[...cards.RARITIES].sort());
    assert.equal(new Set(cards.CARD_FEATURES).size,cards.CARD_FEATURES.length,"card features must be unique");
    for(const rarity of cards.RARITIES)assert.ok(cards.RARITY_WEIGHTS[rarity]>0,`rarity weight ${rarity} must be positive`);
    for(let i=1;i<cards.RARITIES.length;i++)assert.ok(cards.RARITY_WEIGHTS[cards.RARITIES[i]]<cards.RARITY_WEIGHTS[cards.RARITIES[i-1]],"rarer cards must be drawn less often");
    for(const beat of spec.BEATS)checkRef(beat.ref,"progression beat");
    for(let i=1;i<spec.BEATS.length;i++)assert.ok(spec.BEATS[i].min>spec.BEATS[i-1].min,"progression beats out of order");
    assert.equal(spec.PHASES[0].start,0);
    assert.equal(spec.PHASES[spec.PHASES.length-1].end,spec.ARC.targetMinutes);
    for(let i=1;i<spec.PHASES.length;i++)assert.equal(spec.PHASES[i].start,spec.PHASES[i-1].end,"progression phases must tile the arc");
    for(const key of ["handHitsPerMin","feedFraction","avgXpPerFedUnit"])assert.equal(spec.PLAYER_MODEL[key].length,spec.PHASES.length,`PLAYER_MODEL.${key} must have one entry per phase`);

    const ids=new Set();
    for(const card of cards.CARDS){
      assert.ok(!ids.has(card.id),`duplicate card id ${card.id}`);ids.add(card.id);
      assert.ok(cards.CARD_CATEGORIES.includes(card.category),`card ${card.id} has unknown category`);
      assert.ok(cards.RARITIES.includes(card.rarity),`card ${card.id} has unknown rarity`);
      assert.equal(typeof card.implemented,"boolean",`card ${card.id} missing implemented flag`);
      assert.equal(typeof card.inPool,"boolean",`card ${card.id} missing inPool flag`);
      checkRef(card.ref,`card ${card.id}`);
      if(card.model){assert.ok(["hand","worker","global","xp"].includes(card.model.target),`card ${card.id} model target`);assert.ok(card.model.mult>1,`card ${card.id} model mult must exceed 1`);}
      if(card.type){assert.ok(["consumable","aura"].includes(card.category),`card ${card.id} type is deployable-only`);assert.ok(["building","spell"].includes(card.type),`card ${card.id} has unknown deployable type`);}
      if(card.charges!==undefined){assert.ok(["consumable","aura","build"].includes(card.category),`card ${card.id} charges are deployable-only`);assert.ok(Number.isInteger(card.charges)&&card.charges>0,`card ${card.id} charges must be a positive integer`);}
      if(card.durationSeconds!==undefined){assert.ok(["consumable","aura"].includes(card.category),`card ${card.id} duration is deployable-only`);assert.ok(Number.isFinite(card.durationSeconds)&&card.durationSeconds>0,`card ${card.id} duration must be positive`);}
      if(card.category==="aura"){assert.equal(card.type,"building",`aura ${card.id} must be a building`);assert.ok(card.charges>0&&card.durationSeconds>0,`aura ${card.id} must be temporary and charged`);}
      if(card.tags!==undefined){assert.ok(Array.isArray(card.tags)&&card.tags.length>0,`card ${card.id} tags must be a non-empty array`);assert.ok(card.tags.every(tag=>typeof tag==="string"&&tag.length>0),`card ${card.id} has an invalid tag`);}
      if(card.features!==undefined){assert.ok(Array.isArray(card.features)&&card.features.length>0,`card ${card.id} features must be a non-empty array`);assert.ok(card.features.every(feature=>cards.CARD_FEATURES.includes(feature)),`card ${card.id} has an unknown feature`);}
      if(card.ref.startsWith("tower:")){
        const tower=data.TOWER_VARIANTS[card.ref.slice(6)],scored=scoreTower(tower);
        const targetTag=tower.attackMode==="line"?"piercing":["splash","periodic area","manual area","chain"].includes(tower.attackMode)?"aoe":"single target";
        assert.ok(Number.isFinite(scored.score)&&scored.score>0,`card ${card.id} has invalid tower score`);
        assert.ok(card.tags?.includes(targetTag),`card ${card.id} must carry its ${targetTag} targeting tag`);
      }
      if(card.type==="building"&&card.ref.startsWith("building:")){
        const building=data.BUILDING_TYPES[card.ref.slice(9)],scored=scoreBuilding(building,{quantity:card.charges||1});
        if(scored)assert.ok(Number.isFinite(scored.score)&&scored.score>=0,`card ${card.id} has invalid building score`);
      }
      if(card.produces!==undefined){assert.equal(card.category,"build",`card ${card.id} produces is build-only`);assert.ok(typeof card.produces==="string"&&card.produces.length>0,`card ${card.id} has invalid produce output`);}
      if(card.requires!==undefined){
        assert.ok(Array.isArray(card.requires)&&card.requires.length>0,`card ${card.id} requires must be a non-empty array`);
        assert.equal(new Set(card.requires).size,card.requires.length,`card ${card.id} lists a duplicate prerequisite`);
        for(const prereqId of card.requires){
          const prereq=cards.cardById[prereqId];
          assert.ok(prereq,`card ${card.id} requires unknown card ${prereqId}`);
          assert.notEqual(prereqId,card.id,`card ${card.id} requires itself`);
          assert.equal(prereq.category,"buff",`card ${card.id} prerequisite ${prereqId} must be a buff — only buff stacks are owned run state`);
          assert.ok(!card.inPool||prereq.inPool,`card ${card.id} is inPool behind ${prereqId}, which the draft can never deal`);
        }
      }
      assert.ok(!card.inPool||card.implemented,`card ${card.id} is inPool but not implemented`);
    }
    for(const id of spec.DRAFT_POLICY.cycle){const card=cards.cardById[id];assert.ok(card,`draft policy cycles unknown card ${id}`);assert.ok(card.model,`draft policy card ${id} carries no income model`);}

    // The capture loop's authored contract: a 3x3 constructed yard, a frozen three-living-ally
    // capacity table, and a build card gated behind the enemyPickup buff.
    assert.equal(data.BUILDING_TYPES.captureYard.footprint,data.FOOTPRINT_3x3,"capture yard must reserve a 3x3 footprint");
    assert.deepEqual(data.BUILDING_TYPES.captureYard.cost,{wood:8,stone:8});
    assert.equal(data.BUILDING_TYPES.captureYard.buildSlots,3);
    assert.ok(Object.isFrozen(data.CAPTURE_YARD),"capture yard tuning must be immutable");
    assert.equal(data.CAPTURE_YARD.capacity,3,"a completed yard supports exactly three living controlled enemies");
    assert.deepEqual(cards.cardById.bpCaptureYard.requires,["enemyPickup"],"bpCaptureYard must be gated behind the enemyPickup buff");

    // The garrison's authored contract: an ordinary 1x1 constructed building whose GUARD numbers all
    // live in one frozen record, reachable only through the common build card — never the opening hand.
    {
      const garrison=data.BUILDING_TYPES.garrison;
      assert.equal(garrison.footprint,data.FOOTPRINT_1x1,"garrison must reserve a 1x1 footprint");
      assert.deepEqual(garrison.cost,{wood:6,stone:6});
      assert.equal(garrison.buildSlots,2);
      assert.equal(garrison.jobSlots,3,"a garrison holds exactly three guards");
      assert.equal(garrison.jobSlots,data.GARRISON.capacity,"garrison job slots must read the guard capacity, never restate it");
      assert.ok(Object.isFrozen(data.GARRISON),"garrison tuning must be immutable");
      assert.deepEqual({...data.GARRISON},{capacity:3,musterRadius:300,threatRadius:180,guardRadius:180,safeSeconds:10,maxHp:10,damage:2});
      assert.ok(data.GARRISON.musterRadius>data.GARRISON.threatRadius,"the muster call must reach further than the threat that raises it");
      assert.equal(garrison.attackMode,undefined,"the garrison itself has no attack");
      assert.equal(garrison.resource,null,"the garrison produces no resource");
      const garrisonCard=cards.cardById.bpGarrison;
      assert.equal(garrisonCard.category,"build");assert.equal(garrisonCard.rarity,"common");
      assert.equal(garrisonCard.ref,"building:garrison","bpGarrison must reference the authored garrison row");
      assert.equal(garrisonCard.implemented,true);assert.equal(garrisonCard.inPool,true,"the garrison is drafted, not granted");
      assert.equal(garrisonCard.requires,undefined,"the garrison build card is ungated");
      // Not in the opening hand: the starting-kit assertion below pins that hand to the base kit alone.
      // The barracks stays a separate, unbuilt warrior-PRODUCING concept; the garrison never became it.
      const barracks=cards.cardById.bpBarracks;
      assert.equal(barracks.ref,"concept:barracks");assert.equal(barracks.produces,"warriors");
      assert.equal(barracks.implemented,false);assert.equal(barracks.inPool,false);
    }

    const {runModel,MODELED_WAVE_CLEAR_SECONDS}=await import(pathToFileURL(join(root,"docs/progression-model.js")));
    assert.equal(MODELED_WAVE_CLEAR_SECONDS,45,"the docs-only estimate must preserve the prior model output");
    const model=runModel();
    assert.equal(model.eff,(data.DAY_DURATION+MODELED_WAVE_CLEAR_SECONDS*spec.ARC.nightIncomeFactor)/(data.DAY_DURATION+MODELED_WAVE_CLEAR_SECONDS));
    assert.ok(model.levelUps.length>=15&&model.levelUps.length<=80,`draft count ${model.levelUps.length} outside sanity range`);
    for(let i=1;i<model.levelUps.length;i++)assert.ok(model.levelUps[i].min>=model.levelUps[i-1].min,"level-up times must be monotonic");
    assert.ok(Number.isFinite(model.series.total[model.series.total.length-1]),"model income diverged");
  }
  assert.equal(sim.state.runMode,"normal");
  assert.equal(sim.damageDummies.length,0);
  assert.equal(sim.showcaseProps.length,0);
  assert.equal(sim.chests.length,authoredWorld.targets.chestCount);
  {
    // Every materialized chest is cell-aligned, placeable in its own footprint, and unresolved.
    for(const chest of sim.chests){const cell=grid.worldToCell(chest.x,chest.y);assert.deepEqual({x:chest.x,y:chest.y},grid.cellToWorld(cell.cx,cell.cy));assert.equal(sim.canPlace(chest.x,chest.y,null,null,null,chest),true);assert.equal(sim.canPlace(chest.x,chest.y,"house"),false);assert.equal("contents" in chest,false);assert.equal("outcome" in chest,false);}
    // Exactly one starter chest is discoverable from the opening camera; the rest are exploration loot.
    const inBand=sim.chests.filter(chest=>{const radius=sim.distance(chest.x,chest.y,sim.state.camera.x,sim.state.camera.y);return radius>=data.CHEST.discoverMinRadius&&radius<=data.CHEST.discoverMaxRadius;});
    assert.equal(inBand.length,data.CHEST.startingCount);
  }
  sim.initializeRunMode("normal");
  // ── the starting hand ──
  // With the build shop gone a fresh run can only build out of the hand, so normal initialization
  // seeds the opening kit. It is dealt ONCE (re-initializing the same mode stays idempotent) and it
  // is dealt through the ordinary hand writer, so every entry is a real one-copy stack.
  {
    const opening=sim.hand();
    assert.deepEqual(opening.map(entry=>entry.id),["bpHouse","bpTower"],"a normal run must open with the seed kit: workers and the first tower");
    assert.equal(opening.every(entry=>entry.count===1&&entry.charges===null),true,"a seeded card must be an ordinary untouched stack");
    assert.equal(opening.every(entry=>cardCatalog.cardById[entry.id].category==="build"),true);
    assert.equal(sim.initializeRunMode("normal"),undefined);
    assert.deepEqual(sim.hand().map(entry=>entry.id),opening.map(entry=>entry.id),"re-initializing a run must not deal the opening kit twice");
  }
  assert.throws(()=>sim.initializeRunMode("invalid"),/invalid run mode/);
  // Ring spawning: every manual spawn lands near ENEMY_SPAWN_RADIUS of the base, preferring land.
  for(let i=0;i<8;i++){
    assert.equal(sim.spawnEnemy("raider"),undefined,"manual spawn command changed its return contract");const enemy=sim.state.enemies.at(-1);
    const radius=Math.hypot(enemy.x-data.BASE.x,enemy.y-data.BASE.y);
    assert.ok(radius>=data.ENEMY_SPAWN_RADIUS*.89&&radius<=data.ENEMY_SPAWN_RADIUS*1.11,`spawn radius ${radius.toFixed(0)} escaped the ring band`);
    assert.equal(sim.terrainAtWorldPoint(enemy.x,enemy.y),am.LAND,"manual enemy began in water on a map with land on the ring");
    assert.equal(enemy.waveNightNumber,undefined,"manual spawn silently joined a scheduled wave");
  }
  for(const enemy of [...sim.state.enemies]){
    const before=Math.hypot(enemy.x-data.BASE.x,enemy.y-data.BASE.y),variant=data.TOWER_VARIANTS.teleport,teleport={type:"tower",x:enemy.x,y:enemy.y,complete:true,pulse:0,tower:{variant:"teleport",cooldown:0,flash:0,hitFlash:0,hp:variant.maxHp,maxHp:variant.maxHp},hazard:null};sim.buildings.push(teleport);sim.update(.001);sim.buildings.splice(sim.buildings.indexOf(teleport),1);
    assert.ok(Math.hypot(enemy.x-data.BASE.x,enemy.y-data.BASE.y)>before+1,"teleport tower did not push the enemy radially away from the base");
  }
  const taggedEnemy=sim.state.enemies[0];assert.equal(sim.livingActiveWaveEnemies(),0);
  taggedEnemy.combatKind="invalid";assert.throws(()=>sim.validateSimulationInvariants(),/unknown combat kind/);taggedEnemy.combatKind="enemy";
  taggedEnemy.type="invalid";assert.throws(()=>sim.validateSimulationInvariants(),/unknown enemy type/);taggedEnemy.type="raider";
  taggedEnemy.waveNightNumber=0;assert.throws(()=>sim.validateSimulationInvariants(),/malformed wave membership/);delete taggedEnemy.waveNightNumber;sim.state.enemies.splice(1);
  const invalidDrop={kind:"invalid",x:100,y:100,groundY:100,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null};sim.resourceDrops.push(invalidDrop);assert.throws(()=>sim.validateSimulationInvariants(),/unknown resource drop kind/);sim.resourceDrops.pop();
  sim.state.runMode="invalid";assert.throws(()=>sim.update(1/60),/invalid run mode/);sim.state.runMode="normal";
  // The house is placed the only way a house can be placed now: by playing the bpHouse card the
  // opening kit dealt. There is no dock and no toggleBuildMode() to reach for.
  sim.DBG.freeCosts=true;const houseGrass=sim.grass.find(tuft=>sim.canPlace(tuft.x,tuft.y,"house")),houseSite=houseGrass&&{x:houseGrass.x,y:houseGrass.y};assert.ok(houseSite);sim.setPointerWorld(houseSite.x,houseSite.y);assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpHouse")),"targeting");assert.equal(sim.state.buildMode,"house");sim.primaryPress();sim.primaryRelease();assert.equal(sim.buildings.some(item=>item.type==="house"&&item.complete),true,"the bpHouse card did not stand a house");assert.equal(sim.grass.includes(houseGrass),false,"successful building placement did not clear overlapping grass");sim.DBG.instantWorkers=true;sim.update(1/60);const worker=sim.state.workers[0],workerOrigin={x:worker.x,y:worker.y};sim.setPointerWorld(worker.x,worker.y);sim.secondaryPress();assert.equal(sim.heldWorker(),worker);sim.pointerCancelled();assert.equal(worker.x,workerOrigin.x);assert.equal(worker.y,workerOrigin.y);assert.equal(sim.state.workers.includes(worker),true);assert.equal(worker.job,"free","a house-born worker must spawn free");assert.equal(worker.autonomous,true);sim.DBG.freeCosts=sim.DBG.instantWorkers=false;
  // Teardown: the pickup scaffolding must not leak an autonomous economy into the stress run below,
  // whose skill-budget checks assume the base is never fed before xp is granted explicitly.
  sim.state.workers.length=0;sim.buildings.length=0;sim.validateSimulationInvariants();

  // Startup is deterministic authored data; a fixed gameplay seed reproduces it exactly.
  const startupProgram=`
    let seed=0x41c6ce57;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
    const sim=await import("./src/game/simulation.js");
    console.log(JSON.stringify({chest:sim.chests.map(c=>[c.x,c.y,c.hp]),trees:sim.trees.map(n=>[n.x,n.y]).slice(0,8),rocks:sim.rocks.map(n=>[n.x,n.y]).slice(0,4),diamonds:sim.diamonds.map(n=>[n.x,n.y])}));
  `;
  const startupA=execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:startupProgram}).trim();
  const startupB=execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:startupProgram}).trim();
  assert.equal(startupA,startupB,"seeded startup drifted");
  const startupCounts=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:`
    import assert from "node:assert/strict";
    const sim=await import("./src/game/simulation.js");
    const targets=sim.terrainMetadata().targets;assert.equal(sim.trees.length,targets.treeCount);assert.equal(sim.rocks.length,targets.rockCount);assert.equal(sim.diamonds.length,targets.diamondCount);assert.equal(sim.chests.length,targets.chestCount);assert.equal(sim.grass.length,targets.grassCount);sim.validateSimulationInvariants();
    console.log(JSON.stringify({trees:sim.trees.length,rocks:sim.rocks.length,diamonds:sim.diamonds.length,chests:sim.chests.length,grass:sim.grass.length}));
  `}).trim());
  assert.deepEqual(startupCounts,{trees:authoredWorld.trees.length,rocks:authoredWorld.rocks.length,diamonds:authoredWorld.diamonds.length,chests:authoredWorld.chests.length,grass:authoredWorld.grass.length},"startup counts drifted from the authored map");

  const terrainPlacementResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:`
    import assert from "node:assert/strict";
    import * as sim from "./src/game/simulation.js";import * as data from "./src/game/data.js";import {cellToWorld,footprintWorldRect} from "./src/game/grid.js";
    sim.initializeRunMode("normal");
    let water=null,shore=null;
    for(let cy=2;cy<data.GRID_ROWS-2;cy++)for(let cx=2;cx<data.GRID_COLS-2;cx++){
      const p=cellToWorld(cx,cy),one=footprintWorldRect(cx,cy,data.FOOTPRINT_1x1),three=footprintWorldRect(cx,cy,data.FOOTPRINT_3x3);
      if(!water&&!sim.terrainWorldRectEntirelyOnLand(one)&&p.x>data.BUILD_MARGIN&&p.y>data.BUILD_MARGIN&&p.x<data.W-data.BUILD_MARGIN&&p.y<data.H-data.BUILD_MARGIN)water={cx,cy,...p};
      if(!shore&&sim.terrainWorldRectEntirelyOnLand(one)&&!sim.terrainWorldRectEntirelyOnLand(three))shore={cx,cy,...p};
    }
    assert.ok(water&&shore);assert.equal(sim.canPlace(water.x,water.y,"house"),false);assert.equal(sim.canPlace(0,0,"house"),false);assert.equal(sim.canPlace(shore.x,shore.y,"tower"),false,"3x3 footprint ignored neighboring water");
    const chest=sim.chests[0],chestOrigin={x:chest.x,y:chest.y};sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();assert.equal(sim.heldChest(),chest);sim.setPointerWorld(water.x,water.y);sim.secondaryRelease();assert.deepEqual({x:chest.x,y:chest.y},chestOrigin,"chest relocated onto water");
    sim.trees.length=sim.rocks.length=sim.diamonds.length=sim.chests.length=sim.buildings.length=0;
    let origin=null;for(let cy=3;cy<data.GRID_ROWS-3&&!origin;cy++)for(let cx=3;cx<data.GRID_COLS-3;cx++){const p=cellToWorld(cx,cy);if(sim.canPlace(p.x,p.y,"tower")){origin=p;break;}}assert.ok(origin);
    const zero=()=>({wood:0,stone:0,dust:0,coin:0,diamond:0}),shock={type:"tower",x:origin.x,y:origin.y,complete:true,cost:{},delivered:{wood:0,stone:0},storage:zero(),upgrades:{},activeUpgrade:null,tower:{variant:"shock",cooldown:3,flash:0,hitFlash:0,hp:12,maxHp:15},hazard:null,pulse:0};sim.buildings.push(shock);
    sim.setPointerWorld(shock.x,shock.y);sim.secondaryPress();assert.equal(sim.heldBuilding(),shock);sim.setPointerWorld(shore.x,shore.y);sim.secondaryRelease();assert.deepEqual({x:shock.x,y:shock.y},origin,"Shock tower relocated across water");assert.equal(shock.tower.cooldown,3);sim.validateSimulationInvariants();
    console.log(JSON.stringify({water:[water.cx,water.cy],shore:[shore.cx,shore.cy]}));
  `}).trim());
  assert.equal(terrainPlacementResult.water.length,2);


  const chestResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import * as data from "./src/game/data.js";
      import {snapToCellCenter} from "./src/game/grid.js";
      const oldRandom=Math.random;
      const counts=()=>Object.fromEntries(data.RESOURCE_KINDS.map(kind=>[kind,0]));
      const carried=()=>data.RESOURCE_KINDS.reduce((sum,kind)=>sum+sim.state.carried[kind],0);
      const makeWorker=(x,y)=>({x,y,postX:x,postY:y,spawnSource:null,job:"guard",jobTarget:null,autonomous:false,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:counts(),hp:data.WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0});
      const hit=()=>{sim.primaryPress();sim.update(.02);sim.primaryRelease();};
      try{
        sim.initializeRunMode("normal");sim.TUNE.chopTime=.01;
        const chest=sim.chests[0],seedOrigin={x:chest.x,y:chest.y};
        assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).kind,"break-chest");assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).icon,"axe");
        const overlapTree={x:chest.x,y:chest.y,hp:3,max:3,stump:0,shake:0,variant:0,footprint:data.RESOURCE_FOOTPRINT};sim.trees.push(overlapTree);sim.spawnEnemy("raider");const overlapEnemy=sim.state.enemies.at(-1);overlapEnemy.x=chest.x;overlapEnemy.y=chest.y;assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).target,overlapEnemy,"enemy must outrank chest");sim.state.enemies.splice(sim.state.enemies.indexOf(overlapEnemy),1);assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).target,chest,"chest must outrank resource");sim.chests.splice(sim.chests.indexOf(chest),1);assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).target,overlapTree);sim.chests.push(chest);sim.trees.splice(sim.trees.indexOf(overlapTree),1);
        sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();assert.equal(sim.heldChest(),chest);assert.equal(sim.chests.includes(chest),false);sim.validateSimulationInvariants();
        let valid=null;for(let y=64;y<data.H-64&&!valid;y+=data.CELL)for(let x=64;x<data.W-64;x+=data.CELL)if((x!==seedOrigin.x||y!==seedOrigin.y)&&sim.canPlace(x,y,null,null,null,chest)){valid={x,y};break;}assert.ok(valid);
        sim.setPointerWorld(valid.x+3,valid.y+3);sim.secondaryRelease();assert.deepEqual({x:chest.x,y:chest.y},snapToCellCenter(valid.x+3,valid.y+3));assert.equal(sim.chests.includes(chest),true);assert.equal(sim.canPlace(chest.x,chest.y,"house"),false);const placed={x:chest.x,y:chest.y};
        const occupied=sim.trees.find(t=>t.stump<=0);sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();sim.setPointerWorld(occupied.x,occupied.y);sim.secondaryRelease();assert.deepEqual({x:chest.x,y:chest.y},placed,"occupied release must restore exact origin");
        sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();sim.setPointerOutside();sim.secondaryRelease();assert.deepEqual({x:chest.x,y:chest.y},placed,"outside release must restore exact origin");
        sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();sim.pointerCancelled();assert.deepEqual({x:chest.x,y:chest.y},placed);assert.equal(sim.chests.includes(chest),true);
        sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();sim.windowBlurred();assert.deepEqual({x:chest.x,y:chest.y},placed);assert.equal(sim.chests.includes(chest),true);
        sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();sim.openSkillTree();assert.deepEqual({x:chest.x,y:chest.y},placed);assert.equal(sim.chests.includes(chest),true);sim.closeSkillTree();
        const shock={type:"tower",x:chest.x,y:chest.y,complete:true,cost:{},delivered:{wood:0,stone:0},storage:counts(),upgrades:{},activeUpgrade:null,tower:{variant:"shock",cooldown:0,flash:0,hitFlash:0,hp:15,maxHp:15},hazard:null,pulse:0},overlapWorker=makeWorker(chest.x,chest.y);sim.buildings.push(shock);sim.state.workers.push(overlapWorker);sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();assert.equal(sim.heldWorker(),overlapWorker,"worker must outrank tower and chest");sim.pointerCancelled();sim.state.workers.splice(sim.state.workers.indexOf(overlapWorker),1);sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();assert.equal(sim.heldBuilding(),shock,"movable tower must outrank chest");sim.pointerCancelled();sim.buildings.splice(sim.buildings.indexOf(shock),1);sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();assert.equal(sim.heldChest(),chest,"chest must follow worker and tower priority");sim.pointerCancelled();
        sim.setPointerWorld(chest.x,chest.y);sim.secondaryPress();const beforeBuildCount=sim.buildings.length,beforeHeldHp=chest.hp;assert.equal(sim.debugDealCard("bpHouse"),true);assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpHouse")),false,"a card must not arm a placement while a chest is held");assert.equal(sim.state.buildMode,null);sim.primaryPress();sim.update(1);sim.primaryRelease();assert.equal(sim.buildings.length,beforeBuildCount,"primary/build overlap placed while chest held");assert.equal(chest.hp,beforeHeldHp);sim.pointerCancelled();assert.deepEqual({x:chest.x,y:chest.y},placed);sim.validateSimulationInvariants();
        sim.resourceDrops.length=0;for(const kind of data.RESOURCE_KINDS)sim.state.carried[kind]=0;sim.state.capacity=2;sim.debugForceNextChestOutcome("cache");Math.random=()=>0;sim.setPointerWorld(chest.x,chest.y);
        sim.primaryPress();sim.update(.005);sim.setPointerOutside();sim.update(.02);sim.setPointerWorld(chest.x,chest.y);sim.update(.005);sim.primaryRelease();assert.equal(chest.hp,4,"leaving target must reset hold progress");
        for(let i=0;i<3;i++){hit();assert.equal(chest.hp,3-i);assert.equal(sim.resourceDrops.length,0);assert.equal(carried(),0);}
        hit();assert.equal(sim.chests.includes(chest),false);assert.equal(carried(),0,"chest rewards must never enter the hand directly");assert.equal(sim.resourceDrops.length,data.CHEST.cachePayout);assert.equal(sim.resourceDrops.every(d=>d.ttl===null&&d.target===null&&data.RESOURCE_KINDS.includes(d.kind)),true);assert.equal(chest.outcome,undefined);assert.equal(chest.contents,undefined);assert.ok(sim.damageNumbers.filter(n=>n.x===chest.x&&n.y===chest.y).length>=4);
        const cacheTotal=sim.resourceDrops.length;assert.notEqual(sim.resolvePrimaryAction(chest.x,chest.y)?.target,chest,"destroyed chest remained targetable");assert.equal(sim.resourceDrops.length,cacheTotal);
        const fullCache={x:chest.x,y:chest.y,hp:data.CHEST.maxHp,max:data.CHEST.maxHp,shake:0,footprint:data.CHEST.footprint};sim.chests.push(fullCache);sim.resourceDrops.length=0;for(const kind of data.RESOURCE_KINDS)sim.state.carried[kind]=0;sim.state.capacity=5;sim.state.carried.wood=5;sim.debugForceNextChestOutcome("cache");Math.random=()=>0;sim.setPointerWorld(fullCache.x,fullCache.y);for(let i=0;i<4;i++)hit();assert.equal(carried(),5,"existing hand contents must remain unchanged");assert.equal(sim.resourceDrops.length,data.CHEST.cachePayout,"cache must drop all five resources regardless of hand capacity");assert.equal(sim.resourceDrops.every(d=>d.ttl===null&&d.target===null),true);
        const pinata={x:chest.x,y:chest.y,hp:data.CHEST.maxHp,max:data.CHEST.maxHp,shake:0,footprint:data.CHEST.footprint};sim.chests.push(pinata);sim.resourceDrops.length=0;for(const kind of data.RESOURCE_KINDS)sim.state.carried[kind]=0;sim.debugForceNextChestOutcome("pinata");Math.random=()=>.9;sim.setPointerWorld(pinata.x,pinata.y);for(let i=0;i<4;i++)hit();
        assert.equal(sim.chests.includes(pinata),false);assert.equal(carried(),0);assert.equal(sim.resourceDrops.length,data.CHEST.pinataPayout);assert.equal(sim.resourceDrops.every(d=>d.kind==="coin"&&d.ttl===null),true,"chest coins must be permanent");assert.ok(Math.max(...sim.resourceDrops.map(d=>sim.distance(d.x,d.y,pinata.x,pinata.y)))>50,"pinata did not scatter widely");const pinataTotal=sim.resourceDrops.length;assert.notEqual(sim.resolvePrimaryAction(pinata.x,pinata.y)?.target,pinata);assert.equal(sim.resourceDrops.length,pinataTotal);sim.validateSimulationInvariants();
        console.log(JSON.stringify({checks:51,cache:cacheTotal,fullCache:data.CHEST.cachePayout,pinata:pinataTotal}));
      }finally{Math.random=oldRandom;}
    `
  }).trim());
  assert.equal(chestResult.cache,data.CHEST.cachePayout);assert.equal(chestResult.pinata,data.CHEST.pinataPayout);

  // Chain lightning: the buff turns a completed swing into full extra swings (own crit rolls) that
  // cross freely between enemies and resources; the lightning tower chains its authored damage
  // between combat targets only. Math.random()=>0 forces the proc AND every crit deterministically.
  const chainResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import * as data from "./src/game/data.js";
      const oldRandom=Math.random;
      const enemy=(x,y)=>({combatKind:"enemy",type:"raider",x,y,hp:5,max:5,attackCooldown:0,healCooldown:1,wob:0,flash:0,shotFlash:0,healFlash:0,status:{burn:null,slow:null},retaliationTower:null});
      const swing=()=>{sim.primaryPress();sim.update(.02);sim.primaryRelease();};
      try{
        sim.initializeRunMode("normal");sim.TUNE.chopTime=.01;Math.random=()=>0;
        sim.trees.length=sim.rocks.length=sim.diamonds.length=sim.chests.length=sim.buildings.length=sim.resourceDrops.length=0;sim.state.enemies.length=sim.state.workers.length=0;
        // A hand-built arena east of the base. Distances author the jump order: from A the tree (40)
        // outranks B (105); from the tree only B (65) is in the 120 reach (C sits 125 away); from B,
        // C (60); from C, D (60) — and D back to A is 165, out of reach, so 4 jumps is the ceiling.
        const bx=data.BASE.x,by=data.BASE.y;
        const tree={x:bx+256,y:by,hp:3,max:3,stump:0,shake:0,variant:0,footprint:data.RESOURCE_FOOTPRINT};sim.trees.push(tree);
        const a=enemy(bx+216,by),b=enemy(bx+321,by),c=enemy(bx+381,by),d=enemy(bx+441,by);sim.state.enemies.push(a,b,c,d);
        // Stacks applied through the debug dealer command — the same applyBuff() path a draft takes.
        // Jumps EQUAL stacks (chance rises alongside, forced here by the zero roll).
        assert.equal(sim.debugApplyBuff("bpHouse"),false,"debugApplyBuff must reject non-buffs");
        for(const id of ["chainLightning","chainLightning","critClicks"])assert.equal(sim.debugApplyBuff(id),true);
        assert.equal(sim.buffStacks("chainLightning"),2);
        sim.setPointerWorld(a.x,a.y);swing();
        assert.equal(sim.lightningArcs.length,2,"two stacks must yield exactly two jumps");
        assert.equal(a.hp,2,"the initial swing must land a full x3 crit");
        assert.equal(tree.hp,2,"the chain must strike the resource node");
        assert.equal(sim.resourceDrops.filter(d=>d.kind==="wood").length,2,"a chained crit chop must add its bonus drop");
        assert.equal(b.hp,2,"a chained combat hit must deal full crit damage");
        assert.equal(c.hp,5,"a two-jump chain must not reach the third target");
        // At the 4-stack cap the same swing runs the full chain: tree, B, C, D.
        for(const id of ["chainLightning","chainLightning"])assert.equal(sim.debugApplyBuff(id),true);
        a.hp=b.hp=c.hp=d.hp=5;
        let arcsBefore=sim.lightningArcs.length;swing();
        assert.equal(sim.lightningArcs.length-arcsBefore,4,"four stacks must yield exactly four jumps");
        assert.equal(b.hp,2);assert.equal(c.hp,2);assert.equal(d.hp,2,"the capped chain must reach the fourth jump");
        // One stack: a single jump into the tree, nothing further.
        a.hp=b.hp=c.hp=d.hp=5;sim.state.draft.buffs.chainLightning=1;
        arcsBefore=sim.lightningArcs.length;swing();
        assert.equal(sim.lightningArcs.length-arcsBefore,1,"one stack must yield exactly one jump");
        assert.equal(b.hp,5,"a one-jump chain must stop at the resource node");
        // The tower: authored damage on the aimed target plus chainJumps more, combat targets only —
        // the tree sits nearest to A and must be skipped in favor of B, then C, then D.
        delete sim.state.draft.buffs.chainLightning;delete sim.state.draft.buffs.critClicks;
        a.hp=b.hp=c.hp=d.hp=5;const treeHp=tree.hp;
        const variant=data.TOWER_VARIANTS.lightning;
        sim.buildings.push({type:"tower",x:bx+116,y:by,complete:true,pulse:0,tower:{variant:"lightning",cooldown:0,flash:0,hitFlash:0,hp:variant.maxHp,maxHp:variant.maxHp},hazard:null});
        const towerArcsBefore=sim.lightningArcs.length;sim.update(.001);
        assert.equal(sim.lightningArcs.length-towerArcsBefore,1+variant.chainJumps,"tower bolt must strike its target and every chained foe");
        assert.equal(a.hp,3);assert.equal(b.hp,3);assert.equal(c.hp,3);assert.equal(d.hp,3);
        assert.equal(tree.hp,treeHp,"the tower chain must never strike resources");
        assert.ok(sim.buildings[0].tower.cooldown>0,"the strike must consume the tower cooldown");
        sim.validateSimulationInvariants();
        // Arcs are transient run state: they age out on their own and a mode reset clears them.
        for(let i=0;i<30;i++)sim.update(1/60);
        assert.equal(sim.lightningArcs.length,0,"arcs must age out");
        console.log(JSON.stringify({checks:16,capJumps:4}));
      }finally{Math.random=oldRandom;}
    `
  }).trim());
  assert.equal(chainResult.capJumps,data.CARD_BUFFS.chainJumps+3);

  // Focused deterministic regressions run in a clean process so fixtures cannot leak into stress.
  const featureResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import * as data from "./src/game/data.js";
      import {cellToWorld} from "./src/game/grid.js";
      let seed=0x51a7;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      const counts=()=>({wood:0,stone:0,dust:0,coin:0,diamond:0});
      const building=(type,x,y,complete=true,cost={wood:1,stone:0})=>({type,x,y,complete,cost,delivered:counts(),storage:counts(),upgrades:{},activeUpgrade:null,plannedVariant:null,tower:null,hazard:null,pulse:0,starved:false});
      const worker=(job,target,x,y)=>({x,y,postX:x,postY:y+20,spawnSource:null,job,jobTarget:target,autonomous:false,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:counts(),hp:data.WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,guardSafeTime:0});
      const freeWorker=(x,y)=>({...worker("free",null,x,y),postY:y,autonomous:true});
      const drop=(kind,x,y)=>({kind,x,y,groundY:y,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null});
      // Every scenario starts on a fresh day: none of them steps far enough to reach dusk, so no
      // dawn reward can freeze the world in the middle of a worker measurement.
      // A pending draft offer freezes the whole world, so any scenario that crosses a real dawn
      // clears the reward it just earned before it measures anything else.
      const clearDraft=()=>{sim.state.draft.queue=0;sim.state.draft.dawnQueue=0;sim.state.draft.offer=null;sim.state.draft.offerKind=null;sim.state.draftPaused=false;};
      const reset=()=>{sim.buildings.length=sim.resourceDrops.length=sim.chests.length=sim.state.workers.length=sim.state.enemies.length=sim.trees.length=sim.rocks.length=sim.diamonds.length=0;for(const kind of data.RESOURCE_KINDS)sim.state.stored[kind]=0;sim.state.clock.phase="day";sim.state.clock.remaining=data.DAY_DURATION;sim.state.paused=sim.state.gameOver=false;sim.state.coinTimer=99999;clearDraft();Object.assign(sim.state.nightWave,{activePlan:null,threatBudget:0,spawnedThreat:0,totalSpawns:0,remainingSpawns:0,elapsed:0,nextSpawnAt:0,activeNightNumber:null});sim.DBG.groundSourcing=sim.DBG.builderSelfSupply=true;sim.DBG.instantWorkers=false;sim.TUNE.builderSourceRadius=300;sim.TUNE.freeSearchRadius=200;sim.TUNE.fleeHpThreshold=1;};
      // Night without a wave: a positive spawn budget that is never due keeps the clearance check
      // from auto-dawning the moment the phase flips, so night behavior can be measured on its own.
      const holdNight=()=>{sim.state.clock.phase="night";sim.state.nightWave.remainingSpawns=1;sim.state.nightWave.nextSpawnAt=1e9;};
      const step=(n=1)=>{for(let i=0;i<n;i++)sim.update(1/60);};
      // The free-worker scheduler sweeps every .5 simulated seconds with no debug gate; stepping a
      // little past one window guarantees at least one sweep without assuming where it lands.
      const sweep=()=>step(31);
      try{
        sim.initializeRunMode("normal");
        assert.deepEqual(Object.entries(data.BUILDING_TYPES).filter(([,def])=>def.jobSlots).map(([type,def])=>[type,def.jobSlots]),[["lumber",2],["quarry",2],["stockpile",2],["garrison",3]]);assert.equal(data.RESOURCE_NODE_JOB_SLOTS,1);
        assert.deepEqual(Object.fromEntries(Object.entries(data.BUILDING_TYPES).map(([type,def])=>[type,def.buildSlots])),{lumber:2,quarry:3,stockpile:2,house:2,obelisk:3,tower:3,captureYard:3,garrison:2,blast:0,spikes:0,landmine:0,tar:0,damageOrbs:0,summoningCircle:0,meteorTarget:0});
        assert.equal(sim.DBG.groundSourcing,true);assert.equal(sim.TUNE.builderSourceRadius,400);
        reset();{const site=building("lumber",100,100,false),store=building("stockpile",110,100);store.storage.wood=3;const loose=drop("wood",104,100),builder=worker("build",site,100,100);sim.buildings.push(site,store);sim.resourceDrops.push(loose);sim.state.workers.push(builder);sim.DBG.groundSourcing=false;step();assert.equal(builder.taskTarget,null);assert.ok(builder.carried.wood>0);assert.equal(loose.claimedBy,undefined);}
        reset();{const site=building("lumber",100,100,false),store=building("stockpile",110,100);store.storage.wood=3;const loose=drop("wood",130,100),builder=worker("build",site,100,100);sim.buildings.push(site,store);sim.resourceDrops.push(loose);sim.state.workers.push(builder);sim.DBG.groundSourcing=true;step();assert.equal(builder.taskTarget,loose);assert.equal(loose.claimedBy,builder);assert.equal(store.storage.wood,3);sim.DBG.groundSourcing=false;sim.TUNE.builderSourceRadius=60;step();assert.equal(builder.taskTarget,loose);}
        reset();{const site=building("lumber",100,100,false),store=building("stockpile",110,100);store.storage.wood=1;const builder=worker("build",site,100,100);sim.buildings.push(site,store);sim.state.workers.push(builder);sim.DBG.groundSourcing=true;step();assert.equal(builder.carried.wood,1);}
        reset();{const site=building("tower",100,100,false,{wood:0,stone:0,dust:1}),store=building("stockpile",110,100),builder=worker("build",site,100,100);store.storage.dust=1;sim.buildings.push(site,store);sim.state.workers.push(builder);step();assert.equal(builder.carried.dust,1,"builders must haul variant materials");step();assert.equal(site.complete,true,"variant material did not finish the one tower build");}
        reset();{const site=building("lumber",100,100,false),builder=worker("build",site,100,100);sim.buildings.push(site);sim.state.workers.push(builder);step();assert.equal(builder.starved,true);}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);step();assert.equal(builder.job,"build");assert.equal(builder.jobTarget,site);assert.equal(builder.selfSupply.node,tree);step(600);assert.equal(site.complete,true);assert.equal(site.delivered.wood,1);assert.equal(builder.job,"staff","manual builder must inherit the durable post it stood up");assert.equal(builder.jobTarget,site);assert.equal(builder.autonomous,false);assert.equal(builder.selfSupply,null);assert.equal(sim.resourceDrops.some(item=>item.claimedBy===builder),false);}
        reset();{const site=building("tower",100,100,false,{wood:1,stone:1}),tree={x:190,y:100,hp:3,max:3,stump:0,shake:0},rock={x:130,y:100,hp:3,max:3,depleted:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.rocks.push(rock);sim.state.workers.push(builder);step();assert.deepEqual(builder.selfSupply,{kind:"stone",node:rock},"nearest needed node must win across kinds");}
        reset();{const site=building("tower",100,100,false,{wood:1,stone:1}),tree={x:130,y:100,hp:3,max:3,stump:0,shake:0},rock={x:190,y:100,hp:3,max:3,depleted:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.rocks.push(rock);sim.state.workers.push(builder);step();assert.deepEqual(builder.selfSupply,{kind:"wood",node:tree},"nearest needed node must win across kinds");}
        reset();{const site=building("tower",100,100,false,{wood:2,stone:0}),tree={x:170,y:100,hp:6,max:6,stump:0,shake:0},a=worker("build",site,100,100),b=worker("build",site,102,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(a,b);step();assert.ok(a.selfSupply||b.selfSupply);assert.equal([a,b].filter(item=>item.selfSupply).length,1,"node/self-supply reservation duplicated");step(700);assert.equal(site.delivered.wood,site.cost.wood);assert.equal(site.complete,true,"builders must reselect without over-delivery");}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);step(90);assert.ok(builder.selfSupply);sim.setPointerWorld(builder.x,builder.y);sim.secondaryPress();assert.equal(builder.selfSupply,null);assert.equal(sim.resourceDrops.some(item=>item.claimedBy===builder),false);sim.pointerCancelled();}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);step(90);builder.hp=1;sim.spawnEnemy("healer");const danger=sim.state.enemies[0];danger.x=builder.x+5;danger.y=builder.y;step();assert.equal(builder.fleeing,true);assert.equal(builder.selfSupply,null);assert.equal(sim.resourceDrops.some(item=>item.claimedBy===builder),false);assert.equal(builder.job,"build");assert.equal(builder.jobTarget,site);}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);sim.DBG.builderSelfSupply=false;step();assert.equal(builder.starved,true);assert.equal(builder.selfSupply,null);assert.equal(builder.x,100);assert.ok(builder.y>100&&builder.y<=builder.postY);}
        reset();{const site=building("lumber",100,100,false),loose=drop("wood",105,100),builder=worker("build",site,100,100);sim.buildings.push(site);sim.resourceDrops.push(loose);sim.state.workers.push(builder);sim.DBG.groundSourcing=true;step();assert.equal(builder.taskTarget,loose);}
        reset();{const site=building("lumber",100,100,false,{wood:2,stone:0}),a=worker("build",site,100,100),b=worker("build",site,101,100),one=drop("wood",104,100),two=drop("wood",106,100);sim.buildings.push(site);sim.resourceDrops.push(one,two);sim.state.workers.push(a,b);sim.DBG.groundSourcing=true;step();assert.ok(a.taskTarget&&b.taskTarget);assert.notEqual(a.taskTarget,b.taskTarget);step(500);assert.ok(site.delivered.wood<=site.cost.wood);assert.equal(site.complete,true);assert.equal(a.job,"staff");assert.equal(a.jobTarget,site);}
        reset();{const site=building("lumber",100,100,false),a=worker("build",site,100,100),b=worker("build",site,101,100),c=worker("build",site,102,100);a.carried.wood=1;sim.buildings.push(site);sim.state.workers.push(a,b,c);step();assert.equal(site.complete,true);assert.equal(sim.workerOccupancyStatus(site).assigned,2);assert.deepEqual([a,b,c].map(item=>item.job).sort(),["free","staff","staff"],"the over-capacity manual builder must return to free, never guard");const spare=[a,b,c].find(item=>item.job==="free");assert.equal(spare.jobTarget,null);assert.equal(spare.autonomous,true);}
        // Durable posts are no longer auto-filled: a completed camp with vacancies stays vacant until
        // the player staffs it, and a newborn worker is free rather than posted to the nearest job.
        reset();{const house=building("house",500,500),near=building("lumber",560,500),far=building("stockpile",700,500);house.spawnTimer=0;sim.buildings.push(house,near,far);sim.DBG.instantWorkers=true;step();const born=sim.state.workers[0];assert.equal(born.job,"free");assert.equal(born.jobTarget,null);assert.equal(born.autonomous,true);sweep();assert.equal(sim.durablePostStatus(near).assigned,0,"idle workers must not fill durable posts autonomously");assert.equal(sim.durablePostStatus(far).assigned,0);assert.equal(sim.state.workers.every(item=>item.job==="free"),true);}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const first=building("lumber",300,300),second=building("quarry",600,300),staff=worker("staff",first,first.x,first.y+16);staff.postX=first.x;staff.postY=first.y+16;sim.buildings.push(first,second);sim.state.workers.push(staff);step();assert.equal(sim.durablePostStatus(first).arrived,1);sim.setPointerWorld(staff.x,staff.y);sim.secondaryPress();sim.setPointerWorld(second.x,second.y);sim.secondaryRelease();assert.equal(staff.jobTarget,second);assert.equal(sim.durablePostStatus(first).assigned,0);assert.equal(sim.durablePostStatus(second).arrived,0);step();assert.equal(sim.durablePostStatus(second).arrived,0);step(600);assert.equal(sim.durablePostStatus(second).arrived,1);}
        reset();{const site=building("lumber",300,300,false),builder=worker("build",site,site.x,site.y);builder.carried.wood=1;sim.buildings.push(site);sim.state.workers.push(builder);step();assert.equal(site.complete,true);assert.equal(builder.jobTarget,site);assert.equal(sim.durablePostStatus(site).arrived,0);step(20);assert.equal(sim.durablePostStatus(site).arrived,1);}
        reset();{const house=building("house",500,500);house.spawnTimer=0;sim.buildings.push(house);sim.DBG.instantWorkers=true;step();const born=sim.state.workers[0];assert.equal(born.job,"free");assert.equal(born.jobTarget,null);assert.equal(born.autonomous,true);assert.equal(born.spawnSource,house);assert.equal(born.postX,house.x);assert.equal(born.postY,house.y+23);step(5);assert.equal(sim.state.workers.length,data.HOUSE_SLOTS,"a completed house must fill exactly its authored slots");assert.equal(sim.state.workers.every(item=>item.job==="free"&&item.autonomous),true);}
        reset();{const house=building("house",500,500),camp=building("lumber",550,500);house.spawnTimer=0;const staff=worker("staff",camp,camp.x,camp.y+16);staff.spawnSource=house;staff.postX=camp.x;staff.postY=camp.y+16;sim.buildings.push(house,camp);sim.state.workers.push(staff);sim.setPointerWorld(staff.x,staff.y);sim.secondaryPress();assert.equal(sim.heldWorker(),staff);assert.equal(sim.durablePostStatus(camp).assigned,1,"a held staffer must keep its slot reserved");sim.DBG.instantWorkers=true;step();assert.equal(sim.durablePostStatus(camp).assigned,1,"a newborn must not take the held worker's post");assert.equal(sim.state.workers.at(-1).job,"free");sim.pointerCancelled();}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const tree={x:200,y:200,hp:3,max:3,stump:0};sim.trees.push(tree);const first=worker("harvest",{node:tree,kind:"wood"},200,200),held=freeWorker(210,200);sim.state.workers.push(first,held);assert.deepEqual(sim.workerOccupancyStatus(tree),{target:tree,assigned:1,capacity:1});assert.equal(sim.workerAssignmentAt(held,tree.x,tree.y),null);sim.setPointerWorld(first.x,first.y);sim.secondaryPress();assert.equal(sim.workerOccupancyStatus(tree).assigned,1);assert.ok(sim.workerAssignmentAt(first,tree.x,tree.y));sim.pointerCancelled();}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const one={x:200,y:200,hp:3,max:3,stump:0},two={x:240,y:200,hp:3,max:3,stump:0};sim.trees.push(one,two);const a=worker("harvest",{node:one,kind:"wood"},200,200),b=worker("harvest",{node:null,kind:"wood"},220,200);sim.state.workers.push(a,b);step();assert.equal(b.jobTarget.node,two);assert.equal(sim.workerOccupancyStatus(one).assigned,1);assert.equal(sim.workerOccupancyStatus(two).assigned,1);}
        reset();{const camp=building("lumber",300,300),a=worker("staff",camp,300,316),b=worker("staff",camp,301,316),held=freeWorker(310,300);sim.buildings.push(camp);sim.state.workers.push(a,b,held);assert.equal(sim.workerOccupancyStatus(camp).assigned,2);assert.equal(sim.workerAssignmentAt(held,camp.x,camp.y),null);sim.setPointerWorld(a.x,a.y);sim.secondaryPress();assert.equal(sim.workerOccupancyStatus(camp).assigned,2);assert.ok(sim.workerAssignmentAt(a,camp.x,camp.y));sim.pointerCancelled();}
        reset();{const site=building("tower",300,300,false),a=worker("build",site,300,320),b=worker("build",site,301,320),c=worker("build",site,302,320),held=freeWorker(310,300);sim.buildings.push(site);sim.state.workers.push(a,b,c,held);assert.deepEqual(sim.workerOccupancyStatus(site),{target:site,assigned:3,capacity:3});assert.equal(sim.workerAssignmentAt(held,site.x,site.y),null);sim.setPointerWorld(a.x,a.y);sim.secondaryPress();assert.equal(sim.workerOccupancyStatus(site).assigned,3);assert.ok(sim.workerAssignmentAt(a,site.x,site.y));sim.pointerCancelled();assert.equal(sim.debugApplyBuff("buildCapacity"),true);assert.equal(sim.workerOccupancyStatus(site).capacity,4);assert.ok(sim.workerAssignmentAt(held,site.x,site.y));delete sim.state.draft.buffs.buildCapacity;}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const tree={x:200,y:200,hp:3,max:3,stump:0},camp=building("lumber",232,200),far=building("quarry",264,200);sim.trees.push(tree);sim.buildings.push(far,camp);assert.equal(sim.workerOccupancyAt(camp.x,camp.y).target,camp);assert.equal(sim.workerOccupancyAt(far.x,far.y).target,far);tree.stump=1;sim.buildings.length=0;assert.equal(sim.workerOccupancyAt(tree.x,tree.y),null);}
        // ── the free-worker scheduler: bounded autonomous job selection ──
        assert.equal(sim.TUNE.freeSearchRadius,200);
        // Same-tier strict priority: a blueprint outranks a nearer covered drop and a nearby node.
        reset();{const site=building("lumber",300,300,false,{wood:99,stone:0}),store=building("stockpile",360,300),tree={x:270,y:300,hp:9,max:9,stump:0,shake:0},loose=drop("wood",310,330),idle=freeWorker(300,340);sim.buildings.push(site,store);sim.trees.push(tree);sim.resourceDrops.push(loose);sim.state.workers.push(idle);sweep();assert.equal(idle.job,"build","construction must outrank hauling and gathering in one tier");assert.equal(idle.jobTarget,site);assert.equal(idle.autonomous,true);}
        // Tier precedence: a haulable drop in the local tier beats a blueprint in the expanded tier.
        reset();{const site=building("lumber",580,300,false,{wood:99,stone:0}),store=building("stockpile",300,300),loose=drop("wood",320,300),idle=freeWorker(400,300);sim.buildings.push(site,store);sim.resourceDrops.push(loose);sim.state.workers.push(idle);sweep();assert.equal(idle.job,"haul","local hauling must beat expanded construction");assert.equal(idle.jobTarget,store);assert.equal(loose.claimedBy,idle,"the chosen drop must be reserved at assignment");assert.equal(idle.autonomous,true);}
        // Local gathering beats expanded construction: one tier is evaluated completely before expanding.
        reset();{const site=building("lumber",540,300,false,{wood:99,stone:0}),tree={x:440,y:300,hp:9,max:9,stump:0,shake:0},idle=freeWorker(340,300);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(idle);sweep();assert.equal(idle.job,"harvest","a local node must beat an expanded blueprint");assert.equal(idle.jobTarget.node,tree);assert.equal(idle.autonomous,true);}
        // The expanded tier is bounded by the tunable search radius and reaches past the local leash.
        reset();{const site=building("lumber",540,300,false,{wood:99,stone:0}),idle=freeWorker(340,300);sim.buildings.push(site);sim.state.workers.push(idle);sim.TUNE.freeSearchRadius=180;sweep();assert.equal(idle.job,"free","work beyond the expanded radius must stay out of reach");sim.TUNE.freeSearchRadius=200;sweep();assert.equal(idle.job,"build");assert.equal(idle.jobTarget,site);}
        // Nearest candidate wins; an exact-distance tie keeps stable collection order.
        reset();{const near={x:400,y:300,hp:9,max:9,stump:0,shake:0},far={x:410,y:300,hp:9,max:9,stump:0,shake:0},idle=freeWorker(300,300);sim.trees.push(far,near);sim.state.workers.push(idle);sweep();assert.equal(idle.jobTarget.node,near,"the nearest viable node must win");}
        reset();{const first={x:400,y:300,hp:9,max:9,stump:0,shake:0},second={x:200,y:300,hp:9,max:9,stump:0,shake:0},idle=freeWorker(300,300);sim.trees.push(first,second);sim.state.workers.push(idle);sweep();assert.equal(idle.jobTarget.node,first,"an exact-distance tie must keep collection order");}
        // Multiple free workers in one sweep spread across sites by proximity, honoring build capacity.
        reset();{const first=building("lumber",300,300,false,{wood:99,stone:0}),second=building("lumber",500,300,false,{wood:99,stone:0}),a=freeWorker(310,300),b=freeWorker(320,300),c=freeWorker(490,300);sim.buildings.push(first,second);sim.state.workers.push(c,b,a);sweep();assert.equal(sim.workerOccupancyStatus(first).assigned,2);assert.equal(sim.workerOccupancyStatus(second).assigned,1);assert.equal(c.jobTarget,second);assert.equal([a,b,c].every(item=>item.job==="build"&&item.autonomous),true);}
        // An autonomous builder joins a manually assigned one and full slots turn later workers away.
        reset();{const site=building("lumber",300,300,false,{wood:99,stone:0}),manual=worker("build",site,300,320),near=freeWorker(310,300),far=freeWorker(330,300);sim.buildings.push(site);sim.state.workers.push(manual,far,near);sweep();assert.equal(sim.workerOccupancyStatus(site).assigned,2);assert.equal([near,far].filter(item=>item.job==="build").length,1,"build slots must cap autonomous joiners");assert.equal([near,far].filter(item=>item.job==="free").length,1);assert.equal(manual.job,"build");assert.equal(manual.autonomous,false);}
        // Autonomous construction ends in free: the finished durable post is NOT inherited.
        reset();{const site=building("lumber",300,300,false),auto=worker("build",site,300,300);auto.autonomous=true;auto.carried.wood=1;sim.buildings.push(site);sim.state.workers.push(auto);step(20);assert.equal(site.complete,true);assert.equal(auto.job,"free","autonomous builders must not inherit the completed building's post");assert.equal(auto.jobTarget,null);assert.equal(sim.durablePostStatus(site).assigned,0);}
        // Autonomous hauling honors its reservation, collects a batch, deposits, then returns free.
        reset();{const store=building("stockpile",300,300),hauler=freeWorker(320,300);sim.buildings.push(store);sim.resourceDrops.push(drop("wood",330,300),drop("wood",340,300),drop("stone",350,300));sim.state.workers.push(hauler);sweep();assert.equal(hauler.job,"haul");assert.ok(hauler.taskTarget);step(900);assert.equal(store.storage.wood,2);assert.equal(store.storage.stone,1);assert.equal(hauler.job,"free","a deposited batch must end the autonomous haul");assert.equal(sim.resourceDrops.length,0);}
        // Manual builders of a post-less building (a tower has no durable job) also resolve to free.
        reset();{const site=building("tower",300,300,false,{wood:1,stone:0}),a=worker("build",site,300,300),b=worker("build",site,301,300);a.carried.wood=1;sim.buildings.push(site);sim.state.workers.push(a,b);step(20);assert.equal(site.complete,true);assert.deepEqual([a.job,b.job],["free","free"],"completing a post-less building must free its builders, not mint guards");}
        // One autonomous strike: the worker hits once, leaves the physical drop, and is free again.
        reset();{const tree={x:200,y:200,hp:5,max:5,stump:0,shake:0};sim.trees.push(tree);const gatherer=worker("harvest",{node:tree,kind:"wood"},200,220);gatherer.autonomous=true;gatherer.hitCooldown=0;sim.state.workers.push(gatherer);step();assert.equal(tree.hp,4);assert.equal(sim.resourceDrops.length,1);assert.equal(gatherer.job,"free","autonomous gathering is exactly one strike");}
        // An autonomous gather objective that dies before impact resolves to free with no yield.
        reset();{const tree={x:200,y:200,hp:5,max:5,stump:1,shake:0};sim.trees.push(tree);const gatherer=worker("harvest",{node:tree,kind:"wood"},200,220);gatherer.autonomous=true;gatherer.hitCooldown=0;sim.state.workers.push(gatherer);step();assert.equal(gatherer.job,"free");assert.equal(sim.resourceDrops.length,0,"an invalid node must not produce resources");}
        // Worker death frees the house slot; the replacement spawns free like every newborn.
        reset();{const house=building("house",500,500);house.spawnTimer=0;sim.buildings.push(house);sim.DBG.instantWorkers=true;step(6);assert.equal(sim.state.workers.length,data.HOUSE_SLOTS);const victim=sim.state.workers[0],corpsesBefore=sim.workerCorpses.length;victim.hp=2;sim.spawnEnemy("raider");const killer=sim.state.enemies[0];killer.x=victim.x;killer.y=victim.y;step();assert.equal(sim.state.workers.includes(victim),false,"production enemy hit did not kill the worker");assert.equal(sim.workerCorpses.length,corpsesBefore+1);sim.state.enemies.length=0;step();assert.equal(sim.state.workers.length,data.HOUSE_SLOTS,"death must free the slot for a replacement");assert.equal(sim.state.workers.every(item=>item.job==="free"),true);}
        // Lifting a worker releases its live drop reservation immediately.
        reset();{const store=building("stockpile",300,300),hauler=worker("haul",store,310,300),loose=drop("wood",330,300);hauler.autonomous=true;hauler.taskTarget=loose;loose.claimedBy=hauler;sim.buildings.push(store);sim.resourceDrops.push(loose);sim.state.workers.push(hauler);sim.setPointerWorld(hauler.x,hauler.y);sim.secondaryPress();assert.equal(sim.heldWorker(),hauler);assert.equal(loose.claimedBy,undefined,"a held worker may not keep a drop reserved");sim.pointerCancelled();}
        // A free worker in combat entanglement is not schedulable; a clean one beside it is.
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),combat=freeWorker(240,300),retaliating=freeWorker(320,340),returning=freeWorker(330,300),clean=freeWorker(340,300);sim.buildings.push(site);sim.state.workers.push(combat,retaliating,returning,clean);sim.spawnEnemy("healer");const pest=sim.state.enemies[0];pest.x=combat.x+data.WORKER_MELEE-4;pest.y=combat.y;combat.combatTarget=pest;retaliating.retaliationTarget=pest;returning.returnAfterCombat=true;returning.postY=600;sweep();assert.equal(clean.job,"build");assert.equal(combat.job,"free","a fighting worker must not be scheduled");assert.equal(retaliating.job,"free","a retaliating worker must not be scheduled");assert.equal(returning.job,"free","a worker returning from combat must not be scheduled");sim.state.enemies.length=0;}
        // Paused simulated time freezes the search cadence entirely.
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),idle=freeWorker(310,300);sim.buildings.push(site);sim.state.workers.push(idle);sim.togglePause();const elapsedBefore=sim.state.clock.elapsed;step(60);assert.equal(sim.state.clock.elapsed,elapsedBefore);assert.equal(idle.job,"free","the scheduler must not run under pause");sim.togglePause();sweep();assert.equal(idle.job,"build");}
        // Losing the objective mid-job frees the worker: a razed site and a vanished storage both resolve.
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),builder=worker("build",site,310,300),store=building("stockpile",600,300),hauler=worker("haul",store,610,300),loose=drop("wood",650,300);builder.autonomous=true;hauler.autonomous=true;hauler.taskTarget=loose;loose.claimedBy=hauler;sim.buildings.push(site,store);sim.resourceDrops.push(loose);sim.state.workers.push(builder,hauler);step();assert.equal(builder.job,"build");assert.equal(hauler.job,"haul");sim.buildings.splice(sim.buildings.indexOf(site),1);sim.buildings.splice(sim.buildings.indexOf(store),1);step();assert.equal(builder.job,"free");assert.equal(hauler.job,"free","a hauler whose destination vanished must return to free");assert.equal(loose.claimedBy,undefined,"a freed hauler may not keep its reservation");}
        // Fleeing interrupts the objective but never the assignment: claims release, the job survives.
        reset();{const tower=building("tower",120,100),site=building("lumber",300,300,false,{wood:99,stone:0}),builder=worker("build",site,200,100),claimed=drop("wood",202,100);tower.tower={variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:10,maxHp:10};builder.autonomous=true;builder.hp=1;builder.carried.dust=1;builder.taskTarget=claimed;builder.retaliationTarget={x:205,y:100};claimed.claimedBy=builder;sim.buildings.push(tower,site);sim.resourceDrops.push(claimed);sim.state.workers.push(builder);sim.spawnEnemy("healer");const danger=sim.state.enemies[0];danger.x=210;danger.y=100;const prior={job:builder.job,jobTarget:builder.jobTarget,carried:{...builder.carried}};step();assert.equal(builder.fleeing,true);assert.equal(builder.taskTarget,null);assert.equal(claimed.claimedBy,undefined);assert.equal(builder.job,prior.job);assert.equal(builder.jobTarget,prior.jobTarget);assert.deepEqual(builder.carried,prior.carried);assert.equal(builder.combatTarget,null);assert.equal(builder.retaliationTarget,null);const fledX=builder.x;step(10);assert.ok(builder.x<fledX);danger.x=700;danger.y=700;step(179);assert.equal(builder.fleeing,true);danger.x=builder.x+data.WORKER_LEASH+5;danger.y=builder.y;step();assert.equal(builder.fleeing,true,"danger inside recovery radius must reset safe time without causing fight/flee oscillation");assert.equal(builder.combatTarget,null);danger.x=700;danger.y=700;step(179);assert.equal(builder.fleeing,true);step(2);assert.equal(builder.fleeing,false);assert.equal(builder.job,prior.job);assert.equal(builder.jobTarget,prior.jobTarget);assert.deepEqual(builder.carried,prior.carried);assert.equal(builder.hp,1);}
        reset();{const lowStation=building("garrison",200,100),low=worker("guard",lowStation,200,100);low.hp=1;sim.buildings.push(lowStation);sim.state.workers.push(low);sim.spawnEnemy("healer");const danger=sim.state.enemies[0];danger.x=205;danger.y=100;step();assert.equal(low.fleeing,true);sim.setPointerWorld(low.x,low.y);sim.secondaryPress();assert.equal(sim.heldWorker(),low);sim.setPointerWorld(500,500);sim.secondaryRelease();assert.equal(low.fleeing,false);assert.equal(low.fleeSafeTime,0);assert.deepEqual([low.x,low.y],[500,500]);assert.equal(low.job,"free","open ground must REPOSITION the worker as free, never mint a guard");assert.equal(low.jobTarget,null);assert.equal(low.autonomous,true);assert.equal(sim.durablePostStatus(lowStation).assigned,0,"leaving the garrison must release its reserved slot");}
        reset();{const healthyStation=building("garrison",200,100),healthy=worker("guard",healthyStation,200,100);healthy.hp=sim.TUNE.fleeHpThreshold+1;healthy.attackCooldown=0;sim.buildings.push(healthyStation);sim.state.workers.push(healthy);sim.spawnEnemy("healer");const enemy=sim.state.enemies[0];enemy.x=healthy.x;enemy.y=healthy.y;const hpBefore=enemy.hp;step();assert.equal(healthy.fleeing,false);assert.equal(healthy.combatTarget,enemy);assert.equal(enemy.hp,hpBefore-data.WORKER_DAMAGE);assert.equal(healthy.attackCooldown,data.WORKER_ATTACK_RATE);}
        // Explicit guards are isolated: never rescheduled, never borrowed, never tidying drops.
        reset();{const site=building("lumber",300,300,false,{wood:99,stone:0}),store=building("stockpile",360,300),tree={x:270,y:300,hp:9,max:9,stump:0,shake:0},loose=drop("wood",312,312),station=building("garrison",310,310),guard=worker("guard",station,310,310);guard.postX=310;guard.postY=310;sim.buildings.push(site,store,station);sim.trees.push(tree);sim.resourceDrops.push(loose);sim.state.workers.push(guard);sweep();assert.equal(guard.job,"guard","an explicit guard must never be given autonomous work");assert.equal(guard.jobTarget,station,"a garrison guard keeps its station through every scheduler sweep");assert.equal(sim.workerOccupancyStatus(site).assigned,0);assert.equal(sim.resourceDrops.includes(loose),true,"guards must not opportunistically collect drops");assert.equal(loose.claimedBy,undefined);assert.equal(guard.carried.wood,0);}
        // Free is not guard: with an enemy inside the old guard leash but NO garrison within the
        // muster radius, the free worker stays inert instead of improvising a defense.
        reset();{const free=freeWorker(300,300),station=building("garrison",900,300),guard=worker("guard",station,900,300);guard.postX=900;guard.postY=300;sim.buildings.push(station);sim.state.workers.push(free,guard);sim.spawnEnemy("raider");const nearFree=sim.state.enemies[0];nearFree.x=free.x+80;nearFree.y=free.y;sim.spawnEnemy("raider");const nearGuard=sim.state.enemies[1];nearGuard.x=guard.x+80;nearGuard.y=guard.y;const freeAt={x:free.x,y:free.y};step();assert.equal(free.combatTarget,null,"a free worker must not proactively defend a post");assert.deepEqual({x:free.x,y:free.y},freeAt,"a free worker with no assignment must remain inert");assert.equal(guard.combatTarget,nearGuard,"an explicit guard still defends its post");sim.state.enemies.length=0;}
        // ── the garrison ────────────────────────────────────────────────────────────────────
        // A worker becomes a guard ONLY by being dropped into a completed garrison. The station
        // reuses the shared occupancy/reservation/arrival machinery, so its slots are derived from
        // the workers pointing at it — held workers included — and never stored on the building.
        reset();{
          const alpha=building("garrison",400,400),beta=building("garrison",700,400),home=building("house",1000,400);
          home.spawnTimer=99999;sim.buildings.push(alpha,beta,home);
          const one=freeWorker(360,460),two=freeWorker(365,460),three=freeWorker(370,460),four=freeWorker(375,460);
          sim.state.workers.push(one,two,three,four);
          const drag=(unit,x,y)=>{sim.setPointerWorld(unit.x,unit.y);sim.secondaryPress();assert.equal(sim.heldWorker(),unit);sim.setPointerWorld(x,y);sim.secondaryRelease();};
          drag(one,alpha.x-10,alpha.y);
          assert.equal(one.job,"guard","a completed garrison must accept a dropped worker as a guard");
          assert.equal(one.jobTarget,alpha,"a guard must name the exact garrison it was dropped into");
          assert.equal(one.autonomous,false,"a dropped guard is a manual assignment");
          assert.equal(one.postX,alpha.x);assert.ok(one.postY>alpha.y&&one.postY<alpha.y+data.CELL,"the guard post must sit on the station itself");
          assert.equal(sim.durablePostStatus(alpha).capacity,data.GARRISON.capacity);
          assert.equal(sim.durablePostStatus(alpha).assigned,1,"assignment must reserve the slot before the guard has walked anywhere");
          assert.equal(sim.durablePostStatus(alpha).arrived,0,"a travelling guard has not arrived yet");
          step(120);assert.equal(sim.durablePostStatus(alpha).arrived,1,"the guard must record arrival through the durable post");
          sweep();assert.equal(one.job,"guard","a manual guard stays assigned until it is explicitly moved");assert.equal(one.jobTarget,alpha);
          sim.setPointerWorld(one.x,one.y);sim.secondaryPress();assert.equal(sim.heldWorker(),one);
          assert.equal(sim.durablePostStatus(alpha).assigned,1,"a held guard must keep its garrison slot reserved");
          sim.pointerCancelled();
          drag(two,alpha.x+10,alpha.y);assert.equal(two.jobTarget,alpha);assert.equal(sim.durablePostStatus(alpha).assigned,2);
          drag(three,alpha.x,alpha.y-10);assert.equal(three.jobTarget,alpha);assert.equal(sim.durablePostStatus(alpha).assigned,data.GARRISON.capacity,"the third drop must fill the last authored slot");
          const origin={x:four.x,y:four.y},prior={job:four.job,jobTarget:four.jobTarget};
          assert.equal(sim.workerAssignmentAt(four,alpha.x,alpha.y),null,"a full garrison must offer no assignment");
          drag(four,alpha.x,alpha.y);
          assert.deepEqual({x:four.x,y:four.y},origin,"full-garrison rejection did not restore the pickup origin");
          assert.deepEqual({job:four.job,jobTarget:four.jobTarget},prior,"full-garrison rejection did not restore the prior assignment");
          assert.equal(sim.durablePostStatus(alpha).assigned,data.GARRISON.capacity);
          drag(four,beta.x,beta.y);assert.equal(four.jobTarget,beta,"a second garrison must fill independently of a full one");
          assert.equal(sim.durablePostStatus(beta).assigned,1);assert.equal(sim.durablePostStatus(alpha).assigned,data.GARRISON.capacity);
          sim.validateSimulationInvariants();
          drag(two,beta.x-10,beta.y);assert.equal(two.jobTarget,beta);
          assert.equal(sim.durablePostStatus(alpha).assigned,data.GARRISON.capacity-1,"reassignment must release the old station on the spot");assert.equal(sim.durablePostStatus(beta).assigned,2);
          drag(two,home.x,home.y);assert.equal(two.job,"free","a completed house must reposition the worker as free, not mint a guard");assert.equal(two.jobTarget,null);assert.equal(two.autonomous,true);
          drag(four,520,700);assert.equal(four.job,"free","open ground must reposition the worker as free, not mint a guard");assert.equal(four.jobTarget,null);assert.equal(four.autonomous,true);
          assert.equal(sim.durablePostStatus(beta).assigned,0,"both departures must free the second garrison");
          drag(three,560,760);assert.equal(three.job,"free");
          sim.buildings.splice(sim.buildings.indexOf(alpha),1);
          step();assert.equal(one.job,"free","a guard whose garrison left the world must be released to free");assert.equal(one.jobTarget,null);assert.equal(one.autonomous,true);
          sim.validateSimulationInvariants();
        }
        // ── the garrison muster: autonomous defense ─────────────────────────────────────────
        // The scheduler answers a hostile by posting nearby autonomous workers to a garrison, ahead
        // of any build/haul/gather work. The posting is a reservation first and a fortification only
        // once the guard has physically arrived; it stands itself down again on a quiet day.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,300);
          sim.buildings.push(station);sim.state.workers.push(idle);
          step();assert.equal(idle.job,"free","a garrison alone raises no muster");
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();
          assert.equal(idle.job,"guard","a hostile inside the threat radius must muster a nearby autonomous worker");
          assert.equal(idle.jobTarget,station,"the muster must name the exact garrison it reserved");
          assert.equal(idle.autonomous,true,"a mustered guard is a SCHEDULER assignment");
          assert.equal(sim.durablePostStatus(station).assigned,1,"the slot is reserved before the guard walks anywhere");
          assert.equal(sim.durablePostStatus(station).arrived,0,"a travelling guard has not arrived yet");
          sim.state.enemies.length=0;
          step(200);assert.equal(sim.durablePostStatus(station).arrived,1,"arrival must be tracked through the shared staffing gate");
          sim.validateSimulationInvariants();
        }
        // The muster abandons the prior autonomous objective safely: claims release and the carried
        // load becomes physical drops, so nothing stays reserved behind the new guard.
        reset();{
          const station=building("garrison",400,400),store=building("stockpile",400,260),hauler=freeWorker(400,300),loose=drop("wood",396,300);
          hauler.job="haul";hauler.jobTarget=store;hauler.postX=store.x;hauler.postY=store.y+18;hauler.taskTarget=loose;loose.claimedBy=hauler;hauler.carried.stone=2;
          sim.buildings.push(station,store);sim.resourceDrops.push(loose);sim.state.workers.push(hauler);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();
          assert.equal(hauler.job,"guard");assert.equal(hauler.jobTarget,station);
          assert.equal(hauler.taskTarget,null,"the muster must release the abandoned task");
          assert.equal(loose.claimedBy,undefined,"a mustered worker may not keep a drop reserved");
          assert.equal(hauler.carried.stone,0,"the incompatible load must be scattered, not carried into the garrison");
          assert.equal(sim.resourceDrops.filter(item=>item.kind==="stone").length,2,"the scattered load must re-enter the world as physical drops");
          sim.validateSimulationInvariants();
        }
        // Both radii are hard bounds: the threat that raises the call, and the reach of the call.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,300);sim.buildings.push(station);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400+data.GARRISON.threatRadius+6;foe.y=300;
          step();assert.equal(idle.job,"free","a hostile beyond the threat radius raises no muster");
          foe.x=400+data.GARRISON.threatRadius-40;step();assert.equal(idle.job,"guard","a hostile inside the threat radius must raise the muster");
        }
        reset();{
          const far=building("garrison",400,300+data.GARRISON.musterRadius+40),idle=freeWorker(400,300);
          sim.buildings.push(far);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.equal(idle.job,"free","no garrison within the muster radius means no muster");
          const near=building("garrison",400,400);sim.buildings.push(near);
          step();assert.equal(idle.job,"guard");assert.equal(idle.jobTarget,near,"only a station inside the muster radius may be chosen");
        }
        // An unfinished garrison is not a station: it offers no slot to the muster.
        reset();{
          const site=building("garrison",400,400,false,{wood:6,stone:6}),idle=freeWorker(400,300);
          sim.buildings.push(site);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.notEqual(idle.job,"guard","an unfinished garrison must never take a guard");
        }
        // Nearest station wins; an exact-distance tie keeps stable collection order.
        reset();{
          const first=building("garrison",500,300),second=building("garrison",300,300),idle=freeWorker(400,300);
          sim.buildings.push(first,second);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.equal(idle.jobTarget,first,"an exact-distance tie must keep collection order");
        }
        reset();{
          const far=building("garrison",520,300),close=building("garrison",460,300),idle=freeWorker(400,300);
          sim.buildings.push(far,close);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.equal(idle.jobTarget,close,"the nearest viable garrison must win regardless of collection order");
        }
        // Slot contention: capacity caps the muster and the reservation lands inside the same sweep.
        reset();{
          const station=building("garrison",400,400);sim.buildings.push(station);
          const a=freeWorker(400,300),b=freeWorker(402,300),c=freeWorker(404,300),d=freeWorker(406,300);sim.state.workers.push(a,b,c,d);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=402;foe.y=180;
          step();
          assert.deepEqual([a.job,b.job,c.job,d.job],["guard","guard","guard","free"],"capacity must cap the muster in collection order");
          assert.equal(sim.durablePostStatus(station).assigned,data.GARRISON.capacity);
          assert.equal(d.jobTarget,null,"the worker that lost the contention keeps nothing reserved");
          sim.validateSimulationInvariants();
        }
        // A manually staffed garrison offers only its remaining slot.
        reset();{
          const station=building("garrison",400,400),manual=worker("guard",station,400,418),a=freeWorker(400,300),b=freeWorker(402,300),c=freeWorker(404,300);
          manual.postX=400;manual.postY=418;sim.buildings.push(station);sim.state.workers.push(manual,a,b,c);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=401;foe.y=180;
          step();
          assert.deepEqual([a.job,b.job,c.job],["guard","guard","free"],"a manual guard's slot must not be handed to the muster");
          assert.equal(sim.durablePostStatus(station).assigned,data.GARRISON.capacity);
        }
        // Manual assignments are standing orders: the muster never overrides one.
        reset();{
          const station=building("garrison",400,400),site=building("lumber",380,300,false,{wood:99,stone:0}),store=building("stockpile",420,300),camp=building("quarry",360,300),other=building("garrison",700,400);
          const b=worker("build",site,380,300),h=worker("haul",store,420,300),g=worker("harvest",{node:null,kind:"wood"},400,300),s=worker("staff",camp,360,300),m=worker("guard",other,700,300);
          sim.buildings.push(station,site,store,camp,other);sim.state.workers.push(b,h,g,s,m);
          sim.spawnEnemy("raider");sim.state.enemies[0].x=400;sim.state.enemies[0].y=180;
          sim.spawnEnemy("raider");sim.state.enemies[1].x=700;sim.state.enemies[1].y=180;
          step();
          assert.deepEqual([b.job,h.job,g.job,s.job,m.job],["build","haul","harvest","staff","guard"],"a manual assignment must survive the muster untouched");
          assert.equal(m.jobTarget,other,"a manual guard is never re-posted by the muster");
          assert.equal(sim.durablePostStatus(station).assigned,0,"no manual worker may be drafted into the garrison");
          sim.state.enemies.length=0;
        }
        // Melee self-defense outranks travel: a worker already in contact fights where it stands.
        reset();{
          const station=building("garrison",600,300),idle=freeWorker(400,300);sim.buildings.push(station);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=idle.x+data.WORKER_MELEE-6;foe.y=idle.y;foe.attackCooldown=5;
          const at={x:idle.x,y:idle.y},hpBefore=foe.hp;
          step();
          assert.equal(idle.job,"guard","the muster still reserves the slot");
          assert.equal(idle.combatTarget,foe,"a worker in contact must fight instead of walking away");
          assert.equal(foe.hp,hpBefore-data.WORKER_DAMAGE);
          assert.deepEqual({x:idle.x,y:idle.y},at,"contact must suppress the walk to the station");
          assert.equal(sim.durablePostStatus(station).arrived,0);
          sim.state.enemies.length=0;
        }
        // Night postings are binding, and dawn releases the whole autonomous roster in one go.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,300);sim.buildings.push(station);sim.state.workers.push(idle);
          holdNight();
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.equal(idle.job,"guard");
          sim.state.enemies.length=0;
          step(data.GARRISON.safeSeconds*60+300);
          assert.equal(idle.job,"guard","a night muster must hold through a quiet night");
          assert.equal(sim.state.clock.phase,"night","the held night must not have auto-dawned");
          assert.equal(sim.durablePostStatus(station).assigned,1);
          sim.transitionPhase();clearDraft();
          assert.equal(sim.state.clock.phase,"day");
          assert.equal(idle.job,"free","dawn must release the autonomous garrison roster");
          assert.equal(idle.jobTarget,null);assert.equal(idle.autonomous,true);
          assert.equal(sim.durablePostStatus(station).assigned,0);
          sim.validateSimulationInvariants();
        }
        // Dawn is a roster-wide transaction that spares the player's own guards.
        reset();{
          const station=building("garrison",400,400),beta=building("garrison",700,400);
          const manual=worker("guard",station,400,418),a=freeWorker(400,300),b=freeWorker(700,300);
          manual.postX=400;manual.postY=418;sim.buildings.push(station,beta);sim.state.workers.push(manual,a,b);
          holdNight();
          sim.spawnEnemy("raider");sim.state.enemies[0].x=400;sim.state.enemies[0].y=180;
          sim.spawnEnemy("raider");sim.state.enemies[1].x=700;sim.state.enemies[1].y=180;
          step();assert.deepEqual([a.job,b.job],["guard","guard"]);assert.equal(a.jobTarget,station);assert.equal(b.jobTarget,beta);
          sim.state.enemies.length=0;sim.transitionPhase();clearDraft();
          assert.deepEqual([a.job,b.job],["free","free"],"one dawn transaction must release every mustered guard");
          assert.equal(manual.job,"guard","a manual guard is never released by dawn");assert.equal(manual.jobTarget,station);
          assert.equal(sim.durablePostStatus(station).assigned,1);assert.equal(sim.durablePostStatus(beta).assigned,0);
          sim.validateSimulationInvariants();
        }
        // Repeated night/day cycles re-muster and re-release the same roster, with no drift.
        reset();{
          const station=building("garrison",400,400),a=freeWorker(400,300),b=freeWorker(404,300);
          sim.buildings.push(station);sim.state.workers.push(a,b);
          for(let cycle=0;cycle<3;cycle++){
            sim.transitionPhase();assert.equal(sim.state.clock.phase,"night");sim.state.nightWave.nextSpawnAt=1e9;sim.state.enemies.length=0;
            sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=station.x+120;foe.y=station.y;foe.attackCooldown=99;
            step();assert.deepEqual([a.job,b.job],["guard","guard"],"cycle "+cycle+": the roster must re-muster each night");
            sim.state.enemies.length=0;step(data.GARRISON.safeSeconds*60+60);
            assert.deepEqual([a.job,b.job],["guard","guard"],"cycle "+cycle+": night postings never time out");
            sim.transitionPhase();clearDraft();
            assert.equal(sim.state.clock.phase,"day");
            assert.deepEqual([a.job,b.job],["free","free"],"cycle "+cycle+": dawn must release the roster");
            assert.equal(sim.durablePostStatus(station).assigned,0);
            sim.validateSimulationInvariants();
          }
        }
        // Daytime: the station's own defense radius holds the post open, quiet times it out.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,380);sim.buildings.push(station);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=260;
          step();assert.equal(idle.job,"guard");
          // Pinned just inside the guard radius and unable to swing: the timer must keep resetting.
          for(let i=0;i<data.GARRISON.safeSeconds*60+300;i++){foe.x=station.x+data.GARRISON.guardRadius-10;foe.y=station.y;foe.attackCooldown=99;step();}
          assert.equal(idle.job,"guard","a hostile inside the guard radius must hold the post open indefinitely");
          // Just outside it, the same hostile no longer counts as local threat.
          for(let i=0;i<data.GARRISON.safeSeconds*60-60;i++){foe.x=station.x+data.GARRISON.guardRadius+10;foe.y=station.y;foe.attackCooldown=99;step();}
          assert.equal(idle.job,"guard","the guard must hold its post for the full safe delay");
          for(let i=0;i<120;i++){foe.x=station.x+data.GARRISON.guardRadius+10;foe.y=station.y;foe.attackCooldown=99;step();}
          assert.equal(idle.job,"free","a quiet day must demobilize the autonomous guard");
          assert.equal(idle.jobTarget,null);assert.equal(idle.autonomous,true);
          assert.equal(sim.durablePostStatus(station).assigned,0,"demobilization must reopen the derived slot");
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
        }
        // A manual guard has no demobilization clock at all.
        reset();{
          const station=building("garrison",400,400),manual=worker("guard",station,400,418);manual.postX=400;manual.postY=418;
          sim.buildings.push(station);sim.state.workers.push(manual);
          step(data.GARRISON.safeSeconds*60+300);
          assert.equal(manual.job,"guard","a manual guard never auto-demobilizes");assert.equal(manual.jobTarget,station);
          assert.equal(sim.durablePostStatus(station).assigned,1);
        }
        // Invalidation: a reserved station that leaves the world releases its mustered guard.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,300);sim.buildings.push(station);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.equal(idle.job,"guard");
          sim.buildings.splice(sim.buildings.indexOf(station),1);
          step();
          assert.equal(idle.job,"free","a garrison that left the world must release its guard");
          assert.equal(idle.jobTarget,null);assert.equal(idle.autonomous,true);
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
        }
        // Pickup, drop and death during travel all reopen the derived occupancy immediately.
        reset();{
          const station=building("garrison",600,300),a=freeWorker(400,300),b=freeWorker(460,300);
          sim.buildings.push(station);sim.state.workers.push(a,b);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=430;foe.y=180;
          step();assert.deepEqual([a.job,b.job],["guard","guard"]);assert.equal(sim.durablePostStatus(station).assigned,2);
          sim.setPointerWorld(b.x,b.y);sim.secondaryPress();assert.equal(sim.heldWorker(),b);
          assert.equal(sim.durablePostStatus(station).assigned,2,"a held guard keeps its reservation");
          sim.setPointerWorld(300,700);sim.secondaryRelease();
          assert.equal(b.job,"free");assert.equal(sim.durablePostStatus(station).assigned,1,"dropping the guard elsewhere reopens the slot");
          a.hp=2;foe.x=a.x+35;foe.y=a.y;foe.attackCooldown=0;
          step();
          assert.equal(sim.state.workers.includes(a),false,"the travelling guard must have died to the raider");
          assert.equal(sim.durablePostStatus(station).assigned,0,"death must immediately reopen the derived slot");
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
        }
        // Paused simulated time freezes the muster, the demobilization clock and the guard alike.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,300);sim.buildings.push(station);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          sim.togglePause();step(120);assert.equal(idle.job,"free","the muster must not run under pause");
          sim.togglePause();step();assert.equal(idle.job,"guard");
          sim.state.enemies.length=0;sim.togglePause();step(data.GARRISON.safeSeconds*60+300);
          assert.equal(idle.job,"guard","the demobilization clock must not advance under pause");
          sim.togglePause();step(data.GARRISON.safeSeconds*60+120);
          assert.equal(idle.job,"free","the clock resumes with the simulation");
        }
        // A forced debug phase change is the real transition, so it releases the roster too.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,300);sim.buildings.push(station);sim.state.workers.push(idle);
          holdNight();
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=180;
          step();assert.equal(idle.job,"guard");
          sim.state.enemies.length=0;sim.debugGoToPhase("day");clearDraft();
          assert.equal(sim.state.clock.phase,"day");
          assert.equal(idle.job,"free","a forced dawn must release the mustered roster like any other dawn");
          assert.equal(sim.durablePostStatus(station).assigned,0);
          sim.validateSimulationInvariants();
        }
        // Several workers, several hostiles and several garrisons resolve in one deterministic pass.
        reset();{
          const alpha=building("garrison",400,400),beta=building("garrison",900,400),gamma=building("garrison",1400,400);
          sim.buildings.push(alpha,beta,gamma);
          const crew=[];for(const x of [380,420,360,880,920,860,1380,1420,1360,1800])crew.push(freeWorker(x,300));
          sim.state.workers.push(...crew);
          for(const x of [400,900,1400]){sim.spawnEnemy("raider");const foe=sim.state.enemies.at(-1);foe.x=x;foe.y=180;foe.attackCooldown=99;}
          step();
          assert.deepEqual(crew.map(unit=>unit.jobTarget),[alpha,alpha,alpha,beta,beta,beta,gamma,gamma,gamma,null],"each hostile must fill only its own nearest station");
          for(const station of [alpha,beta,gamma])assert.equal(sim.durablePostStatus(station).assigned,data.GARRISON.capacity);
          assert.equal(crew.at(-1).job,"free","a worker with no hostile in reach keeps working the economy");
          for(let i=0;i<600;i++){for(const foe of sim.state.enemies)foe.attackCooldown=99;step();}
          sim.validateSimulationInvariants();
          assert.equal(sim.state.workers.filter(unit=>unit.job==="guard").length,9,"a live hostile at every station holds every post");
          sim.state.enemies.length=0;
        }
        // ── the garrison's fortified kit: effective health and damage ───────────────────────
        // Nothing is granted for orders or for a reservation. The kit belongs to a guard STANDING
        // at a live station: it is granted as a max-HP DELTA and withdrawn as a CLAMP, so a status
        // change can never heal a wounded guard to full nor kill it by subtraction.
        const post=(unit,station)=>{unit.postX=station.x;unit.postY=station.y+18;return unit;};
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station);sim.state.workers.push(guard);
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP,"a travelling guard is still an ordinary worker");
          assert.equal(guard.hp,data.WORKER_HP);
          step(200);
          assert.equal(sim.durablePostStatus(station).arrived,1,"the guard must have reached its post");
          assert.equal(sim.workerMaxHp(guard),data.GARRISON.maxHp,"arrival must raise the effective maximum");
          assert.equal(guard.hp,data.GARRISON.maxHp);
          // Every later frame re-reads the same predicate; the arrival edge may never fire twice.
          step(300);
          assert.equal(guard.hp,data.GARRISON.maxHp,"repeated arrival processing must not keep granting health");
          sim.validateSimulationInvariants();
        }
        // A wounded guard is fortified by the DELTA only: 3/5 becomes 8/10, never 10/10.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          guard.hp=3;sim.buildings.push(station);sim.state.workers.push(guard);
          step(200);
          assert.equal(guard.hp,3+(data.GARRISON.maxHp-data.WORKER_HP),"arrival grants the max-HP delta, not a full heal");
          assert.equal(sim.workerMaxHp(guard),data.GARRISON.maxHp);
          step(300);assert.equal(guard.hp,8,"the delta is granted exactly once");
          sim.validateSimulationInvariants();
        }
        // Lifting an arrived guard withdraws the kit on the spot while the slot stays reserved;
        // putting it back grants the one legitimate arrival delta again and nothing more.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          guard.hp=3;sim.buildings.push(station);sim.state.workers.push(guard);
          step(200);assert.equal(guard.hp,8);
          guard.hp=2;
          sim.setPointerWorld(guard.x,guard.y);sim.secondaryPress();
          assert.equal(sim.heldWorker(),guard);
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP,"a held guard is no longer fortified");
          assert.equal(guard.hp,2,"the clamp may never take health the ordinary pool still holds");
          assert.equal(guard.job,"guard");assert.equal(guard.jobTarget,station);
          assert.equal(sim.durablePostStatus(station).assigned,1,"a held guard keeps its station reserved");
          sim.validateSimulationInvariants();
          sim.setPointerWorld(station.x,station.y);sim.secondaryRelease();
          assert.equal(guard.jobTarget,station,"returning the guard must restore the same posting");
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP,"the returned guard must re-reach the post first");
          step(60);
          assert.equal(guard.hp,2+(data.GARRISON.maxHp-data.WORKER_HP),"the return may grant the arrival delta exactly once");
          step(300);assert.equal(guard.hp,7);
          sim.validateSimulationInvariants();
        }
        // Ending guard duty CLAMPS the overfull pool instead of subtracting a fixed amount.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station);sim.state.workers.push(guard);
          step(200);assert.equal(guard.hp,data.GARRISON.maxHp);
          sim.setPointerWorld(guard.x,guard.y);sim.secondaryPress();
          assert.equal(guard.hp,data.WORKER_HP,"the overfull pool must clamp to the ordinary maximum");
          sim.setPointerWorld(300,700);sim.secondaryRelease();
          assert.equal(guard.job,"free");assert.equal(guard.hp,data.WORKER_HP);
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP);
          assert.equal(sim.durablePostStatus(station).assigned,0);
          step(120);assert.equal(guard.hp,data.WORKER_HP,"a freed worker never regains the fortified pool");
          sim.validateSimulationInvariants();
        }
        // Reassignment between stations withdraws one kit and grants the other exactly once.
        reset();{
          const alpha=building("garrison",400,400),beta=building("garrison",700,400),guard=post(worker("guard",alpha,400,300),alpha);
          guard.hp=4;sim.buildings.push(alpha,beta);sim.state.workers.push(guard);
          step(200);assert.equal(guard.hp,9);
          sim.setPointerWorld(guard.x,guard.y);sim.secondaryPress();
          sim.setPointerWorld(beta.x,beta.y);sim.secondaryRelease();
          assert.equal(guard.jobTarget,beta);assert.equal(guard.hp,data.WORKER_HP,"the old station's kit is withdrawn on reassignment");
          assert.equal(sim.durablePostStatus(alpha).assigned,0);
          step(60);
          assert.equal(guard.hp,data.GARRISON.maxHp,"the new station grants its own arrival delta");
          sim.validateSimulationInvariants();
        }
        // A camp is a durable post too, and it shares the arrival gate — but grants no kit at all.
        reset();{
          const station=building("garrison",400,400),camp=building("lumber",700,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station,camp);sim.state.workers.push(guard);
          step(200);assert.equal(guard.hp,data.GARRISON.maxHp);
          sim.setPointerWorld(guard.x,guard.y);sim.secondaryPress();
          sim.setPointerWorld(camp.x,camp.y);sim.secondaryRelease();
          assert.equal(guard.job,"staff");assert.equal(guard.jobTarget,camp);
          assert.equal(guard.hp,data.WORKER_HP);
          step(300);
          assert.equal(sim.durablePostStatus(camp).arrived,1,"the staffer must reach its camp post");
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP,"arriving at a camp grants no fortified pool");
          assert.equal(guard.hp,data.WORKER_HP);
          sim.validateSimulationInvariants();
        }
        // A mustered guard is fortified on arrival like any other, and demobilization clamps it.
        reset();{
          const station=building("garrison",400,400),idle=freeWorker(400,380);
          sim.buildings.push(station);sim.state.workers.push(idle);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=400;foe.y=260;foe.attackCooldown=99;
          step();assert.equal(idle.job,"guard");
          assert.equal(sim.workerMaxHp(idle),data.WORKER_HP,"the muster reserves a slot, it does not fortify");
          idle.hp=3;
          for(let i=0;i<120;i++){foe.x=station.x+data.GARRISON.guardRadius-10;foe.y=station.y;foe.attackCooldown=99;step();}
          assert.equal(idle.hp,8,"a mustered guard is fortified by arrival, by the delta");
          assert.equal(sim.workerMaxHp(idle),data.GARRISON.maxHp);
          sim.state.enemies.length=0;
          step(data.GARRISON.safeSeconds*60+180);
          assert.equal(idle.job,"free","a quiet day must demobilize the autonomous guard");
          assert.equal(idle.hp,data.WORKER_HP,"demobilization clamps the pool instead of subtracting");
          assert.equal(sim.workerMaxHp(idle),data.WORKER_HP);
          sim.validateSimulationInvariants();
        }
        // Debug healing tops every worker up to its OWN effective maximum.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station),plain=worker("haul",data.BASE,data.BASE.x,data.BASE.y+5);
          sim.buildings.push(station);sim.state.workers.push(guard,plain);
          step(200);guard.hp=2;plain.hp=1;
          sim.debugHealAll();
          assert.equal(guard.hp,data.GARRISON.maxHp,"healing must reach the guard's effective maximum");
          assert.equal(plain.hp,data.WORKER_HP,"an ordinary worker heals to the ordinary maximum");
          sim.validateSimulationInvariants();
        }
        // Combat: only an ARRIVED guard swings for the garrison's damage; cadence is untouched.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station);sim.state.workers.push(guard);
          sim.spawnEnemy("healer");const early=sim.state.enemies[0];early.x=guard.x;early.y=guard.y;early.attackCooldown=99;guard.attackCooldown=0;
          const earlyBefore=early.hp;step();
          assert.equal(sim.durablePostStatus(station).arrived,0,"contact suppresses the walk to the post");
          assert.equal(early.hp,earlyBefore-data.WORKER_DAMAGE,"a guard that has not arrived hits like any worker");
          sim.state.enemies.length=0;
          step(300);assert.equal(sim.durablePostStatus(station).arrived,1);
          sim.spawnEnemy("healer");const armed=sim.state.enemies[0];armed.x=guard.x;armed.y=guard.y;armed.attackCooldown=99;guard.attackCooldown=0;
          const armedBefore=armed.hp;step();
          assert.equal(armed.hp,armedBefore-data.GARRISON.damage,"an arrived guard hits with the garrison's damage");
          assert.equal(guard.attackCooldown,data.WORKER_ATTACK_RATE,"the attack cadence is unchanged");
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
        }
        // The survival interrupt scales with the fortified pool. A raider's even damage walks a
        // 10 HP guard 10→8→…→2 without ever touching the ordinary threshold of 1, so the trigger
        // reads hp against effective max: 2/10 runs, 3/10 still fights.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station);sim.state.workers.push(guard);
          step(300);assert.equal(sim.workerMaxHp(guard),data.GARRISON.maxHp);
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=guard.x+5;foe.y=guard.y;foe.attackCooldown=99;
          guard.hp=3;step();
          assert.equal(guard.fleeing,false,"3/10 is above the scaled threshold and holds the line");
          guard.hp=2;step();
          assert.equal(guard.fleeing,true,"a fortified guard at 2/10 must run for safety, not fight to the death");
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
        }
        // The bigger pool is not immortality: zero is still death, and the slot reopens with it.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station);sim.state.workers.push(guard);
          step(200);assert.equal(guard.hp,data.GARRISON.maxHp);
          const corpsesBefore=sim.workerCorpses.length;
          sim.spawnEnemy("raider");const killer=sim.state.enemies[0];killer.x=guard.x;killer.y=guard.y;killer.attackCooldown=0;
          guard.hp=2;step(5);
          assert.equal(sim.state.workers.includes(guard),false,"a fortified guard still dies at zero health");
          assert.equal(sim.workerCorpses.length,corpsesBefore+1,"death must leave the ordinary corpse");
          assert.equal(sim.durablePostStatus(station).assigned,0,"death must reopen the garrison slot");
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
        }
        // A guard with no LIVE station is never fortified: an unfinished garrison grants nothing.
        reset();{
          const site=building("garrison",400,400,false,{wood:6,stone:6}),guard=post(worker("guard",site,400,418),site);
          sim.buildings.push(site);sim.state.workers.push(guard);
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP,"an unfinished garrison is no station");
          step();
          assert.equal(guard.job,"free","a guard with no live station is released, never fortified");
          assert.equal(guard.hp,data.WORKER_HP);assert.equal(sim.workerMaxHp(guard),data.WORKER_HP);
          sim.validateSimulationInvariants();
        }
        // A station that leaves the world takes its kit with it on the very next frame.
        reset();{
          const station=building("garrison",400,400),guard=post(worker("guard",station,400,300),station);
          sim.buildings.push(station);sim.state.workers.push(guard);
          step(200);assert.equal(guard.hp,data.GARRISON.maxHp);
          sim.buildings.splice(sim.buildings.indexOf(station),1);
          assert.equal(sim.workerMaxHp(guard),data.WORKER_HP,"an invalid station cannot keep the kit alive");
          step();
          assert.equal(guard.job,"free");assert.equal(guard.hp,data.WORKER_HP,"the pool clamps when the station is gone");
          sim.validateSimulationInvariants();
        }
        // Sustained pressure: guards muster, fortify, fight, die and are replaced over and over
        // while the effective-maximum invariant is checked throughout and slots keep reopening.
        reset();{
          const station=building("garrison",400,400),house=building("house",320,400);
          house.spawnTimer=0;sim.DBG.instantWorkers=true;sim.buildings.push(station,house);
          const corpsesBefore=sim.workerCorpses.length;let fortified=0;
          for(let i=0;i<3600;i++){
            if(i%150===0){sim.spawnEnemy("raider");const raider=sim.state.enemies.at(-1);raider.x=station.x+16;raider.y=station.y-16;}
            sim.update(1/60);clearDraft();
            fortified=Math.max(fortified,sim.state.workers.filter(unit=>sim.workerMaxHp(unit)===data.GARRISON.maxHp).length);
            assert.ok(sim.durablePostStatus(station).assigned<=data.GARRISON.capacity,"derived occupancy must never oversubscribe");
            if(i%120===0)sim.validateSimulationInvariants();
          }
          assert.ok(fortified>0,"sustained pressure must have fortified at least one guard");
          assert.ok(sim.workerCorpses.length>corpsesBefore,"sustained combat must have cost guards their lives");
          for(const unit of sim.state.workers)assert.ok(unit.hp<=sim.workerMaxHp(unit),"no worker may outlive its effective maximum");
          sim.state.enemies.length=0;step(30);
          assert.ok(sim.durablePostStatus(station).assigned<=data.GARRISON.capacity,"deaths must keep reopening the derived slots");
          sim.validateSimulationInvariants();
        }
        // ── the garrison end to end ─────────────────────────────────────────────────────────
        // One station, one continuous run of the whole feature: the drafted build card lands a
        // SITE at the authored cost, manual builders carry that cost and inherit the posts they
        // stood up, a hostile musters the reserve into the remaining slot, arrival (never the
        // order) fortifies, a night posting holds and dawn stands only the autonomous guard down.
        // The three failure cases close on the way through: a full station rejects a drop, a dead
        // guard reopens its slot, and a station that leaves the world releases whoever it held.
        reset();{
          const drag=(unit,x,y)=>{sim.setPointerWorld(unit.x,unit.y);sim.secondaryPress();assert.equal(sim.heldWorker(),unit);sim.setPointerWorld(x,y);sim.secondaryRelease();};
          // 1 · acquisition — the common build card lands an ordinary construction site.
          assert.equal(sim.debugDealCard("bpGarrison"),true,"the garrison must be dealable as an ordinary build card");
          assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpGarrison")),"targeting");
          assert.equal(sim.state.buildMode,"garrison");
          let anchor=null;
          for(let cy=16;cy<48&&!anchor;cy++)for(let cx=16;cx<96;cx++){const p=cellToWorld(cx,cy);if(sim.canPlace(p.x,p.y,"garrison")){anchor=p;break;}}
          assert.ok(anchor,"the end-to-end run needs a placeable land cell");
          sim.setPointerWorld(anchor.x,anchor.y);sim.primaryPress();sim.primaryRelease();
          const station=sim.buildings.at(-1);
          assert.equal(station.type,"garrison");
          assert.equal(station.complete,false,"a build card lands a site, never a finished garrison");
          assert.deepEqual(station.cost,{...data.BUILDING_TYPES.garrison.cost},"the site must charge the authored 6 wood + 6 stone");
          assert.equal(sim.hand().some(entry=>entry.id==="bpGarrison"),false,"the single-charge build must leave the hand as its site lands");
          assert.equal(sim.workerOccupancyStatus(station).capacity,data.BUILDING_TYPES.garrison.buildSlots,"the site offers exactly its authored build slots");
          // 2 · construction — two manual builders carry the cost from covering storage.
          const store=building("stockpile",anchor.x+64,anchor.y);store.storage.wood=6;store.storage.stone=6;
          sim.buildings.push(store);
          const alpha=worker("build",station,anchor.x-12,anchor.y),beta=worker("build",station,anchor.x+12,anchor.y);
          sim.state.workers.push(alpha,beta);
          for(let i=0;i<3600&&!station.complete;i++)step();
          assert.equal(station.complete,true,"the builders never delivered the authored cost");
          // The construction stretch is the only long one; a fresh day keeps the postings below from
          // meeting a dusk they were never measuring.
          sim.state.clock.remaining=data.DAY_DURATION;
          // 3 · manual guards — completion inheritance fills both slots as standing orders.
          assert.deepEqual([alpha.job,beta.job],["guard","guard"],"a manual builder must inherit the garrison post it stood up");
          assert.deepEqual([alpha.autonomous,beta.autonomous],[false,false],"an inherited post is a manual assignment");
          assert.equal(sim.durablePostStatus(station).assigned,data.BUILDING_TYPES.garrison.buildSlots,"inheritance fills one post per builder");
          step(120);
          assert.equal(sim.durablePostStatus(station).arrived,data.BUILDING_TYPES.garrison.buildSlots,"both inherited guards must reach the post");
          assert.equal(sim.workerMaxHp(alpha),data.GARRISON.maxHp);assert.equal(alpha.hp,data.GARRISON.maxHp,"arrival grants the fortified pool");
          // The two build slots leave one authored guard slot open; a manual drop fills it.
          const gamma=freeWorker(anchor.x,anchor.y-40);sim.state.workers.push(gamma);
          drag(gamma,station.x,station.y);
          assert.equal(gamma.job,"guard");assert.equal(gamma.autonomous,false);
          step(120);
          assert.equal(sim.durablePostStatus(station).arrived,data.GARRISON.capacity,"the manual drop must fill and reach the last authored slot");
          sim.validateSimulationInvariants();
          // 3a · FAILURE — a full station rejects a manual drop and restores the pickup origin.
          // The rejection test drags EXTRA: a failed drop re-enters the roster at the back, and the
          // muster below leans on spare keeping its earlier collection slot.
          const spare=freeWorker(anchor.x,anchor.y-260),extra=freeWorker(anchor.x+4,anchor.y-260);
          sim.state.workers.push(spare,extra);
          const origin={x:extra.x,y:extra.y};
          assert.equal(sim.workerAssignmentAt(extra,station.x,station.y),null,"a full garrison must offer no assignment");
          drag(extra,station.x,station.y);
          assert.deepEqual({x:extra.x,y:extra.y},origin,"full-garrison rejection did not restore the pickup origin");
          assert.equal(extra.job,"free");assert.equal(sim.durablePostStatus(station).assigned,data.GARRISON.capacity);
          // 4 · one slot reopens: leaving the post clamps the fortified pool back to the ordinary one.
          drag(beta,anchor.x+600,anchor.y);
          assert.equal(beta.job,"free");assert.equal(beta.hp,data.WORKER_HP,"leaving the post must clamp, not subtract");
          assert.equal(sim.durablePostStatus(station).assigned,data.GARRISON.capacity-1,"the departure must reopen exactly one derived slot");
          // 5 · the muster — a hostile posts the nearest autonomous reserve into the last slot.
          sim.spawnEnemy("raider");const foe=sim.state.enemies[0];foe.x=spare.x;foe.y=spare.y-100;foe.attackCooldown=99;
          step();
          assert.equal(spare.job,"guard","a hostile in the threat radius must muster the reserve");
          assert.equal(spare.jobTarget,station);assert.equal(spare.autonomous,true,"a mustered guard is a scheduler assignment");
          assert.equal(sim.workerMaxHp(spare),data.WORKER_HP,"the muster reserves a slot, it does not fortify");
          assert.equal(extra.job,"free","the last slot is the last slot");
          assert.equal(sim.durablePostStatus(station).assigned,data.GARRISON.capacity);
          // 6 · fortified combat — the hostile holds the stand-down clock open from inside the
          // guard radius but stays outside the post leash, so the reserve walks in and arrives.
          for(let i=0;i<600;i++){foe.x=station.x+data.GARRISON.guardRadius-10;foe.y=station.y;foe.attackCooldown=99;step();}
          assert.equal(sim.durablePostStatus(station).arrived,data.GARRISON.capacity,"the mustered guard must reach its post");
          assert.equal(sim.workerMaxHp(spare),data.GARRISON.maxHp);assert.equal(spare.hp,data.GARRISON.maxHp);
          assert.equal(spare.job,"guard","a hostile inside the guard radius holds the post open");
          foe.x=spare.x;foe.y=spare.y;foe.attackCooldown=99;spare.attackCooldown=0;alpha.attackCooldown=99;gamma.attackCooldown=99;
          const foeBefore=foe.hp;step();
          assert.equal(foe.hp,foeBefore-data.GARRISON.damage,"an arrived guard hits with the garrison's damage");
          assert.equal(spare.attackCooldown,data.WORKER_ATTACK_RATE,"the attack cadence is unchanged");
          sim.state.enemies.length=0;sim.validateSimulationInvariants();
          // 7 · night holds the posting, dawn releases only the autonomous half of the roster.
          sim.transitionPhase();assert.equal(sim.state.clock.phase,"night");
          sim.state.nightWave.nextSpawnAt=1e9;sim.state.enemies.length=0;clearDraft();
          step(data.GARRISON.safeSeconds*60+120);
          assert.equal(spare.job,"guard","a night posting never times out");assert.equal(alpha.job,"guard");
          sim.transitionPhase();clearDraft();
          assert.equal(sim.state.clock.phase,"day");
          assert.equal(spare.job,"free","dawn must stand the autonomous guard down");
          assert.equal(spare.jobTarget,null);assert.equal(spare.autonomous,true);
          assert.equal(spare.hp,data.WORKER_HP,"standing down clamps the fortified pool");
          assert.equal(alpha.job,"guard","a manual guard is never released by dawn");assert.equal(gamma.job,"guard");
          assert.equal(alpha.hp,data.GARRISON.maxHp,"the manual guard keeps the kit it is still standing in");
          assert.equal(sim.durablePostStatus(station).assigned,2,"dawn releases only the autonomous half of the roster");
          sim.validateSimulationInvariants();
          // 8 · FAILURE — the fortified pool is not immortality, and death reopens the slot.
          // The stood-down worker is walked clear first so exactly one corpse is under measurement,
          // and the other manual guard is dragged off its post so the killer has a single victim.
          spare.x=spare.postX=anchor.x+700;spare.y=spare.postY=anchor.y;
          drag(gamma,anchor.x+650,anchor.y);
          assert.equal(gamma.job,"free");assert.equal(sim.durablePostStatus(station).assigned,1);
          const corpsesBefore=sim.workerCorpses.length;
          sim.spawnEnemy("raider");const killer=sim.state.enemies[0];killer.x=alpha.x;killer.y=alpha.y;killer.attackCooldown=0;alpha.hp=2;
          step(5);
          assert.equal(sim.state.workers.includes(alpha),false,"a fortified guard still dies at zero health");
          assert.equal(sim.workerCorpses.length,corpsesBefore+1,"death must leave the ordinary corpse");
          assert.equal(sim.durablePostStatus(station).assigned,0,"death must reopen the derived slot");
          sim.state.enemies.length=0;
          // 9 · FAILURE — a station that leaves the world releases whoever it held, kit included.
          const replacement=freeWorker(station.x-30,station.y);sim.state.workers.push(replacement);
          drag(replacement,station.x,station.y);
          assert.equal(replacement.job,"guard");assert.equal(replacement.jobTarget,station);assert.equal(replacement.autonomous,false);
          step(120);assert.equal(sim.workerMaxHp(replacement),data.GARRISON.maxHp);
          sim.buildings.splice(sim.buildings.indexOf(station),1);
          assert.equal(sim.workerMaxHp(replacement),data.WORKER_HP,"an invalid station cannot keep the kit alive");
          step();
          assert.equal(replacement.job,"free","a garrison that left the world must release its guard");
          assert.equal(replacement.jobTarget,null);assert.equal(replacement.hp,data.WORKER_HP);
          sim.validateSimulationInvariants();
        }
        // Manual jobs persist through idleness and node loss instead of resolving to free.
        reset();{const baseHauler=worker("haul",data.BASE,data.BASE.x,data.BASE.y+5),harvester=worker("harvest",{node:null,kind:"wood"},400,400);sim.state.workers.push(baseHauler,harvester);sweep();step(60);assert.equal(baseHauler.job,"haul","a manual hauler waits at its storage instead of going free");assert.equal(baseHauler.jobTarget,data.BASE);assert.equal(harvester.job,"harvest","a manual harvester keeps its job while no node is available");}
        // The scheduler respects in-flight reservations owned by other workers.
        reset();{const store=building("stockpile",300,300),site=building("tower",700,700,false,{wood:99,stone:0}),owner=worker("build",site,700,700),claimed=drop("wood",310,300),idle=freeWorker(320,300);owner.taskTarget=claimed;claimed.claimedBy=owner;sim.buildings.push(store,site);sim.resourceDrops.push(claimed);sim.state.workers.push(owner,idle);sweep();assert.equal(claimed.claimedBy,owner,"a claimed drop must not be re-reserved");assert.equal(idle.job,"free","the only candidate was claimed, so the worker stays free");}
        // A full stockpile is no hauling destination: capacity is checked before the drop is chosen.
        reset();{const store=building("stockpile",300,300),one=worker("haul",store,600,600),two=worker("haul",store,610,610),loose=drop("wood",310,300),idle=freeWorker(320,300);one.carried.wood=two.carried.wood=data.WORKER_CARRY;one.returning=two.returning=true;one.postX=two.postX=store.x;one.postY=two.postY=store.y+18;sim.buildings.push(store);sim.resourceDrops.push(loose);sim.state.workers.push(one,two,idle);sweep();assert.equal(idle.job,"free","a staffed-out stockpile must not accept autonomous haulers");assert.equal(loose.claimedBy,undefined);}
        // Sustained autonomous economy: several free workers against competing blueprints, bounded
        // nodes that deplete, a stockpile for hauling, and periodic hostile pressure forcing combat
        // interruptions and death/replacement — invariants checked throughout.
        reset();{
          // Node fixtures must satisfy the cell-alignment and on-land invariants, so the whole camp
          // anchors on a scanned patch of authored land and every node sits on a real cell center.
          let anchorCell=null;
          for(let cy=8;cy<40&&!anchorCell;cy++)for(let cx=8;cx<80;cx++){const p=cellToWorld(cx,cy);if(sim.terrainWorldRectEntirelyOnLand({x:p.x-200,y:p.y-200,w:432,h:432})){anchorCell={cx,cy};break;}}
          assert.ok(anchorCell,"the sustained-economy test needs a land patch");
          const anchor=cellToWorld(anchorCell.cx,anchorCell.cy);
          const house=building("house",anchor.x,anchor.y),store=building("stockpile",anchor.x,anchor.y+64),siteA=building("lumber",anchor.x-96,anchor.y,false,{wood:4,stone:0}),siteB=building("quarry",anchor.x+96,anchor.y,false,{wood:0,stone:4});
          house.spawnTimer=0;sim.DBG.instantWorkers=true;sim.buildings.push(house,store,siteA,siteB);
          for(const [dx,dy] of [[-2,2],[-1,-2],[-4,1]]){const p=cellToWorld(anchorCell.cx+dx,anchorCell.cy+dy);sim.trees.push({x:p.x,y:p.y,hp:2,max:2,stump:0,shake:0});}
          for(const [dx,dy] of [[2,2],[4,-2],[5,1]]){const p=cellToWorld(anchorCell.cx+dx,anchorCell.cy+dy);sim.rocks.push({x:p.x,y:p.y,hp:2,max:2,depleted:0,shake:0});}
          for(let i=0;i<5400;i++){
            if(i>0&&i%900===0){sim.spawnEnemy("raider");const raider=sim.state.enemies.at(-1);raider.x=anchor.x+20;raider.y=anchor.y+20;}
            sim.update(1/60);
            if(i%120===0)sim.validateSimulationInvariants();
          }
          sim.validateSimulationInvariants();
          assert.equal(siteA.complete,true,"free workers must finish the competing lumber blueprint");
          assert.equal(siteB.complete,true,"free workers must finish the competing quarry blueprint");
          assert.equal(sim.trees.some(t=>t.stump>0)||sim.rocks.some(r=>r.depleted>0),true,"the bounded nodes must have been worked");
          assert.ok(sim.state.workers.length>=data.HOUSE_SLOTS-1&&sim.state.workers.length<=data.HOUSE_SLOTS,"death/replacement must keep the house population");
          assert.equal(sim.state.workers.every(item=>["free","build","haul","harvest"].includes(item.job)),true,"with no garrison standing, an autonomous run may never mint guards or staff");
        }
        console.log(JSON.stringify({checks:86}));
      }finally{Math.random=old;}
    `
  }).trim());
  const xpResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import {BASE,FEED_XP,RESOURCE_KINDS,LEVEL_CURVE,SKILL_POINT_LEVELS} from "./src/game/data.js";
      import {cardById} from "./src/game/cards.js";
      const counts=()=>Object.fromEntries(RESOURCE_KINDS.map(kind=>[kind,0]));
      const worker=(load)=>({x:BASE.x,y:BASE.y,postX:BASE.x,postY:BASE.y,spawnSource:null,job:"haul",jobTarget:BASE,autonomous:false,taskTarget:null,selfSupply:null,returning:true,starved:false,carried:{...counts(),...load},hp:5,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0});
      const cost=level=>LEVEL_CURVE.base*LEVEL_CURVE.growth**level;
      // Draining must not disturb the wave checks below, so the two schedule-bending cards are avoided.
      const skip=new Set(["calmNight","longDay"]);
      const drain=()=>{let taken=0;while(sim.draftPending()){const offer=sim.draftPending(),kind=sim.draftKind();assert.ok(offer.length>0&&offer.length<=3);assert.equal(new Set(offer).size,offer.length,"draft offered a duplicate card");assert.equal(offer.every(id=>cardById[id].inPool&&cardById[id].implemented),true,"draft offered a card that is not in the pool");assert.equal(offer.every(id=>kind==="level"?cardById[id].category==="build":cardById[id].category==="buff"),true,"draft mixed building and permanent-upgrade pools");assert.equal(sim.chooseDraft(Math.max(0,offer.findIndex(id=>!skip.has(id)))),true);taken++;}return taken;};
      sim.initializeRunMode("normal");assert.equal(sim.xp(),0);assert.equal(sim.skillPoints(),0);assert.equal(sim.waveTier(),0);
      assert.deepEqual(sim.levelState(),{level:0,xp:0,next:cost(0)});assert.equal(sim.draftPending(),null);assert.equal(sim.chooseDraft(0),false);
      sim.state.carried.wood=5;sim.setPointerWorld(BASE.x,BASE.y);sim.secondaryRelease();assert.equal(sim.xp(),5);assert.equal(sim.state.carried.wood,0);assert.equal(sim.state.level,0);assert.equal(sim.draftPending(),null,"a partial level must not deal a draft");
      // 12 xp in one deposit crosses levels 1 AND 2; the first offer is live and the rest are queued.
      const hauler=worker({diamond:1});sim.state.workers.push(hauler);sim.update(1/60);assert.equal(sim.xp(),5+FEED_XP.diamond);assert.equal(hauler.carried.diamond,0);
      assert.equal(sim.state.level,2);assert.equal(sim.state.draft.queue,1);assert.equal(sim.levelState().xp,17-cost(0)-cost(1));assert.equal(sim.levelState().next,cost(2));
      const firstOffer=sim.draftPending();assert.equal(firstOffer.length,3);assert.equal(new Set(firstOffer).size,3);assert.equal(firstOffer.every(id=>cardById[id].inPool&&cardById[id].category==="build"),true,"level-up offered something other than a build");
      assert.equal(sim.chooseDraft(3),false);assert.equal(sim.chooseDraft(-1),false);assert.equal(sim.draftPending(),firstOffer,"a rejected pick must not consume the offer");
      // The world is frozen while an offer pends, and only the queue drain lets time move again.
      const frozen=sim.state.clock.elapsed;for(let i=0;i<60;i++)sim.update(1/60);assert.equal(sim.state.clock.elapsed,frozen,"the world advanced under a pending draft");
      assert.equal(sim.chooseDraft(Math.max(0,firstOffer.findIndex(id=>!skip.has(id)))),true);assert.notEqual(sim.draftPending(),firstOffer,"the queued level-up must replace the consumed offer");
      assert.equal(drain()>0,true);assert.equal(sim.draftPending(),null);assert.equal(sim.state.draftPaused,false);
      for(let i=0;i<60;i++)sim.update(1/60);assert.ok(sim.state.clock.elapsed>frozen,"the world stayed frozen after the draft was consumed");
      assert.equal(sim.debugGrantXp(0),false);assert.equal(sim.debugGrantXp(-1),false);assert.equal(sim.debugGrantXp(1.5),false);assert.equal(sim.debugGrantXp(Number.MAX_SAFE_INTEGER),false);assert.equal(sim.debugGrantXp(Number.MAX_SAFE_INTEGER+1),false);assert.equal(sim.xp(),17);
      // One skill point every SKILL_POINT_LEVELS levels, and the wave tier is level/3 capped at 4.
      assert.equal(sim.skillPoints(),0);while(sim.state.level<SKILL_POINT_LEVELS){sim.debugGrantXp(1);drain();}assert.equal(sim.skillPoints(),1);
      while(sim.state.level<6){sim.debugGrantXp(1);drain();}assert.equal(sim.waveTier(),2);assert.equal(sim.skillPoints(),1);
      const first=sim.skillTreeNodes().find(node=>node.status==="available");assert.equal(sim.selectSkillNode(first.id),true);assert.equal(sim.skillPoints(),0);assert.equal(sim.selectSkillNode(sim.skillTreeNodes().find(node=>node.status==="available").id),false);
      sim.DBG.invulnBase=true;sim.debugStartWave("twoFront");const wave=sim.state.nightWave,plan=wave.activePlan,budget=wave.threatBudget;assert.equal(budget,sim.waveThreatBudget(1));assert.equal(plan.entries.reduce((sum,entry)=>sum+entry.threatCost,0),budget);sim.update(.01);assert.equal(sim.state.enemies[0].waveNightNumber,wave.activeNightNumber);sim.state.enemies.length=0;sim.update(.01);assert.equal(sim.state.clock.phase,"night","an early clear skipped later scheduled spawns");
      sim.debugGrantXp(2000);drain();assert.equal(sim.waveTier(),4);assert.equal(wave.activePlan,plan,"active wave plan changed after leveling");assert.equal(wave.threatBudget,budget);
      while(wave.remainingSpawns>0){const next=plan.entries[wave.totalSpawns-wave.remainingSpawns];sim.update(Math.max(.001,next.at-wave.elapsed+.001));assert.equal(sim.state.enemies.length,1);assert.equal(sim.state.enemies[0].waveNightNumber,wave.activeNightNumber,"scheduled enemy lost wave membership");sim.state.enemies.length=0;}assert.equal(wave.spawnedThreat,budget);
      // The cap holds however far the level runs.
      sim.debugGrantXp(2000000);drain();assert.ok(sim.state.level>=30);assert.equal(sim.waveTier(),4);
      sim.validateSimulationInvariants();console.log(JSON.stringify({checks:44,waveSpawns:wave.totalSpawns,waveThreat:budget,level:sim.state.level}));
    `
  }).trim());
  const tierOneResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";import * as sim from "./src/game/simulation.js";
      // Level 3 unlocks the healer pool; wave number—not level—owns its Threat Budget.
      sim.initializeRunMode("normal");sim.debugGrantXp(22);assert.equal(sim.state.level,3);assert.equal(sim.waveTier(),1);sim.debugStartWave("healerEscort");assert.equal(sim.state.nightWave.activePlan.sourceId,"healerEscort");assert.equal(sim.state.nightWave.threatBudget,sim.waveThreatBudget(1));console.log(JSON.stringify({threat:sim.state.nightWave.threatBudget}));
    `
  }).trim());
  // A calm night measurably shrinks the NEXT wave, and only that one.
  const calmResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";import * as sim from "./src/game/simulation.js";
      import {CARD_CONSUMABLES} from "./src/game/data.js";
      let seed=0x0ca1;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      try{
        sim.initializeRunMode("normal");
        // Consumables currently enter only through explicit/debug deals; their play semantics remain intact.
        const drainOffers=()=>{while(sim.draftPending())sim.chooseDraft(0);};
        assert.equal(sim.debugDealCard("calmNight"),true);
        assert.ok(sim.hand().some(entry=>entry.id==="calmNight"));
        assert.equal(sim.state.draft.calmNight,false,"a card in hand must not have applied itself");
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="calmNight")),"applied");
        assert.equal(sim.state.draft.calmNight,true);
        const plain=sim.waveThreatBudget(1);
        if(sim.state.clock.phase==="night"){sim.transitionPhase();drainOffers();}
        sim.transitionPhase();const calm=sim.state.nightWave.threatBudget;
        assert.equal(calm,Math.max(1,Math.floor(plain*CARD_CONSUMABLES.calmNightFactor)));assert.ok(calm<plain);
        sim.transitionPhase();drainOffers();sim.transitionPhase();assert.equal(sim.state.nightWave.threatBudget,sim.waveThreatBudget(2),"the discount must not carry into a second night");
        console.log(JSON.stringify({plain,calm,levels:sim.state.level}));
      }finally{Math.random=old;}
    `
  }).trim());
  assert.ok(calmResult.calm<calmResult.plain);
  // Night has no duration gate: cap-delayed schedules, surviving wave enemies, manual enemies,
  // pause and game over each exercise the two-part clearance predicate in a clean process.
  const waveClearanceResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import {DAY_DURATION,NIGHT_ENEMY_CAP} from "./src/game/data.js";
      let seed=0xc1ea;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      try{
        sim.initializeRunMode("normal");sim.DBG.invulnBase=true;
        sim.update(DAY_DURATION-1);assert.equal(sim.state.clock.phase,"day");assert.equal(sim.state.clock.remaining,1);sim.update(1);assert.equal(sim.state.clock.phase,"night","the day countdown did not reach dusk at 75 seconds");
        sim.debugStartWave("raiderRush");const wave=sim.state.nightWave,night=wave.activeNightNumber,scheduled=wave.totalSpawns;
        assert.equal(sim.state.clock.phase,"night");assert.equal(sim.state.clock.remaining,0);assert.ok(Number.isInteger(night)&&night>0);
        for(let i=0;i<NIGHT_ENEMY_CAP;i++)sim.spawnEnemy("raider");
        assert.equal(sim.state.enemies.every(enemy=>enemy.waveNightNumber===undefined),true,"manual enemies joined the active wave");
        assert.equal(sim.livingActiveWaveEnemies(),0);
        const beforePause={elapsed:wave.elapsed,remaining:wave.remainingSpawns,run:sim.state.clock.elapsed};
        sim.togglePause();sim.update(60);assert.deepEqual({elapsed:wave.elapsed,remaining:wave.remainingSpawns,run:sim.state.clock.elapsed},beforePause,"pause advanced the wave");sim.togglePause();
        sim.update(46);assert.equal(sim.state.clock.phase,"night","the former fixed boundary ended night");assert.equal(sim.state.clock.remaining,0);assert.equal(wave.remainingSpawns,scheduled,"the enemy cap failed to delay scheduled spawns");
        sim.state.enemies.length=0;sim.update(.01);
        assert.equal(wave.remainingSpawns,0);assert.equal(sim.livingActiveWaveEnemies(),scheduled);assert.equal(sim.state.enemies.every(enemy=>enemy.waveNightNumber===night),true,"scheduled spawn lost active-wave membership");
        // Exhausted schedule is insufficient while one wave member survives.
        const survivor=sim.state.enemies[0];sim.state.enemies.splice(1);sim.update(10);
        assert.equal(sim.state.clock.phase,"night");assert.equal(sim.livingActiveWaveEnemies(),1);assert.equal(sim.state.clock.remaining,0);
        // A debugger enemy is allowed to remain at dawn. Game over and pause still suppress updates.
        sim.state.enemies.splice(sim.state.enemies.indexOf(survivor),1);assert.equal(sim.spawnEnemy("healer"),undefined,"manual spawn command changed its return contract");const manual=sim.state.enemies.at(-1);assert.equal(manual.waveNightNumber,undefined);assert.equal(sim.livingActiveWaveEnemies(),0);
        sim.state.gameOver=true;sim.update(1);assert.equal(sim.state.clock.phase,"night","game over transitioned to dawn");sim.state.gameOver=false;
        sim.togglePause();sim.update(1);assert.equal(sim.state.clock.phase,"night","pause transitioned to dawn");sim.togglePause();
        sim.update(1/60);assert.equal(sim.state.clock.phase,"day");assert.equal(sim.state.clock.completedNights,1);assert.equal(wave.activeNightNumber,null);assert.equal(sim.state.enemies.includes(manual),true,"manual enemy blocked or disappeared at dawn");
        assert.equal(sim.draftKind(),"dawn");const reward=sim.draftPending();assert.ok(reward);sim.update(10);assert.equal(sim.state.clock.completedNights,1);assert.equal(sim.draftPending(),reward,"clearance duplicated the dawn reward");
        sim.validateSimulationInvariants();
        console.log(JSON.stringify({night,elapsed:wave.elapsed,spawns:scheduled,rewards:1,manualSurvived:sim.state.enemies.includes(manual)}));
      }finally{Math.random=old;}
    `
  }).trim());
  assert.equal(waveClearanceResult.rewards,1);assert.equal(waveClearanceResult.manualSurvived,true);assert.ok(waveClearanceResult.elapsed>45);
  const hudResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      const elements=new Map();
      const element=id=>elements.get(id)||elements.set(id,{id,textContent:"",hidden:false,style:{},dataset:{},children:[],classList:{toggle(){},contains(){return false;}},replaceChildren(){this.children.length=0;},appendChild(child){this.children.push(child);}}).get(id);
      globalThis.document={getElementById:element,createElement:()=>({textContent:""})};
      const {syncPhaseHud}=await import("./src/ui/hud.js");
      sim.initializeRunMode("normal");sim.DBG.invulnBase=true;syncPhaseHud();
      assert.equal(element("phaseTime").textContent,"1:15");assert.equal(element("phaseProgressFill").style.width,"0.00%");
      sim.debugStartWave("raiderRush");sim.update(.01);syncPhaseHud();
      assert.match(element("phaseTime").textContent,/^elapsed 0:00$/);assert.match(element("forecastRemaining").textContent,/1 wave enemy alive · 11 scheduled spawns remaining/);assert.equal(element("phaseProgressFill").style.width,"0.00%");
      sim.update(30);sim.state.enemies.splice(1);syncPhaseHud();
      assert.match(element("forecastRemaining").textContent,/1 wave enemy alive · 0 scheduled spawns remaining/);assert.equal(element("phaseProgressFill").style.width,"91.67%");
      sim.state.enemies.length=0;syncPhaseHud();assert.equal(element("forecastRemaining").textContent,"wave clear · 0 enemies alive · 0 scheduled spawns remaining");assert.equal(element("phaseProgressFill").style.width,"100.00%");const clear=element("phaseProgressFill").style.width;
      sim.update(1/60);syncPhaseHud();assert.equal(element("phaseName").textContent,"day 2");assert.equal(element("phaseTime").textContent,"1:15");
      console.log(JSON.stringify({spawning:"1/11",survivor:"1/0",clear,day:element("phaseTime").textContent}));
    `
  }).trim());
  assert.equal(hudResult.spawning,"1/11");assert.equal(hudResult.survivor,"1/0");assert.equal(hudResult.clear,"100.00%");assert.equal(hudResult.day,"1:15");
  // A drafted buff must move a MEASURED number, not just a ledger entry.
  const buffResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";import * as sim from "./src/game/simulation.js";
      import {CARD_BUFFS} from "./src/game/data.js";
      let seed=0xb0ff;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      try{
        sim.initializeRunMode("normal");sim.TUNE.chopTime=1;
        const tree=sim.trees[0];
        // Hold the same chop for a tenth of a second: the bar's fill IS the buffed rate.
        const fill=()=>{sim.setPointerWorld(tree.x,tree.y);sim.primaryPress();sim.update(.1);const progress=sim.chopProgress();sim.primaryRelease();return progress;};
        const before=fill(),baseRadius=sim.vacuumRadius();
        const queueDawn=()=>{if(sim.state.clock.phase==="day")sim.transitionPhase();sim.transitionPhase();};
        let guard=0;
        while(sim.buffStacks("clickSpeed")<2&&guard++<600){
          if(!sim.draftPending())queueDawn();
          const offer=sim.draftPending();if(!offer)continue;assert.equal(sim.draftKind(),"dawn");
          const at=offer.indexOf("clickSpeed");sim.chooseDraft(at>=0?at:Math.max(0,offer.findIndex(id=>id!=="clickSpeed")));
        }
        assert.equal(sim.buffStacks("clickSpeed"),2,"clickSpeed never appeared twice in a draft");
        // The queued offers must not sneak in a third stack, or the measurement below would drift.
        while(sim.draftPending()){const offer=sim.draftPending();sim.chooseDraft(Math.max(0,offer.findIndex(id=>!["calmNight","longDay","clickSpeed"].includes(id))));}
        assert.equal(sim.buffStacks("clickSpeed"),2);
        const after=fill();
        assert.ok(Math.abs(after/before-CARD_BUFFS.clickSpeed**2)<1e-9,"two clickSpeed stacks must compound to 1.2544x");
        assert.equal(sim.vacuumRadius(),baseRadius+CARD_BUFFS.vacuumRadius*sim.buffStacks("vacuumRadius"));
        assert.equal(sim.TUNE.vacuumRadius,45,"a card must never write the authored tuning value");
        while(sim.buffStacks("critClicks")<1&&guard++<1200){
          if(!sim.draftPending())queueDawn();
          const offer=sim.draftPending();if(!offer)continue;assert.equal(sim.draftKind(),"dawn");
          const at=offer.indexOf("critClicks");sim.chooseDraft(at>=0?at:Math.max(0,offer.findIndex(id=>id!=="critClicks")));
        }
        assert.equal(sim.buffStacks("critClicks"),1,"critClicks never appeared in a draft");
        while(sim.draftPending())sim.chooseDraft(0);
        // Isolate crit yield: a randomly drafted Free Hit correctly adds a second full chop.
        delete sim.state.draft.buffs.freeHit;
        Math.random=()=>0;const dropsBefore=sim.resourceDrops.length;
        sim.setPointerWorld(tree.x,tree.y);sim.primaryPress();sim.update(1);sim.primaryRelease();
        const critDrops=sim.resourceDrops.length-dropsBefore;
        assert.equal(critDrops,sim.TUNE.chopYield+1,"a resource crit must add exactly one drop");
        assert.equal(sim.damageNumbers.at(-1).critical,true,"the critical resource drop disagrees with its damage number");
        sim.validateSimulationInvariants();
        console.log(JSON.stringify({before,after,ratio:after/before,stacks:sim.buffStacks("clickSpeed"),critDrops}));
      }finally{Math.random=old;}
    `
  }).trim());
  assert.ok(Math.abs(buffResult.ratio-1.2544)<1e-9);
  // ── the hand ──
  // Drafting, dawn rewards, playing, targeting, partial kits and build placements, all measured in
  // one clean process: a card is only ever an effect once the player plays it.
  const handResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import * as data from "./src/game/data.js";
      import {CARDS,cardById} from "./src/game/cards.js";
      import {snapToCellCenter} from "./src/game/grid.js";
      let seed=0xcafd;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      let handEvents=0;sim.connect({handChanged(){handEvents++;}});
      const counts=()=>Object.fromEntries(data.RESOURCE_KINDS.map(kind=>[kind,0]));
      const clearGround=()=>{sim.trees.length=sim.rocks.length=sim.diamonds.length=sim.chests.length=sim.buildings.length=sim.state.enemies.length=sim.resourceDrops.length=0;};
      const drain=()=>{while(sim.draftPending())sim.chooseDraft(0);};
      const held=id=>sim.hand().find(entry=>entry.id===id)||null;
      const placementAnchor=(x,y)=>{const wanted=snapToCellCenter(x,y);if(sim.canPlace(wanted.x,wanted.y,sim.state.buildMode))return wanted;let best=null,bestDistance=Infinity;for(let cy=64;cy<data.H-64;cy+=data.CELL)for(let cx=64;cx<data.W-64;cx+=data.CELL)if(sim.canPlace(cx,cy,sim.state.buildMode)){const d=Math.hypot(cx-x,cy-y);if(d<bestDistance){best={x:cx,y:cy};bestDistance=d;}}assert.ok(best,"no land placement anchor");return best;};
      const place=(x,y)=>{const anchor=placementAnchor(x,y);sim.setPointerWorld(anchor.x,anchor.y);sim.primaryPress();sim.primaryRelease();return anchor;};
      try{
        sim.initializeRunMode("normal");clearGround();
        // 0 · the opening kit, and the debug command that takes it away again
        assert.deepEqual(sim.hand().map(entry=>entry.id),["bpHouse","bpTower"],"a normal run must open with the seed kit: workers and the first tower");
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpTower")),"targeting","a seeded card must play like any other");
        assert.equal(sim.state.buildMode,"tower");assert.equal(sim.cancelBuildMode(),true);
        assert.equal(sim.debugClearHand(),2,"clearing the hand must report what it dropped");
        assert.deepEqual(sim.hand(),[],"debugClearHand must empty the hand");
        assert.equal(sim.state.cardTargeting,null);assert.equal(sim.state.buildMode,null);
        assert.equal(sim.debugClearHand(),0,"clearing an empty hand is a no-op");
        assert.equal(sim.draftKind(),null);
        assert.equal(sim.playCard(0),false,"an empty hand plays nothing");assert.equal(sim.playCard(-1),false);assert.equal(sim.playCard(.5),false);

        // 1 · level-up rewards are builds that enter the hand
        sim.debugGrantXp(400);
        const levelOffer=sim.draftPending();assert.ok(levelOffer);assert.equal(sim.draftKind(),"level");
        assert.equal(levelOffer.every(id=>cardById[id].category==="build"),true,"level-up offered non-building loot");
        const drafted=levelOffer[0],eventsBeforeBlueprint=handEvents;
        assert.equal(sim.chooseDraft(0),true);assert.ok(held(drafted));
        assert.ok(handEvents>eventsBeforeBlueprint,"a level blueprint should enter the hand");
        drain();assert.equal(sim.state.draftPaused,false);

        // 2 · dawn pays one permanent-buff pick-3 after the wave
        if(sim.state.clock.phase!=="night")sim.transitionPhase();
        assert.equal(sim.state.clock.phase,"night");
        sim.transitionPhase();
        const dawnOffer=sim.draftPending();
        assert.ok(dawnOffer,"the night ended and paid no dawn reward");
        assert.equal(sim.draftKind(),"dawn");assert.equal(sim.state.draftPaused,true);
        assert.equal(dawnOffer.length,3);assert.equal(new Set(dawnOffer).size,3,"the dawn offer repeated a card");
        assert.equal(dawnOffer.every(id=>cardById[id].category==="buff"&&cardById[id].inPool),true,"a dawn offer may only deal permanent buffs");
        assert.equal(sim.playCard(0),false,"a frozen world must not play cards");
        const dawnCard=dawnOffer[0],eventsBeforeDawn=handEvents,stacksBefore=sim.buffStacks(dawnCard);
        assert.equal(sim.chooseDraft(0),true);assert.equal(sim.buffStacks(dawnCard),stacksBefore+1);
        assert.equal(handEvents,eventsBeforeDawn,"a dawn buff should not enter the hand");
        assert.equal(sim.draftKind(),null);assert.equal(sim.state.draftPaused,false);

        // 3 · an untargeted consumable applies on play and leaves the hand
        assert.equal(sim.debugDealCard("woodBundle"),true);
        const woodBefore=sim.state.stored.wood,copies=held("woodBundle").count,eventsBeforePlay=handEvents;
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="woodBundle")),"applied");
        assert.equal(sim.state.stored.wood,woodBefore+data.CARD_CONSUMABLES.woodBundle,"woodBundle did not deliver");
        assert.equal(held("woodBundle")?.count??0,copies-1,"playing a card must thin its stack");
        assert.ok(handEvents>eventsBeforePlay,"spending a card must raise handChanged()");

        // 4 · a kit targets, spends one charge per placement, survives a cancel, and leaves on the last
        clearGround();
        sim.debugClearHand(); // drafted strays (seeded draft luck) must not shadow the dealt kit
        assert.equal(sim.debugDealCard("spikeKit"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="spikeKit")),"targeting");
        assert.equal(sim.state.buildMode,"spikes");assert.equal(held("spikeKit").charges,cardById.spikeKit.charges);
        assert.equal(sim.playCard(0),false,"nothing else may play while a card is targeting");
        place(300,300);
        assert.equal(held("spikeKit").charges,2);assert.equal(sim.buildings.length,1);
        sim.secondaryPress();
        assert.equal(sim.state.buildMode,null);assert.equal(sim.state.cardTargeting,null);
        assert.equal(held("spikeKit").charges,2,"a cancelled kit must keep its unplaced charges");
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="spikeKit")),"targeting");
        place(364,300);assert.equal(held("spikeKit").charges,1);
        place(428,300);
        assert.equal(held("spikeKit"),null,"the kit must leave the hand as its last charge lands");
        assert.equal(sim.state.buildMode,null);assert.equal(sim.state.cardTargeting,null);
        assert.equal(sim.buildings.filter(item=>item.type==="spikes").length,3,"three charges must place three traps");
        assert.equal(sim.buildings.every(item=>item.complete),true,"card-placed traps must be finished");
        assert.equal("buildStacks" in sim.state,false,"the dock's stack counters must be gone with the dock");

        // 5 · the fireball burns inside its radius, spares what is outside it, and leaves nothing
        clearGround();
        sim.spawnEnemy("raider");sim.spawnEnemy("raider");
        const near=sim.state.enemies[0],far=sim.state.enemies[1];
        assert.equal(sim.debugDealCard("fireball"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="fireball")),"targeting");
        const anchor=placementAnchor(600,300);
        near.x=anchor.x;near.y=anchor.y+100;far.x=anchor.x;far.y=anchor.y+200;
        const nearRange=sim.distance(anchor.x,anchor.y,near.x,near.y),farRange=sim.distance(anchor.x,anchor.y,far.x,far.y);
        assert.ok(nearRange<=data.FIREBALL.radius&&farRange>data.FIREBALL.radius,"the fireball test targets are not on both sides of the radius");
        assert.ok(data.FIREBALL.damage>=data.ENEMY_TYPES.raider.hp,"the fireball must be lethal to a raider for this measurement");
        const buildingsBefore=sim.buildings.length,farHp=far.hp;
        place(anchor.x,anchor.y);
        assert.equal(sim.buildings.length,buildingsBefore,"a fireball must leave no building behind");
        assert.equal(sim.state.enemies.includes(near),false,"the fireball spared a raider inside its radius");
        assert.equal(far.hp,farHp,"the fireball reached past its radius");
        assert.equal(held("fireball"),null);assert.equal(sim.state.buildMode,null);

        // 6 · a fancy-tower card lands one CONSTRUCTION SITE. Its one displayed cost is exactly the
        //     basic chassis plus variant materials, and completing it directly produces that variant.
        clearGround();for(const kind of data.RESOURCE_KINDS)sim.state.stored[kind]=0;
        assert.equal(sim.DBG.freeCosts,false);
        assert.equal(sim.debugDealCard("bpSniper"),true);
        // the cancel path first: the card comes back to hand with its charge unspent
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpSniper")),"targeting");
        assert.equal(sim.state.buildMode,"tower","a build card must arm the tower footprint");
        assert.equal(sim.cancelBuildMode(),true);
        assert.equal(sim.state.cardTargeting,null);assert.equal(held("bpSniper")?.charges,1,"a cancelled build must keep its charge");
        const storedBeforeBlueprint=JSON.stringify(sim.state.stored);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpSniper")),"targeting");
        const sniperAnchor=place(300,300);
        const sniper=sim.buildings.at(-1);
        assert.equal(sim.buildings.length,1,"the build placed nothing, or placed twice");
        assert.equal(sniper.type,"tower");assert.equal(sniper.x,sniperAnchor.x);assert.equal(sniper.y,sniperAnchor.y);
        assert.equal(sniper.complete,false,"a build card must land a site, not a finished tower");
        assert.equal(sniper.tower,null);assert.equal(sniper.activeUpgrade,null,"an unfinished tower exposed an upgrade job");
        assert.equal(sniper.plannedVariant,"sniper","the site was not promised to the card's variant");
        assert.deepEqual(sniper.delivered,counts(),"a fresh site has been delivered nothing");
        const sniperCost=Object.fromEntries(data.RESOURCE_KINDS.map(kind=>[kind,(data.BUILDING_TYPES.tower.cost[kind]||0)+(data.TOWER_VARIANTS.sniper.cost[kind]||0)]));
        assert.deepEqual(sniper.cost,sniperCost,"the site must combine chassis and variant materials");
        assert.equal(JSON.stringify(sim.state.stored),storedBeforeBlueprint,"placing a site must not touch storage");
        assert.equal(held("bpSniper"),null,"the build must leave the hand as its site lands");
        assert.equal(sim.state.buildMode,null);assert.equal(sim.state.cardTargeting,null);
        sim.validateSimulationInvariants();
        // One delivery fills the one site and produces the requested full-health tower.
        const deliver=(building,cost)=>{
          for(const kind of data.RESOURCE_KINDS)sim.state.carried[kind]=cost[kind]||0;
          sim.setPointerWorld(building.x,building.y);sim.secondaryRelease();
        };
        deliver(sniper,sniperCost);
        assert.equal(sniper.complete,true,"the combined cost did not finish the site");
        assert.equal(sniper.tower.variant,"sniper");assert.equal(sniper.plannedVariant,null,"the designation must be spent on completion");
        assert.equal(sniper.activeUpgrade,null,"completion created an unwanted second build");
        assert.equal(sniper.tower.maxHp,data.TOWER_VARIANTS.sniper.maxHp);
        assert.equal(sniper.tower.hp,data.TOWER_VARIANTS.sniper.maxHp,"a finished variant tower must be at full hp");
        assert.deepEqual(sim.state.carried,counts(),"the delivery spent exactly the authored costs");
        assert.equal(JSON.stringify(sim.state.stored),storedBeforeBlueprint,"deliveries come from the hand, never from storage");

        // 7 · the obelisk build drops an obelisk SITE at its authored cost, card spent
        clearGround();
        assert.equal(sim.debugDealCard("bpObelisk"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpObelisk")),"targeting");
        assert.equal(sim.state.buildMode,"obelisk");
        place(500,600);
        const obelisk=sim.buildings.at(-1);
        assert.equal(obelisk.type,"obelisk");assert.equal(obelisk.complete,false,"the obelisk card must land a site to fill");
        assert.equal(obelisk.plannedVariant,null,"only a tower card designates a variant");
        assert.deepEqual(obelisk.delivered,counts());
        assert.deepEqual(obelisk.cost,data.BUILDING_TYPES.obelisk.cost,"a card must not rewrite an authored cost");
        assert.equal(held("bpObelisk"),null,"the card is spent when the site is placed");
        deliver(obelisk,data.BUILDING_TYPES.obelisk.cost);
        assert.equal(obelisk.complete,true,"the authored obelisk cost did not finish the site");
        // a build is not an unlock: the SAME card again lands a second, equally unpaid site
        assert.equal(sim.debugDealCard("bpObelisk"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpObelisk")),"targeting");
        place(500,700);
        const secondObelisk=sim.buildings.at(-1);
        assert.notEqual(secondObelisk,obelisk,"the second obelisk card placed nothing");
        assert.equal(secondObelisk.complete,false,"a repeated build must still be paid for");

        // 7b · a build stays in the POOL after it is taken, so later offers may deal it again
        {
          const before=sim.hand().length;
          let repeats=0,guardPool=0,seen=null;
          while(repeats<2&&guardPool++<900){
            if(!sim.draftPending())sim.debugGrantXp(400);
            const offer=sim.draftPending();if(!offer)continue;
            assert.equal(sim.draftKind(),"level","builds must come from XP rewards");
            const at=seen===null?offer.findIndex(id=>cardById[id].category==="build"):offer.indexOf(seen);
            if(at<0){sim.chooseDraft(0);continue;}
            if(seen===null)seen=offer[at];
            sim.chooseDraft(at);repeats++;
          }
          assert.equal(repeats,2,"a taken build never came back in a later offer");
          assert.ok(seen&&cardById[seen].category==="build");
          assert.equal(sim.hand().find(entry=>entry.id===seen).count>=2||sim.hand().length>before,true,"the second copy never reached the hand");
          drain();
        }

        // 7c · the house card charges the ESCALATED price, exactly as the dock's house button did
        {
          clearGround();sim.debugClearHand();
          const houseAt=(x,y)=>{
            assert.equal(sim.debugDealCard("bpHouse"),true);
            assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpHouse")),"targeting");
            place(x,y);return sim.buildings.at(-1);
          };
          const first=houseAt(300,300);
          assert.equal(first.type,"house");
          assert.deepEqual(first.cost,{...data.STARTING_HOUSE_COST},"the first house card must charge only the starting house cost");
          deliver(first,first.cost);assert.equal(first.complete,true);
          const second=houseAt(500,300);
          assert.deepEqual(second.cost,{wood:data.HOUSE_COST.wood+data.HOUSE_COST_ESCALATION.wood,stone:data.HOUSE_COST.stone+data.HOUSE_COST_ESCALATION.stone},"the second house card must charge the escalated cost");
          assert.deepEqual(second.cost,sim.nextHouseCost(),"the site's snapshot must be nextHouseCost() at the moment it landed");
          deliver(second,second.cost);assert.equal(second.complete,true);
          assert.equal(sim.buildings.filter(item=>item.type==="house"&&item.complete).length,2);
        }

        // 8 · every consumable the pool can deal is actually playable
        clearGround();
        const playable=[];
        for(const card of CARDS.filter(item=>item.inPool&&item.category==="consumable")){
          assert.equal(sim.debugDealCard(card.id),true);
          const result=sim.playCard(sim.hand().findIndex(entry=>entry.id===card.id));
          assert.ok(result==="applied"||result==="targeting","in-pool consumable "+card.id+" is unplayable");
          if(result==="targeting"){assert.equal(sim.cancelBuildMode(),true);assert.equal(held(card.id).charges,card.charges??1,"a put-away card lost charges it never spent");}
          playable.push(card.id);
        }
        for(const entry of sim.hand()){assert.ok(cardById[entry.id]);assert.ok(entry.count>=1);assert.ok(entry.charges===null||entry.charges>0);}
        sim.validateSimulationInvariants();
        console.log(JSON.stringify({checks:99,drafted,dawnCard,playable:playable.length,nearRange:Math.round(nearRange),farRange:Math.round(farRange),stacks:sim.hand().length}));
      }finally{Math.random=old;}
    `
  }).trim());
  assert.equal(handResult.playable,cardCatalog.CARDS.filter(card=>card.inPool&&card.category==="consumable").length);
  const html=readFileSync(join(root,"index.html"),"utf8"),overlay=readFileSync(join(root,"src/render/overlay.js"),"utf8"),debuggerSource=readFileSync(join(root,"src/debug/view-debugger.js"),"utf8"),hudSource=readFileSync(join(root,"src/ui/hud.js"),"utf8"),progressionHtml=readFileSync(join(root,"docs/progression.html"),"utf8");
  assert.ok(hudSource.includes('"elapsed "+formatDuration(wave.elapsed)'),"night HUD does not present elapsed time");
  assert.ok(hudSource.includes("livingActiveWaveEnemies()")&&hudSource.includes("scheduled spawn"),"night HUD omits clearance inputs");
  assert.ok(hudSource.includes("(DAY_DURATION-clock.remaining)/DAY_DURATION"),"day HUD countdown progress drifted");
  assert.match(progressionHtml,/wave-clear estimate/);assert.match(progressionHtml,/gameplay dawn occurs only after all\s+scheduled wave enemies are defeated/);
  const viewPanel=html.slice(html.indexOf('<section id="viewPanel"'),html.indexOf('<!-- Empty showcase roots'));
  assert.equal(/<p class="hint">/.test(viewPanel),false);
  const expectedSubtabs={visibility:["scan","readability"],input:["hand","click","projectiles"],overlays:["damage","bars","badge"],gameplay:["economy","builders","time","combat","population","cards"]};
  for(const [pane,expected] of Object.entries(expectedSubtabs)){
    const body=viewPanel.match(new RegExp(`<section class="pane" data-tab="${pane}">([\\s\\S]*?)</section>`))?.[1];
    assert.ok(body,`missing view pane: ${pane}`);
    assert.deepEqual([...body.matchAll(/class="vSubpane" data-subtab="([^"]+)"/g)].map(match=>match[1]),expected);
  }
  for(const pane of ["camera","selectors"]){
    const body=viewPanel.match(new RegExp(`<section class="pane" data-tab="${pane}">([\\s\\S]*?)</section>`))?.[1];
    assert.ok(body&&!body.includes('class="vSubpane"'),`${pane} must remain ungrouped`);
  }
  // ── the build dock is gone, everywhere ──
  // Markup, styles, the HUD adapter and the simulation must all agree, or a dead selector or a
  // dangling command would sit around waiting to be re-wired by mistake.
  {
    const css=readFileSync(join(root,"styles.css"),"utf8"),hud=hudSource,simSource=readFileSync(join(root,"src/game/simulation.js"),"utf8");
    for(const [name,text] of [["index.html",html],["styles.css",css]])
      for(const token of ["buildDock","buildCards","buildTabs","dock-tab","build-category"])
        assert.equal(text.includes(token),false,`${name} still mentions the removed dock (${token})`);
    for(const token of ["toggleBuildMode","setBuildDockCategory","buildDockChanged","buildStacks","unlimitedCharges"])
      assert.equal(hud.includes(token),false,`src/ui/hud.js still reaches for ${token}`);
    for(const token of ["export function toggleBuildMode","export function setBuildDockCategory","state.buildStacks","DBG.unlimitedCharges"])
      assert.equal(simSource.includes(token),false,`src/game/simulation.js still carries ${token}`);
    assert.equal(typeof sim.toggleBuildMode,"undefined","toggleBuildMode must no longer be exported");
    assert.equal(typeof sim.setBuildDockCategory,"undefined","setBuildDockCategory must no longer be exported");
    assert.equal(typeof sim.debugClearHand,"function","the card dealer needs debugClearHand");
    // the card dealer pane and its two moving parts
    assert.match(html,/id="vCardDealer"/);assert.match(html,/id="vClearHand"/);
    assert.ok(debuggerSource.includes("function buildCardDealer()"),"the dealer grid must be generated from the registry");
    assert.ok(debuggerSource.includes('bindBtn("vClearHand"'),"clear hand is unbound");
  }
  assert.match(html,/id="vGroundSourcing" checked/);assert.match(html,/id="vBuilderSelfSupply" checked/);assert.match(html,/id="vBuilderRadius" min="60" max="1000" step="10" value="400"/);assert.match(html,/id="vFreeSearchRadius" min="100" max="1000" step="20" value="500"/,"markup default must agree with TUNE.freeSearchRadius");assert.ok(debuggerSource.includes('bindV("vBuilderSelfSupply", v => { DBG.builderSelfSupply = v; });'));assert.ok(debuggerSource.includes('bindV("vFreeSearchRadius", v => { TUNE.freeSearchRadius = v; }, v => v + "px")'));assert.ok(overlay.includes("workerOccupancyStatus(target)"));assert.ok(overlay.includes("workerOccupancyAt(state.mouse.x,state.mouse.y)"));assert.ok(overlay.includes("drawWorkerSlots(target,height,status)"));assert.ok(overlay.includes("state.workers.length>0||!!heldWorker()"));assert.match(overlay,/hollow circles are vacancies/);assert.match(overlay,/! vacant/);assert.ok(overlay.includes("const BUILD_JOB_ACCENT=css(PAL.jobBuild)"));assert.ok(overlay.includes("function drawBuilderLines()"),"the blueprint builder-link visualization must survive the free-worker rework");assert.ok(overlay.includes('hovered?.kind==="building"&&!hovered.object.complete'));assert.ok(overlay.includes('worker.job==="build"&&worker.jobTarget===site'));assert.equal(overlay.match(/if\(state\.runMode!=="normal"\)return/g)?.length,1);
  // The guard-recruitment era is fully retired: no markup control, no debug flag, no loan-marker
  // coupling and no stale terminology may survive outside intentionally historical documentation.
  {
    const simSource=readFileSync(join(root,"src/game/simulation.js"),"utf8"),sceneSource=readFileSync(join(root,"src/render/scene.js"),"utf8");
    for(const token of ["vBlueprintRecruiting","vIdleSeeksWork","vPickupRadius","vRecruitRadius","recruit radius","idle guards seek work"])
      assert.equal(html.includes(token),false,`index.html still carries the removed control ${token}`);
    for(const [name,text] of [["simulation.js",simSource],["overlay.js",overlay],["view-debugger.js",debuggerSource],["scene.js",sceneSource]])
      for(const token of ["homePost","reposting","workerIsLoaned","recruitRadius","workerPickupRadius","blueprintRecruiting","idleSeeksWork","recruit"])
        assert.equal(text.includes(token),false,`${name} still mentions the removed guard-recruitment system (${token})`);
    assert.equal(typeof sim.workerIsLoaned,"undefined","workerIsLoaned must no longer be exported");
    assert.ok(simSource.includes("function releaseWorkerToFree("),"the canonical free transition must exist");
    assert.ok(simSource.includes("function scheduleFreeWorkers("),"the free-worker scheduler must exist");
    assert.ok(sceneSource.includes('w.job==="free" ? "worker-gatherer"'),"free workers must map explicitly to the gatherer model");
  }

  const normalSteps=12000,dt=1/60;
  sim.DBG.invulnBase=true;
  const elapsedBeforeSpeed=sim.state.clock.elapsed;for(let i=0;i<3;i++)sim.update(dt);assert.ok(Math.abs(sim.state.clock.elapsed-elapsedBeforeSpeed-3*dt)<1e-9);
  const elapsedBeforePause=sim.state.clock.elapsed;sim.togglePause();for(let i=0;i<60;i++)sim.update(dt);assert.equal(sim.state.clock.elapsed,elapsedBeforePause);sim.togglePause();
  sim.pressKey("KeyD");
  // The sustained run clears a complete authored schedule once it is fully spawned. Each resulting
  // dawn deals its own reward, which is taken immediately so the simulation keeps moving.
  let dawnRewards=0;
  for(let i=0;i<normalSteps;i++){
    if(i===300)sim.releaseKey("KeyD");
    sim.update(dt);
    if(sim.state.clock.phase==="night"&&sim.state.nightWave.remainingSpawns===0&&sim.livingActiveWaveEnemies()>0)sim.debugClearEnemies();
    while(sim.draftPending()){
      const kind=sim.draftKind();assert.ok(["level","dawn"].includes(kind),"a pending offer must name its kind");
      if(kind==="dawn"){dawnRewards++;assert.equal(sim.draftPending().every(id=>cardCatalog.cardById[id].category==="buff"),true,"a dawn offer dealt something other than a permanent buff");}
      else assert.equal(sim.draftPending().every(id=>cardCatalog.cardById[id].category==="build"),true,"a level offer dealt something other than a build");
      assert.equal(sim.chooseDraft(0),true);
    }
    if(i%120===0)sim.validateSimulationInvariants();
  }
  assert.equal(sim.state.gameOver,false);assert.ok(sim.state.clock.elapsed>=normalSteps*dt);
  assert.ok(dawnRewards>=1,"the sustained run must clear a complete wave and receive its dawn reward");
  assert.equal(sim.hand().length>0,true,"the dawn rewards must be sitting in the hand");
  for(const entry of sim.hand()){assert.ok(cardCatalog.cardById[entry.id],"hand holds an unknown card");assert.ok(Number.isInteger(entry.count)&&entry.count>=1,"hand stack count must be a positive integer");}
  sim.validateSimulationInvariants();
  assert.equal(sim.damageDummies.length,0);
  assert.equal(sim.showcaseProps.length,0);

  // Levels grant the finite skill-point budget; selections spend exactly that budget. Feeding
  // deals drafts, so the queue is drained back to a running world before anything else is asked.
  assert.equal(sim.skillPoints(),0,"the stress run must not have fed the thing");
  while(sim.state.level<12){sim.debugGrantXp(40);while(sim.draftPending())assert.equal(sim.chooseDraft(0),true);}
  const budget=Math.floor(sim.state.level/data.SKILL_POINT_LEVELS);
  assert.equal(sim.skillPoints(),budget);assert.equal(sim.waveTier(),4);assert.equal(sim.state.draftPaused,false);
  let selected=0;
  while(sim.skillPoints()>0){
    const available=sim.skillTreeNodes().find(node=>node.status==="available");
    assert.ok(available);assert.equal(sim.selectSkillNode(available.id),true);selected++;
  }
  const remaining=sim.skillTreeNodes().find(node=>node.status==="available");
  assert.equal(sim.selectSkillNode(remaining.id),false);assert.equal(selected,budget);
  sim.validateSimulationInvariants();

  // A clean module process is required to test showcase because run mode is intentionally immutable.
  const showcaseResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      let seed=0x5eed1234;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      try{
        const sim=await import("./src/game/simulation.js");
        const data=await import("./src/game/data.js");
        const authored=await import("./src/game/showcase-data.js");
        sim.initializeRunMode("showcase");
        assert.throws(()=>sim.initializeRunMode("normal"),/already initialized/);
        const expected={buildings:authored.SHOWCASE_FIXTURE_COUNTS.buildings+authored.SHOWCASE_FIXTURE_COUNTS.towers+authored.SHOWCASE_FIXTURE_COUNTS.progress,chests:authored.SHOWCASE_FIXTURE_COUNTS.chests,dummies:authored.SHOWCASE_FIXTURE_COUNTS.dummies,props:authored.SHOWCASE_FIXTURE_COUNTS.props,enemies:authored.SHOWCASE_FIXTURE_COUNTS.enemies,workers:authored.SHOWCASE_FIXTURE_COUNTS.workers};
        const check=()=>{sim.validateSimulationInvariants();assert.equal(sim.buildings.length,expected.buildings);assert.equal(sim.chests.length,expected.chests);assert.equal(sim.damageDummies.length,expected.dummies);assert.equal(sim.showcaseProps.length,expected.props);assert.equal(sim.state.enemies.length,expected.enemies);assert.equal(sim.state.workers.length,expected.workers);assert.equal(sim.state.enemies.every(e=>e.displayUnit&&e.waveNightNumber===undefined),true);assert.equal(sim.state.workers.every(w=>w.displayUnit),true);assert.equal(sim.state.nightWave.activeNightNumber,null);assert.equal(sim.livingActiveWaveEnemies(),0);const terrain=sim.terrainMetadata();assert.deepEqual([terrain.terrainCellSize,terrain.terrainCols,terrain.terrainRows],[16,data.W/16,data.H/16]);for(let terrainY=0;terrainY<terrain.terrainRows;terrainY++)for(let terrainX=0;terrainX<terrain.terrainCols;terrainX++)assert.equal(sim.terrainAtRasterCell(terrainX,terrainY),"land","showcase terrain must remain authored all-land");};
        check();
        const authoredEnemies=sim.state.enemies.map(enemy=>({enemy,x:enemy.x,y:enemy.y}));for(let i=0;i<4;i++)assert.equal(sim.spawnEnemy("raider"),undefined,"showcase spawn command changed its return contract");assert.equal(sim.spawnEnemy("brute"),undefined);assert.equal(sim.state.enemies.length,authoredEnemies.length,"showcase debugger spawn added a production enemy");assert.equal(sim.state.enemies.every((enemy,index)=>enemy===authoredEnemies[index].enemy&&enemy.x===authoredEnemies[index].x&&enemy.y===authoredEnemies[index].y),true,"showcase spawn command changed authored enemy identity or position");check();
        assert.equal(sim.debugGrantXp(105),true);assert.equal(sim.xp(),105);assert.equal(sim.skillPoints(),2);assert.equal(sim.rebuildShowcase(),true);assert.equal(sim.xp(),0);assert.equal(sim.skillPoints(),0);check();
        const firstRevision=sim.showcaseLabels().revision;
        for(let i=0;i<20;i++){sim.debugGrantXp(40);assert.equal(sim.rebuildShowcase(),true);assert.equal(sim.xp(),0);assert.equal(sim.skillPoints(),0);check();}
        assert.ok(sim.showcaseLabels().revision>firstRevision);
        const prop=sim.showcaseProps[0],origin={x:prop.x,y:prop.y};sim.setPointerWorld(prop.x,prop.y);sim.secondaryPress();assert.equal(sim.heldProp(),prop);sim.setPointerWorld(data.BASE.x,data.BASE.y);sim.secondaryRelease();assert.equal(prop.x,origin.x);assert.equal(prop.y,origin.y);assert.equal(sim.showcaseProps.includes(prop),true);
        const fixtureChest=sim.chests[0],chestOrigin={x:fixtureChest.x,y:fixtureChest.y};sim.setPointerWorld(fixtureChest.x,fixtureChest.y);sim.secondaryPress();assert.equal(sim.heldChest(),fixtureChest);sim.setPointerWorld(data.BASE.x,data.BASE.y);sim.secondaryRelease();assert.deepEqual({x:fixtureChest.x,y:fixtureChest.y},chestOrigin);assert.equal(sim.chests.includes(fixtureChest),true);
        const chestLabelRevision=sim.showcaseLabels().revision,oldChopTime=sim.TUNE.chopTime,oldCapacity=sim.state.capacity;assert.equal(sim.showcaseLabels().labels.some(record=>record.entity===fixtureChest),true);sim.TUNE.chopTime=.01;sim.state.capacity=0;sim.debugForceNextChestOutcome("cache");sim.setPointerWorld(fixtureChest.x,fixtureChest.y);for(let i=0;i<4;i++){sim.primaryPress();sim.update(.02);sim.primaryRelease();}assert.equal(sim.chests.includes(fixtureChest),false);assert.ok(sim.showcaseLabels().revision>chestLabelRevision);assert.equal(sim.showcaseLabels().labels.some(record=>record.entity===fixtureChest),false,"destroyed showcase chest left stale label");sim.validateSimulationInvariants();sim.TUNE.chopTime=oldChopTime;sim.state.capacity=oldCapacity;sim.rebuildShowcase();check();
        const shock=sim.buildings.find(b=>b.type==="tower"&&b.tower.variant==="shock"),shockOrigin={x:shock.x,y:shock.y};sim.setPointerWorld(shock.x,shock.y);sim.secondaryPress();assert.equal(sim.heldBuilding(),shock);sim.rebuildShowcase();assert.equal(sim.state.heldObject,null);assert.equal(shock.x,shockOrigin.x);assert.equal(shock.y,shockOrigin.y);check();
        const dummy=sim.damageDummies[0],secondDummy=sim.damageDummies[1],oldDamage=sim.TUNE.clickDamage;sim.TUNE.clickDamage=100;sim.setPointerWorld(dummy.x,dummy.y);sim.primaryPress();for(let i=0;i<60;i++)sim.update(1/60);sim.primaryRelease();assert.ok(dummy.defeatedTimer>0);
        for(const target of sim.damageDummies)target.defeatedTimer=10;const basic=sim.buildings.find(b=>b.type==="tower"&&b.tower.variant==="basic");basic.tower.cooldown=0;sim.update(1/60);assert.equal(basic.tower.cooldown,0,"tower targeted a regenerating dummy");
        sim.resetDamageDummies();for(const target of sim.damageDummies)if(target!==secondDummy)target.defeatedTimer=10;sim.setPointerWorld(secondDummy.x,secondDummy.y);sim.primaryPress();for(let i=0;i<50;i++)sim.update(1/60);sim.primaryRelease();assert.equal(sim.focusedDummyReadout().id,secondDummy.id);sim.TUNE.clickDamage=oldDamage;sim.resetDamageDummies();assert.equal(dummy.hitCount,0);
        const drop=sim.resourceDrops.find(item=>item.kind==="dust");sim.setPointerWorld(drop.x,drop.y);sim.secondaryPress();for(let i=0;i<60;i++)sim.update(1/60);assert.ok(sim.state.carried.dust>0);sim.secondaryRelease();sim.rebuildShowcase();
        // The showcase garrison and its guard are inert authored POSES: the fixture holds nobody, the
        // display guard names no station, and the production-only station invariant exempts them.
        const displayGarrison=sim.buildings.find(item=>item.type==="garrison");assert.ok(displayGarrison);assert.equal(displayGarrison.complete,true);assert.equal(sim.durablePostStatus(displayGarrison),null,"showcase fixtures must expose no live occupancy");
        const displayWorker=sim.state.workers.find(item=>item.job==="guard"),nearDrop=sim.resourceDrops[0],displayEnemy=sim.state.enemies[0];displayWorker.hp=sim.TUNE.fleeHpThreshold;displayWorker.fleeing=false;displayWorker.returnAfterCombat=true;displayWorker.carried.wood=0;nearDrop.x=displayWorker.x;nearDrop.y=displayWorker.y;nearDrop.ground=true;nearDrop.target=null;delete nearDrop.claimedBy;displayEnemy.x=displayWorker.x;displayEnemy.y=displayWorker.y;const inactiveSnapshot={x:displayWorker.x,y:displayWorker.y,fleeing:displayWorker.fleeing,returnAfterCombat:displayWorker.returnAfterCombat,drops:sim.resourceDrops.length,wood:displayWorker.carried.wood};for(let i=0;i<10;i++)sim.update(1/60);assert.deepEqual({x:displayWorker.x,y:displayWorker.y,fleeing:displayWorker.fleeing,returnAfterCombat:displayWorker.returnAfterCombat,drops:sim.resourceDrops.length,wood:displayWorker.carried.wood},inactiveSnapshot);assert.equal(displayWorker.jobTarget,null,"a showcase guard is a pose, not a garrison posting");assert.equal(sim.state.workers.some(item=>item.jobTarget===displayGarrison),false,"the showcase garrison must hold no guards");assert.equal(sim.state.workers.every(item=>sim.workerMaxHp(item)===data.WORKER_HP),true,"a showcase guard is a pose and keeps ordinary worker health");
        const elapsed=sim.state.clock.elapsed;sim.togglePause();for(let i=0;i<60;i++)sim.update(1/60);assert.equal(sim.state.clock.elapsed,elapsed);sim.togglePause();
        sim.pressKey("KeyD");for(let i=0;i<9000;i++){if(i===300)sim.releaseKey("KeyD");sim.update(1/60);if(i%120===0)check();}check();assert.ok(sim.damageDummies.some(item=>item.hitCount>0));
        sim.resetShowcaseProps();sim.resetDamageDummies();check();
        console.log(JSON.stringify({...expected,steps:9000,labels:sim.showcaseLabels().labels.length}));
      }finally{Math.random=old;}
    `
  }).trim());

  execFileSync(process.execPath,[join(root,"scripts/card-mechanics.test.mjs")],{cwd:root,stdio:"pipe"});

  console.log(`validate ok | syntax ${jsFiles.length} | authored world ${authoredWorld.trees.length}t/${authoredWorld.rocks.length}r/${authoredWorld.diamonds.length}d/${authoredWorld.chests.length}c | terrain relocation water ${terrainPlacementResult.water.join(",")} | feature ${featureResult.checks+xpResult.checks+chestResult.checks+handResult.checks} checks | level wave threat ${tierOneResult.threat}/${xpResult.waveThreat} | calm night ${calmResult.plain}->${calmResult.calm} | wave clear ${waveClearanceResult.spawns} after ${waveClearanceResult.elapsed.toFixed(0)}s + reward | hud ${hudResult.spawning}->${hudResult.survivor}->clear | clickSpeed x${buffResult.ratio.toFixed(4)} | hand ${handResult.playable} playable, fireball ${handResult.nearRange}<=${data.FIREBALL.radius}<${handResult.farRange} | dawn rewards ${dawnRewards} | normal ${normalSteps} steps | showcase ${showcaseResult.steps} steps | fixtures ${showcaseResult.buildings} buildings, ${showcaseResult.chests} chests, ${showcaseResult.dummies} dummies, ${showcaseResult.props} props, ${showcaseResult.enemies} enemies, ${showcaseResult.workers} workers | skills spent ${selected} | labels ${showcaseResult.labels}`);
}finally{
  Math.random=originalRandom;
}
