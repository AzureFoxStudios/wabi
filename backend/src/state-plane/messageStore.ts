import {
	type ClientMessage,
	type DbMessage,
	type PaginationOptions
} from '../db/repositories/messageRepository.js';
import { type StatePlaneOutboxStats } from './outbox.js';

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
	purgeExpired(now?: number): number;
	purgeDeleted(olderThanMs?: number): number;
	clearAll(): number;
}

export interface MessageStoreRuntimeStats {
	mode: 'stdb_primary';
	writesAttempted: number;
	writesSucceeded: number;
	writesFailed: number;
	lastError: string | null;
	lastErrorAt: number | null;
	operations: Record<string, number>;
	outbox: StatePlaneOutboxStats | null;
}

export interface InstrumentedMessageStore extends MessageStore {
	getRuntimeStats(): MessageStoreRuntimeStats;
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
