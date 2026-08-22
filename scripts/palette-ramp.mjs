// Owns: parametric ramp authoring in OKLab (L / chroma / hue per step) -> sRGB hex. Used to draft
// SWATCH tables by the hue-shift rule (lighter -> yellow & desaturated, darker -> blue & saturated)
// instead of eyeballing hexes. `node scripts/palette-ramp.mjs` prints the current draft.
const toSrgb = c => c <= .0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - .055;
export function oklabToHex(L, a, b){
  const l_ = L + .3963377774 * a + .2158037573 * b;
  const m_ = L - .1055613458 * a - .0638541728 * b;
  const s_ = L - .0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + .2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s;
  const bb = -.0041960863 * l - .7034186147 * m + 1.7076147010 * s;
  const clampOut = [r, g, bb].map(c => Math.min(1, Math.max(0, c)));
  const clipped = [r, g, bb].some(c => c < -.002 || c > 1.002);
  const hex = clampOut.reduce((acc, c) => (acc << 8) | Math.round(toSrgb(c) * 255), 0);
  return {hex, clipped};
}
/** step = [L, C, hueDeg] */
export function ramp(name, steps){
  return steps.map(([L, C, h], i) => {
    const rad = h * Math.PI / 180;
    const {hex, clipped} = oklabToHex(L, C * Math.cos(rad), C * Math.sin(rad));
    return {name: name + i, hex, L, C, h, clipped};
  });
}

// ── DRAFT v2 (Aug 21): measured off the owner's t3ssel8r-style references — grass hue 120→160
// top→bottom, C .09–.11, L .55–.77; stone neutral-cool with lavender shadow; warm cream tops.
export const DRAFT = [
  ...ramp("green", [[.84, .115, 116], [.72, .105, 124], [.63, .105, 132], [.54, .09, 146], [.45, .075, 162]]),
  ...ramp("stone", [[.85, .02, 60], [.71, .012, 150], [.60, .02, 250], [.48, .03, 285]]),   // stone1 cooled: at hue 80 its cloud-shade landed on wood0
  ...ramp("cream", [[.92, .05, 92], [.78, .045, 90]]),
  ...ramp("wood",  [[.62, .07, 62], [.50, .075, 48], [.38, .06, 40]]),
  ...ramp("shade", [[.40, .05, 290], [.30, .06, 285], [.20, .05, 280]]),
  // Warm reserve — the only high-chroma family. Fire ramp (t3ssel8r "Procedural Pixel Art Fire":
  // yellow core → orange → red → crimson) doubles as the enemy/damage ramp.
  ...ramp("red",   [[.84, .16, 92], [.70, .16, 55], [.57, .20, 28], [.42, .15, 12]]),
  // Arcane: portal/dust/fog accents. Violet mid, deep plum shadow.
  ...ramp("arcane",[[.72, .11, 310], [.55, .14, 305], [.38, .12, 300]]),
  // Water / sky / ice. Ice is also the diamond + freeze tint.
  ...ramp("blue",  [[.86, .07, 200], [.70, .10, 230], [.52, .12, 248]]),
  // Singles: skin, light metal/plaster, night-teal (deep foliage & water shadow).
  ...ramp("skin",  [[.78, .08, 60]]),
  ...ramp("metal", [[.84, .03, 225]]),
  ...ramp("teal",  [[.33, .045, 185]]),
  // Dark green-black for deep foliage/tree shadow (bridges green4 → shade), mid grey for leather/rubble.
  ...ramp("moss",  [[.30, .04, 160]]),
  ...ramp("grey",  [[.52, .02, 60]]),
];

if(process.argv[1] && process.argv[1].endsWith("palette-ramp.mjs")){
  for(const s of DRAFT)
    console.log(s.name.padEnd(8), "#" + s.hex.toString(16).padStart(6, "0"), "L", s.L.toFixed(2), "C", s.C.toFixed(3), "hue", String(s.h).padStart(3), s.clipped ? " CLIPPED" : "");
}
