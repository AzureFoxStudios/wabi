import { get } from 'svelte/store';
import { getWabiDB } from './index';
import { getSocket } from '$lib/socketConnection';
import { connected } from '$lib/socket';

const DRAIN_DISPATCH: Record<string, string> = {
	'send-message': 'message',
	'edit-message': 'edit-message',
	'delete-message': 'delete-message',
	'toggle-pin-message': 'toggle-pin-message',
	'add-reaction': 'add-emoji-reaction',
	'remove-reaction': 'remove-emoji-reaction',
	'voice-channel-subscribe': 'voice-channel-subscribe',
	'voice-channel-leave': 'voice-channel-leave',
	'set-voice-transmit-mode': 'set-voice-transmit-mode',
	'assign-role': 'assign-role',
	'remove-role': 'remove-role',
	'ban-user': 'ban-user',
	'create-group': 'create-group',
	'leave-group': 'leave-group',
	'kick-group-member': 'kick-group-member',
	'add-group-member': 'add-group-member',
	'update-group-avatar': 'update-group-avatar',
	'pin-channel': 'pin-channel',
	'unpin-channel': 'unpin-channel',
	'update-profile': 'update-profile',
	'delete-dm': 'delete-dm',
	'message': 'message',
	'delete-emoji': 'delete-emoji',
	'delete-emoji-role-rule': 'delete-emoji-role-rule',
	'clear-channel-messages': 'clear-channel-messages',
	'reception-toggle': 'reception-toggle',
};

export async function drainOutboundQueue(): Promise<void> {
	const db = getWabiDB();
	if (!db) return;

	const sock = getSocket();
	if (!sock || !get(connected)) return;

	const pending = (await db.listQueue({ status: 'pending' })).sort(
		(a, b) => a.createdAt - b.createdAt
	);

	for (const action of pending) {
		const eventName = DRAIN_DISPATCH[action.type];
		if (!eventName) continue;
		try {
			sock.emit(eventName, action.payload);
			await db.markSynced(action.id);
		} catch {
			break;
		}
	}
}
