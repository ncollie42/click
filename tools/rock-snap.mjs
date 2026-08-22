#!/usr/bin/env node
// One-purpose audition harness: screenshot the game's rocky region under the PIXEL pipeline at
// the shipping camera (pitch 33, ortho), for iterating on makeRock. Pattern copied from
// terrain-render-snap.mjs (serve root, seeded Math.random, drive src modules directly).
// Usage: node tools/rock-snap.mjs out.png [zoom]   — shots land in tools/shots/rocks/.
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {extname,join,resolve} from "node:path";
import {chromium} from "playwright";

const ROOT=resolve(import.meta.dirname,".."),OUT=join(ROOT,"tools","shots","rocks");
const MIME={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json"};
await mkdir(OUT,{recursive:true});
const server=createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,"http://local").pathname);
    if(pathname==="/favicon.ico"){response.writeHead(204).end();return;}
    const path=join(ROOT,pathname);
    if(!path.startsWith(ROOT)){response.writeHead(403).end();return;}
    const body=await readFile(path);
    response.writeHead(200,{"content-type":MIME[extname(path)]||"application/octet-stream"});
    response.end(body);
  }catch{response.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const port=server.address().port;

const out=process.argv[2]||"rocks.png", zoom=+(process.argv[3]||2.2);
const cx=+(process.argv[4]||86*32), cy=+(process.argv[5]||86*32), pipe=process.argv[6]||"pixel";
const browser=await chromium.launch({channel:"chrome",headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800}});
await page.addInitScript(name=>{
  let state=1;Math.random=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/0x100000000);
  if(name!=="current")localStorage.setItem("click.pipeline",name);
},pipe);
const errors=[];
page.on("pageerror",e=>errors.push(e.message));
page.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(()=>document.querySelector("#scene")?.width>0&&document.querySelector("#toast")?.textContent.length>0);
await page.evaluate(async settings=>{
  const sim=await import("/src/game/simulation.js"),render=await import("/src/render/scene.js");
  sim.state.paused=true;
  sim.state.camera.x=settings.x;sim.state.camera.y=settings.y;sim.state.camera.zoom=settings.zoom;
  document.body.classList.add("ui-hidden");
  render.view.pitch=33;render.view.yaw=0;render.view.orbit=false;render.setOrthoCamera(true);
  render.placeCamera();
},{x:cx,y:cy,zoom});
await page.waitForTimeout(900);   // let the pipeline settle a few frames
await page.screenshot({path:join(OUT,out)});
if(errors.length)console.log("page errors:",errors);
console.log("wrote",join("tools/shots/rocks",out),errors.length?`(${errors.length} errors)`:"(clean)");
await browser.close();server.close();
