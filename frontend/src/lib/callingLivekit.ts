import { get } from 'svelte/store';
import {
	Room,
	RoomEvent,
	Track,
	type RemoteParticipant,
	type RemoteTrackPublication
} from 'livekit-client';
import {
	activeCalls,
	screenShares,
	sfuMediaActive,
	connectionState,
	callTransportState,
	isVideoOff,
	isDeafened
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
let livekitGeneration = 0;
const LIVEKIT_SMALL_ROOM_AUTO_CAMERA_LIMIT = 6;
const LIVEKIT_ACTIVE_SPEAKER_CAMERA_LIMIT = 4;

const livekitParticipantMedia = new Map<string, {
	username: string;
	audioTrack: MediaStreamTrack | null;
	videoTrack: MediaStreamTrack | null;
	screenAudioTrack: MediaStreamTrack | null;
	screenVideoTrack: MediaStreamTrack | null;
	isSpeaking: boolean;
}>();

/** Publication metadata is deliberately kept even while media is unsubscribed.
 * That is what lets the UI show “Alice is sharing — View” without paying for
 * Alice's screen video/audio until the user asks for it. */
const livekitRemotePublications = new Map<string, Map<Track.Source, RemoteTrackPublication>>();
const livekitViewedScreens = new Set<string>();
const livekitExplicitCameraInterest = new Set<string>();
let livekitActiveSpeakerIdentities = new Set<string>();
const livekitScreenPlaceholders = new Map<string, MediaStream>();

type WabiLivekitShareStream = MediaStream & {
	__wabiLivekitShare?: true;
	__wabiLivekitShareOwnerId?: string;
	__wabiLivekitSharePending?: boolean;
	__wabiLivekitShareViewing?: boolean;
};

// Deafen is a routing decision, not just an output-volume toggle. Re-evaluate
// remote microphone + screen-audio subscriptions immediately when it changes.
let lastLivekitDeafened = get(isDeafened);
isDeafened.subscribe((deafened) => {
	if (deafened === lastLivekitDeafened) return;
	lastLivekitDeafened = deafened;
	if (livekitRoom) queueMicrotask(() => syncLivekitReceivePolicy());
});

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

function requireDeps(): LivekitDeps {
	if (!deps) throw new Error('LiveKit calling dependencies are not initialized');
	return deps;
}

/** LiveKit identities are deliberately opaque-ish `user:<db-id>` values. Wabi's
 * call/roster surfaces use the stable `user-<db-id>` form, so normalize at the
 * media boundary instead of leaking backend identity syntax through the UI. */
function normalizeLivekitIdentity(identity: string): string {
	if (identity.startsWith('user:')) {
		return `user-${identity.slice('user:'.length)}`;
	}
	return identity;
}

/** Decode only enough of our own short-lived JWT to avoid asking the SDK to
 * publish when the Authority deliberately granted listener/server-muted access.
 * This is convenience, never authorization: LiveKit still enforces the signed
 * grant server-side. Fail closed if the payload cannot be inspected. */
function livekitTokenAllowsPublishing(token: string): boolean {
	try {
		const part = token.split('.')[1];
		if (!part) return false;
		const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
		const payload = JSON.parse(atob(padded)) as { video?: { canPublish?: boolean } };
		return payload.video?.canPublish !== false;
	} catch {
		return false;
	}
}

function participantMedia(identity: string, username = identity) {
	const existing = livekitParticipantMedia.get(identity);
	if (existing) {
		if (username) existing.username = username;
		return existing;
	}
	const created = {
		username,
		audioTrack: null,
		videoTrack: null,
		screenAudioTrack: null,
		screenVideoTrack: null,
		isSpeaking: false
	};
	livekitParticipantMedia.set(identity, created);
	return created;
}

function publicationMap(identity: string): Map<Track.Source, RemoteTrackPublication> {
	let publications = livekitRemotePublications.get(identity);
	if (!publications) {
		publications = new Map();
		livekitRemotePublications.set(identity, publications);
	}
	return publications;
}

function rememberPublication(participant: RemoteParticipant, publication: RemoteTrackPublication): void {
	publicationMap(participant.identity).set(publication.source, publication);
	participantMedia(participant.identity, participant.name || participant.identity);
	requireDeps().voiceParticipantLabels.set(
		normalizeLivekitIdentity(participant.identity),
		participant.name || participant.identity
	);
}

function forgetPublication(identity: string, publication: RemoteTrackPublication): void {
	const publications = livekitRemotePublications.get(identity);
	publications?.delete(publication.source);
	if (publications?.size === 0) livekitRemotePublications.delete(identity);
	if (!hasScreenPublication(identity)) {
		livekitViewedScreens.delete(identity);
		livekitScreenPlaceholders.delete(identity);
	}
}

function hasScreenPublication(identity: string): boolean {
	const publications = livekitRemotePublications.get(identity);
	return Boolean(
		publications?.has(Track.Source.ScreenShare) ||
		publications?.has(Track.Source.ScreenShareAudio)
	);
}

function taggedShareStream(
	stream: MediaStream,
	identity: string,
	pending: boolean,
	viewing: boolean
): MediaStream {
	const tagged = stream as WabiLivekitShareStream;
	tagged.__wabiLivekitShare = true;
	tagged.__wabiLivekitShareOwnerId = normalizeLivekitIdentity(identity);
	tagged.__wabiLivekitSharePending = pending;
	tagged.__wabiLivekitShareViewing = viewing;
	return tagged;
}

function screenPlaceholder(identity: string): MediaStream {
	let stream = livekitScreenPlaceholders.get(identity);
	if (!stream) {
		stream = new MediaStream();
		livekitScreenPlaceholders.set(identity, stream);
	}
	return stream;
}

function rebuildLivekitRemoteStores(): void {
	const calls: Call[] = [];
	const shares: ScreenShare[] = [];
	for (const [identity, media] of livekitParticipantMedia.entries()) {
		const userId = normalizeLivekitIdentity(identity);
		const username = media.username || userId;
		const callTracks = [media.audioTrack, media.videoTrack].filter(
			(track): track is MediaStreamTrack => Boolean(track)
		);
		if (callTracks.length > 0) {
			calls.push({
				userId,
				username,
				stream: new MediaStream(callTracks),
				isVideoEnabled: Boolean(media.videoTrack),
				isAudioEnabled: Boolean(media.audioTrack),
				isSpeaking: media.isSpeaking,
				sfu: true
			});
		}

		if (hasScreenPublication(identity)) {
			const shareTracks = [media.screenVideoTrack, media.screenAudioTrack].filter(
				(track): track is MediaStreamTrack => Boolean(track)
			);
			const viewing = livekitViewedScreens.has(identity);
			const stream = shareTracks.length > 0
				? new MediaStream(shareTracks)
				: screenPlaceholder(identity);
			shares.push({
				userId,
				username,
				channelId: livekitChannelId ?? undefined,
				stream: taggedShareStream(stream, identity, shareTracks.length === 0, viewing)
			});
		}
	}
	activeCalls.set(calls);
	screenShares.set(shares);
	requireDeps().syncSpatialAudioGraph();
}

function setLivekitParticipantSpeaking(identity: string, isSpeaking: boolean): void {
	const current = livekitParticipantMedia.get(identity);
	if (!current) return;
	current.isSpeaking = isSpeaking;
	livekitParticipantMedia.set(identity, current);
}

function upsertLivekitTrack(
	identity: string,
	username: string,
	source: Track.Source,
	track: MediaStreamTrack | null
): void {
	requireDeps().voiceParticipantLabels.set(normalizeLivekitIdentity(identity), username);
	const current = participantMedia(identity, username);
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
	if (
		!current.audioTrack &&
		!current.videoTrack &&
		!current.screenAudioTrack &&
		!current.screenVideoTrack &&
		!livekitRemotePublications.has(identity)
	) {
		livekitParticipantMedia.delete(identity);
	} else {
		livekitParticipantMedia.set(identity, current);
	}
	rebuildLivekitRemoteStores();
}

function identityForStableUserId(userId: string): string | null {
	for (const identity of livekitRemotePublications.keys()) {
		if (normalizeLivekitIdentity(identity) === userId) return identity;
	}
	return null;
}

function shouldSubscribeCamera(identity: string): boolean {
	const room = livekitRoom;
	if (!room) return false;
	if (room.remoteParticipants.size <= LIVEKIT_SMALL_ROOM_AUTO_CAMERA_LIMIT) return true;
	return livekitExplicitCameraInterest.has(identity) || livekitActiveSpeakerIdentities.has(identity);
}

function wantsPublication(identity: string, publication: RemoteTrackPublication): boolean {
	if (publication.source === Track.Source.Microphone) {
		return !get(isDeafened);
	}
	if (publication.source === Track.Source.Camera) {
		return shouldSubscribeCamera(identity);
	}
	if (publication.source === Track.Source.ScreenShare) {
		return livekitViewedScreens.has(identity);
	}
	if (publication.source === Track.Source.ScreenShareAudio) {
		return livekitViewedScreens.has(identity) && !get(isDeafened);
	}
	return false;
}

function applyPublicationPolicy(identity: string, publication: RemoteTrackPublication): void {
	const wanted = wantsPublication(identity, publication);
	try {
		if (publication.isSubscribed !== wanted) publication.setSubscribed(wanted);
	} catch (error) {
		console.warn('[Calling] LiveKit subscription update failed', {
			identity,
			source: publication.source,
			wanted,
			error
		});
	}
}

function applyAllPublicationPolicies(): void {
	for (const [identity, publications] of livekitRemotePublications.entries()) {
		for (const publication of publications.values()) {
			applyPublicationPolicy(identity, publication);
		}
	}
}

function registerParticipantPublications(participant: RemoteParticipant): void {
	for (const publication of participant.trackPublications.values()) {
		rememberPublication(participant, publication);
		applyPublicationPolicy(participant.identity, publication);
	}
}

/** Re-evaluate what this client should actually receive. Called after deafen,
 * participant-count changes and active-speaker changes. */
export function syncLivekitReceivePolicy(): void {
	if (!livekitRoom) return;
	applyAllPublicationPolicies();
	rebuildLivekitRemoteStores();
}

/** Explicit camera-interest hook for focused/pinned/visible UI surfaces. Large
 * rooms do not automatically receive every camera. */
export function setLivekitCameraInterest(userId: string, interested: boolean): void {
	const identity = identityForStableUserId(userId);
	if (!identity) return;
	if (interested) livekitExplicitCameraInterest.add(identity);
	else livekitExplicitCameraInterest.delete(identity);
	const publication = livekitRemotePublications.get(identity)?.get(Track.Source.Camera);
	if (publication) applyPublicationPolicy(identity, publication);
}

/** Subscribe to the sharer's screen video and (unless deafened) share audio. */
export function viewLivekitScreenShare(userId: string): void {
	const identity = identityForStableUserId(userId);
	if (!identity) return;
	livekitViewedScreens.add(identity);
	for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
		const publication = livekitRemotePublications.get(identity)?.get(source);
		if (publication) applyPublicationPolicy(identity, publication);
	}
	rebuildLivekitRemoteStores();
}

