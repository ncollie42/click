#!/usr/bin/env node
// Deterministic, DOM-free repository validation and sustained simulation stress.

import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readdirSync,statSync} from "node:fs";
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
let sim,data,showcase;
try{
  [sim,data,showcase]=await Promise.all([
    import(pathToFileURL(join(root,"src/game/simulation.js"))),
    import(pathToFileURL(join(root,"src/game/data.js"))),
    import(pathToFileURL(join(root,"src/game/showcase-data.js")))
  ]);

  assert.equal(sim.state.runMode,"normal");
  assert.equal(sim.damageDummies.length,0);
  assert.equal(sim.showcaseProps.length,0);
  sim.initializeRunMode("normal");
  assert.equal(sim.initializeRunMode("normal"),undefined);
  assert.throws(()=>sim.initializeRunMode("invalid"),/invalid run mode/);
  sim.spawnEnemy("north","raider");const taggedEnemy=sim.state.enemies[0];
  taggedEnemy.combatKind="invalid";assert.throws(()=>sim.validateSimulationInvariants(),/unknown combat kind/);taggedEnemy.combatKind="enemy";
  taggedEnemy.type="invalid";assert.throws(()=>sim.validateSimulationInvariants(),/unknown enemy type/);taggedEnemy.type="raider";
  const invalidDrop={kind:"invalid",x:100,y:100,groundY:100,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null};sim.resourceDrops.push(invalidDrop);assert.throws(()=>sim.validateSimulationInvariants(),/unknown resource drop kind/);sim.resourceDrops.pop();
  sim.state.runMode="invalid";assert.throws(()=>sim.update(1/60),/invalid run mode/);sim.state.runMode="normal";
  sim.DBG.freeCosts=true;let houseSite=null;for(let y=64;y<data.H-64&&!houseSite;y+=data.CELL)for(let x=64;x<data.W-64;x+=data.CELL)if(sim.canPlace(x,y,"house")){houseSite={x,y};break;}assert.ok(houseSite);sim.setPointerWorld(houseSite.x,houseSite.y);sim.toggleBuildMode("house");sim.primaryPress();sim.primaryRelease();sim.DBG.instantWorkers=true;sim.update(1/60);const worker=sim.state.workers[0],workerOrigin={x:worker.x,y:worker.y};sim.setPointerWorld(worker.x,worker.y);sim.secondaryPress();assert.equal(sim.heldWorker(),worker);sim.pointerCancelled();assert.equal(worker.x,workerOrigin.x);assert.equal(worker.y,workerOrigin.y);assert.equal(sim.state.workers.includes(worker),true);sim.DBG.freeCosts=sim.DBG.instantWorkers=false;

  const normalSteps=12000,dt=1/60;
  sim.DBG.invulnBase=true;
  const elapsedBeforeSpeed=sim.state.clock.elapsed;for(let i=0;i<3;i++)sim.update(dt);assert.ok(Math.abs(sim.state.clock.elapsed-elapsedBeforeSpeed-3*dt)<1e-9);
  const elapsedBeforePause=sim.state.clock.elapsed;sim.togglePause();for(let i=0;i<60;i++)sim.update(dt);assert.equal(sim.state.clock.elapsed,elapsedBeforePause);sim.togglePause();
  sim.pressKey("KeyD");
  for(let i=0;i<normalSteps;i++){if(i===300)sim.releaseKey("KeyD");sim.update(dt);if(i%120===0)sim.validateSimulationInvariants();}
  assert.equal(sim.state.gameOver,false);assert.ok(sim.state.clock.elapsed>=normalSteps*dt);
  sim.validateSimulationInvariants();
  assert.equal(sim.damageDummies.length,0);
  assert.equal(sim.showcaseProps.length,0);

  // Production commands reveal the complete graph; every selected node must already be visible.
  let selected=0;
  while(selected<100){
    const available=sim.skillTreeNodes().filter(node=>node.status==="available");
    if(!available.length)break;
    for(const node of available){assert.equal(sim.selectSkillNode(node.id),true);selected++;}
  }
  const skills=sim.skillTreeNodes();
  assert.equal(skills.every(node=>node.status==="selected"),true);
  assert.equal(selected,skills.length);
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
        const expected={buildings:authored.SHOWCASE_FIXTURE_COUNTS.buildings+authored.SHOWCASE_FIXTURE_COUNTS.towers+authored.SHOWCASE_FIXTURE_COUNTS.progress,dummies:authored.SHOWCASE_FIXTURE_COUNTS.dummies,props:authored.SHOWCASE_FIXTURE_COUNTS.props,enemies:authored.SHOWCASE_FIXTURE_COUNTS.enemies,workers:authored.SHOWCASE_FIXTURE_COUNTS.workers};
        const check=()=>{sim.validateSimulationInvariants();assert.equal(sim.buildings.length,expected.buildings);assert.equal(sim.damageDummies.length,expected.dummies);assert.equal(sim.showcaseProps.length,expected.props);assert.equal(sim.state.enemies.length,expected.enemies);assert.equal(sim.state.workers.length,expected.workers);assert.equal(sim.state.enemies.every(e=>e.displayUnit),true);assert.equal(sim.state.workers.every(w=>w.displayUnit),true);};
        check();
        const firstRevision=sim.showcaseLabels().revision;
        for(let i=0;i<20;i++){assert.equal(sim.rebuildShowcase(),true);check();}
        assert.ok(sim.showcaseLabels().revision>firstRevision);
        const prop=sim.showcaseProps[0],origin={x:prop.x,y:prop.y};sim.setPointerWorld(prop.x,prop.y);sim.secondaryPress();assert.equal(sim.heldProp(),prop);sim.setPointerWorld(data.BASE.x,data.BASE.y);sim.secondaryRelease();assert.equal(prop.x,origin.x);assert.equal(prop.y,origin.y);assert.equal(sim.showcaseProps.includes(prop),true);
        const shock=sim.buildings.find(b=>b.type==="tower"&&b.tower.variant==="shock"),shockOrigin={x:shock.x,y:shock.y};sim.setPointerWorld(shock.x,shock.y);sim.secondaryPress();assert.equal(sim.heldBuilding(),shock);sim.rebuildShowcase();assert.equal(sim.state.heldObject,null);assert.equal(shock.x,shockOrigin.x);assert.equal(shock.y,shockOrigin.y);check();
        const dummy=sim.damageDummies[0],secondDummy=sim.damageDummies[1],oldDamage=sim.TUNE.clickDamage;sim.TUNE.clickDamage=100;sim.setPointerWorld(dummy.x,dummy.y);sim.primaryPress();for(let i=0;i<60;i++)sim.update(1/60);sim.primaryRelease();assert.ok(dummy.defeatedTimer>0);
        for(const target of sim.damageDummies)target.defeatedTimer=10;const basic=sim.buildings.find(b=>b.type==="tower"&&b.tower.variant==="basic");basic.tower.cooldown=0;sim.update(1/60);assert.equal(basic.tower.cooldown,0,"tower targeted a regenerating dummy");
        sim.resetDamageDummies();for(const target of sim.damageDummies)if(target!==secondDummy)target.defeatedTimer=10;sim.setPointerWorld(secondDummy.x,secondDummy.y);sim.primaryPress();for(let i=0;i<50;i++)sim.update(1/60);sim.primaryRelease();assert.equal(sim.focusedDummyReadout().id,secondDummy.id);sim.TUNE.clickDamage=oldDamage;sim.resetDamageDummies();assert.equal(dummy.hitCount,0);
        const drop=sim.resourceDrops.find(item=>item.kind==="dust");sim.setPointerWorld(drop.x,drop.y);sim.secondaryPress();for(let i=0;i<60;i++)sim.update(1/60);assert.ok(sim.state.carried.dust>0);sim.secondaryRelease();sim.rebuildShowcase();
        const elapsed=sim.state.clock.elapsed;sim.togglePause();for(let i=0;i<60;i++)sim.update(1/60);assert.equal(sim.state.clock.elapsed,elapsed);sim.togglePause();
        sim.pressKey("KeyD");for(let i=0;i<9000;i++){if(i===300)sim.releaseKey("KeyD");sim.update(1/60);if(i%120===0)check();}check();assert.ok(sim.damageDummies.some(item=>item.hitCount>0));
        sim.resetShowcaseProps();sim.resetDamageDummies();check();
        console.log(JSON.stringify({...expected,steps:9000,labels:sim.showcaseLabels().labels.length}));
      }finally{Math.random=old;}
    `
  }).trim());

  console.log(`validate ok | syntax ${jsFiles.length} | normal ${normalSteps} steps | showcase ${showcaseResult.steps} steps | fixtures ${showcaseResult.buildings} buildings, ${showcaseResult.dummies} dummies, ${showcaseResult.props} props, ${showcaseResult.enemies} enemies, ${showcaseResult.workers} workers | skills ${skills.length} | labels ${showcaseResult.labels}`);
}finally{
  Math.random=originalRandom;
}
