// Owns: the "view" side panel — its visibility, top-level/contextual tabs, ~60 control bindings,
// sightline scan/readouts, and footer utilities. Owns no gameplay state and no meshes; it only writes the
// holders other modules expose.
// ═══════════════════════════════════════════════════════════════════════════
// VIEW DEBUGGER
// Ported from prototype-3d. Top tabs come from .pane[data-tab]; crowded panes declare direct-child
// .vSubpane[data-subtab] groups, and this module generates their contextual navigation.
//
// Tab ownership (same order as the panes, and as the binding groups below):
//   camera / visibility / input / overlays / selectors — view + presentation only.
//   gameplay — the deliberate exception: it drives the simulation. Its switches
//              write DBG (see that object's rule: never authored data) and its
//              buttons call the same entry points play does. Its bindings are the
//              last control group in this file, under the GAMEPLAY PANE banner.
//   threat — live future-wave difficulty controls plus curve/timeline preview.
//   perf — frame-stage timings, scene/entity census, and explicit render-isolation controls.
// bindV() covers range / checkbox / select; bindBtn() covers plain buttons.
//
// Ownership / data flow
//   Reads:    `state` and `view` for the two readouts that mirror live camera values, plus the
//             authored tables (ENEMY_TYPES, NIGHT_WAVE_RECIPES, WAVE_THREAT_CURVE, RESOURCE_KINDS)
//             the selects, curve preview, and grant buttons read. Authored data remains immutable.
//   Writes:   every value a binding writes is either a property on a mutable holder exported by a
//             render module (view, VIEW_TUNE, IND, BARS, DAMAGE_TEXT, BADGE), a property on the simulation's
//             tunable holders (TUNE, DBG), or a setter a module exposes (setOrthoCamera,
//             setWaveThreatCurve, setShadows, setOutlines, setSelectorPreview, setCapacity, setPins).
//             None of them is a
//             bare imported binding: those are read-only, and assigning to one throws.
//   Asks:     HOOKS.resizeView() — injected by main.js. Toggling the orthographic camera needs the
//             ONE resize path (scene first, then the overlay with the same box), and main.js owns
//             that composition; re-deriving it here would fork the invariant.
//   Keeps:    authored normalized defaults for reportable bindV() controls, captured once while
//             those bindings initialize. The changed-values utility compares live controls to this
//             ordered snapshot; it never persists or reapplies values.
//   Supplies: syncViewInputs() — push programmatic camera changes back into the sliders. Called by
//             main.js's frame (auto-orbit advanced the yaw) and, through main.js's hook wiring, by
//             src/input.js's wheel handler.
//             tickVisibility() / drainScans() — the two per-frame taps main.js's draw() makes.
//             tickPerformance() — receives each RAF timestamp after rendering; it owns the rolling
//             cadence window and reads renderer counters without affecting simulation timing.
//             All counters are module-private on purpose: an imported binding cannot be reassigned
//             by its importer.
//
// localStorage: "wd3d.tab" stores the selected top pane; "wd3d.subtabs" defensively stores one
// object mapping grouped pane names to their selected contextual subgroup. Footer utilities and
// control values persist nothing.
// ═══════════════════════════════════════════════════════════════════════════
import {
  RESOURCE_KINDS,
  ENEMY_TYPES,
  FOG,
  NIGHT_WAVE_RECIPES,
  WAVE_THREAT_CURVE,DAY_DURATION,NIGHT_WAVE_WINDOW
} from "../game/data.js";
// The card catalog, read for the dealer grid only: one chip per authored row, never a hand-picked
// subset, so a card added to the registry is dealable the day it lands. Read-only, like every other
// authored table this panel touches.
import {CARDS} from "../game/cards.js";
import {
  TUNE, DBG, state, xp, waveTier, waveThreatBudget, skillPoints, levelState, simulationEntityDiagnostics, buffStacks,
  setCameraZoom, setCapacity, openSkillTree, togglePause,
  // debug entry points (view panel > gameplay)
  spawnEnemy, debugGrant, debugGrantXp, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase,
  setWaveThreatCurve, debugStartWave, debugClearEnemies, debugHealAll, debugDealCard, debugApplyBuff, debugClearHand
} from "../game/simulation.js";
import {
  view, VIEW_TUNE, IND,
  placeCamera, setOrthoCamera, setShadows, setSelectorPreview,
  setPins, scanSubjects, scanBlockers, countVisible, updateWorldMatrices,
  terrainRenderDiagnostics, setWaterPrepass, setRenderPixelRatio
} from "../render/scene.js";
import {setOutlines, outlineMat} from "../render/models.js";
import {BARS, BADGE, BADGE_ICON_RATIO, DAMAGE_TEXT} from "../render/overlay.js";

