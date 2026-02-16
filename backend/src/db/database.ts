import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database file path - /app/data/chat.db or ./data/chat.db for dev
const DB_DIR = process.env.DATABASE_PATH ? dirname(process.env.DATABASE_PATH) : join(process.cwd(), 'data');
const DB_FILE = process.env.DATABASE_PATH || join(DB_DIR, 'chat.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
	fs.mkdirSync(DB_DIR, { recursive: true });
}

console.log(`[Database] Initializing SQLite at: ${DB_FILE}`);

// Create database connection
const db = new Database(DB_FILE);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize schema
export function initializeDatabase() {
	const schemaCandidates = [
		join(process.cwd(), 'src', 'db', 'schema.sql'),
		join(process.cwd(), 'schema.sql'),
		join(__dirname, 'schema.sql')
	];
	const schemaPath = schemaCandidates.find(path => fs.existsSync(path));
	if (!schemaPath) {
		throw new Error(`Schema file not found. Checked: ${schemaCandidates.join(', ')}`);
	}
	const schema = fs.readFileSync(schemaPath, 'utf-8');

	// Split by semicolons and execute each statement
	const statements = schema.split(';').filter((stmt) => stmt.trim().length > 0);

	for (const statement of statements) {
		try {
			db.exec(statement);
		} catch (error) {
			// Table might already exist - that's fine
			if (!(error instanceof Error && error.message.includes('already exists'))) {
				console.error(`[Database] Error executing statement:`, error);
			}
		}
	}

	console.log('[Database] ✅ Schema initialized');

	// Run migrations
	runMigrations();

	// Seed default roles
	seedDefaultRoles();
}

