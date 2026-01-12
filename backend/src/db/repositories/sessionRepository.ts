import db from '../database.js';

export interface Session {
	session_id: string;
	user_id: number | null;
	username: string;
	color: string;
	profile_picture?: string;
	created_at: number;
	expires_at?: number;
	is_temporary: number;
	socket_id?: string;
	last_seen?: number;
}

export class SessionRepository {
	// Create a new session
	create(session: Session): void {
		const stmt = db.prepare(`
			INSERT INTO sessions (session_id, user_id, username, color, profile_picture, created_at, expires_at, is_temporary, socket_id, last_seen)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			session.session_id,
			session.user_id || null,
			session.username,
			session.color,
			session.profile_picture || null,
			session.created_at,
			session.expires_at || null,
			session.is_temporary,
			session.socket_id || null,
			session.last_seen || null
		);
	}

	// Find session by ID
	findById(sessionId: string): Session | null {
		const stmt = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
		return (stmt.get(sessionId) as Session) || null;
	}

	// Find session by user ID
	findByUserId(userId: number): Session | null {
		const stmt = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1');
		return (stmt.get(userId) as Session) || null;
	}

	// Update session
	update(sessionId: string, updates: Partial<Session>): void {
		const allowedFields = ['user_id', 'socket_id', 'last_seen', 'username', 'color', 'profile_picture'];
		const fields = Object.keys(updates).filter((key) => allowedFields.includes(key));

		if (fields.length === 0) return;

		const setClause = fields.map((field) => `${field} = ?`).join(', ');
		const values = fields.map((field) => updates[field as keyof Session]);

		const stmt = db.prepare(`UPDATE sessions SET ${setClause} WHERE session_id = ?`);
		stmt.run(...values, sessionId);
	}

	// Delete session
	delete(sessionId: string): void {
		const stmt = db.prepare('DELETE FROM sessions WHERE session_id = ?');
		stmt.run(sessionId);
	}

	// Clean up expired sessions
	cleanup(): number {
		const stmt = db.prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?');
		const info = stmt.run(Date.now());
		return info.changes;
	}

	// Get all active sessions
	getAll(): Session[] {
		const stmt = db.prepare('SELECT * FROM sessions');
		return stmt.all() as Session[];
	}
}

export const sessionRepository = new SessionRepository();
