// Owns: the fanned hand strip at the bottom of the stage, the card face that the draft
// overlay reuses, and every card animation (consume flights, arrivals, the active lift).
// ═══════════════════════════════════════════════════════════════════════════
// HAND ADAPTER
//
// Ownership / data flow
//   Reads:    src/ui/cards.js (the hand/draft contract) and src/render/scene.js's project(),
//             which is the ONE world->screen conversion in the codebase — the consume flight
//             aims at the base with it rather than guessing a screen point.
//   Writes:   the DOM under #handDock and #cardFlights, and nothing else. Every gameplay
//             change leaves through playCard(); this file never touches `state`.
//   Supplies: initHand() (registration), renderHand() (repaint — the handChanged sink),
//             cardFace() (the shared card anatomy the draft overlay builds its picks from),
//             expectArrival()/playArrival() (the two halves of "a drafted card flies to hand").
//
// Layout note — dock coexistence. The build dock used to sit bottom-CENTRE, which is where a
// fanned hand has to live: the fan is the widest thing on screen and its cards rise on hover.
// styles.css moves the dock to the bottom-LEFT corner as a 244px rail whose category panel
// opens upward, and gives #handDock a width that already subtracts both bottom corners (the
// dock and the keyboard hint). placeCards() then fits the fan inside THAT measured box, so
// the guarantee that nothing collides comes from one measurement rather than a pair of
// constants in two files that could drift. The toast lane moved with them, from just above
// the dock to just above the fan, and steps up again while a card is raised.
// ═══════════════════════════════════════════════════════════════════════════
import {CARDS, CATEGORY_LABEL, hand, playCard, activeIndex} from "./cards.js";
import {BASE} from "../game/data.js";
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
  widthMax:470,    // px the whole fan may span; a big hand tightens its overlap instead
  tiltPerCard:4.4, // degrees added to the spread per extra card
  tiltMax:13,      // degrees from the centre card to an outermost one
  // px the outermost card sits below the centre one. Kept shallow on purpose: the dip and the
  // tilt both push an outer card's bottom corner down, and #handCards' own 32px offset from
  // the stage edge is sized against the pair of them so a charge pip is never cropped.
  arc:14,
  lift:52,         // px a hovered or focused card rises
  scale:1.6,       // how far it grows — enough that the effect text reads at a glance
  part:20,         // px the neighbours step aside to let it through
  activeLift:40,   // px the card currently running a placement holds itself up
  activeScale:1.1, // and how far it grows while it does — a lift, not a takeover
};
const MAX_KEY = 9;

let root=null,list=null,flights=null,hint=null;
let focus=-1;        // keyboard browse cursor
let hover=-1;        // pointer hover
let reduced=false;

