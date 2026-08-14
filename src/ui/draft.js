// Owns: the pick-3 overlay — the level-up draft and the end-of-night dawn payout.
// ═══════════════════════════════════════════════════════════════════════════
// DRAFT ADAPTER
//
// One overlay, two headings. draftKind() decides which: "level" is the tier crossing and may
// offer a boon that fires on the spot, "dawn" is the night's payout and offers consumables and
// blueprints only, every one of which ends up in the hand.
//
// Ownership / data flow
//   Reads:    src/ui/cards.js — draftPending(), draftKind(), levelState(). Never the model's
//             internals; the overlay is a projection of those three calls and nothing else.
//   Writes:   the DOM under #draftOverlay. The one gameplay change it can make is chooseDraft().
//   Supplies: DRAFT_EFFECTS (the draftChanged / levelChanged sinks main.js hands to the model)
//             and initDraft() (registration).
//
// The pick that lands in the hand is not simply deleted from the screen: the chosen card is
// handed to src/ui/hand.js, which flies a clone of it into the empty slot the model just made.
// That is why the overlay holds its scrim through the flight instead of closing on the click —
// see the `resolving` state below.
// ═══════════════════════════════════════════════════════════════════════════
import {CARDS, draftPending, draftKind, chooseDraft, levelState} from "./cards.js";
import {cardFace, cardBox, expectArrival, playArrival} from "./hand.js";
import {syncModalUi} from "./hud.js";

const TITLE = {level:"level up",dawn:"dawn spoils — the night paid out"};
const DESTINATION = {consumable:"→ into your hand",blueprint:"→ into your hand",boon:"→ spent the moment you take it"};

let overlay=null,titleEl=null,subEl=null,picks=null;
let cursor=0;
let resolving=false;   // a pick is mid-flight; hold the overlay open under it
let reduced=false;

// ── the subtitle ────────────────────────────────────────────────────────────
// Each kind explains itself with its own numbers rather than a shared "pick one".
function subtitle(kind){
  const level=levelState();
  if(kind==="dawn")return "the village held. take one thing off the wagon.";
  return "tier "+level.tier+" · "+(level.points===1?"1 skill point banked":level.points+" skill points banked")+
    (level.next?" · next at "+level.next+" xp":" · top tier")+".";
}

export function render(){
  if(!overlay||resolving)return;
  const offers=draftPending(),kind=draftKind();
  if(!offers||!kind){
    if(!overlay.hidden){overlay.hidden=true;syncModalUi();}
    picks.replaceChildren();
    return;
  }
  overlay.dataset.kind=kind;
  titleEl.textContent=TITLE[kind]||TITLE.level;
  subEl.textContent=subtitle(kind);
  cursor=0;
  picks.replaceChildren();
  offers.forEach((id,i)=>{
    const def=CARDS[id];
    const slot=document.createElement("div");
    slot.className="pick";
    slot.dataset.index=String(i);
    slot.appendChild(cardFace(id,{key:String(i+1)}));
    const tag=document.createElement("p");
    tag.className="pick-dest";tag.textContent=DESTINATION[def.category];
    slot.appendChild(tag);
    slot.style.setProperty("--deal",(i*70)+"ms");
    slot.addEventListener("pointerenter",()=>{cursor=i;paintCursor();});
    slot.addEventListener("click",()=>choose(i));
    picks.appendChild(slot);
  });
  paintCursor();
  if(overlay.hidden){overlay.hidden=false;syncModalUi();}
}
function paintCursor(){ [...picks.children].forEach((el,i)=>el.classList.toggle("on",i===cursor)); }

// ── taking a pick ───────────────────────────────────────────────────────────
// Measure first, then move the model, then fly. chooseDraft() adds the card to the hand
// synchronously, so by the time playArrival() runs the empty slot it is aiming at already
// exists — it is held invisible by expectArrival() until the clone gets there.
function choose(index){
  if(resolving)return;
  const offers=draftPending();
  if(!offers)return;
  const id=offers[index],def=CARDS[id],slot=picks.children[index];
  if(!def||!slot)return;
  resolving=true;
  const from=cardBox(slot.querySelector(".card"));
  [...picks.children].forEach((el,i)=>el.classList.add(i===index?"chosen":"rejected"));
  overlay.classList.add("resolving");
  const toHand=def.category!=="boon";
  if(toHand)expectArrival(id);
  chooseDraft(index);
  const flight=toHand?playArrival(from):new Promise(done=>setTimeout(done,reduced?140:430));
  flight.then(()=>{
    resolving=false;
    overlay.classList.remove("resolving");
    render();
  });
}

// ── keyboard ────────────────────────────────────────────────────────────────
// 1/2/3 take a pick outright; the arrows walk the cursor and enter or space takes what it is
// on. Registered ahead of src/input.js and swallowing every press while the overlay is up, so
// the camera keys and the pause chain never run underneath a modal that covers the whole stage.
function onKeyDown(event){
  if(overlay.hidden||resolving)return;
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  event.stopImmediatePropagation();
  if(event.repeat)return;
  const n=picks.children.length;
  const digit=/^Digit([1-3])$/.exec(event.code);
  if(digit&&!event.shiftKey){event.preventDefault();const i=Number(digit[1])-1;if(i<n){cursor=i;paintCursor();choose(i);}return;}
  if(event.code==="ArrowLeft"||event.code==="ArrowRight"){event.preventDefault();cursor=(cursor+(event.code==="ArrowLeft"?n-1:1))%n;paintCursor();return;}
  if(event.code==="Enter"||event.code==="Space"){event.preventDefault();choose(cursor);}
}

// ── effect sinks ────────────────────────────────────────────────────────────
// main.js merges these into the record it hands the card model, beside the hand's own sink.
export const DRAFT_EFFECTS = {
  draftChanged(){render();},
  levelChanged(){},   // the tier readout is re-read by render(); nothing else reacts to a level
};

export function initDraft(){
  overlay=document.getElementById("draftOverlay");
  titleEl=document.getElementById("draftTitle");
  subEl=document.getElementById("draftSub");
  picks=document.getElementById("draftPicks");
  const motion=window.matchMedia("(prefers-reduced-motion:reduce)");
  reduced=motion.matches;
  motion.addEventListener?.("change",event=>{reduced=event.matches;});
  window.addEventListener("keydown",onKeyDown);
  render();
}
