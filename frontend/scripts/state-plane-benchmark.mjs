#!/usr/bin/env node

import { io } from 'socket.io-client';
import { performance } from 'perf_hooks';

function usage() {
	console.log(`Usage: node frontend/scripts/state-plane-benchmark.mjs [options]

Measures Wabi state-plane speed and moderate-load behavior through the live app.

Options:
  --origin <url>             Backend origin (default: env WABI_ORIGIN_URL or http://localhost:8080)
  --socket-url <url>         Socket URL (default: --origin)
  --username <name>          Login username / handle, or guest name when no password/token is supplied
  --password <pass>          Login password
  --token <jwt>              Reuse an existing auth token instead of logging in
  --channel <id>             Channel id to benchmark (default: general)
  --messages <n>             Measured messages (default: 25)
  --warmup <n>               Warmup messages (default: 3)
  --power-users <n>          Concurrent users for the power phase (default: 1 = disabled)
  --power-messages <n>       Messages per user in the power phase (default: 0 = disabled)
  --direct-stdb-samples <n>  Direct STDB reducer/query samples (default: 0)
  --message-size <n>         Approx text size in bytes (default: 32)
  --echo-timeout-ms <n>      Max wait for socket echo (default: 5000)
  --persist-timeout-ms <n>   Max wait for STDB visibility (default: 10000)
  --no-sqlite-probe          Disable legacy-SQLite visibility probes
  --admin-token <jwt>        Explicit admin token for /api/admin/state-plane (default: login token)
  --admin-username <name>    Username for the admin socket used by --prepare-channel
  --stdb-server <url>        STDB server URL for persistence checks
  --stdb-database <name>     STDB database name for persistence checks
  --stdb-token <jwt>         STDB bearer token
  --anonymous                Use STDB anonymous identity (default when no token and env allows)
  --no-anonymous             Disable STDB anonymous identity
  --prepare-channel          Ensure the target channel exists and has persistMessages=true before benchmarking
  --json                     Emit JSON summary
  -h, --help                 Show help
`);
}

