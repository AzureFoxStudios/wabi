import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { dirname, join } from 'path';
import { DATA_DIR } from '../constants.js';
import { type StatePlaneConfig } from './config.js';
import { type StatePlaneOutboxRecord } from './outbox.js';

const REDUCER_INGRESS_PATH = '/api/internal/state-plane/reducer';
const MAX_SEEN_EVENTS = 50_000;
const MAX_SEEN_NONCES = 50_000;
const ALLOWED_ENTITIES = new Set([
	'message',
	'channel',
	'channel_member',
	'user',
	'session',
	'rbac',
	'presence',
	'system'
]);

interface ReducerIngressRequest {
	headers: Record<string, string | string[] | undefined>;
	body: string;
	remoteAddress: string | null;
}

interface ReducerIngressResponse {
	status: number;
	success: boolean;
	duplicate: boolean;
	reason: string | null;
	message: string;
}

export interface StatePlaneReducerIngressStats {
	enabled: boolean;
	path: string;
	requireSignature: boolean;
	requireBearerToken: boolean;
	maxSkewMs: number;
	maxBodyBytes: number;
	accepted: number;
	duplicates: number;
	rejected: number;
	rejectedAuth: number;
	rejectedSignature: number;
	rejectedReplay: number;
	rejectedParse: number;
	errors: number;
	lastAcceptedAt: number | null;
	lastRejectedAt: number | null;
	lastError: string | null;
	lastErrorAt: number | null;
	ingestPath: string;
}

export class StatePlaneReducerIngress {
	private readonly enabled: boolean;
	private readonly requireSignature: boolean;
	private readonly signingSecret: string | null;
	private readonly signingKeyId: string | null;
	private readonly bearerToken: string | null;
	private readonly maxSkewMs: number;
	private readonly maxBodyBytes: number;
	private readonly ingestPath: string;
	private accepted = 0;
	private duplicates = 0;
	private rejected = 0;
	private rejectedAuth = 0;
	private rejectedSignature = 0;
	private rejectedReplay = 0;
	private rejectedParse = 0;
	private errors = 0;
	private lastAcceptedAt: number | null = null;
	private lastRejectedAt: number | null = null;
	private lastError: string | null = null;
	private lastErrorAt: number | null = null;
	private seenEventIds = new Set<string>();
	private seenEventQueue: string[] = [];
	private seenNonces = new Map<string, number>();
	private seenNonceQueue: string[] = [];

