import {
	messageRepository,
	type ClientMessage,
	type DbMessage,
	type PaginationOptions
} from '../db/repositories/messageRepository.js';
import { type StatePlaneOutbox, type StatePlaneOutboxStats } from './outbox.js';

export interface MessageStore {
	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage;
	getByChannel(channelId: string, options?: PaginationOptions): DbMessage[];
	findByMessageId(messageId: string): DbMessage | null;
	update(messageId: string, updates: Partial<DbMessage>): void;
	softDelete(messageId: string): void;
	toClientFormat(dbMsg: DbMessage): ClientMessage;
	getChannelMessageCount(channelId: string): number;
	updateReactions(messageId: string, reactions: Record<string, string[]>): void;
	markEdited(messageId: string, newContent: string): void;
	purgeDeleted(olderThanMs?: number): number;
	clearAll(): number;
}

export interface MessageStoreRuntimeStats {
	mode: 'legacy' | 'dual_write' | 'stdb_primary';
	shadow: {
		label: string;
		writesAttempted: number;
		writesSucceeded: number;
		writesFailed: number;
		lastError: string | null;
		lastErrorAt: number | null;
	};
	parity: {
		samples: number;
		mismatches: number;
		lastMismatch: string | null;
		lastMismatchAt: number | null;
	};
	readSwitch: {
		enabled: boolean;
		canaryPercent: number;
		attempts: number;
		canaryRouted: number;
		shadowServed: number;
		fallbacks: number;
		shadowErrors: number;
		mismatches: number;
		lastFallbackReason: string | null;
		lastFallbackAt: number | null;
	};
	outbox: StatePlaneOutboxStats | null;
}

export interface InstrumentedMessageStore extends MessageStore {
	getRuntimeStats(): MessageStoreRuntimeStats;
}

export class LegacyMessageStore implements InstrumentedMessageStore {
	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage {
		return messageRepository.create(message);
	}

	getByChannel(channelId: string, options: PaginationOptions = {}): DbMessage[] {
		return messageRepository.getByChannel(channelId, options);
	}

	findByMessageId(messageId: string): DbMessage | null {
		return messageRepository.findByMessageId(messageId);
	}

	update(messageId: string, updates: Partial<DbMessage>): void {
		messageRepository.update(messageId, updates);
	}

	softDelete(messageId: string): void {
		messageRepository.softDelete(messageId);
	}

	toClientFormat(dbMsg: DbMessage): ClientMessage {
		return messageRepository.toClientFormat(dbMsg);
	}

	getChannelMessageCount(channelId: string): number {
		return messageRepository.getChannelMessageCount(channelId);
	}

	updateReactions(messageId: string, reactions: Record<string, string[]>): void {
		messageRepository.updateReactions(messageId, reactions);
	}

	markEdited(messageId: string, newContent: string): void {
		messageRepository.markEdited(messageId, newContent);
	}

	purgeDeleted(olderThanMs?: number): number {
		return messageRepository.purgeDeleted(olderThanMs);
	}

	clearAll(): number {
		return messageRepository.clearAll();
	}

	getRuntimeStats(): MessageStoreRuntimeStats {
		return {
			mode: 'legacy',
			shadow: {
				label: 'none',
				writesAttempted: 0,
				writesSucceeded: 0,
				writesFailed: 0,
				lastError: null,
				lastErrorAt: null
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
			},
			outbox: null
		};
	}
}

export class InMemoryShadowMessageStore implements MessageStore {
	private messagesById = new Map<string, DbMessage>();
	private channelMessageIds = new Map<string, Set<string>>();

	private cloneMessage(message: DbMessage): DbMessage {
		return {
			...message,
			reactions_json: message.reactions_json ?? undefined,
			files_json: message.files_json ?? undefined,
			entities_json: message.entities_json ?? undefined,
			attachment_encryption_json: message.attachment_encryption_json ?? undefined,
			attachment_storage_json: message.attachment_storage_json ?? undefined
		};
	}

