// Screenshot rig for the fanned-hand gauntlet. Drives the real page through the dev helpers
// documented in src/main.js (window.__draftDemo) and the simulation's own view-debugger
// buttons — it stages nothing by writing DOM. Any page error fails the whole run.
//
//   node gauntlet-shots/shoot.mjs            (expects a static server on 8971)
import {createRequire} from "node:module";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire("/home/mando/dev/gamedev/click/package.json");
const {chromium} = require("playwright");
const OUT = dirname(fileURLToPath(import.meta.url));
const BASE = "http://127.0.0.1:8971/";
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

await page.goto(BASE, {waitUntil:"load"});
await page.waitForFunction("!!window.__draftDemo");
await wait(900);
await tidy();

// ── A1 · hand at rest ──────────────────────────────────────────────────────
// Six cards: a stacked copy (warm rations ×2) and a part-spent kit (spike kit, 2 of 3).
await page.evaluate(() => window.__draftDemo.hand());
await wait(500);
await shot("A1-hand-at-rest");

// ── A2 · hover ─────────────────────────────────────────────────────────────
const cards = page.locator("#handCards .card");
await cards.nth(3).hover();
await wait(450);
await shot("A2-hover-readable");

// ── A6 · after an instant card ─────────────────────────────────────────────
// Play the coin purse (index 2) with the keyboard, then wait out the flight so the shot is
// the settled aftermath: a thinner hand and the toast the play raised.
await page.mouse.move(640, 300);
await wait(250);
await page.keyboard.press("Digit3");
await wait(900);
await shot("A6-after-instant");

// ── A3 · targeting mid-kit ─────────────────────────────────────────────────
// A fresh 3-charge spike kit, played, then one trap actually placed on the map, so the shot
// is a real mid-kit state: ghost on the ground, card lifted and lit, two pips left of three.
await page.evaluate(() => window.__draftDemo.hand([{id:"spikeKit",count:1},{id:"rations",count:2},
  "coinPurse","watchPlan","tarBarrels"]));
await wait(400);
await page.evaluate(() => window.__draftDemo.freeze(false));
await cards.nth(0).click();
await wait(500);
await page.mouse.move(430, 300);
await page.mouse.down(); await page.mouse.up();     // place trap 1 of 3
await wait(400);
await page.mouse.move(560, 340);                     // leave the ghost sitting on clear ground
await wait(500);
await shot("A3-targeting-mid-kit");
await page.keyboard.press("Escape");
await wait(400);

// ── A4 · dawn reward ───────────────────────────────────────────────────────
await page.evaluate(() => window.__draftDemo.dawn());
await wait(700);
await shot("A4-dawn-spoils");

// ── A5 · a drafted card mid-flight ─────────────────────────────────────────
// Take pick 2, let the flight get properly under way, then freeze it in the air.
await page.locator("#draftPicks .pick").nth(1).click();
await wait(105);
await page.evaluate(() => window.__draftDemo.freeze(true));
await wait(120);
await shot("A5-draft-flies-to-hand");
await page.evaluate(() => window.__draftDemo.freeze(false));
await wait(1100);

// ── A7 · everything at once ────────────────────────────────────────────────
// Hand, the relocated build dock with a category open, the HUD, the keyboard hint.
await page.evaluate(() => window.__draftDemo.hand());
await wait(300);
await page.click('.dock-tab[data-category="economy"]');
await wait(400);
await page.mouse.move(640, 260);
await wait(600);
await shot("A7-whole-screen");

// ── A8 · the level draft, triggered for real ───────────────────────────────
// No debug hook here: playing the harvest feast feeds the base 40 xp through the simulation's
// own feeding path, that crosses the first tier, and the card model's frame watcher opens the
// level draft off the tier moving. Violet furniture and a boon in the pool, unlike dawn.
await page.evaluate(() => window.__draftDemo.hand(["harvestFeast","rations","spikeKit"]));
await wait(300);
await page.keyboard.press("Digit1");
await page.waitForSelector("#draftOverlay:not([hidden])", {timeout:5000});
await wait(700);
await shot("A8-level-up");
await page.keyboard.press("Digit1");
await wait(1400);

// ── A9 · reduced motion ────────────────────────────────────────────────────
// Same screen with prefers-reduced-motion on: nothing travels, nothing pulses, and both
// flights fall back to a fade. Played and drafted here too, so the no-motion paths run.
await page.emulateMedia({reducedMotion:"reduce"});
await page.reload({waitUntil:"load"});
await page.waitForFunction("!!window.__draftDemo");
await wait(900);
await tidy();
await page.evaluate(() => window.__draftDemo.hand());
await wait(300);
await page.keyboard.press("Digit3");
await wait(500);
await page.evaluate(() => window.__draftDemo.dawn());
await wait(500);
await page.locator("#draftPicks .pick").nth(0).hover();
await wait(300);
await shot("A9-reduced-motion");
await page.keyboard.press("Digit2");
await wait(900);

console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
await browser.close();
process.exit(errors.length ? 1 : 0);
