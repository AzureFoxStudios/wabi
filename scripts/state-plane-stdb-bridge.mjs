#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

function usage() {
	console.log(`Usage: node scripts/state-plane-stdb-bridge.mjs [options]

Reads one state-plane outbox event JSON object from stdin and bridges it to SpacetimeDB.
Designed for STATE_SHADOW_SINK=command (one invocation per event).

Options:
  --mode <spacetime-call|stdout|file>   Bridge mode (default: spacetime-call)
  --binary <path>                       Spacetime CLI binary (default: env WABI_STDB_BRIDGE_BINARY or "spacetime")
  --server <name|url>                   Spacetime server (default: env WABI_STDB_BRIDGE_SERVER or "local")
  --database <name>                     Spacetime database name (required for spacetime-call)
  --reducer <name>                      Default reducer (default: ingest_wabi_event)
  --map-file <path>                     Optional JSON mapping file for entity/operation routing
  --output-file <path>                  Output file path for mode=file
  --timeout-ms <n>                      CLI timeout in ms (default: 10000)
  --anonymous                           Add --anonymous (default: true)
  --no-anonymous                        Do not add --anonymous
  --yes                                 Add --yes (default: true)
  --no-yes                              Do not add --yes
  --no-config                           Add --no-config (default: true)
  --use-config                          Do not add --no-config
  --dry-run                             Parse/map only; do not call CLI
  --json                                Emit result as JSON
  -h, --help                            Show help

Map file format (JSON):
{
  "message.create": {
    "reducer": "ingest_message_create",
    "argsTemplate": ["{{payload.channelId}}", "{{payload.messageId}}", "{{payload.senderId}}"]
  },
  "channel.*": {
    "reducer": "ingest_channel_event",
    "argsTemplate": ["{{json}}"]
  },
  "*.*": {
    "reducer": "ingest_wabi_event",
    "argsTemplate": ["{{json}}"]
  }
}
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
	const options = {
		mode: (process.env.WABI_STDB_BRIDGE_MODE || 'spacetime-call').trim().toLowerCase(),
		binary: (process.env.WABI_STDB_BRIDGE_BINARY || 'spacetime').trim(),
		server: (process.env.WABI_STDB_BRIDGE_SERVER || 'local').trim(),
		database: (process.env.WABI_STDB_BRIDGE_DATABASE || '').trim(),
		reducer: (process.env.WABI_STDB_BRIDGE_REDUCER || 'ingest_wabi_event').trim(),
		mapFile: (process.env.WABI_STDB_BRIDGE_MAP_FILE || '').trim(),
		outputFile: (process.env.WABI_STDB_BRIDGE_OUTPUT_FILE || '').trim(),
		timeoutMs: parsePositiveInt(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS, 10000, 100, 300000),
		anonymous: !['0', 'false', 'no', 'off'].includes((process.env.WABI_STDB_BRIDGE_ANONYMOUS || 'true').trim().toLowerCase()),
		yes: !['0', 'false', 'no', 'off'].includes((process.env.WABI_STDB_BRIDGE_YES || 'true').trim().toLowerCase()),
		noConfig: !['0', 'false', 'no', 'off'].includes((process.env.WABI_STDB_BRIDGE_NO_CONFIG || 'true').trim().toLowerCase()),
		dryRun: false,
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
		if (arg === '--yes') {
			options.yes = true;
			continue;
		}
		if (arg === '--no-yes') {
			options.yes = false;
			continue;
		}
		if (arg === '--no-config') {
			options.noConfig = true;
			continue;
		}
		if (arg === '--use-config') {
			options.noConfig = false;
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
		if (arg === '--binary') {
			i += 1;
			if (i >= argv.length) throw new Error('--binary requires a value');
			options.binary = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--server') {
			i += 1;
			if (i >= argv.length) throw new Error('--server requires a value');
			options.server = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--database') {
			i += 1;
			if (i >= argv.length) throw new Error('--database requires a value');
			options.database = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--reducer') {
			i += 1;
			if (i >= argv.length) throw new Error('--reducer requires a value');
			options.reducer = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--map-file') {
			i += 1;
			if (i >= argv.length) throw new Error('--map-file requires a value');
			options.mapFile = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--output-file') {
			i += 1;
			if (i >= argv.length) throw new Error('--output-file requires a value');
			options.outputFile = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--timeout-ms') {
			i += 1;
			if (i >= argv.length) throw new Error('--timeout-ms requires a value');
			options.timeoutMs = parsePositiveInt(argv[i], 10000, 100, 300000);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!['spacetime-call', 'stdout', 'file'].includes(options.mode)) {
		throw new Error(`Unsupported mode: ${options.mode}`);
	}
	if (!options.binary) throw new Error('binary is required');
	if (!options.reducer) throw new Error('reducer is required');
	if (options.mode === 'spacetime-call' && !options.database) {
		throw new Error('database is required in spacetime-call mode');
	}
	if (options.mode === 'file' && !options.outputFile) {
		throw new Error('output-file is required in file mode');
	}

	return options;
}

function getPathValue(root, path) {
	if (!path) return undefined;
	const segments = path.split('.').filter(Boolean);
	let cur = root;
	for (const segment of segments) {
		if (cur == null || typeof cur !== 'object' || !(segment in cur)) {
			return undefined;
		}
		cur = cur[segment];
	}
	return cur;
}

function applyTemplate(template, context) {
	if (typeof template !== 'string') return '';
	return template.replace(/\{\{([^}]+)\}\}/g, (_match, expr) => {
		const key = String(expr || '').trim();
		if (!key) return '';
		if (key === 'json') return context.json;
		const value = getPathValue(context, key);
		if (value == null) return '';
		if (typeof value === 'string') return value;
		return JSON.stringify(value);
	});
}

function parseMapFile(path) {
	if (!path) return {};
	if (!existsSync(path)) {
		throw new Error(`map file not found: ${path}`);
	}
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('map file must be a JSON object');
	}
	return raw;
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function parseEventFromStdin(raw) {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		throw new Error('stdin is empty; expected one JSON event');
	}
	const event = JSON.parse(lines[0]);
	if (!event || typeof event !== 'object' || Array.isArray(event)) {
		throw new Error('event must be a JSON object');
	}
	const entity = String(event.entity || '').trim();
	const operation = String(event.operation || '').trim();
	if (!entity) throw new Error('event.entity is required');
	if (!operation) throw new Error('event.operation is required');
	return event;
}

function selectRule(map, event) {
	const entity = String(event.entity || '').trim();
	const operation = String(event.operation || '').trim();
	const keys = [
		`${entity}.${operation}`,
		`${entity}.*`,
		`*.${operation}`,
		'*.*'
	];
	for (const key of keys) {
		const value = map[key];
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		return value;
	}
	return null;
}

function resolveReducerCall(event, options, map) {
	const envelope = {
		...event,
		bridge: {
			version: 1,
			source: 'scripts/state-plane-stdb-bridge.mjs',
			processedAt: Date.now()
		}
	};
	const json = JSON.stringify(envelope);
	const rule = selectRule(map, envelope);
	const reducer = String(rule?.reducer || options.reducer).trim();
	if (!reducer) throw new Error('resolved reducer name is empty');

	const context = {
		...envelope,
		payload: envelope.payload || {},
		json
	};

	let args = [json];
	if (Array.isArray(rule?.argsTemplate) && rule.argsTemplate.length > 0) {
		args = rule.argsTemplate.map((entry) => applyTemplate(String(entry), context));
	}

	return {
		reducer,
		args,
		envelope,
		ruleMatched: Boolean(rule)
	};
}

function runSpacetimeCall(options, reducerCall) {
	const args = ['call'];
	if (options.server) {
		args.push('-s', options.server);
	}
	if (options.anonymous) args.push('--anonymous');
	if (options.yes) args.push('--yes');
	if (options.noConfig) args.push('--no-config');
	args.push(options.database, reducerCall.reducer, ...reducerCall.args);

	const startedAt = Date.now();
	const result = spawnSync(options.binary, args, {
		encoding: 'utf8',
		timeout: options.timeoutMs,
		maxBuffer: 8 * 1024 * 1024
	});
	const durationMs = Date.now() - startedAt;

	if (result.error) {
		throw new Error(`spacetime_call_error: ${result.error.message}`);
	}
	if (result.signal) {
		throw new Error(`spacetime_call_terminated signal=${result.signal}`);
	}
	if (typeof result.status === 'number' && result.status !== 0) {
		const stderr = (result.stderr || '').trim();
		const stdout = (result.stdout || '').trim();
		const detail = stderr || stdout || `status=${result.status}`;
		throw new Error(`spacetime_call_failed: ${detail}`);
	}

	return {
		durationMs,
		stdout: (result.stdout || '').trim(),
		stderr: (result.stderr || '').trim()
	};
}

function printResult(payload, asJson) {
	if (asJson) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log('[state-plane-stdb-bridge] Result');
	console.log(`  mode=${payload.mode}`);
	console.log(`  reducer=${payload.reducer}`);
	console.log(`  argsCount=${payload.argsCount}`);
	console.log(`  eventId=${payload.eventId || ''}`);
	console.log(`  entity=${payload.entity}`);
	console.log(`  operation=${payload.operation}`);
	console.log(`  ruleMatched=${payload.ruleMatched}`);
	console.log(`  dryRun=${payload.dryRun}`);
	if (payload.durationMs != null) {
		console.log(`  durationMs=${payload.durationMs}`);
	}
	if (payload.outputFile) {
		console.log(`  outputFile=${payload.outputFile}`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const map = parseMapFile(options.mapFile);
	const raw = await readStdin();
	const event = parseEventFromStdin(raw);
	const reducerCall = resolveReducerCall(event, options, map);

	let durationMs = null;
	if (!options.dryRun) {
		if (options.mode === 'spacetime-call') {
			const run = runSpacetimeCall(options, reducerCall);
			durationMs = run.durationMs;
		} else if (options.mode === 'stdout') {
			process.stdout.write(`${JSON.stringify(reducerCall.envelope)}\n`);
		} else if (options.mode === 'file') {
			appendFileSync(
				options.outputFile,
				`${JSON.stringify({
					reducer: reducerCall.reducer,
					args: reducerCall.args,
					event: reducerCall.envelope,
					recordedAt: Date.now()
				})}\n`
			);
		}
	}

	const result = {
		mode: options.mode,
		reducer: reducerCall.reducer,
		argsCount: reducerCall.args.length,
		eventId: reducerCall.envelope.eventId || null,
		entity: String(reducerCall.envelope.entity || ''),
		operation: String(reducerCall.envelope.operation || ''),
		ruleMatched: reducerCall.ruleMatched,
		dryRun: options.dryRun,
		durationMs,
		outputFile: options.mode === 'file' ? options.outputFile : null
	};
	printResult(result, options.json);
}

try {
	await main();
} catch (error) {
	console.error('[state-plane-stdb-bridge] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
}