// ── host hooks ──────────────────────────────────────────────────────────────
// Same shape as the simulation's connect(effects): named sinks, filled in wholesale at boot.
const HOOKS = {
  resizeView(){},
};

const $v = id => document.getElementById(id);

// Module-private orchestration state. None of it is exported: an importer cannot reassign an
// imported binding, so every one of these would have to become a holder the moment it left.
let scanData = [], scanTimer = 0, scanPending = false, frameTick = 0, liveVisibility = false;
let perfFrames = [], perfSamples = [], perfLastReadout = 0;
let vPanes = [], subtabState = {};
const boundDefaults = new Map();

// ── tabs ────────────────────────────────────────────────────────────────────
function resetPaneScroll(){ $v("vPanes").scrollTop = 0; }
// Hide only the panel root. Descendant DOM and classes remain untouched, so restoring preserves the
// collapsed state, selected tabs, scroll position, controls, and readouts exactly as left.
function togglePanelVisibility(){
  const panel=$v("viewPanel");
  panel.hidden=!panel.hidden;
}
function showVTab(name){
  for(const p of vPanes) p.classList.toggle("on", p.dataset.tab===name);
  for(const b of $v("vTabs").children) b.classList.toggle("on", b.dataset.tab===name);
  resetPaneScroll();
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

function saveSubtabs(){
  try{ localStorage.setItem("wd3d.subtabs", JSON.stringify(subtabState)); }catch{}
}
function showSubtab(pane, key, focus=false){
  const subpanes = [...pane.querySelectorAll(":scope > .vSubpane")];
  if(!subpanes.some(subpane=>subpane.dataset.subtab===key)) key = subpanes[0]?.dataset.subtab;
  if(!key)return;
  for(const subpane of subpanes) subpane.hidden = subpane.dataset.subtab!==key;
  const buttons = [...pane.querySelectorAll(":scope > .vSubTabs > button")];
  for(const button of buttons){
    const on = button.dataset.subtab===key;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
    if(on&&focus)button.focus();
  }
  subtabState[pane.dataset.tab] = key;
  saveSubtabs();
  resetPaneScroll();
}
function buildSubtabs(){
  try{
    const saved = JSON.parse(localStorage.getItem("wd3d.subtabs")||"{}");
    if(saved&&typeof saved==="object"&&!Array.isArray(saved)) subtabState = saved;
  }catch{ subtabState = {}; }

  for(const [paneIndex,pane] of vPanes.entries()){
    const subpanes = [...pane.querySelectorAll(":scope > .vSubpane")];
    if(!subpanes.length)continue;
    const nav = document.createElement("nav");
    nav.className = "vSubTabs";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", pane.dataset.tab+" sections");
    const buttons = subpanes.map((subpane,subpaneIndex)=>{
      const key = subpane.dataset.subtab;
      const button = document.createElement("button");
      const buttonId = `vSubtab-${paneIndex}-${subpaneIndex}`;
      const panelId = `vSubpane-${paneIndex}-${subpaneIndex}`;
      button.type = "button";
      button.id = buttonId;
      button.dataset.subtab = key;
      button.textContent = subpane.dataset.subtabLabel?.trim()||key;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", panelId);
      subpane.id = panelId;
      subpane.setAttribute("role", "tabpanel");
      subpane.setAttribute("aria-labelledby", buttonId);
      button.addEventListener("click", ()=>showSubtab(pane,key));
      nav.appendChild(button);
      return button;
    });
    nav.addEventListener("keydown", event=>{
      const current = buttons.indexOf(document.activeElement);
      if(current<0)return;
      let next;
      if(event.key==="ArrowLeft") next = (current-1+buttons.length)%buttons.length;
      else if(event.key==="ArrowRight") next = (current+1)%buttons.length;
      else if(event.key==="Home") next = 0;
      else if(event.key==="End") next = buttons.length-1;
      else return;
      event.preventDefault();
      showSubtab(pane,buttons[next].dataset.subtab,true);
    });
    pane.prepend(nav);
    const saved = subtabState[pane.dataset.tab];
    showSubtab(pane,subpanes.some(subpane=>subpane.dataset.subtab===saved) ? saved : subpanes[0].dataset.subtab);
  }
}

// ── control binding ─────────────────────────────────────────────────────────
// Binds one control to one presentation field. Values are normalized once for both `apply` and the
// changed-values snapshot: checkboxes stay boolean, numeric widgets/selects become numbers, and a
// non-numeric select stays a string. The o_<id> readout span is optional. `report=false` is reserved
// for transient action selectors whose selection is a command preview, not a tunable value.
function normalizedControlValue(el){
  if(el.type==="checkbox")return el.checked;
  const number = Number(el.value);
  return el.value!==""&&Number.isFinite(number) ? number : el.value;
}
function bindV(id, apply, fmt, report=true){
  const el = $v(id), out = $v("o_"+id), select = el.tagName === "SELECT";
  // Browsers restore form-control values across a reload, so a slider left at
  // some test value keeps applying it while the markup still reads its default.
  // Markup wins on load; that is the only way these stay predictable.
  if(el.type === "checkbox") el.checked = el.hasAttribute("checked");
  // Same rule for a <select>: the option carrying the `selected` attribute wins over whatever the
  // browser restored, and with none marked the first option is the default.
  else if(select) el.selectedIndex = Math.max(0, [...el.options].findIndex(o=>o.hasAttribute("selected")));
  else if(el.hasAttribute("value")) el.value = el.getAttribute("value");
  if(report) boundDefaults.set(id,{el,value:normalizedControlValue(el)});
  const run = ()=>{
    const v = normalizedControlValue(el);
    apply(v);
    if(out) out.textContent = fmt ? fmt(v) : v;
  };
  el.addEventListener(el.type==="checkbox"||select ? "change" : "input", run);
  run();
}

/** Buttons, the shape bindV() does not cover (no value, no readout span). */
function bindBtn(id, fn){ $v(id).addEventListener("click", fn); }

function changedValuesReport(){
  const lines = [];
  for(const [id,{el,value:authored}] of boundDefaults){
    const current = normalizedControlValue(el);
    if(!Object.is(current,authored)) lines.push(`${id}: ${current} (default ${authored})`);
  }
  return lines.join("\n")||"no changed values";
}
async function showChangedValues(){
  const report = changedValuesReport(), output = $v("vChangedOutput");
  output.value = report;
  output.hidden = false;
  try{ await navigator.clipboard.writeText(report); }catch{}
}
function openShowcase(){
  if(state.runMode==="showcase")return;
  const url = new URL(location.href);
  url.searchParams.set("mode","showcase");
  location.assign(url.href);
}
function syncShowcaseAction(){
  const button = $v("vShowcase"), active = state.runMode==="showcase";
  button.disabled = active;
  button.textContent = active ? "showcase active" : "open showcase";
}

/** Fill a <select> from data so the options can never drift from the tables. */
function fillSelect(id, items){
  $v(id).replaceChildren(...items.map(([value,label])=>{
    const o=document.createElement("option"); o.value=value; o.textContent=label; return o;
  }));
}

// ── the card dealer (gameplay > cards) ──────────────────────────────────────
// A chip per registry card, grouped by category in the registry's own order, labelled with the id
// because that is what the rest of the debugger speaks. Clicking a consumable/build calls
// debugDealCard() — the same command the ?draftDemo console helpers use — so a dealt card is an
// ordinary hand entry. Clicking an IMPLEMENTED buff calls debugApplyBuff(): one stack through the
// ordinary applyBuff() path, uncapped on purpose, with the chip repainting its ×stacks tally.
// (The tally repaints on click only, so it can go stale across a run reset — reopen to refresh.)
// Auras and unimplemented buffs are drawn (the grid is the whole catalog) but disabled.
const DEALER_GROUPS=[["build","builds"],["consumable","consumables"],["aura","auras"],["buff","buffs"]];
const DEALABLE=new Set(["consumable","build"]);
// ── threat-curve preview ────────────────────────────────────────────────────
// Earliest means every prior wave clears by the end of its 30-second spawn window. Real timestamps
// move later when enemies survive; this is a curve ruler, not a promise about combat duration.
function formatTimelineTime(totalSeconds){
  const seconds=Math.max(0,Math.round(totalSeconds)),minutes=Math.floor(seconds/60);
  return minutes+":"+String(seconds%60).padStart(2,"0");
}
function earliestWaveStart(wave){return DAY_DURATION+(wave-1)*(DAY_DURATION+NIGHT_WAVE_WINDOW);}
function drawThreatCurve(selectedWave){
  const canvas=$v("vThreatChart"),g=canvas.getContext("2d"),width=canvas.width,height=canvas.height,pad=10,maxWave=Number($v("vThreatWave").max);
  const budgets=Array.from({length:maxWave},(_,index)=>waveThreatBudget(index+1)),maxBudget=Math.max(...budgets);
  g.clearRect(0,0,width,height);g.strokeStyle="#4d573b";g.lineWidth=1;g.beginPath();g.moveTo(pad,height-pad);g.lineTo(width-pad,height-pad);g.lineTo(width-pad,pad);g.stroke();
  const point=wave=>({x:pad+(wave-1)/(maxWave-1)*(width-pad*2),y:height-pad-waveThreatBudget(wave)/maxBudget*(height-pad*2)});
  g.strokeStyle="#d4a443";g.lineWidth=2;g.beginPath();
  for(let wave=1;wave<=maxWave;wave++){const p=point(wave);if(wave===1)g.moveTo(p.x,p.y);else g.lineTo(p.x,p.y);}g.stroke();
  const selected=point(selectedWave);g.fillStyle="#fff1c7";g.beginPath();g.arc(selected.x,selected.y,3,0,Math.PI*2);g.fill();
}
function renderThreatPreview(wave){
  const threat=waveThreatBudget(wave),time=formatTimelineTime(earliestWaveStart(wave));
  $v("vThreatHeroWave").textContent=wave;
  $v("vThreatHeroBudget").textContent=threat;
  $v("vThreatHeroTime").textContent=time;
  const body=$v("vThreatGrid");body.replaceChildren();
  const rows=Math.max(30,WAVE_THREAT_CURVE.targetWave);
  for(let value=1;value<=rows;value++){
    const row=document.createElement("tr");if(value===wave)row.className="on";
    for(const text of [value,waveThreatBudget(value),formatTimelineTime(earliestWaveStart(value))]){const cell=document.createElement("td");cell.textContent=text;row.appendChild(cell);}
    body.appendChild(row);
  }
  drawThreatCurve(wave);
}
function tuneThreatCurve(patch){
  if(setWaveThreatCurve(patch))renderThreatPreview(Number($v("vThreatWave").value));
}
function describeThreatPower(value){return value.toFixed(2)+(Math.abs(value-1)<.001?" · linear":value>1?" · ease-in":" · front-loaded");}

function buildCardDealer(){
  const root=$v("vCardDealer");
  root.replaceChildren();
  for(const [category,label] of DEALER_GROUPS){
    const cards=CARDS.filter(card=>card.category===category);
    if(!cards.length)continue;
    const heading=document.createElement("h4");heading.textContent=label+" ("+cards.length+")";root.appendChild(heading);
    const grid=document.createElement("div");grid.className="vCardGrid";
    for(const card of cards){
      const chip=document.createElement("button");
      chip.type="button";chip.className="vCardChip r-"+card.rarity;chip.textContent=card.id;
      chip.title=card.rarity+" · "+card.text+(card.inPool?"":" · out of pool");
      if(!card.inPool)chip.classList.add("off-pool");
      if(DEALABLE.has(category))chip.addEventListener("click",()=>{debugDealCard(card.id);});
      else if(category==="buff"&&card.implemented){
        const paint=()=>{const stacks=buffStacks(card.id);chip.textContent=stacks>0?card.id+" ×"+stacks:card.id;};
        paint();
        chip.title=card.rarity+" · "+card.text+" · applies one stack now (debug stacks ignore the cap)";
        chip.addEventListener("click",()=>{if(debugApplyBuff(card.id))paint();});
      }
      else{chip.disabled=true;chip.title=card.rarity+" · "+card.text+(category==="buff"?" · not implemented yet":" · not holdable (applies on draft)");}
      grid.appendChild(chip);
    }
    root.appendChild(grid);
  }
}

// ── generated fog controls ──────────────────────────────────────────────────
// The only range controls this panel builds instead of reading from the markup, because their
// authored defaults come from FOG: the pop tween can be COMPRESSED but never stretched — the
// simulation splices a pop record out at age >= FOG.popAnimTime — so the duration slider's ceiling
// AND its default are that constant, and both must move with it if it is ever retuned.
// Shape is the panel's authored range markup exactly (label > .row > name + o_<id>, then the input),
// so bindV() binds these like any other slider, `value` attribute included.
function buildFogControls(){
  const root = document.querySelector('#vPanes .pane[data-tab="visibility"] .vSubpane[data-subtab="readability"]');
  const heading = document.createElement("h4"); heading.textContent = "fog"; root.appendChild(heading);
  const popMs = Math.round(FOG.popAnimTime*1000);
  const controls = [
    ["vFogHeight",  "block height", 40, 200,   5,  100,   ""],
    ["vFogPopTime", "pop duration", 80, popMs, 10, popMs, "capped at FOG.popAnimTime ("+popMs+"ms): the pop record is gone past that, so a longer tween would cut off mid-collapse"],
    ["vFogPopSwell","pop swell",    0,  100,   5,  35,    ""],
  ];
  for(const [id,name,min,max,step,value,title] of controls){
    const wrap=document.createElement("label"), row=document.createElement("span"),
          caption=document.createElement("span"), out=document.createElement("span"), input=document.createElement("input");
    row.className="row"; caption.textContent=name; out.id="o_"+id; row.append(caption,out);
    input.autocomplete="off"; input.type="range"; input.id=id;
    input.min=min; input.max=max; input.step=step;
    // bindV() reads the `value` ATTRIBUTE to beat the browser's form restore, so set it as one.
    input.setAttribute("value",value);
    if(title) wrap.title=title;
    wrap.append(row,input); root.appendChild(wrap);
  }
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
  bindV("vPins",  v=>{ view.ghostPins=v; if(!v)setPins([]); });
  bindV("vLiveVisibility",v=>{ liveVisibility=v; frameTick=0; if(!v)setPins([]); });
  // ── fog: presentation only. The knobs live on `view`; FOG stays authored data. ──
  bindV("vFogHeight",  v=>{ view.fogHeight=v; },   v=>v+"%");
  bindV("vFogPopTime", v=>{ view.fogPopTime=v; },  v=>v+"ms");
  bindV("vFogPopSwell",v=>{ view.fogPopSwell=v; }, v=>v+"%");

  // ── pickup / harvest: these drive real simulation constants, not just visuals ──
  bindV("vCap",   v=>{ setCapacity(v); },        v=>v);
  bindV("vRadius",v=>{ TUNE.vacuumRadius=v; },   v=>v+"px");
  bindV("vRate",  v=>{ TUNE.suckRate=v/1000; },  v=>v+"ms");
  bindV("vArc",   v=>{ VIEW_TUNE.handArc=v; },   v=>v.toFixed(1));
  bindV("vRing",  v=>{ VIEW_TUNE.showVacuumRing=v; });
  bindV("vChopT", v=>{ TUNE.chopTime=v/1000; },  v=>(v/1000).toFixed(2)+"s");
  bindV("vSnapR", v=>{ TUNE.snapRadius=v; },     v=>v+"px");
  bindV("vShotSpeed", v=>{ VIEW_TUNE.shotSpeed=v; }, v=>v+" u/s");
  bindV("vShotArc",   v=>{ VIEW_TUNE.shotArc=v; },   v=>v.toFixed(1)+"x");
  bindV("vShotSize",  v=>{ VIEW_TUNE.shotSize=v; },  v=>v.toFixed(1)+"x");
  bindV("vOutline",   v=>{ setOutlines(v); });
  bindV("vOutlineW",  v=>{ outlineMat.uniforms.thickness.value=v; }, v=>v.toFixed(3));
  bindV("vWaterPrepass",v=>{ setWaterPrepass(v); });
  // Unlike authored style controls, the initial ratio belongs to the current display. Seed the
  // range before bindV captures its baseline; moving it then deliberately overrides device DPR.
  $v("vPixelRatio").removeAttribute("value");
  $v("vPixelRatio").value=terrainRenderDiagnostics().pixelRatio;
  bindV("vPixelRatio",v=>{ setRenderPixelRatio(v); HOOKS.resizeView(); },v=>v.toFixed(2)+"x");
  bindBtn("vPerfPause",togglePause);
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
  bindV("vSelPreview", v=>{ setSelectorPreview(v); }, null, false);

  bindV("vYield", v=>{ TUNE.chopYield=v; },      v=>v+"x");
  bindV("vDamage",v=>{ TUNE.clickDamage=v; },    v=>v+" hp");

  // ── floating combat text: presentation only; hit creation and age stay in simulation.js ──
  bindV("vDamageText",    v=>{ DAMAGE_TEXT.enabled=v; });
  bindV("vDamageFadeIn",  v=>{ DAMAGE_TEXT.fadeIn=v; },       v=>v.toFixed(2)+"s");
  bindV("vDamageHold",    v=>{ DAMAGE_TEXT.hold=v; },         v=>v.toFixed(2)+"s");
  bindV("vDamageFadeOut", v=>{ DAMAGE_TEXT.fadeOut=v; },      v=>v.toFixed(2)+"s");
  bindV("vDamageRise",    v=>{ DAMAGE_TEXT.rise=v; },         v=>v+"px");
  bindV("vDamageSpread",  v=>{ DAMAGE_TEXT.spread=v; },       v=>v+"px");
  bindV("vDamageGrow",    v=>{ DAMAGE_TEXT.grow=v; },         v=>Math.round(v*100)+"%");
  bindV("vDamageSize",    v=>{ DAMAGE_TEXT.size=v; },         v=>v+"px");
  bindV("vDamageCrit",    v=>{ DAMAGE_TEXT.criticalScale=v; },v=>v.toFixed(2)+"x");

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

  // ── threat curve: future plans update live; wave preview itself is read-only ──
  bindV("vThreatStart", value=>tuneThreatCurve({startBudget:value}), value=>value+" threat");
  bindV("vThreatTarget", value=>tuneThreatCurve({targetBudget:value}), value=>value+" threat");
  bindV("vThreatTargetWave", value=>tuneThreatCurve({targetWave:value}), value=>"wave "+value);
  bindV("vThreatPower", value=>tuneThreatCurve({power:value}), describeThreatPower);
  bindV("vThreatWave", renderThreatPreview, null, false);

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
  bindV("vGroundSourcing", v => { DBG.groundSourcing = v; });
  bindV("vBuilderSelfSupply", v => { DBG.builderSelfSupply = v; });
  bindV("vBuilderRadius", v => { TUNE.builderSourceRadius = v; }, v => v + "px");
  bindV("vFreeSearchRadius", v => { TUNE.freeSearchRadius = v; }, v => v + "px");
  bindBtn("vGrantXp",      ()=>debugGrantXp(25));
  bindBtn("vGrantXpBig",   ()=>debugGrantXp(100));
  bindBtn("vGrantAll",     ()=>debugGrant(RESOURCE_KINDS));
  bindBtn("vGrantDust",    ()=>debugGrant(["dust"]));
  bindBtn("vGrantCoin",    ()=>debugGrant(["coin"]));
  bindBtn("vGrantDiamond", ()=>debugGrant(["diamond"]));

  // time — game speed moved here from the input pane; id, range, default, format unchanged.
  bindV("vSpeed", v=>{ TUNE.gameSpeed=v; },      v=>v+"x");
  bindBtn("vStartDay",     ()=>debugGoToPhase("day"));
  bindBtn("vStartNight",   ()=>debugGoToPhase("night"));
  bindBtn("vAdvancePhase", debugAdvancePhase);

  // combat — normal-mode spawnEnemy() has no phase guard; showcase intentionally no-ops to keep authored fixtures inert.
  bindBtn("vSpawnEnemy",   ()=>spawnEnemy($v("vEnemyType").value));
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

  // cards — the dealer grid is generated from the registry; only the two buttons are bound here.
  buildCardDealer();
  bindBtn("vClearHand", ()=>{ debugClearHand(); });
}

// Three different numbers on purpose: xp is everything ever fed, the level is what the draft rides
// on, and the wave tier is what the night reads off that level.
export function syncXpReadout(){
  const level=levelState();
  $v("vXpReadout").textContent="xp "+xp()+" · lv "+level.level+" ("+level.xp.toFixed(1)+"/"+level.next.toFixed(1)+") · tier "+waveTier()+" · "+skillPoints()+" points";
}
/** Push programmatic camera changes (orbit, wheel zoom) back into the sliders. */
export function syncViewInputs(){
  $v("vYaw").value = Math.round(view.yaw);  $v("o_vYaw").textContent = Math.round(view.yaw)+"°";
  $v("vZoom").value = state.camera.zoom;    $v("o_vZoom").textContent = state.camera.zoom.toFixed(2);
  syncXpReadout();
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

// ── per-frame taps owned by the debugger ───────────────────────────────────
/**
 * Visibility stat + occluded pins, driven from draw() so the pins track moving things. Throttled:
 * it raycasts every clickable thing. Must land BEFORE the draw call — it adds pins to the scene.
 */
export function tickVisibility(){
  if(liveVisibility&&++frameTick % 15 === 0) measureNow();
}
/** Drain a scan a slider scheduled. Runs after the frame is on screen, never during it. */
export function drainScans(){
  if(scanPending){ scanPending=false; runScan(); }
}

/**
 * Record browser-delivered RAF cadence, not simulation steps: game-speed runs multiple updates per
 * frame and must not inflate this number. DOM and renderer diagnostics refresh at 4 Hz; the frame
 * timestamps retain only the rolling one-second window.
 */
export function tickPerformance(now,timings){
  perfFrames.push(now);perfSamples.push({now,...timings});
  const cutoff=now-1000;
  while(perfFrames.length>1&&perfFrames[0]<cutoff)perfFrames.shift();
  while(perfSamples.length>1&&perfSamples[0].now<cutoff)perfSamples.shift();
  if(now-perfLastReadout<250)return;
  perfLastReadout=now;

  const intervals=[];
  for(let i=1;i<perfFrames.length;i++)intervals.push(perfFrames[i]-perfFrames[i-1]);
  if(intervals.length){
    const elapsed=perfFrames.at(-1)-perfFrames[0];
    const sorted=[...intervals].sort((a,b)=>a-b);
    const p95=sorted[Math.ceil(sorted.length*.95)-1];
    $v("vPerfFps").textContent=(intervals.length*1000/elapsed).toFixed(0);
    $v("vPerfAverage").textContent=(elapsed/intervals.length).toFixed(1)+" ms";
    $v("vPerfP95").textContent=p95.toFixed(1)+" ms";
  }
  const mean=key=>perfSamples.reduce((sum,sample)=>sum+(sample[key]||0),0)/perfSamples.length;
  for(const [id,key] of [["vPerfSimulation","simulationMs"],["vPerfSceneSync","sceneSyncMs"],
    ["vPerfVisibility","visibilityMs"],["vPerfRender","renderMs"],["vPerfUi","uiMs"],["vPerfWork","workMs"]])
    $v(id).textContent=mean(key).toFixed(2)+" ms";

  const entities=simulationEntityDiagnostics(),diagnostics=terrainRenderDiagnostics();
  $v("vPerfEntities").textContent=entities.total;
  $v("vPerfUnits").textContent=entities.workers+" / "+entities.enemies;
  $v("vPerfWorld").textContent=entities.buildings+" / "+entities.resourceNodes;
  $v("vPerfTransient").textContent=entities.drops+" / "+entities.transients;
  $v("vPerfSceneObjects").textContent=diagnostics.sceneObjects+" / "+diagnostics.meshes;
  $v("vPerfVisibleMeshes").textContent=diagnostics.visibleMeshes+" / "+diagnostics.shadowCasters;
  $v("vPerfMeshKinds").textContent=diagnostics.outlines+" / "+diagnostics.instancedMeshes;
  $v("vPerfDrawCalls").textContent=diagnostics.drawCalls.toLocaleString();
  $v("vPerfTriangles").textContent=diagnostics.triangles.toLocaleString();
  $v("vPerfGeometries").textContent=diagnostics.geometries+" / "+diagnostics.materials;
  $v("vPerfTextures").textContent=diagnostics.textures;
  $v("vPerfBuffer").textContent=diagnostics.bufferWidth+" × "+diagnostics.bufferHeight;
  $v("vPerfPauseState").textContent=state.paused?"paused":"running";
  $v("vPerfPause").textContent=state.paused?"resume simulation":"pause simulation";
  const memory=performance.memory;
  $v("vPerfHeap").textContent=memory?(memory.usedJSHeapSize/1048576).toFixed(1)+" / "+(memory.jsHeapSizeLimit/1048576).toFixed(0)+" MiB":"unsupported";
}

// ── registration ────────────────────────────────────────────────────────────
// Every listener and binding this adapter owns, in one auditable list. Called once, by main.js,
// after initHud() and after initInput() (whose keydown listener must stay ahead of the shift+digit
// handler below).
export function initViewDebugger(hooks={}){
  Object.assign(HOOKS, hooks);

  buildTabs();
  // Build and select every contextual group before controls apply their authored defaults; hidden
  // controls remain ordinary DOM controls and must initialize through the same binding path.
  buildSubtabs();
  // Generated controls must exist before bindControls(), which binds them by id like any other.
  buildFogControls();
  $v("vToggle").addEventListener("click", ()=>{
    const on = $v("viewPanel").classList.toggle("collapsed");
    $v("vToggle").textContent = on ? "view ▸" : "view ▾";
  });
  bindControls();
  $v("vRescan").addEventListener("click", ()=>runScan());
  $v("vShowcase").addEventListener("click", openShowcase);
  $v("vChanged").addEventListener("click", showChangedValues);
  // main.js initializes run mode synchronously after this adapter returns. Defer the label check so
  // it reads simulation-owned state without duplicating URL mode selection in the debugger.
  queueMicrotask(syncShowcaseAction);

  // T hides/restores the entire panel without changing any descendant state. Shift+digit switches
  // tabs; plain digits stay free for the game. Silent while the skill tree is up: it covers this
  // panel, and the `inert` it hangs on the rest of the frame stops clicks and focus but not a
  // listener bound to `window`.
  window.addEventListener("keydown", e=>{
    if(state.skillTree.open)return;
    if(e.code==="KeyT"&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      e.preventDefault();if(!e.repeat)togglePanelVisibility();return;
    }
    if(!e.shiftKey)return;
    const n = "!@#$%^&*("./* shifted digits */indexOf(e.key);
    if(n>=0 && vPanes[n]){ showVTab(vPanes[n].dataset.tab); e.preventDefault(); }
  });

  $v("vRestart").addEventListener("click", ()=>location.reload());
  // One warm-up frame: layout has settled, so the renderer can be re-measured through the host's
  // one resize path and the first sightline sweep has a real camera to sweep.
  requestAnimationFrame(()=>{ syncShowcaseAction(); HOOKS.resizeView(); runScan(); });
}
