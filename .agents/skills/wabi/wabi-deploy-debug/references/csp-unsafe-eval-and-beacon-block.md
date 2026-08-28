# CSP `unsafe-eval` + Cloudflare beacon block

## Symptom
- Console: `e.subscribe is not a function` (Svelte store runtime crash)
- `Cross-Origin Request Blocked` for `https://static.cloudflareinsights.com/beacon.min.js`
- CSP violation: `script-src` missing `'unsafe-eval'`
- Page stuck on "Starting Wabi" boot shell (never hides)
- Forum/wiki channels fail to load (socket breaks before channel data arrives)

## Root Cause
The Caddy TLS header in `Caddyfile.tunnel` sets a `Content-Security-Policy` with `script-src` that includes the Cloudflare beacon domain but **omits `'unsafe-eval'`**. SvelteKit's client bundle uses eval-based code (source maps / runtime), and the browser blocks it silently — the boot IIFE dies before `dismissDocumentBootShell()` can hide the loading screen.

This presents identically to the terser-minify boot crash (see `spa-boot-crash.md`), but the fix is different: it's a **CSP header** issue, not a build/minifier issue.

## Diagnosis
```bash
# Check the live CSP header
curl -sI https://wabi.chat/ | grep -i content-security-policy
# Look for: script-src 'self' 'unsafe-inline' ... (MISSING 'unsafe-eval')

# Check for the beacon block in browser console
# Cross-Origin Request Blocked: ... static.cloudflareinsights.com/beacon.min.js
# CSP violation: ... (Missing 'unsafe-eval')
```

## Fix
In `Caddyfile.tunnel`, add `'unsafe-eval'` to the `script-src` directive:

```diff
- Content-Security-Policy "...; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com ...; ..."
+ Content-Security-Policy "...; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com ...; ..."
```

Then restart the Caddy container on Tim:
```bash
docker restart wabi-tunnel-caddy
```

## Note on the Cloudflare beacon
The `static.cloudflareinsights.com/beacon.min.js` Cross-Origin block is **cosmetic** — the beacon is injected by Cloudflare's edge (not Caddy or the app HTML). It does not break the app once `'unsafe-eval'` is added to `script-src`. The integrity-hash mismatch on the beacon is a Cloudflare-side issue and does not affect core functionality.

## Verification
- CSP header in curl response includes `'unsafe-eval'`
- Browser console no longer shows CSP violation for `script-src`
- `e.subscribe is not a function` error gone
- Forum/wiki channels load normally
- Boot shell hides on page load