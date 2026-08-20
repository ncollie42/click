// Owns: every line of GLSL the FULL texel-splatting pipeline runs. Pure string library — no imports,
// no three, no DOM — so the whole shader surface can be read end to end in one file while the JS
// modules stay about orchestration.
//
// PORTED FROM (all under /home/mando/dev/gamedev/pixel/source/):
//   shadow.glsl      -> SHADOW_VERT / SHADOW_FRAG
//   gbuffer.glsl     -> GBUFFER_VERT / GBUFFER_FRAG
//   edge_mask.glsl   -> EDGE_MASK_FRAG
//   lighting.glsl    -> LIGHTING_FRAG          (+ CHUNK_OKLAB, CHUNK_SKY, CHUNK_OCT)
//   splat.glsl       -> SPLAT_VERT / SPLAT_FRAG (+ CHUNK_BAYER)
//   background.glsl  -> BACKGROUND_VERT / BACKGROUND_FRAG
//   post.glsl        -> POST_FRAG              (+ the debug_vis.glsl modes)
//
// ── ADAPTATIONS, AND WHY EACH ONE IS AN ENCODING CHANGE AND NOT A FIDELITY CUT ──────────────
//
// 1. TEXTURE ARRAY -> ONE 6x3 ATLAS. The reference keeps 18 logical cubemap layers (3 probes x 6
//    faces) in a texture2DArray and renders MRT into one slice at a time. WebGL2 through three r160
//    cannot attach an array layer as an MRT colour attachment, so the 18 layers live side by side in
//    one 2D texture: LAYER l occupies cell (l % 6, l / 6) — column = FACE, row = PROBE (0 eye,
//    1 grid, 2 prev). Every `texelFetch(tex, ivec3(px,py,layer))` in the reference becomes
//    `texelFetch(tex, layerOrigin(layer,size) + ivec2(px,py))` here. Neighbour taps (edge mask,
//    outline detection) are clamped to the owning cell so layers never bleed into each other — the
//    array texture got that for free, the atlas has to be told.
//
// 2. R32F RADIAL -> RGBA8 PACKED. The reference stores Chebyshev radial distance in an R32F
//    attachment. three r160 builds every MRT attachment from one cloned texture descriptor, so a
//    float attachment would force all three to float. Radial is packed into 4 bytes with three's own
//    packDepthToRGBA math instead (~2e-10 round-trip error over [0,1], verified numerically).
//    The stored value is INVERTED — packUnit(1 - radial) — so that the all-zero clear reads back as
//    radial 1.0, which is exactly the reference's "sky, nothing hit" sentinel that every downstream
//    pass tests with `>= 0.999`. Get that inversion backwards and the whole screen becomes geometry
//    sitting on the near plane.
//
// 3. RADIAL IS COMPUTED FROM VIEW SPACE, NOT FROM A PROBE-ORIGIN UNIFORM. gbuffer.glsl subtracts a
//    probe_origin uniform in the fragment shader. Every cube face basis here is a SIGNED PERMUTATION
//    of world axes (verified numerically: the rotation block of each face camera's matrixWorldInverse
//    has exactly one +/-1 per row), so max(|viewX|,|viewY|,|viewZ|) is bit-for-bit the world-space
//    Chebyshev distance from the probe origin. Dropping the uniform means the scene-facing G-buffer
//    materials carry no per-face state at all, which is what makes ONE material swap serve all 18
//    face renders.
//
// 4. BACKGROUND RAY FROM inverse(viewProj) INSTEAD OF right/up/forward + tan(fov/2). Proven
//    numerically identical for a perspective camera at ANY orientation (max error 2.8e-14 over five
//    poses including roll and near-vertical pitch), and unlike the reference's form it also produces
//    something sane for the game's orthographic camera toggle. Rotation-correct by construction: the
//    matrix is rebuilt from the live camera every frame, so there is no yaw/pitch assumption anywhere.
//
// 5. ENTITY IDS ARE PER MATERIAL, plus a radial-discontinuity test. three has no per-mesh uniform
//    slot, so the reference's per-entity id becomes a per-material id (see full/capture.js). Alone
//    that would lose the silhouette between two props sharing a material, so detectEdge() also treats
//    a relative radial jump as a boundary. This is a superset of the reference's test.
//
// ── TWO SHADER DIALECTS, and mixing them up is the fastest way to bench this pipeline ────────
//   * SCENE shaders (SHADOW_*, GBUFFER_*) are three ShaderMaterials with glslVersion GLSL3. three
//     prepends `#version 300 es`, a precision qualifier, `#define attribute in` / `#define varying
//     out`, the standard uniforms (modelMatrix / modelViewMatrix / projectionMatrix / normalMatrix /
//     viewMatrix / cameraPosition), the standard attributes (position / normal / uv) and the
//     conditional `#ifdef USE_INSTANCING attribute mat4 instanceMatrix`,
//     `#ifdef USE_INSTANCING_COLOR attribute vec3 instanceColor`, `#ifdef USE_COLOR attribute vec3
//     color` blocks. So they must NOT redeclare any of those and must NOT declare precision. They DO
//     declare their own `layout(location=N) out` targets: under GLSL3 three SKIPS its pc_fragColor
//     declaration, leaving location 0 free.
//   * PASS shaders (edge mask, lighting, background, splat, post) are RawShaderMaterials with
//     glslVersion GLSL3. three prepends `#version 300 es` and the custom defines and NOTHING else —
//     every attribute, uniform, varying and precision qualifier below is declared by hand.

