// Owns showcase-only DOM, listeners, navigation, labels, and dummy readouts.

import {
  focusShowcaseSection,resetDamageDummies,resetShowcaseProps,rebuildShowcase,
  showcaseSections,showcaseLabels,focusedDummyReadout
} from "../game/simulation.js";
import {project} from "../render/scene.js";

let teardownCurrent=()=>{};
let active=false;
let labelsRevision=-1;
let labels=[];
const labelByKey=new Map();
let readout=null;
let readoutText="";

function normalUrl(){const url=new URL(location.href);url.searchParams.delete("mode");return url.pathname+(url.search||"")+(url.hash||"");}
function syncLabels(){
  const snapshot=showcaseLabels();
  if(!snapshot||snapshot.revision===labelsRevision)return;
  const root=document.getElementById("showcaseLabels"),nextKeys=new Set(),next=[];
  labelsRevision=snapshot.revision;
  for(const record of snapshot.labels){
    nextKeys.add(record.key);
    let item=labelByKey.get(record.key);
    if(!item){const element=document.createElement("span");element.dataset.labelKey=record.key;item={element,record,visible:null,left:"",top:""};labelByKey.set(record.key,item);}
    item.record=record;
    if(item.element.textContent!==record.label)item.element.textContent=record.label;
    next.push(item);root.appendChild(item.element);
  }
  for(const [key,item] of labelByKey)if(!nextKeys.has(key)){item.element.remove();labelByKey.delete(key);}
  labels=next;
}
function runAndSync(command){return ()=>{command();syncLabels();};}

export function initShowcaseUi(hooks={}){
  teardownCurrent();active=true;labelsRevision=-1;readoutText="";
  const cameraChanged=hooks.cameraChanged||(()=>{}),game=document.getElementById("game"),root=document.getElementById("showcasePanel"),labelsRoot=document.getElementById("showcaseLabels");
  game.classList.add("showcase-active");
  root.replaceChildren();labelsRoot.replaceChildren();root.hidden=labelsRoot.hidden=false;
  document.getElementById("phaseHud").hidden=true;
  const title=document.createElement("h2");title.textContent="showcase sandbox";root.appendChild(title);
  const nav=document.createElement("nav");nav.setAttribute("aria-label","showcase gallery sections");root.appendChild(nav);
  const wanted=new Set(["resources","buildings","towers","units","dummies","props","progress"]),handlers=[];
  for(const [id,section] of Object.entries(showcaseSections()))if(wanted.has(id)){
    const button=document.createElement("button"),handler=()=>{if(focusShowcaseSection(id))cameraChanged();};
    button.type="button";button.textContent=section.label;button.addEventListener("click",handler);handlers.push([button,handler]);nav.appendChild(button);
  }
  const actions=document.createElement("div");actions.className="showcase-actions";root.appendChild(actions);
  for(const [text,command] of [["reset dummies",resetDamageDummies],["reset props",resetShowcaseProps],["reset fixtures",rebuildShowcase]]){
    const button=document.createElement("button"),handler=runAndSync(command);button.type="button";button.textContent=text;button.addEventListener("click",handler);handlers.push([button,handler]);actions.appendChild(button);
  }
  const normal=document.createElement("a");normal.href=normalUrl();normal.textContent="return to normal run";actions.appendChild(normal);
  readout=document.createElement("output");readout.className="showcase-readout";readout.setAttribute("aria-live","polite");root.appendChild(readout);
  syncLabels();
  teardownCurrent=()=>{
    active=false;for(const [element,handler] of handlers)element.removeEventListener("click",handler);
    root.replaceChildren();labelsRoot.replaceChildren();root.hidden=labelsRoot.hidden=true;game.classList.remove("showcase-active");document.getElementById("phaseHud").hidden=false;
    labels=[];labelByKey.clear();labelsRevision=-1;readout=null;readoutText="";
  };
}

export function updateShowcaseUi(){
  if(!active)return;
  syncLabels();
  for(const item of labels){
    const {entity,height}=item.record,p=project(entity.x,entity.y,height||38),visible=Number.isFinite(p.depth)&&p.depth>=-1&&p.depth<=1&&p.x>=0&&p.x<=960&&p.y>=0&&p.y<=540;
    if(item.visible!==visible){item.element.hidden=!visible;item.visible=visible;}
    if(!visible)continue;
    const left=(p.x/9.6).toFixed(3)+"%",top=(p.y/5.4).toFixed(3)+"%";
    if(item.left!==left){item.element.style.left=left;item.left=left;}
    if(item.top!==top){item.element.style.top=top;item.top=top;}
  }
  const d=focusedDummyReadout(),text=d?(d.id+" · hp "+d.hp+"/"+d.max+" · last "+d.recentDamage+" · hits "+d.hitCount+(d.defeated?" · regenerating":"")):"hit a dummy to inspect damage";
  if(text!==readoutText){readout.textContent=text;readoutText=text;}
}

export function teardownShowcaseUi(){teardownCurrent();}
