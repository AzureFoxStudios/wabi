# ADR-0002: Direction for direct-message and group encryption

- **Status:** Accepted, 2026-11-13. The owner answered §8 the same day; the decisions are in §9. Nothing in stages 1 to 3 is built yet.
- **Inputs:** owner's position of 2026-11-13 (below); [`docs/VISION.md`](../VISION.md); [`docs/PRIVACY_STANCE.md`](../PRIVACY_STANCE.md); [`docs/SECURITY-MODEL.md`](../SECURITY-MODEL.md); `core/crates/wabi-server/src/api/e2ee.rs`; `core/crates/wabi-server/tests/dm_encryption_contract.rs`; `frontend/src/lib/e2ee.ts`, `frontend/src/lib/dm/dmE2eeState.ts`, and `frontend/src/lib/e2eeEnvelope.ts` (that last file exists only on PR 355's branch).
- **Scope:** decision document only. It changes no code and makes no new product claim.

**Owner's position (2026-11-13).** Wabi exists because Discord offers no privacy. Direct messages and groups are the protected tier. Public community content is treated as readable by the server. The owner wants long-term stability: published, standard protocols rather than home-made ones, nothing that has to be thrown away in six months, and a path toward key handshakes that do not depend on trusting the server.

**How to read this.** Each section starts with the plain answer. Facts about Wabi are marked **[tested: test name]** or **[read from code]**. Facts about outside projects give the URL they came from. Anything that could not be checked is marked **not verified**.

---

## 1. What exists today

**Plain answer.** Each browser makes its own keys. One participant's browser picks a random key for the room and sends a locked copy of it to every participant device. The server stores those locked copies and the public keys, and enforces many rules about what it will accept. But the server also decides which devices exist. A browser trusts a device the first time it sees it and shows no fingerprints, so the server can slip in a device of its own. The cryptographic building blocks are standard (P-256, AES-GCM, HKDF, ECDSA through the browser's WebCrypto). The way they are put together is Wabi's own design and has not been reviewed.

### 1.1 Device keys

