// Owns: the game-pixel->world-unit scale, mesh/material helpers, outline shells, and every
// entity / building / blueprint model factory. Imports palette, data and grid; never scene.js.
// ═══════════════════════════════════════════════════════════════════════════
// MODEL FACTORIES
// Pure builders: each make*() returns a fresh THREE.Group with its parts hung on userData for the
// per-frame sync functions in scene.js to drive. Nothing here reads or writes simulation state, and
// nothing here holds a reference to a simulation entity — scene.js owns the pools that do.
//
// Sizes come from the authored tables (data.js) and the placement lattice (grid.js). Footprint pads
// in particular are measured from buildingFootprint()/CELL, so a pad and the cells canPlace()
// reserves can never disagree, and no gameplay size is restated here.
//
// Ownership / disposal: geometry and material are built PER INSTANCE inside a make*() so a group can
// be torn down wholesale by disposeGroup(). The two exceptions are documented at their definitions:
// outlineMat (one global shader material shared by every shell) and geometries created by scene.js
// for its own pooled singletons, which are never parented into a disposed group.
// ═══════════════════════════════════════════════════════════════════════════
import * as THREE from "three";
import {PAL, DROP_COLOR} from "./palette.js";
import {W,H,BASE,CELL} from "../game/data.js";
import {buildingFootprint} from "../game/grid.js";

// ── the one unit conversion the whole render layer shares ───────────────────
// The simulation thinks in 2D game pixels; three.js thinks in world units. game (x, y) maps to
// world (x*S, 0, y*S). It lives here because every model dimension below is expressed against it,
// and scene.js imports it rather than restating the ratio.
export const S = 1/16;                       // game pixels -> world units
export const WU = W*S, HU = H*S;             // 96 x 64
export const gx = x => x*S, gz = y => y*S;

export const flat = (color, extra={}) => new THREE.MeshLambertMaterial({color, flatShading:true, ...extra});
// ── outlines ────────────────────────────────────────────────────────────────
// Inverted hull: a back-faced copy of each prop pushed out along its normals,
// so only the shell behind the object survives depth testing and reads as ink.
// Costs one extra draw per prop; hidden meshes are skipped, so the toggle is free.
// OUTLINE_ON is a module-private `let` with exactly one writer, setOutlines() below — the view
// debugger calls that function, it never assigns the flag, because an imported binding is read-only.
let OUTLINE_ON = true;
export const outlineMat = new THREE.ShaderMaterial({
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
export const isOutline = o => o.userData.outline === true;

export function meshOf(geo, mat, cast=true, receive=true){
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
export function setOutlines(on){
  OUTLINE_ON = on;
  for(const s of outlineShells) s.visible = on;
}

export function disposeGroup(g){
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


// ─────────────────────────────────────────────────────────── entity models

export function makeTree(t){
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
export function makeRock(){
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
export function makeDiamond(){
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
export function makeDrop(kind){
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
export function makeDamageDummy(){
  const g=new THREE.Group();
  const post=meshOf(new THREE.CylinderGeometry(.18,.24,1.45,8),flat(PAL.timber));post.position.y=.72;
  const target=meshOf(new THREE.CylinderGeometry(.72,.72,.18,12),flat(PAL.plasterLit));target.rotation.x=Math.PI/2;target.position.y=1.35;
  const bull=meshOf(new THREE.CylinderGeometry(.32,.32,.2,12),flat(PAL.bad));bull.rotation.x=Math.PI/2;bull.position.set(0,1.35,.03);
  const base=meshOf(new THREE.BoxGeometry(1.15,.16,.75),flat(PAL.masonryDark));base.position.y=.08;
  g.add(post,target,bull,base);g.userData={target,bull};return g;
}

export function makeShowcaseProp(model){
  const g=new THREE.Group();
  if(model==="barrel"){
    const body=meshOf(new THREE.CylinderGeometry(.48,.54,.95,10),flat(PAL.timber));body.position.y=.5;
    for(const y of [.18,.82]){const band=meshOf(new THREE.TorusGeometry(.51,.055,4,10),flat(PAL.metal));band.rotation.x=Math.PI/2;band.position.y=y;g.add(band);}g.add(body);
  }else{
    const box=meshOf(new THREE.BoxGeometry(1,1,1),flat(PAL.wood));box.position.y=.5;
    const brace=meshOf(new THREE.BoxGeometry(1.08,.12,.12),flat(PAL.timberDark));brace.position.set(0,.5,.51);brace.rotation.z=Math.PI/4;g.add(box,brace);
  }
  return g;
}

export function makeEnemy(type){
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
export function makeWorker(){
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
export function makeCorpse(coat){
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
export function makeBase(){
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
export function makeKing(){
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
export const FLOOR_H = .09;          // pad thickness in world units
export const FLOOR_LIFT = .006;      // bottom face held clear of the ground plane
export const FLOOR_TOP = FLOOR_LIFT + FLOOR_H;
// Takes the footprint itself, not a type, so the base (which has no BUILDING_TYPES entry) uses the
// same pad path as everything else.
export function makeFootprintFloor(fp, color=PAL.pad){
  // cast=false: no outline shell, no shadow casting, and therefore invisible to blockerMeshes().
  const m = meshOf(new THREE.BoxGeometry(fp.w*CELL*S, FLOOR_H, fp.h*CELL*S), flat(color), false, true);
  m.position.y = FLOOR_LIFT + FLOOR_H/2;   // box bottom sits just above y=0, so no coplanar ground face
  return m;
}

export function makeBuilding(type){
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
export function makeBlueprint(type){
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

/** One carried item in the cursor pile. Smaller than makeDrop()'s ground models, by design. */
export function handMeshFor(kind){
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.13,.13,.62,6), flat(col)); m.rotation.z = Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.22,.22,.07,10), flat(col)); m.rotation.x = Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.24,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.22,0), flat(col));
  return m;
}
