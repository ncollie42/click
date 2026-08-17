// Owns: the bottom-centred hand row, the card face that the draft overlay reuses, and every
// card animation (pose changes, consume flights, arrivals, and the active lift).
// ═══════════════════════════════════════════════════════════════════════════
// HAND ADAPTER
//
// Ownership / data flow
//   Reads:    src/game/simulation.js — hand(), playCard() and state.cardTargeting, which are the
//             whole contract this file needs; src/game/cards.js for a card's DISPLAY fields; the
//             two authored icon tables in src/game/data.js; and src/render/scene.js's project(),
//             which is the ONE world->screen conversion in the codebase — the consume flight aims
//             at the base with it rather than guessing a screen point.
//   Writes:   the DOM under #handDock and #cardFlights, and nothing else. Every gameplay change
//             leaves through playCard(); this file never assigns into `state`.
//   Supplies: initHand() (registration), renderHand() (repaint — the handChanged sink),
//             syncHandTargeting() (the buildHudChanged sink; see the note on it),
//             syncHandPeek() (the one per-frame tap main.js's draw() makes; see the peek note),
//             cardFace() (the shared card anatomy the draft overlay builds its picks from),
//             expectArrival()/playArrival() (the two halves of "a drafted card flies to hand").
//
// No card rule lives here. What a card DOES, how many charges it carries and where a played one
// goes are all simulation.js's; this file only draws what hand() reports and asks playCard() to
// change it. The one thing it authors is the card's PICTURE — glyph, name casing, category word —
// because src/game/cards.js is a design catalog and holds no presentation.
//
// Layout note — the hand owns the bottom band. placeCards() measures #handDock, keeps a fixed gap,
// shrinks cards only from 150px to 96px, then lets the dock scroll rather than overlap cards. Layout
// writes final positions directly; pose changes are separate, named Web Animations. Under night
// pressure the row lowers but keeps each card's identity visible. The toast lane steps up while a
// card is raised.
// ═══════════════════════════════════════════════════════════════════════════
import {cardById} from "../game/cards.js";
import {hand, playCard, state} from "../game/simulation.js";
import {BASE, TOWER_VARIANTS, UPGRADES, BUILDING_TYPES} from "../game/data.js";
import {project} from "../render/scene.js";
import {motionTiming, prefersReducedMotion, watchReducedMotion} from "./motion.js";

// ── tuning ──────────────────────────────────────────────────────────────────
const HAND_LAYOUT={
  preferredWidth:150,
  narrowPreferredWidth:120,
  narrowFrameWidth:800,
  minimumWidth:96,
  gap:14,
  edgePad:14,      // room for the 15% hover growth at each end of the row
  hoverLift:54,
  hoverScale:1.15,
  activeLift:40,
  activeScale:1.1,
};
const POSES={rest:{y:0,scale:1},hover:{y:-HAND_LAYOUT.hoverLift,scale:HAND_LAYOUT.hoverScale},
  active:{y:-HAND_LAYOUT.activeLift,scale:HAND_LAYOUT.activeScale}};
const MAX_KEY = 9;
// Cards whose whole effect happens AT THE BASE — they feed it, heal it, or land in its stores. A
// spent one flies there; everything else burns off straight up out of the frame. Read by
// spendFlight() and nothing else; a card missing from this set simply takes the default exit.
const BASE_BOUND = new Set(["woodBundle","stoneBundle","dustBundle","healBase","baseHp","handCarry"]);

let root=null,list=null,flights=null,hint=null,layoutObserver=null;
const poseAnimations=new WeakMap();
let focus=-1;        // keyboard browse cursor
let hover=-1;        // pointer hover
let reduced=false;
let peekOverride=null;  // the h key: null follows night pressure, true lowers the row, false keeps it open
let peeking=null;       // last painted peek answer, so the frame tap only touches the DOM on a change
let playedOnce=false;   // the legend fades after the first successful play; runtime only, nothing stored
let spendWatch=null;    // id of a card mid-placement; renderHand() flies it out when it leaves the hand

