# Lore credential boundary and membership integrity

Status: complete locally; verification and diff review finished. Not deployed.
Base: local main `a362c75e` (the earlier audio fix is `ac7330de`).
No commit, push, deployment, live-account mutation or host-package changes in this work.
The unrelated untracked UI reconnaissance/planning documents belong to the
frontend lane and were left untouched.

## Diagnosis and selected objective

Wabi is a single-binary event-sourced collaboration system: WabiDB commands and
projections feed REST and Socket.IO; Svelte browser/Tauri clients own offline and
media state; optional Lore adds working trees, revisions, sync and workspace
integration. Prior audio/write-completion tests and the separate UI entry audit
show substantial working behavior, but are not whole-product launch acceptance.

The first launch objective selected here is **make an external-tool credential
a bounded repository capability, never a reusable account login**. This has a
direct security boundary and can be proven without deploying or requiring the
external Lore binary.

Reproduced against the previous code through the production Axum API router
and a real temporary WabiDB:

- A Lore token could authenticate `/user/me` as its owner, including `isOwner`.
- A token scoped to repository A could read repository B if its user could.
- A connect token could list/mint connect credentials via its account authority.
- The Connect panel submitted the returned 12-character prefix, but revoke
  expected a full hash, returning 404; the panel swallowed that failure.

All four initial contract tests failed before the fix. Expanded testing then
found that `remove_channel_member().await` returned success while membership
remained: `channel_member_removed` was not dispatched to the membership handler.
That coupling required a projection/recovery fix to finish this objective.

## Implemented boundary

General `AuthUser` no longer resolves Lore tokens. `api/lore_auth.rs` supplies
explicit read/write extractors only for repository-data operations. All other
handlers keep account authentication. This defaults new routes to rejecting
tool credentials rather than relying on an expanding method/path denylist.

The scoped extractor verifies token syntax/hash, exact scope, current active
registered user, revocation floors, exact requested channel, channel existence
and explicit membership. Existing handler role checks remain authoritative.
Minting requires explicit membership and a registered non-bot principal; role
loss does not prevent listing/revoking one's own issued credentials.
Single-token revocations recognize both new full-hash session IDs and the old
short-hash IDs, preserving revocation intent across upgrades. User/global floors
and both single-token ID forms were tested again after reopening the server.

Token lifecycle APIs return full non-secret hashes for precise revocation;
legacy prefixes remain accepted only when unambiguous within the requested
channel and caller's authority. Other users' or other channels' tokens return
404; collisions return 409 without revoking anything. Only admins may manage
other users' tokens. Scope strings are exact, not substring matches.

Connect-panel changes are limited to this credential workflow: distinguish
loading/failure/empty states, show failed revocation without deleting the row,
prevent duplicate mutations, invalidate superseded reads, clear revoked
plaintext, discard closed/changed-channel responses, use the actual channel ID
instead of falling back to an unrelated repo ID, quote copied shell arguments,
and contain/restore keyboard focus. No new design framework or main-shell edits.

## Projection change: channel_members

- **Record:** unchanged postcard `ChannelMemberRecord` (channel ID, user ID,
  joined timestamp, role, nick). No added fields, codec changes or migration of
  event payloads.
- **Events:** existing `channel_member_added` plus already-emitted
  `channel_member_removed`. Both handler `event_types()` and registry metadata
  now include removal.
- **Index:** unchanged `channel_members`, keyed `[channel length LE][channel][user ID LE]`.
  Removal deletes the exact row, repeated removal is idempotent, malformed
  removal fails, later adds can rejoin.
- **Completion:** the adapter's existing emit path is unchanged. Command success
  now reflects the applied membership change through the existing completion
  boundary; no optimistic parallel membership store was introduced.

Old snapshots retain the ignored event at `events["channel_member_removed"]`.
That existing marker triggers a targeted repair during replay. For the channels
represented by the snapshot's memberships and marker, the engine validates
committed historical event references and restores last-add/last-remove ordering.
It removes stale rows only: replaying every historical add into a snapshot could
undo a later account-deletion cascade. Unrelated snapshot data stays intact;
post-checkpoint events then apply normally. Successful repair removes the marker.

Missing/corrupt required history fails startup before accepting clients and
preserves the last checkpoint. This intentional availability tradeoff avoids
silently restoring revoked access. Operators must restore/repair the relevant
history rather than delete snapshots or keys. No live database was opened or
migrated during this work.

## Verification evidence

- Before: 4/4 targeted API regressions failed (`/tmp/wabi-lore-credential-before.log`).
- After initial fix: 4/4 passed; expanded 10/10 passed after membership repair.
- Membership-filtered WabiDB run: 15 passed, including old-snapshot repair,
  full replay, pre/post-checkpoint rejoins, account-deletion cascade preservation,
  preservation of unrelated checkpoint data, and missing-history startup refusal.
