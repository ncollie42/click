// Owns: the building registry and the frame every building body shares. One file per type in
// this folder exports build(g, add); this file wraps it with the parts list and the static bake.
// Adding a building = add a file here + one registry line. Unknown types get the placeholder box.
//
// No ground pad (Aug 22, owner). Every building used to get a footprint-sized flat floor mesh
// here; the terrain now paints PAL.soil under the footprint itself, off the wear field scene.js
// stamps (rebuildWearStatic), so a body seats straight on the ground at kit.js GROUND_Y.
//
// Contract out (scene.js drives these): userData.parts (hurt-flash / ghost-tint targets: the fused
// mesh plus whatever authored parts survived the bake), plus whatever hooks the body hung (roof,
// tip, postMarkers, slotMarkers, orbit/orbs, inner/anims/ashRings) — each body's header names its own.
import * as THREE from "three";
import {bakeStatic} from "../kit.js";
import {build as tower} from "./tower.js";
import {build as house} from "./house.js";
import {build as rangeBeacon} from "./range-beacon.js";
import {build as warShrine} from "./war-shrine.js";
import {build as wardTotem} from "./ward-totem.js";
import {build as hasteTotem} from "./haste-totem.js";
import {build as garrison} from "./garrison.js";
import {build as lumber} from "./lumber.js";
import {build as quarry} from "./quarry.js";
import {build as stockpile} from "./stockpile.js";
import {build as obelisk} from "./obelisk.js";
import {build as blast} from "./blast.js";
import {build as landmine} from "./landmine.js";
import {build as spikes} from "./spikes.js";
import {build as tar} from "./tar.js";
import {build as damageOrbs} from "./damage-orbs.js";
import {build as summoningCircle} from "./summoning-circle.js";
import {build as meteorTarget} from "./meteor-target.js";
import {build as fireballTarget} from "./fireball-target.js";
import {build as scoutHut} from "./scout-hut.js";
import {build as captureYard} from "./capture-yard.js";
import {build as consumableForge} from "./consumable-forge.js";
import {build as mainBase} from "./main-base.js";
import {build as placeholder} from "./placeholder.js";

// Keys are BUILDING_TYPES ids (data.js) — the sim's vocabulary, verbatim.
export const BUILDING_BUILDERS = Object.freeze({
  tower, house, rangeBeacon, warShrine, wardTotem, hasteTotem, garrison, lumber, quarry,
  stockpile, obelisk, blast, landmine, spikes, tar, damageOrbs, summoningCircle, meteorTarget,
  fireballTarget, scoutHut, captureYard, consumableForge, mainBase,
});

export function makeBuilding(type){
  const g = new THREE.Group();
  const parts = [];
  const add = (m)=>{ g.add(m); parts.push(m); return m; };
  (BUILDING_BUILDERS[type] ?? placeholder)(g, add);
  g.userData.parts = parts;
  // Everything not hung on userData above fuses into one mesh; the hurt-flash list is rebuilt as
  // the merged mesh plus whichever authored parts survived (they kept their own materials).
  const fused = bakeStatic(g);
  if(fused) g.userData.parts = [fused, ...parts.filter(part => part.parent)];
  return g;
}
