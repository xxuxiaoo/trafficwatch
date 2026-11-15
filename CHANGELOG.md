# Changelog

## 0.10.6 — 2026-11-15

- Preserve a temporary owner session across closed/reopened tabs and browser restarts within the same browser profile. Validate the session with an owner-only API before restoring the interface, migrate existing tab-only sessions and retain the original server expiry without storing a password or history key.
- Clear shared browser credentials and visible private pages on lock. Continue to require a fresh password after Windows lock, logout, service restart or session expiry; AI visitor credentials cannot restore the owner interface. Stop in-flight refreshes when clearing a locked page to avoid writing into its removed content.
- Download missing diagnostic build dependencies from official NuGet URLs with pinned hashes, retain native-addon license notices, correct the YAML ISC attribution and refresh public build/architecture/validation documentation.

## 0.10.5 — 2026-11-15

- Open clicked chart intervals immediately, with their selected times and a visible loading state. Clear old details while loading, provide explicit retry actions and resume interrupted selections after page navigation or returning to the foreground. Cancel obsolete route selections and avoid competing hidden-page requests.
- Give interactive connection details an independent query worker so a whole-period overview cannot hold them in its queue. Include detail progress and failure counters in local health, and prevent obsolete queries from repopulating cleared caches.
- Aggregate only the selected connection minutes before resolving metadata. Reuse compact per-range route/program summaries, build route charts and top peaks from one minute scan, and decode endpoint rule metadata only for the requested connection page. Preserve exact totals, archived history, anonymous attribution and visitor date limits.

## 0.10.4 — 2026-11-15

- Filter incidents by their actual trigger evidence, including slow successful attempts. Combine provider, Harness, gateway and cause on the same trigger; enforce authorized dates on derived encrypted indexes and filter choices. Build legacy indexes in bounded batches and indicate incomplete results while catching up.
- Populate filter choices from all records in the selected period, preserve choices on empty results, use categories appropriate to each record type, and add reset and applied-condition summaries. Keep draft conditions separate from polling, supersede stale requests on apply, and restrict incident details to the applied dates.
- Unify sidebar links and buttons, spacing, icons and current-page highlights across overview, diagnostics and storage. Align the diagnosis filters, collapse collection self-check details, distinguish matched records from period gateway attempts, and improve desktop and mobile layout.

## 0.10.3 — 2026-11-15

- Add read-only CC Switch proxy request, Codex diagnostic SQLite/text, Claude Code API error/debug, and DSH JSONL/Zstd retry and terminal error adapters. Keep imported transcripts separate from real gateway requests; extract allowlisted metadata without retaining prompts, responses, credentials or raw log text.
- Check source readability, schema support, bounded discovery, incremental backlog, parse/time failures, TraceEvent heartbeat/drops and actual PktMon ownership every minute. Save checks through the signed encrypted queue and expose source status and practical follow-up hints in the diagnostics view.
- Check request phase availability, retry-chain gaps within fully authorized time windows, and same-target TCP evidence. Distinguish missing data, capabilities absent from the source, historical backfill and system collector outages. Enforce visitor dates on collection snapshots and skip request aggregation for the lightweight latest-check query.

## 0.10.2 — 2026-11-15

- Keep repeated attempts at the same Magpie provider distinct and stable across updates. Replay available current/previous-day routing logs through a new cursor generation; encrypted imports replace collided legacy entries without double counting or allowing a delayed legacy queue to recreate them.
- Parse Go local log dates and explicit ISO offsets. Never label an unreadable occurrence time as now. Replay available application logs without triggering new incidents; flag unrecoverable legacy times and exclude them from exact-date visitor evidence.
- Capture slow response, connection, upload and first-content evidence even when a request succeeds. Keep slow capture reasons separate from network failures, and mark old incidents and incomplete legacy request coverage in the viewer/API.
- Recognize HTTP 499 as cancellation in request summaries, match provider labels without case sensitivity, and refresh endpoint mappings when local provider settings change.

