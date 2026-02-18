# Code Quality Audit — Wabi
*Generated: 2026-02-18*

This document identifies violations of low coupling, high cohesion, and separation of concerns found throughout the codebase.
Issues are grouped by file/area and ranked by severity (🔴 Critical → 🟡 Moderate → 🟢 Minor).

---

## 1. `backend/src/server.ts` — God File (Most Critical)

### 🔴 1.1 — Single file does everything

`server.ts` is a single file responsible for **all** of the following, making it a textbook "God Object":

| Responsibility | Should Be In |
|---|---|
| HTTP server creation & CORS | `server.ts` (ok) |
| Static file serving | A dedicated `staticHandler.ts` |
| Profile picture upload | `api/mediaRoutes.ts` |
| Group avatar upload | `api/mediaRoutes.ts` |
| Background image upload | `api/mediaRoutes.ts` |
| Resumable chunked upload (init/chunk/complete/status) | `api/uploadRoutes.ts` |
| Emoji upload | `api/emojiRoutes.ts` |
| URL preview + image proxy | `api/proxyRoutes.ts` |
| Business data CRUD (todos, sprints, projects, calendar, diary, resources) | `api/businessRoutes.ts` |
| Guest code verification | `api/guestRoutes.ts` |
| Plugin management API | `api/pluginRoutes.ts` |
| Socket.IO connection lifecycle | `socket/connectionHandler.ts` |
| 50+ socket event handlers | Separate per-domain socket handlers |
| Voice channel state machine | `socket/voiceHandler.ts` |
| WebRTC signaling relay | `socket/webrtcHandler.ts` |
| Role management events | `socket/roleHandler.ts` |
| In-memory channel/message/user store | `store/memoryStore.ts` |
| Business data file I/O | `services/businessService.ts` |
| Auto-delete timers | `services/messageExpiryService.ts` |
| Resumable upload token signing/verification | `services/uploadTokenService.ts` |
| At-rest file encryption/decryption | `services/fileEncryptionService.ts` |

**Estimated line count for a single file: ~4,500+ lines.** This is unworkable for maintenance.

---

### 🔴 1.2 — Direct `db.prepare()` calls bypass the repository layer

Despite having repositories (`channelRepository`, `messageRepository`, etc.), `server.ts` bypasses them constantly with raw `db.prepare()` calls:

```typescript
// In getUserRoleInfo() — raw SQL, not using any repository
const roleRows = db.prepare(
  'SELECT role_name, priority, color FROM roles WHERE role_name IN (' + roles.map(() => '?').join(',') + ') ORDER BY priority DESC'
).all(...roles);

// In socket event handlers — raw SQL for emoji role rules
db.prepare(`INSERT INTO emoji_role_rules ...`).run(...);
db.prepare(`DELETE FROM emoji_role_rules WHERE id = ? ...`).run(...);
db.prepare(`SELECT role_name, remove_on_unreact FROM emoji_role_rules ...`).all(...);
db.prepare(`UPDATE roles SET display_name = ?`).run(...);
```

This defeats the entire point of the repository pattern. The data access layer has no single point of control.

---

### 🔴 1.3 — Dual-state data management (in-memory + database)

Every entity is maintained in **both** an in-memory `Map` and SQLite simultaneously. Business logic must keep them in sync manually:

```typescript
// Example: deleting a channel — 4 separate data stores to update manually
channels.delete(channelId);             // Map
channelMessages.delete(channelId);      // Map
pinnedMessages.delete(channelId);       // Map
channelRepository.delete(channelId);    // SQLite
```

There is no single source of truth. If any of these steps fail silently, the state diverges. This pattern is scattered across dozens of socket event handlers.

---

### 🔴 1.4 — `deleteMessageById` is a `null` variable assigned after initialization

```typescript
// Declared at the top as null
let deleteMessageById: ((channelId: string, messageId: string) => void) | null = null;

// ... hundreds of lines later, after Socket.IO is initialized ...
deleteMessageById = (channelId: string, messageId: string) => { ... };
```

This function is called in `restoreMessageDeletionTimers()` which runs at startup — before `deleteMessageById` is assigned. This is a latent null-reference bug. It bypasses TypeScript's type system and creates temporal coupling between initialization order.

