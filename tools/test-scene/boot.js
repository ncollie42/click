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
const {grassTune} = await import("../../src/render/grass.js");
const {startTestScene} = await import("./scene.js");
const {PIXEL_PRESET} = await import("./preset.js");

// Any query param named after a pixelTune knob overrides the preset — this is how the proof shots
// are taken (&clouds=0, &rays=0, &pixelScale=0). Typed against the preset/default so "0" becomes
// false for a boolean knob and 0 for a numeric one. grassTune knobs ride the same rule, handed to
// scene.js so they land AFTER preset.GRASS.tune and BEFORE the first geometry build (URL wins,
// and a ?density= shot is deterministic, not a 250ms-later rebuild); a name in BOTH tunes would
// go to pixelTune, so keep grass knob names distinct.
// "toon" is RESERVED (round 5): it is a MATERIAL-stage switch, not a pixelTune knob, so it must
// not fall through to the `key in pixelTune` test below. ?toon=0 -> stock Lambert everywhere.
// "grass" is RESERVED the same way: ?grass=0 removes the grass mesh entirely (A/B + yardstick
// shots), which no grassTune knob does.
const RESERVED = new Set(["t", "seed", "sunaz", "sunel", "props", "grass", "ortho", "yaw", "pitch", "toon"]);
const tuneOverrides = {}, grassOverrides = {};
for(const [key, raw] of params){
  if(RESERVED.has(key)) continue;
  const typed = (ref) => typeof ref === "boolean" ? (raw !== "0" && raw !== "false")
                       : typeof ref === "number" ? parseFloat(raw) : raw;
  if(key in pixelTune) tuneOverrides[key] = typed(key in PIXEL_PRESET ? PIXEL_PRESET[key] : pixelTune[key]);
  else if(key in grassTune) grassOverrides[key] = typed(grassTune[key]);
  else console.warn(`[test-scene] ignoring unknown param "${key}"`);
}

// Camera experiments: ?ortho=1 (true orthographic at the same framing), ?yaw=45 (orbit),
// ?pitch=35.26 — ortho+yaw 45+pitch 35.26 together are classic isometric.
const {CAMERA} = await import("./preset.js");
if(params.has("pitch")) CAMERA.pitchDeg = parseFloat(params.get("pitch"));
const testScene = startTestScene({
  canvas: document.getElementById("c"), seed, tuneOverrides, grassOverrides, sunAz, sunEl,
  noProps: params.get("props") === "0",   // yardstick only — see scene.js
  noGrass: params.get("grass") === "0",
  // ?toon=0 turns the material-stage ramp off (preset.TOON.enabled is the default). The A/B pair
  // full.png vs toon-off.png is the only thing that isolates the transfer function.
  ...(params.get("toon") !== null ? {toon: params.get("toon") !== "0"} : {}),
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
