# Animated media backgrounds (added 2026-08-23)

User-uploaded animated backgrounds: images (PNG/JPG/**animated GIF/WEBP**)
and **video loops (MP4/WebM/MOV)**.

## How each type animates

| Type | Mechanism | Why |
|------|-----------|-----|
| Animated GIF / animated WEBP | CSS `background-image` on `.chat-container` (existing path) | Browsers animate these natively inside CSS backgrounds |
| MP4 / WebM / MOV | `<VideoBackground />` component, first child of `.chat-container` | CSS backgrounds cannot play video — needs a real `<video autoplay muted loop playsinline>` |

`.chat-container` is `position:relative`; the video sits at `z-index:0`
(above the container fill, below `.messages` which is `--z-base`+DOM order),
mirroring how the ambient canvas layers in.

## Persistence

`backgroundImage` rides the existing custom-theme round-trip
(`themeStore.customTheme.backgroundImage` → server `custom_theme` /
localStorage). No schema change; video vs image is derived from the URL
extension (`/\.(mp4|webm|mov)(\?|$)/i`).

## Upload endpoint (was missing!)

The frontend called `POST /api/upload-background-image` from day one but **no
handler existed server-side** — uploads 404'd silently. Implemented
2026-08-23:

- Handler: `core/crates/wabi-server/src/api/upload.rs::upload_background_image`
- Route mount: `core/crates/wabi-server/src/api/routes.rs` (`/api/upload-background-image`)
- Validation: magic-byte sniffing (`sniff_background_mime`) for
  PNG/JPEG/GIF8/WEBP(RIFF)/MP4(ftyp)/WEBM(EBML); extension derives from the
  SNIFFED type, never the client filename. Cap 25MB (video loops), images 10MB.
- Response shape: `{ backgroundImageUrl }` (frontend also tolerates `fileUrl`).
- Registry kind: `UploadKind::Other`.

Served back via the standard capability-URL `/uploads/{filename}` with the
locked-down CSP/sandbox headers — no change needed there.

## Settings UI

`BackgroundImageEditor.svelte`: accept list includes
`video/mp4,video/webm,video/quicktime`; preview renders `<video>` for video,
CSS box for images. Opacity/blur apply to both paths.
