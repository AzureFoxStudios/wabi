import { mkdirSync, existsSync, createWriteStream, type WriteStream } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import { DATA_DIR } from '../constants.js';

export interface StatePlaneOutboxRecord {
	eventId?: string;
	timestamp: number;
	entity: 'message' | 'channel' | 'channel_member' | 'user' | 'session' | 'rbac' | 'presence' | 'system';
	operation: string;
	payload: Record<string, unknown>;
}

export interface StatePlaneOutboxStats {
	enabled: boolean;
	path: string | null;
	redactSensitive: boolean;
	redactedFields: number;
	written: number;
	errors: number;
	lastError: string | null;
	lastErrorAt: number | null;
}

export class StatePlaneOutbox {
	private static readonly sensitiveKeyPattern =
		/(token|secret|password|passwd|authorization|auth|jwt|cookie|session|api[_-]?key|bearer)/i;
	private readonly enabled: boolean;
	private readonly path: string | null;
	private readonly redactSensitive: boolean;
	private stream: WriteStream | null = null;
	private written = 0;
	private redactedFields = 0;
	private eventCounter = 0;
	private errors = 0;
	private lastError: string | null = null;
	private lastErrorAt: number | null = null;
	private warned = false;

	constructor(options?: { enabled?: boolean; path?: string; redactSensitive?: boolean }) {
		this.enabled = options?.enabled !== false;
		this.redactSensitive = options?.redactSensitive !== false;
		this.path = this.enabled
			? (options?.path && options.path.trim().length > 0
				? options.path.trim()
				: join(DATA_DIR, 'state-plane-outbox.ndjson'))
			: null;

		if (!this.enabled || !this.path) return;

		try {
			const dir = dirname(this.path);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			this.stream = createWriteStream(this.path, { flags: 'a' });
			this.stream.on('error', (error) => {
				this.recordError(error);
			});
		} catch (error) {
			this.recordError(error);
			this.stream = null;
		}
	}

	append(record: StatePlaneOutboxRecord): void {
		if (!this.enabled || !this.stream) return;
		try {
			const recordWithId = this.ensureEventId(record);
			const safeRecord = this.redactSensitive ? this.sanitizeRecord(recordWithId) : recordWithId;
			const line = `${JSON.stringify(safeRecord)}\n`;
			this.stream.write(line);
			this.written += 1;
		} catch (error) {
			this.recordError(error);
		}
	}

	getStats(): StatePlaneOutboxStats {
		return {
			enabled: this.enabled,
			path: this.path,
			redactSensitive: this.redactSensitive,
			redactedFields: this.redactedFields,
			written: this.written,
			errors: this.errors,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt
		};
	}

	private shouldRedactKey(key: string): boolean {
		return StatePlaneOutbox.sensitiveKeyPattern.test(key);
	}

	private sanitizeValue(value: unknown, key: string, depth: number): unknown {
		if (this.shouldRedactKey(key)) {
			this.redactedFields += 1;
			return '[redacted]';
		}
		if (value == null) return value;
		if (depth > 6) return '[truncated]';
		if (typeof value === 'string') {
			if (value.startsWith('Bearer ')) {
				this.redactedFields += 1;
				return '[redacted]';
			}
			return value;
		}
		if (Array.isArray(value)) {
			const items = value.slice(0, 250);
			return items.map((item) => this.sanitizeValue(item, '', depth + 1));
		}
		if (typeof value === 'object') {
			const input = value as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			const entries = Object.entries(input).slice(0, 250);
			for (const [childKey, childValue] of entries) {
				out[childKey] = this.sanitizeValue(childValue, childKey, depth + 1);
			}
			return out;
		}
		return value;
	}

	private sanitizeRecord(record: StatePlaneOutboxRecord): StatePlaneOutboxRecord {
		return {
			...record,
			payload: this.sanitizeValue(record.payload, 'payload', 0) as Record<string, unknown>
		};
	}

	private ensureEventId(record: StatePlaneOutboxRecord): StatePlaneOutboxRecord {
		if (typeof record.eventId === 'string' && record.eventId.trim().length > 0) return record;
		this.eventCounter += 1;
		const now = Date.now().toString(36);
		const nonce = randomBytes(6).toString('hex');
		return {
			...record,
			eventId: `evt_${now}_${this.eventCounter.toString(36)}_${nonce}`
		};
	}

	private recordError(error: unknown): void {
		this.errors += 1;
		this.lastErrorAt = Date.now();
		this.lastError = error instanceof Error ? error.message : String(error);
		if (!this.warned) {
			this.warned = true;
			console.warn('[StatePlane] Outbox write failed; dual-write continues without durable outbox', error);
		}
	}
}
