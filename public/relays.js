import {diagnosticHealth} from './diagnostic-health.mjs';

const $=id=>document.getElementById(id);
const labels={verified:'IPv4 绕行已验证',checking:'正在解析与核验',route_checked:'路由已更新，等待核验',degraded:'部分目标未通过核验',stale:'状态过期，请重新校验',rolled_back:'已撤回受管绕行',stopped:'后台已停止'};
const errorText={invalid_relay_host:'请输入有效的中转域名或完整 HTTP(S) API 地址。',invalid_relay_name:'名称不能为空，且最多 80 个字符。',invalid_relay_targets:'中转列表最多保存 64 项。',duplicate_relay_target:'域名重复，请检查列表。',relay_config_conflict:'其他页面已修改列表，已刷新；请核对后重新保存。',relay_config_unreadable:'配置文件无法安全读取，请检查本机配置。',relay_target_not_found:'列表已更新，请刷新后重试。',relay_backup_not_found:'找不到这个备份，可能已被移走。',invalid_relay_backup:'备份编号无效。',relay_resolution_incomplete:'有新目标未能解析，保留此前已应用的路径；请核对域名后重试。',physical_dns_unavailable:'物理网卡 DNS 暂时不可用',clash_controller_unavailable:'无法连接当前 Clash 控制器',relay_route_verification_failed:'Windows 路由核验未通过',physical_adapter_unavailable:'没有找到可用物理网卡',managed_hosts_modified:'受管 hosts 区块被其他程序改过，请检查后重试。'};
const clock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
let state={targets:[],backups:[]},editing='',busy=false,reading=false,poll,lastSignature='';

