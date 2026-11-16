import crypto from 'node:crypto';
import {mappedProviderHost} from './ai-provider-targets.mjs';

const text=(value,max=96)=>typeof value==='string'?value.replace(/[\r\n\x00-\x1f]/g,' ').slice(0,max):'';
const number=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const stamp=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
export const eventId=(...parts)=>crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,32);
export const DIAGNOSTIC_SCHEMA_VERSION=2;
const networkErrors=['eof','reset','timeout','tls_error','dns_error','gateway_error'];
export function errorCategory(error,status) {
  const value=typeof error==='string'?error:error?JSON.stringify(error):'';
  if(status===499||/cancel|context canceled|abort/i.test(value))return 'cancelled';
  if(status===429)return 'rate_limit';
  if(status===503)return 'upstream_busy';
  if(/\bEOF\b|unexpected end|connection closed/i.test(value))return 'eof';
  if(/reset|ECONNRESET|broken pipe/i.test(value))return 'reset';
  if(/tls|certificate|handshake/i.test(value))return 'tls_error';
  if(/dns|ENOTFOUND|no such host/i.test(value))return 'dns_error';
  if(/timeout|timed out|deadline/i.test(value))return 'timeout';
  if(status===502||status===504)return 'gateway_error';
  if(status>=500)return 'server_error';
  if(status>=400)return 'http_rejected';
  if(value)return 'unknown_error';
  return status>=200&&status<400?'success':'pending';
}
export function normalizeMagpieRequest(raw,{providerTargets=new Map()}={}) {
  if(!raw||typeof raw!=='object')return [];
  const at=stamp(raw.time);if(!Number.isSafeInteger(at)||at<0)return [];
  const requestId=eventId('magpie',raw.id??raw.seq,at);
  const tries=Array.isArray(raw.tries)?raw.tries.slice(0,100):[];
  if(!tries.length&&raw.done===true)tries.push({start:raw.time,status:raw.status,ms:raw.ms,ttft:raw.ttft,done:true});
  const rows=tries.map((attempt,index)=>{
    const started=stamp(attempt.start),start=Number.isSafeInteger(started)?started:at;
    const net=attempt.net&&typeof attempt.net==='object'?attempt.net:{};
    const timings=Object.fromEntries(['before','pool','dns','connect','tls','send','wait','head'].map(key=>[key,number(net[key])]));
    const status=Number(attempt.status)||0,category=errorCategory(attempt.error,status);
    const done=attempt.done===true||raw.done===true||status>0;
    const duration=number(attempt.ms),end=done&&duration!==null?start+Math.ceil(duration):null;
    const captureReasons=[];
    if(networkErrors.includes(category))captureReasons.push(category);
    for(const [key,threshold,reason]of [['connect',5000,'slow_connect'],['tls',5000,'slow_tls'],['send',10000,'slow_send'],['wait',15000,'slow_response']])if(timings[key]>threshold)captureReasons.push(reason);
    if(number(attempt.ttft)>30000&&category!=='cancelled')captureReasons.push('slow_first_content');
    const attemptProvider=[attempt.provider,attempt.id].find(value=>mappedProviderHost(providerTargets,value));
    const provider=text(attemptProvider||raw.provider||'unknown'),host=mappedProviderHost(providerTargets,provider);
    return {id:eventId('magpie-try-v2',requestId,index),legacyId:eventId(requestId,attempt.id??index),schemaVersion:DIAGNOSTIC_SCHEMA_VERSION,kind:'request',at:start,end,requestId,attempt:index+1,
      harness:text(raw.agent||'unknown',40),gateway:'magpie',provider,...(host?{host,targetEvidence:'provider_configuration'}:{}),
      status,category,done,durationMs:duration,ttftMs:number(attempt.ttft),reused:typeof net.reused==='boolean'?net.reused:null,timings,
      phaseEvidence:Object.values(timings).some(value=>value!==null)?'gateway_trace':'unavailable',
      // Error text, sessions, URLs, prompts and arbitrary nested fields are intentionally never copied.
      fault:networkErrors.includes(category),captureReasons};
  });
  const completed=raw.done===true&&rows.length&&rows.every(row=>row.end!==null),requestEnd=completed?Math.max(...rows.map(row=>row.end)):null;
  return rows.map(row=>({...row,requestAt:at,requestEnd,expectedAttempts:tries.length}));
}