---

### 🔴 1.5 — Business filtering logic defined inside the HTTP request handler

```typescript
server.on('request', async (req, res) => {
  // ...
  
  // These functions are REDEFINED on every single HTTP request:
  function filterForUser(data: BusinessData, requestingUserId: number | null): BusinessData { ... }
  function resolveWorkspaceId(userId: number): string { ... }
```

Two functions are defined *inside* the per-request callback. This means they are recreated on every HTTP request (thousands of times per session). They should be module-level functions.

---

### 🟡 1.6 — Hardcoded magic strings and paths throughout

No constants file. Magic strings are repeated across many handlers:

```typescript
// Repeated in 10+ places
'default-workspace'

// Hardcoded paths
const DATA_DIR = '/app/data';
const UPLOADS_DIR = '/app/uploads';

// Role names as raw strings everywhere
['owner', 'admin'].includes(myRoleInfo.highestRole)
"INSERT OR IGNORE INTO user_roles ... WHERE role_name = 'owner'"
```

---

### 🟡 1.7 — Empty catch blocks swallow errors silently

```typescript
try { messageRepository.softDelete(messageId); } catch {}
try { messageRepository.update(data.messageId, { is_pinned: ... }); } catch (dbError) { console.error(...); }
try { channelRepository.delete(breakoutChannel.id); } catch (dbError) { console.error(...); }

// In database.ts migrations:
} catch (e) {
  // Column may already exist
}
```

Silent error swallowing makes debugging extremely difficult. At minimum, errors should be logged with context.

---

### 🟡 1.8 — `channel-error` socket event used for both errors and functional feedback

```typescript
// Used to report cheatcode result (functional message, not an error):
socket.emit("channel-error", `[TEST] Role granted: ${TEST_ROLE_CHEATCODE_ROLE}. Cheatcode is now disabled.`);

// Used as actual errors:
socket.emit("channel-error", "Cannot delete base channels");
```

And in the frontend, this is handled with `alert()`:
```typescript
sock.on('channel-error', (error: string) => {
    alert(error);
});
```

Functional acknowledgment messages piggyback on an error event, and error display uses `alert()` which blocks the UI thread. Both are wrong.

---

## 2. `frontend/src/lib/socket-manager.ts` — Frontend God Module

### 🔴 2.1 — `SocketManager` class handles too many concerns

The `SocketManager` class + the surrounding module file is responsible for:

- WebSocket connection lifecycle (valid)
- Reconnection with exponential backoff (valid)
- **Decrypting DM messages** (should be in `e2eManager.ts`)
- **Updating Svelte stores directly** (couples socket layer to UI state layer)
- **Calling `calling.ts` functions** (couples socket layer to WebRTC layer)
- **Calling `chatStorage.saveMessage()`** (couples socket layer to persistence layer)
- **Calling `showNotification()`** (couples socket layer to notification layer)
- **Updating the browser tab title** (UI concern)
- **Reading localStorage** for unread counts (persistence concern)
- **Handling P2P file transfer signals** (imports from `p2pFileTransfer.ts`)

---

### 🔴 2.2 — `updateBrowserTitle` is defined twice

```typescript
// Defined as a private method on the SocketManager CLASS:
private updateBrowserTitle(): void {
    if (!browser) return;
    const total = get(unreadCount);
    if (total === 0) { document.title = 'Wabi Chat'; }
    // ...
}

// AND ALSO defined as a module-level function (separate, identical implementation):
function updateBrowserTitle(): void {
    if (!browser) return;
    const total = get(unreadCount);
    if (total === 0) { document.title = 'Wabi Chat'; }
    // ...
}
```

Exact duplicate logic. The module-level function is used by `markMessagesAsRead()` and `markChannelAsRead()` while the class method is used internally. They're identical and should be one function.

---

### 🟡 2.3 — `socket.ts` exists only to re-export `socket-manager.ts`

`socket.ts` is a 120-line file that does nothing but re-export everything from `socket-manager.ts`. The file's own comment says: *"Migration: All new code should import from '$lib/socket-manager' directly. This file exists for backwards compatibility only."*

