// Screenshot harness for tools/test-scene.html — the Red Giraffe reference match.
// Usage:  node tools/snap-scene.mjs "t=12&seed=3" full.png [more pairs...]
// Each pair = (query string, output filename). Shots land in tools/shots/redgiraffe-scene-r1/.
// Same shape as tools/snap.mjs (serves the repo root on an ephemeral port, drives system Chrome
// through the repo's playwright, reports pageerrors) — only the page, the viewport and the output
// directory differ. Browser automation here is for VERIFICATION SHOTS ONLY.
//
// Viewport is the reference frame's exact size, so a shot and reference.png can be diffed and
// montaged without resampling.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "tools", "shots", "redgiraffe-scene-r1");
const VIEW = { width: 1571, height: 870 };   // reference.png's size
mkdirSync(OUT, { recursive: true });

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".css":"text/css", ".png":"image/png", ".json":"application/json" };

const server = createServer(async (req, res) => {
  try {
    const path = join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const pairs = [];
for (let i = 2; i + 1 < process.argv.length + 1; i += 2) {
  if (process.argv[i] && process.argv[i + 1]) pairs.push([process.argv[i], process.argv[i + 1]]);
}
if (!pairs.length) { console.error("usage: node tools/snap-scene.mjs <query> <out.png> [...]"); process.exit(1); }

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
let problems = 0;
// Headless Chrome emits a GPU-performance warning every time a screenshot reads the framebuffer
// back ("GPU stall due to ReadPixels"). It is the harness's own doing, not the page's — ignore it
// so "clean: 0 console problems" means something.
const BENIGN = /GL Driver Message .*Performance/;
page.on("console", m => {
  if (m.type() !== "warning" && m.type() !== "error") return;
  if (BENIGN.test(m.text())) return;
  problems++; console.log("[page]", m.text());
});
page.on("pageerror", e => { problems++; console.log("[pageerror]", e.message); });

for (const [query, out] of pairs) {
  await page.goto(`http://127.0.0.1:${port}/tools/test-scene.html?${query}`);
  await page.waitForFunction("window.__ready === true", null, { timeout: 20000 });
  const stuck = await page.evaluate("window.__pipelineError || null");
  if (stuck) { problems++; console.log("[pipeline]", stuck); }
  await page.waitForTimeout(150);   // one settled frame past ready
  const file = join(OUT, out);
  await page.locator("#c").screenshot({ path: file });
  // Round-3 yardstick key: every shot carries the props' screen silhouettes in canvas pixels, so
  // probe.py grades per PROP RECT instead of measure.py's cross-contaminating hue families.
  // Producer: tools/test-scene/scene.js propRects(). Consumer: probe.py.
  const rects = await page.evaluate("JSON.stringify(window.__testScene.propRects())");
  await writeFile(file.replace(/\.png$/, ".props.json"), rects);
  console.log("shot:", file);
}
await browser.close();
server.close();
console.log(problems ? `WARN: ${problems} console problem(s)` : "clean: 0 console problems");
