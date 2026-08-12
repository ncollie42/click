// ═══════════════════════════════════════════════════════════════════════════
// BROWSER ADAPTER + RENDER / UI LAYER
// Everything in this file is downstream of the simulation. It owns the browser:
// the DOM, the canvases, three.js, pointer and keyboard events, the HUD and the
// view debugger — and it owns NO gameplay state.
//
// Ownership / data flow
//   Reads:    src/game/simulation.js through its queries and its exported live
//             collections. Those references are READ-ONLY here by contract: this
//             file may iterate and project them, never splice, push or assign
//             into them, and never assign into `state`.
//   Writes:   only through simulation commands (setPointerWorld, primaryPress,
//             secondaryPress, toggleBuildMode, openUpgradeMenu, …) and through
//             the two tunable holders each side owns — TUNE in the simulation,
//             VIEW_TUNE below.
//   Supplies: the effect implementations the simulation calls back into (see
//             SIM_EFFECTS). They run synchronously inside commands and inside
//             update(), in the exact order the old inline DOM calls ran.
//
// Still living here, deliberately, until steps 5-6 split them out: the three.js
// scene and every mesh/pool, the 2D overlay, the HUD sync functions, all input
// listeners and the whole view debugger.
// ═══════════════════════════════════════════════════════════════════════════
import * as THREE from "three";
// ── authored data ──
// Every immutable definition the game is authored from lives in src/game/data.js: world and frame
// dimensions, the placement lattice, footprints, resource kinds, the building / upgrade / tower /
// enemy tables, the wave recipes and the pacing constants. Nothing here may reassign or mutate any
// of them; this file only reads.
import {
  VIEW_W,VIEW_H,W,H,BASE,BASE_ZONE,
  CELL,GRID_ORIGIN_X,GRID_ORIGIN_Y,GRID_COLS,GRID_ROWS,
  FOOTPRINT_1x1,FOOTPRINT_3x3,
  RESOURCE_KINDS,
  WORKER_HP,WORKER_ATTACK_RATE,WORKER_HIT_COOLDOWN,WORKER_LEASH,
  BUILDING_TYPES,UPGRADES,
  ENEMY_TYPES,MAP_SIDE,
  NIGHT_TELEGRAPH_TIME,NIGHT_WAVE_RECIPES,
  DAY_DURATION,NIGHT_DURATION
} from "./game/data.js";
// ── placement math ──
// Pure lattice helpers over those definitions (src/game/grid.js). Occupancy, the build margin and the
// placement verdict itself are NOT there: canPlace() lives in the simulation, which composes them
// from these helpers and the live world arrays.
import {
  worldToCell,cellToWorld,snapToCellCenter,buildingFootprint,
  footprintCells,footprintWorldRect
} from "./game/grid.js";
// ── the simulation ──
// The sole owner of mutable gameplay state. Commands go in, queries come out; there is no third way
// to touch the world from this file. See that module's header for the full contract.
import {
  connect as connectSimulation, TUNE, DBG, state,
  trees, rocks, diamonds, resourceDrops, buildings, workerCorpses, particles,
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
  hoverTarget, hoveredBuilding, badgeAction, chopProgress,
  heldChopTarget, primaryHeld,
  canPlace, indicatorRadius, towerVariant, buildingCost, costText, upgradeList,
  towerUpgradeList, nextHouseCost, storageServiceRadius, workerAssignmentAt,
  heldWorker, heldBuilding, workerCoatColor, workerLoad, carriedTotal,
  oppositeMapSide, clamp, distance,
  // debug entry points (view panel > gameplay)
  spawnEnemy, debugGrant, debugSweepFreeCosts, debugGoToPhase, debugAdvancePhase,
  debugStartWave, debugClearEnemies, debugHealAll
} from "./game/simulation.js";

// Raycast scratch shared by input (defined here so the pointer handlers can use it).
const _ndc=new THREE.Vector2(), _ray=new THREE.Raycaster(), _ghit=new THREE.Vector3();
const _groundPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);

// ── runtime-tunable PRESENTATION constants (view panel) ──────────────────────
// The view debugger reassigns these while the game runs, exactly as it does the simulation's TUNE.
// They live in one mutable holder for the same reason: an imported binding cannot be reassigned by
// its importer, so a plain `let` here would break the moment step 5 moves the render layer into its
// own module. The split between the two holders is by READER, not by widget: nothing below is ever
// read by the simulation, and nothing in TUNE is presentation-only.
//   handArc / shotSpeed / shotArc / shotSize — pure visuals of a flight the sim already resolved.
//   showVacuumRing — whether to DRAW the ring; its radius is TUNE.vacuumRadius, the real reach.
const VIEW_TUNE = {
  handArc:2,           // world units a collected drop arcs on its way in   [slider vArc]
  showVacuumRing:true, //                                                   [slider vRing]
  shotSpeed:26,        // tower projectile travel, world units per second   [slider vShotSpeed]
  shotArc:1,           // multiplier on how much a shot lobs                [slider vShotArc]
  shotSize:1,          // projectile scale multiplier                       [slider vShotSize]
};

const canvas = document.getElementById("overlay");   // 2D overlay sits above the WebGL scene
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled=false;

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

// ── Pointer data flow ──
// Written by: the handlers below, through setPointerWorld()/setPointerOutside().
// Read by:    the simulation's update() (collection, drop delivery) and draw() (hover feedback).
// Format:     world-space simulation pixels, produced by raycasting the ground plane — the 3D
//             equivalent of the old inverse camera transform, correct at any pitch/yaw.
function groundFromEvent(event){
  const r=canvas.getBoundingClientRect();
  _ndc.x=((event.clientX-r.left)/r.width)*2-1;
  _ndc.y=-((event.clientY-r.top)/r.height)*2+1;
  _ray.setFromCamera(_ndc,camera3);
  if(!_ray.ray.intersectPlane(_groundPlane,_ghit))return null;
  return {x:_ghit.x/S,y:_ghit.z/S};
}
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


// ═══════════════════════════════════════════════════════════════════════════
// 3D RENDER LAYER
// The simulation lives in src/game/simulation.js and still thinks in 2D game
// pixels. Everything here is read-only over the collections and queries it
// exports: game (x, y) maps to world (x*S, 0, y*S), meshes are pooled per
// entity, and anything that must stay unskewed (bars, text, carried resources)
// is drawn on a 2D overlay canvas at projected screen positions.
// Invariant: nothing below this line writes simulation state. The only writers
// in this file are the input handlers above (through commands) and the view
// debugger below (through commands, TUNE, DBG and VIEW_TUNE).
// ═══════════════════════════════════════════════════════════════════════════

function workerToolKind(worker){
  if(worker.job==="harvest")return worker.jobTarget?.kind;
  if(worker.job==="staff")return BUILDING_TYPES[worker.jobTarget?.type]?.resource;
  if(worker.job==="build")return "build";
  return null;
}

const S = 1/16;                       // game pixels -> world units
const WU = W*S, HU = H*S;             // 96 x 64
const gx = x => x*S, gz = y => y*S;

// ═══════════════════════════════════════════════════════════════════════════
// PALETTE
// Single source of truth for every colour in the 3D layer. Entries are hex
// numbers for three.js; css() converts for the 2D overlay and the baked
// ground texture. Grouped by role, not by object, so retinting a material
// family (all timber, all arcane glow) is one edit.
// ═══════════════════════════════════════════════════════════════════════════
const PAL = {
  // ── world ──────────────────────────────────────────────
  sky:        0x1d1c29,
  water:      0x8fb3cf,
  cliff:      0x6a5a41,
  grass:      0x9db97f,
  grassAlt:   0x96b177,
  grassSpeck: 0x8dab70,
  dirt:       0xd9c9a3,   // base clearing, paths
  grid:       0x63764c,   // placement lattice; drawn at very low opacity

  // ── flora ──────────────────────────────────────────────
  trunk:      0x6b4a2e,
  stump:      0x79512e,
  leaf:      [0x7fae5c, 0x6d9a4d, 0xd9a0bc],   // indexed by tree.variant

  // ── minerals ───────────────────────────────────────────
  rock:       0x9a9a94,
  rockDark:   0x6f6f6a,
  rubble:     0x8d8c88,
  gem:        0x71cbd8,
  gemBase:    0x4d6264,
  gemSpent:   0x557b80,

  // ── resources ──────────────────────────────────────────
  wood:       0xb98a4e,
  stone:      0xaaa9a5,
  dust:       0xa783df,
  coin:       0xe3b445,
  diamond:    0x79d9e8,

  // ── people ─────────────────────────────────────────────
  skin:       0xd7b586,
  coat:       0xd4b079,   // fallback worker coat
  jobHaul:    0x6f96ad,
  jobBuild:   0xd29a39,
  jobGuard:   0x9a7a54,
  hat:        0x6f4930,
  kingRobe:   0x9d3f34,
  kingCrown:  0xe8be55,
  blade:      0xded8c9,

  // ── enemies ────────────────────────────────────────────
  raider:     0x4a4152, raiderCap: 0x2b2532,
  archer:     0x76583e, archerCap: 0xa2814f,
  healer:     0x557649, healerCap: 0xe3dec5,
  brute:      0x674337, bruteCap:  0x3b2a21,

  // ── structures ─────────────────────────────────────────
  timber:     0x8a7358,
  timberDark: 0x5c4a38,
  plaster:    0xc0a170,
  plasterLit: 0xc9b48a,
  roof:       0x8e5f3c,
  roofDark:   0x5f4527,
  masonry:    0x8d8495,
  masonryDark:0x6b6874,
  quarryWall: 0x777775,
  quarryRoof: 0x5f6061,
  doorway:    0x49392d,
  // the keep: pale dressed stone, deliberately cooler and lighter than masonry (the obelisk) so
  // the base reads as the one landmark on the map. keepTrim is the plinth/crown/prop course.
  keepWall:   0xb9b6b0,
  keepTrim:   0x93908a,
  pole:       0x5d4935,
  banner:     0xa94634,
  metal:      0xbdb7ab,
  tar:        0x3a3128,
  arcane:     0xb18be5,
  arcaneGlow: 0x2e1f4a,
  fuse:       0xd8a343,
  charge:     0xa74434,
  chargeBody: 0x59473a,
  blueprint:  0x9a774d,
  scaffold:   0x83603a,
  pad:        0xa08a63,   // packed earth under a finished building's footprint

  // ── tower accents (by variant) ─────────────────────────
  towShock:   0x4c5d61,
  towLaser:   0x78e3df,
  towFire:    0xd9713f,
  towFreeze:  0x8fd9ee,
  towTeleport:0x7396e8,
  towBomb:    0x9a5c3a,
  towSniper:  0xd9e3c2,
  towBrick:   0x9b7f60,
  towOutpost: 0x7d6b52,

  // ── feedback / rings ───────────────────────────────────
  flash:      0xd25b49,   // enemy hit tint
  hurtGlow:   0x5a1a12,   // tower damage emissive
  emberGlow:  0x60220c,   // burning status emissive
  ghostOk:    0x1d3312,
  ghostBad:   0x3d1410,
  cellOk:     0x8fc95e,   // footprint preview, placement allowed
  cellBad:    0xcf4f3e,   // footprint preview, placement blocked
  tool:       0x65442c,
  hpGood:     0x7fb356,   // remaining-health track, top row of a stack
  hint:       0xead18d,
  ok:         0xf5df98,   // affirmative highlight: hover rings, default impact flash
  cursor:     0xc8cbb8,   // idle cursor bracket: cool and quiet, so a real target still reads warmer
  bad:        0xb84b3c,
  taunt:      0xd6534f,
  storage:    0xd8c47c,
  pin:        0xd4453a,

  // ── lighting ───────────────────────────────────────────
  sunDay:     0xfff2d0,
  sunNight:   0x9fb4e8,
  skyLight:   0xd8e8ff,
  bounce:     0x6b6350,
};
/** Hex number -> css string, for the 2D overlay and canvas textures. */
const css = n => "#" + n.toString(16).padStart(6,"0");

const DROP_COLOR = {wood:PAL.wood, stone:PAL.stone, dust:PAL.dust,
                    coin:PAL.coin, diamond:PAL.diamond};
const JOB_COAT = {haul:PAL.jobHaul, build:PAL.jobBuild, guard:PAL.jobGuard};
/** Tower roof accent per variant; anything unlisted falls back to timberDark. */
const TOWER_TOP = {
  pulse:PAL.arcane,     shock:PAL.towShock,   laser:PAL.towLaser,
  fire:PAL.towFire,     freeze:PAL.towFreeze, tar:PAL.tar,
  teleport:PAL.towTeleport, bomb:PAL.towBomb, sniper:PAL.towSniper,
  watch:PAL.coin,       brick:PAL.towBrick,   aggro:PAL.taunt,
  turret:PAL.timber,    outpost:PAL.towOutpost,
};

// ─────────────────────────────────────────────────────────── renderer & cameras
const sceneCanvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({canvas:sceneCanvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAL.sky);

const persp = new THREE.PerspectiveCamera(38, 16/9, 0.5, 600);
const ortho = new THREE.OrthographicCamera(-1,1,1,-1,-200,600);
let camera3 = persp;

// Debug-owned view state. pitch 90 reproduces the original top-down framing.
const view = {pitch:40, yaw:0, fov:38, ortho:false, orbit:false,
              heightScale:100, ghostPins:false};

function placeCamera(){
  const cam = state.camera;
  const tx = gx(cam.x), tz = gz(cam.y);
  const p = THREE.MathUtils.degToRad(view.pitch), y = THREE.MathUtils.degToRad(view.yaw);
  // Ortho frustum matches the 2D game's coverage exactly, so clampCamera() and
  // the .2-5 zoom range carry over unchanged.
  // halfW must come from the live canvas aspect. Hardcoding 16:9 here stretches
  // world-X against world-Y on any other shape, which reads as squashed models.
  const halfH = VIEW_H/(2*cam.zoom)*S, halfW = halfH*viewAspect;
  ortho.left=-halfW; ortho.right=halfW; ortho.top=halfH; ortho.bottom=-halfH;
  ortho.updateProjectionMatrix();
  persp.fov = view.fov; persp.updateProjectionMatrix();

  const dist = camera3===ortho ? 160 : halfH/Math.tan(THREE.MathUtils.degToRad(view.fov/2));
  const h = Math.sin(p)*dist, r = Math.cos(p)*dist;
  camera3.position.set(tx + Math.sin(y)*r, h, tz + Math.cos(y)*r);
  camera3.lookAt(tx, 0, tz);

  // The shadow frustum has to track zoom, or zooming out drops every shadow
  // outside it and the map goes flat.
  const span = clamp(halfW*1.5, 14, 120);   // halfW, not halfH — the view is 16:9
  const sc = sun.shadow.camera;
  sc.left=-span; sc.right=span; sc.top=span; sc.bottom=-span;
  sc.updateProjectionMatrix();
}

// The overlay is authored in a fixed 960x540 space but displayed much larger.
// Backing store must match real device pixels or every bar and glyph is upscaled.
let overlayScale = 1;
let viewAspect = 16/9;

function resizeRenderer(){
  const r = sceneCanvas.getBoundingClientRect();
  if(!r.width||!r.height)return;
  renderer.setSize(r.width, r.height, false);
  viewAspect = r.width/r.height;
  persp.aspect = viewAspect;

  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width  = Math.round(r.width  * dpr);
  canvas.height = Math.round(r.height * dpr);
  overlayScale  = canvas.width / VIEW_W;

  placeCamera();
}
addEventListener("resize", resizeRenderer);

// ─────────────────────────────────────────────────────────── lights
// Ambient stays low so cast shadows actually read as shadows.
const sky = new THREE.HemisphereLight(PAL.skyLight, PAL.bounce, 0.5);
scene.add(sky);
const sun = new THREE.DirectionalLight(PAL.sunDay, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.035;
scene.add(sun, sun.target);

// ─────────────────────────────────────────────────────────── ground
const flat = (color, extra={}) => new THREE.MeshLambertMaterial({color, flatShading:true, ...extra});
// ── outlines ────────────────────────────────────────────────────────────────
// Inverted hull: a back-faced copy of each prop pushed out along its normals,
// so only the shell behind the object survives depth testing and reads as ink.
// Costs one extra draw per prop; hidden meshes are skipped, so the toggle is free.
let OUTLINE_ON = true;
const outlineMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: {thickness:{value:.05}, tint:{value:new THREE.Color(0x1d1712)}},
  vertexShader: `
    uniform float thickness;
    void main(){
      vec3 swollen = position + normal * thickness;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(swollen, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 tint;
    void main(){ gl_FragColor = vec4(tint, 1.0); }`,
});
const outlineShells = [];
const isOutline = o => o.userData.outline === true;

