import { browser } from '$app/environment';
import { compressAndEncrypt, decryptAndDecompress } from '../storage-compression';
import { DB_VERSION, MESSAGES_STORE, SETTINGS_STORE } from './utils';
import { getEncryptionKey, setEncryptionKey } from './encryptionKeyHolder';

export { setEncryptionKey, getEncryptionKey };

export class IndexedDBWrapper {
	private db: IDBDatabase | null = null;
	private initPromise: Promise<void> | null = null;
	private readonly dbName: string;

	constructor(dbName: string) {
		this.dbName = dbName;
	}

	async init(): Promise<void> {
		if (!browser) return;
		if (this.db) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, DB_VERSION);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
					db.createObjectStore(MESSAGES_STORE, { keyPath: 'period' });
				}

				if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
					db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
				}
			};
		});

		return this.initPromise;
	}

	async getSetting(key: string): Promise<any> {
		if (!browser || !this.db) return null;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([SETTINGS_STORE], 'readonly');
			const store = transaction.objectStore(SETTINGS_STORE);
			const request = store.get(key);

			request.onsuccess = () => resolve(request.result?.value);
			request.onerror = () => reject(request.error);
		});
	}

	async setSetting(key: string, value: any): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([SETTINGS_STORE], 'readwrite');
			const store = transaction.objectStore(SETTINGS_STORE);
			const request = store.put({ key, value });

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async getAllSettings(): Promise<Array<{ key: string; value: any }>> {
		if (!browser || !this.db) return [];

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([SETTINGS_STORE], 'readonly');
			const store = transaction.objectStore(SETTINGS_STORE);
			const request = store.getAll();

			request.onsuccess = () => resolve(request.result as Array<{ key: string; value: any }>);
			request.onerror = () => reject(request.error);
		});
	}

	async getArchive(period: string): Promise<any> {
		if (!browser || !this.db) return null;

		return new Promise(async (resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.get(period);

			request.onsuccess = async () => {
				let data = request.result?.data;
				const key = getEncryptionKey();

				if (data?.encrypted && key) {
					try {
						const encrypted = new Uint8Array(data.data);
						const decrypted = await decryptAndDecompress(encrypted, key);
						const json = new TextDecoder().decode(decrypted);
						data = JSON.parse(json);
					} catch (err) {
						console.warn('[Storage] Decryption failed:', err);
					}
				}

				resolve(data);
			};
			request.onerror = () => reject(request.error);
		});
	}

	async setArchive(period: string, data: any): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise(async (resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGES_STORE);

			let storedData = data;
			const key = getEncryptionKey();
			if (key) {
				try {
					const json = JSON.stringify(data);
					const encoded = new TextEncoder().encode(json);
					const encrypted = await compressAndEncrypt(encoded, key);
					storedData = { encrypted: true, data: Array.from(encrypted) };
				} catch (err) {
					console.warn('[Storage] Encryption failed, storing unencrypted:', err);
				}
			}

			const request = store.put({ period, data: storedData });

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async deleteArchive(period: string): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.delete(period);

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async getAllArchiveKeys(): Promise<string[]> {
		if (!browser || !this.db) return [];

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.getAllKeys();

			request.onsuccess = () => resolve(request.result as string[]);
			request.onerror = () => reject(request.error);
		});
	}

	async getAllArchives(): Promise<Array<{ period: string; data: any }>> {
		if (!browser || !this.db) return [];

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.getAll();

			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	async clearAllArchives(): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.clear();

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}
