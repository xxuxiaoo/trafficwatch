import {eventId} from './ai-diagnostic-events.mjs';

export function requestCoverage(event,{ring,startedAt,traceState,lastTraceAt,targets=[],now=Date.now()}={}){
  const phase=event.phaseEvidence==='gateway_trace'?'available':event.gateway==='magpie'?(event.done===false?'pending':'missing'):'not_exposed';
  const result={phase,retries:event.gateway==='magpie'?'attempts':event.retryEvidence||'unknown',system:'unknown'};
  if(event.historicalImport||(event.end||event.at)<startedAt){result.system='before_collection';return result;}
  if(traceState!=='recording'||!lastTraceAt||now-lastTraceAt>20000){result.system='collector_unavailable';return result;}
  if(!event.host){result.system='target_unknown';return result;}
  const ips=targets.find(item=>item.host===event.host)?.ips||[];
  if(!ips.length){result.system='target_unknown';return result;}
  const end=event.end||now,from=Math.max(event.at-2000,end-30*60000);
  const rows=ring.between(from,end+2001);
  const matched=rows.some(row=>row.kind==='tcp'&&!row.synthetic&&ips.some(ip=>ip===row.source||ip===row.destination));
  result.system=matched?'same_target_window':'no_matching_tcp';return result;
}

export function collectionSnapshot({sources=[],traceState,lastTraceAt,pktmonState,pktmonCheckedAt,metrics={},queuePending=false,now=Date.now()}={}){
  const checks=[];
  for(const source of sources){
    const issues=[];
    if(['missing','read_error','unsupported_schema','limited','busy','starting','backlog'].includes(source.state))issues.push(source.state);
    if(source.parseFailures)issues.push('parse_failures');
    if(source.timeFailures)issues.push('unknown_times');
    if(source.lastPollAt&&now-source.lastPollAt>90000)issues.push('poll_overdue');
    checks.push({...source,issues,ok:issues.length===0});
  }
  const traceFresh=traceState==='recording'&&Number.isSafeInteger(lastTraceAt)&&now-lastTraceAt<=20000;
  checks.push({id:'traceevent',state:traceFresh?'recording':traceState==='recording'?'heartbeat_stale':traceState,
    issues:[...(!traceFresh?['system_trace_unavailable']:[]),...(metrics.traceEventsLost||metrics.boundedDrops?['dropped_events']:[])],
    eventsLost:metrics.traceEventsLost||0,boundedDrops:metrics.boundedDrops||0});
  checks.push({id:'pktmon',state:pktmonState,issues:[...(pktmonState!=='recording'?['pktmon_unavailable']:[]),...(!pktmonCheckedAt||now-pktmonCheckedAt>150000?['poll_overdue']:[])]});
  if(queuePending)checks.push({id:'encrypted_queue',state:'write_pending',issues:['queue_write_pending']});
  const issueCount=checks.filter(check=>check.issues.length).length;
  return {id:eventId('collection-health',now),kind:'status',at:now,category:'collection_health',schemaVersion:2,
    state:issueCount?'attention':'checked',issueCount,sources:checks,fault:false,
    meaning:'检查日志可读性、增量进度、格式、系统心跳与事件丢失；请求级证据另按所选时间统计。'};
}