function meshOf(geo, mat, cast=true, receive=true){
  const m = new THREE.Mesh(geo, mat); m.castShadow=cast; m.receiveShadow=receive;
  if(cast){                                  // props only — never ground or water
    const shell = new THREE.Mesh(geo, outlineMat);
    shell.castShadow = shell.receiveShadow = false;
    shell.userData.outline = true;
    shell.visible = OUTLINE_ON;
    m.add(shell);
    outlineShells.push(shell);
  }
  return m;
}
function setOutlines(on){
  OUTLINE_ON = on;
  for(const s of outlineShells) s.visible = on;
}

// The original pixel-art ground generator, repainted in the prototype's palette.
const groundLayer=document.createElement("canvas");groundLayer.width=W;groundLayer.height=H;
(function bakeGround(){
  const c=groundLayer.getContext("2d");c.imageSmoothingEnabled=false;
  for(let y=0;y<H;y+=8)for(let x=0;x<W;x+=8){
    const n=(x*13+y*7)%31;
    c.fillStyle=n%3?css(PAL.grass):css(PAL.grassAlt);c.fillRect(x,y,8,8);
    if(n<6){c.fillStyle=css(PAL.grassSpeck);c.fillRect(x+n,y+(n*3)%7,2,2);}
  }
  // No dirt clearing under the base: it wears the same footprint pad as every other building.
})();
const groundTex = new THREE.CanvasTexture(groundLayer);
groundTex.magFilter = THREE.NearestFilter;
groundTex.colorSpace = THREE.SRGBColorSpace;

const ground = meshOf(new THREE.PlaneGeometry(WU,HU), flat(0xffffff,{map:groundTex}), false, true);
ground.rotation.x = -Math.PI/2;
ground.position.set(WU/2, 0, HU/2);
scene.add(ground);

// Slab sides so the map reads as an object rather than an infinite plane.
// Its top must sit BELOW the ground plane — coincident faces z-fight and the
// terrain turns into brown/green stripes.
const slab = meshOf(new THREE.BoxGeometry(WU, 3.0, HU), flat(PAL.cliff), false, false);
slab.position.set(WU/2, -1.53, HU/2);          // top face at y = -0.03
scene.add(slab);

// Water surrounds the slab, same as the prototype's island read.
const water = meshOf(new THREE.PlaneGeometry(WU*5, HU*6), flat(PAL.water), false, false);
water.rotation.x = -Math.PI/2;
water.position.set(WU/2, -1.9, HU/2);
scene.add(water);

// ─────────────────────────────────────────────────────────── placement grid
// The simulation owns the lattice (CELL, GRID_ORIGIN_*, GRID_COLS/ROWS); this only draws it, so the
// lines land on cell BOUNDARIES. Every square therefore encloses exactly one snap target — the same
// cell centre snapToCellCenter() commits to and the same anchor seedWorld() gave each resource node.
// Edge treatment: the half-clipped border cells put boundaries at -CELL/2 and past W/H. Those are
// skipped rather than clamped — a clamped line would sit mid-cell and lie about where a cell ends.
// Cost: (GRID_COLS-1) + (GRID_ROWS-1) = 80 segments in one LineSegments, a single draw call.
const GRID_Y = .015;          // world units above the ground plane: enough to win the depth test
const GRID_OPACITY = .24;     // deliberately faint; draw() fades it further at night
const gridMat = new THREE.LineBasicMaterial({color:PAL.grid, transparent:true,
                                             opacity:GRID_OPACITY, depthWrite:false});
const terrainGrid = (function buildTerrainGrid(){
  const v = [];
  for(let cx=0; cx<=GRID_COLS; cx++){
    const x = GRID_ORIGIN_X + cx*CELL;
    if(x<0 || x>W) continue;
    v.push(gx(x), GRID_Y, gz(0), gx(x), GRID_Y, gz(H));
  }
  for(let cy=0; cy<=GRID_ROWS; cy++){
    const y = GRID_ORIGIN_Y + cy*CELL;
    if(y<0 || y>H) continue;
    v.push(gx(0), GRID_Y, gz(y), gx(W), GRID_Y, gz(y));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  const lines = new THREE.LineSegments(geo, gridMat);
  // Not a mesh and not a shadow caster, so blockerMeshes() cannot pick it up as an occluder.
  lines.castShadow = lines.receiveShadow = false;
  lines.renderOrder = -1;      // below rings, ghosts and every other transparent mark
  return lines;
})();
scene.add(terrainGrid);


// ─────────────────────────────────────────────────────────── entity models

function makeTree(t){
  const g = new THREE.Group();
  const leaf = PAL.leaf[t.variant] ?? PAL.leaf[0];
  const trunk = meshOf(new THREE.CylinderGeometry(.16,.24,2.2,6), flat(PAL.trunk));
  trunk.position.y = 1.1;
  const crown = meshOf(new THREE.IcosahedronGeometry(1.35,0), flat(leaf));
  crown.position.y = 3.0; crown.scale.set(1,.85,1);
  const stump = meshOf(new THREE.CylinderGeometry(.26,.3,.42,6), flat(PAL.stump));
  stump.position.y = .21; stump.visible = false;
  g.add(trunk, crown, stump);
  g.userData = {trunk, crown, stump};
  return g;
}
function makeRock(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.DodecahedronGeometry(.95,0), flat(PAL.rock));
  body.position.y = .55; body.scale.set(1,.72,1);
  const chip = meshOf(new THREE.DodecahedronGeometry(.42,0), flat(PAL.rockDark));
  chip.position.set(.8,.28,.35);
  const rubble = meshOf(new THREE.DodecahedronGeometry(.55,0), flat(PAL.rubble));
  rubble.position.y = .14; rubble.scale.set(1,.3,1); rubble.visible = false;
  g.add(body, chip, rubble);
  g.userData = {live:[body,chip], rubble};
  return g;
}
function makeDiamond(){
  const g = new THREE.Group();
  const base = meshOf(new THREE.DodecahedronGeometry(.7,0), flat(PAL.gemDark));
  base.position.y = .35; base.scale.set(1,.5,1);
  const gem = meshOf(new THREE.OctahedronGeometry(.55,0), flat(PAL.gem));
  gem.position.y = 1.05;
  const spent = meshOf(new THREE.DodecahedronGeometry(.45,0), flat(PAL.gemSpent));
  spent.position.y = .12; spent.scale.set(1,.28,1); spent.visible = false;
  g.add(base, gem, spent);
  g.userData = {live:[base,gem], spent, gem};
  return g;
}
function makeDrop(kind){
  const g = new THREE.Group();
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.16,.16,.8,6), flat(col)); m.rotation.z=Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.3,.3,.09,10), flat(col)); m.rotation.x=Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.32,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.3,0), flat(col));
  m.position.y = .3;
  g.add(m);
  g.userData = {body:m};
  return g;
}
// Enemies borrow the prototype's unit form — capsule body, sphere head, cone
// cap — and read apart by colour and bulk rather than by props.
const ENEMY_LOOK = {
  raider:{body:PAL.raider, cap:PAL.raiderCap, r:.26, len:.46},
  archer:{body:PAL.archer, cap:PAL.archerCap, r:.22, len:.56},
  healer:{body:PAL.healer, cap:PAL.healerCap, r:.29, len:.40},
  brute: {body:PAL.brute, cap:PAL.bruteCap, r:.34, len:.54},
};
function makeEnemy(type){
  const g = new THREE.Group();
  const L = ENEMY_LOOK[type] || ENEMY_LOOK.raider;
  const body = meshOf(new THREE.CapsuleGeometry(L.r, L.len, 3, 8), flat(L.body));
  body.position.y = L.r + L.len/2;
  const head = meshOf(new THREE.SphereGeometry(L.r*.82, 8, 6), flat(PAL.skin));
  head.position.y = L.r*2 + L.len + .04;
  const cap = meshOf(new THREE.ConeGeometry(L.r*1.18, L.r*1.05, 7), flat(L.cap));
  cap.position.y = head.position.y + L.r*.86;
  g.add(body, head, cap);
  g.userData = {body, head, cap, baseColor:L.body};
  return g;
}
function makeWorker(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.CapsuleGeometry(.26,.42,3,7), flat(PAL.coat));
  body.position.y = .55;
  const head = meshOf(new THREE.SphereGeometry(.24,8,6), flat(PAL.skin));
  head.position.y = 1.08;
  const hat = meshOf(new THREE.ConeGeometry(.3,.26,7), flat(PAL.hat));
  hat.position.y = 1.3;
  const load = meshOf(new THREE.BoxGeometry(.28,.28,.28), flat(PAL.wood));
  load.position.set(-.38,.72,0); load.visible = false;
  const tool = meshOf(new THREE.BoxGeometry(.08,.62,.08), flat(PAL.tool));
  tool.position.set(.36,.72,0);
  g.add(body, head, hat, load, tool);
  g.userData = {body, load, tool};
  return g;
}
function makeCorpse(coat){
  const g = new THREE.Group();
  const m = meshOf(new THREE.CapsuleGeometry(.24,.4,3,6),
    new THREE.MeshLambertMaterial({color:new THREE.Color(coat), flatShading:true,
      transparent:true, opacity:.62}));
  m.rotation.z = Math.PI/2; m.position.y = .24;
  g.add(m);
  return g;
}
// ── the keep ────────────────────────────────────────────────────────────────
// A compact square watchtower: a stone shaft whose walls taper inward, a slightly projecting open
// crown with chunky crenellations, and one small dark entrance. No pitched roof, no flag, no
// corner towers - the silhouette is meant to read as a single tall block, not a house.
//
// The VISUAL MASS IS INTENTIONALLY 1x1 (about 2.0 x 2.0 world units, the centre cell) while
// GAMEPLAY OCCUPANCY REMAINS 3x3 (BASE.footprint = FOOTPRINT_3x3). The outer ring of the pad is
// courtyard: an entrance path and a couple of low props, everything kept below doorway height so
// nothing competes with the tower. canPlace(), enemy targeting and BASE.r read the footprint and
// BASE.r, never the model, so shrinking the mesh changes nothing in the simulation.
function makeBase(){
  const g = new THREE.Group();
  const Y0 = FLOOR_TOP;               // the footprint pad's top face; every course stacks off it
  const LAP = .03;                    // each course sinks this far into the one below, so no two
                                      // solid faces ever end up coplanar and z-fighting
  // Square prisms come from a 4-segment cylinder turned 45deg, which lands flat faces on the X and
  // Z axes. Width across those faces is r*sqrt(2), so sq() converts a wall width into the radius
  // three.js wants. A frustum (bottom wider than top) is what gives the walls their taper.
  const sq = w => w/Math.SQRT2;
  const prism = (wBottom, wTop, h, mat) => {
    const m = meshOf(new THREE.CylinderGeometry(sq(wTop), sq(wBottom), h, 4), mat);
    m.rotation.y = Math.PI/4;
    return m;
  };
  const PLINTH_H = .30, SHAFT_H = 3.5, CORBEL_H = .22, MERLON_H = .48;
  const PLINTH_TOP = Y0 + PLINTH_H;                       // .396
  const SHAFT_BOT  = PLINTH_TOP - LAP;
  const SHAFT_TOP  = SHAFT_BOT + SHAFT_H;                 // 3.866
  const CROWN_TOP  = SHAFT_TOP - LAP + CORBEL_H;          // 4.056 - walkway level

  const plinth = meshOf(new THREE.BoxGeometry(2.0,PLINTH_H,2.0), flat(PAL.keepTrim));
  plinth.position.y = Y0 + PLINTH_H/2;
  // 1.86 -> 1.42 across 3.5 of height: a taper you can read in silhouette without the tower
  // looking like a cone. Widest point (1.86) still sits inside the 2.0 plinth.
  const body = prism(1.86, 1.42, SHAFT_H, flat(PAL.keepWall));
  body.position.y = SHAFT_BOT + SHAFT_H/2;
  // The crown flares back OUT past the shaft top (1.42 -> 1.84), so it overhangs by ~.21 a side.
  const corbel = prism(1.46, 1.84, CORBEL_H, flat(PAL.keepTrim));
  corbel.position.y = SHAFT_TOP - LAP + CORBEL_H/2;
  // Shadowed interior, glimpsed through the gaps between merlons and from above: this is what
  // makes the crown read as open rather than as a solid capstone.
  // 1.04 wide keeps it just inside the merlon ring's inner edge (+-.52), so it fills the gaps
  // between the teeth without clipping into them.
  const well = meshOf(new THREE.BoxGeometry(1.04,.12,1.04), flat(PAL.doorway));
  well.position.y = CROWN_TOP + .02;
  g.add(plinth, body, corbel, well);
  // Crenellations: four corners plus one merlon at the middle of each side. .40 blocks with .32
  // gaps around a 1.84 crown, so at gameplay zoom they read as separate teeth, not a serrated rim.
  for(const [mx,mz] of [[-.72,-.72],[.72,-.72],[-.72,.72],[.72,.72],[0,-.72],[0,.72],[-.72,0],[.72,0]]){
    const merlon = meshOf(new THREE.BoxGeometry(.40,MERLON_H,.40), flat(PAL.keepWall));
    merlon.position.set(mx, CROWN_TOP - LAP + MERLON_H/2, mz);
    g.add(merlon);
  }
  // Entrance faces the king. gz() maps sim y straight to world z, and the king stands at
  // BASE.y+18, so "toward the king" is +Z. The dark block stands slightly proud of the plinth
  // (front face z=1.05 vs the plinth's 1.0) so it never z-fights the wall it sits in.
  const door = meshOf(new THREE.BoxGeometry(.58,1.00,.30), flat(PAL.doorway));
  door.position.set(0, PLINTH_TOP - .02 + .50, .90);
  // The king never moves off BASE.y+18, i.e. z=+1.125 with a .26 body radius, so he occupies
  // z .865-1.385 right where a slab tucked against the plinth would go. The step therefore sits at
  // the HEAD OF THE PATH (back face z=1.405) and the king stands on the pad between it and the
  // door; anything nearer the wall would be drawn through his legs.
  const step = meshOf(new THREE.BoxGeometry(.90,.14,.55), flat(PAL.keepTrim));
  step.position.set(0, Y0 + .07, 1.68);
  // One arrow slit high on the same face, so the tower still has an eye when the king is standing
  // in the doorway. The wall has drawn back to z=.78 by this height, so .87 clears it.
  const slit = meshOf(new THREE.BoxGeometry(.20,.42,.14), flat(PAL.doorway));
  slit.position.set(0, 2.80, .80);
  // Worn approach across the courtyard. cast=false, exactly like the pad: no outline shell, no
  // shadow, and invisible to blockerMeshes() so it can never occlude a unit.
  // Reaches z=2.70, so even at the store pulse's peak 1.1x group scale it stays inside the pad.
  const path = meshOf(new THREE.BoxGeometry(.60,.05,1.60), flat(PAL.dirt), false, true);
  path.position.set(0, Y0 + .02, 1.90);
  g.add(door, step, slit, path);
  // Three low props, all well under the doorway's 1.38 and well inside the pad: two gate posts
  // flanking the path and a small stack of cut stone in a back corner. The rest stays open.
  for(const px of [-.62, .62]){
    const post = meshOf(new THREE.BoxGeometry(.28,.36,.28), flat(PAL.keepTrim));
    post.position.set(px, Y0 + .18, 2.45); g.add(post);
  }
  const block = meshOf(new THREE.BoxGeometry(.52,.30,.52), flat(PAL.stone));
  block.position.set(-1.85, Y0 + .15, -1.95);
  const blockTop = meshOf(new THREE.BoxGeometry(.34,.24,.34), flat(PAL.stone));
  blockTop.position.set(-1.78, Y0 + .30 - LAP + .12, -2.02);
  const floor = makeFootprintFloor(BASE.footprint);
  g.add(floor, block, blockTop);
  g.position.set(gx(BASE.x), 0, gz(BASE.y));
  g.userData = {body, floor};
  return g;
}
function makeKing(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.CapsuleGeometry(.26,.44,3,7), flat(PAL.kingRobe));
  body.position.y = .58;
  const head = meshOf(new THREE.SphereGeometry(.24,8,6), flat(PAL.skin));
  head.position.y = 1.12;
  const crown = meshOf(new THREE.CylinderGeometry(.26,.26,.2,6), flat(PAL.kingCrown));
  crown.position.y = 1.36;
  const sword = meshOf(new THREE.BoxGeometry(.08,.86,.08), flat(PAL.blade));
  sword.position.set(.38,.86,0);
  g.add(body, head, crown, sword);
  g.userData = {sword};
  return g;
}

