# Live Rooms — Normative Contract

Status: locked design. Built against the coded mockup at `live-rooms-ui-mockup.zip`
(components: `ConnectionBar`, `LeaveModal`, `LiveChat`, `LiveEmptyState`,
`ChannelSettings` [Live tab], `ChatMessage` [age gradient], `ParticipantsPanel`).
This is the document to build and test against. Nothing here is a proposal.

---

## 0. Object definition

> **Live Room = voice semantics for text.**

A Live channel is a channel with `type: "live"` (Rust: `ChannelKind::Live`, or the
existing retention sentinel `autoDeleteAfter === "live"` — see §7). Messages are
**never persisted to WabiDB**. They exist only in the server's in-memory
`session_messages` buffer for the channel, fan out to currently-connected members,
and die by per-message TTL or hard cap — whichever first.

Two invariants the whole design rests on:
1. **Memory is bounded by `min(rate × TTL, cap)` regardless of room lifetime.**
   Camping / never-empty / idle-hold can NOT blow memory. This is the property that
   makes clear-on-empty wrong and TTL+capped-window correct.
2. **The server is the source of truth for what is alive. The client is the source
   of truth for what it shows.** Server decides eviction; client decides render
   window (weaker-machine setting). They disagree by design and that is fine.

---

## 1. States (per member, per live channel)

```
        ┌─────────────┐
        │    Out      │  not joined; sees nothing; no local scrollback held
        └──────┬──────┘
       explicit Join (click "Join Live")
               │
               ▼
        ┌─────────────┐  receive messages while joined; sticky bar present
        │   Joined    │  navigate away = STILL Joined (bar persists)
        └──────┬──────┘
   no interaction for grace window OR
   socket drops & not re-established within reconnect grace
               │
               ▼
        ┌─────────────┐  soft-detached from live buffer; rejoin is fresh;
        │    Grace    │  no "fresh join" event, no AFK line (silent)
        └──────┬──────┘
   reconnect within grace ──► back to Joined
   grace expires ──► back to Out (local scrollback cleared)
               │
   Any state ◄── explicit Leave ──► Out
        (Leave = clear local scrollback; reopen shows only still-alive buffer)
```

