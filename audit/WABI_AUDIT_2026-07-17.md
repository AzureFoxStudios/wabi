# Wabi Codebase Audit – 2026-07-17

Scope: wabi Rust workspace + frontend SvelteKit app. Checks: build health,
frontend type-check, security posture, API/WS wiring against wabiDB, WabiDB
storage format vs spec, dead-code/STDB eradication, auth/JWT state, upload
handling, CORS/headers, session handling.

---

## 1. Build state

- `cargo check --workspace` → exit 0, no errors.
- `bun run check` (frontend) → exit 0, 75 warnings (accessibility/cosmetic only, no type errors).
- `adapter/mod.rs` is 2 214 lines; `calling_impl_core.ts` is 2 097 lines;
  `MessageList.svelte` is 1 891 lines. Other than those three the tree is
  manageable.

Verdict: green. Compilation is not the risk today.

---

## 2. JWT / auth / secrets

- `validate_exp = true` is set in 8 sites across axum extractor, Socket.IO
  shared, standby, nodes, whiteboard, payments, and the `/login` response.
- JWT secret resolution chain is correct: env `JWT_SECRET` → persisted
  `<data_dir>/jwt_secret` → freshly generated UUID-pair. Hardcoded fallback
  only warns; it does not silently use a known secret.
- Password hashing uses `bcrypt::hash(..., bcrypt::DEFAULT_COST)`.
- Guest login exists and exposes guest 24h-expiry JWTs.
- JWT is stored in `localStorage` (persisted-remember-me) and `sessionStorage`.
  CORS is `mirror_request` + `allow_credentials(true)`, which means any site
  the user visits can make credentialed cross-origin requests unless the
  browser itself blocks it.
- Login endpoint has no per-account lockout or exponential backoff. Global
  rate-limit middleware is 10 rps / 20 burst by default; it protects the
  endpoint but does not slow repeated wrong-password attempts against a
  single account.

Verdict: JWT plumbing is healthy. CORS + localStorage is a real risk. No
login throttling is a real risk.

---

## 3. WabiDB

- Module structure matches lib.rs: 22 modules declared, present on disk.
- Storage format: `HEADER_LEN = 48` in `format/record.rs`; spec doc past
  §2.1 notes "Total header size: 48 bytes (not 36)." Implementation is the
  reconciled version.
- Sequencer invariants from council review are enforced in code with line
  citations:
  - Burned-seq monotonic counter: `sequencer/mod.rs:142` doc + test at 604.
  - Durability-await (fsync before Ok): `engine/mod.rs:146` doc + test at 826.
  - Option B orphan skip (no truncation): `engine/mod.rs:8` + `stream_log/recovery.rs:30`.
- The remaining `unsafe` blocks in `crypto/bootstrap.rs` are test-only
  `env::set_var`/`env::remove_var` calls that require `unsafe` under Rust
  2024. Not a UB concern.
- `unwrap()` calls inside `#[cfg(test)]` are normal. Non-test unwrap count
  in the four core files is zero.
- `list_reactions` in `adapter/mod.rs` is implemented but never called from
  any API route or Socket.IO handler.

Verdict: engine is in good shape. The adapter's `list_reactions` is wired but
unused.

---

## 4. Frontend ↔ backend event cross-reference

Pattern used: extract all `sock.emit(...)` and `socket.on(...)` from frontend
TS files, extract all `socket.on(...)` and `emit(...)` from backend Rust.

Frontend TS emits with no backend `socket.on`: 17 events.

| Event | Frontend file |
|---|---|
| create-thread | channelStore.ts:109 |
| pin-channel | channelStore.ts:124 |
| unpin-channel | channelStore.ts:? |
| retry-message | messageStore.ts:109 |
| mark-messages-as-read | messageStore.ts:88 |
| mark-channel-as-read | messageStore.ts:101 |
| sync-newer | messagePagination.ts:101 |
| create-breakout-rooms | channelStore.ts:82 |
| close-breakout-rooms | channelStore.ts:88 |
| move-user-to-breakout | channelStore.ts:94 |
| move-user-to-voice-channel | channelStore.ts:100 |
| add-reaction | messageReactions.ts:15 |
| remove-reaction | messageReactions.ts:21 |
| cursor | boardSocket.ts |
| patch | boardSocket.ts |
| snapshot | boardSocket.ts |
| leave | socketConnectionCore.ts |

Backend emits with no frontend `sock.on` listener:

- Most are error/state broadcasts (`ban-error`, `kick-error`, `voice-mute-error`,
  `rejoin-failed`, `channel-messages`, etc.). The frontend has listeners for
  the *success* events but not the *error* events, so failure UX is silent.
- `emoji-reaction-added` / `emoji-reaction-removed` are broadcast by
  `media_reactions_signaling.rs:140,203` but no frontend listener consumes
  them — reactions appear only to the sender.

Wire mismatch on reactions specifically:
- Frontend emits `add-reaction` / `remove-reaction`.
- Backend handles `add-emoji-reaction` / `remove-emoji-reaction`.
- Result: reaction emits arrive at the server as unknown events → silently
  dropped.

