// Owns: the card catalog (display data) and the hand/draft model behind it.
// ═══════════════════════════════════════════════════════════════════════════
// CARD MODEL
//
// The brief for this UI names a frozen simulation contract — hand(), playCard(),
// draftKind(), draftPending(), chooseDraft(), levelState(), handChanged() and
// debugDealCard(). src/game/simulation.js in this checkout predates that contract and
// exports none of it (there is no src/game/cards.js either), and src/game/* is
// read-only here. So this module IMPLEMENTS that exact contract on top of the
// commands the simulation does export, and binds to the real thing the moment the
// simulation grows it: every export below prefers `sim.<name>` when it exists and
// falls back to the local model otherwise. Nothing in src/ui/ knows which half it
// is talking to.
//
// Ownership / data flow
//   Reads:    src/game/simulation.js queries. READ-ONLY: this file never assigns into
//             `state`, exactly like src/ui/hud.js.
//   Writes:   its own hand/draft records, and the world only through simulation
//             COMMANDS (toggleBuildMode, cancelBuildMode, toast, the debug grants).
//   Supplies: the contract listed above, plus tickCards(), which main.js calls once
//             per frame so the model can watch for the two things the simulation
//             raises no effect for: a placement landing, and a level / dawn arriving.
// ═══════════════════════════════════════════════════════════════════════════
import * as sim from "../game/simulation.js";

// ── the catalog ─────────────────────────────────────────────────────────────
// Display data first (the fields the brief names: id, category, rarity, text, notes,
// charges), then the one behavioural field each kind needs — `build` for a blueprint
// (which simulation building type its placement flow runs) or `apply` for anything
// instant. Three categories:
//   consumable — instant, one copy spent, goes to the hand
//   blueprint  — enters the simulation's placement flow, spends one charge per drop
//   boon       — level-up only; fires the moment it is drafted and never reaches the hand
const GRANT_TEXT = amount => "+" + amount + " to the stores, hauled in overnight.";
export const CARDS = {
  rations:{id:"rations",name:"warm rations",category:"consumable",rarity:"common",glyph:"✚",
    text:"heal the base, every tower and every worker to full.",
    notes:"eaten on the spot — nothing keeps.",charges:null,
    apply(){sim.debugHealAll();return "the village eats — everything mended";}},
  timberCache:{id:"timberCache",name:"timber cache",category:"consumable",rarity:"common",glyph:"⧉",
    text:"twenty-five wood, straight into the stores.",
    notes:GRANT_TEXT(25),charges:null,
    apply(){sim.debugGrant(["wood"]);return "timber cache broken open — +25 wood";}},
  cutStone:{id:"cutStone",name:"cut stone",category:"consumable",rarity:"common",glyph:"⬢",
    text:"twenty-five stone, already dressed and squared.",
    notes:GRANT_TEXT(25),charges:null,
    apply(){sim.debugGrant(["stone"]);return "cut stone stacked — +25 stone";}},
  coinPurse:{id:"coinPurse",name:"coin purse",category:"consumable",rarity:"uncommon",glyph:"◉",
    text:"twenty-five coin, cut loose from somebody's belt.",
    notes:"no questions asked at dawn.",charges:null,
    apply(){sim.debugGrant(["coin"]);return "coin purse emptied — +25 coin";}},
  dustVial:{id:"dustVial",name:"dust vial",category:"consumable",rarity:"rare",glyph:"✦",
    text:"twenty-five dust — the feed the base likes best.",
    notes:"five xp a grain when fed.",charges:null,
    apply(){sim.debugGrant(["dust"]);return "dust vial uncorked — +25 dust";}},
  harvestFeast:{id:"harvestFeast",name:"harvest feast",category:"consumable",rarity:"uncommon",glyph:"❂",
    text:"feed the base forty experience in one sitting.",
    notes:"runs the real feeding path — the tier reacts.",charges:null,
    apply(){sim.debugGrantXp(40);return "the base is fed — +40 xp";}},

  spikeKit:{id:"spikeKit",name:"spike kit",category:"blueprint",rarity:"common",glyph:"⩚",
    text:"set spike traps on any clear ground.",
    notes:"damages anything that walks across.",charges:3,build:"spikes"},
  tarBarrels:{id:"tarBarrels",name:"tar barrels",category:"blueprint",rarity:"common",glyph:"≈",
    text:"pour tar slicks that slow whatever crosses them.",
    notes:"no damage — only time.",charges:3,build:"tar"},
  mineCrate:{id:"mineCrate",name:"mine crate",category:"blueprint",rarity:"uncommon",glyph:"✸",
    text:"bury land mines that blow once, and hard.",
    notes:"single use, area blast.",charges:2,build:"landmine"},
  watchPlan:{id:"watchPlan",name:"tower plan",category:"blueprint",rarity:"rare",glyph:"⌂",
    text:"stake out one basic tower chassis.",
    notes:"still wants its wood and stone carried over.",charges:1,build:"tower"},
  lumberCharter:{id:"lumberCharter",name:"lumber writ",category:"blueprint",rarity:"uncommon",glyph:"⚒",
    text:"stake out one lumber camp beside the trees.",
    notes:"staff it and it gathers on its own.",charges:1,build:"lumber"},
  quarryWrit:{id:"quarryWrit",name:"quarry writ",category:"blueprint",rarity:"uncommon",glyph:"⧫",
    text:"stake out one quarry over a rock seam.",
    notes:"staff it and it gathers on its own.",charges:1,build:"quarry"},
  obeliskRite:{id:"obeliskRite",name:"obelisk rite",category:"blueprint",rarity:"arcane",glyph:"✧",
    text:"raise one obelisk to hold permanent upgrades.",
    notes:"the only thing that makes a change stick.",charges:1,build:"obelisk"},

  warChest:{id:"warChest",name:"war chest",category:"boon",rarity:"rare",glyph:"⚱",
    text:"fifty wood and fifty stone, delivered before you ask.",
    notes:"spent the moment it is chosen.",charges:null,
    apply(){sim.debugGrant(["wood","stone"]);return "war chest opened — wood and stone in the stores";}},
  scholarsTithe:{id:"scholarsTithe",name:"scholar's tithe",category:"boon",rarity:"rare",glyph:"✤",
    text:"one hundred and twenty experience, fed at once.",
    notes:"a level, near enough.",charges:null,
    apply(){sim.debugGrantXp(120);return "scholar's tithe fed — +120 xp";}},
  kingsFavour:{id:"kingsFavour",name:"king's favour",category:"boon",rarity:"arcane",glyph:"♛",
    text:"twenty-five of every resource the kingdom counts.",
    notes:"spent the moment it is chosen.",charges:null,
    apply(){sim.debugGrant(["wood","stone","dust","coin","diamond"]);return "the king pays — every store filled";}},
};
export const CATEGORY_LABEL = {consumable:"consumable",blueprint:"blueprint",boon:"boon"};

