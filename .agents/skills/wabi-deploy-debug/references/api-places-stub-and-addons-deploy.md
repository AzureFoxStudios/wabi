# Places stub + addons nest — code vs Tim live (R7b)

## Symptom

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' http://100.96.11.45:3001/api/places
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' http://100.96.11.45:3001/api/addons
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' http://100.96.11.45:3001/api/channels
# Broken: places/addons → 200 text/html (SPA index)
# Healthy control: channels → 200 application/json
```

## Root cause

SPA `serve_static` fallback returns index.html 200 for paths not nested under `/api`. Client that expects JSON gets HTML → JSON.parse spam. **If channels is JSON but places/addons are HTML, binary is old / missing nests — not a FE bug.**

## Code shipped (2026-08-01)

`core/crates/wabi-server/src/api/places.rs`:
- `GET /` → `{"places":[]}`
- nested at `/api/places` via `routes.rs` + `mod.rs`

`/api/addons` already has real handler in source (`addons.rs` + `.nest("/addons", ...)`). Live HTML = Tim binary predates nest → **redeploy**.

Also prefer JSON-404 catch-all for unknown `/api/*` before SPA fallback (see `api-spa-fallback-and-stubs.md`).

## Client layer (R7a — already)

`parseApiJson` + content-type + `markEndpointUnsupported` — silences console while ops lag. Do not thrash more FE after guards.

## Board language

- **Code done** = module + nest + `cargo check -p wabi-server`
- **Live green** = Tim curl content-type application/json
- Never mark R7b fully green on source alone while curl is HTML

## After deploy prove

```bash
curl -s http://HOST:3001/api/places   # {"places":[]}
curl -sI http://HOST:3001/api/addons | rg -i content-type
```
