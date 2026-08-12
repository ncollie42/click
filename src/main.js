// Owns: the browser host — DOM wiring, pointer/keyboard input, the HUD, the view debugger and the
// animation loop. Owns no gameplay state and no rendering; it composes the simulation with the
// render layer.
// ═══════════════════════════════════════════════════════════════════════════
// BROWSER ADAPTER + HOST
// Everything in this file is downstream of the simulation and upstream of nothing. It owns the
// browser: the DOM, pointer and keyboard events, the HUD and the view debugger — and it owns NO
// gameplay state and NO meshes.
//
// Ownership / data flow
//   Reads:    src/game/simulation.js through its queries and its exported live
//             collections. Those references are READ-ONLY here by contract: this
//             file may iterate and project them, never splice, push or assign
//             into them, and never assign into `state`.
//   Writes:   only through simulation commands (setPointerWorld, primaryPress,
//             secondaryPress, toggleBuildMode, openUpgradeMenu, …) and through
//             the tunable holders each side owns — TUNE and DBG in the simulation,
//             view / VIEW_TUNE / IND in src/render/scene.js and BARS / BADGE in
//             src/render/overlay.js. Every one of those is a mutable HOLDER or a
//             setter, never a bare imported binding: an imported binding is
//             read-only and assigning to one throws.
//   Supplies: the effect implementations the simulation calls back into (see
//             SIM_EFFECTS), and the one host predicate the scene needs (modalOpen,
//             through connectScene). They run synchronously inside commands and
//             inside update(), in the exact order the old inline DOM calls ran.
//
// Render layer (src/render/*): palette -> models -> scene -> overlay, a straight line with no
// cycles. This file is the only importer of all four and the only place they are composed:
//   resizeView()   the one resize path — scene first, then the overlay with the same box.
//   draw()         drawScene() -> the debugger's visibility measurement -> renderScene() ->
//                  drawOverlay(), the exact order the single-file draw() ran in.
//
// Still living here, deliberately, until step 6 splits them out: the HUD sync functions, all input
// listeners and the whole view debugger.
// ═══════════════════════════════════════════════════════════════════════════
// ── authored data ──
// Every immutable definition the game is authored from lives in src/game/data.js: world and frame
// dimensions, the placement lattice, footprints, resource kinds, the building / upgrade / tower /
// enemy tables, the wave recipes and the pacing constants. Nothing here may reassign or mutate any
// of them; this file only reads.
import {
  RESOURCE_KINDS,
  ENEMY_TYPES,
  NIGHT_WAVE_RECIPES,
  DAY_DURATION,NIGHT_DURATION
} from "./game/data.js";
// ── the simulation ──
// The sole owner of mutable gameplay state. Commands go in, queries come out; there is no third way
// to touch the world from this file. See that module's header for the full contract.
import {
  connect as connectSimulation, TUNE, DBG, state,
  update, toast,
  // commands — player intent
  setPointerWorld, setPointerOutside, primaryPress, primaryRelease,
  secondaryPress, secondaryRelease, pointerCancelled, windowBlurred,
  pressKey, releaseKey,
  beginCameraPan, endCameraPan, dragCameraTo, zoomCameraBy, setCameraZoom,
  offsetCamera, clampCamera,
  togglePause, cancelBuildMode, toggleBuildMode, setBuildDockCategory,
  closeUpgradeMenu, selectUpgrade, acceptUpgrade, setCapacity,
  // queries — pure reads
  hoverTarget, costText, upgradeList, nextHouseCost,
  oppositeMapSide, clamp,
  // debug entry points (view panel > gameplay)
  spawnEnemy, debugGrant, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase,
  debugStartWave, debugClearEnemies, debugHealAll
} from "./game/simulation.js";
// ── the render layer ──
// Read-only over the simulation, exactly like this file. Only the holders and setters named here
// are writable, and each is documented at its definition.
import {
  connect as connectScene, view, VIEW_TUNE, IND,
  placeCamera, resizeRenderer, setOrthoCamera, setShadows, setSelectorPreview,
  groundFromEvent, drawScene, renderScene,
  setPins, scanSubjects, scanBlockers, countVisible, updateWorldMatrices
} from "./render/scene.js";
import {setOutlines, outlineMat} from "./render/models.js";
import {BARS, BADGE, BADGE_ICON_RATIO, drawOverlay, resizeOverlay} from "./render/overlay.js";

