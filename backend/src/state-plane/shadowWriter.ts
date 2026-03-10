import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	truncateSync
} from 'fs';
import { createHash, createHmac, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { DATA_DIR } from '../constants.js';
import { type StatePlaneConfig } from './config.js';
import { type StatePlaneOutboxRecord } from './outbox.js';
import { getStdbAuthMode, getStdbDatabase, getStdbServer, getStdbTimeoutMs } from './stdbCommon.js';

interface ShadowSink {
	apply(record: StatePlaneOutboxRecord): Promise<void>;
}

class MirrorShadowSink implements ShadowSink {
	constructor(private readonly appliedPath: string) {}

	async apply(record: StatePlaneOutboxRecord): Promise<void> {
		appendFileSync(this.appliedPath, `${JSON.stringify(record)}\n`);
	}
}

class HttpShadowSink implements ShadowSink {
	constructor(
		private readonly endpoint: string,
		private readonly token: string | null,
		private readonly signingSecret: string | null,
		private readonly signingKeyId: string | null
	) {}

	async apply(record: StatePlaneOutboxRecord): Promise<void> {
		const body = JSON.stringify(record);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		}
		if (this.signingSecret) {
			const timestamp = Date.now().toString();
			const nonce = randomBytes(16).toString('hex');
			const signature = createHmac('sha256', this.signingSecret)
				.update(`${timestamp}.${nonce}.${body}`)
				.digest('hex');
			headers['X-Wabi-State-Timestamp'] = timestamp;
			headers['X-Wabi-State-Nonce'] = nonce;
			headers['X-Wabi-State-Signature'] = `sha256=${signature}`;
			headers['X-Wabi-State-Signature-Alg'] = 'hmac-sha256';
			if (this.signingKeyId) {
				headers['X-Wabi-State-Key-Id'] = this.signingKeyId;
			}
		}

		const response = await fetch(this.endpoint, {
			method: 'POST',
			headers,
			body
		});
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
		}
	}
}

class CommandShadowSink implements ShadowSink {
	constructor(
		private readonly command: string,
		private readonly timeoutMs: number
	) {}

	async apply(record: StatePlaneOutboxRecord): Promise<void> {
		const payload = `${JSON.stringify(record)}\n`;
		const result = spawnSync(this.command, {
			shell: true,
			input: payload,
			encoding: 'utf8',
			timeout: this.timeoutMs,
			maxBuffer: 8 * 1024 * 1024
		});

		if (result.error) {
			throw new Error(`command_error: ${result.error.message}`);
		}
		if (result.signal) {
			throw new Error(`command_terminated signal=${result.signal}`);
		}
		if (typeof result.status === 'number' && result.status !== 0) {
			const stderr = (result.stderr || '').trim();
			throw new Error(`command_exit_${result.status}${stderr ? `: ${stderr}` : ''}`);
		}
	}
}

class StdbShadowSink implements ShadowSink {
	private readonly server: string;
	private readonly database: string;
	private readonly reducer: string;
	private readonly timeoutMs: number;
	private readonly providedToken: string | null;
	private readonly allowAnonymous: boolean;
	private cachedIdentityToken: string | null = null;

	constructor() {
		const server = getStdbServer();
		const database = getStdbDatabase();
		if (!server || !database) {
			throw new Error('stdb_sink_not_configured');
		}
		this.server = normalizeStdbServer(server);
		this.database = database;
		this.reducer = (process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event').trim() || 'ingest_wabi_event';
		this.timeoutMs = getStdbTimeoutMs();
		const authMode = getStdbAuthMode();
		this.providedToken = authMode.token;
		this.allowAnonymous = authMode.anonymous;
	}

	async apply(record: StatePlaneOutboxRecord): Promise<void> {
		const body = JSON.stringify([JSON.stringify(record)]);
		let response = await this.callReducer(body, await this.resolveToken(false));
		if (response.status === 401 && !this.providedToken && this.allowAnonymous) {
			response = await this.callReducer(body, await this.resolveToken(true));
		}
		if (!response.ok) {
			throw new Error(`stdb_http_${response.status}: ${response.text || response.statusText}`);
		}
	}

	private async resolveToken(forceRefresh: boolean): Promise<string | null> {
		if (this.providedToken) return this.providedToken;
		if (!this.allowAnonymous) return null;
		if (!forceRefresh && this.cachedIdentityToken) return this.cachedIdentityToken;

		const response = await postJson(
			`${this.server}/v1/identity`,
			{ 'Content-Type': 'application/json' },
			'{}',
			this.timeoutMs
		);
		if (!response.ok) {
			throw new Error(`stdb_identity_${response.status}: ${response.text || response.statusText}`);
		}
		const token = response.json?.token;
		if (typeof token !== 'string' || token.trim().length === 0) {
			throw new Error('stdb_identity_missing_token');
		}
		this.cachedIdentityToken = token.trim();
		return this.cachedIdentityToken;
	}

	private async callReducer(body: string, token: string | null): Promise<HttpResponse> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		return postJson(
			`${this.server}/v1/database/${encodeURIComponent(this.database)}/call/${encodeURIComponent(this.reducer)}`,
			headers,
			body,
			this.timeoutMs
		);
	}
}

