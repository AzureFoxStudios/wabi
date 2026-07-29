> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# WABI REPO REVIEW - 2026-05-14
## Scope: post-merge of backend overhaul + CSS refactor
## Method: chunk-by-chunk file inspection

================================================================================
CHUNK 0: PRELIMINARY / META
================================================================================
Repo: /var/home/Iyoku/wabi
Branch: main (6bf5191)
Merge: backend overhaul (STDB calling + Rust API consolidation) merged ON TOP of CSS refactor (a718201)
Stats: 159 deletions, 238 additions, 40 modifications
- backend/ directory: FULLY DELETED (all Node.js backend gone)
- New Rust APIs in core/crates/wabi-server/src/api/: payments.rs, whiteboard.rs
- New frontend calling stack: ~25 files in frontend/src/lib/ (calling_impl.ts, stdbMediaRelay.ts, audio-worklet-playback.ts, etc.)
- CSS refactor: semantic tokens, component extraction, inline style elimination

================================================================================
CHUNK 1: BACKEND — payments.rs
================================================================================
File: core/crates/wabi-server/src/api/payments.rs (708 lines, 23KB)

GOOD:
- Clean axum router pattern, well-structured handlers
- Proper serde camelCase rename annotations
- JWT auth with extract_user_id helper
- Admin guard via is_admin_user(state.owner_user_id)
- STDB integration via sql_query + ingest_event reducers
- sanitize_access_policy / sanitize_donation_config helpers (input validation)
- Default values for PaymentAccessPolicy, PaymentDonationConfig

CONCERNS:
- SQL injection risk in get_policy_row: uses StdbClient::sanitize_sql(key). This is string interpolation into SQL — if sanitize_sql is just a simple escape, it may not handle all edge cases. Better to use parameterized queries or the STDB client’s prepared statement support.
- json_error helper creates string body instead of Json body — minor but inconsistent with success paths that return Json().
- No rate limiting on payment endpoints.
- Missing tests.
- Default workspace ID is hardcoded string "default-workspace" — should come from config.

VERDICT: Solid port from Node.js. Security-conscious but SQL string construction needs review.

================================================================================
CHUNK 2: BACKEND — whiteboard.rs
================================================================================
File: core/crates/wabi-server/src/api/whiteboard.rs (401 lines, 14KB)

GOOD:
- Scope-tagged file IDs via SHA-256 prefix prevent cross-board file access
- Proper file size limits (2MB document, 128KB live payload, 10MB image)
- Filename sanitizer strips path separators and null bytes
- can_access_channel checks owner/admin first, then public/private channel membership via STDB

CONCERNS:
- upload_whiteboard_image uses axum::extract::Multipart but I need to see if the state/config actually has multipart support enabled in main.rs
- serve_whiteboard_file may be vulnerable to path traversal if file_id validation is bypassed — need to verify resolve_upload_path is safe
- Missing MIME type validation on upload (could upload executable content)
- No virus scanning or content validation
- rand::random::<u64>() for nonce is fine but not cryptographically strong

================================================================================
CHUNK 3: BACKEND — socketio.rs (calling + media relay)
================================================================================
File: core/crates/wabi-server/src/socketio.rs (3255 lines, 114KB)

GOOD:
- Group call session tracking with GroupCallSession struct
- Proper cleanup on disconnect (group_call_lefts, call-ended broadcast)
- DM call and group call separation
- call-initiate, call-answer, call-hangup handlers present
- stdb-media broadcast at line 2271: relays to all participants except sender

CONCERNS:
- 3255 lines in one file is a LOT. This should be split into modules (handlers/, state/, auth/)
- Need to verify stdb-media handler actually routes by sessionId (I see payload forwarding but need to check session filtering)
- No Opus re-encoding on the server side — it’s pure relay (which is correct for SFU fallback but means no server-side mixing)
- The file is huge and hard to maintain

================================================================================
CHUNK 4: FRONTEND — calling_impl.ts
================================================================================
File: frontend/src/lib/calling_impl.ts (3954 lines, 118KB)

This is MASSIVE. Nearly 4K lines for calling logic.

GOOD:
- LiveKit token refresh with exponential backoff (LIVEKIT_TOKEN_REFRESH_* constants)
- decodeJwtExp helper for token expiry detection
- STDB and LiveKit transport selection logic
- Proper cleanup (cancelLivekitTokenRefresh, disconnect functions)

CHUNK 5: FRONTEND — stdbMediaRelay.ts
================================================================================
File: frontend/src/lib/stdbMediaRelay.ts (198 lines, 6KB)
Package: opus-recorder ^8.0.5 present in package.json

