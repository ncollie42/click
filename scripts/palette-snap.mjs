// Owns: OKLab nearest-swatch lookup for the shared palette. Used by validate.mjs (PAL ⊆ swatches
// check) and by hand when remapping roles: `node scripts/palette-snap.mjs` prints every PAL role
// with its nearest swatch and flags distances > 0.12 (a visibly different colour).
import {PAL, SWATCH} from "../src/render/palette.js";
import {SUN_INTENSITY, HEMI_INTENSITY, SUN_NDOTL} from "../src/render/rig.js";

const lin = c => c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
export function oklab(h){
  const r = lin((h >> 16 & 255) / 255), g = lin((h >> 8 & 255) / 255), b = lin((h & 255) / 255);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .7936177850 * m - .0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + .4505937099 * s,
          .0259040371 * l + .7827717662 * m - .8086757660 * s];
}
const ENTRIES = Object.entries(SWATCH).map(([n, h]) => [n, h, oklab(h)]);
/** -> [swatchName, hex, oklabDistance] */
export function nearestSwatch(hex){
  const o = oklab(hex);
  let best = null, bd = Infinity;
  for(const [n, h, p] of ENTRIES){
    const d = Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]);
    if(d < bd){ bd = d; best = [n, h, d]; }
  }
  return best;
}
export const isSwatch = hex => ENTRIES.some(e => e[1] === hex);

// ── lit-colour prediction ─────────────────────────────────────────────────────────────────
// The game rig (scene.js lights, three physical-light Lambert): out = albedo/π × irradiance,
//   irradiance = sun.intensity × sunColor × rampBand + hemi.intensity × mix(bounce, skyLight, w)
// with w = 0.5·n.y + 0.5 (= 1 on up-facing faces). Numbers mirror scene.js / test-scene preset
// SUN/HEMI: intensity 3.21, hemi 0.60; flat lit ground sits in the toon band 0.866 (= sin 60°).
// Cloud shade, cast shadow and the pixel pipeline's own exposure are NOT modelled — this is the
// "which swatch does a plain lit/shaded face land on" question, not a frame reproduction.
const SUN_I = SUN_INTENSITY, HEMI_I = HEMI_INTENSITY;
const toLin = h => [lin((h >> 16 & 255) / 255), lin((h >> 8 & 255) / 255), lin((h & 255) / 255)];
const toSrgb = c => c <= .0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - .055;
const toHex = l => l.reduce((acc, c) => (acc << 8) | Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255), 0);
const sunLin = toLin(PAL.sunDay), skyLin = toLin(PAL.skyLight), gndLin = toLin(PAL.bounce);
/** Rendered linear colour of `albedoHex` at toon band `band`, hemi weight `w` (1 = up-facing). */
export function litColor(albedoHex, band = SUN_NDOTL, w = 1){
  const a = toLin(albedoHex);
  return a.map((c, i) => c / Math.PI * (SUN_I * sunLin[i] * band + HEMI_I * (gndLin[i] + (skyLin[i] - gndLin[i]) * w)));
}
export function predictLanding(albedoHex){
  const lit = nearestSwatch(toHex(litColor(albedoHex, SUN_NDOTL, 1)))[0];
  const side = nearestSwatch(toHex(litColor(albedoHex, .55, .5)))[0];    // toon low-mid band, vertical face
  const shade = nearestSwatch(toHex(litColor(albedoHex, 0, 1)))[0];      // hemi only (cast shadow / dark side)
  return {lit, side, shade};
}

if(process.argv[1] && process.argv[1].endsWith("palette-snap.mjs")){
  const byHex = new Map(Object.entries(SWATCH).map(([n, h]) => [h, n]));
  console.log("role         authored      lit→       side→      shade→   (! = lit face lands off its authored swatch)");
  for(const [k, v] of Object.entries(PAL)){
    if(k === "sunDay" || k === "sunNight" || k === "skyLight" || k === "bounce") continue;
    const vs = Array.isArray(v) ? v : [v];
    for(const h of vs){
      const name = byHex.get(h) ?? nearestSwatch(h)[0] + "?";
      const p = predictLanding(h);
      const flag = p.lit !== name ? "!" : " ";
      console.log(k.padEnd(12), name.padEnd(12), (p.lit).padEnd(10), (p.side).padEnd(10), p.shade.padEnd(10), flag);
    }
  }
}
