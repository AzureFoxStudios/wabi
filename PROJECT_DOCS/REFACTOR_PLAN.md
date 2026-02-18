# Refactor Plan — Step-by-Step Cleanup
*Generated: 2026-02-18 | See also: CODE_QUALITY_AUDIT.md*

Guiding principle: **Extract safe, isolated things first. Never refactor and change behaviour at the same time. Touch god files last, not first.**

---

## Phase 1 — Zero-Risk Wins (No Functional Changes)
*Est: 2–3 hours total. Zero risk of breaking anything.*

### Step 1: Delete `temp_edit.js`
```
frontend/src/lib/temp_edit.js  →  DELETE
```
A dev scratchpad committed to production source. Just delete it.

---

### Step 2: Create `constants.ts` files
Create named constants for every magic string before touching any logic. This is mechanical and safe — and will reveal exactly how pervasive the magic strings are.

**`backend/src/constants.ts`** (new file):
```typescript
export const DEFAULT_WORKSPACE_ID = 'default-workspace';
export const DEFAULT_CHANNEL_ID = 'general';
export const DEFAULT_VOICE_CHANNEL_ID = 'voice';
export const DATA_DIR = process.env.DATA_DIR || '/app/data';
export const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
export const BUSINESS_DATA_DIR_NAME = 'business';

export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MOD: 'mod',
  MEMBER: 'member',
  GUEST: 'guest'
} as const;
export type RoleName = typeof ROLES[keyof typeof ROLES];
```

Then find-replace all hardcoded occurrences in `server.ts`, `database.ts`, `roleMiddleware.ts`.

---

### Step 3: Fix `updateBrowserTitle` duplication in `socket-manager.ts`
The function is defined twice with identical bodies — once as a private class method, once as a module-level function.

- Delete the private class method `SocketManager.updateBrowserTitle()`
- Change all internal class calls to `updateBrowserTitle()` (the module-level one)
- One function, one definition.

---

### Step 4: Extract `fetchWithTimeout` in `api.ts`
The AbortController+timeout pattern is copy-pasted 7 times. Extract it:

```typescript
// api.ts — add at top
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
```

Replace all 7 manual occurrences with calls to this helper.

---

### Step 5: Add logging to all empty/silent catch blocks
Go through every `catch {}` and `catch (_) {}` in `server.ts` and `database.ts`. At minimum add:
```typescript
catch (e) {
  console.error('[context description]', e);
}
```
No logic change — pure observability improvement.

---

## Phase 2 — Extract Self-Contained Backend Services
*These modules have NO dependency on in-memory Maps (channels, users, etc.). Safe to extract.*

### Step 6: `backend/src/services/fileEncryptionService.ts` (new file)
Move out of `server.ts`:
- `AT_REST_MAGIC`
- `FILE_ENCRYPTION_KEY`
- `maybeEncryptForAtRest(plain: Buffer): Buffer`
- `maybeDecryptFromAtRest(buffer: Buffer): Buffer`
- `writeUploadFile(filePath: string, payload: Buffer): void`

Only the upload/download handlers use these — clean cut.

---

### Step 7: `backend/src/services/uploadTokenService.ts` (new file)
Move out of `server.ts`:
- `UPLOAD_TOKEN_SECRET`
- `UPLOAD_TOKEN_TTL_MS`
- `base64UrlEncodeBuffer(buf: Buffer): string`
- `base64UrlDecodeToBuffer(input: string): Buffer`
- `signUploadToken(uploadId: string, ownerKey: string): string`
- `verifyUploadToken(token: string, uploadId: string, ownerKey: string): boolean`

Nothing in the socket layer touches these.

---

### Step 8: `backend/src/db/repositories/roleRepository.ts` (new file)
This is the most important step before touching socket handlers, because permissions checks are called everywhere.

Move the raw `db.prepare()` calls out of `server.ts` into a proper repository:
- `getUserRoleInfo(dbUserId?: number)`
- `getRoleDefinitions(workspaceId: string)`
- `getRolePriority(roleName: string, workspaceId: string)`
- `workspaceHasOwner(): boolean`
- All emoji role rule queries (INSERT / DELETE / SELECT from `emoji_role_rules`)
- `setRoleDisplayName(roleName: string, displayName: string, workspaceId: string)`