function runMigrations() {
	const addColumnIfMissing = (table: string, column: string, definition: string) => {
		try {
			const cols = db.pragma(`table_info(${table})`) as { name: string }[];
			if (!cols.some(c => c.name === column)) {
				db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
				console.log(`[Database] Migration: added ${table}.${column}`);
			}
		} catch (e) {
			console.error(`[Database] Migration error adding ${table}.${column}:`, e);
		}
	};

	// Migration: Add handle column to users table
	addColumnIfMissing('users', 'handle', 'TEXT UNIQUE COLLATE NOCASE');
	addColumnIfMissing('users', 'profile_picture', 'TEXT');
	addColumnIfMissing('users', 'bio', 'TEXT');
	addColumnIfMissing('users', 'is_active', 'INTEGER DEFAULT 1');

	// Backfill handles for users that don't have one
	try {
		const usersWithoutHandle = db.prepare("SELECT user_id, username FROM users WHERE handle IS NULL").all() as { user_id: number; username: string }[];
		if (usersWithoutHandle.length > 0) {
			const updateStmt = db.prepare("UPDATE users SET handle = ? WHERE user_id = ?");
			for (const user of usersWithoutHandle) {
				const baseHandle = user.username.replace(/\s+/g, '').toLowerCase();
				let handle = baseHandle;
				let suffix = 1;
				// Resolve conflicts by appending numeric suffix
				while (true) {
					const existing = db.prepare("SELECT 1 FROM users WHERE handle = ? COLLATE NOCASE AND user_id != ?").get(handle, user.user_id);
					if (!existing) break;
					handle = `${baseHandle}${suffix}`;
					suffix++;
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

	// Verify handle column exists
	{
		const cols = db.pragma('table_info(users)') as { name: string }[];
		if (!cols.some(c => c.name === 'handle')) {
			console.error('[Database] WARNING: handle column missing after migration — auth may be degraded');
		}
	}

	// Migration: Add username font columns to users table
	addColumnIfMissing('users', 'username_font_family', "TEXT DEFAULT 'inherit'");
	addColumnIfMissing('users', 'username_font_size', "TEXT DEFAULT 'inherit'");
	addColumnIfMissing('users', 'username_font_weight', "TEXT DEFAULT '600'");
	addColumnIfMissing('users', 'username_font_style', "TEXT DEFAULT 'normal'");

	// Migration: Session columns used by current session repository
	addColumnIfMissing('sessions', 'profile_picture', 'TEXT');
	addColumnIfMissing('sessions', 'socket_id', 'TEXT');
	addColumnIfMissing('sessions', 'last_seen', 'INTEGER');

	// Migration: user_settings columns used by current settings repository
	addColumnIfMissing('user_settings', 'allow_temp_user_messages', 'INTEGER DEFAULT 1');
	addColumnIfMissing('user_settings', 'business_private_mode', 'INTEGER DEFAULT 0');

	// Migration: Add description column to channels table
	try {
		const cols = db.pragma('table_info(channels)') as { name: string }[];
		if (!cols.some(c => c.name === 'description')) {
			db.exec("ALTER TABLE channels ADD COLUMN description TEXT DEFAULT ''");
			console.log('[Database] Migration: added description column to channels');
		}
	} catch (e) {
		// Column may already exist
	}

	// Migration: Add optional voice settings column to channels table
	try {
		const cols = db.pragma('table_info(channels)') as { name: string }[];
		if (!cols.some(c => c.name === 'voice_settings_json')) {
			db.exec('ALTER TABLE channels ADD COLUMN voice_settings_json TEXT');
			console.log('[Database] Migration: added voice_settings_json column to channels');
		}
	} catch (e) {
		// Column may already exist
	}

	// Migration: add min_role to channels
	addColumnIfMissing('channels', 'min_role', "TEXT DEFAULT 'guest'");
	addColumnIfMissing('channels', 'parent_channel_id', 'TEXT');
	addColumnIfMissing('channels', 'parent_message_id', 'TEXT');
	addColumnIfMissing('channels', 'thread_archived', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'thread_locked', 'INTEGER DEFAULT 0');
	addColumnIfMissing('channels', 'thread_auto_archive_minutes', 'INTEGER DEFAULT 1440');
	addColumnIfMissing('channels', 'thread_last_activity_at', 'INTEGER');

	try {
		db.exec('CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_channel_id)');
	} catch (e) {
		console.error('[Database] Migration error creating idx_channels_parent:', e);
	}

	// Migration: add display_name to roles
	addColumnIfMissing('roles', 'display_name', 'TEXT');

	// Migration: emoji-role automation table
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS emoji_role_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				emoji_id TEXT NOT NULL,
				role_name TEXT NOT NULL,
				remove_on_unreact INTEGER DEFAULT 0,
				workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
				enabled INTEGER DEFAULT 1,
				created_at INTEGER DEFAULT (strftime('%s', 'now'))
			)
		`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_emoji_role_rules_emoji ON emoji_role_rules(emoji_id, workspace_id)');
	} catch (e) {
		console.error('[Database] Migration error creating emoji_role_rules:', e);
	}

	// Migration: Add priority/color/is_hoisted to user_roles
	try {
		const cols = db.pragma('table_info(user_roles)') as { name: string }[];
		if (!cols.some(c => c.name === 'priority')) {
			db.exec('ALTER TABLE user_roles ADD COLUMN priority INTEGER DEFAULT 10');
			db.exec('ALTER TABLE user_roles ADD COLUMN color TEXT');
			db.exec('ALTER TABLE user_roles ADD COLUMN is_hoisted INTEGER DEFAULT 0');
			console.log('[Database] Migration: added priority/color/is_hoisted to user_roles');
		}
	} catch (e) {
		// Columns may already exist
	}

	// Migration: Add encryption columns to messages table
	try {
		const cols = db.pragma('table_info(messages)') as { name: string }[];
		if (!cols.some(c => c.name === 'is_encrypted')) {
			db.exec('ALTER TABLE messages ADD COLUMN is_encrypted INTEGER DEFAULT 0');
			db.exec('ALTER TABLE messages ADD COLUMN encryption_iv TEXT');
			console.log('[Database] Migration: added encryption columns to messages');
		}
	} catch (e) {
		// Columns may already exist
	}
}

function seedDefaultRoles() {
	const defaultRoles = [
		{ role_name: 'owner', display_name: 'Owner', priority: 100, color: '#FFD700', is_hoisted: 1 },
		{ role_name: 'admin', display_name: 'Admin', priority: 90, color: '#FF4444', is_hoisted: 1 },
		{ role_name: 'mod', display_name: 'Moderator', priority: 70, color: '#44FF44', is_hoisted: 1 },
		{ role_name: 'member', display_name: 'Member', priority: 10, color: null, is_hoisted: 0 },
		{ role_name: 'guest', display_name: 'Guest', priority: 0, color: '#888888', is_hoisted: 0 }
	];

	const insertRole = db.prepare(
		'INSERT OR IGNORE INTO roles (role_name, workspace_id, display_name, priority, color, is_hoisted) VALUES (?, ?, ?, ?, ?, ?)'
	);
	const updateDisplayName = db.prepare(
		'UPDATE roles SET display_name = COALESCE(display_name, ?) WHERE role_name = ? AND workspace_id = ?'
	);

	for (const role of defaultRoles) {
		insertRole.run(role.role_name, 'default-workspace', role.display_name, role.priority, role.color, role.is_hoisted);
		updateDisplayName.run(role.display_name, role.role_name, 'default-workspace');
	}

	// Auto-assign owner to the first registered user if no owner exists
	const ownerExists = db.prepare(
		"SELECT 1 FROM user_roles WHERE role_name = 'owner' AND workspace_id = 'default-workspace' LIMIT 1"
	).get();

	if (!ownerExists) {
		const firstUser = db.prepare('SELECT user_id FROM users ORDER BY user_id ASC LIMIT 1').get() as { user_id: number } | undefined;
		if (firstUser) {
			db.prepare(
				"INSERT OR IGNORE INTO user_roles (user_id, role_name, workspace_id) VALUES (?, 'owner', 'default-workspace')"
			).run(firstUser.user_id);
			console.log(`[Database] Auto-assigned owner role to user_id ${firstUser.user_id}`);
		}
	}
}

// Cleanup on shutdown
export function closeDatabase() {
	db.close();
	console.log('[Database] ✅ Connection closed');
}

export default db;
