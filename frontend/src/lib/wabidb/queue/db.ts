import { browser } from '$app/environment';

const QUEUE_STORE = 'outbound_queue';
const QUEUE_DB_NAME = 'wabi-queue';
const DB_VERSION = 1;

export class QueueDB {
	private db: IDBDatabase | null = null;
	private initPromise: Promise<void> | null = null;

	async init(): Promise<void> {
		if (!browser) return;
		if (this.db) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(QUEUE_DB_NAME, DB_VERSION);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(QUEUE_STORE)) {
					db.createObjectStore(QUEUE_STORE, { keyPath: 'key' });
				}
			};
		});

		return this.initPromise;
	}

	async put(key: string, value: unknown): Promise<void> {
		await this.init();
		if (!browser || !this.db) return;

		return new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction([QUEUE_STORE], 'readwrite');
			const store = tx.objectStore(QUEUE_STORE);
			const req = store.put(value, key);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	async get(key: string): Promise<unknown> {
		await this.init();
		if (!browser || !this.db) return null;

		return new Promise<unknown>((resolve, reject) => {
			const tx = this.db!.transaction([QUEUE_STORE], 'readonly');
			const store = tx.objectStore(QUEUE_STORE);
			const req = store.get(key);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async getAll(): Promise<unknown[]> {
		await this.init();
		if (!browser || !this.db) return [];

		return new Promise<unknown[]>((resolve, reject) => {
			const tx = this.db!.transaction([QUEUE_STORE], 'readonly');
			const store = tx.objectStore(QUEUE_STORE);
			const req = store.getAll();
			req.onsuccess = () => resolve(req.result as unknown[]);
			req.onerror = () => reject(req.error);
		});
	}

	async delete(key: string): Promise<void> {
		await this.init();
		if (!browser || !this.db) return;

		return new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction([QUEUE_STORE], 'readwrite');
			const store = tx.objectStore(QUEUE_STORE);
			const req = store.delete(key);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	async clear(): Promise<void> {
		await this.init();
		if (!browser || !this.db) return;

		return new Promise<void>((resolve, reject) => {
			const tx = this.db!.transaction([QUEUE_STORE], 'readwrite');
			const store = tx.objectStore(QUEUE_STORE);
			const req = store.clear();
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}
}