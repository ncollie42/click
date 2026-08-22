#!/usr/bin/env node
// Focused DOM-free regressions for click spells, temporary consumables, summons, and enemy pickup.

import assert from "node:assert/strict";
import * as sim from "../src/game/simulation.js";
import * as data from "../src/game/data.js";
import {cardById,RARITY_WEIGHTS} from "../src/game/cards.js";
import {buildingFootprint,cellToWorld,footprintCells,worldToCell} from "../src/game/grid.js";

sim.initializeRunMode("normal");sim.debugClearHand();
sim.trees.length=sim.rocks.length=sim.diamonds.length=sim.chests.length=sim.buildings.length=sim.friendlyBrutes.length=sim.state.enemies.length=sim.resourceDrops.length=0;
const counts=()=>Object.fromEntries(data.RESOURCE_KINDS.map(kind=>[kind,0]));
const worker=(x,y)=>({x,y,postX:x,postY:y,spawnSource:null,job:"guard",jobTarget:null,autonomous:false,taskTarget:null,selfSupply:null,returning:false,starved:false,carried:counts(),hp:data.WORKER_HP,attackCooldown:0,hitCooldown:.5,step:0,combatTarget:null,retaliationTarget:null,returnAfterCombat:false,fleeing:false,fleeSafeTime:0});
const drop=(kind,x,y)=>({kind,x,y,groundY:y,vx:0,vy:0,ground:true,target:null,t:0,spin:0,ttl:null});
const play=id=>{assert.equal(sim.debugDealCard(id),true);return sim.playCard(sim.hand().findIndex(entry=>entry.id===id));};
const findAnchor=(type=sim.state.buildMode,exclude=null)=>{for(let y=96;y<data.H-96;y+=data.CELL)for(let x=96;x<data.W-96;x+=data.CELL){const cell=worldToCell(x,y),fogFree=footprintCells(cell.cx,cell.cy,buildingFootprint(type)).every(candidate=>{const point=cellToWorld(candidate.cx,candidate.cy);return !sim.fogAtPoint(point.x,point.y);});if(fogFree&&(!exclude||x!==exclude.x||y!==exclude.y)&&sim.canPlace(x,y,type))return {x,y};}assert.fail("no placement anchor for "+type);};
const place=id=>{assert.equal(play(id),"targeting");const anchor=findAnchor();sim.setPointerWorld(anchor.x,anchor.y);sim.primaryPress();sim.primaryRelease();return anchor;};
const findWater=()=>{for(let y=96;y<data.H-96;y+=data.CELL)for(let x=96;x<data.W-96;x+=data.CELL)if(sim.terrainAtWorldPoint(x,y)==="water")return {x,y};assert.fail("no water cell");};
const originalRandom=Math.random;Math.random=()=>0;
let visible=new Set(),levelEvents=0;sim.connect({isCombatTargetOnScreen(target){return visible.has(target);},levelChanged(){levelEvents++;}});

