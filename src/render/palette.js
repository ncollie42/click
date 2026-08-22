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
// COLOUR THEORY (owner, Aug 21 — the rules a palette pick and every role mapping obey):
//  · VALUE carries readability, hue carries meaning (Garbaj, youtube 9Em4i1tlAb4; TF2/Mario).
//    Grayscale a frame: every actor (unit, enemy, building, pickup) must be clearly lighter or
//    darker than the ground under it. Same-value-different-hue is the Overwatch failure.
//  · Ground is the biggest surface, so it is MUTED and MID-VALUE: a RANGE of greens (4-5 step
//    ramp — we are most sensitive to green, adjacent greens read as bands) with room above
//    (highlight/patch) and below (shade/shadow). It never owns the most saturated hue.
//  · Bold saturation is spent on ACTION: enemies, damage, pins, pickups. RED IS RESERVED for
//    threat/damage — nothing ambient (roofs, banners, king) wears it.
//  · Complementary split: meadow green + arcane purple is the world; enemies sit in red/orange
//    against both; allied accents in blue/cream.
//  · Selout outlines darken the pixel's own colour, so they do not rescue value collisions —
//    the value rule has to hold without them.
//
// HOW A COLOUR REACHES THE SCREEN (pixel.js quantizeMode 1), per pixel:
//   authored swatch (PAL)  →  × sun/hemi/cloud/toon-ramp  →  lit colour (off-palette)
//        →  convert to OKLab  →  find nearest swatch  →  if near a border, dither between 2 swatches
// OKLab is only the ruler for "nearest"; nothing is stored in it. `pixelTune.spread` is the
// dither zone width (0 = hard bands). Lighting knocks every authored colour off-palette, so the
// swatch you SEE on a lit face is whichever is nearest to authored × rig — scripts/palette-snap.mjs
// predicts that landing per role; author one step off when the prediction lands wrong.
//
// Ground albedos are LINEAR-solved against the Red Giraffe reference under the shared sun/hemi
// rig below (tools/test-scene/ROUND-LOG.md), written as the sRGB hex a painter would author.
// They are applied ONCE (vertex tint over a white texture) — never tint-times-texture.
// ═══════════════════════════════════════════════════════════════════════════
// ── THE 32 SWATCHES ────────────────────────────────────────────────────────────────────────
// OUR OWN palette, v2 (owner, Aug 21), replacing the Lospec Downgraded-32 trial ("too beautiful",
// navy grass shadows, 3 greens). Authored PARAMETRICALLY in OKLab by scripts/palette-ramp.mjs —
// edit L/C/hue there and paste the hexes here; never hand-edit a hex. Ramps follow the hue-shift
// rule (lighter → yellow & desaturated, darker → blue & saturated) and bridge into the shared
// shade/moss/teal darks. Measured off t3ssel8r-style references: grass hue 112→162 top→bottom,
// C ≤ .105, lit meadow L .72; stone neutral with lavender shadow; warm cream tops. The red ramp
// is the ONLY high-chroma family (fire + enemy + damage) — see COLOUR THEORY above.
// Night / fire moods are a second tier swapped at runtime (pixelTune.palette), not more swatches.
// Every PAL role below is ONE of these (validate.mjs asserts it). Enforcement is at AUTHORING:
// the shipped quantizer is OKLab bands (pixel.js quantizeMode 0), which keeps hue and lets light
// modulate the swatch. Palette match (mode 1, QUANT_PALETTES[32] = this list) lost the Aug 22 A/B —
// blade-edge ink and dither turned every shadow into brown speckle — and remains an A/B only.
export const SWATCH = {
  // greens: the ground ramp. green1 = LIT meadow (mid-value, muted); green4 = grass shadow
  green0: 0xc6d47a, green1: 0x97b064, green2: 0x719651, green3: 0x4a7d4e, green4: 0x286248,
  // stone: sunlit cream top → neutral → cool lavender shadow
  stone0: 0xd8cbc1, stone1: 0x9ca49e, stone2: 0x77818c, stone3: 0x5b5c6e,
  // shared highlight / sand bridge
  cream0: 0xf0e4bf, cream1: 0xc2b797,
  // wood
  wood0: 0xa57d5a, wood1: 0x86563c, wood2: 0x5e3729,
  // shadow bridge: lavender → navy → night-black
  shade0: 0x474361, shade1: 0x2b294b, shade2: 0x12132c,
  // warm reserve: gold → orange → fire-red → crimson. Enemies, damage, fire, pins. Nothing ambient.
  red0: 0xf0c630, red1: 0xe87f25, red2: 0xd4312a, red3: 0x8c1737,
  // arcane: portal, dust, fog accents
  arcane0: 0xba91d8, arcane1: 0x8559b2, arcane2: 0x4d2f77,
  // water / sky / ice (blue0 doubles as diamond + freeze)
  blue0: 0x99dfe3, blue1: 0x54aad1, blue2: 0x236daa,
  // singles
  // metal0: light cool highlight — quantize target only; lit faces can't reach it (palette-snap)
  skin0: 0xdeac83, metal0: 0xb7cfd9, teal0: 0x153d38, moss0: 0x1b3427, grey0: 0x72665e,
};
const S = SWATCH;

