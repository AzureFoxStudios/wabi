import db from '../database.js';

export interface DbChannel {
	channel_id: string;
	channel_type: 'public' | 'dm' | 'group';
	name: string;
	description: string;
	created_at: number;
	created_by?: string;
	persist_messages: number;
	is_archived: number;
}

export class ChannelRepository {
	// Create a new channel
	create(channel: Omit<DbChannel, 'is_archived'>): DbChannel {
		const stmt = db.prepare(`
			INSERT INTO channels (channel_id, channel_type, name, description, created_at, created_by, persist_messages, is_archived)
			VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		`);

		stmt.run(
			channel.channel_id,
			channel.channel_type,
			channel.name,
			channel.description || '',
			channel.created_at,
			channel.created_by || null,
			channel.persist_messages ?? 1
		);

		return {
			...channel,
			is_archived: 0
		};
	}

	// Find channel by ID
	findById(channelId: string): DbChannel | null {
		const stmt = db.prepare('SELECT * FROM channels WHERE channel_id = ? AND is_archived = 0');
		return (stmt.get(channelId) as DbChannel) || null;
	}

	// Find all channels for a user (via channel_members)
	findByUserId(userId: string): DbChannel[] {
		const stmt = db.prepare(`
			SELECT c.* FROM channels c
			INNER JOIN channel_members cm ON c.channel_id = cm.channel_id
			WHERE cm.user_id = ? AND c.is_archived = 0
			ORDER BY c.created_at DESC
		`);
		return stmt.all(userId) as DbChannel[];
	}

	// Find existing DM between two users
	findDMBetween(userId1: string, userId2: string): DbChannel | null {
		// DM channel IDs are formatted as "dm-{sortedUserId1}-{sortedUserId2}"
		const memberIds = [userId1, userId2].sort();
		const dmId = `dm-${memberIds.join('-')}`;

		const stmt = db.prepare(`
			SELECT * FROM channels
			WHERE channel_id = ? AND channel_type = 'dm' AND is_archived = 0
		`);
		return (stmt.get(dmId) as DbChannel) || null;
	}

	// Get all public channels
	getPublicChannels(): DbChannel[] {
		const stmt = db.prepare(`
			SELECT * FROM channels
			WHERE channel_type = 'public' AND is_archived = 0
			ORDER BY created_at ASC
		`);
		return stmt.all() as DbChannel[];
	}

	// Archive a channel (soft delete)
	archive(channelId: string): void {
		const stmt = db.prepare('UPDATE channels SET is_archived = 1 WHERE channel_id = ?');
		stmt.run(channelId);
	}

	// Ensure general channel exists
	ensureGeneralExists(): void {
		const existing = this.findById('general');
		if (!existing) {
			this.create({
				channel_id: 'general',
				channel_type: 'public',
				name: 'general',
				created_at: Date.now(),
				created_by: 'system',
				persist_messages: 1
			});
			console.log('[ChannelRepository] Created general channel');
		}
	}

	// Update channel settings
	updateSettings(channelId: string, settings: { persist_messages?: number; description?: string }): void {
		const updates: string[] = [];
		const values: any[] = [];

		if (settings.persist_messages !== undefined) {
			updates.push('persist_messages = ?');
			values.push(settings.persist_messages);
		}

		if (settings.description !== undefined) {
			updates.push('description = ?');
			values.push(settings.description);
		}

		if (updates.length === 0) return;

		values.push(channelId);
		const stmt = db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE channel_id = ?`);
		stmt.run(...values);
	}

	// Delete a channel (CASCADE deletes members + messages)
	delete(channelId: string): void {
		const stmt = db.prepare('DELETE FROM channels WHERE channel_id = ?');
		stmt.run(channelId);
	}

	// Check if channel exists
	exists(channelId: string): boolean {
		const stmt = db.prepare('SELECT 1 FROM channels WHERE channel_id = ? AND is_archived = 0');
		return stmt.get(channelId) !== undefined;
	}
}

export const channelRepository = new ChannelRepository();
