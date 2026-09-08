import type { QueuedAction, QueueFilter } from '../types';
import { QueueDB } from './db';
import { groupMembership } from '$lib/groupAccess';
import { GROUP_QUEUE_ACTIONS, CALL_QUEUE_ACTIONS, ADMIN_ROLE_QUEUE_ACTIONS, ADMIN_ROLE_QUEUE_ERROR, BAN_QUEUE_ERROR, MESSAGE_QUEUE_ACTIONS, MESSAGE_QUEUE_OWNERSHIP_ERROR } from './groupPolicy';
import type { MessageSettlement } from '$lib/messageDelivery';

const MAX_QUEUE_SIZE = 10000;
const MAX_FAILED_AGE_MS = 24 * 60 * 60 * 1000;

export class QueueManager {
	private db: QueueDB;
	private _pruning = false;

	constructor() {
		this.db = new QueueDB();
	}

	async enqueue(action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>): Promise<string> {
		if (action.type === 'ban-user') throw new Error(BAN_QUEUE_ERROR);
		if (GROUP_QUEUE_ACTIONS.has(action.type)) throw new Error('Group membership changes require a live server confirmation');
		if (CALL_QUEUE_ACTIONS.has(action.type)) throw new Error('Voice actions belong to the current call, not the offline queue');
		if (ADMIN_ROLE_QUEUE_ACTIONS.has(action.type)) throw new Error(ADMIN_ROLE_QUEUE_ERROR);
		const realm = groupMembership.realm();
		if (MESSAGE_QUEUE_ACTIONS.has(action.type) && !realm) throw new Error(MESSAGE_QUEUE_OWNERSHIP_ERROR);
		const channelId = (action.payload as { channelId?: unknown } | null)?.channelId;
		const revision = typeof channelId === 'string' && groupMembership.tracks(channelId)
			? groupMembership.revision(channelId) : undefined;
		if (revision === null) throw new Error('You no longer have access to this group');
		// Capture BEFORE any IndexedDB await. A later re-add is not permission
		// to replay something composed in the previous membership lifecycle.
		action = { ...action, authority: realm ? { realm, membershipRevision: revision } : undefined };
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
				const key = `${item.scopeId}:${item.id}`;
				await this.db.updateAction(key, current => ({ ...current, status: 'synced', error: undefined }));
				return;
			}
		}
	}

	async markFailed(actionId: string, error: string, retryable = true): Promise<void> {
		const all = await this.db.getAll();
		for (const item of all) {
			if (!this._isQueuedAction(item) || item.id !== actionId) continue;
			await this.db.updateAction(`${item.scopeId}:${item.id}`, current => current.status === 'synced' ? null :
				({ ...current, status: 'failed', error, retryable }));
			return;
		}
	}

	async claimMessage(actionId: string): Promise<boolean> {
		const item = (await this.listQueue()).find(action => action.id === actionId);
		if (!item) return false;
		return this.db.updateAction(`${item.scopeId}:${item.id}`, current =>
			current.status !== 'pending' || current.attemptedAt !== undefined ? null : { ...current, attemptedAt: Date.now() });
	}

	async settleMessageReceipt(channelId: string, clientMessageId: string, realm: string | null, result: MessageSettlement): Promise<void> {
		// A bare client ID must not settle another account/channel's queue, or an
		// offline intent which has never been submitted. Capture realm at receipt.
		if (!realm) return;
		const matches = (item: QueuedAction) => {
			const payload = item.payload as { channelId?: string; clientMessageId?: string } | null;
			return (item.type === 'send-message' || item.type === 'message') && item.authority?.realm === realm &&
				payload?.channelId === channelId && payload.clientMessageId === clientMessageId && item.attemptedAt !== undefined;
		};
		const all = await this.db.getAll();
		for (const item of all) {
			if (!this._isQueuedAction(item) || !matches(item)) continue;
			await this.db.updateAction(`${item.scopeId}:${item.id}`, current => {
				if (!matches(current) || current.status === 'synced') return null;
				if (result.status === 'synced') return { ...current, status: 'synced', error: undefined, deliveryOutcome: undefined };
				// A late timeout must not replace a correlated rejection, and no
				// failure may overwrite a receipt already committed by another tab.
				if (current.status !== 'pending' && !(current.deliveryOutcome === 'unknown' && result.outcome === 'rejected')) return null;
				return { ...current, status: 'failed', error: result.error, deliveryOutcome: result.outcome, retryable: false };
			});
		}
	}

	async retryFailed(): Promise<void> {
		const all = await this.db.getAll();
		const now = Date.now();

		for (const item of all) {
			if (!this._isQueuedAction(item)) continue;
			if (item.status === 'failed' && item.type === 'ban-user') {
				await this.db.updateAction(`${item.scopeId}:${item.id}`, current => current.status !== 'failed' ? null :
					({ ...current, error: BAN_QUEUE_ERROR, retryable: false }));
				continue;
			}
			if (item.status === 'failed' && item.retryable !== false) {
				const age = now - (item.retriedAt ?? item.createdAt);
				if (age > MAX_FAILED_AGE_MS) continue;

				const key = `${item.scopeId}:${item.id}`;
				await this.db.updateAction(key, current => current.status !== 'failed' || current.retryable === false || current.attemptedAt !== undefined ? null :
					({ ...current, status: 'pending', retriedAt: now, error: undefined }));
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
