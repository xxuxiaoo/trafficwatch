const lanes={windows:'本机',clash:'梯子'};
const stages={opening:'打开加密记录',totals:'读取流量总量',program_buckets:'合并所选时段的连接记录',programs:'汇总应用与 Harness 归因',routes:'汇总连接出口',timeline:'生成时段图表',selection:'读取所选连接',summary:'汇总所选连接',connections:'读取连接明细'};
function elapsedText(ms){
  const seconds=Math.max(0,Math.floor(ms/1000));
  return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';
}
export function queryProgressView(packet,elapsedMs=0){
  const query=packet?.query,initialization=packet?.initialization;
  const elapsed='已用 '+elapsedText(Math.max(elapsedMs,query?.elapsedMs||0));
  if(initialization?.phase==='index')return {text:(lanes[initialization.lane]||'历史')+' · 首次创建应用查询索引，后续解锁会复用 · '+elapsed,determinate:false};
  if(packet?.ready===false)return {text:'正在打开加密历史 · '+elapsed,determinate:false};
  if(query?.state==='queued'){
    const blocker=query.blocker;
    const waiting=blocker?.stage==='reader_restart'?'统计读取线程正在重启':blocker?`正在等待${lanes[blocker.lane]?lanes[blocker.lane]+' · ':''}${stages[blocker.stage]||'前一项统计'}完成${Number.isFinite(blocker.elapsedMs)?'（已运行 '+elapsedText(blocker.elapsedMs)+'）':''}`:'统计查询即将开始';
    return {text:`${waiting} · 当前排第 ${query.position} 项 · ${elapsed}`,determinate:false};
  }
  const stage=stages[query?.stage]||'读取统计结果',prefix=lanes[query?.lane]?lanes[query.lane]+' · ':'';
  if(query?.state==='running'){
    const counted=Number.isSafeInteger(query.done)&&Number.isSafeInteger(query.total)&&query.total>0&&query.done>=0&&query.done<=query.total;
    const count=counted?' · '+query.done.toLocaleString('zh-CN')+' / '+query.total.toLocaleString('zh-CN')+' 条归因记录（'+Math.floor(query.done/query.total*100)+'%，当前阶段）':'';
    return {text:prefix+stage+count+' · '+elapsed,determinate:counted,done:query.done,total:query.total};
  }
  return {text:'正在读取统计结果 · '+elapsed,determinate:false};
}

// Idle capture continues importing small envelopes. Only a real backlog or a
// newly opened vault should request an extra overview refresh.
export function createImportRefreshTracker(){
  let initialized=false,previousReady=false,backlog=false;
  return value=>{
    const progress=value.backgroundImport,needsCatchup=progress?.state==='paused'||progress?.state==='running'&&(progress.remaining===undefined||progress.remaining===null||progress.remaining>=16);
    const refresh=initialized&&(!previousReady&&value.ready||backlog&&progress?.state==='complete');
    previousReady=value.ready;initialized=true;
    if(needsCatchup)backlog=true;else if(progress?.state==='complete')backlog=false;
    return Boolean(refresh);
  };
}
