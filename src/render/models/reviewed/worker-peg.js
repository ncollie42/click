// The five peg villagers — quality bar: docs/reference/workers.png (see docs/model-spec.md,
// docs/quality-bar.md). Standalone module: imports THREE only, palette hexes hardcoded so the
// viewer can load it with zero game imports.
//
// v16 — ONE SHELL, ONE MESH. v15 still stacked primitives: a lathed cowl ending in a hard
// horizontal cut on a lighter pot, a cream face-patch floating proud of it (and poking THROUGH
// it from behind), and a "brim" that only existed on the flanks. v16 authors the whole cowl —
// crown, face, jaw, shoulder fold and back-cape — as a SINGLE BufferGeometry with three material
// groups. Consequences that matter:
//   * the face is CARVED, not applied: the front vertices of three shell rings are snapped onto
//     one flat plane and painted cream. Same vertices, same mesh — poke-through is geometrically
//     impossible, and the cheek chamfer is the shell's own facet.
//   * the colour breaks land on MODELED edge loops: hood -> cape at the shoulder FOLD ring
//     (the radius tucks to 5.80 at the jaw then kicks back to 5.82 over a 1.1 px drop — a real
//     fabric crease), cape -> coat at the scalloped hem lip, whose height swings with cos(phi):
//     short at the chest, falling into a long tail at the back. No break sits on a primitive
//     intersection, and from directly behind the outline runs crown-to-hem uninterrupted.
//   * facet density is UNIFIED: SEG = 12 for shell and coat, both lathed from phi = 15 deg, so
//     the vertical creases line up through the hem, the face straddles the centre line instead
//     of being split by a seam, and the crown is a flat 12-gon cap — no pole convergence.
//
// Profile numbers are MEASURED off the sheet (guard silhouette, 303 px tall, segmented by hue):
//   belly max radius / height = 0.264      waist radius / hood max radius = 0.86
//   hood max radius / belly max radius = 0.80       belly max at t = 0.21, hood max at t = 0.745
//
// Contract: MODELS[name] = { build, anims, cam }
//   build() -> THREE.Group, origin at ground center, sim-px scale, ~27 px tall.
//   anims[name](group, phase01, tSeconds) — deterministic; parts reset from stored rest
//   transforms every call, so anims never accumulate.
//
// Group tree (names are the integration contract):
//   root -> body -> [coat, strap/belt, head -> [shell, brim, eyeL, eyeR, band*],
//                    axe*, basket*, hammer*, shield*, spear*, stack*]
//
// REST-SNAPSHOT AUDIT (sibling-module bug class): record()/restore() operate on `parts`, and
// `parts` NEVER contains `root` — see assemble(), which builds the map from body/head/shell plus
// whatever dress() adds, all of them descendants. The root's placement (the wrapper's yaw and
// position in models.js) is therefore never captured and never restored, so an animated worker
// cannot teleport to world origin. assertNoRoot() below makes that structural, not a comment.
import * as THREE from "three";
import {SWATCH as S} from "../../palette.js";

// ── palette (five-hue unit coding — judged BETTER than the reference; do not drift) ─────────
// Aug 22 migration: the five hues survive, the hexes do not — every ink is a shared swatch
// (palette.js SWATCH). OKLab-nearest (scripts/palette-snap.mjs) picked most of them; the COAT
// values were pulled DOWN a step by hand because a worker is an actor on the meadow and
// palette.js COLOUR THEORY requires its value to clear SWATCH.green1/green2 by a visible margin.
// Nearest for the old tan coat (0xbd9455) and the old olive coat (0xb09a55) was literally
// green1 — the grass — which is the exact collision the doctrine forbids, so the coats went dark
// (wood1 / green4) and hue keeps doing the job-coding. Values, top to bottom:
//   skin stone0 .85 · delivery red0 .84 · haul blue2 .52 · guard grey0 .52 · carrier wood1 .50 ·
//   gatherer green4 .45  — all ≥ .10 OKLab-L clear of the lit meadow (green1 .72).
const C = {
  skin: S.stone0,          // warm cream — still 3+ value steps above every coat, but pulled
                           // off near-white so the face reads as a HEAD, not a lamp
  coat: S.wood1,           // tan carrier
  hoodTan: S.wood2,        // richer brown cowl for the tan units
  jobHaul: S.blue2,        // denim blue
  jobDelivery: S.red0,     // marigold
  jobGuard: S.grey0,       // chocolate, lifted a touch
  coatOlive: S.green4, hoodOlive: S.teal0,   // gatherer: olive cowl over olive, both under the meadow
  hat: S.wood1, strapDark: S.wood2,
  blade: S.stone0, metal: S.stone1, metalDark: S.grey0,
  trunk: S.wood2, wood: S.wood0, timberDark: S.wood2,
  haft: S.wood2,           // warm dark brown — NOT the near-black v15 used, which read as an
                           // outline artifact rather than a wooden handle
  eye: S.shade2,
  barkLog: S.wood0, logCap: S.cream0, logRing: S.wood1,   // cream end-grain so "logs" read at range
};
const shade = (hex, f) => new THREE.Color(hex).multiplyScalar(f).getHex();
const mat = hex => new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
const dmat = hex => new THREE.MeshLambertMaterial({ color: hex, flatShading: true, side: THREE.DoubleSide });

// ── geometry helpers ────────────────────────────────────────────────────────
// Every hand-built surface here is emitted through triOut(), which orients each triangle away
// from a supplied reference point. Winding stops being a thing that can be silently wrong.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function triOut(p, a, b, c, ref) {
  const u = sub(b, a), v = sub(c, a);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const d = [(a[0] + b[0] + c[0]) / 3 - ref[0], (a[1] + b[1] + c[1]) / 3 - ref[1],
             (a[2] + b[2] + c[2]) / 3 - ref[2]];
  if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0) p.push(...a, ...c, ...b);
  else p.push(...a, ...b, ...c);
}
function geoFrom(groups) {                       // groups: [[positions, materialIndex], ...]
  const all = [];
  const g = new THREE.BufferGeometry();
  let start = 0;
  for (const [pos, mi] of groups) {
    if (!pos.length) continue;
    all.push(...pos);
    g.addGroup(start, pos.length / 3, mi);
    start += pos.length / 3;
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(all, 3));
  g.computeVertexNormals();
  return g;
}

