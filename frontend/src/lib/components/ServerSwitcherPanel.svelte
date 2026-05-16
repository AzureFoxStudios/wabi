<script lang="ts">
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
	import { followUnreadCountsByServer } from '$lib/followingSnapshots';
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
	let utilityPanelExpanded = true;
	let addServerExpanded = false;
	let addServerInput: HTMLInputElement | null = null;
	let addServerPanel: HTMLDivElement | null = null;

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

	function removeServer(url: string): void {
		removeSavedServer(url);
		if (editingUrl === url) {
			stopEditing();
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
		addServerPanel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		addServerInput?.focus();
	}

	function canRenderServerImage(url: string | null | undefined): boolean {
		return Boolean(url && !brokenImageUrls.has(url));
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

	function serverAccent(server: SavedServerView): string {
		return server.effectiveAccentColor || '#2dd4bf';
	}

	function serverBannerImage(server: SavedServerView): string {
		return canRenderServerImage(server.effectiveBannerUrl)
			? `url('${server.effectiveBannerUrl}')`
			: 'none';
	}

	function groupAccent(item: SavedServerRailItem): string {
		if (item.kind === 'folder') {
			return item.folder.effectiveAccentColor || '#2dd4bf';
		}
		return serverAccent(item.server);
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

	function getShowcaseDescription(server: SavedServerView | null): string {
		if (!server) {
			return 'Switch networks, edit local aliases, and manage multi-server folders from one panel.';
		}
		return server.effectiveDescription || server.url;
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
</script>

<section
	class="server-switcher"
	class:mobile
	class:dock-right={dockSide === 'right'}
>
	<div
		class="switcher-showcase"
		style:--showcase-accent={showcaseServer?.effectiveAccentColor || '#2dd4bf'}
	>
		{#if canRenderServerImage(showcaseServer?.effectiveBannerUrl)}
			<img
				class="switcher-showcase-image"
				src={showcaseServer?.effectiveBannerUrl}
				alt={showcaseServer?.effectiveName || 'Saved server banner'}
				on:error={() => markImageBroken(showcaseServer?.effectiveBannerUrl)}
			/>
		{/if}

		<div class="switcher-showcase-copy">
			<div class="switcher-eyebrow">Servers</div>
			<h2>{showcaseServer?.effectiveName || 'Saved servers'}</h2>
			<p>{getShowcaseDescription(showcaseServer)}</p>
		</div>

		<button type="button" class="switcher-close" aria-label="Close server switcher" on:click={() => dispatch('close')}>x</button>
	</div>

	<div class="switcher-body">
		{#if mobile && mobileMove}
			<div class="switcher-move-banner">
				<div class="switcher-move-banner-copy">
					<strong>Moving {mobileMove.label}</strong>
					<span>
						{#if mobileDragState}
							Release over another server or folder to drop.
						{:else if mobileMove.kind === 'folder'}
							Drag across another server group, or use the fallback targets below.
						{:else}
							Drag across a server or folder, or use the fallback targets below.
						{/if}
					</span>
				</div>
				<div class="switcher-move-banner-actions">
					{#if mobileMove.kind === 'server' && mobileMove.sourceFolderId}
						<button type="button" class="switcher-secondary" on:click={ungroupMovingServer}>Take Out</button>
					{/if}
					<button type="button" class="switcher-tertiary" on:click={cancelMobileMove}>Cancel</button>
				</div>
			</div>
		{/if}

		<div class="switcher-utility-panel" class:collapsed={!utilityPanelExpanded}>
			<button
				type="button"
				class="switcher-utility-toggle"
				aria-expanded={utilityPanelExpanded}
				on:click={() => (utilityPanelExpanded = !utilityPanelExpanded)}
			>
				<div class="switcher-utility-toggle-copy">
					<strong>Shortcuts</strong>
				</div>
				<span class="switcher-utility-toggle-icon" class:expanded={utilityPanelExpanded} aria-hidden="true">
					<svg viewBox="0 0 20 20">
						<path d="M6 8l4 4 4-4" />
					</svg>
				</span>
			</button>
			{#if utilityPanelExpanded}
				<ModeTabsDrawer embedded />
			{/if}
		</div>

		<div class="switcher-list" bind:this={switcherListElement}>
			{#each $savedServerRailItems as item (item.id)}
				<div
					class="switcher-group"
					class:move-selected={isMovingFolder(item.id)}
					class:drop-before={mobile && isGroupPreview(item.id, 'before')}
					class:drop-after={mobile && isGroupPreview(item.id, 'after')}
					class:drop-join={mobile && isJoinFolderPreview(item.id)}
					data-drop-group-id={mobile ? item.id : undefined}
					data-drop-group-kind={mobile ? item.kind : undefined}
					data-drop-group-folder-id={mobile && item.kind === 'folder' ? item.folder.id : undefined}
					data-drop-group-server-url={mobile && item.kind === 'server' ? item.server.url : undefined}
					style:--group-accent={groupAccent(item)}
				>
					{#if item.kind === 'folder'}
						<div class="switcher-folder-header">
							<div class="switcher-folder-heading">
								<button
									type="button"
									class="switcher-folder-toggle"
									aria-expanded={isFolderExpanded(item.folder.id)}
									use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileFolderMove(item, event) }}
									on:click={() => handleFolderHeaderTap(item.folder.id)}
								>
									<span class="switcher-folder-toggle-icon" class:expanded={isFolderExpanded(item.folder.id)} aria-hidden="true">
										<svg viewBox="0 0 20 20">
											<path d="M6 8l4 4 4-4" />
										</svg>
									</span>
									<span class="switcher-folder-copy">
										<strong>{item.folder.effectiveName}</strong>
										<span>{item.folder.members.length} saved servers</span>
									</span>
								</button>
								{#if editingFolderId === item.folder.id}
									<div class="switcher-folder-editor">
										<input
											type="text"
											bind:value={folderNameDraft}
											placeholder="Local folder name"
											on:keydown={(event) => {
												if (event.key === 'Enter') saveFolderName(item.folder.id);
												if (event.key === 'Escape') stopEditingFolder();
											}}
										/>
										<button type="button" class="switcher-secondary" on:click={() => saveFolderName(item.folder.id)}>Save</button>
										<button type="button" class="switcher-tertiary" on:click={stopEditingFolder}>Cancel</button>
									</div>
								{/if}
							</div>
							<div class="switcher-folder-actions">
								<button type="button" class="switcher-tertiary" on:click={() => startEditingFolder(item.folder.id, item.folder.name || '')}>Rename</button>
							</div>
						</div>
					{/if}

					{#if mobile && mobileMove && !mobileDragState}
						<div class="switcher-move-targets">
							{#if mobileMove.kind === 'folder'}
								<button
									type="button"
									class="switcher-secondary"
									disabled={mobileMove.itemId === item.id}
									on:click={() => moveMobileFolder(item, 'before')}
								>
									Before
								</button>
								<button
									type="button"
									class="switcher-secondary"
									disabled={mobileMove.itemId === item.id}
									on:click={() => moveMobileFolder(item, 'after')}
								>
									After
								</button>
							{:else}
								<button
									type="button"
									class="switcher-secondary"
									disabled={item.kind === 'server' && item.server.url === mobileMove.serverUrl}
									on:click={() => moveMobileServerAroundGroup(item, 'before')}
								>
									Before Group
								</button>
								<button
									type="button"
									class="switcher-secondary"
									disabled={item.kind === 'server' && item.server.url === mobileMove.serverUrl}
									on:click={() => moveMobileServerAroundGroup(item, 'after')}
								>
									After Group
								</button>
								{#if item.kind === 'folder' && mobileMove.sourceFolderId !== item.folder.id}
									<button type="button" class="switcher-secondary" on:click={() => joinMobileServerToFolder(item)}>
										Join Folder
									</button>
								{/if}
							{/if}
						</div>
					{/if}

					{#if shouldRenderGroupMembers(item)}
						<div class="switcher-group-members" class:folder-members={item.kind === 'folder'}>
							{#each groupMembers(item) as server (server.url)}
								<div
									class="switcher-row"
									class:move-selected={isMovingServer(server.url)}
									class:drop-before={mobile && isRowPreview(server.url, 'before')}
									class:drop-after={mobile && isRowPreview(server.url, 'after')}
									class:drop-make-folder={mobile && isMakeFolderPreview(server.url)}
									class:active={server.isActive}
									data-drop-row-url={mobile ? server.url : undefined}
									data-drop-row-item-id={mobile ? item.id : undefined}
									data-drop-row-item-kind={mobile ? item.kind : undefined}
									style:--row-accent={serverAccent(server)}
									style:--row-banner-image={serverBannerImage(server)}
									role="button"
									tabindex="0"
									aria-current={server.isActive ? 'page' : undefined}
									on:click={() => handleServerRowSelect(server)}
									on:keydown={(event) => handleServerRowKeydown(event, server)}
								>
									<div
										class="switcher-avatar"
										use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileServerMove(server, item, event) }}
									>
										{#if canRenderServerImage(server.effectiveIconUrl)}
											<img
												src={server.effectiveIconUrl}
												alt={server.effectiveName}
												on:error={() => markImageBroken(server.effectiveIconUrl)}
											/>
										{:else}
											<span>{avatarText(server)}</span>
										{/if}
									</div>

									<div class="switcher-meta">
										<div class="switcher-title-row">
											<button
												type="button"
												class="switcher-name-btn"
												title={getServerTitle(server)}
												on:click|stopPropagation={() => startEditing(server)}
											>
												{server.effectiveName}
											</button>
											{#if getServerFollowUnreadCount(server.url) > 0}
												<span class="switcher-badge switcher-badge--follow-unread">
													{getServerFollowUnreadCount(server.url)} unread
												</span>
											{/if}
										</div>
										{#if editingUrl === server.url}
											<div class="switcher-alias-editor">
												<input
													type="text"
													bind:value={aliasDraft}
													placeholder="Local alias for this device"
													on:keydown={(event) => {
														if (event.key === 'Enter') saveAlias(server.url);
														if (event.key === 'Escape') stopEditing();
													}}
												/>
												<button type="button" class="switcher-secondary" on:click={() => saveAlias(server.url)}>Save Alias</button>
												<button type="button" class="switcher-tertiary" on:click={stopEditing}>Cancel</button>
											</div>
										{:else if item.kind === 'folder'}
											<div class="switcher-detail-line">{item.folder.effectiveName}</div>
										{/if}
									</div>

									<div class="switcher-side-actions">
										{#if item.kind === 'folder'}
											<button
												type="button"
												class="switcher-side-bubble"
												title="Take out of folder"
												aria-label={`Take ${server.effectiveName} out of folder`}
												on:click|stopPropagation={() => ungroupServer(server.url)}
											>
												Out
											</button>
										{/if}
										<button
											type="button"
											class="switcher-side-bubble switcher-remove-bubble"
											title="Remove saved server"
											aria-label={`Remove ${server.effectiveName}`}
											on:click|stopPropagation={() => removeServer(server.url)}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true">
												<path d="M14 3h7v7" />
												<path d="M10 14L21 3" />
												<path d="M21 14v7h-7" />
												<path d="M3 10L14 21" />
												<path d="M3 3h7v7H3z" />
											</svg>
										</button>
									</div>

									{#if mobile && mobileMove?.kind === 'server' && !mobileDragState}
										<div class="switcher-row-move-actions">
											{#if isMovingServer(server.url)}
												<span class="switcher-move-pill">Moving</span>
											{:else}
												<button
													type="button"
													class="switcher-secondary"
													on:click={() => moveMobileServerRelativeToServer(server, item, 'before')}
												>
													Before
												</button>
												<button
													type="button"
													class="switcher-secondary"
													on:click={() => moveMobileServerRelativeToServer(server, item, 'after')}
												>
													After
												</button>
												{#if item.kind === 'server'}
													<button
														type="button"
														class="switcher-secondary"
														on:click={() => createMobileServerFolder(server.url)}
													>
														Make Folder
													</button>
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
				<div class="switcher-empty">
					No saved servers yet. Successful connections will appear here automatically.
				</div>
			{/each}
		</div>

		<div class="switcher-add-panel" class:expanded={addServerExpanded} bind:this={addServerPanel}>
			<button
				type="button"
				class="switcher-add-toggle"
				aria-expanded={addServerExpanded}
				on:click={() => {
					if (addServerExpanded) {
						addServerExpanded = false;
						return;
					}
					void openAddServerPanel();
				}}
			>
				<strong>Add server</strong>
				<span class="switcher-add-toggle-icon" class:expanded={addServerExpanded} aria-hidden="true">
					<svg viewBox="0 0 20 20">
						<path d="M10 4v12" />
						<path d="M4 10h12" />
					</svg>
				</span>
			</button>
			{#if addServerExpanded}
				<div class="switcher-intro">
					<label class="switcher-input-group">
						<span>Open another server</span>
						<input
							type="text"
							bind:this={addServerInput}
							bind:value={manualServerUrl}
							placeholder="wabi.chat or https://staging.example.com"
							on:keydown={(event) => event.key === 'Enter' && handleOpenManualServer()}
						/>
					</label>
					<button type="button" class="switcher-primary" on:click={handleOpenManualServer}>Open</button>
				</div>
			{/if}
		</div>
	</div>

	{#if mobile && mobileMove && mobileDragState}
		<div
			class="switcher-drag-ghost"
			style:--drag-x={`${mobileDragState.x}px`}
			style:--drag-y={`${mobileDragState.y}px`}
		>
			<span class="switcher-drag-ghost-tag">{mobileMove.kind === 'folder' ? 'Folder' : 'Server'}</span>
			<strong>{mobileMove.label}</strong>
		</div>
	{/if}
</section>


