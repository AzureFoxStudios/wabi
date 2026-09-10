<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getAuthToken, getStoredDbUserId, authSessionGeneration } from '$lib/authSession';
	import { getApiBase } from '$lib/api/utils';
	import { parseLoreChannelId } from '$lib/api/lore';
	import { LocalWorkspace, desktopAvailable, type LocalSnapshot } from '$lib/loreLocalWorkspace';
	import { stageStillMatches, type Change, type Stage } from '$lib/loreLocalChanges';
	import { LocalDetection, type DetectionStatus } from '$lib/loreLocalDetection';

	let { channelId, projectName, serverUrl, accountId, onCounts }: { channelId: string; projectName: string; serverUrl: string; accountId: string; onCounts?: (value: { outgoing: number; incoming: number; conflicts: number }) => void } = $props();
	let workspace = $state<LocalWorkspace | null>(null);
	let snapshot = $state<LocalSnapshot | null>(null);
	let staged = $state<Record<string, Stage>>({});
	let busy = $state(false);
	let error = $state('');
	let status = $state('');
	let summary = $state('');
	let lastChecked = $state('');
	let alive = true;
	let generation = $state<number | null>(null);
	let native = $state(false);
	let detectionStatus = $state<DetectionStatus>({ checking: false, paused: false, warning: '' });
	let detector: LocalDetection | null = null;
	let numericId = $derived(parseLoreChannelId(channelId));

	onMount(() => {
		generation = authSessionGeneration(serverUrl); native = desktopAvailable();
		const nudge = () => { if (document.visibilityState !== 'hidden') detector?.nudge(); };
		window.addEventListener('focus', nudge);
		window.addEventListener('online', nudge);
		document.addEventListener('visibilitychange', nudge);
		return () => {
			window.removeEventListener('focus', nudge);
			window.removeEventListener('online', nudge);
			document.removeEventListener('visibilitychange', nudge);
		};
	});
	const active = () => alive && generation !== null && getApiBase().replace(/\/+$/, '') === serverUrl.replace(/\/+$/, '')
		&& authSessionGeneration(serverUrl) === generation && String(getStoredDbUserId(serverUrl) ?? '') === accountId;
	onDestroy(() => { alive = false; void detector?.dispose().catch(() => {}); });
	let outgoing = $derived(snapshot?.changes.filter((c) => ['added', 'modified', 'deleted'].includes(c.kind)) ?? []);
	let incoming = $derived(snapshot?.changes.filter((c) => c.kind === 'incoming') ?? []);
	let conflicts = $derived(snapshot?.changes.filter((c) => c.kind === 'conflict') ?? []);
	let stagedCount = $derived(Object.keys(staged).length);
	$effect(() => { onCounts?.({ outgoing: outgoing.length, incoming: incoming.length, conflicts: conflicts.length }); });
	let staleCount = $derived(Object.values(staged).filter((entry) => {
		const change = snapshot?.changes.find((c) => c.path === entry.path);
		return !change || !stageStillMatches(entry, change);
	}).length);
	let canPublish = $derived(!!snapshot?.online && !snapshot.readOnly && !snapshot.reviewRequired && stagedCount > 0 && staleCount === 0 && !!summary.trim());

	function token(): string {
		if (!active()) throw new Error('Account or server changed. Reopen Local changes.');
		const value = getAuthToken(serverUrl);
		if (!value) throw new Error('Sign in before using this project.');
		return value;
	}
	function reflect() { if (active() && workspace) { staged = { ...workspace.state.staged }; snapshot = workspace.snapshot; } }
	function startDetection(target: LocalWorkspace) {
		detectionStatus = { checking: false, paused: false, warning: '' };
		detector = new LocalDetection({
			active: () => active() && workspace === target,
			visible: () => document.visibilityState !== 'hidden',
			probe: () => target.probeChanges(),
			compare: async (scanLocal) => {
				const result = await target.detect(token(), scanLocal);
				if (!active() || workspace !== target) return;
				reflect(); lastChecked = new Date().toLocaleTimeString();
				if (!result.online) throw new Error(result.notice);
			},
			release: () => target.stopWatching(),
			status: (value) => { if (active() && workspace === target) detectionStatus = value; }
		});
		detector.start();
	}
	async function perform(action: () => Promise<void>, serialize = true) {
		if (busy) return;
		busy = true; error = ''; status = '';
		try { if (serialize && detector) await detector.runManual(action); else await action(); }
		catch (e) { if (alive) error = e instanceof Error ? e.message : String(e); }
		finally { if (alive) { reflect(); busy = false; } }
	}
	async function refresh() {
		if (!workspace) return;
		await workspace.refresh(token()); reflect(); lastChecked = new Date().toLocaleTimeString();
	}
	async function connect() {
		if (!numericId) throw new Error('Select a valid Project channel.');
		token();
		// Do not dispose from inside its own manual queue: wait for the old watcher first.
		const previous = detector; detector = null;
		await previous?.dispose();
		try {
			const selected = await LocalWorkspace.connect(serverUrl, numericId, accountId, active);
			if (!selected) return;
			workspace = selected; snapshot = null; staged = {}; lastChecked = ''; summary = '';
			await selected.save();
			await refresh();
			status = 'Folder connected. Changes are detected automatically; pulling and publishing are your decisions.';
		} finally { if (workspace && active()) startDetection(workspace); }
	}
	async function publish() {
		if (!workspace) return;
		const deletions = Object.values(staged).filter((item) => item.localHash === null);
		if (deletions.length && !window.confirm(`Publish ${deletions.length} file deletion(s) to ${projectName}?\n\n${deletions.map((item) => item.path).join('\n')}`)) return;
		const result = await workspace.publish(token(), summary);
		summary = '';
		await refresh();
		status = `Published ${result.completed.length} file(s), with one revision per file. ${result.warnings.join(' ')}`;
	}
	async function pull(selection: Change[]) {
		if (!workspace || !selection.length) return;
		if (!window.confirm(`Apply ${selection.length} server change(s) to your local folder?\n\n${selection.map((c) => `${c.remoteEtag === null ? 'Remove' : 'Download'}: ${c.path}`).join('\n')}\n\nExisting local versions are preserved in .wabi-workspace/backups.`)) return;
		const count = await workspace.pull(token(), selection);
		await refresh(); status = `Applied ${count} server change(s).`;
	}
	async function resolveLocal(change: Change) {
		if (!workspace || !window.confirm(`Keep your local version of ${change.path}?\n\nThis stages ${change.localHash === null ? 'a remote deletion' : 'your local file'} against the current server version. Nothing is published until you click Publish staged.`)) return;
		await workspace.resolveKeepLocal(change); await refresh();
	}
	function size(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`; }
</script>

<section class="local-workspace" aria-label="Local project changes" aria-busy={busy}>
	<header>
		<div><h2>{projectName}: local changes</h2><p>Changes appear automatically. You decide what to stage, publish, or pull.</p></div>
		{#if native}<button disabled={busy} onclick={() => perform(connect, false)}>{workspace ? 'Choose another folder' : 'Use this project on my computer'}</button>{/if}
	</header>
	{#if !native}
		<div class="notice"><h3>Local folders are a desktop feature</h3><p>The website can browse repositories and download copies, but it cannot silently monitor a folder on your computer. Open this project in the Wabi desktop app to connect a folder and stage changes.</p><p>A downloaded ZIP is still an unlinked copy. Existing command-line wabi-sync remains a separate automatic-sync workflow.</p></div>
	{:else}
		{#if error}<p role="alert" class="notice error">{error}</p>{/if}
		{#if status}<p role="status" class="notice">{status}</p>{/if}
		{#if workspace}
			<div class="folder-bar"><div><strong>Local folder</strong><code>{workspace.folder}</code><small>{lastChecked ? `Last checked ${lastChecked}` : 'Not checked yet'} · {detectionStatus.paused ? 'Detection paused' : detectionStatus.checking ? 'Checking for changes…' : 'Automatic detection on'} · Manual publishing and pulling</small></div><div class="actions"><button disabled={busy} onclick={() => perform(async () => { await workspace?.openFolder(); })}>Open folder</button><button disabled={busy} onclick={() => perform(refresh)}>Check now</button><button disabled={busy} aria-pressed={detectionStatus.paused} onclick={() => detector?.setPaused(!detectionStatus.paused)}>{detectionStatus.paused ? 'Resume detection' : 'Pause detection'}</button><button disabled={busy || !snapshot?.online || !incoming.length} onclick={() => perform(() => pull(incoming))}>Pull incoming ({incoming.length})</button></div></div>
			{#if detectionStatus.warning}<p role="status" class="notice">{detectionStatus.warning}</p>{/if}
			{#if snapshot?.notice}<p role="status" class="notice">{snapshot.notice}</p>{/if}
			{#if incoming.length && snapshot?.online}<p role="status" class="notice">{incoming.length} incoming change(s) available. Your local files have not been changed. Review the list and choose Pull incoming to apply them.</p>{/if}
			{#if snapshot?.readOnly}<p class="notice">Read-only mirror: pulling is available, but local changes cannot be published here.</p>{/if}
			{#if snapshot?.reviewRequired}<p class="notice">This project requires review. Use its Repository review workflow to publish; local staging does not bypass review.</p>{/if}
			<div class="changes-layout">
				<div class="changes-list">
					<h3>Your changes ({outgoing.length})</h3>
					{#each outgoing as change (change.path)}
						<label class="change-row"><input type="checkbox" checked={!!staged[change.path]} disabled={busy || snapshot?.readOnly || snapshot?.reviewRequired} onchange={(event) => { const checked = event.currentTarget.checked; void perform(async () => { await workspace?.stage(change, checked); }); }} /><span class="kind">{change.kind}</span><span class="filename">{change.path}{#if staged[change.path] && !stageStillMatches(staged[change.path], change)}<small>Changed after staging or awaiting review — review before restaging.</small>{/if}</span><span class="file-size">{size(change.size)}</span></label>
					{:else}<p class="muted">No outgoing changes in the last comparison.</p>{/each}
					<h3>Incoming ({incoming.length})</h3>
					{#each incoming as change (change.path)}<div class="change-row"><span class="kind">{change.remoteEtag === null ? 'removed' : 'updated'}</span><span class="filename">{change.path}</span><span class="file-size">{size(change.size)}</span></div>{:else}<p class="muted">No incoming changes in the last comparison.</p>{/each}
					<h3>Conflicts ({conflicts.length})</h3>
					{#each conflicts as change (change.path)}<div class="conflict"><strong>{change.path}</strong><p>Local and server versions differ. Neither will be overwritten automatically.</p><div class="actions"><button disabled={busy || !snapshot?.online || snapshot.readOnly || snapshot.reviewRequired} onclick={() => perform(() => resolveLocal(change))}>Keep local and stage</button><button disabled={busy || !snapshot?.online} onclick={() => perform(() => pull([change]))}>Use server version</button></div></div>{:else}<p class="muted">No conflicts.</p>{/each}
				</div>
				<aside class="publish-panel">
					<h3>Staged ({stagedCount})</h3>
					<p>Staging records the version you reviewed. Editing it again requires restaging; it will not silently publish newer edits.</p>
					{#if staleCount}<p role="status">{staleCount} staged selection(s) need review. Uncheck and select changed files again, or unstage them. Automatic detection never restages your work.</p>{/if}
					{#each Object.values(staged) as entry (entry.path)}<code>{entry.path}</code>{/each}
					<button disabled={busy || !stagedCount} onclick={() => perform(async () => { await workspace?.unstageAll(); })}>Unstage all</button>
					<label for="local-publish-summary">Change summary</label><textarea id="local-publish-summary" rows="3" maxlength="2000" bind:value={summary} disabled={busy} placeholder="What changed, and why?"></textarea>
					<button class="primary" disabled={busy || !canPublish} onclick={() => perform(publish)}>{busy ? 'Working…' : `Publish staged (${stagedCount})`}</button>
					<small>Each published file creates its own Lore revision. This is not one atomic multi-file commit, and publishing stops at the first failure.</small>
				</aside>
			</div>
		{:else}<div class="notice"><p>Choose an empty folder to pull an existing project, or choose your own project folder to review its differences first. Existing files are never assumed safe to overwrite.</p><p>Use a separate folder from any automatic wabi-sync process. Local credentials are not stored in the project.</p></div>{/if}
	{/if}
</section>

<style>
	.local-workspace { padding: 1rem; color: var(--text-primary); }
	header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; align-items: center; }
	h2 { font-size: 1.125rem; margin: 0 0 0.35rem; } h3 { font-size: 0.95rem; margin: 1rem 0 0.6rem; }
	p { margin: 0.4rem 0; line-height: 1.5; } header p, .muted, small { color: var(--text-secondary); }
	button { color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 0.5rem 0.7rem; border-radius: 4px; cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: not-allowed; } button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent-color, currentColor); outline-offset: 2px; }
	.notice, .folder-bar, .publish-panel, .conflict { border: 1px solid var(--border-color); background: var(--bg-secondary); padding: 0.85rem; margin-top: 1rem; border-radius: 4px; }
	.error { border-color: var(--danger-color, #bc4b4b); }
	.folder-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
	code { display: block; overflow-wrap: anywhere; font-size: 0.8rem; margin: 0.35rem 0; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.changes-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(15rem, 20rem); gap: 1rem; }
	.change-row { display: flex; gap: 0.6rem; align-items: center; border-bottom: 1px solid var(--border-color); padding: 0.7rem 0.2rem; }
	.kind { min-width: 4.5rem; text-transform: capitalize; font-size: 0.8rem; color: var(--text-secondary); }
	.filename { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 0.875rem; }.filename small { display: block; }
	.file-size { white-space: nowrap; font-size: 0.75rem; color: var(--text-secondary); }
	.publish-panel { align-self: start; } .publish-panel p, .conflict p { font-size: 0.8rem; }
	.publish-panel label { display: block; margin-top: 1rem; font-size: 0.85rem; }
	textarea { box-sizing: border-box; width: 100%; resize: vertical; margin: 0.5rem 0; padding: 0.6rem; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color); }
	.primary { width: 100%; font-weight: 600; } .publish-panel small { display: block; margin-top: 0.6rem; line-height: 1.5; }
	@media (max-width: 760px) { .changes-layout { grid-template-columns: minmax(0, 1fr); } .publish-panel { order: -1; } .file-size { display: none; } }
</style>