// ── shared chunks ───────────────────────────────────────────────────────────

/** three's packDepthToRGBA math, verbatim. Survives the unorm8 round trip for a [0,1] float with
 * ~2e-10 error (verified in node over 100k samples). One quirk, harmless here: v = 1.0 exactly
 * saturates and reads back as 255/256, because the top channel is scaled by 256/255 before
 * quantisation. The only value stored through this is 1 - radial, so the saturating end is geometry
 * sitting on the probe near plane and the SENTINEL end (all-zero clear -> 0 -> radial 1.0) round
 * trips exactly. */
export const CHUNK_PACK = `
const float PackUpscale = 256.0 / 255.0;
const float UnpackDownscale = 255.0 / 256.0;
const vec3 PackFactors = vec3(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0);
const vec4 UnpackFactors = UnpackDownscale / vec4(PackFactors, 1.0);
const float ShiftRight8 = 1.0 / 256.0;
vec4 packUnit(const in float v){
  vec4 r = vec4(fract(v * PackFactors), v);
  r.yzw -= r.xyz * ShiftRight8;
  return r * PackUpscale;
}
float unpackUnit(const in vec4 v){ return dot(v, UnpackFactors); }
`;

/** Octahedral normal encode/decode — gbuffer.glsl oct_encode() / lighting.glsl oct_decode(). */
export const CHUNK_OCT = `
vec2 octEncode(vec3 n){
  vec2 p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z) + 1e-8);
  if(n.z < 0.0){
    p = (1.0 - abs(p.yx)) * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
  }
  return p * 0.5 + 0.5;
}
vec3 octDecode(vec2 e){
  vec2 f = e * 2.0 - 1.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  if(n.z < 0.0){
    n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  }
  return normalize(n);
}
`;

// Cubemap face <-> direction (probe.odin FACE_TARGETS/FACE_UPS, splat.glsl texel_dir(),
// lighting.glsl face_uv_to_dir(), background.glsl dir_to_face_uv()), plus the 6x3 atlas addressing
// that stands in for the reference's texture2DArray.
//
// Face order is the reference's: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z. faceDir() must stay in exact
// lockstep with FACE_TARGETS/FACE_UPS in full/probe.js — those look-at bases are what MAKE this
// mapping true, and t1 in the verification set proves the two agree to 2e-15 in NDC.
export const CHUNK_FACE = `
vec3 faceDir(int face, float u, float v){
  if(face == 0) return vec3( 1.0,   -v,   -u);
  if(face == 1) return vec3(-1.0,   -v,    u);
  if(face == 2) return vec3(   u,  1.0,    v);
  if(face == 3) return vec3(   u, -1.0,   -v);
  if(face == 4) return vec3(   u,   -v,  1.0);
  return vec3(-u, -v, -1.0);
}
vec3 dirToFaceUV(vec3 d){
  vec3 a = abs(d);
  float f, u, v;
  if(a.x >= a.y && a.x >= a.z){
    if(d.x > 0.0){ f = 0.0; u = -d.z / a.x; v = -d.y / a.x; }
    else         { f = 1.0; u =  d.z / a.x; v = -d.y / a.x; }
  } else if(a.y >= a.x && a.y >= a.z){
    if(d.y > 0.0){ f = 2.0; u = d.x / a.y; v =  d.z / a.y; }
    else         { f = 3.0; u = d.x / a.y; v = -d.z / a.y; }
  } else {
    if(d.z > 0.0){ f = 4.0; u =  d.x / a.z; v = -d.y / a.z; }
    else         { f = 5.0; u = -d.x / a.z; v = -d.y / a.z; }
  }
  return vec3(f, u * 0.5 + 0.5, v * 0.5 + 0.5);
}
// Layer l = probe * 6 + face lives at atlas cell (face, probe) — column = face, row = probe.
ivec2 layerOrigin(int layer, int size){ return ivec2((layer - (layer / 6) * 6) * size, (layer / 6) * size); }
`;

