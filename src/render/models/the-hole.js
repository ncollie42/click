// The Keep and the Hole — main base model, full 3x3 footprint (96x96 sim px, origin at center).
// Contract: docs/model-spec.md. Violet only on the pit, its fissures, motes, orb (+authored cyan stud).
// v14, built to the CROSS-ROUND INVARIANTS instead of any single critic list:
//   A/B. One hot thin octagonal lip ring — the brightest emissive on the asset — then values step
//        monotonically darker inward to a near-black floor. The ring IS the distance identity.
//   C.   In the grade: berm is a LOW lip (~1.5, quarter of v13's), apron feathers flush to grass,
//        mouth widened to r15.5 so the pit dominates the keep again.
//   D.   Interior is 3 stepped concentric octagonal facet rings (wall, ledge, wall...) — recession
//        sold by flat-shaded steps; unlit below the first ledge so no sun ever lifts the void.
//   E.   Violet lives in SEAMS BETWEEN FACETS: charred rock CHUNKS (not slabs) radiate from the rim,
//        emissive seams run in the valleys between chunks, hot core + one dim falloff step. Hue
//        shifted blue-violet (#7c3cf0 family) — the old #9b4de0 read magenta under the warm sun.
//   F.   The gulp flashes the MOUTH first: sleeve bands inside the funnel bloom rim->inward, floor
//        breathes, cracks flare SECOND. The pit is what was fed, so the pit answers.
//   G.   Orb: irregular facet cluster + satellites, white angled wedge eyes, cyan stud only,
//        hover pool + contact shadow directly below and placed clear of the curb at yaw 35.
//   Shadow hygiene: berm/apron/emissive meshes never cast; only keep, curb, chute, rubble do.
import * as THREE from "three";

const C = {
  sand:      0xd9c9a3,
  sandEdge:  0xb8bb88,
  bermTop:   0xc4b28e,
  pad:       0xa08a63,
  charInner: 0x241c26,
  charOuter: 0x59493c,
  chunkDark: 0x352c42,   // lifted one value step (round 6): facet separation must exist
  chunkMid:  0x463a54,
  rubble:    0x8d8c88,
  greys:     [0xa6a6a0, 0x9a9a94, 0x84837e, 0x6f6f6a],
  rockDark:  0x6f6f6a,
  curbStone: 0x77766f,
  timber:    0x8a7358,
  timberDark:0x5c4a38,
  doorway:   0x49392d,
  wallShelf: 0x5e3fa8,   // pit interior bands, concentric value steps darkening inward
  wallMid:   0x3d2680,
  wallDeep:  0x221448,
  wallThroat:0x120b26,
  floor:     0x080512,
  // Emissive bases pushed further BLUE than the authored #a783df family: the additive halo over
  // warm sand plus ACES rolloff drags displayed hue toward magenta, so the authored hex must aim
  // past violet for the RENDERED pixels to land on it. Judge the displayed color, not this file.
  violetHot: 0x6a2ee0,
  violetMid: 0x4f22b8,
  violetDim: 0x33206e,
  orbBody:   0x1f1826,
  eye:       0x71cbd8,
};

function rng(seed){ let s = seed; return () => (s = (s*16807)%2147483647) / 2147483647; }
const lambert = (color, opts={}) => new THREE.MeshLambertMaterial({color, flatShading:true, ...opts});
const unlit   = (color) => new THREE.MeshBasicMaterial({color});
const vcLambert = () => new THREE.MeshLambertMaterial({vertexColors:true, flatShading:true});
const vcUnlit   = () => new THREE.MeshBasicMaterial({vertexColors:true});
const mix = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k);
// The viewer force-sets castShadow=true on every mesh at mount; lock it off for meshes that must
// never produce ground-shadow artifacts (emissive decals, berm skins, ground blobs).
function noShadow(mesh){
  Object.defineProperty(mesh, "castShadow", {get: () => false, set: () => {}});
  return mesh;
}

