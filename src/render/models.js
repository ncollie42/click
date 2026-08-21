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
import {W,H,BASE,CELL,BUILDING_TYPES,ENEMY_TYPES,GARRISON} from "../game/data.js";
import {buildingFootprint} from "../game/grid.js";
// Reviewed sim-px models (see docs/quality-bar.md): standalone modules the model viewer also
// loads. Adopted into the game's scale/shadow/outline conventions by adoptModel() below.
import {MODELS as PEG_MODELS, dressCarry} from "./models/worker-peg.js";
import {MODELS as BASE_MODELS} from "./models/the-hole.js";
import {MODELS as ENEMY_MODELS} from "./models/enemy-shard.js";
import {MODELS as NODE_MODELS, withGameTarget} from "./models/resource-nodes.js";
import {MODELS as CIRCLE_MODELS, withGameTarget as withCircleGameTarget} from "./models/summoning-circle.js";

// ── the one unit conversion the whole render layer shares ───────────────────
// The simulation thinks in 2D game pixels; three.js thinks in world units. game (x, y) maps to
// world (x*S, 0, y*S). It lives here because every model dimension below is expressed against it,
// and scene.js imports it rather than restating the ratio.
export const S = 1/16;                       // game pixels -> world units
export const WU = W*S, HU = H*S;             // 480 x 320 world units
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
      vec4 local = vec4(position + normal * thickness, 1.0);
      #ifdef USE_INSTANCING
        local = instanceMatrix * local;
      #endif
      gl_Position = projectionMatrix * modelViewMatrix * local;
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
// Shells built OUTSIDE meshOf() — scene.js's instanced scatter — join and leave the same registry
// so the view panel's outline switch reaches them too.
export function adoptOutlineShell(shell){
  shell.castShadow = shell.receiveShadow = false;
  shell.userData.outline = true;
  shell.visible = OUTLINE_ON;
  outlineShells.push(shell);
  return shell;
}
export function releaseOutlineShell(shell){
  const i = outlineShells.indexOf(shell);
  if(i >= 0) outlineShells.splice(i, 1);
}

