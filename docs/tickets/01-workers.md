# 01 — Workers (the peg villagers)

**Skill:** `pixel-model`. **Replaces:** `src/render/models/units/worker.js` → `makePegWorker(key)`,
which adopts `models/reviewed/worker-peg.js`. Keep the function name and export; rewrite the body.

## What it is
One shared villager body with job dressings. Keys scene.js asks for (scene.js ~line 1168):
`worker-gatherer`, `worker-courier`, `worker-builder`, `worker-guard`, each optionally suffixed
`+carry` (carrying a log bundle). Same body, coat colour + one accessory per job (palette.js:
`coat`, `jobHaul`, `jobBuild`, `jobGuard`). Reference look: `docs/reference/workers.png`;
motion vocabulary: `docs/model-spec.md` "Workers".

## Size
~1.4 cells tall (≈2.8 wu). At play zoom that is ~20 texels: silhouette + coat band + head + one
accessory shape. No face detail beyond two dark eye dots — white is the eye channel only.

## Contract to keep (scene.js drives these)
- `g.userData = {inner, anims}` where `inner` is the posed group and `anims` has
  `idle(inner, phase01, t)`, `walk(inner, phase01, t)`, `chop(inner, phase01, t)`,
  `carryLag(inner, phase01, t)`. Pure functions: snapshot rest, restore, pose.
- Wrapper group owns facing (scene.js sets `g.rotation.y`) and world placement. Build at world
  scale — no `S` wrapper.
- Hit/hurt feedback is scene-side; no emissive parts needed.

## Doctrine notes for this cast
- Body = smooth curve (capsule/sphere with real segments, `flatShading:false`). Hood/hat and
  accessories = few flat planes. That is the whole model.
- The old cast's lesson, still true: one continuous body shell, never ball-on-gourd ("snowman").
- Accessory reads by silhouette at 20 texels: axe flat FACING the camera, basket as one block.

## Exit
README "done" list + an audition shot with all four jobs (+carry variants) in a row beside the
1×1 scale ball, rest pose, and one mid-`chop` frame that reads as a swing.