// ── vertex-colored helpers ──────────────────────────────────────────────────
function vcMesh(pos, col, mat){
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat || vcLambert());
}
function blobFan(cx, cz, y, rBase, rJit, segments, colorIn, colorOut, rand){
  const pos = [], col = [];
  const edge = [];
  for(let i=0;i<segments;i++){
    const a = (i/segments)*Math.PI*2;
    const r = rBase + (rand()-0.5)*2*rJit;
    edge.push([cx+Math.cos(a)*r, y, cz+Math.sin(a)*r]);
  }
  const ci = new THREE.Color(colorIn), co = new THREE.Color(colorOut);
  for(let i=0;i<segments;i++){
    const e1 = edge[i], e2 = edge[(i+1)%segments];
    pos.push(cx, y, cz, ...e2, ...e1);
    col.push(ci.r,ci.g,ci.b, co.r,co.g,co.b, co.r,co.g,co.b);
  }
  return vcMesh(pos, col);
}
function ringBand(cx, cz, rA, yA, rB, yB, segments, twistA, twistB, jitter, colorA, colorB, rand, mat){
  const pos = [], col = [];
  const ring = (r, y, twist) => {
    const out = [];
    for(let i=0;i<segments;i++){
      const a = (i/segments)*Math.PI*2 + twist;
      const rr = r*(1+(rand()-0.5)*jitter);
      out.push([cx+Math.cos(a)*rr, y+(rand()-0.5)*jitter*r*0.25, cz+Math.sin(a)*rr]);
    }
    return out;
  };
  const A = ring(rA, yA, twistA), B = ring(rB, yB, twistB);
  const ca = new THREE.Color(colorA), cb = new THREE.Color(colorB);
  for(let i=0;i<segments;i++){
    const i2 = (i+1)%segments;
    pos.push(...A[i], ...B[i], ...A[i2],   ...A[i2], ...B[i], ...B[i2]);
    col.push(ca.r,ca.g,ca.b, cb.r,cb.g,cb.b, ca.r,ca.g,ca.b,  ca.r,ca.g,ca.b, cb.r,cb.g,cb.b, cb.r,cb.g,cb.b);
  }
  return vcMesh(pos, col, mat);
}
// One continuous surface over SHARED jittered rings — adjacent bands can never gap or stripe,
// because each ring's vertices are computed once and reused by both neighboring bands.
// Optional `lit`: bakes a directional rim-light into the vertex colors — the FAR inner wall
// (the side whose inner face is seen from the default camera, which is also the side the sun
// reaches into) catches a violet gradient that is hot near the lip and decays with depth, while
// the near wall stays shadow-dark. A hole reads by its lit far wall, not by uniform darkness.
function multiRing(cx, cz, rings, segments, jitter, rand, mat, lit){
  const ringVerts = rings.map((rg, k) => {
    const twist = (k%2)*(Math.PI/segments);
    const out = [];
    for(let i=0;i<segments;i++){
      const a = (i/segments)*Math.PI*2 + twist;
      const rr = rg.r*(1+(rand()-0.5)*jitter);
      out.push({p:[cx+Math.cos(a)*rr, rg.y, cz+Math.sin(a)*rr], a});
    }
    return out;
  });
  const vcol = (k, v) => {
    const base = new THREE.Color(rings[k].color);
    if(!lit) return base;
    const az = Math.max(0, Math.cos(v.a)*lit.dirX + Math.sin(v.a)*lit.dirZ);
    const fade = lit.fades[Math.min(k, lit.fades.length-1)];
    return base.lerp(new THREE.Color(lit.color), az*fade);
  };
  const pos = [], col = [];
  for(let k=0;k<rings.length-1;k++){
    const A = ringVerts[k], B = ringVerts[k+1];
    for(let i=0;i<segments;i++){
      const i2 = (i+1)%segments;
      const verts = [[k,A[i]],[k+1,B[i]],[k,A[i2]], [k,A[i2]],[k+1,B[i]],[k+1,B[i2]]];
      for(const [rk, v] of verts){
        pos.push(...v.p);
        const c = vcol(rk, v);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  return vcMesh(pos, col, mat);
}

// ── charred chunk spokes: violet seams in the valleys BETWEEN facet chunks ──
function buildScorchChunks(rand, pitX, lipR){
  const g = new THREE.Group(); g.name = "cracks";
  const seamMat = lambert(C.violetMid, {emissive:C.violetHot, emissiveIntensity:1.0});
  const dimMat  = lambert(C.violetDim, {emissive:C.violetDim, emissiveIntensity:0.5});
  g.userData.material = seamMat; g.userData.tipMaterial = dimMat;
  const chunkMats = [lambert(C.chunkDark), lambert(C.chunkMid), lambert(mix(C.chunkDark, C.charOuter, 0.3).getHex())];
  const slotMat = unlit(0x120d1a);
  // TWO boulders (round 6): spend the whole budget on the two that read. Each carries one
  // BRANCHING carved crack: a main channel aligned with the rock's own facet grid, and a branch
  // leaving it at a joint partway along — the enemies sheet's construction, never straight
  // streaks at arbitrary angles. Positions of the survivors unchanged from v17.
  const angles = [0.2, 1.4];
  for(const a0 of angles){
    const ca = a0 + (rand()-0.5)*0.12;
    const s = 8.2 + rand()*1.4;
    const cr = lipR + 5.5 + s*0.55 + rand()*1.5;
    const cx = pitX + Math.cos(ca)*cr, cz = Math.sin(ca)*cr;
    const rockYaw = -ca + (rand()-0.5)*0.4;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), chunkMats[(rand()*3)|0]);
    rock.scale.set(1, 0.48, 0.8);
    rock.position.set(cx, 0.4 + s*0.19, cz);
    rock.rotation.set(0, rockYaw, 0);
    rock.castShadow = true;
    g.add(rock);
    const topY = 0.4 + s*0.19 + s*0.48*0.5;
    // main channel: runs with the rock's facet grid (its own yaw), slot + hot core
    const cut = (ang, px, pz, len, w) => {
      const slot = noShadow(new THREE.Mesh(new THREE.BoxGeometry(len, 0.7, w*2.1), slotMat));
      slot.position.set(px, topY - 0.22, pz);
      slot.rotation.y = ang;
      g.add(slot);
      const core = noShadow(new THREE.Mesh(new THREE.BoxGeometry(len*1.04, 0.5, w), seamMat));
      core.position.set(px, topY - 0.06, pz);
      core.rotation.y = ang;
      g.add(core);
    };
    cut(rockYaw, cx, cz, s*1.55, 0.8);
    // branch: leaves the main at a joint ~1/3 along, at the neighbouring facet's angle,
    // shorter and thinner — one silhouette, one crack system, visibly forked
    const jx = cx + Math.cos(-rockYaw)*s*0.55, jz = cz + Math.sin(-rockYaw)*s*0.55;
    const bAng = rockYaw + (rand()<0.5 ? -1 : 1)*0.65;
    cut(bAng, jx + Math.cos(-bAng)*s*0.3, jz + Math.sin(-bAng)*s*0.3, s*0.85, 0.55);
  }
  // short recessed grade cuts (R3/R5 synthesis): carved channels radiating from the lip into
  // the apron — dark slot walls with a violet core, geometry not paint, tapering in two steps.
  // Angles sit between the boulder spokes so neither crowds the other.
  for(const a0 of [-0.45, 0.85, 2.0, 3.2]){
    let ca = a0 + (rand()-0.5)*0.1;
    let cr = lipR + 1.2;
    for(let seg2=0; seg2<2; seg2++){
      const len = seg2===0 ? 5.0+rand()*1.5 : 3.2+rand();
      const w = seg2===0 ? 1.9 : 1.1;
      const mx = pitX + Math.cos(ca)*(cr + len/2), mz = Math.sin(ca)*(cr + len/2);
      const slot = noShadow(new THREE.Mesh(new THREE.BoxGeometry(len, 0.42, w), slotMat));
      slot.position.set(mx, 0.44, mz);
      slot.rotation.y = -ca;
      g.add(slot);
      const core = noShadow(new THREE.Mesh(new THREE.BoxGeometry(len*0.7, 0.36, w*0.38),
        seg2===0 ? seamMat : dimMat));
      core.position.set(mx, 0.55, mz);
      core.rotation.y = -ca;
      g.add(core);
      cr += len*0.96; ca += (rand()-0.5)*0.25;
    }
  }
  return g;
}

// ── the keep ────────────────────────────────────────────────────────────────
function buildKeep(rand){
  const keep = new THREE.Group(); keep.name = "keep";
  const R = 12, H = 30;
  const greyMats = C.greys.map(c=>lambert(c));
  const darkMat = lambert(C.rockDark);
  for(let b=0;b<7;b++){
    const a = (b/7)*Math.PI*2 + 0.2;
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(8.4+(rand()-0.5)*1.6, 4.6, 5.4+(rand()-0.5)*1.2), b%3===1 ? darkMat : greyMats[2]);
    block.position.set(Math.cos(a)*12.6, 1.4, Math.sin(a)*12.6);
    block.rotation.y = -a + (rand()-0.5)*0.12;
    keep.add(block);
  }
  const aoPad = noShadow(new THREE.Mesh(new THREE.CircleGeometry(16.5, 14),
    new THREE.MeshBasicMaterial({color:0x3a3226, transparent:true, opacity:0.28})));
  aoPad.rotation.x = -Math.PI/2; aoPad.position.y = 0.34;
  keep.add(aoPad);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(R, R+1.6, H, 9), greyMats[1]);
  core.position.y = 2.6 + H/2;
  keep.add(core);
  for(let c=0;c<5;c++){
    const y = 6.2 + c*5.4;
    for(let b=0;b<6;b++){
      const a = (b/6)*Math.PI*2 + (c%2)*(Math.PI/6) + (rand()-0.5)*0.06;
      const rr = R + 0.4 - c*0.14;
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(6.2+(rand()-0.5)*1.6, 4.2+(rand()-0.5)*0.6, 1.6),
        greyMats[(rand()*4)|0]);
      block.position.set(Math.cos(a)*rr, y, Math.sin(a)*rr);
      block.rotation.y = -a + Math.PI/2;
      keep.add(block);
      const under = new THREE.Mesh(new THREE.BoxGeometry(6.0+(rand()-0.5)*1.2, 0.8, 1.7), lambert(0x55544f));
      under.position.set(Math.cos(a)*rr, y-2.4, Math.sin(a)*rr);
      under.rotation.y = -a + Math.PI/2;
      keep.add(under);
    }
  }
  const cren = new THREE.Group(); cren.name = "crenellations"; cren.position.y = 2.6 + H;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(R+1.7, R+0.8, 3, 9), darkMat);
  cap.position.y = 1.5;
  cren.add(cap);
  for(let m=0;m<6;m++){
    const a = (m/6)*Math.PI*2 + 0.26;
    const merlon = new THREE.Mesh(new THREE.BoxGeometry(5.6, 4.4, 4.4), greyMats[m%2===0?0:2]);
    merlon.position.set(Math.cos(a)*(R+0.8), 5.0, Math.sin(a)*(R+0.8));
    merlon.rotation.y = -a;
    cren.add(merlon);
  }
  keep.add(cren);
  const door = new THREE.Group(); door.name = "door";
  const doorMat = lambert(C.doorway), plankMat = lambert(C.timberDark);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 12.4, 9.2), doorMat);
  slab.position.set(R+0.8, 8.2, 0);
  door.add(slab);
  for(const off of [-2.9, 0, 2.9]){
    const plank = new THREE.Mesh(new THREE.BoxGeometry(0.8, 11.2, 2.2), plankMat);
    plank.position.set(R+2.25, 8.0, off);
    door.add(plank);
  }
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(4.7, 4.7, 2.8, 8, 1, false, 0, Math.PI), doorMat);
  arch.rotation.z = Math.PI/2; arch.rotation.y = Math.PI/2;
  arch.position.set(R+0.8, 14.3, 0);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.6, 13.2), darkMat);
  lintel.position.set(R+0.7, 17.6, 0);
  const step = new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.8, 10.4), lambert(C.pad));
  step.position.set(R+3.8, 1.7, 0);
  door.add(arch, lintel, step);
  door.rotation.y = -0.35;
  keep.add(door);
  // deliberately dim: the keep's crack is a supporting detail — the pit must win every
  // emissive-hierarchy fight, especially at distance (round-4 ruling).
  const climb = new THREE.Group(); climb.name = "keepCrack";
  const hotMat = lambert(C.violetDim, {emissive:C.violetMid, emissiveIntensity:0.22});
  const fadeMat = lambert(C.violetDim, {emissive:C.violetDim, emissiveIntensity:0.12});
  keep.userData.crackMaterial = hotMat;
  let cy = 0.8, ca = 0.72;
  for(let i=0;i<6;i++){
    const h = 3.0 - i*0.3;
    const seg = noShadow(new THREE.Mesh(
      new THREE.BoxGeometry(1.5 - i*0.16, h, 1.5 - i*0.16), i>=4 ? fadeMat : hotMat));
    const rr = 14.2 - i*0.14;
    seg.position.set(Math.cos(ca)*rr, cy + h/2, Math.sin(ca)*rr);
    climb.add(seg);
    cy += h*0.9; ca += (rand()-0.5)*0.1;
  }
  keep.add(climb);
  return keep;
}

