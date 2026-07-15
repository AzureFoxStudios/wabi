<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { currentUser } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import type { WorkspacePanelStackV1 } from '$lib/docking/layoutSchema';
	import { canAccessWorkspacePanel, registerPluginWorkspacePanels, workspacePanelList, type WorkspacePanelManifest } from '$lib/workspacePanels';
	import { fetchPluginInventory } from '$lib/addonInventory';
	import { openDetachedPanel, listenForDetachedWindowClose } from '$lib/detachedPanels';
	import WorkspacePanelHost from './WorkspacePanelHost.svelte';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import QuickResourcesPanel from './QuickResourcesPanel.svelte';
	import { windowsEnabled } from '$lib/motion/animationQuality';
	import './RightPanel.css';

	interface RenderStack extends WorkspacePanelStackV1 { panels: WorkspacePanelManifest[]; activePanel: WorkspacePanelManifest; overflowPanels: WorkspacePanelManifest[]; visiblePanels: WorkspacePanelManifest[]; }
	const dispatch = createEventDispatcher<{ openSettings: { paymentSurface: 'connections' }; }>();

	let rightPanelHeight = 0;
	let dockElement: HTMLElement | null = null;
	let draggedPanelId = '';
	let isResizingSplit = false;
	let recentPanelIds: string[] = ['users', 'dms', 'notes', 'map'];
	let contextMenuVisible = false;
	let contextMenuPosition = { x: 0, y: 0 };
	let contextMenuPanelId = '';
	let contextMenuRef: HTMLElement | null = null;
	let panelDrawerStackId: string | null = null;
	let panelSearchQuery = '';

	$: activeTab = $layoutStore.activeRightTab;
	$: availablePanels = $workspacePanelList.filter((panel) => canAccessWorkspacePanel(panel, $currentUser));
	$: panelById = new Map(availablePanels.map((panel) => [panel.id, panel] as const));
	$: renderStacks = buildRenderStacks($layoutStore.rightPanelDock.stacks ?? [], panelById);
	$: dockedPanelIds = new Set(renderStacks.flatMap((stack) => stack.panels.map((panel) => panel.id)));
	$: dpIds = $layoutStore.detachedPanelIds;
	$: undockedPanels = availablePanels.filter((panel) => !dockedPanelIds.has(panel.id) && (dpIds?.has ? !dpIds.has(panel.id) : true));
	$: activePanel = panelById.get(activeTab) || renderStacks[0]?.activePanel || availablePanels[0] || null;
	$: visibleStacks = $layoutStore.isMobile ? buildMobileRenderStack(availablePanels, activePanel) : renderStacks;
	$: splitOrientation = $layoutStore.rightPanelDock.orientation === 'horizontal' ? 'horizontal' : 'vertical';
	$: stacksWithDetachedFiltered = visibleStacks.map((stack) => ({ ...stack, visiblePanels: stack.visiblePanels.filter((panel) => dpIds?.has ? !dpIds.has(panel.id) : true) }));
	$: if (availablePanels.length > 0 && !panelById.has(activeTab)) layoutStore.openRightPanel(availablePanels[0].id);
	$: if (activePanel && recentPanelIds[0] !== activePanel.id) recentPanelIds = [activePanel.id, ...recentPanelIds.filter((id) => id !== activePanel.id)].slice(0, 5);
	$: recentPanels = recentPanelIds.map((id) => panelById.get(id)).filter((panel): panel is WorkspacePanelManifest => Boolean(panel));

	onMount(() => {
		let cancelled = false;
		void fetchPluginInventory().then((plugins) => { if (cancelled || !plugins) return; registerPluginWorkspacePanels(plugins); });
		const unlisten = listenForDetachedWindowClose((panelId) => layoutStore.dockPanel(panelId as any));
		function handleClickOutside(event: MouseEvent) { if (contextMenuVisible && contextMenuRef && !contextMenuRef.contains(event.target as Node)) hideContextMenu(); if (panelDrawerStackId) closePanelDrawer(); }
		function handleKeydown(event: KeyboardEvent) { if (event.key === 'Escape') { hideContextMenu(); closePanelDrawer(); } }
		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleKeydown);
		return () => { cancelled = true; unlisten(); document.removeEventListener('click', handleClickOutside); document.removeEventListener('keydown', handleKeydown); };
	});
	onDestroy(() => { stopSplitResize(); });

	function buildRenderStacks(stacks: WorkspacePanelStackV1[], registry: Map<string, WorkspacePanelManifest>): RenderStack[] {
		return stacks.map((stack) => {
			const panels = stack.tabs.map((panelId) => registry.get(panelId)).filter((panel): panel is WorkspacePanelManifest => Boolean(panel));
			if (panels.length === 0) return null;
			const activePanel = panels.find((panel) => panel.id === stack.activePanelId) || panels[0];
			const threshold = Math.max(3, Math.min($layoutStore.rightPanelDock.overflowThreshold || 5, 8));
			const visiblePanels = panels.slice(0, threshold);
			const overflowPanels = panels.slice(threshold);
			return { ...stack, panels, activePanel, visiblePanels, overflowPanels };
		}).filter((stack): stack is RenderStack => Boolean(stack));
	}
	function buildMobileRenderStack(panels: WorkspacePanelManifest[], currentPanel: WorkspacePanelManifest | null): RenderStack[] {
		if (panels.length === 0) return [];
		const active = currentPanel && panels.some((panel) => panel.id === currentPanel.id) ? currentPanel : panels[0];
		const threshold = Math.max(4, Math.min($layoutStore.rightPanelDock.overflowThreshold || 5, 8));
		return [{ id: 'mobile-stack', tabs: panels.map((panel) => panel.id), activePanelId: active.id, size: 100, minSize: 100, maxSize: 100, collapsed: false, pinned: true, panels, activePanel: active, visiblePanels: panels.slice(0, threshold), overflowPanels: panels.slice(threshold) }];
	}
	function showPanelContextMenu(event: MouseEvent, panelId: string): void { event.preventDefault(); contextMenuPanelId = panelId; contextMenuPosition = { x: event.clientX, y: event.clientY }; contextMenuVisible = true; }
	function hideContextMenu(): void { contextMenuVisible = false; contextMenuPanelId = ''; }
	function closePanelDrawer(): void { panelDrawerStackId = null; panelSearchQuery = ''; }
	function togglePanelDrawer(stackId: string): void { panelDrawerStackId = panelDrawerStackId === stackId ? null : stackId; panelSearchQuery = ''; }
	function cycleActivePanel(stack: RenderStack): void {
		const currentIndex = stack.panels.findIndex((candidate) => candidate.id === stack.activePanel.id);
		const nextIndex = (currentIndex + 1) % stack.panels.length;
		layoutStore.setActiveRightPanel(stack.panels[nextIndex].id);
	}
	async function handleDetachPanel(): Promise<void> { if (!contextMenuPanelId || !$windowsEnabled) return; layoutStore.detachPanel(contextMenuPanelId as any); await openDetachedPanel({ kind: 'workspace-panel', panelId: contextMenuPanelId }); hideContextMenu(); }
	function splitPanel(panelId: string): void { closePanelDrawer(); layoutStore.splitRightPanelTab(panelId); }
	function addPanelToStack(panelId: string, stackId: string): void { if (!panelId) return; layoutStore.moveRightPanelTab(panelId, stackId); layoutStore.setActiveRightPanel(panelId); }
	function loadWorkspace(name: string): void { layoutStore.loadWorkspace(name); }
	function formatWorkspaceName(name: string): string { if (name === 'media-review') return 'Media Review'; return name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
	function handleTabKeydown(event: KeyboardEvent, stack: RenderStack, panel: WorkspacePanelManifest): void {
		const currentIndex = stack.panels.findIndex((candidate) => candidate.id === panel.id);
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); layoutStore.setActiveRightPanel(stack.panels[(currentIndex + 1) % stack.panels.length].id); }
		if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); layoutStore.setActiveRightPanel(stack.panels[(currentIndex - 1 + stack.panels.length) % stack.panels.length].id); }
		if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); layoutStore.setActiveRightPanel(panel.id); }
		if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); splitPanel(panel.id); }
	}
	function handleDragStart(event: DragEvent, stackId: string, panelId: string): void { draggedPanelId = panelId; event.dataTransfer?.setData('text/plain', JSON.stringify({ panelId, stackId })); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }
	function handleDragOver(event: DragEvent): void { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
	function handleDrop(event: DragEvent, stackId: string, index = -1): void {
		event.preventDefault();
		let panelId = draggedPanelId;
		try { const payload = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}') as { panelId?: string }; panelId = payload.panelId || panelId; } catch {}
		if (!panelId) return;
		layoutStore.moveRightPanelTab(panelId, stackId, index);
		draggedPanelId = '';
	}
	function startSplitResize(event: MouseEvent): void { event.preventDefault(); if (renderStacks.length < 2) return; isResizingSplit = true; window.addEventListener('mousemove', handleSplitResizeMove); window.addEventListener('mouseup', stopSplitResize); }
	function handleSplitResizeMove(event: MouseEvent): void {
		if (!isResizingSplit || !dockElement) return;
		const rect = dockElement.getBoundingClientRect();
		const isHorizontalSplit = stacksWithDetachedFiltered.length > 1 && splitOrientation === 'horizontal';
		let nextSize: number;
		if (isHorizontalSplit) nextSize = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100; else nextSize = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
		layoutStore.resizeRightPanelStacks(nextSize);
	}
	function stopSplitResize(): void { isResizingSplit = false; window.removeEventListener('mousemove', handleSplitResizeMove); window.removeEventListener('mouseup', stopSplitResize); }
</script>

<div class="right-panel" class:mobile-workspace={$layoutStore.isMobile} bind:clientHeight={rightPanelHeight}>
	<div class="workspace-dock" class:split-mode={stacksWithDetachedFiltered.length > 1} class:horizontal-split={stacksWithDetachedFiltered.length > 1 && splitOrientation === 'horizontal'} class:vertical-split={stacksWithDetachedFiltered.length > 1 && splitOrientation === 'vertical'} class:resizing={isResizingSplit} bind:this={dockElement}>
		{#if stacksWithDetachedFiltered.length === 0}<div class="dock-empty">No workspace panels are available.</div>{:else}
			{#each stacksWithDetachedFiltered as stack, stackIndex (stack.id)}
				<section class="panel-stack" class:is-collapsed={stack.collapsed} role="group" aria-label={`${stack.activePanel.label} stack`} style:flex-basis={visibleStacks.length > 1 ? `${stack.collapsed ? 42 : stack.size}%` : '100%'} on:dragover={handleDragOver} on:drop={(event) => handleDrop(event, stack.id)}>
					<div class="stack-header">
						<div class="stack-tabs" role="tablist" aria-label={`${stack.id} workspace panels`}>
							<button type="button" class="panel-tab active panel-tab-drawer-trigger" role="tab" aria-selected="true" aria-haspopup="listbox" aria-expanded={panelDrawerStackId === stack.id} title="Choose right panel mode" on:click|stopPropagation={() => togglePanelDrawer(stack.id)} on:dblclick|stopPropagation={() => cycleActivePanel(stack)} on:contextmenu|preventDefault={() => togglePanelDrawer(stack.id)}>
								<span class="panel-tab-icon"><WorkspacePanelIcon icon={stack.activePanel.icon} /></span>
								<span class="panel-tab-label">{stack.activePanel.shortLabel || stack.activePanel.label}</span>
								<svg class="panel-tab-chevron" class:open={panelDrawerStackId === stack.id} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>
							</button>
							{#if stack.overflowPanels.length > 0}
								<button type="button" class="panel-tab-more" aria-label="More panels" title="More panels" on:click|stopPropagation={() => togglePanelDrawer(stack.id)}>More</button>
							{/if}
							{#if panelDrawerStackId === stack.id}
								<div class="panel-drawer" role="listbox" aria-label="Available panels" tabindex="-1" on:click|stopPropagation on:keydown={(event) => event.stopPropagation()}>
									{#if stack.panels.length > 10}<div class="panel-drawer-search"><input type="text" placeholder="Filter panels..." bind:value={panelSearchQuery} on:keydown={(e) => e.stopPropagation()} /></div>{/if}
									<div class="panel-drawer-list" class:scrollable={stack.panels.length > 10}>
										{#each stack.panels.filter(p => !panelSearchQuery || p.label.toLowerCase().includes(panelSearchQuery.toLowerCase())) as panel (panel.id)}
											<button type="button" class="panel-drawer-item" class:active={stack.activePanel.id === panel.id} role="option" aria-selected={stack.activePanel.id === panel.id} on:click={() => { layoutStore.setActiveRightPanel(panel.id); closePanelDrawer(); }}>
												<span class="panel-tab-icon"><WorkspacePanelIcon icon={panel.icon} /></span>
												<span class="panel-tab-label">{panel.shortLabel || panel.label}</span>
												{#if panel.badge}<span class="panel-badge">{panel.badge}</span>{/if}
											</button>
										{/each}
									</div>
								</div>
							{/if}
						</div>
						<div class="stack-actions">
							<button type="button" title={splitOrientation === 'horizontal' ? 'Split active panel side by side' : 'Split active panel above and below'} aria-label="Split active panel" on:click={() => splitPanel(stack.activePanel.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{#if splitOrientation === 'horizontal'}<rect x="3" y="3" width="7" height="18" rx="1"></rect><rect x="14" y="3" width="7" height="18" rx="1"></rect>{:else}<rect x="3" y="3" width="18" height="7" rx="1"></rect><rect x="3" y="14" width="18" height="7" rx="1"></rect>{/if}</svg></button>
							{#if stacksWithDetachedFiltered.length > 1}<button type="button" title="Merge this split back into one panel stack" aria-label="Merge panel split" on:click={() => layoutStore.mergeRightPanelStack(stack.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7h8"></path><path d="M8 17h8"></path><path d="M12 3v18"></path><path d="m8 11 4-4 4 4"></path><path d="m8 13 4 4 4-4"></path></svg></button>{:else}
								<button type="button" class:active={!stack.collapsed} title={stack.collapsed ? 'Expand stack' : 'Collapse stack'} aria-label={stack.collapsed ? 'Expand stack' : 'Collapse stack'} on:click={() => layoutStore.toggleRightPanelStackCollapsed(stack.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{#if stack.collapsed}<path d="M18 15l-6-6-6 6"></path>{:else}<path d="M6 9l6 6 6-6"></path>{/if}</svg></button>
							{/if}
							<button type="button" class:active={stack.pinned} title={stack.pinned ? 'Pinned stack — tabs stay in place when adding or removing panels' : 'Unpinned stack — tabs may shift when layout changes'} aria-label={stack.pinned ? 'Pinned stack' : 'Unpinned stack'} on:click={() => layoutStore.toggleRightPanelStackPinned(stack.id)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></button>
						</div>
					</div>
					{#if stack.collapsed}<button class="collapsed-stack-button" type="button" on:click={() => layoutStore.toggleRightPanelStackCollapsed(stack.id)}><span class="panel-tab-icon"><WorkspacePanelIcon icon={stack.activePanel.icon} /></span><span>{stack.activePanel.label}</span></button>{:else}
						<div class="panel-stack-content"><WorkspacePanelHost panel={stack.activePanel} on:openSettings={(event) => dispatch('openSettings', event.detail)} /></div>
					{/if}
				</section>
				{#if stackIndex === 0 && visibleStacks.length > 1}<button type="button" class="stack-resize-handle" aria-label="Resize panel split" title="Resize panel split" on:mousedown={startSplitResize}></button>{/if}
			{/each}
		{/if}
	</div>

	{#if contextMenuVisible && $windowsEnabled}
		<div class="panel-context-menu" style={`left: ${contextMenuPosition.x}px; top: ${contextMenuPosition.y}px;`} bind:this={contextMenuRef} role="menu" aria-label="Panel options">
			<button type="button" class="context-menu-item" role="menuitem" on:click={handleDetachPanel}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>Open in new window</button>
		</div>
	{/if}

	<QuickResourcesPanel parentHeight={rightPanelHeight} />
</div>
