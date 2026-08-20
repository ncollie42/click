// Owns: the renderer debug window — a floating panel of sliders over retroTune / toonTune /
// pixelTune plus the pipeline switch. Toggled with R (wired in pipelines/index.js, which
// lazy-imports this file on the first press, so the game's load path never pays for it).
// Everything here is DOM the panel itself creates; it never touches the game canvas, the
// view-debugger, or scene.js. The tune objects are live-read by the pipelines every frame, so a
// slider drag is visible on the next rendered frame with no plumbing — this panel just writes
// numbers into them.
//
// Layout: one column per concern — pipeline radios up top (kept in sync with F9 via a poll while
// the panel is open), then a section per pipeline. Each section header shows a dot when its
// pipeline is the active one. Reset buttons restore the values captured at first open.

import {retroTune} from "./retro.js";
import {toonTune, PANEL_SPEC as TOON_SPEC} from "./toon.js";
import {pixelTune, PANEL_SPEC as PIXEL_SPEC} from "./pixel.js";

// [key, label, min, max, step] for sliders; ["key", label] for checkboxes; selects carry options.
const RETRO_SLIDERS = [
  ["targetHeight",   "target height px", 64, 1080, 4],
  ["pixelScale",     "pixel scale (0=off)", 0, 1, 0.05],
  ["bands",          "posterize bands", 2, 64, 1],
  ["outlineStrength","outline strength", 0, 4, 0.25],
  ["depthEdge",      "silhouette thresh", 0.0001, 0.02, 0.0001],
  ["creaseThreshold","crease thresh", 0, 1, 0.01],
  ["creaseStrength", "crease strength", 0, 4, 0.25],
  ["edgeHighlight",  "edge highlight (nrm)", 0, 4, 0.25],
  ["normalThreshold","normal thresh", 0.01, 1, 0.01],
];
const RETRO_CHECKS = [
  ["posterize","posterize"], ["outlines","outlines"], ["creases","creases"], ["snap","camera snap"],
  ["normalEdges","normal edges (hello-threejs)"],
];

const CSS = `
#rpDebug{position:fixed;top:12px;right:12px;z-index:10000;width:min(620px,calc(100vw - 24px));
  max-height:calc(100vh - 24px);
  overflow-y:auto;overflow-x:hidden;background:#0f1318fa;color:#cfd8e3;font:11px/1.5 monospace;
  border:1px solid #2a3542;
  border-radius:6px;padding:10px 12px;box-shadow:0 4px 24px #000a}
/* Two-column knob layout so a whole section fits on screen without scrolling; the header,
   checkbox row and preset row span both columns. Falls back to one column on narrow viewports. */
#rpDebug .sect{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:14px}
#rpDebug .sect h4,#rpDebug .sect .checks{grid-column:1/-1}
@media (max-width:660px){#rpDebug .sect{grid-template-columns:1fr}}
#rpDebug h3{margin:0 0 6px;font-size:12px;color:#fff;display:flex;justify-content:space-between;align-items:center}
#rpDebug h4{margin:10px 0 4px;font-size:11px;color:#8fb4ff;border-bottom:1px solid #2a3542;
  padding-bottom:2px;display:flex;justify-content:space-between;align-items:center}
#rpDebug h4 .dot{color:#5f6;display:none}
#rpDebug .active h4 .dot{display:inline}
#rpDebug .row{display:flex;align-items:center;gap:6px;margin:2px 0;min-width:0}
#rpDebug .row label{flex:0 0 122px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* width + min-width:0 on every control: form elements have a large intrinsic minimum
   (~177px for a text input) that flex-basis alone cannot shrink past — without these the
   readouts blow out their grid cell, overlap the neighbour column and force the panel to
   scroll sideways. */
#rpDebug .row input[type=range]{flex:1 1 60px;width:60px;min-width:0;accent-color:#8fb4ff}
#rpDebug .row input.val{flex:0 0 64px;width:64px;min-width:0;text-align:right;color:#9fe8a8;
  background:#1a2028;border:1px solid #2a3542;border-radius:3px;font:inherit;padding:0 3px}
#rpDebug .row select{flex:1 1 60px;width:60px;min-width:0;background:#1a2028;color:#cfd8e3;
  border:1px solid #2a3542;font:inherit}
#rpDebug .grp{grid-column:1/-1;margin:8px 0 1px;padding-bottom:1px;color:#8fb4ff;
  border-bottom:1px solid #222c38;font-size:10px;letter-spacing:.06em}
#rpDebug .checks{display:flex;flex-wrap:wrap;gap:2px 10px;margin:3px 0;grid-column:1/-1}
#rpDebug .checks label{display:flex;gap:4px;align-items:center;cursor:pointer}
#rpDebug .pipes{display:flex;flex-wrap:wrap;gap:4px 10px;margin:2px 0 4px}
#rpDebug .pipes label{display:flex;gap:4px;align-items:center;cursor:pointer;color:#fff}
#rpDebug button{background:#1a2028;color:#9ab;border:1px solid #2a3542;border-radius:3px;
  font:10px monospace;cursor:pointer;padding:1px 7px}
#rpDebug button:hover{color:#fff}
#rpDebug .hint{color:#5a6a7a;margin-top:6px}`;

