<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
	import { brandName } from '$lib/branding';
	import { centerPanelView } from '$lib/layoutStoreStates';
	import { followUnreadCountsByServer } from '$lib/followingSnapshots';
	import {
		createSavedServerFolder,
		moveSavedServerToFolder,
		reorderSavedServerRailItem,
		savedServerRailItems,
		switchToSavedServer,
		reorderSavedServer,
		type SavedServerFolderView,
		type SavedServerRailItem,
		type SavedServerView
	} from '$lib/savedServers';

	type RailDropPosition = 'before' | 'after' | 'inside';

	export let mobile = false;

	const dispatch = createEventDispatcher<{
		manage: void;
	}>();

	let draggedServerUrl: string | null = null;
	let draggedItemId: string | null = null;
	let draggedItemKind: 'server' | 'folder' | null = null;
	let dropTargetId: string | null = null;
	let dropPosition: RailDropPosition = 'before';
	let openFolderId: string | null = null;
	let suppressTapUntil = 0;
	let brokenImageUrls = new Set<string>();

	$: activeMobileFolder =
		mobile && openFolderId
			? $savedServerRailItems.find(
					(item): item is Extract<SavedServerRailItem, { kind: 'folder' }> =>
						item.kind === 'folder' && item.folder.id === openFolderId
			  )?.folder ?? null
			: null;

	function avatarText(server: SavedServerView | null): string {
		if (!server?.effectiveName) return 'W';
		return server.effectiveName.charAt(0).toUpperCase();
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

	function folderPreviewMembers(folder: SavedServerFolderView): SavedServerView[] {
		return folder.members.slice(0, 4);
	}

	function getServerUnreadCount(serverUrl: string): number {
		return $followUnreadCountsByServer[serverUrl] || 0;
	}

	function getFolderUnreadCount(folder: SavedServerFolderView): number {
		return folder.members.reduce((sum, server) => sum + getServerUnreadCount(server.url), 0);
	}

	function formatUnreadBadge(count: number): string {
		if (count <= 0) return '';
		if (count > 99) return '99+';
		return String(count);
	}

	function toggleFolder(folderId: string): void {
		openFolderId = openFolderId === folderId ? null : folderId;
	}

	function beginManageGesture(): void {
		suppressTapUntil = Date.now() + 700;
		dispatch('manage');
	}

	function shouldSuppressTap(): boolean {
		return mobile && Date.now() < suppressTapUntil;
	}

	function clearDragState(): void {
		draggedServerUrl = null;
		draggedItemId = null;
		draggedItemKind = null;
		dropTargetId = null;
		dropPosition = 'before';
	}

	function handleDragStart(item: SavedServerRailItem, event: DragEvent): void {
		draggedItemId = item.id;
		draggedItemKind = item.kind;
		draggedServerUrl = item.kind === 'server' ? item.server.url : null;
		dropTargetId = item.id;
		dropPosition = item.kind === 'server' ? 'inside' : 'before';
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', item.id);
		}
	}

	function handleDragOver(item: SavedServerRailItem, event: DragEvent): void {
		if (!draggedItemId) return;
		if (item.id === draggedItemId) return;
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		dropTargetId = item.id;

		const targetEl = event.currentTarget as HTMLElement | null;
		if (!targetEl) return;
		const rect = targetEl.getBoundingClientRect();
		const localY = event.clientY - rect.top;
		if (draggedItemKind === 'folder') {
			dropPosition = localY >= rect.height / 2 ? 'after' : 'before';
			return;
		}
		const innerBand = Math.min(14, rect.height * 0.26);
		if (localY > innerBand && localY < rect.height - innerBand) {
			dropPosition = 'inside';
			return;
		}
		dropPosition = localY >= rect.height / 2 ? 'after' : 'before';
	}

	function handleDrop(item: SavedServerRailItem, event: DragEvent): void {
		if (!draggedItemId) return;
		event.preventDefault();
		event.stopPropagation();
		if (item.id === draggedItemId) {
			clearDragState();
			return;
		}

		if (draggedItemKind === 'folder') {
			reorderSavedServerRailItem(draggedItemId, item.id, dropPosition === 'after' ? 'after' : 'before');
			clearDragState();
			return;
		}

		if (!draggedServerUrl) {
			clearDragState();
			return;
		}

		if (dropPosition === 'inside') {
			if (item.kind === 'server') {
				createSavedServerFolder(draggedServerUrl, item.server.url);
			} else {
				moveSavedServerToFolder(draggedServerUrl, item.folder.id);
				openFolderId = item.folder.id;
			}
			clearDragState();
			return;
		}

		const targetUrl = dropPosition === 'before' ? item.firstUrl : item.lastUrl;
		reorderSavedServer(draggedServerUrl, targetUrl, dropPosition, null);
		clearDragState();
	}

	function handleFolderMemberSelect(server: SavedServerView): void {
		if (shouldSuppressTap()) {
			return;
		}
		if (server.isActive) {
			dispatch('manage');
			return;
		}
		openFolderId = null;
		switchToSavedServer(server.url);
	}

	function handleServerSelect(server: SavedServerView): void {
		if (shouldSuppressTap()) {
			return;
		}
		if (server.isActive) {
			dispatch('manage');
			return;
		}
		switchToSavedServer(server.url);
	}

	function handleFolderSelect(folderId: string): void {
		if (shouldSuppressTap()) {
			return;
		}
		toggleFolder(folderId);
	}

	function handleRailLongPress(): void {
		if (!mobile) return;
		beginManageGesture();
	}
