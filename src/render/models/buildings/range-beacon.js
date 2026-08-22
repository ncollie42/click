// Owns: the range beacon building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: userData.tip.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, GROUND_Y} from "../kit.js";

export function build(g, add){
  // Compact 1x1 signal mast: pale concentric hardware advertises tower support, while the hover
  // ring supplies the exact authored coverage radius.
  const base=add(meshOf(new THREE.CylinderGeometry(.72,.86,.30,8),flat(PAL.masonryDark)));base.position.y=GROUND_Y+.15;
  const cap=add(meshOf(new THREE.CylinderGeometry(.58,.68,.18,8),flat(PAL.masonry)));cap.position.y=GROUND_Y+.39;
  const mast=add(meshOf(new THREE.CylinderGeometry(.10,.14,1.75,8),flat(PAL.metal)));mast.position.y=GROUND_Y+1.30;
  for(const y of [1.02,1.48]){
    const ring=add(meshOf(new THREE.TorusGeometry(.42,.07,6,16),flat(PAL.towLightning)));
    ring.rotation.x=Math.PI/2;ring.position.y=GROUND_Y+y;
  }
  const signal=add(meshOf(new THREE.OctahedronGeometry(.34,0),flat(PAL.towLightning,{emissive:PAL.arcaneGlow})));
  signal.position.y=GROUND_Y+2.30;g.userData.tip=signal;
}