// ── footprint floors ────────────────────────────────────────────────────────
// A low pad covering exactly the cells canPlace() reserves for `type`. Every dimension is derived
// from the footprint metadata (fp.w/fp.h in CELLS -> game px -> world units), so the tower's 3x3
// pad and a deployable's single cell come from the same expression and nothing restates a size.
// The model keeps its own scale and stays centred on the anchor; the pad is what grows.
// Ownership: geometry and material are built PER INSTANCE. Building groups are torn down wholesale
// by disposeGroup(), so nothing parented into one may share a geometry or material with anything else.
const FLOOR_H = .09;          // pad thickness in world units
const FLOOR_LIFT = .006;      // bottom face held clear of the ground plane
const FLOOR_TOP = FLOOR_LIFT + FLOOR_H;
// Takes the footprint itself, not a type, so the base (which has no BUILDING_TYPES entry) uses the
// same pad path as everything else.
function makeFootprintFloor(fp, color=PAL.pad){
  // cast=false: no outline shell, no shadow casting, and therefore invisible to blockerMeshes().
  const m = meshOf(new THREE.BoxGeometry(fp.w*CELL*S, FLOOR_H, fp.h*CELL*S), flat(color), false, true);
  m.position.y = FLOOR_LIFT + FLOOR_H/2;   // box bottom sits just above y=0, so no coplanar ground face
  return m;
}

function makeBuilding(type){
  const g = new THREE.Group();
  const parts = [];
  const add = (m)=>{ g.add(m); parts.push(m); return m; };
  if(type==="tower"){
    for(const [dx,dz] of [[-.5,-.5],[.5,-.5],[-.5,.5],[.5,.5]]){
      const leg = add(meshOf(new THREE.BoxGeometry(.2,3.0,.2), flat(PAL.timber)));
      leg.position.set(dx,1.5,dz);
    }
    const deck = add(meshOf(new THREE.BoxGeometry(1.7,.3,1.7), flat(PAL.timber)));
    deck.position.y = 3.1;
    const roof = add(meshOf(new THREE.ConeGeometry(1.4,1.0,4), flat(PAL.timberDark)));
    roof.position.y = 3.8; roof.rotation.y = Math.PI/4;
    g.userData.roof = roof;
  } else if(type==="house"){
    const b = add(meshOf(new THREE.BoxGeometry(2.4,1.6,2.0), flat(PAL.plaster))); b.position.y=.8;
    const r = add(meshOf(new THREE.ConeGeometry(1.9,1.2,4), flat(PAL.roof))); r.position.y=2.2; r.rotation.y=Math.PI/4;
  } else if(type==="lumber"){
    const b = add(meshOf(new THREE.BoxGeometry(2.4,1.3,1.9), flat(PAL.scaffold))); b.position.y=.65;
    const r = add(meshOf(new THREE.BoxGeometry(2.7,.28,2.2), flat(PAL.roofDark))); r.position.y=1.42;
    const log = add(meshOf(new THREE.CylinderGeometry(.22,.22,1.8,6), flat(PAL.wood)));
    log.rotation.x=Math.PI/2; log.position.set(1.1,.24,.9);
  } else if(type==="quarry"){
    const b = add(meshOf(new THREE.BoxGeometry(2.3,1.2,1.9), flat(PAL.quarryWall))); b.position.y=.6;
    const r = add(meshOf(new THREE.ConeGeometry(1.7,.9,5), flat(PAL.quarryRoof))); r.position.y=1.6;
    const s = add(meshOf(new THREE.DodecahedronGeometry(.45,0), flat(PAL.stone))); s.position.set(1.1,.3,.9);
  } else if(type==="stockpile"){
    const p = add(meshOf(new THREE.BoxGeometry(2.6,.24,2.2), flat(PAL.scaffold))); p.position.y=.12;
    const c1 = add(meshOf(new THREE.BoxGeometry(.9,.7,.9), flat(PAL.wood))); c1.position.set(-.6,.55,0);
    const c2 = add(meshOf(new THREE.BoxGeometry(.8,.55,.8), flat(PAL.stone))); c2.position.set(.65,.48,.2);
  } else if(type==="obelisk"){
    const b = add(meshOf(new THREE.BoxGeometry(1.5,.4,1.5), flat(PAL.masonryDark))); b.position.y=.2;
    const sh = add(meshOf(new THREE.CylinderGeometry(.36,.52,3.0,5), flat(PAL.masonry))); sh.position.y=1.9;
    const tip = add(meshOf(new THREE.OctahedronGeometry(.44,0), flat(PAL.arcane,{emissive:PAL.arcaneGlow}))); tip.position.y=3.7;
    g.userData.tip = tip;
  } else if(type==="blast"){
    const b = add(meshOf(new THREE.CylinderGeometry(.55,.62,.8,8), flat(PAL.chargeBody))); b.position.y=.4;
    const t = add(meshOf(new THREE.SphereGeometry(.28,8,6), flat(PAL.charge))); t.position.y=.95;
  } else if(type==="landmine"){
    const b = add(meshOf(new THREE.CylinderGeometry(.5,.55,.4,8), flat(PAL.chargeBody))); b.position.y=.2;
    const t = add(meshOf(new THREE.CylinderGeometry(.14,.14,.3,6), flat(PAL.fuse))); t.position.y=.52;
  } else if(type==="spikes"){
    for(let i=0;i<5;i++){
      const s = add(meshOf(new THREE.ConeGeometry(.16,.85,4), flat(PAL.metal)));
      s.position.set((i%3-1)*.55, .42, (Math.floor(i/3)-.5)*.6);
    }
  } else if(type==="tar"){
    const p = add(meshOf(new THREE.CylinderGeometry(1.15,1.15,.12,14), flat(PAL.tar))); p.position.y=.06;
  } else {
    const b = add(meshOf(new THREE.BoxGeometry(2,1.4,1.8), flat(PAL.blueprint))); b.position.y=.7;
  }
  // Added after `parts` is filled and deliberately NOT pushed into it: the tower hurt-flash and the
  // ghost tint iterate `parts`/meshes for the MODEL, and the ground pad must not join those effects.
  const floor = makeFootprintFloor(buildingFootprint(type));
  g.add(floor);
  g.userData.floor = floor;
  g.userData.parts = parts;
  return g;
}
// Blueprints are footprint-aware too: same pad the finished building will get, so completing a
// structure never changes the ground it reserved. Posts ride the footprint corners.
function makeBlueprint(type){
  const g = new THREE.Group();
  const fp = buildingFootprint(type);
  const w = fp.w*CELL*S, d = fp.h*CELL*S;
  const pad = makeFootprintFloor(buildingFootprint(type), PAL.scaffold);
  g.add(pad);
  g.userData.floor = pad;
  const post = .18, ix = w/2 - post/2 - .06, iz = d/2 - post/2 - .06;
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    const p = meshOf(new THREE.BoxGeometry(post,1.1,post), flat(PAL.blueprint));
    p.position.set(sx*ix, FLOOR_TOP + .55, sz*iz);
    g.add(p);
  }
  return g;
}

// ─────────────────────────────────────────────────────────── pooling
/** Keeps one group per live entity; builds on first sight, disposes when gone. */
function makeLayer(build, update){
  const store = new Map();
  const seen = new Set();
  return function sync(list){
    seen.clear();
    for(const e of list){
      let g = store.get(e);
      if(!g){
        g = build(e);
        g.traverse(o=>{ if(o.isMesh) o.userData.ent = e; });   // for the occlusion test
        scene.add(g); store.set(e,g);
      }
      seen.add(e);
      g.visible = true;
      update(g,e);
    }
    for(const [e,g] of store){
      if(seen.has(e))continue;
      scene.remove(g); disposeGroup(g); store.delete(e);
    }
  };
}
function disposeGroup(g){
  g.traverse(o=>{
    if(!o.isMesh) return;
    if(isOutline(o)){                        // shares its parent's geometry and
      const i = outlineShells.indexOf(o);     // one global material — drop the
      if(i >= 0) outlineShells.splice(i, 1);  // reference, dispose neither
      return;
    }
    o.geometry.dispose();
    if(o.material.dispose) o.material.dispose();
  });
}
const setXZ = (g,e,y=0)=>g.position.set(gx(e.x), y, gz(e.y));
const shakeOf = e => e.shake ? Math.sin(e.shake*28)*.12 : 0;

const syncTrees = makeLayer(makeTree, (g,t)=>{
  setXZ(g,t);
  const d = g.userData, felled = t.stump>0;
  d.trunk.visible = d.crown.visible = !felled;
  d.stump.visible = felled;
  g.rotation.z = felled ? 0 : shakeOf(t);
  const wear = felled ? 1 : .78 + .22*(t.hp/t.max);
  g.scale.set(wear, wear*view.heightScale/100, wear);
});
const syncRocks = makeLayer(makeRock, (g,r)=>{
  setXZ(g,r);
  const d = g.userData, spent = r.depleted>0;
  for(const m of d.live) m.visible = !spent;
  d.rubble.visible = spent;
  g.rotation.z = spent ? 0 : shakeOf(r);
  const wear = spent ? 1 : .8 + .2*(r.hp/r.max);
  g.scale.set(wear, wear*view.heightScale/100, wear);
});
const syncDiamonds = makeLayer(makeDiamond, (g,n)=>{
  setXZ(g,n);
  const d = g.userData, spent = n.depleted>0;
  for(const m of d.live) m.visible = !spent;
  d.spent.visible = spent;
  g.rotation.z = spent ? 0 : shakeOf(n);
  if(!spent) d.gem.rotation.y += .02;
  g.scale.y = view.heightScale/100;
});
const syncDrops = makeLayer(e=>makeDrop(e.kind), (g,r)=>{
  if(r.target==="hand"){
    // Flying to the cursor: parabolic hop, fast tumble, shrinking as it lands.
    const p = clamp(r.t,0,1);
    setXZ(g, r, Math.sin(p*Math.PI)*VIEW_TUNE.handArc + p*2.2);
    g.rotation.x += .30; g.rotation.y += .22;
    g.scale.setScalar(1 - .45*p);
    g.userData.body.visible = true;
    return;
  }
  setXZ(g, r, 0);
  g.rotation.set(0, r.spin*.25, 0);      // sim spins at 4 rad/s; that reads far too fast
  g.scale.setScalar(1);
  const fading = r.ttl!==null && r.ttl<2 && Math.floor(r.ttl*7)%2===0;
  g.userData.body.visible = !fading;
});
const syncEnemies = makeLayer(e=>makeEnemy(e.type), (g,e)=>{
  const def = ENEMY_TYPES[e.type], s = def.size;
  setXZ(g,e, Math.abs(Math.sin(e.wob))*.1);
  g.scale.set(s, s*view.heightScale/100, s);
  g.rotation.z = Math.sin(e.wob)*.09;                    // the wobble-walk
  const d = g.userData;
  d.body.material.color.setHex(e.flash ? PAL.flash : d.baseColor);
  const burning = !!e.status?.burn;
  d.body.material.emissive.setHex(burning ? PAL.emberGlow : 0x000000);
});
const syncWorkers = makeLayer(makeWorker, (g,w)=>{
  const t = performance.now()/1000;
  if(w===heldWorker() && state.mouse.inside){
    // Lifted units ride the cursor, exactly like the demo's carried object.
    g.position.set(gx(state.mouse.x), 2.2 + Math.sin(t*5)*.14, gz(state.mouse.y));
    g.rotation.z = Math.sin(t*7)*.13;
  } else {
    setXZ(g,w, Math.abs(Math.sin(w.step*8))*.08);
    g.rotation.z = Math.sin(w.step*8)*.10;
  }
  g.scale.y = view.heightScale/100;
  const d = g.userData;
  d.body.material.color.set(workerCoatColor(w));
  const load = workerLoad(w);
  d.load.visible = load>0;
  if(load){
    const k = w.carried.diamond?"diamond":w.carried.coin?"coin":w.carried.dust?"dust":w.carried.stone?"stone":"wood";
    d.load.material.color.setHex(DROP_COLOR[k]);
  }
  const tool = workerToolKind(w);
  const swinging = (w.combatTarget && w.attackCooldown>WORKER_ATTACK_RATE-.2) ||
                   (tool && w.hitCooldown>WORKER_HIT_COOLDOWN-.2);
  d.tool.rotation.z = swinging ? -1.1 : .25;
});
const syncCorpses = makeLayer(c=>makeCorpse(c.coat), (g,c)=>{
  g.position.set(gx(c.x+c.pose), .1, gz(c.y+c.pose*.35));
  g.rotation.y = c.flip<0 ? Math.PI : 0;
});

