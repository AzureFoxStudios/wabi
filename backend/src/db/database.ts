import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type DbMode = 'sqlite';

interface DatabaseLike {
	prepare: (sql: string) => any;
	exec: (sql: string) => void;
	close: () => void;
	transaction?: <T extends (...args: any[]) => any>(fn: T) => T;
	pragma?: (value: string) => any;
}

const resolvedMode = (process.env.DB_MODE || 'sqlite').trim().toLowerCase();
const DB_MODE: DbMode = 'sqlite';
if (resolvedMode !== 'sqlite') {
	console.warn(`[Database] DB_MODE='${resolvedMode}' is no longer supported; using sqlite`);
}

const SQLITE_DB_DIR = process.env.DATABASE_PATH ? dirname(process.env.DATABASE_PATH) : join(process.cwd(), 'data');
const SQLITE_DB_FILE = process.env.DATABASE_PATH || join(SQLITE_DB_DIR, 'chat.db');

function splitSqlStatements(sql: string): string[] {
	return sql
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

let dbClient: DatabaseLike;
let dbClosed = false;

if (!fs.existsSync(SQLITE_DB_DIR)) {
	fs.mkdirSync(SQLITE_DB_DIR, { recursive: true });
}
console.log(`[Database] Initializing SQLite at: ${SQLITE_DB_FILE}`);
const sqliteDb = new Database(SQLITE_DB_FILE);
sqliteDb.pragma('foreign_keys = ON');
dbClient = sqliteDb as unknown as DatabaseLike;

function resolveSchemaPath(schemaFileName: 'schema.sql'): string {
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
		console.error('[Database] WARNING: handle column missing after migration - auth may be degraded');
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
	addColumnIfMissing('user_settings', 'home_experience', "TEXT DEFAULT 'community'");
	addColumnIfMissing('user_settings', 'require_password_change', 'INTEGER DEFAULT 0');
	addColumnIfMissing('user_settings', 'payment_preferred_route', 'TEXT');
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
	addColumnIfMissing('messages', 'entities_json', 'TEXT');
	addColumnIfMissing('messages', 'attachment_storage_json', 'TEXT');
	addColumnIfMissing('albums', 'is_featured', 'INTEGER DEFAULT 0');
	addColumnIfMissing('album_items', 'sort_order', 'INTEGER DEFAULT 0');

	try {
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_albums_scope_featured ON albums(scope_type, scope_id, is_featured DESC, updated_at DESC)');
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_album_items_album_order ON album_items(album_id, sort_order ASC, uploaded_at DESC)');
		dbClient.exec(`
			UPDATE album_items
			SET sort_order = uploaded_at
			WHERE sort_order IS NULL OR sort_order <= 0
		`);
	} catch (e) {
		console.error('[Database] Album migration/index error:', e);
	}

	try {
		dbClient.exec(`
			CREATE TABLE IF NOT EXISTS dictionary_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
				term TEXT NOT NULL,
				term_normalized TEXT NOT NULL,
				definition TEXT NOT NULL,
				language TEXT NOT NULL DEFAULT 'en',
				created_by_user_id INTEGER,
				created_by_username TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				votes INTEGER DEFAULT 0,
				UNIQUE(workspace_id, language, term_normalized)
			)
		`);
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_dictionary_lookup ON dictionary_entries(workspace_id, language, term_normalized)');
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_dictionary_recent ON dictionary_entries(workspace_id, updated_at DESC)');
	} catch (e) {
		console.error('[Database] Migration error creating dictionary_entries:', e);
	}

	try {
		dbClient.exec(`
			CREATE TABLE IF NOT EXISTS whiteboards (
				board_id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
				scope_type TEXT NOT NULL DEFAULT 'channel',
				scope_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 1,
				document_json TEXT NOT NULL,
				is_private INTEGER DEFAULT 1,
				created_by TEXT,
				updated_by TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		addColumnIfMissing('whiteboards', 'workspace_id', "TEXT NOT NULL DEFAULT 'default-workspace'");
		addColumnIfMissing('whiteboards', 'scope_type', "TEXT NOT NULL DEFAULT 'channel'");
		addColumnIfMissing('whiteboards', 'scope_id', 'TEXT');
		addColumnIfMissing('whiteboards', 'version', 'INTEGER NOT NULL DEFAULT 1');
		addColumnIfMissing('whiteboards', 'document_json', 'TEXT');
		addColumnIfMissing('whiteboards', 'is_private', 'INTEGER DEFAULT 1');
		addColumnIfMissing('whiteboards', 'created_by', 'TEXT');
		addColumnIfMissing('whiteboards', 'updated_by', 'TEXT');
		addColumnIfMissing('whiteboards', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
		addColumnIfMissing('whiteboards', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
		dbClient.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_whiteboards_scope ON whiteboards(scope_type, scope_id)');
		dbClient.exec('CREATE INDEX IF NOT EXISTS idx_whiteboards_workspace_updated ON whiteboards(workspace_id, updated_at DESC)');
	} catch (e) {
		console.error('[Database] Migration error creating whiteboards:', e);
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