	private getChannelRows(channelId: string): DbMessage[] {
		const ids = this.channelMessageIds.get(channelId);
		if (!ids || ids.size === 0) return [];
		const rows: DbMessage[] = [];
		for (const id of ids) {
			const row = this.messagesById.get(id);
			if (row) rows.push(this.cloneMessage(row));
		}
		return rows;
	}

	private addMessageIndex(channelId: string, messageId: string): void {
		let ids = this.channelMessageIds.get(channelId);
		if (!ids) {
			ids = new Set<string>();
			this.channelMessageIds.set(channelId, ids);
		}
		ids.add(messageId);
	}

	private removeMessageIndex(channelId: string, messageId: string): void {
		const ids = this.channelMessageIds.get(channelId);
		if (!ids) return;
		ids.delete(messageId);
		if (ids.size === 0) {
			this.channelMessageIds.delete(channelId);
		}
	}

	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage {
		const created: DbMessage = this.cloneMessage({
			id: this.messagesById.size + 1,
			...message
		});
		this.messagesById.set(created.message_id, created);
		this.addMessageIndex(created.channel_id, created.message_id);
		return this.cloneMessage(created);
	}

	getByChannel(channelId: string, options: PaginationOptions = {}): DbMessage[] {
		const limit = options.limit || 50;
		let rows = this.getChannelRows(channelId)
			.filter((msg) => msg.deleted_at == null)
			.sort((a, b) => a.created_at - b.created_at);

		if (options.beforeMessageId) {
			const before = this.findByMessageId(options.beforeMessageId);
			if (!before) return [];
			rows = rows.filter((msg) => msg.created_at < before.created_at);
			rows.sort((a, b) => b.created_at - a.created_at);
			rows = rows.slice(0, limit);
			rows.reverse();
			return rows;
		}

		if (options.afterMessageId) {
			const after = this.findByMessageId(options.afterMessageId);
			if (!after) return [];
			rows = rows.filter((msg) => msg.created_at > after.created_at);
			rows.sort((a, b) => a.created_at - b.created_at);
			return rows.slice(0, limit);
		}

		rows.sort((a, b) => b.created_at - a.created_at);
		rows = rows.slice(0, limit);
		rows.reverse();
		return rows;
	}

	findByMessageId(messageId: string): DbMessage | null {
		const row = this.messagesById.get(messageId);
		if (!row || row.deleted_at != null) return null;
		return this.cloneMessage(row);
	}

	update(messageId: string, updates: Partial<DbMessage>): void {
		const existing = this.messagesById.get(messageId);
		if (!existing) return;
		const next = { ...existing, ...updates };
		this.messagesById.set(messageId, this.cloneMessage(next));
	}

	softDelete(messageId: string): void {
		const existing = this.messagesById.get(messageId);
		if (!existing) return;
		existing.deleted_at = Date.now();
		this.messagesById.set(messageId, this.cloneMessage(existing));
	}

	toClientFormat(dbMsg: DbMessage): ClientMessage {
		return messageRepository.toClientFormat(dbMsg);
	}

	getChannelMessageCount(channelId: string): number {
		const rows = this.getChannelRows(channelId);
		return rows.filter((row) => row.deleted_at == null).length;
	}

	updateReactions(messageId: string, reactions: Record<string, string[]>): void {
		this.update(messageId, { reactions_json: JSON.stringify(reactions) });
	}

	markEdited(messageId: string, newContent: string): void {
		this.update(messageId, { content: newContent, entities_json: undefined, is_edited: 1 });
	}

	purgeDeleted(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
		const cutoff = Date.now() - olderThanMs;
		let purged = 0;
		for (const [messageId, row] of this.messagesById.entries()) {
			if (row.deleted_at != null && row.deleted_at < cutoff) {
				this.messagesById.delete(messageId);
				this.removeMessageIndex(row.channel_id, messageId);
				purged += 1;
			}
		}
		return purged;
	}

	clearAll(): number {
		const count = this.messagesById.size;
		this.messagesById.clear();
		this.channelMessageIds.clear();
		return count;
	}
}

export interface DualWriteMessageStoreOptions {
	label?: string;
	paritySampleRate?: number;
	outbox?: StatePlaneOutbox | null;
	strictShadow?: boolean;
	readShadowEnabled?: boolean;
	readCanaryPercent?: number;
}

