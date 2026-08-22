// Owns: the fireball target building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none (aiming ghost).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  // Aiming ghost only (target-only row, never a standing building): a hot ember sphere so the
  // 50%-opacity preview reads "fire lands here", distinct from the blast charge's keg.
  const ember=add(meshOf(new THREE.IcosahedronGeometry(.55,1),flat(PAL.charge)));ember.position.y=.6;
  const glow=add(meshOf(new THREE.IcosahedronGeometry(.34,1),flat(PAL.fuse)));glow.position.y=.6;
}