/** OKLab + posterize — lighting.glsl toOKLab/fromOKLab/posterize. Input/output linear RGB.
 * BANDS is a uniform here where the reference had a const; the chroma shift constant (0.05) and the
 * round-to-nearest band rule are verbatim. */
export const CHUNK_OKLAB = `
vec3 toOKLab(vec3 c){
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2220049174 * c.g + 0.6896926207 * c.b;
  float l_ = pow(max(l, 0.0), 1.0 / 3.0);
  float m_ = pow(max(m, 0.0), 1.0 / 3.0);
  float s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
vec3 fromOKLab(vec3 lab){
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 posterize(vec3 color, float bands){
  vec3 lab = toOKLab(color);
  float L = clamp(lab.x, 0.0, 1.0);
  lab.x = floor(L * bands + 0.5) / bands;
  lab.z += (lab.x - 0.5) * 0.05;
  return max(fromOKLab(lab), vec3(0.0));
}
`;

/** Procedural sky gradient + horizon haze — lighting.glsl sky branch. Zenith/horizon/haze colours
 * are uniforms here (the game tints its sky through the day) where the reference had consts. */
export const CHUNK_SKY = `
vec3 skyGradient(vec3 dir, vec3 zenith, vec3 horizon, vec3 hazeColor, float hazeDensity){
  float t = pow(clamp(dir.y, 0.0, 1.0), 0.25);
  vec3 c = mix(horizon, zenith, t);
  float below = 1.0 - clamp(dir.y, 0.0, 1.0);
  c = mix(c, hazeColor, pow(below, 2.0) * min(hazeDensity * 5.0, 1.0));
  return c;
}
`;

/** Bayer 4x4 ordered dither — splat.glsl bayer4(). Computed arithmetically instead of indexing a
 * local const array: dynamic indexing of a local array is legal in ES 3.0 but has burned drivers
 * before, and the bit twiddle is EXACT. Verified cell by cell against the reference matrix
 * (0 8 2 10 / 12 4 14 6 / 3 11 1 9 / 15 7 13 5) and confirmed to wrap. */
export const CHUNK_BAYER = `
float bayer4(ivec2 p){
  int x = p.x & 3;
  int y = p.y & 3;
  int t = x ^ y;
  int v = ((t & 1) << 3) | ((y & 1) << 2) | (((t >> 1) & 1) << 1) | ((y >> 1) & 1);
  return float(v) / 16.0;
}
`;

// ── pass 1: sun shadow map (shadow.glsl) ────────────────────────────────────
// ShaderMaterial (GLSL3) used as scene.overrideMaterial. Writes packed gl_FragCoord.z, exactly like
// the reference's encode_depth(), except with three's 32-bit packing (same idea, different constant
// set — the reference's variant loses the same low bits). three's own shadow system is switched off
// for the whole frame (shadowMap.autoUpdate = false) so it cannot re-render the scene behind us.

export const SHADOW_VERT = `
void main(){
  vec4 obj = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    obj = instanceMatrix * obj;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * obj;
}
`;

export const SHADOW_FRAG = `
${CHUNK_PACK}
layout(location = 0) out vec4 outDepth;
void main(){
  outDepth = packUnit(gl_FragCoord.z);
}
`;

// ── pass 2: G-buffer capture (gbuffer.glsl) ─────────────────────────────────
// One ShaderMaterial variant per (source material x instanced?) — see full/capture.js. MRT layout is
// the reference's: 0 = albedo.rgb + entity id in .a, 1 = octahedral normal in .rg, 2 = radial.
// Defines set by capture.js: GB_FLAT, GB_MAP, GB_FLIP, GB_DOUBLE. USE_INSTANCING /
// USE_INSTANCING_COLOR / USE_COLOR / USE_COLOR_ALPHA come from three.

