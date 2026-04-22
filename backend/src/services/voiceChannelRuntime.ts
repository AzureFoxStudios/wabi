interface VoiceChannelLike {
	id: string;
	type?: string;
	minRole?: string;
	members?: string[];
	parentChannelId?: string;
	breakoutIndex?: number;
	voiceSettings?: {
		userLimit?: number | null;
		forceSolo?: boolean;
	};
}

interface VoiceParticipantLike {
	userId: string;
	socketId: string;
	username?: string;
	profilePicture?: string;
}

interface MoveVoiceParticipantOptions {
	onMoved?: (payload: {
		stableUserId: string;
		member: VoiceParticipantLike;
		fromChannelId: string;
		toChannelId: string;
	}) => void;
}

interface CreateVoiceChannelRuntimeOptions<TChannel extends VoiceChannelLike, TSocket> {
	channels: Map<string, TChannel>;
	resolveSocketId: (stableUserId: string) => string | null;
	buildVoiceParticipant: (stableUserId: string) => VoiceParticipantLike;
	getVoiceChannelUserLimit: (channel: TChannel | undefined) => number | null;
	isVoiceChannelFocusedAudio: (channel: TChannel | undefined) => boolean;
	canSocketAccessChannel: (socket: TSocket, channel: TChannel) => boolean;
	listSockets: () => Iterable<TSocket>;
	emitStateToSocket: (socket: TSocket, event: string, payload: unknown) => void;
	emitToSocketId: (socketId: string, event: string, payload: unknown) => void;
}

