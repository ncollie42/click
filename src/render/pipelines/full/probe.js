// Owns: probe GEOMETRY and probe TIME for the full (three-probe) texel-splatting pipeline.
// Ported from /home/mando/dev/gamedev/pixel/source/probe.odin — the face bases, the 90-degree cube
// projection, the face-mask visibility test, and the grid-snap transition state machine.
//
// WHY A PROBE AT ALL: texel splatting is perspective-stable because the texel grid is anchored to a
// probe ORIGIN, not to the camera. Pan the camera inside one grid cell and every splat keeps the
// exact same world-space footprint, so nothing crawls or shimmers. Cross a cell boundary and the
// grid origin has to jump — the Bayer crossfade against the previous origin is what hides that jump.
//
// THREE PROBES, exactly as the reference (probe.odin NUM_PROBES = 3):
//   PROBE_EYE  (layers  0-5)  origin = the live camera position. Close-up detail; the reference
//                             pushes its splats slightly farther in depth so grid wins ties.
//   PROBE_GRID (layers  6-11) origin = camera position snapped to a GRID_STEP lattice. The stable
//                             base image.
//   PROBE_PREV (layers 12-17) origin = the PREVIOUS grid origin, alive only during a crossfade.
// Layer index is probe * 6 + face throughout, matching the reference's texture-array layout; here
// that index addresses a cell of a 6x3 atlas instead (column = face, row = probe). See full/glsl.js
// header note 1.
//
// NOTHING HERE ASSUMES A FIXED CAMERA POSE. Face masks come from the live camera forward vector and
// (optionally) the live FOV; probe origins come from the live camera position. The pipeline must
// stay correct under the game's orbit debug mode and under any free rotation added later, so every
// value in this module is re-derived per frame from the camera object.
//
// FACE ORDER is the reference's: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z. FACE_TARGETS/FACE_UPS are chosen so
// that a standard GL look-at basis reproduces faceDir() in full/glsl.js EXACTLY — verified
// numerically (max NDC error 2e-15 across all six faces, and every face rotation is a signed
// permutation of world axes, which is what lets the G-buffer skip the probe-origin uniform).

export const NUM_FACES = 6;
export const NUM_PROBES = 3;
export const TOTAL_LAYERS = NUM_FACES * NUM_PROBES;   // 18

export const PROBE_EYE = 0;
export const PROBE_GRID = 1;
export const PROBE_PREV = 2;

// probe.odin FACE_TARGETS / FACE_UPS.
export const FACE_TARGETS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
export const FACE_UPS = [
  [0, -1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -1, 0],
];

// probe.odin EYE_CULL_COS / GRID_CULL_COS — cos(98 deg) and cos(103 deg). The grid cone is wider so
// it still covers the screen through a transition, when the grid origin is up to half a cell away
// from the camera.
export const EYE_CULL_COS = -0.139;
export const GRID_CULL_COS = -0.225;

/** One 90-degree square camera per face. Six camera OBJECTS, not one moved six times: three only
 * re-uploads a program's camera-scoped uniforms when the camera object changes between draws, so
 * sharing a single camera across faces would risk a stale projection in any scene material that
 * reads one. (Our G-buffer material reads only modelMatrix/modelViewMatrix/projectionMatrix, all of
 * which three refreshes per draw, but the six-camera shape costs nothing and removes the question.)
 * The same six are re-placed for each of the three probes — see placeFaceCameras. */
export function makeFaceCameras(THREE, near, far){
  const cams = [];
  for(let f = 0; f < NUM_FACES; f++){
    const c = new THREE.PerspectiveCamera(90, 1, near, far);
    c.up.set(...FACE_UPS[f]);
    cams.push(c);
  }
  return cams;
}

/** Point every face camera at `origin` (THREE.Vector3) and refresh its matrices. */
export function placeFaceCameras(cams, origin, near, far){
  for(let f = 0; f < NUM_FACES; f++){
    const c = cams[f];
    if(c.near !== near || c.far !== far){
      c.near = near; c.far = far; c.updateProjectionMatrix();
    }
    c.position.copy(origin);
    c.up.set(...FACE_UPS[f]);
    c.lookAt(origin.x + FACE_TARGETS[f][0], origin.y + FACE_TARGETS[f][1], origin.z + FACE_TARGETS[f][2]);
    c.updateMatrixWorld(true);   // Camera.updateMatrixWorld also refreshes matrixWorldInverse
  }
}

/** probe.odin compute_face_mask(): 6-bit mask of faces that can contribute, from the camera forward
 * vector. `threshold` is the cosine of the acceptance angle. Purely a function of `fwd`, so it
 * re-derives correctly under any camera rotation — that is the whole rotation-correctness contract. */
export function computeFaceMask(fwd, threshold){
  let mask = 0;
  if(fwd.x >= threshold) mask |= 1;
  if(-fwd.x >= threshold) mask |= 2;
  if(fwd.y >= threshold) mask |= 4;
  if(-fwd.y >= threshold) mask |= 8;
  if(fwd.z >= threshold) mask |= 16;
  if(-fwd.z >= threshold) mask |= 32;
  return mask;
}

/** probe.odin face_visible(). */
export const faceVisible = (face, mask) => (mask & (1 << face)) !== 0;

/** Number of set bits in a 6-bit face mask — used for the per-frame cost readout. */
export function faceCount(mask){
  let n = 0;
  for(let f = 0; f < NUM_FACES; f++) if(mask & (1 << f)) n++;
  return n;
}

