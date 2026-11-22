# Changelog

## 0.10.20

- Add Antigravity to Harness with separate Windows and Clash proxy totals, upload/download bars, and drill-down by time, process, destination or proxy connection.
- Recognize the Antigravity executable, its bundled language server and verified descendants. Group existing records with a matching process name as they are read, without migrating the database.
- Support Antigravity process aliases, keyboard navigation between Harness tabs, and compact navigation on narrow screens.

## 0.10.19

- Use the SQLite WAL health response when opening TrafficWatch from the desktop or tray. Reuse the running viewer and report startup exits, timeouts and unexpected listeners separately.
- Recognize verified plaintext history before checking for retained encrypted backups. Subsequent upgrades keep the active history in place and skip the old password and migration.

## 0.10.18

- Keep the collector's HTTP listener responsive while SQLite opens, prepares indexes or writes traffic. Wait for the collector to report readiness before accepting an upgrade, and report startup stages and log tails when a check fails.
- Remove the first sample's full SQLite optimization, defer retention cleanup, and seek directly to the first and last sample when looking up history bounds.
- Inspect checkpoints from rolled back upgrades. Reuse a verified lane when its source files still match, and apply only new packets when the earlier queue prefix and its replay state can be verified. Preserve the source and rollback files.

## 0.10.17

- Accept the legacy Clash controller gap reason. Report damaged queue packets or operations and continue applying valid capture records in order.
- Reuse verified history lanes after an interrupted Windows upgrade. If an unchanged verified traffic database had no pending packets at its checkpoint, replay its current queue without redoing the encrypted conversion.

## 0.10.16

- Write traffic and diagnostic history directly to local SQLite WAL and open a single dashboard without a password or visitor card.
- Upgrade existing Windows installs with an offline, checked conversion of old encrypted databases, archives, captures, and diagnostic attachments. Retain the original files and the previous program for rollback.
- Combine the same airport across Clash clients and retain client, node, application, and destination drill-down.

## 0.10.15 — 2026-11-21

- Bring capture controls, traffic trends and airport rankings into the main overview. Open it from the same desktop shortcut and from a smaller tray menu.
- Combine automatically identified airport labels across clients. Drill down from an airport to its clients, exit nodes and connection details. Remove the manual assignment API and retire stored manual groups during database migration.
- Retire the old dashboard and embedded desktop windows. The Windows package opens the viewer in the default browser and drops the WebView2 dependency.

## 0.10.14 — 2026-11-19

- Show which Clash client owns the Windows TUN route, including while it is idle. Record each reachable controller's byte deltas independently during switches and mark gaps when an active controller cannot be read.
- Automatically label known nodes from the current Clash Verge or FlClash subscription and live provider membership. Keep manual groups for unclassified nodes and earlier records.
- Speed up encrypted history catch-up with larger batches for large queues, fewer repeated database operations and shorter retries for transient database locks. Keep the encrypted queue and its replay protection.

## 0.10.13 — 2026-11-17

- Separate proxy usage by client and exact client/node membership, so identically named nodes in Clash Verge and FlClash can belong to different airport groups. Keep rows without recorded client identity explicitly under legacy / unrecognized history.
- Store airport group labels in the encrypted history settings and add owner-only management for creating, editing and removing groups. Show client and airport upload/download totals together, with filters that stay local to the ladder view.
- Load the client/node inventory only when airport management opens, separate it from normal ladder filtering, and provide retry and incremental node-list controls.
- Report the true statistics queue position and the active blocker stage. Cancel obsolete background refreshes when a foreground query needs the reader, while coalescing same-query work.
- Mark filtered airport summaries as complete so client and airport filters render their results instead of remaining in a loading state.

## 0.10.12 — 2026-11-17

- Add a lightweight Harness query for exact family totals, process attribution and time charts, without reading destinations, node lists or connection pages. Reuse the encrypted process index for Windows queries. Display existing overview totals immediately, render each source as it completes, coalesce repeated family clicks, and discard abandoned responses.
- Treat Mihomo's idle `connections: null` as an empty connection list, preserving global counters. Discover FlClash controllers and live credential changes from its settings, prefer the active TUN over an idle installed client, and rediscover the traffic source every ten seconds. Detect an active FlClash with its control interface closed instead of silently collecting an idle Verge core.
- Apply relay exclusions to the selected client's own runtime with independent ownership records; preserve live settings and never reload Verge YAML into FlClash. Revalidate after a client change, check every reachable discovered core for relay connections, and retain the existing Windows physical DNS and exact routes.
- Show healthy diagnosis capture and verified paths in green, failed bypass validation in red, and incomplete or stale checks in amber. Report safe failure codes, affected checks, the failed stage and previous successful verification separately. Protect all live details with the existing owner-session policy and clear them from visitor views.

