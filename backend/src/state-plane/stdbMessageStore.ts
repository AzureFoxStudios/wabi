import {
	messageRepository,
	type ClientMessage,
	type DbMessage,
	type PaginationOptions
} from '../db/repositories/messageRepository.js';
import type { InstrumentedMessageStore, MessageStoreRuntimeStats } from './messageStore.js';
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

function sortMessagesByCreatedAt(rows: DbMessage[]): DbMessage[] {
	return [...rows].sort((a, b) => {
		if (a.created_at !== b.created_at) return a.created_at - b.created_at;
		return a.message_id.localeCompare(b.message_id);
	});
}

function applyPagination(rows: DbMessage[], options: PaginationOptions): DbMessage[] {
	const limit = options.limit || 50;
	const chronological = sortMessagesByCreatedAt(rows);

	if (options.beforeMessageId) {
		const before = chronological.find((row) => row.message_id === options.beforeMessageId);
		if (!before) return [];
		return chronological.filter((row) => row.created_at < before.created_at).slice(-limit);
	}
	if (options.afterMessageId) {
		const after = chronological.find((row) => row.message_id === options.afterMessageId);
		if (!after) return [];
		return chronological.filter((row) => row.created_at > after.created_at).slice(0, limit);
	}
	return chronological.slice(-limit);
}

export class StdbPrimaryMessageStore extends StdbStoreBase implements InstrumentedMessageStore {
	private readonly stats = makeBaseStats();
	private readonly readCanaryPercent = 0;
	private readonly readCanaryEnabled = false;
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

	private parseMessages(rows: Record<string, unknown>[]): DbMessage[] {
		const parsed: DbMessage[] = [];
		for (const row of rows) {
			const message = parseJsonObject<DbMessage>(row.row_json);
			if (!message) continue;
			parsed.push(message);
		}
		return parsed;
	}

	private loadMessage(messageId: string, includeDeleted = false): DbMessage | null {
		const deletedClause = includeDeleted ? '' : ' AND deleted = false';
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_message WHERE message_id = ${escapeSqlLiteral(messageId)}${deletedClause} LIMIT 1`
		);
		if (rows.length === 0) return null;
		return parseJsonObject<DbMessage>(rows[0].row_json) || null;
	}

	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage {
		bumpOperation(this.stats, 'create');
		this.stats.writesAttempted += 1;
		const created: DbMessage = { ...message };
		try {
			this.ingest('message', 'create', {
				messageId: created.message_id,
				channelId: created.channel_id,
				senderId: created.sender_id,
				createdAt: created.created_at,
				row: created
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'create', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'create', () => {
			messageRepository.create(message);
		});
		return created;
	}

	getByChannel(channelId: string, options: PaginationOptions = {}): DbMessage[] {
		bumpOperation(this.stats, 'getByChannel');
		const rows = this.client.sqlRows(
			`SELECT row_json FROM state_message WHERE channel_id = ${escapeSqlLiteral(channelId)} AND deleted = false LIMIT 50000`
		);
		return applyPagination(this.parseMessages(rows), options);
	}

	findByMessageId(messageId: string): DbMessage | null {
		bumpOperation(this.stats, 'findByMessageId');
		return this.loadMessage(messageId, false);
	}

	update(messageId: string, updates: Partial<DbMessage>): void {
		bumpOperation(this.stats, 'update');
		this.stats.writesAttempted += 1;
		const current = this.loadMessage(messageId, true);
		if (!current) return;
		const next: DbMessage = { ...current, ...updates };
		try {
			this.ingest('message', 'update', {
				messageId,
				updates,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'update', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'update', () => {
			messageRepository.update(messageId, updates);
		});
	}

	softDelete(messageId: string): void {
		bumpOperation(this.stats, 'softDelete');
		this.stats.writesAttempted += 1;
		const current = this.loadMessage(messageId, true);
		if (!current) return;
		const deletedAt = nowMs();
		const next: DbMessage = { ...current, deleted_at: deletedAt };
		try {
			this.ingest('message', 'softDelete', {
				messageId,
				deletedAt,
				row: next
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'softDelete', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'softDelete', () => {
			messageRepository.softDelete(messageId);
		});
	}

	toClientFormat(dbMsg: DbMessage): ClientMessage {
		return messageRepository.toClientFormat(dbMsg);
	}

	getChannelMessageCount(channelId: string): number {
		bumpOperation(this.stats, 'getChannelMessageCount');
		const rows = this.client.sqlRows(
			`SELECT COUNT(*) AS count FROM state_message WHERE channel_id = ${escapeSqlLiteral(channelId)} AND deleted = false`
		);
		if (rows.length === 0) return 0;
		return toNumber(rows[0].count);
	}

	updateReactions(messageId: string, reactions: Record<string, string[]>): void {
		this.update(messageId, { reactions_json: JSON.stringify(reactions) });
	}

	markEdited(messageId: string, newContent: string): void {
		this.update(messageId, { content: newContent, is_edited: 1 });
	}

	purgeDeleted(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
		bumpOperation(this.stats, 'purgeDeleted');
		this.stats.writesAttempted += 1;
		const cutoff = nowMs() - olderThanMs;
		const rows = this.client.sqlRows('SELECT row_json FROM state_message WHERE deleted = true LIMIT 50000');
		const candidates = this.parseMessages(rows).filter((message) => (message.deleted_at || 0) > 0 && (message.deleted_at || 0) < cutoff);
		try {
			this.ingest('message', 'purgeDeleted', {
				cutoff,
				messageIds: candidates.map((message) => message.message_id)
			});
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'purgeDeleted', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'purgeDeleted', () => {
			messageRepository.purgeDeleted(olderThanMs);
		});
		return candidates.length;
	}

	clearAll(): number {
		bumpOperation(this.stats, 'clearAll');
		this.stats.writesAttempted += 1;
		const rows = this.client.sqlRows('SELECT COUNT(*) AS count FROM state_message');
		const count = rows.length > 0 ? toNumber(rows[0].count) : 0;
		try {
			this.ingest('message', 'clearAll', { count });
			this.stats.writesSucceeded += 1;
		} catch (error) {
			this.recordWriteFailure(this.stats, 'clearAll', error);
		}
		this.mirrorWrite(this.stats, this.shadow, 'clearAll', () => {
			messageRepository.clearAll();
		});
		return count;
	}

	getRuntimeStats(): MessageStoreRuntimeStats {
		return {
			mode: 'stdb_primary',
			shadow: {
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
				enabled: this.readCanaryEnabled,
				canaryPercent: this.readCanaryPercent,
				attempts: 0,
				canaryRouted: 0,
				shadowServed: 0,
				fallbacks: 0,
				shadowErrors: 0,
				mismatches: 0,
				lastFallbackReason: null,
				lastFallbackAt: null
			},
			outbox: this.outbox?.getStats() || null
		};
	}
}