export const GBUFFER_VERT = `
uniform vec3 uColor;
out vec3 vAlbedo;
out vec3 vWorldNormal;
out vec3 vWorldPos;
out vec3 vViewPos;
out vec2 vUv;
void main(){
  vec4 obj = vec4(position, 1.0);
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    obj = instanceMatrix * obj;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 world = modelMatrix * obj;
  vec4 view = modelViewMatrix * obj;
  vWorldPos = world.xyz;
  vViewPos = view.xyz;
  // Ignores the inverse-transpose for non-uniform scale, the same shortcut gbuffer.glsl takes.
  // Flat-shaded materials re-derive the normal from screen-space derivatives below anyway.
  vWorldNormal = mat3(modelMatrix) * nrm;
  vec3 albedo = uColor;
  #ifdef USE_INSTANCING_COLOR
    albedo *= instanceColor;
  #endif
  // three declares the colour attribute as vec4 when the geometry supplies 4 components, so the
  // alpha branch has to come FIRST or this is a vec3 *= vec4 compile error.
  #if defined(USE_COLOR_ALPHA)
    albedo *= color.rgb;
  #elif defined(USE_COLOR)
    albedo *= color;
  #endif
  vAlbedo = albedo;
  vUv = uv;
  gl_Position = projectionMatrix * view;
}
`;

export const GBUFFER_FRAG = `
${CHUNK_PACK}
${CHUNK_OCT}
uniform vec2 uNearFar;
uniform float uEntityId;
#ifdef GB_MAP
uniform sampler2D uMap;
uniform vec4 uMapTransform;   // xy = repeat, zw = offset
#endif
in vec3 vAlbedo;
in vec3 vWorldNormal;
in vec3 vWorldPos;
in vec3 vViewPos;
in vec2 vUv;
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outRadial;
void main(){
  vec3 albedo = vAlbedo;
  #ifdef GB_MAP
    albedo *= texture(uMap, vUv * uMapTransform.xy + uMapTransform.zw).rgb;
  #endif
  outAlbedo = vec4(albedo, uEntityId);

  vec3 n = normalize(vWorldNormal);
  #ifdef GB_FLAT
    // three's flatShading equivalent. The cross product's sign follows the winding, so the smooth
    // vertex normal is used purely as an orientation reference.
    vec3 flatN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    n = dot(flatN, n) < 0.0 ? -flatN : flatN;
  #endif
  // Same two-sided handling three does via FLIP_SIDED / DOUBLE_SIDED, so BackSide and DoubleSide
  // source materials do not come out lit from behind.
  #ifdef GB_FLIP
    n = -n;
  #endif
  #ifdef GB_DOUBLE
    if(!gl_FrontFacing) n = -n;
  #endif
  outNormal = vec4(octEncode(n), 0.0, 1.0);

  // Chebyshev (L-infinity) distance from the probe origin. See adaptation note 3 in the file header:
  // the face basis is a signed permutation, so view-space and world-space Chebyshev are identical.
  float chebyshev = max(max(abs(vViewPos.x), abs(vViewPos.y)), abs(vViewPos.z));
  float radial = clamp((chebyshev - uNearFar.x) / (uNearFar.y - uNearFar.x), 0.0, 1.0);
  outRadial = packUnit(1.0 - radial);
}
`;

// ── shared fullscreen-triangle vertex shader (RawShaderMaterial, GLSL3) ─────
// `position` carries clip-space xy directly — see FULLSCREEN_POSITIONS in full/passes.js.

export const FULLSCREEN_VERT = `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ── pass 3: edge mask (edge_mask.glsl) ──────────────────────────────────────
// Per-side 4-neighbour radial continuity. The reference runs one fullscreen pass PER LAYER; this
// runs ONE pass over the whole 6x3 atlas, which is the identical set of fragment invocations with
// the layer derived from the atlas cell instead of a uniform. Neighbour taps clamp to the owning
// cell, reproducing the array texture's per-layer edge behaviour (the reference's `px.x > 0` /
// `px.x < PROBE_RES - 1` guards).
// Output: R = left, G = right, B = bottom, A = top. 1 = continuous (tight quad), 0 = expanded.

export const EDGE_MASK_FRAG = `
precision highp float;
precision highp int;
precision highp sampler2D;
${CHUNK_PACK}
uniform sampler2D uRadial;
uniform int uProbeSize;
uniform float uThreshold;
in vec2 vUv;
layout(location = 0) out vec4 outMask;

float radialAt(ivec2 p){ return 1.0 - unpackUnit(texelFetch(uRadial, p, 0)); }

