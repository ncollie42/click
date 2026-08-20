// Owns: every line of GLSL the splat pipeline runs. Nothing here touches three or the DOM — the
// module is a string library, so the shaders can be read end-to-end in one place and the JS modules
// stay about *orchestration*. Ported from /pixel (Odin+sokol): gbuffer.glsl, edge_mask.glsl,
// lighting.glsl, splat.glsl, background.glsl, post.glsl, shadow.glsl.
//
// TWO SHADER DIALECTS live here, and mixing them up is the single easiest way to bench this
// pipeline:
//   * SCENE shaders (shadow caster, G-buffer variants) are compiled as three ShaderMaterials with
//     glslVersion GLSL3. three prepends its own prefix: `#version 300 es`, `#define attribute in`,
//     `#define varying out`, the standard uniforms (modelMatrix / modelViewMatrix / projectionMatrix
//     / normalMatrix / cameraPosition), the standard attributes (position / normal / uv), and the
//     conditional blocks `#ifdef USE_INSTANCING attribute mat4 instanceMatrix`,
//     `#ifdef USE_INSTANCING_COLOR attribute vec3 instanceColor`, `#ifdef USE_COLOR attribute vec3
//     color`. So those shaders must NOT redeclare any of that, and must NOT declare a precision
//     qualifier (three's prefix does). They DO declare their own `layout(location=N) out` targets:
//     under GLSL3 three skips its pc_fragColor declaration, leaving location 0 free.
//   * PASS shaders (edge mask, lighting, background, splat, post) are RawShaderMaterials with
//     glslVersion GLSL3. three prepends `#version 300 es` and the custom defines and NOTHING ELSE —
//     every attribute, uniform, varying and precision qualifier is declared by hand below.
//
// Data encodings (all G-buffer attachments are RGBA8 — see targets.js for why we don't use R32F):
//   albedo.rgb = linear diffuse, albedo.a = entity id / 255 (0 = sky, from the zero clear)
//   normal.rg  = octahedral world normal, .ba unused
//   radial     = packUnit(1 - radialNorm), 32-bit. INVERTED so the zero clear reads as radial 1.0,
//                which is the "sky / no geometry" sentinel every later pass tests with >= 0.999.

// ── shared chunks ───────────────────────────────────────────────────────────

// three's packDepthToRGBA math, verbatim: survives the unorm8 round trip for a [0,1] float with
// ~2e-10 error. Verified numerically. One quirk: v = 1.0 exactly saturates and reads back as
// 255/256, because the top channel is scaled by 256/255 before quantisation. Harmless here — the
// only value we store is 1 - radial, so the saturating end is geometry sitting on the probe's near
// plane, and the sentinel end (all zero = sky) round trips exactly.
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

/** Octahedral normal encode/decode (gbuffer.glsl + lighting.glsl). */
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

