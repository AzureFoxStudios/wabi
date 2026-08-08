# CF Beacon Error — Decision Record (2026-08-04)

## Symptom
Client-side console error on wabi.chat around the Cloudflare Web Analytics beacon
(`static.cloudflareinsights.com/beacon.min.js`): CORS/SRI-hash complaint.

## Finding
The app CSP already allows the beacon host:
- `Caddyfile.tunnel` line 24: `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com ...`
- `Caddyfile.example` line 44: same host in script-src.

The beacon script is **edge-injected by Cloudflare**, not app code. The remaining
console noise is cosmetic — typically caused by ad-blockers / privacy extensions
blocking or modifying the edge-injected script, or browser variance in SRI handling
for edge-inlined scripts. The app itself needs no fix and no runtime change.

## Decision
**Keep Cloudflare Web Analytics enabled. No app-code change.**

The only real "fix" for the console noise is disabling Web Analytics in the
Cloudflare dashboard (zone wabi.chat → Analytics → Web Analytics). That is a
maintainer decision, not a code decision. If the maintainer wants a silent console,
disable it there; otherwise ignore the error as cosmetic.