// The reference leaves an out-of-range side CONTINUOUS (mask starts at 1.0 and the guard skips the
// tap), so an out-of-range side returns 1.0 here.
float side(bool inside, ivec2 p, float r){
  if(!inside) return 1.0;
  float n = radialAt(p);
  if(n >= 0.999) return 0.0;
  if(abs(r - n) / max(max(r, n), 1e-5) >= uThreshold) return 0.0;
  return 1.0;
}
void main(){
  ivec2 ap = ivec2(gl_FragCoord.xy);
  ivec2 base = (ap / uProbeSize) * uProbeSize;
  ivec2 lp = ap - base;
  float r = radialAt(ap);
  if(r >= 0.999){ outMask = vec4(0.0); return; }   // sky: all sides expanded, per the reference
  outMask = vec4(
    side(lp.x > 0,              ap + ivec2(-1, 0), r),
    side(lp.x < uProbeSize - 1, ap + ivec2( 1, 0), r),
    side(lp.y > 0,              ap + ivec2(0, -1), r),
    side(lp.y < uProbeSize - 1, ap + ivec2(0,  1), r));
}
`;

// ── pass 4: lighting (lighting.glsl) ────────────────────────────────────────
// World-position reconstruction from (face, texel, radial, probe origin), diffuse + 3x3 PCF shadow,
// entity/normal outlines with an OKLab lightness step, 32-band OKLab posterisation, procedural sky
// for the texels that hit nothing. Again one draw over the whole atlas rather than 18 draws: the
// probe row picks the origin, the face column picks the direction.
//
// The reference skips outlines on the eye probe (layer < 6) because at camera range they read wrong;
// that gate is uOutlineEye here, defaulting off to match.

export const LIGHTING_FRAG = `
precision highp float;
precision highp int;
precision highp sampler2D;
${CHUNK_PACK}
${CHUNK_OCT}
${CHUNK_FACE}
${CHUNK_OKLAB}
${CHUNK_SKY}
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uRadial;
uniform sampler2D uShadow;
uniform mat4 uLightMatrix;      // world -> shadow uv + depth, three's LightShadow.matrix
uniform vec3 uSunDir;           // unit vector pointing AT the sun
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uOriginEye;
uniform vec3 uOriginGrid;
uniform vec3 uOriginPrev;
uniform vec2 uNearFar;
uniform vec2 uShadowBias;       // x = constant, y = slope-scaled; both in normalised [0,1] depth
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uShadowTexel;
uniform float uBands;
uniform float uNormalThresh;
uniform float uDepthEdge;
uniform float uOutlineDarken;
uniform float uOutlineHighlight;
uniform float uOutlines;        // 0/1
uniform float uOutlineEye;      // 0/1 — reference behaviour is 0 (eye probe gets no outlines)
uniform int uProbeSize;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

float radialAt(ivec2 p){ return 1.0 - unpackUnit(texelFetch(uRadial, p, 0)); }

// lighting.glsl detectEdge(): 0 = no edge, 1 = darken, 2 = highlight. Neighbours clamp to the cell.
// The radial-jump branch is the click-specific addition described in header note 5.
int detectEdge(ivec2 ap, ivec2 lp, int eid, vec3 nrm, float r, vec3 viewDir){
  for(int i = 0; i < 4; i++){
    ivec2 d = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
    ivec2 nl = lp + d;
    if(nl.x < 0 || nl.y < 0 || nl.x >= uProbeSize || nl.y >= uProbeSize) continue;
    ivec2 np = ap + d;
    float nr = radialAt(np);
    if(nr >= 0.999) return 1;                        // silhouette against sky -> ink
    if(abs(r - nr) / max(max(r, nr), 1e-5) >= uDepthEdge){
      if(r <= nr) return 1;                          // we are in front -> we take the outline
      continue;                                      // we are behind -> the other side draws it
    }
    int neid = int(texelFetch(uAlbedo, np, 0).a * 255.0 + 0.5);
    if(neid != 0 && eid != 0 && neid != eid){
      if(r <= nr) return 1;
      continue;
    }
    vec3 nn = octDecode(texelFetch(uNormal, np, 0).rg);
    if(dot(nrm, nn) < uNormalThresh){
      return dot(nrm, viewDir) > dot(nn, viewDir) ? 2 : 1;
    }
  }
  return 0;
}

