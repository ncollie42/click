// Screenshot harness for tools/model-viewer.html.
// Usage:  node tools/snap.mjs "model=worker-gatherer&anim=chop&phase=0.5" gatherer-chop.png [more pairs...]
// Each pair = (query string, output filename). Shots land in tools/shots/.
// Serves the repo root itself on an ephemeral port; needs `npx playwright` + system Chrome.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "tools", "shots");
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
if (!pairs.length) { console.error("usage: node tools/snap.mjs <query> <out.png> [...]"); process.exit(1); }

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 940, height: 660 } });
page.on("console", m => { if (m.type() === "warning" || m.type() === "error") console.log("[page]", m.text()); });
page.on("pageerror", e => console.log("[pageerror]", e.message));

for (const [query, out] of pairs) {
  await page.goto(`http://127.0.0.1:${port}/tools/model-viewer.html?${query}`);
  await page.waitForFunction("window.__ready === true", null, { timeout: 15000 });
  await page.waitForTimeout(120);   // one settled frame past ready
  const file = join(OUT, out);
  await page.locator("#c").screenshot({ path: file });
  console.log("shot:", file);
}
await browser.close();
server.close();
