// Owns: adopting the reviewed sim-px modules (models/reviewed/*) into the game's shadow and
// outline conventions. Geometry and materials are never edited — viewer and game render the
// identical model.
import * as THREE from "three";
import {isOutline, addPxOutline, adoptOutlineShell} from "./kit.js";

// A module that draws its OWN ink keeps it: summoning-circle's screen-space hull is built around a
// silhouette DONOR (its kerb is a carved slab whose own edges must not be inked) and has a device-
// pixel floor the world-space house shell has no way to reproduce. So this adoption sets the
// shadow flags and hands the module's shells to the outline registry — the view panel's toggle
// reaches them — and deliberately runs no addPxOutline pass, which would double every line.
// disposeGroup() knows to free these (they own a private geometry and ShaderMaterial each).
export function adoptInkedModel(group){
  group.traverse(o=>{
    if(!o.isMesh) return;
    if(isOutline(o)){ adoptOutlineShell(o); return; }
    o.castShadow = true;                 // silently refused by the module's noShadow locks
    o.receiveShadow = true;
  });
  return group;
}
export function adoptModel(group){
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
