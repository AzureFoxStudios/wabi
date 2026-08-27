# Avatar upload — cross-account “only uploader sees it”

## Path
1. `POST /api/upload-profile-picture` → `/uploads/{uuid}.ext` + upload registry
2. Client emits socket `update-profile` with `profilePicture: /uploads/...`
3. Server: sanitize URL → WDB `update_user` → `profile-updated` + broadcast `user-updated`
4. **B6:** merge patch into pre-write snapshot for broadcast (do not re-read WDB immediately after write — projection race)

## Cross-account blank checklist
1. **GET `/uploads/<file>`** on Tim origin and public CF — expect **200**, `Content-Type: image/*`, not HTML/SPA
2. Uploads dir mounted and `serve_upload` path-traversal guards OK
3. Upload CSP: `default-src 'none'` + sandbox is intentional for script safety; `img-src 'self' data:` must allow display
4. Wire payload includes `profilePicture` for observers (`user-updated`)
5. Client: peopleTracker / localWabiAccounts preserve last known picture if server omits field
6. `sanitize_avatar_url` only allows `/uploads/`, `/api/`, `https://`

## Code anchors
- `core/crates/wabi-server/src/api/upload.rs` — `upload_profile_picture`
- `core/crates/wabi-server/src/socketio/presence.rs` — `on_update_profile` / `build_user_view`
- `frontend/src/lib/profilePictureUpload.ts`, Settings upload → `updateProfile`