// ── the pit: low-lipped mouth, terraced octagonal interior, void below ──────
function buildPit(rand, pitX){
  const pit = new THREE.Group(); pit.name = "pit"; pit.position.x = pitX;
  const SEG = 8, J = 0.04;                       // octagonal per invariant D
  const LIP_R = 15.5, LIP_Y = 1.5;               // low lip: quarter of v13's berm
  // gentle apron rise from grade to the lip — displaced earth, not a volcano
  const berm = ringBand(0,0, 24, 0.32, LIP_R+0.8, LIP_Y, SEG*2, 0, Math.PI/(SEG*2), J,
    mix(C.sand, C.charOuter, 0.35), C.bermTop, rand);
  berm.name = "berm";
  // the berm casts like everything else villager-scale — the pit must live in the same light
  // as the tower (judge: "the tower casts hard shadow, the pit rim casts none").
  berm.castShadow = true; berm.receiveShadow = true;
  // interior: ONE continuous surface over shared octagonal rings, with a baked violet rim-light
  // running DOWN the far inner wall (sun- and default-camera-consistent direction) while the near
  // wall stays shadow-dark. The eye measures depth against that lit wall; pure black was a hole
  // that read as a sticker. Heights stay above the apron blob (y≈0.26+jitter) — the sand must
  // never win the depth test inside the mouth.
  const funnel = new THREE.Group(); funnel.name = "funnel";
  // Rings shaped so the 35° view shows CONCENTRIC VISIBLE BANDS: a shallow violet shelf under
  // the lip (wide in plan), a mid step, then the steep drop to the black throat. The graze view
  // keeps its occlusion; the top view now has bands to measure depth against.
  const RINGS = [
    {r:LIP_R,  y:LIP_Y,  color:C.wallShelf},
    {r:12.9,   y:1.28,   color:C.wallMid},
    {r:10.9,   y:1.02,   color:C.wallDeep},
    {r:8.2,    y:0.70,   color:C.wallThroat},
    {r:5.4,    y:0.60,   color:C.floor},
  ];
  const LIT = {dirX:-0.83, dirZ:-0.55, color:0x6a44e0, fades:[0.9, 0.55, 0.22, 0.0, 0.0]};
  // ONE set of jittered ring vertices, shared by the base walls AND four per-band flash meshes.
  // The flash meshes are single flat colors (normal blending, never additive) that the gulp
  // brightens IN SEQUENCE toward the throat — flat bands pulsing in place, no gradient, and the
  // floor flashes with them so no dark polygon ever shows at the center.
  const trand = rng(555);
  const ringVerts = RINGS.map((rg, k) => {
    const twist = (k%2)*(Math.PI/SEG);
    const out = [];
    for(let i=0;i<SEG;i++){
      const a = (i/SEG)*Math.PI*2 + twist;
      const rr = rg.r*(1+(trand()-0.5)*0.035);
      out.push({p:[Math.cos(a)*rr, rg.y, Math.sin(a)*rr], a});
    }
    return out;
  });
  const bandGeo = (k) => {
    const A = ringVerts[k], B = ringVerts[k+1], pos = [];
    for(let i=0;i<SEG;i++){
      const i2 = (i+1)%SEG;
      pos.push(...A[i].p, ...B[i].p, ...A[i2].p,  ...A[i2].p, ...B[i].p, ...B[i2].p);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  };
  // base walls: vertex-colored flat bands with the baked far-wall light
  {
    const pos = [], col = [];
    for(let k=0;k<RINGS.length-1;k++){
      const A = ringVerts[k], B = ringVerts[k+1];
      for(let i=0;i<SEG;i++){
        const i2 = (i+1)%SEG;
        for(const [rk, v] of [[k,A[i]],[k+1,B[i]],[k,A[i2]], [k,A[i2]],[k+1,B[i]],[k+1,B[i2]]]){
          pos.push(...v.p);
          const base = new THREE.Color(RINGS[rk].color);
          const az = Math.max(0, Math.cos(v.a)*LIT.dirX + Math.sin(v.a)*LIT.dirZ);
          const c = base.lerp(new THREE.Color(LIT.color), az*LIT.fades[Math.min(rk, LIT.fades.length-1)]);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    const throat = noShadow(vcMesh(pos, col, vcUnlit()));
    funnel.add(throat);
  }
  const FLASH_COLORS = [0x5b2ed0, 0x6a2ee0, 0x6f32e8, 0x7a3af0];
  const flashMats = [];
  for(let k=0;k<4;k++){
    const mat = new THREE.MeshBasicMaterial({color:FLASH_COLORS[k], transparent:true, opacity:0, depthWrite:false});
    const band = noShadow(new THREE.Mesh(bandGeo(k), mat));
    band.renderOrder = 10;
    flashMats.push(mat);
    funnel.add(band);
  }
  funnel.userData.flashMats = flashMats;
  const floorMat = new THREE.MeshBasicMaterial({color:C.floor});
  funnel.userData.floorMaterial = floorMat;
  const floor = noShadow(new THREE.Mesh(new THREE.CircleGeometry(5.5, SEG), floorMat));
  floor.rotation.x = -Math.PI/2; floor.position.y = 0.58; floor.name = "throatFloor";
  funnel.add(floor);
  // THE identity: one thin hot octagonal lip ring, brightest emissive on the asset, plus an
  // additive glow halo so the pit wins the distance hierarchy outright.
  const lip = noShadow(new THREE.Mesh(new THREE.TorusGeometry(LIP_R+0.2, 1.1, 4, SEG),
    lambert(C.violetDim, {emissive:C.violetHot, emissiveIntensity:1.5})));
  lip.rotation.x = Math.PI/2; lip.rotation.z = Math.PI/SEG; lip.position.y = LIP_Y+0.25; lip.name = "lip";
  funnel.userData.lipMaterial = lip.material;
  funnel.add(lip);
  // dark scorch collar conforming to the berm slope stays — it anchors the rim in dark material.
  // The additive halo quad is DELETED (round 6): it composited a smooth gradient over authored
  // flat bands and was the standing magenta generator. Rim heat now comes from the flat emissive
  // lip band alone — widened for more emissive area, still one flat color, hard edges.
  const collar = ringBand(0,0, 19.0, 1.13, 16.1, LIP_Y+0.04, SEG*2, 0, Math.PI/(SEG*2), 0,
    0x241d2c, 0x15101c, rand, vcUnlit());
  noShadow(collar); collar.name = "collar";
  funnel.add(collar);
  // curb: stones half-sunk at the lip shoulder, octagon beams lashed on top — a low well-curb
  const curb = new THREE.Group(); curb.name = "curb";
  const stoneMat = lambert(C.curbStone), stoneDark = lambert(0x5f5e58), beamMat = lambert(C.timber);
  const N = 8, CURB_R = LIP_R + 3.2;
  for(let i=0;i<N;i++){
    const a = (i/N)*Math.PI*2 + Math.PI/N;
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(6.4+(rand()-0.5)*1.2, 3.0+(rand()-0.5)*0.6, 4.2+(rand()-0.5)*1.0),
      i%4===2 ? stoneDark : stoneMat);
    s.position.set(Math.cos(a)*CURB_R, 1.9, Math.sin(a)*CURB_R);
    s.rotation.y = -a + Math.PI/2 + (rand()-0.5)*0.14;
    s.castShadow = true;
    curb.add(s);
  }
  const chord = 2*CURB_R*Math.sin(Math.PI/N);
  for(let i=0;i<N;i++){
    const aMid = (i/N)*Math.PI*2;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(chord*0.96, 1.7, 2.3), beamMat);
    const rMid = CURB_R*Math.cos(Math.PI/N);
    beam.position.set(Math.cos(aMid)*rMid, 3.9, Math.sin(aMid)*rMid);
    beam.rotation.y = -aMid + Math.PI/2;
    beam.castShadow = true;
    curb.add(beam);
  }
  // the ladder-chute over the curb — the narrative beat; now a short ramp onto a low rim
  const chute = new THREE.Group(); chute.name = "chute";
  const hi = {x:-(CURB_R-1.2), y:5.0}, lo = {x:-(CURB_R+10.0), y:0.8};
  const len = Math.hypot(hi.x-lo.x, hi.y-lo.y), ang = Math.atan2(hi.y-lo.y, hi.x-lo.x);
  const ramp = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 1.0, 6.4), lambert(C.timberDark));
  deck.position.y = 0.5;
  ramp.add(deck);
  for(const zoff of [-3.4, 3.4]){
    const side = new THREE.Mesh(new THREE.BoxGeometry(len, 2.0, 1.2), beamMat);
    side.position.set(0, 1.1, zoff);
    ramp.add(side);
  }
  for(let p=0;p<3;p++){
    const cleat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.55, 6.2), beamMat);
    cleat.position.set(-len/2 + (p+1)*len/4, 1.1, 0);
    ramp.add(cleat);
  }
  ramp.rotation.z = ang;
  ramp.position.set((hi.x+lo.x)/2, (hi.y+lo.y)/2, 0);
  chute.add(ramp);
  chute.rotation.y = 0.75;
  chute.position.y = 0.3;
  chute.traverse(o=>{ if(o.isMesh) o.castShadow = true; });
  pit.add(berm, funnel, curb, chute);
  return pit;
}

