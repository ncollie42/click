// Owns: the fullscreen debug card sandbox (#cardSandbox) — every registry card as a REAL card face,
// dealt or applied through the simulation's existing debug commands, plus the free-placement toggle.
// This is the "try any card now" bench the gameplay pane's chip dealer is too cramped to be: same
// commands (debugDealCard / debugApplyBuff / debugClearHand / DBG.freeCosts), bigger surface.
// Debug-only adapter: it reads the catalog and calls exported commands; it owns no gameplay state.
//
// Toggle: C (outside text inputs), the view panel's "open card sandbox" button, or the close
// button. Escape closes when open — bound in the CAPTURE phase like the draft overlay's handler,
// so the press never reaches input.js's pause chain.
//
// Free placement: opening the sandbox for the FIRST time switches DBG.freeCosts on (that is what a
// sandbox is for); the checkbox mirrors the gameplay pane's #vFreeCosts both ways so the two
// switches can never disagree about the one flag they share.

import {CARDS, RARITIES} from "../game/cards.js";
import {cardFace} from "../ui/hand.js";
import {
  DBG, toast, buffStacks,
  debugDealCard, debugApplyBuff, debugClearHand, debugSweepFreeCosts
} from "../game/simulation.js";

const GROUPS=[["build","builds"],["consumable","consumables"],["aura","auras"],["buff","buffs"]];
const DEALABLE=new Set(["consumable","build"]);
const RARITY_RANK=Object.fromEntries(RARITIES.map((rarity,index)=>[rarity,index]));

/** Bench availability, which is NOT pool eligibility: "active" cards click (deal or apply),
 * "offPool" cards click too but the draft would never offer them, "off" cards do nothing
 * (auras and unimplemented buffs). Drives both the sort and the show-inactive toggle. */
function cardStatus(card){
  const clickable=DEALABLE.has(card.category)||(card.category==="buff"&&card.implemented);
  if(!clickable)return "off";
  return card.inPool?"active":"offPool";
}
const STATUS_RANK={active:0,offPool:1,off:2};

let root=null, grid=null, armedFreeOnce=false;
const stackBadges=new Map();   // buff card id -> its ×N badge element, repainted on open and click

function isOpen(){ return root && !root.hidden; }
function typingInField(){ return /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||""); }

function setFreeCosts(on){
  DBG.freeCosts=on; debugSweepFreeCosts();
  document.getElementById("csFreeCosts").checked=on;
  // Mirror the gameplay pane's switch; both write the same flag through the same sweep.
  const panelBox=document.getElementById("vFreeCosts");
  if(panelBox) panelBox.checked=on;
}

function paintStacks(){
  for(const [id,badge] of stackBadges){
    const stacks=buffStacks(id);
    badge.textContent=stacks>0?"×"+stacks:"";
    badge.hidden=stacks<=0;
  }
}

function open(){
  root.hidden=false;
  if(!armedFreeOnce){ armedFreeOnce=true; setFreeCosts(true); toast("card sandbox — free placement on"); }
  else document.getElementById("csFreeCosts").checked=DBG.freeCosts;
  paintStacks();
  root.focus();
}
function close(){ root.hidden=true; }
function toggle(){ isOpen()?close():open(); }

/** One clickable cell: the shared card face plus this bench's own affordances (stack badge,
 * out-of-pool tag, disabled reason). The face is presentation; the wrapper owns the click. */
