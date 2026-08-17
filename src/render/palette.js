// Owns: the render layer's colour vocabulary and hex->css conversion. Leaf module — imports nothing.
// ═══════════════════════════════════════════════════════════════════════════
// PALETTE
// Single source of truth for every colour in the 3D layer. Entries are hex
// numbers for three.js; css() converts for the 2D overlay and the baked
// ground texture. Grouped by role, not by object, so retinting a material
// family (all timber, all arcane glow) is one edit.
// ═══════════════════════════════════════════════════════════════════════════
export const PAL = {
  // ── world ──────────────────────────────────────────────
  sky:        0x1d1c29,
  water:      0x8fb3cf,
  cliff:      0x6a5a41,
  grass:      0x9db97f,
  grassAlt:   0x96b177,
  grassSpeck: 0x8dab70,
  grassTuft:  [0x33452d, 0x405536, 0x2b3d29, 0x4b6040],
  dirt:       0xd9c9a3,   // base clearing, paths
  grid:       0x63764c,   // placement lattice; drawn at very low opacity

  // ── flora ──────────────────────────────────────────────
  trunk:      0x6b4a2e,
  stump:      0x79512e,
  leaf:      [0x7fae5c, 0x6d9a4d, 0xd9a0bc],   // indexed by tree.variant

  // ── minerals ───────────────────────────────────────────
  rock:       0x9a9a94,
  rockDark:   0x6f6f6a,
  rubble:     0x8d8c88,
  gem:        0x71cbd8,
  gemBase:    0x4d6264,
  gemSpent:   0x557b80,

  // ── resources ──────────────────────────────────────────
  wood:       0xb98a4e,
  stone:      0xaaa9a5,
  dust:       0xa783df,
  coin:       0xe3b445,
  diamond:    0x79d9e8,

  // ── people ─────────────────────────────────────────────
  skin:       0xd7b586,
  coat:       0xd4b079,   // fallback worker coat
  jobHaul:    0x6f96ad,
  jobBuild:   0xd29a39,
  jobGuard:   0x9a7a54,
  hat:        0x6f4930,
  kingRobe:   0x9d3f34,
  kingCrown:  0xe8be55,
  blade:      0xded8c9,

  // ── enemies ────────────────────────────────────────────
  raider:     0x4a4152, raiderCap: 0x2b2532,
  archer:     0x76583e, archerCap: 0xa2814f,
  healer:     0x557649, healerCap: 0xe3dec5,
  brute:      0x674337, bruteCap:  0x3b2a21,

  // ── structures ─────────────────────────────────────────
  timber:     0x8a7358,
  timberDark: 0x5c4a38,
  chestTimber:0x9a6b3f,
  chestFrame: 0x493728,
  chestLatch: 0xc2b9a5,
  plaster:    0xc0a170,
  plasterLit: 0xc9b48a,
  roof:       0x8e5f3c,
  roofDark:   0x5f4527,
  masonry:    0x8d8495,
  masonryDark:0x6b6874,
  quarryWall: 0x777775,
  quarryRoof: 0x5f6061,
  doorway:    0x49392d,
  // Main-base precursor pit. Violet stays isolated here; the keep uses the shared stone/timber set.
  pitRim:     0xa783df,
  pitMid:     0x5d476f,
  pitDeep:    0x29232f,
  pitThroat:  0x151219,
  pole:       0x5d4935,
  banner:     0xa94634,
  metal:      0xbdb7ab,
  tar:        0x3a3128,
  arcane:     0xb18be5,
  arcaneGlow: 0x2e1f4a,
  fuse:       0xd8a343,
  charge:     0xa74434,
  chargeBody: 0x59473a,
  blueprint:  0x9a774d,
  scaffold:   0x83603a,
  pad:        0xa08a63,   // packed earth under a finished building's footprint

  // ── tower accents (by variant) ─────────────────────────
  towShock:   0x4c5d61,
  towLaser:   0x78e3df,
  towFire:    0xd9713f,
  towFreeze:  0x8fd9ee,
  towTeleport:0x7396e8,
  towBomb:    0x9a5c3a,
  towSniper:  0xd9e3c2,
  towBrick:   0x9b7f60,
  towOutpost: 0x7d6b52,
  towLightning:0x9db9e6,

  // ── feedback / rings ───────────────────────────────────
  flash:      0xd25b49,   // enemy hit tint
  hurtGlow:   0x5a1a12,   // tower damage emissive
  emberGlow:  0x60220c,   // burning status emissive
  ghostOk:    0x1d3312,
  ghostBad:   0x3d1410,
  cellOk:     0x8fc95e,   // footprint preview, placement allowed
  cellBad:    0xcf4f3e,   // footprint preview, placement blocked
  tool:       0x65442c,
  hpGood:     0x7fb356,   // remaining-health track, top row of a stack
  hint:       0xead18d,
  ok:         0xf5df98,   // affirmative highlight: hover rings, default impact flash
  cursor:     0xc8cbb8,   // idle cursor bracket: cool and quiet, so a real target still reads warmer
  bad:        0xb84b3c,
  taunt:      0xd6534f,
  storage:    0xd8c47c,
  pin:        0xd4453a,

  // ── lighting ───────────────────────────────────────────
  sunDay:     0xfff2d0,
  sunNight:   0x9fb4e8,
  skyLight:   0xd8e8ff,
  bounce:     0x6b6350,
};
/** Hex number -> css string, for the 2D overlay and canvas textures. */
export const css = n => "#" + n.toString(16).padStart(6,"0");

export const DROP_COLOR = {wood:PAL.wood, stone:PAL.stone, dust:PAL.dust,
                    coin:PAL.coin, diamond:PAL.diamond};
export const JOB_COAT = {haul:PAL.jobHaul, build:PAL.jobBuild, guard:PAL.jobGuard};
/** Tower roof accent per variant; anything unlisted falls back to timberDark. */
export const TOWER_TOP = {
  pulse:PAL.arcane,     shock:PAL.towShock,   laser:PAL.towLaser,
  fire:PAL.towFire,     freeze:PAL.towFreeze, tar:PAL.tar,
  teleport:PAL.towTeleport, bomb:PAL.towBomb, sniper:PAL.towSniper,
  watch:PAL.coin,       brick:PAL.towBrick,   aggro:PAL.taunt,
  turret:PAL.timber,    outpost:PAL.towOutpost, lightning:PAL.towLightning,
};
