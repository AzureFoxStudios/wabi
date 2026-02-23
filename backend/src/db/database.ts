import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'worker_threads';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type DbMode = 'sqlite' | 'postgres';

interface RunInfo {
	changes: number;
	lastInsertRowid?: number | bigint;
}

interface PreparedStatementLike {
	run: (...params: any[]) => RunInfo;
	get: (...params: any[]) => any;
	all: (...params: any[]) => any[];
}

interface DatabaseLike {
	prepare: (sql: string) => PreparedStatementLike;
	exec: (sql: string) => void;
	close: () => void;
	transaction?: <T extends (...args: any[]) => any>(fn: T) => T;
	pragma?: (value: string) => any;
}

const resolvedMode = (process.env.DB_MODE || 'sqlite').trim().toLowerCase();
const DB_MODE: DbMode = resolvedMode === 'postgres' ? 'postgres' : 'sqlite';
if (resolvedMode !== 'sqlite' && resolvedMode !== 'postgres') {
	console.warn(`[Database] Unknown DB_MODE='${resolvedMode}', defaulting to sqlite`);
}

const SQLITE_DB_DIR = process.env.DATABASE_PATH ? dirname(process.env.DATABASE_PATH) : join(process.cwd(), 'data');
const SQLITE_DB_FILE = process.env.DATABASE_PATH || join(SQLITE_DB_DIR, 'chat.db');

function sleepMs(ms: number): void {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(signal, 0, 0, ms);
}

function splitSqlStatements(sql: string): string[] {
	return sql
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

function convertSqlitePlaceholders(sql: string): string {
	let out = '';
	let inSingle = false;
	let inDouble = false;
	let index = 0;

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		const next = i + 1 < sql.length ? sql[i + 1] : '';

		if (ch === "'" && !inDouble) {
			out += ch;
			if (inSingle && next === "'") {
				out += next;
				i++;
				continue;
			}
			inSingle = !inSingle;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			out += ch;
			continue;
		}

		if (ch === '?' && !inSingle && !inDouble) {
			index += 1;
			out += `$${index}`;
			continue;
		}

		out += ch;
	}

	return out;
}

function appendBeforeSemicolon(sql: string, suffix: string): string {
	const trimmed = sql.trim();
	if (trimmed.endsWith(';')) {
		return `${trimmed.slice(0, -1)}${suffix};`;
	}
	return `${trimmed}${suffix}`;
}

function translateSqliteSqlToPostgres(sql: string): { sql: string; wasInsertOrIgnore: boolean } {
	let translated = sql;
	const wasInsertOrIgnore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(translated);

	translated = translated.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
	translated = translated.replace(/strftime\('%s',\s*'now'\)/gi, 'EXTRACT(EPOCH FROM NOW())::BIGINT');
	translated = convertSqlitePlaceholders(translated);
	translated = translated.replace(/([\w.]+)\s*=\s*(\$\d+)\s+COLLATE\s+NOCASE/gi, 'LOWER($1) = LOWER($2)');
	translated = translated.replace(/\s+COLLATE\s+NOCASE/gi, '');

	if (wasInsertOrIgnore && !/\bON\s+CONFLICT\b/i.test(translated)) {
		translated = appendBeforeSemicolon(translated, ' ON CONFLICT DO NOTHING');
	}

	return { sql: translated, wasInsertOrIgnore };
}

const INSERT_ID_COLUMN_BY_TABLE: Record<string, string> = {
	users: 'user_id',
	messages: 'id',
	offline_messages: 'message_id',
	channel_members: 'id',
	relays: 'relay_id',
	webhooks: 'id',
	webhook_deliveries: 'id',
	user_encryption_keys: 'id',
	emoji_role_rules: 'id',
	user_roles: 'id',
	resource_visibility: 'id'
};

function getInsertMetadata(sql: string): { table: string | null; idColumn: string | null } {
	const match = /^\s*INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+"?([a-zA-Z_][\w]*)"?/i.exec(sql);
	if (!match) return { table: null, idColumn: null };
	const table = match[1].toLowerCase();
	return {
		table,
		idColumn: INSERT_ID_COLUMN_BY_TABLE[table] || null
	};
}

class PostgresSyncBridge {
	private readonly worker: Worker;
	private readonly requestPort: MessagePort;
	private requestId = 0;
	private closed = false;