// ── the card's picture ──────────────────────────────────────────────────────
// src/game/cards.js authors the card's MEANING (category, rarity, text, charges) and no
// presentation at all, so the three things a face needs beyond that are made here — for the whole
// card registry, not a hand-picked subset, because any inPool card can turn up in an offer.
//
// Card ids are camelCase and the whole UI is lowercase, so an id is split at its humps rather than
// flattened into one word: chopYield -> "chop yield". Nothing else renames a card.
const cardName=id=>id.replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase();
const CATEGORY_LABEL={buff:"buff",consumable:"consumable",aura:"aura",build:"build"};

// The glyph. A card's `ref` already names what it unlocks, so towers and upgrades read their
// authored icon straight out of data.js and stay in step with it for free. The rest of the refs
// point at things that own no icon (buildings) or at nothing built yet (concepts), so those are
// presentation-only picks made HERE, drawn from the same glyph vocabulary the authored tables use.
const REF_GLYPHS={
  "concept:clickCombat":"✊","concept:chopTime":"↻","concept:chopYield":"⛏","concept:crit":"⌖",
  "concept:chainLightning":"ϟ","concept:freeHit":"✦","concept:enemyPickup":"☝","concept:loadedDrop":"▣","concept:enemySlam":"↓","concept:retaliation":"↩",
  "concept:workerSpeed":"»","concept:workerCarry":"▣","concept:houseSlots":"⌂","concept:workerHp":"♥",
  "concept:dawnHeal":"☀","concept:towerDamage":"●","concept:towerSpeed":"↯","concept:towerRange":"◎",
  "concept:dawnRepair":"▦","concept:baseHp":"⌂","concept:nightGather":"☾","concept:feedXp":"◉",
  "concept:screenClick":"✊","concept:resourceRecall":"⌁","concept:touchOfDeath":"☠","concept:meteor":"●",
  "concept:fireball":"♨","concept:treants":"♣","concept:healBase":"♥","concept:repairTowers":"▦","concept:rushBuild":"↯",
  "concept:bundle":"▣","concept:tempWorker":"☝","concept:calmNight":"☾","concept:longDay":"☀",
  "concept:draftMeta":"↻","concept:barracks":"⚔","concept:mendingBeacon":"♥","concept:towerStandard":"✦",
  "concept:warDrum":"⚔","concept:frostTotem":"❄","concept:luckyTotem":"◆","concept:wildFoundation":"♣",
  "concept:dustSiphon":"⌁","concept:coinPress":"◎","concept:diamondDrill":"◈",
  "building:blast":"●","building:spikes":"▲","building:landmine":"◉","building:tar":"≋","building:obelisk":"▰","building:damageOrbs":"◉","building:summoningCircle":"◎",
  // The base kit. These five refs are the buildings the shop used to sell; BUILDING_TYPES owns
  // their names and costs but no icon, so — like every other building above — the picture is
  // chosen here, out of the same glyph vocabulary the authored tables use.
  "building:house":"⌂","building:lumber":"♣","building:quarry":"⛏","building:stockpile":"▣","building:tower":"⌖",
  // The capture yard's picture is the three-bay pen read edge-on: distinct from the storage "▣".
  "building:captureYard":"▤",
};
// The last resort, one per category — so a card added to the registry tomorrow draws a picture the
// day it lands instead of a hole where one should be. Nothing here can return empty.
const CATEGORY_GLYPHS={buff:"✦",consumable:"◈",aura:"◎",build:"⌂"};
function cardGlyph(card){
  const [kind,name]=String(card.ref||"").split(":");
  const authored=kind==="tower"?TOWER_VARIANTS[name]?.icon
    :kind==="upgrade"?UPGRADES.find(upgrade=>upgrade.id===name)?.icon
    :REF_GLYPHS[card.ref];
  return authored||CATEGORY_GLYPHS[card.category]||"✦";
}

