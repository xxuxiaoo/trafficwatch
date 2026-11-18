import fs from 'node:fs';
import path from 'node:path';
import {parse,stringify} from 'yaml';
import {discoverEndpoints,discoverControllers,chooseController,requestController} from './mihomo.mjs';

export function controllerCall(candidate,route,method='GET',body){
  return requestController(candidate,route,method,body,{timeoutMs:4000});
}
export async function productionController(settings){
  const profile=path.join(settings.OwnerProfile,'AppData','Roaming');
  const {controllers,outcomes}=await discoverControllers({controller:'auto',secret:''},{...process.env,APPDATA:profile});
  const result=chooseController(controllers);
  if(!result)throw new Error(outcomes.some(item=>/controller_http_(401|403)/.test(item.reason?.message))?'clash_controller_unauthorized':'clash_controller_unavailable');return {...result,controllers};
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
export async function applyClashOverlay(settings,{hosts,ips,rollback=false,stateDir,controller,rollbackControllers}){
  if(rollback&&!controller){
    const env={...process.env,APPDATA:path.join(settings.OwnerProfile,'AppData','Roaming')};
    let online=rollbackControllers;
    if(!Array.isArray(online)){
      const candidates=discoverEndpoints({controller:'auto',secret:''},env);
      const outcomes=await Promise.allSettled(candidates.map(async candidate=>({candidate,config:await controllerCall(candidate,'/configs')})));
      online=outcomes.filter(item=>item.status==='fulfilled').map(item=>item.value);
    }
    const results=[];
    for(const client of ['verge','flclash']){
      const marker=path.join(stateDir,client==='verge'?'clash-overlay.json':'clash-overlay-flclash.json');
      if(!fs.existsSync(marker))continue;
      const runtimeFile=client==='verge'?settings.ClashConfigPath:path.join(env.APPDATA,'com.follow','clash','config.yaml');
      const active=chooseController(online.filter(item=>item.candidate.client===client));
      const target=active||{candidate:{client,configPath:runtimeFile},config:parse(fs.readFileSync(runtimeFile,'utf8')),offline:true};
      results.push(await applyClashOverlay(settings,{hosts:[],ips:[],rollback:true,stateDir,controller:target}));
    }
    return {state:'rolled_back',clients:results};
  }
  const target=controller||await productionController(settings),client=target.candidate.client||'verge';
  if(!['verge','flclash'].includes(client))throw new Error('clash_client_unsupported');
  const runtimeFile=path.resolve(target.candidate.configPath||settings.ClashConfigPath);
  if(client==='verge'&&runtimeFile!==path.resolve(settings.ClashConfigPath))throw new Error('clash_config_identity_mismatch');
  const script=client==='verge'?path.resolve(settings.BypassProfileScript||''):null;
  const parent=path.resolve(path.dirname(settings.ClashConfigPath),'profiles');
  if(script&&(path.dirname(script)!==parent||!script.endsWith('.js')))throw new Error('clash_profile_script_not_configured');
  const source=script?fs.readFileSync(script,'utf8'):null,next=script?patchProfileScript(source,rollback?[]:hosts,ips):null;
  const markerFile=path.join(stateDir,client==='verge'?'clash-overlay.json':'clash-overlay-flclash.json');let state=fs.existsSync(markerFile)?JSON.parse(fs.readFileSync(markerFile,'utf8')):{ips:[],hosts:[]};const previousState=state;
  const runtimeText=fs.readFileSync(runtimeFile,'utf8'),runtime=parse(runtimeText);
  for(const key of ['mode','mixed-port','port','socks-port','redir-port','tproxy-port','allow-lan','bind-address','ipv6','log-level','find-process-mode','interface-name','routing-mark','unified-delay','tcp-concurrent','keep-alive-interval','keep-alive-idle','disable-keep-alive','authentication','skip-auth-prefixes'])if(Object.hasOwn(target.config,key))runtime[key]=target.config[key];
  runtime.tun={...runtime.tun,...target.config.tun};
  if(client==='flclash'&&!target.offline){
    // A live controller toggle does not rewrite FlClash's generated YAML.
    // Retain its current endpoint and password when reloading that same core.
    runtime['external-controller']=target.candidate.endpoint;
    runtime.secret=target.candidate.secret||'';
  }
  if(!runtime.dns||!Array.isArray(runtime.dns['fake-ip-filter'])||runtime.dns['fake-ip-filter-mode']==='whitelist')throw new Error('clash_dns_filter_unsupported');
  const oldIps=state.ips||[],oldHosts=state.hosts||[];
  const hadFilters=[...runtime.dns['fake-ip-filter']],hadExcludes=[...(runtime.tun?.['route-exclude-address']||[])];
  // Only runtime values originally inserted by this manager are removed.
  const ownHosts=rollback?[]:hosts.filter(host=>oldHosts.includes(host)||!runtime.dns['fake-ip-filter'].includes(host));
  const originalExcludes=runtime.tun?.['route-exclude-address']||[];
  const ownIps=rollback?[]:ips.filter(ip=>oldIps.includes(ip)||!originalExcludes.includes(ip+'/32'));
  runtime.dns['fake-ip-filter']=[...new Set([...runtime.dns['fake-ip-filter'].filter(host=>!oldHosts.includes(host)),...(rollback?[]:hosts)])];
  runtime.tun??={};runtime.tun['route-exclude-address']=[...new Set([...originalExcludes.filter(ip=>!oldIps.includes(ip.replace(/\/32$/,''))),...(rollback?[]:ips.map(ip=>ip+'/32'))])];
  const rules=target.offline?{rules:[]}:await controllerCall(target.candidate,'/rules');
  const effectiveFilters=hadFilters,effectiveExcludes=target.config.tun?.['route-exclude-address']||hadExcludes;
  const directReady=hosts.every(host=>rules.rules?.find(rule=>String(rule.type).toLowerCase()==='domain'&&rule.payload===host)?.proxy==='DIRECT');
  const exclusionsReady=!rollback&&hosts.every(host=>effectiveFilters.includes(host))&&ips.every(ip=>effectiveExcludes.includes(ip+'/32'));
  if(source===next&&exclusionsReady&&directReady)return {state:'unchanged',client,hosts:hosts.length,ips:ips.length};
  const reconciled=reconcileRelayRules(runtime.rules,state,rollback?[]:hosts);runtime.rules=reconciled.rules;
  if(source!==next)fs.writeFileSync(script,next);
  try{
    // Persist ownership before reload, so a crash cannot orphan additions.
    state={ips:rollback?[]:ownIps,hosts:rollback?[]:ownHosts,ruleOwnership:reconciled.ruleOwnership,updatedAt:Date.now()};fs.writeFileSync(markerFile,JSON.stringify(state));
    const payload=stringify(runtime);
    fs.writeFileSync(runtimeFile,payload);
    if(!target.offline)await controllerCall(target.candidate,'/configs?force=false','PUT',{payload});
  }catch(error){if(source!==next)fs.writeFileSync(script,source);fs.writeFileSync(runtimeFile,runtimeText);fs.writeFileSync(markerFile,JSON.stringify(previousState));throw error;}
  return {state:'applied',client,hosts:hosts.length,ips:ips.length,rollback,liveApplied:!target.offline};
}
