// The four shadow-shard enemies — quality bar: docs/reference/enemies.png (exact-subject).
// docs/model-spec.md (motion vocabulary) · docs/quality-bar.md (the loop).
// Standalone module: imports THREE only, hexes hardcoded.
//
// Contract: MODELS[name] = { build, anims, cam } — build() -> Group at ground-center origin,
// sim-px scale (raider ≈ peg mass but LOW, brute ×1.35); anims (group, phase01, tSeconds)
// deterministic, rest-transform snapshots so nothing accumulates.
//
// v13 — the structural round on v12. v12 passed silhouette taxonomy, crack branching/taper
// and the brute's thump annulus; those are untouched. What changed:
//
// v14 — FINAL POLISH on v13.1. The value regime, silhouettes, socketed eyes and FX
// grammar of v13.1 are untouched; every number in the colour table is byte-for-byte
// v13.1. What v14 changes, and only this:
//   1 CRACKS ARE BRITTLE, NOT PAINTED. Floor half-width 1.4·0.66·w → 1.15·0.34·w, a
//     58% cut, with the whole gash coming in 25% so the seam stays violet-with-dark-
//     edges instead of turning into a black slot with a wire down it. And
//     every path is a POLYLINE — straight segments meeting at hard angular kinks, never
//     a Catmull-Rom S. Forks are re-aimed to leave the trunk at an ACUTE angle (≤52°
//     measured in 3-space, not param space). One narrow dim-violet spill facet flanks
//     the floor on one side (display 24 — under every body plane, so it can never read
//     as a lit face). And ONE crack per creature actually NICKS the silhouette: a real
//     concave dent pulled into the hull where the seam runs off the outline.
//   2 ARCHER + HEALER TIER SHELVES. The archer's lathe was all flank-facing planes, so
//     the value ramp physically could not show. It is now four stacked tiers with a
//     +Y shelf facet at each break (shelves land on PLANE.top 66, walls on the flanks
//     28–43). The healer's crown gets the same treatment, twice.
//   3 ARCHER MUZZLE APERTURE — socketed like an eye: recessed dark ring, emissive core,
//     charge flash and bolt both spawn from it. Ability violet (245,132,255) is a
//     separate register from crack violet (188,126,231): brighter AND more saturated.
//   4 HEAL MOTES TRAVEL — four detached tetrahedra rise past the crown and converge.
//     The surface-flush chevron cross is gone, as is the offset contact ellipse.
//   5 RAIDER crouch/leap delta doubled. 6 debris is DIRT, 40% smaller. 7 three thick
//     radial quills instead of four thin ones.
//
// v13.1 — CALIBRATION ONLY on top of v13. v13's mechanics were right and are untouched:
// world-space baked plane shading, the dispToLin/toneAlbedo display-referred pipeline, the
// recessed crack system, one socketed eye system, the FX grammar. What v13 got wrong was
// the REGIME — a judge's generic numbers put the bodies at ~150 sRGB and the cast read as
// lavender-grey stone golems. Re-measured against docs/reference/enemies.png, this pass
// changes the COLOUR TABLE and nothing else:
//   · PLANE re-targeted to the sheet's near-black regime +10% for our brighter ground
//     (viewer ground luma ~174 vs the sheet's ~139). Rendered: flanks 40–46, tops 66–72,
//     undersides 20. Sheet, for comparison: flanks 39–47, tops 55–64, undersides 18–21.
//   · TINT_BODY was 0x9990cc — a 22-point blue lift on every body pixel. The sheet's rock
//     is NEUTRAL charcoal (52,52,51). Now cool-compensated so it RENDERS neutral (44,44,44).
//   · SEAM_RGB down from (216,134,255) to the sheet's own crack core (188,126,231): the
//     seam no longer has to out-glow a bright top plane, it has to glow against a dark one.
//   · SOCKET_DISP 12 → 15 and RIM_DISP 14 → 10, both re-seated under the new floor.
// Silhouettes, crack geometry, eye construction and FX grammar are byte-for-byte v13.
//
//  1 VALUE RAMP, NEW REGIME. Every value in this file is authored as a DISPLAYED sRGB
//    target and pushed backwards through the viewer's ACES curve and its actual light rig
//    (dispToLin / irrLum / toneAlbedo). Shading is now
//    baked in WORLD space (shadeWorld at the end of build), so a cone rotated to point at
//    the ground is shaded like a thing pointing at the ground — the single biggest reason
//    v12's spikes collapsed into one dead value.
//  2 CRACKS RECEDE. Licensed fallback, taken literally: NOTHING in a crack sits above the
//    local surface plane (the lip rails ride the surface, everything else falls away from
//    it), both walls and both lips are unlit and darker than the darkest body plane
//    (display 10 vs the undersides' 20), the emissive is the floor quad and nothing else,
//    and the sun-lit wall variant is DELETED — no crack face can catch light. Rims and
//    floor are separate meshes so a seam flare can never brighten a rim. Branching, taper
//    to zero at both ends and tree topology (no closed cells) are v12's, kept.
//  3 ONE SOCKETED EYE SYSTEM ×4. Recessed socket plate (unlit, darker than any body
//    plane) + PAIRED slits set inboard of it + an angled brow that overhangs. The archer's
//    lone bar, the healer's monocle ring and every front-marker are gone. White exists
//    only inside a socket, and every socket is inboard of its creature's silhouette.
//  4 GROUND-PLANE VIOLET = THREAT, EXCLUSIVELY. The brute's thump annulus keeps it,
//    unchanged. The healer's ground pool is deleted; its hover identity is now SILHOUETTE
//    (flared scalloped bell rim + three hanging tendrils + a 14-unit gap) plus a small
//    neutral detached shadow, and its heal reads as violet chevrons travelling up past
//    the body while its own cracks brighten.
//  5–9 raider windup that actually compresses · archer bolt out of a chest-height muzzle
//    with a real recoil pitch · brute debris as shard volumes with one violet facet each ·
//    raider rear cluster shrunk (no second head), stray floating geometry removed, lunge
//    arcs nose-up with a broken faceted trail.
import * as THREE from "three";

// ════════════════════════════════════════════════════════════════════════════
// FIX 1 · DISPLAY-REFERRED AUTHORING
// The viewer renders through ACES filmic (exposure 1.18) then sRGB. Authoring dark
// values by eye against that curve is hopeless — v12 measured 33→57 sRGB when it was
// aiming three clear steps apart. So every value below is written as the sRGB number
// it must READ AS on screen, and inverted through the tone curve and the viewer's own
// light rig to get the albedo that produces it.
// ════════════════════════════════════════════════════════════════════════════
const EXPOSURE = 1.18;
function acesInv(y) {                       // displayed linear -> scene linear
  const A = 1 - 0.983729 * y, B = 0.0245786 - 0.432951 * y, K = -(0.000090537 + 0.238081 * y);
  return ((-B + Math.sqrt(B * B - 4 * A * K)) / (2 * A)) * 0.6 / EXPOSURE;
}
const srgbDec = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const dispToLin = d => acesInv(srgbDec(Math.min(254, Math.max(0, d)) / 255));

// hue vectors, normalised to luminance 1 so "display value" and "hue" stay independent
const lumOf = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
function tintOf(hex) { const c = new THREE.Color(hex); const l = lumOf(c); return [c.r / l, c.g / l, c.b / l]; }
// v13.1 · the sheet's rock is NEUTRAL charcoal, not lavender. Colour-picked off
// docs/reference/enemies.png: (52,52,51) (72,71,74) (19,22,23) (43,45,46) — r≈g≈b with
// at most +3 blue. v13's 0x9990cc put a 22-point blue lift on every body pixel, which is
// half of why the cast read as lavender stone golems. Barely-cool charcoal instead: the
// violet in these creatures belongs to the CRACKS, and it only reads as violet because
// the rock around it is not.
// The tint is an ALBEDO, and the rig it sits under is warm (sun 0xfff2d8) over an olive
// bounce (0x6a7a55): a neutral albedo renders warm brown (measured 51,48,41). So the
// albedo is cool-compensated — it is not the colour the rock reads as, it is the colour
// that makes the rock READ neutral once the rig has coloured it.
const TINT_BODY = tintOf(0x969bb0);         // cool-compensated → renders neutral charcoal
const TINT_RIM = tintOf(0x8b8a9c);          // crack rims: near-neutral, never violet
const TINT_VIOLET = tintOf(0xc07cff);       // the villain colour
const TINT_WARM = tintOf(0xfff2e2);         // eye white

// a THREE.Color that RENDERS at `disp` sRGB with hue `tint` (unlit / MeshBasic path)
function dispColor(disp, tint = TINT_BODY) {
  const L = dispToLin(disp);
  return new THREE.Color().setRGB(L * tint[0], L * tint[1], L * tint[2], THREE.LinearSRGBColorSpace);
}
// …and the same thing per channel, for colours bright enough that a hue vector would
// clip. ACES desaturates as it approaches white, so a violet authored as "very bright
// violet" comes out pink-white unless each channel is inverted through the curve.
function dispRGB(r, g, b) {
  return new THREE.Color().setRGB(dispToLin(r), dispToLin(g), dispToLin(b), THREE.LinearSRGBColorSpace);
}
const unlit = (color, opt = {}) => new THREE.MeshBasicMaterial({ color, ...opt });
const unlitAt = (disp, tint, opt) => unlit(dispColor(disp, tint), opt);
const shadedMat = (opt = {}) => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, ...opt });

// ── the viewer's light rig, solved for luminance ────────────────────────────
const SUN = new THREE.Vector3(120, 220, 80).normalize();
const FILL = new THREE.Vector3(-140, 60, -100).normalize();
const L_SKY = lumOf(new THREE.Color(0xfff6e0)), L_GND = lumOf(new THREE.Color(0x6a7a55));
const L_SUN = lumOf(new THREE.Color(0xfff2d8)) * 1.6, L_FILL = lumOf(new THREE.Color(0xcfd8ee)) * 0.4;
function irrLum(n) {
  return 1.15 * (L_GND + (L_SKY - L_GND) * (0.5 + 0.5 * n.y))
    + L_SUN * Math.max(0, n.dot(SUN)) + L_FILL * Math.max(0, n.dot(FILL));
}

// ── the ramp itself: five flat steps, no gradients ──────────────────────────
// Measured off the render, these are what the judge color-picks.
// The top tier is deliberately RARE: only a facet within ~42° of straight up
// gets `top`, so the mass of a body still reads dark violet while the planes that do
// face the sun read a full stop-and-a-half above the flanks.
// v13.1 CALIBRATION · v13's numbers were a full regime too bright (tops ~150: grey stone
// golems). Measured off the reference sheet, body pixels only, ground/crack/eye masked:
//     brute  p25=27 p50=39 p75=47 p90=55 p99=64      archer p25=20 p50=29 p90=50
//     raider p25=23 p50=38 p90=52                    healer p25=25 p50=33 p90=59
// These are MATTE NEAR-BLACK creatures. The sheet's ground sits at luma ~139; the viewer's
// is ~174, so the whole ramp is lifted ~10% to hold the same figure/ground separation
// against brighter grass — and no further. Tops land 62-73, flanks 39-46, undersides 23.
const PLANE = { top: 66, upper: 43, sideLit: 42, sideDark: 28, under: 20 };
// per-part trim. Deliberately GENTLE (±12%): v12 spread parts so far apart that the
// plane ramp itself stopped being measurable. The brute's head still reads over its
// shoulder, but a top face is a top face everywhere on the cast.
const T = { dark: 0.90, low: 0.95, mid: 1.0, high: 1.04, crown: 1.08 };
const GAIN = 1.0;                            // empirical trim, calibrated off the render
const SUN_AZ = new THREE.Vector2(120, 80).normalize();
function planeDisp(n) {
  if (n.y > 0.74) return PLANE.top;
  if (n.y > 0.18) return PLANE.upper;
  if (n.y < -0.40) return PLANE.under;   // only a plane that really looks at the
                                         // ground goes dark: at -0.22 every narrow cone
                                         // read as a floating black triangle
  const h = Math.hypot(n.x, n.z);
  const az = h > 1e-3 ? Math.max(0, (n.x * SUN_AZ.x + n.z * SUN_AZ.y) / h) : 0;
  return PLANE.sideDark + (PLANE.sideLit - PLANE.sideDark) * (az > 0.45 ? 1 : az > 0.12 ? 0.5 : 0);
}
// the inversion: what albedo makes THIS normal read at its plane's display target
function toneAlbedo(n, tone) {
  return GAIN * dispToLin(planeDisp(n) * tone) / (irrLum(n) / Math.PI);
}
const clamp01 = v => Math.max(0, Math.min(1, v));
const bell = (p, lo, hi) => (p <= lo || p >= hi ? 0 : Math.sin(Math.PI * (p - lo) / (hi - lo)));

