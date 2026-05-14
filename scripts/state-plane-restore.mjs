#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

const DERIVED_TABLES = new Set([
	'state_user_meta',
	'state_user_username',
	'state_user_handle'
]);

const EPHEMERAL_AND_FORENSIC_TABLES = new Set([
	'state_session',
	'state_backend_instance_lease',
	'state_socket_lease',
	'state_presence_lease',
	'state_webhook_delivery',
	'ingested_event'
]);

const CONTENT_TABLES = new Set([
	'state_message',
	'state_offline_message',
	'state_reaction',
	'state_whiteboard',
	'state_album_item'
]);

const RESTORE_MAPPING = {
	state_user: ['user', 'update'],
	state_user_encryption_key: ['encryption_key', 'upsert_user_encryption_key'],
	state_channel: ['channel', 'update_settings'],
	state_channel_member: ['channel_member', 'add_member'],
	state_role_definition: ['rbac', 'upsert_role_definition'],
	state_rbac_assignment: ['rbac', 'assign_role'],
	state_ban: ['ban', 'ban'],
	state_mute: ['mute', 'mute'],
	state_deafen: ['deafen', 'deafen'],
	state_relay: ['relay', 'upsert_relay'],
	state_dictionary_entry: ['dictionary', 'upsert_entry'],
	state_app_setting: ['app_setting', 'upsert_app_setting'],
	state_emoji_role_rule: ['emoji_role_rule', 'upsert_rule'],
	state_emote: ['emote', 'upsert'],
	state_album: ['album', 'upsert_album'],
	state_album_item: ['album_item', 'upsert_item'],
	state_webhook: ['webhook', 'upsert_webhook'],
	state_user_settings: ['settings', 'upsert_user_settings'],
	state_theme_preferences: ['theme', 'upsert_theme_preferences'],
	state_layout_preferences: ['layout', 'upsert_layout'],
	state_guest_code: ['guest_code', 'upsert_code'],
	state_payment_intent: ['payment', 'upsert_intent'],
	state_payment_event: ['payment', 'append_event'],
	state_payment_account_link: ['payment', 'upsert_account_link'],
	state_payment_user_block: ['payment', 'upsert_user_block'],
	state_payment_policy: ['payment', 'upsert_policy'],
	state_manual_settlement: ['payment', 'upsert_manual_settlement'],
	state_message: ['message', 'create'],
	state_offline_message: ['offline_message', 'create'],
	state_reaction: ['reaction', 'add'],
	state_whiteboard: ['whiteboard', 'upsert_board']
};

function usage() {
	console.log(`Usage: node scripts/state-plane-restore.mjs --backup-dir <path> [options]

Restores a Wabi state-plane backup through the STDB ingest reducer.

Options:
  --backup-dir <path>    Backup directory containing manifest.json (required)
  --profile <continuity|full-emergency>
                         Expected backup profile (default: manifest profile)
  --data-dir <path>      Wabi DATA_DIR on host (default: ./data)
  --uploads-dir <path>   Uploads directory on host (default: ./uploads)
  --plugins-dir <path>   Plugin package directory on host (default: ./plugins)
  --helper <path>        STDB HTTP helper (default: backend/scripts/state-plane-stdb-http.mjs)
  --server <url|name>    STDB server (default: WABI_STDB_BRIDGE_SERVER or local)
  --database <name>      STDB database (default: WABI_STDB_BRIDGE_DATABASE; required)
  --token <jwt>          STDB auth token (default: WABI_STDB_AUTH_TOKEN)
  --anonymous            Allow anonymous STDB identity if no token is provided
  --no-anonymous         Disable anonymous STDB identity
  --timeout-ms <n>       STDB request timeout (default: WABI_STDB_BRIDGE_TIMEOUT_MS or 10000)
  --restore-files        Restore filesystem sidecars (.env, plugin state, uploads)
  --overwrite-files      Allow overwriting existing restored filesystem targets
  --skip-logical         Restore files only; do not replay table rows
  --dry-run              Validate and print actions without writing/calling reducers
  --previous-ingest-secret <secret>
                         Previous WABI_STDB_INGEST_SECRET for key rotation
  --i-understand-this-restores-content
                         Required when restoring full-emergency logical content
  --json                 Emit final summary as JSON
  -h, --help             Show help
`);
}

