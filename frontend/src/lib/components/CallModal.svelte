<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { socket } from '$lib/socket';
	import {
		incomingCall,
		isInCall,
		isMuted,
		isVideoOff,
		activeCalls,
		answerCall,
		rejectCall,
		endCall,
		toggleMute,
		toggleVideo,
		getLocalStream,
		handleCallOffer,
		handleCallAnswer,
		handleCallIceCandidate,
		createCallOffer
	} from '$lib/calling';
	import { showCallNotification, playCallRingtone } from '$lib/notifications';

	let localVideoElement: HTMLVideoElement;
	let remoteVideoElements: Record<string, HTMLVideoElement> = {};
	let callNotification: Notification | null = null;

	$: if ($incomingCall) {
		playRingtone();
		// Show desktop notification with answer/reject buttons
		callNotification = showCallNotification(
			$incomingCall.username,
			$incomingCall.isVideoCall,
			() => handleAnswer(),
			() => handleReject()
		);
	} else {
		// Clear notification when call ends
		if (callNotification) {
			callNotification.close();
			callNotification = null;
		}
	}

	onMount(() => {
		if (!$socket) return;

		// Listen for call events
		$socket.on('call-incoming', (data: { userId: string; username: string; isVideoCall: boolean }) => {
			incomingCall.set({
				userId: data.userId,
				username: data.username,
				isVideoCall: data.isVideoCall
			});
		});

		$socket.on('call-accepted', async (data: { userId: string; isVideoCall: boolean }) => {
			// Start WebRTC connection
			await createCallOffer($socket!, data.userId);
		});

		$socket.on('call-rejected', (data: { userId: string }) => {
			alert('Call was rejected');
			endCall($socket!);
		});

		$socket.on('call-ended', (data: { userId: string }) => {
			endCall($socket!);
		});

		$socket.on('call-offer', async (data: { offer: RTCSessionDescriptionInit; senderId: string }) => {
			const call = $activeCalls.find(c => c.userId === data.senderId) || $incomingCall;
			const username = call ? (call as any).username : 'Unknown';
			await handleCallOffer($socket!, data.senderId, username, data.offer);
		});

		$socket.on('call-answer-sdp', async (data: { answer: RTCSessionDescriptionInit; senderId: string }) => {
			await handleCallAnswer(data.senderId, data.answer);
		});

		$socket.on('call-ice-candidate', async (data: { candidate: RTCIceCandidateInit; senderId: string }) => {
			await handleCallIceCandidate(data.senderId, data.candidate);
		});
	});

	onDestroy(() => {
		if ($socket) {
			$socket.off('call-incoming');
			$socket.off('call-accepted');
			$socket.off('call-rejected');
			$socket.off('call-ended');
			$socket.off('call-offer');
			$socket.off('call-answer-sdp');
			$socket.off('call-ice-candidate');
		}
	});

	$: if ($isInCall && localVideoElement) {
		const stream = getLocalStream();
		if (stream) {
			localVideoElement.srcObject = stream;
		}
	}

	$: if ($activeCalls.length > 0) {
		$activeCalls.forEach(call => {
			const videoElement = remoteVideoElements[call.userId];
			if (videoElement && call.stream) {
				videoElement.srcObject = call.stream;
			}
		});
	}

	function playRingtone() {
		// Play ringtone sound
		playCallRingtone();
	}

	async function handleAnswer() {
		if (!$incomingCall || !$socket) return;
		await answerCall($socket, $incomingCall.userId, $incomingCall.isVideoCall);
	}

	function handleReject() {
		if (!$incomingCall || !$socket) return;
		rejectCall($socket, $incomingCall.userId);
	}

	function handleEndCall() {
		if (!$socket) return;
		endCall($socket);
	}

	function handleToggleMute() {
		toggleMute();
	}

	function handleToggleVideo() {
		toggleVideo();
	}
</script>

