<script lang="ts">
	import type { RenderTile } from '$lib/callRenderModel';
	import type { PresenterOverlayElement, PresenterOverlayTool } from '$lib/calling/presenterOverlay';
	import PresenterOverlayCanvas from './PresenterOverlayCanvas.svelte';

	export let tile: RenderTile;
	export let isPinned: boolean = false;
	export let isSpeaking: boolean = false;
	export let isDisconnected: boolean = false;
	export let avatarUrl: string | null = null;
	export let layout: 'grid' | 'bubble' = 'grid';
	export let getInitial: (label: string) => string = (label) => label.charAt(0).toUpperCase();
	export let onPin: (tileId: string) => void = () => {};

	// Presenter overlay props
	export let presenterOverlayVisible: boolean = false;
	export let activePresenterOverlayTileId: string = '';
	export let presenterOverlayTool: PresenterOverlayTool = 'pen';
	export let presenterOverlayColor: string = '#ffffff';
	export let presenterOverlayStrokeWidth: number = 2;
	export let presenterOverlayElements: PresenterOverlayElement[] = [];
	export let onPresenterOverlayChange: (elements: PresenterOverlayElement[]) => void = () => {};
	export let onPresenterOverlayActivate: () => void = () => {};

	function bindMediaStream(node: HTMLMediaElement, stream: MediaStream | null) {
		node.srcObject = stream ?? null;
		return {
			update(nextStream: MediaStream | null) {
				node.srcObject = nextStream ?? null;
			},
			destroy() {
				node.srcObject = null;
			}
		};
	}

	function hashString(value: string): number {
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = value.charCodeAt(i) + ((hash << 5) - hash);
		}
		return Math.abs(hash);
	}

	function bubbleStyle(tileId: string): string {
		const seed = hashString(tileId);
		const angle = (seed % 360) * (Math.PI / 180);
		const radius = 24 + (seed % 16);
		const x = Math.max(10, Math.min(90, 50 + Math.cos(angle) * radius));
		const y = Math.max(15, Math.min(85, 50 + Math.sin(angle) * radius));
		const size = 78 + (seed % 24);
		return `left:${x}%; top:${y}%; width:${size}px; height:${size}px;`;
	}
</script>

