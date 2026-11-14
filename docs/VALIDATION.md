# TrafficWatch validation

The active test suite combines the upstream regression tests with synthetic history, process-family and performance/recovery tests. The publication checkout completed 155 cases: 153 passed, 2 administrator-only ETW integration tests skipped, no failures. JavaScript and PowerShell syntax checks passed. The native helper self-test and the Windows tray/controller package build also passed using hash-verified offline dependencies. Run `npm run check`, `npm test`, and `npm run audit:publication`. CI runs source tests on Windows and Linux; Linux validates query/accounting behavior and does not provide Windows native capture.

The 0.7.0 unified viewer was locally exercised with actual collected history for today, 24 hours, 7 days, 30 days, a selected date and all history. Retained history was shorter than a complete 7/30-day window. A 160-cycle refresh/scroll test used synthetic responses to check browser resource growth; page nodes and canvas pixels stayed constant and collected JS heap approached a plateau. A separate six-minute actual-data run completed 36 refreshes without content disappearing or an accumulating query queue. Neither is a completed multi-day endurance test.

Browser checks also covered failed/unreadable history responses, stale responses after fast range changes, hidden-page pause/resume, application/connection drill-down, route filtering, harness tabs, unsaved settings, narrow screens, time-axis interaction, and separate upload/download colors. Per-machine measured timings are not a universal performance guarantee. First-time complex attribution can still take several seconds; the initial totals and chart render separately.

The public installer supports fresh installations. It is reviewed and syntax-checked, but has not been used to reinstall over the author's running setup. The package build, native helper and desktop compilation are checked separately. Upgrade/migration and multi-user isolation are not established by those checks.

## 0.7.1 continuous-view performance checks

The same isolated Microsoft Edge setup profiled 0.7.0 and 0.7.1 against the same local service with actual collected records. A 130-second natural refresh observation produced these measurements:

| Measurement | 0.7.0 | 0.7.1 |
| --- | ---: | ---: |
| DOM mutation records | 929 | 217 |
| Overview rebuilds | 6 | 2 |
| Header renders | 43 | 6 |
| Main-thread task time | 125.0 ms | 77.9 ms |
| Layout time | 15.1 ms | 6.2 ms |

In a separate repeated-status phase, 120 identical header updates triggered 120 layouts before the change and none after it. Twenty application-view renders took 61.4 ms before and 16.5 ms after; twenty proxy-view renders took 64.9 ms before and 21.1 ms after. These timings describe the measured JavaScript render functions on this machine, not whole-browser responsiveness or a guarantee for other hardware. The isolated browser did not reproduce the user's intermittent whole-browser slowdown.

Focused checks confirmed that an unchanged cached result retains its chart model and list nodes, a complete range uses one history request per refresh, and unchanged status updates make no DOM writes. Background/foreground checks covered the overview, application detail, proxy detail and harness views: canvas backing stores shrink to 1×1 and handlers detach in the background; charts and keyboard interactions recover on return. Repeated same-size drawing retains the correct canvas transform. Existing range/recovery checks and the 160-cycle refresh/scroll test also passed on 0.7.1. The source suite again completed 155 cases with 153 passing and two administrator-only ETW cases skipped; the Windows package built with verified offline dependencies.

A separate 15-minute natural-refresh run used actual history without forced garbage collection or artificial rapid refreshes. Thirty samples recorded a JS heap of 1.60–3.29 MiB, 464–465 live page elements, zero observed long tasks above 50 ms, no page errors and no queued history requests. The browser naturally reclaimed old nodes and heap during the run; background pause, canvas release and return also passed. This is a short controlled observation, not a multi-day endurance result or a measurement of the user's original browser session. After a two-file viewer hot update, the installed 0.7.1 passed actual-data overview/drill-down, proxy, harness, legacy-link and narrow-screen checks. Both collector processes remained running through that update; this does not establish a general suite upgrade or fresh-install validation.

Original upstream validation notes follow for provenance; their claims apply to the upstream baseline.

# Validation records

Latest validation recorded on 2026-10-25. These results describe the tested workload and host, not an accuracy guarantee for every capture source or Windows installation. Older entries retain their original scope.

## v0.5.0 desktop and updater verification

- Local regression tests passed (115 tests: 113 passed and two administrator-only native tests explicitly skipped), followed by the additional same-version update-retry regression and API checks. All JavaScript syntax checks passed.
- The packaged Windows lifecycle smoke passed: own collector startup/stop/restart/exit, single instance, lock cleanup and isolation from foreign services. Real WebView2 checks passed, including the mini-window language bridge, startup preference, CSV export, navigation isolation and close/reopen behavior.
- An isolated portable upgrade fixture rejected ZIP traversal before stopping the current instance, preserved SQLite/configuration/budget settings through a successful upgrade, then restored and restarted the previous version after an intentionally broken new collector failed to start. No real user database was used in these fixtures.
- English and Chinese calendar/report UI checks passed at 360, 390, 768 and 1600 pixels; offline HTML report export retained coverage notes and escaped stored text. No completed long-run capture or billing-accuracy validation is claimed.

