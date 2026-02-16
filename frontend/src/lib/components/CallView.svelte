<script lang="ts">
	import {
		screenShares,
		activeCalls,
		isSharing,
		isInCall,
		isMuted,
		isDeafened,
		isVideoOff,
		isLocalSpeaking,
		localStream,
		localScreenStream,
		connectionState,
		callTransportState,
		stopScreenShare,
		endCall,
		toggleMute,
		toggleDeafen,
		toggleVideo
	} from '$lib/calling';
	import { getSocket, users, currentUser } from '$lib/socket';
	import { fade, scale } from 'svelte/transition';

	// Determine layout mode based on active media
	$: layoutMode = determineLayoutMode($screenShares.length, $activeCalls.length);

	type LayoutMode = 'empty' | 'screen-focus' | 'screen-split' | 'video-grid' | 'voice-grid';

	function determineLayoutMode(screenShareCount: number, callCount: number): LayoutMode {
		if (screenShareCount === 0 && callCount === 0 && !$isSharing && !$isInCall) {
			return 'empty';
		}
		if (screenShareCount === 1) {
			return 'screen-focus';
		}
		if (screenShareCount >= 2) {
			return 'screen-split';
		}
		// No screen shares, check for video calls
		const hasVideo = $activeCalls.some(c => c.isVideoEnabled) || ($isInCall && !$isVideoOff);
		if (hasVideo) {
			return 'video-grid';
		}
		return 'voice-grid';
	}

	$: hasActiveMedia = $activeCalls.length > 0 || $screenShares.length > 0 || $isSharing || $isInCall;

	// Get participants for voice-only display
	$: participants = getParticipants();

	function getParticipants() {
		const result: { id: string; username: string; isLocal: boolean; isSpeaking: boolean; stream?: MediaStream }[] = [];

		// Add local user if in call
		if ($isInCall && $currentUser) {
			result.push({
				id: $currentUser.id,
				username: $currentUser.username,
				isLocal: true,
				isSpeaking: $isLocalSpeaking && !$isMuted && !$isDeafened,
				stream: $localStream || undefined
			});
		}

		// Add remote participants
		for (const call of $activeCalls) {
			result.push({
				id: call.userId,
				username: call.username || 'Unknown',
				isLocal: false,
				isSpeaking: call.isSpeaking && call.isAudioEnabled,
				stream: call.stream
			});
		}

		return result;
	}

	function handleStopScreenShare() {
		const sock = getSocket();
		if (sock) {
			stopScreenShare(sock);
		}
	}

	function handleEndCall() {
		const sock = getSocket();
		if (sock) {
			endCall(sock);
		}
	}

	function handleToggleMute() {
		toggleMute();
	}

	function handleToggleDeafen() {
		toggleDeafen();
	}

	async function handleToggleVideo() {
		const sock = getSocket();
		await toggleVideo(sock || undefined);
	}

	// Get initials for avatar
	function getInitials(username: string): string {
		return username.charAt(0).toUpperCase();
	}

	// Generate consistent color from username
	function getAvatarColor(username: string): string {
		const colors = [
			'#e74c3c', '#3498db', '#2ecc71', '#9b59b6',
			'#f39c12', '#1abc9c', '#e91e63', '#00bcd4'
		];
		let hash = 0;
		for (let i = 0; i < username.length; i++) {
			hash = username.charCodeAt(i) + ((hash << 5) - hash);
		}
		return colors[Math.abs(hash) % colors.length];
	}

	function streamBinding(node: HTMLVideoElement, stream?: MediaStream) {
		node.srcObject = stream ?? null;
		return {
			update(nextStream?: MediaStream) {
				node.srcObject = nextStream ?? null;
			},
			destroy() {
				node.srcObject = null;
			}
		};
	}
</script>

