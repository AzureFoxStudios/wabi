# Selfhostability check (wabi.chat hardwire audit)

When the user asks "is this still selfhostable / are we hardwiring wabi.chat", VERIFY — do not assert.

## Grep the repo
```
search_files(pattern="wabi\.chat", path="<repo>", target="content")
```
Read every hit. Classify each:

### FINE (NOT a hardwire)
- Tauri desktop-app prod default server URL (a packaged app needs a default server). In `serverUrl.ts` the `prod_tauri` branch returns `https://wabi.chat`. This is expected.
- UI placeholder text / example strings in inputs (`placeholder="wabi.chat or https://staging.wabi.chat"`).
- Test fixtures (`crates/.../tests/message_types.rs` preview URLs).
- Bot User-Agent strings (`+https://wabi.chat` in `preview.rs` / `auth.rs`).
- A share-link copy default (`buildShareLink(record, baseUrl = 'https://wabi.chat')`) — fixable, see below.

### HARDWIRE (must fix)
- A hardcoded domain used as the **connectivity** base in WEB mode (serverUrl resolves to a fixed host instead of `window.location.origin`).
- CORS `connect-src` pinning a host instead of `'self' wss:`.

## The key file: serverUrl.ts
Read `frontend/src/lib/serverUrl.ts`. The `resolveServerUrlInternal()` function decides the server URL:
- Tauri runtime → `https://wabi.chat` (fine, see above).
- Vite dev (`:5173`) → `${protocol}//${hostname}:3001` (fine).
- Docker `:3000` → `${protocol}//${hostname}:3001` (fine).
- **Production web (fallthrough, case 5)** → `return { url: origin, source: 'same_origin' }` where `origin = window.location.origin`. **This is the selfhostable path** — no hardwire.

So a self-hosted instance served from any origin connects same-origin. Confirmed via reading the file, not just grep.

## Share-link default fix (the one real leftover)
`frontend/src/lib/shareToChannel.ts`:
```ts
export function buildShareLink(record, baseUrl = 'https://wabi.chat'): string { ... }
```
Both callers (`ShareToChannelModal.svelte`, `ObjectShareMenu.svelte`) call it WITHOUT `baseUrl`, so a self-hosted copy would emit share links pointing at wabi.chat. Fix: import `getServerUrl` from `./serverUrl` and default to `getServerUrl() || 'https://wabi.chat'`. (`bun run check` stays 0 errors.) This makes the copied share URL use the live server origin.

## Report format
"Selfhostable: YES. Prod web resolves serverUrl from window.location.origin (serverUrl.ts:210). CORS connect-src is 'self' wss: (relative WS). The only wabi.chat references are: Tauri desktop default (legit), share-link copy default (fixed to getServerUrl()), UI placeholder text, test fixtures, bot UA strings. No connectivity hardwire."
