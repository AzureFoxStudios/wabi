<script lang="ts">
	import { onDestroy } from 'svelte';
	import { mapTokens, type MapToken } from './tokenStore';

	export let placeId: string | null = null;
	export let layerId: string | null = null;
	export let viewRotation = 0;

	let dragging: MapToken | null = null;
	let layerElement: HTMLElement | null = null;

	$: tokens = $mapTokens.filter((token) =>
		placeId && token.placeId === placeId && (!layerId || !token.layerId || token.layerId === layerId)
	);

	function beginDrag(event: PointerEvent, token: MapToken) {
		event.preventDefault();
		event.stopPropagation();
		if (Math.abs(viewRotation % 360) > 0.1) return;
		dragging = token;
		layerElement = (event.currentTarget as HTMLElement).parentElement;
		window.addEventListener('pointermove', drag);
		window.addEventListener('pointerup', endDrag, { once: true });
	}

	function drag(event: PointerEvent) {
		if (!dragging || !layerElement) return;
		const rect = layerElement.getBoundingClientRect();
		if (!rect.width || !rect.height) return;
		mapTokens.move(
			dragging.id,
			(event.clientX - rect.left) / rect.width,
			(event.clientY - rect.top) / rect.height
		);
	}

	function endDrag() {
		dragging = null;
		layerElement = null;
		window.removeEventListener('pointermove', drag);
	}

	onDestroy(() => window.removeEventListener('pointermove', drag));
</script>

{#each tokens as token (token.id)}
	<button
		type="button"
		class="map-token"
		class:dragging={dragging?.id === token.id}
		style={`left:${token.x * 100}%;top:${token.y * 100}%;--token-color:${token.color};--counter-rotation:${-viewRotation}deg`}
		title={Math.abs(viewRotation % 360) > 0.1 ? `${token.label} — reset North to drag` : `Drag ${token.label}`}
		on:pointerdown={(event) => beginDrag(event, token)}
		on:click|stopPropagation
	>
		<span class="token-glyph">{token.glyph}</span>
		<span class="token-label">{token.label}</span>
	</button>
{/each}

<style>
	.map-token {
		position:absolute;
		z-index:8;
		transform:translate(-50%,-50%) rotate(var(--counter-rotation));
		display:flex;
		align-items:center;
		gap:.3rem;
		padding:.22rem .42rem .22rem .22rem;
		border:1px solid color-mix(in srgb,var(--token-color) 70%,white 30%);
		border-radius:999px;
		background:color-mix(in srgb,var(--surface-base,#10131a) 84%,transparent);
		color:var(--text-heading,#fff);
		box-shadow:0 4px 14px rgba(0,0,0,.35);
		cursor:grab;
		user-select:none;
		touch-action:none;
	}
	.map-token:active,.map-token.dragging { cursor:grabbing; z-index:12; }
	.token-glyph { width:1.55rem;height:1.55rem;border-radius:50%;display:grid;place-items:center;background:var(--token-color);color:#111;font-weight:800; }
	.token-label { max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.72rem;font-weight:650; }
</style>
