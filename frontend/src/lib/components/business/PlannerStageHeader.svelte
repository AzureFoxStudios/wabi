<!--
	My Planner's row A (design contract §7.23, §8.6): "My Planner", one locality tag, the save
	state, then the view segment (Calendar · Board · Journal · Projects) and the split "New task ▾".
	The ⋯ menu is a StageBar action (PlannerWorkspaceContent owns its rows).

	- On center stage this renders inside StageBar's row A (via setStageHeader `component`), so
	  the title, tag and status use StageBar's own classes and tiers (the tag collapses to its dot
	  below a 760px stage, with the words in its tooltip, in ⋯ and for assistive tech).
	- `part="inline"` renders the same row as the Planner's own masthead where no StageBar exists
	  (the personal workspace route).
	- Phone shell (§8.12; on the 52px bar itself the title and the locality tag's dot show, and ⋯
	  says the locality and the save state in words): `part="tabs"` is the one row under the bar for Calendar, Journal and
	  Projects (the segment and New, 44px targets); on the board the view menu
	  (`part="views"`) and New (`part="new"`) join the board's one tools row instead. Each phone
	  part keeps the save state as a status live region for assistive tech.
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
		part?: 'row' | 'inline' | 'tabs' | 'views' | 'new';
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
	// On the phone bar row A keeps the title and the tag's dot; the views and New sit in the row
	// below it (the strip, or on the board its tools row).
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

{#snippet viewMenu(extra: string)}
	<Menu items={viewItems} label="Planner views" class={`w-btn w-btn--quiet psh-viewmenu ${extra}`} triggerLabel={`View: ${activeLabel}`} heading="Planner views">
		<span>{activeLabel}</span><Icon name="chevDown" size={14} />
	</Menu>
{/snippet}

{#snippet newSplit(glyphOnly: boolean)}
	<span class="w-split psh-new">
		<button
			type="button"
			class="w-btn w-btn--primary planner-new-primary"
			data-planner-new={activeView}
			title={readOnly ? 'Read-only: nothing can be added here' : newHint}
			aria-label={glyphOnly ? newLabel : undefined}
			disabled={readOnly}
			onclick={onNew}
		>
			<Icon name="plus" size={16} />{#if !glyphOnly}<span class="psh-new-words">{newLabel}</span>{/if}
		</button>
		<Menu items={newItems} label="Create new" class="w-btn w-btn--primary w-split__menu" triggerLabel="Choose what to create" align="end" disabled={readOnly}>
			<Icon name="chevDown" size={16} />
		</Menu>
	</span>
{/snippet}

{#snippet tablistKeys()}
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
{/snippet}

{#snippet phoneStatus()}
	<!-- The phone bar shows no save state; it is still announced (and said in ⋯). -->
	{#if status}<span class="psh-sr" role="status">{status}</span>{/if}
{/snippet}

{#if part === 'tabs'}
	<div class="psh psh--tabs psh--phone">
		{@render tablistKeys()}
		{@render newSplit(true)}
		{@render phoneStatus()}
	</div>
{:else if part === 'views'}
	<div class="psh psh--phone">{@render viewMenu('psh-viewmenu--always')}</div>
{:else if part === 'new'}
	<div class="psh psh--phone">
		{@render newSplit(true)}
		{@render phoneStatus()}
	</div>
{:else}
	<div class="psh" class:psh--inline={inline}>
		{#if inline}
			<h1 class="psh-title">{title}</h1>
		{:else}
			<h2 class="stage-a__title"><span class="stage-a__name">{title}</span></h2>
		{/if}
		{#if inline}
			<span class="w-tag psh-chip" title={scopeTitle || undefined}>{scope}</span>
			{#if status}<span class="psh-status" role="status">{status}</span>{/if}
		{:else}
			<!-- On the phone bar (and any stage under 760px) this tag is its dot; the words stay in
			     its tooltip, in ⋯ and for assistive tech (§7.23). -->
			<span class="w-tag stage-a__chip stage-a__scope" title={scopeTitle || scope}>
				<span class="w-dot stage-a__scope-dot" aria-hidden="true"></span><span class="stage-a__scope-words">{scope}</span>
			</span>
			<!-- The phone parts below the bar carry the save state's live region instead. -->
			{#if status && !phone}<span class="stage-a__status" role="status">{status}</span>{/if}
		{/if}
		{#if !phone}
			<span class="psh-spacer" aria-hidden="true"></span>
			{@render tablistKeys()}
			{@render viewMenu('')}
			{@render newSplit(false)}
		{/if}
	</div>
{/if}

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

	/* ---------- phone parts (§8.12): one row, every target 44×44 ---------- */
	.psh--tabs {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.psh--tabs .psh-seg {
		flex: 1 1 auto;
		display: flex;
		min-width: 0;
	}
	.psh--tabs .psh-seg > button {
		flex: 1 1 0;
		min-width: 0;
		height: 44px;
		padding-inline: 4px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.psh--phone .planner-new-primary {
		width: 44px;
		height: 44px;
		padding: 0;
		justify-content: center;
	}
	.psh--phone .psh-new :global(.w-split__menu) {
		width: 44px;
		height: 44px;
	}
	.psh :global(.psh-viewmenu.psh-viewmenu--always) {
		display: inline-flex;
		gap: 6px;
		height: 44px;
		padding-inline: 12px 10px;
		color: var(--w-text);
	}
	.psh-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
