# Independent personal Planner — 28 September 2026

Status: implementation/build/runtime checks on the current worktree candidate. Not deployed to Tim or released in an installer.

## Implemented

- `/personal` reuses Calendar, Board, Journal and Projects independently of community authentication. Login and community-bound My Planner have explicit personal entries; no fake community/channel setup.
- Browser personal identity and IndexedDB snapshots are separate from existing server/account scopes. Desktop identity uses private main-window Tauri IPC to the bundled sidecar. Neither path adopts earlier account data automatically.
- `wabi-server --personal-planner --data-dir …` reads a bounded operation from stdin, returns one JSON response and exits before Authority initialization. No network listener, account bootstrap, provider, relay or WabiDB community is started.
- Native versioned JSON commits live in app data `personal-planner`, with an OS lock, revision checks, retained conflict drafts, synchronized immutable commit files and one preceding committed state. Interrupted temporary files are ignored; malformed committed records block writes.
- Personal attribution is “Me”; no community directory fetch, relay probes, outbound queue replay or launch-page lookup. Channel references are hidden in the personal Project editor.
- Old snapshots remain intact. Existing validated additive export/import is the explicit content-transfer and backup path. Cross-scope channel/Lore references are rejected. No publishing, model access or device sync has been added.

## Verification

- Scoped server tests cover reopen/readback, stale-write draft retention and resolution, interrupted temporary files, corrupted commits, wrong scope, incomplete snapshots, competing operation locks, duplicate IDs and symlink rejection.
- `scripts/tests/personal-planner-sidecar-smoke.py` ran against the newly built real server binary. Each operation was a separate process with an empty environment. It saved/reopened disposable project, calendar and journal records (including code and image payload bytes), retained a conflicting draft, restored a copied committed store into an isolated profile, and rejected a partial write without changing accepted data. This checks payload retention, not image decoding or physical power-loss behavior.
- The desktop Rust bridge compiled with the pinned toolchain. The check used a build-only `TAURI_CONFIG` override removing externalBin entries because the checkout lacks the packaged target-suffixed Tailcat resource. No packaged installation or native WebView IPC UI acceptance is claimed.
- Frontend check: zero errors, 90 existing warnings. Static build succeeded, fingerprint `68e25e04a4222f19`.
- 35 focused frontend tests passed across Planner sessions, validated backup/import, project hierarchy, journal formatting and a regression for zero personal directory requests / rejection of late community replies.
- Real in-app browser at `http://127.0.0.1:47332/personal`: independent empty inventory, creation/reload of **Personal offline proof**, local “Me” sign-off, save/reload of a journal containing fenced TypeScript, and save/reload of **Personal print deadline**. Existing account Planner content did not appear. The browser path uses actual IndexedDB, not native storage. A real screenshot was displayed in the task; the preview was left open.
- Scoped whitespace checks passed. Full-tree whitespace checks still report unrelated login-helper/generated-protocol issues; these were not rewritten.

## Remaining acceptance and release boundaries

- Native packaged app end-to-end: launch personal mode without a community account, save all record types through actual WebView IPC, quit/reopen, and verify export/import and sidecar-unavailable draft recovery.
- Installer packaging with matching sidecar resources; Windows/macOS runtime and filesystem durability acceptance.
- Fresh-profile offline and network observation, including inherited theme/media preferences. Source guards disable known community initialization paths; an exhaustive no-network trace has not been recorded.
- Physical power-loss/IO-fault acceptance. Synchronized immutable commits and interrupted-file tests are not equivalent to a real power-loss trial.
- Personal device enrollment/sync, explicit community publication and personal AI grants are separate unimplemented features.

No Tim data, community admission rules, credentials or shared project records were changed by this slice. Native files/browser storage are not encrypted at rest. A local sidecar does not provide synchronization or failover.
