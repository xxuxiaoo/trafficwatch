import {eventId,errorCategory,magpieLogTimestamp,DIAGNOSTIC_SCHEMA_VERSION} from './ai-diagnostic-events.mjs';

const finite=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const timestamp=value=>typeof value==='number'?(value<1e11?Math.round(value*1000):Math.round(value)):Date.parse(value);
const faultCategories=new Set(['eof','reset','timeout','tls_error','dns_error','gateway_error']);
const statusOf=value=>{const n=Number(value);return Number.isInteger(n)&&n>=100&&n<=599?n:0;};
const harness=value=>({codex:'codex',claude:'claude',claudecode:'claude',claude_code:'claude',dsh:'dsh'}[String(value).toLowerCase()]||'unknown');
// These parsers return a strict metadata allowlist. Arbitrary messages, headers,
// model output, session names, URLs and request bodies never leave the adapter.
function diagnosticLog({source,key,at,status=0,error='',category,client='unknown',retry=null,delayMs=null,context={}}){
  if(!Number.isSafeInteger(at)||at<0){context.onInvalidTime?.();return null;}
  category=category||errorCategory(error,status);
  return {id:eventId(source,key),schemaVersion:DIAGNOSTIC_SCHEMA_VERSION,kind:'log',at,
    timeSource:'source_log',observedAt:context.observedAt??Date.now(),historicalImport:context.historicalImport===true,
    source,harness:client,gateway:'unknown',category,status,fault:faultCategories.has(category),retry,delayMs,
    phaseEvidence:'unavailable',rawLogRetained:false};
}

export function normalizeCcSwitchRequest(row,context={}){
  // CC Switch also imports transcripts. Those are not proxy requests and would
  // otherwise duplicate the Harness adapters and invent gateway observations.
  if(row?.data_source!=='proxy'||!row.request_id)return null;
  const at=timestamp(row.created_at);if(!Number.isSafeInteger(at)||at<0){context.onInvalidTime?.();return null;}
  const status=statusOf(row.status_code),category=errorCategory(typeof row.error_message==='string'?row.error_message:'',status);
  const durationMs=finite(row.duration_ms)??finite(row.latency_ms),ttftMs=finite(row.first_token_ms);
  return {id:eventId('cc-switch-proxy',row.request_id),schemaVersion:DIAGNOSTIC_SCHEMA_VERSION,kind:'request',at,
    end:durationMs===null?null:at+Math.ceil(durationMs),requestId:eventId('cc-switch',row.request_id),attempt:null,
    gateway:'cc-switch',harness:harness(row.app_type),provider:typeof row.provider_name==='string'?row.provider_name.replace(/[\x00-\x1f]/g,' ').slice(0,96):'provider-'+eventId(row.provider_id).slice(0,10),
    source:'cc-switch',status,category,done:status>0,durationMs,ttftMs,timings:{},phaseEvidence:'unavailable',
    retryEvidence:'request_summary_only',fault:faultCategories.has(category),captureReasons:ttftMs>30000&&category!=='cancelled'?['slow_first_content']:[],
    observedAt:context.observedAt??Date.now(),historicalImport:context.historicalImport===true};
}

