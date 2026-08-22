// Owns: the dressed peg worker wrapper. Contract: userData.inner, anims.
import * as THREE from "three";
import {S, bakeStatic} from "../kit.js";
import {adoptModel} from "../adopt.js";
import {MODELS as PEG_MODELS, dressCarry} from "../reviewed/worker-peg.js";

// Job -> dressed peg. Key format "worker-<job>[+carry]": the +carry suffix dresses the SAME job
// model with the log bundle (dressCarry), so a loaded courier stays denim rather than turning tan.
// The wrapper owns world placement/scale; scene.js drives the anims on userData.inner.
export function makePegWorker(key){
  const [name, carry] = key.split("+");
  const def = PEG_MODELS[name] || PEG_MODELS["worker-gatherer"];
  const inner = def.build();
  inner.rotation.y = 0;                  // zero the sheet display yaw; facing is the wrapper's job
  if(carry){
    dressCarry(inner);
    // The log bundle is rigid — anims move the whole stack group — so its ~17 meshes fuse into
    // one before adoption (which then adds the single sim-px outline shell for it).
    const stack = inner.getObjectByName("stack");
    if(stack) bakeStatic(stack, {requireShadow: false, shell: false});
  }
  adoptModel(inner);
  const g = new THREE.Group();
  g.add(inner);
  g.scale.setScalar(S);
  g.userData = {inner, anims: def.anims};
  return g;
}
