// Owns: the training dummy. Contract: userData.target, bull.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, bakeStatic} from "../kit.js";

export function makeDamageDummy(){
  const g=new THREE.Group();
  const post=meshOf(new THREE.CylinderGeometry(.18,.24,1.45,8),flat(PAL.timber));post.position.y=.72;
  const target=meshOf(new THREE.CylinderGeometry(.72,.72,.18,12),flat(PAL.plasterLit));target.rotation.x=Math.PI/2;target.position.y=1.35;
  const bull=meshOf(new THREE.CylinderGeometry(.32,.32,.2,12),flat(PAL.bad));bull.rotation.x=Math.PI/2;bull.position.set(0,1.35,.03);
  const base=meshOf(new THREE.BoxGeometry(1.15,.16,.75),flat(PAL.masonryDark));base.position.y=.08;
  g.add(post,target,bull,base);g.userData={target,bull};bakeStatic(g);return g;
}