// ── THE SHELL ───────────────────────────────────────────────────────────────
const SEG = 12;                 // radial segments — few, large, load-bearing planes
const PHI0 = Math.PI / SEG;     // 15 deg: vertices at +-15/+-45, so the face STRADDLES the centre
const WAIST = 15.4;             // hem line, and the head group's pivot (a real shoulder pivot)

// [r, y], bottom-to-top. Slope segments are deliberate: base flare / belly / shoulder taper.
const COAT_PROFILE = [
  [0.00,  0.00], [2.95,  0.00],   // small contact ellipse — the sheet tucks hard at the floor
  [5.72,  2.20],                  // base flare
  [7.19,  4.90], [7.12,  8.00],   // belly, widest at t~0.21 like the sheet
  [6.23, 11.40],                  // shoulder taper
  [5.00, WAIST],                  // the waist — a GENTLE pinch (0.86 of hood max), not a neck
  [4.62, 17.30],                  // continues up INSIDE the cowl, hidden. Tapered, not flared:
                                  // at r = 5.36 this ring's front sat 0.03 px PROUD of the carved
                                  // face plane and printed a dark chip in the middle of the face
                                  // — the same poke-through class the judge caught in v15.
];
function coatR(y) {                     // world-space radius of the coat lathe at height y
  const P = COAT_PROFILE;
  if (y <= P[0][1]) return P[1][0];
  for (let i = 1; i < P.length; i++) {
    if (y > P[i][1]) continue;
    const span = P[i][1] - P[i - 1][1];
    if (span <= 0) return P[i][0];
    const k = (y - P[i - 1][1]) / span;
    return P[i - 1][0] + (P[i][0] - P[i - 1][0]) * k;
  }
  return P[P.length - 1][0];
}
const lathe = prof => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), SEG, PHI0);

// The carved face plane. FACE_Z sits ~0.8 behind the shell's own brow bulge and ~1.8 behind the
// brim's front lip; the lip's underside faces down-and-forward, takes almost no key light, and
// prints the flat-shaded shadow band across the forehead. Do NOT push FACE_Z further back: the
// coat's hidden top ring and the fold's chest drape both live around z = 5.2, and anything in
// front of the plane climbs up over the chin under the game's 40-degree camera.
const FACE_Z = 5.15;
const BROW_Y = 5.90, JAW_Y = -0.30;
const FOLD_Y = -1.25;                       // the shoulder fold: hood value ends HERE, on a crease
// Scalloped hem, cos(phi): SHORT at the chest, long into a back tail. Two things fall out of
// that phase choice — the cowl reads as the reference's back-cape rather than a bib, and the
// chest drape stops ballooning forward under the chin, which from a 32-degree camera was
// climbing up and occluding the bottom of the carved face.
const HEM_BASE = -3.30, HEM_AMP = 1.85;
const CROWN = 11.05;

// Shell rings, crown-first. `hw` marks the three FACE rings: their front vertices (|phi| <= 45)
// are snapped onto z = FACE_Z and pinched to +-hw, which cuts the flat pentagonal face plane and
// leaves the 45->75 deg quad as a real cheek chamfer. `zc` is a softer front flattening (the
// jaw plane and the chest bib) with no pinch. `cape` rings ride the coat at a fixed offset, so
// the cowl's skirt can never be swallowed by the body it drapes over.
const RINGS = [
  { y: CROWN,  r: 3.25 },                                  // flat 12-gon crown — no pole
  { y:  8.70,  r: 5.28 },
  { y: BROW_Y, r: 5.94, hw: 3.30 },                        // BROW  — top edge of the face
  { y:  2.80,  r: 6.04, hw: 3.56 },                        // CHEEK — widest
  { y: JAW_Y,  r: 5.80, hw: 2.66 },                        // JAW   — chin, narrowed: pentagon
  { y: FOLD_Y, r: 5.82 },                                  // SHOULDER FOLD — kicks OUT. break #1
  { cape: 0.55, off: 0.62, m: 1 },                         // cape mid-drape
  { cape: 1.00, off: 0.80, m: 1 },                         // scalloped hem lip.       break #2
];
const phiAt = i => PHI0 + (i / SEG) * Math.PI * 2;
const inFront = i => {
  let a = phiAt(i) % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  return Math.abs(a) <= Math.PI / 4 + 1e-6;
};
const slouch = y => (y > 7.5 ? -0.030 * (y - 7.5) ** 2 : 0);   // the sheet's beanies lean BACK

function ringVert(ring, i) {
  const phi = phiAt(i);
  let y, r;
  if (ring.cape != null) {
    const hemY = HEM_BASE + HEM_AMP * Math.cos(phi);
    y = FOLD_Y + (hemY - FOLD_Y) * ring.cape;
    r = coatR(y + WAIST) + ring.off;
  } else { y = ring.y; r = ring.r; }
  let x = r * Math.sin(phi), z = r * Math.cos(phi);
  if (ring.hw != null && inFront(i)) {          // THE CARVE — shared vertices, one flat plane
    z = FACE_Z;
    x = Math.max(-ring.hw, Math.min(ring.hw, x));
  } else if (ring.zc != null) {
    z = Math.min(z, ring.zc);
  }
  return [x, y + 0, z + slouch(y)];
}
// Radius / half-width of the shell at an arbitrary height — used to seat the brim ON the shell.
function lerpRing(y, key) {
  for (let i = 1; i < 6; i++) {                 // non-cape rings only: 0 .. FOLD
    const a = RINGS[i - 1], b = RINGS[i];
    if (y > a.y || y < b.y) continue;
    const k = (a.y - y) / (a.y - b.y);
    const av = a[key], bv = b[key];
    if (av == null || bv == null) return null;
    return av + (bv - av) * k;
  }
  return null;
}
function shellFrontZ(px, py) {
  const R = lerpRing(py, "r") ?? RINGS[2].r;
  const hw = lerpRing(py, "hw");
  const ax = Math.abs(px);
  const sphere = Math.sqrt(Math.max(0.4, R * R - px * px));
  if (hw == null) return sphere + slouch(py);
  if (ax <= hw) return FACE_Z;
  const xc = R * Math.SQRT1_2;                    // the 45 deg vertex: end of the cheek chamfer
  if (ax >= xc) return sphere;
  return FACE_Z + (xc - FACE_Z) * ((ax - hw) / (xc - hw));
}