This means half the codebase still uses the old import path, maintaining two entry points for the same module. This should be completed (migrate all imports) or documented as intentional API surface.

---

### 🟡 2.4 — `authStore` is mutated directly from the socket layer

```typescript
// Inside socket-manager.ts — the transport layer modifying auth state
authStore.setAuthError('Connection lost. Please refresh the page.', 'connection_lost');
authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
```

The socket layer directly drives the auth store. This creates tight coupling: the transport module knows about and writes to application-level auth state. Auth error handling should flow through an event/callback interface, not a direct import.

---

## 3. `frontend/src/lib/calling.ts` — Second God Module

### 🔴 3.1 — Massive single module with unrelated concerns

`calling.ts` (~1,400 lines) handles:

| Concern | Should Be Separate |
|---|---|
| WebRTC peer connection lifecycle | `webrtc/peerManager.ts` |
| ICE candidate queue management | `webrtc/peerManager.ts` |
| DSP audio pipeline (filters, compressor) | `audio/dspPipeline.ts` |
| Audio processing mode resolution | `audio/audioProcessing.ts` |
| Performance guard (CPU load detection) | `audio/performanceGuard.ts` |
| Local/remote speaking detection (RMS) | `audio/speakingDetector.ts` |
| Spatial audio engine management | `audio/spatialAudio.ts` (partially exists at `audio/spatialEngine.ts`) |
| Video quality adaptation (bitrate tiers) | `webrtc/videoQuality.ts` |
| Connection diagnostics polling | `webrtc/diagnostics.ts` |
| Call state (start/end/answer/reject) | `calling/callController.ts` |
| Screen share (start/stop/offer) | `calling/screenShare.ts` |
| Voice channel join/leave | `calling/voiceChannel.ts` |
| 20+ exported Svelte stores | |

---

### 🔴 3.2 — Module-level mutable global state

`calling.ts` uses extensive module-level mutable variables as de facto globals:

```typescript
const peerConnections = new Map<string, PeerConnectionState>();
const remoteSpeakingMonitors = new Map<string, SpeakingMonitor>();
let localSpeakingMonitor: SpeakingMonitor | null = null;
let speakingAudioContext: AudioContext | null = null;
let activeVoiceChannelId: string | null = null;
let runtimeAudioModeOverride: EffectiveAudioProcessingMode | null = null;
let performanceGuardInterval: number | null = null;
let performanceLagStrikeCount = 0;
let diagnosticsPollInterval: number | null = null;
let spatialAudioEngine: SpatialAudioEngine | null = null;
let spatialFallbackNoticeShown = false;
// ... and more
```

There are ~15+ mutable module-level variables. This is effectively a singleton with hidden global state. It cannot be unit tested, reset between tests, or safely used in SSR context.

---

### 🟡 3.3 — Socket passed as a parameter into every function

Every function that needs to emit events takes `socket: Socket` as a parameter:

```typescript
export async function joinVoiceChannel(socket: Socket, channelId: string)
export async function leaveVoiceChannel(socket: Socket, channelId: string)
export async function startCall(socket: Socket, targetUserId: string, isVideoCall: boolean)
export async function answerCall(socket: Socket, callerId: string, isVideoCall: boolean)
export function rejectCall(socket: Socket, callerId: string)
export function endCall(socket: Socket)
export async function startScreenShare(socket: Socket)
export function stopScreenShare(socket: Socket)
// ...
```

The socket is not stored in the module but retrieved from `socket-manager.ts` and passed at every call site. This is repeated prop drilling. The calling module should receive the socket once at initialization (or use an event emitter abstraction) rather than accepting it as a parameter on every function.

---

## 4. `frontend/src/lib/api.ts` — Repetitive Boilerplate

### 🟡 4.1 — Copy-pasted AbortController / timeout pattern in every function