## 0.10.1 — 2026-11-15

- Show existing encrypted history as soon as its databases open. Import locked capture queues in bounded, rotating background batches so a large Windows backlog cannot prevent Clash, diagnostics or owner requests from running.
- Keep live collector status available while history opens. Show background catch-up separately from the first encryption migration, and refresh views when preparation completes.
- Preserve the owner session across overview and diagnostics navigation. Opening and maintenance errors return service-unavailable responses rather than expired-session responses; frontend authentication handling also distinguishes these conditions.

## 0.10.0 — 2026-11-15

- Add encrypted AI connection diagnostics using Magpie request attempts, Microsoft TraceEvent and filtered Windows PktMon metadata snapshots, with independent AI visitor scope and bounded incident previews.
- Add managed relay routes through the physical IPv4 interface, DNS refresh, Clash exclusions, verification and rollback controls.

## 0.9.1 — 2026-11-14

- Return to the original overview, dated view, storage or legacy page after unlocking. Validate local return destinations and preserve explicit security management and recovery-code setup flows.
- Distinguish opening encrypted databases and importing locked capture queues from the first encryption migration; completed histories no longer appear to be migrating again on each unlock.
- Keep recent queries on indexed source tables when no archive blocks intersect the range. Skip expensive cold summary construction for large connection dictionaries or bucket ranges, retaining exact attribution without exceeding the cache budget.
- Reuse saved Harness rules in the read cache, expose query stages and failure counts in local diagnostics, show recoverable attribution errors, and let a manual refresh cancel stalled work before retrying.

## 0.9.0 — 2026-11-14

- Preserve full history indefinitely while moving samples and minute connection buckets older than 90 days into verified, lossless monthly compression blocks inside the encrypted history database. Shared connection/rule metadata, coverage and daily ledgers remain intact.
- Transparently query old dates through overview, detail, legacy and AI visitor-card APIs; keep disjoint authorized windows exact, reject archived sample replays and support scoped deletion across online and archived rows.
- Add an owner-only storage page with history/cache/queue/backup accounting, reusable pages, monthly archives, growth and disk warnings, policy settings and background maintenance progress.
- Bound disposable summary storage to a 256 MiB combined budget, fall back to exact queries when full and defer rebuilding for an hour. Keep fixed verified recovery backups and remove redundant abandoned backup staging files.
- Reclaim database space with a streamed encrypted replacement, per-table value verification and crash recovery; pause history readers during replacement while collectors continue sealing packets.
- Batch and throttle archive work, reuse replay queries, bound decoded blocks, skip irrelevant months and avoid repeated hourly scans of compressed history.

## 0.8.1 — 2026-11-14

- Submit plaintext cleanup as a background job with phase updates and duplicate-request coalescing; refreshing or closing the initiating page does not cancel verification.
- Verify both encrypted backups before removing either plaintext history, reuse verified copies on retry, check WAL checkpoint completion, and bound verification cache memory to 64 MiB.
- Show readable progress and interrupted/retry states instead of a browser request timing out after one minute.

## 0.8.0 — 2026-11-14

- Add opt-in password-encrypted history with offline recovery, encrypted capture while locked, resumable migration and verified encrypted backups before plaintext cleanup.
- Add configurable AI visitor cards: source/date scope, separate operations, 30/60/120 minute or custom validity, optional access after screen lock, revocation and owner-unlock linkage.
- Keep archived dashboards behind the same authorization boundary; remove persisted plaintext browser snapshots and protect history APIs on both collectors.
- Add a local DPAPI-protected AI command adapter and a desktop privacy setup entry. Password setup must be completed locally by the owner before encryption is active.
- Fix privacy setup silently failing to open the browser: prepare the owner ticket over a private pipe, launch the registered browser from the desktop UI thread, and display startup failures.

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