function buildShellGeo() {
  const hood = [], cape = [], skin = [];
  const V = RINGS.map(ring => Array.from({ length: SEG }, (_, i) => ringVert(ring, i)));
  // crown cap: a flat polygon, not a converging pole
  const cap = [0, CROWN, slouch(CROWN)];
  for (let i = 0; i < SEG; i++)
    triOut(hood, cap, V[0][i], V[0][(i + 1) % SEG], [0, CROWN - 4, 0]);
  // bands, top ring -> bottom ring
  for (let k = 0; k + 1 < RINGS.length; k++) {
    const up = V[k], lo = V[k + 1], ring = RINGS[k + 1];
    const faceBand = RINGS[k].hw != null && ring.hw != null;
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      const isFace = faceBand && inFront(i) && inFront(j);
      const out = isFace ? skin : (ring.m === 1 ? cape : hood);
      const ref = [0, (up[i][1] + lo[i][1]) / 2, 0];
      triOut(out, lo[i], lo[j], up[i], ref);
      triOut(out, lo[j], up[j], up[i], ref);
    }
  }
  return geoFrom([[hood, 0], [cape, 1], [skin, 2]]);
}

// ── THE BRIM ────────────────────────────────────────────────────────────────
// A closed 8-segment band wrapping the FULL front opening: over the brow, down both cheeks,
// dying into the jaw. Each station carries three vertices — A welded onto the shell surface,
// B the front lip (pushed out AND dropped in y, so it physically overhangs the face), C the
// outer roll landing back on the shell. The A->B strip therefore faces down-and-forward and
// takes almost no key light: that dark band above the eyes IS the shadow, no shadow map needed.
const BRIM_PATH = [
  [-3.00, 0.40], [-4.00, 2.85], [-3.95, 5.10], [-2.55, 6.50],
  [ 0.00, 6.85],
  [ 2.55, 6.50], [ 3.95, 5.10], [ 4.00, 2.85], [ 3.00, 0.40],
];
const BRIM_C = 2.90;                    // the opening's centre, for the outward normal
function buildBrimGeo() {
  const N = BRIM_PATH.length - 1;
  const stations = BRIM_PATH.map(([px, py], i) => {
    const u = i / N;
    // taper to nothing at both ends: v15's roll simply stopped, leaving two pale tusks either
    // side of the chin. A brim has to die back into the shell it grew out of.
    const w = Math.min(1, 2.3 * Math.min(u, 1 - u));
    const L = Math.hypot(px, py - BRIM_C) || 1;
    const nx = px / L, ny = (py - BRIM_C) / L;
    const z0 = shellFrontZ(px, py);
    const up = Math.max(0, Math.min(1, (py - 0.30) / 6.20));
    const lip = (0.32 + 0.72 * up) * w;                  // deepest overhang over the brow
    const A = [px, py, z0 - 0.12];
    const B = [px + nx * 0.22 * w, py + ny * 0.22 * w - (0.10 + 1.35 * up) * w, z0 + lip];
    const cx = px + nx * 0.62 * w, cy = py + ny * 0.62 * w;
    const C = [cx, cy, shellFrontZ(cx, cy) + 0.14 * w];
    return [A, C, B];                                    // ring order: CCW about the path
  });
  const p = [];
  for (let s = 0; s + 1 < stations.length; s++) {
    const P = stations[s], Q = stations[s + 1];
    const ctr = [0, 1, 2].reduce((acc, k) => [acc[0] + (P[k][0] + Q[k][0]) / 6,
      acc[1] + (P[k][1] + Q[k][1]) / 6, acc[2] + (P[k][2] + Q[k][2]) / 6], [0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      const l = (k + 1) % 3;
      triOut(p, P[k], P[l], Q[l], ctr);
      triOut(p, P[k], Q[l], Q[k], ctr);
    }
  }
  for (const [cap, sgn] of [[stations[0], -1], [stations[stations.length - 1], 1]]) {
    const ctr = [cap[0][0] + sgn * 2, (cap[0][1] + cap[1][1] + cap[2][1]) / 3, (cap[0][2] + cap[1][2] + cap[2][2]) / 3];
    triOut(p, cap[0], cap[1], cap[2], ctr);
  }
  return geoFrom([[p, 0]]);
}

// ── shared body ─────────────────────────────────────────────────────────────
function buildBody(coatHex, hoodHex = coatHex, opt = {}) {
  const body = new THREE.Group(); body.name = "body";
  const coat = new THREE.Mesh(lathe(COAT_PROFILE), mat(coatHex));
  coat.name = "coat";
  body.add(coat);

  const head = new THREE.Group(); head.name = "head";
  head.position.y = WAIST;                       // pivot at the shoulder, not inside a skull
  // three-step value ramp crown -> hem: hood, then the cape one step LIGHTER (cloth catching the
  // sky over the shoulders), then the coat. Every step lands on a modeled edge, never a seam.
  const capeHex = opt.capeHex ?? shade(hoodHex, 1.13);
  const shell = new THREE.Mesh(buildShellGeo(), [mat(hoodHex), mat(capeHex), mat(C.skin)]);
  shell.name = "hood";                           // name kept: the shell IS the hood now
  head.add(shell);

  const brim = new THREE.Mesh(buildBrimGeo(), mat(shade(hoodHex, opt.brimWide ? 1.09 : 1.03)));
  brim.name = "brim";
  head.add(brim);

  for (const s of [-1, 1]) {                     // big eyes — banked win. v16 spaces them wider
    const eye = new THREE.Mesh(new THREE.BoxGeometry(1.14, 2.44, 0.42), mat(C.eye));
    eye.name = s < 0 ? "eyeL" : "eyeR";          // and lifts them to face centre: v15's low, tight
    eye.position.set(s * 1.72, 3.25, FACE_Z + 0.16);   // pair read "startled"
    head.add(eye);
  }
  body.add(head);
  return body;
}

function chestStrap(body, lean = 0.62) {
  // sits BELOW the cape hem now — the cowl owns the shoulders, the strap crosses the belly
  const strap = new THREE.Mesh(new THREE.TorusGeometry(6.98, 0.74, 4, 16), mat(C.hat));
  strap.name = "strap";
  strap.position.y = 8.60;
  // Euler order XYZ applies Z first, and a torus is symmetric about its own z — so rotation.z
  // is a no-op here. Y-then-X tilts the ring's PLANE, which is what makes a bandolier.
  strap.rotation.set(Math.PI / 2, lean, 0);
  strap.scale.set(1, 1, 1.5);
  body.add(strap);
  return strap;
}
function belt(body) {
  const g = new THREE.Group(); g.name = "beltG";
  const b = new THREE.Mesh(new THREE.TorusGeometry(7.02, 0.66, 4, 16), mat(C.hat));
  b.rotation.x = Math.PI / 2; b.position.y = 8.40; b.scale.set(1, 1, 1.6);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.9, 0.7), mat(C.metal));
  buckle.position.set(0, 8.40, 7.0);
  g.add(b, buckle);
  body.add(g);
  return g;
}
// A seat for a prop: the small dark nub a shaft rests against, so nothing "passes through" the
// coat — the contact is designed and visible.
function seat(body, x, y, z, rz = 0) {
  const n = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.5, 1.9), mat(C.strapDark));
  n.position.set(x, y, z);
  n.rotation.set(0, Math.atan2(x, z), rz);
  body.add(n);
  return n;
}

