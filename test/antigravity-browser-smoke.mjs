import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordAntigravity } from './antigravity-fixture.mjs';

const [destination, playwrightDir, edge, hostStyles, scheme, packageDir = path.resolve(import.meta.dirname, '..')] = process.argv.slice(2);
assert(destination && playwrightDir && edge && hostStyles && ['light', 'dark'].includes(scheme),
  'Usage: node test/antigravity-browser-smoke.mjs <new-output-dir> <playwright-dir> <edge-exe> <host-overview.css> <light|dark> [package-dir]');
const root = fs.realpathSync(packageDir);
const loadPackage = name => import(pathToFileURL(path.join(root, 'src', name)));
const [{ startOverviewServer }, { Store }] = await Promise.all([loadPackage('overview-server.mjs'), loadPackage('store.mjs')]);
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.resolve(destination), historyRoot = path.join(output, 'data');
fs.mkdirSync(output);
process.env.TRAFFICWATCH_CACHE_ROOT = path.join(output, 'cache');
const css = fs.readFileSync(hostStyles, 'utf8');
const rootStyle = css.match(/:root\s*\{([^}]+)\}/)?.[1] || '';
const variables = Object.fromEntries([...rootStyle.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
for (const key of ['--text', '--paper', '--surface', '--green', '--blue']) assert.ok(variables[key], key);

const windows = new Store(path.join(historyRoot, 'windows'));
const clash = new Store(path.join(historyRoot, 'clash'));
const now = Date.now();
try {
  for (const minutesAgo of [135, 75, 15]) {
    recordAntigravity(windows, clash, Math.floor((now - minutesAgo * 60000) / 60000) * 60000);
  }
} finally { windows.close(); clash.close(); }
const ports = await Promise.all(Array.from({ length: 3 }, async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}));
const [listenPort, ...sourcePorts] = ports.map(server => server.address().port);
await Promise.all(ports.map(server => new Promise(resolve => server.close(resolve))));
const app = startOverviewServer({ historyRoot, suiteSettings: {}, listenPort, sourcePorts });
const { chromium } = await import(pathToFileURL(path.resolve(playwrightDir, 'index.mjs')));
const began = performance.now(), pageErrors = [], screenshots = [];
let browser;
try {
  if (!app.server.listening) await once(app.server, 'listening');
  browser = await chromium.launch({ headless: true, executablePath: edge, timeout: 12000 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, locale: 'zh-CN' });
  await context.addInitScript(theme => {
    document.addEventListener('DOMContentLoaded', () => {
      for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);
    }, { once: true });
  }, variables);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const base = `http://127.0.0.1:${listenPort}`;
  const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, expectedVersion);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.selectOption('#range', '24h');
  await page.waitForFunction(() => document.querySelector('#overviewHarnessBreakdown').textContent.includes('Antigravity 54 KB'));
  assert.equal(await page.locator('#overviewHarness').innerText(), '84 KB');
  assert.equal(await page.locator('html').evaluate((root, key) => root.style.getPropertyValue(key), '--paper'), variables['--paper']);
  assert.equal(await page.evaluate(scheme => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, scheme), true);

  const nav = page.locator('.primary-nav [data-view-button=harness]');
  const tab = page.getByRole('tab', { name: 'Antigravity', exact: true });
  await nav.click();
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#harnessTotal').textContent === '30 KB');
  await tab.click();
  await page.waitForFunction(() => document.querySelector('#harnessSelectedName').textContent === 'Antigravity' &&
    document.querySelector('#harnessTotal').textContent === '54 KB' && document.querySelector('#harnessProxyTotal').textContent === '27 KB' &&
    document.querySelector('#harnessChart').width > 10);
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#harnessDirections').innerText(), /↑ 21 KB.*↓ 33 KB/);
  assert.equal(await page.locator('#harnessProcessRows button').count(), 3);
  assert.equal(await page.locator('#harnessProcessRows').getByText('codex.exe', { exact: true }).count(), 0);

  async function capture(name, width, height, keepScroll = false) {
    await page.setViewportSize({ width, height });
    if (!keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, 'page must fit the viewport');
    assert.equal(await page.locator('.primary-nav').evaluate(nav => nav.scrollWidth === nav.clientWidth), true, 'navigation clips');
    const active = await tab.isVisible();
    if (active) {
      const layout = await page.locator('#harnessTabs button').evaluateAll(elements => elements.map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const box = element.getBoundingClientRect(), text = range.getBoundingClientRect();
        return { x: box.x, right: box.right, width: box.width, textWidth: text.width };
      }));
      assert.equal(layout.length, 4);
      for (const box of layout) assert.ok(box.x >= 0 && box.right <= width && box.textWidth < box.width, `${width}px harness tab clips`);
    }
    const file = path.join(output, name + '.png');
    await page.screenshot({ path: file, fullPage: !keepScroll, animations: 'disabled' });
    screenshots.push(file);
  }

  await capture('antigravity-1280', 1280, 900);
  await capture('antigravity-560', 560, 900);
  await capture('antigravity-420', 420, 900);

  // Arrow movement retains focus and updates the selected family's query.
  await tab.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'dsh', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'dsh', exact: true }).press('End');
  await page.waitForFunction(() => document.querySelector('#harnessTotal').textContent === '54 KB');

  const language = page.locator('#harnessProcessRows button').filter({ hasText: 'language_server.exe' });
  await language.click();
  await page.locator('#appConnectionRows').getByText('agent.example.test:443', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#appConnectionRows tr').count(), 1, 'same-name language server excluded from the detail');
  await page.locator('#appDestinations button').filter({ hasText: 'agent.example.test' }).click();
  await page.locator('#appDetailTitle').getByText('language_server.exe → agent.example.test', { exact: true }).waitFor();

  await nav.click();
  const canvas = page.locator('#harnessChart');
  await page.waitForFunction(() => document.querySelector('#harnessChart')._chartModel?.points.some(point => point.values.some(value => value.value > 0)));
  const point = await canvas.evaluate(element => {
    const { points, pad, width } = element._chartModel;
    const point = points.find(value => value.values.some(item => item.value > 0));
    const wrap = element.closest('.chart-wrap');
    wrap.scrollLeft = Math.max(0, point.x - width / 2);
    return { x: point.x - wrap.scrollLeft, y: pad.top + 12, from: point.from, to: point.to };
  });
  const [timeDetail] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/detail' && url.searchParams.get('family') === 'antigravity' &&
        url.searchParams.get('from') === String(point.from) && url.searchParams.get('to') === String(point.to);
    }),
    canvas.click({ position: { x: point.x, y: point.y } }),
  ]);
  assert.equal(timeDetail.status(), 200);
  await page.locator('#appConnectionRows').getByText('agent.example.test:443', { exact: true }).first().waitFor();

  await page.setViewportSize({ width: 560, height: 900 });
  await nav.click();
  await page.getByRole('button', { name: '查看代理连接', exact: true }).click();
  const nodes = page.locator('#ladderConnectionRows').getByText('Example node', { exact: true });
  await nodes.first().waitFor();
  assert.equal(await nodes.count(), 3);
  const rows = await page.locator('#ladderConnectionRows').innerText();
  assert.match(rows, /Clash Verge[\s\S]*language_server\.exe[\s\S]*agent\.example\.test[\s\S]*3 KB[\s\S]*6 KB/);
  assert.doesNotMatch(rows, /msedge|direct\.example\.test/);
  const detailTitleInView = await page.locator('#ladderDetailTitle').evaluate(title => {
    const box = title.getBoundingClientRect(), sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    return box.top >= sidebar.bottom && box.bottom <= innerHeight;
  });
  assert.equal(detailTitleInView, true, 'proxy detail title must remain visible below the navigation');
  const table = page.locator('#ladderDetail .table-scroll');
  const canReachLastColumn = await table.evaluate(wrapper => {
    wrapper.scrollLeft = wrapper.scrollWidth;
    const right = wrapper.querySelector('th:last-child').getBoundingClientRect().right;
    const reachable = right <= wrapper.getBoundingClientRect().right;
    wrapper.scrollLeft = 0;
    return reachable;
  });
  assert.equal(canReachLastColumn, true);
  await capture('antigravity-proxy-560', 560, 900, true);
  await page.locator('.settings-link[data-view-button=settings]').click();
  assert.equal(await page.locator('#aliasFamily option[value="antigravity"]').innerText(), 'Antigravity');
  await page.getByRole('heading', { name: 'Antigravity', exact: true }).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', version: expectedVersion, browser: browser.version(), themeVariables: Object.keys(variables).length,
    scheme, assertions: 'overview, local/proxy totals, tabs and keyboard, process/domain/time and proxy details, settings and responsive layout',
    elapsedMs: Math.round(performance.now() - began), screenshots }, null, 2));
} finally {
  await browser?.close();
  const exited = once(app.server, 'close');
  await app.close();
  await exited;
}
