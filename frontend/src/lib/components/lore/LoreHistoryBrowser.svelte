<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onDestroy, untrack } from 'svelte';
	import { getLoreFileHistory, getLoreFileDiff, getSignedLoreUrl, type LoreRevision, type LoreFileInfo } from '$lib/api/lore';
	import { newestFirst, revisionSummary, formatRevisionTime, previewKind, SelectionEpoch } from '$lib/lore/workspacePresentation';
	import LoreDiffViewer from './LoreDiffViewer.svelte';
	import LoreImageCompare from './LoreImageCompare.svelte';

	let { revisions, files, channelId, getToken, isActive, initialPath = '' }: {
		revisions: LoreRevision[]; files: LoreFileInfo[]; channelId: number;
		getToken: () => string; isActive: () => boolean; initialPath?: string;
	} = $props();
	let query = $state('');
	let selectedHash = $state<string | null>(null);
	let selected = $derived(revisions.find(item => item.hash === selectedHash) ?? null);
	let path = $state('');
	let pathHistory = $state<LoreRevision[]>([]);
	let from = $state('');
	let to = $state('');
	let busy = $state(false);
	let error = $state('');
	let compared = $state(false);
	let diff = $state<string | null>(null);
	let images = $state<{ before: string; after: string } | null>(null);
	let mode = $state<'unified' | 'side-by-side'>('unified');
	const requests = new SelectionEpoch();
	let ordered = $derived(newestFirst(revisions));
	let visible = $derived(ordered.filter(item => `${item.message} ${item.hash} ${item.authorId}`.toLowerCase().includes(query.toLowerCase())));
	let detail = $derived(selected ? revisionSummary(selected.message) : null);
	$effect(() => {
		const requested = initialPath;
		if (requested) untrack(() => { path = requested; void loadPath(); });
	});
	onDestroy(() => requests.dispose());
	function clearComparison() { requests.begin(); busy = false; error = ''; compared = false; diff = null; images = null; }
	function selectRevision(revision: LoreRevision) { selectedHash = revision.hash; }
	function pathChanged() { clearComparison(); pathHistory = []; from = ''; to = ''; }
	async function loadPath() {
		clearComparison(); pathHistory = []; from = ''; to = '';
		const requestedPath = path.trim(); if (!requestedPath) return;
		const request = requests.begin(); busy = true;
		try {
			const result = newestFirst(await getLoreFileHistory(getToken(), channelId, requestedPath)).filter(item => !!item.hash);
			if (!isActive() || !requests.current(request)) return;
			pathHistory = result; to = result[0]?.hash ?? ''; from = result[1]?.hash ?? '';
			if (!result.length) error = $_('lore_history.no_history');
		} catch (e) { if (isActive() && requests.current(request)) error = e instanceof Error ? e.message : $_('lore_history.err_history'); }
		finally { if (requests.current(request)) busy = false; }
	}
	async function compare() {
		if (busy || !from || !to || from === to) return;
		const request = requests.begin(); busy = true; error = ''; diff = null; images = null; compared = false;
		const requestedPath = path.trim(), before = from, after = to;
		try {
			const token = getToken(), kind = previewKind(requestedPath);
			if (kind === 'image') {
				const [a, b] = await Promise.all([getSignedLoreUrl(token, channelId, requestedPath, before), getSignedLoreUrl(token, channelId, requestedPath, after)]);
				if (isActive() && requests.current(request)) images = { before: a, after: b };
			} else if (kind === 'text') {
				const result = await getLoreFileDiff(token, channelId, requestedPath, before, after);
				if (isActive() && requests.current(request)) diff = result;
			}
			if (isActive() && requests.current(request)) compared = true;
		} catch (e) { if (isActive() && requests.current(request)) error = e instanceof Error ? e.message : $_('lore_history.err_compare'); }
		finally { if (requests.current(request)) busy = false; }
	}
	async function download(revision: string) {
		const requestedPath = path.trim();
		try {
			const url = await getSignedLoreUrl(getToken(), channelId, requestedPath, revision);
			if (!isActive() || path.trim() !== requestedPath) return;
			const anchor = document.createElement('a'); anchor.href = url; anchor.download = requestedPath.split('/').pop() ?? 'revision'; anchor.rel = 'noopener'; anchor.click();
		} catch (e) { if (isActive()) error = e instanceof Error ? e.message : $_('lore_history.err_download'); }
	}
</script>

