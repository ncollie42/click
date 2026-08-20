// Owns: assembly of the test scene — renderer, camera, light rig, terrain + props, and the
// hand-off to the shared render-pipeline registry. Everything numeric lives in preset.js; this
// file only wires it up. Browser-only.
//
// Pipeline contract (src/render/pipelines/index.js): we hand over {THREE, renderer, scene,
// getCamera, getSun, waterPrePass, view}. There is no water here, so waterPrePass is a no-op —
// pixel.js calls it once per frame and must not care. getSun() must return a shadow-casting
// DirectionalLight whose shadow frustum covers the visible ground: in cloudsMode "scene" that
// light's shadow map is where cloud shade comes from (pixel.js adds cloud-field.js's plane to
// OUR scene, on the default layer, and hides it from colour with colorWrite:false).
//
// NOTHING here patches the cloud plane. Round 1 carried two workarounds (view-camera layer
// enable, plane.shadowSide) for bugs since fixed in src/render/cloud-field.js + pixel.js; the
// page now drives the stock path so what it measures is what the game gets.

import * as THREE from "three";
import {configurePipelines, renderFrame, resizePipeline, setPipeline, getPipelineName}
  from "../../src/render/pipelines/index.js";
import {pixelTune} from "../../src/render/pipelines/pixel.js";
import {CAMERA, SUN, HEMI, TERRAIN, OBJECTS, PIXEL_PRESET, SEED_DEFAULT} from "./preset.js";
import {buildTerrain} from "./terrain.js";
import {buildObjects} from "./objects.js";

const DEG = Math.PI / 180;

/** Sun direction (unit, pointing FROM the target TOWARD the sun) from az/el.
 *  azimuth 0 = +X (screen right at yaw 0); positive azimuth tips toward the camera (+Z). */
export function sunDirection(azimuthDeg, elevationDeg){
  const el = elevationDeg * DEG, az = azimuthDeg * DEG;
  const horiz = Math.cos(el);
  return new THREE.Vector3(horiz * Math.cos(az), Math.sin(el), horiz * Math.sin(az));
}

/**
 * Screen-space silhouette polygon of one prop, in CANVAS PIXELS (origin top-left) — the round-3
 * yardstick's key. Consumers: snap-scene.mjs writes these to <shot>.props.json, and
 * tools/shots/redgiraffe-scene-r1/probe.py masks each prop by (polygon ∩ props-on/props-off diff).
 * Exact, not approximate: a sphere's silhouette is the circle of tangency (radius r·√(1−(r/d)²) on
 * a plane pushed r²/d toward the camera), NOT the great circle — at d≈70 wu, r=5 that is a 0.25%
 * shrink, but the tangency plane offset matters for the sunk domes' ground line.
 */
function silhouettePoly(THREE, mesh, spec, camera, w, h){
  const pts = [];
  const c = mesh.position;
  if(spec.kind === "sphere"){
    const toCam = new THREE.Vector3().subVectors(camera.position, c);
    const d = toCam.length();
    toCam.divideScalar(d);
    const rr = spec.r * Math.sqrt(Math.max(0, 1 - (spec.r / d) * (spec.r / d)));
    const ring = new THREE.Vector3().copy(c).addScaledVector(toCam, spec.r * spec.r / d);
    // any two axes orthogonal to the view direction
    const a = new THREE.Vector3(0, 1, 0).cross(toCam);
    if(a.lengthSq() < 1e-6) a.set(1, 0, 0);
    a.normalize();
    const b = new THREE.Vector3().crossVectors(toCam, a).normalize();
    for(let i = 0; i < 48; i++){
      const th = i / 48 * Math.PI * 2;
      pts.push(new THREE.Vector3().copy(ring)
        .addScaledVector(a, rr * Math.cos(th)).addScaledVector(b, rr * Math.sin(th)));
    }
  }else{
    const [sx, sy, sz] = spec.size;
    for(let i = 0; i < 8; i++){
      const p = new THREE.Vector3((i & 1 ? 0.5 : -0.5) * sx, (i & 2 ? 0.5 : -0.5) * sy,
                                  (i & 4 ? 0.5 : -0.5) * sz);
      pts.push(p.applyMatrix4(mesh.matrixWorld));
    }
  }
  const scr = pts.map(p => {
    const v = p.clone().project(camera);
    return [(v.x * 0.5 + 0.5) * w, (1 - (v.y * 0.5 + 0.5)) * h];
  });
  return convexHull(scr);
}