// Buildings swap their whole mesh when they finish or change tower variant.
const buildingStore = new Map();
function syncBuildings(){
  const seen = new Set();
  for(const b of buildings){
    // The blueprint key carries its type now that the blueprint pad is footprint-sized.
    const key = b.complete ? (b.type==="tower" ? "tower:"+(b.tower?.variant||"basic") : b.type) : "blueprint:"+b.type;
    let rec = buildingStore.get(b);
    if(!rec || rec.key!==key){
      if(rec){ scene.remove(rec.g); disposeGroup(rec.g); }
      const g = b.complete ? makeBuilding(b.type) : makeBlueprint(b.type);
      if(b.complete && b.type==="tower" && g.userData.roof)
        g.userData.roof.material.color.setHex(TOWER_TOP[b.tower?.variant] ?? PAL.timberDark);
      g.traverse(o=>{ if(o.isMesh) o.userData.ent = b; });
      scene.add(g);
      rec = {key, g};
      buildingStore.set(b, rec);
    }
    seen.add(b);
    rec.g.visible = true;
    setXZ(rec.g, b);
    rec.g.scale.y = view.heightScale/100;
    const pulse = 1 + (b.pulse||0)*.12;
    rec.g.scale.x = rec.g.scale.z = pulse;
    // The pad marks RESERVED CELLS, so it must not breathe with the pulse: undo the group's
    // horizontal scale on the floor alone. Its extents then always equal the placement preview's.
    if(rec.g.userData.floor) rec.g.userData.floor.scale.set(1/pulse, 1, 1/pulse);
    if(b.complete && b.type==="tower" && b.tower){
      const hurt = b.tower.hitFlash>0;
      for(const p of rec.g.userData.parts||[]) p.material.emissive.setHex(hurt?PAL.hurtGlow:0x000000);
    }
    if(rec.g.userData.tip) rec.g.userData.tip.rotation.y += .02;
  }
  for(const [b,rec] of buildingStore){
    if(seen.has(b))continue;
    scene.remove(rec.g); disposeGroup(rec.g); buildingStore.delete(b);
  }
}

const baseMesh = makeBase(); scene.add(baseMesh);
const kingMesh = makeKing(); scene.add(kingMesh);

// ─────────────────────────────────────────────────────────── ground rings (zones)
const ringGeo = new THREE.RingGeometry(.985,1,64);
const ringPool = [];
let ringUsed = 0;
function ring(x, y, radiusPx, color=css(PAL.hint), opacity=.6){
  let m = ringPool[ringUsed];
  if(!m){
    m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      transparent:true, side:THREE.DoubleSide, depthWrite:false}));
    m.rotation.x = -Math.PI/2;
    ringPool.push(m); scene.add(m);
  }
  ringUsed++;
  m.visible = true;
  m.position.set(gx(x), .09, gz(y));
  m.scale.setScalar(radiusPx*S);
  m.material.color.set(color);
  m.material.opacity = opacity;
  return m;
}
function endRings(){ for(let i=ringUsed;i<ringPool.length;i++) ringPool[i].visible=false; ringUsed=0; }

// ─────────────────────────────────────────────────────────── attack visuals
// Every ranged attack already records where it fired and a decaying flash; the
// sim applies damage instantly, so these are pure feedback drawn from that.
const beamGeo = new THREE.CylinderGeometry(1,1,1,6,1,true);
const flashGeo = new THREE.IcosahedronGeometry(1,0);
const beamPool = [], flashPool = [];
let beamUsed = 0, flashUsed = 0;
const _bA = new THREE.Vector3(), _bB = new THREE.Vector3(), _bD = new THREE.Vector3();
const _upY = new THREE.Vector3(0,1,0);

/** A cylinder stretched between two points, both in game (x, y) plus world height. */
function beam(x1,y1,h1, x2,y2,h2, radius, color, alpha){
  _bA.set(gx(x1), h1, gz(y1));
  _bB.set(gx(x2), h2, gz(y2));
  _bD.subVectors(_bB, _bA);
  const len = _bD.length();
  if(len < 1e-4) return;

  let m = beamPool[beamUsed];
  if(!m){
    m = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({transparent:true, depthWrite:false}));
    beamPool.push(m); scene.add(m);
  }
  beamUsed++;
  m.visible = true;
  m.position.copy(_bA).addScaledVector(_bD, .5);
  m.quaternion.setFromUnitVectors(_upY, _bD.normalize());
  m.scale.set(radius, len, radius);
  m.material.color.set(color);
  m.material.opacity = clamp(alpha, 0, 1);
}
function muzzle(x, y, h, size, color, alpha){
  let m = flashPool[flashUsed];
  if(!m){
    m = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({transparent:true, depthWrite:false}));
    flashPool.push(m); scene.add(m);
  }
  flashUsed++;
  m.visible = true;
  m.position.set(gx(x), h, gz(y));
  m.scale.setScalar(size);
  m.material.color.set(color);
  m.material.opacity = clamp(alpha, 0, 1);
}
function endAttacks(){
  for(let i=beamUsed;i<beamPool.length;i++) beamPool[i].visible=false;
  for(let i=flashUsed;i<flashPool.length;i++) flashPool[i].visible=false;
  beamUsed = flashUsed = 0;
}

// ── travelling shots ────────────────────────────────────────────────────────
// Purely visual. The sim resolves damage the instant a tower fires, so these
// balls are a short flight after the fact — kept brief enough that the target
// has not visibly reacted before the shot lands.
const SHOT_GEO = new THREE.DodecahedronGeometry(.30, 0);
const shotPool = [], shots = [], impacts = [];
const lastFlash = new WeakMap();

function spawnShot(x1,y1,h1, x2,y2,h2, color, size, arc, impact){
  const from = new THREE.Vector3(gx(x1), h1, gz(y1));
  const to   = new THREE.Vector3(gx(x2), h2, gz(y2));
  let mesh = shotPool.pop();
  if(!mesh){
    mesh = new THREE.Mesh(SHOT_GEO, new THREE.MeshLambertMaterial({flatShading:true}));
    mesh.castShadow = false;                  // keeps them out of the occlusion scan
    scene.add(mesh);
  }
  mesh.visible = true;
  mesh.material.color.set(color);
  mesh.scale.setScalar(size*VIEW_TUNE.shotSize);
  shots.push({mesh, from, to, t:0,
    dur: clamp(from.distanceTo(to)/VIEW_TUNE.shotSpeed, .1, .9),
    arc: arc*VIEW_TUNE.shotArc, impact});
}

function stepShots(dt){
  for(let i=shots.length-1; i>=0; i--){
    const s = shots[i];
    s.t += dt/s.dur;
    const p = Math.min(s.t, 1);
    s.mesh.position.lerpVectors(s.from, s.to, p);
    s.mesh.position.y += Math.sin(p*Math.PI)*s.arc;
    s.mesh.rotation.x += dt*13;
    s.mesh.rotation.y += dt*9;
    if(p < 1) continue;
    s.mesh.visible = false;
    shotPool.push(s.mesh);
    shots.splice(i, 1);
    if(s.impact) impacts.push({...s.impact, t:0});
  }
  for(let i=impacts.length-1; i>=0; i--){
    impacts[i].t += dt/0.28;
    if(impacts[i].t >= 1) impacts.splice(i, 1);
  }
}

function drawAttacks(){
  const hs = view.heightScale/100;

  for(const b of buildings){
    if(!b.complete || b.type!=="tower" || !b.tower) continue;
    const t = b.tower, v = towerVariant(b);
    const col = v.impactColor || v.accent || css(PAL.ok);
    const topH = 3.4*hs;                       // the tower deck
    const area = v.attackMode==="periodic area" || v.attackMode==="manual area";

    // A rising flash means it just fired. Launch the visual for that shot.
    const prev = lastFlash.get(b) ?? 0;
    if(t.flash > prev){
      if(v.attackMode==="splash" && t.impactX!==undefined)
        spawnShot(b.x,b.y,topH, t.impactX,t.impactY, .35, col, 1.6, 2.4,
                  {x:t.impactX, y:t.impactY, r:v.splashRadius||40, col});
      else if(!area && v.attackMode!=="line" && t.targetX!==undefined)
        spawnShot(b.x,b.y,topH, t.targetX,t.targetY, .7, col, 1, 1.0, null);
    }
    lastFlash.set(b, t.flash);

    if(t.flash <= 0) continue;
    const a = clamp(t.flash*3.2, 0, 1);
    if(area){
      // Shockwave grows outward as the flash decays.
      const grow = 1 - clamp(t.flash/.4, 0, 1);
      ring(b.x, b.y, (v.effectRadius||60)*(.25+.75*grow), col, a*.85);
    } else if(v.attackMode==="line" && t.targetX!==undefined){
      beam(b.x, b.y, topH, t.targetX, t.targetY, .5, (v.beamWidth||10)*S*.5, col, a);
    }
    muzzle(b.x, b.y, topH, .22 + .42*a, col, a);
  }

  // Splash rings fire when the shell lands, not when the barrel flashes.
  for(const im of impacts)
    ring(im.x, im.y, im.r*(.3+.7*im.t), im.col, (1-im.t)*.9);

  for(const e of state.enemies){
    if(e.shotFlash > 0)
      beam(e.x, e.y, .8, e.shotX ?? BASE.x, e.shotY ?? BASE.y, .7, .055,
           "#d9b65f", clamp(e.shotFlash*7, 0, 1));
    if(e.healFlash > 0 && e.healX!==undefined)
      beam(e.x, e.y, 1.0, e.healX, e.healY, 1.0, .07,
           "#75c86d", clamp(e.healFlash*3, 0, 1));
  }

  for(const w of state.workers)
    if(w.combatTarget && w.attackCooldown > WORKER_ATTACK_RATE-.2)
      beam(w.x, w.y, .8, w.combatTarget.x, w.combatTarget.y, .7, .06, "#f3dfa3", .85);

  endAttacks();
}

// ─────────────────────────────────────────────────────────── occluded markers
// Populated by measureNow() in the debug layer, which already computes the
// hidden positions while it counts visibility.
const pins = new THREE.Group();
scene.add(pins);
const pinGeo = new THREE.ConeGeometry(.6,1.4,4);
const pinMat = new THREE.MeshBasicMaterial({color:PAL.pin, depthTest:false, transparent:true, opacity:.9});
function setPins(points){
  pins.clear();
  if(!view.ghostPins)return;
  for(const p of points){
    const m = new THREE.Mesh(pinGeo, pinMat);
    m.position.set(p.x, p.y + 3.4, p.z);
    m.rotation.x = Math.PI;          // point down at the thing you can't see
    m.renderOrder = 999;
    pins.add(m);
  }
}

// ─────────────────────────────────────────────────────────── particles
const partGeo = new THREE.BoxGeometry(.18,.18,.18);
const partPool = [];
let partUsed = 0;
function syncParticles(){
  partUsed = 0;
  for(const p of particles){
    let m = partPool[partUsed];
    if(!m){
      m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({transparent:true}));
      partPool.push(m); scene.add(m);
    }
    partUsed++;
    m.visible = true;
    m.position.set(gx(p.x), .45 + Math.max(0,p.life)*1.2, gz(p.y));
    m.material.color.set(p.col);
    m.material.opacity = clamp(p.life*3,0,1);
    const s = p.resource ? 1.6 : 1;
    m.scale.setScalar(s);
  }
  for(let i=partUsed;i<partPool.length;i++) partPool[i].visible=false;
}

// ─────────────────────────────────────────────────────────── the hand
// state.carried is just counts, so the pile is rebuilt whenever those change.
// Golden-angle stacking keeps it legible as it grows past a couple of items.
const hand = new THREE.Group();
scene.add(hand);
const handItems = [];
let handSig = "";

function handMeshFor(kind){
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.13,.13,.62,6), flat(col)); m.rotation.z = Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.22,.22,.07,10), flat(col)); m.rotation.x = Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.24,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.22,0), flat(col));
  return m;
}
function syncHand(){
  const t = performance.now()/1000;
  const want = [];
  for(const kind of RESOURCE_KINDS)
    for(let i=0;i<state.carried[kind];i++) want.push(kind);

  const sig = want.join(",");
  if(sig !== handSig){
    const grew = want.length > handItems.length;
    for(const it of handItems){ hand.remove(it.mesh); it.mesh.geometry.dispose(); it.mesh.material.dispose(); }
    handItems.length = 0;
    want.forEach((kind,i)=>{
      const mesh = handMeshFor(kind);
      hand.add(mesh);
      const a = i*2.399, r = .26*Math.sqrt(i);
      handItems.push({mesh, phase:Math.random()*6.28,
        pop:(grew && i===want.length-1) ? 1 : 0,
        home:new THREE.Vector3(Math.cos(a)*r, i*.2, Math.sin(a)*r)});
    });
    handSig = sig;
  }

  hand.visible = state.mouse.inside && handItems.length>0;
  if(!hand.visible)return;
  hand.position.set(gx(state.mouse.x), 2.5 + Math.sin(t*5)*.09, gz(state.mouse.y));
  hand.rotation.y += .009;
  for(const it of handItems){
    it.mesh.position.set(it.home.x, it.home.y + Math.sin(t*3.2+it.phase)*.06, it.home.z);
    if(it.pop>0){ it.pop = Math.max(0, it.pop-.05); it.mesh.scale.setScalar(1 + it.pop*.9); }
  }
}

