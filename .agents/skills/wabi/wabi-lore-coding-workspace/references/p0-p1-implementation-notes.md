# P0 + P1 Implementation Notes (2026-08-07)

## ts-rs Gotchas (wabi-core `--features ts`)

- `serde_json::Value` does NOT implement `TS`. Use `#[cfg_attr(feature = "ts", ts(type = "unknown"))]` to work around.
- `#[ts(as = ...)]` requires a **string literal**, not a type expression: `#[cfg_attr(feature = "ts", ts(as = "Vec<LoreCapability>"))]`.
- `HashSet<T>` with `#[ts(as = "Vec<T>")]` serializes as an array in the generated TS — this is the intended pattern.
- Running `cargo test -p wabi-core --features ts` REGENERATES `packages/wabi-protocol/src/generated/*.ts` and STRIPS manual edits. Re-append `"category"|"lore"` to `ChannelType.ts` after regen.

## Rust Policy Engine Patterns

- `globset::GlobSet` for ref path matching and path policy glob matching. Added as dependency in `Cargo.toml`.
- `LoreCapabilitySet` wraps `HashSet<LoreCapability>` with ergonomic set operations (contains, insert, union, intersection).
- `check_policy()` in `mod.rs` is the unified entry point: role → capabilities → ref check → path check → Allow/Deny.
- Default role mapping: Owner gets ALL, Admin gets all except EgressPause, Developer gets write+review, Artist gets asset paths only, Viewer is read-only.

## Svelte 5 Runes Patterns (P1 components)

- **NO `$:` reactive declarations** — use `$derived` and `$effect` only.
- **Recursive components**: Svelte 5 does NOT support named fragments (`{@render}`) for self-reference. Use a separate `LoreTreeNode.svelte` component that imports itself via sibling reference pattern (Tree imports TreeNode, TreeNode renders children as TreeNode).
- **DOM event handlers**: `{onClick}` on `<button>` fails type check — use `onclick={() => onClick()}` to wrap the callback.
- **`{#each}` closing tag**: Must be `{/each}`, not `{/option}` or `{/item}`.
- **LSP type mismatches**: `LoreRevision` from `loreStore.ts` has `authorId: number`, not `author: string`. Map at the component boundary: `revisions.map(r => ({...r, author: `User ${r.authorId}`}))`.

## Component Architecture

9 components in `frontend/src/lib/components/lore/`:
- `LoreChannelShell` — top-level shell with tabs (files/history/diff), branch picker, health indicator
- `LoreFileTree` — builds tree from flat file list, search filter, delegates to TreeNode
- `LoreTreeNode` — recursive tree node (folder/file), handles expand/collapse
- `LoreFileViewer` — code display with line numbers, binary detection, large file truncation
- `LoreHistoryPanel` — revision list with author/branch filters, compare mode (select 2 to diff)
- `LoreDiffViewer` — unified and side-by-side diff modes
- `LoreBlameView` — grouped blame display (consecutive lines by same author collapsed)
- `LoreBranchPicker` — branch list with create/delete/switch, tag display
- `LoreLockBadge` — lock/unlock indicator with time-ago display

## OpenCode Status

OpenCode CLI was completely non-functional this session — 3 consecutive failures including bare smoke test. All P0/P1 code was written directly by the agent. Do not rely on OpenCode for Lore work until it is verified working again.