void main(){
  ivec2 ap = ivec2(gl_FragCoord.xy);
  ivec2 cell = ap / uProbeSize;
  int face = cell.x;                 // column = face
  int probe = cell.y;                // row = probe (0 eye, 1 grid, 2 prev)
  ivec2 lp = ap - cell * uProbeSize;
  vec3 origin = probe == 0 ? uOriginEye : (probe == 1 ? uOriginGrid : uOriginPrev);

  float sizeF = float(uProbeSize);
  float u = (float(lp.x) + 0.5) / sizeF * 2.0 - 1.0;
  float v = (float(lp.y) + 0.5) / sizeF * 2.0 - 1.0;
  vec3 dir = faceDir(face, u, v);

  float radial = radialAt(ap);
  if(radial >= 0.999){
    vec3 sky = skyGradient(normalize(dir), uSkyZenith, uSkyHorizon, uHazeColor, uHazeDensity);
    outColor = vec4(posterize(sky, uBands), 1.0);
    return;
  }

  vec3 albedo = texelFetch(uAlbedo, ap, 0).rgb;
  vec3 nrm = octDecode(texelFetch(uNormal, ap, 0).rg);

  float maxComp = max(max(abs(dir.x), abs(dir.y)), abs(dir.z));
  float chebyshev = radial * (uNearFar.y - uNearFar.x) + uNearFar.x;
  vec3 worldPos = origin + dir * (chebyshev / maxComp);

  float ndotl = max(dot(nrm, uSunDir), 0.0);

  float shadow = 1.0;
  vec4 lc = uLightMatrix * vec4(worldPos, 1.0);
  vec3 ls = lc.xyz / lc.w;
  if(ls.x >= 0.0 && ls.x <= 1.0 && ls.y >= 0.0 && ls.y <= 1.0 && ls.z <= 1.0){
    float bias = max(uShadowBias.y * (1.0 - ndotl), uShadowBias.x);
    float sum = 0.0;
    for(int x = -1; x <= 1; x++){
      for(int y = -1; y <= 1; y++){
        float d = unpackUnit(texture(uShadow, ls.xy + vec2(float(x), float(y)) * uShadowTexel));
        sum += (ls.z - bias > d) ? 0.0 : 1.0;
      }
    }
    shadow = sum / 9.0;
  }

  vec3 color = albedo * (uAmbient + uSunColor * ndotl * shadow);

  if(uOutlines > 0.5 && (probe >= 1 || uOutlineEye > 0.5)){
    int eid = int(texelFetch(uAlbedo, ap, 0).a * 255.0 + 0.5);
    vec3 viewDir = normalize(origin - worldPos);
    int edge = detectEdge(ap, lp, eid, nrm, radial, viewDir);
    if(edge != 0){
      float band = 1.0 / uBands;
      vec3 lab = toOKLab(color);
      lab.x += edge == 1 ? -uOutlineDarken * band : uOutlineHighlight * band;
      lab.x = clamp(lab.x, 0.0, 1.0);
      color = max(fromOKLab(lab), vec3(0.0));
    }
  }

  // Posterise last so the outline step is quantised too — the reference's ordering.
  outColor = vec4(posterize(color, uBands), 1.0);
}
`;

// ── pass 5a: background (background.glsl) ───────────────────────────────────
// Fullscreen triangle at depth 1.0, so every splat quad lands in front of it. Maps each screen pixel
// to a world ray from the EYE probe origin (which IS the camera position), snaps that ray to a
// cubemap texel of layers 0-5, and fetches the already-lit colour — pixelated sky, and hole-fill
// wherever the quads miss. See header note 4 for the ray derivation.

export const BACKGROUND_VERT = `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const BACKGROUND_FRAG = `
precision highp float;
precision highp int;
precision highp sampler2D;
${CHUNK_PACK}
${CHUNK_FACE}
uniform sampler2D uLit;
uniform sampler2D uRadial;
uniform mat4 uInvViewProj;
uniform vec3 uEyeOrigin;
uniform vec3 uHazeColor;
uniform vec2 uNearFar;
uniform float uHazeDensity;
uniform int uProbeSize;
uniform int uProbeRow;      // atlas row to read: 0 = eye probe (layers 0-5)
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main(){
  vec4 far = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uEyeOrigin);

  vec3 fuv = dirToFaceUV(dir);
  int layer = uProbeRow * 6 + int(fuv.x);
  ivec2 origin = layerOrigin(layer, uProbeSize);
  int px = clamp(int(fuv.y * float(uProbeSize)), 0, uProbeSize - 1);
  int py = clamp(int(fuv.z * float(uProbeSize)), 0, uProbeSize - 1);
  ivec2 ap = origin + ivec2(px, py);

  vec3 lit = texelFetch(uLit, ap, 0).rgb;
  float radial = 1.0 - unpackUnit(texelFetch(uRadial, ap, 0));
  if(radial < 0.999 && uHazeDensity > 0.0){
    float chebyshev = radial * (uNearFar.y - uNearFar.x) + uNearFar.x;
    float maxComp = max(max(abs(dir.x), abs(dir.y)), abs(dir.z));
    float haze = 1.0 - exp(-uHazeDensity * (chebyshev / maxComp));
    lit = mix(lit, uHazeColor, haze);
  }
  outColor = vec4(lit, 1.0);
}
`;

