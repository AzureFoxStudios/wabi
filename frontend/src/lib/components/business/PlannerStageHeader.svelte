<!--
	My Planner's row A (design contract §7.23, §8.6): "My Planner", one locality tag, the save
	state, then the view segment (Calendar · Board · Journal · Projects) and the split "New task ▾".
	The ⋯ menu is a StageBar action (PlannerWorkspaceContent owns its rows).

	- On center stage this renders inside StageBar's row A (via setStageHeader `component`), so
	  the title, tag and status use StageBar's own classes and tiers (the tag collapses to its dot
	  below a 760px stage, with the words in its tooltip, in ⋯ and for assistive tech).
	- `part="inline"` renders the same row as the Planner's own masthead where no StageBar exists
	  (the personal workspace route). `part="tabs"` is the phone strip under the 52px bar: the
	  segment at full width and the New split; on the phone bar itself only the title shows.
	- Below a 1000px stage the segment becomes one "Board ▾" view menu, and below 560 the New
	  button keeps only its glyph (its name stays for assistive tech).
	- The segment is a tablist (roving tabindex, ←/→ Home/End select) controlling the Planner's
	  view panel (`panelId`).
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { isMobile } from '$lib/layoutStoreStates';
	import type { PlannerView } from '$lib/business/plannerBoard';

	interface Props {
		title: string;
		scope: string;
		scopeTitle?: string;
		status?: string | null;
		views: { value: PlannerView; label: string }[];
		activeView: PlannerView;
		panelId: string;
		onSelectView: (view: PlannerView) => void;
		newLabel: string;
		newHint: string;
		onNew: () => void;
		newItems: MenuEntry[];
		part?: 'row' | 'inline' | 'tabs';
		readOnly?: boolean;
	}

	let {
		title,
		scope,
		scopeTitle = '',
		status = null,
		views,
		activeView,
		panelId,
		onSelectView,
		newLabel,
		newHint,
		onNew,
		newItems,
		part = 'row',
		readOnly = false
	}: Props = $props();

	const inline = $derived(part === 'inline');
	const tabsOnly = $derived(part === 'tabs');
	// On the phone bar row A keeps only the title; the segment and New live in the strip below.
	const phone = $derived($isMobile && part === 'row');
	const activeLabel = $derived(views.find((view) => view.value === activeView)?.label ?? '');
	let tablist = $state<HTMLElement | null>(null);

	const viewItems = $derived<MenuEntry[]>(
		views.map((view) => ({
			id: `view-${view.value}`,
			label: view.label,
			role: 'menuitemradio',
			checked: view.value === activeView,
			onSelect: () => onSelectView(view.value)
		}))
	);

	function tabId(view: PlannerView): string {
		return `${panelId}-tab-${view}`;
	}

	function handleTabKeydown(event: KeyboardEvent, index: number) {
		const last = views.length - 1;
		const next =
			event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
			: event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
			: event.key === 'Home' ? 0
			: event.key === 'End' ? last
			: -1;
		if (next < 0) return;
		event.preventDefault();
		const view = views[next].value;
		onSelectView(view);
		queueMicrotask(() => tablist?.querySelector<HTMLElement>(`#${CSS.escape(tabId(view))}`)?.focus());
	}
</script>

