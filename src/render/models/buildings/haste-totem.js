// Owns: the haste totem building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: userData.tip.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, FLOOR_TOP} from "../kit.js";

export function build(g, add){
  // Slim timber pole stacked with upward chevrons — speed, not force; the coin-bright tip keeps
  // it apart from the freeze-blue ward boss and the beacon's lightning rings.
  const base=add(meshOf(new THREE.CylinderGeometry(.66,.80,.28,8),flat(PAL.masonryDark)));base.position.y=FLOOR_TOP+.14;
  const pole=add(meshOf(new THREE.CylinderGeometry(.09,.12,1.85,8),flat(PAL.timberDark)));pole.position.y=FLOOR_TOP+1.20;
  for(const y of [.85,1.25,1.65]){
    const chevron=add(meshOf(new THREE.ConeGeometry(.34,.30,4),flat(PAL.timber)));
    chevron.position.y=FLOOR_TOP+y;chevron.rotation.y=Math.PI/4;
  }
  const tip=add(meshOf(new THREE.ConeGeometry(.26,.44,6),flat(PAL.coin,{emissive:PAL.arcaneGlow})));
  tip.position.y=FLOOR_TOP+2.28;g.userData.tip=tip;
}
