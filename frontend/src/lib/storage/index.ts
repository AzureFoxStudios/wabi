// One settings singleton. The obsolete parallel chat-archive implementation
// was retired; do not instantiate another store through this import path.
export { LocalSettings, localSettings } from '../storage';
export { enableStorageEncryption, disableStorageEncryption, initializeStorageEncryption, isStorageEncryptionEnabled } from './encryption';
