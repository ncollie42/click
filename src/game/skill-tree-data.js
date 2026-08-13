// Owns: the authored skill graph — node records, the undirected edge list, and the integrity rules
// they must satisfy. Leaf module — imports nothing, and owns no run state.
// ═══════════════════════════════════════════════════════════════════════════
// AUTHORED SKILL TREE
// THE single source for the skill graph's SHAPE: every node's stable id, its
// placeholder name and glyph, its authored graph coordinates, and the edges
// that connect them. Nothing here knows what a skill DOES — nodes carry no cost,
// no stat and no effect, on purpose, so the graph can be re-authored freely
// without touching a single gameplay rule.
//
// Ownership / data flow
//   Written by: nobody. Every value is authored, frozen, and may only change by
//               editing this file. No debug flag, no view panel binding and no
//               simulation path may assign into these records — the same rule
//               data.js states, restated here because this module is its sibling.
//   Read by:    simulation.js, which owns WHICH nodes a run has revealed or
//               selected (state.skillTree) and never writes back into the graph,
//               and — through the simulation's queries only — the UI layer.
//   Imports:    none, deliberately. This module must stay a leaf so nothing can
//               create an import cycle through it. It never touches `document`,
//               `window`, THREE, the canvas, or any mutable run state.
//
// Anything a run can CHANGE deliberately does not live here: revealed/selected
// membership is run state and belongs to simulation.js, exactly like resources
// and buildings do. This file only ever answers "what does the tree look like".
// ═══════════════════════════════════════════════════════════════════════════

// ── node records ────────────────────────────────────────────────────────────
// Format: {id,name,icon,x,y}, plus `root:true` on exactly ONE node.
//   id     stable and unique; the UI, the run state sets and any later save data
//          all key off it, so an id is never reused for a different node.
//   name   the short display string, placeholder for now — the same field the
//          building / upgrade / tower tables in data.js carry.
//   icon   one glyph, the same convention UPGRADES / TOWER_VARIANTS use.
//   x,y    authored GRAPH coordinates — not world pixels and not screen pixels.
//          The root sits at the origin, +x runs right, +y runs OUTWARD (deeper),
//          and a depth is 1.5 units down. Whoever draws the tree scales and pans
//          them, so retuning the layout can never move a building, a tower or
//          anything else measured in simulation pixels. The set is authored to an
//          exactly 2:1 bounding box, with the root centred across it and sitting
//          on the TOP edge (y:0 is minY). The drawer scales that box UNIFORMLY
//          into the graph band, which runs about 2.2:1 on a narrow frame and
//          tends toward 16:9 on a wide one. The contain fit turns over at a band
//          ratio of 1.78, so at every size the frame reaches the box fits to the
//          band's HEIGHT and the spare width shows as even margins down both
//          sides; a squarer box would leave more of them empty.
// Naming: <branch><depth><sibling>. The digit is the authored hop count from the
// root, which is also the reveal depth — handy while the names are placeholders.
const NODES=[
  {id:"root",name:"origin",icon:"✦",x:0,y:0,root:true},
  // depth 1 — the three branches that leave the root, thrown wide apart
  {id:"alpha1",name:"alpha path",icon:"◈",x:-3.2,y:1.5},
  {id:"beta1",name:"beta path",icon:"◆",x:0,y:1.6},
  {id:"gamma1",name:"gamma path",icon:"◇",x:3.4,y:1.5},
  // depth 2 — each branch forks (gamma2b and, later, gamma3 are deliberate dead ends)
  {id:"alpha2a",name:"alpha fork",icon:"◐",x:-5,y:3},
  {id:"alpha2b",name:"alpha spur",icon:"◑",x:-2,y:3.1},
  {id:"beta2",name:"beta fork",icon:"◒",x:.3,y:3.2},
  {id:"gamma2a",name:"gamma fork",icon:"◓",x:2.9,y:3.1},
  {id:"gamma2b",name:"gamma spur",icon:"◔",x:6.2,y:2.9},   // the right edge of the box
  // depth 3
  {id:"alpha3a",name:"alpha crown",icon:"▲",x:-5.9,y:4.5},
  {id:"alpha3b",name:"alpha ridge",icon:"△",x:-2.4,y:4.7},
  {id:"beta3",name:"beta crown",icon:"▼",x:.6,y:4.8},
  {id:"gamma3",name:"gamma crown",icon:"▶",x:3.4,y:4.6},
  // depth 4 — two long tips, so reveal has more than a token number of rings to walk
  {id:"alpha4",name:"alpha apex",icon:"★",x:-6.2,y:6},     // the left edge of the box
  {id:"beta4",name:"beta apex",icon:"☆",x:1,y:6.2}         // the deepest row, and the bottom edge
];

// ── edges ───────────────────────────────────────────────────────────────────
// Authored SEPARATELY from the nodes so no node encodes its own topology: one
// list to read when the shape is in question, and adding a link never means
// editing two records that could then disagree.
// UNDIRECTED: {a,b} and {b,a} name the same edge and only one of them is ever
// written. Reveal walks an edge in both directions (see SKILL_NEIGHBORS below),
// so "nearby" always means the same thing from either end.
// The graph is a graph, not a tree: alpha2b—beta2 is a cross-link between two
// depth-2 nodes on different branches, which is exactly the case that would
// break a parent/child model.
const EDGES=[
  {a:"root",b:"alpha1"},{a:"root",b:"beta1"},{a:"root",b:"gamma1"},
  {a:"alpha1",b:"alpha2a"},{a:"alpha1",b:"alpha2b"},
  {a:"beta1",b:"beta2"},
  {a:"gamma1",b:"gamma2a"},{a:"gamma1",b:"gamma2b"},
  {a:"alpha2b",b:"beta2"},                                   // the cross-link
  {a:"alpha2a",b:"alpha3a"},{a:"alpha2b",b:"alpha3b"},
  {a:"beta2",b:"beta3"},
  {a:"gamma2a",b:"gamma3"},
  {a:"alpha3a",b:"alpha4"},
  {a:"beta3",b:"beta4"}
];

