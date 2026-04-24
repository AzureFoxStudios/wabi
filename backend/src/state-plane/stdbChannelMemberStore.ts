import type { DbChannelMember } from './records.js';
import type { ChannelMemberStoreRuntimeStats } from './storeTypes.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	parseJsonObject,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';

function channelMemberKey(channelId: string, userId: string): string {
	return `${channelId}:${userId}`;
}

export class StdbPrimaryChannelMemberStore extends StdbStoreBase {
	private readonly stats = makeBaseStats();

	constructor(options: StdbPrimaryStoreOptions = {}) {
		super(options);
	}

	private parseMembers(rows: Record<string, unknown>[]): DbChannelMember[] {
		const parsed: DbChannelMember[] = [];
		for (const row of rows) {
			const member = parseJsonObject<DbChannelMember>(row.row_json);
			if (!member) continue;
			parsed.push(member);
		}
		return parsed;
	}

	private loadMember(channelId: string, userId: string, activeOnly = true): DbChannelMember | null {
		const activeClause = activeOnly ? ' AND active = true' : '';
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_channel_member WHERE member_key = ${escapeSqlLiteral(channelMemberKey(channelId, userId))}${activeClause} LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<DbChannelMember>(rows[0].row_json) || null;
	}

	addMember(member: Omit<DbChannelMember, 'id'>): DbChannelMember {
		bumpOperation(this.stats, 'add_member');
		this.stats.writesAttempted += 1;
		const added: DbChannelMember = { ...member };
		try {
			this.ingest('channel_member', 'add_member', {
				channelId: member.channel_id,
				userId: member.user_id,
				role: member.role,
				row: added
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'add_member', error);
		}
		return added;
	}

	getMembers(channelId: string): DbChannelMember[] {
		bumpOperation(this.stats, 'getMembers');
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_channel_member WHERE channel_id = ${escapeSqlLiteral(channelId)} AND active = true LIMIT 50000`
		);
		return this.parseMembers(rows).sort((a, b) => a.joined_at - b.joined_at);
	}

	getMemberIds(channelId: string): string[] {
		bumpOperation(this.stats, 'getMemberIds');
		const rows = this.client.sqlRows(
			`SELECT user_id FROM state_channel_member WHERE channel_id = ${escapeSqlLiteral(channelId)} AND active = true LIMIT 50000`
		);
		return rows
			.map((row) => String(row.user_id || ''))
			.filter((userId) => userId.length > 0);
	}

	isMember(channelId: string, userId: string): boolean {
		bumpOperation(this.stats, 'isMember');
		const rows = this.client.sqlRows(
			`SELECT COUNT(*) AS count FROM state_channel_member WHERE member_key = ${escapeSqlLiteral(channelMemberKey(channelId, userId))} AND active = true`
		);
		return rows.length > 0 && toNumber(rows[0].count) > 0;
	}

	removeMember(channelId: string, userId: string): void {
		bumpOperation(this.stats, 'remove_member');
		this.stats.writesAttempted += 1;
		try {
			this.ingest('channel_member', 'remove_member', { channelId, userId });
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'remove_member', error);
		}
	}

	getUserChannels(userId: string): { channel_id: string; role: string }[] {
		bumpOperation(this.stats, 'getUserChannels');
		const rows = this.client.sqlRows(
			`SELECT channel_id, role FROM state_channel_member WHERE user_id = ${escapeSqlLiteral(userId)} AND active = true LIMIT 50000`
		);
		return rows
			.map((row) => ({ channel_id: String(row.channel_id || ''), role: String(row.role || 'member') }))
			.filter((row) => row.channel_id.length > 0);
	}

	updateMember(channelId: string, userId: string, updates: Partial<DbChannelMember>): void {
		bumpOperation(this.stats, 'update_member');
		this.stats.writesAttempted += 1;
		const current = this.loadMember(channelId, userId, false);
		if (!current) return;
		const next: DbChannelMember = { ...current, ...updates };
		try {
			this.ingest('channel_member', 'update_member', {
				channelId,
				userId,
				updates,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update_member', error);
		}
	}

	getMember(channelId: string, userId: string): DbChannelMember | null {
		bumpOperation(this.stats, 'getMember');
		return this.loadMember(channelId, userId, true);
	}

	addMembers(members: Omit<DbChannelMember, 'id'>[]): void {
		bumpOperation(this.stats, 'add_members_bulk');
		for (const member of members) {
			this.addMember(member);
		}
	}

	getRuntimeStats(): ChannelMemberStoreRuntimeStats {
		return {
			mode: 'stdb_primary',
			writesAttempted: this.stats.writesAttempted,
			writesSucceeded: this.stats.writesSucceeded,
			writesFailed: this.stats.writesFailed,
			lastError: this.stats.lastError,
			lastErrorAt: this.stats.lastErrorAt,
			operations: { ...this.stats.operations }
		};
	}
}
