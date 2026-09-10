# Open PR integration — 2026-09-10

Status: completed. The owner requested reconciliation of all open PRs with main.

## Result

All 19 PRs in the initial queue are accounted for in main. GitHub's open-PR endpoint returned an empty list after promotion. Original feature/dependency commit ancestry was retained; no source branches were deleted or force-rewritten. No production deployment was performed.

| PRs | Work | Disposition |
|---|---|---|
| #174 | Rust/TypeScript/build-order CI repair | Merged first as f7db843c8aa61bd393a364c9db9bc62b75eb21fd |
| #158–#172 | Fifteen Cargo/npm dependency updates | Included in the tested integration; original heads are ancestors of main |
| #173 | Sprite-sheet emote player | Merged into the integration with its tests and documentation |
| #175 | Unified Lore UI, local-folder staging, automatic detection | Marked ready and integrated; publication/pull decisions remain manual |
| #179 | Long-form Reader redesign | Independently merged as 29143afcd5aec2a21af336aa14d30ac45219874e; retained as the integration base |

**Tested integrated source:** 42c167641906a5cdd5d129324dfacd4fb99dd054.
Main was fast-forwarded to that exact source commit after validation. This completion record is a subsequent documentation-only update.

**Successful audit:** https://github.com/AzureFoxStudios/wabi/actions/runs/34482141627

The audit workflow lives on integrate/open-prs-2026-09-10, not main. Its workflow commit d014c438c2804ecff1af0dfe3e9bd7320bd8c821 assembled/tested the candidate; the artifact's head.txt and preserved integrate/candidate-34482141627 branch identify the tested source commit above. Do not confuse the workflow-definition SHA with the source SHA.

## Integration fixes

- Adopted #174's deliberate TypeScript 6.0.3 compatibility repair and Rust 1.93 setup, then evaluated all dependency updates together.
- Resolved #168/#170's adjacent-line conflicts in package.json/package-lock.json with a three-way merge of disjoint JSON keys. Conflicting edits to the same value were not guessed or overwritten.
- Regenerated and reviewed genuine Cargo lockfiles. Root resolution disambiguated a syn dependency after the combined updates; native resolution included the added Lore dependencies and reqwest query support.
- Enabled reqwest 0.13's query feature used by the existing native publication request. Conditional writes and explicit user decisions were retained.
- Updated two stale test expectations from five to the existing seven-role catalog. The reload test now compares full role names, not only a count; authorization and persistence assertions remain intact.
- Repaired a racy blob-corruption test fixture by flushing and verifying its asynchronous corrupting write before testing reader rejection. Production BlobReader and integrity enforcement were unchanged.
- Native validation fetched the real repository-pinned Tailcat v0.4.0 sidecar; no dummy executable or disabled packaging configuration was used.
- The generated ChannelView.ts change produced by root tests was deliberately not committed. Existing protocol fields remain intact.

## Observed validation results

Ubuntu 24.04, Rust 1.93, Node 22, Bun 1.3.14; strict dependency installation, no peer-dependency bypass.

| Check | Result |
|---|---|
| npm ci --no-audit --no-fund | Passed |
| bun test src/lib | 658 passed, 3 existing skips, 0 failed |
| npm run check | 0 errors; 169 warnings remain |
| STATIC_BUILD=1 npm run build | Passed |
| Lore comparison/staging tests | 38 passed |
| Lore detection scheduler tests | 32 passed |
| Lore production-observer tests | 9 passed |
| Lore presentation tests | 53 passed |
| cargo check --workspace --locked | Passed |
| cargo test --workspace --locked --no-fail-fast | 1,609 passed, 2 ignored, 0 failed |
| Dedicated wabi-lore / wabi-sync tests | 34 / 8 passed; also covered by the workspace suite |
| cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked | Passed; both native entry points checked |
| cargo test --manifest-path src-tauri/Cargo.toml --locked --lib lore_local | 8 native tests passed |

The final audit's required-status gate and candidate-preservation job both succeeded. Earlier failing attempts were investigated rather than skipped; their logs remain available on the audit branch.

## Remaining release validation and feature limits

This is verified development-branch integration, not certification of production or every platform. Physical desktop/editor/watcher behavior, Linux/Windows filesystem recovery and races, actual Lore server transfers/concurrent permissions, and Windows/macOS installer packaging still need release testing. Existing warnings and unrelated packaging workflows are not claimed fixed.

Lore detection remains read-only awareness: no automatic publication, pull, deletion, staging, restaging or conflict resolution. Multi-file publication is still one revision per selected file. No always-running tray service, atomic multi-file commit, new offline commit graph, or advanced binary comparison is claimed.

The earlier dated Lore plans preserve implementation history. Their old install/compile blockers are superseded by this record; their unimplemented features and manual release-test limits are not.