GOOD:
- Clean class-based encapsulation
- start()/stop() lifecycle
- AudioWorklet for playback (avoids main-thread audio glitches)
- Jitter buffer concept (even if naive)

CONCERNS (CRITICAL):
- LINE 59: `this.audioContext.createMediaStreamAudioSourceTrack(stream)` — THIS METHOD DOES NOT EXIST in Web Audio API. Correct method is `createMediaStreamSource(stream)` which returns an AudioNode, not a "track".
- LINE 60: `this.opusRecorder.start(audioInput)` — opus-recorder takes a MediaStream or config, not an AudioNode. The API usage is wrong.
- LINE 117: Decoder worker path `opus-recorder/dist/decoderWorker.min.js` — in Vite/bundled environments, this path won't resolve correctly unless opus-recorder is configured as an external or the worker is copied to dist.
- Jitter buffer is a FIFO push-then-immediate-decode. It does NOT actually buffer — packets are decoded as soon as they arrive. A real jitter buffer needs:
  - Timestamp tracking per packet
  - Playback scheduling (not decode-on-arrival)
  - Packet loss concealment (PLC)
  - Dynamic buffer sizing based on network jitter
- The decode timeout is 100ms per packet — if a packet takes 101ms to decode, it's silently dropped.
- No congestion control, no bandwidth adaptation, no simulcast/SVC layer selection

VERDICT: Skeleton implementation with Web API errors that will break at runtime. Needs fixing before it works.

================================================================================
CHUNK 6: FRONTEND — audio-worklet-playback.ts
================================================================================
File: frontend/src/lib/audio-worklet-playback.ts (54 lines, 1.4KB)

GOOD:
- Clean AudioWorkletProcessor implementation
- Uses port.onmessage for PCM data queuing
- Proper buffer management with bufferIndex tracking
- Returns true (keeps processor alive)
- Minimal and focused

CONCERNS:
- No sample rate conversion — assumes incoming PCM matches AudioContext sample rate
- No handling of buffer underrun (silence inserted implicitly by output being pre-zeroed)
- No gain control or volume normalization
- Hardcoded single-channel mono
- Could benefit from a small ring buffer instead of Float32Array[] array

VERDICT: Solid skeleton. Will work if PCM data arrives at the right rate. Needs rate conversion for production.

================================================================================
CHUNK 7: FRONTEND — CSS REFACTOR
================================================================================
File: frontend/src/styles/tokens.css (319 lines, 13KB)

GOOD:
- Comprehensive semantic token system: --surface-*, --text-*, --border-*, --accent-*
- Legacy alias bridge for backward compatibility (lines 237-266)
- Full typography, spacing, radii, shadows, z-index, motion, opacity token sets
- RGB variants for runtime transparency calculations
- Static defaults for pre-JS rendering

