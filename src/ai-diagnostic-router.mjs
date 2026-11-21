import { readRelayHealth } from './relay-health.mjs';

const service = 'http://127.0.0.1:43132';

export async function diagnosticRoute({ req, url, json, maintenance, readJson, dataRoot }) {
  if (!/^\/api\/diagnostics(?:\/|$)/.test(url.pathname)) return false;
  const get = req.method === 'GET', post = req.method === 'POST';
  try {
    if (get && url.pathname === '/api/diagnostics/status') {
      let collector = null, collectorError = null;
      try {
        const response = await fetch(service + '/api/health', { signal: AbortSignal.timeout(1200) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        collector = await response.json();
      } catch (error) { collectorError = error.cause?.code || error.message; }
      json(200, { collector, collectorError, bypass: readRelayHealth(dataRoot), liveAvailable: true });
    } else if (post && url.pathname === '/api/diagnostics/mark') {
      await readJson(req);
      const response = await fetch(service + '/api/mark', {
        method: 'POST', headers: { 'x-codex-flow': '1', 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(4000),
      });
      json(response.status, await response.json());
    } else if (get && ['/api/diagnostics', '/api/diagnostics/event'].includes(url.pathname)) {
      const options = {};
      for (const key of ['from', 'to', 'kind', 'provider', 'harness', 'gateway', 'category', 'limit']) {
        if (url.searchParams.has(key)) options[key] = url.searchParams.get(key);
      }
      if (url.searchParams.has('cursor')) {
        try { options.cursor = JSON.parse(url.searchParams.get('cursor')); }
        catch { throw new Error('invalid_diagnostic_cursor'); }
      }
      if (url.pathname.endsWith('/event')) {
        options.eventId = url.searchParams.get('id');
        if (!options.eventId) throw new Error('invalid_diagnostic_event');
      }
      json(200, await maintenance.request('diagnostic-query', options));
    } else if (get && url.pathname === '/api/diagnostics/attachment') {
      json(200, await maintenance.request('diagnostic-attachment', { id: url.searchParams.get('id') }));
    } else if (post && url.pathname === '/api/diagnostics/attachment/delete') {
      const { id } = await readJson(req);
      json(200, await maintenance.request('diagnostic-delete-attachment', { id }));
    } else json(404, { error: 'not_found' });
  } catch (error) {
    if (error.message === 'diagnostic_attachment_not_found') json(404, { error: error.message });
    else if (error.message.startsWith('invalid_')) json(400, { error: error.message });
    else {
      console.error('TrafficWatch diagnostic request:', error.code || error.cause?.code || error.message);
      json(503, { error: error.message.startsWith('history_') ? error.message : 'diagnostics_unavailable' });
    }
  }
  return true;
}
