#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

function usage() {
	console.log(`Usage: node backend/scripts/state-plane-stdb-http.mjs <mode> [options]

Modes:
  call   POST reducer call with JSON args array body
  sql    POST SQL query body

Options:
  --server <url|nickname>   SpacetimeDB server (default: local)
  --database <name>         Database name (required)
  --token <jwt>             Bearer token (optional)
  --anonymous               Acquire anonymous identity token when --token is not provided
  --no-anonymous            Disable anonymous identity acquisition when --token is not provided
  --timeout-ms <n>          Request timeout in milliseconds (default: 10000)
  --token-cache-file <path> Anonymous token cache file (default: ./data/state-plane-stdb-token-cache.json)
  --reducer <name>          Reducer name (required for call mode)
  --args-json <json>        JSON array string for reducer args (required for call mode)
  --query <sql>             SQL query string (required for sql mode)
  --json                    Emit formatted JSON
  -h, --help                Show help
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

function normalizeServer(value) {
	const raw = String(value || 'local').trim();
	if (!raw || raw.toLowerCase() === 'local') return 'http://127.0.0.1:3000';
	if (raw.toLowerCase() === 'maincloud') return 'https://maincloud.spacetimedb.com';
	if (raw.includes('://')) return raw.replace(/\/+$/, '');
	return `http://${raw.replace(/\/+$/, '')}`;
}

function parseArgs(argv) {
	const anonymousDefault = process.env.NODE_ENV === 'production' ? 'false' : 'true';
	const options = {
		mode: '',
		server: normalizeServer(process.env.WABI_STDB_BRIDGE_SERVER || 'local'),
		database: (process.env.WABI_STDB_BRIDGE_DATABASE || '').trim(),
		token: (process.env.WABI_STDB_AUTH_TOKEN || '').trim(),
		anonymous: !['0', 'false', 'no', 'off'].includes((process.env.WABI_STDB_ANONYMOUS || anonymousDefault).trim().toLowerCase()),
		timeoutMs: parsePositiveInt(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS, 10000, 100, 300000),
		tokenCacheFile: (process.env.WABI_STDB_TOKEN_CACHE_FILE || '').trim(),
		reducer: (process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event').trim(),
		argsJson: '',
		query: '',
		json: false
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--anonymous') {
			options.anonymous = true;
			continue;
		}
		if (arg === '--no-anonymous') {
			options.anonymous = false;
			continue;
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if (arg === '--server') {
			i += 1;
			if (i >= argv.length) throw new Error('--server requires a value');
			options.server = normalizeServer(argv[i]);
			continue;
		}
		if (arg === '--database') {
			i += 1;
			if (i >= argv.length) throw new Error('--database requires a value');
			options.database = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--token') {
			i += 1;
			if (i >= argv.length) throw new Error('--token requires a value');
			options.token = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--timeout-ms') {
			i += 1;
			if (i >= argv.length) throw new Error('--timeout-ms requires a value');
			options.timeoutMs = parsePositiveInt(argv[i], 10000, 100, 300000);
			continue;
		}
		if (arg === '--token-cache-file') {
			i += 1;
			if (i >= argv.length) throw new Error('--token-cache-file requires a value');
			options.tokenCacheFile = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--reducer') {
			i += 1;
			if (i >= argv.length) throw new Error('--reducer requires a value');
			options.reducer = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--args-json') {
			i += 1;
			if (i >= argv.length) throw new Error('--args-json requires a value');
			options.argsJson = String(argv[i] || '');
			continue;
		}
		if (arg === '--query') {
			i += 1;
			if (i >= argv.length) throw new Error('--query requires a value');
			options.query = String(argv[i] || '');
			continue;
		}
		if (!options.mode && (arg === 'call' || arg === 'sql')) {
			options.mode = arg;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.mode) throw new Error('Missing mode (call|sql)');
	if (!options.database) throw new Error('--database is required');
	if (options.mode === 'call' && !options.reducer) throw new Error('--reducer is required for call mode');
	if (options.mode === 'call' && !options.argsJson) throw new Error('--args-json is required for call mode');
	if (options.mode === 'sql' && !options.query) throw new Error('--query is required for sql mode');

	return options;
}

function normalizeTokenCacheFile(input) {
	const raw = String(input || '').trim();
	if (!raw) {
		return resolve(process.cwd(), 'data/state-plane-stdb-token-cache.json');
	}
	return resolve(process.cwd(), raw);
}

function decodeJwtExpiryMs(token) {
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

function readTokenCache(cacheFile) {
	if (!existsSync(cacheFile)) return {};
	try {
		const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
		if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
			return parsed.servers;
		}
		return {};
	} catch {
		return {};
	}
}

function writeTokenCache(cacheFile, servers) {
	try {
		mkdirSync(dirname(cacheFile), { recursive: true });
		const next = {
			version: 1,
			servers
		};
		writeFileSync(cacheFile, `${JSON.stringify(next)}\n`, 'utf8');
	} catch {
		// Best effort cache write.
	}
}

function getCachedToken(cacheFile, server) {
	const servers = readTokenCache(cacheFile);
	const entry = servers?.[server];
	if (!entry || typeof entry !== 'object') return null;
	const token = typeof entry.token === 'string' ? entry.token.trim() : '';
	if (!token) return null;
	const expiresAt = Number(entry.expiresAt || 0);
	const now = Date.now();
	if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - 60_000 <= now) {
		return null;
	}
	return token;
}

function putCachedToken(cacheFile, server, token) {
	const servers = readTokenCache(cacheFile);
	const expMs = decodeJwtExpiryMs(token);
	servers[server] = {
		token,
		expiresAt: expMs || Date.now() + 10 * 60 * 1000,
		updatedAt: Date.now()
	};
	writeTokenCache(cacheFile, servers);
}

async function postJson(url, headers, body, timeoutMs) {
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

async function requestIdentityToken(options) {
	const identityResponse = await postJson(
		`${options.server}/v1/identity`,
		{ 'Content-Type': 'application/json' },
		'{}',
		options.timeoutMs
	);
	if (!identityResponse.ok) {
		throw new Error(
			`identity_request_failed status=${identityResponse.status} body=${identityResponse.text || identityResponse.statusText}`
		);
	}
	const token = identityResponse.json?.token;
	if (typeof token !== 'string' || token.trim().length === 0) {
		throw new Error('identity_request_succeeded_but_token_missing');
	}
	return token.trim();
}

async function resolveToken(options, forceRefresh = false) {
	if (options.token) return { token: options.token, source: 'provided' };
	if (!options.anonymous) return { token: null, source: 'none' };

	const cacheFile = normalizeTokenCacheFile(options.tokenCacheFile);
	if (!forceRefresh) {
		const cached = getCachedToken(cacheFile, options.server);
		if (cached) {
			return { token: cached, source: 'cache' };
		}
	}

	const fresh = await requestIdentityToken(options);
	putCachedToken(cacheFile, options.server, fresh);
	return { token: fresh, source: 'identity' };
}

function printResult(result, asJson) {
	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(JSON.stringify(result));
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const executeRequest = async (headers) =>
		options.mode === 'call'
			? postJson(
				`${options.server}/v1/database/${encodeURIComponent(options.database)}/call/${encodeURIComponent(options.reducer)}`,
				headers,
				options.argsJson,
				options.timeoutMs
			)
			: postJson(
				`${options.server}/v1/database/${encodeURIComponent(options.database)}/sql`,
				headers,
				options.query,
				options.timeoutMs
			);

	const startedAt = Date.now();
	let tokenInfo = await resolveToken(options);
	const headers = {
		'Content-Type': options.mode === 'sql' ? 'text/plain' : 'application/json'
	};
	if (tokenInfo.token) {
		headers.Authorization = `Bearer ${tokenInfo.token}`;
	}
	let response = await executeRequest(headers);
	if (
		!response.ok &&
		response.status === 401 &&
		!options.token &&
		options.anonymous
	) {
		tokenInfo = await resolveToken(options, true);
		const retryHeaders = {
			'Content-Type': options.mode === 'sql' ? 'text/plain' : 'application/json'
		};
		if (tokenInfo.token) {
			retryHeaders.Authorization = `Bearer ${tokenInfo.token}`;
		}
		response = await executeRequest(retryHeaders);
	}

	const durationMs = Date.now() - startedAt;
	const result = {
		mode: options.mode,
		server: options.server,
		database: options.database,
		reducer: options.mode === 'call' ? options.reducer : null,
		tokenSource: tokenInfo.source || 'none',
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		durationMs,
		json: response.json,
		text: response.text
	};

	printResult(result, options.json);
	if (!response.ok) {
		process.exit(1);
	}
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ ok: false, error: message }));
	process.exit(2);
}
