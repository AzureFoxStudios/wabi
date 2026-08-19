<script lang="ts">
	import { onMount } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { isMobile, focusMode } from '$lib/layoutStoreStates';
	import { currentUser } from '$lib/socket';
	import { activeTransfers, incomingFileOffers } from '$lib/p2pFileTransfer';
	import {
		canAccessWorkspacePanel,
		workspacePanelList,
		type WorkspacePanelManifest
	} from '$lib/workspacePanels';
	import { armPeekDismiss, cancelPeekDismiss } from '$lib/rightPeekGestures';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import './RightStubStrip.css';

	let hoveredId = $state<string | null>(null);
	let contextMenu = $state<{ panelId: string; x: number; y: number } | null>(null);
	let drawerOpen = $state(false);
	let drawerStyle = $state('');
	let contextMenuRef = $state<HTMLElement | null>(null);
	let drawerRef = $state<HTMLElement | null>(null);
	let addStubRef = $state<HTMLButtonElement | null>(null);

	const availablePanels = $derived(
		$workspacePanelList.filter((panel) => canAccessWorkspacePanel(panel, $currentUser))
	);
	const panelById = $derived(
		new Map(availablePanels.map((panel) => [panel.id, panel] as const))
	);
	const stripPanels = $derived(
		$layoutStore.stubStrip
			.map((id) => panelById.get(id))
			.filter((panel): panel is WorkspacePanelManifest => Boolean(panel))
	);
	const drawerPanels = $derived(
		availablePanels.filter((panel) => !$layoutStore.stubStrip.includes(panel.id))
	);
	const transferBadgeCount = $derived(
		$incomingFileOffers.length +
			$activeTransfers.filter(
				(t) => t.status !== 'complete' && t.status !== 'cancelled' && t.status !== 'failed'
			).length
	);

	$effect(() => {
		if (contextMenu) {
			const firstItem = contextMenuRef?.querySelector('button');
			if (firstItem) firstItem.focus();
		}
	});

	onMount(() => {
		function handleKeydown(event: KeyboardEvent) {
			if (event.key !== 'Escape') return;
			if (contextMenu) {
				hideContextMenu();
				return;
			}
			if (drawerOpen) {
				closeDrawer();
				return;
			}
			layoutStore.closeRightPanel();
		}
		function handleClickOutside(event: MouseEvent) {
			const target = event.target as Node | null;
			if (contextMenu && contextMenuRef && !contextMenuRef.contains(target)) hideContextMenu();
			if (
				drawerOpen &&
				drawerRef &&
				!drawerRef.contains(target) &&
				!(target instanceof Node && addStubRef?.contains(target))
			) {
				closeDrawer();
			}
		}
		document.addEventListener('keydown', handleKeydown);
		document.addEventListener('click', handleClickOutside);
		return () => {
			document.removeEventListener('keydown', handleKeydown);
			document.removeEventListener('click', handleClickOutside);
		};
	});

	function handleStubEnter(panelId: string): void {
		hoveredId = panelId;
		cancelPeekDismiss();
		layoutStore.peekPanel(panelId);
	}

	function handleStubFocus(panelId: string): void {
		hoveredId = panelId;
		cancelPeekDismiss();
		layoutStore.peekPanel(panelId);
	}

	function handleStubLeave(): void {
		hoveredId = null;
		armPeekDismiss();
	}

	function handleStubBlur(): void {
		if (hoveredId !== null) hoveredId = null;
		armPeekDismiss();
	}

	function handleStubClick(panelId: string): void {
		hoveredId = null;
		layoutStore.pinPanel(panelId);
	}

	function handleStubContextMenu(event: MouseEvent, panelId: string): void {
		event.preventDefault();
		drawerOpen = false;
		contextMenu = { panelId, x: event.clientX, y: event.clientY };
	}

	function hideContextMenu(): void {
		contextMenu = null;
	}

	function closeDrawer(): void {
		drawerOpen = false;
	}

	function toggleDrawer(): void {
		if (drawerOpen) {
			closeDrawer();
			return;
		}
		contextMenu = null;
		drawerOpen = true;
		positionDrawer();
	}

	function positionDrawer(): void {
		const rect = addStubRef?.getBoundingClientRect();
		if (!rect) return;
		const side = $layoutStore.stubSide;
		const top = Math.min(rect.top - 8, window.innerHeight - 336);
		const edge = side === 'left' ? 'left' : 'right';
		drawerStyle = `top: ${Math.max(8, top)}px; ${edge}: 28px;`;
	}

	function removeStub(panelId: string): void {
		layoutStore.removeStub(panelId);
		hideContextMenu();
	}

	function moveStub(delta: number): void {
		if (!contextMenu) return;
		const index = $layoutStore.stubStrip.indexOf(contextMenu.panelId);
		if (index < 0) return;
		layoutStore.reorderStub(index, index + delta);
		hideContextMenu();
	}

	function resetStrip(): void {
		layoutStore.resetStubs();
		closeDrawer();
	}

	function toggleSide(): void {
		layoutStore.setStubSide($layoutStore.stubSide === 'left' ? 'right' : 'left');
		closeDrawer();
	}

	function badgeText(panel: WorkspacePanelManifest): string | null {
		const count =
			panel.id === 'transfers'
				? transferBadgeCount + (typeof panel.badge === 'number' ? panel.badge : 0)
				: typeof panel.badge === 'number'
					? panel.badge
					: 0;
		if (!count) return null;
		return count > 99 ? '99+' : String(count);
	}

	function isDisplayed(panelId: string): boolean {
		return $layoutStore.rightPanelMode !== 'none' && $layoutStore.activeRightTab === panelId;
	}

	function isPinned(panelId: string): boolean {
		return $layoutStore.rightPanelMode === 'pinned' && $layoutStore.pinnedPanelId === panelId;
	}
