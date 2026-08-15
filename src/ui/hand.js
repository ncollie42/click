// Owns: the fanned hand strip at the bottom of the stage, the card face that the draft
// overlay reuses, and every card animation (consume flights, arrivals, the active lift).
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
// Layout note — the fan owns the bottom band. The build dock is GONE (building is card-driven now),
// so the fan no longer has to share the bottom of the stage with a 244px rail. styles.css widened
// #handDock accordingly and moved the keyboard legend into the corner the dock left; placeCards()
// still fits the fan inside THAT measured box, so the guarantee that nothing collides comes from
// one measurement rather than constants in two files that could drift. Three things the fan now
// does for itself, all in placeCards(): it writes its own BASELINE so a tilted outermost card is
// never cropped by the frame, it thins its own body text past a density threshold so a neighbour
// cannot cover a sentence, and it drops to a PEEK sliver while a night wave is live.
// The toast lane rides above the fan and steps up again while a card is raised.
// ═══════════════════════════════════════════════════════════════════════════
import {cardById} from "../game/cards.js";
import {hand, playCard, state} from "../game/simulation.js";
import {BASE, TOWER_VARIANTS, UPGRADES, BUILDING_TYPES} from "../game/data.js";
import {project} from "../render/scene.js";

// ── tuning ──────────────────────────────────────────────────────────────────
// One record so the fan's geometry is readable as a table rather than scattered constants.
const FAN = {
  // Fraction of a card's width between neighbouring centres when the hand is small — which is
  // also how much of each card the fan leaves uncovered, since every card is painted over by
  // its right-hand neighbour. At .83 a card keeps its number, eyebrow, glyph and whole name in
  // the clear and only its right margin goes under. A relative figure, so it survives the
  // card shrinking at narrow frame sizes.
  step:.83,
  widthMax:640,    // px the whole fan may span; a big hand tightens its overlap instead
  edgePad:26,      // px of frame the OUTERMOST card must still leave, tilt included
  tiltPerCard:4.4, // degrees added to the spread per extra card
  tiltMax:13,      // degrees from the centre card to an outermost one
  arc:14,          // px the outermost card sits below the centre one
  // px of clear frame under the LOWEST point of the fan. placeCards() adds the dip and the drop a
  // tilted card's bottom corner makes on top of this, and writes the sum as #handCards' `bottom` —
  // so the card that used to lose its charge pips off the bottom of the letterbox cannot, at any
  // hand size, tilt, or card width. It is a floor, not the baseline itself.
  floor:22,
  lift:52,         // px a hovered or focused card rises
  scale:1.6,       // how far it grows — enough that the effect text reads at a glance
  part:20,         // px the neighbours step aside to let it through
  activeLift:40,   // px the card currently running a placement holds itself up
  activeScale:1.1, // and how far it grows while it does — a lift, not a takeover
  // Hand size at which a card's right-hand neighbour starts covering its effect text. Past it the
  // fan goes DENSE: body text is suppressed on every unraised card (styles.css owns the rule) and
  // the name, glyph and pips carry the card on their own.
  denseFrom:6,
};
const MAX_KEY = 9;
// Cards whose whole effect happens AT THE BASE — they feed it, heal it, or land in its stores. A
// spent one flies there; everything else burns off straight up out of the frame. Read by
// spendFlight() and nothing else; a card missing from this set simply takes the default exit.
const BASE_BOUND = new Set(["woodBundle","stoneBundle","dustBundle","healBase","baseHp","handCarry"]);

let root=null,list=null,flights=null,hint=null;
let focus=-1;        // keyboard browse cursor
let hover=-1;        // pointer hover
let reduced=false;
let peekOverride=null;  // the h key: null follows the night-wave rule, true forces the sliver, false forces it open
let peeking=null;       // last painted peek answer, so the frame tap only touches the DOM on a change
let playedOnce=false;   // the legend fades after the first successful play; runtime only, nothing stored
let spendWatch=null;    // id of a card mid-placement; renderHand() flies it out when it leaves the hand