function parsePositiveInt(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	const rounded = Math.floor(parsed);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function normalizeUrl(value, fallback) {
	const raw = String(value || fallback || '').trim();
	if (!raw) return '';
	if (raw.includes('://')) return raw.replace(/\/+$/, '');
	return `http://${raw.replace(/\/+$/, '')}`;
}

function normalizeAnonymous(defaultValue) {
	const raw = String(defaultValue).trim().toLowerCase();
	return !['0', 'false', 'no', 'off'].includes(raw);
}

function parseArgs(argv) {
	const origin = normalizeUrl(process.env.WABI_ORIGIN_URL || 'http://localhost:8080');
	const options = {
		origin,
		socketUrl: normalizeUrl(process.env.WABI_SOCKET_URL || origin),
		username: (process.env.WABI_BENCH_USERNAME || '').trim(),
		password: process.env.WABI_BENCH_PASSWORD || '',
		token: (process.env.WABI_AUTH_TOKEN || '').trim(),
		channelId: (process.env.WABI_BENCH_CHANNEL || 'general').trim(),
		messages: parsePositiveInt(process.env.WABI_BENCH_MESSAGES || '25', 25, 1, 5000),
		warmup: parsePositiveInt(process.env.WABI_BENCH_WARMUP || '3', 3, 0, 1000),
		powerUsers: parsePositiveInt(process.env.WABI_BENCH_POWER_USERS || '1', 1, 1, 128),
		powerMessages: parsePositiveInt(process.env.WABI_BENCH_POWER_MESSAGES || '0', 0, 0, 5000),
		directStdbSamples: parsePositiveInt(process.env.WABI_BENCH_DIRECT_STDB_SAMPLES || '0', 0, 0, 1000),
		messageSize: parsePositiveInt(process.env.WABI_BENCH_MESSAGE_SIZE || '32', 32, 8, 4096),
		echoTimeoutMs: parsePositiveInt(process.env.WABI_BENCH_ECHO_TIMEOUT_MS || '5000', 5000, 250, 120000),
		persistTimeoutMs: parsePositiveInt(process.env.WABI_BENCH_PERSIST_TIMEOUT_MS || '10000', 10000, 250, 300000),
		sqliteProbeEnabled: true,
		adminToken: (process.env.WABI_ADMIN_TOKEN || '').trim(),
		adminUsername: (process.env.WABI_ADMIN_USERNAME || '').trim(),
		stdbServer: normalizeUrl(process.env.WABI_STDB_BRIDGE_SERVER || ''),
		stdbDatabase: (process.env.WABI_STDB_BRIDGE_DATABASE || '').trim(),
		stdbToken: (process.env.WABI_STDB_AUTH_TOKEN || '').trim(),
		stdbAnonymous: normalizeAnonymous(process.env.WABI_STDB_ANONYMOUS || 'true'),
		prepareChannel: false,
		json: false
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if (arg === '--anonymous') {
			options.stdbAnonymous = true;
			continue;
		}
		if (arg === '--no-anonymous') {
			options.stdbAnonymous = false;
			continue;
		}
		if (arg === '--origin') {
			i += 1;
			options.origin = normalizeUrl(argv[i], options.origin);
			if (!options.socketUrl) options.socketUrl = options.origin;
			continue;
		}
		if (arg === '--socket-url') {
			i += 1;
			options.socketUrl = normalizeUrl(argv[i], options.origin);
			continue;
		}
		if (arg === '--username') {
			i += 1;
			options.username = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--password') {
			i += 1;
			options.password = String(argv[i] || '');
			continue;
		}
		if (arg === '--token') {
			i += 1;
			options.token = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--channel') {
			i += 1;
			options.channelId = String(argv[i] || '').trim() || 'general';
			continue;
		}
		if (arg === '--messages') {
			i += 1;
			options.messages = parsePositiveInt(argv[i], options.messages, 1, 5000);
			continue;
		}
		if (arg === '--warmup') {
			i += 1;
			options.warmup = parsePositiveInt(argv[i], options.warmup, 0, 1000);
			continue;
		}
		if (arg === '--power-users') {
			i += 1;
			options.powerUsers = parsePositiveInt(argv[i], options.powerUsers, 1, 128);
			continue;
		}
		if (arg === '--power-messages') {
			i += 1;
			options.powerMessages = parsePositiveInt(argv[i], options.powerMessages, 0, 5000);
			continue;
		}
		if (arg === '--direct-stdb-samples') {
			i += 1;
			options.directStdbSamples = parsePositiveInt(argv[i], options.directStdbSamples, 0, 1000);
			continue;
		}
		if (arg === '--message-size') {
			i += 1;
			options.messageSize = parsePositiveInt(argv[i], options.messageSize, 8, 4096);
			continue;
		}
		if (arg === '--echo-timeout-ms') {
			i += 1;
			options.echoTimeoutMs = parsePositiveInt(argv[i], options.echoTimeoutMs, 250, 120000);
			continue;
		}
		if (arg === '--persist-timeout-ms') {
			i += 1;
			options.persistTimeoutMs = parsePositiveInt(argv[i], options.persistTimeoutMs, 250, 300000);
			continue;
		}
		if (arg === '--no-sqlite-probe') {
			options.sqliteProbeEnabled = false;
			continue;
		}
		if (arg === '--admin-token') {
			i += 1;
			options.adminToken = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--admin-username') {
			i += 1;
			options.adminUsername = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--stdb-server') {
			i += 1;
			options.stdbServer = normalizeUrl(argv[i], '');
			continue;
		}
		if (arg === '--stdb-database') {
			i += 1;
			options.stdbDatabase = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--stdb-token') {
			i += 1;
			options.stdbToken = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--prepare-channel') {
			options.prepareChannel = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.origin) throw new Error('origin is required');
	if (!options.socketUrl) options.socketUrl = options.origin;
	if (!options.token && !options.username) {
		throw new Error('username is required unless --token is supplied');
	}
	if (!options.username && options.token) {
		throw new Error('username is required when --token is supplied');
	}

	return options;
}

async function fetchJson(url, init) {
	const response = await fetch(url, init);
	const text = await response.text().catch(() => '');
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${json?.error || text || response.statusText}`);
	}
	return json;
}

async function login(origin, username, password) {
	const json = await fetchJson(`${origin}/api/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});
	return {
		token: String(json?.token || '').trim(),
		username: String(json?.user?.username || username).trim()
	};
}

