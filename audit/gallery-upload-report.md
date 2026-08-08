# Gallery Channel Upload — Worker Report

Date: 2026-08-05

## Files changed

- `frontend/src/lib/components/GalleryChannel.svelte` — upload button + drag-and-drop
- `frontend/src/lib/galleryStore.ts` — new `uploadGalleryImages()` upload handler
- `frontend/src/lib/i18n/locales/en.json` — added `gallery_upload`, `gallery_drop_hint`
- `frontend/src/lib/i18n/locales/es.json` — added `gallery_upload`, `gallery_drop_hint`
- `frontend/src/styles/components/gallery-channel.css` — dropzone / upload button styles

Note: the task named `frontend/src/lib/stores/galleryStore.ts` and
`frontend/src/styles/components/gallery.css`, but neither exists. The real files are
`frontend/src/lib/galleryStore.ts` and `frontend/src/styles/components/gallery-channel.css`
(imported by `styles/styles.css`); edits went there.

## What was added

1. **Upload button** in the gallery header toolbar (next to the search box): a `+` icon button
   that opens a hidden `<input type="file" accept="image/*" multiple>` picker. It is disabled
   while an upload is in flight and shows a spinner in that state.

2. **Drag-and-drop**: `dragenter`/`dragover`/`dragleave`/`drop` handlers on the gallery root
   (with `role="group"` to satisfy the a11y rule, matching `TextChannelList.svelte` /
   `VoiceChannelList.svelte`). A depth counter prevents the overlay from flickering when
   crossing child elements. Dropped files are filtered to `image/*` before upload.

3. **Dropzone overlay**: absolute-positioned, semi-transparent
   (`color-mix(in srgb, var(--surface-sunken) 65%, transparent)`) overlay with a dashed
   `--accent-primary-color` border and the localized "Drop image here" hint.

4. **Upload pipeline**: follows the existing frontend upload pattern — `POST /api/upload`
   with `FormData` + `Authorization: Bearer <token>` (same as
   `media-albums/mediaAlbumUpload.ts` and `gameScreenshotPipe.ts`). After upload, each file is
   added as a media-album item for the channel scope via `addMediaAlbumItem()`. If the channel
   has no album yet, one is created via `createMediaAlbum()` (named after the channel);
   otherwise the most recently updated album is reused. On success, `loadGallery(channelId)`
   refreshes the gallery items. Non-image drops are ignored; per-file errors are surfaced in a
   `role="alert"` bar under the header.

5. **Styling**: new CSS uses only semantic tokens (`--surface-*`, `--accent-primary-color`,
   `--text-*`, `--border-subtle`, `--radius-*`, `--space-*`, `--z-overlay`) — no raw hex colors.

## Verification

```
cd /var/home/Ronin/wabi/frontend && bun run check
```

Result: **6 errors / 71 warnings** (37 files) — at the stated baseline (max 6 errors / 71 warnings).
Grep of the svelte-check output shows no diagnostics referencing any changed file
(`galleryStore`, `GalleryChannel`, gallery CSS, or the i18n locales).

## Caveats

- Uploads go straight into a media album scoped to the channel (the backing store for the
  gallery view). A new album is created only if the channel has none; otherwise the newest
  album is reused, so repeated uploads accumulate in one album rather than creating one album
  per upload.
- The upload is the simple `POST /api/upload` form-data path (not the resumable
  `/api/upload/resumable/*` pipeline). This matches the existing album-upload code
  (`mediaAlbumUpload.ts`) and other components that call `/api/upload`.
- Files are filtered by MIME (`file.type.startsWith('image/')`); files with an empty MIME type
  are skipped. The picker uses `accept="image/*"` and `multiple`.
- No commit / push performed. Files outside the scope list (`core/crates/wabi-server/src/main.rs`,
  `frontend/src/lib/wikiStore.ts`) were already modified in the working tree before this task and
  were not touched.