/** The authored name of whatever a ref points at, or null for a concept that owns no table row. */
function refName(ref){
  const [kind,name]=String(ref||"").split(":");
  return kind==="tower"?TOWER_VARIANTS[name]?.name||null
    :kind==="building"?BUILDING_TYPES[name]?.name||null:null;
}
/** A build card's id is a slug for the thing it unlocks ("bpSniper"), and that thing already has an
 *  authored name — head the card with what it builds rather than with the slug. */
function cardTitle(card){ return card.category==="build"&&refName(card.ref)||cardName(card.id); }
/** A tower build's own `text` is its category said again after the eyebrow and the name. The
 *  authored table that NAMES the tower also describes it, so the card carries that line instead
 *  and says something the rest of the face does not. */
function cardText(card){
  const [kind,name]=String(card.ref||"").split(":");
  return card.category==="build"&&kind==="tower"&&TOWER_VARIANTS[name]?.description||card.text;
}
/** The authored tower a build card's placement stands up, or null for anything else. The chassis
 *  card ("building:tower") is the basic variant — same table row the finished tower fights with. */
function towerVariant(card){
  if(card.category!=="build")return null;
  const [kind,name]=String(card.ref||"").split(":");
  return kind==="tower"?TOWER_VARIANTS[name]||null:kind==="building"&&name==="tower"?TOWER_VARIANTS.basic:null;
}
// ── the card face ───────────────────────────────────────────────────────────
// One anatomy, two sizes. Everything inside is em-based off the card's own font-size, which
// styles.css derives from --cw, so a 150px hand card and a 236px draft pick are the same drawing
// at two scales rather than two drawings. Category eyebrow, glyph, name, rule, effect text, then
// the footer that carries charge pips and the count badge. Rarity stays visual in the frame rather
// than being repeated as secondary copy.
export function cardFace(id,{key=null,count=1,charges=null}={}){
  // An id with no catalog row cannot happen through hand() or draftPending(), but the face is the
  // last thing between a catalog bug and a blank rectangle on screen, so it draws one anyway.
  const def=cardById[id]||{id,category:"consumable",rarity:"common",text:"",ref:""};
  const el=document.createElement("article");
  el.className="card r-"+def.rarity+" c-"+def.category;
  el.dataset.id=id;
  const add=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;el.appendChild(node);return node;};
  if(key!==null){const k=document.createElement("kbd");k.className="card-key";k.textContent=key;el.appendChild(k);}
  add("header","card-eyebrow",def.type==="spell"?"spell":CATEGORY_LABEL[def.category]||def.category);
  add("div","card-glyph",cardGlyph(def));
  add("h4","card-name",cardTitle(def));
  add("div","card-rule");
  add("p","card-text",cardText(def));
  // The stat strip, only on a card that places a tower. Values are read at draw time from the
  // same TOWER_VARIANTS row the glyph and description come from, so a data.js tuning pass
  // changes the face for free. Area towers own no `range`; their effectRadius fills the slot.
  const tower=towerVariant(def);
  if(tower){
    const stats=add("div","card-stats");
    const stat=(short,value,label)=>{
      const cell=document.createElement("span");cell.className="stat";
      cell.setAttribute("aria-label",label+" "+value);
      const tag=document.createElement("i");tag.setAttribute("aria-hidden","true");tag.textContent=short;
      cell.append(tag,String(value));
      stats.appendChild(cell);
    };
    stat("dmg:",tower.damage,"damage");
    stat("cd:",tower.cooldown+"s","fires every");
    stat("hp:",tower.maxHp,"hp");
    if(tower.range!==undefined)stat("range:",tower.range,"range");
    else stat("area:",tower.effectRadius,"area radius");
  }
  const foot=add("footer","card-foot");
  // Charge pips: the kit's authored total, filled to whatever is left. A card with no charge
  // track draws no pips at all, so the row only ever appears on something that can be spent
  // in pieces. `charges` is null while every copy is untouched — that reads as a full kit.
  if(def.charges>1){
    const left=charges===null||charges===undefined?def.charges:charges;
    const pips=document.createElement("span");pips.className="pips";
    pips.setAttribute("aria-label",left+" of "+def.charges+" placements left");
    for(let i=0;i<def.charges;i++){const pip=document.createElement("i");pip.className="pip"+(i<left?" on":"");pips.appendChild(pip);}
    foot.appendChild(pips);
    const tally=document.createElement("span");tally.className="pip-count";tally.textContent=left+"/"+def.charges;
    foot.appendChild(tally);
  }
  if(count>1){
    el.dataset.count=String(count);   // draws the second card behind this one, see styles.css
    const badge=document.createElement("span");badge.className="card-count";badge.textContent="×"+count;el.appendChild(badge);
  }
  return el;
}

