<script lang="ts">
	import { socket, getSocket, users, currentUser, currentChannel } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import {
		incomingCall,
		outgoingCall,
		groupCallRingingTargets,
		isInCall,
		channelCallPanelOpen,
		activeVoiceChannel,
		activeGroupCall,
		isMuted,
		isDeafened,
		isVideoOff,
		isLocalSpeaking,
		activeCalls,
		screenShares,
		isSharing,
		localScreenStream,
		callMode,
		answerCall,
		cancelOutgoingCall,
		rejectCall,
		stopGroupCallRingingTarget,
		endCall,
		toggleMute,
		toggleDeafen,
		toggleVideo,
		startScreenShare,
		stopScreenShare,
		localStream,
		listeningVoiceChannels,
		connectionState,
		callTransportState,
		spatialAudioRuntimeStatus,
		toggleSpatialAudioEnabled
	} from '$lib/calling';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import {
		computeCallLayout,
		DEFAULT_ACTIVE_SPEAKER_STATE,
		tileOwnerParticipantId,
		type ActiveSpeakerState
	} from '$lib/callLayoutManager';
	import {
		buildActiveSpeakerLevels,
		buildParticipants,
		buildRenderTiles,
		buildShares,
		getInitial,
		type RenderTile
	} from '$lib/callRenderModel';
	import {
		directCallRecordingParticipants,
		groupCallRecordingParticipants,
		voiceCallRecordingParticipants
	} from '$lib/callRecordingPresence';
	import { callRecordingState, startCallRecording, stopCallRecording } from '$lib/callRecording';
	import { showCallNotification, playCallRingtone, stopCallRingtone } from '$lib/notifications';
	import { openWhiteboardSurface, queueWhiteboardImport } from '$lib/whiteboard/whiteboardSurface';
	import { onDestroy, afterUpdate } from 'svelte';

	type CallViewportMode = 'embedded' | 'focus' | 'docked';

	let callNotification: Notification | null = null;
	let lastIncomingCallToken: string | null = null;
	let lastRingtoneToken: string | null = null;
	let callViewportMode: CallViewportMode = 'embedded';
	let hatchOpen = false;
	let pinnedTileIds: string[] = [];
	let activeSpeakerState: ActiveSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
	let wasInCall = false;
	let wasChannelPanelOpen = false;
	let ringingMenuOpen = false;
	let ringingMenuX = 0;
	let ringingMenuY = 0;
	let ringingMenuTarget: { stableUserId: string; username: string } | null = null;
	let callStageElement: HTMLDivElement | null = null;
	let captureBusy = false;
	let captureFeedback = '';
	let captureFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

	$: spatialAudioActive = $spatialAudioRuntimeStatus.active;
	$: spatialQuickToggleVisible = $spatialAudioRuntimeStatus.quickToggleVisible;
	$: showDockedBar = $isInCall && callViewportMode === 'docked';
	$: showCallShell = $isInCall && callViewportMode !== 'docked';
	$: showHatchToggle = $isInCall;
	$: focusHatchInsetLeft = !$layoutStore.isMobile && $layoutStore.navDock === 'left' ? $layoutStore.channelSidebarWidth : 0;
	$: focusHatchInsetRight = !$layoutStore.isMobile
		? ($layoutStore.navDock === 'right' ? $layoutStore.channelSidebarWidth : 0) + ($layoutStore.showRightPanel ? $layoutStore.rightPanelWidth : 0)
		: 0;

	$: participants = buildParticipants($activeCalls, $isInCall, $localStream, $isVideoOff);
	$: shares = buildShares($screenShares, $isSharing, $localScreenStream);
	$: renderTiles = buildRenderTiles(participants, shares);
	$: tileById = new Map(renderTiles.map((tile) => [tile.id, tile]));
	$: captureAvailable = shares.length > 0;
	$: activeSpeakerLevels = buildActiveSpeakerLevels(participants, $activeCalls, $isLocalSpeaking, $isMuted, $isDeafened);
	$: recordingLabel =
		$callRecordingState.status === 'recording'
			? `Recording ${formatRecordingElapsed($callRecordingState.elapsedMs)}`
			: $callRecordingState.status === 'saving'
				? 'Saving recording...'
				: $callRecordingState.savedFileCount > 1
					? `Saved ${$callRecordingState.savedFileCount} files`
				: $callRecordingState.savedPath
					? `Saved: ${$callRecordingState.savedPath}`
					: $callRecordingState.savedFileCount === 1
						? 'Saved 1 file'
					: $callRecordingState.lastError
						? `Recording error: ${$callRecordingState.lastError}`
						: '';
	$: selfStableUserId =
		typeof $currentUser?.dbUserId === 'number'
			? `user-${$currentUser.dbUserId}`
			: ($currentUser?.id || null);
	$: channelScopeRecordingParticipants = (() => {
		const channelIds = new Set($listeningVoiceChannels);
		if ($activeVoiceChannel?.id) {
			channelIds.add($activeVoiceChannel.id);
		}
		const participantsByUserId = new Map<
			string,
			{ userId: string; socketId?: string; username?: string; profilePicture?: string }
		>();
		for (const channelId of channelIds) {
			for (const participant of $voiceCallRecordingParticipants[channelId] || []) {
				participantsByUserId.set(participant.userId, participant);
			}
		}
		return Array.from(participantsByUserId.values());
	})();
	$: activeScopeRecordingParticipants =
		$callMode === 'channel'
			? channelScopeRecordingParticipants
			: $callMode === 'group'
				? ($activeGroupCall?.id ? ($groupCallRecordingParticipants[$activeGroupCall.id] || []) : [])
				: $directCallRecordingParticipants;
	$: activeRecordingCount = activeScopeRecordingParticipants.length;
	$: showRecordingPresenceBanner =
		$callRecordingState.status === 'recording' ||
		$callRecordingState.status === 'saving' ||
		activeRecordingCount > 0;
	$: recordingPillText =
		$callRecordingState.status === 'saving'
			? 'Saving'
			: $callRecordingState.status === 'recording'
				? `REC ${formatRecordingElapsed($callRecordingState.elapsedMs)}`
				: activeRecordingCount > 0
					? `REC ${activeRecordingCount}`
					: '';
	$: recordingPresenceCopy =
		$callRecordingState.status === 'saving'
			? 'Recording has stopped. Saving locally on this device.'
			: activeRecordingCount > 0
				? formatRecordingPresenceCopy(activeScopeRecordingParticipants, selfStableUserId)
				: $callRecordingState.status === 'recording'
					? 'Recording is starting. Everyone in this call will see the badge.'
					: '';

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

	afterUpdate(() => {
		if (!isSameSpeakerState(activeSpeakerState, layoutResult.nextActiveSpeakerState)) {
			activeSpeakerState = layoutResult.nextActiveSpeakerState;
		}
	});

	$: orderedTiles = layoutResult.tileIds
		.map((tileId) => tileById.get(tileId))
		.filter((tile): tile is RenderTile => Boolean(tile));
	$: routeListeningCount = (() => {
		const ids = new Set($listeningVoiceChannels);
		if ($activeVoiceChannel?.id) ids.add($activeVoiceChannel.id);
		return ids.size;
	})();
	$: voiceRouteText =
		$callMode === 'channel'
			? `Speaking: ${$activeVoiceChannel?.name || 'None'} | Listening: ${routeListeningCount} channel(s)`
			: $callMode === 'group'
				? `Group call: ${$activeGroupCall?.name || 'Group'}`
			: $isInCall
				? (
					$callTransportState.reason === 'direct_call_turn_unconfigured'
						? 'Direct call: P2P/STUN only. TURN relay is not configured on this server.'
						: 'Direct call: P2P/TURN'
				)
				: '';
	$: ringingMenuItems = ringingMenuTarget
		? ([
			{
				id: 'stop-ringing',
				label: 'Stop ringing',
				icon: 'phone',
				onSelect: () => handleStopRinging(ringingMenuTarget)
			}
		] satisfies ContextMenuItem[])
		: [];

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

	// Auto-dock when the user navigates away from the voice channel to a text channel
	$: {
		if (wasChannelPanelOpen && !$channelCallPanelOpen && $isInCall && $callMode === 'channel' && callViewportMode !== 'docked') {
			callViewportMode = 'docked';
		}
		wasChannelPanelOpen = $channelCallPanelOpen;
	}

	$: {
		const incomingToken = $incomingCall
			? `${$incomingCall.channelId || $incomingCall.userId}:${$incomingCall.isVideoCall ? 'video' : 'voice'}`
			: null;
		const outgoingToken = $outgoingCall
			? `${$outgoingCall.channelId || $outgoingCall.targetUserId || 'pending'}:${$outgoingCall.isVideoCall ? 'video' : 'voice'}`
			: null;
		const ringtoneToken = incomingToken || outgoingToken;
		if (ringtoneToken && ringtoneToken !== lastRingtoneToken) {
			playCallRingtone();
		}
		if (!ringtoneToken && lastRingtoneToken) {
			stopCallRingtone();
		}
		lastRingtoneToken = ringtoneToken;
		if (incomingToken && incomingToken !== lastIncomingCallToken) {
			callNotification?.close();
			callNotification = showCallNotification(
				$incomingCall!.channelName ? `${$incomingCall!.username} • ${$incomingCall!.channelName}` : $incomingCall!.username,
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

	function hashString(value: string): number {
		let hash = 0;
		for (let i = 0; i < value.length; i += 1) {
			hash = value.charCodeAt(i) + ((hash << 5) - hash);
		}
		return Math.abs(hash);
	}

	function bubbleStyle(tileId: string): string {
		if (orderedTiles.length === 1) {
			return 'width:108px; height:108px;';
		}
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
		await answerCall($socket, $incomingCall.userId, $incomingCall.isVideoCall, {
			channelId: $incomingCall.channelId,
			channelName: $incomingCall.channelName,
			localDisplayName: $currentUser?.username || 'Wabi User'
		});
	}

	function handleReject() {
		if (!$incomingCall || !$socket) return;
		rejectCall($socket, $incomingCall.userId, { channelId: $incomingCall.channelId });
	}

	function handleCancelOutgoing() {
		if (!$outgoingCall || !$socket) return;
		cancelOutgoingCall($socket);
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

	async function handleToggleRecording() {
		if ($callRecordingState.status === 'recording' || $callRecordingState.status === 'saving') {
			await stopCallRecording();
			return;
		}
		await startCallRecording();
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

	function resolveWhiteboardCaptureChannelId(): string {
		return $currentChannel;
	}

	function clearCaptureFeedbackTimer(): void {
		if (!captureFeedbackTimer) return;
		clearTimeout(captureFeedbackTimer);
		captureFeedbackTimer = null;
	}

	function setCaptureFeedback(message: string): void {
		captureFeedback = message;
		clearCaptureFeedbackTimer();
		if (!message) return;
		captureFeedbackTimer = setTimeout(() => {
			captureFeedback = '';
			captureFeedbackTimer = null;
		}, 4000);
	}

	function findScreenCaptureVideo(): HTMLVideoElement | null {
		if (!callStageElement) return null;
		return (
			callStageElement.querySelector('.media-tile.hero video.tile-video.contain') ||
			callStageElement.querySelector('video.tile-video.contain')
		) as HTMLVideoElement | null;
	}

	async function handleCaptureToWhiteboard() {
		if (captureBusy) return;
		const channelId = resolveWhiteboardCaptureChannelId();
		if (!channelId) {
			setCaptureFeedback('Open a channel before capturing to the whiteboard.');
			return;
		}

		const video = findScreenCaptureVideo();
		if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
			setCaptureFeedback('No active screen frame is ready to capture.');
			return;
		}

		captureBusy = true;
		setCaptureFeedback('');
		try {
			const canvas = document.createElement('canvas');
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				throw new Error('Capture canvas is unavailable.');
			}
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob((nextBlob) => {
					if (nextBlob) resolve(nextBlob);
					else reject(new Error('Unable to serialize captured frame.'));
				}, 'image/png');
			});
			openWhiteboardSurface(channelId);
			queueWhiteboardImport(
				channelId,
				new File([blob], `whiteboard-capture-${Date.now()}.png`, { type: 'image/png' }),
				'capture'
			);
			setCaptureFeedback('Captured frame queued for the whiteboard.');
		} catch (error) {
			setCaptureFeedback(
				error instanceof Error ? error.message : 'Failed to capture the current frame.'
			);
		} finally {
			captureBusy = false;
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

	function openRingingMenu(event: MouseEvent, target: { stableUserId: string; username: string }) {
		event.preventDefault();
		event.stopPropagation();
		ringingMenuTarget = target;
		ringingMenuX = event.clientX;
		ringingMenuY = event.clientY;
		ringingMenuOpen = true;
	}

	function closeRingingMenu() {
		ringingMenuOpen = false;
		ringingMenuTarget = null;
	}

	function handleStopRinging(target: { stableUserId: string; username: string } | null) {
		const sock = $socket || getSocket();
		if (!sock || !target) return;
		stopGroupCallRingingTarget(sock, target.stableUserId);
		closeRingingMenu();
	}

	function isTileDisconnected(tile: RenderTile): boolean {
		return !tile.isLocal && !tile.stream;
	}

	function formatRecordingElapsed(elapsedMs: number): string {
		const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		if (hours > 0) {
			return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
		}
		return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
	}

	function formatRecordingPresenceCopy(
		participants: Array<{ userId: string; username?: string }>,
		selfStableId: string | null
	): string {
		if (participants.length === 0) return '';
		const labels = participants.map((participant) =>
			selfStableId && participant.userId === selfStableId ? 'You' : (participant.username || participant.userId)
		);
		if (labels.length === 1) {
			return `${labels[0]} ${labels[0] === 'You' ? 'are' : 'is'} recording. Everyone in this call can see it.`;
		}
		if (labels.length === 2) {
			return `${labels[0]} and ${labels[1]} are recording.`;
		}
		return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more are recording.`;
	}

	function getParticipantAvatarUrl(tile: RenderTile): string | null {
		if (tile.isLocal) return $currentUser?.profilePicture || null;
		const byId = $users.find((user) => user.id === tile.participantId);
		if (byId?.profilePicture) return byId.profilePicture;
		const byName = $users.find((user) => user.username === tile.label);
		return byName?.profilePicture || null;
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
		clearCaptureFeedbackTimer();
	});
</script>

<svelte:window on:keydown={handleKeydown} />

{#if $incomingCall}
	<div class="call-modal-overlay">
		<div class="incoming-call-modal">
			<div class="caller-info">
				<div class="caller-avatar">{$incomingCall.username.charAt(0).toUpperCase()}</div>
				<h2>{$incomingCall.username}</h2>
				<p class="call-type">{$incomingCall.isVideoCall ? 'Video' : 'Voice'} {$incomingCall.channelId ? 'Group Call' : 'Call'}</p>
				{#if $incomingCall.channelName}
					<p class="call-subtitle">{$incomingCall.channelName}</p>
				{/if}
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
		<div class="docked-title">
			Call in progress ({1 + $activeCalls.length})
			{#if recordingPillText}
				<span class="recording-pill compact" class:is-saving={$callRecordingState.status === 'saving'}>
					<span class="recording-dot"></span>
					{recordingPillText}
				</span>
			{/if}
		</div>
		<div class="docked-actions">
			<button class="dock-btn" on:click={() => setViewportMode('embedded')} title="Open embedded call">Open</button>
			<button class="dock-btn" on:click={() => setViewportMode('focus')} title="Focus call">Focus</button>
			<button class="dock-btn" class:active={$isMuted} on:click={handleToggleMute} title={$isMuted ? 'Unmute' : 'Mute'}>Mute</button>
			<button
				class="dock-btn record"
				class:active={$callRecordingState.status === 'recording'}
				on:click={handleToggleRecording}
				title={$callRecordingState.status === 'recording' ? 'Stop recording' : 'Start recording'}
			>
				{$callRecordingState.status === 'saving' ? 'Saving' : $callRecordingState.status === 'recording' ? 'Stop REC' : 'Record'}
			</button>
			<button class="dock-btn end" on:click={handleEndCall} title="Leave call">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
		</button>
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
				on:click={callViewportMode === 'focus' ? () => setViewportMode('embedded') : () => setViewportMode('focus')}
				title={callViewportMode === 'focus' ? 'Exit fullscreen' : 'Fullscreen'}
			>
				{#if callViewportMode === 'focus'}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
				{/if}
			</button>
		{/if}

		<div class="active-call-container">
			{#if showRecordingPresenceBanner}
				<div class="recording-banner" role="status" aria-live="polite">
					<span class="recording-pill" class:is-saving={$callRecordingState.status === 'saving'}>
						<span class="recording-dot"></span>
						{recordingPillText || 'REC'}
					</span>
					<span class="recording-copy">{recordingPresenceCopy}</span>
				</div>
			{/if}
			<div class="call-stage" bind:this={callStageElement}>
				{#if layoutResult.template === 'floating-bubbles'}
					<div class="bubble-stage" class:single-bubble={orderedTiles.length === 1}>
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
								<div class="bubble-avatar">
									{#if getParticipantAvatarUrl(tile)}
										<img class="bubble-avatar-image" src={getParticipantAvatarUrl(tile) || ''} alt={tile.label} loading="lazy" decoding="async" />
									{:else}
										{getInitial(tile.label)}
									{/if}
								</div>
								<div class="bubble-label">{tile.label}</div>
								{#if isTileDisconnected(tile)}
									<div class="tile-status">Disconnected</div>
								{/if}
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
										<div class="avatar-circle">
											{#if getParticipantAvatarUrl(tile)}
												<img class="avatar-circle-image" src={getParticipantAvatarUrl(tile) || ''} alt={tile.label} loading="lazy" decoding="async" />
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
								{/if}
								<div class="tile-label">{tile.label}</div>
								{#if isTileDisconnected(tile)}
									<div class="tile-status">Disconnected</div>
								{/if}
							</article>
						{/each}
					</div>
				{/if}
			</div>

			<div class="call-controls">
				<div class="control-actions">
					<button class="control-btn" class:active={$isMuted} on:click={handleToggleMute} title={$isMuted ? 'Unmute' : 'Mute'}>
						{#if $isMuted}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{/if}
					</button>
					<button class="control-btn" class:active={$isDeafened} on:click={handleToggleDeafen} title={$isDeafened ? 'Undeafen' : 'Deafen'}>
						{#if $isDeafened}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
						{/if}
					</button>
					<button class="control-btn" class:active={!$isVideoOff} on:click={handleToggleVideo} title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
					</button>
					<button class="control-btn" class:active={$isSharing} on:click={handleToggleScreenShare} title={$isSharing ? 'Stop sharing' : 'Share screen'}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
					</button>
					<button
						class="control-btn"
						class:active={captureAvailable}
						on:click={handleCaptureToWhiteboard}
						disabled={!captureAvailable || captureBusy}
						title="Capture current shared frame to whiteboard"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h4l2-2h4l2 2h4v10H4z"/><circle cx="12" cy="12" r="3.5"/></svg>
					</button>
					<button
						class="control-btn record"
						class:active={$callRecordingState.status === 'recording'}
						class:is-saving={$callRecordingState.status === 'saving'}
						on:click={handleToggleRecording}
						title={$callRecordingState.status === 'recording' ? 'Stop recording' : 'Start recording'}
					>
						<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="7"></circle></svg>
					</button>
					<button class="control-btn end" on:click={handleEndCall} title="Leave call">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07C9.44 17.28 8.17 16 7.05 14.68A19.79 19.79 0 0 1 4 6.05 2 2 0 0 1 5.99 4h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L10.68 11.68"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
					</button>
				</div>
			</div>

			{#if $connectionState && $connectionState !== 'idle'}
				<div class="connection-status">Connection: {$connectionState}</div>
			{/if}
			{#if voiceRouteText}
				<div class="route-status">{voiceRouteText}</div>
			{/if}
			{#if recordingLabel}
				<div class="recording-status" class:is-error={$callRecordingState.status === 'error'}>
					{recordingLabel}
				</div>
			{/if}
			{#if captureFeedback}
				<div class="route-status">{captureFeedback}</div>
			{/if}
			{#if $callMode === 'group' && $groupCallRingingTargets.length > 0}
				<div class="ringing-targets-panel">
					<div class="ringing-targets-label">Still ringing</div>
					<div class="ringing-targets-list">
						{#each $groupCallRingingTargets as target (target.stableUserId)}
							<button
								type="button"
								class="ringing-target-chip"
								title={`Manage ringing for ${target.username}`}
								on:click={(event) => openRingingMenu(event, target)}
								on:contextmenu={(event) => openRingingMenu(event, target)}
							>
								<span class="ringing-target-name">{target.username}</span>
								<span class="ringing-target-state">Ringing</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}

{#if $outgoingCall && !$isInCall}
	<div class="call-modal-overlay">
		<div class="incoming-call-modal">
			<div class="caller-info">
				<div class="caller-avatar">{$outgoingCall.username.charAt(0).toUpperCase()}</div>
				<h2>{$outgoingCall.username}</h2>
				<p class="call-type">Calling... {$outgoingCall.isVideoCall ? 'Video' : 'Voice'} {$outgoingCall.scope === 'group' ? 'Group Call' : 'Call'}</p>
				{#if $outgoingCall.channelName}
					<p class="call-subtitle">Ringing {$outgoingCall.channelName}</p>
				{/if}
				{#if $outgoingCall.scope === 'group' && $groupCallRingingTargets.length > 0}
					<div class="ringing-targets-panel outgoing">
						<div class="ringing-targets-label">Right-click or tap a name to stop ringing that person.</div>
						<div class="ringing-targets-list">
							{#each $groupCallRingingTargets as target (target.stableUserId)}
								<button
									type="button"
									class="ringing-target-chip"
									title={`Manage ringing for ${target.username}`}
									on:click={(event) => openRingingMenu(event, target)}
									on:contextmenu={(event) => openRingingMenu(event, target)}
								>
									<span class="ringing-target-name">{target.username}</span>
									<span class="ringing-target-state">Ringing</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
			<div class="call-actions">
				<button class="reject-btn" on:click={handleCancelOutgoing}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<ContextMenu
	open={ringingMenuOpen}
	x={ringingMenuX}
	y={ringingMenuY}
	items={ringingMenuItems}
	ariaLabel="Ringing participant actions"
	headerLabel={ringingMenuTarget?.username || null}
	headerSubLabel="Group call invite"
	on:close={closeRingingMenu}
	on:select={closeRingingMenu}
/>

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
		z-index: var(--z-call-overlay);
		backdrop-filter: blur(8px);
	}

	.incoming-call-modal {
		background:
			radial-gradient(circle at 20% 15%, rgba(56, 189, 248, 0.18), transparent 50%),
			radial-gradient(circle at 80% 80%, rgba(99, 102, 241, 0.18), transparent 50%),
			#111827;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 24px 56px rgba(0, 0, 0, 0.52);
		border-radius: 20px;
		padding: 2rem;
		width: min(420px, 92vw);
		color: #fff;
	}

	.caller-info {
		text-align: center;
		margin-bottom: 1.5rem;
	}

	.caller-info h2 {
		color: #fff;
		margin: 0 0 0.25rem;
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
		box-shadow: 0 0 0 4px rgba(88, 101, 242, 0.3);
	}

	.call-type {
		margin: 0;
		color: rgba(255, 255, 255, 0.6);
	}

	.call-subtitle {
		margin: 0.35rem 0 0;
		color: rgba(255, 255, 255, 0.82);
		font-size: 0.95rem;
	}

	.ringing-targets-panel {
		margin-top: 1rem;
		padding: 0.9rem 1rem;
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.08);
	}

	.ringing-targets-panel.outgoing {
		text-align: left;
	}

	.ringing-targets-label {
		font-size: 0.8rem;
		color: rgba(255, 255, 255, 0.72);
		margin-bottom: 0.7rem;
	}

	.ringing-targets-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
	}

	.ringing-target-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.55rem 0.8rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(15, 23, 42, 0.6);
		color: inherit;
		cursor: pointer;
	}

	.ringing-target-chip:hover {
		background: rgba(30, 41, 59, 0.88);
		border-color: rgba(96, 165, 250, 0.38);
	}

	.ringing-target-name {
		font-weight: 600;
	}

	.ringing-target-state {
		font-size: 0.78rem;
		color: rgba(125, 211, 252, 0.95);
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
		z-index: var(--z-call-docked);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.8rem;
		border-radius: 12px;
		background: color-mix(in srgb, #111827 88%, black 12%);
		border: 1px solid rgba(255, 255, 255, 0.12);
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.42);
	}

	.docked-title {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		flex-wrap: wrap;
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

	.dock-btn.record {
		background: rgba(185, 28, 28, 0.18);
		border-color: rgba(248, 113, 113, 0.36);
		color: #fecaca;
	}

	.dock-btn.record.active {
		background: rgba(220, 38, 38, 0.48);
		border-color: rgba(248, 113, 113, 0.7);
	}

	.dock-btn.end {
		background: rgba(239, 68, 68, 0.2);
		border-color: rgba(239, 68, 68, 0.5);
		color: #fda4af;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.dock-btn.end svg {
		width: 14px;
		height: 14px;
		stroke: currentColor;
	}

	.call-shell {
		pointer-events: none;
		z-index: var(--z-call-shell);
	}

	.call-shell.mode-embedded {
		position: absolute;
		inset: 0;
	}

	.call-shell.mode-focus {
		position: fixed;
		inset: 0;
		z-index: var(--z-call-focus);
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
		top: 0.75rem;
		right: 0.75rem;
		z-index: var(--z-call-controls);
		width: 32px;
		height: 32px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(0, 0, 0, 0.52);
		color: #fff;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		backdrop-filter: blur(4px);
	}

	.hatch-toggle svg {
		width: 15px;
		height: 15px;
		stroke: currentColor;
	}

	.active-call-container {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: #0b1020;
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

	.recording-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.85rem;
		padding: 0.65rem 0.9rem;
		background: rgba(127, 29, 29, 0.22);
		border-bottom: 1px solid rgba(248, 113, 113, 0.18);
	}

	.recording-copy {
		font-size: 0.75rem;
		font-weight: 600;
		color: rgba(254, 226, 226, 0.88);
		text-align: right;
	}

	.recording-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.38rem 0.62rem;
		border-radius: 999px;
		background: rgba(17, 24, 39, 0.76);
		border: 1px solid rgba(248, 113, 113, 0.28);
		color: #fef2f2;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.recording-pill.compact {
		font-size: 0.68rem;
		padding: 0.2rem 0.45rem;
	}

	.recording-pill.is-saving {
		border-color: rgba(253, 224, 71, 0.3);
		color: #fef9c3;
	}

	.recording-dot {
		width: 0.56rem;
		height: 0.56rem;
		border-radius: 50%;
		background: #ef4444;
		box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
		animation: recording-pulse 1.4s infinite;
	}

	.recording-pill.is-saving .recording-dot {
		background: #facc15;
		box-shadow: none;
		animation: none;
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
		background: color-mix(in srgb, #111827 90%, black 10%);
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
			#0b1020;
		overflow: hidden;
	}

	.bubble-stage.single-bubble {
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

	.bubble-tile {
		position: absolute;
		transform: translate(-50%, -50%);
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in srgb, #111827 86%, black 14%);
		border: 2px solid transparent;
		padding: 0.35rem;
	}

	.bubble-stage.single-bubble .bubble-tile {
		position: relative;
		left: auto;
		top: auto;
		transform: none;
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
		color: rgba(255, 255, 255, 0.88);
		white-space: nowrap;
	}

	.tile-status {
		position: absolute;
		left: 0.55rem;
		top: 0.55rem;
		background: rgba(185, 28, 28, 0.85);
		color: #fff;
		padding: 0.14rem 0.36rem;
		border-radius: 6px;
		font-size: 0.62rem;
		font-weight: 700;
	}

	.call-controls {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.9rem;
		padding: 0.8rem;
		padding-bottom: calc(0.8rem + env(safe-area-inset-bottom, 0px));
		background: color-mix(in srgb, #111827 90%, black 10%);
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}

	.control-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.control-btn {
		width: 40px;
		height: 40px;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		flex-shrink: 0;
	}

	.control-btn svg {
		width: 17px;
		height: 17px;
		stroke: currentColor;
		flex-shrink: 0;
	}

	.control-btn.active {
		background: color-mix(in srgb, var(--accent, #5865f2) 35%, transparent);
		border-color: color-mix(in srgb, var(--accent, #5865f2) 65%, transparent);
	}

	.control-btn.record {
		background: rgba(127, 29, 29, 0.22);
		border-color: rgba(248, 113, 113, 0.36);
		color: #fecaca;
	}

	.control-btn.record.active {
		background: rgba(220, 38, 38, 0.46);
		border-color: rgba(248, 113, 113, 0.72);
		color: #fff1f2;
	}

	.control-btn.record.is-saving {
		background: rgba(161, 98, 7, 0.26);
		border-color: rgba(250, 204, 21, 0.52);
		color: #fef3c7;
	}

	.control-btn.end {
		background: rgba(239, 68, 68, 0.2);
		border-color: rgba(239, 68, 68, 0.5);
		color: #fda4af;
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

	.route-status {
		position: absolute;
		top: 2.2rem;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(0, 0, 0, 0.56);
		padding: 0.25rem 0.52rem;
		border-radius: 8px;
		font-size: 0.66rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.88);
		z-index: 3;
		white-space: nowrap;
	}

	.recording-status {
		position: absolute;
		top: 3.9rem;
		left: 50%;
		transform: translateX(-50%);
		max-width: min(92vw, 900px);
		background: rgba(0, 0, 0, 0.56);
		padding: 0.25rem 0.52rem;
		border-radius: 8px;
		font-size: 0.66rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.88);
		z-index: 3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.recording-status.is-error {
		color: #fecaca;
		background: rgba(127, 29, 29, 0.62);
	}

	@keyframes recording-pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
		}
		70% {
			box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
		}
	}

	@media (max-width: 900px) {
		.call-shell.mode-focus.hatch-open .active-call-container {
			inset: 0.45rem;
			border-radius: 14px;
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
