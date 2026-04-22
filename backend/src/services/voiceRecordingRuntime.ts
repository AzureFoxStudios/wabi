interface ActiveUserLike {
	id: string;
	dbUserId?: number;
	username?: string;
	profilePicture?: string;
}

interface GroupCallSessionLike {
	channelId: string;
	connectedParticipants: Set<string>;
}

interface VoiceParticipantLike {
	userId: string;
	socketId: string;
	username?: string;
	profilePicture?: string;
}

interface RecordingActivationRequest {
	socketId: string;
	stableUserId: string;
	active: boolean;
	scope?: "direct" | "group" | "channel";
	channelId?: string;
}

interface CreateVoiceRecordingRuntimeOptions {
	users: Map<string, ActiveUserLike>;
	activeCallPeers: Map<string, Set<string>>;
	groupCallSessions: Map<string, GroupCallSessionLike>;
	socketVoiceSubscriptions: Map<string, Set<string>>;
	getPublicUserId: (user: Pick<ActiveUserLike, 'id' | 'dbUserId'>) => string;
	buildVoiceParticipant: (stableUserId: string) => VoiceParticipantLike;
	resolveSocketId: (stableUserId: string) => string | null;
	emitToSocket: (socketId: string, event: string, payload: unknown) => void;
	emitToStableUser: (stableUserId: string, event: string, payload: unknown) => void;
	emitToVoiceAudience: (channelId: string, event: string, payload: unknown) => void;
}