function parsePositiveInt(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeBool(value, fallback) {
	if (value == null || String(value).trim() === '') return fallback;
	const raw = String(value).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
	if (['0', 'false', 'no', 'off'].includes(raw)) return false;
	return fallback;
}

function parseArgs(argv) {
	const options = {
		backupDir: null,
		profile: null,
		dataDir: resolve(process.cwd(), 'data'),
		uploadsDir: resolve(process.cwd(), 'uploads'),
		pluginsDir: resolve(process.cwd(), 'plugins'),
		helper: resolve(process.cwd(), 'backend/scripts/state-plane-stdb-http.mjs'),
		server: process.env.WABI_STDB_BRIDGE_SERVER || 'local',
		database: process.env.WABI_STDB_BRIDGE_DATABASE || '',
		token: process.env.WABI_STDB_AUTH_TOKEN || '',
		anonymous: normalizeBool(process.env.WABI_STDB_ANONYMOUS, process.env.NODE_ENV !== 'production'),
		timeoutMs: parsePositiveInt(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS, 10000, 100, 30000),
		restoreFiles: false,
		overwriteFiles: false,
		skipLogical: false,
		dryRun: false,
		understandsContent: false,
		previousIngestSecret: '',
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
		if (arg === '--restore-files') {
			options.restoreFiles = true;
			continue;
		}
		if (arg === '--overwrite-files') {
			options.overwriteFiles = true;
			continue;
		}
		if (arg === '--skip-logical') {
			options.skipLogical = true;
			continue;
		}
		if (arg === '--dry-run') {
			options.dryRun = true;
			continue;
		}
		if (arg === '--i-understand-this-restores-content') {
			options.understandsContent = true;
			continue;
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if ([
			'--backup-dir',
			'--profile',
			'--data-dir',
			'--uploads-dir',
			'--plugins-dir',
			'--helper',
			'--server',
			'--database',
			'--token',
			'--timeout-ms',
			'--previous-ingest-secret'
		].includes(arg)) {
			i += 1;
			if (i >= argv.length) throw new Error(`${arg} requires a value`);
			const value = argv[i];
			if (arg === '--backup-dir') options.backupDir = resolve(process.cwd(), value);
			if (arg === '--profile') options.profile = String(value || '').trim();
			if (arg === '--data-dir') options.dataDir = resolve(process.cwd(), value);
			if (arg === '--uploads-dir') options.uploadsDir = resolve(process.cwd(), value);
			if (arg === '--plugins-dir') options.pluginsDir = resolve(process.cwd(), value);
			if (arg === '--helper') options.helper = resolve(process.cwd(), value);
			if (arg === '--server') options.server = String(value || '').trim();
			if (arg === '--database') options.database = String(value || '').trim();
			if (arg === '--token') options.token = String(value || '').trim();
			if (arg === '--timeout-ms') options.timeoutMs = parsePositiveInt(value, 10000, 100, 30000);
			if (arg === '--previous-ingest-secret') options.previousIngestSecret = String(value || '');
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!options.backupDir) throw new Error('--backup-dir is required');
	if (!options.database && !options.skipLogical) {
		throw new Error('--database is required for logical restore (or set WABI_STDB_BRIDGE_DATABASE)');
	}
	if (!existsSync(options.helper) && !options.skipLogical) {
		throw new Error(`STDB helper not found: ${options.helper}`);
	}
	return options;
}

function sha256Text(text) {
	return createHash('sha256').update(text).digest('hex');
}

function sha256File(path) {
	const hash = createHash('sha256');
	hash.update(readFileSync(path));
	return hash.digest('hex');
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function contentTablesInManifest(manifest) {
	return [...new Set((manifest.tables || [])
		.map((entry) => entry?.table)
		.filter((table) => CONTENT_TABLES.has(table)))].sort();
}

function enforceContentRestoreGate(manifest, profile, options) {
	const contentTables = contentTablesInManifest(manifest);
	if (contentTables.length === 0 || options.skipLogical) return;
	if (profile !== 'full-emergency') {
		throw new Error(`Content tables are not allowed in a ${profile} restore: ${contentTables.join(', ')}`);
	}
	if (!options.understandsContent) {
		throw new Error(`Restoring content tables requires --i-understand-this-restores-content: ${contentTables.join(', ')}`);
	}
}

function verifyManifestFile(backupDir, entry) {
	if (!entry?.path || !entry?.sha256) return;
	const path = resolve(backupDir, entry.path);
	if (!existsSync(path)) throw new Error(`Missing backup file: ${path}`);
	const actual = sha256File(path);
	if (actual !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.path}`);
}

function rowPayload(row) {
	let parsedRowJson = null;
	if (typeof row?.row_json === 'string' && row.row_json.trim()) {
		try {
			parsedRowJson = JSON.parse(row.row_json);
		} catch {
			parsedRowJson = null;
		}
	}
	return {
		row: parsedRowJson && typeof parsedRowJson === 'object' && !Array.isArray(parsedRowJson)
			? parsedRowJson
			: { ...row }
	};
}

function buildEvent(table, row, ingestAuthKeyHash) {
	const mapping = RESTORE_MAPPING[table];
	if (!mapping) return null;
	const [entity, operation] = mapping;
	const payload = rowPayload(row);
	const event = {
		eventId: `restore_${table}_${sha256Text(JSON.stringify(payload)).slice(0, 32)}`,
		timestamp: Date.now(),
		entity,
		operation,
		payload
	};
	if (ingestAuthKeyHash) event.authKey = ingestAuthKeyHash;
	return event;
}

function callReducer(reducer, argsJson, options) {
	const args = [
		options.helper,
		'call',
		'--server',
		options.server,
		'--database',
		options.database,
		'--timeout-ms',
		String(options.timeoutMs),
		'--reducer',
		reducer,
		'--args-json',
		argsJson,
		'--json'
	];
	if (options.token) {
		args.push('--token', options.token);
	} else if (options.anonymous) {
		args.push('--anonymous');
	} else {
		args.push('--no-anonymous');
	}
	const result = spawnSync(process.execPath, args, {
		encoding: 'utf8',
		maxBuffer: 8 * 1024 * 1024,
		timeout: options.timeoutMs + 5000
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout || `Reducer ${reducer} failed`).trim());
	}
	const parsed = JSON.parse(result.stdout);
	if (!parsed.ok) {
		throw new Error(`Reducer ${reducer} failed: status=${parsed.status} body=${parsed.text || parsed.statusText}`);
	}
	return parsed;
}

function restoreLogicalTables(manifest, options) {
	const secret = process.env.WABI_STDB_INGEST_SECRET || '';
	const ingestAuthKeyHash = secret ? sha256Text(secret) : null;
	let restoredRows = 0;
	let skippedRows = 0;
	const skippedTables = new Map();

	if (secret && !options.dryRun) {
		const previousHash = options.previousIngestSecret ? sha256Text(options.previousIngestSecret) : null;
		try {
			callReducer('set_ingest_key', JSON.stringify([ingestAuthKeyHash, previousHash]), options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (previousHash) {
				throw new Error(`set_ingest_key failed before restore: ${message}`);
			}
			console.warn(`[state-plane-restore] set_ingest_key preflight failed; continuing in case the existing key already matches: ${message}`);
		}
	}

	for (const tableEntry of manifest.tables || []) {
		const table = tableEntry.table;
		verifyManifestFile(options.backupDir, tableEntry);
		if (DERIVED_TABLES.has(table) || EPHEMERAL_AND_FORENSIC_TABLES.has(table)) {
			const tableJson = readJson(join(options.backupDir, tableEntry.path));
			const count = Array.isArray(tableJson.rows) ? tableJson.rows.length : 0;
			skippedRows += count;
			skippedTables.set(table, (skippedTables.get(table) || 0) + count);
			continue;
		}
		const tableJson = readJson(join(options.backupDir, tableEntry.path));
		const rows = Array.isArray(tableJson.rows) ? tableJson.rows : [];
		for (const row of rows) {
			const event = buildEvent(table, row, ingestAuthKeyHash);
			if (!event) {
				skippedRows += 1;
				skippedTables.set(table, (skippedTables.get(table) || 0) + 1);
				continue;
			}
			if (!options.dryRun) {
				callReducer('ingest_wabi_event', JSON.stringify([JSON.stringify(event)]), options);
			}
			restoredRows += 1;
		}
	}

	return {
		restoredRows,
		skippedRows,
		skippedTables: Object.fromEntries(skippedTables)
	};
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
}

function copyBackupPath(source, destination, options) {
	if (!existsSync(source)) return false;
	if (existsSync(destination) && !options.overwriteFiles) {
		throw new Error(`Refusing to overwrite ${destination}; pass --overwrite-files`);
	}
	if (options.dryRun) return true;
	ensureDir(dirname(destination));
	const stat = statSync(source);
	if (stat.isDirectory()) {
		cpSync(source, destination, { recursive: true, force: true, dereference: false });
	} else {
		copyFileSync(source, destination);
	}
	return true;
}

function restoreFilesystem(options, profile) {
	const root = join(options.backupDir, 'filesystem');
	if (!existsSync(root)) return 0;
	let restored = 0;
	if (copyBackupPath(join(root, '.env'), resolve(process.cwd(), '.env'), options)) restored += 1;
	if (profile === 'full-emergency') {
		if (copyBackupPath(join(root, 'data'), options.dataDir, options)) restored += 1;
	} else {
		if (copyBackupPath(join(root, 'data', '.wabi-auto-secrets'), join(options.dataDir, '.wabi-auto-secrets'), options)) restored += 1;
		if (copyBackupPath(join(root, 'data', 'spacetimedb-config'), join(options.dataDir, 'spacetimedb-config'), options)) restored += 1;
		if (copyBackupPath(join(root, 'data', 'stdb-publisher-config'), join(options.dataDir, 'stdb-publisher-config'), options)) restored += 1;
		if (copyBackupPath(join(root, 'data', '.plugin-storage'), join(options.dataDir, '.plugin-storage'), options)) restored += 1;
	}
	if (copyBackupPath(join(root, 'plugins'), options.pluginsDir, options)) restored += 1;
	if (copyBackupPath(join(root, 'uploads'), options.uploadsDir, options)) restored += 1;
	return restored;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const manifestPath = join(options.backupDir, 'manifest.json');
	if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
	const manifest = readJson(manifestPath);
	const profile = options.profile || manifest.profile || 'continuity';
	if (options.profile && options.profile !== manifest.profile) {
		throw new Error(`Profile mismatch: requested ${options.profile}, manifest is ${manifest.profile}`);
	}
	if (profile === 'full-emergency' && !options.understandsContent) {
		throw new Error('Restoring full-emergency requires --i-understand-this-restores-content');
	}
	enforceContentRestoreGate(manifest, profile, options);

	const fileCount = options.restoreFiles ? restoreFilesystem(options, profile) : 0;
	const logical = options.skipLogical
		? { restoredRows: 0, skippedRows: 0, skippedTables: {} }
		: restoreLogicalTables(manifest, options);

	const summary = {
		backupDir: options.backupDir,
		profile,
		dryRun: options.dryRun,
		filesRestored: fileCount,
		...logical
	};
	if (options.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log('[state-plane-restore] Restore summary');
	console.log(`  profile=${summary.profile}`);
	console.log(`  backupDir=${summary.backupDir}`);
	console.log(`  dryRun=${summary.dryRun}`);
	console.log(`  filesRestored=${summary.filesRestored}`);
	console.log(`  restoredRows=${summary.restoredRows}`);
	console.log(`  skippedRows=${summary.skippedRows}`);
	if (Object.keys(summary.skippedTables).length > 0) {
		console.log(`  skippedTables=${JSON.stringify(summary.skippedTables)}`);
	}
}

try {
	main();
} catch (error) {
	console.error('[state-plane-restore] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
