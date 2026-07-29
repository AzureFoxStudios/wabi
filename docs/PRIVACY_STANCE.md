# Wabi Privacy & Operator Responsibility Stance

> Informational positioning for docs/README. Not legal advice.
>
> **Current implementation status (2026-07-29):** Wabi DMs and private rooms are not end-to-end encrypted. Their text and attachments must be treated as server-readable. E2EE language in design documents is a future requirement, not a current product claim.

## Running a Wabi server means running a community — for real

There is no company upstream. No Trust & Safety team is coming. When you run a Wabi instance, *you* are the provider: your server, your community, your responsibility. Depending on where you live, that can include legal obligations most Discord server owners have never had to think about, because Discord handled it for them. Nobody handles it for you.

Choose moderators like it matters, because it does. A mod who doesn't know how to handle a serious report isn't a mod — they're a liability you appointed. Wabi ships the tools: reporting pipelines, evidence preservation, escalation guides. Using them is your job.

Private spaces currently rely on server access controls and transport encryption; the server operator may be able to read their contents. Public spaces are yours to govern. Govern them.

## Two independent privacy axes

Do not treat "encrypted" and "ephemeral" as the same property.

| Conversation type | Confidentiality | Retention |
|---|---|---|
| Default public channel | Server-readable | Memory-only (not retained by default) |
| Archived public channel | Server-readable | Timed or durable (owner-controlled key) |
| DM | Server-readable today; E2EE is unshipped | Policy-dependent |
| Private room | Server-readable today; E2EE is unshipped | Policy-dependent |

- **Ephemeral public chat** is operator-readable while live and not retained by default. It is *not* private from the server operator. Describe it as "ephemeral and not retained," never as operator-blind.
- **Only E2EE** hides content from the server operator. Merely avoiding disk writes does not accomplish that.
- **Persisted public channels and current DMs/private rooms** must be treated as operator-readable. A future E2EE implementation must keep client private keys outside the server-controlled key hierarchy.

## Regulatory note (accurate as of 2026-07-09)

The EU "Chat Control"/CSAM Regulation is **not enacted**. The Council adopted a negotiating position on 2025-11-26; the current text removes mandatory detection and states the regulation must not weaken E2EE, require decryption, or create access to E2EE data. A voluntary-scanning derogation expired 2026-04-03; on 2026-07-02 the Council proposed reinstating it through 2028-04-03, but Parliament has not approved, amended, or rejected it.

Wabi's privacy design does not depend on the regulation's status. The durable rule is: if the servers can decrypt private messages under normal operation, they can eventually be breached, abused, subpoenaed, or compelled. Design the capability out of the system rather than relying on policy promises.

## CSAM and abuse reporting

Wabi separates public and private spaces and gives operators the tools to act on a "punish the bad actor" model.

**Public spaces:** operators moderate, may use precise tools like hash matching (PhotoDNA/NCMEC lists) for public image uploads if they choose, and report criminals to law enforcement, who prosecute the individual.

**Private spaces (DMs / private rooms):** currently server-readable and not equivalent to a sealed letter. Do not promise operator blindness until an independently verified E2EE send/receive and attachment path ships.

**The software author:** responsible for building good tools, not for what strangers do with self-hosted instances. Publishing general-purpose, non-criminal-marketed encryption software has strong protection; that protection is strongest when Wabi does not operate servers and gives operators legitimate safety tooling.

Concrete commitments:
- User reporting is first-class; a report → quarantine → preserve → escalate pipeline is built into the admin panel.
- Optional hash-check integration is allowed for public channels only. Future E2EE spaces must remain outside server-side content inspection.
- No AI classifiers on private content. Do not build the hook.
- Evidence-friendly bans and public-space metadata retention support operator criminal referrals. Current DMs are not operator-blind.

## Deployment trust boundary

The Rust origin should bind to loopback or a private container network by default. Public exposure requires an HTTPS reverse proxy (Caddy, nginx, Traefik) or an encrypted tunnel. A tunnel solves reachability and transport encryption; it does **not** create E2EE. Current DM contents remain inside the server/transport trust boundary.

Production checklist:
- Origin port not published to `0.0.0.0` publicly by default.
- Separate development and production Compose profiles.
- External `wss://` required; secure cookies.
- Clear proxy-header trust documentation.
- Startup warning or refusal when explicitly configured for public insecure operation.

## Acceptance tests before any privacy claim

1. Memory-only canary: a unique string produces zero durable-storage writes.
2. Restart: memory-only messages disappear after restart.
3. Persistence: an opted-in public message survives restart and is readable by the server.
4. DM downgrade: the server rejects plaintext submitted to a DM.
5. Server-blind: database contents plus all server keys cannot decrypt a DM.
6. Attachment: stored DM blobs are ciphertext, unrecognizable by file signature.
7. Logging: canary plaintext does not appear in logs, traces, errors, or metrics.
8. Key-change: replacing a device key produces a visible warning.
9. Retention: expired content disappears from projections, media, indexes, and eventually backups.
10. Network: production configuration exposes only the TLS endpoint.
