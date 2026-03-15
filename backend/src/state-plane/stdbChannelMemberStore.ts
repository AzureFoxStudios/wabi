import {
	channelMemberRepository,
	type DbChannelMember
} from '../db/repositories/channelMemberRepository.js';
import db from '../db/database.js';
import type { ChannelMemberStoreRuntimeStats } from './channelMemberStore.js';
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
	private readonly shadow = {
		attempted: 0,
		succeeded: 0,
		failed: 0,
		lastError: null as string | null,
		lastErrorAt: null as number | null
	};

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
		if (activeOnly) {
			const mirrored = channelMemberRepository.getMember(channelId, userId);
			if (mirrored) return mirrored;
		}
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
		this.mirrorWrite(this.stats, this.shadow, 'add_member', () => {
			channelMemberRepository.addMember(member);
		});
		return added;
	}

	getMembers(channelId: string): DbChannelMember[] {
		bumpOperation(this.stats, 'getMembers');
		const mirrored = channelMemberRepository.getMembers(channelId);
		if (mirrored.length > 0) {
			return mirrored;
		}
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_channel_member WHERE channel_id = ${escapeSqlLiteral(channelId)} AND active = true LIMIT 50000`
		);
		return this.parseMembers(rows).sort((a, b) => a.joined_at - b.joined_at);
	}

	getMemberIds(channelId: string): string[] {
		bumpOperation(this.stats, 'getMemberIds');
		const mirrored = channelMemberRepository.getMemberIds(channelId);
		if (mirrored.length > 0) {
			return mirrored;
		}
		const rows = this.client.sqlRows(
			`SELECT user_id FROM state_channel_member WHERE channel_id = ${escapeSqlLiteral(channelId)} AND active = true LIMIT 50000`
		);
		return rows
			.map((row) => String(row.user_id || ''))
			.filter((userId) => userId.length > 0);
	}

	isMember(channelId: string, userId: string): boolean {
		bumpOperation(this.stats, 'isMember');
		if (channelMemberRepository.isMember(channelId, userId)) {
			return true;
		}
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
		this.mirrorWrite(this.stats, this.shadow, 'remove_member', () => {
			channelMemberRepository.removeMember(channelId, userId);
		});
	}

	getUserChannels(userId: string): { channel_id: string; role: string }[] {
		bumpOperation(this.stats, 'getUserChannels');
		const mirrored = channelMemberRepository.getUserChannels(userId);
		if (mirrored.length > 0) {
			return mirrored;
		}
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
		this.mirrorWrite(this.stats, this.shadow, 'update_member', () => {
			channelMemberRepository.updateMember(channelId, userId, updates);
		});
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

	warmFromPrimary(limit: number): number {
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;
		const existingKeys = new Set(
			this.client.sqlRows('SELECT member_key FROM state_channel_member LIMIT 50000')
				.map((row) => String(row.member_key || '').trim())
				.filter((memberKey) => memberKey.length > 0)
		);

		const rows = db.prepare(`
			SELECT * FROM channel_members
			ORDER BY channel_id ASC, joined_at ASC, user_id ASC
			LIMIT ?
		`).all(safeLimit) as DbChannelMember[];

		let seeded = 0;
		for (const row of rows) {
			if (existingKeys.has(channelMemberKey(row.channel_id, row.user_id))) continue;
			this.ingest('channel_member', 'add_member', {
				channelId: row.channel_id,
				userId: row.user_id,
				role: row.role,
				row
			});
			seeded += 1;
		}

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = seeded;
		return seeded;
	}

	getRuntimeStats(): ChannelMemberStoreRuntimeStats {
		return {
			mode: 'stdb_primary',
			writesAttempted: this.stats.writesAttempted,
			writesSucceeded: this.stats.writesSucceeded,
			writesFailed: this.stats.writesFailed,
			lastError: this.stats.lastError,
			lastErrorAt: this.stats.lastErrorAt,
			operations: { ...this.stats.operations },
			shadow: {
				enabled: this.mirrorLegacyWrites,
				label: this.mirrorLegacyWrites ? 'legacy-mirror' : 'none',
				writesAttempted: this.shadow.attempted,
				writesSucceeded: this.shadow.succeeded,
				writesFailed: this.shadow.failed,
				lastError: this.shadow.lastError,
				lastErrorAt: this.shadow.lastErrorAt
			},
			parity: {
				samples: 0,
				mismatches: 0,
				lastMismatch: null,
				lastMismatchAt: null
			},
			readSwitch: {
				enabled: false,
				canaryPercent: 0,
				attempts: 0,
				canaryRouted: 0,
				shadowServed: 0,
				fallbacks: 0,
				shadowErrors: 0,
				mismatches: 0,
				lastFallbackReason: null,
				lastFallbackAt: null
			}
		};
	}
}