## 0.10.11 — 2026-11-17

- Add a compact, persistent application lookup index inside the history database. Exact range-first attribution avoids fetching full connection/rule payloads for each application identity; encrypted histories keep the index encrypted. Existing histories build it once during opening and reuse it on later unlocks.
- Show the current statistics stage, elapsed time, and measured processed/total attribution records. Percentages explicitly refer to the current stage; SQL phases with no measured denominator use an indeterminate indicator. Query progress is restricted to the unlocked owner session.
- Stream source attribution into application totals while preserving scope boundaries, aliases, family evidence and exact connection counts. Small idle capture imports and repeated refresh clicks no longer interrupt the current overview query; completing a real backlog queues one subsequent refresh.
- Stop the progress display on failure or lock, retain previously loaded totals on query errors, and preserve quick totals while application attribution is running.

## 0.10.10 — 2026-11-17

- Add a protected relay-management page inside the traffic center. Add, edit, enable, disable and remove relay hostnames; save a restore point before each list change; restore a selected prior list or disable all managed bypass entries.
- Validate public DNS hostnames and resolved IPv4 addresses, accept pasted HTTP(S) API URLs by their hostname, reconcile the list through the existing physical-DNS and exact-route verifier, and trigger an immediate background recheck after edits. Unmanaged IPv6 addresses prevent a verified status.
- Remove stale manager-owned IPv4 routes and proxy exceptions when a relay is removed. Track the managed Clash rule prefix while retaining original rules underneath it, so removal and rollback preserve user rules. Keep existing relay entries on first migration and back them up before the first edit.
- Require the unlocked owner session for every relay-list operation; AI visitor cards cannot view or change routing settings.

## 0.10.9 — 2026-11-17

- Batch adjacent collector operations into signed encrypted queue envelopes, flushing at most every two seconds or 64 operations. Graceful shutdown still flushes pending data; a forced termination or power loss can lose samples still in the short in-memory window.
- Adapt vault import work slices to backlog size while keeping sources round-robin. Report rolling per-source import rate, incoming capture rate, net drain rate, ETA and stalled progress; explain that overview totals remain partial during catch-up.
- Verify batching, flush deadlines, exact count recovery, net ETA, incoming traffic accounting and non-progress notices using synthetic fixtures.
- In a local synthetic run of 600 samples with 12 connection rows each, two-second batching halved envelopes from 600 to 300 and reduced combined encrypted capture/import time from 3,678 ms to 1,871 ms. Upload/download totals and all sample counts matched; this fixture result is host-specific.

## 0.10.8 — 2026-11-16

- Resolve Magpie relay targets from its selected Responses, Chat or Anthropic endpoint, along with generic and nested endpoint settings. Match stable provider ids, names and former names, preserve per-attempt fallback targets, and leave conflicting labels or unmanaged endpoints unmapped. Never use a website or credential field as a request destination.
- Classify Windows TCP Reconnect as a connection retry, preserve surrounding evidence for known AI relay traffic and keep retries separate from failed HTTP request counts. Correct the display/API category of previously saved Reconnect evidence without inventing old triggers.
- Show relay hostnames in request details and group connection retries by socket, process, destination and time. Open incident details with key evidence, retain the complete timeline and bounded pagination, and highlight connection retries.

## 0.10.7 — 2026-11-16

- Import locked capture queues using bounded grouped history commits and grouped acknowledgements, with round-robin scheduling for Windows, Clash and diagnostics. Keep per-packet savepoints, signed validation and replay ledgers so a rejected packet cannot leave partial records and a crash after commit cannot double byte counts.
- Show remaining capture batches, imported batches, throughput and a sanitized failure reason. Hide routine tiny live queues, refresh overviews more often during catch-up and refresh on completion.
- Invalidate completed-hour program summaries when late capture is imported. Use exact source queries during catch-up so partially built caches cannot leave application or Harness totals incomplete.

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