	constructor(private readonly config: Record<string, any>) {
		const workerSource = `
import { parentPort } from 'worker_threads';
import { Pool } from 'pg';

let pool = null;
let requestPort = null;
let pgConfig = null;

function serializeError(error) {
	if (!error) return 'Unknown Postgres error';
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch (_) {
		return String(error);
	}
}

async function ensurePool() {
	if (!pool) {
		pool = new Pool(pgConfig || {});
	}
	return pool;
}

async function handleRequest(message) {
	const id = message?.id;
	if (!requestPort) return;

	try {
		switch (message.action) {
			case 'ping': {
				const p = await ensurePool();
				await p.query('SELECT 1');
				requestPort.postMessage({ id, ok: true, data: { ok: true } });
				break;
			}
			case 'query': {
				const p = await ensurePool();
				const result = await p.query(message.sql, message.params || []);
				requestPort.postMessage({
					id,
					ok: true,
					data: {
						rows: result.rows || [],
						rowCount: typeof result.rowCount === 'number' ? result.rowCount : 0,
						command: result.command || null
					}
				});
				break;
			}
			case 'exec': {
				const p = await ensurePool();
				await p.query(message.sql);
				requestPort.postMessage({ id, ok: true, data: { ok: true } });
				break;
			}
			case 'close': {
				if (pool) {
					await pool.end();
					pool = null;
				}
				requestPort.postMessage({ id, ok: true, data: { ok: true } });
				break;
			}
			default: {
				requestPort.postMessage({ id, ok: false, error: 'Unknown Postgres bridge action' });
				break;
			}
		}
	} catch (error) {
		requestPort.postMessage({ id, ok: false, error: serializeError(error) });
	}
}

parentPort.on('message', (message) => {
	if (message?.type === 'init') {
		pgConfig = message.config || {};
		requestPort = message.port;
		requestPort.on('message', (payload) => {
			void handleRequest(payload);
		});
		requestPort.start();
		requestPort.postMessage({ id: 0, ok: true, data: { ready: true } });
	}
});
`;

		this.worker = new Worker(workerSource, { eval: true, type: 'module' });
		const channel = new MessageChannel();
		this.requestPort = channel.port1;
		this.requestPort.start();
		this.worker.postMessage({ type: 'init', config: this.config, port: channel.port2 }, [channel.port2]);

		this.waitForReady();
	}

	private waitForReady(): void {
		const timeoutMs = 30_000;
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const packet = receiveMessageOnPort(this.requestPort);
			if (packet && packet.message && packet.message.id === 0 && packet.message.ok === true) {
				return;
			}
			sleepMs(10);
		}
		throw new Error('Postgres worker bridge did not become ready in time');
	}

	private send(action: 'ping' | 'query' | 'exec' | 'close', payload: Record<string, any> = {}, timeoutMs = 60_000): any {
		if (this.closed && action !== 'close') {
			throw new Error('Postgres bridge is already closed');
		}

		this.requestId += 1;
		const id = this.requestId;
		this.requestPort.postMessage({ id, action, ...payload });

		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const packet = receiveMessageOnPort(this.requestPort);
			if (!packet || !packet.message) {
				sleepMs(10);
				continue;
			}
			const message = packet.message;
			if (message.id !== id) {
				continue;
			}
			if (!message.ok) {
				throw new Error(message.error || 'Postgres bridge request failed');
			}
			return message.data;
		}

		throw new Error(`Postgres bridge request timed out after ${timeoutMs}ms`);
	}

	ping(): void {
		this.send('ping');
	}

	query(sql: string, params: any[] = []): { rows: any[]; rowCount: number; command?: string } {
		const data = this.send('query', { sql, params });
		return {
			rows: Array.isArray(data?.rows) ? data.rows : [],
			rowCount: typeof data?.rowCount === 'number' ? data.rowCount : 0,
			command: data?.command
		};
	}

	exec(sql: string): void {
		this.send('exec', { sql });
	}

	close(): void {
		if (this.closed) return;
		try {
			this.send('close', {}, 15_000);
		} finally {
			this.closed = true;
			this.requestPort.close();
			void this.worker.terminate();
		}
	}
}

class PostgresDatabase implements DatabaseLike {
	private readonly bridge: PostgresSyncBridge;

	constructor(config: Record<string, any>) {
		this.bridge = new PostgresSyncBridge(config);
	}

	ping(): void {
		this.bridge.ping();
	}

