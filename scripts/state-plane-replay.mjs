#!/usr/bin/env node

import { createHmac, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { spawnSync } from 'child_process';

function usage() {
	console.log(`Usage: node scripts/state-plane-replay.mjs [options]

Replays outbox/deadletter NDJSON events into a target sink.

Options:
  --mode <ingress|command>   Replay target mode (default: ingress)
  --source <path>         NDJSON file to replay (default: ./data/state-plane-outbox.ndjson)
  --origin <url>          Base URL (default: env WABI_ORIGIN_URL or http://localhost:8080)
  --path <path>           Reducer ingress path (default: /api/internal/state-plane/reducer)
  --token <token>         Bearer token (default: env WABI_SHADOW_TOKEN/STATE_SHADOW_TOKEN)
  --signing-secret <val>  HMAC signing secret (default: env WABI_SHADOW_SIGNING_SECRET/STATE_SHADOW_SIGNING_SECRET)
  --signing-key-id <val>  Optional signing key id
  --command <cmd>         Shell command for mode=command (default: env STATE_SHADOW_COMMAND)
  --offset-file <path>    Resume offset file path (default: <source>.replay.offset)
  --no-resume             Ignore existing offset file (start from 0)
  --from-start            Start from byte offset 0 and overwrite offset file on success
  --max-events <n>        Maximum events to process this run (default: all records)
  --max-errors <n>        Stop after this many errors (default: 20)
  --timeout-ms <n>        Timeout per event (HTTP or command) (default: 10000)
  --save-every <n>        Persist offset every n processed events (default: 100)
  --strict                Stop on first non-success response/parse error
  --dry-run               Parse/validate records without sending
  --json                  Emit summary as JSON
  -h, --help              Show help
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

function parseArgs(argv) {
	const defaults = {
		mode: (process.env.WABI_STATE_REPLAY_MODE || 'ingress').trim().toLowerCase(),
		source: resolve(process.cwd(), process.env.WABI_STATE_REPLAY_SOURCE || 'data/state-plane-outbox.ndjson'),
		origin: (process.env.WABI_ORIGIN_URL || 'http://localhost:8080').trim().replace(/\/+$/, ''),
		path: (process.env.WABI_STATE_REDUCER_PATH || '/api/internal/state-plane/reducer').trim(),
		token: (process.env.WABI_SHADOW_TOKEN || process.env.STATE_SHADOW_TOKEN || '').trim(),
		signingSecret: (process.env.WABI_SHADOW_SIGNING_SECRET || process.env.STATE_SHADOW_SIGNING_SECRET || '').trim(),
		signingKeyId: (process.env.WABI_SHADOW_SIGNING_KEY_ID || process.env.STATE_SHADOW_SIGNING_KEY_ID || '').trim(),
		command: (process.env.WABI_STATE_REPLAY_COMMAND || process.env.STATE_SHADOW_COMMAND || '').trim(),
		offsetFile: null,
		resume: true,
		fromStart: false,
		maxEvents: Number.MAX_SAFE_INTEGER,
		maxErrors: 20,
		timeoutMs: 10000,
		saveEvery: 100,
		strict: false,
		dryRun: false,
		json: false
	};

	const options = { ...defaults };

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--no-resume') {
			options.resume = false;
			continue;
		}
		if (arg === '--from-start') {
			options.fromStart = true;
			options.resume = true;
			continue;
		}
		if (arg === '--strict') {
			options.strict = true;
			continue;
		}
		if (arg === '--dry-run') {
			options.dryRun = true;
			continue;
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if (arg === '--mode') {
			i += 1;
			if (i >= argv.length) throw new Error('--mode requires a value');
			options.mode = String(argv[i] || '').trim().toLowerCase();
			continue;
		}
		if (arg === '--source') {
			i += 1;
			if (i >= argv.length) throw new Error('--source requires a value');
			options.source = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--origin') {
			i += 1;
			if (i >= argv.length) throw new Error('--origin requires a value');
			options.origin = String(argv[i] || '').trim().replace(/\/+$/, '');
			continue;
		}
		if (arg === '--path') {
			i += 1;
			if (i >= argv.length) throw new Error('--path requires a value');
			options.path = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--token') {
			i += 1;
			if (i >= argv.length) throw new Error('--token requires a value');
			options.token = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--signing-secret') {
			i += 1;
			if (i >= argv.length) throw new Error('--signing-secret requires a value');
			options.signingSecret = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--signing-key-id') {
			i += 1;
			if (i >= argv.length) throw new Error('--signing-key-id requires a value');
			options.signingKeyId = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--command') {
			i += 1;
			if (i >= argv.length) throw new Error('--command requires a value');
			options.command = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--offset-file') {
			i += 1;
			if (i >= argv.length) throw new Error('--offset-file requires a value');
			options.offsetFile = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--max-events') {
			i += 1;
			if (i >= argv.length) throw new Error('--max-events requires a value');
			options.maxEvents = parsePositiveInt(argv[i], Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
			continue;
		}
		if (arg === '--max-errors') {
			i += 1;
			if (i >= argv.length) throw new Error('--max-errors requires a value');
			options.maxErrors = parsePositiveInt(argv[i], 20, 1, 1_000_000);
			continue;
		}
		if (arg === '--timeout-ms') {
			i += 1;
			if (i >= argv.length) throw new Error('--timeout-ms requires a value');
			options.timeoutMs = parsePositiveInt(argv[i], 10000, 100, 300000);
			continue;
		}
		if (arg === '--save-every') {
			i += 1;
			if (i >= argv.length) throw new Error('--save-every requires a value');
			options.saveEvery = parsePositiveInt(argv[i], 100, 1, 1_000_000);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.offsetFile) {
		options.offsetFile = `${options.source}.replay.offset`;
	}
	if (options.mode !== 'ingress' && options.mode !== 'command') {
		throw new Error('mode must be ingress or command');
	}
	if (options.mode === 'ingress') {
		if (!options.origin) throw new Error('origin is required in ingress mode');
		if (!options.path || !options.path.startsWith('/')) throw new Error('path must start with "/" in ingress mode');
	}
	if (options.mode === 'command' && !options.command) {
		throw new Error('command is required in command mode');
	}

	return options;
}

function loadOffset(path) {
	if (!existsSync(path)) return 0;
	try {
		const raw = readFileSync(path, 'utf8').trim();
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed < 0) return 0;
		return Math.floor(parsed);
	} catch {
		return 0;
	}
}

function saveOffset(path, offset) {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${Math.max(0, Math.floor(offset))}\n`);
}

function buildHeaders(body, options) {
	const headers = {
		'Content-Type': 'application/json'
	};

	if (options.token) {
		headers.Authorization = `Bearer ${options.token}`;
	}

	if (options.signingSecret) {
		const timestamp = Date.now().toString();
		const nonce = randomBytes(16).toString('hex');
		const signature = createHmac('sha256', options.signingSecret)
			.update(`${timestamp}.${nonce}.${body}`)
			.digest('hex');
		headers['X-Wabi-State-Timestamp'] = timestamp;
		headers['X-Wabi-State-Nonce'] = nonce;
		headers['X-Wabi-State-Signature'] = `sha256=${signature}`;
		headers['X-Wabi-State-Signature-Alg'] = 'hmac-sha256';
		if (options.signingKeyId) {
			headers['X-Wabi-State-Key-Id'] = options.signingKeyId;
		}
	}

	return headers;
}

async function postJson(url, body, headers, timeoutMs) {
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

function runCommand(command, body, timeoutMs) {
	const result = spawnSync(command, {
		shell: true,
		input: `${body}\n`,
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 8 * 1024 * 1024
	});

	if (result.error) {
		return {
			ok: false,
			status: 0,
			statusText: result.error.message,
			text: result.error.message,
			json: null
		};
	}
	if (result.signal) {
		return {
			ok: false,
			status: 0,
			statusText: `terminated:${result.signal}`,
			text: result.stderr || '',
			json: null
		};
	}
	const exitCode = typeof result.status === 'number' ? result.status : -1;
	return {
		ok: exitCode === 0,
		status: exitCode,
		statusText: exitCode === 0 ? 'ok' : 'command_failed',
		text: ((result.stderr || '').trim() || (result.stdout || '').trim()),
		json: null
	};
}

function printSummary(summary, asJson) {
	if (asJson) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log('[state-plane-replay] Summary');
	console.log(`  mode=${summary.mode}`);
	console.log(`  source=${summary.source}`);
	if (summary.mode === 'ingress') {
		console.log(`  endpoint=${summary.endpoint}`);
	} else {
		console.log(`  command=${summary.command}`);
	}
	console.log(`  dryRun=${summary.dryRun}`);
	console.log(`  resumed=${summary.resumed}`);
	console.log(`  startOffset=${summary.startOffset}`);
	console.log(`  endOffset=${summary.endOffset}`);
	console.log(`  sourceBytes=${summary.sourceBytes}`);
	console.log(`  processed=${summary.processed}`);
	console.log(`  sent=${summary.sent}`);
	console.log(`  duplicates=${summary.duplicates}`);
	console.log(`  skippedEmpty=${summary.skippedEmpty}`);
	console.log(`  parseErrors=${summary.parseErrors}`);
	console.log(`  postErrors=${summary.postErrors}`);
	console.log(`  stoppedEarly=${summary.stoppedEarly}`);
	console.log(`  stopReason=${summary.stopReason || ''}`);
	console.log(`  offsetFile=${summary.offsetFile}`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!existsSync(options.source)) {
		throw new Error(`source file not found: ${options.source}`);
	}

	const sourceBytes = statSync(options.source).size;
	const buffer = readFileSync(options.source);
	const endpoint = options.mode === 'ingress' ? `${options.origin}${options.path}` : null;

	let startOffset = 0;
	if (options.resume) {
		startOffset = options.fromStart ? 0 : loadOffset(options.offsetFile);
	}
	if (startOffset > buffer.length) {
		console.warn(
			`[state-plane-replay] Offset ${startOffset} exceeds source size ${buffer.length}; resetting to 0`
		);
		startOffset = 0;
	}

	let cursor = startOffset;
	let processed = 0;
	let sent = 0;
	let duplicates = 0;
	let skippedEmpty = 0;
	let parseErrors = 0;
	let postErrors = 0;
	let stoppedEarly = false;
	let stopReason = null;
	let savesSinceLastWrite = 0;

	while (cursor < buffer.length && processed < options.maxEvents) {
		const newlineIndex = buffer.indexOf(0x0a, cursor);
		if (newlineIndex < 0) {
			break;
		}

		const line = buffer.subarray(cursor, newlineIndex).toString('utf8');
		const nextCursor = newlineIndex + 1;
		processed += 1;

		if (!line.trim()) {
			skippedEmpty += 1;
			cursor = nextCursor;
			continue;
		}

		let record;
		try {
			record = JSON.parse(line);
		} catch (error) {
			parseErrors += 1;
			cursor = nextCursor;
			const message = error instanceof Error ? error.message : String(error);
			if (options.strict) {
				stoppedEarly = true;
				stopReason = `parse_error: ${message}`;
				break;
			}
			if (parseErrors + postErrors >= options.maxErrors) {
				stoppedEarly = true;
				stopReason = `max_errors_reached (${options.maxErrors})`;
				break;
			}
			continue;
		}

		if (!options.dryRun) {
			const body = JSON.stringify(record);
			try {
				const response =
					options.mode === 'ingress'
						? await postJson(endpoint, body, buildHeaders(body, options), options.timeoutMs)
						: runCommand(options.command, body, options.timeoutMs);
				if (!response.ok) {
					postErrors += 1;
					if (options.strict) {
						stoppedEarly = true;
						stopReason =
							options.mode === 'ingress'
								? `post_error_http_${response.status}`
								: `command_error_exit_${response.status}`;
						break;
					}
					if (parseErrors + postErrors >= options.maxErrors) {
						stoppedEarly = true;
						stopReason = `max_errors_reached (${options.maxErrors})`;
						break;
					}
				} else {
					if (options.mode === 'ingress' && response.json?.duplicate === true) {
						duplicates += 1;
					} else {
						sent += 1;
					}
				}
			} catch (error) {
				postErrors += 1;
				const message = error instanceof Error ? error.message : String(error);
				if (options.strict) {
					stoppedEarly = true;
					stopReason = `post_exception: ${message}`;
					break;
				}
				if (parseErrors + postErrors >= options.maxErrors) {
					stoppedEarly = true;
					stopReason = `max_errors_reached (${options.maxErrors})`;
					break;
				}
			}
		}

		cursor = nextCursor;
		savesSinceLastWrite += 1;
		if (!options.dryRun && options.resume && savesSinceLastWrite >= options.saveEvery) {
			saveOffset(options.offsetFile, cursor);
			savesSinceLastWrite = 0;
		}
	}

	if (!options.dryRun && options.resume) {
		saveOffset(options.offsetFile, cursor);
	}

	if (!stoppedEarly && processed >= options.maxEvents) {
		stoppedEarly = true;
		stopReason = `max_events_reached (${options.maxEvents})`;
	}

	const summary = {
		mode: options.mode,
		source: options.source,
		endpoint,
		command: options.mode === 'command' ? options.command : null,
		dryRun: options.dryRun,
		resumed: options.resume,
		startOffset,
		endOffset: cursor,
		sourceBytes,
		processed,
		sent,
		duplicates,
		skippedEmpty,
		parseErrors,
		postErrors,
		stoppedEarly,
		stopReason,
		offsetFile: options.offsetFile
	};

	printSummary(summary, options.json);

	const failed = parseErrors + postErrors > 0;
	if (failed && options.strict) {
		process.exit(1);
	}
	if (failed && !options.strict && options.maxErrors <= parseErrors + postErrors) {
		process.exit(1);
	}
}

try {
	await main();
} catch (error) {
	console.error('[state-plane-replay] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
