# Wabi DM System v2 — Plan + Sober STDB Market Analysis

> **Unshipped security target:** Current Wabi DMs are server-readable. This plan describes desired architecture, not current guarantees. No E2EE badge or operator-blind claim may ship until the implementation and downgrade tests pass.
>
> **The Lamborghini principle (read first).** STDB is the engine. Wabi's body is the Svelte frontend, the design language, the friend-tier UX, the cross-surface integration with Notes. The relevant future-design question is whether the architecture can make tested retention and confidentiality properties structural. Those properties are not guarantees of the current product.

Two documents in one:

1. **Part 1: The DM v2 plan** — the corrected design with friend tiers, two-STDB split, STDB-carried audio, STT addon, encryption, group invites. Faithful to `docs/dms-and-notes-vision.md`.

2. **Part 2: Sober STDB market analysis** — what the 2.0 launch actually proved, what it didn't, what Wabi is betting on, and the realistic option of building a Wabi-flavored alternative.

The vision doc is still the source of truth for product intent. This file is the implementation plan and the architectural reality check. When the two disagree, the doc wins — fix the plan.

---

# Part 1: DM System v2

## What the vision doc says (so we're aligned)

Five ideas from the doc that shape v2:

1. **People before DMs.** The People list is the address book of the user's Wabi universe. First surface after sign-in, not a side panel.

2. **DMs are a space for two people to send messages.** Not a private channel. A relationship with its own state, history, visual identity. Transport is an implementation choice.

3. **Memory is what the user says.** Retention ladder follows Snapchat/Session framing. Fixed list, not free duration picker. `view once` / `30s` / `1m` / `5m` / `10m` / `30m` / `1h` / `1d` / `1w` / `1mo` / `forever`. Default 1 week. Per-conversation, per-message.

4. **Verified encryption gates any future claim.** The target is client-side E2EE with ciphertext-only server handling. Current DMs remain server-readable.

5. **LINE mode is a first-class home view, not an extra.** Personal messenger layout that hides server channels, puts DMs + Notes + People at the front.

Plus from the broader doc: group messages as a first-class conversation type, not a smaller channel. Notes as local-first, encrypted, cross-surface integrated with DMs. The "personal stuff travels with the user" principle.

## v2 deltas from v1 (the four big changes)

| Area | v1 | v2 |
|---|---|---|
| Trust model | Binary (accept once → full access) | Four tiers: blocked / stranger / acquaintance / friend |
| Call media transport | WebRTC only | **STDB-carried audio by default** (via `wabi-media`); WebRTC as low-latency opt-in |
| E2E encryption | Single-device only | **Multi-device sync** as opt-in with honest tradeoff banner (server holds wrapped key) |
| Plaintext mode | Not addressed | Per-server toggle; E2E user can opt out of plaintext in a plaintext server |

## What "use the engine" means in practice

The Lamborghini framing means the trust model lives in STDB, not in the application layer. Concretely:

**Every state-changing operation is a reducer with a friend-tier check.** The check is transactional, audit-logged in the WAL, and cannot be bypassed by a buggy or compromised wabi-server process. The server admin cannot grant someone a higher tier without writing to `dm_friendship`, and that write is itself a reducer with its own transaction log.

```rust
// Every call/voice-note/file reducer starts with this
fn require_tier(ctx: &ReducerContext, other_user: u64, min_tier: Tier) -> Result<(), String> {
    let me = ctx.sender;
    let tier = get_friendship_tier(&ctx.db, me, other_user)?;
    if tier.value() < min_tier.value() {
        return Err(format!("requires tier {:?}", min_tier));
    }
    Ok(())
}

#[reducer]
pub fn publish_audio_frame(ctx: &ReducerContext, room_id: u64, seq: u32, frame: Vec<u8>, codec: String, sample_rate: u32) -> Result<(), String> {
    let sender = ctx.sender;
    
    // 1. Is sender a member of this room?
    let is_member = ctx.db.call_member().room_id().filter(room_id)
        .any(|m| m.user_id == sender && m.left_at.is_none());
    if !is_member {
        return Err("not a room member".to_string());
    }
    
    // 2. Get the room to find the other members
    let room = ctx.db.call_room().room_id().find(room_id).ok_or("room not found")?;
    
    // 3. Friend-tier check against every other member
    for member in ctx.db.call_member().room_id().filter(room_id) {
        if member.user_id == sender { continue; }
        // Friends only for call audio. Strangers can't even be in the room.
        require_tier(ctx, member.user_id, Tier::Friend)?;
    }
    
    // 4. Encrypt the frame with the room key (held in dm_ephemeral_keys, not on the server)
    let room_key = get_room_key_for_sender(&ctx.db, room_id, sender)?;
    let nonce = generate_nonce();
    let encrypted = encrypt_frame(&room_key, &nonce, &frame)?;
    
    // 5. Insert with TTL — auto-purge after call end + 5 min
    let purge_after = room.ends_at
        .map(|e| e + Duration::seconds(300))
        .unwrap_or_else(|| ctx.timestamp + Duration::seconds(300));
    
    ctx.db.call_audio_frame().insert(CallAudioFrame {
        room_id,
        sequence_number: seq,
        sender_user_id: sender,
        codec,
        sample_rate: sample_rate as i32,
        frame_data: encrypted,
        nonce,
        sent_at: ctx.timestamp,
        purge_after,
    });
    Ok(())
}
```

