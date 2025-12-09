<script lang="ts">
	import { screenShares, isSharing, stopScreenShare } from '$lib/webrtc';
	import { activeCalls, endCall, isInCall } from '$lib/calling';
	import { getSocket } from '$lib/socket';
	import { fade } from 'svelte/transition';

	// Reactive declaration to determine if any call or screen share is active
	$: hasActiveMedia = $activeCalls.length > 0 || $screenShares.length > 0;

	function handleStopScreenShare() {
		const socketInstance = getSocket();
		if (socketInstance) {
			stopScreenShare(socketInstance);
		} else {
			console.error('Socket not available to stop screen share');
		}
	}

	function handleEndCall() {
		const socketInstance = getSocket();
		if (socketInstance) {
			endCall(socketInstance);
		} else {
			console.error('Socket not available to end call');
		}
	}
</script>

{#if hasActiveMedia}
	<div class="call-view-container" transition:fade>
		{#each $activeCalls as call (call.userId)}
			<div class="media-window">
				<video
					autoplay
					playsinline
					muted={call.userId === $activeCalls[0]?.userId}
					srcObject={call.stream}
					class:hidden={!call.isVideoEnabled}
				></video>
				<div class="user-label">{call.username || 'Unknown'} (Call)</div>
			</div>
		{/each}

		{#each $screenShares as share (share.userId)}
			<div class="media-window screen-share-window">
				<video
					autoplay
					playsinline
					srcObject={share.stream}
				></video>
				<div class="user-label">{share.username || 'Unknown'} (Screen Share)</div>
			</div>
		{/each}

		<div class="controls">
			{#if $isSharing}
				<button class="control-button stop-share" on:click={handleStopScreenShare} title="Stop Screen Share">
					⏹️ Stop Share
				</button>
			{/if}
			{#if $isInCall}
				<button class="control-button end-call" on:click={handleEndCall} title="End Call">
					📞 End Call
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.call-view-container {
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		background-color: rgba(0, 0, 0, 0.7); /* Semi-transparent overlay */
		z-index: 999; /* Below modals but above main content */
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 10px;
		padding: 20px;
		box-sizing: border-box;
	}

	.media-window {
		position: relative;
		background-color: #1a1a1a;
		border: 1px solid #333;
		border-radius: 8px;
		overflow: hidden;
		flex-grow: 1;
		flex-basis: 300px; /* Minimum width for a video */
		max-width: 500px; /* Maximum width for a video */
		aspect-ratio: 16 / 9;
		display: flex;
		justify-content: center;
		align-items: center;
	}

	.media-window video {
		width: 100%;
		height: 100%;
		object-fit: contain; /* Ensure entire video is visible */
		background-color: black;
	}

	.media-window video.hidden {
		display: none;
	}

	.user-label {
		position: absolute;
		bottom: 10px;
		left: 10px;
		background-color: rgba(0, 0, 0, 0.6);
		color: white;
		padding: 5px 10px;
		border-radius: 5px;
		font-size: 0.9rem;
	}

	.controls {
		position: absolute;
		bottom: 20px;
		display: flex;
		gap: 10px;
		background-color: rgba(0, 0, 0, 0.6);
		padding: 10px 15px;
		border-radius: 8px;
	}

	.control-button {
		background-color: #5865f2;
		color: white;
		border: none;
		padding: 10px 15px;
		border-radius: 5px;
		cursor: pointer;
		font-size: 1rem;
		transition: background-color 0.2s ease;
	}

	.control-button:hover {
		background-color: #4752c4;
	}

	.stop-share {
		background-color: #e74c3c;
	}

	.stop-share:hover {
		background-color: #c0392b;
	}

	.end-call {
		background-color: #e74c3c;
	}

	.end-call:hover {
		background-color: #c0392b;
	}
</style>