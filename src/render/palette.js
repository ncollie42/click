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
//    threat/damage — nothing ambient (roofs, banners, structures) wears it.
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
  soil:       S.wood0,    // bare earth under buildings/base (wear-field paint). wood1 read too hard
                          // against green1 (owner, Aug 22) — wood0 is a step lighter, still earth
  // Per-WFC-variant meadow tints (scene.js tintFor lerps grass toward these).
  regionForest: S.green2,
  regionRocky:  S.stone1,
  regionOpen:   S.green0,
  dirt:       S.cream1,   // base clearing, paths
  grid:       S.green3,   // placement lattice; drawn at very low opacity
  // Depth-foam water shader (scene.js waterUniforms) + its floor/far planes.
  waterShallow: S.blue1,
  waterDeep:    S.blue2,
  // blue0, not cream0 (Aug 22): a near-white shore rim was the one thing in frame above the eye
  // channel's ceiling (house law: white belongs to eyes and glints — docs/water.md), and the blue
  // ramp's own top step is what makes the shore read as WATER rather than as a highlight.
  waterFoam:    S.blue0,
  waterFloor:   S.cream1,
  waterFar:     S.teal0,
  // Night tier for the same shader (scene.js WATER_NIGHT): one step down the same blue ramp, so
  // water swaps palette at night like every toned family instead of just going dark.
  waterShallowNight: S.blue2,
  waterDeepNight:    S.teal0,
  waterFoamNight:    S.blue1,
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
  // VALUE GATE (Aug 22, asserted by scripts/validate.mjs): every ACTOR role below — anything that
  // stands on the meadow — is at least .08 OKLab-L clear of BOTH green1 (lit clearing) and green2
  // (forest tint). That is the COLOUR THEORY rule above turned into a test, and it is what moved
  // skin off skin0 (L .78, six points from the lit clearing) and the fallback coat off cream1.
  skin:       S.stone0,   // was skin0: L .78 sat inside the meadow's value band
  coat:       S.wood1,    // fallback worker coat — dark brown reads BELOW the clearing
  jobHaul:    S.blue2,
  jobBuild:   S.red0,     // gold, the builder's hi-vis
  jobGuard:   S.stone3,
  hat:        S.wood2,
  blade:      S.stone0,   // metal0 never self-lands under the warm sun (palette-snap); stone0 does

  // ── enemies (DARK bodies; red is the THREAT they emit) ─
  // WIRED Aug 22. These roles were dead for a day; models/reviewed/enemy-shard.js is now their ONLY
  // reader (its INK table) and models/units/enemy.js reads enemyShade, so retinting the cast is an
  // edit HERE.
  //
  // OWNER CALL (Aug 22, after a crimson-body build was rejected): "enemies are red" does NOT mean
  // red-BODIED. RED IS RESERVED for threat/damage, and a body is not damage — what a creature DOES
  // is. So the mass stays DARK (shade1, the navy end of the shadow bridge, L .30, well clear of the
  // ground's value band) and the reserve is spent on the ACTIVE registers: the seams that crack open
  // across the rock, the ability FX it throws, and the hit flashes it puts on the player's things
  // (see the feedback section below). A crimson body ate the whole reserve and left the seams
  // nothing to glow against; a dark body is what gives red something to be bright ON.
  //
  // THESE ARE HUE VECTORS, NOT ALBEDOS. enemy-shard normalises each to luminance 1 (tintOf) and
  // takes VALUE from its own PLANE ramp, so a cap swatch's own L never reaches the screen — which
  // is why the caps are deliberately NOT in validate's ACTOR_ROLES gate (archerCap red1 sits inside
  // the ground's value band and still renders as a dark orange fin). The bodies ARE gated.
  //
  // One warm note per creature at most, and only on a cap: red belongs to the seams.
  raider:     S.shade1,  raiderCap: S.shade2,   // dorsal spine ridge + shoulder barbs
  archer:     S.shade1,  archerCap: S.red1,     // the swept quill fin: its one warm note
  healer:     S.shade1,  healerCap: S.cream0,   // bone crown — the healer is the pale one
  brute:      S.shade1,  bruteCap:  S.shade2,   // black overhanging brow
  bomber:     S.shade1,  bomberCap: S.red0,     // the fuse stub, same gold as PAL.fuse
  // Hue of a sun-facing enemy facet (PLANE.top / PLANE.upper). Neutral-cool rather than a second
  // violet: the body must read as unlit ROCK so the seams are the only saturated thing on it.
  enemyLit:   S.stone3,
  // Seam registers, authored as DISPLAY targets in enemy-shard (dispRGB inverts the tone curve, so
  // a seam renders as this swatch on the nose). enemySeam is the hot core, enemySeamDeep the walls
  // and the cool half of the flat two-step. These replace the arcane violet the cast wore Aug 21.
  enemySeam:     S.red2,
  enemySeamDeep: S.red3,
  // What the creature THROWS — bolts, motes, charge flash, the bomber's ember. It has to beat the
  // seam on value AND leave the body, so it sits one step further up the ramp (red1, luma ~143 vs
  // red2's ~83), with red2 as its banked/dim state.
  enemyAbility:    S.red1,
  enemyAbilityDim: S.red2,
  // shadeToFamily() target for the baked cast (models/units/enemy.js). It was TONES.stoneDk.shadow
  // (shade1) while the cast was charcoal stone; with the BODY now on shade1 the shade has to go one
  // step further down the same bridge or the shaded side stops separating from the lit side.
  enemyShade: S.shade2,

  // ── structures ─────────────────────────────────────────
  timber:     S.wood1,    // wood0 (L .62) is the lit meadow's value — a building must clear it
  timberDark: S.wood2,
  chestTimber:S.wood1,
  chestFrame: S.wood2,
  chestLatch: S.stone0,
  plaster:    S.cream1,
  plasterLit: S.cream0,
  roof:       S.wood1,
  roofDark:   S.wood2,
  masonry:    S.stone0,   // stone1 is green1's value to within .01
  masonryDark:S.stone2,
  quarryWall: S.stone2,
  quarryRoof: S.stone3,
  doorway:    S.wood2,
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
  // THE TWO DIRECTIONS OF DAMAGE, and they are different facts the player reads differently.
  // Both are red — all damage is — but they are separate roles so a retune of one cannot move the
  // other, and so grep answers "what turns red when the player is losing?" in one hop.
  flash:      S.red1,     // PLAYER-DEALT: an enemy body flashing as it takes a hit (scene.js syncEnemies)
  // ENEMY-DEALT: the emissive every player-side thing lights when its hp drops — main base
  // (syncBase), towers and buildings (syncBuildings), chests, and the worker hit flash. red3 was too
  // dark to read as an event on an already-dark body; red2 is the fire-red step and carries.
  hurtGlow:   S.red2,
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
/** NIGHT TIER (Aug 22). t3ssel8r's night is a PALETTE SWAP, not a darken: each toned family keeps
 *  its own authored lit/shadow pair at night, one that happens to live further down the same ramp
 *  and further into the shade/moss/teal bridge. No new swatches — every entry is one of the 32.
 *  Consumed by TONES below (each day triple carries its `night` pair) and lerped continuously by
 *  material-light-mods' uLmNight, which scene.js drives from the same 0..1 the sun dim uses.
 *  Chosen so the night world compresses into ONE value band the ground still tops:
 *  ground green3 (L .54) > canopy/rock (L .30-.48) > everything untoned, which the dimmed sun
 *  drops to L .2-.46 on its own (rig.js NIGHT_SUN_SCALE). */
