# P1: Browser VCS UX — File Tree, Viewer, History, Diff

## Context

You are building the browser-based VCS UX for Wabi's Lore/coding workspace. This runs inside a `lore` channel type. The existing `LoreChannel.svelte` is 1903 lines — a monolithic god component that needs to be decomposed into proper subcomponents.

**Wabi frontend:** Svelte 5 runes only (`$props`, `$derived`, `$effect`). No `export let`, no `$:` reactive declarations. Dark cosmic/nebula theme. Tokens in `src/styles/tokens.css`.

**Existing store:** `frontend/src/lib/loreStore.ts` — thin store with `loreRepo`, `loreFiles`, `loreRevisions`, `loreBranches`, `loreFileHistory`, `loreFileDiff`, `loreLoading`, `loreError`, `loreHealth`.

**Existing API:** `frontend/src/lib/api/lore.ts` — REST calls to `/api/addons/lore/repos/{channelId}/...`

**Existing god component:** `frontend/src/lib/components/LoreChannel.svelte` (1903 lines) — currently does everything in one file. We are NOT rewriting it in place. We are building NEW subcomponents and a NEW shell that uses them.

## What to Build

### P1.1 — File Tree Browser

Create `frontend/src/lib/components/lore/LoreFileTree.svelte`:

- Recursive file tree with expand/collapse folders
- Icons: folder (collapsed/expanded), file (with type-based icon: code, image, binary, text)
- Selection: click to select, double-click to open in viewer
- Context menu (right-click): open, download, lock/unlock, delete, history, diff
- Loading state: skeleton while tree loads
- Error state: retry button
- Path breadcrumbs at top
- Search/filter input: filter files by name
- Uses Wabi tokens: `--surface-raised`, `--text-secondary`, `--accent-primary`

Props:
```ts
interface Props {
  files: LoreFileInfo[];
  selectedPath: string | null;
  loading: boolean;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent) => void;
}
```

### P1.2 — File Viewer

Create `frontend/src/lib/components/lore/LoreFileViewer.svelte`:

- Syntax-highlighted source code (use `shiki` or highlight.js — pick one, add to package.json)
- Binary files: show "Binary file — download to view" with size/type info
- Large files (>1MB): show "File too large for inline view — download" with option to view first 100 lines
- Line numbers
- Copy button
- File metadata bar: path, size, hash, last revision
- Tab bar for multiple open files (max 5, LRU eviction)
- Close tab button
- Uses `--font-mono` for code

Props:
```ts
interface Props {
  filePath: string;
  fileContent: string | null;  // null = binary or loading
  fileInfo: LoreFileInfo | null;
  loading: boolean;
  onClose: () => void;
}
```

### P1.3 — History Panel

Create `frontend/src/lib/components/lore/LoreHistoryPanel.svelte`:

- Revision list: commit hash (short), message, author, timestamp, file count
- Click revision → show diff (or select two → compare)
- Branch/tag indicator per revision
- Pagination: load more button (50 revisions at a time)
- Filter: by author, date range, branch
- "Blame" button per file (opens blame view — P1.4)

Props:
```ts
interface Props {
  revisions: LoreRevision[];
  branches: LoreBranch[];
  loading: boolean;
  onRevisionSelect: (hash: string) => void;
  onCompare: (from: string, to: string) => void;
}
```

### P1.4 — Blame View

Create `frontend/src/lib/components/lore/LoreBlameView.svelte`:

- Line-by-line attribution: each line shows author, timestamp, commit hash
- Compact: collapsed consecutive lines by same author show range
- Click line → navigate to that revision's diff
- Uses `--font-mono` for code, `--text-muted` for blame metadata

Props:
```ts
interface Props {
  filePath: string;
  blameData: BlameLine[];  // { line: number, content: string, author: string, timestamp: number, hash: string }
  loading: boolean;
}
```

### P1.5 — Diff Viewer

Create `frontend/src/lib/components/lore/LoreDiffViewer.svelte`:

- Unified diff view (default) with toggle to side-by-side
- Added lines green, removed lines red, context lines neutral
- Collapsible hunks
- File header with change stats (+N/-M)
- Scroll sync for side-by-side
- "Copy diff" button
- Navigation between files in multi-file diffs

