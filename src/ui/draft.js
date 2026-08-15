// Owns the level bar in the xp HUD and the pick-3 draft screen: their DOM, focus containment, the
// inert frame state and the key capture that runs while the screen is up. Owns no gameplay state.
// ═══════════════════════════════════════════════════════════════════════════
// DRAFT ADAPTER
// Ownership / data flow
//   Reads:    the level/draft SOURCE record main.js hands in — three functions, levelState(),
//             draftPending() and chooseDraft(index). That record is the simulation namespace in a
//             real run and the dev-only ?draftDemo stand-in otherwise; this file cannot tell them
//             apart and must not. src/game/cards.js and the two authored icon tables in
//             src/game/data.js are read for display fields only.
//   Writes:   the DOM only. The one way out of this file into the world is SOURCE.chooseDraft().
//   Supplies: DRAFT_EFFECTS — levelChanged/draftChanged, merged into the simulation's connect()
//                             record by main.js. Pure sinks, same contract as the HUD's.
//             initDraft()   — registration, called once by main.js.
//             syncLevelHud()— the sync pass boot re-runs.
// Every selector this file writes lives under #xpHud or #draftPanel, so it reaches no other panel.
// ═══════════════════════════════════════════════════════════════════════════
import {cardById} from "../game/cards.js";
import {UPGRADES, TOWER_VARIANTS} from "../game/data.js";

const panel=()=>document.getElementById("draftPanel");
const focusable=element=>!!element&&element.isConnected&&!element.disabled&&element.getClientRects().length>0;
const stillMotion=()=>window.matchMedia("(prefers-reduced-motion:reduce)").matches;

let surface=null;                    // <canvas id="overlay"> — the focus target of last resort
let SOURCE=null;                     // the level/draft record; see the header
let returnFocus=null;
let shownLevel=null;                 // pulse only on a CHANGE, so boot and resyncs stay quiet
let shownOffer="";                   // rendered card ids, joined — a re-deal must be a real re-deal
let resolving=false;                 // a pick is playing out; the screen takes no further input

// Inert every sibling subtree except game-over while the full-stage screen owns input. Same shape
// as the skill tree's: the two screens are mutually exclusive, so neither ever unsets the other's.
function setFrameInert(on){
  for(let node=panel();node?.parentElement&&node.id!=="game";node=node.parentElement)
    for(const other of node.parentElement.children)
      if(other!==node&&other.id!=="gameOver")other.toggleAttribute("inert",on);
}

// ── the level bar ───────────────────────────────────────────────────────────
/** Repaint the run's one progress bar. A source without levelState() leaves it exactly as authored,
 *  which is what keeps this adapter loadable before the simulation half of the contract lands. */
