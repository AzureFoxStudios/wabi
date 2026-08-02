# Wabi Bot Platform Design (research-backed)

**Date:** 2026-08-01  
**Status:** Locked design for post-showcase Wave 13. Not a showcase blocker.  
**Kanban cards:** H0 (design done), H1a/H1b/H1c on `docs/showcase-prep-kanban.md`  
**Related:** Hermes stretch gateway, `wabi-webhooks` addon, existing ban/mute admin tools.

---

## 0. Current state (verified against source)

| Surface | Reality |
|---------|---------|
| `User` domain | Human-only. Fields: username, handle, color, password_hash, is_registered, is_active, profile, bio, status. **No `is_bot`, no bot token.** (`core/crates/wabidb/src/domain/mod.rs`) |
| Webhook domain | Stored: `webhook_id, channel_id, name, url, created_*`. Projection `webhook_upserted` exists. |
| Webhook delivery addon | **Stub.** `core/addons/webhooks/backend/src/lib.rs` logs `Would deliver to webhook` — no HTTP POST, no retries. |
| Bot API routes | **None.** No `/api/bots`, no bot auth middleware. |
| Operator secret | `/api/operator/*` + `x-operator-secret` + loopback — break-glass admin, **not** a bot identity. |
| Moderation | `ban_user` / `mute_user` adapter methods + file blacklist (`docs/BAN_SYSTEM.md`). Human/admin path; not bot-callable as product. |
| Admin UI | Automod/webhooks sections exist in mocks/audits as UI-without-API. |

**Conclusion:** Wabi has storage sketches and human mod tools. It does **not** have a bot platform. Building bots well means platform first, Hermes second.

---

## 1. Identity decision (locked)