// Go's standard logger uses local wall time; ISO timestamps may carry their own
// offset. Never substitute the time at which a historical line was read.
export function magpieLogTimestamp(line){
  const prefix=String(line).slice(0,160),match=prefix.match(/^\s*(?:\[|(?:time|timestamp)=\"?)?(\d{4})([-/])(\d{2})\2(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?(?=[\s\]\"]|$)/);
  if(!match)return null;
  const [,year,,month,day,hour,minute,second,fraction='',zone]=match,parts=[year,month,day,hour,minute,second].map(Number),[y,m,d,h,min,s]=parts;
  const calendar=new Date(Date.UTC(y,m-1,d,h,min,s));
  if(y<1970||calendar.getUTCFullYear()!==y||calendar.getUTCMonth()!==m-1||calendar.getUTCDate()!==d||h>23||min>59||s>59)return null;
  const ms=Number(fraction.padEnd(3,'0').slice(0,3)),at=zone?Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${String(ms).padStart(3,'0')}${zone}`):new Date(y,m-1,d,h,min,s,ms).getTime();
  return Number.isSafeInteger(at)?{at,timeSource:zone?'log_offset':'log_local'}:null;
}

export function normalizeMagpieLog(line,{hosts=[],observedAt=Date.now(),historicalImport=false}={}){
  if(typeof line!=='string'||!/EOF|502|504|reset|handshake|timeout|timed out|connection refused/i.test(line))return null;
  const timestamp=magpieLogTimestamp(line),category=errorCategory(line,/\b502\b/.test(line)?502:/\b504\b/.test(line)?504:0);
  return {id:eventId('magpie-app',line),kind:'log',schemaVersion:DIAGNOSTIC_SCHEMA_VERSION,at:timestamp?.at??null,timeSource:timestamp?.timeSource??'unknown',observedAt,historicalImport,
    host:hosts.find(host=>line.includes(host))||null,gateway:'magpie',category,fault:Boolean(timestamp)&&networkErrors.includes(category),rawLogRetained:false};
}

export function diagnosticTriggers(event){
  if(event.historicalImport||event.lateHistoricalRecord||event.timeSource==='unknown')return [];
  if(event.kind==='mark')return ['manual'];
  return [...new Set([...(event.fault?[event.category||'unknown_error']:[]),...(event.captureReasons||[])])];
}

export class EvidenceRing {
  constructor({durationMs=30*60000,maxBytes=64*1024*1024,maxEvents=50000}={}){Object.assign(this,{durationMs,maxBytes,maxEvents});this.data=[];this.head=0;this.bytes=0;this.evicted=0;}
  get rows(){return this.data.slice(this.head);}
  get size(){return this.data.length-this.head;}
  add(event,now=Date.now()){
    const size=Buffer.byteLength(JSON.stringify(event));if(size>this.maxBytes){this.evicted++;return;}
    this.data.push({event,size});this.bytes+=size;
    while(this.size&&(this.bytes>this.maxBytes||this.size>this.maxEvents||this.data[this.head].event.at<now-this.durationMs)){this.bytes-=this.data[this.head++].size;this.evicted++;}
    if(this.head>4096&&this.head>this.data.length/2){this.data=this.data.slice(this.head);this.head=0;}
  }
  between(from,to){return this.rows.map(row=>row.event).filter(event=>event.at>=from&&event.at<to);}
}

export class IncidentEngine {
  constructor({persist,ring=new EvidenceRing(),beforeMs=600000,afterMs=300000,now=Date.now}={}){Object.assign(this,{persist,ring,beforeMs,afterMs,now});this.active=null;this.lastSaved=0;}
  observe(event){
    this.ring.add(event,this.now());
    if(diagnosticTriggers(event).length)this.trigger(event);
    if(this.active&&event.at>=this.active.from&&event.at<=this.active.to){
      this.active.evidence.set(event.id,event);
      if(this.active.evidence.size>10000){
        this.active.evidence.delete(this.active.evidence.keys().next().value);this.active.truncated++;
      }
    }
    this.tick();
  }
  trigger(event){
    const at=event.end||event.at;
    if(this.active&&(at>this.active.to||at-this.active.at>1800000))this.finish();
    const isNew=!this.active;
    if(!this.active){const evidence=this.ring.between(at-this.beforeMs,at+1);this.active={id:crypto.randomUUID(),at,from:at-this.beforeMs,to:at+this.afterMs,provider:event.provider||event.host||'',harness:event.harness||'',gateway:event.gateway||'',triggers:new Map(),evidence:new Map(evidence.slice(-10000).map(row=>[row.id,row])),truncated:Math.max(0,evidence.length-10000),evictedAtStart:this.ring.evicted};}
    this.active.to=Math.max(this.active.to,at+this.afterMs);this.active.triggers.set(event.id,diagnosticTriggers(event));
    if(this.active.triggers.size>1024)this.active.triggers.delete(this.active.triggers.keys().next().value);
    if(isNew||this.now()-this.lastSaved>=30000)this.save('recording');
  }
  save(state){
    if(!this.active)return;const value=this.active;
    this.persist({id:value.id,kind:'incident',schemaVersion:DIAGNOSTIC_SCHEMA_VERSION,at:value.at,from:value.from,to:value.to,state,provider:value.provider,harness:value.harness,gateway:value.gateway,triggers:[...new Set([...value.triggers.values()].flat())],evidence:[...value.evidence.values()].sort((a,b)=>a.at-b.at),ringEvictions:this.ring.evicted-value.evictedAtStart+value.truncated,
      conclusion:'证据已保存；尚未据此确定根因。缺失阶段保持未知。'});this.lastSaved=this.now();
  }
  tick(){if(!this.active)return;if(this.now()>=this.active.to)this.finish();else if(this.now()-this.lastSaved>=30000)this.save('recording');}
  finish(state='complete'){this.save(state);this.active=null;}
}
