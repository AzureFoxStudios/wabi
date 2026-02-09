import db from '../database.js';

export interface DbMessage {
	id?: number;
	message_id: string;
	channel_id: string;
	sender_id: string;
	sender_username: string;
	sender_color?: string;
	message_type: 'text' | 'gif' | 'file' | 'emoji';
	content: string;
	gif_url?: string;
	file_url?: string;
	file_name?: string;
	file_size?: number;
	reply_to_id?: string;
	is_spoiler: number;
	is_pinned: number;
	is_edited: number;
	reactions_json?: string;
	created_at: number;
	deleted_at?: number;
}

export interface PaginationOptions {
	limit?: number;        // default 50
	beforeMessageId?: string;  // load older messages
	afterMessageId?: string;   // sync newer messages
}

export interface ClientMessage {
	id: string;
	user: string;
	userId: string;
	text: string;
	timestamp: number;
	type: 'text' | 'gif' | 'file' | 'emoji';
	gifUrl?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	replyTo?: string;
	isSpoiler?: boolean;
	isPinned?: boolean;
	isEdited?: boolean;
	reactions?: Record<string, string[]>;
	color?: string;
}

export class MessageRepository {
	// Create a new message
	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage {
		const stmt = db.prepare(`
			INSERT INTO messages (
				message_id, channel_id, sender_id, sender_username, sender_color,
				message_type, content, gif_url, file_url, file_name, file_size,
				reply_to_id, is_spoiler, is_pinned, is_edited, reactions_json, created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const info = stmt.run(
			message.message_id,
			message.channel_id,
			message.sender_id,
			message.sender_username,
			message.sender_color || null,
			message.message_type,
			message.content,
			message.gif_url || null,
			message.file_url || null,
			message.file_name || null,
			message.file_size || null,
			message.reply_to_id || null,
			message.is_spoiler || 0,
			message.is_pinned || 0,
			message.is_edited || 0,
			message.reactions_json || null,
			message.created_at
		);

		return {
			id: info.lastInsertRowid as number,
			...message
		};
	}

	// Get messages for a channel with pagination
	getByChannel(channelId: string, options: PaginationOptions = {}): DbMessage[] {
		const limit = options.limit || 50;

		let query: string;
		let params: any[];

		if (options.beforeMessageId) {
			// Load older messages (before a specific message)
			const beforeMsg = this.findByMessageId(options.beforeMessageId);
			if (!beforeMsg) {
				return [];
			}
			query = `
				SELECT * FROM messages
				WHERE channel_id = ? AND deleted_at IS NULL AND created_at < ?
				ORDER BY created_at DESC
				LIMIT ?
			`;
			params = [channelId, beforeMsg.created_at, limit];
		} else if (options.afterMessageId) {
			// Load newer messages (after a specific message)
			const afterMsg = this.findByMessageId(options.afterMessageId);
			if (!afterMsg) {
				return [];
			}
			query = `
				SELECT * FROM messages
				WHERE channel_id = ? AND deleted_at IS NULL AND created_at > ?
				ORDER BY created_at ASC
				LIMIT ?
			`;
			params = [channelId, afterMsg.created_at, limit];
		} else {
			// Initial load - get latest messages
			query = `
				SELECT * FROM messages
				WHERE channel_id = ? AND deleted_at IS NULL
				ORDER BY created_at DESC
				LIMIT ?
			`;
			params = [channelId, limit];
		}

		const stmt = db.prepare(query);
		const messages = stmt.all(...params) as DbMessage[];

		// For initial load and beforeMessageId, reverse to get chronological order
		if (!options.afterMessageId) {
			messages.reverse();
		}

		return messages;
	}

	// Find a single message by its message_id
	findByMessageId(messageId: string): DbMessage | null {
		const stmt = db.prepare('SELECT * FROM messages WHERE message_id = ? AND deleted_at IS NULL');
		return (stmt.get(messageId) as DbMessage) || null;
	}

	// Find a single message by its database id
	findById(id: number): DbMessage | null {
		const stmt = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL');
		return (stmt.get(id) as DbMessage) || null;
	}

	// Update a message
	update(messageId: string, updates: Partial<DbMessage>): void {
		const allowedFields = ['content', 'is_spoiler', 'is_pinned', 'is_edited', 'reactions_json'];
		const fields = Object.keys(updates).filter((key) => allowedFields.includes(key));

		if (fields.length === 0) return;

		const setClause = fields.map((field) => `${field} = ?`).join(', ');
		const values = fields.map((field) => updates[field as keyof DbMessage]);

		const stmt = db.prepare(`UPDATE messages SET ${setClause} WHERE message_id = ?`);
		stmt.run(...values, messageId);
	}

	// Soft delete a message
	softDelete(messageId: string): void {
		const stmt = db.prepare('UPDATE messages SET deleted_at = ? WHERE message_id = ?');
		stmt.run(Date.now(), messageId);
	}

	// Check if message exists (for deduplication)
	exists(messageId: string): boolean {
		const stmt = db.prepare('SELECT 1 FROM messages WHERE message_id = ?');
		return stmt.get(messageId) !== undefined;
	}

	// Convert DB message to client format
	toClientFormat(dbMsg: DbMessage): ClientMessage {
		const msg: ClientMessage = {
			id: dbMsg.message_id,
			user: dbMsg.sender_username,
			userId: dbMsg.sender_id,
			text: dbMsg.content,
			timestamp: dbMsg.created_at,
			type: dbMsg.message_type
		};

		if (dbMsg.gif_url) msg.gifUrl = dbMsg.gif_url;
		if (dbMsg.file_url) msg.fileUrl = dbMsg.file_url;
		if (dbMsg.file_name) msg.fileName = dbMsg.file_name;
		if (dbMsg.file_size) msg.fileSize = dbMsg.file_size;
		if (dbMsg.reply_to_id) msg.replyTo = dbMsg.reply_to_id;
		if (dbMsg.is_spoiler) msg.isSpoiler = true;
		if (dbMsg.is_pinned) msg.isPinned = true;
		if (dbMsg.is_edited) msg.isEdited = true;
		if (dbMsg.sender_color) msg.color = dbMsg.sender_color;

		if (dbMsg.reactions_json) {
			try {
				msg.reactions = JSON.parse(dbMsg.reactions_json);
			} catch {
				// Ignore parse errors
			}
		}

		return msg;
	}

	// Get message count for a channel (useful for pagination info)
	getChannelMessageCount(channelId: string): number {
		const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ? AND deleted_at IS NULL');
		const result = stmt.get(channelId) as { count: number };
		return result.count;
	}

	// Update reactions for a message
	updateReactions(messageId: string, reactions: Record<string, string[]>): void {
		const reactionsJson = JSON.stringify(reactions);
		const stmt = db.prepare('UPDATE messages SET reactions_json = ? WHERE message_id = ?');
		stmt.run(reactionsJson, messageId);
	}

	// Toggle pin status
	togglePin(messageId: string): boolean {
		const msg = this.findByMessageId(messageId);
		if (!msg) return false;

		const newPinStatus = msg.is_pinned ? 0 : 1;
		const stmt = db.prepare('UPDATE messages SET is_pinned = ? WHERE message_id = ?');
		stmt.run(newPinStatus, messageId);
		return newPinStatus === 1;
	}

	// Mark message as edited
	markEdited(messageId: string, newContent: string): void {
		const stmt = db.prepare('UPDATE messages SET content = ?, is_edited = 1 WHERE message_id = ?');
		stmt.run(newContent, messageId);
	}
}

export const messageRepository = new MessageRepository();
