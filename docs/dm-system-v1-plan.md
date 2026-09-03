# DM System v1 — Build Plan

> **Unshipped security target:** Current Wabi DMs are server-readable. This plan must not be cited as evidence that E2EE exists, and no encryption badge or guarantee may ship until its full acceptance suite passes.

Building the new DM system from scratch, faithful to the vision in
`docs/dms-and-notes-vision.md`. This plan pulls the doc's ideas
through end to end and lays out the build order.

The vision doc is the source of truth for product intent. This file
is the implementation plan that realizes it. When the two disagree,
the doc wins — fix the plan.

## What the vision doc says (so we're aligned)

Five ideas from the doc that shape v1:

1. **People before DMs.** You cannot DM someone you don't know exists.
   The People list is the address book of the user's Wabi universe —
   every person they can reach, with current status. It's the first
   surface after sign-in, not a sub-panel.

2. **DMs are a space for two people to send messages.** Not a private
   channel. Not a smaller channel. A DM is a relationship with its
   own state, history, and visual identity. Transport (STDB calling,
   socket.io, P2P, whatever) is an implementation choice.

3. **Memory is what the user says.** The retention ladder follows the
   Snapchat/Session framing: a fixed list, not a free duration
   picker. `view once` / `30s` / `1m` / `5m` / `10m` / `30m` / `1h`
   / `1d` / `1w` / `1mo` / `forever`. Default is 1 week. The user
   picks per conversation, per message. Forever uses a local sidecar.
   The data model MUST support this from day one even if the picker
   UI ships in v2.

4. **Verified encryption is a release gate for any future E2EE
   claim.** The target is client-side encryption with ciphertext-only
   server handling. Until that is implemented and tested, DMs remain
   server-readable and the UI must make no E2EE claim.

