// Owns: the DOM skill-tree panel — its connector SVG, its node tiles, its open/closed class, the
// `inert` it hangs on the rest of the frame while it is up, and the listeners inside it. Owns no
// gameplay state and no markup outside #skillTreePanel.
// ═══════════════════════════════════════════════════════════════════════════
// SKILL TREE ADAPTER
// A read-only projection of the authored graph, exactly like the render layer is one of the world:
// everything on screen comes from two simulation queries, and this file never touches
// skill-tree-data.js and never writes `state`.
//
// Ownership / data flow
//   Reads:    src/game/simulation.js through skillTreeNodes() / skillTreeEdges(), which hand back
//             FRESH records over the frozen graph. Read-only by contract: project them, never assign
//             into them, never reach past them to SKILL_NODES — the query is the whole interface.
//   Writes:   the DOM only — the children of #skillTreeLinks and #skillTreeNodes, the graph box's
//             --graph-ratio, the `hidden` class on #skillTreePanel, `inert` on the rest of the
//             frame while the panel is up (setFrameInert, below, names the one exception), and
//             focus, including one move made AFTER the panel is hidden again. Every gameplay change
//             this file causes goes through a COMMAND (selectSkillNode, closeSkillTree); there is no
//             other way out of here into the world.
//   Asks:     syncModalUi() from src/ui/hud.js — `.modal-open` on #game answers for both modals and
//             the HUD owns that class, so this panel re-runs the HUD's toggle rather than forking
//             it. The dependency runs skill-tree -> hud and never back.
//   Supplies: SKILL_TREE_EFFECTS — this panel's half of the simulation's effect record, merged with
//             the HUD's half by main.js. Same invariant as the HUD's: every hook is a pure sink over
//             state the simulation already changed, and none of them calls a command.
//             initSkillTree(surface) — the listener registration, called once by main.js, which
//             also hands over the pointer surface this file may need to park focus on.
//
// The open flag is the SIMULATION's (state.skillTree.open), not this panel's class: a modal that
// suppresses world input is gameplay state, and modalOpen() answers for it without importing this
// file. The class here only mirrors it.
//
// Layout: node coordinates are AUTHORED graph units (see skill-tree-data.js), mapped here rather
// than by a per-id CSS rule — re-authoring the graph must never mean editing a stylesheet. ONE
// mapping written two ways over the same bounding box: the SVG takes the box as its viewBox, the
// tiles take it normalised to 0..100 as `%`. CSS gets one number, that box's unitless ratio, which
// styles.css contain-fits into the band, so nothing here re-runs on a resize.
// ═══════════════════════════════════════════════════════════════════════════
import {
  // commands — the only writes this file can make into the world
  selectSkillNode, closeSkillTree,
  // queries — pure reads
  skillTreeNodes, skillTreeEdges
} from "../game/simulation.js";
import {syncModalUi} from "./hud.js";

const SVG_NS="http://www.w3.org/2000/svg";
const panel=()=>document.getElementById("skillTreePanel");
// The pointer surface (<canvas id="overlay">) — handed in by main.js at init, exactly as the HUD
// gets it, so this file never looks the element up and its owners stay at the documented three.
// The one thing done to it here: take focus, when closing has nowhere better to put it.
let surface=null;
// Whatever had focus when the panel opened, so closing can hand it back. Module-private: an
// importer cannot reassign an imported binding.
let returnFocus=null;
// focus() on a detached, unrendered or disabled element is a silent no-op, so a restore target may
// be none of those — getClientRects() rules out the first two at once.
const focusable=element=>!!element&&element.isConnected&&!element.disabled&&element.getClientRects().length>0;

// ── the rest of the frame, switched off ─────────────────────────────────────
// `inert` over every subtree of #game that is not this panel: no focus, no clicks, no a11y node, so
// a Tab cannot reach the HUD from any starting point, <body> included. It walks UP from the panel,
// so the levels above #stage (the build dock) are covered too, and spares #gameOver — the one layer
// allowed over this panel (see the stack in styles.css). DOM-level only: a listener on `window`
// still fires, which is why input.js and view-debugger.js check the flag themselves.
function setFrameInert(on){
  for(let node=panel();node?.parentElement&&node.id!=="game";node=node.parentElement)
    for(const other of node.parentElement.children)
      if(other!==node&&other.id!=="gameOver")other.toggleAttribute("inert",on);
}

// Over EVERY authored node, hidden ones included, so revealing one slides nothing already on
// screen: the frame belongs to the graph, not to this run. Degenerate spans fall back to 1.
function graphBounds(nodes){
  const xs=nodes.map(node=>node.x),ys=nodes.map(node=>node.y);
  const minX=Math.min(...xs),minY=Math.min(...ys);
  return {minX,minY,spanX:Math.max(...xs)-minX||1,spanY:Math.max(...ys)-minY||1};
}
const atX=(node,box)=>100*(node.x-box.minX)/box.spanX;
const atY=(node,box)=>100*(node.y-box.minY)/box.spanY;
const tileById=id=>document.querySelector('#skillTreeNodes [data-node-id="'+id+'"]');

