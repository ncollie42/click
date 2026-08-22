// Owns the base-progress bar in the top HUD and the pick-3 overlay — the main-base level payout,
// the end-of-night dawn payout and chest/forge consumables. Owns no gameplay state.
// ═══════════════════════════════════════════════════════════════════════════
// DRAFT ADAPTER
//
// One overlay, three reward kinds. "base" deals the mixed build+buff pick a completed authored
// main-base level earns; "dawn" applies the wave-clear permanent buff; "consumable" deals a chest
// or Consumable Forge reward into the hand. The simulation owns those pools; this adapter only
// presents the offer. (The XP "level" draft was deleted Aug 22 along with the XP track itself.)
//
// Ownership / data flow
//   Reads:    src/game/simulation.js — draftPending(), draftKind(), chooseDraft() and
//             mainBaseStatus() (both the top bar and the base reward's subtitle).
//             Never the simulation's internals; the overlay is a projection of those calls alone.
//             src/game/cards.js for the one display field it needs itself (a pick's category, which
//             decides where the card is going); the face is drawn by src/ui/hand.js.
//   Writes:   the DOM under #draftOverlay and #baseHud. The one gameplay change it can make is
//             chooseDraft().
//   Supplies: DRAFT_EFFECTS (the draftChanged / baseLevelChanged sinks main.js hands the
//             simulation), syncBaseHud() (the sync pass boot re-runs) and initDraft().
//
// The pick that lands in the hand is not simply deleted from the screen: the chosen card is
// handed to src/ui/hand.js, which flies a clone of it into the empty slot the simulation just
// made. That is why the overlay holds its scrim through the flight instead of closing on the
// click — see the `resolving` state below. The world is frozen behind a pending offer, so those
// extra frames cost the run nothing.
// ═══════════════════════════════════════════════════════════════════════════
import {cardById} from "../game/cards.js";
import {draftPending, draftKind, chooseDraft, rerollDraft, rerollState, mainBaseStatus} from "../game/simulation.js";
import {cardFace, cardBox, expectArrival, playArrival} from "./hand.js";
import {syncModalUi} from "./hud.js";

// "base" and "dawn" deal the same permanent-buff pool; only the copy tells them apart, so the
// player always knows which thing they did earned the pick.
const TITLE = {base:"the main base rises",dawn:"choose a permanent upgrade",consumable:"choose a consumable"};
const goesToHand = category => category!=="buff";

let surface=null;      // <canvas id="overlay"> — the focus target of last resort
let overlay=null,titleEl=null,subEl=null,picks=null,rerollBtn=null;
let cursor=0;
let resolving=false;   // a pick is mid-flight; hold the overlay open under it
let reduced=false;
let returnFocus=null;
let shownLevel=null;   // pulse only on a CHANGE, so boot and resyncs stay quiet

const focusable=element=>!!element&&element.isConnected&&!element.disabled&&element.getClientRects().length>0;

// ── the base bar ────────────────────────────────────────────────────────────
/**
 * Repaint the run's one progress bar. Since XP was deleted (Aug 22) the number it counts is the
 * MAIN BASE's authored level: the label is the level standing out of the authored maximum, the fill
 * is how much of the next recipe has been delivered (in units, all kinds pooled — the bar is a
 * feel, the exact per-kind need is printed beside it and drawn in full over the base itself by
 * src/render/overlay.js), and the right-hand text is what the next level still wants.
 */
