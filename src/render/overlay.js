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
  WORKER_HP,
  BUILDING_TYPES,UPGRADES,
  ENEMY_TYPES,
  NIGHT_TELEGRAPH_TIME
} from "../game/data.js";
import {
  state, trees, rocks, diamonds, chests, buildings, damageDummies, damageNumbers,
  badgeAction, chopProgress, heldChopTarget, primaryHeld, hoverTarget,
  buildingCost, towerUpgradeList, carriedTotal, heldWorker, heldChest, workerIsLoaned, workerOccupancyStatus, workerOccupancyAt, durablePostStatus, clamp
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

const BUILD_JOB_ACCENT=css(PAL.jobBuild);
function workerDrawPosition(worker,held){
  return worker===held&&state.mouse.inside?state.mouse:worker;
}
function addBuilderLine(worker,held,sitePoint){
  const at=workerDrawPosition(worker,held),p=project(at.x,at.y,18);
  if(p.depth>1)return;
  ctx.moveTo(p.x,p.y);ctx.lineTo(sitePoint.x,sitePoint.y);
}
/** Hover-only construction links. One shared path keeps the transient work allocation-free. */
function drawRecruitmentLines(){
  if(state.runMode!=="normal")return;
  const hovered=hoverTarget(),site=hovered?.kind==="building"&&!hovered.object.complete?hovered.object:null;
  if(!site)return;
  const sitePoint=project(site.x,site.y,12);if(sitePoint.depth>1)return;
  const held=heldWorker();ctx.save();ctx.beginPath();
  for(const worker of state.workers)if(worker.job==="build"&&worker.jobTarget===site)addBuilderLine(worker,held,sitePoint);
  if(held&&held.job==="build"&&held.jobTarget===site)addBuilderLine(held,held,sitePoint);
  ctx.strokeStyle=BUILD_JOB_ACCENT;ctx.globalAlpha=.28;ctx.lineWidth=Math.max(1,barScale());ctx.lineCap="round";ctx.stroke();ctx.restore();
}
function drawLoanMarker(worker,held){
  if(!workerIsLoaned(worker))return;
  const at=workerDrawPosition(worker,held),p=project(at.x,at.y,38);if(p.depth>1)return;
  const r=3.5*barScale();ctx.fillStyle=BUILD_JOB_ACCENT;ctx.beginPath();
  ctx.moveTo(p.x,p.y-r);ctx.lineTo(p.x+r,p.y);ctx.lineTo(p.x,p.y+r);ctx.lineTo(p.x-r,p.y);ctx.closePath();ctx.fill();
}
function drawLoanMarkers(){
  if(state.runMode!=="normal")return;
  const held=heldWorker();for(const worker of state.workers)drawLoanMarker(worker,held);
  if(held)drawLoanMarker(held,held);
}

export function drawOverlay(){
  // Draw in 960x540 space; the transform scales it up to device pixels crisply.
  ctx.setTransform(overlayScale,0,0,overlayScale,0,0);
  ctx.clearRect(0,0,VIEW_W,VIEW_H);

  // Night lighting, screen space, exactly as before.
  if(state.clock.light>0){
    ctx.fillStyle = "rgba(12,28,67,"+state.clock.light+")";
    ctx.fillRect(0,0,VIEW_W,VIEW_H);
  }
  drawNightTelegraph();
  drawRecruitmentLines();

  // Health only. Swing progress lives in the action badge now (drawActionBadge),
  // so a node you are cutting shows its remaining yield here and the fill of the
  // current hit down on the badge — one piece of feedback each, never both.
  // Auto-hide is unchanged: a full-health thing carries no mark at all.
  const rowsFor = (frac, fill) => frac < 1 ? [{frac, fill}] : [];

  // Widths keep each track near the reference's ~9:1 ratio; the frame padding
  // adds height, so a narrow track reads as a squat blob rather than a bar.
  const hasWorkers=state.workers.length>0||!!heldWorker();
  const hoveredOccupancy=hasWorkers&&state.mouse.inside?workerOccupancyAt(state.mouse.x,state.mouse.y):null;
  const occupancyVisible=target=>{const status=workerOccupancyStatus(target);return status&&hasWorkers&&(status.assigned>0||hoveredOccupancy?.target===target);};
  const drawOccupancy=(target,height)=>{const status=workerOccupancyStatus(target);if(status)drawWorkerSlots(target,height,status);};
  for(const t of trees)if(t.stump<=0){
    marks(t.x,t.y,58,52, rowsFor(t.hp/t.max, css(PAL.hpGood)));
    if(occupancyVisible(t))drawOccupancy(t,72);
  }
  for(const r of rocks)if(r.depleted<=0){
    marks(r.x,r.y,34,46, rowsFor(r.hp/r.max, "#bcbab3"));
    if(occupancyVisible(r))drawOccupancy(r,49);
  }
  for(const n of diamonds)if(n.depleted<=0){
    marks(n.x,n.y,38,46, rowsFor(n.hp/n.max, css(PAL.diamond)));
    if(occupancyVisible(n))drawOccupancy(n,53);
  }
  for(const chest of heldChest()?[...chests,heldChest()]:chests)
    marks(chest===heldChest()&&state.mouse.inside?state.mouse.x:chest.x,chest===heldChest()&&state.mouse.inside?state.mouse.y:chest.y,46,43,rowsFor(chest.hp/chest.max,css(PAL.chestLatch)));
  for(const e of state.enemies){
    const s = ENEMY_TYPES[e.type].size;
    marks(e.x,e.y,28*s,Math.round(40*s), rowsFor(e.hp/e.max, "#c65343"));
  }
  // Simulation-owned dummies reuse neutral health bars; they never enter enemy identity/reward UI.
  for(const d of damageDummies)marks(d.x,d.y,42,48,rowsFor(d.hp/d.max,"#d6c36d"));
  for(const w of state.workers)
    if(w.hp<WORKER_HP) bar(w.x,w.y,30,w.hp/WORKER_HP,40,null,css(PAL.hpGood));
  drawLoanMarkers();
  if(state.baseHp<state.baseMax) bar(BASE.x,BASE.y,84,state.baseHp/state.baseMax,90,null,css(PAL.bad));

  for(const b of buildings){
    // Blueprints and upgrades are the same job — carry resources here — so they
    // share one name / bar / tally stack instead of two invented formats.
    if(!b.complete){
      drawDelivery(b.x, b.y, BUILDING_TYPES[b.type].name, buildingCost(b), b.delivered);
      if(occupancyVisible(b))drawOccupancy(b,74);
      if(b.starved) label("! starved", b.x, b.y, 22, "#e08a76");
      continue;
    }
    const staffing=durablePostStatus(b);
    if(staffing&&staffing.arrived<staffing.capacity)label("! vacant",b.x,b.y,30,"#72c9b2");
    if(staffing&&occupancyVisible(b))drawOccupancy(b,48);
    if(b.type==="tower" && b.tower && b.tower.hp<b.tower.maxHp)
      bar(b.x,b.y,56,b.tower.hp/b.tower.maxHp,52,null,css(PAL.hpGood));
    if(b.activeUpgrade){
      const job = b.activeUpgrade;
      const up = towerUpgradeList().find(i=>i.id===job.id) || UPGRADES.find(i=>i.id===job.id);
      if(up) drawDelivery(b.x, b.y, up.name, up.cost, job.delivered, css(PAL.arcane));
    }
  }

  // Transient combat feedback sits over persistent bars/badges; cursor carry remains topmost.
  drawActionBadge();
  drawDamageNumbers();
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
    ctx.fillStyle=hit.critical?"#fff1a6":hit.tone==="received"?"#ef765f":"#f2c84b";ctx.fillText(text,x,y);
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
