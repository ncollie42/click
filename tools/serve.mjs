#!/usr/bin/env node
// Dev server for the repository: serves the repo root like `python3 -m http.server`
// and additionally accepts PUT /src/game/maps/starter.map.json so the map editor's
// "save to game" button can update the live map in place. The body is validated with
// the real game loader (structure + base/chest/raised invariants) before anything is
// written; an invalid map changes nothing on disk.
//
//   node tools/serve.mjs [port]     (default port 8000)

import {createServer} from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import {join, normalize, extname, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {parseMapDocument, stringifyMapDocument} from "../src/game/map-document.js";
import {buildWorldFromMapData} from "../src/game/authored-map.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LIVE_MAP_PATH = "/src/game/maps/starter.map.json";
const PORT = Number(process.argv[2] ?? 8000);
const BODY_LIMIT = 8 * 1024 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8"){
  res.writeHead(status, {"content-type": type, "cache-control": "no-store"});
  res.end(body);
}

async function readBody(req){
  const chunks = [];
  let size = 0;
  for await (const chunk of req){
    size += chunk.length;
    if(size > BODY_LIMIT) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function saveLiveMap(req, res){
  let canonical;
  try{
    const doc = parseMapDocument(await readBody(req));   // structural validation
    canonical = stringifyMapDocument(doc);
    buildWorldFromMapData(JSON.parse(canonical));        // full game-boot invariants
  }catch(error){
    send(res, 400, `rejected, nothing written: ${error.message}`);
    return;
  }
  await writeFile(join(ROOT, LIVE_MAP_PATH), canonical);
  console.log(`saved ${LIVE_MAP_PATH}`);
  send(res, 200, "saved");
}

async function serveStatic(req, res){
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let path = normalize(join(ROOT, pathname));
  if(path !== ROOT && !path.startsWith(ROOT + sep)) return send(res, 403, "forbidden");
  try{
    let body;
    try{
      body = await readFile(path);
    }catch(error){
      if(error.code !== "EISDIR") throw error;
      path = join(path, "index.html");
      body = await readFile(path);
    }
    res.writeHead(200, {"content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store"});
    res.end(req.method === "HEAD" ? undefined : body);
  }catch{
    send(res, 404, "not found");
  }
}

createServer(async (req, res) => {
  try{
    const pathname = new URL(req.url, "http://localhost").pathname;
    if(req.method === "PUT" && pathname === LIVE_MAP_PATH) await saveLiveMap(req, res);
    else if(req.method === "GET" || req.method === "HEAD") await serveStatic(req, res);
    else send(res, 405, "method not allowed");
  }catch(error){
    send(res, 500, error.message);
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
  console.log(`map editor: http://127.0.0.1:${PORT}/tools/map-editor.html (live save enabled)`);
});