function normalizeSampleRate(input: number | undefined): number {
	if (!Number.isFinite(input)) return 0.1;
	return Math.max(0, Math.min(1, input as number));
}

function normalizeCanaryPercent(input: number | undefined): number {
	if (!Number.isFinite(input)) return 0;
	return Math.max(0, Math.min(100, Math.floor(input as number)));
}

export class DualWriteMessageStore implements InstrumentedMessageStore {
	private warnedOps = new Set<string>();
	private readonly label: string;
	private readonly paritySampleRate: number;
	private readonly outbox: StatePlaneOutbox | null;
	private readonly strictShadow: boolean;
	private readonly readShadowEnabled: boolean;
	private readonly readCanaryPercent: number;
	private writesAttempted = 0;
	private writesSucceeded = 0;
	private writesFailed = 0;
	private lastError: string | null = null;
	private lastErrorAt: number | null = null;
	private paritySamples = 0;
	private parityMismatches = 0;
	private lastParityMismatch: string | null = null;
	private lastParityMismatchAt: number | null = null;
	private readAttempts = 0;
	private readCanaryRouted = 0;
	private readShadowServed = 0;
	private readFallbacks = 0;
	private readShadowErrors = 0;
	private readMismatches = 0;
	private lastReadFallbackReason: string | null = null;
	private lastReadFallbackAt: number | null = null;

	constructor(
		private readonly primary: MessageStore,
		private readonly shadow: MessageStore,
		options: DualWriteMessageStoreOptions = {}
	) {
		this.label = options.label || 'state-plane-shadow';
		this.paritySampleRate = normalizeSampleRate(options.paritySampleRate);
		this.outbox = options.outbox || null;
		this.strictShadow = options.strictShadow === true;
		this.readShadowEnabled = options.readShadowEnabled === true;
		this.readCanaryPercent = normalizeCanaryPercent(options.readCanaryPercent);
	}

	private shouldRunParitySample(): boolean {
		return this.paritySampleRate > 0 && Math.random() <= this.paritySampleRate;
	}

	private shouldRunReadCanary(): boolean {
		if (!this.readShadowEnabled) return false;
		if (this.readCanaryPercent <= 0) return false;
		return Math.random() * 100 < this.readCanaryPercent;
	}

	private recordReadFallback(reason: string): void {
		this.readFallbacks += 1;
		this.lastReadFallbackReason = reason;
		this.lastReadFallbackAt = Date.now();
	}

	private compareMessageRow(primaryRow: DbMessage | null, shadowRow: DbMessage | null): string | null {
		if (!primaryRow && !shadowRow) return null;
		if (!primaryRow || !shadowRow) return `presence_mismatch primary=${Boolean(primaryRow)} shadow=${Boolean(shadowRow)}`;
		if (primaryRow.message_id !== shadowRow.message_id) {
			return `message_id_mismatch primary=${primaryRow.message_id} shadow=${shadowRow.message_id}`;
		}
		return null;
	}

	private trackShadowError(op: string, error: unknown): void {
		this.writesFailed += 1;
		this.lastErrorAt = Date.now();
		this.lastError = error instanceof Error ? error.message : String(error);
		const key = `${op}:${this.label}`;
		if (!this.warnedOps.has(key)) {
			this.warnedOps.add(key);
			console.warn(`[StatePlane] Shadow operation failed (${op}); continuing with primary store`, error);
		}
	}

	private shadowBestEffort(op: string, fn: () => void): void {
		this.writesAttempted += 1;
		try {
			fn();
			this.writesSucceeded += 1;
		} catch (error) {
			this.trackShadowError(op, error);
			if (this.strictShadow) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		}
	}

	private appendOutbox(operation: string, payload: Record<string, unknown>): void {
		this.outbox?.append({
			timestamp: Date.now(),
			entity: 'message',
			operation,
			payload
		});
	}

