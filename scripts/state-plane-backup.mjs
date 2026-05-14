#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { spawnSync } from 'child_process';

const CONTINUITY_TABLES = [
	'state_user',
	'state_user_meta',
	'state_user_username',
	'state_user_handle',
	'state_user_encryption_key',
	'state_channel',
	'state_channel_member',
	'state_role_definition',
	'state_rbac_assignment',
	'state_ban',
	'state_mute',
	'state_deafen',
	'state_relay',
	'state_dictionary_entry',
	'state_app_setting',
	'state_emoji_role_rule',
	'state_emote',
	'state_album',
	'state_webhook',
	'state_user_settings',
	'state_theme_preferences',
	'state_layout_preferences',
	'state_guest_code'
];

const PAYMENT_TABLES = [
	'state_payment_intent',
	'state_payment_event',
	'state_payment_account_link',
	'state_payment_user_block',
	'state_payment_policy',
	'state_manual_settlement'
];

const CONTENT_TABLES = [
	'state_message',
	'state_offline_message',
	'state_reaction',
	'state_whiteboard',
	'state_album_item'
];

const EPHEMERAL_AND_FORENSIC_TABLES = [
	'state_session',
	'state_backend_instance_lease',
	'state_socket_lease',
	'state_presence_lease',
	'state_webhook_delivery',
	'ingested_event'
];

function usage() {
	console.log(`Usage: node scripts/state-plane-backup.mjs [options]

Creates a Wabi state-plane backup with an explicit privacy profile.

Options:
  --profile <continuity|full-emergency>
                         Backup profile (default: continuity)
  --backup-root <path>   Backup output root (default: ./backups)
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
  --include-payments     Include payment/legal tables in the logical dump
  --include-guest-codes  Include state_guest_code in continuity dump (default)
  --exclude-guest-codes  Exclude state_guest_code from continuity dump
  --skip-filesystem      Skip .env/data/uploads/plugins sidecars (test drills only)
  --i-understand-this-includes-content
                         Required for --profile full-emergency
  --json                 Emit final summary as JSON
  -h, --help             Show help

Continuity backups intentionally exclude messages, offline messages, reactions,
whiteboards, album items, sessions, mesh leases, webhook deliveries, ingested
events, and the state-plane outbox. Full emergency backups include content and
full filesystem state and must be treated as break-glass sensitive material.
`);
}

