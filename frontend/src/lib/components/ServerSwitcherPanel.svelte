<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
	import { followUnreadCountsByServer } from '$lib/followingSnapshots';
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
			<div class="switcher-eyebrow">Server Switcher</div>
			<h2>{showcaseServer?.effectiveName || 'Saved servers'}</h2>
			<p>{getShowcaseDescription(showcaseServer)}</p>
		</div>

		<button type="button" class="switcher-close" aria-label="Close server switcher" on:click={() => dispatch('close')}>x</button>
	</div>

	<div class="switcher-body">
		<div class="switcher-intro">
			<label class="switcher-input-group">
				<span>Open another server</span>
				<input
					type="text"
					bind:value={manualServerUrl}
					placeholder="wabi.chat or https://staging.example.com"
					on:keydown={(event) => event.key === 'Enter' && handleOpenManualServer()}
				/>
			</label>
			<button type="button" class="switcher-primary" on:click={handleOpenManualServer}>Open</button>
		</div>

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
											{#if server.isActive}
												<span class="switcher-badge">Active</span>
											{/if}
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

<style>
	.server-switcher {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--accent) 4%, var(--bg-tertiary)), var(--bg-tertiary)),
			var(--bg-tertiary);
		backdrop-filter: blur(14px);
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		z-index: calc(var(--z-modal, 1200) - 1);
	}

	.server-switcher > * {
		position: relative;
		z-index: 1;
	}

	.server-switcher.dock-right {
		border-right: none;
		border-left: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	.server-switcher.mobile {
		position: fixed;
		z-index: var(--z-modal, 1200);
	}

	.switcher-showcase {
		position: relative;
		min-height: 150px;
		padding: 1.05rem 1.05rem 0.9rem;
		border-bottom: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		background:
			linear-gradient(180deg, rgba(4, 8, 14, 0.08), rgba(4, 8, 14, 0.28)),
			linear-gradient(135deg, color-mix(in srgb, var(--showcase-accent) 18%, rgba(255, 255, 255, 0.04)), rgba(255, 255, 255, 0.01));
		overflow: hidden;
	}

	.switcher-showcase::after {
		content: '';
		position: absolute;
		inset: auto -9% -34% auto;
		width: 240px;
		height: 240px;
		border-radius: 50%;
		background: radial-gradient(circle, color-mix(in srgb, var(--showcase-accent) 34%, transparent), transparent 70%);
		filter: blur(24px);
		pointer-events: none;
	}

	.switcher-showcase-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0.32;
	}

	.switcher-showcase-copy {
		position: relative;
		z-index: 1;
		max-width: 520px;
		display: grid;
		gap: 0.35rem;
		padding-right: 2.7rem;
	}

	.switcher-eyebrow {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.74);
	}

	.switcher-showcase-copy h2 {
		margin: 0;
		font-size: 1.35rem;
		color: #f8fafc;
	}

	.switcher-showcase-copy p {
		margin: 0;
		color: rgba(255, 255, 255, 0.8);
		line-height: 1.45;
	}

	.switcher-close {
		position: absolute;
		top: 0.95rem;
		right: 0.95rem;
		width: 34px;
		height: 34px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 10px;
		background: rgba(3, 7, 18, 0.42);
		color: #f8fafc;
		cursor: pointer;
		z-index: 2;
	}

	.server-switcher.dock-right .switcher-close {
		right: auto;
		left: 0.95rem;
	}

	.switcher-close:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.switcher-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
		padding: 0.9rem 0.9rem 1rem;
		overflow: hidden;
	}

	.switcher-intro {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.65rem;
		align-items: end;
	}

	.switcher-move-banner {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.8rem 0.9rem;
		border-radius: 16px;
		border: 1px solid rgba(125, 211, 252, 0.24);
		background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(45, 212, 191, 0.12));
	}

	.switcher-move-banner-copy {
		display: grid;
		gap: 0.18rem;
	}

	.switcher-move-banner-copy strong {
		font-size: 0.9rem;
		color: #f8fafc;
	}

	.switcher-move-banner-copy span {
		font-size: 0.74rem;
		color: rgba(255, 255, 255, 0.72);
	}

	.switcher-move-banner-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.switcher-input-group {
		display: grid;
		gap: 0.35rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.switcher-input-group input,
	.switcher-alias-editor input {
		height: 40px;
		border: 1px solid rgba(var(--border-rgb), 0.58);
		border-radius: 10px;
		padding: 0 0.8rem;
		background: color-mix(in srgb, var(--bg-secondary) 86%, transparent);
		color: var(--text-primary);
	}

	.switcher-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: grid;
		gap: 0.5rem;
		padding-right: 0.15rem;
	}

	.switcher-group {
		position: relative;
		display: grid;
		gap: 0.35rem;
	}

	.switcher-group + .switcher-group {
		padding-top: 0.55rem;
		border-top: 1px solid rgba(var(--border-rgb), 0.42);
	}

	.switcher-group.move-selected,
	.switcher-group.drop-before,
	.switcher-group.drop-after,
	.switcher-group.drop-join {
		padding-inline: 0.45rem;
		padding-block: 0.55rem 0.45rem;
		border-radius: 16px;
	}

	.switcher-group.move-selected {
		background: rgba(56, 189, 248, 0.06);
		box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.18);
	}

	.switcher-group.drop-before {
		box-shadow:
			inset 0 4px 0 rgba(125, 211, 252, 0.9),
			inset 0 0 0 1px rgba(125, 211, 252, 0.18);
	}

	.switcher-group.drop-after {
		box-shadow:
			inset 0 -4px 0 rgba(125, 211, 252, 0.9),
			inset 0 0 0 1px rgba(125, 211, 252, 0.18);
	}

	.switcher-group.drop-join {
		background: rgba(45, 212, 191, 0.08);
		box-shadow: inset 0 0 0 1px rgba(45, 212, 191, 0.2);
	}

	.switcher-folder-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		padding-inline: 0.15rem;
	}

	.server-switcher.dock-right .switcher-folder-header {
		flex-direction: row-reverse;
	}

	.switcher-folder-heading {
		min-width: 0;
		display: grid;
		gap: 0.5rem;
	}

	.switcher-folder-toggle {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.server-switcher.dock-right .switcher-folder-toggle {
		flex-direction: row-reverse;
		text-align: right;
	}

	.switcher-folder-toggle-icon {
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 10px;
		border: 1px solid rgba(var(--border-rgb), 0.5);
		background: color-mix(in srgb, var(--group-accent) 18%, rgba(255, 255, 255, 0.03));
		color: var(--text-secondary);
	}

	.switcher-folder-toggle-icon svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 0.2s ease;
	}

	.switcher-folder-toggle-icon.expanded svg {
		transform: rotate(180deg);
	}

	.switcher-folder-copy {
		min-width: 0;
		display: grid;
		gap: 0.15rem;
	}

	.server-switcher.dock-right .switcher-folder-copy {
		justify-items: end;
	}

	.switcher-folder-header strong {
		display: block;
		font-size: 0.88rem;
		color: var(--text-primary);
	}

	.switcher-folder-copy > span {
		font-size: 0.72rem;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.switcher-folder-actions,
	.switcher-folder-editor {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		align-items: center;
	}

	.switcher-folder-editor input {
		height: 38px;
		border: 1px solid rgba(var(--border-rgb), 0.58);
		border-radius: 10px;
		padding: 0 0.8rem;
		background: color-mix(in srgb, var(--bg-secondary) 86%, transparent);
		color: var(--text-primary);
	}

	.switcher-move-targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.switcher-group-members {
		display: grid;
		gap: 0.32rem;
	}

	.switcher-group-members.folder-members {
		padding-left: 0.95rem;
		margin-left: 0.55rem;
		border-left: 1px solid rgba(var(--border-rgb), 0.38);
	}

	.server-switcher.dock-right .switcher-group-members.folder-members {
		padding-left: 0;
		margin-left: 0;
		padding-right: 0.95rem;
		margin-right: 0.55rem;
		border-left: none;
		border-right: 1px solid rgba(var(--border-rgb), 0.38);
	}

	.switcher-row {
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.58rem;
		padding: 0.38rem 0.62rem;
		border: 1px solid rgba(var(--border-rgb), 0.42);
		border-radius: 10px;
		align-items: center;
		cursor: pointer;
		background:
			linear-gradient(90deg, rgba(7, 11, 19, 0.9), rgba(7, 11, 19, 0.72) 46%, rgba(7, 11, 19, 0.84)),
			var(--row-banner-image, none);
		background-position: center;
		background-repeat: no-repeat;
		background-size: cover;
		overflow: hidden;
		transition:
			border-color 0.18s ease,
			background-color 0.18s ease,
			transform 0.18s ease;
	}

	.switcher-row::before {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg, rgba(255, 255, 255, 0.06), transparent 44%);
		pointer-events: none;
	}

	.server-switcher.dock-right .switcher-row::before {
		background: linear-gradient(270deg, rgba(255, 255, 255, 0.06), transparent 44%);
	}

	.switcher-row > * {
		position: relative;
		z-index: 1;
	}

	.switcher-row.active,
	.switcher-row[aria-current='page'] {
		border-color: color-mix(in srgb, var(--row-accent) 28%, rgba(var(--border-rgb), 0.48));
		background-color: rgba(255, 255, 255, 0.02);
	}

	.switcher-row.move-selected {
		border-color: rgba(125, 211, 252, 0.36);
		box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.16);
	}

	.switcher-row.drop-before {
		box-shadow: inset 0 4px 0 rgba(125, 211, 252, 0.95);
	}

	.switcher-row.drop-after {
		box-shadow: inset 0 -4px 0 rgba(125, 211, 252, 0.95);
	}

	.switcher-row.drop-make-folder {
		border-color: rgba(244, 114, 182, 0.34);
		box-shadow: 0 0 0 1px rgba(244, 114, 182, 0.12);
	}

	.switcher-row.active::after,
	.switcher-row[aria-current='page']::after {
		content: '';
		position: absolute;
		inset-block: 5px;
		inset-inline-start: 0;
		width: 2px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--row-accent) 68%, white);
		pointer-events: none;
	}

	.server-switcher.dock-right .switcher-row.active::after,
	.server-switcher.dock-right .switcher-row[aria-current='page']::after {
		inset-inline-start: auto;
		inset-inline-end: 0;
	}

	.switcher-row:hover {
		border-color: color-mix(in srgb, var(--row-accent) 18%, rgba(var(--border-rgb), 0.52));
		transform: translateY(-1px);
	}

	.switcher-avatar {
		width: 34px;
		height: 34px;
		border-radius: 999px;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: color-mix(in srgb, var(--row-accent) 22%, rgba(255, 255, 255, 0.08));
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		color: #fff;
	}

	.switcher-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.switcher-meta {
		min-width: 0;
		display: grid;
		gap: 0.12rem;
		align-content: start;
	}

	.server-switcher.dock-right .switcher-meta {
		text-align: right;
	}

	.switcher-title-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.28rem;
		align-items: center;
	}

	.server-switcher.dock-right .switcher-title-row {
		justify-content: flex-end;
	}

	.switcher-name-btn {
		padding: 0;
		border: 0;
		background: transparent;
		font-size: 0.88rem;
		color: var(--text-primary);
		font-weight: 700;
		text-align: inherit;
		cursor: pointer;
	}

	.switcher-name-btn:hover {
		color: color-mix(in srgb, var(--row-accent) 52%, white);
	}

	.switcher-detail-line {
		font-size: 0.76rem;
		color: var(--text-secondary);
		word-break: break-word;
	}

	.switcher-badge {
		font-size: 0.58rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding: 0.1rem 0.3rem;
		border-radius: 999px;
		background: rgba(45, 212, 191, 0.18);
		color: #bffdf2;
		border: 1px solid rgba(45, 212, 191, 0.22);
	}

	.switcher-badge--follow-unread {
		background: rgba(239, 68, 68, 0.14);
		border-color: rgba(239, 68, 68, 0.24);
		color: #fecaca;
	}

	.switcher-side-actions,
	.switcher-alias-editor {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		align-items: center;
	}

	.switcher-side-actions {
		align-self: center;
		justify-content: flex-end;
		opacity: 0.72;
		transition: opacity 0.18s ease;
	}

	.switcher-row:hover .switcher-side-actions,
	.switcher-row:focus-within .switcher-side-actions,
	.switcher-row.active .switcher-side-actions,
	.switcher-row[aria-current='page'] .switcher-side-actions {
		opacity: 1;
	}

	.switcher-side-bubble {
		min-width: 30px;
		height: 30px;
		padding: 0 0.38rem;
		border-radius: 8px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
	}

	.switcher-side-bubble:hover {
		border-color: rgba(var(--border-rgb), 0.38);
		background: rgba(255, 255, 255, 0.06);
		color: var(--text-primary);
	}

	.switcher-side-bubble svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.switcher-remove-bubble {
		width: 30px;
		padding: 0;
		color: #fda4af;
	}

	.switcher-remove-bubble:hover {
		background: rgba(127, 29, 29, 0.2);
		border-color: rgba(248, 113, 113, 0.24);
	}

	.switcher-row-move-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		padding-top: 0.15rem;
	}

	.switcher-move-pill {
		display: inline-flex;
		align-items: center;
		height: 34px;
		padding: 0 0.75rem;
		border-radius: 999px;
		border: 1px solid rgba(125, 211, 252, 0.28);
		background: rgba(56, 189, 248, 0.14);
		color: #dbeafe;
		font-size: 0.76rem;
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.switcher-drag-ghost {
		position: fixed;
		left: 0;
		top: 0;
		transform: translate(calc(var(--drag-x) - 50%), calc(var(--drag-y) - 62%));
		display: grid;
		gap: 0.22rem;
		min-width: 132px;
		max-width: 220px;
		padding: 0.7rem 0.85rem;
		border-radius: 16px;
		border: 1px solid rgba(125, 211, 252, 0.28);
		background: rgba(7, 10, 18, 0.92);
		box-shadow: 0 18px 36px rgba(2, 6, 23, 0.34);
		backdrop-filter: blur(12px);
		pointer-events: none;
		z-index: calc(var(--z-modal, 1200) + 8);
	}

	.switcher-drag-ghost strong {
		font-size: 0.84rem;
		color: #f8fafc;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.switcher-drag-ghost-tag {
		font-size: 0.64rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #bae6fd;
	}

	.switcher-primary,
	.switcher-secondary,
	.switcher-tertiary {
		height: 38px;
		border-radius: 12px;
		padding: 0 0.85rem;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(255, 255, 255, 0.06);
		color: var(--text-primary);
		cursor: pointer;
		font-weight: 600;
	}

	.switcher-primary {
		background: linear-gradient(135deg, rgba(45, 212, 191, 0.3), rgba(59, 130, 246, 0.24));
		border-color: rgba(45, 212, 191, 0.28);
	}

	.switcher-primary:disabled,
	.switcher-secondary:disabled,
	.switcher-tertiary:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.switcher-empty {
		padding: 1rem;
		border: 1px dashed rgba(255, 255, 255, 0.12);
		border-radius: 18px;
		color: var(--text-secondary);
		text-align: center;
	}

	@media (max-width: 768px) {
		.switcher-intro,
		.switcher-row {
			grid-template-columns: 1fr;
		}

		.switcher-move-banner {
			align-items: stretch;
		}

		.switcher-move-banner-actions {
			justify-content: flex-start;
		}

		.switcher-side-actions {
			justify-content: flex-start;
		}
	}
</style>
