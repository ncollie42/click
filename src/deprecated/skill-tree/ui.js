// DEPRECATED: Non-runnable source snapshot retained for a possible revisit.
// Its runtime hooks were deliberately removed. Read README.md before restoring this feature.
// Previously owned the skill-tree DOM, focus containment, inert state, and delegated listeners.
// Authored graph units map to one SVG viewBox and percentage-positioned node tiles.
import {
  // commands — the only writes this file can make into the world
  selectSkillNode, closeSkillTree,
  // queries — pure reads
  skillTreeNodes, skillTreeEdges, skillPoints
} from "../../game/simulation.js";
import {syncModalUi} from "../../ui/hud.js";

const SVG_NS="http://www.w3.org/2000/svg";
const panel=()=>document.getElementById("skillTreePanel");
let surface=null;
let returnFocus=null;
const focusable=element=>!!element&&element.isConnected&&!element.disabled&&element.getClientRects().length>0;

// Inert every sibling subtree except game-over while the full-stage modal owns input.
function setFrameInert(on){
  for(let node=panel();node?.parentElement&&node.id!=="game";node=node.parentElement)
    for(const other of node.parentElement.children)
      if(other!==node&&other.id!=="gameOver")other.toggleAttribute("inert",on);
}

function graphBounds(nodes){
  const xs=nodes.map(node=>node.x),ys=nodes.map(node=>node.y);
  const minX=Math.min(...xs),minY=Math.min(...ys);
  return {minX,minY,spanX:Math.max(...xs)-minX||1,spanY:Math.max(...ys)-minY||1};
}
const atX=(node,box)=>100*(node.x-box.minX)/box.spanX;
const atY=(node,box)=>100*(node.y-box.minY)/box.spanY;
const tileById=id=>document.querySelector('#skillTreeNodes [data-node-id="'+id+'"]');

// Presentation-only arrival history; runtime reveal membership stays in simulation.js.
const shownNodes=new Set(),shownEdges=new Set();
const edgeKey=edge=>edge.a<edge.b?edge.a+"|"+edge.b:edge.b+"|"+edge.a;

function renderSkillTree(){
  const nodes=skillTreeNodes(),box=graphBounds(nodes),visible=new Map(),points=skillPoints();
  document.getElementById("skillTreePoints").textContent=points+" point"+(points===1?"":"s")+" remaining";
  // Preserve focus by node ID across whole-layer replacement.
  const focusedId=document.activeElement?.closest(".skill-node")?.dataset.nodeId;
  for(const node of nodes)if(node.status!=="hidden")visible.set(node.id,node);
  document.getElementById("skillTreeGraph").style.setProperty("--graph-ratio",box.spanX/box.spanY);
  const arriving=new Set([...visible.keys()].filter(id=>!shownNodes.has(id)));

  const links=document.getElementById("skillTreeLinks");
  links.setAttribute("viewBox",[box.minX,box.minY,box.spanX,box.spanY].join(" "));
  const drawn=[];
  for(const edge of skillTreeEdges()){
    const a=visible.get(edge.a),b=visible.get(edge.b);
    if(!a||!b)continue;                                           // never a stub into empty space
    const line=document.createElementNS(SVG_NS,"line");
    line.setAttribute("x1",a.x);line.setAttribute("y1",a.y);
    line.setAttribute("x2",b.x);line.setAttribute("y2",b.y);
    line.setAttribute("vector-effect","non-scaling-stroke");
    if(a.status==="selected"&&b.status==="selected")line.classList.add("taken");
    const key=edgeKey(edge);
    if(!shownEdges.has(key)){
      shownEdges.add(key);line.classList.add("arriving");
      // Grow from the end already on screen toward the tile arriving at the other one; CSS puts the
      // origin in this segment's own box, whose corner is the lower x and the lower y of the pair.
      const from=arriving.has(a.id)&&!arriving.has(b.id)?b:a;
      line.style.transformOrigin=(from.x-Math.min(a.x,b.x))+"px "+(from.y-Math.min(a.y,b.y))+"px";
    }
    drawn.push(line);
  }
  links.replaceChildren(...drawn);

  const tiles=[];
  for(const node of nodes){
    if(node.status==="hidden")continue;
    const taken=node.status==="selected";
    const tile=document.createElement("button");
    tile.type="button";tile.className="skill-node "+node.status+(node.root?" root":"")+(arriving.has(node.id)?" arriving":"");
    tile.dataset.nodeId=node.id;                                  // the delegated click reads this
    tile.style.left=atX(node,box).toFixed(3)+"%";tile.style.top=atY(node,box).toFixed(3)+"%";
    // Taking a node is one-way and unrepeatable, so it is neither a toggle (aria-pressed) nor the
    // current item of a set (aria-current): aria-disabled is the true one, and unlike the `disabled`
    // property it leaves the tile reachable, so the name below can still be read back.
    const inert=taken||points===0;
    if(inert)tile.setAttribute("aria-disabled","true");
    if(!taken&&points===0)tile.classList.add("unaffordable");
    tile.title=node.name;tile.setAttribute("aria-label",node.name+(taken?" · taken":points===0?" · no skill points":""));
    // aria-hidden so a screen reader reads the name above rather than spelling the glyph out.
    const glyph=document.createElement("span");glyph.className="skill-glyph";glyph.textContent=node.icon;glyph.setAttribute("aria-hidden","true");
    tile.appendChild(glyph);tiles.push(tile);
  }
  document.getElementById("skillTreeNodes").replaceChildren(...tiles);
  for(const id of visible.keys())shownNodes.add(id);   // seen now; the next pass draws them plain
  if(focusedId)tileById(focusedId)?.focus();
}