function parsePositiveInt(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseArgs(argv) {
	const options = {
		profile: 'continuity',
		backupRoot: resolve(process.cwd(), 'backups'),
		dataDir: resolve(process.cwd(), 'data'),
		uploadsDir: resolve(process.cwd(), 'uploads'),
		pluginsDir: resolve(process.cwd(), 'plugins'),
		helper: resolve(process.cwd(), 'backend/scripts/state-plane-stdb-http.mjs'),
		server: process.env.WABI_STDB_BRIDGE_SERVER || 'local',
		database: process.env.WABI_STDB_BRIDGE_DATABASE || '',
		token: process.env.WABI_STDB_AUTH_TOKEN || '',
		anonymous: normalizeBool(process.env.WABI_STDB_ANONYMOUS, process.env.NODE_ENV !== 'production'),
		timeoutMs: parsePositiveInt(process.env.WABI_STDB_BRIDGE_TIMEOUT_MS, 10000, 100, 30000),
		includePayments: false,
		includeGuestCodes: true,
		skipFilesystem: false,
		understandsContent: false,
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
		if (arg === '--include-payments') {
			options.includePayments = true;
			continue;
		}
		if (arg === '--include-guest-codes') {
			options.includeGuestCodes = true;
			continue;
		}
		if (arg === '--exclude-guest-codes') {
			options.includeGuestCodes = false;
			continue;
		}
		if (arg === '--skip-filesystem') {
			options.skipFilesystem = true;
			continue;
		}
		if (arg === '--i-understand-this-includes-content') {
			options.understandsContent = true;
			continue;
		}
		if (arg === '--json') {
			options.json = true;
			continue;
		}
		if ([
			'--profile',
			'--backup-root',
			'--data-dir',
			'--uploads-dir',
			'--plugins-dir',
			'--helper',
			'--server',
			'--database',
			'--token',
			'--timeout-ms'
		].includes(arg)) {
			i += 1;
			if (i >= argv.length) throw new Error(`${arg} requires a value`);
			const value = argv[i];
			if (arg === '--profile') options.profile = String(value || '').trim();
			if (arg === '--backup-root') options.backupRoot = resolve(process.cwd(), value);
			if (arg === '--data-dir') options.dataDir = resolve(process.cwd(), value);
			if (arg === '--uploads-dir') options.uploadsDir = resolve(process.cwd(), value);
			if (arg === '--plugins-dir') options.pluginsDir = resolve(process.cwd(), value);
			if (arg === '--helper') options.helper = resolve(process.cwd(), value);
			if (arg === '--server') options.server = String(value || '').trim();
			if (arg === '--database') options.database = String(value || '').trim();
			if (arg === '--token') options.token = String(value || '').trim();
			if (arg === '--timeout-ms') options.timeoutMs = parsePositiveInt(value, 10000, 100, 30000);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	if (!['continuity', 'full-emergency'].includes(options.profile)) {
		throw new Error('--profile must be continuity or full-emergency');
	}
	if (options.profile === 'full-emergency' && !options.understandsContent) {
		throw new Error('--profile full-emergency requires --i-understand-this-includes-content');
	}
	if (!options.database) {
		throw new Error('--database is required (or set WABI_STDB_BRIDGE_DATABASE)');
	}
	if (!existsSync(options.helper)) {
		throw new Error(`STDB helper not found: ${options.helper}`);
	}
	return options;
}

function normalizeBool(value, fallback) {
	if (value == null || String(value).trim() === '') return fallback;
	const raw = String(value).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
	if (['0', 'false', 'no', 'off'].includes(raw)) return false;
	return fallback;
}

function utcStamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function sha256File(path) {
	const hash = createHash('sha256');
	hash.update(readFileSync(path));
	return hash.digest('hex');
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeJsonFile(path, value) {
	ensureDir(dirname(path));
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function cpIfExists(source, destination, copiedFiles) {
	if (!existsSync(source)) return false;
	ensureDir(dirname(destination));
	const stat = statSync(source);
	if (stat.isDirectory()) {
		cpSync(source, destination, { recursive: true, force: true, dereference: false });
	} else {
		copyFileSync(source, destination);
	}
	copiedFiles.push({
		source,
		path: relative(process.cwd(), destination),
		sizeBytes: stat.isDirectory() ? null : stat.size,
		sha256: stat.isDirectory() ? null : sha256File(destination)
	});
	return true;
}

function decodeSqlRows(sqlResponse) {
	const elements = sqlResponse?.schema?.elements || [];
	const names = elements.map((entry, index) => entry?.name?.some || `col_${index}`);
	const rows = Array.isArray(sqlResponse?.rows) ? sqlResponse.rows : [];
	return rows.map((row) => {
		const out = {};
		for (let i = 0; i < names.length; i += 1) {
			out[names[i]] = normalizeCell(row?.[i]);
		}
		return out;
	});
}

function normalizeCell(value) {
	if (Array.isArray(value) && value.length === 1) return value[0];
	return value;
}

function runSql(table, options) {
	const args = [
		options.helper,
		'sql',
		'--server',
		options.server,
		'--database',
		options.database,
		'--timeout-ms',
		String(options.timeoutMs),
		'--query',
		`SELECT * FROM ${table}`,
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
		maxBuffer: 128 * 1024 * 1024,
		timeout: options.timeoutMs + 5000
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`SQL dump failed for ${table}: ${(result.stderr || result.stdout || '').trim()}`);
	}
	const parsed = JSON.parse(result.stdout);
	if (!parsed.ok) {
		throw new Error(`SQL dump failed for ${table}: status=${parsed.status} body=${parsed.text || parsed.statusText}`);
	}
	return {
		raw: parsed.json,
		rows: decodeSqlRows(parsed.json)
	};
}

function buildTableList(options) {
	const tables = CONTINUITY_TABLES.filter((table) => options.includeGuestCodes || table !== 'state_guest_code');
	if (options.includePayments || options.profile === 'full-emergency') tables.push(...PAYMENT_TABLES);
	if (options.profile === 'full-emergency') tables.push(...CONTENT_TABLES, ...EPHEMERAL_AND_FORENSIC_TABLES);
	return [...new Set(tables)];
}

function extractUploadRefsFromRows(rows) {
	const refs = new Set();
	const regex = /\/uploads\/([^"'\s?#\\]+)/g;
	for (const row of rows) {
		const text = JSON.stringify(row);
		let match;
		while ((match = regex.exec(text)) != null) {
			try {
				const decoded = decodeURIComponent(match[1]);
				const safeName = basename(decoded);
				if (safeName && safeName !== '.' && safeName !== '..' && !safeName.startsWith('.')) {
					refs.add(safeName);
				}
			} catch {
				const safeName = basename(match[1]);
				if (safeName && !safeName.startsWith('.')) refs.add(safeName);
			}
		}
	}
	return refs;
}

function copySelectiveUploads(uploadRefs, options, backupDir, copiedFiles) {
	const copied = [];
	for (const fileName of [...uploadRefs].sort()) {
		const source = resolve(options.uploadsDir, fileName);
		if (source !== options.uploadsDir && !source.startsWith(options.uploadsDir + sep)) continue;
		if (!existsSync(source) || !statSync(source).isFile()) continue;
		const destination = join(backupDir, 'filesystem', 'uploads', fileName);
		cpIfExists(source, destination, copiedFiles);
		copied.push(fileName);
	}
	return copied;
}

function copyContinuityFilesystem(options, backupDir, copiedFiles, uploadRefs) {
	cpIfExists(resolve(process.cwd(), '.env'), join(backupDir, 'filesystem', '.env'), copiedFiles);
	cpIfExists(join(options.dataDir, '.wabi-auto-secrets'), join(backupDir, 'filesystem', 'data', '.wabi-auto-secrets'), copiedFiles);
	cpIfExists(join(options.dataDir, 'spacetimedb-config'), join(backupDir, 'filesystem', 'data', 'spacetimedb-config'), copiedFiles);
	cpIfExists(join(options.dataDir, 'stdb-publisher-config'), join(backupDir, 'filesystem', 'data', 'stdb-publisher-config'), copiedFiles);
	cpIfExists(join(options.dataDir, '.plugin-storage'), join(backupDir, 'filesystem', 'data', '.plugin-storage'), copiedFiles);
	cpIfExists(options.pluginsDir, join(backupDir, 'filesystem', 'plugins'), copiedFiles);
	return copySelectiveUploads(uploadRefs, options, backupDir, copiedFiles);
}

function copyFullEmergencyFilesystem(options, backupDir, copiedFiles) {
	cpIfExists(resolve(process.cwd(), '.env'), join(backupDir, 'filesystem', '.env'), copiedFiles);
	cpIfExists(options.dataDir, join(backupDir, 'filesystem', 'data'), copiedFiles);
	cpIfExists(options.uploadsDir, join(backupDir, 'filesystem', 'uploads'), copiedFiles);
	cpIfExists(options.pluginsDir, join(backupDir, 'filesystem', 'plugins'), copiedFiles);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const backupDir = join(options.backupRoot, `state-plane-${options.profile}-${utcStamp()}`);
	const tablesDir = join(backupDir, 'tables');
	ensureDir(tablesDir);

	const tableNames = buildTableList(options);
	const tableEntries = [];
	const copiedFiles = [];
	const allUploadRefs = new Set();

	for (const table of tableNames) {
		const dumped = runSql(table, options);
		for (const ref of extractUploadRefsFromRows(dumped.rows)) allUploadRefs.add(ref);
		const tablePath = join(tablesDir, `${table}.json`);
		const payload = {
			table,
			query: `SELECT * FROM ${table}`,
			exportedAt: new Date().toISOString(),
			rowCount: dumped.rows.length,
			rows: dumped.rows
		};
		writeJsonFile(tablePath, payload);
		tableEntries.push({
			table,
			rowCount: dumped.rows.length,
			path: relative(backupDir, tablePath),
			sha256: sha256File(tablePath)
		});
	}

	let copiedUploads = null;
	if (options.skipFilesystem) {
		copiedUploads = [];
	} else {
		copiedUploads =
			options.profile === 'full-emergency'
				? (copyFullEmergencyFilesystem(options, backupDir, copiedFiles), null)
				: copyContinuityFilesystem(options, backupDir, copiedFiles, allUploadRefs);
	}

	const manifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		profile: options.profile,
		stdb: {
			server: options.server,
			database: options.database,
			anonymous: options.anonymous,
			usedToken: Boolean(options.token)
		},
		privacy: {
			continuityExcludes: {
				contentTables: CONTENT_TABLES,
				ephemeralAndForensicTables: EPHEMERAL_AND_FORENSIC_TABLES,
				paymentTablesIncluded: options.includePayments || options.profile === 'full-emergency'
			},
			fullEmergencyIncludesContent: options.profile === 'full-emergency',
			encryptionAtRestRequired: true,
			filesystemSkipped: options.skipFilesystem,
			note: 'Store this backup only in encrypted storage. Continuity contains password hashes, encrypted private keys, webhook secrets, and server trust material.'
		},
		tables: tableEntries,
		files: copiedFiles,
		uploads: {
			mode: options.skipFilesystem ? 'skipped' : (options.profile === 'full-emergency' ? 'all' : 'continuity-referenced-only'),
			referenced: copiedUploads
		}
	};
	const manifestPath = join(backupDir, 'manifest.json');
	writeJsonFile(manifestPath, manifest);

	const summary = {
		backupDir,
		profile: options.profile,
		tables: tableEntries.length,
		rows: tableEntries.reduce((sum, entry) => sum + entry.rowCount, 0),
		files: copiedFiles.length,
		manifest: manifestPath
	};
	if (options.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log('[state-plane-backup] Backup created');
	console.log(`  profile=${summary.profile}`);
	console.log(`  backupDir=${summary.backupDir}`);
	console.log(`  tables=${summary.tables}`);
	console.log(`  rows=${summary.rows}`);
	console.log(`  files=${summary.files}`);
	console.log(`  manifest=${summary.manifest}`);
	console.warn('[state-plane-backup] Backup contains sensitive material; store it with restic/borg or equivalent encryption.');
}

try {
	main();
} catch (error) {
	console.error('[state-plane-backup] Failed:', error instanceof Error ? error.message : String(error));
	process.exit(2);
}
