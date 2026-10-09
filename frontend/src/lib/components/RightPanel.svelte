<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { activeRightTab } from '$lib/layoutStoreStates';
	import { dockOrder } from '$lib/layoutStoreRightPanel';
	import { currentUser } from '$lib/socket';
	import { canAccessWorkspacePanel, workspacePanelList, type WorkspacePanelManifest } from '$lib/workspacePanels';
	import WorkspacePanelHost from './WorkspacePanelHost.svelte';
	import QuickResourcesPanel from './QuickResourcesPanel.svelte';
	import './RightPanel.css';

	const dispatch = createEventDispatcher<{ openSettings: { paymentSurface?: 'connections' } | undefined; }>();

	let rightPanelHeight = $state(0);

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

	// Panels pinned side by side. Top to bottom follows the rail, so dragging on the rail rearranges the dock.
	// While another panel is being peeked (hover over the rail), that panel is shown on its own.
	const stackIds = $derived.by(() => {
		if ($layoutStore.rightPanelMode !== 'pinned') return [] as string[];
		const pinned = $layoutStore.dockStack.length > 0 ? $layoutStore.dockStack : $layoutStore.pinnedPanelId ? [$layoutStore.pinnedPanelId] : [];
		const present = pinned.filter((id) => panelById.has(id));
		return dockOrder(present, $layoutStore.stubStrip);
	});
	const showStack = $derived(stackIds.length > 1 && stackIds.includes($layoutStore.activeRightTab));
	const stackPanels = $derived(stackIds.map((id) => panelById.get(id)).filter((panel): panel is WorkspacePanelManifest => Boolean(panel)));
	function move(id: string, delta: number) {
		const strip = $layoutStore.stubStrip;
		const from = strip.indexOf(id);
		if (from === -1) return;
		// swap with the neighbouring pinned panel, so one click always moves it one place in the dock
		const order = stackIds;
		const neighbour = order[order.indexOf(id) + delta];
		if (!neighbour) return;
		layoutStore.reorderStub(from, strip.indexOf(neighbour));
	}

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

<div
	class="right-panel"
	class:is-peek={$layoutStore.rightPanelMode === 'peek'}
	class:is-pinned={$layoutStore.rightPanelMode === 'pinned'}
	class:mobile-workspace={$layoutStore.isMobile}
	bind:clientHeight={rightPanelHeight}
>
	{#if showStack}
		<div class="dock-stack">
			{#each stackPanels as panel, index (panel.id)}
				<section class="dock-section" aria-label={panel.label}>
					<header class="dock-section-head">
						<span class="dock-section-title">{panel.label}</span>
						<span class="dock-section-actions">
							<button type="button" class="dock-btn" aria-label={`Move ${panel.label} up`} disabled={index === 0} onclick={() => move(panel.id, -1)}>↑</button>
							<button type="button" class="dock-btn" aria-label={`Move ${panel.label} down`} disabled={index === stackPanels.length - 1} onclick={() => move(panel.id, 1)}>↓</button>
							<button type="button" class="dock-btn" aria-label={`Unpin ${panel.label}`} onclick={() => layoutStore.unpinOne(panel.id)}>×</button>
						</span>
					</header>
					<div class="dock-section-body">
						<WorkspacePanelHost {panel} on:openSettings={(event) => dispatch('openSettings', event.detail)} />
					</div>
				</section>
			{/each}
		</div>
	{:else if displayedPanel}
		<div class="panel-stack-content">
			<WorkspacePanelHost panel={displayedPanel} on:openSettings={(event) => dispatch('openSettings', event.detail)} />
		</div>
	{:else}
		<div class="dock-empty">No workspace panels are available.</div>
	{/if}

	<QuickResourcesPanel parentHeight={rightPanelHeight} />
</div>

<script lang="ts" context="module">
	const RECENT_PANEL_IDS = ['users', 'dms', 'notes', 'map'];
</script>