</script>

<aside class="server-rail" class:mobile aria-label="Saved servers">
	<div class="rail-primary" class:mobile>
		<button
			type="button"
			class="rail-home"
			title="{brandName} — open server switcher"
			on:click={() => dispatch('manage')}
		>
			<img src="/wabi-logo-small.webp" alt={brandName} class="server-avatar-image server-avatar-image--logo" />
		</button>

		{#if !mobile}
			<div class="rail-divider"></div>
		{/if}

		<div class="rail-list">
			{#each $savedServerRailItems as item (item.id)}
				<div class="rail-item">
					{#if item.kind === 'server'}
						<button
							type="button"
							class="server-pill"
							class:active={item.server.isActive}
							class:drag-target={dropTargetId === item.id && draggedServerUrl !== null}
							class:drop-before={dropTargetId === item.id && dropPosition === 'before'}
							class:drop-after={dropTargetId === item.id && dropPosition === 'after'}
							class:drop-inside={dropTargetId === item.id && dropPosition === 'inside'}
							title={item.server.effectiveName}
							draggable={!mobile}
							use:longpress={{ duration: 430, cancelOnMove: 12, onLongPress: handleRailLongPress }}
							on:click={() => handleServerSelect(item.server)}
							on:dragstart={(event) => handleDragStart(item, event)}
							on:dragover={(event) => handleDragOver(item, event)}
							on:drop={(event) => handleDrop(item, event)}
							on:dragend={clearDragState}
						>
							{#if canRenderServerImage(item.server.effectiveIconUrl)}
								<img
									src={item.server.effectiveIconUrl}
									alt={item.server.effectiveName}
									class="server-avatar-image"
									on:error={() => markImageBroken(item.server.effectiveIconUrl)}
								/>
							{:else}
								<span class="server-avatar-fallback">{avatarText(item.server)}</span>
							{/if}
							{#if getServerUnreadCount(item.server.url) > 0}
								<span class="server-unread-badge">{formatUnreadBadge(getServerUnreadCount(item.server.url))}</span>
							{/if}
						</button>
					{:else}
						<div class="folder-shell">
							<button
								type="button"
								class="server-pill folder-pill"
								class:active={Boolean(item.folder.activeMember)}
								class:drag-target={dropTargetId === item.id && draggedServerUrl !== null}
								class:drop-before={dropTargetId === item.id && dropPosition === 'before'}
								class:drop-after={dropTargetId === item.id && dropPosition === 'after'}
								class:drop-inside={dropTargetId === item.id && dropPosition === 'inside'}
								title={item.folder.effectiveName}
								draggable={!mobile}
								use:longpress={{ duration: 430, cancelOnMove: 12, onLongPress: handleRailLongPress }}
								on:click={() => handleFolderSelect(item.folder.id)}
								on:dragstart={(event) => handleDragStart(item, event)}
								on:dragover={(event) => handleDragOver(item, event)}
								on:drop={(event) => handleDrop(item, event)}
								on:dragend={clearDragState}
							>
								<div class="folder-grid">
									{#each folderPreviewMembers(item.folder) as server (server.url)}
										<div class="folder-grid-cell">
											{#if canRenderServerImage(server.effectiveIconUrl)}
												<img
													src={server.effectiveIconUrl}
													alt={server.effectiveName}
													class="folder-grid-image"
													on:error={() => markImageBroken(server.effectiveIconUrl)}
												/>
											{:else}
												<span>{avatarText(server)}</span>
											{/if}
										</div>
									{/each}
								</div>
								{#if getFolderUnreadCount(item.folder) > 0}
									<span class="server-unread-badge">{formatUnreadBadge(getFolderUnreadCount(item.folder))}</span>
								{/if}
							</button>

							{#if !mobile && openFolderId === item.folder.id}
								<div class="folder-popout">
									<div class="folder-popout-header">
										<strong>{item.folder.effectiveName}</strong>
										<span>{item.folder.members.length} saved</span>
									</div>
									<div class="folder-popout-list">
										{#each item.folder.members as server (server.url)}
											<button
												type="button"
												class="folder-member"
												class:active={server.isActive}
												title={server.effectiveName}
												on:click={() => handleFolderMemberSelect(server)}
											>
												{#if canRenderServerImage(server.effectiveIconUrl)}
													<img
														src={server.effectiveIconUrl}
														alt={server.effectiveName}
														class="server-avatar-image"
														on:error={() => markImageBroken(server.effectiveIconUrl)}
													/>
												{:else}
													<span class="server-avatar-fallback">{avatarText(server)}</span>
												{/if}
												{#if getServerUnreadCount(server.url) > 0}
													<span class="server-unread-badge server-unread-badge--member">{formatUnreadBadge(getServerUnreadCount(server.url))}</span>
												{/if}
											</button>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if mobile}
		<button type="button" class="rail-manage rail-manage-mobile" title="Add or switch servers" on:click={() => dispatch('manage')}>
			<span>+</span>
		</button>
		{/if}
	</div>

	{#if mobile && activeMobileFolder}
		<div class="mobile-folder-tray">
			<div class="folder-popout-header">
				<strong>{activeMobileFolder.effectiveName}</strong>
				<span>{activeMobileFolder.members.length} saved</span>
			</div>
			<div class="folder-popout-list mobile-folder-list">
				{#each activeMobileFolder.members as server (server.url)}
					<button
						type="button"
						class="folder-member"
						class:active={server.isActive}
						title={server.effectiveName}
						use:longpress={{ duration: 430, cancelOnMove: 12, onLongPress: handleRailLongPress }}
						on:click={() => handleFolderMemberSelect(server)}
					>
						{#if canRenderServerImage(server.effectiveIconUrl)}
							<img
								src={server.effectiveIconUrl}
								alt={server.effectiveName}
								class="server-avatar-image"
								on:error={() => markImageBroken(server.effectiveIconUrl)}
							/>
						{:else}
							<span class="server-avatar-fallback">{avatarText(server)}</span>
						{/if}
						{#if getServerUnreadCount(server.url) > 0}
							<span class="server-unread-badge server-unread-badge--member">{formatUnreadBadge(getServerUnreadCount(server.url))}</span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	{#if !mobile}
		<button type="button" class="rail-manage" title="Admin Dashboard" on:click={() => centerPanelView.set('admin')}>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
			</svg>
		</button>
		<button type="button" class="rail-manage" title="Add or switch servers" on:click={() => dispatch('manage')}>
			<span>+</span>
		</button>
	{/if}
</aside>