// Cubemap face <-> direction, and the 3x2 atlas layout that replaces the reference's texture array.
// Face order is the reference's: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z. faceDir() must stay in lockstep with
// FACE_TARGETS/FACE_UPS in probe.js — those look-at bases are what make this mapping true.
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
ivec2 faceOrigin(int face, int probeSize){
  return ivec2((face % 3) * probeSize, (face / 3) * probeSize);
}
`;

/** OKLab + posterize (lighting.glsl). Input/output linear RGB. */
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

/** Procedural sky + exponential haze (lighting.glsl / background.glsl / splat.glsl constants). */
export const CHUNK_SKY = `
vec3 skyGradient(vec3 dir, vec3 zenith, vec3 horizon, vec3 hazeColor, float hazeDensity){
  float t = pow(clamp(dir.y, 0.0, 1.0), 0.25);
  vec3 c = mix(horizon, zenith, t);
  float below = 1.0 - clamp(dir.y, 0.0, 1.0);
  c = mix(c, hazeColor, pow(below, 2.0) * min(hazeDensity * 5.0, 1.0));
  return c;
}
`;

// Bayer 4x4 ordered dither, computed arithmetically instead of from a const array: dynamic indexing
// of a local array is legal in ES 3.0 but has burned drivers before, and the bit twiddle is exact.
// Verified against the reference matrix (0 8 2 10 / 12 4 14 6 / 3 11 1 9 / 15 7 13 5).
export const CHUNK_BAYER = `
float bayer4(ivec2 p){
  int x = p.x & 3;
  int y = p.y & 3;
  int t = x ^ y;
  int v = ((t & 1) << 3) | ((y & 1) << 2) | (((t >> 1) & 1) << 1) | ((y >> 1) & 1);
  return float(v) / 16.0;
}
`;

// ── pass 1: sun shadow map ──────────────────────────────────────────────────
// ShaderMaterial (GLSL3) used as scene.overrideMaterial. Writes packed gl_FragCoord.z, exactly like
// shadow.glsl, except with three's 32-bit packing instead of the reference's 4-channel variant.
// We ignore three's own shadow system inside this pipeline (shadowMap.autoUpdate is forced off).

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

// ── pass 2: G-buffer capture ────────────────────────────────────────────────
// One ShaderMaterial variant per (source material x instanced?) — see capture.js. The reference
// passed the probe origin as a uniform to get the Chebyshev radial distance; we don't need it: the
// cube face bases are signed axis permutations of world space, so max(|x|,|y|,|z|) of the VIEW
// position equals the world-space Chebyshev distance from the probe origin. That removes the last
// per-face uniform from the scene materials, which in turn means three's per-draw modelViewMatrix
// upload is the only thing that has to be fresh — and that one is uploaded unconditionally.
//
// Defines set by capture.js: GB_FLAT (flat-shaded source material), GB_MAP (source material has a
// diffuse map). USE_INSTANCING / USE_INSTANCING_COLOR / USE_COLOR come from three.

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
  // Ignores non-uniform scale (inverse transpose), same shortcut the reference takes. Flat-shaded
  // materials re-derive the normal from screen-space derivatives anyway.
  vWorldNormal = mat3(modelMatrix) * nrm;
  vec3 albedo = uColor;
  #ifdef USE_INSTANCING_COLOR
    albedo *= instanceColor;
  #endif
  // three declares the colour attribute as vec4 when the geometry supplies 4 components, so the
  // alpha branch has to come first or this is a vec3 *= vec4 compile error.
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
    // Faceted look, three's flatShading equivalent. The cross product's sign depends on winding, so
    // the smooth vertex normal is used purely as an orientation reference.
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

  float chebyshev = max(max(abs(vViewPos.x), abs(vViewPos.y)), abs(vViewPos.z));
  float radial = clamp((chebyshev - uNearFar.x) / (uNearFar.y - uNearFar.x), 0.0, 1.0);
  outRadial = packUnit(1.0 - radial);
}
`;

// ── shared fullscreen-triangle vertex shader (RawShaderMaterial, GLSL3) ─────
// position holds clip-space xy directly (see passes.js FULLSCREEN_POSITIONS).

export const FULLSCREEN_VERT = `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ── pass 3: edge mask ───────────────────────────────────────────────────────
// Port of edge_mask.glsl. One draw over the WHOLE 3x2 atlas instead of the reference's per-layer
// pass: the face a texel belongs to is derived from its atlas coordinate, and neighbour lookups are
// clamped to the owning face so faces never bleed into each other.
// Output: R = left, G = right, B = bottom, A = top; 1 = continuous (tight quad), 0 = expanded.

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

float radialAt(ivec2 p){
  return 1.0 - unpackUnit(texelFetch(uRadial, p, 0));
}
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
  if(r >= 0.999){ outMask = vec4(0.0); return; }
  outMask = vec4(
    side(lp.x > 0,               ap + ivec2(-1, 0), r),
    side(lp.x < uProbeSize - 1,  ap + ivec2( 1, 0), r),
    side(lp.y > 0,               ap + ivec2(0, -1), r),
    side(lp.y < uProbeSize - 1,  ap + ivec2(0,  1), r));
}
`;

// ── pass 4: lighting ────────────────────────────────────────────────────────
// Port of lighting.glsl, again as ONE draw over the whole atlas. Reconstructs world position from
// (face, texel, radial, probe origin), lights it with a 3x3 PCF sample of our own shadow map,
// applies pixel-art outlines and 32-band OKLab posterization, and paints sky where radial says the
// ray missed everything.
//
// Outline detection differs from the reference on purpose: the reference gets object boundaries from
// per-entity ids, which we can only supply per *material* (three has no per-mesh uniform slot). So
// alongside the material id we also treat a radial discontinuity as a boundary — that recovers
// silhouettes between two props sharing a material, which the id test alone would miss.

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
uniform mat4 uLightMatrix;      // world -> shadow uv/depth, three's LightShadow.matrix
uniform vec3 uSunDir;           // unit vector pointing AT the sun
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uProbeOrigin;
uniform vec2 uNearFar;
uniform vec2 uShadowBias;       // x = constant, y = slope-scaled, both in normalised depth
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uHazeColor;
uniform float uHazeDensity;
uniform float uShadowTexel;
uniform float uBands;
uniform float uNormalThresh;
uniform float uDepthEdge;
uniform float uOutlines;
uniform int uProbeSize;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