interface HttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	text: string;
	json: any;
}

function normalizeStdbServer(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	if (trimmed.includes('://')) return trimmed.replace(/\/+$/, '');
	return `http://${trimmed.replace(/\/+$/, '')}`;
}

async function postJson(
	url: string,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number
): Promise<HttpResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body,
			signal: controller.signal
		});
		const text = await response.text().catch(() => '');
		let json: any = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			text,
			json
		};
	} finally {
		clearTimeout(timeout);
	}
}

export interface StatePlaneShadowWriterStats {
	enabled: boolean;
	running: boolean;
	sink: 'mirror' | 'http' | 'command' | 'stdb';
	signingEnabled: boolean;
	signingKeyId: string | null;
	commandConfigured: boolean;
	commandTimeoutMs: number;
	outboxPath: string;
	outboxMaxBytes: number;
	outboxTruncateMinBytes: number;
	offsetPath: string;
	deadLetterPath: string;
	applied: number;
	failed: number;
	parseErrors: number;
	loopErrors: number;
	offset: number;
	fileSizeBytes: number;
	backlogBytes: number;
	backlogOverLimit: boolean;
	duplicatesSkipped: number;
	truncations: number;
	truncateBytes: number;
	truncateFailures: number;
	lastAppliedAt: number | null;
	lastTruncatedAt: number | null;
	lastError: string | null;
	lastErrorAt: number | null;
}

export class StatePlaneShadowWriter {
	private readonly enabled: boolean;
	private readonly pollIntervalMs: number;
	private readonly batchSize: number;
	private readonly outboxPath: string;
	private readonly outboxMaxBytes: number;
	private readonly outboxTruncateMinBytes: number;
	private readonly offsetPath: string;
	private readonly deadLetterPath: string;
	private readonly sinkKind: 'mirror' | 'http' | 'command' | 'stdb';
	private readonly signingEnabled: boolean;
	private readonly signingKeyId: string | null;
	private readonly commandConfigured: boolean;
	private readonly commandTimeoutMs: number;
	private readonly sink: ShadowSink;
	private readonly mirrorPath: string;
	private running = false;
	private inFlight = false;
	private timer: NodeJS.Timeout | null = null;
	private offset = 0;
	private applied = 0;
	private failed = 0;
	private parseErrors = 0;
	private loopErrors = 0;
	private fileSizeBytes = 0;
	private backlogBytes = 0;
	private backlogOverLimit = false;
	private duplicatesSkipped = 0;
	private truncations = 0;
	private truncateBytes = 0;
	private truncateFailures = 0;
	private backlogWarned = false;
	private readonly seenEventLimit = 50_000;
	private seenEventIds = new Set<string>();
	private seenEventQueue: string[] = [];
	private lastAppliedAt: number | null = null;
	private lastTruncatedAt: number | null = null;
	private lastError: string | null = null;
	private lastErrorAt: number | null = null;