// Consumable Forge integration: force its rare build card into an ordinary level offer, construct
// it, then exercise manual dust batching through the shared consumable queue.
const forgePool=sim.draftEligible(["build"]),forgePoolIndex=forgePool.findIndex(card=>card.id==="bpConsumableForge"),forgeWeight=forgePool.reduce((sum,card)=>sum+RARITY_WEIGHTS[card.rarity],0),forgeWeightBefore=forgePool.slice(0,forgePoolIndex).reduce((sum,card)=>sum+RARITY_WEIGHTS[card.rarity],0);
assert.ok(forgePoolIndex>=0,"bpConsumableForge is absent from the live build pool");
Math.random=()=>(forgeWeightBefore+RARITY_WEIGHTS.rare/2)/forgeWeight;
assert.equal(sim.debugGrantXp(6),true);const forgeOffer=sim.draftPending();assert.equal(sim.draftKind(),"level");assert.equal(forgeOffer.length,3);assert.ok(forgeOffer.includes("bpConsumableForge"));
assert.equal(sim.chooseDraft(forgeOffer.indexOf("bpConsumableForge")),true);assert.ok(sim.hand().some(entry=>entry.id==="bpConsumableForge"));assert.equal(sim.draftPending(),null);
Math.random=()=>0;sim.DBG.freeCosts=true;assert.equal(sim.playCard(sim.hand().findIndex(entry=>entry.id==="bpConsumableForge")),"targeting");const forgeAnchor=findAnchor();sim.setPointerWorld(forgeAnchor.x,forgeAnchor.y);sim.primaryPress();sim.primaryRelease();sim.DBG.freeCosts=false;
const forge=sim.buildings.find(building=>building.type==="consumableForge");assert.ok(forge?.complete);assert.deepEqual(forge.consumableForge,{dust:0});assert.equal(sim.buildings.includes(forge),true);
sim.setPointerWorld(forge.x,forge.y);sim.secondaryRelease();assert.equal(forge.consumableForge.dust,0,"empty release changed forge progress");
sim.state.carried.wood=1;sim.secondaryRelease();assert.equal(forge.consumableForge.dust,0);assert.equal(sim.state.carried.wood,0);assert.equal(sim.resourceDrops.filter(item=>item.kind==="wood").length,1,"non-dust did not use the ground-drop fallback");sim.resourceDrops.length=0;
sim.state.carried.dust=2;sim.secondaryRelease();assert.equal(forge.consumableForge.dust,2);assert.equal(sim.draftPending(),null,"partial dust queued a draft");
assert.equal(sim.debugGrantXp(8),true);const priorityOffer=sim.draftPending();assert.equal(sim.draftKind(),"level");
sim.state.carried.dust=5;sim.secondaryRelease();assert.equal(forge.consumableForge.dust,2);assert.equal(sim.draftPending(),priorityOffer,"forge reward displaced the active level offer");assert.equal(sim.state.draft.consumableQueue,1);assert.equal(sim.state.draftPaused,true);
assert.equal(sim.chooseDraft(0),true);assert.equal(sim.draftKind(),"consumable","forge reward did not follow the higher-priority level offer");
let forgeDrafts=0;
const chooseForgeReward=()=>{const offer=sim.draftPending();assert.equal(sim.draftKind(),"consumable");assert.equal(offer.length,3);assert.equal(new Set(offer).size,3);assert.equal(offer.every(id=>cardById[id].category==="consumable"),true);const chosen=offer[0],before=sim.hand().find(entry=>entry.id===chosen)?.count??0;assert.equal(sim.chooseDraft(0),true);assert.equal(sim.hand().find(entry=>entry.id===chosen)?.count,before+1,"chosen forge consumable did not enter the hand");forgeDrafts++;};
chooseForgeReward();
sim.state.carried.dust=6;sim.setPointerWorld(forge.x,forge.y);sim.secondaryRelease();assert.equal(forge.consumableForge.dust,3,"deposit over five lost its remainder");
sim.state.carried.dust=17;sim.secondaryRelease();assert.equal(forge.consumableForge.dust,0,"multi-batch delivery lost or invented excess dust");assert.equal(sim.state.draft.consumableQueue,4,"multi-batch delivery queued the wrong number behind the live offer");
while(sim.draftPending())chooseForgeReward();assert.equal(forgeDrafts,6);assert.equal(sim.state.draftPaused,false);const forgeResumeAt=sim.state.clock.elapsed;sim.update(.01);assert.ok(sim.state.clock.elapsed>forgeResumeAt,"world stayed paused after forge drafts drained");assert.equal(sim.buildings.includes(forge),true,"forge was consumed by a payout");
forge.consumableForge.dust=5;assert.throws(()=>sim.validateSimulationInvariants(),/illegal consumable-forge state/);forge.consumableForge.dust=1.5;assert.throws(()=>sim.validateSimulationInvariants(),/illegal consumable-forge state/);forge.consumableForge.dust=0;sim.validateSimulationInvariants();
sim.buildings.splice(sim.buildings.indexOf(forge),1);sim.debugClearHand();

// Tower Range applies to both ranged and area towers, then leaves the draft after five stacks.
const towerRangeCard=cardById.towerRange,basicRadius=sim.indicatorRadius("tower"),pulse={type:"tower",tower:{variant:"pulse"}};
assert.equal(towerRangeCard.stacks,5);assert.equal(towerRangeCard.inPool,true);assert.equal(towerRangeCard.implemented,true);
for(let i=0;i<towerRangeCard.stacks;i++)assert.equal(sim.debugApplyBuff("towerRange"),true);
const stackedRange=data.CARD_BUFFS.towerRange*towerRangeCard.stacks;
assert.equal(sim.indicatorRadius("tower"),basicRadius+stackedRange);assert.equal(sim.towerRadius(pulse),data.TOWER_VARIANTS.pulse.effectRadius+stackedRange);
assert.equal(sim.draftEligible(["buff"]).some(card=>card.id==="towerRange"),false,"capped tower range remained in the draft pool");
delete sim.state.draft.buffs.towerRange;

