# TrafficWatch

Local Windows network history for observed applications, Clash/Mihomo proxy traffic, and Codex / Claude Code / dsh process families. A unified overview supports time filters, upload/download bars, application and connection drill-down, traffic peaks, and explicit collection gaps.

[中文说明](README.md) · [Build and install](docs/BUILD_WINDOWS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Attribution](NOTICE.md)

Based on **[GloryPkqa/codex-netwatch v0.5.1](https://github.com/GloryPkqa/codex-netwatch/tree/v0.5.1)** under MIT. The original copyright and license are retained. This fork is maintained independently.

## Build

Requires Node.js 24+, Windows 10/11 x64 and .NET Framework 4.8. The tray also needs the installed Edge WebView2 Runtime. There are no JavaScript package dependencies.

```powershell
git clone https://github.com/xxuxiaoo/trafficwatch.git
cd trafficwatch
npm run check
npm test
npm run build:windows
```

Run `.build/windows/TrafficWatch/scripts/install-windows.ps1` from an administrator PowerShell for a fresh installation. It installs to `%ProgramFiles%\TrafficWatch`, stores records in `%ProgramData%\TrafficWatch` by default, creates a SYSTEM boot task for the two collectors and a separate login task for the user tray. It refuses to overwrite an existing installation. Use `-DataRoot` or `-ClashConfigPath` for local configuration; those files are never tracked.

The desktop shortcut opens a controller for starting/stopping the suite, reopening the tray and changing startup preferences. The overview is at http://127.0.0.1:43131/ . Legacy views remain available at ports 43128 and 43130 with `?legacy=1`.

## Measurement boundaries

Windows ETW observes process TCP/UDP events, including loopback. Mihomo observes the selected controller's counters and connections. Those are overlapping views and must not be added together as a bill. Harness totals classify observed application traffic; they are not per-chat or token billing. Unknown attribution and collection gaps remain explicit. Offline data cannot be recovered, and no exact agreement with VPN or carrier accounting is promised.

The suite defaults to unlimited retention (`retentionDays: 0`). Queries use disposable read-side summaries and bounded worker queues; collection remains separate from the viewing service. See [validation](docs/VALIDATION.md) for tested behavior and limits.

Run `npm run audit:publication` inside a Git checkout before publishing. The repository contains source, synthetic tests and documentation, without personal traffic records, local credentials or runtime binaries. Keep LICENSE, NOTICE.md and any bundled runtime/SDK license files when redistributing.
