export const finiteBytes = (x) =>
  Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.floor(Number(x)) : 0;
export function counterDelta(current, previous) {
  current = finiteBytes(current);
  previous = finiteBytes(previous);
  return current >= previous ? current - previous : current;
}

export class Accounting {
  constructor(options = {}) {
    this.preserveRouteMetadata = options.preserveRouteMetadata === true;
    this.previous = new Map();
    this.proxyAccounts = new Map();
    this.lastAt = 0;
    this.global = null;
  }
  resetBaseline() {
    this.previous.clear();
    this.proxyAccounts.clear();
    this.lastAt = 0;
    this.global = null;
  }
  consume(snapshot, now, classify, activeSessions = []) {
    if (snapshot.proxySnapshots) return this.consumeProxies(snapshot.proxySnapshots, now, classify, activeSessions);
    const baseline = !this.lastAt && !snapshot.incremental;
    const rows = [];
    let codexUp = 0,
      codexDown = 0,
      unknownUp = 0,
      unknownDown = 0;
    for (const c of snapshot.connections) {
      if (
        !c ||
        !c.id ||
        !Number.isFinite(c.upload) ||
        c.upload < 0 ||
        !Number.isFinite(c.download) ||
        c.download < 0
      )
        continue;
      // Native IDs already contain helper generation, process birth and endpoints.
      // Its start timestamp belongs to each drained ETW window, not the connection.
      const proxyClient=this.preserveRouteMetadata&&!c.metadata?.native&&['verge','flclash','mihomo'].includes(snapshot.proxyClient)?snapshot.proxyClient:'';
      const key = snapshot.incremental && c.metadata?.native ? c.id : `${c.id}:${c.start || ''}${proxyClient?`:client:${proxyClient}`:''}`;
      const airport = proxyClient && c.airport && /^auto-[a-f0-9]{24}$/.test(c.airport.id) ? c.airport : null;
      const old = this.previous.get(key);
      const rawUp = finiteBytes(c.upload),
        rawDown = finiteBytes(c.download);
      // Existing connections on first attach are baselined, not backdated.
      const fresh = !baseline && !old && Date.parse(c.start) >= this.lastAt;
      const up = snapshot.incremental ? rawUp : old ? counterDelta(rawUp, old.up) : fresh ? rawUp : 0;
      const down = snapshot.incremental ? rawDown : old ? counterDelta(rawDown, old.down) : fresh ? rawDown : 0;
      const identified = classify(c.metadata || {}, now);
      // A connection identity is stable for its lifetime. Once established, keep
      // it even if its local port is reused before the controller drops the row.
      let attribution =
        old?.attribution && old.attribution.scope !== 'unknown'
          ? old.attribution
          : identified ||
            old?.attribution || { scope: 'unknown', family: 'unknown', evidence: 'none', process: '', pid: null };
      if (!attribution.family) {
        attribution = {
          ...attribution,
          family: attribution.scope === 'codex' ? 'codex' : attribution.scope === 'unknown' ? 'unknown' : 'other',
        };
      }
      if (identified && attribution.process === identified.process &&
          (!attribution.pid || !identified.pid || attribution.pid === identified.pid) &&
          !(attribution.familyRoot?.startsWith('script:') && identified.family === 'other')) {
        attribution = { ...attribution, family: identified.family || attribution.family,
          familyRoot: identified.familyRoot || '' };
      }
      this.previous.set(key, { up: rawUp, down: rawDown, at: now, attribution });
      if (attribution.scope === 'codex') {
        codexUp += up;
        codexDown += down;
      }
      if (attribution.scope === 'unknown') {
        unknownUp += up;
        unknownDown += down;
      }
      rows.push({
        key: airport ? `${key}:${airport.id}` : key,
        host: String(c.metadata?.host || c.metadata?.destinationIP || '未知地址').slice(0, 255),
        network: c.metadata?.network || '',
        start: c.start || '',
        ...attribution,
        up,
        down,
        rawUp,
        rawDown,
        rule: this.preserveRouteMetadata
          ? JSON.stringify({ source: c.metadata?.native ? 'windows' : 'mihomo',
              client: proxyClient,
              ...(airport ? {airport} : {}),
              type: String(c.rule || ''), payload: c.rulePayload || '', chains: c.chains || [],
              localIP: c.metadata?.sourceIP || '', localPort: c.metadata?.sourcePort || 0,
              destinationIP: c.metadata?.destinationIP || '', destinationPort: c.metadata?.destinationPort || 0,
              observedPID: c.metadata?.native ? c.metadata.processId : null })
          : String(c.rule || '').slice(0, 80),
      });
    }
    const allUp = snapshot.incremental ? finiteBytes(snapshot.uploadTotal) : this.global ? counterDelta(snapshot.uploadTotal, this.global.up) : 0;
    const allDown = snapshot.incremental ? finiteBytes(snapshot.downloadTotal) : this.global ? counterDelta(snapshot.downloadTotal, this.global.down) : 0;
    this.global = { up: snapshot.uploadTotal, down: snapshot.downloadTotal };
    const duration = snapshot.incremental ? Math.max(1, snapshot.duration || 1000) : this.lastAt ? Math.max(1, now - this.lastAt) : 0;
    this.lastAt = now;
    // Keep short-lived disappeared connections briefly for reappearance, bounded in memory.
    for (const [key, value] of this.previous)
      if (now - value.at > 120000) this.previous.delete(key);
    return {
      at: now,
      duration,
      baseline,
      codexUp,
      codexDown,
      unknownUp,
      unknownDown,
      allUp,
      allDown,
      rows,
      activeSessions,
    };
  }
  consumeProxies(snapshots, now, classify, activeSessions) {
    const combined = {
      at: now, duration: this.lastAt ? Math.max(1, now - this.lastAt) : 0, baseline: !this.lastAt,
      allUp: 0, allDown: 0, codexUp: 0, codexDown: 0, unknownUp: 0, unknownDown: 0, rows: [], activeSessions,
    };
    const next = new Map();
    for (const snapshot of snapshots) {
      const {sourceKey} = snapshot;
      const account = (!snapshot.reset && this.proxyAccounts.get(sourceKey)) || new Accounting({preserveRouteMetadata:this.preserveRouteMetadata});
      const sample = account.consume(snapshot, now, classify, activeSessions);
      for (const quantity of ['allUp','allDown','codexUp','codexDown','unknownUp','unknownDown']) combined[quantity] += sample[quantity];
      for (const row of sample.rows) combined.rows.push(row);
      next.set(sourceKey, account);
    }
    this.lastAt = now;
    this.proxyAccounts = next;
    return combined;
  }
}
