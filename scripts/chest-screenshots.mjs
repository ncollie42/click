#!/usr/bin/env node
// Repeatable browser proof for chest rendering/interactions. Owns its temporary HTTP server.

import {spawn} from "node:child_process";
import {existsSync,mkdirSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const output=join(root,"docs/screenshots");mkdirSync(output,{recursive:true});
const port=Number(process.env.CHEST_SCREENSHOT_PORT||4173),base=`http://127.0.0.1:${port}`;
const server=spawn("python3",["-m","http.server",String(port),"--directory",root],{stdio:"ignore"});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForServer(){for(let i=0;i<50;i++){try{if((await fetch(base)).ok)return;}catch{}await sleep(100);}throw new Error("screenshot HTTP server did not start");}
const launch={headless:true,args:["--no-sandbox"]},chrome=process.env.CHROME_PATH||"/usr/bin/google-chrome";
if(existsSync(chrome))launch.executablePath=chrome;
let browser;
const errors=[];
async function open(path="/"){
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
  await page.route("**/favicon.ico",route=>route.fulfill({status:204,body:""}));
  page.on("pageerror",error=>errors.push(`pageerror ${path}: ${error.message}`));
  page.on("console",message=>{if(message.type()==="error")errors.push(`console ${path}: ${message.text()}`);});
  page.on("response",response=>{if(response.status()>=400)errors.push(`http ${response.status()} ${response.url()}`);});
  await page.goto(base+path,{waitUntil:"networkidle"});
  await page.evaluate(async()=>{window.__sim=await import("./src/game/simulation.js");window.__scene=await import("./src/render/scene.js");});
  await page.waitForTimeout(250);return page;
}
async function shot(page,name){await page.waitForTimeout(180);await page.screenshot({path:join(output,name)});}
async function focusChest(page){await page.evaluate(()=>{const s=window.__sim,c=s.chests[0];s.state.camera.x=c.x;s.state.camera.y=c.y;s.state.camera.zoom=2.4;});}
async function hitChest(page,count){await page.evaluate(count=>{const s=window.__sim;for(let i=0;i<count;i++){s.primaryPress();s.update(.02);s.primaryRelease();}},count);}
try{
  await waitForServer();browser=await chromium.launch(launch);
  let page=await open();await focusChest(page);await shot(page,"chest-normal-day.png");
  await page.evaluate(()=>{const s=window.__sim;s.debugGoToPhase("night");s.state.clock.light=.5;if(s.state.clock.phase!=="night")throw new Error("night proof did not enter night phase");});
  await shot(page,"chest-normal-night.png");
  await page.evaluate(()=>{const s=window.__sim,c=s.chests[0];s.debugGoToPhase("day");s.state.clock.light=0;s.setPointerWorld(c.x,c.y);s.secondaryPress();let p=null;for(let y=64;y<960&&!p;y+=32)for(let x=64;x<1472;x+=32)if(s.canPlace(x,y,null,null,null,c)){p={x,y};break;}if(!p)throw new Error("no held chest screenshot cell");s.setPointerWorld(p.x,p.y);s.state.camera.x=p.x;s.state.camera.y=p.y;const tuple=window.__scene.scanSubjects().find(([entity])=>entity===c);if(!tuple||tuple[2]!==p.x||tuple[3]!==p.y)throw new Error("held chest scan does not use cursor coordinates");});
  await shot(page,"chest-held-placement.png");
  await page.evaluate(()=>{const s=window.__sim;s.secondaryRelease();const c=s.chests[0];s.TUNE.chopTime=.01;s.setPointerWorld(c.x,c.y);s.state.camera.x=c.x;s.state.camera.y=c.y;});await hitChest(page,1);await shot(page,"chest-damaged.png");
  await page.evaluate(()=>{const s=window.__sim;s.debugForceNextChestOutcome("cache");Math.random=()=>0;});await hitChest(page,3);await shot(page,"chest-cache.png");await page.close();

  page=await open();await focusChest(page);await page.evaluate(()=>{const s=window.__sim,c=s.chests[0];s.TUNE.chopTime=.01;s.debugForceNextChestOutcome("pinata");Math.random=()=>.75;s.setPointerWorld(c.x,c.y);});await hitChest(page,4);await page.evaluate(()=>{const s=window.__sim;if(s.resourceDrops.length!==12||!s.resourceDrops.every(drop=>drop.ttl===null))throw new Error("piñata browser proof payout mismatch");});await shot(page,"chest-pinata.png");await page.close();

  page=await open("/?mode=showcase");await page.evaluate(async()=>{const s=window.__sim;for(let i=0;i<6;i++){s.rebuildShowcase();await new Promise(requestAnimationFrame);}s.focusShowcaseSection("props");if(s.chests.length!==1)throw new Error("showcase chest fixture missing");});await shot(page,"chest-showcase.png");await page.close();
  if(errors.length)throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ok:true,states:["normal-day","normal-night","held-placement","damaged","cache","pinata","showcase"],output}));
}finally{
  if(browser)await browser.close();
  server.kill("SIGTERM");
}
