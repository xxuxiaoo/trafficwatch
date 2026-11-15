import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DiagnosticSpool} from './ai-diagnostic-store.mjs';
import {appRoot,readSettings,discoverPhysical,physicalDns,probeRelay,runNetworkScript} from './ai-windows.mjs';
import {applyClashOverlay,productionController,controllerCall} from './relay-clash-overlay.mjs';

export async function bypassCycle(settings,{rollback=false,verify=false}={}){
  const dataRoot=settings.DataRoot,dir=path.join(dataRoot,'relay-bypass');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'targets.json');let previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{targets:[]};
  if(rollback){
    await applyClashOverlay(settings,{hosts:settings.RelayHosts,ips:previous.targets.flatMap(target=>target.ips),rollback:true,stateDir:dir});
    const [result]=await runNetworkScript('TrafficWatch-RelayRoutes.ps1','Rollback');if(!result?.ok)throw new Error('relay_rollback_failed');
    return {kind:'route',id:crypto.randomUUID(),at:Date.now(),state:'rolled_back'};
  }
  const adapter=await discoverPhysical(),changed=JSON.stringify(previous.adapter)!==JSON.stringify(adapter),targets=[],errors=[];
  for(const host of settings.RelayHosts){
    const old=previous.targets.find(target=>target.host===host);
    if(old&&!changed&&old.refreshAt>Date.now()){targets.push(old);continue;}
    try{
      const answer=await physicalDns(host,adapter),ttl=Math.max(60,Math.min(600,...answer.records.map(record=>record.ttl)));
      targets.push({host,ips:[...new Set(answer.records.map(record=>record.ip))],resolvedAt:answer.at,refreshAt:Date.now()+ttl*1000,cnames:answer.cnames,ipv6Available:adapter.ipv6.length>0,ipv6Unmanaged:answer.ipv6Records?.length||0});
    }catch{if(old)targets.push({...old,refreshAt:0,stale:true});errors.push({host,code:'physical_dns_unavailable'});}
  }
  if(targets.length!==settings.RelayHosts.length)throw new Error('relay_resolution_incomplete');
  const input=path.join(dir,'routes-input.json');fs.writeFileSync(input,JSON.stringify({adapter,targets}));
  const [routes]=await runNetworkScript('TrafficWatch-RelayRoutes.ps1','Apply',input);
  if(!routes?.ok)throw new Error('relay_route_verification_failed');
  const ips=[...new Set(targets.flatMap(target=>target.ips))];
  const overlay=await applyClashOverlay(settings,{hosts:settings.RelayHosts,ips,stateDir:dir});
  const result={kind:'route',id:crypto.randomUUID(),at:Date.now(),state:errors.length?'stale':'route_checked',adapter,targets,errors,routes:routes.checks,overlay,checks:[]};
  if(verify||changed||Date.now()-(previous.verifiedAt||0)>15*60000){
    const {candidate}=await productionController(settings);
    for(const target of targets){
      let seen=null,checkPromise;
      const ordinary=await dns.lookup(target.host,{family:4}).catch(()=>null);
      const probe=await probeRelay(target.host,target.ips[0],adapter,{onConnected:tuple=>{
        checkPromise=controllerCall(candidate,'/connections').then(snapshot=>{seen=snapshot.connections.some(connection=>Number(connection.metadata?.sourcePort)===tuple.sourcePort&&(connection.metadata?.destinationIP===tuple.ip||connection.metadata?.host===tuple.host));}).catch(()=>{seen=null;});
      }}).catch(()=>null);await checkPromise;
      const route=routes.checks.find(check=>check.ip===target.ips[0]);
      result.checks.push({host:target.host,at:Date.now(),systemIp:ordinary?.address||null,probe,seenInClash:seen,
        verified:Boolean(route?.physical&&ordinary&&target.ips.includes(ordinary.address)&&probe?.source===adapter.address&&seen===false&&(!adapter.ipv6.length||!target.ipv6Unmanaged))});
    }
    result.state=result.checks.every(check=>check.verified)&&!errors.length?'verified':'degraded';
  }else result.state=previous.state==='verified'&&!errors.length?'verified':'route_checked';
  const currentController=await productionController(settings),snapshot=await controllerCall(currentController.candidate,'/connections');
  result.remainingClashConnections=snapshot.connections.filter(connection=>settings.RelayHosts.includes(connection.metadata?.host)||(!connection.metadata?.host&&ips.includes(connection.metadata?.destinationIP))).map(connection=>({host:connection.metadata.host||null,process:String(connection.metadata.process||'').split(/[\\/]/).at(-1),source:connection.metadata.sourceIP,sourcePort:connection.metadata.sourcePort,destination:connection.metadata.destinationIP,chains:connection.chains}));
  if(result.remainingClashConnections.length){result.state='degraded';result.errors.push({code:'relay_connections_still_in_clash'});}
  const next={adapter,targets,state:result.state,verifiedAt:result.checks.length?Date.now():previous.verifiedAt,checks:result.checks.length?result.checks:previous.checks,updatedAt:Date.now()};
  fs.writeFileSync(file+'.pending',JSON.stringify(next));fs.renameSync(file+'.pending',file);
  return result;
}

async function main(){
  const settings=readSettings();if(!Array.isArray(settings.RelayHosts)||!settings.RelayHosts.length)return;
  const dataRoot=settings.DataRoot,dir=path.join(dataRoot,'relay-bypass');fs.mkdirSync(dir,{recursive:true});
  if(!process.argv.includes('--rollback')&&(fs.existsSync(path.join(dir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'))))return;
  const metadata=JSON.parse(fs.readFileSync(path.join(dataRoot,'vault','vault.json'),'utf8')),spool=new DiagnosticSpool(dataRoot,metadata);
  const rollback=process.argv.includes('--rollback');let stopping=false,lastResult='',timer;
  const writeStatus=value=>{const file=path.join(dir,'status.json');fs.writeFileSync(file+'.pending',JSON.stringify({app:'trafficwatch-relay-bypass',pid:process.pid,at:Date.now(),...value}));fs.renameSync(file+'.pending',file);};
  if(rollback){const result=await bypassCycle(settings,{rollback:true});spool.append([result]);writeStatus({state:'rolled_back'});spool.close();return;}
  const stop=()=>{stopping=true;clearTimeout(timer);spool.close();writeStatus({state:'stopped'});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  async function tick(){
    if(stopping)return;
    if(fs.existsSync(path.join(dir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'))){stop();return;}
    try{
      const result=await bypassCycle(settings),signature=JSON.stringify([result.state,result.adapter,result.targets.map(target=>[target.host,target.ips,target.stale]),result.errors]);
      if(signature!==lastResult||result.checks.length){spool.append([result]);lastResult=signature;}
      writeStatus({state:result.state,targets:result.targets.length,verified:result.checks.length?result.checks.filter(check=>check.verified).length:undefined});
    }catch{writeStatus({state:'degraded'});spool.append([{kind:'gap',id:crypto.randomUUID(),at:Date.now(),category:'bypass_validation_failed',fault:true}]);}
    if(!stopping)timer=setTimeout(tick,60000);
  }
  await tick();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Relay bypass could not start.\n');process.exitCode=1;});
