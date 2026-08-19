<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { activeRightTab } from '$lib/layoutStoreStates';
	import { currentUser } from '$lib/socket';
	import { canAccessWorkspacePanel, workspacePanelList, type WorkspacePanelManifest } from '$lib/workspacePanels';
	import WorkspacePanelHost from './WorkspacePanelHost.svelte';
	import QuickResourcesPanel from './QuickResourcesPanel.svelte';
	import './RightPanel.css';

	const dispatch = createEventDispatcher<{ openSettings: { paymentSurface: 'connections' }; }>();

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
	{#if displayedPanel}
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