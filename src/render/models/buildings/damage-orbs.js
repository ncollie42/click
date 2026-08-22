// Owns: the damage orbs building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: userData.orbit (group), orbs.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const hub=add(meshOf(new THREE.CylinderGeometry(.38,.52,.32,8),flat(PAL.masonryDark)));hub.position.y=.18;
  const orbit=new THREE.Group();orbit.position.y=.75;g.add(orbit);g.userData.orbit=orbit;g.userData.orbs=[];
  for(let i=0;i<3;i++){const orb=meshOf(new THREE.OctahedronGeometry(.25,0),flat(PAL.arcane,{emissive:PAL.arcaneGlow}));const a=i*Math.PI*2/3;orb.position.set(Math.cos(a)*1.65,0,Math.sin(a)*1.65);orbit.add(orb);g.userData.orbs.push(orb);}
}
