import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {parse,stringify} from 'yaml';
import {discoverEndpoints,validateEndpoint} from './mihomo.mjs';

export function controllerCall(candidate,route,method='GET',body){
  return new Promise((resolve,reject)=>{
    const request=http.request({...validateEndpoint(candidate.endpoint),path:route,method,headers:{...(candidate.secret?{Authorization:'Bearer '+candidate.secret}:{}),...(body===undefined?{}:{'content-type':'application/json'})}},response=>{
      const chunks=[];let size=0;response.on('data',part=>{size+=part.length;if(size>16*1024*1024)response.destroy(new Error('controller_oversize'));else chunks.push(part);});response.on('error',reject);response.on('end',()=>{if(response.statusCode<200||response.statusCode>=300)return reject(new Error('controller_http_'+response.statusCode));try{resolve(size?JSON.parse(Buffer.concat(chunks)):{});}catch{reject(new Error('controller_invalid'));}});
    });request.setTimeout(4000,()=>request.destroy(new Error('controller_timeout')));request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
}
export async function productionController(settings){
  const profile=path.join(settings.OwnerProfile,'AppData','Roaming');
  const candidates=discoverEndpoints({controller:'auto',secret:''},{...process.env,APPDATA:profile});
  const results=await Promise.allSettled(candidates.map(async candidate=>({candidate,config:await controllerCall(candidate,'/configs')})));
  const result=results.find(result=>result.status==='fulfilled'&&result.value.config['mixed-port']===7897);
  if(!result)throw new Error('clash_controller_unavailable');return result.value;
}
const start='// BEGIN TrafficWatch physical relay bypass',end='// END TrafficWatch physical relay bypass';
export function patchProfileScript(source,hosts,ips){
  const expression=new RegExp('\\s*'+start+'[\\s\\S]*?'+end+'\\s*','g');
  let clean=source.replace(expression,'\n');
  if(!hosts.length)return clean;
  if(!/return\s+config\s*;/.test(clean))throw new Error('clash_profile_script_unsupported');
  const block=`\n  ${start}\n  config.dns = config.dns || {};\n  if (config.dns['fake-ip-filter-mode'] === 'whitelist') throw new Error('TrafficWatch requires a blacklist fake-ip filter');\n  config.dns['fake-ip-filter'] = Array.from(new Set([...(config.dns['fake-ip-filter'] || []), ...${JSON.stringify(hosts)}]));\n  config.tun = config.tun || {};\n  config.tun['route-exclude-address'] = Array.from(new Set([...(config.tun['route-exclude-address'] || []), ...${JSON.stringify(ips.map(ip=>ip+'/32'))}]));\n  config.rules = [...${JSON.stringify(hosts.map(host=>'DOMAIN,'+host+',DIRECT'))}, ...(config.rules || [])];\n  ${end}\n  `;
  return clean.replace(/return\s+config\s*;/,block+'return config;');
}
export function reconcileRelayRules(currentRules,previousOwnership,hosts){
  const previous=previousOwnership||{},ownership=previous.ruleOwnership||{},oldHosts=Object.keys(ownership);
  let rules=Array.isArray(currentRules)?[...currentRules]:[];
  // Original user rules remain in place underneath this exact managed prefix.
  // Only remove the known inserted copy, never all matching rules.
  for(let index=oldHosts.length-1;index>=0;index--){
    const host=oldHosts[index],entry=ownership[host],managed='DOMAIN,'+host+',DIRECT';
    if(entry?.inserted&&rules[index]===managed)rules.splice(index,1);
  }
  const ruleOwnership=Object.fromEntries(hosts.map(host=>[host,{inserted:true}]));
  return {rules:[...hosts.map(host=>'DOMAIN,'+host+',DIRECT'),...rules],ruleOwnership};
}
export async function applyClashOverlay(settings,{hosts,ips,rollback=false,stateDir}){
  const script=path.resolve(settings.BypassProfileScript||'');
  const parent=path.resolve(path.dirname(settings.ClashConfigPath),'profiles');
  if(path.dirname(script)!==parent||!script.endsWith('.js'))throw new Error('clash_profile_script_not_configured');
  const source=fs.readFileSync(script,'utf8'),next=patchProfileScript(source,rollback?[]:hosts,ips);
  const markerFile=path.join(stateDir,'clash-overlay.json');let state=fs.existsSync(markerFile)?JSON.parse(fs.readFileSync(markerFile,'utf8')):{ips:[],hosts:[]};const previousState=state;
  const runtimeText=fs.readFileSync(settings.ClashConfigPath,'utf8'),runtime=parse(runtimeText);
  if(!runtime.dns||!Array.isArray(runtime.dns['fake-ip-filter'])||runtime.dns['fake-ip-filter-mode']==='whitelist')throw new Error('clash_dns_filter_unsupported');
  const oldIps=state.ips||[],oldHosts=state.hosts||[];
  const hadFilters=[...runtime.dns['fake-ip-filter']],hadExcludes=[...(runtime.tun?.['route-exclude-address']||[])];
  // Only runtime values originally inserted by this manager are removed.
  const ownHosts=rollback?[]:hosts.filter(host=>oldHosts.includes(host)||!runtime.dns['fake-ip-filter'].includes(host));
  const originalExcludes=runtime.tun?.['route-exclude-address']||[];
  const ownIps=rollback?[]:ips.filter(ip=>oldIps.includes(ip)||!originalExcludes.includes(ip+'/32'));
  runtime.dns['fake-ip-filter']=[...new Set([...runtime.dns['fake-ip-filter'].filter(host=>!oldHosts.includes(host)),...(rollback?[]:hosts)])];
  runtime.tun??={};runtime.tun['route-exclude-address']=[...new Set([...originalExcludes.filter(ip=>!oldIps.includes(ip.replace(/\/32$/,''))),...(rollback?[]:ips.map(ip=>ip+'/32'))])];
  const target=await productionController(settings);
  const rules=await controllerCall(target.candidate,'/rules');
  const effectiveFilters=hadFilters,effectiveExcludes=hadExcludes;
  const directReady=hosts.every(host=>rules.rules?.find(rule=>String(rule.type).toLowerCase()==='domain'&&rule.payload===host)?.proxy==='DIRECT');
  const exclusionsReady=!rollback&&hosts.every(host=>effectiveFilters.includes(host))&&ips.every(ip=>effectiveExcludes.includes(ip+'/32'));
  if(source===next&&exclusionsReady&&directReady)return {state:'unchanged',hosts:hosts.length,ips:ips.length};
  const reconciled=reconcileRelayRules(runtime.rules,state,rollback?[]:hosts);runtime.rules=reconciled.rules;
  if(source!==next)fs.writeFileSync(script,next);
  try{
    // Persist ownership before reload, so a crash cannot orphan additions.
    state={ips:rollback?[]:ownIps,hosts:rollback?[]:ownHosts,ruleOwnership:reconciled.ruleOwnership,updatedAt:Date.now()};fs.writeFileSync(markerFile,JSON.stringify(state));
    const payload=stringify(runtime);
    fs.writeFileSync(settings.ClashConfigPath,payload);
    await controllerCall(target.candidate,'/configs?force=false','PUT',{payload});
  }catch(error){if(source!==next)fs.writeFileSync(script,source);fs.writeFileSync(settings.ClashConfigPath,runtimeText);fs.writeFileSync(markerFile,JSON.stringify(previousState));throw error;}
  return {state:'applied',hosts:hosts.length,ips:ips.length,rollback};
}