async function fetchAdminState(origin, token) {
	if (!token) return null;
	try {
		return await fetchJson(`${origin}/api/admin/state-plane`, {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

function makeMessageText(runId, index, size) {
	const compactRunId = String(runId).replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'bench';
	const prefix = `wb ${compactRunId} ${String(index).padStart(4, '0')} `;
	if (prefix.length >= size) return prefix.slice(0, size);
	return `${prefix}${'x'.repeat(size - prefix.length)}`;
}

function waitForSocketEvent(socket, eventName, predicate, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for socket event '${eventName}'`));
		}, timeoutMs);

		const onEvent = (...args) => {
			try {
				if (predicate && !predicate(...args)) return;
				settled = true;
				cleanup();
				resolve(args);
			} catch (error) {
				cleanup();
				reject(error);
			}
		};

		const onChannelError = (message) => {
			if (settled) return;
			cleanup();
			reject(new Error(`channel-error: ${message}`));
		};

		const onConnectError = (error) => {
			if (settled) return;
			cleanup();
			reject(new Error(`connect_error: ${error?.message || String(error)}`));
		};

		function cleanup() {
			clearTimeout(timeout);
			socket.off(eventName, onEvent);
			socket.off('channel-error', onChannelError);
			socket.off('connect_error', onConnectError);
		}

		socket.on(eventName, onEvent);
		socket.on('channel-error', onChannelError);
		socket.on('connect_error', onConnectError);
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeLatencies(values) {
	if (!values.length) {
		return {
			count: 0,
			minMs: null,
			maxMs: null,
			avgMs: null,
			p50Ms: null,
			p95Ms: null,
			p99Ms: null
		};
	}
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (p) => {
		const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
		return Number(sorted[index].toFixed(2));
	};
	const total = sorted.reduce((sum, value) => sum + value, 0);
	return {
		count: sorted.length,
		minMs: Number(sorted[0].toFixed(2)),
		maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
		avgMs: Number((total / sorted.length).toFixed(2)),
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		p99Ms: percentile(0.99)
	};
}

function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function buildAdminDelta(before, after) {
	if (!before?.runtime || !after?.runtime) {
		return null;
	}
	const beforeRuntime = before.runtime;
	const afterRuntime = after.runtime;
	return {
		mode: afterRuntime.config?.effectiveMode || afterRuntime.config?.mode || 'unknown',
		shadowSink: afterRuntime.shadowWriter?.sink || 'unknown',
		outboxWrittenDelta: toNumber(afterRuntime.outbox?.written) - toNumber(beforeRuntime.outbox?.written),
		outboxErrorsDelta: toNumber(afterRuntime.outbox?.errors) - toNumber(beforeRuntime.outbox?.errors),
		shadowAppliedDelta: toNumber(afterRuntime.shadowWriter?.applied) - toNumber(beforeRuntime.shadowWriter?.applied),
		shadowFailedDelta: toNumber(afterRuntime.shadowWriter?.failed) - toNumber(beforeRuntime.shadowWriter?.failed),
		shadowLoopErrorsDelta: toNumber(afterRuntime.shadowWriter?.loopErrors) - toNumber(beforeRuntime.shadowWriter?.loopErrors),
		shadowBacklogBytes: toNumber(afterRuntime.shadowWriter?.backlogBytes),
		messageShadowWriteFailuresDelta:
			toNumber(afterRuntime.messageStore?.shadow?.writesFailed) - toNumber(beforeRuntime.messageStore?.shadow?.writesFailed),
		messageParityMismatchesDelta:
			toNumber(afterRuntime.messageStore?.parity?.mismatches) - toNumber(beforeRuntime.messageStore?.parity?.mismatches)
	};
}

function normalizeStdbServer(server) {
	return normalizeUrl(server, '');
}

class StdbProbe {
	constructor(options) {
		this.server = normalizeStdbServer(options.server);
		this.database = String(options.database || '').trim();
		this.providedToken = String(options.token || '').trim() || null;
		this.allowAnonymous = Boolean(options.anonymous);
		this.timeoutMs = parsePositiveInt(options.timeoutMs || 5000, 5000, 250, 120000);
		this.identityToken = null;
	}

	isEnabled() {
		return Boolean(this.server && this.database);
	}

	async waitForMessage(messageId, timeoutMs) {
		if (!this.isEnabled()) return null;
		const startedAt = performance.now();
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const visible = await this.messageExists(messageId);
			if (visible) {
				return Number((performance.now() - startedAt).toFixed(2));
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return null;
	}

	async messageExists(messageId) {
		const query = `SELECT message_id FROM state_message WHERE message_id = '${String(messageId).replace(/'/g, "''")}' LIMIT 1`;
		let response = await this.sql(query, false);
		if (response.status === 401 && !this.providedToken && this.allowAnonymous) {
			response = await this.sql(query, true);
		}
		if (!response.ok) {
			throw new Error(`stdb_sql_${response.status}: ${response.text || response.statusText}`);
		}
		const rows = Array.isArray(response.json?.[0]?.rows) ? response.json[0].rows : [];
		return rows.length > 0;
	}

	async sql(query, forceRefresh) {
		const headers = {
			'Content-Type': 'text/plain'
		};
		const token = await this.resolveToken(forceRefresh);
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		return this.post(
			`${this.server}/v1/database/${encodeURIComponent(this.database)}/sql`,
			headers,
			query
		);
	}

	async callReducer(reducerName, args, forceRefresh = false) {
		const headers = {
			'Content-Type': 'application/json'
		};
		const token = await this.resolveToken(forceRefresh);
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
		return this.post(
			`${this.server}/v1/database/${encodeURIComponent(this.database)}/call/${encodeURIComponent(reducerName)}`,
			headers,
			JSON.stringify(args)
		);
	}

	async resolveToken(forceRefresh) {
		if (this.providedToken) return this.providedToken;
		if (!this.allowAnonymous) return null;
		if (!forceRefresh && this.identityToken) return this.identityToken;
		const response = await this.post(
			`${this.server}/v1/identity`,
			{ 'Content-Type': 'application/json' },
			'{}'
		);
		if (!response.ok) {
			throw new Error(`stdb_identity_${response.status}: ${response.text || response.statusText}`);
		}
		const token = response.json?.token;
		if (typeof token !== 'string' || token.trim().length === 0) {
			throw new Error('stdb_identity_missing_token');
		}
		this.identityToken = token.trim();
		return this.identityToken;
	}

	async post(url, headers, body) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body,
				signal: controller.signal
			});
			const text = await response.text().catch(() => '');
			let json = null;
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
}

