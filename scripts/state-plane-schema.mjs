#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

function usage() {
	console.log(`Usage: node scripts/state-plane-schema.mjs <command> [options]

Commands:
  status                  Show schema contract status
  reconcile               Reconcile schema file against required version
  set                     Set schema file to an explicit version

Options:
  --data-dir <path>       DATA_DIR location (default: ./data)
  --required-version <n>  Required schema version (default: env/1)
  --auto-apply <bool>     Auto-apply behavior for reconcile (default: env/true)
  --version <n>           Target version for set command
  --reason <text>         History reason for set/reconcile writes
  --max-history <n>       Max history entries retained (default: 200)
  --allow-downgrade       Allow set to lower schema version
  --json                  Emit JSON output
  -h, --help              Show help
`);
}

function parseBool(value, fallback) {
	if (typeof value !== 'string') return fallback;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
}

function parseIntBounded(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	const rounded = Math.floor(parsed);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function parseArgs(argv) {
	const options = {
		command: 'status',
		dataDir: resolve(process.cwd(), process.env.WABI_DATA_DIR || 'data'),
		requiredVersion: parseIntBounded(process.env.STATE_PLANE_SCHEMA_VERSION, 1, 1, 1000),
		autoApply: parseBool(process.env.STATE_PLANE_SCHEMA_AUTO_APPLY, true),
		targetVersion: null,
		reason: '',
		maxHistory: 200,
		allowDowngrade: false,
		json: false
	};

	let commandSet = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			usage();
			process.exit(0);
		}
		if (arg === '--allow-downgrade') {
			options.allowDowngrade = true;
			continue;
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if (arg === '--data-dir') {
			i += 1;
			if (i >= argv.length) throw new Error('--data-dir requires a value');
			options.dataDir = resolve(process.cwd(), argv[i]);
			continue;
		}
		if (arg === '--required-version') {
			i += 1;
			if (i >= argv.length) throw new Error('--required-version requires a value');
			options.requiredVersion = parseIntBounded(argv[i], 1, 1, 1000);
			continue;
		}
		if (arg === '--auto-apply') {
			i += 1;
			if (i >= argv.length) throw new Error('--auto-apply requires a value');
			options.autoApply = parseBool(argv[i], true);
			continue;
		}
		if (arg === '--version') {
			i += 1;
			if (i >= argv.length) throw new Error('--version requires a value');
			options.targetVersion = parseIntBounded(argv[i], 1, 1, 1000);
			continue;
		}
		if (arg === '--reason') {
			i += 1;
			if (i >= argv.length) throw new Error('--reason requires a value');
			options.reason = String(argv[i] || '').trim();
			continue;
		}
		if (arg === '--max-history') {
			i += 1;
			if (i >= argv.length) throw new Error('--max-history requires a value');
			options.maxHistory = parseIntBounded(argv[i], 200, 1, 10000);
			continue;
		}
		if (!arg.startsWith('-') && !commandSet) {
			const lowered = arg.toLowerCase();
			if (!['status', 'reconcile', 'set'].includes(lowered)) {
				throw new Error(`Unknown command: ${arg}`);
			}
			options.command = lowered;
			commandSet = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function schemaPath(dataDir) {
	return join(dataDir, 'state-plane-schema-version.json');
}

function sanitizeHistory(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const entry of raw) {
		const version = Number(entry?.version);
		const appliedAt = Number(entry?.appliedAt);
		const reason = String(entry?.reason || '').trim();
		if (!Number.isFinite(version) || version < 1) continue;
		if (!Number.isFinite(appliedAt) || appliedAt <= 0) continue;
		if (!reason) continue;
		out.push({
			version: Math.floor(version),
			appliedAt: Math.floor(appliedAt),
			reason
		});
	}
	return out;
}

function loadSchemaFile(path) {
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	const version = Number(raw?.version);
	if (!Number.isFinite(version) || version < 1) {
		throw new Error(`Invalid schema version file: ${path}`);
	}
	const updatedAtRaw = Number(raw?.updatedAt);
	const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? Math.floor(updatedAtRaw) : null;
	const history = sanitizeHistory(raw?.history);
	return {
		version: Math.floor(version),
		updatedAt,
		history
	};
}

function writeSchemaFile(path, version, reason, existing, maxHistory) {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const now = Date.now();
	const history = [...(existing?.history || []), { version, appliedAt: now, reason }];
	const payload = {
		version,
		updatedAt: now,
		history: history.slice(-maxHistory)
	};
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
	return {
		version,
		updatedAt: now,
		history: payload.history
	};
}

function buildStatus(path, requiredVersion, autoApply, current, updated, action, reasonOverride = null) {
	const currentVersion = current?.version ?? null;
	let mismatch = false;
	let reason = reasonOverride;
	if (reason == null) {
		if (currentVersion == null) {
			mismatch = true;
			reason = 'schema_version_missing';
		} else if (currentVersion > requiredVersion) {
			mismatch = true;
			reason = `schema_downgrade_not_supported current=${currentVersion} required=${requiredVersion}`;
		} else if (currentVersion < requiredVersion) {
			mismatch = true;
			reason = `schema_upgrade_required current=${currentVersion} required=${requiredVersion}`;
		} else {
			mismatch = false;
			reason = null;
		}
	}
	return {
		path,
		requiredVersion,
		autoApply,
		currentVersion,
		mismatch,
		reason,
		updated,
		action,
		lastUpdatedAt: current?.updatedAt ?? null,
		historyLength: current?.history?.length ?? 0
	};
}

function printStatus(status, asJson) {
	if (asJson) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	console.log('[state-plane-schema] Status');
	console.log(`  path=${status.path}`);
	console.log(`  requiredVersion=${status.requiredVersion}`);
	console.log(`  currentVersion=${status.currentVersion == null ? 'null' : status.currentVersion}`);
	console.log(`  autoApply=${status.autoApply}`);
	console.log(`  mismatch=${status.mismatch}`);
	console.log(`  reason=${status.reason || ''}`);
	console.log(`  updated=${status.updated}`);
	console.log(`  action=${status.action}`);
	console.log(`  lastUpdatedAt=${status.lastUpdatedAt == null ? 'null' : status.lastUpdatedAt}`);
	console.log(`  historyLength=${status.historyLength}`);
}

function reconcile(options, path) {
	const current = loadSchemaFile(path);
	if (!current) {
		if (!options.autoApply) {
			return buildStatus(path, options.requiredVersion, options.autoApply, null, false, 'noop_missing_auto_apply_disabled');
		}
		const reason = options.reason || 'bootstrap';
		const next = writeSchemaFile(path, options.requiredVersion, reason, null, options.maxHistory);
		return buildStatus(path, options.requiredVersion, options.autoApply, next, true, 'bootstrap_applied');
	}

	if (current.version === options.requiredVersion) {
		return buildStatus(path, options.requiredVersion, options.autoApply, current, false, 'noop_already_current');
	}

	if (current.version > options.requiredVersion) {
		return buildStatus(
			path,
			options.requiredVersion,
			options.autoApply,
			current,
			false,
			'noop_downgrade_blocked',
			`schema_downgrade_not_supported current=${current.version} required=${options.requiredVersion}`
		);
	}

	if (!options.autoApply) {
		return buildStatus(
			path,
			options.requiredVersion,
			options.autoApply,
			current,
			false,
			'noop_upgrade_required_auto_apply_disabled',
			`schema_upgrade_required current=${current.version} required=${options.requiredVersion}`
		);
	}

	const reason = options.reason || `auto_upgrade_from_${current.version}`;
	const next = writeSchemaFile(path, options.requiredVersion, reason, current, options.maxHistory);
	return buildStatus(path, options.requiredVersion, options.autoApply, next, true, 'upgrade_applied');
}

function setVersion(options, path) {
	if (options.targetVersion == null) {
		throw new Error('set command requires --version <n>');
	}
	const current = loadSchemaFile(path);
	const currentVersion = current?.version ?? null;
	if (
		currentVersion != null &&
		options.targetVersion < currentVersion &&
		!options.allowDowngrade
	) {
		throw new Error(
			`Refusing to downgrade schema version from ${currentVersion} to ${options.targetVersion}. Re-run with --allow-downgrade if intentional.`
		);
	}
	const reason = options.reason || (currentVersion == null ? 'manual_set_bootstrap' : `manual_set_from_${currentVersion}`);
	const next = writeSchemaFile(path, options.targetVersion, reason, current, options.maxHistory);
	return buildStatus(path, options.requiredVersion, options.autoApply, next, true, 'manual_set_applied');
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const path = schemaPath(options.dataDir);

	let status;
	switch (options.command) {
		case 'status':
			status = buildStatus(path, options.requiredVersion, options.autoApply, loadSchemaFile(path), false, 'status');
			break;
		case 'reconcile':
			status = reconcile(options, path);
			break;
		case 'set':
			status = setVersion(options, path);
			break;
		default:
			throw new Error(`Unsupported command: ${options.command}`);
	}

	printStatus(status, options.json);
	if (status.mismatch && options.command === 'reconcile') {
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error('[state-plane-schema] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
