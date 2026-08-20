// Owns: the test scene's interactive camera — the same control set as the game's view panel
// (pitch / detent yaw / zoom / fov / orthographic / isometric preset) plus direct mouse control
// on the canvas. Interactive sessions only: boot.js skips this module entirely when ?t= freezes
// time, so screenshots stay byte-stable and panel-free.
//
// Consumes scene.js's api surface: {pose, placeCamera, setOrtho} — this module mutates the pose,
// scene.js's frame loop re-places the camera from it every frame.
//
// Yaw behaves like the game's slider (view-debugger.js "yaw detents"): the slider LOCKS to the
// 8 compass spots (every 45°) and the camera GLIDES there (~220ms cubic ease-out, shortest arc).
// Mouse orbit is free while dragging; releasing snaps-and-glides to the nearest detent.

const YAW_DETENT = 45, YAW_TWEEN_MS = 220;
const snapYaw = v => {
  let s = Math.round(v / YAW_DETENT) * YAW_DETENT;
  while(s > 180) s -= 360;
  while(s < -180) s += 360;
  return s;
};

export function attachCameraControls({api, canvas}){
  const {pose} = api;
  let yawTweenId = 0;
  function tweenYawTo(target){
    cancelAnimationFrame(yawTweenId); yawTweenId = 0;
    const from = pose.yaw;
    const delta = ((target - from + 540) % 360) - 180;
    if(Math.abs(delta) < 0.5){ pose.yaw = target; sync(); return; }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min((now - t0) / YAW_TWEEN_MS, 1);
      pose.yaw = from + delta * (1 - Math.pow(1 - k, 3));
      sync();
      if(k < 1) yawTweenId = requestAnimationFrame(step);
      else { yawTweenId = 0; pose.yaw = target; sync(); }
    };
    yawTweenId = requestAnimationFrame(step);
  }

  // ── panel ──
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;top:10px;left:10px;z-index:20;background:#141712e6;" +
    "color:#cfd6c4;font:11px/1.5 monospace;padding:10px 12px;border:1px solid #343b30;" +
    "border-radius:6px;user-select:none;width:200px";
  box.innerHTML = `
    <b style="color:#e8e3b6">camera</b> <span style="float:right;cursor:pointer" data-x>×</span>
    ${["pitch", "yaw", "dist", "fov"].map(k => `
      <label style="display:block;margin-top:6px">${k} <span data-o="${k}" style="float:right"></span>
        <input data-k="${k}" type="range" style="width:100%" autocomplete="off"></label>`).join("")}
    <label style="display:block;margin-top:6px"><input data-k="ortho" type="checkbox" autocomplete="off"> orthographic</label>
    <button data-iso type="button" style="margin-top:8px;width:100%;font:inherit;cursor:pointer">isometric</button>
    <div style="margin-top:6px;color:#7b8471">drag orbit · shift-drag pan · wheel zoom</div>`;
  document.body.appendChild(box);
  const RANGES = {pitch: [15, 89, 1], yaw: [-180, 180, YAW_DETENT], dist: [80, 420, 5], fov: [5, 70, 0.25]};
  const inputs = {};
  for(const el of box.querySelectorAll("input[data-k]")){
    const k = el.dataset.k;
    inputs[k] = el;
    if(el.type === "range"){ const [lo, hi, st] = RANGES[k]; el.min = lo; el.max = hi; el.step = st; }
  }
  box.querySelector("[data-x]").onclick = () => box.remove();
  box.querySelector("[data-iso]").onclick = () => {
    pose.pitch = 35.264; api.setOrtho(true); tweenYawTo(45); sync();
  };
  inputs.pitch.oninput = () => { pose.pitch = +inputs.pitch.value; sync(); };
  inputs.yaw.oninput = () => tweenYawTo(snapYaw(+inputs.yaw.value));
  inputs.dist.oninput = () => { pose.dist = +inputs.dist.value; sync(); };
  inputs.fov.oninput = () => { pose.fov = +inputs.fov.value; sync(); };
  inputs.ortho.onchange = () => { api.setOrtho(inputs.ortho.checked); sync(); };

  /** One writer for widget/readout state; pose is the only truth. */
  function sync(){
    if(!box.isConnected) return;
    inputs.pitch.value = pose.pitch; inputs.yaw.value = snapYaw(pose.yaw);
    inputs.dist.value = pose.dist; inputs.fov.value = pose.fov;
    inputs.ortho.checked = pose.ortho;
    const o = k => box.querySelector(`[data-o="${k}"]`);
    o("pitch").textContent = Math.round(pose.pitch) + "°";
    o("yaw").textContent = Math.round(pose.yaw) + "°";
    o("dist").textContent = Math.round(pose.dist) + " wu";
    o("fov").textContent = pose.fov.toFixed(1) + "°";
  }
  sync();

  // ── mouse on the canvas ──
  // Left-drag orbits (free while held; release glides to the nearest yaw detent). Shift- or
  // middle-drag pans the TARGET across the ground plane in view-relative axes. Wheel dollies
  // `dist`, which is also the ortho zoom (halfH is derived from it in scene.js).
  let drag = null;   // {mode:"orbit"|"pan", x, y}
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", e => {
    drag = {mode: (e.button === 1 || e.shiftKey) ? "pan" : "orbit", x: e.clientX, y: e.clientY};
    cancelAnimationFrame(yawTweenId); yawTweenId = 0;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", e => {
    if(!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if(drag.mode === "orbit"){
      pose.yaw = ((pose.yaw - dx * 0.25 + 540) % 360) - 180;
      pose.pitch = Math.max(15, Math.min(89, pose.pitch + dy * 0.25));
    }else{
      const yaw = pose.yaw * Math.PI / 180;
      const s = pose.dist / 500;               // px -> wu, scaled with zoom so panning feels flat
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);   // screen-right on the ground
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);  // screen-up on the ground
      pose.target[0] -= (dx * rx - dy * fx) * s;
      pose.target[2] -= (dx * rz - dy * fz) * s;
    }
    sync();
  });
  const endDrag = () => {
    if(drag?.mode === "orbit") tweenYawTo(snapYaw(pose.yaw));
    drag = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    pose.dist = Math.max(80, Math.min(420, pose.dist * Math.exp(e.deltaY * 0.001)));
    sync();
  }, {passive: false});
}
