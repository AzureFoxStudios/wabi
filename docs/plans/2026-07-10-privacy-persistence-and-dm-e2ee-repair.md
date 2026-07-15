# Privacy, Ephemeral Persistence, and DM E2EE Repair Plan

> For hy3: implement this plan in small, independently reviewable cards. Do not commit, rebase, change branches, or delete existing documentation. Run the stated tests after each card and stop at a failing contract instead of broadening scope.

**Goal:** Restore Wabi’s intended trust model: user content is memory-only unless explicitly persisted; opted-in public history is readable by the server owner; DMs and DM files are end-to-end encrypted so the server stores ciphertext only.

**Architecture:** Split message delivery by persistence class before any durable write occurs. `Off` messages use the existing in-memory/session fanout and never reach WabiDB. Persistent public messages use the normal WabiDB path and remain owner-readable. DMs use the existing browser X3DH/Double Ratchet primitives, but their live send/receive and attachment paths must be reconnected so the server only relays/stores ciphertext envelopes.

**Tech stack:** Rust/Axum/Socket.IO/WabiDB, SvelteKit/TypeScript, Web Crypto API, existing X3DH + Double Ratchet modules.

---

## Refinements from 2026-07-09 analysis

These corrections supersede earlier loose wording in the plan and any earlier audit summary.

- **Regulatory status (accurate as of 2026-07-09):** The EU "Chat Control"/CSAM Regulation is **not enacted**. The Council adopted a negotiating position on 2025-11-26; the current text removes mandatory detection and says the regulation must not weaken E2EE, require decryption, or access E2EE data. A voluntary-scanning derogation expired 2026-04-03; on 2026-07-02 the Council proposed reinstating it to 2028-04-03, but Parliament has not approved it. Do not claim the regulation is in force. The durable design goal stands regardless: Wabi must not possess private-message plaintext or recovery keys under normal operation.
- **Two independent axes, not one "encrypted" flag:** model confidentiality (`server_readable` vs `end_to_end`) separately from retention (`memory_only` / `timed` / `durable`). Ephemeral public chat is operator-readable live but not retained; it is NOT private from the operator. Only E2EE hides content from the operator.
- **Typed message envelope:** replace the generic `content: String` with an explicit `MessageBody` enum (`Plaintext` for server-readable channels, `EndToEndEncrypted` for DMs/private rooms). The server rejects `Plaintext` for E2EE conversations and rejects malformed encrypted envelopes.
- **Rename `encrypted_body_ref`:** the field currently holds plaintext for ordinary messages. Rename it to an honest name (e.g. `body`/`content_ref`) before any E2EE work; a field named "encrypted" that contains plaintext is an audit hazard.
- **Server-enforced DM downgrade rejection:** the API must refuse a plaintext body sent to a DM/private-room destination. This prevents a broken or malicious client from silently downgrading E2EE.
- **Group E2EE direction:** the existing repair targets DMs via the present X3DH/Double Ratchet code. For private group rooms, prefer **MLS (RFC 9420)** over inventing a group protocol; treat it as a separate follow-on workstream (Workstream B0 gate) that must pass an independent-audit/WASM/server-blind evaluation before any group-room feature is built on it.
- **Deployment trust boundary:** the Rust origin should bind to loopback or a private container network by default; public exposure requires an HTTPS reverse proxy or tunnel. A tunnel provides transport encryption only, not E2EE.

## Non-negotiable product contract

| Surface | Storage and key rule |
|---|---|
| Server default / public channel with policy `Off` | In-memory only. No WabiDB command, segment, index, projection write, backup record, or disk cache of message body. Lost on server restart. |
| Opted-in public channel | Durable WabiDB history. The server owner’s key can read/moderate/export it. |
| Persistent channel with timed retention | UI deletion is not enough. Retention must eventually remove ciphertext/plaintext from queryable state and compact old storage; do not call this “secure deletion” until the physical/key-destruction verification exists. |
| DM text and files | Client encrypts before sending/uploading. Server stores and fans out ciphertext/envelopes only. Server operator has no DM content key. |
| System metadata | Durable: users, channels, memberships, roles, persistence policy, audit metadata. Do not put message bodies in these streams. |

