import type { WabiDB, WabiDBOptions, OfflineScopeDescriptor, ScopeStatus, QueuedAction, QueueFilter, StorageReport, Query } from './types';
import { initScopeRegistry, registerScope, enableScope, disableScope, listScopes } from './scopes/registry';
import { QueueManager } from './queue/manager';

let instance: WabiDBImpl | null = null;

class WabiDBImpl implements WabiDB {
	private queue: QueueManager;
	private opened = false;

	constructor() {
		this.queue = new QueueManager();
	}

	async open(options?: WabiDBOptions): Promise<void> {
		if (this.opened) return;
		initScopeRegistry();
		this.opened = true;
	}

	async close(): Promise<void> {
		this.opened = false;
		await this.queue.prune();
	}

	registerScope(scope: OfflineScopeDescriptor): void {
		registerScope(scope);
	}

	enableScope(scopeId: string, options?: { force?: boolean }): Promise<void> {
		enableScope(scopeId, options);
		return Promise.resolve();
	}

	disableScope(scopeId: string): Promise<void> {
		disableScope(scopeId);
		return Promise.resolve();
	}

	listScopes(): ScopeStatus[] {
		return listScopes();
	}

	async put(_scopeId: string, _key: string, _value: unknown): Promise<void> {
	}

	async get(_scopeId: string, _key: string): Promise<unknown> {
		return undefined;
	}

	async delete(_scopeId: string, _key: string): Promise<void> {
	}

	async query(_scopeId: string, _query: Query): Promise<unknown[]> {
		return [];
	}

	async enqueue(action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>): Promise<string> {
		return this.queue.enqueue(action as any);
	}

	async listQueue(filter?: QueueFilter): Promise<QueuedAction[]> {
		return this.queue.listQueue(filter);
	}

	async markSynced(actionId: string): Promise<void> {
		return this.queue.markSynced(actionId);
	}

	async markSyncedByClientId(clientMessageId: string): Promise<void> {
		return this.queue.markSyncedByClientId(clientMessageId);
	}

	async retryFailed(): Promise<void> {
		return this.queue.retryFailed();
	}

	async getUsage(): Promise<StorageReport> {
		const scopes = listScopes();
		return {
			scopes: scopes.map(s => ({ scopeId: s.scopeId, sizeBytes: 0, itemCount: 0 })),
			totalBytes: 0,
		};
	}

	async estimateDownload(_scopeId: string, _items: string[]): Promise<number> {
		return 0;
	}

	async clearScope(scopeId: string): Promise<void> {
		await this.queue.clearScope(scopeId);
	}
}

export async function openWabiDB(options?: WabiDBOptions): Promise<WabiDB> {
	if (!instance) {
		instance = new WabiDBImpl();
	}
	await instance.open(options);
	return instance;
}

export function getWabiDB(): WabiDBImpl | null {
	return instance;
}