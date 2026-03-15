<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
	import { followUnreadCountsByServer } from '$lib/followingSnapshots';
	import {
		createSavedServerFolder,
		currentSavedServer,
		moveSavedServerToFolder,
		openUnsavedServer,
		refreshSavedServer,
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

	function armMobileTapSuppression(): void {
		suppressTapUntil = Date.now() + MOBILE_MOVE_SUPPRESS_MS;
	}

	function shouldSuppressMobileTap(): boolean {
		return mobile && Date.now() < suppressTapUntil;
	}

	function serverAccent(server: SavedServerView): string {
		return server.effectiveAccentColor || '#2dd4bf';
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

	function moveRailItem(itemId: string, direction: 'up' | 'down'): void {
		const index = $savedServerRailItems.findIndex((item) => item.id === itemId);
		if (index === -1) return;
		const target = direction === 'up' ? $savedServerRailItems[index - 1] : $savedServerRailItems[index + 1];
		if (!target) return;
		reorderSavedServerRailItem(itemId, target.id, direction === 'up' ? 'before' : 'after');
	}

	function canMoveRailItem(itemId: string, direction: 'up' | 'down'): boolean {
		const index = $savedServerRailItems.findIndex((item) => item.id === itemId);
		if (index === -1) return false;
		return direction === 'up' ? index > 0 : index < $savedServerRailItems.length - 1;
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

	function quickSwitchServer(server: SavedServerView): void {
		if (shouldSuppressMobileTap()) {
			return;
		}
		if (!server.isActive) {
			switchToSavedServer(server.url);
		}
		if (mobile) {
			dispatch('close');
		}
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

<section class="server-switcher" class:mobile>
	<div
		class="switcher-hero"
		style:--hero-accent={$currentSavedServer?.effectiveAccentColor || '#2dd4bf'}
	>
		{#if $currentSavedServer?.effectiveBannerUrl}
			<img class="switcher-hero-image" src={$currentSavedServer.effectiveBannerUrl} alt={$currentSavedServer.effectiveName} />
		{/if}
		<div class="switcher-hero-copy">
			<div class="switcher-eyebrow">Server Switcher</div>
			<h2>{$currentSavedServer?.effectiveName || 'Saved Servers'}</h2>
			<p>{$currentSavedServer?.effectiveDescription || 'Switch networks, edit local aliases, and manage multi-server folders from one panel.'}</p>
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
									use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileFolderMove(item, event) }}
									on:click={() => handleFolderHeaderTap(item.folder.id)}
								>
									<strong>{item.folder.effectiveName}</strong>
									<span>{item.folder.members.length} saved servers</span>
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
								<button
									type="button"
									class="switcher-tertiary"
									disabled={!canMoveRailItem(item.id, 'up')}
									on:click={() => moveRailItem(item.id, 'up')}
								>
									Up
								</button>
								<button
									type="button"
									class="switcher-tertiary"
									disabled={!canMoveRailItem(item.id, 'down')}
									on:click={() => moveRailItem(item.id, 'down')}
								>
									Down
								</button>
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

					{#if mobile && item.kind === 'folder' && isFolderExpanded(item.folder.id)}
						<div class="switcher-folder-strip" role="group" aria-label={`${item.folder.effectiveName} quick switch`}>
							{#each item.folder.members as server (server.url)}
								<button
									type="button"
									class="switcher-folder-chip"
									class:move-selected={isMovingServer(server.url)}
									class:active={server.isActive}
									use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileServerMove(server, item, event) }}
									on:click={() => quickSwitchServer(server)}
								>
									<div class="switcher-folder-chip-avatar">
										{#if server.effectiveIconUrl}
											<img src={server.effectiveIconUrl} alt={server.effectiveName} />
										{:else}
											<span>{avatarText(server)}</span>
										{/if}
									</div>
									<span class="switcher-folder-chip-label">{server.effectiveName}</span>
								</button>
							{/each}
						</div>
					{/if}

					{#if shouldRenderGroupMembers(item)}
						{#each groupMembers(item) as server (server.url)}
							<div
								class="switcher-row"
								class:move-selected={isMovingServer(server.url)}
								class:drop-before={mobile && isRowPreview(server.url, 'before')}
								class:drop-after={mobile && isRowPreview(server.url, 'after')}
								class:drop-make-folder={mobile && isMakeFolderPreview(server.url)}
								data-drop-row-url={mobile ? server.url : undefined}
								data-drop-row-item-id={mobile ? item.id : undefined}
								data-drop-row-item-kind={mobile ? item.kind : undefined}
								style:--row-accent={serverAccent(server)}
							>
								<div
									class="switcher-avatar"
									use:longpress={{ duration: 430, cancelOnMove: 18, onLongPress: (event) => startMobileServerMove(server, item, event) }}
								>
									{#if server.effectiveIconUrl}
										<img src={server.effectiveIconUrl} alt={server.effectiveName} />
									{:else}
										<span>{avatarText(server)}</span>
									{/if}
								</div>

								<div class="switcher-meta">
									<div class="switcher-title-row">
										<strong>{server.effectiveName}</strong>
										{#if server.isActive}
											<span class="switcher-badge">Current</span>
										{/if}
										{#if getServerFollowUnreadCount(server.url) > 0}
											<span class="switcher-badge switcher-badge--follow-unread">
												{getServerFollowUnreadCount(server.url)} follow unread
											</span>
										{/if}
										{#if server.hasRegisteredSession}
											<span class="switcher-badge switcher-badge--session">Auth</span>
										{:else if server.hasGuestSession}
											<span class="switcher-badge switcher-badge--guest">Guest</span>
										{/if}
										{#if item.kind === 'folder'}
											<span class="switcher-badge switcher-badge--folder">Folder</span>
										{/if}
									</div>
									<div class="switcher-url">{server.url}</div>
									{#if server.lastUsername}
										<div class="switcher-detail">Last user: {server.lastUsername}</div>
									{/if}
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
									{/if}
								</div>

								<div class="switcher-actions">
									{#if !mobile || item.kind !== 'folder'}
										<button
											type="button"
											class="switcher-secondary"
											disabled={server.isActive}
											on:click={() => switchToSavedServer(server.url)}
										>
											Open
										</button>
									{/if}
									<button type="button" class="switcher-tertiary" on:click={() => refreshSavedServer(server.url)}>Refresh</button>
									<button type="button" class="switcher-tertiary" on:click={() => startEditing(server)}>Alias</button>
									{#if item.kind === 'folder'}
										<button type="button" class="switcher-tertiary" on:click={() => ungroupServer(server.url)}>Ungroup</button>
									{:else}
										<button
											type="button"
											class="switcher-tertiary"
											disabled={!canMoveRailItem(item.id, 'up')}
											on:click={() => moveRailItem(item.id, 'up')}
										>
											Up
										</button>
										<button
											type="button"
											class="switcher-tertiary"
											disabled={!canMoveRailItem(item.id, 'down')}
											on:click={() => moveRailItem(item.id, 'down')}
										>
											Down
										</button>
									{/if}
									<button type="button" class="switcher-danger" on:click={() => removeServer(server.url)}>Remove</button>
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
		background:
			linear-gradient(180deg, rgba(6, 10, 18, 0.98) 0%, rgba(10, 16, 27, 0.98) 100%),
			radial-gradient(circle at top right, rgba(45, 212, 191, 0.18), transparent 42%);
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		z-index: calc(var(--z-modal, 1200) - 1);
	}

	.server-switcher.mobile {
		position: fixed;
		z-index: var(--z-modal, 1200);
	}

	.switcher-hero {
		position: relative;
		min-height: 168px;
		padding: 1.2rem 1.15rem 1rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
		overflow: hidden;
	}

	.switcher-hero::after {
		content: '';
		position: absolute;
		inset: auto -10% -30% auto;
		width: 220px;
		height: 220px;
		border-radius: 50%;
		background: radial-gradient(circle, color-mix(in srgb, var(--hero-accent) 38%, transparent), transparent 70%);
		filter: blur(22px);
		pointer-events: none;
	}

	.switcher-hero-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0.28;
	}

	.switcher-hero-copy {
		position: relative;
		z-index: 1;
		max-width: 520px;
		display: grid;
		gap: 0.35rem;
	}

	.switcher-eyebrow {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.74);
	}

	.switcher-hero-copy h2 {
		margin: 0;
		font-size: 1.35rem;
		color: #f8fafc;
	}

	.switcher-hero-copy p {
		margin: 0;
		color: rgba(255, 255, 255, 0.78);
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

	.switcher-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem 1rem 1.1rem;
		overflow: hidden;
	}

	.switcher-intro {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.7rem;
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
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 12px;
		padding: 0 0.8rem;
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-primary);
	}

	.switcher-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding-right: 0.15rem;
	}

	.switcher-group {
		display: grid;
		gap: 0.7rem;
		padding: 0.85rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 18px;
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.02));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--group-accent) 10%, transparent);
	}

	.switcher-group.move-selected {
		border-color: rgba(125, 211, 252, 0.34);
		box-shadow:
			inset 0 0 0 1px rgba(125, 211, 252, 0.22),
			0 0 0 1px rgba(125, 211, 252, 0.12);
	}

	.switcher-group.drop-before {
		box-shadow:
			inset 0 4px 0 rgba(125, 211, 252, 0.9),
			inset 0 0 0 1px rgba(125, 211, 252, 0.22),
			0 0 0 1px rgba(125, 211, 252, 0.12);
	}

	.switcher-group.drop-after {
		box-shadow:
			inset 0 -4px 0 rgba(125, 211, 252, 0.9),
			inset 0 0 0 1px rgba(125, 211, 252, 0.22),
			0 0 0 1px rgba(125, 211, 252, 0.12);
	}

	.switcher-group.drop-join {
		border-color: rgba(45, 212, 191, 0.36);
		background: linear-gradient(135deg, rgba(45, 212, 191, 0.18), rgba(255, 255, 255, 0.03));
		box-shadow:
			inset 0 0 0 1px rgba(45, 212, 191, 0.2),
			0 0 0 1px rgba(45, 212, 191, 0.12);
	}

	.switcher-folder-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding-bottom: 0.2rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}

	.switcher-folder-heading {
		min-width: 0;
		display: grid;
		gap: 0.45rem;
	}

	.switcher-folder-toggle {
		padding: 0;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
	}

	.switcher-folder-header strong {
		display: block;
		font-size: 0.86rem;
		color: var(--text-primary);
	}

	.switcher-folder-header span {
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
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 12px;
		padding: 0 0.8rem;
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-primary);
	}

	.switcher-move-targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.switcher-folder-strip {
		display: flex;
		gap: 0.65rem;
		overflow-x: auto;
		padding-bottom: 0.1rem;
		scrollbar-width: thin;
	}

	.switcher-folder-strip::-webkit-scrollbar {
		height: 5px;
	}

	.switcher-folder-strip::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.14);
		border-radius: 999px;
	}

	.switcher-folder-chip {
		min-width: 88px;
		max-width: 116px;
		padding: 0.62rem 0.5rem 0.58rem;
		border-radius: 16px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.03));
		color: var(--text-primary);
		display: grid;
		gap: 0.42rem;
		justify-items: center;
		cursor: pointer;
		flex-shrink: 0;
	}

	.switcher-folder-chip.active {
		border-color: rgba(45, 212, 191, 0.34);
		background: linear-gradient(135deg, rgba(45, 212, 191, 0.22), rgba(59, 130, 246, 0.18));
	}

	.switcher-folder-chip.move-selected {
		border-color: rgba(125, 211, 252, 0.42);
		background: linear-gradient(135deg, rgba(56, 189, 248, 0.24), rgba(30, 41, 59, 0.4));
		box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.16);
	}

	.switcher-folder-chip-avatar {
		width: 46px;
		height: 46px;
		border-radius: 16px;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(255, 255, 255, 0.08);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.92rem;
		font-weight: 700;
		color: #fff;
	}

	.switcher-folder-chip-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.switcher-folder-chip-label {
		width: 100%;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
	}

	.switcher-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.85rem;
		padding: 0.2rem 0;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--row-accent) 8%, transparent);
		border-radius: 16px;
	}

	.switcher-row.move-selected {
		box-shadow:
			inset 0 0 0 1px rgba(125, 211, 252, 0.24),
			0 0 0 1px rgba(125, 211, 252, 0.1);
		background: rgba(56, 189, 248, 0.08);
	}

	.switcher-row.drop-before {
		box-shadow:
			inset 0 4px 0 rgba(125, 211, 252, 0.95),
			inset 0 0 0 1px rgba(125, 211, 252, 0.18);
	}

	.switcher-row.drop-after {
		box-shadow:
			inset 0 -4px 0 rgba(125, 211, 252, 0.95),
			inset 0 0 0 1px rgba(125, 211, 252, 0.18);
	}

	.switcher-row.drop-make-folder {
		background: linear-gradient(135deg, rgba(244, 114, 182, 0.12), rgba(45, 212, 191, 0.12));
		box-shadow:
			inset 0 0 0 1px rgba(244, 114, 182, 0.2),
			0 0 0 1px rgba(244, 114, 182, 0.1);
	}

	.switcher-avatar {
		width: 54px;
		height: 54px;
		border-radius: 18px;
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
		gap: 0.28rem;
		align-content: start;
	}

	.switcher-title-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		align-items: center;
	}

	.switcher-title-row strong {
		font-size: 0.95rem;
		color: var(--text-primary);
	}

	.switcher-url,
	.switcher-detail {
		font-size: 0.76rem;
		color: var(--text-secondary);
		word-break: break-word;
	}

	.switcher-badge {
		font-size: 0.64rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding: 0.14rem 0.38rem;
		border-radius: 999px;
		background: rgba(45, 212, 191, 0.18);
		color: #bffdf2;
		border: 1px solid rgba(45, 212, 191, 0.22);
	}

	.switcher-badge--session {
		background: rgba(96, 165, 250, 0.14);
		border-color: rgba(96, 165, 250, 0.24);
		color: #dbeafe;
	}

	.switcher-badge--guest {
		background: rgba(251, 191, 36, 0.14);
		border-color: rgba(251, 191, 36, 0.24);
		color: #fde68a;
	}

	.switcher-badge--folder {
		background: rgba(244, 114, 182, 0.14);
		border-color: rgba(244, 114, 182, 0.2);
		color: #fbcfe8;
	}

	.switcher-badge--follow-unread {
		background: rgba(239, 68, 68, 0.14);
		border-color: rgba(239, 68, 68, 0.24);
		color: #fecaca;
	}

	.switcher-actions,
	.switcher-alias-editor {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		align-items: center;
	}

	.switcher-actions {
		align-self: start;
		justify-content: flex-end;
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
	.switcher-tertiary,
	.switcher-danger {
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

	.switcher-danger {
		color: #fca5a5;
	}

	.switcher-primary:disabled,
	.switcher-secondary:disabled,
	.switcher-tertiary:disabled,
	.switcher-danger:disabled {
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

		.switcher-actions {
			justify-content: flex-start;
		}
	}
</style>
