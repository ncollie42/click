// Owns: every GPU buffer the splat pipeline allocates, and the rules for re-allocating them when a
// tunable or the canvas size changes. Nothing else in the pipeline calls `new WebGL*RenderTarget`.
//
// LAYOUT — a 3x2 ATLAS INSTEAD OF A CUBEMAP ARRAY. The reference keeps its G-buffers in a
// texture2DArray with one layer per (probe, face) and renders MRT into a layer at a time. WebGL2 via
// three cannot attach an array layer as an MRT colour attachment, so the six faces live side by side
// in one 2D texture, face f at cell (f%3, f/3), and each face render targets its cell through the
// render target's viewport+scissor. Sampling is then plain texelFetch with a face offset — see
// faceOrigin() in glsl.js. Neighbour taps (edge mask, outline detection) clamp to the owning cell so
// faces never bleed into each other.
//
// FORMATS — everything is RGBA8. The reference stores radial distance in R32F; three r160 builds all
// MRT attachments from one cloned texture descriptor, and a float colour attachment adds an
// extension dependency for no benefit here, so radial is packed into all four bytes instead (~32-bit
// over the whole near..far range, which at far=600 is sub-millimetre). The packing is INVERTED
// (1 - radial) so that the all-zero clear reads back as radial 1.0 — the "sky, no geometry" sentinel
// every downstream pass tests for. Get that backwards and the whole screen turns into geometry at
// the near plane.
//
// TWO SLOTS, PING-PONGED. Slot A and slot B are identical. The grid probe captures into the current
// slot every frame; when the grid origin snaps, the slots swap, so the frozen slot instantly becomes
// "prev" with no copy at all. This is the one real deviation from the reference's prev probe: prev
// shows a scene that is up to one crossfade old (0.5s) instead of re-capturing live. Units move
// slowly relative to that and prev is dithering out the whole time, so the staleness is invisible —
// and it halves the per-frame capture cost.

export class Targets {
  constructor(THREE){
    this.THREE = THREE;
    this.slots = [null, null];
    this.gridSlot = 0;
    this.probeSize = 0;
    this.shadow = null;
    this.shadowSize = 0;
    this.lowRes = null;
    this.lowW = 0;
    this.lowH = 0;
  }

  get grid(){ return this.slots[this.gridSlot]; }
  get prev(){ return this.slots[1 - this.gridSlot]; }
  swapSlots(){ this.gridSlot = 1 - this.gridSlot; }

  _atlasOptions(){
    const THREE = this.THREE;
    return {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    };
  }

  ensureAtlas(probeSize){
    if(this.probeSize === probeSize && this.slots[0]) return false;
    this._disposeSlots();
    const THREE = this.THREE;
    const w = probeSize * 3, h = probeSize * 2;
    for(let i = 0; i < 2; i++){
      const opts = this._atlasOptions();
      // MRT: 0 = albedo(rgb)+entity id(a), 1 = octahedral normal(rg), 2 = packed radial.
      const gbuf = new THREE.WebGLMultipleRenderTargets(w, h, 3, {...opts, depthBuffer: true});
      for(const t of gbuf.texture){ t.name = "splat.gbuffer"; }
      const edge = new THREE.WebGLRenderTarget(w, h, this._atlasOptions());
      const lit = new THREE.WebGLRenderTarget(w, h, this._atlasOptions());
      this.slots[i] = {gbuf, edge, lit};
    }
    this.probeSize = probeSize;
    this.gridSlot = 0;
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
    this.lowW = w;
    this.lowH = h;
    return true;
  }

  _disposeSlots(){
    for(let i = 0; i < 2; i++){
      const s = this.slots[i];
      if(!s) continue;
      s.gbuf.dispose();
      s.edge.dispose();
      s.lit.dispose();
      this.slots[i] = null;
    }
    this.probeSize = 0;
  }

  dispose(){
    this._disposeSlots();
    this.shadow?.dispose();
    this.shadow = null;
    this.shadowSize = 0;
    this.lowRes?.dispose();
    this.lowRes = null;
    this.lowW = this.lowH = 0;
  }
}
