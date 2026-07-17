# Live Session Rooms (No-Disk Chat) Implementation Plan

> **For Hermes / OpenCode / hy3:** Implement task-by-task. Do not commit unless the user asks. Prefer verifying against live contracts before inventing new policy tables.

**Goal:** Let operators create a dedicated **Live** room where messages exist only for the current server process session (memory fanout), never enter WabiDB segments/indexes, and vanish on restart — while keeping the product default for normal text channels as **timed 24h** (Discord-as-pseudo-email), with **Keep forever** as explicit opt-in.

**Architecture:** Split the send path by **storage class** before any durable write. Three classes for public/text-like chat: `live` (session only), `timed` (WDB write + TTL; default 24h), `forever` (WDB write, no TTL). Live is a first-class channel mode/flag, not a silent side effect of UI wording. Hardware win: no append growth for hot lobbies / stage chat / “just hanging out” rooms.

**Tech stack:** Rust `wabi-server` Socket.IO send path, `session_messages`, WabiDB only when class ≠ live; Svelte channel create + settings; existing purge/clear-channel-messages.

**Related (do not ignore):**
- Parent contract: `docs/plans/2026-07-10-privacy-persistence-and-dm-e2ee-repair.md` (Workstream A — true `Off` / memory-only)
- Stance: `docs/PRIVACY_STANCE.md` (ephemeral ≠ E2EE; public live chat is still operator-readable while live)
- Current default TTL flip (2026-07-17): default **24h**, keep forever opt-in — already partially in tree; this plan adds **true live/no-disk** as a third class

---

## Why this product shape

| Mode | Who wants it | Disk | Restart | Typical room |
|------|----------------|------|---------|----------------|
| **Live** | Stage chat, watch parties, voice lobby spam, “be here now” | No message body writes | Gone | Dedicated Live channel |
| **Timed 24h (default)** | Normal servers, Discord-like | Write then delete | Survives until TTL | `#general` |
| **Keep forever** | Lore, announcements, wiki-adjacent chat | Write, keep | Survives | `#announcements` |

Artists / communities: a **Live** room is a feature, not a penalty — less disk, less “who said what last month,” less hardware pressure on busy servers.

Hardware note (honest):
- Live avoids **message stream / segment / index growth** for that channel.
- Still costs **RAM** for `session_messages` while the process is up (cap required).
- Uploads/attachments are a **separate** policy (default: refuse or force ephemeral blob TTL for Live rooms — see Task 6).

---

## Non-negotiable contracts

1. **Live send path must not call `WdbAdapter::send_message` / `run_command` for the message body.**
2. **Live history after process restart is empty** (no “oops it was in a segment”).
3. **Live is still operator-readable while live** (not E2EE). Do not market as “private.”
4. **Default for new normal text channels remains timed 24h**, not Live.
5. **Keep forever remains opt-in** with confirm + purge when leaving forever (UI already partial).
6. **Acceptance tests must prove “never written,” not only “not listed after restart.”** Grep/scan temp `data_dir` for the canary string.

---

## Current code facts (as of 2026-07-17)

- `core/crates/wabi-server/src/socketio/messages.rs` — **always** attempts `wdb.send_message(...)`, then schedules TTL, then pushes to `session_messages`.
- `session_messages` is an in-memory fanout cache (cap ~1000/channel), **not** a storage-class switch today.
- Frontend `persistMessages` is largely **client local history / search**, not “skip server disk.”
- Channel settings now express **Message retention** (24h default UI / Keep forever opt-in) — retention ≠ Live class.
- Parent plan already requires policy resolution **before** durable write; this plan specializes that into a **Live room** product surface.

---

## Storage class model (v1)

```text
enum ChannelStorageClass {
  Live,     // session only, no WDB message body
  Timed,    // WDB + auto-delete (default label "24h")
  Forever,  // WDB, no auto-delete
}
```

Resolution for a send (public/text-like):

1. If channel is Live → session only, assign ephemeral id, fanout, return.
2. Else if Forever → WDB write, no TTL spawn.
3. Else Timed → WDB write + TTL from map/label/policy (default 24h).

