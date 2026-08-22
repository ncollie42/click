// Owns: the summoning circle building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: userData.inner, anims, slotMarkers, ashRings — nothing joins parts.
import * as THREE from "three";
import {S, FLOOR_TOP} from "../kit.js";
import {GAME_TARGET, relightForGame} from "../game-rig.js";
import {adoptInkedModel} from "../adopt.js";
import {MODELS as CIRCLE_MODELS, withGameTarget as withCircleGameTarget} from "../reviewed/summoning-circle.js";

export function build(g, add){
  // The reviewed sim-px working (src/render/models/reviewed/summoning-circle.js) replaces the emissive
  // disc + torus. It rides the 3x3 pad like the main base does — its own holder, scaled by S,
  // lifted to the pad top — and nothing here joins `parts`: the hurt flash and the ghost tint
  // must never reach the violet glyph, which is the dust gauge and means one thing only.
  // userData.inner is what protects the whole subtree from bakeStatic() at the bottom of this
  // function (its keep-set walks userData), which matters more here than anywhere else: the
  // fuse would weld the five dust slots and the six decay stages into one un-switchable mesh.
  const model = CIRCLE_MODELS["summoning-circle"];
  const circle = withCircleGameTarget(GAME_TARGET, () => model.build());
  relightForGame(circle);
  adoptInkedModel(circle);
  const holder = new THREE.Group();
  holder.add(circle);
  holder.scale.setScalar(S);
  holder.position.y = FLOOR_TOP;
  g.add(holder);
  g.userData.inner = circle;
  g.userData.anims = model.anims;
  g.userData.slotMarkers = circle.userData.slotMarkers;   // one per dust in the circle (0..4)
  g.userData.ashRings = circle.userData.ashRings;         // six decay stages, driven by lifetime
}
