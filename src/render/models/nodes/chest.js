// Owns: the chest (reviewed cast). Contract: userData.body, lid (hinge group), latch, wearMats.
import * as THREE from "three";
import {S, isOutline, bakeStatic, disposeGroup} from "../kit.js";
import {GAME_TARGET, relightForGame, shadeToFamily} from "../game-rig.js";
import {TONES} from "../../palette.js";
import {adoptModel} from "../adopt.js";
import {MODELS as NODE_MODELS, withGameTarget} from "../reviewed/resource-nodes.js";

// The chest is the one node the player picks up and smashes, never opens: the module's loot pile
// and its `open` pose are dropped at build (the sim has no open state to drive them from), and
// what survives is the named lid — still a real hinge group, so syncChests' shake wobble tips it
// exactly as it always did. Two fused meshes: body-and-hardware, and the lid assembly.
export function makeChest(){
  const g=new THREE.Group();
  const inner = withGameTarget(GAME_TARGET, () => NODE_MODELS["chest"].build());
  relightForGame(inner);
  const loot = inner.getObjectByName("loot");
  if(loot){ disposeGroup(loot); loot.removeFromParent(); }
  const lid = inner.getObjectByName("lid"), latch = inner.getObjectByName("latch");
  // The brass latch stays out of the fuse so userData.latch keeps meaning what it always meant —
  // one part, one draw. Everything else on the body (chamfered timber, feet, rails, straps,
  // liner) is rigid and becomes one mesh.
  const body = bakeStatic(inner, {extraKeep:[lid, latch], requireShadow:false, shell:false});
  bakeStatic(lid, {requireShadow:false, shell:false});
  // Timber family: in cloud shade the chest reads TONES.wood.shadow, not hemi grey-brown.
  shadeToFamily(inner, TONES.wood.shadow);
  adoptModel(inner);
  inner.scale.setScalar(S);
  g.add(inner);
  // wearMats is the hurt tint: every BODY material, which here is every material there is (this
  // cast has no emissive or unlit part to keep out of it).
  const wear=new Set();inner.traverse(o=>{if(o.isMesh&&!isOutline(o))wear.add(o.material);});
  g.userData={body:body??inner, lid, latch, wearMats:[...wear]};
  return g;
}
