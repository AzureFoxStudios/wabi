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
}

// Cleanup on shutdown
export function closeDatabase() {
	db.close();
	console.log('[Database] ✅ Connection closed');
}

export default db;