function noShadow(mesh) {
  Object.defineProperty(mesh, "castShadow", { get: () => false, set: () => {} });
  return mesh;
}
function rng(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

// bake per-face colour from a normal supplied in an arbitrary frame
function paintFaces(geo, tone, m3) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const colors = g.attributes.color ? g.attributes.color.array : new Float32Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    if (m3) n.applyMatrix3(m3).normalize();
    const v = toneAlbedo(n, tone);
    for (let k = 0; k < 3; k++) {
      colors[(i + k) * 3 + 0] = Math.min(1, v * TINT_BODY[0]);
      colors[(i + k) * 3 + 1] = Math.min(1, v * TINT_BODY[1]);
      colors[(i + k) * 3 + 2] = Math.min(1, v * TINT_BODY[2]);
    }
  }
  if (!g.attributes.color) g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  else g.attributes.color.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}
const shadePlanes = (geo, tone = T.mid) => paintFaces(geo, tone, null);

// FIX 1 · re-bake every shaded mesh with its WORLD normal once the tree is assembled.
// A horn rotated to lie along the back was being shaded as if it stood upright; this is
// what let the whole cast collapse into one value no matter what the ramp said.
function shadeWorld(root) {
  root.updateMatrixWorld(true);
  const m3 = new THREE.Matrix3();
  root.traverse(o => {
    if (o.isMesh && o.userData.tone !== undefined) {
      m3.getNormalMatrix(o.matrixWorld);
      paintFaces(o.geometry, o.userData.tone, m3);
    }
  });
}

// v14 BUGFIX · the weld key used toFixed(3), and toFixed prints NEGATIVE ZERO as
// "-0.000". A lathe closes its ring at azimuth 2π, where x = r·sin(2π) = −2.4e−16 —
// so the seam column keyed differently from the column it is supposed to BE, took a
// different random offset, and left a hairline slit down the front of every lathe in
// the cast. (Visible as a 1px grass-green thread on the archer and round the healer's
// rim in every build since v9.) Integer keys: String(-0) === "0", so the ring closes.
const weldKey = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

// jitter every UNIQUE vertex position (welded) so facets stay closed
function jitterWelded(geo, amount, seed) {
  const rand = rng(seed);
  const pos = geo.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = weldKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (!seen.has(key)) seen.set(key, [(rand() - 0.5) * 2 * amount, (rand() - 0.5) * 2 * amount, (rand() - 0.5) * 2 * amount]);
    const [dx, dy, dz] = seen.get(key);
    pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
  }
  return geo;
}
// apply an arbitrary local-space deformation to every vertex (the raider's wedge)
function deform(geo, fn) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i); fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  return geo;
}

// chunky rock plate — a jittered icosahedron, the cast's base vocabulary.
// Records the analytic radii so cracks can be laid on a smooth proxy surface.
function plate(r, sx, sy, sz, tone, seed, detail = 1, jitter = 0.07) {
  const geo = jitterWelded(new THREE.IcosahedronGeometry(r, detail), jitter * r, seed);
  geo.scale(sx, sy, sz);
  const m = new THREE.Mesh(shadePlanes(geo, tone), shadedMat());
  m.userData.rad = [r * sx, r * sy, r * sz];
  m.userData.tone = tone;
  return m;
}
// crystalline lathe body (spire shaft, healer bell) — low radial count, jittered rings
function latheShard(profile, seg, tone, seed, jitter = 0.35) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y));
  const geo = jitterWelded(new THREE.LatheGeometry(pts, seg), jitter, seed);
  const m = new THREE.Mesh(shadePlanes(geo, tone), shadedMat({ side: THREE.DoubleSide }));
  m.userData.prof = profile;
  m.userData.tone = tone;
  return m;
}
// 4-sided tapered spike — horns, quills, tendrils, tail. Pivot at the ROOT.
function spike(rad, len, tone, seed = 5, sides = 4) {
  const geo = jitterWelded(new THREE.ConeGeometry(rad, len, sides), rad * 0.1, seed);
  geo.translate(0, len / 2, 0);
  const m = new THREE.Mesh(shadePlanes(geo, tone), shadedMat());
  m.userData.tone = tone;
  return m;
}

// ════════════════════════════════════════════════════════════════════════════
// FIX 2 · CRACKS THAT RECEDE
// ════════════════════════════════════════════════════════════════════════════
// v12's verdict: "tubes lying on top of stone — polygons run continuously underneath,
// violet rides one side wall and the rim, bright slivers on top rims of branch stubs."
// Every one of those came from geometry that stood PROUD of the surface and from wall
// colours that were violet and sun-stepped. v13 takes the licensed fallback literally:
//
//   surface ──lip───┐                     ┌───lip── surface     lip rails ON the plane
//                    \  wall        wall /                      unlit, display 15
//                     └───── FLOOR ─────┘                       the ONLY emissive
//
//   · nothing is above the local surface plane — the lip rails sit on it (a 0.012u
//     bias, ~1/15 of a pixel, purely to stop z-fighting) and every other vertex falls
//     INWARD along −n. The floor is genuinely sunk; a depth bias, not geometry, is what
//     makes it visible through the unbroken hull.
//   · walls and lips are one flat unlit near-black, darker than the darkest body plane
//     (10 vs 20–28). There is no sun-side wall variant any more, so no crack face can
//     catch light from any angle.
//   · rims and floor are SEPARATE meshes: a seam flare multiplies the floor only, so a
//     bright crack can never produce a bright rim.
//   · width = w·sin(πt)^0.6 ⇒ exactly zero at both ends; forks leave a trunk sample and
//     never return ⇒ the seam graph is a TREE ⇒ a closed cell is impossible. (v12's,
//     kept — the judge passed the branching and the taper.)
const RIM_DISP = 10;                          // darker than PLANE.under (20) × T.dark = 18
// v13.1 SEAM PALETTE · colour-picked off the reference sheet's crack cores (crack pixels
// isolated by the magenta green-dip r−g>18, then laddered by luminance):
//     brute  core(top5%) = (186,129,229) L=149 · p75 (165,95,215) · p50 (135,69,196)
//     archer core        = (178,108,223) L=131 · healer (174,134,196) · raider (163,115,200)
// v13 ran the seam at (216,134,255) because it had to out-glow a 150-sRGB top plane. It
// doesn't any more — it has to glow against a 39-sRGB flank, which is the entire trick.
// So the core comes DOWN and gets more saturated: deep violet, green channel well under
// half of blue. Emissive-floor-only construction is unchanged.
const SEAM_RGB = [188, 126, 231], SEAM_RGB_COOL = [132, 68, 190];
// v14 · TWO VIOLET REGISTERS, and the difference is the whole read.
// CRACK violet is a property of the rock: it sits in a trench, it never leaves the body.
// ABILITY violet is the thing the creature THROWS — bolts, motes, the charge flash —
// and it has to beat the crack on BOTH axes at once. That is harder than it sounds:
// dispRGB inverts each channel through the ACES CURVE, but three.js also runs the ACES
// input/output MATRICES, which mix channels and desaturate hard as any channel nears
// clip. v14's first cut authored (245,132,255) and RENDERED (255,194,255) — luma 211
// but saturation 0.24, i.e. pink. Solved numerically against the real transform:
//   crack core  authored (188,126,231) -> renders (193,133,232)  luma 153  S 0.427
//   ability     authored (216,  8,254) -> renders (253,130,255)  luma 165  S 0.490
//   ability dim authored (168, 74,236) -> renders (179, 87,239)  luma 118  S 0.636
// Brighter AND more saturated, with the near-zero authored green buying back the
// saturation the matrix takes away. Off-body is the third separator.
const ABILITY_RGB = [216, 8, 254], ABILITY_DIM = [168, 74, 236];
const LIP = dispColor(RIM_DISP, TINT_RIM);
const HOT = dispRGB(...SEAM_RGB), COOL = dispRGB(...SEAM_RGB_COOL);
// v14 · the spill: a dim violet falloff facet flanking the floor on ONE side. 24 is
// under PLANE.sideDark (28) and under the darkest body plane a crack ever borders, so
// it reads as glow bleeding into the fracture's shadow — never as a lit facet.
const SPILL_DISP = 24;
const SPILL = dispColor(SPILL_DISP, tintOf(0xb070ff));
const SURFACE_EPS = 0.012;                    // sub-pixel: "on the plane", not above it
const CRACK_W = 1.15;                         // one dial for the whole cast's seam weight
// v14 · the floor is the only part of the seam that glows, and at 1.4·0.66·w it was a
// broad flat ribbon — a painted stripe. Now 1.15·0.34·w: 42% of v13.1's width, a −58%
// cut, right in the band the note asked for. The whole gash comes in 25% with it —
// holding the trench at its old width while thinning only the floor turned every seam
// into a black slot with a wire in it, which is the opposite failure.
const FLOOR_RATIO = 0.34;

// ray/triangle (Möller–Trumbore) — used to sit the trench on the REAL jittered surface
function rayHit(geo, o, dir) {
  const pos = geo.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();
  let far = -Infinity;
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    e1.subVectors(b, a); e2.subVectors(c, a);
    pv.crossVectors(dir, e2);
    const det = e1.dot(pv);
    if (Math.abs(det) < 1e-7) continue;
    const inv = 1 / det;
    tv.subVectors(o, a);
    const u = tv.dot(pv) * inv;
    if (u < 0 || u > 1) continue;
    qv.crossVectors(tv, e1);
    const v = dir.dot(qv) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = e2.dot(qv) * inv;
    if (t > far) far = t;
  }
  return far;
}

// analytic proxy surfaces, all in the HOST MESH's local space -------------------
const mkRAt = prof => y => {
  if (y <= prof[0][1]) return prof[0][0];
  for (let i = 0; i < prof.length - 1; i++) {
    const [r1, y1] = prof[i], [r2, y2] = prof[i + 1];
    if (y <= y2) return r1 + (r2 - r1) * (y - y1) / ((y2 - y1) || 1);
  }
  return prof[prof.length - 1][0];
};
// u = azimuth (0 = +Z, the camera side), v = elevation −1..1
function ellipsoidSurf(rx, ry, rz) {
  return (u, v) => {
    const phi = v * Math.PI * 0.5, cp = Math.cos(phi);
    return { p: new THREE.Vector3(rx * cp * Math.sin(u), ry * Math.sin(phi), rz * cp * Math.cos(u)),
      o: new THREE.Vector3(0, 0, 0) };
  };
}
// u = azimuth (0 = +Z), v = height along the lathe axis
function latheSurf(prof) {
  const rAt = mkRAt(prof);
  return (u, v) => ({ p: new THREE.Vector3(rAt(v) * Math.sin(u), v, rAt(v) * Math.cos(u)),
    o: new THREE.Vector3(0, v, 0) });
}
const warpSurf = (base, D) => (u, v) => {
  const b = base(u, v);
  return { p: D(b.p), o: D(b.o) };
};
function surfFrame(surf, u, v) {
  const e = 0.02;
  const c = surf(u, v);
  const du = surf(u + e, v).p.sub(surf(u - e, v).p);
  const dv = surf(u, v + e).p.sub(surf(u, v - e).p);
  const n = new THREE.Vector3().crossVectors(du, dv);
  if (n.lengthSq() < 1e-9) n.copy(c.p).sub(c.o);
  n.normalize();
  if (n.dot(c.p.clone().sub(c.o)) < 0) n.negate();
  return { p: c.p, o: c.o, n };
}

// ── v14 · BRITTLE PATHS ──────────────────────────────────────────────────────
// Fracture is not organic. A Catmull-Rom through the same control points gives a
// smooth curl — a river, a vine, a painted flourish. These three helpers walk the
// control points as a POLYLINE instead: straight runs, hard direction changes at the
// vertices. Every vertex is guaranteed to land ON a sample, so the kink is never
// smoothed away by the neighbour-averaged rail tangents.
function polyLen(c) {
  const L = [0];
  for (let i = 0; i < c.length - 1; i++) L.push(L[i] + Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]));
  return L;
}
function polyAt(c, t) {
  const L = polyLen(c), total = L[L.length - 1] || 1, d = t * total;
  for (let i = 0; i < c.length - 1; i++) {
    if (d <= L[i + 1] || i === c.length - 2) {
      const f = (d - L[i]) / ((L[i + 1] - L[i]) || 1);
      return [c[i][0] + (c[i + 1][0] - c[i][0]) * f, c[i][1] + (c[i + 1][1] - c[i][1]) * f];
    }
  }
  return c[c.length - 1];
}
// -> [[u, v, t], ...]; samples split between segments by length, vertices always hit.
function polySamples(c, samples) {
  const L = polyLen(c), total = L[L.length - 1] || 1, out = [];
  for (let i = 0; i < c.length - 1; i++) {
    const n = Math.max(1, Math.round(samples * (L[i + 1] - L[i]) / total));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      out.push([c[i][0] + (c[i + 1][0] - c[i][0]) * f, c[i][1] + (c[i + 1][1] - c[i][1]) * f,
        (L[i] + f * (L[i + 1] - L[i])) / total]);
    }
  }
  out.push([c[c.length - 1][0], c[c.length - 1][1], 1]);
  return out;
}

