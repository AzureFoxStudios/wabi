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
	import {
		selectedRemoteVideo as wabidbRemoteVideoStreams,
		selectedLocalVideoActive as wabidbLocalVideoActive,
		selectedLocalVideo as wabidbLocalPreviewStreams
	} from '$lib/callingVideoState';
	import { isInCall, callMode, openChannelCallPanel } from '$lib/calling';
	import { voiceChannelMembers } from '$lib/presenceStore';

	interface StripTile {
		key: string;
		label: string;
		stream: MediaStream;
		isLocal: boolean;
		isScreen: boolean;
	}

	// Reactive merge: remote feeds + local previews. Svelte 5 contract: all
	// store reads happen in top-level $: derivations; the template only walks
	// the precomputed array.
	// Stable id → display name, so a tile says who it is instead of a raw id.
	$: namesById = (() => {
		const map = new Map<string, string>();
		for (const roster of Object.values($voiceChannelMembers)) {
			for (const member of roster) if (member.username) map.set(member.userId, member.username);
		}
		return map;
	})();

	$: stripTiles = computeStripTiles(
		$wabidbRemoteVideoStreams,
		$wabidbLocalVideoActive,
		$wabidbLocalPreviewStreams,
		$isInCall,
		$callMode,
		namesById
	);

	function computeStripTiles(
		remote: Map<string, MediaStream>,
		localActive: boolean,
		localPreviews: Map<'camera' | 'screen', MediaStream>,
		inCall: boolean,
		mode: string | null,
		names: Map<string, string>
	): StripTile[] {
		if (!inCall || mode !== 'channel') return [];
		const out: StripTile[] = [];
		for (const [key, stream] of remote) {
			const sep = key.lastIndexOf(':');
			const source = key.slice(sep + 1);
			const stableId = key.slice(0, sep);
			const name = names.get(stableId) ?? 'Someone';
			out.push({
				key,
				label: source === 'screen' ? `${name} · screen` : name,
				stream,
				isLocal: false,
				isScreen: source === 'screen'
			});
		}
		if (localActive) {
			const camera = localPreviews.get('camera');
			if (camera) out.push({ key: 'local:camera', label: 'You', stream: camera, isLocal: true, isScreen: false });
			const screen = localPreviews.get('screen');
			if (screen) out.push({ key: 'local:screen', label: 'Your screen', stream: screen, isLocal: true, isScreen: true });
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
				aria-label={`Open call view: ${tile.label}`}
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
	/* Role tokens only (design contract §5, §8.5): a hairline above, the column surface, video on
	   the sink, the label on an image scrim. Sizes follow the interface scale. */
	.voice-live-strip {
		display: flex;
		gap: 8px;
		padding: 8px 12px;
		overflow-x: auto;
		border-top: var(--w-bw) solid var(--w-line);
		background: var(--w-bg2);
	}

	.voice-live-tile {
		position: relative;
		flex: 0 0 auto;
		width: 160px;
		height: 90px;
		padding: 0;
		overflow: hidden;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: var(--w-sink);
		cursor: pointer;
		transition: border-color var(--w-dur-1) var(--w-ease);
	}
	.voice-live-tile:hover {
		border-color: var(--w-line-strong);
	}
	.voice-live-tile:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	.voice-live-tile.screen {
		width: 240px;
	}

	.voice-live-video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.voice-live-tile.screen .voice-live-video {
		object-fit: contain;
	}

	.voice-live-label {
		position: absolute;
		left: 6px;
		bottom: 6px;
		max-width: calc(100% - 12px);
		padding: 0 6px;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--w-bg) 80%, transparent);
		color: var(--w-text);
		font: var(--w-t-caption);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