// ── props (groups pivoted at the strap point; sized to break the silhouette) ─
function buildAxe() {
  // A real bearded axe is a PROFILE: narrow socket, top shoulder that flares out and up, a
  // cutting edge that bows forward, and a beard that hooks back under the haft. v16 keeps that
  // outline and fixes the VALUES: the haft is warm dark brown rather than near-black (v15's read
  // as an ink outline, not a handle) and the cheek is dark metal, so bit / beard / poll / haft
  // are four separate values against the tan coat.
  const axe = new THREE.Group(); axe.name = "axe";
  const cheekSteel = C.metalDark, bitSteel = C.blade, steelEdge = S.cream0;
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.25, 14.5, 6), mat(C.haft));
  handle.name = "haft";
  axe.add(handle);
  const buttCap = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.30, 1.5, 6), mat(C.strapDark));
  buttCap.position.y = -6.9;                 // the BUTT, deliberately clear below the strap
  axe.add(buttCap);
  const head = new THREE.Group(); head.name = "axeHead"; head.position.y = 3.9;
  head.scale.setScalar(1.00);
  head.rotation.y = 0.30;   // profile square to the yaw-35 sheet camera; chop() unspins both
  head.rotation.z = 0.30;
  const cheekMesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.3, 2.1), mat(cheekSteel));
  cheekMesh.position.set(0.15, 0.20, 0);   // a dark socket, not a brick over half the bit
  const poll = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.0, 2.0), mat(bitSteel));
  poll.position.set(-1.6, 0.35, 0);        // butt on the far side: the haft runs THROUGH the head
  head.add(poll, cheekMesh);
  // outline, counter-clockwise in the profile plane: socket top, shoulder, edge top,
  // edge belly, edge bottom, beard tip, beard hook, socket bottom. Sized off the sheet:
  // clearly wider than tall — an outline that is taller than long reads as a pebble.
  const BIT = [
    [1.10,  2.05], [4.10,  2.80], [7.55,  1.25], [8.30, -0.60],
    [6.95, -2.75], [4.35, -5.40], [2.30, -2.45], [1.10, -1.45],
  ];
  const half = x => Math.max(0.18, 1.20 - 0.125 * x);   // thick at the socket, thin at the edge
  const p = [];
  const F = BIT.map(([x, y]) => [x, y,  half(x)]);
  const B = BIT.map(([x, y]) => [x, y, -half(x)]);
  // Cheek faces fan from a raised SPINE point rather than a corner, so each cheek breaks into
  // eight planes with different normals. A single flat fan lit the whole bit as one pale blob.
  const spineF = [3.9, -0.35,  half(3.9) + 0.34], spineB = [3.9, -0.35, -half(3.9) - 0.34];
  const ref = [3.9, -0.35, 0];
  for (let i = 0; i < BIT.length; i++) {
    const j = (i + 1) % BIT.length;
    triOut(p, spineF, F[i], F[j], ref);
    triOut(p, spineB, B[j], B[i], ref);
    triOut(p, F[i], B[i], F[j], ref);                   // rim band around the profile
    triOut(p, F[j], B[i], B[j], ref);
  }
  head.add(new THREE.Mesh(geoFrom([[p, 0]]), mat(bitSteel)));
  // the bright strip rides the three cutting-edge segments, so the glint follows the bow of the
  // blade instead of sitting as one flat rectangle
  const EDGE = [[7.60, 1.20], [8.30, -0.55], [7.20, -2.35]];
  for (let i = 0; i < EDGE.length - 1; i++) {
    const [x0, y0] = EDGE[i], [x1, y1] = EDGE[i + 1];
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.45, L + 0.2, 0.5), mat(steelEdge));
    seg.position.set((x0 + x1) / 2 + (dy / L) * 0.10, (y0 + y1) / 2 - (dx / L) * 0.10, 0);
    seg.rotation.z = Math.atan2(dy, dx) + Math.PI / 2;
    head.add(seg);
  }
  axe.add(head);
  return axe;
}
function buildBasket() {
  // An ACTUAL weave. Four courses of staggered horizontal slats riding over vertical stakes,
  // half-slot offset course to course, so the surface reads as basketry geometry instead of a
  // fluted cylinder. Dark inner shell sells "hollow vessel".
  const basket = new THREE.Group(); basket.name = "basket";
  const N = 10, COURSES = 4, HGT = 10.6, RB = 4.35, RT = 5.55;
  const rAt = v => RB + (RT - RB) * v;
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(RT - 0.1, RB - 0.1, HGT, N, 1, true),
    dmat(shade(C.wood, 0.5)));
  basket.add(wall);
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(RB, RB, 0.6, N), mat(shade(C.wood, 0.45)));
  floor.position.y = -HGT / 2 + 0.3;
  basket.add(floor);
  for (let i = 0; i < N; i++) {                              // stakes (the warp)
    const a = (i / N) * Math.PI * 2;
    const r = rAt(0.5) - 0.05;
    const stake = new THREE.Mesh(new THREE.BoxGeometry(0.9, HGT + 0.2, 0.85), mat(shade(C.wood, 0.66)));
    stake.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
    stake.rotation.y = a;
    basket.add(stake);
  }
  for (let c = 0; c < COURSES; c++) {                        // courses (the weft), staggered
    const v = (c + 0.5) / COURSES, y = -HGT / 2 + v * HGT, r = rAt(v) + 0.34;
    const off = (c % 2) ? Math.PI / N : 0;
    const w = (2 * Math.PI * r / N) * 0.86;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + off;
      const slat = new THREE.Mesh(new THREE.BoxGeometry(w, (HGT / COURSES) * 0.74, 0.8),
        mat(c % 2 ? shade(C.wood, 1.06) : shade(C.wood, 0.84)));
      slat.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
      slat.rotation.y = a;
      basket.add(slat);
    }
  }
  const rim = new THREE.Mesh(new THREE.TorusGeometry(RT + 0.15, 0.62, 4, N + 2), mat(shade(C.wood, 0.62)));
  rim.rotation.x = Math.PI / 2; rim.position.y = HGT / 2;
  basket.add(rim);
  return basket;
}
function buildHammer() {
  // Glyph split from the axe: short FAT box head, pale faces on BOTH ends, stubby handle — at
  // 30px the axe is "wide flat blade", the hammer is "fat block". Pivot is the BELT LOOP at the
  // top, so the haft hangs DOWN the flank and never tunnels through the coat.
  const h = new THREE.Group(); h.name = "hammer";
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.92, 6.2, 6), mat(C.haft));
  handle.name = "haft";
  handle.position.y = -4.0;
  h.add(handle);
  const head = new THREE.Group(); head.name = "hammerHead";
  head.add(new THREE.Mesh(new THREE.BoxGeometry(4.7, 2.6, 2.5), mat(S.stone2)));
  for (const s of [-1, 1]) {                       // pale striking faces on BOTH ends
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.85, 3.0, 2.9), mat(S.stone0));
    face.position.x = s * 2.55;
    head.add(face);
  }
  h.add(head);
  return h;
}
function buildShield() {
  // A SOLID: front face, rim ring, back face, real thickness, rigid and planar. v15's disc lost
  // its back entirely at yaw 180 and read as a warped orange crescent hugging the torso.
  const s = new THREE.Group(); s.name = "shield";
  const N = 10, R = 5.85, T = 1.90;
  const boards = new THREE.Mesh(new THREE.CylinderGeometry(R, R, T, N), mat(S.wood0));
  boards.rotation.x = Math.PI / 2;
  s.add(boards);
  for (const z of [T / 2 - 0.10, -T / 2 + 0.10]) {       // rim ring proud on BOTH faces
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.20, 0.62, 4, N), mat(S.cream1));
    rim.position.z = z;
    s.add(rim);
  }
  for (const y of [-2.85, 0, 2.85]) {                    // three plank divisions across the face
    const seam = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.42, 0.34), mat(S.wood1));
    seam.position.set(0, y, T / 2 + 0.02);
    s.add(seam);
  }
  const backBar = new THREE.Mesh(new THREE.BoxGeometry(9.4, 1.5, 0.7), mat(C.strapDark));
  backBar.position.z = -T / 2 - 0.28; backBar.rotation.z = 0.5;
  s.add(backBar);
  const boss = new THREE.Mesh(new THREE.SphereGeometry(2.05, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2),
    mat(C.metal));                                       // FACETED hemisphere, metal value
  boss.rotation.x = Math.PI / 2; boss.position.z = T / 2 - 0.05;
  const bossRing = new THREE.Mesh(new THREE.TorusGeometry(2.30, 0.34, 4, 8), mat(C.metalDark));
  bossRing.position.z = T / 2 + 0.05;
  s.add(boss, bossRing);
  return s;
}
function buildSpear() {
  // Pivot at the BUTT (local y = 0) so the shaft can be seated against the body instead of run
  // through it. Three values, none of them near-black: wood-brown shaft, dark ferrule collar,
  // LIGHT metal leaf blade with a centre ridge — two facets per side, per face.
  const sp = new THREE.Group(); sp.name = "spear";
  const LEN = 25.0;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.80, 0.98, LEN, 6), mat(C.trunk));
  shaft.name = "shaft";
  shaft.position.y = LEN / 2;
  sp.add(shaft);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.05, 1.3, 6), mat(C.strapDark));
  butt.position.y = 0.45;
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(1.28, 1.12, 2.2, 6), mat(C.strapDark));
  ferrule.position.y = LEN - 0.6;                 // dark collar under the blade — v15's binding
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 3.0, 6), mat(C.strapDark));
  grip.position.y = LEN * 0.42;                   // was black-on-black and read as an artifact
  sp.add(butt, ferrule, grip);
  // leaf blade: half-outline (bottom -> tip), mirrored, with a raised spine at x = 0
  const OUT = [[0.00, 0.00], [1.60, 1.65], [2.08, 4.30], [1.28, 6.90], [0.00, 8.90]];
  const ridge = k => 0.86 * Math.sin(Math.PI * Math.min(1, Math.max(0.06, k)));
  const p = [];
  for (const s2 of [1, -1]) for (const f of [1, -1]) {
    for (let k = 0; k + 1 < OUT.length; k++) {
      const y0 = OUT[k][1], y1 = OUT[k + 1][1];
      const R0 = [0, y0, f * ridge(k / (OUT.length - 1))];
      const R1 = [0, y1, f * ridge((k + 1) / (OUT.length - 1))];
      const E0 = [s2 * OUT[k][0], y0, 0], E1 = [s2 * OUT[k + 1][0], y1, 0];
      triOut(p, R0, R1, E1, [0, (y0 + y1) / 2, 0]);
      triOut(p, R0, E1, E0, [0, (y0 + y1) / 2, 0]);
    }
  }
  const blade = new THREE.Mesh(geoFrom([[p, 0]]), mat(C.blade));
  blade.name = "blade";
  blade.position.y = LEN + 0.2;
  sp.add(blade);
  return sp;
}
function buildLogStack() {
  // The sheet's bundle is a 3+2 stack that overhangs the body on both sides, 8-sided so the
  // end-grain caps read as cut timber.
  const stack = new THREE.Group(); stack.name = "stack";
  const bark = mat(C.barkLog), barkDark = mat(shade(C.barkLog, 0.78)), cap = mat(C.logCap);
  const log = (x, y, z, len, r, dark) => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), [dark ? barkDark : bark, cap, cap]);
    g.add(m);
    for (const e of [-1, 1]) {                  // end-grain ring loop at each cut
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.42, 0.22, 4, 10), mat(C.logRing));
      ring.rotation.x = Math.PI / 2; ring.position.y = e * (len / 2 + 0.10);
      g.add(ring);
    }
    g.rotation.z = Math.PI / 2;
    g.position.set(x, y, z);
    return g;
  };
  stack.add(
    log(-1.5, 0.0, -2.6, 16.4, 2.62, true),     // staggered lengths AND offsets so the cut ends
    log( 0.9, 0.2,  2.1, 15.0, 2.48, false),    // fan out as a cluster of end-grain discs
    log(-0.4, 4.6, -0.4, 13.6, 2.34, true),
    log( 1.3, 4.4,  4.2, 12.6, 2.16, false),
    log(-0.8, 8.5,  1.4, 12.0, 2.10, true),
  );
  for (const x of [-3.9, 4.1]) {                // lashings sunk INTO the bundle surface
    const wrap = new THREE.Group();
    const strap = new THREE.Mesh(new THREE.TorusGeometry(5.9, 0.9, 3, 10), mat(C.timberDark));
    strap.rotation.y = Math.PI / 2;
    wrap.add(strap);
    wrap.position.set(x, 3.6, 0.7);
    wrap.scale.set(1, 1.02, 1.16);
    stack.add(wrap);
  }
  return stack;
}

