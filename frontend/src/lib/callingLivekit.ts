import { get } from 'svelte/store';
import { Room, RoomEvent, Track } from 'livekit-client';
import {
	activeCalls,
	screenShares,
	sfuMediaActive,
	connectionState,
	callTransportState,
	isVideoOff,
	activeVoiceChannel
} from './callingStateStores';
import {
	cancelLivekitTokenRefresh,
	scheduleLivekitTokenRefresh
} from './callingLivekitTokenRefresh';
import { createLivekitAccessToken } from './mediaGateway';
import type { Call, ScreenShare } from './callingTypes';

// ============================================================================
// Dependency Injection
// ============================================================================

export type LivekitDeps = {
	shouldSendAudioToChannel: (channelId?: string) => boolean;
	syncSpatialAudioGraph: () => void;
	voiceParticipantLabels: Map<string, string>;
};

let deps: LivekitDeps | null = null;

export function initLivekitDeps(d: LivekitDeps): void {
	deps = d;
}

// ============================================================================
// Private State
// ============================================================================

let livekitRoom: Room | null = null;
let livekitChannelId: string | null = null;
const livekitParticipantMedia = new Map<string, {
	username: string;
	audioTrack: MediaStreamTrack | null;
	videoTrack: MediaStreamTrack | null;
	screenAudioTrack: MediaStreamTrack | null;
	screenVideoTrack: MediaStreamTrack | null;
	isSpeaking: boolean;
}>();

// ============================================================================
// Getters / Setters
// ============================================================================

export function getLivekitRoom(): Room | null {
	return livekitRoom;
}

export function setLivekitRoom(room: Room | null): void {
	livekitRoom = room;
}

export function getLivekitChannelId(): string | null {
	return livekitChannelId;
}

export function setLivekitChannelid(id: string | null): void {
	livekitChannelId = id;
}