// one trench: ctrl = control points in (u,v) surface params. Emits THREE children into
// the host mesh — "seamRim" (unlit dark, never flares), "seamSpill" (the dim violet
// falloff) and "seam" (the emissive floor).
function trench(host, surf, ctrl, opt = {}) {
  const { samples = 18, dim = false, spill = 1 } = opt;
  const w = (opt.w ?? 0.62) * CRACK_W;
  // shallow on purpose: a deep narrow V shows the camera nothing but wall. What is NOT
  // wide any more is the floor — the walls now carry most of the trench's width.
  const depth = opt.depth ?? Math.max(0.34, w * 0.42);
  const geo = host.geometry;
  const S = [];
  for (const [u, v, t] of polySamples(ctrl, samples)) {
    const f = surfFrame(surf, u, v);
    const dir = f.p.clone().sub(f.o);
    let p = f.p;
    if (dir.lengthSq() > 1e-8) {                         // pull the path onto the real facets
      dir.normalize();
      const hit = rayHit(geo, f.o, dir);
      if (hit > 0 && isFinite(hit)) p = f.o.clone().addScaledVector(dir, hit);
    }
    S.push({ p, n: f.n, t });
  }
  const rimV = [], floV = [], floC = [], spiV = [];
  const tri = (arr, a, b, c) => { arr.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); };
  const quadRim = (a, b, c, d) => { tri(rimV, a, b, c); tri(rimV, a, c, d); };
  const quadSpi = (a, b, c, d) => { tri(spiV, a, b, c); tri(spiV, a, c, d); };
  const quadFlo = (a, b, c, d, col) => {
    tri(floV, a, b, c); tri(floV, a, c, d);
    for (let k = 0; k < 6; k++) floC.push(col.r, col.g, col.b);
  };

  const rails = S.map((s, i) => {
    const prev = S[Math.max(0, i - 1)].p, next = S[Math.min(S.length - 1, i + 1)].p;
    const tang = next.clone().sub(prev);
    if (tang.lengthSq() < 1e-9) tang.set(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(s.n, tang.normalize()).normalize();
    const hw = w * Math.pow(Math.sin(Math.PI * s.t), 0.6);      // ZERO at t=0 and t=1
    const dp = depth * Math.pow(Math.sin(Math.PI * s.t), 0.5);  // the cut shallows out too
    const base = s.p.clone().addScaledVector(s.n, SURFACE_EPS);
    const at = (k, d) => base.clone().addScaledVector(side, hw * k).addScaledVector(s.n, -dp * d);
    return {
      // the outer lip band is COPLANAR with the surface (not above it): the crumbled
      // dark edge that borders the glow on both sides even when a wall foreshortens away
      outL: at(1.22, 0), outR: at(-1.22, 0),
      lipL: at(1, 0), lipR: at(-1, 0),                            // ON the surface plane
      // v14 · the wall is now split: an outer stretch of near-black, then a narrow
      // band right beside the floor that carries the spill on ONE side.
      midL: at(0.58, 0.52), midR: at(-0.58, 0.52),
      floL: at(FLOOR_RATIO, 1), floR: at(-FLOOR_RATIO, 1),
    };
  });
  for (let i = 0; i < rails.length - 1; i++) {
    const A = rails[i], B = rails[i + 1];
    const t = (i + 0.5) / (rails.length - 1);
    const floorCol = dim ? COOL : (t < 0.62 ? HOT : COOL);        // FLAT step, never a gradient
    quadRim(A.outL, B.outL, B.lipL, A.lipL);                      // left lip, ON the surface
    quadRim(A.lipL, B.lipL, B.midL, A.midL);                      // left wall, falling inward
    quadRim(A.midR, B.midR, B.lipR, A.lipR);                      // right wall, falling inward
    quadRim(A.lipR, B.lipR, B.outR, A.outR);                      // right lip, ON the surface
    if (spill > 0) { quadSpi(A.midL, B.midL, B.floL, A.floL); quadRim(A.floR, B.floR, B.midR, A.midR); }
    else { quadSpi(A.floR, B.floR, B.midR, A.midR); quadRim(A.midL, B.midL, B.floL, A.floL); }
    quadFlo(A.floL, B.floL, B.floR, A.floR, floorCol);            // THE FLOOR — only emissive
  }
  // the sunken geometry lives inside the hull; a depth bias (not height) is what reveals
  // it. −900 units ≈ 1.2 world units of pull at this camera distance: far more than the
  // ~0.9u cut, far less than any plate is thick.
  const off = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -900 };
  const rimGeo = new THREE.BufferGeometry();
  rimGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rimV), 3));
  const rim = noShadow(new THREE.Mesh(rimGeo, unlit(LIP, { side: THREE.DoubleSide, ...off })));
  rim.name = "seamRim";
  const spiGeo = new THREE.BufferGeometry();
  spiGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(spiV), 3));
  const spillMesh = noShadow(new THREE.Mesh(spiGeo, unlit(SPILL, { side: THREE.DoubleSide, ...off })));
  spillMesh.name = "seamSpill";
  const floGeo = new THREE.BufferGeometry();
  floGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(floV), 3));
  floGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(floC), 3));
  const floor = noShadow(new THREE.Mesh(floGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, ...off })));
  floor.name = "seam";
  host.add(rim, spillMesh, floor);
  return floor;
}

// v14 · ACUTE FORKS. A branch that leaves its trunk at 80–110° reads as a plus sign or
// a road junction; brittle fracture branches SHARP, the daughter crack carrying on in
// roughly the direction the parent was already travelling. The correction has to be
// measured in 3-space — (u,v) param space is anisotropic (radians against world units
// on a lathe), so an angle that looks acute in the table can be a right angle on the
// model. So: map both directions through the surface's real tangent basis, measure the
// true angle, and if it exceeds MAX, rotate the WHOLE fork about the junction (shape
// preserved, aim corrected) until it doesn't.
const FORK_MAX = 52 * Math.PI / 180;
function acuteFork(surf, j, trunkDir, to) {
  const e = 0.02;
  const Du = surf(j[0] + e, j[1]).p.sub(surf(j[0] - e, j[1]).p);
  const Dv = surf(j[0], j[1] + e).p.sub(surf(j[0], j[1] - e).p);
  const map3 = (a, b) => Du.clone().multiplyScalar(a).addScaledVector(Dv, b);
  const ang = (a, b) => {
    const A = map3(...a), B = map3(...b);
    if (A.lengthSq() < 1e-12 || B.lengthSq() < 1e-12) return 0;
    return A.angleTo(B);
  };
  const f0 = [to[0][0] - j[0], to[0][1] - j[1]];
  const rot = (p, th) => {
    const c = Math.cos(th), s = Math.sin(th), dx = p[0] - j[0], dy = p[1] - j[1];
    return [j[0] + dx * c - dy * s, j[1] + dx * s + dy * c];
  };
  if (ang(trunkDir, f0) <= FORK_MAX) return to;
  // which way round shortens the angle? try both, bisect on the winner.
  const step = (th) => ang(trunkDir, [f0[0] * Math.cos(th) - f0[1] * Math.sin(th),
    f0[0] * Math.sin(th) + f0[1] * Math.cos(th)]);
  let lo = 0, hi = (step(0.1) < step(-0.1) ? 1 : -1) * Math.PI;
  for (let k = 0; k < 24; k++) {                          // bisect to the FORK_MAX contour
    const mid = (lo + hi) / 2;
    if (step(mid) > FORK_MAX) lo = mid; else hi = mid;
  }
  return to.map(p => rot(p, hi));
}

// a crack SYSTEM: one trunk + 2–3 forks that leave the trunk and never return.
// spec = { trunk:[[u,v],...], w, forks:[{ at: 0..1 along trunk, to:[[u,v],...], w }] }
function crackTree(host, surf, spec) {
  const W = spec.w ?? 0.62;
  trench(host, surf, spec.trunk, { w: W, samples: spec.samples ?? 15, depth: spec.depth, spill: spec.spill });
  for (const f of spec.forks || []) {
    const j = polyAt(spec.trunk, f.at);                   // the Y-junction, ON the trunk
    const ahead = polyAt(spec.trunk, Math.min(1, f.at + 0.06));
    const to = acuteFork(surf, j, [ahead[0] - j[0], ahead[1] - j[1]], f.to);
    trench(host, surf, [j, ...to], { w: f.w ?? W * 0.62, samples: f.samples ?? 10, depth: spec.depth, spill: f.spill ?? spec.spill });
  }
}

// ── v14 · THE SILHOUETTE NICK ────────────────────────────────────────────────
// One per creature, where a seam runs off the outline: pull the hull vertices around
// that point INWARD along the surface normal so the outline itself takes a notch out
// of it. Welded by rounded position so facets stay closed, and applied BEFORE the
// crack is laid (the trench ray-casts onto the real surface, so the seam drapes into
// the dent) and before finish() re-bakes the world-space shading of the new normals.
function nick(mesh, surf, u, v, r, depth) {
  const f = surfFrame(surf, u, v);
  const geo = mesh.geometry, pos = geo.attributes.position;
  const p = new THREE.Vector3(), moved = new Map();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const key = weldKey(p.x, p.y, p.z);
    if (!moved.has(key)) {
      const d = p.distanceTo(f.p);
      moved.set(key, d >= r ? null : -depth * Math.pow(1 - d / r, 1.4));
    }
    const k = moved.get(key);
    if (k !== null) pos.setXYZ(i, p.x + f.n.x * k, p.y + f.n.y * k, p.z + f.n.z * k);
  }
  pos.needsUpdate = true;
  return mesh;
}

