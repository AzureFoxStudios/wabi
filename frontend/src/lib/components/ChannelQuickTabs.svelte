<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { channelUnreadCounts, channels, currentChannel, currentUser, joinChannel, voiceChannelMembers } from '$lib/socket';
	import { activeVoiceChannel, callMode } from '$lib/calling';
	import { layoutStore } from '$lib/layoutStore';
	import { mobileTabQueue, type AddonTabSpec, type MobileQueueTab } from '$lib/mobileTabQueue';
	import { openDetachedPanel } from '$lib/detachedPanels';

	type RenderTab = {
		id: string;
		type: 'channel' | 'addon';
		label: string;
		channelId?: string;
		addonId?: string;
		badgeCount: number;
		active: boolean;
		onSelect?: () => void;
	};

	const { tabs: queueTabs, addonTabs, activeTabId } = mobileTabQueue;

	let railViewport: HTMLDivElement | null = null;
	let railWidth = 0;
	let visibleTabCount = 0;
	let tabWidthPx = 0;
	let isOverflowing = false;
	let isPointerDragging = false;
	let pointerStartX = 0;
	let pointerStartScrollLeft = 0;
	let pointerLastDeltaX = 0;
	let pointerType: 'mouse' | 'touch' | 'pen' | '' = '';
	let suppressClick = false;
	let lastSyncedChannelId: string | null = null;
	let draggedChannelId: string | null = null;
	let dropTargetChannelId: string | null = null;
	let dropPosition: 'before' | 'after' = 'before';
	let suppressSelectUntil = 0;
	let contextMenuVisible = false;
	let contextMenuX = 0;
	let contextMenuY = 0;
	let contextMenuTab: RenderTab | null = null;

	const TAB_MIN_WIDTH = 88;
	const TAB_MAX_WIDTH = 168;
	// Negative gap matches visual overlap between queued tabs.
	const TAB_GAP = -12;
	const TAB_OVERLAP = 12;
	const EDGE_FIRST_MIN = 112;
	const EDGE_FIRST_MAX = 180;
	const EDGE_FIRST_RATIO = 0.26;
	const EDGE_LAST_MIN = 96;
	const SWIPE_SWITCH_THRESHOLD = 44;

	$: eligibleChannels = $channels.filter((channel) => (
		!channel.type ||
		channel.type === 'text' ||
		channel.type === 'public' ||
		channel.type === 'thread_public' ||
		channel.type === 'thread_private'
	));
	$: eligibleChannelIds = eligibleChannels.map((channel) => channel.id);
	$: eligibleChannelSet = new Set(eligibleChannelIds);
	$: channelById = new Map(eligibleChannels.map((channel) => [channel.id, channel] as const));
	$: addonById = new Map($addonTabs.map((addon) => [addon.id, addon] as const));

	$: mobileTabQueue.pruneChannels(eligibleChannelIds);

	$: if ($currentChannel && $currentChannel !== lastSyncedChannelId && eligibleChannelSet.has($currentChannel)) {
		mobileTabQueue.setActiveChannel($currentChannel);
		lastSyncedChannelId = $currentChannel;
	}

	// Keep queue deterministic: only channels the user explicitly visits are queued.

	$: renderTabs = buildRenderTabs($queueTabs, channelById, addonById);
	$: tabCount = renderTabs.length;
	$: showRail = tabCount >= 2;

	$: {
		const width = Math.max(0, railWidth);
		if (!showRail || width === 0) {
			visibleTabCount = 0;
			tabWidthPx = TAB_MIN_WIDTH;
			isOverflowing = false;
		} else {
			const countByMinWidth = Math.max(1, Math.floor((width + TAB_GAP) / (TAB_MIN_WIDTH + TAB_GAP)));
			visibleTabCount = Math.max(1, Math.min(tabCount, countByMinWidth));
			const totalGap = Math.max(0, visibleTabCount - 1) * TAB_GAP;
			const idealWidth = Math.floor((width - totalGap) / visibleTabCount);
			tabWidthPx = Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, idealWidth));
			const trackWidth = (tabCount * tabWidthPx) + (Math.max(0, tabCount - 1) * TAB_GAP);
			isOverflowing = trackWidth > width + 1;
		}
	}

	$: if (showRail) {
		void tick().then(() => ensureActiveTabVisible());
	}

	$: inChannelCall = $callMode === 'channel' && Boolean($activeVoiceChannel?.id);
	$: callParticipants = resolveCallParticipants();
	$: showCallParticipants = $layoutStore.isMobile && inChannelCall && callParticipants.length > 0;
	$: extraCallCount = Math.max(0, callParticipants.length - 5);

	function buildRenderTabs(
		items: MobileQueueTab[],
		channelLookup: Map<string, (typeof eligibleChannels)[number]>,
		addonLookup: Map<string, AddonTabSpec>
	): RenderTab[] {
		const result: RenderTab[] = [];
		for (const item of items) {
			if (item.type === 'channel') {
				const channel = channelLookup.get(item.channelId);
				if (!channel) continue;
				result.push({
					id: item.id,
					type: 'channel',
					label: `# ${channel.name}`,
					channelId: channel.id,
					badgeCount: $channelUnreadCounts[channel.id] || 0,
					active: $currentChannel === channel.id
				});
				continue;
			}

			const addon = addonLookup.get(item.addonId);
			if (!addon) continue;
			result.push({
				id: item.id,
				type: 'addon',
				label: addon.shortLabel || addon.label,
				addonId: addon.id,
				badgeCount: addon.badgeCount || 0,
				active: $activeTabId === item.id,
				onSelect: addon.onSelect
			});
		}
		return result;
	}

	function resolveCallParticipants(): Array<{ key: string; username: string; avatar?: string; initial: string }> {
		const channelId = $activeVoiceChannel?.id;
		if (!channelId) return [];

		const remote = [...($voiceChannelMembers[channelId] || [])];
		const current = $currentUser;
		if (current) {
			const currentStableId = current.dbUserId ? `user-${current.dbUserId}` : null;
			const hasCurrent = remote.some((member) =>
				member.userId === current.id ||
				member.socketId === current.id ||
				(currentStableId ? member.userId === currentStableId : false)
			);
			if (!hasCurrent) {
				remote.push({
					userId: currentStableId || current.id,
					socketId: current.id,
					username: current.username,
					profilePicture: current.profilePicture
				});
			}
		}

		return remote.map((member) => {
			const username = member.username || 'User';
			return {
				key: `${member.userId}:${member.socketId || ''}`,
				username,
				avatar: member.profilePicture,
				initial: username.charAt(0).toUpperCase() || '?'
			};
		});
	}

	function handleSelectTab(tab: RenderTab, event?: Event): void {
		if (Date.now() < suppressSelectUntil) {
			event?.preventDefault();
			return;
		}

		if (tab.type === 'channel' && tab.channelId) {
			joinChannel(tab.channelId);
			mobileTabQueue.setActiveTab(tab.id);
			return;
		}

		mobileTabQueue.setActiveTab(tab.id);
		tab.onSelect?.();
	}

	function handleDragStart(tab: RenderTab, event: DragEvent): void {
		if (tab.type !== 'channel' || !tab.channelId) {
			event.preventDefault();
			return;
		}
		draggedChannelId = tab.channelId;
		dropTargetChannelId = tab.channelId;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', tab.channelId);
		}
	}

	function handleDragOver(tab: RenderTab, event: DragEvent): void {
		if (!draggedChannelId || tab.type !== 'channel' || !tab.channelId) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		dropTargetChannelId = tab.channelId;
		const targetEl = event.currentTarget as HTMLElement | null;
		if (targetEl) {
			const rect = targetEl.getBoundingClientRect();
			const midpoint = rect.left + rect.width / 2;
			dropPosition = event.clientX >= midpoint ? 'after' : 'before';
		}
	}

	function handleDrop(tab: RenderTab, event: DragEvent): void {
		event.preventDefault();
		if (!draggedChannelId || tab.type !== 'channel' || !tab.channelId) return;
		mobileTabQueue.reorderChannelTab(draggedChannelId, tab.channelId, dropPosition);
		suppressSelectUntil = Date.now() + 180;
		draggedChannelId = null;
		dropTargetChannelId = null;
		dropPosition = 'before';
	}

	function handleDragEnd(): void {
		draggedChannelId = null;
		dropTargetChannelId = null;
		dropPosition = 'before';
	}

	function handleCloseTab(tab: RenderTab, event: Event): void {
		event.preventDefault();
		event.stopPropagation();
		closeTab(tab);
	}

	function closeTab(tab: RenderTab): void {
		if (tab.type === 'channel' && tab.channelId) {
			const closingActive = $currentChannel === tab.channelId;
			const fallbackChannel = renderTabs
				.filter((item) => item.type === 'channel' && item.channelId && item.channelId !== tab.channelId)
				.map((item) => item.channelId as string)[0];

			if (closingActive && fallbackChannel) {
				joinChannel(fallbackChannel);
			}
			mobileTabQueue.closeChannelTab(tab.channelId);
			return;
		}

		if (tab.type === 'addon' && tab.addonId) {
			mobileTabQueue.closeAddonTab(tab.addonId);
		}
	}

	async function handleDetachTab(tab: RenderTab, event: Event): Promise<void> {
		event.preventDefault();
		event.stopPropagation();
		await detachTab(tab);
	}

	async function detachTab(tab: RenderTab): Promise<void> {
		if (tab.type !== 'channel' || !tab.channelId) return;

		const rawName = tab.label.replace(/^#\s*/, '').trim();
		await openDetachedPanel({
			kind: 'channel-chat',
			channelId: tab.channelId,
			channelName: rawName || undefined
		});
		closeTab(tab);
	}

	function closeTabContextMenu(): void {
		contextMenuVisible = false;
		contextMenuTab = null;
	}

	function openTabContextMenu(tab: RenderTab, event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const menuWidth = 176;
		const menuHeight = 84;
		const maxX = Math.max(8, window.innerWidth - menuWidth - 8);
		const maxY = Math.max(8, window.innerHeight - menuHeight - 8);
		contextMenuX = Math.max(8, Math.min(event.clientX, maxX));
		contextMenuY = Math.max(8, Math.min(event.clientY, maxY));
		contextMenuTab = tab;
		contextMenuVisible = true;
	}

	async function handleContextDetach(): Promise<void> {
		if (!contextMenuTab) return;
		if (contextMenuTab.type !== 'channel') return;
		await detachTab(contextMenuTab);
		closeTabContextMenu();
	}

	function handleContextClose(): void {
		if (!contextMenuTab) return;
		closeTab(contextMenuTab);
		closeTabContextMenu();
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			closeTabContextMenu();
		}
	}

	function activateRelative(direction: -1 | 1): void {
		if (renderTabs.length <= 1) return;
		const activeIndex = Math.max(0, renderTabs.findIndex((tab) => tab.active));
		const nextIndex = Math.min(renderTabs.length - 1, Math.max(0, activeIndex + direction));
		if (nextIndex === activeIndex) return;
		handleSelectTab(renderTabs[nextIndex]);
	}

	function handleWheel(event: WheelEvent): void {
		if (!isOverflowing || !railViewport) return;
		const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
		if (Math.abs(dominantDelta) < 1) return;
		event.preventDefault();
		railViewport.scrollLeft += dominantDelta;
	}

	function handlePointerDown(event: PointerEvent): void {
		if (!railViewport) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		isPointerDragging = true;
		pointerType = (event.pointerType as 'mouse' | 'touch' | 'pen') || 'mouse';
		pointerStartX = event.clientX;
		pointerStartScrollLeft = railViewport.scrollLeft;
		pointerLastDeltaX = 0;
		suppressClick = false;
		railViewport.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent): void {
		if (!isPointerDragging || !railViewport) return;
		const deltaX = event.clientX - pointerStartX;
		pointerLastDeltaX = deltaX;
		if (Math.abs(deltaX) > 6) suppressClick = true;

		// Desktop drag-to-scroll.
		if (pointerType === 'mouse' || pointerType === 'pen') {
			railViewport.scrollLeft = pointerStartScrollLeft - deltaX;
			event.preventDefault();
		}
	}

	function handlePointerUp(event: PointerEvent): void {
		if (!isPointerDragging || !railViewport) return;
		if (railViewport.hasPointerCapture(event.pointerId)) {
			railViewport.releasePointerCapture(event.pointerId);
		}

		// Mobile swipe switches to adjacent tab when the queue overflows.
		if (pointerType === 'touch' && isOverflowing && Math.abs(pointerLastDeltaX) >= SWIPE_SWITCH_THRESHOLD) {
			activateRelative(pointerLastDeltaX < 0 ? 1 : -1);
		}

		isPointerDragging = false;
		pointerType = '';
		window.setTimeout(() => {
			suppressClick = false;
		}, 0);
	}

	function tabInlineStyle(tabIndex: number): string {
		const order = tabIndex + 1;
		if (tabCount >= 2 && railWidth > 0) {
			const effectiveRailWidth = railWidth;
			const firstWidth = Math.max(EDGE_FIRST_MIN, Math.min(EDGE_FIRST_MAX, Math.floor(effectiveRailWidth * EDGE_FIRST_RATIO)));
			const middleWidth = Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, tabWidthPx));
			if (tabIndex === 0) return `width: ${firstWidth}px; --tab-order: ${order}; --tab-depth: ${tabIndex};`;
			if (tabIndex === tabCount - 1) {
				const middleCount = Math.max(0, tabCount - 2);
				const usedWidth = firstWidth + (middleCount * middleWidth) - ((tabCount - 1) * TAB_OVERLAP);
				const fillWidth = Math.floor(effectiveRailWidth - usedWidth);
				// Fill to the right edge when there is room; otherwise fall back to standard width.
				if (fillWidth >= EDGE_LAST_MIN) {
					return `width: ${fillWidth}px; max-width: none; --tab-order: ${order}; --tab-depth: ${tabIndex};`;
				}
				return `width: ${middleWidth}px; --tab-order: ${order}; --tab-depth: ${tabIndex};`;
			}
			return `width: ${middleWidth}px; --tab-order: ${order}; --tab-depth: ${tabIndex};`;
		}
		return `width: ${tabWidthPx}px; --tab-order: ${order}; --tab-depth: ${tabIndex};`;
	}

	function ensureActiveTabVisible(): void {
		if (!railViewport || !showRail) return;
		const active = renderTabs.find((tab) => tab.active) || renderTabs[0];
		if (!active) return;
		const selector = `button[data-tab-id="${active.id}"]`;
		const activeButton = railViewport.querySelector(selector) as HTMLButtonElement | null;
		activeButton?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
	}

	onMount(() => {
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				railWidth = entry.contentRect.width;
			}
		});
		if (railViewport) resizeObserver.observe(railViewport);
		return () => resizeObserver.disconnect();
	});

	onDestroy(() => {
		isPointerDragging = false;
	});
