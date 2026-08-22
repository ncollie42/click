// Owns: the model layer's public surface — one barrel over src/render/models/. Nothing is
// defined here; consumers (scene.js, the view debugger, the map editor) import from this file
// and never reach into the folders, so the folder layout can move without touching them.
//
// Layout (one model per file; Aug 21 split of the former 1,200-line models.js):
//   models/kit.js        shared kit: unit scale S, flat(), meshOf() + outline shells, bakeStatic(),
//                        disposeGroup(), footprint pads, gable prism
//   models/game-rig.js   the light-rig mirror + relightForGame() (interlocked with scene.js lights)
//   models/adopt.js      adoption of the reviewed sim-px modules (shadows + sim-px ink)
//   models/reviewed/     the gauntlet-reviewed standalone modules (viewer-loadable, import only three)
//   models/nodes/        tree, rock, diamond, chest, drops (+ node-mesh.js, the reviewed-cast path)
//   models/units/        worker, enemy (+corpse), king, damage dummy
//   models/buildings/    one file per building type + index.js (registry + shared frame),
//                        main-base.js, blueprint.js
//   models/props/        showcase-only props
// Dependency direction is one-way: kit <- game-rig <- adopt <- category files <- this barrel.
// Building a NEW model: read docs/pixel-models.md (the pixel-model skill enforces it), add a
// file in the right folder, export it here (buildings also register in buildings/index.js).

export {
  S, WU, HU, gx, gz, flat, meshOf, isOutline, setOutlines, outlineMat, outlineMatPx,
  adoptOutlineShell, releaseOutlineShell, bakeStatic, disposeGroup,
  FLOOR_H, FLOOR_LIFT, FLOOR_TOP, makeFootprintFloor,
} from "./models/kit.js";
export {GAME_EXPOSURE, GAME_TARGET, relightForGame} from "./models/game-rig.js";
export {makeGrassTuftGeometry} from "./models/nodes/grass-tuft.js";
export {TREE_MODELS} from "./models/nodes/node-mesh.js";
export {makeTree} from "./models/nodes/tree.js";
export {makeRock} from "./models/nodes/rock.js";
export {makeDiamond} from "./models/nodes/diamond.js";
export {makeChest} from "./models/nodes/chest.js";
export {makeDrop, handMeshFor} from "./models/nodes/drop.js";
export {makePegWorker} from "./models/units/worker.js";
export {makeEnemy, makeCorpse} from "./models/units/enemy.js";
export {makeKing} from "./models/units/king.js";
export {makeDamageDummy} from "./models/units/damage-dummy.js";
export {makeShowcaseProp} from "./models/props/showcase-prop.js";
export {makeMainBase} from "./models/buildings/main-base.js";
export {makeBlueprint} from "./models/buildings/blueprint.js";
export {makeBuilding, BUILDING_BUILDERS} from "./models/buildings/index.js";
