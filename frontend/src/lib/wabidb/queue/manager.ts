import type { QueuedAction, QueueFilter } from '../types';
import { QueueDB } from './db';

export class QueueManager {
	private db: QueueDB;

	constructor() {
		this.db = new QueueDB();
	}

	async enqueue(action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>): Promise<string> {
		const id = crypto.randomUUID();
		const record: QueuedAction = {
			...action,
			id,
			status: 'pending',
			createdAt: Date.now(),
		};
		const key = `${action.scopeId}:${id}`;
		await this.db.put(key, record);
		return id;
	}

	async listQueue(filter?: QueueFilter): Promise<QueuedAction[]> {
		const all = await this.db.getAll();
		let results = all.filter((item): item is QueuedAction =>
			this._isQueuedAction(item),
		);
		if (filter?.scopeId) results = results.filter(a => a.scopeId === filter.scopeId);
		if (filter?.status) results = results.filter(a => a.status === filter.status);
		if (filter?.limit) results = results.slice(-filter.limit);
		return results;
	}

	async markSynced(actionId: string): Promise<void> {
		const all = await this.db.getAll();
		for (const item of all) {
			if (!this._isQueuedAction(item)) continue;
			if (item.id === actionId) {
				item.status = 'synced';
				const key = `${item.scopeId}:${item.id}`;
				await this.db.put(key, item);
				return;
			}
		}
	}

	async retryFailed(): Promise<void> {
		const all = await this.db.getAll();
		for (const item of all) {
			if (!this._isQueuedAction(item)) continue;
			if (item.status === 'failed') {
				item.status = 'pending';
				item.retriedAt = Date.now();
				item.error = undefined;
				const key = `${item.scopeId}:${item.id}`;
				await this.db.put(key, item);
			}
		}
	}

	async clearScope(scopeId: string): Promise<void> {
		const all = await this.db.getAll();
		for (const item of all) {
			if (!this._isQueuedAction(item)) continue;
			if (item.scopeId === scopeId) {
				const key = `${item.scopeId}:${item.id}`;
				await this.db.delete(key);
			}
		}
	}

	private _isQueuedAction(item: unknown): item is QueuedAction {
		return (
			typeof item === 'object' &&
			item !== null &&
			'id' in item &&
			typeof (item as QueuedAction).id === 'string' &&
			'type' in item &&
			'scopeId' in item &&
			'status' in item
		);
	}
}