export const TONES_NIGHT = {
  meadow:  {lit: S.green3, shadow: S.teal0},     // moonlit clearing; its shade leaves the greens entirely
  canopy:  {lit: S.moss0,  shadow: S.shade2},
  canopyDk:{lit: S.teal0,  shadow: S.shade2},    // teal0 vs moss0 keeps the two canopy variants apart at night
  canopyLt:{lit: S.green4, shadow: S.moss0},
  wood:    {lit: S.wood2,  shadow: S.shade2},
  stone:   {lit: S.stone3, shadow: S.shade1},    // the lavender end of the stone ramp is the night rock
  stoneDk: {lit: S.shade0, shadow: S.shade2},
};
/** Tone targets for materials that opt into material-light-mods setToneTargets(): the swatch a
 *  flat SUN-LIT face shows and the swatch a fully SHADED face shows (t3ssel8r's authored
 *  highlight/shadow per material). The mid/penumbra blends between them. Only the meadow today. */
export const TONES = {
  meadow:  {albedo: S.green1, lit: S.green1, shadow: S.green4, night: TONES_NIGHT.meadow},   // green4: cloud/canopy shade = dark teal mass (green3 too mild)
  // Live-rig models (kit.toned): canopies, trunks, boulders. Shadow swatches are the ramp's
  // bridge darks so a shaded tree/rock never goes grey-brown under the cool hemi.
  canopy:  {albedo: S.green2, lit: S.green2, shadow: S.moss0,  night: TONES_NIGHT.canopy},
  canopyDk:{albedo: S.green3, lit: S.green3, shadow: S.moss0,  night: TONES_NIGHT.canopyDk},
  canopyLt:{albedo: S.green0, lit: S.green0, shadow: S.green4, night: TONES_NIGHT.canopyLt},
  wood:    {albedo: S.wood1,  lit: S.wood1,  shadow: S.wood2,  night: TONES_NIGHT.wood},
  // stone lit stone1 → stone0 (Aug 22): the reference's rocks are a THREE-band read — warm cream
  // TOP, neutral SIDE, lavender SHADE — and one triple gets all three for free, because the toon
  // ramp already separates the faces. Solved with scripts/palette-snap.mjs's litColor math over
  // the rock hull's actual face normals (rock.js): crest (band .866/1) = stone0 exactly, the
  // sun-side walls (band .55) land stone1, the cross walls stone2, the dark walls shade0, and a
  // cast-shadowed face is stone3 exactly. lit=stone1 gave tops and sides the SAME swatch.
  stone:   {albedo: S.stone1, lit: S.stone0, shadow: S.stone3, night: TONES_NIGHT.stone},
  stoneDk: {albedo: S.stone2, lit: S.stone2, shadow: S.shade1, night: TONES_NIGHT.stoneDk},
};
/** Enemy VARIANT tier (game/data.js ENEMY_VARIANT_BANDS `tier`) -> the SEAM's two steps,
 *  [hot core, cool walls]. Tier 1 has no entry: it is the pair enemy-shard already authors
 *  (enemySeam over enemySeamDeep). Applied by enemy-shard's tintSeams() from models/units/enemy.js.
 *
 *  A LADDER UP THE RED RAMP, and both steps are NAMED rather than computed. The obvious
 *  implementation - one swatch per tier, walls at some fraction of it - was built and measured
 *  wrong: red1 x 0.66 is (153,84,24), which snaps to wood1. A DIMMED ORANGE IS BROWN. That is not a
 *  bug to tune around, it is what the colour is, so every step a seam can take is written down here
 *  as a swatch instead:
 *      tier 1  red2 / red3     the authored crack
 *      tier 2  red1 / red2     veteran: the whole seam one step hotter
 *      tier 3  red0 / red1     elite: gold-hot core, orange walls
 *  Monotone in heat, four of the ramp's four steps used, nothing off-palette in between. red0 is
 *  also the coin and the builder's hi-vis, which is a real collision - it is spent here on a
 *  hairline crack rather than a mass, and only on the rarest enemy in the game.
 *
 *  THE BODY IS NEVER TINTED. It was, for one build on Aug 22, and that is the mistake this file's
 *  enemy section argues against: tier is an INTENSITY, and intensity belongs on the register that
 *  already means "this thing hurts you", not on the silhouette's albedo.
 *
 *  Until Aug 22 these lived in game/data.js as raw "#3568a8" / "#a23e50" - a BLUE veteran spent the
 *  ALLIES' accent colour on an enemy (COLOUR THEORY above), and neither hex was a swatch, which the
 *  model census never caught because it only scans src/render/models. Colour is render vocabulary,
 *  so it lives here and data.js carries only the tier; validate.mjs asserts both halves of that
 *  split. */
