# Lore capability gate — `false` must never be cached forever

**Symptom (2026-08-08):** The channel creator shows Text/Voice/Forum/Gallery/Wiki/Planner/Folder but no **Code** chip, even though the lore addon is healthy on the server (`/api/addons/lore/health` → `{status:"ok"}`, `POST /api/addons/lore/repos` → 401 missing-auth = route alive). The chip was hidden for the entire session.

## Root cause

`frontend/src/lib/addonInventory.ts` `hasAddonCapability(addonId)`:

```ts
const capabilityCache = new Map<string, Promise<boolean>>();
// cache.set(normalizedId, promise) — result cached FOREVER, including false
```

`ChannelSidebar.svelte` calls it ONCE in `onMount`. If the inventory fetch races the very first page load (stale SW shell, flaky network), the promise resolves `false` — and because the cache is permanent, every subsequent check returns the cached `false`. Additionally `CreateChannelForm.svelte` had a reactive that FORCE-RESET the selection: `$: if (!loreAvailable && newChannelType === 'lore') onTypeChange('text')` — so even trying to pick Code silently bounced you back to Text.

## Fix (landed)

1. **`hasAddonCapability`**: only `true` is sticky. Wrap the probe in try/finally; on resolution, if the result is `false` and the cache still points at this promise, evict it (`capabilityCache.delete(normalizedId)`) so the next call re-probes. Concurrent callers during flight still share the in-flight promise.
2. **`CreateChannelForm.svelte`**: the Code chip is ALWAYS rendered (no `...(loreAvailable ? [...] : [])`). When `loreAvailable === false` it renders disabled (`aria-disabled`, click ignored, hint text "Addon unavailable", title explains lore addon not enabled) and the submit button is gated. No more hidden chip, no more force-reset.
3. **`ChannelSidebar.svelte`**: removed the `if (!ok && newChannelType === 'lore') newChannelType = 'text'` reset; kept the `loreAvailable` gate for the LoreWorkspace "New Code Channel" button.
4. Exported `resetAddonCapabilityCache()` for future shell-refresh re-probes.

## Debug order when the Code chip is missing

1. Server truth first: `curl -s localhost:3001/api/addons/lore/health` → must be `ok`, not `disabled`/`not_found`.
2. Capability source: `GET /api/addons` must list `"id":"lore"` with `enabled:true` — the inventory check reads this list.
3. Frontend gate: grep `capabilityCache` — if `false` is cached, the chip is gone for the session regardless of server health.
4. After fix, hard refresh: the chip appears disabled-then-enabled as the re-probe resolves, never missing.

## "Lore channel feels dead" — dead-button audit (same day)

Even with the chip fixed, `LoreChannelShell` shipped with several clickable-but-dead controls. Audit list (all found and fixed 2026-08-08):

1. **`handleContextMenu` was a TODO no-op** (`// TODO: context menu with lock/unlock/delete/compare options`) yet `LoreFileTree`/`LoreTreeNode` DO wire right-click to it → right-clicking a file did nothing. Implemented a minimal `contextMenu` state `{path,x,y}` + fixed-position menu with Lock/Unlock/Compare/Delete reusing the EXISTING `handleLock`/`handleUnlock`/`handleDelete` (those were already wired) + `handleCompare`. Close on backdrop click; clamp position to `window.innerWidth/Height`.
2. **`handleDeleteBranch` was a TODO** (`// TODO: wire delete branch API`) and NO delete-branch route exists in `core/crates/wabi-server/src/api/lore.rs` (route table: list_branches, create_branch, merge_branch only). Removing the affordance beats leaving a dead button: dropped `onDelete` prop + confirm-delete UI + right-click handler from `LoreBranchPicker.svelte` entirely.
3. **`handleUpload` passed args in the wrong order**: `uploadLoreFile(token, channelId, file, repoPath, msg)` but the signature is `(token, channelId, path: string, file: File, message?)` → runtime throw on every upload. Fix: `uploadLoreFile(token, channelId, repoPath, file, msg)`. Note: this was a **pre-existing svelte-check error in HEAD** (`Argument of type 'File' is not assignable to parameter of type 'string'` at LoreChannelShell:237) that had been ignored as "pre-existing noise" — always grep the pre-existing error list for files you're about to touch; pre-existing ≠ irrelevant, it can be a real runtime bug.
4. `handleTemplateSelect` also had a `// TODO: create file from template via API` — left as-is (out of scope that day); check it before next lore ship.
5. `LoreConnectModal` already surfaces real server errors (`err.error || fallback` → `.error-message` block) — good pattern, keep.

**Rule of thumb for lore-channel audits:** grep `lib/components/lore/` for `TODO` and for `void`-stub handlers; every visible button must either do something real or not render.