export function livekitParticipantMediaSize(): number {
	return livekitParticipantMedia.size;
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeLivekitIdentity(identity: string): string {
	if (identity.startsWith('user:')) {
		return identity.slice('user:'.length);
	}
	return identity;
}

function rebuildLivekitRemoteStores(): void {
	const calls: Call[] = [];
	const shares: ScreenShare[] = [];
	for (const [identity, media] of livekitParticipantMedia.entries()) {
		const userId = normalizeLivekitIdentity(identity);
		const username = media.username || `User ${userId}`;
		const callTracks = [media.audioTrack, media.videoTrack].filter((track): track is MediaStreamTrack => Boolean(track));
		if (callTracks.length > 0) {
			calls.push({
				userId,
				username,
				stream: new MediaStream(callTracks),
				isVideoEnabled: Boolean(media.videoTrack),
				isAudioEnabled: Boolean(media.audioTrack),
				isSpeaking: media.isSpeaking
			});
		}

		const shareTracks = [media.screenVideoTrack, media.screenAudioTrack].filter((track): track is MediaStreamTrack => Boolean(track));
		if (shareTracks.length > 0) {
			shares.push({
				userId,
				username,
				stream: new MediaStream(shareTracks)
			});
		}
	}
	activeCalls.set(calls);
	screenShares.set(shares);
	deps!.syncSpatialAudioGraph();
}

function setLivekitParticipantSpeaking(identity: string, isSpeaking: boolean): void {
	const current = livekitParticipantMedia.get(identity);
	if (!current) return;
	current.isSpeaking = isSpeaking;
	livekitParticipantMedia.set(identity, current);
	rebuildLivekitRemoteStores();
}

function upsertLivekitTrack(
	identity: string,
	username: string,
	source: Track.Source,
	track: MediaStreamTrack | null
): void {
	deps!.voiceParticipantLabels.set(normalizeLivekitIdentity(identity), username);
	const current = livekitParticipantMedia.get(identity) ?? {
		username,
		audioTrack: null,
		videoTrack: null,
		screenAudioTrack: null,
		screenVideoTrack: null,
		isSpeaking: false
	};
	current.username = username || current.username;
	if (source === Track.Source.Camera) {
		current.videoTrack = track;
	} else if (source === Track.Source.Microphone) {
		current.audioTrack = track;
	} else if (source === Track.Source.ScreenShare) {
		current.screenVideoTrack = track;
	} else if (source === Track.Source.ScreenShareAudio) {
		current.screenAudioTrack = track;
	}
	livekitParticipantMedia.set(identity, current);
	rebuildLivekitRemoteStores();
}

function removeLivekitTrack(identity: string, source: Track.Source): void {
	const current = livekitParticipantMedia.get(identity);
	if (!current) return;
	if (source === Track.Source.Camera) {
		current.videoTrack = null;
	} else if (source === Track.Source.Microphone) {
		current.audioTrack = null;
	} else if (source === Track.Source.ScreenShare) {
		current.screenVideoTrack = null;
	} else if (source === Track.Source.ScreenShareAudio) {
		current.screenAudioTrack = null;
	}
	if (!current.audioTrack && !current.videoTrack && !current.screenAudioTrack && !current.screenVideoTrack) {
		livekitParticipantMedia.delete(identity);
	} else {
		livekitParticipantMedia.set(identity, current);
	}
	rebuildLivekitRemoteStores();
}

// ============================================================================
// Label Resolution
// ============================================================================

export function resolveVoiceParticipantLabel(userId: string): string | null {
	const remembered = deps!.voiceParticipantLabels.get(userId)?.trim();
	if (remembered) {
		return remembered;
	}

	const activeCall = get(activeCalls).find((call) => call.userId === userId);
	if (activeCall?.username?.trim()) {
		return activeCall.username.trim();
	}

	for (const [identity, media] of livekitParticipantMedia.entries()) {
		if (normalizeLivekitIdentity(identity) !== userId) continue;
		const username = media.username?.trim();
		if (username) {
			return username;
		}
	}

	return null;
}

// ============================================================================
// SFU Connection Lifecycle
// ============================================================================

export async function disconnectLivekitSfu(options: { preserveCallState?: boolean } = {}): Promise<void> {
	const { preserveCallState = false } = options;
	const channelId = livekitChannelId;
	if (channelId) {
		cancelLivekitTokenRefresh(channelId);
	}
	const room = livekitRoom;
	livekitRoom = null;
	livekitChannelId = null;
	livekitParticipantMedia.clear();
	if (!room) {
		sfuMediaActive.set(false);
		return;
	}
	try {
		await room.disconnect();
	} catch {
		// no-op
	}
	if (!preserveCallState) {
		// Only clear SFU-related call state; preserve P2P calls.
		activeCalls.update((calls) => calls.filter(call => !call.sfu));
		screenShares.set([]);
	}
	sfuMediaActive.set(false);
	connectionState.set(preserveCallState ? 'connecting' : 'idle');
	callTransportState.update((state) => {
		if (preserveCallState) {
			return {
				...state,
				reason: state.reason === 'livekit_connected' ? 'livekit_refreshing' : state.reason
			};
		}

		return {
			...state,
			activeTransport: 'p2p',
			reason: state.reason === 'livekit_connected' ? 'livekit_disconnected' : state.reason
		};
	});
	deps!.syncSpatialAudioGraph();
}

export async function connectLivekitSfu(channelId: string, localDisplayName: string): Promise<void> {
  if (livekitRoom && livekitChannelId === channelId && get(sfuMediaActive)) {
		return;
  }
  await disconnectLivekitSfu();
  const tokenResponse = await createLivekitAccessToken(channelId, localDisplayName);
	console.log(
		`[Calling] LiveKit target: ${tokenResponse.source === 'relay' ? tokenResponse.relayName || `relay ${tokenResponse.relayId}` : 'origin'} (${tokenResponse.url})`
	);
	const room = new Room({
		dynacast: true,
		stopLocalTrackOnUnpublish: false
	});
	room.on(RoomEvent.TrackSubscribed, (remoteTrack, publication, participant) => {
		upsertLivekitTrack(
			participant.identity,
			participant.name || participant.identity,
			publication.source,
			remoteTrack.mediaStreamTrack
		);
});
	room.on(RoomEvent.TrackUnsubscribed, (_remoteTrack, publication, participant) => {
		removeLivekitTrack(participant.identity, publication.source);
	});
	room.on(RoomEvent.ParticipantDisconnected, (participant) => {
		livekitParticipantMedia.delete(participant.identity);
		rebuildLivekitRemoteStores();
	});
	room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
		const activeIds = new Set(speakers.map((speaker) => speaker.identity));
		for (const identity of livekitParticipantMedia.keys()) {
			setLivekitParticipantSpeaking(identity, activeIds.has(identity));
		}
	});
	room.on(RoomEvent.Disconnected, () => {
		if (livekitRoom === room) {
			void disconnectLivekitSfu();
		}
	});
	connectionState.set('connecting');
  await room.connect(tokenResponse.url, tokenResponse.token, {
      autoSubscribe: true
  });
  if (tokenResponse?.token) {
    scheduleLivekitTokenRefresh(channelId, localDisplayName, tokenResponse.token);
  }
	await room.localParticipant.setMicrophoneEnabled(deps!.shouldSendAudioToChannel(channelId));
	if (!get(isVideoOff)) {
		await room.localParticipant.setCameraEnabled(true);
	}
	livekitRoom = room;
	livekitChannelId = channelId;
	sfuMediaActive.set(true);
	connectionState.set('connected');
	callTransportState.update((state) => ({
		...state,
		activeTransport: 'sfu',
		isFallback: false,
		reason: 'livekit_connected',
		gatewayMediaPlaneStatus: 'ready'
	}));
}