// ─────────────────────────────────────────────────────────── previews (ghosts)
const ghostBuild = {key:null, g:null};
function showGhostBuilding(type, x, y, ok, lift=0){
  const key = type;
  if(ghostBuild.key!==key){
    if(ghostBuild.g){ scene.remove(ghostBuild.g); disposeGroup(ghostBuild.g); }
    ghostBuild.g = makeBuilding(type);
    // The ghost's own pad is hidden: showFootprint() draws the reserved cells on the ground, and a
    // held building floats on the cursor, where a pad would just hang in the air.
    if(ghostBuild.g.userData.floor) ghostBuild.g.userData.floor.visible = false;
    // depthWrite off as well as transparent: a 1x1 model is wider than its cell, so a depth-writing
    // ghost would bury the reserved-cell quads underneath it and the footprint would go unseen.
    ghostBuild.g.traverse(o=>{ if(o.isMesh && !isOutline(o)){ o.material.transparent=true; o.material.opacity=.5; o.material.depthWrite=false; o.castShadow=false; } });
    scene.add(ghostBuild.g);
    ghostBuild.key = key;
  }
  ghostBuild.g.visible = true;
  ghostBuild.g.position.set(gx(x), lift, gz(y));
  ghostBuild.g.traverse(o=>{ if(o.isMesh && !isOutline(o)) o.material.emissive.setHex(ok?PAL.ghostOk:PAL.ghostBad); });
}
function hideGhostBuilding(){ if(ghostBuild.g) ghostBuild.g.visible=false; }

// ── footprint preview ───────────────────────────────────────────────────────
// One tinted quad per cell footprintCells() reserves, plus a border on the footprint's exact world
// rect. The player sees the same cells canPlace() tested and the same rectangle the finished floor
// will cover, so the preview and the committed pad share one source of dimensions.
// Depth: the quads ride just above the tallest pad (FLOOR_TOP) so an invalid placement over an
// existing building still shows red instead of being swallowed by that building's own floor. They
// keep depthTest on — trees and towers still occlude them correctly — with depthWrite off and a
// negative polygon offset so nothing coplanar (a tar puddle, another pad) can flicker against them.
// Ownership: these live directly in the scene, never inside a group disposeGroup() will visit, so
// their geometry and materials are shared module singletons and are never disposed.
const CELL_U = CELL*S;                 // one cell in world units
const GHOST_Y = FLOOR_TOP + .035;
const CELL_GAP = .07;                  // hairline seam so each reserved cell reads as its own square
const cellGeo = new THREE.PlaneGeometry(1,1);
const edgeGeo = new THREE.BufferGeometry().setAttribute("position",
  new THREE.Float32BufferAttribute([-.5,0,-.5,  .5,0,-.5,  .5,0,.5,  -.5,0,.5], 3));
const cellMat = ok => new THREE.MeshBasicMaterial({
  color: ok?PAL.cellOk:PAL.cellBad, transparent:true, opacity:.34, depthWrite:false,
  side:THREE.DoubleSide, polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2});
const edgeMat = ok => new THREE.LineBasicMaterial({
  color: ok?PAL.cellOk:PAL.cellBad, transparent:true, opacity:.85, depthWrite:false});
const CELL_MAT = {ok:cellMat(true), bad:cellMat(false)};
const EDGE_MAT = {ok:edgeMat(true), bad:edgeMat(false)};
const cellPool = [];
let footprintEdge = null;

function showFootprint(type, x, y, ok){
  const fp = buildingFootprint(type), c = worldToCell(x, y);
  const cells = footprintCells(c.cx, c.cy, fp);
  for(let i=0;i<cells.length;i++){
    let m = cellPool[i];
    if(!m){
      m = new THREE.Mesh(cellGeo, CELL_MAT.ok);
      m.rotation.x = -Math.PI/2;                 // plane XY -> ground XZ
      m.castShadow = m.receiveShadow = false;    // never a shadow caster => never an occlusion blocker
      m.renderOrder = 2;
      cellPool.push(m); scene.add(m);
    }
    const w = cellToWorld(cells[i].cx, cells[i].cy);
    m.visible = true;
    m.material = ok?CELL_MAT.ok:CELL_MAT.bad;
    m.position.set(gx(w.x), GHOST_Y, gz(w.y));
    m.scale.set(CELL_U-CELL_GAP, CELL_U-CELL_GAP, 1);
  }
  for(let i=cells.length;i<cellPool.length;i++) cellPool[i].visible=false;
  // The border is the authority on extents: exactly footprintWorldRect(), the rect the pad fills.
  if(!footprintEdge){
    footprintEdge = new THREE.LineLoop(edgeGeo, EDGE_MAT.ok);
    footprintEdge.castShadow = footprintEdge.receiveShadow = false;
    footprintEdge.renderOrder = 3;
    scene.add(footprintEdge);
  }
  const r = footprintWorldRect(c.cx, c.cy, fp);
  footprintEdge.visible = true;
  footprintEdge.material = ok?EDGE_MAT.ok:EDGE_MAT.bad;
  footprintEdge.position.set(gx(r.x+r.w/2), GHOST_Y+.004, gz(r.y+r.h/2));
  footprintEdge.scale.set(r.w*S, 1, r.h*S);
}
function hideFootprint(){
  for(const m of cellPool) m.visible=false;
  if(footprintEdge) footprintEdge.visible=false;
}

// ── selection indicators ────────────────────────────────────────────────────
// Two reusable ground marks — a four-cornered selector bracket and a segmented radius ring — built
// here. drawZones() aims both: the selector at the primary-action target, at the footprint of a
// building being placed or relocated, and at the footprint of the completed building under the
// cursor; the radius ring at that building's real coverage.
//
// Data flow (render-only): every call is (where, how big, what colour). Neither function reads or
// writes simulation state, keeps a reference to an entity, or remembers a selection between frames,
// so the sim stays the only owner of positions, footprints and radii. Claim-per-frame like the ring
// pool above: show*() claims the next free slot, end*() hides whatever went unclaimed, and hide*()
// drops the whole set — so callers never track slot indices.
//
// Dimensions: showSelector() takes the SAME rect shape footprintWorldRect() returns ({x,y,w,h}, sim
// pixels, top-left anchored). A selector around a placed building therefore reuses the exact rect
// its pad covers, cellWorldRect() supplies the one-CELL case out of the same lattice, and
// pointWorldRect() supplies it off-lattice for things that move continuously. No size is restated
// here — the footprint table stays the single source of dimensions.
//
// Ownership / geometry lifetime: both pools grow on demand and never shrink. A slot's group, meshes,
// materials and (for the radius ring) its position buffer live from first use until the page
// unloads. They are added straight to the scene, never parented into a group disposeGroup() visits,
// so nothing here is ever disposed and a redraw only rewrites transforms and colours — no mesh,
// geometry or material is allocated per frame. The selector arms share cellGeo, the unit quad the
// footprint preview above already owns. The radius ring cannot share one unit geometry because a
// uniform scale would fatten its band with the circle, so each slot owns one buffer that is
// REWRITTEN IN PLACE (same Float32Array, same mesh) only when that slot's radius actually changes.
//
// Depth: both ride above GHOST_Y, so they clear pads (FLOOR_TOP), previews and the footprint border
// without z-fighting; depthTest stays on so towers and trees still occlude them, with depthWrite off
// and a negative polygon offset so nothing coplanar can flicker against them.
//
// Exclusion: castShadow=false on every mesh keeps them out of blockerMeshes() (`isMesh && visible &&
// castShadow`) and therefore out of both the occlusion scan and the sun's shadow map — the same
// technique the footprint quads use. They are built with `new THREE.Mesh`, never meshOf(), so no
// outline shell is registered and setOutlines() cannot reach them. Hover picking raycasts the math
// ground plane (groundFromEvent), never scene objects, so they are unpickable by construction.
//
// Night: unlit MeshBasicMaterial, so they hold the same readable value under the night sun tint
// instead of going black, and low default opacity keeps them from dominating the frame.
const SELECT_Y = GHOST_Y + .016;      // above the footprint quads (GHOST_Y) and their border (+.004)
const RADIUS_Y = GHOST_Y + .010;
const NO_OPTS = Object.freeze({});    // shared default so an omitted opts bag allocates nothing

/** One-CELL rect, same shape as footprintWorldRect(), around the cell containing a world point. */
function cellWorldRect(x, y){
  const c = worldToCell(x, y);
  return footprintWorldRect(c.cx, c.cy, FOOTPRINT_1x1);
}
/**
 * Same rect shape and same footprint-derived size, but centred on the point itself instead of on the
 * cell containing it. For things that live off the lattice — enemies walk continuously, so snapping
 * their mark would make it jump a whole cell at a time while they slide.
 */
function pointWorldRect(x, y, footprint=FOOTPRINT_1x1){
  const w = footprint.w*CELL, h = footprint.h*CELL;
  return {x:x - w/2, y:y - h/2, w, h};
}

// ── shared indicator tunables ──
// PRESENTATION ONLY. Every field here changes how a mark is drawn and nothing else: no footprint is
// measured from these, no gameplay radius is derived from them, and indicatorRadius() never reads
// them. A ring's RADIUS in particular is always the simulation's own number — the breath below moves
// its opacity, never its size, so an indicator can never advertise coverage the sim does not have.
//
// All three call sites (the one-cell action bracket, the placement/relocation preview and the
// building-hover mark) go through indicatorPulse()/indicatorRingOpacity(), so one knob retimes or
// restyles the whole language at once and two marks alive on the same frame stay in phase.
const IND = {
  pulseAmt: .07,      // corner breath: half-amplitude as a fraction of the resting half-extent
  pulseSpeed: 4,      // rad/s, shared by corners and rings so they never beat against each other
  thick: .10,         // corner stroke width, world units
  cornerOpacity: .85, // corner brackets' base opacity, before the per-site weight below
  ringOpacity: .42,   // segmented ring's mid opacity, the centre of its breath
  follow: .28,        // cursor bracket glide: fraction of the remaining gap closed per 60Hz frame
};
// Hard ceiling on the breath, applied AFTER the per-site weight. The tightest case is a 1x1 bracket,
// where the arms are cut at .68 of a 1.0 half-extent: at .20 the corners pull in to .80 and still
// leave a .12 gap either side of the centre, so opposite brackets can never cross or fuse, and they
// never push out far enough to read as detached from the thing they frame. The slider is capped to
// the same number, so the clamp is a floor under a bad value rather than a surprise.
const IND_PULSE_MAX = .20;
// Per-site weights on IND.pulseAmt, written as ratios of the amplitudes this shipped with so the
// defaults reproduce the original look exactly while a single knob still scales all of them together.
const IND_PULSE_ACTION = 9/7;    // the one-cell action bracket breathes a touch deeper (.09 vs .07)
const IND_RING_PULSE   = 13/7;   // rings breathe in opacity, not size (.13 against the corners' .07)
// Same ratio trick for corner opacity: a placement/relocation verdict is the one mark the player is
// about to COMMIT to, so its corners sit a shade firmer than the informational ones (.90 vs .85).
const IND_OPACITY_PLACEMENT = 18/17;
// The idle bracket is the quietest state there is — nothing is under the pointer, it is only saying
// "the grid is here and this is the cell you are on" — so it sits well under the informational marks.
const IND_OPACITY_IDLE = .55;

/** Multiplier on a selector rect's half-extents at time t. weight scales the shared amplitude. */
function indicatorPulse(t, weight=1){
  return 1 + Math.sin(t*IND.pulseSpeed)*clamp(IND.pulseAmt*weight, 0, IND_PULSE_MAX);
}
/**
 * Opacity for a selector's corner brackets. weight scales the shared base the same way the pulse
 * weights do, and the clamp keeps a weighted site legal when the slider is pushed to 1.
 */
function indicatorCornerOpacity(weight=1){
  return clamp(IND.cornerOpacity*weight, 0, 1);
}
/**
 * Opacity for a segmented radius ring at time t. Amplitude is capped at three quarters of the base,
 * so a ring turned down to the slider's dimmest setting breathes SHALLOWER rather than blinking out
 * of existence at the bottom of every cycle — a coverage claim that vanishes is worse than a faint
 * one. The cap is far above the default amplitude (.315 vs .13), so it never bites at rest.
 */
function indicatorRingOpacity(t){
  const amp = Math.min(IND.pulseAmt*IND_RING_PULSE, IND.ringOpacity*.75);
  return clamp(IND.ringOpacity + Math.sin(t*IND.pulseSpeed)*amp, 0, 1);
}

// ── corner selector ──
// Four independent L brackets, one per corner of the rect, each made of two axis-aligned quads that
// meet without overlapping (an overlap would double-blend at the corner). Arm length tracks the
// rect's shorter side so a 1x1 and a 3x3 stay proportionate; stroke width (IND.thick) is a constant
// in world units so both read at the same weight — and, being a world measure, it grows and shrinks
// with the footprint it frames under camera zoom instead of drifting away from it.
const SEL_ARM_FRAC = .34;             // arm length as a share of the shorter side
const SEL_ARM_MIN = .35, SEL_ARM_MAX = 1.4;
const SEL_CORNERS = [[-1,-1],[1,-1],[1,1],[-1,1]];   // sign pairs, (x,z), in arm order
const selectorPool = [];
let selectorUsed = 0;

function makeSelector(){
  const g = new THREE.Group();
  // One material per slot (like the ring pool), so two live selectors can carry different colours.
  const mat = new THREE.MeshBasicMaterial({
    transparent:true, side:THREE.DoubleSide, depthWrite:false,
    polygonOffset:true, polygonOffsetFactor:-3, polygonOffsetUnits:-3});
  const arms = [];
  for(let i=0;i<SEL_CORNERS.length*2;i++){     // 4 corners x 2 arms
    const m = new THREE.Mesh(cellGeo, mat);    // shared unit quad, owned by the footprint block
    m.rotation.x = -Math.PI/2;                 // plane XY -> ground XZ, so it lies on the ground
    m.castShadow = m.receiveShadow = false;    // never a shadow caster => never an occlusion blocker
    m.renderOrder = 5;
    g.add(m); arms.push(m);
  }
  g.userData.arms = arms; g.userData.mat = mat;
  scene.add(g);
  return g;
}

/**
 * rect: {x,y,w,h} in sim pixels (footprintWorldRect / cellWorldRect / pointWorldRect).
 * opts: {color,opacity,pulse}.
 *
 * pulse is a multiplier on the rect's HALF-EXTENTS only — the four corners breathe outward and back
 * while stroke width and arm length hold still. Scaling the group instead would scale the stroke with
 * it, so a breathing selector would read as a thickening one; the group therefore stays at scale 1
 * and every arm keeps the size it was measured at from the resting rect.
 */
