# Service Worker stale shell cache

## Symptom

Deploy SHA matches local, `/health` 200, served CSS hash looks unchanged, and
the user says "it doesn't update at all" even after hard refresh.

## Cause

`frontend/src/routes/+layout.svelte` registers `/sw.js?v=${__WABI_SW_VERSION__}`.
The SW precaches `/index.html` and shell assets on install. Browsers keep the
old registration alive across deploys, so a new `wabi-server` binary can emit
new assets while the local SW still serves its cached shell.

## Triage

1. Prove the new build is actually on disk and embedded:
   - Tim SHA vs local SHA
   - `strings` the binary for your new feature/CSS marker
2. Confirm whether public `curl` still serves the OLD CSS hash:
   - `curl -s https://wabi.chat/ | grep -oE "0\.[A-Za-z0-9_-]+\.css"`
   - compare to `grep -oE "0\.[A-Za-z0-9_-]+\.css" frontend/build/index.html`
3. If they match locally but the user sees old UI in browser: SW is the likely
   culprit.

## Fixes

### Immediate: user-side unregister

DevTools → Application/Storage → Service Workers → Unregister any `wabi.chat`
registration, then hard refresh.

### Recurring: version-bust the SW URL

Bump `frontend/vite.config.ts`:

```ts
'__WABI_SW_VERSION__': JSON.stringify('10'),
```

Rebuild frontend + binary, redeploy. The new `/sw.js?v=10` registration URL
forces a fresh install + shell precache.

## Related

- `cf-stale-js-chunk-and-diagnostic-runtime.md` covers Cloudflare edge caching
  of chunk files; this note covers local PWA shell caching.
