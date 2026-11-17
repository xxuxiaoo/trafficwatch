import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DiagnosticSpool} from './ai-diagnostic-store.mjs';
import {readSettings,discoverPhysical,physicalDns,probeRelay,runNetworkScript} from './ai-windows.mjs';
import {applyClashOverlay,productionController,controllerCall} from './relay-clash-overlay.mjs';
import {activeRelayHosts,relayHostRevision} from './relay-targets.mjs';

export async function bypassCycle(settings,{rollback=false,verify=false,services={}}={}){
  const discover=services.discoverPhysical||discoverPhysical,resolve=services.physicalDns||physicalDns,probeTarget=services.probeRelay||probeRelay;
  const networkScript=services.runNetworkScript||runNetworkScript,overlayApply=services.applyClashOverlay||applyClashOverlay;
  const getController=services.productionController||productionController,callController=services.controllerCall||controllerCall,lookup=services.lookup||dns.lookup;
  const dataRoot=settings.DataRoot,dir=path.join(dataRoot,'relay-bypass');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'targets.json');let previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{targets:[]};
  if(rollback){
    await overlayApply(settings,{hosts:[],ips:previous.targets.flatMap(target=>target.ips),rollback:true,stateDir:dir});
    const [result]=await networkScript('TrafficWatch-RelayRoutes.ps1','Rollback');if(!result?.ok)throw new Error('relay_rollback_failed');
    fs.writeFileSync(file+'.pending',JSON.stringify({adapter:null,targets:[],state:'rolled_back',checks:[],hostRevision:relayHostRevision([]),updatedAt:Date.now()}));fs.renameSync(file+'.pending',file);
    return {kind:'route',id:crypto.randomUUID(),at:Date.now(),state:'rolled_back',targets:[],checks:[],errors:[]};
  }
  const hosts=activeRelayHosts(settings);
  if(!hosts.length){
    if(previous.targets?.length){
      await overlayApply(settings,{hosts:[],ips:previous.targets.flatMap(target=>target.ips),rollback:true,stateDir:dir});
      const [routes]=await networkScript('TrafficWatch-RelayRoutes.ps1','Rollback');if(!routes?.ok)throw new Error('relay_rollback_failed');
    }
    const next={adapter:null,targets:[],state:'rolled_back',verifiedAt:Date.now(),checks:[],hostRevision:relayHostRevision([]),updatedAt:Date.now()};
    fs.writeFileSync(file+'.pending',JSON.stringify(next));fs.renameSync(file+'.pending',file);
    return {kind:'route',id:crypto.randomUUID(),at:Date.now(),state:'rolled_back',adapter:null,targets:[],errors:[],routes:[],checks:[],remainingClashConnections:[]};
  }
  const adapter=await discover(),changed=JSON.stringify(previous.adapter)!==JSON.stringify(adapter),targets=[],errors=[];
  const hostRevision=relayHostRevision(hosts),targetsChanged=hostRevision!==previous.hostRevision;
  for(const host of hosts){
    const old=previous.targets.find(target=>target.host===host);
    if(old&&!changed&&old.refreshAt>Date.now()){targets.push(old);continue;}
    try{
      const answer=await resolve(host,adapter),ttl=Math.max(60,Math.min(600,...answer.records.map(record=>record.ttl)));
      targets.push({host,ips:[...new Set(answer.records.map(record=>record.ip))],resolvedAt:answer.at,refreshAt:Date.now()+ttl*1000,cnames:answer.cnames,ipv6Available:adapter.ipv6.length>0,ipv6Unmanaged:answer.ipv6Records?.length||0});
    }catch{if(old)targets.push({...old,refreshAt:0,stale:true});errors.push({host,code:'physical_dns_unavailable'});}
  }
  if(targets.length!==hosts.length){const error=new Error('relay_resolution_incomplete');error.targets=errors;throw error;}
  const input=path.join(dir,'routes-input.json');fs.writeFileSync(input,JSON.stringify({adapter,targets}));
  const [routes]=await networkScript('TrafficWatch-RelayRoutes.ps1','Apply',input);
  if(!routes?.ok)throw new Error('relay_route_verification_failed');
  const ips=[...new Set(targets.flatMap(target=>target.ips))];
  const overlay=await overlayApply(settings,{hosts,ips,stateDir:dir});
  const result={kind:'route',id:crypto.randomUUID(),at:Date.now(),state:errors.length?'stale':'route_checked',adapter,targets,errors,routes:routes.checks,overlay,checks:[]};
  if(verify||changed||targetsChanged||JSON.stringify(targets.map(target=>[target.host,target.ips]))!==JSON.stringify(previous.targets.map(target=>[target.host,target.ips]))||Date.now()-(previous.verifiedAt||0)>15*60000){
    const {candidate}=await getController(settings);
    for(const target of targets){
      let seen=null,checkPromise;
      const ordinary=await lookup(target.host,{family:4}).catch(()=>null);
      const probe=await probeTarget(target.host,target.ips[0],adapter,{onConnected:tuple=>{
        checkPromise=callController(candidate,'/connections').then(snapshot=>{seen=snapshot.connections.some(connection=>Number(connection.metadata?.sourcePort)===tuple.sourcePort&&(connection.metadata?.destinationIP===tuple.ip||connection.metadata?.host===tuple.host));}).catch(()=>{seen=null;});
      }}).catch(()=>null);await checkPromise;
      const route=routes.checks.find(check=>check.ip===target.ips[0]);
      result.checks.push({host:target.host,at:Date.now(),systemIp:ordinary?.address||null,probe,seenInClash:seen,
        verified:Boolean(route?.physical&&ordinary&&target.ips.includes(ordinary.address)&&probe?.source===adapter.address&&probe?.phase==='complete'&&!probe?.errorType&&seen===false&&(!adapter.ipv6.length||!target.ipv6Unmanaged))});
    }
    result.state=result.checks.every(check=>check.verified)&&!errors.length?'verified':'degraded';
  }else result.state=previous.state==='verified'&&!errors.length?'verified':'route_checked';
  const currentController=await getController(settings),snapshot=await callController(currentController.candidate,'/connections');
  result.remainingClashConnections=snapshot.connections.filter(connection=>hosts.includes(connection.metadata?.host)||(!connection.metadata?.host&&ips.includes(connection.metadata?.destinationIP))).map(connection=>({host:connection.metadata.host||null,process:String(connection.metadata.process||'').split(/[\\/]/).at(-1),source:connection.metadata.sourceIP,sourcePort:connection.metadata.sourcePort,destination:connection.metadata.destinationIP,chains:connection.chains}));
  if(result.remainingClashConnections.length){result.state='degraded';result.errors.push({code:'relay_connections_still_in_clash'});}
  const next={adapter,targets,state:result.state,hostRevision,errors:result.errors,routes:result.routes,verifiedAt:result.checks.length?Date.now():previous.verifiedAt,checks:result.checks.length?result.checks:previous.checks,updatedAt:Date.now()};
  fs.writeFileSync(file+'.pending',JSON.stringify(next));fs.renameSync(file+'.pending',file);
  return result;
}

