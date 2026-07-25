import type { QueuedAction, QueueFilter } from '../types';
import { QueueDB } from './db';

const MAX_QUEUE_SIZE = 10000;
const MAX_FAILED_AGE_MS = 24 * 60 * 60 * 1000;

export class QueueManager {
	private db: QueueDB;
	private _pruning = false;

	constructor() {
		this.db = new QueueDB();
	}

	async enqueue(action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>): Promise<string> {
		const id = crypto.randomUUID();
		const record = this._serialize(action, id);
		const key = `${action.scopeId}:${id}`;

		let size = await this.db.getSize();
		if (size >= MAX_QUEUE_SIZE) {
			await this.db.prune();
			size = await this.db.getSize();
			if (size >= MAX_QUEUE_SIZE) {
				await this.db.trimToSize(MAX_QUEUE_SIZE - 1);
			}
		}

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
				const updated = { ...item, status: 'synced' as const };
				const key = `${item.scopeId}:${item.id}`;
				await this.db.put(key, updated);
				return;
			}
		}
	}

	async retryFailed(): Promise<void> {
		const all = await this.db.getAll();
		const now = Date.now();

		for (const item of all) {
			if (!this._isQueuedAction(item)) continue;
			if (item.status === 'failed') {
				const age = now - (item.retriedAt ?? item.createdAt);
				if (age > MAX_FAILED_AGE_MS) continue;

				const updated = { ...item, status: 'pending' as const, retriedAt: now, error: undefined };
				const key = `${item.scopeId}:${item.id}`;
				await this.db.put(key, updated);
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

	async prune(): Promise<number> {
		return this.db.prune();
	}

	private _serialize(action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>, id: string): QueuedAction {
		const payload = this._safeSerialize(action.payload);
		return {
			...action,
			id,
			status: 'pending',
			payload,
			createdAt: Date.now(),
			key: `${action.scopeId}:${id}`,
		} as QueuedAction;
	}

	private _safeSerialize(value: unknown): unknown {
		if (value === null || value === undefined) return value;
		const type = typeof value;
		if (type === 'string' || type === 'number' || type === 'boolean') return value;
		if (Array.isArray(value)) return value.map(item => this._safeSerialize(item));
		if (type === 'object') {
			try {
				JSON.stringify(value);
				return value;
			} catch {
				return { __unsafe: true, hint: 'non-serializable' };
			}
		}
		return { __unsafe: true, hint: `unsupported type: ${type}` };
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