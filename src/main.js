// Owns composition and frame order; no gameplay, render, or adapter state.
// Pipeline: URL mode → adapters → simulation initialization → frame update → scene sync/visibility →
// Three.js render → 2D overlay → showcase UI projection → deferred debugger scans.
// simulation.js owns mutable gameplay; render and UI adapters consume queries and injected effects.
import {connect as connectSimulation, initializeRunMode, TUNE, update, toast, setBuildDockCategory} from "./game/simulation.js";
import {connect as connectScene, resizeRenderer, drawScene, renderScene} from "./render/scene.js";
import {drawOverlay, resizeOverlay} from "./render/overlay.js";
import {SIM_EFFECTS, initHud, modalOpen, syncBuildHud, syncPhaseHud} from "./ui/hud.js";
import {SKILL_TREE_EFFECTS, initSkillTree} from "./ui/skill-tree.js";
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
connectSimulation({...SIM_EFFECTS, ...SKILL_TREE_EFFECTS,
  phaseHudChanged(){SIM_EFFECTS.phaseHudChanged();syncXpReadout();}
});
// ── Mode-selection data flow ──
// Browser URL is read only here. The simulation receives one initialization command and remains
// independent of window/location; absent or unknown values preserve the normal default lifecycle.
const requestedMode=new URLSearchParams(window.location.search).get("mode")==="showcase"?"showcase":"normal";
connectScene({isModalOpen(){return modalOpen();}});
initHud(surface);
initSkillTree(surface);
initInput(surface, {cameraChanged(){ syncViewInputs(); }});
initViewDebugger({resizeView});
// Initialize after adapters bind their authored defaults, so showcase camera/fixtures are the final
// boot state; normal initialization remains a no-op and leaves production startup untouched.
initializeRunMode(requestedMode);
if(requestedMode==="showcase"){syncViewInputs();initShowcaseUi({cameraChanged(){syncViewInputs();}});}
window.addEventListener("resize", resizeView);

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
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
toast(requestedMode==="showcase"?"showcase ready — towers use production combat stats":"left-hold a tree or rock to gather");
