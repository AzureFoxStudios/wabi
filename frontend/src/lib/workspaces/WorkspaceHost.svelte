<!--
	The office host (design contract §8.8): loads Documents, Sheets or Present into center stage.

	No bands above the tool: turning Sheets or Present off lives in the editor's ⋯ (with a confirm)
	and in Settings › Add-ons; the server's sharing policy lives in Settings › Admin. While a tool
	loads, the 2px line sits under the masthead with a library skeleton. When Sheets or Present is
	off on this device, a centered card explains the add-on with its consent facts verbatim.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { notebookOwner } from '$lib/notes/scope';
	import { hydrateWorkspaceAddons, setWorkspaceAddonEnabled, workspaceAddonEnabled } from './addonState';
	import type { Tool } from './bridge';
	import FileExportNotice from './FileExportNotice.svelte';
	import LoadLine from '$lib/components/ui/LoadLine.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { _ } from '$lib/i18n';
	import './workspace.css';

	let { tool }: { tool: Tool } = $props();
	let WorkspaceComponent = $state<Component | null>(null);
	let ready = $state(false), available = $state(true), loading = $state(false), error = $state(''), enabling = $state(false);
	let requestGeneration = 0;
	let loadedTool = $state<Tool | null>(null), loadedScope = $state<string | null>(null);
	const enabled = $derived(tool === 'sheets' || tool === 'present' ? $workspaceAddonEnabled[tool] : true);
	const scopeKey = $derived($notebookOwner.owner?.scopeId || 'waiting-for-account');

	const TOOLS: Record<Tool, { name: string; icon: IconName; does: string }> = {
		documents: { name: 'Documents', icon: 'file', does: 'Write and share documents with the people on this server.' },
		sheets: { name: 'Sheets', icon: 'sheet', does: 'Spreadsheets with formulas, filters and charts, private until you share them.' },
		present: { name: 'Present', icon: 'present', does: 'Build slide decks and present them to a channel or a call.' },
		audience: { name: 'Presentation', icon: 'present', does: 'Follow a presentation shared with you.' }
	};
	const info = $derived(TOOLS[tool] ?? TOOLS.documents);

	async function load(selected: Tool, generation: number, identity: string) {
		WorkspaceComponent = null; loadedTool = null; loadedScope = null; loading = true; error = ''; available = true;
		try {
			if (selected === 'sheets' || selected === 'present') {
				const entry = selected === 'sheets' ? await import('@wabi/workspace-sheets') : await import('@wabi/workspace-present');
				if (generation !== requestGeneration) return;
				available = entry.available;
				if (!entry.available || !enabled) return;
				const module = await entry.loadWorkspace();
				if (generation === requestGeneration) { loadedTool = selected; loadedScope = identity; WorkspaceComponent = module.default; }
			} else {
				const module = selected === 'documents' ? await import('./DocumentsWorkspace.svelte') : await import('./AudienceWorkspace.svelte');
				if (generation === requestGeneration) { loadedTool = selected; loadedScope = identity; WorkspaceComponent = module.default; }
			}
		} catch (e) {
			if (generation === requestGeneration) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (generation === requestGeneration) loading = false;
		}
	}
	$effect(() => {
		const selected = tool;
		const permitted = enabled;
		const identity = scopeKey;
		if (ready) { permitted; identity; void load(selected, ++requestGeneration, identity); }
	});
	async function enable() {
		if (tool !== 'sheets' && tool !== 'present') return;
		enabling = true;
		try { error = ''; await setWorkspaceAddonEnabled(tool, true); }
		catch (e) { error = e instanceof Error ? e.message : String(e); }
		finally { enabling = false; }
	}
	function retry() {
		error = '';
		void load(tool, ++requestGeneration, scopeKey);
	}
	onMount(() => {
		let live = true;
		void hydrateWorkspaceAddons().catch((e) => (error = e.message)).finally(() => { if (live) ready = true; });
		return () => { live = false; requestGeneration++; };
	});

	const opening = $derived((loading || !ready) && !error);
</script>

<section class="workspace-host" data-workspace-tool={tool}>
	<FileExportNotice />
	<LoadLine active={opening} label={`Opening ${info.name}…`} class="workspace-host__line" />
	{#if error}
		<div class="workspace-host__notice">
			<Notice title={`${info.name} couldn't open`} text="Your files on this device are unchanged." onretry={retry} {error} />
		</div>
	{/if}
	{#if !available}
		<div class="workspace-gate">
			<div class="workspace-gate__card">
				<span class="workspace-gate__disc" aria-hidden="true"><Icon name={info.icon} size={20} /></span>
				<p class="w-kicker workspace-gate__kicker">Optional add-on · {$_('maturity.preview')}</p>
				<h2 class="workspace-gate__title">{info.name} isn't in this build</h2>
				<p class="workspace-gate__text">This minimal build excludes the authoring engine. Use the separately built workspace edition to enable it. Your existing files are retained; no automatic download or remote code import takes place.</p>
			</div>
		</div>
	{:else if !enabled}
		<div class="workspace-gate">
			<div class="workspace-gate__card">
				<span class="workspace-gate__disc" aria-hidden="true"><Icon name={info.icon} size={20} /></span>
				<p class="w-kicker workspace-gate__kicker">Optional add-on · {$_('maturity.preview')}</p>
				<h2 class="workspace-gate__title">{info.name}</h2>
				<p class="workspace-gate__does">{info.does}</p>
				<p class="workspace-gate__text">This addon is off on this device. Enabling it does not share files or enable the other office addon. Its editor loads only while you open the workspace.</p>
				<button type="button" class="w-btn w-btn--primary workspace-gate__action" disabled={enabling} onclick={() => void enable()}>{enabling ? `Turning on ${info.name}…` : `Turn on ${info.name}`}</button>
			</div>
		</div>
	{:else if WorkspaceComponent && loadedTool === tool && loadedScope === scopeKey}
		{#key `${tool}:${scopeKey}`}<div class="workspace-host-body"><WorkspaceComponent /></div>{/key}
	{:else if opening}
		<div class="workspace-library workspace-library--loading">
			<div class="workspace-library__column">
				<header class="workspace-library__head"><h1 class="workspace-library__title">{info.name}</h1></header>
				<Skeleton variant="card" rows={4} label={`Opening ${info.name}…`} class="workspace-library__skeleton" />
			</div>
		</div>
	{/if}
</section>
