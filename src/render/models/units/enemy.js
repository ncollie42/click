// Owns: enemy (reviewed shard cast, variant-tinted) and corpse. Contract: userData.inner, anims, tintMats.
import * as THREE from "three";
import {ENEMY_TYPES} from "../../../game/data.js";
import {S, meshOf, isOutline} from "../kit.js";
import {adoptModel} from "../adopt.js";
import {MODELS as ENEMY_MODELS} from "../reviewed/enemy-shard.js";

// Enemy type -> adopted shard model. Models bake archetype size (the brute's ×1.35); scene.js applies
// only explicit ENEMY_TYPES.modelScale (the boss), never collision `size`. userData.tintMats collects
// the unique BODY materials (lit, zero-emissive Lambert) so hit-flash/burn tint the rock and never
// the seam floors, eyes or ability FX (those are unlit/emissive and are excluded by the filter).
//
// Variant colour is baked into those meshes' authored vertex colours while preserving luminance.
// A material.color multiplier made the already near-black rock merely darker, so blue Veterans and
// red Elites were effectively indistinguishable. Luminance-normalized vertex tint keeps every
// calibrated facet value while changing its readable hue.
// The sim draws its own shot beam (scene.js beam() off shotFlash/shotX), so the archer's modelled
// bolt is hidden at build; its charge flash and recoil remain.
const colorLuminance=color=>.2126*color.r+.7152*color.g+.0722*color.b;
function tintEnemyGeometry(geometry,tint,amount=.72){
  const colors=geometry.getAttribute("color");
  if(!colors)return;
  const tintLuminance=colorLuminance(tint);
  if(tintLuminance<=0)return;
  const tr=tint.r/tintLuminance,tg=tint.g/tintLuminance,tb=tint.b/tintLuminance;
  for(let i=0;i<colors.count;i++){
    const r=colors.getX(i),g=colors.getY(i),b=colors.getZ(i),l=.2126*r+.7152*g+.0722*b;
    colors.setXYZ(i,
      THREE.MathUtils.lerp(r,l*tr,amount),
      THREE.MathUtils.lerp(g,l*tg,amount),
      THREE.MathUtils.lerp(b,l*tb,amount));
  }
  colors.needsUpdate=true;
}
export function makeEnemy(type){
  const enemy=ENEMY_TYPES[type],archetype=enemy?.archetype||"raider";
  const def = ENEMY_MODELS["enemy-"+archetype] || ENEMY_MODELS["enemy-raider"];
  const inner = def.build();
  adoptModel(inner);
  if(archetype==="archer"){ const bolt = inner.getObjectByName("bolt"); if(bolt) bolt.visible = false; }
  const tintMats = [], seenMats = new Set(), tintGeometries = new Set();
  const variantTint=enemy?.variantColor ? new THREE.Color(enemy.variantColor) : null;
  inner.traverse(o=>{
    if(!o.isMesh || isOutline(o)) return;
    for(const m of Array.isArray(o.material) ? o.material : [o.material]){
      if(seenMats.has(m)) continue; seenMats.add(m);
      if(m.isMeshLambertMaterial && m.emissive && m.emissive.getHex()===0) tintMats.push(m);
    }
    if(variantTint && o.material?.isMeshLambertMaterial && !tintGeometries.has(o.geometry)){
      tintGeometries.add(o.geometry);
      tintEnemyGeometry(o.geometry,variantTint);
    }
  });
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
