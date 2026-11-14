# Third-party materials

## Codex Netwatch

Copyright (c) 2026 GloryPkqa. MIT License. The full notice and license are retained in [LICENSE](LICENSE). See [NOTICE.md](NOTICE.md) for the exact upstream baseline and modifications.

## Node.js

Source checkout: Node.js is a separately installed prerequisite, not a tracked binary.

The optional Windows package includes official **Node.js 24.22.1 for Windows x64**. The build pins and verifies the official archive and executable SHA256 values. It copies the full Node.js license, including dependency notices, to `runtime/NODE-LICENSE.txt`, and includes the official checksum file and a runtime provenance manifest. The Node.js project is available at https://nodejs.org/ and https://github.com/nodejs/node.

## Microsoft Edge WebView2 SDK

The optional Windows tray build uses Microsoft's official **Microsoft.Web.WebView2 1.0.4258.31** NuGet package. It includes the WinForms/Core managed bindings and the x64 loader. The package's complete `LICENSE.txt` and `NOTICE.txt` are copied to `WEBVIEW2-LICENSE.txt` and `WEBVIEW2-NOTICE.txt` in the generated distribution. Keep these files when redistributing that distribution. Package URL: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31 .

The WebView2 Evergreen Runtime and Windows/.NET Framework are system prerequisites. The build does not bundle or silently install those runtimes. No Microsoft or upstream endorsement is claimed.

No third-party runtime, NuGet archive, personal configuration, traffic history or build cache is committed to this source repository.
