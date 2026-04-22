import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

export interface StdbDecodedRow {
	[key: string]: unknown;
}

export interface StdbSqlResponse {
	schema?: {
		elements?: Array<{
			name?: { some?: string } | null;
			algebraic_type?: unknown;
		}>;
	};
	rows?: unknown[][];
	total_duration_micros?: number;
	stats?: {
		rows_inserted?: number;
		rows_deleted?: number;
		rows_updated?: number;
	};
}

export interface StdbClientRuntimeStats {
	enabled: boolean;
	server: string | null;
	database: string | null;
	helperPath: string | null;
	authMode: 'token' | 'anonymous' | 'none';
	calls: number;
	sqlReads: number;
	errors: number;
	lastError: string | null;
	lastErrorAt: number | null;
	lastLatencyMs: number | null;
}

export interface StdbConnectivityProbe {
	ok: boolean;
	reason: string | null;
	latencyMs: number | null;
}

export interface StdbSyncClientOptions {
	server: string | null;
	database: string | null;
	timeoutMs: number;
	authToken: string | null;
	anonymous: boolean;
}

function normalizeServer(raw: string | null): string | null {
	if (!raw) return null;
	const value = raw.trim();
	if (!value) return null;
	const lowered = value.toLowerCase();
	if (lowered === 'local') return 'http://127.0.0.1:3000';
	if (lowered === 'maincloud') return 'https://maincloud.spacetimedb.com';
	if (value.includes('://')) return value.replace(/\/+$/, '');
	return `http://${value.replace(/\/+$/, '')}`;
}

function stableStringify(value: unknown): string {
	if (value == null) return 'null';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`).join(',')}}`;
}

function decodeJwtExpiryMs(token: string): number | null {
	try {
		const parts = String(token || '').split('.');
		if (parts.length < 2) return null;
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		if (typeof payload?.exp !== 'number') return null;
		return Math.floor(payload.exp * 1000);
	} catch {
		return null;
	}
}

function decodeSqlRows(response: StdbSqlResponse): StdbDecodedRow[] {
	const elements = response.schema?.elements || [];
	const names = elements.map((entry, index) => entry?.name?.some || `col_${index}`);
	const rows = Array.isArray(response.rows) ? response.rows : [];
	return rows.map((row) => {
		const out: StdbDecodedRow = {};
		for (let i = 0; i < names.length; i += 1) {
			const algebraicType = elements[i]?.algebraic_type;
			out[names[i]] = normalizeCell(row?.[i], algebraicType);
		}
		return out;
	});
}

function normalizeCell(value: unknown, algebraicType: unknown): unknown {
	if (
		Array.isArray(value) &&
		value.length === 1 &&
		algebraicType &&
		typeof algebraicType === 'object' &&
		'Product' in (algebraicType as Record<string, unknown>)
	) {
		const product = (algebraicType as { Product?: { elements?: Array<{ name?: { some?: string } }> } }).Product;
		const firstName = product?.elements?.[0]?.name?.some || '';
		if (firstName.startsWith('__timestamp_')) {
			return value[0];
		}
	}
	return value;
}

