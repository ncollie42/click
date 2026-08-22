// Owns: the spikes building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  for(let i=0;i<5;i++){
    const s = add(meshOf(new THREE.ConeGeometry(.16,.85,4), flat(PAL.metal)));
    s.position.set((i%3-1)*.55, .42, (Math.floor(i/3)-.5)*.6);
  }
}
