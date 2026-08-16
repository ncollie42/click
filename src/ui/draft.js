// Owns the level bar in the xp HUD and the pick-3 overlay — the level-up draft and the
// end-of-night dawn payout. Owns no gameplay state.
// ═══════════════════════════════════════════════════════════════════════════
// DRAFT ADAPTER
//
// One overlay, two reward loops. draftKind() decides which: "level" deals permanent buffs that
// apply immediately; "dawn" pays out consumables and blueprints that enter the hand. The simulation
// owns those disjoint pools; this adapter only titles and presents the resulting offer.
//
// Ownership / data flow
//   Reads:    src/game/simulation.js — draftPending(), draftKind(), chooseDraft(), levelState().
//             Never the simulation's internals; the overlay is a projection of those four calls.
//             src/game/cards.js for the one display field it needs itself (a pick's category, which
//             decides where the card is going); the face is drawn by src/ui/hand.js.
//   Writes:   the DOM under #draftOverlay and #xpHud. The one gameplay change it can make is
//             chooseDraft().
//   Supplies: DRAFT_EFFECTS (the draftChanged / levelChanged sinks main.js hands the simulation),
//             syncLevelHud() (the sync pass boot re-runs) and initDraft() (registration).
//
// The pick that lands in the hand is not simply deleted from the screen: the chosen card is
// handed to src/ui/hand.js, which flies a clone of it into the empty slot the simulation just
// made. That is why the overlay holds its scrim through the flight instead of closing on the
// click — see the `resolving` state below. The world is frozen behind a pending offer, so those
// extra frames cost the run nothing.
// ═══════════════════════════════════════════════════════════════════════════
import {cardById} from "../game/cards.js";
import {draftPending, draftKind, chooseDraft, levelState} from "../game/simulation.js";
import {cardFace, cardBox, expectArrival, playArrival} from "./hand.js";
import {syncModalUi} from "./hud.js";

const TITLE = {level:"level up",dawn:"dawn spoils — the night paid out"};
const goesToHand = category => category!=="buff";

let surface=null;      // <canvas id="overlay"> — the focus target of last resort
let overlay=null,titleEl=null,subEl=null,picks=null;
let cursor=0;
let resolving=false;   // a pick is mid-flight; hold the overlay open under it
let reduced=false;
let returnFocus=null;
let shownLevel=null;   // pulse only on a CHANGE, so boot and resyncs stay quiet

const focusable=element=>!!element&&element.isConnected&&!element.disabled&&element.getClientRects().length>0;

// ── the level bar ───────────────────────────────────────────────────────────
/** Repaint the run's one progress bar — the level, and how far into it. */
export function syncLevelHud(){
  const level=levelState();
  if(!level)return;
  const capped=!(level.next>0),bar=document.getElementById("levelBar");
  const progress=capped?1:Math.max(0,Math.min(1,level.xp/level.next));
  document.getElementById("levelBarFill").style.width=(100*progress).toFixed(2)+"%";
  document.getElementById("levelBarLabel").textContent="lv "+level.level;
  // The level curve is geometric, so both numbers arrive fractional (the carry into a new level is
  // whatever the last cost left over). The bar rounds only what it PRINTS and leaves the fill on the
  // raw pair, so the text can never claim progress the fill has not — and it rounds progress DOWN
  // against a cost rounded UP, so "8 / 8" is never on screen while the bar is still short.
  document.getElementById("levelBarXp").textContent=capped?"max":Math.floor(level.xp)+" / "+Math.ceil(level.next);
  if(level.level===shownLevel)return;
  // Reading offsetWidth between remove and add is the reflow that lets the pulse replay on
  // back-to-back level-ups; without it the class never leaves the element and nothing restarts.
  if(shownLevel!==null){bar.classList.remove("up");void bar.offsetWidth;bar.classList.add("up");}
  shownLevel=level.level;
}

// ── focus containment ───────────────────────────────────────────────────────
// Inert every sibling subtree except game-over while the full-stage screen owns input. Same shape
// as the skill tree's: the two screens are mutually exclusive, so neither ever unsets the other's.
function setFrameInert(on){
  for(let node=overlay;node?.parentElement&&node.id!=="game";node=node.parentElement)
    for(const other of node.parentElement.children)
      if(other!==node&&other.id!=="gameOver")other.toggleAttribute("inert",on);
}

// ── the subtitle ────────────────────────────────────────────────────────────
// Each kind explains itself with its own numbers rather than a shared "pick one".
function subtitle(kind){
  if(kind==="dawn")return "the village held. take one thing off the wagon.";
  const level=levelState();
  return "level "+level.level+(level.next>0?" · next at "+Math.ceil(level.next)+" more xp":" · top level")+".";
}