Verdict: reactions are dead end-to-end. The 17 no-handler emits are mostly
"feature not yet implemented" but need explicit confirmation; they silently
no-op today.

---

## 5. Upload / security headers

- Upload path traversal is defended: canonicalize + starts-with check.
- MIME types are served via `mime_guess`. SVGs are explicitly whitelisted
  (`image/svg+xml`). When served back to clients they carry no
  `Content-Security-Policy` and no `X-Content-Type-Options: nosniff`.
  An attacker who can upload content and knows the URL can serve an SVG with
  embedded `<script>` from your origin.
- DOMPurify sanitizes `parseMessage` output and `renderReaderHtml`. `{@html}`
  in `MessageContent.svelte` goes through `parseMessage` → DOMPurify. The
  three remaining naked `{@html}` sites are: static SVG in context menu,
  reader tab (through `renderReaderHtml`/DOMPurify), and the message parser.
  None are raw user input without a sanitize step.

Verdict: upload serving lacks security headers; SVG specifically is the XSS
vector. Everything else is fine.

---

## 6. Session / ephemeral state

- `session_messages: HashMap<channel_id, Vec<Value>>` lives in `AppState` and
  is unbounded per-channel (capped at 1000 entries on message send).
- Cache is populated on emit and read on channel join. On restart the cache
  is empty; the fallback loads up to 50 messages from WabiDB — without
  reactions, with only partial fields, and with no pagination cursor.
- There is no TTL or eviction for the per-channel session cache beyond the
  1000-entry hard cap.

Verdict: acceptable for hot-path caching; the fallback on reload is a
degraded read (no reactions, last-50 cap).

---

## 7. STDB / retired-system eradication

Active-surface survivors (excluding `archive/`, `*.bak*`, `docs/`):

| File | Lines of active STDB reference |
|---|---|
| `wabi-serve` | ~8 |
| `wabi-serve.sh` | ~8 |
| `scripts/launch.sh` | ~30 env plumbing |
| `package.json` | 1 script name |
| `frontend/src/lib/mediaRuntime.ts` | 1 migration map line |

`docker-compose.yml` and `Caddyfile.*` were already cleaned.

Verdict: almost eradicated. The `scripts/launch.sh` block is the biggest
piece. `mediaRuntime.ts` line is a migration hashmap entry.

---

## 8. TURN config

`ServerConfig` carries `turn_enabled`, `turn_uri`, `turn_secret`. No env
vars populate them — all three are hardcoded (`false`, `None`, `None`).
The `/api/media/turn-credentials` handler always returns "TURN server not
enabled". The three fields plus the endpoint + frontend TURN module are
dead code today.

Verdict: dead code, not a runtime risk. Worth either wiring up or removing.

---

## 9. WabiDB engine internals (new findings vs prior audit)

- Council-review invariants are encoded as both docs and test names
  (`monotonic`, `durability_await`, `orphan_records_tolerated`,
  `burned_seq_on_failure`). Coverage is present.
- Crash-injection test file `tests/crash_tests.rs` is 680 lines and exercises
  the real failure points.
- WabiStore trait is defined in `engine/wabi_store.rs:1090` — note: it is
  **not** dyn-compatible (async fn without Send/Box). `Arc<dyn WabiStore>`
  does not compile; the code uses `Arc<WdbAdapter>` directly. This is a
  deliberate limitation, not a bug, but any future trait-object refactor must
  add `#[async_trait]` or explicit `Pin<BoxFuture<...>>`.
- `adapter/mod.rs:476` contains a TODO: "add a message_id → (channel_id, seq)
  secondary index." Without it, `list_reactions` does a full prefix scan over
  all `reactions:*` keys — fine at test scale, linear at production scale.

---

## 10. Summary verdict table

| Area | Result |
|---|---|
| Rust workspace build | Clean, exit 0 |
| Frontend type-check | Clean, 75 cosmetic warnings |
| JWT validation | All 8 sites enabled |
| JWT secret handling | Correct chain (env → file → gen) |
| Password hashing | bcrypt, correct |
| Rate limiting | 10 rps global; no per-account throttle |
| CORS | mirror_request + allow_credentials (too wide) |
| Security headers | Missing entirely |
| Upload traversal | Defended |
| Upload XSS (SVG) | No CSP / nosniff |
| DOMPurify coverage | All user-rendered HTML |
| WabiDB module structure | 22 modules, matches lib.rs |
| WabiDB format impl | Matches spec (48-byte header) |
| Sequencer invariants | All three encoded + tested |
| Adapter `list_reactions` | Implemented but never called |
| Socket.IO: reactions | Frontend/backend event names disagree; no reaction listener |
| Socket.IO: 17 no-handler emits | Silent no-ops; most are feature-not-yet-wired |
| STDB eradication | Active-surface count non-zero (see §7) |
| TURN config | Dead code, no env wiring |
| `unsafe` in wabidb | Test-only env manipulation |
| Monolith risk | adapter/mod.rs 2214 L, calling_impl_core.ts 2097 L, MessageList 1891 L |
