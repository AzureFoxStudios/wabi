# Creating profile art for Wabi

This is the export contract for the current profile creator candidate. It is not
a claim that the candidate is deployed on a public server.

## Banner canvas

- Start with **1200 × 400 pixels (3:1)**. Larger art with the same ratio works;
  those dimensions are a recommendation, not an upload requirement.
- Profile popouts, the full profile and the editor show a 3:1 banner with centered
  cover scaling. Different ratios crop at the edges. A compact sidebar can show
  a shallower decorative crop, so essential information belongs in the bio.
- Keep important artwork away from the bottom left: the avatar overlaps that
  area. At narrow sizes, treat **x 0–400, y 200–400** on the recommended canvas
  as an overlap zone. Leave about 60 pixels around other edges; avoid the top
  right where profile controls can appear.
- The downloadable [banner guide](./banner-guide.svg)
  marks a suggested central/right subject area. Use it as an artboard guide;
  hide its labels and masks before exporting. Wabi does not offer an artwork
  cropping or animation timeline editor in this candidate.

## Animation and export

- For banners, export **PNG, JPEG, GIF or WebP**. The decoration editor accepts
  **PNG, GIF or WebP**; choose PNG or WebP when you need a transparent center.
  Both artwork flows allow **10 MiB or less** per file. The server checks the
  image signature and stores the original bytes with a matching extension.
  A filename alone does not determine format.
- Use **animated WebP or GIF** for looping art. APNG retains its PNG bytes; its
  animation depends on the receiving browser. WebP is a useful choice when a
  transparent animated decoration needs a smaller file than GIF.
- A practical starting point is a **3–6 second seamless loop, 12–24 fps**. These
  are artist recommendations, not enforced frame or duration limits. Export in
  sRGB and inspect the file at its actual on-screen size.
- Avoid flashes and rapid high-contrast transitions. Keep text readable with
  and without animation. Make a useful still image: a viewer can stop profile
  animation or hide the decorative art entirely.
- Uploaded animation is not converted into a video. The app has no guarantee
  of equal playback speed or color rendering across browsers/native webviews.
- Stopping profile animation displays one decoded frame in a canvas. It is not
  a timeline selector and does not guarantee that every browser picks exactly
  the same frame. Reduced motion also stops the name shimmer.

## Avatar decoration

- Use **512 × 512 pixels**, with a transparent center so the person's avatar is
  still visible. PNG and animated WebP are convenient transparent exports; GIF
  has more limited transparency.
- Profile cards and the editor use rounded square avatars. Small message and
  People rows crop avatars and decorations to a circle. Keep important art
  within the central circular area, leave the corners clear, and keep the
  center transparent so the avatar remains visible in either crop. Preview
  at small row sizes as well as on a profile card.
- Start with the [decoration guide](./avatar-overlay-guide.svg).
  Scale/offset controls help align the art; this is not a free drawing editor.
- Avatar picture upload is a separate flow with its own 5 MiB limit. A banner
  or decoration's 10 MiB limit does not change that flow.

## Names and plates

The profile creator edits typography, two-color gradients, glow, slow shimmer
and solid/gradient/outline nameplates. Start with a preset and tune it, then
export a **Wabi profile design JSON** file. A version 1 design is at most 16 KiB
and contains appearance values plus a title, without an account ID, biography,
media URLs or executable CSS. Importing changes a draft; **Publish design** is
the step that saves it to the active server/account.

Artwork is shared as separate image files. Design import/export does not bundle
avatar/banner images, copy files between independent Wabi servers or publish a
design to a marketplace. Plain-mode and animation choices belong to each viewer
and are never included in the artist's design.

## Downloadable examples

The in-app guide includes two complete example looks. You can download the
[example pack](./examples/profile-examples.zip), or use individual files:

- **Night Garden:** [painted banner](./examples/night-garden.png), 2172 × 724
  pixels at 3:1, with a [gradient name and outlined plate](./examples/night-garden.wabi-profile.json).
- **Aurora Loop:** [animated WebP](./examples/aurora-loop.webp), 1200 × 400,
  four seconds and 64 frames, with a [glowing name and gradient plate](./examples/aurora-loop.wabi-profile.json).
  It also includes a [GIF](./examples/aurora-loop.gif), [PNG still](./examples/aurora-loop-poster.png)
  and [editable animation source](./examples/aurora-loop.py).

Both examples fit the upload limits. The gallery starts with still images;
playing the animated example respects your motion settings. **Edit name design**
loads a local draft in the studio. Import a downloaded design and explicitly
publish it to apply the name/plate; upload the banner separately. See the
[example notes](./examples/README.md) for steps, timing and source details.

## Preview checklist

1. Check the banner at 3:1, including the avatar overlap and a narrow phone view.
2. Check the name/plate in a message, People row and profile card, on light and
   dark themes.
3. Check a still frame and plain rendering; the person must stay identifiable.
4. Publish to a disposable account and inspect from a second account. Refresh
   and reconnect before calling the result saved.

Sprite-sheet emotes, custom server emoji and stickers use separate asset
contracts. Super-reaction effects and profile-wide particle effects are not
implemented by this profile design format.