export function escapeSqlLiteral(value: string): string {
	// Strip null bytes and control characters (U+0000-U+001F except tab/newline/CR)
	const sanitized = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
	// Escape single quotes (SQL standard) and backslashes (for backends that interpret them)
	return `'${sanitized.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function toStdbEventId(entity: string, operation: string, payload: unknown): string {
	const basis = `${entity}:${operation}:${stableStringify(payload)}`;
	const digest = createHash('sha256').update(basis).digest('hex');
	return `stdb_${entity}_${operation}_${digest.slice(0, 32)}`;
}

function resolveHelperPath(): string | null {
	const candidates = [
		resolve(process.cwd(), 'scripts/state-plane-stdb-http.mjs'),
		resolve(process.cwd(), 'backend/scripts/state-plane-stdb-http.mjs')
	];
	for (const path of candidates) {
		if (existsSync(path)) return path;
	}
	return null;
}

interface HelperResponse {
	ok: boolean;
	status: number;
	statusText: string;
	durationMs?: number;
	json?: unknown;
	text?: string;
}

export class StdbSyncClient {
	private readonly server: string | null;
	private readonly database: string | null;
	private readonly timeoutMs: number;
	private readonly authToken: string | null;
	private readonly anonymous: boolean;
	private readonly helperPath: string | null;
	private calls = 0;
	private sqlReads = 0;
	private errors = 0;
	private lastError: string | null = null;
	private lastErrorAt: number | null = null;
	private lastLatencyMs: number | null = null;
	private readonly failureCooldownMs = 5000;
	private unavailableUntilMs: number | null = null;
	private asyncAnonymousToken: string | null = null;
	private asyncAnonymousTokenExpiresAt: number | null = null;
	private tokenRefreshInFlight: Promise<string | null> | null = null;

	constructor(options: StdbSyncClientOptions) {
		this.server = normalizeServer(options.server);
		this.database = options.database?.trim() || null;
		this.timeoutMs = Math.max(100, Math.min(30000, Math.floor(options.timeoutMs || 10000)));
		this.authToken = options.authToken?.trim() || null;
		this.anonymous = options.anonymous !== false;
		this.helperPath = resolveHelperPath();
	}

	isEnabled(): boolean {
		return Boolean(this.server && this.database && this.helperPath);
	}

	getRuntimeStats(): StdbClientRuntimeStats {
		const authMode = this.authToken ? 'token' : (this.anonymous ? 'anonymous' : 'none');
		return {
			enabled: this.isEnabled(),
			server: this.server,
			database: this.database,
			helperPath: this.helperPath,
			authMode,
			calls: this.calls,
			sqlReads: this.sqlReads,
			errors: this.errors,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt,
			lastLatencyMs: this.lastLatencyMs
		};
	}

	getTimeoutMs(): number {
		return this.timeoutMs;
	}

	probeConnectivity(timeoutMs = Math.min(this.timeoutMs, 1500)): StdbConnectivityProbe {
		if (!this.server || !this.database) {
			return { ok: false, reason: 'missing server or database', latencyMs: null };
		}
		if (!this.helperPath) {
			return {
				ok: false,
				reason: 'missing helper script backend/scripts/state-plane-stdb-http.mjs',
				latencyMs: null
			};
		}

		const args = [
			this.helperPath,
			'sql',
			'--query',
			'SELECT config_key FROM ingest_auth_config LIMIT 1',
			'--server',
			this.server,
			'--database',
			this.database,
			'--timeout-ms',
			String(Math.max(100, timeoutMs))
		];
		if (this.authToken) {
			args.push('--token', this.authToken);
		} else if (this.anonymous) {
			args.push('--anonymous');
		} else {
			args.push('--no-anonymous');
		}

		const startedAt = Date.now();
		const result = spawnSync(process.execPath, args, {
			encoding: 'utf8',
			timeout: Math.max(250, timeoutMs + 250),
			maxBuffer: 2 * 1024 * 1024
		});
		const latencyMs = Date.now() - startedAt;

		if (result.error) {
			return { ok: false, reason: `helper_error:${result.error.message}`, latencyMs };
		}
		if (result.signal) {
			return { ok: false, reason: `helper_signal:${result.signal}`, latencyMs };
		}

		const stdout = (result.stdout || '').trim();
		const stderr = (result.stderr || '').trim();
		if (typeof result.status === 'number' && result.status !== 0) {
			return {
				ok: false,
				reason: `helper_exit_${result.status}${stderr ? `:${stderr.slice(0, 256)}` : ''}`,
				latencyMs
			};
		}
		if (!stdout) {
			return { ok: false, reason: 'helper_empty_output', latencyMs };
		}

		try {
			const maybeLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith('{')) || stdout;
			const parsed = JSON.parse(maybeLine) as HelperResponse;
			if (parsed?.ok === true) {
				return { ok: true, reason: null, latencyMs };
			}
			return {
				ok: false,
				reason: `http_failure:${parsed?.status ?? 'unknown'}:${(parsed?.text || parsed?.statusText || 'unknown').slice(0, 256)}`,
				latencyMs
			};
		} catch (error) {
			return {
				ok: false,
				reason: `bad_json:${error instanceof Error ? error.message : String(error)}`,
				latencyMs
			};
		}
	}

	callReducer(reducer: string, args: unknown[]): void {
		this.calls += 1;
		this.runHelper([
			'call',
			'--reducer',
			reducer,
			'--args-json',
			JSON.stringify(args)
		]);
	}

	async callReducerAsync(reducer: string, args: unknown[]): Promise<void> {
		this.calls += 1;
		await this.runHttpRequest(
			`${this.server}/v1/database/${encodeURIComponent(this.database || '')}/call/${encodeURIComponent(reducer)}`,
			'application/json',
			JSON.stringify(args)
		);
	}

	sql(query: string): StdbSqlResponse {
		const response = this.runHelper([
			'sql',
			'--query',
			query
		]);
		this.sqlReads += 1;
		const payload = response.json;
		if (Array.isArray(payload)) {
			return (payload[0] as StdbSqlResponse) || {};
		}
		return (payload as StdbSqlResponse) || {};
	}

	sqlRows(query: string): StdbDecodedRow[] {
		const response = this.sql(query);
		return decodeSqlRows(response);
	}

	async sqlAsync(query: string): Promise<StdbSqlResponse> {
		this.sqlReads += 1;
		const response = await this.runHttpRequest(
			`${this.server}/v1/database/${encodeURIComponent(this.database || '')}/sql`,
			'text/plain',
			query
		);
		const payload = response.json;
		if (Array.isArray(payload)) {
			return (payload[0] as StdbSqlResponse) || {};
		}
		return (payload as StdbSqlResponse) || {};
	}

	async sqlRowsAsync(query: string): Promise<StdbDecodedRow[]> {
		const response = await this.sqlAsync(query);
		return decodeSqlRows(response);
	}

	async probeConnectivityAsync(timeoutMs = Math.min(this.timeoutMs, 1500)): Promise<StdbConnectivityProbe> {
		if (!this.server || !this.database) {
			return { ok: false, reason: 'missing server or database', latencyMs: null };
		}
		const startedAt = Date.now();
		try {
			const token = await this.resolveAsyncAuthToken(false);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
			try {
				const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
				if (token) headers.Authorization = `Bearer ${token}`;
				const response = await fetch(
					`${this.server}/v1/database/${encodeURIComponent(this.database)}/sql`,
					{
						method: 'POST',
						headers,
						body: 'SELECT config_key FROM ingest_auth_config LIMIT 1',
						signal: controller.signal
					}
				);
				const latencyMs = Date.now() - startedAt;
				if (!response.ok) {
					const text = await response.text().catch(() => '');
					return {
						ok: false,
						reason: `http_failure:${response.status}:${(text || response.statusText || 'unknown').slice(0, 256)}`,
						latencyMs
					};
				}
				return { ok: true, reason: null, latencyMs };
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			return {
				ok: false,
				reason: `probe_error:${error instanceof Error ? error.message : String(error)}`,
				latencyMs: Date.now() - startedAt
			};
		}
	}

	private runHelper(modeArgs: string[]): HelperResponse {
		this.throwIfTemporarilyUnavailable();
		if (!this.server || !this.database) {
			throw new Error('stdb_not_configured: missing server or database');
		}
		if (!this.helperPath) {
			throw new Error('stdb_not_configured: missing helper script backend/scripts/state-plane-stdb-http.mjs');
		}

		const args = [
			this.helperPath,
			...modeArgs,
			'--server',
			this.server,
			'--database',
			this.database,
			'--timeout-ms',
			String(this.timeoutMs)
		];
		if (this.authToken) {
			args.push('--token', this.authToken);
		} else if (this.anonymous) {
			args.push('--anonymous');
		} else {
			args.push('--no-anonymous');
		}

		const startedAt = Date.now();
		const result = spawnSync(process.execPath, args, {
			encoding: 'utf8',
			timeout: this.timeoutMs + 2000,
			maxBuffer: 16 * 1024 * 1024
		});
		this.lastLatencyMs = Date.now() - startedAt;

		if (result.error) {
			return this.fail(`stdb_helper_error: ${result.error.message}`);
		}
		if (result.signal) {
			return this.fail(`stdb_helper_signal: ${result.signal}`);
		}

		const stdout = (result.stdout || '').trim();
		const stderr = (result.stderr || '').trim();
		if (typeof result.status === 'number' && result.status !== 0) {
			const detail = stderr || stdout;
			return this.fail(
				`stdb_helper_exit_${result.status}${detail ? `: ${detail.slice(0, 512)}` : ''}`
			);
		}
		if (!stdout) {
			return this.fail('stdb_helper_empty_output');
		}

		let parsed: HelperResponse | null = null;
		try {
			const maybeLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith('{')) || stdout;
			parsed = JSON.parse(maybeLine) as HelperResponse;
		} catch (error) {
			return this.fail(`stdb_helper_bad_json: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (!parsed || parsed.ok !== true) {
			const errText = (parsed?.text || parsed?.statusText || 'unknown').slice(0, 256);
			return this.fail(
				`stdb_http_failure status=${parsed?.status ?? 'unknown'} text=${errText}`
			);
		}
		return parsed;
	}

	private async resolveAsyncAuthToken(forceRefresh = false): Promise<string | null> {
		if (this.authToken) {
			return this.authToken;
		}
		if (!this.anonymous || !this.server) {
			return null;
		}

		const now = Date.now();
		if (
			!forceRefresh &&
			this.asyncAnonymousToken &&
			this.asyncAnonymousTokenExpiresAt &&
			this.asyncAnonymousTokenExpiresAt - 60_000 > now
		) {
			return this.asyncAnonymousToken;
		}

		// Single-flight: if a refresh is already in progress, share it
		if (this.tokenRefreshInFlight) {
			return this.tokenRefreshInFlight;
		}

		this.tokenRefreshInFlight = this.fetchIdentityToken();
		try {
			return await this.tokenRefreshInFlight;
		} finally {
			this.tokenRefreshInFlight = null;
		}
	}

	private async fetchIdentityToken(): Promise<string> {
		const response = await fetch(`${this.server}/v1/identity`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: '{}'
		});
		const text = await response.text().catch(() => '');
		let json: Record<string, unknown> | null = null;
		try {
			json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
		} catch {
			json = null;
		}
		if (!response.ok) {
			this.fail(`stdb_identity_failure status=${response.status} text=${text || response.statusText}`);
		}

		const token = typeof json?.token === 'string' ? json.token.trim() : '';
		if (!token) {
			this.fail('stdb_identity_missing_token');
		}

		this.asyncAnonymousToken = token;
		this.asyncAnonymousTokenExpiresAt = decodeJwtExpiryMs(token) || (Date.now() + 10 * 60 * 1000);
		return token;
	}

	private async runHttpRequest(url: string, contentType: string, body: string): Promise<HelperResponse> {
		this.throwIfTemporarilyUnavailable();
		const startedAt = Date.now();
		const execute = async (forceRefreshToken = false): Promise<HelperResponse> => {
			const token = await this.resolveAsyncAuthToken(forceRefreshToken);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				const headers: Record<string, string> = {
					'Content-Type': contentType
				};
				if (token) {
					headers.Authorization = `Bearer ${token}`;
				}

				let response: Response;
				try {
					response = await fetch(url, {
						method: 'POST',
						headers,
						body,
						signal: controller.signal
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.fail(`stdb_http_transport_error: ${message}`);
				}
				const text = await response.text().catch(() => '');
				let json: unknown = null;
				try {
					json = text ? JSON.parse(text) : null;
				} catch {
					json = null;
				}
				return {
					ok: response.ok,
					status: response.status,
					statusText: response.statusText,
					durationMs: Date.now() - startedAt,
					json,
					text
				};
			} finally {
				clearTimeout(timeout);
			}
		};

		let response = await execute(false);
		if (!response.ok && response.status === 401 && !this.authToken && this.anonymous) {
			response = await execute(true);
		}
		this.lastLatencyMs = Date.now() - startedAt;
		if (!response.ok) {
			const errText = (response.text || response.statusText || 'unknown').slice(0, 256);
			this.fail(
				`stdb_http_failure status=${response.status} text=${errText}`
			);
		}
		return response;
	}

	private fail(message: string): never {
		this.errors += 1;
		this.lastError = message;
		this.lastErrorAt = Date.now();
		if (this.isTransportFailure(message)) {
			this.unavailableUntilMs = Date.now() + this.failureCooldownMs;
		}
		throw new Error(message);
	}

	private throwIfTemporarilyUnavailable(): void {
		if (!this.unavailableUntilMs) return;
		const remainingMs = this.unavailableUntilMs - Date.now();
		if (remainingMs <= 0) {
			this.unavailableUntilMs = null;
			return;
		}
		this.fail(`stdb_temporarily_unavailable: retry_in_ms=${remainingMs}`);
	}

	private isTransportFailure(message: string): boolean {
		const normalized = message.toLowerCase();
		return (
			normalized.includes('fetch failed') ||
			normalized.includes('timed out') ||
			normalized.includes('econnrefused') ||
			normalized.includes('enotfound') ||
			normalized.includes('socket hang up') ||
			normalized.startsWith('stdb_helper_error:') ||
			normalized.startsWith('stdb_helper_signal:') ||
			normalized.startsWith('stdb_http_transport_error:') ||
			normalized.startsWith('stdb_temporarily_unavailable:')
		);
	}
}
