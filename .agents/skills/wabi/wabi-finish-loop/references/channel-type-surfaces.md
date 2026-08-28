# Channel-type surfaces (wiki / forum / gallery)

Verified on website-finish pass 2026-07-23.

## Chrome (UI)

| Don't | Do |
|---|---|
| SurfaceHeader with channel name + giant `+ New X` under ChatHeader | Compact toolbar row with small primary only |
| Description line repeating "Wiki"/"Forum" | Omit redundant surface label |
| All channels show `#` in sidebar | Distinct icons: forum bubble, wiki book, gallery tile |
| Create form: `Forum (coming soon)` disabled | Enable forum + wiki when `ChannelKind` exists |

Settings modal: branch on `channel.type` — wiki/forum/gallery titles + kind-specific help; chat retention/spoiler/purge only when chat-like.

## API paths (frontend must match nest)

| Surface | Correct base |
|---|---|
| Wiki pages | `GET/POST /api/wiki/{channelId}/pages` |
| Forum threads | `GET/POST /api/forum/{channelId}/threads` |
| Media albums | `POST /api/albums` (`scopeType`/`scopeId` camelCase) |

Wrong (404 HTML or JSON): `/api/channels/{id}/wiki/pages`.

## Domain

- `ChannelKind::Gallery = 9` required; without it create stores as Text → gallery disappears on reload.
- Forum/wiki kinds already exist; list them in sidebar filters (not only `text`).

## Projection create race (500)

Symptom: `album was created but not found in projection` / `thread created but not found in projection`.

Cause: sequencer dispatches projections async; handler `get_*` immediately after `run()` races the barrier.

Fix in `WdbAdapter::run` after `run_command` + `deliver_event`:
```rust
self.engine.barrier().wait_for(
    outcome.commit_seq,
    wabidb::projections::barrier::DEFAULT_WAIT_TIMEOUT,
).await
// warn on timeout; optional JSON fallback with synthetic id for client UX
```

Album create should take `AuthUser` (not hardcode user_id 1).

## Smoke

```bash
# wiki list
curl -s -H "Authorization: Bearer $TOKEN" https://wabi.chat/api/wiki/ch_f/pages
# forum create
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"body":"hi","title":"t"}' https://wabi.chat/api/forum/ch_c/threads
# album create
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scopeType":"channel","scopeId":"ch_1","name":"A"}' https://wabi.chat/api/albums
```
All should be HTTP 200 JSON.
