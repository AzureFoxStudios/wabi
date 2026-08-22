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
	localPreview: MediaStream | null,
	voiceMembersByChannel: Record<string, { userId: string; isMuted?: boolean; username?: string }[]>
): ParticipantMedia[] {
	if (remoteStreams.size === 0 && !localPreview) return participants;

	return participants.map((participant) => {
		// Local tile: adopt the lane preview as our own video.
		if (participant.isLocal) {
			if (localPreview && !participant.stream?.getVideoTracks().length) {
				return { ...participant, hasVideo: true, stream: localPreview };
			}
			return participant;
		}

		// Remote tiles: match by stable id (`user-<dbId>`) or raw id.
		const remote = remoteStreams.get(participant.id);
		const memberRow = Object.values(voiceMembersByChannel)
			.flat()
			.find((m) => m.userId === participant.id);
		const next: ParticipantMedia = { ...participant };
		if (remote && !next.stream?.getVideoTracks().length) {
			next.hasVideo = true;
			next.stream = remote;
		}
		if (memberRow?.isMuted !== undefined && next.isMuted === undefined) {
			next.isMuted = memberRow.isMuted;
		}
		return next;
	});
}
