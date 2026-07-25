import { get } from 'svelte/store';
import { getWabiDB } from './index';
import { getSocket } from '$lib/socketConnection';
import { connected } from '$lib/socket';

export async function drainOutboundQueue(): Promise<void> {
	const db = getWabiDB();
	if (!db) return;

	const sock = getSocket();
	if (!sock || !get(connected)) return;

	const pending = (await db.listQueue({ status: 'pending' })).sort(
		(a, b) => a.createdAt - b.createdAt
	);

	for (const action of pending) {
		if (action.type !== 'send-message') continue;
		try {
			sock.emit('message', action.payload);
			await db.markSynced(action.id);
		} catch {
			break;
		}
	}
}