Do **not** overload `autoDeleteAfter: null` to mean both Forever and Live. Forever stays null/forever label; Live is an explicit flag/mode.

Suggested wire fields (pick one, stay consistent):

- **Preferred:** `storageClass: "live" | "timed" | "forever"` on channel view + settings.
- **Alt:** `liveSessionOnly: true` boolean + existing retention for timed/forever.

Also surface UI badge: `LIVE` / “session only · lost on restart”.

---

## Out of scope (YAGNI for this plan)

- DM E2EE repair (parent plan Workstream B)
- MLS groups
- Cryptographic secure deletion proofs for timed/forever
- Changing global ops `RUST_LOG` / TraceLayer (separate min-knowledge ops profile)
- Making **default** server-wide Live (product decision: no — keep 24h default)

---

## Task list

### Task 1: Name the contract in docs (short)

**Objective:** One page operators and implementers share.

**Files:**
- Create: `docs/LIVE_SESSION_ROOMS.md` (short user/operator facing)
- Link from: `docs/PRIVACY_STANCE.md` (one paragraph + link)

**Content must include:**
- Three-class table (Live / Timed / Forever)
- “Live ≠ E2EE”
- Hardware benefits (no message segment growth)
- Default remains Timed 24h

**Verify:** Doc exists; no contradictory “Off means never written” claim without noting implementation status.

---

### Task 2: Failing contract test — Live never hits disk

**Objective:** Lock the no-disk property before coding.

**Files:**
- Create: `core/crates/wabi-server/tests/live_session_room_contract.rs`  
  (or extend `persistence_policy_contract` from parent plan if it exists)

**Assertions:**
1. Create channel with Live class.
2. Send unique canary body `LIVE-CANARY-<uuid>`.
3. Connected peer receives message over socket.
4. Scan `data_dir` recursively for canary bytes → **zero matches**.
5. Restart / reopen store → list history for channel → empty / no canary.
6. Control: Timed channel with same canary → appears on disk and after reopen (until TTL).

**Run:**
```bash
cd /var/home/Ronin/wabi
cargo test -p wabi-server --test live_session_room_contract -- --nocapture
```

**Expected first run:** FAIL (Live still writes via `send_message`).

---

### Task 3: Channel model / settings field for Live

**Objective:** Persist **policy only** (not message bodies).

**Files (expected touch points):**
- Channel domain / projection row: add `storage_class` or `live_session_only`
- `core/crates/wabi-server/src/socketio/wiring_handlers.rs` — `update-channel-settings`
- `core/crates/wabi-server/src/api/channels.rs` — create accepts storage class (default `timed`)
- `core/crates/wabi-server/src/socketio/shared.rs` — channel view JSON
- Frontend: `CreateChannelForm.svelte`, `ChannelSettingsModal.svelte`, `socket-types.ts`, channel store

**Rules:**
- Default create: `timed` + `24h`
- Live create: `storageClass=live`, ignore forever; clear TTL maps for that channel
- Switching Live → Timed/Forever: confirm “future messages will be stored”
- Switching Timed/Forever → Live: confirm + optional **purge** existing durable history (`clear-channel-messages`)

**Verify:** Create Live + Timed channels; API/socket payloads show correct class; restart preserves class config (policy row only).

---

### Task 4: Split send path (the load-bearing change)

**Objective:** Live messages never call durable send.

**Files:**
- Modify: `core/crates/wabi-server/src/socketio/messages.rs` (`on_message`)
- Possibly: `core/crates/wabi-server/src/api/messages.rs` REST send (same rule)

**Step sketch:**

```rust
// Pseudocode — implement against real types
let class = resolve_storage_class(&state, &channel_id).await;
let message_id = if class == StorageClass::Live {
    format!("live_{}", uuid::Uuid::new_v4())
} else {
    match state.app.wdb.send_message(...).await {
        Ok(id) => id,
        Err(e) => { warn!(...); /* existing fallback behavior */ generated_id }
    }
};
// always session_messages push + emit
// TTL spawn only for Timed
```

