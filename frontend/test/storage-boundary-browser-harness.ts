import { mount, unmount } from 'svelte';
import '../src/styles/styles.css';
import { setConfiguredServerUrl, normalizeServerUrl, resolveServerUrl } from '../src/lib/serverUrl';
import { setAuthToken } from '../src/lib/authSession';
import { groupMembership } from '../src/lib/groupAccess';
import { initI18n } from '../src/lib/i18n';
import { applyTheme } from '../src/lib/theme/themeManager';
import { DEFAULT_THEME } from '../src/lib/theme/themes';

async function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('messages', { keyPath: 'period' });
      request.result.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function seed(name: string) {
  const db = await open(name);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['messages', 'settings'], 'readwrite');
    tx.objectStore('messages').put({ period: '2026-09', data: {
      'group-private': [{ id: 'private-canary', type: 'text', text: 'UNOWNED-PRIVATE-ARCHIVE', timestamp: 1 }]
    } });
    tx.objectStore('settings').put({ key: 'saveHistory', value: 'true' });
    tx.objectStore('settings').put({ key: 'reminders-canary', value: [5, 15] });
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  db.close();
}
async function snapshot(name: string) {
  const db = await open(name);
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); return value;
}

async function run() {
  initI18n();
  applyTheme(DEFAULT_THEME);
  setConfiguredServerUrl(location.origin, false);
  const account = (sub: string) => {
    setAuthToken(`eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ sub, exp: 4102444800 }))}.fixture`);
    groupMembership.realm();
  };
  account('1');
  groupMembership.revoke('group-private', '2', groupMembership.realm()!);
  const scopedName = `wabi-chat-db:${encodeURIComponent(normalizeServerUrl(resolveServerUrl().url))}`;
  const names = ['wabi-chat-db', scopedName];
  for (const name of names) await seed(name);
  const before = await Promise.all(names.map(snapshot));
  let messageStoreAccess = 0;
  const objectStore = IDBTransaction.prototype.objectStore;
  IDBTransaction.prototype.objectStore = function(name: string) {
    if (name === 'messages') messageStoreAccess++;
    return objectStore.call(this, name);
  };
  const exports: string[] = [];
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() { /* capture Blob below, without downloading */ };
  const createURL = URL.createObjectURL;
  URL.createObjectURL = blob => {
    if (blob instanceof Blob) void blob.text().then(text => exports.push(text));
    return createURL(blob);
  };
  const nativeCommands: string[] = [];
  if (new URLSearchParams(location.search).has('tauri')) {
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      nativeCommands.push(command); throw new Error(`Unregistered native command: ${command}`);
    } };
    localStorage.setItem('tauriStorageEnabled', 'true');
  }
  const { default: Settings } = await import('../src/lib/components/StorageSettings.svelte');
  let component = mount(Settings, { target: document.querySelector('#harness')! });
  (window as any).__storageBoundary = {
    exports: () => exports,
    messageStoreAccess: () => messageStoreAccess,
    nativeCommands: () => nativeCommands,
    async switchAccount() {
      await unmount(component); account('2');
      component = mount(Settings, { target: document.querySelector('#harness')! });
    },
    async settingsCanary() {
      const storage = await import('../src/lib/storage');
      const settings = (storage as any).localSettings ?? (storage as any).chatStorage;
      const existing = await settings.getSetting('reminders-canary');
      await settings.setSetting('reminders-canary-2', [30]);
      return { existing, saved: await settings.getSetting('reminders-canary-2') };
    },
    async settingsAbort() {
      const { localSettings } = await import('../src/lib/storage');
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
        const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
        if (this.name === 'settings' && value.key === 'abort-canary') {
          request.addEventListener('success', () => this.transaction.abort());
        }
        return request;
      };
      let rejected = false;
      try { await localSettings.setSetting('abort-canary', 'must not commit'); }
      catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = put; }
      return { rejected, persisted: await localSettings.getSetting('abort-canary') };
    },
    async prepareQueue() {
      const { openWabiDB } = await import('../src/lib/wabidb');
      const { QueueDB } = await import('../src/lib/wabidb/queue/db');
      const db = await openWabiDB();
      const raw = new QueueDB();
      for (const [id, retryable] of [['retryable', true], ['uncertain', false]] as const) {
        await raw.put(`corechat:${id}`, { key: `corechat:${id}`, id, scopeId: 'corechat',
          status: 'failed', type: 'set-status', payload: { status: 'active' }, createdAt: Date.now(), retryable });
      }
      return db.listQueue();
    },
    async queueState() { return (await import('../src/lib/wabidb')).getWabiDB()!.listQueue(); },
    async failQueueRead(fail: boolean) {
      const db = (await import('../src/lib/wabidb')).getWabiDB()!;
      if (fail) {
        (db as any).__originalList = db.listQueue;
        db.listQueue = async () => { throw new Error('Fixture queue read failed'); };
      } else db.listQueue = (db as any).__originalList;
    },
    async close() {
      await unmount(component);
      IDBTransaction.prototype.objectStore = objectStore;
      URL.createObjectURL = createURL;
      HTMLAnchorElement.prototype.click = anchorClick;
      return { before, after: await Promise.all(names.map(snapshot)) };
    }
  };
}
void run().catch(error => { (window as any).__storageError = String(error); throw error; });