Props:
```ts
interface Props {
  diff: string;  // unified diff text
  mode: 'unified' | 'side-by-side';
  onModeChange: (mode: 'unified' | 'side-by-side') => void;
}
```

### P1.6 — Branch/Tag Picker

Create `frontend/src/lib/components/lore/LoreBranchPicker.svelte`:

- Dropdown: list branches and tags
- Create branch: inline form (name + source branch)
- Delete branch: confirm dialog
- Switch branch: button
- Current branch indicator (highlighted)
- Branch age / last commit info

Props:
```ts
interface Props {
  branches: LoreBranch[];
  currentBranch: string;
  onCreate: (name: string, from: string) => void;
  onDelete: (name: string) => void;
  onSwitch: (name: string) => void;
}
```

### P1.7 — Lock Status

Create `frontend/src/lib/components/lore/LoreLockBadge.svelte`:

- Small badge on file tree items showing lock status
- Who holds the lock, since when
- Click → unlock dialog (if you own it) or info (if someone else owns it)
- Uses `--color-warning` for locked, `--color-success` for unlocked

Props:
```ts
interface Props {
  locked: boolean;
  lockedBy: string | null;
  lockedAt: number | null;
  onClick: () => void;
}
```

### P1.8 — New LoreChannel Shell

Create `frontend/src/lib/components/lore/LoreChannelShell.svelte`:

- Layout: 3-panel (tree | viewer | history) with resizable dividers
- Top bar: repo name, branch picker, search, health status
- Tab bar: messages / files / history / diff (like workspace views)
- Uses existing Wabi layout patterns (WorkspaceViewBar)
- Graceful degradation: if Lore not connected, show connect panel
- Role-aware: hide write actions for viewers

**DO NOT** modify the existing `LoreChannel.svelte` — the new shell replaces it. The old one stays for now (will be deleted later).

## CSS

Create `frontend/src/styles/components/lore-channel.css`:

- Use Wabi tokens exclusively
- File tree: compact, dense, hover highlights
- Diff viewer: line-height for readability, color-coded additions/deletions
- Responsive: on mobile, panels stack vertically
- No raw hex colors — use `--surface-*`, `--text-*`, `--accent-*` tokens

## Constraints

- **Svelte 5 runes only**: `$props`, `$derived`, `$effect`. No `export let`, no `$:`.
- **No headless browser testing** — Wabi crashes Skia in Chromium. Verify with `bun run check`.
- **Wabi tokens**: `--surface-raised`, `--text-secondary`, `--font-mono`, `--radius-md`, `--space-*`
- **No new global state** — keep everything local to components or existing `loreStore.ts`
- **Accessibility**: aria-labels on icon buttons, keyboard navigation for tree

## Files to Create

1. `frontend/src/lib/components/lore/LoreFileTree.svelte`
2. `frontend/src/lib/components/lore/LoreFileViewer.svelte`
3. `frontend/src/lib/components/lore/LoreHistoryPanel.svelte`
4. `frontend/src/lib/components/lore/LoreBlameView.svelte`
5. `frontend/src/lib/components/lore/LoreDiffViewer.svelte`
6. `frontend/src/lib/components/lore/LoreBranchPicker.svelte`
7. `frontend/src/lib/components/lore/LoreLockBadge.svelte`
8. `frontend/src/lib/components/lore/LoreChannelShell.svelte`
9. `frontend/src/styles/components/lore-channel.css`
10. `frontend/src/lib/components/lore/index.ts` — barrel export

## Files to Modify

1. `frontend/package.json` — add `shiki` (or highlight.js) dependency
2. `frontend/src/lib/loreStore.ts` — add `loreBlame` store if needed

## Verification

```bash
cd /var/home/Ronin/wabi/frontend
bun run check 2>&1 | tail -20
```

## Output

Write a report to `/var/home/Ronin/wabi/audit/lore-p1-browser-ux-report.md` with:
- What was implemented
- Component list with line counts
- Type check results
- Known gaps / next steps
- CSS token usage audit