<script lang="ts">
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { channels, channelMessages, currentUser, sendMessage, users } from '$lib/socket';
	import type { Channel, Message, User } from '$lib/socket-types';
	import { layoutStore } from '$lib/layoutStore';
	import type { WorkspacePanelStackV1 } from '$lib/docking/layoutSchema';
	import {
		canAccessWorkspacePanel,
		registerPluginWorkspacePanels,
		workspacePanelList,
		type WorkspacePanelManifest
	} from '$lib/workspacePanels';
	import { fetchPluginInventory } from '$lib/addonInventory';
	import { openDetachedPanel, listenForDetachedWindowClose } from '$lib/detachedPanels';
	import WorkspacePanelHost from './WorkspacePanelHost.svelte';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import { windowsEnabled } from '$lib/motion/animationQuality';

	type QuickMode = 'notes' | 'dm';

	interface RenderStack extends WorkspacePanelStackV1 {
		panels: WorkspacePanelManifest[];
		activePanel: WorkspacePanelManifest;
		overflowPanels: WorkspacePanelManifest[];
		visiblePanels: WorkspacePanelManifest[];
	}

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

	const QUICK_MIN_HEIGHT = 150;
	const QUICK_DEFAULT_HEIGHT = 240;
	const QUICK_MAX_RATIO = 0.56;
	const QUICK_COLLAPSED_BAR_HEIGHT = 44;
	const QUICK_COLLAPSE_THRESHOLD = 118;

	let quickMode: QuickMode = 'notes';
	let quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	let quickPanelCollapsed = false;
	let quickDmChannelId = '';
	let quickMessage = '';
	let isResizingQuick = false;
	let quickResizeStartY = 0;
	let quickResizeStartHeight = QUICK_DEFAULT_HEIGHT;
	let rightPanelElement: HTMLElement | null = null;
	let dockElement: HTMLElement | null = null;
	let quickMessagesElement: HTMLDivElement | null = null;
	let draggedPanelId = '';
	let isResizingSplit = false;
	let recentPanelIds: string[] = ['users', 'dms', 'media'];
	let contextMenuVisible = false;
	let contextMenuPosition = { x: 0, y: 0 };
	let contextMenuPanelId = '';
	let contextMenuRef: HTMLElement | null = null;

	// Blender-style panel drawer
	let panelDrawerOpen = false;
	let panelDrawerRef: HTMLElement | null = null;
	let panelSearchQuery = '';

	$: activeTab = $layoutStore.activeRightTab;
	$: availablePanels = $workspacePanelList.filter((panel) => canAccessWorkspacePanel(panel, $currentUser));
	$: panelById = new Map(availablePanels.map((panel) => [panel.id, panel] as const));
	$: renderStacks = buildRenderStacks($layoutStore.rightPanelDock.stacks, panelById);
	$: dockedPanelIds = new Set(renderStacks.flatMap((stack) => stack.panels.map((panel) => panel.id)));
	$: undockedPanels = availablePanels.filter((panel) => !dockedPanelIds.has(panel.id) && !$layoutStore.detachedPanelIds.has(panel.id));
	$: activePanel = panelById.get(activeTab) || renderStacks[0]?.activePanel || availablePanels[0] || null;
	$: visibleStacks = $layoutStore.isMobile ? buildMobileRenderStack(availablePanels, activePanel) : renderStacks;

	// Stacks with detached panels filtered out of visiblePanels
	$: stacksWithDetachedFiltered = visibleStacks.map((stack) => ({
		...stack,
		visiblePanels: stack.visiblePanels.filter((panel) => !$layoutStore.detachedPanelIds.has(panel.id))
	}));
	$: if (availablePanels.length > 0 && !panelById.has(activeTab)) {
		layoutStore.openRightPanel(availablePanels[0].id);
	}
	$: if (activePanel && recentPanelIds[0] !== activePanel.id) {
		recentPanelIds = [activePanel.id, ...recentPanelIds.filter((id) => id !== activePanel.id)].slice(0, 5);
	}
	$: recentPanels = recentPanelIds
		.map((id) => panelById.get(id))
		.filter((panel): panel is WorkspacePanelManifest => Boolean(panel));

	$: dmChannels = $channels.filter((ch) => ch.type === 'dm' || ch.type === 'group');
	$: if (!quickDmChannelId && dmChannels.length > 0) {
		quickDmChannelId = dmChannels[0].id;
	}
	$: if (quickDmChannelId && !dmChannels.some((ch) => ch.id === quickDmChannelId)) {
		quickDmChannelId = dmChannels[0]?.id || '';
	}
	$: quickDmChannel = dmChannels.find((ch) => ch.id === quickDmChannelId) || null;
	$: quickMessages = quickDmChannelId ? (($channelMessages[quickDmChannelId] || []) as Message[]) : [];
	$: quickRecentMessages = quickMessages.slice(-40);
	$: quickConversationTitle = quickDmChannel ? getDmLabel(quickDmChannel) : 'Quick DM';

	$: if (quickMessagesElement) {
		quickMessagesElement.scrollTop = quickMessagesElement.scrollHeight;
	}

	onMount(() => {
		let cancelled = false;
		void fetchPluginInventory().then((plugins) => {
			if (cancelled || !plugins) return;
			registerPluginWorkspacePanels(plugins);
		});

		// Listen for detached window close events to re-dock panels
		const unlisten = listenForDetachedWindowClose((panelId) => {
			layoutStore.dockPanel(panelId as any);
		});

		// Close context menu on outside click or Escape
		function handleClickOutside(event: MouseEvent) {
			if (contextMenuVisible && contextMenuRef && !contextMenuRef.contains(event.target as Node)) {
				hideContextMenu();
			}
			if (panelDrawerOpen && panelDrawerRef && !panelDrawerRef.contains(event.target as Node)) {
				panelDrawerOpen = false;
				panelSearchQuery = '';
			}
		}
		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				hideContextMenu();
				panelDrawerOpen = false;
				panelSearchQuery = '';
			}
		}
		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleKeydown);

		return () => {
			cancelled = true;
			unlisten();
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
		};
	});

	onDestroy(() => {
		stopSplitResize();
		handleQuickResizeStop();
	});

	function buildRenderStacks(
		stacks: WorkspacePanelStackV1[],
		registry: Map<string, WorkspacePanelManifest>
	): RenderStack[] {
		return stacks
			.map((stack) => {
				const panels = stack.tabs
					.map((panelId) => registry.get(panelId))
					.filter((panel): panel is WorkspacePanelManifest => Boolean(panel));
				if (panels.length === 0) return null;
				const activePanel = panels.find((panel) => panel.id === stack.activePanelId) || panels[0];
				const threshold = Math.max(3, Math.min($layoutStore.rightPanelDock.overflowThreshold || 5, 8));
				const visiblePanels = panels.slice(0, threshold);
				const overflowPanels = panels.slice(threshold);
				return {
					...stack,
					panels,
					activePanel,
					visiblePanels,
					overflowPanels
				};
			})
			.filter((stack): stack is RenderStack => Boolean(stack));
	}

	function buildMobileRenderStack(
		panels: WorkspacePanelManifest[],
		currentPanel: WorkspacePanelManifest | null
	): RenderStack[] {
		if (panels.length === 0) return [];
		const active = currentPanel && panels.some((panel) => panel.id === currentPanel.id) ? currentPanel : panels[0];
		const threshold = Math.max(4, Math.min($layoutStore.rightPanelDock.overflowThreshold || 5, 8));
		return [
			{
				id: 'mobile-stack',
				tabs: panels.map((panel) => panel.id),
				activePanelId: active.id,
				size: 100,
				minSize: 100,
				maxSize: 100,
				collapsed: false,
				pinned: true,
				panels,
				activePanel: active,
				visiblePanels: panels.slice(0, threshold),
				overflowPanels: panels.slice(threshold)
			}
		];
	}

	function showPanelContextMenu(event: MouseEvent, panelId: string): void {
		event.preventDefault();
		contextMenuPanelId = panelId;
		contextMenuPosition = { x: event.clientX, y: event.clientY };
		contextMenuVisible = true;
	}

	function hideContextMenu(): void {
		contextMenuVisible = false;
		contextMenuPanelId = '';
	}

	async function handleDetachPanel(): Promise<void> {
		if (!contextMenuPanelId || !$windowsEnabled) return;
		layoutStore.detachPanel(contextMenuPanelId as any);
		await openDetachedPanel({ kind: 'workspace-panel', panelId: contextMenuPanelId });
		hideContextMenu();
	}

	function splitPanel(panelId: string): void {
		layoutStore.splitRightPanelTab(panelId);
	}

	function addPanelToStack(panelId: string, stackId: string): void {
		if (!panelId) return;
		layoutStore.moveRightPanelTab(panelId, stackId);
		layoutStore.setActiveRightPanel(panelId);
	}

	function loadWorkspace(name: string): void {
		layoutStore.loadWorkspace(name);
	}

	function formatWorkspaceName(name: string): string {
		if (name === 'media-review') return 'Media Review';
		return name
			.split('-')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function handleTabKeydown(event: KeyboardEvent, stack: RenderStack, panel: WorkspacePanelManifest): void {
		const currentIndex = stack.panels.findIndex((candidate) => candidate.id === panel.id);
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
			event.preventDefault();
			const next = stack.panels[(currentIndex + 1) % stack.panels.length];
			layoutStore.setActiveRightPanel(next.id);
		}
		if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
			event.preventDefault();
			const previous = stack.panels[(currentIndex - 1 + stack.panels.length) % stack.panels.length];
			layoutStore.setActiveRightPanel(previous.id);
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			layoutStore.setActiveRightPanel(panel.id);
		}
		if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			splitPanel(panel.id);
		}
	}

	function handleDragStart(event: DragEvent, stackId: string, panelId: string): void {
		draggedPanelId = panelId;
		event.dataTransfer?.setData('text/plain', JSON.stringify({ panelId, stackId }));
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	}

	function handleDragOver(event: DragEvent): void {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	}

	function handleDrop(event: DragEvent, stackId: string, index = -1): void {
		event.preventDefault();
		let panelId = draggedPanelId;
		try {
			const payload = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}') as { panelId?: string };
			panelId = payload.panelId || panelId;
		} catch {
			// Keep the locally tracked drag id.
		}
		if (!panelId) return;
		layoutStore.moveRightPanelTab(panelId, stackId, index);
		draggedPanelId = '';
	}

	function startSplitResize(event: MouseEvent): void {
		event.preventDefault();
		if (renderStacks.length < 2) return;
		isResizingSplit = true;
		window.addEventListener('mousemove', handleSplitResizeMove);
		window.addEventListener('mouseup', stopSplitResize);
	}

	function handleSplitResizeMove(event: MouseEvent): void {
		if (!isResizingSplit || !dockElement) return;
		const rect = dockElement.getBoundingClientRect();
		const isHorizontalSplit = stacksWithDetachedFiltered.length > 1;
		let nextSize: number;
		if (isHorizontalSplit) {
			// Horizontal split (row mode): resize by X position
			nextSize = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
		} else {
			// Vertical split (column mode): resize by Y position
			nextSize = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
		}
		layoutStore.resizeRightPanelStacks(nextSize);
	}

	function stopSplitResize(): void {
		isResizingSplit = false;
		window.removeEventListener('mousemove', handleSplitResizeMove);
		window.removeEventListener('mouseup', stopSplitResize);
	}

	function getOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const me = $currentUser;
		if (!me) return null;
		const myStableId = me.dbUserId ? `user-${me.dbUserId}` : me.id;
		const otherStableId = (channel.members || []).find((id) => id !== myStableId);
		if (!otherStableId) return null;
		if (otherStableId.startsWith('user-')) {
			const dbId = Number.parseInt(otherStableId.slice(5), 10);
			return $users.find((u) => u.dbUserId === dbId) || null;
		}
		return $users.find((u) => u.id === otherStableId) || null;
	}

	function getDmLabel(channel: Channel): string {
		if (channel.type === 'group') {
			return channel.name || 'Group DM';
		}
		const other = getOtherUser(channel);
		return other?.username || channel.name || 'Direct Message';
	}

	function getMessageText(message: Message): string {
		if (message.type === 'text') return message.text;
		if (message.type === 'gif') return '[GIF]';
		if (message.type === 'file') return '[File]';
		if (message.type === 'emoji') return '[Emoji]';
		if (message.type === 'role_gate') return '[Role message]';
		return '[Message]';
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	function handleQuickMessageKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendQuickMessage();
		}
	}

	function sendQuickMessage(): void {
		if (!quickDmChannelId) return;
		const trimmed = quickMessage.trim();
		if (!trimmed) return;
		sendMessage(quickDmChannelId, trimmed);
		quickMessage = '';
	}

	function handleQuickResizeStart(event: MouseEvent): void {
		event.preventDefault();
		isResizingQuick = true;
		quickResizeStartY = event.clientY;
		quickResizeStartHeight = quickPanelHeight;
		window.addEventListener('mousemove', handleQuickResizeMove);
		window.addEventListener('mouseup', handleQuickResizeStop);
	}

	function handleQuickResizeMove(event: MouseEvent): void {
		if (!isResizingQuick) return;
		const delta = quickResizeStartY - event.clientY;
		const maxHeight = rightPanelElement ? Math.floor(rightPanelElement.clientHeight * QUICK_MAX_RATIO) : 420;
		const nextHeight = quickResizeStartHeight + delta;
		if (nextHeight <= QUICK_COLLAPSE_THRESHOLD) {
			quickPanelCollapsed = true;
			return;
		}
		quickPanelCollapsed = false;
		quickPanelHeight = Math.max(QUICK_MIN_HEIGHT, Math.min(maxHeight, nextHeight));
	}

	function handleQuickResizeStop(): void {
		isResizingQuick = false;
		window.removeEventListener('mousemove', handleQuickResizeMove);
		window.removeEventListener('mouseup', handleQuickResizeStop);
	}

	function collapseQuickPanel(): void {
		quickPanelCollapsed = true;
	}

	function expandQuickPanel(): void {
		quickPanelCollapsed = false;
		if (quickPanelHeight < QUICK_MIN_HEIGHT) {
			quickPanelHeight = QUICK_DEFAULT_HEIGHT;
		}
	}
