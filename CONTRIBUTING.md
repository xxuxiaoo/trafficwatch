# Contributing

Use Node.js 24+ and run `npm run check`, `npm test` and `npm run audit:publication` before opening a pull request. Windows native changes also require `scripts/build-native.ps1` and its helper self-test. See `docs/BUILD_WINDOWS.md` for the full desktop build.

Keep fixtures synthetic. Use reserved example domains/IPs and temporary directories, preserve exact interval and byte accounting checks, and do not commit actual SQLite files, secrets or screenshots of real activity. Preserve the upstream license and attribution. Contributions are distributed under MIT.

The current installer supports a fresh installation. Changes to upgrades, boot task ownership or process termination must include an explicit recovery design and checks that unrelated processes and original records remain untouched.