	prepare(sql: string): PreparedStatementLike {
		const originalSql = sql;
		const insertMeta = getInsertMetadata(originalSql);

		const buildSql = (forRun: boolean): { sql: string; idColumn: string | null } => {
			const translated = translateSqliteSqlToPostgres(originalSql);
			let pgSql = translated.sql;
			let idColumn = insertMeta.idColumn;

			if (forRun && idColumn && /^\s*INSERT\s+/i.test(pgSql) && !/\bRETURNING\b/i.test(pgSql)) {
				pgSql = appendBeforeSemicolon(pgSql, ` RETURNING ${idColumn}`);
			}

			if (!forRun) {
				idColumn = null;
			}

			return { sql: pgSql, idColumn };
		};

		return {
			run: (...params: any[]): RunInfo => {
				const built = buildSql(true);
				const result = this.bridge.query(built.sql, params);
				const info: RunInfo = { changes: result.rowCount || 0 };

				if (built.idColumn && result.rows.length > 0) {
					const rawId = result.rows[0][built.idColumn];
					if (typeof rawId === 'bigint') {
						info.lastInsertRowid = Number(rawId);
					} else if (typeof rawId === 'string' && /^\d+$/.test(rawId)) {
						info.lastInsertRowid = Number(rawId);
					} else if (typeof rawId === 'number') {
						info.lastInsertRowid = rawId;
					}
				}

				return info;
			},
			get: (...params: any[]): any => {
				const built = buildSql(false);
				const result = this.bridge.query(built.sql, params);
				return result.rows[0];
			},
			all: (...params: any[]): any[] => {
				const built = buildSql(false);
				const result = this.bridge.query(built.sql, params);
				return result.rows;
			}
		};
	}

	exec(sql: string): void {
		const translated = translateSqliteSqlToPostgres(sql).sql;
		this.bridge.exec(translated);
	}

	transaction<T extends (...args: any[]) => any>(fn: T): T {
		return fn;
	}

	close(): void {
		this.bridge.close();
	}
}

function getPostgresConfigFromEnv(): Record<string, any> {
	const config: Record<string, any> = {};
	const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

	if (connectionString && connectionString.trim().length > 0) {
		config.connectionString = connectionString.trim();
	} else {
		config.host = process.env.POSTGRES_HOST || 'postgres';
		config.port = Number(process.env.POSTGRES_PORT || 5432);
		config.user = process.env.POSTGRES_USER || 'wabi';
		config.password = process.env.POSTGRES_PASSWORD || 'wabi';
		config.database = process.env.POSTGRES_DB || 'wabi';
	}

	const sslMode = (process.env.POSTGRES_SSL || '').trim().toLowerCase();
	if (sslMode === 'true' || sslMode === 'require') {
		config.ssl = { rejectUnauthorized: false };
	}

	return config;
}

let dbClient: DatabaseLike;
let dbClosed = false;

if (DB_MODE === 'sqlite') {
	if (!fs.existsSync(SQLITE_DB_DIR)) {
		fs.mkdirSync(SQLITE_DB_DIR, { recursive: true });
	}
	console.log(`[Database] Initializing SQLite at: ${SQLITE_DB_FILE}`);
	const sqliteDb = new Database(SQLITE_DB_FILE);
	sqliteDb.pragma('foreign_keys = ON');
	dbClient = sqliteDb as unknown as DatabaseLike;
} else {
	console.log('[Database] Initializing PostgreSQL mode');
	dbClient = new PostgresDatabase(getPostgresConfigFromEnv());
}

function resolveSchemaPath(schemaFileName: 'schema.sql' | 'schema.postgres.sql'): string {
	const schemaCandidates = [
		join(process.cwd(), 'src', 'db', schemaFileName),
		join(process.cwd(), schemaFileName),
		join(__dirname, schemaFileName)
	];

	const schemaPath = schemaCandidates.find((candidate) => fs.existsSync(candidate));
	if (!schemaPath) {
		throw new Error(`Schema file not found. Checked: ${schemaCandidates.join(', ')}`);
	}

	return schemaPath;
}

function applySchema(schemaPath: string): void {
	const schema = fs.readFileSync(schemaPath, 'utf-8');
	const statements = splitSqlStatements(schema);

	for (const statement of statements) {
		try {
			dbClient.exec(statement);
		} catch (error) {
			if (error instanceof Error && error.message.includes('already exists')) {
				continue;
			}
			console.error('[Database] Error executing schema statement:', error);
			throw error;
		}
	}
}

