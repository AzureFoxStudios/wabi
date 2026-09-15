# PR queue cleanup — 2026-09-15

Status: remediation executed; merge/close decisions remain with the owner.

## What the mess actually was

Fifteen open PRs (all authored 2026-09-12 → 09-14 by William Porter plus bot
identities) were showing near-universal red CI. Investigation found the red
was mostly inherited, not diagnostic:

1. **main's CI was red at the frontend unit-test step** (`bun test src/lib`):
   `1bcb3344` expanded the admin navigation to the 12-section server center
   and made moderation staff-visible, but `adminNavigation.test.ts` still
   expected the old 7-section catalog. Every open PR inherited this failure,
   which masked everything downstream. Fixed on main as `57f60ef2`.
2. **main's `cargo test --workspace` did not compile**:
   - `socketio_impl.rs` `include!()`s ~20 files into one module scope, so the
     CAD series (`48188615`) introduced a second `mod tests` (E0428).
   - `crates/wabi-core/tests/message_types.rs` initialized
     `AttachmentEncryptionMeta` without the four chunked-E2EE fields the E2EE
     series added (E0063, two sites).
   CI never noticed because it never got past the frontend step. Fixed on
   main as `0790aedc` (`mod whiteboard_ops_tests` rename; test initializers
   pass `None` for the legacy single-blob shape).
3. **PR #186 (Games & Steam) was already squash-merged into main** as
   `0c069267` but left open, with phantom add/add "conflicts". Bookkeeping
   debt: close it.
4. **Four dependency bumps were silently lost**: the 2026-08-28 batch merges
   `761a7e32` / `37619e21` have commit messages claiming they merged the
   dependabot bumps, but their diffs reverted xyflow, katex, motion and
   marked to older versions and never landed zeroize. The dependabot PRs
   (since closed) were never the problem — main's dependency state was.

## Actions taken

### main repairs (fast-forwarded, no history rewrite)
- `57f60ef2` — align admin navigation test with shipped navigation and
  backend moderator admission (`server_center.rs` checks `mod`/`moderator`).
- `0790aedc` — workspace test-build repairs above.
- After these, main's frontend suite is green locally (714 pass / 0 fail).

### PR branch updates (merge commits pushed, no force-pushes)
All ten stale PR branches were brought up to date with main so CI runs
against current code:
- Clean updates: `feat/mobile-first-2026-09-12`, `feature/chat-backdrops-koi`,
  `polish/public-site-seo-legal`, `feat/translator-assist-addon`,
  `fix/joker-shader-fidelity`, `feat/emote-library-ux`,
  `feat/reader-code-navigation` (merged by owner shortly after), and media
  stack tip `feat/media-voice-policy-selective` (also #209's head).
- `fix/mobile-native-green-2026-09-13` (#196): resolved `MainLayout.svelte`
  conflict as a union — the branch's `mobileSurfaceStack` plus main's
  right-panel peek-retract tracking, which are independent.
- `feat/dm-code-workspace-ux` (#184, draft): kept the branch's redesigned
  47-line `DMTab.svelte` shell (the PR's purpose) and re-applied main's only
  substantive change to the old monolith — the "What can we play?" games
  context-menu item from #186 — inside `DmConversationHeader.openMenu()`,
  where the header menu now lives.

### Dependency re-land — branch `chore/re-land-dependency-bumps`
- `4005a8d1` — re-lands the lost bumps at the newest versions satisfying
  bun's `minimum-release-age` (7 days) policy: marked 18.0.12,
  motion 13.2.0, @xyflow/svelte 1.6.6 (package.json + package-lock.json);
  zeroize 1.9.0 with zeroize_derive 1.5.0 (Cargo.lock only). TypeScript
  deliberately stays 6.0.3; the TS 7 rollback is respected.
- `f823182c` — untrack `logs/wabi-server.log.<date>` (dated names dodge the
  `*.log` rule) and `data/bots.json` (mutates on every bot registration);
  both added to `.gitignore`, on-disk runtime files untouched.

### Parked feature work (was sitting uncommitted on main)
- `feat/tui-overhaul-2026-09` — Lore screen, category sidebar, E2EE-honest
  rendering, optimistic sends (19 TUI tests pass).
- `feat/i18n-thai` — Thai locale + translating guide (check:i18n parity OK).
  Both pushed; PRs not yet opened.

## Validation

| Check | Result |
|---|---|
| bun test src/lib (main + chore branch) | 714–717 pass, 0 fail |
| svelte-check (main + chore branch) | 0 errors (173 warnings, existing baseline) |
| STATIC_BUILD=1 bun run build | passes, index.html emitted |
| cargo test --workspace --locked (chore branch) | see run log; compile now succeeds |
| Frontend suite on updated #184 / #196 branches | 0 fail locally |

Known remaining reds that are branch-specific, not inherited:
- #187/#196 mobile-native-build Android APK job (new workflow, own issue).
- #184 draft has ~23 svelte-check errors from its own runes-mode conversion
  of `lore/LoreFileViewer.svelte` (pre-existing on the branch).

## Second wave — real per-PR failures (after the inherited red was fixed)

Once main's CI went green (`0790aedc`), the remaining PR failures were
re-triaged from runner logs:

- Several PRs had failed "Cargo test" simply because their branches predated
  `0790aedc`; all remaining PR branches were merged to current main a second
  time so queued runs test fixed code (no conflicts; the #211 Reader merge
  auto-merged into #196 the same way).
- #212 had two real svelte-check errors in its own `EmojiPicker.svelte`
  (`activeMode` inferred as `string`); fixed on the branch with an explicit
  `'emoji' | 'sticker'` annotation.
- #184's 23 svelte-check errors are its own incomplete runes migration of
  `lore/LoreFileViewer.svelte` (legacy reactivity mixed with `$state`/`$props`,
  so the compiler falls back to legacy mode and rejects the runes generics).
  That is draft-authoring work, deliberately left to the branch.
- #187/#196's Android APK job is a branch-new workflow with its own issue.
- Local `cargo test` runs regen ts-rs output with doc-comment formatting
  drift (`AttachmentEncryptionMeta.ts`, `ChannelView.ts`); that drift was
  discarded, never committed.

main's `CI` workflow is green at `0790aedc`; the release/CodeQL/Tauri
workflows were still runner-queued at the time of writing.

## Decisions still open (owner call)

1. Merge order for the 13 real feature PRs. Suggested: #200 → #199 → #210 →
   #212 → #208 → #184 (when draft is done) → #187 then #196 → media stack
   #202 → #204 → #205 → #207 in order.
2. Close #186 (content already in main) — and close #209 after the media
   stack merges, or keep it as the stack's integration gate until then.
3. The media stack has never been built against main's E2EE series; #209
   (draft, stack-vs-main) exists for exactly that and should be green before
   #202–#207 merge.
4. `gh` CLI is installed at `~/.local/bin/gh` but unauthenticated; closing
   #186 / commenting / opening the chore PR requires `gh auth login`.
