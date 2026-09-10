# Lore local folders and manual Changes/Staging

Date: 2026-09-10
Status: implementation submitted for review; native desktop and full frontend verification are outstanding. Do not treat this as a production-ready release.
Base: main at 0c5520e8be5a6d156c7f13ed6a47cb342db764e7.

## Goal and implementation

Connect a plain project folder to a Wabi Lore project without teaching artists the wabi-sync CLI. The Project workspace now has Repository and Local changes surfaces. The former is the original LoreWorkspace component, preserved byte-for-byte as LoreRepositoryWorkspace in the same directory. Existing files, history, comparisons, review, and settings stay there.

Local changes provides a native folder chooser, Open folder, explicit Refresh changes, outgoing/incoming/conflict lists, persistent per-file staging, a summary, Publish staged, and confirmed Pull incoming. It does not start a watcher or upload on editor saves. A browser gets an explanation, not fake native controls. A ZIP download remains an unlinked copy.

The six lore_local_* Tauri commands are registered in both existing desktop entry points. A folder grant is tied to its canonical root, the originating window, server, account, and numeric Lore channel. The native chooser is the only way to obtain a grant; later operations receive a handle, not an arbitrary filesystem root. The frontend also checks server/account/session generation and component lifetime between operations.

## Important semantic boundary

This first iteration is NOT a Git-compatible clone, offline commit graph, or atomic multi-file commit implementation. It deliberately does NOT call the existing shared stageOnly/snapshot endpoints. Snapshot would commit the server's whole staging area, potentially including someone else's work.

Staging records the exact local SHA-256 and observed remote ETag in the local index. Publish staged preflights every selected file, then uses conditional per-file PUT/DELETE calls, with one revision per file and a shared human summary. Accepted files advance their baselines and are saved individually. The first failure stops the batch and retains remaining work. There is no force-push or last-write-wins fallback. Native transfer errors must be reconciled by refresh before retrying; a lost response is not proof of failure on the server.

Read-only mirrors cannot publish. Projects requiring review are blocked from direct desktop publishing and sent to the existing Repository review flow. If review policy changes during an upload and the response says pending review, that entry stays flagged and does not advance the official baseline. Publishing to a specific branch and an isolated server transaction for atomic multi-file commits are follow-up work, not advertised capabilities of this PR.

## Comparison and recovery

Local full SHA-256 and remote ETags are stored separately. Large-file q-* ETags include server-specific metadata and are treated as opaque; a matching local content hash must not be assumed to equal one. Identical strong hashes can establish a baseline. An unknown remote file missing from a newly linked local folder is incoming, never a proposed remote deletion. Unknown conflicting files require an explicit choice.

The local index is .wabi-workspace/state.json, with one state.previous.json recovery copy. Index records are versioned and identity-bound; malformed or mismatched state fails closed. No credentials are written to either file. After restart, reselect the folder to renew the native grant; the saved baselines and stages remain. The current index save path preserves a previous-only recovery index if replacement fails.

Pulls recheck the local content immediately before replacement. Replaced or locally removed bytes are retained under .wabi-workspace/backups with adjacent JSON mapping records identifying their original path. Publication of a downloaded file uses a same-filesystem hard link with create-only semantics, so a concurrently recreated editor file is not overwritten. Restoring a backup is currently manual: inspect its JSON mapping, preserve current work separately, then copy the backup to the original path. There is no automatic cleanup or backup-management UI in this iteration.

Hard-link support is required for local replacement; unsupported filesystems fail rather than fall back to destructive overwrites. This needs physical Windows/Linux filesystem verification before release. The guards are defensive checks, not a claim of race-free isolation against a malicious local process repeatedly changing directory entries.

## Limits and exclusions