class SqliteProbe {
	constructor(options) {
		this.timeoutMs = parsePositiveInt(options.timeoutMs || 5000, 5000, 100, 120000);
		this.origin = normalizeUrl(options.origin || 'http://localhost:8080');
		this.token = String(options.adminToken || '').trim();
		this.enabled = options.enabled !== false && this.token.length > 0;
		this.error = null;
		if (!this.enabled && !this.token) {
			this.error = 'admin token required';
		}
	}

	isEnabled() {
		return this.enabled;
	}

	getStatus() {
		return {
			enabled: this.isEnabled(),
			mode: 'admin_http',
			error: this.error
		};
	}

	async messageExists(messageId) {
		if (!this.isEnabled()) return false;
		const json = await fetchJson(
			`${this.origin}/api/admin/legacy-message-status?messageId=${encodeURIComponent(String(messageId))}`,
			{
				headers: {
					Authorization: `Bearer ${this.token}`
				}
			}
		);
		return json?.exists === true;
	}

	async waitForMessage(messageId, timeoutMs) {
		if (!this.isEnabled()) return null;
		const startedAt = performance.now();
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await this.messageExists(messageId)) {
				return Number((performance.now() - startedAt).toFixed(2));
			}
			await sleep(10);
		}
		return null;
	}

	close() {
		// No-op: probe is stateless HTTP.
	}
}

