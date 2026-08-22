// Owns: ground drops (makeDrop, contract userData.body) and the smaller cursor-pile items.
import * as THREE from "three";
import {PAL, DROP_COLOR} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function makeDrop(kind){
  const g = new THREE.Group();
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.16,.16,.8,6), flat(col)); m.rotation.z=Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.3,.3,.09,10), flat(col)); m.rotation.x=Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.32,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.3,0), flat(col));
  m.position.y = .3;
  g.add(m);
  g.userData = {body:m};
  return g;
}
/** One carried item in the cursor pile. Smaller than makeDrop()'s ground models, by design. */
export function handMeshFor(kind){
  const col = DROP_COLOR[kind] || PAL.wood;
  let m;
  if(kind==="wood"){ m = meshOf(new THREE.CylinderGeometry(.13,.13,.62,6), flat(col)); m.rotation.z = Math.PI/2; }
  else if(kind==="coin"){ m = meshOf(new THREE.CylinderGeometry(.22,.22,.07,10), flat(col)); m.rotation.x = Math.PI/2; }
  else if(kind==="diamond") m = meshOf(new THREE.OctahedronGeometry(.24,0), flat(col));
  else m = meshOf(new THREE.DodecahedronGeometry(.22,0), flat(col));
  return m;
}
