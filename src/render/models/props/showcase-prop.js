// Owns: showcase-only props (barrel, crate).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, bakeStatic} from "../kit.js";

export function makeShowcaseProp(model){
  const g=new THREE.Group();
  if(model==="barrel"){
    const body=meshOf(new THREE.CylinderGeometry(.48,.54,.95,10),flat(PAL.timber));body.position.y=.5;
    for(const y of [.18,.82]){const band=meshOf(new THREE.TorusGeometry(.51,.055,4,10),flat(PAL.metal));band.rotation.x=Math.PI/2;band.position.y=y;g.add(band);}g.add(body);
  }else{
    const box=meshOf(new THREE.BoxGeometry(1,1,1),flat(PAL.wood));box.position.y=.5;
    const brace=meshOf(new THREE.BoxGeometry(1.08,.12,.12),flat(PAL.timberDark));brace.position.set(0,.5,.51);brace.rotation.z=Math.PI/4;g.add(box,brace);
  }
  bakeStatic(g);
  return g;
}
