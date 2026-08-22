#!/usr/bin/env node
// Focused interface tests for the finite Card Pull and Reward Draft transaction.

import assert from "node:assert/strict";
import {createRewardDraft} from "../src/game/reward-draft.js";

const weights={common:10,rare:3,epic:1};
const cards=[
  {id:"buildA",category:"build",rarity:"common",inPool:true},
  {id:"buildB",category:"build",rarity:"common",inPool:true},
  {id:"buildC",category:"build",rarity:"rare",inPool:true},
  {id:"buildD",category:"build",rarity:"epic",inPool:true},
  {id:"lockedBuild",category:"build",rarity:"common",inPool:true,requires:["unlock"]},
  {id:"unlock",category:"buff",rarity:"common",inPool:true},
  {id:"buffB",category:"buff",rarity:"rare",inPool:true},
  {id:"itemA",category:"consumable",rarity:"common",inPool:true},
  {id:"itemB",category:"consumable",rarity:"rare",inPool:true},
  {id:"disabled",category:"build",rarity:"common",inPool:false},
];
const draft=createRewardDraft({cards,rarityWeights:weights,random:()=>0,rerollCost:1});

assert.deepEqual(draft.pull().possible,cards.filter(card=>card.inPool).map(card=>card.id));
assert.equal(draft.pull().eligible.base.includes("lockedBuild"),false);

draft.earn("base");
const first=draft.current();
assert.equal(first.kind,"base");assert.equal(first.cardIds.length,3);
assert.equal(first.cardIds.every(id=>id.startsWith("build")),true);
assert.deepEqual(draft.reroll(0),{changed:false,reason:"insufficient-coins"});
assert.equal(draft.current(),first,"a refused reroll replaced the batch");
assert.deepEqual(draft.reroll(1),{changed:true,cost:1});
assert.equal(draft.current().cardIds.some(id=>!first.cardIds.includes(id)),true,"reroll failed to use an alternative");
assert.equal(draft.current().cardIds.length,3,"reroll did not reuse rejected cards to fill a short alternative pool");
assert.equal(first.cardIds.every(id=>draft.pull().remaining.includes(id)),true,"reroll removed a rejected card");
const rerolledOffer=draft.current(),rejected=rerolledOffer.cardIds.slice(1),chosen=rerolledOffer.cardIds[0];
assert.equal(draft.choose(0),chosen);
assert.deepEqual(draft.pull().given,[chosen]);
assert.equal(rejected.every(id=>draft.pull().remaining.includes(id)),true,"rejected cards left the Card Pull");

draft.earn("base");
assert.equal(draft.current().cardIds.includes(chosen),false,"a given card returned to an offer");
assert.deepEqual(draft.reroll(1),{changed:false,reason:"no-alternative"});

while(draft.current())draft.choose(0);
for(let i=0;i<10;i++){draft.earn("base");if(draft.current())draft.choose(0);}
assert.equal(draft.pull().eligible.base.length,0,"an exhausted building Card Pull refilled");
draft.earn("base");assert.equal(draft.current(),null,"an empty reward created debt");assert.equal(draft.pull().pending.base,0);

draft.earn("consumable",2);
assert.equal(draft.current().cardIds.length,2,"short Reward Draft did not expose every remaining card");
assert.deepEqual(draft.reroll(1),{changed:false,reason:"no-alternative"});
draft.choose(0);assert.equal(draft.current().cardIds.length,1);
draft.choose(0);assert.equal(draft.current(),null);

draft.earn("dawn");
assert.equal(draft.current().cardIds.includes("unlock"),true);
assert.equal(draft.choose(draft.current().cardIds.indexOf("unlock")),"unlock");
assert.equal(draft.pull().eligible.base.includes("lockedBuild"),true,"newly eligible card did not enter the active Card Pull");
draft.earn("base");assert.deepEqual(draft.current().cardIds,["lockedBuild"]);

draft.reset();
draft.earn("consumable",2);draft.earn("dawn");draft.earn("base");
draft.choose(0);
assert.equal(draft.current().kind,"base","backlog did not prioritize Base Level rewards");
draft.choose(0);
assert.equal(draft.current().kind,"dawn","backlog did not prioritize Wave rewards");
draft.choose(0);
assert.equal(draft.current().kind,"consumable","backlog did not leave consumables last");
draft.discardRewards();assert.equal(draft.current(),null);assert.deepEqual(draft.pull().pending,{base:0,dawn:0,consumable:0});

assert.throws(()=>createRewardDraft({cards:[cards[0],cards[0]],rarityWeights:weights}),/duplicate Reward Draft card id/);
assert.throws(()=>createRewardDraft({cards,rarityWeights:weights,random:()=>1}).earn("base"),/random must be/);
const weighted=createRewardDraft({cards:[cards[0],cards[2]],rarityWeights:weights,random:()=>.8,offerSize:1});
weighted.earn("base");assert.deepEqual(weighted.current().cardIds,["buildC"],"rarity weights did not control the remaining-card draw");
console.log("reward draft ok");
