# CF Beacon Error — Decision Record (2026-08-04, updated 2026-08-10)

## Symptom
Client-side console error on wabi.chat around the Cloudflare Web Analytics beacon
(`static.cloudflareinsights.com/beacon.min.js`): CORS/SRI-hash complaint. The SRI
"computed" digest reported by the browser was:
`z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==`

## Finding (2026-08-10 re-investigation)
1. **No SRI hash is hardcoded in this repo.** `rg` for the digest, `beacon.min.js`,
   `integrity=`, or `cloudflareinsights` finds zero hits in `frontend/src`,
   `frontend/build`, and `core/` (only unrelated WabiDB CRC/GCM "integrity" comments
   and a lockfile entry). The `integrity` attribute is injected by Cloudflare's edge,
   not by our code.
2. **CSP is NOT blocking the beacon.** Both Caddyfiles already allow the host:
   - `Caddyfile.tunnel` line 24: `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com ...`
   - `Caddyfile.example` line 44: same host in script-src.
   Live verification `curl -sSL -D - https://wabi.chat` (2026-08-10) shows the exact
   `Caddyfile.tunnel` CSP on the wire. `connect-src 'self' wss: stun: turn: https:`
   also covers the beacon's data endpoint (`https://cloudflareinsights.com`).
3. **The digest proves an empty response body, not a code bug.** Base64-decode the
   reported hash and it equals `SHA-512("")` — `printf '' | openssl dgst -sha512
   -binary | base64` reproduces the string byte-for-byte. The browser computed the
   digest of a **0-byte body**, i.e. an ad-blocker / privacy extension / edge returned
   an empty response for `beacon.min.js`. The edge-injected `integrity` attribute
   expects the real (non-empty) script hash, so SRI fails and the browser logs the
   SRI + accompanying CORS complaint for the blocked cross-origin load.
4. **Current live HTML has no injected beacon** — the served `index.html` (19 KB)
   contains no `beacon.min.js` tag, so dashboard automatic injection is off or
   conditional. A console error that persists is a stale cached HTML page (one that
   still carries the injected tag) or a locally injected/blocked script.

The beacon script is **edge-injected by Cloudflare**, not app code. The app itself
needs no fix and no runtime change.

## Decision
**Keep Cloudflare Web Analytics enabled. No app-code change.**

This is a Cloudflare **dashboard setting**, not a code problem. Resolution path:
- Cloudflare dashboard → zone **wabi.chat** → **Analytics → Web Analytics**.
  Either **disable Web Analytics** (silences the noise completely), or leave it
  enabled and treat the SRI/CORS console error as cosmetic (it has no functional
  impact on the app).
- Optionally purge cached HTML at the edge after disabling so no stale page still
  carries the injected beacon tag.
