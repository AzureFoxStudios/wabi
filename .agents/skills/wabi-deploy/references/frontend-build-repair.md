# Frontend Build Repair Cheat-Sheet

## Context

Wabi's frontend has undergone multiple partial modularisation passes. Files were split, renamed, or stubbed out, but import chains were not always updated. Vite's `bun run build` surfaces these as hard errors because Rollup cannot resolve the missing exports. `tsc --noEmit` often does NOT catch them if the missing module has no `.d.ts` declaration.

## Symptom

```
✗ Build failed in 5.Xs
error during build:
Could not resolve "./place-search" from "src/lib/place-mentions.ts"
Could not resolve "./livekitSfu" from "src/lib/livekitToken.ts"
"syncProgress" is not exported by "src/lib/socket-manager.ts", imported by "src/lib/socket.ts"
"buildRTCConfig" is not exported by "src/lib/mediaRuntime.ts", imported by "src/lib/audioCapture.ts"
```

## Repair Technique

For each error, identify the ACTUAL source of the symbol:

```bash
# 1. Find who defines the symbol
cd frontend
grep -rn "export.*function buildRTCConfig\|export.*buildRTCConfig" src/lib/

# 2. Find every file that imports the symbol
grep -rn "buildRTCConfig" src/lib/ --include="*.ts" --include="*.svelte"
```

Then choose ONE of:

### A. Redirect import to correct module

If the symbol exists but the import path is stale (renamed module):

```bash
sed -i "s|from './mediaRuntime';|from './turnConfig';|g" src/lib/audioCapture.ts
```

### B. Create a stub module

If the entire module was deleted but something still imports it:

```typescript
// src/lib/livekitSfu.ts
export let livekitRoom: any = null;
export let livekitChannelId: string | null = null;

export async function connectLivekitSfu(_c: string, _d: string): Promise<void> {}
export async function disconnectLivekitSfu(_o?: { preserveCallState?: boolean }): Promise<void> {}
```

### C. Add a stub re-export in a compatibility shim

If a backwards-compatibility file (`socket.ts`) re-exports symbols that no longer exist in the real implementation (`socket-manager.ts`), add a local stub:

```typescript
// In socket.ts
import { writable } from 'svelte/store';
export const syncProgress = writable<number>(0);
```

This lets consuming components (`SyncLoadingOverlay.svelte`) compile without touching them.

## Known Landmines (as of May 2026)

| Missing import | Real location | Fix |
|---|---|---|
| `./place-search` | `./placeSearch.ts` + `./placeStore.ts` | Redirect imports |
| `./livekitSfu` | Module deleted | Create stub `livekitSfu.ts` |
| `syncProgress` from `socket-manager.ts` | Never existed there | Add `writable(0)` stub in `socket.ts` |
| `buildRTCConfig` from `mediaRuntime.ts` | Actually in `./turnConfig.ts` | Redirect import |
| `sendMessage` from `socket-manager.ts` | Moved to `channelStore.ts` or `api.ts` | Check current architecture; often REST replaced Socket.IO |

## Rule of Thumb

- **If the symbol IS a function with real logic** → find where it moved and redirect.
- **If the symbol IS a store used by UI** → stub it locally in the shim that components import.
- **If the entire module is gone with no replacement** → create a stub file with no-op exports.

## Post-Repair Verification

```bash
cd frontend
STATIC_BUILD=1 bun run build
```

Iterate until build succeeds. The process is usually 3–6 missing-export fixes.
