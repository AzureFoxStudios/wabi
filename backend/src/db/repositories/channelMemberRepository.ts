import db from '../database.js';

export interface DbChannelMember {
	id?: number;
	channel_id: string;
	user_id: string;
	username: string;
	registered_user_id?: number;
	joined_at: number;
	role: 'owner' | 'admin' | 'member';
}

export class ChannelMemberRepository {
	// Add a member to a channel
	addMember(member: Omit<DbChannelMember, 'id'>): DbChannelMember {
		const stmt = db.prepare(`
			INSERT OR IGNORE INTO channel_members (channel_id, user_id, username, registered_user_id, joined_at, role)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		const info = stmt.run(
			member.channel_id,
			member.user_id,
			member.username,
			member.registered_user_id || null,
			member.joined_at,
			member.role || 'member'
		);

		return {
			id: info.lastInsertRowid as number,
			...member
		};
	}

	// Get all members of a channel
	getMembers(channelId: string): DbChannelMember[] {
		const stmt = db.prepare(`
			SELECT * FROM channel_members
			WHERE channel_id = ?
			ORDER BY joined_at ASC
		`);
		return stmt.all(channelId) as DbChannelMember[];
	}

	// Get user IDs only (for quick membership lookups)
	getMemberIds(channelId: string): string[] {
		const stmt = db.prepare(`
			SELECT user_id FROM channel_members
			WHERE channel_id = ?
		`);
		const rows = stmt.all(channelId) as { user_id: string }[];
		return rows.map(r => r.user_id);
	}

	// Check if user is a member of a channel
	isMember(channelId: string, userId: string): boolean {
		const stmt = db.prepare(`
			SELECT 1 FROM channel_members
			WHERE channel_id = ? AND user_id = ?
		`);
		return stmt.get(channelId, userId) !== undefined;
	}

	// Remove a member from a channel
	removeMember(channelId: string, userId: string): void {
		const stmt = db.prepare(`
			DELETE FROM channel_members
			WHERE channel_id = ? AND user_id = ?
		`);
		stmt.run(channelId, userId);
	}

	// Get all channels for a user
	getUserChannels(userId: string): { channel_id: string; role: string }[] {
		const stmt = db.prepare(`
			SELECT channel_id, role FROM channel_members
			WHERE user_id = ?
		`);
		return stmt.all(userId) as { channel_id: string; role: string }[];
	}

	// Update member info (e.g., when username changes or they register)
	updateMember(channelId: string, userId: string, updates: Partial<DbChannelMember>): void {
		const allowedFields = ['username', 'registered_user_id', 'role'];
		const fields = Object.keys(updates).filter((key) => allowedFields.includes(key));

		if (fields.length === 0) return;

		const setClause = fields.map((field) => `${field} = ?`).join(', ');
		const values = fields.map((field) => updates[field as keyof DbChannelMember]);

		const stmt = db.prepare(`UPDATE channel_members SET ${setClause} WHERE channel_id = ? AND user_id = ?`);
		stmt.run(...values, channelId, userId);
	}

	// Get member by user ID in a channel
	getMember(channelId: string, userId: string): DbChannelMember | null {
		const stmt = db.prepare(`
			SELECT * FROM channel_members
			WHERE channel_id = ? AND user_id = ?
		`);
		return (stmt.get(channelId, userId) as DbChannelMember) || null;
	}

	// Bulk add members (for group creation)
	addMembers(members: Omit<DbChannelMember, 'id'>[]): void {
		const stmt = db.prepare(`
			INSERT OR IGNORE INTO channel_members (channel_id, user_id, username, registered_user_id, joined_at, role)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		const insertMany = db.transaction((membersToAdd: Omit<DbChannelMember, 'id'>[]) => {
			for (const member of membersToAdd) {
				stmt.run(
					member.channel_id,
					member.user_id,
					member.username,
					member.registered_user_id || null,
					member.joined_at,
					member.role || 'member'
				);
			}
		});

		insertMany(members);
	}
}

export const channelMemberRepository = new ChannelMemberRepository();