	constructor(config: StatePlaneConfig) {
		this.enabled = config.shadowWriterEnabled;
		this.pollIntervalMs = config.shadowPollIntervalMs;
		this.batchSize = config.shadowBatchSize;
		this.outboxPath = config.outboxPath || join(DATA_DIR, 'state-plane-outbox.ndjson');
		this.outboxMaxBytes = config.outboxMaxBytes;
		this.outboxTruncateMinBytes = config.outboxTruncateMinBytes;
		this.offsetPath = join(DATA_DIR, 'state-plane-shadow.offset');
		this.deadLetterPath = join(DATA_DIR, 'state-plane-shadow-deadletter.ndjson');
		this.mirrorPath = join(DATA_DIR, 'state-plane-shadow-applied.ndjson');
		let resolvedSink: 'mirror' | 'http' | 'command' | 'stdb' = config.shadowSink;

		if (resolvedSink === 'http' && config.shadowEndpoint) {
			this.sink = new HttpShadowSink(
				config.shadowEndpoint,
				config.shadowToken,
				config.shadowSigningSecret,
				config.shadowSigningKeyId
			);
			this.signingEnabled = config.shadowSigningSecret != null;
			this.signingKeyId = config.shadowSigningKeyId;
			this.commandConfigured = false;
			this.commandTimeoutMs = 0;
			if (!this.signingEnabled) {
				console.warn(
					'[StatePlane] shadow sink=http running without STATE_SHADOW_SIGNING_SECRET; outbound events are unsigned'
				);
			}
		} else if (resolvedSink === 'command' && config.shadowCommand) {
			this.sink = new CommandShadowSink(config.shadowCommand, config.shadowCommandTimeoutMs);
			this.signingEnabled = false;
			this.signingKeyId = null;
			this.commandConfigured = true;
			this.commandTimeoutMs = config.shadowCommandTimeoutMs;
		} else if (resolvedSink === 'stdb') {
			try {
				this.sink = new StdbShadowSink();
				this.signingEnabled = false;
				this.signingKeyId = null;
				this.commandConfigured = false;
				this.commandTimeoutMs = 0;
			} catch (error) {
				this.sink = new MirrorShadowSink(this.mirrorPath);
				console.warn(
					`[StatePlane] shadow sink=stdb requested but STDB client is not configured; using mirror sink (${error instanceof Error ? error.message : String(error)})`
				);
				resolvedSink = 'mirror';
				this.signingEnabled = false;
				this.signingKeyId = null;
				this.commandConfigured = false;
				this.commandTimeoutMs = 0;
			}
		} else {
			this.sink = new MirrorShadowSink(this.mirrorPath);
			if (resolvedSink === 'http') {
				console.warn('[StatePlane] shadow sink=http requested without STATE_SHADOW_ENDPOINT; using mirror sink');
			} else if (resolvedSink === 'command') {
				console.warn('[StatePlane] shadow sink=command requested without STATE_SHADOW_COMMAND; using mirror sink');
			} else if (resolvedSink === 'stdb') {
				console.warn('[StatePlane] shadow sink=stdb requested without STDB client config; using mirror sink');
			}
			resolvedSink = 'mirror';
			this.signingEnabled = false;
			this.signingKeyId = null;
			this.commandConfigured = false;
			this.commandTimeoutMs = 0;
		}
		this.sinkKind = resolvedSink;

		this.ensurePaths();
		this.offset = this.loadOffset();
	}

	start(): void {
		if (!this.enabled || this.running) return;
		this.running = true;
		void this.tick();
		this.timer = setInterval(() => {
			void this.tick();
		}, this.pollIntervalMs);
		this.timer.unref?.();
		console.log(
			`[StatePlane] Shadow writer started (sink=${this.sinkKind}, signing=${this.signingEnabled}, commandConfigured=${this.commandConfigured}, commandTimeoutMs=${this.commandTimeoutMs}, poll=${this.pollIntervalMs}ms, outboxMaxBytes=${this.outboxMaxBytes}, truncateMinBytes=${this.outboxTruncateMinBytes})`
		);
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.persistOffset();
	}

	getStats(): StatePlaneShadowWriterStats {
		return {
			enabled: this.enabled,
			running: this.running,
			sink: this.sinkKind,
			signingEnabled: this.signingEnabled,
			signingKeyId: this.signingKeyId,
			commandConfigured: this.commandConfigured,
			commandTimeoutMs: this.commandTimeoutMs,
			outboxPath: this.outboxPath,
			outboxMaxBytes: this.outboxMaxBytes,
			outboxTruncateMinBytes: this.outboxTruncateMinBytes,
			offsetPath: this.offsetPath,
			deadLetterPath: this.deadLetterPath,
			applied: this.applied,
			failed: this.failed,
			parseErrors: this.parseErrors,
			loopErrors: this.loopErrors,
			offset: this.offset,
			fileSizeBytes: this.fileSizeBytes,
			backlogBytes: this.backlogBytes,
			backlogOverLimit: this.backlogOverLimit,
			duplicatesSkipped: this.duplicatesSkipped,
			truncations: this.truncations,
			truncateBytes: this.truncateBytes,
			truncateFailures: this.truncateFailures,
			lastAppliedAt: this.lastAppliedAt,
			lastTruncatedAt: this.lastTruncatedAt,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt
		};
	}

	private ensurePaths(): void {
		const candidates = [this.outboxPath, this.offsetPath, this.deadLetterPath, this.mirrorPath];
		for (const target of candidates) {
			const dir = dirname(target);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
	}

	private loadOffset(): number {
		if (!existsSync(this.offsetPath)) return 0;
		try {
			const raw = readFileSync(this.offsetPath, 'utf8').trim();
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed < 0) return 0;
			return Math.floor(parsed);
		} catch {
			return 0;
		}
	}

	private persistOffset(): void {
		try {
			writeFileSync(this.offsetPath, `${this.offset}\n`);
		} catch (error) {
			this.recordLoopError(error);
		}
	}

	private recordLoopError(error: unknown): void {
		this.loopErrors += 1;
		this.lastErrorAt = Date.now();
		this.lastError = error instanceof Error ? error.message : String(error);
	}

