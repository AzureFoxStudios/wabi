# Wabi profile examples

Two starter looks for the current profile creator candidate. You can use the
files separately or remix them. Nothing is published by downloading or importing.

| Look | Banner | Name and plate |
| --- | --- | --- |
| Night Garden | `night-garden.png`: 2172 × 724, 3:1, 2.39 MiB | `night-garden.wabi-profile.json`: violet/mint gradient with an outlined plate |
| Aurora Loop | `aurora-loop.webp`: 1200 × 400, 4 seconds, 64 frames, 838 KiB | `aurora-loop.wabi-profile.json`: violet glow with a gradient plate |

Aurora also includes a GIF version (1.78 MiB), a PNG still and editable source.
Both animations loop forever. WebP uses alternating 62/63 ms frame delays; GIF
uses 60/70 ms to fit that format's clock. Each complete cycle totals 4,000 ms.

## Use a look

1. Open **Settings → Profile → Profile design studio**.
2. Choose **Import design** and select the look's `.wabi-profile.json` file.
3. Edit the draft and choose **Publish design** to apply the name and plate.
4. Use **Upload banner** to add the image separately.
5. Check messages, People, the compact card, complete side panel and large card.
   Check still rendering and plain profiles too.

The in-app artist guide also has an **Edit name design** shortcut that loads a
draft directly. It does not change your published profile.

## Make your own artwork

Start with a **1200 × 400 px** banner. The Night Garden example is larger with
the same 3:1 ratio; Wabi uses a centered cover crop. Keep the lower left quiet
for the overlapping avatar and leave a margin around important detail.

For animation, a 3–6 second loop at 12–24 fps is a useful starting point. Export
animated WebP or GIF under 10 MiB. PNG/JPEG/WebP/GIF work for still banners.
Videos and SVG source files are not accepted profile-art uploads.

`aurora-loop.py` creates original ribbon shapes. It labels canvas dimensions,
duration, frame count, colors and ribbon controls. Its header explains how to
render it. The source and Aurora artwork have a CC0 dedication. Night Garden
was generated with the built-in image generation tool; its exact prompt is in
`night-garden-prompt.txt`. The remaining example files use Wabi's MIT license,
included as `LICENSE.txt` in the archive.

The full export guide and SVG artboard templates are included in the archive.
SVG templates are guides for your art application; hide the masks and labels
before exporting a bitmap.
