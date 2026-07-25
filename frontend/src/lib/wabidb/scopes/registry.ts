import type { OfflineScopeDescriptor, ScopeStatus, BackendKind } from '../types';

const SCOPE_KEY = 'wabi_scopes_v1';
const SCOPE_STATE_KEY = 'wabi_scope_state_v1';

interface ScopeState {
	enabled: boolean;
	backend: string;
}

let descriptors: Map<string, OfflineScopeDescriptor> = new Map();
let scopeState: Map<string, ScopeState> = new Map();

function loadState(): void {
	try {
		const raw = localStorage.getItem(SCOPE_STATE_KEY);
		if (raw) {
			const entries = JSON.parse(raw) as [string, ScopeState][];
			scopeState = new Map(entries);
		}
	} catch {
		/* ignore */
	}
}

function persistState(): void {
	try {
		const entries = Array.from(scopeState.entries()).map(([k, v]) => [k, v] as [string, any]);
		localStorage.setItem(SCOPE_STATE_KEY, JSON.stringify(entries));
	} catch {
		/* ignore */
	}
}

function loadDescriptors(): void {
	try {
		const raw = localStorage.getItem(SCOPE_KEY);
		if (raw) {
			const entries = JSON.parse(raw) as [string, OfflineScopeDescriptor][];
			descriptors = new Map(entries);
		}
	} catch {
		/* ignore */
	}
}

function persistDescriptors(): void {
	try {
		const entries = Array.from(descriptors.entries()).map(([k, v]) => [k, v] as [string, any]);
		localStorage.setItem(SCOPE_KEY, JSON.stringify(entries));
	} catch {
		/* ignore */
	}
}

export function registerScope(descriptor: OfflineScopeDescriptor): void {
	descriptors.set(descriptor.scopeId, descriptor);
	if (!scopeState.has(descriptor.scopeId)) {
		scopeState.set(descriptor.scopeId, {
			enabled: descriptor.defaultEnabled ?? false,
			backend: descriptor.backend ?? 'indexeddb',
		});
		persistState();
	}
	persistDescriptors();
}

export function enableScope(scopeId: string, options?: { force?: boolean }): void {
	const state = scopeState.get(scopeId);
	if (!state) throw new Error(`Scope ${scopeId} not registered`);
	state.enabled = true;
	persistState();
}

export function disableScope(scopeId: string): void {
	const state = scopeState.get(scopeId);
	if (!state) throw new Error(`Scope ${scopeId} not registered`);
	state.enabled = false;
	persistState();
}

export function listScopes(): ScopeStatus[] {
	return Array.from(descriptors.entries()).map(([scopeId, desc]) => {
		const state = scopeState.get(scopeId);
		return {
			scopeId,
			name: desc.name,
			enabled: state?.enabled ?? false,
			userControl: desc.userControl ?? 'opt-in',
			backend: (state?.backend ?? desc.backend ?? 'indexeddb') as BackendKind,
		};
	});
}

export function getScopeState(scopeId: string): ScopeState | undefined {
	return scopeState.get(scopeId);
}

export function bootstrapCoreScopes(): void {
	registerScope({
		scopeId: 'corechat',
		name: 'CoreChat',
		description: 'Message history (opt-in), drafts, outbound queue, presence/profile snapshots, local search index',
		backend: 'indexeddb',
		blobSupport: false,
		defaultEnabled: false,
		userControl: 'opt-in',
	});
	registerScope({
		scopeId: 'system',
		name: 'System',
		description: 'Themes, preferences, emoji/sticker packs, auth/session, storage metadata',
		backend: 'indexeddb',
		blobSupport: false,
		defaultEnabled: true,
		userControl: 'always',
	});
}

export function initScopeRegistry(): void {
	loadState();
	loadDescriptors();
	bootstrapCoreScopes();
}