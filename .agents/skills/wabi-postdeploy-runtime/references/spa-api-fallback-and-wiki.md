# SPA embed: JSON 404 for `/api/*` + wiki paths

## HTML shell on API

Missing/unauthorized API through SPA fallback:

```
curl -sS https://host/api/user/theme | head -c 80
# <!doctype html> ...
```

FE: `JSON.parse` / `res.json()` → unexpected character.

## Axum serve_static

Before `index.html`:

```rust
if path == "api" || path.starts_with("api/") {
    return (
        StatusCode::NOT_FOUND,
        [(CONTENT_TYPE, "application/json")],
        Json(json!({ "error": "not_found" })),
    ).into_response();
}
```

## Wiki

- Backend: `.nest("/wiki", wiki::routes)` under `/api` → `/api/wiki/{channel_id}/pages`
- FE must not keep templates as `.../wiki/pages` after switching apiBase to `/api/wiki` (double segment)
- Live probe (even old binary): existing wiki list may return `{"pages":[]}` JSON if route exists
- Domain `WikiPage`/`WikiRevision`: `#[serde(rename_all = "camelCase")]` for FE `pageId` fields
- Trait stubs in `LocalWabiStore` are not the production adapter — `WdbAdapter` has real wiki methods

## Embed order

`STATIC_BUILD=1 bun run build` (must have `build/index.html`) **then** `cargo build --release -p wabi-server`.

Plain `bun run build` (adapter-node) → no index.html → all SPA routes 404 while `/health` 200.