# LoreChannelShell Architecture (2026-08-08)

## Entry point
`Chat.svelte` imports `LoreChannelShell` (not the old `LoreChannel` monolith) and renders it when `currentChannelType === 'lore'`.

## Component tree
```
LoreChannelShell
├── No-repo state: LoreConnectModal (triggered by "Connect Repository" button, Owner/Admin/Developer only)
├── Top bar: repo name + LoreBranchPicker + New button + Upload button + health dot
├── Tab bar: Files | History | Diff | Review | Timeline | Governance
├── Panels (switched by activeTab):
│   ├── Files: LoreFileTree (left 280px) + LoreFileViewer (right flex)
│   │           └── fileView toggle: view | blame (LoreBlameView)
│   │           └── LoreLockBadge in file-viewer-header
│   ├── History: LoreHistoryPanel (main) + LorePushCalendar (right sidebar 320px)
│   ├── Diff: LoreDiffViewer (unified | side-by-side)
│   ├── Review: LoreReviewPanel (placeholder — needs review API data)
│   ├── Timeline: LoreActivityFeed (derived from $loreRevisions)
│   └── Governance: LoreAuditViewer (placeholder — needs audit API data)
├── Bottom bar: LoreCitationRegistry (conditional on citations.length > 0)
└── Overlays:
    ├── LoreConnectModal (showConnectModal state, from empty-channel prompt)
    ├── LoreTemplatePicker (showTemplates state, from "New" button)
    └── LoreCitationPreview (activeCitation state, from citation click)
```

## Store dependencies
All state flows from `loreStore.ts` Svelte writable stores:
- `$loreRepo`, `$loreFiles`, `$loreRevisions`, `$loreBranches`
- `$loreFileDiff`, `$loreFileHistory`, `$loreLoading`, `$loreHealth`, `$loreError`
- Actions: `loadLoreRepo()`, `loadLoreHistory()`, `loadLoreHealth()`, `loadLoreFileDiff()`, `loadLoreFileHistory()`

## Prop contracts (key components)
- **LoreFileTree**: `files: LoreFileInfo[]`, `selectedPath`, `loading`, `onSelect`, `onOpen`, `onContextMenu`
- **LoreFileViewer**: `filePath`, `fileContent`, `fileInfo`, `loading`, `onClose`
- **LoreHistoryPanel**: `revisions`, `branches`, `loading`, `onRevisionSelect`, `onCompare`
- **LoreDiffViewer**: `diff: string`, `mode: 'unified'|'side-by-side'`, `onModeChange`
- **LoreBranchPicker**: `branches`, `currentBranch`, `onCreate`, `onDelete`, `onSwitch`
- **LoreLockBadge**: `locked`, `lockedBy`, `lockedAt`, `onClick`
- **LoreCitationChip**: `citation`, `drift`, `onClick`, `onPin`, `onUpdate`
- **LoreCitationRegistry**: `citations[]`, `onCitationClick(id)`, `onPin(id)`, `onUpdate(id)`
- **LoreTemplatePicker**: `templates[]`, `onSelect(template)` — template shape: `{ id, name, file_path, language, category }`
- **LoreReviewPanel**: `review`, `onApprove`, `onRequestChanges`, `onMerge`, `onClose`
- **LoreActivityFeed**: `activity[]` (type: commit/review/merge/lock/release, author_id, message, timestamp)
- **LorePushCalendar**: `commits[]` (date, count)
- **LoreAuditViewer**: `events[]` (id, type, author_id, description, timestamp, details)
- **LoreConnectModal**: `channelId`, `onConnected`, `onClose` — calls `POST /api/addons/lore/repos` with `{ channelId, repoName, loreServerUrl }`

## Data flow
1. `$effect` on `activeChannel` triggers `loadLoreRepo() + loadLoreHistory() + loadLoreHealth()`
2. `loadLoreRepo()` fetches repo metadata + file list → updates `$loreRepo`, `$loreFiles`
3. `loadLoreHistory()` fetches revisions + branches → updates `$loreRevisions`, `$loreBranches`
4. File click → `handleOpen()` → fetches signed URL → loads file content → `fileContent` state
5. Branch switch → `handleSwitchBranch()` → reloads repo
6. Upload → `handleUpload()` → calls `uploadLoreFile()` → reloads repo

## Role gates
- `canEdit`: owner/admin/developer → can create branches, upload, lock, unlock, delete
- `canAssetWrite`: canEdit || artist → can upload files
- "New" and "Upload" buttons hidden for viewers

## Known gaps
- Review panel has no live data source (no review API endpoint yet)
- Audit viewer has no live data source (no audit API endpoint yet)
- Blame view has no data source (Lore CLI doesn't have blame command)
- Template picker doesn't create files yet (no template API endpoint)
- Citation registry is empty placeholder (no citation data source)
- Branch delete not wired to API
- `file_history` API call passes `&str` not `Option<&str>` (signature mismatch)