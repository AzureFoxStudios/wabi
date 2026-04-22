import db from '../database.js';

const createChannelStmt = db.prepare(`
	INSERT INTO channels (
			channel_id, channel_type, name, description, min_role, voice_settings_json, created_at, created_by, persist_messages, auto_delete_after, watch_queue_enabled,
			is_archived, parent_channel_id, is_breakout, breakout_index, parent_message_id, thread_archived, thread_locked,
			thread_auto_archive_minutes, thread_last_activity_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const findChannelByIdStmt = db.prepare('SELECT * FROM channels WHERE channel_id = ? AND is_archived = 0');
const findChannelsByUserIdStmt = db.prepare(`
	SELECT c.* FROM channels c
	INNER JOIN channel_members cm ON c.channel_id = cm.channel_id
	WHERE cm.user_id = ? AND c.is_archived = 0
	ORDER BY c.created_at DESC
`);
const findDmBetweenStmt = db.prepare(`
	SELECT * FROM channels
	WHERE channel_id = ? AND channel_type = 'dm' AND is_archived = 0
`);
const getWorkspaceChannelsStmt = db.prepare(`
	SELECT * FROM channels
	WHERE channel_type IN ('text', 'voice', 'public', 'thread_public') AND is_archived = 0
	ORDER BY created_at ASC
`);
const archiveChannelStmt = db.prepare('UPDATE channels SET is_archived = 1 WHERE channel_id = ?');
const normalizeBaseChannelTypeStmt = db.prepare('UPDATE channels SET channel_type = ?, persist_messages = ? WHERE channel_id = ?');
const deleteChannelStmt = db.prepare('DELETE FROM channels WHERE channel_id = ?');
const channelExistsStmt = db.prepare('SELECT 1 FROM channels WHERE channel_id = ? AND is_archived = 0');
const updateChannelAvatarStmt = db.prepare('UPDATE channels SET avatar = ? WHERE channel_id = ?');

export interface DbChannel {
	channel_id: string;
	channel_type: 'text' | 'voice' | 'public' | 'dm' | 'group' | 'thread_public' | 'thread_private';
	name: string;
	description: string;
	min_role?: string;
	voice_settings_json?: string | null;
	watch_queue_enabled?: number;
	created_at: number;
	created_by?: string;
	persist_messages: number;
	auto_delete_after?: string | null;
	is_archived: number;
	avatar?: string;
	parent_channel_id?: string | null;
	is_breakout?: number;
	breakout_index?: number | null;
	parent_message_id?: string | null;
	thread_archived?: number;
	thread_locked?: number;
	thread_auto_archive_minutes?: number;
	thread_last_activity_at?: number | null;
}

export class ChannelRepository {
	// Create a new channel
	create(channel: Omit<DbChannel, 'is_archived'>): DbChannel {
		createChannelStmt.run(
			channel.channel_id,
			channel.channel_type,
			channel.name,
			channel.description || '',
			channel.min_role || 'guest',
			channel.voice_settings_json ?? null,
				channel.created_at,
				channel.created_by || null,
				channel.persist_messages ?? 0,
				channel.auto_delete_after ?? null,
				channel.watch_queue_enabled ?? 0,
				channel.parent_channel_id || null,
			channel.is_breakout ?? 0,
			channel.breakout_index ?? null,
			channel.parent_message_id || null,
			channel.thread_archived ?? 0,
			channel.thread_locked ?? 0,
			channel.thread_auto_archive_minutes ?? 1440,
			channel.thread_last_activity_at ?? channel.created_at
		);

		return {
			...channel,
			is_archived: 0
		};
	}

	// Find channel by ID
	findById(channelId: string): DbChannel | null {
		return (findChannelByIdStmt.get(channelId) as DbChannel) || null;
	}

	// Find all channels for a user (via channel_members)
	findByUserId(userId: string): DbChannel[] {
		return findChannelsByUserIdStmt.all(userId) as DbChannel[];
	}

	// Find existing DM between two users
	findDMBetween(userId1: string, userId2: string): DbChannel | null {
		// DM channel IDs are formatted as "dm-{sortedUserId1}-{sortedUserId2}"
		const memberIds = [userId1, userId2].sort();
		const dmId = `dm-${memberIds.join('-')}`;

		return (findDmBetweenStmt.get(dmId) as DbChannel) || null;
	}

	// Get all workspace channels (text/voice plus legacy public)
	getWorkspaceChannels(): DbChannel[] {
		return getWorkspaceChannelsStmt.all() as DbChannel[];
	}

	// Archive a channel (soft delete)
	archive(channelId: string): void {
		archiveChannelStmt.run(channelId);
	}

	// Ensure default base channels exist (1 text + 1 voice)
	ensureBaseChannelsExist(): void {
		const existing = this.findById('general');
		if (!existing) {
			this.create({
				channel_id: 'general',
				channel_type: 'text',
				name: 'general',
				created_at: Date.now(),
				created_by: 'system',
				persist_messages: 0
			});
			console.log('[ChannelRepository] Created default text channel: general');
		} else if (existing.channel_type !== 'text') {
			// Canonicalize legacy base channel type to explicit text
			normalizeBaseChannelTypeStmt.run('text', 0, 'general');
			console.log(`[ChannelRepository] Normalized base channel type: general (${existing.channel_type} -> text)`);
		}

		const existingVoice = this.findById('voice');
		if (!existingVoice) {
			this.create({
				channel_id: 'voice',
				channel_type: 'voice',
				name: 'voice',
				created_at: Date.now(),
				created_by: 'system',
				persist_messages: 0
			});
			console.log('[ChannelRepository] Created default voice channel: voice');
		} else if (existingVoice.channel_type !== 'voice') {
			// Canonicalize legacy/mis-typed base voice channel
			normalizeBaseChannelTypeStmt.run('voice', 0, 'voice');
			console.log(`[ChannelRepository] Normalized base channel type: voice (${existingVoice.channel_type} -> voice)`);
		}
	}

	// Update channel settings
	updateSettings(channelId: string, settings: { name?: string; persist_messages?: number; auto_delete_after?: string | null; description?: string; min_role?: string; voice_settings_json?: string | null; watch_queue_enabled?: number }): void {
		const updates: string[] = [];
		const values: any[] = [];

		if (settings.name !== undefined) {
			updates.push('name = ?');
			values.push(settings.name);
		}

		if (settings.persist_messages !== undefined) {
			updates.push('persist_messages = ?');
			values.push(settings.persist_messages);
		}

		if (settings.auto_delete_after !== undefined) {
			updates.push('auto_delete_after = ?');
			values.push(settings.auto_delete_after);
		}

		if (settings.description !== undefined) {
			updates.push('description = ?');
			values.push(settings.description);
		}

		if (settings.min_role !== undefined) {
			updates.push('min_role = ?');
			values.push(settings.min_role);
		}

		if (settings.voice_settings_json !== undefined) {
			updates.push('voice_settings_json = ?');
			values.push(settings.voice_settings_json);
		}

		if (settings.watch_queue_enabled !== undefined) {
			updates.push('watch_queue_enabled = ?');
			values.push(settings.watch_queue_enabled);
		}

		if (updates.length === 0) return;

		values.push(channelId);
		const stmt = db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE channel_id = ?`);
		stmt.run(...values);
	}

	// Delete a channel (CASCADE deletes members + messages)
	delete(channelId: string): void {
		deleteChannelStmt.run(channelId);
	}

	// Check if channel exists
	exists(channelId: string): boolean {
		return channelExistsStmt.get(channelId) !== undefined;
	}

	// Update group avatar
	updateAvatar(channelId: string, avatarUrl: string | null): void {
		updateChannelAvatarStmt.run(avatarUrl, channelId);
	}
}

export const channelRepository = new ChannelRepository();