<!-- Incoming Call Modal -->
{#if $incomingCall}
	<div class="call-modal-overlay">
		<div class="incoming-call-modal">
			<div class="caller-info">
				<div class="caller-avatar">
					{$incomingCall.username.charAt(0).toUpperCase()}
				</div>
				<h2>{$incomingCall.username}</h2>
				<p class="call-type">
					{$incomingCall.isVideoCall ? '📹 Video' : '📞 Voice'} Call
				</p>
			</div>
			<div class="call-actions">
				<button class="answer-btn" on:click={handleAnswer}>
					<span class="btn-icon">📞</span>
					Answer
				</button>
				<button class="reject-btn" on:click={handleReject}>
					<span class="btn-icon">✖️</span>
					Decline
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Active Call UI -->
{#if $isInCall}
	<div class="active-call-container">
		<div class="video-grid">
			<!-- Local video -->
			<div class="video-wrapper local-video">
				<!-- svelte-ignore a11y-media-has-caption -->
				<video
					bind:this={localVideoElement}
					autoplay
					muted
					playsinline
					class="video-element"
					class:video-hidden={$isVideoOff}
				></video>
				{#if $isVideoOff}
					<div class="video-placeholder">
						<span class="placeholder-icon">📹</span>
						<span>Camera Off</span>
					</div>
				{/if}
				<div class="video-label">You</div>
			</div>

			<!-- Remote videos -->
			{#each $activeCalls as call (call.userId)}
				<div class="video-wrapper remote-video">
					<!-- svelte-ignore a11y-media-has-caption -->
					<video
						bind:this={remoteVideoElements[call.userId]}
						autoplay
						playsinline
						class="video-element"
						class:video-hidden={!call.isVideoEnabled}
					></video>
					{#if !call.isVideoEnabled}
						<div class="video-placeholder">
							<span class="placeholder-icon">👤</span>
							<span>{call.username || 'User'}</span>
						</div>
					{/if}
					<div class="video-label">{call.username || 'User'}</div>
				</div>
			{/each}
		</div>

		<div class="call-controls">
			<button
				class="control-btn"
				class:active={$isMuted}
				on:click={handleToggleMute}
				title={$isMuted ? 'Unmute' : 'Mute'}
			>
				<span class="control-icon">{$isMuted ? '🔇' : '🎤'}</span>
			</button>

			<button
				class="control-btn"
				class:active={$isVideoOff}
				on:click={handleToggleVideo}
				title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}
			>
				<span class="control-icon">{$isVideoOff ? '📹' : '📷'}</span>
			</button>

			<button class="control-btn end-call-btn" on:click={handleEndCall} title="End call">
				<span class="control-icon">📞</span>
			</button>
		</div>
	</div>
{/if}

<style>
	.call-modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
		backdrop-filter: blur(8px);
	}

	.incoming-call-modal {
		background: white;
		border-radius: 16px;
		padding: 2rem;
		width: 90%;
		max-width: 400px;
		box-shadow: none;
		animation: slideUp 0.3s ease-out;
	}

	@keyframes slideUp {
		from {
			transform: translateY(100px);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	.caller-info {
		text-align: center;
		margin-bottom: 2rem;
	}

	.caller-avatar {
		width: 100px;
		height: 100px;
		border-radius: 50%;
		background: var(--accent);
		color: white;
		font-size: 3rem;
		font-weight: bold;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto 1rem;
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.05);
		}
	}

	.caller-info h2 {
		margin: 0 0 0.5rem;
		font-size: 1.5rem;
		color: var(--modal-text);
	}

	.call-type {
		color: var(--modal-text-secondary);
		font-size: 1rem;
		margin: 0;
	}

	.call-actions {
		display: flex;
		gap: 1rem;
		justify-content: center;
	}

	.answer-btn,
	.reject-btn {
		flex: 1;
		padding: 1rem;
		border: none;
		border-radius: 12px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.answer-btn {
		background: var(--color-success);
		color: white;
	}

	.answer-btn:hover {
		background: var(--color-success-hover);
		transform: translateY(-2px);
	}

	.reject-btn {
		background: var(--color-danger-hover);
		color: white;
	}

	.reject-btn:hover {
		background: var(--color-danger-dark);
		transform: translateY(-2px);
	}

	.btn-icon {
		font-size: 1.25rem;
	}

	.active-call-container {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--dark-bg-primary);
		z-index: 1500;
		display: flex;
		flex-direction: column;
	}

	.video-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 1rem;
		padding: 1rem;
		overflow-y: auto;
	}

	.video-wrapper {
		position: relative;
		background: var(--dark-bg-secondary);
		border-radius: 12px;
		overflow: hidden;
		aspect-ratio: 16 / 9;
	}

	.local-video {
		max-width: 300px;
		position: absolute;
		bottom: 1rem;
		right: 1rem;
		z-index: 10;
		border: none;
	}

	.video-element {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.video-hidden {
		display: none;
	}

	.video-placeholder {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: var(--modal-text);
		color: white;
		gap: 0.5rem;
	}

	.placeholder-icon {
		font-size: 3rem;
	}

	.video-label {
		position: absolute;
		bottom: 0.75rem;
		left: 0.75rem;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.call-controls {
		display: flex;
		gap: 1rem;
		padding: 1.5rem;
		background: var(--dark-bg-secondary);
		justify-content: center;
		border-top: 1px solid var(--modal-text);
	}

	.control-btn {
		width: 60px;
		height: 60px;
		border-radius: 50%;
		border: none;
		background: var(--modal-text);
		color: white;
		font-size: 1.5rem;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.control-btn:hover {
		background: var(--modal-text-secondary);
		transform: scale(1.1);
	}

	.control-btn.active {
		background: var(--color-danger-hover);
	}

	.end-call-btn {
		background: var(--color-danger-hover);
	}

	.end-call-btn:hover {
		background: var(--color-danger-dark);
	}

	.control-icon {
		display: block;
	}
</style>