- Additional positive API test uses the real LoreService, filesystem and WabiDB,
  with `tests/fixtures/lore-cli-credential-fixture.sh` **only at the external CLI
  boundary**. It proves scoped upload, manifest/readback, staged batch snapshot,
  durable change cursors, signed-download compatibility and revocation before
  cached-file access. This is not verification of the external Lore executable.
- Headful Chromium under the real desktop CSP passed loading/error/retry,
  revocation failures, colliding display prefixes, read-only mint, plaintext
  clearing, late list/mint responses across channel changes and panel closure,
  keyboard focus, quoted sync commands and invalid-channel behavior. Desktop
  and 390px-wide rendering inspected; narrow controls fit without panel overflow.
  Actual component/API helpers and application styles; fixture HTTP/session
  boundaries; no production account. Run from `frontend`:
  `node scripts/lore-connect-browser-smoke.mjs`.

Final gates (all completed successfully):

| Gate | Result / evidence |
|---|---|
| `cargo test -p wabidb -p wabi-server --features wabi-server/addons -- --test-threads=1` | WabiDB 899 tests + 1 doctest; server 383 executions (includes duplicated lib/bin unit suites), 1 ignored doctest. `/tmp/wabi-lore-security-broad.log` |
| Final `lore_credential_contract` rerun | 13 passed, including the later legacy/exact session-ID and account-floor restart regressions. `/tmp/wabi-lore-credential-final.log` |
| `cargo test -p wabi-lore -p wabi-sync -- --test-threads=1` | 34 addon + 8 sync tests passed. `/tmp/wabi-lore-addon-sync-tests.log` |
| `cargo check -p wabi-server --no-default-features --locked` | Passed; scoped extractors remain optional, core still builds without Lore. `/tmp/wabi-lore-server-no-addons.log` |
| `bun test src/lib` | 273 passed, 12 existing crypto-related skips; no failures. `/tmp/wabi-lore-frontend-tests.log` |
| `bun run check` | 0 errors, 181 warnings in 49 files (removed four unused Connect-panel selectors from the 185-warning baseline). `/tmp/wabi-lore-connect-final-check.log` |
| Headful Connect regression | Passed. `/tmp/wabi-lore-connect-browser.log`; desktop/narrow screenshots `/tmp/wabi-lore-connect-contract.png`, `/tmp/wabi-lore-connect-narrow.png` |
| `bun run build:tauri`, then `bun run build:static` | Both passed; desktop CodeMirror bundle included. Final local `frontend/build` is the web/static build. Logs `/tmp/wabi-lore-connect-tauri-build.log`, `/tmp/wabi-lore-connect-static-build.log` |
| Skill validators and `git diff --check` | Passed; no generated protocol or unrelated runtime-data changes. |

The frontend builds above are **not** native Linux executable/package builds.
Browser fixtures do not establish native WebKit or real-server end-to-end behavior.
Test/browser/build processes completed and the isolated browser/server closed.

## Skill use and review boundaries

Privacy/API-handler guidance framed the credential boundary; the old skill's
public-read default was contradicted by actual security requirements and has
been corrected. Projection/testing guidance kept the change event-sourced,
postcard-compatible and tested through real dispatch/recovery. Skill-creator
guidance was used for focused updates to the projection and API skills.
Frontend architecture and interface-review guidance led to existing Svelte 5
runes, explicit async ownership, readable failure states and keyboard focus;
this is not a whole-interface aesthetic review. Typography, icons, motion and
global theme/spacing polish remain with the separate frontend lane.

## Not proven / next launch obstacles

This is **not launch approval**. Source-backed concerns queued for separate,
coherent objectives:

1. Channel/message/wiki/forum/incident/gallery REST read authorization differs
   from Socket.IO. Audit all private-data entry points, including REST self-join
   for DMs and independent admin JWT helpers. Do not assume the old security
   remediation plan proves these paths safe.
2. Instance keys/revocations/upload registry were recently untracked in another
   commit. Git history still contains prior data; operator exposure assessment
   and safe remediation are required. Do not publish keys or blindly rotate the
   WabiDB root key. No history rewriting or secret rotation performed here.
3. Offline drain marks messages synced after emit rather than authoritative ACK.
4. Lore download-cache key/invalidation and offline lock honesty need a separate
   data-integrity review. An embedded-mode lock currently reports a local result
   without an exclusivity mechanism. Scoped-token enforcement does not fix that.
5. `is_user_banned` in the adapter is still a stub; calling it is not proof of ban
   enforcement. Existing account-wide revocation checks are separately tested.

No real external Lore server/CLI or wabi-sync daemon was run. No two-device media
retest, native Tauri window verification, signed-package rebuild or deployment.
This work changes shared frontend behavior, not native audio/configuration.
Already-issued signed URLs remain short-lived capabilities with their existing
membership checks, not individually revocable Lore connect tokens. Membership
rejoin can restore an unrevoked token. Authorization does not cancel file I/O
already in progress when a role/membership/token is revoked.
