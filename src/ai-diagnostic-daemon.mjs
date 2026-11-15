import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {DiagnosticSpool} from './ai-diagnostic-store.mjs';
import {normalizeMagpieRequest,normalizeMagpieLog,IncidentEngine,eventId,errorCategory,DIAGNOSTIC_SCHEMA_VERSION} from './ai-diagnostic-events.mjs';
import {IncrementalTail} from './ai-log-tail.mjs';
import {appRoot,readSettings,discoverPhysical,physicalDns,probeRelay,runNetworkScript} from './ai-windows.mjs';
import {productionController,controllerCall} from './relay-clash-overlay.mjs';
import {commandVerifier} from './vault-commands.mjs';
import {DiagnosticLogSources} from './ai-log-sources.mjs';
import {requestCoverage,collectionSnapshot} from './ai-diagnostic-quality.mjs';

export async function startAiDiagnostics({settings=readSettings()}={}){
  const dataRoot=settings.DataRoot,dir=path.join(dataRoot,'diagnostics');fs.mkdirSync(dir,{recursive:true});
  if(fs.existsSync(path.join(dir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request')))return;
  if(!fs.existsSync(path.join(dataRoot,'vault','vault.json')))return;
  const metadata=JSON.parse(fs.readFileSync(path.join(dataRoot,'vault','vault.json'),'utf8')),verify=commandVerifier(metadata.commandPublicKey),spool=new DiagnosticSpool(dataRoot,metadata);
  const startedAt=Date.now();
  let pending=[],stopping=false,flushing=false,lastTick=0,trace=null,traceState='starting',traceRetry=0,lost=0,localDrops=0,resourceStart=process.cpuUsage(),lastResource=Date.now(),activeHost='',controller=null,pktmonState='starting',lastPktIncident=null,feedState='detecting',feedCursor='now',feedOrigin='',feedNextCheck=0,lastTraceAt=0,pktmonCheckedAt=0,lastCollectionCheck=0,magpieParseFailures=0;
  // A new cursor generation replays available source logs once through the
  // corrected parser. Corrected events supersede legacy IDs in encrypted storage.
  const seen=new Map(),tails=new Map(),checkpointFile=path.join(dir,'cursors-v3.json');
  let checkpoints={};try{checkpoints=JSON.parse(fs.readFileSync(checkpointFile,'utf8'));}catch{}
  const metrics={events:0,requests:0,faults:0,polls:0,errors:0,probeBytes:0,traceEventsLost:0,boundedDrops:0,pending:0};
  const persist=event=>{pending.push(event);if(pending.length>=64)flush();};
  const engine=new IncidentEngine({persist:event=>{persist(event);if(event.state==='recording'&&event.id!==lastPktIncident){lastPktIncident=event.id;snapshotPktmon('before',event.id).catch(()=>{});}if(event.state==='complete')snapshotPktmon('after',event.id).catch(()=>{});}});
  const observe=event=>{
    if(stopping)return;
    if(!Number.isSafeInteger(event.at))return;metrics.events++;
    if(!event.historicalImport)engine.observe((event.end||event.at)<Date.now()-30*60000?{...event,lateHistoricalRecord:true}:event);
    if(['request','probe','gap','mark','log','route','resource','status'].includes(event.kind))persist(event);
  };
  function flush(){if(flushing||!pending.length)return;flushing=true;try{spool.append(pending);pending=[];}finally{flushing=false;}}
  const gapTimes=new Map();
  function gap(category,source=''){metrics.errors++;const key=category+source,now=Date.now();if(now-(gapTimes.get(key)||0)<60000)return;gapTimes.set(key,now);observe({id:crypto.randomUUID(),kind:'gap',at:now,category,...(source?{source}:{})});}
  function withCoverage(event){return {...event,coverage:requestCoverage(event,{ring:engine.ring,startedAt,traceState,lastTraceAt,targets:targetState()?.targets||[]})};}
  const logSources=new DiagnosticLogSources({ownerProfile:settings.OwnerProfile,checkpoints:checkpoints.adapters||{},onGap:gap,onEvent:event=>{
    if(event.kind==='request'){const host=providerMap.get(event.provider?.toLowerCase());if(host)event.host=host;event=withCoverage(event);}
    observe(event);
  }});
  function acceptRequest(raw,{historicalImport=false}={}){
    for(const event of normalizeMagpieRequest(raw)){
      const signature=JSON.stringify(event);if(seen.get(event.id)===signature)continue;seen.delete(event.id);seen.set(event.id,signature);while(seen.size>20000)seen.delete(seen.keys().next().value);
      metrics.requests++;if(event.fault)metrics.faults++;event.observedAt=Date.now();event.historicalImport=historicalImport;
      const host=providerMap.get(event.provider.toLowerCase());if(host){activeHost=host;event.host=host;}observe(withCoverage(event));
    }
  }
  function acceptFeed(raw){
    if(raw.tries||raw.time){acceptRequest(raw);return;}
    const at=Date.parse(raw.t);if(!Number.isSafeInteger(at)||typeof raw.id!=='string')return;
    const status=Number(raw.status)||0,category=errorCategory('',status),id=eventId('magpie-feed',raw.id);
    const event={kind:'status',id,at,end:status>0&&Number.isFinite(raw.ms)?at+Math.round(raw.ms):null,category:'magpie_feed_summary',result:category,status,gateway:'magpie',provider:String(raw.providerName||raw.provider||'').slice(0,96),harness:String(raw.agent||'').slice(0,40),durationMs:Number.isFinite(raw.ms)?raw.ms:null,fault:[502,504].includes(status),phaseEvidence:'unavailable'};
    const host=settings.RelayHosts.find(host=>raw.host===host)||providerMap.get(String(raw.provider||raw.providerName||'').toLowerCase());if(host){event.host=host;activeHost=host;}
    const signature=JSON.stringify(event);if(seen.get(id)===signature)return;seen.set(id,signature);while(seen.size>20000)seen.delete(seen.keys().next().value);observe(event);
  }
  const routingDir=path.join(settings.OwnerProfile,'.config','magpie','routing'),appLog=path.join(settings.OwnerProfile,'AppData','Local','magpie','logs','app.log');
  const providerMap=new Map();
  let lastProviderRefresh=0;
  function loadProviders(){
    lastProviderRefresh=Date.now();
    try{
      const value=JSON.parse(fs.readFileSync(path.join(settings.OwnerProfile,'.config','magpie','providers.json'),'utf8'));
      const next=new Map();
      // Use only endpoint hostnames and provider labels. Never copy credential objects into events.
      const visit=(node,label='',depth=0)=>{if(!node||typeof node!=='object'||depth>5)return;for(const [key,item]of Object.entries(node)){
        if(typeof item==='string'&&/^(base_?url|api_?base|baseAPI|endpoint|url)$/i.test(key))try{const host=new URL(item.includes('://')?item:'https://'+item).hostname;if(settings.RelayHosts.includes(host))for(const id of [node.name,node.id,label].filter(Boolean))next.set(String(id).slice(0,96).toLowerCase(),host);}catch{}
        else if(item&&typeof item==='object'&&!/key|secret|token|credential/i.test(key))visit(item,/^\d+$/.test(key)?label:key,depth+1);
      }};visit(value);providerMap.clear();for(const [label,host]of next)providerMap.set(label,host);
    }catch{}
  }
  loadProviders();
  async function pollFeed(){
    if(Date.now()<feedNextCheck)return;
    if(!feedOrigin)try{const info=JSON.parse(fs.readFileSync(path.join(settings.OwnerProfile,'.config','magpie','gateway.json'),'utf8'));if(/^127\.0\.0\.1:\d+$/.test(info.addr))feedOrigin='http://'+info.addr;}catch{}
    if(!feedOrigin){feedState='files_only';feedNextCheck=Date.now()+60000;return;}
    try{
      const response=await fetch(feedOrigin+'/v1/magpie/usage/requests?'+new URLSearchParams({cursor:feedCursor,limit:'100'}),{signal:AbortSignal.timeout(2000)});
      if([400,410].includes(response.status)){gap('magpie_feed_cursor_gap');feedCursor='now';return;}
      if(!response.ok)throw new Error();
      const reader=response.body.getReader(),chunks=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024){await reader.cancel();throw new Error();}chunks.push(value);}
      const value=JSON.parse(Buffer.concat(chunks));if(!Array.isArray(value.rows)||typeof value.next_cursor!=='string')throw new Error();
      for(const row of value.rows)acceptFeed(row);feedCursor=value.next_cursor;feedState='cursor_feed_and_files';
    }catch{feedState='files_only';feedNextCheck=Date.now()+60000;feedOrigin='';}
  }
  function addTail(key,file,onLine){if(tails.has(key))return;const saved=checkpoints[key];tails.set(key,new IncrementalTail(file,{...saved,onLine,onGap:reason=>gap(reason)}));}
  let lastUnknownTimeGap=0;
  function appLine(line,context){
    const event=normalizeMagpieLog(line,{hosts:settings.RelayHosts,...context});if(!event)return;
    if(event.at===null){metrics.unknownLogTimes=(metrics.unknownLogTimes||0)+1;if(Date.now()-lastUnknownTimeGap>=60000){lastUnknownTimeGap=Date.now();gap('magpie_log_time_unknown');}return;}
    observe(event);
  }
  addTail('app-old',path.join(path.dirname(appLog),'app.old.log'),appLine);
  addTail('app',appLog,appLine);
  async function pollLogs(){
    if(Date.now()-lastProviderRefresh>=60000)loadProviders();
    const now=Date.now();for(const delta of [0,-86400000]){const day=new Date(now+8*3600000+delta).toISOString().slice(0,10);addTail(day,path.join(routingDir,day+'.jsonl'),(line,context)=>{try{const row=JSON.parse(line);if(!Number.isSafeInteger(Date.parse(row.time)))magpieParseFailures++;acceptRequest(row,context);}catch{magpieParseFailures++;}});}
    for(const [key,tail]of tails){if(!key.startsWith('app')&&key<new Date(now-2*86400000+8*3600000).toISOString().slice(0,10)){tails.delete(key);continue;}try{await tail.poll();}catch{tail.status.state='read_error';gap('log_read_failed');}}
    await logSources.poll();
    flush();checkpoints={...Object.fromEntries([...tails].map(([key,tail])=>[key,tail.checkpoint()])),adapters:logSources.checkpoint()};fs.writeFileSync(checkpointFile+'.pending',JSON.stringify(checkpoints));fs.renameSync(checkpointFile+'.pending',checkpointFile);
  }
  function startTrace(){
    if(trace||stopping||Date.now()<traceRetry)return;
    trace=spawn(path.join(appRoot,'native','TrafficWatch-AiTrace.exe'),[],{windowsHide:true,stdio:['pipe','pipe','ignore']});trace.stdin.on('error',()=>{});
    const input=createInterface({input:trace.stdout});input.on('line',line=>{
      if(line.length>4*1024*1024){gap('trace_oversize');return;}
      try{
        const row=JSON.parse(line);
        if(row.kind==='ready'){traceState='recording';updateTraceTargets();}
        else if(row.kind==='trace'){
          lastTraceAt=Date.now();
          if(row.eventsLost>lost||row.boundedDrops>localDrops)gap('trace_dropped_events');lost=row.eventsLost;localDrops=row.boundedDrops;metrics.traceEventsLost=lost;metrics.boundedDrops=localDrops;
          const currentTargets=targetState()?.targets||[];
          for(const raw of row.events||[]){if(typeof raw.operation!=='string')continue;const synthetic=raw.process==='TrafficWatch-RelayProbe',event={id:crypto.randomUUID(),kind:'tcp',...raw,synthetic,category:/Retransmit/i.test(raw.operation)?'retransmit':/Fail/i.test(raw.operation)?'tcp_fail':'socket',fault:/Fail/i.test(raw.operation)};engine.observe(event);if(!synthetic){const target=currentTargets.find(target=>target.ips.includes(raw.source)||target.ips.includes(raw.destination));if(target)activeHost=target.host;}}
        }else if(row.kind==='error')traceState='unavailable';
      }catch{gap('trace_invalid_event');}
    });
    const ended=()=>{if(!trace)return;trace=null;traceState='unavailable';traceRetry=Date.now()+60000;if(!stopping)gap('trace_stopped');};trace.on('exit',ended);trace.on('error',ended);
  }
  function targetState(){try{return JSON.parse(fs.readFileSync(path.join(dataRoot,'relay-bypass','targets.json'),'utf8'));}catch{return null;}}
  function updateTraceTargets(){const ips=targetState()?.targets.flatMap(target=>target.ips)||[];if(trace&&!trace.stdin.destroyed)trace.stdin.write(JSON.stringify(ips)+'\n');}
  async function connectivity(){
    let adapter;try{adapter=await discoverPhysical();}catch{gap('physical_adapter_unavailable');return;}
    const state=targetState();
    const selected=activeHost?[activeHost]:settings.RelayHosts.slice(0,1),others=metrics.polls%5===0?settings.RelayHosts.filter(host=>!selected.includes(host)):[];
    for(const host of [...selected,...others]){
      let ip=state?.targets.find(target=>target.host===host)?.ips?.[0];
      if(!ip)try{ip=(await physicalDns(host,adapter)).records[0].ip;}catch{gap('physical_dns_unavailable');continue;}
      for(const binding of [adapter,null]){
        try{
          let address=ip;if(!binding)address=(await dns.lookup(host,{family:4})).address;
          const row=await probeRelay(host,address,binding);metrics.probeBytes+=(row.sentBytes||0)+(row.receivedBytes||0);
          const internalError=['ArgumentException','InvalidOperationException'].includes(row.errorType);
          const category=internalError?'probe_error':row.errorType?(row.phase==='tls'?'tls_error':row.phase==='tcp'?'timeout':'eof'):row.status>=500?'server_error':'reachable';
          observe({...row,id:crypto.randomUUID(),category,fault:Boolean(row.errorType)&&!internalError,synthetic:true,billedInference:false,observedAt:Date.now()});
        }catch{gap('probe_helper_failed');}
      }
    }
    updateTraceTargets();
    if(!controller)try{controller=(await productionController(settings)).candidate;}catch{}
    if(controller)try{
      const [connections,config]=await Promise.all([controllerCall(controller,'/connections'),controllerCall(controller,'/configs')]);
      const rows=connections.connections.filter(connection=>settings.RelayHosts.includes(connection.metadata?.host)).map(connection=>({host:connection.metadata.host,source:connection.metadata.sourceIP,sourcePort:connection.metadata.sourcePort,destination:connection.metadata.destinationIP,chains:connection.chains,rule:connection.rule,upload:connection.upload,download:connection.download}));
      const bypassExpected=state?.state==='verified';
      observe({kind:'status',id:crypto.randomUUID(),at:Date.now(),category:rows.length&&bypassExpected?'relay_connections_still_in_clash':'clash_path',fault:Boolean(rows.length&&bypassExpected),tunEnabled:config.tun?.enable,connections:rows});
    }catch{controller=null;gap('clash_observation_unavailable');}
  }
  let pktBusy=false,pktTargetsSignature='',pktNextCheck=0;
  async function snapshotPktmon(stage,incidentId){
    if(pktBusy||pktmonState!=='recording')return;pktBusy=true;
    try{
      const [result]=await runNetworkScript('TrafficWatch-PktMon.ps1','Snapshot',undefined,{timeout:20000});
      if(result?.file){
        const expected=path.resolve(dir,'pktmon-private'),file=path.resolve(result.file);if(path.dirname(file)!==expected||!file.endsWith('.etl'))throw new Error('invalid_pktmon_file');
        const bytes=fs.readFileSync(file);try{
          // Packet payload flag is disabled. Store a signed public-key encrypted attachment before removing the native temporary.
          const {sealPacket,packetFormat}=await import('./vault-crypto.mjs');const id=crypto.randomUUID(),packet=sealPacket({bytes:bytes.toString('base64'),from:result.from,to:result.to},metadata.publicKey,{format:packetFormat,vault:metadata.id,lane:'diagnostics',id},spool.signingKey);
          const attachments=path.join(dir,'attachments');fs.mkdirSync(attachments,{recursive:true});fs.writeFileSync(path.join(attachments,id+'.sealed'),JSON.stringify(packet));
          observe({kind:'status',category:'pktmon_attachment',id,at:Date.now(),from:result.from,to:result.to,incidentId,stage,bytes:bytes.length,packetPayload:false});
          fs.unlinkSync(file);
        }finally{bytes.fill(0);}
      }
      pktmonState=result?.state==='recording'?'recording':'unavailable';pktmonCheckedAt=Date.now();
    }catch{pktmonState='unavailable';gap('pktmon_snapshot_failed');}finally{pktBusy=false;}
  }
  async function startPktmon(){
    const targets=targetState()?.targets.flatMap(target=>target.ips)||[];if(!targets.length){pktmonState='waiting_for_targets';return;}
    const signature=JSON.stringify([...new Set(targets)].sort());
    if(pktmonState==='recording'&&pktTargetsSignature&&pktTargetsSignature!==signature){
      if(engine.active)await snapshotPktmon('address-change',engine.active.id);
      try{await runNetworkScript('TrafficWatch-PktMon.ps1','Stop');gap('pktmon_targets_changed');}catch{pktmonState='unavailable';return;}
    }
    const input=path.join(dir,'pktmon-input.json');fs.writeFileSync(input,JSON.stringify({ips:targets}));
    try{const [row]=await runNetworkScript('TrafficWatch-PktMon.ps1','Start',input);pktmonState=row?.state||'unavailable';pktmonCheckedAt=Date.now();if(pktmonState==='recording')pktTargetsSignature=signature;}catch{pktmonState='unavailable';}
  }
  function checkCollection(){
    const routing=[...tails].filter(([key])=>!key.startsWith('app')).map(([,tail])=>tail.status),available=routing.filter(item=>item.state!=='missing');
    const magpie={id:'magpie',state:available.some(item=>item.state==='read_error')?'read_error':available.some(item=>item.bytesBehind)?'backlog':available.length?'caught_up':'missing',capability:'attempts_and_phases',files:available.length,bytesBehind:available.reduce((sum,item)=>sum+(item.bytesBehind||0),0),lastPollAt:Date.now(),parseFailures:magpieParseFailures,timeFailures:metrics.unknownLogTimes||0,feedState};
    const snapshot=collectionSnapshot({sources:[magpie,...logSources.snapshot()],traceState,lastTraceAt,pktmonState,pktmonCheckedAt,metrics,queuePending:pending.length>1024});
    observe(snapshot);flush();logSources.resetCounters();magpieParseFailures=0;metrics.unknownLogTimes=0;lastCollectionCheck=Date.now();
  }
  const health=()=>({app:'trafficwatch-ai-diagnostics',pid:process.pid,state:stopping?'stopped':'recording',at:Date.now(),trace:traceState,pktmon:pktmonState,metrics:{traceEventsLost:metrics.traceEventsLost,boundedDrops:metrics.boundedDrops,unknownLogTimes:metrics.unknownLogTimes||0},resources:{rssBytes:process.memoryUsage().rss,ringBytes:engine.ring.bytes},features:{magpie:'incremental_files',requestFeed:feedState,traceEvent:'2.0.77',pktmonPayload:false,eventSchema:DIAGNOSTIC_SCHEMA_VERSION,slowRequestCapture:true,logAdapters:['magpie','cc-switch','codex','claude','dsh'],collectionChecks:true},encrypted:true});
  const server=http.createServer(async(req,res)=>{
    const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
    if(req.headers.host!=='127.0.0.1:43132'||req.headers.origin&&req.headers.origin!=='http://127.0.0.1:43132')return json(403,{error:'local_origin_required'});
    if(req.method==='GET'&&req.url==='/api/health')return json(200,health());
    if(req.method!=='POST'||req.headers['x-codex-flow']!=='1')return json(403,{error:'local_header_required'});
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)return json(400,{error:'invalid_body'});}
    let body;try{body=JSON.parse(raw||'{}');}catch{return json(400,{error:'invalid_body'});}
    if(!verify(req.headers['x-trafficwatch-command'],req.url,body))return json(403,{error:'signed_owner_command_required'});
    if(req.url==='/api/mark'){const at=Date.now();observe({id:crypto.randomUUID(),kind:'mark',at,category:'manual',fault:true});flush();return json(200,{ok:true,at});}
    if(req.url==='/api/stop'){json(200,{ok:true});setTimeout(stop,100);return;}json(404,{error:'not_found'});
  });
  server.listen(43132,'127.0.0.1');
  async function resources(){
    const now=Date.now(),cpu=process.cpuUsage(resourceStart),elapsed=now-lastResource;resourceStart=process.cpuUsage();lastResource=now;
    let system=null;try{[system]=await runNetworkScript('TrafficWatch-Resources.ps1','Status',undefined,{timeout:10000});}catch{}
    if(stopping)return;
    observe({id:crypto.randomUUID(),kind:'resource',at:now,category:'collector_load',cpuPercent:(cpu.user+cpu.system)/1000/elapsed*100,rssBytes:process.memoryUsage().rss,systemFreeBytes:os.freemem(),ringBytes:engine.ring.bytes,system});
  }
  async function tick(){
    if(stopping)return;
    if(fs.existsSync(path.join(dir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'))){await stop();return;}
    try{
      await pollLogs();await pollFeed();engine.tick();startTrace();
      if(Date.now()>=pktNextCheck&&!pktBusy){pktNextCheck=Date.now()+60000;const signature=JSON.stringify([...new Set(targetState()?.targets.flatMap(target=>target.ips)||[])].sort());if(pktmonState!=='recording'||signature!==pktTargetsSignature)await startPktmon();else try{const [row]=await runNetworkScript('TrafficWatch-PktMon.ps1','Status');pktmonState=row?.state||'unavailable';pktmonCheckedAt=Date.now();}catch{pktmonState='unavailable';}}
      if(Date.now()-lastCollectionCheck>=60000)checkCollection();
    }catch{gap('diagnostic_poll_failed');}
    metrics.polls++;lastTick=Date.now();timer=setTimeout(tick,3000);
  }
  async function stop(){
    if(stopping)return;stopping=true;clearTimeout(timer);clearInterval(probeTimer);clearInterval(resourceTimer);trace?.stdin.end('stop\n');
    const deadline=Date.now()+15000;while(pktBusy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    engine.finish('interrupted');flush();
    try{await runNetworkScript('TrafficWatch-PktMon.ps1','Stop');}catch{}
    logSources.close();spool.close();server.close();
  }
  let timer,probing=false;
  const probeTimer=setInterval(()=>{if(!probing&&!stopping){probing=true;connectivity().catch(()=>gap('connectivity_poll_failed')).finally(()=>{probing=false;});}},60000);
  const resourceTimer=setInterval(()=>{if(!stopping)resources();},60000);
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  observe({kind:'gap',id:crypto.randomUUID(),at:Date.now(),category:'diagnostics_started'});
  startTrace();await startPktmon();await tick();return {stop,health};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startAiDiagnostics().catch(()=>{process.stderr.write('AI diagnostics could not start.\n');process.exitCode=1;});