## v0.5.0 calendar/report read models

- Desktop smoke fixtures explicitly set `NETWATCH_TEST_SILENT=1` so intentional startup/rollback failures do not display tray balloons on the user's desktop. This switch only suppresses test notifications; production notifications keep their existing defaults and failure logging remains active.
- Seven focused calendar/report tests passed against temporary synthetic databases. They cover leap months, observed zero versus unknown/future dates, fixed budget zones, UTC/local date boundaries, DST 23/25-hour days, same-local-time comparisons and unavailable pruned partial-day detail.
- Report tests verify current-period clipping before future samples, preserved daily totals after detail cleanup, retained process/hour evidence, open/closed gap clipping, explicit coverage limits, invalid inputs and unchanged schema-4 integrity. Existing storage regressions also passed.
- These are read-model tests, not a full desktop, updater, live-capture or long-running validation. Final release-level desktop/update/CI checks are recorded separately when completed. No billing-accuracy or complete-capture claim is made.

## v0.3.2 editable retention and six-hour range

- Local Windows syntax checks passed. Of 90 automated tests, 88 passed and the two administrator-only native integration tests were explicitly skipped on the unelevated host.
- Retention regressions verify valid boundaries, rejection of fractional/out-of-range values before any settings changes, persistence through a new database connection, cleanup on the next successful poll and no restoration of deleted history after increasing the period. Diagnostics report the effective saved retention.
- Range validation checks the six-hour query boundary. The shared range applies to both the dashboard and CSV export.
- An isolated real WebView2 GUI saved a custom retention value, reopened the setting, rejected zero days, selected Last 6 hours and verified English/Chinese labels. Existing CSV, startup-state, window and navigation checks also passed, along with the bundled portable lifecycle smoke.
- These checks used synthetic test data. No retention change was made to the user's real data as part of testing, and no long-run validation was resumed.

## v0.3.1 native capture and source switching

