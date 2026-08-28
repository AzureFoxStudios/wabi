import type { Call, ScreenShare } from './calling';

export type RenderTileKind = 'video' | 'screen' | 'avatar';

export interface ParticipantMedia {
	id: string;
	label: string;
	isLocal: boolean;
	hasVideo: boolean;
	stream: MediaStream | null;
	isMuted?: boolean;
	isScreenSharing?: boolean;
}

export interface ShareMedia {
	id: string;
	participantId: string;
	label: string;
	isLocal: boolean;
	stream: MediaStream | null;
}

export interface RenderTile {
	id: string;
	participantId: string;
	label: string;
	kind: RenderTileKind;
	stream: MediaStream | null;
	isLocal: boolean;
	isMuted?: boolean;
	isScreenSharing?: boolean;
}

export function buildParticipants(
	calls: Call[],
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
			stream: myStream,
			isMuted: false,
			isScreenSharing: false
		});
	}
	for (const call of calls) {
		list.push({
			id: call.userId,
			label: call.username || 'User',
			isLocal: false,
			hasVideo: Boolean(call.isVideoEnabled && call.stream?.getVideoTracks().length),
			stream: call.stream,
			isMuted: !call.isAudioEnabled,
			isScreenSharing: false
		});
	}
	return list.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildRosterParticipants(
	rosterMembers: { userId: string; username: string; profilePicture?: string; isMuted?: boolean }[],
	existingCallUserIds: Set<string>
): ParticipantMedia[] {
	return rosterMembers
		.filter((m) => !existingCallUserIds.has(m.userId))
		.map((m) => ({
			id: m.userId,
			label: m.username || 'User',
			isLocal: false,
			hasVideo: false,
			stream: null,
			isMuted: m.isMuted ?? false,
			isScreenSharing: false
		}));
}

