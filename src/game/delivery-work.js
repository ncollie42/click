// Owns the shared mutable recipe/progress state for every resource-delivery target.
// Target adapters own completion effects; workers, player input, UI, and tests read this module.

import {RESOURCE_KINDS} from "./data.js";

const RESOURCE_KIND_SET=new Set(RESOURCE_KINDS);

function invariant(condition,message){if(!condition)throw new Error("delivery work invariant: "+message);}
function resourceCounts(source={}){return Object.fromEntries(RESOURCE_KINDS.map(kind=>[kind,source[kind]??0]));}

export function assertDeliveryWork(work){
  invariant(work&&typeof work==="object","work is missing");
  invariant(work.cost&&work.delivered,"recipe state is missing");
  for(const kind of RESOURCE_KINDS){
    const cost=work.cost[kind],delivered=work.delivered[kind];
    invariant(Number.isInteger(cost)&&cost>=0,"illegal "+kind+" cost");
    invariant(Number.isInteger(delivered)&&delivered>=0&&delivered<=cost,"illegal "+kind+" progress");
  }
  for(const kind of Object.keys(work.cost))invariant(RESOURCE_KIND_SET.has(kind),"unknown cost kind "+kind);
  for(const kind of Object.keys(work.delivered))invariant(RESOURCE_KIND_SET.has(kind),"unknown progress kind "+kind);
  invariant(RESOURCE_KINDS.some(kind=>work.cost[kind]>0),"empty recipe");
  return work;
}

export function createDeliveryWork(cost,delivered={}){
  const work={cost:Object.freeze(resourceCounts(cost)),delivered:resourceCounts(delivered)};
  return assertDeliveryWork(work);
}

export function resetDeliveryWork(work,cost){
  invariant(work&&typeof work==="object","cannot reset missing work");
  work.cost=Object.freeze(resourceCounts(cost));
  work.delivered=resourceCounts();
  return assertDeliveryWork(work);
}

export function deliveryNeed(work,kind,reserved=0){
  assertDeliveryWork(work);
  invariant(RESOURCE_KIND_SET.has(kind),"unknown need kind "+kind);
  invariant(Number.isInteger(reserved)&&reserved>=0,"illegal reservation for "+kind);
  return Math.max(0,work.cost[kind]-work.delivered[kind]-reserved);
}

export function deliveryComplete(work){
  assertDeliveryWork(work);
  return RESOURCE_KINDS.every(kind=>work.delivered[kind]===work.cost[kind]);
}

/** Consumes only the current recipe's outstanding demand from caller-owned cargo. */
export function deliverToWork(work,cargo){
  assertDeliveryWork(work);
  const accepted=resourceCounts();let total=0;
  for(const kind of RESOURCE_KINDS){
    invariant(Number.isInteger(cargo[kind])&&cargo[kind]>=0,"illegal cargo "+kind);
    const amount=Math.min(cargo[kind],deliveryNeed(work,kind));
    cargo[kind]-=amount;work.delivered[kind]+=amount;accepted[kind]=amount;total+=amount;
  }
  return {accepted,total,completed:deliveryComplete(work)};
}

export function deliveryStatus(work){
  assertDeliveryWork(work);
  return {cost:{...work.cost},delivered:{...work.delivered},complete:deliveryComplete(work)};
}
