// Owns: the test scene's DIRECT camera input (drag orbit, shift/middle-drag pan, wheel zoom) and
// the floating TOON RAMP editor. Interactive sessions only: boot.js skips this module when ?t=
// freezes time, so screenshots stay byte-stable and panel-free.
//
// The camera/sun SLIDERS used to live here too; they moved into the shared R panel (owner call,
// Aug 20) — debug-panel.js renders them from the poseControls adapter this scene hands to
// configurePipelines, so the game and the test scene share one camera UI. The panel's 500ms
// refresh poll picks up mouse-driven pose changes on its own; nothing here talks to it.
//
// Consumes scene.js's api surface: {pose, gradientMap, toon} — this module mutates the pose,
// scene.js's frame loop re-places the camera from it every frame.
//
// Yaw matches the game's slider law (view-debugger.js "yaw detents"): free while dragging,
// releasing snaps-and-glides to the nearest of the 8 compass spots (~220ms cubic ease-out).

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
    if(Math.abs(delta) < 0.5){ pose.yaw = target; return; }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min((now - t0) / YAW_TWEEN_MS, 1);
      pose.yaw = from + delta * (1 - Math.pow(1 - k, 3));
      if(k < 1) yawTweenId = requestAnimationFrame(step);
      else { yawTweenId = 0; pose.yaw = target; }
    };
    yawTweenId = requestAnimationFrame(step);
  }

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
  }, {passive: false});

  // ── toon ramp editor (round 5) ──
  // Live gradient-map editing. The authored 32-texel map decodes into RUNS (band levels) and the
  // edges between them; sliders rewrite the texture's Uint8Array IN PLACE (+ needsUpdate), so a
  // drag lands on the next frame without touching any material. Only the LIT half (dotNL >= 0)
  // is editable — the lower half stays authored zeros. Hidden when the ramp is off (?toon=0).
  // Stays a floating box (not the R panel): it is test-scene-only until the game adopts the ramp.
  if(!(api.toon && api.gradientMap)) return;
  const tex = api.gradientMap;
  const steps = tex.image.width, half = steps / 2;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;top:10px;left:10px;z-index:20;background:#141712e6;" +
    "color:#cfd6c4;font:11px/1.5 monospace;padding:10px 12px;border:1px solid #343b30;" +
    "border-radius:6px;user-select:none;width:200px";
  box.innerHTML = `<b style="color:#e8e3b6">toon ramp</b> <span style="float:right;cursor:pointer" data-x>×</span>
    <div data-ramp style="display:flex;height:12px;border:1px solid #343b30;border-radius:3px;overflow:hidden;margin:5px 0"></div>
    <div data-rows></div>
    <div style="margin-top:6px;color:#7b8471">drag orbit · shift-drag pan · wheel zoom · camera in R panel</div>`;
  document.body.appendChild(box);
  box.querySelector("[data-x]").onclick = () => box.remove();
  const rampStrip = box.querySelector("[data-ramp]");
  const rows = box.querySelector("[data-rows]");

  // Decode runs from the authored lit half: [{level, start}] where start is a lit-texel index.
  const runs = [];
  for(let i = 0; i < half; i++){
    const v = tex.image.data[half + i] / 255;
    if(!runs.length || Math.abs(v - runs[runs.length - 1].level) > 1e-3) runs.push({level: v, start: i});
  }
  function paintRamp(){
    rampStrip.textContent = "";
    for(let i = 0; i < half; i++){
      const c = document.createElement("div");
      const v = tex.image.data[half + i];
      c.style.cssText = `flex:1;background:rgb(${v},${v},${v})`;
      c.title = `dotNL ${(i / half).toFixed(2)}–${((i + 1) / half).toFixed(2)} → ${(v / 255).toFixed(3)}`;
      rampStrip.appendChild(c);
    }
  }
  const applyRamp = () => {
    for(let i = 0; i < half; i++){
      let band = runs[0];
      for(const r of runs) if(i >= r.start) band = r;
      tex.image.data[half + i] = Math.round(Math.max(0, Math.min(1, band.level)) * 255);
    }
    tex.needsUpdate = true;
    paintRamp();
  };
  const NAMES = ["terminator", "anchor", "mid", "crown"];
  runs.forEach((run, i) => {
    const lab = document.createElement("label");
    lab.style.cssText = "display:block;margin-top:4px";
    lab.innerHTML = `${NAMES[i] || "band " + i} <span style="float:right" data-o></span>
      <input type="range" min="0" max="1" step="0.005" style="width:100%" autocomplete="off">`;
    const inp = lab.querySelector("input"), out = lab.querySelector("[data-o]");
    inp.value = run.level; out.textContent = run.level.toFixed(3);
    inp.oninput = () => { run.level = +inp.value; out.textContent = run.level.toFixed(3); applyRamp(); };
    rows.appendChild(lab);
    if(i > 0){
      // Edge slider between band i-1 and i, in dotNL, snapped to the texel grid.
      const el = document.createElement("label");
      el.style.cssText = "display:block;margin-top:2px;color:#7b8471";
      el.innerHTML = `└ edge (dotNL) <span style="float:right" data-o></span>
        <input type="range" min="${1 / half}" max="${1 - 1 / half}" step="${1 / half}" style="width:100%" autocomplete="off">`;
      const einp = el.querySelector("input"), eout = el.querySelector("[data-o]");
      einp.value = run.start / half; eout.textContent = (run.start / half).toFixed(3);
      einp.oninput = () => {
        // Keep edges ordered: this band must start after the previous and before the next.
        const lo = (runs[i - 1].start + 1), hi = (runs[i + 1] ? runs[i + 1].start - 1 : half - 1);
        run.start = Math.max(lo, Math.min(hi, Math.round(+einp.value * half)));
        einp.value = run.start / half; eout.textContent = (run.start / half).toFixed(3);
        applyRamp();
      };
      rows.appendChild(el);
    }
  });
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "copy TOON levels";
  copyBtn.style.cssText = "margin-top:6px;width:100%;font:inherit;cursor:pointer";
  copyBtn.onclick = () => {
    const levels = [...tex.image.data].map(v => +(v / 255).toFixed(4));
    navigator.clipboard?.writeText(JSON.stringify({steps, levels}));
    copyBtn.textContent = "copied — paste into preset.js TOON";
    setTimeout(() => { copyBtn.textContent = "copy TOON levels"; }, 1400);
  };
  rows.appendChild(copyBtn);
  paintRamp();
}
