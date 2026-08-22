// Owns: the capture yard building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the parts list and static bake after.
// userData contract: userData.slotMarkers (three bay caps).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, GROUND_Y} from "../kit.js";

export function build(g, add){
  // Villager-built holding pen: timber palisade on hand-set stone footings, split into three
  // visible bays by inner dividers. Palette rule: timber/plaster/stone/sage only — violet stays
  // enemy/precursor information. userData.slotMarkers are the three sage bay caps scene.js shows
  // one-per-living-ally, so occupancy reads off the model itself.
  const E=2.55;                                            // fence half-extent inside the 3x3 footprint
  const post=(x,z,h=1.05)=>{const p=add(meshOf(new THREE.BoxGeometry(.22,h,.22),flat(PAL.timberDark)));p.position.set(x,GROUND_Y+h/2,z);return p;};
  const rail=(x,z,w,d,y)=>{const r=add(meshOf(new THREE.BoxGeometry(w,.14,d),flat(PAL.timber)));r.position.set(x,GROUND_Y+y,z);return r;};
  for(const sx of [-1,1])for(const sz of [-1,1])post(sx*E,sz*E,1.2);
  post(-E,0);post(E,0);post(-.85,E);post(.85,E);           // side mid posts; the front pair frames the gate gap
  for(const y of [.42,.86]){
    rail(0,-E,2*E,.12,y);                                  // back run
    rail(-E,0,.12,2*E,y);rail(E,0,.12,2*E,y);              // side runs
    rail(-(E+.85)/2,E,E-.85,.12,y);rail((E+.85)/2,E,E-.85,.12,y);   // front runs either side of the gate
  }
  [[-E,-E],[E,-E],[-E,E],[E,E]].forEach(([x,z],i)=>{const footing=add(meshOf(new THREE.BoxGeometry(.6,.3,.6),flat(i%2?PAL.rockDark:PAL.rock)));footing.position.set(x,GROUND_Y+.15,z);});
  for(const x of [-.85,.85]){const divider=add(meshOf(new THREE.BoxGeometry(.14,.8,2),flat(PAL.timber)));divider.position.set(x,GROUND_Y+.4,-E+1);}
  const trough=add(meshOf(new THREE.BoxGeometry(1.1,.3,.5),flat(PAL.plaster)));trough.position.set(0,GROUND_Y+.15,.9);
  const slotMarkers=[];
  for(const x of [-1.7,0,1.7]){
    post(x,-E+.02,1.15);
    const cap=add(meshOf(new THREE.ConeGeometry(.22,.36,6),flat(PAL.sage)));cap.position.set(x,GROUND_Y+1.33,-E+.02);slotMarkers.push(cap);
  }
  g.userData.slotMarkers=slotMarkers;
}
