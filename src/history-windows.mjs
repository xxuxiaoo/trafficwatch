export function intersectWindows(windows, from, to) {
  return windows.map(window => ({ from: Math.max(window.from, from), to: Math.min(window.to, to) }))
    .filter(window => window.to > window.from);
}

export function containsTime(windows, timestamp) {
  return windows.some(window => timestamp >= window.from && timestamp < window.to);
}

export function containsInterval(windows, from, to) {
  return windows.some(window => from >= window.from && to <= window.to && to > from);
}
