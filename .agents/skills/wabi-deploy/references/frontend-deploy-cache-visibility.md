# Frontend Deploy Cache Visibility — Wabi Rust Binary

Use when a Wabi frontend/Rust-binary deploy appears to succeed but the live website looks unchanged, throws a runtime error, or bounces to login.

## Symptom

- Tim container is healthy and `/health` returns 200.
- Local rebuilt `frontend/build/index.html` asset filenames match Tim/public HTML.
- User/browser still shows old UI, a `n.subscribe is not a function` crash, or a login bounce loop.

## Verify live bytes, not just container health

Compare these three sources:

1. Local build:
   - `frontend/build/index.html`
   - `frontend/build/_app/immutable/...`
2. Tim local HTTP:
   - `curl -fsS http://127.0.0.1:3001/`
   - `curl -fsS -I http://127.0.0.1:3001/sw.js`
3. Public site:
   - `curl -fsS -I https://wabi.chat/`
   - fetch CSS/JS referenced by public HTML and grep for expected selectors/strings.

If local build, Tim local, and public HTML reference the same hashed assets, the deploy reached the server. The problem is likely browser/service-worker/CDN cache or the expected visual change is subtler/different than assumed.

## Cache-header pitfall found in session

The Rust static fallback originally returned only `Content-Type`. Cloudflare then served `/sw.js` with `cache-control: max-age=14400`, so existing browsers could keep an old service worker/shell and make a successful deploy look unchanged.

Fix static serving in `core/crates/wabi-server/src/main.rs` so:

- `index.html`, `sw.js`, `manifest.json`, `manifest.webmanifest`, `service-worker.js` => `Cache-Control: no-cache` (forces revalidation every load)
- `_app/immutable/*` hashed assets => `Cache-Control: public, max-age=31536000, immutable`
- other static assets => short cache such as `public, max-age=3600`

After deploying that fix, verify public headers:

```bash
curl -fsS -I https://wabi.chat/
curl -fsS -I 'https://wabi.chat/sw.js?deploy_check=8'
curl -fsS -I https://wabi.chat/_app/immutable/assets/<known-css>.css
```

Expected:

- `/` shows `no-cache`.
- Hashed immutable assets may still be cached aggressively by Cloudflare (`max-age=14400`); that is correct if filenames are content-hashed and change when contents change.
- Cloudflare beacon CSP error (`static.cloudflareinsights.com` blocked by `script-src 'self'`) is a **red herring** — harmless analytics, never the crash.

## Stale chunk graph: `n.subscribe is not a function` after rapid redeploys

**Symptom (verified 2026-07-19):** After two back-to-back binary deploys (one broken, one fixed), the user's browser loads `/`, shows the main page briefly, then throws `Uncaught TypeError: n.subscribe is not a function` at an immutable chunk (`DUjf2F7D.js`) and/or bounces to login. It is NOT a code bug in the new build.

**Why it happens:** `index.html` references a set of hashed `_app/...` chunks. If the browser cached `index.html` from deploy #1 (which points at chunk hashes that deploy #2 replaced), it fetches a mismatched chunk graph → a module evaluates to `undefined` → a store auto-subscription (`$store`) calls `.subscribe` on `undefined`. The Cloudflare beacon CSP error is a **red herring**.

**Definitive diagnosis without trusting the user's browser:** reproduce headlessly with a real Chromium against the LIVE site. Playwright is already a `frontend` dep (`playwright-core`); install the browser once:

```bash
cd /var/home/Ronin/wabi/frontend && npx playwright install chromium
cat > /tmp/repro.mjs <<'MJS'
import pkg from '/var/home/Ronin/wabi/frontend/node_modules/playwright-core/index.js';
const { chromium } = pkg;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  let cap = false;
  p.on('pageerror', (e) => { console.log('PAGEERROR:\n'+(e.stack||e.message)+'\n===='); cap = true; });
  p.on('console', (m) => { if (m.type()==='error' && !/cloudflareinsights|beacon/.test(m.text())) console.log('CERR: '+m.text()); });
  try { await p.goto('https://wabi.chat/', { waitUntil:'commit', timeout:25000 }); } catch(e){ console.log('GOTO: '+e.message); }
  for (let i=0;i<16 && !cap;i++) await new Promise(r=>setTimeout(r,500));
  await b.close(); console.log('captured='+cap);
})();
MJS
node /tmp/repro.mjs
```

If the headless run shows `captured=false` (0 pageerrors) but the user's browser throws, it is **stale cache**, not a build defect. Confirm headers: `curl -I https://wabi.chat/` must show `cache-control: no-cache`. With `no-cache` on `index.html`, a hard refresh forces the browser to re-fetch the entry HTML and pick up the current chunk set.

**Fix (shipped 2026-07-19, commit `4473c8b`):** `serve_static` in `main.rs` sends `Cache-Control: no-cache` for `index.html`/`service-worker.js` and `public, max-age=31536000, immutable` for everything else.

**User-side unblock:** one hard refresh (Cmd/Ctrl+Shift+R) clears the stale graph. If the same browser then still loops, it is the **stale-token bounce** (below), which a hard refresh does NOT fix — needs site-data clear.

## Stale auth token bounce loop (client localStorage, not a server bug)

**Symptom:** App shows the main page for a moment, then bounces back to `/login` with a `session_expired`/auth error; `/api/user/settings` returns `401`. The beacon CSP error is again a red herring.

**Why:** The browser holds an old auth token in `localStorage` (from a prior server session / the broken-deploy window). Boot sees the token → renders app → socket connects with the stale token → server rejects → frontend sets `session_expired` → `clearAuthSession()` + `clearStoredIdentity()` → back to login. Loop until the bad token is gone.

**Server is fine — prove it:** guest login needs no password and confirms the auth path:
```bash
curl -s -X POST https://wabi.chat/api/auth/guest -H 'Content-Type: application/json' \
  -d '{"username":"probe_guest"}' -w '\nHTTP:%{http_code}\n'
# Expect: {"token":"eyJ...","user":{...}} HTTP:200
```
If that returns 200, the server auth works; the bounce is purely client stale state.

**Unblock:** clear site data for wabi.chat (DevTools → Application → Storage → Clear site data; or `localStorage.clear()` in console). A hard refresh alone does NOT clear localStorage. After clearing, log in fresh.

**Resilience fix (optional):** make the `session_expired` handler also strip the bad token keys from `localStorage` before bouncing, so it self-heals instead of looping (encodes in `+page.svelte` authStore subscriber).

## Reporting discipline

When the user reports no visible update / a crash / a login bounce, do not simply insist it deployed. Re-check and report evidence:

- local vs remote binary SHA256
- Tim local root asset refs
- public root asset refs
- public CSS/JS contains expected selectors/strings
- cache headers for `/`, `/sw.js`, and a representative `_app/immutable` asset
- headless Chromium pageerror capture (vs user's stale browser)

If the bytes + headers match and the headless run is clean but the user still sees breakage, state that explicitly: it is client stale state, and recommend the precise unblock (hard refresh for stale chunks; site-data clear for stale tokens).