export const PAL = {
  // ── world ──────────────────────────────────────────────
  sky:        S.shade2,
  water:      S.blue1,
  cliff:      S.stone3,
  grass:      S.green1,   // LIT meadow — mid-value on purpose; actors read above/below it
  grassAlt:   S.green0,   // bright patch tone, blended in sparse noise (scene.js groundColorInto)
  soil:       S.wood1,    // meadow dirt (test-scene TERRAIN.dirt)
  grassTuft:  [S.green3, S.green2, S.green4, S.green2],   // legacy tuft instancer + editor preview
  // Per-WFC-variant meadow tints (scene.js tintFor lerps grass toward these).
  regionForest: S.green2,
  regionRocky:  S.stone1,
  regionOpen:   S.green0,
  dirt:       S.cream1,   // base clearing, paths
  grid:       S.green3,   // placement lattice; drawn at very low opacity
  // Depth-foam water shader (scene.js waterUniforms) + its floor/far planes.
  waterShallow: S.blue1,
  waterDeep:    S.blue2,
  waterFoam:    S.cream0,
  waterFloor:   S.cream1,
  waterFar:     S.teal0,
  // Fog-of-war block shades (scene.js fog section): the shade bridge.
  fogLand:    [S.shade0, S.stone3, S.shade1],
  fogWater:   [S.shade1, S.shade0, S.shade1],

  // ── flora ──────────────────────────────────────────────
  trunk:      S.wood1,
  stump:      S.wood1,
  // Indexed by tree.variant. No green1: that is the ground, and a canopy must read above or below
  // it in value. Blossom NUKED Aug 21 (its side/shade bands spent the red reserve on a tree).
  leaf:      [S.green2, S.green3, S.green0],

  // ── minerals ───────────────────────────────────────────
  rock:       S.stone1,
  rockDark:   S.stone2,
  rubble:     S.grey0,
  gem:        S.blue0,
  gemBase:    S.stone2,
  gemSpent:   S.stone3,

  // ── resources ──────────────────────────────────────────
  wood:       S.wood0,
  stone:      S.stone1,
  dust:       S.arcane0,
  coin:       S.red0,
  diamond:    S.blue0,

  // ── people (allies: blue/cream accents, never red) ─────
  skin:       S.skin0,
  coat:       S.cream1,   // fallback worker coat
  jobHaul:    S.blue2,
  jobBuild:   S.red0,     // gold, the builder's hi-vis
  jobGuard:   S.stone3,
  hat:        S.wood2,
  kingRobe:   S.arcane1,  // royal = arcane purple; red is the enemy's
  kingCrown:  S.red0,
  blade:      S.stone0,   // metal0 never self-lands under the warm sun (palette-snap); stone0 does

  // ── enemies (red ramp = threat) ────────────────────────
  raider:     S.red3,    raiderCap: S.shade1,
  archer:     S.red2,    archerCap: S.wood2,
  healer:     S.arcane1, healerCap: S.cream0,
  brute:      S.red3,    bruteCap:  S.shade2,

  // ── structures ─────────────────────────────────────────
  timber:     S.wood0,
  timberDark: S.wood2,
  chestTimber:S.wood0,
  chestFrame: S.wood2,
  chestLatch: S.stone0,
  plaster:    S.cream1,
  plasterLit: S.cream0,
  roof:       S.wood1,
  roofDark:   S.wood2,
  masonry:    S.stone1,
  masonryDark:S.stone2,
  quarryWall: S.stone2,
  quarryRoof: S.stone3,
  doorway:    S.wood2,
  // Main-base precursor pit. Violet stays isolated here; the keep uses the shared stone/timber set.
  pitRim:     S.arcane0,
  pitMid:     S.arcane2,
  pitDeep:    S.shade1,
  pitThroat:  S.shade2,
  pole:       S.wood2,
  banner:     S.arcane1,
  metal:      S.stone0,
  tar:        S.shade2,
  arcane:     S.arcane0,
  arcaneGlow: S.arcane2,
  fuse:       S.red0,
  charge:     S.red1,
  chargeBody: S.wood2,
  blueprint:  S.blue1,
  scaffold:   S.wood0,
  pad:        S.cream1,   // packed earth under a finished building's footprint
  sage:       S.blue1,    // allied-unit accent: capture yard markers, converted-enemy read

  // ── tower accents (by variant) ─────────────────────────
  towShock:   S.stone3,
  towLaser:   S.blue0,
  towFire:    S.red1,
  towFreeze:  S.blue0,
  towTeleport:S.blue2,
  towBomb:    S.grey0,
  towSniper:  S.cream0,
  towBrick:   S.wood1,
  towOutpost: S.wood0,
  towLightning:S.blue1,

  // ── feedback / rings ───────────────────────────────────
  flash:      S.red1,     // enemy hit tint
  hurtGlow:   S.red3,     // tower damage emissive
  emberGlow:  S.red3,     // burning status emissive
  ghostOk:    S.green4,
  ghostBad:   S.red3,
  cellOk:     S.green0,   // footprint preview, placement allowed
  cellBad:    S.red2,     // footprint preview, placement blocked
  tool:       S.wood2,
  hpGood:     S.green0,   // remaining-health track, top row of a stack
  hint:       S.cream0,
  ok:         S.red0,     // affirmative highlight: hover rings, default impact flash (gold)
  cursor:     S.stone0,   // idle cursor bracket: cool and quiet, so a real target still reads warmer
  bad:        S.red2,
  taunt:      S.red1,
  storage:    S.cream1,
  pin:        S.red2,

  // ── lighting (NOT albedos — multiply everything; exempt from the swatch check) ──
  sunDay:     0xfff2d0,
  sunNight:   0x9fb4e8,
  // Hemi pair. Aug 22: flipped COOL/LAVENDER from the Red-Giraffe warm solve (0xffde82/0x6b5a4a).
  // Under the warm pair, grass and stone in shadow quantized to wood2 — red-brown speckle over the
  // meadow (palette-snap shade landings). The t3ssel8r references shade lavender; this pair
  // sends shadows to teal0/moss0/shade1. Consumers: scene.js hemi, game-rig.js bake, test-scene
  // HEMI — all read these two, so the rigs cannot drift. Old pair kept above for A/B.
  skyLight:   0xc8c0ff,
  bounce:     0x5a4e6e,
};
/** Tone targets for materials that opt into material-light-mods setToneTargets(): the swatch a
 *  flat SUN-LIT face shows and the swatch a fully SHADED face shows (t3ssel8r's authored
 *  highlight/shadow per material). The mid/penumbra blends between them. Only the meadow today. */