export function normalizeCodexLog(row,context={}){
  if(!row||typeof row.feedback_log_body!=='string'||!/^(codex_http_client::|codex_api::|codex_core::(?:stream_events_utils|client|client_common)(?:::|$))/.test(row.target||''))return null;
  const body=row.feedback_log_body;
  const transport=row.target.startsWith('codex_http_client::')||row.target.startsWith('codex_api::');
  if(!transport&&!['WARN','ERROR','INFO'].includes(row.level))return null;
  // DEBUG SSE messages contain model text. Match the transport's own response
  // message, never a status-looking substring inside generated content.
  const response=transport?body.match(/\b(?:HTTP request completed|request completed|response received|received response)\b[^\r\n]*?\bstatus(?:_code)?[=: ]+(\d{3})\b/i):null;
  const status=statusOf(response?.[1]);
  const retry=body.match(/\b(?:retrying|reconnecting|retry)\s*(?:in\s+\d+\s*m?s\s*)?\(?\s*(\d+)\s*\/\s*(\d+)/i);
  const error=['WARN','ERROR','INFO'].includes(row.level)&&/stream disconnected before completion|error sending request|failed to (?:send|connect)|connection (?:reset|closed)|\b(?:EOF|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b|timed out|TLS handshake/i.test(body);
  if(!status&&!retry&&!error)return null;
  const subsecond=Number.isInteger(row.ts_nanos)&&row.ts_nanos>=0&&row.ts_nanos<1e9?Math.floor(row.ts_nanos/1e6):0;
  return diagnosticLog({source:'codex',key:context.sourceKey?`${context.sourceKey}:${row.id}`:row.id,at:timestamp(row.ts)+subsecond,status,
    error:error?body:'',category:!status&&retry&&!error?'retry_scheduled':undefined,client:'codex',retry:retry?Number(retry[1]):null,context});
}

export function normalizeCodexText(line,context={}){
  const target=line.match(/\b(codex_(?:http_client|api|core)::[a-zA-Z_:]+):/);
  if(!target)return null;
  const time=magpieLogTimestamp(line);if(!time)return null;
  return normalizeCodexLog({id:eventId(line),ts:time.at,target:target[1],level:line.match(/\b(TRACE|DEBUG|INFO|WARN|ERROR)\b/)?.[1],feedback_log_body:line},context);
}

export function normalizeClaudeRecord(row,context={}){
  if(!row||!(row.type==='system'&&row.subtype==='api_error'||row.type==='assistant'&&row.isApiErrorMessage===true))return null;
  const error=row.error,err=error&&typeof error==='object'?error:{};
  // Only API-error envelopes qualify; a tool result or quoted user error does not.
  const apiMessage=row.isApiErrorMessage===true?(Array.isArray(row.message?.content)?row.message.content.filter(item=>item.type==='text'&&typeof item.text==='string').map(item=>item.text.slice(0,2048)).slice(0,2).join(' '):''):'';
  const body=[typeof error==='string'?error:typeof err.message==='string'?err.message:'',apiMessage].filter(Boolean).join(' ');
  const status=statusOf(err.status??err.statusCode??row.statusCode) || statusOf(body.match(/(?:\bHTTP\s*|\bstatus[=: ]+|\bAPI (?:Error|error)[: ]+|^\s*)([45]\d{2})\b/i)?.[1]);
  const code=typeof row.error==='string'?row.error:typeof err.type==='string'?err.type:'';
  return diagnosticLog({source:'claude',key:[context.sourceKey,row.uuid||eventId(JSON.stringify(row))],at:timestamp(row.timestamp),status,
    error:body||code,category:!status&&!body&&/api_error|overloaded_error/.test(code)?'server_error':undefined,
    client:'claude',retry:finite(row.retryAttempt),delayMs:finite(row.retryInMs),context});
}

export function normalizeClaudeDebug(line,context={}){
  if(typeof line!=='string'||!/\[(?:ERROR|WARN|DEBUG)\].*(?:API (?:error|request failed)|Error in streaming|Retrying request|Request failed)/i.test(line))return null;
  const time=magpieLogTimestamp(line);if(!time)return null;
  const status=statusOf(line.match(/\b(?:status(?:Code)?[=: ]+|API error[: ]+|Request failed[: ]+)([45]\d{2})\b/i)?.[1]);
  return diagnosticLog({source:'claude-debug',key:line,at:time.at,status,error:line,client:'claude',context});
}

export function normalizeDshRecord(row,context={}){
  if(!row||!['llm/retry','llm/retry-started','turn/end'].includes(row.type))return null;
  const data=row.data&&typeof row.data==='object'?row.data:{};
  if(row.type==='turn/end'&&data.reason?.kind!=='error')return null;
  const failure=row.type==='turn/end'?data.reason.error||{}:data.failure&&typeof data.failure==='object'?data.failure:{};
  const status=statusOf(failure.status??failure.statusCode??failure.httpStatus) || statusOf(String(failure.message||'').match(/(?:\bHTTP\s*|\bstatus[=: ]+|^\s*)([45]\d{2})\b/i)?.[1]);
  const error=[failure.code,failure.message].filter(value=>typeof value==='string').join(' ');
  const event=diagnosticLog({source:'dsh',key:[context.sourceKey,row.seq,row.type],at:timestamp(row.time),status,error,
    category:row.type==='llm/retry-started'?'retry_started':!error&&!status?row.type==='llm/retry'?'retry_scheduled':'unknown_error':undefined,
    client:'dsh',retry:finite(data.retry),delayMs:finite(data.delayMs),context});
  if(event&&typeof data.retryId==='string')event.retryChain=eventId('dsh-retry',context.sourceKey,data.retryId);
  return event;
}