</script>

<div class="right-panel" class:mobile-workspace={$layoutStore.isMobile} bind:this={rightPanelElement}>
	<div class="workspace-dock" class:split-mode={stacksWithDetachedFiltered.length > 1} class:resizing={isResizingSplit} bind:this={dockElement}>
		{#if stacksWithDetachedFiltered.length === 0}
			<div class="dock-empty">No workspace panels are available.</div>
	{:else}
		{#each stacksWithDetachedFiltered as stack, stackIndex (stack.id)}
				<section
					class="panel-stack"
					class:is-collapsed={stack.collapsed}
					role="group"
					aria-label={`${stack.activePanel.label} stack`}
					style:flex-basis={visibleStacks.length > 1 ? `${stack.collapsed ? 42 : stack.size}%` : '100%'}
					on:dragover={handleDragOver}
					on:drop={(event) => handleDrop(event, stack.id)}
				>
					<div class="stack-header" bind:this={panelDrawerRef}>
						<div class="stack-tabs" role="tablist" aria-label={`${stack.id} workspace panels`}>
							<button
								type="button"
								class="panel-tab active panel-tab-drawer-trigger"
								role="tab"
								aria-selected="true"
								title="Click to show all panels"
								on:click={() => { panelDrawerOpen = !panelDrawerOpen; panelSearchQuery = ''; }}
							>
								<span class="panel-tab-icon"><WorkspacePanelIcon icon={stack.activePanel.icon} /></span>
								<span class="panel-tab-label">{stack.activePanel.shortLabel || stack.activePanel.label}</span>
								<svg class="panel-tab-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M18 15l-6-6-6 6"></path>
								</svg>
							</button>

							{#if panelDrawerOpen}
								<div class="panel-drawer" role="listbox" aria-label="Available panels">
									{#if stack.panels.length > 10}
										<div class="panel-drawer-search">
											<input
												type="text"
												placeholder="Filter panels..."
												bind:value={panelSearchQuery}
												on:keydown={(e) => e.stopPropagation()}
											/>
										</div>
									{/if}
									<div class="panel-drawer-list" class:scrollable={stack.panels.length > 10}>
										{#each stack.panels.filter(p => !panelSearchQuery || p.label.toLowerCase().includes(panelSearchQuery.toLowerCase())) as panel (panel.id)}
											<button
												type="button"
												class="panel-drawer-item"
												class:active={stack.activePanel.id === panel.id}
												role="option"
												aria-selected={stack.activePanel.id === panel.id}
												on:click={() => { layoutStore.setActiveRightPanel(panel.id); panelDrawerOpen = false; panelSearchQuery = ''; }}
											>
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
							<button type="button" title="Split active panel — show two panels side by side" aria-label="Split active panel" on:click={() => splitPanel(stack.activePanel.id)}>
								<!-- Columns icon: two vertical panels side by side -->
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="3" width="7" height="18" rx="1"></rect>
									<rect x="14" y="3" width="7" height="18" rx="1"></rect>
								</svg>
							</button>
							<button
								type="button"
								class:active={!stack.collapsed}
								title={stack.collapsed ? 'Expand stack' : 'Collapse stack'}
								aria-label={stack.collapsed ? 'Expand stack' : 'Collapse stack'}
								on:click={() => layoutStore.toggleRightPanelStackCollapsed(stack.id)}
							>
								<!-- Chevron up/down -->
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									{#if stack.collapsed}
										<path d="M18 15l-6-6-6 6"></path>
									{:else}
										<path d="M6 9l6 6 6-6"></path>
									{/if}
								</svg>
							</button>
							<button
								type="button"
								class:active={stack.pinned}
								title={stack.pinned ? 'Pinned stack — tabs stay in place when adding or removing panels' : 'Unpinned stack — tabs may shift when layout changes'}
								aria-label={stack.pinned ? 'Pinned stack' : 'Unpinned stack'}
								on:click={() => layoutStore.toggleRightPanelStackPinned(stack.id)}
							>
								<!-- Pin / thumbtack -->
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
									<line x1="12" y1="17" x2="12" y2="22"></line>
									<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
								</svg>
							</button>
						</div>
					</div>

					{#if stack.collapsed}
						<button class="collapsed-stack-button" type="button" on:click={() => layoutStore.toggleRightPanelStackCollapsed(stack.id)}>
							<span class="panel-tab-icon"><WorkspacePanelIcon icon={stack.activePanel.icon} /></span>
							<span>{stack.activePanel.label}</span>
						</button>
					{:else}
						<div class="panel-stack-content">
							<WorkspacePanelHost panel={stack.activePanel} on:openSettings={(event) => dispatch('openSettings', event.detail)} />
						</div>
					{/if}
				</section>

				{#if stackIndex === 0 && visibleStacks.length > 1}
					<button
						type="button"
						class="stack-resize-handle"
						aria-label="Resize panel split"
						title="Resize panel split"
						on:mousedown={startSplitResize}
					></button>
				{/if}
			{/each}
		{/if}
	</div>

	{#if contextMenuVisible && $windowsEnabled}
		<div
			class="panel-context-menu"
			style={`left: ${contextMenuPosition.x}px; top: ${contextMenuPosition.y}px;`}
			bind:this={contextMenuRef}
			role="menu"
			aria-label="Panel options"
		>
			<button type="button" class="context-menu-item" role="menuitem" on:click={handleDetachPanel}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
					<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
					<polyline points="15 3 21 3 21 9"></polyline>
					<line x1="10" y1="14" x2="21" y2="3"></line>
				</svg>
				Open in new window
			</button>
		</div>
	{/if}

	<div
		class="quick-resources"
		class:is-collapsed={quickPanelCollapsed}
		style={`height: ${quickPanelCollapsed ? QUICK_COLLAPSED_BAR_HEIGHT : quickPanelHeight}px;`}
	>
		{#if quickPanelCollapsed}
			<div class="quick-collapsed-bar">
				<div class="quick-mode-toggle" role="tablist" aria-label="Notes and quick DM">
					<button type="button" class:active={quickMode === 'notes'} aria-pressed={quickMode === 'notes'} on:click={() => (quickMode = 'notes')}>Notes</button>
					<button type="button" class:active={quickMode === 'dm'} aria-pressed={quickMode === 'dm'} on:click={() => (quickMode = 'dm')}>DM</button>
				</div>
				<button class="quick-collapse-btn" type="button" title="Expand bottom panel" on:click={expandQuickPanel}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="18 15 12 9 6 15"></polyline>
					</svg>
				</button>
			</div>
		{:else}
			<button
				class="quick-resize-handle"
				type="button"
				on:mousedown={handleQuickResizeStart}
				title="Resize bottom panel"
				aria-label="Resize bottom panel"
			></button>

			<div class="quick-header">
				<div class="quick-header-main">
					<div class="quick-mode-toggle" role="tablist" aria-label="Notes and quick DM">
						<button type="button" class:active={quickMode === 'notes'} aria-pressed={quickMode === 'notes'} on:click={() => (quickMode = 'notes')}>Notes</button>
						<button type="button" class:active={quickMode === 'dm'} aria-pressed={quickMode === 'dm'} on:click={() => (quickMode = 'dm')}>DM</button>
					</div>

					{#if quickMode === 'dm'}
						<select class="quick-dm-select" bind:value={quickDmChannelId}>
							{#if dmChannels.length === 0}
								<option value="">No DM threads</option>
							{:else}
								{#each dmChannels as channel}
									<option value={channel.id}>{getDmLabel(channel)}</option>
								{/each}
							{/if}
						</select>
					{/if}
				</div>

				<button class="quick-collapse-btn" type="button" title="Collapse bottom panel" on:click={collapseQuickPanel}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="6 9 12 15 18 9"></polyline>
					</svg>
				</button>
			</div>

			<div class="quick-body">
				{#if quickMode === 'notes'}
					<WorkspacePanelHost panel={{ id: 'notes', label: 'Notes', icon: 'notes', component: 'notes', defaultDock: 'bottom', mobileMode: 'sheet', source: 'core' }} />
				{:else if !quickDmChannelId}
					<div class="quick-empty">Open a DM or group thread to use quick replies here.</div>
				{:else}
					<div class="quick-dm-shell">
						<div class="quick-dm-messages" bind:this={quickMessagesElement}>
							{#if quickRecentMessages.length === 0}
								<div class="quick-empty">No messages yet.</div>
							{:else}
								{#each quickRecentMessages as message}
									<div class="quick-dm-message">
										<div class="quick-dm-meta">
											<span class="quick-dm-author">{message.user}</span>
											<span class="quick-dm-time">{formatTime(message.timestamp)}</span>
										</div>
										<div class="quick-dm-text">{getMessageText(message)}</div>
									</div>
								{/each}
							{/if}
						</div>

						<div class="quick-dm-compose">
							<input
								type="text"
								bind:value={quickMessage}
								on:keydown={handleQuickMessageKeydown}
								placeholder={`Message ${quickConversationTitle}...`}
							/>
							<button class="quick-send-btn" type="button" on:click={sendQuickMessage}>Send</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.right-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background:
			radial-gradient(circle at top right, rgba(var(--accent-rgb), 0.12), transparent 34%),
			linear-gradient(180deg, color-mix(in srgb, var(--surface-base) 98%, transparent), color-mix(in srgb, var(--surface-app) 94%, transparent));
	}

	.overflow-menu,
	.quick-dm-select {
		min-width: 0;
		height: 32px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 84%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 90%, transparent);
		color: var(--text-heading);
		padding: 0 0.5rem;
		font-size: 0.76rem;
		font-weight: 650;
	}

	.stack-actions button,
	.quick-collapse-btn {
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
		background: color-mix(in srgb, var(--surface-base) 80%, transparent);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.stack-actions button:hover,
	.stack-actions button.active,
	.quick-collapse-btn:hover {
		border-color: rgba(var(--accent-rgb), 0.32);
		background: rgba(var(--accent-rgb), 0.12);
		color: var(--text-heading);
	}

	.stack-actions svg,
	.quick-collapse-btn svg {
		width: 16px;
		height: 16px;
	}

	.panel-tab {
		min-width: 0;
		height: 34px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
		background: color-mix(in srgb, var(--surface-base) 76%, transparent);
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		padding: 0 0.5rem;
		cursor: pointer;
		font-size: 0.73rem;
		font-weight: 750;
		white-space: nowrap;
	}

	.panel-tab.active {
		background: rgba(var(--accent-rgb), 0.18);
		border-color: rgba(var(--accent-rgb), 0.36);
		color: var(--text-heading);
	}

	.panel-tab-icon {
		width: 17px;
		height: 17px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.panel-tab-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.panel-badge {
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--color-danger, #ef4444);
		color: var(--text-inverse, #fff);
		font-size: 0.65rem;
		line-height: 16px;
		text-align: center;
	}

	.panel-tab-chevron {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		opacity: 0.7;
	}

	.panel-tab-drawer-trigger {
		flex: 1;
		min-width: 120px;
		max-width: 220px;
	}

	.panel-drawer {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 100;
		min-width: 180px;
		max-width: 320px;
		background: var(--surface-base);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
		border-radius: 10px;
		box-shadow: 0 4px 24px var(--shadow-md, var(--shadow-md, var(--shadow-lg, rgba(0, 0, 0, 0.28)))), 0 1px 4px var(--shadow-md, var(--shadow-md, rgba(0, 0, 0, 0.16)));
		overflow: hidden;
	}

	.panel-drawer-search {
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
	}

	.panel-drawer-search input {
		width: 100%;
		height: 30px;
		padding: 0 0.5rem;
		border-radius: 6px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
		background: var(--surface-raised);
		color: var(--text-heading);
		font-size: 0.73rem;
		box-sizing: border-box;
	}

	.panel-drawer-search input:focus {
		outline: none;
		border-color: rgba(var(--accent-rgb), 0.4);
	}

	.panel-drawer-list {
		display: flex;
		flex-direction: column;
		max-height: 360px;
		overflow-y: auto;
		padding: 0.3rem;
	}

	.panel-drawer-list.scrollable {
		max-height: 320px;
	}

	.panel-drawer-item {
		width: 100%;
		min-width: 0;
		height: 34px;
		border-radius: 7px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.5rem;
		cursor: pointer;
		font-size: 0.73rem;
		font-weight: 750;
		text-align: left;
	}

	.panel-drawer-item:hover {
		background: color-mix(in srgb, var(--surface-raised) 80%, transparent);
		border-color: color-mix(in srgb, var(--border-subtle) 60%, transparent);
		color: var(--text-heading);
	}

	.panel-drawer-item.active {
		background: rgba(var(--accent-rgb), 0.15);
		border-color: rgba(var(--accent-rgb), 0.3);
		color: var(--text-heading);
	}

	.workspace-dock {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.workspace-dock.split-mode {
		flex-direction: row;
	}

	.workspace-dock.resizing {
		cursor: ns-resize;
		user-select: none;
	}

	.panel-stack {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 44px;
		min-width: 0;
		overflow: hidden;
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
	}

	.workspace-dock.split-mode .panel-stack {
		flex-direction: row;
		border-bottom: none;
		border-right: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
	}

	.workspace-dock.split-mode .panel-stack:last-child {
		border-right: none;
	}

	.stack-header {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.48rem 0.55rem;
		background: color-mix(in srgb, var(--surface-base) 82%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 68%, transparent);
	}

	.stack-tabs {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		overflow-x: auto;
	}

	.stack-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.stack-actions button {
		width: 26px;
		height: 26px;
		border-radius: 7px;
	}

	.panel-stack-content {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.stack-resize-handle {
		flex-shrink: 0;
		border: none;
		border-top: 1px solid rgba(var(--accent-rgb), 0.2);
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb), 0.22), transparent);
		cursor: ns-resize;
		padding: 0;
		/* Default: vertical split (column) */
		height: 8px;
		width: 100%;
	}

	.workspace-dock.split-mode .stack-resize-handle {
		/* Horizontal split (row): resize handle is vertical */
		cursor: ew-resize;
		height: 100%;
		width: 8px;
		border-top: none;
		border-bottom: none;
		border-left: 1px solid rgba(var(--accent-rgb), 0.2);
		border-right: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb), 0.22), transparent);
	}

	.collapsed-stack-button,
	.dock-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.8rem;
		color: var(--text-secondary);
		background: transparent;
		border: none;
		font-weight: 700;
	}

	.quick-resources {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 86%, transparent);
		background:
			radial-gradient(circle at bottom right, rgba(var(--accent-rgb), 0.12), transparent 38%),
			linear-gradient(180deg, color-mix(in srgb, var(--surface-base) 94%, transparent), color-mix(in srgb, var(--surface-raised) 82%, transparent));
		overflow: hidden;
	}

	.quick-resize-handle {
		height: 8px;
		border: none;
		background: transparent;
		cursor: ns-resize;
		padding: 0;
		flex-shrink: 0;
	}

	.quick-header,
	.quick-collapsed-bar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.55rem 0.65rem;
	}

	.quick-header {
		justify-content: space-between;
	}

	.quick-collapsed-bar {
		justify-content: space-between;
		height: 100%;
	}

	.quick-header-main {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		flex: 1;
	}

	.quick-mode-toggle {
		display: inline-flex;
		align-items: center;
		padding: 0.16rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 86%, transparent);
		background: color-mix(in srgb, var(--surface-base) 86%, transparent);
	}

	.quick-mode-toggle button {
		height: 28px;
		padding: 0 0.7rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.quick-mode-toggle button.active {
		background: rgba(var(--accent-rgb), 0.18);
		color: var(--text-heading);
	}

	.quick-dm-select {
		flex: 1;
	}

	.quick-collapse-btn {
		border-radius: 999px;
		border: none;
		background: transparent;
	}

	.quick-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
	}

	.quick-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 0.95rem;
		color: var(--text-muted);
		font-size: 0.8rem;
		text-align: center;
	}

	.quick-dm-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.quick-dm-messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.quick-dm-message {
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-base) 78%, transparent);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
	}

	.quick-dm-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.2rem;
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	.quick-dm-author {
		color: var(--text-heading);
		font-weight: 750;
	}

	.quick-dm-text {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.quick-dm-compose {
		display: flex;
		gap: 0.45rem;
		padding: 0.55rem;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
	}

	.quick-dm-compose input {
		flex: 1;
		min-width: 0;
		height: 34px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		background: color-mix(in srgb, var(--surface-app) 90%, transparent);
		color: var(--text-heading);
		padding: 0 0.65rem;
	}

	.quick-send-btn {
		height: 34px;
		border: none;
		border-radius: 8px;
		background: var(--accent-primary);
		color: white;
		font-weight: 800;
		padding: 0 0.7rem;
		cursor: pointer;
	}

	.mobile-workspace .workspace-dock {
		flex: 1;
	}

	.mobile-workspace .panel-stack {
		flex-basis: 100% !important;
	}

	.mobile-workspace .panel-stack:not(:first-child),
	.mobile-workspace .stack-resize-handle,
	.mobile-workspace .quick-resources {
		display: none;
	}

	.mobile-workspace .stack-header {
		overflow-x: auto;
	}

	@media (max-width: 420px) {
		.panel-tab-label {
			display: none;
		}
	}

	.panel-context-menu {
		position: fixed;
		z-index: 9999;
		background: var(--surface-base);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		border-radius: 6px;
		padding: 4px;
		min-width: 160px;
		box-shadow: 0 4px 16px color-mix(in srgb, var(--surface-app) 80%, transparent);
	}

	.context-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--text-heading);
		font-size: 0.875rem;
		cursor: pointer;
		text-align: left;
	}

	.context-menu-item:hover {
		background: var(--surface-raised);
	}

	.context-menu-item svg {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}

	.detached-indicator {
		font-size: 0.7em;
		opacity: 0.6;
	}
</style>
