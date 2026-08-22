// Owns: THE day-light rig numbers — one source for scene.js (the lights), game-rig.js (the model
// bake), material-light-mods.js setToneTargets (tone solves), scripts/palette-snap.mjs (lit-landing
// prediction) and tools/test-scene/preset.js. Before Aug 22 these lived in five places and a sun
// change would have desynced the tone solves silently.
//
// Derivation (test-scene round 5, Aug 20): flat-ground sun term S = 0.885 held fixed, so
// SUN_INTENSITY = S·π / sin(SUN_ELEVATION_DEG). Colours are PAL.sunDay / skyLight / bounce.
// Imports palette.js (a leaf) for the two light colours the tone rigs below carry; nothing else.
import {PAL} from "./palette.js";
export const SUN_ELEVATION_DEG = 60;
export const SUN_AZIMUTH_DEG = 0;            // 0 = +X (screen right); positive tips toward +Z
export const SUN_S = 0.885;                  // flat-ground direct term at noon
export const SUN_NDOTL = Math.sin(SUN_ELEVATION_DEG * Math.PI / 180);   // 0.866: flat ground
export const SUN_INTENSITY = SUN_S * Math.PI / SUN_NDOTL;              // 3.21
export const HEMI_INTENSITY = 0.6;
export const SUN_DISTANCE = 240;

// ── NIGHT (Aug 22) ─────────────────────────────────────────────────────────────────────────────
// The key light is the ONLY light the clock touches. The hemi pair stays exactly as it is, all
// night: game-rig.js's bakes, palette-snap.mjs's predictions and shadeToFamily()'s shade solve all
// mirror HEMI_INTENSITY as a constant, and dimming it would silently invalidate every one of them.
// What that buys, checked against the solve math: a fully SHADED face renders the same colour day
// and night (hemi only), while a sunlit face falls to ~its own day-shadow value — night reads as
// "the whole world is in shadow", which is what night physically is and what the reference does.
// The palette SWAP (palette.js TONES_NIGHT) is what re-tones the families on top of that.
//
// 0.11 = the endpoint scene.js always documented ("night floor ≈ 0.35" = the old rig's 1.1 − .75)
// and never reached: it drove the dim with state.clock.light, which tops out at NIGHT_OVERLAY_ALPHA
// = 0.28, so the shipped night sun was 0.75·SUN_INTENSITY = 2.41. scene.js now normalises the
// clock to a true 0..1 before applying this, so the floor is the intended 3.21 × 0.11 = 0.353.
export const NIGHT_SUN_SCALE = 0.11;
/** The rig setToneTargets() solves against — day, and its night twin. One source, so a light
 *  change here cannot desync the tone solves in scene.js (terrain/blades) and kit.js (toned()). */
export const TONE_RIG = {sunColor: PAL.sunDay, sunIntensity: SUN_INTENSITY, ndotl: SUN_NDOTL,
                         skyColor: PAL.skyLight, hemiIntensity: HEMI_INTENSITY};
export const TONE_RIG_NIGHT = {sunColor: PAL.sunNight, sunIntensity: SUN_INTENSITY * NIGHT_SUN_SCALE,
                               ndotl: SUN_NDOTL, skyColor: PAL.skyLight, hemiIntensity: HEMI_INTENSITY};
