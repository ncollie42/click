// Owns: the construction-site blueprint (pad + four posts). Contract: userData.floor.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {CELL} from "../../../game/data.js";
import {buildingFootprint} from "../../../game/grid.js";
import {S, flat, meshOf, bakeStatic, FLOOR_TOP, makeFootprintFloor} from "../kit.js";

// Blueprints are footprint-aware too: same pad the finished building will get, so completing a
// structure never changes the ground it reserved. Posts ride the footprint corners.
export function makeBlueprint(type){
  const g = new THREE.Group();
  const fp = buildingFootprint(type);
  const w = fp.w*CELL*S, d = fp.h*CELL*S;
  const pad = makeFootprintFloor(buildingFootprint(type), PAL.scaffold);
  g.add(pad);
  g.userData.floor = pad;
  const post = .18, ix = w/2 - post/2 - .06, iz = d/2 - post/2 - .06;
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    const p = meshOf(new THREE.BoxGeometry(post,1.1,post), flat(PAL.blueprint));
    p.position.set(sx*ix, FLOOR_TOP + .55, sz*iz);
    g.add(p);
  }
  bakeStatic(g);                              // four corner posts fuse into one mesh
  return g;
}