Every function in `api.ts` repeats the same 5-line pattern:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8000);
try {
    const res = await fetch(..., { signal: controller.signal });
    // ...
} finally {
    clearTimeout(timeout);
}
```

This pattern appears **7 times** in the file. It should be extracted into a single `fetchWithTimeout(url, options, timeoutMs)` helper. The DRY violation means if the timeout strategy ever changes, it must be updated in 7 places.

---

### 🟡 4.2 — `getUserSettings` returns `any`

```typescript
export async function getUserSettings(token: string): Promise<any> {
```

This is the only function in the file with an untyped return value. The shape of user settings is known and should have a proper interface.

---

## 5. `frontend/src/lib/storage.ts` — Low Cohesion

### 🟡 5.1 — `ChatStorage` mixes archiving, settings, and export

`ChatStorage` is responsible for:
- Message archiving with period rotation
- Storing application settings (via `getSetting`/`setSetting`)
- Archive cleanup on startup
- Exporting archives as JSON files (downloads files with DOM manipulation)
- Computing storage statistics

Settings management and file export are unrelated to message archiving and should be separate concerns.

---

### 🟢 5.2 — `IndexedDBWrapper` is a private inner class with public-looking API

`IndexedDBWrapper` has methods like `getSetting`, `setSetting`, `getArchive`, etc. — a complete general-purpose IDB API. It's buried inside `storage.ts` as a private implementation detail. If any other module ever needs IndexedDB access, this cannot be reused.

---

## 6. `frontend/src/lib/notifications.ts` — Mixed Concerns

### 🟡 6.1 — Audio synthesis, audio playback, and desktop notifications in one file

`notifications.ts` handles three distinct concerns:
1. **Web Audio API synthesis** — Generates a rotary phone ringtone using oscillators, gain nodes, LFOs.
2. **Audio file playback** — Plays `.ogg` notification sounds via `HTMLAudioElement`.
3. **Desktop notification API** — Creates `Notification` objects with click handlers.

These use completely different browser APIs and have different failure modes. They should be split: `callSounds.ts` already exists (for in-call sounds) — ringtone generation belongs there, not in `notifications.ts`.

---

### 🟡 6.2 — Notification settings read from localStorage directly, on every call

```typescript
function getNotificationSquelchSettings() {
    return {
        suppressEveryoneHere: localStorage.getItem('suppressEveryoneHereMentions') === 'true',
        suppressRoleMentions: localStorage.getItem('suppressRoleMentions') === 'true'
    };
}

function getNotificationSound(): string {
    return localStorage.getItem('notificationSound') || '/sounds/ProjectSound.ogg';
}

function getNotificationVolume(): number {
    const volume = localStorage.getItem('notificationVolume');
    return volume ? parseFloat(volume) : 0.5;
}
```

`localStorage` is read on every notification/sound event. There is no settings cache/store. This is repeated in `calling.ts`, `socket-manager.ts`, and `notifications.ts`. A centralized settings store/service would prevent scattered localStorage access.

---

## 7. `backend/src/db/database.ts` — Migration Logic in Wrong Place

### 🟡 7.1 — Schema migrations mixed with database initialization

`database.ts` contains:
- Database connection setup (ok)
- `initializeDatabase()` — schema loading (ok)
- `runMigrations()` — 100+ lines of `ALTER TABLE` statements
- `seedDefaultRoles()` — seed data

Migrations should be in numbered migration files (e.g., `migrations/001_add_handle.sql`), not hardcoded as imperative `addColumnIfMissing` calls in a function. The current approach has no migration history, no rollback support, and no way to know what version the DB is at.

---

### 🟢 7.2 — `seedDefaultRoles` is called on every startup

```typescript
export function initializeDatabase() {
    // ...
    runMigrations();
    seedDefaultRoles(); // Called EVERY startup
}
```

`seedDefaultRoles` uses `INSERT OR IGNORE` which is safe, but seeding inside the main `initializeDatabase` function means seed logic runs unconditionally on every server restart. This couples startup initialization to seed data, making it harder to run the server in test mode with a clean DB.

---

## 8. Cross-Cutting Issues

### 🔴 8.1 — Business data types are all `any[]`

The `BusinessData` interface uses `any` arrays for all domain entities:

```typescript
interface BusinessData {
  workspaceId: string;
  todos: any[];
  calendarEvents: any[];
  diaryEntries: any[];
  projects: any[];
  sprints: any[];
  resources: any[];
  tags: any[];
  graphEdges: any[];
  lastUpdated: number;
}
```

The entire business domain (the feature most likely to grow) has zero type safety. Bugs in todo/project/sprint data shapes will only surface at runtime.

---

### 🟡 8.2 — Magic workspace ID `'default-workspace'` hardcoded everywhere

The string `'default-workspace'` appears in `server.ts`, `database.ts`, `roleMiddleware.ts`, and SQL queries. It is never defined as a named constant. A typo anywhere would silently fail.

---

### 🟡 8.3 — `temp_edit.js` in production source

```
frontend/src/lib/temp_edit.js
```

A file named `temp_edit.js` exists in the production source tree (`frontend/src/lib/`). This is a development scratchpad committed to source.

---

### 🟢 8.4 — `webrtc.ts` exists only to re-export from `calling.ts`

```typescript
// webrtc.ts — entire file content:
export {
    screenShares,
    isSharing,
    startScreenShare,
    // ...
} from './calling';
```

Identical situation to `socket.ts` → `socket-manager.ts`. Two module entry points for the same API creates ambiguity about which to import.

---

## Summary Table

| # | File | Issue | Severity |
|---|---|---|---|
| 1.1 | `server.ts` | God file — 20+ distinct responsibilities | 🔴 Critical |
| 1.2 | `server.ts` | Raw `db.prepare()` bypasses repository layer | 🔴 Critical |
| 1.3 | `server.ts` | Dual-state: in-memory Maps + SQLite, manually synced | 🔴 Critical |
| 1.4 | `server.ts` | `deleteMessageById` is `null` at startup, assigned later | 🔴 Critical |
| 1.5 | `server.ts` | Functions redefined inside per-request callback | 🔴 Critical |
| 1.6 | `server.ts` | Hardcoded magic strings/paths throughout | 🟡 Moderate |
| 1.7 | `server.ts` | Silent `catch {}` swallows errors | 🟡 Moderate |
| 1.8 | `server.ts` | `channel-error` event dual-use; `alert()` for error display | 🟡 Moderate |
| 2.1 | `socket-manager.ts` | SocketManager handles crypto, storage, notifications, WebRTC, UI | 🔴 Critical |
| 2.2 | `socket-manager.ts` | `updateBrowserTitle` defined twice (identical) | 🔴 Critical |
| 2.3 | `socket-manager.ts` | `socket.ts` shim creates two import paths for same module | 🟡 Moderate |
| 2.4 | `socket-manager.ts` | Transport layer mutates auth store directly | 🟡 Moderate |
| 3.1 | `calling.ts` | God module — 8+ distinct concerns | 🔴 Critical |
| 3.2 | `calling.ts` | 15+ module-level mutable globals | 🔴 Critical |
| 3.3 | `calling.ts` | Socket prop-drilled into every function | 🟡 Moderate |
| 4.1 | `api.ts` | AbortController/timeout pattern copy-pasted 7 times | 🟡 Moderate |
| 4.2 | `api.ts` | `getUserSettings` returns `any` | 🟡 Moderate |
| 5.1 | `storage.ts` | ChatStorage mixes archiving, settings, and DOM export | 🟡 Moderate |
| 5.2 | `storage.ts` | IndexedDBWrapper buried and non-reusable | 🟢 Minor |
| 6.1 | `notifications.ts` | Web Audio synthesis + audio playback + desktop notifications | 🟡 Moderate |
| 6.2 | `notifications.ts` | localStorage read on every call, no settings cache | 🟡 Moderate |
| 7.1 | `database.ts` | Migrations are imperative code, not versioned SQL files | 🟡 Moderate |
| 7.2 | `database.ts` | Seed data runs unconditionally every startup | 🟢 Minor |
| 8.1 | Global | `BusinessData` uses `any[]` for all domain types | 🔴 Critical |
| 8.2 | Global | `'default-workspace'` magic string, never a constant | 🟡 Moderate |
| 8.3 | Global | `temp_edit.js` committed to production source | 🟢 Minor |
| 8.4 | Global | `webrtc.ts` is a pure re-export shim | 🟢 Minor |
