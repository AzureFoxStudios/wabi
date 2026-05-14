<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { longpress } from '$lib/actions/longpress';
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
			title="Open server switcher"
			on:click={() => dispatch('manage')}
		>
			<img src="/wabi-logo-small.webp" alt="Wabi" class="server-avatar-image server-avatar-image--logo" />
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
			<button type="button" class="rail-manage rail-manage-mobile" title="Open server switcher" on:click={() => dispatch('manage')}>
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
		<button type="button" class="rail-manage" title="Open server switcher" on:click={() => dispatch('manage')}>
			<span>+</span>
		</button>
	{/if}
</aside>

<style>
	.server-rail {
		width: 92px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
		padding: 1.05rem 1rem 1.15rem;
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		background:
			linear-gradient(180deg, rgba(13, 17, 27, 0.96) 0%, rgba(var(--surface-app-rgb, 17, 24, 39), 0.9) 100%),
			radial-gradient(circle at top, rgba(var(--color-info-rgb, 56, 189, 248), 0.16), transparent 52%);
		box-sizing: border-box;
	}

	.rail-item,
	.folder-shell {
		position: relative;
		width: 100%;
		display: flex;
		justify-content: center;
		padding: 0 0.2rem;
	}

	.rail-home,
	.server-pill,
	.rail-manage {
		width: 56px;
		height: 56px;
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
		border-radius: 999px;
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.05);
		color: var(--text-inverse, var(--text-inverse, #f8fafc));
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
		overflow: hidden;
		transition:
			transform 0.22s ease,
			border-radius 0.26s cubic-bezier(0.22, 1, 0.36, 1),
			border-color 0.22s ease,
			background 0.22s ease,
			box-shadow 0.22s ease;
		will-change: transform, border-radius;
	}

	.rail-home:hover,
	.server-pill:hover,
	.rail-manage:hover {
		transform: translateY(-1px);
		border-radius: 18px;
		border-color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.18);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.1);
	}

	.server-pill.active {
		border-radius: 18px;
		border-color: rgba(var(--color-success-rgb, 94, 234, 212), 0.48);
		background: linear-gradient(135deg, rgba(var(--color-success-rgb, 45, 212, 191), 0.22), rgba(59, 130, 246, 0.18));
		box-shadow: 0 0 0 1px rgba(var(--color-success-rgb, 94, 234, 212), 0.18);
	}

	.server-pill.drag-target {
		border-color: rgba(var(--color-info-rgb, 125, 211, 252), 0.42);
	}

	.server-pill.drop-inside {
		box-shadow: 0 0 0 2px rgba(var(--color-info-rgb, 125, 211, 252), 0.28);
		background: linear-gradient(135deg, rgba(var(--color-info-rgb, 56, 189, 248), 0.24), rgba(var(--color-success-rgb, 45, 212, 191), 0.18));
	}

	.server-pill.drop-before::before,
	.server-pill.drop-after::after {
		content: '';
		position: absolute;
		left: 50%;
		width: 34px;
		height: 3px;
		border-radius: 999px;
		background: var(--color-info, #7dd3fc);
		transform: translateX(-50%);
		box-shadow: 0 0 0 1px rgba(6, 10, 18, 0.8);
	}

	.server-pill.drop-before::before {
		top: -7px;
	}

	.server-pill.drop-after::after {
		bottom: -7px;
	}

	.server-avatar-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.server-unread-badge {
		position: absolute;
		right: -6px;
		bottom: -4px;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.22rem;
		border-radius: 999px;
		background: linear-gradient(135deg, var(--color-danger, var(--color-danger, #ef4444)), var(--color-warning, var(--color-warning, #f97316)));
		color: var(--text-inverse, var(--text-inverse, #fff));
		font-size: 0.64rem;
		font-weight: 800;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 2px solid rgba(7, 10, 18, 0.96);
		box-shadow: 0 6px 18px rgba(var(--color-danger-rgb, 239, 68, 68), 0.34);
		pointer-events: none;
	}

	.server-unread-badge--member {
		right: -5px;
		bottom: -5px;
		min-width: 1.05rem;
		height: 1.05rem;
		font-size: 0.58rem;
	}

	.server-avatar-image--logo {
		object-fit: contain;
		padding: 0.55rem;
	}

	.server-avatar-fallback,
	.rail-manage span {
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.01em;
	}

	.rail-divider {
		width: 28px;
		height: 1px;
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.12);
	}

	.rail-list {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.95rem;
		width: 100%;
		overflow-y: auto;
		padding: 0.2rem 0 0.3rem;
	}

	.rail-list::-webkit-scrollbar {
		width: 4px;
	}

	.rail-list::-webkit-scrollbar-thumb {
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.12);
		border-radius: 999px;
	}

	.folder-pill {
		padding: 0.34rem;
	}

	.folder-grid {
		width: 100%;
		height: 100%;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-rows: repeat(2, minmax(0, 1fr));
		gap: 0.16rem;
		padding: 0.18rem;
		box-sizing: border-box;
	}

	.folder-grid-cell {
		border-radius: 8px;
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.58rem;
		font-weight: 700;
	}

	.folder-grid-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.folder-popout {
		position: absolute;
		left: calc(100% + 0.75rem);
		top: 0;
		width: 188px;
		padding: 0.75rem;
		border-radius: 18px;
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
		background:
			linear-gradient(180deg, rgba(7, 10, 18, 0.97) 0%, rgba(14, 20, 32, 0.97) 100%),
			radial-gradient(circle at top right, rgba(var(--color-success-rgb, 45, 212, 191), 0.14), transparent 50%);
		box-shadow: 0 18px 36px rgba(var(--surface-app-rgb, 2, 6, 23), 0.42);
		display: grid;
		gap: 0.7rem;
		z-index: 12;
	}

	.folder-popout-header {
		display: grid;
		gap: 0.14rem;
	}

	.folder-popout-header strong {
		font-size: 0.84rem;
		color: var(--text-inverse, var(--text-inverse, #f8fafc));
	}

	.folder-popout-header span {
		font-size: 0.7rem;
		color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.62);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.folder-popout-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
	}

	.folder-member {
		width: 44px;
		height: 44px;
		padding: 0;
		border-radius: 999px;
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.08);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.05);
		color: var(--text-inverse, var(--text-inverse, #fff));
		cursor: pointer;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			transform 0.22s ease,
			border-radius 0.26s cubic-bezier(0.22, 1, 0.36, 1),
			border-color 0.22s ease,
			background 0.22s ease;
	}

	.folder-member:hover {
		transform: translateY(-1px);
		border-radius: 16px;
		border-color: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.18);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.1);
	}

	.folder-member.active {
		border-color: rgba(var(--color-success-rgb, 94, 234, 212), 0.48);
		background: linear-gradient(135deg, rgba(var(--color-success-rgb, 45, 212, 191), 0.24), rgba(59, 130, 246, 0.18));
	}

	.rail-manage {
		margin-top: auto;
		font-size: 1.2rem;
	}
</style>
