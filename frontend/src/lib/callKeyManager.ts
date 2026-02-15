interface PeerKeyState {
	peerId: string;
	callId: string;
	epoch: number;
	sharedSecret: ArrayBuffer;
	frameKey: Uint8Array;
	ready: boolean;
}

interface PendingReady {
	resolve: () => void;
	reject: (reason?: unknown) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

async function deriveFrameKey(sharedSecret: ArrayBuffer, callId: string, peerId: string, epoch: number): Promise<Uint8Array> {
	const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
	const info = new TextEncoder().encode(`wabi-media-e2ee:${callId}:${peerId}:${epoch}`);
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(32),
			info
		},
		hkdfKey,
		256
	);
	return new Uint8Array(bits);
}

export class CallKeyManager {
	private identityKeyPair: CryptoKeyPair | null = null;
	private publicKeyB64: string | null = null;
	private readonly peerKeys = new Map<string, PeerKeyState>();
	private readonly pending = new Map<string, PendingReady[]>();

	async ensureIdentity(): Promise<string> {
		if (this.identityKeyPair && this.publicKeyB64) return this.publicKeyB64;
		this.identityKeyPair = await crypto.subtle.generateKey(
			{ name: 'ECDH', namedCurve: 'P-256' },
			true,
			['deriveBits']
		);
		const exported = await crypto.subtle.exportKey('raw', this.identityKeyPair.publicKey);
		this.publicKeyB64 = toBase64(exported);
		return this.publicKeyB64;
	}

	async createOffer(callId: string, peerId: string): Promise<{ callId: string; keyMaterial: string }> {
		const keyMaterial = await this.ensureIdentity();
		this.setPeerState(callId, peerId, {
			sharedSecret: new ArrayBuffer(0),
			epoch: 0,
			frameKey: new Uint8Array(0),
			ready: false
		});
		return { callId, keyMaterial };
	}

	async acceptOffer(callId: string, peerId: string, remoteKeyMaterial: string): Promise<{ callId: string; keyMaterial: string; epoch: number }> {
		const localMaterial = await this.ensureIdentity();
		await this.deriveSharedSecret(callId, peerId, remoteKeyMaterial, 1);
		return { callId, keyMaterial: localMaterial, epoch: 1 };
	}

	async acceptAnswer(callId: string, peerId: string, remoteKeyMaterial: string, epoch: number): Promise<void> {
		await this.deriveSharedSecret(callId, peerId, remoteKeyMaterial, epoch);
	}

	async rotate(callId: string, peerId: string): Promise<number> {
		const key = this.peerKeys.get(peerId);
		if (!key || !key.sharedSecret.byteLength) {
			throw new Error(`No shared secret for peer ${peerId}`);
		}
		const nextEpoch = key.epoch + 1;
		const frameKey = await deriveFrameKey(key.sharedSecret, callId, peerId, nextEpoch);
		this.peerKeys.set(peerId, { ...key, callId, epoch: nextEpoch, frameKey, ready: true });
		this.resolvePending(peerId);
		return nextEpoch;
	}

	revoke(peerId: string): void {
		this.peerKeys.delete(peerId);
		this.rejectPending(peerId, new Error(`Peer ${peerId} revoked`));
	}

	setRemoteEpoch(peerId: string, epoch: number): void {
		const key = this.peerKeys.get(peerId);
		if (!key) return;
		key.epoch = epoch;
	}

	getFrameKey(peerId: string): Uint8Array | null {
		return this.peerKeys.get(peerId)?.frameKey ?? null;
	}

	isReady(peerId: string): boolean {
		return Boolean(this.peerKeys.get(peerId)?.ready);
	}

	waitUntilReady(peerId: string, timeoutMs = 7000): Promise<void> {
		if (this.isReady(peerId)) return Promise.resolve();

		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				this.pending.set(
					peerId,
					(this.pending.get(peerId) || []).filter(entry => entry.timeoutId !== timeoutId)
				);
				reject(new Error(`Timed out waiting for E2EE key exchange with ${peerId}`));
			}, timeoutMs);
			const list = this.pending.get(peerId) || [];
			list.push({ resolve, reject, timeoutId });
			this.pending.set(peerId, list);
		});
	}

	private setPeerState(callId: string, peerId: string, state: Omit<PeerKeyState, 'callId' | 'peerId'>): void {
		this.peerKeys.set(peerId, { ...state, callId, peerId });
	}

	private async deriveSharedSecret(callId: string, peerId: string, remoteKeyMaterial: string, epoch: number): Promise<void> {
		if (!this.identityKeyPair?.privateKey) {
			await this.ensureIdentity();
		}
		const remotePublicKey = await crypto.subtle.importKey(
			'raw',
			fromBase64(remoteKeyMaterial),
			{ name: 'ECDH', namedCurve: 'P-256' },
			false,
			[]
		);
		const sharedSecret = await crypto.subtle.deriveBits(
			{ name: 'ECDH', public: remotePublicKey },
			this.identityKeyPair!.privateKey,
			256
		);
		const frameKey = await deriveFrameKey(sharedSecret, callId, peerId, epoch);
		this.setPeerState(callId, peerId, { sharedSecret, epoch, frameKey, ready: true });
		this.resolvePending(peerId);
	}

	private resolvePending(peerId: string): void {
		const pending = this.pending.get(peerId);
		if (!pending) return;
		pending.forEach(entry => {
			clearTimeout(entry.timeoutId);
			entry.resolve();
		});
		this.pending.delete(peerId);
	}

	private rejectPending(peerId: string, reason: unknown): void {
		const pending = this.pending.get(peerId);
		if (!pending) return;
		pending.forEach(entry => {
			clearTimeout(entry.timeoutId);
			entry.reject(reason);
		});
		this.pending.delete(peerId);
	}
}

export const callKeyManager = new CallKeyManager();
