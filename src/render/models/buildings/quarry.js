// Owns: the quarry building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const b = add(meshOf(new THREE.BoxGeometry(2.3,1.2,1.9), flat(PAL.quarryWall))); b.position.y=.6;
  const r = add(meshOf(new THREE.ConeGeometry(1.7,.9,5), flat(PAL.quarryRoof))); r.position.y=1.6;
  const s = add(meshOf(new THREE.DodecahedronGeometry(.45,0), flat(PAL.stone))); s.position.set(1.1,.3,.9);
}
