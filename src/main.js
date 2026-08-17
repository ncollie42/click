// Owns composition and frame order; no gameplay, render, or adapter state.
// Pipeline: URL mode → adapters → simulation initialization → frame update → scene sync/visibility →
// Three.js render → 2D overlay → showcase UI projection → deferred debugger scans.
// simulation.js owns mutable gameplay; render and UI adapters consume queries and injected effects.
import {connect as connectSimulation, initializeRunMode, TUNE, update, toast} from "./game/simulation.js";
// Namespace as well as named bindings: the ?draftDemo console helpers below reach for a handful of
// debug commands that nothing else in the composition names.
import * as SIMULATION from "./game/simulation.js";
import {connect as connectScene, resizeRenderer, drawScene, renderScene, combatTargetOnScreen} from "./render/scene.js";
import {drawOverlay, resizeOverlay} from "./render/overlay.js";
import {SIM_EFFECTS, initHud, modalOpen, syncBuildHud, syncPhaseHud} from "./ui/hud.js";
import {SKILL_TREE_EFFECTS, initSkillTree} from "./ui/skill-tree.js";
import {initHand, renderHand, syncHandTargeting, syncHandPeek, debugHoldFlights} from "./ui/hand.js";
import {DRAFT_EFFECTS, initDraft, syncLevelHud} from "./ui/draft.js";
import {initInput} from "./input.js";
import {
  initViewDebugger, syncViewInputs, syncXpReadout, tickVisibility, tickPerformance, drainScans
} from "./debug/view-debugger.js";
import {initShowcaseUi, updateShowcaseUi} from "./ui/showcase.js";
import {initBuildVersion} from "./ui/build-version.js";

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
// handChanged / draftChanged / levelChanged ride in the same record as every other effect, so the
// card UI is driven entirely by the simulation raising them — nothing polls.
connectSimulation({...SIM_EFFECTS, ...SKILL_TREE_EFFECTS, ...DRAFT_EFFECTS,
  isCombatTargetOnScreen(target){return combatTargetOnScreen(target);},
  handChanged(){renderHand();},
  phaseHudChanged(){SIM_EFFECTS.phaseHudChanged();syncXpReadout();},
  // Arming and cancelling a card's placement is a BUILD-hud move in the simulation's eyes: only
  // which card owns the cursor changed, not the hand itself. The hand listens too, so the lifted,
  // rarity-lit card settles back the instant a right-click stows a part-spent kit.
  buildHudChanged(){SIM_EFFECTS.buildHudChanged();syncHandTargeting();}
});
// ── Mode-selection data flow ──
// Browser URL is read only here, with one documented exception: data.js reads ?mapSize at import
// time (W/H must exist before any module body runs). The simulation receives one initialization command and remains
// independent of window/location; absent or unknown values preserve the normal default lifecycle.
const search=new URLSearchParams(window.location.search);
const requestedMode=search.get("mode")==="showcase"?"showcase":"normal";
if(search.get("draftDemo")==="1")draftDemo();
connectScene({isModalOpen(){return modalOpen();}});
initHud(surface);
initSkillTree(surface);
// Both card adapters bind their window keydown BEFORE src/input.js binds its own, which is the
// whole reason they sit here: the draft overlay has to swallow a press aimed at a stage it
// completely covers, and the hand has to clear its browse cursor on escape before the pause
// chain sees that press. Neither consumes anything while a modal is open or a digit is shifted.
initHand();
initDraft(surface);
initInput(surface, {
  cameraChanged(){syncViewInputs();},
  uiVisibilityChanged(hidden){document.body.classList.toggle("ui-hidden",hidden);},
});
initViewDebugger({resizeView});
initBuildVersion();
// Initialize after adapters bind their authored defaults, so showcase camera/fixtures are the final
// boot state; normal initialization remains a no-op and leaves production startup untouched.
initializeRunMode(requestedMode);
if(requestedMode==="showcase"){syncViewInputs();initShowcaseUi({cameraChanged(){syncViewInputs();}});}
window.addEventListener("resize", resizeView);

