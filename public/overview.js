import {initializeVault,vaultHeaders,checkVaultResponse,importProgressText} from './vault-browser.mjs';
import {queryProgressView,createImportRefreshTracker} from './history-progress.mjs';
const $ = (id) => document.getElementById(id);
const importRefreshTracker=createImportRefreshTracker();
let vaultState;
await initializeVault({overview:true,onStatus:value=>{
  vaultState=value;renderImportState();
  if(importRefreshTracker(value)){if(refreshPromise)refreshAfterImport=true;else refresh(true);}
}});
function renderImportState(){
  const target=$('backgroundImportNotice');if(!target)return;
  const text=importProgressText(vaultState?.backgroundImport);
  target.hidden=!text;if(target.textContent!==text)target.textContent=text;
}
const pageNames = {
  overview: '流量总览',
  apps: '本机全部应用',
  ladder: '梯子流量',
  harness: 'Harness 用量',
  investigate: '高峰与采集缺口',
  settings: '设置与旧版备份',
};
const familyNames = { codex: 'Codex', claude: 'Claude Code', dsh: 'dsh', other: '其他应用', unknown: '待识别' };
const evidenceNames = {
  process: '进程信息',
  descendant: '父子进程',
  etw: 'Windows 网络事件',
  etw_descendant: 'Windows 网络事件 · 子进程',
  mihomo: 'Mihomo 进程信息',
  none: '缺少进程证据',
};
let view = 'overview';
let range = 'today';
const calendarDate = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
let selectedDate = calendarDate();
let data = null, monthData = null, apps = null;
let refreshTimer = 0, refreshSequence = 0, detailSequence = 0, harnessSequence = 0;
let activeAppDetail = null, activeLadderDetail = null, activeFamily = 'codex', harnessLoadedKey = '';
let appDetailData = null, ladderDetailData = null;
let liveTimer = 0, livePacket = null, detailHistory = [], harnessResult = null;
let ladderFilterAbort=null,ladderFilterData=null,ladderFilterDataKey='',ladderFilterPendingKey='',ladderFilterError='',ladderFilterSequence=0,airportNodeSelection=null;
let airportInventory=null,airportInventoryKey='',airportInventoryPendingKey='',airportInventoryError='',airportInventoryAbort=null,airportNodeLimit=120;
let harnessLoadedAt = 0,harnessResultKey='';
let preferences = readPreferences();
let historyAbort, detailAbort, harnessAbort, liveAbort, refreshPromise, refreshKey = '', dataKey = '';
let historyState = 'loading', historyError = '', monthLoadedAt = 0, appPage = 0, settingsInitialized = false;
let progressTimer=0,historyProgress=null,historyStartedAt=0,refreshAfterImport=false;
const snapshotCache = new Map();
const queryKey = () => `${range}|${range === 'day' ? selectedDate : calendarDate()}`;
const isCancelled = (error) => error?.name === 'AbortError' || error?.message === 'request_cancelled';
function hideChartTooltip() { if (chartTooltip) chartTooltip.hidden = true; }
let snapshotWritePending = false;
function saveSnapshot(key, value) {
  snapshotCache.delete(key); snapshotCache.set(key,value);
  while (snapshotCache.size > 6) snapshotCache.delete(snapshotCache.keys().next().value);
}

