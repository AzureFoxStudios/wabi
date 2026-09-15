import type { BusinessDataSnapshot } from './types';

export interface PlannerRecord { scope: string; revision: number; data: BusinessDataSnapshot }
export interface PlannerDraft { scope: string; id: string; data: BusinessDataSnapshot; savedAt: number }
export interface PlannerPersistence {
	read(scope: string): Promise<PlannerRecord | null>;
	write(scope: string, revision: number, data: BusinessDataSnapshot, draftId: string): Promise<number>;
	drafts(scope: string): Promise<PlannerDraft[]>;
}
export class PlannerConflict extends Error {
	constructor() { super('Planner changed in another window. Your draft is kept; export it before loading the saved version.'); }
}

const DB_NAME = 'wabi-planner';
function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		let abandoned = false;
		const fail = (error: unknown) => { abandoned = true; reject(error); };
		request.onupgradeneeded = () => {
			request.result.createObjectStore('notebooks', { keyPath: 'scope' });
			const drafts = request.result.createObjectStore('drafts', { keyPath: ['scope', 'id'] });
			drafts.createIndex('scope', 'scope');
		};
		request.onblocked = () => fail(new Error('Close older Wabi windows, then retry Planner storage.'));
		request.onerror = () => fail(request.error);
		request.onsuccess = () => {
			if (abandoned) { request.result.close(); return; }
			request.result.onversionchange = () => request.result.close();
			resolve(request.result);
		};
	});
}

export const plannerPersistence: PlannerPersistence = {
	async read(scope) {
		const db = await openDatabase();
		try {
			return await new Promise<PlannerRecord | null>((resolve, reject) => {
				const tx = db.transaction('notebooks', 'readonly');
				const request = tx.objectStore('notebooks').get(scope);
				tx.oncomplete = () => resolve(request.result ?? null);
				tx.onabort = () => reject(tx.error ?? new Error('Planner read was interrupted.'));
			});
		} finally { db.close(); }
	},
	async write(scope, revision, data, draftId) {
		const db = await openDatabase();
		try {
			return await new Promise<number>((resolve, reject) => {
				const tx = db.transaction(['notebooks', 'drafts'], 'readwrite');
				const store = tx.objectStore('notebooks');
				const request = store.get(scope);
				let conflict = false;
				request.onsuccess = () => {
					const current = request.result as PlannerRecord | undefined;
					if ((current?.revision ?? 0) !== revision) {
						conflict = true;
						// Preserve the losing editor independently, in the same transaction.
						tx.objectStore('drafts').put({ scope, id: draftId, data, savedAt: Date.now() });
					} else {
						store.put({ scope, revision: revision + 1, data });
						tx.objectStore('drafts').delete([scope, draftId]);
					}
				};
				tx.oncomplete = () => conflict ? reject(new PlannerConflict()) : resolve(revision + 1);
				tx.onabort = () => reject(tx.error ?? new Error('Planner save was interrupted.'));
			});
		} finally { db.close(); }
	},
	async drafts(scope) {
		const db = await openDatabase();
		try {
			return await new Promise<PlannerDraft[]>((resolve, reject) => {
				const tx = db.transaction('drafts', 'readonly');
				const request = tx.objectStore('drafts').index('scope').getAll(scope);
				tx.oncomplete = () => resolve(request.result);
				tx.onabort = () => reject(tx.error ?? new Error('Planner recovery read was interrupted.'));
			});
		} finally { db.close(); }
	}
};
