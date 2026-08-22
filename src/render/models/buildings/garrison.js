// Owns: the garrison building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: userData.postMarkers (one pennant per guard slot).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {GARRISON} from "../../../game/data.js";
import {flat, meshOf, GROUND_Y, gablePrismGeometry} from "../kit.js";

export function build(g, add){
  // Villager-built guard station on the ordinary 1x1 footprint: a compact plaster-and-timber hut set
  // against the back (-Z) with an open drill yard in front (+Z), where the simulation posts its
  // guards (garrisonPost is the anchor at y+18, i.e. straight out the door). Palette is the shared
  // villager vocabulary — timber, plaster, stone, metal, banner — plus the guard coat colour on
  // the shields, so the station reads as the same builders who raised the house and the yard.
  // The two flagstones ARE the station's two slots (GARRISON.capacity is what the tray counts);
  // their pennants are userData.postMarkers, which scene.js raises one per ARRIVED guard, exactly
  // as the capture yard's bay caps follow its living allies. No new UI, no extra worker model.
  const hutW=1.42,hutD=.80,hutH=.86,hutZ=-.40,hutFront=hutZ+hutD/2,hutTop=GROUND_Y+hutH;

  // Hand-set footings under the hut corners, uneven like the tower's and the yard's stone courses.
  [[-.62,-.24],[.62,-.24],[-.62,-.72],[.62,-.72]].forEach(([x,z],i)=>{
    const footing=add(meshOf(new THREE.BoxGeometry(.42,.22,.42),flat(i%2?PAL.rockDark:PAL.rock)));
    footing.position.set(x,GROUND_Y+.11,z);
  });

  const walls=add(meshOf(new THREE.BoxGeometry(hutW,hutH,hutD),flat(PAL.plaster)));
  walls.position.set(0,GROUND_Y+hutH/2,hutZ);
  for(const x of [-hutW/2,hutW/2]) for(const z of [hutZ-hutD/2,hutZ+hutD/2]){
    const post=add(meshOf(new THREE.BoxGeometry(.12,hutH+.04,.12),flat(PAL.timber)));
    post.position.set(x,GROUND_Y+hutH/2,z);
  }
  const roof=add(meshOf(gablePrismGeometry(hutW+.20,.52,hutD+.20),flat(PAL.timber)));
  roof.position.set(0,hutTop,hutZ);
  const ridge=add(meshOf(new THREE.BoxGeometry(.13,.13,hutD+.24),flat(PAL.timberDark)));
  ridge.position.set(0,hutTop+.52,hutZ);

  // A single wide doorway facing the yard: the guards muster out of it, so nothing blocks +Z.
  const door=add(meshOf(new THREE.BoxGeometry(.52,.62,.12),flat(PAL.timberDark)));
  door.position.set(0,GROUND_Y+.31,hutFront+.05);
  const lintel=add(meshOf(new THREE.BoxGeometry(.70,.12,.14),flat(PAL.timber)));
  lintel.position.set(0,GROUND_Y+.68,hutFront+.06);

  // Shields hung either side of the door — the guard coat colour with a metal boss.
  for(const x of [-.50,.50]){
    const shield=add(meshOf(new THREE.CylinderGeometry(.21,.21,.08,8),flat(PAL.jobGuard)));
    shield.rotation.x=Math.PI/2;shield.position.set(x,GROUND_Y+.52,hutFront+.05);
    const boss=add(meshOf(new THREE.CylinderGeometry(.07,.07,.05,8),flat(PAL.metal)));
    boss.rotation.x=Math.PI/2;boss.position.set(x,GROUND_Y+.52,hutFront+.11);
  }

  // Muster standard at the back corner: the station's colours, visible over the roofline.
  const staff=add(meshOf(new THREE.CylinderGeometry(.05,.06,1.42,6),flat(PAL.pole)));
  staff.position.set(.74,GROUND_Y+.71,-.82);
  const flag=add(meshOf(new THREE.BoxGeometry(.30,.44,.05),flat(PAL.banner)));
  flag.position.set(.60,GROUND_Y+1.16,-.82);

  // Weapon rack on the left flank: two uprights, a crossbar and three racked spears.
  for(const z of [-.06,.30]){
    const upright=add(meshOf(new THREE.BoxGeometry(.10,.72,.10),flat(PAL.timber)));
    upright.position.set(-.80,GROUND_Y+.36,z);
  }
  const crossbar=add(meshOf(new THREE.BoxGeometry(.12,.10,.50),flat(PAL.timberDark)));
  crossbar.position.set(-.80,GROUND_Y+.64,.12);
  for(const z of [-.02,.12,.26]){
    const shaft=add(meshOf(new THREE.CylinderGeometry(.035,.035,.94,5),flat(PAL.timber)));
    shaft.position.set(-.80,GROUND_Y+.47,z);shaft.rotation.x=.10;
    const head=add(meshOf(new THREE.ConeGeometry(.06,.18,4),flat(PAL.metal)));
    head.position.set(-.80,GROUND_Y+1.03,z-.05);
  }

  // One station position per authored guard slot. Flagstones are permanent (the slots exist
  // whether or not they are filled); the pennants above them are the arrival read.
  const postMarkers=[];
  for(let i=0;i<GARRISON.capacity;i++){
    const x=(i-(GARRISON.capacity-1)/2)*.62,side=x>=0?1:-1;
    const flagstone=add(meshOf(new THREE.BoxGeometry(.42,.08,.42),flat(i%2?PAL.rockDark:PAL.rock)));
    flagstone.position.set(x,GROUND_Y+.04,.50);
    const pole=add(meshOf(new THREE.CylinderGeometry(.04,.05,.72,5),flat(PAL.pole)));
    pole.position.set(x+side*.24,GROUND_Y+.36,.50);
    const pennant=add(meshOf(new THREE.BoxGeometry(.24,.22,.04),flat(PAL.banner)));
    pennant.position.set(x+side*.12,GROUND_Y+.60,.50);
    postMarkers.push(pennant);
  }
  g.userData.postMarkers=postMarkers;
}
