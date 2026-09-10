import { fetchWithTimeout, parseApiJson } from './api/utils';
import { parseState, planChanges, publishStaged, stageChange, keepLocal, type WorkspaceState, type LocalFile, type RemoteFile, type Change, type Stage, type Published, type Baseline } from './loreLocalChanges';

interface Connection { handle: string; folder: string; identity: string; state: unknown }
interface Scan { files: LocalFile[]; ignore: string }
interface Manifest { files: RemoteFile[]; read_only?: boolean; readOnly?: boolean }
export interface LocalSnapshot { changes: Change[]; online: boolean; notice: string; readOnly: boolean; reviewRequired: boolean }
async function native<T>(command: string, args: Record<string, unknown>): Promise<T> {
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<T>(command, args);
}
export function desktopAvailable(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** A connection is bound to one explicitly selected folder and one authenticated context. */
export class LocalWorkspace {
	readonly folder: string;
	state: WorkspaceState;
	snapshot: LocalSnapshot | null = null;
	private lastManifest: Manifest | null = null;
	private reviewRequired = false;
	private constructor(private connection: Connection, private base: string, private channel: number, private active: () => boolean) {
		this.folder = connection.folder;
		this.state = parseState(connection.state, connection.identity);
	}
	static async connect(base: string, channel: number, account: string, active: () => boolean): Promise<LocalWorkspace | null> {
		if (!desktopAvailable()) throw new Error('Local folders require the Wabi desktop app. Browser downloads are unlinked copies.');
		const connection = await native<Connection | null>('lore_local_choose', { serverUrl: base, channelId: channel, accountId: account });
		if (!active()) throw new Error('Account or project changed while choosing a folder.');
		return connection ? new LocalWorkspace(connection, base.replace(/\/+$/, ''), channel, active) : null;
	}
	private assertActive() { if (!this.active()) throw new Error('The account, server, or project changed. Reconnect the local folder.'); }
	private args() { return { handle: this.connection.handle }; }
	async save(): Promise<void> {
		// Persist accepted writes to their ORIGINAL folder even if the view was unmounted meanwhile.
		await native('lore_local_save_state', { ...this.args(), index: this.state });
	}
	async openFolder(): Promise<void> { this.assertActive(); await native('lore_local_open', this.args()); }
	private async remote(token: string): Promise<Manifest> {
		const url = `${this.base}/api/addons/lore/repos/${this.channel}`;
		const headers = { Authorization: `Bearer ${token}` };
		const [manifestResponse, repoResponse] = await Promise.all([
			fetchWithTimeout(`${url}/manifest`, { headers }), fetchWithTimeout(url, { headers })
		]);
		if (!manifestResponse.ok || !repoResponse.ok) {
			throw new Error(`Server comparison failed (HTTP ${!manifestResponse.ok ? manifestResponse.status : repoResponse.status}).`);
		}
		const manifest = await parseApiJson(manifestResponse) as Manifest | null;
		const repo = await parseApiJson(repoResponse) as Record<string, unknown> | null;
		if (!manifest || !Array.isArray(manifest.files) || !repo) throw new Error('This server did not return a valid Lore project.');
		this.reviewRequired = repo.auto_branch_on_upload === true || repo.autoBranchOnUpload === true;
		return manifest;
	}
	async refresh(token: string, requireOnline = false): Promise<LocalSnapshot> {
		this.assertActive();
		const scan = await native<Scan>('lore_local_scan', this.args());
		let online = true, notice = '';
		try { this.lastManifest = await this.remote(token); }
		catch (error) {
			if (requireOnline || !this.lastManifest) throw error;
			online = false;
			notice = 'Offline or access unavailable: comparing against the last server check. Publishing and pulling require a fresh check.';
		}
		this.assertActive();
		const manifest = this.lastManifest!;
		const plan = planChanges(scan.files, manifest.files, this.state, scan.ignore);
		// A stale/offline remote view must never establish new "synced" baselines.
		if (online) {
			let changed = false;
			for (const [path, baseline] of Object.entries(plan.reconciled)) {
				const old = Object.hasOwn(this.state.baselines, path) ? this.state.baselines[path] : undefined;
				if (!old || old.localHash !== baseline.localHash || old.remoteEtag !== baseline.remoteEtag) {
					this.state.baselines[path] = baseline; changed = true;
				}
				if (Object.hasOwn(this.state.staged, path) && !this.state.staged[path].pendingReview) { delete this.state.staged[path]; changed = true; }
			}
			if (changed) await this.save();
		}
		this.snapshot = { changes: plan.changes, online, notice, readOnly: manifest.read_only === true || manifest.readOnly === true, reviewRequired: this.reviewRequired };
		return this.snapshot;
	}
	async stage(change: Change, checked: boolean): Promise<void> {
		this.assertActive();
		if (checked) this.state.staged[change.path] = stageChange(change);
		else delete this.state.staged[change.path];
		await this.save();
	}
	async unstageAll(): Promise<void> { this.assertActive(); this.state.staged = Object.create(null); await this.save(); }
	async resolveKeepLocal(change: Change): Promise<void> {
		this.assertActive();
		if (!this.snapshot?.online) throw new Error('Reconnect and refresh before resolving a conflict.');
		this.state.staged[change.path] = keepLocal(this.state, change);
		await this.save();
	}
	async publish(token: string, message: string) {
		const snapshot = await this.refresh(token, true);
		if (snapshot.readOnly) throw new Error('This is a read-only mirror. Local changes cannot be published here.');
		if (snapshot.reviewRequired) throw new Error('This project requires review. Use the Repository review flow; desktop publishing does not bypass it.');
		return publishStaged(this.state, snapshot.changes, message, {
			active: this.active,
			save: () => this.save(),
			publish: (stage: Stage, summary: string) => native<Published>('lore_local_publish', {
				...this.args(), path: stage.path, localHash: stage.localHash, remoteEtag: stage.remoteEtag, token, message: summary
			})
		});
	}
	async pull(token: string, selection: Change[]): Promise<number> {
		const snapshot = await this.refresh(token, true);
		for (const selected of selection) {
			const fresh = snapshot.changes.find((c) => c.path === selected.path);
			if (!fresh || fresh.localHash !== selected.localHash || fresh.remoteEtag !== selected.remoteEtag
				|| !['incoming', 'conflict'].includes(fresh.kind)) throw new Error(`${selected.path} changed since confirmation. Review the new comparison.`);
		}
		let count = 0;
		for (const selected of selection) {
			this.assertActive();
			const result = await native<Baseline>('lore_local_pull', {
				...this.args(), path: selected.path, localHash: selected.localHash, remoteEtag: selected.remoteEtag, token
			});
			this.state.baselines[selected.path] = result;
			delete this.state.staged[selected.path];
			await this.save(); count++;
		}
		return count;
	}
}
