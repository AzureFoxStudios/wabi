/** Local staging never uses Lore's shared server-side stageOnly/snapshot queue. */
export interface LocalFile { path: string; hash: string; size: number }
export interface RemoteFile { path: string; etag: string | null; size: number }
export interface Baseline { localHash: string | null; remoteEtag: string | null }
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'incoming' | 'conflict';
export interface Change extends Baseline { path: string; kind: ChangeKind; size: number }
export interface Stage extends Baseline { path: string; pendingReview?: boolean }
export interface WorkspaceState {
	version: 1;
	identity: string;
	baselines: Record<string, Baseline>;
	staged: Record<string, Stage>;
}

const INTERNAL = new Set([
	'.git', '.lore', '.wabi-sync', '.wabi-workspace', '.wabi-sync.json',
	'.wabiignore', '.loreignore', '.wabi-repo.json', '.ssh', '.gnupg',
	'node_modules', 'target', '.svelte-kit', 'build', 'dist', 'data', 'logs'
]);

export function safePath(path: string): boolean {
	return path.length > 0 && path.length <= 4096 && !/[\\\x00-\x1f:]/.test(path)
		&& path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'
			&& !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function internalPath(path: string): boolean {
	return !safePath(path) || path.split('/').some((part) => INTERNAL.has(part)
		|| part.startsWith('.env') || part === '.DS_Store' || part.includes('.wabi-conflict-'));
}

/** Same conservative * / ** grammar as wabi-sync, with ordered negation. */
export function isIgnored(path: string, source = ''): boolean {
	if (internalPath(path)) return true;
	const candidates = [path];
	let parent = path;
	while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); candidates.push(parent); }
	let ignored = false;
	for (let line of source.split(/\r?\n/)) {
		line = line.trim();
		if (!line || line.startsWith('#')) continue;
		const negate = line.startsWith('!');
		if (negate) line = line.slice(1).trim();
		line = line.replace(/\/$/, '');
		if (!line) continue;
		let pattern = '';
		for (let i = 0; i < line.length; i++) {
			if (line[i] === '*' && line[i + 1] === '*') {
				i++;
				if (line[i + 1] === '/') { pattern += '(?:.*/)?'; i++; }
				else pattern += '.*';
			} else if (line[i] === '*') pattern += '[^/]*';
			else pattern += line[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
		const regex = new RegExp(`^${pattern}$`);
		if (candidates.some((candidate) => regex.test(candidate))) ignored = !negate;
	}
	return ignored;
}

export function emptyState(identity: string): WorkspaceState {
	return { version: 1, identity, baselines: Object.create(null), staged: Object.create(null) };
}

function nullableString(value: unknown): value is string | null {
	return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 512);
}

export function parseState(raw: unknown, identity: string): WorkspaceState {
	if (raw === null) return emptyState(identity);
	if (!raw || typeof raw !== 'object') throw new Error('Invalid local workspace state. It was not overwritten.');
	const input = raw as Record<string, unknown>;
	if (input.version !== 1 || input.identity !== identity) {
		throw new Error('This folder belongs to a different account, server, or project. Choose another folder.');
	}
	const result = emptyState(identity);
	for (const name of ['baselines', 'staged'] as const) {
		const records = input[name];
		if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid workspace index.');
		for (const [path, value] of Object.entries(records)) {
			if (!safePath(path) || !value || typeof value !== 'object') throw new Error('Invalid workspace path.');
			const record = value as Record<string, unknown>;
			if (!nullableString(record.localHash) || !nullableString(record.remoteEtag)) throw new Error('Invalid workspace baseline.');
			if (name === 'staged') {
				if (record.path !== path) throw new Error('Invalid staged path.');
				result.staged[path] = { path, localHash: record.localHash, remoteEtag: record.remoteEtag, ...(record.pendingReview === true ? { pendingReview: true } : {}) };
			} else result.baselines[path] = { localHash: record.localHash, remoteEtag: record.remoteEtag };
		}
	}
	return result;
}

function indexFiles<T extends { path: string }>(files: T[], ignore: string): Map<string, T> {
	const result = new Map<string, T>();
	const caseFolded = new Map<string, string>();
	for (const file of files) {
		if (!safePath(file.path)) throw new Error(`Unsafe project path: ${file.path}`);
		if (isIgnored(file.path, ignore)) continue;
		const folded = file.path.toLowerCase();
		if (result.has(file.path) || caseFolded.has(folded)) throw new Error(`Duplicate or case-colliding path: ${file.path}`);
		result.set(file.path, file);
		caseFolded.set(folded, file.path);
	}
	return result;
}

