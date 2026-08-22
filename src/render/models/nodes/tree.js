// Owns: the tree model. Contract (scene.js scatter layer): userData.live = fused trunk+crown
// mesh, userData.stump = hidden remnant. Variant 0..2 via t.variant (PAL.leaf, slot 2 = blossom).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, bakeStatic} from "../kit.js";

// Aug 21 (owner): trees REVERTED to the pre-gauntlet stacked primitives (from 923898b^,
// verbatim shapes) — under the pixel pipeline the quantizer wants big smooth/simple forms, and
// the SDF trees' painted per-facet ramps fight it at ~28 texels across. Rock/diamond/chest stay
// on the gauntlet cast below; TREE_MODELS/"tree-stump" remain exported by the module, so swapping
// the gauntlet trees back is this one function. Flat PAL albedos ride the live rig (no relight).
// TREE_SCALE multiplies every dimension INTO the built geometry (not a group scale — the scatter
// layer clones through the live mesh's own matrix and would drop a group transform). Reload to
// see a change; 1 = the historical size (crown ~2.7 wu wide, ~3.4 wu tall).
const TREE_SCALE = 1;
export function makeTree(t){
  const K = TREE_SCALE;
  const g = new THREE.Group();
  const leaf = PAL.leaf[t.variant] ?? PAL.leaf[0];
  const trunk = meshOf(new THREE.CylinderGeometry(.16*K,.24*K,2.2*K,6), flat(PAL.trunk));
  trunk.position.y = 1.1*K;
  // Crown is SMOOTH (geometry and shading), unlike the 2018-style faceted original: under the
  // pixel pipeline a flat-shaded icosahedron hands the quantizer one NdotL per facet — 20 flat
  // plates, no gradient to carve bands from — and its ~40° facet steps ink every seam in the
  // normal-edge pass. Smooth normals put the banding back in the quantizer, which is exactly
  // what makes the scale ball read (test-scene round-3 finding). Trunk/stump stay flat-shaded:
  // thin cylinders read as chunky wood either way.
  const crown = meshOf(new THREE.SphereGeometry(1.35*K, 32, 20), flat(leaf, {flatShading:false}));
  crown.position.y = 3.0*K; crown.scale.set(1,.85,1);
  const stump = meshOf(new THREE.CylinderGeometry(.26*K,.3*K,.42*K,6), flat(PAL.stump));
  stump.position.y = .21*K; stump.visible = false;
  g.add(trunk, crown, stump);
  g.userData = {stump};
  g.userData.live = bakeStatic(g) ?? trunk;   // trunk+crown fuse into one live mesh
  return g;
}