export function buildShares(
	remoteShares: ScreenShare[],
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

export function buildRenderTiles(participantsList: ParticipantMedia[], shareList: ShareMedia[]): RenderTile[] {
	const hasShares = shareList.length > 0;
	const videoParticipants = participantsList.filter((participant) => participant.hasVideo);
	const avatarParticipants = participantsList.filter((participant) => !participant.hasVideo);
	const hasVideoTiles = videoParticipants.length > 0;
	const tiles: RenderTile[] = [];

	const screenSharingIds = new Set(shareList.map((share) => share.participantId));
	function tileFlags(participantId: string, participant?: ParticipantMedia): { isMuted?: boolean; isScreenSharing?: boolean } {
		return {
			isMuted: participant?.isMuted,
			isScreenSharing: screenSharingIds.has(participantId)
		};
	}
	const participantById = new Map(participantsList.map((participant) => [participant.id, participant]));

	if (hasShares || hasVideoTiles) {
		for (const share of shareList) {
			tiles.push({
				id: `share:${share.id}`,
				participantId: share.participantId,
				label: share.label,
				kind: 'screen',
				stream: share.stream,
				isLocal: share.isLocal,
				...tileFlags(share.participantId, participantById.get(share.participantId))
			});
		}
		for (const participant of videoParticipants) {
			tiles.push({
				id: `video:${participant.id}`,
				participantId: participant.id,
				label: participant.label,
				kind: 'video',
				stream: participant.stream,
				isLocal: participant.isLocal,
				...tileFlags(participant.id, participant)
			});
		}
		for (const participant of avatarParticipants) {
			tiles.push({
				id: `avatar:${participant.id}`,
				participantId: participant.id,
				label: participant.label,
				kind: 'avatar',
				stream: participant.stream,
				isLocal: participant.isLocal,
				...tileFlags(participant.id, participant)
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
			isLocal: participant.isLocal,
			...tileFlags(participant.id, participant)
		});
	}

	return tiles.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildActiveSpeakerLevels(
	participantsList: ParticipantMedia[],
	calls: Call[],
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

export function getInitial(label: string): string {
	return label.trim().charAt(0).toUpperCase() || '?';
}

/**
 * Normalize a relay/lane user key to the stable id form the UI tiles use
 * (`user-<dbId>`). The lane stores streams under the raw envelope userId
 * (e.g. "2"), but buildWabidbAwareParticipants looks up `user-2`.
 */
function toStableUserKey(userId: string): string {
	return /^\d+$/.test(userId) ? `user-${userId}` : userId;
}

/**
 * Overlay wabidb relay video onto the P2P-derived participant list.
 *
 * The wabidb video lane decodes remote frames into per-user MediaStreams
 * (`wabidbRemoteVideoStreams`) and exposes the local preview while the lane
 * is live. P2P call objects know nothing about those, so without this merge
 * camera/screenshare on the default transport never renders a tile.
 *
 * Also repairs roster mute state: `voice-user-muted`/`voice-self-state` events
 * maintain `isMuted` on voiceChannelMembers, but the roster path dropped it.
 */
export function buildWabidbAwareParticipants(
	participants: ParticipantMedia[],
	remoteStreams: Map<string, MediaStream>,
	localCameraPreview: MediaStream | null,
	localScreenPreview: MediaStream | null,
	voiceMembersByChannel: Record<string, { userId: string; isMuted?: boolean; username?: string }[]>
): ParticipantMedia[] {
	if (remoteStreams.size === 0 && !localCameraPreview && !localScreenPreview) return participants;

	const out: ParticipantMedia[] = [];
	for (const participant of participants) {
		// Local tile: adopt the lane camera preview as our own video.
		if (participant.isLocal) {
			let next: ParticipantMedia = { ...participant };
			if (localCameraPreview && !next.stream?.getVideoTracks().length) {
				next.hasVideo = true;
				next.stream = localCameraPreview;
			}
			if (localScreenPreview) next.isScreenSharing = true;
			out.push(next);
			continue;
		}

		// Remote tiles: look the feed up by composite stream key. The lane keys
		// streams by `stableUserId:source`; try both raw and normalized ids and
		// fall back to a legacy un-sourced key for pre-P1 senders.
		const stableId = toStableUserKey(participant.id);
		const cameraKey = `${stableId}:camera`;
		const screenKey = `${stableId}:screen`;
		const legacyKeys = [participant.id, stableId];
		const cameraStream =
			remoteStreams.get(cameraKey) ??
			legacyKeys.map((k) => remoteStreams.get(k)).find((s): s is MediaStream => Boolean(s)) ??
			null;
		const screenStream =
			remoteStreams.get(screenKey) ?? null;

		const memberRow = Object.values(voiceMembersByChannel)
			.flat()
			.find((m) => m.userId === participant.id);

		let next: ParticipantMedia = { ...participant };
		if (cameraStream && !next.stream?.getVideoTracks().length) {
			next.hasVideo = true;
			next.stream = cameraStream;
		}
		if (screenStream) next.isScreenSharing = true;
		if (memberRow?.isMuted !== undefined && next.isMuted === undefined) {
			next.isMuted = memberRow.isMuted;
		}
		out.push(next);
	}
	return out;
}

/**
 * Remote wabidb screen shares as ShareMedia tiles. One entry per remote
 * `user:screen` stream; local sharing still flows through buildShares().
 */
export function buildWabidbScreenShares(
	remoteStreams: Map<string, MediaStream>,
	localScreenPreview: MediaStream | null,
	displayNames: Record<string, string> = {}
): ShareMedia[] {
	const shares: ShareMedia[] = [];
	for (const [key, stream] of remoteStreams) {
		if (!key.endsWith(':screen')) continue;
		const stableId = key.slice(0, -':screen'.length);
		const label = displayNames[stableId] ? `${displayNames[stableId]}'s Screen` : 'Shared Screen';
		shares.push({
			id: `wabidb:${key}`,
			participantId: stableId,
			label,
			isLocal: false,
			stream
		});
	}
	if (localScreenPreview) {
		shares.push({
			id: 'local',
			participantId: 'local',
			label: 'Your Screen',
			isLocal: true,
			stream: localScreenPreview
		});
	}
	return shares.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One normalized screen-share entry per participant, across BOTH transports.
 * `key` is stable for Svelte keyed-each; `ownerId` is the stable user id
 * ('local' for the sharer's own screen). Wabidb entries win on dedupe: their
 * owner ids are server-attested, while P2P ids come from connection targets.
 */
export interface MergedScreenShareEntry {
	key: string;
	ownerId: string;
	label: string;
	stream: MediaStream | null;
	isLocal: boolean;
}

export function mergeScreenShareEntries(
	remoteStreams: Map<string, MediaStream>,
	p2pShares: ScreenShare[],
	localScreenPreview: MediaStream | null,
	displayNames: Record<string, string> = {}
): MergedScreenShareEntry[] {
	const entries = new Map<string, MergedScreenShareEntry>();
	const labelFor = (stableId: string, fallback?: string): string => {
		const name = displayNames[stableId] ?? fallback ?? stableId.replace(/^user-/, '');
		return `${name}'s Screen`;
	};

	for (const [key, stream] of remoteStreams) {
		if (!key.endsWith(':screen')) continue;
		const ownerId = key.slice(0, -':screen'.length);
		entries.set(ownerId, {
			key: `wabidb:${key}`,
			ownerId,
			label: labelFor(ownerId),
			stream,
			isLocal: false
		});
	}

	for (const share of p2pShares) {
		const ownerId = toStableUserKey(share.userId);
		if (entries.has(ownerId)) continue;
		entries.set(ownerId, {
			key: `p2p:${ownerId}`,
			ownerId,
			label: labelFor(ownerId, share.username),
			stream: share.stream,
			isLocal: false
		});
	}

	if (localScreenPreview) {
		entries.set('local', {
			key: 'local',
			ownerId: 'local',
			label: 'Your Screen',
			stream: localScreenPreview,
			isLocal: true
		});
	}

	return Array.from(entries.values()).sort((a, b) => a.key.localeCompare(b.key));
}
