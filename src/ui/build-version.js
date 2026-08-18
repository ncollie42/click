// Owns the manually authored game version shown in the frame. Increment GAME_VERSION when preparing
// a release; it deliberately has no coupling to Git commits, deployment metadata, or asset hashes.
export const GAME_VERSION="0.0.3";

export function initBuildVersion(){
  const output=document.getElementById("buildVersion");if(!output)return;
  output.textContent="version "+GAME_VERSION;
  output.title="Wooddrop version "+GAME_VERSION;
}