// ── pass 5b: splat (splat.glsl) ─────────────────────────────────────────────
// The technique itself. One instanced draw per (probe, visible face): probeSize^2 instances of a
// 6-vertex quad, no per-instance attributes — the texel index is gl_InstanceID and the corner is the
// sign pair stored in `position` (the reference derives it from gl_VertexIndex % 6; identical set of
// six corners, and culling is off so only consistency matters). Sky texels collapse to a degenerate
// triangle, which the GPU discards at primitive assembly for free.

export const SPLAT_VERT = `
precision highp float;
precision highp int;
precision highp sampler2D;
${CHUNK_PACK}
${CHUNK_FACE}
in vec3 position;              // xy = corner sign pair (-1/+1)
uniform sampler2D uRadial;
uniform sampler2D uEdge;
uniform mat4 uViewProj;
uniform vec3 uProbeOrigin;
uniform vec3 uCameraPos;
uniform vec2 uNearFar;
uniform float uExpansion;      // reference EXPANSION = 0.5 texels
uniform float uTightScale;     // reference 1.15
uniform float uTightSlope;     // reference 0.0005
uniform float uFadeT;
uniform float uEyeBias;        // reference 0.001 — pushes the eye probe behind grid on ties
uniform int uProbeIdx;         // 0 = eye, 1 = grid, 2 = prev
uniform int uFace;
uniform int uLayer;            // uProbeIdx * 6 + uFace
uniform int uProbeSize;
flat out vec2 vTexel;          // atlas coordinate of this texel, for the fragment's lit fetch
flat out float vFade;
flat out float vProbeIdx;
flat out float vHazeDist;
void main(){
  int size = uProbeSize;
  int texel = gl_InstanceID;
  int px = texel - (texel / size) * size;
  int py = texel / size;
  ivec2 ap = layerOrigin(uLayer, size) + ivec2(px, py);

  vTexel = vec2(ap);
  vFade = uFadeT;
  vProbeIdx = float(uProbeIdx);
  vHazeDist = 0.0;

  float radial = 1.0 - unpackUnit(texelFetch(uRadial, ap, 0));
  if(radial >= 0.999){ gl_Position = vec4(0.0); return; }   // sky -> degenerate quad

  float sizeF = float(size);
  float chebyshev = radial * (uNearFar.y - uNearFar.x) + uNearFar.x;
  float centerU = (float(px) + 0.5) / sizeF;
  float centerV = (float(py) + 0.5) / sizeF;

  vec3 centerDir = faceDir(uFace, centerU * 2.0 - 1.0, centerV * 2.0 - 1.0);
  float centerMax = max(abs(centerDir.x), max(abs(centerDir.y), abs(centerDir.z)));
  vec3 centerPos = uProbeOrigin + centerDir * (chebyshev / centerMax);
  // Haze is view dependent, so it measures from the CAMERA, not from the probe origin.
  vHazeDist = length(centerPos - uCameraPos);

  vec3 faceNormal =
    uFace == 0 ? vec3( 1.0, 0.0, 0.0) :
    uFace == 1 ? vec3(-1.0, 0.0, 0.0) :
    uFace == 2 ? vec3( 0.0, 1.0, 0.0) :
    uFace == 3 ? vec3( 0.0,-1.0, 0.0) :
    uFace == 4 ? vec3( 0.0, 0.0, 1.0) : vec3(0.0, 0.0,-1.0);

  // Two half-sizes: expanded (gap fill across a depth discontinuity) and tight (angle-compensated,
  // for a texel whose neighbour on that side is continuous). cosTheta floors at 0.14 (~82 degrees)
  // to cap the grazing-angle blow-up, exactly as the reference does.
  float halfTexel = 0.5 / sizeF;
  float hs = halfTexel + uExpansion / sizeF;
  vec3 viewDir = normalize(centerPos - uCameraPos);
  float cosTheta = max(abs(dot(viewDir, faceNormal)), 0.14);
  float tanTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0)) / cosTheta;
  float hsEdge = halfTexel * uTightScale + uTightSlope * tanTheta;

  vec4 emask = texelFetch(uEdge, ap, 0);
  float hsL = emask.r > 0.5 ? hsEdge : hs;
  float hsR = emask.g > 0.5 ? hsEdge : hs;
  float hsB = emask.b > 0.5 ? hsEdge : hs;
  float hsT = emask.a > 0.5 ? hsEdge : hs;

  float cu = position.x < 0.0 ? centerU - hsL : centerU + hsR;
  float cv = position.y < 0.0 ? centerV - hsB : centerV + hsT;

  vec3 rawDir = faceDir(uFace, cu * 2.0 - 1.0, cv * 2.0 - 1.0);
  float maxComp = max(abs(rawDir.x), max(abs(rawDir.y), abs(rawDir.z)));
  vec3 worldPos = uProbeOrigin + rawDir * (chebyshev / maxComp);

  gl_Position = uViewProj * vec4(worldPos, 1.0);

  // Knuth multiplicative hash depth jitter — breaks the z-fight between coplanar neighbouring
  // texels. Keyed on the LAYER (not the face) so the three probes get different jitter, per the
  // reference's tid = layer * PROBE_SIZE * PROBE_SIZE + py * PROBE_SIZE + px.
  uint tid = uint(uLayer * size * size + py * size + px);
  uint h = (tid * 2654435761u) >> 24u;
  gl_Position.z += float(h) * 1e-9 * gl_Position.w;

  // Eye probe sits slightly FARTHER so grid texels win the LESS_EQUAL depth test where the two
  // overlap: grid is the perspective-stable base, eye only fills what grid cannot see.
  if(uProbeIdx == 0) gl_Position.z += uEyeBias * gl_Position.w;

  gl_Position.z = min(gl_Position.z, gl_Position.w);
}
`;