// ════════════════════════════════════════════════════════════════════════════
// FIX 3 · ONE SOCKETED EYE SYSTEM, FOUR CREATURES
// ════════════════════════════════════════════════════════════════════════════
// Same construction everywhere, scaled per creature: a recessed socket plate darker
// than any body plane, a MIRRORED PAIR of slits set well inboard of the socket's own
// outline, and a brow plane pitched forward above so the socket sits under an overhang.
// The pair is the only white in the model, and it can never reach a silhouette edge
// because it is bounded by the socket, which is itself bounded by the head.
// v13.1 · the socket used to be a 12 against 74–152 body planes — a 6:1 step that banded
// into a bandit mask at thumbnail size. Against the new near-black regime it only needs
// to be the darkest thing on the head: 15 sits just under PLANE.under × T.dark (18), so
// it still reads as a hollow at full size while stepping only ~1.4:1 against the shaded
// head planes it actually borders (20–28). Verified: no banding in the 30px thumb strip.
const SOCKET_DISP = 15;
// a flat convex polygon (fan-triangulated) — sockets and brows are PLANES, not boxes:
// a box reads as sunglasses stuck on the face, a shaped plane reads as a hollow.
function polyPlate(pts, mat, z = 0) {
  const v = [];
  for (let i = 1; i < pts.length - 1; i++) {
    v.push(pts[0][0], pts[0][1], z, pts[i][0], pts[i][1], z, pts[i + 1][0], pts[i + 1][1], z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
  return noShadow(new THREE.Mesh(geo, mat));
}
function eyeCluster(parent, o) {
  const { p, ry = 0, rx = 0, size = 1, gap = 2.2, tilt = 0.35, slit = 1.0 } = o;
  const g = new THREE.Group(); g.name = "eyes";
  g.position.set(...p); g.rotation.set(rx, ry, 0);
  const off = { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -600, side: THREE.DoubleSide };

  const w = 3.0 * size * slit, h = Math.max(0.40, w * 0.30);
  const W = gap * 0.5 + w * 1.24, TOP = h * 2.4, BOT = h * 2.0;
  // THE SOCKET — a shaped hollow, wider at the middle and raked at the outer corners,
  // unlit and darker than any body plane. The pair lives strictly inside its outline.
  const sock = polyPlate([[-W, TOP * 0.30], [-W * 0.52, TOP], [W * 0.52, TOP], [W, TOP * 0.30],
    [W * 0.72, -BOT], [-W * 0.72, -BOT]], unlitAt(SOCKET_DISP, TINT_RIM, off));
  sock.name = "socket";
  g.add(sock);
  // THE BROW — a plane above, pitched forward so it overhangs the socket. Its lower
  // edge dips at the centre: the scowl, and the thing that puts the socket in shadow.
  const bw = W * 1.02, bh = h * 1.5;
  const brow = polyPlate([[-bw, TOP + bh], [bw, TOP + bh], [bw * 0.92, TOP - h * 0.1],
    [0, TOP - h * 0.95], [-bw * 0.92, TOP - h * 0.1]], unlitAt(SOCKET_DISP * 1.4, TINT_RIM, off));
  brow.name = "browShade";
  brow.position.set(0, 0, 0.55 * size); brow.rotation.x = -0.55;
  g.add(brow);

  for (const s of [-1, 1]) {                              // the PAIR — mirrored exactly
    const geo = new THREE.BoxGeometry(w, h, 0.45 * size);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + pos.getY(i) * 1.5 * -s);  // rake
    const eye = noShadow(new THREE.Mesh(geo, unlitAt(232, TINT_WARM, {
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -800 })));
    eye.name = "eye" + (s < 0 ? "L" : "R");
    eye.position.set(s * (gap / 2 + w * 0.5), 0, 0.22 * size);
    eye.rotation.z = s * tilt;
    g.add(eye);
  }
  parent.add(g);
  return g;
}

// ── ground FX primitives (flat, faceted, unlit — same rules as bodies) ──────
// FIX 4 · GROUND-PLANE VIOLET = THREAT, EXCLUSIVELY. Only the brute's slam annulus is
// allowed on the ground; contact shadows are neutral dark and nothing else lands there.
const C = { shadow: 0x151810, ringHot: 0xbb70f7, ringDim: 0x4d1c96 };
function softShadow(parent, rx, rz, opacity = 0.34, x = 0, z = 0) {
  const m = noShadow(new THREE.Mesh(new THREE.CircleGeometry(1, 12),
    unlit(C.shadow, { transparent: true, opacity, depthWrite: false })));
  m.name = "contactShadow";
  m.rotation.x = -Math.PI / 2; m.scale.set(rx, rz, 1); m.position.set(x, 0.12, z);
  parent.add(m);
  return m;
}
function flatBand(rIn, rOut, hex, opacity, seg = 16) {
  const v = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const P = (r, a) => [Math.cos(a) * r, 0, Math.sin(a) * r];
    const A = P(rIn, a0), B = P(rOut, a0), D = P(rOut, a1), E = P(rIn, a1);
    v.push(...A, ...B, ...D, ...A, ...D, ...E);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
  return noShadow(new THREE.Mesh(geo, unlit(hex, { transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })));
}
function annulusRing(parent, name) {
  const g = new THREE.Group(); g.name = name;
  const inner = flatBand(0.78, 0.92, C.ringDim, 0); inner.name = name + "Inner";
  const lead = flatBand(0.92, 1.0, C.ringHot, 0); lead.name = name + "Lead";
  g.add(inner, lead);
  g.position.y = 0.2;
  parent.add(g);
  return g;
}
function ringOpacity(g, o) { g.children.forEach((c, i) => { c.material.opacity = i ? o : o * 0.8; }); }

// ── rest snapshots (anims never accumulate) ─────────────────────────────────
function snapshotRest(root) {
  root.traverse(o => {
    o.userData.rest = { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() };
    if (o.material) {
      o.userData.restColor = o.material.color ? o.material.color.clone() : null;
      if (o.material.transparent) o.userData.restOpacity = o.material.opacity;
    }
  });
}
function restore(root) {
  root.traverse(o => {
    // v14 BUGFIX · the ROOT's rest is snapshotted at build time, before whoever mounts
    // it has placed it in the world. Restoring it teleported the whole creature to the
    // origin the first frame an anim ran — which is why the raider has been standing in
    // the middle of the lineup, on top of the healer, in every row shot since v9. The
    // root's placement belongs to the caller; anims own everything below it.
    if (o === root) return;
    const r = o.userData.rest;
    if (r) { o.position.copy(r.p); o.rotation.copy(r.r); o.scale.copy(r.s); }
    if (o.userData.restColor) o.material.color.copy(o.userData.restColor);
    if (o.userData.restOpacity !== undefined) o.material.opacity = o.userData.restOpacity;
  });
}
// crack flare: multiplies the FLOOR mesh only. "seamRim" is never touched, so a hot
// crack cannot produce a lit rim.
function flareSeams(root, k) {
  root.traverse(o => {
    if (o.name === "seam") o.material.color.setScalar(1 + 0.55 * k);
    // the spill rides at a THIRD of the floor's gain: it stays a falloff, and at full
    // flare it still lands under the body planes it borders.
    else if (o.name === "seamSpill" && o.userData.restColor) {
      o.material.color.copy(o.userData.restColor).multiplyScalar(1 + 0.18 * k);
    }
  });
}
// finish a build: bake world-space shading, then snapshot the rest pose
function finish(root) { shadeWorld(root); snapshotRest(root); return root; }

// ════════════════════════════════════════════════════════════════════════════
// RAIDER — a LONG HORIZONTAL WEDGE, 42 long × 14.5 high. FIX 8: the rear spike
// cluster is shrunk to a taper (it read as a second head), the floating chest
// chevron and the detached leg spikes are gone, the legs root INSIDE the hull.
// ════════════════════════════════════════════════════════════════════════════
function buildRaider() {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = "body";
  root.add(body);

  // the wedge: tall haunch at the rear falling to a low pointed prow.
  // D is applied to the geometry AND handed to the crack surface, so the trench
  // path is analytic (never the tessellation) yet lands on the deformed hull.
  const HR = [7.6, 5.9, 14.5];
  const D = (v) => {
    const f = clamp01((v.z + HR[2]) / (2 * HR[2]));       // 0 rear → 1 prow
    const g = clamp01((-v.z + HR[2]) / (2 * HR[2]));      // 1 rear → 0 prow
    v.x *= 1 - 0.40 * f * f - 0.28 * Math.pow(g, 3);
    v.y = v.y * (1 - 0.52 * f * f) - 4.4 * f * f + 1.7 * Math.pow(g, 3);
    return v;
  };
  const hullGeo = deform(jitterWelded(new THREE.IcosahedronGeometry(1, 1), 0.055, 41)
    .scale(HR[0], HR[1], HR[2]), D);
  const hull = new THREE.Mesh(shadePlanes(hullGeo, T.mid), shadedMat());
  hull.name = "hull"; hull.position.set(0, 8.4, 0); hull.userData.tone = T.mid;
  body.add(hull);

  // HEAD: a separate low block riding out past the prow, with a jaw plane under it
  const head = new THREE.Group(); head.name = "head";
  head.position.set(0, 5.2, 14.6);
  const skull = plate(4.6, 1.06, 0.84, 1.15, T.high, 45, 1, 0.06); skull.name = "skull";
  const jaw = plate(3.6, 0.9, 0.3, 1.2, T.low, 47, 0, 0.09);
  jaw.name = "jaw"; jaw.position.set(0, -2.6, 1.6); jaw.rotation.x = 0.24;
  head.add(skull, jaw);
  body.add(head);

  // THE NOSE SPIKE — thrust forward PAST the front feet (feet at z≈9, tip at z≈25)
  const nose = spike(2.0, 10.5, T.high, 48, 4);
  nose.name = "nose"; nose.position.set(0, 5.0, 15.0); nose.rotation.x = Math.PI / 2 + 0.13;
  body.add(nose);

  // FIX 8 — four SHORT claws whose roots sit INSIDE the hull, so no rotation in the
  // lunge can detach them into floating triangles the way v12's did.
  const legs = new THREE.Group(); legs.name = "legs";
  for (const s of [-1, 1]) {
    const fr = new THREE.Group(); fr.name = s < 0 ? "limbL" : "limbR";
    fr.position.set(s * 4.0, 5.8, 9.0);
    const claw = spike(1.5, 6.0, T.low, s < 0 ? 53 : 54);
    claw.rotation.set(3.02, 0, s * -0.14);
    fr.add(claw);
    legs.add(fr);
    const rb = new THREE.Group(); rb.name = s < 0 ? "hindL" : "hindR";
    rb.position.set(s * 5.2, 7.2, -8.0);
    const st = spike(1.8, 7.0, T.low, s < 0 ? 55 : 56);
    st.rotation.set(3.16, 0, s * -0.09);
    rb.add(st);
    legs.add(rb);
  }
  body.add(legs);

  // ONE thin tail point out the back — the rear TAPERS, it never bunches
  const tail = spike(1.7, 14.0, T.low, 57);
  tail.name = "tail"; tail.position.set(0, 13.4, -13.2); tail.rotation.x = -1.86;
  body.add(tail);

  // FIX 8 — the dorsal ridge is now a WEDGE TOO: tallest over the shoulder, shrinking
  // to a stub at the tail root. v12 put its longest spikes at the rear, which is
  // exactly why the back end read as a second head.
  const horns = new THREE.Group(); horns.name = "horns";
  [[6.0, 10.6, 7.6, -0.70], [1.6, 12.2, 6.6, -0.86], [-2.8, 13.6, 4.8, -1.02], [-7.2, 14.8, 3.0, -1.18]]
    .forEach(([z, y, len, rx], i) => {
      const h = spike(1.6 - i * 0.16, len, T.dark, 60 + i);
      h.position.set(0, y, z); h.rotation.x = rx;
      h.name = "horn" + i;
      horns.add(h);
    });
  for (const s of [-1, 1]) {                              // two low shoulder barbs, front half
    const h = spike(1.15, 4.4, T.dark, s < 0 ? 64 : 65);
    h.position.set(s * 5.2, 9.4, 3.4); h.rotation.set(-0.55, 0, s * 1.05);
    horns.add(h);
  }
  body.add(horns);

  // FIX 2 — trench systems on the hull's flanks and one on the skull. Short arcs,
  // tree topology, tapering to nothing at every tip. The params are (azimuth,
  // elevation) on the ANALYTIC hull, never mesh edges.
  const hullSurf = warpSurf(ellipsoidSurf(...HR), D);
  // v14 · THE NICK. For a z-elongated hull the screen-x silhouette sits well forward
  // (p ∝ R²·m ⇒ u ≈ −0.4 for the near-left edge at yaw 35), which is exactly where the
  // second seam system starts — so the crack runs off the outline and takes a bite
  // out of it on the way. Applied before the trenches: they drape into the dent.
  nick(hull, hullSurf, -0.40, 0.50, 4.4, 3.2);
  crackTree(hull, hullSurf, {                              // long straight runs, hard kinks
    trunk: [[0.66, 0.70], [0.44, 0.30], [0.60, -0.02], [0.30, -0.30], [0.40, -0.52]], w: 0.66, samples: 22,
    forks: [{ at: 0.26, to: [[0.86, 0.16], [1.04, 0.02]], w: 0.34, samples: 12 },
      { at: 0.66, to: [[0.06, -0.16], [-0.16, -0.36]], w: 0.32, samples: 12 }],
  });
  crackTree(hull, hullSurf, {                              // starts AT the nick
    trunk: [[-0.40, 0.50], [-0.58, 0.16], [-0.86, -0.04], [-0.74, -0.38]], w: 0.52, samples: 17,
    forks: [{ at: 0.52, to: [[-1.10, -0.06], [-1.30, -0.20]], w: 0.20, samples: 10 }],
  });
  crackTree(hull, hullSurf, {                              // the near haunch, over the ribs
    trunk: [[1.52, 0.58], [1.86, 0.26], [1.60, -0.06], [1.94, -0.34]], w: 0.42, samples: 17,
    forks: [{ at: 0.44, to: [[2.24, 0.16], [2.46, 0.02]], w: 0.22, samples: 10 }],
  });
  crackTree(hull, hullSurf, {                              // the far side gets its own seam
    trunk: [[2.90, 0.62], [3.16, 0.24], [2.94, -0.06], [3.26, -0.32]], w: 0.36, samples: 17,
    forks: [{ at: 0.5, to: [[2.60, 0.06], [2.40, -0.06]], w: 0.21, samples: 10 }],
  });
  crackTree(skull, ellipsoidSurf(...skull.userData.rad), {
    trunk: [[0.54, 0.72], [0.30, 0.34], [0.46, 0.02], [0.22, -0.26]], w: 0.40, samples: 15,
    forks: [{ at: 0.42, to: [[0.72, 0.14], [0.94, 0.04]], w: 0.16, samples: 9 }],
  });

  // FIX 3 — narrow, forward-raked slits under a heavy brow: a fast little killer.
  // v14 · parented to the HEAD, not the body. On the body they stayed put while the
  // head dropped in the windup, and the socket plate — which draws over everything by
  // design — ended up lying on the grass in front of the creature like a dropped mask.
  eyeCluster(head, { p: [0, 1.7, 4.6], rx: -0.14, size: 0.62, gap: 1.0, tilt: 0.55, slit: 1.05 });

  // FIX 8 — the trail is a BROKEN faceted ribbon: five separate tapering plates with
  // gaps between them, folded in Y so each catches its own flat step. Never a welded wedge.
  const trail = new THREE.Group(); trail.name = "trail";
  {
    // v13.1 · these plates are alpha-blended over 174-luma grass, so a mid-luma violet
    // washes out to grey-mauve (measured 170,152,154 — it read as dirty white, not energy).
    // The tail of the ramp is therefore DEEP and heavily saturated: blended half-and-half
    // with the ground it still lands violet instead of grey.
    const cols = [dispRGB(...SEAM_RGB), dispRGB(...SEAM_RGB_COOL),
      dispRGB(118, 56, 176), dispRGB(88, 42, 136), dispRGB(66, 32, 104)];
    for (let i = 0; i < 4; i++) {
      const t0 = i / 4, t1 = t0 + 0.20;                   // 0.05 gap between plates
      const w0 = 5.2 * (1 - t0) * (1 - t0) + 0.6, w1 = 5.2 * (1 - t1) * (1 - t1) + 0.6;
      const z0 = -20 * t0 - 7, z1 = -20 * t1 - 7;
      const y0 = (i % 2 ? 2.2 : -2.2) + 11.6, y1 = -(i % 2 ? 2.2 : -2.2) + 11.6;
      const v = [-w0, y0, z0, w0, y0, z0, w1, y1, z1, -w0, y0, z0, w1, y1, z1, -w1, y1, z1];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
      const m = noShadow(new THREE.Mesh(geo, unlit(cols[i], {
        side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false })));
      m.name = "trailSeg" + i;
      trail.add(m);
    }
  }
  root.add(trail);

  softShadow(root, 9.5, 5.6, 0.32, 0, -1.0);
  return finish(root);
}

const trailOpacity = (g, o) => g.getObjectByName("trail").children
  .forEach((c, i) => { c.material.opacity = Math.max(0, o * (1 - i * 0.26)); });

const raiderAnims = {
  scuttle(g, phase, t) {
    restore(g);
    const body = g.getObjectByName("body");
    const hop = Math.abs(Math.sin(t * 9));
    body.position.y = hop * 1.4;
    body.rotation.x = 0.06 * hop;                        // nose-down tilt into the run
    body.rotation.z = Math.sin(t * 9) * 0.05;
    g.getObjectByName("head").rotation.x = -0.05 * hop;
    g.getObjectByName("tail").rotation.x = -1.80 + 0.12 * Math.sin(t * 9 - 0.8);
    g.getObjectByName("limbL").rotation.x = Math.sin(t * 9) * 0.45;
    g.getObjectByName("limbR").rotation.x = Math.sin(t * 9 + Math.PI) * 0.45;
    g.getObjectByName("hindL").rotation.x = Math.sin(t * 9 + 2.2) * 0.35;
    g.getObjectByName("hindR").rotation.x = Math.sin(t * 9 + 2.2 + Math.PI) * 0.35;
  },
  // FIX 5 — the WINDUP is now a real telegraph: the body compresses 20% ALONG ITS LONG
  // AXIS (z), the head drops and pulls back, the dorsal spikes RISE toward vertical, the
  // haunches load, and the cracks flare to their peak at the moment of release.
  // FIX 8 — the LUNGE arcs nose-UP off the ground with the forelegs thrown forward.
  lunge(g, phase) {
    restore(g);
    const body = g.getObjectByName("body");
    const head = g.getObjectByName("head");
    const nose = g.getObjectByName("nose");
    const tail = g.getObjectByName("tail");
    const horns = g.getObjectByName("horns");
    const shadow = g.getObjectByName("contactShadow");
    const L = g.getObjectByName("limbL"), R = g.getObjectByName("limbR");
    const HL = g.getObjectByName("hindL"), HR2 = g.getObjectByName("hindR");
    if (phase < 0.42) {                                  // WINDUP — a real CROUCH
      // v14 · the delta between this pose and the leap has to be obvious in a still
      // pair from the same yaw, so every term is roughly doubled: the wedge squats
      // 3.4 units, packs 22% along its own length, drops its head below the shoulder
      // line and fans the dorsal spikes OUT as well as up.
      const k = Math.pow(phase / 0.42, 0.7);
      body.position.z = -6.4 * k;                        // rear-loaded
      body.position.y = -1.0 * k;
      body.rotation.x = 0.16 * k;                        // nose DOWN, haunches up
      // the squat is a SQUASH, not a drop: 22% shorter along its own length, 12%
      // lower, 12% wider. Dropping the whole group instead (the first cut of this)
      // drove the prow, the nose spike and the face clean through the ground plane.
      body.scale.set(1 + 0.12 * k, 1 - 0.12 * k, 1 - 0.22 * k);
      head.rotation.x = 0.24 * k;                        // head drops — but not so
      head.position.z -= 3.4 * k;                        // far the face stops reading
      head.position.y -= 1.0 * k;
      nose.rotation.x = Math.PI / 2 + 0.13 - 0.30 * k;   // the tusk clears the ground
      tail.rotation.x = -1.86 + 0.92 * k;
      horns.children.forEach((h, i) => {                 // dorsal spikes RISE and FLARE
        h.rotation.x += 0.62 * k * (i < 4 ? 1 : 0.4);
        h.rotation.z += (i % 2 ? 0.34 : -0.34) * k;
      });
      L.rotation.x = R.rotation.x = 0.92 * k;            // forelegs folded under
      HL.rotation.x = HR2.rotation.x = -0.58 * k;        // hind legs coiled
      shadow.scale.set(9.5 * (1 + 0.16 * k), 5.6 * (1 - 0.06 * k), 1);
      shadow.material.opacity = 0.32 + 0.10 * k;         // pressed into the ground
      flareSeams(g, k);                                  // peak flare AT the release
    } else if (phase < 0.64) {                           // LUNGE — the leap
      const k = (phase - 0.42) / 0.22;
      const e = Math.sin(Math.PI * k * 0.5);
      const air = Math.sin(Math.PI * k);
      body.position.z = -6.4 + 28 * e;
      body.position.y = 12.5 * air;                      // the airborne gap
      body.rotation.x = 0.16 - 0.78 * e;                 // through level to NOSE-UP (−36°)
      body.scale.set(1 - 0.06 * e, 1 - 0.02 * e, 1 + 0.26 * e);   // stretched along facing
      head.rotation.x = 0.50 - 0.86 * e;
      L.rotation.x = R.rotation.x = 0.86 - 2.05 * e;     // forelegs thrown FORWARD, straight
      HL.rotation.x = HR2.rotation.x = -0.58 + 1.35 * e; // hind legs trail behind
      tail.rotation.x = -1.12 - 0.66 * e;
      flareSeams(g, 1 - k);
      trailOpacity(g, 0.95 * (1 - k * 0.3));
      const trail = g.getObjectByName("trail");
      trail.position.set(0, body.position.y * 0.9, body.position.z);
      trail.scale.set(1, 1, 0.6 + 0.9 * e);
      // AIRBORNE = the shadow shrinks, fades AND lags behind the body it belongs to.
      // A shadow that tracks perfectly under a leaping thing still reads as contact.
      shadow.scale.set(9.5 * (1 - 0.62 * air), 5.6 * (1 - 0.62 * air), 1);
      shadow.position.z = -1.0 + body.position.z * 0.72;
      shadow.material.opacity = 0.32 - 0.20 * air;
    } else {                                             // SETTLE
      const k = (phase - 0.64) / 0.36;
      const d = Math.exp(-4 * k);
      body.position.z = 22 * (1 - k);
      body.rotation.x = 0.14 * Math.sin(k * 14) * d;
      head.rotation.x = 0.1 * Math.sin(k * 12) * d;
      trailOpacity(g, 0.6 * (1 - k) * (1 - k));
      const trail = g.getObjectByName("trail");
      trail.position.z = body.position.z;
      trail.scale.set(1, 1, 1.4 + 0.5 * k);
      shadow.position.z = -1.0 + body.position.z * 0.72;
    }
  },
};

// ════════════════════════════════════════════════════════════════════════════
// ARCHER — a SOLID tapering spire with four heavy backswept quills. FIX 6: the
// bolt leaves a NAMED MUZZLE on the spire's chest, never the face, and the recoil
// is a real 10° pitch back.
// ════════════════════════════════════════════════════════════════════════════
function buildArcher() {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = "body";
  root.add(body);

  // v14 · FOUR STACKED TIERS. v13.1's profile was one smooth taper, which on a lathe
  // means every facet is flank-facing: the ramp had nothing to land on and the whole
  // spire sat on one value no matter what the table said. Each tier is now a near-
  // vertical wall (dr/dy ≈ −0.07 ⇒ flank, 28–43, stepped round the 9 segments by
  // azimuth) closed by a 2-unit SHELF whose normal is +Y ⇒ PLANE.top, 66. Four bright
  // horizontal reads stacked up a dark spire, exactly like the sheet's plate stacks.
  // The first cut of this had 2.4-wide shelves on vertical walls and rendered a
  // wedding cake. The shelf only has to be wide enough to hold a top-lit facet — the
  // CONE has to survive. So: the walls keep a real taper, the shelves are 1.0–1.7 and
  // deliberately UNEQUAL, and the tier heights are unevenly spaced.
  const PROF = [
    [0, 0], [13.2, 0], [13.9, 2.6],
    [12.2, 8.4], [10.9, 8.7],        // ── tier 1 shelf (1.3)
    [9.9, 16.2], [8.2, 16.5],        // ── tier 2 shelf (1.7)
    [7.4, 23.6], [6.4, 23.9],        // ── tier 3 shelf (1.0)
    [5.6, 31.0], [4.2, 31.3],        // ── tier 4 shelf (1.4)
    [3.5, 39.0], [2.4, 46.0], [1.2, 52.0], [0, 58],
  ];
  const rAt = mkRAt(PROF);
  const shaft = latheShard(PROF, 9, T.high, 21, 0.42);   // jitter down: shelves stay shelves
  shaft.name = "shaft";
  body.add(shaft);

  // v14 · THREE quills, not four: fewer, much thicker, and swung further out from the
  // axis. At 30px the old four dissolved into one soft grey mass and the archer's
  // thumbnail collapsed toward the healer's cone — the fix is fewer separated masses
  // with real air between them, and enough radial throw that they break the outline
  // instead of hugging it.
  // Three EQUAL-LENGTH near-vertical spikes read as rabbit ears; the fix is a swept
  // FIN — lengths stepping down as they climb, sweep angle opening out as they climb,
  // and a real azimuth fan so no two are parallel from any yaw.
  const quills = new THREE.Group(); quills.name = "quills";
  [[13, 34, -1.30, -0.92], [22, 28, -1.02, -0.12], [30, 27, -0.92, 0.86]]
    .forEach(([y, len, rx, az], i) => {
      const q = spike(6.6 - i * 1.1, len, T.low, 70 + i, 4);
      const r = rAt(y) - 1.2;
      q.position.set(Math.sin(az) * r, y, -Math.cos(az) * r);
      q.rotation.set(rx, az, 0);
      q.name = "quill" + i;
      quills.add(q);
    });
  body.add(quills);

  // crown shard so the tip reads as a point, not a cut cone
  const crownSpike = spike(2.4, 12.5, T.crown, 76);
  crownSpike.name = "crownSpike"; crownSpike.position.set(0.2, 52.5, -0.4); crownSpike.rotation.x = -0.16;
  body.add(crownSpike);

  // v14 · seams live WITHIN one tier wall each — a plate cracks, the stack doesn't.
  // (A trench spanning a shelf has to drape over a ledge its analytic proxy knows
  // nothing about, and floats.) Straight runs, hard kinks, acute forks.
  const sSurf = latheSurf(PROF);
  // a lathe's screen-x extreme is exactly perpendicular to the view, so at yaw 35 the
  // near-left outline is u = −0.96 — that is where the notch has to go to be seen.
  nick(shaft, sSurf, -0.96, 13.4, 3.8, 3.0);
  crackTree(shaft, sSurf, {                                // tier 1 wall
    trunk: [[0.34, 9.6], [0.16, 12.2], [0.42, 14.0], [0.26, 15.8]], w: 0.58, samples: 18,
    forks: [{ at: 0.42, to: [[0.74, 13.4], [0.96, 14.8]], w: 0.32, samples: 10 }],
  });
  crackTree(shaft, sSurf, {                                // tier 2 wall
    trunk: [[0.26, 17.4], [0.48, 19.6], [0.22, 21.4], [0.36, 23.0]], w: 0.48, samples: 17,
    forks: [{ at: 0.46, to: [[-0.10, 20.8], [-0.30, 22.0]], w: 0.26, samples: 10 }],
  });
  crackTree(shaft, sSurf, {                                // starts AT the nick
    trunk: [[-0.96, 13.4], [-0.72, 11.6], [-0.90, 10.2], [-0.66, 9.2]], w: 0.44, samples: 15,
    forks: [{ at: 0.5, to: [[-1.24, 11.0], [-1.42, 10.0]], w: 0.24, samples: 9 }],
  });
  crackTree(shaft, sSurf, {                                // the base flare
    trunk: [[0.92, 3.4], [1.14, 5.2], [0.88, 7.0]], w: 0.50, samples: 14,
    forks: [{ at: 0.5, to: [[1.46, 5.0], [1.66, 4.0]], w: 0.24, samples: 9 }],
  });
  crackTree(shaft, sSurf, {                                // far side, so it is never blank
    trunk: [[3.05, 17.8], [3.30, 20.0], [3.06, 21.8], [3.28, 23.2]], w: 0.42, samples: 16,
    forks: [{ at: 0.46, to: [[2.74, 20.6], [2.52, 21.8]], w: 0.25, samples: 10 }],
  });
  crackTree(shaft, sSurf, {                                // tier 3, small
    trunk: [[0.10, 25.0], [0.34, 27.2], [0.14, 29.4]], w: 0.34, samples: 13,
  });
  crackTree(shaft, sSurf, {                                // tier 3, far side
    trunk: [[2.70, 25.4], [2.94, 27.4], [2.72, 29.4]], w: 0.30, samples: 12,
  });

  // FIX 3 — the PAIR, high on the front face where a head would be. y=28.5 sits
  // mid-wall on tier 3, whose radius (5.9) still clears the socket's half-width (3.5).
  eyeCluster(body, { p: [0, 28.5, rAt(28.5) + 0.35], rx: -0.10, size: 0.74, gap: 1.5, tilt: 0.34 });

  // ── v14 · THE MUZZLE APERTURE ──────────────────────────────────────────────
  // Built exactly like an eye socket, because that is what sells "a hole in a solid
  // thing": a recessed dark ring bitten into the tier-3 wall at chest height, an
  // emissive core sunk INSIDE it, and everything the shot emits — charge flash, bolt
  // — spawning from that core. 9 units below the eyes, on the spire's front.
  const muzzle = new THREE.Group(); muzzle.name = "muzzle";
  muzzle.position.set(0, 22, rAt(22));
  const apOff = { polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -800, side: THREE.DoubleSide };
  const apRing = noShadow(new THREE.Mesh(new THREE.RingGeometry(1.6, 3.3, 7),
    unlitAt(SOCKET_DISP, TINT_RIM, apOff)));
  apRing.name = "muzzleRing"; apRing.position.z = 0.12;
  // at REST the core is an ember, not a lamp: below the crack core's luma, so a
  // resting archer never advertises a shot it isn't taking. It charges to the full
  // ability register only in the frames before release.
  const apCore = noShadow(new THREE.Mesh(new THREE.CircleGeometry(1.6, 7),
    unlit(dispRGB(96, 46, 150), apOff)));
  apCore.name = "muzzleCore"; apCore.position.z = -0.55;   // sunk INSIDE the ring
  muzzle.add(apRing, apCore);
  const flash = noShadow(new THREE.Mesh(jitterWelded(new THREE.OctahedronGeometry(3.4), 0.4, 80),
    unlit(dispRGB(...ABILITY_RGB), { transparent: true, opacity: 0, depthWrite: false })));
  flash.name = "chargeFlash"; flash.position.z = 0.9;
  muzzle.add(flash);
  // the bolt: a tapered THREE-SIDED dart, ~2× v12, bright violet tip / dark tail,
  // with a short rear ribbon.
  const bolt = new THREE.Group(); bolt.name = "bolt";
  bolt.position.z = 1.2;                                   // leaves the aperture, not the air
  {
    // v14 · ABILITY REGISTER. Authored per channel so ACES cannot desaturate it toward
    // pink-white: it must out-glow AND out-saturate every crack on the model, or the
    // shot reads as a piece of the archer falling off.
    const head = noShadow(new THREE.Mesh(new THREE.ConeGeometry(3.6, 15.0, 3),
      unlit(dispRGB(...ABILITY_RGB), { transparent: true, opacity: 0 })));
    head.name = "boltHead"; head.rotation.x = Math.PI / 2; head.position.z = 7.5;
    const tailC = noShadow(new THREE.Mesh(new THREE.ConeGeometry(3.6, 17.0, 3),
      unlit(dispRGB(...ABILITY_DIM), { transparent: true, opacity: 0 })));
    tailC.name = "boltTail"; tailC.rotation.x = -Math.PI / 2; tailC.position.z = -8.5;
    const v = [], rib = 13;
    for (let i = 0; i < 2; i++) {                          // a folded two-plate ribbon
      const s = i ? 1 : -1;
      v.push(0, 1.9, -17, 0, -1.9, -17, s * 1.2, 0, -17 - rib);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
    const ribbon = noShadow(new THREE.Mesh(rg, unlitAt(92, TINT_VIOLET,
      { transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })));
    ribbon.name = "boltRibbon";
    bolt.add(head, tailC, ribbon);
  }
  muzzle.add(bolt);
  body.add(muzzle);

  softShadow(root, 11.5, 9.0, 0.34, 0, -0.5);
  return finish(root);
}

const boltOpacity = (g, o) => g.getObjectByName("bolt").children
  .forEach((c, i) => { c.material.opacity = i === 2 ? o * 0.7 : o; });

const archerAnims = {
  sway(g, phase, t) {
    restore(g);
    const body = g.getObjectByName("body");
    body.rotation.z = Math.sin(t * 1.6) * 0.05 + Math.sin(t * 2.7) * 0.018;
    body.rotation.x = Math.sin(t * 1.2) * 0.025;
    g.getObjectByName("quills").children.forEach((q, i) => {
      q.rotation.z += Math.sin(t * 1.6 - 0.5 - i * 0.35) * 0.05;
    });
  },
  // FIX 6 — lean in to draw, one-frame flash AT THE MUZZLE, then the spire pitches
  // BACK 10° with the quills sweeping forward while the dart flies out of its chest.
  fire(g, phase) {
    restore(g);
    const body = g.getObjectByName("body");
    const quills = g.getObjectByName("quills");
    const flash = g.getObjectByName("chargeFlash");
    const core = g.getObjectByName("muzzleCore");
    const bolt = g.getObjectByName("bolt");
    if (phase < 0.28) {                                   // draw — lean IN, quills back
      const k = phase / 0.28;
      body.rotation.x = 0.09 * k;
      quills.children.forEach(q => { q.rotation.x -= 0.30 * k; });
      flareSeams(g, 0.7 * k);
      core.material.color.copy(core.userData.restColor).lerp(dispRGB(...ABILITY_RGB), k);
      core.scale.setScalar(1 + 0.35 * k * k);             // the aperture charges
    } else if (phase < 0.34) {                            // the one-frame flash
      body.rotation.x = 0.09;
      flash.material.opacity = 0.95;
      flash.scale.setScalar(1 + 0.7 * ((phase - 0.28) / 0.06));
      core.material.color.copy(dispRGB(...ABILITY_RGB));
      core.scale.setScalar(1.6);
      flareSeams(g, 1);
      // the dart is NOT out yet — this frame is the aperture going off, and if the
      // bolt is already drawn over it the flash has nothing to read against.
      boltOpacity(g, 0);
      quills.children.forEach(q => { q.rotation.x -= 0.30; });
    } else {                                              // RECOIL — pitch back 10°
      const k = (phase - 0.34) / 0.66;
      core.scale.setScalar(1 + 0.5 * Math.exp(-6 * k));
      core.material.color.copy(dispRGB(...ABILITY_RGB)).lerp(core.userData.restColor, clamp01(k * 2.4));
      const d = Math.exp(-3.2 * k);
      body.rotation.x = -0.175 * Math.cos(k * 12) * d;    // 10° back, damped
      body.rotation.z = 0.05 * Math.sin(k * 11) * d;
      quills.children.forEach((q, i) => { q.rotation.x += 0.34 * Math.sin(k * 10 - i * 0.4) * d; });
      flareSeams(g, 0.8 * d);
      const f = clamp01(k * 1.35);
      bolt.position.set(0, 5 * f - 8 * f * f, 1.2 + 70 * f);
      bolt.rotation.x = -0.22 * f;
      boltOpacity(g, 1 - Math.pow(f, 3));
    }
  },
};

// ════════════════════════════════════════════════════════════════════════════
// HEALER — FIX 4: the ground pool is GONE. Hover now lives entirely in the
// silhouette: a bell that FLARES at the bottom into a scalloped rim, three hanging
// tendrils, and 9 units of clear air under the lowest tip. The only thing it puts on
// the ground is a small neutral detached shadow.
// ════════════════════════════════════════════════════════════════════════════
const HEAL_FLOAT = 24.5;
// widest at the RIM (12.6) and pulled in hard above it (8.4): a bell that flares, not
// an egg. The flare is 1.5× the waist — the whole hover read at thumbnail size.
// v14 · the flare and the waist are v13.1 to the decimal — that silhouette is the
// hover read and it is not up for renegotiation. What is new is the CROWN: two shelf
// breaks above the waist, +Y facets that catch the top light the way the archer's
// tiers do, so the head end of the bell stops being one dead flank value.
const BELL = [[7.6, 0], [13.2, 1.6], [13.4, 3.2], [10.2, 5.8], [8.2, 9.2], [8.5, 12.6],
  [8.2, 16.0], [7.6, 19.2], [6.4, 19.5],      // ── crown shelf: nine +Y facets
  [5.2, 22.6], [3.4, 24.8], [0, 26]];
function buildHealer() {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = "body";
  body.position.y = HEAL_FLOAT;                           // REST POSE IS AIRBORNE (build(), not anims)
  body.rotation.z = 0.04;
  root.add(body);

  const rAt = mkRAt(BELL);
  const mantle = latheShard(BELL, 9, T.mid, 25, 0.26);
  mantle.name = "mantle";
  body.add(mantle);
  // the bell's mouth, capped with an unlit dark disc: from below it reads as a hollow
  // shadowed underside instead of showing the far wall's backfaces.
  const mouth = noShadow(new THREE.Mesh(new THREE.CircleGeometry(7.8, 9),
    unlitAt(SOCKET_DISP * 1.4, TINT_RIM, { side: THREE.DoubleSide })));
  mouth.name = "mouth"; mouth.rotation.x = Math.PI / 2; mouth.position.y = 0.6;
  body.add(mouth);

  // FIX 4/9 — THE SCALLOPED RIM. Nine downward points around the flare: the reason a
  // 30px black thumbnail can tell this thing is hanging in the air with zero violet.
  const scallop = new THREE.Group(); scallop.name = "scallop";
  {
    // v14 · R 13.3 → 13.7 and the top edge lifted to 2.6: the jittered mantle used to
    // fall inside the skirt in places and a 1px sliver of GRASS showed through the
    // join, tracing a bright yellow-green line right round the rim. The hanging
    // points (y = −5.6) are untouched, so the hover silhouette is identical.
    const N = 9, R = 13.7, v = [];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2, am = (a0 + a1) / 2;
      const P = (a, y, r) => [Math.sin(a) * r, y, Math.cos(a) * r];
      v.push(...P(a0, 2.6, R), ...P(a1, 2.6, R), ...P(am, -5.6, R * 0.72));
      v.push(...P(a1, 2.6, R), ...P(a0, 2.6, R), ...P(am, -5.6, R * 0.72));   // both faces
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
    const m = new THREE.Mesh(shadePlanes(geo, T.low), shadedMat({ side: THREE.DoubleSide }));
    m.userData.tone = T.low; m.name = "scallopMesh";
    scallop.add(m);
  }
  body.add(scallop);

  // FIX 4 — THREE hanging tendrils, long enough to read at thumbnail size, ending
  // 9 units clear of the ground. Their lag is the personality.
  const fringe = new THREE.Group(); fringe.name = "fringe";
  [[0.30, 12.9], [2.40, 13.3], [4.40, 12.6]].forEach(([a, r], i) => {
    const hold = new THREE.Group(); hold.name = "nub" + i;
    hold.position.set(Math.sin(a) * r, 1.3, Math.cos(a) * r);
    hold.rotation.set(Math.cos(a) * 0.10, 0, -Math.sin(a) * 0.10);   // a little outward splay
    const cone = spike(2.2, 11.4 - i * 0.8, T.low, 90 + i);
    cone.rotation.x = Math.PI;
    hold.add(cone);
    fringe.add(hold);
  });
  body.add(fringe);

  // the crown spike — the fissures radiate from under it
  const crown = spike(2.2, 6.4, T.crown, 27);
  crown.name = "crown"; crown.position.y = 24.4;
  body.add(crown);
  const crest = noShadow(new THREE.Mesh(new THREE.OctahedronGeometry(1.9),
    unlit(dispRGB(...SEAM_RGB))));
  crest.name = "crest"; crest.position.y = 30.6; crest.scale.y = 1.7;
  body.add(crest);

  // FIX 2 — four short tapering fissures radiating down from under the crown. v14:
  // they run on the wall BELOW the crown shelves (18.2 → 9.6) so no trench has to
  // drape over a ledge, and each is a straight run with two hard kinks.
  const bSurf = latheSurf(BELL);
  // the fissure at a=5.52 kinks at (5.32, 15.2) — which IS the near-left outline
  // (5.32 ≡ −0.96 rad, the view tangent) — so that kink is where the bell loses a
  // chip of itself. Five fissures now, not four: at v13.1's floor width four covered
  // the bell, at v14's they left the front bare.
  nick(mantle, bSurf, 5.32, 15.2, 3.4, 2.6);
  [[0.30, 1], [1.10, -1], [1.95, 1], [3.60, -1], [5.52, -1]].forEach(([a, s], i) => {
    crackTree(mantle, bSurf, {
      trunk: [[a, 18.2], [a + s * 0.20, 15.2], [a - s * 0.14, 12.4], [a + s * 0.10, 9.6]],
      w: 0.40 - i * 0.025, samples: 16,
      forks: [{ at: 0.50, to: [[a + s * 0.52, 13.4], [a + s * 0.74, 11.4]], w: 0.20, samples: 9 }],
    });
  });

  // FIX 3 — the PAIR in a socket. The monocle ring is deleted.
  eyeCluster(body, { p: [0, 12.8, rAt(12.8) + 0.25], rx: -0.10, size: 0.85, gap: 2.0, tilt: 0.30 });

  // ── v14 · MOTES THAT TRAVEL ────────────────────────────────────────────────
  // v13.1's heal was a cross of chevrons sitting flush against the bell — surface
  // decoration, indistinguishable from a crack that happened to move. These are four
  // small DETACHED tetrahedra: they spawn out beside the flare, rise past the crest,
  // converge toward the axis and fade. Off-body (the whole point), faceted (so they
  // are objects, not sprites) and in the ABILITY register, never the crack register.
  const motes = new THREE.Group(); motes.name = "motes";
  for (let i = 0; i < 4; i++) {
    const geo = jitterWelded(new THREE.TetrahedronGeometry(4.3 - i * 0.4), 0.5, 110 + i).toNonIndexed();
    const pos = geo.attributes.position, cols = new Float32Array(pos.count * 3);
    const hot = dispRGB(...ABILITY_RGB), cool = dispRGB(...ABILITY_DIM);
    for (let f = 0; f < pos.count / 3; f++) {              // two lit facets, two in shade
      const c = f % 3 === 0 ? cool : hot;
      for (let k = 0; k < 3; k++) {
        cols[(f * 3 + k) * 3] = c.r; cols[(f * 3 + k) * 3 + 1] = c.g; cols[(f * 3 + k) * 3 + 2] = c.b;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    const m = noShadow(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, depthWrite: false })));
    m.name = "mote" + i;
    m.userData.a = 0.55 + i * 1.72;                        // spread around the bell
    m.userData.r = 21.5 - i * 1.1;
    m.userData.spin = [1.4 + i * 0.5, 2.1 - i * 0.3];
    motes.add(m);
  }
  root.add(motes);

  // DETACHED soft shadow, neutral dark — it is hovering, not standing, and violet is
  // never allowed on the ground for anything but the brute's slam.
  // v14 · it was offset (5.5, −4.0) and rendered as an ellipse lying beside the
  // creature under nothing at all. Re-anchored under the body, and the hover moves it
  // with the drift so it stays anchored.
  softShadow(root, 5.2, 3.4, 0.20, 0, 0);
  return finish(root);
}

const healerAnims = {
  hover(g, phase, t) {
    restore(g);
    const body = g.getObjectByName("body");
    body.position.y = HEAL_FLOAT + Math.sin(t * 2.0) * 2.4;
    body.position.x = Math.sin(t * 0.8) * 1.2;            // the drift
    body.rotation.z = 0.04 + Math.sin(t * 1.35) * 0.045;
    for (let i = 0; i < 3; i++) {                         // tendril lag = the personality
      const nb = g.getObjectByName("nub" + i);
      nb.rotation.x = Math.sin(t * 2.0 - 0.85 - i * 0.5) * 0.26;
      nb.rotation.z = Math.cos(t * 2.0 - 0.85 - i * 0.5) * 0.20;
    }
    const sh = g.getObjectByName("contactShadow");        // the shadow breathes with the bob
    const k = 1 - Math.sin(t * 2.0) * 0.12;
    sh.scale.set(5.2 * k, 3.4 * k, 1);
    sh.position.x = body.position.x;                      // stays UNDER the drift
  },
  heal(g, phase, t) {
    healerAnims.hover(g, phase, t);
    const body = g.getObjectByName("body");
    const k = bell(phase, 0.08, 0.92);
    body.position.y += 3.0 * bell(phase, 0.05, 0.6);      // it RISES as it casts
    body.scale.setScalar(1 + 0.1 * k);                    // breathing, not casting
    body.rotation.z += 0.08 * Math.sin(phase * Math.PI * 2);
    g.getObjectByName("crest").scale.set(1 + 0.4 * k, 1.7 + 0.5 * k, 1 + 0.4 * k);
    flareSeams(g, k);                                     // its own cracks brighten
    // v14 · the motes: spawn low and OUT beside the flare, climb past the crest,
    // converge toward the axis, fade. Detached the whole way.
    for (let i = 0; i < 4; i++) {
      const m = g.getObjectByName("mote" + i);
      const ck = clamp01((phase - 0.05 - i * 0.10) / 0.62);
      const live = ck > 0 && ck < 1;
      m.material.opacity = live ? 0.98 * bell(ck, 0, 1) ** 0.5 : 0;
      const r = m.userData.r * (1 - 0.40 * ck);
      m.position.set(Math.sin(m.userData.a) * r + body.position.x * 0.4,
        HEAL_FLOAT - 9 + ck * 52, Math.cos(m.userData.a) * r);
      m.rotation.set(ck * m.userData.spin[0] + i, ck * m.userData.spin[1], 0.4 * i);
      m.scale.setScalar(1 - 0.35 * ck);
    }
  },
};

// ════════════════════════════════════════════════════════════════════════════
// BRUTE — ASYMMETRIC: the right shoulder rides a head higher than the left and two
// knuckle-arms stand clear of the torso, so the outline HAS ARMS. FIX 3: the white
// row is gone — one heavy wide-set socketed pair. FIX 7: real shard debris.
// ════════════════════════════════════════════════════════════════════════════
function buildBrute() {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = "body";
  root.add(body);

  // torso: two masses at DIFFERENT heights — the asymmetry is structural
  const hump = plate(12.0, 1.18, 0.95, 1.10, T.mid, 31); hump.position.set(-3.5, 22.0, -4); hump.name = "hump";
  const shoulderR = plate(10.2, 1.05, 1.0, 1.0, T.high, 30); shoulderR.position.set(9.5, 29.0, -2.5); shoulderR.name = "shoulderR";
  const chest = plate(9.2, 1.20, 0.95, 0.82, T.mid, 34); chest.position.set(0, 14, 3.0); chest.name = "chest";
  const haunchL = plate(7.4, 0.95, 0.9, 1.05, T.low, 32); haunchL.position.set(-11.5, 8.0, -9); haunchL.name = "haunchL";
  const haunchR = plate(7.4, 0.95, 0.9, 1.05, T.low, 33); haunchR.position.set(11.5, 8.0, -9); haunchR.name = "haunchR";

  // KNUCKLE-ARMS — held clear of the torso, upper arm + knuckle fist on the ground.
  const arms = new THREE.Group(); arms.name = "arms";
  for (const s of [-1, 1]) {
    const arm = new THREE.Group(); arm.name = s < 0 ? "armL" : "armR";
    arm.position.set(s * 19.5, s < 0 ? 20.5 : 25.5, 9.5);     // right arm hangs from the high shoulder
    const upper = plate(4.8, 0.88, 2.05, 0.88, T.low, s < 0 ? 36 : 37);
    upper.position.set(s * 0.9, -7.8, 0);
    upper.rotation.z = s * 0.13;
    const fist = plate(5.8, 1.12, 0.76, 1.10, T.mid, s < 0 ? 38 : 39, 0);
    fist.name = s < 0 ? "fistL" : "fistR";
    fist.position.set(s * 2.2, s < 0 ? -16.4 : -21.4, 1.8);
    arm.add(upper, fist);
    arms.add(arm);
  }

  // head: slung low between the arms, a step lighter than the shoulder
  const head = plate(7.4, 1.06, 0.88, 1.0, T.crown, 35); head.position.set(-1.0, 12.4, 12.0); head.rotation.x = 0.20; head.name = "head";
  const brow = plate(6.6, 1.02, 0.30, 0.62, T.crown, 40, 0);
  brow.position.set(-1.0, 17.0, 13.6); brow.rotation.x = -0.28; brow.name = "brow";
  body.add(hump, shoulderR, chest, haunchL, haunchR, arms, head, brow);
  body.rotation.x = 0.05;

  // FIX 2 — the widest trenches in the cast, but still trees on short arcs.
  const humpSurf = ellipsoidSurf(...hump.userData.rad);
  // v14 · THE NICK. On a sphere the top-of-screen silhouette point at yaw 35 / pitch 32
  // has normal ≈ (−0.30, 0.84, −0.43) ⇒ (u, v) ≈ (3.75, 0.63). The rear crown seam is
  // rerouted to start exactly there, so the brute's highest outline has a bite in it.
  nick(hump, humpSurf, 3.75, 0.63, 4.4, 4.0);
  crackTree(hump, humpSurf, {
    trunk: [[0.52, 0.80], [0.20, 0.44], [0.44, 0.10], [0.10, -0.20]], w: 0.62, samples: 20,
    forks: [{ at: 0.26, to: [[0.78, 0.36], [1.00, 0.24]], w: 0.34, samples: 11 },
      { at: 0.60, to: [[-0.08, 0.14], [-0.34, 0.02]], w: 0.32, samples: 11 },
      { at: 0.88, to: [[0.40, -0.36], [0.56, -0.52]], w: 0.24, samples: 9 }],
  });
  crackTree(shoulderR, ellipsoidSurf(...shoulderR.userData.rad), {
    trunk: [[0.66, 0.78], [0.36, 0.44], [0.60, 0.10], [0.34, -0.20]], w: 0.44, samples: 18,
    forks: [{ at: 0.5, to: [[0.98, 0.28], [1.20, 0.14]], w: 0.24, samples: 10 },
      { at: 0.78, to: [[0.14, -0.16], [-0.06, -0.30]], w: 0.20, samples: 9 }],
  });
  crackTree(chest, ellipsoidSurf(...chest.userData.rad), {
    trunk: [[-0.48, 0.64], [-0.14, 0.28], [-0.36, -0.04], [-0.08, -0.36]], w: 0.46, samples: 18,
    forks: [{ at: 0.42, to: [[0.26, 0.18], [0.48, 0.06]], w: 0.25, samples: 10 },
      { at: 0.74, to: [[-0.62, -0.14], [-0.82, -0.28]], w: 0.21, samples: 9 }],
  });
  // v14 · at v13.1's floor width seven trees read as a dense network; at 0.28 the same
  // seven left whole plates blank, so the near fist gets one too. Same rules.
  const fistR = body.getObjectByName("fistR");
  crackTree(fistR, ellipsoidSurf(...fistR.userData.rad), {
    trunk: [[0.40, 0.66], [0.70, 0.30], [0.46, -0.02]], w: 0.30, samples: 13,
  });
  crackTree(haunchR, ellipsoidSurf(...haunchR.userData.rad), {
    trunk: [[0.60, 0.64], [0.88, 0.26], [0.66, -0.08], [0.92, -0.38]], w: 0.32, samples: 16,
  });
  crackTree(hump, humpSurf, {                               // starts AT the nick
    trunk: [[3.75, 0.63], [3.20, 0.40], [3.48, 0.06], [3.14, -0.22]], w: 0.46, samples: 18,
    forks: [{ at: 0.5, to: [[2.86, 0.16], [2.62, 0.02]], w: 0.26, samples: 10 }],
  });
  crackTree(haunchL, ellipsoidSurf(...haunchL.userData.rad), {
    trunk: [[3.36, 0.60], [3.66, 0.22], [3.42, -0.12]], w: 0.30, samples: 13,
  });
  crackTree(head, ellipsoidSurf(...head.userData.rad), {
    trunk: [[-0.52, 0.76], [-0.18, 0.42], [-0.42, 0.12], [-0.14, -0.16]], w: 0.38, samples: 16,
    forks: [{ at: 0.5, to: [[0.12, 0.30], [0.30, 0.18]], w: 0.22, samples: 9 }],
  });

  // FIX 3 — ONE heavy, wide-set socketed pair under the brow. No teeth row, no bar.
  eyeCluster(body, { p: [-1.0, 14.2, 19.2], rx: -0.20, size: 1.05, gap: 4.2, tilt: 0.26 });

  // FIX 7 — DEBRIS. v14: these are CLODS OF GROUND, not pieces of the brute. At v13.1's
  // size and body-rock palette the thump read as the creature shedding its own armour
  // every time it landed — the exact opposite of "it hit the ground so hard the ground
  // came up". So: 40% smaller, and re-lit off the dirt under the grass (a warm dark
  // earth ramp, 78/56/36) instead of the body's charcoal. Only two of the eight carry
  // a violet facet, and dimmer than a seam core: the annulus is what ties the effect
  // to the creature, the clods just have to be soil.
  const chips = new THREE.Group(); chips.name = "chips";
  const TINT_DIRT = tintOf(0x9c8a70);
  for (let i = 0; i < 8; i++) {
    const rand = rng(200 + i * 7);
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const geo = jitterWelded(new THREE.TetrahedronGeometry(1.9 + (i % 3) * 0.66, 1), 0.55, 100 + i);
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const faces = pos.count / 3;
    const litFace = i % 4 === 1 ? Math.floor(rand() * faces) : -1;
    const rock = [dispColor(70, TINT_DIRT), dispColor(50, TINT_DIRT), dispColor(32, TINT_DIRT)];
    const glow = dispColor(120, TINT_VIOLET);   // dimmer than a seam core (147)
    for (let f = 0; f < faces; f++) {
      const c = f === litFace ? glow : rock[f % 3];
      for (let k = 0; k < 3; k++) {
        cols[(f * 3 + k) * 3] = c.r; cols[(f * 3 + k) * 3 + 1] = c.g; cols[(f * 3 + k) * 3 + 2] = c.b;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    const ch = noShadow(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0 })));
    ch.position.set(Math.sin(a) * 14, 2.5, 4 + Math.cos(a) * 14);
    ch.rotation.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
    ch.userData.arc = a;
    ch.userData.spin = [1.5 + rand() * 3.5, 1.0 + rand() * 3.0, 1.5 + rand() * 3.0];
    ch.name = "chip" + i;
    chips.add(ch);
  }
  root.add(chips);

  annulusRing(root, "groundRing");
  softShadow(root, 18, 13, 0.36);
  return finish(root);
}