function runSqliteMigrations(): void {
	if (!dbClient.pragma) return;

	const addColumnIfMissing = (table: string, column: string, definition: string) => {
		try {
			const cols = dbClient.pragma!(`table_info(${table})`) as { name: string }[];
			if (!cols.some((c) => c.name === column)) {
				dbClient.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				console.log(`[Database] Migration: added ${table}.${column}`);
			}
		} catch (e) {
			console.error(`[Database] Migration error adding ${table}.${column}:`, e);
		}
	};

	addColumnIfMissing('users', 'handle', 'TEXT UNIQUE COLLATE NOCASE');
	addColumnIfMissing('users', 'profile_picture', 'TEXT');
	addColumnIfMissing('users', 'bio', 'TEXT');
	addColumnIfMissing('users', 'is_active', 'INTEGER DEFAULT 1');

	try {
		const usersWithoutHandle = dbClient
			.prepare('SELECT user_id, username FROM users WHERE handle IS NULL')
			.all() as { user_id: number; username: string }[];
		if (usersWithoutHandle.length > 0) {
			const updateStmt = dbClient.prepare('UPDATE users SET handle = ? WHERE user_id = ?');
			for (const user of usersWithoutHandle) {
				const baseHandle = user.username.replace(/\s+/g, '').toLowerCase();
				let handle = baseHandle;
				let suffix = 1;
				while (true) {
					const existing = dbClient
						.prepare('SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE AND user_id != ?')
						.get(handle, user.user_id);
					if (!existing) break;
					handle = `${baseHandle}${suffix}`;
					suffix += 1;
				}
				try {
					updateStmt.run(handle, user.user_id);
				} catch (e) {
					console.error(`[Database] Failed to backfill handle for user_id ${user.user_id}:`, e);
				}
			}
			console.log(`[Database] Backfilled handles for ${usersWithoutHandle.length} users`);
		}
	} catch (e) {
		console.error('[Database] Handle backfill error:', e);
	}

	const usersCols = dbClient.pragma('table_info(users)') as { name: string }[];
	if (!usersCols.some((c) => c.name === 'handle')) {
		console.error('[Database] WARNING: handle column missing after migration — auth may be degraded');
	}

	addColumnIfMissing('users', 'username_font_family', "TEXT DEFAULT 'inherit'");
	addColumnIfMissing('users', 'username_font_size', "TEXT DEFAULT 'inherit'");
	addColumnIfMissing('users', 'username_font_weight', "TEXT DEFAULT '600'");
	addColumnIfMissing('users', 'username_font_style', "TEXT DEFAULT 'normal'");

	addColumnIfMissing('sessions', 'profile_picture', 'TEXT');
	addColumnIfMissing('sessions', 'socket_id', 'TEXT');
	addColumnIfMissing('sessions', 'last_seen', 'INTEGER');

	addColumnIfMissing('user_settings', 'allow_temp_user_messages', 'INTEGER DEFAULT 1');
	addColumnIfMissing('user_settings', 'business_private_mode', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'description', "TEXT DEFAULT ''");
	addColumnIfMissing('channels', 'voice_settings_json', 'TEXT');
	addColumnIfMissing('channels', 'min_role', "TEXT DEFAULT 'guest'");
	addColumnIfMissing('channels', 'parent_channel_id', 'TEXT');
	addColumnIfMissing('channels', 'is_breakout', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'breakout_index', 'INTEGER');
	addColumnIfMissing('channels', 'parent_message_id', 'TEXT');
	addColumnIfMissing('channels', 'thread_archived', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'thread_locked', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'thread_auto_archive_minutes', 'INTEGER DEFAULT 1440');
	addColumnIfMissing('channels', 'thread_last_activity_at', 'INTEGER');

	try {
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id)');
	} catch (e) {
		console.error('[Database] Migration error creating idx_channels_parent:', e);
	}

	addColumnIfMissing('roles', 'display_name', 'TEXT');

	try {
		dbClient.exec(`
			CREATE TABLE IF NOT EXISTS emoji_role_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				channel_id TEXT,
				message_id TEXT,
				emoji_id TEXT NOT NULL,
				role_name TEXT NOT NULL,
				remove_on_unreact INTEGER DEFAULT 0,
				workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
				enabled INTEGER DEFAULT 1,
				created_at INTEGER DEFAULT (strftime('%s', 'now'))
			)
		`);
		addColumnIfMissing('emoji_role_rules', 'channel_id', 'TEXT');
		addColumnIfMissing('emoji_role_rules', 'message_id', 'TEXT');
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_emoji_role_rules_lookup ON emoji_role_rules(channel_id, message_id, emoji_id, workspace_id)');

		const cleanupInfo = dbClient
			.prepare(`
				DELETE FROM emoji_role_rules
				WHERE channel_id IS NULL OR channel_id = '' OR message_id IS NULL OR message_id = ''
			`)
			.run();
		if ((cleanupInfo.changes || 0) > 0) {
			console.log(`[Database] Migration: removed ${cleanupInfo.changes} legacy global emoji-role rules`);
		}
	} catch (e) {
		console.error('[Database] Migration error creating emoji_role_rules:', e);
	}

	addColumnIfMissing('user_roles', 'priority', 'INTEGER DEFAULT 10');
	addColumnIfMissing('user_roles', 'color', 'TEXT');
	addColumnIfMissing('user_roles', 'is_hoisted', 'INTEGER DEFAULT 0');

	addColumnIfMissing('messages', 'is_encrypted', 'INTEGER DEFAULT 0');
	addColumnIfMissing('messages', 'encryption_iv', 'TEXT');
	addColumnIfMissing('messages', 'attachment_encryption_json', 'TEXT');
	addColumnIfMissing('messages', 'files_json', 'TEXT');
	addColumnIfMissing('messages', 'attachment_storage_json', 'TEXT');
}

