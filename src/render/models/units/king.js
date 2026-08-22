// Owns: the king figure. Contract: userData.sword.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, bakeStatic} from "../kit.js";

export function makeKing(){
  const g = new THREE.Group();
  const body = meshOf(new THREE.CapsuleGeometry(.26,.44,3,7), flat(PAL.kingRobe));
  body.position.y = .58;
  const head = meshOf(new THREE.SphereGeometry(.24,8,6), flat(PAL.skin));
  head.position.y = 1.12;
  const crown = meshOf(new THREE.CylinderGeometry(.26,.26,.2,6), flat(PAL.kingCrown));
  crown.position.y = 1.36;
  const sword = meshOf(new THREE.BoxGeometry(.08,.86,.08), flat(PAL.blade));
  sword.position.set(.38,.86,0);
  g.add(body, head, crown, sword);
  g.userData = {sword};
  bakeStatic(g);
  return g;
}
