// Owns: THE day-light rig numbers — one source for scene.js (the lights), game-rig.js (the model
// bake), material-light-mods.js setToneTargets (tone solves), scripts/palette-snap.mjs (lit-landing
// prediction) and tools/test-scene/preset.js. Before Aug 22 these lived in five places and a sun
// change would have desynced the tone solves silently.
//
// Derivation (test-scene round 5, Aug 20): flat-ground sun term S = 0.885 held fixed, so
// SUN_INTENSITY = S·π / sin(SUN_ELEVATION_DEG). Colours are PAL.sunDay / skyLight / bounce.
// Leaf module — imports nothing.
export const SUN_ELEVATION_DEG = 60;
export const SUN_AZIMUTH_DEG = 0;            // 0 = +X (screen right); positive tips toward +Z
export const SUN_S = 0.885;                  // flat-ground direct term at noon
export const SUN_NDOTL = Math.sin(SUN_ELEVATION_DEG * Math.PI / 180);   // 0.866: flat ground
export const SUN_INTENSITY = SUN_S * Math.PI / SUN_NDOTL;              // 3.21
export const HEMI_INTENSITY = 0.6;
export const SUN_DISTANCE = 240;