export function syncLevelHud(){
  const level=SOURCE?.levelState?.();
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

// ── card face ───────────────────────────────────────────────────────────────
// Card ids are camelCase and the whole UI is lowercase, so the id is split at its humps rather than
// flattened into one word: chopYield -> "chop yield". Nothing else renames a card.
const cardName=id=>id.replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase();

// The art window's glyph. A card's `ref` already names what it unlocks, so towers and upgrades read
// their authored icon straight out of data.js and stay in step with it for free. The rest of the
// refs point at things that own no icon (buildings) or at nothing built yet (concepts), so those are
// presentation-only picks made HERE, drawn from the same glyph vocabulary the authored tables use.
const REF_GLYPHS={
  "concept:clickCombat":"✊","concept:chopTime":"↻","concept:chopYield":"⛏","concept:crit":"⌖","concept:chainLightning":"ϟ",
  "concept:loadedDrop":"▣","concept:enemySlam":"↓",
  "concept:workerSpeed":"»","concept:workerCarry":"▣","concept:houseSlots":"⌂","concept:workerHp":"♥",
  "concept:dawnHeal":"☀","concept:towerDamage":"●","concept:towerSpeed":"↯","concept:towerRange":"◎",
  "concept:dawnRepair":"▦","concept:baseHp":"⌂","concept:retaliation":"↩","concept:nightGather":"☾","concept:feedXp":"◉",
  "concept:fireball":"♨","concept:treants":"♣","concept:healBase":"♥","concept:repairTowers":"▦","concept:rushBuild":"↯",
  "concept:bundle":"▣","concept:tempWorker":"☝","concept:calmNight":"☾","concept:longDay":"☀",
  "concept:draftMeta":"↻","concept:barracks":"⚔","concept:mendingBeacon":"♥","concept:towerStandard":"✦",
  "concept:warDrum":"⚔","concept:frostTotem":"❄","concept:luckyTotem":"◆","concept:wildFoundation":"♣",
  "concept:dustSiphon":"⌁","concept:coinPress":"◎","concept:diamondDrill":"◈",
  "building:blast":"●","building:spikes":"▲","building:landmine":"◉","building:tar":"≋","building:obelisk":"▰",
};
const CATEGORY_GLYPHS={buff:"✦",consumable:"◈",aura:"◎",blueprint:"⌂"};
function cardGlyph(card){
  const [kind,name]=String(card.ref||"").split(":");
  const authored=kind==="tower"?TOWER_VARIANTS[name]?.icon
    :kind==="upgrade"?UPGRADES.find(upgrade=>upgrade.id===name)?.icon
    :REF_GLYPHS[card.ref];
  return authored||CATEGORY_GLYPHS[card.category]||"✦";
}

// The fan: three cards dealt from the middle of the stage, resting rotated and on a shallow arc with
// the centre card highest. Both the rest pose and the throw origin are authored as custom properties
// so the keyframes below stay one rule for all three — CSS cannot derive per-index geometry itself.
const FAN=[{rot:"-5deg",lift:"11px"},{rot:"0deg",lift:"0px"},{rot:"5deg",lift:"11px"}];

function renderOffer(ids){
  const cards=ids.map((id,index)=>{
    const card=cardById[id]||{category:"card",rarity:"common",text:"",ref:""};
    const pose=FAN[index]||FAN[1];
    const tile=document.createElement("button");
    tile.type="button";tile.className="draft-card";tile.dataset.index=index;tile.dataset.rarity=card.rarity;
    tile.style.setProperty("--rot",pose.rot);
    tile.style.setProperty("--lift",pose.lift);
    tile.style.setProperty("--dx","calc("+(1-index)+" * var(--step))");
    tile.style.animationDelay=(index*80)+"ms";
    tile.setAttribute("aria-label",[card.category,cardName(id),card.rarity,card.text].join(" · ")+" · press "+(index+1));
    const part=(cls,text,parent)=>{
      const node=document.createElement("span");node.className=cls;
      if(text)node.textContent=text;
      node.setAttribute("aria-hidden","true");                 // the aria-label above reads the card
      (parent||tile).appendChild(node);return node;
    };
    part("draft-key",String(index+1));
    part("draft-banner",cardName(id));
    part("draft-eyebrow",card.category);
    part("draft-glyph",cardGlyph(card),part("draft-art"));
    part("draft-text",card.text);
    // Pips are the stack ceiling, one dot per stack — buffs only; everything else keeps the row's
    // height so the three text panels stay on one line across the fan.
    const pips=part("draft-pips");
    for(let i=0;i<(card.stacks>1?card.stacks:0);i++)pips.appendChild(document.createElement("i"));
    return tile;
  });
  document.getElementById("draftCards").replaceChildren(...cards);
  shownOffer=ids.join("|");
}

// ── the draft screen ────────────────────────────────────────────────────────
/** The one entry point: read the pending offer and make the screen agree with it. Idempotent — an
 *  offer already on screen is not re-dealt, so chooseDraft()'s own draftChanged() and the re-check
 *  that follows its truthy return collapse into a single deal. */
function syncDraft(){
  const ids=SOURCE?.draftPending?.();
  if(!ids?.length){closeDraft();return;}
  const signature=ids.join("|");
  if(!panel().hidden&&signature===shownOffer)return;
  if(panel().hidden){returnFocus=document.activeElement;setFrameInert(true);}
  renderOffer(ids);                                            // repaint before unhiding
  panel().hidden=false;
  // Focus the screen, not a card: the cards' focus pose is the same pop-out as hover, and putting it
  // on one of them before the player has chosen would break the fan the deal just laid down.
  panel().focus();
}

function closeDraft(){
  if(panel().hidden)return;
  panel().hidden=true;setFrameInert(false);shownOffer="";
  // Hiding does not hand focus back for us, and a refused focus() is silent: try the opener, then
  // CHECK, and fall back to the pointer surface main.js handed in rather than strand <body>.
  if(focusable(returnFocus))returnFocus.focus();
  const landed=document.activeElement;
  if(!landed||landed===document.body||panel().contains(landed))surface.focus();
  returnFocus=null;
}

const PICK_MS=380;
/** Play the pick, THEN commit it. The simulation is frozen behind a pending offer, so the extra
 *  frames cost the run nothing, and committing last keeps one order for both outcomes: a replacement
 *  offer deals in over the cards that just left, a last offer closes the screen. */
function choose(index){
  if(panel().hidden||resolving)return;
  const tiles=[...document.querySelectorAll("#draftCards .draft-card")];
  if(!tiles[index])return;
  resolving=true;
  tiles.forEach((tile,at)=>tile.classList.add(at===index?"chosen":"discarded"));
  const commit=()=>{resolving=false;if(SOURCE.chooseDraft(index))syncDraft();};
  if(stillMotion())commit();else setTimeout(commit,PICK_MS);
}

// ── keys ────────────────────────────────────────────────────────────────────
// Registered in the CAPTURE phase because both other window keydown listeners are ahead of this
// adapter in registration order: input.js owns Escape and WASD, the view debugger owns shift+digit.
// A pending draft must be taken, so Escape is swallowed here and reaches neither. Tab is the one
// key deliberately let through — the trap below is what answers it.
const CLAIMED=new Set(["Escape","KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","KeyK"]);
function onKeyDownCapture(event){
  if(panel().hidden)return;
  if(!CLAIMED.has(event.code)&&!event.code.startsWith("Digit"))return;
  event.preventDefault();event.stopPropagation();
  const pick="123".indexOf(event.key);
  if(pick>=0&&!event.repeat&&!event.shiftKey)choose(pick);
}
// The cards are the only stops inside; this closes Tab traversal around them.
function onPanelKeydown(event){
  if(event.key!=="Tab")return;
  const stops=panel().querySelectorAll("button"),first=stops[0],last=stops[stops.length-1],at=document.activeElement;
  if(!first||(at!==panel()&&at!==(event.shiftKey?first:last)))return;
  event.preventDefault();(event.shiftKey?last:first).focus();
}

// ── effect implementations handed to the simulation ─────────────────────────
export const DRAFT_EFFECTS = {
  levelChanged(){syncLevelHud();},
  draftChanged(){syncDraft();},
};

// ── registration ────────────────────────────────────────────────────────────
export function initDraft(pointerSurface, source){
  surface=pointerSurface;SOURCE=source;
  document.getElementById("draftCards").addEventListener("click",event=>{
    const tile=event.target.closest(".draft-card");
    if(tile)choose(Number(tile.dataset.index));
  });
  panel().addEventListener("keydown",onPanelKeydown);
  // A press on the screen's own background has no focusable ancestor but the panel: focus it there
  // rather than let focus fall to <body>, from where shift+Tab walks the document backwards.
  panel().addEventListener("pointerdown",event=>{if(!event.target.closest("button"))panel().focus();});
  window.addEventListener("keydown",onKeyDownCapture,true);
  syncLevelHud();
}