function showSelector(rect, opts=NO_OPTS){
  let g = selectorPool[selectorUsed];
  if(!g){ g = makeSelector(); selectorPool.push(g); }
  selectorUsed++;
  const hw0 = rect.w*S/2, hh0 = rect.h*S/2;    // resting half-extents: the size the strokes are cut from
  // Cap the arm at the half-extent so opposite brackets can never meet and close into an outline.
  const arm = Math.min(clamp(Math.min(hw0,hh0)*2*SEL_ARM_FRAC, SEL_ARM_MIN, SEL_ARM_MAX), hw0, hh0);
  const t = Math.min(IND.thick, arm*.5);       // keeps the second arm's length (arm-t) positive
  // Only the corner OFFSETS breathe; arm and t above were measured before this and are not touched.
  const pulse = opts.pulse ?? 1;
  const hw = hw0*pulse, hh = hh0*pulse;
  const arms = g.userData.arms;
  for(let c=0;c<SEL_CORNERS.length;c++){
    const sx = SEL_CORNERS[c][0], sz = SEL_CORNERS[c][1], cx = sx*hw, cz = sz*hh;
    const along = arms[c*2], across = arms[c*2+1];
    along.position.set(cx - sx*arm/2, 0, cz - sz*t/2);          // x-arm: full length, one stroke deep
    along.scale.set(arm, t, 1);
    across.position.set(cx - sx*t/2, 0, cz - sz*(t + (arm-t)/2)); // z-arm: starts where the x-arm ends
    across.scale.set(t, arm-t, 1);
  }
  g.visible = true;
  g.position.set(gx(rect.x + rect.w/2), SELECT_Y, gz(rect.y + rect.h/2));
  const mat = g.userData.mat;
  mat.color.set(opts.color ?? css(PAL.ok));
  mat.opacity = opts.opacity ?? .8;
  return g;
}
function endSelectors(){ for(let i=selectorUsed;i<selectorPool.length;i++) selectorPool[i].visible=false; selectorUsed=0; }
function hideSelectors(){ for(const g of selectorPool) g.visible=false; selectorUsed=0; }

// ── segmented radius ring ──
// Exactly 12 arcs: three per quadrant, hairline gaps between the three, and a wider break centred on
// each cardinal axis so the four groups read as separate. The four spans tile a full circle exactly:
// 3*span + 2*SEG_GAP + QUAD_GAP == PI/2 by construction.
const RING_SEGS = 12, RING_PER_QUAD = 3, RING_STEPS = 6;   // 3 per quadrant x 4 quadrants
const RING_QUAD_GAP = .17, RING_SEG_GAP = .055;            // radians: group break, in-group gap
const RING_BAND = .22;                                     // band width in world units, radius-independent
// Angles are fixed; only the radii change, so cos/sin are precomputed once for the whole ring.
const RING_ANGLES = (()=>{
  const span = (Math.PI/2 - RING_QUAD_GAP - (RING_PER_QUAD-1)*RING_SEG_GAP)/RING_PER_QUAD;
  const out = [];
  for(let q=0;q<4;q++){
    const start = q*Math.PI/2 + RING_QUAD_GAP/2;           // half the break sits either side of the axis
    for(let s=0;s<RING_PER_QUAD;s++){
      const a0 = start + s*(span + RING_SEG_GAP);
      for(let k=0;k<=RING_STEPS;k++) out.push(a0 + span*k/RING_STEPS);
    }
  }
  return out;                                              // RING_SEGS*(RING_STEPS+1) angles, draw order
})();
const RING_COS = RING_ANGLES.map(a=>Math.cos(a)), RING_SIN = RING_ANGLES.map(a=>Math.sin(a));
// Vertex i of RING_ANGLES contributes an inner vertex (2i) and an outer vertex (2i+1); each arc is a
// strip of RING_STEPS quads. Index order is constant, so one shared array seeds every slot.
const RING_INDEX = (()=>{
  const idx = [];
  for(let s=0;s<RING_SEGS;s++){
    const base = s*(RING_STEPS+1)*2;
    for(let k=0;k<RING_STEPS;k++){
      const v = base + k*2;
      idx.push(v, v+1, v+3, v, v+3, v+2);
    }
  }
  return idx;
})();
function writeRadiusRing(arr, rIn, rOut){
  for(let i=0;i<RING_COS.length;i++){
    const c = RING_COS[i], s = RING_SIN[i], o = i*6;
    arr[o]   = c*rIn;  arr[o+1] = 0; arr[o+2] = s*rIn;
    arr[o+3] = c*rOut; arr[o+4] = 0; arr[o+5] = s*rOut;
  }
}
const radiusPool = [];
let radiusUsed = 0;

/** Centre in sim pixels, radius in sim pixels. opts: {color, opacity, pulse}. */
function showRadiusRing(x, y, radiusPx, opts=NO_OPTS){
  let rec = radiusPool[radiusUsed];
  if(!rec){
    const geo = new THREE.BufferGeometry();
    // BufferAttribute (not Float32BufferAttribute) so the array is kept by reference and can be
    // rewritten in place; setIndex() builds this slot's own index attribute from the shared list.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RING_COS.length*6), 3));
    geo.setIndex(RING_INDEX);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      transparent:true, side:THREE.DoubleSide, depthWrite:false,
      polygonOffset:true, polygonOffsetFactor:-3, polygonOffsetUnits:-3}));
    mesh.castShadow = mesh.receiveShadow = false;   // keeps it out of blockerMeshes()/shadow map
    mesh.renderOrder = 4;
    scene.add(mesh);
    rec = {mesh, arr:geo.attributes.position.array, radius:-1};
    radiusPool.push(rec);
  }
  radiusUsed++;
  const r = Math.max(RING_BAND, radiusPx*S);
  if(rec.radius !== r){                             // rebuild only when this slot's radius moves
    writeRadiusRing(rec.arr, r - RING_BAND, r);
    rec.mesh.geometry.attributes.position.needsUpdate = true;
    rec.mesh.geometry.computeBoundingSphere();
    rec.radius = r;
  }
  rec.mesh.visible = true;
  rec.mesh.position.set(gx(x), RADIUS_Y, gz(y));
  rec.mesh.scale.setScalar(opts.pulse ?? 1);
  rec.mesh.material.color.set(opts.color ?? css(PAL.hint));
  rec.mesh.material.opacity = opts.opacity ?? .55;
  return rec.mesh;
}
function endRadiusRings(){ for(let i=radiusUsed;i<radiusPool.length;i++) radiusPool[i].mesh.visible=false; radiusUsed=0; }
function hideRadiusRings(){ for(const rec of radiusPool) rec.mesh.visible=false; radiusUsed=0; }

// Held workers are the real mesh lifted onto the cursor (see syncWorkers), so
// there is no worker ghost — only the drop-target ring below it.

// ─────────────────────────────────────────────────────────── 2D overlay
const _pv = new THREE.Vector3();
/** game (x,y) plus height in game px -> overlay canvas coords (960x540). */
function project(x, y, hpx=0){
  _pv.set(gx(x), hpx*S, gz(y)).project(camera3);
  return {x:(_pv.x*.5+.5)*VIEW_W, y:(-_pv.y*.5+.5)*VIEW_H, depth:_pv.z};
}
/** Health / progress readout. Same capsule as the chop bar, dark-rimmed. */
// ── overlay sizing (view panel > bars) ──────────────────────────────────────
// Overlay marks are drawn in fixed screen pixels, so without scaling they
// dwarf the world when zoomed out and vanish when zoomed in.
const BARS = {
  wMul:1, h:6,            // track width multiplier and thickness at zoom 1
  gap:2.5, padX:4, padY:1.5,   // gap between tracks; frame padding, split per axis
  lift:1,                 // multiplier on every "height above the entity"
  scale:true,             // track camera zoom
  minScale:.6, maxScale:1.8,
  text:9, textMin:7, textMax:15,
};
const barScale = () =>
  BARS.scale ? clamp(state.camera.zoom, BARS.minScale, BARS.maxScale) : 1;

const bar = (x, y, hpx, frac, wpx, _back, fill="#d39a3d") =>
  marks(x, y, hpx, wpx, [{frac, fill}]);
function label(text, x, y, hpx, color="#f1dfb7", size=BARS.text){
  const p = project(x, y, hpx*BARS.lift);
  if(p.depth>1)return;
  const s = clamp(size*barScale(), BARS.textMin, BARS.textMax);
  ctx.font = "bold "+s.toFixed(1)+"px monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#17120dcc"; ctx.fillText(text, p.x+1, p.y+1);
  ctx.fillStyle = color; ctx.fillText(text, p.x, p.y);
}

// ── delivery readout, shared by blueprints and upgrades ─────────────────────
const RES_ABBR = {wood:"w", stone:"s", dust:"d", coin:"◉", diamond:"◆"};
/** "w 2/8  s 0/10  ◆ 0/1" — what's in versus what's needed. */
function costLine(cost, delivered){
  return RESOURCE_KINDS.filter(k=>(cost[k]||0)>0)
    .map(k=>RES_ABBR[k]+" "+Math.min(delivered[k]||0,cost[k])+"/"+cost[k]).join("  ");
}
function costProgress(cost, delivered){
  let need=0, got=0;
  for(const k of RESOURCE_KINDS){
    const c = cost[k]||0;
    need += c; got += Math.min(delivered[k]||0, c);
  }
  return need ? got/need : 1;
}
/** One presentation for every "carry resources here" job: name, bar, tally. */
function drawDelivery(x, y, name, cost, delivered, accent="#d4a443"){
  label(name, x, y, 60);
  bar(x, y, 47, costProgress(cost,delivered), 58, "#292119", accent);
  label(costLine(cost,delivered), x, y, 34, "#e8dcbc", 8.5);
}

function drawOverlay(){
  // Draw in 960x540 space; the transform scales it up to device pixels crisply.
  ctx.setTransform(overlayScale,0,0,overlayScale,0,0);
  ctx.clearRect(0,0,VIEW_W,VIEW_H);

  // Night lighting, screen space, exactly as before.
  if(state.clock.light>0){
    ctx.fillStyle = "rgba(12,28,67,"+state.clock.light+")";
    ctx.fillRect(0,0,VIEW_W,VIEW_H);
  }
  drawNightTelegraph();

  // Health only. Swing progress lives in the action badge now (drawActionBadge),
  // so a node you are cutting shows its remaining yield here and the fill of the
  // current hit down on the badge — one piece of feedback each, never both.
  // Auto-hide is unchanged: a full-health thing carries no mark at all.
  const rowsFor = (frac, fill) => frac < 1 ? [{frac, fill}] : [];

  // Widths keep each track near the reference's ~9:1 ratio; the frame padding
  // adds height, so a narrow track reads as a squat blob rather than a bar.
  for(const t of trees)
    if(t.stump<=0) marks(t.x,t.y,58,52, rowsFor(t.hp/t.max, css(PAL.hpGood)));
  for(const r of rocks)
    if(r.depleted<=0) marks(r.x,r.y,34,46, rowsFor(r.hp/r.max, "#bcbab3"));
  for(const n of diamonds)
    if(n.depleted<=0) marks(n.x,n.y,38,46, rowsFor(n.hp/n.max, css(PAL.diamond)));
  for(const e of state.enemies){
    const s = ENEMY_TYPES[e.type].size;
    marks(e.x,e.y,28*s,Math.round(40*s), rowsFor(e.hp/e.max, "#c65343"));
  }
  for(const w of state.workers)
    if(w.hp<WORKER_HP) bar(w.x,w.y,30,w.hp/WORKER_HP,40,null,css(PAL.hpGood));
  if(state.baseHp<state.baseMax) bar(BASE.x,BASE.y,84,state.baseHp/state.baseMax,90,null,css(PAL.bad));

  for(const b of buildings){
    // Blueprints and upgrades are the same job — carry resources here — so they
    // share one name / bar / tally stack instead of two invented formats.
    if(!b.complete){
      drawDelivery(b.x, b.y, BUILDING_TYPES[b.type].name, buildingCost(b), b.delivered);
      if(b.starved) label("! starved", b.x, b.y, 22, "#e08a76");
      continue;
    }
    if(b.type==="tower" && b.tower && b.tower.hp<b.tower.maxHp)
      bar(b.x,b.y,56,b.tower.hp/b.tower.maxHp,52,null,css(PAL.hpGood));
    if(b.activeUpgrade){
      const job = b.activeUpgrade;
      const up = towerUpgradeList().find(i=>i.id===job.id) || UPGRADES.find(i=>i.id===job.id);
      if(up) drawDelivery(b.x, b.y, up.name, up.cost, job.delivered, css(PAL.arcane));
    }
  }

  // Last world-anchored mark, so the badge sits over the bars it shares a target
  // with; the cursor's carry count still draws on top of everything.
  drawActionBadge();
  drawCarryCount();
}

/**
 * Preview read of what a held left click would hit right now — or null.
 * Pure pass-through to resolvePrimaryAction(), the single authority the
 * simulation swings with, so the ring (and any later tool icon, via the
 * returned .kind / .icon) can never point at something the sim would not hit.
 */
// Sits ON the node (mid-canopy for a tree) rather than floating above it.

function roundPath(x, y, w, h, r){
  ctx.beginPath();
  if(ctx.roundRect){ ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r); ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r); ctx.arcTo(x,   y,   x+w, y,  r);
  ctx.closePath();
}

/**
 * One rounded frame holding N stacked tracks. Callers today pass a single
 * health row (see drawOverlay's rowsFor); the stack stays generic so any second
 * per-entity track lands inside the same frame rather than as a loose mark
 * floating at its own height.
 */
function stackedBars(px, py, rows, w, k){
  if(!rows.length) return;
  const rowH = BARS.h*k;
  const gap  = BARS.gap*k;
  const padX = BARS.padX*k, padY = BARS.padY*k;
  const innerH = rows.length*rowH + (rows.length-1)*gap;
  const boxW = w + padX*2, boxH = innerH + padY*2;
  const bx = px - boxW/2, by = py - boxH/2;

  roundPath(bx, by, boxW, boxH, Math.min(boxH/2, rowH*1.4));
  ctx.fillStyle = "rgba(36,31,22,.86)"; ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5*k);
  ctx.strokeStyle = "#efe6cd"; ctx.stroke();

  rows.forEach((row, i)=>{
    const ry = by + padY + i*(rowH+gap);
    roundPath(bx+padX, ry, w, rowH, rowH/2);
    ctx.fillStyle = "rgba(12,10,7,.5)"; ctx.fill();
    const fw = w*clamp(row.frac, 0, 1);
    if(fw > rowH*0.35){
      roundPath(bx+padX, ry, fw, rowH, rowH/2);
      ctx.fillStyle = row.fill; ctx.fill();
    }
  });
}

/** Project an entity and draw its stacked marks above it. */
function marks(x, y, hpx, wpx, rows){
  if(!rows.length) return;
  const p = project(x, y, hpx*BARS.lift);
  if(p.depth>1) return;
  const k = barScale();
  stackedBars(p.x, p.y, rows, wpx*BARS.wMul*k, k);
}