<div class="psh" class:psh--inline={inline} class:psh--tabs={tabsOnly}>
	{#if !tabsOnly}
		{#if inline}
			<h1 class="psh-title">{title}</h1>
		{:else}
			<h2 class="stage-a__title"><span class="stage-a__name">{title}</span></h2>
		{/if}
	{/if}
	{#if !phone}
		{#if inline}
			<span class="w-tag psh-chip" title={scopeTitle || undefined}>{scope}</span>
			{#if status}<span class="psh-status" role="status">{status}</span>{/if}
		{:else if !tabsOnly}
			<span class="w-tag stage-a__chip stage-a__scope" title={scopeTitle || scope}>
				<span class="w-dot stage-a__scope-dot" aria-hidden="true"></span><span class="stage-a__scope-words">{scope}</span>
			</span>
			{#if status}<span class="stage-a__status" role="status">{status}</span>{/if}
		{/if}

		{#if !tabsOnly}<span class="psh-spacer" aria-hidden="true"></span>{/if}

		<div class="w-seg planner-tabs psh-seg" role="tablist" aria-label="Planner views" bind:this={tablist}>
			{#each views as view, index (view.value)}
				<button
					type="button"
					role="tab"
					id={tabId(view.value)}
					aria-selected={view.value === activeView}
					aria-controls={panelId}
					tabindex={view.value === activeView ? 0 : -1}
					onclick={() => onSelectView(view.value)}
					onkeydown={(event) => handleTabKeydown(event, index)}
				>{view.label}</button>
			{/each}
		</div>
		{#if !tabsOnly}
			<Menu items={viewItems} label="Planner views" class="w-btn w-btn--quiet psh-viewmenu" triggerLabel={`View: ${activeLabel}`} heading="Planner views">
				<span>{activeLabel}</span><Icon name="chevDown" size={14} />
			</Menu>
		{/if}

		<span class="w-split psh-new">
			<button
				type="button"
				class="w-btn w-btn--primary planner-new-primary"
				data-planner-new={activeView}
				title={readOnly ? 'Read-only: nothing can be added here' : newHint}
				aria-label={tabsOnly ? newLabel : undefined}
				disabled={readOnly}
				onclick={onNew}
			>
				<Icon name="plus" size={16} />{#if !tabsOnly}<span class="psh-new-words">{newLabel}</span>{/if}
			</button>
			<Menu items={newItems} label="Create new" class="w-btn w-btn--primary w-split__menu" triggerLabel="Choose what to create" align="end" disabled={readOnly}>
				<Icon name="chevDown" size={16} />
			</Menu>
		</span>
		{#if tabsOnly}
			<!-- The phone bar hides row A's tag and status; the truth is still said once, here. -->
			<p class="psh-meta">
				<span class="w-tag psh-chip" title={scopeTitle || undefined}>{scope}</span>
				{#if status}<span class="psh-status" role="status">{status}</span>{/if}
			</p>
		{/if}
	{/if}
</div>

<style>
	/* The row's parts are flex items of StageBar's lead (or of the inline masthead). */
	.psh {
		display: contents;
	}
	.psh-spacer {
		flex: 1 1 0;
		min-width: 0;
	}
	.psh-seg,
	.psh-new {
		flex: none;
	}
	/* The quiet view menu replaces the segment on a narrow stage. */
	.psh :global(.psh-viewmenu) {
		display: none;
		flex: none;
	}
	.psh-new-words {
		white-space: nowrap;
	}

	@container stage (max-width: 999.98px) {
		.psh:not(.psh--tabs) .psh-seg {
			display: none;
		}
		.psh :global(.psh-viewmenu) {
			display: inline-flex;
			gap: 6px;
			padding-inline: 10px 8px;
			color: var(--w-text);
		}
	}
	@container stage (max-width: 559.98px) {
		.psh-new .planner-new-primary {
			width: 32px;
			padding: 0;
			justify-content: center;
		}
		.psh-new-words {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}

	/* ---------- inline masthead (no StageBar: the personal workspace route) ---------- */
	.psh--inline {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.psh-title {
		flex: 0 1 auto;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-title);
		letter-spacing: 0.005em;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.psh-chip {
		flex: none;
	}
	.psh-status {
		flex: none;
		color: var(--w-faint);
		font: var(--w-t-micro);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* ---------- phone strip: the segment at full width, New as its glyph ---------- */
	.psh--tabs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.psh-meta {
		flex: 1 0 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		margin: 0;
	}
	.psh--tabs .psh-seg {
		flex: 1 1 auto;
		display: flex;
		min-width: 0;
	}
	.psh--tabs .psh-seg > button {
		flex: 1 1 0;
		min-width: 0;
		height: 36px;
		padding-inline: 4px;
	}
	.psh--tabs .planner-new-primary {
		width: 40px;
		padding: 0;
		justify-content: center;
	}
	.psh--tabs .psh-new :global(.w-split__menu) {
		width: 32px;
	}
	.psh--tabs :is(.planner-new-primary, .psh-new :global(.w-split__menu)) {
		height: 40px;
	}
</style>