/** The reference's thresholds (cos 98 / cos 103) were tuned against a 60-degree vertical FOV. This
 * game runs a 38-degree camera today but the FOV is a live slider and an orthographic toggle exists,
 * so the threshold is widened to whatever the camera's half-DIAGONAL FOV needs. The result is never
 * NARROWER than the reference's constant — `Math.min` on cosines picks the wider cone — so this can
 * only ever select MORE faces than the reference would, never fewer. Rotation-safe: half-diagonal is
 * an orientation-independent property of the frustum. */
export function cullThreshold(camera, baseCos, fovAware){
  if(!fovAware) return baseCos;
  if(!camera.isPerspectiveCamera) return -1;          // ortho: no ray cone at all, keep every face
  const halfV = (camera.fov * Math.PI / 180) * 0.5;
  const tanV = Math.tan(halfV);
  const tanH = tanV * (camera.aspect || 1);
  const halfDiag = Math.atan(Math.hypot(tanV, tanH));
  return Math.min(baseCos, Math.cos(Math.PI * 0.5 + halfDiag));
}

// ── transition state ────────────────────────────────────────────────────────
// Straight port of probe.odin's Transition_State + transition_update(), including the two details
// that are easy to "clean up" and wrong to:
//
//   1. A new grid origin is only accepted while NOT already blending. Origin changes queue up behind
//      the running crossfade instead of restarting it, which is what stops a fast pan from producing
//      a stack of half-faded transitions.
//   2. The fade advance is NOT in an `else`. It runs on the same frame the blend starts, so fadeT is
//      already > 0 by the time the fragment shader dithers — otherwise grid and prev both draw at
//      full strength for exactly one frame and the seam pops.
//
// SPEED-ADAPTIVE, per the reference: the rate is max(1/blendDuration, smoothedSpeed / gridStep), so
// a camera crossing cells faster than the fixed duration fades proportionally faster. The speed is
// an exponential moving average with a 0.05s time constant.

export class Transition {
  constructor(){
    this.gridOrigin = null;      // THREE.Vector3, allocated on first update
    this.prevOrigin = null;
    this.fadeT = 0;
    this.blending = false;
    this.smoothedSpeed = 0;      // world units / second
    this.lastPos = null;
    this.initialized = false;
    // probe.odin's grid_needs_update / prev_needs_update: a probe whose origin just moved holds
    // texture data from a DIFFERENT world position and must be re-captured this frame regardless of
    // any scheduling. This pipeline captures all 18 layers every frame by default, so these are
    // advisory — they drive the optional `cullCaptures` fast path and the debug readout.
    this.gridNeedsUpdate = false;
    this.prevNeedsUpdate = false;
  }

  /** @param camPos live THREE.Vector3 @param dt seconds @param gridStep world units @param blendDuration seconds */
  update(THREE, camPos, dt, gridStep, blendDuration){
    const step = Math.max(gridStep, 1e-3);
    const clamped = Math.min(Math.max(dt, 0), 0.1);   // probe.odin: dt_clamped = min(dt, 0.1)

    if(!this.initialized){
      this.gridOrigin = new THREE.Vector3();
      this.prevOrigin = new THREE.Vector3();
      this.lastPos = camPos.clone();
      this.gridOrigin.set(Math.round(camPos.x / step) * step,
                          Math.round(camPos.y / step) * step,
                          Math.round(camPos.z / step) * step);
      this.prevOrigin.copy(this.gridOrigin);
      this.initialized = true;
      this.gridNeedsUpdate = true;
      this.prevNeedsUpdate = false;
      return;
    }

    this.gridNeedsUpdate = false;
    this.prevNeedsUpdate = false;

    if(clamped > 1e-4){
      const inst = this.lastPos.distanceTo(camPos) / clamped;
      const alpha = 1 - Math.exp(-clamped / 0.05);
      this.smoothedSpeed = alpha * inst + (1 - alpha) * this.smoothedSpeed;
    }
    this.lastPos.copy(camPos);

    const sx = Math.round(camPos.x / step) * step;
    const sy = Math.round(camPos.y / step) * step;
    const sz = Math.round(camPos.z / step) * step;

    if(!this.blending &&
       (sx !== this.gridOrigin.x || sy !== this.gridOrigin.y || sz !== this.gridOrigin.z)){
      this.prevOrigin.copy(this.gridOrigin);
      this.gridOrigin.set(sx, sy, sz);
      this.fadeT = 0;
      this.blending = true;
      this.gridNeedsUpdate = true;
      this.prevNeedsUpdate = true;
    }

    // Deliberately NOT `else if` — see note 2 above.
    if(this.blending){
      const rate = Math.max(1 / Math.max(blendDuration, 1e-3), this.smoothedSpeed / step);
      this.fadeT += rate * clamped;
      if(this.fadeT >= 1){ this.fadeT = 1; this.blending = false; }
    }
  }

  /** The value the splat shaders want: 0 when idle (no dithering at all), 0..1 mid-transition.
   * splat.odin: `fade_t := ts.blending ? ts.fade_t : f32(0)`. */
  get fade(){ return this.blending ? this.fadeT : 0; }

  /** A grid-step change (slider) invalidates the lattice; re-snap on the next update. */
  reset(){
    this.initialized = false;
    this.blending = false;
    this.fadeT = 0;
    this.smoothedSpeed = 0;
  }
}
