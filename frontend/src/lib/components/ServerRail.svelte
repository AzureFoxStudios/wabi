<!--
	Saved-servers rail (design contract §8.1): shown left of the sidebar only while more than one
	server is saved. Roles and kit only.

	- Tiles are 52px: the server's icon (or the ensō, or its initial) on the rail's --w-bg. The
	  server you are on takes the selection grammar: a --w-raise tile with aria-current="page"
	  (High Contrast adds the inset ring); hover is the 70% raise mix. Nothing moves or reshapes
	  under the pointer.
	- Unread followed channels show as an 8px ink dot at the tile's top-right with a ring in the
	  rail's colour; the count is in the tile's name and tooltip, never colour alone.
	- Folders are a 2×2 stamp grid; the open folder is a kit popover.
	- The foot band (80px, on the shared footer rule) holds Admin dashboard and Add or switch
	  servers as icon buttons.
-->
<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
	import { brandName } from '$lib/branding';
	import { serverUnreadLabel } from '$lib/serverSwitcherLabels';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import {
		centerPanelView,
		railDensity,
		railSide,
		railLayoutLoaded
	} from '$lib/layoutStoreStates';
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
	import { loadRailLayout, persistRailLayout } from '$lib/railLayout';

	type RailDropPosition = 'before' | 'after' | 'inside';

	export let mobile = false;

	const dispatch = createEventDispatcher<{
		manage: void;
	}>();

	// Load persisted rail chrome (density + side) from DB on mount
	$: if (!$railLayoutLoaded) {
		void loadRailLayout();
	}
	$: if ($railLayoutLoaded) {
		persistRailLayout();
	}
	$: $railDensity, $railSide, $railLayoutLoaded, void persistRailLayout;

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

	/** The tile's name for tooltips and assistive tech: "Common Ground, current server, 3 unread". */
	function tileLabel(name: string, active: boolean, unread: number): string {
		return [name, active ? 'current server' : '', serverUnreadLabel(unread)].filter(Boolean).join(', ');
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

<aside class="server-rail" class:mobile class:density-full={$railDensity === 'full'} class:density-icons-only={$railDensity === 'icons-only'} class:density-hidden={$railDensity === 'hidden'} class:rail-right={$railSide === 'right'} aria-label="Saved servers">
	<div class="rail-primary" class:mobile>
		<div class="rail-head">
			<Tooltip text={`${brandName} · saved servers`} placement={$railSide === 'right' ? 'left' : 'right'}>
				<button
					type="button"
					class="rail-home"
					aria-label={`${brandName}: open saved servers`}
					on:click={() => dispatch('manage')}
				>
					<span class="rail-enso" aria-hidden="true"></span>
				</button>
			</Tooltip>
		</div>

		<div class="rail-list">
			{#each $savedServerRailItems as item (item.id)}
				<div class="rail-item">
					{#if item.kind === 'server'}
						{@const unread = getServerUnreadCount(item.server.url)}
						<Tooltip text={tileLabel(item.server.effectiveName, item.server.isActive, unread)} placement={$railSide === 'right' ? 'left' : 'right'} describe={false}>
							<button
								type="button"
								class="server-pill"
								class:active={item.server.isActive}
								class:drag-target={dropTargetId === item.id && draggedServerUrl !== null}
								class:drop-before={dropTargetId === item.id && dropPosition === 'before'}
								class:drop-after={dropTargetId === item.id && dropPosition === 'after'}
								class:drop-inside={dropTargetId === item.id && dropPosition === 'inside'}
								aria-label={tileLabel(item.server.effectiveName, item.server.isActive, unread)}
								aria-current={item.server.isActive ? 'page' : undefined}
								draggable={!mobile}
								use:longpress={{ duration: 430, cancelOnMove: 12, onLongPress: handleRailLongPress }}
								on:click={() => handleServerSelect(item.server)}
								on:dragstart={(event) => handleDragStart(item, event)}
								on:dragover={(event) => handleDragOver(item, event)}
								on:drop={(event) => handleDrop(item, event)}
								on:dragend={clearDragState}
							>
								<span class="server-mark">
									{#if canRenderServerImage(item.server.effectiveIconUrl)}
										<img
											src={item.server.effectiveIconUrl}
											alt=""
											class="server-avatar-image"
											on:error={() => markImageBroken(item.server.effectiveIconUrl)}
										/>
									{:else if item.server.useNeutralBranding}
										<span class="server-avatar-fallback" aria-hidden="true">{avatarText(item.server)}</span>
									{:else}
										<span class="server-avatar-enso" aria-hidden="true"></span>
									{/if}
								</span>
								{#if unread > 0}
									<span class="server-unread-dot" aria-hidden="true"></span>
								{/if}
							</button>
						</Tooltip>
					{:else}
						{@const folderUnread = getFolderUnreadCount(item.folder)}
						<div class="folder-shell">
							<Tooltip text={tileLabel(item.folder.effectiveName, Boolean(item.folder.activeMember), folderUnread)} placement={$railSide === 'right' ? 'left' : 'right'} describe={false}>
								<button
									type="button"
									class="server-pill folder-pill"
									class:active={Boolean(item.folder.activeMember)}
									class:drag-target={dropTargetId === item.id && draggedServerUrl !== null}
									class:drop-before={dropTargetId === item.id && dropPosition === 'before'}
									class:drop-after={dropTargetId === item.id && dropPosition === 'after'}
									class:drop-inside={dropTargetId === item.id && dropPosition === 'inside'}
									aria-label={`Folder ${tileLabel(item.folder.effectiveName, Boolean(item.folder.activeMember), folderUnread)}`}
									aria-expanded={openFolderId === item.folder.id}
									draggable={!mobile}
									use:longpress={{ duration: 430, cancelOnMove: 12, onLongPress: handleRailLongPress }}
									on:click={() => handleFolderSelect(item.folder.id)}
									on:dragstart={(event) => handleDragStart(item, event)}
									on:dragover={(event) => handleDragOver(item, event)}
									on:drop={(event) => handleDrop(item, event)}
									on:dragend={clearDragState}
								>
									<span class="folder-grid" aria-hidden="true">
										{#each folderPreviewMembers(item.folder) as server (server.url)}
											<span class="folder-grid-cell">
												{#if canRenderServerImage(server.effectiveIconUrl)}
													<img
														src={server.effectiveIconUrl}
														alt=""
														class="folder-grid-image"
														on:error={() => markImageBroken(server.effectiveIconUrl)}
													/>
												{:else}
													<span>{avatarText(server)}</span>
												{/if}
											</span>
										{/each}
									</span>
									{#if folderUnread > 0}
										<span class="server-unread-dot" aria-hidden="true"></span>
									{/if}
								</button>
							</Tooltip>

							{#if !mobile && openFolderId === item.folder.id}
								<div class="folder-popout" role="group" aria-label={`Folder ${item.folder.effectiveName}`}>
									<div class="folder-popout-header">
										<strong>{item.folder.effectiveName}</strong>
										<span class="w-count">{item.folder.members.length} saved</span>
									</div>
									<div class="folder-popout-list">
										{#each item.folder.members as server (server.url)}
											{@const memberUnread = getServerUnreadCount(server.url)}
											<button
												type="button"
												class="folder-member"
												class:active={server.isActive}
												title={server.effectiveName}
												aria-label={tileLabel(server.effectiveName, server.isActive, memberUnread)}
												aria-current={server.isActive ? 'page' : undefined}
												on:click={() => handleFolderMemberSelect(server)}
											>
												<span class="server-mark server-mark--sm">
													{#if canRenderServerImage(server.effectiveIconUrl)}
														<img
															src={server.effectiveIconUrl}
															alt=""
															class="server-avatar-image"
															on:error={() => markImageBroken(server.effectiveIconUrl)}
														/>
													{:else}
														<span class="server-avatar-fallback" aria-hidden="true">{avatarText(server)}</span>
													{/if}
												</span>
												{#if memberUnread > 0}
													<span class="server-unread-dot" aria-hidden="true"></span>
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
			<button type="button" class="w-ibtn rail-manage rail-manage-mobile" aria-label="Add or switch servers" on:click={() => dispatch('manage')}>
				<Icon name="plus" />
			</button>
		{/if}
	</div>

	{#if mobile && activeMobileFolder}
		<div class="mobile-folder-tray" role="group" aria-label={`Folder ${activeMobileFolder.effectiveName}`}>
			<div class="folder-popout-header">
				<strong>{activeMobileFolder.effectiveName}</strong>
				<span class="w-count">{activeMobileFolder.members.length} saved</span>
			</div>
			<div class="folder-popout-list mobile-folder-list">
				{#each activeMobileFolder.members as server (server.url)}
					{@const memberUnread = getServerUnreadCount(server.url)}
					<button
						type="button"
						class="folder-member"
						class:active={server.isActive}
						title={server.effectiveName}
						aria-label={tileLabel(server.effectiveName, server.isActive, memberUnread)}
						aria-current={server.isActive ? 'page' : undefined}
						use:longpress={{ duration: 430, cancelOnMove: 12, onLongPress: handleRailLongPress }}
						on:click={() => handleFolderMemberSelect(server)}
					>
						<span class="server-mark server-mark--sm">
							{#if canRenderServerImage(server.effectiveIconUrl)}
								<img
									src={server.effectiveIconUrl}
									alt=""
									class="server-avatar-image"
									on:error={() => markImageBroken(server.effectiveIconUrl)}
								/>
							{:else}
								<span class="server-avatar-fallback" aria-hidden="true">{avatarText(server)}</span>
							{/if}
						</span>
						{#if memberUnread > 0}
							<span class="server-unread-dot" aria-hidden="true"></span>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	{#if !mobile}
		<div class="rail-foot">
			<Tooltip text="Admin dashboard" placement={$railSide === 'right' ? 'left' : 'right'}>
				<button type="button" class="w-ibtn rail-manage" aria-label="Admin dashboard" on:click={() => centerPanelView.set('admin')}>
					<Icon name="gear" />
				</button>
			</Tooltip>
			<Tooltip text="Add or switch servers" placement={$railSide === 'right' ? 'left' : 'right'}>
				<button type="button" class="w-ibtn rail-manage" aria-label="Add or switch servers" on:click={() => dispatch('manage')}>
					<Icon name="plus" />
				</button>
			</Tooltip>
		</div>
	{/if}
</aside>
