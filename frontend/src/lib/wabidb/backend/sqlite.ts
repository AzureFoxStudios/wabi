import type { WabiDB, WabiDBOptions, OfflineScopeDescriptor, ScopeStatus, QueuedAction, QueueFilter, StorageReport, Query } from '../types';

export class SQLiteBackend implements WabiDB {
	async open(_options?: WabiDBOptions): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	close(): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	registerScope(_descriptor: OfflineScopeDescriptor): void {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	enableScope(_scopeId: string, _options?: { force?: boolean }): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	disableScope(_scopeId: string): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	listScopes(): ScopeStatus[] {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	put(_scopeId: string, _key: string, _value: unknown): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	get(_scopeId: string, _key: string): Promise<unknown> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	delete(_scopeId: string, _key: string): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	query(_scopeId: string, _query: Query): Promise<unknown[]> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	enqueue(_action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>): Promise<string> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	listQueue(_filter?: QueueFilter): Promise<QueuedAction[]> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	markSynced(_actionId: string): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	retryFailed(): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	getUsage(): Promise<StorageReport> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	estimateDownload(_scopeId: string, _items: string[]): Promise<number> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}

	clearScope(_scopeId: string): Promise<void> {
		throw new Error('SQLite backend is not yet implemented in v1');
	}
}