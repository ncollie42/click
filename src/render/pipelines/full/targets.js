// Owns: every GPU buffer the full pipeline allocates, and the rules for re-allocating them when a
// tunable or the canvas size changes. Nothing else in this pipeline calls `new WebGL*RenderTarget`.
//
// LAYOUT — ONE 6x3 ATLAS INSTEAD OF AN 18-LAYER TEXTURE ARRAY.
// The reference (gbuffer.odin / lighting.odin / edge_mask.odin) keeps its G-buffers in a
// texture2DArray of TOTAL_LAYERS = 18 slices and renders MRT into one slice at a time. three r160
// cannot attach an array layer (or a cube face) as an MRT colour attachment — WebGLMultipleRenderTargets
// is a plain 2D multi-attachment FBO — so the 18 logical layers live side by side in one 2D texture:
//
//      col ->   face 0   face 1   face 2   face 3   face 4   face 5
//   row 0 eye   layer 0  layer 1  layer 2  layer 3  layer 4  layer 5
//   row 1 grid  layer 6  ...                                 layer 11
//   row 2 prev  layer 12 ...                                 layer 17
//
// so layer = probe * 6 + face sits at cell (layer % 6, layer / 6), which is exactly what
// layerOrigin() computes in full/glsl.js. Atlas size is probeSize*6 x probeSize*3 — 2304 x 1152 at
// the default probeSize 384. probeSize is clamped so the WIDE axis fits maxTextureSize.
//
// FORMATS — everything is RGBA8. The reference stores radial in R32F; three r160 builds every MRT
// attachment from one cloned texture descriptor, so one float attachment would drag the other two
// with it, and a float colour attachment adds an extension dependency for no benefit. Radial is
// packed into all four bytes instead (~2e-10 error over the near..far range). The packing is
// INVERTED (1 - radial) so the all-zero clear reads back as radial 1.0 — the "sky, no geometry"
// sentinel every downstream pass tests for. See full/glsl.js header note 2.
//
// DEPTH — one shared depth buffer for the whole atlas. Each of the 18 face renders is scissored to
// its own disjoint cell, so they cannot interfere; the atlas is depth-cleared once per frame instead
// of 18 times.
//
// NO PING-PONG. The sibling `splat` pipeline recycles the previous grid capture as its prev probe;
// this one does not. PROBE_PREV is a real probe with its own six layers, re-captured live from the
// old grid origin every frame, exactly as probe.odin/game.odin describe. That is the whole point of
// the "full" pipeline and it is why it costs 18 scene draws instead of 6.

import {NUM_FACES, NUM_PROBES, TOTAL_LAYERS} from "./probe.js";

export const ATLAS_COLS = NUM_FACES;    // 6
export const ATLAS_ROWS = NUM_PROBES;   // 3

export class Targets {
  constructor(THREE){
    this.THREE = THREE;
    this.probeSize = 0;
    this.gbuf = null;      // WebGLMultipleRenderTargets: 0 albedo+id, 1 oct normal, 2 packed radial
    this.edge = null;      // RGBA8: per-side continuity mask
    this.lit = null;       // RGBA8: fully shaded colour, linear RGB
    this.shadow = null;
    this.shadowSize = 0;
    this.lowRes = null;
    this.lowW = 0;
    this.lowH = 0;
  }

  _atlasOptions(depthBuffer){
    const THREE = this.THREE;
    return {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      depthBuffer: !!depthBuffer,
      stencilBuffer: false,
    };
  }

  /** @returns true when the atlas was (re)allocated, so the caller can resize dependent state. */
  ensureAtlas(probeSize){
    if(this.probeSize === probeSize && this.gbuf) return false;
    this._disposeAtlas();
    const THREE = this.THREE;
    const w = probeSize * ATLAS_COLS, h = probeSize * ATLAS_ROWS;
    this.gbuf = new THREE.WebGLMultipleRenderTargets(w, h, 3, this._atlasOptions(true));
    for(const t of this.gbuf.texture) t.name = "full.gbuffer";
    this.edge = new THREE.WebGLRenderTarget(w, h, this._atlasOptions(false));
    this.edge.texture.name = "full.edge";
    this.lit = new THREE.WebGLRenderTarget(w, h, this._atlasOptions(false));
    this.lit.texture.name = "full.lit";
    this.probeSize = probeSize;
    return true;
  }

  ensureShadow(size){
    if(this.shadowSize === size && this.shadow) return false;
    this.shadow?.dispose();
    const THREE = this.THREE;
    this.shadow = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.shadow.texture.name = "full.shadow";
    this.shadowSize = size;
    return true;
  }

  ensureLowRes(w, h){
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if(this.lowW === w && this.lowH === h && this.lowRes) return false;
    this.lowRes?.dispose();
    const THREE = this.THREE;
    this.lowRes = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.lowRes.texture.name = "full.lowres";
    this.lowW = w;
    this.lowH = h;
    return true;
  }

  /** Atlas pixel rect for one logical layer (probe * 6 + face). */
  layerRect(layer){
    const s = this.probeSize;
    return [(layer % ATLAS_COLS) * s, Math.floor(layer / ATLAS_COLS) * s, s, s];
  }

  /** UV sub-rectangle (x, y, w, h in 0..1) of one layer — the post pass's debug blit uses this. */
  layerUvRect(layer){
    return [(layer % ATLAS_COLS) / ATLAS_COLS, Math.floor(layer / ATLAS_COLS) / ATLAS_ROWS,
            1 / ATLAS_COLS, 1 / ATLAS_ROWS];
  }

  /** UV sub-rectangle covering one probe's whole row of six faces. */
  probeUvRect(probe){
    return [0, probe / ATLAS_ROWS, 1, 1 / ATLAS_ROWS];
  }

  _disposeAtlas(){
    this.gbuf?.dispose();
    this.edge?.dispose();
    this.lit?.dispose();
    this.gbuf = this.edge = this.lit = null;
    this.probeSize = 0;
  }

  dispose(){
    this._disposeAtlas();
    this.shadow?.dispose();
    this.shadow = null;
    this.shadowSize = 0;
    this.lowRes?.dispose();
    this.lowRes = null;
    this.lowW = this.lowH = 0;
  }
}

export {TOTAL_LAYERS};
