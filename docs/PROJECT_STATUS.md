# Wabi Project Status

**Updated:** 2026-09-25

**Purpose:** canonical product-status boundary for operators, contributors, reviewers, and AI agents.

Wabi moves quickly. Dated plans and old PR descriptions are useful history, but they are not automatically the current contract. When documentation disagrees about whether something is shipped, this page and the current source should win over older planning documents.

## Product boundary

Wabi is a **self-hosted communication and collaborative-workspace application for small communities**.

The intended model is:

- one community runs one canonical **Authority** server;
- the Authority owns that community's accounts, permissions, content, and durable state;
- one Wabi client may save and switch among multiple independent Authorities;
- those independent servers do **not** federate, share identities, or synchronize community state;
- optional helpers may improve media, ingress, private reachability, or other scoped functions without becoming additional state authorities.

Wabi is not trying to become a centralized hosted social network, a Matrix/ActivityPub-style federation protocol, or a distributed active-active database product.

## Friends and direct message repair candidate — not deployed

The current branch adds server-local friend requests and accepted friendships,
plus direct message room, fanout and history repairs. The friend relationship
is a durable Authority record; it does not grant access to a DM. Browser and
physical phone acceptance, including the Tim deployment, remain pending. See
[the rebuild contract](plans/2026-09-25-friends-and-dm-rebuild.md).

## Production-finish candidate — not yet merged or deployed

`codex/production-finish-20260915` adds account/server-scoped local Notes with transactional saves, independent editor drafts, conflict recovery, trash, titled wiki-links/backlinks, explicit legacy recovery, JSON backup/import, portable Markdown archives, keyboard link completion, a reading view, explicit broken-link reconnect and a shared scratchpad. Reader storage upgrades preserve older writing, and a scoped return control links Reader copies to their source notes. Profile annotations now use scoped, revision-checked writes. See [Local Notes](features/LOCAL_NOTES.md) for storage boundaries, backup limits and unfinished acceptance work.

The candidate also scopes device-local Planner data to its server/account, retains competing or failed-save drafts, and replaces destructive imports with validated additive imports. Planner server sync is unavailable. Recurring calendar occurrences render with local-date handling and explicit whole-series editing. See [Local Planner](features/LOCAL_PLANNER.md).

The candidate also rejects damaged experimental encryption-registry state instead of silently resetting it, and removes cosmetic DM privacy modes that did not control encryption. Existing encrypted content is preserved; no operator-blind confidentiality claim is certified.

This candidate also contains the production-finish entry-page, mobile-panel and authentication repairs tracked in the [campaign ledger](plans/2026-09-15-production-finish-campaign.md). Candidate checks do not promote the deployed website, full workspace suite, native devices, self-host installation, restore procedure or physical-device calling to production-ready status.

## Available in the current main product line

### Communication and community

- Text channels, direct messages, group conversations, replies, typing/presence, guest access, roles, and owner/admin controls.
- Voice, video, and screen sharing with the existing Wabi call stack and optional TURN/SFU deployment support.
- Multi-server client/server switching while keeping each server an independent trust boundary.
- Custom server branding and a substantial theme/customization system.
- **Optional Translator Assist:** per-user on-demand and viewport-aware automatic message translation through local or explicitly chosen self-hosted LibreTranslate. It is disabled by default, bundles no language models, and does not proxy translation plaintext through the Wabi Authority.

### Workspaces and creative review

- Shared whiteboards and wiki/content surfaces.
- Dockable center-stage workspaces for communication and non-chat tasks.
- Long-form Reader workspace with search, outline, bookmarks/notes, continuous/paged reading, focus mode, and supported text/image imports.
- CAD/model review:
  - DXF read-only 2D viewing and markup;
  - DWG through an optional operator-provided `dwg2dxf` helper;
  - 3MF import into the normal 3D viewer;
  - STEP/STP/IGES/IGS import through OpenCascade WASM into the normal 3D viewer;
  - Model Space / Paper Space layout handling and detection of spatial model content.
- Lore project workspace with file/history/review/local-folder workflows when the optional external Lore integration is available.

### Platform and deployment

- One Rust `wabi-server` core containing the API, realtime services, embedded static frontend, and WabiDB.
- WabiDB as the in-process durable state engine; no external SQL/STDB database is required for the normal Authority deployment.
- Docker/Podman single-machine deployment.
- Tauri desktop source/build path.
- Optional coturn, LiveKit, SRT media gateway, Cloudflare tunnel profiles, and other helper services.
- Optional Tailcat private-access transport for supported desktop clients.
- Plugin package integrity/signing/scanning/audit machinery and runtime loading framework, with plugin mode opt-in.
- Local visual effects and sprite-sheet emote support.

## Experimental or incomplete

