// Owns: the obelisk building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: userData.tip.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const b = add(meshOf(new THREE.BoxGeometry(1.5,.4,1.5), flat(PAL.masonryDark))); b.position.y=.2;
  const sh = add(meshOf(new THREE.CylinderGeometry(.36,.52,3.0,5), flat(PAL.masonry))); sh.position.y=1.9;
  const tip = add(meshOf(new THREE.OctahedronGeometry(.44,0), flat(PAL.arcane,{emissive:PAL.arcaneGlow}))); tip.position.y=3.7;
  g.userData.tip = tip;
}
