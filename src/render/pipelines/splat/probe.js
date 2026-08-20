// Owns: probe geometry and probe *time*. Two things live here and nothing else touches them —
//   1. the cubemap face basis (which way each of the 6 faces looks, which atlas cell it lands in,
//      and which faces the camera can possibly see), and
//   2. the grid-snap transition state machine ported from the reference's probe.odin.
//
// WHY A PROBE AT ALL: texel splatting is perspective-stable because the texel grid is anchored to a
// probe origin, not to the camera. Pan the camera inside one grid cell and every splat keeps the
// exact same world-space footprint, so nothing crawls or shimmers. Cross a cell boundary and the
// grid has to jump — that jump is what the Bayer crossfade hides.
//
// SIMPLIFIED VS THE REFERENCE: the reference runs three probes (eye at the camera, grid snapped,
// prev for the fade). We run two — grid and prev — because this game's camera never free-rotates and
// the eye probe exists to fix close-range detail for a first-person view. See splat.js for the
// ping-pong that makes prev cost zero extra capture work.
//
// FACE ORDER is the reference's: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z, laid out in a 3x2 atlas as
// (face%3, face/3). FACE_TARGETS/FACE_UPS are chosen so that a standard GL look-at basis reproduces
// glsl.js's faceDir() exactly — verify one by hand before touching either side.

export const NUM_FACES = 6;

export const FACE_TARGETS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
export const FACE_UPS = [
  [0, -1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -1, 0],
];

/** One 90-degree camera per face. Six objects, not one moved six times: three only re-uploads
 * viewMatrix/cameraPosition when the camera *object* changes, so sharing one would risk stale
 * per-face uniforms in any scene material that reads them. */
export function makeFaceCameras(THREE, near, far){
  const cams = [];
  for(let f = 0; f < NUM_FACES; f++){
    const c = new THREE.PerspectiveCamera(90, 1, near, far);
    c.up.set(...FACE_UPS[f]);
    cams.push(c);
  }
  return cams;
}

/** Point every face camera at `origin` (a THREE.Vector3) and refresh its matrices. */
export function placeFaceCameras(cams, origin, near, far){
  for(let f = 0; f < NUM_FACES; f++){
    const c = cams[f];
    if(c.near !== near || c.far !== far){
      c.near = near; c.far = far; c.updateProjectionMatrix();
    }
    c.position.copy(origin);
    c.up.set(...FACE_UPS[f]);
    c.lookAt(origin.x + FACE_TARGETS[f][0], origin.y + FACE_TARGETS[f][1], origin.z + FACE_TARGETS[f][2]);
    c.updateMatrixWorld(true);   // also refreshes matrixWorldInverse (Camera overrides this)
  }
}

/** 6-bit mask of faces worth capturing/splatting, from the camera forward vector.
 * threshold is cos(acceptance angle); the reference uses cos(103 degrees) for the grid probe so the
 * cone reaches a little past the horizon and covers the screen corners. */
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

export const faceVisible = (face, mask) => (mask & (1 << face)) !== 0;

// ── transition state ────────────────────────────────────────────────────────
// Port of probe.odin's Transition_State. The grid origin snaps to a world lattice; when it moves,
// the old origin becomes "prev" and a crossfade runs. The fade rate is the max of a fixed duration
// and the camera's own speed in cells/second, so a fast pan doesn't stack up a queue of half-faded
// transitions — it just fades faster.

export class Transition {
  constructor(){
    this.gridOrigin = null;     // THREE.Vector3, set on first update
    this.prevOrigin = null;
    this.fadeT = 0;
    this.blending = false;
    this.smoothedSpeed = 0;
    this.lastPos = null;
    this.snapped = false;       // true on the frame the grid origin moved
  }

  /** @param camPos THREE.Vector3 (live camera position) @param dt seconds */
  update(THREE, camPos, dt, gridStep, blendDuration){
    const step = Math.max(gridStep, 1e-3);
    const clamped = Math.min(Math.max(dt, 0), 0.1);
    this.snapped = false;

    if(!this.gridOrigin){
      this.gridOrigin = new THREE.Vector3();
      this.prevOrigin = new THREE.Vector3();
      this.lastPos = camPos.clone();
      this.gridOrigin.set(Math.round(camPos.x / step) * step,
                          Math.round(camPos.y / step) * step,
                          Math.round(camPos.z / step) * step);
      this.prevOrigin.copy(this.gridOrigin);
      this.snapped = true;
      return;
    }

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
      this.snapped = true;
    }

    // Not gated by `else`: fadeT must already be > 0 on the frame the blend starts, or grid and prev
    // both draw at full strength for one frame and the seam pops.
    if(this.blending){
      const rate = Math.max(1 / Math.max(blendDuration, 1e-3), this.smoothedSpeed / step);
      this.fadeT += rate * clamped;
      if(this.fadeT >= 1){ this.fadeT = 1; this.blending = false; }
    }
  }

  /** Fade value the splat shaders want: 0 when idle (no dithering), 0..1 mid-transition. */
  get fade(){ return this.blending ? this.fadeT : 0; }
}
