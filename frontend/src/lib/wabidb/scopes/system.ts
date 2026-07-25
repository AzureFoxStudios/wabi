import type { OfflineScopeDescriptor } from '../types';

export function createSystemScope(): OfflineScopeDescriptor {
	return {
		scopeId: 'system',
		name: 'System',
		description: 'Themes, preferences, emoji/sticker packs, auth/session, storage metadata',
		backend: 'indexeddb',
		blobSupport: false,
		defaultEnabled: true,
		userControl: 'always',
	};
}