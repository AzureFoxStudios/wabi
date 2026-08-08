# Whiteboard Wire Contract — v1

Single source of truth for the whiteboard collaboration protocol.
Both backend (Rust) and frontend (TS) workers MUST implement against this exact contract.

## BoardDocument (JSON wire shape)

```json
{
  "boardId": "channel:<uuid>",
  "version": 12,
  "elements": [],
  "layers": [],
  "activeLayerId": "layer-default",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "policy": { "access": "open", "writeAccess": "anyone" },
  "meta": { "updatedAt": 0, "updatedBy": 0 }
}
```

- `boardId` is ALWAYS the canonical id — use `boardId` in every event, never `channelId`.
- `version` increments on every persisted snapshot. Server owns truth; clients echo it back.
- `policy.access`: `"open"` | `"desktop_only"` (web clients cannot even view).
- `policy.writeAccess`: `"anyone"` | `"desktop"` (web clients view-only).
- Missing `policy` on load → default `{ access: "open", writeAccess: "anyone" }`.

## Element fields

Base (all types): `id, type, x, y, width, height, rotation, zIndex, layerId, opacity, strokeColor, strokeWidth, fillColor, createdBy, updatedAt, locked`

- `type`: `stroke | line | rect | ellipse | arrow | text | image | math`
- `stroke` adds: `points: [{x, y, pressure?}]`
- `rect` adds: `borderRadius`
- `arrow` adds: `arrowHead: "end" | "both" | "none"`
- `text` adds: `text, fontSize, fontFamily, textAlign`
- `image` adds: `src, assetId?, fileName?, mimeType?, naturalWidth, naturalHeight`
- `math` adds: `latex, fontSize` (Phase 5 — frontend may define now, backend stores opaquely)

## Layer fields

`id, name, kind ("content"|"reference"|"background"), visible, locked, opacity, blendMode, order, createdAt, updatedAt`

- `blendMode` default `"source-over"`; curated set: `source-over, multiply, screen, overlay, darken, lighten, soft-light, hard-light, difference, exclusion`
- Unknown blendMode on load → normalize to `"source-over"`.

## Socket.IO events

### Client → Server

| Event | Payload | Notes |
|---|---|---|
| `whiteboard:join` | `{ boardId, clientClass?: "tauri" \| "web", attestation?: string }` | Server loads doc from wabiDB, enforces policy, joins room `wb:<boardId>`, replies `whiteboard:joined` |
| `whiteboard:leave` | `{ boardId }` | Leaves room, replies `whiteboard:left` |
| `whiteboard:snapshot` | `{ boardId, document }` | Client-initiated full save (debounced). Server validates size + version, persists, fans out to others |
| `whiteboard:patch` | `{ boardId, patch }` | Live op. Server validates, fans out to room EXCEPT sender, sends `whiteboard:ack` |
| `whiteboard:cursor` | `{ boardId, cursor }` | Ephemeral. Never persisted. Fanned out except sender, throttled client-side |

### Server → Client

| Event | Payload | Notes |
|---|---|---|
| `whiteboard:joined` | `{ boardId, document, capability: { read: bool, write: bool } }` | Sent to joining socket |
| `whiteboard:left` | `{ boardId }` | |
| `whiteboard:patch` | `{ boardId, patch }` | To all OTHER sockets in room |
| `whiteboard:cursor` | `{ boardId, cursor, userId, username, color }` | To all OTHER sockets in room |
| `whiteboard:ack` | `{ patchId, version }` | To the sender after successful patch application |
| `whiteboard:error` | `{ code, message }` | Codes below |

### Error codes

`DESKTOP_REQUIRED` — board is desktop_only and client is web.
`READ_ONLY` — board writeAccess is desktop and client is web (or board read-only).
`VERSION_CONFLICT` — snapshot version does not match server current version.
`PAYLOAD_TOO_LARGE` — doc > 2MB or live payload > 128KB.
`UNAUTHORIZED` — no/invalid token or no channel membership.
`NOT_FOUND` — board doc missing and cannot be created (non-member).

## Patch ops

Each patch object: `{ patchId: string, baseVersion: number, author: string, op: <op> }`

- `{ op: "element:add", element }`
- `{ op: "element:update", id, changes }`
- `{ op: "element:remove", ids: string[] }`
- `{ op: "layer:create", layer }`
- `{ op: "layer:update", id, changes }`
- `{ op: "layer:delete", id }`
- `{ op: "layer:reorder", id, dir }` — dir: `front|back|forward|backward`
- `{ op: "layer:select", id }`
- `{ op: "document:replace", document }` — full doc sync

## Size limits (already in code)

- `WHITEBOARD_MAX_DOCUMENT_BYTES = 2MB` (snapshot)
- `WHITEBOARD_MAX_LIVE_PAYLOAD_BYTES = 128KB` (patch/cursor)

## wabiDB storage

Follow the `get_user_layout` / `upsert_user_layout` JSON-blob pattern already in the
adapter (`core/crates/wabi-server/src/adapter/mod.rs` ~line 1262). Add:

- `get_whiteboard_doc(board_id) -> Result<Option<String>>` (raw JSON string)
- `put_whiteboard_doc(board_id, json) -> Result<()>`

Trait method lives in `core/crates/wabidb/src/engine/wabi_store.rs`, real impl in
the adapter, no-op fallback in the in-memory engine impl.

## Room id

`wb:<boardId>` — same as current shim.
