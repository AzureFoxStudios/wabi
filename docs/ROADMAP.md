# Wabi Roadmap

**Updated:** 2026-09-14  
**Status:** living priority map, not a release promise.

Wabi already has a wide feature surface. The priority now is less “add another tab” and more **make the existing product coherent, recoverable, secure, and pleasant enough to trust**.

For the current shipped/experimental boundary, see [PROJECT_STATUS.md](PROJECT_STATUS.md). This roadmap describes where effort should go next.

The active execution plan is the [production-pilot finishing campaign](plans/2026-09-15-production-finish-campaign.md), with dependencies, implementation cards, and acceptance gates for hosted testers and self-hosters. Linked local Notes has a [separate migration and implementation design](plans/2026-09-15-linked-local-notebook.md).

## Priority 0 — prove the foundation

### Storage, backup, and recovery

- **Keep WabiDB persistence/recovery proven on the release candidate.** The September 15 audit did not reproduce the previously unspecified regression; restart/replay/crash tests passed. Tie any remaining failure to a reproducer and complete a current-candidate restore drill before distributed-state work moves forward.
- Run a real backup → clean-host restore drill using [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md).
- Keep persistent-record/schema changes backward-safe; never break older postcard-encoded records without a dual-decode migration path.
- Make operator health/readiness surfaces explain storage/application failure rather than reporting a meaningless green light.

### Calls and screen sharing

- Continue physical two-client acceptance across representative networks and devices.
- Exercise reconnect, loss recovery, screenshare, microphone/camera ownership, Bluetooth/audio-route behavior, and optional TURN/SFU paths.
- Reduce the remaining performance gap caused by media-over-Socket.IO/base64 where that path is used; prefer binary/specialized media transport when it meaningfully improves reliability.
- Do not treat synthetic/headful browser tests as physical-device certification.

### Authorization and admin operations

- Continue REST/Socket.IO/admin permission audits, especially around private resources and destructive operations.
- Finish the Admin/Moderator/Owner overhaul around useful operational questions: storage/uploads, connected helpers/nodes, health, jobs, failures, moderation, and cleanup — not vanity counters.
- Make destructive storage/upload actions dependency-aware so an operator cannot casually delete a file still referenced by content.

## Priority 1 — product cohesion

### Communication and profiles

- Finish the DM/profile interaction cleanup so “click a person → talk to them” has one obvious path.
- Keep private-message UI honest about the current server-readable security model.
- Evolve profiles, notes, social context, and game/project surfaces without creating a global Wabi identity service.
- Any future cross-server friend convenience should remain **client-owned/non-federated** unless the architecture is deliberately changed and reviewed.

### Workspaces and docking

- Continue removing old AI-generated UI oddities: floating text controls, duplicate navigation, inconsistent buttons, cramped panes, and one-off layouts.
- Make right-click/open/dock behavior predictable across Reader, Files, Media, Lore, whiteboard, Planner, CAD, and 3D.
- Preserve saved workspaces while making narrow/mobile layouts intentional rather than compressed desktop UI.

### CAD, 3D, and creative review

- Polish importer/runtime errors and larger-model behavior.
- Improve collaborative review/annotation ergonomics and navigation between chat preview ↔ dock ↔ full workspace.
- Preserve the product boundary: Wabi reviews and discusses design files; it does not need to become a parametric CAD package.
- Keep proprietary/optional helpers isolated from the MIT core when licensing requires it.

### Lore and project work

- Harden the existing local-folder/detection/staging/review workflow with real multi-user permission/concurrency tests.
- Improve comparison/conflict UX and recovery from interrupted transfers.
- Keep local drafts, published revisions, and review-required changes visually distinct.

## Priority 2 — clients and release engineering

### Desktop

- Keep Windows/macOS/Linux packaging reproducible.
- Exercise upgrades, native sidecars, file permissions, notifications, local workspace watchers, and private-access tooling on real machines.
- Treat signing/notarization/installer certification as separate release gates from “Cargo compiled.”

### Mobile

- Land the phone-first shell only after native Android/iOS build gates stay green.
- Then prove emulator/physical-device behavior: navigation, notifications, calling, audio routes, network changes, background/lock-screen constraints, and mobile-safe local-file boundaries.
- Do not ship a shrunken desktop UI as the mobile design.

## Priority 3 — extensions and optional services

### Plugins

- Keep runtime plugins opt-in/off by default until permission enforcement and isolation expectations are independently audited.
- Make dependency requirements and missing-addon errors explicit in UI.
- Preserve package checksum/signing/scanning/audit controls while defining what they **do not** sandbox.
- Add richer integration surfaces only when core workspaces cannot solve the use case cleanly.

### Games and external integrations

- Finish game/Steam work behind explicit privacy and operator configuration boundaries before calling it shipped.
- Prefer on-demand imports and deliberate sharing over continuous activity harvesting.
- External-service features should degrade cleanly when the provider/API is absent.

### Private access and media helpers

- Continue Tailcat/private-access and DERP reliability work without turning a relay provider into a required central Wabi service.
- Keep TURN, SFU, SRT gateway, tunnels, and future helpers optional and observable.

## Priority 4 — advanced topology, only after recovery is proven

The goal is not “turn mesh back on.” The goal is to earn each distributed-systems claim with evidence.

Required gates before production HA language:

1. live two-node state convergence;
2. restart/catch-up correctness;
3. deletion/tombstone convergence;
4. clear passive-writer rules;
5. no split-brain under failure injection;
6. Anchor realtime/WebSocket behavior proven, not HTTP-only marketing;
7. real deletion-safe standby export/import;
8. manual promotion runbook tested on a clean host;
9. uploads/blobs recovered with state;
10. only then evaluate automatic election/failover.

Until those pass, the **Authority is the single source of truth** and experimental replication stays explicitly gated.

## Security/privacy work that should not be shortcut

- End-to-end encryption for DMs/private rooms is a future security project, not a label to apply to current server-readable messages.
- Any E2EE design must cover text, attachments, multi-device keys, verification/key changes, logging, backup/recovery expectations, and downgrade prevention before Wabi claims operator blindness.
- Retention controls and E2EE are separate features.

## Deliberate non-goals / deferred work

- **Server federation/global identity:** not part of Wabi's current product model.
- **Active-active community state:** not until the HA gates above are proven.
- **Full CAD authoring:** Wabi is a review/collaboration surface.
- **Built-in music catalog/streaming:** deferred pending a clear legal/rights and product design; existing OSS music tools are sufficient meanwhile.
- **Feature-count races with Discord:** Wabi should win by ownership, coherence, useful integrated workspaces, and small-community ergonomics rather than cloning every centralized-platform feature.

## How to maintain this roadmap

- Put implementation detail in dated `docs/plans/` files, not here.
- Move an item forward based on verified behavior, not because a branch exists.
- When a feature becomes available/experimental/retired, update [PROJECT_STATUS.md](PROJECT_STATUS.md) and the relevant operator/architecture docs in the same change.
