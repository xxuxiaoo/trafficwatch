const $=id=>document.getElementById(id),laneName=lane=>lane==='windows'?'本机应用':'Clash / 梯子';
const format=new Intl.NumberFormat('zh-CN'),date=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const bytes=value=>{if(value===null||value===undefined)return '—';const units=['B','KiB','MiB','GiB','TiB'];let index=0;while(Math.abs(value)>=1024&&index<4){value/=1024;index++;}return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:index?1:0}).format(value)+' '+units[index];};
const node=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
const errorNames={storage_busy:'已有整理任务在运行。',storage_no_history:'首次采集完成后即可查看磁盘占用。',archive_corrupt:'归档校验未通过。',invalid_storage_policy:'请选择有效的保留天数。'};
let data,busy=false,policyEdited=false,monthLimit=24,lastSignature='',lastJobState='',pollTimer;
function message(text){$('message').textContent=text;$('message').hidden=!text;}
async function api(route,body){
  const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'x-codex-flow':'1',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(!response.ok)throw new Error(errorNames[value.error]||'操作未完成（'+(value.error||response.status)+'），请稍后重试。');return value;
}
function renderJob(job){
  const running=job?.state==='running';
  for(const id of ['archive','compact','purge','save'])$(id).disabled=running;
  const operation=job?.operation==='compact'?'回收数据库空页':job?.operation==='purge-cache'?'清理缓存':'无损归档';
  const stages={preparing:'正在准备',archive:'正在压缩旧记录',copy:'正在复制数据',compact:'正在分批回收空页',indexes:'正在整理数据库结构',verify:'正在完整校验',complete:'已完成'};
  const elapsed=job?.startedAt?Math.max(0,Math.floor(((running?Date.now():job.updatedAt)-job.startedAt)/1000)):0;
  $('job').textContent=!job?'等待下次自动检查。':running?operation+' · '+(stages[job.stage]||'正在处理')+(job.lane?' · '+laneName(job.lane):'')+' · '+Math.floor(elapsed/60)+' 分 '+elapsed%60+' 秒':job.state==='completed'?operation+'已完成。':job.state==='paused'?'整理已暂停。':errorNames[job.error]||'整理暂未完成；原记录保留，请稍后重试。';
  const result=job?.result;
  $('jobDetail').textContent=result?.lanes?'本次回收 '+bytes(result.lanes.reduce((n,lane)=>n+lane.reclaimedBytes,0))+(result.lanes.some(lane=>lane.reusableOnly)?'。部分旧库会继续复用空页。':'。'):job?.operation==='purge-cache'&&job.state==='completed'?'摘要缓存已清空，下次按需重建。':job?.moved||result?.moved?'已整理 '+format.format(result?.moved||job.moved)+' 行，内容从 '+bytes(result?.rawBytes||job.rawBytes)+' 压缩到 '+bytes(result?.compressedBytes||job.compressedBytes)+'。':job?.state==='completed'?'目前没有达到整理期限的记录。':'';
}
function renderMonths(){
  const filter=$('archiveLane').value,rows=data.lanes.flatMap(lane=>lane.archives.months.map(month=>({...month,lane:lane.lane}))).filter(month=>filter==='all'||filter===month.lane).sort((a,b)=>b.month.localeCompare(a.month)||a.lane.localeCompare(b.lane));
  const fragment=document.createDocumentFragment();
  for(const month of rows.slice(0,monthLimit)){
    const tr=node('tr');for(const value of [month.month+' · '+laneName(month.lane),format.format(month.rows),bytes(month.rawBytes),bytes(month.compressedBytes),month.rawBytes?Math.round((1-month.compressedBytes/month.rawBytes)*100)+'%':'—'])tr.append(node('td',value));
    const td=node('td'),link=node('a','查看记录');const day=new Date(month.firstAt+8*3600000).toISOString().slice(0,10);link.href='/?range=day&date='+day+'#'+(month.lane==='windows'?'apps':'ladder');link.title='从 '+day+' 开始查看，也可在总览中另选日期';td.append(link);tr.append(td);fragment.append(tr);
  }
  if(!rows.length){const td=node('td','还没有旧数据需要归档。达到设置期限后会自动按月整理。');td.colSpan=6;const tr=node('tr');tr.append(td);fragment.append(tr);}
  $('months').replaceChildren(fragment);$('moreMonths').hidden=rows.length<=monthLimit;
}
function render(value){
  data=value;renderJob(value.job);
  const signature=JSON.stringify({...value,job:undefined});if(signature===lastSignature)return;lastSignature=signature;
  $('total').textContent=bytes(value.totalBytes);$('available').textContent=bytes(value.disk.availableBytes);$('reusable').textContent=bytes(value.reusableBytes);$('growth').textContent=bytes(value.dailyGrowthBytes);
  $('capacity').textContent=value.disk.capacityBytes===null?'系统未提供磁盘容量':'数据盘总容量 '+bytes(value.disk.capacityBytes);
  $('updated').textContent='占用快照 '+time.format(value.generatedAt);$('forecast').textContent=value.daysRemaining===null?'积累一天后按净增长估算':value.daysRemaining>3650?'当前净增长较低，暂不估算满盘日期':'按当前净增长约可用 '+format.format(value.daysRemaining)+' 天';
  const warningNames={disk_low:'数据盘剩余空间较少，请留意容量。',capacity_soon:'按近期净增长，可用空间可能不足 60 天。',scan_incomplete:'部分文件未计入，当前占用只是已统计部分。'};
  $('warnings').textContent=value.warnings.map(w=>warningNames[w]||w).join(' ');$('warnings').hidden=!value.warnings.length;
  const parts=[['流量历史',value.databaseBytes],['AI 连接诊断',value.diagnosticBytes||0],['可重建缓存',value.cacheBytes],['旧版恢复文件',value.backupBytes]];
  $('components').replaceChildren(...parts.map(([name,size])=>{const row=node('div'),meter=node('meter');meter.min=0;meter.max=Math.max(1,value.totalBytes);meter.value=size;meter.setAttribute('aria-label',name+'占用');row.append(node('span',name),meter,node('strong',bytes(size)));return row;}));
  if(!policyEdited){$('onlineDays').value=String(value.policy.onlineDays);$('enabled').checked=value.policy.enabled;}
  $('lanes').replaceChildren(...value.lanes.map(lane=>{
    const card=node('div'),dl=node('dl'),archives=lane.archives;
    const fields=[['文件实际占用',bytes(lane.physicalBytes)],['近期样本',format.format(lane.online.samples)+' 行'],['近期日期',lane.online.firstAt===null?'暂无':date.format(lane.online.firstAt)+' — '+date.format(lane.online.lastAt)],['已归档明细',format.format(archives.rows)+' 行 / '+archives.months.length+' 个月']];
    for(const [name,content]of fields)dl.append(node('dt',name),node('dd',content));card.append(node('h3',laneName(lane.lane)),dl);return card;
  }));
  $('backups').replaceChildren(...(value.backupFiles.length?value.backupFiles.map(file=>node('p',file.name+' · '+bytes(file.bytes)+' · '+date.format(file.modifiedAt)+(file.managed?' · 固定恢复副本':''))):[node('p','暂无迁移恢复备份。')]));renderMonths();
}
async function refresh(fresh=false){
  if(busy)return;busy=true;$('refresh').disabled=true;
  try{
    const value=await api('/api/storage'+(fresh?'?fresh=1':''));render(value);
    const state=value.job?.state||'';
    if(lastJobState==='running'&&state!=='running'&&!fresh){lastJobState=state;busy=false;await refresh(true);return;}
    lastJobState=state;
  }catch(error){message(error.name==='TimeoutError'?'读取占用超时。后台任务会继续，可以稍后刷新。':error.message);}finally{busy=false;$('refresh').disabled=false;}
}
async function start(operation){
  for(const id of ['archive','compact','purge'])$(id).disabled=true;
  try{const result=await api('/api/storage/'+operation,{});renderJob(result.job);message('任务已在后台开始，可以离开此页；稍后回来查看结果。');lastJobState='running';await refresh();}
  catch(error){message(error.message);renderJob(data?.job);}
}
$('refresh').addEventListener('click',()=>refresh(true));$('archive').addEventListener('click',()=>start('run'));$('purge').addEventListener('click',()=>start('cache'));$('compact').addEventListener('click',()=>start('compact'));
for(const id of ['onlineDays','enabled'])$(id).addEventListener('change',()=>{policyEdited=true;});
$('policy').addEventListener('submit',async event=>{event.preventDefault();$('save').disabled=true;try{await api('/api/storage/policy',{onlineDays:Number($('onlineDays').value),enabled:$('enabled').checked});policyEdited=false;message('设置已保存。所有历史继续无限保留；可以点击“立即整理旧记录”应用本次设置。');await refresh(true);}catch(error){message(error.message);}finally{$('save').disabled=false;}});
$('archiveLane').addEventListener('change',()=>{monthLimit=24;renderMonths();});$('moreMonths').addEventListener('click',()=>{monthLimit+=24;renderMonths();});
await refresh(true);
pollTimer=setInterval(()=>{if(!document.hidden)refresh();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('pagehide',()=>clearInterval(pollTimer));
