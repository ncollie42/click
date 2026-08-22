// Owns: the meteor target building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: none (aiming ghost).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf} from "../kit.js";

export function build(g, add){
  const rock=add(meshOf(new THREE.DodecahedronGeometry(2.2,1),flat(PAL.stone)));rock.scale.y=.65;rock.position.y=1.1;
}