// ── assembly + anim plumbing ────────────────────────────────────────────────
function assertNoRoot(parts, root) {
  // Structural guard for the sibling-module bug: if the ROOT ever lands in `parts`, restore()
  // would overwrite the wrapper's world placement every frame and the model would teleport to
  // origin the instant it animates. Keep the snapshot to descendants only.
  for (const o of Object.values(parts)) if (o === root) throw new Error("worker-peg: root in parts");
}
function record(parts) {
  const rest = {};
  for (const [k, o] of Object.entries(parts)) if (o) rest[k] = { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() };
  return rest;
}
function restore(parts, rest) {
  for (const [k, o] of Object.entries(parts)) if (o && rest[k]) { o.position.copy(rest[k].p); o.rotation.copy(rest[k].r); o.scale.copy(rest[k].s); }
}
function assemble(coatHex, dress, hoodHex = coatHex, opt = {}) {
  const root = new THREE.Group();
  root.rotation.y = 0.30;                        // sheet pose (face toward the sheet camera);
                                                 // integration zeroes it — see models.js
  const body = buildBody(coatHex, hoodHex, opt);
  root.add(body);
  const parts = {
    body, head: body.getObjectByName("head"), hood: body.getObjectByName("hood"),
    brim: body.getObjectByName("brim"),
  };
  dress(body, parts);
  assertNoRoot(parts, root);
  root.userData.parts = parts;
  root.userData.rest = record(parts);
  root.userData.seed = (coatHex % 97) / 97 * Math.PI * 2;
  return root;
}
const sm = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const wobble = (x, f = 11, d = 5) => Math.exp(-d * x) * Math.cos(f * x);

