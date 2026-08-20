<script lang="ts">
	import { fade } from 'svelte/transition';
	import { socket, getSocket, users, currentUser, currentChannel, channels, voiceChannelMembers } from '$lib/socket';
	import { brandName } from '$lib/branding';
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
		canScreenShare,
		localStream,
		listeningVoiceChannels,
		connectionState,
		callTransportState,
		spatialAudioRuntimeStatus,
		toggleSpatialAudioEnabled,
		callOfflineNotice
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
		formatRecordingElapsed,
		formatRecordingPresenceCopy,
		hashString,
		isSameIdList,
		isSameSpeakerState,
		sanitizePinnedIds
	} from './callModalHelpers';
	import {
		buildActiveSpeakerLevels,
		buildParticipants,
		buildRenderTiles,
		buildRosterParticipants,
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
	import {
		PRESENTER_OVERLAY_COLORS,
		PRESENTER_OVERLAY_WIDTHS,
		clonePresenterOverlayElements,
		type PresenterOverlayElement,
		type PresenterOverlayTool
	} from '$lib/calling/presenterOverlay';
	import PresenterOverlayCanvas from './PresenterOverlayCanvas.svelte';
	import CallParticipantGrid from './CallParticipantGrid.svelte';
	import CallControls from './CallControls.svelte';
	import CallRecordingPanel from './CallRecordingPanel.svelte';
	import IncomingCallModal from './IncomingCallModal.svelte';
	import OutgoingCallModal from './OutgoingCallModal.svelte';
	import { onDestroy, afterUpdate } from 'svelte';

	type CallViewportMode = 'embedded' | 'focus' | 'docked';

	let callNotification: Notification | null = null;
	let lastIncomingCallToken: string | null = null;
	let lastRingtoneToken: string | null = null;
	let callViewportMode: CallViewportMode = 'docked';
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
	let presenterOverlayVisible = false;
	let presenterOverlayTool: PresenterOverlayTool = 'pen';
	let presenterOverlayColor: string = PRESENTER_OVERLAY_COLORS[0];
	let presenterOverlayStrokeWidth: number = PRESENTER_OVERLAY_WIDTHS[1];
	let activePresenterOverlayTileId = '';
	let presenterOverlayElementsByTile: Record<string, PresenterOverlayElement[]> = {};
	let presenterOverlayUndoByTile: Record<string, PresenterOverlayElement[][]> = {};
	let presenterOverlayRedoByTile: Record<string, PresenterOverlayElement[][]> = {};

	const PRESENTER_OVERLAY_MAX_HISTORY = 24;
	const presenterOverlayTools: PresenterOverlayTool[] = ['pen', 'arrow', 'rect', 'ellipse'];

	$: spatialAudioActive = $spatialAudioRuntimeStatus.active;
	$: spatialQuickToggleVisible = $spatialAudioRuntimeStatus.quickToggleVisible;
	$: showDockedBar = $isInCall && callViewportMode === 'docked';
	$: showCallShell = $isInCall && callViewportMode !== 'docked';
	$: showHatchToggle = $isInCall && callViewportMode !== 'docked';
	// Resolve the real channel name — joinVoiceChannel stores the raw id in
	// activeVoiceChannel, so look the display name up in the channel list.
	$: activeVoiceChannelName =
		$channels.find((channel) => channel.id === $activeVoiceChannel?.id)?.name ??
		$activeVoiceChannel?.name ??
		'';
	$: focusHatchInsetLeft = !$layoutStore.isMobile && $layoutStore.navDock === 'left' ? $layoutStore.channelSidebarWidth : 0;
	$: focusHatchInsetRight = !$layoutStore.isMobile
		? ($layoutStore.navDock === 'right' ? $layoutStore.channelSidebarWidth : 0) + ($layoutStore.showRightPanel ? $layoutStore.rightPanelWidth : 0)
		: 0;

	$: participants = [...buildParticipants($activeCalls, $isInCall, $localStream, $isVideoOff), ...rosterParticipants];
	$: rosterParticipants = (() => {
		const channelId = $activeVoiceChannel?.id;
		if (!channelId) return [];
		const members = $voiceChannelMembers[channelId] || [];
		const selfId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : ($currentUser?.id || '');
		const existingIds = new Set($activeCalls.map((c) => c.userId));
		existingIds.add(selfId);
		return buildRosterParticipants(
			members.filter((m) => m.userId !== selfId),
			existingIds
		);
	})();
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
	$: presenterOverlayAvailable = orderedTiles.some((tile) => tile.kind === 'screen');
	$: presenterOverlayPreferredTileId =
		layoutResult.heroIds.find((tileId) => tileById.get(tileId)?.kind === 'screen') ||
		orderedTiles.find((tile) => tile.kind === 'screen')?.id ||
		'';
	$: if (!presenterOverlayAvailable) {
		presenterOverlayVisible = false;
		activePresenterOverlayTileId = '';
	} else if (
		!activePresenterOverlayTileId ||
		!orderedTiles.some((tile) => tile.id === activePresenterOverlayTileId && tile.kind === 'screen')
	) {
		activePresenterOverlayTileId = presenterOverlayPreferredTileId;
	}
	$: activePresenterOverlayElements = activePresenterOverlayTileId
		? presenterOverlayElementsByTile[activePresenterOverlayTileId] || []
		: [];
	$: presenterOverlayCanUndo =
		Boolean(activePresenterOverlayTileId) &&
		(presenterOverlayUndoByTile[activePresenterOverlayTileId]?.length || 0) > 0;
	$: presenterOverlayCanRedo =
		Boolean(activePresenterOverlayTileId) &&
		(presenterOverlayRedoByTile[activePresenterOverlayTileId]?.length || 0) > 0;
	$: presenterOverlayActiveLabel =
		(activePresenterOverlayTileId && tileById.get(activePresenterOverlayTileId)?.label) || 'Screen';
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
			callViewportMode = 'docked';
			channelCallPanelOpen.set(false);
			hatchOpen = false;
			pinnedTileIds = [];
			activeSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
			presenterOverlayVisible = false;
			presenterOverlayTool = 'pen';
			presenterOverlayColor = PRESENTER_OVERLAY_COLORS[0];
			presenterOverlayStrokeWidth = PRESENTER_OVERLAY_WIDTHS[1];
			activePresenterOverlayTileId = '';
			presenterOverlayElementsByTile = {};
			presenterOverlayUndoByTile = {};
			presenterOverlayRedoByTile = {};
		}
		if (!$isInCall && wasInCall) {
			callViewportMode = 'docked';
			hatchOpen = false;
			pinnedTileIds = [];
			activeSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
			presenterOverlayVisible = false;
			presenterOverlayTool = 'pen';
			presenterOverlayColor = PRESENTER_OVERLAY_COLORS[0];
			presenterOverlayStrokeWidth = PRESENTER_OVERLAY_WIDTHS[1];
			activePresenterOverlayTileId = '';
			presenterOverlayElementsByTile = {};
			presenterOverlayUndoByTile = {};
			presenterOverlayRedoByTile = {};
		}
		wasInCall = $isInCall;
	}

	// Docked-first (voice UX contract): joining/answering never springs the
	// fullscreen shell. The docked bar is the resting state; the user expands
	// explicitly via the docked bar's Open/Focus buttons (setViewportMode)
	// or by clicking an already-connected voice channel in the sidebar
	// (openChannelCallPanel — user intent only, safe: every join/answer
	// path sets channelCallPanelOpen(false), so this can never fire on join).
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
			localDisplayName: $currentUser?.username || `${brandName} User`
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
			try {
				await startScreenShare($socket);
			} catch {
				// startScreenShare already logs; swallow here to prevent PWA crash
			}
		}
	}

	function resolveWhiteboardCaptureChannelId(): string {
		return $activeVoiceChannel?.id || $currentChannel;
	}

	function openWhiteboardFromCall(): void {
		const channelId = resolveWhiteboardCaptureChannelId();
		if (!channelId) {
			setCaptureFeedback('Open or join a channel before using the whiteboard.');
			return;
		}
		currentChannel.set(channelId);
		openWhiteboardSurface(channelId);
		setCaptureFeedback('Whiteboard opened for this call.');
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

	function getPresenterOverlayElements(tileId: string): PresenterOverlayElement[] {
		return presenterOverlayElementsByTile[tileId] || [];
	}

	function setPresenterOverlayElements(
		tileId: string,
		nextElements: PresenterOverlayElement[],
		options: { recordHistory?: boolean } = {}
	): void {
		if (!tileId) return;
		const { recordHistory = true } = options;
		const previous = clonePresenterOverlayElements(getPresenterOverlayElements(tileId));
		const next = clonePresenterOverlayElements(nextElements);

		presenterOverlayElementsByTile = {
			...presenterOverlayElementsByTile,
			[tileId]: next
		};

		if (!recordHistory) return;

		const nextUndo = [...(presenterOverlayUndoByTile[tileId] || []), previous];
		while (nextUndo.length > PRESENTER_OVERLAY_MAX_HISTORY) nextUndo.shift();
		presenterOverlayUndoByTile = {
			...presenterOverlayUndoByTile,
			[tileId]: nextUndo
		};
		presenterOverlayRedoByTile = {
			...presenterOverlayRedoByTile,
			[tileId]: []
		};
	}

	function activatePresenterOverlayTile(tileId: string): void {
		if (!tileId) return;
		activePresenterOverlayTileId = tileId;
	}

	function togglePresenterOverlay(): void {
		if (!presenterOverlayAvailable) return;
		presenterOverlayVisible = !presenterOverlayVisible;
		if (presenterOverlayVisible && !activePresenterOverlayTileId) {
			activePresenterOverlayTileId = presenterOverlayPreferredTileId;
		}
	}

	function clearPresenterOverlay(): void {
		if (!activePresenterOverlayTileId || activePresenterOverlayElements.length === 0) return;
		setPresenterOverlayElements(activePresenterOverlayTileId, []);
	}

	function undoPresenterOverlay(): void {
		if (!activePresenterOverlayTileId) return;
		const undoStack = [...(presenterOverlayUndoByTile[activePresenterOverlayTileId] || [])];
		if (undoStack.length === 0) return;
		const previous = undoStack.pop() || [];
		const current = clonePresenterOverlayElements(getPresenterOverlayElements(activePresenterOverlayTileId));
		presenterOverlayUndoByTile = {
			...presenterOverlayUndoByTile,
			[activePresenterOverlayTileId]: undoStack
		};
		presenterOverlayRedoByTile = {
			...presenterOverlayRedoByTile,
			[activePresenterOverlayTileId]: [
				...(presenterOverlayRedoByTile[activePresenterOverlayTileId] || []),
				current
			]
		};
		presenterOverlayElementsByTile = {
			...presenterOverlayElementsByTile,
			[activePresenterOverlayTileId]: clonePresenterOverlayElements(previous)
		};
	}

	function redoPresenterOverlay(): void {
		if (!activePresenterOverlayTileId) return;
		const redoStack = [...(presenterOverlayRedoByTile[activePresenterOverlayTileId] || [])];
		if (redoStack.length === 0) return;
		const next = redoStack.pop() || [];
		const current = clonePresenterOverlayElements(getPresenterOverlayElements(activePresenterOverlayTileId));
		presenterOverlayRedoByTile = {
			...presenterOverlayRedoByTile,
			[activePresenterOverlayTileId]: redoStack
		};
		presenterOverlayUndoByTile = {
			...presenterOverlayUndoByTile,
			[activePresenterOverlayTileId]: [
				...(presenterOverlayUndoByTile[activePresenterOverlayTileId] || []),
				current
			]
		};
		presenterOverlayElementsByTile = {
			...presenterOverlayElementsByTile,
			[activePresenterOverlayTileId]: clonePresenterOverlayElements(next)
		};
	}

	function escapeAttributeSelectorValue(value: string): string {
		if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
			return CSS.escape(value);
		}
		return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	}

	function findPresenterOverlayTileElement(tileId: string): HTMLElement | null {
		if (!callStageElement || !tileId) return null;
		return callStageElement.querySelector(
			`.media-tile[data-tile-id="${escapeAttributeSelectorValue(tileId)}"]`
		) as HTMLElement | null;
	}

	function findCompositeCaptureTile(): HTMLElement | null {
		if (!presenterOverlayVisible || !activePresenterOverlayTileId) return null;
		return findPresenterOverlayTileElement(activePresenterOverlayTileId);
	}

	async function captureCompositeTileFrame(tileElement: HTMLElement): Promise<Blob> {
		const video = tileElement.querySelector('video.tile-video') as HTMLVideoElement | null;
		if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
			throw new Error('No active screen frame is ready to capture.');
		}

		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			throw new Error('Capture canvas is unavailable.');
		}

		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		const overlayCanvas = tileElement.querySelector(
			'canvas[data-presenter-overlay-canvas="true"]'
		) as HTMLCanvasElement | null;
		if (overlayCanvas) {
			ctx.drawImage(overlayCanvas, 0, 0, canvas.width, canvas.height);
		}

		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((nextBlob) => {
				if (nextBlob) resolve(nextBlob);
				else reject(new Error('Unable to serialize captured frame.'));
			}, 'image/png');
		});
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
			const compositeTile = findCompositeCaptureTile();
			const blob = compositeTile
				? await captureCompositeTileFrame(compositeTile)
				: await new Promise<Blob>((resolve, reject) => {
					const canvas = document.createElement('canvas');
					canvas.width = video.videoWidth;
					canvas.height = video.videoHeight;
					const ctx = canvas.getContext('2d');
					if (!ctx) {
						reject(new Error('Capture canvas is unavailable.'));
						return;
					}
					ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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

	function minimizeToDocked(): void {
		callViewportMode = 'docked';
		channelCallPanelOpen.set(false);
		hatchOpen = false;
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
	<IncomingCallModal
		caller={$incomingCall}
		groupCallRingingTargets={$groupCallRingingTargets}
		scope={$incomingCall.channelId ? 'group' : 'direct'}
		onAnswer={handleAnswer}
		onReject={handleReject}
		onOpenRingingMenu={openRingingMenu}
	/>
{/if}

{#if $callOfflineNotice}
	<div class="call-offline-banner" transition:fade={{ duration: 160 }} role="alert">
		{$callOfflineNotice}
		<button
			class="call-offline-dismiss"
			on:click={() => callOfflineNotice.set(null)}
			title="Dismiss"
			aria-label="Dismiss call notice"
		>×</button>
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
	<div class="docked-bar" class:connected={$callMode === 'channel'} role="region" aria-label="Docked call controls">
		<div class="docked-status">
			<span class="docked-voice-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
			</span>
			<div class="docked-info">
				<span class="docked-channel">
					{#if $callMode === 'channel'}
						{activeVoiceChannelName || 'Voice channel'}
					{:else}
						Call in progress
					{/if}
				</span>
				<span class="docked-meta">
					{voiceRouteText || `${1 + $activeCalls.length} participant${$activeCalls.length === 0 ? '' : 's'}`}
				</span>
			</div>
			{#if recordingPillText}
				<span class="recording-pill compact" class:is-saving={$callRecordingState.status === 'saving'}>
					<span class="recording-dot"></span>
					{recordingPillText}
				</span>
			{/if}
		</div>
		<div class="docked-actions">
			<button class="dock-btn" on:click={() => setViewportMode('embedded')} title="Open call view">Open</button>
			<button class="dock-btn" on:click={() => setViewportMode('focus')} title="Focus call">Focus</button>
			<button class="dock-btn" class:active={$isMuted} on:click={handleToggleMute} title={$isMuted ? 'Unmute' : 'Mute'}>Mute</button>
			<button class="dock-btn" class:active={$isDeafened} on:click={handleToggleDeafen} title={$isDeafened ? 'Undeafen' : 'Deafen'}>Deafen</button>
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
			{#if callViewportMode === 'embedded'}
				<button
					type="button"
					class="hatch-toggle minimize"
					on:click={minimizeToDocked}
					title="Minimize to voice bar"
					aria-label="Minimize call to voice bar"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
				</button>
			{/if}
		{/if}

		<div class="active-call-container">
			{#if showRecordingPresenceBanner}
				<CallRecordingPanel recordingState={$callRecordingState} {recordingPresenceCopy} {recordingPillText} />
			{/if}
			<div class="call-stage" bind:this={callStageElement}>
				<CallParticipantGrid
					{orderedTiles}
					layoutTemplate={layoutResult.template}
					{pinnedTileIds}
					isSpeaking={isTileSpeaking}
					{getParticipantAvatarUrl}
					{getInitial}
					onPin={togglePin}
					{isTileDisconnected}
					{presenterOverlayVisible}
					{activePresenterOverlayTileId}
					{presenterOverlayTool}
					{presenterOverlayColor}
					{presenterOverlayStrokeWidth}
					presenterOverlayElementsByTile={presenterOverlayElementsByTile}
					onPresenterOverlayChange={(tileId, elements) => setPresenterOverlayElements(tileId, elements)}
					onPresenterOverlayActivate={(tileId) => activatePresenterOverlayTile(tileId)}
					heroIds={layoutResult.heroIds}
				/>
			</div>

			<CallControls
				isMuted={$isMuted}
				isDeafened={$isDeafened}
				isVideoOff={$isVideoOff}
				isSharing={$isSharing}
				canScreenShare={canScreenShare()}
				{captureAvailable}
				{captureBusy}
				callRecordingStatus={$callRecordingState.status}
				{presenterOverlayVisible}
				{presenterOverlayAvailable}
				{presenterOverlayCanUndo}
				{presenterOverlayCanRedo}
				{presenterOverlayTool}
				{presenterOverlayColor}
				{presenterOverlayStrokeWidth}
				onToggleMute={handleToggleMute}
				onToggleDeafen={handleToggleDeafen}
				onToggleVideo={handleToggleVideo}
				onToggleScreenShare={handleToggleScreenShare}
				onTogglePresenterOverlay={togglePresenterOverlay}
				onCaptureToWhiteboard={handleCaptureToWhiteboard}
				onOpenWhiteboard={openWhiteboardFromCall}
				onToggleRecording={handleToggleRecording}
				onEndCall={handleEndCall}
				onPresenterOverlayToolChange={(tool) => (presenterOverlayTool = tool)}
				onPresenterOverlayColorChange={(color) => (presenterOverlayColor = color)}
				onPresenterOverlayStrokeWidthChange={(width) => (presenterOverlayStrokeWidth = width)}
				onPresenterOverlayUndo={undoPresenterOverlay}
				onPresenterOverlayRedo={redoPresenterOverlay}
				onPresenterOverlayClear={clearPresenterOverlay}
			/>

			{#if $connectionState && $connectionState !== 'idle'}
				<div class="connection-status">Connection: {$connectionState}</div>
			{/if}
			{#if voiceRouteText}
				<div class="route-status">{voiceRouteText}</div>
			{/if}
			{#if recordingLabel}
				<CallRecordingPanel recordingState={$callRecordingState} {recordingLabel} />
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
	<OutgoingCallModal
		caller={$outgoingCall}
		groupCallRingingTargets={$groupCallRingingTargets}
		onCancel={handleCancelOutgoing}
		onOpenRingingMenu={openRingingMenu}
	/>
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