export const TONES = {
  meadow:  {albedo: S.green1, lit: S.green1, shadow: S.green4},   // green4: cloud/canopy shade = dark teal mass (green3 too mild)
  // Live-rig models (kit.toned): canopies, trunks, boulders. Shadow swatches are the ramp's
  // bridge darks so a shaded tree/rock never goes grey-brown under the cool hemi.
  canopy:  {albedo: S.green2, lit: S.green2, shadow: S.moss0},
  canopyDk:{albedo: S.green3, lit: S.green3, shadow: S.moss0},
  canopyLt:{albedo: S.green0, lit: S.green0, shadow: S.green4},
  wood:    {albedo: S.wood1,  lit: S.wood1,  shadow: S.wood2},
  stone:   {albedo: S.stone1, lit: S.stone1, shadow: S.stone3},
  stoneDk: {albedo: S.stone2, lit: S.stone2, shadow: S.shade1},
};
/** Roles that are light colours, not surface albedos — the only PAL entries allowed off-palette. */
export const LIGHT_ROLES = new Set(["sunDay", "sunNight", "skyLight", "bounce"]);
// ── pixel-pipeline quantize tier (pixel.js quantizeMode 1 "palette match") ─────────────────
// ONE tier: the 32 swatches above. The old hand-eyeballed 8/16 tiers were deleted Aug 21 with
// the palette unification; a smaller palette is a new SWATCH table, not a second tier.
// WHY OKLab distance, and what it means for authoring a tier (Red Giraffe, Pixel Perfect ep1,
// youtube Mp7eQsiZ_wA): "we are much more sensitive to green than we are to blue … raw RGB is
// not perceptually uniform", so nearest-swatch is measured in a perceptual space. Corollary for
// a meadow game: two greens that look "close" in a swatch strip still read as distinct bands on
// the ground — budget a RAMP of 4-5 greens; blues/purples get by with 2-3. Tiers are swappable
// at runtime (pixelTune.palette) — the look is data, not baked into assets.
export const QUANT_PALETTES = {
  32: Object.values(SWATCH),
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
