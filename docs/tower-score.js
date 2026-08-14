// Owns the catalog's deliberately simple tower-power estimate; gameplay never reads this score.
// Add future mechanics as explicit weighted terms so the score remains auditable instead of hiding
// balance assumptions in tower tags or presentation code.

export const TOWER_SCORE_FORMULA=Object.freeze({
  damagePerSecond:10,
  maxHp:.5,
});

/**
 * Baseline power = 10 × damage × attacks/second + 0.5 × HP + explicit future terms.
 * `extraPoints` is keyed so future contributors (range, expected targets, status utility, etc.)
 * remain visible in the returned breakdown rather than becoming one unexplained multiplier.
 */
function scoreCombatStats({damage=0,cooldown=1,maxHp=0},extraPoints={}){
  const damagePerSecond=damage/cooldown;
  const terms={
    damagePerSecond:damagePerSecond*TOWER_SCORE_FORMULA.damagePerSecond,
    maxHp:maxHp*TOWER_SCORE_FORMULA.maxHp,
    ...extraPoints,
  };
  const total=Object.values(terms).reduce((sum,value)=>sum+value,0);
  return {score:Math.round(total),rawScore:total,damagePerSecond,terms};
}

export function scoreTower(tower,extraPoints={}){
  return scoreCombatStats(tower,extraPoints);
}

// Deployables reuse the combat baseline. Persistent hazards use their authored cooldown; one-shot
// buildings use one activation as the rate unit. A kit's charges scale its total card power.
export function scoreBuilding(building,{quantity=1,extraPoints={}}={}){
  if(building.damage===undefined&&building.maxHp===undefined)return null;
  const unit=scoreCombatStats(building,extraPoints);
  return {...unit,score:Math.round(unit.rawScore*quantity),unitScore:unit.score,quantity};
}
