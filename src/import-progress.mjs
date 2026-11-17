const round=value=>Math.round(value*10)/10;
const roundRate=value=>round(Math.max(0,value));

export function importBudgetMs(remaining){
  if(!Number.isSafeInteger(remaining)||remaining<200)return 25;
  return remaining>=2000?75:50;
}

export function measureImportProgress(points,now,remaining,{windowMs=30000,minWindowMs=5000}={}){
  const samples=points.filter(point=>Number.isFinite(point.at)&&point.at<=now&&now-point.at<=windowMs&&Number.isFinite(point.remaining)&&Number.isFinite(point.processed));
  if(samples.length<2)return {measurementSeconds:0,importedPerSecond:null,arrivingPerSecond:null,netPerSecond:null,etaSeconds:null,stalled:false};
  const first=samples[0],last=samples.at(-1),elapsed=Math.max(0,(last.at-first.at)/1000),measurementSeconds=Math.round(elapsed*10)/10;
  if(elapsed*1000<minWindowMs)return {measurementSeconds,importedPerSecond:null,arrivingPerSecond:null,netPerSecond:null,etaSeconds:null,stalled:false};
  const imported=Math.max(0,last.processed-first.processed),remainingChange=last.remaining-first.remaining;
  const importedPerSecond=roundRate(imported/elapsed),arrivingPerSecond=roundRate(Math.max(0,imported+remainingChange)/elapsed),netPerSecond=round(importedPerSecond-arrivingPerSecond);
  const backlog=Number.isFinite(remaining)?remaining:last.remaining,stalled=backlog>0&&netPerSecond<0.1;
  return {measurementSeconds,importedPerSecond,arrivingPerSecond,netPerSecond,etaSeconds:backlog>0&&netPerSecond>=0.1?Math.ceil(backlog/netPerSecond):null,stalled};
}
