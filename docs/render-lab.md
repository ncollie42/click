# The Render Lab — workflow for visual R&D

How a technique goes from "saw it in a video" to "shipped in the game", as practiced Aug 17-19
2026. This is the renderer-side sibling of docs/gauntlet.md (which owns MODEL quality loops).

## The pipeline of a technique

```
video/repo ─► transcript ─► INSPECT ─► AUDITION ─► VERIFY ─► JUDGE ─► owner gate ─► INTEGRATE
             (yt-dlp)      (map onto   (in the     (boot     (cold,                (contracts +
                            codebase)   right       harness,  tough,                validator +
                                        venue)      headless) measured)             re-judge)
```

1. **Transcript, not vibes.** `scratchpad/yt-dlp --js-runtimes node --skip-download
   --write-auto-subs` pulls the auto-subs; strip VTT to text. Repos: shallow-clone and read the
   actual shader source. Media downloads 403 without impersonation deps — transcripts don't.
2. **Inspect before implementing.** A read-only agent maps each technique onto THIS codebase:
   what exists already (name the file), what's new, where it slots, what to verify. The inspect
   report is the implementation brief. Techniques that assume a free camera or per-material
   engine hooks usually need adapting — say so before code is written.
3. **Audition in the right venue — never in the shipped game:**
   | kind | venue | examples |
   |---|---|---|
   | screen-space look | a PIPELINE in src/render/pipelines/ (registry: F9/R/B) | retro, toon |
   | water treatment | map-editor water mode (tools/map-editor/water-modes.js) | depth foam, voyage |
   | model/foliage | model-viewer module (MODELS registry + snap.mjs) | gauntlet casts, leaf cards |
   | scene feature | behind a tune flag, default off | normal edges, cloud shadows |
4. **Verify headless, always the same three gates:** `node --check` every file; mechanical
   uniform/spec cross-checks for GLSL; a seeded boot via the harness pattern (serve repo, chrome
   from repo's node_modules, seeded Math.random, zero pageerrors AND zero `[pipeline]` bench
   lines, screenshot). scripts/validate.mjs must stay green whenever sim files are touched.
   GLSL "compiles in my head" is not a gate — the boot screenshot is.
5. **Judge cold and tough.** Fresh agent per round, never the builder, measurements over
   adjectives, reference art is law, verdict + numbered fix list tagged structural/paint/taste.
   Loop on structural, STOP on taste — the owner is the finish line. (Full judging protocol:
   docs/gauntlet.md.) codex CLI can serve as an extra independent critic on the code itself.
6. **Owner gate.** Screenshots + verdicts land in the showcase artifact and the round logs;
   nico picks. Nothing integrates without it (the Aug-18 model integration was itself gated).
7. **Integrate with contracts.** Keep signatures/userData stable, adapt colours through the
   MEASURED game rig (the world is 6.7x darker in linear than the viewer — relightForGame in
   models.js), swap audition-only machinery for house systems (module ink → outline shells),
   then validator agent + full harness re-run.

## Standing infrastructure

- **Registry** src/render/pipelines/index.js — F9 cycles, R panel (active section only, perf
  meter, presets A/B, copy-json, typeable values), B blinks the last two pipelines. Same panel
  works in the map editor.
- **Boot matrix** scratchpad/showcase-matrix.mjs pattern — one seeded world, one screenshot per
  renderer config; the raw material for judging and the showcase.
- **Showcase artifact** ("The Click Render Lab") — updated in place after every wave; it is the
  running record nico reviews.
- **Round logs** live next to the shots (tools/shots/*/ROUND-LOG.md); memory files carry only
  pointers + laws.

## Failure modes already paid for (don't re-buy)

- Opus 529 outage windows: back off 30 min and RESUME agents (SendMessage) rather than respawning;
  builders lose nothing if resumed. Judge rounds can be done by the orchestrator in a pinch —
  log the blindness deviation.
- Two agents, one file = corruption risk: partition ownership per agent, sequence same-file work
  (oceans waits for the voyage water agent).
- Playwright default screenshot timeout dies on single-digit-FPS pipelines — pass timeout:90000.
- Quantize/band in DISPLAY space; author display targets; never trust authored hex through a rig.
