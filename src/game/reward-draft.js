// Owns the run's finite Card Pull and the full Reward Draft transaction. Gameplay callers earn
// rewards by kind; this module alone decides eligibility, ordering, offers, rerolls, and which card
// IDs have already been given. Card effects, the hand, coins, pausing, and presentation stay with
// the simulation adapter.

const REWARD_POLICY=Object.freeze({
  base:Object.freeze({category:"build"}),
  dawn:Object.freeze({category:"buff"}),
  consumable:Object.freeze({category:"consumable"}),
});
const REWARD_PRIORITY=Object.freeze(["base","dawn","consumable"]);

function invariant(condition,message){if(!condition)throw new Error(message);}
function frozenIds(ids){return Object.freeze([...ids]);}

export function createRewardDraft({cards,rarityWeights,random=()=>Math.random(),offerSize=3,rerollCost=1}){
  invariant(Array.isArray(cards),"Reward Draft cards must be an array");
  invariant(Number.isInteger(offerSize)&&offerSize>0,"invalid Reward Draft offer size");
  invariant(Number.isInteger(rerollCost)&&rerollCost>=0,"invalid Reward Draft reroll cost");
  const cardById=new Map();
  for(const card of cards){
    invariant(card&&typeof card.id==="string"&&card.id,"Reward Draft card missing id");
    invariant(!cardById.has(card.id),"duplicate Reward Draft card id: "+card.id);
    invariant(typeof card.inPool==="boolean","Reward Draft card missing inPool: "+card.id);
    invariant(Number.isFinite(rarityWeights[card.rarity])&&rarityWeights[card.rarity]>0,"invalid rarity weight for "+card.id);
    cardById.set(card.id,card);
  }
  for(const card of cards)for(const requiredId of card.requires??[])invariant(cardById.has(requiredId),card.id+" requires unknown card "+requiredId);

  const possible=Object.freeze(cards.filter(card=>card.inPool&&Object.values(REWARD_POLICY).some(policy=>policy.category===card.category)));
  const possibleIds=new Set(possible.map(card=>card.id));
  const given=new Set();
  const queues={base:0,dawn:0,consumable:0};
  let offer=null;

  function prerequisitesMet(card){return (card.requires??[]).every(id=>given.has(id));}
  function eligibleCards(kind){
    const policy=REWARD_POLICY[kind];
    invariant(policy,"unknown Reward Draft kind: "+kind);
    return possible.filter(card=>card.category===policy.category&&!given.has(card.id)&&prerequisitesMet(card));
  }
  function weightedDraw(source,count){
    const pool=[...source],picked=[];
    while(picked.length<count&&pool.length){
      const total=pool.reduce((sum,card)=>sum+rarityWeights[card.rarity],0);
      const sample=random();
      invariant(Number.isFinite(sample)&&sample>=0&&sample<1,"Reward Draft random must be in [0, 1)");
      let roll=sample*total,index=0;
      while(index<pool.length-1&&(roll-=rarityWeights[pool[index].rarity])>=0)index++;
      picked.push(pool.splice(index,1)[0]);
    }
    return picked;
  }
  function nextQueuedKind(){return REWARD_PRIORITY.find(kind=>queues[kind]>0)||null;}
  function setOffer(kind,selected){offer=Object.freeze({kind,cardIds:frozenIds(selected.map(card=>card.id))});}
  function refill(){
    while(!offer){
      const kind=nextQueuedKind();
      if(!kind)return;
      queues[kind]--;
      const eligible=eligibleCards(kind);
      if(eligible.length)setOffer(kind,weightedDraw(eligible,Math.min(offerSize,eligible.length)));
    }
  }
  function assertState(){
    for(const kind of REWARD_PRIORITY)invariant(Number.isInteger(queues[kind])&&queues[kind]>=0,"invalid Reward Draft queue: "+kind);
    for(const id of given)invariant(possibleIds.has(id),"given card is outside the Card Pull: "+id);
    if(!offer)return;
    invariant(REWARD_POLICY[offer.kind],"live Reward Draft has an unknown kind");
    invariant(offer.cardIds.length>0&&offer.cardIds.length<=offerSize,"live Reward Draft has an invalid size");
    invariant(new Set(offer.cardIds).size===offer.cardIds.length,"live Reward Draft repeats a card");
    for(const id of offer.cardIds){
      const card=cardById.get(id);
      invariant(possibleIds.has(id)&&!given.has(id),"live Reward Draft contains an unavailable card: "+id);
      invariant(card.category===REWARD_POLICY[offer.kind].category,"live Reward Draft card disagrees with its kind: "+id);
      invariant(prerequisitesMet(card),"live Reward Draft contains a locked card: "+id);
    }
  }
  function earn(kind,count=1){
    invariant(REWARD_POLICY[kind],"unknown Reward Draft kind: "+kind);
    invariant(Number.isInteger(count)&&count>0,"invalid Reward Draft count");
    queues[kind]+=count;refill();assertState();
  }
  function choose(index){
    if(!offer||!Number.isInteger(index)||index<0||index>=offer.cardIds.length)return null;
    const cardId=offer.cardIds[index];
    invariant(!given.has(cardId),"Reward Draft gave one card twice: "+cardId);
    given.add(cardId);offer=null;refill();assertState();return cardId;
  }
  function reroll(availableCoins){
    if(!offer)return Object.freeze({changed:false,reason:"no-offer"});
    const eligible=eligibleCards(offer.kind),current=new Set(offer.cardIds);
    const alternatives=eligible.filter(card=>!current.has(card.id));
    if(!alternatives.length)return Object.freeze({changed:false,reason:"no-alternative"});
    if(!Number.isFinite(availableCoins)||availableCoins<rerollCost)return Object.freeze({changed:false,reason:"insufficient-coins"});
    const targetSize=Math.min(offerSize,eligible.length);
    const selected=weightedDraw(alternatives,Math.min(targetSize,alternatives.length));
    if(selected.length<targetSize){
      const selectedIds=new Set(selected.map(card=>card.id));
      const reusable=eligible.filter(card=>current.has(card.id)&&!selectedIds.has(card.id));
      selected.push(...weightedDraw(reusable,targetSize-selected.length));
    }
    invariant(selected.some(card=>!current.has(card.id)),"Reward Draft reroll did not change the batch");
    setOffer(offer.kind,selected);assertState();
    return Object.freeze({changed:true,cost:rerollCost});
  }
  function current(){return offer;}
  function pull(){
    const givenIds=possible.filter(card=>given.has(card.id)).map(card=>card.id);
    const remainingIds=possible.filter(card=>!given.has(card.id)).map(card=>card.id);
    const eligible=Object.fromEntries(REWARD_PRIORITY.map(kind=>[kind,frozenIds(eligibleCards(kind).map(card=>card.id))]));
    return Object.freeze({
      possible:frozenIds(possible.map(card=>card.id)),
      given:frozenIds(givenIds),
      remaining:frozenIds(remainingIds),
      eligible:Object.freeze(eligible),
      pending:Object.freeze({...queues}),
    });
  }
  function discardRewards(){for(const kind of REWARD_PRIORITY)queues[kind]=0;offer=null;assertState();}
  function reset(){given.clear();for(const kind of REWARD_PRIORITY)queues[kind]=0;offer=null;assertState();}

  assertState();
  return Object.freeze({earn,choose,reroll,current,pull,discardRewards,reset});
}
