<script lang="ts">
	import { socket, getSocket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import {
		incomingCall,
		isInCall,
		channelCallPanelOpen,
		isMuted,
		isDeafened,
		isVideoOff,
		isLocalSpeaking,
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
		connectionState,
		spatialAudioRuntimeStatus,
		toggleSpatialAudioEnabled
	} from '$lib/calling';
	import {
		computeCallLayout,
		DEFAULT_ACTIVE_SPEAKER_STATE,
		tileOwnerParticipantId,
		type ActiveSpeakerState
	} from '$lib/callLayoutManager';
	import { showCallNotification, playCallRingtone, stopCallRingtone } from '$lib/notifications';
	import { onDestroy } from 'svelte';

	type CallViewportMode = 'embedded' | 'focus' | 'docked';
	type RenderTileKind = 'video' | 'screen' | 'avatar';

	interface ParticipantMedia {
		id: string;
		label: string;
		isLocal: boolean;
		hasVideo: boolean;
		stream: MediaStream | null;
	}

	interface ShareMedia {
		id: string;
		participantId: string;
		label: string;
		isLocal: boolean;
		stream: MediaStream | null;
	}

	interface RenderTile {
		id: string;
		participantId: string;
		label: string;
		kind: RenderTileKind;
		stream: MediaStream | null;
		isLocal: boolean;
	}

	let callNotification: Notification | null = null;
	let lastIncomingCallToken: string | null = null;
	let callViewportMode: CallViewportMode = 'embedded';
	let hatchOpen = false;
	let pinnedTileIds: string[] = [];
	let activeSpeakerState: ActiveSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
	let wasInCall = false;

	$: spatialAudioActive = $spatialAudioRuntimeStatus.active;
	$: spatialQuickToggleVisible = $spatialAudioRuntimeStatus.quickToggleVisible;
	$: showDockedBar = $isInCall && callViewportMode === 'docked';
	$: showCallShell = $isInCall && callViewportMode !== 'docked';
	$: showHatchToggle = $isInCall && callViewportMode === 'focus';
	$: focusHatchInsetLeft = !$layoutStore.isMobile && $layoutStore.navDock === 'left' ? $layoutStore.channelSidebarWidth : 0;
	$: focusHatchInsetRight = !$layoutStore.isMobile
		? ($layoutStore.navDock === 'right' ? $layoutStore.channelSidebarWidth : 0) + ($layoutStore.showRightPanel ? $layoutStore.rightPanelWidth : 0)
		: 0;

	$: participants = buildParticipants($activeCalls, $isInCall, $localStream, $isVideoOff);
	$: shares = buildShares($screenShares, $isSharing, $localScreenStream);
	$: renderTiles = buildRenderTiles(participants, shares);
	$: tileById = new Map(renderTiles.map((tile) => [tile.id, tile]));
	$: activeSpeakerLevels = buildActiveSpeakerLevels(participants, $activeCalls, $isLocalSpeaking, $isMuted, $isDeafened);

	$: {
		const nextPins = sanitizePinnedIds(pinnedTileIds, tileById);
		if (!isSameIdList(nextPins, pinnedTileIds)) {
			pinnedTileIds = nextPins;
		}
	}

	$: layoutResult = computeCallLayout({
		participants: participants.map((participant) => ({
			id: participant.id,
			hasVideo: participant.hasVideo
		})),
		shares: shares.map((share) => ({
			id: share.id,
			participantId: share.participantId
		})),
		pins: pinnedTileIds,
		activeSpeakerLevels,
		nowMs: Date.now(),
		activeSpeakerState
	});

	$: {
		if (!isSameSpeakerState(activeSpeakerState, layoutResult.nextActiveSpeakerState)) {
			activeSpeakerState = layoutResult.nextActiveSpeakerState;
		}
	}

	$: orderedTiles = layoutResult.tileIds
		.map((tileId) => tileById.get(tileId))
		.filter((tile): tile is RenderTile => Boolean(tile));

	$: {
		if ($isInCall && !wasInCall) {
			callViewportMode = 'embedded';
			channelCallPanelOpen.set(true);
			hatchOpen = false;
			pinnedTileIds = [];
			activeSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
		}
		if (!$isInCall && wasInCall) {
			callViewportMode = 'embedded';
			hatchOpen = false;
			pinnedTileIds = [];
			activeSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
		}
		wasInCall = $isInCall;
	}

	$: if ($isInCall && $channelCallPanelOpen && callViewportMode === 'docked') {
		callViewportMode = 'embedded';
	}

	$: {
		const incomingToken = $incomingCall
			? `${$incomingCall.userId}:${$incomingCall.isVideoCall ? 'video' : 'voice'}`
			: null;
		if (incomingToken && incomingToken !== lastIncomingCallToken) {
			playCallRingtone();
			callNotification?.close();
			callNotification = showCallNotification(
				$incomingCall!.username,
				$incomingCall!.isVideoCall,
				() => void handleAnswer(),
				() => handleReject()
			);
		}
		if (!incomingToken && lastIncomingCallToken) {
			stopCallRingtone();
			callNotification?.close();
			callNotification = null;
		}
		lastIncomingCallToken = incomingToken;
	}

	function sanitizePinnedIds(pinned: string[], tiles: Map<string, RenderTile>): string[] {
		const next: string[] = [];
		for (const tileId of pinned) {
			if (next.length >= 2) break;
			if (!tiles.has(tileId)) continue;
			if (next.includes(tileId)) continue;
			next.push(tileId);
		}
		return next;
	}

	function isSameIdList(a: string[], b: string[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	function isSameSpeakerState(a: ActiveSpeakerState, b: ActiveSpeakerState): boolean {
		return (
			a.heroParticipantId === b.heroParticipantId &&
			a.candidateParticipantId === b.candidateParticipantId &&
			a.candidateSinceMs === b.candidateSinceMs &&
			a.lastSwitchAtMs === b.lastSwitchAtMs
		);
	}

	function buildParticipants(
		calls: typeof $activeCalls,
		inCall: boolean,
		myStream: MediaStream | null,
		localVideoOff: boolean
	): ParticipantMedia[] {
		const list: ParticipantMedia[] = [];
		if (inCall) {
			const hasLocalVideo = Boolean(!localVideoOff && myStream?.getVideoTracks().length);
			list.push({
				id: 'local',
				label: 'You',
				isLocal: true,
				hasVideo: hasLocalVideo,
				stream: myStream
			});
		}
		for (const call of calls) {
			list.push({
				id: call.userId,
				label: call.username || 'User',
				isLocal: false,
				hasVideo: Boolean(call.isVideoEnabled && call.stream?.getVideoTracks().length),
				stream: call.stream
			});
		}
		return list.sort((a, b) => a.id.localeCompare(b.id));
	}

	function buildShares(
		remoteShares: typeof $screenShares,
		sharing: boolean,
		localShare: MediaStream | null
	): ShareMedia[] {
		const list: ShareMedia[] = remoteShares
			.map((share) => ({
				id: share.userId,
				participantId: share.userId,
				label: `${share.username}'s Screen`,
				isLocal: false,
				stream: share.stream
			}))
			.sort((a, b) => a.id.localeCompare(b.id));

		if (sharing && localShare) {
			list.push({
				id: 'local',
				participantId: 'local',
				label: 'Your Screen',
				isLocal: true,
				stream: localShare
			});
		}

		return list;
	}

	function buildRenderTiles(participantsList: ParticipantMedia[], shareList: ShareMedia[]): RenderTile[] {
		const hasShares = shareList.length > 0;
		const videoParticipants = participantsList.filter((participant) => participant.hasVideo);
		const hasVideoTiles = videoParticipants.length > 0;
		const tiles: RenderTile[] = [];

		if (hasShares || hasVideoTiles) {
			for (const share of shareList) {
				tiles.push({
					id: `share:${share.id}`,
					participantId: share.participantId,
					label: share.label,
					kind: 'screen',
					stream: share.stream,
					isLocal: share.isLocal
				});
			}
			for (const participant of videoParticipants) {
				tiles.push({
					id: `video:${participant.id}`,
					participantId: participant.id,
					label: participant.label,
					kind: 'video',
					stream: participant.stream,
					isLocal: participant.isLocal
				});
			}
			return tiles.sort((a, b) => a.id.localeCompare(b.id));
		}

		for (const participant of participantsList) {
			tiles.push({
				id: `avatar:${participant.id}`,
				participantId: participant.id,
				label: participant.label,
				kind: 'avatar',
				stream: participant.stream,
				isLocal: participant.isLocal
			});
		}
		return tiles.sort((a, b) => a.id.localeCompare(b.id));
	}

	function buildActiveSpeakerLevels(
		participantsList: ParticipantMedia[],
		calls: typeof $activeCalls,
		localSpeaking: boolean,
		muted: boolean,
		deafened: boolean
	): Record<string, number> {
		const levels: Record<string, number> = {};
		for (const participant of participantsList) {
			if (participant.isLocal) {
				levels[participant.id] = !deafened && !muted && localSpeaking ? 1 : 0;
				continue;
			}
			const call = calls.find((entry) => entry.userId === participant.id);
			levels[participant.id] = call?.isAudioEnabled && call?.isSpeaking ? 1 : 0;
		}
		return levels;
	}

	function getInitial(label: string): string {
		return label.trim().charAt(0).toUpperCase() || '?';
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

	async function handleAnswer() {
		if (!$incomingCall || !$socket) return;
		await answerCall($socket, $incomingCall.userId, $incomingCall.isVideoCall);
	}

	function handleReject() {
		if (!$incomingCall || !$socket) return;
		rejectCall($socket, $incomingCall.userId);
	}

	function handleEndCall() {
		const sock = $socket || getSocket();
		if (!sock) return;
		endCall(sock);
		hatchOpen = false;
		pinnedTileIds = [];
	}

	function handleToggleMute() {
		toggleMute();
	}

	function handleToggleDeafen() {
		toggleDeafen();
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

	function setViewportMode(mode: CallViewportMode): void {
		callViewportMode = mode;
		if (mode === 'docked') {
			channelCallPanelOpen.set(false);
			hatchOpen = false;
			return;
		}
		channelCallPanelOpen.set(true);
		if (mode !== 'focus') {
			hatchOpen = false;
		}
	}

	function toggleHatch(): void {
		if (callViewportMode !== 'focus') return;
		hatchOpen = !hatchOpen;
	}

	function closeHatch(): void {
		hatchOpen = false;
	}

	function togglePin(tileId: string): void {
		if (pinnedTileIds.includes(tileId)) {
			pinnedTileIds = pinnedTileIds.filter((id) => id !== tileId);
			return;
		}
		if (pinnedTileIds.length < 2) {
			pinnedTileIds = [...pinnedTileIds, tileId];
			return;
		}
		// Future hook: allow explicit pin-slot selection instead of evicting oldest.
		pinnedTileIds = [pinnedTileIds[1], tileId];
	}

	function isTilePinned(tileId: string): boolean {
		return pinnedTileIds.includes(tileId);
	}

	function isTileSpeaking(tile: RenderTile): boolean {
		if ($isDeafened) return false;
		if (tile.isLocal) return $isLocalSpeaking && !$isMuted;
		const call = $activeCalls.find((entry) => entry.userId === tileOwnerParticipantId(tile.id));
		return Boolean(call?.isAudioEnabled && call?.isSpeaking);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && hatchOpen) {
			event.preventDefault();
			closeHatch();
		}
	}

	onDestroy(() => {
		stopCallRingtone();
		callNotification?.close();
	});
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $incomingCall}
	<div class="call-modal-overlay">
		<div class="incoming-call-modal">
			<div class="caller-info">
				<div class="caller-avatar">{$incomingCall.username.charAt(0).toUpperCase()}</div>
				<h2>{$incomingCall.username}</h2>
				<p class="call-type">{$incomingCall.isVideoCall ? 'Video' : 'Voice'} Call</p>
			</div>
			<div class="call-actions">
				<button class="answer-btn" on:click={handleAnswer}>Answer</button>
				<button class="reject-btn" on:click={handleReject}>Decline</button>
			</div>
		</div>
	</div>
{/if}

{#if $isInCall && $activeCalls.length > 0}
	<div class="remote-audio-sink" aria-hidden="true">
		{#each $activeCalls as call (call.userId)}
			<audio
				autoplay
				playsinline
				muted={$isDeafened || spatialAudioActive}
				use:bindMediaStream={call.stream}
			></audio>
		{/each}
	</div>
{/if}

{#if showDockedBar}
	<div class="docked-bar" role="region" aria-label="Docked call controls">
		<div class="docked-title">Call in progress ({1 + $activeCalls.length})</div>
		<div class="docked-actions">
			<button class="dock-btn" on:click={() => setViewportMode('embedded')} title="Open embedded call">Open</button>
			<button class="dock-btn" on:click={() => setViewportMode('focus')} title="Focus call">Focus</button>
			<button class="dock-btn" class:active={$isMuted} on:click={handleToggleMute} title={$isMuted ? 'Unmute' : 'Mute'}>Mute</button>
			<button class="dock-btn end" on:click={handleEndCall} title="End call">End</button>
		</div>
	</div>
{/if}

{#if showCallShell}
	<div
		class="call-shell"
		class:mode-embedded={callViewportMode === 'embedded'}
		class:mode-focus={callViewportMode === 'focus'}
		class:hatch-open={callViewportMode === 'focus' && hatchOpen}
		style={`--hatch-left: ${focusHatchInsetLeft}px; --hatch-right: ${focusHatchInsetRight}px;`}
	>
		{#if callViewportMode === 'focus'}
			<button
				type="button"
				class="hatch-scrim"
				class:visible={hatchOpen}
				on:click={closeHatch}
				aria-label="Close hatch"
			></button>
		{/if}

		{#if showHatchToggle}
			<button
				type="button"
				class="hatch-toggle"
				on:click={toggleHatch}
				title={hatchOpen ? 'Close hatch' : 'Open hatch'}
			>
				{hatchOpen ? 'Close Hatch' : 'Open Hatch'}
			</button>
		{/if}

		<div class="active-call-container">
			<div class="call-stage">
				{#if layoutResult.template === 'floating-bubbles'}
					<div class="bubble-stage">
						{#each orderedTiles as tile (tile.id)}
							<div
								class="bubble-tile"
								class:pinned={isTilePinned(tile.id)}
								class:speaking={isTileSpeaking(tile)}
								style={bubbleStyle(tile.id)}
							>
								<button
									type="button"
									class="pin-btn"
									on:click|stopPropagation={() => togglePin(tile.id)}
									title={isTilePinned(tile.id) ? 'Unpin tile' : 'Pin tile'}
								>
									{isTilePinned(tile.id) ? 'Unpin' : 'Pin'}
								</button>
								<div class="bubble-avatar">{getInitial(tile.label)}</div>
								<div class="bubble-label">{tile.label}</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="tile-layout template-{layoutResult.template}">
						{#each orderedTiles as tile (tile.id)}
							<article
								class="media-tile"
								class:hero={layoutResult.heroIds.includes(tile.id)}
								class:pinned={isTilePinned(tile.id)}
								class:speaking={isTileSpeaking(tile)}
							>
								<button
									type="button"
									class="pin-btn"
									on:click|stopPropagation={() => togglePin(tile.id)}
									title={isTilePinned(tile.id) ? 'Unpin tile' : 'Pin tile'}
								>
									{isTilePinned(tile.id) ? 'Unpin' : 'Pin'}
								</button>
								{#if tile.kind === 'avatar' || !tile.stream}
									<div class="tile-avatar">
										<div class="avatar-circle">{getInitial(tile.label)}</div>
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
								{/if}
								<div class="tile-label">{tile.label}</div>
							</article>
						{/each}
					</div>
				{/if}
			</div>

			<div class="call-controls">
				<div class="mode-controls" role="group" aria-label="Call view mode">
					<button class="mode-btn" class:active={callViewportMode === 'embedded'} on:click={() => setViewportMode('embedded')}>Embedded</button>
					<button class="mode-btn" class:active={callViewportMode === 'focus'} on:click={() => setViewportMode('focus')}>Focus</button>
					<button class="mode-btn" class:active={callViewportMode === 'docked'} on:click={() => setViewportMode('docked')}>Dock</button>
				</div>

				<div class="control-actions">
					<button class="control-btn" class:active={$isMuted} on:click={handleToggleMute} title={$isMuted ? 'Unmute' : 'Mute'}>Mute</button>
					<button class="control-btn" class:active={$isDeafened} on:click={handleToggleDeafen} title={$isDeafened ? 'Undeafen' : 'Deafen'}>Deafen</button>
					{#if spatialQuickToggleVisible}
						<button class="control-btn" class:active={spatialAudioActive} on:click={toggleSpatialAudioEnabled} title={spatialAudioActive ? 'Disable spatial audio' : 'Enable spatial audio'}>Spatial</button>
					{/if}
					<button class="control-btn" class:active={$isVideoOff} on:click={handleToggleVideo} title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}>Video</button>
					<button class="control-btn" class:active={$isSharing} on:click={handleToggleScreenShare} title={$isSharing ? 'Stop sharing' : 'Share screen'}>{$isSharing ? 'Stop Share' : 'Share'}</button>
					<button class="control-btn end" on:click={handleEndCall} title="End call">End</button>
				</div>
			</div>

			{#if $connectionState && $connectionState !== 'idle'}
				<div class="connection-status">Connection: {$connectionState}</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.remote-audio-sink {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.call-modal-overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2300;
		backdrop-filter: blur(8px);
	}

	.incoming-call-modal {
		background: white;
		border-radius: 16px;
		padding: 2rem;
		width: min(420px, 92vw);
	}

	.caller-info {
		text-align: center;
		margin-bottom: 1.5rem;
	}

	.caller-avatar {
		width: 92px;
		height: 92px;
		border-radius: 50%;
		background: var(--accent);
		color: white;
		font-size: 2.5rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto 0.75rem;
	}

	.call-type {
		margin: 0;
		opacity: 0.75;
	}

	.call-actions {
		display: flex;
		gap: 0.75rem;
	}

	.answer-btn,
	.reject-btn {
		flex: 1;
		padding: 0.8rem 1rem;
		border: none;
		border-radius: 10px;
		font-weight: 600;
		cursor: pointer;
	}

	.answer-btn {
		background: var(--color-success, #16a34a);
		color: #fff;
	}

	.reject-btn {
		background: var(--color-danger-hover, #d83c3e);
		color: #fff;
	}

	.docked-bar {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 1800;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.8rem;
		border-radius: 12px;
		background: color-mix(in srgb, var(--dark-bg-secondary, #111827) 88%, black 12%);
		border: 1px solid rgba(255, 255, 255, 0.12);
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.42);
	}

	.docked-title {
		font-size: 0.78rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.88);
	}

	.docked-actions {
		display: flex;
		gap: 0.45rem;
	}

	.dock-btn {
		padding: 0.4rem 0.65rem;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
	}

	.dock-btn.active {
		background: var(--accent, #5865f2);
	}

	.dock-btn.end {
		background: var(--color-danger-hover, #d83c3e);
		border-color: transparent;
	}

	.call-shell {
		pointer-events: none;
		z-index: 1600;
	}

	.call-shell.mode-embedded {
		position: absolute;
		inset: 0;
	}

	.call-shell.mode-focus {
		position: fixed;
		inset: 0;
		z-index: 1700;
	}

	.hatch-scrim {
		position: fixed;
		inset: 0;
		border: none;
		background: rgba(8, 10, 17, 0.46);
		backdrop-filter: blur(6px);
		opacity: 0;
		pointer-events: none;
		transition: opacity 180ms ease;
		z-index: 0;
	}

	.hatch-scrim.visible {
		opacity: 1;
		pointer-events: auto;
	}

	.hatch-toggle {
		position: fixed;
		top: 1rem;
		right: 1rem;
		z-index: 1802;
		padding: 0.5rem 0.75rem;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
	}

	.active-call-container {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--dark-bg-primary, #0b1020);
		pointer-events: auto;
		transition:
			inset 220ms ease,
			transform 220ms ease,
			border-radius 220ms ease,
			box-shadow 220ms ease;
	}

	.call-shell.mode-focus .active-call-container {
		position: fixed;
		inset: 0;
		z-index: 1;
	}

	.call-shell.mode-focus.hatch-open .active-call-container {
		inset: 0.7rem calc(var(--hatch-right) + 0.7rem) 0.7rem calc(var(--hatch-left) + 0.7rem);
		border-radius: 18px;
		transform: scale(0.988);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.48);
	}

	.call-stage {
		flex: 1;
		min-height: 0;
	}

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

	.template-screen-hero .media-tile.hero,
	.template-single-hero .media-tile.hero {
		grid-column: 1 / -1;
		grid-row: 1;
		min-height: min(68vh, 100%);
		aspect-ratio: auto;
	}

	.template-screen-hero .media-tile:not(.hero),
	.template-single-hero .media-tile:not(.hero) {
		grid-column: span 3;
	}

	.template-split {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.template-hero-stack {
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		grid-auto-rows: minmax(120px, 1fr);
	}

	.template-hero-stack .media-tile.hero {
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

	.template-double-hero-triple .media-tile.hero {
		grid-column: span 3;
		aspect-ratio: 16 / 9;
	}

	.template-double-hero-triple .media-tile:not(.hero) {
		grid-column: span 2;
	}

	.template-uniform-grid {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}

	.template-scroll-grid {
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
	}

	.media-tile {
		position: relative;
		border-radius: 12px;
		overflow: hidden;
		background: color-mix(in srgb, var(--dark-bg-secondary, #111827) 90%, black 10%);
		aspect-ratio: 16 / 9;
		border: 2px solid transparent;
		min-height: 120px;
	}

	.media-tile.hero {
		border-color: rgba(255, 255, 255, 0.2);
	}

	.media-tile.speaking {
		border-color: rgba(34, 197, 94, 0.82);
		box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.35);
	}

	.media-tile.pinned {
		border-color: rgba(250, 204, 21, 0.88);
	}

	.tile-video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.tile-video.contain {
		object-fit: contain;
		background: #000;
	}

	.tile-avatar {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(160deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.92));
	}

	.avatar-circle {
		width: 84px;
		height: 84px;
		border-radius: 50%;
		background: var(--accent, #5865f2);
		color: #fff;
		font-size: 1.9rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.tile-label {
		position: absolute;
		left: 0.55rem;
		bottom: 0.55rem;
		background: rgba(0, 0, 0, 0.64);
		color: #fff;
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
		border: 1px solid rgba(255, 255, 255, 0.24);
		background: rgba(0, 0, 0, 0.56);
		color: #fff;
		font-size: 0.64rem;
		font-weight: 700;
		cursor: pointer;
	}

	.bubble-stage {
		position: relative;
		height: 100%;
		background: radial-gradient(circle at 20% 15%, rgba(56, 189, 248, 0.16), transparent 45%),
			radial-gradient(circle at 80% 75%, rgba(59, 130, 246, 0.16), transparent 45%),
			var(--dark-bg-primary, #0b1020);
		overflow: hidden;
	}

	.bubble-tile {
		position: absolute;
		transform: translate(-50%, -50%);
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in srgb, var(--dark-bg-secondary, #111827) 86%, black 14%);
		border: 2px solid transparent;
		padding: 0.35rem;
	}

	.bubble-tile.speaking {
		border-color: rgba(34, 197, 94, 0.9);
		box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.28);
	}

	.bubble-tile.pinned {
		border-color: rgba(250, 204, 21, 0.92);
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
		color: #fff;
		background: linear-gradient(145deg, rgba(88, 101, 242, 0.92), rgba(67, 56, 202, 0.9));
	}

	.bubble-label {
		position: absolute;
		bottom: -1.15rem;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.68rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.88);
		white-space: nowrap;
	}

	.call-controls {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.9rem;
		padding: 0.8rem;
		padding-bottom: calc(0.8rem + env(safe-area-inset-bottom, 0px));
		background: color-mix(in srgb, var(--dark-bg-secondary, #111827) 90%, black 10%);
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	.mode-controls,
	.control-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.mode-btn,
	.control-btn {
		padding: 0.45rem 0.68rem;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.mode-btn.active,
	.control-btn.active {
		background: var(--accent, #5865f2);
		border-color: transparent;
	}

	.control-btn.end {
		background: var(--color-danger-hover, #d83c3e);
		border-color: transparent;
	}

	.connection-status {
		position: absolute;
		top: 0.6rem;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(0, 0, 0, 0.62);
		padding: 0.35rem 0.6rem;
		border-radius: 8px;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: capitalize;
		z-index: 3;
	}

	@media (max-width: 900px) {
		.call-shell.mode-focus.hatch-open .active-call-container {
			inset: 0.45rem;
			border-radius: 14px;
		}

		.call-controls {
			flex-direction: column;
			align-items: stretch;
		}

		.template-screen-hero .media-tile:not(.hero),
		.template-single-hero .media-tile:not(.hero) {
			grid-column: span 4;
		}
	}

	@media (max-width: 640px) {
		.docked-bar {
			left: 0.6rem;
			right: 0.6rem;
			bottom: 0.6rem;
			flex-direction: column;
			align-items: stretch;
		}

		.docked-actions {
			justify-content: space-between;
		}

		.hatch-toggle {
			top: 0.7rem;
			right: 0.7rem;
		}

		.tile-layout {
			grid-template-columns: 1fr !important;
		}

		.template-hero-stack .media-tile.hero {
			grid-row: auto;
			aspect-ratio: 16 / 9;
		}
	}
</style>
