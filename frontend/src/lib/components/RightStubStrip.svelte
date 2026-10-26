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
	import { armPeekDismiss, cancelPeekDismiss, setPeekPointerInside } from '$lib/rightPeekGestures';
	import { dockCanPin, openPanelFromRail, peekHeld, peekPanelFromRail } from '$lib/layoutStoreRightPanel';
	import { portal } from '$lib/actions/portal';
	import { railPeekKey, peekModifierHeld, peekKeyLabel, reorderIndexes } from '$lib/railPrefs';
	import { panelActionIndex, positionPanelPopover } from '$lib/panelPopover';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import './RightStubStrip.css';

	let stripRef = $state<HTMLElement | null>(null);
	let contextMenu = $state<{ panelId: string; x: number; y: number } | null>(null);
	let hoveredId = $state<string | null>(null);
	let dragId = $state<string | null>(null);
	let dropIndex = $state<number | null>(null);
	let drawerOpen = $state(false);
	let drawerStyle = $state('');
	let contextMenuRef = $state<HTMLElement | null>(null);
	let drawerRef = $state<HTMLElement | null>(null);
	let addStubRef = $state<HTMLButtonElement | null>(null);
	let contextTrigger: HTMLButtonElement | null = null;
	const drawerId = $props.id();
	const stowedNoteId = `${drawerId}-stowed`;

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
	// Fallback seed for the wiki/forum stubs: DEFAULT_STUB_STRIP lives in
	// layoutStoreStates.ts (not owned by this change), so fresh/legacy strips
	// that still equal the old ['users','dms','notes'] default get wiki+forum
	// appended once here. Custom user strips are left untouched; everyone can
	// also add them via the "Add panels" drawer above.
	let seededChannelPanels = $state(false);
	$effect(() => {
		if (seededChannelPanels) return;
		if (!panelById.has('wiki') || !panelById.has('forum')) return;
		seededChannelPanels = true;
		const ids = $layoutStore.stubStrip;
		const isLegacyDefault =
			ids.length === 3 && ids[0] === 'users' && ids[1] === 'dms' && ids[2] === 'notes';
		if (isLegacyDefault) {
			layoutStore.addStub('wiki');
			layoutStore.addStub('forum');
		}
	});
	const transferBadgeCount = $derived(
		$incomingFileOffers.length +
			$activeTransfers.filter(
				(t) => t.status !== 'complete' && t.status !== 'cancelled' && t.status !== 'failed'
			).length
	);

	$effect(() => {
		if (contextMenu) {
			const firstItem = contextMenuRef?.querySelector<HTMLButtonElement>('button:not(:disabled)');
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
			// Dialogs own Escape before this earlier document listener runs.
			if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"]')) return;
			if (contextMenu) {
				event.preventDefault();
				hideContextMenu(true);
				return;
			}
			if (drawerOpen) {
				event.preventDefault();
				closeDrawer(true);
			}
			// Escape elsewhere ends a peek in MainLayout (endPeek) and never unpins anything.
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
		// Holding the peek modifier while already resting on an item peeks it.
		function handleModifierDown(event: KeyboardEvent) {
			if (!hoveredId || contextMenu || drawerOpen || dragId || panelCommitted()) return;
			if (!['Shift', 'Alt', 'Control'].includes(event.key)) return;
			if (!peekModifierHeld($railPeekKey, event)) return;
			cancelPeekDismiss();
			peekPanelFromRail(hoveredId);
		}
		function handleWindowBlur() {
			hideContextMenu();
			closeDrawer();
		}
		document.addEventListener('keydown', handleKeydown);
		document.addEventListener('keydown', handleModifierDown);
		document.addEventListener('click', handleClickOutside);
		window.addEventListener('resize', positionDrawer);
		window.addEventListener('blur', handleWindowBlur);
		return () => {
			document.removeEventListener('keydown', handleKeydown);
			document.removeEventListener('keydown', handleModifierDown);
			document.removeEventListener('click', handleClickOutside);
			window.removeEventListener('resize', positionDrawer);
			window.removeEventListener('blur', handleWindowBlur);
		};
	});

	/** A pinned panel or a held peek is on screen: hover and focus must never swap it (§7.22). */
	function panelCommitted(): boolean {
		const mode = $layoutStore.rightPanelMode;
		return mode === 'pinned' || (mode === 'peek' && $peekHeld);
	}

	function handleStubEnter(panelId: string, event: MouseEvent): void {
		hoveredId = panelId;
		cancelPeekDismiss();
		if (dragId || panelCommitted()) return;
		// Hover alone never opens a panel (unless the preference is 'none'); the
		// peek modifier does. An already-open hover peek follows the pointer between items.
		if (peekModifierHeld($railPeekKey, event) || $layoutStore.rightPanelMode === 'peek') {
			peekPanelFromRail(panelId);
		}
	}

	// Focus shows the tooltip only; Enter or Space (a click) opens the panel.
	function handleStubFocus(): void {
		cancelPeekDismiss();
	}

	function handleStubLeave(): void {
		hoveredId = null;
		if (contextMenu || drawerOpen) return;
		armPeekDismiss();
	}

	function handleStubBlur(): void {
		if (contextMenu || drawerOpen) return;
		armPeekDismiss();
	}

	// Pin beside the stage when the clamp leaves it 600px; otherwise toggle a held peek (§8.4).
	function handleStubClick(panelId: string): void {
		cancelPeekDismiss();
		openPanelFromRail(panelId);
	}

	function handleStubContextMenu(event: MouseEvent, panelId: string): void {
		event.preventDefault();
		drawerOpen = false;
		contextTrigger = event.currentTarget as HTMLButtonElement;
		cancelPeekDismiss();
		// The rail hugs a screen edge, so the menu opens toward the content.
		const stripRect = stripRef?.getBoundingClientRect();
		const x = $layoutStore.stubSide === 'right'
			? window.innerWidth - (stripRect?.left ?? event.clientX) + 6
			: (stripRect?.right ?? event.clientX) + 6;
		const y = Math.min(event.clientY, window.innerHeight - 180);
		contextMenu = { panelId, x, y };
	}

	// The menu's first item (§7.22): Unpin a pinned panel, in flow or stowed (the only way to drop a
	// pin you cannot see), or Pin one beside the stage when the stage keeps 600px.
	function togglePinFromMenu(panelId: string): void {
		if (inPinnedSet(panelId)) layoutStore.unpinOne(panelId);
		else if ($dockCanPin) layoutStore.pinPanel(panelId);
		else return;
		hideContextMenu(true);
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
		layoutStore.addStub('wiki');
		layoutStore.addStub('forum');
		closeDrawer(true);
	}

	function cyclePeekKey(): void {
		const order = ['shift', 'alt', 'ctrl', 'none'] as const;
		railPeekKey.update((key) => order[(order.indexOf(key) + 1) % order.length]);
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

	function handleDragStart(event: DragEvent, panelId: string): void {
		dragId = panelId;
		cancelPeekDismiss();
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', panelId);
		}
	}

	function handleDragOver(event: DragEvent, index: number): void {
		if (!dragId) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		dropIndex = index;
	}

	function handleDrop(event: DragEvent, index: number): void {
		event.preventDefault();
		const from = dragId ? $layoutStore.stubStrip.indexOf(dragId) : -1;
		const move = reorderIndexes($layoutStore.stubStrip.length, from, index);
		if (move) layoutStore.reorderStub(move.from, move.to);
		endDrag();
	}

	function endDrag(): void {
		dragId = null;
		dropIndex = null;
	}

	const peekHint = $derived(
		$railPeekKey === 'none' ? 'hover to peek' : `hold ${peekKeyLabel($railPeekKey)} to peek`
	);

	const STOWED_NOTE = 'Pinned, shown when there is room';

	/** A panel is on screen: a stowed pin (no room beside the stage) is not, unless a held peek shows it. */
	function panelOnScreen(): boolean {
		const mode = $layoutStore.rightPanelMode;
		if (mode === 'none') return false;
		return mode !== 'pinned' || $dockCanPin || $peekHeld;
	}

	function isDisplayed(panelId: string): boolean {
		return panelOnScreen() && $layoutStore.activeRightTab === panelId;
	}

	function inPinnedSet(panelId: string): boolean {
		if ($layoutStore.rightPanelMode !== 'pinned') return false;
		return $layoutStore.dockStack.length > 0 ? $layoutStore.dockStack.includes(panelId) : $layoutStore.pinnedPanelId === panelId;
	}

	// Pinned in flow beside the stage (the folder tab).
	function isPinned(panelId: string): boolean {
		return $dockCanPin && inPinnedSet(panelId);
	}

	// Pinned, but stowed off screen until the stage has room for it again.
	function isStowed(panelId: string): boolean {
		return !$dockCanPin && inPinnedSet(panelId);
	}

	/** The panel is open on purpose (pinned, or a held peek): the stub reads as pressed. */
	function isOpen(panelId: string): boolean {
		if (isPinned(panelId)) return true;
		return isDisplayed(panelId) && panelCommitted();
	}

	function stubTip(panel: WorkspacePanelManifest): string {
		const action = isOpen(panel.id)
			? isPinned(panel.id) ? 'click to unpin' : 'click to close'
			: $dockCanPin ? 'click to pin beside others' : 'click to open over the page';
		const stowed = isStowed(panel.id) ? ` · ${STOWED_NOTE.toLowerCase()}` : '';
		return `${panel.label}${stowed} · ${action} · ${peekHint}`;
	}
</script>

{#if !$isMobile && !$focusMode}
	<div
		bind:this={stripRef}
		class="rail"
		class:side-left={$layoutStore.stubSide === 'left'}
		class:side-right={$layoutStore.stubSide === 'right'}
		role="group"
		aria-label="Panel rail"
		onmouseenter={() => { setPeekPointerInside(true); cancelPeekDismiss(); }}
		onmouseleave={() => { setPeekPointerInside(false); handleStubLeave(); }}
	>
		<div class="rail-list">
			{#each stripPanels as panel, index (panel.id)}
				<button
					type="button"
					class="stub"
					class:active={isDisplayed(panel.id)}
					class:pinned={isPinned(panel.id)}
					class:stowed={isStowed(panel.id)}
					class:dragging={dragId === panel.id}
					class:drop-before={dragId && dropIndex === index && $layoutStore.stubStrip.indexOf(dragId) > index}
					class:drop-after={dragId && dropIndex === index && $layoutStore.stubStrip.indexOf(dragId) < index}
					draggable="true"
					onmouseenter={(event) => handleStubEnter(panel.id, event)}
					onmouseleave={handleStubLeave}
					onfocus={handleStubFocus}
					onblur={handleStubBlur}
					onclick={() => handleStubClick(panel.id)}
					oncontextmenu={(event) => handleStubContextMenu(event, panel.id)}
					ondragstart={(event) => handleDragStart(event, panel.id)}
					ondragover={(event) => handleDragOver(event, index)}
					ondrop={(event) => handleDrop(event, index)}
					ondragend={endDrag}
					data-panel-id={panel.id}
					aria-label={panel.label}
					aria-pressed={isOpen(panel.id)}
					aria-describedby={isStowed(panel.id) ? stowedNoteId : undefined}
					data-tip={stubTip(panel)}
				>
					<span class="stub-icon"><WorkspacePanelIcon icon={panel.icon} /></span>
					<span class="stub-label">{panel.shortLabel || panel.label}</span>
					{#if badgeText(panel)}
						<span class="stub-badge">{badgeText(panel)}</span>
					{/if}
				</button>
			{/each}
		</div>
		<!-- The stowed state for assistive tech (the tooltip is CSS only). -->
		<span id={stowedNoteId} class="sr-only">{STOWED_NOTE}</span>
		<div class="rail-foot">
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
				data-tip="Add or arrange panels"
			>
				<span class="stub-icon" aria-hidden="true">+</span>
			</button>
		</div>
	</div>

	{#if contextMenu}
		<div
			class="panel-context-menu stub-context-menu"
			style={$layoutStore.stubSide === 'right'
				? `right: ${contextMenu.x}px; top: ${contextMenu.y}px;`
				: `left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
			bind:this={contextMenuRef}
			role="menu"
			tabindex="-1"
			aria-label="Rail options"
			oncontextmenu={(event) => event.preventDefault()}
			onkeydown={handleActionKeys}
		>
			{#if inPinnedSet(contextMenu.panelId)}
				<button type="button" class="context-menu-item" role="menuitem" onclick={() => contextMenu && togglePinFromMenu(contextMenu.panelId)}>
					Unpin
				</button>
			{:else}
				<button type="button" class="context-menu-item" role="menuitem" disabled={!$dockCanPin} onclick={() => contextMenu && togglePinFromMenu(contextMenu.panelId)}>
					{$dockCanPin ? 'Pin' : 'Pin · needs a wider window'}
				</button>
			{/if}
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
			<button type="button" class="context-menu-item" role="menuitem" onclick={() => contextMenu && removeStub(contextMenu.panelId)}>
				Remove from rail
			</button>
		</div>
	{/if}

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
					<div class="panel-drawer-empty">All available panels are already on the rail.</div>
				{/if}
			</div>
			<div class="panel-drawer-footer">
				<button type="button" class="panel-drawer-item" onclick={resetStrip}>
					Reset to defaults
				</button>
				<button type="button" class="panel-drawer-item" onclick={cyclePeekKey}>
					Peek with: {$railPeekKey === 'none' ? 'hover only' : `hold ${peekKeyLabel($railPeekKey)}`}
				</button>
				<button type="button" class="panel-drawer-item" onclick={toggleSide}>
					Move rail to the {$layoutStore.stubSide === 'left' ? 'right' : 'left'}
				</button>
			</div>
		</div>
	{/if}
{/if}
