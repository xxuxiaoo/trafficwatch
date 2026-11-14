export function routeKind(rule) {
  let route;
  try { route = typeof rule === 'string' ? JSON.parse(rule) : rule; } catch { return 'unknown'; }
  if (route?.source !== 'mihomo' || !Array.isArray(route.chains) || typeof route.chains[0] !== 'string') return 'unknown';
  const leaf = route.chains[0].trim();
  if (!leaf) return 'unknown';
  if (leaf.toUpperCase() === 'DIRECT') return 'direct';
  if (['REJECT','REJECT-DROP','PASS','COMPATIBLE'].includes(leaf.toUpperCase())) return 'unknown';
  return 'proxy';
}

export function trafficRates(sample, live) {
  if (!sample || !live || !(sample.duration > 0)) return null;
  const seconds = sample.duration / 1000;
  const rates = { proxy: { up: 0, down: 0 }, direct: { up: 0, down: 0 }, unknown: { up: 0, down: 0 } };
  for (const row of sample.rows || []) {
    const rate = rates[routeKind(row.rule)];
    rate.up += Math.max(0, row.up || 0) / seconds;
    rate.down += Math.max(0, row.down || 0) / seconds;
  }
  return rates;
}