function buildCell(card){
  const cell=document.createElement("div");
  cell.className="csCard";
  cell.dataset.search=(card.id+" "+card.text+" "+card.rarity+" "+card.category+" "+(card.tags||[]).join(" ")).toLowerCase();
  cell.dataset.inactive=cardStatus(card)==="active"?"":"1";
  cell.appendChild(cardFace(card.id));
  if(!card.inPool){ const tag=document.createElement("span"); tag.className="csTag"; tag.textContent="out of pool"; cell.appendChild(tag); }
  const flash=()=>{ cell.classList.remove("dealt"); void cell.offsetWidth; cell.classList.add("dealt"); };
  if(DEALABLE.has(card.category)){
    cell.title=card.rarity+" · "+card.text+" — deal into hand (shift: stay open)";
    cell.addEventListener("click",event=>{
      if(!debugDealCard(card.id))return;
      flash();
      if(!event.shiftKey)close();
    });
  }else if(card.category==="buff"&&card.implemented){
    const badge=document.createElement("span"); badge.className="csStacks"; badge.hidden=true;
    cell.appendChild(badge); stackBadges.set(card.id,badge);
    cell.title=card.rarity+" · "+card.text+" — apply one uncapped debug stack";
    cell.addEventListener("click",()=>{ if(debugApplyBuff(card.id)){ flash(); paintStacks(); } });
  }else{
    cell.classList.add("csOff");
    cell.title=card.rarity+" · "+card.text+(card.category==="buff"?" — not implemented yet":" — not holdable (applies on draft)");
  }
  return cell;
}

function buildGrid(){
  grid.replaceChildren(); stackBadges.clear();
  for(const [category,label] of GROUPS){
    // Availability first (clickable, then out-of-pool, then dead), rarity ladder inside each band,
    // registry order breaking ties — so the cards you actually came to deal lead every section.
    const cards=CARDS.map((card,index)=>({card,index})).filter(({card})=>card.category===category)
      .sort((a,b)=>(STATUS_RANK[cardStatus(a.card)]-STATUS_RANK[cardStatus(b.card)])
        ||(RARITY_RANK[a.card.rarity]-RARITY_RANK[b.card.rarity])
        ||(a.index-b.index))
      .map(({card})=>card);
    if(!cards.length)continue;
    const section=document.createElement("section"); section.className="csSection";
    const heading=document.createElement("h3"); heading.textContent=label+" ("+cards.length+")";
    const row=document.createElement("div"); row.className="csRow";
    for(const card of cards) row.appendChild(buildCell(card));
    section.append(heading,row); grid.appendChild(section);
  }
}

function applyFilter(){
  const query=document.getElementById("csFilter").value.trim().toLowerCase();
  const showInactive=document.getElementById("csShowInactive").checked;
  for(const section of grid.querySelectorAll(".csSection")){
    let visible=0;
    for(const cell of section.querySelectorAll(".csCard")){
      const hit=(!query||cell.dataset.search.includes(query))&&(showInactive||!cell.dataset.inactive);
      cell.hidden=!hit; if(hit)visible++;
    }
    section.hidden=visible===0;
  }
}

// Capture phase, same reason as the draft overlay's handler: input.js's pause chain and the hand's
// digit keys are already bound on window, and an open sandbox must swallow Escape/C before them.
function onKeyDownCapture(event){
  if(event.code==="KeyC"&&!event.repeat&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!typingInField()){
    event.preventDefault(); event.stopImmediatePropagation(); toggle(); return;
  }
  if(!isOpen())return;
  if(event.code==="Escape"){
    event.preventDefault(); event.stopImmediatePropagation();
    if(typingInField())document.activeElement.blur(); else close();
  }
}

export function initCardSandbox(){
  root=document.getElementById("cardSandbox");
  grid=document.getElementById("csGrid");
  buildGrid();
  document.getElementById("csClose").addEventListener("click",close);
  document.getElementById("csClearHand").addEventListener("click",()=>{ debugClearHand(); });
  document.getElementById("csFreeCosts").addEventListener("change",event=>setFreeCosts(event.target.checked));
  document.getElementById("csFilter").addEventListener("input",applyFilter);
  document.getElementById("csShowInactive").addEventListener("change",applyFilter);
  applyFilter();   // the toggle starts unchecked, so inactive cards begin hidden
  // The launcher lives in the view panel's authored markup (gameplay > cards).
  document.getElementById("vOpenCardSandbox")?.addEventListener("click",open);
  window.addEventListener("keydown",onKeyDownCapture,true);
}