function runPostgresMigrations(): void {
	const columnExists = (table: string, column: string): boolean => {
		const result = dbClient
			.prepare(`
				SELECT 1
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = ? AND column_name = ?
				LIMIT 1
			`)
			.get(table, column);
		return Boolean(result);
	};

	const addColumnIfMissing = (table: string, column: string, definition: string) => {
		try {
			if (!columnExists(table, column)) {
				dbClient.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				console.log(`[Database] Migration: added ${table}.${column}`);
			}
		} catch (error) {
			console.error(`[Database] Migration error adding ${table}.${column}:`, error);
		}
	};

	addColumnIfMissing('users', 'handle', 'TEXT UNIQUE');
	addColumnIfMissing('users', 'profile_picture', 'TEXT');
	addColumnIfMissing('users', 'bio', 'TEXT');
	addColumnIfMissing('users', 'is_active', 'INTEGER DEFAULT 1');

	try {
		const usersWithoutHandle = dbClient
			.prepare('SELECT user_id, username FROM users WHERE handle IS NULL')
			.all() as { user_id: number; username: string }[];
		if (usersWithoutHandle.length > 0) {
			const updateStmt = dbClient.prepare('UPDATE users SET handle = ? WHERE user_id = ?');
			for (const user of usersWithoutHandle) {
				const baseHandle = user.username.replace(/\s+/g, '').toLowerCase();
				let handle = baseHandle;
				let suffix = 1;
				while (true) {
					const existing = dbClient
						.prepare('SELECT 1 FROM users WHERE LOWER(handle) = LOWER(?) AND user_id != ? LIMIT 1')
						.get(handle, user.user_id);
					if (!existing) break;
					handle = `${baseHandle}${suffix}`;
					suffix += 1;
				}
				updateStmt.run(handle, user.user_id);
			}
			console.log(`[Database] Backfilled handles for ${usersWithoutHandle.length} users`);
		}
	} catch (error) {
		console.error('[Database] Handle backfill error:', error);
	}

	addColumnIfMissing('users', 'username_font_family', "TEXT DEFAULT 'inherit'");
	addColumnIfMissing('users', 'username_font_size', "TEXT DEFAULT 'inherit'");
	addColumnIfMissing('users', 'username_font_weight', "TEXT DEFAULT '600'");
	addColumnIfMissing('users', 'username_font_style', "TEXT DEFAULT 'normal'");

	addColumnIfMissing('sessions', 'profile_picture', 'TEXT');
	addColumnIfMissing('sessions', 'socket_id', 'TEXT');
	addColumnIfMissing('sessions', 'last_seen', 'BIGINT');

	addColumnIfMissing('user_settings', 'allow_temp_user_messages', 'INTEGER DEFAULT 1');
	addColumnIfMissing('user_settings', 'business_private_mode', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'description', "TEXT DEFAULT ''");
	addColumnIfMissing('channels', 'voice_settings_json', 'TEXT');
	addColumnIfMissing('channels', 'min_role', "TEXT DEFAULT 'guest'");
	addColumnIfMissing('channels', 'parent_channel_id', 'TEXT');
	addColumnIfMissing('channels', 'is_breakout', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'breakout_index', 'INTEGER');
	addColumnIfMissing('channels', 'parent_message_id', 'TEXT');
	addColumnIfMissing('channels', 'thread_archived', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'thread_locked', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'thread_auto_archive_minutes', 'INTEGER DEFAULT 1440');
	addColumnIfMissing('channels', 'thread_last_activity_at', 'BIGINT');

	dbClient.exec('CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id)');

	addColumnIfMissing('roles', 'display_name', 'TEXT');
	addColumnIfMissing('user_roles', 'priority', 'INTEGER DEFAULT 10');
	addColumnIfMissing('user_roles', 'color', 'TEXT');
	addColumnIfMissing('user_roles', 'is_hoisted', 'INTEGER DEFAULT 0');
	addColumnIfMissing('messages', 'is_encrypted', 'INTEGER DEFAULT 0');
	addColumnIfMissing('messages', 'encryption_iv', 'TEXT');
	addColumnIfMissing('messages', 'attachment_encryption_json', 'TEXT');
	addColumnIfMissing('messages', 'files_json', 'TEXT');
	addColumnIfMissing('messages', 'attachment_storage_json', 'TEXT');

	try {
		const cleanupInfo = dbClient
			.prepare(`
				DELETE FROM emoji_role_rules
				WHERE channel_id IS NULL OR channel_id = '' OR message_id IS NULL OR message_id = ''
			`)
			.run();
		if ((cleanupInfo.changes || 0) > 0) {
			console.log(`[Database] Migration: removed ${cleanupInfo.changes} legacy global emoji-role rules`);
		}
	} catch (error) {
		console.error('[Database] Migration error cleaning emoji_role_rules:', error);
	}
}