// ── row layout and authored poses ───────────────────────────────────────────
/** Which held card is running the simulation's placement flow, or -1. state.cardTargeting names
 *  the card by id and the hand holds one entry per id, so the two cannot disagree. */
function activeIndex(){
  const id=state.cardTargeting?.id;
  return id?hand().findIndex(entry=>entry.id===id):-1;
}
function transformAt(x,pose){return `translate3d(${x.toFixed(1)}px,${pose.y}px,0) scale(${pose.scale})`;}
/** Layout is already at its destination when this runs. WAAPI owns only the temporary pose path,
 *  so resize/reflow never becomes coupled to hover animation. */
function animatePose(el,fromName,toName,x,kind){
  const previous=poseAnimations.get(el);if(previous)previous.cancel();
  const from=POSES[fromName]||POSES.rest,to=POSES[toName];
  el.style.setProperty("--y",to.y+"px");el.style.setProperty("--scale",String(to.scale));
  if(reduced||fromName===toName||!el.animate)return;
  let frames,timing;
  if(toName==="hover"&&kind==="pointer"){
    frames=[{transform:transformAt(x,from)},{transform:transformAt(x,{y:4,scale:.99}),offset:.12},
      {transform:transformAt(x,{y:-59,scale:1.18}),offset:.7},{transform:transformAt(x,to)}];
    timing=motionTiming("lift","slow",{element:root,reduced:false});
  }else if(toName==="hover"){
    frames=[{transform:transformAt(x,from)},{transform:transformAt(x,{y:-57,scale:1.17}),offset:.72},
      {transform:transformAt(x,to)}];
    timing=motionTiming("lift","medium",{element:root,reduced:false});
  }else if(toName==="active"){
    frames=[{transform:transformAt(x,from)},{transform:transformAt(x,{y:3,scale:.99}),offset:.12},
      {transform:transformAt(x,{y:-44,scale:1.12}),offset:.72},{transform:transformAt(x,to)}];
    timing=motionTiming("lift","slow",{element:root,reduced:false});
  }else{
    frames=[{transform:transformAt(x,from)},{transform:transformAt(x,{y:3,scale:.985}),offset:.72},
      {transform:transformAt(x,to)}];
    timing=motionTiming("settle","medium",{element:root,reduced:false});
  }
  const animation=el.animate(frames,timing);
  poseAnimations.set(el,animation);
  animation.finished.then(()=>{if(poseAnimations.get(el)===animation)poseAnimations.delete(el);},()=>{});
}
function revealCard(index,cardW){
  if(index<0||!root.classList.contains("overflow"))return;
  const left=HAND_LAYOUT.edgePad+index*(cardW+HAND_LAYOUT.gap),right=left+cardW;
  let target=root.scrollLeft;
  if(left<target)target=left-HAND_LAYOUT.edgePad;
  else if(right>target+root.clientWidth)target=right-root.clientWidth+HAND_LAYOUT.edgePad;
  if(target!==root.scrollLeft)root.scrollTo({left:target,behavior:reduced?"auto":"smooth"});
}
function placeCards(){
  const cards=[...list.children],n=cards.length;
  if(!n){list.style.width="0px";root.classList.remove("overflow");return;}
  const available=Math.max(0,root.clientWidth-HAND_LAYOUT.edgePad*2);
  const fitWidth=(available-HAND_LAYOUT.gap*(n-1))/n;
  const preferred=root.clientWidth<HAND_LAYOUT.narrowFrameWidth
    ?HAND_LAYOUT.narrowPreferredWidth:HAND_LAYOUT.preferredWidth;
  const cardW=Math.min(preferred,Math.max(HAND_LAYOUT.minimumWidth,fitWidth));
  const rowW=HAND_LAYOUT.edgePad*2+n*cardW+(n-1)*HAND_LAYOUT.gap;
  const overflowing=rowW>root.clientWidth+.5;
  list.style.setProperty("--cw",cardW.toFixed(2)+"px");
  list.style.width=rowW.toFixed(1)+"px";
  list.style.left=(overflowing?0:(root.clientWidth-rowW)/2).toFixed(1)+"px";
  root.classList.toggle("overflow",overflowing);
  if(!overflowing)root.scrollLeft=0;

  const raised=hover>=0?hover:focus,active=activeIndex();
  cards.forEach((el,i)=>{
    const x=HAND_LAYOUT.edgePad+i*(cardW+HAND_LAYOUT.gap);
    const pose=i===raised?"hover":i===active?"active":"rest";
    const oldPose=el.dataset.pose;
    el.style.setProperty("--x",x.toFixed(1)+"px");
    if(oldPose===undefined){const value=POSES[pose];el.style.setProperty("--y",value.y+"px");el.style.setProperty("--scale",String(value.scale));}
    else animatePose(el,oldPose,pose,x,raised===i&&hover===i?"pointer":"keyboard");
    el.dataset.pose=pose;
    el.style.zIndex=String(i===raised?90:i===active?80:10);
    el.classList.toggle("raised",i===raised);
    el.classList.toggle("active",i===active&&i!==raised);
  });
  root.classList.toggle("targeting",active>=0);
  if(focus>=0)revealCard(focus,cardW);
  document.getElementById("game").classList.toggle("hand-raised",raised>=0);
}

