// Owns: the 2D overlay canvas — health/progress bars, floating combat text, delivery readouts,
// the action badge/tool icons, carry count, night tint and wave-edge telegraphs.
// ═══════════════════════════════════════════════════════════════════════════
// 2D OVERLAY
// Everything that must stay unskewed by camera pitch and yaw is drawn here, in a fixed 960x540
// authoring space, on the <canvas id="overlay"> that sits above the WebGL scene.
//
// Ownership / data flow
//   Consumes: project() from src/render/scene.js — the ONE producer of screen coordinates. This
//             module never touches a camera, a THREE object or the scene graph; it asks scene.js
//             where a world point landed and paints there. The dependency runs overlay -> scene and
//             never back, so nothing drawn here can move the camera it was projected with.
//   Reads:    simulation queries and live collections, read-only, exactly like scene.js.
//   Writes:   the 2D context, this canvas's backing store, and the presentation holders below
//             (BARS, DAMAGE_TEXT, BADGE) which the view debugger's `overlays` pane fills in.
//
// The canvas element itself is shared: scene.js reads its client rect for raycasting and the host
// owns its event listeners and classes (src/input.js, src/ui/hud.js). This module is the only writer of its width/height.
// ═══════════════════════════════════════════════════════════════════════════
import {PAL, css} from "./palette.js";
import {project} from "./scene.js";
import {
  VIEW_W,VIEW_H,BASE,
  RESOURCE_KINDS,
  BUILDING_TYPES,TOWER_VARIANTS,UPGRADES,DAMAGE_ORBS,SUMMONING_CIRCLE,CAPTURE_YARD,
  ENEMY_TYPES,
  NIGHT_TELEGRAPH_TIME
} from "../game/data.js";
import {
  state, trees, rocks, diamonds, chests, buildings, friendlyBrutes, controlledEnemies, damageDummies, damageNumbers, resourceDrops,
  fogAtPoint,
  badgeAction, chopProgress, heldChopTarget, primaryHeld, hoverTarget, hoveredBuilding, captureYardOccupancy,
  towerUpgradeList, carriedTotal, heldWorker, heldBuilding, heldChest, workerOccupancyStatus, workerOccupancyAt, workerMaxHp, clamp,
  mainBaseStanding, mainBaseStatus
} from "../game/simulation.js";

const canvas = document.getElementById("overlay");   // 2D overlay sits above the WebGL scene
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled=false;

// The overlay is authored in a fixed 960x540 space but displayed much larger.
// Backing store must match real device pixels or every bar and glyph is upscaled.
let overlayScale = 1;

/**
 * Re-point the backing store at the live CSS box. Takes the same box scene.js's resizeRenderer()
 * measured, so the two layers can never disagree about the viewport they are drawing into.
 */
