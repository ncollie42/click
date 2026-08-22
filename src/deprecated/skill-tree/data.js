// DEPRECATED: Disabled feature; not a production entrypoint. Retained for a possible revisit.
// Owns the frozen authored skill graph and validates it at import.
// Coordinates are historical graph units, not world pixels. No active runtime imports this module.
export const SKILL_POINT_LEVELS=4; // Historical placeholder cadence.

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

// Undirected edges are authored separately; alpha2b—beta2 intentionally makes this a graph.
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

// Validate IDs, root, edge integrity, and reachability before exporting authored data.
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

const PROBLEMS=validateSkillTree({nodes:NODES,edges:EDGES});
if(PROBLEMS.length)throw new Error("deprecated skill-tree data: "+PROBLEMS.join("; "));

export const SKILL_NODES=Object.freeze(NODES.map(node=>Object.freeze({...node})));
export const SKILL_EDGES=Object.freeze(EDGES.map(edge=>Object.freeze({...edge})));
export const SKILL_TREE_ROOT_ID=SKILL_NODES.find(node=>node.root).id;
// Null-prototype lookups make arbitrary IDs read undefined rather than inherited properties.
const byId=Object.create(null),neighbours=Object.create(null);
for(const node of SKILL_NODES){
  byId[node.id]=node;
  neighbours[node.id]=Object.freeze(SKILL_EDGES.filter(edge=>edge.a===node.id||edge.b===node.id).map(edge=>edge.a===node.id?edge.b:edge.a));
}
export const SKILL_NODES_BY_ID=Object.freeze(byId);
export const SKILL_NEIGHBORS=Object.freeze(neighbours);