let arrivalId=null;   // an id the next repaint must hold back for a flight
export function renderHand(){
  if(!list)return;
  const cards=hand();
  // A card spent by PLACEMENT leaves the hand out on the map, not under the cursor — the last
  // charge lands on a click the hand never sees, and the only signal is this repaint arriving with
  // one fewer card. So the box of the watched card is measured while it is still on screen, and
  // the flight is launched from it the moment it is gone. (An "applied" play flies from play()
  // itself, which can measure before the simulation moves.)
  const leaving=spendWatch&&!cards.some(entry=>entry.id===spendWatch)
    ? [...list.children].find(el=>el.dataset.id===spendWatch)
    : null;
  const leavingBox=leaving?cardBox(leaving,Number(leaving.style.getPropertyValue("--scale"))||1):null;
  list.replaceChildren();
  cards.forEach((entry,i)=>{
    const el=cardFace(entry.id,{key:i<MAX_KEY?String(i+1):null,count:entry.count,charges:entry.charges});
    el.tabIndex=-1;
    el.dataset.index=String(i);
    if(entry.id===arrivalId)el.classList.add("arriving");
    el.addEventListener("pointerenter",()=>{hover=i;focus=-1;placeCards();});
    el.addEventListener("pointerleave",()=>{if(hover===i)hover=-1;placeCards();});
    el.addEventListener("click",()=>play(i));
    list.appendChild(el);
  });
  if(focus>=cards.length)focus=cards.length?cards.length-1:-1;
  if(hover>=cards.length)hover=-1;
  root.classList.toggle("empty",cards.length===0);
  if(hint)hint.hidden=cards.length===0;
  placeCards();
  if(leavingBox){spendFlight(spendWatch,leavingBox);spendWatch=null;}
  else if(spendWatch&&!cards.some(entry=>entry.id===spendWatch))spendWatch=null;
}
/**
 * The buildHudChanged sink. Cancelling a placement (right-click, escape) clears
 * state.cardTargeting and raises buildHudChanged, not handChanged — nothing about the cards
 * themselves moved, only which one owns the cursor. Re-placing the row is the whole response:
 * the lifted card settles back and its glow goes out. Cheap, and it keeps hover alive, which
 * a full repaint would not.
 */
