// Owns: the war shrine building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: userData.tip.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, FLOOR_TOP} from "../kit.js";

export function build(g, add){
  // A squat martial altar, visually distinct from the range beacon's tall signal mast.
  const base=add(meshOf(new THREE.CylinderGeometry(.76,.88,.34,6),flat(PAL.masonryDark)));base.position.y=FLOOR_TOP+.17;
  const altar=add(meshOf(new THREE.BoxGeometry(1.10,.48,.72),flat(PAL.masonry)));altar.position.y=FLOOR_TOP+.55;
  for(const turn of [-.62,.62]){
    const blade=add(meshOf(new THREE.BoxGeometry(.12,1.45,.10),flat(PAL.metal)));blade.position.y=FLOOR_TOP+1.25;blade.rotation.z=turn;
    const guard=add(meshOf(new THREE.BoxGeometry(.48,.10,.13),flat(PAL.timberDark)));guard.position.set(Math.sin(turn)*-.38,FLOOR_TOP+.94,0);guard.rotation.z=turn;
  }
  const crest=add(meshOf(new THREE.OctahedronGeometry(.28,0),flat(PAL.banner,{emissive:PAL.hurtGlow})));crest.position.y=FLOOR_TOP+1.82;g.userData.tip=crest;
}
