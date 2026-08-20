// Owns: grass sprite previews — dumps every authored SPRITE_STYLES atlas (src/render/grass.js)
// to an upscaled PNG so the pixels can be eyeballed and a style picked without a browser.
// Usage:  node tools/test-scene/grass-sprite.mjs [scale=16]
// Output: tools/shots/grass-sprites/<style>.png (nearest-neighbour upscale, dark backdrop so the
// near-white blades read; transparent texels stay transparent in the file's alpha).
// The PNG encoder is deliberately minimal (IHDR/IDAT/IEND, filter 0, node zlib) — no deps.

import {deflateSync} from "node:zlib";
import {writeFileSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {bladeAtlasPixels, SPRITE_STYLE_NAMES} from "../../src/render/grass.js";

const OUT = resolve(import.meta.dirname, "..", "shots", "grass-sprites");
mkdirSync(OUT, {recursive: true});
const SCALE = Math.max(1, parseInt(process.argv[2] ?? "16", 10) || 16);

const CRC_TABLE = new Uint32Array(256);
for(let n = 0; n < 256; n++){
  let c = n;
  for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
const crc32 = buf => {
  let c = 0xffffffff;
  for(const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data){
  const t = Buffer.from(type, "ascii");
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([head, t, data, crc]);
}

function encodePNG(w, h, rgba){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(h * (1 + w * 4));      // filter byte 0 per scanline
  for(let y = 0; y < h; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (1 + w * 4) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function upscaled(style){
  const {width, height, data} = bladeAtlasPixels(style);
  const W = width * SCALE, H = height * SCALE;
  const out = new Uint8Array(W * H * 4);
  for(let y = 0; y < H; y++){
    // atlas row 0 is the blade BASE; flip so the preview shows blades growing upward
    const sy = height - 1 - (y / SCALE | 0);
    for(let x = 0; x < W; x++){
      const si = (sy * width + (x / SCALE | 0)) * 4, di = (y * W + x) * 4;
      if(data[si + 3]){
        out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2];
        out[di + 3] = 255;
      }else{
        out[di] = 24; out[di + 1] = 30; out[di + 2] = 24; out[di + 3] = 255;   // dark backdrop
      }
    }
  }
  return {W, H, out, width, height};
}

const sheets = [];
for(const style of SPRITE_STYLE_NAMES){
  const s = upscaled(style);
  sheets.push([style, s]);
  const file = join(OUT, `${style}.png`);
  writeFileSync(file, encodePNG(s.W, s.H, s.out));
  console.log(`wrote ${file} (${s.width}x${s.height} → ${s.W}x${s.H})`);
}

// Contact sheet: every style stacked vertically (SPRITE_STYLE_NAMES order), separator rows
// between them, all left-aligned on the widest atlas.
const GAP = SCALE;
const sheetW = Math.max(...sheets.map(([, s]) => s.W));
const sheetH = sheets.reduce((a, [, s]) => a + s.H, 0) + GAP * (sheets.length - 1);
const sheet = new Uint8Array(sheetW * sheetH * 4);
for(let i = 0; i < sheet.length; i += 4){ sheet[i] = 14; sheet[i + 1] = 18; sheet[i + 2] = 14; sheet[i + 3] = 255; }
let yOff = 0;
for(const [, s] of sheets){
  for(let y = 0; y < s.H; y++)
    sheet.set(s.out.subarray(y * s.W * 4, (y + 1) * s.W * 4), ((yOff + y) * sheetW) * 4);
  yOff += s.H + GAP;
}
const allFile = join(OUT, "all.png");
writeFileSync(allFile, encodePNG(sheetW, sheetH, sheet));
console.log(`wrote ${allFile} (${SPRITE_STYLE_NAMES.join(" / ")}, top to bottom)`);
