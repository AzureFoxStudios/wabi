# Wabi Privacy and Operator Responsibility

**Status:** current product/privacy boundary  
**Updated:** 2026-09-16
**Not legal advice.** Laws and operator obligations vary by jurisdiction.

Wabi's privacy model starts with **self-hosting and explicit trust boundaries**, not with the claim that the server cannot see anything.

A Wabi community chooses its own server and operator instead of being required to put community data into a central Wabi service. That is meaningful privacy and autonomy — but the operator is still part of the trust model.

## The short version

- Wabi does not require a central Wabi account or global identity service.
- Independent Wabi servers do not federate or share account databases.
- The server operator controls the instance and its durable data.
- **DMs and private rooms are not end-to-end encrypted today. Their text and attachments must be treated as server-readable.**
- Retention and confidentiality are separate. “Deleted later” or “not written to disk” does not mean “hidden from the server.”
- Optional proxies, tunnels, DERP relays, media services, external tools, and plugins add their own trust boundaries.

## Self-hosting changes who is trusted

When you run a Wabi server, you are operating a community service for the people who use it. There is no upstream Wabi Trust & Safety team moderating your instance, recovering your data, or making local legal/compliance choices for you.

That means operators should:

- choose owners/admins/moderators carefully;
- protect server secrets and backups;
- understand which optional providers can observe traffic or metadata;
- keep software updated and review plugins before enabling them;
- define retention/moderation rules appropriate for the community;
- understand any legal obligations that apply where they operate.

Wabi should provide useful moderation, reporting, audit, export, and recovery tools without pretending the software author operates the community.

## Confidentiality and retention are different axes

| Space / state | Confidentiality today | Retention |
|---|---|---|
| Live/ephemeral public chat | Server-readable while live | Not durably retained by that mode |
| Timed public chat | Server-readable | Visible until expiry/deletion; underlying event records and backups may remain |
| Forever/archived public chat | Server-readable | Visible until explicitly deleted; underlying event records and backups may remain |
| DM | **Server-readable; E2EE unshipped** | Policy/implementation dependent |
| Private/group room | **Server-readable; E2EE unshipped** | Policy/implementation dependent |
| Presence/typing/transient call state | Server/runtime-visible | Intended to be transient |
| Client-local preferences/effects | Device-local unless a feature explicitly syncs them | Local lifecycle |

A memory-only message can still be read by the server process while it exists. Call it **ephemeral/not retained**, not “private from the operator.”

The current Authority deletion path writes a deleted message record; it does not purge the original event history. Timed retention uses the same logical deletion path. Database event history is distinct from rotating diagnostic log files. A UI disappearance, a retention timer firing, or routine log rotation is not evidence of secure erasure. Attachment files, explicit report evidence, browser caches, exported copies and backups have separate lifecycles.

Only a correctly implemented end-to-end encrypted path can remove the server operator from the content-confidentiality boundary.

## E2EE is a future acceptance project, not current marketing

Wabi contains encryption/security design work, but the current DM/private-room send path is not an independently verified E2EE system.

Before Wabi can claim operator-blind private messaging, tests must cover at least:

1. plaintext is never accepted/stored as the private-message payload;
2. server data plus server-held keys cannot decrypt message content;
3. attachments are encrypted end to end as well as message text;
4. device/key changes produce a visible security event;
5. multi-device and recovery behavior does not quietly escrow private keys to the server;
6. plaintext does not leak into logs, traces, errors, search indexes, previews, moderation hooks, or backups;
7. downgrade to plaintext cannot happen silently;
8. retention/deletion semantics are defined for ciphertext, keys, attachments, indexes, and backups.

Until that entire path ships and is verified, docs and UI must say **server-readable**.

### Experimental registry and recovery boundary

The candidate retains the existing encrypted-envelope and attachment mechanisms; it does not convert existing ciphertext to plaintext. A room's registry flag reports `experimental_e2ee`, not verified operator-blind confidentiality. The separate DM “Sealed / Private / Open” menu was a device-local label with no connection to message encryption and is no longer presented as a security control. Existing stored preferences are left untouched.