---

## Phase 3 — Fix the Deferred `null` Initialization Bug

### Step 9: `backend/src/services/messageExpiryService.ts` (new file)
`deleteMessageById` is currently declared as `null` and assigned hundreds of lines later — a latent crash bug.

Create a proper service that imports its dependencies:
```typescript
// messageExpiryService.ts
import { messageRepository } from '../db/repositories/messageRepository';
import { channelMessages, channels } from '../store/memoryStore'; // Phase 4 prereq
import type { EmitToChannelFn } from '../types';

export function deleteMessageById(
  channelId: string,
  messageId: string,
  emitToChannel: EmitToChannelFn
): void { ... }

export function scheduleMessageDeletion(...): void { ... }
export function cancelMessageDeletion(messageId: string): void { ... }
export function restoreMessageDeletionTimers(emitToChannel: EmitToChannelFn): void { ... }
```

This eliminates the temporal coupling between initialization order.

---

## Phase 4 — Extract Route Handlers from `server.ts`
*Do in order: least → most in-memory-state dependency.*

### Step 10: Routes with zero in-memory state dependency (safest first)
- **`api/proxyRoutes.ts`** — URL preview (`/api/url-preview`) + image proxy (`/api/image-proxy`). Pure HTTP, no socket state.
- **`api/pluginRoutes.ts`** — Plugin management routes (use `pluginLoader`, no Maps).
- **`api/guestRoutes.ts`** — Guest code verification (`/api/guest/verify-code`).

Pattern for each: extract the handler function, import it in `server.ts`, call it:
```typescript
// server.ts (before)
if (url.pathname === "/api/url-preview" && req.method === "GET") {
  // 60 lines of logic
}

// server.ts (after)
if (url.pathname === "/api/url-preview" && req.method === "GET") {
  await handleUrlPreview(req, res);
  return;
}
```

---

### Step 11: `api/uploadRoutes.ts` (new file)
Extract all upload endpoints:
- `POST /api/upload` (simple upload)
- `POST /api/upload/resumable/init`
- `GET /api/upload/resumable/status`
- `PUT /api/upload/resumable/chunk`
- `POST /api/upload/resumable/complete`
- `POST /api/upload-profile-picture`
- `POST /api/upload-group-avatar`
- `POST /api/upload-background-image`
- `POST /api/emoji/upload`

These only touch the filesystem and `uploadTokenService` / `fileEncryptionService` — no in-memory Maps.

---

### Step 12: `api/businessRoutes.ts` (new file)
Extract all business data endpoints:
- `GET /api/business/get`
- `POST /api/business/sync`
- `GET /api/business/resources`
- `POST /api/business/resource/create`
- `PUT /api/business/resource/:id`
- `DELETE /api/business/resource/:id`

Move with them: `filterForUser`, `resolveWorkspaceId`, `initializeWorkspace`, `saveBusinessData`, `loadBusinessData`, the `businessWorkspaces` Map.

At this point `server.ts` is dramatically smaller.

---

## Phase 5 — Extract Socket Event Handlers (Backend)
*Prerequisite: create `store/memoryStore.ts` first so all handlers can share state.*

### Step 13: `backend/src/store/memoryStore.ts` (new file)
Move all in-memory Maps here:
```typescript
export const channels = new Map<string, Channel>();
export const channelMessages = new Map<string, Message[]>();
export const users = new Map<string, User>();
export const pinnedMessages = new Map<string, Set<string>>();
export const sessions = new Map<string, Session>();
export const userCurrentChannel = new Map<string, string>();
export const channelTypingUsers = new Map<string, Set<string>>();
// voice state maps, etc.
```

All socket handlers import from this. Not pretty, but an essential intermediate step.

---

### Step 14: Extract socket handlers — safest order (least cross-domain coupling first)
Create a `socket/` directory. Each file exports a `register(io, socket)` function.