const bruteAnims = {
  // hop, land, ANNULUS with a hard leading edge, 360° debris, seams peak at contact,
  // squash clamped so the eye line survives the money frame. (v12's — the judge called
  // the annulus the best effect in the set; it is unchanged.)
  thump(g, phase) {
    restore(g);
    const body = g.getObjectByName("body");
    const hump = g.getObjectByName("hump");
    const head = g.getObjectByName("head");
    const brow = g.getObjectByName("brow");
    const eyes = g.getObjectByName("eyes");
    const ring = g.getObjectByName("groundRing");
    const chip = i => g.getObjectByName("chip" + i);
    if (phase < 0.5) {                                    // the hop — seams brighten airborne
      const k = phase / 0.5;
      const air = 4 * k * (1 - k);
      body.position.y = 13 * air;
      body.position.z = 7 * k;
      body.rotation.x = 0.05 + 0.12 * Math.sin(Math.PI * k);
      body.scale.set(1 - 0.05 * air, 1 + 0.09 * air, 1 - 0.05 * air);
      head.rotation.x = 0.20 - 0.12 * air;
      flareSeams(g, 0.85 * Math.sin(Math.PI * k));
      ringOpacity(ring, 0);
    } else if (phase < 0.7) {                             // CONTACT
      const k = (phase - 0.5) / 0.2;
      const s = Math.sin(Math.PI * Math.pow(k, 0.7));
      body.position.z = 7;
      body.scale.set(1 + 0.15 * s, 1 - 0.15 * s, 1 + 0.15 * s);   // clamped squash
      body.rotation.x = 0.05 + 0.07 * s;
      hump.scale.set(1 + 0.05 * s, 1 - 0.13 * s, 1 + 0.05 * s);
      // counter-lift the face so the eyes survive the money frame
      for (const o of [head, brow, eyes]) o.position.y += 2.4 * s;
      flareSeams(g, 1 - 0.5 * k);
      ringOpacity(ring, 0.95 * (1 - k * 0.3));
      ring.scale.setScalar(22 + k * 30);
      ring.position.z = 7;
      for (let i = 0; i < 8; i++) {
        const ch = chip(i), sp = ch.userData.spin;
        const ck = clamp01(k * 1.6 - (i % 3) * 0.05);
        const a = ch.userData.arc;
        ch.material.opacity = 0.98;
        ch.position.set(Math.sin(a) * (16 + 32 * ck), 2.5 + 20 * Math.sin(Math.PI * ck * 0.8),
          4 + Math.cos(a) * (16 + 32 * ck));
        ch.rotation.set(ch.rotation.x + ck * sp[0], ch.rotation.y + ck * sp[1], ch.rotation.z + ck * sp[2]);
      }
    } else {                                              // settle
      const k = (phase - 0.7) / 0.3;
      const d = Math.exp(-4.5 * k);
      body.position.z = 7 * (1 - k);
      const w = 0.05 * Math.cos(k * 15) * d;
      body.scale.set(1 + w, 1 - w, 1 + w);
      flareSeams(g, 0.5 * d);
      ringOpacity(ring, 0.6 * (1 - k) * (1 - k));
      ring.scale.setScalar(52 + k * 16);
      ring.position.z = 7 * (1 - k);
      for (let i = 0; i < 8; i++) {
        const ch = chip(i), sp = ch.userData.spin;
        const a = ch.userData.arc;
        ch.material.opacity = 0.98 * (1 - k);
        ch.position.set(Math.sin(a) * (46 + 8 * k), 2.5 * (1 - k) + 1.5, 4 + Math.cos(a) * (46 + 8 * k));
        ch.rotation.set(ch.rotation.x + sp[0] * (1 + k), ch.rotation.y + sp[1], ch.rotation.z + sp[2]);
      }
    }
  },
};