// The overlay canvas is the input surface. scene.js reads its client rect to build a raycast ray and
// overlay.js owns its 2D context and backing store; this file owns its listeners and its classes.
const canvas = document.getElementById("overlay");

/**
 * The one resize path. The scene resizes first and hands back the CSS box it measured, so the
 * overlay's backing store is always sized from the identical numbers. Returns nothing; a canvas
 * with no layout yet leaves both sides untouched, exactly as before.
 */
function resizeView(){
  const box = resizeRenderer();
  if(box) resizeOverlay(box.width, box.height);
}
addEventListener("resize", resizeView);

// ── effect implementations handed to the simulation ─────────────────────────
// The simulation raises player-facing feedback by NAME; this record turns each name into the DOM
// work it used to do inline. Invariant (consumer end): every hook is a pure sink — it may read
// simulation state, it must never write it, and it must not call back into a command.
const SIM_EFFECTS = {
  toast(message){const el=document.getElementById("toast");el.textContent=message;el.classList.add("on");},
  sound(freq,duration){sound(freq,duration);},
  toastExpired(){document.getElementById("toast").classList.remove("on");},
  afterUpdate(){updatePrompt();syncPhaseHud();},
  gameOver(){document.getElementById("gameOver").classList.remove("off");},
  pauseChanged(paused){document.getElementById("pauseBadge").classList.toggle("off",!paused);},
  buildHudChanged(){syncBuildHud();},
  buildDockChanged(category){
    document.getElementById("buildCards").classList.toggle("open",!!category);
    document.querySelectorAll(".build-category").forEach(panel=>panel.classList.toggle("open",panel.dataset.category===category));
    document.querySelectorAll(".dock-tab").forEach(tab=>{const active=tab.dataset.category===category;tab.classList.toggle("on",active);tab.setAttribute("aria-expanded",active);});
  },
  upgradeMenuOpened(){renderUpgradeMenu();document.getElementById("upgradePanel").classList.remove("off");syncModalUi();},
  upgradeMenuClosed(){document.getElementById("upgradePanel").classList.add("off");syncModalUi();},
  phaseHudChanged(){syncPhaseHud();},
  // The panel's own class IS the modal flag, so the simulation asks rather than tracking a copy.
  isModalOpen(){return modalOpen();},
};
connectSimulation(SIM_EFFECTS);
// The scene asks the same question for one reason only: the idle cursor bracket must refuse to draw
// while a modal owns input. Injected rather than imported so no render module reaches into the UI.
connectScene({isModalOpen(){return modalOpen();}});

// ── Pointer data flow ──
// Written by: the handlers below, through setPointerWorld()/setPointerOutside().
// Read by:    the simulation's update() (collection, drop delivery) and the scene (hover feedback).
// Format:     world-space simulation pixels, produced by scene.js's groundFromEvent(), which
//             raycasts the ground plane — the 3D equivalent of the old inverse camera transform,
//             correct at any pitch/yaw.
function pointerPosition(event){
  const g=groundFromEvent(event);
  if(!g){setPointerOutside();return;}
  setPointerWorld(g.x,g.y);
}
canvas.addEventListener("wheel",event=>{
  event.preventDefault();
  // Zoom toward the cursor: remember the ground point, rescale, put it back. placeCamera() has to
  // run between the two reads, or the second raycast would still use the old projection.
  const before=groundFromEvent(event);
  zoomCameraBy(Math.exp(-event.deltaY*.0015));
  placeCamera();
  const after=groundFromEvent(event);
  if(before&&after)offsetCamera(before.x-after.x,before.y-after.y);
  clampCamera();placeCamera();pointerPosition(event);syncViewInputs();
},{passive:false});
canvas.addEventListener("pointermove",event=>{
  if(state.camera.panning){
    // Drag keeps the grabbed ground point pinned under the cursor.
    const g=groundFromEvent(event);
    if(g){dragCameraTo(g.x,g.y);placeCamera();}
  }
  pointerPosition(event);
});
canvas.addEventListener("pointerleave",()=>setPointerOutside());
canvas.addEventListener("contextmenu",event=>event.preventDefault());
canvas.addEventListener("auxclick",event=>event.preventDefault());
canvas.addEventListener("pointerdown",event=>{
  pointerPosition(event);
  if(event.button===1){event.preventDefault();const g=groundFromEvent(event);beginCameraPan(g?g.x:state.camera.x,g?g.y:state.camera.y);canvas.setPointerCapture(event.pointerId);return;}
  if(state.gameOver||state.paused||modalOpen())return;
  if(event.button===0)primaryPress();
  if(event.button===2)secondaryPress();
});
// Window-level release prevents collection or camera drag getting stuck outside the canvas.
window.addEventListener("pointerup",event=>{if(event.button===0)primaryRelease();if(event.button===2)secondaryRelease();if(event.button===1)endCameraPan();});
window.addEventListener("pointercancel",()=>pointerCancelled());
window.addEventListener("blur",()=>windowBlurred());
window.addEventListener("keydown",event=>{
  if(event.code==="Escape"){event.preventDefault();if(!event.repeat){if(closeUpgradeMenu())return;if(cancelBuildMode())return;togglePause();}return;}
  if(["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowLeft","ArrowDown","ArrowRight"].includes(event.code)){event.preventDefault();pressKey(event.code);}
});
window.addEventListener("keyup",event=>releaseKey(event.code));