</script>

{#if !$isMobile && !$focusMode}
	<div
		class="stub-strip"
		class:side-left={$layoutStore.stubSide === 'left'}
		class:side-right={$layoutStore.stubSide === 'right'}
		on:mouseenter={cancelPeekDismiss}
		on:mouseleave={armPeekDismiss}
	>
		{#each stripPanels as panel (panel.id)}
			<button
				type="button"
				class="stub"
				class:active={isDisplayed(panel.id)}
				class:pinned={isPinned(panel.id)}
				class:revealed={hoveredId === panel.id}
				on:mouseenter={() => handleStubEnter(panel.id)}
				on:mouseleave={handleStubLeave}
				on:focus={() => handleStubFocus(panel.id)}
				on:blur={handleStubBlur}
				on:click={() => handleStubClick(panel.id)}
				on:contextmenu={(event) => handleStubContextMenu(event, panel.id)}
				aria-label={panel.label}
				aria-pressed={isPinned(panel.id)}
				title={panel.label}
			>
				<span class="stub-icon"><WorkspacePanelIcon icon={panel.icon} /></span>
				{#if badgeText(panel)}
					<span class="stub-badge">{badgeText(panel)}</span>
				{/if}
				{#if isPinned(panel.id)}
					<span class="stub-dot" aria-hidden="true"></span>
				{/if}
			</button>
		{/each}
		<button
			type="button"
			class="stub stub-add"
			bind:this={addStubRef}
			on:click={toggleDrawer}
			on:mouseenter={cancelPeekDismiss}
			on:mouseleave={armPeekDismiss}
			aria-label="Add or manage panels"
			title="Add panels"
		>
			<span class="stub-icon" aria-hidden="true">+</span>
		</button>
	</div>

	{#if contextMenu}
		<div
			class="panel-context-menu stub-context-menu"
			style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
			bind:this={contextMenuRef}
			role="menu"
			aria-label="Strip options"
			on:contextmenu|preventDefault
		>
			<button
				type="button"
				class="context-menu-item"
				role="menuitem"
				on:click={() => removeStub(contextMenu.panelId)}
			>
				Remove from strip
			</button>
			<button
				type="button"
				class="context-menu-item"
				role="menuitem"
				disabled={$layoutStore.stubStrip.indexOf(contextMenu.panelId) <= 0}
				on:click={() => moveStub(-1)}
			>
				Move up
			</button>
			<button
				type="button"
				class="context-menu-item"
				role="menuitem"
				disabled={$layoutStore.stubStrip.indexOf(contextMenu.panelId) >= $layoutStore.stubStrip.length - 1}
				on:click={() => moveStub(1)}
			>
				Move down
			</button>
		</div>
	{/if}

	{#if drawerOpen}
		<div
			class="panel-drawer stub-drawer"
			style={drawerStyle}
			bind:this={drawerRef}
			role="listbox"
			aria-label="Available panels"
			tabindex="-1"
			on:click|stopPropagation
		>
			<div class="panel-drawer-list">
				{#each drawerPanels as panel (panel.id)}
					<button
						type="button"
						class="panel-drawer-item"
						role="option"
						aria-selected={false}
						on:click={() => {
							layoutStore.addStub(panel.id);
							closeDrawer();
						}}
					>
						<span class="panel-tab-icon"><WorkspacePanelIcon icon={panel.icon} /></span>
						<span class="panel-tab-label">{panel.shortLabel || panel.label}</span>
						{#if panel.badge}<span class="panel-badge">{panel.badge}</span>{/if}
					</button>
				{/each}
				{#if drawerPanels.length === 0}
					<div class="panel-drawer-empty">All available panels are already in the strip.</div>
				{/if}
			</div>
			<div class="panel-drawer-footer">
				<button type="button" class="panel-drawer-item" on:click={resetStrip}>
					Reset to defaults
				</button>
				<button type="button" class="panel-drawer-item" on:click={toggleSide}>
					Stubs on {$layoutStore.stubSide === 'left' ? 'right' : 'left'}
				</button>
			</div>
		</div>
	{/if}
{/if}