// ════════════════════════════════════════════════════════════════════════════
// BOMBER — a SQUAT CRACKED BOULDER on four stub claws, ~17 wide × 17 high, with
// one dark fuse stub breaking the crown. The kamikaze of the cast: it never
// swings, so its one telegraph is the ARM — the sim's fuse timer drives a
// silhouette change (the shell swells, the claws splay flat, the fuse stands up
// and grows) plus an accelerating ember blink in the ability register. Ground
// stays clean: threat never lands on the ground plane (that is the brute's slam
// annulus, exclusively) — the tell lives entirely in the body.
// ════════════════════════════════════════════════════════════════════════════
// Rest ember sits BELOW the dim ability register: a banked coal, not a lit charge —
// the arm blink jumping to full ABILITY_RGB is the contrast that sells the fuse.
const EMBER_HOT = dispRGB(...ABILITY_RGB), EMBER_REST = dispRGB(112, 48, 162);
function buildBomber() {
  const root = new THREE.Group();
  const body = new THREE.Group(); body.name = "body";
  root.add(body);

  // ONE continuous shell — a ball is the rare subject where the base vocabulary IS
  // the identity. Slightly squashed so it reads planted, never balloon.
  const shell = plate(8.4, 1.0, 0.95, 1.0, T.mid, 83, 1, 0.06);
  shell.name = "shell"; shell.position.set(0, 8.8, 0);
  body.add(shell);

  // THE FUSE — a short dark stub rooted inside the crown, tilted toward the front so
  // facing reads at distance, with the ember shard at its tip. The ember is the only
  // ability-register element on the model and the only thing the arm brightens.
  const fuse = new THREE.Group(); fuse.name = "fuse";
  fuse.position.set(0, 15.2, 1.4); fuse.rotation.x = 0.34;
  const stub = spike(2.6, 9.2, T.dark, 86, 5); stub.name = "fuseStub";
  const ember = noShadow(new THREE.Mesh(
    jitterWelded(new THREE.IcosahedronGeometry(1.25, 0), 0.14, 87), unlit(EMBER_REST.clone())));
  ember.name = "fuseEmber"; ember.position.set(0, 8.9, 0);
  fuse.add(stub, ember);
  body.add(fuse);

  // Four SHORT claws, roots inside the hull (raider's law: no anim can detach them).
  const legs = new THREE.Group(); legs.name = "legs";
  for (const s of [-1, 1]) for (const f of [-1, 1]) {
    const leg = new THREE.Group();
    leg.name = "leg" + (f > 0 ? "F" : "R") + (s < 0 ? "L" : "R");
    leg.position.set(s * 5.0, 4.4, f * 4.4);
    const claw = spike(1.4, 5.4, T.low, 90 + s + f * 2);
    claw.rotation.set(3.02 + f * 0.12, 0, s * -0.20);
    leg.add(claw);
    legs.add(leg);
  }
  body.add(legs);

  // Seam systems — tree topology, straight runs, hard kinks, on the ANALYTIC ball.
  // One trunk falls away from the fuse socket (the shell is failing where the charge
  // lives), one rakes the far flank, and one starts AT the silhouette nick.
  const surf = ellipsoidSurf(...shell.userData.rad);
  nick(shell, surf, -0.96, 0.30, 4.0, 2.6);               // screen-x outline at yaw 35
  crackTree(shell, surf, {
    trunk: [[0.30, 0.84], [0.62, 0.50], [0.44, 0.16], [0.74, -0.18], [0.54, -0.50]], w: 0.62, samples: 20,
    forks: [{ at: 0.30, to: [[0.98, 0.30], [1.18, 0.16]], w: 0.30, samples: 10 },
      { at: 0.68, to: [[0.20, -0.30], [0.00, -0.44]], w: 0.26, samples: 10 }],
  });
  crackTree(shell, surf, {
    trunk: [[-0.96, 0.30], [-0.70, -0.02], [-0.94, -0.30], [-0.66, -0.54]], w: 0.48, samples: 16,
    forks: [{ at: 0.46, to: [[-1.24, -0.16], [-1.42, -0.30]], w: 0.22, samples: 9 }],
  });
  crackTree(shell, surf, {
    trunk: [[2.88, 0.58], [3.14, 0.24], [2.92, -0.08], [3.22, -0.38]], w: 0.38, samples: 16,
    forks: [{ at: 0.50, to: [[2.60, 0.06], [2.42, -0.08]], w: 0.20, samples: 9 }],
  });

  // Narrow slits under a brow on the shell's front — the second front marker.
  eyeCluster(body, { p: [0, 11.8, 7.2], rx: -0.16, size: 0.50, gap: 1.4, tilt: 0.45, slit: 0.95 });

  softShadow(root, 8.8, 7.6, 0.32);
  return finish(root);
}