export function syncHandTargeting(){
  // A put-away kit is not a spend: drop the watch so its next ordinary removal is not mistaken
  // for one, and so a card that never left cannot strand a pending flight.
  if(spendWatch&&!state.cardTargeting)spendWatch=null;
  if(list)placeCards();
}

// ── peek / collapse ─────────────────────────────────────────────────────────
// The judge's condition for keeping the hand bottom-centre: during a live night wave the bottom of
// the battlefield is where the fighting is, so the hand lowers while retaining each card's category,
// icon, and name (styles.css owns the transform). It rises on hover, or on the h key at any time.
// Called once per frame by main.js's draw(), because the two things it reads — the clock phase and
// whether any enemy is alive — move inside update() without a single card changing, so no
// simulation effect can raise it. It writes the DOM only when the answer actually flips.
function nightPressure(){ return state.clock.phase==="night"&&state.enemies.length>0; }
function peekWanted(){ return peekOverride===null?nightPressure():peekOverride; }
export function syncHandPeek(){
  if(!root)return;
  // A card mid-placement must stay reachable, and an empty hand has nothing to hide.
  const want=peekWanted()&&!state.cardTargeting&&list.children.length>0;
  if(want===peeking)return;
  peeking=want;
  root.classList.toggle("peek",want);
}

// ── playing ─────────────────────────────────────────────────────────────────
// The card's own rectangle is measured BEFORE the play, because "applied" repaints the hand
// out from under it — the flight is a clone of a card that no longer exists.
function play(index){
  const el=list.children[index];
  if(!el)return;
  const before=cardBox(el,Number(el.style.getPropertyValue("--scale"))||1),id=el.dataset.id;
  const result=playCard(index);
  if(result==="applied"||result==="targeting")fadeHint();
  // "applied" already repainted the hand through handChanged, but it did so while this card was
  // still raised — drop the cursor and re-place so the row settles consistently.
  if(result==="applied"){hover=-1;focus=-1;placeCards();spendFlight(id,before);}
  // "targeting" spends nothing YET: the card stays in hand, one charge lighter per placement, and
  // leaves on the click that empties it. renderHand() watches for exactly that and flies it then.
  else if(result==="targeting"){spendWatch=id;hover=-1;focus=-1;placeCards();}
  // Refused (the simulation said no and announced why): a short shudder on the card that was
  // asked for, as a class rather than a keyframe list, so it composes with the card pose.
  else{el.classList.remove("refused");void el.offsetWidth;el.classList.add("refused");}
}

const CARD_RATIO=1.54;  // the one place the card's shape is written down outside styles.css
/**
 * A card's VISUAL box: its centre from the live rectangle (correct through hover scale) and the
 * width a flight clone must be built at. Exported because the draft
 * overlay measures its own pick with it and hands the result straight back to playArrival().
 */