**Caps for Live:**
- Keep or lower session cap for Live channels (e.g. 200–500) to bound RAM.
- Optional: drop oldest more aggressively under memory pressure (later).

**Verify:** Re-run Task 2 tests → PASS.

---

### Task 5: History / load-more / search behavior

**Objective:** UI does not pretend Live has durable history.

**Files:**
- `MessageList.svelte` / Chat load-more — disable “load older” for Live
- `Chat.svelte` full-history search — require Timed/Forever (already gated partly by `persistMessages`; align with storage class)
- Channel list badge: LIVE

**Verify:** Live channel: live messages appear; refresh after server restart → empty; no infinite spinner loading history.

---

### Task 6: Attachments policy for Live

**Objective:** Avoid “message is live but file lives forever on disk.”

**v1 simplest (recommended):**
- **Reject file uploads** in Live channels with a clear error: “Live rooms are text/session only; use a timed or forever channel for files.”

**v1.1 optional:**
- Allow upload with **forced short blob TTL** + delete with message; more work.

**Files:** upload API + chat upload orchestrator + Live channel check.

**Verify:** Upload in Live → 4xx + UI toast; Timed channel upload still works.

---

### Task 7: Operator docs + settings copy

**Objective:** Correct mental model.

**Copy guidelines:**
- Live: “Session only. Lost when the server restarts. Not private from the server owner.”
- Timed: “Stored briefly (default 24 hours), then deleted.”
- Forever: “Opt-in history. Stored until purged.”

**Verify:** No place labels Live as E2EE or “no one can see this.”

---

### Task 8: Smoke on a real process (local or Tim)

**Objective:** Runtime proof.

1. Build + run `wabi-server` with clean temp data dir.
2. Create `#live-stage` as Live, `#general` timed.
3. Send canaries; `rg` data dir for live canary → empty; timed canary present.
4. Restart server; Live empty; Timed still has canary (until TTL).
5. Watch disk growth under load: Live room spam should not grow `streams/**/messages` the way Timed does (spot-check segment sizes).

**Report:** build-verified + runtime-verified separately.

---

## Suggested implementation order

1 → 2 (failing test) → 4 (send path) → 3 (settings field if needed for tests) → 5 → 6 → 7 → 8  

If tests need a flag before settings UI, hardcode Live via test helper / admin API first, then wire UI.

---

## Risks / pitfalls

1. **Forgetting REST `POST /api/messages`** — socket fixed, HTTP still writes. Gate both.
2. **Using `autoDeleteAfter: null` for Live** — collides with Keep forever. Separate field.
3. **Client localStorage** — even Live messages may cache on client; document or clear on leave (optional follow-up).
4. **Uploads** — biggest accidental persistence hole.
5. **Replication / standby** — Live messages must not enter snapshot shipping of message bodies (metadata/policy only).
6. **Marketing language** — Live is ephemeral + hardware-friendly, not Signal.

---

## Definition of done

- [ ] Contract test proves Live canary never on disk
- [ ] Operator can create a dedicated Live room in UI
- [ ] Default new text channel still Timed 24h
- [ ] Keep forever still opt-in
- [ ] Live: no load-more durable history; restart clears
- [ ] Attachments blocked or strictly ephemeral on Live
- [ ] Docs updated without overclaiming E2EE

---

## Handoff notes for implementers

- Prefer extending parent plan’s policy resolution rather than a one-off `if channel.name == "live"`.
- `session_messages` already exists — Live **uses** it; Timed/Forever **also** use it as cache **plus** WDB.
- After implementation, update `docs/PRIVACY_STANCE.md` acceptance item #1–2 with Live channel as the canary surface.
- Do not change Tim production until contract tests pass and a local smoke is recorded.

---

## Optional later (not this plan)

- Server-wide “min knowledge” profile: quieter `RUST_LOG`, no HTTP TraceLayer
- Live voice stage auto-paired with Live text lobby
- RAM pressure metrics / admin “Live rooms memory usage”
- Client: “this room does not save history” empty state art for artist communities
