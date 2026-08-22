// Owns raw browser input and converts pointer events to world-space simulation commands.
// Reads simulation state only for input guards; camera/debug synchronization leaves through HOOKS.
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
import {placeCamera, groundFromEvent, view} from "./render/scene.js";
import {addClickRipple} from "./render/overlay.js";
import {modalOpen, toggleMute} from "./ui/hud.js";

// The element every canvas-level listener below is attached to. Set once, by initInput().
let surface = null;

// ── host hooks ──────────────────────────────────────────────────────────────
// Same shape as the simulation's connect(effects) and the scene's connect(hooks): a record of
// named sinks, filled in wholesale at boot. The default is a no-op so this module runs headless.
const HOOKS = {
  cameraChanged(){},
  uiVisibilityChanged(){},
};

/** Event -> world pixels -> the simulation's pointer. Outside the ground plane counts as outside. */
function pointerPosition(event){
  const g=groundFromEvent(event);
  if(!g){setPointerOutside();return;}
  setPointerWorld(g.x,g.y);
}

// ── orbit (shift+left-drag) ─────────────────────────────────────────────────
// The test scene's camera feel (tools/test-scene/camera-controls.js) ported behind SHIFT, because
// a bare left press is gameplay (gather/build). Yaw is free while dragging; release glides to the
// nearest 45° compass detent — same law as the view debugger's yaw slider. Pitch drags too,
// clamped to the debugger's 15–89 range. view.* is the debug-owned pose holder scene.js exports;
// drawScene re-places the camera from it every frame, so handlers only need HOOKS.cameraChanged
// to keep the debugger readouts honest (the same contract the middle-drag pan uses).
const ORBIT_RATE = .25, YAW_DETENT = 45, YAW_TWEEN_MS = 220;
let orbitDrag = null;   // {x, y} last pointer position while shift-dragging
let yawTweenId = 0;
function tweenYawTo(target){
  cancelAnimationFrame(yawTweenId); yawTweenId = 0;
  const from = view.yaw, delta = ((target - from + 540) % 360) - 180;
  if(Math.abs(delta) < .5){ view.yaw = (target + 360) % 360; return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min((now - t0) / YAW_TWEEN_MS, 1);
    view.yaw = (from + delta * (1 - Math.pow(1 - k, 3)) + 360) % 360;
    placeCamera(); HOOKS.cameraChanged();
    if(k < 1) yawTweenId = requestAnimationFrame(step); else yawTweenId = 0;
  };
  yawTweenId = requestAnimationFrame(step);
}
function endOrbit(snap){
  if(!orbitDrag) return;
  orbitDrag = null;
  if(snap) tweenYawTo(Math.round(view.yaw / YAW_DETENT) * YAW_DETENT % 360);
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
  if(orbitDrag){
    const dx = event.clientX - orbitDrag.x, dy = event.clientY - orbitDrag.y;
    orbitDrag.x = event.clientX; orbitDrag.y = event.clientY;
    view.yaw = (view.yaw - dx * ORBIT_RATE + 360) % 360;
    view.pitch = Math.max(15, Math.min(89, view.pitch + dy * ORBIT_RATE));
    placeCamera(); HOOKS.cameraChanged();
    return;
  }
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
  // Shift+left claims the press for orbiting before any guard, same priority rule as the middle
  // pan above — the camera stays drivable while paused or over the upgrade panel.
  if(event.button===0&&event.shiftKey){
    event.preventDefault();
    cancelAnimationFrame(yawTweenId); yawTweenId=0;
    orbitDrag={x:event.clientX,y:event.clientY};
    surface.setPointerCapture(event.pointerId);
    return;
  }
  if(state.gameOver||state.paused||modalOpen())return;
  // Presentation-only press mark: every primary press on the world gets a same-frame ripple at the
  // cursor, whether or not the press resolves to an action — empty ground included.
  if(event.button===0&&state.mouse.inside)addClickRipple(state.mouse.x,state.mouse.y);
  if(event.button===0)primaryPress();
  if(event.button===2)secondaryPress();
}
// Window-level release prevents collection or camera drag getting stuck outside the canvas.
function onPointerUp(event){if(event.button===0&&orbitDrag){endOrbit(true);return;}if(event.button===0)primaryRelease();if(event.button===2)secondaryRelease();if(event.button===1)endCameraPan();}
function onPointerCancel(){ endOrbit(false); pointerCancelled(); }
function onBlur(){ windowBlurred();HOOKS.uiVisibilityChanged(false); }
function onKeyDown(event){
  // Hold-to-hide is presentation-only. It precedes modal guards so screenshots can hide any UI,
  // and preventing default keeps focus fixed instead of walking the debugger or modal controls.
  if(event.code==="Tab"){event.preventDefault();if(!event.repeat)HOOKS.uiVisibilityChanged(true);return;}
  // Escape is a dismiss chain, outermost thing first, and each link reports whether it consumed the
  // press: the skill tree covers the whole stage, so it goes before the panel underneath it.
  if(event.code==="Escape"){event.preventDefault();if(!event.repeat){if(closeSkillTree())return;if(closeUpgradeMenu())return;if(cancelBuildMode())return;togglePause();}return;}
  // Mute is presentation-only, so it stays available under every modal and guard.
  if(event.code==="KeyM"){if(!event.repeat)toggleMute();return;}
  // The K skill-tree shortcut is retired while the tree is hidden from production UI (its nodes
  // have no cost or effect yet); the view panel's "open skill tree" button remains the debug entry.
  // The skill tree covers the whole stage, so panning under it would scroll a world nobody can see;
  // openSkillTree() already dropped the held keys and this stops new ones being taken. Escape above
  // is deliberately ahead of the guard, and the upgrade panel — which hides little — is untouched.
  if(state.skillTree.open)return;
  if(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"].includes(event.code)){event.preventDefault();pressKey(event.code);}
}
function onKeyUp(event){
  if(event.code==="Tab")HOOKS.uiVisibilityChanged(false);
  releaseKey(event.code);
}

// ── registration ────────────────────────────────────────────────────────────
// Every listener this adapter owns, in registration order. Called once by main.js after initHud()
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
