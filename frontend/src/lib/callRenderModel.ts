import type { Call, ScreenShare } from './calling';

export type RenderTileKind = 'video' | 'screen' | 'avatar';

export interface ParticipantMedia {
	id: string;
	label: string;
	isLocal: boolean;
	hasVideo: boolean;
	stream: MediaStream | null;
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
		for (const participant of avatarParticipants) {
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
