# Relay management

Open **中转直连** in the traffic center after unlocking the owner session. Add a display name and a relay hostname or HTTP(S) API URL. A pasted URL contributes only its hostname; credentials, IP literals, wildcard names, localhost and local-network suffixes are rejected. At most 64 unique relay targets can be stored.

Every save, edit, delete, enable change, restore, and disable-all operation first saves the previous list in `DataRoot/relay-bypass/backups`. The first edit backs up the existing `RelayHosts` list without changing it. Backups can be restored in the page; restoring one first saves the current list as another backup. The manager keeps the latest 30 backups in its picker and retains older backup files.

After a change, the page requests a background reconciliation. The route worker resolves enabled domains through the physical adapter, installs exact IPv4 routes, updates its owned hosts block, refreshes the Clash profile overlay and DIRECT rules, and removes no-longer-needed owned routes and `NO_PROXY` entries. The diagnostic daemon reads the same enabled target list. AAAA records are reported as unmanaged and prevent a verified status because this route manager only installs IPv4 routes. The status is `verified` only after the positive physical-interface probe and Clash-connection check pass; a queued request or a route update alone is not proof of verification.

**恢复原 DIRECT** disables all managed targets and requests reconciliation. The current list is backed up first. This removes TrafficWatch-owned physical routes and Clash profile additions while preserving unrelated Clash configuration and each relay's original matching rules. It does not alter other applications' proxy configuration beyond removing TrafficWatch-owned entries.

The boot-time route worker and the local viewer use the same managed configuration. The loopback API uses the application request header and checks the browser origin.
