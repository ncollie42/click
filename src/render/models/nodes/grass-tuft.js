// Owns: the legacy grass tuft geometry (map editor preview + any single InstancedMesh user).
import * as THREE from "three";

// Shared by scene.js's single InstancedMesh: three crossed blade clusters form one readable
// Clickyland-style black-green tuft without allocating one object/material per vegetation cell.
export function makeGrassTuftGeometry(){
  const positions=[];
  const triangle=(a,b,c)=>positions.push(...a,...b,...c);
  for(const [x,z,h,w] of [[-.28,.08,.62,.16],[.08,-.12,.78,.18],[.3,.14,.52,.14]]){
    triangle([x-w,0,z],[x+w,0,z],[x,h,z]);
    triangle([x,0,z-w],[x,0,z+w],[x,h,z]);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();geometry.computeBoundingSphere();return geometry;
}