export function createVoiceChannelRuntime<TChannel extends VoiceChannelLike, TSocket>({
	channels,
	resolveSocketId,
	buildVoiceParticipant,
	getVoiceChannelUserLimit,
	isVoiceChannelFocusedAudio,
	canSocketAccessChannel,
	listSockets,
	emitStateToSocket,
	emitToSocketId
}: CreateVoiceChannelRuntimeOptions<TChannel, TSocket>) {
	const voiceChannelParticipants = new Map<string, Set<string>>();
	const voiceChannelSubscribers = new Map<string, Set<string>>();
	const socketVoiceSubscriptions = new Map<string, Set<string>>();
	const voicePeerGraph = new Map<string, Set<string>>();

	const getVoiceChannelMembers = (channelId: string): VoiceParticipantLike[] => {
		const participants = voiceChannelParticipants.get(channelId);
		if (!participants || participants.size === 0) return [];
		return Array.from(participants).map(buildVoiceParticipant);
	};

	const canJoinVoiceChannel = (channel: TChannel, stableUserId: string): { allowed: true } | { allowed: false; reason: string } => {
		const participants = voiceChannelParticipants.get(channel.id);
		if (participants?.has(stableUserId)) {
			return { allowed: true };
		}

		const limit = getVoiceChannelUserLimit(channel);
		if (limit !== null && (participants?.size || 0) >= limit) {
			return {
				allowed: false,
				reason: channel.voiceSettings?.forceSolo
					? 'This voice channel is forced solo right now'
					: 'This voice channel is full'
			};
		}

		return { allowed: true };
	};

	const canSubscribeToVoiceChannel = (socketId: string, channel: TChannel): { allowed: true } | { allowed: false; reason: string } => {
		const existingSubscriptions = Array.from(socketVoiceSubscriptions.get(socketId) || []);
		const otherSubscriptions = existingSubscriptions.filter((subscribedChannelId) => subscribedChannelId !== channel.id);
		const targetIsFocused = isVoiceChannelFocusedAudio(channel);
		const existingFocusedChannel = otherSubscriptions
			.map((subscribedChannelId) => channels.get(subscribedChannelId))
			.find((subscribedChannel) => isVoiceChannelFocusedAudio(subscribedChannel));

		if (targetIsFocused && otherSubscriptions.length > 0) {
			return {
				allowed: false,
				reason: 'This voice channel requires focused audio. Leave other listen-in channels first.'
			};
		}

		if (existingFocusedChannel) {
			return {
				allowed: false,
				reason: 'Your current voice channel requires focused audio. Leave it before listening elsewhere.'
			};
		}

		return { allowed: true };
	};

	const addVoiceSubscription = (socketId: string, channelId: string): void => {
		let channelSubscribers = voiceChannelSubscribers.get(channelId);
		if (!channelSubscribers) {
			channelSubscribers = new Set<string>();
			voiceChannelSubscribers.set(channelId, channelSubscribers);
		}
		channelSubscribers.add(socketId);

		let socketSubscriptions = socketVoiceSubscriptions.get(socketId);
		if (!socketSubscriptions) {
			socketSubscriptions = new Set<string>();
			socketVoiceSubscriptions.set(socketId, socketSubscriptions);
		}
		socketSubscriptions.add(channelId);
	};

	const removeVoiceSubscription = (socketId: string, channelId: string): void => {
		const channelSubscribers = voiceChannelSubscribers.get(channelId);
		if (channelSubscribers) {
			channelSubscribers.delete(socketId);
			if (channelSubscribers.size === 0) {
				voiceChannelSubscribers.delete(channelId);
			}
		}

		const socketSubscriptions = socketVoiceSubscriptions.get(socketId);
		if (socketSubscriptions) {
			socketSubscriptions.delete(channelId);
			if (socketSubscriptions.size === 0) {
				socketVoiceSubscriptions.delete(socketId);
			}
		}
	};

	const removeAllVoiceSubscriptionsForSocket = (socketId: string): void => {
		const subscriptions = Array.from(socketVoiceSubscriptions.get(socketId) || []);
		for (const channelId of subscriptions) {
			removeVoiceSubscription(socketId, channelId);
		}
	};

	const getVoiceAudienceSocketIds = (channelId: string): Set<string> => {
		const audience = new Set<string>();

		const participants = voiceChannelParticipants.get(channelId);
		if (participants) {
			for (const stableUserId of participants) {
				const participantSocketId = resolveSocketId(stableUserId);
				if (participantSocketId) {
					audience.add(participantSocketId);
				}
			}
		}

		const subscribers = voiceChannelSubscribers.get(channelId);
		if (subscribers) {
			for (const subscriberSocketId of subscribers) {
				audience.add(subscriberSocketId);
			}
		}

		return audience;
	};

	const emitToVoiceAudience = (channelId: string, event: string, data: unknown): void => {
		for (const socketId of getVoiceAudienceSocketIds(channelId)) {
			emitToSocketId(socketId, event, data);
		}
	};

	const getVoiceStatePayload = (): Record<string, VoiceParticipantLike[]> => {
		const payload: Record<string, VoiceParticipantLike[]> = {};
		for (const channelId of voiceChannelParticipants.keys()) {
			payload[channelId] = getVoiceChannelMembers(channelId);
		}
		return payload;
	};

	const emitVoiceChannelState = (channelId: string): void => {
		const channel = channels.get(channelId);
		if (!channel || channel.type !== 'voice') return;

		const payload = {
			channelId,
			members: getVoiceChannelMembers(channelId)
		};

		for (const targetSocket of listSockets()) {
			if (!canSocketAccessChannel(targetSocket, channel)) continue;
			emitStateToSocket(targetSocket, 'voice-channel-state', payload);
		}
	};

	const getBreakoutChannelsForParent = (parentChannelId: string): TChannel[] => {
		return Array.from(channels.values())
			.filter((channel) => channel.type === 'voice' && channel.parentChannelId === parentChannelId)
			.sort((a, b) => (a.breakoutIndex || 0) - (b.breakoutIndex || 0));
	};

	const moveVoiceParticipant = (
		stableUserId: string,
		fromChannelId: string,
		toChannelId: string,
		options: MoveVoiceParticipantOptions = {}
	): boolean => {
		if (fromChannelId === toChannelId) return false;
		const fromParticipants = voiceChannelParticipants.get(fromChannelId);
		if (!fromParticipants || !fromParticipants.has(stableUserId)) return false;

		let toParticipants = voiceChannelParticipants.get(toChannelId);
		if (!toParticipants) {
			toParticipants = new Set<string>();
			voiceChannelParticipants.set(toChannelId, toParticipants);
		}
		if (toParticipants.has(stableUserId)) return false;

		const member = buildVoiceParticipant(stableUserId);

		fromParticipants.delete(stableUserId);
		if (fromParticipants.size === 0) {
			voiceChannelParticipants.delete(fromChannelId);
		}

		toParticipants.add(stableUserId);

		emitVoiceChannelState(fromChannelId);
		emitVoiceChannelState(toChannelId);
		options.onMoved?.({
			stableUserId,
			member,
			fromChannelId,
			toChannelId
		});

		emitToVoiceAudience(fromChannelId, 'voice-channel-user-left', {
			channelId: fromChannelId,
			userId: stableUserId,
			socketId: member.socketId
		});
		emitToVoiceAudience(toChannelId, 'voice-channel-user-joined', {
			channelId: toChannelId,
			userId: stableUserId,
			socketId: member.socketId,
			username: member.username
		});
		return true;
	};

	const addVoicePeerLink = (stableA: string, stableB: string): void => {
		if (stableA === stableB) return;
		if (!voicePeerGraph.has(stableA)) voicePeerGraph.set(stableA, new Set());
		if (!voicePeerGraph.has(stableB)) voicePeerGraph.set(stableB, new Set());
		voicePeerGraph.get(stableA)!.add(stableB);
		voicePeerGraph.get(stableB)!.add(stableA);
	};

	const removeVoicePeerLink = (stableA: string, stableB: string): void => {
		voicePeerGraph.get(stableA)?.delete(stableB);
		if ((voicePeerGraph.get(stableA)?.size || 0) === 0) voicePeerGraph.delete(stableA);
		voicePeerGraph.get(stableB)?.delete(stableA);
		if ((voicePeerGraph.get(stableB)?.size || 0) === 0) voicePeerGraph.delete(stableB);
	};

	const removeAllVoicePeerLinks = (stableId: string): Set<string> => {
		const peers = new Set(voicePeerGraph.get(stableId) || []);
		for (const peerStableId of peers) {
			voicePeerGraph.get(peerStableId)?.delete(stableId);
			if ((voicePeerGraph.get(peerStableId)?.size || 0) === 0) {
				voicePeerGraph.delete(peerStableId);
			}
		}
		voicePeerGraph.delete(stableId);
		return peers;
	};

	return {
		voiceChannelParticipants,
		voiceChannelSubscribers,
		socketVoiceSubscriptions,
		voicePeerGraph,
		getVoiceChannelMembers,
		canJoinVoiceChannel,
		canSubscribeToVoiceChannel,
		addVoiceSubscription,
		removeVoiceSubscription,
		removeAllVoiceSubscriptionsForSocket,
		getVoiceAudienceSocketIds,
		emitToVoiceAudience,
		getVoiceStatePayload,
		emitVoiceChannelState,
		getBreakoutChannelsForParent,
		moveVoiceParticipant,
		addVoicePeerLink,
		removeVoicePeerLink,
		removeAllVoicePeerLinks
	};
}
