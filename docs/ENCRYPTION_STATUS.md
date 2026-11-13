# Conversation encryption: what "experimental" means, and what has been tested

Last checked against `main` on 2026-11-13. Written for people and for AI agents. Read this before changing, reviewing or describing encryption in direct messages and groups.

## The short version

Encryption for new direct messages and groups is **built, enforced by the server on every entry path found so far, and tested**. It is not a stub, a prototype or a first draft.

It is labelled **experimental** for three specific reasons, and only these:

1. **No outside professional has reviewed it.** Every review so far was done by the project itself (see "Reviews so far").
2. **The server hands out everyone's keys, and nothing lets a user check them yet.** An operator who sets out to read a conversation can add a device of their own. Key verification is decided and planned (ADR-0002, stage 1).
3. **In the browser, the server also delivers the app.** A dishonest server could deliver a changed app. The desktop app does not have this limit.

The label is about who has checked it and what an operator who cheats could do. It is not about whether the code is finished.

## For AI agents

- Do **not** treat the encryption code as unfinished, one-shot or untested because the word "experimental" appears. Do not rewrite it, "complete" it, or replace it with a design of your own.
- Do **not** remove or soften the label, and do not strengthen it. The words "secure", "end-to-end encrypted" (without "experimental"), "verified", "audited" and "the operator cannot read" stay out of code, UI and docs until ADR-0002 stage 3 has passed. AGENTS.md golden rule 13.
- Do **not** report the three reasons above as bugs you found. They are known and written down, and their fixes are planned in ADR-0002.
- **Do** report anything that contradicts the "What is enforced and tested" table below: a path that accepts readable text in an encrypted conversation, a way to downgrade, a place decrypted content leaves the device. That is a real finding.
- The design in use today (`wabi-e2ee-v1`) will be replaced by MLS (RFC 9420). That is a decision about the long term, not a verdict that today's code is broken. Until the replacement exists, today's code is the product and its tests must stay green.

## What it protects against today

| Who | Result |
|---|---|
| An operator running the honest server, reading the database, uploads or backups | Cannot read message text or file contents of an encrypted conversation. Can see who talks to whom, when, and message sizes. |
| Someone on the network, with TLS set up | Sees timing and sizes only. |
| An operator who changes the server to read a conversation | **Not protected.** They can add their own device (reason 2) or, in the browser, deliver a changed app (reason 3). |
| A removed member | Keeps what they already received. Gets no keys for later messages from an honest server. |

The full threat model is ADR-0002 §2.

## What is enforced and tested

The server refuses; it does not trust the client to behave. Each row names where the proof is.

| Property | Proof |
|---|---|
| Readable text is refused in an encrypted or pending conversation on every path found: chat over every transport, edits, notes, forum, wiki, albums, gallery, incidents, whiteboard, bots, and uploads that are not the opaque encrypted shape | `core/crates/wabi-server/tests/dm_encryption_contract.rs`: `plaintext_is_refused_on_message_note_forum_bot_and_edit_paths_of_an_encrypted_room`, `feature_surfaces_refuse_readable_text_in_encrypted_and_pending_conversations`, `raw_websocket_has_no_message_entry_path`, `forum_text_follows_the_plaintext_boundary_before_and_after_encryption` |
| A new conversation accepts nothing readable until encryption is on, or until each sender has chosen the server-readable fallback for themselves | `pending_room_refuses_plaintext_until_each_sender_consents_or_encryption_is_enabled`, `bots_post_in_a_new_room_only_after_every_human_member_chose_server_readable` |
| An encrypted conversation cannot be turned back to readable by an API call, a role, a membership change or a restart | `encrypted_room_cannot_be_downgraded_by_api_role_membership_or_restart` |
| The server holds only public device keys, and room keys wrapped for registered devices | `server_stores_only_public_device_keys_and_keys_wrapped_to_registered_devices` |
| Refused readable text leaves no trace in server data or logs | `refused_plaintext_and_client_plaintext_leave_no_trace_in_server_data_or_logs` |
| Removing or deleting a member forces a new room key they do not get | `removed_or_deleted_members_force_rekey_and_lose_access_to_new_wrapped_keys`, `room_key_changes_require_current_revision_registered_sender_next_epoch_and_every_member_device` |
| A device's identity cannot be silently replaced | `device_identities_cannot_be_silently_replaced_or_restored`, `revision_device_set_and_sender_checks_each_refuse_on_their_own` |
| Envelopes have the expected shape and nothing extra; attachments must be files the server itself issued; reactions are identifiers, not free text; staff cannot swap a member's ciphertext | `envelopes_must_have_the_client_shape_and_nothing_else`, `encrypted_messages_carry_only_server_issued_upload_references`, `reactions_are_emoji_identifiers_not_free_text`, `staff_cannot_replace_a_members_ciphertext_even_with_a_valid_envelope` |
| In the app, decrypted content stays on the device: no link previews, no remote media without a click, no audio, video or 3D from a URL, no automatic translation, no forwarding into other tools | `frontend/src/lib/privacy/contentEgress.test.ts`, `frontend/src/lib/e2ee.test.ts`, `frontend/src/lib/messageStore.e2ee-boundary.test.ts`, and a real-browser run that records every network request: `frontend/scripts/kept-content-browser-smoke.mjs` (CI workflow `kept-content-browser.yml`) |

