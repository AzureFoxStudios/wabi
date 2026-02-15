import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';
import type { User } from './socket-types';
import { ENCRYPTION_STORAGE_KEY } from './encryption';

export interface SignalingParticipantIdentity {
	socketId: string;
	stableUserId: string;
	dbUserId: number | null;
	sessionId: string | null;
	authenticated: boolean;
	mediaKeyFingerprint: string | null;
	mediaKeyVersion: number | null;
	boundAt: number | null;
}

interface KeyStateMetadata {
	lastFingerprint: string;
	lastVersion: number;
	lastSessionId: string | null;
	lastSeenAt: number;
	compromised: boolean;
	mismatchCount: number;
}

type KeyStateStore = Record<string, KeyStateMetadata>;

const KEY_STATE_STORAGE = 'wabi_media_key_state_meta_v1';

let localStableUserId: string | null = null;
let localDbUserId: number | null = null;
let localAuthenticated = false;

function loadKeyStateStore(): KeyStateStore {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(KEY_STATE_STORAGE);
		return raw ? (JSON.parse(raw) as KeyStateStore) : {};
	} catch {
		return {};
	}
}

function persistKeyStateStore(store: KeyStateStore): void {
	if (!browser) return;
	localStorage.setItem(KEY_STATE_STORAGE, JSON.stringify(store));
}

async function fingerprintForUser(dbUserId: number): Promise<string> {
	if (!browser || !window.crypto?.subtle) return `fallback-${dbUserId}`;

	let publicKey = '';
	try {
		const raw = localStorage.getItem(ENCRYPTION_STORAGE_KEY);
		if (raw) {
			const keyMap = JSON.parse(raw) as Record<string, { publicKey?: string }>;
			publicKey = keyMap[String(dbUserId)]?.publicKey || '';
		}
	} catch {
		// ignore JSON parse failures
	}

	const source = publicKey || `user-${dbUserId}-no-public-key`;
	const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	const bytes = Array.from(new Uint8Array(digest));
	return bytes.slice(0, 16).map(v => v.toString(16).padStart(2, '0')).join('');
}

function stableIdForUser(user: User): string {
	return user.dbUserId ? `user-${user.dbUserId}` : user.id;
}

export async function initializeLocalMediaIdentity(socket: Socket, user: User): Promise<void> {
	localStableUserId = stableIdForUser(user);
	localDbUserId = user.dbUserId || null;
	localAuthenticated = Boolean(user.dbUserId && localStorage.getItem('authToken'));

	const mediaKeyFingerprint = localDbUserId ? await fingerprintForUser(localDbUserId) : `guest-${user.id}`;
	socket.emit('bind-media-identity', {
		mediaKeyFingerprint,
		mediaKeyVersion: 1
	});
}

export function verifyParticipantIdentity(
	senderId: string,
	identity?: SignalingParticipantIdentity
): { ok: boolean; reason?: string } {
	if (!identity) return { ok: false, reason: 'missing_identity' };
	if (!identity.mediaKeyFingerprint) return { ok: false, reason: 'missing_media_key_fingerprint' };
	if (!identity.authenticated || !identity.stableUserId.startsWith('user-')) {
		return { ok: false, reason: 'unauthenticated_participant' };
	}

	const store = loadKeyStateStore();
	const key = identity.stableUserId;
	const existing = store[key];

	if (existing && existing.lastFingerprint !== identity.mediaKeyFingerprint) {
		store[key] = {
			...existing,
			compromised: true,
			mismatchCount: existing.mismatchCount + 1,
			lastSeenAt: Date.now(),
			lastSessionId: identity.sessionId
		};
		persistKeyStateStore(store);
		return { ok: false, reason: 'key_continuity_violation' };
	}

	store[key] = {
		lastFingerprint: identity.mediaKeyFingerprint,
		lastVersion: identity.mediaKeyVersion || 1,
		lastSessionId: identity.sessionId,
		lastSeenAt: Date.now(),
		compromised: existing?.compromised || false,
		mismatchCount: existing?.mismatchCount || 0
	};
	persistKeyStateStore(store);

	if (identity.socketId !== senderId) {
		return { ok: false, reason: 'socket_identity_mismatch' };
	}

	if (localAuthenticated && localStableUserId === key && senderId !== identity.socketId) {
		return { ok: false, reason: 'self_identity_collision' };
	}

	return { ok: true };
}

export function triggerImmediateGroupRekey(channelId: string, reason: string, membersVersion: number): void {
	if (!browser) return;
	const store = loadKeyStateStore();
	store[`group:${channelId}`] = {
		lastFingerprint: `rekey:${reason}`,
		lastVersion: membersVersion,
		lastSessionId: null,
		lastSeenAt: Date.now(),
		compromised: false,
		mismatchCount: 0
	};
	persistKeyStateStore(store);
	console.log(`[MediaIdentity] Immediate group rekey requested for ${channelId} (${reason}, v${membersVersion})`);
}

export function getCompromisedSessions(): Array<{ stableUserId: string; mismatchCount: number; lastSeenAt: number }> {
	const store = loadKeyStateStore();
	return Object.entries(store)
		.filter(([, state]) => state.compromised)
		.map(([stableUserId, state]) => ({ stableUserId, mismatchCount: state.mismatchCount, lastSeenAt: state.lastSeenAt }));
}
