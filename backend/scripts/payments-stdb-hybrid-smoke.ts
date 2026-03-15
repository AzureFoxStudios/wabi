import { spawn, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { fileURLToPath } from 'url';

type JsonRecord = Record<string, any>;

type Options = {
	server: string;
	database: string;
	reducer: string;
	timeoutMs: number;
	skipPublish: boolean;
	json: boolean;
	modulePath: string;
	spacetimeBin: string;
};

type StdbOperatorAuth = {
	token: string | null;
	configPath: string | null;
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	const rounded = Math.floor(parsed);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function generateSmokeDatabaseName(): string {
	return `wabi-payments-hybrid-smoke-${Date.now().toString(36)}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		server: (process.env.WABI_STDB_BRIDGE_SERVER || 'http://127.0.0.1:3001').trim(),
		database: (
			process.env.WABI_STDB_HYBRID_SMOKE_DATABASE ||
			generateSmokeDatabaseName()
		).trim(),
		reducer: (process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event').trim(),
		timeoutMs: parsePositiveInt(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS || '15000', 15000, 100, 300000),
		skipPublish: false,
		json: false,
		modulePath: path.resolve(process.cwd(), '..', 'spacetimedb', 'wabi_state_bridge'),
		spacetimeBin: 'spacetime'
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if (arg === '--skip-publish') {
			options.skipPublish = true;
			continue;
		}
		if (arg === '--server') {
			i += 1;
			options.server = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--database') {
			i += 1;
			options.database = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--reducer') {
			i += 1;
			options.reducer = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--timeout-ms') {
			i += 1;
			options.timeoutMs = parsePositiveInt(argv[i], options.timeoutMs, 100, 300000);
			continue;
		}
		if (arg === '--module-path') {
			i += 1;
			options.modulePath = path.resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--spacetime-bin') {
			i += 1;
			options.spacetimeBin = String(argv[i] || '').trim();
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.server) throw new Error('server is required');
	if (!options.database) throw new Error('database is required');
	if (!fs.existsSync(options.modulePath)) {
		throw new Error(`Spacetime module path not found: ${options.modulePath}`);
	}
	return options;
}

async function getFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address !== 'object') {
				server.close();
				reject(new Error('failed_to_allocate_port'));
				return;
			}
			const { port } = address;
			server.close((closeError) => {
				if (closeError) {
					reject(closeError);
					return;
				}
				resolve(port);
			});
		});
	});
}

async function fetchJson(
	url: string,
	init?: RequestInit
): Promise<{ status: number; ok: boolean; data: JsonRecord; text: string }> {
	const response = await fetch(url, init);
	const text = await response.text();
	let data: JsonRecord = {};
	try {
		data = text ? (JSON.parse(text) as JsonRecord) : {};
	} catch {
		data = {};
	}
	return {
		status: response.status,
		ok: response.ok,
		data,
		text
	};
}

async function waitForHealth(baseUrl: string, hasExited: () => boolean): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 25_000) {
		if (hasExited()) {
			throw new Error('backend_exited_before_healthcheck');
		}
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) return;
		} catch {
			// retry
		}
		await delay(250);
	}
	throw new Error('backend_healthcheck_timeout');
}

function parseJsonLine(text: string): JsonRecord {
	const trimmed = String(text || '').trim();
	if (trimmed) {
		try {
			return JSON.parse(trimmed) as JsonRecord;
		} catch {
			// continue
		}
	}
	const lines = String(text || '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
			return JSON.parse(lines[i]) as JsonRecord;
		}
	}
	throw new Error(`expected JSON output, got: ${text}`);
}

function resolveCliConfigCandidates(): string[] {
	const candidates = new Set<string>();
	const localAppData = process.env.LOCALAPPDATA?.trim();
	if (localAppData) {
		candidates.add(path.join(localAppData, 'SpacetimeDB', 'config', 'cli.toml'));
	}
	const home = os.homedir();
	if (home) {
		candidates.add(path.join(home, '.config', 'SpacetimeDB', 'cli.toml'));
		candidates.add(path.join(home, '.spacetimedb', 'cli.toml'));
	}
	return [...candidates];
}

function resolveOperatorAuth(): StdbOperatorAuth {
	const envToken =
		String(process.env.WABI_STDB_AUTH_TOKEN || '').trim() ||
		String(process.env.STATE_SHADOW_TOKEN || '').trim();
	if (envToken) {
		return {
			token: envToken,
			configPath: null
		};
	}

	for (const candidate of resolveCliConfigCandidates()) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const raw = fs.readFileSync(candidate, 'utf8');
			const match = raw.match(/^\s*spacetimedb_token\s*=\s*"([^"]+)"/m);
			const token = String(match?.[1] || '').trim();
			if (!token) continue;
			return {
				token,
				configPath: candidate
			};
		} catch {
			// continue
		}
	}

	return {
		token: null,
		configPath: null
	};
}

function runCommand(command: string, args: string[], timeoutMs: number, context: string): string {
	const run = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 16 * 1024 * 1024
	});
	if (run.error) throw new Error(`${context}: ${run.error.message}`);
	if (run.signal) throw new Error(`${context}: terminated by ${run.signal}`);
	if (typeof run.status === 'number' && run.status !== 0) {
		const detail = (run.stderr || run.stdout || '').trim();
		throw new Error(`${context}: exit ${run.status}${detail ? ` (${detail})` : ''}`);
	}
	return run.stdout || '';
}

function insertDmChannel(
	databasePath: string,
	params: {
		channelId: string;
		creatorUserId: number;
		creatorUsername: string;
		counterpartyUserId: number;
		counterpartyUsername: string;
	}
): void {
	const sqlite = new Database(databasePath);
	try {
		const now = Date.now();
		sqlite
			.prepare(
				`
					INSERT INTO channels (
						channel_id,
						channel_type,
						name,
						description,
						min_role,
						created_at,
						created_by,
						persist_messages,
						watch_queue_enabled,
						is_archived
					)
					VALUES (?, 'dm', ?, '', 'member', ?, ?, 1, 0, 0)
				`
			)
			.run(
				params.channelId,
				`${params.creatorUsername}, ${params.counterpartyUsername}`,
				now,
				`user-${params.creatorUserId}`
			);
		sqlite
			.prepare(
				`
					INSERT INTO channel_members (
						channel_id,
						user_id,
						username,
						registered_user_id,
						joined_at,
						role
					)
					VALUES (?, ?, ?, ?, ?, 'member')
				`
			)
			.run(params.channelId, `user-${params.creatorUserId}`, params.creatorUsername, params.creatorUserId, now);
		sqlite
			.prepare(
				`
					INSERT INTO channel_members (
						channel_id,
						user_id,
						username,
						registered_user_id,
						joined_at,
						role
					)
					VALUES (?, ?, ?, ?, ?, 'member')
				`
			)
			.run(
				params.channelId,
				`user-${params.counterpartyUserId}`,
				params.counterpartyUsername,
				params.counterpartyUserId,
				now
			);
	} finally {
		sqlite.close();
	}
}

function decodeSqlRows(sqlResponse: JsonRecord): JsonRecord[] {
	const normalized = Array.isArray(sqlResponse) ? sqlResponse[0] : sqlResponse;
	const elements = Array.isArray(normalized?.schema?.elements) ? normalized.schema.elements : [];
	const names = elements.map((entry: JsonRecord, index: number) => entry?.name?.some || `col_${index}`);
	const rows = Array.isArray(normalized?.rows) ? normalized.rows : [];
	return rows.map((row: unknown[]) => {
		const out: JsonRecord = {};
		for (let i = 0; i < names.length; i += 1) {
			out[names[i]] = decodeSqlCell(row?.[i]);
		}
		return out;
	});
}

function decodeSqlCell(value: unknown): unknown {
	if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
		if (value[0] === 0) return value[1];
		if (value[0] === 1) return null;
	}
	return value;
}

function escapeSqlLiteral(value: string): string {
	return `'${String(value).replace(/'/g, "''")}'`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const helperPath = path.resolve(__dirname, 'state-plane-stdb-http.mjs');

const options = parseArgs(process.argv.slice(2));
const operatorAuth = resolveOperatorAuth();
const hasOperatorToken = Boolean(operatorAuth.token);
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wabi-payments-stdb-hybrid-'));
fs.mkdirSync(path.join(smokeRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(smokeRoot, 'uploads'), { recursive: true });

if (!options.skipPublish) {
	const publishArgs = [
		'publish',
		'--module-path',
		options.modulePath,
		'--server',
		options.server,
		options.database,
		'--yes'
	];
	if (!hasOperatorToken) {
		publishArgs.push('--no-config', '--anonymous');
	}
	runCommand(
		options.spacetimeBin,
		operatorAuth.configPath
			? ['--config-path', operatorAuth.configPath, ...publishArgs]
			: publishArgs,
		Math.max(options.timeoutMs, 120000),
		'spacetime publish'
	);
}

const helperBase = [
	helperPath,
	'--server',
	options.server,
	'--database',
	options.database,
	'--timeout-ms',
	String(options.timeoutMs)
];
if (hasOperatorToken) {
	helperBase.push('--token', operatorAuth.token as string);
} else {
	helperBase.push('--anonymous');
}

function helperCall(modeArgs: string[], context: string): JsonRecord {
	const stdout = runCommand(process.execPath, [...helperBase, ...modeArgs], options.timeoutMs + 3000, context);
	return parseJsonLine(stdout);
}

function sqlRows(query: string): JsonRecord[] {
	const response = helperCall(['sql', '--query', query], 'stdb sql');
	assert(response?.ok === true, `stdb sql failed: ${query}`);
	return decodeSqlRows(response.json as JsonRecord);
}

function emit(entity: string, operation: string, payload: JsonRecord): void {
	const event = {
		eventId: `payments_hybrid_${Date.now()}_${Math.random().toString(16).slice(2)}`,
		timestamp: Date.now(),
		entity,
		operation,
		payload
	};
	const response = helperCall(
		[
			'call',
			'--reducer',
			options.reducer,
			'--args-json',
			JSON.stringify([JSON.stringify(event)])
		],
		`stdb call ${entity}.${operation}`
	);
	assert(response?.ok === true, `stdb reducer call failed for ${entity}.${operation}`);
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const databasePath = path.join(smokeRoot, 'data', 'chat.db');
const env = {
	...process.env,
	NODE_ENV: 'development',
	BACKEND_PORT: String(port),
	PORT: String(port),
	DB_MODE: 'sqlite',
	DATABASE_PATH: databasePath,
	DATA_DIR: path.join(smokeRoot, 'data'),
	UPLOADS_DIR: path.join(smokeRoot, 'uploads'),
	FRONTEND_URL: 'http://localhost:5173',
	PUBLIC_URL: baseUrl,
	ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost,http://127.0.0.1',
	JWT_SECRET: 'payments-stdb-hybrid-smoke-secret-123456789',
	PLUGINS_ENABLED: 'true',
	PLUGINS_ALLOW_INSTALL: 'false',
	PLUGINS_DIR: '../plugins',
	PLUGIN_SIGNATURE_POLICY: 'signed-only',
	WABI_PUBLIC_BASE_URL: baseUrl,
	TH_PAYMENTS_PROMPTPAY_PROXY_ID: '0812345678',
	BTC_PAYMENTS_DONATION_ADDRESS: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
	BTC_PAYMENTS_TEST_MODE: 'true',
	WEST_PAYMENTS_TEST_MODE: 'true',
	PAYMENTS_ACCESS_BOOTSTRAP_MODE: 'seed_if_missing',
	PAYMENTS_ACCESS_ENABLED: 'true',
	PAYMENTS_ACCESS_ALLOW_GUEST: 'false',
	PAYMENTS_ACCESS_ALLOWED_ROLES: 'owner,admin,mod,member',
	STATE_BACKEND_MODE: 'stdb_primary',
	STATE_STDB_READ_ENABLED: 'true',
	STATE_STDB_WRITE_ENABLED: 'true',
	STATE_BACKEND_STRICT: 'true',
	STATE_STDB_SUBSCRIPTIONS_ENABLED: 'false',
	WABI_STDB_BRIDGE_SERVER: options.server,
	WABI_STDB_BRIDGE_DATABASE: options.database,
	WABI_STDB_BRIDGE_REDUCER: options.reducer,
	WABI_STDB_BRIDGE_TIMEOUT_MS: String(options.timeoutMs),
	WABI_STDB_AUTH_TOKEN: operatorAuth.token || '',
	WABI_STDB_ANONYMOUS: hasOperatorToken ? 'false' : 'true'
};

const server = spawn(process.execPath, ['dist/server.js'], {
	cwd: backendDir,
	env,
	stdio: ['ignore', 'pipe', 'pipe']
});

let serverExited = false;
let serverLog = '';
server.stdout.on('data', (chunk) => {
	serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
	serverLog += chunk.toString();
});
server.on('exit', () => {
	serverExited = true;
});

try {
	await waitForHealth(baseUrl, () => serverExited);

	const bitcoinProviders = await fetchJson(`${baseUrl}/api/payments/providers?currency=BTC`);
	assert(bitcoinProviders.ok, `bitcoin providers failed: ${bitcoinProviders.status} ${bitcoinProviders.text}`);
	assert(
		Array.isArray(bitcoinProviders.data.providers) &&
			bitcoinProviders.data.providers.some((provider: JsonRecord) => provider.pluginId === 'btc-payments'),
		'btc-payments provider missing from BTC provider list in stdb_primary'
	);

	const registerOwner = await fetchJson(`${baseUrl}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username: 'STDB Owner',
			handle: 'stdbowner',
			password: 'Stdb-Owner-Pass-123'
		})
	});
	assert(registerOwner.ok, `owner register failed: ${registerOwner.status} ${registerOwner.text}`);
	const ownerToken = String(registerOwner.data.token || '');
	const ownerUserId = Number(registerOwner.data.user?.id || 0);
	assert(ownerToken && ownerUserId > 0, 'owner auth payload missing');

	const registerMember = await fetchJson(`${baseUrl}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			username: 'STDB Member',
			handle: 'stdbmember',
			password: 'Stdb-Member-Pass-123'
		})
	});
	assert(registerMember.ok, `member register failed: ${registerMember.status} ${registerMember.text}`);
	const memberToken = String(registerMember.data.token || '');
	const memberUserId = Number(registerMember.data.user?.id || 0);
	assert(memberToken && memberUserId > 0, 'member auth payload missing');

	const ownerHeaders = {
		Authorization: `Bearer ${ownerToken}`,
		'Content-Type': 'application/json'
	};
	const memberHeaders = {
		Authorization: `Bearer ${memberToken}`,
		'Content-Type': 'application/json'
	};

	const statePlane = await fetchJson(`${baseUrl}/api/admin/state-plane`, {
		headers: { Authorization: `Bearer ${ownerToken}` }
	});
	assert(statePlane.ok, `state-plane status failed: ${statePlane.status} ${statePlane.text}`);
	assert(
		statePlane.data.runtime?.config?.effectiveMode === 'stdb_primary',
		`expected stdb_primary, got ${JSON.stringify(statePlane.data.runtime?.config)}`
	);

	const dmChannelId = 'stdb_hybrid_dm_channel';
	insertDmChannel(databasePath, {
		channelId: dmChannelId,
		creatorUserId: ownerUserId,
		creatorUsername: 'STDB Owner',
		counterpartyUserId: memberUserId,
		counterpartyUsername: 'STDB Member'
	});
	const now = Date.now();
	emit('channel', 'create', {
		channelId: dmChannelId,
		row: {
			channel_id: dmChannelId,
			channel_type: 'dm',
			name: 'STDB Owner, STDB Member',
			description: '',
			min_role: 'member',
			voice_settings_json: null,
			watch_queue_enabled: 0,
			created_at: now,
			created_by: `user-${ownerUserId}`,
			persist_messages: 1,
			is_archived: 0
		}
	});
	emit('channel_member', 'add_member', {
		channelId: dmChannelId,
		userId: `user-${ownerUserId}`,
		row: {
			channel_id: dmChannelId,
			user_id: `user-${ownerUserId}`,
			username: 'STDB Owner',
			registered_user_id: ownerUserId,
			joined_at: now,
			role: 'member'
		}
	});
	emit('channel_member', 'add_member', {
		channelId: dmChannelId,
		userId: `user-${memberUserId}`,
		row: {
			channel_id: dmChannelId,
			user_id: `user-${memberUserId}`,
			username: 'STDB Member',
			registered_user_id: memberUserId,
			joined_at: now,
			role: 'member'
		}
	});

	const accountLink = await fetchJson(`${baseUrl}/api/payments/account-links`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			pluginId: 'th-payments',
			providerAccountRef: '0812345678',
			displayLabel: 'PromptPay Smoke'
		})
	});
	assert(accountLink.ok, `account link failed: ${accountLink.status} ${accountLink.text}`);

	const bitcoinAccountLink = await fetchJson(`${baseUrl}/api/payments/account-links`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			pluginId: 'btc-payments',
			providerAccountRef: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
			displayLabel: 'Bitcoin Smoke'
		})
	});
	assert(bitcoinAccountLink.ok, `bitcoin account link failed: ${bitcoinAccountLink.status} ${bitcoinAccountLink.text}`);

	const donationConfig = await fetchJson(`${baseUrl}/api/admin/payments/donations`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			enabled: true,
			providerPluginId: 'th-payments',
			methodId: 'promptpay_qr',
			currency: 'THB',
			countryCode: 'TH',
			suggestedAmountsMinor: [500, 1000, 2500],
			headline: 'Support This Server',
			description: 'STDB hybrid smoke donation route'
		})
	});
	assert(donationConfig.ok, `donation config failed: ${donationConfig.status} ${donationConfig.text}`);

	const paymentIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			pluginId: 'th-payments',
			methodId: 'promptpay_qr',
			amountMinor: 4200,
			currency: 'THB',
			countryCode: 'TH',
			description: 'STDB hybrid smoke payment'
		})
	});
	assert(paymentIntent.ok, `payment create failed: ${paymentIntent.status} ${paymentIntent.text}`);
	const paymentIntentId = String(paymentIntent.data.intent?.intentId || '');
	assert(paymentIntentId, 'payment intent id missing');
	assert(
		paymentIntent.data.intent?.customerRef === '0812345678',
		'personal thai payment should reuse the saved PromptPay reference in stdb_primary'
	);

	const bitcoinIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			pluginId: 'btc-payments',
			methodId: 'bitcoin_qr',
			amountMinor: 125000,
			currency: 'BTC',
			description: 'STDB hybrid bitcoin payment'
		})
	});
	assert(bitcoinIntent.ok, `bitcoin payment create failed: ${bitcoinIntent.status} ${bitcoinIntent.text}`);
	assert(
		bitcoinIntent.data.intent?.customerRef === 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
		'personal bitcoin payment should reuse the saved Bitcoin address in stdb_primary'
	);

	const donationIntent = await fetchJson(`${baseUrl}/api/payments/create`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			pluginId: 'th-payments',
			methodId: 'promptpay_qr',
			amountMinor: 1200,
			currency: 'THB',
			countryCode: 'TH',
			description: 'STDB hybrid donation payment',
			metadata: {
				kind: 'server_donation',
				target: 'default_workspace'
			}
		})
	});
	assert(donationIntent.ok, `donation payment create failed: ${donationIntent.status} ${donationIntent.text}`);
	assert(
		donationIntent.data.intent?.customerRef == null,
		'server donation thai payment should not inherit the owner saved PromptPay reference in stdb_primary'
	);

	const manualCash = await fetchJson(`${baseUrl}/api/manual-cash`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			channelId: dmChannelId,
			amountMinor: 3300,
			currency: 'THB',
			description: 'STDB hybrid manual cash'
		})
	});
	assert(manualCash.ok, `manual cash create failed: ${manualCash.status} ${manualCash.text}`);
	const settlementId = String(manualCash.data.settlement?.settlementId || '');
	assert(settlementId, 'manual settlement id missing');

	const memberConfirm = await fetchJson(`${baseUrl}/api/manual-cash/${settlementId}/confirm`, {
		method: 'POST',
		headers: memberHeaders,
		body: JSON.stringify({})
	});
	assert(memberConfirm.ok, `member manual cash confirm failed: ${memberConfirm.status} ${memberConfirm.text}`);
	const ownerConfirm = await fetchJson(`${baseUrl}/api/manual-cash/${settlementId}/confirm`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({})
	});
	assert(ownerConfirm.ok, `owner manual cash confirm failed: ${ownerConfirm.status} ${ownerConfirm.text}`);

	const blockMember = await fetchJson(`${baseUrl}/api/admin/payments/blocks`, {
		method: 'POST',
		headers: ownerHeaders,
		body: JSON.stringify({
			userId: memberUserId,
			reason: 'STDB smoke block'
		})
	});
	assert(blockMember.ok, `payment block failed: ${blockMember.status} ${blockMember.text}`);
	const linkedAccounts = await fetchJson(`${baseUrl}/api/payments/account-links`, {
		method: 'GET',
		headers: ownerHeaders
	});
	assert(linkedAccounts.ok, `payment account links list failed: ${linkedAccounts.status} ${linkedAccounts.text}`);
	assert(
		Array.isArray(linkedAccounts.data.links) && linkedAccounts.data.links.length >= 1,
		'expected payment account links from stdb_primary read path'
	);
	const paymentBlocks = await fetchJson(`${baseUrl}/api/admin/payments/blocks`, {
		method: 'GET',
		headers: ownerHeaders
	});
	assert(paymentBlocks.ok, `payment block list failed: ${paymentBlocks.status} ${paymentBlocks.text}`);
	assert(
		Array.isArray(paymentBlocks.data.blocks) && paymentBlocks.data.blocks.length >= 1,
		'expected payment user blocks from stdb_primary read path'
	);

	const accessRows = sqlRows(
		`SELECT row_json FROM state_payment_policy WHERE policy_key = ${escapeSqlLiteral('policy:payments_access')} LIMIT 1`
	);
	assert(accessRows.length === 1, 'missing STDB payments access policy row');
	const donationRows = sqlRows(
		`SELECT row_json FROM state_payment_policy WHERE policy_key = ${escapeSqlLiteral('policy:payments_donations')} LIMIT 1`
	);
	assert(donationRows.length === 1, 'missing STDB payments donation config row');
	const accountLinkRows = sqlRows(
		`SELECT row_json FROM state_payment_account_link WHERE user_id = ${ownerUserId} AND workspace_id = ${escapeSqlLiteral('default-workspace')} AND plugin_id = ${escapeSqlLiteral('th-payments')} LIMIT 1`
	);
	assert(accountLinkRows.length === 1, 'missing STDB payment account link row');
	const bitcoinAccountLinkRows = sqlRows(
		`SELECT row_json FROM state_payment_account_link WHERE user_id = ${ownerUserId} AND workspace_id = ${escapeSqlLiteral('default-workspace')} AND plugin_id = ${escapeSqlLiteral('btc-payments')} LIMIT 1`
	);
	assert(bitcoinAccountLinkRows.length === 1, 'missing STDB bitcoin account link row');
	const userBlockRows = sqlRows(
		`SELECT row_json FROM state_payment_user_block WHERE user_id = ${memberUserId} AND workspace_id = ${escapeSqlLiteral('default-workspace')} LIMIT 1`
	);
	assert(userBlockRows.length === 1, 'missing STDB payment user block row');
	const paymentRows = sqlRows(
		`SELECT row_json FROM state_payment_intent WHERE intent_id = ${escapeSqlLiteral(paymentIntentId)} LIMIT 1`
	);
	assert(paymentRows.length === 1, 'missing STDB payment intent row');
	const paymentEventRows = sqlRows(
		`SELECT row_json FROM state_payment_event WHERE intent_id = ${escapeSqlLiteral(paymentIntentId)} LIMIT 5`
	);
	assert(paymentEventRows.length >= 1, 'missing STDB payment event row');
	const settlementRows = sqlRows(
		`SELECT row_json FROM state_manual_settlement WHERE settlement_id = ${escapeSqlLiteral(settlementId)} LIMIT 1`
	);
	assert(settlementRows.length === 1, 'missing STDB manual settlement row');

	const summary = {
		ok: true,
		server: options.server,
		database: options.database,
		baseUrl,
		paymentIntentId,
		settlementId,
		checks: {
			statePlaneMode: statePlane.data.runtime?.config?.effectiveMode,
			paymentPolicyRows: accessRows.length,
			donationPolicyRows: donationRows.length,
			accountLinkRows: accountLinkRows.length,
			bitcoinAccountLinkRows: bitcoinAccountLinkRows.length,
			userBlockRows: userBlockRows.length,
			paymentRows: paymentRows.length,
			paymentEventRows: paymentEventRows.length,
			manualSettlementRows: settlementRows.length
		}
	};

	if (options.json) {
		console.log(JSON.stringify(summary, null, 2));
	} else {
		console.log(summary);
	}
} catch (error) {
	console.error('[payments-stdb-hybrid-smoke] failed');
	console.error(error instanceof Error ? error.stack || error.message : error);
	if (serverLog.trim()) {
		console.error('--- backend log ---');
		console.error(serverLog.trim());
	}
	process.exitCode = 1;
} finally {
	server.kill();
	await delay(250);
}
