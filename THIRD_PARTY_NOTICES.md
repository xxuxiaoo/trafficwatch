# Third-party materials

## Codex Netwatch

Copyright (c) 2026 GloryPkqa. MIT License. The full notice and license are retained in [LICENSE](LICENSE). See [NOTICE.md](NOTICE.md) for the exact upstream baseline and modifications.

## Node.js

Source checkout: Node.js is a separately installed prerequisite, not a tracked binary.

The optional Windows package includes official **Node.js 24.22.1 for Windows x64**. The build pins and verifies the official archive and executable SHA256 values. It copies the full Node.js license, including dependency notices, to `runtime/NODE-LICENSE.txt`, and includes the official checksum file and a runtime provenance manifest. The Node.js project is available at https://nodejs.org/ and https://github.com/nodejs/node.

## better-sqlite3-multiple-ciphers / SQLite3MultipleCiphers

The one-time encrypted-history converter uses **better-sqlite3-multiple-ciphers 13.1.1**, MIT licensed, including SQLite3MultipleCiphers. Source: https://github.com/m4heshd/better-sqlite3-multiple-ciphers . Package integrity is pinned in `package-lock.json`; installation scripts are disabled. The Windows package includes the converter dependency’s JavaScript runtime, Windows x64 N-API binary, package metadata and complete MIT license at `migration/node_modules/better-sqlite3-multiple-ciphers/LICENSE`.

Copyright (c) 2021–2026 Mahesh Bandara Wijerathna; Copyright (c) 2017 Joshua Wise; Copyright (c) 2019–2026 Ulrich Telle. Keep the full bundled license with redistributed binaries. Other operating systems obtain their native binary from the locked npm package.

The pinned transitive dependency **node-addon-api 8.9.2** is MIT licensed, copyright (c) 2017 Node.js API collaborators. Its headers support the SQLite native addon. The Windows package retains its full notice at `migration/node_modules/better-sqlite3-multiple-ciphers/NODE-ADDON-API-LICENSE.md`. Source: https://github.com/nodejs/node-addon-api .

## Microsoft PerfView / TraceEvent

The optional Windows connection diagnostic helper uses **Microsoft.Diagnostics.Tracing.TraceEvent 2.0.77**, including its matching FastSerialization, OSExtensions and native kernel control components, and **System.Runtime.CompilerServices.Unsafe 4.5.2**. These are MIT licensed. The net45 build was selected for the existing Windows .NET Framework 4.8 prerequisite; no new .NET SDK or runtime is installed. Package URLs and SHA256 pins are in `scripts/build-diagnostics.ps1`; a provenance manifest accompanies the built helper. The full MIT notice is retained in `docs/TRACE-EVENT-LICENSE.txt`; the Unsafe package's own license and third-party notice accompany its DLL. Source: https://github.com/microsoft/perfview . These are runtime decoding dependencies, not a bundled PerfView GUI.

## YAML

**yaml 2.8.2** (ISC, copyright Eemeli Aro) parses the owner's existing Clash configuration locally. Its npm integrity is pinned in `package-lock.json`; the Windows package retains the full license at `node_modules/yaml/LICENSE`. Keep that copyright and permission notice with redistributed copies. Source: https://github.com/eemeli/yaml .

## Magpie and Windows PktMon

Magpie is observed through its existing local request feed and incremental logs; its gateway code and credentials are not redistributed. PktMon is a Windows-provided prerequisite, not a bundled binary. Links and scope are documented in `docs/connection-diagnostics.md`. No TLS interception, root certificate or extra network driver is installed by TrafficWatch.

No third-party runtime, NuGet archive, personal configuration, traffic history or build cache is committed to this source repository.
