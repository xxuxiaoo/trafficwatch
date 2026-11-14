# Changelog

## 0.7.2 — 2026-11-14

- Fix live-status text being written inside the status indicator when the page still uses the initial markup. Keep a dedicated text span and normalize older markup once without reintroducing repeated node replacement.

## 0.7.1 — 2026-11-14

- Reuse number formatters and status text nodes; update live status separately from history metadata, without repeating identical DOM writes.
- Refresh an already loaded range once per cycle and keep unchanged cached results without rebuilding charts/tables. Initial cold loads still show quick totals first.
- Release hidden canvas backing stores and chart handlers, restore the current view immediately on return, and reuse unchanged canvas dimensions.
- Coalesce browser snapshot persistence into idle time instead of writing synchronously in the response/render task.

## 0.7.0 — 2026-11-14

- Unified overview for Windows application, Clash/Mihomo and harness histories, with time filters, peaks and connection drill-down.
- Independent boot collectors, unlimited retention, suite controller, responsive tray polling and preserved legacy interfaces.
- Bounded query queues, shared queries, cancellation, worker timeout/crash recovery and stale-response protection.
- Disposable historical program summaries, fast initial totals, bounded caches, pagination and visible-area chart rendering.
- Explicit coverage/gaps and separate upload/download bar colors; consistent route filtering.
- Public source distribution with upstream attribution, local-data exclusions, fresh-install tooling and pinned Windows build dependencies.
- Source fork prevents the inherited single-process updater from installing packages over the two-collector suite.

Upstream history through v0.5.1 is preserved in [docs/upstream/CHANGELOG.md](docs/upstream/CHANGELOG.md).
