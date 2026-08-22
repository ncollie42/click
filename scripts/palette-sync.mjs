// Owns: pushing scripts/palette-ramp.mjs DRAFT hexes into src/render/palette.js SWATCH (by name),
// then reporting every swatch whose LIT landing (palette-snap prediction) is not itself.
// Run after editing a ramp: `node scripts/palette-sync.mjs`. Zero misses = every authored swatch
// shows as itself on a flat lit face.
import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bust = p => import(p + "?" + Date.now());
const {DRAFT} = await bust(join(root, "scripts/palette-ramp.mjs"));
const palettePath = join(root, "src/render/palette.js");
let src = readFileSync(palettePath, "utf8");
for(const d of DRAFT){
  const re = new RegExp(`\\b${d.name}: 0x[0-9a-f]{6}`);
  if(!re.test(src)) throw new Error("palette.js SWATCH has no entry " + d.name);
  src = src.replace(re, `${d.name}: 0x${d.hex.toString(16).padStart(6, "0")}`);
}
writeFileSync(palettePath, src);

const snap = await bust(join(root, "scripts/palette-snap.mjs"));
const {SWATCH} = await bust(palettePath);
let misses = 0;
for(const [name, hex] of Object.entries(SWATCH)){
  const p = snap.predictLanding(hex);
  if(p.lit !== name){
    misses++;
    console.log(name.padEnd(8), "lit->", p.lit.padEnd(8), "side->", p.side.padEnd(8), "shade->", p.shade);
  }
}
console.log(misses, "self-landing misses");
