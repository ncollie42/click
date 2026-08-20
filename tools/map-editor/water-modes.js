// Map editor — water rendering for the preview pane.
// The audition round picked depth-foam water (historical mode 4): a scene depth
// pre-pass drives shoreline foam and a shallow→deep gradient wherever water
// meets geometry. Mode 0 keeps the flat plane the game ships today for
// comparison. Mode 5 ("voyage") is the newest candidate — see buildVoyage.
// Each build tears down exactly what it created; render targets live only while
// the mode that owns them is active. Browser-only.

import * as THREE from "three";

const BASE_COLOR = 0x4d7fc0;
const SHALLOW = new THREE.Color(0x6fb0dd);
const DEEP = new THREE.Color(0x22558f);
const FOAM = new THREE.Color(0xecf6f8);
const SUN_DIR = new THREE.Vector3(.35, .85, .3).normalize();

// Live-tunable parameters (preview toolbar sliders). Amp is in world units;
// water sits .42 below ground tops, so keep max amp well under that.
export const WATER_PARAM_DEFAULTS = Object.freeze({
  amp: .16,      // wave height                                    (modes 4, 5)
  foam: 1,       // foam amount multiplier                         (modes 4, 5)
  fade: .45,     // depth falloff: lower reaches the shallow gradient deeper into the water (4, 5)
  // Mode 5 only. Sliders always call setParams with numbers (it validates nothing else), so the
  // reflection toggle rides along as reflectOn 0/1 rather than a bool — no validator surgery.
  distort: .015,      // refraction offset in screen UV units (~1.5% of the frame at full depth)
  distortSpeed: .35,  // how fast the flow field scrolls; the devlog insists on slow and mellow
  waveSpeed: .6,      // phase rate of the multiplied ebb-flow sine pair (0 freezes the surface)
  caps: .15,          // whitecap amount: slides the noise threshold, 0 = none. Sparse on purpose
  reflect: .8,        // planar-reflection strength, scaled by fresnel before the blend
  reflectOn: 1,       // 1 = render the mirrored camera each frame, 0 = skip that pass entirely
  tint: .8,           // how far the shallow→deep tint takes over from the refracted scene color
});
const FLOOR_COLOR = 0x8f855e;   // submerged sand, shows through the shallows

// World-space XZ wave field, shared by displacement and any future shading.
const WAVE_GLSL = `
uniform float uTime;
uniform float uAmp;
float waveHeight(vec2 p, float t){
  return uAmp * (.45 * sin(p.x * .16 + t * 1.2)
    + .3 * sin(p.x * .11 + p.y * .13 - t * .8)
    + .25 * sin(-.42 * p.x + .38 * p.y + t * 2.0)
    + .3 * sin(p.x * .9 + p.y * .75 + t * 2.4));
}
`;

// Mode 5's macro displacement, straight from the devlog: one sine wave, plus the SAME wave rotated
// 90° around Y, MULTIPLIED together. The product's node lines stand still while its lobes swell and
// drain in turn — the "call and response" ebb-flow motion. A sum (WAVE_GLSL, mode 4) would only ever
// read as another travelling chop. Fine surface detail is left to the flow field and the whitecaps
// on purpose: geometry that small dies in the low-res render anyway.
const EBB_WAVE_GLSL = `
uniform float uTime;
uniform float uAmp;
uniform float uWaveSpeed;
float ebbHeight(vec2 p, float t){
  const vec2 dir = vec2(.8, .6);        // unit travel direction in world XZ
  const float freq = .13;               // ≈48 world units between crests
  float phase = t * uWaveSpeed;
  float along = sin(dot(p, dir) * freq + phase);
  float perp = sin(dot(p, vec2(-dir.y, dir.x)) * freq + phase);   // same params, rotated 90° around Y
  return uAmp * along * perp;
}
`;

