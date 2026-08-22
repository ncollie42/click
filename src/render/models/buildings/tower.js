// Owns: the tower building body. build(g, add) hangs parts via add() and may set
// userData hooks; buildings/index.js adds the footprint pad, parts list and static bake after.
// userData contract: userData.roof (variant accent target).
import * as THREE from "three";
import {PAL} from "../../palette.js";
import {flat, meshOf, FLOOR_TOP} from "../kit.js";

export function build(g, add){
  // The basic chassis owns the silhouette shared by every permanent tower variant. Keep it
  // weaponless: variants tint the roof through userData.roof, while gameplay/VFX remain separate.
  const beam = (a,b,width,color=PAL.timberDark)=>{
    const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),delta=to.clone().sub(from);
    const m=add(meshOf(new THREE.BoxGeometry(width,delta.length(),width),flat(color)));
    m.position.copy(from).add(to).multiplyScalar(.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
    return m;
  };

  // Uneven local stone course: low enough to read as hand-set footings rather than a stone tower.
  const stones=[
    [-1.05,-1.20,.72,.40,.54,-.03],[-.32,-1.18,.68,.34,.52,.02],[.38,-1.21,.70,.42,.56,-.02],[1.09,-1.18,.66,.36,.50,.03],
    [-1.08, 1.19,.68,.35,.52,.02],[-.38, 1.21,.70,.41,.55,-.03],[.35, 1.18,.66,.36,.50,.02],[1.05, 1.20,.74,.40,.54,-.02],
    [-1.22,-.42,.52,.38,.70,.02],[-1.19,.36,.54,.34,.68,-.03],[1.20,-.38,.50,.36,.72,-.02],[1.22,.38,.54,.40,.68,.03],
  ];
  stones.forEach(([x,z,w,h,d,turn],i)=>{
    const stone=add(meshOf(new THREE.BoxGeometry(w,h,d),flat(i%3===1?PAL.rockDark:PAL.rock)));
    stone.position.set(x,FLOOR_TOP+h/2,z);stone.rotation.y=turn;
  });

  // Four wide-set, slightly irregular legs; crossed beams carry the load on every face.
  const legs=[[-1.02,-1.01,.28,.31,-.018],[1.00,-1.03,.31,.28,.014],[-1.04,1.02,.29,.32,.012],[1.03,1.00,.30,.29,-.016]];
  for(const [x,z,w,d,lean] of legs){
    const leg=add(meshOf(new THREE.BoxGeometry(w,2.82,d),flat(PAL.timber)));
    leg.position.set(x,1.72,z);leg.rotation.z=lean;
  }
  for(const z of [-1.02,1.02]){
    beam([-.94,.55,z],[.94,2.72,z],.15);
    beam([.94,.55,z],[-.94,2.72,z],.15);
  }
  for(const x of [-1.02,1.02]){
    beam([x,.55,-.94],[x,2.72,.94],.15);
    beam([x,.55,.94],[x,2.72,-.94],.15);
  }

  // Chunky under-frame plus individual deck planks keep the open platform readable from above.
  for(const z of [-1.14,1.14]){
    const frame=add(meshOf(new THREE.BoxGeometry(2.70,.24,.24),flat(PAL.timberDark)));
    frame.position.set(0,2.98,z);
  }
  for(let i=0;i<6;i++){
    const plank=add(meshOf(new THREE.BoxGeometry(.40,.16,2.58),flat(i%2?PAL.timber:PAL.timberDark)));
    plank.position.set((i-2.5)*.42,3.16+(i%3===0?.015:0),0);
  }

  // Roof posts double as railing uprights. The ladder-facing (+Z) rail has a central opening.
  for(const [x,z] of [[-1.23,-1.23],[1.23,-1.23],[-1.23,1.23],[1.23,1.23]]){
    const post=add(meshOf(new THREE.BoxGeometry(.18,1.18,.18),flat(PAL.timber)));
    post.position.set(x,3.76,z);
  }
  const rail=(w,d,x,z)=>{
    const m=add(meshOf(new THREE.BoxGeometry(w,.16,d),flat(PAL.timber)));
    m.position.set(x,3.62,z);
  };
  rail(2.30,.14,0,-1.23);rail(.14,2.30,-1.23,0);rail(.14,2.30,1.23,0);
  rail(.72,.14,-.82,1.23);rail(.72,.14,.82,1.23);

  // One solid low-poly gable keeps the variant-accent contract as a single material target.
  const roofGeo=new THREE.BufferGeometry();
  const roofVertices=[
    -1.52,4.27,-1.34, -1.52,5.02,0, -1.52,4.27,1.34,
     1.52,4.27,-1.34,  1.52,4.27,1.34,  1.52,5.02,0,
    -1.52,4.27,-1.34,  1.52,4.27,-1.34,  1.52,5.02,0,
    -1.52,4.27,-1.34,  1.52,5.02,0,    -1.52,5.02,0,
    -1.52,4.27,1.34,  -1.52,5.02,0,     1.52,5.02,0,
    -1.52,4.27,1.34,   1.52,5.02,0,     1.52,4.27,1.34,
    -1.52,4.27,-1.34, -1.52,4.27,1.34,  1.52,4.27,1.34,
    -1.52,4.27,-1.34,  1.52,4.27,1.34,  1.52,4.27,-1.34,
  ];
  roofGeo.setAttribute("position",new THREE.Float32BufferAttribute(roofVertices,3));
  // Non-indexed triangles keep normals split at every ridge/eave for hard low-poly facets.
  roofGeo.computeVertexNormals();
  const roof=add(meshOf(roofGeo,flat(PAL.timberDark)));
  g.userData.roof=roof;

  // Ladder leans against the open side and terminates at the deck opening, not through a rail.
  beam([-.35,.30,1.60],[-.35,3.30,1.34],.12,PAL.timber);
  beam([.35,.30,1.60],[.35,3.30,1.34],.12,PAL.timber);
  for(let i=0;i<7;i++){
    const t=(i+1)/8,y=.30+(3.30-.30)*t,z=1.60+(1.34-1.60)*t;
    beam([-.38,y,z],[.38,y,z],.10,PAL.timberDark);
  }
}
