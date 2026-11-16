import crypto from 'node:crypto';
import {tcpOperationCategory} from '../public/tcp-evidence.mjs';

const text=(value,max=96)=>typeof value==='string'?value.replace(/[\x00-\x1f]/g,' ').slice(0,max):'';
export function normalizeTcpEvent(raw,{targets=[],id=crypto.randomUUID()}={}){
  if(!raw||!Number.isSafeInteger(raw.at)||typeof raw.operation!=='string')return null;
  const operation=text(raw.operation,40),process=text(raw.process),synthetic=process==='TrafficWatch-RelayProbe';
  const category=tcpOperationCategory(operation),matches=targets.filter(target=>target.ips?.some(ip=>ip===raw.source||ip===raw.destination));
  const host=matches.length===1?matches[0].host:null;
  const gateway=/^magpie(?:-|$)/i.test(process)?'magpie':/^cc[-_ ]?switch(?:-|$)/i.test(process)?'cc-switch':null;
  const harness=/^codex(?:-|$)/i.test(process)?'codex':/^claude(?:-|$)/i.test(process)?'claude':/^dsh(?:-|$)/i.test(process)?'dsh':null;
  return {id,kind:'tcp',at:raw.at,pid:raw.pid,process,source:text(raw.source,64),sourcePort:raw.sourcePort,destination:text(raw.destination,64),destinationPort:raw.destinationPort,operation,
    count:Number.isSafeInteger(raw.count)&&raw.count>0?raw.count:1,bytes:Number.isFinite(raw.bytes)&&raw.bytes>=0?raw.bytes:0,synthetic,category,fault:!synthetic&&category==='tcp_fail',
    ...(host?{host}:{}),...(gateway?{gateway}:{}),...(harness?{harness}:{}),
    // A retry is a reason to retain evidence, not a failed HTTP request. Limit
    // new automatic captures to known relay traffic from AI clients/gateways.
    captureReasons:!synthetic&&host&&(gateway||harness)&&category==='tcp_connect_retry'?['tcp_connect_retry']:[]};
}
export function correctTcpCategory(event){
  if(event.kind==='tcp'&&tcpOperationCategory(event.operation)==='tcp_connect_retry'&&event.category!=='tcp_connect_retry')return {...event,category:'tcp_connect_retry',fault:false};
  return event;
}