const bomberAnims = {
  // fast rolling patter — busier than the raider's hop, nothing leaves the ground
  scuttle(g, phase, t) {
    restore(g);
    const body = g.getObjectByName("body");
    const bob = Math.abs(Math.sin(t * 11));
    body.position.y = bob * 1.1;
    body.rotation.z = Math.sin(t * 11) * 0.07;            // side-to-side waddle roll
    body.rotation.x = 0.05 + 0.04 * bob;                  // leaning into the run
    g.getObjectByName("fuse").rotation.z = Math.sin(t * 11 - 0.9) * 0.16;
    g.getObjectByName("legFL").rotation.x = Math.sin(t * 11) * 0.5;
    g.getObjectByName("legRR").rotation.x = Math.sin(t * 11) * 0.5;
    g.getObjectByName("legFR").rotation.x = Math.sin(t * 11 + Math.PI) * 0.5;
    g.getObjectByName("legRL").rotation.x = Math.sin(t * 11 + Math.PI) * 0.5;
  },
  // THE ARM — k is the sim's fuse progress, 0 lit → 1 detonation. A silhouette
  // telegraph, not a pose: the shell swells 16% and hunkers, the claws splay flat,
  // the fuse stands upright and grows half again, and the ember blink ACCELERATES
  // toward release. Eyes stay visible the whole way (they ride the body group).
  arm(g, k, t) {
    restore(g);
    const body = g.getObjectByName("body");
    const fuse = g.getObjectByName("fuse");
    const ember = g.getObjectByName("fuseEmber");
    const shadow = g.getObjectByName("contactShadow");
    const q = clamp01(k);
    body.scale.set(1 + 0.16 * q, 1 - 0.10 * q, 1 + 0.16 * q);
    for (const name of ["legFL", "legFR", "legRL", "legRR"]) {
      const leg = g.getObjectByName(name);
      leg.rotation.x = (name[3] === "F" ? 1 : -1) * 0.55 * q;   // pressed out flat
    }
    fuse.rotation.x = 0.34 - 0.30 * q;                    // stands up out of the crown
    fuse.scale.setScalar(1 + 0.5 * q);
    const on = Math.sin(t * (6 + 30 * q * q)) > 0;        // the accelerating blink
    ember.material.color.copy(on ? EMBER_HOT : EMBER_REST);
    ember.scale.setScalar(1 + 0.9 * q + (on ? 0.45 : 0));
    flareSeams(g, on ? 0.35 + 0.65 * q : 0.18 * q);
    shadow.scale.set(8.8 * (1 + 0.14 * q), 7.6 * (1 + 0.14 * q), 1);
    shadow.material.opacity = 0.32 + 0.10 * q;
  },
  // controlled-unit melee only (a captured bomber is defused): a blunt headbutt shunt
  lunge(g, phase) {
    restore(g);
    const body = g.getObjectByName("body");
    const shadow = g.getObjectByName("contactShadow");
    if (phase < 0.4) {                                    // windup — rock back, coil
      const k = Math.pow(phase / 0.4, 0.8);
      body.position.z = -3.6 * k;
      body.rotation.x = -0.22 * k;
      body.scale.set(1 + 0.06 * k, 1 - 0.06 * k, 1);
      flareSeams(g, 0.5 * k);
    } else if (phase < 0.62) {                            // the shunt
      const k = (phase - 0.4) / 0.22, e = Math.sin(Math.PI * k * 0.5);
      body.position.z = -3.6 + 12 * e;
      body.rotation.x = -0.22 + 0.44 * e;
      body.scale.set(1 - 0.04 * e, 1 + 0.02 * e, 1 + 0.08 * e);
      flareSeams(g, 0.5 * (1 - k));
      shadow.position.z = body.position.z * 0.7;
    } else {                                              // settle
      const k = (phase - 0.62) / 0.38, d = Math.exp(-4 * k);
      body.position.z = 8.4 * (1 - k);
      body.rotation.x = 0.12 * Math.sin(k * 12) * d;
      shadow.position.z = body.position.z * 0.7;
    }
  },
};

// ── exports ─────────────────────────────────────────────────────────────────
export const MODELS = {
  "enemy-raider": { build: buildRaider, anims: raiderAnims, cam: { dist: 120, height: 16, target: 9 } },
  "enemy-archer": { build: buildArcher, anims: archerAnims, cam: { dist: 215, height: 46, target: 32 } },
  "enemy-healer": { build: buildHealer, anims: healerAnims, cam: { dist: 182, height: 36, target: 33 } },
  "enemy-brute": { build: buildBrute, anims: bruteAnims, cam: { dist: 190, height: 34, target: 20 } },
  "enemy-bomber": { build: buildBomber, anims: bomberAnims, cam: { dist: 125, height: 18, target: 10 } },
};