function upgradePanelOpen(){return !document.getElementById("upgradePanel").classList.contains("off");}
// The upgrade panel is the only modal left; the old debug modal is gone, and the view
// debugger is a non-modal side panel that deliberately does NOT suppress gameplay input.
function modalOpen(){return upgradePanelOpen();}
function syncModalUi(){document.getElementById("game").classList.toggle("modal-open",modalOpen());}
// Pure presentation of state.upgradeMenu, which the simulation owns. Selecting an option is a
// command (selectUpgrade); this only re-reads and repaints.
function renderUpgradeMenu(){
  const menu=state.upgradeMenu,building=menu.building,list=upgradeList(menu.kind),options=document.getElementById("upgradeOptions"),detail=document.getElementById("upgradeDetail"),towerMenu=menu.kind==="tower";
  document.getElementById("upgradeTitle").textContent=towerMenu?"choose one permanent tower variant":menu.kind+" upgrades";options.replaceChildren();
  if(towerMenu)for(const variant of list){
    const button=document.createElement("button");button.className="variant-card";button.classList.toggle("on",menu.selected===variant.id);button.title=variant.family+" · "+variant.attackMode+" · "+variant.description;button.innerHTML="<b>"+variant.icon+"</b>"+variant.name;button.addEventListener("click",()=>{selectUpgrade(variant.id);renderUpgradeMenu();});options.appendChild(button);
  }else for(const upgrade of list){
    const button=document.createElement("button");button.classList.toggle("on",menu.selected===upgrade.id);button.classList.toggle("owned",!!building.upgrades[upgrade.id]);button.innerHTML="<b>"+upgrade.icon+"</b>"+upgrade.name+(building.upgrades[upgrade.id]?" · done":"");button.addEventListener("click",()=>{if(building.upgrades[upgrade.id])return;selectUpgrade(upgrade.id);renderUpgradeMenu();});options.appendChild(button);
  }
  const selected=list.find(item=>item.id===menu.selected);detail.innerHTML=selected?"<b>"+(towerMenu?selected.icon+" ":"")+selected.name+"</b>"+(towerMenu?"<div class=\"detail-meta\">"+selected.family+" · "+selected.attackMode+"</div>":"")+selected.description+"<br>cost: "+costText(selected.cost):"all upgrades complete";
}
document.getElementById("upgradeDecline").addEventListener("click",closeUpgradeMenu);
document.getElementById("upgradeAccept").addEventListener("click",()=>{acceptUpgrade();});

document.querySelectorAll(".dock-tab").forEach(tab=>tab.addEventListener("click",()=>setBuildDockCategory(state.buildDockCategory===tab.dataset.category?null:tab.dataset.category)));
// Toasts occupy the notification lane immediately above the dock in both collapsed and expanded states.
const buildDock=document.getElementById("buildDock"),stage=document.getElementById("stage");
new ResizeObserver(()=>stage.style.setProperty("--build-dock-clearance",buildDock.offsetHeight+"px")).observe(buildDock);
document.querySelectorAll("button.build").forEach(button=>button.addEventListener("click",()=>toggleBuildMode(button.dataset.kind)));

