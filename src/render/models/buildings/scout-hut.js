// Owns: the scout hut building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, FLOOR_TOP} from "../kit.js";

export function build(g, add){
  // One-cell expedition camp: canvas lean-to on timber poles, banner pole out front. The banner
  // shares PAL.banner with the garrison pennants — allied signage, not enemy violet.
  const back=add(meshOf(new THREE.BoxGeometry(.16,1.0,.16),flat(PAL.timberDark)));back.position.set(-.55,FLOOR_TOP+.5,0);
  const canvas=add(meshOf(new THREE.BoxGeometry(1.5,.1,1.3),flat(PAL.plaster)));
  canvas.position.set(0,FLOOR_TOP+.78,0);canvas.rotation.z=.62;
  const front=add(meshOf(new THREE.BoxGeometry(.14,.5,.14),flat(PAL.timber)));front.position.set(.58,FLOOR_TOP+.25,-.5);
  const front2=add(meshOf(new THREE.BoxGeometry(.14,.5,.14),flat(PAL.timber)));front2.position.set(.58,FLOOR_TOP+.25,.5);
  const bedroll=add(meshOf(new THREE.BoxGeometry(.9,.14,.42),flat(PAL.timberDark)));bedroll.position.set(-.1,FLOOR_TOP+.07,.28);
  const pole=add(meshOf(new THREE.CylinderGeometry(.05,.06,1.5,5),flat(PAL.pole)));pole.position.set(.72,FLOOR_TOP+.75,.62);
  const flag=add(meshOf(new THREE.BoxGeometry(.4,.26,.05),flat(PAL.banner)));flag.position.set(.94,FLOOR_TOP+1.32,.62);
}