// ── the card's picture ──────────────────────────────────────────────────────
// src/game/cards.js authors the card's MEANING (category, rarity, text, charges) and no
// presentation at all, so the three things a face needs beyond that are made here — for the whole
// 57-card registry, not a hand-picked subset, because any inPool card can turn up in an offer.
//
// Card ids are camelCase and the whole UI is lowercase, so an id is split at its humps rather than
// flattened into one word: chopYield -> "chop yield". Nothing else renames a card.
const cardName=id=>id.replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase();
const CATEGORY_LABEL={buff:"buff",consumable:"consumable",aura:"aura",blueprint:"blueprint"};

// The glyph. A card's `ref` already names what it unlocks, so towers and upgrades read their
// authored icon straight out of data.js and stay in step with it for free. The rest of the refs
// point at things that own no icon (buildings) or at nothing built yet (concepts), so those are
// presentation-only picks made HERE, drawn from the same glyph vocabulary the authored tables use.
const REF_GLYPHS={
  "concept:clickCombat":"✊","concept:chopTime":"↻","concept:chopYield":"⛏","concept:crit":"⌖",
  "concept:chainLightning":"ϟ","concept:loadedDrop":"▣","concept:enemySlam":"↓","concept:retaliation":"↩",
  "concept:workerSpeed":"»","concept:workerCarry":"▣","concept:houseSlots":"⌂","concept:workerHp":"♥",
  "concept:dawnHeal":"☀","concept:towerDamage":"●","concept:towerSpeed":"↯","concept:towerRange":"◎",
  "concept:dawnRepair":"▦","concept:baseHp":"⌂","concept:nightGather":"☾","concept:feedXp":"◉",
  "concept:fireball":"♨","concept:treants":"♣","concept:healBase":"♥","concept:repairTowers":"▦","concept:rushBuild":"↯",
  "concept:bundle":"▣","concept:tempWorker":"☝","concept:calmNight":"☾","concept:longDay":"☀",
  "concept:draftMeta":"↻","concept:barracks":"⚔","concept:mendingBeacon":"♥","concept:towerStandard":"✦",
  "concept:warDrum":"⚔","concept:frostTotem":"❄","concept:luckyTotem":"◆","concept:wildFoundation":"♣",
  "concept:dustSiphon":"⌁","concept:coinPress":"◎","concept:diamondDrill":"◈",
  "building:blast":"●","building:spikes":"▲","building:landmine":"◉","building:tar":"≋","building:obelisk":"▰",
  // The base kit. These five refs are the buildings the shop used to sell; BUILDING_TYPES owns
  // their names and costs but no icon, so — like every other building above — the picture is
  // chosen here, out of the same glyph vocabulary the authored tables use.
  "building:house":"⌂","building:lumber":"♣","building:quarry":"⛏","building:stockpile":"▣","building:tower":"⌖",
};
// The last resort, one per category — so a card added to the registry tomorrow draws a picture the
// day it lands instead of a hole where one should be. Nothing here can return empty.
const CATEGORY_GLYPHS={buff:"✦",consumable:"◈",aura:"◎",blueprint:"⌂"};
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
/** A blueprint's id is a slug for the thing it unlocks ("bpSniper"), and that thing already has an
 *  authored name — head the card with what it builds rather than with the slug. */
function cardTitle(card){ return card.category==="blueprint"&&refName(card.ref)||cardName(card.id); }
/** A blueprint's own `text` is its category said a third time ("blueprint: sniper tower"), after
 *  the eyebrow and the name. The authored table that NAMES the thing also describes it, so the
 *  card carries that line instead and says something the rest of the face does not. */
function cardText(card){
  const [kind,name]=String(card.ref||"").split(":");
  return card.category==="blueprint"&&kind==="tower"&&TOWER_VARIANTS[name]?.description||card.text;
}
/**
 * The note line under the effect text: rarity, then whatever ELSE the catalog fields say outright.
 * Composed rather than quoted, because `notes` in the registry is a design/feature-tracker field
 * written for the people building the game ("layered over TUNE.clickDamage at read time"), not a
 * line to put in front of a player. Every branch below reads one authored field and states it.
 */