Unreadable, malformed or incomplete `e2ee_state.json` now blocks registry changes, enabled-room privacy lookup and outbound message validation rather than treating damaged state as an empty registry. The file remains intact for recovery. Restore it with the matching stopped Authority backup; do not delete it to clear the error. An absent registry still represents a fresh installation, so deleting the file cannot be distinguished from never having enabled encryption. This check does not prove resilience to a malicious operator, rollback to an older valid registry, or the full E2EE acceptance checklist above.

## Independent servers, not federation

A Wabi client can save and switch among multiple Wabi servers. Each server has its own accounts, roles, data, operator, and security policy.

There is no global username registry and no server-to-server identity graph. Two accounts with the same handle on two servers are unrelated unless the user/client deliberately presents them together.

Any future cross-server friend convenience should remain client-owned/non-federated unless Wabi intentionally adopts a new protocol and threat model.

## Optional infrastructure changes the trust chain

### Reverse proxies and tunnels

A reverse proxy, VPS, or Cloudflare Tunnel can hide the origin or simplify HTTPS. It does not create E2EE. Depending on configuration/provider, it may observe connection metadata or terminate TLS.

### Tailcat / DERP

Private-access transport solves reachability. It does not grant Wabi membership and it does not make current DMs operator-blind. Public DERP relays are an additional infrastructure provider; operators can choose self-hosted relay infrastructure when that matters.

### TURN / SFU / media helpers

TURN, LiveKit/SFU, SRT gateway, and other media helpers handle some portion of media transport when enabled. Their deployment/operator becomes part of that transport's trust/metadata boundary.

### External integrations

Lore, optional CAD conversion helpers, future game/service integrations, and similar features should be treated as separate tools with their own permissions and data flows. A feature being inside Wabi's UI does not erase the external system's trust boundary.

### Plugins

Runtime backend plugins are operator-installed code. Checksums, signatures, scanning, audit logs, and declared permissions reduce risk, but until the sandbox/permission boundary is independently proven, do not treat an arbitrary backend plugin as hostile code that Wabi can safely contain.

## Local-first customization

Wabi deliberately keeps some customization device-local. Local visual effects, imported pointer textures/shaders, and similar preferences should not require uploading personal assets to the community server merely to customize one user's client.

Local does not automatically mean secret from the local machine user/OS; it means the feature does not need server persistence unless explicitly designed otherwise.

## Deployment trust boundary

For public deployments:

- expose Wabi through a properly configured TLS endpoint or encrypted private-access path;
- keep loopback/operator-recovery interfaces private;
- do not expose experimental sync/standby mutation surfaces as ordinary public APIs;
- keep secrets/backups outside world-readable paths;
- use `/livez` for process liveness and `/readyz` for application readiness;
- treat plugins and optional helper services as additional attack surface.

See [NETWORKING.md](NETWORKING.md), [SECURITY-MODEL.md](SECURITY-MODEL.md), and [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md).

## Moderation and abuse handling

Self-hosting does not mean “no rules.” Operators need tools to act on abuse in the spaces they control.

Product principles:

- user reporting and incident handling should be first-class;
- moderation should be attributable and auditable where practical;
- public/server-readable content can support operator moderation according to the server's policy;
- future true E2EE spaces must not quietly gain a server-side content classifier/backdoor;
- evidence preservation/export should be explicit rather than an invisible universal surveillance mode;
- already delivered content cannot be magically recalled from another user's device.

## Data recovery is part of privacy

A privacy-respecting system that loses its encryption key or corrupts the only copy of community data is still a bad system.

Operators should take protected backups of `data/wabi-server/`, uploads, and externally managed secrets and periodically prove those backups can be restored. Experimental replication/warm standby is **not** a replacement for backups today.

See [deployment/BACKUP_AND_RECOVERY.md](deployment/BACKUP_AND_RECOVERY.md).

## Durable privacy rule

Prefer removing unnecessary capability from the system over promising that a powerful capability will never be abused.

That means:

- no mandatory central Wabi service;
- no hidden global identity graph;
- no E2EE claim while the server can decrypt the content;
- no private-content AI scanning hook by default;
- no accidental experimental sync/write surface exposed as production infrastructure;
- no silent external-service dependency where an operator believes the deployment is fully local.
