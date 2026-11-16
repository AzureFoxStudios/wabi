<script lang="ts">
	import { _ } from '$lib/i18n';
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
		if (!active()) throw new Error($_('lore_local.err_account_changed'));
		const value = getAuthToken(serverUrl);
		if (!value) throw new Error($_('lore_local.err_sign_in'));
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
		if (!numericId) throw new Error($_('lore_local.err_select_channel'));
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
			status = $_('lore_local.folder_connected');
		} finally { if (workspace && active()) startDetection(workspace); }
	}
	async function publish() {
		if (!workspace) return;
		const deletions = Object.values(staged).filter((item) => item.localHash === null);
		if (deletions.length && !window.confirm($_('lore_local.confirm_publish', { values: { count: deletions.length, project: projectName, files: deletions.map((item) => item.path).join('\n') } }))) return;
		const result = await workspace.publish(token(), summary);
		summary = '';
		await refresh();
		status = $_('lore_local.published', { values: { count: result.completed.length, warnings: result.warnings.join(' ') } });
	}
	async function pull(selection: Change[]) {
		if (!workspace || !selection.length) return;
		if (!window.confirm(`${$_('lore_local.confirm_pull', { values: { count: selection.length } })}\n\n${selection.map((c) => `${c.remoteEtag === null ? $_('lore_local.word_remove') : $_('context_menu.download')}: ${c.path}`).join('\n')}\n\n${$_('lore_local.pull_preserved')}`)) return;
		const count = await workspace.pull(token(), selection);
		await refresh(); status = $_('lore_local.applied', { values: { count } });
	}
	async function resolveLocal(change: Change) {
		if (!workspace || !window.confirm($_('lore_local.confirm_keep', { values: { path: change.path, what: change.localHash === null ? $_('lore_local.what_remote_deletion') : $_('lore_local.what_local_file') } }))) return;
		await workspace.resolveKeepLocal(change); await refresh();
	}
	function size(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} ${$_('lore_local.unit_mib')}` : `${Math.ceil(bytes / 1024)} ${$_('lore_local.unit_kib')}`; }
</script>

<section class="local-workspace" aria-label={$_('lore_local.aria_label')} aria-busy={busy}>
	<header>
		<div><h2>{projectName}: {$_('lore_local.heading')}</h2><p>{$_('lore_local.intro')}</p></div>
		{#if native}<button disabled={busy} onclick={() => perform(connect, false)}>{workspace ? $_('lore_local.choose_folder') : $_('lore_local.use_on_computer')}</button>{/if}
	</header>
	{#if !native}
		<div class="notice"><h3>{$_('lore_local.desktop_title')}</h3><p>{$_('lore_local.desktop_body')}</p><p>{$_('lore_local.zip_note')}</p></div>
	{:else}
		{#if error}<p role="alert" class="notice error">{error}</p>{/if}
		{#if status}<p role="status" class="notice">{status}</p>{/if}
		{#if workspace}
			<div class="folder-bar"><div><strong>{$_('lore_local.folder_label')}</strong><code>{workspace.folder}</code><small>{lastChecked ? $_('lore_local.last_checked', { values: { time: lastChecked } }) : $_('lore_local.not_checked')} · {detectionStatus.paused ? $_('lore_local.detection_paused') : detectionStatus.checking ? $_('lore_local.checking') : $_('lore_local.detection_on')} · {$_('lore_local.manual_note')}</small></div><div class="actions"><button disabled={busy} onclick={() => perform(async () => { await workspace?.openFolder(); })}>{$_('lore_local.open_folder')}</button><button disabled={busy} onclick={() => perform(refresh)}>{$_('lore_local.check_now')}</button><button disabled={busy} aria-pressed={detectionStatus.paused} onclick={() => detector?.setPaused(!detectionStatus.paused)}>{detectionStatus.paused ? $_('lore_local.resume_detection') : $_('lore_local.pause_detection')}</button><button disabled={busy || !snapshot?.online || !incoming.length} onclick={() => perform(() => pull(incoming))}>{$_('lore_local.pull_incoming', { values: { count: incoming.length } })}</button></div></div>
			{#if detectionStatus.warning}<p role="status" class="notice">{detectionStatus.warning}</p>{/if}
			{#if snapshot?.notice}<p role="status" class="notice">{snapshot.notice}</p>{/if}
			{#if incoming.length && snapshot?.online}<p role="status" class="notice">{$_('lore_local.incoming_available', { values: { count: incoming.length } })}</p>{/if}
			{#if snapshot?.readOnly}<p class="notice">{$_('lore_local.read_only')}</p>{/if}
			{#if snapshot?.reviewRequired}<p class="notice">{$_('lore_local.review_required')}</p>{/if}
			<div class="changes-layout">
				<div class="changes-list">
					<h3>{$_('lore_local.your_changes', { values: { count: outgoing.length } })}</h3>
					{#each outgoing as change (change.path)}
						<label class="change-row"><input type="checkbox" checked={!!staged[change.path]} disabled={busy || snapshot?.readOnly || snapshot?.reviewRequired} onchange={(event) => { const checked = event.currentTarget.checked; void perform(async () => { await workspace?.stage(change, checked); }); }} /><span class="kind">{change.kind}</span><span class="filename">{change.path}{#if staged[change.path] && !stageStillMatches(staged[change.path], change)}<small>{$_('lore_local.changed_after')}</small>{/if}</span><span class="file-size">{size(change.size)}</span></label>
					{:else}<p class="muted">{$_('lore_local.no_outgoing')}</p>{/each}
					<h3>{$_('lore_local.incoming_h', { values: { count: incoming.length } })}</h3>
					{#each incoming as change (change.path)}<div class="change-row"><span class="kind">{change.remoteEtag === null ? $_('lore_local.kind_removed') : $_('lore_local.kind_updated')}</span><span class="filename">{change.path}</span><span class="file-size">{size(change.size)}</span></div>{:else}<p class="muted">{$_('lore_local.no_incoming')}</p>{/each}
					<h3>{$_('lore_local.conflicts_h', { values: { count: conflicts.length } })}</h3>
					{#each conflicts as change (change.path)}<div class="conflict"><strong>{change.path}</strong><p>{$_('lore_local.conflict_body')}</p><div class="actions"><button disabled={busy || !snapshot?.online || snapshot.readOnly || snapshot.reviewRequired} onclick={() => perform(() => resolveLocal(change))}>{$_('lore_local.keep_local')}</button><button disabled={busy || !snapshot?.online} onclick={() => perform(() => pull([change]))}>{$_('lore_local.use_server')}</button></div></div>{:else}<p class="muted">{$_('lore_local.no_conflicts')}</p>{/each}
				</div>
				<aside class="publish-panel">
					<h3>{$_('lore_local.staged_h', { values: { count: stagedCount } })}</h3>
					<p>{$_('lore_local.staging_note')}</p>
					{#if staleCount}<p role="status">{$_('lore_local.stale_note', { values: { count: staleCount } })}</p>{/if}
					{#each Object.values(staged) as entry (entry.path)}<code>{entry.path}</code>{/each}
					<button disabled={busy || !stagedCount} onclick={() => perform(async () => { await workspace?.unstageAll(); })}>{$_('lore_local.unstage_all')}</button>
					<label for="local-publish-summary">{$_('lore_local.change_summary')}</label><textarea id="local-publish-summary" rows="3" maxlength="2000" bind:value={summary} disabled={busy} placeholder={$_('lore_local.summary_placeholder')}></textarea>
					<button class="primary" disabled={busy || !canPublish} onclick={() => perform(publish)}>{busy ? $_('lore_local.working') : $_('lore_local.publish_staged', { values: { count: stagedCount } })}</button>
					<small>{$_('lore_local.publish_note')}</small>
				</aside>
			</div>
		{:else}<div class="notice"><p>{$_('lore_local.empty_folder')}</p><p>{$_('lore_local.separate_folder')}</p></div>{/if}
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
