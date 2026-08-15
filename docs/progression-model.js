// Progression model — the income → XP → level → draft → income feedback loop.
//
// Pure and DOM-free: progression.html renders it, scripts/validate.mjs smoke-
// tests it, and `node docs/progression-model.js` prints a summary for quick
// tuning. All game numbers arrive live from data.js/simulation.js; all intent
// arrives from progression-spec.js; buff effects from src/game/cards.js.

import {HOUSE_SLOTS,WORKER_CARRY,DAY_DURATION} from "../src/game/data.js";
import {TUNE} from "../src/game/simulation.js";
import {ARC,LEVEL_CURVE,DRAFT_POLICY,PLAYER_MODEL,phaseIndexAt} from "./progression-spec.js";
import {cardById} from "../src/game/cards.js";

export const DT=1/12; // 5-second steps — early drafts land ~30s apart
// Analytical estimate only. Gameplay dawn has no duration: it occurs after every scheduled wave
// enemy is defeated. Keeping a 45-second estimate preserves this model's tuned output.
export const MODELED_WAVE_CLEAR_SECONDS=45;

export function levelCost(level){return LEVEL_CURVE.base*Math.pow(LEVEL_CURVE.growth,level);}

// The scripted drafter: every Nth level takes the next income buff from the
// policy cycle that still has stacks left; other picks don't move the model.
function makeDrafter(){
  const stacksLeft=Object.fromEntries(DRAFT_POLICY.cycle.map(id=>[id,cardById[id].stacks??1]));
  let cursor=0;
  return function draft(level,mults){
    if(level%DRAFT_POLICY.incomeBuffEveryNLevels!==0) return null;
    for(let hop=0;hop<DRAFT_POLICY.cycle.length;hop++){
      const id=DRAFT_POLICY.cycle[cursor%DRAFT_POLICY.cycle.length];cursor++;
      if(stacksLeft[id]<=0) continue;
      stacksLeft[id]--;
      const {target,mult}=cardById[id].model;
      mults[target]*=mult;
      return id;
    }
    return null; // every stack of every income buff is spent
  };
}

export function runModel(){
  const T=ARC.targetMinutes;
  const eff=(DAY_DURATION+MODELED_WAVE_CLEAR_SECONDS*ARC.nightIncomeFactor)/(DAY_DURATION+MODELED_WAVE_CLEAR_SECONDS);
  const steps=Math.round(T/DT)+1;
  const mults={hand:1,worker:1,global:1,xp:1};
  const draft=makeDrafter();
  const series={mins:[],hand:[],work:[],total:[],baseline:[],cumXp:[],level:[]};
  const levelUps=[]; // {min, level, card|null}
  let xp=0,level=0,cumXp=0;
  for(let i=0;i<steps;i++){
    const t=i*DT, pi=phaseIndexAt(Math.min(t,T-0.001));
    const workers=HOUSE_SLOTS*PLAYER_MODEL.houseAtMinutes.filter(m=>m<=t).length;
    const handBase=PLAYER_MODEL.handHitsPerMin[pi]*TUNE.chopYield*eff;
    const workBase=workers*(60/PLAYER_MODEL.workerTripSeconds)*WORKER_CARRY*eff;
    const hand=handBase*mults.hand*mults.global;
    const work=workBase*mults.worker*mults.global;
    const total=hand+work;
    const gained=total*PLAYER_MODEL.feedFraction[pi]*PLAYER_MODEL.avgXpPerFedUnit[pi]*mults.xp*DT;
    xp+=gained;cumXp+=gained;
    while(xp>=levelCost(level)){
      xp-=levelCost(level);level++;
      levelUps.push({min:t,level,card:draft(level,mults)});
    }
    series.mins.push(t);series.hand.push(hand);series.work.push(work);
    series.total.push(total);series.baseline.push(handBase+workBase);
    series.cumXp.push(cumXp);series.level.push(level);
  }
  // draft cadence: minutes between consecutive level-ups (first gap is from 0)
  const gaps=levelUps.map((u,i)=>({min:u.min,gap:u.min-(i?levelUps[i-1].min:0)}));
  return {series,levelUps,gaps,mults,eff,T};
}

// node docs/progression-model.js → tuning summary
if(typeof process!=="undefined"&&process.argv?.[1]?.endsWith("progression-model.js")){
  const {levelUps,gaps,mults,T}=runModel();
  const worst=gaps.reduce((a,b)=>b.gap>a.gap?b:a,{gap:0});
  console.log(`levels ${levelUps.length} in ${T} min`);
  console.log(`first draft at ${levelUps[0]?.min.toFixed(2)} min`);
  console.log(`worst gap ${worst.gap.toFixed(2)} min at min ${worst.min?.toFixed(1)}`);
  console.log(`final mults hand ${mults.hand.toFixed(2)} worker ${mults.worker.toFixed(2)} xp ${mults.xp.toFixed(2)}`);
  console.log("gaps by 5-level bands:",gaps.map(g=>g.gap.toFixed(2)).join(" "));
}
