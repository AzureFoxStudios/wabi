/**
 * Existing server-scoped Planner preferences, not chat-message persistence.
 * Legacy archives have no account owner and are deliberately never opened,
 * migrated, trimmed, exported or assigned to the current login.
 */
import { browser } from '$app/environment';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';
import { IndexedDBWrapper } from './storageDb';

export { enableStorageEncryption, disableStorageEncryption } from './storageEncryption';

export class LocalSettings {
  private databases = new Map<string, IndexedDBWrapper>();

  private scope(): string {
    return normalizeServerUrl(resolveServerUrl().url) || 'browser_default';
  }

  private async database(scope: string): Promise<IndexedDBWrapper> {
    let db = this.databases.get(scope);
    if (!db) {
      db = new IndexedDBWrapper(`wabi-chat-db:${encodeURIComponent(scope)}`);
      this.databases.set(scope, db);
    }
    await db.init();
    if (this.scope() !== scope) throw new Error('Server changed while opening local settings');
    return db;
  }

  async getSetting(key: string): Promise<any> {
    if (!browser) return null;
    const scope = this.scope();
    const db = await this.database(scope);
    const value = await db.getSetting(key);
    if (this.scope() !== scope) throw new Error('Server changed while reading local settings');
    return value;
  }

  async setSetting(key: string, value: any): Promise<void> {
    if (!browser) return;
    const scope = this.scope();
    const db = await this.database(scope);
    await db.setSetting(key, value);
  }
}

export const localSettings = new LocalSettings();
