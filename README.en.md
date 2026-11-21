# TrafficWatch

Local Windows network history for observed applications, Clash/Mihomo proxy traffic, and Codex / Claude Code / dsh process families. A unified overview supports time filters, upload/download bars, application and connection drill-down, traffic peaks, and explicit collection gaps.

[中文说明](README.md) · [Build and install](docs/BUILD_WINDOWS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Attribution](NOTICE.md)

Based on **[GloryPkqa/codex-netwatch v0.5.1](https://github.com/GloryPkqa/codex-netwatch/tree/v0.5.1)** under MIT. The original copyright and license are retained. This fork is maintained independently.

## Current features

- Windows application, Clash/Mihomo and Harness views with selected-period details, route evidence and searchable rankings. Airport totals combine automatically identified subscriptions across clients and drill down by client, node and connection.
- Open the local dashboard directly. Traffic and diagnostics are written to SQLite WAL as they are collected. An encrypted installation can move its history as part of the [one-time in-place upgrade](docs/BUILD_WINDOWS.md#in-place-upgrade).
- Unlimited history with lossless monthly compression of old samples/minute buckets, transparent archive queries, bounded disposable caches, storage accounting and incremental space reclamation. See [storage details](docs/STORAGE.md).
- [AI connection diagnostics](docs/connection-diagnostics.md) combining allowlisted Magpie, CC Switch, Codex, Claude Code and dsh log metadata with TraceEvent/PktMon evidence, failure/slow-request incidents, period filters and automatic collection checks.
- Explicitly configured physical IPv4 relay bypass with managed routes, hosts/Clash exclusions, verification and rollback. Ordinary collection does not enable this feature automatically.
- Independent quick, full-attribution and interactive-detail query workers, cancellation, bounded caches and background pause/resume. Clicked intervals appear immediately while their records load.

## Build

Requires Windows 10/11 x64, .NET Framework 4.8 and a web browser. Source development uses Node.js 24+ and `npm ci --ignore-scripts`.

```powershell
git clone https://github.com/xxuxiaoo/trafficwatch.git
cd trafficwatch
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build:windows
```

Run `.build/windows/TrafficWatch/scripts/install-windows.ps1` from an administrator PowerShell for a fresh installation. It installs to `%ProgramFiles%\TrafficWatch`, stores records in `%ProgramData%\TrafficWatch` by default, creates a SYSTEM boot task for the two collectors and a separate login task for the user tray. Use `scripts/upgrade-windows.ps1` from the new package to upgrade an existing installation. Use `-DataRoot` or `-ClashConfigPath` for local configuration; those files are never tracked.

The desktop shortcut and tray both open http://127.0.0.1:43131/ . Start or pause collection, reopen the tray or change startup preferences from the same page. Collector root URLs redirect to the overview.

## Measurement boundaries

Windows ETW observes process TCP/UDP events, including loopback. Mihomo observes the selected controller's counters and connections. Those are overlapping views and must not be added together as a bill. Harness totals classify observed application traffic; they are not per-chat or token billing. Unknown attribution and collection gaps remain explicit. Offline data cannot be recovered, and no exact agreement with VPN or carrier accounting is promised.

Ordinary capture reads local observations. Only the explicitly enabled relay-bypass feature changes managed routes, a marked hosts block and the configured Clash enhancement script; it provides its own rollback. TrafficWatch does not decrypt HTTPS or install TLS interception.

The suite defaults to unlimited retention (`retentionDays: 0`). Queries use disposable read-side summaries and bounded worker queues; collection remains separate from the viewing service. See [validation](docs/VALIDATION.md) for tested behavior and limits.

Run `npm run audit:publication` inside a Git checkout before publishing. The repository contains source, synthetic tests and documentation, without personal traffic records, local credentials or runtime binaries. Keep LICENSE, NOTICE.md and any bundled runtime/SDK license files when redistributing.