// ── the card face ───────────────────────────────────────────────────────────
// One anatomy, two sizes. Everything inside is em-based off the card's own font-size, which
// styles.css derives from --cw, so a 104px hand card and a 236px draft pick are the same
// drawing at two scales rather than two drawings. Category eyebrow, glyph, name, rule,
// effect text, notes line, then the footer that carries charge pips and the count badge.
export function cardFace(id,{key=null,count=1,charges=null}={}){
  const def=CARDS[id];
  const el=document.createElement("article");
  el.className="card r-"+def.rarity+" c-"+def.category;
  el.dataset.id=id;
  const add=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;el.appendChild(node);return node;};
  if(key!==null){const k=document.createElement("kbd");k.className="card-key";k.textContent=key;el.appendChild(k);}
  add("header","card-eyebrow",CATEGORY_LABEL[def.category]);
  add("div","card-glyph",def.glyph);
  add("h4","card-name",def.name);
  add("div","card-rule");
  add("p","card-text",def.text);
  add("p","card-note",def.notes);
  const foot=add("footer","card-foot");
  // Charge pips: the kit's authored total, filled to whatever is left. A card with no charge
  // track draws no pips at all, so the row only ever appears on something that can be spent
  // in pieces. `charges` is null while every copy is untouched — that reads as a full kit.
  if(def.charges){
    const left=charges===null?def.charges:charges;
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
function placeCards(){
  const cards=[...list.children],n=cards.length;
  if(!n)return;
  // The fan is fitted to #handDock's measured box, minus the room a hovered card needs to grow
  // sideways — that box is what styles.css keeps clear of the build dock and the hint corner,
  // so the whole no-collision guarantee comes from one measurement rather than two constants
  // that could drift apart.
  const cardW=cards[0].offsetWidth;
  const span=Math.max(0,Math.min(FAN.widthMax,root.clientWidth-cardW*FAN.scale));
  const step=n<2?0:Math.min(cardW*FAN.step,span/(n-1));
  const tilt=Math.min(FAN.tiltPerCard*(n-1),FAN.tiltMax);
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
  // A raised card is tall enough to reach the notification lane, so the lane steps up out of
  // its way. #toast already transitions `bottom`, so this costs one class and no new motion.
  document.getElementById("game").classList.toggle("hand-raised",raised>=0);
}

let arrivalId=null;   // an id the next repaint must hold back for a flight
export function renderHand(){
  if(!list)return;
  const cards=hand(),active=activeIndex();
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
  root.classList.toggle("targeting",active>=0);
  if(hint)hint.hidden=cards.length===0;
  placeCards();
}

// ── playing ─────────────────────────────────────────────────────────────────
// The card's own rectangle is measured BEFORE the play, because "applied" repaints the hand
// out from under it — the flight is a clone of a card that no longer exists.
function play(index){
  const el=list.children[index];
  if(!el)return;
  const before=cardBox(el,Number(el.style.getPropertyValue("--scale"))||1),id=el.dataset.id;
  const result=playCard(index);
  // "applied" already repainted the hand through handChanged, but it did so while this card was
  // still the raised one — drop the cursor and re-place, or the fan settles around a gap.
  if(result==="applied"){hover=-1;focus=-1;placeCards();consumeFlight(id,before);}
  else if(result==="targeting"){hover=-1;focus=index;placeCards();}
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
/** A spent consumable flies to the thing it feeds — the base — and burns off over it. */
function consumeFlight(id,from){
  const ghost=ghostAt(id,from),to=basePoint();
  const dx=to.cx-from.cx,dy=to.cy-from.cy;
  const frames=reduced?[{opacity:1},{opacity:0}]:[
    {transform:"translate(0,0) rotate(0deg) scale(1)",opacity:1,filter:"brightness(1)"},
    {transform:"translate("+(dx*.45).toFixed(0)+"px,"+(dy*.4-70).toFixed(0)+"px) rotate(-9deg) scale(1.16)",opacity:1,offset:.42,filter:"brightness(1.4)"},
    {transform:"translate("+dx.toFixed(0)+"px,"+dy.toFixed(0)+"px) rotate(14deg) scale(.16)",opacity:0,filter:"brightness(2.4)"}];
  const run=ghost.animate(frames,{duration:reduced?180:560,easing:reduced?"linear":"cubic-bezier(.5,0,.75,.4)"});
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

// ── keyboard ────────────────────────────────────────────────────────────────
// 1-9 play the card at that position outright (the number is printed on the card).
// Q and E walk a browse cursor along the fan, which raises exactly what hover raises;
// enter or space plays whatever it is on; escape drops the cursor. Registered ahead of
// src/input.js so escape can clear the cursor before the pause chain sees it, and every
// branch bails while a modal owns the screen or a digit is shifted (shift+digit is the
// view debugger's tab shortcut).
function onKeyDown(event){
  if(event.repeat||event.ctrlKey||event.metaKey||event.altKey)return;
  if(document.getElementById("game").classList.contains("modal-open"))return;
  const n=list.children.length;
  if(!n)return;
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
}
