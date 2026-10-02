# Desktop Host Mode — plan of attack

Date: 2026-09-16. Baseline: `d5eba19a7de64c60c6828be3f3447d58570fb330`.
Status: planned / implementation branch, **not shipped**.

## Product contract

Launch Wabi, create a community on this computer, invite people. The desired experience is the simplicity of launching a Minecraft server JAR, without requiring ordinary users to install Docker or development tools. Experts retain the same standalone Authority and full CLI. There is no restricted beginner server and no separate desktop database format.

The finish line is an unassisted clean Windows/Linux installation, first owner, a genuinely new participant on another network, messages, usable calling, and a tested backup/restore. A Host button or successful localhost request alone does not meet it.

Preserve independent communities, existing authentication/permissions, server/account scoping, WabiDB, optional helpers and Docker/Podman. No federation, global Wabi account, mandatory Wabi-operated relay, replacement database, or new call-stack rewrite. Server-readable private messages remain server-readable. Experimental replication/standby does not become production HA by adding a GUI.

## User journey

1. **Join a community** or **Host on this computer**. Joining starts no Authority and asks for no hosting permissions.
2. Initialize a safe per-user data directory and secrets automatically. Establish the first owner while bound only to loopback. Do not expose an unclaimed community to other machines.
3. Choose explicit access: this machine/LAN, private desktop invitation, or public browser HTTPS. Keep certificates, ingress, transport enrollment and membership conceptually distinct.
4. Show hosting state, connected people, access mode, last successful backup and separate media diagnostics. Primary actions: Invite, Back up, Hosting settings, Stop hosting. Logs and configuration are secondary.
5. Closing the window may keep active hosting in the tray; Quit must explain that it stops the community and request graceful shutdown. Never imply operation during sleep/power-off. Background service mode is a later explicit choice.
6. Move the same community to a dedicated host through a tested full backup/restore, preserving identity, required keys, uploads and configuration.

## Architecture

One `wabi-server` implementation, three delivery methods:

- Desktop with an optional bundled Authority, managed by narrow native commands.
- Standalone platform-specific prebuilt server plus launch/service documentation.
- Existing Docker/Podman deployment.

The desktop supervisor owns only children it started. The webview cannot choose arbitrary executables, arguments, environment variables or filesystem paths. Package binaries for the actual target architecture. Never fetch and execute an unverified binary at first launch.

Startup must identify the owned child and its real bound address, then verify application readiness. Use OS-assigned loopback ports where suitable; never kill an unrelated process to acquire a port and never mark ready after a fixed delay. Serialize lifecycle operations, handle stale completions, bound retries, preserve data on failure and use a private inherited control channel for graceful shutdown. Do not add an unauthenticated HTTP shutdown endpoint.

Configuration and storage semantics must remain compatible with the standalone CLI. Keep runtime data out of installation/build directories. Never erase keys, remove live database locks or replace an unreadable instance with a blank community to make startup look successful.

## Verified baseline concerns

- `core/crates/wabi-server/src/main.rs`: the Authority bind constructs an unspecified IPv6 address rather than honoring `config.host`. The Anchor bind has the same pattern. Fix and regress this before claiming loopback-only desktop bootstrap.
- `src-tauri/src/main.rs` and `src-tauri/src/lib.rs`: independent Tauri builders register different commands/state. Consolidate initialization without losing tray, notifications, recording, Lore, Tailcat or viewer behavior; retain desktop/mobile gates.
- `src-tauri/tauri.conf.json`: the inspected external binary list contains Tailcat, not the Authority. Source/build availability is not an end-user hosting installer.
- `docs/PROJECT_STATUS.md`: native packaging, physical calling, backup/restore and experimental topology retain their existing verification boundaries.

## Delivery stages

### A — Safe foundation

Honor bind configuration in Authority/Anchor; unify native entrypoints; introduce testable process/control foundations; maintain CLI behavior and add regression coverage. Gate: local setup actually binds locally and the executable registers the intended commands.

### B — Local Host Mode

Package the matching Authority; implement native Start/Status/Stop, actual readiness, persistent storage, owner setup, Join/Host UI, explicit errors and close/quit behavior. Gate: a clean supported computer creates, uses, stops and reopens the same community without developer tools.

### C — Private invitation

Audit and reuse Tailcat only after proving first-contact enrollment. A new device must not need an existing server session to obtain the connection needed to create that session. Include expiration/revocation, per-device identity, retry/network change and visible relay trust boundaries. Transport reachability never grants administrator access. Gate: an unenrolled remote friend joins, messages, calls and is revocable.

### D — Operational finish

Expose consistent backup, restore, compatible updates, failure recovery and optional service installation. A same-disk copy is not off-machine protection. A binary downgrade does not reverse a storage migration. Gate: restore on a clean host and demonstrate accounts/content/readiness, upgrade behavior and failure recovery.

### E — Public/expert polish

Publish standalone artifacts and precise CLI/config/service documentation. Guide public HTTPS and optional ingress/media helpers without pretending arbitrary networks are automatically reachable. Scale first through measured capacity, a supervised single Authority and scoped helpers. Replication/failover remain separate experimental work.

## Acceptance matrix

| Area | Evidence required |
| --- | --- |
| Clean installation | No manual Git, Node, Rust, Docker or frontend build steps on supported Windows/Linux |
| Bootstrap | Owner established locally; real bind address checked; no unclaimed public listener |
| Lifecycle | Repeated and concurrent start/stop, child exit, parent exit, startup timeout, close/quit, no unrelated process termination |
| Readiness | Expected child/address plus successful readiness; no timer-based or stale success |
| Storage | Restart/recovery/restore preserves accounts, messages, uploads and keys; locks never removed while live |
| Fresh invitation | New device on another network, no enrollment assumptions, expiry, revoke and retry |
| Calling | Real microphone/speaker/screenshare, reconnect, representative NAT/relay paths, sleep/wake |
| Expert operation | Standalone CLI on a dedicated host; correct bind/config; supervision; no GUI requirement |
| Optional services off | Core hosting/chat without unrelated plugins, providers or compulsory central account |

Explicit negative tests: missing/wrong-architecture binary, occupied port, locked storage, corrupt data, missing root key, full disk, permission denial, interrupted startup, incompatible version, expired invitation, inaccessible relay and denied microphone.

## Verification discipline

Record exact commands, platforms, commit and limitations. Source implementation, local tests, native builds, cross-network physical tests, merge and release are distinct. Draft PRs are not shipped functionality; fixtures are not physical/native proof. Do not deploy or advertise public-ready behavior on the strength of this plan.

## Work record

- Plan created from the pinned baseline. Implementation and test results will be appended as work is completed.
- Initial target: Stage A, then a safe local slice of Stage B. Public ingress, complete fresh-device enrollment and physical media certification remain later gates.

## Primary references

- `docs/PROJECT_STATUS.md`
- `docs/architecture/overview.md`
- `docs/NETWORKING.md`
- `docs/features/PRIVATE_ACCESS_GUIDE.md`
- `docs/deployment/BACKUP_AND_RECOVERY.md`
- `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`
- `core/crates/wabi-server/src/main.rs`
- Tauri official sidecar documentation: https://v2.tauri.app/develop/sidecar/

Haven is an interaction-design reference and Backspace an operator/media reference, not a code dependency. Independently implement Wabi's workflow; do not transplant AGPL code under an MIT-only assumption.
