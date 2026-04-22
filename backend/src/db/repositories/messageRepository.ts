import db from '../database.js';

export interface DbMessage {
	id?: number;
	message_id: string;
	channel_id: string;
	sender_id: string;
	sender_username: string;
	sender_color?: string;
	message_type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
	content: string;
	gif_url?: string;
	file_url?: string;
	file_name?: string;
	file_size?: number;
	files_json?: string;
	entities_json?: string;
	attachment_encryption_json?: string;
	attachment_storage_json?: string;
	reply_to_id?: string;
	is_spoiler: number;
	is_pinned: number;
	is_edited: number;
	reactions_json?: string;
	is_encrypted?: number;
	encryption_iv?: string;
	expires_at?: number | null;
	created_at: number;
	deleted_at?: number;
}

export interface PaginationOptions {
	limit?: number;        // default 50
	beforeMessageId?: string;  // load older messages
	afterMessageId?: string;   // sync newer messages
}

export interface PlaceMessageEntity {
	kind: 'place';
	start: number;
	end: number;
	placeId: string;
	layerId?: string;
	poiId?: string;
	label: string;
	displayText?: string;
}

export type MessageEntity = PlaceMessageEntity;

export interface ClientMessage {
	id: string;
	user: string;
	userId: string;
	text: string;
	timestamp: number;
	type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate';
	gifUrl?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	files?: { fileUrl: string; fileName: string; fileSize: number; attachmentEncryption?: { scheme: 'dm-e2ee-v1'; iv: string; mimeType?: string; originalSize?: number }; attachmentStorage?: { scheme: 'wabi-storage-v1'; compressed: boolean; codec: 'identity' | 'gzip'; originalSize: number; storedSize: number; atRestEncrypted: boolean } }[];
	entities?: MessageEntity[];
	attachmentEncryption?: { scheme: 'dm-e2ee-v1'; iv: string; mimeType?: string; originalSize?: number };
	attachmentStorage?: { scheme: 'wabi-storage-v1'; compressed: boolean; codec: 'identity' | 'gzip'; originalSize: number; storedSize: number; atRestEncrypted: boolean };
	replyTo?: string;
	isSpoiler?: boolean;
	isPinned?: boolean;
	isEdited?: boolean;
	encrypted?: boolean;
	iv?: string;
	scheduledDeletionTime?: number;
	reactions?: Record<string, string[]>;
	color?: string;
}

export class MessageRepository {
	// Create a new message
	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage {
		const stmt = db.prepare(`
			INSERT INTO messages (
				message_id, channel_id, sender_id, sender_username, sender_color,
				message_type, content, gif_url, file_url, file_name, file_size, files_json, entities_json, attachment_encryption_json,
				attachment_storage_json,
					reply_to_id, is_spoiler, is_pinned, is_edited, reactions_json,
					is_encrypted, encryption_iv, expires_at, created_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			message.files_json || null,
			message.entities_json || null,
			message.attachment_encryption_json || null,
			message.attachment_storage_json || null,
			message.reply_to_id || null,
			message.is_spoiler || 0,
			message.is_pinned || 0,
			message.is_edited || 0,
				message.reactions_json || null,
				message.is_encrypted || 0,
				message.encryption_iv || null,
				message.expires_at ?? null,
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
		const now = Date.now();

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
					WHERE channel_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND created_at < ?
					ORDER BY created_at DESC
					LIMIT ?
				`;
				params = [channelId, now, beforeMsg.created_at, limit];
			} else if (options.afterMessageId) {
			// Load newer messages (after a specific message)
			const afterMsg = this.findByMessageId(options.afterMessageId);
			if (!afterMsg) {
				return [];
			}
				query = `
					SELECT * FROM messages
					WHERE channel_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND created_at > ?
					ORDER BY created_at ASC
					LIMIT ?
				`;
				params = [channelId, now, afterMsg.created_at, limit];
			} else {
			// Initial load - get latest messages
				query = `
					SELECT * FROM messages
					WHERE channel_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
					ORDER BY created_at DESC
					LIMIT ?
				`;
				params = [channelId, now, limit];
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
		const stmt = db.prepare('SELECT * FROM messages WHERE message_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
		return (stmt.get(messageId, Date.now()) as DbMessage) || null;
	}

	// Find a single message by its database id
	findById(id: number): DbMessage | null {
		const stmt = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
		return (stmt.get(id, Date.now()) as DbMessage) || null;
	}

	// Update a message
	update(messageId: string, updates: Partial<DbMessage>): void {
		const allowedFields = ['content', 'entities_json', 'is_spoiler', 'is_pinned', 'is_edited', 'reactions_json'];
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
		if (dbMsg.files_json) {
			try {
				msg.files = JSON.parse(dbMsg.files_json);
			} catch {
				// Ignore parse errors
			}
		}
		if (dbMsg.entities_json) {
			try {
				msg.entities = JSON.parse(dbMsg.entities_json);
			} catch {
				// Ignore parse errors
			}
		}
		if (dbMsg.attachment_encryption_json) {
			try {
				msg.attachmentEncryption = JSON.parse(dbMsg.attachment_encryption_json);
			} catch {
				// Ignore parse errors
			}
		}
		if (dbMsg.attachment_storage_json) {
			try {
				msg.attachmentStorage = JSON.parse(dbMsg.attachment_storage_json);
			} catch {
				// Ignore parse errors
			}
		}
		if (dbMsg.reply_to_id) msg.replyTo = dbMsg.reply_to_id;
		if (dbMsg.is_spoiler) msg.isSpoiler = true;
		if (dbMsg.is_pinned) msg.isPinned = true;
		if (dbMsg.is_edited) msg.isEdited = true;
			if (dbMsg.is_encrypted) msg.encrypted = true;
			if (dbMsg.encryption_iv) msg.iv = dbMsg.encryption_iv;
			if (typeof dbMsg.expires_at === 'number' && Number.isFinite(dbMsg.expires_at)) {
				msg.scheduledDeletionTime = dbMsg.expires_at;
			}
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
		const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
		const result = stmt.get(channelId, Date.now()) as { count: number };
		return result.count;
	}

	purgeExpired(now: number = Date.now()): number {
		const stmt = db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?');
		return stmt.run(now).changes;
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
		const stmt = db.prepare('UPDATE messages SET content = ?, entities_json = NULL, is_edited = 1 WHERE message_id = ?');
		stmt.run(newContent, messageId);
	}

	// Hard-delete soft-deleted messages older than a threshold to reclaim space
	purgeDeleted(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
		const cutoff = Date.now() - olderThanMs;
		const stmt = db.prepare('DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?');
		return stmt.run(cutoff).changes;
	}

	// Delete all persisted messages (admin/server maintenance)
	clearAll(): number {
		const stmt = db.prepare('DELETE FROM messages');
		return stmt.run().changes;
	}
}

export const messageRepository = new MessageRepository();
