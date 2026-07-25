import type { BackendKind } from '../types';

export function detectBackend(): BackendKind {
	return 'indexeddb';
}