function cardNote(card){
  const detail=card.category==="blueprint"?(refName(card.ref)?"one site · you supply the materials":"a plan for something unbuilt")
    :card.category==="aura"?"one placement · "+card.durationSeconds+"s"
    :card.charges>1?card.charges+" placements"
    :card.category==="buff"&&card.stacks>1?"stacks to "+card.stacks
    :"";
  return [card.rarity,detail].filter(Boolean).join(" · ");
}

// ── the card face ───────────────────────────────────────────────────────────
// One anatomy, two sizes. Everything inside is em-based off the card's own font-size, which
// styles.css derives from --cw, so a 104px hand card and a 236px draft pick are the same
// drawing at two scales rather than two drawings. Category eyebrow, glyph, name, rule,
// effect text, notes line, then the footer that carries charge pips and the count badge.
export function cardFace(id,{key=null,count=1,charges=null}={}){
  // An id with no catalog row cannot happen through hand() or draftPending(), but the face is the
  // last thing between a catalog bug and a blank rectangle on screen, so it draws one anyway.
  const def=cardById[id]||{id,category:"consumable",rarity:"common",text:"",ref:""};
  const el=document.createElement("article");
  el.className="card r-"+def.rarity+" c-"+def.category;
  el.dataset.id=id;
  const add=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;el.appendChild(node);return node;};
  if(key!==null){const k=document.createElement("kbd");k.className="card-key";k.textContent=key;el.appendChild(k);}
  add("header","card-eyebrow",CATEGORY_LABEL[def.category]||def.category);
  add("div","card-glyph",cardGlyph(def));
  add("h4","card-name",cardTitle(def));
  add("div","card-rule");
  add("p","card-text",cardText(def));
  add("p","card-note",cardNote(def));
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

// ── the fan ─────────────────────────────────────────────────────────────────
// Every card is absolutely positioned on one origin point and placed by four CSS variables,
// so a repaint and a hover are the same code path and the transition between them is CSS's
// problem. Cards tilt about their own bottom edge, which is what keeps the bottoms on a
// shallow curve instead of swinging them off it.
/** Which held card is running the simulation's placement flow, or -1. state.cardTargeting names
 *  the card by id and the hand holds one entry per id, so the two cannot disagree. */
function activeIndex(){
  const id=state.cardTargeting?.id;
  return id?hand().findIndex(entry=>entry.id===id):-1;
}
function placeCards(){
  const cards=[...list.children],n=cards.length;
  if(!n)return;
  // The fan is fitted to #handDock's measured box, minus the room a hovered card needs to grow
  // sideways and the edge lane an outermost tilted card must still leave — that box is what
  // styles.css sizes against the frame, so the whole no-collision guarantee comes from one
  // measurement rather than constants in two files that could drift apart.
  const cardW=cards[0].offsetWidth;
  const span=Math.max(0,Math.min(FAN.widthMax,root.clientWidth-cardW*FAN.scale-FAN.edgePad*2));
  const step=n<2?0:Math.min(cardW*FAN.step,span/(n-1));
  const tilt=Math.min(FAN.tiltPerCard*(n-1),FAN.tiltMax);
  // THE anti-crop rule. A card is tilted about its own bottom CENTRE, so the corner that swings
  // down clears (cardW/2)·sin(tilt) below the pivot, and the arc has already pushed an outermost
  // card FAN.arc further down. Raising the whole strip by that sum plus the floor is what keeps
  // the outermost card of a nine-card fan — pips, stack shadow and all — inside the frame.
  const drop=FAN.arc+(cardW/2)*Math.sin(tilt*Math.PI/180);
  list.style.bottom=(FAN.floor+drop).toFixed(1)+"px";
  // Past the density threshold a neighbour covers the card's effect text; styles.css hides it on
  // everything that is not raised, so what is on screen is either whole or absent, never half.
  list.classList.toggle("dense",n>=FAN.denseFrom);
  const raised=hover>=0?hover:focus;
  const active=activeIndex();
  cards.forEach((el,i)=>{
    const t=n<2?0:(i-(n-1)/2)/((n-1)/2);   // -1 .. 1 across the fan
    let x=(i-(n-1)/2)*step,y=FAN.arc*t*t,rot=t*tilt,scale=1;
    if(i===raised){rot=0;y=-FAN.lift;scale=FAN.scale;}
    else if(raised>=0)x+=i<raised?-FAN.part:FAN.part;
    else if(i===active){rot*=.35;y=-FAN.activeLift;scale=FAN.activeScale;}
    el.style.setProperty("--x",x.toFixed(1)+"px");
    el.style.setProperty("--y",y.toFixed(1)+"px");
    el.style.setProperty("--rot",rot.toFixed(2)+"deg");
    el.style.setProperty("--scale",scale.toFixed(3));
    // Raised card on top, then the active one, then left-to-right so the fan overlaps the way
    // a held hand does; the arriving card needs the top of the stack while it lands.
    el.style.zIndex=String(i===raised?90:i===active?80:10+i);
    el.classList.toggle("raised",i===raised);
    el.classList.toggle("active",i===active&&i!==raised);
  });
  root.classList.toggle("targeting",active>=0);
  // A raised card is tall enough to reach the notification lane, so the lane steps up out of
  // its way. #toast already transitions `bottom`, so this costs one class and no new motion.
  document.getElementById("game").classList.toggle("hand-raised",raised>=0);
}

