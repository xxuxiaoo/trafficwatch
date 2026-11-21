# Build and install on Windows

## Source development

Use Node.js 24+. Run `npm ci --ignore-scripts --no-audit --no-fund` to install the pinned dependencies. The collectors and viewer use built-in `node:sqlite`. The multiple-cipher driver serves the one-time history converter and its tests. Run `npm run check` and `npm test` from the checkout.

On Windows, `npm run demo` starts an isolated synthetic collector on port 43129 and opens the overview on port 43139. It uses `data/demo`. `CODEX_FLOW_PORT` and `TRAFFICWATCH_OVERVIEW_PORT` can select unused ports. `npm start` starts only the viewer on port 43131. `TRAFFICWATCH_DATA_ROOT` and `TRAFFICWATCH_CACHE_ROOT` can select development histories and cache location. Use an administrator-installed collector for real ETW data.

The viewer isolates quick totals, complete overviews and interactive connection details in separate bounded workers. `/api/health` exposes each worker's current stage, elapsed time, queued work, completions and failures without returning traffic records. A detail click shows its time window before waiting for SQL; abandoned page selections cancel their work. Queries retain exact minute attribution across online and archived history.

## Windows package

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

The build requires Windows x64, the .NET Framework C# compiler, and `curl.exe` for fetching dependencies. It verifies official Node.js 24.22.1, TraceEvent 2.0.77 and System.Runtime.CompilerServices.Unsafe 4.5.2 against pinned SHA256 values. The static front end is staged from `public/`. Package output and dependency caches are under `.build/`.

Outputs:

- `.build/windows/TrafficWatch/`: complete fresh-install package.
- `.build/trafficwatch-windows-x64.zip`: package archive.
- `.build/SHA256SUMS.txt`: archive SHA256.

To keep an existing build available, pass a new staging path under `.build` and a separate archive name, for example `-StageRoot .build/windows-0.10.13 -OutputFile .build/release-0.10.13/trafficwatch-windows-x64.zip`. A custom staging path must not already exist; the default `.build/windows` path is refreshed in place.

The build includes Node.js, SQLite, YAML and diagnostic dependency notices. The tray requires .NET Framework 4.8 and opens the viewer in the default browser. Generated EXEs are unsigned. Check the release archive and manifest hashes before use.

For an offline build, install the locked npm dependencies ahead of time and pass `-DependencyRoot` pointing to an existing package with `runtime/node.exe`, `runtime/NODE-LICENSE.txt` and `runtime/SHASUMS256.txt`. Prepopulate `.build/dependencies/traceevent-2.0.77.nupkg` and `.build/dependencies/unsafe-4.5.2.nupkg` using the official URLs and SHA256 pins in `scripts/build-diagnostics.ps1`. The build checks cached dependencies too.

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
- Desktop shortcut: `TrafficWatch.lnk`, opening the traffic and control view. An existing shortcut with that name is left alone.

The installer creates local `config.local.json` and `suite-settings.json`; neither contains a copied controller secret. The supervisor reads the local configured secret when starting the Mihomo collector. The data directory grants access to the installation owner, SYSTEM and Administrators. Executables stay under Program Files. `-NoStart` creates the installation and tasks without starting them immediately.

This is a **fresh installer**. It refuses an existing program directory, same-name tasks, occupied monitoring ports or a non-empty data directory. A setup error removes only tasks created by that attempt and leaves its partial program/data directories for inspection. Use the upgrade script below for an existing installation.

## In-place upgrade

Extract the reviewed Windows package into a separate folder. Run its `scripts/upgrade-windows.ps1 -Preflight` from normal PowerShell to verify files, version, access and free space. Run the same script without `-Preflight` from administrator PowerShell to replace the existing installation.

An encrypted installation asks for the old TrafficWatch password or recovery code once in that window. The upgrade verifies three converted SQLite databases and their pending captures from copies, then switches them together. It retains the original history, keys and backups under the existing data path. Failed validation stops the switch. The previous program is kept for rollback, and the task names, user preferences and tray shortcut stay at their existing locations.

## Viewing and control

Open the desktop shortcut or choose **Open TrafficWatch** in the tray. Both open http://127.0.0.1:43131/ in your Windows session. The overview can start or pause the collectors, reopen the tray or change startup preferences. To close the entire suite, choose **More controls → Stop TrafficWatch**. This closes the background components and the viewer. Reopen the desktop shortcut for access and choose **Start collection** to resume recording. The 43128 and 43130 collector interfaces redirect browser visits to the overview.

Native collection can continue while Clash is closed. The proxy lane will report its source unavailable until the controller is accessible. Controller counters cannot reconstruct missed proxy connections.

The inherited automatic single-process updater is disabled in this fork. Review releases in this repository; do not install an upstream portable ZIP over an installed two-collector suite.

## Source archives

After reviewing/staging a Git checkout, run `npm run audit:publication`, then `npm run package:source`. The source archive is built from Git-tracked files. Do not force-add ignored configuration or data. Generated local archives are excluded from source control.