// ── the hand ────────────────────────────────────────────────────────────────
// One record per distinct id, in draw order. `partial` is the charge track: null while
// every copy in the stack is untouched, a number once placements have eaten into the
// top copy. hand() projects that as the contract's `charges`, so a full kit reads null
// and a part-spent one reads what is left.
const HAND = [];       // {id, count, partial}
let ACTIVE = null;     // the blueprint currently running the placement flow
const LISTENERS = {handChanged(){}, draftChanged(){}, levelChanged(){}};
/** Install the UI's sinks. Same shape as the simulation's own connect(). */
export function connectCards(impl){ Object.assign(LISTENERS, impl); }

function localHand(){ return HAND.map(entry=>({id:entry.id,count:entry.count,charges:entry.partial})); }
function stackOf(id){ return HAND.find(entry=>entry.id===id)||null; }
function addToHand(id,copies=1){
  const def=CARDS[id];
  if(!def||def.category==="boon")return false;
  const existing=stackOf(id);
  if(existing)existing.count+=copies; else HAND.push({id,count:copies,partial:null});
  LISTENERS.handChanged();
  return true;
}
/** Spend one whole copy. Clears the stack when the last copy goes. */
function removeCopy(entry){
  entry.count-=1; entry.partial=null;
  if(entry.count<=0){const at=HAND.indexOf(entry);if(at>=0)HAND.splice(at,1);}
}

/** "2 placements left" / "1 placement left" — the one phrasing every charge message uses. */
const chargeText = left => left + " placement" + (left===1?"":"s") + " left";

function localPlayCard(index){
  const entry=HAND[index];
  if(!entry)return false;
  if(sim.state.gameOver||sim.state.paused)return false;
  const def=CARDS[entry.id];
  if(def.category!=="blueprint"){
    const message=def.apply();
    removeCopy(entry);
    LISTENERS.handChanged();
    if(message)sim.toast(message);
    return "applied";
  }
  // Blueprint: hand the simulation's own placement flow the wheel. It refuses while a
  // stack-limited deployable is out of stacks, and says so itself — report that as a
  // no-play rather than inventing a second message on top of it.
  if(ACTIVE&&ACTIVE.id===entry.id){cancelPlay();return false;}
  if(ACTIVE)cancelPlay();
  sim.toggleBuildMode(def.build);
  if(sim.state.buildMode!==def.build)return false;
  if(entry.partial===null)entry.partial=def.charges;
  ACTIVE={id:entry.id,build:def.build,buildings:sim.buildings.length};
  LISTENERS.handChanged();
  sim.toast(def.name+" open — "+chargeText(entry.partial)+", right-click to stow");
  return "targeting";
}
/** Put an in-flight blueprint away without spending anything further. */
function cancelPlay(){
  if(!ACTIVE)return;
  ACTIVE=null;
  if(sim.state.buildMode)sim.cancelBuildMode();
  LISTENERS.handChanged();
}
/** Which hand index, if any, is mid-placement. The hand strip lifts and lights it. */
export function activeIndex(){ return ACTIVE?HAND.findIndex(entry=>entry.id===ACTIVE.id):-1; }

