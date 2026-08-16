// Owns JS access to motion.css tokens and the single reduced-motion media query.
const reducedQuery=typeof window!=="undefined"?window.matchMedia("(prefers-reduced-motion:reduce)"):null;

function token(prefix,name,element){
  const property=`--${prefix}-${name}`;
  const value=typeof getComputedStyle==="function"
    ?getComputedStyle(element||document.documentElement).getPropertyValue(property).trim():"";
  if(!value)throw new Error(`missing motion token ${property}; define it in src/ui/motion.css`);
  return value;
}
export function motionEasing(name,element){return token("ease",name,element);}
export function motionDuration(name,element){
  const value=token("duration",name,element);
  const amount=Number.parseFloat(value);
  if(!Number.isFinite(amount))throw new Error(`invalid motion duration --duration-${name}: ${value}`);
  return value.endsWith("ms")?amount:value.endsWith("s")?amount*1000:amount;
}
export function prefersReducedMotion(){return reducedQuery?.matches||false;}
export function watchReducedMotion(listener){
  if(!reducedQuery)return ()=>{};
  const changed=event=>listener(event.matches);
  reducedQuery.addEventListener?.("change",changed);
  return ()=>reducedQuery.removeEventListener?.("change",changed);
}
/** WAAPI timing from the same vocabulary CSS consumes. Reduced motion always becomes a short fade. */
export function motionTiming(easing,duration,{element,reduced=prefersReducedMotion()}={}){
  return {duration:motionDuration(reduced?"reduced":duration,element),
    easing:reduced?"linear":motionEasing(easing,element)};
}
