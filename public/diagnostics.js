import {initializeVault,vaultHeaders,checkVaultResponse,importProgressText} from './vault-browser.mjs';
import {tcpOperationCategory,summarizeTcpRetries} from './tcp-evidence.mjs';
import {diagnosticHealth} from './diagnostic-health.mjs';
const $=id=>document.getElementById(id),node=(tag,text='',className='')=>{const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;};
const date=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const labels={incident:'故障现场',request:'真实请求',probe:'独立探测',route:'物理路径',gap:'采集缺口',resource:'采集器负载',status:'状态',log:'Magpie 日志',mark:'手动标记',tcp:'TCP 事件',success:'成功',reachable:'可连通',eof:'EOF / 断流',gateway_error:'502 / 504',reset:'连接重置',tls_error:'TLS 错误',dns_error:'DNS 错误',timeout:'超时',upstream_busy:'503 繁忙',rate_limit:'429 限流',cancelled:'取消',pending:'尚未结束',server_error:'服务端错误',http_rejected:'HTTP 拒绝',recording:'仍在取证',complete:'现场完整保存',interrupted:'记录中断',verified:'物理绕行已验证',degraded:'部分验证未通过',route_checked:'路由已检查，等待连接验证',stale:'需重新验证',rolled_back:'已恢复原 DIRECT 路径',stopped:'已停止',unavailable:'不可用',waiting_for_targets:'等待目标地址',in_use_by_other:'其他程序正在使用',foreign_filters_present:'已有其他筛选器',manual:'手动标记',diagnostics_started:'诊断启动 / 前段未记录',trace_dropped_events:'ETW 有丢失事件',trace_stopped:'ETW 助手停止',socket:'连接进度',retransmit:'TCP 重传'};
const label=value=>labels[value]||value||'未知',ms=value=>Number.isFinite(value)?value>=1000?(value/1000).toFixed(2)+' 秒':value.toFixed(0)+' 毫秒':'未知';
labels.probe_error='探测器内部错误';labels.probe_compatibility_fix='探测器兼容修复';
Object.assign(labels,{slow_connect:'建连较慢',slow_tls:'TLS 较慢',slow_send:'发送较慢',slow_response:'响应等待较长',slow_first_content:'首段内容等待较长',magpie_log_time_unknown:'部分日志发生时间无法识别',evidence_uncertain:'旧版证据需复核'});
Object.assign(labels,{log:'客户端 / 网关日志',retry_scheduled:'已安排重试',retry_started:'开始重试',collection_health:'采集自检',checked:'检查通过',attention:'部分来源需留意',cc_switch:'CC Switch',adapter_log_read_failed:'客户端日志读取失败',source_database_reset:'日志数据库已重建'});
Object.assign(labels,{unknown_error:'未分类错误',tcp_fail:'TCP 连接失败',collector_load:'采集器负载',pktmon_attachment:'PktMon 现场附件',magpie_feed_summary:'Magpie 请求摘要',clash_path:'Clash 路径检查',relay_connections_still_in_clash:'中转仍经过 Clash',bypass_validation_failed:'物理路径验证失败'});
labels.tcp_connect_retry='TCP 建连重试';
const sourceNames={magpie:'Magpie','cc-switch':'CC Switch',codex:'Codex',claude:'Claude Code',dsh:'DSH',traceevent:'Microsoft TraceEvent',pktmon:'Windows PktMon',encrypted_queue:'加密写入队列'};
const sourceStates={caught_up:'已跟上日志',quiet:'本期无新文件',missing:'未找到可用日志',read_error:'读取失败',unsupported_schema:'日志结构有变化',limited:'部分文件超出读取上限',busy:'数据库正忙，自动重试',backlog:'正在补读',starting:'正在检查',heartbeat_stale:'系统取证心跳中断',recording:'正常记录',write_pending:'等待加密写入'};
const sourceHints={missing:'使用该客户端时仍显示此状态，可检查其日志是否启用、存储位置是否更改。',read_error:'后台会重试；持续失败时检查文件访问权限与来源程序状态。',unsupported_schema:'来源格式与当前适配不符，需要更新适配器。',limited:'已优先读取最近文件；其他文件未全部覆盖。',busy:'只读访问暂时受阻，下一轮继续。',backlog:'已有日志正在增量补齐，完成后更新状态。',quiet:'发现旧文件；当前时段尚未写入新文件。',heartbeat_stale:'系统事件未按时到达，相关请求的 TCP 证据需要检查。'};
const recordTime=row=>row.timeSource==='unknown'?'发生时间未知 · 读取于 '+date.format(row.observedAt||row.at):date.format(row.at);
const controlIds=['range','from','to','kind','category','provider','harness','gateway'];
const networkCategories=['eof','gateway_error','reset','timeout','tls_error','dns_error','server_error','unknown_error'];
const slowCategories=['slow_connect','slow_tls','slow_send','slow_response','slow_first_content'];
const categoryGroups={incident:[...networkCategories,...slowCategories,'tcp_connect_retry','tcp_fail','manual','evidence_uncertain'],request:[...networkCategories,...slowCategories,'success','upstream_busy','rate_limit','cancelled','http_rejected','pending'],log:[...networkCategories,'retry_scheduled','retry_started','upstream_busy','rate_limit','cancelled','http_rejected'],probe:[...networkCategories,'reachable','probe_error'],status:['collection_health','pktmon_attachment','magpie_feed_summary','clash_path','relay_connections_still_in_clash'],gap:['diagnostics_started','trace_dropped_events','trace_stopped','adapter_log_read_failed','source_database_reset','bypass_validation_failed'],resource:['collector_load'],route:[]};
const harnessName=value=>({codex:'Codex',claude:'Claude Code',dsh:'DSH',unknown:'未识别客户端'}[value]||value);
const gatewayName=value=>({magpie:'Magpie','cc-switch':'CC Switch',direct:'直连',unknown:'未识别网关'}[value]||value);
let packet=null,busy=false,controller,refreshTimer,indexTimer,detailController,cursors=[null],page=0,renderedPage=0,selection=null,filters=new URLSearchParams(),vaultState,generation=0,detailGeneration=0;
window.addEventListener('trafficwatch-vault-locked',()=>{generation++;detailGeneration++;clearInterval(refreshTimer);clearTimeout(indexTimer);controller?.abort();detailController?.abort();});
const readControls=()=>Object.fromEntries(controlIds.map(id=>[id,$(id).value]));
let applied=readControls();
function message(text){$('message').textContent=text;$('message').hidden=!text;}
async function api(route,{body,signal}={}){
  const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'x-codex-flow':'1',...vaultHeaders(),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:signal||AbortSignal.timeout(15000)});await checkVaultResponse(response);
  const value=await response.json();if(!response.ok)throw new Error(value.error==='vault_migrating'?'加密记录正在打开，完成后会自动加载，不需要重复解锁。':value.error==='diagnostics_unavailable'?'诊断后台未响应，请从桌面控制台检查状态。':'操作未完成：'+value.error);return value;
}
function filterParams(values=applied){
  const now=Date.now(),range=values.range;let from,to=now+1;
  if(range==='today')from=Date.parse(new Date(now+8*3600000).toISOString().slice(0,10)+'T00:00:00+08:00');
  else if(range==='custom'){from=Date.parse(values.from+':00+08:00');to=Date.parse(values.to+':00+08:00');if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from)throw new Error('请选择有效的开始和结束时间。');}
  else from=now-({'1h':3600000,'2d':2*86400000,'7d':7*86400000}[range]);
  const result=new URLSearchParams({from:String(from),to:String(to),limit:'50'});
  for(const id of ['kind','category','provider','harness','gateway'])if(values[id].trim())result.set(id,values[id].trim());return result;
}
function updateDraftHint(){
  const draft=readControls(),dirty=controlIds.some(id=>(draft.range==='custom'||!['from','to'].includes(id))&&draft[id]!==applied[id]);
  $('filterHint').textContent=dirty?'条件已修改，点击“应用筛选”更新结果':'选择条件后点击“应用筛选”';$('filterHint').classList.toggle('is-dirty',dirty);
}
function fillSelect(id,values,empty,format=value=>value){
  const select=$(id),selected=select.value,choices=[...new Set([...values,...(selected?[selected]:[])])];
  if(JSON.stringify([...select.options].map(option=>option.value))===JSON.stringify(['',...choices]))return;
  select.replaceChildren(...['',...choices].map(value=>{const option=node('option',value?format(value):empty);option.value=value;return option;}));select.value=selected;
}
function updateCategories({preserve=true,facets=null}={}){
  const kind=$('kind').value,previous=$('category').value,choices=kind?(categoryGroups[kind]||[]):[...new Set(Object.values(categoryGroups).flat())];
  // A status or gap may have a newer category than this UI's built-in labels.
  const extras=facets?.categoryByKind?.[kind]||(!kind?facets?.category||[]:[]),options=[...new Set([...choices,...extras])];
  if(!preserve&&!options.includes(previous))$('category').value='';
  fillSelect('category',options,kind==='incident'?'全部触发原因':'全部类别',label);
  $('categoryLabel').textContent=kind==='incident'?'触发原因':'结果 / 类别';$('category').disabled=kind==='route';
}
function renderFacets(value){
  const facets=value.facets||{};
  fillSelect('provider',facets.provider||[],'全部中转');fillSelect('harness',facets.harness||[],'全部客户端',harnessName);fillSelect('gateway',facets.gateway||[],'全部网关',gatewayName);
  updateCategories({facets});
  $('filterScope').textContent=value.filterIndexPending?'正在补齐旧记录的筛选索引，匹配数可能暂未完整；完成后自动更新。':facets.limited?'选项来自已应用时段，最多展示 200 个不同值。':'中转、客户端和网关选项来自已应用时段的全部记录。';
}
function describeFilters(values){
  const range=values.range==='custom'?values.from.replace('T',' ')+' 至 '+values.to.replace('T',' '):({today:'今天','1h':'最近一小时','2d':'最近两天','7d':'最近七天'}[values.range]);
  const kind=[...$('kind').options].find(option=>option.value===values.kind)?.textContent||'所有记录';
  return [range,kind,values.category?label(values.category):'',values.provider,values.harness?harnessName(values.harness):'',values.gateway?gatewayName(values.gateway):''].filter(Boolean).join(' · ');
}
function clearDetail(){
  selection=null;detailGeneration++;detailController?.abort();
  const empty=node('div','','detail-empty');empty.append(node('span','⌁'),node('strong','选择一条记录查看详情'),node('p','左侧列出匹配记录，这里显示请求阶段和现场时间线。'));$('detail').replaceChildren(empty);
}
function renderStatus(value){
  const health=diagnosticHealth(value);
  for(const id of ['collector','bypass']){const target=$(id),item=health[id];target.textContent=item.title;target.dataset.tone=item.tone;target.closest('.diagnostic-health>div').dataset.tone=item.tone;}
  const state=value.collector;
  $('capture').textContent=value.liveAvailable!==false&&state?health.collector.detail+' · TCP：'+label(state.trace)+' · PktMon：'+label(state.pktmon)+(Number.isFinite(state.resources?.rssBytes)?' · '+Math.round(state.resources.rssBytes/1048576)+' MiB':''):health.collector.detail;
  $('bypassTime').textContent=health.bypass.detail;
  const facts=$('bypassFacts');facts.replaceChildren();
  for(const reason of health.bypass.reasons.slice(1))facts.append(node('li',reason));
  if(health.bypass.at)facts.append(node('li','最近检查 '+date.format(health.bypass.at)+(health.bypass.stage?' · '+health.bypass.stage:'')));
  if(health.bypass.lastVerifiedAt&&health.bypass.tone!=='good')facts.append(node('li','上次完整通过 '+date.format(health.bypass.lastVerifiedAt)+'；不代表本次通过'));
  $('bypassDetails').hidden=!facts.children.length;
}
function renderCollection(value){
  const check=value.rows?.[0];
  if(!check){$('collectionSummary').textContent='所选时间内还没有采集自检记录；新版本运行后每分钟保存一次。';$('collectionSources').replaceChildren();return;}
  $('collectionSummary').textContent=date.format(check.at)+' · '+(check.issueCount?check.issueCount+' 个来源需留意':'已检查各日志来源与系统取证');
  $('collectionSources').replaceChildren(...(check.sources||[]).slice(0,12).map(source=>{
    const item=node('div','','collection-source'),title=node('strong',sourceNames[source.id]||source.id),state=node('span',sourceStates[source.state]||label(source.state),source.issues?.length?'tag warn':'tag');
    const notes=[sourceHints[source.state]||''];
    if(source.capability==='request_summary')notes.push('可读请求结果与总耗时；此来源不提供 DNS / TCP / TLS 分阶段和逐次重试。');
    if(source.capability==='errors_and_retries')notes.push('提取客户端错误与重试，不重复计入网关请求次数。');
    if(source.bytesBehind)notes.push('待补读 '+(source.bytesBehind/1048576).toFixed(1)+' MiB。');
    if(source.parseFailures)notes.push('上次检查后 '+source.parseFailures+' 行格式无法解析。');
    if(source.timeFailures)notes.push('上次检查后 '+source.timeFailures+' 行时间无法识别。');
    if(source.eventsLost||source.boundedDrops)notes.push('系统丢失 '+(source.eventsLost||0)+'；容量丢弃 '+(source.boundedDrops||0)+'。');
    item.append(title,state,node('p',notes.filter(Boolean).join(' ')||'本次检查未发现读取或系统心跳异常。'));return item;
  }));
}
function renderList(value){
  packet=value;const requests=value.requestSummary||[],total=requests.reduce((sum,row)=>sum+row.count,0),faults=requests.filter(row=>['eof','reset','timeout','gateway_error','tls_error','dns_error'].includes(row.category)).reduce((sum,row)=>sum+row.count,0),busyCount=requests.filter(row=>row.category==='upstream_busy').reduce((sum,row)=>sum+row.count,0);
  const quality=value.quality||{},qualityNotes=[];
  if(quality.legacyRequests)qualityNotes.push(quality.legacyRequests+' 条旧版请求尚未从原日志补齐，重试可能不完整');
  if(quality.unknownLogTimes)qualityNotes.push(quality.unknownLogTimes+' 条旧日志无法确认发生时间，不能当作当前故障');
  $('qualityNotice').hidden=!qualityNotes.length;$('qualityNotice').textContent=qualityNotes.join('；')+'。';
  const coverage=[];
  if(quality.requestsChecked)coverage.push('已检查 '+quality.requestsChecked+' 条请求证据');
  if(quality.requestsUnchecked)coverage.push(quality.requestsUnchecked+' 条旧记录尚无新版证据检查结果');
  if(quality.missingRetryAttempts)coverage.push(quality.retryChainsWithGaps+' 条完整时段内的重试链缺 '+quality.missingRetryAttempts+' 次尝试');
  if(quality.phaseMissing)coverage.push(quality.phaseMissing+' 条 Magpie 请求缺少分阶段日志');
  if(quality.phaseNotExposed)coverage.push(quality.phaseNotExposed+' 条来源仅提供请求汇总');
  if(quality.systemUnavailable)coverage.push(quality.systemUnavailable+' 条请求发生时系统取证不可用');
  if(quality.tcpUnmatched)coverage.push(quality.tcpUnmatched+' 条请求未匹配到同期目标 TCP');
  if(quality.targetUnknown)coverage.push(quality.targetUnknown+' 条请求尚未映射目标地址');
  if(quality.beforeCollection)coverage.push(quality.beforeCollection+' 条来自历史补读，未逐次核对同期 TCP');
  $('coverageNote').textContent=coverage.length?coverage.join('；')+'。':'当前范围暂无可检查的请求证据。';
  $('matchCount').textContent=value.summary.reduce((sum,row)=>sum+row.count,0)+' 条';
  $('requestCount').textContent=total+' 次';$('faultCount').textContent='网络错误 '+faults+' · 503 繁忙 '+busyCount;$('listTitle').textContent=[...$('kind').options].find(option=>option.value===applied.kind).textContent;
  $('activeFilters').textContent=describeFilters(applied);renderFacets(value);updateDraftHint();
  $('listHint').textContent='共 '+value.summary.reduce((sum,row)=>sum+row.count,0)+' 条匹配记录，每页最多 50 条 · 更新 '+date.format(value.generatedAt||Date.now());
  $('records').replaceChildren(...value.rows.map(row=>{
    const button=node('button','','record');button.type='button';button.dataset.id=row.id;button.setAttribute('aria-pressed',String(selection===row.id));
    const tag=node('span',label(row.kind==='incident'||row.category==='collection_health'?row.state:row.category||row.state),row.fault?'tag bad':row.kind==='gap'||row.issueCount?'tag warn':'tag');
    const title=node('strong',row.kind==='incident'?[...new Set(row.triggers)].map(label).join(' · '):row.category==='collection_health'?'采集完整性检查':row.provider||row.host||label(row.kind));
    button.append(tag,title,node('small',recordTime(row)+(row.harness?' · '+harnessName(row.harness):'')+(row.attempt?' · 第 '+row.attempt+' 次尝试':'')+(row.durationMs!==undefined?' · '+ms(row.durationMs):'')+(row.status?' · HTTP '+row.status:'')+(row.historicalImport?' · 历史补读':'')+(row.captureReasons?.some(reason=>reason.startsWith('slow_'))?' · 有慢请求证据':'')));
    button.addEventListener('click',()=>select(row));return button;
  }));
  if(!value.rows.length)$('records').append(node('p',value.filterIndexPending?'正在补齐旧记录的筛选索引，请稍候。':'没有符合这些条件的记录。可以扩大时间范围、清除某项条件，或点击“重置”查看今天的全部故障与慢请求现场。','record-empty'));
  $('previous').disabled=page===0;$('next').disabled=!value.next;$('page').textContent='第 '+(page+1)+' 页';
}
function facts(values){const dl=node('dl','','evidence-facts');for(const [name,value]of values)dl.append(node('dt',name),node('dd',value));return dl;}
function describe(row){
  const category=row.kind==='tcp'?tcpOperationCategory(row.operation,row.category):row.category||row.operation||row.state;
  const parts=[label(row.kind),row.provider||row.host||row.process||'',label(category),row.status?'HTTP '+row.status:'',row.durationMs!==undefined?ms(row.durationMs):''];return parts.filter(Boolean).join(' · ');
}
async function select(row){
  const selectedGeneration=++detailGeneration;detailController?.abort();detailController=new AbortController();
  selection=row.id;for(const button of $('records').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.id===row.id));
  const detail=$('detail');detail.replaceChildren(node('h4',describe(row)));
  if(row.kind==='incident'&&!row.evidence){
    detail.append(node('p','正在解密此现场的证据…'));
    try{const params=new URLSearchParams({id:row.id,from:filters.get('from'),to:filters.get('to')}),value=await api('/api/diagnostics/event?'+params,{signal:AbortSignal.any([detailController.signal,AbortSignal.timeout(15000)])});if(selectedGeneration!==detailGeneration)return;const event=value.rows[0];if(!event)throw new Error('此现场不在当前授权范围内。');select(event);}catch(error){if(selectedGeneration===detailGeneration)detail.replaceChildren(node('p',error.name==='AbortError'?'读取超时，请重新选择此记录。':error.message));}return;
  }
  detail.append(facts([['时间',recordTime(row)],['状态',label(row.state||row.category)],['网关 / Harness',[gatewayName(row.gateway),harnessName(row.harness)].filter(Boolean).join(' / ')||'未提供'],['请求阶段',row.phaseEvidence==='unavailable'?'缺少失败阶段日志，来源未提供分阶段耗时':row.phaseEvidence==='gateway_trace'?'有 Magpie 分阶段时序':'见下方证据']]));
  if(row.historicalImport)detail.append(node('p','这条记录由已有日志补齐，发生时间取自原日志；补读不会触发新的故障现场。'));
  if(row.timeSource==='unknown')detail.append(node('p','旧版采集器只留下读取时间，发生时间无法确认。此记录不作为实时故障或精确日期授权的证据。'));
  if(row.kind==='request'){
    detail.append(facts([['中转域名',row.host||'这条记录未保存目标域名']]));
    if(row.schemaVersion!==2)detail.append(node('p','这条旧版请求的重试可能不完整；仅在原日志仍存在时才能补回。'));
    if(row.coverage){const names={available:'已采到',missing:'缺失',not_exposed:'来源不提供',same_target_window:'已找到同一目标和时段的 TCP 元数据',no_matching_tcp:'未匹配到同期目标 TCP',collector_unavailable:'当时系统取证不可用',target_unknown:'尚未映射目标地址',before_collection:'历史补读，未逐次核对同期 TCP',unknown:'尚未检查'};detail.append(facts([['分阶段完整性',names[row.coverage.phase]||'未知'],['系统证据',names[row.coverage.system]||'未知'],['重试记录',row.coverage.retries==='attempts'?'Magpie 逐次尝试':row.coverage.retries==='request_summary_only'?'仅网关请求汇总':'未知']]));}
    if(row.captureReasons?.length)detail.append(node('p','取证原因：'+row.captureReasons.map(label).join(' · ')+'。慢请求即使成功也会自动保留现场；它不等于网络连接失败。'));
    detail.append(facts([['尝试',row.attempt===null?'来源未提供':String(row.attempt)],['总耗时',ms(row.durationMs)],['首字耗时',ms(row.ttftMs)],['连接复用',row.reused===true?'是':row.reused===false?'否':'未知']]));
    const bars=node('div','','stage-bars'),stages={dns:'DNS',connect:'TCP',tls:'TLS',send:'上传',wait:'等待',head:'到响应头'},max=Math.max(1,...Object.values(row.timings||{}).filter(Number.isFinite));
    for(const [key,title]of Object.entries(stages)){const stage=node('div','','stage-row'),meter=node('meter');meter.min=0;meter.max=max;meter.value=row.timings?.[key]||0;meter.setAttribute('aria-label',title);stage.append(node('span',title),meter,node('span',ms(row.timings?.[key])));bars.append(stage);}detail.append(bars);
    detail.append(node('p','取消、429、503 单独归类。没有失败阶段时，不能用后一次成功尝试的时序代替。'));
  }
  if(row.kind==='incident'){
    if(row.legacyEvidence)detail.append(node('p','这是修复前生成的旧现场，可能混有补读日志和探针错误。请以可确认时间的真实请求为准，不能把旧触发项直接当作新故障。'));
    if(row.collectorTestArtifact)detail.append(node('p','此现场由安装验收时探测器的参数兼容错误触发，不能作为业务网络故障证据。已保留原始错误类型，修复后的探测单独记录。'));
    detail.append(node('p',row.conclusion),node('p','已保留 '+row.evidence.length+' 条可访问证据；容量淘汰 / 截断 '+(row.ringEvictions||0)+'。'+(row.state==='recording'?'仍在补充后续 5 分钟。':'')));
    const retrySummary=summarizeTcpRetries(row.evidence);
    if(retrySummary.retries){
      const summary=node('section','','tcp-retry-summary');summary.append(node('strong','TCP 建连重试 '+retrySummary.retries+' 次 · '+retrySummary.connections+' 个连接'),node('p','以下是本现场内的系统建连重试。结合进程和目标查看，重试不等于请求最终失败。'));
      for(const flow of retrySummary.flows.slice(0,8))summary.append(node('p',flow.process+' → '+(flow.host||flow.destination)+':'+flow.destinationPort+' · 源端口 '+flow.sourcePort+' · '+flow.count+' 次 · '+date.format(flow.firstAt)+' — '+date.format(flow.lastAt)));
      if(retrySummary.flows.length>8)summary.append(node('p','其余连接可在下方时间线查看。'));detail.append(summary);
    }
    const timeline=node('div','','timeline'),switches=node('div','','evidence-switches'),keyButton=node('button','关键证据','quiet-button'),allButton=node('button','完整时间线','quiet-button'),more=node('button','加载后续证据','quiet-button');
    for(const button of [keyButton,allButton,more])button.type='button';switches.append(keyButton,allButton);
    const keyEvidence=row.evidence.filter(event=>event.kind==='tcp'?['tcp_connect_retry','tcp_fail','retransmit'].includes(tcpOperationCategory(event.operation,event.category)):event.fault||event.captureReasons?.length||event.kind==='mark');
    let limit=0,visible=keyEvidence.length?keyEvidence:row.evidence,onlyKey=keyEvidence.length>0;
    const render=()=>{for(const event of visible.slice(limit,limit+100)){const retry=event.kind==='tcp'&&tcpOperationCategory(event.operation,event.category)==='tcp_connect_retry',item=node('div','',retry?'tcp-retry':'');item.append(node('time',recordTime(event)),node('strong',describe(event)));if(event.kind==='tcp'&&event.source&&event.destination)item.append(node('p',event.source+(event.sourcePort?':'+event.sourcePort:'')+' → '+event.destination+(event.destinationPort?':'+event.destinationPort:'')+(retry?' · '+(event.count||1)+' 次建连重试':'')));if(event.phaseEvidence==='unavailable')item.append(node('p','失败阶段未知'));timeline.append(item);}limit+=100;more.hidden=limit>=visible.length;};
    const choose=key=>{onlyKey=key;visible=key?keyEvidence:row.evidence;limit=0;timeline.replaceChildren();keyButton.setAttribute('aria-pressed',String(key));allButton.setAttribute('aria-pressed',String(!key));keyButton.textContent='关键证据（'+keyEvidence.length+'）';allButton.textContent='完整时间线（'+row.evidence.length+'）';render();};
    keyButton.addEventListener('click',()=>choose(true));allButton.addEventListener('click',()=>choose(false));more.addEventListener('click',render);choose(onlyKey);detail.append(switches,timeline,more);
  }else if(row.kind!=='request'){
    const more=node('details'),summary=node('summary','查看已采集字段'),pre=node('pre',JSON.stringify(row,null,2));more.append(summary,pre);detail.append(more);
  }
  if(row.category==='pktmon_attachment'){
    const download=node('button','下载已解密的 PktMon 事件附件','quiet-button');download.type='button';download.addEventListener('click',async()=>{download.disabled=true;try{const value=await api('/api/diagnostics/attachment?'+new URLSearchParams({id:row.id})),bytes=Uint8Array.from(atob(value.bytes),char=>char.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes])),link=node('a');link.href=url;link.download=value.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){message(error.message);}finally{download.disabled=false;}});detail.append(download,node('p','此操作将受保护的事件元数据解密为本地 ETL 文件，请自行保管。AI 卡必须具有导出权限并覆盖附件完整时间段。'));
    const remove=node('button','删除此原始事件附件','quiet-button');remove.type='button';remove.addEventListener('click',async()=>{if(!confirm('删除后不能恢复该 ETL 附件。请求记录和故障元数据仍然保留，确定删除？'))return;remove.disabled=true;try{await api('/api/diagnostics/attachment/delete',{body:{id:row.id}});detail.append(node('p','附件已删除，原故障与请求记录保留。'));download.disabled=true;}catch(error){remove.disabled=false;message(error.message);}});detail.append(remove);
  }
}
async function refresh({apply=false,force=false}={}){
  if(busy&&!apply&&!force)return;
  let queryFilters,candidate;
  try{candidate=apply?readControls():applied;queryFilters=page===0||apply?filterParams(candidate):new URLSearchParams(filters);}catch(error){message(error.message);return;}
  const current=++generation;controller?.abort();clearTimeout(indexTimer);controller=new AbortController();
  const activeController=controller,timeout=setTimeout(()=>activeController.abort(),15000);busy=true;$('records').setAttribute('aria-busy','true');$('refresh').disabled=true;
  if(apply){applied=candidate;packet=null;$('matchCount').textContent='—';$('requestCount').textContent='—';$('faultCount').textContent='—';$('activeFilters').textContent=describeFilters(applied);$('listTitle').textContent=$('kind').selectedOptions[0].textContent;$('listHint').textContent='正在应用筛选…';$('records').replaceChildren(node('p','正在读取匹配记录…','record-empty'));$('previous').disabled=true;$('next').disabled=true;updateDraftHint();}
  if(apply){page=0;renderedPage=0;cursors=[null];$('page').textContent='第 1 页';clearDetail();}
  try{
    const params=new URLSearchParams(queryFilters);if(cursors[page])params.set('cursor',JSON.stringify(cursors[page]));
    const checkParams=new URLSearchParams({from:queryFilters.get('from'),to:queryFilters.get('to'),kind:'status',category:'collection_health',limit:'1'});
    const [records,status,checks]=await Promise.allSettled([api('/api/diagnostics?'+params,{signal:activeController.signal}),api('/api/diagnostics/status',{signal:activeController.signal}),api('/api/diagnostics?'+checkParams,{signal:activeController.signal})]);
    if(current!==generation)return;
    if(records.status==='fulfilled'){
      filters=queryFilters;renderedPage=page;renderList(records.value);message('');
      if(records.value.filterIndexPending&&page===0&&!document.hidden)indexTimer=setTimeout(()=>refresh(),750);
    }else{
      page=renderedPage;message(records.reason.name==='AbortError'?'读取超时，请稍后刷新。':records.reason.message);
      if(apply){$('records').replaceChildren(node('p','暂时未能读取匹配记录，请点击“刷新”重试。','record-empty'));$('listHint').textContent='此次筛选尚未加载完成';}
    }
    if(status.status==='fulfilled')renderStatus(status.value);
    if(checks.status==='fulfilled')renderCollection(checks.value);
  }catch(error){if(current===generation)message(error.message);}finally{clearTimeout(timeout);if(current===generation){busy=false;$('refresh').disabled=false;$('records').setAttribute('aria-busy','false');}}
}
$('filters').addEventListener('submit',event=>{event.preventDefault();refresh({apply:true});});
$('filters').addEventListener('input',updateDraftHint);
$('filters').addEventListener('change',event=>{
  if(event.target.id==='range'){
    for(const id of ['fromLabel','toLabel'])$(id).hidden=$('range').value!=='custom';
    if($('range').value==='custom'&&!$('from').value){const local=value=>new Date(value+8*3600000).toISOString().slice(0,16);$('from').value=local(Date.now()-3600000);$('to').value=local(Date.now());}
  }
  if(event.target.id==='kind')updateCategories({preserve:false,facets:packet?.facets});updateDraftHint();
});
$('refresh').addEventListener('click',()=>refresh({force:true}));
$('resetFilters').addEventListener('click',()=>{$('filters').reset();updateCategories({preserve:false});for(const id of ['fromLabel','toLabel'])$(id).hidden=true;refresh({apply:true});});
$('showChecks').addEventListener('click',()=>{$('kind').value='status';updateCategories({preserve:false});$('category').value='collection_health';for(const id of ['provider','harness','gateway'])$(id).value='';refresh({apply:true});});
$('next').addEventListener('click',()=>{if(packet?.next&&!busy){cursors[++page]=packet.next;refresh();}});$('previous').addEventListener('click',()=>{if(page>0&&!busy){page--;refresh();}});
$('mark').addEventListener('click',async()=>{if(busy)return;$('mark').disabled=true;try{const result=await api('/api/diagnostics/mark',{body:{}});message('已标记 '+date.format(result.at)+'，后台正在保留故障前后现场。');}catch(error){message(error.message);}finally{$('mark').disabled=false;}});
$('export').addEventListener('click',async()=>{
  if(!packet||busy)return;try{const params=new URLSearchParams(filters);if(cursors[page])params.set('cursor',JSON.stringify(cursors[page]));params.set('export','1');const report=await api('/api/diagnostics?'+params),blob=new Blob([JSON.stringify({format:'trafficwatch-ai-diagnostics',generatedAt:Date.now(),scope:'当前筛选与当前页',...report},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=node('a');anchor.href=url;anchor.download='trafficwatch-ai-diagnostics.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){message(error.message);}
});
updateCategories();
try{const status=await initializeVault({overview:true,onStatus:value=>{
  const previous=vaultState;vaultState=value;const state=value.backgroundImport?.state;
  const text=importProgressText(value.backgroundImport);$('importNotice').hidden=!text;if($('importNotice').textContent!==text)$('importNotice').textContent=text;
  if(previous&&(!previous.ready&&value.ready||previous.backgroundImport?.state==='running'&&state==='complete'))refresh();
}});if(!status.configured)location.replace('/security');else{await refresh({apply:true});refreshTimer=setInterval(()=>{if(!document.hidden&&page===0)refresh();},30000);}}catch{message('无法连接本机服务，请从桌面流量控制台检查运行状态。');}
document.addEventListener('visibilitychange',()=>{if(document.hidden){controller?.abort();clearTimeout(indexTimer);}else refresh({force:true});});window.addEventListener('pagehide',()=>{clearInterval(refreshTimer);clearTimeout(indexTimer);controller?.abort();detailController?.abort();});
