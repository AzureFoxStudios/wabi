import { writable } from 'svelte/store';

export type CallRecordingScope = 'direct' | 'group' | 'channel';

export interface RecordingPresenceParticipant {
	userId: string;
	socketId?: string;
	username?: string;
	profilePicture?: string;
}

export const directCallRecordingParticipants = writable<RecordingPresenceParticipant[]>([]);
export const groupCallRecordingParticipants = writable<Record<string, RecordingPresenceParticipant[]>>({});
export const voiceCallRecordingParticipants = writable<Record<string, RecordingPresenceParticipant[]>>({});

export function setRecordingPresence(
	scope: CallRecordingScope,
	participants: RecordingPresenceParticipant[],
	channelId?: string
): void {
	if (scope === 'direct') {
		directCallRecordingParticipants.set(participants);
		return;
	}

	if (!channelId) return;

	if (scope === 'group') {
		groupCallRecordingParticipants.update((current) => ({
			...current,
			[channelId]: participants
		}));
		return;
	}

	voiceCallRecordingParticipants.update((current) => ({
		...current,
		[channelId]: participants
	}));
}

export function clearRecordingPresence(scope: CallRecordingScope, channelId?: string): void {
	if (scope === 'direct') {
		directCallRecordingParticipants.set([]);
		return;
	}

	if (!channelId) return;

	if (scope === 'group') {
		groupCallRecordingParticipants.update((current) => {
			const next = { ...current };
			delete next[channelId];
			return next;
		});
		return;
	}

	voiceCallRecordingParticipants.update((current) => {
		const next = { ...current };
		delete next[channelId];
		return next;
	});
}

export function clearAllRecordingPresence(): void {
	directCallRecordingParticipants.set([]);
	groupCallRecordingParticipants.set({});
	voiceCallRecordingParticipants.set({});
}

/**
 * Server `call-recording-presence-changed` reducer (round 5): upsert/remove
 * ONE recorder per scope. The server sends per-recorder deltas (not full
 * lists), so ordering and multi-recorder states stay correct.
 */
export interface RemoteRecordingPresenceEvent {
	active: boolean;
	scope: CallRecordingScope;
	channelIds?: string[];
	recorder?: { userId?: string; username?: string; profilePicture?: string };
}

export function applyRemoteRecordingPresence(payload: RemoteRecordingPresenceEvent): void {
	const recorderId = payload.recorder?.userId;
	if (!recorderId) return;
	const participant: RecordingPresenceParticipant = {
		userId: recorderId,
		username: payload.recorder?.username,
		profilePicture: payload.recorder?.profilePicture
	};

	if (payload.scope === 'direct') {
		directCallRecordingParticipants.update((list) =>
			payload.active
				? [...list.filter((p) => p.userId !== recorderId), participant]
				: list.filter((p) => p.userId !== recorderId)
		);
		return;
	}

	const store =
		payload.scope === 'group' ? groupCallRecordingParticipants : voiceCallRecordingParticipants;
	for (const channelId of payload.channelIds ?? []) {
		store.update((byChannel) => {
			const next = { ...byChannel };
			const current = next[channelId] ?? [];
			next[channelId] = payload.active
				? [...current.filter((p) => p.userId !== recorderId), participant]
				: current.filter((p) => p.userId !== recorderId);
			if (next[channelId].length === 0) delete next[channelId];
			return next;
		});
	}
}

/** Drop one peer's direct-call REC badge (their call with us ended). */
export function removeDirectRecordingParticipant(userId: string): void {
	directCallRecordingParticipants.update((list) => list.filter((p) => p.userId !== userId));
}
