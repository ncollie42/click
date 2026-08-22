// Owns: the lumber building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const b = add(meshOf(new THREE.BoxGeometry(2.4,1.3,1.9), flat(PAL.scaffold))); b.position.y=.65;
  const r = add(meshOf(new THREE.BoxGeometry(2.7,.28,2.2), flat(PAL.roofDark))); r.position.y=1.42;
  const log = add(meshOf(new THREE.CylinderGeometry(.22,.22,1.8,6), flat(PAL.wood)));
  log.rotation.x=Math.PI/2; log.position.set(1.1,.24,.9);
}