- Native transfers stream in 64 KiB chunks and have a 1 GiB per-file safety limit, also subject to the server's configured limit. Publication uses a private fingerprint-verified snapshot, not a file being edited live.
- Scans are manual full-content hashes, capped at 100,000 files and depth 64. There is no background polling, hash cache, pause/resume, or partial range transfer.
- Built-in exclusions cover internal metadata, .env*, .ssh/.gnupg, .git/.lore, build outputs, dependencies, data/log directories, and conflict copies. These cannot be unignored. Other sensitive filenames are not automatically classified: review the list and write .wabiignore rules before publishing.
- .wabiignore supports conservative * / ** patterns and ordered ! negation. Custom rules are applied by the comparison layer AFTER the native scan; unlike built-in exclusions, they do not prune native hashing yet. A symlink or unsupported entry stops the scan, even in a custom-ignored subtree, rather than presenting it as a deletion. Native ignore-aware traversal is follow-up work.
- Invalid paths, cross-platform reserved names, case collisions, missing ETags, malformed state, and observed symlink paths fail closed.
- A folder containing .wabi-sync.json cannot be connected here. Use a different working folder from automatic wabi-sync; the CLI is unchanged.
- Offline comparison is available against a manifest already checked during the current connection. Reopening offline without that manifest does not fabricate remote status. Publish and pull always require a fresh server check.

No server routes, WabiDB events, postcard record layouts, or generated protocol files change.

## Verification performed in this session

Run from repository root with Node 22.16 or a compatible Node release:

```sh
node --experimental-strip-types --test frontend/scripts/lore-local-changes.test.mjs
```

Result: 38 passed, 0 failed. These execute the actual production comparison/staging module, not a separate reimplementation. They cover initial empty folders, additions/modifications/deletions, three-way conflicts, opaque large-file ETags, ignore rules, unsafe/case-colliding paths, account-bound state, stale staged versions, all-selection preflight, explicit conflict resolution, partial success, pending-review state, and persistence failures.

```sh
tsc --strict --noEmit --target es2022 --module esnext frontend/src/lib/loreLocalChanges.ts
```

Result: passed for the standalone pure model only. Syntax transpilation was also checked for the added TypeScript files and extracted Svelte script blocks; this is NOT a Svelte compilation or markup/type check.

Four Rust tests were added for unsafe paths, protected files, a full-hash vector, and Unix symlink escape. They were NOT run. This environment had no Rust toolchain, Bun, installed project dependencies, Tauri runtime, or live external Lore fixture. No native compile, installer, real-browser interaction, end-to-end transfer, or production deploy was verified. The standalone native Cargo dependency features changed; resolve and review the native lockfile during the build gate rather than inventing a lockfile update.

## Required before merging/releasing

1. Install the repository's pinned dependencies; run frontend check, static build, and the existing test suites. Check the two new Svelte components with the actual compiler.
2. Resolve the native dependency/lockfile changes, run cargo fmt, cargo test, and cargo check/build using --manifest-path src-tauri/Cargo.toml on a supported desktop. Verify both existing entry points. Review mobile compile guards because this workflow targets desktop, not mobile folder APIs.
3. In a real Tauri window, test chooser cancel/reconnect/restart, project and account switching mid-transfer, revoked permissions, native dialog behavior, and large-file streaming. Verify web mode cannot grant local access.
4. Against a real Lore fixture, test selected publishing, 409 races, delete/create races, partial failures and lost responses, read-only mirrors, review-policy changes, pulls and reversible deletions. Verify the existing server's ETag preconditions are atomic under concurrent writers; a client precondition header alone cannot guarantee that.
5. Exercise concurrent editor saves, symlink changes, filesystem errors, disk-full conditions, interrupted index replacement, and hard-link rollback on Linux and Windows. Inspect backup mapping and local permissions. Add native fixture/integration tests before declaring those paths verified.

## Deferred from the broader approved vision

Automatic local change watching, a cross-project connection registry, isolated atomic multi-file commits, local history/offline commits, branch selection, unified local/server diff previews, advanced binary comparisons, native ignore-aware scanning, resumable transfers, and a backup restore UI are not implemented by this first iteration.