function idle(g, p, t) {
  const { parts, rest, seed } = g.userData; restore(parts, rest);
  const b = parts.body;
  b.scale.y *= 1 + 0.015 * Math.sin(t * 2.1 + seed);
  b.rotation.z += 0.028 * Math.sin(t * 1.5 + seed);
  parts.head.rotation.z += 0.03 * Math.sin(t * 1.5 + seed + 0.8);
  parts.head.rotation.y += 0.05 * Math.sin(t * 0.7 + seed * 2);
}
function walk(g, p, t) {
  const { parts, rest, seed } = g.userData; restore(parts, rest);
  const ph = p * Math.PI * 2 + t * 9 + seed;
  const b = parts.body;
  const bounce = Math.abs(Math.sin(ph));
  b.position.y += bounce * 1.5;
  b.rotation.z += Math.sin(ph) * 0.085;
  b.rotation.x += 0.07;
  b.scale.y *= 1 - 0.05 * (1 - bounce);
  // the cowl is part of the head, so a small counter-rotation reads as fabric drag
  parts.head.rotation.z -= Math.sin(ph) * 0.05;
  parts.head.rotation.x -= 0.045;
  if (parts.stack) {
    parts.stack.rotation.x += Math.sin(ph - 0.9) * 0.05;
    parts.stack.rotation.z += Math.sin(ph * 0.5 - 0.6) * 0.04;
  }
  if (parts.spear) parts.spear.rotation.x += Math.sin(ph - 0.7) * 0.03;
}
// Shared so ANY job dressed with dressCarry() gets the weight comedy, not just worker-carrier.
function carryLag(g, p, t) {
  const { parts, rest } = g.userData; restore(parts, rest);
  const b = parts.body;
  const stack = parts.stack;
  const rise = sm(p / 0.15);
  const settle = p < 0.15 ? 0 : p - 0.15;
  const tilt = -0.42 * rise * (p < 0.15 ? 1 : Math.exp(-3.4 * settle) * Math.cos(9 * settle));
  if (stack) {
    stack.rotation.x += tilt;
    stack.position.z += tilt * 2.4;
    stack.position.y += Math.abs(tilt) * -0.9;
  }
  b.rotation.x += 0.12 * rise * (p < 0.15 ? 1 : Math.exp(-2.5 * settle));
  b.scale.y *= 1 - 0.03 * rise;                   // dip under the shifting load
  parts.head.rotation.x += -tilt * 0.30;          // the hood lags the load
}

export const MODELS = {};
const CAM = { dist: 118, height: 22, target: 14 };