/** Stop receiving the remote screen while keeping its publication metadata so
 * the View affordance remains available until the sharer actually stops. */
export function hideLivekitScreenShare(userId: string): void {
	const identity = identityForStableUserId(userId);
	if (!identity) return;
	livekitViewedScreens.delete(identity);
	const media = livekitParticipantMedia.get(identity);
	if (media) {
		media.screenVideoTrack = null;
		media.screenAudioTrack = null;
	}
	for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
		const publication = livekitRemotePublications.get(identity)?.get(source);
		if (publication) applyPublicationPolicy(identity, publication);
	}
	rebuildLivekitRemoteStores();
}

// ============================================================================
// Label Resolution
// ============================================================================

export function resolveVoiceParticipantLabel(userId: string): string | null {
	const remembered = requireDeps().voiceParticipantLabels.get(userId)?.trim();
	if (remembered) return remembered;

	const activeCall = get(activeCalls).find((call) => call.userId === userId);
	if (activeCall?.username?.trim()) return activeCall.username.trim();

	for (const [identity, media] of livekitParticipantMedia.entries()) {
		if (normalizeLivekitIdentity(identity) !== userId) continue;
		const username = media.username?.trim();
		if (username) return username;
	}
	return null;
}

// ============================================================================
// SFU Connection Lifecycle
// ============================================================================

