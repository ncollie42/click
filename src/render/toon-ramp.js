// Owns: MATERIAL-STAGE banding. The one place in this repo that builds a toon ramp — a gradient
// map plus the MeshToonMaterial that samples it — so lighting arrives at the post pipeline already
// in broad flat bands instead of as a smooth Lambert gradient that the quantizer then staircases.
//
// WHY THIS EXISTS. Red Giraffe (vid6, the reference this repo's pixel look is matched against):
// "Toon shading... creates clear bands of color which transpose well when quantized" — bands in
// the LIGHTING first, quantizer after. Everything banded in this repo today is post
// (src/render/pipelines/pixel.js mode-0 OKLab posterize). A Lambert sphere crown sees up to
// 1/sin(elevation) times the flat-ground sun term (2.67x at the test scene's 22 deg sun), so its
// crown blows past anything the reference frame contains no matter how the posterizer is tuned.
// Capping the ramp's top level is the only thing that closes that; see
// tools/shots/redgiraffe-scene-r1/ROUND-LOG.md "Round 5 — toon ramp".
//
// OWNERSHIP / STATUS. Right now the ONLY consumer is the render-lab test scene
// (tools/test-scene/{scene,objects,terrain}.js via tools/test-scene/preset.js TOON). Adoption by
// the game (src/render/scene.js) is OWNER-GATED and deliberately not wired here. The API is
// written as the seam the game would adopt: hand it a THREE namespace and authored numbers, get
// back a texture and a material. It imports nothing, touches no global, and holds no state.
//
// HOW three r160 ACTUALLY USES THE MAP (verified in vendor/three.module.min.js, not assumed):
//   gradientmap_pars_fragment:  coord = vec2(dotNL * 0.5 + 0.5, 0.0); return texture2D(gradientMap, coord).r
//   lights_toon_pars_fragment:  irradiance = getGradientIrradiance(normal, light.direction) * directLight.color
// Three consequences that decide how the levels below are authored:
//  1. The ramp replaces the DIRECTIONAL term's clamp(dotNL,0,1) OUTRIGHT. A texel value is
//     therefore an "effective NdotL": 0.5 means this band is lit as if its normal sat at 30 deg to
//     the sun, whatever the real normal is.
//  2. Only the directional light is banded. HemisphereLight / ambient goes through
//     RE_IndirectDiffuse_Toon and adds SMOOTHLY on top, so the dark side of a band is not flat —
//     it still carries the ambient's own 0.5*n.y+0.5 gradient. That is wanted: it keeps the domes
//     from reading as paper cutouts.
//  3. directLight.color already carries the shadow attenuation (lights_fragment_begin multiplies
//     getShadow() into it before RE_Direct runs), so shadow maps — including pixel.js's cloud
//     shadow plane — still band the receiver through the ramp. receiveShadow works unchanged.
//
// COORDINATE MAPPING, the part that surprises people: coord = dotNL*0.5+0.5 spends the texture's
// whole LOWER HALF on dotNL < 0, i.e. on surfaces facing away from the sun, which all render the
// same (ambient only). A `steps`-wide map therefore buys only steps/2 usable LIT bands, and the
// band edges land at fixed dotNL = 2*i/steps - 1. Widen a band by REPEATING its level in the
// array; that is how band edges are placed off the natural grid.

/** Texel i of a `steps`-wide nearest-sampled map covers dotNL in [lo, hi). Exported so callers
 *  (and the round log) can state where a band edge actually lands without re-deriving it. */
export function bandDotNLRange(steps, i){
  return [2 * i / steps - 1, 2 * (i + 1) / steps - 1];
}

/**
 * Build the gradient map: a `steps` x 1 R8 DataTexture whose texels ARE the authored band levels.
 *
 * @param THREE   the three namespace (the module imports nothing itself)
 * @param steps   texture width. steps/2 of them are usable lit bands (see COORDINATE MAPPING).
 * @param levels  `steps` numbers in [0,1], index 0 = most-away-from-sun. Each is an effective
 *                NdotL for that band (see consequence 1 above). Indices in the lower half should
 *                normally be 0 — a surface facing away from the sun has no directional term.
 * @returns a DataTexture the caller owns and must dispose().
 *
 * FORMAT: RedFormat + UnsignedByteType. Verified against vendor/three.module.min.js getInternalFormat():
 * on WebGL2, gl.RED + UNSIGNED_BYTE resolves to the sized internal format R8. LuminanceFormat also
 * "works" (it stays an unsized gl.LUMINANCE and samples as (L,L,L,1)), but it is a WebGL1-era
 * unsized combination that WebGL2 only keeps for compatibility, and the shader reads .r either way.
 * RedFormat is the one that gets a real sized format, so it is the one used.
 *
 * FILTERING: NearestFilter on BOTH mag and min, and generateMipmaps false. Any linear filtering
 * turns the ramp back into a gradient and the whole point is lost. (DataTexture already defaults
 * to exactly this; it is set explicitly because it is load-bearing, not incidental.)
 */
export function makeGradientMap(THREE, {steps, levels}){
  if(!Number.isInteger(steps) || steps < 2) throw new Error(`toon-ramp: steps must be an integer >= 2, got ${steps}`);
  if(!Array.isArray(levels) || levels.length !== steps)
    throw new Error(`toon-ramp: levels must have exactly ${steps} entries, got ${levels?.length}`);

  const data = new Uint8Array(steps);
  for(let i = 0; i < steps; i++){
    const v = levels[i];
    if(!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`toon-ramp: levels[${i}] must be in [0,1], got ${v}`);
    // 8 bits is the resolution of the authored value. At the test scene's exposure one byte step
    // is ~0.3 luma on the brightest band, well under the measurement floor.
    data[i] = Math.round(v * 255);
  }

  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = "toon-ramp";
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;      // one byte per row; the default 4 would mis-stride odd widths
  // No colour space: this is DATA, not colour. NoColorSpace is the Texture default and must stay —
  // an sRGB tag here would silently decode the authored levels.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The banded counterpart of `new THREE.MeshLambertMaterial({color, vertexColors})`.
 * Deliberately minimal: same three inputs the Lambert call sites already pass, plus the map.
 * Shadow behaviour is inherited (castShadow/receiveShadow live on the Mesh, not here) and works —
 * see consequence 3 in the header.
 *
 * @param color        base colour, sRGB hex or THREE.Color. Multiplied by the vertex colour.
 * @param vertexColors pass the geometry's `color` attribute through, same semantics as Lambert.
 * @param gradientMap  from makeGradientMap(). Required — without it three falls back to its own
 *                     built-in two-tone smoothstep, which is not an authored value structure.
 * @returns a MeshToonMaterial the caller owns and must dispose().
 */
export function makeToonMaterial(THREE, {color = 0xffffff, vertexColors = false, gradientMap}){
  if(!gradientMap) throw new Error("toon-ramp: makeToonMaterial needs a gradientMap");
  return new THREE.MeshToonMaterial({color, vertexColors, gradientMap});
}