// Whole seconds as M:SS, rolling over to H:MM:SS only once a run passes an hour — so the common
// case stays as short as the phase countdown beside it and a long run never silently wraps.
function formatDuration(totalSeconds){
  const s=Math.max(0,Math.floor(totalSeconds)),hours=Math.floor(s/3600),minutes=Math.floor(s/60)%60;
  const pad=n=>String(n).padStart(2,"0");
  return hours?hours+":"+pad(minutes)+":"+pad(s%60):minutes+":"+pad(s%60);
}
function syncPhaseHud(){
  const clock=state.clock,wave=state.nightWave,isDay=clock.phase==="day",duration=isDay?DAY_DURATION:NIGHT_DURATION;
  const recipeState=isDay?wave.upcomingRecipe:wave.activeRecipe,recipe=NIGHT_WAVE_RECIPES.find(item=>item.id===recipeState?.id),side=isDay?wave.upcomingSide:wave.activeSide;
  const secondary=recipe?.id==="twoFront"?(isDay?oppositeMapSide(side):wave.secondarySide):null,panel=document.getElementById("phaseHud");
  const setText=(id,text)=>{const element=document.getElementById(id);if(element.textContent!==text)element.textContent=text;};
  const seconds=Math.max(0,Math.ceil(clock.remaining)),phaseNumber=isDay?clock.completedNights+1:wave.nightNumber;
  setText("phaseName",clock.phase+" "+phaseNumber);setText("phaseTime",Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0"));
  setText("runTime",formatDuration(clock.elapsed));
  panel.classList.toggle("night",!isDay);
  document.getElementById("phaseProgressFill").style.width=(100*clamp((duration-clock.remaining)/duration,0,1)).toFixed(2)+"%";
  setText("forecastLabel",isDay?"next attack":"current wave");setText("forecastRemaining",isDay?"":wave.remainingSpawns+" scheduled spawns remaining");
  const signature=[clock.phase,recipe?.id,side,secondary].join("|");
  if(panel.dataset.forecast!==signature){
    panel.dataset.forecast=signature;
    const arrows={north:"↑",east:"→",south:"↓",west:"←"};
    setText("forecastSides",side?(arrows[side]+" "+side+(secondary?" · "+arrows[secondary]+" "+secondary:"")):"no attack scheduled");
    const summary=document.getElementById("recipeSummary");summary.replaceChildren();
    if(recipe){const counts={};for(const spawn of recipe.spawns)counts[spawn[0]]=(counts[spawn[0]]||0)+1;for(const [type,count] of Object.entries(counts)){const item=document.createElement("li");item.textContent=count+"× "+type;summary.appendChild(item);}}
  }
}

function syncBuildHud(){
  document.querySelectorAll("button.build").forEach(button=>button.classList.toggle("on",button.dataset.kind===state.buildMode));
  for(const [kind,label] of [["spikes","spikeStack"],["landmine","landmineStack"],["tar","tarStack"]]){
    const unavailable=!DBG.unlimitedCharges&&state.buildStacks[kind]<=0,button=document.querySelector('button.build[data-kind="'+kind+'"]');
    document.getElementById(label).textContent="free · "+(DBG.unlimitedCharges?"∞":state.buildStacks[kind]+" left");button.disabled=unavailable;
  }
  const houseCost=nextHouseCost();document.getElementById("houseCost").textContent=houseCost.wood+"w · "+houseCost.stone+"s";
  canvas.classList.toggle("building",state.buildMode);
}
function updatePrompt(){
  const box=document.getElementById("prompt"),label=box.querySelector("span"),target=hoverTarget();
  box.classList.toggle("on",!!target);
  if(target)label.textContent=target.kind==="base"?"deposit at base":target.kind==="stockpile"?"store in stockpile":target.kind==="upgrade"?"deposit toward upgrade":"deliver to blueprint";
}
document.getElementById("restart").addEventListener("click",()=>location.reload());

let audio=null;
function sound(freq,duration){
  try{audio=audio||new(window.AudioContext||window.webkitAudioContext)();const o=audio.createOscillator(),g=audio.createGain();o.type="square";o.frequency.value=freq;g.gain.setValueAtTime(.035,audio.currentTime);g.gain.exponentialRampToValueAtTime(.0001,audio.currentTime+duration);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+duration);}catch(_){ }
}

// ─────────────────────────────────────────────────────────── frame
// The composition point for the render layer, in the order the single-file draw() ran:
// scene sync, then the throttled visibility measurement (it adds occlusion pins to the scene, so it
// must land before the draw call), then the draw call, then the 2D overlay on top.
function draw(){
  if(drawScene()) syncViewInputs();   // orbit advanced the yaw; push it back into the slider
  // Visibility stat + occluded pins. Throttled: it raycasts every clickable thing.
  if(++frameTick % 15 === 0) measureNow();
  renderScene();
  drawOverlay();
  if(scanPending){ scanPending=false; runScan(); }
}
let frameTick = 0;


