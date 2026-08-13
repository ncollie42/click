// Owns: the "view" side panel — its tabs, its ~60 control bindings, the sightline scan and its
// readouts. Owns no gameplay state and no meshes; it only writes the holders other modules expose.
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
// Ownership / data flow
//   Reads:    `state` and `view` for the two readouts that mirror live camera values, plus the
//             authored tables (ENEMY_TYPES, NIGHT_WAVE_RECIPES, RESOURCE_KINDS) the selects and
//             grant buttons are filled from. All read-only: nothing here may mutate authored data.
//   Writes:   every value a binding writes is either a property on a mutable holder exported by a
//             render module (view, VIEW_TUNE, IND, BARS, BADGE), a property on the simulation's
//             tunable holders (TUNE, DBG), or a setter a module exposes (setOrthoCamera,
//             setShadows, setOutlines, setSelectorPreview, setCapacity, setPins). None of them is a
//             bare imported binding: those are read-only, and assigning to one throws.
//   Asks:     syncBuildHud() from src/ui/hud.js, after flipping DBG.unlimitedCharges — the dock
//             prints charge counts, so the switch has to repaint it. The dependency runs
//             debugger -> hud and never back.
//             HOOKS.resizeView() — injected by main.js. Toggling the orthographic camera needs the
//             ONE resize path (scene first, then the overlay with the same box), and main.js owns
//             that composition; re-deriving it here would fork the invariant.
//   Supplies: syncViewInputs() — push programmatic camera changes back into the sliders. Called by
//             main.js's frame (auto-orbit advanced the yaw) and, through main.js's hook wiring, by
//             src/input.js's wheel handler.
//             tickVisibility() / drainScans() — the two per-frame taps main.js's draw() makes. The
//             counters behind them (frameTick, scanPending, scanTimer, scanData) are module-private
//             on purpose: an imported binding cannot be reassigned by its importer.
//
// localStorage: one key, "wd3d.tab", the selected pane. Nothing else here persists.
// ═══════════════════════════════════════════════════════════════════════════
import {
  RESOURCE_KINDS,
  ENEMY_TYPES,
  NIGHT_WAVE_RECIPES
} from "../game/data.js";
import {
  TUNE, DBG, state,
  setCameraZoom, setCapacity, openSkillTree,
  // debug entry points (view panel > gameplay)
  spawnEnemy, debugGrant, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase,
  debugStartWave, debugClearEnemies, debugHealAll
} from "../game/simulation.js";
import {
  view, VIEW_TUNE, IND,
  placeCamera, setOrthoCamera, setShadows, setSelectorPreview,
  setPins, scanSubjects, scanBlockers, countVisible, updateWorldMatrices
} from "../render/scene.js";
import {setOutlines, outlineMat} from "../render/models.js";
import {BARS, BADGE, BADGE_ICON_RATIO} from "../render/overlay.js";
import {syncBuildHud} from "../ui/hud.js";

// ── host hooks ──────────────────────────────────────────────────────────────
// Same shape as the simulation's connect(effects): named sinks, filled in wholesale at boot.
const HOOKS = {
  resizeView(){},
};

const $v = id => document.getElementById(id);

// Module-private orchestration state. None of it is exported: an importer cannot reassign an
// imported binding, so every one of these would have to become a holder the moment it left.
let scanData = [], scanTimer = 0, scanPending = false, frameTick = 0;
let vPanes = [];

// ── tabs ────────────────────────────────────────────────────────────────────
function showVTab(name){
  for(const p of vPanes) p.classList.toggle("on", p.dataset.tab===name);
  for(const b of $v("vTabs").children) b.classList.toggle("on", b.dataset.tab===name);
  $v("vPanes").scrollTop = 0;
  try{ localStorage.setItem("wd3d.tab", name); }catch{}
}
function buildTabs(){
  vPanes = [...document.querySelectorAll("#vPanes .pane")];
  vPanes.forEach((p,i)=>{
    const b = document.createElement("button");
    b.textContent = p.dataset.tab; b.dataset.tab = p.dataset.tab; b.title = "shift+"+(i+1);
    b.addEventListener("click", ()=>showVTab(p.dataset.tab));
    $v("vTabs").appendChild(b);
  });
  // A stored name from an older layout (sightlines/pickup/bars) no longer
  // matches a pane, so fall back to camera — the first pane, by design.
  let first = vPanes.some(p=>p.dataset.tab==="camera") ? "camera" : vPanes[0]?.dataset.tab;
  try{ const s = localStorage.getItem("wd3d.tab"); if(vPanes.some(p=>p.dataset.tab===s)) first = s; }catch{}
  showVTab(first);
}

