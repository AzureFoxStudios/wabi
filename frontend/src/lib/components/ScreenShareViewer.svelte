<script lang="ts">
	import { socket, getSocket } from '$lib/socket';
	import {
		screenShares,
		isSharing,
		startScreenShare,
		stopScreenShare
	} from '$lib/webrtc';
	import { playNotificationSound } from '$lib/notifications';

	export let activeView: 'chat' | 'screen' = 'screen';

	let localStream: MediaStream | null = null;
	let error = '';
	let localVideoElement: HTMLVideoElement;
	let previousShareCount = 0;

	function backToChat() {
		activeView = 'chat';
	}

	async function handleStartShare() {
		try {
			const sock = getSocket();
			if (!sock) return;

			localStream = await startScreenShare(sock);
			console.log('Screen share started, stream:', localStream);
			error = '';
		} catch (err) {
			error = 'Failed to start screen sharing. Please grant permissions.';
			console.error('Screen share error:', err);
		}
	}

	function handleStopShare() {
		const sock = getSocket();
		if (!sock) return;
		stopScreenShare(sock);
		localStream = null;
	}

	// Reactive statement to update video srcObject when localStream changes
	$: if (localVideoElement && localStream) {
		localVideoElement.srcObject = localStream;
		localVideoElement.play().catch(err => console.error('Error playing local video:', err));
	}

	// React to new screen shares being added (handled centrally by SocketManager)
	$: if ($screenShares.length > previousShareCount && previousShareCount >= 0) {
		// New screen share detected
		if (previousShareCount > 0) {
			playNotificationSound();
			activeView = 'screen';

			// Show browser notification if document is not focused
			if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
				const newestShare = $screenShares[$screenShares.length - 1];
				new Notification('Screen Share Started', {
					body: `${newestShare?.username || 'Someone'} is sharing their screen`,
					icon: '/icon-192.png'
				});
			}
		}
		previousShareCount = $screenShares.length;
	} else {
		previousShareCount = $screenShares.length;
	}

	// Custom Svelte action to set srcObject on video elements
	function setVideoStream(node: HTMLVideoElement, stream: MediaStream) {
		node.srcObject = stream;
		node.play().catch(err => console.error('Error playing remote video:', err));
		return {
			update(newStream: MediaStream) {
				node.srcObject = newStream;
				node.play().catch(err => console.error('Error playing updated remote video:', err));
			}
		};
	}

	// NOTE: All socket event listeners for WebRTC signaling are now handled
	// centrally in socket.ts (SocketManager). This component only handles UI.
</script>

<div class="screen-share-container">
	<div class="header">
		<div class="header-left">
			<button class="back-btn" on:click={backToChat} title="Back to chat">
				← Back
			</button>
			<h2>🖥️ Screen Sharing</h2>
		</div>
		{#if $isSharing}
			<button on:click={handleStopShare} class="stop-btn">
				Stop Sharing
			</button>
		{:else}
			<button on:click={handleStartShare}>
				Start Sharing
			</button>
		{/if}
	</div>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	<div class="screens">
		{#if $isSharing && localStream}
			<div class="screen-item">
				<div class="screen-header">
					<span class="badge">Your Screen</span>
				</div>
				<video
					bind:this={localVideoElement}
					autoplay
					muted
					playsinline
				></video>
			</div>
		{/if}

		{#each $screenShares as share (share.userId)}
			<div class="screen-item">
				<div class="screen-header">
					<span class="username">{share.username}'s Screen</span>
				</div>
				<video
					use:setVideoStream={share.stream}
					autoplay
					playsinline
				></video>
			</div>
		{/each}

		{#if !$isSharing && $screenShares.length === 0}
			<div class="empty-state">
				<p>No active screen shares</p>
				<p class="hint">Click "Start Sharing" to share your screen</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.screen-share-container {
		height: 100vh;
		display: flex;
		flex-direction: column;
		background: var(--bg-primary);
	}

	.header {
		padding: 1rem;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.header h2 {
		font-size: 1.25rem;
		margin: 0;
	}

	.back-btn {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		border: none;
		padding: 0.5rem 1rem;
		border-radius: 0;
		font-size: 0.9rem;
		cursor: pointer;
		transition: all 0.2s;
		font-weight: 500;
	}

	.back-btn:hover {
		background: var(--bg-hover);
		transform: translateX(-2px);
	}

	.stop-btn {
		background: var(--error);
	}

	.stop-btn:hover {
		background: var(--color-danger-hover);
	}

	.error {
		padding: 1rem;
		background: rgba(255, 74, 74, 0.1);
		color: var(--error);
		border-left: 3px solid var(--error);
		margin: 1rem;
	}

	.screens {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
		gap: 1rem;
		align-content: start;
	}

	.screen-item {
		background: var(--bg-secondary);
		border-radius: 0;
		overflow: hidden;
		border: none;
	}

	.screen-header {
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.badge {
		background: var(--accent);
		color: white;
		padding: 0.25rem 0.75rem;
		border-radius: 0;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.username {
		font-weight: 600;
		color: var(--accent);
	}

	video {
		width: 100%;
		aspect-ratio: 16 / 9;
		background: black;
		display: block;
	}

	.empty-state {
		grid-column: 1 / -1;
		text-align: center;
		padding: 4rem 2rem;
		color: var(--text-secondary);
	}

	.empty-state p {
		margin-bottom: 0.5rem;
	}

	.hint {
		font-size: 0.85rem;
		color: var(--text-secondary);
		opacity: 0.7;
	}
</style>
