// Owns: the DOM heads-up display — the build dock, the phase panel, the hover prompt, the toast,
// the upgrade modal, the pause badge and the game-over card. Owns no gameplay state and no meshes.
// ═══════════════════════════════════════════════════════════════════════════
// HUD ADAPTER
// The consumer end of the simulation's effect contract. The simulation raises player-facing
// feedback by NAME; SIM_EFFECTS below turns each name into the DOM work it used to do inline, and
// main.js is the only place that hands the record over (connect()).
//
// Ownership / data flow
//   Reads:    src/game/simulation.js through its queries and its exported live collections, and
//             src/game/data.js for the authored tables the forecast names. Those references are
//             READ-ONLY here by contract: this file may project them, never splice, push or assign
//             into them, and never assign into `state`.
//   Writes:   the DOM only — element text, classes and children under #game. Every gameplay change
//             this file causes goes through a simulation COMMAND (toggleBuildMode,
//             setBuildDockCategory, closeUpgradeMenu, selectUpgrade, acceptUpgrade); there is no
//             other way out of this file into the world.
//   Supplies: SIM_EFFECTS  — the effect implementations the simulation calls back into. Invariant
//                            (consumer end): every hook is a pure sink. It may read simulation
//                            state, it must never write it, and it must not call back into a
//                            command. They run synchronously inside commands and inside update(),
//                            synchronously in simulation command/update order.
//             modalOpen()  — the one host predicate both the simulation and the scene ask for. It
//                            answers for either modal (see the block below); nothing keeps a copy.
//             syncModalUi() — repaint that predicate onto #game, for the other modal's adapter.
//             syncBuildHud() / syncPhaseHud() — the two sync passes other adapters and boot re-run.
//
// Imported by: src/main.js (composition), src/input.js (modalOpen, for the pointer-down guard),
// src/ui/skill-tree.js (syncModalUi, when its panel opens or closes) and
// src/debug/view-debugger.js (syncBuildHud, after it flips DBG.unlimitedCharges). Nothing is
// imported back from any of them — the HUD is the lowest browser adapter, so the
// pointer surface it needs for the build cursor is HANDED IN by main.js rather than looked up here.
// That keeps <canvas id="overlay"> at its documented three owners: main.js (listeners, classes and focus),
// src/render/overlay.js (2D context and backing store) and src/render/scene.js (client rect).
// ═══════════════════════════════════════════════════════════════════════════
import {
  NIGHT_WAVE_RECIPES,
  DAY_DURATION,NIGHT_DURATION
} from "../game/data.js";
import {
  DBG, state,
  // commands — the only writes this file can make into the world
  toggleBuildMode, setBuildDockCategory,
  closeUpgradeMenu, selectUpgrade, acceptUpgrade,
  // queries — pure reads
  hoverTarget, costText, upgradeList, nextHouseCost,
  oppositeMapSide, clamp
} from "../game/simulation.js";

// The pointer surface (<canvas id="overlay">) — handed in by main.js at init. The HUD touches
// exactly one thing on it: the `building` class that swaps the cursor to a crosshair.
let surface = null;

// ── modal state ─────────────────────────────────────────────────────────────
function upgradePanelOpen(){return !document.getElementById("upgradePanel").classList.contains("off");}
// Two modals: the upgrade panel, whose own class is its flag, and the skill-tree screen, whose flag
// the simulation owns (src/ui/skill-tree.js only mirrors it onto the panel). The old debug modal is
// gone, and the view debugger is a non-modal side panel that deliberately does NOT suppress
// gameplay input. Neither modal pauses the run; both stop POINTER input reaching the world — this
// predicate is the guard input.js's pointer-down asks. Keys are a separate question each modal
// answers for itself: the skill tree suppresses the camera keys in input.js, the upgrade panel
// never did.
export function modalOpen(){return upgradePanelOpen()||state.skillTree.open;}
/** The `.modal-open` class on #game, which this file owns. Called by whichever modal just moved. */
export function syncModalUi(){document.getElementById("game").classList.toggle("modal-open",modalOpen());}

// ── effect implementations handed to the simulation ─────────────────────────
// main.js is the only caller of connect(), and it merges this record with the skill tree's before
// handing it over. The names here are the simulation's, one for one, they do not overlap with that
// other record, and nothing in this one reaches back into a command.
export const SIM_EFFECTS = {
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
  // Answers for both modals (see the block above), so the simulation keeps no copy of either flag.
  isModalOpen(){return modalOpen();},
};

