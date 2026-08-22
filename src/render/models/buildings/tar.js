// Owns: the tar building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none (radius from BUILDING_TYPES.tar.effectRadius).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {BUILDING_TYPES} from "../../../game/data.js";
import {S, flat, meshOf} from "../kit.js";

export function build(g, add){
  // The puddle edge is the gameplay slow boundary; both consume the authored simulation radius.
  const radius=BUILDING_TYPES.tar.effectRadius*S;
  const p = add(meshOf(new THREE.CylinderGeometry(radius,radius,.12,24), flat(PAL.tar))); p.position.y=.06;
}
