<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { isMobile, focusMode } from '$lib/layoutStoreStates';
	import { channels, channelUnreadCounts, currentUser } from '$lib/socket';
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
	import ContextMenu, { type MenuEntry } from './context-menu/ContextMenu.svelte';
	import WorkspacePanelIcon from './WorkspacePanelIcon.svelte';
	import Icon from './ui/Icon.svelte';
	import Tooltip from './ui/Tooltip.svelte';
	import Segmented from './ui/Segmented.svelte';
	import './RightStubStrip.css';

	let stripRef = $state<HTMLElement | null>(null);
	let contextMenu = $state<{ panelId: string; x: number; y: number } | null>(null);
	let contextTrigger = $state<HTMLButtonElement | null>(null);
	let hoveredId = $state<string | null>(null);
	let dragId = $state<string | null>(null);
	let dropIndex = $state<number | null>(null);
	let drawerOpen = $state(false);
	let drawerStyle = $state('');
	let drawerRef = $state<HTMLElement | null>(null);
	let addStubRef = $state<HTMLButtonElement | null>(null);
	const drawerId = $props.id();
	const drawerHeadingId = `${drawerId}-heading`;
	const sideLabelId = `${drawerId}-side`;
	const hoverLabelId = `${drawerId}-hover`;
	const hoverNoteId = `${drawerId}-hover-note`;

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
	// also add them via the "Add panels" popover.
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
	const transferOffers = $derived($incomingFileOffers.length);
	const transfersRunning = $derived(
		$activeTransfers.filter((t) => t.status !== 'complete' && t.status !== 'cancelled' && t.status !== 'failed').length
	);
	const transferBadgeCount = $derived(transferOffers + transfersRunning);
	// The DMs stub carries the same unread total as the sidebar's DMs row.
	const dmUnread = $derived(
		$channels
			.filter((ch) => ch.type === 'dm' || ch.type === 'group')
			.reduce((sum, ch) => sum + (Number($channelUnreadCounts[ch.id]) || 0), 0)
	);

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
			if (event.target instanceof Element && event.target.closest('[role="dialog"]:not(.stub-drawer), [role="alertdialog"]')) return;
			if (drawerOpen) {
				event.preventDefault();
				closeDrawer(true);
			}
			// Escape elsewhere ends a peek in MainLayout (endPeek) and never unpins anything.
		}
		function handleClickOutside(event: MouseEvent) {
			const target = event.target as Node | null;
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
			contextMenu = null;
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
		// Hover alone never opens a panel (unless "Open on hover" is on); the peek modifier does.
		// An already-open hover peek follows the pointer between items.
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

	// Right-click opens the rail menu and nothing else: the panel on screen stays as it is (§7.22).
	function handleStubContextMenu(event: MouseEvent, panelId: string): void {
		event.preventDefault();
		drawerOpen = false;
		contextTrigger = event.currentTarget as HTMLButtonElement;
		cancelPeekDismiss();
		// The rail hugs a screen edge, so the menu opens toward the content (it flips at the edge).
		const stripRect = stripRef?.getBoundingClientRect();
		const x = $layoutStore.stubSide === 'right' ? (stripRect?.left ?? event.clientX) - 6 : (stripRect?.right ?? event.clientX) + 6;
		contextMenu = { panelId, x, y: event.clientY };
	}

	// Shift F10 and the Menu key open the same menu from the keyboard, beside the focused stub.
	function handleStubKeydown(event: KeyboardEvent, panelId: string): void {
		if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
		event.preventDefault();
		const stub = event.currentTarget as HTMLButtonElement;
		const rect = stub.getBoundingClientRect();
		drawerOpen = false;
		contextTrigger = stub;
		cancelPeekDismiss();
		const x = $layoutStore.stubSide === 'right' ? rect.left - 6 : rect.right + 6;
		contextMenu = { panelId, x, y: rect.top };
	}

	// The menu's first item (§7.22): Unpin a pinned panel, in flow or stowed (the only way to drop a
	// pin you cannot see), or Pin one beside the stage when the stage keeps 600px.
	function togglePinFromMenu(panelId: string): void {
		if (inPinnedSet(panelId)) layoutStore.unpinOne(panelId);
		else if ($dockCanPin) layoutStore.pinPanel(panelId);
	}

	function moveStub(panelId: string, delta: number): void {
		const index = $layoutStore.stubStrip.indexOf(panelId);
		const target = index + delta;
		// The item stays focusable while unavailable (aria-disabled), so the action must check the edge.
		if (index < 0 || target < 0 || target >= $layoutStore.stubStrip.length) return;
		layoutStore.reorderStub(index, target);
	}

	function removeStub(panelId: string): void {
		layoutStore.removeStub(panelId);
		// The stub that opened the menu is gone: the add button keeps the keyboard in the rail.
		queueMicrotask(() => addStubRef?.focus({ preventScroll: true }));
	}

	const menuItems = $derived.by((): MenuEntry[] => {
		if (!contextMenu) return [];
		const panelId = contextMenu.panelId;
		const index = $layoutStore.stubStrip.indexOf(panelId);
		const pinned = inPinnedSet(panelId);
		return [
			pinned
				? { id: 'unpin', label: 'Unpin', icon: 'x', onSelect: () => togglePinFromMenu(panelId) }
				: {
						id: 'pin',
						label: 'Pin',
						icon: 'pin',
						disabled: !$dockCanPin,
						hint: $dockCanPin ? undefined : 'Needs a wider window',
						onSelect: () => togglePinFromMenu(panelId)
					},
			{ id: 'sep-move', type: 'separator' },
			{ id: 'up', label: 'Move up', icon: 'chevUp', disabled: index <= 0, onSelect: () => moveStub(panelId, -1) },
			{ id: 'down', label: 'Move down', icon: 'chevDown', disabled: index < 0 || index >= $layoutStore.stubStrip.length - 1, onSelect: () => moveStub(panelId, 1) },
			{ id: 'sep-remove', type: 'separator' },
			{ id: 'remove', label: 'Remove from rail', icon: 'minus', onSelect: () => removeStub(panelId) }
		];
	});

	const menuPanel = $derived(contextMenu ? panelById.get(contextMenu.panelId) ?? null : null);

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
		const height = drawerRef?.offsetHeight || 520;
		// Opens toward the stage and rests on the footer band, its foot 8px above the rail's foot.
		const anchor = { left: rect.left, right: rect.right, top: rect.bottom - 8 - height };
		const placement = positionPanelPopover(anchor,
			{ width: window.innerWidth, height: window.innerHeight },
			{ width: drawerRef?.offsetWidth || 300, height },
			$layoutStore.stubSide);
		drawerStyle = `top: ${placement.top}px; left: ${placement.left}px; max-width: ${placement.maxWidth}px; max-height: ${placement.maxHeight}px;`;
	}

	// ↑/↓ (and Home/End) move between the popover's rows, from every row: list navigation never
	// changes a setting. This runs in the capture phase, ahead of a segmented control's own keys,
	// so a Side or Open on hover segment keeps only ←/→ for choosing (radio-group arrows).
	const ROW_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);
	function handleActionKeys(event: KeyboardEvent): void {
		if (event.defaultPrevented || !ROW_KEYS.has(event.key)) return;
		const root = event.currentTarget as HTMLElement;
		const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([tabindex='-1'])"));
		const index = panelActionIndex(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length);
		if (index === null) return;
		event.preventDefault();
		if (event.target instanceof Element && event.target.closest('[role="radiogroup"]')) event.stopPropagation();
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

	function resetStrip(): void {
		layoutStore.resetStubs();
		layoutStore.addStub('wiki');
		layoutStore.addStub('forum');
		closeDrawer(true);
	}

	// "Open on hover" is the hover-to-peek preference ('none'); Off is the default hold-Shift peek.
	// A person who chose Alt or Ctrl earlier keeps it while Off is selected.
	const openOnHover = $derived($railPeekKey === 'none' ? 'on' : 'off');
	function setOpenOnHover(value: 'on' | 'off'): void {
		if (value === 'on') railPeekKey.set('none');
		else if ($railPeekKey === 'none') railPeekKey.set('shift');
	}

	async function setSide(side: 'left' | 'right'): Promise<void> {
		layoutStore.setStubSide(side);
		// The rail moved to the other edge: the popover follows its add button.
		await tick();
		positionDrawer();
	}

	/** The stub's accessible name: the badge said in words that are true for that panel. */
	function stubName(panel: WorkspacePanelManifest, badge: string | null): string {
		if (!badge) return panel.label;
		if (panel.id === 'dms') return `${panel.label}, ${badge} unread`;
		if (panel.id === 'transfers') {
			const parts = [
				transferOffers ? `${transferOffers} incoming` : '',
				transfersRunning ? `${transfersRunning} in progress` : ''
			].filter(Boolean);
			if (parts.length) return `${panel.label}, ${parts.join(', ')}`;
		}
		return `${panel.label}, ${badge} updates`;
	}

	function badgeText(panel: WorkspacePanelManifest): string | null {
		const extra = panel.id === 'transfers' ? transferBadgeCount : panel.id === 'dms' ? dmUnread : 0;
		const count = extra + (typeof panel.badge === 'number' ? panel.badge : 0);
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

	/** Shown as a peek (hover or held), never pinned in flow: a --w-raise fill, no tab join. */
	function isPeeked(panelId: string): boolean {
		return isDisplayed(panelId) && !isPinned(panelId);
	}

	/** The panel is open on purpose (pinned, or a held peek): the stub reads as pressed. */
	function isOpen(panelId: string): boolean {
		if (isPinned(panelId)) return true;
		return isDisplayed(panelId) && panelCommitted();
	}

	// A pinned panel sits in flow against the rail: the folder tab joins it, so the rail draws no
	// hairline of its own on that side (the panel's edge toward the stage is the column rule).
	const joined = $derived(!$isMobile && $dockCanPin && $layoutStore.rightPanelMode === 'pinned');

	// One line: the name, its state when it has one, what a click does, and how to peek. The peek
	// hint is left out while a pinned panel or a held peek is on screen: hover and the peek key do
	// nothing then (§7.22), so the tooltip never promises a gesture that cannot happen.
	function stubTip(panel: WorkspacePanelManifest): string {
		const action = isOpen(panel.id)
			? isPinned(panel.id) ? 'click to unpin' : 'click to close'
			: $dockCanPin ? 'click to pin' : 'click to open over the page';
		const stowed = isStowed(panel.id) ? ` · ${STOWED_NOTE.toLowerCase()}` : '';
		const peek = isOpen(panel.id) || panelCommitted() ? '' : ` · ${peekHint}`;
		return `${panel.label}${stowed} · ${action}${peek}`;
	}

	const tipSide = $derived($layoutStore.stubSide === 'left' ? 'right' : 'left');
</script>

{#if !$isMobile && !$focusMode}
	<div
		bind:this={stripRef}
		class="rail"
		class:side-left={$layoutStore.stubSide === 'left'}
		class:side-right={$layoutStore.stubSide === 'right'}
		class:joined
		role="group"
		aria-label="Panel rail"
		onmouseenter={() => { setPeekPointerInside(true); cancelPeekDismiss(); }}
		onmouseleave={() => { setPeekPointerInside(false); handleStubLeave(); }}
	>
		<div class="w-rail__list">
			{#each stripPanels as panel, index (panel.id)}
				{@const badge = badgeText(panel)}
				<Tooltip text={stubTip(panel)} placement={tipSide} disabled={dragId !== null || contextMenu !== null}>
					<button
						type="button"
						class="stub"
						class:active={isDisplayed(panel.id)}
						class:peeked={isPeeked(panel.id)}
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
						onkeydown={(event) => handleStubKeydown(event, panel.id)}
						ondragstart={(event) => handleDragStart(event, panel.id)}
						ondragover={(event) => handleDragOver(event, index)}
						ondrop={(event) => handleDrop(event, index)}
						ondragend={endDrag}
						data-panel-id={panel.id}
						aria-label={stubName(panel, badge)}
						aria-pressed={isOpen(panel.id)}
					>
						<span class="stub-icon"><WorkspacePanelIcon icon={panel.icon} /></span>
						<span class="stub-label">{panel.shortLabel || panel.label}</span>
						{#if badge}
							<span class="stub-badge w-badge w-badge--sm w-badge--ring" aria-hidden="true">{badge}</span>
						{/if}
					</button>
				</Tooltip>
			{/each}
		</div>
		<!-- The footer band: its top hairline is the footer rule shared with the sidebar foot, the
		     composer and the Scratchpad tray (y = 100% - --w-foot). -->
		<div class="w-rail__foot">
			<Tooltip text="Add or arrange panels" placement={tipSide} disabled={drawerOpen}>
				<button
					type="button"
					class="stub-add w-ibtn"
					bind:this={addStubRef}
					onclick={toggleDrawer}
					onkeydown={handleAddKeydown}
					onmouseenter={cancelPeekDismiss}
					onmouseleave={handleStubLeave}
					aria-label="Add panels"
					aria-haspopup="dialog"
					aria-expanded={drawerOpen}
					aria-controls={drawerOpen ? drawerId : undefined}
				>
					<Icon name="plus" />
				</button>
			</Tooltip>
		</div>
	</div>

	<ContextMenu
		open={contextMenu !== null}
		x={contextMenu?.x ?? 0}
		y={contextMenu?.y ?? 0}
		items={menuItems}
		ariaLabel="Rail options"
		headerLabel={menuPanel?.label ?? null}
		returnFocus={contextTrigger}
		onClose={() => (contextMenu = null)}
	/>

	{#if drawerOpen}
		<div
			id={drawerId}
			class="panel-drawer stub-drawer"
			style={drawerStyle}
			bind:this={drawerRef}
			use:portal
			role="dialog"
			aria-labelledby={drawerHeadingId}
			tabindex="-1"
			onkeydowncapture={handleActionKeys}
			onfocusout={handleDrawerFocusOut}
			onmouseenter={cancelPeekDismiss}
		>
			<h2 class="panel-drawer-heading" id={drawerHeadingId}>Add panels</h2>
			<div class="panel-drawer-list">
				{#each drawerPanels as panel (panel.id)}
					<button
						type="button"
						class="panel-drawer-item"
						aria-label={`Add ${panel.label} to the rail`}
						aria-describedby={panel.description ? `${drawerId}-desc-${panel.id}` : undefined}
						onclick={() => {
							layoutStore.addStub(panel.id);
							closeDrawer(true);
						}}
					>
						<span class="panel-tab-icon"><WorkspacePanelIcon icon={panel.icon} /></span>
						<span class="panel-tab-text">
							<span class="panel-tab-label">{panel.label}</span>
							{#if panel.description}
								<span class="panel-tab-desc" id={`${drawerId}-desc-${panel.id}`}>{panel.description}</span>
							{/if}
						</span>
					</button>
				{/each}
				{#if drawerPanels.length === 0}
					<p class="panel-drawer-empty">Every panel you can open is already on the rail.</p>
				{/if}
			</div>
			<div class="panel-drawer-footer" role="group" aria-labelledby={`${drawerId}-rail`}>
				<h3 class="panel-drawer-kicker" id={`${drawerId}-rail`}>Rail</h3>
				<div class="rail-pref">
					<span class="rail-pref-label" id={sideLabelId}>Side</span>
					<Segmented
						labelledby={sideLabelId}
						options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
						value={$layoutStore.stubSide}
						onchange={(side) => void setSide(side as 'left' | 'right')}
					/>
				</div>
				<div class="rail-pref">
					<span class="rail-pref-text">
						<span class="rail-pref-label" id={hoverLabelId}>Open on hover</span>
						<span class="rail-pref-note" id={hoverNoteId}>Only while no panel is pinned</span>
					</span>
					<Segmented
						labelledby={`${hoverLabelId} ${hoverNoteId}`}
						options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
						value={openOnHover}
						onchange={(value) => setOpenOnHover(value as 'on' | 'off')}
					/>
				</div>
				<button type="button" class="w-btn w-btn--quiet w-btn--sm rail-reset" onclick={resetStrip}>Reset rail</button>
			</div>
		</div>
	{/if}
{/if}