// ── static baking ───────────────────────────────────────────────────────────
// Collapses a freshly built group's rigid, untinted meshes into ONE vertex-coloured mesh (plus its
// single outline shell), so a model costs a handful of draw calls instead of dozens. Build-time
// only: call it inside a make*() before the group is returned, never on a group already in a scene.
// A mesh is baked only when nothing can ever move or restyle it independently of the group:
//   - not reachable from group.userData (those are the animated / toggled / retinted parts). The
//     `parts` key is exempt — it is the whole-model hurt-flash list, which the caller rebuilds
//     around the merged mesh.
//   - material is a bare opaque front-sided Lambert with no map and no emissive (an emissive or
//     transparent material is a styling hook, not set dressing).
//   - visible and castShadow (hidden state toggles and pads keep their own mesh).
// material.color is already in working space, so copying it into the vertex colour attribute under
// a white vertexColors material renders the identical pixels.
export function bakeStatic(g, {extraKeep = [], requireShadow = true, shell = true} = {}){
  const keep = new Set(extraKeep.filter(Boolean));
  const keepMats = new Set();
  const visit = value => {
    if(!value || typeof value !== "object") return;
    if(value.isObject3D){ keep.add(value); return; }
    if(value.isMaterial){ keepMats.add(value); return; }
    if(Array.isArray(value)){ value.forEach(visit); return; }
    if(value.constructor === Object) Object.values(value).forEach(visit);
  };
  for(const [key, value] of Object.entries(g.userData)) if(key !== "parts") visit(value);
  const bakeableMat = m => m && m.isMeshLambertMaterial && !m.map && !m.transparent &&
    m.side === THREE.FrontSide && m.emissive.getHex() === 0 && !keepMats.has(m);
  // requireShadow=false is the pre-adoption path (sim-px models before adoptModel() switches
  // shadows on); it must still respect a model's noShadow locks, probed by set-and-read.
  const shadowOk = o => {
    if(requireShadow) return o.castShadow;
    const was = o.castShadow; o.castShadow = true;
    const unlocked = o.castShadow; o.castShadow = was;
    return unlocked;
  };
  const bakeable = [];
  g.traverse(o => {
    if(!o.isMesh || isOutline(o) || keep.has(o) || !o.visible || !shadowOk(o)) return;
    for(let p = o.parent; p && p !== g; p = p.parent) if(keep.has(p)) return;
    const m = o.material;
    if(Array.isArray(m)){
      if(!o.geometry.groups.length || !m.every(bakeableMat)) return;
    } else if(!bakeableMat(m)) return;
    bakeable.push(o);
  });
  if(bakeable.length < 2) return null;
  const positions = [], normals = [], colors = [];
  const mat4 = new THREE.Matrix4();
  for(const mesh of bakeable){
    mesh.updateMatrix(); mat4.copy(mesh.matrix);
    for(let p = mesh.parent; p !== g; p = p.parent){ p.updateMatrix(); mat4.premultiply(p.matrix); }
    const geo = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mat4);
    const pos = geo.getAttribute("position"), nor = geo.getAttribute("normal"), vc = geo.getAttribute("color");
    // Per-vertex diffuse: the material's colour (per geometry group when multi-material),
    // multiplied by any authored vertex colours — exactly what the Lambert shader computed.
    const mats = Array.isArray(mesh.material) ? mesh.material : null;
    const groupColorAt = i => {
      if(!mats) return mesh.material.color;
      for(const grp of geo.groups) if(i >= grp.start && i < grp.start + grp.count)
        return mats[grp.materialIndex % mats.length].color;
      return mats[0].color;
    };
    for(let i = 0; i < pos.count; i++){
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      const c = groupColorAt(i);
      if(vc) colors.push(c.r*vc.getX(i), c.g*vc.getY(i), c.b*vc.getZ(i));
      else colors.push(c.r, c.g, c.b);
    }
    geo.dispose();
  }
  // Tear the sources down; a material survives only while some kept mesh still uses it.
  const baked = new Set(bakeable);
  const liveMaterials = new Set();
  g.traverse(o => { if(o.isMesh && !baked.has(o) && !isOutline(o))
    for(const m of Array.isArray(o.material) ? o.material : [o.material]) liveMaterials.add(m); });
  for(const mesh of bakeable){
    for(const child of [...mesh.children]) if(isOutline(child)){
      const i = outlineShells.indexOf(child); if(i >= 0) outlineShells.splice(i, 1);
    }
    mesh.removeFromParent(); mesh.geometry.dispose();
    for(const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
      if(!liveMaterials.has(m) && !keepMats.has(m)) m.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  const material = flat(0xffffff, {vertexColors: true});
  // shell=false is the pre-adoption path: adoptModel() adds the sim-px outline itself, so meshOf's
  // world-unit shell would both double the ink and use the wrong thickness under the 1/16 wrapper.
  const merged = shell ? meshOf(geometry, material) : new THREE.Mesh(geometry, material);
  g.add(merged);
  return merged;
}

export function disposeGroup(g){
  g.traverse(o=>{
    if(!o.isMesh) return;
    if(isOutline(o)){                        // house shells share their parent's geometry and
      const i = outlineShells.indexOf(o);     // one global material — drop the reference,
      if(i >= 0) outlineShells.splice(i, 1);  // dispose neither.
      // A module that draws its OWN ink (summoning-circle's screen-space hull) owns a private
      // geometry and a private ShaderMaterial per shell. Those must be released, or every
      // consumed summoning circle leaks one of each.
      if(o.material !== outlineMat && o.material !== outlineMatPx){
        o.geometry.dispose();
        for(const m of Array.isArray(o.material) ? o.material : [o.material]) if(m && m.dispose) m.dispose();
      }
      return;
    }
    o.geometry.dispose();
    // Material may be an array (multi-group meshes in the reviewed sim-px models).
    for(const m of Array.isArray(o.material) ? o.material : [o.material])
      if(m && m.dispose) m.dispose();
  });
}


// ─────────────────────────────────────────────────────────── entity models

// Shared by scene.js's single InstancedMesh: three crossed blade clusters form one readable
// Clickyland-style black-green tuft without allocating one object/material per vegetation cell.
export function makeGrassTuftGeometry(){
  const positions=[];
  const triangle=(a,b,c)=>positions.push(...a,...b,...c);
  for(const [x,z,h,w] of [[-.28,.08,.62,.16],[.08,-.12,.78,.18],[.3,.14,.52,.14]]){
    triangle([x-w,0,z],[x+w,0,z],[x,h,z]);
    triangle([x,0,z-w],[x,0,z+w],[x,h,z]);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();geometry.computeBoundingSphere();return geometry;
}

// ── display-referred adoption: the game's own rig, inverted ─────────────────
// The painted casts (resource-nodes.js, summoning-circle.js) are calibrated in DISPLAYED sRGB
// against the model viewer, which renders them UNLIT through ACES @1.18. The game renders
// NoToneMapping + sRGB out, through a LIT Lambert. Adopting them unchanged would hand a scene-
// linear ACES value to a light rig and shade it a second time.
//
// So those two modules can bake for the game instead (withGameTarget): every colour comes out as
// the albedo that displays its calibrated pixel on an UP-FACING facet. This is the other half —
// rescale each facet by irr(up)/irr(that facet's WORLD normal), so the Lambert pass multiplies the
// rig straight back out and the painted ramp renders exactly as authored, while the material still
// answers to the sun, the shadow map and the day/night dim, which an unlit material never would.
// (Same idea as enemy-shard's toneAlbedo(), which does it against the VIEWER's rig at build time;
// this does it against the GAME's rig at adoption time, so one module serves both renderers.)
//
// THE RIG, mirrored from scene.js. If the lights there change, these change with them:
//   sun    PAL.sunDay @1.1 (drawScene's `1.1 - night*.75`, i.e. the NOON value), aimed from
//          (cam.x-26, 46, cam.y+20) at the camera focus — a constant world direction.
//   hemi   PAL.skyLight over PAL.bounce @0.5, axis +Y.
// Three's non-legacy lighting (renderer._useLegacyLights === false, r160) is
//   displayed_linear = albedo * (sun*I*max(0,N·L) + mix(ground,sky,.5+.5*N.y)*I_hemi) / PI
// which was verified against the shipped build to the byte: a fog block of authored 0x484253 on
// its top face predicts (44,39,48) and the render measures (44,40,48).
const GAME_SUN_DIR = new THREE.Vector3(-26,46,20).normalize();
const GAME_SUN_I = 1.1, GAME_HEMI_I = .5;
const _sunLin = new THREE.Color(PAL.sunDay), _skyLin = new THREE.Color(PAL.skyLight), _gndLin = new THREE.Color(PAL.bounce);
// THE ONE EXPOSURE NUMBER, and the honest limit of this whole exercise.
// The gauntlet calibrated its cast against a clearing that DISPLAYS at (173,187,127), luma 180.
// The game's clearing displays (57,81,30), luma 72 — measured off tools/shots/terrain-before —
// because scene.js tints the grass texture (PAL.grass) with a vertex colour that is PAL.grass
// again, so the ground is that colour squared. In linear light the game's world is 6.7x darker
// than the viewer's, and the sheet's absolute numbers are simply not reachable here: at albedo 1
// the brightest pixel this rig can put on a sun-facing top facet is (169,166,157), and the
// canopy's calibrated green alone wants G=200.
// So the cast is transplanted rather than copied: ONE linear exposure applied to every target,
// which preserves every ratio inside the cast AND its ratio against the world. 0.19 is the value
// that reproduces the reference sheet's own figure/ground — its canopy sits 1.47x its grass in
// linear luminance, and 0.19 puts the canopy 1.47x the GAME's grass (displayed luma ~91 against
// the clearing's 72, against the sheet's 190-over-160).
// MEASURED, on tools/shots/terrain/normal-base.png against tools/shots/terrain-before: canopy
// median (87,99,68) luma 94 over a clearing at luma 73. The old primitive crowns sat at luma 112,
// so the new trees separate LESS than the ones they replace (+21 against +39) while separating
// exactly as much as the reference sheet's do. That is the one call in this file that is taste
// rather than measurement, and it is a single number to turn:
//     .19   the sheet's figure/ground, in linear ratio (canopy 1.47x the clearing)   <- shipped
//     .226  the sheet's figure/ground, in DISPLAY luma (+30 over the clearing, canopy luma ~103)
//     .275  the OLD game's contrast (canopy luma ~112, what the primitive crowns had)
// Raising it costs ramp: the higher the exposure, the more shade-side facets hit the albedo
// ceiling in relightGeometry() below and flatten toward the rig's own falloff.
export const GAME_EXPOSURE = .19;
function gameIrradiance(n, out){
  const nl = Math.max(0, n.dot(GAME_SUN_DIR)), w = .5 + .5*n.y, iw = 1/Math.PI;
  out.r = (_sunLin.r*GAME_SUN_I*nl + (_gndLin.r + (_skyLin.r-_gndLin.r)*w)*GAME_HEMI_I)*iw;
  out.g = (_sunLin.g*GAME_SUN_I*nl + (_gndLin.g + (_skyLin.g-_gndLin.g)*w)*GAME_HEMI_I)*iw;
  out.b = (_sunLin.b*GAME_SUN_I*nl + (_gndLin.b + (_skyLin.b-_gndLin.b)*w)*GAME_HEMI_I)*iw;
  return out;
}
const _rlNormalMatrix = new THREE.Matrix3(), _rlA = new THREE.Vector3(), _rlB = new THREE.Vector3(),
      _rlC = new THREE.Vector3(), _rlN = new THREE.Vector3(), _rlIrr = new THREE.Color();
const _rlUp = new THREE.Vector3(0,1,0);
// The up-facing irradiance the painted modules solve their albedo against, and the numerator of
// every per-facet rescale below. Handed to them through withGameTarget() so neither module has to
// hold a copy of the game's light rig.
const GAME_UP_IRR = (()=>{ const c = gameIrradiance(_rlUp, new THREE.Color()); return [c.r, c.g, c.b]; })();
export const GAME_TARGET = {exposure: GAME_EXPOSURE, irr: GAME_UP_IRR};
// Facet normals are recomputed from POSITIONS, not read from the normal attribute: the attribute
// is smooth on the primitives these modules borrow (the chest lid is a CylinderGeometry), while
// the material is flatShaded, so the shader's normal is the geometric one. Solving against
// anything else puts the compensation on a different normal than the shading pass uses.
function relightGeometry(geo, normalMatrix){
  const pos = geo.getAttribute("position"), col = geo.getAttribute("color");
  if(!col) return;
  for(let i = 0; i < pos.count; i += 3){
    _rlA.fromBufferAttribute(pos, i); _rlB.fromBufferAttribute(pos, i+1); _rlC.fromBufferAttribute(pos, i+2);
    _rlN.copy(_rlB).sub(_rlA).cross(_rlC.sub(_rlA)).applyMatrix3(normalMatrix);
    if(_rlN.lengthSq() < 1e-20) continue;                 // degenerate facet (SDF pole fans)
    gameIrradiance(_rlN.normalize(), _rlIrr);
    // The ceiling is where this stops being exact, and it is worth naming: a facet the sun never
    // reaches gets ~1/4.4 of an up-facing facet's light, so a bright fill (the canopy's shade
    // band, a trunk's shaded side) would need albedo past 1 to hold its painted value there.
    // Tops and uppers — which is what a 40-degree camera mostly sees — land exactly on target.
    // WHEN IT DOES CLIP, IT CLIPS TOWARD BLACK, NOT TOWARD THE RIG'S HUE. Clamping per channel
    // was measured doing the second thing: a pale trunk's side facets pinned all three channels
    // at 1, so the pixel became the rig itself — sky-lit, and the bone trunk rendered cool grey
    // (72,76,77) where its family is warm (88,85,76). Scaling the whole triple by its own worst
    // channel keeps the authored hue and spends only value, which is the trade the cast can
    // afford (its ramp is already a value ramp).
    const kr = GAME_UP_IRR[0]/_rlIrr.r, kg = GAME_UP_IRR[1]/_rlIrr.g, kb = GAME_UP_IRR[2]/_rlIrr.b;
    for(let k = 0; k < 3; k++){
      const r = col.getX(i+k)*kr, g = col.getY(i+k)*kg, b = col.getZ(i+k)*kb;
      const over = Math.max(1, r, g, b);
      col.setXYZ(i+k, r/over, g/over, b/over);
    }
  }
  col.needsUpdate = true;
}
/** Re-solve every painted facet for its own world normal. Run once, on the built sim-px group,
 *  BEFORE bakeStatic() fuses it (the fuse copies whatever colours it finds, and it flattens the
 *  transforms these normals are read through). */
export function relightForGame(root){
  root.updateMatrixWorld(true);
  const done = new Set();
  root.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    const geo = o.geometry;
    if(!geo.userData.gameTarget || done.has(geo)) return;
    done.add(geo);
    relightGeometry(geo, _rlNormalMatrix.getNormalMatrix(o.matrixWorld));
    geo.userData.gameTarget = false;
  });
  return root;
}