{#if hasActiveMedia}
	<div class="media-overlay" transition:fade={{ duration: 200 }}>
		<!-- Screen Share Focus Mode (1 screen share) -->
		{#if layoutMode === 'screen-focus'}
			<div class="layout-focus">
				<div class="main-content">
					{#each $screenShares as share (share.userId)}
						<div class="screen-share-main" transition:scale>
							<video
								autoplay
								playsinline
								muted={$isDeafened}
								use:streamBinding={share.stream}
							></video>
							<div class="stream-label">{share.username}'s Screen</div>
						</div>
					{/each}
				</div>

				<!-- Participant strip at bottom -->
				<div class="participant-strip">
					{#each participants as participant (participant.id)}
						<div class="participant-thumb" class:speaking={participant.isSpeaking && !participant.isLocal}>
							{#if participant.stream && participant.stream.getVideoTracks().length > 0}
								<video
									autoplay
									playsinline
									muted={participant.isLocal || $isDeafened}
									use:streamBinding={participant.stream}
								></video>
							{:else}
								<div
									class="avatar-thumb"
									style="background-color: {getAvatarColor(participant.username)}"
								>
									{getInitials(participant.username)}
								</div>
							{/if}
							<span class="thumb-name">{participant.isLocal ? 'You' : participant.username}</span>
							{#if participant.isLocal && $isMuted}
								<span class="muted-indicator">Muted</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Screen Share Split Mode (2+ screen shares) -->
		{#if layoutMode === 'screen-split'}
			<div class="layout-split">
				<div class="screens-grid">
					{#each $screenShares as share (share.userId)}
						<div class="screen-share-tile" transition:scale>
							<video
								autoplay
								playsinline
								muted={$isDeafened}
								use:streamBinding={share.stream}
							></video>
							<div class="stream-label">{share.username}'s Screen</div>
						</div>
					{/each}
				</div>

				<div class="participant-strip">
					{#each participants as participant (participant.id)}
						<div class="participant-thumb" class:speaking={participant.isSpeaking && !participant.isLocal}>
							<div
								class="avatar-thumb"
								style="background-color: {getAvatarColor(participant.username)}"
							>
								{getInitials(participant.username)}
							</div>
							<span class="thumb-name">{participant.isLocal ? 'You' : participant.username}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Video Grid Mode -->
		{#if layoutMode === 'video-grid'}
			<div class="layout-video-grid">
				<!-- Local video (picture-in-picture style) -->
				{#if $isInCall && $localStream}
					<div class="local-video-pip" transition:scale>
						<video
							autoplay
							playsinline
							muted
							use:streamBinding={$localStream}
							class:hidden={$isVideoOff}
						></video>
						{#if $isVideoOff}
							<div class="video-off-placeholder">
								<div
									class="avatar-large"
									style="background-color: {getAvatarColor($currentUser?.username || 'You')}"
								>
									{getInitials($currentUser?.username || 'You')}
								</div>
							</div>
						{/if}
						<div class="pip-label">You</div>
					</div>
				{/if}

				<!-- Remote videos -->
				<div class="remote-videos">
					{#each $activeCalls as call (call.userId)}
						<div class="video-tile" class:speaking={call.isSpeaking && call.isAudioEnabled && !$isDeafened} transition:scale>
							<video
								autoplay
								playsinline
								muted={$isDeafened}
								use:streamBinding={call.stream}
								class:hidden={!call.isVideoEnabled}
							></video>
							{#if !call.isVideoEnabled}
								<div class="video-off-placeholder">
									<div
										class="avatar-large"
										style="background-color: {getAvatarColor(call.username)}"
									>
										{getInitials(call.username)}
									</div>
								</div>
							{/if}
							<div class="stream-label">{call.username}</div>
							{#if !call.isAudioEnabled}
								<div class="muted-badge">Muted</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Voice Only Grid Mode -->
		{#if layoutMode === 'voice-grid'}
			<div class="layout-voice-grid">
				{#each participants as participant (participant.id)}
					<div
						class="voice-tile"
						class:speaking={participant.isSpeaking && !participant.isLocal && !$isDeafened}
						transition:scale
					>
						<div
							class="avatar-voice"
							style="background-color: {getAvatarColor(participant.username)}"
						>
							{getInitials(participant.username)}
						</div>
						<span class="voice-name">{participant.isLocal ? 'You' : participant.username}</span>
						<div class="voice-status">
							{#if participant.isLocal && $isMuted}
								<span class="status-muted">Muted</span>
							{:else if participant.isSpeaking}
								<span class="status-speaking">Speaking</span>
							{:else}
								<span class="status-silent">Silent</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Controls bar -->
		<div class="controls-bar">
			<div class="transport-badge" class:degraded={$callTransportState.isFallback}>
				Transport: {$callTransportState.activeTransport.toUpperCase()}
				{#if $callTransportState.isFallback}
					<span class="transport-note">fallback active</span>
				{/if}
			</div>

			{#if $connectionState && $connectionState !== 'idle' && $connectionState !== 'connected'}
				<div class="connection-badge" class:warning={$connectionState === 'connecting' || $connectionState === 'signaling'} class:error={$connectionState === 'failed'}>
					{$connectionState}
				</div>
			{/if}

			<div class="controls-group">
				{#if $isInCall}
					<button
						class="control-btn"
						class:active={$isMuted}
						on:click={handleToggleMute}
						title={$isMuted ? 'Unmute' : 'Mute'}
					>
						{#if $isMuted}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="1" y1="1" x2="23" y2="23"></line>
								<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
								<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
								<line x1="12" y1="19" x2="12" y2="23"></line>
								<line x1="8" y1="23" x2="16" y2="23"></line>
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
								<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
								<line x1="12" y1="19" x2="12" y2="23"></line>
								<line x1="8" y1="23" x2="16" y2="23"></line>
							</svg>
						{/if}
					</button>

					<button
						class="control-btn"
						class:active={$isDeafened}
						on:click={handleToggleDeafen}
						title={$isDeafened ? 'Undeafen' : 'Deafen'}
					>
						{#if $isDeafened}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="1" y1="1" x2="23" y2="23"></line>
								<path d="M9 4.5A3 3 0 0 1 12 2a3 3 0 0 1 3 3c0 0.99-.48 1.87-1.22 2.42"></path>
								<path d="M8 8H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1l4 4V8z"></path>
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
								<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
							</svg>
						{/if}
					</button>

					<button
						class="control-btn"
						class:active={$isVideoOff}
						on:click={handleToggleVideo}
						title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}
					>
						{#if $isVideoOff}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<line x1="1" y1="1" x2="23" y2="23"></line>
								<path d="M21 7l-5 5 5 5V7z"></path>
								<rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M23 7l-7 5 7 5V7z"></path>
								<rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
							</svg>
						{/if}
					</button>
				{/if}

				{#if $isSharing}
					<button
						class="control-btn stop-share"
						on:click={handleStopScreenShare}
						title="Stop Screen Share"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
							<line x1="8" y1="21" x2="16" y2="21"></line>
							<line x1="12" y1="17" x2="12" y2="21"></line>
							<line x1="7" y1="7" x2="17" y2="13"></line>
							<line x1="17" y1="7" x2="7" y2="13"></line>
						</svg>
						Stop Share
					</button>
				{/if}

				{#if $isInCall}
					<button
						class="control-btn end-call"
						on:click={handleEndCall}
						title="End Call"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
							<line x1="1" y1="1" x2="23" y2="23"></line>
						</svg>
						End Call
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.media-overlay {
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		height: 100dvh;
		background-color: var(--bg-primary, #1a1a2e);
		z-index: 1500;
		display: flex;
		flex-direction: column;
	}

	/* Layout: Focus (1 screen share) */
	.layout-focus {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.main-content {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}

	.screen-share-main {
		position: relative;
		width: 100%;
		max-width: 1200px;
		aspect-ratio: 16 / 9;
		background: #000;
		border-radius: 8px;
		overflow: hidden;
	}

	.screen-share-main video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.participant-strip {
		display: flex;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--bg-secondary, #16213e);
		overflow-x: auto;
		justify-content: center;
	}

	.participant-thumb {
		position: relative;
		width: 80px;
		height: 80px;
		border-radius: 8px;
		overflow: hidden;
		background: var(--bg-tertiary, #0f3460);
		flex-shrink: 0;
	}

	.participant-thumb.speaking {
		box-shadow: 0 0 0 3px var(--accent, #4ade80);
	}

	.participant-thumb video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.avatar-thumb {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 600;
		color: white;
	}

	.thumb-name {
		position: absolute;
		bottom: 4px;
		left: 4px;
		right: 4px;
		font-size: 0.7rem;
		color: white;
		background: rgba(0, 0, 0, 0.7);
		padding: 2px 4px;
		border-radius: 4px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
	}

	.muted-indicator {
		position: absolute;
		top: 4px;
		right: 4px;
		font-size: 0.6rem;
		background: var(--color-danger, #ef4444);
		color: white;
		padding: 2px 4px;
		border-radius: 4px;
	}

	/* Layout: Split (2+ screen shares) */
	.layout-split {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.screens-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
		gap: 1rem;
		padding: 1rem;
	}

	.screen-share-tile {
		position: relative;
		background: #000;
		border-radius: 8px;
		overflow: hidden;
	}

	.screen-share-tile video {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	/* Layout: Video Grid */
	.layout-video-grid {
		flex: 1;
		display: flex;
		flex-direction: column;
		position: relative;
	}

	.local-video-pip {
		position: absolute;
		bottom: 100px;
		right: 1rem;
		width: 200px;
		aspect-ratio: 16 / 9;
		background: var(--bg-secondary, #16213e);
		border-radius: 8px;
		overflow: hidden;
		z-index: 10;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	}

	.local-video-pip video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.local-video-pip video.hidden {
		display: none;
	}

	.pip-label {
		position: absolute;
		bottom: 4px;
		left: 4px;
		font-size: 0.75rem;
		color: white;
		background: rgba(0, 0, 0, 0.7);
		padding: 2px 8px;
		border-radius: 4px;
	}

	.remote-videos {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 1rem;
		padding: 1rem;
		align-content: center;
	}

	.video-tile {
		position: relative;
		background: var(--bg-secondary, #16213e);
		border-radius: 8px;
		overflow: hidden;
		aspect-ratio: 16 / 9;
	}

	.video-tile.speaking {
		box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.5);
	}

	.video-tile video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.video-tile video.hidden {
		display: none;
	}

	.video-off-placeholder {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-tertiary, #0f3460);
	}

	.avatar-large {
		width: 80px;
		height: 80px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 2rem;
		font-weight: 600;
		color: white;
	}

	.stream-label {
		position: absolute;
		bottom: 8px;
		left: 8px;
		font-size: 0.875rem;
		color: white;
		background: rgba(0, 0, 0, 0.7);
		padding: 4px 8px;
		border-radius: 4px;
	}

	.muted-badge {
		position: absolute;
		top: 8px;
		right: 8px;
		font-size: 0.75rem;
		background: var(--color-danger, #ef4444);
		color: white;
		padding: 4px 8px;
		border-radius: 4px;
	}

	/* Layout: Voice Grid */
	.layout-voice-grid {
		flex: 1;
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		padding: 2rem;
		align-content: center;
		justify-content: center;
	}

	.voice-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem;
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		min-width: 120px;
		transition: box-shadow 0.2s;
	}

	.voice-tile.speaking {
		box-shadow: 0 0 0 3px var(--accent, #4ade80);
	}

	.avatar-voice {
		width: 64px;
		height: 64px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 600;
		color: white;
	}

	.voice-name {
		font-size: 0.875rem;
		color: var(--text-primary, #fff);
		font-weight: 500;
	}

	.voice-status {
		font-size: 0.75rem;
	}

	.status-muted {
		color: var(--color-danger, #ef4444);
	}

	.status-speaking {
		color: var(--accent, #4ade80);
	}

	.status-silent {
		color: var(--text-secondary, #888);
	}

	/* Controls Bar */
	.controls-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 1rem;
		padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		background: var(--bg-secondary, #16213e);
		border-top: 1px solid var(--border, #333);
	}

	.transport-badge {
		padding: 0.35rem 0.65rem;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		background: rgba(16, 185, 129, 0.18);
		color: #ecfdf5;
		border: 1px solid rgba(16, 185, 129, 0.45);
	}

	.transport-badge.degraded {
		background: rgba(245, 158, 11, 0.2);
		border-color: rgba(245, 158, 11, 0.55);
		color: #fffbeb;
	}

	.transport-note {
		margin-left: 0.35rem;
		font-weight: 600;
		text-transform: none;
	}

	.connection-badge {
		position: absolute;
		left: 1rem;
		font-size: 0.75rem;
		padding: 4px 8px;
		border-radius: 4px;
		text-transform: capitalize;
	}

	.connection-badge.warning {
		background: var(--color-warning, #f59e0b);
		color: #000;
	}

	.connection-badge.error {
		background: var(--color-danger, #ef4444);
		color: #fff;
	}

	.controls-group {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.control-btn {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		border: none;
		background: var(--bg-tertiary, #0f3460);
		color: white;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.control-btn:hover {
		background: var(--bg-hover, #1a4a7a);
		transform: scale(1.05);
	}

	.control-btn.active {
		background: var(--color-danger, #ef4444);
	}

	.control-btn svg {
		width: 20px;
		height: 20px;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.control-btn.stop-share,
	.control-btn.end-call {
		width: auto;
		border-radius: 24px;
		padding: 0 1rem;
		gap: 0.5rem;
		background: var(--color-danger, #ef4444);
		font-size: 0.875rem;
		font-weight: 500;
	}

	.control-btn.stop-share:hover,
	.control-btn.end-call:hover {
		background: var(--color-danger-hover, #dc2626);
	}

	.control-btn.stop-share svg,
	.control-btn.end-call svg {
		width: 18px;
		height: 18px;
	}

	@media (max-width: 768px) {
		.remote-videos {
			grid-template-columns: 1fr;
		}

		.screens-grid {
			grid-template-columns: 1fr;
		}

		.local-video-pip {
			width: 120px;
			bottom: 80px;
		}

		.control-btn {
			width: 44px;
			height: 44px;
			min-width: 44px;
			min-height: 44px;
		}

		.control-btn svg {
			width: 18px;
			height: 18px;
		}
	}
</style>
