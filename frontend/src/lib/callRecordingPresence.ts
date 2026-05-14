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