// ═══════════════════════════════════════════════════════════════════════════
// VIEW DEBUGGER
// Ported from prototype-3d. Tabs are generated from the panes, so adding a
// section means adding a <section class="pane" data-tab="..."> and nothing else.
//
// Tab ownership (same order as the panes, and as the binding groups below):
//   camera / visibility / input / overlays / selectors — view + presentation only.
//   gameplay — the deliberate exception: it drives the simulation. Its switches
//              write DBG (see that object's rule: never authored data) and its
//              buttons call the same entry points play does. Its bindings are the
//              last group in this file, under the GAMEPLAY PANE banner.
// bindV() covers range / checkbox / select; bindBtn() covers plain buttons.
//
// Every value a binding writes is either a property on a mutable holder exported by a render module
// (view, VIEW_TUNE, IND, BARS, BADGE) or a setter that module exposes (setOrthoCamera, setShadows,
// setOutlines, setSelectorPreview). None of them is a bare imported binding: those are read-only,
// and assigning to one throws.
// ═══════════════════════════════════════════════════════════════════════════

const $v = id => document.getElementById(id);
let scanData = [], scanTimer = 0, scanPending = false;

const vPanes = [...document.querySelectorAll("#vPanes .pane")];
function showVTab(name){
  for(const p of vPanes) p.classList.toggle("on", p.dataset.tab===name);
  for(const b of $v("vTabs").children) b.classList.toggle("on", b.dataset.tab===name);
  $v("vPanes").scrollTop = 0;
  try{ localStorage.setItem("wd3d.tab", name); }catch{}
}
vPanes.forEach((p,i)=>{
  const b = document.createElement("button");
  b.textContent = p.dataset.tab; b.dataset.tab = p.dataset.tab; b.title = "shift+"+(i+1);
  b.addEventListener("click", ()=>showVTab(p.dataset.tab));
  $v("vTabs").appendChild(b);
});
(function initTab(){
  // A stored name from an older layout (sightlines/pickup/bars) no longer
  // matches a pane, so fall back to camera — the first pane, by design.
  let first = vPanes.some(p=>p.dataset.tab==="camera") ? "camera" : vPanes[0]?.dataset.tab;
  try{ const s = localStorage.getItem("wd3d.tab"); if(vPanes.some(p=>p.dataset.tab===s)) first = s; }catch{}
  showVTab(first);
})();

$v("vToggle").addEventListener("click", ()=>{
  const on = $v("viewPanel").classList.toggle("collapsed");
  $v("vToggle").textContent = on ? "view ▸" : "view ▾";
});

// Binds one control to one presentation field. Three control shapes: range (numeric), checkbox
// (boolean) and <select> (numeric, from the option's value — so `apply` always sees a number and
// callers never branch on the widget). The o_<id> readout span is optional; a <select> already shows
// its own label, so those omit it.
function bindV(id, apply, fmt){
  const el = $v(id), out = $v("o_"+id), select = el.tagName === "SELECT";
  // Browsers restore form-control values across a reload, so a slider left at
  // some test value keeps applying it while the markup still reads its default.
  // Markup wins on load; that is the only way these stay predictable.
  if(el.type === "checkbox") el.checked = el.hasAttribute("checked");
  // Same rule for a <select>: the option carrying the `selected` attribute wins over whatever the
  // browser restored, and with none marked the first option is the default.
  else if(select) el.selectedIndex = Math.max(0, [...el.options].findIndex(o=>o.hasAttribute("selected")));
  else if(el.hasAttribute("value")) el.value = el.getAttribute("value");
  const run = ()=>{
    const v = el.type==="checkbox" ? el.checked : +el.value;
    apply(v);
    if(out) out.textContent = fmt ? fmt(v) : v;
  };
  el.addEventListener(el.type==="checkbox"||select ? "change" : "input", run);
  run();
}

