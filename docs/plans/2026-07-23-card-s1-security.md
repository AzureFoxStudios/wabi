# Card S1 — Security quick wins

Date: 2026-07-23
Worker: laguna (recon) + Hermes captain (headers)

## Findings
| Severity | Item | Status |
|---|---|---|
| High | JWT in localStorage (XSS-stealable) | Documented; httpOnly migration is a larger auth card |
| Med | SPA fell back HTML for unknown /api/* | Fixed earlier this loop (JSON 404) |
| Med | Missing baseline security headers | Fixed: nosniff, frame, referrer, permissions, CSP |
| Low | Optional theme/places/plugins 200 HTML | Fixed with stubs + JSON 404 |
| Info | Message render uses markdown escape path | Audited OK by Laguna recon |

## Code
- `main.rs`: `security_headers_middleware` on all responses
- Prior: API SPA fallback, theme/places/plugins stubs

## Remaining
- httpOnly cookie session migration
- CSP nonce for scripts (drop unsafe-inline)
- CSRF tokens for cookie auth when migrated
