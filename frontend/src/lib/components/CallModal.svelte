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
		channelCallPanelSessionId,
		activeVoiceChannel,
		activeGroupCall,
		isMuted,
		isDeafened,
		isVideoOff,
		isLocalSpeaking,
		activeCalls,
		isSharing,
		callMode,
		answerCall,
		cancelOutgoingCall,
		rejectCall,
		dismissChannelCallPanel,
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
		spatialAudioDiagnostics,
		spatialSeatDebugState,
		toggleSpatialAudioEnabled,
		callOfflineNotice
	} from '$lib/calling';
	import {
		selectedRemoteVideo as wabidbRemoteVideoStreams,
		selectedLocalVideo as wabidbLocalPreviewStreams,
		selectedLocalVideoActive as wabidbLocalVideoActive,
		selectedScreenShares as screenShares,
		selectedLocalScreenStream as localScreenStream
	} from '$lib/callingVideoState';
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
		sanitizePinnedIds,
		debugSeatStyle,
		listMediaDevices,
		selectAudioOutput,
		type MediaDeviceGroups
	} from './callModalHelpers';
	import {
		buildActiveSpeakerLevels,
		buildParticipants,
		buildRenderTiles,
		buildWabidbAwareParticipants,
		buildWabidbScreenShares,
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
	import { callRecordingState, startCallRecording, stopCallRecording, confirmLeaveWhileRecording } from '$lib/callRecording';
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
	import CallStage from './CallStage.svelte';
	import { callSessions, focusedCallSessionId } from '$lib/callSessionManager';
	import { leaveCall as leaveViewedCall } from '$lib/callSurfaces';
	import CallControls from './CallControls.svelte';
	import CallRecordingPanel from './CallRecordingPanel.svelte';
	import IncomingCallModal from './IncomingCallModal.svelte';
	import OutgoingCallModal from './OutgoingCallModal.svelte';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';
	import Tooltip from './ui/Tooltip.svelte';
	import type { MenuEntry } from './context-menu/ContextMenu.svelte';
	import {
		connectionWords,
		peopleCountLabel,
		recordingReadout,
		sessionConnectionState
	} from '$lib/callShell';
	import { onDestroy, afterUpdate, onMount } from 'svelte';

	type CallViewportMode = 'embedded' | 'focus' | 'docked';

	/** Developer instruments (spatial seat debug, relay counters) exist only in dev builds (§9.4). */
	const isDevBuild = import.meta.env.DEV;

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
	let showSpatialDebugOverlay = false;
	/** The spatial seat map lives in the stage; it is opened from the header's Call options. */
	let spatialSeatsOpen = false;

	let mediaDevices: MediaDeviceGroups | null = null;
	let selectedAudioInputId: string | null = null;
	let selectedAudioOutputId: string | null = null;
	let mediaDevicesLoaded = false;

	const STORAGE_AUDIO_INPUT = 'wabi-call-audio-input';
	const STORAGE_AUDIO_OUTPUT = 'wabi-call-audio-output';

	onMount(() => {
		try {
			const storedInput = localStorage.getItem(STORAGE_AUDIO_INPUT);
			const storedOutput = localStorage.getItem(STORAGE_AUDIO_OUTPUT);
			if (storedInput) selectedAudioInputId = storedInput;
			if (storedOutput) selectedAudioOutputId = storedOutput;
		} catch {
			/* localStorage may be unavailable */
		}
	});

	async function handleOpenDevicePicker() {
		if (mediaDevicesLoaded) return;
		mediaDevicesLoaded = true;
		mediaDevices = await listMediaDevices();
	}

	async function handleSelectDevice(kind: 'audioinput' | 'audiooutput', deviceId: string) {
		if (kind === 'audioinput') {
			selectedAudioInputId = deviceId;
			try {
				localStorage.setItem(STORAGE_AUDIO_INPUT, deviceId);
			} catch {
				/* ignore */
			}
		} else {
			selectedAudioOutputId = deviceId;
			try {
				localStorage.setItem(STORAGE_AUDIO_OUTPUT, deviceId);
			} catch {
				/* ignore */
			}
			await selectAudioOutput(deviceId);
		}
	}

	const PRESENTER_OVERLAY_MAX_HISTORY = 24;
	const presenterOverlayTools: PresenterOverlayTool[] = ['pen', 'arrow', 'rect', 'ellipse'];

	$: spatialAudioActive = $spatialAudioRuntimeStatus.active;
	$: spatialQuickToggleVisible = $spatialAudioRuntimeStatus.quickToggleVisible;
	// Stage targeting (2026-09-07): the panel shows the session the user
	// clicked from the roster, falling back to the focused session. Lets a
	// BACKGROUND channel call be viewed without changing transmit focus.
	$: stageSession = (() => {
		const targeted = $channelCallPanelSessionId;
		if (targeted) {
			const session = $callSessions.get(targeted);
			if (session) return session;
		}
		return $focusedCallSessionId ? $callSessions.get($focusedCallSessionId) : null;
	})();
	$: hasChannelStage = Boolean(stageSession && stageSession.kind === 'channel');
	// Channel stage counts as a live surface even when the legacy isInCall
	// flag is false (listen-only joins never set it).
	$: callSurfaceLive = $isInCall || hasChannelStage;
	// The docked bar is the minimized DM / group call. A minimized channel call (or a listen-only
	// room, which never sets isInCall) lives in the sidebar's voice status and the Calls panel.
	$: showDockedBar = $isInCall && callViewportMode === 'docked' && $callMode !== 'channel';
	$: showCallShell = callSurfaceLive && callViewportMode !== 'docked';
	// Resolve the real channel name — joinVoiceChannel stores the raw id in
	// activeVoiceChannel, so look the display name up in the channel list.
	$: activeVoiceChannelName =
		$channels.find((channel) => channel.id === $activeVoiceChannel?.id)?.name ??
		$activeVoiceChannel?.name ??
		'';
	// Full window with the hatch open leaves the sidebar and the companion column visible. The
	// companion's real reserved width is the shell's --w-dock-w (0 for a stowed pin) plus the rail,
	// read in CSS; only the sidebar side is known here.
	$: focusHatchInsetLeft = !$layoutStore.isMobile && $layoutStore.navDock === 'left' ? $layoutStore.channelSidebarWidth : 0;
	$: focusHatchInsetRight = !$layoutStore.isMobile && $layoutStore.navDock === 'right' ? $layoutStore.channelSidebarWidth : 0;

	// Header (§8.5): the room's name, how many people, and connection trouble in plain words.
	$: stageChannelId = hasChannelStage && stageSession ? (stageSession.channelId ?? stageSession.id) : null;
	$: callTitle = stageChannelId && stageSession
		? ($channels.find((channel) => channel.id === stageChannelId)?.name ?? stageSession.name ?? 'Voice room')
		: $callMode === 'group'
			? ($activeGroupCall?.name || 'Group call')
			: $activeCalls[0]?.username
				? `Call with ${$activeCalls[0].username}`
				: $callMode === 'channel' && activeVoiceChannelName
					? activeVoiceChannelName
					: 'Call';
	$: callPeopleCount = stageChannelId && stageSession
		? (($voiceChannelMembers[stageChannelId] ?? []).length || stageSession.participants.length)
		: $callMode === 'channel' && $activeVoiceChannel?.id
			? (($voiceChannelMembers[$activeVoiceChannel.id] ?? []).length || 1 + $activeCalls.length)
			: 1 + $activeCalls.length;
	$: callPeopleLabel = peopleCountLabel(callPeopleCount);
	$: callStatusWords = connectionWords(
		stageChannelId && stageSession && !$isInCall ? sessionConnectionState(stageSession.lifecycle) : $connectionState
	);
	$: compactDock = $layoutStore.isMobile;
	// The camera store defaults to "on" outside a call; a listen-only room has no camera to show.
	$: cameraOn = $isInCall && !$isVideoOff;
	$: callOptionsItems = [
		{
			id: 'spatial',
			label: 'Spatial hearing',
			role: 'menuitemcheckbox',
			checked: spatialAudioActive,
			hint: 'Places voices around you',
			onSelect: toggleSpatialAudioEnabled
		},
		{
			id: 'seats',
			label: 'Arrange seats',
			icon: 'users',
			hidden: !(hasChannelStage && spatialAudioActive),
			onSelect: () => {
				spatialSeatsOpen = true;
			}
		},
		{ id: 'sep-settings', type: 'separator' },
		{
			id: 'audio-settings',
			label: 'Audio settings',
			icon: 'gear',
			onSelect: () => {
				window.dispatchEvent(new CustomEvent('wabi:open-settings', { detail: { tab: 'audio' } }));
			}
		},
		{ id: 'dev', type: 'kicker', label: 'Developer', hidden: !isDevBuild },
		{
			id: 'spatial-debug',
			label: 'Spatial debug overlay',
			role: 'menuitemcheckbox',
			checked: showSpatialDebugOverlay,
			hidden: !isDevBuild,
			onSelect: handleToggleSpatialDebug
		}
	] satisfies MenuEntry[];

	$: participants = buildWabidbAwareParticipants(
		buildParticipants($activeCalls, $isInCall, $localStream, $isVideoOff),
		$wabidbRemoteVideoStreams,
		$wabidbLocalVideoActive ? ($wabidbLocalPreviewStreams.get('camera') ?? null) : null,
		$wabidbLocalVideoActive ? ($wabidbLocalPreviewStreams.get('screen') ?? null) : null,
		$voiceChannelMembers
	);
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
	$: shares = (() => {
		// Roster + call labels for wabidb share tiles ("Alice's Screen" instead
		// of the generic "Shared Screen" — the lane keys carry only ids).
		const displayNames: Record<string, string> = {};
		for (const memberList of Object.values($voiceChannelMembers)) {
			for (const member of memberList) {
				if (member.username) displayNames[member.userId] = member.username;
			}
		}
		for (const call of $activeCalls) {
			if (call.username) displayNames[call.userId] = call.username;
		}
		const base = buildShares($screenShares, $isSharing, $localScreenStream);
		const wabidbShares = buildWabidbScreenShares(
			$wabidbRemoteVideoStreams,
			$wabidbLocalVideoActive ? ($wabidbLocalPreviewStreams.get('screen') ?? null) : null,
			displayNames
		);
		if (wabidbShares.length === 0) return base;
		// Prefer the wabidb local screen preview over the P2P one when both exist.
		const merged = [
			...base.filter((s) => !(s.isLocal && s.id === 'local' && wabidbShares.some((w) => w.isLocal))),
			...wabidbShares.filter((w) => !w.isLocal)
		];
		const seen = new Set<string>();
		return merged.filter((s) => (seen.has(s.participantId + (s.isLocal ? ':local' : '')) ? false : (seen.add(s.participantId + (s.isLocal ? ':local' : '')), true)));
	})();
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
	// One readout for everyone in the call: "Recording 02:14" (§8.5, §9.5).
	$: recordingPillText = recordingReadout(
		$callRecordingState.status,
		formatRecordingElapsed($callRecordingState.elapsedMs),
		activeRecordingCount
	);
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
	// Transport and route details are developer diagnostics (dev builds only, §9.4).
	$: devRouteText = !isDevBuild
		? ''
		: $callMode === 'direct' && $isInCall
			? $callTransportState.reason === 'direct_call_turn_unconfigured'
				? 'Direct call: STUN only, no TURN relay configured on this server'
				: 'Direct call: peer-to-peer with TURN fallback'
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
			// Auto-spawn contract: the join path itself decides whether the panel
			// opens (autoOpenChannelCallPanel) — do NOT force it closed here.
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
			showSpatialDebugOverlay = false;
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
			showSpatialDebugOverlay = false;
		}
		wasInCall = $isInCall;
	}
	$: if (!$isInCall && showSpatialDebugOverlay) {
		showSpatialDebugOverlay = false;
	}

	// Auto-spawn (decision 2026-08-26, reverses docked-first): every join/answer
	// path opens the embedded panel via autoOpenChannelCallPanel, and this
	// transition docks it in when the store flips true while in-call. Leaving
	// the call auto-dissolves it via the teardown paths. The sidebar's
	// openChannelCallPanel click remains user intent and keeps working.
	$: if (callSurfaceLive && $channelCallPanelOpen && callViewportMode === 'docked') {
		callViewportMode = 'embedded';
	}

	// Auto-dock when the user navigates away from the voice channel to a text channel
	$: {
		if (wasChannelPanelOpen && !$channelCallPanelOpen && callSurfaceLive && callViewportMode !== 'docked') {
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
		if (stageSession) {
			// Viewing a background call is not a request to hang up the
			// foreground group/direct call. The shared action retains the
			// recording guard and supports offline voice-intent cancellation.
			if (!leaveViewedCall(stageSession)) return;
		} else {
			const sock = $socket || getSocket();
			if (!sock || !confirmLeaveWhileRecording()) return;
			endCall(sock);
		}
		hatchOpen = false;
		pinnedTileIds = [];
	}

	function handleToggleMute() {
		toggleMute();
	}

	function handleToggleDeafen() {
		toggleDeafen();
	}

	function handleToggleSpatialDebug(): void {
		showSpatialDebugOverlay = !showSpatialDebugOverlay;
		// The debug overlay only renders inside the expanded call shell, so
		// spring the docked bar open if the user enabled it from docked state.
		if (showSpatialDebugOverlay && callViewportMode === 'docked') {
			setViewportMode('embedded');
		}
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
			// User-initiated minimize: sticky for the rest of this call.
			dismissChannelCallPanel();
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
		dismissChannelCallPanel();
		hatchOpen = false;
	}

	/** Full window fills the app window above every column; pressing it again returns to the stage. */
	function toggleFullWindow(): void {
		setViewportMode(callViewportMode === 'focus' ? 'embedded' : 'focus');
	}

	function closeHatch(): void {
		hatchOpen = false;
	}

	// --- WO-1b/WO-2a: audio + video relay diagnostics (Diag overlay row) ------
	let relayDiagTimer: ReturnType<typeof setInterval> | null = null;
	let relayAudioDiag = '';
	let relayVideoDiag = '';

	function refreshRelayDiagnostics(): void {
		void import('$lib/callingWabidb').then(
			({ getWabidbRelayDiagnostics, getWabidbLaneDiagnostics, formatWabidbLaneDiagnostics }) => {
				const relays = getWabidbRelayDiagnostics();
				let recv = 0;
				let dec = 0;
				let play = 0;
				let fail = 0;
			 let sent = 0;
				let ctx: string | null = null;
				for (const r of relays) {
					recv += r.recvEnvelopes ?? 0;
					sent += r.sentEnvelopes ?? 0;
					dec += r.decodeOk ?? 0;
					fail += r.decodeFail ?? 0;
					play += r.playedChunks ?? 0;
					ctx = ctx ?? r.audioContextState ?? null;
				}
				relayAudioDiag = `Audio: tx=${sent} rx=${recv} dec=${dec} play=${play}${fail ? ` err=${fail}` : ''} (ctx=${ctx ?? 'n/a'})`;
				relayVideoDiag = formatWabidbLaneDiagnostics(getWabidbLaneDiagnostics());
			}
		);
	}

	function startRelayDiagPolling(): void {
		if (relayDiagTimer) return;
		refreshRelayDiagnostics();
		relayDiagTimer = setInterval(refreshRelayDiagnostics, 1000);
	}

	function stopRelayDiagPolling(): void {
		if (relayDiagTimer) {
			clearInterval(relayDiagTimer);
			relayDiagTimer = null;
		}
		relayAudioDiag = '';
		relayVideoDiag = '';
	}

	$: if ($isInCall && showSpatialDebugOverlay) startRelayDiagPolling();
	$: if (!$isInCall || !showSpatialDebugOverlay) stopRelayDiagPolling();

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
		stopRelayDiagPolling();
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
	<div class="call-offline-banner w-notice w-notice--warn" transition:fade={{ duration: 160 }} role="alert">
		<Icon name="warn" size={16} />
		<p class="w-notice__title">{$callOfflineNotice}</p>
		<div class="w-notice__actions">
			<button
				type="button"
				class="w-ibtn w-ibtn--sm"
				on:click={() => callOfflineNotice.set(null)}
				title="Dismiss"
				aria-label="Dismiss call notice"
			><Icon name="x" size={16} /></button>
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
	<!-- The minimized DM / group call: one small card with the call's name, its people and the
	     controls you reach for without opening it (§7.26). -->
	<div class="docked-bar" role="region" aria-label={`Call: ${callTitle}`}>
		<div class="docked-status">
			<span class="docked-live" aria-hidden="true"></span>
			<div class="docked-info">
				<span class="docked-channel">{callTitle}</span>
				<span class="docked-meta">{callPeopleLabel}{#if callStatusWords} · {callStatusWords}{/if}</span>
			</div>
			{#if recordingPillText}
				<span class="recording-pill" class:is-saving={$callRecordingState.status === 'saving'} role="status">
					<span class="recording-dot" aria-hidden="true"></span>
					{recordingPillText}
				</span>
			{/if}
		</div>
		<div class="docked-actions">
			<button type="button" class="w-btn w-btn--sm" on:click={() => setViewportMode('embedded')}>Open</button>
			<button
				type="button"
				class="w-ibtn docked-mic"
				aria-label="Mute microphone"
				aria-pressed={$isMuted}
				title="Mute microphone"
				on:click={handleToggleMute}
			><Icon name={$isMuted ? 'micOff' : 'mic'} /></button>
			<button
				type="button"
				class="w-ibtn"
				aria-label="Deafen"
				aria-pressed={$isDeafened}
				title="Deafen"
				on:click={handleToggleDeafen}
			><Icon name={$isDeafened ? 'headphonesOff' : 'headphones'} /></button>
			<button type="button" class="w-btn w-btn--danger w-btn--sm docked-leave" on:click={handleEndCall}>
				<Icon name="phoneOff" />Leave
			</button>
		</div>
	</div>
{/if}

{#if showCallShell}
	<!-- Embedded: center stage below the masthead (folio and channel context stay). Full window:
	     the same call over the whole app window. Both share one header and one floating dock. -->
	<div
		class="call-shell"
		class:mode-embedded={callViewportMode === 'embedded'}
		class:mode-focus={callViewportMode === 'focus'}
		class:hatch-open={callViewportMode === 'focus' && hatchOpen}
		style={`--hatch-left: ${focusHatchInsetLeft}px; --hatch-right: ${focusHatchInsetRight}px;`}
	>
		{#if callViewportMode === 'focus' && hatchOpen}
			<button
				type="button"
				class="hatch-scrim"
				on:click={closeHatch}
				aria-label="Close hatch"
			></button>
		{/if}

		<section class="call-room" aria-labelledby="call-head-title">
			{#if showRecordingPresenceBanner}
				<CallRecordingPanel recordingState={$callRecordingState} {recordingPresenceCopy} {recordingPillText} />
			{/if}

			<header class="call-head">
				<div class="call-head__lead">
					<span class="call-head__live" aria-hidden="true"></span>
					<h2 class="call-head__title" id="call-head-title">{callTitle}</h2>
					<span class="call-head__meta">{callPeopleLabel}</span>
					{#if callStatusWords}
						<span class="call-head__status" role="status">{callStatusWords}</span>
					{/if}
				</div>
				<div class="call-head__actions">
					<Tooltip text="Call options" placement="bottom">
						<Menu items={callOptionsItems} label="Call options" triggerLabel="Call options" class="w-ibtn" align="end">
							<Icon name="more" />
						</Menu>
					</Tooltip>
					<Tooltip text="Minimize call" placement="bottom">
						<button
							type="button"
							class="w-ibtn"
							aria-label="Minimize call"
							on:click={minimizeToDocked}
						><Icon name="chevDown" /></button>
					</Tooltip>
					<Tooltip text={callViewportMode === 'focus' ? 'Back to the stage' : 'Fill the window'} placement="bottom">
						<button
							type="button"
							class="w-ibtn"
							aria-label="Full window"
							aria-pressed={callViewportMode === 'focus'}
							on:click={toggleFullWindow}
						><Icon name={callViewportMode === 'focus' ? 'collapse' : 'expand'} /></button>
					</Tooltip>
				</div>
			</header>

			{#if $callMode === 'group' && $groupCallRingingTargets.length > 0}
				<div class="ringing-targets-panel">
					<span class="ringing-targets-label w-kicker">Still ringing</span>
					<div class="ringing-targets-list">
						{#each $groupCallRingingTargets as target (target.stableUserId)}
							<button
								type="button"
								class="ringing-target-chip"
								title={`Manage ringing for ${target.username}`}
								aria-haspopup="menu"
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

			<div class="call-stage" class:call-stage--grid={!hasChannelStage} bind:this={callStageElement}>
				{#if hasChannelStage && stageSession}
					<!-- Phase 3 + 2026-09-07 stage targeting: the clicked session's
					     stage — the audio room of stamps, video/screen tiles, spatial seats. -->
					<CallStage
						session={stageSession}
						spatialEnabled={spatialAudioActive}
						bind:seatsOpen={spatialSeatsOpen}
					/>
				{:else}
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
				{/if}
				{#if isDevBuild && showSpatialDebugOverlay && $isInCall}
					<!-- Developer instrument (dev builds only, §9.4): seats, transport and relay counters. -->
					<div class="spatial-debug-overlay" transition:fade={{ duration: 140 }}>
						<div class="spatial-debug-header">
							<span class="w-kicker">Spatial seats</span>
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
									<span>{seat.seatIndex + 1} of {seat.slotCount}</span>
								</div>
							{/each}
						</div>
						<dl class="spatial-debug-facts">
							<dt>Transport</dt>
							<dd>{$callTransportState.activeTransport}{$callTransportState.isFallback ? ' (fallback)' : ''}</dd>
							<dt>Spatial</dt>
							<dd>{$spatialAudioRuntimeStatus.effectiveMode}, {$spatialAudioDiagnostics.totalSources} sources</dd>
							{#if devRouteText}
								<dt>Route</dt>
								<dd>{devRouteText}</dd>
							{/if}
							{#if relayAudioDiag}
								<dt>Audio relay</dt>
								<dd>{relayAudioDiag}</dd>
							{/if}
							{#if relayVideoDiag}
								<dt>Video relay</dt>
								<dd>{relayVideoDiag}</dd>
							{/if}
						</dl>
					</div>
				{/if}
			</div>

			{#if recordingLabel && !showRecordingPresenceBanner}
				<CallRecordingPanel recordingState={$callRecordingState} {recordingLabel} />
			{/if}

			<CallControls
				compact={compactDock}
				feedback={captureFeedback}
				isMuted={$isMuted}
				isDeafened={$isDeafened}
				isVideoOff={!cameraOn}
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
				devices={mediaDevices}
				selectedAudioInputId={selectedAudioInputId}
				selectedAudioOutputId={selectedAudioOutputId}
				onOpenDevicePicker={handleOpenDevicePicker}
				onSelectDevice={handleSelectDevice}
			/>
		</section>
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
