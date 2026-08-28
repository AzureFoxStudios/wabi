# `/api/media/runtime` 404 fix

## Symptom
`GET /api/media/runtime` returns `{"error":"not_found"}` even after redeploy.

## Root cause
The handler was registered in the wrong router module. The frontend calls
`/api/media/...`, which is handled by `api/media.rs` → `media::routes()`.
Adding the route in `api/routes.rs` under the separate `/media-turn` mount
makes it invisible to `/api/media/*` requests.

## Fix
Move the route/handler into `api/media.rs` inside `media::routes()`, then
remove the stale declaration from `api/routes.rs`.

## Verification
```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/media/runtime
# -> 200
curl -s http://127.0.0.1:3001/api/media/runtime | head -20
# -> {"media":{"localEnhancedEnabled":true,...}}
```

## Pitfall
If you moved a handler between modules and `cargo check` says
`cannot find value <fn> in this scope`, clean the stale artifact:
```bash
cargo clean -p wabi-server && cargo check -p wabi-server --release --features addons
```
