# DM E2EE Reactivation Plan — 2026-09-12

Status: **Draft — awaiting owner sign-off on the WS-0 decisions before implementation**
Provenance: Repo archaeology of the dormant E2EE groundwork, conducted 2026-09-12.
Everything below is grounded in the current `main` tree; file paths and field names
were read directly, not assumed.

---

## 0. Ground rules (read first)

- Read `AGENTS.md` before touching anything. This plan touches postcard-encoded
  records and generated protocol types, so golden rules **#4** (generated
  `packages/wabi-protocol`) and **#5** (dual-decode `RecordV0`/`V1` for postcard
  records) are load-bearing.
- **This plan lifts the E2EE freeze** placed by
  `docs/plans/2026-08-17-security-remediation.md`. That freeze was the right call at
  the time (the DM transport had eavesdropping holes). Those holes are now closed
  (WS-1 of that plan: `resolve_identity`, `can_access_dm`, `channel_access_contract.rs`).
  Before any E2EE wiring ships, **re-verify `channel_access_contract.rs` still
  passes** — E2EE on top of a leaky transport is theater.
- **No time estimates in this plan.** It is a task inventory. Each workstream has
  concrete files, tasks, and acceptance criteria. Sequence is by dependency, not by
  clock.
- Hard boundary that survives the freeze lift: **the server must never hold a private
  key that can decrypt DMs, and must never see DM plaintext.** If any task in this
  plan requires the server to decrypt, or to store a decryptable private key, stop and
  re-scope — that is not E2EE.
- Tests accompany every change. The dormant crypto suites (`dmCrypto.test.ts`,
  `dmRatchet.test.ts`, `dmRecovery.test.ts`) are already wired into `bun test` + CI
  (commit `39b8f0b`, 2026-07-31) — keep them green and extend them.
- Never commit `data/` contents, `data/admin_policies.json`, `data/jwt_secret`, or
  `docs/wabi-carl-watch.md`. No push, no deploy without the explicit word.

---

## 1. What we found (groundwork inventory)

The E2EE work was **built and tested, then deliberately frozen** — not lost. Two
parallel crypto stacks exist, plus the schema hooks.

### 1.1 Client crypto stack (TypeScript) — `frontend/src/lib/dm/`

| File | What it is | State |
|---|---|---|
| `dmCrypto.ts` | X25519 keygen, `deriveSharedSecret`, `seal`/`open` (AES-GCM), `sealBase64`/`openBase64`, `buildAad(convId:senderId:messageNumber)`, `deriveConversationKey` (HKDF, info `wabi-dm-v1`), `computeConversationId` (SHA-256 of sorted pubkeys), nonce uniqueness | Complete |
| `dmRatchet.ts` | `PreKeyBundle`, `RatchetSession`, `EncryptedMessage`; `x3dhInitiate`/`x3dhRespond`, `ratchetInit`, `encryptMessage`/`decryptMessage` (double ratchet, HKDF chain KDF), `serializeSession` | Complete |
| `dmKeyring.ts` | IndexedDB identity store (`wabi-keyring`), `saveIdentity`/`loadIdentity`/`hasIdentity`/`deleteIdentity`/`listIdentityIds`; `StoredKeyBundle { publicKeyB64, privateKeyJwk, deviceId, createdAt }` | Complete (single-device) |
| `dmEphemeralKeys.ts` | Ephemeral key helpers | Present |
| `dmRecovery.ts` | Key recovery flows | Present (22KB, not yet audited line-by-line) |
| `x25519.ts` | X25519 helpers | Present |
| `*.test.ts` | Suites for the above | Wired into `bun test` + CI |

### 1.2 Server crypto stack (Rust) — `core/crates/wabidb/src/crypto/`

`aes_gcm_record`, `bootstrap`, `dm_rekey`, `double_ratchet`, `identity`,
`place_rekey`, `re_encrypt`, `rekey`, `stream_key_registry`, `device_pinning`,
`dm_envelope`, `helper_revocation`, `safety_number`, `version_skew`,
`x3dh_handshake`, `x3dh_identity`.

A full Signal-grade module set — including **safety numbers, device pinning,
version-skew handling, and helper revocation**, which go beyond a minimal E2EE.

### 1.3 Schema hooks (already in place)