	private updateBacklogStats(fileSizeBytes: number): void {
		this.fileSizeBytes = Math.max(0, Math.floor(fileSizeBytes));
		this.backlogBytes = Math.max(0, this.fileSizeBytes - this.offset);
		this.backlogOverLimit = this.backlogBytes > this.outboxMaxBytes;
		if (this.backlogOverLimit && !this.backlogWarned) {
			this.backlogWarned = true;
			console.warn(
				`[StatePlane] Shadow writer backlog exceeded limit backlogBytes=${this.backlogBytes} maxBytes=${this.outboxMaxBytes}`
			);
			return;
		}
		if (!this.backlogOverLimit) {
			this.backlogWarned = false;
		}
	}

	private maybeTruncateCaughtUp(fileSizeBytes: number): void {
		if (this.offset !== fileSizeBytes) return;
		if (fileSizeBytes < this.outboxTruncateMinBytes) return;
		try {
			truncateSync(this.outboxPath, 0);
			this.truncations += 1;
			this.truncateBytes += fileSizeBytes;
			this.lastTruncatedAt = Date.now();
			this.offset = 0;
			this.persistOffset();
			this.updateBacklogStats(0);
		} catch (error) {
			this.truncateFailures += 1;
			this.recordLoopError(error);
		}
	}

	private getEventKey(record: StatePlaneOutboxRecord, rawLine: string): string {
		if (typeof record.eventId === 'string' && record.eventId.trim().length > 0) {
			return `id:${record.eventId.trim()}`;
		}
		const digest = createHash('sha1').update(rawLine).digest('hex');
		return `sha1:${digest}`;
	}

	private hasSeenEvent(key: string): boolean {
		return this.seenEventIds.has(key);
	}

	private markSeenEvent(key: string): void {
		this.seenEventIds.add(key);
		this.seenEventQueue.push(key);
		if (this.seenEventQueue.length <= this.seenEventLimit) return;
		const removed = this.seenEventQueue.shift();
		if (removed) {
			this.seenEventIds.delete(removed);
		}
	}

	private async tick(): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			if (!existsSync(this.outboxPath)) {
				this.updateBacklogStats(0);
				return;
			}

			const buffer = readFileSync(this.outboxPath);
			if (this.offset > buffer.length) {
				// Outbox rotated/truncated.
				this.offset = 0;
				this.persistOffset();
			}
			this.updateBacklogStats(buffer.length);
			if (this.offset === buffer.length) {
				this.maybeTruncateCaughtUp(buffer.length);
				return;
			}

			const maxLines = Math.max(1, this.batchSize);
			let nextOffset = this.offset;
			let consumedLines = 0;

			while (consumedLines < maxLines && nextOffset < buffer.length) {
				const newlineIndex = buffer.indexOf(0x0a, nextOffset);
				if (newlineIndex < 0) break;

				const line = buffer.subarray(nextOffset, newlineIndex).toString('utf8');
				nextOffset = newlineIndex + 1;
				consumedLines += 1;

				if (!line.trim()) continue;
				await this.applyLine(line);
			}

			if (nextOffset !== this.offset) {
				this.offset = nextOffset;
				this.persistOffset();
			}
			this.updateBacklogStats(buffer.length);
			this.maybeTruncateCaughtUp(buffer.length);
		} catch (error) {
			this.recordLoopError(error);
		} finally {
			this.inFlight = false;
		}
	}

	private async applyLine(line: string): Promise<void> {
		let record: StatePlaneOutboxRecord;
		try {
			record = JSON.parse(line) as StatePlaneOutboxRecord;
		} catch (error) {
			this.parseErrors += 1;
			this.failed += 1;
			this.lastErrorAt = Date.now();
			this.lastError = `parse_error: ${error instanceof Error ? error.message : String(error)}`;
			appendFileSync(
				this.deadLetterPath,
				`${JSON.stringify({ timestamp: Date.now(), reason: 'parse_error', line })}\n`
			);
			return;
		}

		try {
			const eventKey = this.getEventKey(record, line);
			if (this.hasSeenEvent(eventKey)) {
				this.duplicatesSkipped += 1;
				return;
			}
			await this.sink.apply(record);
			this.markSeenEvent(eventKey);
			this.applied += 1;
			this.lastAppliedAt = Date.now();
		} catch (error) {
			this.failed += 1;
			this.lastErrorAt = Date.now();
			this.lastError = `apply_error: ${error instanceof Error ? error.message : String(error)}`;
			appendFileSync(
				this.deadLetterPath,
				`${JSON.stringify({ timestamp: Date.now(), reason: 'apply_error', error: this.lastError, record })}\n`
			);
		}
	}
}
