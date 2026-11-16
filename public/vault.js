import {initializeVault,vaultHeaders,setVaultToken,hasVaultToken,safeReturnTarget,importProgressText} from './vault-browser.mjs';
const $=id=>document.getElementById(id),dates=new Set(),windows=[];
const returnTarget=safeReturnTarget(new URLSearchParams(location.search).get('return'));
let status,requestSignature='',setupNonce=new URLSearchParams(location.hash.slice(1)).get('setup')||'',recoveryPending=false;
history.replaceState(null,'',location.pathname+location.search);
const time=at=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(at);
const errors={wrong_password:'密码或恢复码不正确。',windows_unlock_required:'请先解锁 Windows。',vault_locked:'界面已锁定，请重新输入密码。',setup_launcher_required:'请从桌面流量控制台点击“设置加密”，再设置密码。',password_too_short:'密码至少需要 10 个字符。',unlock_rate_limited:'请稍等几秒再尝试。',vault_migrating:'历史正在加密，请稍后再操作。',vault_collectors_need_update:'采集器尚未切换到加密写入，请先安装当前版本。',ai_request_not_found:'该申请已经失效，请让 AI 重新申请。',invalid_authorized_dates:'请添加有效日期或时间段。'};
function message(text){$('message').textContent=text;$('message').hidden=!text;}
async function api(route,body){
  const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'x-codex-flow':'1',...vaultHeaders(),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const value=await response.json();if(!response.ok)throw new Error(errors[value.error]||value.error||'操作失败');return value;
}
function renderState(){
  const locked=status.locked||!hasVaultToken();
  const phase=status.initialization?.phase||(status.migration?'migration':'opening');
  $('stateLine').textContent=!status.configured?'尚未启用加密；原有记录仍是明文。':locked?'流量记录已锁定。':status.ready?status.plaintextCleanupPending?'历史已加密；旧明文仍待验证和清理。':'流量记录已解锁，加密保护正常。':phase==='migration'?'首次加密正在迁移原有历史…':phase==='import'?'正在导入锁定期间采集的加密记录…':'正在打开已加密的流量记录…';
  if(status.ready&&!locked&&importProgressText(status.backgroundImport))$('stateLine').textContent=importProgressText(status.backgroundImport);
  $('loginPanel').hidden=(!locked&&status.configured)||recoveryPending;
  $('managePanel').hidden=locked||!status.configured||recoveryPending;
  $('confirmLabel').hidden=status.configured;$('recoveryLabel').hidden=!status.configured;$('setupHint').hidden=status.configured;
  $('loginTitle').textContent=status.configured?'解锁流量记录':'设置流量记录密码';
  $('loginDescription').textContent=returnTarget?'输入密码后自动返回'+(returnTarget.startsWith('/storage')?'存储管理。':returnTarget.startsWith('/legacy')?'原版详情。':'流量页面。'):'锁屏后需要重新输入你的密码。采集仍在后台继续。';
  $('unlockButton').textContent=status.configured?'解锁':'启用加密';
  $('password').minLength=status.configured?0:10;$('confirmPassword').required=!status.configured;
  $('unlockButton').disabled=!status.configured&&!setupNonce;
  $('migrationPanel').hidden=status.ready||locked;
  $('migrationTitle').textContent=phase==='migration'?'首次加密原有历史':phase==='import'?'正在补齐锁定期间的记录':'正在打开加密记录';
  const progress=status.initialization||status.migration;
  const progressLane=progress?.lane==='windows'?'本机应用':'Clash';
  $('migrationText').textContent=progress?.error?'处理暂停：'+progress.error:phase==='migration'?'正在处理 '+progressLane+' 的 '+(progress?.table||'原有历史')+' 记录。':phase==='import'?'正在导入'+progressLane+'采集的加密记录，完成后即可查看。':'正在打开加密数据库，已有历史保持加密。';
  $('migrationHint').textContent=phase==='migration'?'首次迁移验证及明文清理完成前，旧文件仍可能包含未加密的历史。':'这是本次解锁的准备工作。'+(returnTarget?'完成后将自动返回原页面。':'请稍候。');
  $('cleanupPanel').hidden=!status.ready||!status.plaintextCleanupPending;
  const cleanup=status.cleanup,running=cleanup?.state==='running';
  $('cleanupButton').disabled=running;
  $('cleanupButton').textContent=running?'验证与清理正在后台进行…':['failed','paused'].includes(cleanup?.state)?'重试验证并清理':'验证并清理项目旧明文';
  const lane=cleanup?.lane==='windows'?'本机':cleanup?.lane==='clash'?'Clash':'';
  const stages={preparing:'正在准备后台任务',checkpoint:'正在固定'+lane+'加密数据库快照',copy:'正在复制'+lane+'加密备份',verify:'正在完整校验'+lane+'加密备份，大型数据库可能需要数分钟',remove:'两路备份已验证，正在清理旧明文'};
  const elapsed=cleanup?.startedAt?Math.floor((Date.now()-cleanup.startedAt)/1000):0;
  $('cleanupStatus').textContent=running?(stages[cleanup.stage]||'正在处理')+'。已用时 '+Math.floor(elapsed/60)+' 分 '+elapsed%60+' 秒。可以关闭页面，稍后回来查看；请勿重复提交。':cleanup?.state==='failed'?(cleanup.error==='vault_backup_busy'?'数据库快照暂时繁忙，请稍后重试。':'验证或清理未完成。校验通过前保留旧明文，可以重试。'):cleanup?.state==='paused'?'任务因锁定或服务重启暂停。解锁后可重试，已验证的备份会复用。':'';
  if(running)$('stateLine').textContent='正在验证加密备份与清理旧明文；后台采集继续加密写入。';
  if(returnTarget&&status.configured&&!locked&&status.ready&&!recoveryPending)location.replace(returnTarget);
}
function grantInput(){
  const kind=$('scopeKind').value;
  const scope=kind.startsWith('recent')?{kind:'recent',days:Number(kind.slice(6))}:kind==='dates'?{kind,dates:[...dates]}:kind==='windows'?{kind,windows:[...windows]}:{kind:'all'};
  return {name:$('grantName').value.trim(),lanes:[...document.querySelectorAll('[name=lane]:checked')].map(item=>item.value),permissions:[...document.querySelectorAll('[name=permission]:checked')].map(item=>item.value),scope,minutes:Number($('duration').value==='custom'?$('customDuration').value:$('duration').value),continueWhenLocked:$('continueLocked').checked};
}
const permissionNames={read:'查看',create:'添加备注',update:'修改备注',delete:'删除备注',export:'导出',rules:'全局分组规则',deleteHistory:'删除原始历史'};
function element(tag,text,className){const item=document.createElement(tag);if(text!==undefined)item.textContent=text;if(className)item.className=className;return item;}
async function loadRequests(){
  if(status.locked||!status.ready||recoveryPending)return;
  const data=await api('/api/vault/requests');
  const signature=JSON.stringify(data.requests);
  if(signature!==requestSignature){
    requestSignature=signature;const old=$('requestId').value;$('requestId').replaceChildren(element('option','选择一个 AI 申请…'));
    $('requestId').firstChild.value='';
    for(const request of data.requests.filter(request=>!request.approved)){const option=element('option',request.name+' · '+time(request.createdAt));option.value=request.id;$('requestId').append(option);}
    if(old&&[...$('requestId').options].some(option=>option.value===old))$('requestId').value=old;
    else if($('requestId').options.length===2)$('requestId').selectedIndex=1;
  }
  $('linkage').checked=data.linked;
  const fragment=document.createDocumentFragment();
  for(const grant of data.grants){
    const item=element('article',undefined,'grant-item'),heading=element('h3',grant.name);heading.append(element('span',grant.active?'有效':'已失效','badge'));item.append(heading);
    item.append(element('p',grant.lanes.map(lane=>({windows:'本机应用',clash:'梯子',diagnostics:'AI 连接诊断'}[lane]||lane)).join(' / ')+' · '+grant.permissions.map(permission=>permissionNames[permission]).join('、')));
    item.append(element('p','记录范围：'+grant.windows.map(window=>time(window.from)+' 至 '+time(window.to)).join('；')));
    item.append(element('p','到期：'+time(grant.expiresAt)+(grant.continueWhenLocked?' · 锁屏后继续':' · 锁屏时撤销')));
    if(grant.active){const button=element('button','撤销','secondary');button.type='button';button.addEventListener('click',()=>run(async()=>{await api('/api/vault/revoke',{id:grant.id});await loadRequests();}));item.append(button);}
    fragment.append(item);
  }
  if(!data.grants.length)fragment.append(element('p','暂无访客卡。'));$('grantList').replaceChildren(fragment);
}
async function run(action){message('');try{await action();}catch(error){message(error.message);}}
$('loginForm').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const password=$('password').value;if(!status.configured&&password!==$('confirmPassword').value)throw new Error('两次密码不一致。');
  $('unlockButton').disabled=true;
  try{
    const result=await api(status.configured?'/api/vault/unlock':'/api/vault/setup',status.configured?{password,recovery:$('useRecovery').checked}:{password,nonce:setupNonce});
    setVaultToken(result.token,result.sessionExpiresAt);setupNonce='';status=result;
    if(result.recoveryCode){recoveryPending=true;$('recoveryPanel').hidden=false;$('recoveryCode').textContent=result.recoveryCode;}
    renderState();await loadRequests();
  }finally{$('password').value=$('confirmPassword').value='';$('unlockButton').disabled=false;}
});});
$('copyRecovery').addEventListener('click',()=>run(async()=>{await navigator.clipboard.writeText($('recoveryCode').textContent);message('恢复码已复制，请保存到安全位置。');}));
$('recoverySaved').addEventListener('change',()=>{$('finishRecovery').disabled=!$('recoverySaved').checked;});
$('finishRecovery').addEventListener('click',()=>{recoveryPending=false;$('recoveryPanel').hidden=true;$('recoveryCode').textContent='';renderState();});
$('scopeKind').addEventListener('change',()=>{$('datePicker').hidden=$('scopeKind').value!=='dates';$('windowPicker').hidden=$('scopeKind').value!=='windows';});
function renderDates(){
  $('selectedDates').replaceChildren();for(const date of [...dates].sort()){const button=element('button',date+' ×');button.type='button';button.addEventListener('click',()=>{dates.delete(date);renderDates();});$('selectedDates').append(button);}
  $('selectedWindows').replaceChildren();windows.forEach((window,index)=>{const button=element('button',time(window.from)+' → '+time(window.to)+' ×');button.type='button';button.addEventListener('click',()=>{windows.splice(index,1);renderDates();});$('selectedWindows').append(button);});
}
$('addDate').addEventListener('click',()=>{if($('dateToAdd').value)dates.add($('dateToAdd').value);renderDates();});
$('addWindow').addEventListener('click',()=>run(async()=>{
  const from=Date.parse($('windowFrom').value+':00+08:00'),to=Date.parse($('windowTo').value+':00+08:00');
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from)throw new Error('请填写开始和结束时间。');
  windows.push({from,to});renderDates();
}));
$('duration').addEventListener('change',()=>{$('customDurationLabel').hidden=$('duration').value!=='custom';});
$('grantForm').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  await api('/api/vault/grants',{requestId:$('requestId').value,grant:grantInput()});$('grantStatus').textContent='访客卡已发出，AI 可按授权范围继续工作。';await loadRequests();
});});
$('linkage').addEventListener('change',()=>run(async()=>{const enabled=$('linkage').checked;await api('/api/vault/linkage',{enabled,template:grantInput()});$('linkStatus').textContent=enabled?'当前左侧设置已作为自动批准模板。锁屏后停止批准新申请。':'自动批准已关闭。';}));
for(const [id,force] of [['lockNow',false],['revokeAll',true]])$(id).addEventListener('click',()=>run(async()=>{await api('/api/vault/lock',{force});setVaultToken('');status=await api('/api/vault/status');renderState();}));
$('changePasswordForm').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  if($('newPassword').value!==$('newPasswordConfirm').value)throw new Error('两次新密码不一致。');
  try{await api('/api/vault/password',{password:$('newPassword').value});message('密码已更新。恢复码保持有效。');}finally{$('newPassword').value=$('newPasswordConfirm').value='';}
});});
$('loadAudit').addEventListener('click',()=>run(async()=>{const {rows}=await api('/api/vault/audit');$('auditList').replaceChildren(...rows.map(row=>element('p',time(row.at)+' · '+row.actor+' · '+row.action)));}));
$('cleanupButton').addEventListener('click',()=>run(async()=>{
  $('cleanupButton').disabled=true;
  try{
    const result=await api('/api/vault/cleanup',{});status=await api('/api/vault/status');
    if(result.cleanup&&!status.cleanup)status.cleanup=result.cleanup;renderState();
  }catch(error){
    status=await api('/api/vault/status').catch(()=>status);renderState();
    if(status.cleanup?.state!=='running')throw new Error(error.name==='TimeoutError'?'连接本机服务超时，请刷新查看任务状态后再决定是否重试。':error.message);
  }
}));
await run(async()=>{status=await initializeVault();renderState();await loadRequests();});
let polling=false;setInterval(async()=>{
  if(polling||document.hidden)return;polling=true;
  try{status=await api('/api/vault/status');if(status.locked){setVaultToken('');if(recoveryPending){recoveryPending=false;$('recoveryPanel').hidden=true;$('recoveryCode').textContent='';}}renderState();await loadRequests();}catch{}finally{polling=false;}
},2500);