// Houses reserve a centered 3x3 yard. One completed 1x1 beacon reaches towers on both sides.
assert.equal(data.BUILDING_TYPES.house.footprint,data.FOOTPRINT_3x3);assert.equal(sim.indicatorRadius("rangeBeacon"),data.BUILDING_TYPES.rangeBeacon.effectRadius);
const beacon={type:"rangeBeacon",x:1000,y:1000,complete:true},leftTower={type:"tower",x:936,y:1000,complete:true,tower:{variant:"basic"}},rightTower={type:"tower",x:1064,y:1000,complete:true,tower:{variant:"basic"}};sim.buildings.push(beacon,leftTower,rightTower);
assert.equal(sim.towerRadius(leftTower),basicRadius+50);assert.equal(sim.towerRadius(rightTower),basicRadius+50);beacon.complete=false;assert.equal(sim.towerRadius(leftTower),basicRadius,"unfinished beacon applied its buff");sim.buildings.splice(sim.buildings.indexOf(beacon),3);
const shrine={type:"warShrine",x:data.BASE.x+100,y:data.BASE.y,complete:true},buffedTower={type:"tower",x:data.BASE.x+164,y:data.BASE.y,complete:true,tower:{variant:"basic",cooldown:0,flash:0,hitFlash:0,hp:10,maxHp:10}};sim.buildings.push(shrine,buffedTower);sim.spawnEnemy("brute");let shrineTarget=sim.state.enemies.at(-1);shrineTarget.x=buffedTower.x+100;shrineTarget.y=buffedTower.y;sim.update(.001);assert.equal(shrineTarget.hp,shrineTarget.max-2,"war shrine did not add one direct tower damage");sim.state.enemies.length=0;sim.buildings.splice(sim.buildings.indexOf(shrine),2);

