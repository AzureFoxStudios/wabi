# API SPA fallback + optional stubs

## Bug
`serve_static` SPA-fallback returned `index.html` with **HTTP 200** for unknown paths including `/api/*`. Frontend then `response.json()` → `JSON.parse: unexpected character` (ThemeApi / Places / Addons console spam). Clients that only mark-unsupported on **404** never silence the endpoint.

## Fix (wabi-server `main.rs`)
Before SPA fallback, if `path == "/api" || path.starts_with("/api/")`:
```rust
return (StatusCode::NOT_FOUND, [(CONTENT_TYPE, "application/json")], r#"{"error":"not_found"}"#).into_response();
```

## Optional stubs (return real JSON 200)
| Route | Body |
|---|---|
| `GET/PUT /api/user/theme`, `POST .../reset` | default theme JSON; in-memory map OK until WDB field |
| `GET /api/places` | `{"places":[]}` |
| `GET /api/plugins` | `{"plugins":[]}` |

## Verify
```bash
curl -s -o /dev/null -w "%{http_code}" https://wabi.chat/api/does-not-exist  # 404
curl -s https://wabi.chat/api/places   # {"places":[]}
# with token:
curl -s -H "Authorization: Bearer $T" https://wabi.chat/api/user/theme
```

## Dual headers note
Caddy + app middleware may both set CSP / Permissions-Policy. Prefer fixing **Caddyfile.tunnel** for calling (camera/mic) rather than stacking a more restrictive edge policy. See `caddy-calling-permissions.md`.