All of the server tests run in CI on every pull request (`test` job). They use the real router and a real data directory, not mocks.

## Known gaps, with their state

| Gap | State |
|---|---|
| If the registry file `e2ee_state.json` is lost or rolled back, readable sends reopen | Closed by PR 357 (merged with this row): a durable per-room marker in WabiDB refuses readable content when the registry is missing, older or weaker; the known-gap test is replaced by the contract tests in `dm_encryption_contract.rs`. Keys cannot be restored; members rekey. |
| Attachments in encrypted messages: the server drops the file list (a naming mismatch between client and server), so what a recipient receives is unverified | Open. Next task after PR 357. |
| No key verification; new devices are accepted without telling the user | Decided: ADR-0002 stage 1. Not built. |
| A new device cannot read old messages; losing every device loses history | By design for now. Decided: ADR-0002 §9, answers 3 and 5. |
| One room key covers all messages until the next key change (no forward secrecy inside a key period) | Addressed by the move to MLS, ADR-0002 stage 2. |
| Retention and deletion rules for ciphertext, keys and attachments are not defined | Open. Required before stage 3. |
| The terminal client cannot read or send encrypted messages | Open. Arrives with the shared MLS library, stage 2. |

## Reviews so far

Honest description: these were done by the project, using separate AI reviewer sessions that did not write the code and were told to break it. None is a professional human review.

| Change | Review |
|---|---|
| PR 354, server boundary | Two rounds. The first round found that wiki, albums, gallery, incidents, whiteboard and uploads still accepted readable text; fixed and re-checked with a mutation run (remove the check, confirm a test fails). |
| PR 355, client keeps decrypted content on the device | Four rounds. Found five ways around the media gate, then a URL mismatch and a same-origin playlist case; all fixed. A 273-payload probe and the browser run were repeated on the final version. |
| PR 357, durable marker | Three rounds. A 63-case matrix of marker state against registry state found no readable send admitted where it should be refused. Mutations that survived were given tests in round 3 (completion re-check and lock hold, sequencer preflight wiring, history shape); see the PR for the per-mutant table. |

A mutation run means: delete or flip one security check, run the tests, and confirm at least one fails. A check that can be deleted with every test still green is treated as untested.

## What lifts the label

A person's word that "it works" is not enough, whoever they work for. What counts is a written review with these parts:

1. **A named reviewer or firm** whose work is reviewing cryptographic protocols and their implementations.
2. **A stated scope and commit**: the MLS integration, key verification, the server's role in ordering and delivering, how the client stores keys, and the eight points in `docs/PRIVACY_STANCE.md`.
3. **A findings list** with severities, and the project's fixes checked by the reviewer.
4. **The report published** in this repository.

After that, and only for the desktop and terminal apps, the wording in ADR-0002 stage 3 may be used. The browser caveat (reason 3) stays permanently.

The owner has decided to plan for such a review (ADR-0002 §9, answer 9). Until then the label stays, and this page is the record that the code behind it has been built and tested with care.

## Where things are

- Server rules: `core/crates/wabi-server/src/api/e2ee.rs`
- Server tests: `core/crates/wabi-server/tests/dm_encryption_contract.rs`
- Client crypto and envelope: `frontend/src/lib/e2ee.ts`, `frontend/src/lib/e2eeEnvelope.ts`, `frontend/src/lib/dm/dmE2eeState.ts`
- Client rules for decrypted content: `frontend/src/lib/privacy/`
- What users are told: `docs/PRIVACY_STANCE.md`
- Direction and decisions: `docs/architecture/ADR-0002-dm-encryption-direction.md`