// Death buffs grow a physical tree and damage every surviving enemy inside the death blast.
const deathAnchor=findAnchor(null);sim.TUNE.chopTime=.01;assert.equal(sim.debugApplyBuff("deathTree"),true);const treesBeforeDeath=sim.trees.length;sim.spawnEnemy("raider");let doomed=sim.state.enemies.at(-1);doomed.x=deathAnchor.x;doomed.y=deathAnchor.y;doomed.hp=1;sim.setPointerWorld(doomed.x,doomed.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();assert.equal(sim.trees.length,treesBeforeDeath+1);sim.trees.pop();delete sim.state.draft.buffs.deathTree;
assert.equal(sim.debugApplyBuff("deathExplosion"),true);sim.state.enemies.length=0;/* brute probes survive the 3-damage blast; a 3 hp raider would die and chain into the outside probe */for(const [kind,dx] of [["raider",0],["brute",50],["brute",65]]){sim.spawnEnemy(kind);const target=sim.state.enemies.at(-1);target.x=deathAnchor.x+dx;target.y=deathAnchor.y;}const [blastSource,blastNear,blastOutside]=sim.state.enemies;blastSource.hp=1;sim.setPointerWorld(blastSource.x,blastSource.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();assert.equal(blastNear.hp,blastNear.max-data.CARD_BUFFS.deathExplosionDamage);assert.equal(blastOutside.hp,blastOutside.max);sim.state.enemies.length=0;delete sim.state.draft.buffs.deathExplosion;

// Free Hit is bounded, and a free hit generated by a chain jump may start its own chain.
sim.spawnEnemy("raider");let enemy=sim.state.enemies[0];enemy.x=data.BASE.x+100;enemy.y=data.BASE.y;sim.debugApplyBuff("freeHit");sim.TUNE.chopTime=.01;
sim.setPointerWorld(enemy.x,enemy.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();assert.equal(enemy.hp,enemy.max-2,"Free Hit must strike exactly once without recursive Free Hits");
sim.state.enemies.length=0;sim.lightningArcs.length=0;sim.spawnEnemy("brute");sim.spawnEnemy("brute");let [chainA,chainB]=sim.state.enemies;chainA.x=data.BASE.x+100;chainA.y=data.BASE.y;chainB.x=chainA.x+60;chainB.y=chainA.y;sim.debugApplyBuff("chainLightning");
sim.setPointerWorld(chainA.x,chainA.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();assert.ok(sim.lightningArcs.length>1&&sim.lightningArcs.length<=24,"generated hit effects must compose but remain depth-bounded");delete sim.state.draft.buffs.chainLightning;delete sim.state.draft.buffs.freeHit;

// Screen spells consume an injected active-camera answer, not simulation camera approximations.
sim.state.enemies.length=0;sim.spawnEnemy("brute");sim.spawnEnemy("brute");let [near,far]=sim.state.enemies;visible=new Set([near]);const farHp=far.hp;
assert.equal(play("screenClick"),"applied");assert.equal(near.hp,near.max-1);assert.equal(far.hp,farHp);assert.equal(play("touchOfDeath"),"applied");assert.equal(sim.state.enemies.includes(near),false);assert.equal(far.hp,farHp);

// Every boss death creates exactly one ordinary chest at the nearest valid placement cell.
sim.state.enemies.length=0;const bossAnchor=findAnchor(null),chestsBeforeBoss=sim.chests.length;sim.spawnEnemy("bruteBoss");const slainBoss=sim.state.enemies.at(-1);slainBoss.x=bossAnchor.x;slainBoss.y=bossAnchor.y;slainBoss.hp=1;
sim.setPointerWorld(slainBoss.x,slainBoss.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();assert.equal(sim.state.enemies.includes(slainBoss),false);assert.equal(sim.chests.length,chestsBeforeBoss+1);assert.deepEqual({x:sim.chests.at(-1).x,y:sim.chests.at(-1).y},bossAnchor);sim.validateSimulationInvariants();sim.chests.pop();

// Recall releases claims and batches all arrivals into one base deposit: storage changes, XP never does.
sim.resourceDrops.length=0;const recallA=drop("wood",100,100),recallB=drop("stone",132,100),claimer=worker(100,100);claimer.taskTarget=recallA;recallA.claimedBy=claimer;sim.state.workers.push(claimer);sim.resourceDrops.push(recallA,recallB);
const xpBefore=sim.xp(),storedBefore={...sim.state.stored},eventsBefore=levelEvents;assert.equal(play("resourceRecall"),"applied");assert.equal(claimer.taskTarget,null);sim.update(1);
assert.equal(sim.resourceDrops.length,0);assert.equal(sim.xp(),xpBefore,"a base deposit must never grant xp");assert.deepEqual(sim.state.stored,{...storedBefore,wood:storedBefore.wood+1,stone:storedBefore.stone+1});assert.equal(levelEvents,eventsBefore,"a deposit must not touch the level track");sim.state.workers.length=0;

// Meteor rejects water, respects occupancy/radius, installs a validated 3x3 rock, and can be mined out.
assert.equal(play("meteor"),"targeting");const water=findWater(),meteorAnchor=findAnchor();sim.setPointerWorld(water.x,water.y);sim.primaryPress();sim.primaryRelease();assert.ok(sim.hand().some(entry=>entry.id==="meteor"),"invalid cast spent meteor");
sim.spawnEnemy("brute");sim.spawnEnemy("brute");const [edge,outside]=sim.state.enemies.slice(-2);edge.x=meteorAnchor.x+data.METEOR.radius;edge.y=meteorAnchor.y;outside.x=edge.x+1;outside.y=edge.y;const outsideHp=outside.hp,meteorTree={x:meteorAnchor.x+64,y:meteorAnchor.y,hp:3,max:3,stump:0,shake:0,variant:0,footprint:data.RESOURCE_FOOTPRINT};sim.trees.push(meteorTree);
sim.setPointerWorld(meteorAnchor.x,meteorAnchor.y);sim.primaryPress();sim.primaryRelease();
// Damage resolves at TOUCHDOWN (fallTime later), not at cast. Ride out the fall, then re-pin the
// enemies (they walked during it) so the at-radius / past-radius probes measure the blast, not drift.
sim.update(data.METEOR.fallTime-.05);edge.x=meteorAnchor.x+data.METEOR.radius;edge.y=meteorAnchor.y;outside.x=edge.x+1;outside.y=edge.y;sim.update(.1);const meteorRock=sim.rocks.at(-1);assert.equal(edge.hp,Math.max(0,edge.max-data.METEOR.damage));assert.equal(outside.hp,outsideHp);assert.equal(meteorTree.stump,1,"meteor did not damage a tree");sim.trees.splice(sim.trees.indexOf(meteorTree),1);assert.equal(meteorRock.meteor,true);assert.equal(meteorRock.footprint,data.FOOTPRINT_3x3);assert.equal(sim.canPlace(meteorAnchor.x,meteorAnchor.y,"meteorTarget"),false);
for(let i=0;i<data.METEOR.rockHp;i++){sim.setPointerWorld(meteorRock.x,meteorRock.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();}assert.equal(meteorRock.depleted,1);assert.equal(meteorRock.hp,0);sim.state.enemies.length=0;sim.validateSimulationInvariants();

// Fireball is a three-cast kit. Each ball stays visible/in flight before its 5-damage touchdown.
assert.equal(cardById.fireball.charges,3);assert.equal(data.FIREBALL.damage,5);assert.equal(play("fireball"),"targeting");const fireballAnchor=findAnchor();
sim.spawnEnemy("brute");const fireballVictim=sim.state.enemies.at(-1);fireballVictim.x=fireballAnchor.x;fireballVictim.y=fireballAnchor.y;const fireballHp=fireballVictim.hp,fireballBuildings=sim.buildings.length;
sim.setPointerWorld(fireballAnchor.x,fireballAnchor.y);sim.primaryPress();sim.primaryRelease();assert.equal(fireballVictim.hp,fireballHp,"fireball damaged on cast instead of touchdown");assert.equal(sim.fallingFireballs.length,1);assert.equal(sim.hand().find(entry=>entry.id==="fireball").charges,2);assert.equal(sim.buildings.length,fireballBuildings);
const rocksBeforeFireball=sim.rocks.length;sim.update(data.FIREBALL.fallTime-.05);fireballVictim.x=fireballAnchor.x;fireballVictim.y=fireballAnchor.y;sim.update(.1);assert.equal(fireballVictim.hp,fireballHp-5);assert.equal(sim.fallingFireballs.length,0);assert.ok(sim.state.screenShake>0);
// Touchdown leaves a small 1x1 rock (meteor's rock in miniature) that now occupies the cell, so the
// remaining casts must aim elsewhere — findAnchor re-scans for the next clear cell.
const fireballRock=sim.rocks.at(-1);assert.equal(sim.rocks.length,rocksBeforeFireball+1,"fireball touchdown left no rock");assert.equal(fireballRock.fireball,true);assert.equal(fireballRock.x,fireballAnchor.x);assert.equal(fireballRock.y,fireballAnchor.y);assert.equal(fireballRock.max,data.FIREBALL.rockHp);assert.equal(fireballRock.footprint,data.FOOTPRINT_1x1);assert.equal(sim.canPlace(fireballAnchor.x,fireballAnchor.y,"fireballTarget"),false);
for(let i=0;i<2;i++){const next=findAnchor("fireballTarget");sim.setPointerWorld(next.x,next.y);sim.primaryPress();sim.primaryRelease();sim.update(data.FIREBALL.fallTime+.01);}assert.equal(sim.hand().some(entry=>entry.id==="fireball"),false);assert.equal(sim.state.buildMode,null);assert.equal(sim.fallingFireballs.length,0);assert.equal(sim.rocks.length,rocksBeforeFireball+3,"each fireball slam leaves one rock");sim.state.enemies.length=0;
for(let i=0;i<data.FIREBALL.rockHp;i++){sim.setPointerWorld(fireballRock.x,fireballRock.y);sim.primaryPress();sim.update(.02);sim.primaryRelease();}assert.equal(fireballRock.depleted,1,"fireball rock is not mineable");sim.validateSimulationInvariants();

// Tar's visible 3x3-wide puddle slows every enemy inside its authored radius, not only the center cell.
const tarAnchor=place("tarKit"),tar=sim.buildings.find(building=>building.type==="tar"&&building.x===tarAnchor.x&&building.y===tarAnchor.y);sim.cancelBuildMode();
for(const dx of [data.BUILDING_TYPES.tar.effectRadius-1,-data.BUILDING_TYPES.tar.effectRadius+1,data.BUILDING_TYPES.tar.effectRadius+1]){sim.spawnEnemy("raider");const target=sim.state.enemies.at(-1);target.x=tar.x+dx;target.y=tar.y;}
const [tarInsideA,tarInsideB,tarOutside]=sim.state.enemies.slice(-3);sim.update(.001);assert.equal(tarInsideA.status.slow?.multiplier,data.BUILDING_TYPES.tar.slowMultiplier);assert.equal(tarInsideB.status.slow?.multiplier,data.BUILDING_TYPES.tar.slowMultiplier);assert.equal(tarOutside.status.slow,null);sim.state.enemies.length=0;sim.buildings.splice(sim.buildings.indexOf(tar),1);

// Three orbs independently cover their orbit; relocation restores on water, pause freezes lifetime,
// held lifetime still expires, and ordinary expiry removes the center.
Math.random=()=>.999;const orbAnchor=place("damageOrbs"),orb=sim.buildings.find(building=>building.type==="damageOrbs");assert.equal(orb.orbs.count,3);orb.x=data.BASE.x+192;orb.y=data.BASE.y;
for(let i=0;i<3;i++){sim.spawnEnemy("brute");const target=sim.state.enemies.at(-1),a=i*Math.PI*2/3;target.x=orb.x+Math.cos(a)*data.DAMAGE_ORBS.orbitRadius;target.y=orb.y+Math.sin(a)*data.DAMAGE_ORBS.orbitRadius;}const orbTree={x:orb.x+data.DAMAGE_ORBS.orbitRadius,y:orb.y,hp:3,max:3,stump:0,shake:0,variant:0,footprint:data.RESOURCE_FOOTPRINT},orbRock={x:orb.x+Math.cos(Math.PI*2/3)*data.DAMAGE_ORBS.orbitRadius,y:orb.y+Math.sin(Math.PI*2/3)*data.DAMAGE_ORBS.orbitRadius,hp:3,max:3,depleted:0,shake:0,footprint:data.RESOURCE_FOOTPRINT};sim.trees.push(orbTree);sim.rocks.push(orbRock);const orbVictims=[...sim.state.enemies],victimHp=orbVictims.map(target=>target.hp),orbDrops=sim.resourceDrops.length;sim.update(.001);orbVictims.forEach((target,i)=>assert.equal(target.hp,victimHp[i]-data.DAMAGE_ORBS.damage));assert.equal(orbTree.hp,2,"damage orbs did not hurt trees");assert.equal(orbRock.hp,2,"damage orbs did not hurt rocks");assert.equal(sim.resourceDrops.length,orbDrops+2);sim.state.enemies.length=0;sim.trees.splice(sim.trees.indexOf(orbTree),1);sim.rocks.splice(sim.rocks.indexOf(orbRock),1);
const remaining=orb.orbs.remaining;sim.togglePause();sim.update(5);sim.togglePause();assert.equal(orb.orbs.remaining,remaining);
sim.setPointerWorld(orb.x,orb.y);sim.secondaryPress();assert.equal(sim.heldBuilding(),orb);const origin={x:orb.x,y:orb.y},heldOrbAngle=orb.orbs.angle,heldOrbCursor=findAnchor("damageOrbs",origin);sim.setPointerWorld(heldOrbCursor.x,heldOrbCursor.y);orb.orbs.cooldown=0;sim.spawnEnemy("brute");const heldOrbVictim=sim.state.enemies.at(-1);heldOrbVictim.x=heldOrbCursor.x+Math.cos(heldOrbAngle)*data.DAMAGE_ORBS.orbitRadius;heldOrbVictim.y=heldOrbCursor.y+Math.sin(heldOrbAngle)*data.DAMAGE_ORBS.orbitRadius;const heldOrbHp=heldOrbVictim.hp;sim.update(.001);assert.ok(orb.orbs.angle>heldOrbAngle,"held damage orbs stopped spinning");assert.equal(heldOrbVictim.hp,heldOrbHp-data.DAMAGE_ORBS.damage,"held damage orbs stopped damaging");assert.equal(sim.heldBuilding(),orb);sim.state.enemies.length=0;sim.setPointerWorld(water.x,water.y);sim.secondaryRelease();assert.deepEqual({x:orb.x,y:orb.y},origin,"invalid relocation did not restore origin");
sim.setPointerWorld(orb.x,orb.y);sim.secondaryPress();const moved=findAnchor("damageOrbs",origin);sim.setPointerWorld(moved.x,moved.y);sim.secondaryRelease();assert.deepEqual({x:orb.x,y:orb.y},moved);orb.orbs.remaining=.01;sim.update(.02);assert.equal(sim.buildings.includes(orb),false);
const heldExpiryAnchor=place("damageOrbs"),heldExpiry=sim.buildings.find(building=>building.type==="damageOrbs");heldExpiry.orbs.remaining=.01;sim.setPointerWorld(heldExpiryAnchor.x,heldExpiryAnchor.y);sim.secondaryPress();sim.update(.02);assert.equal(sim.heldBuilding(),null,"held temporary survived expiry");

// Circle preserves partial dust through relocation, repeatedly converts every five dust while its
// lifetime remains, handles multiple summons in one delivery, and creates defenders that can die.
Math.random=()=>0;place("summoningCircle");const expiring=sim.buildings.find(building=>building.type==="summoningCircle");expiring.summoning.remaining=.01;sim.update(.02);assert.equal(sim.buildings.includes(expiring),false);
const circleAnchor=place("summoningCircle"),circle=sim.buildings.find(building=>building.type==="summoningCircle");sim.state.carried.dust=2;sim.setPointerWorld(circle.x,circle.y);sim.secondaryRelease();assert.equal(circle.summoning.dust,2);assert.equal(sim.buildings.includes(circle),true);
sim.setPointerWorld(circle.x,circle.y);sim.secondaryPress();const circleOrigin={x:circle.x,y:circle.y};sim.setPointerWorld(water.x,water.y);sim.secondaryRelease();assert.deepEqual({x:circle.x,y:circle.y},circleOrigin);assert.equal(circle.summoning.dust,2);
sim.setPointerWorld(circle.x,circle.y);sim.secondaryPress();const circleMoved=findAnchor("summoningCircle",circleOrigin);sim.setPointerWorld(circleMoved.x,circleMoved.y);sim.secondaryRelease();assert.deepEqual({x:circle.x,y:circle.y},circleMoved);assert.equal(circle.summoning.dust,2);
sim.resourceDrops.length=0;sim.state.carried.dust=5;sim.setPointerWorld(circle.x,circle.y);sim.secondaryRelease();assert.equal(sim.buildings.includes(circle),true,"first summon consumed the persistent circle");assert.equal(sim.friendlyBrutes.length,1);assert.equal(circle.summoning.dust,2,"partial dust did not carry into the next summon");assert.equal(sim.state.carried.dust,0);
sim.state.carried.dust=8;sim.setPointerWorld(circle.x,circle.y);sim.secondaryRelease();assert.equal(sim.friendlyBrutes.length,3,"one funded delivery did not summon several Brutes");assert.equal(circle.summoning.dust,0);assert.equal(sim.buildings.includes(circle),true);
const defender=sim.friendlyBrutes[0];sim.resourceDrops.length=0;sim.spawnEnemy("bruteBoss");enemy=sim.state.enemies.at(-1);const bossDef=data.ENEMY_TYPES.bruteBoss;
enemy.x=defender.x+bossDef.stompRadius-5;enemy.y=defender.y;enemy.wob=(.5-.01)/.12;sim.DBG.invulnBase=true;const stompTree={x:enemy.x,y:enemy.y,hp:3,max:3,stump:0,shake:0,variant:0,footprint:data.RESOURCE_FOOTPRINT};sim.trees.push(stompTree);const beforeStomp=defender.hp;sim.update(.02);assert.equal(defender.hp,beforeStomp-bossDef.stompDamage,"walking boss contact did not damage nearby player units");assert.equal(stompTree.stump,1,"player-resources stomp did not damage a tree");sim.trees.splice(sim.trees.indexOf(stompTree),1);
enemy.x=defender.x+20;enemy.y=defender.y;enemy.attackCooldown=0;const defenderHp=defender.hp;sim.update(.01);assert.ok(defender.hp<defenderHp,"hostile did not target nearer friendly Brute");for(let i=0;i<20&&sim.friendlyBrutes.includes(defender);i++)sim.update(.2);assert.equal(sim.friendlyBrutes.includes(defender),false,"friendly Brute could not die");sim.state.enemies.length=0;circle.summoning.remaining=.01;sim.update(.02);assert.equal(sim.buildings.includes(circle),false,"used circle survived its lifetime");

// Prerequisite gating is deterministic run state, not luck: a `requires` card is locked out of every
// eligible pool until each listed buff is owned, and unlocking never edits the authored catalog.
const gated=cardById.bpCaptureYard;
assert.deepEqual(gated.requires,["enemyPickup"]);
assert.equal(sim.buffStacks("enemyPickup"),0,"test order broke: enemyPickup owned before the gating checks");
assert.equal(sim.cardPrerequisitesMet(gated),false,"prerequisite reported met before its buff was owned");
assert.equal(sim.draftEligible().some(card=>!sim.cardPrerequisitesMet(card)),false,"eligible pool leaked a locked card");
assert.equal(sim.draftEligible(["build"]).some(card=>card.id===gated.id),false,"locked build card entered the level pool");

// Workers retain right-click priority over overlapping light enemies. Held scheduled enemies count
// toward clearance, preserve status, restore on cancel, reject water, and heavy enemies remain fixed.
sim.debugApplyBuff("enemyPickup");
assert.equal(sim.cardPrerequisitesMet(gated),true,"owning the buff did not satisfy the prerequisite");
assert.equal(sim.draftEligible(["build"]).some(card=>card.id===gated.id),gated.inPool,"unlocked eligibility must track the authored inPool flag alone");
assert.equal(gated.implemented||!gated.inPool,true,"bpCaptureYard may not enter the pool before its loop is implemented");const overlapWorker=worker(circleAnchor.x+200,circleAnchor.y);sim.state.workers.push(overlapWorker);sim.spawnEnemy("raider");enemy=sim.state.enemies.at(-1);enemy.x=overlapWorker.x;enemy.y=overlapWorker.y;sim.setPointerWorld(enemy.x,enemy.y);sim.secondaryPress();assert.equal(sim.heldWorker(),overlapWorker);sim.pointerCancelled();sim.state.workers.length=0;
if(sim.state.clock.phase==="day")sim.transitionPhase();enemy.waveNightNumber=sim.state.nightWave.activeNightNumber;enemy.status.slow={duration:2,multiplier:.5};enemy.attackCooldown=.7;const identity={status:enemy.status,hp:enemy.hp,cooldown:enemy.attackCooldown,x:enemy.x,y:enemy.y};
sim.setPointerWorld(enemy.x,enemy.y);sim.secondaryPress();assert.equal(sim.heldEnemy(),enemy);assert.equal(sim.livingActiveWaveEnemies(),1);sim.pointerCancelled();assert.equal(sim.state.enemies.includes(enemy),true);assert.equal(enemy.status,identity.status);assert.equal(enemy.hp,identity.hp);assert.equal(enemy.attackCooldown,identity.cooldown);
sim.setPointerWorld(enemy.x,enemy.y);sim.secondaryPress();sim.setPointerWorld(water.x,water.y);sim.secondaryRelease();assert.deepEqual({x:enemy.x,y:enemy.y},{x:identity.x,y:identity.y},"enemy dropped into water");
sim.setPointerWorld(enemy.x,enemy.y);sim.secondaryPress();sim.windowBlurred();assert.equal(sim.state.enemies.includes(enemy),true);assert.deepEqual({x:enemy.x,y:enemy.y},{x:identity.x,y:identity.y});
sim.spawnEnemy("brute");const heavy=sim.state.enemies.at(-1);heavy.x=enemy.x+80;heavy.y=enemy.y;sim.setPointerWorld(heavy.x,heavy.y);sim.secondaryPress();assert.equal(sim.heldEnemy(),null);sim.secondaryRelease();
sim.state.enemies.splice(sim.state.enemies.indexOf(heavy),1);   // the fixed heavy would otherwise maul the capture-yard fixtures below

// Capture Yard: a completed yard converts a dropped light enemy into a linked ally with its current
// HP and no hostile references; occupancy is derived per yard, capacity is three LIVING units, an
// incomplete or full yard restores the exact pickup origin, and a death reopens exactly one slot.
sim.DBG.freeCosts=true;place("bpCaptureYard");const yardA=sim.buildings.find(building=>building.type==="captureYard");assert.equal(yardA.complete,true);
sim.DBG.freeCosts=false;const siteAnchor=place("bpCaptureYard");const yardSite=sim.buildings.at(-1);assert.equal(yardSite.type,"captureYard");assert.equal(!!yardSite.complete,false);
const enemyOrigin={x:enemy.x,y:enemy.y};
sim.setPointerWorld(enemy.x,enemy.y);sim.secondaryPress();assert.equal(sim.heldEnemy(),enemy);sim.setPointerWorld(siteAnchor.x,siteAnchor.y);sim.secondaryRelease();
assert.equal(sim.state.enemies.includes(enemy),true,"incomplete yard consumed the enemy");assert.deepEqual({x:enemy.x,y:enemy.y},enemyOrigin,"incomplete-yard rejection did not restore the pickup origin");
assert.equal(sim.livingActiveWaveEnemies(),1,"scheduled raider must still gate dawn before capture");
sim.setPointerWorld(enemy.x,enemy.y);sim.secondaryPress();sim.setPointerWorld(yardA.x,yardA.y);sim.secondaryRelease();
assert.equal(sim.controlledEnemies.includes(enemy),true);assert.equal(sim.state.enemies.includes(enemy),false);assert.equal(enemy.sourceYard,yardA);
assert.equal(enemy.waveNightNumber,undefined,"capture must leave hostile wave accounting");assert.equal(sim.livingActiveWaveEnemies(),0);
assert.equal(enemy.status.slow,null,"hostile status survived conversion");assert.equal(sim.captureYardOccupancy(yardA),1);
const capture=(type,yard)=>{sim.spawnEnemy(type);const target=sim.state.enemies.at(-1);target.x=yard.x+150;target.y=yard.y;sim.setPointerWorld(target.x,target.y);sim.secondaryPress();assert.equal(sim.heldEnemy(),target);sim.setPointerWorld(yard.x,yard.y);sim.secondaryRelease();return target;};
const allyArcher=capture("archer",yardA);assert.equal(sim.captureYardOccupancy(yardA),2);
const allyRaider=capture("raider",yardA);assert.equal(sim.captureYardOccupancy(yardA),3);
sim.spawnEnemy("raider");const fourth=sim.state.enemies.at(-1);fourth.x=yardA.x+150;fourth.y=yardA.y;
sim.setPointerWorld(fourth.x,fourth.y);sim.secondaryPress();sim.setPointerWorld(yardA.x,yardA.y);sim.secondaryRelease();
assert.equal(sim.state.enemies.includes(fourth),true,"a full yard accepted a fourth capture");assert.deepEqual({x:fourth.x,y:fourth.y},{x:yardA.x+150,y:yardA.y},"full-yard rejection did not restore the pickup origin");assert.equal(sim.captureYardOccupancy(yardA),3);
sim.DBG.freeCosts=true;place("bpCaptureYard");const yardB=sim.buildings.filter(building=>building.type==="captureYard"&&building.complete).at(-1);assert.notEqual(yardB,yardA);
sim.setPointerWorld(fourth.x,fourth.y);sim.secondaryPress();sim.setPointerWorld(yardB.x,yardB.y);sim.secondaryRelease();
assert.equal(fourth.sourceYard,yardB,"a second yard must accept captures independently of a full one");assert.equal(sim.captureYardOccupancy(yardB),1);assert.equal(sim.captureYardOccupancy(yardA),3);
allyRaider.x=yardA.x-150;allyRaider.y=yardA.y;   // off the shared muster point, so the brute's nearest-target pick is unambiguous
sim.spawnEnemy("brute");const killer=sim.state.enemies.at(-1);killer.x=allyRaider.x+20;killer.y=allyRaider.y;killer.attackCooldown=0;
sim.update(.01);
assert.equal(sim.controlledEnemies.includes(allyRaider),false,"hostile brute could not kill the controlled raider");assert.equal(sim.captureYardOccupancy(yardA),2,"ally death did not reopen its yard slot");
const replacement=capture("raider",yardA);assert.equal(sim.captureYardOccupancy(yardA),3,"reopened slot rejected a replacement capture");assert.equal(replacement.sourceYard,yardA);
// Controlled archers fight with their authored ranged kit; controlled healers heal ALLIES only.
sim.state.enemies.length=0;
sim.spawnEnemy("raider");const mark=sim.state.enemies.at(-1);mark.x=allyArcher.x+100;mark.y=allyArcher.y;const markHp=mark.hp;
for(const unit of sim.controlledEnemies)unit.attackCooldown=0;
sim.update(.01);
assert.ok(mark.hp<markHp,"controlled archer did not attack a hostile inside the guard radius");
sim.state.enemies.length=0;
const allyHealer=capture("healer",yardB);fourth.hp=1;allyHealer.x=fourth.x+30;allyHealer.y=fourth.y;allyHealer.healCooldown=0;
sim.update(.01);
assert.ok(fourth.hp>1,"controlled healer did not heal an injured allied unit");

Math.random=originalRandom;sim.validateSimulationInvariants();console.log("card mechanics ok");
