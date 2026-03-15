import {
	channelRepository,
	type DbChannel
} from '../db/repositories/channelRepository.js';
import db from '../db/database.js';
import type { ChannelStoreRuntimeStats } from './channelStore.js';
import { escapeSqlLiteral } from './stdbSyncClient.js';
import {
	StdbStoreBase,
	bumpOperation,
	makeBaseStats,
	nowMs,
	parseJsonObject,
	type StdbPrimaryStoreOptions,
	toNumber
} from './stdbCommon.js';

export class StdbPrimaryChannelStore extends StdbStoreBase {
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

	private parseChannels(rows: Record<string, unknown>[]): DbChannel[] {
		const parsed: DbChannel[] = [];
		for (const row of rows) {
			const channel = parseJsonObject<DbChannel>(row.row_json);
			if (!channel) continue;
			parsed.push(channel);
		}
		return parsed;
	}

	private loadChannel(channelId: string, includeArchived = false): DbChannel | null {
		if (!includeArchived) {
			const mirrored = channelRepository.findById(channelId);
			if (mirrored) return mirrored;
		}
		const archivedClause = includeArchived ? '' : ' AND archived = false';
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_channel WHERE channel_id = ${escapeSqlLiteral(channelId)}${archivedClause} LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<DbChannel>(rows[0].row_json) || null;
	}