// ── the resource nodes ──────────────────────────────────────────────────────
// Trees, rock, diamond and chest are the reviewed sim-px cast in src/render/models/
// resource-nodes.js (SDF shells, painted vertex-colour ramps). The old stacked primitives are
// gone; what survives untouched is every CONTRACT scene.js drives them through —
// userData.live / stump / rubble / spent / gem / body / lid / latch / wearMats — so the scatter
// layers, the collapse tweens and the chest wobble did not have to learn anything new.
//
// Adoption, in the order it has to happen:
//   1 build inside withGameTarget() -> the module bakes DISPLAY TARGETS, on lit Lambert, no ink
//   2 relightForGame()              -> targets become albedo against the game rig's world normals
//   3 bakeStatic()                  -> the ~10 meshes fuse to one (the scatter layer wants ONE
//                                      geometry per variant; the per-entity casts want the draw
//                                      calls). Fusing before the relight would be wrong: it
//                                      copies colours, and the colours are not albedo yet.
//   4 scale by S                    -> sim px -> world units, on the MESH, because
//                                      makeScatterLayer() clones geometry through liveSrc.matrix
//                                      and never sees a wrapper group.
// Sizes are the module's, not restated here. Measured against the old models' footprints (world
// units, ink excluded): tree crown 2.7w x 3.4h -> 2.63/2.96 x 3.56/2.97 (variants a/b), rock
// 1.9 x 1.44 -> 1.88 x 1.25, diamond 1.6 -> 1.79 x 1.92, chest 1.3w x 1.11h -> 1.36 x 1.30.
// tree.variant 0..2. Slot 2 is the BLOSSOM, because PAL.leaf[2] has always been pink (0xd9a0bc):
// a third of this world's trees are already in flower and the cast has the tree for it. The
// module also exports "tree-green-c" — swap it in here if the owner wants three greens instead.
export const TREE_MODELS = ["tree-green-a", "tree-green-b", "tree-blossom"];
/** Build one node model on the game's path: relit, fused to a single mesh, scaled to world units. */
function nodeMesh(name){
  const inner = withGameTarget(GAME_TARGET, () => NODE_MODELS[name].build());
  relightForGame(inner);
  bakeStatic(inner, {requireShadow:false, shell:false});
  inner.updateMatrixWorld(true);
  const meshes = [];
  inner.traverse(o=>{ if(o.isMesh && !isOutline(o)) meshes.push(o); });
  // bakeStatic leaves exactly one mesh for these casts (nothing is hung on userData but `parts`,
  // which it exempts). There is deliberately NO fallback: a module change that leaves a second
  // mesh un-fused (transparent/emissive/DoubleSide parts resist the fuse) throws AT BOOT, loudly,
  // instead of shipping a silently broken scatter model — the scatter layers are module-scope, so
  // this line runs before the first frame and the failure is unmissable.
  const mesh = meshes[0];
  if(meshes.length !== 1) throw new Error(`resource node ${name} fused to ${meshes.length} meshes`);
  mesh.geometry.applyMatrix4(mesh.matrixWorld);
  mesh.position.set(0,0,0); mesh.rotation.set(0,0,0);
  mesh.removeFromParent();
  mesh.scale.setScalar(S);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
export function makeTree(t){
  const g = new THREE.Group();
  const live = nodeMesh(TREE_MODELS[t.variant] ?? TREE_MODELS[0]);
  const stump = nodeMesh("tree-stump");
  stump.visible = false;
  g.add(live, stump);
  g.userData = {live, stump};
  return g;
}
export function makeRock(){
  const g = new THREE.Group();
  const live = nodeMesh("rock");
  const rubble = nodeMesh("rock-rubble");
  rubble.visible = false;
  g.add(live, rubble);
  g.userData = {live, rubble};
  return g;
}
// Per-entity cast (makeLayer builds one group per node), so it keeps its parts: `crystals` is the
// spinner scene.js drives through userData.gem, and the live cluster and the spent crater swap
// visibility on `depleted`. Two fused meshes plus the crystal cluster, each with the house's
// sim-px ink shell — the module's own screen-space ink is off (see resource-nodes' inkable()).
export function makeDiamond(){
  const g = new THREE.Group();
  const inner = withGameTarget(GAME_TARGET, () => NODE_MODELS["diamond"].build());
  relightForGame(inner);
  const crystals = inner.getObjectByName("crystals");
  delete inner.userData.gemMats;              // the module's glint hook: no game caller, and it
                                              // would keep the crystals out of the fuse below
  bakeStatic(inner, {extraKeep:[crystals], requireShadow:false, shell:false});
  bakeStatic(crystals, {requireShadow:false, shell:false});
  adoptModel(inner);
  inner.scale.setScalar(S);
  const spent = nodeMesh("diamond-spent");
  addPxOutline(spent);
  spent.visible = false;
  g.add(inner, spent);
  // `live` is what syncDiamonds() shows/hides: the mound group and the crystal cluster ride
  // together, so one entry (the whole sim-px group) says it once.
  g.userData = {live:[inner], spent, gem:crystals};
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
// Enemies use the reviewed shadow-shard models (src/render/models/enemy-shard.js); the old
// prototype capsules are gone. makeEnemy() lives below the adoption layer it depends on.
export function makeDamageDummy(){
  const g=new THREE.Group();
  const post=meshOf(new THREE.CylinderGeometry(.18,.24,1.45,8),flat(PAL.timber));post.position.y=.72;
  const target=meshOf(new THREE.CylinderGeometry(.72,.72,.18,12),flat(PAL.plasterLit));target.rotation.x=Math.PI/2;target.position.y=1.35;
  const bull=meshOf(new THREE.CylinderGeometry(.32,.32,.2,12),flat(PAL.bad));bull.rotation.x=Math.PI/2;bull.position.set(0,1.35,.03);
  const base=meshOf(new THREE.BoxGeometry(1.15,.16,.75),flat(PAL.masonryDark));base.position.y=.08;
  g.add(post,target,bull,base);g.userData={target,bull};bakeStatic(g);return g;
}

// The chest is the one node the player picks up and smashes, never opens: the module's loot pile
// and its `open` pose are dropped at build (the sim has no open state to drive them from), and
// what survives is the named lid — still a real hinge group, so syncChests' shake wobble tips it
// exactly as it always did. Two fused meshes: body-and-hardware, and the lid assembly.
export function makeChest(){
  const g=new THREE.Group();
  const inner = withGameTarget(GAME_TARGET, () => NODE_MODELS["chest"].build());
  relightForGame(inner);
  const loot = inner.getObjectByName("loot");
  if(loot){ disposeGroup(loot); loot.removeFromParent(); }
  const lid = inner.getObjectByName("lid"), latch = inner.getObjectByName("latch");
  // The brass latch stays out of the fuse so userData.latch keeps meaning what it always meant —
  // one part, one draw. Everything else on the body (chamfered timber, feet, rails, straps,
  // liner) is rigid and becomes one mesh.
  const body = bakeStatic(inner, {extraKeep:[lid, latch], requireShadow:false, shell:false});
  bakeStatic(lid, {requireShadow:false, shell:false});
  adoptModel(inner);
  inner.scale.setScalar(S);
  g.add(inner);
  // wearMats is the hurt tint: every BODY material, which here is every material there is (this
  // cast has no emissive or unlit part to keep out of it).
  const wear=new Set();inner.traverse(o=>{if(o.isMesh&&!isOutline(o))wear.add(o.material);});
  g.userData={body:body??inner, lid, latch, wearMats:[...wear]};
  return g;
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
  bakeStatic(g);
  return g;
}

// ── sim-px model adoption ───────────────────────────────────────────────────
// The reviewed models (src/render/models/worker-peg.js, the-hole.js) are standalone modules
// authored at SIM-PIXEL scale with zero game imports, so the model viewer can load them bare.
// Adoption happens here, at the mount point: one wrapper group scaled by S maps their pixels to
// world units, shadows are switched on (the-hole's noShadow property locks keep their own answer),
// and ink outlines are added to every lit, opaque, single-sided prop mesh. Geometry and materials
// are never edited — the viewer and the game render the identical model.
// Their outline shells need thickness in SIM PX (the shared outlineMat's is in world units and
// would vanish under the 1/16 wrapper): outlineMatPx is a clone whose thickness scene.js mirrors
// from outlineMat every frame, so the view panel's weight slider drives both.
export const outlineMatPx = outlineMat.clone();
outlineMatPx.uniforms.thickness.value = outlineMat.uniforms.thickness.value / S;
function addPxOutline(mesh){
  const shell = new THREE.Mesh(mesh.geometry, outlineMatPx);
  shell.castShadow = shell.receiveShadow = false;
  shell.userData.outline = true;
  shell.visible = OUTLINE_ON;
  mesh.add(shell);
  outlineShells.push(shell);
}
// A module that draws its OWN ink keeps it: summoning-circle's screen-space hull is built around a
// silhouette DONOR (its kerb is a carved slab whose own edges must not be inked) and has a device-
// pixel floor the world-space house shell has no way to reproduce. So this adoption sets the
// shadow flags and hands the module's shells to the outline registry — the view panel's toggle
// reaches them — and deliberately runs no addPxOutline pass, which would double every line.
// disposeGroup() knows to free these (they own a private geometry and ShaderMaterial each).
function adoptInkedModel(group){
  group.traverse(o=>{
    if(!o.isMesh) return;
    if(isOutline(o)){ adoptOutlineShell(o); return; }
    o.castShadow = true;                 // silently refused by the module's noShadow locks
    o.receiveShadow = true;
  });
  return group;
}
function adoptModel(group){
  group.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    o.castShadow = true;                 // silently refused by the-hole's emissive/decal locks
    o.receiveShadow = true;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if(o.castShadow && !m.isMeshBasicMaterial && !m.transparent && m.side !== THREE.DoubleSide)
      addPxOutline(o);
  });
  return group;
}