function message(text,error=false){$('message').textContent=text;$('message').hidden=!text;$('message').dataset.error=String(error);}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function setBusy(value){
  busy=value;
  for(const node of document.querySelectorAll('button,input,select'))node.disabled=value;
  $('restore').disabled=value||!$('backup').value;
}
async function api(body){
  const payload=body?{...body,...(state.revision?{revision:state.revision}:{})}:undefined;
  const response=await fetch('/api/relay-targets',{method:payload?'POST':'GET',headers:{'x-codex-flow':'1',...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),cache:'no-store',signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'relay_operation_failed');return value;
}
function targetHealth(target){
  if(!target.enabled)return state.applied?.targets?.some(row=>row.host===target.host)?'等待撤回':'已停用';
  if(state.disabled)return '后台停止，等待应用';
  const applied=state.applied?.targets?.find(row=>row.host===target.host),check=state.applied?.checks?.find(row=>row.host===target.host);
  if(!applied)return '等待解析与应用';
  if(state.status?.state==='stale')return '状态过期';
  if(state.pending)return '列表已变更，等待核验';
  if(state.status?.state==='degraded'&&state.status.error)return '最近核验失败，详见上方原因';
  if(state.status?.state==='checking'&&state.status.previousState!=='verified')return '正在重新核验';
  if(applied.stale)return 'DNS 结果过期';
  if(applied.ipv6Unmanaged&&applied.ipv6Available)return 'IPv6 路径未覆盖';
  if(check?.seenInClash)return '仍在 Clash 中';
  if(check?.probe?.errorType)return '连接探测未完成';
  return check?.verified?'物理路径已验证':'等待连接验证';
}
function targetRow(target){
  const row=element('div',undefined,'relay-item');row.dataset.id=target.id;
  const identity=element('div');identity.append(element('span',target.name,'relay-target-name'),element('span',target.host,'relay-target-host'));
  const applied=state.applied?.targets?.find(item=>item.host===target.host);
  if(applied?.ips?.length)identity.append(element('small','IPv4 '+applied.ips.join(' · '),'relay-target-address'));
  const health=element('span',targetHealth(target),'relay-target-health');
  const enable=element('label',undefined,'relay-enable'),toggle=element('input');toggle.type='checkbox';toggle.checked=target.enabled;toggle.setAttribute('aria-label','启用 '+target.name+' 的物理绕行');
  toggle.addEventListener('change',()=>{const enabled=toggle.checked;mutate(async()=>{await api({action:'save',targets:state.targets.map(item=>item.id===target.id?{...item,enabled}:item)});message(enabled?'已启用，后台正在核验路径。':'已停用，后台正在撤回此目标的受管绕行。');});});
  enable.append(toggle,document.createTextNode('绕行'));
  const actions=element('div',undefined,'relay-row-actions'),edit=element('button','编辑'),remove=element('button','删除');edit.type=remove.type='button';
  edit.addEventListener('click',()=>{editing=target.id;$('name').value=target.name;$('host').value=target.host;$('saveTarget').textContent='保存修改';$('cancelEdit').hidden=false;$('name').focus();});
  remove.addEventListener('click',()=>{if(!window.confirm('删除“'+target.name+'”并撤回它的受管物理绕行？'))return;mutate(async()=>{await api({action:'delete',id:target.id});if(editing===target.id)resetForm();message('已删除并备份列表，后台正在清理受管配置。');});});
  actions.append(edit,remove);row.append(identity,health,enable,actions);return row;
}
function render(){

  const signature=JSON.stringify(state);
  if(signature!==lastSignature){
    lastSignature=signature;
    $('targets').replaceChildren(...(state.targets.length?state.targets.map(targetRow):[element('p','没有受管目标。添加中转后即可启用物理绕行。','relay-empty')]));
    const selected=$('backup').value;
    $('backup').replaceChildren(new Option('选择一个列表备份',''),...state.backups.map(item=>new Option(clock.format(item.createdAt)+' · '+item.targets+' 个目标',item.id)));
    $('backup').value=state.backups.some(item=>item.id===selected)?selected:'';
  }
  $('listSummary').textContent=state.targets.length+' 个目标 · '+state.targets.filter(target=>target.enabled).length+' 个启用';
  const status=state.disabled?'stopped':state.status?.state==='degraded'?'degraded':state.pending?'pending':state.status?.state||'none';
  $('status').textContent=status==='pending'?'列表已保存，等待后台应用':labels[status]||'尚未获取后台状态';$('status').dataset.state=status;
  const adapter=state.applied?.adapter,parts=[];
  if(adapter)parts.push('物理网卡 '+adapter.name+' · '+adapter.address);
  if(state.status?.at)parts.push('最后检查 '+clock.format(state.status.at));
  if(state.status?.error||state.status?.client)parts.push(diagnosticHealth({bypass:state.status}).bypass.detail);
  if(state.disabled)parts.push('后台暂停中；恢复流量采集后会继续处理列表。');
  $('pathDetail').textContent=parts.join('　');
  setBusy(busy);
}
async function loadState(){const value=await api();state=value;render();}
async function refresh(){if(busy||reading)return;reading=true;try{await loadState();}catch(error){message('无法读取中转配置：'+(errorText[error.message]||error.message),true);}finally{reading=false;}}
async function mutate(operation){
  if(busy)return;setBusy(true);
  try{await operation();await loadState();}catch(error){message('操作失败：'+(errorText[error.message]||error.message),true);try{await loadState();}catch{}}
  finally{setBusy(false);}
}
function resetForm(){editing='';$('targetForm').reset();$('saveTarget').textContent='添加';$('cancelEdit').hidden=true;}
$('targetForm').addEventListener('submit',event=>{
  event.preventDefault();const name=$('name').value.trim(),host=$('host').value.trim(),wasEditing=Boolean(editing),targets=[...state.targets];
  if(editing){const index=targets.findIndex(target=>target.id===editing);if(index<0){message('这条目标已被其他页面删除，请刷新列表。',true);return;}targets[index]={...targets[index],name,host};}
  else targets.push({id:crypto.randomUUID(),name,host,enabled:true});
  mutate(async()=>{await api({action:'save',targets});resetForm();message(wasEditing?'修改已保存，后台正在核验。':'已添加新中转，后台正在解析并核验路径。');});
});
$('cancelEdit').addEventListener('click',resetForm);
$('apply').addEventListener('click',()=>mutate(async()=>{await api({action:'apply'});message('已请求后台立即解析并核验路径，结果会自动更新。');}));
$('disableAll').addEventListener('click',()=>{if(!window.confirm('停用所有中转并撤回 TrafficWatch 添加的绕行配置？当前列表会先自动备份。'))return;mutate(async()=>{await api({action:'disable-all'});resetForm();message('已备份并停用全部目标，后台正在撤回受管绕行。');});});
$('restore').addEventListener('click',()=>{const id=$('backup').value;if(!id||!window.confirm('恢复这个备份列表？当前列表会先自动备份。'))return;mutate(async()=>{await api({action:'restore',id});resetForm();message('已恢复备份并保留当前版本，后台正在重新核验。');});});
$('backup').addEventListener('change',()=>{$('restore').disabled=busy||!$('backup').value;});$('refresh').addEventListener('click',refresh);
await refresh();
poll=setInterval(()=>{if(!document.hidden)refresh();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('pagehide',()=>clearInterval(poll));
