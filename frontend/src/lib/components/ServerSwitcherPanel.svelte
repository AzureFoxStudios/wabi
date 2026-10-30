<!--
	Saved servers (design contract §8.1, §7.13): the switcher overlays the sidebar at the sidebar's
	width and never covers center stage; on phones it is a bottom sheet over a scrim.

	- Head: kicker "SAVED SERVERS", the current server in serif 18 and its host in mono without
	  the scheme, then "Each server keeps its own account." (multi-server is not federation:
	  every row is its own server with its own sign-in).
	- Rows are 52px: the server icon (or the ensō, or an initial under neutral branding) 28, the
	  name over the host, an ink badge for unread followed channels. The current server takes the
	  selection grammar (--w-raise, aria-current="page"). Rename, take-out-of-folder and remove
	  live in the row's ⋯ menu; remove asks first.
	- Shortcuts (recent and followed channels) is a disclosure, closed until asked for.
	- "Add server" is a default button in the 80px footer band, on the shared footer rule.
	- Esc closes it and focus returns to whatever opened it. Roles and kit classes only.
-->
<script lang="ts">
	import HostLink from './HostLink.svelte';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
	import { modalFocus } from '$lib/actions/modalFocus';
	import { followUnreadCountsByServer } from '$lib/followingSnapshots';
	import { brandConfig } from '$lib/branding';
	import { confirmAction, isConfirmOpen } from '$lib/confirm';
	import { layoutStore } from '$lib/layoutStore';
	import { serverHostLabel, serverUnreadBadge, serverUnreadLabel } from '$lib/serverSwitcherLabels';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import ModeTabsDrawer from './ModeTabsDrawer.svelte';
	import {
		currentSavedServer,
		createSavedServerFolder,
		moveSavedServerToFolder,
		openUnsavedServer,
		removeSavedServer,
		reorderSavedServer,
		reorderSavedServerRailItem,
		renameSavedServerFolder,
		renameLocalSavedServer,
		savedServerRailItems,
		setUseNeutralBranding,
		switchToSavedServer,
		type SavedServerRailItem,
		type SavedServerView
	} from '$lib/savedServers';

	const dispatch = createEventDispatcher<{
		close: void;
	}>();

	export let mobile = false;
	export let dockSide: 'left' | 'right' = 'left';

	type MobileMoveState =
		| {
				kind: 'server';
				serverUrl: string;
				label: string;
				sourceFolderId: string | null;
		  }
		| {
				kind: 'folder';
				itemId: string;
				label: string;
		  }
		| null;

	type MobileDragState = {
		x: number;
		y: number;
	};

	type MobileDropPreview =
		| {
				kind: 'group-position';
				itemId: string;
				position: 'before' | 'after';
		  }
		| {
				kind: 'join-folder';
				itemId: string;
		  }
		| {
				kind: 'row-position';
				serverUrl: string;
				itemId: string;
				position: 'before' | 'after';
		  }
		| {
				kind: 'make-folder';
				serverUrl: string;
		  }
		| null;

	const MOBILE_MOVE_SUPPRESS_MS = 700;
	const MOBILE_AUTO_SCROLL_EDGE_PX = 88;
	const MOBILE_AUTO_SCROLL_MAX_STEP = 18;

	let manualServerUrl = '';
	let editingUrl: string | null = null;
	let aliasDraft = '';
	let editingFolderId: string | null = null;
	let folderNameDraft = '';
	let expandedFolderIds = new Set<string>();
	let mobileFolderStateInitialized = false;
	let mobileMove: MobileMoveState = null;
	let mobileDragState: MobileDragState | null = null;
	let mobileDropPreview: MobileDropPreview = null;
	let suppressTapUntil = 0;
	let mobileAutoScrollFrame: number | null = null;
	let switcherListElement: HTMLDivElement | null = null;
	let brokenImageUrls = new Set<string>();
	let showcaseServer: SavedServerView | null = null;
	// Shortcuts stay closed until asked for: the switcher's job is choosing a server.
	let utilityPanelExpanded = false;
	let addServerExpanded = false;
	let addServerInput: HTMLInputElement | null = null;
	let addServerPanel: HTMLElement | null = null;
	let addServerButton: HTMLButtonElement | null = null;
	let panelElement: HTMLElement | null = null;
	let opener: HTMLElement | null = null;

	const uid = Math.random().toString(36).slice(2, 8);
	const kickerId = `switcher-kicker-${uid}`;
	const titleId = `switcher-title-${uid}`;
	const shortcutsId = `switcher-shortcuts-${uid}`;
	const addInputId = `switcher-add-${uid}`;

	// MainLayout sizes the overlay to max(sidebar, 320px); the panel itself keeps to the sidebar's
	// own width, so it never covers the stage's leading edge (critique shell#2).
	const MIN_OVERLAY_WIDTH = 320;
	$: overlayExcess = Math.max(0, MIN_OVERLAY_WIDTH - Math.max(0, $layoutStore.channelSidebarWidth || 0));

	function close(): void {
		dispatch('close');
	}

	/** The phone sheet is modal (focus trap, Esc, focus return); the desktop overlay is not. */
	function sheetFocus(node: HTMLElement, enabled: boolean) {
		let handle: ReturnType<typeof modalFocus> | null = enabled ? modalFocus(node, close) : null;
		return {
			update(next: boolean) {
				if (next && !handle) handle = modalFocus(node, close);
				else if (!next && handle) {
					handle.destroy();
					handle = null;
				}
			},
			destroy() {
				handle?.destroy();
			}
		};
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (mobile || event.key !== 'Escape' || event.defaultPrevented || isConfirmOpen()) return;
		event.preventDefault();
		close();
	}

	function startEditing(server: SavedServerView): void {
		editingUrl = server.url;
		aliasDraft = server.localAlias || '';
	}

	function stopEditing(): void {
		editingUrl = null;
		aliasDraft = '';
	}

	function saveAlias(url: string): void {
		renameLocalSavedServer(url, aliasDraft);
		stopEditing();
	}

	function getServerTitle(server: SavedServerView): string {
		const canonicalName =
			server.frontendMetadata?.displayName ||
			server.launchPageBranding?.brandName ||
			server.url;
		if (server.localAlias && server.localAlias !== canonicalName) {
			return `${canonicalName}\n${server.url}`;
		}
		return canonicalName;
	}

	function handleServerRowSelect(server: SavedServerView): void {
		if (shouldSuppressMobileTap()) return;
		if (!server.isActive) {
			switchToSavedServer(server.url);
		}
		dispatch('close');
	}

	function handleServerRowKeydown(event: KeyboardEvent, server: SavedServerView): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		handleServerRowSelect(server);
	}

	async function removeServer(server: SavedServerView): Promise<void> {
		const remove = await confirmAction({
			title: `Remove ${server.effectiveName} from saved servers?`,
			body: 'It leaves this device’s list. Your account and messages on that server stay as they are.',
			confirm: 'Remove server',
			danger: true
		});
		if (!remove) return;
		removeSavedServer(server.url);
		if (editingUrl === server.url) {
			stopEditing();
		}
	}

	function rowMenuItems(server: SavedServerView, item: SavedServerRailItem): MenuEntry[] {
		const items: MenuEntry[] = [
			{ id: 'rename', label: 'Rename on this device', icon: 'pencil', onSelect: () => startEditing(server) }
		];
		if (item.kind === 'folder') {
			items.push({ id: 'ungroup', label: 'Take out of folder', icon: 'folder', onSelect: () => ungroupServer(server.url) });
		}
		items.push({ id: 'remove', label: 'Remove saved server', icon: 'trash', danger: true, onSelect: () => void removeServer(server) });
		return items;
	}

	function folderMenuItems(item: Extract<SavedServerRailItem, { kind: 'folder' }>): MenuEntry[] {
		return [
			{ id: 'rename-folder', label: 'Rename folder', icon: 'pencil', onSelect: () => startEditingFolder(item.folder.id, item.folder.name || '') }
		];
	}

	function editorKeydown(event: KeyboardEvent, save: () => void, cancel: () => void): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			save();
		}
		if (event.key === 'Escape') {
			// The field's own Esc cancels the edit; it never also closes the switcher.
			event.preventDefault();
			event.stopPropagation();
			cancel();
		}
	}

	function ungroupServer(url: string): void {
		moveSavedServerToFolder(url, null);
		if (editingUrl === url) {
			stopEditing();
		}
	}

	function startEditingFolder(folderId: string, currentName: string): void {
		editingFolderId = folderId;
		folderNameDraft = currentName;
		if (mobile) {
			expandedFolderIds = new Set([...expandedFolderIds, folderId]);
		}
	}

	function stopEditingFolder(): void {
		editingFolderId = null;
		folderNameDraft = '';
	}

	function saveFolderName(folderId: string): void {
		renameSavedServerFolder(folderId, folderNameDraft);
		stopEditingFolder();
	}

	function handleOpenManualServer(): void {
		const nextUrl = manualServerUrl.trim();
		if (!nextUrl) return;
		openUnsavedServer(nextUrl);
		manualServerUrl = '';
		addServerExpanded = false;
	}

	async function openAddServerPanel(): Promise<void> {
		addServerExpanded = true;
		await tick();
		addServerPanel?.scrollIntoView({ block: 'nearest' });
		addServerInput?.focus();
	}

	async function closeAddServerPanel(): Promise<void> {
		addServerExpanded = false;
		manualServerUrl = '';
		await tick();
		addServerButton?.focus();
	}

	function canRenderServerImage(url: string | null | undefined, failedUrls: ReadonlySet<string>): boolean {
		return Boolean(url && !failedUrls.has(url));
	}

	function markImageBroken(url: string | null | undefined): void {
		if (!url || brokenImageUrls.has(url)) return;
		const next = new Set(brokenImageUrls);
		next.add(url);
		brokenImageUrls = next;
	}

	function armMobileTapSuppression(): void {
		suppressTapUntil = Date.now() + MOBILE_MOVE_SUPPRESS_MS;
	}

	function shouldSuppressMobileTap(): boolean {
		return mobile && Date.now() < suppressTapUntil;
	}

	function groupMembers(item: SavedServerRailItem): SavedServerView[] {
		return item.kind === 'folder' ? item.folder.members : [item.server];
	}

	function getShowcaseServer(items: SavedServerRailItem[], active: SavedServerView | null): SavedServerView | null {
		if (active) return active;
		for (const item of items) {
			if (item.kind === 'folder') {
				if (item.folder.activeMember) return item.folder.activeMember;
				if (item.folder.members[0]) return item.folder.members[0];
				continue;
			}
			return item.server;
		}
		return null;
	}

	function toggleFolderExpanded(folderId: string): void {
		const next = new Set(expandedFolderIds);
		if (next.has(folderId)) {
			next.delete(folderId);
		} else {
			next.add(folderId);
		}
		expandedFolderIds = next;
	}

	function isFolderExpanded(folderId: string): boolean {
		return !mobile || expandedFolderIds.has(folderId);
	}

	function shouldRenderGroupMembers(item: SavedServerRailItem): boolean {
		return item.kind !== 'folder' || isFolderExpanded(item.folder.id);
	}

	function avatarText(server: SavedServerView): string {
		return server.effectiveName.charAt(0).toUpperCase();
	}

	function getServerFollowUnreadCount(serverUrl: string): number {
		return $followUnreadCountsByServer[serverUrl] || 0;
	}

	function cancelMobileMove(): void {
		stopMobileAutoScroll();
		mobileMove = null;
		mobileDragState = null;
		mobileDropPreview = null;
	}

	function endMobileDragSession(): void {
		stopMobileAutoScroll();
		mobileDragState = null;
		mobileDropPreview = null;
	}

	function handleFolderHeaderTap(folderId: string): void {
		if (shouldSuppressMobileTap()) {
			return;
		}
		toggleFolderExpanded(folderId);
	}

	function beginMobileDragFromTouch(event?: TouchEvent): void {
		const touch = event?.touches?.[0] || event?.changedTouches?.[0];
		if (!touch) {
			endMobileDragSession();
			return;
		}
		mobileDragState = {
			x: touch.clientX,
			y: touch.clientY
		};
		mobileDropPreview = resolveMobileDropPreview(touch.clientX, touch.clientY);
	}

	function getRailItemById(itemId: string): SavedServerRailItem | null {
		return $savedServerRailItems.find((item) => item.id === itemId) || null;
	}

	function stopMobileAutoScroll(): void {
		if (mobileAutoScrollFrame !== null && typeof window !== 'undefined') {
			window.cancelAnimationFrame(mobileAutoScrollFrame);
		}
		mobileAutoScrollFrame = null;
	}

	function getMobileAutoScrollDelta(y: number): number {
		if (!switcherListElement) return 0;
		const rect = switcherListElement.getBoundingClientRect();
		const maxScrollTop = switcherListElement.scrollHeight - switcherListElement.clientHeight;
		if (y <= rect.top && switcherListElement.scrollTop > 0) {
			return -MOBILE_AUTO_SCROLL_MAX_STEP;
		}
		if (y >= rect.bottom && switcherListElement.scrollTop < maxScrollTop) {
			return MOBILE_AUTO_SCROLL_MAX_STEP;
		}

		const fromTop = y - rect.top;
		const fromBottom = rect.bottom - y;
		if (fromTop < MOBILE_AUTO_SCROLL_EDGE_PX && switcherListElement.scrollTop > 0) {
			const strength = (MOBILE_AUTO_SCROLL_EDGE_PX - fromTop) / MOBILE_AUTO_SCROLL_EDGE_PX;
			return -Math.max(6, Math.round(MOBILE_AUTO_SCROLL_MAX_STEP * strength));
		}
		if (fromBottom < MOBILE_AUTO_SCROLL_EDGE_PX && switcherListElement.scrollTop < maxScrollTop) {
			const strength = (MOBILE_AUTO_SCROLL_EDGE_PX - fromBottom) / MOBILE_AUTO_SCROLL_EDGE_PX;
			return Math.max(6, Math.round(MOBILE_AUTO_SCROLL_MAX_STEP * strength));
		}
		return 0;
	}

	function runMobileAutoScroll(): void {
		mobileAutoScrollFrame = null;
		if (!mobile || !mobileDragState || !switcherListElement) return;
		const delta = getMobileAutoScrollDelta(mobileDragState.y);
		if (!delta) return;
		switcherListElement.scrollTop += delta;
		mobileDropPreview = resolveMobileDropPreview(mobileDragState.x, mobileDragState.y);
		if (typeof window !== 'undefined') {
			mobileAutoScrollFrame = window.requestAnimationFrame(runMobileAutoScroll);
		}
	}

	function syncMobileAutoScroll(y: number): void {
		const delta = getMobileAutoScrollDelta(y);
		if (!delta) {
			stopMobileAutoScroll();
			return;
		}
		if (mobileAutoScrollFrame === null && typeof window !== 'undefined') {
			mobileAutoScrollFrame = window.requestAnimationFrame(runMobileAutoScroll);
		}
	}

	function resolveMobileDropPreview(x: number, y: number): MobileDropPreview {
		if (!mobile || !mobileMove || typeof document === 'undefined') return null;
		const touchedElement = document.elementFromPoint(x, y) as HTMLElement | null;
		if (!touchedElement) return null;

		if (mobileMove.kind === 'folder') {
			const folderGroup = touchedElement.closest<HTMLElement>('[data-drop-group-id]');
			const itemId = folderGroup?.dataset.dropGroupId?.trim() || '';
			if (!folderGroup || !itemId || itemId === mobileMove.itemId) {
				return null;
			}
			const rect = folderGroup.getBoundingClientRect();
			return {
				kind: 'group-position',
				itemId,
				position: y < rect.top + rect.height / 2 ? 'before' : 'after'
			};
		}

		const rowElement = touchedElement.closest<HTMLElement>('[data-drop-row-url]');
		if (rowElement) {
			const serverUrl = rowElement.dataset.dropRowUrl?.trim() || '';
			const itemId = rowElement.dataset.dropRowItemId?.trim() || '';
			const itemKind = rowElement.dataset.dropRowItemKind === 'folder' ? 'folder' : 'server';
			if (serverUrl && itemId && serverUrl !== mobileMove.serverUrl) {
				const rect = rowElement.getBoundingClientRect();
				const localY = y - rect.top;
				if (itemKind === 'server' && localY > rect.height * 0.28 && localY < rect.height * 0.72) {
					return {
						kind: 'make-folder',
						serverUrl
					};
				}
				return {
					kind: 'row-position',
					serverUrl,
					itemId,
					position: localY < rect.height / 2 ? 'before' : 'after'
				};
			}
		}

		const groupElement = touchedElement.closest<HTMLElement>('[data-drop-group-id]');
		const itemId = groupElement?.dataset.dropGroupId?.trim() || '';
		const groupKind = groupElement?.dataset.dropGroupKind === 'folder' ? 'folder' : 'server';
		const folderId = groupElement?.dataset.dropGroupFolderId?.trim() || null;
		const groupServerUrl = groupElement?.dataset.dropGroupServerUrl?.trim() || '';
		if (!groupElement || !itemId) {
			return null;
		}
		if (groupKind === 'server' && groupServerUrl === mobileMove.serverUrl) {
			return null;
		}

		const rect = groupElement.getBoundingClientRect();
		const localY = y - rect.top;
		if (groupKind === 'folder') {
			const upperBand = rect.height * 0.24;
			const lowerBand = rect.height * 0.76;
			if (localY < upperBand) {
				return {
					kind: 'group-position',
					itemId,
					position: 'before'
				};
			}
			if (localY > lowerBand) {
				return {
					kind: 'group-position',
					itemId,
					position: 'after'
				};
			}
			if (folderId && folderId !== mobileMove.sourceFolderId) {
				return {
					kind: 'join-folder',
					itemId
				};
			}
			return null;
		}

		return {
			kind: 'group-position',
			itemId,
			position: localY < rect.height / 2 ? 'before' : 'after'
		};
	}

	function applyMobileDropPreview(preview: Exclude<MobileDropPreview, null>): void {
		if (!mobileMove) return;
		if (preview.kind === 'group-position') {
			const item = getRailItemById(preview.itemId);
			if (!item) return;
			if (mobileMove.kind === 'folder') {
				moveMobileFolder(item, preview.position);
				return;
			}
			moveMobileServerAroundGroup(item, preview.position);
			return;
		}

		if (preview.kind === 'join-folder') {
			const item = getRailItemById(preview.itemId);
			if (item?.kind === 'folder') {
				joinMobileServerToFolder(item);
			}
			return;
		}

		if (preview.kind === 'make-folder') {
			createMobileServerFolder(preview.serverUrl);
			return;
		}

		const item = getRailItemById(preview.itemId);
		const server = item ? groupMembers(item).find((member) => member.url === preview.serverUrl) || null : null;
		if (item && server) {
			moveMobileServerRelativeToServer(server, item, preview.position);
		}
	}

	function handleGlobalTouchMove(event: TouchEvent): void {
		if (!mobileDragState || !mobileMove) return;
		const touch = event.touches[0] || event.changedTouches[0];
		if (!touch) return;
		event.preventDefault();
		mobileDragState = {
			x: touch.clientX,
			y: touch.clientY
		};
		mobileDropPreview = resolveMobileDropPreview(touch.clientX, touch.clientY);
		syncMobileAutoScroll(touch.clientY);
	}

	function handleGlobalTouchEnd(event: TouchEvent): void {
		if (!mobileDragState || !mobileMove) return;
		armMobileTapSuppression();
		const touch = event.changedTouches[0] || event.touches[0];
		const resolvedPreview =
			(touch ? resolveMobileDropPreview(touch.clientX, touch.clientY) : mobileDropPreview) || mobileDropPreview;
		if (resolvedPreview) {
			applyMobileDropPreview(resolvedPreview);
			return;
		}
		endMobileDragSession();
	}

	function startMobileFolderMove(
		item: Extract<SavedServerRailItem, { kind: 'folder' }>,
		event?: TouchEvent
	): void {
		if (!mobile) return;
		armMobileTapSuppression();
		stopEditing();
		stopEditingFolder();
		expandedFolderIds = new Set([...expandedFolderIds, item.folder.id]);
		mobileMove = {
			kind: 'folder',
			itemId: item.id,
			label: item.folder.effectiveName
		};
		beginMobileDragFromTouch(event);
	}

	function startMobileServerMove(
		server: SavedServerView,
		item: SavedServerRailItem,
		event?: TouchEvent
	): void {
		if (!mobile) return;
		armMobileTapSuppression();
		stopEditing();
		stopEditingFolder();
		if (item.kind === 'folder') {
			expandedFolderIds = new Set([...expandedFolderIds, item.folder.id]);
		}
		mobileMove = {
			kind: 'server',
			serverUrl: server.url,
			label: server.effectiveName,
			sourceFolderId: item.kind === 'folder' ? item.folder.id : null
		};
		beginMobileDragFromTouch(event);
	}

	function moveMobileFolder(item: SavedServerRailItem, position: 'before' | 'after'): void {
		if (mobileMove?.kind !== 'folder' || mobileMove.itemId === item.id) return;
		reorderSavedServerRailItem(mobileMove.itemId, item.id, position);
		cancelMobileMove();
	}

	function moveMobileServerAroundGroup(item: SavedServerRailItem, position: 'before' | 'after'): void {
		if (mobileMove?.kind !== 'server') return;
		const targetUrl = position === 'before' ? item.firstUrl : item.lastUrl;
		reorderSavedServer(mobileMove.serverUrl, targetUrl, position, null);
		cancelMobileMove();
	}

	function moveMobileServerRelativeToServer(
		server: SavedServerView,
		item: SavedServerRailItem,
		position: 'before' | 'after'
	): void {
		if (mobileMove?.kind !== 'server' || mobileMove.serverUrl === server.url) return;
		reorderSavedServer(
			mobileMove.serverUrl,
			server.url,
			position,
			item.kind === 'folder' ? item.folder.id : null
		);
		if (item.kind === 'folder') {
			expandedFolderIds = new Set([...expandedFolderIds, item.folder.id]);
		}
		cancelMobileMove();
	}

	function joinMobileServerToFolder(item: Extract<SavedServerRailItem, { kind: 'folder' }>): void {
		if (mobileMove?.kind !== 'server' || mobileMove.sourceFolderId === item.folder.id) return;
		moveSavedServerToFolder(mobileMove.serverUrl, item.folder.id);
		expandedFolderIds = new Set([...expandedFolderIds, item.folder.id]);
		cancelMobileMove();
	}

	function createMobileServerFolder(targetServerUrl: string): void {
		if (mobileMove?.kind !== 'server' || mobileMove.serverUrl === targetServerUrl) return;
		createSavedServerFolder(mobileMove.serverUrl, targetServerUrl);
		cancelMobileMove();
	}

	function ungroupMovingServer(): void {
		if (mobileMove?.kind !== 'server' || !mobileMove.sourceFolderId) return;
		moveSavedServerToFolder(mobileMove.serverUrl, null);
		cancelMobileMove();
	}

	function isMovingServer(url: string): boolean {
		return mobileMove?.kind === 'server' && mobileMove.serverUrl === url;
	}

	function isMovingFolder(itemId: string): boolean {
		return mobileMove?.kind === 'folder' && mobileMove.itemId === itemId;
	}

	function isGroupPreview(itemId: string, position: 'before' | 'after'): boolean {
		return (
			mobileDropPreview?.kind === 'group-position' &&
			mobileDropPreview.itemId === itemId &&
			mobileDropPreview.position === position
		);
	}

	function isJoinFolderPreview(itemId: string): boolean {
		return mobileDropPreview?.kind === 'join-folder' && mobileDropPreview.itemId === itemId;
	}

	function isRowPreview(serverUrl: string, position: 'before' | 'after'): boolean {
		return (
			mobileDropPreview?.kind === 'row-position' &&
			mobileDropPreview.serverUrl === serverUrl &&
			mobileDropPreview.position === position
		);
	}

	function isMakeFolderPreview(serverUrl: string): boolean {
		return mobileDropPreview?.kind === 'make-folder' && mobileDropPreview.serverUrl === serverUrl;
	}

	$: if (mobile && !mobileFolderStateInitialized) {
		const next = new Set<string>();
		for (const item of $savedServerRailItems) {
			if (item.kind === 'folder' && item.folder.activeMember) {
				next.add(item.folder.id);
			}
		}
		expandedFolderIds = next;
		mobileFolderStateInitialized = true;
	}

	$: showcaseServer = getShowcaseServer($savedServerRailItems, $currentSavedServer);

	onMount(() => {
		if (typeof window === 'undefined') return;
		opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
		// The desktop overlay takes focus so it is announced by name; the phone sheet's focus
		// trap does the same for itself.
		if (!mobile) void tick().then(() => {
			if (panelElement && !panelElement.contains(document.activeElement)) panelElement.focus({ preventScroll: true });
		});
		window.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
		window.addEventListener('touchend', handleGlobalTouchEnd, { passive: false });
		window.addEventListener('touchcancel', handleGlobalTouchEnd, { passive: false });
		return () => {
			stopMobileAutoScroll();
			window.removeEventListener('touchmove', handleGlobalTouchMove);
			window.removeEventListener('touchend', handleGlobalTouchEnd);
			window.removeEventListener('touchcancel', handleGlobalTouchEnd);
		};
	});

	onDestroy(() => {
		if (mobile || typeof document === 'undefined') return;
		// Back to the "Switch server" button (or whatever opened it), unless focus already moved on.
		const active = document.activeElement;
		const leftWithPanel = !active || active === document.body || (panelElement?.contains(active) ?? false);
		if (leftWithPanel && opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
	});
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<section
	class="server-switcher"
	class:mobile
	class:dock-right={dockSide === 'right'}
	style:--switcher-excess={mobile ? null : `${overlayExcess}px`}
>
	{#if mobile}
		<!-- Pointer-only affordance: Esc and the close button cover the keyboard. -->
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="w-scrim switcher-scrim" on:click={close}></div>
	{/if}
	<div
		class="switcher-panel"
		class:w-sheet={mobile}
		role="dialog"
		aria-modal={mobile ? 'true' : undefined}
		aria-labelledby="{kickerId} {titleId}"
		tabindex="-1"
		bind:this={panelElement}
		use:sheetFocus={mobile}
	>
		{#if mobile}<div class="w-sheet__grabber" aria-hidden="true"></div>{/if}
		<header class="switcher-head">
			<div class="switcher-head-row">
				<span class="w-kicker switcher-kicker" id={kickerId}>Saved servers</span>
				<button type="button" class="w-ibtn switcher-close" aria-label="Close saved servers" on:click={close}>
					<Icon name="x" />
				</button>
			</div>
			<h2 class="switcher-current" id={titleId}>{showcaseServer?.effectiveName || 'No server yet'}</h2>
			{#if showcaseServer}
				<p class="switcher-host w-mono" title={showcaseServer.url}>{serverHostLabel(showcaseServer.url)}</p>
			{/if}
			<p class="switcher-note">Each server keeps its own account.</p>
			<HostLink />
		</header>

		<div class="switcher-body">
			{#if mobile && mobileMove}
				<div class="w-notice w-notice--info switcher-move" role="status">
					<Icon name="grip" size={16} />
					<p class="w-notice__title">Moving {mobileMove.label}</p>
					<p class="w-notice__text">
						{#if mobileDragState}
							Release over another server or folder to drop it there.
						{:else if mobileMove.kind === 'folder'}
							Drag over another server group, or use Before and After below.
						{:else}
							Drag over a server or folder, or use the buttons below.
						{/if}
					</p>
					<div class="w-notice__actions">
						{#if mobileMove.kind === 'server' && mobileMove.sourceFolderId}
							<button type="button" class="w-btn w-btn--sm" on:click={ungroupMovingServer}>Take out</button>
						{/if}
						<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={cancelMobileMove}>Cancel</button>
					</div>
				</div>
			{/if}

			<div class="switcher-list" bind:this={switcherListElement}>
				{#each $savedServerRailItems as item (item.id)}
					<div
						class="switcher-group"
						class:in-folder={item.kind === 'folder'}
						class:move-selected={isMovingFolder(item.id)}
						class:drop-before={mobile && isGroupPreview(item.id, 'before')}
						class:drop-after={mobile && isGroupPreview(item.id, 'after')}
						class:drop-join={mobile && isJoinFolderPreview(item.id)}
						data-drop-group-id={mobile ? item.id : undefined}
						data-drop-group-kind={mobile ? item.kind : undefined}
						data-drop-group-folder-id={mobile && item.kind === 'folder' ? item.folder.id : undefined}
						data-drop-group-server-url={mobile && item.kind === 'server' ? item.server.url : undefined}
					>
						{#if item.kind === 'folder'}
							<div class="switcher-folder">
								{#if mobile}
									<button
										type="button"
										class="switcher-folder-toggle"
										aria-expanded={isFolderExpanded(item.folder.id)}
										use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileFolderMove(item, event) }}
										on:click={() => handleFolderHeaderTap(item.folder.id)}
									>
										<Icon name="chevRight" size={14} class="switcher-folder-chev" />
										<span class="switcher-folder-name">{item.folder.effectiveName}</span>
										<span class="w-count">{item.folder.members.length}</span>
									</button>
								{:else}
									<span class="switcher-folder-toggle switcher-folder-toggle--static">
										<Icon name="folder" size={14} class="switcher-folder-chev" />
										<span class="switcher-folder-name">{item.folder.effectiveName}</span>
										<span class="w-count" aria-label={`${item.folder.members.length} saved servers`}>{item.folder.members.length}</span>
									</span>
								{/if}
								<Menu
									items={folderMenuItems(item)}
									label={`Folder ${item.folder.effectiveName}`}
									triggerLabel={`More for folder ${item.folder.effectiveName}`}
									class="w-ibtn w-ibtn--sm switcher-more"
									align="end"
									heading={item.folder.effectiveName}
								>
									<Icon name="more" size={16} />
								</Menu>
							</div>
							{#if editingFolderId === item.folder.id}
								<div class="switcher-editor">
									<label class="w-label" for={`folder-name-${item.folder.id}`}>Folder name on this device</label>
									<input
										id={`folder-name-${item.folder.id}`}
										class="w-field w-field--chrome"
										type="text"
										bind:value={folderNameDraft}
										placeholder="e.g. Neighbourhood"
										on:keydown={(event) => editorKeydown(event, () => saveFolderName(item.folder.id), stopEditingFolder)}
									/>
									<div class="switcher-editor-actions">
										<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={stopEditingFolder}>Cancel</button>
										<button type="button" class="w-btn w-btn--primary w-btn--sm" on:click={() => saveFolderName(item.folder.id)}>Save</button>
									</div>
								</div>
							{/if}
						{/if}

						{#if mobile && mobileMove && !mobileDragState}
							<div class="switcher-move-targets">
								{#if mobileMove.kind === 'folder'}
									<button type="button" class="w-btn w-btn--sm" disabled={mobileMove.itemId === item.id} on:click={() => moveMobileFolder(item, 'before')}>Before</button>
									<button type="button" class="w-btn w-btn--sm" disabled={mobileMove.itemId === item.id} on:click={() => moveMobileFolder(item, 'after')}>After</button>
								{:else}
									<button type="button" class="w-btn w-btn--sm" disabled={item.kind === 'server' && item.server.url === mobileMove.serverUrl} on:click={() => moveMobileServerAroundGroup(item, 'before')}>Before group</button>
									<button type="button" class="w-btn w-btn--sm" disabled={item.kind === 'server' && item.server.url === mobileMove.serverUrl} on:click={() => moveMobileServerAroundGroup(item, 'after')}>After group</button>
									{#if item.kind === 'folder' && mobileMove.sourceFolderId !== item.folder.id}
										<button type="button" class="w-btn w-btn--sm" on:click={() => joinMobileServerToFolder(item)}>Join folder</button>
									{/if}
								{/if}
							</div>
						{/if}

						{#if shouldRenderGroupMembers(item)}
							<div class="switcher-rows">
								{#each groupMembers(item) as server (server.url)}
									{@const unread = getServerFollowUnreadCount(server.url)}
									<div
										class="switcher-row"
										class:active={server.isActive}
										class:editing={editingUrl === server.url}
										class:move-selected={isMovingServer(server.url)}
										class:drop-before={mobile && isRowPreview(server.url, 'before')}
										class:drop-after={mobile && isRowPreview(server.url, 'after')}
										class:drop-make-folder={mobile && isMakeFolderPreview(server.url)}
										data-drop-row-url={mobile ? server.url : undefined}
										data-drop-row-item-id={mobile ? item.id : undefined}
										data-drop-row-item-kind={mobile ? item.kind : undefined}
									>
										<button
											type="button"
											class="switcher-row-main"
											aria-current={server.isActive ? 'page' : undefined}
											aria-label={[server.effectiveName, serverHostLabel(server.url), server.isActive ? 'current server' : '', serverUnreadLabel(unread)].filter(Boolean).join(', ')}
											title={getServerTitle(server)}
											on:click={() => handleServerRowSelect(server)}
										>
											<span
												class="switcher-avatar"
												use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileServerMove(server, item, event) }}
											>
												{#if canRenderServerImage(server.effectiveIconUrl, brokenImageUrls)}
													<img
														src={server.effectiveIconUrl}
														alt=""
														on:error={() => markImageBroken(server.effectiveIconUrl)}
													/>
												{:else if server.useNeutralBranding}
													<span class="switcher-initial" aria-hidden="true">{avatarText(server)}</span>
												{:else}
													<span class="switcher-enso" aria-hidden="true"></span>
												{/if}
											</span>
											<span class="switcher-row-text">
												<span class="switcher-row-name">{server.effectiveName}</span>
												<span class="switcher-row-host">{serverHostLabel(server.url)}</span>
											</span>
											{#if unread > 0}
												<span class="w-badge w-badge--sm switcher-row-badge" aria-hidden="true">{serverUnreadBadge(unread)}</span>
											{/if}
										</button>
										<span class="switcher-row-tray">
											<Menu
												items={rowMenuItems(server, item)}
												label={`Actions for ${server.effectiveName}`}
												triggerLabel={`More for ${server.effectiveName}`}
												class="w-ibtn w-ibtn--sm switcher-more"
												align="end"
												heading={server.effectiveName}
												subheading={serverHostLabel(server.url)}
											>
												<Icon name="more" size={16} />
											</Menu>
										</span>

										{#if editingUrl === server.url}
											<div class="switcher-editor">
												<label class="w-label" for={`alias-${uid}-${server.url}`}>Name on this device</label>
												<input
													id={`alias-${uid}-${server.url}`}
													class="w-field w-field--chrome"
													type="text"
													bind:value={aliasDraft}
													placeholder={server.frontendMetadata?.displayName || server.launchPageBranding?.brandName || serverHostLabel(server.url)}
													on:keydown={(event) => editorKeydown(event, () => saveAlias(server.url), stopEditing)}
												/>
												<label class="switcher-check">
													<input
														type="checkbox"
														class="w-check"
														checked={server.useNeutralBranding === true}
														on:change={(event) =>
															setUseNeutralBranding(
																server.url,
																(event.currentTarget as HTMLInputElement).checked
															)}
													/>
													<span>Hide Wabi branding at start-up and sign-in</span>
												</label>
												<div class="switcher-editor-actions">
													<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={stopEditing}>Cancel</button>
													<button type="button" class="w-btn w-btn--primary w-btn--sm" on:click={() => saveAlias(server.url)}>Save name</button>
												</div>
											</div>
										{/if}

										{#if mobile && mobileMove?.kind === 'server' && !mobileDragState}
											<div class="switcher-move-targets switcher-move-targets--row">
												{#if isMovingServer(server.url)}
													<span class="w-tag">Moving</span>
												{:else}
													<button type="button" class="w-btn w-btn--sm" on:click={() => moveMobileServerRelativeToServer(server, item, 'before')}>Before</button>
													<button type="button" class="w-btn w-btn--sm" on:click={() => moveMobileServerRelativeToServer(server, item, 'after')}>After</button>
													{#if item.kind === 'server'}
														<button type="button" class="w-btn w-btn--sm" on:click={() => createMobileServerFolder(server.url)}>Make folder</button>
													{/if}
												{/if}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<div class="w-empty switcher-empty">
						<Icon name="server" />
						<p class="w-empty__title">No saved servers yet</p>
						<p class="w-empty__text">Servers you sign in to are saved on this device and appear here.</p>
					</div>
				{/each}
			</div>

			<div class="switcher-shortcuts">
				<button
					type="button"
					class="w-disclosure switcher-shortcuts-toggle"
					aria-expanded={utilityPanelExpanded}
					aria-controls={shortcutsId}
					on:click={() => (utilityPanelExpanded = !utilityPanelExpanded)}
				>
					<Icon name="chevRight" size={16} />
					<span>Shortcuts</span>
					<span class="switcher-shortcuts-hint">Recent and followed</span>
				</button>
				{#if utilityPanelExpanded}
					<div class="w-disclosure__body switcher-shortcuts-body" id={shortcutsId}>
						<ModeTabsDrawer embedded />
					</div>
				{/if}
			</div>
		</div>

		<footer class="switcher-foot" class:expanded={addServerExpanded} bind:this={addServerPanel}>
			{#if addServerExpanded}
				<form class="switcher-add" on:submit|preventDefault={handleOpenManualServer}>
					<label class="w-label" for={addInputId}>Open another server</label>
					<input
						id={addInputId}
						class="w-field w-field--chrome"
						type="text"
						inputmode="url"
						autocomplete="url"
						spellcheck="false"
						bind:this={addServerInput}
						bind:value={manualServerUrl}
						placeholder="{brandConfig.domain} or https://staging.example.com"
						on:keydown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								event.stopPropagation();
								void closeAddServerPanel();
							}
						}}
					/>
					<p class="switcher-add-hint">It gets its own sign-in; nothing is shared between servers.</p>
					<div class="switcher-editor-actions">
						<button type="button" class="w-btn w-btn--quiet" on:click={() => void closeAddServerPanel()}>Cancel</button>
						<button type="submit" class="w-btn w-btn--primary" disabled={!manualServerUrl.trim()}>Open server</button>
					</div>
				</form>
			{:else}
				<button type="button" class="w-btn switcher-add-btn" aria-expanded="false" bind:this={addServerButton} on:click={() => void openAddServerPanel()}>
					<Icon name="plus" size={16} />Add server
				</button>
			{/if}
		</footer>
	</div>

	{#if mobile && mobileMove && mobileDragState}
		<div
			class="switcher-drag-ghost"
			style:--drag-x={`${mobileDragState.x}px`}
			style:--drag-y={`${mobileDragState.y}px`}
		>
			<span class="w-kicker">{mobileMove.kind === 'folder' ? 'Folder' : 'Server'}</span>
			<strong>{mobileMove.label}</strong>
		</div>
	{/if}
</section>