function fmt(v){ return Math.abs(v) >= 100 ? String(Math.round(v)) : String(+v.toFixed(4)); }

/** Built once by createPanel(); everything else is closure state inside it. */
export function createPanel({setPipeline, getPipelineName}){
  // structuredClone, not spread: toonTune.palette is an ARRAY — a shallow copy would share it and
  // an in-place palette edit would silently corrupt the "default" that reset restores (codex catch).
  const defaults = structuredClone({retro: retroTune, toon: toonTune, pixel: pixelTune});
  // Shadow DOM, not a bare div: the game's stylesheet has GLOBAL tag rules (styles.css
  // `button{width:100%;padding:7px;...}`, dark input colors) that mangled the panel when it lived
  // in the light DOM — stretched buttons, invisible readout text. The shadow boundary keeps both
  // worlds honest: game CSS can't reach in, panel CSS can't leak out.
  const host = document.createElement("div");
  host.id = "rpDebugHost";
  const shadow = host.attachShadow({mode: "open"});
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.id = "rpDebug";
  root.style.display = "none";
  shadow.appendChild(root);
  document.body.appendChild(host);

  const head = document.createElement("h3");
  head.innerHTML = `<span>renderer</span>`;
  // Live frame meter: rAF deltas, rolling 30-frame average, only while the panel is open. This is
  // the page's real frame time — the number that judges a pipeline's cost claim.
  const perf = document.createElement("span");
  perf.style.cssText = "color:#9ab;font-weight:normal;font-size:11px;margin-left:8px";
  head.querySelector("span").appendChild(perf);
  const close = document.createElement("button");
  close.textContent = "×";
  close.addEventListener("click", ()=>toggle(false));
  head.appendChild(close);
  root.appendChild(head);

  let perfRaf = 0, perfLast = 0, perfAvg = 16.7;
  function perfTick(t){
    if(perfLast) perfAvg += ((t - perfLast) - perfAvg) / 30;
    perfLast = t;
    perf.textContent = ` ${perfAvg.toFixed(1)}ms · ${(1000/perfAvg).toFixed(0)}fps`;
    perfRaf = requestAnimationFrame(perfTick);
  }

  // ── pipeline radios ──
  const pipes = document.createElement("div");
  pipes.className = "pipes";
  const radios = {};
  for(const name of ["current","retro","toon","pixel"]){
    const l = document.createElement("label");
    const r = document.createElement("input");
    r.type = "radio"; r.name = "rpPipe"; r.value = name;
    r.addEventListener("change", async ()=>{ if(r.checked){ await setPipeline(name); sync(); } });
    radios[name] = r;
    l.append(r, name);
    pipes.appendChild(l);
  }
  root.appendChild(pipes);

  const sections = {};   // name -> its wrapper <div>; only the ACTIVE pipeline's section shows

  function section(title, tune, sliders, checks, selects){
    // Everything for one pipeline lives in one wrapper so sync() can show exactly the active
    // pipeline's knobs and nothing else — the stacked all-three view was unusable noise.
    const box = document.createElement("div");
    box.className = "sect";
    root.appendChild(box);
    sections[title] = box;
    const rootAppend = el => box.appendChild(el);
    const h = document.createElement("h4");
    h.innerHTML = `<span>${title} <span class="dot">●</span></span>`;
    const reset = document.createElement("button");
    reset.textContent = "reset";
    h.appendChild(reset);
    rootAppend(h);

    const outs = [];   // refresh closures, so reset/sync can repaint controls from the tune
    for(const entry of sliders){
      // A bare string in the sliders list is a group header spanning both panel columns —
      // pixel's spec uses these to give clouds/outlines/quantize their own sections.
      if(typeof entry === "string"){
        const g = document.createElement("div");
        g.className = "grp"; g.textContent = entry;
        rootAppend(g);
        continue;
      }
      const [key, label, min, max, step] = entry;
      const row = document.createElement("div"); row.className = "row";
      const l = document.createElement("label"); l.textContent = label; l.title = key;
      const s = document.createElement("input");
      s.type = "range"; s.min = min; s.max = max; s.step = step; s.value = tune[key];
      // The readout is itself an input: type an exact value (sliders can't hit 0.000226) and the
      // slider follows. `change` not `input`, so half-typed numbers don't fight the tune.
      const o = document.createElement("input"); o.className = "val"; o.value = fmt(tune[key]);
      s.addEventListener("input", ()=>{ tune[key] = +s.value; o.value = fmt(+s.value); });
      o.addEventListener("change", ()=>{ const v = +o.value; if(isFinite(v)){ tune[key] = v; s.value = v; } });
      // shadow.activeElement, not document's — inside a shadow root the document only sees the host.
      outs.push(()=>{ s.value = tune[key]; if(shadow.activeElement !== o) o.value = fmt(tune[key]); });
      row.append(l, s, o);
      rootAppend(row);
    }
    const checksBox = document.createElement("div"); checksBox.className = "checks";
    for(const [key, label] of checks){
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox"; c.checked = !!tune[key];
      c.addEventListener("change", ()=>{ tune[key] = c.checked; });
      outs.push(()=>{ c.checked = !!tune[key]; });
      l.append(c, label);
      checksBox.appendChild(l);
    }
    rootAppend(checksBox);
    for(const [key, label, options] of selects || []){
      const row = document.createElement("div"); row.className = "row";
      const l = document.createElement("label"); l.textContent = label; l.title = key;
      const sel = document.createElement("select");
      for(const opt of options){
        const [value, text] = Array.isArray(opt) ? opt : [opt, String(opt)];
        const el = document.createElement("option");
        el.value = value; el.textContent = text;
        sel.appendChild(el);
      }
      sel.value = tune[key];
      sel.addEventListener("change", ()=>{ tune[key] = +sel.value; });
      outs.push(()=>{ sel.value = tune[key]; });
      row.append(l, sel);
      rootAppend(row);
    }
    reset.addEventListener("click", ()=>{
      Object.assign(tune, defaults[title]);
      for(const refresh of outs) refresh();
    });

    // Preset slots: two saved tunings per pipeline (localStorage), for A/B-ing looks WITHIN a
    // pipeline the way the B key A/Bs across pipelines. Save stores the current knobs; the slot
    // button recalls them. `copy` puts the tune JSON on the clipboard for sharing/committing.
    const presets = document.createElement("div"); presets.className = "checks";
    for(const slot of ["A", "B"]){
      const save = document.createElement("button");
      save.textContent = "save " + slot;
      save.addEventListener("click", ()=>{
        try{ localStorage.setItem(`rpPreset.${title}.${slot}`, JSON.stringify(tune)); }
        catch{ save.textContent = "storage off"; setTimeout(()=>{ save.textContent = "save " + slot; }, 1200); return; }
        save.textContent = "saved"; setTimeout(()=>{ save.textContent = "save " + slot; }, 900);
      });
      const load = document.createElement("button");
      load.textContent = slot;
      load.addEventListener("click", ()=>{
        let raw = null;
        try{ raw = localStorage.getItem(`rpPreset.${title}.${slot}`); }catch{ /* blocked storage */ }
        if(!raw) return;
        try{ Object.assign(tune, JSON.parse(raw)); for(const refresh of outs) refresh(); }
        catch{ /* stale preset */ }
      });
      presets.append(save, load);
    }
    const copy = document.createElement("button");
    copy.textContent = "copy json";
    copy.addEventListener("click", ()=>{
      navigator.clipboard?.writeText(JSON.stringify(tune, null, 2));
      copy.textContent = "copied"; setTimeout(()=>{ copy.textContent = "copy json"; }, 900);
    });
    presets.appendChild(copy);
    rootAppend(presets);
    return outs;
  }

  const retroOuts = section("retro", retroTune, RETRO_SLIDERS, RETRO_CHECKS);
  // toon and pixel ship their own panel descriptions — consumed as-is.
  const toonOuts = section("toon", toonTune, TOON_SPEC.sliders, TOON_SPEC.checks, TOON_SPEC.selects);
  const pixelOuts = section("pixel", pixelTune, PIXEL_SPEC.sliders, PIXEL_SPEC.checks, PIXEL_SPEC.selects);

  // Shown instead of a section when the untuned "current" pipeline is active.
  const noKnobs = document.createElement("div");
  noKnobs.className = "hint";
  noKnobs.textContent = "current = the stock renderer — no knobs";
  root.appendChild(noKnobs);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "R toggles · F9 cycles · B blinks last two · type exact values in the readouts";
  root.appendChild(hint);

  // F9 and the radios both change the pipeline; a cheap poll while open keeps them agreeing, and
  // also repaints sliders if something (console, another tab of knobs) wrote the tunes directly.
  let pollTimer = 0;
  function sync(){
    const name = getPipelineName();
    if(radios[name] && !radios[name].checked) radios[name].checked = true;
    // Only the active pipeline's knobs are shown; the others' state persists hidden.
    for(const [key, box] of Object.entries(sections)){
      // "" (not "block") so the .sect grid rule from the stylesheet applies when visible.
      box.style.display = key === name ? "" : "none";
      box.classList.toggle("active", key === name);
    }
    noKnobs.style.display = name === "current" ? "block" : "none";
    for(const refresh of retroOuts) refresh();
    for(const refresh of toonOuts) refresh();
    for(const refresh of pixelOuts) refresh();
  }

  function toggle(force){
    const show = force !== undefined ? force : root.style.display === "none";
    root.style.display = show ? "block" : "none";
    clearInterval(pollTimer);
    cancelAnimationFrame(perfRaf); perfLast = 0;
    if(show){ sync(); pollTimer = setInterval(sync, 500); perfRaf = requestAnimationFrame(perfTick); }
  }

  return {toggle};
}
