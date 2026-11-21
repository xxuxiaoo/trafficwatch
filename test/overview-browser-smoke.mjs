import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {once} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const [packageDir,outputDir,playwrightDir,browserPath]=process.argv.slice(2);
assert(packageDir&&outputDir&&playwrightDir,'usage: node test/overview-browser-smoke.mjs <package-dir> <new-output-dir> <playwright-dir> [browser-exe]');
const root=path.resolve(packageDir),target=path.resolve(outputDir),data=path.join(target,'data');
assert(!fs.existsSync(target),'smoke output must be a new directory');
fs.mkdirSync(target,{recursive:true});
const {chromium}=await import(pathToFileURL(path.resolve(playwrightDir,'index.mjs')));
const script=name=>path.join(import.meta.dirname,name);
const fixture=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',script('overview-gui-fixture.mjs'),data],{stdio:'inherit',windowsHide:true});
assert.equal(fixture.status,0,'isolated database setup failed');
const listeners=Array.from({length:4},()=>net.createServer());
await Promise.all(listeners.map(s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve))));
const ports=listeners.map(s=>s.address().port);
await Promise.all(listeners.map(s=>new Promise(resolve=>s.close(resolve))));
const server=spawn(process.execPath,['--disable-warning=ExperimentalWarning',script('overview-gui-server.mjs'),root,data,...ports.map(String)],{
  cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...process.env,TRAFFICWATCH_SINGLE_COLLECTOR:'0',TRAFFICWATCH_CACHE_ROOT:path.join(target,'cache')}
});
const exited=once(server,'exit'),base=`http://127.0.0.1:${ports[0]}`,headers={'x-codex-flow':'1'};
const errors=[],start=performance.now();let browser,standalone,standaloneExited,stage='health';
let firstTotalsMs, fullOverviewMs;
async function waitForViewer(child, url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Overview child exited: ${child.exitCode}`);
    try {
      const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(800) });
      const health = await response.json();
      if (response.ok && health.app === 'trafficwatch-overview' && health.collectorPid === child.pid) return health;
      lastError = new Error(`Unexpected viewer health response (HTTP ${response.status})`);
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Overview did not start', { cause: lastError });
}
try {
  await waitForViewer(server, base);
  stage='launch';
  browser=await chromium.launch({headless:true,timeout:10000, ...(browserPath?{executablePath:browserPath}:{}),args:['--disable-gpu']});
  const page=await browser.newPage({viewport:{width:1280,height:880}});page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  stage='overview';
  const opened=performance.now();
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:10000});
  await page.selectOption('#range','24h');
  await page.waitForFunction(()=>document.querySelector('#overviewMachine').textContent==='4.6 KB'&&document.querySelector('#overviewProxy').textContent==='32 KB');
  firstTotalsMs=Math.round(performance.now()-opened);
  const airport=page.locator('#overviewAirportRows .airport-usage-item');
  assert.equal(await airport.count(),1);
  assert.equal(await airport.locator('.airport-usage-identity').innerText(),'Example Air');
  assert.equal(await airport.locator('.airport-usage-amount').innerText(),'32 KB');
  assert.deepEqual((await airport.locator('.airport-client-filter').allTextContents()).sort(),['Clash Verge · 12 KB','FlClash · 20 KB']);
  assert(await page.locator('#controlStart').isVisible());
  await page.waitForFunction(()=>document.querySelector('#overviewHarness').textContent==='4.6 KB');
  fullOverviewMs=Math.round(performance.now()-opened);
  await page.screenshot({path:path.join(target,'overview.png'),timeout:10000});
  stage = 'complete stop is discoverable and cancellable';
  await page.locator('#advancedControls summary').click();
  const dialog = page.waitForEvent('dialog');
  const stopButton = page.getByRole('button', { name: '完全停止 TrafficWatch' });
  const click = stopButton.click();
  const confirmation = await dialog;
  assert.match(confirmation.message(), /停止采集、诊断、托盘和流量中心/);
  await confirmation.dismiss();
  await click;
  assert(await stopButton.isEnabled());
  await page.locator('#advancedControls summary').click();
  stage='airport drill-down';
  await airport.locator('.airport-usage-row').click();
  await page.waitForFunction(()=>document.querySelector('#activeAirportMeta').textContent.includes('32 KB'));
  await page.locator('#airportUsageRows .airport-client-filter').filter({hasText:'FlClash'}).click();
  await page.waitForFunction(()=>document.querySelector('#activeAirportMeta').textContent.includes('20 KB'));
  const node=page.locator('#ladderNodeRows button').filter({hasText:'HK-1'});
  await node.click();
  await page.locator('#ladderConnectionRows').getByText('192.0.2.21:443',{exact:false}).waitFor();
  const detail=await page.locator('#ladderConnectionRows').innerText();
  assert.match(detail,/FlClash[\s\S]*synthetic-flclash\.synthetic\.test[\s\S]*9 KB[\s\S]*11 KB/);
  assert.doesNotMatch(detail,/Clash Verge|192\.0\.2\.20/);
  await page.screenshot({path:path.join(target,'airport-detail.png'),fullPage:true,timeout:10000});
  await page.locator('#clearProxyFilters').click();
  await page.waitForFunction(()=>document.querySelector('#airportUsageRows .airport-usage-amount')?.textContent==='32 KB');
  stage='usage alert';
  await page.locator('.brand').click();
  await page.locator('#overviewWarnings button').filter({hasText:'Codex 上传突增'}).click();
  await page.locator('#appConnectionRows').getByText('synthetic-machine.synthetic.test',{exact:true}).waitFor();
  await page.locator('#backToApps').click();
  stage='other views and mobile';
  await page.locator('.primary-nav [data-view-button=apps]').click();
  await page.locator('#appRows strong').getByText('codex.exe',{exact:true}).waitFor();
  await page.locator('.primary-nav [data-view-button=harness]').click();
  await page.waitForFunction(()=>document.querySelector('#harnessTotal').textContent==='4.6 KB');
  await page.locator('.brand').click();
  await page.setViewportSize({width:390,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,'mobile viewport overflows');
  await page.screenshot({path:path.join(target,'overview-mobile.png'),fullPage:true,timeout:10000});
  stage='retired routes';
  for(const route of ['/history','/index.html','/api/airport-groups','/security','/vault.js','/api/vault/status','/api/ai/session'])assert.equal((await fetch(base+route,{headers})).status,404,route);
  stage = 'diagnostics and storage open without credentials';
  await page.goto(base+'/diagnostics',{waitUntil:'domcontentloaded'});
  await page.locator('#listTitle').waitFor();
  assert.match(page.url(), /\/diagnostics$/);
  await page.goto(base+'/storage',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#lanes').children.length===2);
  assert.match(page.url(), /\/storage$/);
  stage = 'portable overview omits inactive lane warnings';
  const [, machinePort, clashPort, standalonePort] = ports;
  standalone = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning', script('overview-gui-server.mjs'), root, path.join(data, 'windows'),
    String(standalonePort), String(machinePort), String(clashPort),
  ], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TRAFFICWATCH_SINGLE_COLLECTOR: '1', TRAFFICWATCH_DEMO: '1', TRAFFICWATCH_CACHE_ROOT: path.join(target, 'portable-cache') },
  });
  standaloneExited = once(standalone, 'exit');
  const portableBase = `http://127.0.0.1:${standalonePort}`;
  assert.equal((await waitForViewer(standalone, portableBase)).singleCollector, 'demo');
  const standalonePage = await browser.newPage();
  standalonePage.setDefaultTimeout(10000);
  standalonePage.on('pageerror', error => errors.push(error.message));
  await standalonePage.goto(portableBase, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await standalonePage.selectOption('#range', '24h');
  await standalonePage.waitForFunction(() => document.querySelector('#overviewHarness').textContent === '4.6 KB');
  assert(await standalonePage.locator('#globalNotice').isHidden());
  assert(await standalonePage.locator('#collectorControls').isHidden());
  assert.deepEqual(errors,[],'browser runtime errors');
  console.log(JSON.stringify({status:'passed',checks:11,firstTotalsMs,fullOverviewMs,milliseconds:Math.round(performance.now()-start),port:ports[0],output:target}));
} catch(error){
  throw new Error(`browser smoke failed at ${stage}: ${error.message}`,{cause:error});
} finally {
  await browser?.close();
  if (standalone?.exitCode === null) standalone.kill();
  if (standaloneExited) await standaloneExited;
  if(server.exitCode===null)server.kill();
  await exited;
}
