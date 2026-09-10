# Sprite-sheet emotes

Wabi can use game-style sprite sheets for lightweight animated emotes without GIF decoding or a WebGL shader.

The frontend player is `frontend/src/lib/components/emoji/SpriteSheetEmote.svelte`. It accepts a sprite-sheet image plus frame metadata and advances frames at a configurable FPS. The player pauses when off-screen through `IntersectionObserver` and freezes on the first frame when the operating system requests reduced motion.

## Basic usage

```svelte
<script lang="ts">
	import SpriteSheetEmote from '$lib/components/emoji/SpriteSheetEmote.svelte';
</script>

<SpriteSheetEmote
	src="/stickers/cat-waiting.webp"
	alt="Cat waiting awkwardly"
	frameCount={8}
	fps={8}
	width={128}
	height={128}
/>
```

A horizontal strip is the default: eight frames means eight columns and one row. Multi-row sheets are also supported:

```svelte
<SpriteSheetEmote
	src="/stickers/capybara-dissolve.webp"
	alt="Capybara waving and dissolving"
	frameCount={12}
	columns={4}
	fps={10}
	width={128}
	height={128}
/>
```

## Performance

The player uses a single CSS background image and only changes the selected background-position at the requested frame rate. It does not require canvas, WebGL, or a shader. Off-screen players pause automatically.

For ordinary chat emotes, 6-12 FPS is usually enough. Keep source sheets close to the display resolution instead of shipping unnecessarily large art. WebP is a good default for raster sprite sheets.

## Where shaders still help

A shader is optional and should be reserved for procedural effects such as noise dissolves, glow, distortion, hue shifts, or particles. Character motion such as blinking, waving, yawning, or slumping is better authored as frames so it remains deterministic and works identically in the web app and Tauri.

## Integration note

This change introduces the reusable player and tested frame-layout helpers. It deliberately does not change the persisted WabiDB `Emote` record. Animation metadata can be added later through manifest metadata or a backwards-compatible sidecar representation without changing postcard-encoded records.
