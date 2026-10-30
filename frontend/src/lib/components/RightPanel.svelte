<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { get } from 'svelte/store';
	import { layoutStore } from '$lib/layoutStore';
	import { activeRightTab, selectedDmChannelId } from '$lib/layoutStoreStates';
	import { dockCanPin, dockOrder, endPeek, peekHeld } from '$lib/layoutStoreRightPanel';
	import { channels, channelUnreadCounts, currentUser } from '$lib/socket';
	import { openNotesSurface } from '$lib/notesWorkspace';
	import {
		canAccessWorkspacePanel,
		panelChannelChoice,
		panelFrameCounts,
		workspacePanelList,
		type WorkspacePanelManifest
	} from '$lib/workspacePanels';
	import WorkspacePanelHost from './WorkspacePanelHost.svelte';
	import QuickResourcesPanel from './QuickResourcesPanel.svelte';
	import Icon from './ui/Icon.svelte';
	import Tooltip from './ui/Tooltip.svelte';
	import './RightPanel.css';

	const dispatch = createEventDispatcher<{ openSettings: { paymentSurface?: 'connections' } | undefined; }>();
	const uid = $props.id();

	let rightPanelHeight = $state(0);
	/** Stacked sections folded to their header, for this session only (layout state stays in the store). */
	let collapsed = $state<string[]>([]);

	const availablePanels = $derived(
		$workspacePanelList.filter((panel) => canAccessWorkspacePanel(panel, $currentUser))
	);
	const panelById = $derived(
		new Map(availablePanels.map((panel) => [panel.id, panel] as const))
	);
	// N4: heal invalid tab without thrashing to panels[0] via openRightPanel —
	// fall back through recents, then the first accessible panel.
	const displayedPanel = $derived.by(() => {
		const current = panelById.get($layoutStore.activeRightTab);
		if (current) return current;
		const fallback = RECENT_PANEL_IDS.find((id) => panelById.has(id)) || availablePanels[0]?.id;
		return fallback ? (panelById.get(fallback) ?? null) : null;
	});

	// Everything pinned, top to bottom in the rail's order (dragging on the rail rearranges the dock).
	const stackIds = $derived.by(() => {
		if ($layoutStore.rightPanelMode !== 'pinned') return [] as string[];
		const pinned = $layoutStore.dockStack.length > 0 ? $layoutStore.dockStack : $layoutStore.pinnedPanelId ? [$layoutStore.pinnedPanelId] : [];
		const present = pinned.filter((id) => panelById.has(id));
		return dockOrder(present, $layoutStore.stubStrip);
	});
	const stackPanels = $derived(stackIds.map((id) => panelById.get(id)).filter((panel): panel is WorkspacePanelManifest => Boolean(panel)));

	/** A peek is on screen: a plain peek, or a held peek over a stowed pin (the mode stays 'pinned'). */
	const peeking = $derived($layoutStore.rightPanelMode === 'peek' || ($layoutStore.rightPanelMode === 'pinned' && $peekHeld));
	// A panel shown that is not one of the pins (a peek of another panel over a stowed pin). The pins
	// stay mounted, hidden, so their own state (search text, a picked channel, scroll) survives.
	const otherPanel = $derived(displayedPanel && !stackIds.includes(displayedPanel.id) ? displayedPanel : null);

	type View = { key: string; stacked: boolean; panel: WorkspacePanelManifest | null; hidden: boolean };
	// Keyed by panel, so a peek that gets pinned keeps its mounted panel (and what was typed in it).
	const views = $derived.by(() => {
		const list: View[] = [];
		const pinsHidden = otherPanel !== null;
		if (stackPanels.length > 1) list.push({ key: ' stack', stacked: true, panel: null, hidden: pinsHidden });
		else if (stackPanels.length === 1) list.push({ key: stackPanels[0].id, stacked: false, panel: stackPanels[0], hidden: pinsHidden });
		if (otherPanel) list.push({ key: otherPanel.id, stacked: false, panel: otherPanel, hidden: false });
		return list;
	});

	const dmUnread = $derived(
		$channels
			.filter((ch) => ch.type === 'dm' || ch.type === 'group')
			.reduce((sum, ch) => sum + (Number($channelUnreadCounts[ch.id]) || 0), 0)
	);

	/** The count beside a title: what the panel published (People), or the DMs' unread total. */
	function countFor(panel: WorkspacePanelManifest): string | null {
		const published = $panelFrameCounts[panel.id];
		if (published !== undefined) return String(published);
		if (panel.id === 'dms' && dmUnread > 0) return `${dmUnread > 99 ? '99+' : dmUnread} unread`;
		return null;
	}

	/** The panel on screen as a peek (its × ends the peek) rather than pinned in flow (× unpins it). */
	function shownAsPeek(panel: WorkspacePanelManifest): boolean {
		return peeking && (otherPanel?.id === panel.id || $layoutStore.rightPanelMode === 'peek' || !$dockCanPin);
	}

	function closeLabel(panel: WorkspacePanelManifest): string {
		return shownAsPeek(panel) ? `Close ${panel.label}` : `Unpin ${panel.label}`;
	}

	// Unpin is explicit and takes only this panel; a peek's × only puts the peek away (§8.4).
	function closePanel(panel: WorkspacePanelManifest): void {
		if (shownAsPeek(panel)) endPeek();
		else layoutStore.unpinOne(panel.id);
	}

	function pinFromPeek(panel: WorkspacePanelManifest): void {
		if (!get(dockCanPin)) return;
		layoutStore.pinPanel(panel.id);
	}

	function stageChannelFor(panel: WorkspacePanelManifest): string | null {
		if (panel.component === 'wiki') return $panelChannelChoice.wiki;
		if (panel.component === 'forum') return $panelChannelChoice.forum;
		return null;
	}

	function canOpenInStage(panel: WorkspacePanelManifest): boolean {
		if (!panel.opensInStage) return false;
		if (panel.component === 'wiki' || panel.component === 'forum') return Boolean(stageChannelFor(panel));
		return true;
	}

	// The companion moves to the page: center stage opens the same thing and this panel leaves.
	function openInStage(panel: WorkspacePanelManifest): void {
		const wasPeek = shownAsPeek(panel);
		if (panel.component === 'notes') {
			openNotesSurface();
		} else if (panel.component === 'dms') {
			const channelId = get(selectedDmChannelId);
			window.dispatchEvent(new CustomEvent('wabi:navigate', { detail: channelId ? { view: 'dm', channelId } : { view: 'dm' } }));
		} else {
			const channelId = stageChannelFor(panel);
			if (!channelId) return;
			window.dispatchEvent(new CustomEvent('wabi:navigate', { detail: { view: 'chat', channelId, preserveRightPanel: true } }));
		}
		if (wasPeek) endPeek();
		else layoutStore.unpinOne(panel.id);
	}

	function toggleSection(id: string): void {
		collapsed = collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id];
	}

	const titleId = (panel: WorkspacePanelManifest) => `${uid}-title-${panel.id}`;

	$effect(() => {
		if (availablePanels.length === 0) return;
		const tab = $layoutStore.activeRightTab;
		if (panelById.has(tab)) return;
		const fallback = RECENT_PANEL_IDS.find((id) => panelById.has(id)) || availablePanels[0].id;
		if ($layoutStore.rightPanelMode === 'pinned' && $layoutStore.pinnedPanelId === tab) {
			layoutStore.pinPanel(fallback);
		} else {
			activeRightTab.set(fallback);
		}
	});
