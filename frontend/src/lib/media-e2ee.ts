type EncodedStreams = {
	readable: ReadableStream<any>;
	writable: WritableStream<any>;
};

type InsertableEndpoint = {
	createEncodedStreams?: () => EncodedStreams;
};

const attachedSenders = new WeakSet<RTCRtpSender>();
const attachedReceivers = new WeakSet<RTCRtpReceiver>();

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, arr) => sum + arr.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptFrameData(data: Uint8Array, rawKey: Uint8Array, epoch: number): Promise<Uint8Array> {
	const iv = randomBytes(12);
	const key = await importAesKey(rawKey);
	const aad = new Uint8Array(4);
	new DataView(aad.buffer).setUint32(0, epoch);
	const encrypted = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad },
		key,
		data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
	);
	return concat(new Uint8Array([0x57, 0x41, 0x42, 0x49]), aad, iv, new Uint8Array(encrypted));
}

async function decryptFrameData(data: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
	if (data.length < 20) return data;
	if (data[0] !== 0x57 || data[1] !== 0x41 || data[2] !== 0x42 || data[3] !== 0x49) return data;

	const aad = data.slice(4, 8);
	const iv = data.slice(8, 20);
	const cipher = data.slice(20);
	const key = await importAesKey(rawKey);
	const clear = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv, additionalData: aad },
		key,
		cipher.buffer.slice(cipher.byteOffset, cipher.byteOffset + cipher.byteLength)
	);
	return new Uint8Array(clear);
}

function getEncodedFrameData(frame: any): Uint8Array {
	if (frame.data instanceof ArrayBuffer) return new Uint8Array(frame.data);
	if (ArrayBuffer.isView(frame.data)) return new Uint8Array(frame.data.buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.byteLength));
	return new Uint8Array(0);
}

function setEncodedFrameData(frame: any, data: Uint8Array): void {
	frame.data = data.buffer;
}

function createEncryptTransform(getKey: () => Uint8Array | null, getEpoch: () => number): TransformStream<any, any> {
	return new TransformStream({
		async transform(frame, controller) {
			const key = getKey();
			if (!key) {
				controller.enqueue(frame);
				return;
			}
			try {
				const encrypted = await encryptFrameData(getEncodedFrameData(frame), key, getEpoch());
				setEncodedFrameData(frame, encrypted);
				controller.enqueue(frame);
			} catch (error) {
				console.error('[E2EE] Failed to encrypt frame:', error);
			}
		}
	});
}

function createDecryptTransform(getKey: () => Uint8Array | null): TransformStream<any, any> {
	return new TransformStream({
		async transform(frame, controller) {
			const key = getKey();
			if (!key) {
				controller.enqueue(frame);
				return;
			}
			try {
				const decrypted = await decryptFrameData(getEncodedFrameData(frame), key);
				setEncodedFrameData(frame, decrypted);
				controller.enqueue(frame);
			} catch (error) {
				console.error('[E2EE] Failed to decrypt frame:', error);
			}
		}
	});
}

function attachTransform(endpoint: InsertableEndpoint, transform: TransformStream<any, any>): boolean {
	if (typeof endpoint.createEncodedStreams !== 'function') {
		return false;
	}
	const { readable, writable } = endpoint.createEncodedStreams();
	readable.pipeThrough(transform).pipeTo(writable).catch((error) => {
		console.error('[E2EE] Insertable stream pipeline failed:', error);
	});
	return true;
}

export function attachPeerConnectionE2EE(
	pc: RTCPeerConnection,
	getKey: () => Uint8Array | null,
	getEpoch: () => number
): void {
	for (const sender of pc.getSenders()) {
		if (attachedSenders.has(sender)) continue;
		if (!sender.track) continue;
		const ok = attachTransform(sender as unknown as InsertableEndpoint, createEncryptTransform(getKey, getEpoch));
		if (ok) attachedSenders.add(sender);
	}

	for (const receiver of pc.getReceivers()) {
		if (attachedReceivers.has(receiver)) continue;
		const ok = attachTransform(receiver as unknown as InsertableEndpoint, createDecryptTransform(getKey));
		if (ok) attachedReceivers.add(receiver);
	}
}

export function supportsMediaE2EE(pc: RTCPeerConnection): boolean {
	const sender = pc.getSenders()[0] as unknown as InsertableEndpoint | undefined;
	const receiver = pc.getReceivers()[0] as unknown as InsertableEndpoint | undefined;
	return Boolean(sender?.createEncodedStreams || receiver?.createEncodedStreams);
}
