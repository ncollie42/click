// Owns: composition. It wires the simulation to the render layer and to the four browser adapters,
// then runs the frame. It owns no gameplay state, no meshes, no listeners of its own beyond resize,
// and no DOM markup — every one of those belongs to a module named below.
// ═══════════════════════════════════════════════════════════════════════════
// HOST / COMPOSITION ROOT
//
// Module layout (a straight line; there are no cycles anywhere in the graph):
//
//   src/game/data.js        authored, immutable definitions — world and frame dimensions, the
//                           placement lattice, footprints, resource kinds, the building / upgrade /
//                           tower / enemy tables, the wave recipes, the pacing constants. A leaf:
//                           it imports nothing.
//   src/game/grid.js        pure placement-lattice math over data.js. No state.
//   src/game/skill-tree-data.js
//                           the authored skill graph — node ids, placeholder names / glyphs, graph
//                           coordinates and the undirected edge list, all frozen. A second leaf: it
//                           imports nothing, and it holds shape only, no cost and no effect.
//   src/game/simulation.js  the SOLE owner of mutable gameplay state. Commands go in, queries come
//                           out. It is DOM-free and Three.js-free, and it imports nothing but
//                           data.js, grid.js and skill-tree-data.js. Player-facing feedback leaves
//                           it by NAME, through the effect record connect() installs.
//
//   src/render/palette.js -> models.js -> scene.js -> overlay.js
//                           the presentation layer, read-only over the simulation. scene.js is the
//                           one producer of screen coordinates (project()); overlay.js is its sole
//                           consumer. Mutable presentation holders live here: view / VIEW_TUNE /
//                           IND in scene.js, BARS / BADGE in overlay.js.
//
//   src/ui/hud.js           the HUD adapter: build dock, phase panel, prompt, toast, upgrade modal,
//                           pause badge, game-over card, and the effect record the simulation calls
//                           back into. The lowest of the four adapters — the other three import it.
//   src/ui/skill-tree.js    the skill-tree adapter: the #skillTreePanel overlay, its connector SVG
//                           and its node tiles, rebuilt whole from the simulation's skill queries.
//                           Read-only over the graph. The second half of the effect record, and
//                           the second modal — it asks hud.js to repaint the shared modal class.
//   src/input.js            the input adapter: pointer, wheel, keyboard, blur/cancel, camera intent
//                           and the screen-to-world conversion. Ends every path in a command.
//   src/debug/view-debugger.js
//                           the view panel: tabs, ~60 control bindings, the sightline scan.
//
//   src/main.js             this file. The only importer of all of them, and the only place they
//                           are composed.
//
// Ownership / data flow through this file
//   Reads:    nothing from the simulation but TUNE.gameSpeed, for the loop below.
//   Writes:   nothing. Every write in the running game happens inside a module above.
//   Supplies: the four wiring points, all of them the same shape (a record of named hooks, replaced
//             wholesale at boot, never a bare imported binding — an imported binding is read-only
//             and assigning to one throws):
//               connectSimulation({...effects})     hud.js and skill-tree.js implement the
//                                                   simulation's effects, one record each, disjoint
//                                                   by name and merged here — connect() is called
//                                                   once, so the merge cannot live in an adapter.
//               connectScene({isModalOpen})         the one host predicate the scene needs, so the
//                                                   idle cursor bracket refuses to draw over a modal.
//               initInput(surface, {cameraChanged}) the wheel's zoom has to reach the debugger's
//                                                   sliders without input.js knowing they exist.
//               initViewDebugger({resizeView})      the ortho toggle has to reach the ONE resize
//                                                   path, which is composed here.
//
// The DOM element <canvas id="overlay"> is looked up HERE and handed to the three adapters that
// need it, which keeps its owners at the documented three: this file (listeners, via input.js;
// classes, via hud.js; and focus, via skill-tree.js), src/render/overlay.js (2D context and backing
// store) and src/render/scene.js (client rect for the raycast). No adapter looks it up for itself.
// ═══════════════════════════════════════════════════════════════════════════
import {connect as connectSimulation, TUNE, update, toast, setBuildDockCategory} from "./game/simulation.js";
import {connect as connectScene, resizeRenderer, drawScene, renderScene} from "./render/scene.js";
import {drawOverlay, resizeOverlay} from "./render/overlay.js";
import {SIM_EFFECTS, initHud, modalOpen, syncBuildHud, syncPhaseHud} from "./ui/hud.js";
import {SKILL_TREE_EFFECTS, initSkillTree} from "./ui/skill-tree.js";
import {initInput} from "./input.js";
import {initViewDebugger, syncViewInputs, tickVisibility, drainScans} from "./debug/view-debugger.js";

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
// Two of these four calls are order-dependent, and the comments on each init say why: the HUD must
// be initialised before the debugger (a binding repaints the dock as it is bound, which needs the
// surface the HUD was handed), and input before the debugger (its window keydown must stay ahead of
// the shift+digit handler). initSkillTree() only binds listeners to markup that is always there,
// so its position is free; it sits with the other adapters.
connectSimulation({...SIM_EFFECTS, ...SKILL_TREE_EFFECTS});
connectScene({isModalOpen(){return modalOpen();}});
initHud(surface);
initSkillTree(surface);
initInput(surface, {cameraChanged(){ syncViewInputs(); }});
initViewDebugger({resizeView});
window.addEventListener("resize", resizeView);

// ─────────────────────────────────────────────────────────── frame
// The composition point for the render layer, in the order the single-file draw() ran:
// scene sync, then the throttled visibility measurement (it adds occlusion pins to the scene, so it
// must land before the draw call), then the draw call, then the 2D overlay on top, then draining
// any scan a debugger slider scheduled — after the frame is on screen, never during it.
function draw(){
  if(drawScene()) syncViewInputs();   // orbit advanced the yaw; push it back into the slider
  tickVisibility();
  renderScene();
  drawOverlay();
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
toast("left-hold a tree or rock to gather");