async function registerBenchmarkUser(origin, label) {
	const suffix = Math.random().toString(36).slice(2, 10);
	const username = `${label}_${suffix}`.slice(0, 31);
	const password = `Bench!${Math.random().toString(36).slice(2, 14)}Aa1`;
	const json = await fetchJson(`${origin}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username,
			password,
			handle: username
		})
	});
	return {
		username: String(json?.user?.username || username).trim(),
		password,
		token: String(json?.token || '').trim()
	};
}

function makeGuestUsername(label, index) {
	return `${label}_${index}_${Math.random().toString(36).slice(2, 7)}`.slice(0, 31);
}

async function connectSocket(options, token, username) {
	return await new Promise((resolve, reject) => {
		const socket = io(options.socketUrl, {
			transports: ['websocket', 'polling'],
			reconnection: false,
			timeout: options.echoTimeoutMs,
			withCredentials: true,
			forceNew: true,
			auth: {
				token
			}
		});

		const onConnect = () => {
			socket.off('connect_error', onConnectError);
			resolve(socket);
		};
		const onConnectError = (error) => {
			socket.off('connect', onConnect);
			reject(new Error(`connect_error: ${error?.message || String(error)}`));
		};

		socket.once('connect', onConnect);
		socket.once('connect_error', onConnectError);
	});
}

function getChannelFromInitPayload(payload, channelId) {
	const channels = Array.isArray(payload?.channels) ? payload.channels : [];
	return channels.find((channel) => channel?.id === channelId) || null;
}

async function ensurePersistentChannel(options) {
	if (!options.prepareChannel) return;
	if (!options.adminToken) {
		throw new Error('--prepare-channel requires --admin-token');
	}
	if (!options.adminUsername) {
		throw new Error('--prepare-channel requires --admin-username');
	}

	const adminSocket = await connectSocket(options, options.adminToken, options.adminUsername);
	try {
		const initPromise = waitForSocketEvent(adminSocket, 'init', () => true, options.echoTimeoutMs);
		adminSocket.emit('join', options.adminUsername);
		const [initPayload] = await initPromise;
		let existingChannel = getChannelFromInitPayload(initPayload, options.channelId);

		if (!existingChannel) {
			const createdPromise = waitForSocketEvent(
				adminSocket,
				'channel-created',
				(channel) => channel?.id === options.channelId,
				options.echoTimeoutMs
			);
			adminSocket.emit('create-channel', {
				name: options.channelId,
				channelType: 'text'
			});
			const [createdChannel] = await createdPromise;
			existingChannel = createdChannel || null;
		}

		if (existingChannel?.persistMessages === true) {
			return;
		}

		const updatedPromise = waitForSocketEvent(
			adminSocket,
			'channel-settings-updated',
			(payload) => payload?.channelId === options.channelId && payload?.persistMessages === true,
			options.echoTimeoutMs
		);
		adminSocket.emit('update-channel-settings', {
			channelId: options.channelId,
			persistMessages: true
		});
		await updatedPromise;
	} finally {
		adminSocket.disconnect();
	}
}

async function connectAndJoinChannel(options, token, username, channelId) {
	const socket = await connectSocket(options, token, username);
	try {
		const initPromise = waitForSocketEvent(socket, 'init', () => true, options.echoTimeoutMs);
		socket.emit('join', username);
		await initPromise;
		socket.emit('join-channel', channelId);
		await waitForSocketEvent(
			socket,
			'channel-messages',
			(data) => data?.channelId === channelId,
			options.echoTimeoutMs
		);
		return socket;
	} catch (error) {
		socket.disconnect();
		throw error;
	}
}

async function measureMessagePipeline({
	socket,
	options,
	channelId,
	text,
	sqliteProbe,
	stdbProbe
}) {
	const startedAt = performance.now();
	const eventPromise = waitForSocketEvent(
		socket,
		'message',
		(payload) => payload?.channelId === channelId && payload?.message?.text === text,
		options.echoTimeoutMs
	);
	socket.emit('message', {
		text,
		type: 'text',
		channelId
	});
	const [payload] = await eventPromise;
	const echoMs = Number((performance.now() - startedAt).toFixed(2));
	const messageId = payload?.message?.id;
	let sqliteMs = null;
	let sqliteError = null;
	let shadowMs = null;
	let shadowError = null;

	if (messageId && sqliteProbe?.isEnabled()) {
		try {
			sqliteMs = await sqliteProbe.waitForMessage(messageId, options.persistTimeoutMs);
			if (sqliteMs == null) {
				sqliteError = `Timed out waiting for SQLite visibility (${options.persistTimeoutMs}ms)`;
			}
		} catch (error) {
			sqliteError = error instanceof Error ? error.message : String(error);
		}
	}

	if (messageId && stdbProbe?.isEnabled()) {
		try {
			shadowMs = await stdbProbe.waitForMessage(messageId, options.persistTimeoutMs);
			if (shadowMs == null) {
				shadowError = `Timed out waiting for STDB visibility (${options.persistTimeoutMs}ms)`;
			}
		} catch (error) {
			shadowError = error instanceof Error ? error.message : String(error);
		}
	}

	return {
		messageId,
		echoMs,
		sqliteMs,
		sqliteError,
		shadowMs,
		shadowError
	};
}

function collectLatency(values, candidate) {
	if (typeof candidate === 'number' && Number.isFinite(candidate)) {
		values.push(candidate);
	}
}

function countFailures(entries, key) {
	return entries.filter((entry) => entry[key]).length;
}

async function runDirectStdbBench(options, stdbProbe, runId) {
	if (!stdbProbe.isEnabled() || options.directStdbSamples <= 0) return null;

	const reducerLatencies = [];
	const visibilityLatencies = [];
	const queryLatencies = [];
	const samples = [];
	let visibilityTimeouts = 0;
	let failures = 0;
	const reducerName = 'ingest_wabi_event';

	for (let i = 0; i < options.directStdbSamples; i += 1) {
		const ts = Date.now();
		const messageId = `direct-${runId}-${String(i + 1).padStart(3, '0')}`;
		const text = makeMessageText(`${runId}-direct`, i + 1, options.messageSize);
		const event = {
			eventId: `direct:${runId}:${i + 1}`,
			timestamp: ts,
			entity: 'message',
			operation: 'create',
			payload: {
				messageId,
				channelId: options.channelId,
				senderId: 'direct-bench',
				createdAt: ts,
				row: {
					message_id: messageId,
					channel_id: options.channelId,
					sender_id: 'direct-bench',
					created_at: ts,
					deleted: false,
					deleted_at: null,
					content: text,
					message_type: 'text'
				}
			}
		};

		let reducerMs = null;
		let visibilityMs = null;
		let queryMs = null;
		let errorMessage = null;

		try {
			const reducerStarted = performance.now();
			let response = await stdbProbe.callReducer(reducerName, [JSON.stringify(event)], false);
			if (response.status === 401) {
				response = await stdbProbe.callReducer(reducerName, [JSON.stringify(event)], true);
			}
			reducerMs = Number((performance.now() - reducerStarted).toFixed(2));
			if (!response.ok) {
				throw new Error(`stdb_reducer_${response.status}: ${response.text || response.statusText}`);
			}

			visibilityMs = await stdbProbe.waitForMessage(messageId, options.persistTimeoutMs);
			if (visibilityMs == null) {
				visibilityTimeouts += 1;
				errorMessage = `Timed out waiting for direct STDB visibility (${options.persistTimeoutMs}ms)`;
			}

			const query = `SELECT message_id FROM state_message WHERE message_id = '${messageId.replace(/'/g, "''")}' LIMIT 1`;
			const queryStarted = performance.now();
			const queryResponse = await stdbProbe.sql(query, false);
			queryMs = Number((performance.now() - queryStarted).toFixed(2));
			if (!queryResponse.ok) {
				throw new Error(`stdb_query_${queryResponse.status}: ${queryResponse.text || queryResponse.statusText}`);
			}
		} catch (error) {
			failures += 1;
			errorMessage = error instanceof Error ? error.message : String(error);
		}

		collectLatency(reducerLatencies, reducerMs);
		collectLatency(visibilityLatencies, visibilityMs);
		collectLatency(queryLatencies, queryMs);
		samples.push({
			index: i + 1,
			messageId,
			reducerMs,
			visibilityMs,
			queryMs,
			error: errorMessage
		});
	}

	return {
		samples: options.directStdbSamples,
		reducerCall: summarizeLatencies(reducerLatencies),
		visibility: summarizeLatencies(visibilityLatencies),
		query: summarizeLatencies(queryLatencies),
		visibilityTimeouts,
		failures,
		entries: samples
	};
}

