// Owns: the page entry point — URL params, the deterministic time freeze, and the readiness flag
// the screenshot harness waits on. Nothing else here; the scene lives in scene.js.
//
// TIME FREEZE, and why it is in its own module: pixel.js reads performance.now() every frame for
// the cloud/god-ray field's uTime, and cloud-field.js's shadow plane is synced from that same
// number. Freezing it makes a shot reproducible. The patch MUST land before the pipeline modules
// are evaluated, so every import below is DYNAMIC and happens after the assignment — a static
// `import` would be hoisted above it.

const params = new URLSearchParams(location.search);

const t = params.get("t");
if(t !== null && Number.isFinite(parseFloat(t))){
  const frozenMs = parseFloat(t) * 1000;
  performance.now = () => frozenMs;      // own-property shadow of Performance.prototype.now
}

// A frozen clock means "this is a screenshot", so the key hint must not land in the shot.
if(t !== null) document.getElementById("hint")?.remove();

const seed = params.has("seed") ? (parseInt(params.get("seed"), 10) | 0) : undefined;
const sunAz = params.has("sunaz") ? parseFloat(params.get("sunaz")) : undefined;
const sunEl = params.has("sunel") ? parseFloat(params.get("sunel")) : undefined;

const {pixelTune} = await import("../../src/render/pipelines/pixel.js");
const {startTestScene} = await import("./scene.js");
const {PIXEL_PRESET} = await import("./preset.js");

// Any query param named after a pixelTune knob overrides the preset — this is how the proof shots
// are taken (&clouds=0, &rays=0, &pixelScale=0). Typed against the preset/default so "0" becomes
// false for a boolean knob and 0 for a numeric one.
const RESERVED = new Set(["t", "seed", "sunaz", "sunel", "props", "ortho", "yaw", "pitch"]);
const tuneOverrides = {};
for(const [key, raw] of params){
  if(RESERVED.has(key)) continue;
  if(!(key in pixelTune)){ console.warn(`[test-scene] ignoring unknown param "${key}"`); continue; }
  const ref = key in PIXEL_PRESET ? PIXEL_PRESET[key] : pixelTune[key];
  if(typeof ref === "boolean") tuneOverrides[key] = raw !== "0" && raw !== "false";
  else if(typeof ref === "number") tuneOverrides[key] = parseFloat(raw);
  else tuneOverrides[key] = raw;
}

// Camera experiments: ?ortho=1 (true orthographic at the same framing), ?yaw=45 (orbit),
// ?pitch=35.26 — ortho+yaw 45+pitch 35.26 together are classic isometric.
const {CAMERA} = await import("./preset.js");
if(params.has("pitch")) CAMERA.pitchDeg = parseFloat(params.get("pitch"));
const testScene = startTestScene({
  canvas: document.getElementById("c"), seed, tuneOverrides, sunAz, sunEl,
  noProps: params.get("props") === "0",   // yardstick only — see scene.js
  ortho: params.get("ortho") === "1",
  yawDeg: params.has("yaw") ? parseFloat(params.get("yaw")) : 0,
});
window.__testScene = testScene;

// Interactive sessions get the camera panel + mouse orbit/pan/zoom (same control set as the
// game's view panel). Screenshot runs (?t= frozen) skip it entirely: no panel pixels in a shot,
// and the pose stays exactly what the URL authored.
if(t === null){
  const {attachCameraControls} = await import("./camera-controls.js");
  attachCameraControls({api: testScene, canvas: document.getElementById("c")});
}

// Ready = the pixel pipeline is live and a few frames have landed (the first frame allocates the
// low-res target and the shadow map; the cloud plane appears on the frame after that).
// If pixel got benched the registry falls back to "current" — surface that instead of hanging, so
// the harness reports a broken page rather than timing out with no clue.
const READY_FRAMES = 6;
(function waitReady(){
  if(testScene.pipeline() === "pixel" && testScene.framesRendered() >= READY_FRAMES){
    window.__ready = true;
    return;
  }
  if(testScene.framesRendered() > 240){
    window.__pipelineError = `pipeline stuck on "${testScene.pipeline()}"`;
    window.__ready = true;
    return;
  }
  requestAnimationFrame(waitReady);
})();