## Current facts that this work must correct

- `docs/persistence-policy-plan.md` defines opt-in persistence and says `Off` must skip `.wseg` and `.widx`, but it is marked planned.
- `core/crates/wabi-server/src/adapter/mod.rs:153-190` currently sends every message through WabiDB and assigns `content.to_string()` to `encrypted_body_ref`.
- `core/crates/wabi-server/src/socketio/messages.rs:58-65` sends plaintext to the durable adapter.
- `frontend/src/lib/messageStore.ts:112-147` emits plaintext `text` for ordinary messages.
- `frontend/src/lib/dm/dmRatchet.ts` contains crypto primitives/tests, but the live app does not import them for sending.
- `frontend/src/lib/components/chat/uploadOrchestrator.ts:71-100` hard-disables DM attachment encryption with `&& false`.
- `core/crates/wabi-server/src/api/upload.rs:320-345` writes uploads with `at_rest_encrypted: false`.
- `WdbAdapter::delete_message()` currently creates a deletion event; it does not prove the original durable event bytes are gone.

---

# Workstream A — persistence policy and true ephemeral delivery

## Card A1 — Lock down the policy contract with failing tests

**Objective:** Prevent another refactor from silently writing `Off` messages to disk.

**Files:**
- Create: `core/crates/wabi-server/tests/persistence_policy_contract.rs`
- Modify: `core/crates/wabi-server/Cargo.toml` only if the test target needs a missing dev dependency
- Reference only: `docs/persistence-policy-plan.md`

**Steps:**
1. Add a temporary-data-dir test that configures server default `Off`, sends one channel message, restarts/reopens storage, and asserts:
   - no durable message is listed;
   - the message body bytes are absent from files created below the temporary data directory;
   - a live connected recipient received the message before restart.
2. Add a matching `On` test proving the message survives restart and is readable through the normal authorized server history path.
3. Add resolver unit tests for precedence: user override → channel override → server default → fallback.
4. Run the focused test and confirm the `Off` test fails before implementation.

**Commands:**
```bash
cd /var/home/Ronin/wabi/core
cargo test -p wabi-server --test persistence_policy_contract -- --nocapture
```

**Acceptance:** The test names and assertions distinguish “not replayed” from “never written.” A test that merely checks the UI after restart is insufficient.

---

## Card A2 — Add a durable policy record for configuration, not message content

**Objective:** Persist only the policy configuration needed to resolve future message writes.

**Files:**
- Create: `core/crates/wabidb/src/projections/persistence_policies.rs`
- Modify: `core/crates/wabidb/src/projections/mod.rs`
- Modify: `core/crates/wabidb/src/engine/mod.rs`
- Modify: `core/crates/wabidb/src/domain/mod.rs` if a shared domain type is needed
- Create: `core/crates/wabidb/src/projections/persistence_policies_test.rs` or colocated module tests

**Steps:**
1. Define a minimal enum: `Off`, `Session`, `On`. Do not add `Custom` rule language in this card; leave it explicitly unsupported until a real rule format exists.
2. Define records keyed by one scope: `server_default`, `channel:<channel_id>`, or `user:<user_id>`.
3. Register the projection as a system stream so the policy survives restart regardless of message policy.
4. Implement pure resolution with the documented precedence order.
5. Test codec round trip, projection upsert, precedence, and restart/replay of policy records.

**Acceptance:** No message body or plaintext history is stored in this projection. No “default to On” fallback is introduced.

---

## Card A3 — Expose policy reads/writes through the WabiStore adapter

**Objective:** Let server handlers resolve policy without accessing WabiDB internals directly.

**Files:**
- Modify: `core/crates/wabidb/src/engine/wabi_store.rs`
- Modify: `core/crates/wabi-server/src/adapter/mod.rs`
- Modify: adapter unit tests in `core/crates/wabi-server/src/adapter/mod.rs` or existing adapter test module