export function syncBaseHud(){
  const base=mainBaseStatus();
  if(!base)return;
  const bar=document.getElementById("baseBar");
  let wanted=0,paid=0,need="";
  if(base.cost){
    const parts=[];
    for(const kind of Object.keys(base.cost)){
      const cost=base.cost[kind]||0,delivered=Math.min(cost,base.delivered[kind]||0);
      wanted+=cost;paid+=delivered;
      if(delivered<cost)parts.push((cost-delivered)+" "+kind);
    }
    need=parts.join(" + ");
  }
  const progress=base.atMaxLevel?1:(wanted?paid/wanted:0);
  document.getElementById("baseBarFill").style.width=(100*progress).toFixed(2)+"%";
  document.getElementById("baseBarLabel").textContent="base lv "+base.level+"/"+base.maxLevel;
  const needEl=document.getElementById("baseBarNeed"),needText=base.atMaxLevel?"max":need||"ready";
  // A tick on every printed change, but not while the whole bar is replaying its level-up pulse —
  // one piece of feedback at a time. Same remove/reflow/add replay trick as the pulse below.
  if(needEl.textContent!==needText){
    needEl.textContent=needText;
    if(base.level===shownLevel){needEl.classList.remove("tick");void needEl.offsetWidth;needEl.classList.add("tick");}
  }
  if(base.level===shownLevel)return;
  // Reading offsetWidth between remove and add is the reflow that lets the pulse replay on
  // back-to-back levels; without it the class never leaves the element and nothing restarts.
  if(shownLevel!==null){bar.classList.remove("up");void bar.offsetWidth;bar.classList.add("up");}
  shownLevel=base.level;
}

// ── focus containment ───────────────────────────────────────────────────────
// Inert every sibling subtree except game-over while this full-stage screen owns input.
function setFrameInert(on){
  for(let node=overlay;node?.parentElement&&node.id!=="game";node=node.parentElement)
    for(const other of node.parentElement.children)
      if(other!==node&&other.id!=="gameOver")other.toggleAttribute("inert",on);
}

// ── the subtitle ────────────────────────────────────────────────────────────
// Each kind explains itself with its own numbers rather than a shared "pick one".
function subtitle(kind){
  if(kind==="base"){
    const base=mainBaseStatus();
    return "the main base stands at level "+base.level+" of "+base.maxLevel+". choose one build or upgrade.";
  }
  if(kind==="dawn")return "the village held. choose one permanent upgrade.";
  return "choose one card to keep until played.";
}

export function render(){
  if(!overlay||resolving)return;
  const offers=draftPending(),kind=draftKind();
  if(!offers||!kind){closeOverlay();return;}
  overlay.dataset.kind=kind;
  titleEl.textContent=TITLE[kind]||TITLE.base;
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
  // The reroll footer: pay coins, redraw the offer. rerollDraft()'s draftChanged lands back here,
  // so a successful press repaints the picks (and this button) through the ordinary render.
  const reroll=rerollState();
  rerollBtn.textContent="r · reroll for "+reroll.cost+" ◉ — "+reroll.coins+" held";
  rerollBtn.disabled=reroll.coins<reroll.cost;
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
  if(event.code==="KeyR"){tryReroll();return;}
  if(event.code==="ArrowLeft"||event.code==="ArrowRight"){cursor=(cursor+(event.code==="ArrowLeft"?n-1:1))%n;paintCursor();return;}
  if(event.code==="Enter"||event.code==="Space")choose(cursor);
}
// The overlay is the only stop inside it, so tab simply comes back to it rather than walking the
// document behind the scrim.
function onOverlayKeydown(event){ if(event.key==="Tab"){event.preventDefault();overlay.focus();} }

function tryReroll(){ if(!resolving)rerollDraft(); }

// ── effect sinks ────────────────────────────────────────────────────────────
// main.js merges these into the record it hands the simulation's connect(), beside the hand's own.
export const DRAFT_EFFECTS = {
  draftChanged(){render();},
  baseLevelChanged(){syncBaseHud();},
};

export function initDraft(pointerSurface){
  surface=pointerSurface;
  overlay=document.getElementById("draftOverlay");
  titleEl=document.getElementById("draftTitle");
  subEl=document.getElementById("draftSub");
  picks=document.getElementById("draftPicks");
  rerollBtn=document.getElementById("draftReroll");
  rerollBtn.addEventListener("click",tryReroll);
  const motion=window.matchMedia("(prefers-reduced-motion:reduce)");
  reduced=motion.matches;
  motion.addEventListener?.("change",event=>{reduced=event.matches;});
  overlay.addEventListener("keydown",onOverlayKeydown);
  // A press on the scrim has no focusable ancestor but the overlay: focus it there rather than
  // let focus fall to <body>, from where shift+tab walks the document backwards.
  overlay.addEventListener("pointerdown",event=>{if(!event.target.closest(".pick"))overlay.focus();});
  window.addEventListener("keydown",onKeyDownCapture,true);
  syncBaseHud();
  render();
}
