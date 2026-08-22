// Owns: enemy (reviewed shard cast, variant-seamed) and corpse. Contract: userData.inner, anims, tintMats.
import * as THREE from "three";
import {ENEMY_TYPES} from "../../../game/data.js";
import {S, meshOf, isOutline} from "../kit.js";
import {adoptModel} from "../adopt.js";
import {shadeToFamily} from "../game-rig.js";
import {PAL, ENEMY_VARIANT_TINT} from "../../palette.js";
import {MODELS as ENEMY_MODELS, tintSeams} from "../reviewed/enemy-shard.js";

// Enemy type -> adopted shard model. Models bake archetype size (the brute's x1.35); scene.js applies
// only explicit ENEMY_TYPES.modelScale (the boss), never collision `size`. userData.tintMats collects
// the unique BODY materials (lit, zero-emissive Lambert) so hit-flash/burn tint the rock and never
// the seam floors, eyes or ability FX (those are unlit/emissive and are excluded by the filter).
//
// VARIANT TIER = SEAM HEAT (Aug 22, owner call). The tier used to be a luminance-preserving vertex
// tint over the whole BODY, which is why an earlier pass could turn veterans blue and elites red.
// The cast's body is dark rock on purpose now and red is reserved for what the creature DOES, so
// tier moves onto the seam register: tintSeams() repaints the crack floors and nothing else.
// data.js carries only the tier; palette.js ENEMY_VARIANT_TINT carries the swatch, because colour is
// render vocabulary and the game layer does not import the render layer.
//
// The sim draws its own shot beam (scene.js beam() off shotFlash/shotX), so the archer's modelled
// bolt is hidden at build; its charge flash and recoil remain.
export function makeEnemy(type){
  const enemy=ENEMY_TYPES[type],archetype=enemy?.archetype||"raider";
  const def = ENEMY_MODELS["enemy-"+archetype] || ENEMY_MODELS["enemy-raider"];
  const inner = def.build();
  adoptModel(inner);
  if(archetype==="archer"){ const bolt = inner.getObjectByName("bolt"); if(bolt) bolt.visible = false; }
  const tintMats = [], seenMats = new Set();
  inner.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    for(const m of Array.isArray(o.material) ? o.material : [o.material]){
      if(seenMats.has(m)) continue; seenMats.add(m);
      if(m.isMeshLambertMaterial && m.emissive && m.emissive.getHex()===0) tintMats.push(m);
    }
  });
  // Tier 1 has no entry: it is the two-step the cast is already authored in (red2 over red3).
  const variantSeam=ENEMY_VARIANT_TINT[enemy?.variantTier];
  if(variantSeam) tintSeams(inner, variantSeam);
  // shadeToFamily measures the albedo it finds, so it runs last. The seam retint above is emissive
  // MeshBasic and invisible to it either way. PAL.enemyShade is one step below the shade1 BODY on
  // the same bridge; TONES.stoneDk.shadow (shade1) would now equal the lit side and flatten the cast.
  shadeToFamily(inner, PAL.enemyShade);
  const g = new THREE.Group();
  g.add(inner);
  g.scale.setScalar(S);
  g.userData = {inner, anims:def.anims, tintMats};
  return g;
}
export function makeCorpse(coat){
  const g = new THREE.Group();
  const m = meshOf(new THREE.CapsuleGeometry(.24,.4,3,6),
    new THREE.MeshLambertMaterial({color:new THREE.Color(coat), flatShading:true,
      transparent:true, opacity:.62}));
  m.rotation.z = Math.PI/2; m.position.y = .24;
  g.add(m);
  return g;
}