	constructor(config: StatePlaneConfig) {
		this.enabled = config.reducerIngressEnabled;
		this.requireSignature = config.reducerIngressRequireSignature;
		this.signingSecret = config.shadowSigningSecret;
		this.signingKeyId = config.shadowSigningKeyId;
		this.bearerToken = config.shadowToken;
		this.maxSkewMs = config.reducerIngressMaxSkewMs;
		this.maxBodyBytes = config.reducerIngressMaxBodyBytes;
		this.ingestPath = join(DATA_DIR, 'state-plane-reducer-ingest.ndjson');
		this.ensurePaths();
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getPath(): string {
		return REDUCER_INGRESS_PATH;
	}

	getMaxBodyBytes(): number {
		return this.maxBodyBytes;
	}

	getStats(): StatePlaneReducerIngressStats {
		return {
			enabled: this.enabled,
			path: REDUCER_INGRESS_PATH,
			requireSignature: this.requireSignature,
			requireBearerToken: this.bearerToken != null,
			maxSkewMs: this.maxSkewMs,
			maxBodyBytes: this.maxBodyBytes,
			accepted: this.accepted,
			duplicates: this.duplicates,
			rejected: this.rejected,
			rejectedAuth: this.rejectedAuth,
			rejectedSignature: this.rejectedSignature,
			rejectedReplay: this.rejectedReplay,
			rejectedParse: this.rejectedParse,
			errors: this.errors,
			lastAcceptedAt: this.lastAcceptedAt,
			lastRejectedAt: this.lastRejectedAt,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt,
			ingestPath: this.ingestPath
		};
	}

	handle(request: ReducerIngressRequest): ReducerIngressResponse {
		if (!this.enabled) {
			return {
				status: 404,
				success: false,
				duplicate: false,
				reason: 'disabled',
				message: 'Reducer ingress is disabled'
			};
		}

		if (request.body.length > this.maxBodyBytes) {
			this.rejected += 1;
			this.rejectedParse += 1;
			this.lastRejectedAt = Date.now();
			return {
				status: 413,
				success: false,
				duplicate: false,
				reason: 'body_too_large',
				message: 'Payload exceeds reducer ingress body limit'
			};
		}

		if (this.bearerToken) {
			const auth = this.headerValue(request.headers, 'authorization');
			const expected = `Bearer ${this.bearerToken}`;
			if (!auth || !this.constantTimeEqual(auth, expected)) {
				this.rejected += 1;
				this.rejectedAuth += 1;
				this.lastRejectedAt = Date.now();
				return {
					status: 401,
					success: false,
					duplicate: false,
					reason: 'auth_failed',
					message: 'Bearer token required'
				};
			}
		}

		const signatureCheck = this.verifySignatureHeaders(request.headers, request.body);
		if (!signatureCheck.ok) {
			this.rejected += 1;
			this.rejectedSignature += 1;
			this.lastRejectedAt = Date.now();
			return {
				status: signatureCheck.status,
				success: false,
				duplicate: false,
				reason: signatureCheck.reason,
				message: signatureCheck.message
			};
		}

		let record: StatePlaneOutboxRecord;
		try {
			record = this.normalizeRecord(request.body);
		} catch (error) {
			this.rejected += 1;
			this.rejectedParse += 1;
			this.lastRejectedAt = Date.now();
			return {
				status: 400,
				success: false,
				duplicate: false,
				reason: 'parse_failed',
				message: error instanceof Error ? error.message : String(error)
			};
		}

		const eventKey = this.getEventKey(record, request.body);
		if (this.hasSeenEvent(eventKey)) {
			this.duplicates += 1;
			this.accepted += 1;
			this.lastAcceptedAt = Date.now();
			return {
				status: 202,
				success: true,
				duplicate: true,
				reason: null,
				message: 'Duplicate event skipped'
			};
		}

		try {
			appendFileSync(this.ingestPath, `${JSON.stringify(record)}\n`);
			this.markSeenEvent(eventKey);
			if (signatureCheck.nonce) {
				this.markSeenNonce(signatureCheck.nonce, signatureCheck.timestamp || Date.now());
			}
			this.accepted += 1;
			this.lastAcceptedAt = Date.now();
			return {
				status: 202,
				success: true,
				duplicate: false,
				reason: null,
				message: 'Accepted'
			};
		} catch (error) {
			this.errors += 1;
			this.lastErrorAt = Date.now();
			this.lastError = error instanceof Error ? error.message : String(error);
			return {
				status: 500,
				success: false,
				duplicate: false,
				reason: 'ingest_write_failed',
				message: 'Failed to persist reducer ingress event'
			};
		}
	}

	private ensurePaths(): void {
		const dir = dirname(this.ingestPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | null {
		const raw = headers[key] ?? headers[key.toLowerCase()];
		if (Array.isArray(raw)) {
			for (const entry of raw) {
				const trimmed = entry.trim();
				if (trimmed.length > 0) return trimmed;
			}
			return null;
		}
		if (typeof raw !== 'string') return null;
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	private constantTimeEqual(a: string, b: string): boolean {
		const left = Buffer.from(a);
		const right = Buffer.from(b);
		if (left.length !== right.length) return false;
		return timingSafeEqual(left, right);
	}

	private cleanupSeenNonces(now: number): void {
		const cutoff = now - this.maxSkewMs;
		while (this.seenNonceQueue.length > 0) {
			const nonce = this.seenNonceQueue[0];
			const ts = this.seenNonces.get(nonce);
			if (ts == null || ts < cutoff || this.seenNonces.size > MAX_SEEN_NONCES) {
				this.seenNonceQueue.shift();
				this.seenNonces.delete(nonce);
				continue;
			}
			break;
		}
	}

	private verifySignatureHeaders(
		headers: Record<string, string | string[] | undefined>,
		body: string
	): { ok: boolean; status: number; reason: string | null; message: string; nonce: string | null; timestamp: number | null } {
		if (!this.requireSignature) {
			return {
				ok: true,
				status: 200,
				reason: null,
				message: 'signature_not_required',
				nonce: null,
				timestamp: null
			};
		}

		if (!this.signingSecret) {
			return {
				ok: false,
				status: 503,
				reason: 'ingress_misconfigured',
				message: 'Reducer ingress signature is required but STATE_SHADOW_SIGNING_SECRET is not configured',
				nonce: null,
				timestamp: null
			};
		}

		const timestampRaw = this.headerValue(headers, 'x-wabi-state-timestamp');
		const nonce = this.headerValue(headers, 'x-wabi-state-nonce');
		const signatureRaw = this.headerValue(headers, 'x-wabi-state-signature');
		const keyId = this.headerValue(headers, 'x-wabi-state-key-id');

		if (!timestampRaw || !nonce || !signatureRaw) {
			return {
				ok: false,
				status: 401,
				reason: 'signature_missing',
				message: 'Signed envelope headers are required',
				nonce: null,
				timestamp: null
			};
		}

		if (this.signingKeyId && keyId && keyId !== this.signingKeyId) {
			return {
				ok: false,
				status: 401,
				reason: 'signature_key_id_mismatch',
				message: 'Signing key id mismatch',
				nonce: null,
				timestamp: null
			};
		}

		const timestamp = Number(timestampRaw);
		if (!Number.isFinite(timestamp)) {
			return {
				ok: false,
				status: 401,
				reason: 'signature_timestamp_invalid',
				message: 'Invalid signature timestamp',
				nonce: null,
				timestamp: null
			};
		}

		const now = Date.now();
		if (Math.abs(now - timestamp) > this.maxSkewMs) {
			return {
				ok: false,
				status: 401,
				reason: 'signature_timestamp_skew',
				message: `Signature timestamp outside allowed skew (${this.maxSkewMs}ms)`,
				nonce: null,
				timestamp
			};
		}

		this.cleanupSeenNonces(now);
		if (this.seenNonces.has(nonce)) {
			this.rejectedReplay += 1;
			return {
				ok: false,
				status: 409,
				reason: 'signature_replay',
				message: 'Replay detected for signature nonce',
				nonce: null,
				timestamp
			};
		}

		const provided = signatureRaw.startsWith('sha256=') ? signatureRaw.slice('sha256='.length) : signatureRaw;
		if (!/^[a-fA-F0-9]{64}$/.test(provided)) {
			return {
				ok: false,
				status: 401,
				reason: 'signature_invalid_format',
				message: 'Signature must be sha256 hex',
				nonce: null,
				timestamp
			};
		}

		const expected = createHmac('sha256', this.signingSecret)
			.update(`${timestampRaw}.${nonce}.${body}`)
			.digest('hex');

		if (!this.constantTimeEqual(provided.toLowerCase(), expected.toLowerCase())) {
			return {
				ok: false,
				status: 401,
				reason: 'signature_invalid',
				message: 'Signature verification failed',
				nonce: null,
				timestamp
			};
		}

		return {
			ok: true,
			status: 200,
			reason: null,
			message: 'signature_verified',
			nonce,
			timestamp
		};
	}

	private normalizeRecord(body: string): StatePlaneOutboxRecord {
		const raw = JSON.parse(body) as Record<string, unknown>;
		if (!raw || typeof raw !== 'object') {
			throw new Error('Payload must be a JSON object');
		}
		const entity = typeof raw.entity === 'string' ? raw.entity.trim() : '';
		if (!ALLOWED_ENTITIES.has(entity)) {
			throw new Error('Invalid entity');
		}
		const operation = typeof raw.operation === 'string' ? raw.operation.trim() : '';
		if (!operation) {
			throw new Error('Missing operation');
		}
		const payload = raw.payload;
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			throw new Error('Payload payload must be an object');
		}
		const timestamp = Number(raw.timestamp);
		const normalizedTimestamp = Number.isFinite(timestamp) ? Math.max(0, Math.floor(timestamp)) : Date.now();
		const eventId = typeof raw.eventId === 'string' && raw.eventId.trim().length > 0 ? raw.eventId.trim() : undefined;

		return {
			eventId,
			timestamp: normalizedTimestamp,
			entity: entity as StatePlaneOutboxRecord['entity'],
			operation: operation.slice(0, 200),
			payload: payload as Record<string, unknown>
		};
	}

	private getEventKey(record: StatePlaneOutboxRecord, rawBody: string): string {
		if (record.eventId) return `id:${record.eventId}`;
		return `sha1:${createHash('sha1').update(rawBody).digest('hex')}`;
	}

	private hasSeenEvent(key: string): boolean {
		return this.seenEventIds.has(key);
	}

	private markSeenEvent(key: string): void {
		this.seenEventIds.add(key);
		this.seenEventQueue.push(key);
		if (this.seenEventQueue.length <= MAX_SEEN_EVENTS) return;
		const removed = this.seenEventQueue.shift();
		if (removed) {
			this.seenEventIds.delete(removed);
		}
	}

	private markSeenNonce(nonce: string, timestamp: number): void {
		this.seenNonces.set(nonce, timestamp);
		this.seenNonceQueue.push(nonce);
		if (this.seenNonceQueue.length <= MAX_SEEN_NONCES) return;
		const removed = this.seenNonceQueue.shift();
		if (removed) {
			this.seenNonces.delete(removed);
		}
	}
}