- When a browser first uses encryption, it creates one identity per (server URL, account). The identity is two P-256 key pairs: one for ECDH (key agreement) and one for ECDSA (signing). The keys are generated as *extractable*, and the device ID has the form `d_<uuid>`. **[read from code: `createIdentity`, `e2ee.ts`]**
- The private keys are exported (PKCS#8), encrypted with AES-GCM under a random 32-byte "wrap secret", and stored in `localStorage`. **The wrap secret is stored in `localStorage` too**, in the next entry. Anything that can read the page's storage (a script running in the page, malware, someone with the disk) gets the private keys. The wrapping does not protect them. **[read from code: `getOrCreateWrapSecret`, `wrapLocalBytes`]**
- The client registers its public keys with `POST /api/e2ee/devices`. Guests cannot register. An account can have at most 8 active devices. **[read from code: `register_device`, `e2ee.rs`]**
- The server refuses to re-register a device ID under different keys, and refuses to bring back a revoked device ID. **[tested: `device_identities_cannot_be_silently_replaced_or_restored`]**

### 1.2 Room keys, epochs and membership revision

- Enabling or rekeying a room: the participant's client generates a random 32-byte room key. For each recipient device, it makes a fresh P-256 key pair, does ECDH with the recipient's public key, and derives a wrapping key with HKDF-SHA-256. The HKDF input binds the room, the epoch, the membership revision and the recipient device. The client then encrypts the room key with AES-GCM and signs the wrapped copy with its ECDSA key. **[read from code: `wrapRoomKey`, `roomKeyCanonical`]**
- The **epoch** is a counter that goes up by one at every rekey. The **membership revision** is a WabiDB counter that changes whenever the room's membership changes; deleting an account counts too (PR 349).
- The server accepts an enable or rekey only if all of these hold: the sender device belongs to the caller; the epoch is 1 for a first enable and previous+1 for a rekey; the revision is current; and the set of wrapped copies matches *exactly* the active devices of current members, with none extra and none missing. **[tested: `room_key_changes_require_current_revision_registered_sender_next_epoch_and_every_member_device`, `server_stores_only_public_device_keys_and_keys_wrapped_to_registered_devices`]**
- The server keeps only the **latest** epoch's wrapped copies. Each rekey replaces the room entry. Keys for older epochs exist only in each client's `localStorage` cache. **[read from code: `set_room`, `cacheRoomKey`]**
- When a room needs a rekey, the client rekeys automatically before its next send. That automatic rekey refuses devices it has not pinned. **[read from code: `encryptMessageForChannel` calls `rekeyE2eeRoom(id, false)`]**
- The "update encryption keys" button in the DM views calls `rekeyE2ee`, which passes `allowNewDevices = true`. It approves any new device without showing its fingerprint. **[read from code: `dmE2eeState.ts`, `DMMessageView.svelte`, `DmConversationView.svelte`]**
- A new conversation is enabled automatically once every member has a device (`prepareNewConversationEncryption`). That path also accepts and pins every device the server lists. **[read from code]**

### 1.3 Messages

- The message body is JSON `{text, type, options}`, where `options` is filtered to a short allow-list (reply target, file references, attachment metadata and similar). It is encrypted with AES-GCM-256 under the room key, using a random 12-byte IV. The additional authenticated data binds the room, the epoch, the revision and the sender device. The envelope is signed with ECDSA P-256 over room|epoch|revision|sender device|IV|ciphertext and sent as `wabi-e2ee-v1:<json>`. **[read from code: `encryptMessageForChannel`, `messageCanonical`]**
- The signature does **not** cover the message ID, a timestamp or a sequence number. The server could deliver the same envelope a second time, as a new message, and it would still verify. No test covers this. **[read from code]**
- What the server checks on every send:
  - the room is enabled, and the envelope names that room and its current epoch;
  - the revision is current, and the device set has not changed since the last rekey;
  - the sender device is registered and not revoked;
  - the envelope has exactly the client's fields and nothing more;
  - the IV, ciphertext and signature decode to the sizes AES-GCM and ECDSA produce.
  **[tested: `envelopes_must_have_the_client_shape_and_nothing_else`, `revision_device_set_and_sender_checks_each_refuse_on_their_own`]**
- **The server does not check signatures.** That is deliberate: authenticity is the endpoints' job (`validate_outbound_message` doc comment). **[read from code]**
- What the receiving client does:
  1. finds the sender's device in the server's list (or in its local pins);
  2. **pins it if it is new** (`pinDevice(sender, true)`, trust on first use);
  3. checks the signature, then decrypts.
  A pinned device that changes its keys is refused. **[tested (client, `e2ee.test.ts`): "a sender device whose pinned keys changed is a failed check", "a bad message signature is a failed check", "an unknown sender device is a failed check"]** The "unknown device" test covers a device that is in neither list. A device the server does list is accepted and pinned without the user seeing it. **[read from code]**
- The link between a device and its *user* comes from the server: from the message's `userId` and from the device list. **[read from code]**
- A fingerprint function exists (the first 16 bytes of SHA-256 over both public keys, `fingerprintDevice`). `getE2eeSecuritySummary` returns it, but no Svelte component calls either. Users cannot see fingerprints today. **[read from code: grep of `frontend/src`]**

### 1.4 Membership changes, new devices, lost devices

- **Add, remove or delete a member:** the revision changes. The server then refuses old-revision envelopes, and plaintext, until someone rekeys to exactly the remaining members' devices. A removed or deleted member cannot fetch room status or new wrapped keys. **[tested: `removed_or_deleted_members_force_rekey_and_lose_access_to_new_wrapped_keys`]** A removed member keeps every room key already cached on their device. **[read from code]**
- **Downgrade:** an enabled room cannot go back to readable, whether through the API, role changes, membership changes or a restart. **[tested: `encrypted_room_cannot_be_downgraded_by_api_role_membership_or_restart`]** The client also refuses to believe a "disabled" status for a room it has seen encrypted. **[read from code: `cacheRoomStatus`]**
- **New device:** it receives the room key at the next rekey. It cannot read messages from earlier epochs, because the server keeps no old wrapped keys. **[read from code]** A message it cannot open shows as "no key". **[tested (client): "no cached key and no room-key envelope addressed to this device is \"no key\""]**
- **Lost device, or cleared browser storage:** history from that device is gone. There is no backup or recovery. **[tested (client): "local keys cleared after a key was cached: the message is \"no key\", not a failed check"]** The API can revoke any of the caller's own devices and answers `rekeyRequired`, but the client helper only revokes the device it is running on. I did not check whether any screen lets a user revoke a *different*, lost device. **[read from code: `revoke_device`, `revokeCurrentE2eeDevice`]**

### 1.5 Attachments

- The client encrypts the file in 1 MiB chunks with AES-GCM under the **room key**. Each chunk's IV is an 8-byte random prefix plus a counter, and the authenticated data binds room, epoch, file ID and chunk index. The upload is named `e2ee-<uuid>.wabi` with type `application/octet-stream`. The real name, type and size travel only inside the encrypted message. **[read from code: `encryptAttachmentForChannel`]** DM and group uploads are encrypted; uploads in shared channels are not. **[tested (client): `uploadOrchestrator.e2ee.test.ts`]**
- Where readable content is refused, the server accepts only that opaque upload shape. File references next to an envelope must be uploads the server issued for the same room. **[tested: `feature_surfaces_refuse_readable_text_in_encrypted_and_pending_conversations`, `encrypted_messages_carry_only_server_issued_upload_references`]**
- **Not working as intended:** the client sends `files[]` in camelCase, but the server's `FileAttachmentRecord` reads snake_case, so the server drops the list (see §3). Nobody has checked what recipients actually receive. **[read from code + 2026-11-12 handoff on PR 356]**

### 1.6 What the server stores, and what it can do with it

`data/wabi-server/e2ee_state.json` (mode 0600, written atomically) holds three things:

- `devices`: user, device ID, label, the two public keys, timestamps, and revocation time;
- `rooms`: per room, the enabled flag, epoch, revision, who enabled it, timestamps, and the current wrapped copies;
- `newRoomPolicies`: pending or server-readable mode, plus which users consented to server-readable.

**[tested: `server_stores_only_public_device_keys_and_keys_wrapped_to_registered_devices` checks that only these fields exist and that a room key or private key a client sends by mistake is stored nowhere]** Message ciphertext lives in WabiDB like any other message.

An **honest** server cannot open content with this data. It does learn:

- who is in each room;
- every device and its label, for example `Wabi · Linux x86_64`;
- when people send, and how large messages and files are;
- when keys rotate.

A **dishonest** server can change this file or its own code; see §2. A damaged registry blocks sends and key changes and is never overwritten. **[tested (unit, `e2ee.rs`): `missing_registry_is_a_fresh_instance_but_corrupt_registry_is_preserved`, `corrupt_registry_blocks_plaintext_before_content_processing`]** A *missing* registry is treated as a fresh install. On `main` that silently reopens readable sends. **[tested: `known_gap_missing_registry_currently_readmits_plaintext`]** PR 357 fixes this (§3).

### 1.7 Clients other than the browser

- **Terminal client (`wabi-tui`):** it has no encryption code. It shows encrypted messages as `[encrypted message — readable in clients holding the room key]`. **[read from code: `core/crates/wabi-tui/src/app.rs`, with a unit test next to it]**
- **Desktop app (Tauri):** it bundles the built frontend (`frontendDist: ../frontend/build`) and runs the same `e2ee.ts`. **[read from code: `src-tauri/tauri.conf.json`]**

## 2. Threat model today

**Plain answer.** Against an honest operator, a curious operator, or a network attacker when TLS is used, encrypted rooms keep message text and file contents hidden. Against an operator who sets out to read them, they do not. Such an operator can add their own device to a room without anyone seeing it, or serve a web app that sends the keys out.

| Who | What they can do today |
|---|---|
| **Curious operator** (runs the honest code, reads data and backups) | Read everything in server-readable rooms, and in new rooms where a sender chose server-readable. In encrypted rooms: read the metadata listed in §1.6, but not message text or file contents. |
| **Malicious operator** (changes the server and serves the web app) | **Insert its own device.** It registers a device under any user's account and lists it. Three client paths accept it without showing anything: automatic setup of a new room pins every listed device; the "update encryption keys" button approves new devices; a received message from a newly listed device is pinned and shown as that user's. So the operator can read new messages and **forge messages that appear to come from a member**. **Serve modified code** that copies keys or plaintext out; the browser runs whatever the server sends. **Withhold, delay, reorder or replay** messages (the signature has no message ID or counter), and show different members a different membership. **Silently re-add a removed member's device** at the next rekey: the client wraps to whatever devices the server lists, and a removed member's device is already pinned. |
| **Network attacker** | With TLS correctly set up: the metadata TLS does not hide (timing, sizes, server address). Without TLS: everything a malicious operator can do, because they can rewrite both the API responses and the app code. |
| **Removed member** | Keep and read everything they already received. Read any old-epoch ciphertext they get hold of later (a leaked backup, a dishonest server), because their room keys stay cached. Cannot get keys for epochs after their removal from an honest server. |
| **Stolen or unlocked device** | Read every room key and both private keys from `localStorage` (the wrap secret sits next to them). Read all history the account can still fetch while its login session lasts. Keep receiving new room keys until the device is revoked and the room is rekeyed. |

These are the two structural limits `PRIVACY_STANCE.md` already names:

1. **The server supplies first-seen device keys.** Nothing a user can see lets them notice a substituted key. Until users compare keys over another channel (Decision A), encryption protects against a server that does not try to read, not against one that does.
2. **The browser gets its code from the server.** Even with perfect cryptography, a web client can only be as honest as the server that delivers it (§6).

Today's design also has no forward secrecy inside an epoch. One room key covers every message and file until the next rekey, and each device keeps old room keys indefinitely. A compromised device's long-term ECDH key also opens every wrapped copy addressed to it, in any epoch whose copies someone kept. There is no post-compromise recovery either, except a rekey caused by a membership change or a button press. **[read from code]**

## 3. Known gaps found on 2026-11-12/13 and their state

**Plain answer.** The server-side refusals have tests. The client leak fix and the durable marker are written but not merged. Attachments, key verification and multi-device recovery are open.

| Gap | State on 2026-11-13 |
|---|---|
| Features with no encrypted form (forum, wiki, albums, gallery, incidents, whiteboards, bots, readable uploads) accepted readable text inside encrypted or pending rooms | **Fixed and merged, PR 354.** Covered by `feature_surfaces_refuse_readable_text_in_encrypted_and_pending_conversations`, `plaintext_is_refused_on_message_note_forum_bot_and_edit_paths_of_an_encrypted_room`, `bots_post_in_a_new_room_only_after_every_human_member_chose_server_readable` and related tests. |
| The client sent decrypted content back out (link previews, remote media, translation, forwarding, Lore, report without disclosure) | **Fixed and merged, PR 355** (`frontend/src/lib/privacy/`, `contentEgress.test.ts`, browser run `kept-content-browser.yml`). The owner's browser checklist in that PR has not been run. |
| A missing registry, or a rollback to an older valid one, reopened readable sends | **In progress, PR 357** (open): a durable per-room marker in WabiDB (`room_encryption` projection), compared against the registry on every decision. On `main` the gap is recorded by `known_gap_missing_registry_currently_readmits_plaintext`. PR 357 still documents that **rolling back to an older binary** reopens it. |
| The wire `encrypted` flag was taken from the sender, so a plaintext message could look encrypted to recipients | **In progress, PR 357** (commit "Relay \"encrypted\" only from the server's own decision"). PR 355 separately marks client-observed decryption with a symbol the wire cannot set (`e2eeEnvelope.ts`). |
| The server drops encrypted attachments' file list (`FileAttachmentRecord` is snake_case, the client sends camelCase) | **Open, not investigated further.** Noted in the 2026-11-12 handoff (PR 356). |
| No key verification | **Open.** Fingerprint code exists, but no screen shows it (§1.3). Decision A. |
| No multi-device recovery | **Open.** A new device cannot read history; a lost device loses it (§1.4). |

The eight-point checklist in `PRIVACY_STANCE.md`, against today's tests:

| # | Point | Covered? |
|---|---|---|
| 1 | Plaintext never accepted as the private payload | **Server side, yes**: PR 354 tests across chat, REST, edits, notes, forum, bots, feature surfaces, uploads and the raw `/ws`; `pending_room_refuses_plaintext_until_each_sender_consents_or_encryption_is_enabled`. |
| 2 | Server data plus server-held keys cannot decrypt | **Partly.** `server_stores_only_public_device_keys_and_keys_wrapped_to_registered_devices` and `refused_plaintext_and_client_plaintext_leave_no_trace_in_server_data_or_logs`. Nothing can prove this against a malicious server that substitutes keys (§2). |
| 3 | Attachments encrypted end to end | **Partly.** Server shape checks and client upload tests exist, but nothing tests the full path, and the file-list bug is open. |
| 4 | Device or key changes produce a visible security event | **No.** A pinned key change is refused (client test), but new devices are accepted silently and nothing is shown. |
| 5 | No quiet key escrow through multi-device or recovery | **Partly.** Escrow recipients are refused (point 2's test). There is no recovery design to check. |
| 6 | No plaintext in logs, traces, errors, indexes, previews, hooks or backups | **Server side, yes**: `refused_plaintext_and_client_plaintext_leave_no_trace_in_server_data_or_logs`. **Client side, open**: PR 355. |
| 7 | No silent downgrade to plaintext | **Mostly.** `encrypted_room_cannot_be_downgraded_by_api_role_membership_or_restart`. The registry-loss case waits on PR 357; the binary-rollback case stays open. |
| 8 | Retention and deletion defined for ciphertext, keys, attachments, indexes and backups | **No.** Not defined and not tested. |

## 4. Decision A: key verification that does not depend on the server

**Plain answer.** Start with **safety numbers and QR codes compared between two people's devices, plus loud warnings when a known key changes or an unknown device appears**. It is the cheapest option that defeats key substitution, it builds on code that already exists, and it costs nothing for people who never press it. Cross-signing should follow together with the protocol change (Decision B), because MLS needs a per-user identity anyway. A transparency log is not worth building for Wabi now.

### Options

**A1. Safety numbers and QR codes.**
- *What the user does:* opens the person's profile in a DM, sees a number (or a QR code), and compares it in person or over another app. The app marks that person "verified".
- *What it defends against:* key substitution by the server, once checked. A later change shows a warning.
- *What it costs on today's code:* small. `fingerprintDevice` and the device pins exist. Needed: a screen, a "verified" flag stored next to each pin, a QR camera scan in the desktop app, and fixes to the three silent-accept paths in §2 so a new device becomes a visible event instead of being pinned. With several devices per user it means one number per device. That is clumsy, which is why A2 follows.
- *Effect on easy setup:* none if optional. Messaging still starts at once; verification is something people choose to do.

**A2. Cross-signing by a user identity key.**
- *What the user does:* verifies a person once. On their own new device, the user approves it from an old device (scan or code), or with a recovery key.
- *What it defends against:* the same as A1, and the trust survives new devices. A device the user's own identity has not signed is visibly untrusted.
- *What it costs on today's code:* a new user-level key, signing of device keys, an approval flow between the user's own devices, and a decision about recovery keys (which touches checklist point 5). It is medium-sized work, and it lands differently under each protocol in Decision B. Building it on v1 first would mean building it twice.
- *Effect on easy setup:* adds a step on every new device ("approve from your other device or enter your recovery key"). This is the main cost of the multi-device story.

**A3. Trust on first use with loud key-change warnings.**
- *What the user does:* nothing until something changes. Then they see a warning in the conversation.
- *What it defends against:* a server that switches keys *after* first contact. It does not protect the first contact, which is exactly where automatic setup of a new room is exposed today.
- *What it costs on today's code:* small. Pinning exists; the warning and the removal of silent approval are the work.
- *Effect on easy setup:* none.

**A4. A transparency log** (a public, append-only record of every key the server has published, checked by clients).
- *What the user does:* nothing; clients check automatically.
- *What it defends against:* a server showing different keys to different people, but only if someone outside the server watches the log. A community with a single self-hosted server usually has no such outside party.
- *What it costs on today's code:* large. It is a new subsystem. A permissive Rust implementation exists (`akd`, MIT OR Apache-2.0, 0.13.0 published 2026-08-13, NCC Group audit August 2023 per its README: https://github.com/facebook/akd, https://crates.io/crates/akd). The IETF KEYTRANS protocol is still a draft (https://github.com/ietf-wg-keytrans/draft-protocol; version not verified).
- *Effect on easy setup:* no user step, but another moving part for every operator.

### Recommendation for Decision A

Build **A1 together with A3** as stage 1: show safety numbers and QR codes; mark people verified; turn every new device or key change into a visible message in the conversation; and stop the three silent-accept paths. In a room where *no one* has verified anyone yet, a new device should still be accepted, with a notice, so setup stays easy. Once a person is verified, a change to their devices should block sending to them until the user looks. Plan A2 as part of stage 2. Skip A4 unless Wabi gains a way to have outside parties check the log.

**What the UI must say**

- **Before verification:** "Encrypted (experimental). Not verified: the server could have given you the wrong keys. Compare safety numbers to check."
- **After verification:** "Encrypted (experimental). You verified [name]'s devices on [date]. Wabi will warn you if they change." Never "secure", "protected" or "end-to-end encrypted" without "experimental", and in the web client never without the code-delivery note (§6).
- **On a change:** "[name] has a new device, or their keys changed. If you did not expect this, check with them before sending."

## 5. Decision B: the protocol itself

**Plain answer.** Adopt **MLS (RFC 9420)**, through a permissively licensed Rust library compiled for the server, the desktop app, the terminal client and (as WASM) the browser. It is the only option that is a published standard, covers groups and DMs with one mechanism, gives forward secrecy and post-compromise security, and passes `deny.toml`. Wabi is not deployed, so the current v1 design can be retired instead of migrated.

**What could not be checked.** rfc-editor.org, datatracker.ietf.org, signal.org, matrix.org, leastauthority.com and the OpenMLS blog did not load from this session. Statements about those sources are marked not verified. GitHub repository pages, raw LICENSE files, crates.io and npm did load. Licences below are as the LICENSE file or registry states them. `deny.toml` allows MIT, Apache-2.0, BSD, ISC, MPL-2.0 and others, and not AGPL or GPL.

### (i) Keep and harden the current v1 design, and have it reviewed

- *Maturity:* Wabi's own. It uses standard WebCrypto building blocks with no outside library. Licence is not an issue.
- *Multi-device:* one wrapped copy per device; no history for new devices; no recovery.
- *Membership changes:* a full rekey, with one wrapped copy per device for every add or remove. That is fine at small sizes.
- *Forward secrecy / post-compromise security:* none inside an epoch (§2). Adding a ratchet would mean designing one ourselves.
- *Attachments:* already designed (§1.5).
- *What carries over:* everything; it is today's code.
- *Main reason against:* it is exactly the "home-made protocol" the owner wants to leave. A review would find what to fix, but the result would still be a one-off design that only Wabi uses, that no one else maintains, and that every future reviewer has to learn from scratch.

### (ii) MLS, RFC 9420, for groups and DMs (recommended)

- *The standard:* RFC 9420, Proposed Standard, July 2023. Its abstract says it gives forward secrecy and post-compromise security for groups "from two to thousands", with update costs that grow with the logarithm of group size. **Not verified from the RFC text** (the hosts were unreachable; this comes from search results pointing to https://www.rfc-editor.org/rfc/rfc9420). An architecture document, RFC 9750 (April 2025), exists according to search results only: **not verified**.
- *Rust implementations:*
  - **OpenMLS**:
    - Licence: MIT (https://raw.githubusercontent.com/openmls/openmls/main/LICENSE).
    - Releases: crates.io 0.9.2, published 2026-10-22; GitHub release openmls-v0.9.0 (https://github.com/openmls/openmls/releases).
    - Browser: a `js` feature "to enable compilation to wasm". `wasm32-unknown-unknown` is listed as built but not tested in CI, and the `openmls-wasm` directory calls itself an "Experiment".
    - Audit: an SRLabs audit with fixes in 0.8.1 and 0.7.3, per search results only. **Not verified.**
  - **mls-rs** (AWS):
    - Licence: Apache-2.0 OR MIT (https://github.com/awslabs/mls-rs; crates.io).
    - Releases: 0.57.1, tagged 2026-11-12.
    - Browser: its README lists WASM builds, but marks its WebCrypto provider experimental.
    - Audit: the README says it "has not yet received a full security audit by a 3rd party", and claims full RFC 9420 conformance.
  - Both are permissive and pass `deny.toml`. Both have browser support that their own authors call experimental. Choosing between them needs a short spike (§8, Q4).
- *Multi-device:* in MLS each device is its own member ("leaf") of the group. A user's devices are tied together through the credential each device presents, which is where cross-signing (A2) belongs. History for a newly joined device is not part of MLS; Wabi would have to decide it separately (§8, Q3).
- *Membership changes at Wabi's sizes:* adds and removes are "commits" that the server orders and relays. For DMs and small groups the cost is small whatever the scaling. Because the server orders commits, MLS needs a single sequencer for each group, which WabiDB already is. (That last point is my reasoning, not a source.)
- *Forward secrecy and post-compromise security:* built into the protocol (per the RFC abstract, not verified). This is the main technical gain over (i).
- *Attachments:* MLS encrypts messages, not files. Keep the chunked file encryption from v1, but give each file a random key carried inside the MLS message, instead of reusing the room key. (Design note, not a source.)
- *What carries over:* the server boundary carries over almost unchanged. That covers plaintext refusal on every path, the opaque upload shape, no downgrade, the pending/server-readable policy and PR 357's durable marker. Most of `dm_encryption_contract.rs` is about those rules and stays useful. What changes: the registry holds MLS "KeyPackages" (published device keys) and group messages instead of `devices` and wrapped copies. The envelope-shape tests and the epoch/revision checks get rewritten around MLS epochs. The membership-revision check stays as a cross-check.
- *Browser and other clients:* one Rust library compiled for the server, the desktop app, the terminal client and (as WASM) the browser would give the terminal client encryption for the first time. The Tauri CSP already allows `'wasm-unsafe-eval'` (`tauri.conf.json`).
- *Main risk:* browser support in both libraries is labelled experimental by their authors, and Wabi would be integrating MLS itself, with its own server acting as MLS's delivery service. That integration is what stage 3 reviews.

### (iii) Signal-style: X3DH or PQXDH, Double Ratchet, and sender keys for groups

- *Specifications:* published on signal.org. **Not reached from this session; revisions and contents not verified.** They are published specifications, not IETF standards.
- *Implementation:* `libsignal` is licensed **AGPL-3.0** (https://raw.githubusercontent.com/signalapp/libsignal/main/LICENSE). It would **fail `deny.toml`**. Latest release v0.107.0, 10 Nov 2026 (https://github.com/signalapp/libsignal/releases). Its README says "Use outside of Signal is unsupported" and that APIs change without notice. There is no official WASM build; the maintainers declined one as "too much of a maintenance burden" (https://github.com/signalapp/libsignal/issues/350).
- *Permissive alternatives:* not researched. **Not verified.**
- *Multi-device and groups:* in Signal's design these come from separate pieces (Sesame for devices, sender keys for groups; specs not verified here), not from a single group protocol.
- *Main reason against:* the reference library cannot be used under Wabi's licence policy and is unsupported outside Signal. Writing our own implementation from the specs would turn a standard design back into home-made code.

### (iv) Matrix Olm and Megolm, through vodozemac

- *Implementation:* `vodozemac` is licensed Apache-2.0 (https://raw.githubusercontent.com/matrix-org/vodozemac/main/LICENSE); 0.11.2 was published 2026-11-05. It is used in the browser through `@matrix-org/matrix-sdk-crypto-wasm` 19.0.1, Apache-2.0, published 2026-11-06 (https://github.com/matrix-org/matrix-sdk-crypto-wasm). Its README reports one Least Authority audit "with no significant findings". The report itself was not read: **not verified**. The older `libolm` was deprecated on 2024-07-31 and archived on 2026-02-23 (https://github.com/matrix-org/olm).
- *Multi-device and groups:* Megolm group sessions are shared to each device over Olm. In my understanding, Megolm ratchets forward inside a session but gives no post-compromise security until the session is replaced. **Both points are from general knowledge, not verified.**
- *Ecosystem direction:* Matrix itself has an open draft proposal for MLS, MSC2883 (https://github.com/matrix-org/matrix-spec-proposals/pull/2883, last active 2 Jun 2026).
- *Main reason against:* the convenient browser package wraps Matrix's whole client-side crypto machine (`OlmMachine`), which assumes Matrix's own device lists, cross-signing and key backup. Using only vodozemac means rebuilding that machinery in Wabi. Megolm is also a Matrix-specific protocol, not an IETF standard, and Matrix's own draft points toward MLS. Choosing it risks the "thrown away later" outcome the owner wants to avoid.

### Migration of rooms that already hold v1 ciphertext

Wabi is not deployed, so no real user holds v1 rooms. That buys a clean cut: new rooms use MLS from the start; existing v1 rooms become read-only on clients that still hold their keys, for one release; then v1 code is removed. There is no conversion step and no long dual-protocol period. A test instance that needs old messages back must export them before the cut. A version tag on the wire (`wabi-e2ee-v1:` today, a new prefix for MLS) keeps the two apart, and the server refuses v1 sends after the cut.

## 6. The client-integrity problem

**Plain answer.** The desktop app can fix this; the web client cannot. In the desktop app the code comes from the installed release, not from the community's server. In the browser, the server sends the code each time, so a malicious operator can always send code that leaks. The honest wording follows from that difference.

- **Desktop (Tauri):** the frontend is bundled into the app (`frontendDist: ../frontend/build`), so the operator does not serve it. The trust moves to Wabi's release process: who builds and signs the app, and how updates arrive. That only holds if the app never loads code pages from the community server; that should be checked whenever this area changes. **[read from code]**
- **Terminal client:** today it cannot read or send encrypted messages at all (§1.7). With a shared Rust MLS library (Decision B) it could do both, with code from the installed binary.
- **Web client:** subresource integrity, service workers and similar measures do not help, because the server also serves the page that declares them. Third-party code-verification browser extensions exist in principle, but I have not evaluated any, and Wabi should not depend on one.
- **Wording that follows:**
  - in the desktop app and terminal client, encryption can eventually be described as not depending on the operator's honesty, after stage 3;
  - in the web client it must always say something like "In the browser, your community's server delivers this app. A dishonest server could change it. Use the desktop app if that matters to you." The existing `E2EE_CLIENT_INTEGRITY_NOTE` already says the core of this;
  - safety-number verification done in the web client is only as trustworthy as the web client itself.

## 7. Staged plan

**Plain answer.** Four stages. Each one can ship by itself, and each says exactly what Wabi may claim afterwards. Nothing before stage 3 allows the words "end-to-end encrypted" without "experimental".

**Stage 0: finish what is in flight.**
- *Work:* merge PR 355 (client keeps decrypted content on the device) and PR 357 (durable room marker, server-owned `encrypted` flag) after review; fix the attachment file-list mismatch and test what recipients receive; add a test for envelope replay, or record the gap.
- *May say:* "New DMs and groups use experimental encryption. It has not been independently reviewed. The server provides the encryption keys and could swap them, and in the browser the server also provides the app."

**Stage 1: key verification (Decision A).**
- *Work:* safety numbers and QR codes; a verified flag; visible device and key-change events; remove the three silent-accept paths; a way to revoke a lost device from another device.
- *May say:* "You can check that you and the other person have the right keys. After you check, Wabi warns you if they change." Still experimental; still a design of Wabi's own.

**Stage 2: protocol (Decision B).**
- *Work:* spike the two MLS libraries (browser build, size, speed); pick one; move DMs and groups to MLS with per-file attachment keys; add cross-signing (A2) and a decided multi-device history policy; keep the stage-0 server boundary and its tests; retire v1 as described in §5.
- *May say:* "Uses MLS (RFC 9420), a published IETF standard, through [library]. Experimental and not independently reviewed."

**Stage 3: independent review.**
- *Work:* an outside review of Wabi's MLS integration, the key-verification flow, the delivery-service role of the server, the client storage of keys, and all eight checklist points (point 8, retention, must be defined first); fix what it finds; publish the report.
- *May say, only after it passes:* "End-to-end encrypted in the desktop and terminal apps; reviewed by [reviewer] on [date]", with the web-client caveat from §6 kept permanently.

**Not to be claimed until stage 3 passes:** "end-to-end encrypted" without "experimental"; "the operator cannot read your messages"; "secure", "private from the server", "verified" or "audited" applied to encryption; any comparison to Signal or WhatsApp. Retention settings (live, timed) are never evidence of confidentiality.

## 8. Open questions for the owner

1. **Decision A first step:** safety numbers + QR + loud warnings (recommended), or go straight to cross-signing?
2. **Decision B:** MLS (recommended), harden v1, Signal-style, or Olm/Megolm?
3. **History on a new device:** (a) a new device sees only messages from after it joined (simplest, most private); (b) the user's old device sends history to the new one when approving it; or (c) an encrypted key backup protected by a recovery key the user keeps?
4. **MLS library:** allow a short spike comparing OpenMLS and mls-rs before choosing? Yes or no.
5. **Lost everything:** when a user loses every device, is "history is gone, start fresh" acceptable? Yes, or require a recovery key (which adds a setup step)?
6. **Unverified new devices in a room where someone verified people:** block sending until the user looks (recommended), or warn and continue?
7. **Web client wording:** show the code-delivery caveat on every encrypted conversation in the browser, or only in the security details panel?
8. **v1 retirement:** read-only for one release, then removed (recommended), or removed immediately since nothing is deployed?
9. **Stage 3 budget:** plan for a paid outside review before any non-experimental claim? Yes, or keep "experimental" indefinitely?

## 9. Owner decisions, 2026-11-13

The owner answered the nine questions in their own words. Each entry gives the answer, then what it means for the work. Where the answer left a choice open, the choice made here is marked **coordinator's reading** and the owner can change it.

1. **First step for checking keys.** *"Whichever one feels more sane. Though I could see both: family Wabi having scan necessary, public using a simpler but heavier handshake?"*
   - Stage 1 builds safety numbers, QR codes and loud key-change warnings (A1 with A3), as recommended. Cross-signing (A2) comes with MLS in stage 2.
   - New requirement from this answer: **how strict verification is must be a setting.** A user can choose "only send to people I have verified" for one conversation or for everyone. A server owner can turn that on as the default for their server (a family server where everyone can scan in person). A public server leaves it off and relies on automatic checks plus warnings.
   - A server setting can only add strictness. The user's own setting is the one that counts, because a dishonest server would simply report the strict default as off.

2. **The protocol.** *"A little bit of A, B and C combined? I want something that lasts."*
   - **Coordinator's reading: MLS (RFC 9420) is the one protocol.** Mixing parts of several protocols is how a home-made design is produced, and a home-made design is the thing that does not last: nobody else maintains it and every reviewer starts from nothing.
   - What is combined is everything around the protocol. From today's design (B): the server rules, the pending and server-readable policy, the durable marker and the contract tests all carry over. From Signal's design (C): the way people verify each other (safety numbers, QR, key-change warnings). From MLS (A): the cryptography.

3. **Old messages on a new device.** *"Maybe we leave it at exporting a chat? … give the ability to back up if you have it."*
   - A new device sees only messages from after it joined (option a).
   - A device that has the history can **export a conversation** to a file the user keeps, and a device can open such a file. Nothing is sent between devices automatically and the server holds no key backup by default.
   - An export is the user's own copy on their own disk. The default export is protected by a passphrase the user picks; a plain readable export is offered with a clear warning. The export format must be a published one.

4. **MLS library.** *"Give a doc giving verbose info about both, but deeply think about the longer term of both and choose that one, outlining why in said document."*
   - Yes to the trial. Its result is a document, `docs/architecture/ADR-0003-mls-library-choice.md`: both libraries built for the browser and the desktop, measured, with their maintenance history, governance, review history and licence checked against primary sources, and one chosen for the long term with the reasons written out.
   - Decided in [ADR-0003](ADR-0003-mls-library-choice.md), accepted by the owner on 2026-11-13: **mls-rs**, behind one small Wabi-owned interface so the choice can be reversed.

5. **Losing every device.** *"Wabi being ephemeral is strong, but … we should allow people to 'discordify': keep deep history. However we need to make sure it's sane and not going to make people pull their hair out."*
   - Default: history in encrypted conversations is gone with the last device. No recovery key at setup, so setup stays one step.
   - Opt-in: a user who wants deep history can turn on a **recovery key**. One screen, one key to save, a check that they saved it, and no reminders after that. It is built with the MLS work in stage 2, not before, so it is built once.
   - Community channels are a separate matter: they are server-readable and already keep history for as long as their retention setting says, including forever.

6. **An unknown device appears for someone already verified.** *"A combination makes sense: a gate saying 'this was from an unknown device, pause messages?'"*
   - For a verified person: sending to them pauses and a gate asks. The gate says which device is new and since when, and offers "check with them first" (stay paused) and "continue anyway" (send, and the person shows as unverified again until re-checked). Messages that arrive from the unknown device are shown with a mark, never as if nothing changed.
   - For a person never verified: a notice in the conversation, and sending continues.

7. **Browser wording.** *"We shouldn't go too crazy, and make sure servers can't hijack anything by just existing. We don't want bad actors destroying people's DMs or computers by just connecting."*
   - Wording: one clear line the first time an encrypted conversation is opened in the browser, and the full note in the security details panel. Not a banner on every conversation.
   - New requirement from this answer: **connecting to a server must not let that server harm the client or the user's other servers.** In the desktop app a server must not be able to deliver code, read another server's keys or conversations, or reach the user's files. This gets its own audit of what a hostile server can do to a client that connects to it, with tests for each boundary (Tauri navigation and content rules, addon and plugin loading, per-server storage, links and file handling).

8. **Retiring today's design.** *"If it's just clean-up then yes, remove."*
   - When MLS conversations work, the v1 code is removed in the same release. No read-only period. Nothing is deployed, and the test server is wiped.

9. **Outside review.** *"Keep, however please document that testing has taken place so that AI doesn't think it's one-shot code and trips over itself."*
   - Plan for a paid outside review before any claim without "experimental". The label stays until then.
   - `docs/ENCRYPTION_STATUS.md` now records what "experimental" means here, what is enforced and tested, the reviews done so far, and what a review must contain to lift the label. AGENTS.md points to it.

### Order of work after these decisions

1. Finish stage 0: PR 357, then the attachment file-list fix.
2. In parallel, because they touch no encryption code: the MLS library trial (answer 4) and the hostile-server audit (answer 7).
3. Stage 1: verification, the gate from answer 6, the strictness setting from answer 1.
4. Conversation export (answer 3).
5. Stage 2: MLS, cross-signing, the opt-in recovery key (answer 5), removal of v1 (answer 8).
6. Stage 3: the outside review.

