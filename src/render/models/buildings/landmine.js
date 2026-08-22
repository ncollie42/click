// Owns: the landmine building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const b = add(meshOf(new THREE.CylinderGeometry(.5,.55,.4,8), flat(PAL.chargeBody))); b.position.y=.2;
  const t = add(meshOf(new THREE.CylinderGeometry(.14,.14,.3,6), flat(PAL.fuse))); t.position.y=.52;
}
