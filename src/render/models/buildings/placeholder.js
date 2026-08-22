// Owns: the placeholder building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: none — the fallback box for an unknown type.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const b = add(meshOf(new THREE.BoxGeometry(2,1.4,1.8), flat(PAL.blueprint))); b.position.y=.7;
}