bindV("vPitch", v=>{ view.pitch=v; placeCamera(); drawScan(); updateReadout(); }, v=>v+"°");
bindV("vYaw",   v=>{ view.yaw=v; placeCamera(); scheduleScan(); updateReadout(); }, v=>v+"°");
bindV("vZoom",  v=>{ setCameraZoom(v); placeCamera(); updateReadout(); }, v=>v.toFixed(2));
bindV("vFov",   v=>{ view.fov=v; placeCamera(); updateReadout(); }, v=>v+"°");
bindV("vOrtho", v=>{ setOrthoCamera(v); resizeView(); scheduleScan(); updateReadout(); });
bindV("vOrbit", v=>{ view.orbit=v; });
bindV("vHeight",v=>{ view.heightScale=v; scheduleScan(); updateReadout(); }, v=>v+"%");
bindV("vShadow",v=>{ setShadows(v); });
bindV("vPins",  v=>{ view.ghostPins=v; });

// ── pickup / harvest: these drive real simulation constants, not just visuals ──
bindV("vCap",   v=>{ setCapacity(v); },        v=>v);
bindV("vRadius",v=>{ TUNE.vacuumRadius=v; },   v=>v+"px");
bindV("vRate",  v=>{ TUNE.suckRate=v/1000; },  v=>v+"ms");
bindV("vArc",   v=>{ VIEW_TUNE.handArc=v; },   v=>v.toFixed(1));
bindV("vRing",  v=>{ VIEW_TUNE.showVacuumRing=v; });
bindV("vChopT", v=>{ TUNE.chopTime=v/1000; },  v=>(v/1000).toFixed(2)+"s");
bindV("vShotSpeed", v=>{ VIEW_TUNE.shotSpeed=v; }, v=>v+" u/s");
bindV("vShotArc",   v=>{ VIEW_TUNE.shotArc=v; },   v=>v.toFixed(1)+"x");
bindV("vShotSize",  v=>{ VIEW_TUNE.shotSize=v; },  v=>v.toFixed(1)+"x");
bindV("vOutline",   v=>{ setOutlines(v); });
bindV("vOutlineW",  v=>{ outlineMat.uniforms.thickness.value=v; }, v=>v.toFixed(3));
// ── ground selectors: presentation only, see the IND block in src/render/scene.js ──
// Owned by the `selectors` pane (see the tab-ownership list above #vPanes; this block and that pane
// are the two halves of the same concern and nothing else should write IND).
// These write IND fields and nothing else. Footprints (buildingFootprint) and gameplay radii
// (indicatorRadius) are read from the simulation on the frame they are drawn and are never touched
// here, so no slider position can change where a building lands or how far a tower shoots.
bindV("vSelPulse",   v=>{ IND.pulseAmt=v; },    v=>v.toFixed(3));
bindV("vSelSpeed",   v=>{ IND.pulseSpeed=v; },  v=>v.toFixed(1)+" rad/s");
bindV("vSelThick",   v=>{ IND.thick=v; },       v=>v.toFixed(2));
bindV("vSelOpacity", v=>{ IND.cornerOpacity=v; }, v=>v.toFixed(2));
bindV("vRingOpacity",v=>{ IND.ringOpacity=v; }, v=>v.toFixed(2));
bindV("vSelFollow",  v=>{ IND.follow=v; },      v=>v>=1?"snap":v.toFixed(2));
// The one control here that is not a style knob: it draws sample marks (drawSelectorPreview) instead
// of restyling the live ones, and it stays render-only — see the comment on that function.
bindV("vSelPreview", v=>{ setSelectorPreview(v); });

bindV("vYield", v=>{ TUNE.chopYield=v; },      v=>v+"x");
bindV("vDamage",v=>{ TUNE.clickDamage=v; },    v=>v+" hp");

// ── overlay bar sizing / placement ──
bindV("vBarScale",v=>{ BARS.scale=v; });
bindV("vBarMin",  v=>{ BARS.minScale=v; }, v=>v.toFixed(2)+"x");
bindV("vBarMax",  v=>{ BARS.maxScale=v; }, v=>v.toFixed(1)+"x");
bindV("vBarW",    v=>{ BARS.wMul=v; },     v=>v.toFixed(2)+"x");
bindV("vBarH",    v=>{ BARS.h=v; },        v=>v.toFixed(1)+"px");
bindV("vBarGap",  v=>{ BARS.gap=v; },      v=>v.toFixed(1)+"px");
bindV("vBarPadX", v=>{ BARS.padX=v; },     v=>v.toFixed(1)+"px");
bindV("vBarPadY", v=>{ BARS.padY=v; },     v=>v.toFixed(1)+"px");
bindV("vBarLift", v=>{ BARS.lift=v; },     v=>v.toFixed(2)+"x");
bindV("vBarText", v=>{ BARS.text=v; },     v=>v.toFixed(1)+"px");
bindV("vTextMin", v=>{ BARS.textMin=v; },  v=>v.toFixed(1)+"px");
bindV("vTextMax", v=>{ BARS.textMax=v; },  v=>v.toFixed(1)+"px");

