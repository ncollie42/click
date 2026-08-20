// Map editor — water rendering for the preview pane.
// The audition round picked depth-foam water (historical mode 4): a scene depth
// pre-pass drives shoreline foam and a shallow→deep gradient wherever water
// meets geometry. Mode 0 keeps the flat plane the game ships today for
// comparison. (A "voyage/ocean" mode 5 was auditioned and benched — see docs/water.md;
// its implementation lives at commit ffe6b95.)
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
  amp: .16,      // wave height
  foam: 1,       // foam amount multiplier
  fade: .45,     // depth falloff: lower reaches the shallow gradient deeper into the water
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

export function createWaterModes({renderer, surfaceY, tileOf, floorYOf}){
  let mode = 4, scene = null, doc = null, mesh = null, perFrame = null;
  const extraMeshes = [];
  const params = {...WATER_PARAM_DEFAULTS};
  const uTime = {value: 0};
  const uAmp = {value: params.amp};
  const uFoamMul = {value: params.foam};
  const uFade = {value: params.fade};
  const startedAt = performance.now();
  const owned = [];                       // disposed on every rebuild
  // Render targets, disposed on every rebuild too; only the active mode's targets are allocated.
  const targets = {depth: null};
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
  // finite and continuous, so fade + shore depth control the entire gradient run.
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

  // Historical audition numbering kept: 0 = flat (game today), 4 = depth foam.
  const builders = {0: buildFlat, 4: buildDepthFoam};

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
