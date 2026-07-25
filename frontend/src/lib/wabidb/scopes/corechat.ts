import type { OfflineScopeDescriptor } from '../types';

export function createCoreChatScope(): OfflineScopeDescriptor {
	return {
		scopeId: 'corechat',
		name: 'CoreChat',
		description: 'Message history (opt-in), drafts, outbound queue, presence/profile snapshots, local search index',
		backend: 'indexeddb',
		blobSupport: false,
		defaultEnabled: false,
		userControl: 'opt-in',
	};
}