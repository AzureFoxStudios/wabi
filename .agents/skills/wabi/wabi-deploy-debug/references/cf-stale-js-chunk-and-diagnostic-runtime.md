# Cloudflare stale JS chunk + diagnostic runtime patch

## CF edge cache serves old `_app/immutable/chunks/*.js` after binary swap

After `scp` + container swap, the new binary embeds a new frontend build, but
Cloudflare edge can still serve the **previous chunk** from its cache, even with
a hard refresh (`Ctrl+Shift+R`).

Verify hash mismatch:

```bash
LOCAL=$(sha256sum frontend/build/_app/immutable/chunks/Z9Z8gdf2.js | awk '{print $1}')
LIVE=$(curl -sS --max-time 15 -H "Cache-Control: no-cache" https://wabi.chat/_app/immutable/chunks/Z9Z8gdf2.js | sha256sum | awk '{print $1}')
[ "$LOCAL" = "$LIVE" ] && echo "OK" || echo "STALE"
```

If stale:
1. Purge CF cache from the wabi.chat dashboard (Caching → Purge Cache).
2. Hard refresh.
3. Re-check hash.

## Mid-call lazy-chunk 404 after swap (old client, new binary)

Distinct from edge staleness above: the page loaded FINE (fresh `index.html`),
but it loaded BEFORE the swap. The new binary embeds new hashed chunks and the
old hashes no longer exist on the server. The next lazy `await import()` in the
old page 404s:

```
Uncaught (in promise) TypeError: error loading dynamically imported module:
https://wabi.chat/_app/immutable/chunks/CWDXsqFO.js
```

In calling this is fatal, not cosmetic: the fallback/heal paths
(`reEstablishChannelP2P`, mesh close, relay re-create) all run through dynamic
imports, so the 404 throws mid-chain and the transport is lost — on a client
whose chunk prefix (e.g. `bnW4HGz3.js`) differs from live (`BJ25VJPY.js`).

Rule: after EVERY ship, hard-refresh ALL test devices BEFORE testing calls,
and confirm the chunk prefix in console sources matches live
(`curl -s https://wabi.chat/ | grep -oE 'entry/start\.[A-Za-z0-9_-]+\.js'`).
A call log on a stale chunk cannot judge the new code. Single-shot capability:
there is no N-1 asset retention — the old hashes die with the swap.

## Diagnostic runtime patch for `e.subscribe is not a function`

When static audits don't surface the truthy non-store, patch the built runtime
chunk to log it at the failure point. The patch target is always in
`Z9Z8gdf2.js` (Svelte runtime) at the `It(e,t,n)` subscribe helper.

CRITICAL ORDER:
- Source code patches → `bun run build` → patch built `Z9Z8gdf2.js` → `cargo build --release` → scp → swap.
- **Every** `bun run build` regenerates the chunk hash and **wipes** the patch.
  Re-patch after build, before cargo.

Patch text:

```js
function It(e,t,n){if(e==null)return t(void 0),n&&n(void 0),ee;
if(typeof e!=="object"||typeof e.subscribe!=="function"){
  try{console.error("[SUBSCRIBE_FAIL] non-store value:",e,
    "| stack:",new Error().stack.slice(0,600))}catch(_){}
  return t(void 0),ee}
const r=ht(()=>e.subscribe(t,n));...
```

After deploy, the console will print `[SUBSCRIBE_FAIL] non-store value: <object>`
naming the exact culprit.