**Steps:**
1. Add narrow WabiStore operations: get resolved message persistence and upsert server/channel/user policy.
2. Implement them in `WdbAdapter` through the policy projection.
3. Keep adapter operations typed; do not pass arbitrary JSON policy blobs.
4. Test `Off`, `Session`, and `On` resolution without invoking Socket.IO.

**Acceptance:** The only caller that chooses whether a message is durable uses this typed resolver. No handler infers durability from an absent/false frontend field.

---

## Card A4 — Make the Socket.IO channel-message path honor `Off`

**Objective:** Ensure an ephemeral message is faned out but never passed to `send_message`/WabiDB.

**Files:**
- Modify: `core/crates/wabi-server/src/socketio/messages.rs`
- Modify: `core/crates/wabi-server/src/socketio/shared.rs` only if view serialization needs an explicit ephemeral marker
- Test: `core/crates/wabi-server/tests/persistence_policy_contract.rs`

**Steps:**
1. Resolve the effective policy before the current `state.app.wdb.send_message(...)` call.
2. For `Off`, create a server-session-only message ID, add the message only to the existing in-memory session state if that state is needed for connected clients, and emit it to the channel.
3. Do not call WabiStore, sequencer, projection dispatcher, retention lookup, or backup logic for `Off` content.
4. For `On`, retain the present WabiDB path.
5. For `Session`, do not claim compliance until its exact storage/recovery semantics are implemented and tested. It may temporarily map to `On` only behind an explicit documented compatibility guard; it must never become the default silently.
6. Re-run A1 tests.

**Acceptance:** An `Off` message is visible to connected users, disappears after restart, and its sentinel body is not found under the WabiDB data directory.

---

## Card A5 — Make REST message creation use the same policy gate

**Objective:** Eliminate a bypass where HTTP message creation persists data that Socket.IO correctly treats as ephemeral.

**Files:**
- Modify: `core/crates/wabi-server/src/api/messages.rs`
- Modify/Create: shared server-side message-delivery helper under `core/crates/wabi-server/src/` if needed
- Test: extend `core/crates/wabi-server/tests/persistence_policy_contract.rs`

**Steps:**
1. Extract the policy decision/delivery primitive from A4 only if necessary to share it cleanly.
2. Route both REST and Socket.IO message creation through it.
3. Add one REST test for `Off` and one for `On`.
4. Confirm the REST response does not promise a durable ID for an `Off` message.

**Acceptance:** No second plaintext persistence path remains for normal channel messages.

---

## Card A6 — Wire owner setup and channel settings to policy, with honest labels

**Objective:** Give the server owner and channel administrators an explicit persistence choice.

**Files:**
- Modify: `core/crates/wabi-server/src/api/setup.rs` and `core/crates/wabi-server/src/api/routes.rs`, or the existing setup route location
- Modify: `core/crates/wabi-server/src/socketio/wiring_handlers.rs`
- Modify: `frontend/src/lib/components/sidebar/ChannelSettingsModal.svelte`
- Modify: the first-owner/setup Svelte surface that currently handles setup status
- Create/modify focused frontend tests if the repository has the matching test harness

**UI language:**
- `Ephemeral (default) — never written to this server’s message storage; lost when the server restarts.`
- `Persistent — saved as server history; server owner/admin policy can access it.`
- Do not display “secure deletion” or “private from the owner” for public channels.

**Steps:**
1. Server setup defaults user-content policy to `Off` once the owner completes setup.
2. Channel Settings exposes only `Ephemeral` and `Persistent` for this delivery. Do not expose half-built Session/Custom controls.
3. Persist policy changes in the system policy stream.
4. Verify a newly-created channel inherits server default and a channel override wins.

**Acceptance:** A fresh server’s default is visibly and functionally ephemeral. Existing installations receive a migration-safe explicit compatibility state, not a surprise destructive flip.

