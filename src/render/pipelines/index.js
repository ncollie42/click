// Owns: the render-pipeline registry and the active-pipeline switch. scene.js hands this module a
// context once (configurePipelines) and routes its per-frame draw through renderFrame(); nothing
// here reaches back into scene.js, so there are no import cycles — pipeline modules are loaded
// lazily on first activation.
//
// Pipeline contract (what retro.js / splat.js must export as default):
//   {
//     name: string,
//     init(ctx)?     — once, on first activation. May allocate targets/materials.
//     render(ctx)    — draw one full frame to the default framebuffer. Required.
//     resize(ctx,w,h)? — drawing-buffer size changed (w/h in device px).
//     dispose(ctx)?  — switched away; free GPU resources. May be re-init'ed later.
//   }
// ctx = {THREE, renderer, scene, getCamera(), getSun(), waterPrePass(), view}
//   - getCamera() returns the live camera (persp/ortho swap at runtime; never cache it).
//   - waterPrePass(w?,h?) fills the water depth texture; call it before any pass that renders the
//     scene's water material, or the water shader samples a stale/undefined depth buffer. When
//     rendering the scene into an offscreen target, pass that target's size so the water shader's
//     screen-space UVs (gl_FragCoord/uResolution) stay aligned.
//   - Pipelines own their offscreen targets and must leave renderer state (render target,
//     override material, camera layers, shadowMap.autoUpdate) restored on return.
//
// Switching: F9 cycles current → retro → splat. Persisted in localStorage "click.pipeline" so a
// reload keeps the chosen pipeline. A pipeline that throws during init/render is benched (falls
// back to "current") instead of black-screening the game.

const PIPELINES = ["current", "retro", "toon", "splat", "full"];
const STORAGE_KEY = "click.pipeline";
// Blocked storage (private browsing, quota) must never take the renderer down with it — codex
// review caught all three call sites throwing into init, setPipeline and the bench-recovery path.
const storageGet = k => { try{ return localStorage.getItem(k); }catch{ return null; } };
const storageSet = (k, v) => { try{ localStorage.setItem(k, v); }catch{ /* renderer > persistence */ } };

let ctx = null;
let activeName = "current";
let previousName = null;    // the pipeline before the last switch — the B-key blink target
let active = null;          // loaded pipeline object for activeName ("current" keeps null)
let loading = false;
const benched = new Set();  // pipelines that threw; skipped when cycling until reload

function loaderFor(name){
  if(name === "retro") return import("./retro.js");
  if(name === "toon") return import("./toon.js");
  if(name === "splat") return import("./splat.js");
  if(name === "full") return import("./full.js");
  return null;
}

/** scene.js calls this once at module init, before the first frame. */
export function configurePipelines(context){
  ctx = context;
  const saved = storageGet(STORAGE_KEY);
  if(saved && PIPELINES.includes(saved) && saved !== "current") setPipeline(saved);
  window.addEventListener("keydown", e => {
    if(e.key === "F9"){
      e.preventDefault();
      let i = PIPELINES.indexOf(activeName);
      for(let step = 1; step <= PIPELINES.length; step++){
        const next = PIPELINES[(i + step) % PIPELINES.length];
        if(!benched.has(next)){ setPipeline(next); return; }
      }
      return;
    }
    // R toggles the renderer debug window (sliders over retroTune/splatTune + pipeline switch).
    // Lazy import: the panel (and both pipeline modules it reads the tunes from) load on first use.
    if(e.code === "KeyR" && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
       && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")){
      togglePanel();
    }
    // B blink-compares: flips between the active pipeline and the previous one, for A/B judging.
    if(e.code === "KeyB" && !e.repeat && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
       && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")){
      if(previousName !== null && previousName !== activeName) setPipeline(previousName);
    }
  });
}

export function getPipelineName(){ return activeName; }

export async function setPipeline(name){
  if(!PIPELINES.includes(name) || loading) return;
  if(name === activeName) return;
  previousName = activeName;
  const old = active, oldName = activeName;
  // Fall back to direct rendering while the module loads.
  active = null; activeName = "current";
  try{ old?.dispose?.(ctx); }catch(err){ console.error(`[pipeline] ${oldName} dispose failed`, err); }
  if(old) old._inited = false;   // dispose freed its resources; re-activation must re-init
  if(name !== "current"){
    loading = true;
    try{
      const mod = await loaderFor(name);
      const pipe = mod.default;
      if(!pipe?.render) throw new Error(`pipeline "${name}" has no render()`);
      if(!pipe._inited){ pipe.init?.(ctx); pipe._inited = true; }
      active = pipe; activeName = name;
    }catch(err){
      console.error(`[pipeline] "${name}" failed to load/init — benched`, err);
      benched.add(name);
    }finally{ loading = false; }
  }
  storageSet(STORAGE_KEY, activeName);
  announce(activeName);
}

/** The per-frame draw scene.js delegates to. */
export function renderFrame(){
  if(active){
    try{ active.render(ctx); return; }
    catch(err){
      console.error(`[pipeline] "${activeName}" render threw — benched`, err);
      benched.add(activeName);
      try{ active.dispose?.(ctx); }catch{ /* already broken */ }
      active._inited = false;
      active = null; activeName = "current";
      storageSet(STORAGE_KEY, activeName);
      announce("current (fallback)");
    }
  }
  ctx.waterPrePass();
  ctx.renderer.render(ctx.scene, ctx.getCamera());
}

/** scene.js forwards drawing-buffer resizes here. */
export function resizePipeline(w, h){
  try{ active?.resize?.(ctx, w, h); }
  catch(err){ console.error(`[pipeline] "${activeName}" resize failed`, err); }
}

// The renderer debug window (debug-panel.js), created on the first R press.
let panel = null, panelLoading = false;
async function togglePanel(){
  if(panel){ panel.toggle(); return; }
  if(panelLoading) return;
  panelLoading = true;
  try{
    const mod = await import("./debug-panel.js");
    panel = mod.createPanel({setPipeline, getPipelineName});
    panel.toggle(true);
  }catch(err){ console.error("[pipeline] debug panel failed to load", err); }
  finally{ panelLoading = false; }
}

// Tiny transient badge so F9 gives visible feedback without touching the debugger UI.
let badge = null, badgeTimer = 0;
function announce(name){
  console.log(`[pipeline] active: ${name}`);
  if(!badge){
    badge = document.createElement("div");
    badge.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;"+
      "background:#000c;color:#fff;font:13px monospace;padding:4px 12px;border-radius:4px;pointer-events:none";
    document.body.appendChild(badge);
  }
  badge.textContent = `render: ${name}  (F9 cycles)`;
  badge.style.display = "block";
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(()=>{ badge.style.display = "none"; }, 2000);
}