// Tileable value noise baked into a small RGBA texture: R and G are independent fields, read as a
// flow vector in the shader. Generated in code on purpose — the repo takes no binary assets, and a
// 64² lattice-noise tile is indistinguishable from an authored flow map once it is scrolling.
function makeFlowTexture(size = 64){
  const hash = (x, y, seed) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return n - Math.floor(n);
  };
  // Lattice indices wrap at `cells`, so the tile matches itself across a RepeatWrapping seam.
  const noise = (u, v, cells, seed) => {
    const x = u * cells, y = v * cells;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const wrap = i => ((i % cells) + cells) % cells;
    const at = (i, j) => hash(wrap(i), wrap(j), seed);
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(at(x0, y0), at(x0 + 1, y0), sx),
      THREE.MathUtils.lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), sx), sy);
  };
  const data = new Uint8Array(size * size * 4);
  for(let y = 0; y < size; y++) for(let x = 0; x < size; x++){
    const u = x / size, v = y / size, index = (y * size + x) * 4;
    data[index] = 255 * (.65 * noise(u, v, 4, 1) + .35 * noise(u, v, 8, 2));
    data[index + 1] = 255 * (.65 * noise(u, v, 4, 3) + .35 * noise(u, v, 8, 4));
    data[index + 2] = 128;
    data[index + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  // No colorSpace conversion: these bytes are vector data, not color.
  texture.needsUpdate = true;
  return texture;
}

const TAIL_GLSL = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
const FACET_LIGHT_GLSL = `
float facetLight(vec3 world, vec3 sun){
  vec3 normal = normalize(cross(dFdx(world), dFdy(world)));
  if(normal.y < 0.0) normal = -normal;
  return .5 + .6 * clamp(dot(normal, sun), 0.0, 1.0);
}
`;

// ── planar reflection camera ─────────────────────────────────────────────────
// three's Reflector math, specialised to a horizontal mirror plane at planeY: the virtual camera is
// the real one reflected through the plane, and textureMatrix projects a world position into that
// render's [0,1] screen space so the shader can sample it with a perspective divide.
// Oblique near-plane clipping (Lengyel, terathon.com/code/oblique.html) folds the mirror plane into
// the projection's near plane so submerged geometry never reaches the reflection. Its derivation
// divides by projectionMatrix[14] and assumes the perspective w = -z row, so it is applied for
// perspective cameras only; an ortho camera still mirrors correctly, it just relies on the caller
// hiding below-water meshes (see buildVoyage) and can show submerged shore walls.
const CLIP_BIAS = .003;
const _mirrorUp = new THREE.Vector3(), _normal = new THREE.Vector3(), _camPos = new THREE.Vector3();
const _planePos = new THREE.Vector3(), _view = new THREE.Vector3(), _lookAt = new THREE.Vector3();
const _target = new THREE.Vector3(), _rotation = new THREE.Matrix4();
const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _q = new THREE.Vector4();
function updateMirrorCamera(camera, mirror, planeY, textureMatrix){
  const normal = _normal.set(0, 1, 0), planePos = _planePos.set(0, planeY, 0);
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  _view.subVectors(planePos, _camPos).reflect(normal).negate().add(planePos);
  _rotation.extractRotation(camera.matrixWorld);
  _lookAt.set(0, 0, -1).applyMatrix4(_rotation).add(_camPos);
  _target.subVectors(planePos, _lookAt).reflect(normal).negate().add(planePos);
  mirror.position.copy(_view);
  mirror.up.copy(_mirrorUp.set(0, 1, 0).applyMatrix4(_rotation).reflect(normal));
  mirror.lookAt(_target);
  mirror.near = camera.near;
  mirror.far = camera.far;
  mirror.updateMatrixWorld(true);                 // Camera.updateMatrixWorld refreshes matrixWorldInverse
  mirror.projectionMatrix.copy(camera.projectionMatrix);
  if(!camera.isOrthographicCamera){
    _plane.setFromNormalAndCoplanarPoint(normal, planePos).applyMatrix4(mirror.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const p = mirror.projectionMatrix.elements;
    _q.set((Math.sign(_clip.x) + p[8]) / p[0], (Math.sign(_clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    _clip.multiplyScalar(2 / _clip.dot(_q));
    p[2] = _clip.x;
    p[6] = _clip.y;
    p[10] = _clip.z + 1 - CLIP_BIAS;
    p[14] = _clip.w;
  }
  mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
  textureMatrix.set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);
  textureMatrix.multiply(mirror.projectionMatrix);
  textureMatrix.multiply(mirror.matrixWorldInverse);
}

export function createWaterModes({renderer, surfaceY, tileOf, floorYOf}){
  let mode = 4, scene = null, doc = null, mesh = null, perFrame = null;
  const extraMeshes = [];
  const params = {...WATER_PARAM_DEFAULTS};
  const uTime = {value: 0};
  const uAmp = {value: params.amp};
  const uFoamMul = {value: params.foam};
  const uFade = {value: params.fade};
  const uDistort = {value: params.distort};
  const uDistortSpeed = {value: params.distortSpeed};
  const uWaveSpeed = {value: params.waveSpeed};
  const uCaps = {value: params.caps};
  const uReflectStrength = {value: params.reflect * params.reflectOn};
  const uTint = {value: params.tint};
  const startedAt = performance.now();
  const owned = [];                       // disposed on every rebuild
  // Render targets, disposed on every rebuild too. depth: mode 4's pre-pass. scene/reflect: mode 5's
  // opaque-scene color read and its mirrored camera. Only the active mode's targets are allocated.
  const targets = {depth: null, scene: null, reflect: null};
  const tmpSize = new THREE.Vector2();

  const own = resource => { owned.push(resource); return resource; };
  function disposeTarget(key){
    if(!targets[key]) return;
    targets[key].depthTexture?.dispose();
    targets[key].dispose();
    targets[key] = null;
  }
  // Grow-on-demand offscreen target; `depth` asks for a sampleable DepthTexture alongside the color.
  function sizedTarget(key, size, depth){
    if(targets[key] && targets[key].width === size.x && targets[key].height === size.y) return targets[key];
    disposeTarget(key);
    targets[key] = new THREE.WebGLRenderTarget(size.x, size.y,
      depth ? {depthTexture: new THREE.DepthTexture(size.x, size.y)} : {});
    return targets[key];
  }
  function clear(){
    if(mesh && scene) scene.remove(mesh);
    for(const extra of extraMeshes) scene.remove(extra);
    extraMeshes.length = 0;
    mesh = null;
    perFrame = null;
    for(const resource of owned) resource.dispose();
    owned.length = 0;
    for(const key of Object.keys(targets)) disposeTarget(key);
  }

  // Shared plane: 3 tiles of apron beyond the map on every side, subdivided so
  // one facet spans ~`facetSize` world units (0 = single quad).
  function planeMesh(material, facetSize){
    const tile = tileOf(doc);
    const width = (doc.width + 6) * tile, depth = (doc.height + 6) * tile;
    const segs = size => THREE.MathUtils.clamp(Math.round(size / facetSize), 8, 160);
    const geometry = own(facetSize > 0
      ? new THREE.PlaneGeometry(width, depth, segs(width), segs(depth))
      : new THREE.PlaneGeometry(width, depth));
    mesh = new THREE.Mesh(geometry, own(material));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(doc.width * tile / 2, surfaceY, doc.height * tile / 2);
    mesh.name = "water";
    scene.add(mesh);
    return mesh;
  }

  function buildFlat(){
    planeMesh(new THREE.MeshLambertMaterial({color: BASE_COLOR, flatShading: true}), 0).receiveShadow = true;
  }

  // A lake floor at shore-wall depth: without it, view rays escape past the wall bottoms into the
  // void, and the shallow→deep gradient snaps to full deep in a hard line. The floor keeps thickness
  // finite and continuous, so fade + shore depth control the entire gradient run. Modes 4 and 5 both
  // want it; mode 5 additionally hides it while rendering reflections (it sits below the mirror plane).
  function lakeFloor(){
    const tile = tileOf(doc);
    const geometry = own(new THREE.PlaneGeometry((doc.width + 6) * tile, (doc.height + 6) * tile));
    const floor = new THREE.Mesh(geometry, own(new THREE.MeshLambertMaterial({color: FLOOR_COLOR})));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(doc.width * tile / 2, floorYOf(), doc.height * tile / 2);
    floor.name = "waterFloor";
    scene.add(floor);
    extraMeshes.push(floor);
    return floor;
  }

  function buildDepthFoam(){
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime, uAmp, uFoamMul, uFade,
        uDepth: {value: null},
        uResolution: {value: new THREE.Vector2(1, 1)},
        uNear: {value: .1}, uFar: {value: 4000},
        uShallow: {value: SHALLOW}, uDeep: {value: DEEP}, uFoam: {value: FOAM}, uSun: {value: SUN_DIR},
      },
      vertexShader: WAVE_GLSL + `
        varying vec3 vWorld;
        varying float vViewZ;
        void main(){
          vec4 world = modelMatrix * vec4(position, 1.0);
          world.y += waveHeight(world.xz, uTime);
          vWorld = world.xyz;
          vec4 view = viewMatrix * world;
          vViewZ = view.z;
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: "#include <packing>\n" + FACET_LIGHT_GLSL + `
        uniform sampler2D uDepth;
        uniform vec2 uResolution;
        uniform float uNear, uFar, uTime, uFoamMul, uFade;
        uniform vec3 uShallow, uDeep, uFoam, uSun;
        varying vec3 vWorld;
        varying float vViewZ;
        void main(){
          float sceneDepth = texture2D(uDepth, gl_FragCoord.xy / uResolution).x;
          float sceneViewZ = perspectiveDepthToViewZ(sceneDepth, uNear, uFar);
          float thickness = max(vViewZ - sceneViewZ, 0.0);
          vec3 color = mix(uShallow, uDeep, 1.0 - exp(-thickness * uFade)) * facetLight(vWorld, uSun);
          float ripple = .5 + .5 * sin(thickness * 6.0 - uTime * 2.2 + (vWorld.x + vWorld.z) * .4);
          float foam = (smoothstep(1.8, .08, thickness) * smoothstep(.3, .8, ripple)
            + smoothstep(.45, .04, thickness)) * uFoamMul;
          color = mix(color, uFoam, clamp(foam, 0.0, 1.0));
          gl_FragColor = vec4(color, clamp(.6 + thickness * .12, 0.0, .93));
          ${TAIL_GLSL}
        }`,
    });
    const built = planeMesh(material, 3);
    lakeFloor();
    const depthOverride = own(new THREE.MeshBasicMaterial());
    // Optional width/height mirror the game's waterPrePass: a render pipeline drawing the scene
    // into a low-res offscreen target passes that target's size so uResolution matches the
    // gl_FragCoord space the water will actually be shaded in.
    perFrame = (camera, width, height) => {
      const size = width ? tmpSize.set(width, height) : renderer.getDrawingBufferSize(tmpSize);
      material.uniforms.uDepth.value = sizedTarget("depth", size, true).depthTexture;
      material.uniforms.uResolution.value.copy(size);
      material.uniforms.uNear.value = camera.near;
      material.uniforms.uFar.value = camera.far;
      // Depth pre-pass: everything but the water, cheapest possible materials. Everything the pass
      // borrows is captured first and put back in the finally — the previously BOUND target (callers
      // may already be rendering into one; restoring literal null would silently retarget them), the
      // caller's own overrideMaterial, shadow autoUpdate and the water's visibility. A throw mid-pass
      // must not leave the water hidden or the override dangling on every later frame.
      const previousTarget = renderer.getRenderTarget();
      const previousOverride = scene.overrideMaterial;
      const shadowAuto = renderer.shadowMap.autoUpdate;
      try{
        built.visible = false;
        renderer.shadowMap.autoUpdate = false;
        scene.overrideMaterial = depthOverride;
        renderer.setRenderTarget(targets.depth);
        renderer.render(scene, camera);
      }finally{
        renderer.setRenderTarget(previousTarget);
        scene.overrideMaterial = previousOverride;
        renderer.shadowMap.autoUpdate = shadowAuto;
        built.visible = true;
      }
    };
  }

  // ── mode 5: "voyage" ───────────────────────────────────────────────────────
  // Ports the four ingredients from Voyage's devlog "Developing a Water Shader for 3D Pixel Art":
  //   1. TINT        — the plane samples the opaque scene color behind it (pass A) and blends the
  //                    shallow→deep tint over it by absorption depth, so the lake bed reads through
  //                    the shallows instead of being replaced by a flat gradient (mode 4's look).
  //   2. DISTORTION  — a generated tileable flow tile (makeFlowTexture) scrolls in world XZ and
  //                    offsets the scene-color sample UVs, SCALED BY THE DEPTH FADE so geometry
  //                    breaking the surface barely warps while deep pixels warp hardest (the
  //                    devlog's subtlety). Deliberately slow and mellow; a leak guard re-tests depth
  //                    at the offset UV so foreground geometry can't smear.
  //   3. REFLECTION  — pass B renders the scene through a mirrored camera (updateMirrorCamera) and
  //                    the shader projects that texture onto the surface. The devlog shipped this
  //                    behind a toggle because of the second camera's cost; so do we (reflectOn).
  //   4. FOAM        — mode 4's depth-difference shoreline threshold, uniform-for-uniform, so the
  //                    two candidates can be compared on the parts that are supposed to match,
  //                    plus scattered whitecaps (uCaps) the devlog paints on top of the whole stack.
  // Vertex displacement is the devlog's ebb-flow pair (EBB_WAVE_GLSL), not mode 4's summed chop.
  // Fresnel weights reflection against refraction by view angle: grazing views mirror, top-down
  // views look through. Both offscreen passes land in linear color (three skips tone mapping into
  // render targets), so everything composites linear and the fragment tail tone-maps exactly once.
  // Per-frame cost: 1 extra full scene render with reflections off, 2 with them on, on top of the
  // real draw — pricier than mode 4's depth-only override pass, which is the honest audition data.
  function buildVoyage(){
    const flow = own(makeFlowTexture());
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime, uAmp, uFoamMul, uFade, uDistort, uDistortSpeed, uWaveSpeed, uCaps, uReflectStrength, uTint,
        uScene: {value: null}, uDepth: {value: null}, uReflect: {value: null}, uFlow: {value: flow},
        uReflectMatrix: {value: new THREE.Matrix4()},
        uResolution: {value: new THREE.Vector2(1, 1)},
        uNear: {value: .1}, uFar: {value: 4000}, uOrtho: {value: 0},
        uShallow: {value: SHALLOW}, uDeep: {value: DEEP}, uFoam: {value: FOAM}, uSun: {value: SUN_DIR},
      },
      vertexShader: EBB_WAVE_GLSL + `
        uniform mat4 uReflectMatrix;
        varying vec3 vWorld;
        varying float vViewZ;
        varying vec4 vReflectUv;
        void main(){
          vec4 world = modelMatrix * vec4(position, 1.0);
          world.y += ebbHeight(world.xz, uTime);
          vWorld = world.xyz;
          // Projected against the displaced world position, so the reflection rides the waves.
          vReflectUv = uReflectMatrix * vec4(world.xyz, 1.0);
          vec4 view = viewMatrix * world;
          vViewZ = view.z;
          gl_Position = projectionMatrix * view;
        }`,
      // highp on the depth sampler is load-bearing (same reason as the game's water: ANGLE honors
      // the lowp default and quantizes thickness into visible bands).
      fragmentShader: "#include <packing>\n" + FACET_LIGHT_GLSL + `
        uniform highp sampler2D uDepth;
        uniform sampler2D uScene, uReflect, uFlow;
        uniform vec2 uResolution;
        uniform float uNear, uFar, uOrtho, uTime, uFoamMul, uFade;
        uniform float uDistort, uDistortSpeed, uWaveSpeed, uCaps, uReflectStrength, uTint;
        uniform vec3 uShallow, uDeep, uFoam, uSun;
        varying vec3 vWorld;
        varying float vViewZ;
        varying vec4 vReflectUv;
        float sceneViewZAt(vec2 uv){
          float depth = texture2D(uDepth, uv).x;
          return uOrtho > .5
            ? orthographicDepthToViewZ(depth, uNear, uFar)
            : perspectiveDepthToViewZ(depth, uNear, uFar);
        }
        void main(){
          vec2 uv = gl_FragCoord.xy / uResolution;
          // 2. flow field: two scrolling octaves of the generated tile, read as a vector.
          vec2 flowUv = vWorld.xz * .05 + vec2(uTime * uDistortSpeed * .05, uTime * uDistortSpeed * .037);
          vec2 flow = (texture2D(uFlow, flowUv).rg - .5)
            + (texture2D(uFlow, flowUv * 1.9 - uTime * uDistortSpeed * .03).rg - .5) * .5;
          // Thickness comes from the undistorted read so foam and tint stay put while refraction wobbles.
          float thickness = max(vViewZ - sceneViewZAt(uv), 0.0);
          // Absorption depth: 0 where geometry breaks the surface, →1 in deep water. It drives the
          // tint (1) and, scaled onto the offset, the distortion (2) — the shore stays readable
          // because surface-adjacent pixels barely move, while deep pixels warp the full uDistort.
          float absorb = 1.0 - exp(-thickness * uFade);
          vec2 refractUv = clamp(uv + flow * uDistort * absorb, vec2(.001), vec2(.999));
          if(vViewZ - sceneViewZAt(refractUv) <= 0.0) refractUv = uv;   // offset hit geometry in front: no leak
          vec3 sceneColor = texture2D(uScene, refractUv).rgb;
          // 1. tint over the refracted scene; deep water absorbs more of it.
          float light = facetLight(vWorld, uSun);
          vec3 color = mix(sceneColor, mix(uShallow, uDeep, absorb) * light,
            clamp(uTint * (.3 + .7 * absorb), 0.0, 1.0));
          // 3. fresnel-weighted planar reflection.
          vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          if(normal.y < 0.0) normal = -normal;
          float fresnel = .04 + .96 * pow(1.0 - clamp(dot(normal, normalize(cameraPosition - vWorld)), 0.0, 1.0), 4.0);
          if(uReflectStrength > 0.0){
            // The mirrored ray never travels through the water, so this offset stays depth-independent
            // (unlike refraction above): only the surface ripple bends it.
            vec2 reflectUv = vReflectUv.xy / max(vReflectUv.w, 1e-4) + flow * uDistort * .6;
            vec3 reflection = texture2D(uReflect, clamp(reflectUv, vec2(.001), vec2(.999))).rgb;
            color = mix(color, reflection, clamp(uReflectStrength * fresnel, 0.0, 1.0));
          }
          // 4. shoreline foam, identical to mode 4.
          float ripple = .5 + .5 * sin(thickness * 6.0 - uTime * 2.2 + (vWorld.x + vWorld.z) * .4);
          float foam = (smoothstep(1.8, .08, thickness) * smoothstep(.3, .8, ripple)
            + smoothstep(.45, .04, thickness)) * uFoamMul;
          color = mix(color, uFoam, clamp(foam, 0.0, 1.0));
          // 4b. whitecaps, painted last (top of the devlog's layer stack). Two independent reads of the
          // flow tile are multiplied, so only the rare pixels where BOTH fields peak clear the
          // threshold — sparse by construction, since dense surface noise muddies pixel art. Swapped
          // axes and incommensurate scales are the point of taking two reads: one tile read twice puts
          // exactly one fleck per lattice cell and the repeat reads as a grid. That product tops out
          // at .66, so uCaps = 0 parks the threshold out of reach — no caps at all — while 1 still
          // scatters flecks (~10% of the surface) instead of sheeting it; the .4 gamma is the measured
          // inverse of the product's steep tail, which keeps the slider's low end usable rather than
          // all-or-nothing. Drift keeps a floor so caps crawl even with the waves frozen.
          vec2 capDrift = uTime * (.004 + uWaveSpeed * .01) * vec2(1.0, -1.4);
          float crest = texture2D(uFlow, vWorld.xz * .13 + capDrift).r
            * texture2D(uFlow, vWorld.zx * .079 - capDrift * 1.3).g;
          float capEdge = mix(.66, .36, pow(clamp(uCaps, 0.0, 1.0), .4));
          color = mix(color, uFoam, smoothstep(capEdge, capEdge + .04, crest));
          // Opaque: this shader composites its own refraction, so nothing is left for blending.
          gl_FragColor = vec4(color, 1.0);
          ${TAIL_GLSL}
        }`,
    });
    const built = planeMesh(material, 3);
    const floor = lakeFloor();
    const reflectMatrix = material.uniforms.uReflectMatrix.value;
    let mirror = null;
    // Same optional width/height contract as mode 4: a pipeline drawing into a low-res offscreen
    // target passes that size so every screen-space read shares one gl_FragCoord space.
    perFrame = (camera, width, height) => {
      const size = width ? tmpSize.set(width, height) : renderer.getDrawingBufferSize(tmpSize);
      const sceneTarget = sizedTarget("scene", size, true);
      material.uniforms.uScene.value = sceneTarget.texture;
      material.uniforms.uDepth.value = sceneTarget.depthTexture;
      material.uniforms.uResolution.value.copy(size);
      material.uniforms.uNear.value = camera.near;
      material.uniforms.uFar.value = camera.far;
      material.uniforms.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
      // Same capture-and-restore contract as mode 4: the bound target, the caller's overrideMaterial
      // (this mode binds none of its own, but an enclosing pass may have one), shadow autoUpdate, and
      // the meshes these passes hide all come back in the finally even if a render throws.
      const previousTarget = renderer.getRenderTarget();
      const previousOverride = scene.overrideMaterial;
      const shadowAuto = renderer.shadowMap.autoUpdate;
      try{
        renderer.shadowMap.autoUpdate = false;    // shadows stay on the real draw's single update
        built.visible = false;
        // Pass A — opaque scene color + depth with the water hidden. No overrideMaterial here, unlike
        // mode 4: this render *is* the color the surface refracts, so it needs the real materials.
        renderer.setRenderTarget(sceneTarget);
        renderer.render(scene, camera);
        // Pass B — planar reflection. Off means off: no target, no render, and uReflectStrength is 0
        // so the shader's branch never samples it.
        if(params.reflectOn >= .5){
          const reflectTarget = sizedTarget("reflect", size, false);
          material.uniforms.uReflect.value = reflectTarget.texture;
          if(!mirror || !!mirror.isOrthographicCamera !== !!camera.isOrthographicCamera)
            mirror = camera.isOrthographicCamera ? new THREE.OrthographicCamera() : new THREE.PerspectiveCamera();
          floor.visible = false;   // sits below the mirror plane; mirrored, it would paint the sky sand
          updateMirrorCamera(camera, mirror, surfaceY, reflectMatrix);
          renderer.setRenderTarget(reflectTarget);
          renderer.render(scene, mirror);
        }else if(targets.reflect){
          material.uniforms.uReflect.value = null;
          disposeTarget("reflect");
        }
      }finally{
        renderer.setRenderTarget(previousTarget);
        scene.overrideMaterial = previousOverride;
        renderer.shadowMap.autoUpdate = shadowAuto;
        built.visible = true;
        floor.visible = true;
      }
    };
  }

  // Historical audition numbering kept: 0 = flat (game today), 4 = depth foam, 5 = voyage port.
  const builders = {0: buildFlat, 4: buildDepthFoam, 5: buildVoyage};

  return {
    setMode(next){
      if(!builders[next]) throw new Error(`water mode must be one of ${Object.keys(builders).join(", ")}, got ${next}`);
      mode = next;
    },
    mode: () => mode,
    setParams(partial){
      for(const key of Object.keys(partial)){
        if(!(key in params) || typeof partial[key] !== "number" || !Number.isFinite(partial[key]))
          throw new Error(`bad water param ${key}=${partial[key]}`);
        params[key] = partial[key];
      }
      uAmp.value = params.amp;
      uFoamMul.value = params.foam;
      uFade.value = params.fade;
      uDistort.value = params.distort;
      uDistortSpeed.value = params.distortSpeed;
      uWaveSpeed.value = params.waveSpeed;
      uCaps.value = params.caps;
      // The toggle folds into the strength the shader reads: 0 means the reflection branch is dead
      // even on the frame before the pre-pass notices and drops the target.
      uReflectStrength.value = params.reflectOn >= .5 ? params.reflect : 0;
      uTint.value = params.tint;
    },
    params: () => ({...params}),
    build(nextScene, nextDoc){
      clear();
      scene = nextScene;
      doc = nextDoc;
      builders[mode]();
    },
    update(camera, width, height){
      uTime.value = (performance.now() - startedAt) / 1000;
      if(perFrame) perFrame(camera, width, height);
    },
    triangleCount(){
      if(!mesh) return 0;
      const geometry = mesh.geometry;
      return (geometry.getIndex() ? geometry.getIndex().count : geometry.getAttribute("position").count) / 3;
    },
    dispose: clear,
  };
}