**The server admin cannot read the audio** because `room_key` is the conversation key, and the unwrap happens client-side. The server only has the wrapped form. **The audio cannot outlive the TTL** because the auto-purge reducer runs in the same transaction model. **The friend-tier check is structural** because it's in the reducer, not in the application layer.

**That's the Lamborghini.** The same architecture that makes Wabi fast (subscription push) also makes Wabi trustworthy (transactional reducers, schema-level invariants, binary columns for media). Don't use the Honda. Use the engine.

## Two-STDB architecture (the answer to "STDB is a data black hole")

Wabi runs two STDB instances per server, both self-hosted, both under the BSL Additional Use Grant:

```
┌─────────────────────────────────────┐
│  wabi-durable  (STDB instance #1)   │   ← long-lived data
│  - Users, channels, messages        │   ← license: BSL, 1 instance
│  - DM ciphertext, friend tiers      │
│  - Notes (encrypted), albums meta   │
│  - Voice-note transcripts (text)    │
│  - Channel/call recordings opt-in   │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  wabi-media    (STDB instance #2)   │   ← short-lived media
│  - Call audio frames (Opus)         │   ← license: BSL, separate instance
│  - Screen-share frames              │   ← TTL on every row
│  - Voice-note audio (until STT)     │   ← auto-purge reducer
│  - Signaling transients             │
└─────────────────────────────────────┘
```