// gatherer — olive cowl over tan, big bearded axe slung across the back
MODELS["worker-gatherer"] = {
  cam: CAM,
  build: () => assemble(C.coatOlive, (body, parts) => {
    chestStrap(body);
    seat(body, 4.6, 9.0, -5.4);
    const axe = buildAxe();
    axe.position.set(5.3, 10.6, -5.4);   // slung clear of the cape's flank: head above the
    axe.rotation.set(0.10, 0, -0.34);    // shoulder, butt visible below the strap, tip off the ground
    body.add(axe);
    parts.axe = axe;
    parts.axeHead = axe.getObjectByName("axeHead");
  }, C.hoodOlive, { brimWide: true }),
  anims: {
    idle, walk, carryLag,
    // v16 re-author. v15 was a uniform rigid tilt: the torso folded 0.64 rad and vanished behind
    // its own head, and the haft crossed the face at contact. Now the body ARCS (a smaller fold
    // plus a forward shift and a real squash), the hood LAGS the body through the swing and
    // overshoots after it, and the blade lands low and outboard — chest height, off the centre
    // line — so the face is never crossed.
    chop(g, p, t) {
      const { parts, rest } = g.userData; restore(parts, rest);
      const axe = parts.axe, b = parts.body, hd = parts.head;
      const hold = sm(p / 0.12);
      const SWING_Y = -Math.PI / 2;
      const strikeK = p < 0.4 ? 0 : sm(Math.min(1, (p - 0.4) / 0.12));
      parts.axeHead.rotation.y = rest.axeHead.r.y + (SWING_Y - rest.axeHead.r.y) * strikeK;
      parts.axeHead.rotation.z = rest.axeHead.r.z * (1 - hold);   // un-roll the display pose
      const HOLD = new THREE.Vector3(6.9, 12.4, 1.2);     // off the strap, at the side
      const WIND = new THREE.Vector3(6.6, 16.6, -3.6);    // raised high behind
      const HIT  = new THREE.Vector3(7.4,  8.4,  7.4);    // LOW and outboard: clear of the face
      axe.position.lerpVectors(rest.axe.p, HOLD, hold);
      const restZ = rest.axe.r.z, upZ = 0.25, windZ = 0.7, strikeZ = -2.50;
      axe.rotation.x = rest.axe.r.x * (1 - hold);
      // bodyTilt is tracked explicitly so the hood can be given a fraction of it, one frame
      // "behind" — that fraction IS the lag.
      let tilt = 0, lead = 0;
      if (p < 0.12) {
        axe.rotation.z = restZ + (upZ - restZ) * hold;
        b.rotation.y += 0.12 * hold;
      } else if (p < 0.4) {
        const k = sm((p - 0.12) / 0.28);
        axe.position.lerpVectors(HOLD, WIND, k);
        axe.rotation.z = upZ + (windZ - upZ) * k;
        b.rotation.y += 0.12 + 0.24 * k;          // torso coils away
        tilt = -0.18 * k;                         // tips BACK on the wind-up
        lead = -0.10 * k;
        hd.rotation.y += -0.15 * k;
      } else if (p < 0.52) {
        const k = sm((p - 0.4) / 0.12);
        axe.position.lerpVectors(WIND, HIT, k);
        axe.rotation.z = windZ + (strikeZ - windZ) * k;
        axe.rotation.y = -0.25 * k;
        axe.scale.setScalar(1 + 0.15 * Math.sin(k * Math.PI));
        b.rotation.y += 0.36 - 0.5 * k;
        tilt = -0.18 + 0.40 * k;                  // committed forward ARC, not a face-plant
        lead = -0.10 + 0.28 * k;                  // hood trails the torso, then whips past it
        b.position.z += 1.7 * k; b.position.y -= 1.3 * k;                  // the arc travels, so the fold is not a hinge
        b.scale.y *= 1 - 0.085 * k;               // impact squash lands WITH the blade
        b.scale.x *= 1 + 0.045 * k; b.scale.z *= 1 + 0.045 * k;
        hd.rotation.y += -(0.36 - 0.5 * k) * 0.85 + 0.18 * k;
      } else {
        const k = sm((p - 0.52) / 0.38);
        axe.position.lerpVectors(HIT, rest.axe.p, k);
        axe.rotation.z = strikeZ + (restZ - strikeZ) * k + wobble(p - 0.52) * 0.1;
        axe.rotation.y = -0.25 * (1 - k);
        b.rotation.y += -0.14 * (1 - k);
        tilt = 0.22 * (1 - k) + wobble(p - 0.52, 10, 6) * 0.05;
        lead = 0.18 * (1 - k) + wobble(p - 0.52, 8, 4) * 0.06;   // the cowl settles last
        b.position.z += 1.7 * (1 - k); b.position.y -= 1.3 * (1 - k);
        b.scale.y *= 1 - 0.085 * (1 - k);         // squash releases through the recovery
        b.scale.x *= 1 + 0.045 * (1 - k); b.scale.z *= 1 + 0.045 * (1 - k);
        hd.rotation.y += (0.14 * 0.85 + 0.18) * (1 - k);
      }
      b.rotation.x += tilt;
      hd.rotation.x += lead - tilt * 0.42;        // world-space head angle < body angle = LAG
    },
  },
};

// courier — denim blue cowl and coat, woven basket backpack
MODELS["worker-courier"] = {
  cam: CAM,
  build: () => assemble(C.jobHaul, (body, parts) => {
    chestStrap(body);
    const basket = buildBasket();
    basket.position.set(5.1, 12.4, -6.6);   // offset onto the RIGHT shoulder blade: dead-centre
    basket.rotation.set(0.08, 0.36, -0.05);  // behind, it swallowed the whole peg from yaw 180
    body.add(basket);
    parts.basket = basket;
  }),
  anims: { idle, walk, carryLag },
};

// Delivery Worker — marigold, dark leather cap, hammer hung off the belt as a clear T
MODELS["worker-builder"] = {
  cam: CAM,
  build: () => assemble(C.jobDelivery, (body, parts) => {
    belt(body);                                   // the sheet's builder wears ONE belt, no sash
    const hammer = buildHammer();
    // Hung OUTSIDE the coat off the belt line: head just above the strap, haft dangling down the
    // flank. v15 sank it into the belly at z = 6.4 and the handle exited the far side.
    hammer.position.set(4.7, 9.3, 5.6);
    hammer.rotation.set(0.05, 0.36, 0.20);
    body.add(hammer);
    parts.hammer = hammer;
  }, C.hoodTan, { brimWide: true }),
  anims: { idle, walk, carryLag },
};