	create(channel: Omit<DbChannel, 'is_archived'>): DbChannel {
		bumpOperation(this.stats, 'create');
		this.stats.writesAttempted += 1;
		const created: DbChannel = { ...channel, is_archived: 0 };
		try {
			this.ingest('channel', 'create', {
				channelId: created.channel_id,
				channelType: created.channel_type,
				row: created
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'create', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'create', () => {
			channelRepository.create(channel);
		});
		return created;
	}

	findById(channelId: string): DbChannel | null {
		bumpOperation(this.stats, 'findById');
		return this.loadChannel(channelId, false);
	}

	findByUserId(userId: string): DbChannel[] {
		bumpOperation(this.stats, 'findByUserId');
		const mirrored = channelRepository.findByUserId(userId);
		if (mirrored.length > 0) {
			return mirrored.sort((a, b) => b.created_at - a.created_at);
		}
		try {
			const rows = this.client.sqlRows(
				`SELECT c.row_json AS row_json
				 FROM state_channel AS c
				 INNER JOIN state_channel_member AS m ON m.channel_id = c.channel_id
				 WHERE m.user_id = ${escapeSqlLiteral(userId)}
				   AND m.active = true
				   AND c.archived = false
				 LIMIT 50000`
			);
			return this.parseChannels(rows).sort((a, b) => b.created_at - a.created_at);
		} catch {
			// Compatibility fallback for SQL engines without join support.
			const memberRows = this.client.sqlRows(
				`SELECT channel_id FROM state_channel_member WHERE user_id = ${escapeSqlLiteral(userId)} AND active = true LIMIT 50000`
			);
			const channelIds = Array.from(new Set(memberRows.map((row) => String(row.channel_id || '')).filter(Boolean)));
			const channels: DbChannel[] = [];
			for (const channelId of channelIds) {
				const channel = this.loadChannel(channelId, false);
				if (channel) channels.push(channel);
			}
			return channels.sort((a, b) => b.created_at - a.created_at);
		}
	}

	findDMBetween(userId1: string, userId2: string): DbChannel | null {
		const memberIds = [userId1, userId2].sort();
		const dmId = `dm-${memberIds.join('-')}`;
		const channel = this.findById(dmId);
		if (!channel || channel.channel_type !== 'dm') return null;
		return channel;
	}

	getWorkspaceChannels(): DbChannel[] {
		bumpOperation(this.stats, 'getWorkspaceChannels');
		const mirrored = channelRepository.getWorkspaceChannels();
		if (mirrored.length > 0) {
			return mirrored.sort((a, b) => a.created_at - b.created_at);
		}
		const rows = this.client.sqlRows('SELECT row_json FROM state_channel WHERE archived = false LIMIT 50000');
		const channels = this.parseChannels(rows).filter((channel) => {
			return (
				channel.channel_type === 'text' ||
				channel.channel_type === 'voice' ||
				channel.channel_type === 'public' ||
				channel.channel_type === 'thread_public'
			);
		});
		return channels.sort((a, b) => a.created_at - b.created_at);
	}

	archive(channelId: string): void {
		bumpOperation(this.stats, 'archive');
		this.stats.writesAttempted += 1;
		const current = this.loadChannel(channelId, true);
		if (!current) return;
		const next: DbChannel = { ...current, is_archived: 1 };
		try {
			this.ingest('channel', 'archive', { channelId, row: next });
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'archive', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'archive', () => {
			channelRepository.archive(channelId);
		});
	}

	ensureBaseChannelsExist(): void {
		if (!this.findById('general')) {
			this.create({
				channel_id: 'general',
				channel_type: 'text',
				name: 'general',
				description: '',
				created_at: nowMs(),
				created_by: 'system',
				persist_messages: 0
			});
		}
		if (!this.findById('voice')) {
			this.create({
				channel_id: 'voice',
				channel_type: 'voice',
				name: 'voice',
				description: '',
				created_at: nowMs(),
				created_by: 'system',
				persist_messages: 0
			});
		}
	}

	updateSettings(
		channelId: string,
		settings: {
			name?: string;
			persist_messages?: number;
			description?: string;
			min_role?: string;
			voice_settings_json?: string | null;
			watch_queue_enabled?: number;
		}
	): void {
		bumpOperation(this.stats, 'update_settings');
		this.stats.writesAttempted += 1;
		const current = this.loadChannel(channelId, true);
		if (!current) return;
		const next: DbChannel = {
			...current,
			name: settings.name ?? current.name,
			persist_messages: settings.persist_messages ?? current.persist_messages,
			description: settings.description ?? current.description,
			min_role: settings.min_role ?? current.min_role,
			watch_queue_enabled: settings.watch_queue_enabled ?? current.watch_queue_enabled,
			voice_settings_json:
				settings.voice_settings_json !== undefined ? settings.voice_settings_json : current.voice_settings_json
		};
		try {
			this.ingest('channel', 'update_settings', {
				channelId,
				settings,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update_settings', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'update_settings', () => {
			channelRepository.updateSettings(channelId, settings);
		});
	}

	delete(channelId: string): void {
		bumpOperation(this.stats, 'delete');
		this.stats.writesAttempted += 1;
		try {
			this.ingest('channel', 'delete', { channelId });
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'delete', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'delete', () => {
			channelRepository.delete(channelId);
		});
	}

	exists(channelId: string): boolean {
		bumpOperation(this.stats, 'exists');
		const rows = this.client.sqlRows(
			`SELECT COUNT(*) AS count FROM state_channel WHERE channel_id = ${escapeSqlLiteral(channelId)} AND archived = false`
		);
		return rows.length > 0 && toNumber(rows[0].count) > 0;
	}

	updateAvatar(channelId: string, avatarUrl: string | null): void {
		bumpOperation(this.stats, 'update_avatar');
		this.stats.writesAttempted += 1;
		const current = this.loadChannel(channelId, true);
		if (!current) return;
		const next: DbChannel = { ...current, avatar: avatarUrl || undefined };
		try {
			this.ingest('channel', 'update_avatar', {
				channelId,
				avatarUrl,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update_avatar', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'update_avatar', () => {
			channelRepository.updateAvatar(channelId, avatarUrl);
		});
	}

	warmFromPrimary(limit: number): number {
		const safeLimit = Math.max(0, Math.floor(limit));
		if (safeLimit === 0) return 0;
		const existingIds = new Set(
			this.client.sqlRows('SELECT channel_id FROM state_channel LIMIT 50000')
				.map((row) => String(row.channel_id || '').trim())
				.filter((channelId) => channelId.length > 0)
		);

		const rows = db.prepare(`
			SELECT * FROM channels
			WHERE is_archived = 0
			ORDER BY created_at ASC
			LIMIT ?
		`).all(safeLimit) as DbChannel[];

		let seeded = 0;
		for (const row of rows) {
			if (existingIds.has(row.channel_id)) continue;
			this.ingest('channel', 'create', {
				channelId: row.channel_id,
				channelType: row.channel_type,
				row
			});
			seeded += 1;
		}

		this.stats.operations.warmup = (this.stats.operations.warmup || 0) + 1;
		this.stats.operations.warmup_rows = seeded;
		return seeded;
	}

	getRuntimeStats(): ChannelStoreRuntimeStats {
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