export function cardBox(el,scale=1){
  const r=el.getBoundingClientRect();
  return {cx:r.left+r.width/2,cy:r.top+r.height/2,cw:el.offsetWidth*scale};
}
/** A free-floating copy of a card, parked over a visual box on the fixed flight layer. */
function ghostAt(id,box){
  const ghost=cardFace(id,{});
  ghost.classList.add("card-flight");
  ghost.style.setProperty("--cw",box.cw.toFixed(1)+"px");
  ghost.style.left=(box.cx-box.cw/2).toFixed(1)+"px";
  ghost.style.top=(box.cy-box.cw*CARD_RATIO/2).toFixed(1)+"px";
  flights.appendChild(ghost);
  return ghost;
}
/** Where the base is, in viewport pixels — project() is the codebase's only world->screen map. */
function basePoint(){
  const stage=document.getElementById("stage").getBoundingClientRect();
  const p=project(BASE.x,BASE.y,34);
  return {cx:stage.left+stage.width*(p.x/960),cy:stage.top+stage.height*(p.y/540)};
}
/**
 * THE spend. Every card that leaves the hand leaves VISIBLY, whichever way it was spent — an
 * instant effect under the cursor, or the last charge of a kit landing out on the map. The card
 * that was there a frame ago is cloned onto the flight layer and flown off it.
 *
 * Two exits, chosen by where the effect actually happened. A card whose whole effect is AT THE
 * BASE (a bundle, a heal — see BASE_BOUND) flies to the base and burns off over it, aimed with
 * project(), the codebase's one world->screen map. Everything else goes straight up and out of the
 * frame: a spike kit's charges landed wherever the player clicked, and dragging its card across
 * the screen to the base would claim a relationship that is not there.
 * Reduced motion: a plain fade, no travel, for both.
 */
function spendFlight(id,from){
  const ghost=ghostAt(id,from);
  const toBase=BASE_BOUND.has(id);
  let frames;
  if(reduced)frames=[{opacity:1},{opacity:0}];
  else if(toBase){
    const to=basePoint(),dx=to.cx-from.cx,dy=to.cy-from.cy;
    frames=[
      {transform:"translate(0,0) rotate(0deg) scale(1)",opacity:1,filter:"brightness(1)"},
      {transform:"translate("+(dx*.45).toFixed(0)+"px,"+(dy*.4-70).toFixed(0)+"px) rotate(-9deg) scale(1.16)",opacity:1,offset:.42,filter:"brightness(1.4)"},
      {transform:"translate("+dx.toFixed(0)+"px,"+dy.toFixed(0)+"px) rotate(14deg) scale(.16)",opacity:0,filter:"brightness(2.4)"}];
  }else frames=[
    {transform:"translate(0,0) rotate(0deg) scale(1)",opacity:1,filter:"brightness(1)"},
    {transform:"translate(0,-58px) rotate(-4deg) scale(1.12)",opacity:1,offset:.34,filter:"brightness(1.5)"},
    {transform:"translate(0,-260px) rotate(7deg) scale(.72)",opacity:0,filter:"brightness(2.2)"}];
  const run=ghost.animate(frames,motionTiming("exit",toBase?"travel":"flight",{element:root,reduced}));
  run.finished.then(()=>ghost.remove(),()=>ghost.remove());
}

// ── arrivals ────────────────────────────────────────────────────────────────
// Two halves so the draft overlay can measure its own pick before the model moves it:
// expectArrival() names the id the next repaint must render invisible, playArrival() flies a
// clone from the overlay's card into that empty slot and hands it over.
export function expectArrival(id){ arrivalId=id; }
export function playArrival(from){
  const id=arrivalId;arrivalId=null;
  const el=[...(list?.children||[])].reverse().find(node=>node.dataset.id===id);
  if(!el)return Promise.resolve();
  const to=cardBox(el),ghost=ghostAt(id,from);
  const dx=to.cx-from.cx,dy=to.cy-from.cy,scale=to.cw/from.cw;
  const frames=reduced?[{opacity:1},{opacity:0}]:[
    {transform:"translate(0,0) rotate(0deg) scale(1)",opacity:1},
    {transform:"translate("+(dx*.55).toFixed(0)+"px,"+(dy*.32).toFixed(0)+"px) rotate(-6deg) scale("+(scale+(1-scale)*.5).toFixed(3)+")",opacity:1,offset:.55},
    {transform:"translate("+dx.toFixed(0)+"px,"+dy.toFixed(0)+"px) rotate(0deg) scale("+scale.toFixed(3)+")",opacity:1}];
  const run=ghost.animate(frames,motionTiming("enter","arrival",{element:root,reduced}));
  return run.finished.catch(()=>{}).then(()=>{
    ghost.remove();
    el.classList.remove("arriving");
    el.classList.add("landed");
    setTimeout(()=>el.classList.remove("landed"),420);
  });
}
/** Mid-flight freeze for screenshot staging: hold the arrival clone at a given progress. */
export function debugHoldFlights(on){ flights?.getAnimations({subtree:true}).forEach(a=>on?a.pause():a.play()); }

