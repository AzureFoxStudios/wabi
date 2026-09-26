# Wabi Project Status

**Updated:** 2026-09-26

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

## Friends and direct message repair — deployed on Tim, pending phone acceptance

The `codex/friends-dm-release-20260925` branch adds server-local friend requests
and accepted friendships, plus direct message room, fanout and history repairs.
The friend relationship is a durable Authority record; it does not grant access
to a DM. The tested release binary and embedded static frontend were deployed
to Tim on 2026-09-25. A disposable two-account browser test covered desktop,
mobile viewport and embedded PWA queue/reconnect behavior; the public page,
health endpoint and realtime handshake passed after deployment. Physical phone
acceptance remains pending, and this branch has not been merged into `main`.
See [the rebuild contract](plans/2026-09-25-friends-and-dm-rebuild.md).

The 2026-09-25 follow-up (`7cfed649`) is also live on Tim. It makes People
menus, profile and friend actions usable by mouse and touch, fixes mobile
navigation into a full direct message view, and adds a center-stage group chat
with creation, membership controls and older-history loading. Timed retention
changes now affect only messages sent afterward; the five-second policy sweeps
quickly without deleting earlier history, and the message timer and room badge
have been refreshed. The follow-up passed disposable two-account browser and
installed-PWA flows, group and retention regressions, and public health/page/
realtime checks. Physical-phone acceptance is still pending. Live mode can
temporarily hide older durable history while selected, and messages deleted
before this repair cannot be recovered.

The 2026-09-26 follow-up (`88db86a7`) is live on Tim. It fixes the realtime
startup race and installed-PWA delivery through HTTP polling, makes Friends
requests and notices visible, keeps DM previews current, and refines the
DM/group layout and per-message timer badge. A disposable two-account browser
run covered phone-sized installed PWAs, offline replay, friends, group and DM
messages, and 30-second to 24-hour to 5-second retention changes. The exact
release passed a fresh embedded-build smoke check; Tim's public page,
health/readiness and Socket.IO polling probes passed after the swap. Physical
phone acceptance remains open.

### Experimental conversation encryption — deployed on Tim

The Tim release branch adds an experimental default for newly created DMs and
groups. Each new room starts encryption-pending. Registered participants'
clients create device keys, and the room can switch to encrypted text only
after every participant has a registered device. The Authority rejects
plaintext sends while encryption is pending. A participant can explicitly
choose server-readable chat instead; that choice stops automatic enablement,
and **each sender** must confirm server-readable mode before sending plaintext.
The original rollout left earlier rooms in their previous mode. Damaged
encryption-registry state blocks sends and key changes
instead of silently resetting. The cosmetic “Sealed / Private / Open” menu no
longer appears as a security control. This rollout remains under acceptance
testing, including physical phones, and is **not an independently verified
E2EE or operator-blind guarantee**. See [the privacy stance](PRIVACY_STANCE.md)
for the trust boundary.

The 2026-09-26 follow-up (`e2639368`) is live on Tim. It registers signed-in
browser devices and upgrades **future messages** in older readable rooms to
experimental encryption once every participant has a registered device, unless
an explicit server-readable choice is in force. Historical plaintext remains
server-readable. This branch is not merged; physical-phone acceptance and
independent E2EE verification remain open.

### Shared conversation notes — deployed on Tim, pending phone acceptance

`codex/dm-call-notes-followup-20260926` adds a collapsed-by-default Shared notes
panel for DMs and groups. Saved notes use a separate Authority-backed store,
membership checks, author-only updates and revision checks, with live refresh
for recipients. Existing personal browser Notes remain private and are not
uploaded automatically. Readable rooms store readable notes; experimental
encrypted rooms store signed ciphertext envelopes and pending rooms reject
plaintext. Shared notes outlive message timers until removed or the room is
deleted, and Authority data-directory backups include them. The 2026-09-26
follow-up is live on Tim but not merged. See [Local Notes](features/LOCAL_NOTES.md)
for the detailed storage and backup boundary.

The exact release binary SHA-256 is
`57452407550d192214e6d4362325b84b689aea169a508f9e0e0ce0e2b87e565c`;
its embedded PWA build ID is `bc3da61ab7d3546f`. Tim was stopped for a full
data/uploads/config/binary backup at
`/home/tim/wabi-backups/authority-20260926-dm-call-notes-followup` before the
swap. Disposable two-account tests covered encrypted shared-note delivery and
reload, default-relay DM/group camera frames, and two controlled phone PWAs
exchanging durable messages, including HTTP polling and offline replay. Tim
origin and public readiness, application shell, protected note/admin routes,
realtime polling, and the Lore addon passed after restart. Physical devices
remain an acceptance gate.

## Production-finish candidate — not yet merged or deployed

`codex/production-finish-20260915` adds account/server-scoped local Notes with transactional saves, independent editor drafts, conflict recovery, trash, titled wiki-links/backlinks, explicit legacy recovery, JSON backup/import, portable Markdown archives, keyboard link completion, a reading view, explicit broken-link reconnect and a shared scratchpad. Reader storage upgrades preserve older writing, and a scoped return control links Reader copies to their source notes. Profile annotations now use scoped, revision-checked writes. See [Local Notes](features/LOCAL_NOTES.md) for storage boundaries, backup limits and unfinished acceptance work.

The candidate also scopes device-local Planner data to its server/account, retains competing or failed-save drafts, and replaces destructive imports with validated additive imports. Planner server sync is unavailable. Recurring calendar occurrences render with local-date handling and explicit whole-series editing. See [Local Planner](features/LOCAL_PLANNER.md).

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

- Independently verified end-to-end encryption for DMs/private rooms.
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
- New DMs/groups in the Tim rollout begin encryption-pending and may move to experimental encrypted text after participant devices are ready. Updated clients also upgrade future messages in older readable rooms when all devices are ready, unless server-readable mode was explicitly selected; historical plaintext remains readable. Explicit server-readable fallback needs each sender's confirmation. First-seen device keys come from the Authority, and the full client/protocol has not been independently verified.
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