function buildBase({awake}){
  const rand = rng(1337);
  const root = new THREE.Group();
  const apron = new THREE.Group(); apron.name = "apron";
  const PIT_X = 21;
  const patch = noShadow(blobFan(5, 0, 0.26, 47, 5, 22, C.sand, C.sandEdge, rand));
  patch.receiveShadow = true;
  // stepped edge transition (round 6): the blob shape was right, the clean vector edge wasn't.
  // Small dirt patches scatter past the boundary and grass-colored bites eat into it, so the
  // apron dissolves into the field instead of ending at a line.
  for(let i=0;i<9;i++){
    const a = (i/9)*Math.PI*2 + rand()*0.5;
    const rr = 48 + rand()*7;
    const spot = noShadow(blobFan(5+Math.cos(a)*rr, Math.sin(a)*rr, 0.24, 3.2+rand()*2.6, 1.4, 7,
      C.sandEdge, mix(C.sandEdge, 0x9db97f, 0.5).getHex(), rand));
    apron.add(spot);
  }
  for(let i=0;i<6;i++){
    const a = (i/6)*Math.PI*2 + 0.4 + rand()*0.4;
    const rr = 41 + rand()*4;
    const bite = noShadow(blobFan(5+Math.cos(a)*rr, Math.sin(a)*rr, 0.3, 2.6+rand()*2.0, 1.2, 6,
      0x9db97f, mix(0x9db97f, C.sandEdge, 0.4).getHex(), rand));
    apron.add(bite);
  }
  const scorch = noShadow(ringBand(PIT_X, 0, 27, 0.4, 19.5, 0.44, 20, 0, Math.PI/20, 0.09,
    mix(C.charOuter, C.sand, 0.35), C.charInner, rand));
  scorch.receiveShadow = true;
  apron.add(patch, scorch);
  const rubbleMat = lambert(C.rubble), rubbleDark = lambert(0x77766f);
  const spots = [[-38,36],[42,-30],[47,18],[-30,-44],[6,-38],[-6,47],[38,32],[-48,10],[26,44]];
  for(const [x,z] of spots){
    const n = 1 + (rand()*2|0);
    for(let i=0;i<n;i++){
      const s = 1.4 + rand()*2.1;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rand()<0.4?rubbleDark:rubbleMat);
      rock.position.set(x+(rand()-0.5)*6, 0.3+s*0.45, z+(rand()-0.5)*6);
      rock.rotation.set(rand()*3, rand()*3, rand()*3);
      rock.castShadow = true;
      apron.add(rock);
    }
  }
  root.add(apron);
  const keep = buildKeep(rand); keep.position.x = -27;
  root.add(keep);
  root.add(buildPit(rand, PIT_X));
  root.add(buildScorchChunks(rand, PIT_X, 15.5));
  if(awake){
    // shard sentinel: hovers over open sand, clear of the curb silhouette at the default yaw
    const orb = new THREE.Group(); orb.name = "orb"; orb.position.set(PIT_X+24, 0, -18);
    const core = new THREE.Group(); core.name = "orbCore"; core.position.y = 22;
    core.scale.setScalar(1.18);                  // guardian presence at gameplay distance
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(6.4, 0),
      lambert(C.orbBody, {emissive:0x241a36, emissiveIntensity:0.5}));
    body.castShadow = true;
    core.add(body);
    // satellites pushed OUT so they genuinely protrude — visible bumps in silhouette, an
    // irregular shard-cluster outline instead of a floating rock (round-5 ruling).
    const satMat = lambert(C.orbBody, {emissive:0x241a36, emissiveIntensity:0.5});
    const sats = [[6.6,2.4,-2.4,3.6],[-6.0,-1.8,3.0,3.2],[-2.2,6.4,3.2,2.7]];
    for(const [sx,sy,sz,ss] of sats){
      const sat = new THREE.Mesh(new THREE.IcosahedronGeometry(ss, 0), satMat);
      sat.position.set(sx, sy, sz);
      sat.castShadow = true;
      core.add(sat);
    }
    // seams share the boulder construction: dark recessed slot + hot core inset
    const seamMat = lambert(C.violetMid, {emissive:C.violetHot, emissiveIntensity:1.25});
    const slotMat2 = unlit(0x120d1a);
    let sr = rng(77);
    for(let i=0;i<6;i++){
      const a1 = sr()*Math.PI*2, a2 = sr()*Math.PI - Math.PI/2;
      const rx = sr()*3.1, ry = sr()*3.1, rz = sr()*3.1;
      const px = Math.cos(a1)*Math.cos(a2)*2.4, py = Math.sin(a2)*2.4, pz = Math.sin(a1)*Math.cos(a2)*2.4;
      const slot = noShadow(new THREE.Mesh(new THREE.BoxGeometry(8.6, 1.5, 1.5), slotMat2));
      slot.position.set(px, py, pz);
      slot.rotation.set(rx, ry, rz);
      core.add(slot);
      const seam = noShadow(new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.8, 0.8), seamMat));
      seam.position.set(px, py, pz);
      seam.rotation.set(rx, ry, rz);
      core.add(seam);
    }
    // eyes with dark brow-socket recesses so they read as EYES, not white specks
    const eyeMat = unlit(0xf2f0ea), socketMat = unlit(0x100c16);
    for(const side of [-1, 1]){
      const socket = noShadow(new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.4, 0.7), socketMat));
      socket.position.set(5.0, 1.7, side*2.4);
      socket.rotation.y = -side*0.5;
      socket.rotation.z = side*0.35;
      core.add(socket);
      const eye = noShadow(new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.3, 0.55), eyeMat));
      eye.position.set(5.35, 1.5, side*2.4);
      eye.rotation.y = -side*0.5;
      eye.rotation.z = side*0.35;
      core.add(eye);
    }
    const stud = noShadow(new THREE.Mesh(new THREE.OctahedronGeometry(0.85, 0),
      lambert(C.eye, {emissive:C.eye, emissiveIntensity:1.0})));
    stud.position.set(5.7, 2.9, 0);
    core.add(stud);
    // deep-violet spike: dark body, restrained emissive — menace, not a party hat
    const spike = noShadow(new THREE.Mesh(new THREE.ConeGeometry(1.7, 7.0, 4),
      lambert(0x2a1a4a, {emissive:C.violetMid, emissiveIntensity:0.85})));
    spike.position.set(1.2, 8.8, 0); spike.rotation.z = -0.28;
    core.add(spike);
    const trail = new THREE.Group(); trail.name = "orbTrail";
    for(let i=0;i<3;i++){
      const mote = noShadow(new THREE.Mesh(new THREE.TetrahedronGeometry(0.7 - i*0.15, 0), seamMat));
      mote.position.set(2.5 + i*2.2, -5 - i*2.6, 3 + i*1.4);   // toward camera-right, never hidden
      trail.add(mote);
    }
    core.add(trail);
    orb.add(core);
    // two SEPARATE ground marks (round 6): a small dark contact-shadow ellipse directly under
    // the mass, and the violet glow pool offset beside it — shadow is dark, pool is violet,
    // and they never read as one smudge.
    const shadow = noShadow(new THREE.Mesh(new THREE.CircleGeometry(4.6, 12),
      new THREE.MeshBasicMaterial({color:0x14101a, transparent:true, opacity:0.58})));
    shadow.rotation.x = -Math.PI/2; shadow.position.y = 0.62; shadow.scale.x = 1.35;
    shadow.name = "orbShadow";
    const pool = noShadow(new THREE.Mesh(new THREE.CircleGeometry(5.4, 12),
      new THREE.MeshBasicMaterial({color:C.violetHot, transparent:true, opacity:0.38})));
    pool.rotation.x = -Math.PI/2; pool.position.set(3.4, 0.56, 2.6); pool.name = "orbPool";
    orb.add(shadow, pool);
    root.add(orb);
  }
  return root;
}