// ── control binding ─────────────────────────────────────────────────────────
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

/** Buttons, the shape bindV() does not cover (no value, no readout span). */
function bindBtn(id, fn){ $v(id).addEventListener("click", fn); }

/** Fill a <select> from data so the options can never drift from the tables. */
function fillSelect(id, items){
  $v(id).replaceChildren(...items.map(([value,label])=>{
    const o=document.createElement("option"); o.value=value; o.textContent=label; return o;
  }));
}

// ── the bindings ────────────────────────────────────────────────────────────
// One call per control, in pane order. Each bindV() applies its markup default the moment it is
// bound, so this list is also the boot sequence for every tunable the panel owns.
function bindControls(){
  bindV("vPitch", v=>{ view.pitch=v; placeCamera(); drawScan(); updateReadout(); }, v=>v+"°");
  bindV("vYaw",   v=>{ view.yaw=v; placeCamera(); scheduleScan(); updateReadout(); }, v=>v+"°");
  bindV("vZoom",  v=>{ setCameraZoom(v); placeCamera(); updateReadout(); }, v=>v.toFixed(2));
  bindV("vFov",   v=>{ view.fov=v; placeCamera(); updateReadout(); }, v=>v+"°");
  bindV("vOrtho", v=>{ setOrthoCamera(v); HOOKS.resizeView(); scheduleScan(); updateReadout(); });
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

  // ═════════════════════════════════════════════════════════════════════════
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
  // ═════════════════════════════════════════════════════════════════════════

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

  // combat — spawnEnemy() has no phase guard, so debugger spawns need no bypass.
  bindBtn("vSpawnEnemy",   ()=>spawnEnemy(null,$v("vEnemyType").value));
  bindBtn("vStartWave",    ()=>debugStartWave($v("vWaveRecipe").value));
  bindBtn("vClearEnemies", debugClearEnemies);
  bindV("vInvulnBase", v=>{ DBG.invulnBase=v; });

  // population
  bindV("vInstantWorkers", v=>{ DBG.instantWorkers=v; });
  bindBtn("vHealAll", debugHealAll);

  // skills — the ONLY way into the skill-tree screen for now; it has no production entry point
  // yet. Not a debug command: this is the same openSkillTree() a real trigger will call, and the
  // guards that keep two modals off screen at once live in it, not here.
  bindBtn("vOpenSkillTree", ()=>{ openSkillTree(); });
}

/** Push programmatic camera changes (orbit, wheel zoom) back into the sliders. */
export function syncViewInputs(){
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

// ── the two per-frame taps main.js's draw() makes ───────────────────────────
/**
 * Visibility stat + occluded pins, driven from draw() so the pins track moving things. Throttled:
 * it raycasts every clickable thing. Must land BEFORE the draw call — it adds pins to the scene.
 */
export function tickVisibility(){
  if(++frameTick % 15 === 0) measureNow();
}
/** Drain a scan a slider scheduled. Runs after the frame is on screen, never during it. */
export function drainScans(){
  if(scanPending){ scanPending=false; runScan(); }
}

// ── registration ────────────────────────────────────────────────────────────
// Every listener and binding this adapter owns, in one auditable list. Called once, by main.js,
// after initHud() (the `unlimited charges` binding repaints the dock) and after initInput() (whose
// keydown listener must stay ahead of the shift+digit handler below).
export function initViewDebugger(hooks={}){
  Object.assign(HOOKS, hooks);

  buildTabs();
  $v("vToggle").addEventListener("click", ()=>{
    const on = $v("viewPanel").classList.toggle("collapsed");
    $v("vToggle").textContent = on ? "view ▸" : "view ▾";
  });
  bindControls();
  $v("vRescan").addEventListener("click", ()=>runScan());

  // shift+digit switches tabs; plain digits stay free for the game. Silent while the skill tree is
  // up: it covers this panel, and the `inert` it hangs on the rest of the frame stops clicks and
  // focus but not a listener bound to `window`.
  window.addEventListener("keydown", e=>{
    if(!e.shiftKey||state.skillTree.open)return;
    const n = "!@#$%^&*("./* shifted digits */indexOf(e.key);
    if(n>=0 && vPanes[n]){ showVTab(vPanes[n].dataset.tab); e.preventDefault(); }
  });

  $v("vRestart").addEventListener("click", ()=>location.reload());
  // One warm-up frame: layout has settled, so the renderer can be re-measured through the host's
  // one resize path and the first sightline sweep has a real camera to sweep.
  requestAnimationFrame(()=>{ HOOKS.resizeView(); runScan(); });
}