// Visibility may add scene pins before rendering; debugger scans drain only after the visible frame.
function draw(){
  const started=performance.now();
  if(drawScene()) syncViewInputs();   // orbit advanced the yaw; push it back into the slider
  const synced=performance.now();
  tickVisibility();
  const visibilityDone=performance.now();
  renderScene();
  const rendered=performance.now();
  drawOverlay();
  // The hand's peek/collapse state is the one card thing no simulation effect can raise: it depends
  // on the clock phase AND on enemies being alive, which move inside update() without any card
  // changing. One cheap read per frame; the call only touches the DOM when the answer changes.
  syncHandPeek();
  updateShowcaseUi();
  drainScans();
  const finished=performance.now();
  return {sceneSyncMs:synced-started,visibilityMs:visibilityDone-synced,
    renderMs:rendered-visibilityDone,uiMs:finished-rendered,drawWorkMs:finished-started};
}

// ── boot ──────────────────────────────────────────────────────────────
resizeView();
syncBuildHud();syncPhaseHud();syncLevelHud();
let previous=performance.now();
function frame(now){
  const dt=Math.min(.033,(now-previous)/1000);previous=now;
  const workStarted=performance.now();
  // Speed-up runs extra whole steps rather than stretching dt — a 3x-longer dt
  // would let enemies skip past melee range and break contact-damage checks.
  for(let i=0;i<TUNE.gameSpeed;i++)update(dt);
  const simulationDone=performance.now(),drawTiming=draw(),workDone=performance.now();
  // Stage timings are CPU wall time. WebGL submission may return before GPU completion; resolution
  // and pass isolation controls in the perf pane distinguish that case better than this clock can.
  tickPerformance(now,{simulationMs:simulationDone-workStarted,...drawTiming,workMs:workDone-workStarted});
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
toast(requestedMode==="showcase"?"showcase ready — towers use production combat stats":"left-hold a tree or rock to gather");

// ── dev-only: ?draftDemo=1 ────────────────────────────────────────────
// Console and screenshot staging over the REAL simulation — every helper below is a debug COMMAND
// the simulation already exports, so a staged hand is dealt, played and spent through exactly the
// paths a run uses. Nothing here fabricates a card, an offer or a level.
//   window.__draftDemo.deal(n)       level n times over, so real level offers appear
//   window.__draftDemo.dawn()        run a night to its end, so the real dawn reward is queued
//   window.__draftDemo.hand([...])   deal a list of card ids into the hand ("id" or [id, copies])
//   window.__draftDemo.add(id,n)     deal one card in, the way a draft does
//   window.__draftDemo.freeze(on)    pause/resume card flights mid-air for a photograph
const DEMO_HAND=[["woodBundle",2],"spikeKit","fireball","bpSniper","calmNight","healBase"];
function draftDemo(){
  window.__draftDemo={
    deal(count=1){for(let i=0;i<count;i++){const s=SIMULATION.levelState();SIMULATION.debugGrantXp(Math.max(1,Math.ceil(SIMULATION.levelCost(s.level)-s.xp)));}},
    dawn(){SIMULATION.debugGoToPhase("night");SIMULATION.debugGoToPhase("day");},
    hand(entries=DEMO_HAND){
      const dealt=[];
      for(const entry of entries){
        const [id,copies]=Array.isArray(entry)?entry:[entry,1];
        for(let i=0;i<copies;i++)if(SIMULATION.debugDealCard(id))dealt.push(id);
      }
      return dealt;
    },
    add(id,copies=1){let dealt=0;for(let i=0;i<copies;i++)if(SIMULATION.debugDealCard(id))dealt++;return dealt;},
    freeze(on=true){debugHoldFlights(on);},
    kind(){return SIMULATION.draftKind();},
  };
}