These exist in source or active development but must not be advertised as completed production guarantees.

### Multi-node / availability

- **Regional Anchor role:** a stateless Authority proxy exists, but native WebSocket upgrade forwarding is not complete. It is not a complete regional realtime edge.
- **WabiDB network replication:** transport/security work exists, but live projection convergence and safe writer/failover semantics are not proven. Network replication is explicitly experimental and disabled by default.
- **Warm standby:** encrypted envelope/storage groundwork exists, but there is not yet a production-safe live-state exporter/importer/promotion path. Automatic failover/election is intentionally disabled.
- **High availability:** Wabi does not currently claim production active-active, automatic Authority failover, or split-brain-safe multi-writer state.

### Clients and ecosystem

- Native phone clients are active work; Android/iOS release and physical-device acceptance are not yet a product guarantee.
- The runtime plugin framework is still being hardened. Operator-installed backend plugins should be treated as trusted code, not as safely sandboxed adversarial code.
- Broader profile/gaming/Steam work and additional social UX may exist on development branches; it is not a main-product claim until integrated and verified.
- Animated chat backdrops and other visual experiments may exist on branches without being part of the current release boundary.

### Calling

Calling works, but performance and correctness work continues across browser/native clients, reconnects, larger calls, screenshare, media transport, and real two-device/network acceptance. Synthetic/headful browser coverage is valuable but is not a substitute for physical-device certification.

## Explicitly not claimed today

- End-to-end encryption for DMs/private rooms.
- Operator-blind private content.
- Federation between independent Wabi servers.
- Global Wabi identities or a global username directory.
- Cross-server DMs implemented by servers talking to one another.
- Production active-active community state.
- Automatic backend failover / Authority election.
- Production-ready WabiDB peer replication or standby restore.
- A full CAD editor, parametric modeler, or authoritative DWG solid-model renderer.
- PDF/EPUB support in Reader unless/until those importers actually ship.
- Fully sandboxed untrusted plugins.
- A production-certified native mobile release.
- A built-in music streaming/catalog service. Music integration remains a rights/legal/product decision rather than something to bolt on casually.

## Privacy boundary

Wabi is privacy-oriented through self-hosting and minimized central dependence, but **self-hosted does not mean zero-trust**.

- The server operator controls the instance and can access server-readable content.
- DMs/private rooms are currently server-readable; E2EE design work is not a shipped encryption guarantee.
- Retention and confidentiality are separate. A message that is not retained after its configured lifetime is still visible to the server while it exists.
- Client-local preferences/effects/queues remain a different trust boundary from server state.
- Optional reverse proxies, tunnels, DERP relays, media services, external tools, and plugins add their own operators/software to the trust chain.
- Translator Assist does not use the Authority as a translation relay. A remote self-hosted translator is nevertheless another plaintext recipient for any text the user asks it to translate; localhost translation keeps that additional processing on the user's device.

See `PRIVACY_STANCE.md` and `SECURITY-MODEL.md` for detail.

## Release-readiness gates that matter most

The next meaningful confidence gains are not more feature-count checkboxes. They are proof that the existing product behaves correctly under failure and real use:

1. **WabiDB recovery** — keep restart/replay/crash tests green on the release candidate. The September 15 audit did not reproduce the previously unspecified regression; a real candidate backup/restore drill remains a separate gate.
2. **Backup/restore drill** — take a real stopped-server backup, restore it to a clean host, prove accounts/content/readiness, and document the exact supported compatibility boundary.
3. **Physical call matrix** — two real clients across representative networks, including reconnect, screenshare, audio routing, and optional TURN/SFU paths.
4. **Authorization audit** — continue endpoint/socket/admin permission review and preserve deny-by-default behavior for private resources.
5. **Desktop release checks** — platform packaging, upgrades, permissions, and sidecars on supported OSes.
6. **Mobile acceptance** — native build → emulator/device → network/media/background behavior before claiming mobile release readiness.
7. **Plugin trust boundary** — verify permission enforcement/sandbox expectations and make the UI/docs match what is truly isolated.
8. **Multi-node acceptance, later** — only call replication/standby HA after two-node convergence, restart catch-up, deletion semantics, passive-writer rules, Anchor realtime behavior, real export/import, and a tested manual promotion runbook all pass.

## Documentation rule

Use these labels consistently:

- **Available** — integrated into the current product line and has a real runtime path.
- **Optional** — available but requires explicit operator configuration or an external helper/service.
- **Experimental** — source exists, but correctness/release acceptance is incomplete and the feature should fail closed by default when safety matters.
- **Planned** — design or branch work only; do not describe it in present tense as a shipped capability.

When a feature crosses one of these boundaries, update this file, the root `README.md`, and the relevant architecture/deployment document in the same change.