### AFK sub-state (orthogonal to the above)
- `active` | `afk` | `you`. AFK is **status only, never a kick** (text rooms).
- Entering AFK: optional system line `"<user> is AFK"` + moon chip on avatar.
- Leaving AFK: optional system line `"<user> is back"` + chip removed.
- Gated by: channel/server AFK-announce toggle (default **ON**), rate-limit, and
  "only after was-active" (don't announce AFK for someone who never sent anything).
- Firehose rooms can disable announce via toggle so the channel isn't drowned.

---

## 2. Events (server → client)

| Event | Trigger | Payload | Notes |
|---|---|---|---|
| `live-message` | message sent to a live channel | full message view | fanout to all Joined members of that channel |
| `message-deleted` | TTL expiry OR cap eviction | `{ channelId, messageId }` | clients animate out / ghost |
| `live-join` | member transitions Out→Joined | `{ channelId, userId }` | system line only if announce on; NOT for grace-rejoin |
| `live-leave` | member Out (explicit or grace expiry) | `{ channelId, userId }` | system line only if announce on |
| `presence-afk` / `presence-back` | AFK sub-state change | `{ channelId, userId }` | gated by announce toggle |
| `live-count` | member count changes | `{ channelId, count }` | drives "N people live right now" |
| `live-buffer-snapshot` | on Join (and grace-rejoin) | last `min(serverCap, clientWindow)` alive messages | see §4 — what you see on open |

---

## 3. Server guarantees (what the server MUST hold)

1. **No durable write.** `send_message` for a live channel MUST NOT call
   `wdb.send_message`. (Already proven by `live_session_room_contract` test.)
2. **Per-message TTL.** Every live message carries `born_at = server_now`. A
   reaper task walks `session_messages[channel]` and evicts any message with
   `now - born_at >= ttl_ms(channel)`. On evict → emit `message-deleted`.
3. **Hard count cap.** `len(session_messages[channel])` never exceeds
   `cap(channel)`. On overflow, evict oldest first (and emit `message-deleted`).
4. **Empty-room drop is an optimization, not a contract.** When the last member
   leaves, the server MAY drop the buffer; it is NOT required to. Memory is already
   bounded by TTL+cap, so emptiness is irrelevant to safety. (This is the explicit
   fix for the never-empty / camping problem: we do NOT depend on rooms emptying.)
5. **TTL precedence over cap.** A message that expires by TTL is removed even if
   under cap. Cap only bounds the *live* window size.
6. **Restart = total poof.** Single-process only (see §6). No WAL, no replay.

---

## 4. What you see on open (Join behavior)

- **Show still-alive server window.** On Join (and grace-rejoin) the server sends
  `live-buffer-snapshot` = the messages currently alive (not yet TTL-expired),
  capped at `min(serverCap, clientRenderWindow)`.
- Strict join-point (see literally nothing) was considered and **rejected** for the
  busy-room case — walking into a live lobby to a blank screen feels broken, and
  those messages are going to poof on their own anyway.
- Client render window is a **per-client local setting** (weaker-computer support),
  NOT sent to server as a filter by default. See §5 for the server-side option.

---

## 5. Weaker-client / client authority

Two distinct caps, must not be conflated:

- **Server cap** (`cap(channel)`): how many messages the server holds in RAM and
  fans out. Protects the host. Admin setting.
- **Client render window** (`clientRenderWindow`): how many messages a given browser
  keeps in the DOM. Protects the user's machine. Per-client local setting
  (e.g. 100 / 250 / 500). Pure frontend trim; default e.g. 250.

Privacy/weak-client note: with only a client render window, the server still *sent*
the full alive buffer. A truly bandwidth-constrained client MAY request
`"send me last N only"` server-side (optional future flag). That is a bandwidth
optimization, not a correctness requirement. Client A rendering 500 and Client B
rendering 50 disagreeing about "what's in the room" is **harmless** as long as no
shared-state action (reply-to, moderation-on-visible) depends on a unified view.
Live rooms SHOULD NOT expose reply-to-a-specific-message or moderation-on-visible
that assumes shared scrollback; if they do, that action must target the message id,
which may already be dead on the server (handle "message gone" gracefully).

---

## 6. Multi-node / restart semantics (scope boundary)

- **Single-process is the contract for v1.** Restart = total poof, honestly.
- If/when multi-node: `session_messages` is either
  - (a) sticky-session local → live room buffer splits by node; reconnect to
    another node = different (empty) buffer; or
  - (b) shared ephemeral store (Redis) → now it's "ephemeral store," not
    "memory only," and restart poof depends on that store's persistence.
- **Decision deferred.** v1 does NOT support horizontal scale for live rooms.
  Documented as a known limitation, not a hidden one.

---

## 7. Channel kind vs retention sentinel (implementation note)

The mockup uses `type: "live"`. The current Rust backend keys Live off the
existing in-memory `channel_auto_delete_label` map with the `"live"` sentinel
(proven, avoids the postcard replay-break that a new `Channel` field would cause).
**Keep the sentinel approach for v1.** A real `ChannelKind::Live` is the eventual
clean form but requires a WabiDB domain change + migration + dual-decode (the
replay-break class of risk). Not worth it while the sentinel works. The contract
does not care which mechanism backs `type: "live"`.

---

## 8. Attachments lifecycle (the real disk lie)

Text in RAM is cheap; blobs are not. Rules:

1. A live attachment **dies with its parent message** — same TTL, same cap eviction.
   When `message-deleted` fires, the server deletes the blob bytes.
2. **Separate blob budget**, coupled to the message TTL in practice: large files
   uploaded on a short cycle can still thrash disk/bandwidth even if count-capped.
   Mitigations (all admin-configurable, free-typed durations/sizes):
   - `attachmentMaxSize` per live channel (mockup default `8 MB`)
   - optional `attachmentMaxPerWindow` rate (e.g. N MB per TTL window)
   - blob store TTL = parent message TTL (no independent long-lived blob)
3. **Object-store delete is eventually consistent.** "Poof" for blobs is a promise
   the server makes by issuing the delete; the underlying store may retain briefly.
   Acceptable for ephemeral rooms; document it. Live rooms are not a compliance
   boundary.
4. v1 scope: **block attachments in live rooms OR strictly cap them.** The mockup
   shows an attach icon but also an `attachmentMaxSize` setting — implement the cap,
   not a hard block. (Earlier plan Task 6 "block attachments" is relaxed to
   "strictly cap" per this contract.)

---

## 9. Reconnect grace (admin-defined)

- `reconnectGrace` is an admin/server setting, free-typed duration (mockup default
  `60s`). Shipped with a sensible example in config template; hosts have full
  control in OSS. No magic product default forced on hosts.
- While within grace after a socket drop: member is `Grace`, not `Out`. Reconnect →
  `Joined` silently (no fresh join event, no AFK line). Grace expiry → `Out`,
  local scrollback cleared.
- **Presence-level idle eviction is separate from message TTL** (see §10). Grace is
  about *transport* drops; idle eviction is about *presence* cost.

---

## 10. Presence / connection-cost abuse (the other memory vector)

TTL bounds the *message buffer*, but presence itself costs: websocket slots,
presence fanout, typing indicators, reconnect storms. A botnet of idle tabs does
not blow the message buffer — it blows **connection capacity**.

- **Idle presence eviction:** no interaction (send / react / typing) for
  `idleTimeout` → transition to `Grace`-like soft-detach from the live buffer
  (rejoin is fresh). Separate from message TTL. Admin-configurable.
- This is the answer to "malicious keep-alive": holding a tab open costs a slot;
  an idle slot is soft-ejected, so a squatter consumes at most one connection and
  no message memory. Flooding messages is bounded by cap + rate-limit.

---

## 11. Settings surface (canonical, from mockup `ChannelSettings` Live tab)

All durations **free-typed strings** (`5s`, `45s`, `2m`, `10m`, `1h`), presets are
shortcuts only. Per-channel, override-able by server default.

| Setting | Mockup default | Scope | Meaning |
|---|---|---|---|
| Message TTL | `10m` | per-channel, server default | per-message lifetime from send |
| Message count cap | `1000` | per-channel, server default | hard ceiling on server-held msgs |
| AFK announce | ON | per-channel/server toggle | post `X is AFK` / `X is back` |
| Reconnect grace | `60s` | server (admin) | rejoin-without-fresh-join window |
| Attachment max size | `8 MB` | per-channel | blob dies with message TTL |
| Client render window | (local, e.g. 250) | per-client | DOM trim for weak machines |

**Admin-configurable cap? Yes** — both TTL and count cap are admin settings
(server default + per-channel override). Confirmed.

---

## 12. UI contract (from mockup, must hold in the real SvelteKit port)

- **Sticky `ConnectionBar`** whenever `Joined`: shows `Connected` + room name +
  signal bars + a persistent **Leave** button. Always present while Joined,
  including when browsing other channels. Navigating away does NOT leave.
- **Leave** opens `LeaveModal`: "Your local scrollback for this visit will clear.
  You can rejoin anytime — you'll only see messages the server still has alive."
- **LiveEmptyState** when `Out`: "Join Live" CTA, live preview avatars (NO message
  content leaked), "N people live right now", "Be here now… Nothing is saved."
- **Fade-by-age**: messages render with a 4-stage `age` gradient
  (`msg-aging-1..4`) and a hover "fades in Xm" hint. Server sends `born_at`;
  client computes age locally (clock-skew tolerant — see §13).
- **ParticipantsPanel**: shows `active` / `afk` / `you` with moon chip for AFK.
- **AFK announce** default ON; toggle in settings; chip always shows regardless.

---

## 13. Clock-skew & mid-read poof (the consistency caveats)

- **Age is computed client-side from `born_at` (server timestamp).** Each client
  shows its own fade gradient; minor skew only shifts when a message *looks* about
  to die, not whether it's legally alive. The server's eviction is authoritative
  for removal.
- **Mid-read poof:** when `message-deleted` arrives, the client **animates the
  message out** (ghost/fade), does NOT block reply (reply not a live-room feature),
  and any in-flight reply to a now-dead id is rejected with "message no longer
  live." No orphan replies.
- **Reactions/threads/edits on a dying message:** live rooms SHOULD NOT have these
  in v1. If added later, the entire interaction graph must die with the parent
  (server deletes children on parent eviction).

---

## 14. Test matrix (what must be proven)

Backend (`live_session_room_contract` extended):
- [x] live message never written to disk (existing test)
- [ ] live message evicted after TTL → `message-deleted` emitted, buffer shrinks
- [ ] cap overflow evicts oldest → `message-deleted` emitted
- [ ] setting a channel live via `update-channel-settings` marks it; switching back
      clears the `"live"` sentinel
- [ ] attachment blob deleted when parent message TTL-expires
- [ ] restart clears all live buffers (inherent; smoke test)
- [ ] idle presence eviction drops a non-interacting member's buffer subscription

Frontend (SvelteKit port of the mockup):
- [ ] `ConnectionBar` persists across channel navigation while Joined
- [ ] Leave → local scrollback cleared; rejoin shows only still-alive snapshot
- [ ] fade gradient renders by age from `born_at`
- [ ] client render window trims DOM without affecting server buffer
- [ ] AFK chip + announce line gated by toggle
- [ ] weak-client render window setting persists locally

---

## 15. Build order (after contract sign-off)

1. In-memory live reaper (TTL eviction + `message-deleted` emit) — backend
2. Count-cap enforcement on live channels — backend
3. `update-channel-settings` already marks live; add TTL/cap per-channel storage —
   backend
4. Attachment blob-TTL coupling + size cap — backend
5. Idle presence eviction — backend
6. `live-buffer-snapshot` on Join — backend
7. SvelteKit port of mockup: `ConnectionBar`, `LeaveModal`, `LiveEmptyState`,
   `LiveChat` (fade-by-age), `ParticipantsPanel`, `ChannelSettings` Live tab,
   AFK announce — frontend
8. Client render-window setting (weaker computers) — frontend
9. End-to-end smoke on a running server (Tim or local)

---

## 16. Open follow-ups (explicitly deferred, not in v1)

- `ChannelKind::Live` domain type (clean form; needs WabiDB migration + dual-decode)
- Horizontal-scale live rooms (sticky vs shared ephemeral store decision)
- Server-side "send me last N only" bandwidth mode
- Strict join-point mode toggle
- Rolling-TTL option as distinct from per-message-TTL (different product feel)