/**
 * Graph integrity, as a PURE function over any {nodes,edges} pair — it reads no
 * module state, so the real graph and a hand-made broken one are checked by the
 * identical code. Returns a (possibly empty) array of problem strings rather
 * than throwing, so the gate below can report all of them at once. Not exported:
 * that gate is the only caller, and the rest of the repo sees only the result.
 *
 * The five rules, each of which would silently break reveal:
 *   * every node has a unique, non-empty string id      (lookups must be single)
 *   * exactly one node with a usable id is flagged root (the one starting point)
 *   * both endpoints of every edge name a real node     (no dangling neighbour)
 *   * no self-edge and no duplicate edge                (a node is not its own
 *                                                        neighbour; a link is
 *                                                        authored exactly once)
 *   * every node is reachable from the root             (reveal only ever walks
 *                                                        outward along edges)
 */
function validateSkillTree(graph){
  const problems=[],nodes=graph?.nodes||[],edges=graph?.edges||[],ids=new Set(),near=new Map();
  for(const node of nodes){
    const id=node?.id;
    if(typeof id!=="string"||!id){problems.push("node with no usable id");continue;}
    if(ids.has(id))problems.push("duplicate node id: "+id);
    ids.add(id);near.set(id,[]);
  }
  const roots=nodes.filter(node=>typeof node?.id==="string"&&node.id&&node.root);
  if(roots.length!==1)problems.push("expected exactly one node with a usable id flagged root, found "+roots.length);
  const seen=new Set();
  for(const edge of edges){
    const a=edge?.a,b=edge?.b;
    if(!ids.has(a)||!ids.has(b)){problems.push("edge endpoint is not a node: "+a+" - "+b);continue;}
    if(a===b){problems.push("self edge: "+a);continue;}
    const key=a<b?a+"|"+b:b+"|"+a;                           // unordered, because edges are undirected
    if(seen.has(key)){problems.push("duplicate edge: "+key);continue;}
    seen.add(key);near.get(a).push(b);near.get(b).push(a);
  }
  // Reachability, over the edges that survived the rules above. Reveal starts at the root and only
  // ever steps along an edge, so a node no chain reaches can never be shown — an island, or a root
  // whose own edges were deleted, is a graph that imports clean and then never grows.
  if(roots.length===1){
    const reached=new Set([roots[0].id]);
    for(let frontier=[roots[0].id];frontier.length;){
      const next=[];
      for(const id of frontier)for(const other of near.get(id))if(!reached.has(other)){reached.add(other);next.push(other);}
      frontier=next;
    }
    for(const id of ids)if(!reached.has(id))problems.push("unreachable from root: "+id);
  }
  return problems;
}

// Init-time gate: an authored mistake fails the import, loudly, instead of shipping a graph the
// reveal walk cannot use — a dangling neighbour, two starting points, or a branch nothing reaches.
const PROBLEMS=validateSkillTree({nodes:NODES,edges:EDGES});
if(PROBLEMS.length)throw new Error("skill-tree-data.js: "+PROBLEMS.join("; "));

// ── the frozen exports ──────────────────────────────────────────────────────
// Everything below is deep-frozen: the arrays reject push/splice and the records
// reject assignment (modules are strict mode, so a write THROWS rather than
// passing silently). The read-only contract is therefore enforced here, not just
// documented, and the simulation's projections hand out copies on top of that.
export const SKILL_NODES=Object.freeze(NODES.map(node=>Object.freeze({...node})));
export const SKILL_EDGES=Object.freeze(EDGES.map(edge=>Object.freeze({...edge})));
/** The one node a fresh run starts on, derived from the flag validate() just proved is single. */
export const SKILL_TREE_ROOT_ID=SKILL_NODES.find(node=>node.root).id;
// Both lookups below are null-prototype: an id that is not a node reads as `undefined` and NOT as
// something inherited from Object.prototype, so a caller testing `SKILL_NODES_BY_ID[id]` can never
// be fooled by "constructor" or "__proto__" into treating a string as a node.
const byId=Object.create(null),neighbours=Object.create(null);
for(const node of SKILL_NODES){
  byId[node.id]=node;
  neighbours[node.id]=Object.freeze(SKILL_EDGES.filter(edge=>edge.a===node.id||edge.b===node.id).map(edge=>edge.a===node.id?edge.b:edge.a));
}
/** id -> node record. THE lookup; nothing else may scan SKILL_NODES to resolve an id. */
export const SKILL_NODES_BY_ID=Object.freeze(byId);
/** id -> its immediate neighbours, both directions of every edge folded in. THE adjacency
 *  answer, so reveal never re-derives "nearby" from coordinates or from an edge's direction. */
export const SKILL_NEIGHBORS=Object.freeze(neighbours);
