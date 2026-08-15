// Progression spec — the AUTHORED half of docs/progression.html.
//
// This file holds design INTENT only: the target arc, phase boundaries, the
// structural beat schedule, the level curve, the draft policy, and the
// player-model assumptions the charts integrate. Real game numbers (costs,
// worker stats, cycle lengths) are NEVER copied here — progression.html
// imports them live from src/game/data.js + simulation.js, and card effects
// live in src/game/cards.js. Edit the game, refresh, the charts move.
//
// Direction (decided 2026-08-14): Vampire-Survivors-style leveling. XP from
// feeding the thing fills an exponential level curve; every level-up deals a
// pick-3 draft from src/game/cards.js. The draft IS the dopamine drip, so the
// beat schedule below only carries STRUCTURAL moments — the drip is emergent
// and charted by the model instead of authored minute-by-minute.
//
// Refs: every beat `ref` is checked by scripts/validate.mjs against the real
// tables. `concept:` refs are free-form — mechanics not in code yet.
// Everything below is a strawman to react to, not a commitment.

// ── the arc ──────────────────────────────────────────────────────────────────
export const ARC = {
  targetMinutes: 45,         // one continuous run, start → "end" (was 110; refocused 2026-08-14)
  beatRuleMinutes: 9,        // max quiet gap between STRUCTURAL beats before the timeline flags it
  nightIncomeFactor: 0.35,   // fraction of day gather rate sustained through a night
};

// ── level curve — XP to go from level n to n+1 ───────────────────────────────
// cost(n) = base × growth^n. The model integrates income against this and
// reports the draft cadence; the target band is one draft every 0.5–3 min.
// The GAME's table is canonical — this is a pass-through, not a second copy.
export {LEVEL_CURVE} from "../src/game/data.js";

// ── draft policy — what the modeled player picks ─────────────────────────────
// Deterministic stand-in for a real player: every `incomeBuffEveryNLevels`-th
// level they take the next income-affecting buff from `cycle` (skipping cards
// whose `stacks` are spent); other levels go to blueprints/consumables, which
// don't move the income model. Ids must exist in src/game/cards.js and carry a
// `model`. The headless bot replaces this with real play later.
export const DRAFT_POLICY = {
  incomeBuffEveryNLevels: 2,
  cycle: ["clickSpeed","workerCarry","critClicks","workerSpeed","chopYield",
          "steadyHand","xpAppetite","vacuumRadius","workerSlot","handCarry","nightOwl"],
};

// ── phases — contiguous bands, minutes ───────────────────────────────────────
// Each phase states what the PLAYER'S CLICKS are for. The paradigm shifts are
// the boundaries where that answer changes.
export const PHASES = [
  {id:"bareHands",  name:"Bare hands",     start:0,   end:4,
   clicksAre:"gathering — chop, carry, feed by hand",
   exit:"first worker takes over a node"},
  {id:"firstHands", name:"First hands",    start:4,   end:12,
   clicksAre:"directing — place buildings, plug gaps, still half the income",
   exit:"gather income mostly worker-driven"},
  {id:"automation", name:"Automation I",   start:12,  end:22,
   clicksAre:"combat + layout — drafted buffs absorb the chores",
   exit:"fog reveal: the map is bigger than the meadow"},
  {id:"fog",        name:"Into the fog",   start:22,  end:35,
   clicksAre:"exploration + greed — richer nodes out in the dark, glow dial tension",
   exit:"the thing is loud enough that nights outpace towers"},
  {id:"awakening",  name:"The thing wakes",start:35,  end:45,
   clicksAre:"triage — spend everything, choose an ending",
   exit:"run ends"},
];

// ── structural beats — minutes, sorted ───────────────────────────────────────
// Only the moments the draft can't provide: openings, reveals, the ending.
// kind: "unlock" | "shift" (paradigm shift) | "spike" (set-piece moment).
export const BEATS = [
  {min:2,   kind:"spike",  label:"first house",        ref:"building:house"},
  {min:3.5, kind:"spike",  label:"first worker",       ref:"concept:worker"},
  {min:5,   kind:"spike",  label:"first draft",        ref:"concept:draft"},
  {min:6,   kind:"unlock", label:"quarry",             ref:"building:quarry"},
  {min:9,   kind:"unlock", label:"first tower",        ref:"building:tower"},
  {min:15,  kind:"unlock", label:"obelisk",            ref:"building:obelisk"},
  {min:22,  kind:"shift",  label:"FOG REVEAL — the map opens", ref:"concept:fog"},
  {min:28,  kind:"unlock", label:"rich fog nodes",     ref:"concept:richNodes"},
  {min:35,  kind:"shift",  label:"the thing wakes",    ref:"concept:awakening"},
  {min:43,  kind:"spike",  label:"ending choice",      ref:"concept:ending"},
];

// ── player model — UN-BUFFED baseline the draft compounds on ─────────────────
// Per-phase, indexed by PHASES order. Guesses until the headless bot measures.
export const PLAYER_MODEL = {
  // completed player harvest hits per minute of active play (chop hold-cycles)
  handHitsPerMin:    [40, 30, 18, 12, 8],
  // share of total income the player feeds to the base (rest → buildings)
  feedFraction:      [0.30, 0.35, 0.40, 0.50, 0.60],
  // average XP per fed unit — rises as dust/coin/diamond enter the mix
  avgXpPerFedUnit:   [1, 1, 1.3, 2.6, 4.5],
  // seconds for one worker round trip: walk out, chop a full carry, walk back
  workerTripSeconds: 20,
  // minutes at which each successive house is finished (workers = houses × HOUSE_SLOTS)
  houseAtMinutes:    [4, 8, 13, 19, 26, 34, 42],
};

export function phaseAt(min){
  return PHASES.find(p=>min>=p.start&&min<p.end) ?? PHASES[PHASES.length-1];
}
export function phaseIndexAt(min){
  const p=phaseAt(min); return PHASES.indexOf(p);
}
