// Owns: the house building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: none (front is +Z).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, GROUND_Y, gablePrismGeometry} from "../kit.js";

export function build(g, add){
  // Front is +Z, matching the house worker spawn/post at simulation y+23. The cottage remains
  // centered inside the anchor cell while its footprint floor reserves the full 3x3 yard.
  const wallH=1.14,wallW=1.46,wallD=1.30,wallTop=GROUND_Y+wallH;
  const walls=add(meshOf(new THREE.BoxGeometry(wallW,wallH,wallD),flat(PAL.plaster)));
  walls.position.y=GROUND_Y+wallH/2;

  const roofRun=.89,roofRise=.90,roofDepth=1.58;
  const gable=add(meshOf(gablePrismGeometry(wallW,roofRise,wallD),flat(PAL.plaster)));
  gable.position.y=wallTop;

  // Three broad, overlapping rows per slope suggest hand-laid shingles without texture detail.
  const slope=Math.hypot(roofRun,roofRise),angle=Math.atan2(roofRise,roofRun),rows=3;
  for(const side of [-1,1]) for(let i=0;i<rows;i++){
    const t=(i+.5)/rows;
    const shingle=add(meshOf(
      new THREE.BoxGeometry(slope/rows+.08,.09,roofDepth),
      flat((i+(side>0?1:0))%2 ? PAL.timberDark : PAL.timber)
    ));
    shingle.position.set(side*roofRun*(1-t),wallTop+roofRise*t,0);
    shingle.rotation.z=side<0?angle:-angle;
  }
  const ridge=add(meshOf(new THREE.BoxGeometry(.14,.14,roofDepth+.04),flat(PAL.timberDark)));
  ridge.position.y=wallTop+roofRise;

  // Rough timber frame. Front jambs and lintel enlarge the door read; the other beams expose the
  // plaster-over-frame construction from any camera quarter without ornamenting it.
  for(const [x,z] of [[-wallW/2,-wallD/2],[wallW/2,-wallD/2],[-wallW/2,wallD/2],[wallW/2,wallD/2]]){
    const post=add(meshOf(new THREE.BoxGeometry(.12,wallH+.04,.12),flat(PAL.timber)));
    post.position.set(x,GROUND_Y+wallH/2,z);
  }
  for(const x of [-wallW/2,wallW/2]){
    const eave=add(meshOf(new THREE.BoxGeometry(.13,.13,wallD+.08),flat(PAL.timberDark)));
    eave.position.set(x,wallTop,0);
  }
  const frontBeam=add(meshOf(new THREE.BoxGeometry(wallW+.08,.13,.13),flat(PAL.timberDark)));
  frontBeam.position.set(0,wallTop,wallD/2+.025);
  const gablePost=add(meshOf(new THREE.BoxGeometry(.11,roofRise,.11),flat(PAL.timber)));
  gablePost.position.set(0,wallTop+roofRise/2,wallD/2+.035);

  const door=add(meshOf(new THREE.BoxGeometry(.66,1.04,.14),flat(PAL.timberDark)));
  door.position.set(0,GROUND_Y+.52,wallD/2+.07);
  for(const x of [-.39,.39]){
    const jamb=add(meshOf(new THREE.BoxGeometry(.13,1.10,.16),flat(PAL.timber)));
    jamb.position.set(x,GROUND_Y+.55,wallD/2+.10);
  }
  const lintel=add(meshOf(new THREE.BoxGeometry(.91,.15,.17),flat(PAL.timber)));
  lintel.position.set(0,GROUND_Y+1.08,wallD/2+.10);

  // The chimney is three slightly misaligned stone courses, not one machined extrusion.
  for(let i=0;i<3;i++){
    const course=add(meshOf(new THREE.BoxGeometry(.31-(i%2)*.02,.27,.31),flat(PAL.rock)));
    course.position.set(.43+(i===1?.025:0),1.84+i*.255,-.27);
    course.rotation.y=(i-1)*.045;
  }

  // Tiny side props keep the doorway clear for worker births at +Z.
  for(const [z,y] of [[-.24,.20],[-.08,.20],[-.16,.38]]){
    const log=add(meshOf(new THREE.CylinderGeometry(.09,.10,.42,6),flat(PAL.timber)));
    log.rotation.x=Math.PI/2;
    log.position.set(.82,GROUND_Y+y,z);
  }
  for(const z of [.30,.76]){
    const post=add(meshOf(new THREE.BoxGeometry(.11,.55,.11),flat(PAL.timberDark)));
    post.position.set(-.89,GROUND_Y+.275,z);
  }
  const rail=add(meshOf(new THREE.BoxGeometry(.10,.10,.53),flat(PAL.timber)));
  rail.position.set(-.89,GROUND_Y+.36,.53);
}