---

# Workstream B0 — MLS evaluation gate (must clear before building any private group rooms)

**Objective:** Prove the MLS library is sound, independently audited, and usable in Wabi's client/server shape before committing group E2EE to it. This is a go/no-go gate, not an implementation task. DM repair (B1–B6) uses the existing X3DH/Double Ratchet code and does not wait on this gate.

## Why this gate exists

The protocol (IETF RFC 9420) is open and has been formally verified (ProVerif, TreeKEM machine-checked proofs, NYU/Dodis analysis; the "Rogue" attack was found in public and fixed in the standard). The main Rust library, OpenMLS, had an independent security audit by SRLabs sponsored by the Sovereign Tech Agency (a public-interest body, not a vendor). Adoption by WhatsApp/Google confirms scale, not safety — and MLS is deliberately server-blind, which limits a malicious operator, not helps one.

The remaining risks are implementation-specific: pinned-dependency integrity, WASM build for the browser client, and whether OUR key directory can impersonate users. None of those are solved by "MLS exists." This gate forces proof before build.

## Card B0.1 — Pin and verify the OpenMLS dependency

**Objective:** Establish a known-good, reproducible MLS dependency.

**Files:**
- Create: `core/crates/wabi-server/Cargo.toml` entry (or a new `wabi-mls` crate) pinning OpenMLS to an exact audited version
- Create: `frontend/package.json`/WASM binding pin if the browser client will use OpenMLS via WASM
- Create: `docs/plans/mls-dependency-pin.md` recording the exact version + audit reference

**Steps:**
1. Pin a specific OpenMLS release that corresponds to the SRLabs-audited version; record the audit reference (blog.phnx.im OpenMLS independent security audit) and any post-audit fixes applied.
2. Verify the dependency builds with `cargo build -p wabi-mls` (or the relevant crate).
3. Run `cargo audit` and `cargo deny check` (or equivalent) and record zero unhandled advisories for the MLS dependency chain.
4. Document the exact commit/version so the build is reproducible.

**Acceptance:** A reproducible pin exists with a cited audit; no unhandled critical/high advisories in the MLS dependency tree.

---

## Card B0.2 — Prove OpenMLS compiles to WASM for the browser client

**Objective:** Confirm the library can run in Wabi's browser trust model, not just native.

**Files:**
- Create: a minimal WASM crate or `wasm-bindgen` wrapper exercising OpenMLS group create + add + send
- Create: a small browser/Node test that loads the WASM and performs one epoch transition

**Steps:**
1. Build the WASM target and confirm it loads in a headless browser/Node harness.
2. Perform one full group lifecycle: create group, add a member, advance epoch, send an encrypted message, have the second member decrypt.
3. Confirm no plaintext group content is observable in the serialized MLS messages the "server" would store/forward.

**Acceptance:** The WASM module runs the group lifecycle and produces server-blind ciphertext; build is reproducible.

---

## Card B0.3 — Prototype one private group room end to end (proof of concept only)

**Objective:** Demonstrate MLS for a private room before building product features on it.

**Files:**
- Create: `core/crates/wabi-server/tests/mls_private_room_poc.rs`
- Create: `frontend/src/lib/mls/mlsRoomPoc.test.ts` (or equivalent harness)
- Reference only: do NOT modify production room/composer code in this card

**Steps:**
1. Stand up one MLS group for a private room with 3 test devices.
2. Route MLS commit/welcome/message bytes through the existing WabiDB message path as opaque ciphertext (reuse the `EndToEndEncrypted` envelope from B2).
3. Verify membership change rotates the epoch and a removed member cannot decrypt subsequent messages.
4. Verify the server, holding all stored bytes + all server keys, cannot decrypt room content (server-blind test from the acceptance list).
5. Keep this as a PoC; no UI, no settings, no production wiring.

**Acceptance:** The PoC passes the server-blind test and the membership-removal test. Product group-E2EE work may begin only after this card passes and the user approves.

---

