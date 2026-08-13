// Owns: raw browser input — pointer, wheel, keyboard, blur/cancel — and the screen-to-world
// conversion that turns an event into a simulation command. Owns no gameplay state and no DOM UI.
// ═══════════════════════════════════════════════════════════════════════════
// INPUT ADAPTER
// Every listener here ends in either a simulation COMMAND or a camera placement call. Nothing in
// this file draws, and nothing in it reads or writes a HUD element.
//
// Ownership / data flow
//   Reads:    `state` from src/game/simulation.js, read-only, for the three facts a handler needs
//             before it can decide: whether a camera pan is in progress, whether the run is
//             over / paused, and whether the skill-tree screen is up. It never assigns into it.
//   Writes:   only through simulation commands (setPointerWorld, setPointerOutside, primaryPress,
//             primaryRelease, secondaryPress, secondaryRelease, pointerCancelled, windowBlurred,
//             pressKey, releaseKey, beginCameraPan, endCameraPan, dragCameraTo, zoomCameraBy,
//             offsetCamera, clampCamera, togglePause, cancelBuildMode, closeUpgradeMenu,
//             closeSkillTree) and through src/render/scene.js's placeCamera(), which re-derives
//             the camera from the simulation's camera state. There is no third way out of here.
//   Asks:     modalOpen() from src/ui/hud.js — a pointer-down must not reach gameplay while a modal
//             owns input. That is the ONLY guard for the upgrade panel, which leaves most of the
//             canvas exposed; the skill tree also covers the surface, so its presses never arrive
//             here at all. The HUD is the lower module of the two, so this is a plain import and
//             the dependency runs input -> hud and never back.
//             HOOKS.cameraChanged() — injected by main.js. The view debugger's yaw/zoom sliders
//             mirror the camera, so a programmatic camera change (wheel zoom) has to push back into
//             them. Injected rather than imported so this file never learns a debugger exists.
//
// ── Pointer data flow ──
// Written by: the handlers below, through setPointerWorld()/setPointerOutside().
// Read by:    the simulation's update() (collection, drop delivery) and the scene (hover feedback).
// Format:     world-space simulation pixels, produced by scene.js's groundFromEvent(), which
//             raycasts the ground plane — the 3D equivalent of the old inverse camera transform,
//             correct at any pitch/yaw.
//
// The pointer surface (<canvas id="overlay">) is handed in by main.js rather than looked up here,
// so the element keeps its documented three owners: main.js (listeners, classes and focus),
// src/render/overlay.js (2D context and backing store), src/render/scene.js (client rect).
// ═══════════════════════════════════════════════════════════════════════════
import {
  state,
  // commands — player intent
  setPointerWorld, setPointerOutside, primaryPress, primaryRelease,
  secondaryPress, secondaryRelease, pointerCancelled, windowBlurred,
  pressKey, releaseKey,
  beginCameraPan, endCameraPan, dragCameraTo, zoomCameraBy,
  offsetCamera, clampCamera,
  togglePause, cancelBuildMode, closeUpgradeMenu, closeSkillTree
} from "./game/simulation.js";
import {placeCamera, groundFromEvent} from "./render/scene.js";
import {modalOpen} from "./ui/hud.js";

// The element every canvas-level listener below is attached to. Set once, by initInput().
let surface = null;

// ── host hooks ──────────────────────────────────────────────────────────────
// Same shape as the simulation's connect(effects) and the scene's connect(hooks): a record of
// named sinks, filled in wholesale at boot. The default is a no-op so this module runs headless.
const HOOKS = {
  cameraChanged(){},
};

/** Event -> world pixels -> the simulation's pointer. Outside the ground plane counts as outside. */
function pointerPosition(event){
  const g=groundFromEvent(event);
  if(!g){setPointerOutside();return;}
  setPointerWorld(g.x,g.y);
}

// ── handlers ────────────────────────────────────────────────────────────────
// Named rather than inline so the registration list below reads as a table.

function onWheel(event){
  event.preventDefault();
  // Zoom toward the cursor: remember the ground point, rescale, put it back. placeCamera() has to
  // run between the two reads, or the second raycast would still use the old projection.
  const before=groundFromEvent(event);
  zoomCameraBy(Math.exp(-event.deltaY*.0015));
  placeCamera();
  const after=groundFromEvent(event);
  if(before&&after)offsetCamera(before.x-after.x,before.y-after.y);
  clampCamera();placeCamera();pointerPosition(event);HOOKS.cameraChanged();
}
function onPointerMove(event){
  if(state.camera.panning){
    // Drag keeps the grabbed ground point pinned under the cursor.
    const g=groundFromEvent(event);
    if(g){dragCameraTo(g.x,g.y);placeCamera();}
  }
  pointerPosition(event);
}
function onPointerLeave(){ setPointerOutside(); }
function onPreventDefault(event){ event.preventDefault(); }
// Priority order, unchanged: middle button claims the event for camera panning before any guard
// runs, so a pan still works while paused, after the base has fallen, and over the upgrade panel,
// which leaves most of the canvas exposed. The skill tree is the case this cannot cover: it is a
// full-stage overlay, so a press over it never reaches the surface and no handler here runs.
function onPointerDown(event){
  pointerPosition(event);
  if(event.button===1){event.preventDefault();const g=groundFromEvent(event);beginCameraPan(g?g.x:state.camera.x,g?g.y:state.camera.y);surface.setPointerCapture(event.pointerId);return;}
  if(state.gameOver||state.paused||modalOpen())return;
  if(event.button===0)primaryPress();
  if(event.button===2)secondaryPress();
}
// Window-level release prevents collection or camera drag getting stuck outside the canvas.
function onPointerUp(event){if(event.button===0)primaryRelease();if(event.button===2)secondaryRelease();if(event.button===1)endCameraPan();}
function onPointerCancel(){ pointerCancelled(); }
function onBlur(){ windowBlurred(); }
function onKeyDown(event){
  // Escape is a dismiss chain, outermost thing first, and each link reports whether it consumed the
  // press: the skill tree covers the whole stage, so it goes before the panel underneath it.
  if(event.code==="Escape"){event.preventDefault();if(!event.repeat){if(closeSkillTree())return;if(closeUpgradeMenu())return;if(cancelBuildMode())return;togglePause();}return;}
  // The skill tree covers the whole stage, so panning under it would scroll a world nobody can see;
  // openSkillTree() already dropped the held keys and this stops new ones being taken. Escape above
  // is deliberately ahead of the guard, and the upgrade panel — which hides little — is untouched.
  if(state.skillTree.open)return;
  if(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"].includes(event.code)){event.preventDefault();pressKey(event.code);}
}
function onKeyUp(event){ releaseKey(event.code); }

// ── registration ────────────────────────────────────────────────────────────
// Every listener this adapter owns, in one auditable list, in the order the single-file build
// registered them. Called once, by main.js, after initHud() (the pointer-down guard needs the HUD)
// and before the view debugger (whose shift+digit handler must stay the later keydown listener).
export function initInput(pointerSurface, hooks={}){
  surface = pointerSurface;
  Object.assign(HOOKS, hooks);

  surface.addEventListener("wheel", onWheel, {passive:false});
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerleave", onPointerLeave);
  surface.addEventListener("contextmenu", onPreventDefault);
  surface.addEventListener("auxclick", onPreventDefault);
  surface.addEventListener("pointerdown", onPointerDown);

  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("blur", onBlur);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
}
