# Moderation policy files and recovery

**Status:** current worktree; verify a disposable restart before deploying.

An Authority keeps local account/channel restrictions in `blacklist.txt` and Server Center rules, cases, privacy policy, staff and self-selected community role gates, member community role choices, and temporary join controls in `server_center.json` under its data directory. These files belong to that Authority. There is no Wabi-wide ban list.

## Damaged or older blacklist lines

The Authority now refuses to start when an existing blacklist file contains an unknown or malformed entry. Older versions could skip such lines. The startup error includes the line number; it does not delete or rewrite the file.

1. Stop the Authority and preserve a copy of the complete data directory, including both policy files and WabiDB. Confirm no process still uses that directory.
2. Copy `blacklist.txt` aside again before editing it. Inspect the reported line and decide what restriction the operator intended. Do not silently discard an unknown entry.
3. Keep each restriction on one line as `type|value|reason|expires_timestamp`. Use `0` for no expiry or a Unix timestamp in seconds. Supported types are `user` (positive numeric account ID), `ip` (one IPv4 or IPv6 address), `channel_ban` and `channel_timeout` (`channel_id:positive_user_id`). Comments begin with `#`.
4. Restart against the preserved data directory. If `server_center.json` is damaged, restore that file from a matching backup; do not replace it with an empty object to make the server boot.

The Authority writes blacklist changes with a temporary file and rename. Active bans and timed restrictions are checked from the loaded file after restart. A damaged file blocks admission rather than becoming an empty allowlist.

## IP restrictions

An `ip` entry denies HTTP and Socket.IO requests from the resolved client address. Without `WABI_TRUSTED_PROXIES`, the address is the direct socket peer and forwarding headers are ignored. When that setting names trusted proxy CIDRs, Wabi uses the rightmost untrusted address in `X-Forwarded-For`; configure only proxies you control. A tunnel or reverse proxy can make many people share one observed address. Check the address before adding an IP restriction; an IP address is a weak, shared signal and does not prove account identity.

Account bans are local to this server. Temporary raid controls require invitations for new accounts and pause guest creation without retaining additional messages. Neither mechanism prevents determined evasion through another address or independently hosted Wabi server.

## Case evidence

A participant report explicitly stores one selected message snapshot for staff. The owner may remove it, and may choose a 1, 7, 30, or 90 day lifetime for snapshots in **new** reports; the default is manual removal. Automated safety flags store a message reference and rule details without a second content snapshot. Expiry clears the active Server Center snapshot, not old backups, event history, copies made by recipients, or text staff typed into comments. Maintain backup retention separately.
