import { get } from 'svelte/store';
import { getWabiDB } from './index';
import { getSocket } from '$lib/socketConnection';
import { connected } from '$lib/socket';
import { groupQueueDecision, queueRejectionReason } from './queue/groupPolicy';
import { groupMembership } from '$lib/groupAccess';
import { _updateOptimisticMessage } from '$lib/messageStore';

const UNCONFIRMED_MESSAGE = 'Delivery not confirmed. This message may have been sent; check the conversation before sending again.';
const awaitingMessages = new Set<string>();
function markUnconfirmed(channelId: string, clientMessageId: string, error: string): void {
	_updateOptimisticMessage(channelId, message => message.clientMessageId === clientMessageId && Boolean(message.deliveryState),
		{ deliveryState: 'failed', deliveryError: error });
}

const DRAIN_DISPATCH: Record<string, string> = {
	'send-message': 'message',
	'edit-message': 'edit-message',
	'delete-message': 'delete-message',
	'toggle-pin-message': 'toggle-pin-message',
	'add-reaction': 'add-emoji-reaction',
	'remove-reaction': 'remove-emoji-reaction',
	'assign-role': 'assign-role',
	'remove-role': 'remove-role',
	'ban-user': 'ban-user',
	'pin-channel': 'pin-channel',
	'unpin-channel': 'unpin-channel',
	'update-profile': 'update-profile',
	'delete-dm': 'delete-dm',
	'message': 'message',
	'delete-emoji': 'delete-emoji',
	'delete-emoji-role-rule': 'delete-emoji-role-rule',
	'clear-channel-messages': 'clear-channel-messages',
	'toggle-reception': 'toggle-reception',
};

let draining: Promise<void> | null = null;
let requested = false;
export function drainOutboundQueue(): Promise<void> {
	requested = true;
	if (!draining) draining = (async () => {
		do { requested = false; await drainOnce(); } while (requested);
	})().finally(() => { draining = null; });
	return draining;
}

async function drainOnce(): Promise<void> {
	const db = getWabiDB();
	if (!db) return;

	const sock = getSocket();
	if (!sock || !get(connected)) return;
	const socketId = sock.id;
	const realm = groupMembership.realm();
	const current = () => getSocket() === sock && sock.connected && sock.id === socketId && groupMembership.realm() === realm;

	const pending = (await db.listQueue({ status: 'pending' })).sort(
		(a, b) => a.createdAt - b.createdAt
	);

	for (const action of pending) {
		if (!current()) return;
		const decision = groupQueueDecision(action, groupMembership);
		if (decision === 'defer') continue;
		if (decision === 'reject') {
			const reason = queueRejectionReason(action);
			await db.markFailed(action.id, reason, false);
			const payload = action.payload as { channelId?: string; clientMessageId?: string } | null;
			if (payload?.channelId && payload.clientMessageId) markUnconfirmed(payload.channelId, payload.clientMessageId, reason);
			continue;
		}
		const eventName = DRAIN_DISPATCH[action.type];
		if (!eventName) continue;
		if (eventName === 'message') {
			const payload = action.payload as { channelId?: string; clientMessageId?: string } | null;
			if (action.attemptedAt !== undefined && awaitingMessages.has(action.id)) continue;
			if (!payload?.channelId || !payload.clientMessageId || action.attemptedAt !== undefined) {
				await db.markFailed(action.id, UNCONFIRMED_MESSAGE, false);
				if (payload?.channelId && payload.clientMessageId) markUnconfirmed(payload.channelId, payload.clientMessageId, UNCONFIRMED_MESSAGE);
				continue;
			}
			if (!await db.claimMessage(action.id)) continue;
			// Claim before emit prevents cross-tab/reload duplicate delivery.
			// Recheck after the storage await: removal may have won the race.
			if (!current() || groupQueueDecision(action, groupMembership) !== 'send') {
				await db.markFailed(action.id, 'Not sent: connection or group access changed before sending.', false);
				continue;
			}
			awaitingMessages.add(action.id);
			setTimeout(() => {
				awaitingMessages.delete(action.id);
				void db.markFailed(action.id, UNCONFIRMED_MESSAGE, false).catch(error => console.warn('[queue] Could not record unconfirmed delivery', error));
				if (current()) markUnconfirmed(payload.channelId!, payload.clientMessageId!, UNCONFIRMED_MESSAGE);
			}, 15_000);
		}
		try {
			sock.emit(eventName, action.payload);
			// Chat stays pending until message-accepted. Socket.IO emit is not
			// a server acknowledgement. The attempt marker prevents unsafe retry.
			if (eventName !== 'message') await db.markSynced(action.id);
		} catch {
			break;
		}
	}

	// Call owners readmit after authoritative init. Queue dispatch is neither
	// roster acknowledgement nor ownership of a media transport.
}