// ── the upgrade modal ───────────────────────────────────────────────────────
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

// ── the phase panel ─────────────────────────────────────────────────────────
// Whole seconds as M:SS, rolling over to H:MM:SS only once a run passes an hour — so the common
// case stays as short as the phase countdown beside it and a long run never silently wraps.
function formatDuration(totalSeconds){
  const s=Math.max(0,Math.floor(totalSeconds)),hours=Math.floor(s/3600),minutes=Math.floor(s/60)%60;
  const pad=n=>String(n).padStart(2,"0");
  return hours?hours+":"+pad(minutes)+":"+pad(s%60):minutes+":"+pad(s%60);
}
export function syncPhaseHud(){
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

// ── the build dock ──────────────────────────────────────────────────────────
// Charge counts and affordability are read fresh from the simulation every pass; the only thing
// written outside this panel is the crosshair cursor on the pointer surface main.js handed in.
export function syncBuildHud(){
  document.querySelectorAll("button.build").forEach(button=>button.classList.toggle("on",button.dataset.kind===state.buildMode));
  for(const [kind,label] of [["spikes","spikeStack"],["landmine","landmineStack"],["tar","tarStack"]]){
    const unavailable=!DBG.unlimitedCharges&&state.buildStacks[kind]<=0,button=document.querySelector('button.build[data-kind="'+kind+'"]');
    document.getElementById(label).textContent="free · "+(DBG.unlimitedCharges?"∞":state.buildStacks[kind]+" left");button.disabled=unavailable;
  }
  const houseCost=nextHouseCost();document.getElementById("houseCost").textContent=houseCost.wood+"w · "+houseCost.stone+"s";
  surface.classList.toggle("building",state.buildMode);
}

// ── the hover prompt ────────────────────────────────────────────────────────
function updatePrompt(){
  const box=document.getElementById("prompt"),label=box.querySelector("span"),target=hoverTarget();
  box.classList.toggle("on",!!target);
  if(target)label.textContent=target.kind==="base"?"deposit at base":target.kind==="stockpile"?"store in stockpile":target.kind==="upgrade"?"deposit toward upgrade":"deliver to blueprint";
}

// ── audio ───────────────────────────────────────────────────────────────────
// The one non-DOM sink in this file, kept beside the toast because they are two halves of the same
// player-facing feedback record: the simulation raises `sound` exactly where it raises `toast`.
let audio=null;
function sound(freq,duration){
  try{audio=audio||new(window.AudioContext||window.webkitAudioContext)();const o=audio.createOscillator(),g=audio.createGain();o.type="square";o.frequency.value=freq;g.gain.setValueAtTime(.035,audio.currentTime);g.gain.exponentialRampToValueAtTime(.0001,audio.currentTime+duration);o.connect(g);g.connect(audio.destination);o.start();o.stop(audio.currentTime+duration);}catch(_){ }
}

// ── registration ────────────────────────────────────────────────────────────
// Every listener and observer this adapter owns, in one auditable list. Called once, by main.js,
// before src/input.js and src/debug/view-debugger.js — the debugger's `unlimited charges` binding
// runs syncBuildHud() the moment it is bound, and that needs `surface` already set.
export function initHud(pointerSurface){
  surface = pointerSurface;

  // upgrade modal
  document.getElementById("upgradeDecline").addEventListener("click", closeUpgradeMenu);
  document.getElementById("upgradeAccept").addEventListener("click", ()=>{acceptUpgrade();});

  // build dock — tabs, cards, and the clearance the toast lane reserves above the dock
  document.querySelectorAll(".dock-tab").forEach(tab=>tab.addEventListener("click",()=>setBuildDockCategory(state.buildDockCategory===tab.dataset.category?null:tab.dataset.category)));
  // Toasts occupy the notification lane immediately above the dock in both collapsed and expanded states.
  const buildDock=document.getElementById("buildDock"),stage=document.getElementById("stage");
  new ResizeObserver(()=>stage.style.setProperty("--build-dock-clearance",buildDock.offsetHeight+"px")).observe(buildDock);
  document.querySelectorAll("button.build").forEach(button=>button.addEventListener("click",()=>toggleBuildMode(button.dataset.kind)));

  // game over
  document.getElementById("restart").addEventListener("click", ()=>location.reload());
}