// guard — chocolate cowl, warm shield with a light metal boss, tall spear seated at the hip
MODELS["worker-guard"] = {
  cam: CAM,
  build: () => assemble(C.jobGuard, (body, parts) => {
    const shield = buildShield();
    shield.position.set(6.75, 10.5, -3.40);  // on the flank, clear of the cape's skirt
    shield.rotation.set(0.05, 0.98, 0.06);
    body.add(shield);
    seat(body, 5.1, 9.4, -4.9, 0.3);         // the strap nub the butt rests against
    const spear = buildSpear();
    spear.position.set(5.2, 9.6, -4.9);      // pivot IS the butt: nothing continues below it
    spear.rotation.set(0.20, 0, -0.30);
    body.add(spear);
    parts.shield = shield; parts.spear = spear;
  }, C.hoodTan),
  anims: {
    idle, walk, carryLag,
    jab(g, p, t) {
      const { parts, rest } = g.userData; restore(parts, rest);
      const spear = parts.spear, b = parts.body;
      const draw = sm(p / 0.3);
      // level the spear by pitching it forward about its butt, then slide the butt to the hip
      spear.position.lerpVectors(rest.spear.p, new THREE.Vector3(7.2, 12.2, -6.0), draw);
      spear.rotation.x = rest.spear.r.x + (Math.PI / 2 - rest.spear.r.x) * draw;
      spear.rotation.z = rest.spear.r.z * (1 - draw);
      b.rotation.y += -0.14 * draw;                    // shoulders square up behind the point
      let push = 0;
      if (p >= 0.3 && p < 0.45) push = sm((p - 0.3) / 0.15) * 7;
      else if (p >= 0.45) push = 7 * (1 - sm((p - 0.45) / 0.3)) + wobble(p - 0.45, 10, 5) * 1.2;
      spear.position.z += push;
      b.position.z += -push * 0.22;
      b.rotation.x += push * 0.018;                    // body drives the thrust
      if (p >= 0.45) {
        const back = sm((p - 0.45) / 0.55);
        spear.position.lerp(rest.spear.p, back * 0.9);
        spear.rotation.x += (rest.spear.r.x - spear.rotation.x) * back;
        spear.rotation.z += (rest.spear.r.z - spear.rotation.z) * back;
      }
    },
    // v16 re-author: COVER, not a belly-plate. The shield swings up in front of the chest and
    // the LOWER face, tilted so its top rim leans away from the eyes; the body leans BACK behind
    // it and peers over the top. Rim top lands ~1.1 px under the eye line at full raise.
    shieldUp(g, p, t) {
      const { parts, rest } = g.userData; restore(parts, rest);
      const s = parts.shield, b = parts.body;
      const up = sm(p);
      s.position.lerpVectors(rest.shield.p, new THREE.Vector3(1.1, 12.2, 7.4), up);
      s.rotation.y = rest.shield.r.y * (1 - up) + 0.16 * up;
      s.rotation.x = rest.shield.r.x * (1 - up) - 0.34 * up;   // top rim tips AWAY from the face
      s.rotation.z = rest.shield.r.z * (1 - up) + 0.22 * up;
      b.scale.y *= 1 - 0.09 * up;                      // crouch-squash
      b.scale.x *= 1 + 0.05 * up;
      b.scale.z *= 1 + 0.05 * up;
      b.rotation.x += -0.17 * up;                      // lean BACK behind the cover
      b.rotation.z += 0.05 * up;
      b.position.z += -1.6 * up;
      parts.head.rotation.x += 0.09 * up;              // chin drops, eyes stay over the rim
    },
  },
};

// carrier dressing, exported: the game dresses ANY job's peg with the carried load (log bundle,
// tumpline, chest lashings, constant load compression) instead of rebuilding it as the tan
// carrier — a hauling courier stays denim-blue while loaded. Applied POST-assemble, so it
// patches both the live pose and the rest snapshot; the carrier model below rides the same path.
export function dressCarry(root) {
  const parts = root.userData.parts, rest = root.userData.rest;
  const body = parts.body, head = parts.head;
  const stack = buildLogStack();
  // v16: a SHOULDER-AND-BACK carry. v15 sat the bundle on the crown, which ate the hood and the
  // face — "a woodpile on a bag". Now it rides behind and above the shoulders: the load still
  // towers (the comedy survives) but the cowl, brim and face are fully readable from the front.
  stack.position.set(0, 17.5, -8.2);
  stack.rotation.set(-0.15, 0.06, 0.03);
  body.add(stack);
  // tumpline: the forehead band that makes the load LOOK carried rather than balanced. On the
  // head, so it rides the cowl through every anim.
  const band = new THREE.Mesh(new THREE.TorusGeometry(5.52, 0.60, 4, 14), mat(C.timberDark));
  band.name = "band";
  band.rotation.set(Math.PI / 2 - 0.42, 0, 0);
  band.position.set(0, 8.20, -0.30);          // ON THE CROWN, clear of the brow: at brim height
  band.scale.set(1, 1, 0.94);                 // it read as a scowling monobrow
  head.add(band);
  // two lashings from the bundle down around the chest — readable from front and rear
  for (const s of [-1, 1]) {
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(6.85, 0.58, 4, 14), mat(C.timberDark));
    wrap.rotation.set(Math.PI / 2 + 0.30, 0, s * 0.60);   // two shoulder straps, not one belt
    wrap.position.set(0, 10.1, -0.5);
    wrap.scale.set(1, 1, 1.04);
    body.add(wrap);
  }
  body.scale.y *= 0.965; body.rotation.x += 0.05;   // constant load compression + brace
  body.position.y += 0.36;                          // the brace tips the base flare's rim below
                                                    // y=0; lift it back onto the ground plane
  rest.body.s.copy(body.scale); rest.body.r.copy(body.rotation); rest.body.p.copy(body.position);
  parts.stack = stack;
  parts.band = band;
  rest.stack = { p: stack.position.clone(), r: stack.rotation.clone(), s: stack.scale.clone() };
  rest.band = { p: band.position.clone(), r: band.rotation.clone(), s: band.scale.clone() };
  return root;
}

// carrier — tan coat under a brown cowl, log bundle shouldered high on the back
MODELS["worker-carrier"] = {
  cam: { ...CAM, target: 17, dist: 126 },
  build: () => dressCarry(assemble(C.coat, () => {}, C.hoodTan, { brimWide: true })),
  anims: { idle, walk, carryLag },
};