// ── action badge: presentation only, drawn from the same barScale() as above ──
// Ranges are clamped in the markup so the badge stays legible, stays translucent
// enough to read the silhouette through, and stays pinned to its target.
bindV("vBadgeBox",  v=>{ BADGE.box=v; BADGE.icon=v*BADGE_ICON_RATIO; }, v=>v+"px");
bindV("vBadgeDrop", v=>{ BADGE.drop=v; },                              v=>v+"px");
bindV("vBadgeFill", v=>{ BADGE.fill="rgba("+BADGE.fillRGB+","+v+")"; }, v=>v.toFixed(2));

// ═══════════════════════════════════════════════════════════════════════════
// GAMEPLAY PANE
// The one pane whose controls reach into the simulation instead of a
// presentation bag. Every switch here writes a DBG field and nothing else;
// every button calls a debug COMMAND exported by simulation.js, and each of
// those goes through a normal gameplay entry point (completeBuilding,
// applyFinishedUpgrade, transitionPhase, spawnEnemy...) rather than poking
// state. The command bodies live next to the gameplay they exercise, in
// simulation.js; only the bindings are here.
// NOTHING in this block may mutate authored data: BUILDING_TYPES / UPGRADES /
// TOWER_VARIANTS costs and stats, ENEMY_TYPES, and NIGHT_WAVE_RECIPES are read
// only. The grant buttons are the sole writers of state.stored, and the free
// costs toggle deliberately is not one of them.
// ═══════════════════════════════════════════════════════════════════════════

/** Buttons, the shape bindV() does not cover (no value, no readout span). */
function bindBtn(id, fn){ $v(id).addEventListener("click", fn); }

/** Fill a <select> from data so the options can never drift from the tables. */
function fillSelect(id, items){
  $v(id).replaceChildren(...items.map(([value,label])=>{
    const o=document.createElement("option"); o.value=value; o.textContent=label; return o;
  }));
}


fillSelect("vEnemyType", Object.entries(ENEMY_TYPES).map(([id,def])=>[id,def.name]));
fillSelect("vWaveRecipe", NIGHT_WAVE_RECIPES.map(recipe=>[recipe.id,recipe.id]));

// economy — free costs bypasses the DELIVERY, it does not zero a cost or top up a store.
bindV("vFreeCosts", v=>{ DBG.freeCosts=v; debugSweepFreeCosts(); });
bindV("vUnlimitedCharges", v=>{ DBG.unlimitedCharges=v; syncBuildHud(); });
bindBtn("vGrantAll",     ()=>debugGrant(RESOURCE_KINDS));
bindBtn("vGrantDust",    ()=>debugGrant(["dust"]));
bindBtn("vGrantCoin",    ()=>debugGrant(["coin"]));
bindBtn("vGrantDiamond", ()=>debugGrant(["diamond"]));

// time — game speed moved here from the input pane; id, range, default, format unchanged.
bindV("vSpeed", v=>{ TUNE.gameSpeed=v; },      v=>v+"x");
bindBtn("vStartDay",     ()=>debugGoToPhase("day"));
bindBtn("vStartNight",   ()=>debugGoToPhase("night"));
bindBtn("vAdvancePhase", debugAdvancePhase);

// combat — spawnEnemy() carries no phase guard of its own (night-only spawning lives in
// the sim loop's updateNightEnemyWave), so a debug spawn needs no bypass; it is a direct
// call with a random edge, exactly like the daytime spawner used to make.
bindBtn("vSpawnEnemy",   ()=>spawnEnemy(null,$v("vEnemyType").value));
bindBtn("vStartWave",    ()=>debugStartWave($v("vWaveRecipe").value));
bindBtn("vClearEnemies", debugClearEnemies);
bindV("vInvulnBase", v=>{ DBG.invulnBase=v; });

// population
bindV("vInstantWorkers", v=>{ DBG.instantWorkers=v; });
bindBtn("vHealAll", debugHealAll);

$v("vRescan").addEventListener("click", ()=>runScan());

