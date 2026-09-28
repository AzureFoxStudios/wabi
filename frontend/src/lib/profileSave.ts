import { get } from 'svelte/store';
import { connected, currentUser, getSocket } from './socket';
import { isCurrentUserProfile } from './profileIdentity';

export interface ProfileSaveSocket {
	connected?: boolean;
	id?: string;
	on(event: string, handler: (payload: any) => void): unknown;
	off(event: string, handler: (payload: any) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

/** Correlation prevents another profile update from confirming this draft. */
export function requestProfileSave(sock: ProfileSaveSocket, patch: Record<string, unknown>, requestId: string, isSelf: (payload: any) => boolean, timeoutMs = 10000): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			sock.off('profile-updated', onSaved);
			sock.off('profile-update-failed', onFailed);
			sock.off('disconnect', onDisconnected);
		};
		const onSaved = (payload: any) => {
			if (payload?.profileRequestId !== requestId || !isSelf(payload)) return;
			cleanup(); resolve();
		};
		const onFailed = (payload: any) => {
			if (payload?.profileRequestId !== requestId) return;
			cleanup(); reject(new Error(payload.reason || payload.message || 'The server could not save your profile.'));
		};
		const onDisconnected = () => { cleanup(); reject(new Error('Disconnected before the save was confirmed. Reconnect and check your profile before retrying.')); };
		const timer = setTimeout(() => { cleanup(); reject(new Error('The save could not be confirmed. Check your profile after reconnecting before retrying.')); }, timeoutMs);
		sock.on('profile-updated', onSaved);
		sock.on('profile-update-failed', onFailed);
		sock.on('disconnect', onDisconnected);
		try { sock.emit('update-profile', { ...patch, requestId }); } catch (error) { cleanup(); reject(error); }
	});
}

export async function saveProfilePatch(patch: Record<string, unknown>): Promise<void> {
	const sock = getSocket();
	const self = get(currentUser);
	if (!sock || !self || !get(connected) || sock.connected === false) throw new Error('Connect to your server to publish profile changes.');
	const requestId = crypto.randomUUID();
	await requestProfileSave(sock, patch, requestId, (payload) => isCurrentUserProfile(payload, self, sock.id));
}