export const SPLAT_FRAG = `
precision highp float;
precision highp int;
precision highp sampler2D;
${CHUNK_BAYER}
uniform sampler2D uLit;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
flat in vec2 vTexel;
flat in float vFade;
flat in float vProbeIdx;
flat in float vHazeDist;
layout(location = 0) out vec4 outColor;
void main(){
  // Complementary ordered dither during a grid transition: grid (idx 1) fades IN, prev (idx 2)
  // fades OUT on the inverse pattern, so the two tile the screen instead of overdrawing. The eye
  // probe (idx 0) is never dithered.
  if(vFade > 0.0 && vFade < 1.0){
    float threshold = bayer4(ivec2(gl_FragCoord.xy));
    if(vProbeIdx > 0.5 && vProbeIdx < 1.5){ if(threshold >= vFade) discard; }
    else if(vProbeIdx > 1.5)              { if(threshold <  vFade) discard; }
  }
  vec3 lit = texelFetch(uLit, ivec2(vTexel), 0).rgb;
  float haze = 1.0 - exp(-uHazeDensity * vHazeDist);
  outColor = vec4(mix(lit, uHazeColor, haze), 1.0);
}
`;

// ── pass 6: post (post.glsl + debug_vis.glsl) ───────────────────────────────
// Nearest-neighbour upscale of the low-res target with a gamma curve (everything upstream is linear
// RGB), plus the debug views the reference put behind Tab / 1-6 / 7.
//   uMode 0 = lit colour + gamma   1 = raw rgb           2 = packed radial (1 - unpack, grayscale)
//   uMode 3 = octahedral normal    4 = edge mask rgb     5 = albedo rgb + gamma
//   uMode 6 = packed depth, NOT inverted (the shadow map stores gl_FragCoord.z directly)
// uRect selects a sub-rectangle of the source, which is how showFace/showProbe pick an atlas cell.

export const POST_FRAG = `
precision highp float;
precision highp sampler2D;
${CHUNK_PACK}
${CHUNK_OCT}
uniform sampler2D uTex;
uniform vec4 uRect;    // xy = uv offset, zw = uv scale
uniform int uMode;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main(){
  vec2 uv = uRect.xy + vUv * uRect.zw;
  vec4 t = texture(uTex, uv);
  vec3 c;
  if(uMode == 2)      c = vec3(1.0 - unpackUnit(t));
  else if(uMode == 3) c = octDecode(t.rg) * 0.5 + 0.5;
  else if(uMode == 6) c = vec3(unpackUnit(t));
  else                c = t.rgb;
  if(uMode == 0 || uMode == 5) c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}
`;