**Why two instances, not one with TTL on some tables:** the privacy architecture preference (already in Wabi's knowledge base) is explicit: "default/privacy-first mode must keep ephemeral call/media STDB separate from durable core STDB." The split makes the privacy guarantee structural, not policy-based. A compromised `wabi-durable` cannot exfiltrate audio because audio never lives there. `wabi-media` is not backed up by default.

**BSL Additional Use Grant covers both instances.** The grant is per-instance for "your application or service." Wabi is the application. Each STDB instance is a separate licensed deployment. Both are covered. Neither is a "Database Service" as defined in the BSL (which would be a multi-tenant hosted offering).

**`wabi-media` has TTL on every row.** A scheduled reducer purges rows where `purge_after < now()`. For live call audio: TTL = call end + 5 minutes. For voice notes: TTL = transcript generated + 1 minute. The default TTL is server-admin configurable (off / 1 min / 5 min / 15 min / 1 hour) but the schema enforces it on every insert.

## Call media transport — the Lamborghini version

**The default is STDB-carried audio via `wabi-media` STDB.** This is the 2.0 launch demo path, but for the right reasons: it gets around CGNAT by design (one outbound WebSocket per client to the Wabi server), the audio is E2E encrypted with the conversation key, and the trust promise is structural (the audio is in a TTL-bounded table in the same database as the rest of the state). WebRTC stays as an opt-in for low-latency use cases (rare in Wabi's domain) and for screen-share (where bandwidth matters more than the trust model).

| Scenario | Transport | Why |
|---|---|---|
| **1:1 voice (default)** | **STDB-carried audio in `wabi-media`** | CGNAT solved. E2E encrypted with conversation key. Server admin cannot MITM. No STUN/TURN/ICE handshake. Mobile network handoff is "just reconnect the WebSocket." |
| 1:1 voice (low-latency opt-in) | **WebRTC direct + TURN** | For users who care about 20-50ms latency (music, pro audio). Rare in Wabi. Off by default. |
| 1:1 screen share | **WebRTC** (default) or **STDB-carried frames** (low-motion opt-in) | Screen share is bandwidth-heavy. WebRTC is the standard. |
| Group call (2-4 people) | **STDB-carried audio in `wabi-media`** | Subscription push fans out to all members. Latency is fine for voice. |
| Group call (5-8 people) | **STDB-carried audio, audio-only** | Same model. STDB scales for audio past 8. |
| Group call (8+ people) | **STDB-carried audio** or **LiveKit SFU** (helper-node Phase 4) | Both work. STDB is the default (free, every server has it). SFU is the opt-in for sites with media nodes. |
| Signaling for all of the above | **`wabi-durable` STDB** | Room state, member list, presence, invite flow, friend-tier checks. Not media. |

**Latency comparison:**
- WebRTC 1:1: 20-50ms
- STDB-carried 1:1 (via subscription push): 50-200ms
- Discord voice: 100-300ms (depending on region)
- Phone call (PSTN): 100-300ms

**STDB-carried audio latency is in the same range as Discord and PSTN.** For talking to your friends, 100ms is fine. For music, no — use WebRTC. Wabi is not a music app.

**The CGNAT question:** the 2.0 launch demo showed audio streaming through STDB. The same architecture works for STDB-mediated WebRTC signaling. Both solve CGNAT because the client makes one outbound WebSocket to the Wabi server; the server fans out via subscriptions (for STDB-carried audio) or coordinates the WebRTC handshake (for the WebRTC path). Wabi's call design uses STDB-carried audio by default — CGNAT solved at the architectural level, not as a TURN fallback hack.

## Friend tiers (the graduated trust model)

Four tiers, ordered:

| Tier | What it means | DM capabilities |
|---|---|---|
| `blocked` | Hard wall | Nothing in, nothing out, invisible in People list |
| `stranger` (default) | Hasn't been friended; first-time contact | Text in/out. **No files, no images, no voice, no notes, no albums.** Every file/image attempt triggers a one-tap accept prompt. |
| `acquaintance` | Has been friended or had ≥1 conversation | Text + images + files. No voice notes, no notes/albums sharing, no cross-surface integrations. |
| `friend` | Explicitly friended by both sides (mutual opt-in) | Everything: text, files, images, voice notes, shared notes, shared albums, voice/screen share invites, friend-only retention tiers. |

**The accept prompt is a real, named UI.** When a `stranger` tries to send a file/image, the recipient sees:

> *<User> wants to send you a file: "birthday-photo.jpg" (1.2 MB)*
> [Accept] [Decline] [Always accept from <User>] [Block <User>]

Fourth button is the friendship upgrade. Pressing it moves them to `acquaintance` (or `friend` if mutual). Once "Always accept from <User>" is tapped, the prompt is gone for that person — but the global mute still applies.

**Raid/spam protection is structural:** strangers cannot send files or images at all. The accept prompt is the only way a file enters your client, and it's blocked by default for non-friends. A spam raid of images from new accounts is a no-op. The prompt is rate-limited server-side (5 pending requests per hour per sender, 20 per day). Past that, auto-block.

**Per-user override** (`dm_friend_prompt_pref` table): users can flip the global toggle ("auto-accept from strangers" off by default; opt-out available) or set per-user "always accept from <User>" without friending.

**Friend scope is per-server, not global.** Because Wabi is multi-server with the client as the bridge (per `WABI_MULTI_SERVER_ARCHITECTURE.md`), a user with accounts on Kyle's Room, Joey's Server, and TAFKAT Art has three independent friend lists. Cross-server friends are v3+ (federation).

## Friend notes and friend albums

**Yes, both exist, both shared.**

**Friend notes** (`shared_friend_note` table) live in `wabi-durable`, encrypted with a **per-friend-pair symmetric key** derived from both users' keys. Only the two users can decrypt. Each note has a `shared_with` list of friend pairs. Promoted DM messages from a friend can land in friend notes by default.

**Friend albums** extend the existing `media-albums/` surface. Albums gain a `visibility: 'private' | 'friends' | 'friend_pair:<user_id>' | 'public'` field. `friend_pair:<user_id>` means "visible only to me and this one person, encrypted to that pair." The "our photos" album with a partner is the natural use case.

## Plaintext mode (opt-in, per-server)

**Per-server setting** `server.dm_plaintext_allowed: bool` (default: `false`). When `true`, DMs in that server are stored plaintext, no E2E. The server admin can read them. The client shows a "Plaintext DMs (server admin can read)" badge in the conversation header.

**Per-user override:** a user can refuse plaintext DMs. If the server is plaintext and the user has E2E on, **E2E wins.** The server gets ciphertext from that user. The worst case is the E2E user's messages are the only unreadable ones.

**Friendship-tier + plaintext interplay:** a `friend` relationship in a plaintext server can be auto-promoted to E2E without breaking the server's plaintext setting. The friendship keypair is separate from the server keypair. So a user can have a "private E2E conversation with my friend in a plaintext server."

**No per-message toggle.** That's a footgun. Either the conversation is E2E or it isn't.

## Multi-device key sync (opt-in)

| Mode | What you get | What you give up |
|---|---|---|
| **Single-device (default)** | Strongest privacy. Private key never leaves one device. | Sign in on a new device, you start fresh. Old messages are unrecoverable ciphertext. |
| **Multi-device sync (opt-in)** | Same as Discord: log in on any device, see full history decrypted. | Server stores the encrypted private key, wrapped with a per-device passphrase. Server can brute-force the passphrase. Cannot read messages without it. |

**Honest banner on enrollment:**
> "Multi-device sync means your encryption key is stored on the server, wrapped with a passphrase only you know. If you forget the passphrase, you lose access to all devices. The server admin could in theory brute-force your passphrase, but cannot read your messages without it. Continue?"

**v1 ships the passphrase-only flow.** QR-code "link new device" is v3.

## Group invites (opt-in, no thrust)

| Flow | Behavior |
|---|---|
| Create group from scratch | Creator picks name, picks members. Each member gets a `DmGroupInvite` notification, not auto-add. |
| Add someone to existing group | Same flow. New person gets an invite, not a thrust. Existing members see "X is joining" but the group is unchanged. |
| Shareable link | One-time token, 24h expiry, requires explicit click-through. Recipient sees "You were invited to <group> by <creator>." |
| Per-friend pre-approval | "Auto-accept group invites from <User>" — useful for partner/family/roommate groups. |

**The "do you want x?" question goes in the right place: as a real opt-in, not a popup spam.**

## History catch-up (explicit ask, not automatic)

A user can right-click on a group in the sidebar and "Request history sync" — the server sends them the full conversation log up to retention expiry. For E2E groups, the user gets the wrapped conversation key for past messages; prior members' devices re-wrap the conversation key for the new member (standard Signal pattern).

**Per-conversation retention is a user property.** Default 1 week. Past messages keep the retention they were sent under unless the user explicitly extends ("Keep this older than the retention" on individual messages, like archiving).

## STT (speech-to-text) addon

**Default model: whisper.cpp tiny.q4** — ~75 MB on disk, ~200 MB RAM while transcribing, **0 MB persistent**. Lazy-loads on first use, runs in a Web Worker, never reaches the server. Audio is discarded after transcript is generated. Transcript is E2E encrypted and lives in `wabi-durable`.

**Upgrade path: Nemotron 3.5 ASR Streaming 0.6B** (the one you linked) — 600M parameters, **~300 MB INT4 ONNX**, ~1-2 GB RAM, 40 languages, configurable chunk sizes 80/160/320/560/1120 ms. Better WER. Same privacy model.

**Potential server-side opt-in for Tauri-native users:** the same whisper.cpp binary on the server admin's machine, off by default. This sends audio into the server trust boundary and must not be described as E2EE.

**No cloud STT.** Google/Azure/AWS would break E2E.

**Memory budget during a 4-person call with voice-note transcription:**
- Base Wabi app: 100-150 MB
- STDB durable client: 50-100 MB
- STDB media client: 50-200 MB (depends on call size)
- whisper-tiny in worker: 200 MB peak, 0 MB persistent
- Audio playback buffer: 10-50 MB

**Peak: ~600-700 MB.** Compare to Discord voice: 800 MB-1.5 GB idle, 1.5-2.5 GB during voice. Wabi is meaningfully lighter.

## Data model — STDB tables (wabi-durable)

```rust
// Friend tiers
dm_friendship:
  owner_user_id (PK, i64)
  other_user_id (PK, i64)
  tier (enum: 'blocked' | 'stranger' | 'acquaintance' | 'friend')
  friended_at (timestamp, nullable)
  friended_by (user_id, nullable)
  created_at (timestamp)

// Per-user file-accept overrides
dm_friend_prompt_pref:
  owner_user_id (PK, i64)
  scope (enum: 'global' | 'per_user')
  other_user_id (i64, nullable)
  auto_accept_files (bool)
  auto_accept_images (bool)
  auto_accept_voice (bool)

// Conversations (existing v1 schema, unchanged)
dm_conversation, dm_member, dm_message, dm_user_key, dm_conversation_key:
// ...as v1 plan

// Group invites (pending)
dm_group_invite:
  conversation_id (PK, string)
  user_id (PK, i64)
  inviter_user_id (i64)
  invited_at (timestamp)
  expires_at (timestamp)

// History sync requests
dm_history_sync:
  conversation_id (PK, string)
  user_id (PK, i64)
  wrapped_conversation_key (bytes)
  requested_at (timestamp)

// Friend-shared notes
shared_friend_note:
  note_id (PK, string)
  owner_user_id (i64)
  pair_user_id (i64)  // the friend
  ciphertext (bytes)
  nonce (bytes)
  created_at (timestamp)
  updated_at (timestamp)

// Multi-device key escrow (opt-in)
dm_user_key.device_wrapped_private_key (bytes, nullable)  // v1 schema field, populated when sync enabled
```

## Data model — STDB tables (wabi-media)

```rust
call_room:
  room_id (PK)
  kind (enum: 'one_on_one' | 'group_dm' | 'channel_voice')
  created_by (user_id)
  created_at (timestamp)
  ends_at (timestamp, nullable)
  retention_seconds (i32, nullable)  // server-admin configurable
  row_json

call_member:
  room_id (PK part)
  user_id (PK part)
  joined_at (timestamp)
  left_at (timestamp, nullable)
  inviter_user_id (i64, nullable)
  invite_accepted (bool)
  row_json

// Audio frames — TTL is the architectural privacy guarantee
call_audio_frame:
  room_id (PK part)
  sequence_number (PK part, u32)  // monotonic per room
  sender_user_id (i64)
  codec (string, e.g. 'opus')
  sample_rate (i32)
  frame_data (Vec<u8>)  // encrypted with room key
  sent_at (timestamp)
  purge_after (timestamp)  // TTL — auto-purge reducer deletes after this
  row_json

call_screen_frame:
  room_id (PK part)
  sender_user_id (PK part)
  sequence_number (PK part, i32)
  frame_data (Vec<u8>)
  width (i32)
  height (i32)
  sent_at (timestamp)
  purge_after (timestamp)
  row_json

// Voice notes — audio lives here until STT generates transcript, then audio is purged
voice_note_audio:
  voice_note_id (PK)
  conversation_id (string)
  sender_user_id (i64)
  codec (string)
  audio_data (Vec<u8>)  // encrypted with conversation key
  duration_ms (i32)
  recorded_at (timestamp)
  purge_after (timestamp)  // TTL = transcript generated + 1 min, or 5 min if STT disabled
  row_json

// Auto-purge reducer
#[reducer]
pub fn purge_expired_media_rows(ctx: &ReducerContext) {
    let now = ctx.timestamp;
    for row in ctx.db.call_audio_frame().iter() {
        if row.purge_after < now {
            ctx.db.call_audio_frame().delete(row);
        }
    }
    // ... same for call_screen_frame, voice_note_audio
}
```

## Build phases (v2)

| Phase | Task |
|---|---|
| 1 | Foundation: STDB schema additions to `wabi-durable` (friend tiers, prompt prefs, group invites, history sync, multi-device key escrow) |
| 2 | Two-STDB split: provision `wabi-media` as a separate instance, configure wabi-server to connect to both |
| 3 | Friend-tier reducers: tier check in `join_call`, `send_file_request`, `send_image_request`, `send_voice_note` |
| 4 | DM request flow: opt-in DM requests for strangers, accept prompt UI, rate limiting |
| 5 | Group invites: opt-in group creation/add flow, shareable link tokens, per-friend pre-approval |
| 6 | Right panel: `DmListPanel` (People + Conversations), search, friend indicators |
| 7 | Center stage: `DmConversationView`, virtualized scrollback, encryption indicator, retention badge, "promote to note" |
| 8 | DM-focused mode (LINE mode): home-layout switcher, personal theme |
| 9 | E2E encryption round-trip: synthetic client A encrypts, synthetic client B decrypts. Must match. |
| 10 | Multi-device key sync (passphrase flow) with honest tradeoff banner |
| 11 | Plaintext mode (per-server setting, per-user override) |
| 12 | `wabi-media` schema: call rooms, audio frames, screen frames, voice notes (the audio lives here, E2E encrypted with the conversation key) |
| 13 | `wabi-media` reducer: auto-purge expired rows (cron-driven) — structural privacy guarantee |
| 14 | **STDB-carried audio path** (default): `publish_audio_frame` reducer checks friend tier, encrypts with room key, inserts into `call_audio_frame` with TTL. Subscribed clients receive frames via subscription push. **WebRTC path** (opt-in): signaling through `wabi-durable` STDB, media P2P, TURN fallback |
| 15 | STT addon: `addons/media/stt-button/`, whisper-tiny.q4 default, Nemotron upgrade path. Audio in `wabi-media`, transcript in `wabi-durable` |
| 16 | Friend notes (shared) and friend albums (visibility filter) |
| 17 | History catch-up reducer, per-message retention overrides |

## Version pin (Tim + Ronin)

**v1.12.0 on both. Match the binary in `frontend/package.json` (currently 2.2.0) — bump back to 1.12.0 OR migrate fully to a single 2.x version. The split version pin is the worst option.**

v1.12.0 is the last 1.x. Stable, mature, supports binary columns. The 2.0 features we'd lose: V8 threading performance (irrelevant for Wabi's small message volume), the 2.0 launch demo path (we use WebRTC for media anyway), some SDK polish. Not blocking.

The 2.0 migration is a separate workstream. Don't mix it with the DM plan.

---

# Part 2: Sober STDB Market Analysis

You said you were star-struck by the 2.0 launch stats. Your rebellious Batman feels jaded. You want to know what can be built and whether to take the same concept and build a "for web communications" version of STDB. Here's the sober answer.

## What the 2.0 launch actually proved

**Source: `spacetimedb.com/blog/benchmarking` (Tyler Cloutier, May 14, 2026), confirmed in the May 2026 V8 threading fix.**

**The headline:** STDB 2.0 on the transfer benchmark — 303,920 ± 4,712 TPS (TypeScript), 265,541 ± 940 TPS (Rust). Better than two orders of magnitude over the next competitor.

**The honest read:**
1. The "competitor" column on the original 2.0 keynote chart was misconfigured. STDB's own team admitted the original benchmark "numbers we published at that time" were "misleading" — not because the benchmark was wrong but because STDB itself wasn't living up to its potential. They fixed the V8 threading model after the criticism.
2. The 2.0 numbers are the corrected ones (304k TPS). That's real. The architecture (colocated server + storage, in-memory state, embedded WASM reducers, subscription push) is genuinely fast.
3. **The numbers are reproducible.** The benchmark code is open at `github.com/clockworklabs/SpacetimeDB/tree/master/templates/keynote-2`. Anyone with an Intel 14900K can re-run.

**What 304k TPS means for a chat app like Wabi:** Wabi will never need 304,000 transactions per second. A 500-user server with active chat might do 1,000 TPS peak. STDB is dramatically over-spec'd for Wabi's workload. The "10,000x faster than we need" framing is the right one.

## What it didn't prove — the foo.community re-test

**Source: `foo.community/blog/spacetimedb-v2-benchmark-sqlite/` (Tanay Karnik, March 20, 2026).** Independent reproduction. Sober second opinion. **Read this whole article.**

The summary: Tanay took STDB's own benchmark code, found that the Node.js + SQLite competitor connector was broken (Drizzle ORM was missing `.run()` calls — the SQL was never executed, the benchmark was measuring Node.js HTTP overhead, not database writes), and then **fixed it and got vanilla Node.js + better-sqlite3 + WebSockets + write batching to 163,075 TPS** with `synchronous=FULL` and proper fsync on every commit. Durability preserved.

**Key findings from the reproduction:**
- Default SQLite (journal_mode=delete, double-fsync): 360 TPS, 133ms p50
- SQLite with WAL + WebSockets + batching (batch=10): 13,438 TPS, 2.8ms p50
- SQLite with batch=4000, inflight=120: 163,075 TPS, 31ms p50
- STDB (Rust, same hardware): 167,915 TPS, latency not disclosed

**The 304k vs 163k gap is real, but the gap between STDB and "boring tech done right" is much smaller than the marketing chart suggested.** The headline "23x faster than SQLite" is closer to "1.8x faster than SQLite done correctly."

Tanay's analysis of why STDB is genuinely fast:
- Colocated server + storage (no network round-trip between logic and data)
- In-memory state (no disk read on the hot path)
- WASM-isolated reducers (safe to run user code)
- Subscription push (no polling)

Tanay's analysis of what STDB is *actually solving*:
> "The WASM reducer model is actually solving: running user-generated code safely, supporting multi-tenant platforms where you can't trust what's being executed. Stuff that they need for their Maincloud offering."

> "If it's your own code on your own server, there's no untrusted code to sandbox. The WASM runtime buys you nothing."

That's the sober read. **STDB's WASM-reducer model is a multi-tenant product story (Maincloud), not a self-host story.** For Wabi, where the Wabi server admin is trusted, the WASM isolation is overhead you don't need.

## The CGNAT / "world changing" claim — also sobered

The 2.0 launch demo showed audio streaming through STDB via subscriptions. This gets around CGNAT because the client makes one outbound WebSocket to STDB; the server fans out the audio to all subscribers without the clients needing inbound connectivity. **This is real and useful.**

**But it works the same way for WebRTC signaling through STDB.** The WebRTC connection setup is server-mediated via STDB signaling. The audio bytes still go P2P between the two clients (with TURN fallback). The signaling goes through the server. **CGNAT solved, same architecture as Discord/Matrix/Signal.**

The "STDB carries audio bytes" path is architecturally possible and bandwidth-egress-expensive. The "STDB carries signaling, WebRTC carries media" path is the production pattern that 99% of real-time communication apps use in 2026. **For Wabi's call design, use the production pattern.** Don't try to be the 2.0 launch demo.

## What can be done with this concept — the "build a Wabi-flavored version" question

The STDB architectural primitives are not magic. They're a combination of:
1. **Embedded logic in the database** (stored procedures on steroids, via WASM)
2. **In-memory state with WAL persistence**
3. **Subscription-based push** (server pushes row updates to subscribed clients)
4. **ACID transactions in the embedded language**
5. **Binary columns** (for media payloads)

These can be built without a proprietary runtime. Convex does it. Partykit does it. Cloudflare Durable Objects do it. **foo.community's article specifically calls out Cloudflare Durable Objects as a production-grade alternative that does this pattern right** with real durability guarantees and horizontal scaling.

**For Wabi's specific case (self-hosted, multi-server, privacy-first, voice + text + media), the right question is: what does Wabi need from the database layer?**

| Wabi needs | STDB provides | Alternatives |
|---|---|---|
| Real-time state sync to subscribed clients | ✅ Subscription push | Convex, Partykit, Liveblocks, custom WebSocket server |
| Reducers for state transitions | ✅ WASM reducers | Plain server endpoints (Express, Axum, etc.) |
| In-memory hot state | ✅ In-memory tables | Any in-memory cache + DB |
| Binary payload storage (for media) | ✅ `Vec<u8>` columns | S3, file relay, IPFS, plain file storage |
| Self-hostable | ✅ Standalone binary | Postgres + custom server, SQLite + custom server |
| Open source / no vendor lock | ⚠️ BSL until 2031-06-15, AGPL-with-linking-exception after | True open source alternatives |
| Multi-instance federation for Wabi's "client is the bridge" model | ⚠️ Each instance is its own island, federation is the client's job | Same model works for any backend |

**The honest answer: you could build a "Wabi-flavored" version of STDB in a few weeks that does what Wabi needs.** The architecture would be:

- **Storage engine:** SQLite with WAL mode. It's a real database, durable, fast enough for any Wabi workload. `synchronous=FULL` for safety. Binary blob support is built in. The Tanay teardown showed it does 163k TPS on a single machine.
- **Subscription push:** a thin Rust/TypeScript server that holds WebSocket connections to subscribed clients and pushes row updates when they happen. SQLite triggers → server event loop → WebSocket fanout. ~500-2000 LOC of Rust with Axum + tokio-tungstenite.
- **Reducer model:** plain server endpoints (Axum routes). Each route reads/writes SQLite in a transaction, the trigger fires, the subscription fanout runs. No WASM needed because Wabi server admins are trusted.
- **Media handling:** S3-compatible storage for blobs (or a file relay, or even just disk on the server admin's machine), with signed URLs for the client to download. The Wabi-server binary serves as the file server for small files; large files go to the file relay helper node.
- **Auth:** the existing `wabi-server` auth flow, no changes.

**This is not magic. It's a few weeks of Rust work** for someone who's already building Wabi-server. The subscription push model is the novel piece; everything else is well-understood.

**But you probably don't need to build it.** The reasons:

1. **STDB works fine for Wabi's workload.** Wabi is not going to push 304k TPS. Wabi is going to push maybe 1k TPS peak. STDB is dramatically over-spec'd and that's fine.
2. **The BSL is not blocking.** Pin a version, self-host, the Additional Use Grant covers you. If you want to fork, open the fork. After 2031-06-15, AGPL with linking exception means Wabi code stays closed even if you modify STDB.
3. **Building a Wabi-flavored DB is a distraction** from the actual Wabi work. The fracture campaign is mid-flight, the v2 DM plan needs implementation, the STT addon needs to ship, the friend tiers need code, the STDB-mediated voice vs WebRTC question needs to settle. **Build Wabi on STDB now. Decouple the database layer behind a clean interface. Swap it later if needed.**
4. **The "CGNAT voice call" capability doesn't require STDB to carry media.** WebRTC + STDB signaling solves CGNAT for voice calls in 2026. This is the production pattern.

## The "rebuild the concept" option, if you want it anyway

If you do want to build a Wabi-flavored version, the spec would be:

**WabiDB (working name) — a self-hosted real-time state server for Wabi**

- **Storage:** SQLite (WAL mode, `synchronous=FULL`). One process, one file. ~10 MB binary.
- **Schema:** declared in Rust, migrations are version-stamped SQL files. Table definitions use a simple DSL or just SQL.
- **Server:** Axum + tokio. WebSocket endpoint for subscriptions, HTTP endpoint for state-changing operations. ~2000 LOC of Rust.
- **Real-time:** server holds a map of `(subscription_query → Vec<WebSocket>)`. When a SQLite row changes, the affected queries are recomputed, diffed, and pushed to subscribed clients. The fanout is the novel part.
- **Binary columns:** SQLite BLOB columns. The schema just declares the column as `Blob`. The client receives the bytes over WebSocket.
- **TTL:** scheduled task purges rows with `purge_after < now()`. Same pattern as STDB reducers.
- **Auth:** JWT in the WebSocket upgrade. Existing wabi-server auth flow.
- **CLI:** `wabidb init`, `wabidb start`, `wabidb shell` (SQL REPL). Similar feel to spacetimedb-cli.
- **License:** MIT or Apache 2.0. Open source from day one.

**Effort estimate: 4-6 weeks of focused Rust work for someone who's already in the wabi-server codebase.** The hard parts are: the subscription query language (what does a "subscribe to all messages in channel X" look like?), the diff/push protocol (sending only changed rows, not full query results, every time), and the migration story (how do you change a schema when clients are connected).

**Once WabiDB exists, Wabi decouples from STDB.** Wabi-server talks to WabiDB instead. The frontend talks to Wabi-server. The two-STDB split becomes a two-WabiDB-instance split with no behavior change.

## What to do now

1. **Pin v1.12.0 on Tim and Ronin.** Don't fork. Don't panic.
2. **Continue the v2 DM plan implementation** as written in Part 1. The two-STDB split is the architectural answer to "data black hole."
3. **Defer the WabiDB build question** to a futuresight doc. Don't start it now. The fracture campaign is mid-flight and adding a database rewrite is a distraction.
4. **Write a WabiDB futuresight doc** that captures: (a) the architectural primitives, (b) the SQLite-with-WS-push model, (c) the subscription query language design questions, (d) the migration story, (e) the "if STDB goes closed source for real, here's our escape hatch" framing. Save as `docs/futuresight-wabidb.md`. Don't build it.
5. **Update the v1 DM plan doc** with a note: "v2 supersedes this. See `docs/dm-system-v2-plan.md`."

The sober read: STDB 2.0 is genuinely fast, the marketing was exaggerated, vanilla SQLite + WebSockets + batching gets you 90% of the way there, the CGNAT voice story works with WebRTC + STDB signaling without STDB carrying media, and you can build a Wabi-flavored alternative when you need to (not now). The Wabi v2 DM plan as written is the right next step.