export function createVoiceRecordingRuntime({
	users,
	activeCallPeers,
	groupCallSessions,
	socketVoiceSubscriptions,
	getPublicUserId,
	buildVoiceParticipant,
	resolveSocketId,
	emitToSocket,
	emitToStableUser,
	emitToVoiceAudience
}: CreateVoiceRecordingRuntimeOptions) {
	const directCallRecorders = new Set<string>();
	const groupCallRecordingParticipants = new Map<string, Set<string>>();
	const voiceCallRecorders = new Set<string>();
	const voiceChannelRecordingParticipants = new Map<string, Set<string>>();

	const getDirectCallAudience = (socketId: string): Set<string> => {
		return new Set<string>([socketId, ...Array.from(activeCallPeers.get(socketId) || [])]);
	};

	const getDirectCallRecordingParticipantsForSocket = (socketId: string): VoiceParticipantLike[] => {
		const scopeStableIds = new Set<string>();
		const socketUser = users.get(socketId);
		if (socketUser) {
			scopeStableIds.add(getPublicUserId(socketUser));
		}

		for (const peerSocketId of Array.from(activeCallPeers.get(socketId) || [])) {
			const peerUser = users.get(peerSocketId);
			if (!peerUser) continue;
			scopeStableIds.add(getPublicUserId(peerUser));
		}

		return Array.from(scopeStableIds)
			.filter((stableUserId) => directCallRecorders.has(stableUserId))
			.map(buildVoiceParticipant);
	};

	const emitDirectCallRecordingPresenceForSocket = (socketId: string): void => {
		if (!users.has(socketId)) return;
		emitToSocket(socketId, 'call-recording-presence', {
			scope: 'direct',
			participants: getDirectCallRecordingParticipantsForSocket(socketId)
		});
	};

	const emitDirectCallRecordingPresenceForSocketSet = (socketIds: Iterable<string>): void => {
		for (const socketId of socketIds) {
			emitDirectCallRecordingPresenceForSocket(socketId);
		}
	};

	const emitGroupCallRecordingPresence = (channelId: string): void => {
		const session = groupCallSessions.get(channelId);
		if (!session) return;

		const participants = Array.from(groupCallRecordingParticipants.get(channelId) || []).map(buildVoiceParticipant);
		for (const stableUserId of session.connectedParticipants) {
			emitToStableUser(stableUserId, 'call-recording-presence', {
				scope: 'group',
				channelId,
				participants
			});
		}
	};

	const emitVoiceChannelRecordingPresence = (channelId: string): void => {
		const participants = Array.from(voiceChannelRecordingParticipants.get(channelId) || []).map(buildVoiceParticipant);
		emitToVoiceAudience(channelId, 'call-recording-presence', {
			scope: 'channel',
			channelId,
			participants
		});
	};

	const removeRecorderFromGroupChannels = (stableUserId: string, channelId?: string): void => {
		const affectedChannelIds = new Set<string>();
		if (channelId) {
			const participants = groupCallRecordingParticipants.get(channelId);
			if (participants?.delete(stableUserId)) {
				affectedChannelIds.add(channelId);
				if (participants.size === 0) {
					groupCallRecordingParticipants.delete(channelId);
				}
			}
		} else {
			for (const [groupChannelId, participants] of groupCallRecordingParticipants.entries()) {
				if (!participants.delete(stableUserId)) continue;
				affectedChannelIds.add(groupChannelId);
				if (participants.size === 0) {
					groupCallRecordingParticipants.delete(groupChannelId);
				}
			}
		}

		for (const groupChannelId of affectedChannelIds) {
			emitGroupCallRecordingPresence(groupChannelId);
		}
	};

	const syncVoiceRecordingPresenceForSocket = (stableUserId: string, socketId: string): void => {
		const affectedChannelIds = new Set<string>();

		for (const [channelId, participants] of voiceChannelRecordingParticipants.entries()) {
			if (!participants.delete(stableUserId)) continue;
			affectedChannelIds.add(channelId);
			if (participants.size === 0) {
				voiceChannelRecordingParticipants.delete(channelId);
			}
		}

		if (voiceCallRecorders.has(stableUserId)) {
			for (const channelId of Array.from(socketVoiceSubscriptions.get(socketId) || [])) {
				let participants = voiceChannelRecordingParticipants.get(channelId);
				if (!participants) {
					participants = new Set<string>();
					voiceChannelRecordingParticipants.set(channelId, participants);
				}
				participants.add(stableUserId);
				affectedChannelIds.add(channelId);
			}
		}

		for (const channelId of affectedChannelIds) {
			emitVoiceChannelRecordingPresence(channelId);
		}
	};

	const clearAllRecordingPresenceForStableUser = (stableUserId: string, socketId?: string): void => {
		directCallRecorders.delete(stableUserId);
		removeRecorderFromGroupChannels(stableUserId);

		if (voiceCallRecorders.delete(stableUserId)) {
			syncVoiceRecordingPresenceForSocket(stableUserId, socketId || resolveSocketId(stableUserId) || stableUserId);
		} else if (socketId) {
			syncVoiceRecordingPresenceForSocket(stableUserId, socketId);
		}
	};

	const setRecordingActiveForSocket = ({
		socketId,
		stableUserId,
		active,
		scope,
		channelId
	}: RecordingActivationRequest): { ok: true } | { ok: false; error: string } => {
		const directAudience = getDirectCallAudience(socketId);

		clearAllRecordingPresenceForStableUser(stableUserId, socketId);
		emitDirectCallRecordingPresenceForSocketSet(directAudience);

		if (!active) {
			return { ok: true };
		}

		if (scope === 'direct') {
			if ((activeCallPeers.get(socketId)?.size || 0) === 0) {
				return { ok: false, error: 'Join an active direct call before recording.' };
			}

			directCallRecorders.add(stableUserId);
			emitDirectCallRecordingPresenceForSocketSet(directAudience);
			return { ok: true };
		}

		if (scope === 'group') {
			if (!channelId) {
				return { ok: false, error: 'Group call recording requires a channel.' };
			}

			const session = groupCallSessions.get(channelId);
			if (!session || !session.connectedParticipants.has(stableUserId)) {
				return { ok: false, error: 'Join the group call before recording.' };
			}

			let participants = groupCallRecordingParticipants.get(channelId);
			if (!participants) {
				participants = new Set<string>();
				groupCallRecordingParticipants.set(channelId, participants);
			}
			participants.add(stableUserId);
			emitGroupCallRecordingPresence(channelId);
			return { ok: true };
		}

		if (scope === 'channel') {
			if ((socketVoiceSubscriptions.get(socketId)?.size || 0) === 0) {
				return { ok: false, error: 'Join or listen to a voice channel before recording.' };
			}

			voiceCallRecorders.add(stableUserId);
			syncVoiceRecordingPresenceForSocket(stableUserId, socketId);
			return { ok: true };
		}

		return { ok: false, error: 'Unsupported recording scope.' };
	};

	return {
		emitDirectCallRecordingPresenceForSocket,
		emitDirectCallRecordingPresenceForSocketSet,
		emitGroupCallRecordingPresence,
		emitVoiceChannelRecordingPresence,
		removeRecorderFromGroupChannels,
		syncVoiceRecordingPresenceForSocket,
		clearAllRecordingPresenceForStableUser,
		setRecordingActiveForSocket
	};
}
