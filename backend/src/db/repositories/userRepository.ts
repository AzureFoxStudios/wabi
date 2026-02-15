import db from '../database.js';

export interface RegisteredUser {
	user_id?: number;
	username: string;
	handle?: string;
	password_hash: string;
	created_at: number;
	color: string;
	profile_picture?: string;
	bio?: string;
	is_active?: number;
	username_font_family?: string;
	username_font_size?: string;
	username_font_weight?: string;
	username_font_style?: string;
}

export class UserRepository {
	// Create a new user
	create(user: Omit<RegisteredUser, 'user_id'>): RegisteredUser {
		try {
			const stmt = db.prepare(`
				INSERT INTO users (username, handle, password_hash, created_at, color, profile_picture, bio)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`);

			const info = stmt.run(
				user.username,
				user.handle || null,
				user.password_hash,
				user.created_at,
				user.color,
				user.profile_picture || null,
				user.bio || null
			);

			return {
				user_id: info.lastInsertRowid as number,
				...user
			};
		} catch (e) {
			// If handle column doesn't exist, fall back to INSERT without handle
			if (e instanceof Error && e.message.includes('handle')) {
				console.warn('[UserRepository] create: handle column missing, inserting without handle');
				const stmt = db.prepare(`
					INSERT INTO users (username, password_hash, created_at, color, profile_picture, bio)
					VALUES (?, ?, ?, ?, ?, ?)
				`);
				const info = stmt.run(
					user.username,
					user.password_hash,
					user.created_at,
					user.color,
					user.profile_picture || null,
					user.bio || null
				);
				return {
					user_id: info.lastInsertRowid as number,
					...user,
					handle: undefined
				};
			}
			throw e;
		}
	}

	// Find user by username
	findByUsername(username: string): RegisteredUser | null {
		const stmt = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
		return (stmt.get(username) as RegisteredUser) || null;
	}

	// Find user by handle
	findByHandle(handle: string): RegisteredUser | null {
		try {
			const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
			const stmt = db.prepare('SELECT * FROM users WHERE handle = ? COLLATE NOCASE');
			return (stmt.get(cleanHandle) as RegisteredUser) || null;
		} catch (e) {
			// If handle column doesn't exist, fall back gracefully
			console.warn('[UserRepository] findByHandle failed (handle column may be missing):', (e as Error).message);
			return null;
		}
	}

	// Find user by handle or username (for login)
	findByHandleOrUsername(identifier: string): RegisteredUser | null {
		const cleanId = identifier.startsWith('@') ? identifier.slice(1) : identifier;
		return this.findByHandle(cleanId) || this.findByUsername(identifier);
	}

	// Find user by ID
	findById(userId: number): RegisteredUser | null {
		const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
		return (stmt.get(userId) as RegisteredUser) || null;
	}

	// Update user profile
	update(userId: number, updates: Partial<RegisteredUser>): void {
		const allowedFields = ['color', 'profile_picture', 'bio', 'is_active', 'username_font_family', 'username_font_size', 'username_font_weight', 'username_font_style'];
		const fields = Object.keys(updates).filter((key) => allowedFields.includes(key));

		if (fields.length === 0) return;

		const setClause = fields.map((field) => `${field} = ?`).join(', ');
		const values = fields.map((field) => updates[field as keyof RegisteredUser]);

		const stmt = db.prepare(`UPDATE users SET ${setClause} WHERE user_id = ?`);
		stmt.run(...values, userId);
	}


	// Rename user and handle
	rename(userId: number, username: string, handle: string): void {
		const stmt = db.prepare('UPDATE users SET username = ?, handle = ? WHERE user_id = ?');
		stmt.run(username, handle, userId);
	}

	// Delete user
	delete(userId: number): void {
		const stmt = db.prepare('DELETE FROM users WHERE user_id = ?');
		stmt.run(userId);
	}

	// Get all users
	getAll(): RegisteredUser[] {
		const stmt = db.prepare('SELECT * FROM users WHERE is_active = 1');
		return stmt.all() as RegisteredUser[];
	}
}

export const userRepository = new UserRepository();