	private compareMessageRows(primaryRows: DbMessage[], shadowRows: DbMessage[]): string | null {
		if (primaryRows.length !== shadowRows.length) {
			return `row_count_mismatch primary=${primaryRows.length} shadow=${shadowRows.length}`;
		}
		for (let i = 0; i < primaryRows.length; i += 1) {
			const primaryId = primaryRows[i].message_id;
			const shadowId = shadowRows[i].message_id;
			if (primaryId !== shadowId) {
				return `message_id_mismatch index=${i} primary=${primaryId} shadow=${shadowId}`;
			}
		}
		return null;
	}

	private sampleParity(channelId: string, options: PaginationOptions): void {
		if (!this.shouldRunParitySample()) return;
		this.paritySamples += 1;
		try {
			const primaryRows = this.primary.getByChannel(channelId, options);
			const shadowRows = this.shadow.getByChannel(channelId, options);
			const mismatch = this.compareMessageRows(primaryRows, shadowRows);
			if (mismatch) {
				this.parityMismatches += 1;
				this.lastParityMismatch = mismatch;
				this.lastParityMismatchAt = Date.now();
			}
		} catch (error) {
			this.parityMismatches += 1;
			this.lastParityMismatchAt = Date.now();
			this.lastParityMismatch = `parity_sample_error: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	create(message: Omit<DbMessage, 'id' | 'deleted_at'>): DbMessage {
		const created = this.primary.create(message);
		this.shadowBestEffort('create', () => {
			this.shadow.create(message);
		});
		this.appendOutbox('create', {
			messageId: created.message_id,
			channelId: created.channel_id,
			senderId: created.sender_id,
			createdAt: created.created_at
		});
		return created;
	}

	getByChannel(channelId: string, options: PaginationOptions = {}): DbMessage[] {
		this.readAttempts += 1;
		const primaryRows = this.primary.getByChannel(channelId, options);

		if (!this.shouldRunReadCanary()) {
			this.sampleParity(channelId, options);
			return primaryRows;
		}

		this.readCanaryRouted += 1;
		try {
			const shadowRows = this.shadow.getByChannel(channelId, options);
			this.paritySamples += 1;
			const mismatch = this.compareMessageRows(primaryRows, shadowRows);
			if (mismatch) {
				this.parityMismatches += 1;
				this.lastParityMismatch = `read_canary:getByChannel(${channelId}): ${mismatch}`;
				this.lastParityMismatchAt = Date.now();
				this.readMismatches += 1;
				this.recordReadFallback('mismatch:getByChannel');
				return primaryRows;
			}
			this.readShadowServed += 1;
			return shadowRows;
		} catch (error) {
			this.readShadowErrors += 1;
			this.recordReadFallback('error:getByChannel');
			this.trackShadowError('read:getByChannel', error);
			return primaryRows;
		}
	}

	findByMessageId(messageId: string): DbMessage | null {
		this.readAttempts += 1;
		const primaryRow = this.primary.findByMessageId(messageId);

		if (!this.shouldRunReadCanary()) {
			return primaryRow;
		}

		this.readCanaryRouted += 1;
		try {
			const shadowRow = this.shadow.findByMessageId(messageId);
			this.paritySamples += 1;
			const mismatch = this.compareMessageRow(primaryRow, shadowRow);
			if (mismatch) {
				this.parityMismatches += 1;
				this.lastParityMismatch = `read_canary:findByMessageId(${messageId}): ${mismatch}`;
				this.lastParityMismatchAt = Date.now();
				this.readMismatches += 1;
				this.recordReadFallback('mismatch:findByMessageId');
				return primaryRow;
			}
			if (shadowRow) this.readShadowServed += 1;
			return shadowRow;
		} catch (error) {
			this.readShadowErrors += 1;
			this.recordReadFallback('error:findByMessageId');
			this.trackShadowError('read:findByMessageId', error);
			return primaryRow;
		}
	}

	update(messageId: string, updates: Partial<DbMessage>): void {
		this.primary.update(messageId, updates);
		this.shadowBestEffort('update', () => {
			this.shadow.update(messageId, updates);
		});
		this.appendOutbox('update', {
			messageId,
			updates
		});
	}

	softDelete(messageId: string): void {
		this.primary.softDelete(messageId);
		this.shadowBestEffort('softDelete', () => {
			this.shadow.softDelete(messageId);
		});
		this.appendOutbox('softDelete', { messageId });
	}

	toClientFormat(dbMsg: DbMessage): ClientMessage {
		return this.primary.toClientFormat(dbMsg);
	}

	getChannelMessageCount(channelId: string): number {
		this.readAttempts += 1;
		const primaryCount = this.primary.getChannelMessageCount(channelId);

		if (!this.shouldRunReadCanary()) {
			return primaryCount;
		}

		this.readCanaryRouted += 1;
		try {
			const shadowCount = this.shadow.getChannelMessageCount(channelId);
			this.paritySamples += 1;
			if (primaryCount !== shadowCount) {
				this.parityMismatches += 1;
				this.lastParityMismatch = `read_canary:getChannelMessageCount(${channelId}): count_mismatch primary=${primaryCount} shadow=${shadowCount}`;
				this.lastParityMismatchAt = Date.now();
				this.readMismatches += 1;
				this.recordReadFallback('mismatch:getChannelMessageCount');
				return primaryCount;
			}
			this.readShadowServed += 1;
			return shadowCount;
		} catch (error) {
			this.readShadowErrors += 1;
			this.recordReadFallback('error:getChannelMessageCount');
			this.trackShadowError('read:getChannelMessageCount', error);
			return primaryCount;
		}
	}

	updateReactions(messageId: string, reactions: Record<string, string[]>): void {
		this.primary.updateReactions(messageId, reactions);
		this.shadowBestEffort('updateReactions', () => {
			this.shadow.updateReactions(messageId, reactions);
		});
		this.appendOutbox('updateReactions', {
			messageId,
			reactions
		});
	}

	markEdited(messageId: string, newContent: string): void {
		this.primary.markEdited(messageId, newContent);
		this.shadowBestEffort('markEdited', () => {
			this.shadow.markEdited(messageId, newContent);
		});
		this.appendOutbox('markEdited', {
			messageId,
			newContent
		});
	}

	purgeDeleted(olderThanMs?: number): number {
		const purged = this.primary.purgeDeleted(olderThanMs);
		this.shadowBestEffort('purgeDeleted', () => {
			this.shadow.purgeDeleted(olderThanMs);
		});
		this.appendOutbox('purgeDeleted', { olderThanMs: olderThanMs ?? null, purged });
		return purged;
	}

	clearAll(): number {
		const cleared = this.primary.clearAll();
		this.shadowBestEffort('clearAll', () => {
			this.shadow.clearAll();
		});
		this.appendOutbox('clearAll', { cleared });
		return cleared;
	}

	getRuntimeStats(): MessageStoreRuntimeStats {
		return {
			mode: 'dual_write',
			shadow: {
				label: this.label,
				writesAttempted: this.writesAttempted,
				writesSucceeded: this.writesSucceeded,
				writesFailed: this.writesFailed,
				lastError: this.lastError,
				lastErrorAt: this.lastErrorAt
			},
			parity: {
				samples: this.paritySamples,
				mismatches: this.parityMismatches,
				lastMismatch: this.lastParityMismatch,
				lastMismatchAt: this.lastParityMismatchAt
			},
			readSwitch: {
				enabled: this.readShadowEnabled,
				canaryPercent: this.readCanaryPercent,
				attempts: this.readAttempts,
				canaryRouted: this.readCanaryRouted,
				shadowServed: this.readShadowServed,
				fallbacks: this.readFallbacks,
				shadowErrors: this.readShadowErrors,
				mismatches: this.readMismatches,
				lastFallbackReason: this.lastReadFallbackReason,
				lastFallbackAt: this.lastReadFallbackAt
			},
			outbox: this.outbox?.getStats() || null
		};
	}
}

export function getMessageStoreRuntimeStats(store: MessageStore): MessageStoreRuntimeStats | null {
	const instrumented = store as Partial<InstrumentedMessageStore>;
	if (typeof instrumented.getRuntimeStats !== 'function') return null;
	try {
		return instrumented.getRuntimeStats();
	} catch {
		return null;
	}
}
