// Owns: the main base (reviewed keep + precursor pit on the shared pad). Contract: userData.floor, inner, anims.
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {BASE} from "../../../game/data.js";
import {S, gx, gz, bakeStatic, FLOOR_TOP, makeFootprintFloor} from "../kit.js";
import {adoptModel} from "../adopt.js";
import {MODELS as BASE_MODELS} from "../reviewed/the-hole.js";

// ── main base: keep and precursor pit ───────────────────────────────────────
// The reviewed model (the-hole.js) replaces the inline keep+pit that used to live here. The
// asymmetric model sits on the same authored anchor and 3x3 footprint: the grass pad below it is
// the reserved-cells contract (identical to every building's), the model rides a sim-px holder
// lifted to the pad top, and placement/targeting/storage continue to read BASE untouched.
export function makeMainBase(awake){
  const name = awake ? "main-base-awake" : "main-base";
  const inner = BASE_MODELS[name].build();
  // The hole's anims move only the funnel group, the orb subtree and a set of emissive/transparent
  // materials (which the bake filter refuses on its own). Everything else — keep, crenellations,
  // door, berm, chute, apron, curb — is rigid and fuses into one mesh before adoption.
  bakeStatic(inner, {extraKeep: [inner.getObjectByName("funnel"), inner.getObjectByName("orb")],
                     requireShadow: false, shell: false});
  adoptModel(inner);
  const g = new THREE.Group();
  const floor = makeFootprintFloor(BASE.footprint, PAL.grass);
  g.add(floor);
  const holder = new THREE.Group();
  holder.add(inner);
  holder.scale.setScalar(S);
  holder.position.y = FLOOR_TOP;
  g.add(holder);
  g.position.set(gx(BASE.x), 0, gz(BASE.y));
  g.userData = {floor, inner, anims: BASE_MODELS[name].anims};
  return g;
}