// ── primary-action badge ────────────────────────────────────────────────────
// A tool silhouette pinned under whatever a held left click would work on, so
// "what does clicking here do?" is answered before the swing starts. Drawn on
// the screen-facing overlay like every other mark, so no camera pitch or yaw
// can skew it, and purely decorative: hit-testing is world-space (groundFromEvent)
// and never consults the canvas, so the badge cannot swallow a click.
// box / drop / icon / fill alpha below are debugger-owned presentation state:
// the view panel's "bars > action badge" sliders write them live (see bindV
// calls near vBarScale). Nothing here feeds targeting, cadence, or the resolver.
const BADGE = {
  box:19,       // frame side, overlay px at zoom 1            [slider vBadgeBox]
  drop:15,      // px below the target's ground point — its lower/front edge on screen
                //                                             [slider vBadgeDrop]
  icon:15,      // silhouettes are authored in a 20x20 box, drawn at this size.
                // Rides vBadgeBox at the authored 15:19 ratio so resizing the
                // frame never leaves the tool rattling around or spilling out.
  edgePad:5,    // margin kept when a badge is clamped against the viewport
  // Held-action fill: the badge IS the swing bar now, rising bottom-to-top.
  // Cool and translucent on purpose — it reads as clearly "not empty" against the
  // badge's dark ground while staying darker than both tool inks (steel #bdb7ab,
  // haft #9a774d), so the silhouette on top of it never loses contrast. Drawn
  // above the night tint like every other overlay mark, so day and night look
  // identical rather than the fill dimming out after dusk.
  fillRGB:"84,170,214",             // hue is fixed art direction, alpha is tunable
  fill:"rgba(84,170,214,.3)",       // rebuilt from fillRGB [slider vBadgeFill]
};
// Authored icon:frame ratio, captured before any slider can move either one.
const BADGE_ICON_RATIO = BADGE.icon / BADGE.box;
// Zoom scaling follows BARS exactly (barScale()), so the badge grows and shrinks
// in step with the bars above it and the debug sliders steer both.

const ICON_STEEL = css(PAL.metal), ICON_WOOD = css(PAL.blueprint);
/**
 * Tool silhouettes keyed by resolvePrimaryAction()'s icon id — the resolver
 * names the tool, this table draws it, and nothing else decides which is which.
 * Each entry paints inside a 20x20 box centred on the current origin (y down);
 * drawBadge() supplies the translate/scale so one path set serves any size.
 * Canvas primitives only: no glyphs, no fonts, no external art to load.
 */
const ACTION_ICONS = {
  axe(){                                        // trees
    ctx.lineCap="round"; ctx.lineJoin="round";
    ctx.strokeStyle=ICON_WOOD; ctx.lineWidth=2.6;
    ctx.beginPath(); ctx.moveTo(2.2,-6.4); ctx.lineTo(-3.0,8.6); ctx.stroke();   // haft
    ctx.fillStyle=ICON_STEEL;                                                    // bit, drawn over the haft top
    ctx.beginPath();
    ctx.moveTo(0.6,-8.2);
    ctx.quadraticCurveTo(5.4,-8.8, 8.0,-5.8);       // shoulder
    ctx.quadraticCurveTo(9.6,-2.0, 6.4,1.6);        // cutting edge, bulged out
    ctx.quadraticCurveTo(4.0,-1.8, 0.0,-2.2);       // concave underside back to the haft
    ctx.closePath(); ctx.fill();
  },
  pickaxe(){                                    // rocks and diamond deposits
    ctx.lineCap="round"; ctx.lineJoin="round";
    ctx.strokeStyle=ICON_WOOD; ctx.lineWidth=2.6;
    ctx.beginPath(); ctx.moveTo(0,-5.4); ctx.lineTo(0,8.8); ctx.stroke();        // haft
    ctx.fillStyle=ICON_STEEL;                                                    // head: one crescent tapering to two points
    ctx.beginPath();
    ctx.moveTo(-9.4,0.8);
    ctx.quadraticCurveTo(-6.2,-8.0, 0,-8.4);
    ctx.quadraticCurveTo( 6.2,-8.0, 9.4,0.8);
    ctx.quadraticCurveTo( 5.4,-3.4, 0,-4.4);
    ctx.quadraticCurveTo(-5.4,-3.4, -9.4,0.8);
    ctx.closePath(); ctx.fill();
  },
  sword(){                                      // enemies
    ctx.lineJoin="round";
    ctx.fillStyle=ICON_STEEL;                                                    // blade, point up
    ctx.beginPath();
    ctx.moveTo(0,-9.5); ctx.lineTo(2.2,-5.6); ctx.lineTo(2.2,1.6);
    ctx.lineTo(-2.2,1.6); ctx.lineTo(-2.2,-5.6); ctx.closePath(); ctx.fill();
    roundPath(-6.4,1.6,12.8,2.4,1.2); ctx.fill();                                // crossguard
    ctx.beginPath(); ctx.arc(0,8.6,1.4,0,Math.PI*2); ctx.fill();                 // pommel
    ctx.fillStyle=ICON_WOOD;
    roundPath(-1.5,4.0,3.0,4.0,1.4); ctx.fill();                                 // grip
  },
};

/**
 * Compact frame + silhouette, centred on (px,py) in 960x540 overlay space.
 * @param fill 0..1 of the held action already served — the badge doubles as the
 *   swing bar, so this rises bottom-to-top inside the frame. 0 draws an empty badge.
 */
function drawBadge(px, py, iconId, k, fill){
  const paint = ACTION_ICONS[iconId];
  if(!paint) return;                          // unknown tool: draw nothing, never a blank box
  const box = BADGE.box*k, half = box/2, r = Math.min(half, 5*k);
  ctx.save();
  // Same dark-fill / light-rim treatment as stackedBars, so the two marks on one
  // target read as one family rather than two invented widgets.
  roundPath(px-half, py-half, box, box, r);
  ctx.fillStyle = "rgba(36,31,22,.86)"; ctx.fill();
  // Progress rises inside that same rounded interior: clipped to it, so the fill
  // can never square off the corners or bleed past the rim, and painted BEFORE the
  // rim and the icon — the stroke below always runs at one width and one colour
  // whatever the fraction, and the silhouette always sits on top of the fill.
  const frac = clamp(fill || 0, 0, 1);
  if(frac > 0){
    ctx.save();
    ctx.clip();                               // the rounded frame path, still current
    ctx.fillStyle = BADGE.fill;
    ctx.fillRect(px-half, py+half - box*frac, box, box*frac);
    ctx.restore();
  }
  roundPath(px-half, py-half, box, box, r);   // rebuilt: clip() left the path implicit
  ctx.lineWidth = Math.max(1, 1.5*k); ctx.strokeStyle = "#efe6cd"; ctx.stroke();
  ctx.translate(px, py);
  const s = BADGE.icon*k/20;                  // icon design space is 20 units wide
  ctx.scale(s, s);
  paint();
  ctx.restore();
}

/**
 * The action the badge advertises, or null when it must stay dark.
 * Reads chopTarget() -> resolvePrimaryAction(), the one authority the press
 * arms, so an enemy standing on a tree previews the sword the click swings.
 */
function drawActionBadge(){
  const action = badgeAction();
  if(!action) return;
  const t = action.target;
  const p = project(t.x, t.y, 0);      // ground point = the model's lower/front edge on screen
  if(p.depth > 1) return;              // behind the camera
  const k = barScale();
  const half = BADGE.box*k/2 + BADGE.edgePad*k;
  // Visible height from the live backing store, so clamping still lands inside
  // the frame on aspects other than the authored 16:9.
  const viewH = canvas.height/overlayScale || VIEW_H;
  // Read-only view of the sim's one hold timer — nothing is advanced here.
  // It shows only while the button is down on the very thing chopState is timing,
  // so hovering before the press draws an empty badge, and an early release, a
  // pointer leave, a modal, or a swap to another target has already zeroed or
  // dropped chopState by the time this frame draws. A completed hit rolls the
  // timer back to 0 itself, which empties the badge for the next repeat while the
  // button stays held. Steady Hand needs nothing here: it multiplies chopState.t.
  const filling = primaryHeld() && heldChopTarget() === action.target;
  drawBadge(clamp(p.x, half, VIEW_W-half),
            clamp(p.y + BADGE.drop*k, half, viewH-half),
            action.icon, k, filling ? chopProgress() : 0);
}

/** The pile itself is 3D; only the "n/5" readout stays flat. */
function drawCarryCount(){
  const total = carriedTotal();
  if(!total || !state.mouse.inside) return;
  const p = project(state.mouse.x, state.mouse.y, 0);
  if(p.depth>1) return;
  const full = total >= state.capacity;
  ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#17120dcc"; ctx.fillText(total+"/"+state.capacity, p.x+1, p.y+15);
  ctx.fillStyle = full ? "#e8926f" : "#f1dfb7";
  ctx.fillText(total+"/"+state.capacity, p.x, p.y+14);
}

function drawWarningEdge(side,alpha){
  const thickness=18;ctx.fillStyle="rgba(202,72,48,"+alpha+")";
  if(side===MAP_SIDE.NORTH)ctx.fillRect(0,0,VIEW_W,thickness);
  else if(side===MAP_SIDE.SOUTH)ctx.fillRect(0,VIEW_H-thickness,VIEW_W,thickness);
  else if(side===MAP_SIDE.WEST)ctx.fillRect(0,0,thickness,VIEW_H);
  else ctx.fillRect(VIEW_W-thickness,0,thickness,VIEW_H);
}
function drawNightTelegraph(){
  const clock=state.clock,wave=state.nightWave,side=wave.upcomingSide,recipe=wave.upcomingRecipe;
  if(clock.phase!=="day"||clock.remaining>NIGHT_TELEGRAPH_TIME||!side||!recipe)return;
  const alpha=.42+Math.sin(clock.remaining*5)*.14,secondary=recipe.id==="twoFront"?oppositeMapSide(side):null;
  drawWarningEdge(side,alpha);if(secondary)drawWarningEdge(secondary,alpha);
}


/**
 * Placement/relocation mark: four pulsing corners around the COMPLETE footprint, plus the segmented
 * radius ring when indicatorRadius() reports one.
 *
 * anchor is the snapToCellCenter() result the preview and the commit both use, so the corners, the
 * ring, the tinted cells, the ghost and the building that finally lands share one centre. Extents come
 * from buildingFootprint() -> footprintWorldRect(), the same pair showFootprint() measures its pad
 * with, so 1x1 and 3x3 need no special casing and no dimension is restated here.
 *
 * Colour is the placement verdict, PAL.cellOk/PAL.cellBad — the same two colours CELL_MAT/EDGE_MAT
 * tint the pad with, so corners, ring and cells flip together. Only the CORNERS breathe (a pulse on
 * their offsets); the ring's radius is left alone and its opacity does the breathing, because the ring
 * states real coverage and a scaled one would advertise a range the tower does not have. An invalid
 * spot therefore reads as red everywhere while still showing the true, unshrunken radius.
 */
function showPlacementIndicators(type, anchor, ok, t, building=null){
  const c = worldToCell(anchor.x, anchor.y);
  const color = css(ok ? PAL.cellOk : PAL.cellBad);
  showSelector(footprintWorldRect(c.cx, c.cy, buildingFootprint(type)),
    {color, opacity:indicatorCornerOpacity(IND_OPACITY_PLACEMENT), pulse:indicatorPulse(t)});
  const radius = indicatorRadius(type, building);
  if(radius) showRadiusRing(anchor.x, anchor.y, radius, {color, opacity:indicatorRingOpacity(t)});
}

// ── selector preview (debugger affordance) ──────────────────────────────────
// A tuning aid owned by the view debugger's `selectors` tab, not a game feature. Ordinary play never
// puts every selector state on screen at once — a valid and an invalid footprint are mutually
// exclusive, and a coverage ring only appears while the cursor sits on the thing that owns it — so
// this draws SAMPLE marks on demand and the slider row above can be judged against a known state.
//
// RENDER-ONLY, and strictly so: nothing here places, mutates or reads-then-writes anything. No
// building is created, `buildings` and `state` are never assigned to, and the samples go through the
// SAME showSelector()/showRadiusRing() calls drawZones() makes. They therefore claim ordinary pool
// slots and endSelectors()/endRadiusRings() retire them on the very frame the mode returns to off —
// no separate teardown exists because none is needed. Every dimension is real: footprints come from
// the footprint table (FOOTPRINT_1x1 / FOOTPRINT_3x3) and the radius from indicatorRadius("tower"),
// which resolves through towerRadius() to TOWER_VARIANTS.basic.range. No number is invented here.
//
// LIVE MARKS — deliberate: the preview is ADDITIVE and never suppresses them. With a mode on and the
// cursor also over a target, BOTH draw. That is the point of the control: the sample is the fixed
// reference you compare the moving live mark against, and suppressing one would make them
// un-comparable. The anchor is the camera-focus cell, so a sample holds still and stays on screen
// while you pan; if a live mark happens to land on the same cell the two simply overlap, which is
// harmless — separate pool slots, separate materials, no shared state.
const SEL_PREVIEW_MODES = Object.freeze({OFF:0, ACTION:1, OK_1X1:2, OK_3X3:3, BAD_3X3:4, RADIUS:5});
let SEL_PREVIEW = SEL_PREVIEW_MODES.OFF;   // written by bindV("vSelPreview") and by nothing else

function drawSelectorPreview(t){
  if(SEL_PREVIEW === SEL_PREVIEW_MODES.OFF) return;
  // Camera focus, snapped the same way a real placement snaps — always on screen, always on lattice.
  const a = snapToCellCenter(state.camera.x, state.camera.y);
  const c = worldToCell(a.x, a.y);
  const M = SEL_PREVIEW_MODES;
  if(SEL_PREVIEW === M.ACTION){
    // The one-cell primary-action bracket: PAL.ok, and the deeper IND_PULSE_ACTION breath.
    showSelector(cellWorldRect(a.x, a.y),
      {color:css(PAL.ok), opacity:indicatorCornerOpacity(), pulse:indicatorPulse(t, IND_PULSE_ACTION)});
    return;
  }
  if(SEL_PREVIEW === M.RADIUS){
    // A completed building under the cursor: hint-toned footprint corners plus its coverage ring.
    showSelector(footprintWorldRect(c.cx, c.cy, FOOTPRINT_3x3),
      {color:css(PAL.hint), opacity:indicatorCornerOpacity(), pulse:indicatorPulse(t)});
    const radius = indicatorRadius("tower");   // omitted building => the basic chassis's own range
    if(radius) showRadiusRing(a.x, a.y, radius, {color:css(PAL.hint), opacity:indicatorRingOpacity(t)});
    return;
  }
  // Placement verdicts. BAD reuses the 3x3 footprint so it differs from the valid 3x3 in COLOUR
  // ONLY — the pair is there to check the red/green flip reads at a glance, not the sizing.
  const ok = SEL_PREVIEW !== M.BAD_3X3;
  const footprint = SEL_PREVIEW === M.OK_1X1 ? FOOTPRINT_1x1 : FOOTPRINT_3x3;
  showSelector(footprintWorldRect(c.cx, c.cy, footprint),
    {color:css(ok ? PAL.cellOk : PAL.cellBad),
     opacity:indicatorCornerOpacity(IND_OPACITY_PLACEMENT), pulse:indicatorPulse(t)});
}