let arrivalId=null;   // an id the next repaint must hold back for a flight
export function renderHand(){
  if(!list)return;
  const cards=hand();
  // A card spent by PLACEMENT leaves the hand out on the map, not under the cursor — the last
  // charge lands on a click the fan never sees, and the only signal is this repaint arriving with
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
 * themselves moved, only which one owns the cursor. Re-placing the fan is the whole response:
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
// The judge's condition for keeping the fan bottom-centre: during a live night wave the bottom of
// the battlefield is where the fighting is, so the hand gets out of the way. It drops to a sliver
// (styles.css owns the transform) and rises again on hover, or on the h key at any time.
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
  // still the raised one — drop the cursor and re-place, or the fan settles around a gap.
  if(result==="applied"){hover=-1;focus=-1;placeCards();spendFlight(id,before);}
  // "targeting" spends nothing YET: the card stays in hand, one charge lighter per placement, and
  // leaves on the click that empties it. renderHand() watches for exactly that and flies it then.
  else if(result==="targeting"){spendWatch=id;hover=-1;focus=index;placeCards();}
  // Refused (the simulation said no and announced why): a short shudder on the card that was
  // asked for, as a class rather than a keyframe list, so it composes with the fan transform
  // the card is already wearing instead of fighting it.
  else{el.classList.remove("refused");void el.offsetWidth;el.classList.add("refused");}
}

const CARD_RATIO=1.54;  // the one place the card's shape is written down outside styles.css
/**
 * A card's VISUAL box: its centre from the live rectangle (correct through any fan rotation or
 * hover scale) and the width a flight clone must be built at. Exported because the draft
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
  const run=ghost.animate(frames,{duration:reduced?180:toBase?560:480,easing:reduced?"linear":"cubic-bezier(.4,0,.7,.45)"});
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
  const run=ghost.animate(frames,{duration:reduced?200:620,easing:reduced?"linear":"cubic-bezier(.34,.72,.32,1)"});
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
// Q and E walk a browse cursor along the fan, which raises exactly what hover raises;
// enter or space plays whatever it is on; H lowers the fan to its peek sliver (and back);
// escape drops the cursor. Registered ahead of
// src/input.js so escape can clear the cursor before the pause chain sees it, and every
// branch bails while a modal owns the screen or a digit is shifted (shift+digit is the
// view debugger's tab shortcut).
function onKeyDown(event){
  if(event.repeat||event.ctrlKey||event.metaKey||event.altKey)return;
  if(document.getElementById("game").classList.contains("modal-open"))return;
  const n=list.children.length;
  if(!n)return;
  // H is the manual half of the peek rule: it stows or raises the fan whatever the clock says.
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
  const motion=window.matchMedia("(prefers-reduced-motion:reduce)");
  reduced=motion.matches;
  motion.addEventListener?.("change",event=>{reduced=event.matches;});
  window.addEventListener("keydown",onKeyDown);
  renderHand();
  syncHandPeek();
}