<div class="lw-history">
	<section class="lw-history-list" aria-label={$_('lore_history.aria_list')}>
		<div class="lw-section-head"><h2>{$_('lore_history.history')}</h2><span>{$_('lore_history.revisions_count', { values: { count: ordered.length } })}</span></div>
		<label class="lw-search"><span class="lw-sr-only">{$_('lore_history.search_sr')}</span><input type="search" bind:value={query} placeholder={$_('lore_history.search_placeholder')} /></label>
		<p class="lw-help">{$_('lore_history.newest_first')}</p>
		{#each visible as revision}
			{@const summary = revisionSummary(revision.message)}
			<button class="lw-revision" class:is-selected={selected === revision} aria-pressed={selected === revision} onclick={() => selectRevision(revision)}>
				<strong>{summary.title}</strong><span>{revision.authorId ? $_('lore_history.user_id', { values: { id: revision.authorId } }) : $_('lore_history.author_unavailable')} · {formatRevisionTime(revision.timestamp)}</span>
				<code>{revision.hash ? revision.hash.slice(0, 8) : $_('lore_history.revision_id_unavailable')}</code>
			</button>
		{:else}<p class="lw-empty-inline">{query ? $_('lore_history.no_match') : $_('lore_history.no_revisions')}</p>{/each}
	</section>
	<section class="lw-history-detail" aria-label={$_('lore_history.aria_detail')}>
		{#if selected && detail}
			<header class="lw-detail-head"><p class="lw-eyebrow">{$_('lore_history.revision_details')}</p><h2>{detail.title}</h2><p>{selected.authorId ? $_('lore_history.user_id', { values: { id: selected.authorId } }) : $_('lore_history.author_unavailable')} · {formatRevisionTime(selected.timestamp)}</p><code>{selected.hash || $_('lore_history.revision_id_unavailable')}</code>{#if detail.detail}<p class="lw-revision-message">{detail.detail}</p>{/if}</header>
		{:else}<header class="lw-detail-head"><h2>{$_('lore_history.understand')}</h2><p>{$_('lore_history.understand_help')}</p></header>{/if}
		<div class="lw-comparison-controls">
			<h3>{$_('lore_history.compare_file')}</h3><p class="lw-help">{$_('lore_history.compare_help')}</p>
			<form class="lw-inline-form" onsubmit={(event) => { event.preventDefault(); void loadPath(); }}><label>{$_('lore_history.file_path')}<input list={`lore-history-paths-${channelId}`} bind:value={path} oninput={pathChanged} placeholder="docs/README.md" required /></label><button class="lw-button" disabled={busy || !path.trim()}>{$_('lore_history.load_versions')}</button></form>
			<datalist id={`lore-history-paths-${channelId}`}>{#each files.filter(file => file.path.toLowerCase().includes(path.toLowerCase())).slice(0, 100) as file (file.path)}<option value={file.path} />{/each}</datalist>
			{#if pathHistory.length}
				<div class="lw-inline-form"><label>{$_('lore_history.before')}<select bind:value={from} onchange={clearComparison}><option value="">{$_('lore_history.choose_version')}</option>{#each pathHistory as revision}<option value={revision.hash}>{formatRevisionTime(revision.timestamp)} · {revision.hash.slice(0, 8)}</option>{/each}</select></label><label>{$_('lore_history.after')}<select bind:value={to} onchange={clearComparison}><option value="">{$_('lore_history.choose_version')}</option>{#each pathHistory as revision}<option value={revision.hash}>{formatRevisionTime(revision.timestamp)} · {revision.hash.slice(0, 8)}</option>{/each}</select></label><button class="lw-button lw-primary" disabled={busy || !from || !to || from === to} onclick={() => void compare()}>{$_('lore_history.compare')}</button></div>
			{/if}
			{#if pathHistory.length === 1}<p class="lw-help">{$_('lore_history.one_version')}</p>{/if}
			{#if error}<p class="lw-alert" role="alert">{error}</p>{/if}
			{#if busy}<p role="status">{$_('lore_history.loading_compare')}</p>{/if}
		</div>
		{#if compared}
			<div class="lw-comparison-result">
				{#if images}<LoreImageCompare before={images.before} after={images.after} beforeLabel={$_('lore_history.before_label', { values: { hash: from.slice(0, 8) } })} afterLabel={$_('lore_history.after_label', { values: { hash: to.slice(0, 8) } })} />
				{:else if diff !== null}{#if diff}<LoreDiffViewer {diff} {mode} onModeChange={(value) => mode = value} filePath={path} />{:else}<p class="lw-empty-inline">{$_('lore_history.no_text_diff')}</p>{/if}
				{:else}<p class="lw-empty-inline">{$_('lore_history.binary')}</p>{/if}
				<div class="lw-download-versions"><button class="lw-button" onclick={() => void download(from)}>{$_('lore_history.dl_before')}</button><button class="lw-button" onclick={() => void download(to)}>{$_('lore_history.dl_after')}</button></div>
			</div>
		{/if}
	</section>
</div>
