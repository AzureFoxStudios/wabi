export interface GroupCallSession {
	channelId: string;
	channelName: string;
	initiatorStableId: string;
	isVideoCall: boolean;
	hasEverEstablished: boolean;
	lastInviteSenderId: string;
	invitedParticipants: Set<string>;
	connectedParticipants: Set<string>;
}

interface RemoveGroupCallParticipantOptions {
	userId?: string;
	cancelPendingIfEmpty?: boolean;
	cancelledByUserId?: string;
	onConnectedRemoved?: (channelId: string, stableUserId: string) => void;
}

interface JoinGroupCallOptions {
	onJoined?: (channelId: string) => void;
}

interface CreateGroupCallRuntimeOptions {
	emitToStableUser: (stableUserId: string, event: string, payload: unknown) => void;
	findDisplayName: (stableUserId: string) => string | undefined;
}

export function createGroupCallRuntime({
	emitToStableUser,
	findDisplayName
}: CreateGroupCallRuntimeOptions) {
	const groupCallSessions = new Map<string, GroupCallSession>();

	const isGroupCallEstablished = (session: GroupCallSession): boolean => {
		return session.connectedParticipants.size > 1;
	};

	const cancelPendingGroupCallInvites = (session: GroupCallSession, cancelledByUserId?: string): void => {
		const cancellingUserId = cancelledByUserId || session.lastInviteSenderId;
		if (!cancellingUserId) {
			session.invitedParticipants.clear();
			return;
		}

		for (const stableUserId of Array.from(session.invitedParticipants)) {
			emitToStableUser(stableUserId, 'call-cancelled', {
				userId: cancellingUserId,
				channelId: session.channelId
			});
		}

		session.invitedParticipants.clear();
	};

	const cleanupIdleGroupCallSession = (
		session: GroupCallSession,
		options: { cancelPending?: boolean; cancelledByUserId?: string } = {}
	): boolean => {
		if (session.connectedParticipants.size === 0) {
			if (session.invitedParticipants.size > 0 && options.cancelPending !== false) {
				cancelPendingGroupCallInvites(session, options.cancelledByUserId);
			}
			groupCallSessions.delete(session.channelId);
			return true;
		}

		if (
			session.connectedParticipants.size === 1 &&
			session.invitedParticipants.size === 0 &&
			!session.hasEverEstablished
		) {
			groupCallSessions.delete(session.channelId);
			return true;
		}

		return false;
	};

	const emitGroupCallParticipantJoined = (
		session: GroupCallSession,
		userId: string,
		username: string,
		excludeStableUserId: string
	): void => {
		for (const stableUserId of session.connectedParticipants) {
			if (stableUserId === excludeStableUserId) continue;

			emitToStableUser(stableUserId, 'group-call-participant-joined', {
				channelId: session.channelId,
				channelName: session.channelName,
				stableUserId: userId,
				userId,
				username
			});
		}
	};

	const emitGroupCallParticipantLeft = (session: GroupCallSession, stableUserId: string, userId: string): void => {
		for (const participantStableId of session.connectedParticipants) {
			emitToStableUser(participantStableId, 'group-call-participant-left', {
				channelId: session.channelId,
				stableUserId,
				userId
			});
		}
	};

	const emitGroupCallInviteCleared = (
		session: GroupCallSession,
		stableUserId: string,
		reason: 'rejected' | 'stopped' | 'cancelled'
	): void => {
		const username = findDisplayName(stableUserId) || stableUserId;
		for (const participantStableId of session.connectedParticipants) {
			emitToStableUser(participantStableId, 'group-call-invite-cleared', {
				channelId: session.channelId,
				stableUserId,
				username,
				reason
			});
		}
	};

	const joinGroupCallSession = (
		session: GroupCallSession,
		stableUserId: string,
		username: string,
		options: JoinGroupCallOptions = {}
	): void => {
		const alreadyConnected = session.connectedParticipants.has(stableUserId);
		session.invitedParticipants.delete(stableUserId);
		if (alreadyConnected) return;

		session.connectedParticipants.add(stableUserId);
		if (session.connectedParticipants.size > 1) {
			session.hasEverEstablished = true;
		}
		emitGroupCallParticipantJoined(session, stableUserId, username, stableUserId);
		options.onJoined?.(session.channelId);
	};

	const removeGroupCallParticipantFromSession = (
		session: GroupCallSession,
		stableUserId: string,
		options: RemoveGroupCallParticipantOptions = {}
	): void => {
		const wasInvited = session.invitedParticipants.delete(stableUserId);
		const wasConnected = session.connectedParticipants.delete(stableUserId);

		if (!wasInvited && !wasConnected) return;

		if (wasInvited) {
			emitGroupCallInviteCleared(session, stableUserId, 'cancelled');
		}

		if (wasConnected && options.userId) {
			emitGroupCallParticipantLeft(session, stableUserId, options.userId);
		}

		if (wasConnected) {
			options.onConnectedRemoved?.(session.channelId, stableUserId);
		}

		cleanupIdleGroupCallSession(session, {
			cancelPending: options.cancelPendingIfEmpty,
			cancelledByUserId: options.cancelledByUserId
		});
	};

	return {
		groupCallSessions,
		isGroupCallEstablished,
		cancelPendingGroupCallInvites,
		cleanupIdleGroupCallSession,
		emitGroupCallParticipantJoined,
		emitGroupCallParticipantLeft,
		emitGroupCallInviteCleared,
		joinGroupCallSession,
		removeGroupCallParticipantFromSession
	};
}