1. **`socket/emoteHandler.ts`** — emote upload/delete (only touches `emotes` Map + filesystem)
2. **`socket/roleHandler.ts`** — assign/remove role, role definitions, emoji role rules (uses `roleRepository`)
3. **`socket/webrtcHandler.ts`** — WebRTC signaling relay (just forwards events, no state at all)
4. **`socket/voiceHandler.ts`** — voice channel join/leave/subscribe + voice peer graph
5. **`socket/channelHandler.ts`** — create/delete channel, breakout rooms, threads, settings
6. **`socket/messageHandler.ts`** — send/edit/delete message, pin, reactions, typing
7. **`socket/dmHandler.ts`** — DM and group CRUD
8. **`socket/userHandler.ts`** — join, rejoin, profile update, disconnect

The `io.on("connection")` block in `server.ts` becomes a clean router:
```typescript
io.on("connection", (socket) => {
  registerUserHandler(io, socket);
  registerMessageHandler(io, socket);
  registerChannelHandler(io, socket);
  // ...
});
```

---

## Phase 6 — Frontend: `calling.ts`
*Do after backend is clean — don't debug both sides simultaneously.*

### Step 15: Extract the most isolated sub-modules first (no stores, no WebRTC)
- **`audio/dspPipeline.ts`** — `createDspAudioPipeline`, `disposeDspAudioPipeline`. Pure audio node graph, no stores.
- **`audio/speakingDetector.ts`** — `startRemoteSpeakingMonitor`, `stopRemoteSpeakingMonitor`, `computeRms`. Pure audio analysis.
- **`audio/performanceGuard.ts`** — `startPerformanceGuard`, `stopPerformanceGuard`. Pure timer logic.
- **`webrtc/diagnostics.ts`** — `sampleCallConnectionDiagnostics`, `startCallDiagnosticsPolling`. Pure RTCStats polling.
- **`webrtc/videoQuality.ts`** — tier table + `applyAdaptiveVideoQualityTier`. Pure sender manipulation.

---

### Step 16: Store the socket once — remove prop drilling
Add an `init` function to `calling.ts`:
```typescript
let _socket: Socket | null = null;
export function initCalling(socket: Socket): void {
  _socket = socket;
}
```
Remove `socket: Socket` from every exported function signature. This is mechanical but high-value.

---

### Step 17: Extract screen share
- **`calling/screenShare.ts`** — `startScreenShare`, `stopScreenShare`, `createScreenShareOffer`, `handleScreenShareOffer`, `handleScreenShareAnswer`, `handleScreenShareIceCandidate`.

Clear boundary: screen share peer connections are a different type (`'screen-share-outbound'` / `'screen-share-inbound'`).

---

### Step 18: Extract voice channel logic
- **`calling/voiceChannel.ts`** — `joinVoiceChannel`, `leaveVoiceChannel`, `addVoiceChannelListen`, `removeVoiceChannelListen`.

---

## Phase 7 — Frontend: `socket-manager.ts`

### Step 19: Decouple `authStore` from the transport layer
Replace the direct import with a callback:
```typescript
// socket-manager.ts
class SocketManager {
  private onAuthError?: (message: string, type: string) => void;
  
  setAuthErrorCallback(cb: (message: string, type: string) => void): void {
    this.onAuthError = cb;
  }
}

// The component that initializes the socket:
socketManager.setAuthErrorCallback((msg, type) => authStore.setAuthError(msg, type));
```

---

### Step 20: Move `decryptMessagesForChannel` to `e2eManager.ts`
The function already belongs there conceptually. `socket-manager.ts` should call:
```typescript
await e2eManager.decryptChannelMessages(channelId, messages, channelList, token);
```

---

### Step 21: Complete the `socket.ts` / `webrtc.ts` migration
1. Run find-replace across frontend: `from '$lib/socket'` → `from '$lib/socket-manager'`
2. Delete `frontend/src/lib/socket.ts`
3. Run find-replace: `from '$lib/webrtc'` → `from '$lib/calling'`
4. Delete `frontend/src/lib/webrtc.ts`

---

## Where to Start Tomorrow Morning

**Do Phase 1, Steps 1–5 first.**

- Takes 2–3 hours
- Zero risk of breaking functionality
- Makes every subsequent phase faster and safer
- The constants file alone will show you exactly how many places each magic string appears — vital information before moving code

**Biggest mistake to avoid:** Trying to refactor `server.ts` top-to-bottom before extracting the services it depends on. That way leads to a week of broken builds.
