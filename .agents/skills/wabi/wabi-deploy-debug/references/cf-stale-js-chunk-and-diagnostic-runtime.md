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