// Job -> dressed peg. Key format "worker-<job>[+carry]": the +carry suffix dresses the SAME job
// model with the log bundle (dressCarry), so a loaded courier stays denim rather than turning tan.
// The wrapper owns world placement/scale; scene.js drives the anims on userData.inner.
export function makePegWorker(key){
  const [name, carry] = key.split("+");
  const def = PEG_MODELS[name] || PEG_MODELS["worker-gatherer"];
  const inner = def.build();
  inner.rotation.y = 0;                  // zero the sheet display yaw; facing is the wrapper's job
  if(carry){
    dressCarry(inner);
    // The log bundle is rigid — anims move the whole stack group — so its ~17 meshes fuse into
    // one before adoption (which then adds the single sim-px outline shell for it).
    const stack = inner.getObjectByName("stack");
    if(stack) bakeStatic(stack, {requireShadow: false, shell: false});
  }
  adoptModel(inner);
  const g = new THREE.Group();
  g.add(inner);
  g.scale.setScalar(S);
  g.userData = {inner, anims: def.anims};
  return g;
}
// Enemy type -> adopted shard model. Models bake archetype size (the brute's ×1.35); scene.js applies
// only explicit ENEMY_TYPES.modelScale (the boss), never collision `size`. userData.tintMats collects
// the unique BODY materials (lit, zero-emissive Lambert) so hit-flash/burn tint the rock and never
// the seam floors, eyes or ability FX (those are unlit/emissive and are excluded by the filter).
//
// Variant colour is baked into those meshes' authored vertex colours while preserving luminance.
// A material.color multiplier made the already near-black rock merely darker, so blue Veterans and
// red Elites were effectively indistinguishable. Luminance-normalized vertex tint keeps every
// calibrated facet value while changing its readable hue.
// The sim draws its own shot beam (scene.js beam() off shotFlash/shotX), so the archer's modelled
// bolt is hidden at build; its charge flash and recoil remain.
const colorLuminance=color=>.2126*color.r+.7152*color.g+.0722*color.b;
function tintEnemyGeometry(geometry,tint,amount=.72){
  const colors=geometry.getAttribute("color");
  if(!colors)return;
  const tintLuminance=colorLuminance(tint);
  if(tintLuminance<=0)return;
  const tr=tint.r/tintLuminance,tg=tint.g/tintLuminance,tb=tint.b/tintLuminance;
  for(let i=0;i<colors.count;i++){
    const r=colors.getX(i),g=colors.getY(i),b=colors.getZ(i),l=.2126*r+.7152*g+.0722*b;
    colors.setXYZ(i,
      THREE.MathUtils.lerp(r,l*tr,amount),
      THREE.MathUtils.lerp(g,l*tg,amount),
      THREE.MathUtils.lerp(b,l*tb,amount));
  }
  colors.needsUpdate=true;
}
export function makeEnemy(type){
  const enemy=ENEMY_TYPES[type],archetype=enemy?.archetype||"raider";
  const def = ENEMY_MODELS["enemy-"+archetype] || ENEMY_MODELS["enemy-raider"];
  const inner = def.build();
  adoptModel(inner);
  if(archetype==="archer"){ const bolt = inner.getObjectByName("bolt"); if(bolt) bolt.visible = false; }
  const tintMats = [], seenMats = new Set(), tintGeometries = new Set();
  const variantTint=enemy?.variantColor ? new THREE.Color(enemy.variantColor) : null;
  inner.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    for(const m of Array.isArray(o.material) ? o.material : [o.material]){
      if(seenMats.has(m)) continue; seenMats.add(m);
      if(m.isMeshLambertMaterial && m.emissive && m.emissive.getHex()===0) tintMats.push(m);
    }
    if(variantTint && o.material?.isMeshLambertMaterial && !tintGeometries.has(o.geometry)){
      tintGeometries.add(o.geometry);
      tintEnemyGeometry(o.geometry,variantTint);
    }
  });
  const g = new THREE.Group();
  g.add(inner);
  g.scale.setScalar(S);
  g.userData = {inner, anims:def.anims, tintMats};
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
// ── main base: keep and precursor pit ───────────────────────────────────────
// The reviewed model (the-hole.js) replaces the inline keep+pit that used to live here. The
// asymmetric model sits on the same authored anchor and 3x3 footprint: the grass pad below it is
// the reserved-cells contract (identical to every building's), the model rides a sim-px holder
// lifted to the pad top, and placement/targeting/storage continue to read BASE untouched.
export function makeMainBase(awake){
  const name = awake ? "main-base-awake" : "main-base";
  const inner = BASE_MODELS[name].build();
  // The hole's anims move only the funnel group, the orb subtree and a set of emissive/transparent
  // materials (which the bake filter refuses on its own). Everything else — keep, crenellations,
  // door, berm, chute, apron, curb — is rigid and fuses into one mesh before adoption.
  bakeStatic(inner, {extraKeep: [inner.getObjectByName("funnel"), inner.getObjectByName("orb")],
                     requireShadow: false, shell: false});
  adoptModel(inner);
  const g = new THREE.Group();
  const floor = makeFootprintFloor(BASE.footprint, PAL.grass);
  g.add(floor);
  const holder = new THREE.Group();
  holder.add(inner);
  holder.scale.setScalar(S);
  holder.position.y = FLOOR_TOP;
  g.add(holder);
  g.position.set(gx(BASE.x), 0, gz(BASE.y));
  g.userData = {floor, inner, anims: BASE_MODELS[name].anims};
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
  bakeStatic(g);
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

// Fresh closed triangular prism for a pitched-roof gable. Positions are local to the wall top;
// non-indexed faces keep the low-poly planes hard and let disposeGroup() own the geometry normally.
function gablePrismGeometry(w,h,d){
  const x=w/2,z=d/2;
  const fL=[-x,0,z],fR=[x,0,z],fT=[0,h,z];
  const bL=[-x,0,-z],bR=[x,0,-z],bT=[0,h,-z];
  const faces=[
    fL,fR,fT, bR,bL,bT,                   // front and back
    fL,bT,bL, fL,fT,bT,                   // left roof slope
    fR,bR,bT, fR,bT,fT,                   // right roof slope
    fL,bL,bR, fL,bR,fR,                   // hidden bottom closes the volume
  ];
  const geo=new THREE.BufferGeometry();
  geo.setAttribute("position",new THREE.Float32BufferAttribute(faces.flat(),3));
  geo.computeVertexNormals();
  return geo;
}

export function makeBuilding(type){
  const g = new THREE.Group();
  const parts = [];
  const add = (m)=>{ g.add(m); parts.push(m); return m; };
  if(type==="tower"){
    // The basic chassis owns the silhouette shared by every permanent tower variant. Keep it
    // weaponless: variants tint the roof through userData.roof, while gameplay/VFX remain separate.
    const beam = (a,b,width,color=PAL.timberDark)=>{
      const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),delta=to.clone().sub(from);
      const m=add(meshOf(new THREE.BoxGeometry(width,delta.length(),width),flat(color)));
      m.position.copy(from).add(to).multiplyScalar(.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
      return m;
    };

    // Uneven local stone course: low enough to read as hand-set footings rather than a stone tower.
    const stones=[
      [-1.05,-1.20,.72,.40,.54,-.03],[-.32,-1.18,.68,.34,.52,.02],[.38,-1.21,.70,.42,.56,-.02],[1.09,-1.18,.66,.36,.50,.03],
      [-1.08, 1.19,.68,.35,.52,.02],[-.38, 1.21,.70,.41,.55,-.03],[.35, 1.18,.66,.36,.50,.02],[1.05, 1.20,.74,.40,.54,-.02],
      [-1.22,-.42,.52,.38,.70,.02],[-1.19,.36,.54,.34,.68,-.03],[1.20,-.38,.50,.36,.72,-.02],[1.22,.38,.54,.40,.68,.03],
    ];
    stones.forEach(([x,z,w,h,d,turn],i)=>{
      const stone=add(meshOf(new THREE.BoxGeometry(w,h,d),flat(i%3===1?PAL.rockDark:PAL.rock)));
      stone.position.set(x,FLOOR_TOP+h/2,z);stone.rotation.y=turn;
    });

    // Four wide-set, slightly irregular legs; crossed beams carry the load on every face.
    const legs=[[-1.02,-1.01,.28,.31,-.018],[1.00,-1.03,.31,.28,.014],[-1.04,1.02,.29,.32,.012],[1.03,1.00,.30,.29,-.016]];
    for(const [x,z,w,d,lean] of legs){
      const leg=add(meshOf(new THREE.BoxGeometry(w,2.82,d),flat(PAL.timber)));
      leg.position.set(x,1.72,z);leg.rotation.z=lean;
    }
    for(const z of [-1.02,1.02]){
      beam([-.94,.55,z],[.94,2.72,z],.15);
      beam([.94,.55,z],[-.94,2.72,z],.15);
    }
    for(const x of [-1.02,1.02]){
      beam([x,.55,-.94],[x,2.72,.94],.15);
      beam([x,.55,.94],[x,2.72,-.94],.15);
    }

    // Chunky under-frame plus individual deck planks keep the open platform readable from above.
    for(const z of [-1.14,1.14]){
      const frame=add(meshOf(new THREE.BoxGeometry(2.70,.24,.24),flat(PAL.timberDark)));
      frame.position.set(0,2.98,z);
    }
    for(let i=0;i<6;i++){
      const plank=add(meshOf(new THREE.BoxGeometry(.40,.16,2.58),flat(i%2?PAL.timber:PAL.timberDark)));
      plank.position.set((i-2.5)*.42,3.16+(i%3===0?.015:0),0);
    }

    // Roof posts double as railing uprights. The ladder-facing (+Z) rail has a central opening.
    for(const [x,z] of [[-1.23,-1.23],[1.23,-1.23],[-1.23,1.23],[1.23,1.23]]){
      const post=add(meshOf(new THREE.BoxGeometry(.18,1.18,.18),flat(PAL.timber)));
      post.position.set(x,3.76,z);
    }
    const rail=(w,d,x,z)=>{
      const m=add(meshOf(new THREE.BoxGeometry(w,.16,d),flat(PAL.timber)));
      m.position.set(x,3.62,z);
    };
    rail(2.30,.14,0,-1.23);rail(.14,2.30,-1.23,0);rail(.14,2.30,1.23,0);
    rail(.72,.14,-.82,1.23);rail(.72,.14,.82,1.23);

    // One solid low-poly gable keeps the variant-accent contract as a single material target.
    const roofGeo=new THREE.BufferGeometry();
    const roofVertices=[
      -1.52,4.27,-1.34, -1.52,5.02,0, -1.52,4.27,1.34,
       1.52,4.27,-1.34,  1.52,4.27,1.34,  1.52,5.02,0,
      -1.52,4.27,-1.34,  1.52,4.27,-1.34,  1.52,5.02,0,
      -1.52,4.27,-1.34,  1.52,5.02,0,    -1.52,5.02,0,
      -1.52,4.27,1.34,  -1.52,5.02,0,     1.52,5.02,0,
      -1.52,4.27,1.34,   1.52,5.02,0,     1.52,4.27,1.34,
      -1.52,4.27,-1.34, -1.52,4.27,1.34,  1.52,4.27,1.34,
      -1.52,4.27,-1.34,  1.52,4.27,1.34,  1.52,4.27,-1.34,
    ];
    roofGeo.setAttribute("position",new THREE.Float32BufferAttribute(roofVertices,3));
    // Non-indexed triangles keep normals split at every ridge/eave for hard low-poly facets.
    roofGeo.computeVertexNormals();
    const roof=add(meshOf(roofGeo,flat(PAL.timberDark)));
    g.userData.roof=roof;

    // Ladder leans against the open side and terminates at the deck opening, not through a rail.
    beam([-.35,.30,1.60],[-.35,3.30,1.34],.12,PAL.timber);
    beam([.35,.30,1.60],[.35,3.30,1.34],.12,PAL.timber);
    for(let i=0;i<7;i++){
      const t=(i+1)/8,y=.30+(3.30-.30)*t,z=1.60+(1.34-1.60)*t;
      beam([-.38,y,z],[.38,y,z],.10,PAL.timberDark);
    }
  } else if(type==="house"){
    // Front is +Z, matching the house worker spawn/post at simulation y+23. The cottage remains
    // centered inside the anchor cell while its footprint floor reserves the full 3x3 yard.
    const wallH=1.14,wallW=1.46,wallD=1.30,wallTop=FLOOR_TOP+wallH;
    const walls=add(meshOf(new THREE.BoxGeometry(wallW,wallH,wallD),flat(PAL.plaster)));
    walls.position.y=FLOOR_TOP+wallH/2;

    const roofRun=.89,roofRise=.90,roofDepth=1.58;
    const gable=add(meshOf(gablePrismGeometry(wallW,roofRise,wallD),flat(PAL.plaster)));
    gable.position.y=wallTop;

    // Three broad, overlapping rows per slope suggest hand-laid shingles without texture detail.
    const slope=Math.hypot(roofRun,roofRise),angle=Math.atan2(roofRise,roofRun),rows=3;
    for(const side of [-1,1]) for(let i=0;i<rows;i++){
      const t=(i+.5)/rows;
      const shingle=add(meshOf(
        new THREE.BoxGeometry(slope/rows+.08,.09,roofDepth),
        flat((i+(side>0?1:0))%2 ? PAL.timberDark : PAL.timber)
      ));
      shingle.position.set(side*roofRun*(1-t),wallTop+roofRise*t,0);
      shingle.rotation.z=side<0?angle:-angle;
    }
    const ridge=add(meshOf(new THREE.BoxGeometry(.14,.14,roofDepth+.04),flat(PAL.timberDark)));
    ridge.position.y=wallTop+roofRise;

    // Rough timber frame. Front jambs and lintel enlarge the door read; the other beams expose the
    // plaster-over-frame construction from any camera quarter without ornamenting it.
    for(const [x,z] of [[-wallW/2,-wallD/2],[wallW/2,-wallD/2],[-wallW/2,wallD/2],[wallW/2,wallD/2]]){
      const post=add(meshOf(new THREE.BoxGeometry(.12,wallH+.04,.12),flat(PAL.timber)));
      post.position.set(x,FLOOR_TOP+wallH/2,z);
    }
    for(const x of [-wallW/2,wallW/2]){
      const eave=add(meshOf(new THREE.BoxGeometry(.13,.13,wallD+.08),flat(PAL.timberDark)));
      eave.position.set(x,wallTop,0);
    }
    const frontBeam=add(meshOf(new THREE.BoxGeometry(wallW+.08,.13,.13),flat(PAL.timberDark)));
    frontBeam.position.set(0,wallTop,wallD/2+.025);
    const gablePost=add(meshOf(new THREE.BoxGeometry(.11,roofRise,.11),flat(PAL.timber)));
    gablePost.position.set(0,wallTop+roofRise/2,wallD/2+.035);

    const door=add(meshOf(new THREE.BoxGeometry(.66,1.04,.14),flat(PAL.timberDark)));
    door.position.set(0,FLOOR_TOP+.52,wallD/2+.07);
    for(const x of [-.39,.39]){
      const jamb=add(meshOf(new THREE.BoxGeometry(.13,1.10,.16),flat(PAL.timber)));
      jamb.position.set(x,FLOOR_TOP+.55,wallD/2+.10);
    }
    const lintel=add(meshOf(new THREE.BoxGeometry(.91,.15,.17),flat(PAL.timber)));
    lintel.position.set(0,FLOOR_TOP+1.08,wallD/2+.10);

    // The chimney is three slightly misaligned stone courses, not one machined extrusion.
    for(let i=0;i<3;i++){
      const course=add(meshOf(new THREE.BoxGeometry(.31-(i%2)*.02,.27,.31),flat(PAL.rock)));
      course.position.set(.43+(i===1?.025:0),1.84+i*.255,-.27);
      course.rotation.y=(i-1)*.045;
    }

    // Tiny side props keep the doorway clear for worker births at +Z.
    for(const [z,y] of [[-.24,.20],[-.08,.20],[-.16,.38]]){
      const log=add(meshOf(new THREE.CylinderGeometry(.09,.10,.42,6),flat(PAL.timber)));
      log.rotation.x=Math.PI/2;
      log.position.set(.82,FLOOR_TOP+y,z);
    }
    for(const z of [.30,.76]){
      const post=add(meshOf(new THREE.BoxGeometry(.11,.55,.11),flat(PAL.timberDark)));
      post.position.set(-.89,FLOOR_TOP+.275,z);
    }
    const rail=add(meshOf(new THREE.BoxGeometry(.10,.10,.53),flat(PAL.timber)));
    rail.position.set(-.89,FLOOR_TOP+.36,.53);
  } else if(type==="rangeBeacon"){
    // Compact 1x1 signal mast: pale concentric hardware advertises tower support, while the hover
    // ring supplies the exact authored coverage radius.
    const base=add(meshOf(new THREE.CylinderGeometry(.72,.86,.30,8),flat(PAL.masonryDark)));base.position.y=FLOOR_TOP+.15;
    const cap=add(meshOf(new THREE.CylinderGeometry(.58,.68,.18,8),flat(PAL.masonry)));cap.position.y=FLOOR_TOP+.39;
    const mast=add(meshOf(new THREE.CylinderGeometry(.10,.14,1.75,8),flat(PAL.metal)));mast.position.y=FLOOR_TOP+1.30;
    for(const y of [1.02,1.48]){
      const ring=add(meshOf(new THREE.TorusGeometry(.42,.07,6,16),flat(PAL.towLightning)));
      ring.rotation.x=Math.PI/2;ring.position.y=FLOOR_TOP+y;
    }
    const signal=add(meshOf(new THREE.OctahedronGeometry(.34,0),flat(PAL.towLightning,{emissive:PAL.arcaneGlow})));
    signal.position.y=FLOOR_TOP+2.30;g.userData.tip=signal;
  } else if(type==="warShrine"){
    // A squat martial altar, visually distinct from the range beacon's tall signal mast.
    const base=add(meshOf(new THREE.CylinderGeometry(.76,.88,.34,6),flat(PAL.masonryDark)));base.position.y=FLOOR_TOP+.17;
    const altar=add(meshOf(new THREE.BoxGeometry(1.10,.48,.72),flat(PAL.masonry)));altar.position.y=FLOOR_TOP+.55;
    for(const turn of [-.62,.62]){
      const blade=add(meshOf(new THREE.BoxGeometry(.12,1.45,.10),flat(PAL.metal)));blade.position.y=FLOOR_TOP+1.25;blade.rotation.z=turn;
      const guard=add(meshOf(new THREE.BoxGeometry(.48,.10,.13),flat(PAL.timberDark)));guard.position.set(Math.sin(turn)*-.38,FLOOR_TOP+.94,0);guard.rotation.z=turn;
    }
    const crest=add(meshOf(new THREE.OctahedronGeometry(.28,0),flat(PAL.banner,{emissive:PAL.hurtGlow})));crest.position.y=FLOOR_TOP+1.82;g.userData.tip=crest;
  } else if(type==="wardTotem"){
    // Squat stone cairn behind a raised metal shield plate: reads "protection", staying low and
    // heavy against the beacon's mast and the war shrine's blades.
    const base=add(meshOf(new THREE.CylinderGeometry(.78,.90,.32,7),flat(PAL.masonryDark)));base.position.y=FLOOR_TOP+.16;
    for(const [y,r] of [[.52,.62],[.86,.46],[1.14,.30]]){
      const stone=add(meshOf(new THREE.CylinderGeometry(r*.86,r,.34,7),flat(PAL.masonry)));stone.position.y=FLOOR_TOP+y;
    }
    const shield=add(meshOf(new THREE.CylinderGeometry(.52,.52,.10,6),flat(PAL.metal)));
    shield.rotation.x=Math.PI/2;shield.position.set(0,FLOOR_TOP+.92,.58);
    const boss=add(meshOf(new THREE.OctahedronGeometry(.22,0),flat(PAL.towFreeze,{emissive:PAL.arcaneGlow})));
    boss.position.set(0,FLOOR_TOP+.92,.72);g.userData.tip=boss;
  } else if(type==="hasteTotem"){
    // Slim timber pole stacked with upward chevrons — speed, not force; the coin-bright tip keeps
    // it apart from the freeze-blue ward boss and the beacon's lightning rings.
    const base=add(meshOf(new THREE.CylinderGeometry(.66,.80,.28,8),flat(PAL.masonryDark)));base.position.y=FLOOR_TOP+.14;
    const pole=add(meshOf(new THREE.CylinderGeometry(.09,.12,1.85,8),flat(PAL.timberDark)));pole.position.y=FLOOR_TOP+1.20;
    for(const y of [.85,1.25,1.65]){
      const chevron=add(meshOf(new THREE.ConeGeometry(.34,.30,4),flat(PAL.timber)));
      chevron.position.y=FLOOR_TOP+y;chevron.rotation.y=Math.PI/4;
    }
    const tip=add(meshOf(new THREE.ConeGeometry(.26,.44,6),flat(PAL.coin,{emissive:PAL.arcaneGlow})));
    tip.position.y=FLOOR_TOP+2.28;g.userData.tip=tip;
  } else if(type==="garrison"){
    // Villager-built guard station on the ordinary 1x1 pad: a compact plaster-and-timber hut set
    // against the back (-Z) with an open drill yard in front (+Z), where the simulation posts its
    // guards (garrisonPost is the anchor at y+18, i.e. straight out the door). Palette is the shared
    // villager vocabulary — timber, plaster, stone, metal, banner — plus the guard coat colour on
    // the shields, so the station reads as the same builders who raised the house and the yard.
    // The two flagstones ARE the station's two slots (GARRISON.capacity is what the tray counts);
    // their pennants are userData.postMarkers, which scene.js raises one per ARRIVED guard, exactly
    // as the capture yard's bay caps follow its living allies. No new UI, no extra worker model.
    const hutW=1.42,hutD=.80,hutH=.86,hutZ=-.40,hutFront=hutZ+hutD/2,hutTop=FLOOR_TOP+hutH;

    // Hand-set footings under the hut corners, uneven like the tower's and the yard's stone courses.
    [[-.62,-.24],[.62,-.24],[-.62,-.72],[.62,-.72]].forEach(([x,z],i)=>{
      const footing=add(meshOf(new THREE.BoxGeometry(.42,.22,.42),flat(i%2?PAL.rockDark:PAL.rock)));
      footing.position.set(x,FLOOR_TOP+.11,z);
    });

    const walls=add(meshOf(new THREE.BoxGeometry(hutW,hutH,hutD),flat(PAL.plaster)));
    walls.position.set(0,FLOOR_TOP+hutH/2,hutZ);
    for(const x of [-hutW/2,hutW/2]) for(const z of [hutZ-hutD/2,hutZ+hutD/2]){
      const post=add(meshOf(new THREE.BoxGeometry(.12,hutH+.04,.12),flat(PAL.timber)));
      post.position.set(x,FLOOR_TOP+hutH/2,z);
    }
    const roof=add(meshOf(gablePrismGeometry(hutW+.20,.52,hutD+.20),flat(PAL.timber)));
    roof.position.set(0,hutTop,hutZ);
    const ridge=add(meshOf(new THREE.BoxGeometry(.13,.13,hutD+.24),flat(PAL.timberDark)));
    ridge.position.set(0,hutTop+.52,hutZ);

    // A single wide doorway facing the yard: the guards muster out of it, so nothing blocks +Z.
    const door=add(meshOf(new THREE.BoxGeometry(.52,.62,.12),flat(PAL.timberDark)));
    door.position.set(0,FLOOR_TOP+.31,hutFront+.05);
    const lintel=add(meshOf(new THREE.BoxGeometry(.70,.12,.14),flat(PAL.timber)));
    lintel.position.set(0,FLOOR_TOP+.68,hutFront+.06);

    // Shields hung either side of the door — the guard coat colour with a metal boss.
    for(const x of [-.50,.50]){
      const shield=add(meshOf(new THREE.CylinderGeometry(.21,.21,.08,8),flat(PAL.jobGuard)));
      shield.rotation.x=Math.PI/2;shield.position.set(x,FLOOR_TOP+.52,hutFront+.05);
      const boss=add(meshOf(new THREE.CylinderGeometry(.07,.07,.05,8),flat(PAL.metal)));
      boss.rotation.x=Math.PI/2;boss.position.set(x,FLOOR_TOP+.52,hutFront+.11);
    }

    // Muster standard at the back corner: the station's colours, visible over the roofline.
    const staff=add(meshOf(new THREE.CylinderGeometry(.05,.06,1.42,6),flat(PAL.pole)));
    staff.position.set(.74,FLOOR_TOP+.71,-.82);
    const flag=add(meshOf(new THREE.BoxGeometry(.30,.44,.05),flat(PAL.banner)));
    flag.position.set(.60,FLOOR_TOP+1.16,-.82);

    // Weapon rack on the left flank: two uprights, a crossbar and three racked spears.
    for(const z of [-.06,.30]){
      const upright=add(meshOf(new THREE.BoxGeometry(.10,.72,.10),flat(PAL.timber)));
      upright.position.set(-.80,FLOOR_TOP+.36,z);
    }
    const crossbar=add(meshOf(new THREE.BoxGeometry(.12,.10,.50),flat(PAL.timberDark)));
    crossbar.position.set(-.80,FLOOR_TOP+.64,.12);
    for(const z of [-.02,.12,.26]){
      const shaft=add(meshOf(new THREE.CylinderGeometry(.035,.035,.94,5),flat(PAL.timber)));
      shaft.position.set(-.80,FLOOR_TOP+.47,z);shaft.rotation.x=.10;
      const head=add(meshOf(new THREE.ConeGeometry(.06,.18,4),flat(PAL.metal)));
      head.position.set(-.80,FLOOR_TOP+1.03,z-.05);
    }

    // One station position per authored guard slot. Flagstones are permanent (the slots exist
    // whether or not they are filled); the pennants above them are the arrival read.
    const postMarkers=[];
    for(let i=0;i<GARRISON.capacity;i++){
      const x=(i-(GARRISON.capacity-1)/2)*.62,side=x>=0?1:-1;
      const flagstone=add(meshOf(new THREE.BoxGeometry(.42,.08,.42),flat(i%2?PAL.rockDark:PAL.rock)));
      flagstone.position.set(x,FLOOR_TOP+.04,.50);
      const pole=add(meshOf(new THREE.CylinderGeometry(.04,.05,.72,5),flat(PAL.pole)));
      pole.position.set(x+side*.24,FLOOR_TOP+.36,.50);
      const pennant=add(meshOf(new THREE.BoxGeometry(.24,.22,.04),flat(PAL.banner)));
      pennant.position.set(x+side*.12,FLOOR_TOP+.60,.50);
      postMarkers.push(pennant);
    }
    g.userData.postMarkers=postMarkers;
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
    // The puddle edge is the gameplay slow boundary; both consume the authored simulation radius.
    const radius=BUILDING_TYPES.tar.effectRadius*S;
    const p = add(meshOf(new THREE.CylinderGeometry(radius,radius,.12,24), flat(PAL.tar))); p.position.y=.06;
  } else if(type==="damageOrbs"){
    const hub=add(meshOf(new THREE.CylinderGeometry(.38,.52,.32,8),flat(PAL.masonryDark)));hub.position.y=.18;
    const orbit=new THREE.Group();orbit.position.y=.75;g.add(orbit);g.userData.orbit=orbit;g.userData.orbs=[];
    for(let i=0;i<3;i++){const orb=meshOf(new THREE.OctahedronGeometry(.25,0),flat(PAL.arcane,{emissive:PAL.arcaneGlow}));const a=i*Math.PI*2/3;orb.position.set(Math.cos(a)*1.65,0,Math.sin(a)*1.65);orbit.add(orb);g.userData.orbs.push(orb);}
  } else if(type==="summoningCircle"){
    // The reviewed sim-px working (src/render/models/summoning-circle.js) replaces the emissive
    // disc + torus. It rides the 3x3 pad like the main base does — its own holder, scaled by S,
    // lifted to the pad top — and nothing here joins `parts`: the hurt flash and the ghost tint
    // must never reach the violet glyph, which is the dust gauge and means one thing only.
    // userData.inner is what protects the whole subtree from bakeStatic() at the bottom of this
    // function (its keep-set walks userData), which matters more here than anywhere else: the
    // fuse would weld the five dust slots and the six decay stages into one un-switchable mesh.
    const model = CIRCLE_MODELS["summoning-circle"];
    const circle = withCircleGameTarget(GAME_TARGET, () => model.build());
    relightForGame(circle);
    adoptInkedModel(circle);
    const holder = new THREE.Group();
    holder.add(circle);
    holder.scale.setScalar(S);
    holder.position.y = FLOOR_TOP;
    g.add(holder);
    g.userData.inner = circle;
    g.userData.anims = model.anims;
    g.userData.slotMarkers = circle.userData.slotMarkers;   // one per dust in the circle (0..4)
    g.userData.ashRings = circle.userData.ashRings;         // six decay stages, driven by lifetime
  } else if(type==="meteorTarget"){
    const rock=add(meshOf(new THREE.DodecahedronGeometry(2.2,1),flat(PAL.stone)));rock.scale.y=.65;rock.position.y=1.1;
  } else if(type==="captureYard"){
    // Villager-built holding pen: timber palisade on hand-set stone footings, split into three
    // visible bays by inner dividers. Palette rule: timber/plaster/stone/sage only — violet stays
    // enemy/precursor information. userData.slotMarkers are the three sage bay caps scene.js shows
    // one-per-living-ally, so occupancy reads off the model itself.
    const E=2.55;                                            // fence half-extent inside the 3x3 pad
    const post=(x,z,h=1.05)=>{const p=add(meshOf(new THREE.BoxGeometry(.22,h,.22),flat(PAL.timberDark)));p.position.set(x,FLOOR_TOP+h/2,z);return p;};
    const rail=(x,z,w,d,y)=>{const r=add(meshOf(new THREE.BoxGeometry(w,.14,d),flat(PAL.timber)));r.position.set(x,FLOOR_TOP+y,z);return r;};
    for(const sx of [-1,1])for(const sz of [-1,1])post(sx*E,sz*E,1.2);
    post(-E,0);post(E,0);post(-.85,E);post(.85,E);           // side mid posts; the front pair frames the gate gap
    for(const y of [.42,.86]){
      rail(0,-E,2*E,.12,y);                                  // back run
      rail(-E,0,.12,2*E,y);rail(E,0,.12,2*E,y);              // side runs
      rail(-(E+.85)/2,E,E-.85,.12,y);rail((E+.85)/2,E,E-.85,.12,y);   // front runs either side of the gate
    }
    [[-E,-E],[E,-E],[-E,E],[E,E]].forEach(([x,z],i)=>{const footing=add(meshOf(new THREE.BoxGeometry(.6,.3,.6),flat(i%2?PAL.rockDark:PAL.rock)));footing.position.set(x,FLOOR_TOP+.15,z);});
    for(const x of [-.85,.85]){const divider=add(meshOf(new THREE.BoxGeometry(.14,.8,2),flat(PAL.timber)));divider.position.set(x,FLOOR_TOP+.4,-E+1);}
    const trough=add(meshOf(new THREE.BoxGeometry(1.1,.3,.5),flat(PAL.plaster)));trough.position.set(0,FLOOR_TOP+.15,.9);
    const slotMarkers=[];
    for(const x of [-1.7,0,1.7]){
      post(x,-E+.02,1.15);
      const cap=add(meshOf(new THREE.ConeGeometry(.22,.36,6),flat(PAL.sage)));cap.position.set(x,FLOOR_TOP+1.33,-E+.02);slotMarkers.push(cap);
    }
    g.userData.slotMarkers=slotMarkers;
  } else {
    const b = add(meshOf(new THREE.BoxGeometry(2,1.4,1.8), flat(PAL.blueprint))); b.position.y=.7;
  }
  // Added after `parts` is filled and deliberately NOT pushed into it: the tower hurt-flash and the
  // ghost tint iterate `parts`/meshes for the MODEL, and the ground pad must not join those effects.
  const grassTile = type==="house" || type==="tower";
  const floor = makeFootprintFloor(buildingFootprint(type), grassTile?PAL.grass:PAL.pad);
  g.add(floor);
  g.userData.floor = floor;
  g.userData.parts = parts;
  // Everything not hung on userData above fuses into one mesh; the hurt-flash list is rebuilt as
  // the merged mesh plus whichever authored parts survived (they kept their own materials).
  const fused = bakeStatic(g);
  if(fused) g.userData.parts = [fused, ...parts.filter(part => part.parent)];
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
  bakeStatic(g);                              // four corner posts fuse into one mesh
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
