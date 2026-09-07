/**
 * Settings-only access to the existing server-scoped database.
 * Do not add access to its unowned legacy "messages" store.
 */
import { browser } from '$app/environment';
import { DB_VERSION, SETTINGS_STORE } from './storageTypes';

export class IndexedDBWrapper {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly dbName: string) {}

  async init(): Promise<void> {
    if (!browser || this.db) return;
    if (!this.initPromise) {
      this.initPromise = new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(SETTINGS_STORE)) {
            request.result.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          this.db = db;
          db.onversionchange = () => {
            db.close();
            if (this.db === db) { this.db = null; this.initPromise = null; }
          };
          resolve();
        };
      }).catch(error => { this.initPromise = null; throw error; });
    }
    await this.initPromise;
  }

  async getSetting(key: string): Promise<any> {
    if (!browser) return null;
    if (!this.db) throw new Error('Local settings database is not open');
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(SETTINGS_STORE, 'readonly');
      const request = tx.objectStore(SETTINGS_STORE).get(key);
      tx.oncomplete = () => resolve(request.result?.value);
      tx.onabort = () => reject(tx.error || new Error('Local settings read aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }

  async setSetting(key: string, value: any): Promise<void> {
    if (!browser) return;
    if (!this.db) throw new Error('Local settings database is not open');
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(SETTINGS_STORE, 'readwrite');
      tx.objectStore(SETTINGS_STORE).put({ key, value });
      // Request success is not a persistence acknowledgment: a later abort
      // must reject the caller too.
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Local settings write aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
}
