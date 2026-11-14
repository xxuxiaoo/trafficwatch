# Build and install on Windows

## Source development

Use Node.js 24+. No `npm install` is necessary: the collector uses built-in Node.js modules, including `node:sqlite`. Run `npm run check` and `npm test` from the checkout.

`npm run demo` starts the inherited synthetic-data collector on port 43128 with isolated `data/demo`. Set `CODEX_FLOW_PORT` to an unused port if another collector is running. This command previews the legacy dashboard, without changing boot tasks. `npm start` starts only the unified viewer on port 43131 and needs `windows/monitor.sqlite` and `clash/monitor.sqlite` under its data root. `TRAFFICWATCH_DATA_ROOT` and `TRAFFICWATCH_CACHE_ROOT` can select those directories for a development viewer; `TRAFFICWATCH_OVERVIEW_PORT` selects an unused viewer port. Use an administrator-installed collector for real ETW data.

## Windows package

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

The build requires Windows x64, the .NET Framework C# compiler, and `curl.exe`. It downloads official Node.js 24.22.1 and WebView2 SDK 1.0.4258.31 with pinned SHA256 values. Generated dependencies, native binaries, desktop executables, staging and archives remain in `.build/`, except a separately invoked `scripts/build-native.ps1` writes its ignored helper under `native/`.

Outputs:

- `.build/windows/TrafficWatch/`: complete fresh-install package.
- `.build/trafficwatch-windows-x64.zip`: package archive.
- `.build/SHA256SUMS.txt`: archive SHA256.

The Node.js and WebView2 full license/notices are copied into the package. Edge WebView2 Evergreen Runtime and .NET Framework 4.8 are installed system prerequisites. Generated EXEs are unsigned. Digest checks verify the pinned dependencies and archive contents, not Windows publisher identity.

For an offline build, pass `-DependencyRoot` pointing to an extracted, already available official-compatible package containing `runtime/node.exe`, the Node.js licenses/checksums, the three WebView2 DLLs and their license/notice files. The same executable/DLL hashes are checked. Build staging is cleared only after its absolute path is checked to equal this checkout's `.build/windows`.

## Fresh installation

Extract the whole Windows archive. In an administrator PowerShell, run:

```powershell
cd .\TrafficWatch
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

Optional arguments:

```powershell
.\scripts\install-windows.ps1 -DataRoot 'E:\TrafficWatchData' -ClashConfigPath 'E:\ProxyConfig\clash-verge.yaml'
```

Run as the Windows user who owns the Clash configuration and accept elevation for that same user. Defaults:

- Program files: `%ProgramFiles%\TrafficWatch`.
- Data: `%ProgramData%\TrafficWatch`.
- Configuration: the installing user's Clash Verge Rev application-data directory.
- `TrafficWatch - Open-source Netwatch`: SYSTEM boot task; starts two independent collectors before user login.
- `TrafficWatch - Tray`: limited user task at login; exiting the tray keeps collection running.
- Desktop shortcut: `TrafficWatch.lnk`, opening the suite controller. An existing shortcut with that name is left alone.

The installer creates local `config.local.json` and `suite-settings.json`; neither contains a copied controller secret. The supervisor reads the local configured secret when starting the Mihomo collector. The owner gets Modify access to the chosen data directory, while executables stay under Program Files. `-NoStart` creates the installation and tasks without starting them immediately.

This is a **fresh installer**. It refuses an existing program directory, same-name tasks, occupied monitoring ports or a non-empty data directory. It does not migrate or overwrite an existing installation. A setup error removes only tasks created by that attempt and leaves its partial program/data directories for inspection. No user history is recursively deleted. A future migration installer must separately handle backups and rollback.

## Viewing and control

Open the desktop shortcut to start/stop the suite, reopen the tray or enable/disable startup. The controller starts the overview service when opening the main view. Addresses:

- Unified view: http://127.0.0.1:43131/
- Legacy Windows view: http://127.0.0.1:43128/?legacy=1
- Legacy Mihomo view: http://127.0.0.1:43130/?legacy=1

Native collection can continue while Clash is closed. The proxy lane will report its source unavailable until the controller is accessible. Controller counters cannot reconstruct missed proxy connections.

The inherited automatic single-process updater is disabled in this fork. Review releases in this repository; do not install an upstream portable ZIP over an installed two-collector suite.

## Source archives

After reviewing/staging a Git checkout, run `npm run audit:publication`, then `npm run package:source`. The source archive is built from Git-tracked files. Do not force-add ignored configuration or data. Generated local archives are excluded from source control.
