/**
 * storageTypes.ts
 * Type definitions and constants for storage system
 */

import type { Message, Channel } from './socket-types';

export interface LoadMessagesResult {
	messages: Record<string, Message[]>;
	availableArchives: Record<string, string[]>; // channelId -> archive keys sorted oldest-first
}

export interface StorageStats {
	archives: Array<{
		period: string;
		size: number;
		messageCount: number;
	}>;
	totalSize: number;
	totalMessages: number;
}

export type RotationPeriod = 'week' | 'month' | 'half-year' | 'year';

export const LEGACY_DB_NAME = 'wabi-chat-db';
export const DB_NAME_PREFIX = 'wabi-chat-db:';
export const DB_VERSION = 1;
export const MESSAGES_STORE = 'messages';
export const SETTINGS_STORE = 'settings';
export const MAX_MESSAGES_PER_CHANNEL = 2000; // Limit RAM usage
export const MAX_ARCHIVES_TO_KEEP = 2; // Keep only 2 months of archive history
export const ARCHIVE_WRITE_BATCH_MS = 64;
export const LEGACY_MIGRATION_SCOPE_KEY = 'wabi_chat_db_legacy_scope_v1';
export const ENCRYPTION_KEY_SETTING = 'storage_encryption_key_v1';
export const ENCRYPTION_ENABLED_SETTING = 'storage_encryption_enabled';
