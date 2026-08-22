// Owns: the shared model-building kit — the game-pixel->world-unit scale, the ground seat, the
// flat Lambert helper, outline shells (world-unit and sim-px), static baking, group disposal and
// the gable prism. Every model file imports from here; this file imports from no model file
// (dependency direction: kit <- game-rig <- adopt <- models/*/ <- models.js barrel).
import * as THREE from "three";
import {SWATCH} from "../palette.js";
import {setToneTargets} from "../material-light-mods.js";
import {TONE_RIG, TONE_RIG_NIGHT} from "../rig.js";
import {W,H} from "../../game/data.js";

// ── the one unit conversion the whole render layer shares ───────────────────
// The simulation thinks in 2D game pixels; three.js thinks in world units. game (x, y) maps to
// world (x*S, 0, y*S). It lives here because every model dimension below is expressed against it,
// and scene.js imports it rather than restating the ratio.
export const S = 1/16;                       // game pixels -> world units
export const WU = W*S, HU = H*S;             // 480 x 320 world units
export const gx = x => x*S, gz = y => y*S;

export const flat = (color, extra={}) => new THREE.MeshLambertMaterial({color, flatShading:true, ...extra});
// flat() + authored tone targets (palette.js TONES): the material's albedo is the triple's albedo,
// its flat-lit face renders `lit` and its shaded face `shadow` exactly (material-light-mods).
// For live-rig models only (trees, rocks); baked casts go through game-rig.js instead.
// The tone triple carries its own `night` pair (palette.js TONES_NIGHT), so a toned material joins
// the night tier by existing — nothing here or in the model files chooses a night colour.
export const toned = (tone, extra={}) => {
  const m = flat(tone.albedo, extra);
  setToneTargets(m, {...tone, rig: TONE_RIG, nightRig: TONE_RIG_NIGHT});
  return m;
};
// ── outlines ────────────────────────────────────────────────────────────────
// Inverted hull: a back-faced copy of each prop pushed out along its normals,
// so only the shell behind the object survives depth testing and reads as ink.
// Costs one extra draw per prop; hidden meshes are skipped, so the toggle is free.
// OUTLINE_ON is a module-private `let` with exactly one writer, setOutlines() below — the view
// debugger calls that function, it never assigns the flag, because an imported binding is read-only.
let OUTLINE_ON = true;
export const outlineMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  // Ink is SWATCH.shade2 (Aug 22): the palette's own night-black, cool to match the lavender
  // hemi the shadows now bridge into. The old 0x1d1712 was a warm near-black solved against the
  // deleted warm hemi pair and printed a brown line around every cool-shaded prop.
  uniforms: {thickness:{value:.05}, tint:{value:new THREE.Color(SWATCH.shade2)}},
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

// ── sim-px model adoption ───────────────────────────────────────────────────
// The reviewed models (src/render/models/reviewed/worker-peg.js, the-hole.js) are standalone modules
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
export function addPxOutline(mesh){
  const shell = new THREE.Mesh(mesh.geometry, outlineMatPx);
  shell.castShadow = shell.receiveShadow = false;
  shell.userData.outline = true;
  shell.visible = OUTLINE_ON;
  mesh.add(shell);
  outlineShells.push(shell);
}

// ── the ground seat ─────────────────────────────────────────────────────────
// Every building body seats its bottom face here. It is plain 0: the terrain plane is y=0 and
// bodies stand directly ON it. Until Aug 22 it was .096, the top of the flat footprint-sized PAD
// mesh this kit drew under every building; the pads are deleted (owner: "if we have soil now — we can remove the ugly 'floor' around buildings — just have the soil"), and
// the bare ground under a footprint is now painted by the terrain itself, from the wear field
// scene.js stamps (rebuildWearStatic -> landSoil.uLandSoilAt).
// Kept as a named constant rather than inlined: it is the one place to change if the ground ever
// stops being flat, and it names what `+ h/2` in every body means.
export const GROUND_Y = 0;

// Fresh closed triangular prism for a pitched-roof gable. Positions are local to the wall top;
// non-indexed faces keep the low-poly planes hard and let disposeGroup() own the geometry normally.
export function gablePrismGeometry(w,h,d){
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
