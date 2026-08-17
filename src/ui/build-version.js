// Owns the tiny build fingerprint shown in the game frame. It hashes the runtime module graph and
// styles actually served to the browser, so static deployments get a useful version without a
// bundler or a generated Git file. A future deploy pipeline may override it with meta[name=git-commit].
const IMPORT_SPECIFIER=/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;

async function collectAsset(url,assets,seen){
  const key=url.href;if(seen.has(key))return;seen.add(key);
  const response=await fetch(url);
  if(!response.ok)throw new Error(`version asset ${url.pathname}: ${response.status}`);
  const source=await response.text();assets.push([url.pathname,source]);
  if(!url.pathname.endsWith(".js"))return;
  for(const match of source.matchAll(IMPORT_SPECIFIER)){
    const specifier=match[1];
    if(!specifier.startsWith(".")&&!specifier.startsWith("/"))continue;
    const dependency=new URL(specifier,url);
    if(dependency.origin===location.origin)await collectAsset(dependency,assets,seen);
  }
}

async function contentFingerprint(){
  const assets=[],seen=new Set(),root=new URL("../../",import.meta.url);
  await collectAsset(new URL("index.html",root),assets,seen);
  await collectAsset(new URL("styles.css",root),assets,seen);
  await collectAsset(new URL("src/ui/motion.css",root),assets,seen);
  await collectAsset(new URL("vendor/three.module.min.js",root),assets,seen);
  await collectAsset(new URL("src/main.js",root),assets,seen);
  assets.sort(([a],[b])=>a.localeCompare(b));
  const payload=assets.map(([path,source])=>path+"\n"+source).join("\n");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}

export async function initBuildVersion(){
  const output=document.getElementById("buildVersion");if(!output)return;
  const commit=document.querySelector('meta[name="git-commit"]')?.content.trim();
  try{
    const version=commit||await contentFingerprint();
    output.textContent="build "+version;
    output.title=commit?"Git commit "+commit:"SHA-256 fingerprint of the served game files";
  }catch(error){
    output.textContent="build local";
    output.title="Build fingerprint unavailable: "+error.message;
  }
}