</script>

<svelte:window on:click={closeTabContextMenu} on:keydown={handleWindowKeydown} />

{#if showCallParticipants}
	<div class="call-participants-strip" aria-label="Active voice participants">
		{#each callParticipants.slice(0, 5) as member (member.key)}
			<div class="call-avatar" title={member.username}>
				{#if member.avatar}
					<img src={member.avatar} alt={member.username} />
				{:else}
					<span>{member.initial}</span>
				{/if}
			</div>
		{/each}
		{#if extraCallCount > 0}
			<div class="call-avatar more">+{extraCallCount}</div>
		{/if}
	</div>
{/if}

{#if showRail}
	<div
		class="tab-rail-viewport"
		bind:this={railViewport}
		on:wheel={handleWheel}
	>
		<div class="tab-rail-track" class:edge-layout={tabCount >= 2}>
			{#each renderTabs as tab, tabIndex (tab.id)}
				<button
					class="queue-tab"
					class:active={tab.active}
					class:drag-target={tab.type === 'channel' && tab.channelId === dropTargetChannelId && draggedChannelId !== null && tab.channelId !== draggedChannelId}
					class:drop-before={tab.type === 'channel' && tab.channelId === dropTargetChannelId && dropPosition === 'before'}
					class:drop-after={tab.type === 'channel' && tab.channelId === dropTargetChannelId && dropPosition === 'after'}
					class:first-tab={tabCount >= 2 && tabIndex === 0}
					class:last-tab={tabCount >= 2 && tabIndex === tabCount - 1}
					style={tabInlineStyle(tabIndex)}
					data-tab-id={tab.id}
					draggable={tab.type === 'channel'}
					on:dragstart={(event) => handleDragStart(tab, event)}
					on:dragover={(event) => handleDragOver(tab, event)}
					on:drop={(event) => handleDrop(tab, event)}
					on:dragend={handleDragEnd}
					on:contextmenu={(event) => openTabContextMenu(tab, event)}
					on:click={(event) => handleSelectTab(tab, event)}
					title={tab.label}
				>
					<span class="tab-label">{tab.label}</span>
					{#if tab.badgeCount > 0}
						<span class="tab-badge">{tab.badgeCount > 99 ? '99+' : tab.badgeCount}</span>
					{/if}
					{#if tab.type === 'channel'}
						<span
							class="tab-detach"
							role="button"
							tabindex="0"
							aria-label={`Detach ${tab.label}`}
							title={`Detach ${tab.label} to new window`}
							on:pointerdown={(event) => {
								event.preventDefault();
								event.stopPropagation();
							}}
							on:click={(event) => {
								void handleDetachTab(tab, event);
							}}
							on:keydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									void handleDetachTab(tab, event);
								}
							}}
						>
							↗
						</span>
					{/if}
					<span
						class="tab-close"
						role="button"
						tabindex="0"
						aria-label={`Close ${tab.label}`}
						title={`Close ${tab.label}`}
						on:pointerdown={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
						on:click={(event) => handleCloseTab(tab, event)}
						on:keydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								handleCloseTab(tab, event);
							}
						}}
					>
						x
					</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

{#if contextMenuVisible && contextMenuTab}
	<div
		class="tab-context-menu"
		style="left: {contextMenuX}px; top: {contextMenuY}px;"
		role="menu"
		on:click|stopPropagation
		on:contextmenu|preventDefault
	>
		<button type="button" class="tab-context-item" role="menuitem" on:click={handleContextClose}>
			Close Tab
		</button>
		<button
			type="button"
			class="tab-context-item"
			role="menuitem"
			disabled={contextMenuTab.type !== 'channel'}
			on:click={() => {
				void handleContextDetach();
			}}
		>
			Detach Tab
		</button>
	</div>
{/if}

<style>
	.call-participants-strip {
		display: flex;
		align-items: center;
		gap: 0;
		padding: 0.4rem 0.6rem 0.25rem 0;
		background: var(--bg-secondary);
		border-bottom: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	.call-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-tertiary);
		color: var(--text-primary);
		font-size: 0.75rem;
		font-weight: 700;
		overflow: hidden;
		border: none;
		margin-left: -8px;
	}

	.call-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.call-avatar.more {
		margin-left: -8px;
		font-size: 0.72rem;
	}

	.call-participants-strip .call-avatar:first-child {
		margin-left: 0;
	}

	.tab-rail-viewport {
		overflow-x: auto;
		overflow-y: hidden;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
		background: #505050;
		border-bottom: none;
		padding: 0;
		touch-action: pan-y;
		cursor: grab;
	}

	.tab-rail-viewport:active {
		cursor: grabbing;
	}

	.tab-rail-viewport::-webkit-scrollbar {
		display: none;
	}

	.tab-rail-track {
		display: flex;
		align-items: center;
		gap: 0;
		min-width: min-content;
		padding: 0;
	}

	.tab-rail-track.edge-layout {
		width: 100%;
		min-width: 100%;
	}

	.queue-tab {
		--tab-darken: min(82%, calc(var(--tab-depth, 0) * var(--tab-shade-strength, 0.06) * 100%));
		height: 31px;
		min-height: 31px;
		max-width: 168px;
		border-radius: 999px;
		border: none;
		background: #383838;
		background: color-mix(in srgb, var(--bg-tertiary, #383838) calc(100% - var(--tab-darken)), black var(--tab-darken));
		color: #f3f4f6;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 0 1.45rem 0 0.85rem;
		font-size: 0.74rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		flex: 0 0 auto;
		transition: color 0.18s ease, background 0.18s ease, transform 0.2s ease, border-radius 0.2s ease, box-shadow 0.2s ease;
		margin-left: -12px;
		position: relative;
		z-index: var(--tab-order, 1);
	}

	.queue-tab:first-child {
		margin-left: 0;
	}

	.tab-rail-track.edge-layout .queue-tab {
		flex: 0 0 auto;
		margin-left: -10px;
	}

	.tab-rail-track.edge-layout .queue-tab.first-tab {
		margin-left: 0;
		border-radius: 0;
	}

	.tab-rail-track.edge-layout .queue-tab.last-tab {
		border-radius: 999px 0 0 999px;
		margin-right: 0;
	}


	.queue-tab:hover {
		background: #424242;
		z-index: 2;
	}

	.queue-tab.active {
		color: #ffffff;
		background: #1e1e1e;
		background: color-mix(in srgb, var(--bg-primary, #1e1e1e) 86%, black 14%);
		transform: none;
		border-radius: 999px;
		z-index: calc(var(--tab-order, 1) + 120);
	}

	.queue-tab.drag-target {
		outline: 2px solid rgba(255, 255, 255, 0.2);
		outline-offset: -2px;
	}

	.queue-tab.drop-before::before,
	.queue-tab.drop-after::after {
		content: '';
		position: absolute;
		top: 4px;
		bottom: 4px;
		width: 3px;
		background: rgba(255, 255, 255, 0.9);
		border-radius: 999px;
		pointer-events: none;
	}

	.queue-tab.drop-before::before {
		left: 0;
	}

	.queue-tab.drop-after::after {
		right: 0;
	}

	.tab-rail-track.edge-layout .queue-tab.first-tab.active {
		border-radius: 999px;
	}

	.tab-rail-track.edge-layout .queue-tab.last-tab.active {
		border-radius: 999px 0 0 999px;
	}

	.tab-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tab-close {
		position: absolute;
		right: 6px;
		top: 50%;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		width: 16px;
		height: 16px;
		border: none;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.14);
		color: #fff;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.78rem;
		line-height: 1;
		padding: 0;
		margin-left: 0.2rem;
		transition: opacity 0.12s ease, background 0.12s ease;
	}

	.tab-detach {
		position: absolute;
		right: 24px;
		top: 50%;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		width: 16px;
		height: 16px;
		border: none;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.14);
		color: #fff;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.66rem;
		line-height: 1;
		padding: 0;
		transition: opacity 0.12s ease, background 0.12s ease;
	}

	.queue-tab:hover .tab-detach {
		opacity: 1;
		pointer-events: auto;
	}

	.tab-detach:hover {
		background: rgba(255, 255, 255, 0.26);
	}

	.queue-tab:hover .tab-close {
		opacity: 1;
		pointer-events: auto;
	}

	.tab-close:hover {
		background: rgba(255, 255, 255, 0.26);
	}

	.tab-badge {
		min-width: 22px;
		height: 22px;
		padding: 0 6px;
		border-radius: 999px;
		background: #a51f1f;
		color: #fff;
		font-size: 0.72rem;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: none;
	}

	@media (max-width: 768px) {
		.queue-tab {
			height: 31px;
			min-height: 31px;
			font-size: 0.72rem;
			margin-left: -10px;
		}
	}

	.tab-context-menu {
		position: fixed;
		z-index: 2200;
		min-width: 172px;
		padding: 0.3rem;
		background: var(--bg-secondary, #20222f);
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 10px;
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.36);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.tab-context-item {
		border: none;
		background: transparent;
		color: var(--text-primary, #f3f4f6);
		border-radius: 7px;
		padding: 0.5rem 0.6rem;
		text-align: left;
		font-size: 0.82rem;
		cursor: pointer;
	}

	.tab-context-item:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.1);
	}

	.tab-context-item:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>


