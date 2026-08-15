// Screenshot rig for the fanned-hand gauntlet. Drives the real page through the dev helpers
// documented in src/main.js (window.__draftDemo, behind ?draftDemo=1) and the simulation's own
// view-debugger buttons — every card, offer and level below is dealt by a simulation debug
// COMMAND, so nothing here stages a state the game cannot reach on its own. It writes no DOM.
// Any page error fails the whole run.
//
//   node gauntlet-shots/shoot.mjs            (expects a static server on 8971)
import {createRequire} from "node:module";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire("/home/mando/dev/gamedev/click/package.json");
const {chromium} = require("playwright");
const OUT = dirname(fileURLToPath(import.meta.url));
const BASE = "http://127.0.0.1:8971/?draftDemo=1";
mkdirSync(OUT, {recursive:true});

const errors = [];
const wait = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({executablePath:"/usr/bin/google-chrome"});
const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2});
page.on("pageerror", e => errors.push("pageerror: " + e.message));
// The favicon 404 is the static server's, not the page's; everything else counts.
page.on("console", m => {if(m.type()==="error" && !/favicon/.test(m.location().url||"")) errors.push("console: " + m.text());});
page.on("requestfailed", r => {if(!/favicon/.test(r.url())) errors.push("requestfailed: " + r.url());});

async function shot(name){ await page.screenshot({path:`${OUT}/${name}.png`}); console.log("  ✓", name); }
/** Collapse the debug side panel — it is a dev tool, not game chrome, and it covers the map. */
async function tidy(){ await page.click("#vToggle"); }
/** The hand the shots are taken against: a stacked copy (wood bundle ×2) and a kit that can be
 *  part-spent, plus one of every other shape a card comes in — spell, blueprint, plain instant. */
const deal = () => page.evaluate(() => window.__draftDemo.hand());
/** Play the spike kit and drop one of its three traps, which is what leaves a real 2-of-3 card. */
async function openKitAndPlaceOne(){
  await page.locator("#handCards .card").nth(1).click();   // spike kit
  await wait(500);
  await page.mouse.move(430, 300);
  await page.mouse.down(); await page.mouse.up();          // trap 1 of 3
  await wait(400);
}

await page.goto(BASE, {waitUntil:"load"});
await page.waitForFunction("!!window.__draftDemo");
await wait(900);
await tidy();

// ── A3 · targeting mid-kit ─────────────────────────────────────────────────
// Taken first because it is the state A1's part-spent card comes out of: the kit is open, one
// trap is already on the ground, the ghost sits on clear ground under the cursor and the card is
// lifted and violet with two of three pips left.
await deal();
await wait(500);
await openKitAndPlaceOne();
await page.mouse.move(560, 340);                           // leave the ghost on clear ground
await wait(500);
await shot("A3-targeting-mid-kit");
await page.keyboard.press("Escape");                       // stow: the unplaced charges stay
await wait(500);

// ── A1 · hand at rest ──────────────────────────────────────────────────────
// Six cards, among them a stacked copy (wood bundle ×2) and the kit the shot above left at 2 of 3.
await page.mouse.move(640, 260);
await wait(500);
await shot("A1-hand-at-rest");

// ── A2 · hover ─────────────────────────────────────────────────────────────
await page.locator("#handCards .card").nth(3).hover();
await wait(450);
await shot("A2-hover-readable");

// ── A6 · after an instant card ─────────────────────────────────────────────
// Play calm night (position 5) with the keyboard, then wait out the flight so the shot is the
// settled aftermath: a card fewer in the fan and the toast the play raised.
await page.mouse.move(640, 260);
await wait(250);
await page.keyboard.press("Digit5");
await wait(900);
await shot("A6-after-instant");

// ── A4 · dawn reward ───────────────────────────────────────────────────────
// A whole night run to its end through the simulation's own phase transition, which is the thing
// that queues the dawn pick — sunrise colours, and three cards that all end up in the hand.
await page.evaluate(() => window.__draftDemo.dawn());
await page.waitForSelector("#draftOverlay:not([hidden])", {timeout:5000});
await wait(800);
await shot("A4-dawn-spoils");

// ── A5 · a drafted card mid-flight ─────────────────────────────────────────
// Take pick 2, let the flight get properly under way, then freeze it in the air.
await page.locator("#draftPicks .pick").nth(1).click();
await wait(115);
await page.evaluate(() => window.__draftDemo.freeze(true));
await wait(120);
await shot("A5-draft-flies-to-hand");
await page.evaluate(() => window.__draftDemo.freeze(false));
await wait(1100);

// ── A8 · the level draft ───────────────────────────────────────────────────
// __draftDemo.deal() feeds the base exactly the xp the next level costs, through the same feeding
// path a carried resource takes, so the simulation levels and deals its own offer. Violet
// furniture and a buff in the mix, unlike dawn.
await page.evaluate(() => window.__draftDemo.deal(1));
await page.waitForSelector("#draftOverlay:not([hidden])", {timeout:5000});
await wait(800);
await shot("A8-level-up");
await page.keyboard.press("Digit1");
await wait(1500);

// ── A7 · everything at once ────────────────────────────────────────────────
// Hand, the relocated build dock with a category open, the HUD, the level bar, the keyboard hint.
await deal();
await wait(400);
await page.click('.dock-tab[data-category="economy"]');
await wait(400);
await page.mouse.move(640, 240);
await wait(600);
await shot("A7-whole-screen");

// ── A9 · reduced motion ────────────────────────────────────────────────────
// The same draft screen with prefers-reduced-motion on: nothing travels, nothing pulses, and both
// card flights fall back to a fade. Played and drafted here too, so the no-motion paths run.
await page.emulateMedia({reducedMotion:"reduce"});
await page.reload({waitUntil:"load"});
await page.waitForFunction("!!window.__draftDemo");
await wait(900);
await tidy();
await deal();
await wait(400);
await page.keyboard.press("Digit5");
await wait(500);
await page.evaluate(() => window.__draftDemo.dawn());
await page.waitForSelector("#draftOverlay:not([hidden])", {timeout:5000});
await wait(400);
await page.locator("#draftPicks .pick").nth(0).hover();
await wait(300);
await shot("A9-reduced-motion");
await page.keyboard.press("Digit2");
await wait(900);

console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