export function resizeOverlay(cssWidth, cssHeight){
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width  = Math.round(cssWidth  * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  overlayScale  = canvas.width / VIEW_W;
}

/** Health / progress readout. Same capsule as the chop bar, dark-rimmed. */
// ── overlay sizing (view panel > bars) ──────────────────────────────────────
// Overlay marks are drawn in fixed screen pixels, so without scaling they
// dwarf the world when zoomed out and vanish when zoomed in.
// MUTABLE HOLDER: the `overlays` pane writes these as properties on the imported object.
export const BARS = {
  wMul:1, h:6,            // track width multiplier and thickness at zoom 1
  gap:2.5, padX:4, padY:1.5,   // gap between tracks; frame padding, split per axis
  lift:1,                 // multiplier on every "height above the entity"
  scale:true,             // track camera zoom
  minScale:.6, maxScale:1.8,
  text:9, textMin:7, textMax:15,
  idleHold:2.5, fadeIn:.18, fadeOut:.6, // seconds: health changes/hover wake a mark, then it settles away
};
// Floating combat text presentation. Simulation owns impact snapshots and their game-time age;
// the overlays pane owns these knobs. Set rise/grow to zero for stationary, fixed-size numbers.
export const DAMAGE_TEXT = {
  enabled:true,
  fadeIn:.08,hold:.3,fadeOut:.65,
  rise:48,spread:8,grow:.35,
  size:18,criticalScale:1.55,
};
const barScale = () =>
  BARS.scale ? clamp(state.camera.zoom, BARS.minScale, BARS.maxScale) : 1;

const healthPresentation=new WeakMap();
const hoveredHealthTargets=new Set();
function collectHoveredHealthTargets(){
  hoveredHealthTargets.clear();
  if(!state.mouse.inside)return hoveredHealthTargets;
  const action=badgeAction(),delivery=hoverTarget(),building=hoveredBuilding();
  if(action?.target)hoveredHealthTargets.add(action.target);
  if(delivery?.object)hoveredHealthTargets.add(delivery.object);
  if(building)hoveredHealthTargets.add(building);
  return hoveredHealthTargets;
}
/** Health marks are presentation-owned. Fraction changes and hover wake them; inactivity fades them. */
function healthMarks(target,x,y,hpx,frac,wpx,fill,hovered,now){
  let view=healthPresentation.get(target);
  if(frac>=1){if(view){view.frac=1;view.alpha=0;view.lastFrame=now;}return;}
  if(!view){view={frac,alpha:0,lastActive:now,lastFrame:now};healthPresentation.set(target,view);}
  if(Math.abs(view.frac-frac)>1e-6){view.frac=frac;view.lastActive=now;}
  if(hovered)view.lastActive=now;
  const dt=Math.min(.1,Math.max(0,now-view.lastFrame));view.lastFrame=now;
  const visible=now-view.lastActive<=BARS.idleHold;
  const duration=visible?BARS.fadeIn:BARS.fadeOut;
  view.alpha=clamp(view.alpha+(visible?1:-1)*(duration>0?dt/duration:1),0,1);
  if(view.alpha<=0)return;
  ctx.save();ctx.globalAlpha*=view.alpha;
  marks(x,y,hpx,wpx,[{frac,fill}]);
  ctx.restore();
}
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
/** Dark slot tray: hollow circles are vacancies; filled circles are assigned workers. */
function drawWorkerSlots(target,hpx,status){
  const p=project(target.x,target.y,hpx*BARS.lift);if(p.depth>1)return;
  const s=barScale(),r=3.4*s,gap=3*s,pad=4*s;
  const w=status.capacity*r*2+Math.max(0,status.capacity-1)*gap+pad*2,h=r*2+pad*2;
  roundPath(p.x-w/2,p.y-h/2,w,h,3*s);ctx.fillStyle="#17120ddd";ctx.fill();
  for(let i=0;i<status.capacity;i++){
    const x=p.x-w/2+pad+r+i*(r*2+gap);
    ctx.beginPath();ctx.arc(x,p.y,r,0,Math.PI*2);
    if(i<status.assigned){ctx.fillStyle="#f0dfb0";ctx.fill();}
    else{ctx.fillStyle="#292119";ctx.fill();ctx.strokeStyle="#f0dfb0";ctx.lineWidth=1.35*s;ctx.stroke();}
  }
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

const DELIVERY_WORK_ACCENT=css(PAL.jobDelivery);
function workerDrawPosition(worker,held){
  return worker===held&&state.mouse.inside?state.mouse:worker;
}
function addDeliveryWorkerLine(worker,held,sitePoint){
  const at=workerDrawPosition(worker,held),p=project(at.x,at.y,18);
  if(p.depth>1)return;
  ctx.moveTo(p.x,p.y);ctx.lineTo(sitePoint.x,sitePoint.y);
}
/** Hover-only construction links — one line per assigned Delivery Worker, manual or autonomous.
 * One shared path keeps the transient work allocation-free. */
function drawDeliveryWorkerLines(){
  if(state.runMode!=="normal")return;
  const hovered=hoverTarget(),site=hovered?.kind==="building"&&!hovered.object.complete?hovered.object:null;
  if(!site)return;
  const sitePoint=project(site.x,site.y,12);if(sitePoint.depth>1)return;
  const held=heldWorker();ctx.save();ctx.beginPath();
  for(const worker of state.workers)if(worker.job==="deliver"&&worker.jobTarget===site)addDeliveryWorkerLine(worker,held,sitePoint);
  if(held&&held.job==="deliver"&&held.jobTarget===site)addDeliveryWorkerLine(held,held,sitePoint);
  ctx.strokeStyle=DELIVERY_WORK_ACCENT;ctx.globalAlpha=.28;ctx.lineWidth=Math.max(1,barScale());ctx.lineCap="round";ctx.stroke();ctx.restore();
}

export function drawOverlay(){
  // Draw in 960x540 space; the transform scales it up to device pixels crisply.
  ctx.setTransform(overlayScale,0,0,overlayScale,0,0);
  ctx.clearRect(0,0,VIEW_W,VIEW_H);

  // Night wash REMOVED (Aug 22): night is now a palette swap in the 3D scene (palette.js
  // TONES_NIGHT + rig.js NIGHT_SUN_SCALE, mixed by material-light-mods uLmNight), and the old
  // 2D navy fill on top double-counted it and re-tinted the quantized swatches off-palette.
  // state.clock.light still drives the scene (it is the normalised night phase) — only the
  // screen-space fill is gone.
  drawNightTelegraph();
  drawDeliveryWorkerLines();

  // Health only. Swing progress lives in the action badge now (drawActionBadge),
  // so a node you are cutting shows its remaining yield here and the fill of the
  // current hit down on the badge — one piece of feedback each, never both.
  // Full-health things stay unmarked; damaged things wake on change/hover, then fade after inactivity.
  const now=performance.now()/1000,hovered=collectHoveredHealthTargets();
  const health=(target,x,y,hpx,frac,wpx,fill)=>healthMarks(target,x,y,hpx,frac,wpx,fill,hovered.has(target),now);

  // Widths keep each track near the reference's ~9:1 ratio; the frame padding
  // adds height, so a narrow track reads as a squat blob rather than a bar.
  const hasWorkers=state.workers.length>0||!!heldWorker();
  const hoveredOccupancy=hasWorkers&&state.mouse.inside?workerOccupancyAt(state.mouse.x,state.mouse.y):null;
  const occupancyVisible=target=>{const status=workerOccupancyStatus(target);return status&&hasWorkers&&(status.assigned>0||hoveredOccupancy?.target===target);};
  const drawOccupancy=(target,height)=>{const status=workerOccupancyStatus(target);if(status)drawWorkerSlots(target,height,status);};
  for(const t of trees)if(t.stump<=0){
    health(t,t.x,t.y,58,t.hp/t.max,52,css(PAL.hpGood));
    if(occupancyVisible(t))drawOccupancy(t,72);
  }
  for(const r of rocks)if(r.depleted<=0){
    health(r,r.x,r.y,34,r.hp/r.max,46,"#bcbab3");
    if(occupancyVisible(r))drawOccupancy(r,49);
  }
  for(const n of diamonds)if(n.depleted<=0){
    health(n,n.x,n.y,38,n.hp/n.max,46,css(PAL.diamond));
    if(occupancyVisible(n))drawOccupancy(n,53);
  }
  for(const chest of heldChest()?[...chests,heldChest()]:chests)
    health(chest,chest===heldChest()&&state.mouse.inside?state.mouse.x:chest.x,chest===heldChest()&&state.mouse.inside?state.mouse.y:chest.y,46,chest.hp/chest.max,43,css(PAL.chestLatch));
  for(const e of state.enemies){
    // The scene hides bodies standing in fog because the simulation makes them untargetable; a
    // health track floating over a blank fog block would be the only trace of one, so it goes too.
    if(fogAtPoint(e.x,e.y)) continue;
    const s = ENEMY_TYPES[e.type].size;
    health(e,e.x,e.y,28*s,e.hp/e.max,Math.round(40*s),"#c65343");
  }
  for(const brute of friendlyBrutes){health(brute,brute.x,brute.y,42,brute.hp/brute.max,52,"#62c990");label("ALLY",brute.x,brute.y,62,"#8ff0b5");}
  // Controlled enemies wear the friendly-Brute language — green health track, ALLY tag — so a
  // converted raider can never be misread as the hostile it used to be.
  for(const unit of controlledEnemies){health(unit,unit.x,unit.y,28,unit.hp/unit.max,40,"#62c990");label("ALLY",unit.x,unit.y,50,"#8ff0b5");}
  // Simulation-owned dummies reuse neutral health bars; they never enter enemy identity/reward UI.
  for(const d of damageDummies)health(d,d.x,d.y,42,d.hp/d.max,48,"#d6c36d");
  // Effective maximum, not the ordinary one: an arrived garrison guard carries the bigger pool, so
  // its bar must fill against that or a fortified guard would read as permanently wounded.
  for(const w of state.workers){const max=workerMaxHp(w);health(w,w.x,w.y,30,w.hp/max,40,css(PAL.hpGood));}
  // No base, no health track: during the pre-wave opening the map centre holds nothing to wound,
  // and its unfinished site draws the ordinary delivery panel in the building loop below.
  if(mainBaseStanding()){
    health(BASE,BASE.x,BASE.y,84,state.baseHp/state.baseMax,90,css(PAL.bad));
    // The authored progression, in the SAME "carry resources here" language every blueprint and
    // upgrade uses — the standing base is just another delivery target until it tops out.
    const base=mainBaseStatus(),levelText="main base · lv "+base.level+"/"+base.maxLevel;
    if(base.atMaxLevel)label(levelText+" · max",BASE.x,BASE.y,60,"#e8dcbc");
    else drawDelivery(BASE.x,BASE.y,levelText+" → "+(base.level+1),base.cost,base.delivered,css(PAL.jobDelivery));
    // Active Base Delivery Work wears the same derived occupancy mark as every other post.
    // It is not in `buildings`, so it cannot ride the loop below and says so here instead.
    if(occupancyVisible(BASE))drawOccupancy(BASE,30);
  }

  for(const b of buildings){
    // Blueprints and upgrades are the same job — carry resources here — so they
    // share one name / bar / tally stack instead of two invented formats.
    if(!b.complete){
      const buildName=b.plannedVariant?TOWER_VARIANTS[b.plannedVariant].name:BUILDING_TYPES[b.type].name;
      drawDelivery(b.x, b.y, buildName, b.delivery.cost, b.delivery.delivered);
      if(occupancyVisible(b))drawOccupancy(b,74);
      if(b.starved) label("! starved", b.x, b.y, 22, "#e08a76");
      continue;
    }
    if(occupancyVisible(b))drawOccupancy(b,48);
    if(b.type==="tower" && b.tower)
      health(b,b.x,b.y,56,b.tower.hp/b.tower.maxHp,52,css(PAL.hpGood));
    // Yard capacity is derived per frame, so this readout is correct the instant a capture lands
    // or a linked ally dies — there is no cached counter to lag behind.
    if(b.type==="captureYard"){const held=captureYardOccupancy(b);marks(b.x,b.y,48,58,[{frac:held/CAPTURE_YARD.capacity,fill:"#75c86d"}]);label(held+"/"+CAPTURE_YARD.capacity+" turned",b.x,b.y,70,"#a8e6b0");}
    if(b.orbs){marks(b.x,b.y,44,50,[{frac:b.orbs.remaining/DAMAGE_ORBS.duration,fill:"#8fd9ee"}]);label(Math.ceil(b.orbs.remaining)+"s",b.x,b.y,57,"#bcecff");}
    if(b.summoning){marks(b.x,b.y,48,58,[{frac:b.summoning.remaining/SUMMONING_CIRCLE.duration,fill:"#9870c9"},{frac:b.summoning.dust/SUMMONING_CIRCLE.dustCost,fill:"#c5a1e8"}]);label(b.summoning.dust+"/"+SUMMONING_CIRCLE.dustCost+" dust · "+Math.ceil(b.summoning.remaining)+"s",b.x,b.y,70,"#dec8f4");}
    if(b.type==="consumableForge")drawDelivery(b.x,b.y,"consumable forge",b.delivery.cost,b.delivery.delivered,css(PAL.dust));
    if(b.activeUpgrade){
      const job = b.activeUpgrade;
      const up = towerUpgradeList().find(i=>i.id===job.id) || UPGRADES.find(i=>i.id===job.id);
      if(up) drawDelivery(b.x, b.y, up.name, up.cost, job.delivered, css(PAL.arcane));
    }
  }
  const heldTemporary=heldBuilding();
  if(heldTemporary?.orbs&&state.mouse.inside){marks(state.mouse.x,state.mouse.y,44,50,[{frac:heldTemporary.orbs.remaining/DAMAGE_ORBS.duration,fill:"#8fd9ee"}]);label(Math.ceil(heldTemporary.orbs.remaining)+"s",state.mouse.x,state.mouse.y,57,"#bcecff");}
  if(heldTemporary?.summoning&&state.mouse.inside){marks(state.mouse.x,state.mouse.y,48,58,[{frac:heldTemporary.summoning.remaining/SUMMONING_CIRCLE.duration,fill:"#9870c9"},{frac:heldTemporary.summoning.dust/SUMMONING_CIRCLE.dustCost,fill:"#c5a1e8"}]);label(heldTemporary.summoning.dust+"/"+SUMMONING_CIRCLE.dustCost+" dust · "+Math.ceil(heldTemporary.summoning.remaining)+"s",state.mouse.x,state.mouse.y,70,"#dec8f4");}

  // Transient combat feedback sits over persistent bars/badges; cursor carry remains topmost.
  drawCoinBeacons();
  drawActionBadge();
  drawDamageNumbers();
  drawClickRipples();
  drawCarryCount();
}

function damageTextOpacity(age){
  const fadeIn=DAMAGE_TEXT.fadeIn,holdEnd=fadeIn+DAMAGE_TEXT.hold,total=holdEnd+DAMAGE_TEXT.fadeOut;
  if(age<0||age>=total)return 0;
  if(fadeIn>0&&age<fadeIn)return age/fadeIn;
  if(DAMAGE_TEXT.fadeOut>0&&age>holdEnd)return 1-(age-holdEnd)/DAMAGE_TEXT.fadeOut;
  return 1;
}
function damageTextValue(amount){return Number.isInteger(amount)?String(amount):amount.toFixed(1).replace(/\.0$/,"");}
function drawDamageNumbers(){
  if(!DAMAGE_TEXT.enabled)return;
  const total=DAMAGE_TEXT.fadeIn+DAMAGE_TEXT.hold+DAMAGE_TEXT.fadeOut;
  if(total<=0)return;
  for(const hit of damageNumbers){
    const alpha=damageTextOpacity(hit.age);if(alpha<=0)continue;
    const p=project(hit.x,hit.y,30);if(p.depth>1)continue;
    const progress=clamp(hit.age/total,0,1),ease=1-Math.pow(1-progress,3);
    const x=p.x+hit.lane*DAMAGE_TEXT.spread+Math.sin((hit.seed+progress)*Math.PI*2)*DAMAGE_TEXT.spread*.25;
    const y=p.y-DAMAGE_TEXT.rise*ease;
    const scale=(1+DAMAGE_TEXT.grow*ease)*(hit.critical?DAMAGE_TEXT.criticalScale:1);
    const size=DAMAGE_TEXT.size*scale,text=damageTextValue(hit.amount);
    ctx.save();ctx.globalAlpha=alpha;ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.font="900 "+size.toFixed(1)+"px Georgia, serif";
    ctx.lineJoin="round";ctx.lineWidth=Math.max(2,size*.18);ctx.strokeStyle="#211208";ctx.strokeText(text,x,y);
    // tone "received" = damage the PLAYER took, so it wears PAL.bad (red2) — the same step as every
    // other enemy-dealt read. "dealt" and criticals stay gold/amber: those are the player winning.
    ctx.fillStyle=hit.critical?"#fff1a6":hit.tone==="received"?css(PAL.bad):"#f2c84b";ctx.fillText(text,x,y);
    ctx.restore();
  }
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
 * health row (see drawOverlay's health helper); the stack stays generic so any second
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
// the view panel's "bars > action badge" sliders write them live (see the bindV
// calls near vBarScale in src/debug/view-debugger.js). Nothing here feeds targeting, cadence, or
// the resolver.
export const BADGE = {
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
export const BADGE_ICON_RATIO = BADGE.icon / BADGE.box;
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
// The readout bumps on any change — a gained drop and a spent pile both deserve a tick.
const CARRY_BUMP_MS = 180;
let carryShown = 0, carryBumpAt = -1e9;
function drawCarryCount(){
  const total = carriedTotal();
  if(total !== carryShown){carryShown = total;carryBumpAt = performance.now();}
  if(!total || !state.mouse.inside) return;
  const p = project(state.mouse.x, state.mouse.y, 0);
  if(p.depth>1) return;
  const full = total >= state.capacity;
  const bump = Math.max(0, 1-(performance.now()-carryBumpAt)/CARRY_BUMP_MS);
  ctx.font = "bold "+(10+4*bump*bump).toFixed(1)+"px monospace"; ctx.textAlign = "center";
  ctx.fillStyle = "#17120dcc"; ctx.fillText(total+"/"+state.capacity, p.x+1, p.y+15);
  ctx.fillStyle = full ? "#e8926f" : "#f1dfb7";
  ctx.fillText(total+"/"+state.capacity, p.x, p.y+14);
}

// ── click ripples ───────────────────────────────────────────────────────────
// Same-frame press feedback: src/input.js pushes a world point on every primary press (hit or
// miss); each entry draws one expanding, fading ring and expires on wall-clock age.
const RIPPLE_MS = 280;
const ripples = [];
export function addClickRipple(x,y){ripples.push({x,y,at:performance.now()});}
function drawClickRipples(){
  const now = performance.now();
  for(let i=ripples.length-1;i>=0;i--){
    const age = (now-ripples[i].at)/RIPPLE_MS;
    if(age>=1){ripples.splice(i,1);continue;}
    const p = project(ripples[i].x, ripples[i].y, 0);
    if(p.depth>1) continue;
    const ease = 1-Math.pow(1-age,3), k = barScale();
    ctx.beginPath();ctx.arc(p.x, p.y, (5+15*ease)*k, 0, Math.PI*2);
    ctx.strokeStyle = "rgba(241,223,183,"+(.6*(1-age)).toFixed(3)+")";
    ctx.lineWidth = 2*k*(1-.5*age);ctx.stroke();
  }
}

// ── coin beacon ─────────────────────────────────────────────────────────────
// Timed drops (the wandering gold coin) get a soft rising beam so the toast is not their only
// announcement. The scene's TTL blink still owns despawn urgency.
function drawCoinBeacons(){
  const t = performance.now()/1000;
  for(const drop of resourceDrops){
    if(drop.ttl===null || drop.target) continue;
    const p = project(drop.x, drop.groundY, 0);
    if(p.depth>1) continue;
    const k = barScale(), pulse = .5+.5*Math.sin(t*5+drop.spin);
    const fade = clamp(drop.ttl/2, 0, 1);         // settle out over the last 2s, under the blink
    const beamH = (46+8*pulse)*k, beamW = 7*k;
    const beam = ctx.createLinearGradient(0, p.y-beamH, 0, p.y);
    beam.addColorStop(0,"rgba(227,180,69,0)");
    beam.addColorStop(1,"rgba(227,180,69,"+(.34*fade).toFixed(3)+")");
    ctx.fillStyle = beam;ctx.fillRect(p.x-beamW/2, p.y-beamH, beamW, beamH);
  }
}

function drawNightTelegraph(){
  // Spawning is a ring around the base with no direction, so the telegraph is the
  // full screen border rather than one warned edge.
  const clock=state.clock,wave=state.nightWave;
  if(clock.phase!=="day"||clock.remaining>NIGHT_TELEGRAPH_TIME||!wave.upcomingPlan)return;
  const thickness=18,alpha=.42+Math.sin(clock.remaining*5)*.14;
  ctx.fillStyle="rgba(202,72,48,"+alpha+")";
  ctx.fillRect(0,0,VIEW_W,thickness);ctx.fillRect(0,VIEW_H-thickness,VIEW_W,thickness);
  ctx.fillRect(0,thickness,thickness,VIEW_H-2*thickness);ctx.fillRect(VIEW_W-thickness,thickness,thickness,VIEW_H-2*thickness);
}