/** Push programmatic camera changes (orbit, wheel zoom) back into the sliders. */
function syncViewInputs(){
  $v("vYaw").value = Math.round(view.yaw);  $v("o_vYaw").textContent = Math.round(view.yaw)+"°";
  $v("vZoom").value = state.camera.zoom;    $v("o_vZoom").textContent = state.camera.zoom.toFixed(2);
}

// ─────────────────────────────────────────────── visibility measurement
// The scene half — who the subjects are, which meshes block, and the raycast itself — lives in
// src/render/scene.js, next to the scene graph and the camera it needs. Everything here is the
// debugger's own readouts and its pitch sweep.

function measureNow(){
  const r = countVisible(scanSubjects(), scanBlockers());
  setPins(r.hidden);
  const pct = r.total ? Math.round(r.vis/r.total*100) : 100;
  $v("vStat").textContent = r.vis+"/"+r.total;
  const w = $v("vWarn");
  w.textContent = pct>=95 ? "✓" : "⚠ "+(100-pct)+"% hidden";
  w.className = pct>=95 ? "ok" : "warn";
}

function runScan(){
  updateWorldMatrices();
  const list = scanSubjects(), blockers = scanBlockers(), saved = view.pitch;
  scanData = [];
  for(let p=15;p<=89;p+=3){
    view.pitch = p; placeCamera();
    const r = countVisible(list, blockers);
    scanData.push({p, pct: r.total ? r.vis/r.total : 1});
  }
  view.pitch = saved; placeCamera();
  drawScan(); updateReadout(); measureNow();
}
function scheduleScan(){ clearTimeout(scanTimer); scanTimer = setTimeout(()=>{scanPending=true;}, 260); }

function drawScan(){
  const c = $v("vScan"), g = c.getContext("2d"), Wd = c.width, Hd = c.height;
  const pad = 8, floor = Hd - pad - 16;
  g.clearRect(0,0,Wd,Hd);
  if(!scanData.length)return;
  const bw = (Wd-pad*2)/scanData.length;
  g.strokeStyle="#7d7458"; g.lineWidth=1;
  for(const f of [0,.5]){ const y = pad+(floor-pad)*f; g.beginPath(); g.moveTo(pad,y); g.lineTo(Wd-pad,y); g.stroke(); }
  scanData.forEach((d,i)=>{
    const h = (floor-pad)*d.pct;
    g.fillStyle = d.pct>=.999 ? "#6fa04f" : d.pct>=.92 ? "#d4a443" : "#c25a44";
    g.fillRect(pad+i*bw, floor-h, Math.max(bw-1.5,1), h);
  });
  const mx = pad + ((view.pitch-15)/3)*bw + bw/2;
  g.strokeStyle="#f1dfb7"; g.lineWidth=2;
  g.beginPath(); g.moveTo(mx,2); g.lineTo(mx,floor); g.stroke();
  g.fillStyle="#b3a684"; g.font="700 15px monospace"; g.textBaseline="top";
  g.fillText("15°",pad,floor+4);
  g.textAlign="right"; g.fillText("89°",Wd-pad,floor+4);
  g.textAlign="center"; g.fillStyle="#f1dfb7";
  g.fillText(Math.round(view.pitch)+"°", Math.min(Math.max(mx,30),Wd-34), floor+4);
  g.textAlign="left";
}
function updateReadout(){
  const clean = scanData.find(d=>d.pct>=.999);
  const here = scanData.find(d=>d.p>=view.pitch);
  $v("vReadout").textContent =
    "pitch  "+Math.round(view.pitch)+"°    yaw "+Math.round(view.yaw)+"°\n"+
    "zoom   "+state.camera.zoom.toFixed(2)+"   "+(view.ortho?"orthographic":"fov "+view.fov+"°")+"\n"+
    "height "+view.heightScale+"%"+(here?"   visible "+Math.round(here.pct*100)+"%":"")+"\n"+
    (clean ? "clean from "+clean.p+"° up" : "never fully clean");
}

// shift+digit switches tabs; plain digits stay free for the game.
addEventListener("keydown", e=>{
  if(!e.shiftKey)return;
  const n = "!@#$%^&*("./* shifted digits */indexOf(e.key);
  if(n>=0 && vPanes[n]){ showVTab(vPanes[n].dataset.tab); e.preventDefault(); }
});

// measureNow() is driven from draw() so the pins track moving things.
$v("vRestart").addEventListener("click", ()=>location.reload());
requestAnimationFrame(()=>{ resizeView(); runScan(); });


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
