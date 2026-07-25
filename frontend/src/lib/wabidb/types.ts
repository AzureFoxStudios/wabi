export type BackendKind = 'indexeddb';

export interface WabiDB {
	open(options?: WabiDBOptions): Promise<void>;
	close(): Promise<void>;
	registerScope(scope: OfflineScopeDescriptor): void;
	enableScope(scopeId: string, options?: EnableOptions): Promise<void>;
	disableScope(scopeId: string): Promise<void>;
	listScopes(): ScopeStatus[];
	put(scopeId: string, key: string, value: unknown): Promise<void>;
	get(scopeId: string, key: string): Promise<unknown>;
	delete(scopeId: string, key: string): Promise<void>;
	query(scopeId: string, query: Query): Promise<unknown[]>;
	enqueue(action: Omit<QueuedAction, 'id' | 'status' | 'createdAt'>): Promise<string>;
	listQueue(filter?: QueueFilter): Promise<QueuedAction[]>;
	markSynced(actionId: string): Promise<void>;
	retryFailed(): Promise<void>;
	getUsage(): Promise<StorageReport>;
	estimateDownload(scopeId: string, items: string[]): Promise<number>;
	clearScope(scopeId: string): Promise<void>;
}

export interface WabiDBOptions {
	backend?: BackendKind;
}

export interface OfflineScopeDescriptor {
	scopeId: string;
	name: string;
	description?: string;
	backend?: BackendKind;
	blobSupport?: boolean;
	requiredTableNames?: string[];
	estimatedSizeBytes?: number;
	defaultEnabled?: boolean;
	userControl?: 'always' | 'opt-in' | 'off';
}

export interface EnableOptions {
	force?: boolean;
}

export interface ScopeStatus {
	scopeId: string;
	name: string;
	enabled: boolean;
	sizeBytes?: number;
	lastSyncAt?: number;
	userControl: 'always' | 'opt-in' | 'off';
	backend: BackendKind;
}

export interface BlobMeta {
	name: string;
	size: number;
	mimeType: string;
	createdAt?: number;
}

export interface QueuedAction {
	id: string;
	type: string;
	payload: unknown;
	scopeId: string;
	status: 'pending' | 'synced' | 'failed';
	createdAt: number;
	retriedAt?: number;
	error?: string;
}

export interface QueueFilter {
	scopeId?: string;
	status?: QueuedAction['status'];
	limit?: number;
}

export interface StorageUsage {
	scopeId: string;
	sizeBytes: number;
	itemCount: number;
}

export interface StorageReport {
	scopes: StorageUsage[];
	totalBytes: number;
}

export interface Query {
	index?: string;
	key?: string;
	range?: [string, string];
	limit?: number;
	offset?: number;
}