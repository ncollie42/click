// Owns: THE colour vocabulary for every host — game scene, test scene, map-editor preview,
// pixel-pipeline quantize tiers. Leaf module — imports nothing.
// ═══════════════════════════════════════════════════════════════════════════
// PALETTE
// Single source of truth for every colour in the 3D layer. Entries are hex
// numbers for three.js; css() converts for the 2D overlay and the baked
// ground texture. Grouped by role, not by object, so retinting a material
// family (all timber, all arcane glow) is one edit.
//
// LAW (owner, Aug 21): no host authors its own hexes for a shared role. Test scene
// (tools/test-scene/preset.js) and game (src/render/scene.js) read the SAME ground/light
// entries, so a look solved in one is the look of the other. Model files still carry
// per-model ink (see models/reviewed/*) — migrating those is a separate pass.
//
// Ground albedos are LINEAR-solved against the Red Giraffe reference under the shared sun/hemi
// rig below (tools/test-scene/ROUND-LOG.md), written as the sRGB hex a painter would author.
// They are applied ONCE (vertex tint over a white texture) — never tint-times-texture.
// ═══════════════════════════════════════════════════════════════════════════
export const PAL = {
  // ── world ──────────────────────────────────────────────
  sky:        0x1d1c29,
  water:      0x8fb3cf,
  cliff:      0x6a5a41,
  grass:      0x55c058,   // renders (96,186,54) lit / (31,67,22) cloud-shaded
  grassAlt:   0x85d06e,   // BRIGHTER second meadow tone, renders (138,195,68) — the reference's
                          // p95 grass; blended in sparse noise patches (scene.js groundColorInto)
  soil:       0x837b47,   // meadow dirt, renders ~(120,111,47) lit; cloud-shaded clears 40 L
  grassTuft:  [0x33452d, 0x405536, 0x2b3d29, 0x4b6040],   // legacy tuft instancer + editor preview
  // Per-WFC-variant meadow tints (scene.js tintFor lerps grass toward these).
  regionForest: 0x6f965c,
  regionRocky:  0xa8a387,
  regionOpen:   0xb3c98c,
  dirt:       0xd9c9a3,   // base clearing, paths
  grid:       0x63764c,   // placement lattice; drawn at very low opacity
  // Depth-foam water shader (scene.js waterUniforms) + its floor/far planes.
  waterShallow: 0x6fb0dd,
  waterDeep:    0x22558f,
  waterFoam:    0xecf6f8,
  waterFloor:   0x8f855e,
  waterFar:     0x24568c,
  // Fog-of-war block shades: authored for the OLD rig then divided by 2.45 linear so the fog
  // displays byte-near-identical under the Aug 21 rig (scene.js fog section has the numbers).
  fogLand:    [0x34303c, 0x3a3543, 0x2d2935],
  fogWater:   [0x2e2d3c, 0x333243, 0x282835],

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
  sage:       0x7ba46a,   // allied-unit accent: capture yard markers, converted-enemy read

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
  // Hemi pair ported from the test-scene solve (tools/test-scene/preset.js HEMI, Aug 21):
  // warm sky, not blue — the pixel pipeline's quantizer re-cools it; a blue hemi double-cools.
  // Consumers: scene.js hemisphere light + models.js game-rig mirror. Change both rigs together.
  skyLight:   0xffde82,
  bounce:     0x6b5a4a,
};
// ── pixel-pipeline quantize tiers (pixel.js quantizeMode 1 "palette match") ────────────────
// NOTE: the shipped quantizer is mode 0 (37 OKLab lightness bands, hue untouched) — these tiers
// only bite when quantizeMode is switched to 1 in the R panel. Built from the hue families above
// (night-navy, grass greens, sun-creams, stone greys, wood browns, water blues, portal purple).
export const QUANT_PALETTES = {
  8: [0x1b2033, 0x2e4a3b, 0x49683f, 0x6f8f4e, 0x9db365, 0xc7cd8d, 0xe8e3b6, 0xfaf3d8],
  16: [
    0x1b2033, 0x2e4a3b, 0x49683f, 0x6f8f4e, 0x9db365, 0xc7cd8d, 0xe8e3b6, 0xfaf3d8,
    0x3a3f4d, 0x6b7280, 0x9aa3ad,             // stone
    0x5a3d2e, 0x8a6242,                       // wood
    0x31456b, 0x4b6a8f,                       // water
    0x6e4a7e,                                 // portal/tree purple
  ],
  32: [
    0x11141f, 0x1b2033, 0x272e47, 0x31456b, 0x4b6a8f, 0x7290ab,             // night + water blues
    0x24352b, 0x2e4a3b, 0x3d5c3a, 0x49683f, 0x5b7c46, 0x6f8f4e, 0x86a55a,   // greens (dark→light)
    0x9db365, 0xc7cd8d,
    0xdbd8a2, 0xe8e3b6, 0xf1ecc9, 0xfaf3d8,                                 // sand → cream
    0x2c3038, 0x4a4f5a, 0x6b7280, 0x8d95a0, 0xaeb6bf,                       // stone greys
    0x402c20, 0x5a3d2e, 0x7a5438, 0x8a6242, 0xa87e54,                       // wood browns
    0x4a3457, 0x6e4a7e, 0x9a6fae,                                           // purples
  ],
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