## Card B0.4 — Plan trust safeguards for the MLS deployment (design only)

**Objective:** Decide how Wabi prevents its own key directory from impersonating users. MLS gives group crypto; it does NOT give device trust.

**Files:**
- Create: `docs/plans/mls-trust-safeguards.md` (design doc, not code)

**Required design decisions:**
1. Append-only key-transparency log for device public keys.
2. Visible per-account device list; notify on add/remove.
3. Existing-device approval or user-held recovery secret before adding a device.
4. Safety numbers / QR verification for high-risk rooms.
5. Visible channel-membership-change log.
6. Protocol-level resistance to E2EE downgrade (reuse B4's DM downgrade rejection for rooms).
7. Reproducible build + transparent release record for the client, since the browser client is a weaker trust model.

**Acceptance:** The design doc exists and is approved before any private-group-room feature is built on MLS. No production code in this card.

**Gate outcome:** Only after B0.1–B0.4 pass and the user explicitly approves may hy3 proceed to implement private group rooms on MLS. If the gate fails (audit gap, WASM failure, server-blind test fails, or trust design rejected), fall back to keeping private group rooms as server-readable-with-owner-key (Workstream A durable path) and do NOT ship E2EE group rooms.

---

# Workstream B — DM E2EE restoration

## Card B1 — Write an E2EE integration contract before reconnecting UI

**Objective:** Turn the existing crypto promise into runtime-enforced behavior.

**Files:**
- Create: `frontend/src/lib/dm/dmE2eeIntegration.test.ts`
- Modify: existing crypto test runner only to include the new test
- Create: server integration test under `core/crates/wabi-server/tests/` for ciphertext persistence

**Required assertions:**
1. Sender produces ciphertext; plaintext bytes do not occur in the outbound DM envelope.
2. Recipient with the matching session decrypts correctly.
3. A server-side stored DM record contains ciphertext/header/envelope metadata, not plaintext.
4. A non-participant and a server-only test fixture cannot decrypt it.
5. A changed/tampered ciphertext is rejected.

**Acceptance:** These tests fail against the current live DM wiring before any code is changed.

---

## Card B2 — Define a ciphertext-only DM wire record

**Objective:** Remove the ambiguous plaintext `encrypted_body_ref` contract for DMs.

**Files:**
- Modify: `core/crates/wabidb/src/projections/dm_messages.rs`
- Modify: `core/crates/wabidb/src/domain/mod.rs`
- Modify: `core/crates/wabi-server/src/adapter/mod.rs`
- Modify: generated protocol source only through the project’s canonical generator, never by hand
- Tests: projection codec and migration tests

**Record requirements:**
- Rename the existing misleading `encrypted_body_ref` (it currently holds plaintext) to an honest field such as `content_ref`/`body` for server-readable records; keep ciphertext fields separate for E2EE records.
- Introduce an explicit `MessageBody` envelope (see Refinements section) so the server distinguishes `Plaintext` (server-readable only) from `EndToEndEncrypted`.
- DM/conversation ID
- message ID and sender device ID
- recipient device ID(s)
- ciphertext bytes/base64
- nonce/ratchet header and protocol version
- timestamp and non-sensitive delivery metadata
- no plaintext `content`, `text`, title, preview, or recovery phrase

**Steps:**
1. Version the ciphertext envelope (`dm-e2ee-v1`) rather than overloading generic channel fields.
2. Add backward-safe decode/migration handling for existing dev records; do not silently interpret plaintext historical rows as E2EE.
3. Ensure listing/retrieval returns the envelope only; decryption remains frontend-only.

**Acceptance:** Grepping a server-side serialized DM record never finds the test plaintext sentinel.

---

## Card B3 — Add device public-key and prekey publication/retrieval

**Objective:** Let clients establish the existing X3DH/Double Ratchet session without server access to private keys.

**Files:**
- Modify/Create WabiDB projection(s) for public identity/prekeys under `core/crates/wabidb/src/projections/`
- Modify: `core/crates/wabidb/src/engine/wabi_store.rs`
- Modify: `core/crates/wabi-server/src/adapter/mod.rs`
- Modify: authenticated API/socket routes for publishing and fetching public bundles
- Modify: `frontend/src/lib/dm/dmCrypto.ts` and/or a new `dmKeyStore.ts`

**Steps:**
1. Store only public identity keys, signed prekeys, and one-time prekeys on the server.
2. Keep private identity/prekey material in client storage protected by the user’s local encryption mechanism; never POST it.
3. Authenticate publication and retrieval; rate-limit bundle retrieval and consume one-time prekeys atomically.
4. Add tests proving the server record cannot reconstruct a private key.

**Acceptance:** Two fresh browser-client fixtures establish matching sessions using only server-held public material.

---

## Card B4 — Reconnect DM composer and receive flow to the ratchet

**Objective:** Replace plaintext DM sending with ciphertext envelopes end to end.

**Files:**
- Modify: `frontend/src/lib/messageStore.ts` or the actual DM-specific send entry point
- Modify: `frontend/src/lib/components/Chat.svelte` / `DmConversationView.svelte` only where DM routing occurs
- Modify: `frontend/src/lib/socketConnection*` receive handling
- Modify: `core/crates/wabi-server/src/socketio/` DM message handler(s)
- Modify: `core/crates/wabi-server/src/adapter/mod.rs`

**Steps:**
1. Branch on channel type before generic `sendMessage` emits plaintext.
2. For a DM, establish/load ratchet session, encrypt locally, persist updated ratchet state locally, and send only the DM envelope.
3. On receipt, store/display only after local decryption succeeds.
4. Add server-side enforcement: the DM endpoint must reject any `Plaintext` body or malformed encrypted envelope with a 4xx response. This is the backstop that prevents a broken or malicious client from silently downgrading an E2EE conversation to plaintext.
5. Render a clear locked/error state on missing session, changed device key, or decrypt failure; never fall back to plaintext.
5. Keep ordinary public-channel delivery on Workstream A’s persistence policy path.

**Acceptance:** Network payload capture in the test harness contains no DM plaintext; both participants see readable decrypted text; server history displays/stores only ciphertext.

---

## Card B5 — Restore encrypted DM attachments before upload

**Objective:** Prevent the current raw-DM-file upload behavior.

**Files:**
- Modify: `frontend/src/lib/components/chat/uploadOrchestrator.ts`
- Modify/Create: a focused DM attachment encryption helper under `frontend/src/lib/dm/`
- Modify: `core/crates/wabi-server/src/api/upload.rs`
- Modify: attachment metadata types through the canonical protocol generator
- Tests: frontend crypto/upload unit test plus server upload authorization test

**Steps:**
1. Remove the dead `&& false` branch and replace `await null` with an actual encrypt-before-upload implementation based on the established DM session/content key design.
2. Upload ciphertext bytes; retain only encrypted attachment metadata and non-sensitive MIME/size fields required for display.
3. Require authorization to fetch DM blobs; do not make ciphertext URLs broadly public if avoidable.
4. Decrypt only in the recipient client.
5. Mark `at_rest_encrypted` truthfully: it must reflect ciphertext upload, not merely a UI flag.

**Acceptance:** A raw attachment sentinel is absent from upload storage and server logs; sender and recipient can decrypt; a server-only fixture cannot.

---

## Card B6 — Device-change and recovery behavior

**Objective:** Avoid insecure key recovery shortcuts after E2EE is wired.

**Files:**
- Modify/Create: frontend DM key-state/recovery modules
- Modify: public-key/prekey server projection only for encrypted recovery blobs/public metadata
- Modify: DM settings UI
- Tests: recovery and changed-device warning flows

**Rules:**
- v1 may honestly be single-device if recovery is not complete.
- Do not upload private keys or recovery phrases in plaintext.
- Do not silently replace a contact key; require explicit user verification/re-approval.
- Do not claim forward secrecy until ratchet-state persistence and key-change behavior pass tests.

**Acceptance:** Product copy exactly matches the implemented recovery capability.

---

# Workstream C — retention and deployment honesty

## Card C1 — Make message expiry claims accurate and testable

**Objective:** Separate memory-only expiry, logical delete, and physical/key-based purge.

**Files:**
- Modify: `core/crates/wabi-server/src/socketio/messages.rs`
- Modify: `core/crates/wabi-server/src/adapter/mod.rs`
- Modify: WabiDB retention modules under `core/crates/wabidb/src/retention/`
- Create: retention integration tests

**Steps:**
1. Keep `Off` messages outside retention because they have no durable copy.
2. For durable timed messages, retain logical UI deletion as an immediate step.
3. Add a scheduled compaction/purge path for obsolete durable records/segments.
4. If per-message content keys are introduced, destroy them at expiry and test that ciphertext cannot be decrypted after destruction.
5. Audit snapshots/backups: retention must be applied before standby/archive export, or exports must have an explicit retention policy.

**Acceptance:** Documentation and UI distinguish `ephemeral (never written)` from `expires from server history`. No unsupported “disk wiped” claim is shown.

---

## Card C2 — Document network modes without requiring Cloudflare

**Objective:** Make self-hosting secure by default in documentation and visible runtime warnings while preserving LAN/Tailscale/CGNAT choices.

**Files:**
- Modify: `scripts/SELF-HOST-GUIDE.md`
- Modify: `docker-compose.yml`
- Modify: `Caddyfile.tunnel`
- Modify/Create: server startup warning or frontend connection-security warning
- Tests: config/documentation smoke checks where available

**Rules:**
- Localhost/LAN: describe as trusted-network HTTP only.
- Tailscale: explicitly supported and recommended for private remote access; no Cloudflare required.
- CGNAT/public sharing: tunnel/reverse proxy is an operator choice; Cloudflare is optional, not a Wabi privacy prerequisite.
- Public direct deployment: require HTTPS at the edge and warn if the configured public URL is HTTP.
- Do not force Cloudflare into normal Wabi operation.

**Acceptance:** A user can follow the guide for Tailscale-only hosting without Cloudflare, and a public-facing HTTP configuration emits a clear warning.

---

# Final verification gate

Run only after every focused card passes its own tests:

```bash
cd /var/home/Ronin/wabi/core
cargo test -p wabidb --lib
cargo test -p wabi-server

cd /var/home/Ronin/wabi/frontend
bun run check
bun run build
```

Then perform four manual/runtime proofs using unique sentinel text/files:

1. Send an `Off` public-channel message, stop server, search the WabiDB data directory and any generated backup path for the sentinel. Expected: absent.
2. Send a persistent public-channel message, restart, verify owner-authorized history returns it. Expected: present and readable.
3. Send a DM sentinel and attachment. Inspect server network/log/storage artifacts. Expected: ciphertext only; both participant clients decrypt.
4. Expire a durable timed message. Verify it disappears from normal history; only claim cryptographic/physical deletion after the dedicated key-destruction/compaction proof passes.

## Handoff rules for hy3

- Do Workstream A before B. The generic plaintext channel path must be made policy-aware before DM code is reintroduced.
- Do not “solve” DMs by reusing the public channel plaintext path with an `encrypted: true` flag.
- Do not call a message ephemeral merely because UI hides it after restart.
- Do not claim E2EE from at-rest encryption, Cloudflare TLS, Tailscale, or a server-owned key.
- Do not change public-channel owner access: persisted public channels are intentionally owner-readable.
- Do NOT build any private group room on MLS until Workstream B0 gate clears (B0.1 dependency pin + audit, B0.2 WASM build, B0.3 server-blind PoC, B0.4 trust-safeguards design) and the user approves. If the gate fails, keep private group rooms server-readable-with-owner-key; do not ship E2EE group rooms.
- Report exact tests run and the first unimplemented contract; do not silently skip a failing E2EE or disk-absence proof.
