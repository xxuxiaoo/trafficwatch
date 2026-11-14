# Privacy and security

TrafficWatch keeps network history in local SQLite files. Records can include process names and paths, destination IPs/domains, connection times, route metadata, byte counts and process-family evidence. The inherited optional session feature can read local Codex activity/token metadata; it does not convert token counts into network bytes.

The Windows process observer examines limited executable/script arguments in memory to classify supported Node-based harnesses. It does not export full command lines, trailing CLI arguments, environment variables or chat bodies into those observations. The Mihomo controller secret is read from local configuration/environment and must remain private.

The default HTTP services bind to `127.0.0.1` and validate Host/Origin and the application request header. These checks do not isolate mutually untrusted users on the same machine. Do not expose the services with a reverse proxy or port-forward them to other machines.

System-wide ETW collection uses an administrator-installed SYSTEM boot task. Executable files remain under Program Files; observations and the disposable viewer cache live separately. The dashboard does not modify system proxy rules, install TLS interception, decrypt traffic or send application telemetry. Manual release checks contact GitHub. Windows builds download pinned official Node.js/WebView2 dependencies when no verified offline dependency directory is supplied.

Do not publish `config.local.json`, `suite-settings.json`, `.env`, raw exports, screenshots of real use, databases, logs, crash dumps, credentials or build caches. `.gitignore` and `scripts/audit-publication.mjs` provide a first check, not a guarantee of complete secret detection. Inspect a public diff as well.

For a suspected vulnerability, avoid posting real connection records or credentials in a public issue. Use GitHub's private vulnerability reporting when available; otherwise describe the issue without sensitive evidence and request a private contact channel.
