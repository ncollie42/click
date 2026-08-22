// Owns: the Consumable Forge building body. build(g, add) hangs parts via add();
// buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, FLOOR_TOP} from "../kit.js";

export function build(g, add){
  const body=add(meshOf(new THREE.BoxGeometry(1.5,1.5,1.5),flat(PAL.masonryDark)));
  body.position.y=FLOOR_TOP+.75;
}