function seedDefaultRoles(): void {
	const defaultRoles = [
		{ role_name: 'owner', display_name: 'Owner', priority: 100, color: '#FFD700', is_hoisted: 1 },
		{ role_name: 'admin', display_name: 'Admin', priority: 90, color: '#FF4444', is_hoisted: 1 },
		{ role_name: 'mod', display_name: 'Moderator', priority: 70, color: '#44FF44', is_hoisted: 1 },
		{ role_name: 'member', display_name: 'Member', priority: 10, color: null, is_hoisted: 0 },
		{ role_name: 'guest', display_name: 'Guest', priority: 0, color: '#888888', is_hoisted: 0 }
	];

	const insertRole = dbClient.prepare(
		'INSERT OR IGNORE INTO roles (role_name, workspace_id, display_name, priority, color, is_hoisted) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const updateDisplayName = dbClient.prepare(
		'UPDATE roles SET display_name = COALESCE(display_name, ?) WHERE role_name = ? AND workspace_id = ?'
	);

	for (const role of defaultRoles) {
		insertRole.run(role.role_name, DEFAULT_WORKSPACE_ID, role.display_name, role.priority, role.color, role.is_hoisted);
		updateDisplayName.run(role.display_name, role.role_name, DEFAULT_WORKSPACE_ID);
	}

	const ownerExists = dbClient
		.prepare("SELECT 1 FROM user_roles WHERE role_name = 'owner' AND workspace_id = ? LIMIT 1")
		.get(DEFAULT_WORKSPACE_ID);

	if (!ownerExists) {
		const firstUser = dbClient.prepare('SELECT user_id FROM users ORDER BY user_id ASC LIMIT 1').get() as
			| { user_id: number }
			| undefined;
		if (firstUser) {
			dbClient
				.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_name, workspace_id) VALUES (?, 'owner', ?)")
				.run(firstUser.user_id, DEFAULT_WORKSPACE_ID);
			console.log(`[Database] Auto-assigned owner role to user_id ${firstUser.user_id}`);
		}
	}
}

export function initializeDatabase(): void {
	if (DB_MODE === 'postgres') {
		const pgDb = dbClient as PostgresDatabase;
		pgDb.ping();
		const schemaPath = resolveSchemaPath('schema.postgres.sql');
		applySchema(schemaPath);
		console.log('[Database] ✅ PostgreSQL schema initialized');
		runPostgresMigrations();
		seedDefaultRoles();
		console.log('[Database] ✅ PostgreSQL migrations complete');
		return;
	}

	const schemaPath = resolveSchemaPath('schema.sql');
	applySchema(schemaPath);
	console.log('[Database] ✅ SQLite schema initialized');
	runSqliteMigrations();
	seedDefaultRoles();
	console.log('[Database] ✅ SQLite migrations complete');
}

export function closeDatabase(): void {
	if (dbClosed) return;
	dbClient.close();
	dbClosed = true;
	console.log('[Database] ✅ Connection closed');
}

export function getDatabaseMode(): DbMode {
	return DB_MODE;
}

const db = dbClient;
export default db;