// ── cursor bracket ──────────────────────────────────────────────────────────
// ONE bracket lives under the pointer at all times, and it changes what it frames rather than
// blinking in and out. Three states, in priority order, resolved fresh every frame:
//
//   1. a harvest/attack target   -> that target's one-cell rect, PAL.ok, the deeper action breath
//   2. a completed building      -> its COMPLETE footprint rect, PAL.hint, plus its coverage rings
//   3. nothing                   -> the lattice cell under the pointer, PAL.cursor, dimmed
//
// Both target states already had their own authority — badgeAction() and hoveredBuilding() — and
// those are unchanged and still consulted in that order. All this adds is the third state and the
// glide, so a bracket that used to appear from nowhere now travels there from wherever it was.
/**
 * What the cursor bracket frames this frame, or null when it should not be drawn at all.
 * Pure: reads state and the live world lists, mutates nothing, returns a fresh descriptor.
 *
 * `building` rides along so the caller can hang the coverage rings off the same resolution — the
 * corners and the rings can never end up naming different buildings.
 */
function cursorMark(){
  // 1. Something to swing at. badgeAction() owns every suppression this needs.
  const action = badgeAction();
  if(action){
    // Nodes sit exactly on cell centers (see the seeder), so theirs snaps to the lattice; enemies move
    // continuously, so theirs is centred on the enemy at the same one-cell size instead of hopping.
    const p = action.target;
    return {rect: action.resource ? cellWorldRect(p.x, p.y) : pointWorldRect(p.x, p.y),
            color: css(PAL.ok), opacity: indicatorCornerOpacity(), pulse: IND_PULSE_ACTION,
            building: null};
  }
  // 2. A finished building. hoveredBuilding() is the sole authority for WHICH one.
  const b = hoveredBuilding();
  if(b){
    const c = worldToCell(b.x, b.y);
    return {rect: footprintWorldRect(c.cx, c.cy, buildingFootprint(b.type)),
            color: css(PAL.hint), opacity: indicatorCornerOpacity(), pulse: 1, building: b};
  }
  // 3. Empty ground. The two resolvers above both refuse in these states and the idle bracket has to
  // refuse in the same ones, or it would outlive them — placement and a held object draw their own
  // snapped mark, and the rest are "the game is not taking pointer input right now".
  const m = state.mouse;
  if(!m.inside || state.paused || state.gameOver || modalOpen()) return null;
  if(state.camera.panning || state.heldObject || state.buildMode) return null;
  return {rect: cellWorldRect(m.x, m.y), color: css(PAL.cursor),
          opacity: indicatorCornerOpacity(IND_OPACITY_IDLE), pulse: 1, building: null};
}

// Where the bracket actually IS, as opposed to where cursorMark() says it belongs. Centre and size
// are smoothed separately so a 1x1 -> 3x3 handover grows the frame instead of popping it.
// `live` false means the bracket is not on screen, so the next frame that draws it TELEPORTS: without
// that it would sail across the whole map after every pause, modal or pointer-leave.
const cursorGlide = {x:0, y:0, w:0, h:0, live:false};
let cursorGlideT = 0;
/**
 * Ease the drawn rect toward the resolved one and return what to draw. Exponential smoothing with the
 * step taken from real elapsed time, so the glide covers the same ground per second at 30fps as at
 * 144 and IND.follow keeps meaning "fraction of the gap closed per 60Hz frame".
 *
 * A moving enemy is smoothed like everything else rather than special-cased: exponential smoothing
 * settles at a constant lag of v*dt/k, which at the default is about a fortieth of a cell for a
 * walking raider — far too small to read as the bracket falling behind, and it keeps the handover
 * from the lattice onto a moving body as smooth as every other handover.
 */
function glideCursorRect(rect){
  const now = performance.now()/1000;
  const dt = Math.min(.05, now - (cursorGlideT || now));
  cursorGlideT = now;
  const cx = rect.x + rect.w/2, cy = rect.y + rect.h/2;
  const k = cursorGlide.live ? 1 - Math.pow(1 - clamp(IND.follow, .01, 1), dt*60) : 1;
  cursorGlide.x += (cx - cursorGlide.x)*k;
  cursorGlide.y += (cy - cursorGlide.y)*k;
  cursorGlide.w += (rect.w - cursorGlide.w)*k;
  cursorGlide.h += (rect.h - cursorGlide.h)*k;
  cursorGlide.live = true;
  return {x: cursorGlide.x - cursorGlide.w/2, y: cursorGlide.y - cursorGlide.h/2,
          w: cursorGlide.w, h: cursorGlide.h};
}

function drawZones(){
  const m = state.mouse, t = performance.now()/1000;

  // Vacuum reach while right-drag is collecting — the real collectDrop() radius.
  if(VIEW_TUNE.showVacuumRing && state.collecting && m.inside)
    ring(m.x, m.y, TUNE.vacuumRadius, css(PAL.ok), .45 + Math.sin(t*6)*.18);

  // The cursor bracket: one mark, always present, that RETARGETS instead of appearing and vanishing.
  // cursorMark() picks what it frames (see above) and the glide carries it there, so moving off a tree
  // and onto a tower is a single frame sliding and growing rather than two separate marks.
  const cursor = cursorMark();
  if(cursor){
    // One continuous clock (t, shared with the rings), so a retarget mid-breath carries the phase over
    // instead of snapping the bracket back to full size.
    showSelector(glideCursorRect(cursor.rect),
      {color:cursor.color, opacity:cursor.opacity, pulse:indicatorPulse(t, cursor.pulse)});
  } else cursorGlide.live = false;   // off screen: the next appearance teleports rather than flies in

  if(m.inside && distance(m.x,m.y,BASE.x,BASE.y)<BASE.r+16) ring(BASE.x,BASE.y,BASE_ZONE);

  // Coverage rings for the hovered building, hung off the SAME resolution the corners used so the two
  // can never name different buildings. The radius comes from indicatorRadius(), the resolver the
  // placement preview also reads — a tower reads its OWN variant's range through it, so an upgraded
  // tower advertises what it actually covers and a house/obelisk/spike gets no ring at all.
  // These do NOT glide: the corners are a pointer, free to ease, but a ring is a claim about where the
  // simulation reaches, and a claim that drifts to its position is a claim that is briefly wrong.
  const hovered = cursor?.building;
  if(hovered){
    const color = css(PAL.hint);
    const radius = indicatorRadius(hovered.type, hovered);
    if(radius) showRadiusRing(hovered.x, hovered.y, radius, {color, opacity:indicatorRingOpacity(t)});
    // Aggro's taunt is a SECOND ring in PAL.taunt — a different radius with different meaning (what it
    // pulls, not what it shoots), so it is coloured apart instead of doubling the attack ring's tone.
    const taunt = hovered.type==="tower" && towerVariant(hovered).tauntRadius;
    if(taunt) showRadiusRing(hovered.x, hovered.y, taunt, {color:css(PAL.taunt), opacity:indicatorRingOpacity(t)});
  }
  if(heldWorker()){
    ring(BASE.x,BASE.y,BASE_ZONE,css(PAL.storage),.4);
    for(const s of buildings) if(s.complete && s.type==="stockpile")
      ring(s.x,s.y,storageServiceRadius(s),css(PAL.storage),.4);
  }

  hideGhostBuilding();
  hideFootprint();
  // Previews snap with snapToCellCenter() — the exact call leftClick()/dropHeldObject() commit with —
  // so the ghost's cell, its validity tint, and the placed anchor can never disagree.
  if(state.buildMode && m.inside){
    const a = snapToCellCenter(m.x, m.y);
    const ok = canPlace(a.x, a.y, state.buildMode);
    showFootprint(state.buildMode, a.x, a.y, ok);
    showGhostBuilding(state.buildMode, a.x, a.y, ok);
    showPlacementIndicators(state.buildMode, a, ok, t);
  }
  if(state.heldObject && m.inside){
    const worker = heldWorker();
    if(worker){
      // The worker itself is already floating on the cursor; show where it lands.
      const a = workerAssignmentAt(worker, m.x, m.y);
      if(a) ring(a.zoneX,a.zoneY,a.zoneRadius,css(PAL.ok),.85);
      else  ring(m.x,m.y,WORKER_LEASH,css(PAL.bad),.7);
      ring(m.x, m.y, 16, a?css(PAL.ok):css(PAL.bad), .8);
    } else {
      const b = heldBuilding();
      if(b){
        const a = snapToCellCenter(m.x, m.y), ok = canPlace(a.x, a.y, b.type, b);
        showFootprint(b.type, a.x, a.y, ok);
        showGhostBuilding(b.type, a.x, a.y, ok, 1.6 + Math.sin(t*5)*.12);
        // A held tower keeps whatever variant it was upgraded to, so its radius comes from the
        // building itself (towerRadius -> its own variant), never from the basic chassis.
        showPlacementIndicators(b.type, a, ok, t, b);
        ring(a.x, a.y, 30, ok?css(PAL.ok):css(PAL.bad), .8);
      }
    }
  }
  // Debugger samples last, so they claim pool slots AFTER every live mark and can never displace one.
  drawSelectorPreview(t);
  // endRings()/endSelectors()/endRadiusRings() run in draw(), after drawAttacks() claims its rings.
}

// ─────────────────────────────────────────────────────────── frame
function draw(){
  if(view.orbit){ view.yaw = (view.yaw + .25) % 360; syncViewInputs(); }
  placeCamera();

  const cam = state.camera;
  sun.position.set(gx(cam.x)-26, 46, gz(cam.y)+20);
  sun.target.position.set(gx(cam.x), 0, gz(cam.y));
  sun.target.updateMatrixWorld();
  // Night dims and cools the key light; day/night already lives in state.clock.
  const night = state.clock.light;
  sun.intensity = 1.1 - night*.75;
  sun.color.setHex(night>.25 ? PAL.sunNight : PAL.sunDay);
  // The grid is unlit, so without this it would stay bright while the map darkens and end up the
  // loudest thing on screen at night. Fading it keeps it under the terrain and the combat marks.
  gridMat.opacity = GRID_OPACITY * (1 - night*.55);

  syncTrees(trees); syncRocks(rocks); syncDiamonds(diamonds);
  syncDrops(resourceDrops); syncCorpses(workerCorpses);
  syncEnemies(state.enemies); syncWorkers(state.workers);
  syncBuildings(); syncParticles(); syncHand();

  const basePulse = 1 + state.basePulse*.1;
  baseMesh.scale.set(basePulse, view.heightScale/100, basePulse);
  // The pad marks BASE's RESERVED CELLS, so it must not breathe with the store pulse - same
  // counter-scale syncBuildings() applies to every other building's footprint floor.
  baseMesh.userData.floor.scale.set(1/basePulse, 1, 1/basePulse);
  const king = state.king;
  kingMesh.position.set(gx(king.x), 0, gz(king.y));
  kingMesh.scale.y = view.heightScale/100;
  kingMesh.userData.sword.rotation.z = king.swing>0 ? -1.2 : 0;

  // Shots advance on real elapsed time, independent of the sim step count.
  const nowS = performance.now()/1000;
  stepShots(Math.min(.05, nowS - (lastDrawT || nowS)));
  lastDrawT = nowS;

  drawZones();
  drawAttacks();
  endRings();
  // Same claim-per-frame contract as the rings: whatever drawZones() did not claim this frame hides.
  // draw() runs even while paused / in a modal, so a suppressed selector is always cleared next frame.
  endSelectors();
  endRadiusRings();
  // Visibility stat + occluded pins. Throttled: it raycasts every clickable thing.
  if(++frameTick % 15 === 0) measureNow();
  renderer.render(scene, camera3);
  drawOverlay();
  if(scanPending){ scanPending=false; runScan(); }
}
let frameTick = 0, lastDrawT = 0;


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
bindV("vOrtho", v=>{ view.ortho=v; camera3 = v?ortho:persp; resizeRenderer(); scheduleScan(); updateReadout(); });
bindV("vOrbit", v=>{ view.orbit=v; });
bindV("vHeight",v=>{ view.heightScale=v; scheduleScan(); updateReadout(); }, v=>v+"%");
bindV("vShadow",v=>{ renderer.shadowMap.enabled=v; scene.traverse(o=>{ if(o.isMesh) o.material.needsUpdate=true; }); });
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
// ── ground selectors: presentation only, see the IND block by showSelector() ──
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
bindV("vSelPreview", v=>{ SEL_PREVIEW=v; });

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
const occRay = new THREE.Raycaster();
const _sp = new THREE.Vector3();

/** Every live thing the player can click, with the height to sight to. */
function subjects(){
  const out = [];
  for(const t of trees)    if(t.stump<=0)    out.push([t,1.7]);
  for(const r of rocks)    if(r.depleted<=0) out.push([r,.6]);
  for(const n of diamonds) if(n.depleted<=0) out.push([n,.9]);
  for(const d of resourceDrops) out.push([d,.3]);
  for(const w of state.workers) out.push([w,.8]);
  for(const e of state.enemies) out.push([e,.8]);
  for(const b of buildings)     out.push([b,1.0]);
  return out;
}
function blockerMeshes(){
  const out = [];
  scene.traverse(o=>{ if(o.isMesh && o.visible && o.castShadow) out.push(o); });
  return out;
}
function countVisible(list, blockers){
  let vis = 0;
  const hidden = [];
  for(const [e,h] of list){
    _sp.set(gx(e.x), h*view.heightScale/100, gz(e.y));
    const dir = _sp.clone().sub(camera3.position);
    const dist = dir.length();
    occRay.set(camera3.position, dir.normalize());
    occRay.far = dist;
    let blocked = false;
    for(const hit of occRay.intersectObjects(blockers,false)){
      const owner = hit.object.userData.ent;
      if(owner === e) continue;                 // its own body doesn't count
      if(hit.distance < dist - .15){ blocked = true; break; }
    }
    if(blocked) hidden.push(_sp.clone()); else vis++;
  }
  return {vis, total:list.length, hidden};
}

function measureNow(){
  const r = countVisible(subjects(), blockerMeshes());
  setPins(r.hidden);
  const pct = r.total ? Math.round(r.vis/r.total*100) : 100;
  $v("vStat").textContent = r.vis+"/"+r.total;
  const w = $v("vWarn");
  w.textContent = pct>=95 ? "✓" : "⚠ "+(100-pct)+"% hidden";
  w.className = pct>=95 ? "ok" : "warn";
}

function runScan(){
  scene.updateMatrixWorld(true);
  const list = subjects(), blockers = blockerMeshes(), saved = view.pitch;
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
requestAnimationFrame(()=>{ resizeRenderer(); runScan(); });


// ── boot ──────────────────────────────────────────────────────────────
resizeRenderer();
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
