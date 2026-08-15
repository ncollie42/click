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
let sim,data,grid,showcase,cardCatalog;
try{
  [sim,data,grid,showcase,cardCatalog]=await Promise.all([
    import(pathToFileURL(join(root,"src/game/simulation.js"))),
    import(pathToFileURL(join(root,"src/game/data.js"))),
    import(pathToFileURL(join(root,"src/game/grid.js"))),
    import(pathToFileURL(join(root,"src/game/showcase-data.js"))),
    import(pathToFileURL(join(root,"src/game/cards.js")))
  ]);

  assert.deepEqual(data.FEED_XP,{wood:1,stone:1,dust:5,coin:5,diamond:12});
  assert.deepEqual(Object.keys(data.FEED_XP),data.RESOURCE_KINDS);
  assert.deepEqual(Object.fromEntries(data.NIGHT_WAVE_RECIPES.map(recipe=>[recipe.id,recipe.minTier])),{raiderRush:0,archerLine:0,healerEscort:1,brutePush:2,twoFront:2});
  assert.equal(data.NIGHT_TIER_BONUS_SPAWNS,3);
  assert.equal(Object.isFrozen(data.ENEMY_TYPES),true);assert.equal(Object.values(data.ENEMY_TYPES).every(Object.isFrozen),true);
  assert.equal(Object.isFrozen(data.ENEMY_POOL),true);assert.equal(Object.isFrozen(data.NIGHT_WAVE_RECIPES),true);assert.equal(data.NIGHT_WAVE_RECIPES.every(recipe=>Object.isFrozen(recipe)&&Object.isFrozen(recipe.spawns)&&recipe.spawns.every(Object.isFrozen)),true);
  assert.deepEqual(data.LEVEL_CURVE,{base:6,growth:1.19});assert.equal(data.SKILL_POINT_LEVELS,4);
  assert.deepEqual(data.XP_TIERS,[40,100,200,350]);   // dead table, still imported by docs/progression.html and render/scene.js
  assert.equal(Object.isFrozen(data.CHEST),true);assert.equal(Object.isFrozen(data.CHEST.weights),true);assert.equal(Object.isFrozen(data.CHEST.outcomeOdds),true);
  assert.deepEqual(Object.keys(data.CHEST.weights),data.RESOURCE_KINDS);
  assert.equal(data.CHEST.startingCount,1);assert.equal(data.CHEST.maxHp,4);assert.deepEqual(data.CHEST.outcomeOdds,{cache:.5,pinata:.5});assert.equal(data.CHEST.cachePayout,5);assert.equal(data.CHEST.pinataPayout,12);assert.equal(data.CHEST.footprint,data.FOOTPRINT_1x1);
  assert.ok(data.CHEST.weights.wood>data.CHEST.weights.dust&&data.CHEST.weights.stone>data.CHEST.weights.coin&&data.CHEST.weights.diamond<Math.min(...data.RESOURCE_KINDS.filter(k=>k!=="diamond").map(k=>data.CHEST.weights[k])));

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
      if(card.charges!==undefined){assert.ok(["consumable","aura","blueprint"].includes(card.category),`card ${card.id} charges are deployable-only`);assert.ok(Number.isInteger(card.charges)&&card.charges>0,`card ${card.id} charges must be a positive integer`);}
      if(card.durationSeconds!==undefined){assert.ok(["consumable","aura"].includes(card.category),`card ${card.id} duration is deployable-only`);assert.ok(Number.isFinite(card.durationSeconds)&&card.durationSeconds>0,`card ${card.id} duration must be positive`);}
      if(card.category==="aura"){assert.equal(card.type,"building",`aura ${card.id} must be a building`);assert.ok(card.charges>0&&card.durationSeconds>0,`aura ${card.id} must be temporary and charged`);}
      if(card.tags!==undefined){assert.ok(Array.isArray(card.tags)&&card.tags.length>0,`card ${card.id} tags must be a non-empty array`);assert.ok(card.tags.every(tag=>typeof tag==="string"&&tag.length>0),`card ${card.id} has an invalid tag`);}
      if(card.features!==undefined){assert.ok(Array.isArray(card.features)&&card.features.length>0,`card ${card.id} features must be a non-empty array`);assert.ok(card.features.every(feature=>cards.CARD_FEATURES.includes(feature)),`card ${card.id} has an unknown feature`);}
      if(card.ref.startsWith("tower:")){
        const tower=data.TOWER_VARIANTS[card.ref.slice(6)],scored=scoreTower(tower);
        const targetTag=tower.attackMode==="line"?"piercing":["splash","periodic area","manual area"].includes(tower.attackMode)?"aoe":"single target";
        assert.ok(Number.isFinite(scored.score)&&scored.score>0,`card ${card.id} has invalid tower score`);
        assert.ok(card.tags?.includes(targetTag),`card ${card.id} must carry its ${targetTag} targeting tag`);
      }
      if(card.type==="building"&&card.ref.startsWith("building:")){
        const building=data.BUILDING_TYPES[card.ref.slice(9)],scored=scoreBuilding(building,{quantity:card.charges||1});
        if(scored)assert.ok(Number.isFinite(scored.score)&&scored.score>=0,`card ${card.id} has invalid building score`);
      }
      if(card.produces!==undefined){assert.equal(card.category,"blueprint",`card ${card.id} produces is blueprint-only`);assert.ok(typeof card.produces==="string"&&card.produces.length>0,`card ${card.id} has invalid produce output`);}
      assert.ok(!card.inPool||card.implemented,`card ${card.id} is inPool but not implemented`);
    }
    for(const id of spec.DRAFT_POLICY.cycle){const card=cards.cardById[id];assert.ok(card,`draft policy cycles unknown card ${id}`);assert.ok(card.model,`draft policy card ${id} carries no income model`);}

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
  assert.equal(sim.chests.length,data.CHEST.startingCount);
  {const chest=sim.chests[0],cell=grid.worldToCell(chest.x,chest.y),center=grid.cellToWorld(cell.cx,cell.cy),radius=sim.distance(chest.x,chest.y,sim.state.camera.x,sim.state.camera.y);assert.deepEqual({x:chest.x,y:chest.y},center);assert.ok(radius>=data.CHEST.discoverMinRadius&&radius<=data.CHEST.discoverMaxRadius);assert.equal(sim.canPlace(chest.x,chest.y,null,null,null,chest),true);assert.equal(sim.canPlace(chest.x,chest.y,"house"),false);assert.equal("contents" in chest,false);assert.equal("outcome" in chest,false);}
  sim.initializeRunMode("normal");
  // ── the starting hand ──
  // With the build shop gone a fresh run can only build out of the hand, so normal initialization
  // seeds the opening kit. It is dealt ONCE (re-initializing the same mode stays idempotent) and it
  // is dealt through the ordinary hand writer, so every entry is a real one-copy stack.
  {
    const opening=sim.hand();
    assert.deepEqual(opening.map(entry=>entry.id),["bpHouse","bpLumber","bpQuarry","bpTower"],"a normal run must open with the base-kit blueprints");
    assert.equal(opening.every(entry=>entry.count===1&&entry.charges===null),true,"a seeded card must be an ordinary untouched stack");
    assert.equal(opening.every(entry=>cardCatalog.cardById[entry.id].category==="blueprint"),true);
    assert.equal(sim.initializeRunMode("normal"),undefined);
    assert.deepEqual(sim.hand().map(entry=>entry.id),opening.map(entry=>entry.id),"re-initializing a run must not deal the opening kit twice");
  }
  assert.throws(()=>sim.initializeRunMode("invalid"),/invalid run mode/);
  sim.spawnEnemy("north","raider");const taggedEnemy=sim.state.enemies[0];
  assert.equal(taggedEnemy.waveNightNumber,undefined,"manual spawn silently joined a scheduled wave");assert.equal(sim.livingActiveWaveEnemies(),0);
  taggedEnemy.combatKind="invalid";assert.throws(()=>sim.validateSimulationInvariants(),/unknown combat kind/);taggedEnemy.combatKind="enemy";
  taggedEnemy.type="invalid";assert.throws(()=>sim.validateSimulationInvariants(),/unknown enemy type/);taggedEnemy.type="raider";
  taggedEnemy.waveNightNumber=0;assert.throws(()=>sim.validateSimulationInvariants(),/malformed wave membership/);delete taggedEnemy.waveNightNumber;
  const invalidDrop={kind:"invalid",x:100,y:100,groundY:100,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null};sim.resourceDrops.push(invalidDrop);assert.throws(()=>sim.validateSimulationInvariants(),/unknown resource drop kind/);sim.resourceDrops.pop();
  sim.state.runMode="invalid";assert.throws(()=>sim.update(1/60),/invalid run mode/);sim.state.runMode="normal";
  // The house is placed the only way a house can be placed now: by playing the bpHouse card the
  // opening kit dealt. There is no dock and no toggleBuildMode() to reach for.
  sim.DBG.freeCosts=true;let houseSite=null;for(let y=64;y<data.H-64&&!houseSite;y+=data.CELL)for(let x=64;x<data.W-64;x+=data.CELL)if(sim.canPlace(x,y,"house")){houseSite={x,y};break;}assert.ok(houseSite);sim.setPointerWorld(houseSite.x,houseSite.y);assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpHouse")),"targeting");assert.equal(sim.state.buildMode,"house");sim.primaryPress();sim.primaryRelease();assert.equal(sim.buildings.some(item=>item.type==="house"&&item.complete),true,"the bpHouse card did not stand a house");sim.DBG.instantWorkers=true;sim.update(1/60);const worker=sim.state.workers[0],workerOrigin={x:worker.x,y:worker.y};sim.setPointerWorld(worker.x,worker.y);sim.secondaryPress();assert.equal(sim.heldWorker(),worker);sim.pointerCancelled();assert.equal(worker.x,workerOrigin.x);assert.equal(worker.y,workerOrigin.y);assert.equal(sim.state.workers.includes(worker),true);sim.DBG.freeCosts=sim.DBG.instantWorkers=false;

  // A fixed seed must reproduce startup, and an impossible first batch must be discarded.
  const startupProgram=`
    let seed=0x41c6ce57;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
    const sim=await import("./src/game/simulation.js");
    console.log(JSON.stringify({chest:sim.chests.map(c=>[c.x,c.y,c.hp]),trees:sim.trees.map(n=>[n.x,n.y]).slice(0,8),rocks:sim.rocks.map(n=>[n.x,n.y]).slice(0,4),diamonds:sim.diamonds.map(n=>[n.x,n.y])}));
  `;
  const startupA=execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:startupProgram}).trim();
  const startupB=execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:startupProgram}).trim();
  assert.equal(startupA,startupB,"seeded startup drifted");
  const retryResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{cwd:root,encoding:"utf8",input:`
    import assert from "node:assert/strict";
    let calls=0,seed=0x51a7;Math.random=()=>{calls++;if(calls<=16002)return .5;return ((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);};
    const sim=await import("./src/game/simulation.js");
    assert.equal(sim.trees.length,80);assert.equal(sim.rocks.length,24);assert.equal(sim.diamonds.length,5);assert.equal(sim.chests.length,1);sim.validateSimulationInvariants();
    console.log(JSON.stringify({calls,chests:sim.chests.length}));
  `}).trim());
  assert.ok(retryResult.calls>16002);

  const chestResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import * as data from "./src/game/data.js";
      import {snapToCellCenter} from "./src/game/grid.js";
      const oldRandom=Math.random;
      const counts=()=>Object.fromEntries(data.RESOURCE_KINDS.map(kind=>[kind,0]));
      const carried=()=>data.RESOURCE_KINDS.reduce((sum,kind)=>sum+sim.state.carried[kind],0);
      const makeWorker=(x,y)=>({x,y,postX:x,postY:y,spawnSource:null,job:"guard",jobTarget:null,homePost:null,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:counts(),hp:data.WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,reposting:false});
      const hit=()=>{sim.primaryPress();sim.update(.02);sim.primaryRelease();};
      try{
        sim.initializeRunMode("normal");sim.TUNE.chopTime=.01;
        const chest=sim.chests[0],seedOrigin={x:chest.x,y:chest.y};
        assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).kind,"break-chest");assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).icon,"axe");
        const overlapTree={x:chest.x,y:chest.y,hp:3,max:3,stump:0,shake:0,variant:0,footprint:data.RESOURCE_FOOTPRINT};sim.trees.push(overlapTree);sim.spawnEnemy("north","raider");const overlapEnemy=sim.state.enemies.at(-1);overlapEnemy.x=chest.x;overlapEnemy.y=chest.y;assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).target,overlapEnemy,"enemy must outrank chest");sim.state.enemies.splice(sim.state.enemies.indexOf(overlapEnemy),1);assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).target,chest,"chest must outrank resource");sim.chests.splice(sim.chests.indexOf(chest),1);assert.equal(sim.resolvePrimaryAction(chest.x,chest.y).target,overlapTree);sim.chests.push(chest);sim.trees.splice(sim.trees.indexOf(overlapTree),1);
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

  // Focused deterministic regressions run in a clean process so fixtures cannot leak into stress.
  const featureResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import * as data from "./src/game/data.js";
      let seed=0x51a7;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      const counts=()=>({wood:0,stone:0,dust:0,coin:0,diamond:0});
      const building=(type,x,y,complete=true,cost={wood:1,stone:0})=>({type,x,y,complete,cost,delivered:{wood:0,stone:0},storage:counts(),upgrades:{},activeUpgrade:null,tower:null,hazard:null,pulse:0,starved:false});
      const worker=(job,target,x,y)=>({x,y,postX:x,postY:y+20,spawnSource:null,job,jobTarget:target,homePost:null,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:counts(),hp:data.WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,reposting:false});
      const drop=(kind,x,y)=>({kind,x,y,groundY:y,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null});
      // Every scenario starts on a fresh day: none of them steps far enough to reach dusk, so no
      // dawn reward can freeze the world in the middle of a worker measurement.
      const reset=()=>{sim.buildings.length=sim.resourceDrops.length=sim.chests.length=sim.state.workers.length=sim.state.enemies.length=sim.trees.length=sim.rocks.length=sim.diamonds.length=0;for(const kind of data.RESOURCE_KINDS)sim.state.stored[kind]=0;sim.state.clock.phase="day";sim.state.clock.remaining=data.DAY_DURATION;sim.state.paused=sim.state.gameOver=false;sim.DBG.groundSourcing=sim.DBG.blueprintRecruiting=sim.DBG.builderSelfSupply=true;sim.DBG.idleSeeksWork=false;sim.DBG.instantWorkers=false;sim.TUNE.builderSourceRadius=300;sim.TUNE.recruitRadius=200;sim.TUNE.fleeHpThreshold=1;};
      const step=(n=1)=>{for(let i=0;i<n;i++)sim.update(1/60);};
      // Recruitment cadence is private; disabling it while time advances makes the next enabled step due.
      const forceRecruitSweep=()=>{sim.DBG.blueprintRecruiting=false;step(31);sim.DBG.blueprintRecruiting=true;step();};
      try{
        sim.initializeRunMode("normal");
        assert.deepEqual(Object.entries(data.BUILDING_TYPES).filter(([,def])=>def.jobSlots).map(([type,def])=>[type,def.jobSlots]),[["lumber",2],["quarry",2],["stockpile",2]]);assert.equal(data.RESOURCE_NODE_JOB_SLOTS,1);assert.equal(data.BLUEPRINT_JOB_SLOTS,2);
        assert.equal(sim.DBG.groundSourcing,true);assert.equal(sim.TUNE.builderSourceRadius,300);
        reset();{const site=building("lumber",100,100,false),store=building("stockpile",110,100);store.storage.wood=3;const loose=drop("wood",104,100),builder=worker("build",site,100,100);sim.buildings.push(site,store);sim.resourceDrops.push(loose);sim.state.workers.push(builder);sim.DBG.groundSourcing=false;step();assert.equal(builder.taskTarget,null);assert.ok(builder.carried.wood>0);assert.equal(loose.claimedBy,undefined);}
        reset();{const site=building("lumber",100,100,false),store=building("stockpile",110,100);store.storage.wood=3;const loose=drop("wood",130,100),builder=worker("build",site,100,100);sim.buildings.push(site,store);sim.resourceDrops.push(loose);sim.state.workers.push(builder);sim.DBG.groundSourcing=true;step();assert.equal(builder.taskTarget,loose);assert.equal(loose.claimedBy,builder);assert.equal(store.storage.wood,3);sim.DBG.groundSourcing=false;sim.TUNE.builderSourceRadius=60;step();assert.equal(builder.taskTarget,loose);}
        reset();{const site=building("lumber",100,100,false),store=building("stockpile",110,100);store.storage.wood=1;const builder=worker("build",site,100,100);sim.buildings.push(site,store);sim.state.workers.push(builder);sim.DBG.groundSourcing=true;step();assert.equal(builder.carried.wood,1);}
        reset();{const site=building("lumber",100,100,false),builder=worker("build",site,100,100);sim.buildings.push(site);sim.state.workers.push(builder);step();assert.equal(builder.starved,true);}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100),savedHome={job:"guard",jobTarget:null,postX:40,postY:50};builder.homePost=savedHome;sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);step();assert.equal(builder.job,"build");assert.equal(builder.jobTarget,site);assert.equal(builder.homePost,savedHome);assert.equal(builder.selfSupply.node,tree);step(600);assert.equal(site.complete,true);assert.equal(site.delivered.wood,1);assert.equal(builder.homePost,null);assert.equal(builder.selfSupply,null);assert.equal(sim.resourceDrops.some(item=>item.claimedBy===builder),false);}
        reset();{const site=building("tower",100,100,false,{wood:1,stone:1}),tree={x:190,y:100,hp:3,max:3,stump:0,shake:0},rock={x:130,y:100,hp:3,max:3,depleted:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.rocks.push(rock);sim.state.workers.push(builder);step();assert.deepEqual(builder.selfSupply,{kind:"stone",node:rock},"nearest needed node must win across kinds");}
        reset();{const site=building("tower",100,100,false,{wood:1,stone:1}),tree={x:130,y:100,hp:3,max:3,stump:0,shake:0},rock={x:190,y:100,hp:3,max:3,depleted:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.rocks.push(rock);sim.state.workers.push(builder);step();assert.deepEqual(builder.selfSupply,{kind:"wood",node:tree},"nearest needed node must win across kinds");}
        reset();{const site=building("tower",100,100,false,{wood:2,stone:0}),tree={x:170,y:100,hp:6,max:6,stump:0,shake:0},a=worker("build",site,100,100),b=worker("build",site,102,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(a,b);step();assert.ok(a.selfSupply||b.selfSupply);assert.equal([a,b].filter(item=>item.selfSupply).length,1,"node/self-supply reservation duplicated");step(700);assert.equal(site.delivered.wood,site.cost.wood);assert.equal(site.complete,true,"builders must reselect without over-delivery");}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);step(90);assert.ok(builder.selfSupply);sim.setPointerWorld(builder.x,builder.y);sim.secondaryPress();assert.equal(builder.selfSupply,null);assert.equal(sim.resourceDrops.some(item=>item.claimedBy===builder),false);sim.pointerCancelled();}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);step(90);builder.hp=1;sim.spawnEnemy("north","healer");const danger=sim.state.enemies[0];danger.x=builder.x+5;danger.y=builder.y;step();assert.equal(builder.fleeing,true);assert.equal(builder.selfSupply,null);assert.equal(sim.resourceDrops.some(item=>item.claimedBy===builder),false);assert.equal(builder.job,"build");assert.equal(builder.jobTarget,site);}
        reset();{const site=building("lumber",100,100,false),tree={x:180,y:100,hp:3,max:3,stump:0,shake:0},builder=worker("build",site,100,100);sim.buildings.push(site);sim.trees.push(tree);sim.state.workers.push(builder);sim.DBG.builderSelfSupply=false;step();assert.equal(builder.starved,true);assert.equal(builder.selfSupply,null);assert.equal(builder.x,100);assert.ok(builder.y>100&&builder.y<=builder.postY);}
        reset();{const site=building("lumber",100,100,false),loose=drop("wood",105,100),builder=worker("build",site,100,100);sim.buildings.push(site);sim.resourceDrops.push(loose);sim.state.workers.push(builder);sim.DBG.groundSourcing=true;step();assert.equal(builder.taskTarget,loose);}
        reset();{const site=building("lumber",100,100,false,{wood:2,stone:0}),a=worker("build",site,100,100),b=worker("build",site,101,100),one=drop("wood",104,100),two=drop("wood",106,100);sim.buildings.push(site);sim.resourceDrops.push(one,two);sim.state.workers.push(a,b);sim.DBG.groundSourcing=true;step();assert.ok(a.taskTarget&&b.taskTarget);assert.notEqual(a.taskTarget,b.taskTarget);step(500);assert.ok(site.delivered.wood<=site.cost.wood);assert.equal(site.complete,true);assert.equal(a.job,"staff");assert.equal(a.jobTarget,site);}
        reset();{const site=building("lumber",100,100,false),a=worker("build",site,100,100),b=worker("build",site,101,100),c=worker("build",site,102,100);a.carried.wood=1;sim.buildings.push(site);sim.state.workers.push(a,b,c);step();assert.equal(site.complete,true);assert.equal(sim.workerOccupancyStatus(site).assigned,2);assert.deepEqual([a,b,c].map(item=>item.job).sort(),["guard","staff","staff"]);assert.equal([a,b,c].find(item=>item.job==="guard").jobTarget,null);}
        reset();{const house=building("house",500,500),near=building("lumber",560,500),far=building("stockpile",700,500);house.spawnTimer=0;sim.buildings.push(house,near,far);sim.DBG.instantWorkers=true;step();const born=sim.state.workers[0];assert.equal(born.jobTarget,near);let status=sim.durablePostStatus(near);assert.equal(status.assigned,1);assert.equal(status.arrived,0);assert.equal(sim.vacantDurablePosts().includes(near),true);step(600);status=sim.durablePostStatus(near);assert.equal(status.arrived,2);}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const first=building("lumber",300,300),second=building("quarry",600,300),staff=worker("staff",first,first.x,first.y+16);staff.postX=first.x;staff.postY=first.y+16;sim.buildings.push(first,second);sim.state.workers.push(staff);step();assert.equal(sim.durablePostStatus(first).arrived,1);sim.setPointerWorld(staff.x,staff.y);sim.secondaryPress();sim.setPointerWorld(second.x,second.y);sim.secondaryRelease();assert.equal(staff.jobTarget,second);assert.equal(sim.durablePostStatus(first).assigned,0);assert.equal(sim.durablePostStatus(second).arrived,0);step();assert.equal(sim.durablePostStatus(second).arrived,0);step(600);assert.equal(sim.durablePostStatus(second).arrived,1);}
        reset();{const site=building("lumber",300,300,false),builder=worker("build",site,site.x,site.y);builder.carried.wood=1;sim.buildings.push(site);sim.state.workers.push(builder);step();assert.equal(site.complete,true);assert.equal(builder.jobTarget,site);assert.equal(sim.durablePostStatus(site).arrived,0);step(20);assert.equal(sim.durablePostStatus(site).arrived,1);}
        reset();{const house=building("house",500,500);house.spawnTimer=0;sim.buildings.push(house);sim.DBG.instantWorkers=true;step();const born=sim.state.workers[0];assert.equal(born.job,"guard");assert.equal(born.jobTarget,null);assert.equal(born.postX,house.x);assert.equal(born.postY,house.y+23);}
        reset();{const house=building("house",500,500),camp=building("lumber",550,500);house.spawnTimer=0;const staff=worker("staff",camp,camp.x,camp.y+16);staff.spawnSource=house;staff.postX=camp.x;staff.postY=camp.y+16;sim.buildings.push(house,camp);sim.state.workers.push(staff);sim.setPointerWorld(staff.x,staff.y);sim.secondaryPress();assert.equal(sim.heldWorker(),staff);assert.equal(sim.durablePostStatus(camp).assigned,1);sim.DBG.instantWorkers=true;step();assert.equal(sim.durablePostStatus(camp).assigned,2);sim.pointerCancelled();}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const tree={x:200,y:200,hp:3,max:3,stump:0};sim.trees.push(tree);const first=worker("harvest",{node:tree,kind:"wood"},200,200),held=worker("guard",null,210,200);sim.state.workers.push(first,held);assert.deepEqual(sim.workerOccupancyStatus(tree),{target:tree,assigned:1,capacity:1});assert.equal(sim.workerAssignmentAt(held,tree.x,tree.y),null);sim.setPointerWorld(first.x,first.y);sim.secondaryPress();assert.equal(sim.workerOccupancyStatus(tree).assigned,1);assert.ok(sim.workerAssignmentAt(first,tree.x,tree.y));sim.pointerCancelled();}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const one={x:200,y:200,hp:3,max:3,stump:0},two={x:240,y:200,hp:3,max:3,stump:0};sim.trees.push(one,two);const a=worker("harvest",{node:one,kind:"wood"},200,200),b=worker("harvest",{node:null,kind:"wood"},220,200);sim.state.workers.push(a,b);step();assert.equal(b.jobTarget.node,two);assert.equal(sim.workerOccupancyStatus(one).assigned,1);assert.equal(sim.workerOccupancyStatus(two).assigned,1);}
        reset();{const camp=building("lumber",300,300),a=worker("staff",camp,300,316),b=worker("staff",camp,301,316),held=worker("guard",null,310,300);sim.buildings.push(camp);sim.state.workers.push(a,b,held);assert.equal(sim.workerOccupancyStatus(camp).assigned,2);assert.equal(sim.workerAssignmentAt(held,camp.x,camp.y),null);sim.setPointerWorld(a.x,a.y);sim.secondaryPress();assert.equal(sim.workerOccupancyStatus(camp).assigned,2);assert.ok(sim.workerAssignmentAt(a,camp.x,camp.y));sim.pointerCancelled();}
        reset();{const site=building("tower",300,300,false),a=worker("build",site,300,320),b=worker("build",site,301,320),held=worker("guard",null,310,300);sim.buildings.push(site);sim.state.workers.push(a,b,held);assert.deepEqual(sim.workerOccupancyStatus(site),{target:site,assigned:2,capacity:2});assert.equal(sim.workerAssignmentAt(held,site.x,site.y),null);sim.setPointerWorld(a.x,a.y);sim.secondaryPress();assert.equal(sim.workerOccupancyStatus(site).assigned,2);assert.ok(sim.workerAssignmentAt(a,site.x,site.y));sim.pointerCancelled();}
        reset();{sim.trees.length=sim.rocks.length=sim.diamonds.length=0;const tree={x:200,y:200,hp:3,max:3,stump:0},camp=building("lumber",232,200),far=building("quarry",264,200);sim.trees.push(tree);sim.buildings.push(far,camp);assert.equal(sim.workerOccupancyAt(camp.x,camp.y).target,camp);assert.equal(sim.workerOccupancyAt(far.x,far.y).target,far);tree.stump=1;sim.buildings.length=0;assert.equal(sim.workerOccupancyAt(tree.x,tree.y),null);}
        assert.equal(sim.DBG.blueprintRecruiting,true);assert.equal(sim.TUNE.recruitRadius,200);
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),a=worker("guard",null,300,316),b=worker("guard",null,340,300),replacement=worker("guard",null,350,300),far=worker("guard",null,561,300);a.carried.dust=1;sim.buildings.push(site);sim.state.workers.push(far,replacement,b,a);sim.DBG.blueprintRecruiting=false;step(31);a.x=300;a.y=316;const before={x:a.x,y:a.y,carried:{...a.carried}};sim.DBG.blueprintRecruiting=true;step();assert.deepEqual([a,b].map(item=>item.job),["build","build"]);assert.ok(a.homePost&&b.homePost);assert.deepEqual({x:a.x,y:a.y,carried:a.carried},before);assert.equal(far.job,"guard");assert.equal(sim.workerOccupancyStatus(site).assigned,2);a.hp=2;sim.spawnEnemy("north","raider");const killer=sim.state.enemies[0];killer.x=a.x;killer.y=a.y;step();assert.equal(sim.state.workers.includes(a),false,"production enemy hit did not kill builder");sim.state.enemies.length=0;step(28);assert.equal(replacement.job,"guard","recruited before cadence");const elapsedBeforePause=sim.state.clock.elapsed;sim.togglePause();step(60);assert.equal(sim.state.clock.elapsed,elapsedBeforePause);assert.equal(replacement.job,"guard");sim.togglePause();step(2);assert.equal(replacement.job,"build","not recruited once cadence elapsed");}
        reset();{const first=building("tower",300,300,false,{wood:99,stone:0}),second=building("tower",500,300,false,{wood:99,stone:0}),a=worker("guard",null,310,300),b=worker("guard",null,320,300),c=worker("guard",null,490,300);sim.buildings.push(first,second);sim.state.workers.push(c,b,a);forceRecruitSweep();assert.equal(sim.workerOccupancyStatus(first).assigned,2);assert.equal(sim.workerOccupancyStatus(second).assigned,1);assert.equal(c.jobTarget,second);}
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),manual=worker("build",site,300,320),near=worker("guard",null,310,300),far=worker("guard",null,330,300);sim.buildings.push(site);sim.state.workers.push(manual,far,near);forceRecruitSweep();assert.equal(near.job,"build");assert.equal(far.job,"guard");assert.equal(sim.workerOccupancyStatus(site).assigned,2);}
        reset();{const site=building("lumber",300,300,false),manual=worker("build",site,300,300),loan=worker("guard",null,310,300);loan.postX=100;loan.postY=120;sim.buildings.push(site);sim.state.workers.push(manual,loan);assert.equal(sim.workerIsLoaned(manual),false);forceRecruitSweep();assert.equal(sim.workerIsLoaned(loan),true);manual.carried.wood=1;step(20);assert.equal(site.complete,true);assert.equal(manual.job,"staff");assert.equal(manual.jobTarget,site);assert.equal(loan.job,"staff");assert.equal(loan.jobTarget,site);assert.equal(loan.homePost,null);assert.equal(sim.workerIsLoaned(loan),false);}
        reset();{const house=building("house",500,500),site=building("lumber",300,300,false),resident=worker("staff",site,300,316),loan=worker("guard",null,310,300),finisher=worker("build",site,300,300);house.spawnTimer=data.WORKER_SPAWN_TIME;resident.postX=site.x;resident.postY=site.y+16;loan.postX=80;loan.postY=90;sim.buildings.push(house,site);sim.state.workers.push(resident,loan,finisher);sim.DBG.blueprintRecruiting=false;step(31);sim.DBG.blueprintRecruiting=true;step();assert.equal(loan.job,"build");assert.equal(sim.state.workers.indexOf(loan)<sim.state.workers.indexOf(finisher),true);finisher.carried.wood=1;house.spawnTimer=2/60;step();assert.equal(site.complete,true);assert.equal(loan.job,"staff");assert.equal(loan.jobTarget,site);assert.equal(finisher.job,"guard");assert.equal(finisher.jobTarget,null);assert.equal(sim.durablePostStatus(site).assigned,2);const beforeSpawn=sim.state.workers.length;step();assert.equal(sim.state.workers.length,beforeSpawn+1);const born=sim.state.workers.at(-1);assert.notEqual(born.jobTarget,site);assert.equal(sim.durablePostStatus(site).assigned,2);}
        reset();{const site=building("tower",300,300,false,{wood:1,stone:0}),a=worker("guard",null,310,300),b=worker("guard",null,320,300);a.postX=80;b.postX=90;sim.buildings.push(site);sim.state.workers.push(a,b);forceRecruitSweep();a.carried.wood=1;step(20);assert.equal(site.complete,true);assert.deepEqual([a.job,b.job],["guard","guard"]);assert.deepEqual([a.postX,b.postX],[80,90]);}
        reset();{const site=building("lumber",300,300,false,{wood:99,stone:0}),resident=worker("staff",site,300,316),a=worker("guard",null,310,300),b=worker("guard",null,320,300);a.postX=80;b.postX=90;sim.buildings.push(site);sim.state.workers.push(resident,a,b);forceRecruitSweep();site.complete=true;step();assert.equal([a,b].filter(item=>item.job==="staff"&&item.jobTarget===site).length,1);assert.equal([a,b].filter(item=>item.job==="guard"&&item.homePost===null).length,1);}
        reset();{const site=building("lumber",300,300,false,{wood:99,stone:0}),one=worker("staff",site,300,316),two=worker("staff",site,301,316),a=worker("guard",null,310,300),b=worker("guard",null,320,300);a.postX=80;b.postX=90;sim.buildings.push(site);sim.state.workers.push(one,two,a,b);forceRecruitSweep();site.complete=true;step();assert.deepEqual([a.job,b.job],["guard","guard"]);assert.deepEqual([a.postX,b.postX],[80,90]);}
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),a=worker("guard",null,310,300),b=worker("guard",null,320,300),replacement=worker("guard",null,330,300);sim.buildings.push(site);sim.state.workers.push(a,b,replacement);forceRecruitSweep();assert.equal(replacement.job,"guard");sim.state.workers.splice(sim.state.workers.indexOf(a),1);step(31);assert.equal(replacement.job,"build");assert.equal(sim.workerOccupancyStatus(site).assigned,2);}
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),loan=worker("guard",null,310,300),builder=worker("guard",null,320,300),replacement=worker("guard",null,330,300);sim.buildings.push(site);sim.state.workers.push(loan,builder,replacement);forceRecruitSweep();assert.equal(replacement.job,"guard");sim.setPointerWorld(loan.x,loan.y);sim.secondaryPress();sim.setPointerWorld(700,700);sim.secondaryRelease();step(31);assert.equal(replacement.job,"build");assert.equal(sim.workerOccupancyStatus(site).assigned,2);}
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),combat=worker("guard",null,310,300),retaliating=worker("guard",null,320,300),returning=worker("guard",null,330,300),clean=worker("guard",null,340,300);clean.x=300;clean.y=320;clean.postX=300;clean.postY=320;sim.buildings.push(site);sim.state.workers.push(combat,retaliating,returning,clean);sim.DBG.blueprintRecruiting=false;step(31);combat.combatTarget={};retaliating.retaliationTarget={};returning.returnAfterCombat=true;sim.DBG.blueprintRecruiting=true;step();assert.equal(clean.job,"build");assert.equal(combat.job,"guard");assert.equal(retaliating.job,"guard");assert.equal(returning.job,"guard");}
        reset();{const site=building("tower",300,300,false,{wood:99,stone:0}),loan=worker("guard",null,310,300),other=worker("guard",null,320,300);sim.buildings.push(site);sim.state.workers.push(loan,other);sim.DBG.blueprintRecruiting=false;step(31);assert.deepEqual([loan.job,other.job],["guard","guard"]);sim.DBG.blueprintRecruiting=true;step();assert.equal(loan.job,"build");sim.DBG.blueprintRecruiting=false;site.complete=true;step();assert.equal(loan.job,"guard");assert.equal(loan.homePost,null);}
        reset();{const home=building("tower",100,100),site=building("tower",300,300,false,{wood:99,stone:0}),loan=worker("guard",home,310,300);loan.postX=home.x;loan.postY=home.y;sim.buildings.push(home,site);sim.state.workers.push(loan);forceRecruitSweep();assert.equal(loan.job,"build");sim.buildings.splice(sim.buildings.indexOf(home),1);site.complete=true;step();assert.equal(loan.job,"guard");assert.equal(loan.jobTarget,null);assert.notDeepEqual([loan.postX,loan.postY],[home.x,home.y]);}
        reset();{const tower=building("tower",120,100),site=building("lumber",300,300,false,{wood:99,stone:0}),loan=worker("build",site,200,100),claimed=drop("wood",202,100);tower.tower={variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:10,maxHp:10};loan.hp=1;loan.carried.dust=1;const savedHome={job:"guard",jobTarget:null,postX:450,postY:450};loan.homePost=savedHome;loan.taskTarget=claimed;loan.retaliationTarget={x:205,y:100};claimed.claimedBy=loan;sim.buildings.push(tower,site);sim.resourceDrops.push(claimed);sim.state.workers.push(loan);sim.spawnEnemy("north","healer");const danger=sim.state.enemies[0];danger.x=210;danger.y=100;const prior={job:loan.job,jobTarget:loan.jobTarget,homePost:loan.homePost,carried:{...loan.carried}};step();assert.equal(loan.fleeing,true);assert.equal(loan.taskTarget,null);assert.equal(claimed.claimedBy,undefined);assert.equal(loan.job,prior.job);assert.equal(loan.jobTarget,prior.jobTarget);assert.equal(loan.homePost,prior.homePost);assert.deepEqual(loan.homePost,savedHome);assert.deepEqual(loan.carried,prior.carried);assert.equal(loan.combatTarget,null);assert.equal(loan.retaliationTarget,null);const fledX=loan.x;step(10);assert.ok(loan.x<fledX);danger.x=700;danger.y=700;step(179);assert.equal(loan.fleeing,true);danger.x=loan.x+data.WORKER_LEASH+5;danger.y=loan.y;step();assert.equal(loan.fleeing,true,"danger inside recovery radius must reset safe time without causing fight/flee oscillation");assert.equal(loan.combatTarget,null);danger.x=700;danger.y=700;step(179);assert.equal(loan.fleeing,true);step(2);assert.equal(loan.fleeing,false);assert.equal(loan.job,prior.job);assert.equal(loan.jobTarget,prior.jobTarget);assert.equal(loan.homePost,prior.homePost);assert.deepEqual(loan.carried,prior.carried);assert.equal(loan.hp,1);}
        reset();{const low=worker("guard",null,200,100);low.hp=1;sim.state.workers.push(low);sim.spawnEnemy("north","healer");const danger=sim.state.enemies[0];danger.x=205;danger.y=100;step();assert.equal(low.fleeing,true);sim.setPointerWorld(low.x,low.y);sim.secondaryPress();assert.equal(sim.heldWorker(),low);sim.setPointerWorld(500,500);sim.secondaryRelease();assert.equal(low.fleeing,false);assert.equal(low.fleeSafeTime,0);assert.deepEqual([low.x,low.y],[500,500]);}
        reset();{const healthy=worker("guard",null,200,100);healthy.hp=sim.TUNE.fleeHpThreshold+1;healthy.attackCooldown=0;sim.state.workers.push(healthy);sim.spawnEnemy("north","healer");const enemy=sim.state.enemies[0];enemy.x=healthy.x;enemy.y=healthy.y;const hpBefore=enemy.hp;step();assert.equal(healthy.fleeing,false);assert.equal(healthy.combatTarget,enemy);assert.equal(enemy.hp,hpBefore-data.WORKER_DAMAGE);assert.equal(healthy.attackCooldown,data.WORKER_ATTACK_RATE);}
        reset();{const house=building("house",100,100),camp=building("lumber",295,100),idle=worker("guard",null,100,123);idle.spawnSource=house;idle.postX=100;idle.postY=123;house.spawnTimer=data.WORKER_SPAWN_TIME;sim.buildings.push(house,camp);sim.state.workers.push(idle);sim.DBG.blueprintRecruiting=false;sim.DBG.idleSeeksWork=true;step(31);assert.equal(idle.job,"staff");assert.equal(idle.jobTarget,camp);assert.equal(idle.homePost,null);assert.equal(idle.reposting,true);assert.equal(idle.spawnSource,house);}
        reset();{const house=building("house",100,100),camp=building("lumber",300,100),manual=worker("guard",null,110,123);manual.spawnSource=house;manual.postX=110;manual.postY=123;sim.buildings.push(house,camp);sim.state.workers.push(manual);sim.DBG.blueprintRecruiting=false;sim.DBG.idleSeeksWork=true;step(31);assert.equal(manual.job,"guard");sim.DBG.idleSeeksWork=false;manual.postX=100;step(31);assert.equal(manual.job,"guard");}
        reset();{const site=building("tower",200,100,false,{wood:1,stone:0}),guard=worker("guard",null,100,100),loose=drop("wood",105,100);guard.postX=200;guard.postY=100;guard.returnAfterCombat=true;sim.DBG.idleSeeksWork=true;sim.buildings.push(site);sim.resourceDrops.push(loose);sim.state.workers.push(guard);sim.DBG.blueprintRecruiting=false;step();assert.equal(guard.carried.wood,1);assert.equal(sim.resourceDrops.includes(loose),false);step(180);assert.equal(site.complete,true);assert.equal(site.delivered.wood,1);assert.equal(guard.carried.wood,0);}
        reset();{const site=building("tower",700,700,false,{wood:99,stone:0}),owner=worker("build",site,700,700),a=worker("guard",null,100,100),b=worker("guard",null,100,101),claimed=drop("wood",105,100);owner.taskTarget=claimed;claimed.claimedBy=owner;a.postX=b.postX=200;a.postY=b.postY=100;a.returnAfterCombat=b.returnAfterCombat=true;sim.buildings.push(site);sim.state.workers.push(owner,a,b);sim.resourceDrops.push(claimed);sim.DBG.idleSeeksWork=true;sim.DBG.blueprintRecruiting=false;step();assert.equal(claimed.claimedBy,owner);assert.equal(sim.resourceDrops.includes(claimed),true);assert.equal(a.carried.wood+b.carried.wood,0);}
        reset();{const a=worker("guard",null,100,100),b=worker("guard",null,100,101),loose=drop("wood",105,100);a.postX=b.postX=200;a.postY=b.postY=100;a.returnAfterCombat=b.returnAfterCombat=true;sim.state.workers.push(a,b);sim.resourceDrops.push(loose);sim.DBG.idleSeeksWork=true;sim.DBG.blueprintRecruiting=false;step();assert.equal(a.carried.wood+b.carried.wood,1);assert.equal(sim.resourceDrops.includes(loose),false);}
        reset();{const site=building("tower",200,100,false,{wood:1,stone:0}),builder=worker("build",site,700,700),guard=worker("guard",null,200,100),loose=drop("wood",205,100);builder.carried.wood=1;guard.postX=200;guard.postY=100;guard.returnAfterCombat=true;sim.buildings.push(site);sim.state.workers.push(builder,guard);sim.resourceDrops.push(loose);sim.DBG.idleSeeksWork=true;sim.DBG.groundSourcing=false;sim.DBG.blueprintRecruiting=false;step();assert.equal(site.delivered.wood,0,"guard must respect the builder's in-flight reservation");assert.equal(guard.carried.wood,0);assert.equal(site.complete,false);assert.equal(sim.resourceDrops.includes(loose),false);const fallback=sim.resourceDrops.find(item=>item.kind==="wood");assert.ok(fallback);assert.equal(fallback.target,null);assert.equal(fallback.claimedBy,undefined);step(120);assert.equal(fallback.ground,true);assert.equal(fallback.target,null);assert.equal(fallback.claimedBy,undefined);}
        console.log(JSON.stringify({checks:55}));
      }finally{Math.random=old;}
    `
  }).trim());
  const xpResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";
      import * as sim from "./src/game/simulation.js";
      import {BASE,FEED_XP,RESOURCE_KINDS,LEVEL_CURVE,SKILL_POINT_LEVELS,NIGHT_WAVE_SPAWNS,NIGHT_TIER_BONUS_SPAWNS} from "./src/game/data.js";
      import {cardById} from "./src/game/cards.js";
      const counts=()=>Object.fromEntries(RESOURCE_KINDS.map(kind=>[kind,0]));
      const worker=(load)=>({x:BASE.x,y:BASE.y,postX:BASE.x,postY:BASE.y,spawnSource:null,job:"haul",jobTarget:BASE,homePost:null,taskTarget:null,selfSupply:null,returning:true,starved:false,carried:{...counts(),...load},hp:5,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0,reposting:false});
      const cost=level=>LEVEL_CURVE.base*LEVEL_CURVE.growth**level;
      // Draining must not disturb the wave checks below, so the two schedule-bending cards are avoided.
      const skip=new Set(["calmNight","longDay"]);
      const drain=()=>{let taken=0;while(sim.draftPending()){const offer=sim.draftPending();assert.equal(offer.length,3);assert.equal(new Set(offer).size,3,"draft offered a duplicate card");assert.equal(offer.every(id=>cardById[id].inPool&&cardById[id].implemented),true,"draft offered a card that is not in the pool");assert.equal(sim.chooseDraft(Math.max(0,offer.findIndex(id=>!skip.has(id)))),true);taken++;}return taken;};
      sim.initializeRunMode("normal");assert.equal(sim.xp(),0);assert.equal(sim.skillPoints(),0);assert.equal(sim.waveTier(),0);
      assert.deepEqual(sim.levelState(),{level:0,xp:0,next:cost(0)});assert.equal(sim.draftPending(),null);assert.equal(sim.chooseDraft(0),false);
      sim.state.carried.wood=5;sim.setPointerWorld(BASE.x,BASE.y);sim.secondaryRelease();assert.equal(sim.xp(),5);assert.equal(sim.state.carried.wood,0);assert.equal(sim.state.level,0);assert.equal(sim.draftPending(),null,"a partial level must not deal a draft");
      // 12 xp in one deposit crosses levels 1 AND 2; the first offer is live and the rest are queued.
      const hauler=worker({diamond:1});sim.state.workers.push(hauler);sim.update(1/60);assert.equal(sim.xp(),5+FEED_XP.diamond);assert.equal(hauler.carried.diamond,0);
      assert.equal(sim.state.level,2);assert.equal(sim.state.draft.queue,1);assert.equal(sim.levelState().xp,17-cost(0)-cost(1));assert.equal(sim.levelState().next,cost(2));
      const firstOffer=sim.draftPending();assert.equal(firstOffer.length,3);assert.equal(new Set(firstOffer).size,3);assert.equal(firstOffer.every(id=>cardById[id].inPool),true);
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
      sim.DBG.invulnBase=true;sim.debugStartWave("twoFront");const wave=sim.state.nightWave,sequence=[];assert.equal(wave.totalSpawns,NIGHT_WAVE_SPAWNS+2*NIGHT_TIER_BONUS_SPAWNS);sim.update(.01);assert.equal(sim.state.enemies[0].waveNightNumber,wave.activeNightNumber);sequence.push([sim.state.enemies[0].type,sim.state.enemies[0].spawnSide]);sim.state.enemies.length=0;sim.update(.01);assert.equal(sim.state.clock.phase,"night","an early clear skipped later scheduled spawns");
      sim.debugGrantXp(2000);drain();assert.equal(sim.waveTier(),4);assert.equal(wave.totalSpawns,18,"active wave must retain its setup tier");
      for(let i=1;i<18;i++){sim.update(30/18+.001);assert.equal(sim.state.enemies.length,1);assert.equal(sim.state.enemies[0].waveNightNumber,wave.activeNightNumber,"bonus recipe cycle lost scheduled membership");sequence.push([sim.state.enemies[0].type,sim.state.enemies[0].spawnSide]);sim.state.enemies.length=0;}assert.equal(wave.remainingSpawns,0);assert.deepEqual(sequence.slice(12),sequence.slice(0,6),"bonus spawns must cycle recipe types and fronts");
      // The cap holds however far the level runs.
      sim.debugGrantXp(2000000);drain();assert.ok(sim.state.level>=30);assert.equal(sim.waveTier(),4);
      sim.validateSimulationInvariants();console.log(JSON.stringify({checks:44,waveSpawns:18,level:sim.state.level}));
    `
  }).trim());
  const tierOneResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";import * as sim from "./src/game/simulation.js";
      // Level 3 is exactly wave tier 1: the healer escort unlocks and the night gains one bonus batch.
      sim.initializeRunMode("normal");sim.debugGrantXp(22);assert.equal(sim.state.level,3);assert.equal(sim.waveTier(),1);sim.debugStartWave("healerEscort");assert.equal(sim.state.nightWave.totalSpawns,15);console.log(JSON.stringify({spawns:15}));
    `
  }).trim());
  // A calm night measurably shrinks the NEXT wave, and only that one.
  const calmResult=JSON.parse(execFileSync(process.execPath,["--input-type=module","-"],{
    cwd:root,encoding:"utf8",input:`
      import assert from "node:assert/strict";import * as sim from "./src/game/simulation.js";
      import {NIGHT_WAVE_SPAWNS,NIGHT_TIER_BONUS_SPAWNS,CARD_CONSUMABLES} from "./src/game/data.js";
      let seed=0x0ca1;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      try{
        sim.initializeRunMode("normal");
        // Drafting a consumable no longer applies it: the card is drawn into the hand, and the
        // discount exists only once the player PLAYS it.
        const drainOffers=()=>{while(sim.draftPending())sim.chooseDraft(sim.draftPending().findIndex(id=>!["calmNight","longDay"].includes(id)));};
        let taken=false,guard=0;
        while(!taken&&guard++<600){
          if(!sim.draftPending())sim.debugGrantXp(400);
          const offer=sim.draftPending();if(!offer)continue;
          const at=offer.indexOf("calmNight");sim.chooseDraft(at>=0?at:offer.findIndex(id=>id!=="longDay"));taken=at>=0;
        }
        assert.equal(taken,true,"calmNight never appeared in a draft");
        drainOffers();
        assert.ok(sim.hand().some(entry=>entry.id==="calmNight"),"a drafted calmNight must land in the hand");
        assert.equal(sim.state.draft.calmNight,false,"a card in hand must not have applied itself");
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="calmNight")),"applied");
        assert.equal(sim.state.draft.calmNight,true);
        const plain=NIGHT_WAVE_SPAWNS+sim.waveTier()*NIGHT_TIER_BONUS_SPAWNS;
        if(sim.state.clock.phase==="night"){sim.transitionPhase();drainOffers();}
        sim.transitionPhase();const calm=sim.state.nightWave.totalSpawns;
        assert.equal(calm,Math.max(1,Math.floor(plain*CARD_CONSUMABLES.calmNightFactor)));assert.ok(calm<plain);
        sim.transitionPhase();drainOffers();sim.transitionPhase();assert.equal(sim.state.nightWave.totalSpawns,plain,"the discount must not carry into a second night");
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
      import {DAY_DURATION,NIGHT_ENEMY_CAP,NIGHT_WAVE_SPAWNS} from "./src/game/data.js";
      let seed=0xc1ea;const old=Math.random;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/0x100000000);
      try{
        sim.initializeRunMode("normal");sim.DBG.invulnBase=true;
        sim.update(DAY_DURATION-1);assert.equal(sim.state.clock.phase,"day");assert.equal(sim.state.clock.remaining,1);sim.update(1);assert.equal(sim.state.clock.phase,"night","the day countdown did not reach dusk at 75 seconds");
        sim.debugStartWave("raiderRush");const wave=sim.state.nightWave,night=wave.activeNightNumber;
        assert.equal(sim.state.clock.phase,"night");assert.equal(sim.state.clock.remaining,0);assert.ok(Number.isInteger(night)&&night>0);
        for(let i=0;i<NIGHT_ENEMY_CAP;i++)sim.spawnEnemy("north","raider");
        assert.equal(sim.state.enemies.every(enemy=>enemy.waveNightNumber===undefined),true,"manual enemies joined the active wave");
        assert.equal(sim.livingActiveWaveEnemies(),0);
        const beforePause={elapsed:wave.elapsed,remaining:wave.remainingSpawns,run:sim.state.clock.elapsed};
        sim.togglePause();sim.update(60);assert.deepEqual({elapsed:wave.elapsed,remaining:wave.remainingSpawns,run:sim.state.clock.elapsed},beforePause,"pause advanced the wave");sim.togglePause();
        sim.update(46);assert.equal(sim.state.clock.phase,"night","the former fixed boundary ended night");assert.equal(sim.state.clock.remaining,0);assert.equal(wave.remainingSpawns,NIGHT_WAVE_SPAWNS,"the enemy cap failed to delay scheduled spawns");
        sim.state.enemies.length=0;sim.update(.01);
        assert.equal(wave.remainingSpawns,0);assert.equal(sim.livingActiveWaveEnemies(),NIGHT_WAVE_SPAWNS);assert.equal(sim.state.enemies.every(enemy=>enemy.waveNightNumber===night),true,"scheduled spawn lost active-wave membership");
        // Exhausted schedule is insufficient while one wave member survives.
        const survivor=sim.state.enemies[0];sim.state.enemies.splice(1);sim.update(10);
        assert.equal(sim.state.clock.phase,"night");assert.equal(sim.livingActiveWaveEnemies(),1);assert.equal(sim.state.clock.remaining,0);
        // A debugger enemy is allowed to remain at dawn. Game over and pause still suppress updates.
        sim.state.enemies.splice(sim.state.enemies.indexOf(survivor),1);assert.equal(sim.spawnEnemy("south","healer"),undefined,"manual spawn command changed its return contract");const manual=sim.state.enemies.at(-1);assert.equal(manual.waveNightNumber,undefined);assert.equal(sim.livingActiveWaveEnemies(),0);
        sim.state.gameOver=true;sim.update(1);assert.equal(sim.state.clock.phase,"night","game over transitioned to dawn");sim.state.gameOver=false;
        sim.togglePause();sim.update(1);assert.equal(sim.state.clock.phase,"night","pause transitioned to dawn");sim.togglePause();
        sim.update(1/60);assert.equal(sim.state.clock.phase,"day");assert.equal(sim.state.clock.completedNights,1);assert.equal(wave.activeNightNumber,null);assert.equal(sim.state.enemies.includes(manual),true,"manual enemy blocked or disappeared at dawn");
        assert.equal(sim.draftKind(),"dawn");const reward=sim.draftPending();assert.ok(reward);sim.update(10);assert.equal(sim.state.clock.completedNights,1);assert.equal(sim.draftPending(),reward,"clearance duplicated the dawn reward");
        sim.validateSimulationInvariants();
        console.log(JSON.stringify({night,elapsed:wave.elapsed,spawns:NIGHT_WAVE_SPAWNS,rewards:1,manualSurvived:sim.state.enemies.includes(manual)}));
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
        let guard=0;
        while(sim.buffStacks("clickSpeed")<2&&guard++<600){
          if(!sim.draftPending())sim.debugGrantXp(400);
          const offer=sim.draftPending();if(!offer)continue;
          const at=offer.indexOf("clickSpeed");sim.chooseDraft(at>=0?at:offer.findIndex(id=>!["calmNight","longDay"].includes(id)));
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
          if(!sim.draftPending())sim.debugGrantXp(400);
          const offer=sim.draftPending();if(!offer)continue;
          const at=offer.indexOf("critClicks");sim.chooseDraft(at>=0?at:Math.max(0,offer.findIndex(id=>!["calmNight","longDay"].includes(id))));
        }
        assert.equal(sim.buffStacks("critClicks"),1,"critClicks never appeared in a draft");
        while(sim.draftPending())sim.chooseDraft(0);
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
  // Drafting, dawn rewards, playing, targeting, partial kits and blueprint placements, all measured in
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
      const place=(x,y)=>{sim.setPointerWorld(x,y);sim.primaryPress();sim.primaryRelease();};
      try{
        sim.initializeRunMode("normal");clearGround();
        // 0 · the opening kit, and the debug command that takes it away again
        assert.deepEqual(sim.hand().map(entry=>entry.id),["bpHouse","bpLumber","bpQuarry","bpTower"],"a normal run must open with the base-kit blueprints");
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpTower")),"targeting","a seeded card must play like any other");
        assert.equal(sim.state.buildMode,"tower");assert.equal(sim.cancelBuildMode(),true);
        assert.equal(sim.debugClearHand(),4,"clearing the hand must report what it dropped");
        assert.deepEqual(sim.hand(),[],"debugClearHand must empty the hand");
        assert.equal(sim.state.cardTargeting,null);assert.equal(sim.state.buildMode,null);
        assert.equal(sim.debugClearHand(),0,"clearing an empty hand is a no-op");
        assert.equal(sim.draftKind(),null);
        assert.equal(sim.playCard(0),false,"an empty hand plays nothing");assert.equal(sim.playCard(-1),false);assert.equal(sim.playCard(.5),false);

        // 1 · a drafted consumable is DRAWN, not fired
        let guard=0,drafted=null;
        while(!drafted&&guard++<600){
          if(!sim.draftPending())sim.debugGrantXp(400);
          const offer=sim.draftPending();if(!offer)continue;
          assert.equal(sim.draftKind(),"level","a level-up must deal a level offer");
          const at=offer.findIndex(id=>cardById[id].category==="consumable"),eventsBefore=handEvents,storedBefore=JSON.stringify(sim.state.stored);
          assert.equal(sim.chooseDraft(at>=0?at:0),true);
          if(at<0)continue;
          drafted=offer[at];
          assert.ok(handEvents>eventsBefore,"a card entering the hand must raise handChanged()");
          assert.ok(held(drafted),"the drafted consumable never reached hand()");
          if(["woodBundle","stoneBundle","dustBundle"].includes(drafted))assert.equal(JSON.stringify(sim.state.stored),storedBefore,"a drafted bundle must not deliver until it is played");
        }
        assert.ok(drafted,"no consumable was ever offered");
        drain();assert.equal(sim.state.draftPaused,false);

        // 2 · dawn pays its own pick-3, consumables and blueprints only
        if(sim.state.clock.phase!=="night")sim.transitionPhase();
        assert.equal(sim.state.clock.phase,"night");
        sim.transitionPhase();
        const dawnOffer=sim.draftPending();
        assert.ok(dawnOffer,"the night ended and paid no dawn reward");
        assert.equal(sim.draftKind(),"dawn");assert.equal(sim.state.draftPaused,true);
        assert.equal(dawnOffer.length,3);assert.equal(new Set(dawnOffer).size,3,"the dawn offer repeated a card");
        assert.equal(dawnOffer.every(id=>["consumable","blueprint"].includes(cardById[id].category)&&cardById[id].inPool),true,"a dawn offer may only deal consumables and blueprints");
        assert.equal(sim.playCard(0),false,"a frozen world must not play cards");
        assert.equal(sim.chooseDraft(0),true);
        const dawnCard=dawnOffer[0];assert.ok(held(dawnCard),"the dawn pick never reached hand()");
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
        sim.spawnEnemy("north","raider");sim.spawnEnemy("north","raider");
        const near=sim.state.enemies[0],far=sim.state.enemies[1],anchor=snapToCellCenter(600,300);
        near.x=anchor.x;near.y=anchor.y+100;far.x=anchor.x;far.y=anchor.y+200;
        const nearRange=sim.distance(anchor.x,anchor.y,near.x,near.y),farRange=sim.distance(anchor.x,anchor.y,far.x,far.y);
        assert.ok(nearRange<=data.FIREBALL.radius&&farRange>data.FIREBALL.radius,"the fireball test targets are not on both sides of the radius");
        assert.ok(data.FIREBALL.damage>=data.ENEMY_TYPES.raider.hp,"the fireball must be lethal to a raider for this measurement");
        assert.equal(sim.debugDealCard("fireball"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="fireball")),"targeting");
        const buildingsBefore=sim.buildings.length,farHp=far.hp;
        place(600,300);
        assert.equal(sim.buildings.length,buildingsBefore,"a fireball must leave no building behind");
        assert.equal(sim.state.enemies.includes(near),false,"the fireball spared a raider inside its radius");
        assert.equal(far.hp,farHp,"the fireball reached past its radius");
        assert.equal(held("fireball"),null);assert.equal(sim.state.buildMode,null);

        // 6 · a blueprint targets like a kit, but what its click lands is an ordinary CONSTRUCTION
        //     SITE promised to the variant — the player still carries every resource, and the total
        //     is exactly the basic tower plus that variant's own authored upgrade cost.
        clearGround();for(const kind of data.RESOURCE_KINDS)sim.state.stored[kind]=0;
        assert.equal(sim.DBG.freeCosts,false);
        assert.equal(sim.debugDealCard("bpSniper"),true);
        // the cancel path first: the card comes back to hand with its charge unspent
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpSniper")),"targeting");
        assert.equal(sim.state.buildMode,"tower","a blueprint must arm the tower footprint");
        assert.equal(sim.cancelBuildMode(),true);
        assert.equal(sim.state.cardTargeting,null);assert.equal(held("bpSniper")?.charges,1,"a cancelled blueprint must keep its charge");
        const storedBeforeBlueprint=JSON.stringify(sim.state.stored);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpSniper")),"targeting");
        const sniperAnchor=snapToCellCenter(300,300);
        place(300,300);
        const sniper=sim.buildings.at(-1);
        assert.equal(sim.buildings.length,1,"the blueprint placed nothing, or placed twice");
        assert.equal(sniper.type,"tower");assert.equal(sniper.x,sniperAnchor.x);assert.equal(sniper.y,sniperAnchor.y);
        assert.equal(sniper.complete,false,"a blueprint card must land a site, not a finished tower");
        assert.equal(sniper.tower,null);assert.equal(sniper.activeUpgrade,null,"the variant is designated, not yet accepted");
        assert.equal(sniper.plannedVariant,"sniper","the site was not promised to the card's variant");
        assert.deepEqual(sniper.delivered,{wood:0,stone:0},"a fresh site has been delivered nothing");
        assert.deepEqual(sniper.cost,data.BUILDING_TYPES.tower.cost,"a card must not rewrite an authored cost");
        assert.equal(JSON.stringify(sim.state.stored),storedBeforeBlueprint,"placing a site must not touch storage");
        assert.equal(held("bpSniper"),null,"the blueprint must leave the hand as its site lands");
        assert.equal(sim.state.buildMode,null);assert.equal(sim.state.cardTargeting,null);
        sim.validateSimulationInvariants();
        // carry the chassis cost to it: the tower stands as a BASIC one and accepts the sniper job
        const deliver=(building,cost)=>{
          for(const kind of data.RESOURCE_KINDS)sim.state.carried[kind]=cost[kind]||0;
          sim.setPointerWorld(building.x,building.y);sim.secondaryRelease();
        };
        deliver(sniper,data.BUILDING_TYPES.tower.cost);
        assert.equal(sniper.complete,true,"the authored chassis cost did not finish the site");
        assert.equal(sniper.tower.variant,"basic");assert.equal(sniper.plannedVariant,null,"the designation must be spent on completion");
        assert.deepEqual(sniper.activeUpgrade,{id:"sniper",kind:"tower",delivered:counts()},"the variant upgrade must be accepted for the player");
        // and the variant's own authored cost finishes it, at full variant hp
        deliver(sniper,data.TOWER_VARIANTS.sniper.cost);
        assert.equal(sniper.tower.variant,"sniper","the designated upgrade never completed");
        assert.equal(sniper.activeUpgrade,null);
        assert.equal(sniper.tower.maxHp,data.TOWER_VARIANTS.sniper.maxHp);
        assert.equal(sniper.tower.hp,data.TOWER_VARIANTS.sniper.maxHp,"a finished variant tower must be at full hp");
        assert.deepEqual(sim.state.carried,counts(),"the delivery spent exactly the authored costs");
        assert.equal(JSON.stringify(sim.state.stored),storedBeforeBlueprint,"deliveries come from the hand, never from storage");

        // 7 · the obelisk blueprint drops an obelisk SITE at its authored cost, card spent
        clearGround();
        assert.equal(sim.debugDealCard("bpObelisk"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpObelisk")),"targeting");
        assert.equal(sim.state.buildMode,"obelisk");
        place(500,600);
        const obelisk=sim.buildings.at(-1);
        assert.equal(obelisk.type,"obelisk");assert.equal(obelisk.complete,false,"the obelisk card must land a site to fill");
        assert.equal(obelisk.plannedVariant,null,"only a tower card designates a variant");
        assert.deepEqual(obelisk.delivered,{wood:0,stone:0});
        assert.deepEqual(obelisk.cost,data.BUILDING_TYPES.obelisk.cost,"a card must not rewrite an authored cost");
        assert.equal(held("bpObelisk"),null,"the card is spent when the site is placed");
        deliver(obelisk,data.BUILDING_TYPES.obelisk.cost);
        assert.equal(obelisk.complete,true,"the authored obelisk cost did not finish the site");
        // a blueprint is not an unlock: the SAME card again lands a second, equally unpaid site
        assert.equal(sim.debugDealCard("bpObelisk"),true);
        assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpObelisk")),"targeting");
        place(500,700);
        const secondObelisk=sim.buildings.at(-1);
        assert.notEqual(secondObelisk,obelisk,"the second obelisk card placed nothing");
        assert.equal(secondObelisk.complete,false,"a repeated blueprint must still be paid for");

        // 7b · a blueprint stays in the POOL after it is taken, so later offers may deal it again
        {
          const before=sim.hand().length;
          let repeats=0,guardPool=0,seen=null;
          while(repeats<2&&guardPool++<900){
            if(!sim.draftPending())sim.debugGrantXp(400);
            const offer=sim.draftPending();if(!offer)continue;
            const at=seen===null?offer.findIndex(id=>cardById[id].category==="blueprint"):offer.indexOf(seen);
            if(at<0){sim.chooseDraft(0);continue;}
            if(seen===null)seen=offer[at];
            sim.chooseDraft(at);repeats++;
          }
          assert.equal(repeats,2,"a taken blueprint never came back in a later offer");
          assert.ok(seen&&cardById[seen].category==="blueprint");
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
          assert.deepEqual(first.cost,{wood:data.HOUSE_COST.wood,stone:data.HOUSE_COST.stone},"the first house card must charge the base house cost");
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
  assert.match(html,/id="vGroundSourcing" checked/);assert.match(html,/id="vBuilderSelfSupply" checked/);assert.match(html,/id="vBuilderRadius" min="60" max="400" step="10" value="300"/);assert.match(html,/id="vBlueprintRecruiting" checked/);assert.match(html,/id="vIdleSeeksWork" checked/);assert.match(html,/id="vRecruitRadius" min="100" max="500" step="20" value="200"/);assert.ok(debuggerSource.includes('bindV("vBuilderSelfSupply", v => { DBG.builderSelfSupply = v; });'));assert.ok(debuggerSource.includes('bindV("vBlueprintRecruiting", v => { DBG.blueprintRecruiting = v; });'));assert.ok(debuggerSource.includes('bindV("vIdleSeeksWork", v => { DBG.idleSeeksWork = v; });'));assert.ok(debuggerSource.includes('bindV("vRecruitRadius", v => { TUNE.recruitRadius = v; }, v => v + "px")'));assert.ok(overlay.includes("workerOccupancyStatus(target)"));assert.ok(overlay.includes("workerOccupancyAt(state.mouse.x,state.mouse.y)"));assert.ok(overlay.includes("drawWorkerSlots(target,height,status)"));assert.ok(overlay.includes("state.workers.length>0||!!heldWorker()"));assert.match(overlay,/hollow circles are vacancies/);assert.match(overlay,/! vacant/);assert.ok(overlay.includes("const BUILD_JOB_ACCENT=css(PAL.jobBuild)"));assert.ok(overlay.includes("workerIsLoaned(worker)"));assert.equal(overlay.includes("worker.homePost"),false);assert.ok(overlay.includes('hovered?.kind==="building"&&!hovered.object.complete'));assert.ok(overlay.includes('worker.job==="build"&&worker.jobTarget===site'));assert.equal(overlay.match(/if\(state\.runMode!=="normal"\)return/g)?.length,2);

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
      if(kind==="dawn"){dawnRewards++;assert.equal(sim.draftPending().every(id=>["consumable","blueprint"].includes(cardCatalog.cardById[id].category)),true,"a dawn offer dealt something other than a consumable or blueprint");}
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
        const check=()=>{sim.validateSimulationInvariants();assert.equal(sim.buildings.length,expected.buildings);assert.equal(sim.chests.length,expected.chests);assert.equal(sim.damageDummies.length,expected.dummies);assert.equal(sim.showcaseProps.length,expected.props);assert.equal(sim.state.enemies.length,expected.enemies);assert.equal(sim.state.workers.length,expected.workers);assert.equal(sim.state.enemies.every(e=>e.displayUnit&&e.waveNightNumber===undefined),true);assert.equal(sim.state.workers.every(w=>w.displayUnit),true);assert.equal(sim.state.nightWave.activeNightNumber,null);assert.equal(sim.livingActiveWaveEnemies(),0);};
        check();
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
        const displayWorker=sim.state.workers.find(item=>item.job==="guard"),nearDrop=sim.resourceDrops[0],displayEnemy=sim.state.enemies[0];displayWorker.hp=sim.TUNE.fleeHpThreshold;displayWorker.fleeing=false;displayWorker.returnAfterCombat=true;displayWorker.reposting=true;displayWorker.carried.wood=0;nearDrop.x=displayWorker.x;nearDrop.y=displayWorker.y;nearDrop.ground=true;nearDrop.target=null;delete nearDrop.claimedBy;displayEnemy.x=displayWorker.x;displayEnemy.y=displayWorker.y;const inactiveSnapshot={x:displayWorker.x,y:displayWorker.y,fleeing:displayWorker.fleeing,returnAfterCombat:displayWorker.returnAfterCombat,reposting:displayWorker.reposting,drops:sim.resourceDrops.length,wood:displayWorker.carried.wood};for(let i=0;i<10;i++)sim.update(1/60);assert.deepEqual({x:displayWorker.x,y:displayWorker.y,fleeing:displayWorker.fleeing,returnAfterCombat:displayWorker.returnAfterCombat,reposting:displayWorker.reposting,drops:sim.resourceDrops.length,wood:displayWorker.carried.wood},inactiveSnapshot);
        const elapsed=sim.state.clock.elapsed;sim.togglePause();for(let i=0;i<60;i++)sim.update(1/60);assert.equal(sim.state.clock.elapsed,elapsed);sim.togglePause();
        sim.pressKey("KeyD");for(let i=0;i<9000;i++){if(i===300)sim.releaseKey("KeyD");sim.update(1/60);if(i%120===0)check();}check();assert.ok(sim.damageDummies.some(item=>item.hitCount>0));
        sim.resetShowcaseProps();sim.resetDamageDummies();check();
        console.log(JSON.stringify({...expected,steps:9000,labels:sim.showcaseLabels().labels.length}));
      }finally{Math.random=old;}
    `
  }).trim());

  console.log(`validate ok | syntax ${jsFiles.length} | feature ${featureResult.checks+xpResult.checks+chestResult.checks+handResult.checks} checks | level waves ${tierOneResult.spawns}/${xpResult.waveSpawns} | calm night ${calmResult.plain}->${calmResult.calm} | wave clear ${waveClearanceResult.spawns} after ${waveClearanceResult.elapsed.toFixed(0)}s + reward | hud ${hudResult.spawning}->${hudResult.survivor}->clear | clickSpeed x${buffResult.ratio.toFixed(4)} | hand ${handResult.playable} playable, fireball ${handResult.nearRange}<=${data.FIREBALL.radius}<${handResult.farRange} | dawn rewards ${dawnRewards} | normal ${normalSteps} steps | showcase ${showcaseResult.steps} steps | fixtures ${showcaseResult.buildings} buildings, ${showcaseResult.chests} chests, ${showcaseResult.dummies} dummies, ${showcaseResult.props} props, ${showcaseResult.enemies} enemies, ${showcaseResult.workers} workers | skills spent ${selected} | labels ${showcaseResult.labels}`);
}finally{
  Math.random=originalRandom;
}
