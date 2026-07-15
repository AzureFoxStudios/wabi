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
		callOfflineNotice,
		spatialAudioRuntimeStatus,
		spatialAudioDiagnostics,
		spatialSeatDebugState,
		stopScreenShare,
		endCall,
		toggleMute,
		toggleDeafen,
		toggleVideo
	} from '$lib/calling';
	import { getSocket, users, currentUser } from '$lib/socket';
	import { fade, scale } from 'svelte/transition';
	import type { SpatialPosition } from '$lib/audio/spatialEngine';

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
	let showSpatialDebugOverlay = false;
	$: if (!$isInCall && showSpatialDebugOverlay) {
		showSpatialDebugOverlay = false;
	}

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

	function toggleSpatialDebugOverlay(): void {
		showSpatialDebugOverlay = !showSpatialDebugOverlay;
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function debugSeatStyle(position: SpatialPosition): string {
		const left = clamp(50 + (position.x / 4) * 42, 8, 92);
		const top = clamp(50 + (position.z / 4) * 42, 8, 92);
		return `left:${left}%; top:${top}%;`;
	}
</script>

{#if hasActiveMedia}
	<div class="media-overlay" transition:fade={{ duration: 200 }}>
		{#if $callOfflineNotice}
			<div class="call-offline-banner" transition:fade={{ duration: 160 }}>
				{$callOfflineNotice}
				<button
					class="call-offline-dismiss"
					on:click={() => callOfflineNotice.set(null)}
					title="Dismiss"
				>×</button>
			</div>
		{/if}
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
						<div
							class="participant-thumb"
							class:speaking={participant.isSpeaking && !participant.isLocal}
							transition:scale={{ duration: 200 }}
						>
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
									style="--avatar-color: {getAvatarColor(participant.username)}"
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
						<div
							class="participant-thumb"
							class:speaking={participant.isSpeaking && !participant.isLocal}
							transition:scale={{ duration: 200 }}
						>
							<div
								class="avatar-thumb"
								style="--avatar-color: {getAvatarColor(participant.username)}"
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
									style="--avatar-color: {getAvatarColor($currentUser?.username || 'You')}"
								>
									{getInitials($currentUser?.username || 'You')}
								</div>
							</div>
						{/if}
						<div class="pip-label">{$currentUser?.username || 'You'}</div>
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
										style="--avatar-color: {getAvatarColor(call.username)}"
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
							style="--avatar-color: {getAvatarColor(participant.username)}"
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

		{#if showSpatialDebugOverlay && $isInCall}
			<div class="spatial-debug-overlay" transition:fade={{ duration: 140 }}>
				<div class="spatial-debug-header">
					<strong>Spatial Debug</strong>
					<span>{$spatialSeatDebugState.entries.length} sources</span>
				</div>
				<div class="spatial-debug-map">
					<div class="spatial-debug-center" aria-hidden="true"></div>
					{#each $spatialSeatDebugState.entries as seat (seat.sourceId)}
						<div
							class="spatial-seat"
							class:share={seat.sourceType === 'share'}
							class:speaking={seat.isSpeaking}
							style={debugSeatStyle(seat.position)}
							title={`${seat.username} (${seat.sourceType}) seat ${seat.seatIndex + 1}/${seat.slotCount}`}
						>
							{seat.username.charAt(0).toUpperCase()}
						</div>
					{/each}
				</div>
				<div class="spatial-debug-list">
					{#each $spatialSeatDebugState.entries as seat (seat.sourceId)}
						<div class="spatial-debug-row">
							<span class="spatial-debug-type">{seat.sourceType}</span>
							<span>{seat.username}</span>
							<span>S{seat.seatIndex + 1}/{seat.slotCount}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Controls bar -->
		<div class="controls-bar">
			<div class="transport-badge" class:degraded={$callTransportState.isFallback}>
				Transport: {$callTransportState.activeTransport.toUpperCase()}
				{#if $callTransportState.isFallback}
					<span class="transport-note">fallback active</span>
				{/if}
				{#if $callTransportState.gatewayControlPlaneStatus !== 'idle'}
					<span class="transport-note">gateway {$callTransportState.gatewayControlPlaneStatus}</span>
				{/if}
				{#if $callTransportState.gatewayMediaPlaneStatus !== 'idle'}
					<span class="transport-note">media {$callTransportState.gatewayMediaPlaneStatus}</span>
				{/if}
				{#if $callTransportState.gatewayActiveStreams !== null}
					<span class="transport-note">streams {$callTransportState.gatewayActiveStreams}</span>
				{/if}
			</div>
			<div class="transport-badge">
				Spatial: {$spatialAudioRuntimeStatus.effectiveMode.toUpperCase()}
				<span class="transport-note">src {$spatialAudioDiagnostics.totalSources}</span>
			</div>

			{#if $connectionState && $connectionState !== 'idle' && $connectionState !== 'connected'}
				<div class="connection-badge" class:warning={$connectionState === 'connecting' || $connectionState === 'signaling'} class:error={$connectionState === 'failed'}>
					{$connectionState}
				</div>
			{/if}

			<div class="controls-group">
				{#if $isInCall}
					<button
						class="control-btn debug-toggle"
						class:active={showSpatialDebugOverlay}
						on:click={toggleSpatialDebugOverlay}
						title="Spatial Debug Overlay"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="9"></circle>
							<circle cx="12" cy="12" r="2"></circle>
							<path d="M12 3v2M12 19v2M3 12h2M19 12h2"></path>
						</svg>
					</button>

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
	.call-offline-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		background: rgba(180, 30, 30, 0.92);
		color: #fff;
		font-size: 0.8rem;
		font-weight: 600;
	}
	.call-offline-dismiss {
		background: transparent;
		border: none;
		color: #fff;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.25rem;
	}
</style>