</script>

{#snippet iconAction(label: string, icon: 'x' | 'pin' | 'expand', onclick: () => void)}
	<Tooltip text={label} placement="bottom">
		<button type="button" class="w-ibtn w-ibtn--sm" aria-label={label} {onclick}>
			<Icon name={icon} />
		</button>
	</Tooltip>
{/snippet}

<!-- The companion frame (§7.21): row A (56) names the panel and holds its actions; row B (40) is the
     panel's own search and filter, or its one-line description; the body follows; the Scratchpad
     tray is the footer band. Same masthead rule (y = 96) as the sidebar and the stage. -->
{#snippet frame(panel: WorkspacePanelManifest)}
	{@const count = countFor(panel)}
	<header class="w-panel__a">
		<h2 class="w-panel__title" id={titleId(panel)}>
			<span class="w-panel__name">{panel.label}</span>
			{#if count}<span class="w-panel__count">{count}</span>{/if}
		</h2>
		{#if panel.locality}<span class="w-tag w-panel__tag">{panel.locality}</span>{/if}
		<div class="w-panel__acts">
			{#if canOpenInStage(panel)}
				{@render iconAction('Open in center stage', 'expand', () => openInStage(panel))}
			{/if}
			{#if shownAsPeek(panel) && $dockCanPin && !stackIds.includes(panel.id)}
				{@render iconAction('Pin beside the page', 'pin', () => pinFromPeek(panel))}
			{/if}
			{@render iconAction(closeLabel(panel), 'x', () => closePanel(panel))}
		</div>
	</header>
	{#if !panel.ownsToolbar}
		<div class="w-panel__b">
			<p class="w-panel__desc">{panel.description ?? ''}</p>
		</div>
	{/if}
	<div class="panel-stack-content">
		<WorkspacePanelHost {panel} on:openSettings={(event) => dispatch('openSettings', event.detail)} />
	</div>
{/snippet}

<div
	class="right-panel w-panel"
	class:is-peek={$layoutStore.rightPanelMode === 'peek'}
	class:is-pinned={$layoutStore.rightPanelMode === 'pinned'}
	class:mobile-workspace={$layoutStore.isMobile}
	bind:clientHeight={rightPanelHeight}
>
	{#each views as view (view.key)}
		{#if view.stacked}
			<div class="dock-stack w-panel__view" hidden={view.hidden}>
				{#each stackPanels as panel, index (panel.id)}
					{@const folded = collapsed.includes(panel.id)}
					{@const count = countFor(panel)}
					<section class="dock-section" class:collapsed={folded} aria-labelledby={titleId(panel)}>
						<header class="w-panel__sec">
							<h3 class="w-panel__sec-title" id={titleId(panel)}>
								<button
									type="button"
									class="w-panel__sec-toggle"
									aria-expanded={!folded}
									aria-controls={`${uid}-body-${panel.id}`}
									onclick={() => toggleSection(panel.id)}
								>
									<span class="w-panel__name">{panel.label}</span>
									{#if count}<span class="w-panel__count">{count}</span>{/if}
									<Icon name={folded ? 'chevRight' : 'chevDown'} size={14} class="w-panel__chev" />
								</button>
							</h3>
							{@render iconAction(`Unpin ${panel.label}`, 'x', () => layoutStore.unpinOne(panel.id))}
						</header>
						<div class="dock-section-body" id={`${uid}-body-${panel.id}`} hidden={folded}>
							{#if index === 0 && !panel.ownsToolbar}
								<!-- The top section keeps the masthead rule at y = 96, like a single panel. -->
								<div class="w-panel__b"><p class="w-panel__desc">{panel.description ?? ''}</p></div>
							{/if}
							<WorkspacePanelHost {panel} on:openSettings={(event) => dispatch('openSettings', event.detail)} />
						</div>
					</section>
				{/each}
			</div>
		{:else if view.panel}
			<section class="w-panel__view" aria-labelledby={titleId(view.panel)} hidden={view.hidden}>
				{@render frame(view.panel)}
			</section>
		{/if}
	{:else}
		<div class="dock-empty">
			<p class="dock-empty-title">No panels available</p>
			<p class="dock-empty-text">Panels you can open appear on the rail; none are available to your account here.</p>
		</div>
	{/each}

	<QuickResourcesPanel parentHeight={rightPanelHeight} />
</div>

<script lang="ts" module>
	const RECENT_PANEL_IDS = ['users', 'dms', 'notes', 'map'];
</script>
