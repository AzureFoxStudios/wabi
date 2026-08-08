You are a coding worker. Your task is bounded: add an upload button and drag-and-drop photo upload to gallery channels in the Wabi frontend.

## Scope

Touch ONLY these files:
- frontend/src/lib/components/GalleryChannel.svelte (add upload button + drag-and-drop)
- frontend/src/styles/components/gallery.css (add dropzone styles if needed)
- frontend/src/lib/i18n/locales/en.json (add keys: gallery_upload, gallery_drop_hint)
- frontend/src/lib/i18n/locales/es.json (add keys: gallery_upload, gallery_drop_hint)
- frontend/src/lib/stores/galleryStore.ts (add upload handler if needed)

Do NOT touch:
- src-tauri/ or any Tauri code
- core/ backend (Rust)
- tokens.css or any theme files
- ChatComposer.svelte, messageSend.ts, wikiStore.ts, main.rs
- Any file not listed above

## Implementation

1. In GalleryChannel.svelte, add a "+" or upload icon button in the header/toolbar area. Wire it to open a file picker for images only (accept="image/*").

2. Add drag-and-drop: when a user drags an image file over the gallery channel view, show a dropzone overlay. On drop, upload the file.

3. Use the existing upload pipeline. Look at these files for the pattern:
   - frontend/src/lib/components/chat/uploadOrchestrator.ts
   - frontend/src/lib/components/chat/fileHandlers.ts
   - frontend/src/lib/components/chat/uploadResumable.ts
   - frontend/src/lib/components/chat/FileUploadPreview.svelte
   Copy the upload pattern from these — do not invent a new one.

4. The upload API is POST /api/upload. Check how other components call it.

5. Use semantic tokens only (--surface-*, --accent-*, --text-*, --radius-*, --space-*). Never raw hex colors.

6. After upload completes, refresh the gallery items (check galleryStore.ts for the refresh/reload function).

7. The dropzone overlay should be subtle — a semi-transparent overlay with a dashed border and "Drop image here" text.

## Verification

After your edits:
- Run: cd /var/home/Ronin/wabi/frontend && bun run check
- Report the error/warning count. It must NOT exceed 6 errors / 71 warnings (baseline).

## Output

Write a brief report to audit/gallery-upload-report.md listing:
- Files changed
- What was added
- bun run check results
- Any caveats

Do NOT commit. Do NOT push. Do NOT touch any files outside the scope list.
