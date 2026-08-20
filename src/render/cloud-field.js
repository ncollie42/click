// Owns: the ONE cloud density field — the GLSL that decides where clouds are, shared by every
// consumer so they can never drift apart. Consumers today:
//   1. pixel.js composite — analytic sun-plane projection of the field: the god-ray march's
//      occluder and (cloudsMode "image") the legacy image-space darken fold.
//   2. pixel.js's cloud shadow plane (created via createCloudShadowPlane below) — a real
//      shadow-casting mesh at cloudHeight whose customDepthMaterial punches cloud-shaped holes,
//      so the stock shadow system projects cloud shade onto object SIDES along the live sun
//      (Red Giraffe vid6's "feed the mask into the shadow system"; the plane needs no sun math —
//      the shadow camera IS the sun projection).
//
// Field contract: cloudCoverAt(worldXZ) returns SMOOTH coverage in [0,1] (no banding — banding is
// each consumer's post-step, per the smooth-first-then-quantize law). Uniform set is declared by
// CLOUD_UNIFORMS_GLSL; every consumer syncs the same four values per frame from pixelTune, and
// uTime must be the SAME number across consumers within a frame (pixel.js computes it once).

export const CLOUD_UNIFORMS_GLSL = /* glsl */`
uniform float uCloudScale, uCloudSpeed, uCloudCover, uTime;
uniform vec2 uCloudOffset;
`;

// value-noise fBm over world XZ. Cheap, tileless, deterministic (came from toon.js, deleted
// at 43ad59b; verbatim so shipped cloud shapes did not change when this file was extracted).
export const CLOUD_FIELD_GLSL = /* glsl */`
float cfHash21(vec2 p){
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float cfVnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cfHash21(i), cfHash21(i + vec2(1.0, 0.0)), u.x),
             mix(cfHash21(i + vec2(0.0, 1.0)), cfHash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float cfFbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int k = 0; k < 4; k++){ v += a * cfVnoise(p); p = p * 2.03 + 17.7; a *= 0.5; }
  return v;
}
float cloudCoverAt(vec2 worldXZ){
  // uCloudOffset pans the field in FIELD units (1 unit ≈ 1/uCloudScale wu): drift (uTime) only
  // ever moves along one fixed diagonal, so composition needed a second, authored, dial
  // (round-2 critic: the shade masses sat mirrored from the reference with no knob to move them).
  float n = cfFbm(worldXZ * uCloudScale + uTime * uCloudSpeed + uCloudOffset) * 1.6 - 0.3;
  return smoothstep(uCloudCover, uCloudCover + 0.18, n);
}
`;

const DEPTH_VERT = /* glsl */`
varying vec3 vWorld;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// Shadow maps are binary per texel, so banded partial coverage becomes a DITHERED discard: a
// `cover` fraction of texels stays opaque and the receiver's PCF taps average that back into
// partial darkness. The threshold is INTERLEAVED GRADIENT NOISE (Jimenez '14): white-noise hash
// clumped into salt-and-pepper under PCF (round-1 finding), and ordered 4x4 Bayer left a
// perfectly regular diagonal weave along every penumbra (round-2 critic, 77% sign-alternation
// vs the reference's organic 30%). IGN is low-discrepancy like Bayer — every PCF window sees
// close to the true fraction — but aperiodic, so no lattice survives the average.
const DEPTH_FRAG = /* glsl */`
#include <packing>
${CLOUD_UNIFORMS_GLSL}
uniform float uCloudBands;
varying vec3 vWorld;
${CLOUD_FIELD_GLSL}
float cfIgn(vec2 px){
  return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
}
void main(){
  float cover = cloudCoverAt(vWorld.xz);
  if(uCloudBands > 1.5) cover = floor(cover * uCloudBands + 0.5) / uCloudBands;
  if(cover < cfIgn(gl_FragCoord.xy)) discard;
  gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
}`;

/**
 * Shadow-casting cloud plane. The caller owns its lifecycle: add mesh to the scene, remove +
 * dispose when done (pixel.js does this symmetrically). Sync the returned uniforms every frame
 * alongside the composite's copies. The 8000-unit span out-covers the shadow frustum (≤120
 * half-span, scene.js placeCamera) everywhere the camera can go.
 *
 * Layering (round-1 builder finding, verified against vendor three r160): WebGLShadowMap layer-
 * tests objects against the VIEW camera, not the shadow camera — so the plane must stay on the
 * default layer and hides from the main pass via colorWrite:false instead. Consequence for
 * override-material passes (they replace the material, colorWrite and all): the owner must
 * mesh.visible=false the plane around them (pixel.js's normals pass does).
 */
export function createCloudShadowPlane(THREE){
  const uniforms = {
    uCloudScale: {value: 0.02}, uCloudSpeed: {value: 0.01},
    uCloudCover: {value: 0.52}, uTime: {value: 0}, uCloudBands: {value: 3},
    uCloudOffset: {value: new THREE.Vector2(0, 0)},
  };
  const depthMat = new THREE.ShaderMaterial({
    uniforms, vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG,
  });
  // Placeholder surface material: draws nothing in the main pass (colorWrite/depthWrite off).
  // shadowSide must be explicit — the depth pass otherwise renders the REVERSE of material.side
  // (peter-panning default), which backface-culls this upward-facing single-sided plane out of
  // the shadow map entirely (round-1 builder finding, vendor three getDepthMaterial).
  const surfaceMat = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false});
  surfaceMat.shadowSide = THREE.DoubleSide;
  const geo = new THREE.PlaneGeometry(8000, 8000);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, surfaceMat);
  mesh.name = "cloud-shadow-plane";
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.raycast = () => {};   // inert to pickers and the view-debugger's blocker scan
  mesh.customDepthMaterial = depthMat;
  return {mesh, uniforms, dispose(){ geo.dispose(); depthMat.dispose(); surfaceMat.dispose(); }};
}