export async function disconnectLivekitSfu(
	options: { preserveCallState?: boolean } = {}
): Promise<void> {
	livekitGeneration++;
	const { preserveCallState = false } = options;
	const channelId = livekitChannelId;
	if (channelId) cancelLivekitTokenRefresh(channelId);
	const room = livekitRoom;
	livekitRoom = null;
	livekitChannelId = null;
	livekitParticipantMedia.clear();
	livekitRemotePublications.clear();
	livekitViewedScreens.clear();
	livekitExplicitCameraInterest.clear();
	livekitActiveSpeakerIdentities.clear();
	livekitScreenPlaceholders.clear();
	if (!room) {
		sfuMediaActive.set(false);
		return;
	}
	if (!preserveCallState) {
		activeCalls.update((calls) => calls.filter((call) => !call.sfu));
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
	requireDeps().syncSpatialAudioGraph();
	try {
		await room.disconnect();
	} catch {
		// local ownership is already retired
	}
}

export async function connectLivekitSfu(
	channelId: string,
	localDisplayName: string,
	signal?: AbortSignal
): Promise<void> {
	signal?.throwIfAborted();
	if (livekitRoom && livekitChannelId === channelId && get(sfuMediaActive)) return;
	if (livekitRoom && livekitChannelId !== channelId) {
		throw new Error('LiveKit is already owned by another call');
	}
	await disconnectLivekitSfu();
	signal?.throwIfAborted();
	const generation = ++livekitGeneration;
	const check = () => {
		signal?.throwIfAborted();
		if (generation !== livekitGeneration) {
			throw new DOMException('LiveKit call superseded', 'AbortError');
		}
	};
	const tokenResponse = await createLivekitAccessToken(channelId, localDisplayName);
	const tokenCanPublish = livekitTokenAllowsPublishing(tokenResponse.token);
	check();
	console.log(
		`[Calling] LiveKit target: ${tokenResponse.source === 'relay' ? tokenResponse.relayName || `relay ${tokenResponse.relayId}` : 'origin'} (${tokenResponse.url})`
	);
	const room = new Room({
		dynacast: true,
		stopLocalTrackOnUnpublish: false
	});
	livekitRoom = room;
	livekitChannelId = channelId;
	const abort = () => {
		if (livekitRoom === room) void disconnectLivekitSfu();
	};
	signal?.addEventListener('abort', abort, { once: true });
	try {
		room.on(RoomEvent.TrackPublished, (publication, participant) => {
			if (livekitRoom !== room) return;
			rememberPublication(participant, publication);
			applyPublicationPolicy(participant.identity, publication);
			rebuildLivekitRemoteStores();
		});
		room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
			if (livekitRoom !== room) return;
			forgetPublication(participant.identity, publication);
			removeLivekitTrack(participant.identity, publication.source);
		});
		room.on(RoomEvent.TrackSubscribed, (remoteTrack, publication, participant) => {
			if (livekitRoom !== room) return;
			rememberPublication(participant, publication);
			upsertLivekitTrack(
				participant.identity,
				participant.name || participant.identity,
				publication.source,
				remoteTrack.mediaStreamTrack
			);
		});
		room.on(RoomEvent.TrackUnsubscribed, (_remoteTrack, publication, participant) => {
			if (livekitRoom !== room) return;
			removeLivekitTrack(participant.identity, publication.source);
		});
		room.on(RoomEvent.ParticipantConnected, (participant) => {
			if (livekitRoom !== room) return;
			registerParticipantPublications(participant);
			applyAllPublicationPolicies();
			rebuildLivekitRemoteStores();
		});
		room.on(RoomEvent.ParticipantDisconnected, (participant) => {
			if (livekitRoom !== room) return;
			livekitParticipantMedia.delete(participant.identity);
			livekitRemotePublications.delete(participant.identity);
			livekitViewedScreens.delete(participant.identity);
			livekitExplicitCameraInterest.delete(participant.identity);
			livekitActiveSpeakerIdentities.delete(participant.identity);
			livekitScreenPlaceholders.delete(participant.identity);
			applyAllPublicationPolicies();
			rebuildLivekitRemoteStores();
		});
		room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
			if (livekitRoom !== room) return;
			const activeIds = new Set(speakers.map((speaker) => speaker.identity));
			livekitActiveSpeakerIdentities = new Set(
				speakers.slice(0, LIVEKIT_ACTIVE_SPEAKER_CAMERA_LIMIT).map((speaker) => speaker.identity)
			);
			for (const identity of livekitParticipantMedia.keys()) {
				setLivekitParticipantSpeaking(identity, activeIds.has(identity));
			}
			applyAllPublicationPolicies();
			rebuildLivekitRemoteStores();
		});
		room.on(RoomEvent.Disconnected, () => {
			if (livekitRoom === room) void disconnectLivekitSfu();
		});

		connectionState.set('connecting');
		await room.connect(tokenResponse.url, tokenResponse.token, {
			autoSubscribe: false
		});
		check();

		// TrackPublished is metadata, not a guarantee that every pre-existing
		// publication generated an event during connect. Seed policy from the
		// authoritative participant publication maps after connection as well.
		for (const participant of room.remoteParticipants.values()) {
			registerParticipantPublications(participant);
		}
		applyAllPublicationPolicies();
		rebuildLivekitRemoteStores();

		if (tokenResponse.token) {
			scheduleLivekitTokenRefresh(channelId, localDisplayName, tokenResponse.token);
		}
		if (tokenCanPublish) {
			await room.localParticipant.setMicrophoneEnabled(
				requireDeps().shouldSendAudioToChannel(channelId)
			);
			check();
			if (!get(isVideoOff)) {
				await room.localParticipant.setCameraEnabled(true);
				check();
			}
		}
		livekitRoom = room;
		livekitChannelId = channelId;
		sfuMediaActive.set(true);
		connectionState.set('connected');
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'sfu',
			isFallback: false,
			reason: tokenCanPublish ? 'livekit_connected' : 'livekit_connected_listen_only',
			gatewayMediaPlaneStatus: 'ready'
		}));
	} catch (error) {
		if (livekitRoom === room) await disconnectLivekitSfu();
		else {
			try {
				await room.disconnect();
			} catch {
				// no-op
			}
		}
		throw error;
	} finally {
		signal?.removeEventListener('abort', abort);
	}
}
