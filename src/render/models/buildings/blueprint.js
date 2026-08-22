// Owns: the construction-site blueprint — four corner posts on the reserved footprint's corners.
// No ground pad (Aug 22, owner): the site's bare soil is painted by the terrain off the wear field
// scene.js stamps for the building record, exactly as for the finished body.
// Contract: no userData hooks.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {CELL} from "../../../game/data.js";
import {buildingFootprint} from "../../../game/grid.js";
import {S, flat, meshOf, bakeStatic, GROUND_Y} from "../kit.js";

// Blueprints are footprint-aware: the posts mark the exact cells canPlace() reserved, so
// completing a structure never changes the ground it claimed.
export function makeBlueprint(type){
  const g = new THREE.Group();
  const fp = buildingFootprint(type);
  const w = fp.w*CELL*S, d = fp.h*CELL*S;
  const post = .18, ix = w/2 - post/2 - .06, iz = d/2 - post/2 - .06;
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    const p = meshOf(new THREE.BoxGeometry(post,1.1,post), flat(PAL.blueprint));
    p.position.set(sx*ix, GROUND_Y + .55, sz*iz);
    g.add(p);
  }
  bakeStatic(g);                              // four corner posts fuse into one mesh
  return g;
}