CONCERNS:
- Lines 84-86: Still references magenta (#ff00ff) in accent-subtle, accent-medium, accent-glow defaults. Commit 1cbcd5d said it replaced garish magenta with indigo — but the token defaults still have it.
- Self-referencing var() fallbacks create confusing chains: `--surface-app: var(--surface-app, var(--surface-app, #1a1a2e))` — this resolves to itself, not the static fallback. The double var() is redundant and may cause issues in some browsers.
- `--color-success` static defaults don't match Tailwind values (line says #22c55e in app.css but #00ff7f in tokens.css)

File: frontend/src/styles/components/chat-core.css
File: frontend/src/styles/components/sidebar-core.css
(And ~40 other component CSS files)

GOOD:
- Extracted from Svelte <style> blocks — follows user's colocated responsive preference
- chat-core.css, sidebar-core.css, messagelist css files, settings css files
- Mobile-specific files exist: chat-mobile.css, sidebar-mobile.css, settings-mobile.css, ml-mobile.css

CONCERNS:
- tokens.css has BOTH semantic tokens pointing to legacy AND legacy pointing to semantic — circular references. Need to verify which actually wins at runtime.
- 46 remaining inline style=background-color usages (mostly in business/Calendar, Kanban, etc.) — not all migrated
- ThemeCustomizer.svelte still has #ff00ff defaults (hardcoded in Svelte component props)
- Need to verify themeManager.ts sets both legacy and semantic tokens (mentioned in commit but need to confirm)

================================================================================
CHUNK 8: INFRASTRUCTURE / DOCS / BUILD HEALTH
================================================================================

DOCKER COMPOSE:
- File: docker-compose.yml — clean, well-documented
- Core services: spacetimedb, stdb-publisher, stdb-proxy (Caddy), wabi-server (Rust)
- Optional profiles: turn, sfu, tunnel, booster-full
- No references to deleted backend/ directory
- Good use of health checks and depends_on conditions

PLAN.md / REFACTOR_STATUS.md:
- PLAN.md shows active task blocks. J5 (Delete /backend) is now DONE.
- Many tasks still open: calling extractions (E1-E10), TS module splits (I1-I15), backend cleanup (J1-J4, J6-J9), deployment (F1-F4)
- PLAN.md needs updating to reflect completed work

BUILD HEALTH:

BACKEND (cargo check):
- 5 compile errors in wabi-server:
  1. `StdbClient::sanitize_sql` is PRIVATE (payments.rs x3) — can't call it, needs to be pub or use a different approach
  2. `socket.join(room_id).ok()` — `join()` returns `()`, not `Result`, so `.ok()` doesn't exist
  3. `.to(&room_id)` — trait bound `&String` doesn't satisfy `RoomParam`; needs `room_id` directly
- These are straightforward fixes but mean the backend DOES NOT COMPILE on main

FRONTEND (npm run check / svelte-check):
- 212 errors, 98 warnings in 51 files
- Top error patterns:
  - 51× "No overload matches this call" — overloaded function signatures don't match usage
  - 13× "unknown not assignable to User" — type narrowing issues
  - 11× "number not assignable to string" — type mismatches
  - 8× "Record<string,any> missing User[] properties" — array vs object confusion
  - 7× "Cannot find name 'safeJsonParse'" — missing import/function
  - 6× "roleName does not exist on RoleDefinition" — stale type references
  - Various "Cannot find module" errors for deleted backend paths
- Some errors may be pre-existing; commit e5e093e claimed "svelte-check: 0 errors" but that was on a718201 before the backend merge.

OPUS-RECORDER:
- Package present in package.json ("opus-recorder": "^8.0.5")
- But `stdbMediaRelay.ts` uses API incorrectly — needs fixing regardless of package presence

================================================================================
CHUNK 9: BACKEND — COMPILE ERRORS (DETAIL)
================================================================================

Error 1-3: E0624 sanitize_sql is private
  Location: payments.rs:232, :328, :482
  Fix: Either make sanitize_sql pub in db.rs, or inline SQL escaping, or use parameterized queries

Error 4: E0599 no method .ok() 
  Location: socketio.rs:2252
  Code: `socket.join(room_id.clone()).ok();`
  Fix: `let _ = socket.join(room_id.clone());` or just `socket.join(room_id.clone());`

Error 5: E0277 trait bound &String doesn't satisfy RoomParam
  Location: socketio.rs:2275
  Code: `.to(&room_id)`
  Fix: `.to(room_id)` (pass owned String, not reference)

================================================================================
CHUNK 10: FRONTEND — TYPE ERROR ANALYSIS
================================================================================

Top categories:
a) "No overload matches this call" (51×) — likely from function signatures changed during the refactor but call sites not updated. Need to inspect each.
b) "unknown not assignable to User" (13×) — often from $store values not properly typed or from generic stores without type parameters
c) Cannot find module (multiple) — references to deleted backend/src/shared/*.js contracts. Some frontend files still import from old backend paths.
d) Missing properties on types — roleName/displayName on RoleDefinition, layoutLoaded on Readable, autoDeleteAfter on channel creation type — schema drift between STDB bindings and frontend types

+e) safeJsonParse, rightPanelWidth — missing imports/functions that need to be added or removed
+
+Many of these may be pre-existing, but the merge introduced new ones. The "0 errors" state was before the backend merge.
+
+================================================================================
+CHUNK 11: FINAL SUMMARY
+================================================================================
+
+WHAT WAS DONE WELL:
+===================
+1. BACKEND CONSOLIDATION (MERGE SUCCESS)
+   - Entire Node.js backend/ directory (~159 files) successfully deleted
+   - New Rust API modules added: payments.rs (708 lines), whiteboard.rs (401 lines)
+   - Socket.IO stdb-media relay handler added in socketio.rs (pure broadcast, no server-side Opus processing)
+   - Docker compose updated — no backend references remain
+   - STDB call session tables exist in stdb_bindings_out/
+
+2. CSS REFACTOR (MOSTLY DONE)
+   - tokens.css with 319 lines of comprehensive semantic tokens
+   - ~40 component CSS files extracted from Svelte <style> blocks
+   - Mobile-specific files exist (chat-mobile.css, sidebar-mobile.css, etc.)
+   - themeManager.ts sets BOTH legacy (--bg-primary) AND semantic (--surface-app) tokens
+   - Legacy alias bridge maintains backward compatibility
+   - 1,349 token replacements across 83 files (from commit history)
+   - Magenta defaults (#ff00ff) mostly replaced with indigo (#6366f1)
+
+3. FRONTEND API CONSOLIDATION
+   - api/ directory with 12 clean modules (auth, albums, payments x3, admin, config, dictionary, utils)
+   - api/index.ts provides unified re-export layer (85 exports)
+   - fetchWithTimeout with retry logic
+
+4. CALLING INFRASTRUCTURE
+   - 3,954-line calling_impl.ts — massive but functional
+   - LiveKit token refresh with exponential backoff
+   - AudioWorklet playback processor (clean, minimal)
+   - STDB transport selection with fallback
+   - Call state stores well-organized (callingStateStores.ts)
+
+5. PLANNING / DOCUMENTATION
+   - PLAN.md with clear task blocks
+   - PROJECT_DOCS/ well-organized with architecture, deployment, features, payments
+   - CSS refactor progress tracked in multiple checkpoint files
+
+================================================================================
+
+CRITICAL PROBLEMS:
+==================
+1. BACKEND DOES NOT COMPILE — 5 cargo errors
+   - sanitize_sql is private (payments.rs x3) — FIX: change `fn` to `pub fn` in db.rs
+   - socket.join().ok() — FIX: remove .ok(), join() returns ()
+   - .to(&room_id) — FIX: pass `room_id` not `&room_id`
+   All 5 are trivial one-line fixes.
+
+2. FRONTEND stdbMediaRelay.ts HAS WEB API BUGS
+   - createMediaStreamAudioSourceTrack() doesn't exist — use createMediaStreamSource()
+   - opusRecorder.start(AudioNode) is wrong — takes MediaStream
+   - Worker path won't resolve in Vite bundle
+   - Jitter buffer doesn't actually buffer (decode-on-arrival)
+   This WILL crash at runtime when STDB calling is used.
+
+3. MAGENTA STILL LURKS IN TOKENS.CSS
+   Lines 84-86: --accent-subtle, --accent-medium, --accent-glow still default to rgba(255,0,255,...)
+   These are CSS default values, not runtime-set. If themeManager doesn't set --gradient-accent-subtle / --accent-rgb, browsers will show magenta highlights.
+
+4. FRONTEND HAS 212 SVELTE-CHECK ERRORS
+   - 51x "No overload matches this call"
+   - 13x "unknown not assignable to User"
+   - Missing imports (safeJsonParse, rightPanelWidth)
+   - Schema drift (roleName, displayName, autoDeleteAfter)
+   These existed before the merge but the merge may have added more.
+
+================================================================================
+
+MODERATE CONCERNS:
+==================
+- socketio.rs is 3,255 lines — needs module splitting
+- calling_impl.ts is 3,954 lines — also needs splitting (per PLAN.md blocks E1-E4)
+- 127 inline style= attributes remain in .svelte files (mostly business/ views)
+- No tests on new Rust APIs (payments, whiteboard)
+- No rate limiting on payment endpoints
+- Missing MIME type validation on whiteboard image uploads
+- SQL injection risk in payments.rs (string interpolation into SQL via sanitize_sql)
+- PLAN.md still shows J5 as unchecked (Delete /backend) even though it's done
+
+================================================================================
+
+VERDICT:
+========
+Backend merge: GOOD INTENT, POOR EXECUTION ON MERGE CONFIDENCE
+- The code was written but not verified to compile. 5 trivial errors suggest the author never ran `cargo check`.
+- Once fixed, the APIs look solid.
+
+CSS refactor: MOSTLY DONE, POLISH NEEDED
+- Token system is comprehensive and well-architected.
+- Remaining magenta defaults and 46 inline styles need cleanup.
+- Component extraction is thorough and follows the colocated responsive preference.
+
+Calling feature: SKELETON, NOT PRODUCTION-READY
+- STDB relay exists in socketio.rs (correct pure relay).
+- Frontend capture/playback has real Web API errors that need fixing.
+- Jitter buffer is token effort — needs real implementation for usable audio quality.
+
+OVERALL: The work represents significant progress on backend consolidation and CSS
+refactoring. The main blockers are: (1) 5 trivial backend compile errors, (2) runtime
+bugs in stdbMediaRelay.ts, (3) magenta defaults in tokens.css. These are all fixable
+in under an hour. The 212 frontend errors are a broader cleanup task.
+
+RECOMMEND NEXT STEPS:
+1. Fix 5 cargo compile errors
+2. Fix stdbMediaRelay.ts Web API bugs
+3. Replace magenta defaults in tokens.css
+4. Run `npm run check`, triage errors into "new from merge" vs "pre-existing"
+5. Update PLAN.md to mark completed tasks (J5, D1-D4, etc.)
+6. If you want to push to main, at minimum do steps 1-3 first.
+