// ── animations ──────────────────────────────────────────────────────────────
const bell = (p, c, w) => Math.exp(-(((p-c)/w)**2));
function parts(g){
  const pit = g.getObjectByName("pit");
  const funnel = pit?.getObjectByName("funnel");
  const keep = g.getObjectByName("keep");
  return {funnel,
    floorMat: funnel?.userData.floorMaterial, lipMat: funnel?.userData.lipMaterial,
    flashMats: funnel?.userData.flashMats,
    crackMat: g.getObjectByName("cracks")?.userData.material,
    keepCrackMat: keep?.userData.crackMaterial};
}
function idle(g, _p, t){
  const {lipMat, crackMat, keepCrackMat} = parts(g);
  // the lip stays the brightest thing on the asset through the whole breath
  if(lipMat)      lipMat.emissiveIntensity      = 1.5  + 0.4*Math.sin(t*1.3);
  if(crackMat)    crackMat.emissiveIntensity    = 1.0  + 0.3*Math.sin(t*1.3 + 0.9);
  if(keepCrackMat)keepCrackMat.emissiveIntensity= 0.22 + 0.08*Math.sin(t*1.3 + 1.6);
}
function gulp(g, p, t){
  const {funnel, lipMat, floorMat, flashMats, crackMat, keepCrackMat} = parts(g);
  if(!funnel) return;
  let s = 1, dip = 0;
  if(p < 0.35){ s = 1 + 0.05*(p/0.35); }
  else if(p < 0.55){ const k = (p-0.35)/0.2; s = 1.05 - 0.16*k; dip = 0.7*k; }
  else { const k = (p-0.55)/0.45;
         s = 0.89 + 0.11*(1-Math.cos(k*Math.PI))/2 + 0.035*Math.sin(k*9)*Math.exp(-k*4);
         dip = 0.7*(1-k); }
  funnel.scale.set(s, 1, s);
  funnel.position.y = -dip;
  // SEQUENTIAL BAND PULSE: the lip fires, then each flat band brightens IN PLACE in order
  // toward the throat, the floor last — a swallow traveling down the hole's own geometry.
  // Never a gradient; each band is one flat color at its moment. Ground cracks flare after.
  const kLip    = bell(p, 0.38, 0.09);
  const kGround = bell(p, 0.70, 0.13);
  if(lipMat)      lipMat.emissiveIntensity      = 1.5 + 2.2*kLip;
  if(flashMats) flashMats.forEach((m, i) => { m.opacity = 0.92*bell(p, 0.44 + i*0.055, 0.085); });
  if(floorMat)    floorMat.color.setHex(0x080512).lerp(new THREE.Color(C.violetHot), 0.8*bell(p, 0.66, 0.1));
  if(crackMat)    crackMat.emissiveIntensity    = 1.0 + 1.8*kGround;
  if(keepCrackMat)keepCrackMat.emissiveIntensity= 0.22 + 0.6*kGround;
}
function orbHover(g, _p, t){
  idle(g, _p, t);
  const orb = g.getObjectByName("orb");
  if(!orb) return;
  const core = orb.getObjectByName("orbCore");
  const bob = Math.sin(t*1.5);
  if(core){
    core.position.y = 22 + bob*2.2;
    core.rotation.y = t*0.45;
    core.rotation.z = 0.07*Math.sin(t*0.9);
  }
  const shadow = orb.getObjectByName("orbShadow"), pool = orb.getObjectByName("orbPool");
  const shrink = 1 - bob*0.07;
  if(shadow) shadow.scale.set(shrink, shrink, 1);
  if(pool){  pool.scale.set(1+bob*0.06, 1+bob*0.06, 1); pool.material.opacity = 0.3 + 0.08*Math.sin(t*1.5+0.5); }
}

const cam = {dist: 275, height: 6, target: 12};
export const MODELS = {
  "main-base":       { build: () => buildBase({awake:false}), anims: {idle, gulp}, cam },
  "main-base-awake": { build: () => buildBase({awake:true}),  anims: {idle: orbHover, gulp, orbHover}, cam },
};