export function render(){
  if(!overlay||resolving)return;
  const offers=draftPending(),kind=draftKind();
  if(!offers||!kind){closeOverlay();return;}
  overlay.dataset.kind=kind;
  titleEl.textContent=TITLE[kind]||TITLE.level;
  subEl.textContent=subtitle(kind);
  cursor=0;
  picks.replaceChildren();
  offers.forEach((id,i)=>{
    const card=cardById[id];
    const slot=document.createElement("div");
    slot.className="pick";
    slot.dataset.index=String(i);
    slot.appendChild(cardFace(id,{key:String(i+1)}));
    slot.style.setProperty("--deal",(i*70)+"ms");
    slot.addEventListener("pointerenter",()=>{cursor=i;paintCursor();});
    slot.addEventListener("click",()=>choose(i));
    picks.appendChild(slot);
  });
  paintCursor();
  if(overlay.hidden){
    returnFocus=document.activeElement;setFrameInert(true);
    overlay.hidden=false;syncModalUi();
    // Focus the screen, not a card: the cursor state is the same pose hover uses, and putting it
    // on one of them before the player has chosen would break the fan the deal just laid down.
    overlay.focus();
  }
}
function paintCursor(){ [...picks.children].forEach((el,i)=>el.classList.toggle("on",i===cursor)); }

function closeOverlay(){
  picks.replaceChildren();
  if(overlay.hidden)return;
  overlay.hidden=true;setFrameInert(false);syncModalUi();
  // Hiding does not hand focus back for us, and a refused focus() is silent: try the opener, then
  // CHECK, and fall back to the pointer surface main.js handed in rather than strand <body>.
  if(focusable(returnFocus))returnFocus.focus();
  const landed=document.activeElement;
  if(!landed||landed===document.body||overlay.contains(landed))surface?.focus();
  returnFocus=null;
}

// ── taking a pick ───────────────────────────────────────────────────────────
// Measure first, then move the simulation, then fly. chooseDraft() adds the card to the hand
// synchronously, so by the time playArrival() runs the empty slot it is aiming at already
// exists — it is held invisible by expectArrival() until the clone gets there. chooseDraft()
// also deals whatever is queued behind this offer, but its draftChanged() lands while
// `resolving` is up, so the replacement waits for the flight rather than cutting it.
function choose(index){
  if(resolving)return;
  const offers=draftPending();
  if(!offers)return;
  const id=offers[index],card=cardById[id],slot=picks.children[index];
  if(!card||!slot)return;
  resolving=true;
  const from=cardBox(slot.querySelector(".card"));
  [...picks.children].forEach((el,i)=>el.classList.add(i===index?"chosen":"rejected"));
  overlay.classList.add("resolving");
  const toHand=goesToHand(card.category);
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
// on. Registered in the CAPTURE phase, because both other window keydown listeners are ahead of
// this adapter in registration order: src/input.js owns escape and WASD, the view debugger owns
// shift+digit. A pending offer must be taken, so every press is swallowed here while the overlay
// covers the stage — tab is the one key deliberately let through, and the trap below answers it.
function onKeyDownCapture(event){
  if(overlay.hidden||event.key==="Tab")return;
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  event.preventDefault();event.stopPropagation();
  if(event.repeat||resolving)return;
  const n=picks.children.length;
  if(!n)return;
  const digit=/^Digit([1-3])$/.exec(event.code);
  if(digit&&!event.shiftKey){const i=Number(digit[1])-1;if(i<n){cursor=i;paintCursor();choose(i);}return;}
  if(event.code==="ArrowLeft"||event.code==="ArrowRight"){cursor=(cursor+(event.code==="ArrowLeft"?n-1:1))%n;paintCursor();return;}
  if(event.code==="Enter"||event.code==="Space")choose(cursor);
}
// The overlay is the only stop inside it, so tab simply comes back to it rather than walking the
// document behind the scrim.
function onOverlayKeydown(event){ if(event.key==="Tab"){event.preventDefault();overlay.focus();} }

// ── effect sinks ────────────────────────────────────────────────────────────
// main.js merges these into the record it hands the simulation's connect(), beside the hand's own.
export const DRAFT_EFFECTS = {
  draftChanged(){render();},
  levelChanged(){syncLevelHud();},
};

export function initDraft(pointerSurface){
  surface=pointerSurface;
  overlay=document.getElementById("draftOverlay");
  titleEl=document.getElementById("draftTitle");
  subEl=document.getElementById("draftSub");
  picks=document.getElementById("draftPicks");
  const motion=window.matchMedia("(prefers-reduced-motion:reduce)");
  reduced=motion.matches;
  motion.addEventListener?.("change",event=>{reduced=event.matches;});
  overlay.addEventListener("keydown",onOverlayKeydown);
  // A press on the scrim has no focusable ancestor but the overlay: focus it there rather than
  // let focus fall to <body>, from where shift+tab walks the document backwards.
  overlay.addEventListener("pointerdown",event=>{if(!event.target.closest(".pick"))overlay.focus();});
  window.addEventListener("keydown",onKeyDownCapture,true);
  syncLevelHud();
  render();
}