// ── drafts ──────────────────────────────────────────────────────────────────
// Two flavours over one record: a level pick (boons in the mix) and a dawn pick
// (consumables and blueprints only, the night's payout).
let DRAFT = null;      // {kind:"level"|"dawn", offers:[id,id,id], reason}
const POOL = Object.values(CARDS);
const pick3 = pool => {
  const bag=[...pool],out=[];
  while(out.length<3&&bag.length)out.push(...bag.splice(Math.floor(Math.random()*bag.length),1));
  return out.map(def=>def.id);
};
function openDraft(kind){
  if(DRAFT)return false;
  DRAFT={kind,offers:pick3(POOL.filter(def=>kind==="dawn"?def.category!=="boon":true))};
  LISTENERS.draftChanged();
  return true;
}
function localDraftPending(){ return DRAFT?DRAFT.offers.slice():null; }
function localDraftKind(){ return DRAFT?DRAFT.kind:null; }
function localChooseDraft(index){
  if(!DRAFT)return false;
  const id=DRAFT.offers[index];
  if(!id)return false;
  const def=CARDS[id];
  DRAFT=null;
  if(def.category==="boon"){const message=def.apply();if(message)sim.toast(message);}
  else addToHand(id);
  LISTENERS.draftChanged();
  return def.category;   // "boon" | "consumable" | "blueprint" — the caller animates on the last two
}
function localLevelState(){
  return {xp:sim.xp(),tier:sim.xpTier(),next:sim.nextXpThreshold(),points:sim.skillPoints()};
}

// ── the frame watcher ───────────────────────────────────────────────────────
// The two things the simulation raises no effect for. Placement: buildings.length moving
// while a blueprint is active means a charge landed. Progression: a tier crossing is a
// level, a completed night is a dawn. Called once per frame by main.js; it is idempotent
// and does nothing at all until one of those three numbers moves.
let lastTier=null,lastNights=null;
export function tickCards(){
  if(ACTIVE){
    const def=CARDS[ACTIVE.id],entry=stackOf(ACTIVE.id),landed=sim.buildings.length-ACTIVE.buildings;
    if(!entry){ACTIVE=null;}
    else if(landed>0){
      ACTIVE.buildings=sim.buildings.length;
      entry.partial=Math.max(0,entry.partial-landed);
      if(entry.partial<=0){
        // Last charge of the kit: spend the copy and get out of the placement flow.
        removeCopy(entry);ACTIVE=null;
        if(sim.state.buildMode===def.build)sim.cancelBuildMode();
        sim.toast(def.name+" spent — the kit is empty");
      }else{
        // A one-shot building type drops out of build mode after each placement; a kit with
        // charges left re-arms itself so the whole kit runs as one continuous action.
        if(sim.state.buildMode!==def.build){
          sim.toggleBuildMode(def.build);
          if(sim.state.buildMode!==def.build)ACTIVE=null;
        }
        // Overwrite whatever the placement itself announced: the card's remaining charges are
        // the number that matters here, and they are what the pips just ticked down to.
        sim.toast(def.name+" — "+chargeText(entry.partial));
      }
      LISTENERS.handChanged();
    }else if(sim.state.buildMode!==def.build){
      // Cancelled (right-click, escape or the dock): settle back with the charges it still has.
      ACTIVE=null;LISTENERS.handChanged();
      sim.toast(def.name+" stowed — "+chargeText(entry.partial));
    }
  }
  const tier=sim.xpTier(),nights=sim.state.clock.completedNights;
  if(lastTier===null){lastTier=tier;lastNights=nights;return;}
  if(tier>lastTier){lastTier=tier;LISTENERS.levelChanged();openDraft("level");}
  if(nights>lastNights){lastNights=nights;openDraft("dawn");}
}

// ── dev helpers ─────────────────────────────────────────────────────────────
function localDebugDealCard(id,copies=1){ return addToHand(id,copies); }
/** Screenshot staging: put the hand in a known state. Returns the hand it produced. */
export function debugSetHand(entries){
  HAND.length=0;ACTIVE=null;
  for(const entry of entries){
    const id=typeof entry==="string"?entry:entry.id;
    if(!CARDS[id]||CARDS[id].category==="boon")continue;
    HAND.push({id,count:(entry.count??1),partial:(entry.charges??null)});
  }
  LISTENERS.handChanged();
  return localHand();
}
export function debugOpenDraft(kind="level"){ DRAFT=null; return openDraft(kind==="dawn"?"dawn":"level"); }

// ── the contract ────────────────────────────────────────────────────────────
// Real simulation export wins; the local model is the fallback. Bound once at module
// load, so the choice is made in exactly one place and never re-tested at a call site.
export const hand         = sim.hand         || localHand;
export const playCard     = sim.playCard     || localPlayCard;
export const draftPending = sim.draftPending || localDraftPending;
export const draftKind    = sim.draftKind    || localDraftKind;
export const chooseDraft  = sim.chooseDraft  || localChooseDraft;
export const levelState   = sim.levelState   || localLevelState;
export const debugDealCard= sim.debugDealCard|| localDebugDealCard;