/** The legend has done its job once a card has actually been played. A plain runtime flag — the
 *  hint comes back on reload, which is the right behaviour for a scheme nobody has memorised yet
 *  and costs no storage. */
function fadeHint(){
  if(playedOnce)return;
  playedOnce=true;
  hint?.classList.add("faded");
}

// ── keyboard ────────────────────────────────────────────────────────────────
// 1-9 play the card at that position outright (the number is printed on the card).
// Q and E walk a browse cursor along the row, which raises exactly what hover raises;
// enter or space plays whatever it is on; H lowers the hand to its identity strip (and back);
// escape drops the cursor. Registered ahead of
// src/input.js so escape can clear the cursor before the pause chain sees it, and every
// branch bails while a modal owns the screen or a digit is shifted (shift+digit is the
// view debugger's tab shortcut).
function onKeyDown(event){
  if(event.repeat||event.ctrlKey||event.metaKey||event.altKey)return;
  if(document.getElementById("game").classList.contains("modal-open"))return;
  const n=list.children.length;
  if(!n)return;
  // H is the manual half of the peek rule: it stows or raises the hand whatever the clock says.
  // Nothing else in the game binds it (see src/input.js).
  // It flips whatever is on screen right now, so one press always changes something: stowed goes
  // up, raised goes down, and the night-wave rule takes over again at the next phase boundary.
  if(event.code==="KeyH"&&!event.shiftKey){
    event.preventDefault();
    const next=!peekWanted();
    peekOverride=next===nightPressure()?null:next;
    syncHandPeek();return;
  }
  const digit=/^Digit([1-9])$/.exec(event.code);
  if(digit&&!event.shiftKey){const i=Number(digit[1])-1;if(i<n){event.preventDefault();focus=i;hover=-1;placeCards();play(i);}return;}
  if(event.code==="KeyQ"||event.code==="KeyE"){
    event.preventDefault();
    const step=event.code==="KeyQ"?-1:1;
    focus=focus<0?(step>0?0:n-1):Math.min(n-1,Math.max(0,focus+step));
    hover=-1;placeCards();return;
  }
  if((event.code==="Enter"||event.code==="Space")&&focus>=0){event.preventDefault();play(focus);return;}
  if(event.code==="Escape"&&focus>=0&&activeIndex()<0){event.preventDefault();event.stopImmediatePropagation();focus=-1;placeCards();}
}

// ── registration ────────────────────────────────────────────────────────────
// Called once by main.js, before initInput() (see the escape note above).
export function initHand(){
  root=document.getElementById("handDock");
  list=document.getElementById("handCards");
  flights=document.getElementById("cardFlights");
  hint=document.getElementById("handHint");
  reduced=prefersReducedMotion();
  watchReducedMotion(value=>{reduced=value;});
  window.addEventListener("keydown",onKeyDown);
  // Wheel-to-horizontal conversion is scoped to events originating on cards; empty dock space
  // remains pointer-transparent to battlefield input.
  list.addEventListener("wheel",event=>{
    if(!root.classList.contains("overflow")||Math.abs(event.deltaX)>=Math.abs(event.deltaY))return;
    root.scrollLeft+=event.deltaY;event.preventDefault();
  },{passive:false});
  if("ResizeObserver" in window){layoutObserver=new ResizeObserver(()=>placeCards());layoutObserver.observe(root);}
  else window.addEventListener("resize",placeCards);
  renderHand();
  syncHandPeek();
}