float radialAt(ivec2 p){ return 1.0 - unpackUnit(texelFetch(uRadial, p, 0)); }

// 0 = no edge, 1 = darken, 2 = highlight. Neighbours are clamped to the owning face.
int detectEdge(ivec2 ap, ivec2 lp, int eid, vec3 nrm, float r, vec3 viewDir){
  for(int i = 0; i < 4; i++){
    ivec2 d = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
    ivec2 nl = lp + d;
    if(nl.x < 0 || nl.y < 0 || nl.x >= uProbeSize || nl.y >= uProbeSize) continue;
    ivec2 np = ap + d;
    float nr = radialAt(np);
    if(nr >= 0.999) return 1;                       // silhouette against sky -> ink
    if(abs(r - nr) / max(max(r, nr), 1e-5) >= uDepthEdge){
      if(r <= nr) return 1;                         // we are in front -> we get the outline
      continue;
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
  int face = cell.y * 3 + cell.x;
  ivec2 lp = ap - cell * uProbeSize;

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
  vec3 worldPos = uProbeOrigin + dir * (chebyshev / maxComp);

  float ndotl = max(dot(nrm, uSunDir), 0.0);

  float shadow = 1.0;
  vec4 lc = uLightMatrix * vec4(worldPos, 1.0);
  vec3 ls = lc.xyz / lc.w;
  if(ls.x >= 0.0 && ls.x <= 1.0 && ls.y >= 0.0 && ls.y <= 1.0 && ls.z <= 1.0){
    float bias = uShadowBias.x + uShadowBias.y * (1.0 - ndotl);
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

  if(uOutlines > 0.5){
    int eid = int(texelFetch(uAlbedo, ap, 0).a * 255.0 + 0.5);
    vec3 viewDir = normalize(uProbeOrigin - worldPos);
    int edge = detectEdge(ap, lp, eid, nrm, radial, viewDir);
    if(edge != 0){
      float band = 1.0 / uBands;
      vec3 lab = toOKLab(color);
      lab.x += edge == 1 ? -band : band;
      lab.x = clamp(lab.x, 0.0, 1.0);
      color = max(fromOKLab(lab), vec3(0.0));
    }
  }

  outColor = vec4(posterize(color, uBands), 1.0);
}
`;

// ── pass 5a: background ─────────────────────────────────────────────────────
// Port of background.glsl. Fullscreen triangle at depth 1.0 that maps each screen pixel to a world
// ray from the probe origin, snaps that ray to a cubemap texel, and fetches the already-lit colour.
// It paints the sky at the probe's texel resolution AND fills any hole the splat quads leave.
// The ray comes from an inverse view-projection unproject rather than the reference's camera basis +
// tan(fov/2): that one expression covers the game's perspective camera and its orthographic toggle.

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
uniform vec3 uProbeOrigin;
uniform vec3 uHazeColor;
uniform vec2 uNearFar;
uniform float uHazeDensity;
uniform int uProbeSize;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main(){
  vec4 far = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uProbeOrigin);

  vec3 fuv = dirToFaceUV(dir);
  int face = int(fuv.x);
  ivec2 origin = faceOrigin(face, uProbeSize);
  int px = clamp(int(fuv.y * float(uProbeSize)), 0, uProbeSize - 1);
  int py = clamp(int(fuv.z * float(uProbeSize)), 0, uProbeSize - 1);
  ivec2 ap = origin + ivec2(px, py);

  vec3 lit = texelFetch(uLit, ap, 0).rgb;
  float radial = 1.0 - unpackUnit(texelFetch(uRadial, ap, 0));
  if(radial < 0.999){
    float chebyshev = radial * (uNearFar.y - uNearFar.x) + uNearFar.x;
    float maxComp = max(max(abs(dir.x), abs(dir.y)), abs(dir.z));
    float haze = 1.0 - exp(-uHazeDensity * (chebyshev / maxComp));
    lit = mix(lit, uHazeColor, haze);
  }
  outColor = vec4(lit, 1.0);
}
`;

// ── pass 5b: splat ──────────────────────────────────────────────────────────
// Port of splat.glsl, the core of the technique. One instanced draw per visible face: probeSize^2
// instances of a 6-vertex quad, no per-instance attributes — the texel is gl_InstanceID and the
// corner is the sign pair stored in `position`. Sky texels collapse to a degenerate triangle, which
// the GPU discards at primitive assembly.

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
uniform float uExpansion;
uniform float uFadeT;
uniform float uSlot;           // 0 = grid (fades in), 1 = prev (fades out)
uniform int uFace;
uniform int uProbeSize;
flat out vec2 vTexel;
flat out float vFade;
flat out float vSlot;
flat out float vHazeDist;
void main(){
  int size = uProbeSize;
  int texel = gl_InstanceID;
  int px = texel % size;
  int py = texel / size;
  ivec2 ap = faceOrigin(uFace, size) + ivec2(px, py);

  vTexel = vec2(ap);
  vFade = uFadeT;
  vSlot = uSlot;
  vHazeDist = 0.0;

  float radial = 1.0 - unpackUnit(texelFetch(uRadial, ap, 0));
  if(radial >= 0.999){ gl_Position = vec4(0.0); return; }

  float sizeF = float(size);
  float chebyshev = radial * (uNearFar.y - uNearFar.x) + uNearFar.x;
  float centerU = (float(px) + 0.5) / sizeF;
  float centerV = (float(py) + 0.5) / sizeF;

  vec3 centerDir = faceDir(uFace, centerU * 2.0 - 1.0, centerV * 2.0 - 1.0);
  float centerMax = max(abs(centerDir.x), max(abs(centerDir.y), abs(centerDir.z)));
  vec3 centerPos = uProbeOrigin + centerDir * (chebyshev / centerMax);
  vHazeDist = length(centerPos - uCameraPos);

  vec3 faceNormal =
    uFace == 0 ? vec3( 1.0, 0.0, 0.0) :
    uFace == 1 ? vec3(-1.0, 0.0, 0.0) :
    uFace == 2 ? vec3( 0.0, 1.0, 0.0) :
    uFace == 3 ? vec3( 0.0,-1.0, 0.0) :
    uFace == 4 ? vec3( 0.0, 0.0, 1.0) : vec3(0.0, 0.0,-1.0);

  float halfTexel = 0.5 / sizeF;
  float hs = halfTexel + uExpansion / sizeF;
  vec3 viewDir = normalize(centerPos - uCameraPos);
  float cosTheta = max(abs(dot(viewDir, faceNormal)), 0.14);
  float tanTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0)) / cosTheta;
  float hsEdge = halfTexel * 1.15 + 0.0005 * tanTheta;

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

  // Knuth hash depth jitter: breaks the z-fight between coplanar neighbouring texels.
  uint tid = uint(texel + uFace * size * size);
  uint h = (tid * 2654435761u) >> 24u;
  gl_Position.z += float(h) * 1e-9 * gl_Position.w;
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
flat in float vSlot;
flat in float vHazeDist;
layout(location = 0) out vec4 outColor;
void main(){
  // Complementary ordered dither: grid fades in as prev fades out, so the two probes tile the
  // screen during a transition instead of overdrawing each other.
  if(vFade > 0.0 && vFade < 1.0){
    float threshold = bayer4(ivec2(gl_FragCoord.xy));
    if(vSlot < 0.5){ if(threshold >= vFade) discard; }
    else           { if(threshold <  vFade) discard; }
  }
  vec3 lit = texelFetch(uLit, ivec2(vTexel), 0).rgb;
  float haze = 1.0 - exp(-uHazeDensity * vHazeDist);
  outColor = vec4(mix(lit, uHazeColor, haze), 1.0);
}
`;

// ── pass 6: post ────────────────────────────────────────────────────────────
// Port of post.glsl plus the debug views the reference put behind Tab/1-6. Nearest-neighbour upscale
// of the low-res target with a gamma curve (everything upstream is linear).
//   uMode 0 = lit colour + gamma   1 = raw rgb   2 = packed radial   3 = octahedral normal
//   uMode 4 = edge mask rgb        5 = albedo rgb + gamma

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
  else if(uMode == 4) c = t.rgb;
  else                c = t.rgb;
  if(uMode == 0 || uMode == 5) c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}
`;