/** Unknown missing local files are incoming, NEVER local deletions. */
export function planChanges(local: LocalFile[], remote: RemoteFile[], state: WorkspaceState, ignore = '') {
	const locals = indexFiles(local, ignore);
	const remotes = indexFiles(remote, ignore);
	const folded = new Map<string, string>();
	for (const path of [...locals.keys(), ...remotes.keys()]) {
		const previous = folded.get(path.toLowerCase());
		if (previous && previous !== path) throw new Error(`Local/remote case collision: ${previous} and ${path}`);
		folded.set(path.toLowerCase(), path);
	}
	for (const file of locals.values()) if (!file.hash) throw new Error(`Missing local fingerprint: ${file.path}`);
	for (const file of remotes.values()) if (!file.etag) throw new Error(`The server did not provide an ETag for ${file.path}; comparison stopped.`);
	const changes: Change[] = [];
	const reconciled: Record<string, Baseline> = Object.create(null);
	const paths = new Set([...locals.keys(), ...remotes.keys(), ...Object.keys(state.baselines)]);
	for (const path of [...paths].sort()) {
		if (isIgnored(path, ignore)) continue;
		const l = locals.get(path), r = remotes.get(path);
		const localHash = l?.hash ?? null, remoteEtag = r?.etag ?? null;
		const base = Object.hasOwn(state.baselines, path) ? state.baselines[path] : undefined;
		// A sampled q-* server ETag is opaque and must NOT be compared with a local SHA-256.
		const identical = localHash !== null && localHash === remoteEtag;
		if (identical || (localHash === null && remoteEtag === null)) {
			reconciled[path] = { localHash, remoteEtag };
			continue;
		}
		let kind: ChangeKind;
		if (!base) kind = l && r ? 'conflict' : l ? 'added' : 'incoming';
		else {
			const localChanged = localHash !== base.localHash;
			const remoteChanged = remoteEtag !== base.remoteEtag;
			if (!localChanged && !remoteChanged) continue;
			if (localChanged && remoteChanged) kind = 'conflict';
			else if (remoteChanged) kind = 'incoming';
			else kind = l ? (base.localHash === null ? 'added' : 'modified') : 'deleted';
		}
		changes.push({ path, kind, localHash, remoteEtag, size: l?.size ?? r?.size ?? 0 });
	}
	return { changes, reconciled };
}

export function stageChange(change: Change): Stage {
	if (!['added', 'modified', 'deleted'].includes(change.kind)) throw new Error('Pull or resolve remote changes before staging this file.');
	return { path: change.path, localHash: change.localHash, remoteEtag: change.remoteEtag };
}

export function stageStillMatches(stage: Stage, change: Change | undefined): boolean {
	return !stage.pendingReview && !!change && ['added', 'modified', 'deleted'].includes(change.kind)
		&& stage.path === change.path && stage.localHash === change.localHash && stage.remoteEtag === change.remoteEtag;
}

export interface Published extends Baseline { pendingReview: boolean; warning?: string }
export interface PublishPort {
	publish(stage: Stage, message: string): Promise<Published>;
	save(state: WorkspaceState): Promise<void>;
	active(): boolean;
}

/** Sequential, partial-success-aware publishing. Never snapshots the shared server queue. */
export async function publishStaged(state: WorkspaceState, changes: Change[], message: string, port: PublishPort) {
	if (!message.trim()) throw new Error('Write a change summary before publishing.');
	const stages = Object.values(state.staged);
	if (!stages.length) throw new Error('Stage at least one file.');
	const byPath = new Map(changes.map((change) => [change.path, change]));
	// Preflight the whole selection before the first remote mutation.
	for (const stage of stages) if (!stageStillMatches(stage, byPath.get(stage.path))) {
		throw new Error(`${stage.path} changed after staging. Review and stage it again.`);
	}
	const completed: string[] = [];
	const warnings: string[] = [];
	for (const stage of stages) {
		if (!port.active()) throw new Error('The active account or project changed. Publishing stopped.');
		const result = await port.publish(stage, message.trim());
		if (result.pendingReview) {
			state.staged[stage.path] = { ...stage, pendingReview: true };
			await port.save(state);
			throw new Error(`${stage.path} was sent for review, not published to the main project. Check Review before retrying.`);
		}
		state.baselines[stage.path] = { localHash: result.localHash, remoteEtag: result.remoteEtag };
		delete state.staged[stage.path];
		// Persist EACH accepted write. A later failure must not re-publish successful files.
		await port.save(state);
		completed.push(stage.path);
		if (result.warning) warnings.push(result.warning);
	}
	return { completed, warnings };
}

/** Explicit conflict resolution: accept the observed remote version as the new CAS baseline. */
export function keepLocal(state: WorkspaceState, change: Change): Stage {
	if (change.kind !== 'conflict') throw new Error('This file is not conflicted.');
	const previous = Object.hasOwn(state.baselines, change.path) ? state.baselines[change.path] : undefined;
	state.baselines[change.path] = { localHash: previous?.localHash ?? null, remoteEtag: change.remoteEtag };
	return { path: change.path, localHash: change.localHash, remoteEtag: change.remoteEtag };
}