{#if layout === 'bubble'}
	<div
		class="bubble-tile"
		class:pinned={isPinned}
		class:speaking={isSpeaking}
		style={bubbleStyle(tile.id)}
	>
		<button
			type="button"
			class="pin-btn"
			on:click|stopPropagation={() => onPin(tile.id)}
			title={isPinned ? 'Unpin tile' : 'Pin tile'}
		>
			{isPinned ? 'Unpin' : 'Pin'}
		</button>
		<div class="bubble-avatar">
			{#if avatarUrl}
				<img class="bubble-avatar-image" src={avatarUrl} alt={tile.label} loading="lazy" decoding="async" />
			{:else}
				{getInitial(tile.label)}
			{/if}
		</div>
		<div class="bubble-label">{tile.label}</div>
		{#if isDisconnected}
			<div class="tile-status">Disconnected</div>
		{/if}
	</div>
{:else}
	<article
		class="media-tile"
		class:pinned={isPinned}
		class:speaking={isSpeaking}
		class:presenter-overlay-target={presenterOverlayVisible && tile.kind === 'screen' && activePresenterOverlayTileId === tile.id}
		data-tile-id={tile.id}
	>
		<button
			type="button"
			class="pin-btn"
			on:click|stopPropagation={() => onPin(tile.id)}
			title={isPinned ? 'Unpin tile' : 'Pin tile'}
		>
			{isPinned ? 'Unpin' : 'Pin'}
		</button>
		{#if tile.kind === 'avatar' || !tile.stream}
			<div class="tile-avatar">
				<div class="avatar-circle">
					{#if avatarUrl}
						<img class="avatar-circle-image" src={avatarUrl} alt={tile.label} loading="lazy" decoding="async" />
					{:else}
						{getInitial(tile.label)}
					{/if}
				</div>
			</div>
		{:else}
			<video
				class="tile-video"
				class:contain={tile.kind === 'screen'}
				autoplay
				playsinline
				muted
				use:bindMediaStream={tile.stream}
			></video>
			{#if tile.kind === 'screen' && presenterOverlayVisible}
				<PresenterOverlayCanvas
					elements={presenterOverlayElements}
					enabled={presenterOverlayVisible}
					active={activePresenterOverlayTileId === tile.id}
					tool={presenterOverlayTool}
					strokeColor={presenterOverlayColor}
					strokeWidth={presenterOverlayStrokeWidth}
					tileLabel={tile.label}
					onChange={onPresenterOverlayChange}
					onActivate={onPresenterOverlayActivate}
				/>
			{/if}
		{/if}
		<div class="tile-label">{tile.label}</div>
		{#if isDisconnected}
			<div class="tile-status">Disconnected</div>
		{/if}
	</article>
{/if}

<style>
	.media-tile {
		position: relative;
		border-radius: 12px;
		overflow: hidden;
		background: color-mix(in srgb, var(--surface-base, #111827) 90%, black 10%);
		aspect-ratio: 16 / 9;
		border: 2px solid transparent;
		min-height: 120px;
	}

	.media-tile.speaking {
		border-color: rgba(var(--status-online-rgb, 34, 197, 94), 0.82);
		box-shadow: 0 0 0 2px rgba(var(--status-online-rgb, 34, 197, 94), 0.35);
	}

	.media-tile.pinned {
		border-color: rgba(var(--color-warning-rgb, 250, 204, 21), 0.88);
	}

	.media-tile.presenter-overlay-target {
		border-color: rgba(var(--color-warning-rgb, 250, 204, 21), 0.94);
		box-shadow: 0 0 0 2px rgba(var(--color-warning-rgb, 250, 204, 21), 0.28);
	}

	.tile-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.tile-video.contain {
		object-fit: contain;
		background: var(--surface-app, var(--surface-app, #000));
	}

	.tile-avatar {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(160deg, rgba(var(--surface-base-rgb, 30, 41, 59), 0.95), rgba(var(--surface-app-rgb, 15, 23, 42), 0.92));
	}

	.avatar-circle {
		width: 84px;
		height: 84px;
		border-radius: 50%;
		background: var(--accent, var(--accent-primary, #5865f2));
		color: var(--text-inverse, var(--text-inverse, #fff));
		font-size: 1.9rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.avatar-circle-image {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}

	.tile-label {
		position: absolute;
		left: 0.55rem;
		bottom: 0.55rem;
		z-index: 3;
		background: var(--shadow-lg, var(--shadow-lg, rgba(0, 0, 0, 0.64)));
		color: var(--text-inverse, var(--text-inverse, #fff));
		padding: 0.25rem 0.45rem;
		border-radius: 6px;
		font-size: 0.72rem;
		font-weight: 600;
		pointer-events: none;
	}

	.pin-btn {
		position: absolute;
		top: 0.45rem;
		right: 0.45rem;
		z-index: 3;
		padding: 0.2rem 0.4rem;
		border-radius: 999px;
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.24);
		background: var(--shadow-lg, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.56))));
		color: var(--text-inverse, var(--text-inverse, #fff));
		font-size: 0.64rem;
		font-weight: 700;
		cursor: pointer;
	}

	.bubble-tile {
		position: absolute;
		transform: translate(-50%, -50%);
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-base, #111827) 86%, black 14%);
		border: 2px solid transparent;
		padding: 0.35rem;
	}

	.bubble-tile.speaking {
		border-color: rgba(var(--status-online-rgb, 34, 197, 94), 0.9);
		box-shadow: 0 0 0 2px rgba(var(--status-online-rgb, 34, 197, 94), 0.28);
	}

	.bubble-tile.pinned {
		border-color: rgba(var(--color-warning-rgb, 250, 204, 21), 0.92);
	}

	.bubble-avatar {
		width: 100%;
		height: 100%;
		border-radius: 999px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.35rem;
		font-weight: 700;
		color: var(--text-inverse, var(--text-inverse, #fff));
		background: linear-gradient(145deg, rgba(var(--accent-primary-rgb, 88, 101, 242), 0.92), rgba(var(--accent-primary-rgb, 67, 56, 202), 0.9));
	}

	.bubble-avatar-image {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}

	.bubble-label {
		position: absolute;
		bottom: -1.15rem;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.68rem;
		font-weight: 600;
		color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.88);
		white-space: nowrap;
	}

	.tile-status {
		position: absolute;
		left: 0.55rem;
		top: 0.55rem;
		background: var(--color-danger, rgba(185, 28, 28, 0.85));
		color: var(--text-inverse, var(--text-inverse, #fff));
		padding: 0.14rem 0.36rem;
		border-radius: 6px;
		font-size: 0.62rem;
		font-weight: 700;
	}
</style>
