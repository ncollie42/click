// Owns composition and frame order; no gameplay, render, or adapter state.
// Pipeline: URL mode → adapters → simulation initialization → frame update → scene sync/visibility →
// Three.js render → 2D overlay → showcase UI projection → deferred debugger scans.
// simulation.js owns mutable gameplay; render and UI adapters consume queries and injected effects.
import {connect as connectSimulation, initializeRunMode, TUNE, update, toast, setBuildDockCategory} from "./game/simulation.js";
import {connect as connectScene, resizeRenderer, drawScene, renderScene} from "./render/scene.js";
import {drawOverlay, resizeOverlay} from "./render/overlay.js";
import {SIM_EFFECTS, initHud, modalOpen, syncBuildHud, syncPhaseHud} from "./ui/hud.js";
import {SKILL_TREE_EFFECTS, initSkillTree} from "./ui/skill-tree.js";
import {connectCards, tickCards, debugDealCard, debugSetHand, debugOpenDraft, draftKind} from "./ui/cards.js";
import {initHand, renderHand, debugHoldFlights} from "./ui/hand.js";
import {DRAFT_EFFECTS, initDraft} from "./ui/draft.js";
import {initInput} from "./input.js";
import {initViewDebugger, syncViewInputs, syncXpReadout, tickVisibility, drainScans} from "./debug/view-debugger.js";
import {initShowcaseUi, updateShowcaseUi} from "./ui/showcase.js";

// The overlay canvas is the input surface, the 2D overlay and the raycast target all at once.
const surface = document.getElementById("overlay");

/**
 * The one resize path. The scene resizes first and hands back the CSS box it measured, so the
 * overlay's backing store is always sized from the identical numbers. Returns nothing; a canvas
 * with no layout yet leaves both sides untouched, exactly as before.
 */
function resizeView(){
  const box = resizeRenderer();
  if(box) resizeOverlay(box.width, box.height);
}

// ── composition ───────────────────────────────────────────────────────────
// Two calls are order-dependent: the HUD must
// be initialised before the debugger (a binding repaints the dock as it is bound, which needs the
// surface the HUD was handed), and input before the debugger (its window keydown must stay ahead of
// the shift+digit handler). initSkillTree() only binds listeners to markup that is always there,
// so its position is free; it sits with the other adapters.
// handChanged / draftChanged / levelChanged ride in the same record as every other effect, so
// a simulation that grows the card contract natively calls straight through to the same sinks
// the local model in src/ui/cards.js calls today (see the header there).
const CARD_EFFECTS = {handChanged(){renderHand();}, ...DRAFT_EFFECTS};
connectSimulation({...SIM_EFFECTS, ...SKILL_TREE_EFFECTS, ...CARD_EFFECTS,
  phaseHudChanged(){SIM_EFFECTS.phaseHudChanged();syncXpReadout();}
});
connectCards(CARD_EFFECTS);
// ── Mode-selection data flow ──
// Browser URL is read only here. The simulation receives one initialization command and remains
// independent of window/location; absent or unknown values preserve the normal default lifecycle.
const requestedMode=new URLSearchParams(window.location.search).get("mode")==="showcase"?"showcase":"normal";
connectScene({isModalOpen(){return modalOpen();}});
initHud(surface);
initSkillTree(surface);
// Both card adapters bind their window keydown BEFORE src/input.js binds its own, which is the
// whole reason they sit here: the draft overlay has to swallow a press aimed at a stage it
// completely covers, and the hand has to clear its browse cursor on escape before the pause
// chain sees that press. Neither consumes anything while a modal is open or a digit is shifted.
initHand();
initDraft();
initInput(surface, {cameraChanged(){ syncViewInputs(); }});
initViewDebugger({resizeView});
// Initialize after adapters bind their authored defaults, so showcase camera/fixtures are the final
// boot state; normal initialization remains a no-op and leaves production startup untouched.
initializeRunMode(requestedMode);
if(requestedMode==="showcase"){syncViewInputs();initShowcaseUi({cameraChanged(){syncViewInputs();}});}
window.addEventListener("resize", resizeView);

// ── card demo helpers ─────────────────────────────────────────────────────
// Screenshot and console staging only; nothing below runs unless it is called. `?draftDemo=1`
// deals a representative hand at boot (a stacked copy and a part-spent kit among them) so the
// strip can be looked at without playing up to it.
//   window.__draftDemo.deal()        real level offer (boons in the mix)
//   window.__draftDemo.dawn()        real dawn offer (hand cards only)
//   window.__draftDemo.hand([...])   set the hand outright; "id" or {id,count,charges}
//   window.__draftDemo.add(id,n)     deal one card in, the way a draft does
//   window.__draftDemo.freeze(on)    pause/resume card flights mid-air for a photograph
const DEMO_HAND=[{id:"spikeKit",count:1,charges:2},{id:"rations",count:2},"coinPurse",
  "watchPlan","tarBarrels","harvestFeast"];
window.__draftDemo={
  deal(){return debugOpenDraft("level");},
  dawn(){return debugOpenDraft("dawn");},
  hand(entries=DEMO_HAND){return debugSetHand(entries);},
  add(id,copies=1){return debugDealCard(id,copies);},
  freeze(on=true){debugHoldFlights(on);},
  kind(){return draftKind();},
};
if(new URLSearchParams(window.location.search).get("draftDemo")==="1")window.__draftDemo.hand();

// Visibility may add scene pins before rendering; debugger scans drain only after the visible frame.
function draw(){
  if(drawScene()) syncViewInputs();   // orbit advanced the yaw; push it back into the slider
  tickVisibility();
  renderScene();
  drawOverlay();
  updateShowcaseUi();
  drainScans();
}

// ── boot ──────────────────────────────────────────────────────────────
resizeView();
syncBuildHud();syncPhaseHud();setBuildDockCategory(null);
let previous=performance.now();
function frame(now){
  const dt=Math.min(.033,(now-previous)/1000);previous=now;
  // Speed-up runs extra whole steps rather than stretching dt — a 3x-longer dt
  // would let enemies skip past melee range and break contact-damage checks.
  for(let i=0;i<TUNE.gameSpeed;i++)update(dt);
  // After the step, before the frame: the card model watches for the three things the
  // simulation raises no effect for — a placement landing on the active card, a tier crossing
  // and a night completing. It is a no-op until one of those numbers moves.
  tickCards();
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
toast(requestedMode==="showcase"?"showcase ready — towers use production combat stats":"left-hold a tree or rock to gather");
