// Owns: the five props on the reference's diagonal — four spheres and one rotated box.
// Each one is sunk into the meadow by a fraction of its own diameter (preset.OBJECTS[].sink), so
// what the camera sees is a dome with the ground line cutting it, exactly like the reference.
//
// ROUND 3 REVERSAL — the spheres are SMOOTH now, and this is the fix for CRITIC-R2 item 5.
// Rounds 1-2 built them flat-faceted (toNonIndexed + computeVertexNormals, 14x9 segments) on the
// reading that the reference's domes show "angular wedges". They do not: blown up 3x, the
// reference's bands have CURVED edges that follow the sphere's latitude — they are the OKLab
// posterizer's bands over a smooth gradient, not polygons. Building real polygons on top of a
// posterizer gave the white dome 24 distinct core values and a black ink line on every quad seam
// (pixel.js's normal-edge pass reads a per-face normal buffer and a 5-deg facet step clears any
// usable normalThreshold), i.e. the golf ball. Smooth normals put the banding back where the
// reference has it — in the quantizer — and the edge passes go quiet on the interior while
// depthEdge still inks the silhouette.
//
// ROUND 5 — the props' material is now BANDED AT THE MATERIAL STAGE when preset.TOON.enabled &&
// preset.TOON.props. scene.js owns the shared gradient map (built once from preset.TOON) and hands
// it in; this file only chooses toon-vs-Lambert per prop. Everything else — geometry, sink,
// shadows — is identical either way, so ?toon=0 is a clean A/B of the transfer function alone.
//
// Data flow in: preset.OBJECTS + terrain.heightAt (ground contact) + the gradient map from
// scene.js. Out: meshes for scene.js.

import {heightAt} from "./terrain.js";
import {makeToonMaterial} from "../../src/render/toon-ramp.js";

// Enough segments that the silhouette is round at a 283x157 render buffer (one texel is ~5.5
// output px, and a dome is ~40 texels across) and that the smooth normals never staircase.
const SPHERE_SEGMENTS = [48, 32];

export function buildObjects(THREE, {seed, terrain, objects, gradientMap = null}){
  const meshes = [], owned = [];
  for(const spec of objects){
    const ground = heightAt(spec.x, spec.z, seed, terrain);
    let geo, centerY;
    if(spec.kind === "sphere"){
      // SphereGeometry's own normals are the exact analytic ones — do NOT call
      // computeVertexNormals() here, and do NOT toNonIndexed(): either would re-derive them per
      // face and bring the facets (and their ink) straight back.
      geo = new THREE.SphereGeometry(spec.r, SPHERE_SEGMENTS[0], SPHERE_SEGMENTS[1]);
      // sink = fraction of the DIAMETER below the ground line, so 0.5 = equator on the ground.
      centerY = ground + spec.r * (1 - 2 * spec.sink);
    }else{
      geo = new THREE.BoxGeometry(spec.size[0], spec.size[1], spec.size[2]);
      centerY = ground + spec.size[1] * (0.5 - spec.sink);
    }
    const mat = gradientMap
      ? makeToonMaterial(THREE, {color: spec.color, gradientMap})
      : new THREE.MeshLambertMaterial({color: spec.color});
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `test-scene:${spec.name}`;
    mesh.position.set(spec.x, centerY, spec.z);
    if(spec.rot) mesh.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);
    owned.push(geo, mat);
  }
  return {
    meshes,
    dispose(){ for(const o of owned) o.dispose(); },
  };
}