function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem('trafficwatch-unified-settings') || '{}');
    return {
      monthlyMachineGb: Number(value.monthlyMachineGb) || 0,
      monthlyProxyGb: Number(value.monthlyProxyGb) || 0,
      notificationsEnabled: value.notificationsEnabled === true,
    };
  } catch { return { monthlyMachineGb: 0, monthlyProxyGb: 0, notificationsEnabled: false }; }
}
function savePreferences() {
  try { localStorage.setItem('trafficwatch-unified-settings', JSON.stringify(preferences)); } catch { /* Browser storage is optional. */ }
}
const numberFormats = [0, 1, 2].map(maximumFractionDigits => new Intl.NumberFormat('zh-CN', { maximumFractionDigits }));
function bytes(value, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  let amount = Number(value), index = 0;
  const labels = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  while (Math.abs(amount) >= 1000 && index < labels.length - 1) { amount /= 1000; index++; }
  const digits = index === 0 ? 0 : amount >= 100 ? 1 : 2;
  return `${numberFormats[digits].format(amount)} ${labels[index]}${unit}`;
}
const total = (row) => Number(row?.up || 0) + Number(row?.down || 0);
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function time(value, includeDate = false) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '无记录';
  return (includeDate ? dateTimeFormat : timeFormat).format(Number(value));
}
function duration(ms) {
  if (!Number.isFinite(Number(ms)) || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}
function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}
function node(tag, text, className = '') {
  const item = document.createElement(tag);
  if (text !== undefined && text !== null) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function setText(target, text) {
  if (target.textContent !== text) target.textContent = text;
}
function setAttribute(target, name, value) {
  if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}
function releaseChart(canvas) {
  canvas._dispose?.();
  if (canvas.width !== 1) canvas.width = 1;
  if (canvas.height !== 1) canvas.height = 1;
  canvas._plotPoints = [];
  canvas._chartModel = null;
}
function showToast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => ($('toast').hidden = true), 4500);
}
function rangeParams() {
  const params = new URLSearchParams({ range });
  if (range === 'day') params.set('date', selectedDate);
  return params;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs || 55000)]) : AbortSignal.timeout(options.timeoutMs || 55000),
    headers: { 'X-Codex-Flow': '1',...vaultHeaders(), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  await checkVaultResponse(response);
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    const labels = { history_timeout: '历史查询超时，请重试', history_busy: '历史查询繁忙，请稍后重试', history_unavailable: '历史暂时不可读', invalid_range: '日期或时段无效',vault_migrating:'正在打开加密记录，完成后会自动加载。',vault_storage_busy:'正在回收数据库空页，完成后恢复查询；采集照常继续' };
    throw Object.assign(new Error(labels[value.error] || value.error || `本机服务响应 ${response.status}`),{code:value.error});
  }
  return response.json();
}
function requestDetail(lane, filters = {}, options = {}) {
  const params = rangeParams();
  params.set('lane', lane);
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return api(`/api/detail?${params}`, options);
}
function rangeLabel() {
  if (range === 'today') return '今天 · 北京时间';
  if (range === 'day') return `${selectedDate} · 北京时间`;
  if (range === 'all') return '全部已保留记录';
  return `最近 ${range === '24h' ? '24 小时' : range === '7d' ? '7 天' : '30 天'}`;
}
function setView(next,{resumeDetails=true}={}) {
  if (!Object.hasOwn(pageNames, next)) return;
  if(view!==next){
    if(['apps','ladder'].includes(view)){detailAbort?.abort();detailSequence++;}
    if(view==='harness'){harnessAbort?.abort();harnessSequence++;harnessLoadedKey='';}
  }
  hideChartTooltip();
  for (const canvas of document.querySelectorAll('canvas')) {
    // Hidden pages need no GPU backing store. Their data will redraw on entry.
    if (canvas.closest('[data-view]')?.dataset.view !== next) releaseChart(canvas);
  }
  view = next;
  history.replaceState(null, '', `#${view}`);
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== view;
  for (const button of document.querySelectorAll('[data-view-button]')) {
    if (button.dataset.viewButton === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('pageTitle').textContent = view === 'overview' ? '流量总览' : pageNames[view];
  renderHeader();
  if (view === 'overview') renderOverview();
  if (view === 'apps') {renderApps();if(resumeDetails&&activeAppDetail&&!appDetailData)loadAppDetail(activeAppDetail);}
  if (view === 'ladder') {renderLadder();if(resumeDetails&&activeLadderDetail&&!ladderDetailData)loadLadderDetail(activeLadderDetail);}
  if (view === 'harness') { renderHarnessTabs(); if (harnessResult?.[0] === activeFamily) renderHarness(...harnessResult); if (dataKey === queryKey()) loadHarness(activeFamily); }
  if (view === 'investigate') renderInvestigation();
  if (view === 'settings') renderSettings();
}
for (const button of document.querySelectorAll('[data-view-button]')) button.addEventListener('click', () => setView(button.dataset.viewButton));

function proxyStatusLabel(proxy) {
  if (proxy.state === 'partial') return proxy.routeClient ? `${proxyClientName(proxy.routeClient)} 接管 · 控制器不可读` : '部分控制器不可读';
  if (proxy.routing === 'multiple') return '多张 TUN 网卡接管';
  if (proxy.routeClient) {
    const name = proxyClientName(proxy.routeClient);
    if (proxy.state === 'multiple') return `${name} 接管 · 两边均有记录`;
    return proxy.clients?.some(item => item.client === proxy.routeClient && item.deltaBytes > 0)
      ? `${name} 接管 · 有流量` : `${name} 接管 · 当前空闲`;
  }
  if (proxy.state === 'multiple') return '多个客户端同时有流量';
  if (proxy.client && proxy.state === 'active') return `${proxyClientName(proxy.client)} 有流量`;
  if (proxy.routing === 'none') return '未发现 TUN 接管';
  if (proxy.state === 'unavailable') return '控制器未连接';
  if (proxy.clients?.some(item => item.reachable)) return '控制器在线 · 接管待确认';
  return '';
}
function setSourceStatus(id, live, expected) {
  const target = $(id);
  const fresh = live?.state === 'connected' && live.capture?.active === expected &&
    Number.isFinite(live.lastAt) && Date.now() >= live.lastAt && Date.now() - live.lastAt < (live.intervalMs || 1000) + 6000;
  const mismatch = live && live.capture?.active && live.capture.active !== expected;
  const proxy=live?.capture?.proxy;
  const proxyFresh=expected==='mihomo'&&Number.isFinite(proxy?.observedAt)&&Date.now()>=proxy.observedAt&&Date.now()-proxy.observedAt<(live?.intervalMs||1000)+6000;
  const uncertain=proxyFresh&&(proxy.state==='partial'||proxy.routing==='multiple');
  const label = fresh ? '正在采集' : mismatch ? '采集来源不符' : live ? '采集已断开' : '采集未连接';
  const className = `status-chip ${expected === 'mihomo' ? 'proxy-chip' : ''} ${uncertain?'is-warning':fresh?'is-live':'is-offline'}`;
  if (target.className !== className) target.className = className;
  const speed = expected === 'native' ? Number(live?.allUpRate || 0) + Number(live?.allDownRate || 0) : total(live?.routeRates?.proxy);
  let text=`${expected === 'native' ? '本机' : '梯子'} · ${fresh ? bytes(speed, '/s') : label}`;
  const proxyLabel=proxyFresh?proxyStatusLabel(proxy):'';
  if(proxyLabel)text=`梯子 · ${proxyLabel}`;
  if (target.lastElementChild?.tagName !== 'SPAN') {
    const indicator = node('i'); indicator.setAttribute('aria-hidden', 'true');
    target.replaceChildren(indicator, node('span'));
  }
  setText(target.lastElementChild,text);
  const clientStates=Array.isArray(proxy?.clients)?proxy.clients.map(item=>{
    const tun=item.tunEnabled===true?'TUN 配置开启':item.tunEnabled===false?'TUN 配置关闭':'TUN 配置未知';
    const adapter=item.route===true?'Windows 路由指向此网卡':item.interfaceStatus==='up'?`${item.interfaceName||'TUN'} 网卡在线`:item.interfaceStatus==='down'?'TUN 网卡断开':item.interfaceStatus==='missing'?'未匹配到 TUN 网卡':'TUN 网卡状态未知';
    return `${proxyClientName(item.client)}：${item.reachable?'控制器在线':'控制器未连接'}，${tun}，${adapter}${item.deltaBytes>0?'，本次增加 '+bytes(item.deltaBytes):''}`;
  }).join('；'):'';
  setAttribute(target, 'title', proxyFresh?`${proxyLabel||'状态未知'}${clientStates?'；'+clientStates:''}${fresh?'；代理出口合计 '+bytes(speed,'/s'):''}；最近检查 ${time(proxy.observedAt,true)}`:fresh?`最近采样 ${time(live.lastAt, true)}`:(live?.error || '当前显示历史记录'));
  return fresh;
}
function renderLiveStatus() {
  const machineLive = setSourceStatus('machineStatus', livePacket ? livePacket.machine : data?.live?.machine, 'native');
  const clashLive = setSourceStatus('clashStatus', livePacket ? livePacket.clash : data?.live?.clash, 'mihomo');
  const selection=livePacket?.clash?.capture?.proxy||data?.live?.clash?.capture?.proxy;
  const selectionFresh=Number.isFinite(selection?.observedAt)&&Date.now()>=selection.observedAt&&Date.now()-selection.observedAt<(livePacket?.clash?.intervalMs||data?.live?.clash?.intervalMs||1000)+6000;
  const uncertain=selectionFresh&&(selection.state==='partial'||selection.routing==='multiple');
  const status = uncertain?'is-warning':machineLive&&clashLive?'is-live':'is-offline';
  if ($('sidebarCollectorDot').className !== status) $('sidebarCollectorDot').className = status;
  const collectorText=selectionFresh&&proxyStatusLabel(selection)||(!machineLive||!clashLive?'历史可看 · 部分采集未运行':'两路采集均在运行');
  setText($('sidebarCollectorText'),collectorText);
  setAttribute($('selectedDate'), 'max', calendarDate());
}
function renderHeader() {
  setText($('pageTitle'), pageNames[view]);
  renderLiveStatus();
  setText($('rangeSummary'), `${rangeLabel()} · ${historyState === 'loading' ? '正在更新' : historyState === 'error' ? '更新失败，保留上次记录' : '汇总刷新'} ${data?.generatedAt ? time(data.generatedAt, true) : '—'}`);
  setText($('updatedAt'), data?.generatedAt ? `最近更新 ${time(data.generatedAt, true)}` : '等待本机数据');
  const progress=queryProgressView(historyProgress,historyStartedAt?Date.now()-historyStartedAt:0);
  setText($('historyStatus'), historyState === 'loading' ? progress.text : historyState === 'error' ? `更新未完成：${historyError}` : `${rangeLabel()} · ${data?.generatedAt ? time(data.generatedAt) + ' 更新' : '等待记录'}`);
  $('historyProgressPanel').hidden=historyState!=='loading'||!historyStartedAt;
  if(progress.determinate){$('historyProgressBar').max=progress.total;$('historyProgressBar').value=progress.done;}
  else $('historyProgressBar').removeAttribute('value');
  setAttribute($('refreshButton'), 'aria-busy', String(historyState === 'loading'));
  renderPendingAttribution();
}
function renderPendingAttribution(){
  if(dataKey!==queryKey()||data?.machine?.detailReady!==false)return;
  const failed=historyState==='error';
  setText($('overviewHarness'),failed?'暂未完成':'统计中');setText($('overviewUnknown'),failed?'暂未完成':'统计中');
  setText($('overviewHarnessBreakdown'),failed?'应用归因查询失败，点击右上角刷新重试':'总量已就绪，应用归因正在加载');
  setText($('overviewUnknownNote'),failed?'总量已保留；详细统计可重试':'详细统计加载后显示');
  const target=$('topProcessRows'),label=failed?'应用统计暂未完成，请点击右上角刷新重试。':'正在汇总应用，当前总量已可查看…';
  if(target.textContent!==label)target.replaceChildren(node('p',label,'empty-state'));
}
function renderTotals(target, row, onSelect) {
  target.replaceChildren();
  const values = [
    ['代理出口', row.proxy, 'proxy'],
    ['DIRECT 直连', row.direct, 'direct'],
    ['出口未知', row.unknown, 'unknown'],
  ];
  for (const [name, value, route] of values) {
    const item = node('button', undefined, 'route-total'); item.type = 'button';
    item.append(node('span', name), node('strong', bytes(total(value))));
    item.addEventListener('click', () => onSelect?.(route));
    target.append(item);
  }
  if(row.unassigned){
    const unassigned = node('button', undefined, 'route-total unassigned-total'); unassigned.type = 'button';
    unassigned.append(node('span', '未归因差额'), node('strong', bytes(total(row.unassigned))));
    unassigned.addEventListener('click', () => showToast('这个差额没有对应连接证据，不能强行分配给应用或节点。'));
    target.append(unassigned);
  }
}
const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
const gapReasons = { collector_restart: '采集程序重启', initial_baseline: '首次采集基线', source_unavailable: '采集源未连接', proxy_controller_unavailable: '接管中的 Clash 控制器暂不可读', collector_error: '采集异常', source_changed: '切换采集来源', observer_unavailable: '进程信息暂不可用', sampling_delay: '采样延迟', native_events_lost: '系统事件丢失', clock_changed: '系统时间调整' };
const directionColors = { up: '#d58526', down: '#287ca5' };
let chartTooltip;
function chartSeries(name, rows, source, route = '') {
  const shortNames = { '本机已观测': '本机', '本机进程记录': '本机', '梯子代理出口': '梯子', '代理出口': '代理', 'DIRECT 直连': '直连', '出口未知': '未知' };
  return { name, shortName: shortNames[name] || name, source, rows: (rows || []).map((row) => ({ at: row.at, ...(route ? row[route] : row) })) };
}
function mergedGapMs(gaps, from, to) {
  let end = from, amount = 0;
  for (const gap of [...gaps].sort((a, b) => a.gapFrom - b.gapFrom)) {
    const start = Math.max(from, gap.gapFrom, end), stop = Math.min(to, gap.gapTo);
    if (stop > start) { amount += stop - start; end = stop; }
  }
  return amount;
}
function chartModel(series, selectedRange, fullRange) {
  const baseInterval = selectedRange.intervalMs || 3600000;
  const intervalMs = baseInterval * Math.max(1, Math.ceil((selectedRange.to-selectedRange.from) / baseInterval / 240));
  const observed = series.flatMap((line) => [...line.rows, ...(line.source?.timeline || [])])
    .filter((row) => row.at + intervalMs > selectedRange.from && row.at < selectedRange.to);
  const first = fullRange || !observed.length ? selectedRange.from : Math.max(selectedRange.from, Math.min(...observed.map((row) => row.at)));
  const start = Math.floor(first / intervalMs) * intervalMs;
  // Always include intermediate slots and the latest selected time, even if the collector is offline.
  const count = Math.max(1, Math.ceil((selectedRange.to - start) / intervalMs));
  const maps = series.map((line) => {
    const values = new Map();
    for (const row of line.rows) {
      const at = Math.floor(row.at / intervalMs) * intervalMs;
      const bucket = values.get(at) || { up: 0, down: 0 };
      bucket.up += Number(row.up || 0); bucket.down += Number(row.down || 0); values.set(at, bucket);
    }
    return values;
  });
  const points = Array.from({ length: count }, (_, index) => {
    const at = start + index * intervalMs, from = Math.max(at, selectedRange.from), to = Math.min(at + intervalMs, selectedRange.to);
    const values = series.map((line, i) => {
      const row = maps[i].get(at), source = line.source;
      const gaps = (source?.gapDetails || []).filter((gap) => gap.gapFrom < to && gap.gapTo > from);
      const gapMs = mergedGapMs(gaps, from, to);
      const sampleWidth = source?.range?.intervalMs || intervalMs;
      // Detail traffic is minute resolution, while coverage may be hourly. A missing
      // process row alone is never evidence of a stopped collector or of no real traffic.
      const sampled = (source?.timeline || []).some((item) => item.samples > 0 && item.at < to && item.at + sampleWidth > from);
      const outsideHistory = source?.firstAt > to || source?.lastAt < from;
      const missing = !row && (source?.available === false || outsideHistory || !sampled || gapMs >= to - from);
      const partial = !missing && gapMs > 0;
      return { ...row, value: missing ? null : total(row), state: missing ? 'missing' : partial ? 'partial' : 'observed', gaps, gapMs };
    });
    return { at, from, to, values, current: to < at + intervalMs && Date.now() - to < 90000 };
  });
  return { intervalMs, points };
}
function drawChart(canvas, series, onSelect, options = {}) {
  if (!canvas || !canvas.closest('[data-view]') || canvas.closest('[data-view]').hidden) return;
  canvas._dispose?.();
  const selectedRange = options.range;
  if (!selectedRange || selectedRange.to <= selectedRange.from) return;
  if (chartTooltip?.dataset.chart === canvas.id) chartTooltip.hidden = true;
  const wrap = canvas.closest('.chart-wrap');
  let plot = canvas.parentElement;
  if (!plot.classList.contains('chart-plot')) {
    plot = node('div', undefined, 'chart-plot'); wrap.append(plot); plot.append(canvas);
    const ticks = options.ticks ? $(options.ticks) : node('div', undefined, 'chart-ticks');
    plot.append(ticks);
    const caption = node('div', undefined, 'chart-caption'); caption.id = `${canvas.id}Caption`;
    wrap.after(caption); canvas.setAttribute('aria-describedby', caption.id);
  }
  const model = chartModel(series, selectedRange, options.fullRange);
  const { points, intervalMs } = model;
  const pad = { left: 60, right: 16, top: 26, bottom: series.length > 1 ? 29 : 19 };
  const minSlot = intervalMs >= 3600000 ? Math.max(58, series.length * 30 + 16) : Math.max(12, series.length * 9 + 4);
  const width = Math.max(240, wrap.clientWidth || 400);
  const logicalWidth = Math.max(width, pad.left + pad.right + points.length * minSlot);
  plot.style.width = `${logicalWidth}px`;
  canvas.style.width = `${width}px`;
  const height = Math.max(120, canvas.clientHeight || 210), innerHeight = height - pad.top - pad.bottom;
  const innerWidth = logicalWidth - pad.left - pad.right, slotWidth = innerWidth / points.length;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const backingWidth = Math.round(width * dpr), backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const maximum = Math.max(0, ...points.flatMap((point) => point.values.map((value) => value.value || 0)));
  const rawStep = maximum / 3, magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
  const step = [1, 2, 2.5, 5, 10].find((value) => value * magnitude >= rawStep) * magnitude;
  const scale = step * 3;
  const groupWidth = Math.min(slotWidth * .68, series.length === 1 ? 52 : 72), barGap = series.length > 1 ? Math.min(4, groupWidth * .07) : 0;
  const barWidth = (groupWidth - (series.length - 1) * barGap) / series.length;
  points.forEach((point, i) => { point.x = pad.left + (i + .5) * slotWidth; });
  canvas._plotPoints = points; canvas._chartModel = { ...model, range: selectedRange, series: series.map(({ name, shortName }) => ({ name, shortName })), directions: directionColors, width, logicalWidth, height, slotWidth, scale, pad, groupWidth, barWidth, barGap };
  canvas.tabIndex = 0;
  const ticks = plot.querySelector('.chart-ticks'); ticks.replaceChildren();
  const labelEvery = Math.max(1, [1, 2, 3, 5, 10, 15, 30, 60].find((n) => n * slotWidth >= (intervalMs >= 3600000 ? 44 : 42)) || 60);
  for (let i = 0; i < points.length; i++) {
    const point = points[i], tick = node('span', undefined, 'chart-tick');
    const show = i % labelEvery === 0 || (i === points.length - 1 && i % labelEvery > labelEvery / 2);
    tick.style.left = `${point.x}px`; tick.title = `${time(point.from, true)} 至 ${time(point.to, true)}`;
    if (show) {
      tick.append(node('span', clockFormat.format(point.at)));
      if (intervalMs >= 6 * 3600000 || i === 0 || dayFormat.format(point.at) !== dayFormat.format(points[Math.max(0, i - labelEvery)].at)) tick.append(node('small', dayFormat.format(point.at)));
    } else tick.classList.add('tick-unlabelled');
    ticks.append(tick);
  }
  const caption = $(`${canvas.id}Caption`); caption.replaceChildren();
  const unit = intervalMs < 3600000 ? `${intervalMs / 60000} 分钟` : intervalMs < 86400000 ? `${intervalMs / 3600000} 小时` : `${intervalMs / 86400000} 天`;
  caption.append(node('span', `${time(points[0].from)}—${time(points.at(-1).to)} · 北京时间 · 每组 ${unit}`, 'chart-range'));
  for (const [label, color] of [['↑ 上传', directionColors.up], ['↓ 下载', directionColors.down]]) {
    const key = node('span', label, 'bar-legend-item'); key.style.setProperty('--legend', color); caption.append(key);
  }
  caption.append(node('span', series.length > 1 ? `柱子从左到右：${series.map((line) => line.shortName).join(' / ')}` : series[0].name, 'chart-column-order'));
  if (points.some((point) => point.values.some((value) => value.state === 'missing'))) caption.append(node('span', '未采集 ≠ 0 流量', 'bar-legend-item missing-key'));
  if (points.some((point) => point.values.some((value) => value.state === 'partial'))) caption.append(node('span', '部分缺采', 'bar-legend-item partial-key'));
  if (points.some((point) => point.current)) caption.append(node('span', '当前时段尚未结束', 'chart-current-note'));
  if (logicalWidth > width + 2) caption.append(node('span', '↔ 横向滚动可看完整时间', 'chart-scroll-note'));
  const draw = (active = -1) => {
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px Segoe UI, Microsoft YaHei UI, sans-serif'; ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const y = pad.top + innerHeight * i / 3;
      ctx.strokeStyle = '#e8ece9'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      if (maximum || i === 3) { ctx.fillStyle = '#7c8781'; ctx.fillText(bytes(scale * (3 - i) / 3), pad.left - 8, y + 4); }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(pad.left,0,width-pad.left-pad.right,height); ctx.clip(); ctx.translate(-wrap.scrollLeft,0);
    const visibleStart = Math.max(0, Math.floor(wrap.scrollLeft / slotWidth) - 1), visibleEnd = Math.min(points.length, visibleStart + Math.ceil(width / slotWidth) + 3);
    points.slice(visibleStart, visibleEnd).forEach((point, localIndex) => {
      const i = localIndex + visibleStart;
      point.values.forEach((value, s) => {
        const x = point.x - groupWidth / 2 + s * (barWidth + barGap), baseline = pad.top + innerHeight;
        if (value.state === 'missing') {
          ctx.save(); ctx.beginPath(); ctx.rect(x, pad.top, barWidth, innerHeight); ctx.clip();
          ctx.fillStyle = '#f3f5f4'; ctx.fillRect(x, pad.top, barWidth, innerHeight);
          ctx.strokeStyle = '#d8dfda'; ctx.lineWidth = 1;
          for (let dy = -barWidth; dy < innerHeight + barWidth; dy += 8) {
            ctx.beginPath(); ctx.moveTo(x, pad.top + dy); ctx.lineTo(x + barWidth, pad.top + dy + barWidth); ctx.stroke();
          }
          ctx.restore();
          if (series.length === 1 && slotWidth >= 52) { ctx.fillStyle = '#839087'; ctx.textAlign = 'center'; ctx.fillText('未采集', point.x, pad.top - 9); }
        } else {
          const barHeight = value.value > 0 ? Math.max(1, value.value / scale * innerHeight) : 0;
          if (barHeight > 0) {
            const downHeight = barHeight * Number(value.down || 0) / value.value;
            ctx.save(); ctx.beginPath();
            ctx.roundRect(x, baseline - barHeight, barWidth, barHeight, [Math.min(4, barWidth / 3, barHeight / 2), Math.min(4, barWidth / 3, barHeight / 2), 0, 0]); ctx.clip();
            ctx.fillStyle = directionColors.down; ctx.fillRect(x, baseline - downHeight, barWidth, downHeight);
            ctx.fillStyle = directionColors.up; ctx.fillRect(x, baseline - barHeight, barWidth, barHeight - downHeight);
            ctx.restore();
          } else { ctx.fillStyle = '#b5c5bb'; ctx.fillRect(x, baseline - 1, barWidth, 1); }
          if (value.state === 'partial') { ctx.fillStyle = '#b58033'; ctx.beginPath(); ctx.arc(x + barWidth / 2, baseline + 8, 2.5, 0, Math.PI * 2); ctx.fill(); }
          if (series.length === 1 && slotWidth >= 62 && value.value > 0) {
            ctx.textAlign = 'center'; ctx.fillStyle = '#556f60'; ctx.fillText(bytes(value.value), point.x, baseline - barHeight - 8);
          }
        }
        if (series.length > 1 && barWidth >= 20) {
          ctx.textAlign = 'center'; ctx.fillStyle = '#7d8e81'; ctx.font = '9px Segoe UI, Microsoft YaHei UI, sans-serif';
          ctx.fillText(series[s].shortName, x + barWidth / 2, baseline + 23);
          ctx.font = '11px Segoe UI, Microsoft YaHei UI, sans-serif';
        }
      });
      if (point.current) {
        ctx.strokeStyle = '#90aa9a'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.strokeRect(point.x - groupWidth / 2 - 3, pad.top - 7, groupWidth + 6, innerHeight + 11); ctx.setLineDash([]);
      }
    });
    ctx.restore();
    if (!maximum && !points.every((point) => point.values.every((value) => value.state === 'missing'))) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#728178'; ctx.fillText('该范围未记录到匹配流量', pad.left + innerWidth / 2, pad.top + 24);
    }
  };
  let active = -1, hoverFrame = 0, scrollFrame = 0, pointer;
  const marker = plot.querySelector('.chart-hover-marker') || node('div',undefined,'chart-hover-marker');
  plot.append(marker); marker.hidden = true;
  const hideTooltip = () => { cancelAnimationFrame(hoverFrame); hoverFrame = 0; marker.hidden = true; active = -1; if (chartTooltip?.dataset.chart === canvas.id) chartTooltip.hidden = true; };
  const showPoint = (index, clientX, clientY) => {
    if (index < 0 || index >= points.length) { hideTooltip(); return; }
    const point = points[index];
    if (!chartTooltip) { chartTooltip = node('div', undefined, 'chart-tooltip'); chartTooltip.id = 'chartTooltip'; chartTooltip.setAttribute('role', 'tooltip'); document.body.append(chartTooltip); }
    if (active !== index || chartTooltip.dataset.chart !== canvas.id || chartTooltip.hidden) {
    active = index; marker.hidden = false; marker.style.left = `${point.x-slotWidth/2+1}px`; marker.style.width = `${slotWidth-2}px`;
    chartTooltip.dataset.chart = canvas.id; chartTooltip.replaceChildren();
    const endLabel = `${dayFormat.format(point.from) !== dayFormat.format(point.to) ? dayFormat.format(point.to) + ' ' : ''}${clockFormat.format(point.to)}`;
    chartTooltip.append(node('strong', `${dayFormat.format(point.from)} ${clockFormat.format(point.from)}—${endLabel}${point.current ? ' · 进行中' : ''}`, 'chart-tooltip-time'));
    point.values.forEach((value, s) => {
      const row = node('div', undefined, 'chart-tooltip-series');
      row.append(node('span', series[s].name, 'chart-tooltip-name'));
      row.append(node('strong', value.state === 'missing' ? '未采集 · 用量未知' : `合计 ${bytes(value.value)}`));
      if (value.state !== 'missing') {
        const directions = node('div', undefined, 'chart-tooltip-directions');
        for (const [label, amount, color] of [['↑ 上传', value.up || 0, directionColors.up], ['↓ 下载', value.down || 0, directionColors.down]]) {
          const item = node('span', `${label} ${bytes(amount)}`, 'bar-legend-item'); item.style.setProperty('--legend', color); directions.append(item);
        }
        row.append(directions);
        if (!value.value) row.append(node('small', '未记录到匹配流量'));
      }
      if (value.gaps.length) {
        const reasons = [...new Set(value.gaps.map((gap) => gapReasons[gap.reason] || gap.reason))].join('、');
        row.append(node('small', `${value.state === 'partial' ? '部分缺采' : '缺口原因'}：${reasons}（本组内约 ${Math.max(1, Math.round(value.gapMs / 1000))} 秒）`, 'chart-tooltip-gap'));
      }
      chartTooltip.append(row);
    });
    chartTooltip.append(node('small', point.values.every((value) => value.state === 'missing') ? '点击查看采集缺口，不能将此时段当成零流量' : '点击柱子，查看这个时段的应用与连接', 'chart-tooltip-hint'));
    }
    chartTooltip.hidden = false;
    chartTooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - chartTooltip.offsetWidth - 10, clientX + 14))}px`;
    chartTooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - chartTooltip.offsetHeight - 10, clientY + 16))}px`;
  };
  const hit = (event) => {
    const bounds = canvas.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    if (x < pad.left || x >= width - pad.right || y < pad.top - 12 || y > height - 2) return -1;
    return Math.floor((x + wrap.scrollLeft - pad.left) / slotWidth);
  };
  const select = (index) => {
    const point = points[index]; if (!point) return;
    hideTooltip();
    if (point.values.every((value) => value.state === 'missing')) {
      showToast(`${time(point.from)} 至 ${time(point.to)} 没有采集记录，实际用量未知。`);
      setView('investigate'); document.querySelector('.gap-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else onSelect?.(point);
  };
  canvas.onmousemove = (event) => {
    pointer = { clientX: event.clientX, clientY: event.clientY };
    if (!hoverFrame) hoverFrame = requestAnimationFrame(() => { hoverFrame = 0; showPoint(hit(pointer),pointer.clientX,pointer.clientY); });
  };
  canvas.onmouseleave = hideTooltip; canvas.onblur = hideTooltip;
  canvas.onclick = (event) => select(hit(event));
  canvas.onkeydown = (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.min(points.length - 1, Math.max(0, active < 0 ? 0 : active + (event.key === 'ArrowRight' ? 1 : -1)));
      wrap.scrollLeft = Math.max(0, points[index].x - wrap.clientWidth / 2);
      const bounds = canvas.getBoundingClientRect(); showPoint(index, bounds.left + points[index].x - wrap.scrollLeft, bounds.top + height / 2);
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(active < 0 ? 0 : active); }
    else if (event.key === 'Escape') hideTooltip();
  };
  wrap.onscroll = () => { if (document.activeElement !== canvas) hideTooltip(); if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {scrollFrame=0;draw();}); };
  canvas._dispose = () => {
    hideTooltip(); cancelAnimationFrame(scrollFrame);
    canvas.onmousemove = canvas.onmouseleave = canvas.onblur = canvas.onclick = canvas.onkeydown = null;
    wrap.onscroll = null;
    canvas._dispose = null;
  };
  canvas.removeAttribute('title'); draw();
}
function renderOverview() {
  if (!data?.machine || !data?.clash) return;
  const machine = data.machine, clash = data.clash;
  $('overviewMachine').textContent = machine.available ? bytes(total(machine.totals)) : '不可用';
  $('overviewMachineDirections').textContent = `↑ ${bytes(machine.totals?.up)}　↓ ${bytes(machine.totals?.down)}`;
  $('overviewProxy').textContent = clash.available ? bytes(total(clash.groups?.proxy)) : '不可用';
  $('overviewProxyDirections').textContent = `↑ ${bytes(clash.groups?.proxy?.up)}　↓ ${bytes(clash.groups?.proxy?.down)}`;
  const familyTotals = machine.familyTotals || {};
  const harnessBytes = ['codex', 'claude', 'dsh'].reduce((n, key) => n + total(familyTotals[key]), 0);
  $('overviewHarness').textContent = bytes(harnessBytes);
  $('overviewHarnessBreakdown').textContent = ['codex', 'claude', 'dsh'].map((key) => `${familyNames[key]} ${bytes(total(familyTotals[key]))}`).join('　');
  const unknownBytes = total(familyTotals.unknown) + total(machine.unassigned);
  $('overviewUnknown').textContent = bytes(unknownBytes);
  $('overviewUnknownNote').textContent = `待识别进程 ${bytes(total(familyTotals.unknown))} · 未归因差额 ${bytes(total(machine.unassigned))}`;
  if (machine.detailReady === false) {
    renderPendingAttribution();
  }
  $('measurementNote').textContent = '本机总量来自 Windows 进程事件；梯子只计 Clash 已归因到代理节点的连接。两种位置分别记数，代理进程与应用可重复出现，不要相加当账单。';

  drawChart($('overviewChart'), [
    chartSeries('本机已观测', machine.timeline, machine),
    chartSeries('梯子代理出口', clash.routeTimeline, clash, 'proxy'),
  ], (point) => showTimeDetail(point.from, point.to, '流量时段明细'), {
    range: machine.range || clash.range, ticks: 'chartTicks',
  });
  renderPeaks($('peakRows'), machine.peaks, 'machine');
  renderCompactPrograms($('topProcessRows'), machine.allPrograms, 6, (row) => selectApp(row));
  if (machine.detailReady === false) renderPendingAttribution();
  renderIntegrity(machine, clash);
  renderOverviewWarnings(machine, clash);
  renderBudgetStrip();
}
function renderPeaks(target, rows, source) {
  target.replaceChildren();
  if (!rows?.length) { target.append(node('p', '没有可显示的时段采样。', 'empty-state')); return; }
  const width = 5 * 60000;
  for (const row of rows.slice(0, 8)) {
    const button = node('button', undefined, 'compact-row'); button.type = 'button';
    const label = source === 'machine' ? `${time(row.at, true)} · ${row.samples || 0} 个样本` : time(row.at, true);
    const left = node('span', undefined, 'compact-label'); left.append(node('strong', label), node('small', `↑ ${bytes(row.up)}　↓ ${bytes(row.down)}`));
    button.append(left, node('strong', bytes(total(row)), 'compact-value'));
    button.addEventListener('click', () => showTimeDetail(Math.max(row.at, data.machine.range.from), Math.min(data.machine.range.to, row.at + width), '5 分钟高峰明细'));
    target.append(button);
  }
}
function renderCompactPrograms(target, rows, limit, onSelect) {
  target.replaceChildren();
  if (!rows?.length) { target.append(node('p', '这个时段没有已归因到进程的用量。', 'empty-state')); return; }
  for (const row of rows.slice(0, limit)) {
    const button = node('button', undefined, 'compact-row'); button.type = 'button';
    const left = node('span', undefined, 'compact-label');
    left.append(node('strong', row.name || '未识别进程'), node('small', `${familyNames[row.family] || familyNames.other} · ↑ ${bytes(row.up)}　↓ ${bytes(row.down)}`));
    button.append(left, node('strong', bytes(total(row)), 'compact-value'));
    button.addEventListener('click', () => onSelect(row));
    target.append(button);
  }
}
function renderIntegrity(machine, clash) {
  const target = $('integritySummary'); target.replaceChildren();
  for (const [name, item, source] of [['本机', machine, 'Windows ETW'], ['梯子', clash, 'Mihomo / Clash']]) {
    const column = node('div', undefined, `integrity-cell ${item.coverage?.percent < 70 || item.gaps ? 'has-gap' : ''}`);
    column.append(node('span', name), node('strong', item.available ? percent(item.coverage?.percent) : '不可用'), node('small', `${source} · ${item.gaps || 0} 段缺口 · 最近 ${time(item.lastAt)}`));
    target.append(column);
  }
  const actions = node('button', '查看完整性', 'quiet-button'); actions.type = 'button'; actions.addEventListener('click', () => setView('investigate')); target.append(actions);
}
function renderOverviewWarnings(machine, clash) {
  const target = $('overviewWarnings'); target.replaceChildren();
  const messages = [];
  if (machine.firstAt > machine.range?.from) messages.push(`已选${rangeLabel()}；本机记录从 ${time(machine.firstAt,true)} 开始，更早的时间没有历史数据。`);
  if (machine.available && machine.coverage?.percent < 70) messages.push(`本机所选时段覆盖率 ${percent(machine.coverage.percent)}；合计只代表实际采集到的时间。`);
  if (machine.available && machine.connectionCountersExceedGlobal) messages.push('按连接累加的进程流量超过本机全局采样值。代理本机链路可能在多个进程层出现，进程排行用于定位，不能代替网卡账单。');
  if (clash.available && clash.connectionCountersExceedGlobal) messages.push('Clash 连接快照累计与其全局计数存在差异；代理出口用量仅作定位参考。');
  if (messages.length) {
    target.classList.add('has-warning');
    for (const message of messages) target.append(node('p', message));
  } else target.classList.remove('has-warning');
}
function renderBudgetStrip() {
  const target = $('budgetStrip'); target.replaceChildren();
  const hasLimits = preferences.monthlyMachineGb > 0 || preferences.monthlyProxyGb > 0;
  target.hidden = !hasLimits;
  if (!hasLimits) return;
  const machineUsed = total(monthData?.machine?.totals);
  const proxyUsed = total(monthData?.clash?.groups?.proxy);
  const items = [
    ['本机月用量', machineUsed, preferences.monthlyMachineGb],
    ['梯子月用量', proxyUsed, preferences.monthlyProxyGb],
  ].filter((item) => item[2] > 0);
  for (const [name, used, limitGb] of items) {
    const limitBytes = limitGb * 1e9, ratio = limitBytes ? Math.min(100, (used / limitBytes) * 100) : 0;
    const item = node('section', undefined, 'budget-meter');
    const heading = node('div', undefined, 'budget-heading');
    heading.append(node('strong', name), node('span', `${bytes(used)} / ${limitGb} GB`));
    const bar = node('div', undefined, 'budget-track');
    const fill = node('span'); fill.style.width = `${ratio}%`; fill.className = ratio >= 100 ? 'over-limit' : '';
    bar.append(fill);
    item.append(heading, bar, node('small', `${percent(used / limitBytes * 100)} · 本机参考上限，非运营商账单`));
    target.append(item);
    if (used >= limitBytes) notifyLimit(name, limitBytes, used);
  }
}
function notifyLimit(name, limit, used) {
  if (!preferences.notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  const key = `trafficwatch-limit-${calendarDate()}-${name}`;
  try {
    if (localStorage.getItem(key)) return;
    new Notification('TrafficWatch 用量参考线', { body: `${name}已达到参考上限：${bytes(used)} / ${bytes(limit)}。` });
    localStorage.setItem(key, 'yes');
  } catch { /* The in-page meter remains available. */ }
}
function renderApps() {
  if (!data?.machine?.available) {
    if(data) {$('appRows').replaceChildren();const tr=node('tr'),td=node('td','本机历史暂不可读，点击刷新可重试。','empty-state');td.colSpan=7;tr.append(td);$('appRows').append(tr);}
    return;
  }
  $('appListTable').hidden = Boolean(activeAppDetail);
  $('appListPager').hidden = Boolean(activeAppDetail);
  $('backToApps').hidden = !activeAppDetail;
  document.querySelector('[data-view="apps"] .filter-bar').hidden = Boolean(activeAppDetail);
  if (activeAppDetail) { if (appDetailData) renderAppDetail(activeAppDetail,appDetailData); return; }
  const query = $('appSearch').value.trim().toLowerCase();
  const sort = $('appSort').value;
  const rows = [...(data.machine.allPrograms || [])].filter((row) => (row.name || '').toLowerCase().includes(query));
  rows.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'up' ? b.up - a.up : sort === 'down' ? b.down - a.down : total(b) - total(a));
  $('appCount').textContent = `${rows.length} 个进程名 · 包含待识别连接`;
  const body = $('appRows'); body.replaceChildren();
  if (!rows.length) { const tr = node('tr'); const td = node('td', '没有匹配的应用记录。', 'empty-state'); td.colSpan = 7; tr.append(td); body.append(tr); }
  appPage = Math.max(0,Math.min(appPage,Math.ceil(rows.length/50)-1));
  for (const row of rows.slice(appPage*50,(appPage+1)*50)) {
    const tr = node('tr', undefined, 'selectable-row'); tr.tabIndex = 0;
    const processCell = node('td', undefined, 'process-cell');
    processCell.append(node('strong', row.name || '未识别进程'), node('small', row.process || '连接没有提供进程名'));
    tr.append(processCell, node('td', familyNames[row.family] || familyNames.other), node('td', bytes(row.up)), node('td', bytes(row.down)), node('td', bytes(total(row)), 'numeric-strong'), node('td', String(row.connections || 0)), node('td', time(row.lastAt)));
    const open = () => selectApp(row);
    tr.addEventListener('click', open); tr.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    body.append(tr);
  }
  renderPager('appListPager',{page:appPage,pages:Math.ceil(rows.length/50),total:rows.length},(page)=>{appPage=page;renderApps();});
  if (data.machine.detailReady === false) body.replaceChildren(node('tr',undefined,'empty-state'));
  if (data.machine.detailReady === false) { const td=node('td','正在汇总该时段的应用…');td.colSpan=7;body.firstChild.append(td); }
}
function selectApp(row, inherited = null) {
  const process = row.process || '__unknown__';
  if (!inherited) { detailHistory = []; $('appSearch').value = row.name === '未识别进程' ? '' : row.name; }
  openAppSelection({ ...(inherited || {}), process, scope: row.scope || undefined, page: 0,
    title: row.name || row.process || '未识别进程' }, Boolean(inherited));
}
function openAppSelection(selection, remember = true) {
  if (remember && activeAppDetail) { detailHistory.push({ ...activeAppDetail }); if(detailHistory.length>20)detailHistory.shift(); }
  activeAppDetail = selection;
  appDetailData = null;
  setView('apps',{resumeDetails:false});
  $('appDetail').hidden = false;
  $('appDetailTitle').textContent = activeAppDetail.title;
  renderApps();
  loadAppDetail(activeAppDetail);
  $('appDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function loadAppDetail(selection, timeRange = null) {
  detailAbort?.abort(); detailAbort = new AbortController();
  const signal = detailAbort.signal, key = queryKey();
  const current = ++detailSequence;
  appDetailData=null;
  $('appDetailMeta').textContent = `${selection.from ? time(selection.from,true)+' 至 '+time(selection.to,true)+' · ' : ''}正在读取所选时段的分钟流量与目标…`;
  $('appDetail').setAttribute('aria-busy','true');$('exportAppDetail').disabled=true;$('copyEvidence').disabled=true;$('appDetailRetry').hidden=true;
  for(const id of ['appDetailMetrics','appDestinations','appConnectionRows','detailProcessRows','appPager'])$(id).replaceChildren();
  releaseChart($('appDetailChart'));
  try {
    const { title, ...filters } = selection;
    if (timeRange) { filters.from = timeRange.from; filters.to = timeRange.to; }
    const result = await requestDetail('windows', filters, { signal });
    if (current !== detailSequence || key !== queryKey() || signal.aborted) return;
    if (!result.available) throw new Error('该采集源尚未建立历史记录');
    appDetailData = result;
    $('appDetail').setAttribute('aria-busy','false');$('exportAppDetail').disabled=false;$('copyEvidence').disabled=false;$('appDetailRetry').hidden=true;
    if (view === 'apps') renderAppDetail(selection, result);
  } catch (error) {
    if (current === detailSequence && !isCancelled(error)) {$('appDetail').setAttribute('aria-busy','false');$('appDetailMeta').textContent = `明细暂不可用：${error.message}。`;$('appDetailRetry').hidden=false;}
  }
}
function renderAppDetail(selection, result) {
  $('appDetail').hidden = false;
  $('appDetailTitle').textContent = selection.title;
  const { up, down } = result.summary;
  $('appDetailMeta').textContent = `${time(result.range.from, true)} 至 ${time(result.range.to, true)}（不含结束） · 共 ${result.pagination.total} 条连接归因 · 汇总包含全部结果`;
  $('detailBack').hidden = !detailHistory.length;
  $('inspectFrom').value = localInputTime(result.range.from);
  $('inspectTo').value = localInputTime(result.range.to);
  renderCompactPrograms($('detailProcessRows'), result.processes, 12, (row) => selectApp(row, { ...selection, page: 0 }));
  const metrics = $('appDetailMetrics'); metrics.replaceChildren();
  for (const [label, value] of [['上传', up], ['下载', down], ['合计', up + down]]) {
    const item = node('div', undefined, 'detail-metric'); item.append(node('span', label), node('strong', bytes(value))); metrics.append(item);
  }
  renderCompactPrograms($('appDestinations'), result.destinations, 10, (row) => openAppSelection({ ...selection, host: row.name, page: 0, title: `${selection.title} → ${row.name}` }));
  drawChart($('appDetailChart'), [chartSeries('所选应用合计', result.series, result.observation || data?.machine)],
    (point) => showTimeDetail(point.from, point.to, selection.title, selection), { range: result.range, fullRange: true });
  const body = $('appConnectionRows'); body.replaceChildren();
  if (!result.connections.length) { const tr = node('tr'); const td = node('td', '此时段没有连接明细；可能是采集暂停，或该进程尚未产生可归因流量。', 'empty-state'); td.colSpan = 7; tr.append(td); body.append(tr); }
  for (const row of result.connections) {
    const tr = node('tr');
    tr.append(node('td', time(row.lastAt, true)), node('td', `${row.process || '未识别'}${row.pid ? ` · PID ${row.pid}` : row.observedPID ? ` · 事件 PID ${row.observedPID}（无进程名证据）` : ''}`), node('td', row.host + (row.destinationPort ? `:${row.destinationPort}` : '')), node('td', evidenceNames[row.evidence] || row.evidence), node('td', bytes(row.up)), node('td', bytes(row.down)), node('td', bytes(row.amount), 'numeric-strong'));
    body.append(tr);
  }
  renderPager('appPager', result.pagination, (page) => { activeAppDetail = { ...selection, page }; loadAppDetail(activeAppDetail); });
}
function localInputTime(at) { return new Date(at + 8 * 3600000).toISOString().slice(0, 16); }
function renderPager(id, pagination, onPage) {
  const target = $(id); target.replaceChildren();
  const { page, pages, total: count } = pagination;
  const previous = node('button', '上一页', 'quiet-button'), next = node('button', '下一页', 'quiet-button');
  previous.type = next.type = 'button'; previous.disabled = page <= 0; next.disabled = page + 1 >= pages;
  previous.addEventListener('click', () => onPage(page - 1)); next.addEventListener('click', () => onPage(page + 1));
  target.append(previous, node('span', `第 ${pages ? page + 1 : 0} / ${pages} 页 · 共 ${count} 条`), next);
}
function showTimeDetail(from, to, title, filters = {}) {
  if (to <= from) return;
  $('appSearch').value = '';
  openAppSelection({ ...filters, from, to, page: 0, title: `${title} · ${time(from, true)}` });
}
function proxyClientName(client){return ({verge:'Clash Verge',flclash:'FlClash',mihomo:'Mihomo / 其他',legacy:'旧记录（客户端未标记）'})[client]||'未知客户端';}
function airportName(clash,id){return clash.airportGroups?.find(group=>group.id===id)?.name||clash.airportUsage?.find(row=>row.airport===id&&row.airportName)?.airportName||'未归类机场';}
function selectedLadderFilter(){return {client:$('proxyClientFilter').value||'all',airport:$('proxyAirportFilter').value||'all'};}
function ladderFilterKey(){const filter=selectedLadderFilter();return `${queryKey()}|${filter.client}|${filter.airport}`;}
function currentLadderData(){
  const filter=selectedLadderFilter();if(filter.client==='all'&&filter.airport==='all')return data?.clash||null;
  return ladderFilterDataKey===ladderFilterKey()?ladderFilterData:null;
}
function clearLadderDetail(){detailAbort?.abort();detailSequence++;activeLadderDetail=ladderDetailData=null;$('ladderDetail').hidden=true;}
async function loadLadderFilter(force=false){
  const {client,airport}=selectedLadderFilter(),key=ladderFilterKey();
  if(client==='all'&&airport==='all'){ladderFilterAbort?.abort();ladderFilterSequence++;ladderFilterData=null;ladderFilterDataKey='';ladderFilterPendingKey='';ladderFilterError='';if(view==='ladder')renderLadder();return;}
  if(!force&&ladderFilterDataKey===key&&ladderFilterData){if(view==='ladder')renderLadder();return;}
  if(!force&&ladderFilterDataKey===key&&ladderFilterError){if(view==='ladder')renderLadder();return;}
  if(!force&&ladderFilterPendingKey===key)return;
  ladderFilterAbort?.abort();ladderFilterAbort=new AbortController();const signal=ladderFilterAbort.signal,sequence=++ladderFilterSequence;
  ladderFilterPendingKey=key;ladderFilterError='';if(view==='ladder')renderLadder();
  const params=rangeParams();params.set('client',client);if(airport!=='all')params.set('airport',airport);
  try{
    const result=await api('/api/ladder?'+params,{signal});if(signal.aborted||sequence!==ladderFilterSequence)return;
    if(!result.available)throw new Error('Clash 历史暂不可读');ladderFilterData=result;ladderFilterDataKey=key;ladderFilterError='';
  }catch(error){if(signal.aborted||sequence!==ladderFilterSequence||isCancelled(error))return;ladderFilterError=error.message;ladderFilterData=null;ladderFilterDataKey=key;}
  finally{if(sequence===ladderFilterSequence){ladderFilterPendingKey='';if(view==='ladder')renderLadder();}}
}
async function loadAirportInventory(force=false){
  const key=queryKey();if(airportInventoryKey&&airportInventoryKey!==key)airportNodeLimit=120;if(!force&&airportInventoryKey===key&&airportInventory)return;
  if(airportInventoryPendingKey===key)return;
  airportInventoryAbort?.abort();airportInventoryAbort=new AbortController();const signal=airportInventoryAbort.signal,sequence=(loadAirportInventory.sequence||0)+1;loadAirportInventory.sequence=sequence;
  airportInventoryPendingKey=key;airportInventoryError='';setText($('airportNodeCount'),'正在读取此时间范围的代理节点…');
  try{
    const result=await api('/api/ladder/nodes?'+rangeParams(),{signal});if(signal.aborted||sequence!==loadAirportInventory.sequence)return;
    if(!result.available)throw new Error('梯子历史暂不可读');airportInventory=result.clientNodes||[];airportInventoryKey=key;airportInventoryError='';
  }catch(error){if(signal.aborted||sequence!==loadAirportInventory.sequence||isCancelled(error))return;airportInventory=null;airportInventoryKey=key;airportInventoryError=error.message;}
  finally{if(sequence===loadAirportInventory.sequence){airportInventoryPendingKey='';if(view==='ladder'&&data?.clash)renderAirportManager(data.clash);}}
}
function renderAirportControls(clash){
  const select=$('proxyAirportFilter'),current=select.value||'all',options=[['all','全部机场'],['__unassigned__','未归类机场'],...(clash.airportGroups||[]).map(group=>[group.id,group.name])];
  const known=new Set(options.map(([id])=>id));
  for(const row of clash.airportUsage||[])if(row.airport&&row.airportName&&!known.has(row.airport)){
    options.push([row.airport,row.airportName]);known.add(row.airport);
  }
  select.replaceChildren(...options.map(([value,label])=>{const option=node('option',label);option.value=value;return option;}));
  select.value=options.some(([value])=>value===current)?current:'all';
}
function renderAirportUsage(clash){
  const target=$('airportUsageRows'),rows=clash?.airportUsage||[],proxyTotal=total(clash?.groups?.proxy);target.replaceChildren();
  if(ladderFilterError){const retry=node('button',`机场统计未完成：${ladderFilterError}。点击重试`,'empty-state');retry.type='button';retry.addEventListener('click',()=>loadLadderFilter(true));target.append(retry);return;}
  if(!clash){target.append(node('p',ladderFilterPendingKey?'正在按客户端与机场重新汇总…':'选择客户端或机场后显示用量。','empty-state'));return;}
  if(clash.detailReady===false){target.append(node('p','正在汇总机场用量…','empty-state'));return;}
  if(!rows.length){target.append(node('p','当前范围没有可归因到代理节点的流量。','empty-state'));return;}
  for(const row of rows){
    const button=node('button');button.type='button';button.className='airport-usage-row';
    const identity=node('span',undefined,'airport-usage-identity'),title=node('strong',row.airportName||airportName(clash,row.airport)),client=node('small',proxyClientName(row.client)+(row.airportName?' · 自动识别':''));identity.append(title,client);
    const directions=node('span',undefined,'airport-usage-directions');directions.append(node('small',`↑ ${bytes(row.up)}　↓ ${bytes(row.down)}`),node('small',`${row.connections.toLocaleString('zh-CN')} 条连接 · ${proxyTotal?percent(total(row)/proxyTotal*100):'—'}`));
    const amount=node('strong',bytes(total(row)),'airport-usage-amount');button.append(identity,directions,amount);
    button.addEventListener('click',()=>{
      $('proxyClientFilter').value=row.client;$('proxyAirportFilter').value=row.airport||'__unassigned__';clearLadderDetail();loadLadderFilter();
    });target.append(button);
  }
}
function renderAirportManager(clash){
  const groups=clash.airportGroups||[],inventoryReady=airportInventoryKey===queryKey()&&airportInventory!==null,nodes=inventoryReady?airportInventory:[],search=$('airportNodeSearch').value.trim().toLocaleLowerCase(),name=$('airportGroupName').value.trim();
  if(document.querySelector('.airport-manager').open&&!inventoryReady&&!airportInventoryPendingKey&&!(airportInventoryKey===queryKey()&&airportInventoryError))loadAirportInventory();
  const editing=groups.find(group=>group.name.toLocaleLowerCase()===name.toLocaleLowerCase());
  if(airportNodeSelection===null)airportNodeSelection=new Set((editing?.members||[]).map(member=>`${member.client}\0${member.node}`));
  const matching=nodes.filter(item=>!search||`${proxyClientName(item.client)} ${item.name}`.toLocaleLowerCase().includes(search));
  const choices=$('airportNodeChoices');choices.replaceChildren();
  for(const item of matching.slice(0,airportNodeLimit)){
    const label=node('label',undefined,'airport-node-choice'),checkbox=node('input');checkbox.type='checkbox';checkbox.dataset.client=item.client;checkbox.dataset.node=item.name;checkbox.checked=airportNodeSelection.has(`${item.client}\0${item.name}`);
    checkbox.addEventListener('change',()=>{const key=`${item.client}\0${item.name}`;if(checkbox.checked)airportNodeSelection.add(key);else airportNodeSelection.delete(key);});
    label.append(checkbox,node('span',`${proxyClientName(item.client)} · ${item.name}`),node('small',bytes(Number(item.up||0)+Number(item.down||0))));choices.append(label);
  }
  const count=$('airportNodeCount'),countText=airportInventoryError?`节点列表读取失败：${airportInventoryError}`:!inventoryReady?`展开后读取当前时段已采集到的客户端与出口节点。`:nodes.length?`显示 ${Math.min(airportNodeLimit,matching.length)} / ${matching.length} 个匹配节点 · 历史中共 ${nodes.length} 个客户端节点；可输入关键词缩小范围。`:'这个时段没有新采集到可识别客户端的代理节点。';
  count.replaceChildren(node('span',countText));
  if(airportInventoryError){const retry=node('button','重试读取','quiet-button');retry.type='button';retry.addEventListener('click',()=>loadAirportInventory(true));count.append(' ',retry);}
  else if(inventoryReady&&matching.length>airportNodeLimit){const more=node('button','显示更多节点','quiet-button');more.type='button';more.addEventListener('click',()=>{airportNodeLimit+=120;renderAirportManager(clash);});count.append(' ',more);}
  const groupList=$('airportGroupRows');groupList.replaceChildren();
  if(!groups.length)groupList.append(node('p','可手动归类旧记录或未识别的节点。','empty-state'));
  for(const group of groups){
    const row=node('div',undefined,'airport-group-row'),edit=node('button',`${group.name} · ${group.members.length} 个节点`,'quiet-button');edit.type='button';edit.addEventListener('click',()=>{airportNodeSelection=new Set(group.members.map(member=>`${member.client}\0${member.node}`));$('airportGroupName').value=group.name;$('airportNodeSearch').value='';renderAirportManager(clash);});
    const remove=node('button','删除归类','quiet-button');remove.type='button';remove.addEventListener('click',()=>{if($('airportGroupName').value===group.name){$('airportGroupName').value='';airportNodeSelection=new Set();}saveAirportGroups(groups.filter(item=>item.id!==group.id),'已删除机场归类；历史连接会回到未归类。');});
    row.append(edit,remove);groupList.append(row);
  }
}
async function saveAirportGroups(groups,successText){
  const button=$('saveAirportGroup');button.disabled=true;$('airportGroupStatus').textContent='正在保存机场归类…';
  try{
    const saved=await api('/api/airport-groups',{method:'POST',body:JSON.stringify({groups})});
    if(data?.clash)data.clash.airportGroups=saved.groups;
    $('airportGroupStatus').textContent=successText||'机场归类已保存，所选历史时段正在重新汇总。';dataKey='';clearDetails();renderLadder();refresh(true);
  }catch(error){$('airportGroupStatus').textContent=`保存失败：${error.message}`;}
  finally{button.disabled=false;}
}
function renderLadder() {
  const base=data?.clash;
  if (!base?.available) {
    if(data) {$('routeSummary').replaceChildren(node('p','梯子历史暂不可读，点击刷新可重试。','empty-state'));for(const id of ['ladderProcessRows','ladderDomainRows','ladderNodeRows'])$(id).replaceChildren(node('p','等待历史记录…','empty-state'));$('ladderChart').width=1;$('ladderChart').height=1;}
    return;
  }
  renderAirportControls(base);renderAirportManager(base);
  const ladder=currentLadderData();renderAirportUsage(ladder);
  if(!ladder){
    $('routeSummary').replaceChildren(node('p','正在按客户端与机场汇总所选时段…','empty-state'));
    for(const id of ['ladderProcessRows','ladderDomainRows','ladderNodeRows'])$(id).replaceChildren(node('p','正在汇总筛选结果…','empty-state'));
    releaseChart($('ladderChart'));if(!ladderFilterPendingKey&&!ladderFilterError)loadLadderFilter();return;
  }
  renderTotals($('routeSummary'), { ...ladder.groups,...(ladder.unassigned?{unassigned:ladder.unassigned}:{}) }, (route) => {
    $('routeFilter').value = route;
    detailAbort?.abort();detailSequence++;
    activeLadderDetail = null; ladderDetailData = null; $('ladderDetail').hidden = true;
    renderLadder();
  });
  const filtered = $('routeFilter').value;
  const routes = filtered === 'all' ? ['proxy', 'direct', 'unknown'] : [filtered];
  const routeNames = { proxy: '代理出口', direct: 'DIRECT 直连', unknown: '出口未知' };
  drawChart($('ladderChart'), routes.map((key) => chartSeries(routeNames[key], ladder.routeTimeline, ladder, key)),
    (point) => loadLadderDetail({ from: point.from, to: point.to, title: '梯子时段明细' }), { range: data.clash.range, ticks: 'ladderTicks' });
  const routeRows = filtered === 'all' ? ladder.allPrograms : ladder.routePrograms?.[filtered] || [];
  renderCompactPrograms($('ladderProcessRows'), routeRows, 15,
    (row) => loadLadderDetail({ process: row.process || '__unknown__', title: row.name }));
  renderCompactPrograms($('ladderDomainRows'), ladder.routeDomains?.[filtered] || ladder.domains, 15,
    (row) => loadLadderDetail({ host: row.name, title: row.name }));
  renderCompactPrograms($('ladderNodeRows'), ladder.routeNodes?.[filtered] || ladder.nodes, 8,
    (row) => loadLadderDetail({ node: row.name, title: `出口节点 · ${row.name}` }));
  if(ladder.detailReady === false) for (const id of ['ladderProcessRows','ladderDomainRows','ladderNodeRows']) $(id).replaceChildren(node('p','正在汇总连接归因…','empty-state'));
  $('ladderAccountingNote').textContent = ladder.connectionCountersExceedGlobal
    ? '连接累计超过 Clash 全局计数。短连接、采样时点和计数重置都会造成差异；此处用于定位，不是精确账单。'
    : '按已采集的出口节点连接累计；旧记录会标为客户端未识别。短连接可能低估，此统计用于定位，不是机场账单。';
  if (activeLadderDetail && ladderDetailData) renderLadderDetail(activeLadderDetail, ladderDetailData);
}
async function loadLadderDetail(selection) {
  detailAbort?.abort(); detailAbort = new AbortController();
  const signal = detailAbort.signal, key = queryKey();
  activeLadderDetail = selection;
  ladderDetailData = null;
  $('ladderDetail').hidden = false;
  $('ladderDetailTitle').textContent = selection.title;
  $('ladderDetailMeta').textContent = `${selection.from ? time(selection.from,true)+' 至 '+time(selection.to,true)+' · ' : ''}正在读取这个范围的应用与连接…`;
  $('ladderDetail').setAttribute('aria-busy','true');$('exportLadderDetail').disabled=true;$('ladderDetailRetry').hidden=true;
  $('ladderConnectionRows').replaceChildren();$('ladderPager').replaceChildren();releaseChart($('ladderDetailChart'));
  // Navigate as soon as the click is accepted. History work must not hold the
  // user at the chart with no visible acknowledgement of the selected interval.
  $('ladderDetail').scrollIntoView({behavior:'smooth',block:'start'});
  const current = ++detailSequence;
  try {
    const result = await requestDetail('clash', {
      process: selection.process,
      host: selection.host,
      node: selection.node,
      route: $('routeFilter').value,
      client:selection.client??$('proxyClientFilter').value,
      airport:(selection.airport??$('proxyAirportFilter').value)==='all'?'':selection.airport??$('proxyAirportFilter').value,
      from: selection.from,
      to: selection.to,
      page: selection.page || 0,
    }, { signal });
    if (current !== detailSequence || key !== queryKey() || signal.aborted) return;
    if (!result.available) throw new Error('该采集源尚未建立历史记录');
    ladderDetailData = result;
    $('ladderDetail').setAttribute('aria-busy','false');$('exportLadderDetail').disabled=false;$('ladderDetailRetry').hidden=true;
    if (view === 'ladder') renderLadderDetail(selection, result);
  } catch (error) { if(current === detailSequence && !isCancelled(error)) {$('ladderDetail').setAttribute('aria-busy','false');$('ladderDetailMeta').textContent = `连接明细暂不可用：${error.message}。`;$('ladderDetailRetry').hidden=false;} }
}
function renderLadderDetail(selection, result) {
  $('ladderDetail').hidden = false;
  $('ladderDetailTitle').textContent = selection.title;
  const routeBytes = total(result.routeTotals.proxy);
  $('ladderDetailMeta').textContent = `${time(result.range.from, true)} 至 ${time(result.range.to, true)} · 代理 ${bytes(routeBytes)} · DIRECT ${bytes(total(result.routeTotals.direct))} · 未知 ${bytes(total(result.routeTotals.unknown))} · 共 ${result.pagination.total} 条连接，汇总含全部结果`;
  const filtered = $('routeFilter').value, routes = filtered === 'all' ? ['proxy', 'direct', 'unknown'] : [filtered];
  const routeNames = { proxy: '代理出口', direct: 'DIRECT 直连', unknown: '出口未知' };
  drawChart($('ladderDetailChart'), routes.map((key) => chartSeries(routeNames[key], result.series, result.observation || data?.clash, key)),
    (point) => loadLadderDetail({ ...selection, page: 0, from: point.from, to: point.to }), { range: result.range, fullRange: true });
  const body = $('ladderConnectionRows'); body.replaceChildren();
  if (!result.connections.length) { const tr = node('tr'); const td = node('td', '这个时段没有匹配的代理连接。', 'empty-state'); td.colSpan = 9; tr.append(td); body.append(tr); }
  for (const row of result.connections) {
    const tr = node('tr');
    tr.append(node('td',proxyClientName(row.client)),node('td',row.airportName||airportName(data?.clash||{},row.airport)),node('td', time(row.lastAt, true)), node('td', row.process || '未识别'), node('td', row.host), node('td', row.node || '未知出口'), node('td', bytes(row.up)), node('td', bytes(row.down)), node('td', bytes(row.amount), 'numeric-strong'));
    body.append(tr);
  }
  renderPager('ladderPager', result.pagination, (page) => loadLadderDetail({ ...selection, page }));
}
function renderHarnessTabs() {
  const target = $('harnessTabs'); target.replaceChildren();
  for (const family of ['codex', 'claude', 'dsh']) {
    const button = node('button', familyNames[family]); button.type = 'button'; button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(activeFamily === family));
    button.addEventListener('click', () => { activeFamily = family; renderHarnessTabs(); loadHarness(family); });
    target.append(button);
  }
}
async function loadHarness(family, force = false) {
  activeFamily = family;
  const key = `${family}|${queryKey()}|${JSON.stringify(apps)}`;
  if (!force && key === harnessLoadedKey && !harnessAbort?.signal.aborted && Date.now() - harnessLoadedAt < 60000) return;
  harnessAbort?.abort(); harnessAbort = new AbortController(); const signal=harnessAbort.signal, rangeKey=queryKey();
  harnessLoadedKey = key;
  harnessLoadedAt = Date.now();
  const current = ++harnessSequence;
  $('harnessSelectedName').textContent = familyNames[family];
  if (harnessResultKey!==key) {
    harnessResult=null;
    const preview=dataKey===rangeKey&&data?.machine?.detailReady!==false?data?.machine?.familyTotals?.[family]:null;
    $('harnessTotal').textContent = preview?bytes(total(preview)):'读取中'; $('harnessProxyTotal').textContent = '读取中';
    $('harnessShare').textContent=preview&&total(data?.machine?.totals)?percent(total(preview)/total(data.machine.totals)*100):'—';$('harnessPeak').textContent='正在读取时段分布…';
    $('harnessProcessRows').replaceChildren(node('p', '正在读取…', 'empty-state'));
    releaseChart($('harnessChart'));$('harnessDirections').textContent=preview?`↑ ${bytes(preview.up)}　↓ ${bytes(preview.down)} · 总览已统计`:'正在读取所选分组…';$('harnessNotice').replaceChildren();
  }
  const results=[null,null],errors=[];
  const valid=()=>current===harnessSequence&&rangeKey===queryKey()&&!signal.aborted;
  await Promise.all(['windows','clash'].map(async(lane,index)=>{
    const params=rangeParams();params.set('lane',lane);params.set('family',family);if(force)params.set('fresh','1');
    try{results[index]=await api('/api/harness?'+params,{signal});}
    catch(error){if(isCancelled(error)||!valid())return;results[index]={available:false,error:error.message};errors.push(`${index?'梯子':'本机'}：${error.message}`);}
    if(!valid())return;
    harnessResult=[family,...results];harnessResultKey=key;
    if(view==='harness')renderHarness(...harnessResult);
  }));
  if(!valid())return;
  if(errors.length||results.some(value=>!value?.available))harnessLoadedKey='';
  else harnessLoadedAt=Date.now();
}
function renderHarness(family, machine, proxy) {
  const machineReady=machine?.available===true,proxyReady=proxy?.available===true;
  const preview=dataKey===queryKey()&&data?.machine?.detailReady!==false?data?.machine?.familyTotals?.[family]:null;
  const machineSummary=machineReady?machine.summary:preview;
  const machineBytes = total(machineSummary);
  const proxyBytes = total(proxy?.routeTotals?.proxy);
  const systemBytes = total(data?.machine?.totals);
  $('harnessSelectedName').textContent = familyNames[family];
  $('harnessTotal').textContent = machineSummary?bytes(machineBytes):machine?'暂不可用':'读取中';
  $('harnessDirections').textContent = machineSummary?`↑ ${bytes(machineSummary.up)}　↓ ${bytes(machineSummary.down)}${machineReady?'':' · 总览已统计'}`:machine?'本机记录读取失败':'正在读取所选分组…';
  $('harnessProxyTotal').textContent = proxyReady?bytes(proxyBytes):proxy?'暂不可用':'读取中';
  $('harnessProxyShare').textContent = 'Clash 代理连接独立计数，与左侧不相加';
  $('harnessShare').textContent = machineSummary&&systemBytes ? percent((machineBytes / systemBytes) * 100) : '—';
  $('harnessPeak').textContent = machineReady?`最高时段 ${peakFrom(machine.series)}`:machine?'时段分布暂不可用':'正在读取时段分布…';
  const series=[];if(machineReady)series.push(chartSeries('本机进程记录',machine.series,machine.observation));if(proxyReady)series.push(chartSeries('梯子代理出口',proxy.series,proxy.observation,'proxy'));
  if(series.length)drawChart($('harnessChart'),series,(point)=>showTimeDetail(point.from,point.to,familyNames[family],{family}),{range:(machineReady?machine:proxy).range});
  if(machineReady)renderCompactPrograms($('harnessProcessRows'),machine.processes,15,(row)=>selectApp(row,{family}));
  else $('harnessProcessRows').replaceChildren(node('p',machine?'本机进程列表暂不可用；再次点击分组可重试。':'正在读取本机进程…','empty-state'));
  const notice = $('harnessNotice'); notice.replaceChildren();
  if(machine&&!machineReady||proxy&&!proxyReady){notice.className='warning-list has-warning';for(const [name,value]of [['本机',machine],['梯子',proxy]])if(value&&!value.available)notice.append(node('p',`${name}：${value.error==='missing_database'?'尚未建立记录':value.error||'暂不可读'}。再次点击分组可重试。`));}
  else if(!machine||!proxy){notice.className='warning-list';notice.append(node('p',`${!machine?'本机':'梯子'}时段分布正在读取，已完成的来源先行显示。`));}
  else if (!machineBytes) {
    notice.className = 'warning-list has-warning';
    notice.append(node('p', family === 'dsh'
      ? '所选时段没有可归入 dsh 的记录。已支持通过 dsh 的 Node 启动脚本识别及其子进程；旧记录缺少这项证据时保留为其他应用。'
      : '所选时段没有匹配到此 Harness 的连接记录。'));
  } else {
    notice.className = 'warning-list';
    if (family !== 'codex') notice.append(node('p', '既有历史按已有进程证据归组；新版本启用后额外记录脚本与父子进程归属。'));
  }
}
function peakFrom(rows) {
  const peak = [...rows].sort((a, b) => total(b) - total(a))[0];
  return peak && total(peak) > 0 ? `${time(peak.at, true)} · ${bytes(total(peak))}` : '暂无峰值';
}
function renderInvestigation() {
  if (!data?.machine) return;
  renderPeaks($('issueRows'), data.machine.peaks, 'machine');
  const unknown = (data.machine.allPrograms || []).filter((row) => row.family === 'unknown' || row.scope === 'unknown');
  renderCompactPrograms($('unknownRows'), unknown, 12, (row) => selectApp(row));
  const gapSummary = $('gapSummary'); gapSummary.replaceChildren();
  for (const [label, item] of [['本机', data.machine], ['梯子', data.clash]]) {
    const section = node('div', undefined, `gap-metric ${item.gaps ? 'has-gap' : ''}`);
    section.append(node('span', label), node('strong', `${percent(item.coverage?.percent)} 覆盖`), node('small', `${item.gaps || 0} 段记录缺口 · ${item.retentionDays === 0 ? '无限保留' : `${item.retentionDays} 天保留`}`));
    gapSummary.append(section);
  }
  const gaps = [
    ...(data.machine.gapDetails || []).map((item) => ({ ...item, source: '本机' })),
    ...(data.clash.gapDetails || []).map((item) => ({ ...item, source: '梯子' })),
  ].sort((a, b) => b.gapFrom - a.gapFrom).slice(0, 40);
  const target = $('gapRows'); target.replaceChildren();
  if (!gaps.length) target.append(node('p', '所选时段没有记录到采集缺口。', 'empty-state'));
  for (const gap of gaps) {
    const reasons = gapReasons;
    const row = node('div', undefined, 'gap-row');
    row.append(node('span', gap.source, 'gap-source'), node('strong', time(gap.gapFrom, true)), node('span', gap.ongoing ? '仍在持续' : time(gap.gapTo, true)), node('span', duration(gap.durationMs)), node('span', reasons[gap.reason] || gap.reason));
    target.append(row);
  }
}
function renderSettings() {
  if (!data?.machine) return;
  settingsInitialized = true;
  $('monthlyMachineLimit').value = preferences.monthlyMachineGb || '';
  $('monthlyProxyLimit').value = preferences.monthlyProxyGb || '';
  $('notificationsEnabled').checked = preferences.notificationsEnabled;
  const detected = $('detectedProcesses'); detected.replaceChildren();
  const names = [...new Set((data.machine.allPrograms || []).map((row) => row.process).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const name of names) { const option = node('option'); option.value = name; detected.append(option); }
  renderAliases();
}
function renderAliases() {
  if (!apps) return;
  const target = $('aliasGroups'); target.replaceChildren();
  for (const family of ['claude', 'dsh']) {
    const section = node('section', undefined, 'alias-family');
    section.append(node('h4', familyNames[family]));
    const list = node('div', undefined, 'alias-list');
    for (const name of apps[family] || []) {
      const chip = node('span', undefined, 'alias-chip');
      chip.append(node('span', name));
      const remove = node('button', '×'); remove.type = 'button'; remove.title = `移除 ${name}`; remove.setAttribute('aria-label', `移除 ${familyNames[family]} 进程名 ${name}`);
      remove.addEventListener('click', () => updateAlias(family, name, false));
      chip.append(remove); list.append(chip);
    }
    if (!list.childNodes.length) list.append(node('span', '暂无别名', 'muted'));
    section.append(list); target.append(section);
  }
  const codex = node('section', undefined, 'alias-family');
  codex.append(node('h4', 'Codex · 由采集配置识别'));
  codex.append(node('div', (apps.codex || []).join(' · ') || '没有 Codex 进程名', 'locked-aliases'));
  target.append(codex);
  target.append(node('p', '自动识别：Codex / Claude Code / dsh 的官方 Node 启动脚本及其子进程。通用 node.exe、PowerShell 不能整体加入某个分组。', 'fine-print'));
}
async function updateAlias(family, process, add) {
  const status = $('aliasStatus'); status.textContent = '正在同步到两路采集…';
  const next = { codex: apps.codex, claude: [...apps.claude], dsh: [...apps.dsh] };
  const name = process.trim().split(/[\\/]/).at(-1).toLowerCase();
  next[family] = add ? [...new Set([...next[family], name])] : next[family].filter((item) => item !== name);
  if (['codex', 'claude', 'dsh'].some((key) => key !== family && next[key].includes(name))) {
    status.textContent = '这个进程名已经属于其他分组。'; return;
  }
  try {
    const result = await api('/api/harness-apps', { method: 'POST', body: JSON.stringify({ apps: next }) });
    apps = result.apps;
    $('aliasProcess').value = '';
    status.textContent = '规则已同步；直接进程历史已按新分组归类，后续子进程会保留归属。';
    await refresh(true);
    renderAliases();
  } catch (error) { status.textContent = `规则未保存：${error.message}`; }
}
function renderBudgetSettingsStatus() {
  $('limitsStatus').textContent = preferences.monthlyMachineGb || preferences.monthlyProxyGb
    ? '参考线保存在当前浏览器本机配置中；达到上限时仅在此页面打开且已启用通知的情况下提醒。'
    : '参考线为可选项，留空或设为 0 表示不显示。';
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function exportCsv(filename, columns, rows) {
  const content = '\uFEFF' + [columns.map((item) => csvCell(item.label)).join(','), ...rows.map((row) => columns.map((item) => csvCell(typeof item.value === 'function' ? item.value(row) : row[item.value])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = node('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportAppsCsv(rows, name) {
  exportCsv(name, [
    { label: '进程名', value: (row) => row.process || row.name },
    { label: 'Harness', value: (row) => familyNames[row.family] || row.family },
    { label: '归因范围', value: 'scope' }, { label: '证据', value: (row) => evidenceNames[row.evidence] || row.evidence },
    { label: '上传字节', value: 'up' }, { label: '下载字节', value: 'down' },
    { label: '合计字节', value: total }, { label: '连接数', value: 'connections' },
    { label: '首活动', value: (row) => time(row.firstAt, true) }, { label: '末活动', value: (row) => time(row.lastAt, true) },
  ], rows);
}
function exportConnectionsCsv(rows, filename) {
  exportCsv(filename, [
    { label: '进程名', value: 'process' }, { label: 'PID', value: 'pid' }, { label: '目标', value: 'host' },
    { label: '客户端', value: (row) => proxyClientName(row.client) }, { label: '机场', value: (row) => row.airportName||airportName(data?.clash||{},row.airport) },
    { label: 'Harness', value: (row) => familyNames[row.family] || row.family }, { label: '出口', value: (row) => row.node || row.route || '' },
    { label: '证据', value: (row) => evidenceNames[row.evidence] || row.evidence }, { label: '上传字节', value: 'up' },
    { label: '下载字节', value: 'down' }, { label: '合计字节', value: total },
    { label: '最后活动', value: (row) => time(row.lastAt, true) },
  ], rows);
}
function renderCurrentView() {
  if (document.hidden) return;
  renderHeader();
  if (view === 'overview') renderOverview();
  else if (view === 'apps') renderApps();
  else if (view === 'ladder') renderLadder();
  else if (view === 'harness') { renderHarnessTabs(); if (harnessResult?.[0] === activeFamily) renderHarness(...harnessResult); loadHarness(activeFamily); }
  else if (view === 'investigate') renderInvestigation();
  else if (view === 'settings' && !settingsInitialized) renderSettings();
}
function acceptOverview(next, key, quick) {
  const previous = dataKey === key ? data : null;
  if (!quick && previous?.generatedAt && previous.generatedAt === next.generatedAt &&
      previous.machine?.detailReady !== false && previous.clash?.detailReady !== false &&
      next.machine?.available && next.clash?.available) {
    // Cache hits and focus changes must not rebuild unchanged tables/canvases.
    data = { ...previous, refreshing: next.refreshing };
    document.querySelector('main').classList.remove('range-loading');
    $('globalNotice').hidden = true;
    renderHeader();
    return;
  }
  const merged = { ...next };
  const retained = [];
  for (const lane of ['machine','clash']) {
    if (!next[lane]?.available && previous?.[lane]?.available) {
      merged[lane] = previous[lane]; retained.push(lane === 'machine' ? '本机' : '梯子');
    } else if (quick && previous?.[lane]?.detailReady !== false && previous?.[lane]?.available) {
      merged[lane] = { ...next[lane] };
      for (const field of ['allPrograms','programs','familyTotals','unassigned','connectionCountersExceedGlobal','routePrograms','domains','nodes','routeDomains','routeNodes','detailReady']) merged[lane][field] = previous[lane][field];
    }
  }
  data = merged; dataKey = key; apps = next.apps || apps;
  document.querySelector('main').classList.remove('range-loading');
  const missing = ['machine','clash'].filter(lane=>!next[lane]?.available);
  $('globalNotice').hidden = !missing.length;
  if (missing.length) $('globalNotice').textContent = retained.length ? retained.join(' / ') + '暂时不可读，已保留该时间范围上次成功的记录。' : '部分历史暂时不可读，可点击刷新重试；采集状态单独更新。';
  renderCurrentView();
}
function refresh(force = false) {
  if (document.hidden) return Promise.resolve();
  const key = queryKey();
  // Repeated refreshes join the current query. Aborting it on every import
  // completion or click can permanently starve a large first attribution.
  if (refreshPromise && refreshKey === key) return refreshPromise;
  historyAbort?.abort(); historyAbort = new AbortController();
  const signal = historyAbort.signal, current = ++refreshSequence;let preparing=false;
  clearTimeout(refreshTimer);clearTimeout(progressTimer);historyProgress=null;historyStartedAt=Date.now();refreshAfterImport=false;
  refreshKey = key; historyState = 'loading'; historyError = '';
  if (dataKey !== key) {
    const snapshot = snapshotCache.get(key);
    if (snapshot) { data = snapshot; dataKey = key; renderCurrentView(); }
    document.querySelector('main').classList.toggle('range-loading',dataKey !== key);
    $('globalNotice').hidden = dataKey === key;
    if (dataKey !== key) $('globalNotice').textContent = '正在读取' + rangeLabel() + '，暂时保留先前画面；加载期间无法点击旧时段。';
  }
  renderHeader();
  const params=rangeParams();
  const pollProgress=async()=>{
    if(current!==refreshSequence||signal.aborted||document.hidden)return;
    try{
      const progress=await api('/api/overview-progress?'+params,{signal,timeoutMs:3000});
      if(current!==refreshSequence||signal.aborted)return;
      historyProgress=progress;renderHeader();
    }catch{/* A progress-poll failure must never interrupt the actual query. */}
    if(current===refreshSequence&&!signal.aborted&&historyState==='loading')progressTimer=setTimeout(pollProgress,1000);
  };
  progressTimer=setTimeout(pollProgress,300);
  const run = async () => {
    let quickOk = false;
    try {
      const hasCompleteRange = dataKey === key && data?.machine?.available && data?.clash?.available &&
        data.machine.detailReady !== false && data.clash.detailReady !== false;
      if (!hasCompleteRange) {
        try {
          const quick = await api('/api/overview?' + params + '&quick=1' + (force ? '&fresh=1' : ''), { signal, timeoutMs:15000 });
          if (current !== refreshSequence || signal.aborted) return;
          acceptOverview(quick,key,true); quickOk = true;
        } catch (error) { if(signal.aborted) return;if(error.code==='vault_migrating')throw error; }
      }
      // A visible, already loaded range needs one update, rather than replaying
      // cached quick/full responses and then rendering both a second time.
      const next = await api('/api/overview?' + params + ((force || hasCompleteRange) ? '&fresh=1' : ''), { signal });
      if (current !== refreshSequence || signal.aborted) return;
      historyState = 'ready'; acceptOverview(next,key,false);
      if (next.machine?.available && next.clash?.available) saveSnapshot(key,data);
      if (!next.machine?.available || !next.clash?.available) throw new Error('部分历史暂时不可读，保留已有记录');
      if ((preferences.monthlyMachineGb > 0 || preferences.monthlyProxyGb > 0) && Date.now()-monthLoadedAt > 300000) {
        try { monthData = await api('/api/overview?range=month&quick=1',{signal});monthLoadedAt=Date.now();if(view==='overview')renderBudgetStrip(); } catch { /* A budget refresh cannot block the selected range. */ }
      }
    } catch (error) {
      if (current !== refreshSequence || signal.aborted || isCancelled(error)) return;
      preparing=error.code==='vault_migrating';historyState = preparing?'loading':'error'; historyError = error.message;
      $('globalNotice').hidden = false;
      $('globalNotice').textContent = preparing?'正在打开加密历史，完成后自动显示；后台采集继续，不需要重复输入密码。':(quickOk ? '总量和趋势已加载，详细归因暂未完成。' : '历史更新暂未完成，已保留上次成功的记录。') + ' 点击右上角刷新可重试。';
    } finally {
      if (current === refreshSequence) {
        clearTimeout(progressTimer);historyStartedAt=0;historyProgress=null;
        refreshPromise = null; renderHeader();
        const afterImport=refreshAfterImport;refreshAfterImport=false;
        if (!document.hidden) refreshTimer = setTimeout(()=>refresh(afterImport),afterImport?0:preparing?1500:data?.refreshing?5000:range==='day'&&selectedDate<calendarDate()?300000:60000);
      }
    }
  };
  refreshPromise = run(); return refreshPromise;
}
async function refreshLive() {
  clearTimeout(liveTimer);
  if (document.hidden || liveAbort) return;
  const controller = liveAbort = new AbortController();
  try { livePacket = (await api('/api/live', { signal:controller.signal, timeoutMs:3000 })).live; if(!controller.signal.aborted)renderLiveStatus(); }
  catch { if(!controller.signal.aborted){setSourceStatus('machineStatus',null,'native');setSourceStatus('clashStatus',null,'mihomo');} }
  finally { if(liveAbort===controller)liveAbort=null;if(!document.hidden)liveTimer=setTimeout(refreshLive,5000); }
}
function clearDetails() {
  detailAbort?.abort(); harnessAbort?.abort();ladderFilterAbort?.abort();airportInventoryAbort?.abort();
  detailSequence++; harnessSequence++;ladderFilterSequence++;activeAppDetail = activeLadderDetail = appDetailData = ladderDetailData = harnessResult = null;
  ladderFilterData=null;ladderFilterDataKey=ladderFilterPendingKey=ladderFilterError='';
  airportInventory=null;airportInventoryKey=airportInventoryPendingKey=airportInventoryError='';
  detailHistory = []; harnessLoadedKey = ''; appPage = 0; $('appDetail').hidden = $('ladderDetail').hidden = true;
  for(const canvas of document.querySelectorAll('canvas')) releaseChart(canvas);
  hideChartTooltip();
}
async function exportAllConnections(lane, selection, result, button) {
  if (!selection || !result?.available) { showToast('先选择一个应用、节点或时段。'); return; }
  const oldLabel = button.textContent; button.disabled = true;
  try {
    const { title, ...filters } = selection;
    const query = { ...filters, from: result.range.from, to: result.range.to, export: 1, page: 0 };
    if (lane === 'clash') query.route = $('routeFilter').value;
    const first = await requestDetail(lane, query);
    const rows = [...first.connections];
    for (let page = 1; page < first.pagination.pages; page++) {
      button.textContent = `导出 ${page + 1}/${first.pagination.pages}…`;
      rows.push(...(await requestDetail(lane, { ...query, page })).connections);
    }
    exportConnectionsCsv(rows, `${lane === 'clash' ? '梯子' : '本机'}连接明细.csv`);
    showToast(`已导出 ${rows.length} 条连接明细，保留当前时间与筛选。`);
  } catch (error) { showToast(`导出未完成：${error.message}`); }
  finally { button.disabled = false; button.textContent = oldLabel; }
}

$('range').addEventListener('change', () => {
  range = $('range').value;
  clearDetails();
  $('selectedDate').hidden = range !== 'day';
  if (range === 'day' && !$('selectedDate').value) $('selectedDate').value = selectedDate;
  refresh(true);
});
$('selectedDate').value = selectedDate;
$('selectedDate').max = selectedDate;
$('selectedDate').addEventListener('change', () => { selectedDate = $('selectedDate').value || selectedDate; clearDetails(); refresh(true); });
$('refreshButton').addEventListener('click', () => refresh(true));
$('proxyClientFilter').addEventListener('change',()=>{clearLadderDetail();loadLadderFilter();});
$('proxyAirportFilter').addEventListener('change',()=>{clearLadderDetail();loadLadderFilter();});
$('airportNodeSearch').addEventListener('input',()=>{airportNodeLimit=120;if(view==='ladder'&&data?.clash)renderAirportManager(data.clash);});
$('airportGroupName').addEventListener('input',()=>{if(view==='ladder'&&data?.clash)renderAirportManager(data.clash);});
$('clearAirportGroup').addEventListener('click',()=>{airportNodeSelection=new Set();for(const checkbox of $('airportNodeChoices').querySelectorAll('input[type="checkbox"]'))checkbox.checked=false;});
document.querySelector('.airport-manager').addEventListener('toggle',()=>{if(document.querySelector('.airport-manager').open&&data?.clash)loadAirportInventory();});
$('saveAirportGroup').addEventListener('click',()=>{
  const name=$('airportGroupName').value.trim(),selected=[...(airportNodeSelection||new Set())].map(key=>{const [client,nodeName]=key.split('\0');return {client,node:nodeName};});
  if(!name||!selected.length){$('airportGroupStatus').textContent='请填写机场名称，并至少选择一个出口节点。';return;}
  const groups=data?.clash?.airportGroups||[],existing=groups.find(group=>group.name.toLocaleLowerCase()===name.toLocaleLowerCase());
  const id=existing?.id||crypto.randomUUID().replaceAll('-',''),selectedKeys=new Set(selected.map(member=>`${member.client}\0${member.node}`));
  const next=groups.filter(group=>group.id!==id).map(group=>({...group,members:group.members.filter(member=>!selectedKeys.has(`${member.client}\0${member.node}`))}));
  next.push({id,name,members:selected});saveAirportGroups(next);
});
let searchTimer;
$('appSearch').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{appPage=0;renderApps();},120);});
$('appSort').addEventListener('change',()=>{appPage=0;renderApps();});
$('routeFilter').addEventListener('change', () => { renderLadder(); if (activeLadderDetail) loadLadderDetail({ ...activeLadderDetail, page: 0 }); });
$('exportApps').addEventListener('click', () => exportAppsCsv(data?.machine?.allPrograms || [], '本机应用流量.csv'));
$('exportAppDetail').addEventListener('click', () => exportAllConnections('windows', activeAppDetail, appDetailData, $('exportAppDetail')));
$('exportLadder').addEventListener('click', () => exportAppsCsv(data?.clash?.programs || [], '梯子代理应用.csv'));
$('exportLadderDetail').addEventListener('click', () => exportAllConnections('clash', activeLadderDetail, ladderDetailData, $('exportLadderDetail')));
$('appDetailRetry').addEventListener('click',()=>{if(activeAppDetail)openAppSelection(activeAppDetail,false);});
$('ladderDetailRetry').addEventListener('click',()=>{if(activeLadderDetail)loadLadderDetail(activeLadderDetail);});
$('inspectRange').addEventListener('click', () => {
  const from = Date.parse(`${$('inspectFrom').value}:00+08:00`), to = Date.parse(`${$('inspectTo').value}:00+08:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from > Date.now()) { showToast('请选择有效的开始和结束时间，结束需晚于开始。'); return; }
  showTimeDetail(from, to, '自选时段');
});
$('detailBack').addEventListener('click', () => { const previous = detailHistory.pop(); if (previous) openAppSelection(previous, false); });
$('backToApps').addEventListener('click', () => {
  detailAbort?.abort();detailSequence++; activeAppDetail = appDetailData = null; detailHistory=[];
  $('appDetail').hidden=true; $('appSearch').value=''; renderApps();
});
$('copyEvidence').addEventListener('click', async () => {
  if (!appDetailData?.available) return;
  const result = appDetailData;
  const report = [
    `TrafficWatch 排查摘要：${activeAppDetail.title}`,
    `${time(result.range.from,true)} 至 ${time(result.range.to,true)}（北京时间，结束不含）`,
    `上传 ${bytes(result.summary.up)}；下载 ${bytes(result.summary.down)}；合计 ${bytes(total(result.summary))}`,
    `连接归因 ${result.pagination.total} 条；应用：`,
    ...result.processes.slice(0,8).map((row) => `${row.name}: ↑${bytes(row.up)} ↓${bytes(row.down)} (${familyNames[row.family] || row.family})`),
    '主要目标：', ...result.destinations.slice(0,5).map((row) => `${row.name}: ${bytes(total(row))}`),
    '来源为本机 Windows 进程网络事件；回环与代理进程可能重复出现，未采集时段不补录。',
  ].join('\n');
  try { await navigator.clipboard.writeText(report); showToast('已复制排查摘要。'); }
  catch { exportCsv('排查摘要.csv', [{label:'内容',value:'text'}], report.split('\n').map((text) => ({text}))); }
});
$('addAlias').addEventListener('click', () => {
  const name = $('aliasProcess').value.trim();
  if (!name) { $('aliasStatus').textContent = '先选择或输入一个精确的进程名。'; return; }
  const family = $('aliasFamily').value;
  if (apps?.[family]?.includes(name.toLowerCase().split(/[\\/]/).at(-1))) { $('aliasStatus').textContent = '这个进程名已经在该分组中。'; return; }
  updateAlias(family, name, true);
});
$('aliasProcess').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('addAlias').click(); } });
$('saveLimits').addEventListener('click', () => {
  const machine = Number($('monthlyMachineLimit').value) || 0, proxy = Number($('monthlyProxyLimit').value) || 0;
  if (![machine, proxy].every((value) => Number.isFinite(value) && value >= 0 && value <= 1000000)) { $('limitsStatus').textContent = '参考上限应为 0 到 1000000 GB。'; return; }
  preferences.monthlyMachineGb = machine; preferences.monthlyProxyGb = proxy; savePreferences();
  $('limitsStatus').textContent = '参考线上限已保存到此浏览器。';
  refresh(true);
});
$('notificationsEnabled').addEventListener('change', async (event) => {
  if (event.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') event.target.checked = false;
  }
  preferences.notificationsEnabled = event.target.checked && 'Notification' in window && Notification.permission === 'granted';
  savePreferences();
  renderBudgetSettingsStatus();
});
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer); clearTimeout(liveTimer);clearTimeout(progressTimer); hideChartTooltip();
  if(document.hidden){historyAbort?.abort();liveAbort?.abort();detailAbort?.abort();harnessAbort?.abort();refreshSequence++;detailSequence++;harnessSequence++;harnessLoadedKey='';refreshPromise=null;for(const canvas of document.querySelectorAll('canvas'))releaseChart(canvas);}
  else{renderCurrentView();refreshLive();refresh();if(view==='apps'&&activeAppDetail&&!appDetailData)loadAppDetail(activeAppDetail);if(view==='ladder'&&activeLadderDetail&&!ladderDetailData)loadLadderDetail(activeLadderDetail);}
});
let resizeFrame;
window.addEventListener('trafficwatch-vault-locked',()=>{
  clearTimeout(refreshTimer);clearTimeout(liveTimer);clearTimeout(progressTimer);clearTimeout(searchTimer);cancelAnimationFrame(resizeFrame);
  refreshSequence++;detailSequence++;harnessSequence++;refreshPromise=null;
  historyAbort?.abort();liveAbort?.abort();detailAbort?.abort();harnessAbort?.abort();
  for(const canvas of document.querySelectorAll('canvas'))releaseChart(canvas);
});
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame=requestAnimationFrame(()=>{
  if(document.hidden)return;
  if (view === 'overview') renderOverview();
  if (view === 'ladder') renderLadder();
  if (view === 'apps' && appDetailData) renderAppDetail(activeAppDetail, appDetailData);
  if (view === 'harness' && harnessResult) renderHarness(...harnessResult);
  });
});
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); setView('overview'); });
renderBudgetSettingsStatus();
const initialView = location.hash.slice(1);
const initialParams=new URLSearchParams(location.search);
if(initialParams.get('range')==='day'&&/^\d{4}-\d{2}-\d{2}$/.test(initialParams.get('date')||'')){
  range='day';selectedDate=initialParams.get('date');$('range').value=range;$('selectedDate').value=selectedDate;$('selectedDate').hidden=false;
}
if (Object.hasOwn(pageNames, initialView)) setView(initialView);
refreshLive();
refresh(true);
