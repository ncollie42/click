// Owns: the diamond deposit (reviewed cast). Contract: userData.live=[group], spent, gem.
import * as THREE from "three";
import {S, bakeStatic, addPxOutline} from "../kit.js";
import {GAME_TARGET, relightForGame} from "../game-rig.js";
import {adoptModel} from "../adopt.js";
import {MODELS as NODE_MODELS, withGameTarget} from "../reviewed/resource-nodes.js";
import {nodeMesh} from "./node-mesh.js";

// Per-entity cast (makeLayer builds one group per node), so it keeps its parts: `crystals` is the
// spinner scene.js drives through userData.gem, and the live cluster and the spent crater swap
// visibility on `depleted`. Two fused meshes plus the crystal cluster, each with the house's
// sim-px ink shell — the module's own screen-space ink is off (see resource-nodes' inkable()).
export function makeDiamond(){
  const g = new THREE.Group();
  const inner = withGameTarget(GAME_TARGET, () => NODE_MODELS["diamond"].build());
  relightForGame(inner);
  const crystals = inner.getObjectByName("crystals");
  delete inner.userData.gemMats;              // the module's glint hook: no game caller, and it
                                              // would keep the crystals out of the fuse below
  bakeStatic(inner, {extraKeep:[crystals], requireShadow:false, shell:false});
  bakeStatic(crystals, {requireShadow:false, shell:false});
  adoptModel(inner);
  inner.scale.setScalar(S);
  const spent = nodeMesh("diamond-spent");
  addPxOutline(spent);
  spent.visible = false;
  g.add(inner, spent);
  // `live` is what syncDiamonds() shows/hides: the mound group and the crystal cluster ride
  // together, so one entry (the whole sim-px group) says it once.
  g.userData = {live:[inner], spent, gem:crystals};
  return g;
}
