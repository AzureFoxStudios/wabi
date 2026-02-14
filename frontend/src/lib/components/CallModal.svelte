<script lang="ts">
	import { socket, getSocket } from '$lib/socket';
	import {
		incomingCall,
		isInCall,
		isMuted,
		isDeafened,
		isVideoOff,
		activeCalls,
		screenShares,
		isSharing,
		localScreenStream,
		answerCall,
		rejectCall,
		endCall,
		toggleMute,
		toggleDeafen,
		toggleVideo,
		startScreenShare,
		stopScreenShare,
		localStream,
		connectionState
	} from '$lib/calling';
	import { showCallNotification, playCallRingtone, stopCallRingtone } from '$lib/notifications';
	import { onDestroy } from 'svelte';

	// ---- Tile types ----
	interface Tile {
		id: string;
		kind: 'screen-share' | 'video' | 'avatar' | 'local-screen' | 'local-camera';
		label: string;
		stream: MediaStream | null;
		userId: string | null;
		isVideoEnabled: boolean;
	}

	let localVideoElement: HTMLVideoElement;
	let remoteVideoElements: Record<string, HTMLVideoElement> = {};
	let callNotification: Notification | null = null;
	let focusedTileId: string | null = null;

	// ---- Layout mode ----
	type LayoutMode = 'voice-only' | 'video-call' | 'tiled' | 'focused';

	function determineLayout(
		shares: typeof $screenShares,
		calls: typeof $activeCalls,
		sharing: boolean,
		focused: string | null
	): LayoutMode {
		if (focused !== null) return 'focused';
		if (shares.length > 0 || sharing) return 'tiled';
		if (calls.some(c => c.isVideoEnabled) || !$isVideoOff) return 'video-call';
		return 'voice-only';
	}

	$: layoutMode = determineLayout($screenShares, $activeCalls, $isSharing, focusedTileId);

	// ---- Build tile list ----
	function buildTiles(
		shares: typeof $screenShares,
		calls: typeof $activeCalls,
		sharing: boolean,
		screenStream: MediaStream | null,
		myStream: MediaStream | null,
		videoOff: boolean
	): Tile[] {
		const tiles: Tile[] = [];

		// Remote screen shares first (most important)
		for (const s of shares) {
			tiles.push({
				id: `screen-${s.userId}`,
				kind: 'screen-share',
				label: `${s.username}'s Screen`,
				stream: s.stream,
				userId: s.userId,
				isVideoEnabled: true
			});
		}

		// Local screen share preview
		if (sharing && screenStream) {
			tiles.push({
				id: 'local-screen',
				kind: 'local-screen',
				label: 'Your Screen',
				stream: screenStream,
				userId: null,
				isVideoEnabled: true
			});
		}

		// Remote participant tiles
		for (const c of calls) {
			tiles.push({
				id: `call-${c.userId}`,
				kind: c.isVideoEnabled ? 'video' : 'avatar',
				label: c.username || 'User',
				stream: c.stream,
				userId: c.userId,
				isVideoEnabled: c.isVideoEnabled
			});
		}

		// Local camera tile
		tiles.push({
			id: 'local-camera',
			kind: !videoOff ? 'local-camera' : 'avatar',
			label: 'You',
			stream: myStream,
			userId: null,
			isVideoEnabled: !videoOff
		});

		return tiles;
	}

	$: tiles = buildTiles($screenShares, $activeCalls, $isSharing, $localScreenStream, $localStream, $isVideoOff);

	// Validate focusedTileId still exists
	$: if (focusedTileId && !tiles.find(t => t.id === focusedTileId)) {
		focusedTileId = null;
	}

	$: focusedTile = focusedTileId ? tiles.find(t => t.id === focusedTileId) ?? null : null;
	$: thumbnailTiles = focusedTileId ? tiles.filter(t => t.id !== focusedTileId) : [];

	// Focused mode navigation
	function focusPrev() {
		if (!focusedTileId) return;
		const idx = tiles.findIndex(t => t.id === focusedTileId);
		const prev = (idx - 1 + tiles.length) % tiles.length;
		focusedTileId = tiles[prev].id;
	}

	function focusNext() {
		if (!focusedTileId) return;
		const idx = tiles.findIndex(t => t.id === focusedTileId);
		const next = (idx + 1) % tiles.length;
		focusedTileId = tiles[next].id;
	}

	// ---- Incoming call handling ----
	$: if ($incomingCall) {
		playRingtone();
		callNotification = showCallNotification(
			$incomingCall.username,
			$incomingCall.isVideoCall,
			() => handleAnswer(),
			() => handleReject()
		);
	} else {
		stopCallRingtone();
		if (callNotification) {
			callNotification.close();
			callNotification = null;
		}
	}

	// ---- Bind video elements reactively ----
	$: if ($isInCall && localVideoElement && $localStream) {
		localVideoElement.srcObject = $localStream;
	}

	$: if ($activeCalls.length > 0) {
		$activeCalls.forEach(call => {
			const videoElement = remoteVideoElements[call.userId];
			if (videoElement && call.stream) {
				videoElement.srcObject = call.stream;
			}
		});
	}

	// ---- Bind tile video elements ----
	function bindTileVideo(node: HTMLVideoElement, stream: MediaStream | null) {
		if (stream) node.srcObject = stream;
		return {
			update(newStream: MediaStream | null) {
				if (newStream) node.srcObject = newStream;
			}
		};
	}

	function playRingtone() {
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
		focusedTileId = null;
	}

	function handleToggleMute() {
		toggleMute();
	}

	async function handleToggleVideo() {
		await toggleVideo($socket || undefined);
	}

	async function handleToggleScreenShare() {
		if (!$socket) return;
		if ($isSharing) {
			stopScreenShare($socket);
		} else {
			await startScreenShare($socket);
		}
	}

	function handleTileClick(tileId: string) {
		if (layoutMode === 'focused' && focusedTileId === tileId) {
			// Click focused tile again → back to tiled
			focusedTileId = null;
		} else {
			focusedTileId = tileId;
		}
	}

	// Keyboard: Escape exits focused mode
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && focusedTileId) {
			focusedTileId = null;
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

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
					{$incomingCall.isVideoCall ? 'Video' : 'Voice'} Call
				</p>
			</div>
			<div class="call-actions">
				<button class="answer-btn" on:click={handleAnswer}>
					Answer
				</button>
				<button class="reject-btn" on:click={handleReject}>
					Decline
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Active Call UI -->
{#if $isInCall}
	<div class="active-call-container">
		{#if layoutMode === 'voice-only' || layoutMode === 'video-call'}
			<!-- Original grid layout for voice/video calls without screen shares -->
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
							<div class="avatar-circle">You</div>
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
							muted={$isDeafened}
							class:video-hidden={!call.isVideoEnabled}
						></video>
						{#if !call.isVideoEnabled}
							<div class="video-placeholder">
								<div class="avatar-circle">{(call.username || 'U').charAt(0).toUpperCase()}</div>
								<span class="placeholder-name">{call.username || 'User'}</span>
							</div>
						{/if}
						<div class="video-label">{call.username || 'User'}</div>
					</div>
				{/each}
			</div>

		{:else if layoutMode === 'tiled'}
			<!-- Tiled layout: all tiles in auto-fit grid -->
			<div class="tile-grid">
				{#each tiles as tile (tile.id)}
					<button
						class="tile"
						class:tile-screen={tile.kind === 'screen-share' || tile.kind === 'local-screen'}
						on:click={() => handleTileClick(tile.id)}
					>
						{#if tile.kind === 'screen-share' || tile.kind === 'local-screen'}
							<!-- svelte-ignore a11y-media-has-caption -->
							<video
								class="tile-video tile-video-contain"
								autoplay
								playsinline
								muted={tile.kind === 'local-screen' || (tile.userId !== null && $isDeafened)}
								use:bindTileVideo={tile.stream}
							></video>
						{:else if tile.kind === 'video' || tile.kind === 'local-camera'}
							<!-- svelte-ignore a11y-media-has-caption -->
							<video
								class="tile-video"
								autoplay
								playsinline
								muted={tile.userId === null || $isDeafened}
								use:bindTileVideo={tile.stream}
							></video>
						{:else}
							<div class="tile-avatar">
								<div class="avatar-circle">{tile.label.charAt(0).toUpperCase()}</div>
							</div>
						{/if}
						<div class="tile-label">{tile.label}</div>
					</button>
				{/each}
			</div>

		{:else if layoutMode === 'focused' && focusedTile}
			<!-- Focused layout: one tile maximized, rest as thumbnails -->
			<div class="focused-layout">
				<div class="focused-main">
					<!-- Focused tile -->
					<button class="focused-tile" on:click={() => handleTileClick(focusedTile.id)}>
						{#if focusedTile.kind === 'screen-share' || focusedTile.kind === 'local-screen'}
							<!-- svelte-ignore a11y-media-has-caption -->
							<video
								class="focused-video focused-video-contain"
								autoplay
								playsinline
								muted={focusedTile.kind === 'local-screen' || (focusedTile.userId !== null && $isDeafened)}
								use:bindTileVideo={focusedTile.stream}
							></video>
						{:else if focusedTile.kind === 'video' || focusedTile.kind === 'local-camera'}
							<!-- svelte-ignore a11y-media-has-caption -->
							<video
								class="focused-video"
								autoplay
								playsinline
								muted={focusedTile.userId === null || $isDeafened}
								use:bindTileVideo={focusedTile.stream}
							></video>
						{:else}
							<div class="focused-avatar">
								<div class="avatar-circle avatar-circle-lg">{focusedTile.label.charAt(0).toUpperCase()}</div>
							</div>
						{/if}
						<div class="focused-label">{focusedTile.label}</div>
					</button>

					<!-- Overlay controls -->
					<div class="focused-controls-overlay">
						<button class="overlay-btn" on:click={focusPrev} title="Previous tile">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
						</button>
						<button class="overlay-btn" on:click={() => { focusedTileId = null; }} title="Back to tiles">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
						</button>
						<button class="overlay-btn" on:click={focusNext} title="Next tile">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
						</button>
					</div>
				</div>

				<!-- Thumbnail strip -->
				{#if thumbnailTiles.length > 0}
					<div class="thumbnail-strip">
						{#each thumbnailTiles as thumb (thumb.id)}
							<button
								class="thumbnail"
								on:click={() => handleTileClick(thumb.id)}
							>
								{#if thumb.kind === 'screen-share' || thumb.kind === 'local-screen' || thumb.kind === 'video' || thumb.kind === 'local-camera'}
									<!-- svelte-ignore a11y-media-has-caption -->
									<video
										class="thumbnail-video"
										autoplay
										playsinline
										muted={thumb.userId === null || $isDeafened}
										use:bindTileVideo={thumb.stream}
									></video>
								{:else}
									<div class="thumbnail-avatar">
										<div class="avatar-circle avatar-circle-sm">{thumb.label.charAt(0).toUpperCase()}</div>
									</div>
								{/if}
								<div class="thumbnail-label">{thumb.label}</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Controls bar -->
		<div class="call-controls">
			<button
				class="control-btn"
				class:active={$isMuted}
				on:click={handleToggleMute}
				title={$isMuted ? 'Unmute' : 'Mute'}
			>
				<svg class="control-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if $isMuted}
						<line x1="1" y1="1" x2="23" y2="23"></line>
						<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
					{:else}
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
					{/if}
				</svg>
			</button>

			<button
				class="control-btn"
				class:active={$isDeafened}
				on:click={() => toggleDeafen()}
				title={$isDeafened ? 'Undeafen' : 'Deafen'}
			>
				<svg class="control-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if $isDeafened}
						<line x1="1" y1="1" x2="23" y2="23"></line>
						<path d="M6 18.7V21a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2.3"></path>
						<path d="M18 9v3a6 6 0 0 1-.3 1.8"></path>
						<path d="M6 12V9a6 6 0 0 1 11.5-2.3"></path>
					{:else}
						<path d="M3 18v3h18v-3"></path>
						<path d="M12 3a6 6 0 0 1 6 6v3a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6z"></path>
					{/if}
				</svg>
			</button>

			<button
				class="control-btn"
				class:active={$isVideoOff}
				on:click={handleToggleVideo}
				title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}
			>
				<svg class="control-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if $isVideoOff}
						<line x1="1" y1="1" x2="23" y2="23"></line>
						<path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3m0-11l5-5h6a2 2 0 0 1 2 2v9.34a2 2 0 0 1-.46 1.32"></path>
					{:else}
						<path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
					{/if}
				</svg>
			</button>

			<!-- Screen Share button -->
			{#if $isSharing}
				<button
					class="control-btn screen-share-stop"
					on:click={handleToggleScreenShare}
					title="Stop sharing"
				>
					<svg class="control-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
						<line x1="8" y1="21" x2="16" y2="21"></line>
						<line x1="12" y1="17" x2="12" y2="21"></line>
						<line x1="2" y1="3" x2="22" y2="17"></line>
					</svg>
				</button>
			{:else}
				<button
					class="control-btn"
					on:click={handleToggleScreenShare}
					title="Share screen"
				>
					<svg class="control-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
						<line x1="8" y1="21" x2="16" y2="21"></line>
						<line x1="12" y1="17" x2="12" y2="21"></line>
					</svg>
				</button>
			{/if}

			<button class="control-btn end-call-btn" on:click={handleEndCall} title="End call">
				<svg class="control-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
					<line x1="1" y1="1" x2="23" y2="23"></line>
				</svg>
			</button>
		</div>

		{#if $connectionState && $connectionState !== 'idle'}
			<div class="connection-status">Connection: {$connectionState}</div>
		{/if}
	</div>
{/if}

<style>
	/* ================================================================
	   Incoming Call Modal
	   ================================================================ */
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

	/* ================================================================
	   Active Call Container
	   ================================================================ */
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

	/* ================================================================
	   Avatar Circle (shared)
	   ================================================================ */
	.avatar-circle {
		width: 80px;
		height: 80px;
		border-radius: 50%;
		background: var(--accent, #5865F2);
		color: white;
		font-size: 2rem;
		font-weight: bold;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.avatar-circle-lg {
		width: 120px;
		height: 120px;
		font-size: 3rem;
	}

	.avatar-circle-sm {
		width: 36px;
		height: 36px;
		font-size: 1rem;
	}

	/* ================================================================
	   Voice-Only / Video-Call Grid (original layout)
	   ================================================================ */
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
		background: var(--dark-bg-secondary);
		color: white;
		gap: 0.5rem;
	}

	.placeholder-name {
		font-size: 0.875rem;
		opacity: 0.8;
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

	/* ================================================================
	   Tiled Layout
	   ================================================================ */
	.tile-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr));
		gap: 0.5rem;
		padding: 0.5rem;
		overflow-y: auto;
	}

	.tile {
		position: relative;
		background: var(--dark-bg-secondary);
		border-radius: 8px;
		overflow: hidden;
		cursor: pointer;
		border: 2px solid transparent;
		transition: border-color 0.15s;
		aspect-ratio: 16 / 9;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		color: white;
		font-family: inherit;
	}

	.tile:hover {
		border-color: var(--accent, #5865F2);
	}

	.tile-screen {
		/* Screen shares get priority sizing in the grid */
		grid-column: span 1;
	}

	.tile-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.tile-video-contain {
		object-fit: contain;
		background: #000;
	}

	.tile-avatar {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
	}

	.tile-label {
		position: absolute;
		bottom: 0.5rem;
		left: 0.5rem;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		pointer-events: none;
	}

	/* ================================================================
	   Focused Layout
	   ================================================================ */
	.focused-layout {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.focused-main {
		flex: 1;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 0;
	}

	.focused-tile {
		width: 100%;
		height: 100%;
		background: #000;
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		padding: 0;
		color: white;
		font-family: inherit;
	}

	.focused-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.focused-video-contain {
		object-fit: contain;
	}

	.focused-avatar {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		background: var(--dark-bg-secondary);
	}

	.focused-label {
		position: absolute;
		bottom: 1rem;
		left: 1rem;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		pointer-events: none;
	}

	.focused-controls-overlay {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		display: flex;
		gap: 0.5rem;
		z-index: 10;
	}

	.overlay-btn {
		width: 36px;
		height: 36px;
		border-radius: 8px;
		border: none;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s;
		padding: 0;
	}

	.overlay-btn:hover {
		background: rgba(0, 0, 0, 0.85);
	}

	.overlay-btn svg {
		width: 18px;
		height: 18px;
	}

	/* ---- Thumbnail strip ---- */
	.thumbnail-strip {
		display: flex;
		gap: 0.5rem;
		padding: 0.5rem;
		overflow-x: auto;
		background: var(--dark-bg-secondary);
		flex-shrink: 0;
	}

	.thumbnail {
		position: relative;
		width: 120px;
		height: 80px;
		flex-shrink: 0;
		border-radius: 6px;
		overflow: hidden;
		cursor: pointer;
		border: 2px solid transparent;
		transition: border-color 0.15s;
		background: var(--dark-bg-primary);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		color: white;
		font-family: inherit;
	}

	.thumbnail:hover {
		border-color: var(--accent, #5865F2);
	}

	.thumbnail-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.thumbnail-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
	}

	.thumbnail-label {
		position: absolute;
		bottom: 2px;
		left: 2px;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		padding: 1px 4px;
		border-radius: 3px;
		font-size: 0.625rem;
		font-weight: 500;
		pointer-events: none;
		max-width: calc(100% - 4px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ================================================================
	   Controls Bar
	   ================================================================ */
	.call-controls {
		display: flex;
		gap: 1rem;
		padding: 1.5rem;
		padding-bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px));
		background: var(--dark-bg-secondary);
		justify-content: center;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
		flex-shrink: 0;
	}

	.control-btn {
		width: 52px;
		height: 52px;
		border-radius: 50%;
		border: none;
		background: rgba(255, 255, 255, 0.15);
		color: white;
		font-size: 1.5rem;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.control-btn:hover {
		background: rgba(255, 255, 255, 0.25);
		transform: scale(1.1);
	}

	.control-btn.active {
		background: var(--color-danger-hover, #d83c3e);
	}

	.end-call-btn {
		background: var(--color-danger-hover, #d83c3e);
	}

	.end-call-btn:hover {
		background: var(--color-danger-dark, #a12d2f);
	}

	.screen-share-stop {
		background: var(--color-danger-hover, #d83c3e);
	}

	.screen-share-stop:hover {
		background: var(--color-danger-dark, #a12d2f);
	}

	.control-icon {
		display: block;
		width: 22px;
		height: 22px;
	}

	.control-btn svg {
		width: 22px;
		height: 22px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.connection-status {
		position: absolute;
		top: 1rem;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(0, 0, 0, 0.7);
		color: white;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		text-transform: capitalize;
	}

	@media (max-width: 768px) {
		.control-btn {
			width: 44px;
			height: 44px;
		}

		.call-controls {
			gap: 0.75rem;
			padding: 1rem;
			padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		}

		.video-grid {
			grid-template-columns: 1fr;
		}

		.tile-grid {
			grid-template-columns: 1fr;
		}

		.thumbnail {
			width: 90px;
			height: 60px;
		}
	}
</style>