| Pattern | Verdict | Why |
|---------|---------|-----|
| **Bot account** | **Default** | Industry standard (Discord/Slack/Telegram/GitHub/Matrix). Named agent, distinct avatar, @mentionable, scoped perms, auditable, team-visible. Transparent that it is software. |
| Specialized DM | Secondary only | OK later if a *user explicitly starts* a private chat with the bot. Bad as primary surface (doesn't scale, feels like a side-channel, hard to audit for teams). |
| User impersonation | **Never** | Posts with a human's credentials. Privacy/security failure; not acceptable in AI-coder communities. |
| Webhook-only (no bot user) | Incomplete alone | Fine for CI "post this string to #deploys". Insufficient for a collaborator (no @mention, no reactions, no thread reply, no mod actions). Keep as *secondary* passive path. |

### Kosher norms (AI-coder / community ops standard)

1. **Transparent identity** — BOT badge, distinct avatar, never silent/hidden.
2. **Least privilege** — scopes, not "admin by default". Channel membership required for channel events.
3. **Human-in-the-loop** on bulk/destructive actions (mass ban, wipe, role grant storms).
4. **Full audit trail** — bot actions are first-class messages/events with actor = bot user id.
5. **No silent DM reading** — bots never auto-watch DMs; E2EE keys never exposed to bots.
6. **Reason required** for moderation actions (ban/mute/kick must carry a non-empty reason string).
7. **Rate limits** stricter than humans for write paths.
8. **Revocable** — owner/admin can rotate token or disable bot without deleting history.

---

## 2. Language / protocol (locked)

**Discord is not Python-only.** Discord bots speak HTTP REST + Gateway WebSocket. Official and community libraries exist for Python, JS/TS, Go, Rust, Java, C#, Ruby, etc. Python is popular (`discord.py`), not a platform rule.

**Wabi rule:** protocol = **HTTP JSON + bot token** (and later the same Socket.IO/event stream humans use, filtered by membership). Any language that can POST JSON is first-class. Optional SDKs later (TS/Python first if demand) — never required. No "only Python because web."

---

## 3. Platform model (three layers)

Do not mix these:

| Layer | Responsibility | Owner |
|-------|----------------|-------|
| **1. Platform** | `is_bot` user, bot token auth, scopes, rate limits, BOT badge, audit actor | Wabi core |
| **2. Delivery** | Outbound event HTTP POST (finish webhook stub); inbound bot can post/read as itself | webhooks addon + thin bot routes |
| **3. Automation** | Auto-mod rules, scheduled posts, ban-reason templates, welcome messages | External bots *or* optional built-in automod later |

Hermes H1 is a **consumer** of layers 1+2, not a special core path.

### Scopes (v1)

Grant explicitly; default deny:

| Scope | Allows |
|-------|--------|
| `messages:read` | Read messages in channels the bot is a member of |
| `messages:write` | Post/edit/delete **own** messages in those channels |
| `channels:list` | List channels the bot can see |
| `moderation:mute` | Mute with required reason (calls same path as human mod tools) |
| `moderation:ban` | Ban with required reason (same path as human tools + audit) |
| `roles:assign` | Assign/remove roles the bot is allowed to manage (optional, later) |

**Never in v1:** E2EE DM keys, global message search across unjoined channels, impersonate user, operator/break-glass routes, silent presence fabrication.

### Auth

- Bot token = long random secret, stored hashed server-side, shown once at create/rotate.
- Header: `Authorization: Bot <token>` (or `Bearer` with token type claim — pick one and document).
- Distinct from human JWT/password login. Bots do not use password_hash login UX.
- Token bound to one bot user id + scope set + optional allowed-channel allowlist.

### Auto-send / auto-ban (product answers)

| Capability | Allowed? | Guard |
|------------|----------|-------|
| Auto-post channel messages as the bot | Yes | `messages:write` + membership + rate limit |
| Scheduled / cron posts | Yes | Same; Hermes/external scheduler owns timing |
| Auto-ban / auto-mute with reason | Yes | Explicit mod scope + non-empty reason + audit log + optional mod-log channel post |
| Ban without reason | **No** | API rejects empty reason |
| Auto-DM all members | **No** | Out of scope forever for v1; spam vector |
| Silent scrape of DMs / private content | **No** | Never |
| Call same admin tools humans use | **Yes — preferred** | Bots should not reinvent a second admin plane; they call ban/mute/role APIs under bot identity |

Wabi's advantage: admin tools already exist as product. Better bots = same tools via API under a bot actor, not a parallel control plane.

---

## 4. Card split (implementation order)

### H0 — Design lock (this document)
Done when this file is accepted and kanban points here.

### H1a — Bot identity + token auth (platform foundation)
- Add `is_bot: bool` (default false) on `User` (+ migration/projection/serde).
- Bot create/list/rotate/disable admin API (owner/admin only).
- Token mint + hash store; auth middleware accepts bot token → `AuthUser` with bot flag.
- Frontend: BOT badge on messages/member list when `is_bot`.
- **No Hermes-specific code.** Any bot can use this.
- Verify: create bot, mint token, `GET /api/user/me` (or bot-me) returns bot identity; human JWT path unchanged.

### H1b — Delivery (inbound post + outbound webhooks)
- Finish webhook delivery: real HTTP POST, secret header, basic retry, drop stub log-only path.
- Bot can `POST` message to a channel it is in (`messages:write`).
- Outbound events at minimum: `message.created`, `message.updated` (optional), filtered by bot channel membership for bot subscriptions; channel webhooks stay channel-scoped.
- Incoming channel webhook (CI dumb post) remains secondary and separate from bot identity.
- Verify: external process with bot token posts a visible message; channel event hits a registered webhook URL.

### H1c — Hermes as one bot + optional mod scopes
- Register `hermes-bot` (or user-chosen name) via H1a APIs.
- Hermes gateway deliver target posts as that bot (same shape as Discord/Telegram home channel).
- Outbound: @mention bot / reply in shared channel → Hermes receive URL.
- Optional: grant `moderation:ban|mute` only if owner opts in; ban/mute must include reason and write audit + optional mod-log message.
- DM path: still out of scope unless user explicitly opens DM with bot later.
- Verify: Hermes cron/dispatch lands in-channel as bot; @mention reaches Hermes.

### Later (not H1)
- Built-in automod rule engine (convenience; external bots stay first-class).
- Slash commands / interaction framework.
- Full event gateway (Socket.IO bot mode).
- SDKs.
- Steam-style rich presence for bots.

### Defer / stop rules
- If H1a needs more than bot flag + token + auth middleware + badge → stop and redesign.
- If H1b needs a new database engine or new realtime protocol → park.
- If H1c needs Hermes-only core forks (special-case routes only Hermes can use) → reject; Hermes must be a normal bot.
- Balloon → W12 **S4 Bot platform (full)** / **S5 Hermes gateway (full)**.

---

## 5. Security checklist (acceptance bar)

Before any bot card is "green":

- [ ] Bot token never logged in plaintext
- [ ] Token shown once; rotate invalidates old
- [ ] Scopes enforced server-side (not UI-only)
- [ ] Moderation requires reason; empty reason = 400
- [ ] Bot cannot escalate its own scopes
- [ ] Bot cannot read channels it is not in
- [ ] Bot cannot call `/api/operator/*`
- [ ] Rate limits on bot write paths
- [ ] Audit log records actor_user_id = bot
- [ ] Disable bot instantly stops auth
- [ ] No E2EE/private key material in bot payloads
- [ ] Webhook outbound uses signing secret; reject weak open URLs in admin UX warnings
- [ ] Docs state language-agnostic HTTP; no Python-only assumption

---

## 6. Research notes (short)

- **Discord:** Bot users + bot token; intents/scopes; privileged intents opt-in; audit log for mod actions; language-agnostic HTTP/WS.
- **Slack:** Bot users + OAuth scopes; incoming webhooks separate from bot tokens; least privilege.
- **Telegram:** BotFather tokens; bots cannot start groups the same way users do; clear bot identity.
- **Matrix:** Application services / bots as users with mxid; explicit registration.
- **GitHub:** GitHub Apps (installation tokens, fine-grained perms) preferred over personal PATs for automation — same lesson: **app/bot identity ≠ human PAT**.

Wabi aligns with: bot user + token + scopes + audit + language-agnostic HTTP. Avoid: human token reuse, Python-only, webhook-as-only-bot-model, silent superuser bots.

---

## 7. Showcase posture

Wave 13 is **stretch after W0–W11 green**. Showcase story does not depend on Hermes-in-Wabi. If bots become a showcase talking point later, H1a+H1b must ship first; H1c is the demo glue.
