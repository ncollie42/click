#!/usr/bin/env node
// Browser screenshot/smoke harness for production terrain geometry, running on the
// authored starter map (src/game/maps/starter.map.json). Images land under ignored tools/shots/.

import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {extname,join,resolve} from "node:path";
import {chromium} from "playwright";

const ROOT=resolve(import.meta.dirname,".."),OUT=join(ROOT,"tools","shots","terrain"),GAMEPLAY_SEED=1;
const MIME={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json"};
await mkdir(OUT,{recursive:true});
const server=createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url,"http://local").pathname);
    if(pathname==="/favicon.ico"){response.writeHead(204).end();return;}
    const path=join(ROOT,pathname);
    if(!path.startsWith(ROOT)){response.writeHead(403).end();return;}
    const body=await readFile(path);response.writeHead(200,{"content-type":MIME[extname(path)]||"application/octet-stream"});response.end(body);
  }catch{response.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const port=server.address().port,browser=await chromium.launch({channel:"chrome",headless:true});

async function open(mode="normal"){
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],started=performance.now();
  await page.addInitScript(seed=>{let state=seed;Math.random=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/0x100000000);},GAMEPLAY_SEED);
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${port}/index.html${mode==="showcase"?"?mode=showcase":""}`);
  await page.waitForFunction(()=>document.querySelector("#scene")?.width>0&&document.querySelector("#toast")?.textContent.length>0);
  return {page,errors,coldStartupMs:performance.now()-started};
}

async function setView(page,{x,y,zoom,pitch=40,yaw=0,ortho=false}){
  await page.evaluate(async settings=>{
    const sim=await import("/src/game/simulation.js"),render=await import("/src/render/scene.js");
    sim.state.paused=true;sim.state.camera.x=settings.x;sim.state.camera.y=settings.y;sim.state.camera.zoom=settings.zoom;document.body.classList.add("ui-hidden");
    render.view.pitch=settings.pitch;render.view.yaw=settings.yaw;render.view.orbit=false;render.setOrthoCamera(settings.ortho);
    render.resizeRenderer();render.drawScene();render.renderScene();
  },{x,y,zoom,pitch,yaw,ortho});
  await page.waitForTimeout(100);
}
async function pointerRoundTrip(page,settings,target){
  await setView(page,settings);
  const result=await page.evaluate(async point=>{
    const render=await import("/src/render/scene.js"),projected=render.project(point.x,point.y),rect=document.querySelector("#overlay").getBoundingClientRect();
    return render.groundFromEvent({clientX:rect.left+projected.x/960*rect.width,clientY:rect.top+projected.y/540*rect.height});
  },target);
  assert.ok(Math.hypot(result.x-target.x,result.y-target.y)<1e-4,`pointer round-trip drifted: ${JSON.stringify({settings,target,result})}`);
}
try{
  const normal=await open(),page=normal.page;
  const features=await page.evaluate(async()=>{
    const sim=await import("/src/game/simulation.js"),metadata=sim.terrainMetadata(),cols=metadata.terrainCols,rows=metadata.terrainRows;
    const index=(x,y)=>y*cols+x,tags=Array.from({length:cols*rows},(_,i)=>sim.terrainAtRasterCell(i%cols,Math.floor(i/cols)));
    const ocean=new Set(),queue=[];
    const enqueue=(x,y)=>{if(x<0||y<0||x>=cols||y>=rows||tags[index(x,y)]!=="water"||ocean.has(index(x,y)))return;ocean.add(index(x,y));queue.push([x,y]);};
    for(let x=0;x<cols;x++){enqueue(x,0);enqueue(x,rows-1);}for(let y=0;y<rows;y++){enqueue(0,y);enqueue(cols-1,y);}
    for(let at=0;at<queue.length;at++){const [x,y]=queue[at];enqueue(x+1,y);enqueue(x-1,y);enqueue(x,y+1);enqueue(x,y-1);}
    let coast=null;
    const center=(x,y)=>({x:(x+.5)*metadata.terrainCellSize,y:(y+.5)*metadata.terrainCellSize});
    for(let y=0;y<rows&&!coast;y++)for(let x=0;x<cols;x++){
      const at=index(x,y),neighbors=[[x+1,y],[x-1,y],[x,y+1],[x,y-1]].filter(([nx,ny])=>nx>=0&&ny>=0&&nx<cols&&ny<rows);
      const oceanNeighbor=neighbors.find(([nx,ny])=>ocean.has(index(nx,ny)));
      if(tags[at]==="land"&&oceanNeighbor){
        const dx=oceanNeighbor[0]-x,dy=oceanNeighbor[1]-y;let deep=oceanNeighbor;
        for(let step=2;step<=4;step++){const nx=x+dx*step,ny=y+dy*step;if(nx<0||ny<0||nx>=cols||ny>=rows||!ocean.has(index(nx,ny)))break;deep=[nx,ny];}
        coast={...center(x,y),water:center(...deep)};break;
      }
    }
    return {world:[metadata.width,metadata.height],land:tags.filter(tag=>tag==="land").length,water:tags.filter(tag=>tag==="water").length,ocean:ocean.size,coast,targets:metadata.targets,trees:sim.trees.length,rocks:sim.rocks.length,diamonds:sim.diamonds.length,chests:sim.chests.length,grass:sim.grass.length};
  });
  assert.ok(normal.coldStartupMs<30000,`cold startup ${normal.coldStartupMs.toFixed(0)}ms exceeded headless budget`);
  assert.ok(features.land>0&&features.water>0&&features.ocean>0,"authored terrain lacks land or ocean");
  assert.ok(features.coast,"authored terrain lacks an ocean coast");
  assert.deepEqual([features.trees,features.rocks,features.diamonds,features.chests,features.grass],[features.targets.treeCount,features.targets.rockCount,features.targets.diamondCount,features.targets.chestCount,features.targets.grassCount],"materialized resources drifted from authored targets");
  const initialRender=await page.evaluate(async()=>{const render=await import("/src/render/scene.js");render.drawScene();render.renderScene();return render.terrainRenderDiagnostics();});
  assert.ok(initialRender.drawCalls<=768&&initialRender.geometries<=640&&initialRender.textures<=16,`render resources escaped smoke bounds: ${JSON.stringify(initialRender)}`);
  const observedSpawns=await page.evaluate(async()=>{
    const sim=await import("/src/game/simulation.js"),data=await import("/src/game/data.js"),observed=[];
    for(let i=0;i<6;i++){
      sim.spawnEnemy("raider");const enemy=sim.state.enemies.at(-1);
      observed.push({radius:Math.hypot(enemy.x-data.BASE.x,enemy.y-data.BASE.y)/data.ENEMY_SPAWN_RADIUS,land:sim.terrainAtWorldPoint(enemy.x,enemy.y)});
    }
    sim.state.enemies.length=0;return observed;
  });
  assert.equal(observedSpawns.every(spawn=>spawn.land==="land"&&spawn.radius>=.89&&spawn.radius<=1.11),true,`browser enemy began off the base spawn ring: ${JSON.stringify(observedSpawns)}`);

  await setView(page,{x:features.world[0]/2,y:features.world[1]/2,zoom:.1,pitch:89,yaw:0,ortho:true});
  assert.equal(await page.evaluate(async()=>(await import("/src/render/scene.js")).terrainRenderDiagnostics().placementGridVisible),false,"overview retained an invisible placement-grid draw");
  await page.locator("#scene").screenshot({path:join(OUT,"normal-full-map.png")});
  await setView(page,{x:features.world[0]/2,y:features.world[1]/2,zoom:1.35,pitch:38,yaw:18});assert.equal(await page.evaluate(async()=>(await import("/src/render/scene.js")).terrainRenderDiagnostics().placementGridVisible),true,"normal zoom failed to restore placement grid");await page.locator("#scene").screenshot({path:join(OUT,"normal-base.png")});
  const coastView={x:(features.coast.x+features.coast.water.x)/2,y:(features.coast.y+features.coast.water.y)/2};await setView(page,{...coastView,zoom:2.2,pitch:48,yaw:28});
  await page.locator("#scene").screenshot({path:join(OUT,"normal-coast.png")});
  for(const [name,x,y,zoom] of [["normal-dense-forest.png",96*32,62*32,2.2],["normal-meadow.png",120*32,80*32,2],["normal-rocky.png",86*32,86*32,2.2]]){
    await setView(page,{x,y,zoom,pitch:42,yaw:24});
    await page.locator("#scene").screenshot({path:join(OUT,name)});
  }

  const performanceObservation=await page.evaluate(async()=>{const render=await import("/src/render/scene.js"),started=performance.now();for(let i=0;i<120;i++){render.drawScene();render.renderScene();}const forcedElapsed=performance.now()-started,raf=[];await new Promise(resolve=>{let previous=performance.now();const tick=now=>{raf.push(now-previous);previous=now;if(raf.length>=60)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);});raf.sort((a,b)=>a-b);return {forcedElapsed,rafMean:raf.reduce((sum,value)=>sum+value,0)/raf.length,rafP95:raf[Math.floor(raf.length*.95)],stats:render.terrainRenderDiagnostics()};});assert.ok(performanceObservation.forcedElapsed<12000,"120 forced render frames exceeded smoke budget");assert.ok(performanceObservation.rafMean<500&&performanceObservation.rafP95<250,"representative RAF timing exceeded robust headless budget");assert.ok(performanceObservation.stats.drawCalls<=768&&performanceObservation.stats.geometries<=640&&performanceObservation.stats.textures<=16,`representative frame resources escaped bounds: ${JSON.stringify(performanceObservation.stats)}`);

  const center={x:features.world[0]/2,y:features.world[1]/2};
  await pointerRoundTrip(page,{...center,zoom:.3,pitch:18,yaw:-135,ortho:false},{x:center.x+12,y:center.y-8});
  await pointerRoundTrip(page,{...center,zoom:5,pitch:89,yaw:120,ortho:true},{x:center.x-8,y:center.y+6});
  await page.setViewportSize({width:1000,height:900});
  await pointerRoundTrip(page,{...center,zoom:1.4,pitch:32,yaw:47,ortho:false},{x:center.x+5,y:center.y+9});
  assert.deepEqual(normal.errors,[],`normal page errors: ${normal.errors.join(" | ")}`);await page.close();

  const showcase=await open("showcase");
  const rebuild=await showcase.page.evaluate(async()=>{
    const sim=await import("/src/game/simulation.js"),render=await import("/src/render/scene.js"),before=sim.terrainMetadata().revision,beforeStats=render.terrainRenderDiagnostics(),authored=sim.state.enemies.map(enemy=>({enemy,x:enemy.x,y:enemy.y}));
    for(let i=0;i<4;i++)sim.spawnEnemy("raider");sim.spawnEnemy("brute");
    const showcaseSpawnNoop=sim.state.enemies.length===authored.length&&sim.state.enemies.every((enemy,index)=>enemy===authored[index].enemy&&enemy.x===authored[index].x&&enemy.y===authored[index].y);sim.validateSimulationInvariants();
    for(let i=0;i<3;i++){assertRebuild(sim.rebuildShowcase());render.drawScene();render.renderScene();}
    function assertRebuild(ok){if(!ok)throw new Error("showcase terrain rebuild rejected");}
    return {before,after:sim.terrainMetadata().revision,beforeStats,afterStats:render.terrainRenderDiagnostics(),world:[sim.terrainMetadata().width,sim.terrainMetadata().height],showcaseSpawnNoop};
  });
  assert.equal(rebuild.showcaseSpawnNoop,true,"browser showcase spawn command changed authored enemies");assert.equal(rebuild.after,rebuild.before+3,"showcase terrain revision did not advance for each rebuild");assert.equal(rebuild.afterStats.terrainBuilds,rebuild.beforeStats.terrainBuilds+3);assert.equal(rebuild.afterStats.terrainDisposals,rebuild.beforeStats.terrainDisposals+6);assert.equal(rebuild.afterStats.gridBuilds,rebuild.beforeStats.gridBuilds+3);assert.equal(rebuild.afterStats.gridDisposals,rebuild.beforeStats.gridDisposals+3);
  await setView(showcase.page,{x:784,y:480,zoom:.5,pitch:70,yaw:0,ortho:true});
  await showcase.page.locator("#scene").screenshot({path:join(OUT,"showcase-all-land.png")});
  assert.deepEqual(showcase.errors,[],`showcase page errors: ${showcase.errors.join(" | ")}`);await showcase.page.close();
  console.log(`terrain render smoke ok | authored starter map | cold ${normal.coldStartupMs.toFixed(0)}ms | land ${features.land} | water ${features.water} | ocean ${features.ocean} | 120 forced ${performanceObservation.forcedElapsed.toFixed(1)}ms | RAF mean/p95 ${performanceObservation.rafMean.toFixed(1)}/${performanceObservation.rafP95.toFixed(1)}ms | draw/geometries/textures ${performanceObservation.stats.drawCalls}/${performanceObservation.stats.geometries}/${performanceObservation.stats.textures} | ring spawns ${observedSpawns.length} on land | revision ${rebuild.before}->${rebuild.after} | shots ${OUT}`);
}finally{
  await browser.close();server.close();
}