/** Monotone-chain hull; input is a small point set, so the O(n log n) is free. */
function convexHull(pts){
  const p = pts.slice().sort((u, v) => u[0] - v[0] || u[1] - v[1]);
  const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const lower = [], upper = [];
  for(const q of p){ while(lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], q) <= 0) lower.pop(); lower.push(q); }
  for(let i = p.length - 1; i >= 0; i--){ const q = p[i];
    while(upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function startTestScene({canvas, seed = SEED_DEFAULT, tuneOverrides = {}, sunAz, sunEl,
                                noProps = false, ortho = false, yawDeg = 0}){
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true});
  renderer.setPixelRatio(1);              // 1 output pixel per CSS pixel: screenshots are exact
  renderer.shadowMap.enabled = true;
  // Plain PCF, not PCFSoft: PCFSoftShadowMap IGNORES shadow.radius (fixed kernel), and the
  // radius blur is what keeps the el-22 cast skirts from reading as hard fake ellipses.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // No tone mapping and default sRGB output — same as the game (src/render/scene.js), which is
  // what pixel.js's manual encode is calibrated against.

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2a16);   // never visible: the frame is all ground

  // Live camera POSE — preset/URL seed it, camera-controls.js (interactive sessions only)
  // mutates it, placeCamera() reads it every frame. Frame half-height is the fov/dist product,
  // so the ortho camera shows the same meadow as the near-ortho perspective rig and `dist`
  // doubles as the ortho zoom. ?ortho=1&yaw=45&pitch=35.26 is classic isometric.
  const pose = {pitch: CAMERA.pitchDeg, yaw: yawDeg, dist: CAMERA.dist, fov: CAMERA.fov,
                ortho: !!ortho, target: [...CAMERA.target]};
  const halfH = () => pose.dist * Math.tan(pose.fov * 0.5 * DEG);
  let aspect = 16 / 9;
  let camera = null;
  function makeCamera(){
    const h = halfH();
    camera = pose.ortho
      ? new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, CAMERA.near, CAMERA.far)
      : new THREE.PerspectiveCamera(pose.fov, aspect, CAMERA.near, CAMERA.far);
  }
  makeCamera();

  const hemi = new THREE.HemisphereLight(HEMI.skyColor, HEMI.groundColor, HEMI.intensity);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = true;
  const s = SUN.shadow;
  sun.shadow.mapSize.set(s.mapSize, s.mapSize);
  sun.shadow.camera.near = s.near;
  sun.shadow.camera.far = s.far;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -s.halfSpan;
  sun.shadow.camera.right = sun.shadow.camera.top = s.halfSpan;
  sun.shadow.bias = s.bias;
  sun.shadow.normalBias = s.normalBias;
  if(s.radius !== undefined) sun.shadow.radius = s.radius;
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.set(CAMERA.target[0], 0, CAMERA.target[2]);
  const dir = sunDirection(sunAz ?? SUN.azimuthDeg, sunEl ?? SUN.elevationDeg);
  sun.position.copy(sun.target.position).addScaledVector(dir, SUN.distance);
  scene.add(sun, sun.target);

  const terrain = buildTerrain(THREE, {seed, terrain: TERRAIN});
  scene.add(terrain.mesh);
  // ?props=0 removes the five props. Its ONLY job is the yardstick: probe.py diffs a props-off
  // shot against the matching props-on one to get an exact per-prop pixel mask (the diff also
  // lights up each prop's cast shadow, which is why the mask is intersected with the silhouette
  // polygon below). Never used for a judged frame.
  const props = buildObjects(THREE, {seed, terrain: TERRAIN, objects: noProps ? [] : OBJECTS});
  for(const mesh of props.meshes) scene.add(mesh);

  // ── the pixelTune preset, applied before the first frame ──
  // pixel.js live-reads this object every frame, so the R panel keeps working on top of it.
  Object.assign(pixelTune, PIXEL_PRESET, tuneOverrides);

  // `view` is only read by the debug panel's pipeline section; a plain holder satisfies it.
  const view = {pitch: CAMERA.pitchDeg, yaw: 0, fov: CAMERA.fov};
  configurePipelines({
    THREE, renderer, scene,
    getCamera: () => camera,
    getSun: () => sun,
    waterPrePass: () => {},              // no water in this scene
    view,
  });
  setPipeline("pixel");                  // no-op if the registry already picked it up

  function placeCamera(){
    const pitch = pose.pitch * DEG, yaw = pose.yaw * DEG;
    const [tx, ty, tz] = pose.target;
    const horiz = Math.cos(pitch) * pose.dist;
    camera.position.set(tx + Math.sin(yaw) * horiz, ty + Math.sin(pitch) * pose.dist,
                        tz + Math.cos(yaw) * horiz);
    camera.lookAt(tx, ty, tz);
    // Projection follows the pose every frame (cheap at one camera): fov/dist edits from the
    // controls land without any invalidation protocol.
    if(camera.isOrthographicCamera){
      const h = halfH();
      camera.left = -h * aspect; camera.right = h * aspect; camera.top = h; camera.bottom = -h;
    }else{
      camera.fov = pose.fov; camera.aspect = aspect;
    }
    camera.updateProjectionMatrix();
  }

  let frames = 0;
  function frame(){
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if(canvas.width !== w || canvas.height !== h){
      renderer.setSize(w, h, false);
      aspect = w / Math.max(1, h);
      resizePipeline(w, h);      // projection itself is refreshed in placeCamera below
    }
    placeCamera();
    renderFrame();
    frames++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  const api = {
    THREE, renderer, scene, get camera(){ return camera; }, sun, hemi, pixelTune,
    // camera-controls.js's surface: mutate pose freely; setOrtho swaps the camera object
    // (pipelines re-read it through ctx.getCamera() every frame, per the registry contract).
    pose, placeCamera,
    setOrtho(on){ if(pose.ortho !== !!on){ pose.ortho = !!on; makeCamera(); placeCamera(); } },
    seed, preset: {CAMERA, SUN, HEMI, TERRAIN, OBJECTS, PIXEL_PRESET},
    framesRendered: () => frames,
    pipeline: () => getPipelineName(),
    /** Per-prop screen silhouettes for the round-3 yardstick (see silhouettePoly). */
    propRects(){
      placeCamera();
      camera.updateMatrixWorld(true);
      const w = canvas.width, h = canvas.height;
      return OBJECTS.map((spec, i) => {
        const mesh = props.meshes[i];
        if(!mesh) return {name: spec.name, kind: spec.kind, poly: []};
        mesh.updateMatrixWorld(true);
        const poly = silhouettePoly(THREE, mesh, spec, camera, w, h);
        const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
        return {name: spec.name, kind: spec.kind, poly,
                rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]};
      });
    },
    dispose(){ terrain.dispose(); props.dispose(); renderer.dispose(); },
  };
  return api;
}