async function runPowerPhase({
	options,
	runId,
	baseUser,
	sqliteProbe,
	stdbProbe,
	adminToken
}) {
	if (options.powerUsers <= 1 || options.powerMessages <= 0) return null;

	const credentials = [baseUser];
	for (let i = 1; i < options.powerUsers; i += 1) {
		credentials.push({
			username: makeGuestUsername('stdbpower', i + 1),
			token: null
		});
	}

	const sockets = [];
	const results = [];
	const adminBefore = await fetchAdminState(options.origin, adminToken);
	const startedAt = performance.now();

	try {
		for (const credential of credentials) {
			const socket = await connectAndJoinChannel(options, credential.token, credential.username, options.channelId);
			sockets.push({
				socket,
				username: credential.username
			});
		}

		await Promise.all(
			sockets.map(async ({ socket, username }, userIndex) => {
				for (let i = 0; i < options.powerMessages; i += 1) {
					const text = makeMessageText(`${runId}-power-u${userIndex + 1}`, i + 1, options.messageSize);
					try {
						const measurement = await measureMessagePipeline({
							socket,
							options,
							channelId: options.channelId,
							text,
							sqliteProbe,
							stdbProbe
						});
						results.push({
							username,
							index: i + 1,
							...measurement
						});
					} catch (error) {
						results.push({
							username,
							index: i + 1,
							messageId: null,
							echoMs: null,
							sqliteMs: null,
							sqliteError: null,
							shadowMs: null,
							shadowError: error instanceof Error ? error.message : String(error)
						});
					}
				}
			})
		);
	} finally {
		for (const entry of sockets) {
			entry.socket.disconnect();
		}
	}

	await sleep(500);
	const adminAfter = await fetchAdminState(options.origin, adminToken);
	const durationMs = Number((performance.now() - startedAt).toFixed(2));
	const totalMessages = options.powerUsers * options.powerMessages;
	const echoLatencies = [];
	const sqliteLatencies = [];
	const shadowLatencies = [];
	for (const entry of results) {
		collectLatency(echoLatencies, entry.echoMs);
		collectLatency(sqliteLatencies, entry.sqliteMs);
		collectLatency(shadowLatencies, entry.shadowMs);
	}

	return {
		users: options.powerUsers,
		messagesPerUser: options.powerMessages,
		totalMessages,
		durationMs,
		messagesPerSecond: durationMs > 0 ? Number(((totalMessages * 1000) / durationMs).toFixed(2)) : null,
		echo: summarizeLatencies(echoLatencies),
		sqliteVisibility: summarizeLatencies(sqliteLatencies),
		shadowVisibility: summarizeLatencies(shadowLatencies),
		sqliteTimeouts: countFailures(results, 'sqliteError'),
		shadowTimeouts: countFailures(results, 'shadowError'),
		failures: results.filter((entry) => entry.echoMs == null).length,
		adminDelta: buildAdminDelta(adminBefore, adminAfter),
		samples: results
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	const loginResult = options.token
		? { token: options.token, username: options.username }
		: options.password
			? await login(options.origin, options.username, options.password)
			: { token: '', username: options.username };
	const authToken = loginResult.token || '';
	const username = loginResult.username;
	const adminToken = options.adminToken || authToken;
	await ensurePersistentChannel({
		...options,
		adminToken,
		adminUsername: options.adminUsername
	});
	const stdbProbe = new StdbProbe({
		server: options.stdbServer,
		database: options.stdbDatabase,
		token: options.stdbToken,
		anonymous: options.stdbAnonymous,
		timeoutMs: options.persistTimeoutMs
	});
	const sqliteProbe = new SqliteProbe({
		origin: options.origin,
		adminToken,
		timeoutMs: options.persistTimeoutMs,
		enabled: options.sqliteProbeEnabled
	});
	const adminBefore = await fetchAdminState(options.origin, adminToken);

	const socket = await connectAndJoinChannel(options, authToken, username, options.channelId);
	try {
		const echoLatencies = [];
		const sqliteLatencies = [];
		const shadowLatencies = [];
		const messageResults = [];
		let sequence = 0;

		async function sendAndMeasure(isWarmup) {
			sequence += 1;
			const text = makeMessageText(runId, sequence, options.messageSize);
			const measurement = await measureMessagePipeline({
				socket,
				options,
				channelId: options.channelId,
				text,
				sqliteProbe,
				stdbProbe
			});
			if (!isWarmup) {
				collectLatency(echoLatencies, measurement.echoMs);
				collectLatency(sqliteLatencies, measurement.sqliteMs);
				collectLatency(shadowLatencies, measurement.shadowMs);
				messageResults.push({
					index: sequence - options.warmup,
					...measurement
				});
			}
		}

		for (let i = 0; i < options.warmup; i += 1) {
			await sendAndMeasure(true);
		}
		for (let i = 0; i < options.messages; i += 1) {
			await sendAndMeasure(false);
		}

		await new Promise((resolve) => setTimeout(resolve, 500));
		const adminAfter = await fetchAdminState(options.origin, adminToken);
		const adminDelta = buildAdminDelta(adminBefore, adminAfter);
		const sqliteTimeouts = countFailures(messageResults, 'sqliteError');
		const shadowTimeouts = countFailures(messageResults, 'shadowError');
		const directStdb = await runDirectStdbBench(options, stdbProbe, runId);
		const power = await runPowerPhase({
			options,
			runId,
			baseUser: {
				username,
				token: authToken
			},
			sqliteProbe,
			stdbProbe,
			adminToken
		});

		const summary = {
			ok: true,
			runId,
			origin: options.origin,
			socketUrl: options.socketUrl,
			channelId: options.channelId,
			username,
			mode: adminAfter?.runtime?.config?.effectiveMode || adminAfter?.runtime?.config?.mode || 'unknown',
			shadowSink: adminAfter?.runtime?.shadowWriter?.sink || 'unknown',
			messages: options.messages,
			warmup: options.warmup,
			messageSize: options.messageSize,
			sqliteProbe: sqliteProbe.getStatus(),
			stdbProbeEnabled: stdbProbe.isEnabled(),
			speed: {
				echo: summarizeLatencies(echoLatencies),
				sqliteVisibility: summarizeLatencies(sqliteLatencies),
				shadowVisibility: summarizeLatencies(shadowLatencies),
				sqliteTimeouts,
				shadowTimeouts,
				adminDelta,
				samples: messageResults
			},
			directStdb,
			power,
			adminBefore: adminBefore?.runtime?.config ? {
				mode: adminBefore.runtime.config.effectiveMode || adminBefore.runtime.config.mode,
				shadowSink: adminBefore.runtime.shadowWriter?.sink || 'unknown'
			} : adminBefore,
			adminAfter: adminAfter?.runtime?.config ? {
				mode: adminAfter.runtime.config.effectiveMode || adminAfter.runtime.config.mode,
				shadowSink: adminAfter.runtime.shadowWriter?.sink || 'unknown',
				backlogBytes: toNumber(adminAfter.runtime.shadowWriter?.backlogBytes)
			} : adminAfter
		};

		if (options.json) {
			console.log(JSON.stringify(summary, null, 2));
			return;
		}

		console.log('[state-plane-benchmark] Summary');
		console.log(`  runId=${summary.runId}`);
		console.log(`  mode=${summary.mode} shadowSink=${summary.shadowSink} stdbProbe=${summary.stdbProbeEnabled}`);
		console.log(`  channel=${summary.channelId} messages=${summary.messages} warmup=${summary.warmup} size=${summary.messageSize}`);
		console.log(`  speed.echo.avg=${summary.speed.echo.avgMs}ms speed.echo.p50=${summary.speed.echo.p50Ms}ms speed.echo.p95=${summary.speed.echo.p95Ms}ms speed.echo.max=${summary.speed.echo.maxMs}ms`);
		if (summary.sqliteProbe?.enabled) {
			console.log(`  speed.sqlite.avg=${summary.speed.sqliteVisibility.avgMs}ms speed.sqlite.p50=${summary.speed.sqliteVisibility.p50Ms}ms speed.sqlite.p95=${summary.speed.sqliteVisibility.p95Ms}ms speed.sqlite.max=${summary.speed.sqliteVisibility.maxMs}ms sqliteTimeouts=${summary.speed.sqliteTimeouts}`);
		} else if (summary.sqliteProbe?.error) {
			console.log(`  speed.sqlite=disabled reason=${summary.sqliteProbe.error}`);
		}
		if (summary.stdbProbeEnabled) {
			console.log(`  speed.shadow.avg=${summary.speed.shadowVisibility.avgMs}ms speed.shadow.p50=${summary.speed.shadowVisibility.p50Ms}ms speed.shadow.p95=${summary.speed.shadowVisibility.p95Ms}ms speed.shadow.max=${summary.speed.shadowVisibility.maxMs}ms shadowTimeouts=${summary.speed.shadowTimeouts}`);
		}
		if (summary.directStdb) {
			console.log(`  direct.reducer.avg=${summary.directStdb.reducerCall.avgMs}ms direct.reducer.p95=${summary.directStdb.reducerCall.p95Ms}ms direct.visible.avg=${summary.directStdb.visibility.avgMs}ms direct.query.avg=${summary.directStdb.query.avgMs}ms direct.failures=${summary.directStdb.failures}`);
		}
		if (summary.speed.adminDelta) {
			console.log(`  admin.mode=${summary.speed.adminDelta.mode} admin.shadowSink=${summary.speed.adminDelta.shadowSink}`);
			console.log(`  admin.outboxWrittenDelta=${summary.speed.adminDelta.outboxWrittenDelta} admin.shadowAppliedDelta=${summary.speed.adminDelta.shadowAppliedDelta} admin.shadowFailedDelta=${summary.speed.adminDelta.shadowFailedDelta} admin.backlogBytes=${summary.speed.adminDelta.shadowBacklogBytes}`);
		}
		if (summary.power) {
			console.log(`  power.users=${summary.power.users} power.messagesPerUser=${summary.power.messagesPerUser} power.totalMessages=${summary.power.totalMessages} power.durationMs=${summary.power.durationMs} power.mps=${summary.power.messagesPerSecond}`);
			console.log(`  power.echo.avg=${summary.power.echo.avgMs}ms power.echo.p95=${summary.power.echo.p95Ms}ms power.sqlite.avg=${summary.power.sqliteVisibility.avgMs}ms power.shadow.avg=${summary.power.shadowVisibility.avgMs}ms power.failures=${summary.power.failures}`);
		}
	} finally {
		socket.disconnect();
		sqliteProbe.close();
	}
}

main().catch((error) => {
	console.error('[state-plane-benchmark] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
});
