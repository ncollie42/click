// Owns: the stockpile building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const p = add(meshOf(new THREE.BoxGeometry(2.6,.24,2.2), flat(PAL.scaffold))); p.position.y=.12;
  const c1 = add(meshOf(new THREE.BoxGeometry(.9,.7,.9), flat(PAL.wood))); c1.position.set(-.6,.55,0);
  const c2 = add(meshOf(new THREE.BoxGeometry(.8,.55,.8), flat(PAL.stone))); c2.position.set(.65,.48,.2);
}
