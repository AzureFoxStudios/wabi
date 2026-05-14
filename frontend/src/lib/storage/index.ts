/**
 * storage/index.ts
 * Unified re-export layer maintaining 100% backward compatibility
 *
 * Re-exports all storage modules:
 * - utils: Constants and helper functions
 * - indexeddb: IndexedDB wrapper
 * - chat: ChatStorage class and message handling
 * - encryption: Encryption key management
 *
 * Total exports: 30+ functions + types (fully backward compatible)
 */

export { type RotationPeriod, type LoadMessagesResult, type StorageStats, ChatStorage } from './chat';

export { enableStorageEncryption, disableStorageEncryption, initializeStorageEncryption, isStorageEncryptionEnabled } from './encryption';

export {
	LEGACY_DB_NAME,
	DB_NAME_PREFIX,
	DB_VERSION,
	MESSAGES_STORE,
	SETTINGS_STORE,
	MAX_MESSAGES_PER_CHANNEL,
	MAX_ARCHIVES_TO_KEEP,
	ARCHIVE_WRITE_BATCH_MS,
	LEGACY_MIGRATION_SCOPE_KEY,
	ENCRYPTION_KEY_SETTING,
	ENCRYPTION_ENABLED_SETTING,
	resolveStorageScope,
	getScopedDbName,
	getStorageExportLabel,
	safeLocalGet,
	safeLocalSet
} from './utils';

// Create singleton instance for convenience
import { ChatStorage } from './chat';
export const chatStorage = new ChatStorage();
