# DM System — Final Build Plan

> **Unshipped security target:** Current Wabi DMs are server-readable. This plan is not a product guarantee. The current UI must not show an E2EE badge, encryption footer, or operator-blind claim.

> The vision document `dms-and-notes-vision.md` is the source of truth for product intent.
> This is the single end-state spec. No versions, no deferrals. Every feature here gets built.
> Build order is dependency-driven, not scope-driven — crypto before UI because correctness demands isolation, not because time is a constraint.

---

## Architecture decisions (final)

| Decision | Answer |
|----------|--------|
| E2E key holder | Client. `non-extractable` WebCrypto X25519 key in IndexedDB (web) / OS keychain (Tauri). wabiDB at-rest encryption is defense-in-depth, not the trust boundary |
| Key derivation | Mnemonic → 32 bytes (BIP39 seed + HKDF) → `importKey("raw", ..., "ECDH", false, ["deriveBits"])` as non-extractable. Deterministic per mnemonic. No server-side blob |
| Conversation key | Deterministic ECDH per pair: `convId = sha256(sort(a_pub, b_pub))`. Both sides compute same key, zero round-trips |
| Forward secrecy | **Yes.** X3DH + Double Ratchet for 1:1 (Signal-style). Builds on identities → prekeys → ratchet. Envelope has `v: 1` from day one for forward compat. Makes "forever" honest — key leak doesn't expose past messages |
| Posture name | **"Server-blind, not paranoid"** — bodies E2E + forward secrecy, metadata honest, no onion routing, no anonymity tax |
| Forever model | Server holds ciphertext indefinitely. Delivery-ack handshake, then optional local archive. Sidecar is cache, not source of truth |
| Retention rungs | **11**: view-once / 30s / 1m / 5m / 10m / 30m / 1h / 1d / 1w (default) / 1mo / forever. Forever requires explicit acknowledgment of unbounded exposure (mitigated by forward secrecy) |
| Groups | **In scope.** 1:1 built first (ratchet), then groups (pairwise fanout / MLS-style, re-key on membership change). Crypto supports N participants from commit one |
| Multi-device | **In scope.** BIP39 restores same logical identity on new device. Each device has its own prekeys. Message fanned to recipient's current device keys. Restore = same mnemonic → same keypair → same conversations |
| Friend tiers | **In scope, client-local.** Tiers are your private opinion — stored locally, never sent to server. Enforcement on recipient client (not gating server). Effect visible, label never shared |
| Cross-server contacts | **In scope.** Handshake ID (public key fingerprint) exchanged out-of-band. Contact inert until same server. Contact list stored server-side as metadata only |
| Reactions | **Encrypted like messages.** Emoji sealed with conversation key. Client-side tally (server can't aggregate). On-hover bar |
| Safety numbers | **In scope.** Key fingerprint comparison UI. QR scan for out-of-band verification |
| Read receipts | Opt-in per user, off by default. Reveals timing metadata — honest about it |
| Layout root | `LayoutRouter.svelte` — three-state dial: `dm-pure` / `dm-focused` / `server-browser` |
| Right-panel slot | **Repurposed** as auxiliary multitasking pane (second live DmConversationView). DM list stays a column; right panel hosts a conversation |
| Chat.svelte reuse | Never. Hard fork. `DmConversationView` independent component |
| Migration | Greenfield. No importer. Pre-strip ciphertext in dead schema, unrecoverable |
| Tauri vs web | Same crypto path, different key adapter. Tauri = OS keychain (full), web = IndexedDB (trial) |
| Multitasking model | Primary (center) + Auxiliary (right, 320px resizable) = two simultaneous live conversations. Tab strip of open DMs. Tauri pop-out for true multi-window |

---

## Build order (dependency-driven, not scope-driven)

### 1. Identities table (wabiDB projection)
```
identities {
  userId:        string (pk)
  publicKey:     bytes   // 32-byte X25519 public key
  signedPreKey:  bytes   // signed pre-key for X3DH
  oneTimePreKeys: bytes[] // one-time pre-keys for X3DH
  deviceId:      string  // per-device identifier
}
```
Each device has its own identity row (multi-device = multiple rows per user, same mnemonic-derived keypair, different deviceId). Client inserts via store mutation API. Other clients subscribe reactively.

### 2. Crypto domain (pure TypeScript, testable in isolation)
**`dmCrypto.ts`** — 100% WebCrypto:
- `generateDeviceIdentity(mnemonic)` — mnemonic → HKDF → X25519 keypair (non-extractable). Deterministic per mnemonic
- `deriveConversationKey(myPriv, theirPub)` — ECDH → HKDF(`"wabi/dm/v1"`) → AES-256-GCM key
- `seal(key, plaintext, aad)` — random 96-bit nonce, AES-256-GCM. Returns `{ v: 1, ct, iv }`
- `open(key, { v, ct, iv }, aad)` — decrypt. Throws on tamper/wrong key/wrong AAD
- `AAD = "${convId}|${msgId}|${senderId}|${expiresAt}"`

**`dmRatchet.ts`** — X3DH + Double Ratchet (Signal):
- `initiateSession(ownKey, theirPreKeyBundle)` — X3DH handshake → initial root key
- `ratchetStep(session, direction)` — DH ratchet → new sending/receiving chain keys
- `encryptMessage(session, plaintext, aad)` — ratchet + seal
- `decryptMessage(session, { v, ct, iv }, aad, header)` — ratchet + open
- Session state: `{ rootKey, sendingChain, receivingChain, DHs, DHr, PN, Ns, Nr }`
- Prekey bundles: `{ identityKey, signedPreKey, preKeySignature, oneTimePreKey }`

**`dmRecovery.ts`** — BIP39 mnemonic → key:
- 12-word BIP39 mnemonic → seed → HKDF(`"wabi-dm-identity"`) → 32 bytes → `importKey("raw", ..., "ECDH", false, ["deriveBits"])`
- Public key is deterministic. Same mnemonic → same keypair on every device
- Layout preference stored alongside (BIP39 password field or separate encrypted blob)
- First-run prompt: re-enter 3 random words from phrase, or explicit loss-acceptance checkbox

**`dmKeyring.ts`** — key storage adapter:
- Web: IndexedDB (non-extractable handle, survives refresh, lost on site-data clear)
- Tauri: OS keychain plugin (persists through reinstall)
- Same interface, different backend. Selected at boot

**`dmEphemeralKeys.ts`** — in-memory session cache:
- Scoped to browser tab, never persisted
- Derived on first need, evicted on conversation close

**Crypto property tests:**
```
✓ seal(open(x)) === x
✓ tampered AAD → throws
✓ tampered ciphertext → throws
✓ wrong key → throws
✓ nonce uniqueness over 1_000_000 messages
✓ ratchet: 1000 messages forward, no key reuse
✓ ratchet: compromise past key cannot decrypt future messages
✓ mnemonic → deterministic keypair
✓ different mnemonic → different keypair
✓ mnemonic restored on new device produces same conversation IDs
```

### 3. Blind-server integration test (written alongside crypto, runs in CI)
```typescript
async function testServerCannotReadDMs() {
  const alice = await createClient('alice');
  const bob = await createClient('bob');
  const server = getServerStore();

  for (let i = 0; i < 200; i++) {
    await alice.sendDM(bob.userId, `message-${i}`);
  }

  for (const msg of ['message-0', 'message-199', 'hello secret']) {
    assert(!server.ciphertextIncludes(msg));
    assert(!server.logsIncludes(msg));
  }

  const bobMessages = await bob.getDMMessages();
  assert(bobMessages.length === 200);
  assert(bobMessages[0].plaintext === 'message-0');
}
```

### 4. Socket + store layer
- Un-stub `createDM(userId)` — emit `"create-dm"`
- Un-stub `getDMChannelIdForUser(a, b)` — search channel store, fallback to deterministic ID
- Wire `deleteDM(channelId)` — emit `"delete-dm"`

**Durable events** (wabiDB stream append + reactive push):
```
dm-send-message      → dm-message-new
dm-reaction-add      → dm-reaction-added
dm-reaction-remove   → dm-reaction-removed
dm-mark-read         → dm-read-receipt
dm-retention-set     → dm-retention-changed
dm-request-accept    → (conversation activated)
dm-request-decline   → (request deleted)
```

**Ephemeral events** (socket-only, never stored):
```
dm-typing-start      → dm-typing
dm-typing-stop
```

Backend: `dm_messages.rs`, `dm_reactions.rs`, `dm_retention.rs` — append to wabiDB stream, emit notification.

### 5. Layout router + three-state dial
- `LayoutRouter.svelte` — reads `ui.homeLayout`, mounts one of three states: `dm-pure`, `dm-focused`, `server-browser`
- Right-panel slot repurposed as auxiliary multitasking pane (not removed)
- Mode toggle in 52px rail: one tap, 120ms cross-fade. Persists localStorage + account profile (restored via BIP39)
- `dm-pure`: rail shows only you — zero server icons. Indistinguishable from standalone messenger
- `dm-focused`: rail = Home, Requests, then servers collapsed below (LINE default)
- `server-browser`: channels take the stage; DMs collapse to the rail (existing layout)

### 6. DmConversationView (fresh component, no Chat.svelte)
Header: avatar, name, presence dot, last-seen, retention badge, call buttons, note action. Add encryption status only after the verified E2EE release gate passes.
Composer: text input, send on Enter, per-message retention override, no @mentions
Message list: virtualized scrollback, decrypted client-side
Message item: bubble, hover reactions (encrypted), retention chip, promote-to-note, edit/delete own
Footer: no encryption guarantee in the current product.

### 7. Multitasking — aux pane, tabs, pop-out
- `DmSecondaryPanel.svelte` — right panel (320px, resizable) hosting a second DmConversationView
- `pinnedDmChannelId` store alongside existing `selectedDmChannelId` (primary)
- Tab strip: array of open conversation IDs across the top of the DM list
- Pin-to-aux: drag or click a tab into the right pane for side-by-side
- Tauri pop-out: open a DM in its own OS window (true multi-window multitasking)
- Mobile collapses to a swipeable tab row (no panes)

### 8. DmListPanel + People
Home column: People (online-first) → Conversations (pinned/recent, preview, unread) → Requests → Notes
PeoplePicker (replaces CreateDMModal): inline, searchable, returns conversation ID or starts request
PeopleWelcome: empty state, handle/QR, browse servers
Friend tiers (client-local): People context menu → tier selector. Enforcement on recipient client

### 9. Rip `type === 'dm'` from Chat.svelte (after DmConversationView proven)
```
CI regression:
  ✓ selecting a dm never mounts Chat.svelte
  ✓ right panel hosts a conversation (DmConversationView) — never a DM list
  ✓ channel sidebar filters type !== 'dm'
  ✓ dm-pure mode hides the server rail entirely
```

### 10. Retention
11 rungs. Lazy deletion on read as primary (fetch → delete expired before return). Daily sweeper as backstop. View-once: deleted on first open. Forever: no TTL, forward secrecy protects against key leak.

### 11. DM request flow
Stranger → Requests tray. Preview decrypted (sandboxed plaintext only). Accept/Decline/Block. Existing contacts skip request step.

### 12. Encrypted reactions
On-hover bar. Emoji sealed with conversation key (ratchet key). Client-side tally. No server sees emoji or count.

### 13. Groups
Pairwise fanout per recipient using their ratchet session. Re-key on membership change. Compound avatar, named, owner-set retention. Aggregate read state (read N/M).

### 14. LINE mode polish
Three-state dial UX (dm-pure/dm-focused/server-browser). People drawer (slide-over, transient). Honest banners: web trial, single-device, forever acknowledgment, server-blind posture.

### 15. Notes cross-surface
Promote-to-note: client-side copy (decrypt → write to Notes stream). Notes = QuickScratchpad (already exists). `dmCrossSurface.ts` defines the seam.

### 16. Safety numbers / QR verification
Key fingerprint = SHA-256(raw public key). QR encodes `wabi://verify?fp=<fingerprint>&h=<handle>`. Side-by-side compare in encryption-info sheet.

### 17. Multi-device fanout
Each device has its own identity row + prekeys. Messages encrypted to all of recipient's current device keys. BIP39 restores same logical identity on new device.

### 18. Cleanup
Delete orphaned CSS. Remove dead socket stubs. No migration importer — greenfield.

---

## File manifest (final)

**Frontend components** — `frontend/src/lib/components/dm/`:
```
DmListPanel.svelte
DmListItem.svelte
DmPeopleList.svelte
DmConversationView.svelte
DmSecondaryPanel.svelte     (auxiliary multitasking pane — right panel)
DmMessageList.svelte
DmMessageItem.svelte
DmMessageInput.svelte
DmRetentionPicker.svelte
DmEncryptionBadge.svelte
DmRetentionBadge.svelte
DmRequestBanner.svelte
DmHonestBanner.svelte
DmFocusToggle.svelte
DmFocusLayout.svelte
PeoplePicker.svelte
PeopleWelcome.svelte
```

**Frontend modules** — `frontend/src/lib/dm/`:
```
dmCrypto.ts
dmRatchet.ts
dmRecovery.ts
dmKeyring.ts
dmEphemeralKeys.ts
dmStore.ts
dmCrossSurface.ts
```

**Stores:**
```
selectedDmChannelId    (primary — center pane, existing)
pinnedDmChannelId      (aux — right pane, new)
dmOtherUser            (existing)
openTabs               (tab strip of open conversation IDs, new)
homeLayout             (dm-pure | dm-focused | server-browser, existing)
```

**Root component:**
```
LayoutRouter.svelte
```

**CSS:**
```
dm-list.css
dm-conversation.css
dm-focus.css
```

**Backend Rust files:**
```
core/crates/wabi-server/src/socketio/dm_messages.rs
core/crates/wabi-server/src/socketio/dm_reactions.rs
core/crates/wabi-server/src/socketio/dm_retention.rs
```

**Backend projections:**
```
core/crates/wabidb/src/projections/dm_reactions.rs
```

**Edited files:**
```
frontend/src/lib/socket.ts
frontend/src/lib/workspacePanels.ts
frontend/src/lib/components/WorkspacePanelHost.svelte
frontend/src/lib/components/Chat.svelte
frontend/src/lib/components/ChatHeader.svelte
frontend/src/lib/components/ChatComposer.svelte
```

---

## Security-claim release gate

Do not publish an E2EE, forward-secrecy, ciphertext-only, recovery, or operator-blind posture statement until the complete production send/receive, attachment, downgrade, key-change, recovery, and multi-device test suite passes. Current DMs are server-readable.