export const ENEMY_VARIANT_TINT = {2: [S.red1, S.red2], 3: [S.red0, S.red1]};
/** Roles that are light colours, not surface albedos — the only PAL entries allowed off-palette. */
export const LIGHT_ROLES = new Set(["sunDay", "sunNight", "skyLight", "bounce"]);
// ── pixel-pipeline quantize tier (pixel.js quantizeMode 1 "palette match") ─────────────────
// ONE tier: the 32 swatches above. The old hand-eyeballed 8/16 tiers were deleted Aug 21 with
// the palette unification; a smaller palette is a new SWATCH table, not a second tier.
// WHY OKLab distance, and what it means for authoring a tier (Red Giraffe, Pixel Perfect ep1,
// youtube Mp7eQsiZ_wA): "we are much more sensitive to green than we are to blue … raw RGB is
// not perceptually uniform", so nearest-swatch is measured in a perceptual space. Corollary for
// a meadow game: two greens that look "close" in a swatch strip still read as distinct bands on
// the ground — budget a RAMP of 4-5 greens; blues/purples get by with 2-3. The tier is swappable
// at runtime (pixelTune.palette = [hexes], how night/fire moods re-tone) — the look is data, not
// baked into assets. Mode 1 itself is an A/B only; mode 0 (bands) is what ships.
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
