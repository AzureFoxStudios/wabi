# Fixing Media Uploads — May 2026

## Problem Statement

Users cannot upload images, audio recordings, or any media. The upload flow exists end-to-end but breaks at storage.

## How It Works (Frontend)

When a user attaches a photo or records audio:

1. `Chat.svelte` calls `POST /api/upload/resumable/init`
2. Chunks are `PUT` to `/api/upload/resumable/chunk?uploadId=...&offset=...&uploadToken=...`
3. Final step: `POST /api/upload/resumable/complete`
4. The returned `fileUrl` (e.g. `/uploads/photo-1746212341.jpg`) gets embedded in a message

The frontend expects uploaded files to be served at `GET /uploads/<filename` from the same origin.

## Root Causes

### Issue 1: No Storage Directory Configured
The Rust server has no `UPLOADS_DIR` environment variable or config field. The upload endpoints return fake URLs (`/uploads/filename`) but never actually write files anywhere.

### Issue 2: Docker Volume Not Mounted
The `wabi-server` Docker container only mounts:
```
/home/tim/wabi/data -> /data
```
The `uploads` directory (`/home/tim/wabi/uploads`) is not mounted inside the container.

### Issue 3: No Static File Route for /uploads/*
The Axum router only has:
- `/api/*` — API routes
- `/health` — health check
- `/ws/*` — WebSocket
- `/*` (fallback) — serves from embedded `frontend/build` only

There is no route to serve files from an uploads directory.

## Solution

### Rust Side (wabi-server)

1. **Add `uploads_dir` config field** — path to directory where uploaded files are stored
2. **Add static file route** — `GET /uploads/{filename}` that reads from `uploads_dir` and streams the file
3. **Implement actual file storage** — write chunks to temp files, assemble on complete
4. **Proper MIME types** — detect from file extension, set Content-Type header

### Docker Side

Update the container to mount the uploads volume:
```yaml
volumes:
  - /home/tim/wabi/data:/data
  - /home/tim/wabi/uploads:/app/uploads:z  # ADD THIS
```

### Deploy Side

Set `UPLOADS_DIR` env var in the Docker container (defaults to `/app/uploads` if the volume is mounted).

## Implementation Steps

### Task 1: Add UploadsConfig to Server Config ✅
**File:** `core/crates/wabi-server/src/config.rs`
Added `uploads_dir: String` field to `ServerConfig`. Defaults to `$DATA_DIR/uploads` if `UPLOADS_DIR` env var not set.

### Task 2: Add /uploads Static File Route ✅
**File:** `core/crates/wabi-server/src/main.rs`
Added `serve_upload` async handler and `GET /uploads/{filename}` route using Axum's `NamedFile`. MIME type auto-detected via `mime_guess`.

### Task 3: Implement Real File Storage ✅
**File:** `core/crates/wabi-server/src/api/upload.rs`
Complete rewrite:
- UUID-based filenames (no user input in paths)
- Chunks written to temp dir first
- `complete` endpoint atomically moves temp → final location via `std::fs::rename`
- Upload state tracked in-memory via `UploadState` (RwLock-protected HashMap)
- Handles duplicate `init` calls (resume support)

### Task 4: Add Environment Variable ✅
**File:** `core/crates/wabi-server/src/config.rs`
`UPLOADS_DIR` env var, defaults to `{data_dir}/uploads`.

### Task 5: Update Docker Mount ✅
Container now runs with:
```
-v /home/tim/wabi/data:/data:z
-v /home/tim/wabi/uploads:/uploads:z
-e UPLOADS_DIR=/uploads
```

The full `docker run` command (all flags required):
```bash
docker run -d \
  --name wabi-server \
  --restart unless-stopped \
  --network wabi_default \
  -p 127.0.0.1:8080:8080 \
  -v /home/tim/wabi/data:/data:z \
  -v /home/tim/wabi/uploads:/uploads:z \
  -e UPLOADS_DIR=/uploads \
  -e RUST_LOG=wabi_server=debug \
  -e STDB_TOKEN=... \
  -e STDB_ENDPOINT=https://... \
  -e JWT_SECRET=... \
  -e WABI_INGEST_SECRET=... \
  wabi-wabi-server:latest
```

After binary update on host:
```bash
docker cp /home/tim/wabi/bin/wabi-server wabi-server:/app/wabi-server
docker restart wabi-server
```

Fixed by recreating container with proper flags (was missing from initial run).

### Task 6: Update Deploy Documentation ✅
This file is the documentation.

## Verification Steps

1. Build with `cargo build -p wabi-server --release`
2. Deploy to Tim
3. From browser devtools:
   - Attach a photo in a channel
   - Network tab shows `PUT /api/upload/resumable/chunk` returning 200
   - `POST /api/upload/resumable/complete` returns a `fileUrl`
4. Open the returned URL (e.g. `https://wabi.chat/uploads/uuid.jpg`) — image loads
5. Other users can see the image in the message

## Storage Notes

- **Location on Tim's server:** `/home/tim/wabi/uploads/` (host path), mounted at `/app/uploads` in container
- **Old Node.js backend** already had files there (`.glb`, `.obj` files from previous development)
- **File naming:** UUID-based to avoid collisions and path traversal attacks
- **No S3 for now:** Local disk only. Can add S3/gcs/Backblaze later if storage scales.
- **No encryption at rest:** Files are stored unencrypted (same as the old backend)

## Security Considerations

- Filenames are UUID-based, not user-provided — prevents path traversal
- File extension is preserved from the original MIME type mapping
- No user-provided path components accepted
- The `/uploads/` route should probably be auth-gated or at least verify the request has a valid session cookie — currently the upload endpoints use `getUploadAuthHeaders()` (Bearer token), but the static file download does not have obvious auth
- Consider adding a short-lived signed URL pattern if downloads need to be protected (future work)
