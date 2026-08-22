// Owns: the ward totem building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: userData.tip.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, GROUND_Y} from "../kit.js";

export function build(g, add){
  // Squat stone cairn behind a raised metal shield plate: reads "protection", staying low and
  // heavy against the beacon's mast and the war shrine's blades.
  const base=add(meshOf(new THREE.CylinderGeometry(.78,.90,.32,7),flat(PAL.masonryDark)));base.position.y=GROUND_Y+.16;
  for(const [y,r] of [[.52,.62],[.86,.46],[1.14,.30]]){
    const stone=add(meshOf(new THREE.CylinderGeometry(r*.86,r,.34,7),flat(PAL.masonry)));stone.position.y=GROUND_Y+y;
  }
  const shield=add(meshOf(new THREE.CylinderGeometry(.52,.52,.10,6),flat(PAL.metal)));
  shield.rotation.x=Math.PI/2;shield.position.set(0,GROUND_Y+.92,.58);
  const boss=add(meshOf(new THREE.OctahedronGeometry(.22,0),flat(PAL.towFreeze,{emissive:PAL.arcaneGlow})));
  boss.position.set(0,GROUND_Y+.92,.72);g.userData.tip=boss;
}
