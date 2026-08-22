// Owns: the adoption path for the reviewed resource-node cast (models/reviewed/resource-nodes.js)
// on the game's rig — relit, fused to ONE mesh, scaled to world units — plus TREE_MODELS, kept so
// the gauntlet trees can be re-adopted in one edit (nodes/tree.js is the primitive tree today).
import {S, isOutline, bakeStatic} from "../kit.js";
import {GAME_TARGET, relightForGame} from "../game-rig.js";
import {MODELS as NODE_MODELS, withGameTarget} from "../reviewed/resource-nodes.js";

// ── the resource nodes ──────────────────────────────────────────────────────
// Trees, rock, diamond and chest are the reviewed sim-px cast in src/render/models/
// resource-nodes.js (SDF shells, painted vertex-colour ramps). The old stacked primitives are
// gone; what survives untouched is every CONTRACT scene.js drives them through —
// userData.live / stump / rubble / spent / gem / body / lid / latch / wearMats — so the scatter
// layers, the collapse tweens and the chest wobble did not have to learn anything new.
//
// Adoption, in the order it has to happen:
//   1 build inside withGameTarget() -> the module bakes DISPLAY TARGETS, on lit Lambert, no ink
//   2 relightForGame()              -> targets become albedo against the game rig's world normals
//   3 bakeStatic()                  -> the ~10 meshes fuse to one (the scatter layer wants ONE
//                                      geometry per variant; the per-entity casts want the draw
//                                      calls). Fusing before the relight would be wrong: it
//                                      copies colours, and the colours are not albedo yet.
//   4 scale by S                    -> sim px -> world units, on the MESH, because
//                                      makeScatterLayer() clones geometry through liveSrc.matrix
//                                      and never sees a wrapper group.
// Sizes are the module's, not restated here. Measured against the old models' footprints (world
// units, ink excluded): tree crown 2.7w x 3.4h -> 2.63/2.96 x 3.56/2.97 (variants a/b), rock
// 1.9 x 1.44 -> 1.88 x 1.25, diamond 1.6 -> 1.79 x 1.92, chest 1.3w x 1.11h -> 1.36 x 1.30.
// tree.variant 0..2. Slot 2 is the BLOSSOM, because PAL.leaf[2] has always been pink (0xd9a0bc):
// a third of this world's trees are already in flower and the cast has the tree for it. The
// module also exports "tree-green-c" — swap it in here if the owner wants three greens instead.
export const TREE_MODELS = ["tree-green-a", "tree-green-b", "tree-blossom"];
/** Build one node model on the game's path: relit, fused to a single mesh, scaled to world units. */
export function nodeMesh(name){
  const inner = withGameTarget(GAME_TARGET, () => NODE_MODELS[name].build());
  relightForGame(inner);
  bakeStatic(inner, {requireShadow:false, shell:false});
  inner.updateMatrixWorld(true);
  const meshes = [];
  inner.traverse(o=>{ if(o.isMesh && !isOutline(o)) meshes.push(o); });
  // bakeStatic leaves exactly one mesh for these casts (nothing is hung on userData but `parts`,
  // which it exempts). There is deliberately NO fallback: a module change that leaves a second
  // mesh un-fused (transparent/emissive/DoubleSide parts resist the fuse) throws AT BOOT, loudly,
  // instead of shipping a silently broken scatter model — the scatter layers are module-scope, so
  // this line runs before the first frame and the failure is unmissable.
  const mesh = meshes[0];
  if(meshes.length !== 1) throw new Error(`resource node ${name} fused to ${meshes.length} meshes`);
  mesh.geometry.applyMatrix4(mesh.matrixWorld);
  mesh.position.set(0,0,0); mesh.rotation.set(0,0,0);
  mesh.removeFromParent();
  mesh.scale.setScalar(S);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