async function main(){
  const settings=readSettings();if(!settings.DataRoot||(!settings.RelayHosts?.length&&!fs.existsSync(path.join(settings.DataRoot,'relay-bypass','managed-targets.json'))))return;
  const dataRoot=settings.DataRoot,dir=path.join(dataRoot,'relay-bypass');fs.mkdirSync(dir,{recursive:true});
  if(!process.argv.includes('--rollback')&&(fs.existsSync(path.join(dir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'))))return;
  const metadata=JSON.parse(fs.readFileSync(path.join(dataRoot,'vault','vault.json'),'utf8')),spool=new DiagnosticSpool(dataRoot,metadata);
  const rollback=process.argv.includes('--rollback');let stopping=false,lastResult='',timer,running=false,rerun=false,forceVerify=true;
  const writeStatus=value=>{const file=path.join(dir,'status.json');fs.writeFileSync(file+'.pending',JSON.stringify({app:'trafficwatch-relay-bypass',pid:process.pid,at:Date.now(),...value}));fs.renameSync(file+'.pending',file);};
  if(rollback){const result=await bypassCycle(settings,{rollback:true});spool.append([result]);writeStatus({state:'rolled_back'});spool.close();return;}
  const finishStop=()=>{spool.close();writeStatus({state:'stopped'});};
  const stop=()=>{if(stopping)return;stopping=true;clearTimeout(timer);watcher.close();if(!running)finishStop();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const watcher=fs.watch(dir,(_event,filename)=>{
    if(String(filename)!=='refresh.request'||!fs.existsSync(path.join(dir,'refresh.request')))return;
    try{fs.unlinkSync(path.join(dir,'refresh.request'));}catch{}
    forceVerify=true;clearTimeout(timer);if(running)rerun=true;else timer=setTimeout(tick,50);
  });
  async function tick(){
    if(stopping||running)return;running=true;
    if(fs.existsSync(path.join(dir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'))){running=false;stop();return;}
    try{
      const verify=forceVerify;forceVerify=false;
      writeStatus({state:'checking'});
      const result=await bypassCycle(settings,{verify}),signature=JSON.stringify([result.state,result.adapter,result.targets.map(target=>[target.host,target.ips,target.stale]),result.errors]);
      if(signature!==lastResult||result.checks.length){spool.append([result]);lastResult=signature;}
      writeStatus({state:result.state,targets:result.targets.length,verified:result.checks.length?result.checks.filter(check=>check.verified).length:undefined});
    }catch(error){writeStatus({state:'degraded',error:/^[a-z_]+$/.test(error.message)?error.message:'bypass_validation_failed',errors:error.targets});spool.append([{kind:'gap',id:crypto.randomUUID(),at:Date.now(),category:'bypass_validation_failed',fault:true}]);}
    running=false;
    if(stopping){finishStop();return;}
    if(!stopping){if(rerun){rerun=false;timer=setTimeout(tick,50);}else timer=setTimeout(tick,60000);}
  }
  await tick();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Relay bypass could not start.\n');process.exitCode=1;});