export const SKILL_TREE_EFFECTS = {
  skillTreeOpened(){
    returnFocus=document.activeElement;                  // the opener, before anything below moves it
    setFrameInert(true);
    // Repaint before unhiding, so the panel never shows the previous open's tiles for a frame.
    renderSkillTree();panel().classList.remove("hidden");syncModalUi();
    // Open on the choice rather than on the way out: the first tile still available, wherever it
    // falls in the order. Continue is the fallback only if none is left.
    (panel().querySelector('.skill-node:not([aria-disabled])')||document.getElementById("skillTreeContinue")).focus();
  },
  skillTreeChanged(){renderSkillTree();},
  skillTreeClosed(){
    panel().classList.add("hidden");syncModalUi();setFrameInert(false);
    // Hiding does not hand focus back for us: activeElement is still the stop inside the panel that
    // just went display:none, and focusing THAT is a silent no-op. Try the opener, then CHECK — a
    // refused focus() is silent too. Whatever the reason — no opener, an opener that was <body>,
    // focus still stranded in the hidden panel — the pointer surface main.js handed in takes it.
    if(focusable(returnFocus))returnFocus.focus();
    const landed=document.activeElement;
    if(!landed||landed===document.body||panel().contains(landed))surface.focus();
    returnFocus=null;
  },
};

// Inert handles the frame; this closes Tab traversal inside the panel.
function onPanelKeydown(event){
  if(event.key!=="Tab")return;
  const stops=panel().querySelectorAll("button"),first=stops[0],last=stops[stops.length-1],at=document.activeElement;
  if(at!==panel()&&at!==(event.shiftKey?first:last))return;
  event.preventDefault();(event.shiftKey?last:first).focus();
}

export function initSkillTree(pointerSurface){
  surface = pointerSurface;
  document.getElementById("skillTreeNodes").addEventListener("click",event=>{
    const tile=event.target.closest(".skill-node");
    // Simulation remains authoritative; aria-disabled makes the zero-point refusal honest visually.
    if(tile&&!tile.matches('[aria-disabled="true"]'))selectSkillNode(tile.dataset.nodeId);
  });
  document.getElementById("skillTreeContinue").addEventListener("click",()=>{closeSkillTree();});
  panel().addEventListener("keydown",onPanelKeydown);
  // A press on the panel's own background has no focusable ancestor but the panel: focus it there
  // rather than let focus fall to <body>.
  panel().addEventListener("pointerdown",event=>{if(!event.target.closest("button"))panel().focus();});
}
