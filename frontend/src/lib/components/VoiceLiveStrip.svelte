<script lang="ts">
	/**
	 * Docked live-tile strip (calling-audit P1.4).
	 *
	 * When the connected voice channel has ANY inbound wabidb video/screen
	 * feed, render a compact tile strip docked above the composer — inside the
	 * chat stack, never a center-stage takeover (docked-first contract).
	 * Hidden when there is nothing to show. Clicking a tile opens the embedded
	 * call shell via openChannelCallPanel().
	 */
	import { onDestroy } from 'svelte';
	import {
		wabidbRemoteVideoStreams,
		wabidbLocalVideoActive,
		wabidbLocalPreviewStreams
	} from '$lib/wabidbVideoLane';
	import { isInCall, callMode, openChannelCallPanel } from '$lib/calling';

	interface StripTile {
		key: string;
		label: string;
		stream: MediaStream;
		isLocal: boolean;
		isScreen: boolean;
	}

	let tiles: StripTile[] = [];

	// Reactive merge: remote feeds + local previews. Svelte 5 contract: all
	// store reads happen in top-level $: derivations; the template only walks
	// the precomputed array.
	$: stripTiles = computeStripTiles(
		$wabidbRemoteVideoStreams,
		$wabidbLocalVideoActive,
		$wabidbLocalPreviewStreams,
		$isInCall,
		$callMode
	);

	function computeStripTiles(
		remote: Map<string, MediaStream>,
		localActive: boolean,
		localPreviews: Map<'camera' | 'screen', MediaStream>,
		inCall: boolean,
		mode: string | null
	): StripTile[] {
		if (!inCall || mode !== 'channel') return [];
		const out: StripTile[] = [];
		for (const [key, stream] of remote) {
			const sep = key.lastIndexOf(':');
			const source = key.slice(sep + 1);
			const stableId = key.slice(0, sep);
			out.push({
				key,
				label: source === 'screen' ? 'Screen' : stableId.replace(/^user-/, ''),
				stream,
				isLocal: false,
				isScreen: source === 'screen'
			});
		}
		if (localActive) {
			const camera = localPreviews.get('camera');
			if (camera) out.push({ key: 'local:camera', label: 'You', stream: camera, isLocal: true, isScreen: false });
			const screen = localPreviews.get('screen');
			if (screen) out.push({ key: 'local:screen', label: 'Your Screen', stream: screen, isLocal: true, isScreen: true });
		}
		return out;
	}

	function openCallView(): void {
		openChannelCallPanel();
	}

	/** Svelte action attaching a MediaStream to a <video> element. */
	function bindStream(node: HTMLVideoElement, stream: MediaStream) {
		node.srcObject = stream;
		return {
			update(next: MediaStream) {
				if (node.srcObject !== next) node.srcObject = next;
			},
			destroy() {
				node.srcObject = null;
			}
		};
	}
</script>

{#if stripTiles.length > 0}
	<div class="voice-live-strip" role="region" aria-label="Live video in this channel">
		{#each stripTiles as tile (tile.key)}
			<button
				type="button"
				class="voice-live-tile"
				class:screen={tile.isScreen}
				on:click={openCallView}
				title="Open call view"
			>
				<video
					class="voice-live-video"
					muted
					autoplay
					playsinline
					use:bindStream={tile.stream}
				></video>
				<span class="voice-live-label">{tile.label}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.voice-live-strip {
		display: flex;
		gap: 8px;
		padding: 6px 10px;
		overflow-x: auto;
		border-top: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--surface-base, #111827) 92%, black 8%);
	}

	.voice-live-tile {
		position: relative;
		flex: 0 0 auto;
		width: 160px;
		height: 90px;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		background: #000;
		cursor: pointer;
		padding: 0;
	}

	.voice-live-tile.screen {
		width: 240px;
	}

	.voice-live-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.voice-live-tile.screen .voice-live-video {
		object-fit: contain;
	}

	.voice-live-label {
		position: absolute;
		left: 6px;
		bottom: 4px;
		max-width: calc(100% - 12px);
		padding: 1px 6px;
		border-radius: 6px;
		font-size: 0.68rem;
		font-weight: 600;
		color: #fff;
		background: rgba(0, 0, 0, 0.55);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
