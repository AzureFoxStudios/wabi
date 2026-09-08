<script lang="ts">
	import { onMount, tick } from 'svelte';
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
	import { portal } from '$lib/actions/portal';
	import { panelActionIndex, positionPanelPopover } from '$lib/panelPopover';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import './RightStubStrip.css';

	let { floating = false }: { floating?: boolean } = $props();
	let stripRef = $state<HTMLElement | null>(null);
	let contextMenu = $state<{ panelId: string; x: number; y: number } | null>(null);
	let drawerOpen = $state(false);
	let drawerStyle = $state('');
	let contextMenuRef = $state<HTMLElement | null>(null);
	let drawerRef = $state<HTMLElement | null>(null);
	let addStubRef = $state<HTMLButtonElement | null>(null);
	let contextTrigger: HTMLButtonElement | null = null;
	const drawerId = $props.id();

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

	$effect(() => {
		if (!drawerOpen || !drawerRef) return;
		positionDrawer();
		const observer = new ResizeObserver(positionDrawer);
		observer.observe(drawerRef);
		return () => observer.disconnect();
	});

	onMount(() => {
		function handleKeydown(event: KeyboardEvent) {
			if (event.defaultPrevented || event.key !== 'Escape') return;
			if (contextMenu) {
				event.preventDefault();
				hideContextMenu(true);
				return;
			}
			if (drawerOpen) {
				event.preventDefault();
				closeDrawer(true);
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
		function handleWindowBlur() {
			hideContextMenu();
			closeDrawer();
		}
		document.addEventListener('keydown', handleKeydown);
		document.addEventListener('click', handleClickOutside);
		window.addEventListener('resize', positionDrawer);
		window.addEventListener('blur', handleWindowBlur);
		return () => {
			document.removeEventListener('keydown', handleKeydown);
			document.removeEventListener('click', handleClickOutside);
			window.removeEventListener('resize', positionDrawer);
			window.removeEventListener('blur', handleWindowBlur);
		};
	});

	function handleStubEnter(panelId: string): void {
		cancelPeekDismiss();
		layoutStore.peekPanel(panelId);
	}

	function handleStubFocus(panelId: string): void {
		cancelPeekDismiss();
		layoutStore.peekPanel(panelId);
	}

	function handleStubLeave(): void {
		if (contextMenu || drawerOpen) return;
		armPeekDismiss();
	}

	function handleStubBlur(): void {
		if (contextMenu || drawerOpen) return;
		armPeekDismiss();
	}

	function handleStubClick(panelId: string): void {
		layoutStore.pinPanel(panelId);
	}

	function handleStubContextMenu(event: MouseEvent, panelId: string): void {
		event.preventDefault();
		drawerOpen = false;
		contextTrigger = event.currentTarget as HTMLButtonElement;
		cancelPeekDismiss();
		// Coordinates relative to the strip: the menu is absolute inside the
		// strip, and the strip may be inside the transformed peek zone (which
		// would otherwise re-anchor viewport `fixed` children).
		const stripRect = stripRef?.getBoundingClientRect();
		const x = stripRect ? event.clientX - stripRect.left + 4 : event.clientX;
		const y = stripRect ? event.clientY - stripRect.top + 4 : event.clientY;
		contextMenu = { panelId, x, y };
	}

	function hideContextMenu(restoreFocus = false): void {
		contextMenu = null;
		if (restoreFocus) (contextTrigger?.isConnected ? contextTrigger : addStubRef)?.focus();
	}

	function closeDrawer(restoreFocus = false): void {
		drawerOpen = false;
		if (restoreFocus) addStubRef?.focus({ preventScroll: true });
	}

	async function toggleDrawer(): Promise<void> {
		if (drawerOpen) {
			closeDrawer(true);
			return;
		}
		contextMenu = null;
		cancelPeekDismiss();
		drawerOpen = true;
		await tick();
		if (!drawerOpen) return;
		positionDrawer();
		drawerRef?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
	}

	function positionDrawer(): void {
		if (!drawerOpen) return;
		const rect = addStubRef?.getBoundingClientRect();
		if (!rect) return;
		const placement = positionPanelPopover(rect,
			{ width: window.innerWidth, height: window.innerHeight },
			{ width: drawerRef?.offsetWidth || 260, height: drawerRef?.offsetHeight || 520 },
			$layoutStore.stubSide);
		drawerStyle = `top: ${placement.top}px; left: ${placement.left}px; max-width: ${placement.maxWidth}px; max-height: ${placement.maxHeight}px;`;
	}

	function handleActionKeys(event: KeyboardEvent): void {
		const root = event.currentTarget as HTMLElement;
		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
		const index = panelActionIndex(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length);
		if (index === null) return;
		event.preventDefault();
		buttons[index]?.focus();
	}

	function handleDrawerFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (next instanceof Node && (drawerRef?.contains(next) || addStubRef?.contains(next))) return;
		closeDrawer();
	}

	function handleAddKeydown(event: KeyboardEvent): void {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		if (!drawerOpen) void toggleDrawer();
	}

	function removeStub(panelId: string): void {
		layoutStore.removeStub(panelId);
		hideContextMenu();
		addStubRef?.focus({ preventScroll: true });
	}

	function moveStub(delta: number): void {
		if (!contextMenu) return;
		const index = $layoutStore.stubStrip.indexOf(contextMenu.panelId);
		if (index < 0) return;
		layoutStore.reorderStub(index, index + delta);
		hideContextMenu(true);
	}

	function resetStrip(): void {
		layoutStore.resetStubs();
		closeDrawer(true);
	}

	function toggleSide(): void {
		layoutStore.setStubSide($layoutStore.stubSide === 'left' ? 'right' : 'left');
		closeDrawer(true);
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
		bind:this={stripRef}
		class="stub-strip"
		class:floating={floating}
		class:side-left={$layoutStore.stubSide === 'left'}
		class:side-right={$layoutStore.stubSide === 'right'}
		role="group"
		aria-label="Panel strip"
		onmouseenter={cancelPeekDismiss}
		onmouseleave={handleStubLeave}
	>
		{#each stripPanels as panel (panel.id)}
			<button
				type="button"
				class="stub"
				class:active={isDisplayed(panel.id)}
				class:pinned={isPinned(panel.id)}
				onmouseenter={() => handleStubEnter(panel.id)}
				onmouseleave={handleStubLeave}
				onfocus={() => handleStubFocus(panel.id)}
				onblur={handleStubBlur}
				onclick={() => handleStubClick(panel.id)}
				oncontextmenu={(event) => handleStubContextMenu(event, panel.id)}
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
			onclick={toggleDrawer}
			onkeydown={handleAddKeydown}
			onmouseenter={cancelPeekDismiss}
			onmouseleave={handleStubLeave}
			aria-label="Add or manage panels"
			aria-haspopup="dialog"
			aria-expanded={drawerOpen}
			aria-controls={drawerOpen ? drawerId : undefined}
			title="Add panels"
		>
			<span class="stub-icon" aria-hidden="true">+</span>
		</button>

		{#if contextMenu}
			<div
				class="panel-context-menu stub-context-menu"
				style={$layoutStore.stubSide === 'right'
					? `right: ${Math.max(4, 24 - contextMenu.x)}px; top: ${contextMenu.y}px;`
					: `left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
				bind:this={contextMenuRef}
				role="menu"
				tabindex="-1"
				aria-label="Strip options"
				oncontextmenu={(event) => event.preventDefault()}
				onkeydown={handleActionKeys}
			>
				<button
					type="button"
					class="context-menu-item"
					role="menuitem"
					onclick={() => removeStub(contextMenu.panelId)}
				>
					Remove from strip
				</button>
				<button
					type="button"
					class="context-menu-item"
					role="menuitem"
					disabled={$layoutStore.stubStrip.indexOf(contextMenu.panelId) <= 0}
					onclick={() => moveStub(-1)}
				>
					Move up
				</button>
				<button
					type="button"
					class="context-menu-item"
					role="menuitem"
					disabled={$layoutStore.stubStrip.indexOf(contextMenu.panelId) >= $layoutStore.stubStrip.length - 1}
					onclick={() => moveStub(1)}
				>
					Move down
				</button>
			</div>
		{/if}
	</div>

	{#if drawerOpen}
		<div
			id={drawerId}
			class="panel-drawer stub-drawer"
			style={drawerStyle}
			bind:this={drawerRef}
			use:portal
			role="dialog"
			aria-label="Available panels"
			tabindex="-1"
			onkeydown={handleActionKeys}
			onfocusout={handleDrawerFocusOut}
			onmouseenter={cancelPeekDismiss}
		>
			<div class="panel-drawer-heading">Add panels</div>
			<div class="panel-drawer-list">
				{#each drawerPanels as panel (panel.id)}
					<button
						type="button"
						class="panel-drawer-item"
						aria-label={`Add ${panel.label} panel`}
						onclick={() => {
							layoutStore.addStub(panel.id);
							closeDrawer(true);
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
				<button type="button" class="panel-drawer-item" onclick={resetStrip}>
					Reset to defaults
				</button>
				<button type="button" class="panel-drawer-item" onclick={toggleSide}>
					Move panel strip {$layoutStore.stubSide === 'left' ? 'right' : 'left'}
				</button>
			</div>
		</div>
	{/if}
{/if}