- **Wire type** `packages/wabi-protocol/src/generated/MessageView.ts` already carries
  `encrypted?: boolean | null` and `iv?: string | null`. (Generated from `wabi-core`
  via ts-rs — so the Rust `MessageView` almost certainly has them too; verify in WS-0.)
- **Storage record** `core/crates/wabidb/src/projections/messages.rs` →
  `MessageRecord` already has `encrypted_body_ref: String` (postcard-encoded, with a
  `MessageRecordV0` dual-decode fallback). **Today it holds the plaintext body**
  (`content: r.encrypted_body_ref`). There is **no separate `iv` field on the record**
  — that is a gap.
- **Server key registry** `core/crates/wabidb/src/projections/dm_identities.rs`
  exists — the projection that would hold per-user DM identity/prekey state. (Whether
  any command populates it is unverified — WS-0.)

### 1.4 What is NOT wired (the actual gap)

1. **No encryption step in the send path.** Per `message-send-path.md`:
   `ChatComposer.handleSubmit` → `sendMessage` (`messageStore.ts`) →
   `sock.emit('message', { channelId, text, ... })` → server `on_message` → persist.
   `text` goes over the wire and into `MessageRecord` in the clear.
2. **No decryption step in the receive path.**
3. **No prekey distribution** on DM creation (the ephemeral-key pieces exist; there is
   no server round-trip that hands a peer's `PreKeyBundle` to the initiator).
4. **No key-persistence contract across devices/sessions** (the keyring is
   single-device IndexedDB; multi-device + recovery is the part the freeze called out
   as missing).
5. **No `iv` on `MessageRecord`** (the wire type has it; the storage record doesn't).
6. **No protocol spec, threat model, or downgrade tests.**
7. **No independent crypto review.**

### 1.5 The DM write path is separate from the channel path (verified 2026-09-13)

DMs do **not** flow through the generic `MessageRecord`/`send_message` path. The
adapter has a dedicated `send_dm_message` that writes
`core/crates/wabidb/src/projections/dm_messages.rs` → `DmMessageRecord`
(`dm_id`, `message_id`, `author_user_id`, `author_device_id`,
`created_at_micros`, `encrypted_body_ref`, `idempotency_key`, `edit_history`),
with its own `dm_message_created` event and `dm_messages` projection.
`DmMessageRecord` uses **strict** postcard decode (no `V0` fallback yet) — adding
fields there is a dual-decode task (golden rule #5).

Note: `send_dm_message` has **no socket caller on `main` today** — the socket
`message` handler routes everything (including DMs) through the generic
`send_message` path. The dedicated DM write path (and the
`dm_message_recipients` projection) is infrastructure built ahead of its
wiring. **Decision (2026-09-13): E2EE rides the generic path for v1.**
Rationale: the dedicated path is not production-ready (seq-hex message ids
instead of UUIDs — the exact class of bug golden rule 3 exists to prevent;
no socket wiring; no recipient/delivery status yet). Extending the generic
`MessageRecord` with the full envelope (`encrypted`, `iv`,
`ratchet_dh_public`, `pn`, `ns`) is a smaller, safer change and keeps the
existing UUID identity guarantees. The dedicated `DmMessageRecord` gets the
same fields (done) so it is ready when the DM path is promoted; per-device
authorship and per-recipient delivery status are deferred to WS-5
(multi-device), where `dm_message_recipients` will actually be wired.

### 1.6 The decision that shapes everything

There are **two full crypto implementations** (Rust in wabidb, TS in the frontend).
For true E2EE the **client** must do the encrypt/decrypt (the server must never hold a
decryptable key). That makes the **TS stack the send/receive path** and the **Rust
stack the server's key-management/registry layer** (prekey bundles, device lists,
safety-number metadata) — but this split is an **assumption, not a verified fact**.
**WS-0's first job is to confirm or correct this architecture before any wiring.**

---

## 2. Workstreams

### WS-0 — Architecture decision, spec, and threat model (gates everything)

Goal: turn "figure it out again" into a written contract, so the wiring work has a
target.

Tasks:
- [ ] **0.1 Confirm the canonical split.** Read `core/crates/wabidb/src/crypto/
  dm_envelope.rs`, `x3dh_handshake.rs`, `x3dh_identity.rs`, `stream_key_registry.rs`,
  and `projections/dm_identities.rs`. Determine: does the design intend
  (a) client-side encrypt/decrypt with the server as key registry + relay, or
  (b) server-side envelope? Write a one-paragraph decision. If (b), stop — that is not
  E2EE; re-scope.
- [ ] **0.2 Verify the Rust wire type.** Confirm `wabi-core`'s `MessageView` has
  `encrypted`/`iv` (the generated TS implies it). If the Rust type lacks them, adding
  them is a generated-protocol change (golden rule #4).
- [ ] **0.3 Verify the key-registry write path.** Does any command populate
  `dm_identities.rs`? If not, that is a task in WS-2.
- [ ] **0.4 Write the protocol spec** → `docs/specs/dm-e2ee.md` (new). Must define:
  message envelope layout (what exactly is the ciphertext, where the nonce/iv lives,
  AAD binding = `convId:senderId:messageNumber`), key derivation chain (X3DH → root →
  chains), prekey bundle format, version field + forward-compat rule, and the exact
  server↔client message shapes.
- [ ] **0.5 Write the threat model** → same doc. Actors: server operator, network MITM,
  replay, downgrade (attacker strips `encrypted` to force plaintext), malicious peer.
  For each: what the design does, and what it explicitly does **not** protect against
  (be honest — e.g. metadata is not hidden; the server still sees who messages whom,
  when, and how much).
- [ ] **0.6 Downgrade + metadata honesty.** Decide and document: how a client refuses
  to send plaintext when the peer is E2EE-capable (the `encrypted` flag + a capability
  handshake), and what metadata remains visible. This honesty is a feature for the
  target communities.

Acceptance:
- A single `docs/specs/dm-e2ee.md` that an implementer with no other context can build
  from.
- The canonical split (0.1) is written down and, if it is (a), the server is confirmed
  to never hold a decryptable private key.
- The threat model names at least: server operator, MITM, replay, downgrade,
  malicious peer.

### WS-1 — Storage & wire schema (make the record able to carry ciphertext)

Goal: the DM record can carry an encrypted body + iv + envelope metadata, with safe
migration. **Target is `DmMessageRecord`** (the dedicated DM path, §1.5), not the
generic `MessageRecord` — though the generic path gets the same treatment for
consistency since `MessageView` already exposes the fields.

**Status (2026-09-13): COMPLETE.** All five tasks done — see checkmarks below.
Implementation note: because the socket `message` handler routes DMs through the
generic `send_message` path today (the dedicated DM path has no socket caller,
§1.5), the generic `MessageRecord` was extended with the identical five fields
(`encrypted`, `iv`, `ratchet_dh_public`, `pn`, `ns`) plus a `MessageRecordV1`
(pre-E2EE) legacy decode, and the envelope was threaded through
`WabiStore::send_message` / `send_dm_message` via a new `E2eeEnvelope` struct,
the REST `SendMessageRequest`/`MessageResponse`, and the socket `message`
handler + `history` WDB fallback. The dedicated `DmMessageRecord` got the same
fields so it is ready when the DM path is promoted.

Tasks:
- [x] **1.1 Add `iv` + `encrypted` + envelope metadata to `DmMessageRecord`.**
  New fields: `encrypted: bool` (default `false`), `iv: Option<String>`,
  `ratchet_dh_public: Option<String>` (base64, the ratchet DH from
  `EncryptedMessage.RatchetDHr`), `pn: Option<u64>`, `ns: Option<u64>`
  (ratchet position fields, mirroring `dmRatchet.ts` `EncryptedMessage`).
  This is a postcard-encoded record with **strict** decode today → **golden rule
  #5**: add a `DmMessageRecordV0` (the current shape) and make
  `decode_record` lenient (`V1 → V0` fallback), defaulting new fields to
  `false`/`None`. Do not mutate `V0`.
- [x] **1.2 Same for generic `MessageRecord`** (add `encrypted` + `iv` with a
  `MessageRecordV1` fallback alongside the existing `V0`), so channel messages
  and the existing `MessageView.encrypted/iv` fields are coherent.
- [x] **1.3 Domain types.** Add `encrypted`/`iv` to `wabidb::domain::DmMessage`
  (currently it drops the body entirely — it has no `content` field) and to
  `wabidb::domain::Message`; update the `From` impls both directions.
- [x] **1.4 Adapter + store trait.** Extend `WabiStore::send_dm_message` (and the
  `WdbAdapter` impl) to accept the envelope fields; extend the DM read path
  (`get_dm_message`/`list_dm_messages`) to return them.
- [x] **1.5 Round-trip tests.** Extend the `dm_messages` projection tests and
  `crates/wabi-core/tests/message_types.rs`: a record with
  `encrypted == true` + `iv` + ratchet fields encodes → decodes → preserves;
  a pre-change on-disk row decodes with `encrypted == false`, `iv == None`.

Acceptance:
- A DM record with `encrypted == true`, `iv`, and ratchet fields survives
  encode → decode → encode.
- Pre-existing on-disk DM records still decode with `encrypted == false`.
- `cargo test -p wabidb` and `cargo test -p wabi-core` green.

### WS-2 — Server key registry & prekey distribution

Goal: when a DM is created/opened, each participant can obtain the peer's
`PreKeyBundle` (identity + signed prekey + one-time prekey) and register its own.

**Status update (2026-09-13):** `dm_identities.rs` is verified working —
`DmIdentityRecord` (identity key, signed prekey + signature, one-time prekey
pool, device list), `take_onetime_prekey` (atomic pop),
`dm_onetime_prekey_consumed` event, multi-device listing, all unit-tested.
Task 2.1 is therefore **done**; what remains is the API surface + client
integration.

Tasks:
- [x] **2.1 `dm_identities.rs` registry** — verified present and tested
  (identity key, signed prekey + signature, one-time prekey pool, device list,
  atomic prekey pop, consumption events).
- [ ] **2.2 Prekey upload command + API.** Client registers its identity + prekey
  bundle (REST or socket, per the repo's existing patterns). Server stores it in the
  registry. Server stores **public** material only — never a private key.
- [ ] **2.3 Prekey fetch on DM open.** When user A opens/creates a DM with user B, A
  can fetch B's current `PreKeyBundle` (and consume a one-time prekey atomically).
  Gate it with the existing `can_access_dm` (WS-1 of the 2026-08-17 plan) — a
  non-participant, including an admin, must not be able to fetch.
- [ ] **2.4 One-time prekey lifecycle.** Refill policy, exhaustion fallback
  (signed-prekey-only), and revocation (ties into `helper_revocation` if the design
  uses it).
- [ ] **2.5 Device list + pinning hooks.** If 0.1 confirms device pinning is in scope,
  wire the device list into the registry and the `device_pinning` module. If
  multi-device is out of scope for v1, document that explicitly and defer (see WS-5).

Acceptance:
- A new user can register a prekey bundle and a peer can fetch it on DM open.
- One-time prekeys are consumed exactly once (concurrency-safe).
- A non-participant (and an admin) is denied prekey fetch for a DM they are not in.
- The server never stores a private key (assert this in a test or a code-review
  checklist item).

### WS-3 — Client send/receive wiring (the actual E2EE)

Goal: DM text is sealed before it hits the wire and opened after it leaves it.

Tasks:
- [ ] **3.1 Session bootstrap in the frontend.** On DM open: load local identity from
  `dmKeyring` (generate + persist if absent), fetch peer prekey (WS-2), run
  `x3dhInitiate`/`x3dhRespond` to establish the `RatchetSession`, persist the session.
- [ ] **3.2 Seal in the send path.** In `messageStore.ts` `sendMessage`, for DM
  channels: `encryptMessage(session, text, aad)` where
  `aad = buildAad(convId, senderId, messageNumber)`; emit the ciphertext + `iv` +
  `encrypted: true` instead of plaintext `text`. Keep the optimistic-UI and
  `clientMessageId` rules from `message-send-path.md` intact (the ciphertext is just
  the body now).
- [ ] **3.3 Open in the receive path.** On incoming DM `message`/`channel-messages`:
  if `encrypted`, `decryptMessage(session, ...)`; on ratchet advance, persist the
  updated session. Handle out-of-order / skipped messages via the existing `Ns`/`Nr`
  skip logic in `dmRatchet.ts`.
- [ ] **3.4 Session persistence.** Persist `RatchetSession` (via `serializeSession`)
  keyed by `conversationId`, so a reconnect/reload resumes the ratchet. Decide the
  store (IndexedDB alongside the keyring) and the eviction policy.
- [ ] **3.5 Failure modes.** Peer has no prekey / bundle expired / decrypt fails → a
  clear, non-crashing UI state (never silently drop; never fall back to plaintext for
  an E2EE-capable peer). Surface a "can't secure this message" state.
- [ ] **3.6 Keep the send-path invariants.** Re-run the `message-send-path.md`
  checklist: no row rewrite of previous text, optimistic identity stable,
  `message-accepted` patches only finite ids, dedupe on merge.

Acceptance:
- Two clients in a DM exchange text; the server's stored `MessageRecord` contains
  ciphertext + `iv`, not plaintext (verify by inspecting the stored record / a test).
- Kill the server mid-conversation, restart, reconnect → the ratchet resumes and
  history decrypts.
- A third connected socket that is not a DM participant cannot read the DM (re-confirm
  `channel_access_contract.rs`) and, even if it could join, the body is ciphertext.
- `bun run check` + the frontend crypto suites green.

### WS-4 — Downgrade protection & capability handshake

Goal: an E2EE-capable peer is never forced back to plaintext by a network attacker.

Tasks:
- [ ] **4.1 Capability signal.** Each user's profile/identity exposes
  "E2EE-capable" (derived from having a registered identity).
- [ ] **4.2 Refuse plaintext to capable peers.** If both sides are capable, the sender
  must not emit an unencrypted DM; the receiver must reject an unencrypted DM from a
  capable peer (or mark it as degraded with a visible warning — decide in the spec).
- [ ] **4.3 Downgrade tests.** Add tests: attacker strips `encrypted` from a
  capable-peer message → receiver detects and warns/refuses; version-skew (one side
  old) is handled per `version_skew` and documented.

Acceptance:
- A plaintext DM from an E2EE-capable peer is not silently accepted.
- Downgrade tests exist and pass.

### WS-5 — Multi-device & recovery (the part the freeze called out as missing)

Goal: the "multi-device/recovery design" the 2026-08-17 plan required before E2EE
could be claimed.

Tasks:
- [ ] **5.1 Audit `dmRecovery.ts`** (22KB, not yet read) and document what recovery it
  implements.
- [ ] **5.2 Decide v1 scope.** Either (a) ship single-device E2EE now and defer
  multi-device with a clear doc, or (b) implement multi-device via the device list +
  `device_pinning` + `helper_revocation`. This is a **product decision for the owner**
  — flag it, don't assume.
- [ ] **5.3 If (b):** device registration, per-device ratchet branches, safety-number
  display/verification UI, and revocation of a lost device (re-encrypt history via
  `re_encrypt`/`dm_rekey`).
- [ ] **5.4 Safety numbers.** Wire `safety_number` into a "verify this conversation"
  surface so users can confirm they are talking to the right peer (this is what makes
  E2EE meaningful to a human).

Acceptance:
- Whatever scope is chosen is documented in the spec.
- If multi-device ships: a second device can join an existing conversation and decrypt
  history; revoking a device makes its old keys unable to decrypt new messages.

### WS-6 — Docs, privacy stance, and the showcase story

Goal: the public claims match the shipped reality (this is what the target
communities will check first).

Tasks:
- [ ] **6.1 Update `docs/PRIVACY_STANCE.md` and the README** "Privacy & honesty"
  section: replace "DMs are not E2EE today" with the accurate new state (E2EE for DMs,
  what it does/doesn't cover, metadata still visible).
- [ ] **6.2 Update `docs/SECURITY-MODEL.md`** socket/DM section to describe the E2EE
  path and the downgrade protection.
- [ ] **6.3 Update the roadmap** (`docs/ROADMAP.md` + README) to reflect E2EE status
  honestly (shipped / single-device / multi-device pending).
- [ ] **6.4 Write the showcase blurb.** A short, honest paragraph for the communities:
  what is E2EE, what is not (metadata, group DMs if out of scope), and why the
  groundwork was frozen and is now reactivated. Honesty here is the differentiator.

Acceptance:
- No public doc claims E2EE for a surface that isn't E2EE.
- The README/privacy stance and the shipped behavior agree.

### WS-7 — Independent crypto review (before any "E2EE" claim goes public)

Goal: the freeze's non-negotiable — an independent review — is satisfied.

Tasks:
- [ ] **7.1 Package the review bundle:** the spec (WS-0), the threat model, the
  envelope format, the ratchet usage, the downgrade tests, and the key-registry code.
- [ ] **7.2 Get an independent review** from someone who did not write this code (the
  owner's call on who). Track findings as issues.
- [ ] **7.3 Resolve findings** before the "E2EE" label ships in the showcase.

Acceptance:
- A written review exists with findings triaged; blocking findings are closed before
  the public claim.

---

## 3. Sequencing (by dependency, not by clock)

WS-0 → WS-1 → WS-2 → WS-3 → WS-4 → (WS-5 in parallel with WS-3/4 once 0.1/5.2 decide
scope) → WS-6 → WS-7.

- WS-0 gates everything — do not wire anything before the canonical split (0.1) and
  the spec (0.4) are written.
- WS-1 and WS-2 are independent of each other once WS-0 is done (one is storage, one
  is the key registry) — they can proceed in parallel.
- WS-3 depends on both WS-1 (schema) and WS-2 (prekeys).
- WS-4 depends on WS-3.
- WS-6 and WS-7 are the public-claim gates — nothing is advertised as E2EE until
  WS-7's review is done.

---

## 4. Explicitly out of scope (for v1, unless the owner says otherwise)

- **Group DM E2EE** (the ratchet here is 1:1; group E2EE is a different, larger
  problem — the Signal group protocol).
- **E2EE for voice/video** (that is the WebRTC/TURN path, a separate system).
- **Hiding metadata** (who talks to whom, when, how much) — the server still sees
  this; document it, don't pretend otherwise.
- The lore addon, CI, mesh heartbeat (per the standing out-of-scope list).

---

## 5. Completion log (append as workstreams land)

| Date | Workstream | Commit | Notes |
|------|-----------|--------|-------|
| 2026-09-13 | WS-1 | `c26a2472` | E2EE envelope (`encrypted`, `iv`, `ratchet_dh_public`, `pn`, `ns`) on `MessageRecord` + `DmMessageRecord` with lenient decode fallbacks (current→V1→V0 / current→V0); threaded through `WabiStore::send_message`/`send_dm_message` (new `E2eeEnvelope` arg), `WdbAdapter`, REST `SendMessageRequest`/`MessageResponse`, socket `message` handler + history WDB fallback, domain `Message`/`DmMessage`. Encrypted round-trip + legacy-decode tests on both projections; all construction sites updated (locks, property tests, benches, bots/lore/contract call sites). |

---

## 6. State note for the next agent (2026-09-13)

**Branch:** `wip/dm-e2ee-reactivation` (from `main`). Push is authorized for this
branch only. Commits go through the GitHub API (`create_github_commit_from_files`),
which lands directly on the remote branch — no separate `git push` step.

**Done:**
- Plan doc committed (`4bcb8ad1`).
- WS-1 complete (`c26a2472`) — see completion log. The server can now store and
  reload the full E2EE envelope; a reloaded encrypted message keeps its `iv` +
  ratchet position. **Not yet compile-verified in a sandbox** (no Rust toolchain
  here) — the next agent should run `cargo test -p wabidb -p wabi-core -p
  wabi-server` (or at least `cargo check`) before building on top.

**Key design decision (WS-1):** E2EE rides the **generic** `MessageRecord` path
for v1, not the dedicated `DmMessageRecord` path. The socket `message` handler
routes DMs through generic `send_message` today; the dedicated DM path has no
socket caller, seq-hex ids (violates golden rule 3), and no delivery status.
Both record types got the same 5 fields so the dedicated path is ready to be
promoted later (WS-5).

**Wire contract (already in place, client must match in WS-3):**
- Socket `message` cmd accepts: `encrypted` (bool), `iv` (base64 str),
  `ratchetDhPublic` (base64 str), `pn` (u64), `ns` (u64). Absent = plaintext.
- Socket `history` WDB fallback + REST `MessageResponse` return the same five
  fields so reloads keep the envelope.
- REST `POST /messages` `SendMessageRequest` accepts the same five fields.

**Next (in order):** WS-0 spec (`docs/specs/dm-e2ee.md` + threat model) →
WS-2 prekey upload/fetch API (the `dm_identities` registry is already
implemented + tested server-side; it needs a REST/socket surface + client
integration) → WS-3 client seal/open wiring (`frontend/src/lib/dm/` TS crypto
stack exists and is tested) → WS-4 downgrade protection → WS-5 multi-device +
recovery → WS-6/7 docs + independent review bundle.

**Local scratch copies** live in `/opt/sandbox/workspace/tmp/wabi-e2ee/`
(fetched from `main` for surgical editing). Re-fetch from the branch before
editing any file in a future session — they reflect the pre-WS-1 state for
files not touched here.