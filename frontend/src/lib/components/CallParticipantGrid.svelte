<script lang="ts">
	import type { RenderTile } from '$lib/callRenderModel';
	import type { PresenterOverlayElement, PresenterOverlayTool } from '$lib/calling/presenterOverlay';
	import { tileOwnerParticipantId } from '$lib/callLayoutManager';
	import { activeCalls, isMuted, isDeafened, isLocalSpeaking } from '$lib/calling';
	import CallParticipantTile from './CallParticipantTile.svelte';

	export let orderedTiles: RenderTile[];
	export let layoutTemplate: string = 'grid-2x2';
	export let pinnedTileIds: string[] = [];
	export let isSpeaking: (tile: RenderTile) => boolean = () => false;
	export let getParticipantAvatarUrl: (tile: RenderTile) => string | null = () => null;
	export let getInitial: (label: string) => string = (label) => label.charAt(0).toUpperCase();
	export let onPin: (tileId: string) => void = () => {};
	export let isTileDisconnected: (tile: RenderTile) => boolean = () => false;

	// Presenter overlay props
	export let presenterOverlayVisible: boolean = false;
	export let activePresenterOverlayTileId: string = '';
	export let presenterOverlayTool: PresenterOverlayTool = 'pen';
	export let presenterOverlayColor: string = '#ffffff';
	export let presenterOverlayStrokeWidth: number = 2;
	export let presenterOverlayElementsByTile: Record<string, PresenterOverlayElement[]> = {};
	export let onPresenterOverlayChange: (tileId: string, elements: PresenterOverlayElement[]) => void = () => {};
	export let onPresenterOverlayActivate: (tileId: string) => void = () => {};
	export let heroIds: string[] = [];

	function isBubbleLayout(): boolean {
		return layoutTemplate === 'floating-bubbles';
	}
</script>

{#if isBubbleLayout()}
	<div class="bubble-stage" class:single-bubble={orderedTiles.length === 1}>
		{#each orderedTiles as tile (tile.id)}
			<CallParticipantTile
				{tile}
				isPinned={pinnedTileIds.includes(tile.id)}
				isSpeaking={isSpeaking(tile)}
				isDisconnected={isTileDisconnected(tile)}
				avatarUrl={getParticipantAvatarUrl(tile)}
				{onPin}
				{getInitial}
				layout="bubble"
			/>
		{/each}
	</div>
{:else}
	<div class="tile-layout template-{layoutTemplate}">
		{#each orderedTiles as tile (tile.id)}
			<CallParticipantTile
				{tile}
				isPinned={pinnedTileIds.includes(tile.id)}
				isSpeaking={isSpeaking(tile)}
				isDisconnected={isTileDisconnected(tile)}
				avatarUrl={getParticipantAvatarUrl(tile)}
				{onPin}
				{getInitial}
				layout="grid"
				{presenterOverlayVisible}
				{activePresenterOverlayTileId}
				{presenterOverlayTool}
				{presenterOverlayColor}
				{presenterOverlayStrokeWidth}
				presenterOverlayElements={presenterOverlayElementsByTile[tile.id] || []}
				onPresenterOverlayChange={(elements) => onPresenterOverlayChange(tile.id, elements)}
				onPresenterOverlayActivate={() => onPresenterOverlayActivate(tile.id)}
			/>
		{/each}
	</div>
{/if}

<style>
	.tile-layout {
		height: 100%;
		display: grid;
		gap: 0.65rem;
		padding: 0.65rem;
		overflow: auto;
		align-content: start;
	}

	.template-screen-hero,
	.template-single-hero {
		grid-template-columns: repeat(12, minmax(0, 1fr));
		grid-auto-rows: minmax(92px, auto);
	}

	.template-screen-hero :global(.media-tile.hero),
	.template-single-hero :global(.media-tile.hero) {
		grid-column: 1 / -1;
		grid-row: 1;
		min-height: min(68vh, 100%);
		aspect-ratio: auto;
	}

	.template-screen-hero :global(.media-tile:not(.hero)),
	.template-single-hero :global(.media-tile:not(.hero)) {
		grid-column: span 3;
	}

	.template-split {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.template-hero-stack {
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		grid-auto-rows: minmax(120px, 1fr);
	}

	.template-hero-stack :global(.media-tile.hero) {
		grid-column: 1;
		grid-row: 1 / span 2;
		aspect-ratio: auto;
		min-height: 0;
	}

	.template-grid-2x2 {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.template-double-hero-triple {
		grid-template-columns: repeat(6, minmax(0, 1fr));
	}

	.template-double-hero-triple :global(.media-tile.hero) {
		grid-column: span 3;
		aspect-ratio: 16 / 9;
	}

	.template-double-hero-triple :global(.media-tile:not(.hero)) {
		grid-column: span 2;
	}

	.template-uniform-grid {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}

	.template-scroll-grid {
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
	}

	.bubble-stage {
		position: relative;
		height: 100%;
		background: radial-gradient(circle at 20% 15%, rgba(var(--color-info-rgb, 56, 189, 248), 0.16), transparent 45%),
			radial-gradient(circle at 80% 75%, rgba(var(--color-info-rgb, 59, 130, 246), 0.16), transparent 45%),
			var(--surface-app, #0b1020);
		overflow: hidden;
	}

	.bubble-stage.single-bubble {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	:global(.single-bubble .bubble-tile) {
		position: relative;
		left: auto;
		top: auto;
		transform: none;
	}

	@media (max-width: 900px) {
		.template-screen-hero :global(.media-tile:not(.hero)),
		.template-single-hero :global(.media-tile:not(.hero)) {
			grid-column: span 4;
		}
	}

	@media (max-width: 640px) {
		.tile-layout {
			grid-template-columns: 1fr !important;
		}

		.template-hero-stack :global(.media-tile.hero) {
			grid-row: auto;
			aspect-ratio: 16 / 9;
		}
	}
</style>
