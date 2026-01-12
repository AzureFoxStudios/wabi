import db from '../database.js';

export interface OfflineMessage {
	message_id?: number;
	from_user_id?: number;
	from_username: string;
	to_user_id: number;
	channel_id: string;
	message_content: string;
	message_type: string;
	gif_url?: string;
	file_url?: string;
	file_name?: string;
	file_size?: number;
	created_at: number;
	expires_at: number;
	delivered: number;
}

export class OfflineMessageRepository {
	// Queue an offline message
	queue(message: Omit<OfflineMessage, 'message_id' | 'delivered'>): OfflineMessage {
		const stmt = db.prepare(`
			INSERT INTO offline_messages (from_user_id, from_username, to_user_id, channel_id, message_content, message_type, gif_url, file_url, file_name, file_size, created_at, expires_at, delivered)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		`);

		const info = stmt.run(
			message.from_user_id || null,
			message.from_username,
			message.to_user_id,
			message.channel_id,
			message.message_content,
			message.message_type,
			message.gif_url || null,
			message.file_url || null,
			message.file_name || null,
			message.file_size || null,
			message.created_at,
			message.expires_at
		);

		return {
			message_id: info.lastInsertRowid as number,
			...message,
			delivered: 0
		};
	}

	// Get undelivered messages for a user
	getByRecipient(toUserId: number): OfflineMessage[] {
		const stmt = db.prepare(`
			SELECT * FROM offline_messages
			WHERE to_user_id = ? AND delivered = 0
			ORDER BY created_at ASC
		`);
		return stmt.all(toUserId) as OfflineMessage[];
	}

	// Mark messages as delivered
	markDelivered(messageIds: number[]): void {
		if (messageIds.length === 0) return;

		const placeholders = messageIds.map(() => '?').join(',');
		const stmt = db.prepare(`UPDATE offline_messages SET delivered = 1 WHERE message_id IN (${placeholders})`);
		stmt.run(...messageIds);
	}

	// Delete expired messages
	deleteExpired(): number {
		const stmt = db.prepare('DELETE FROM offline_messages WHERE expires_at < ?');
		const info = stmt.run(Date.now());
		return info.changes;
	}

	// Get message count for a user
	getCountByRecipient(toUserId: number): number {
		const stmt = db.prepare('SELECT COUNT(*) as count FROM offline_messages WHERE to_user_id = ? AND delivered = 0');
		const result = stmt.get(toUserId) as { count: number };
		return result.count;
	}
}

export const offlineMessageRepository = new OfflineMessageRepository();