// ── what this panel has already drawn ───────────────────────────────────────
// Presentation state: has the player SEEN this yet, never has the run revealed it — that second
// question is state.skillTree's and stays in the simulation, which holds no animation state. A key
// missing when the pass below builds an element is the whole condition for the arrival class, and
// the pass records it as it goes, so the next repaint builds the same tile plain. Neither set is
// ever cleared, so a re-open replays nothing; a resize repaints nothing at all, so nor does that.
const shownNodes=new Set(),shownEdges=new Set();
const edgeKey=edge=>edge.a<edge.b?edge.a+"|"+edge.b:edge.b+"|"+edge.a;

// One full repaint from the queries. Nothing incremental: both layers are replaced wholesale, so
// the DOM cannot drift out of step with the two id sets the simulation owns.
function renderSkillTree(){
  const nodes=skillTreeNodes(),box=graphBounds(nodes),visible=new Map();
  // replaceChildren() destroys the tile the keyboard is standing on, dropping focus to <body>.
  // Carry it across by id — the node itself outlives its element.
  const focusedId=document.activeElement?.closest(".skill-node")?.dataset.nodeId;
  for(const node of nodes)if(node.status!=="hidden")visible.set(node.id,node);
  document.getElementById("skillTreeGraph").style.setProperty("--graph-ratio",box.spanX/box.spanY);
  // Asked once, before either layer is built, from the set as it stood at the top of the pass.
  const arriving=new Set([...visible.keys()].filter(id=>!shownNodes.has(id)));

  // ── connector layer ───────────────────────────────────────────────────────
  // Produced and destroyed HERE and nowhere else: replaceChildren() drops every <line> the previous
  // pass made, so no connector outlives the state that justified it. Lines are drawn in AUTHORED
  // units — the viewBox IS the bounding box — and strokes opt out of that scale, so one weight
  // at every frame size.
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

  // ── node layer ────────────────────────────────────────────────────────────
  // Same rule, and a hidden node produces NO element: absent from layout, focus order and a11y tree.
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
    if(taken)tile.setAttribute("aria-disabled","true");
    tile.title=node.name;tile.setAttribute("aria-label",node.name+(taken?" · taken":""));
    // aria-hidden so a screen reader reads the name above rather than spelling the glyph out.
    const glyph=document.createElement("span");glyph.className="skill-glyph";glyph.textContent=node.icon;glyph.setAttribute("aria-hidden","true");
    tile.appendChild(glyph);tiles.push(tile);
  }
  document.getElementById("skillTreeNodes").replaceChildren(...tiles);
  for(const id of visible.keys())shownNodes.add(id);   // seen now; the next pass draws them plain
  if(focusedId)tileById(focusedId)?.focus();
}

// ── effect implementations handed to the simulation ─────────────────────────
// The names here are the simulation's, one for one; main.js merges this record into the HUD's and
// hands the result to connect(). Nothing in it reaches back into a command.
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

// ── focus containment ───────────────────────────────────────────────────────
// setFrameInert() is what keeps focus off the HUD; this only closes the ring, so Tab off either end
// comes back to the panel's other end rather than out through the browser's own chrome. The panel
// itself (tabindex=-1, where a background press lands) wraps too; between the ends, browser order.
function onPanelKeydown(event){
  if(event.key!=="Tab")return;
  const stops=panel().querySelectorAll("button"),first=stops[0],last=stops[stops.length-1],at=document.activeElement;
  if(at!==panel()&&at!==(event.shiftKey?first:last))return;
  event.preventDefault();(event.shiftKey?last:first).focus();
}

// ── registration ────────────────────────────────────────────────────────────
// Every listener this adapter owns, in one auditable list. Called once, by main.js. All four sit on
// elements that outlive every repaint, so no handler is ever left behind on a replaced tile.
export function initSkillTree(pointerSurface){
  surface = pointerSurface;
  document.getElementById("skillTreeNodes").addEventListener("click",event=>{
    const tile=event.target.closest(".skill-node");
    // Unconditional: selectSkillNode() refuses a taken id silently, which is the same answer the
    // aria-disabled tile gives, so the two can never disagree about what a click does.
    if(tile)selectSkillNode(tile.dataset.nodeId);
  });
  document.getElementById("skillTreeContinue").addEventListener("click",()=>{closeSkillTree();});
  panel().addEventListener("keydown",onPanelKeydown);
  // A press on the panel's own background has no focusable ancestor but the panel: focus it there
  // rather than let focus fall to <body>.
  panel().addEventListener("pointerdown",event=>{if(!event.target.closest("button"))panel().focus();});
}