5. **LINE mode is a first-class home view, not an extra.** Users who
   only care about DMs (LINE users, Signal users, "I just want a
   messenger") get a home view that hides server channels by default
   and puts DMs + Notes + a People list at the front. The personal
   section travels with the user, not the server.

The doc's anti-features (no reactions on notes, no server-side
full-text search of notes, no "default to forever", no "social feed
of public notes", no rigid DM layout) shape what v1 explicitly
doesn't build.

## Goals (what "v1" means)

A user can:
- Open Wabi and immediately see who's online and available
  (the People list, first surface)
- Start a 1:1 DM with anyone on the server with one click
- Exchange messages in that DM with E2E encryption (server stores
  ciphertext only)
- See their DMs in a dedicated right-panel strip, persistent and
  glanceable
- Open any DM into the center stage to read or reply
- Run Wabi in "DM focused" mode (LINE/Signal feel) — server
  channels hidden, DMs and Notes at the front, personal theme
  independent of server theme
- Promote a DM message to a note (cross-surface action, the
  doc's "send to note" pattern)
- Search across their own DMs and notes, client-side, full-text
  (the server never sees the search query or the plaintext results)
- Trust that the server admin cannot read their messages — the
  data model and the encryption make it structurally impossible

What's NOT in v1 (explicit deferrals, not bugs):
- Group DMs (v2 — needs the retention ladder UI too; v1 is 1:1 only)
- The full retention ladder UI (v1 ships the data model + a single
  default-retention-per-conversation setting; the picker UI ships in v2
  with the group-message work)
- View-once / 30-second ephemeral message UI (v2; the data model is
  ready)
- Multi-device key sync / "link new device" flow (v2; v1 is
  single-device with an honest banner about it)
- Voice / video messages (separate workstream after v2)
- DM search across multiple devices (v2)

## Architecture overview

### Three new surfaces in the app shell

- **`DmListPanel`** — the dedicated right-column strip showing
  conversations + a People section. Always visible when not in
  DM-focused full-screen mode. The People section is at the top,
  not buried — this is the address-book-first design.
- **`DmConversationView`** — replaces the channel chat surface when
  a DM is active. Has the same visual language as the chat surface
  but with DM-specific affordances (encryption indicator, retention
  badge, no @mention model, "promote to note" action).
- **`DmFocusLayout`** — full-screen DmListPanel when DM-focused mode
  is on. Server channels hidden. The entire app surface is DMs +
  Notes + a "browse servers" link.

### The home-layout switcher

A new setting `ui.homeLayout`:
- `"server-browser"` (default, current behavior)
- `"dm-focused"` (LINE/Signal mode)

Toggle via `DmFocusToggle.svelte` from anywhere. Persists to
`localStorage`. No server round-trip. The personal theme override
(`ui.personalTheme`) is independent of any server's theme — the
right panel and DM conversation get their own colors.

### Encryption (the non-negotiable part)

Following the vision doc:
- **Algorithm**: libsodium (NaCl `crypto_box` for keys,
  `crypto_secretbox` for message bodies)
- **Per-user keypair**: generated on first signup, public key
  published to STDB as `dm_user_key`. Private key stays local:
  IndexedDB on web, OS keychain on Tauri. The server never sees
  the private key.
- **Per-conversation symmetric key**: created at conversation
  creation, wrapped for each member using their public key,
  stored in `dm_conversation_key`. The wrapped form is what the
  server sees; the unwrapped form only exists on member devices.
- **Message body**: encrypted on send with the conversation key +
  a per-message nonce. Stored as `dm_message.ciphertext`.
- **AAD (additional authenticated data)**: `conversation_id`,
  `message_id`, `sender_user_id`, `sent_at` — bound to the
  ciphertext so a message can't be replayed into a different
  conversation.
- **What the server CAN see** (be honest about it): who is in a
  conversation, when messages were sent, message count, online
  status, conversation metadata.
- **Target after the E2EE gate passes:** the server cannot see message
  bodies, attachments, reactions, edit history, or voice notes. This
  is not true of the current implementation.
- **Single-device for v1**: the user's private key is bound to
  their first device. If they sign in elsewhere, they get a new
  key and lose access to old ciphertext messages (which are
  unrecoverable without the original key). This is HONEST and
  explicit only after verified E2EE ships. Before then, show no
  encryption badge or operator-blind banner.
- **Multi-device key sync (v2)**: "link new device" flow with
  QR code or passphrase. Requires a key-rotation scheme that v1
  doesn't have to solve.

### DM requests (opt-in by default)

Per the vision doc: "DM requests: opt-in DMs by default, with a
request/accept flow." For v1, this means:
- A new user must explicitly accept a DM before it shows up in
  their conversation list
- The sender's first message sits in a pending state until accepted
- The recipient gets a notification ("<user> wants to DM you")
- The recipient can accept or block
- Once accepted, the conversation is normal (no further gating)
- Existing contacts (people the user has already DMed) skip the
  request step — they go straight to a conversation
- A "block user" action prevents future requests from that user

## Data model (STDB tables)

Five new tables, all Public-read so the server can route messages:

```
dm_conversation:
  conversation_id (PK, string uuid)
  kind (enum: 'one_on_one' — only this in v1)
  created_at (timestamp)
  created_by (user_id)
  last_message_at (timestamp)
  last_message_preview_ciphertext (bytes)  -- encrypted preview
  retention_seconds (i64, nullable)        -- v1: nullable default
  row_json (string)

dm_member:
  conversation_id (string, PK part)
  user_id (i64, PK part)
  joined_at (timestamp)
  last_read_message_id (string, nullable)
  unread_count (i64)
  pending (bool)                            -- true if DM request not yet accepted
  row_json (string)

dm_message:
  message_id (PK, string uuid)
  conversation_id (string)
  sender_user_id (i64)
  ciphertext (bytes)            -- encrypted body
  nonce (bytes)
  attachment_count (i64)
  sent_at (timestamp)
  edited_at (timestamp, nullable)
  deleted (bool)
  -- v2: ephemeral_until, ephemeral_kind, retention_override
  row_json (string)

dm_user_key:
  user_id (PK, i64)
  public_key (bytes)
  algorithm (string, "x25519")
  created_at (timestamp)
  rotated_at (timestamp, nullable)
  row_json (string)

dm_conversation_key:
  conversation_id (PK, string)
  recipient_user_id (PK, i64)
  wrapped_key (bytes)            -- conversation key, encrypted with
                                    recipient's public key
  row_json (string)
```

The bridge module (`wabi_state_bridge/src/lib.rs`) gets new ingest
handlers for these tables. The retention ladder lives in the data
model from day one even though the picker UI ships in v2 — that way
v2 doesn't require a schema migration.

## Server API

All DM traffic flows through the existing socket.io connection.
The wabi-server holds the plaintext conversation key TRANSIENTLY
(in memory only, never on disk) when a user is online so it can
route messages. The disk store is ciphertext.

```
Client → Server (socket.io emit):
  dm.conversation.create_or_get   (other_user_id) → conversation_id
  dm.message.send                  (conversation_id, ciphertext, nonce,
                                    attachment_count) → message_id
  dm.message.edit                  (message_id, ciphertext, nonce) → ok
  dm.message.delete                (message_id) → ok
  dm.read_receipt.update           (conversation_id, message_id) → ok
  dm.typing.start                  (conversation_id)
  dm.typing.stop                   (conversation_id)
  dm.request.accept                (conversation_id) → ok
  dm.request.decline               (conversation_id) → ok
  dm.request.block                 (user_id) → ok

Server → Client (socket.io broadcast):
  dm.message.new             (conversation, message)
  dm.message.edited          (message)
  dm.message.deleted         (message_id)
  dm.typing                  (conversation_id, user_id)
  dm.read_receipt            (conversation_id, user_id, message_id)
  dm.request.received        (from_user_id, conversation_id)
  dm.presence                (user_id, status)
```

The plaintext conversation key is held in memory only, scoped to the
conversation, and re-derived per message from the `dm_conversation_key`
row using the requesting user's stored private key on the client side.

## Frontend components (new files)

```
frontend/src/lib/components/dm/
  DmListPanel.svelte           -- right-column strip (People + Conversations)
  DmListItem.svelte            -- one conversation row (unread, avatar, preview)
  DmPeopleList.svelte          -- People section (the address book)
  DmRequestBanner.svelte       -- pending DM request UI ("<user> wants to DM you")
  DmConversationView.svelte    -- center-stage replacement
  DmMessageList.svelte         -- virtualized scrollback
  DmMessageItem.svelte         -- one message with "promote to note" action
  DmMessageInput.svelte        -- text input, send, attachment (disabled v1)
  DmEncryptionIndicator.svelte -- "encrypted" badge in conversation header
  DmRetentionBadge.svelte      -- shows the conversation's retention setting

frontend/src/lib/components/
  DmFocusToggle.svelte         -- home-layout switcher button
  DmFocusLayout.svelte         -- full-screen DmListPanel when LINE mode on

frontend/src/lib/dm/
  dmCrypto.ts                   -- libsodium wrappers, encrypt/decrypt,
                                 -- per-message nonce + AAD
  dmStore.ts                    -- local DM state (conversations, drafts,
                                 -- pending requests)
  dmSync.ts                     -- sync between server and local store
  dmKeyring.ts                  -- local keypair, IndexedDB persistence
  dmEphemeralKeys.ts            -- in-memory plaintext conversation keys,
                                 -- never persisted
  dmRequests.ts                 -- opt-in DM request flow
  dmCrossSurface.ts             -- "promote DM message to note",
                                 -- "send note to DM"
```

## Right panel and center stage behavior

### `DmListPanel` (always visible when not in DM-focused full-screen)

280px wide. Sections top to bottom, in this order (People first, per
the vision doc):

1. Search bar (filters conversations and People)
2. **People** section — everyone on this server, sorted by online
   status. Click a person → start (or accept) a DM. The People list
   is the address book; it's the first surface after sign-in, not a
   side panel.
3. **Conversations** section — pinned / recent, sorted by
   `last_message_at`. Each row shows: avatar, name, online dot,
   last-message preview, unread badge.
4. Notes quick-capture entry (links to the existing Notes surface)
5. DM encryption settings link (rotate key, see banner about
   single-device)

### `DmConversationView` (replaces channel chat when DM is active)

- Opens when user clicks a conversation in the right panel
- Header: avatar, name, online dot, retention badge, encryption
  indicator, "promote to note" action, "back to <channel>" pill
- `DmMessageList` virtualized scrollback, last 50 messages then
  load-more-on-scroll-up
- `DmMessageInput` at the bottom, send on Enter
- Per-message hover actions: edit (own messages only), delete (own
  only), promote-to-note (any message)
- "Back" button or Esc → return to the previous server channel
- Read receipts: small ✓ under each message, becomes ✓✓ when read

### DM-focused mode (`DmFocusLayout`)

When `ui.homeLayout === "dm-focused"`:
- Server channels hidden
- Center stage shows DmListPanel full-width when no DM is active
- When a DM is active, normal split view (list + conversation)
- "Browse servers" entry at the bottom of the list
- Personal theme override (`ui.personalTheme`) is independent of
  any server's theme

When `ui.homeLayout === "server-browser"`:
- Current behavior. Right panel shows DmListPanel alongside
  the existing user list (the user list becomes a sub-section or
  gets merged into DmListPanel.People).

## Build phases

Each phase is independently demoable. Each phase ends with
`svelte-check` green. Phase boundaries are gates — don't skip them.

### Phase 1: Foundation (no UI yet)

- STDB schema additions: `dm_conversation`, `dm_member`, `dm_message`,
  `dm_user_key`, `dm_conversation_key`
- Bridge module handlers for each (in `wabi_state_bridge/src/lib.rs`)
- Server-side: socket.io event handlers that accept ciphertext from
  the client and ingest to STDB via the existing bridge pathway
- Server-side: socket.io broadcast on incoming messages to other
  members
- Test path: curl can send a ciphertext message and it lands in
  STDB; another curl can fetch it

### Phase 2: Local key generation

- On first signup, the client generates a keypair (libsodium
  `crypto_box_keypair`)
- The private key stays in IndexedDB (`wabi.dm.privateKey`)
- The public key is sent to STDB via the `dm_user_key` bridge
- A migration that runs once per user: if no public key exists,
  generate one and register it
- A "rotate key" button in DM settings that creates a new keypair,
  registers the new public key, and re-wraps all conversation keys

### Phase 3: Client-side encryption

- `dmCrypto.ts` — wraps libsodium primitives
- `dmEphemeralKeys.ts` — in-memory cache of decrypted conversation
  keys, scoped to the active session, never persisted
- Encrypt on send: build the AAD, encrypt, attach nonce
- Decrypt on receive: look up the conversation key, decrypt, verify AAD
- Round-trip test: synthetic client A encrypts, synthetic client B
  decrypts. Must match. Run before Phase 4.

### Phase 4: Conversation creation + DM requests

- `DmListPanel` shows the People section, click a person → creates
  or opens a conversation
- Server: `dm.conversation.create_or_get` finds or creates a 1:1
  conversation between two users, generates a fresh conversation
  key, wraps it for both members, ingests to STDB
- Returns the conversation id + the wrapped key for the requesting user
- The client unwraps the conversation key (using its private key) and
  caches it in `dmEphemeralKeys`
- **DM requests**: if the recipient is a brand-new contact (not in
  the requester's contact list), a `dm_member` row is created with
  `pending = true`. The recipient sees `DmRequestBanner`. They can
  accept, decline, or block.
- Existing contacts (people the requester has already DMed, or who
  are in the user's own server context) skip the request step.

### Phase 5: Right panel list

- `DmListPanel` renders the full layout (People + Conversations +
  Notes entry)
- Conversations show: last-message preview (decrypted client-side
  from `last_message_preview_ciphertext`), unread badge, online dot
- Click a conversation → sets it as active (via the dmStore)
- Search bar filters both sections

### Phase 6: Center stage conversation

- `DmConversationView` replaces the channel chat when a DM is active
- `DmMessageList` virtualized scrollback
- `DmMessageInput` text input; sends encrypted message via
  `dm.message.send`
- Message read state per-user (`dm.read_receipt.update`)
- "Back to channel" pill to return to the previous server channel
- Per-message "promote to note" action — sends the message text to
  the existing Notes surface (cross-surface integration per the
  vision doc)

### Phase 7: DM-focused mode (LINE/Signal)

- `ui.homeLayout` setting persisted to localStorage
- `DmFocusToggle.svelte` to switch between layouts
- `DmFocusLayout.svelte` replaces the channel list when DM-focused
- Personal theme override (independent of server theme)

### Phase 8: Polish + voice notes prep

- Typing indicators (`dm.typing.start` / `dm.typing.stop`)
- Presence in the People list (reuse the existing presence pipeline)
- Read receipts in the conversation view
- Encryption status UI only after runtime verification; no badge in the current product
- Cross-DM search (client-side, after decrypt) — the vision doc
  says search is per-user, never shared with the server
- "Promote to note" / "Send note to DM" cross-surface actions
- Voice notes (the data model already supports attachments; the
  voice-notes UI is the deferred piece but the wiring is ready)

### Phase 9: Security status disclosure

- Do not show an E2EE badge or guarantee until message text,
  attachments, downgrade rejection, key recovery, and multi-device
  behavior pass the release-gate tests.
- After that gate passes, disclose the verified device/key limitations
  without claiming protections beyond the tested implementation.
- A "rotate key" action with confirmation modal explaining what
  happens

## Out of scope for v1 (explicit deferrals)

- Group DMs (v2)
- Custom retention ladder picker UI (data model is ready, UI in v2)
- View-once / 30-second ephemeral timers (v2)
- Multi-device key sync / "link new device" (v2)
- Voice messages (separate workstream)
- DM search across multiple devices (v2)
- Reaction emojis on messages (the doc doesn't say "no reactions",
  but the principle is "DM is a relationship, not a feed" — defer
  until we know users want them)

## Risks and how we'll handle them

**Risk: encryption breaks the message round-trip.** Phase 3 ends
with a round-trip integration test. Synthetic client A encrypts,
synthetic client B decrypts. Run before Phase 4.

**Risk: the existing socket.io channel gets too crowded.** Adding DM
events to the same socket is fine for v1; if it gets too noisy, we
can move to a separate namespace. Defer.

**Risk: the right panel conflicts with the existing user list.** The
existing user list (the People panel) is a tab in the right column.
The new `DmListPanel` replaces it with a unified People +
Conversations view. Old `UserListTabImpl` stays for non-DM user
browsing in the channel context.

**Risk: cross-device confusion.** Single-device only for v1. A
persistent banner + first-time onboarding makes this explicit. No
hidden gotchas.

**Risk: STDB schema changes during dev.** Each phase is additive.
The retention ladder fields are in the schema from day one even
though UI ships later. Schema migrations during dev are fine because
the dev STDB is throwaway.

**Risk: 56-warning baseline creeps up.** svelte-check stays at 0
errors. Warnings can grow up to 70 before I call it a problem
that needs a cleanup pass.

## Time / sequence expectation

1.5 to 2 weeks of focused build time if everything goes right.
Phase 1 is the foundation; everything else depends on it.

If you want to bump something earlier (e.g. "DM-focused mode
visible on day one for a screenshot, even if messages don't work"),
say which phase to move up. Otherwise I start at Phase 1.

## Plan check

Before I start:
- Is the encryption scope right (E2E ciphertext-on-server,
  single-device v1, honest "lose this device lose access" banner)?
- Is People-before-DMs the right order for the right panel
  (People at top, conversations below)?
- Is the right-panel + center-stage takeover right (DM takes over
  center stage even when you were in a server channel)?
- Is DM-focused mode home-layout switch the right way to deliver
  "LINE mode"?
- Is v1 = 1:1 only (no groups) the right cut, with the retention
  ladder data model supported but the picker UI deferred?
- Is opt-in DM requests the right privacy default for v1?
- Phase order good, or do you want to bump something earlier?

Tell me to start when you're ready.
