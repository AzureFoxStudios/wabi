#!/usr/bin/env node

import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';

function usage() {
	console.log(`Usage: node scripts/state-plane-bridge-check.mjs [options]

Validates STATE_SHADOW_COMMAND (or explicit --command) using a synthetic event payload.

Options:
  --command <cmd>         Bridge command to execute (default: env STATE_SHADOW_COMMAND)
  --timeout-ms <n>        Command timeout (default: env STATE_SHADOW_COMMAND_TIMEOUT_MS or 10000)
  --entity <name>         Synthetic event entity (default: system)
  --operation <name>      Synthetic event operation (default: bridge_check)
  --json                  Emit JSON summary
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
	const options = {
		command: (process.env.STATE_SHADOW_COMMAND || '').trim(),
		timeoutMs: parsePositiveInt(process.env.STATE_SHADOW_COMMAND_TIMEOUT_MS, 10000, 100, 300000),
		entity: 'system',
		operation: 'bridge_check',
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
		if (arg === '--command') {
			i += 1;
			if (i >= argv.length) throw new Error('--command requires a value');
			options.command = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--timeout-ms') {
			i += 1;
			if (i >= argv.length) throw new Error('--timeout-ms requires a value');
			options.timeoutMs = parsePositiveInt(argv[i], 10000, 100, 300000);
			continue;
		}
		if (arg === '--entity') {
			i += 1;
			if (i >= argv.length) throw new Error('--entity requires a value');
			options.entity = String(argv[i] || '').trim() || 'system';
			continue;
		}
		if (arg === '--operation') {
			i += 1;
			if (i >= argv.length) throw new Error('--operation requires a value');
			options.operation = String(argv[i] || '').trim() || 'bridge_check';
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.command) throw new Error('Missing command (set STATE_SHADOW_COMMAND or pass --command)');
	return options;
}

function printResult(result, asJson) {
	if (asJson) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log('[state-plane-bridge-check] Result');
	console.log(`  command=${result.command}`);
	console.log(`  timeoutMs=${result.timeoutMs}`);
	console.log(`  eventId=${result.eventId}`);
	console.log(`  ok=${result.ok}`);
	console.log(`  exitCode=${result.exitCode}`);
	console.log(`  durationMs=${result.durationMs}`);
	if (result.stdout) console.log(`  stdout=${result.stdout}`);
	if (result.stderr) console.log(`  stderr=${result.stderr}`);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const eventId = `bridge_check_${Date.now()}_${randomBytes(6).toString('hex')}`;
	const event = {
		eventId,
		timestamp: Date.now(),
		entity: options.entity,
		operation: options.operation,
		payload: {
			source: 'scripts/state-plane-bridge-check.mjs',
			checkAt: Date.now()
		}
	};
	const body = `${JSON.stringify(event)}\n`;
	const startedAt = Date.now();
	const execution = spawnSync(options.command, {
		shell: true,
		input: body,
		encoding: 'utf8',
		timeout: options.timeoutMs,
		maxBuffer: 8 * 1024 * 1024
	});
	const durationMs = Date.now() - startedAt;

	const exitCode = typeof execution.status === 'number' ? execution.status : -1;
	const ok = !execution.error && !execution.signal && exitCode === 0;
	const result = {
		command: options.command,
		timeoutMs: options.timeoutMs,
		eventId,
		ok,
		exitCode,
		durationMs,
		stdout: (execution.stdout || '').toString().trim(),
		stderr: (execution.stderr || '').toString().trim(),
		signal: execution.signal || null,
		error: execution.error ? execution.error.message : null
	};

	printResult(result, options.json);

	if (!ok) {
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error('[state-plane-bridge-check] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