- [CI run 39906895995](https://github.com/GloryPkqa/codex-netwatch/actions/runs/39906895995) tested commit `7cec8eafb4910e1ac97c8fcb41170551ebd21e69`. Windows passed all 89 tests with no failures or skips; Linux regression and packaged Windows lifecycle jobs also passed.
- Elevated Windows integration tests captured known direct TCP upload/download and a UDP exchange from a separate Codex-named process. The TCP test also verified that stopping the helper removed its private ETW session. These are controlled loopback transfers, not a real-world internet billing comparison.
- Parser tests cover TCP/UDP IPv4/IPv6 records, payload process IDs and excluding retransmit/copy notifications. Source-switch regression checks verify that the first native cutover interval is drained after another active source, preventing overlapping byte windows.
- The unelevated local host did not run live native capture. Native integration tests explicitly skip without elevation unless CI requires them; a skip is not reported as a successful native capture test. Automatic mode locally remained connected through Mihomo while native authorization was pending.
- Release assets were checked against their local SHA-256 digests. After the local portable upgrade, every previously recorded sample and the upload/download aggregates through the backup's last timestamp were preserved, and collection resumed.
- No 24/72-hour validation was resumed or completed. See [native capture scope and permissions](NATIVE_CAPTURE.md) for loopback counting, IP destinations, per-run authorization and measurement gaps.

## v0.2.6 connection guidance and repository presentation

- All 82 automated tests and JavaScript syntax checks passed locally. Controller fixtures cover HTTP 401/403, wrong endpoint responses, malformed JSON, response validation and recovery without exposing raw response bodies.
- Real WebView2 checks cover opening/collapsing Connection help, English/Chinese guidance, narrow layout, startup preferences, CSV download and window lifecycle. Static button checks ignore HTML formatting whitespace.
- The bundled portable runtime passed collector ownership, startup/stop/restart/exit, lock cleanup and foreign-service isolation checks. Packaging uses .NET ZIP creation to avoid the interactive archive progress path; test cleanup tolerates short-lived Windows file handles.
- The README overview now uses a maintainer-shared actual usage screenshot, labelled with its v0.2.5 capture version and proxy-wide scope. The investigation screenshot remains synthetic.
- No 24-hour validation was resumed; no completed 24/72-hour validation is claimed.

## v0.2.5 English-first defaults and documentation

- All 80 automated tests and syntax checks passed locally. Language tests verify English defaults with absent, invalid or inaccessible preferences, preserve explicit Chinese/English choices, and retain opt-in system detection.
- A fresh WebView2 profile defaulted to English on the test host. The GUI smoke also verified switching to Chinese in the existing menu, narrow-window layout, startup-state recovery, downloads and navigation.
- English overview/investigation screenshots use isolated synthetic data. Local documentation links were checked; source and portable packages include the primary English README and Chinese translation.
- No 24-hour validation was resumed; prior scope and measurement limits still apply.

## v0.2.4 review fixes

- Regression tests cover rejecting socket evidence timestamped after the current clock, retaining independent proxy identity, accepting fresh replacement evidence, and resuming threshold alerts after a backwards clock change.
- Desktop GUI smoke additionally verifies the sidebar link targets the public `GloryPkqa/codex-netwatch` repository.
- The review retains the existing read-only proxy integration, separate Codex/other/unknown accounting and paused long-run validation.

## v0.2.3 scope and UI clarity

- All 78 automated tests and syntax checks passed locally, including a case where 25 unrelated apps transfer more bytes than Codex. The separate Codex ranking still returns the smaller Codex process.
- Real WebView2 GUI checks cover Codex-only defaults, switching to all-proxied-app comparison and back, bilingual ranking titles, scrolling sidebar selection, startup settings, CSV saving, and window reopening.
- Codex-only rankings and proxy-wide coverage counters have separate, explicit labels. Measurement and attribution rules are unchanged. No 24-hour validation was resumed.

## v0.2.2 startup preference

- The desktop GUI smoke also toggles the startup button on/off against an injected preference, without writing a real Windows startup value.
- Fixture shutdown now stops serving new snapshots before the final audit, allowing a response already served to commit before stopping the child. This addresses the remaining Windows CI response/commit race; it does not relax the independent byte comparison.
- Startup is off by default and controlled only through an explicit window/tray action.

## v0.2.1 desktop GUI

- All 74 automated tests and JavaScript syntax checks passed locally after the update.
- A real Microsoft Edge WebView2 window rendered synthetic live dashboard data. The GUI smoke test passed English/Chinese switching, saving a CSV download, rejecting external embedded navigation, closing to the tray, and reopening the window.
- The portable collector lifecycle and ownership smoke test passed with the bundled official runtime.
- The Windows CI failure in v0.2.0 was traced to synchronous PowerShell memory inspection blocking the fixture server. The harness now reads memory asynchronously; the independent byte-oracle regression passes locally. The earlier 30-second report below remains a record of its original frozen source, not a v0.2.1 load-test claim.
- No 24-hour test was resumed; no completed 24-hour or 72-hour validation is claimed.

## v0.2.0 historical results

## Completed

- 74 automated tests and JavaScript syntax checks passed locally on Windows.
- Portable Windows tray smoke passed with the bundled official Node.js v24.22.1: start, duplicate launch, stop, restart, exit, collector-lock cleanup, ownership marker, and refusal to stop an unrelated compatible-looking service.
- The additive v2→v3 database migration preserved existing counters; SQLite integrity remained `ok`.
- English / Chinese UI checks covered anomaly display, connection drill-down, scoped gaps, language persistence and diagnostic download. Privacy tests seed identifying and credential canaries and verify they are excluded from the exported JSON.

The final **30-second, 1,000-connection, 500-ms polling** fault/load run used the same official runtime and frozen collector source as the long run:

| Measurement                              | Observed result                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Actual wall-clock duration               | 30.523 seconds                                                                                |
| Successful responses / persisted samples | 46 / 46; independent byte oracle matched                                                      |
| Deliberate faults                        | 17 HTTP 503 responses, 3 collector restarts, 2 connection-counter and 2 global-counter resets |
| SQLite integrity                         | `ok`; bucket and sample totals agreed                                                         |
| Peak collector RSS                       | 93,003,776 bytes; excludes the harness and observer child                                     |
| Peak database + WAL footprint            | 3,467,200 bytes                                                                               |
| Maximum measured dashboard latency       | 13.49 ms                                                                                      |
| Observed sampling intervals              | 19.361 seconds; deliberate outages, restart startup and baselines are excluded                |

The observed-time fraction is **not packet-capture coverage**. Faults were intentionally frequent in this short test. The raw, sanitized [synthetic smoke report](upstream/docs/validation/smoke-official-node.json) contains the exact settings and counters.

## Long-run status

A separate **24 actual hour** run began at **2026-10-22 18:38:13 Asia/Shanghai** with 300 synthetic connections, periodic outages and collector restarts. It uses official Node.js v24.22.1 and source fingerprint `73895f1dc4bb4a4e368a488bfdcce64a1f1004bf25608e8e8d07f4a9a9f93a21`.

The long run was stopped before completion. **Neither a completed 24-hour nor a 72-hour result is claimed for this preview.** The test harness remains available for a later full run. Major scheduling pauses, sleep, interruption, unexpected collector exit, byte mismatches or integrity failures prevent a pass.

See [STABILITY.md](STABILITY.md) for reproduction and measurement limits. The source fingerprint identifies the frozen `src/`, `public/`, `scripts/` and `package.json` file bytes on the recorded host; it is not the Git commit ID or archive checksum.
