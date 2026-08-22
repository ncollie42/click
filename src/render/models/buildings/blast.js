// Owns: the blast building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const b = add(meshOf(new THREE.CylinderGeometry(.55,.62,.8,8), flat(PAL.chargeBody))); b.position.y=.4;
  const t = add(meshOf(new THREE.SphereGeometry(.28,8,6), flat(PAL.charge))); t.position.y=.95;
}
